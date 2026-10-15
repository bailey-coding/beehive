/**
 * Promotion state management for the Beehive Promotion Worker
 * Interacts with Spec DO to store and retrieve promotion states
 * M3 Promotion Implementation
 */

import { PromotionState, PromotionMode, Rung, Env } from './types';
import { SpecDOStub, getSpecDo } from './spec-do';

/**
 * Manages promotion state stored in the Spec DO
 */
export class PromotionStateManager {
  private readonly specDo: SpecDOStub;

  constructor(private env: Env) {
    this.specDo = getSpecDo(env);
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

    const response = await this.specDo.fetch(
      '/promotion-states',
      {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-Actor-ID': actorId || 'system',
        },
        body: JSON.stringify(state),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to create promotion state: ${error}`);
    }

    const created = await response.json() as PromotionState;
    console.log(`[State] Created promotion state: ${created.id} for candidate ${candidateId}`);
    return created;
  }

  /**
   * Get promotion state for a specific candidate
   */
  async getPromotionState(candidateId: string): Promise<PromotionState | null> {
    const response = await this.specDo.fetch(
      `/promotion-states?candidateId=${encodeURIComponent(candidateId)}`
    );

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      const error = await response.text();
      throw new Error(`Failed to get promotion state: ${error}`);
    }

    const states = await response.json() as PromotionState[];
    return states[0] || null;
  }

  /**
   * Get all promotion states
   */
  async getPromotionStates(): Promise<PromotionState[]> {
    const response = await this.specDo.fetch('/promotion-states');

    if (!response.ok) {
      if (response.status === 404) {
        return [];
      }
      const error = await response.text();
      throw new Error(`Failed to get promotion states: ${error}`);
    }

    return await response.json() as PromotionState[];
  }

  /**
   * Update promotion state
   */
  async updatePromotionState(
    stateId: string,
    updates: Partial<PromotionState>
  ): Promise<PromotionState> {
    const response = await this.specDo.fetch(
      `/promotion-states/${encodeURIComponent(stateId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to update promotion state: ${error}`);
    }

    const updated = await response.json() as PromotionState;
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
   * Mark promotion as completed
   */
  async markAsCompleted(stateId: string): Promise<PromotionState> {
    return this.updatePromotionState(stateId, {
      status: 'completed',
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
