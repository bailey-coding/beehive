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
   * Check if a candidate can be promoted (no active promotions)
   */
  async canPromote(candidateId: string): Promise<boolean> {
    const state = await this.getPromotionState(candidateId);
    return state === null || 
           state.status === 'completed' || 
           state.status === 'failed' || 
           state.status === 'rolled_back' ||
           state.status === 'cancelled';
  }

  /**
   * Generate a unique ID for promotion states
   */
  private generateId(): string {
    return `promo_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
  }
}
