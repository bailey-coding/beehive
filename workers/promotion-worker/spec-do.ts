/**
 * Spec DO access for the Promotion Worker.
 * SPEC_DO is a cross-script Durable Object binding to SpecDO in the "beehive" worker.
 * Calls go through SpecDO's fetch router (not RPC: SpecDO does not extend DurableObject).
 */

import type { Env, PromotionMode } from './types';
import { PromotionLedgerClient } from '../shared/promotion-ledger';

const DEFAULT_SPEC_DO_NAME = 'main';
const SPEC_DO_ORIGIN = 'https://spec-do.internal';

export interface SpecDOClient {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}

/**
 * Get a client for the single Spec DO instance. Relative paths resolve against
 * the internal origin, since DO stubs require absolute URLs.
 */
export function getSpecDo(env: Env): SpecDOClient {
  const id = env.SPEC_DO.idFromName(DEFAULT_SPEC_DO_NAME);
  const stub = env.SPEC_DO.get(id);
  return {
    fetch: (input, init) =>
      stub.fetch(typeof input === 'string' ? new Request(new URL(input, SPEC_DO_ORIGIN), init) : input),
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
