/**
 * Canary SLO loop against a real Spec DO (D2, docs/plans/d2-canary-ping-pong-plan.md): two violating canaries must
 * not ping-pong. slo-loop.test.ts uses a fake DO whose refs never move, so it cannot see the flip.
 * Real SQL (node:sqlite) through the real router; the canary worker's own clients talk to it.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { SLOMonitor } from '../slo';
import { RollbackManager } from '../rollback';
import type { Env } from '../types';
import { makeSqliteState, makeSpecDo } from '../../spec-do/tests/sqlite-state';
import { LATENCY_BUCKET_COUNT, latencyBucketIndex, type CanaryMetricSample } from '../../shared/deploy-refs';
import type { SpecDO } from '../../spec-do/index';

let spec: SpecDO;
let env: Env;

const call = (path: string, method = 'GET', body?: unknown) =>
  spec.fetch(new Request(`https://spec-do.internal${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Actor-ID': 'test' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
const data = async <T>(res: Response) => ((await res.json()) as { data: T }).data;

/** 100 requests, 5 errors: over the 1% error-rate SLO and above the 50-request minimum */
function violatingSample(): CanaryMetricSample {
  const latencyBuckets = new Array<number>(LATENCY_BUCKET_COUNT).fill(0);
  latencyBuckets[latencyBucketIndex(100)] = 100;
  return { minuteBucket: Math.floor(Date.now() / 60_000), requests: 100, errors: 5, latencySumMs: 10_000, latencyMaxMs: 100, latencyBuckets };
}

/** Deploy a canary and post violating samples for it (before the next deploy supersedes it: a superseded one answers 409) */
async function deployViolating(candidateId: string): Promise<string> {
  const res = await call('/canary-deployments', 'POST', {
    candidateId, specId: 'spec-a', url: `https://${candidateId}.example.workers.dev`, workerVersionId: `ver-${candidateId}`,
    commitSha: 'sha', trafficPercentage: 10, holdoutPercentage: 5,
  });
  expect(res.status).toBe(201);
  const id = (await data<{ deployment: { id: string } }>(res)).deployment.id;
  expect((await call('/canary-metrics', 'POST', { deploymentId: id, source: 'shadow', samples: [violatingSample()] })).status).toBe(201);
  return id;
}

const head = async () => data<{ candidateId: string | null }>(await call('/deploy-refs/head?specId=spec-a&rung=canary'));
const cycle = () => new SLOMonitor(env).runCycle(new RollbackManager(env));

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  spec = makeSpecDo(makeSqliteState());
  const stub = { fetch: (input: Request | string, init?: RequestInit) => spec.fetch(new Request(input, init)) };
  env = {
    SPEC_DO: { idFromName: () => 'id', get: () => stub },
    PREVIEW_MANAGER: {},
    ANALYTICS: { writeDataPoint: vi.fn() },
    API_AUTH_TOKEN: 't',
    SPEC_DO_INTERNAL_TOKEN: 'test-do-internal-token',
    CANARY_SLO_LATENCY_P95: '1000',
    CANARY_SLO_ERROR_RATE: '0.01',
  } as unknown as Env;
});
afterEach(() => vi.restoreAllMocks());

describe('two violating canaries settle instead of ping-ponging', () => {
  it('A then B both violate: cycle 1 rolls back B, cycle 2 rolls back A, cycle 3 finds nothing live', async () => {
    const a = await deployViolating('cand-a');
    const b = await deployViolating('cand-b');
    const c1 = await cycle();
    expect(c1.rolledBack).toEqual([b]);
    expect((await head()).candidateId).toBe('cand-a');
    const c2 = await cycle();
    expect(c2.rolledBack).toEqual([a]);
    expect((await head()).candidateId).toBeNull();
    const c3 = await cycle();
    expect(c3).toMatchObject({ checked: 0, rolledBack: [], errors: [] });
    expect((await head()).candidateId).toBeNull();
  });
});
