/**
 * SpecDO canary metrics (m10 -> m11): per-deployment, per-minute, per-source request outcomes behind the
 * SLO loop. Real SQL (node:sqlite) through the real router.
 *
 * Task: m3-slo-loop | Spec: docs/M3-CANARY-SLO-PLAN.md
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SpecDO } from '../index';
import { makeSqliteState, makeSpecDo, type SqliteState } from './sqlite-state';
import {
  LATENCY_BUCKET_COUNT,
  latencyBucketIndex,
  latencyP95FromBuckets,
  type CanaryMetricSample,
  type CanaryMetricsSummary,
} from '../../shared/deploy-refs';

let store: SqliteState;
let spec: SpecDO;

const call = (path: string, method = 'GET', body?: unknown) =>
  spec.fetch(
    new Request(`https://spec-do.internal${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Actor-ID': 'shadow-router' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
const data = async <T>(res: Response) => ((await res.json()) as { data: T }).data;
const minute = () => Math.floor(Date.now() / 60_000);

/** A sample from explicit latencies (ms) and an error count. */
function sample(latencies: number[], errors = 0, minuteBucket = minute()): CanaryMetricSample {
  const latencyBuckets = new Array<number>(LATENCY_BUCKET_COUNT).fill(0);
  for (const l of latencies) latencyBuckets[latencyBucketIndex(l)]++;
  return {
    minuteBucket,
    requests: latencies.length,
    errors,
    latencySumMs: latencies.reduce((a, b) => a + b, 0),
    latencyMaxMs: Math.max(0, ...latencies),
    latencyBuckets,
  };
}

async function deployCanary(candidateId = 'cand-a', specId = 'spec-a'): Promise<string> {
  const res = await call('/canary-deployments', 'POST', {
    candidateId, specId, url: `https://${candidateId}.example.workers.dev`, workerVersionId: `ver-${candidateId}`,
    commitSha: 'sha', trafficPercentage: 10, holdoutPercentage: 5,
  });
  expect(res.status).toBe(201);
  return (await data<{ deployment: { id: string } }>(res)).deployment.id;
}

const record = (deploymentId: string, samples: CanaryMetricSample[], source = 'shadow') =>
  call('/canary-metrics', 'POST', { deploymentId, source, samples });
const summary = async (deploymentId: string, source = 'shadow', since = 15) =>
  data<CanaryMetricsSummary>(await call(`/canary-metrics?deploymentId=${deploymentId}&source=${source}&sinceMinutes=${since}`));

beforeEach(async () => {
  store = makeSqliteState();
  spec = makeSpecDo(store);
  await spec.init();
});
afterEach(() => vi.useRealTimers());

describe('histogram helpers', () => {
  it('buckets by upper bound, last bucket open', () => {
    expect(latencyBucketIndex(10)).toBe(0);
    expect(latencyBucketIndex(11)).toBe(1);
    expect(latencyBucketIndex(5000)).toBe(8);
    expect(latencyBucketIndex(5001)).toBe(LATENCY_BUCKET_COUNT - 1);
  });
  it('p95 is the upper bound of the bucket reached; the open bucket reads the max; empty is null', () => {
    const b = new Array<number>(LATENCY_BUCKET_COUNT).fill(0);
    expect(latencyP95FromBuckets(b, 0)).toBeNull();
    b[0] = 94; b[3] = 6; // 100 samples: 94 <= 10ms, 6 in (50,100]
    expect(latencyP95FromBuckets(b, 90)).toBe(100);
    const slow = new Array<number>(LATENCY_BUCKET_COUNT).fill(0);
    slow[LATENCY_BUCKET_COUNT - 1] = 10;
    expect(latencyP95FromBuckets(slow, 7777)).toBe(7777);
  });
});

describe('POST/GET /canary-metrics', () => {
  it('adds samples into the same minute and aggregates requests, errors, p95 and max', async () => {
    const id = await deployCanary();
    expect((await record(id, [sample([5, 8, 20], 1)])).status).toBe(201);
    expect((await record(id, [sample([300, 4000], 1)])).status).toBe(201);
    const s = await summary(id);
    expect(s).toMatchObject({ deploymentId: id, source: 'shadow', requests: 5, errors: 2, latencyMaxMs: 4000 });
    expect(s.errorRate).toBeCloseTo(0.4);
    expect(s.latencyP95Ms).toBe(5000);
    expect(store.raw.prepare('SELECT COUNT(*) AS n FROM canary_metrics').get()).toEqual({ n: 1 });
  });

  it('keeps sources apart: shadow data is not canary data', async () => {
    const id = await deployCanary();
    await record(id, [sample([5, 5, 5])], 'shadow');
    expect((await summary(id, 'canary')).requests).toBe(0);
    expect((await summary(id, 'shadow')).requests).toBe(3);
  });

  it('respects the window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-24T12:00:00Z'));
    const id = await deployCanary();
    await record(id, [sample([5], 0, minute() - 20), sample([5, 5], 0, minute())]);
    expect((await summary(id, 'shadow', 15)).requests).toBe(2);
    expect((await summary(id, 'shadow', 30)).requests).toBe(3);
  });

  it('an unknown deployment or no rows reads as 200 with zero requests and null rates, never 404', async () => {
    const res = await call('/canary-metrics?deploymentId=nope&source=shadow');
    expect(res.status).toBe(200);
    expect(await data<CanaryMetricsSummary>(res)).toMatchObject({ requests: 0, errors: 0, errorRate: null, latencyP95Ms: null });
  });

  it('rejects: unknown deployment (404), rolled-back deployment (409), bad bodies and queries (400)', async () => {
    expect((await record('nope', [sample([5])])).status).toBe(404);

    const id = await deployCanary();
    expect((await record(id, [sample([5])])).status).toBe(201);
    expect((await call(`/canary-deployments/${id}/rollback`, 'POST', { reason: 'manual' })).status).toBe(200);
    expect((await record(id, [sample([5])])).status).toBe(409);

    const live = await deployCanary('cand-b', 'spec-b');
    expect((await record(live, [])).status).toBe(400);
    expect((await record(live, [{ ...sample([5]), errors: 9 }])).status).toBe(400); // errors > requests
    expect((await record(live, [{ ...sample([5]), latencyBuckets: [1] }])).status).toBe(400);
    expect((await record(live, [{ ...sample([5]), requests: 2 }])).status).toBe(400); // buckets do not sum
    expect((await record(live, [sample([5])], 'prod')).status).toBe(400);
    expect((await record(live, [sample([5], 0, minute() - 61)])).status).toBe(400);
    expect((await record(live, [sample([5], 0, minute() + 6)])).status).toBe(400);
    expect((await call('/canary-metrics?source=shadow')).status).toBe(400);
    expect((await call(`/canary-metrics?deploymentId=${live}`)).status).toBe(400);
    expect((await call(`/canary-metrics?deploymentId=${live}&source=shadow&sinceMinutes=0`)).status).toBe(400);
    expect((await call(`/canary-metrics?deploymentId=${live}&source=shadow&sinceMinutes=1441`)).status).toBe(400);
    expect((await call(`/canary-metrics?deploymentId=${live}&source=shadow&sinceMinutes=abc`)).status).toBe(400);
    expect((await call('/canary-metrics', 'DELETE')).status).toBe(404);
  });

  it('a rejected batch writes nothing (one transaction)', async () => {
    const id = await deployCanary();
    expect((await record(id, [sample([5]), sample([5], 0, minute() + 99)])).status).toBe(400);
    expect(store.raw.prepare('SELECT COUNT(*) AS n FROM canary_metrics').get()).toEqual({ n: 0 });
  });

  it('prunes rows older than 24h on write and on read', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-24T12:00:00Z'));
    const id = await deployCanary();
    const old = minute() - 24 * 60 - 1;
    store.raw
      .prepare("INSERT INTO canary_metrics VALUES (?, ?, 'shadow', 1, 0, 1, 1, ?, 0)")
      .run(id, old, JSON.stringify(sample([1]).latencyBuckets));
    await summary(id); // a read prunes
    expect(store.raw.prepare('SELECT COUNT(*) AS n FROM canary_metrics').get()).toEqual({ n: 0 });

    store.raw.prepare("INSERT INTO canary_metrics VALUES (?, ?, 'shadow', 1, 0, 1, 1, ?, 0)").run(id, old, JSON.stringify(sample([1]).latencyBuckets));
    await record(id, [sample([5])]); // a write prunes
    expect(store.raw.prepare('SELECT COUNT(*) AS n FROM canary_metrics').get()).toEqual({ n: 1 });
  });
});

describe('m10 -> m11 migration', () => {
  it('adds canary_metrics to an m10 ledger, keeps rows, and is idempotent', async () => {
    store.raw.exec('DROP TABLE canary_metrics');
    store.raw.exec("UPDATE metadata SET value = 'm10' WHERE key = 'schema_version'");
    spec.createOrganization('existing-org', 'github');
    for (let i = 0; i < 2; i++) {
      spec = makeSpecDo(makeSqliteState(store.raw, store.kv));
      await spec.init();
    }
    expect(store.raw.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get()).toEqual({ value: 'm11' });
    expect(store.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'canary_metrics'").get()).toEqual({ n: 1 });
    expect(store.raw.prepare("SELECT COUNT(*) AS n FROM organizations WHERE name = 'existing-org'").get()).toEqual({ n: 1 });
    const id = await deployCanary();
    expect((await record(id, [sample([5])])).status).toBe(201);
  });
});
