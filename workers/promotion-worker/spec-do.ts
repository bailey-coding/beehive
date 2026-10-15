/**
 * Spec DO access for the Promotion Worker.
 * SPEC_DO is a cross-script Durable Object binding to SpecDO in the "beehive" worker.
 */

import type { Env, PromotionMode } from './types';

const DEFAULT_SPEC_DO_NAME = 'main';

// RPC surface of SpecDO (workers/spec-do/index.ts) used by the promotion worker
export interface SpecDORpc {
  getPromotionMode(): Promise<PromotionMode | null>;
  setPromotionMode(mode: PromotionMode): Promise<PromotionMode>;
}

export type SpecDOStub = DurableObjectStub & SpecDORpc;

/**
 * Get the stub for the single Spec DO instance
 */
export function getSpecDo(env: Env): SpecDOStub {
  const id = env.SPEC_DO.idFromName(DEFAULT_SPEC_DO_NAME);
  return env.SPEC_DO.get(id) as SpecDOStub;
}

/**
 * Effective promotion mode: the persisted DO value, else the PROMOTION_MODE var
 */
export async function resolvePromotionMode(env: Env): Promise<PromotionMode> {
  const stored = await getSpecDo(env).getPromotionMode();
  return stored ?? ((env.PROMOTION_MODE as PromotionMode) || 'tournament');
}
