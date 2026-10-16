/**
 * Merge-Train Mode Implementation for the Beehive Promotion Worker
 * M3 Promotion Implementation
 */

import { 
  MergeTrainStatus, 
  MergeTrainCandidate, 
  PromotionRequest, 
  PromotionResult,
  Rung,
  Env,
} from './types';
import { setCandidateStage, getPromotionLedger } from './spec-do';

/**
 * Extended merge train type with ID
 */
type MergeTrainWithId = MergeTrainStatus & { id: string };

/**
 * Manages merge-train-style promotion where candidates are merged sequentially
 */
export class MergeTrainManager {
  constructor(private env: Env) {}

  /**
   * Execute merge-train promotion for a candidate
   */
  async executeMergeTrain(request: PromotionRequest): Promise<PromotionResult> {
    try {
      console.log(`[MergeTrain] Processing merge-train promotion for candidate ${request.candidateId}`);

      const train = await this.getOrCreateMergeTrain(request.specId);
      
      if (!train) {
        throw new Error('Failed to create or retrieve merge train');
      }

      const maxConcurrent = parseInt(this.env.MAX_CONCURRENT_CANDIDATES);
      const activeCount = train.candidates.filter(c => 
        c.status === 'waiting' || c.status === 'merging'
      ).length;

      if (activeCount >= maxConcurrent) {
        return {
          success: false,
          candidateId: request.candidateId,
          specId: request.specId,
          fromRung: request.fromRung,
          toRung: request.toRung,
          message: `Maximum concurrent candidates (${maxConcurrent}) reached. Please wait.`,
          timestamp: new Date().toISOString(),
          mode: 'merge-train',
        };
      }

      // Position and capacity come from the train as saved, so a concurrent add cannot reuse a position
      const updatedTrain = await this.modifyMergeTrain(request.specId, (current) => {
        const active = current.candidates.filter(c => c.status === 'waiting' || c.status === 'merging').length;
        if (active >= maxConcurrent) {
          throw new Error(`Maximum concurrent candidates (${maxConcurrent}) reached. Please wait.`);
        }
        const position = current.candidates.length + 1;
        const newCandidate: MergeTrainCandidate = {
          candidateId: request.candidateId,
          specId: request.specId,
          position,
          status: 'waiting',
        };
        return {
          ...current,
          candidates: [...current.candidates, newCandidate],
          currentPosition: position,
          nextMerge: newCandidate.candidateId,
          status: 'processing',
        };
      });
      console.log(`[MergeTrain] Added candidate ${request.candidateId} to position ${updatedTrain.currentPosition}`);

      await this.processMergeTrain(updatedTrain);

      const candidateInTrain = updatedTrain.candidates.find(
        c => c.candidateId === request.candidateId
      );

      if (!candidateInTrain) {
        throw new Error('Candidate not found in merge train after processing');
      }

      return {
        success: true,
        candidateId: request.candidateId,
        specId: request.specId,
        fromRung: request.fromRung,
        toRung: request.toRung,
        message: `Candidate added to merge train at position ${candidateInTrain.position}. Status: ${candidateInTrain.status}`,
        timestamp: new Date().toISOString(),
        mode: 'merge-train',
        details: {
          trainId: updatedTrain.id,
          position: candidateInTrain.position,
          status: candidateInTrain.status,
          mergedAt: candidateInTrain.mergedAt,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[MergeTrain] Error: ${errorMessage}`);

      return {
        success: false,
        candidateId: request.candidateId,
        specId: request.specId,
        fromRung: request.fromRung,
        toRung: request.toRung,
        message: errorMessage,
        timestamp: new Date().toISOString(),
        mode: 'merge-train',
      };
    }
  }

  /**
   * Get merge train status
   */
  async getMergeTrainStatus(specId?: string): Promise<Response> {
    try {
      if (specId) {
        const train = await this.getMergeTrainBySpec(specId);
        
        if (!train) {
          return new Response(JSON.stringify({
            success: false,
            error: `No merge train found for spec ${specId}`,
            timestamp: new Date().toISOString(),
          }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({
          success: true,
          train,
          timestamp: new Date().toISOString(),
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const trains = await this.getAllMergeTrains();

      return new Response(JSON.stringify({
        success: true,
        trains,
        count: trains.length,
        timestamp: new Date().toISOString(),
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
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
   * Get or create a merge train for a spec
   */
  private async getOrCreateMergeTrain(specId: string): Promise<MergeTrainWithId | null> {
    const existing = await this.getMergeTrainBySpec(specId);
    
    if (existing) {
      return existing;
    }

    const train: MergeTrainWithId = {
      id: `mergetrain_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      mode: 'merge-train',
      specId,
      candidates: [],
      currentPosition: 0,
      nextMerge: null,
      status: 'idle',
      startedAt: new Date().toISOString(),
    };

    const saved = await this.saveMergeTrain(train);
    console.log(`[MergeTrain] Created new merge train: ${saved.id} for spec ${specId}`);
    return saved;
  }

  /**
   * Get merge train by spec ID
   */
  private async getMergeTrainBySpec(specId: string): Promise<MergeTrainWithId | null> {
    return getPromotionLedger(this.env).getMergeTrainBySpec(specId);
  }

  /**
   * Get all merge trains
   */
  private async getAllMergeTrains(): Promise<MergeTrainWithId[]> {
    return getPromotionLedger(this.env).listMergeTrains();
  }

  /**
   * Save merge train to Spec DO
   */
  private async saveMergeTrain(train: MergeTrainWithId): Promise<MergeTrainWithId> {
    return getPromotionLedger(this.env).saveMergeTrain(train);
  }

  /**
   * Read-modify-write against the train's current version (re-applied on a conflict).
   * Throws when the spec has no train.
   */
  private async modifyMergeTrain(
    specId: string,
    mutate: (current: MergeTrainWithId) => MergeTrainWithId
  ): Promise<MergeTrainWithId> {
    const saved = await getPromotionLedger(this.env).modifyMergeTrain(specId, mutate);
    if (!saved) throw new Error(`No merge train found for spec ${specId}`);
    return saved;
  }

  /**
   * Update merge train
   */
  private async updateMergeTrain(
    trainId: string,
    updates: Partial<MergeTrainStatus>
  ): Promise<void> {
    await getPromotionLedger(this.env).updateMergeTrain(trainId, updates);
  }

  /**
   * Process merge train - handle pending merges
   */
  private async processMergeTrain(train: MergeTrainWithId): Promise<void> {
    console.log(`[MergeTrain] Processing train ${train.id} with ${train.candidates.length} candidates`);

    const nextCandidate = train.candidates.find(c => c.status === 'waiting');

    if (!nextCandidate) {
      console.log(`[MergeTrain] No waiting candidates in train ${train.id}`);
      return;
    }

    const updatedCandidates = train.candidates.map(c => 
      c.candidateId === nextCandidate.candidateId 
        ? { ...c, status: 'merging' as const }
        : c
    );

    const trainWithMerging: MergeTrainWithId = {
      ...train,
      candidates: updatedCandidates,
      status: 'processing',
    };

    await this.updateMergeTrain(train.id, {
      candidates: updatedCandidates,
      status: 'processing',
    });

    console.log(`[MergeTrain] Starting merge for candidate ${nextCandidate.candidateId}`);

    try {
      await this.executeMerge(nextCandidate);

      const mergedCandidates = updatedCandidates.map(c => 
        c.candidateId === nextCandidate.candidateId 
          ? { 
              ...c, 
              status: 'merged' as const,
              mergedAt: new Date().toISOString()
            }
          : c
      );

      const stillWaiting = mergedCandidates.some(c => c.status === 'waiting');
      
      const updateData: Partial<MergeTrainStatus> = {
        candidates: mergedCandidates,
        currentPosition: nextCandidate.position,
        nextMerge: this.getNextCandidateId(mergedCandidates),
      };

      if (!stillWaiting) {
        updateData.status = 'idle';
        updateData.completedAt = new Date().toISOString();
      }

      await this.updateMergeTrain(train.id, updateData);

      console.log(`[MergeTrain] Successfully merged candidate ${nextCandidate.candidateId}`);

      if (!stillWaiting) {
        console.log(`[MergeTrain] Completed processing train ${train.id}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      const failedCandidates = updatedCandidates.map(c => 
        c.candidateId === nextCandidate.candidateId 
          ? { 
              ...c, 
              status: 'failed' as const,
              failedAt: new Date().toISOString(),
              failureReason: errorMessage
            }
          : c
      );

      await this.updateMergeTrain(train.id, {
        candidates: failedCandidates,
        status: 'idle',
      });

      console.error(`[MergeTrain] Failed to merge candidate ${nextCandidate.candidateId}: ${errorMessage}`);
    }
  }

  /**
   * Execute merge via Gate Workflow
   */
  private async executeMerge(candidate: MergeTrainCandidate): Promise<void> {
    console.log(`[MergeTrain] Executing merge for ${candidate.candidateId}`);

    const response = await this.env.GATE_WORKFLOW.fetch(
      '/run',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          candidateId: candidate.candidateId,
          specId: candidate.specId,
          type: 'merge-promotion',
          timestamp: new Date().toISOString(),
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gate workflow failed: ${error}`);
    }

    const result = await response.json() as { success: boolean; error?: string };

    if (!result.success) {
      throw new Error(`Gate workflow returned failure: ${result.error || 'Unknown error'}`);
    }

    console.log(`[MergeTrain] Gate workflow completed for ${candidate.candidateId}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  /**
   * Get the next candidate ID to merge
   */
  private getNextCandidateId(candidates: MergeTrainCandidate[]): string | null {
    const waiting = candidates.find(c => c.status === 'waiting');
    return waiting?.candidateId || null;
  }

  /**
   * Retry failed merge
   */
  async retryFailedMerge(candidateId: string, specId: string): Promise<PromotionResult> {
    try {
      const updatedTrain = await this.modifyMergeTrain(specId, (train) => {
        const candidate = train.candidates.find(c => c.candidateId === candidateId);

        if (!candidate) {
          throw new Error(`Candidate ${candidateId} not found in merge train`);
        }

        if (candidate.status !== 'failed') {
          throw new Error(`Candidate ${candidateId} is not in a failed state (current: ${candidate.status})`);
        }

        return {
          ...train,
          candidates: train.candidates.map(c =>
            c.candidateId === candidateId
              ? { ...c, status: 'waiting' as const, failedAt: undefined, failureReason: undefined }
              : c
          ),
          status: 'processing',
        };
      });
      await this.processMergeTrain(updatedTrain);

      return {
        success: true,
        candidateId,
        specId,
        fromRung: 'train' as Rung,
        toRung: 'train' as Rung,
        message: `Retrying merge for candidate ${candidateId}`,
        timestamp: new Date().toISOString(),
        mode: 'merge-train',
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      return {
        success: false,
        candidateId,
        specId,
        fromRung: 'train' as Rung,
        toRung: 'train' as Rung,
        message: errorMessage,
        timestamp: new Date().toISOString(),
        mode: 'merge-train',
      };
    }
  }

  /**
   * Rollback a merged candidate
   */
  async rollbackMergedCandidate(
    candidateId: string,
    specId: string,
    reason: string
  ): Promise<PromotionResult> {
    try {
      await this.modifyMergeTrain(specId, (train) => {
        const candidate = train.candidates.find(c => c.candidateId === candidateId);

        if (!candidate) {
          throw new Error(`Candidate ${candidateId} not found in merge train`);
        }

        if (candidate.status !== 'merged') {
          throw new Error(`Candidate ${candidateId} is not in a merged state (current: ${candidate.status})`);
        }

        return {
          ...train,
          candidates: train.candidates.map(c =>
            c.candidateId === candidateId
              ? {
                  ...c,
                  status: 'rolled_back' as const,
                  failedAt: new Date().toISOString(),
                  failureReason: `Rolled back: ${reason}`
                }
              : c
          ),
        };
      });

      // The ledger car is already rolled_back here; a failure below is reported, and the stage write
      // is idempotent
      await setCandidateStage(this.env, candidateId, 'rolled_back', `Rolled back from merge train: ${reason}`);

      return {
        success: true,
        candidateId,
        specId,
        fromRung: 'train' as Rung,
        toRung: 'train' as Rung,
        message: `Rolled back candidate ${candidateId}: ${reason}`,
        timestamp: new Date().toISOString(),
        mode: 'merge-train',
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      return {
        success: false,
        candidateId,
        specId,
        fromRung: 'train' as Rung,
        toRung: 'train' as Rung,
        message: errorMessage,
        timestamp: new Date().toISOString(),
        mode: 'merge-train',
      };
    }
  }
}
