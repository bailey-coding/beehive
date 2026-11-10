/**
 * Spec DO access for the Promotion Worker.
 * SPEC_DO is a cross-script Durable Object binding to SpecDO in the "beehive" worker.
 * Calls go through SpecDO's fetch router (not RPC: SpecDO does not extend DurableObject).
 */

import type { Env, PromotionMode, Rung } from './types';
import { AdvanceResultSchema, ADVANCE_PATH, type AdvanceResult, type AdvanceRequest, type EvidenceResult } from '../shared/promotion-advance';
import { CANDIDATE_NOT_FOUND } from '../shared/shadow-verdict';
import { getSpecDoStub } from '../shared/spec-do-auth';
import { PromotionLedgerClient } from '../shared/promotion-ledger';

const DEFAULT_SPEC_DO_NAME = 'main';

export interface SpecDOClient {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}

/**
 * Get a client for the single Spec DO instance. Relative paths resolve against
 * the internal origin, since DO stubs require absolute URLs.
 */
export function getSpecDo(env: Env): SpecDOClient {
  // The authed stub resolves relative paths and attaches this worker's internal token
  const stub = getSpecDoStub(env, DEFAULT_SPEC_DO_NAME);
  return {
    fetch: (input, init) => stub.fetch(input, init),
  };
}

/**
 * Typed client for the promotion ledger routes (promotion states, tournaments, merge trains)
 */
export function getPromotionLedger(env: Env): PromotionLedgerClient {
  return new PromotionLedgerClient(getSpecDo(env));
}

/**
 * Persisted promotion mode in Spec DO, or null if never set
 */
export async function getStoredPromotionMode(env: Env): Promise<PromotionMode | null> {
  const response = await getSpecDo(env).fetch('/promotion-mode');
  if (!response.ok) {
    throw new Error(`Failed to read promotion mode: ${response.status}`);
  }
  const body = await response.json() as { mode: PromotionMode | null };
  return body.mode;
}

/**
 * Persist promotion mode in Spec DO
 */
export async function storePromotionMode(env: Env, mode: PromotionMode): Promise<PromotionMode> {
  const response = await getSpecDo(env).fetch('/promotion-mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  if (!response.ok) {
    throw new Error(`Failed to store promotion mode: ${response.status}`);
  }
  const body = await response.json() as { mode: PromotionMode };
  return body.mode;
}

/**
 * Effective promotion mode: the persisted DO value, else the PROMOTION_MODE var
 */
export async function resolvePromotionMode(env: Env): Promise<PromotionMode> {
  const stored = await getStoredPromotionMode(env);
  return stored ?? ((env.PROMOTION_MODE as PromotionMode) || 'tournament');
}

const PROMOTION_ACTOR = 'promotion-worker';

/**
 * Read a candidate row (GET /api/candidates/:id). Throws on any non-2xx, a 404 included.
 */
export async function getCandidate(env: Env, candidateId: string): Promise<Record<string, unknown>> {
  const response = await getSpecDo(env).fetch(`/api/candidates/${encodeURIComponent(candidateId)}`);
  if (!response.ok) {
    throw new Error(`Failed to get candidate ${candidateId}: ${response.status} ${await response.text()}`);
  }
  const body = await response.json() as { data?: Record<string, unknown> };
  return body.data ?? {};
}

/**
 * Record a candidate's stage and a history row (PATCH /api/candidates/:id/stage).
 * Throws on any non-2xx, a 404 included.
 */
export async function setCandidateStage(
  env: Env,
  candidateId: string,
  stage: string,
  notes: string
): Promise<void> {
  const response = await getSpecDo(env).fetch(`/api/candidates/${encodeURIComponent(candidateId)}/stage`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Actor-ID': PROMOTION_ACTOR },
    body: JSON.stringify({ stage, notes }),
  });
  if (!response.ok) {
    throw new Error(`Failed to set candidate ${candidateId} to ${stage}: ${response.status} ${await response.text()}`);
  }
}

// ============================================================================
// advance: the Spec DO's one decision point for moving a candidate up the ladder (docs/plans/promotion-gaps-plan.md section 3.4)
// ============================================================================

/**
 * Why `advance` did not move a candidate. 404 and the 409 codes come from the Spec DO; `ledger_too_old` is a code-less 404 (an older Spec DO with
 * no route, never "unknown candidate": AGENTS.md says a 404 is never "empty"); `ledger_error` is anything else (5xx, a network error, a body
 * that does not parse).
 */
export type AdvanceFailureCode = 'candidate_not_found' | 'ledger_too_old' | 'stale_from_rung' | 'not_next_rung' | 'evidence_missing' | 'ledger_error';

export type AdvanceOutcome =
  | { ok: true; data: AdvanceResult }
  | { ok: false; status: number; code: AdvanceFailureCode; message: string; evidence?: EvidenceResult[] };

const ADVANCE_409_CODES = new Set(['stale_from_rung', 'not_next_rung', 'evidence_missing']);

/**
 * POST /api/candidates/:id/advance. Never throws: every failure is an AdvanceOutcome, so a caller can branch on `code` and cannot mistake a
 * transport problem for a refusal. `dryRun` checks everything and writes nothing.
 */
export async function advanceCandidate(
  env: Env,
  candidateId: string,
  body: Pick<AdvanceRequest, 'toRung' | 'fromRung' | 'dryRun' | 'notes'>,
  actorId: string = PROMOTION_ACTOR
): Promise<AdvanceOutcome> {
  let response: Response;
  try {
    response = await getSpecDo(env).fetch(ADVANCE_PATH(candidateId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Actor-ID': actorId },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return { ok: false, status: 502, code: 'ledger_error', message: `Spec DO call failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  type AdvanceBody = { data?: unknown; error?: unknown; code?: unknown; evidence?: unknown };
  const json = (await response.json().catch(() => null)) as AdvanceBody | null;
  if (response.ok) {
    const parsed = AdvanceResultSchema.safeParse(json?.data);
    if (parsed.success) return { ok: true, data: parsed.data };
    return { ok: false, status: 502, code: 'ledger_error', message: 'Spec DO answered advance with a body that does not parse' };
  }
  const error = typeof json?.error === 'string' ? json.error : `Spec DO answered ${response.status}`;
  if (response.status === 404) {
    return json?.error === CANDIDATE_NOT_FOUND
      ? { ok: false, status: 404, code: 'candidate_not_found', message: `Candidate ${candidateId} not found` }
      : { ok: false, status: 503, code: 'ledger_too_old', message: 'The Spec DO has no advance route yet (it is older than this worker)' };
  }
  if (response.status === 409 && typeof json?.code === 'string' && ADVANCE_409_CODES.has(json.code)) {
    return { ok: false, status: 409, code: json.code as AdvanceFailureCode, message: error, evidence: Array.isArray(json.evidence) ? (json.evidence as EvidenceResult[]) : undefined };
  }
  return { ok: false, status: 502, code: 'ledger_error', message: `Spec DO answered ${response.status} for advance: ${error}` };
}

/**
 * Record a decided head-to-head in the ledger (POST /api/trials, then /decide): the tournament's evidence. The create is keyed, so a retried
 * tournament does not make a second trial; an already-decided trial (409 on decide) is the same decision. Throws on any other non-2xx, a 404 included.
 */
export async function recordDecidedTrial(
  env: Env,
  trial: { specId: string; candidateAId: string; candidateBId: string; winnerId: string; comparisonMetrics: Record<string, unknown>; actorId: string; idempotencyKey: string }
): Promise<string> {
  const headers = { 'Content-Type': 'application/json', 'X-Actor-ID': trial.actorId };
  const created = await getSpecDo(env).fetch('/api/trials', {
    method: 'POST',
    headers: { ...headers, 'Idempotency-Key': trial.idempotencyKey },
    body: JSON.stringify({ specId: trial.specId, candidateAId: trial.candidateAId, candidateBId: trial.candidateBId, decidedBy: trial.actorId }),
  });
  if (!created.ok) throw new Error(`Failed to create trial: ${created.status} ${await created.text()}`);
  const id = ((await created.json()) as { data?: { id?: unknown } }).data?.id;
  if (typeof id !== 'string' || !id) throw new Error('Trial create answered without an id');
  const decided = await getSpecDo(env).fetch(`/api/trials/${encodeURIComponent(id)}/decide`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ winnerId: trial.winnerId, comparisonMetrics: trial.comparisonMetrics, decidedBy: trial.actorId }),
  });
  if (!decided.ok && decided.status !== 409) throw new Error(`Failed to decide trial ${id}: ${decided.status} ${await decided.text()}`);
  return id;
}
