/**
 * Promotion state management for the Beehive Promotion Worker
 * Interacts with Spec DO to store and retrieve promotion states
 * M3 Promotion Implementation
 */

import { PromotionState, PromotionMode, Rung, Env } from './types';
import { getPromotionLedger } from './spec-do';
import type { PromotionLedgerClient, PromotionStatePatch } from '../shared/promotion-ledger';

/**
 * Manages promotion state stored in the Spec DO
 */
/** PROMOTION_TIMEOUT in seconds (wrangler.toml: "3600"); missing, non-numeric or not positive means 3600 */
export function promotionTimeoutSeconds(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 3600;
}

export class PromotionStateManager {
  private readonly ledger: PromotionLedgerClient;

  constructor(private env: Env) {
    this.ledger = getPromotionLedger(env);
  }

  /**
   * Create a new promotion state record
   */
  async createPromotionState(
    candidateId: string,
    specId: string,
    fromRung: Rung,
    toRung: Rung,
    mode: PromotionMode,
    actorId?: string
  ): Promise<PromotionState> {
    const state: PromotionState = {
      id: this.generateId(),
      candidateId,
      specId,
      currentRung: fromRung,
      targetRung: toRung,
      status: 'pending',
      mode,
      startedAt: new Date().toISOString(),
      actorId,
    };

    const created = await this.ledger.createPromotionState(state, actorId);
    console.log(`[State] Created promotion state: ${created.id} for candidate ${candidateId}`);
    return created;
  }

  /**
   * Latest promotion state for a candidate (the DO lists newest first), or null
   * if it has none. Any non-OK DO response, 404 included, throws.
   */
  async getPromotionState(candidateId: string): Promise<PromotionState | null> {
    const states = await this.ledger.listPromotionStates({ candidateId });
    return states[0] || null;
  }

  /**
   * Get all promotion states. Any non-OK DO response, 404 included, throws.
   */
  async getPromotionStates(): Promise<PromotionState[]> {
    return this.ledger.listPromotionStates();
  }

  /**
   * Update promotion state
   */
  async updatePromotionState(
    stateId: string,
    updates: PromotionStatePatch
  ): Promise<PromotionState> {
    const updated = await this.ledger.updatePromotionState(stateId, updates);
    console.log(`[State] Updated promotion state: ${stateId} to status ${updates.status}`);
    return updated;
  }

  /**
   * Transition promotion state to in-progress
   */
  async transitionToInProgress(stateId: string): Promise<PromotionState> {
    return this.updatePromotionState(stateId, {
      status: 'in_progress',
      startedAt: new Date().toISOString(),
    });
  }

  /**
   * Mark promotion as completed and advance `currentRung` to the rung it reached.
   * `currentRung` is the candidate's rung after the latest completed promotion; for
   * pending/failed attempts it stays the rung the attempt started from (retry relies on that).
   */
  async markAsCompleted(stateId: string, reachedRung: Rung): Promise<PromotionState> {
    return this.updatePromotionState(stateId, {
      status: 'completed',
      currentRung: reachedRung,
      completedAt: new Date().toISOString(),
    });
  }

  /**
   * Mark promotion as failed
   */
  async markAsFailed(stateId: string, reason?: string): Promise<PromotionState> {
    return this.updatePromotionState(stateId, {
      status: 'failed',
      failedAt: new Date().toISOString(),
      failureReason: reason,
    });
  }

  /**
   * Mark promotion as rolled back
   */
  async markAsRolledBack(stateId: string, reason?: string): Promise<PromotionState> {
    return this.updatePromotionState(stateId, {
      status: 'rolled_back',
      completedAt: new Date().toISOString(),
      rollbackReason: reason,
    });
  }

  /**
   * Check if a promotion is currently in progress for a candidate
   */
  async isPromotionInProgress(candidateId: string): Promise<boolean> {
    const state = await this.getPromotionState(candidateId);
    return state?.status === 'in_progress';
  }

  /**
   * Check if a candidate can be promoted (no active promotions). Every promotion state is created and finished inside one /promote request, so
   * one still pending or in_progress after PROMOTION_TIMEOUT seconds was abandoned by a request that failed (a ledger write threw): it is
   * cancelled with an `abandoned` reason and no longer blocks (docs/plans/wave-2a-plan.md part E; review b1-S2). `cancelled` is an allowed
   * exit from both statuses in table (d), as for /cancel. The cancel is best effort: if it fails, the new attempt still runs and it is logged.
   */
  async canPromote(candidateId: string): Promise<boolean> {
    const state = await this.getPromotionState(candidateId);
    if (state === null) return true;
    if (state.status !== 'pending' && state.status !== 'in_progress') return true;
    const timeoutMs = promotionTimeoutSeconds(this.env.PROMOTION_TIMEOUT) * 1000;
    const startedMs = Date.parse(state.startedAt);
    if (!Number.isFinite(startedMs) || Date.now() - startedMs <= timeoutMs) return false;
    try {
      await this.updatePromotionState(state.id, {
        status: 'cancelled',
        completedAt: new Date().toISOString(),
        failureReason: `abandoned: ${state.status} for more than ${timeoutMs / 1000}s`,
      });
    } catch (error) {
      console.error(`[State] Could not cancel abandoned promotion state ${state.id}:`, error instanceof Error ? error.message : String(error));
    }
    return true;
  }

  /**
   * Generate a unique ID for promotion states
   */
  private generateId(): string {
    return `promo_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
  }
}
