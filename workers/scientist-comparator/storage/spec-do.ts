/**
 * Spec DO Storage Client
 *
 * Reads specs and candidates from the Spec DO and posts per-request shadow samples to it. The Spec DO sums the samples
 * (`shadow_scores`, schema m15) and derives the shadow verdict in the same transaction, so this client holds no running
 * average and writes no verdict (docs/plans/promotion-gaps-plan.md sections 3.3, 11 B2-B4 and 12 V8-V10).
 *
 * Error contract (AGENTS.md: a 404 is never "empty"): a read answers null only for a 404; any other non-OK answer or a network
 * error throws SpecDoTransientError, which the queue handler turns into message.retry(). A sample post tells its outcomes apart:
 * recorded, not_found (the Spec DO's coded 404: the candidate is unknown or tombstoned), unsupported (an older Spec DO with no
 * route: a code-less 404) and rejected (a 400: retrying the same body cannot help).
 */

import type {
  ScientistQueueMessage,
  CandidateComparisonResult,
  RequestComparisonResult,
} from '../types';
import { getSpecDoStub, type SpecDoCallerEnv, type SpecDoStub } from '../../shared/spec-do-auth';
import { isValidCanaryCandidateId } from '../../shared/deploy-refs';
import { CANDIDATE_NOT_FOUND, SHADOW_MAX_DIFFS_PER_SAMPLE, SHADOW_SAMPLES_PATH, type ShadowSample } from '../../shared/shadow-verdict';

/** The Spec DO answered 5xx (or the call failed): the message is worth retrying */
export class SpecDoTransientError extends Error {}

export type ShadowPostOutcome = 'recorded' | 'not_found' | 'unsupported' | 'rejected';

/**
 * What the samples are scored against. The shadow router still sends a placeholder baseline (a fake 200), so every sample is
 * 'placeholder' until its follow-up plan captures real production responses; only 'production' samples can ever become enforced
 * evidence (docs/plans/promotion-gaps-plan.md section 12, flip-readiness).
 */
export const SAMPLE_BASELINE: ShadowSample['baseline'] = 'placeholder';

const IDEMPOTENCY_KEY_MAX = 255;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A Spec DO answer body, which is { success, data } on success; a bare body is accepted too */
function unwrap<T>(body: unknown): T {
  if (body && typeof body === 'object' && 'data' in body) return (body as { data: T }).data;
  return body as T;
}

/**
 * Client for interacting with Spec DO
 */
export class SpecDOClient {
  private readonly env: SpecDoCallerEnv;
  // One client serves one queue batch. Candidate -> spec and spec lookups repeat across the batch's messages (a hot candidate is
  // in most of them), and an unmemoized 100-message batch of 3 candidates is about 900 concurrent subrequests, near the limit
  // (review S4). Promises are cached so concurrent callers share one call; a failure is evicted so a retry asks again.
  private readonly memo = new Map<string, Promise<unknown>>();

  constructor(env: SpecDoCallerEnv) {
    this.env = env;
  }

  /**
   * Get the Spec DO stub for the main namespace
   */
  private async getStub(): Promise<SpecDoStub> {
    // The Spec DO is namespaced by the main branch; calls carry this worker's internal token
    return getSpecDoStub(this.env);
  }

  /** A fetch that turns a thrown error into SpecDoTransientError, so callers handle one failure type */
  private async send(path: string, init: RequestInit): Promise<Response> {
    try {
      const stub = await this.getStub();
      return await stub.fetch(path, init);
    } catch (error) {
      throw new SpecDoTransientError(`Spec DO call failed: ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Memoized read: see `memo` */
  private read<T>(path: string): Promise<T | null> {
    let cached = this.memo.get(path) as Promise<T | null> | undefined;
    if (!cached) {
      cached = this.readUncached<T>(path);
      this.memo.set(path, cached);
      cached.catch(() => this.memo.delete(path));
    }
    return cached;
  }

  /** null on 404; throws SpecDoTransientError on any other non-OK answer */
  private async readUncached<T>(path: string): Promise<T | null> {
    const response = await this.send(path, { method: 'GET', headers: { 'Content-Type': 'application/json' } });
    if (response.status === 404) return null;
    if (!response.ok) throw new SpecDoTransientError(`Spec DO answered ${response.status} for GET ${path}`);
    try {
      return unwrap<T>(await response.json());
    } catch {
      throw new SpecDoTransientError(`Spec DO answered ${response.status} with a non-JSON body for GET ${path}`);
    }
  }

  /**
   * Get spec definition by ID (null when the spec does not exist)
   */
  async getSpec(specId: string): Promise<{ id: string; declaredDeltaSurface: string } | null> {
    return this.read(`/api/specs/${encodeURIComponent(specId)}`);
  }

  /**
   * Get candidate by ID (null when it does not exist or is tombstoned)
   */
  async getCandidate(candidateId: string): Promise<{
    id: string;
    specId: string;
    shadowScore?: number;
    shadowMatch?: boolean;
    shadowMetrics?: string;
  } | null> {
    return this.read(`/api/candidates/${encodeURIComponent(candidateId)}`);
  }

  /**
   * Get spec ID for a candidate
   */
  async getCandidateSpecId(candidateId: string): Promise<string | null> {
    const candidate = await this.getCandidate(candidateId);
    return candidate?.specId || null;
  }

  /**
   * Get declared delta surface for a spec
   */
  async getDeclaredDeltaSurface(specId: string): Promise<string | null> {
    const spec = await this.getSpec(specId);
    return spec?.declaredDeltaSurface || null;
  }

  /**
   * Post one candidate's sample for one request. The Idempotency-Key makes a queue redelivery (or a retry after a sibling
   * candidate failed) a replay, never a second count. Throws SpecDoTransientError on 5xx or a network error only.
   */
  async postShadowSample(candidateId: string, result: CandidateComparisonResult): Promise<ShadowPostOutcome> {
    const rawKey = `${result.requestId}:${candidateId}`;
    // A key over the DO's limit would be a 400 and a redelivery would then double-count: hash it (hex SHA-256 is 64 characters)
    const key = rawKey.length <= IDEMPOTENCY_KEY_MAX ? rawKey : `sha256:${await sha256Hex(rawKey)}`;
    const sample: ShadowSample = {
      requestId: result.requestId.slice(0, 200),
      score: Math.min(100, Math.max(0, Number.isFinite(result.score) ? result.score : 0)),
      matched: result.matched,
      diffs: result.diffs.slice(0, SHADOW_MAX_DIFFS_PER_SAMPLE).map((d) => ({ type: d.type, severity: d.severity })),
      baseline: SAMPLE_BASELINE,
    };
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Actor-ID': 'scientist-comparator' };
    headers['Idempotency-Key'] = key;
    const response = await this.send(SHADOW_SAMPLES_PATH(candidateId), {
      method: 'POST',
      headers,
      body: JSON.stringify({ samples: [sample] }),
    });
    if (response.ok) return 'recorded';
    if (response.status === 404) {
      let code: unknown;
      try {
        code = ((await response.json()) as { error?: unknown }).error;
      } catch {
        // a non-JSON 404 is not the coded one
      }
      return code === CANDIDATE_NOT_FOUND ? 'not_found' : 'unsupported';
    }
    if (response.status >= 400 && response.status < 500) return 'rejected';
    throw new SpecDoTransientError(`Spec DO answered ${response.status} for POST ${SHADOW_SAMPLES_PATH(candidateId)}`);
  }

  /**
   * Record comparison results for all candidates in a request: one sample each, for ledger candidates only. The shadow router's
   * static targets (`beehive-main`, local ports) have no ledger row. Returns the outcomes by candidate, so the caller can log
   * `unsupported` once per batch rather than retry it.
   */
  async recordRequestComparison(
    _message: ScientistQueueMessage,
    results: RequestComparisonResult
  ): Promise<Map<string, ShadowPostOutcome>> {
    const outcomes = new Map<string, ShadowPostOutcome>();
    for (const candidateResult of results.candidates) {
      if (!isValidCanaryCandidateId(candidateResult.candidateId)) continue;
      outcomes.set(candidateResult.candidateId, await this.postShadowSample(candidateResult.candidateId, candidateResult));
    }
    return outcomes;
  }
}

// ============================================================================
// Exports
// ============================================================================

export type { ScientistQueueMessage, CandidateComparisonResult, RequestComparisonResult };
