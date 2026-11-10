/**
 * Promotion Train Logic for the Beehive Promotion Worker
 * M3 Promotion Implementation
 */

import { 
  PromotionMode, 
  PromotionRequest, 
  ResolvedPromotionRequest,
  PromotionResult,
  PromotionMove,
  Rung,
  Env,
} from './types';
import { TournamentManager, TOURNAMENT_TO_RUNG } from './tournament';
import { MergeTrainManager } from './merge-train';
import { PromotionStateManager } from './state';
import { resolvePromotionMode, advanceCandidate, getCandidate, type AdvanceOutcome } from './spec-do';
import { AdvanceToRungSchema } from '../shared/promotion-advance';

/** In merge-train mode the train is the step that leaves the train rung (train -> canary); every other move is a direct advance */
const MERGE_TRAIN_TO_RUNG: Rung = 'canary';

/** HTTP status for a promotion result: a stable code maps to a status, never a blanket 500 (docs/plans/promotion-gaps-plan.md section 3.5) */
export function statusFor(result: PromotionResult): number {
  if (result.success) return result.outcome === 'waiting' || result.outcome === 'queued' ? 202 : 200;
  switch (result.code) {
    case 'candidate_not_found':
      return 404;
    case 'stale_from_rung':
    case 'not_next_rung':
    case 'evidence_missing':
    case 'no_shadow_evidence':
    case 'tie':
    case 'tournament_completed':
    case 'tournament_exhausted':
    case 'not_enough_entrants':
    case 'evidence_failed':
    case 'spec_mismatch':
    case 'train_full':
    case 'car_not_failed':
    case 'gate_failed':
      return 409;
    case 'ledger_too_old':
      return 503;
    case 'ledger_error':
      return 502;
    default:
      return 500;
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * Main promotion worker that orchestrates promotion based on mode
 */
export class PromotionWorker {
  private tournament: TournamentManager;
  private mergeTrain: MergeTrainManager;
  private stateManager: PromotionStateManager;

  constructor(private env: Env) {
    this.tournament = new TournamentManager(env);
    this.mergeTrain = new MergeTrainManager(env);
    this.stateManager = new PromotionStateManager(env);
  }

  /**
   * Promote a candidate to the next rung. The Spec DO's `advance` is the decision point: this method asks it (dry run) whether the move is
   * legal before creating any promotion state, then either runs the competitive step for it (the tournament for shadow -> train, the merge
   * train for train -> canary) or advances directly. Every refusal keeps the Spec DO's reason as a `code`.
   */
  async promoteCandidate(request: PromotionRequest): Promise<Response> {
    try {
      console.log(`[Promotion] Received promotion request for ${request.candidateId} to ${request.toRung}`);

      if (!this.validateRequest(request)) {
        return json(400, { success: false, error: 'Invalid promotion request: missing required fields, or toRung is not one of shadow, train, canary, full' });
      }

      const canPromote = await this.stateManager.canPromote(request.candidateId);
      
      if (!canPromote) {
        return json(409, { success: false, error: 'Promotion already in progress for this candidate' });
      }

      const mode = await resolvePromotionMode(this.env);

      // Advisory: the real move re-checks everything in the Spec DO's own transaction
      const check = await advanceCandidate(this.env, request.candidateId, { toRung: request.toRung as 'shadow' | 'train' | 'canary' | 'full', fromRung: request.fromRung, dryRun: true }, request.actorId);
      if (!check.ok) {
        const refused = this.refusal(request, check, mode);
        return json(statusFor(refused), { ...refused, error: refused.message, ...(check.evidence ? { evidence: check.evidence } : {}) });
      }
      // The caller names the spec; the candidate's own spec is the truth. A mismatch would let a candidate compete, or queue, under a spec that is not its own.
      const row = await getCandidate(this.env, request.candidateId).catch((error: unknown) => error as Error);
      if (row instanceof Error) {
        const failed = this.base(request, request.fromRung ?? 'pre-merge', mode, { success: false, code: 'ledger_error', message: row.message });
        return json(statusFor(failed), { ...failed, error: failed.message });
      }
      const ownSpec = (row.specId ?? row.spec_id) as string | undefined;
      if (ownSpec !== request.specId) {
        const failed = this.base(request, request.fromRung ?? 'pre-merge', mode, {
          success: false, code: 'spec_mismatch', message: `Candidate ${request.candidateId} belongs to spec ${ownSpec ?? 'unknown'}, not ${request.specId}`,
        });
        return json(statusFor(failed), { ...failed, error: failed.message });
      }
      // A candidate whose shadow verdict failed does not enter the competitive step (plan V2). Under log mode the dry run lets it through, so this is the worker's refusal.
      if (mode === 'tournament' && request.toRung === TOURNAMENT_TO_RUNG && check.data.evidence.some((e) => e.rung === 'shadow' && e.status === 'failed')) {
        const failed = this.base(request, check.data.fromRung ?? request.fromRung ?? 'pre-merge', mode, {
          success: false, code: 'evidence_failed', message: `Candidate ${request.candidateId} has a failing shadow verdict and cannot enter the tournament`,
        });
        return json(statusFor(failed), { ...failed, error: failed.message });
      }
      if (check.data.noop) {
        const done = this.base(request, check.data.fromRung ?? request.fromRung ?? 'pre-merge', mode, { success: true, outcome: 'noop' as const, message: `Candidate ${request.candidateId} is already past ${request.toRung}` });
        return json(200, done);
      }
      const fromRung: Rung = check.data.fromRung ?? request.fromRung ?? 'pre-merge';
      const resolved: ResolvedPromotionRequest = { ...request, fromRung };

      const promotionState = await this.stateManager.createPromotionState(
        request.candidateId,
        request.specId,
        fromRung,
        request.toRung,
        mode,
        request.actorId
      );

      await this.stateManager.transitionToInProgress(promotionState.id);

      let result: PromotionResult;

      if (mode === 'tournament' && request.toRung === TOURNAMENT_TO_RUNG) {
        console.log(`[Promotion] Using tournament mode`);
        result = await this.tournament.executeTournament(resolved);
      } else if (mode === 'merge-train' && request.toRung === MERGE_TRAIN_TO_RUNG) {
        console.log(`[Promotion] Using merge-train mode`);
        result = await this.mergeTrain.executeMergeTrain(resolved);
      } else {
        result = await this.advanceDirectly(resolved, mode);
      }

      if (result.success) {
        // Only a candidate whose stage moved reached the target rung; a waiting, queued or eliminated attempt finished where it started
        const moved = result.outcome === 'moved' || result.outcome === 'noop';
        await this.stateManager.markAsCompleted(promotionState.id, moved ? promotionState.targetRung : fromRung);
        // Someone else's stage moved in this call (a tournament winner, a merged car): their ledger shows who moved, when and why
        for (const move of result.moves ?? []) {
          if (move.candidateId !== request.candidateId) await this.recordMove(move, request, mode);
        }
      } else {
        await this.stateManager.markAsFailed(promotionState.id, result.code ? `${result.code}: ${result.message}` : result.message);
      }

      await this.logAnalytics('promotion', {
        candidateId: request.candidateId,
        specId: request.specId,
        mode,
        success: result.success ? 1 : 0,
        fromRung,
        toRung: request.toRung,
      });

      return json(statusFor(result), result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[Promotion] Error: ${errorMessage}`);

      return json(500, {
        success: false,
        error: errorMessage,
        timestamp: new Date().toISOString()
      });
    }
  }

  /** The shared result fields */
  private base(request: PromotionRequest, fromRung: Rung, mode: PromotionMode, rest: Pick<PromotionResult, 'success' | 'message'> & Partial<PromotionResult>): PromotionResult {
    return { candidateId: request.candidateId, specId: request.specId, fromRung, toRung: request.toRung, timestamp: new Date().toISOString(), mode, ...rest };
  }

  /** A failed `advance` as a result: the Spec DO's code and message, with nothing created in the promotion ledger */
  private refusal(request: PromotionRequest, failed: Extract<AdvanceOutcome, { ok: false }>, mode: PromotionMode): PromotionResult {
    return this.base(request, request.fromRung ?? 'pre-merge', mode, { success: false, code: failed.code, message: failed.message });
  }

  /** Every move that is not a competition (and every move in the other mode's competitive step): ask the Spec DO to advance the candidate */
  private async advanceDirectly(request: ResolvedPromotionRequest, mode: PromotionMode): Promise<PromotionResult> {
    const advanced = await advanceCandidate(
      this.env,
      request.candidateId,
      { toRung: request.toRung as 'shadow' | 'train' | 'canary' | 'full', fromRung: request.fromRung, notes: `Promoted to ${request.toRung} (${mode} mode)` },
      request.actorId
    );
    if (!advanced.ok) return this.refusal(request, advanced, mode);
    const moves: PromotionMove[] = advanced.data.noop ? [] : [{ candidateId: request.candidateId, fromRung: request.fromRung, toRung: request.toRung }];
    return this.base(request, request.fromRung, mode, {
      success: true,
      outcome: advanced.data.noop ? 'noop' : 'moved',
      moves,
      message: advanced.data.noop ? `Candidate ${request.candidateId} is already past ${request.toRung}` : `Candidate ${request.candidateId} advanced to ${request.toRung}`,
      details: { stage: advanced.data.stage, evidence: advanced.data.evidence },
    });
  }

  /**
   * A promotion state for a candidate other than the requester whose stage this call moved (tournament winner, merged car). Its stage is the
   * truth and has already been written, so a ledger error here is logged, not turned into a failed request.
   */
  private async recordMove(move: PromotionMove, request: PromotionRequest, mode: PromotionMode): Promise<void> {
    try {
      const state = await this.stateManager.createPromotionState(move.candidateId, request.specId, move.fromRung, move.toRung, mode, request.actorId);
      await this.stateManager.transitionToInProgress(state.id);
      await this.stateManager.markAsCompleted(state.id, move.toRung);
    } catch (error) {
      console.error(`[Promotion] Could not record the move of ${move.candidateId} to ${move.toRung}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get promotion status for all candidates
   */
  async getPromotionStatus(): Promise<Response> {
    try {
      const states = await this.stateManager.getPromotionStates();

      return new Response(JSON.stringify({
        success: true,
        states,
        timestamp: new Date().toISOString()
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      return new Response(JSON.stringify({
        success: false,
        error: errorMessage,
        timestamp: new Date().toISOString()
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  /**
   * Process a queue message
   */
  async processQueueMessage(message: { id: string; body: string; timestamp: number }): Promise<void> {
    try {
      const body = JSON.parse(message.body) as PromotionRequest;
      console.log(`[Promotion] Processing queue message: ${message.id}`);
      await this.promoteCandidate(body);
    } catch (error) {
      console.error('Failed to process promotion message:', error);
      throw error;
    }
  }

  /**
   * Get status for a specific candidate
   */
  async getCandidatePromotionStatus(candidateId: string): Promise<Response> {
    try {
      const state = await this.stateManager.getPromotionState(candidateId);
      
      if (!state) {
        return new Response(JSON.stringify({
          success: true,
          candidateId,
          status: 'not_started',
          timestamp: new Date().toISOString()
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({
        success: true,
        candidateId,
        state,
        timestamp: new Date().toISOString()
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      return new Response(JSON.stringify({
        success: false,
        error: errorMessage,
        timestamp: new Date().toISOString()
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  /**
   * Retry a failed promotion
   */
  async retryPromotion(candidateId: string, actorId?: string): Promise<Response> {
    try {
      const state = await this.stateManager.getPromotionState(candidateId);
      
      if (!state) {
        return new Response(JSON.stringify({
          success: false,
          error: `No promotion state found for candidate ${candidateId}`,
          timestamp: new Date().toISOString()
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (state.status !== 'failed') {
        return new Response(JSON.stringify({
          success: false,
          error: `Cannot retry: promotion is not in failed state (current: ${state.status})`,
          timestamp: new Date().toISOString()
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // The failed state stays as history and the retry is a new attempt with its own state. (It used to reset the old state to pending and
      // then call promoteCandidate, whose in-progress check refuses a pending state, so a retry could never run against a real ledger.)
      // fromRung is omitted: the Spec DO derives where the candidate is now, and a stale rung from the failed attempt would be a 409
      const retryRequest: PromotionRequest = {
        candidateId: state.candidateId,
        specId: state.specId,
        toRung: state.targetRung,
        actorId,
      };

      const result = await this.promoteCandidate(retryRequest);
      const resultData = await result.json() as { success?: boolean };
      const isSuccess = resultData.success === true;

      return new Response(JSON.stringify({
        success: isSuccess,
        message: `Retry ${isSuccess ? 'initiated' : 'failed'}`,
        data: resultData,
        timestamp: new Date().toISOString()
      }), {
        status: result.status,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      return new Response(JSON.stringify({
        success: false,
        error: errorMessage,
        timestamp: new Date().toISOString()
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  /**
   * Cancel a pending promotion
   */
  async cancelPromotion(candidateId: string, reason?: string): Promise<Response> {
    try {
      const state = await this.stateManager.getPromotionState(candidateId);
      
      if (!state) {
        return new Response(JSON.stringify({
          success: false,
          error: `No promotion state found for candidate ${candidateId}`,
          timestamp: new Date().toISOString()
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (state.status !== 'pending' && state.status !== 'in_progress') {
        return new Response(JSON.stringify({
          success: false,
          error: `Cannot cancel: promotion is not in pending or in_progress state (current: ${state.status})`,
          timestamp: new Date().toISOString()
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      await this.stateManager.updatePromotionState(state.id, {
        status: 'cancelled',
        completedAt: new Date().toISOString(),
        failureReason: reason || 'Cancelled by user',
      });

      return new Response(JSON.stringify({
        success: true,
        message: `Promotion for candidate ${candidateId} cancelled`,
        candidateId,
        timestamp: new Date().toISOString()
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      return new Response(JSON.stringify({
        success: false,
        error: errorMessage,
        timestamp: new Date().toISOString()
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  /**
   * Validate promotion request. toRung must be a rung a candidate moves INTO (pre-merge is where every candidate starts).
   */
  private validateRequest(request: PromotionRequest): boolean {
    return Boolean(
      request.candidateId &&
      request.candidateId.trim() !== '' &&
      request.specId &&
      request.specId.trim() !== '' &&
      AdvanceToRungSchema.safeParse(request.toRung).success
    );
  }

  /**
   * Log analytics event
   */
  private async logAnalytics(event: string, data: Record<string, unknown>) {
    try {
      await this.env.ANALYTICS.writeDataPoint({
        indexes: [Date.now().toString()],
        blobs: [event],
        doubles: Object.values(data).filter(v => typeof v === 'number') as number[]
      });
    } catch (error) {
      console.warn(`[Promotion] Failed to log analytics:`, error);
    }
  }
}
