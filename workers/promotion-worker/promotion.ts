/**
 * Promotion Train Logic for the Beehive Promotion Worker
 * M3 Promotion Implementation
 */

import { 
  PromotionMode, 
  PromotionRequest, 
  PromotionResult,
  Rung,
  Env,
} from './types';
import { TournamentManager } from './tournament';
import { MergeTrainManager } from './merge-train';
import { PromotionStateManager } from './state';
import { resolvePromotionMode } from './spec-do';

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
   * Promote a candidate to the next rung
   */
  async promoteCandidate(request: PromotionRequest): Promise<Response> {
    try {
      console.log(`[Promotion] Received promotion request for ${request.candidateId} from ${request.fromRung} to ${request.toRung}`);

      if (!this.validateRequest(request)) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'Invalid promotion request: missing required fields'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const canPromote = await this.stateManager.canPromote(request.candidateId);
      
      if (!canPromote) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Promotion already in progress for this candidate'
        }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const isValidTransition = this.validateRungTransition(request.fromRung, request.toRung);
      
      if (!isValidTransition) {
        return new Response(JSON.stringify({
          success: false,
          error: `Invalid rung transition: ${request.fromRung} -> ${request.toRung}`
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const mode = await resolvePromotionMode(this.env);

      const promotionState = await this.stateManager.createPromotionState(
        request.candidateId,
        request.specId,
        request.fromRung,
        request.toRung,
        mode,
        request.actorId
      );

      await this.stateManager.transitionToInProgress(promotionState.id);

      let result: PromotionResult;

      if (mode === 'tournament') {
        console.log(`[Promotion] Using tournament mode`);
        result = await this.tournament.executeTournament(request);
      } else {
        console.log(`[Promotion] Using merge-train mode`);
        result = await this.mergeTrain.executeMergeTrain(request);
      }

      if (result.success) {
        await this.stateManager.markAsCompleted(promotionState.id, promotionState.targetRung);
      } else {
        await this.stateManager.markAsFailed(promotionState.id, result.message);
      }

      await this.logAnalytics('promotion', {
        candidateId: request.candidateId,
        specId: request.specId,
        mode,
        success: result.success ? 1 : 0,
        fromRung: request.fromRung,
        toRung: request.toRung,
      });

      return new Response(JSON.stringify(result), {
        status: result.success ? 200 : 500,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[Promotion] Error: ${errorMessage}`);

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

      await this.stateManager.updatePromotionState(state.id, {
        status: 'pending',
        startedAt: new Date().toISOString(),
        failedAt: undefined,
        failureReason: undefined,
      });

      const retryRequest: PromotionRequest = {
        candidateId: state.candidateId,
        specId: state.specId,
        fromRung: state.currentRung,
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
   * Validate promotion request
   */
  private validateRequest(request: PromotionRequest): boolean {
    return Boolean(
      request.candidateId &&
      request.candidateId.trim() !== '' &&
      request.specId &&
      request.specId.trim() !== '' &&
      request.fromRung &&
      request.toRung
    );
  }

  /**
   * Validate rung transition
   */
  private validateRungTransition(fromRung: Rung, toRung: Rung): boolean {
    const rungOrder: Rung[] = ['pre-merge', 'shadow', 'train', 'canary', 'full'];
    const fromIndex = rungOrder.indexOf(fromRung);
    const toIndex = rungOrder.indexOf(toRung);
    return toIndex >= fromIndex;
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
