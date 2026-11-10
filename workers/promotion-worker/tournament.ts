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

export type TournamentRefusalCode = 'no_shadow_evidence' | 'tie' | 'tournament_completed';

/** A decision that cannot be made, with a stable code. The tournament is recorded failed (retryable) and the caller gets the code. */
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
   * with a code (`no_shadow_evidence`, `tie`, an `advance` refusal): the tournament is then recorded failed and can be retried.
   */
  async executeTournament(request: ResolvedPromotionRequest): Promise<PromotionResult> {
    // Set once the tournament is in_progress: only then does a failure belong in the ledger
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

      const updatedTournament = await this.addCandidateToTournament(
        tournament,
        request.candidateId,
        request.fromRung
      );

      if (updatedTournament.candidates.length < 2) {
        await this.updateTournamentStatus(updatedTournament.id, {
          status: 'pending',
        });

        // Not a move: the caller records this attempt as finished at the rung it started from
        return result({ success: true, outcome: 'waiting', message: `Added to tournament. Waiting for more candidates.` });
      }

      if (updatedTournament.status !== 'in_progress') {
        await this.startTournament(updatedTournament.id);
      }
      runningId = updatedTournament.id;

      // Scores are read now, for every entrant, from the ledger: a score that landed after a candidate joined counts, and a missing
      // score is "no evidence", never a default
      const entrants: Array<{ candidateId: string; score: number | null }> = [];
      for (const c of updatedTournament.candidates.filter((x) => x.status === 'competing')) {
        entrants.push({ candidateId: c.candidateId, score: await this.readShadowScore(c.candidateId) });
      }
      const decision = decideTournament(entrants);
      if (decision.kind === 'refused') throw new TournamentRefusal(decision.code, decision.message);

      // The decision is ledger evidence: a decided trial, winner against runner-up (needs the caller's actor; the trial's decided_by is a foreign key)
      let trialId: string | null = null;
      if (request.actorId) {
        trialId = await recordDecidedTrial(this.env, {
          specId: request.specId,
          candidateAId: decision.winnerId,
          candidateBId: decision.runnerUpId,
          winnerId: decision.winnerId,
          comparisonMetrics: { basis: 'shadow_score', tournamentId: updatedTournament.id, scores: decision.scores },
          actorId: request.actorId,
          idempotencyKey: `tournament:${updatedTournament.id}:${decision.winnerId}`,
        });
      }

      // The Spec DO decides whether the winner may move; a refusal here (the verdict flipped, the stage changed) fails the tournament, retryably
      const advanced = await advanceCandidate(
        this.env,
        decision.winnerId,
        { toRung: TOURNAMENT_TO_RUNG as 'train', fromRung: TOURNAMENT_FROM_RUNG, notes: `Tournament ${updatedTournament.id} winner` },
        request.actorId
      );
      if (!advanced.ok) throw new TournamentRefusal(advanced.code, `Winner ${decision.winnerId} could not advance: ${advanced.message}`);

      await this.recordWinner(decision.winnerId, updatedTournament);

      console.log(`[Tournament] Tournament completed. Winner: ${decision.winnerId}`);

      const won = decision.winnerId === request.candidateId;
      return result({
        success: true,
        outcome: won ? 'moved' : 'eliminated',
        message: `Tournament winner: ${decision.winnerId} promoted to ${request.toRung}`,
        moves: [{ candidateId: decision.winnerId, fromRung: request.fromRung, toRung: request.toRung }],
        details: {
          tournamentId: updatedTournament.id,
          winner: decision.winnerId,
          scores: decision.scores,
          ...(trialId ? { trialId } : { trial: 'skipped: no actorId on the request' }),
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[Tournament] Error: ${errorMessage}`);
      if (runningId) await this.recordTournamentFailure(runningId, errorMessage);

      return result({
        success: false,
        code: error instanceof TournamentRefusal ? error.code : 'tournament_error',
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

    const saved = await this.saveTournament(tournament);
    console.log(`[Tournament] Created new tournament: ${saved.id} for spec ${specId}`);
    return saved;
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
  private async recordTournamentFailure(tournamentId: string, reason: string): Promise<void> {
    try {
      await this.updateTournament(tournamentId, { status: 'failed', failureReason: reason });
    } catch (error) {
      console.error(`[Tournament] Could not record failure of ${tournamentId}:`, error);
    }
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

  /**
   * The candidate's shadow score in the ledger, or null when it has none. Throws on any non-2xx (a 404 included), never "no score".
   * A score of 0 is a real score.
   */
  private async readShadowScore(candidateId: string): Promise<number | null> {
    const row = (await getCandidate(this.env, candidateId)) as { shadowScore?: unknown };
    return typeof row.shadowScore === 'number' ? row.shadowScore : null;
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

  /**
   * Mark the tournament in progress
   */
  private async startTournament(tournamentId: string): Promise<void> {
    await this.updateTournamentStatus(tournamentId, {
      status: 'in_progress',
    });
    console.log(`[Tournament] Started tournament: ${tournamentId}`);
  }

  /**
   * Record the winner and the eliminated entrants, then complete the tournament. The winner's stage was already written by `advance`.
   */
  private async recordWinner(winnerId: string, tournament: TournamentWithId): Promise<void> {
    const at = new Date().toISOString();
    const updatedCandidates = tournament.candidates.map(c =>
      c.candidateId === winnerId
        ? { ...c, status: 'winner' as const, promotedAt: at }
        : { ...c, status: 'eliminated' as const }
    );

    await this.updateTournament(tournament.id, {
      winner: winnerId,
      candidates: updatedCandidates,
    });
    await this.updateTournament(tournament.id, {
      status: 'completed',
      winner: winnerId,
      completedAt: at,
    });
  }
}
