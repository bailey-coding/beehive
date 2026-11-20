/**
 * A third Spec DO token for the promotion writes, LOG-ONLY in phase 1 (wave-2a-plan part F; review a-S8): `advance` and the canary deploy
 * writes. The DO never refuses for it in this wave; when its secret is set and a call lacks the header (or carries a wrong one) it logs
 * `promotion_token_missing` (Workers Logs, plus a flood-controlled governance row, none for a dry-run advance). Rollback paths and the stage
 * PATCH (which only writes failed/rolled_back since part A) are not promotion routes: rollback is never gated (AGENTS.md rule 7).
 *
 * Task: wave-2a part F | Spec: docs/plans/wave-2a-plan.md part F
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SpecDO } from '../index';
import { makeSqliteState, type SqliteState } from './sqlite-state';
import { TEST_DO_TOKENS } from './do-tokens';
import { seedLedgerCandidate } from './ledger-seed';
import * as auth from '../../shared/spec-do-auth';

const PROMO = 'test-promotion-token';
const a = auth as unknown as {
  isPromotionRoute?: (method: string, path: string) => boolean;
  PROMOTION_TOKEN_HEADER?: string;
  authedSpecDoStub: typeof auth.authedSpecDoStub;
};

describe('isPromotionRoute: exactly the promotion writes', () => {
  const cases: Array<[string, string, boolean]> = [
    ['POST', '/api/candidates/c-1/advance', true],
    ['POST', '/canary-deployments', true],
    ['PATCH', '/canary-deployments/d-1', true],
    ['GET', '/api/candidates/c-1/advance', false],
    ['GET', '/canary-deployments', false],
    ['GET', '/canary-deployments/d-1', false],
    ['POST', '/canary-deployments/d-1/rollback', false],
    ['POST', '/deploy-refs/rollback', false],
    ['PATCH', '/api/candidates/c-1/stage', false],
    ['POST', '/canary-metrics', false],
    ['POST', '/api/candidates/c-1/advance/x', false],
    ['POST', '/api/candidates/advance', false],
  ];
  it.fails.each(cases)('%s %s -> %s', (method, path, expected) => {
    expect(a.isPromotionRoute!(method, path)).toBe(expected);
  });
});

describe('the client adds the header on promotion routes only, and only when its env holds the secret', () => {
  const sent: Request[] = [];
  const raw = { fetch: async (r: Request) => (sent.push(r), new Response('{}')) } as never;
  beforeEach(() => void (sent.length = 0));

  it.fails('with the secret: on advance and canary writes, not on reads or rollbacks', async () => {
    const stub = a.authedSpecDoStub(raw, { SPEC_DO_INTERNAL_TOKEN: 'i', SPEC_DO_PROMOTION_TOKEN: PROMO } as never);
    await stub.fetch('/api/candidates/c/advance', { method: 'POST', body: '{}' });
    await stub.fetch('/canary-deployments', { method: 'POST', body: '{}' });
    await stub.fetch('/canary-deployments/d', { method: 'PATCH', body: '{}' });
    await stub.fetch('/canary-deployments/d/rollback', { method: 'POST', body: '{}' });
    await stub.fetch('/api/candidates/c');
    expect(sent.map((r) => r.headers.get('X-Beehive-Promotion'))).toEqual([PROMO, PROMO, PROMO, null, null]);
  });

  it('without the secret: never', async () => {
    const stub = a.authedSpecDoStub(raw, { SPEC_DO_INTERNAL_TOKEN: 'i' } as never);
    await stub.fetch('/api/candidates/c/advance', { method: 'POST', body: '{}' });
    expect(sent[0].headers.get('X-Beehive-Promotion')).toBeNull();
  });
});

describe('the Spec DO: log-only', () => {
  let store: SqliteState;
  let spec: SpecDO;
  let warn: ReturnType<typeof vi.spyOn>;

  const build = (promotionSecret?: string) => {
    store = makeSqliteState();
    spec = new SpecDO(store.state as never, { ...TEST_DO_TOKENS, ...(promotionSecret ? { SPEC_DO_PROMOTION_TOKEN: promotionSecret } : {}) } as never);
  };
  /** A call carrying the tier-1 token, and the promotion header only when given */
  const call = (path: string, method: string, body: unknown, promotionHeader?: string) =>
    spec.fetch(new Request(`https://spec-do.internal${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Actor-ID': 'promotion-worker',
        'X-Beehive-Internal': TEST_DO_TOKENS.SPEC_DO_INTERNAL_TOKEN,
        ...(promotionHeader !== undefined ? { 'X-Beehive-Promotion': promotionHeader } : {}),
      },
      body: JSON.stringify(body),
    }));
  const events = () => store.raw.prepare(`SELECT * FROM governance_events WHERE event = 'promotion_token_missing'`).all() as Record<string, any>[];
  const seed = async () => {
    await spec.init();
    seedLedgerCandidate(store.raw, 'cand', 'spec-a');
  };
  const canary = (header?: string) =>
    call('/canary-deployments', 'POST', { candidateId: 'cand', specId: 'spec-a', url: 'https://c.x.workers.dev', workerVersionId: 'v', trafficPercentage: 5, holdoutPercentage: 0 }, header);

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it.fails('secret set, no header: advance and the canary deploy PROCEED, each logs one row and a Workers Logs line', async () => {
    build(PROMO);
    await seed();
    const adv = await call('/api/candidates/cand/advance', 'POST', { toRung: 'shadow' });
    expect(adv.status).toBe(409); // the advance's own answer (no pre-merge verdict), not an auth refusal
    expect(((await adv.json()) as { code?: string }).code).toBe('evidence_missing');
    expect((await canary()).status).toBe(201);
    const rows = events();
    expect(rows.map((r) => JSON.parse(r.detail).route)).toEqual(['POST /api/candidates/:id/advance', 'POST /canary-deployments']);
    expect(rows[0]).toMatchObject({ asserted_actor_id: 'promotion-worker' });
    expect(warn.mock.calls.some((c) => String(c[0]).includes('promotion_token_missing'))).toBe(true);
  });

  it.fails('secret set, wrong header: proceeds and logs', async () => {
    build(PROMO);
    await seed();
    expect((await canary('nope')).status).toBe(201);
    expect(events()).toHaveLength(1);
  });

  it('secret set, right header: no row', async () => {
    build(PROMO);
    await seed();
    expect((await canary(PROMO)).status).toBe(201);
    expect((await call('/api/candidates/cand/advance', 'POST', { toRung: 'shadow' }, PROMO)).status).toBe(409);
    expect(events()).toEqual([]);
  });

  it('secret set, no header, a dry-run advance: no row (the dry-run contract writes nothing)', async () => {
    build(PROMO);
    await seed();
    await call('/api/candidates/cand/advance', 'POST', { toRung: 'shadow', dryRun: true });
    expect(events()).toEqual([]);
  });

  it('secret unset: nothing is logged, nothing refused', async () => {
    build();
    await seed();
    expect((await canary()).status).toBe(201);
    expect(events()).toEqual([]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('promotion_token_missing'))).toBe(false);
  });
});

describe('only the three holders call the promotion routes', () => {
  // beehive-promotion-worker (advance), beehive-canary-worker (canary writes), beehive (the edge's master advance; the DO itself)
  const HOLDERS = ['workers/promotion-worker/', 'workers/canary-worker/', 'workers/api/', 'workers/spec-do/', 'workers/shared/'];
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      if (f === 'node_modules' || f === 'tests') return [];
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
    });
  it('no other worker source names /advance or /canary-deployments', () => {
    const offenders = files('workers')
      .filter((f) => !HOLDERS.some((h) => f.startsWith(h)))
      .filter((f) => /\/advance['`]|\/canary-deployments/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
