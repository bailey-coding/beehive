/**
 * Tournament Mode Implementation for the Beehive Promotion Worker
 * M3 Promotion Implementation
 */

import { 
  TournamentStatus, 
  TournamentCandidate, 
  CandidateComparison, 
  PromotionRequest, 
  PromotionResult,
  CandidateMetrics,
  Rung,
  Env,
} from './types';
import { getSpecDo, getPromotionLedger } from './spec-do';

/**
 * Extended tournament type with ID
 */
type TournamentWithId = TournamentStatus & { id: string };

/**
 * Manages tournament-style promotion where multiple candidates compete
 */
export class TournamentManager {
  constructor(private env: Env) {}

  /**
   * Execute tournament promotion for a candidate
   */
  async executeTournament(request: PromotionRequest): Promise<PromotionResult> {
    // Set once the tournament is in_progress: only then does a failure belong in the ledger
    let runningId: string | null = null;
    try {
      console.log(`[Tournament] Starting tournament promotion for candidate ${request.candidateId}`);

      const tournament = await this.getOrCreateTournament(request.specId);
      
      if (!tournament) {
        throw new Error('Failed to create or retrieve tournament');
      }

      if (tournament.winner && tournament.status === 'completed') {
        return {
          success: false,
          candidateId: request.candidateId,
          specId: request.specId,
          fromRung: request.fromRung,
          toRung: request.toRung,
          message: `Tournament for spec ${request.specId} already completed with winner ${tournament.winner}`,
          timestamp: new Date().toISOString(),
          mode: 'tournament',
        };
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

        return {
          success: true,
          candidateId: request.candidateId,
          specId: request.specId,
          fromRung: request.fromRung,
          toRung: request.toRung,
          message: `Added to tournament. Waiting for more candidates.`,
          timestamp: new Date().toISOString(),
          mode: 'tournament',
        };
      }

      if (updatedTournament.status !== 'in_progress') {
        await this.startTournament(updatedTournament.id);
      }
      runningId = updatedTournament.id;

      const comparisons = await this.runTournamentComparisons(updatedTournament);
      const winner = this.determineTournamentWinner(updatedTournament.candidates, comparisons);

      if (!winner) {
        throw new Error('Could not determine tournament winner');
      }

      await this.promoteTournamentWinner(winner, request.toRung, updatedTournament);
      await this.completeTournament(updatedTournament.id, winner.candidateId, comparisons);

      console.log(`[Tournament] Tournament completed. Winner: ${winner.candidateId}`);

      return {
        success: true,
        candidateId: winner.candidateId,
        specId: request.specId,
        fromRung: request.fromRung,
        toRung: request.toRung,
        message: `Tournament winner: ${winner.candidateId} promoted to ${request.toRung}`,
        timestamp: new Date().toISOString(),
        mode: 'tournament',
        details: {
          tournamentId: updatedTournament.id,
          comparisons: comparisons.length,
          winner: winner.candidateId,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[Tournament] Error: ${errorMessage}`);
      if (runningId) await this.recordTournamentFailure(runningId, errorMessage);

      return {
        success: false,
        candidateId: request.candidateId,
        specId: request.specId,
        fromRung: request.fromRung,
        toRung: request.toRung,
        message: errorMessage,
        timestamp: new Date().toISOString(),
        mode: 'tournament',
      };
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
   * Get candidate metrics from Spec DO and Shadow Router
   */
  private async getCandidateMetrics(candidateId: string): Promise<CandidateMetrics> {
    const defaultMetrics: CandidateMetrics = {
      passRate: 1.0,
      failureRate: 0.0,
      latencyP95: 100,
      latencyP50: 50,
      errorRate: 0.0,
      throughput: 100,
      score: 80,
      conformanceScore: 100,
      complexityDelta: 0,
      stability: 1.0,
    };

    try {
      const specDoResponse = await getSpecDo(this.env).fetch(
        `/candidates/${encodeURIComponent(candidateId)}`
      );

      if (!specDoResponse.ok) {
        throw new Error(`Failed to get candidate: ${await specDoResponse.text()}`);
      }

      const candidateData = await specDoResponse.json() as { metrics?: Partial<CandidateMetrics>; score?: number };
      return {
        ...defaultMetrics,
        ...(candidateData.metrics || {}),
        score: candidateData.score || defaultMetrics.score,
      };
    } catch (error) {
      console.error(`[Tournament] Failed to get metrics for ${candidateId}:`, error);
      return defaultMetrics;
    }
  }

  /**
   * Start tournament comparisons
   */
  private async startTournament(tournamentId: string): Promise<void> {
    await this.updateTournamentStatus(tournamentId, {
      status: 'in_progress',
    });
    console.log(`[Tournament] Started tournament: ${tournamentId}`);
  }

  /**
   * Run comparisons between all competing candidates
   */
  private async runTournamentComparisons(
    tournament: TournamentWithId
  ): Promise<CandidateComparison[]> {
    const comparisons: CandidateComparison[] = [];
    const competingCandidates = tournament.candidates.filter(
      c => c.status === 'competing'
    );

    console.log(`[Tournament] Running comparisons for ${competingCandidates.length} candidates`);

    for (let i = 0; i < competingCandidates.length; i++) {
      for (let j = i + 1; j < competingCandidates.length; j++) {
        const candidateA = competingCandidates[i];
        const candidateB = competingCandidates[j];

        try {
          const comparison = await this.compareCandidates(candidateA, candidateB);
          comparisons.push(comparison);
        } catch (error) {
          console.error(
            `[Tournament] Failed to compare ${candidateA.candidateId} vs ${candidateB.candidateId}:`,
            error
          );
        }
      }
    }

    return comparisons;
  }

  /**
   * Compare two candidates
   */
  private async compareCandidates(
    candidateA: TournamentCandidate,
    candidateB: TournamentCandidate
  ): Promise<CandidateComparison> {
    try {
      const response = await this.env.SHADOW_ROUTER.fetch(
        '/compare',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            candidate1: candidateA.candidateId,
            candidate2: candidateB.candidateId,
            specId: candidateA.specId,
          }),
        }
      );

      if (response.ok) {
        const result = await response.json() as { winner?: string; score?: number };
        if (result.winner) {
          return {
            candidate1: candidateA.candidateId,
            candidate2: candidateB.candidateId,
            winner: result.winner,
            comparisonScore: result.score || Math.abs(candidateA.score - candidateB.score),
            comparedAt: new Date().toISOString(),
          };
        }
      }

      console.log(`[Tournament] Using fallback comparison`);
      return this.fallbackCompareCandidates(candidateA, candidateB);
    } catch (error) {
      console.warn(`[Tournament] Comparison failed, using fallback:`, error);
      return this.fallbackCompareCandidates(candidateA, candidateB);
    }
  }

  /**
   * Fallback comparison when Scientist Comparator is unavailable
   */
  private fallbackCompareCandidates(
    candidateA: TournamentCandidate,
    candidateB: TournamentCandidate
  ): CandidateComparison {
    const scoreDiff = candidateA.score - candidateB.score;
    const winner = scoreDiff >= 0 ? candidateA.candidateId : candidateB.candidateId;
    
    return {
      candidate1: candidateA.candidateId,
      candidate2: candidateB.candidateId,
      winner,
      comparisonScore: Math.abs(scoreDiff),
      comparedAt: new Date().toISOString(),
    };
  }

  /**
   * Determine tournament winner from candidates and comparisons
   */
  private determineTournamentWinner(
    candidates: TournamentCandidate[],
    comparisons: CandidateComparison[]
  ): TournamentCandidate | null {
    if (candidates.length === 0) {
      return null;
    }

    if (candidates.length === 1) {
      return candidates[0];
    }

    const wins: Record<string, number> = {};
    for (const candidate of candidates) {
      wins[candidate.candidateId] = 0;
    }

    for (const comparison of comparisons) {
      wins[comparison.winner] = (wins[comparison.winner] || 0) + 1;
    }

    const scores: Record<string, number> = {};
    const maxWins = Math.max(...Object.values(wins), 1);

    for (const candidate of candidates) {
      const winScore = (wins[candidate.candidateId] / maxWins) * 40;
      const directScore = candidate.score * 0.6;
      scores[candidate.candidateId] = winScore + directScore;
    }

    let maxScore = -Infinity;
    let winner: TournamentCandidate | null = null;

    for (const candidate of candidates) {
      const score = scores[candidate.candidateId] || 0;
      if (score > maxScore) {
        maxScore = score;
        winner = candidate;
      }
    }

    return winner;
  }

  /**
   * Promote tournament winner to target rung
   */
  private async promoteTournamentWinner(
    winner: TournamentCandidate,
    toRung: Rung,
    tournament: TournamentWithId
  ): Promise<void> {
    console.log(`[Tournament] Promoting winner ${winner.candidateId} to ${toRung}`);

    const promoted = await getSpecDo(this.env).fetch(
      `/candidates/${encodeURIComponent(winner.candidateId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          current_rung: toRung,
          status: 'promoted',
          promoted_at: new Date().toISOString(),
        }),
      }
    );
    if (!promoted.ok) {
      throw new Error(`Failed to promote ${winner.candidateId}: ${promoted.status} ${await promoted.text()}`);
    }

    const updatedCandidates = tournament.candidates.map(c =>
      c.candidateId === winner.candidateId
        ? { ...c, status: 'winner' as const, promotedAt: new Date().toISOString() }
        : { ...c, status: 'eliminated' as const }
    );

    await this.updateTournament(tournament.id, {
      winner: winner.candidateId,
      candidates: updatedCandidates,
    });
  }

  /**
   * Complete tournament
   */
  private async completeTournament(
    tournamentId: string,
    winnerId: string,
    comparisons: CandidateComparison[]
  ): Promise<void> {
    await this.updateTournament(tournamentId, {
      status: 'completed',
      winner: winnerId,
      completedAt: new Date().toISOString(),
    });

    console.log(`[Tournament] Completed tournament ${tournamentId}. Winner: ${winnerId}`);
  }
}
