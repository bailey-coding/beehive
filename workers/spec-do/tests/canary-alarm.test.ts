/**
 * SpecDO canary SLO tick alarm: armed by a canary deploy (or the first request after a restart), sends one
 * queue message per tick while a canary is live, stops when none is. Real SQL through the real router.
 *
 * Task: m3-event-driven | Spec: docs/M3-CANARY-SLO-PLAN.md
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SpecDO, CANARY_TICK_INTERVAL_MS } from '../index';
import { makeSqliteState, type SqliteState } from './sqlite-state';
import { authedDo, TEST_DO_TOKENS } from './do-tokens';

let store: SqliteState;
let spec: SpecDO;
let sent: unknown[];
let sendFails: boolean;

function build(s: SqliteState, withQueue = true): SpecDO {
  const producer = { send: vi.fn(async (m: unknown) => { if (sendFails) throw new Error('queue down'); sent.push(m); }) };
  return authedDo(new SpecDO(s.state as never, { ...TEST_DO_TOKENS, ...(withQueue ? { CANARY_SLO_TICKS: producer } : {}) } as never));
}

const call = (path: string, method = 'GET', body?: unknown) =>
  spec.fetch(
    new Request(`https://spec-do.internal${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Actor-ID': 'canary-worker' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
const deployCanary = (candidateId = 'cand-a', specId = 'spec-a') =>
  call('/canary-deployments', 'POST', {
    candidateId, specId, url: `https://${candidateId}.example.workers.dev`, workerVersionId: `ver-${candidateId}`,
    commitSha: 'sha', trafficPercentage: 10, holdoutPercentage: 5,
  });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1_000_000);
  sent = [];
  sendFails = false;
  store = makeSqliteState();
  spec = build(store);
  await spec.init();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('arming', () => {
  it('a canary deploy arms the alarm for +60s', async () => {
    expect(store.alarm.at).toBeNull();
    expect((await deployCanary()).status).toBe(201);
    expect(store.alarm.at).toBe(1_000_000 + CANARY_TICK_INTERVAL_MS);
  });

  it('does not move an alarm that is already pending', async () => {
    await deployCanary();
    vi.setSystemTime(1_030_000);
    await deployCanary('cand-b', 'spec-b');
    expect(store.alarm.at).toBe(1_000_000 + CANARY_TICK_INTERVAL_MS);
  });

  it('a failed deploy request arms nothing', async () => {
    expect((await call('/canary-deployments', 'POST', { nope: true })).status).toBe(400);
    expect(store.alarm.at).toBeNull();
  });

  it('the first request after a restart arms when a canary is already live', async () => {
    await deployCanary();
    store.alarm.at = null; // alarm lost / pre-alarm deploy
    spec = build(store); // fresh instance over the same storage: db not yet initialised
    expect((await call('/health')).status).toBe(200);
    expect(store.alarm.at).toBe(1_000_000 + CANARY_TICK_INTERVAL_MS);
  });

  it('the first request arms nothing when no canary is live', async () => {
    spec = build(store);
    await call('/health');
    expect(store.alarm.at).toBeNull();
  });

  it('a storage error while arming never fails the request', async () => {
    (store.state as any).storage.getAlarm = async () => { throw new Error('boom'); };
    expect((await deployCanary()).status).toBe(201);
  });
});

describe('alarm()', () => {
  it('sends one tick and re-arms while a canary is live', async () => {
    await deployCanary();
    vi.setSystemTime(1_060_000);
    store.alarm.at = null; // the runtime clears the alarm when it fires
    await spec.alarm();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'canary-slo-tick' });
    expect(store.alarm.at).toBe(1_060_000 + CANARY_TICK_INTERVAL_MS);
  });

  it('keeps ticking on every firing', async () => {
    await deployCanary();
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(1_000_000 + (i + 1) * CANARY_TICK_INTERVAL_MS);
      store.alarm.at = null;
      await spec.alarm();
    }
    expect(sent).toHaveLength(3);
  });

  it('with no live canary sends nothing and does not re-arm', async () => {
    await spec.alarm();
    expect(sent).toHaveLength(0);
    expect(store.alarm.at).toBeNull();
  });

  it('stops after the last canary is rolled back', async () => {
    const res = await deployCanary();
    const id = ((await res.json()) as { data: { deployment: { id: string } } }).data.deployment.id;
    expect((await call(`/canary-deployments/${id}/rollback`, 'POST', { reason: 'manual' })).status).toBe(200);
    store.alarm.at = null;
    await spec.alarm();
    expect(sent).toHaveLength(0);
    expect(store.alarm.at).toBeNull();
  });

  it('a failing queue send still re-arms and never throws', async () => {
    await deployCanary();
    store.alarm.at = null;
    sendFails = true;
    await expect(spec.alarm()).resolves.toBeUndefined();
    expect(store.alarm.at).toBe(1_000_000 + CANARY_TICK_INTERVAL_MS);
  });

  it('works with the producer binding absent (older config): re-arms, sends nothing', async () => {
    spec = build(store, false);
    await spec.init();
    await deployCanary();
    store.alarm.at = null;
    await expect(spec.alarm()).resolves.toBeUndefined();
    expect(store.alarm.at).toBe(1_000_000 + CANARY_TICK_INTERVAL_MS);
  });

  it('initialises itself on a cold instance and never throws on a storage failure', async () => {
    await deployCanary();
    store.alarm.at = null;
    spec = build(store); // cold: db unset
    await spec.alarm();
    expect(sent).toHaveLength(1);
    (store.state as any).storage.setAlarm = async () => { throw new Error('boom'); };
    await expect(spec.alarm()).resolves.toBeUndefined();
  });
});
