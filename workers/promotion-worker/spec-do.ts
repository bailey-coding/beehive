/**
 * Spec DO access for the Promotion Worker.
 * SPEC_DO is a cross-script Durable Object binding to SpecDO in the "beehive" worker.
 * Calls go through SpecDO's fetch router (not RPC: SpecDO does not extend DurableObject).
 */

import type { Env, PromotionMode, Rung } from './types';
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

/** Candidate stage recorded when a candidate is promoted to a rung ('full' is the end state) */
export const CANDIDATE_STAGE_FOR_RUNG: Record<Rung, string> = {
  'pre-merge': 'passed_premerge',
  shadow: 'passed_shadow',
  train: 'passed_train',
  canary: 'passed_canary',
  full: 'promoted',
};

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
