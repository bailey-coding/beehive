/**
 * Tournament Mode Implementation for the Beehive Promotion Worker
 * M3 Promotion Implementation
 */

import { 
  TournamentStatus, 
  TournamentCandidate, 
  ResolvedPromotionRequest,
  PromotionResult,
  CandidateMetrics,
  Rung,
  Env,
} from './types';
import { getCandidate, getPromotionLedger, advanceCandidate, recordDecidedTrial } from './spec-do';
import { shadowMinProductionSamples, shadowMinSamples, isProductionSource } from '../shared/shadow-verdict';
import { SpecDoLedgerError } from '../shared/promotion-ledger';

/**
 * Extended tournament type with ID
 */
type TournamentWithId = TournamentStatus & { id: string };

/**
 * The tournament is the competitive step of the ladder: it decides shadow -> train (docs/plans/promotion-gaps-plan.md section 12, V1).
 * Every other move calls `advance` directly. It ranks candidates by their shadow score in the ledger (`shadow_scores`, summed by the Spec
 * DO from the comparator's samples), read when the tournament decides, never a default and never arrival order. A candidate without a
 * score, or a tie for first, is a refusal the caller can see (V2): production candidates carry no score until the shadow router follow-up.
 */
export const TOURNAMENT_FROM_RUNG: Rung = 'shadow';
export const TOURNAMENT_TO_RUNG: Rung = 'train';

export type TournamentRefusalCode = 'no_shadow_evidence' | 'tie' | 'tournament_completed' | 'not_enough_entrants' | 'tournament_exhausted';

/** Thrown inside the claim write when the tournament already has a winner (another run claimed it first): this run resumes that claim */
class ClaimLost extends Error {}

/**
 * advance failures that say nothing about whether the move happened (a thrown fetch, a 5xx, an older Spec DO): the claim stays, so the next run
 * reads the winner's stage and finishes or retries (review S1). Only a definite refusal (a coded 404 or 409) fails the tournament and clears it.
 */
const INDETERMINATE_ADVANCE = new Set(['ledger_error', 'ledger_too_old']);

/** Stages at or past the tournament's target (`passed_shadow`): a claimed winner here has moved, so its tournament only needs completing */
const AT_OR_PAST_TARGET = new Set(['passed_shadow', 'passed_train', 'passed_canary', 'promoted']);

/** A decision that cannot be made, with a stable code. Before a winner exists it only reads (no attempt is spent); after, the tournament is recorded failed (retryable). The caller gets the code. */
export class TournamentRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export type TournamentDecision =
  | { kind: 'winner'; winnerId: string; runnerUpId: string; scores: Record<string, number> }
  | { kind: 'refused'; code: 'no_shadow_evidence' | 'tie'; message: string };

/** Pure. `score: null` means the ledger holds no shadow score for the candidate. */
export function decideTournament(entrants: Array<{ candidateId: string; score: number | null }>): TournamentDecision {
  const unscored = entrants.filter((e) => e.score === null).map((e) => e.candidateId);
  if (unscored.length > 0) {
    return { kind: 'refused', code: 'no_shadow_evidence', message: `No shadow score in the ledger for: ${unscored.join(', ')}` };
  }
  const ranked = entrants.map((e) => ({ candidateId: e.candidateId, score: e.score as number })).sort((a, b) => b.score - a.score);
  if (ranked.length < 2) {
    return { kind: 'refused', code: 'no_shadow_evidence', message: 'A tournament needs at least two scored candidates' };
  }
  if (ranked[0].score === ranked[1].score) {
    return { kind: 'refused', code: 'tie', message: `Tie for first at ${ranked[0].score}: ${ranked[0].candidateId} and ${ranked[1].candidateId}` };
  }
  return {
    kind: 'winner',
    winnerId: ranked[0].candidateId,
    runnerUpId: ranked[1].candidateId,
    scores: Object.fromEntries(ranked.map((r) => [r.candidateId, r.score])),
  };
}

/**
 * Manages tournament-style promotion where multiple candidates compete
 */
export class TournamentManager {
  constructor(private env: Env) {}

  /**
   * Execute the tournament step for a candidate (shadow -> train). The caller (PromotionWorker) has already asked the Spec DO whether the
   * candidate may make this move, so every entrant is a candidate the ledger says is on the shadow rung.
   *
   * Outcomes: `waiting` (alone), `moved` (this candidate won and `advance` wrote its stage), `eliminated` (another won), or a refusal
   * with a code. Evidence refusals (`no_shadow_evidence`, `tie`, `not_enough_entrants`) only read and spend no attempt; an `advance` refusal for the
   * winner records the tournament failed, retryable up to the ledger's cap (`tournament_exhausted` after).
   */
  async executeTournament(request: ResolvedPromotionRequest): Promise<PromotionResult> {
    // Set once a winner exists and the tournament goes in_progress: only then does a failure belong in the ledger
    let runningId: string | null = null;
    const result = (r: Pick<PromotionResult, 'success' | 'message'> & Partial<PromotionResult>): PromotionResult => ({
      candidateId: request.candidateId,
      specId: request.specId,
      fromRung: request.fromRung,
      toRung: request.toRung,
      timestamp: new Date().toISOString(),
      mode: 'tournament',
      ...r,
    });
    try {
      console.log(`[Tournament] Starting tournament promotion for candidate ${request.candidateId}`);

      const tournament = await this.getOrCreateTournament(request.specId);
      
      if (!tournament) {
        throw new Error('Failed to create or retrieve tournament');
      }

      if (tournament.winner && tournament.status === 'completed') {
        return result({
          success: false,
          code: 'tournament_completed',
          message: `Tournament for spec ${request.specId} already completed with winner ${tournament.winner}`,
        });
      }

      // A tournament whose winner was claimed but never completed (the run stopped after the claim, or recording the winner failed after the
      // move): finish that decision before anything else; never decide it again (wave-2a-plan part D3, review b1-S4)
      if (tournament.status === 'in_progress' && tournament.winner) {
        return await this.resumeClaim(tournament, request, result);
      }

      const updatedTournament = await this.addCandidateToTournament(
        tournament,
        request.candidateId,
        request.fromRung
      );

      // Competing entrants only: a disqualified one beside a lone entrant leaves that entrant waiting, not refused
      if (updatedTournament.candidates.filter((c) => c.status === 'competing').length < 2) {
        await this.updateTournamentStatus(updatedTournament.id, {
          status: 'pending',
        });

        // Not a move: the caller records this attempt as finished at the rung it started from
        return result({ success: true, outcome: 'waiting', message: `Added to tournament. Waiting for more candidates.` });
      }

      // Everything below up to the winner's advance only READS: an evidence refusal (no score, a tie, too few eligible entrants) must not move the
      // tournament to in_progress or burn one of its few attempts (MAX_TOURNAMENT_ATTEMPTS), or three refusals would kill a spec's tournament for good.
      // Entrants are re-checked now, not trusted from when they joined: one that can no longer make this move (it failed, was tombstoned, changed
      // stage) or whose shadow verdict failed does not compete (plan V2), and is marked disqualified so it cannot block the next attempt.
      const eligible: TournamentCandidate[] = [];
      const ineligible = new Map<string, string>(); // disqualified: cannot make this move
      const pastRung = new Map<string, string>(); // already moved on: not in the contest, and not a loss either
      // Only a definite "this candidate cannot make this move" disqualifies. A ledger error or an older Spec DO says nothing about the candidate:
      // it stops the attempt (before anything is written) and the entrant stays in, or a transient 5xx would knock a healthy entrant out for good.
      const DISQUALIFYING = new Set(['candidate_not_found', 'stale_from_rung', 'not_next_rung', 'evidence_missing']);
      for (const c of updatedTournament.candidates.filter((x) => x.status === 'competing')) {
        const check = await advanceCandidate(
          this.env,
          c.candidateId,
          { toRung: TOURNAMENT_TO_RUNG as 'train', fromRung: TOURNAMENT_FROM_RUNG, dryRun: true },
          request.actorId
        );
        if (!check.ok) {
          if (!DISQUALIFYING.has(check.code)) throw new TournamentRefusal(check.code, `Could not check entrant ${c.candidateId}: ${check.message}`);
          ineligible.set(c.candidateId, `${check.code}: ${check.message}`);
        } else if (check.data.noop) {
          pastRung.set(c.candidateId, 'already past the shadow rung');
        } else if (check.data.evidence.some((e) => e.rung === 'shadow' && e.status === 'failed')) {
          ineligible.set(c.candidateId, 'evidence_failed: its shadow verdict is fail');
        } else {
          eligible.push(c);
        }
      }
      let current = updatedTournament;
      if (ineligible.size > 0) {
        console.warn(`[Tournament] Disqualifying ${[...ineligible].map(([id, why]) => `${id} (${why})`).join('; ')}`);
        // On the record as saved now, so an entrant that joined meanwhile is kept (the Spec DO writes a tournament_loss near-miss for each disqualified entrant)
        const saved = await getPromotionLedger(this.env).modifyTournament(request.specId, (cur) => ({
          ...cur,
          candidates: cur.candidates.map((c) => (ineligible.has(c.candidateId) && c.status === 'competing' ? { ...c, status: 'disqualified' as const } : c)),
        }));
        if (!saved) throw new Error(`Tournament for spec ${request.specId} disappeared while disqualifying`);
        current = saved as TournamentWithId;
      }
      if (eligible.length < 2) {
        const why = [...ineligible.values(), ...[...pastRung].map(([id, w]) => `${id}: ${w}`)];
        throw new TournamentRefusal('not_enough_entrants', `A tournament needs two eligible entrants; ${eligible.length} left${why.length ? ` (${why.join('; ')})` : ''}`);
      }
      const contested = new Set(eligible.map((c) => c.candidateId));

      // Scores are read now, for every eligible entrant, from the ledger: a score that landed after a candidate joined counts, and a missing
      // score is "no evidence", never a default
      const entrants: Array<{ candidateId: string; score: number | null }> = [];
      for (const c of eligible) entrants.push({ candidateId: c.candidateId, score: await this.readShadowScore(c.candidateId) });
      const decision = decideTournament(entrants);
      if (decision.kind === 'refused') throw new TournamentRefusal(decision.code, decision.message);

      // A winner exists: claim it on the tournament in one version-checked write (start + winner + the contested set, stored as `comparisons`),
      // BEFORE the move (wave-2a-plan part D3). A run that finds another run's claim resumes that one instead of advancing its own pick.
      let claimed: TournamentWithId;
      try {
        claimed = await this.claimWinner(current.id, request.specId, decision, contested);
      } catch (e) {
        if (!(e instanceof ClaimLost)) throw e;
        const now = await this.getTournamentBySpec(request.specId);
        if (now && now.status === 'in_progress' && now.winner) return await this.resumeClaim(now, request, result);
        if (now && now.status === 'completed' && now.winner) {
          return result({ success: false, code: 'tournament_completed', message: `Tournament for spec ${request.specId} already completed with winner ${now.winner}` });
        }
        throw e;
      }
      runningId = claimed.id;

      // The Spec DO decides whether the winner may move; a refusal or error here fails the tournament (retryable) and clears the claim
      const advanced = await advanceCandidate(
        this.env,
        decision.winnerId,
        { toRung: TOURNAMENT_TO_RUNG as 'train', fromRung: TOURNAMENT_FROM_RUNG, notes: `Tournament ${claimed.id} winner` },
        request.actorId
      );
      if (!advanced.ok) {
        if (INDETERMINATE_ADVANCE.has(advanced.code)) {
          runningId = null; // the move may have committed: keep the claim (no failure write, no attempt spent); the next request resumes it
          return result({ success: false, code: advanced.code, message: `Winner ${decision.winnerId}: ${advanced.message} (the claim stays; the next request resumes it)` });
        }
        throw new TournamentRefusal(advanced.code, `Winner ${decision.winnerId} could not advance: ${advanced.message}`);
      }

      // The winner moved: from here on nothing fails the tournament. A failure recording the result leaves the claim for the next run to complete.
      runningId = null;
      const recorded = await this.completeClaimed(claimed.id, request.specId);

      // The decision as ledger evidence, AFTER the winner moved (a trial and a near-miss for the loser say somebody won). Best effort: the stage is
      // the truth, so a trial that cannot be written (an actorId that is no actor row is a foreign-key failure) is reported, not a failed tournament.
      let trial: { trialId: string } | { trial: string };
      if (!request.actorId) {
        trial = { trial: 'skipped: no actorId on the request' };
      } else {
        try {
          trial = {
            trialId: await recordDecidedTrial(this.env, {
              specId: request.specId,
              candidateAId: decision.winnerId,
              candidateBId: decision.runnerUpId,
              winnerId: decision.winnerId,
              comparisonMetrics: { basis: this.productionSource() ? 'shadow_production_score' : 'shadow_score', tournamentId: current.id, scores: decision.scores },
              actorId: request.actorId,
              idempotencyKey: `tournament:${current.id}:${decision.winnerId}:${decision.runnerUpId}`,
            }),
          };
        } catch (trialError) {
          const why = trialError instanceof Error ? trialError.message : String(trialError);
          console.error(`[Tournament] Winner ${decision.winnerId} moved but its trial was not recorded: ${why}`);
          trial = { trial: `not recorded: ${why.slice(0, 200)}` };
        }
      }

      console.log(`[Tournament] Tournament completed. Winner: ${decision.winnerId}`);

      const won = decision.winnerId === request.candidateId;
      return result({
        success: true,
        // A winner whose advance was a no-op (it had already moved by the time the real call ran) is not a move
        outcome: won ? (advanced.data.noop ? 'noop' : 'moved') : 'eliminated',
        message: `Tournament winner: ${decision.winnerId} promoted to ${request.toRung}`,
        moves: advanced.data.noop ? [] : [{ candidateId: decision.winnerId, fromRung: request.fromRung, toRung: request.toRung }],
        details: {
          tournamentId: current.id,
          winner: decision.winnerId,
          scores: decision.scores,
          ...(ineligible.size ? { disqualified: Object.fromEntries(ineligible) } : {}),
          ...(recorded === true ? {} : { recordWinner: recorded }),
          ...trial,
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[Tournament] Error: ${errorMessage}`);
      // The ledger's failure reason leads with the code, so `tie` / `no_shadow_evidence` / an advance refusal is searchable there
      if (runningId) await this.recordTournamentFailure(runningId, error instanceof TournamentRefusal ? `${error.code}: ${errorMessage}` : errorMessage, request.specId);

      return result({
        success: false,
        // The ledger refuses a tournament that has failed too many times (retries_exhausted): a stable 409, not an unexplained 500
        code: error instanceof TournamentRefusal ? error.code : /retries_exhausted/.test(errorMessage) ? 'tournament_exhausted' : 'tournament_error',
        message: errorMessage,
      });
    }
  }

  /**
   * Get tournament status
   */
  async getTournamentStatus(specId?: string): Promise<Response> {
    try {
      if (specId) {
        const tournament = await this.getTournamentBySpec(specId);
        
        if (!tournament) {
          return new Response(JSON.stringify({
            success: false,
            error: `No tournament found for spec ${specId}`,
            timestamp: new Date().toISOString(),
          }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({
          success: true,
          tournament,
          timestamp: new Date().toISOString(),
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const tournaments = await this.getAllTournaments();

      return new Response(JSON.stringify({
        success: true,
        tournaments,
        count: tournaments.length,
        timestamp: new Date().toISOString(),
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      return new Response(JSON.stringify({
        success: false,
        error: errorMessage,
        timestamp: new Date().toISOString(),
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  /**
   * Get or create a tournament for a spec
   */
  private async getOrCreateTournament(specId: string): Promise<TournamentWithId | null> {
    const existing = await this.getTournamentBySpec(specId);
    
    if (existing) {
      return existing;
    }

    const tournament: TournamentWithId = {
      id: `tournament_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      mode: 'tournament',
      specId,
      candidates: [],
      comparisons: [],
      startedAt: new Date().toISOString(),
      status: 'pending',
    };

    try {
      const saved = await this.saveTournament(tournament);
      console.log(`[Tournament] Created new tournament: ${saved.id} for spec ${specId}`);
      return saved;
    } catch (e) {
      // Another run created the spec's tournament between our read and our create (wave-2a-plan part D2): join that one. The spec had no
      // tournament at our read, so the open one the Spec DO names is the spec's newest.
      if (!(e instanceof SpecDoLedgerError && e.code === 'tournament_exists')) throw e;
      const winner = await this.getTournamentBySpec(specId);
      if (!winner) throw e;
      console.log(`[Tournament] Joined tournament ${winner.id} for spec ${specId} (created concurrently)`);
      return winner;
    }
  }

  /**
   * Get tournament by spec ID
   */
  private async getTournamentBySpec(specId: string): Promise<TournamentWithId | null> {
    return getPromotionLedger(this.env).getTournamentBySpec(specId);
  }

  /**
   * Get all tournaments
   */
  private async getAllTournaments(): Promise<TournamentWithId[]> {
    return getPromotionLedger(this.env).listTournaments();
  }

  /**
   * Save tournament to Spec DO
   */
  private async saveTournament(tournament: TournamentWithId): Promise<TournamentWithId> {
    return getPromotionLedger(this.env).saveTournament(tournament);
  }

  /**
   * Move a running tournament to 'failed' so a later request can retry it (the Spec DO counts
   * failures and stops retries after MAX_TOURNAMENT_ATTEMPTS). Best effort: the original
   * error is what the caller sees, so a ledger error here is only logged.
   */
  private async recordTournamentFailure(tournamentId: string, reason: string, specId?: string): Promise<void> {
    try {
      if (specId) {
        // A full-record write (POST), so the claimed winner and the contested set are cleared: a PATCH merges and cannot unset them (review S1)
        const saved = await getPromotionLedger(this.env).modifyTournament(specId, (cur) => {
          if (cur.id !== tournamentId) return null;
          const { winner: _winner, completedAt: _completedAt, ...rest } = cur;
          return { ...rest, status: 'failed', failureReason: reason, comparisons: [] };
        });
        if (saved && saved.id === tournamentId) return;
      }
      await this.updateTournament(tournamentId, { status: 'failed', failureReason: reason });
    } catch (error) {
      console.error(`[Tournament] Could not record failure of ${tournamentId}:`, error);
    }
  }

  /**
   * The claim: one version-checked write that moves the tournament to in_progress with the winner and the contested set (one `comparisons` entry
   * per contested loser). Throws ClaimLost when the record as re-read is completed or is in_progress with a winner (another run claimed it first); a stale winner on a failed or pending row is overwritten.
   */
  private async claimWinner(
    tournamentId: string,
    specId: string,
    decision: Extract<TournamentDecision, { kind: 'winner' }>,
    contested: Set<string>
  ): Promise<TournamentWithId> {
    const at = new Date().toISOString();
    const saved = await getPromotionLedger(this.env).modifyTournament(specId, (cur) => {
      // A winner is a live claim only on an in_progress row (review S2): a stale one on a failed or pending row (an old worker's PATCH keeps it) is
      // overwritten, or that spec could never be decided again
      if (cur.id !== tournamentId || cur.status === 'completed' || (cur.status === 'in_progress' && cur.winner)) {
        throw new ClaimLost(`Tournament ${tournamentId} was claimed or replaced by another run`);
      }
      const winnerScore = decision.scores[decision.winnerId] ?? 0;
      const comparisons = [...contested]
        .filter((id) => id !== decision.winnerId)
        .map((loser) => ({
          candidate1: decision.winnerId,
          candidate2: loser,
          winner: decision.winnerId,
          comparisonScore: winnerScore - (decision.scores[loser] ?? 0),
          comparedAt: at,
        }));
      const { failureReason: _reason, failedAt: _failedAt, ...rest } = cur;
      return { ...rest, status: 'in_progress', winner: decision.winnerId, comparisons };
    });
    if (!saved) throw new Error(`Tournament for spec ${specId} disappeared while claiming its winner`);
    return saved as TournamentWithId;
  }

  /**
   * Complete a claimed tournament on the record as saved (an entrant that joined meanwhile is kept): the winner is `winner`, the losers are the
   * contested set stored at the claim. True when written; otherwise the reason, and the claim stays for the next run (never throws).
   */
  private async completeClaimed(tournamentId: string, specId: string): Promise<true | string> {
    try {
      const at = new Date().toISOString();
      const saved = await getPromotionLedger(this.env).modifyTournament(specId, (cur) => {
        if (cur.id !== tournamentId || !cur.winner || cur.status === 'completed') return null;
        const losers = new Set(cur.comparisons.filter((c) => c.winner === cur.winner).map((c) => c.candidate2));
        return {
          ...cur,
          status: 'completed',
          completedAt: at,
          candidates: cur.candidates.map((c) =>
            c.candidateId === cur.winner
              ? { ...c, status: 'winner' as const, promotedAt: at }
              : c.status === 'competing' && losers.has(c.candidateId) ? { ...c, status: 'eliminated' as const } : c
          ),
        };
      });
      if (saved && saved.id === tournamentId && saved.status === 'completed') return true;
      return 'not recorded: the tournament was no longer the claimed one';
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      console.error(`[Tournament] Winner moved but tournament ${tournamentId} was not completed (the next run completes it): ${why}`);
      return `not recorded: ${why.slice(0, 200)}`;
    }
  }

  /**
   * Finish a claimed tournament (in_progress with a winner): a winner at or past the target stage has moved, so only completing is left; otherwise
   * the move is retried. Never decides again. The requester's outcome: the winner `moved` (this call moved it) or `noop`, a contested loser
   * `eliminated`, anyone else `tournament_completed`.
   */
  private async resumeClaim(
    t: TournamentWithId,
    request: ResolvedPromotionRequest,
    result: (r: Pick<PromotionResult, 'success' | 'message'> & Partial<PromotionResult>) => PromotionResult
  ): Promise<PromotionResult> {
    const winnerId = t.winner as string;
    let stage: string | null = null;
    try {
      stage = String((await getCandidate(this.env, winnerId)).stage ?? '');
    } catch {
      stage = null; // unreadable: the real advance below says what the ledger thinks (a definite refusal fails the tournament)
    }
    let movedNow = false;
    if (!stage || !AT_OR_PAST_TARGET.has(stage)) {
      const advanced = await advanceCandidate(
        this.env,
        winnerId,
        { toRung: TOURNAMENT_TO_RUNG as 'train', fromRung: TOURNAMENT_FROM_RUNG, notes: `Tournament ${t.id} winner` },
        request.actorId
      );
      if (!advanced.ok) {
        if (INDETERMINATE_ADVANCE.has(advanced.code)) {
          return result({ success: false, code: advanced.code, message: `Winner ${winnerId}: ${advanced.message} (the claim stays; the next request resumes it)` });
        }
        // A definite refusal: unless the winner has meanwhile reached the target some other way (then only completing is left), the claim is void
        const now = await getCandidate(this.env, winnerId).then((r) => String(r.stage ?? ''), () => '');
        if (!AT_OR_PAST_TARGET.has(now)) {
          await this.recordTournamentFailure(t.id, `${advanced.code}: Winner ${winnerId} could not advance: ${advanced.message}`, request.specId);
          return result({ success: false, code: advanced.code, message: `Winner ${winnerId} could not advance: ${advanced.message}` });
        }
      } else {
        movedNow = !advanced.data.noop;
      }
    }
    const recorded = await this.completeClaimed(t.id, request.specId);
    const losers = new Set(t.comparisons.filter((c) => c.winner === winnerId).map((c) => c.candidate2));
    const moves = movedNow ? [{ candidateId: winnerId, fromRung: TOURNAMENT_FROM_RUNG, toRung: TOURNAMENT_TO_RUNG }] : [];
    const details = { tournamentId: t.id, winner: winnerId, resumed: true, ...(recorded === true ? {} : { recordWinner: recorded }) };
    if (request.candidateId === winnerId) {
      return result({ success: true, outcome: movedNow ? 'moved' : 'noop', message: `Tournament winner: ${winnerId}`, moves, details });
    }
    if (losers.has(request.candidateId)) {
      return result({ success: true, outcome: 'eliminated', message: `Tournament winner: ${winnerId} promoted to ${request.toRung}`, moves, details });
    }
    return result({ success: false, code: 'tournament_completed', message: `Tournament for spec ${request.specId} was decided with winner ${winnerId}`, details });
  }

  /**
   * Update tournament
   */
  private async updateTournament(
    tournamentId: string,
    updates: Partial<TournamentStatus>
  ): Promise<void> {
    await getPromotionLedger(this.env).updateTournament(tournamentId, updates);
  }

  /**
   * Update tournament status
   */
  private async updateTournamentStatus(
    tournamentId: string,
    updates: Partial<TournamentStatus>
  ): Promise<void> {
    await this.updateTournament(tournamentId, updates);
  }

  /**
   * Add candidate to tournament
   */
  private async addCandidateToTournament(
    tournament: TournamentWithId,
    candidateId: string,
    fromRung: Rung
  ): Promise<TournamentWithId> {
    if (tournament.candidates.some(c => c.candidateId === candidateId)) {
      console.log(`[Tournament] Candidate ${candidateId} already in tournament`);
      return tournament;
    }

    const metrics = await this.getCandidateMetrics(candidateId);

    const newCandidate: TournamentCandidate = {
      candidateId,
      specId: tournament.specId,
      score: metrics.score,
      status: 'competing',
      metrics,
    };

    // Appended to the tournament as saved, so a concurrent add is kept (re-applied on a conflict)
    const updatedTournament = await getPromotionLedger(this.env).modifyTournament(
      tournament.specId,
      (current) =>
        current.candidates.some(c => c.candidateId === candidateId)
          ? null
          : { ...current, candidates: [...current.candidates, newCandidate] }
    );
    if (!updatedTournament) {
      throw new Error(`Tournament for spec ${tournament.specId} disappeared while adding ${candidateId}`);
    }
    console.log(`[Tournament] Added candidate ${candidateId} to tournament ${tournament.id}`);
    return updatedTournament;
  }

  /** TOURNAMENT_SHADOW_SOURCE=production (default off) */
  private productionSource(): boolean {
    return isProductionSource('TOURNAMENT_SHADOW_SOURCE', this.env.TOURNAMENT_SHADOW_SOURCE);
  }

  /**
   * The candidate's shadow score in the ledger, or null when it has none. Throws on any non-2xx (a 404 included), never "no score".
   * A score of 0 is a real score.
   */
  private async readShadowScore(candidateId: string): Promise<number | null> {
    const row = (await getCandidate(this.env, candidateId)) as { shadowScore?: unknown; shadowMetrics?: unknown; shadowProductionScore?: unknown; shadowProductionCount?: unknown };
    if (this.productionSource()) {
      // Production samples only, and enough of them. A Spec DO without the fields (older) answers no score: fail closed.
      const count = row.shadowProductionCount;
      return typeof row.shadowProductionScore === 'number' && typeof count === 'number' && count >= shadowMinProductionSamples() ? row.shadowProductionScore : null;
    }
    // The all-sample score needs as many samples as the shadow verdict (wave-2a-plan part D1, review b1-S5): one sample at 100 must not beat
    // 500 at 99. The count is in shadowMetrics (a JSON string); a missing or unreadable count is no score (fail closed, like the production source).
    if (typeof row.shadowScore !== 'number') return null;
    let total: unknown;
    try {
      total = typeof row.shadowMetrics === 'string' ? (JSON.parse(row.shadowMetrics) as { totalRequests?: unknown }).totalRequests : undefined;
    } catch {
      total = undefined;
    }
    return typeof total === 'number' && total >= shadowMinSamples() ? row.shadowScore : null;
  }

  /**
   * Metrics recorded when a candidate joins: a snapshot for the tournament record, not what decides it (decideTournament reads fresh scores).
   * Throws on a failed read instead of recording defaults.
   */
  private async getCandidateMetrics(candidateId: string): Promise<CandidateMetrics> {
    const row = (await getCandidate(this.env, candidateId)) as { shadowScore?: unknown; shadowMetrics?: unknown };
    let recorded: Partial<CandidateMetrics> = {};
    if (typeof row.shadowMetrics === 'string') {
      try {
        recorded = JSON.parse(row.shadowMetrics) as Partial<CandidateMetrics>;
      } catch {
        // an unreadable snapshot is simply empty; the score below is what matters
      }
    }
    return {
      passRate: 0,
      failureRate: 0,
      latencyP95: 0,
      latencyP50: 0,
      errorRate: 0,
      throughput: 0,
      conformanceScore: 0,
      complexityDelta: 0,
      stability: 0,
      ...recorded,
      score: typeof row.shadowScore === 'number' ? row.shadowScore : 0,
    };
  }



}
