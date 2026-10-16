/**
 * Promotion mode persistence.
 *
 * Mode is stored in SpecDO storage, not in the promotion worker isolate. Two
 * SpecDO instances over one storage map model an isolate restart: the value
 * written by one must be read by the other.
 */

import { describe, it, expect } from 'vitest';
import { SpecDO } from '../../spec-do/index';
import { TEST_DO_TOKENS, TEST_INTERNAL_ONLY } from '../../spec-do/tests/do-tokens';
import handler from '../index';
import { resolvePromotionMode } from '../spec-do';
import type { Env } from '../types';

const AUTH = { Authorization: 'Bearer test-auth-token' };

// Shared DO storage: survives across SpecDO instances like real DO storage does
function makeStorage() {
  const kv = new Map<string, unknown>();
  return {
    storage: {
      get: async (k: string) => kv.get(k),
      put: async (k: string, v: unknown) => void kv.set(k, v),
    },
  };
}

// A SpecDO instance over the given storage (a fresh one models a restarted isolate)
function openSpecDo(storage: ReturnType<typeof makeStorage>): SpecDO {
  return new SpecDO(storage as never, { ...TEST_DO_TOKENS } as never);
}

function makeEnv(spec: SpecDO, promotionMode = 'tournament'): Env {
  return {
    SPEC_DO: {
      idFromName: () => 'main',
      get: () => ({ fetch: (request: Request) => spec.fetch(request) }),
    } as unknown as DurableObjectNamespace,
    PROMOTION_MODE: promotionMode,
    API_AUTH_TOKEN: 'test-auth-token',
    ...TEST_INTERNAL_ONLY,
  } as unknown as Env;
}

const ctx = {} as ExecutionContext;

describe('SpecDO promotion mode storage', () => {
  it('returns null before a mode has been set', async () => {
    const spec = openSpecDo(makeStorage());
    expect(await spec.getPromotionMode()).toBeNull();
  });

  it('persists the mode across SpecDO instances', async () => {
    const storage = makeStorage();
    await openSpecDo(storage).setPromotionMode('merge-train');

    expect(await openSpecDo(storage).getPromotionMode()).toBe('merge-train');
  });

  it('rejects an invalid mode without changing the stored value', async () => {
    const storage = makeStorage();
    const spec = openSpecDo(storage);
    await spec.setPromotionMode('tournament');

    await expect(spec.setPromotionMode('bogus' as never)).rejects.toThrow('Invalid promotion mode');
    expect(await openSpecDo(storage).getPromotionMode()).toBe('tournament');
  });
});

describe('resolvePromotionMode', () => {
  it('falls back to PROMOTION_MODE until a mode is persisted', async () => {
    const storage = makeStorage();
    const env = makeEnv(openSpecDo(storage), 'merge-train');
    expect(await resolvePromotionMode(env)).toBe('merge-train');

    await openSpecDo(storage).setPromotionMode('tournament');
    expect(await resolvePromotionMode(env)).toBe('tournament');
  });
});

describe('/mode endpoints', () => {
  it('POST /mode then GET /mode reads back the mode from the DO', async () => {
    const storage = makeStorage();
    const postRes = await handler.fetch(
      new Request('https://promotion.test/mode', {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'merge-train' }),
      }),
      makeEnv(openSpecDo(storage)),
      ctx,
    );
    expect(postRes.status).toBe(200);
    expect((await postRes.json() as { mode: string }).mode).toBe('merge-train');

    // New SpecDO over the same storage, env default still 'tournament'
    const getRes = await handler.fetch(
      new Request('https://promotion.test/mode', { headers: AUTH }),
      makeEnv(openSpecDo(storage), 'tournament'),
      ctx,
    );
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toMatchObject({ success: true, mode: 'merge-train' });
  });

  it('POST /mode rejects an invalid mode with 400 and keeps the stored value', async () => {
    const storage = makeStorage();
    const env = makeEnv(openSpecDo(storage));
    await openSpecDo(storage).setPromotionMode('tournament');

    const res = await handler.fetch(
      new Request('https://promotion.test/mode', {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'bogus' }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
    expect(await openSpecDo(storage).getPromotionMode()).toBe('tournament');
  });
});
