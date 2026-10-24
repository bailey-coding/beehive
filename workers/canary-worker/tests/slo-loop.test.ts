/**
 * Canary SLO loop (docs/M3-CANARY-SLO-PLAN.md): per-deployment verdicts from the Spec DO's canary metrics,
 * rollback only on a real violation, and the cron handler. A fake Spec DO answers the deploy-ref routes.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import handler from '../index';
import { SLOMonitor, sloConfig } from '../slo';
import { RollbackManager } from '../rollback';
import type { Env } from '../types';

interface FakeDeployment {
  id: string;
  candidateId: string;
  specId: string;
  status?: string;
  autoRollback?: boolean;
  metrics?: { requests: number; errors: number; p95: number | null; max?: number } | 'old-do' | 'error';
  rollback?: number; // status the rollback route answers (default 200)
}

function deployment(d: FakeDeployment) {
  return {
    id: d.id, candidateId: d.candidateId, specId: d.specId, status: d.status ?? 'deployed', url: 'https://x.example', workerVersionId: 'v',
    commitSha: null, trafficPercentage: 10, holdoutPercentage: 5, autoRollback: d.autoRollback ?? true, deployRefId: `ref-${d.id}`,
    rollbackReason: null, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  };
}

function makeEnv(deps: FakeDeployment[], opts: { liveDown?: boolean } = {}, vars: Partial<Env> = {}) {
  const rollbacks: { id: string; reason: string }[] = [];
  const seen: string[] = [];
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 400 ? { success: true, data } : { success: false, error: String(data) }), { status });
  const stub = {
    fetch: vi.fn(async (input: Request | string) => {
      const req = typeof input === 'string' ? new Request(input) : input;
      const url = new URL(req.url);
      seen.push(`${req.method} ${url.pathname}`);
      if (url.pathname === '/deploy-refs/live') {
        if (opts.liveDown) return json('boom', 500);
        return json(deps.map((d) => ({
          ref: { id: `ref-${d.id}`, specId: d.specId, rung: 'canary', candidateId: d.candidateId, commitSha: null, workerVersionId: 'v', prevRefId: null, action: 'promote', movedBy: 'canary-worker', movedAt: 1 },
          deployment: deployment(d),
        })));
      }
      if (url.pathname === '/canary-metrics') {
        const d = deps.find((x) => x.id === url.searchParams.get('deploymentId'))!;
        if (d.metrics === 'old-do') return json('Not found', 404);
        if (d.metrics === 'error') return json('boom', 500);
        const m = d.metrics ?? { requests: 0, errors: 0, p95: null };
        return json({
          deploymentId: d.id, source: url.searchParams.get('source'), sinceMinutes: Number(url.searchParams.get('sinceMinutes')),
          requests: m.requests, errors: m.errors, errorRate: m.requests ? m.errors / m.requests : null, latencyP95Ms: m.p95, latencyMaxMs: m.max ?? m.p95 ?? 0,
        });
      }
      if (url.pathname === '/canary-deployments' && req.method === 'GET') {
        return json(deps.filter((d) => d.candidateId === url.searchParams.get('candidateId')).map(deployment));
      }
      const rb = url.pathname.match(/^\/canary-deployments\/([^/]+)\/rollback$/);
      if (rb && req.method === 'POST') {
        const d = deps.find((x) => x.id === decodeURIComponent(rb[1]))!;
        const body = (await req.json()) as { reason: string };
        if ((d.rollback ?? 200) !== 200) return json('already', d.rollback);
        rollbacks.push({ id: d.id, reason: body.reason });
        return json({ deployment: { ...deployment(d), status: 'rolled_back' }, ref: { id: 'r2', specId: d.specId, rung: 'canary', candidateId: null, commitSha: null, workerVersionId: null, prevRefId: `ref-${d.id}`, action: 'rollback', movedBy: 'canary-worker', movedAt: 2 } });
      }
      return json('Not found', 404);
    }),
  };
  const env = {
    SPEC_DO: { idFromName: () => 'id', get: () => stub },
    PREVIEW_MANAGER: {},
    ANALYTICS: { writeDataPoint: vi.fn() },
    API_AUTH_TOKEN: 't',
    SPEC_DO_INTERNAL_TOKEN: 'i',
    CANARY_SLO_LATENCY_P95: '1000',
    CANARY_SLO_ERROR_RATE: '0.01',
    ...vars,
  } as unknown as Env;
  return { env, rollbacks, seen };
}

const cycle = (env: Env) => new SLOMonitor(env).runCycle(new RollbackManager(env));

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('verdicts', () => {
  it('healthy: enough samples, within both SLOs -> no rollback', async () => {
    const { env, rollbacks } = makeEnv([{ id: 'd1', candidateId: 'c1', specId: 's1', metrics: { requests: 100, errors: 0, p95: 250 } }]);
    const status = await new SLOMonitor(env).checkSLOs();
    expect(status).toMatchObject({ healthy: true, source: 'shadow', windowMinutes: 15, minRequests: 50 });
    expect(status.deployments[0]).toMatchObject({ verdict: 'healthy', candidateId: 'c1', specId: 's1', source: 'shadow' });
    expect((await cycle(env)).rolledBack).toEqual([]);
    expect(rollbacks).toEqual([]);
  });

  it('latency violation rolls back that deployment with the real candidate and spec', async () => {
    const { env, rollbacks } = makeEnv([{ id: 'd1', candidateId: 'c1', specId: 's1', metrics: { requests: 100, errors: 0, p95: 2500 } }]);
    const status = await new SLOMonitor(env).checkSLOs();
    expect(status.violations[0]).toMatchObject({ candidateId: 'c1', specId: 's1', reason: 'latency' });
    expect((await cycle(env)).rolledBack).toEqual(['d1']);
    expect(rollbacks).toEqual([{ id: 'd1', reason: 'latency' }]);
  });

  it('error-rate violation rolls back', async () => {
    const { env, rollbacks } = makeEnv([{ id: 'd1', candidateId: 'c1', specId: 's1', metrics: { requests: 100, errors: 5, p95: 100 } }]);
    await cycle(env);
    expect(rollbacks).toEqual([{ id: 'd1', reason: 'error_rate' }]);
  });

  it('thresholds are strict greater-than: exactly at the limit is healthy', async () => {
    const { env } = makeEnv([{ id: 'd1', candidateId: 'c1', specId: 's1', metrics: { requests: 100, errors: 1, p95: 1000 } }]);
    expect((await new SLOMonitor(env).checkSLOs()).deployments[0].verdict).toBe('healthy');
  });

  it('below the minimum sample size is no verdict: never a rollback, even with terrible numbers', async () => {
    const { env, rollbacks } = makeEnv([{ id: 'd1', candidateId: 'c1', specId: 's1', metrics: { requests: 49, errors: 49, p95: 9999 } }]);
    const status = await new SLOMonitor(env).checkSLOs();
    expect(status.deployments[0].verdict).toBe('insufficient_data');
    await cycle(env);
    expect(rollbacks).toEqual([]);
  });

  it.each([['an old Spec DO (404)', 'old-do'], ['a Spec DO error', 'error']] as const)('%s -> unavailable, not healthy, not a rollback', async (_n, metrics) => {
    const { env, rollbacks } = makeEnv([{ id: 'd1', candidateId: 'c1', specId: 's1', metrics }]);
    const status = await new SLOMonitor(env).checkSLOs();
    expect(status.deployments[0].verdict).toBe('unavailable');
    const result = await cycle(env);
    expect(result.errors[0]).toContain('metrics unavailable');
    expect(rollbacks).toEqual([]);
  });

  it('a superseded or rolled-back deployment is not evaluated', async () => {
    const { env } = makeEnv([{ id: 'd1', candidateId: 'c1', specId: 's1', status: 'superseded', metrics: { requests: 100, errors: 100, p95: 9999 } }]);
    expect((await new SLOMonitor(env).checkSLOs()).deployments).toEqual([]);
  });
});

describe('cycle', () => {
  it('respects the per-canary auto-rollback switch', async () => {
    const { env, rollbacks } = makeEnv([{ id: 'd1', candidateId: 'c1', specId: 's1', autoRollback: false, metrics: { requests: 100, errors: 50, p95: 100 } }]);
    expect(await cycle(env)).toMatchObject({ rolledBack: [], skipped: ['d1'] });
    expect(rollbacks).toEqual([]);
  });

  it.each([404, 409])('a rollback answering %i means it already happened: benign', async (status) => {
    const { env } = makeEnv([{ id: 'd1', candidateId: 'c1', specId: 's1', rollback: status, metrics: { requests: 100, errors: 50, p95: 100 } }]);
    expect(await cycle(env)).toMatchObject({ rolledBack: [], alreadyHandled: ['d1'], errors: [] });
  });

  it('one deployment failing does not stop the others', async () => {
    const { env, rollbacks } = makeEnv([
      { id: 'bad', candidateId: 'c1', specId: 's1', rollback: 500, metrics: { requests: 100, errors: 50, p95: 100 } },
      { id: 'meta-down', candidateId: 'c2', specId: 's2', metrics: 'error' },
      { id: 'slow', candidateId: 'c3', specId: 's3', metrics: { requests: 100, errors: 0, p95: 5000 } },
    ]);
    const result = await cycle(env);
    expect(result.rolledBack).toEqual(['slow']);
    expect(result.errors).toHaveLength(2);
    expect(rollbacks.map((r) => r.id)).toEqual(['slow']);
  });

  it('a second cycle after a successful rollback does nothing (the canary is no longer live)', async () => {
    const deps: FakeDeployment[] = [{ id: 'd1', candidateId: 'c1', specId: 's1', metrics: { requests: 100, errors: 50, p95: 100 } }];
    const { env, rollbacks } = makeEnv(deps);
    await cycle(env);
    deps.length = 0; // the ref moved: no live canary
    expect((await cycle(env)).checked).toBe(0);
    expect(rollbacks).toHaveLength(1);
  });

  it('live canaries unreadable -> no verdict, no rollback (throws)', async () => {
    const { env, rollbacks } = makeEnv([{ id: 'd1', candidateId: 'c1', specId: 's1', metrics: { requests: 100, errors: 50, p95: 100 } }], { liveDown: true });
    await expect(cycle(env)).rejects.toThrow(/Live canaries unavailable/);
    expect(rollbacks).toEqual([]);
  });

  it('bad config -> no verdict and no Spec DO traffic at all', async () => {
    const { env, rollbacks, seen } = makeEnv([{ id: 'd1', candidateId: 'c1', specId: 's1', metrics: { requests: 100, errors: 50, p95: 100 } }], {}, { CANARY_SLO_ERROR_RATE: 'low' });
    await expect(cycle(env)).rejects.toThrow(/Invalid CANARY_SLO_ERROR_RATE/);
    expect(rollbacks).toEqual([]);
    expect(seen).toEqual([]);
  });
});

describe('config', () => {
  it('defaults and validation', () => {
    expect(sloConfig(makeEnv([]).env)).toEqual({ latencyP95: 1000, errorRate: 0.01, minRequests: 50, windowMinutes: 15, source: 'shadow' });
    expect(sloConfig(makeEnv([], {}, { CANARY_SLO_SOURCE: 'canary', CANARY_SLO_MIN_REQUESTS: '200', CANARY_SLO_WINDOW_MINUTES: '5' }).env)).toMatchObject({ source: 'canary', minRequests: 200, windowMinutes: 5 });
    for (const bad of [{ CANARY_SLO_SOURCE: 'prod' }, { CANARY_SLO_MIN_REQUESTS: '0' }, { CANARY_SLO_MIN_REQUESTS: '2.5' }, { CANARY_SLO_WINDOW_MINUTES: '1441' }, { CANARY_SLO_WINDOW_MINUTES: 'x' }]) {
      expect(() => sloConfig(makeEnv([], {}, bad).env)).toThrow(/Invalid CANARY_SLO_/);
    }
  });

  it('passes the configured source and window to the Spec DO', async () => {
    const { env } = makeEnv([{ id: 'd1', candidateId: 'c1', specId: 's1', metrics: { requests: 100, errors: 0, p95: 10 } }], {}, { CANARY_SLO_SOURCE: 'canary', CANARY_SLO_WINDOW_MINUTES: '5' });
    const status = await new SLOMonitor(env).checkSLOs();
    expect(status).toMatchObject({ source: 'canary', windowMinutes: 5 });
    const calls = (env.SPEC_DO as any).get().fetch.mock.calls.map((c: [Request]) => c[0].url);
    expect(calls.find((u: string) => u.includes('/canary-metrics'))).toContain('source=canary&sinceMinutes=5');
  });
});

describe('scheduled handler', () => {
  it('runs a cycle and rolls back a violator', async () => {
    const { env, rollbacks } = makeEnv([{ id: 'd1', candidateId: 'c1', specId: 's1', metrics: { requests: 100, errors: 50, p95: 100 } }]);
    await handler.scheduled({} as any, env, {} as any);
    expect(rollbacks).toEqual([{ id: 'd1', reason: 'error_rate' }]);
  });

  it('never throws on no verdict: logs and waits for the next tick', async () => {
    const { env, rollbacks } = makeEnv([{ id: 'd1', candidateId: 'c1', specId: 's1', metrics: { requests: 100, errors: 50, p95: 100 } }], { liveDown: true });
    await expect(handler.scheduled({} as any, env, {} as any)).resolves.toBeUndefined();
    expect(rollbacks).toEqual([]);
    expect(console.error).toHaveBeenCalled();
  });
});
