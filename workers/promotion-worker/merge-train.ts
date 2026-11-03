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
import { setCandidateStage, getPromotionLedger, getCandidate } from './spec-do';
import { GATE_WORKFLOW_ORIGIN, GATE_PRE_MERGE_PATH } from '../shared/schemas';

/**
 * Extended merge train type with ID
 */
type MergeTrainWithId = MergeTrainStatus & { id: string };

/**
 * A car is (position, candidateId), the same key the Spec DO's near-miss diff uses: a candidate gets a new car on every
 * merge-train promotion and after a failure, so candidateId alone matches older cars too.
 */
type CarKey = Pick<MergeTrainCandidate, 'position' | 'candidateId'>;

const isCar = (c: CarKey, key: CarKey) => c.position === key.position && c.candidateId === key.candidateId;

/** Applies fn to the first car with this key only */
function updateCar(
  cars: MergeTrainCandidate[],
  key: CarKey,
  fn: (c: MergeTrainCandidate) => MergeTrainCandidate
): MergeTrainCandidate[] {
  const i = cars.findIndex((c) => isCar(c, key));
  return i < 0 ? cars : cars.map((c, j) => (j === i ? fn(c) : c));
}

/** The candidate's car with the highest position (ties: the later one); a car without a position never replaces an earlier match */
function latestCar(cars: MergeTrainCandidate[], candidateId: string): MergeTrainCandidate | undefined {
  let latest: MergeTrainCandidate | undefined;
  for (const c of cars) {
    if (c.candidateId !== candidateId) continue;
    if (!latest || c.position >= latest.position) latest = c;
  }
  return latest;
}

/** Unique even if a car was removed or a position repeats; equals length + 1 for every worker-written train */
function nextPosition(cars: MergeTrainCandidate[]): number {
  return Math.max(cars.length, ...cars.map((c) => c.position).filter((p) => Number.isInteger(p))) + 1;
}

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
        const position = nextPosition(current.candidates);
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

      // The car this call added: the add set currentPosition to its position
      const candidateInTrain = updatedTrain.candidates.find(c =>
        isCar(c, { position: updatedTrain.currentPosition, candidateId: request.candidateId })
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
   * Throws when the spec has no train. A null from mutate writes nothing and resolves to the current record.
   */
  private async modifyMergeTrain(
    specId: string,
    mutate: (current: MergeTrainWithId) => MergeTrainWithId | null
  ): Promise<MergeTrainWithId> {
    const saved = await getPromotionLedger(this.env).modifyMergeTrain(specId, mutate);
    if (!saved) throw new Error(`No merge train found for spec ${specId}`);
    return saved;
  }

  /**
   * Process merge train: claim the first waiting car, run its gate, record the outcome. The claim and the outcome are
   * each one CAS write (re-read on a conflict, so a car added meanwhile is kept), and both touch only the claimed car.
   * No I/O happens inside a mutate.
   */
  private async processMergeTrain(train: MergeTrainWithId): Promise<void> {
    console.log(`[MergeTrain] Processing train ${train.id} with ${train.candidates.length} candidates`);

    // Set only by the mutate attempt that returns a write: casLoop returns the current record when mutate returns
    // null, so the saved record cannot tell whether this call claimed a car
    const claim: { car: MergeTrainCandidate | null } = { car: null };
    try {
      await this.modifyMergeTrain(train.specId, (current) => {
        claim.car = null;
        if (current.id !== train.id) return null;
        const next = current.candidates.find(c => c.status === 'waiting');
        if (!next) return null;
        claim.car = next;
        return {
          ...current,
          candidates: updateCar(current.candidates, next, c => ({ ...c, status: 'merging' as const })),
          status: 'processing',
        };
      });
    } catch (error) {
      // The car stays waiting for the next run; the add itself succeeded
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[MergeTrain] Could not claim a car in train ${train.id}: ${errorMessage}`);
      return;
    }

    const car = claim.car;
    if (!car) {
      console.log(`[MergeTrain] No waiting candidates in train ${train.id}`);
      return;
    }

    console.log(`[MergeTrain] Starting merge for candidate ${car.candidateId} (position ${car.position})`);

    // Only the gate call is guarded: a failed outcome write must never mark a car failed whose gate passed
    let failureReason: string | null = null;
    try {
      await this.executeMerge(car);
    } catch (error) {
      failureReason = error instanceof Error ? error.message : String(error);
    }

    const at = new Date().toISOString();
    let written = false;
    try {
      await this.modifyMergeTrain(train.specId, (current) => {
        written = false;
        if (current.id !== train.id) return null;
        // Defensive: no worker path moves a car out of merging; a non-worker or old-worker write may have
        if (current.candidates.find(c => isCar(c, car))?.status !== 'merging') return null;
        written = true;
        if (failureReason !== null) {
          return {
            ...current,
            candidates: updateCar(current.candidates, car, c => ({
              ...c,
              status: 'failed' as const,
              failedAt: at,
              failureReason: failureReason!,
            })),
            status: 'idle',
          };
        }
        const candidates = updateCar(current.candidates, car, c => ({ ...c, status: 'merged' as const, mergedAt: at }));
        const stillWaiting = candidates.some(c => c.status === 'waiting');
        return {
          ...current,
          candidates,
          currentPosition: car.position,
          nextMerge: this.getNextCandidateId(candidates),
          ...(stillWaiting ? {} : { status: 'idle' as const, completedAt: at }),
        };
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(
        `[MergeTrain] Could not record the outcome for candidate ${car.candidateId} (position ${car.position}); the car stays merging: ${errorMessage}`
      );
      throw error;
    }

    if (!written) {
      console.warn(`[MergeTrain] Car ${car.candidateId} (position ${car.position}) is no longer merging; outcome not recorded`);
    } else if (failureReason !== null) {
      console.error(`[MergeTrain] Failed to merge candidate ${car.candidateId}: ${failureReason}`);
    } else {
      console.log(`[MergeTrain] Successfully merged candidate ${car.candidateId}`);
    }
  }

  /**
   * Execute merge via the gate workflow: POST /gates/pre-merge over the GATE_WORKFLOW binding (absolute URL, bearer
   * auth) and read the verdict — a car merges only on result.status === 'pass' (the route answers 201 with
   * success: true even for a fail verdict). No Idempotency-Key: the car has no lease/attempt id, so a key could not
   * be stable across a redelivery of one claim yet different across a retry of the same car
   * (docs/plans/merge-train-gate-call-plan.md section 2 part 3).
   */
  private async executeMerge(candidate: MergeTrainCandidate): Promise<void> {
    console.log(`[MergeTrain] Executing merge for ${candidate.candidateId}`);

    // Fail closed without the token, same as the queue consumer
    if (!this.env.API_AUTH_TOKEN) {
      throw new Error('API_AUTH_TOKEN not configured');
    }

    // A car carries only candidateId/specId; the commit shas live on the candidate row (camelCase in the API response)
    const row = await getCandidate(this.env, candidate.candidateId);
    const nonEmpty = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
    const commitSha = nonEmpty(row.commitSha) ?? nonEmpty(row.commit_sha);
    const baseCommitSha = nonEmpty(row.baseCommitSha) ?? nonEmpty(row.base_commit_sha);
    if (!commitSha || !baseCommitSha) {
      throw new Error(`Candidate ${candidate.candidateId} has no commitSha/baseCommitSha`);
    }

    const response = await this.env.GATE_WORKFLOW.fetch(
      `${GATE_WORKFLOW_ORIGIN}${GATE_PRE_MERGE_PATH}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.env.API_AUTH_TOKEN}`,
          'X-Actor-ID': 'promotion-worker',
        },
        body: JSON.stringify({
          candidateId: candidate.candidateId,
          specId: candidate.specId,
          commitSha,
          baseCommitSha,
          actorId: 'promotion-worker',
        }),
      }
    );

    if (!response.ok) {
      const text = (await response.text()).slice(0, 200);
      throw new Error(`Gate answered ${response.status}: ${text}`);
    }

    let body: { success?: unknown; verdictId?: unknown; result?: { status?: unknown; notes?: unknown } };
    try {
      body = await response.json() as typeof body;
    } catch {
      throw new Error(`Gate answered ${response.status} with a non-JSON body`);
    }

    const status = body.result?.status;
    if (body.success !== true || status !== 'pass') {
      if (status === 'fail' || status === 'pending') {
        throw new Error(`Pre-merge gate ${status} (verdict ${String(body.verdictId)}): ${String(body.result?.notes ?? '')}`);
      }
      // Never "empty is pass": a body without a pass verdict fails the car
      throw new Error(`Gate answered ${response.status} without a pass verdict (success: ${String(body.success)}, result.status: ${String(status)})`);
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
        // Only the candidate's latest car: an older failed car was superseded by a re-add
        const candidate = latestCar(train.candidates, candidateId);

        if (!candidate) {
          throw new Error(`Candidate ${candidateId} not found in merge train`);
        }

        if (candidate.status !== 'failed') {
          throw new Error(`Candidate ${candidateId} is not in a failed state (current: ${candidate.status})`);
        }

        return {
          ...train,
          candidates: updateCar(train.candidates, candidate, c => ({
            ...c,
            status: 'waiting' as const,
            failedAt: undefined,
            failureReason: undefined,
          })),
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
      const at = new Date().toISOString();
      await this.modifyMergeTrain(specId, (train) => {
        // The state check is on the candidate's latest car; the rollback is candidate-level, so every merged car
        // of the candidate is rolled back (one train_drop near-miss per car). Its failed or waiting cars stay as they are.
        const candidate = latestCar(train.candidates, candidateId);

        if (!candidate) {
          throw new Error(`Candidate ${candidateId} not found in merge train`);
        }

        if (candidate.status !== 'merged') {
          throw new Error(`Candidate ${candidateId} is not in a merged state (current: ${candidate.status})`);
        }

        return {
          ...train,
          candidates: train.candidates.map(c =>
            c.candidateId === candidateId && c.status === 'merged'
              ? {
                  ...c,
                  status: 'rolled_back' as const,
                  failedAt: at,
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
