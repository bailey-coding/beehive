/**
 * Live canary pointer cache (workers/shadow-router/live-refs-cache.ts), driven by a fake clock.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DEFAULT_LIVE_REFS_TTL_MS,
  MAX_LIVE_REFS_TTL_MS,
  LiveRefsCache,
  getLiveRefsCache,
  resetLiveRefsCache,
  resolveLiveRefsTtlMs,
} from '../live-refs-cache';
import { applyCanaryRefs, getDefaultShadowConfig } from '../config';

const TTL = 5000;

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe('LiveRefsCache', () => {
  it('cache hit: reads once within the TTL', async () => {
    const c = clock();
    const cache = new LiveRefsCache<string>(TTL, c.now);
    const load = vi.fn().mockResolvedValue('v1');
    expect(await cache.get(load)).toBe('v1');
    c.advance(TTL - 1);
    expect(await cache.get(load)).toBe('v1');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('expiry: reads again once the TTL has passed', async () => {
    const c = clock();
    const cache = new LiveRefsCache<string>(TTL, c.now);
    const load = vi.fn().mockResolvedValueOnce('v1').mockResolvedValueOnce('v2');
    expect(await cache.get(load)).toBe('v1');
    c.advance(TTL);
    expect(await cache.get(load)).toBe('v2');
    expect(load).toHaveBeenCalledTimes(2);
    c.advance(TTL - 1);
    expect(await cache.get(load)).toBe('v2');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('an empty list is a value (a rollback), not a miss', async () => {
    const c = clock();
    const cache = new LiveRefsCache<string[]>(TTL, c.now);
    const load = vi.fn().mockResolvedValue([]);
    expect(await cache.get(load)).toEqual([]);
    expect(await cache.get(load)).toEqual([]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('stale-on-error: last value for one extra TTL, then null (static config)', async () => {
    const c = clock();
    const cache = new LiveRefsCache<string>(TTL, c.now);
    expect(await cache.get(async () => 'good')).toBe('good'); // stamped t0
    const down = vi.fn().mockResolvedValue(null);

    c.advance(TTL); // expired, DO down
    expect(await cache.get(down)).toBe('good');
    c.advance(TTL - 1); // age 2 x TTL - 1: still inside the extra TTL
    expect(await cache.get(down)).toBe('good');
    c.advance(1); // age 2 x TTL: bound reached
    expect(await cache.get(down)).toBeNull();
    c.advance(10 * TTL);
    expect(await cache.get(down)).toBeNull();
    // every one of those requests retried the DO: nothing negative was cached
    expect(down).toHaveBeenCalledTimes(4);
  });

  it('a throwing loader counts as a failed read', async () => {
    const c = clock();
    const cache = new LiveRefsCache<string>(TTL, c.now);
    await cache.get(async () => 'good');
    c.advance(TTL);
    expect(await cache.get(async () => { throw new Error('boom'); })).toBe('good');
  });

  it('never caches an error: no value -> null, and the next request retries and recovers', async () => {
    const c = clock();
    const cache = new LiveRefsCache<string>(TTL, c.now);
    const load = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('v1');
    expect(await cache.get(load)).toBeNull();
    expect(await cache.get(load)).toBe('v1'); // same instant: the failure was not remembered
    expect(await cache.get(load)).toBe('v1');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a recovered read replaces the stale value and restarts the TTL', async () => {
    const c = clock();
    const cache = new LiveRefsCache<string>(TTL, c.now);
    await cache.get(async () => 'old');
    c.advance(TTL);
    expect(await cache.get(async () => null)).toBe('old');
    expect(await cache.get(async () => 'new')).toBe('new');
    c.advance(TTL - 1);
    const load = vi.fn().mockResolvedValue('newer');
    expect(await cache.get(load)).toBe('new');
    expect(load).not.toHaveBeenCalled();
  });

  it('in-flight dedupe: concurrent requests share one read', async () => {
    const c = clock();
    const cache = new LiveRefsCache<string>(TTL, c.now);
    let release!: (v: string) => void;
    const load = vi.fn(() => new Promise<string>((resolve) => (release = resolve)));
    const all = [cache.get(load), cache.get(load), cache.get(load), cache.get(load)];
    expect(load).toHaveBeenCalledTimes(1);
    release('shared');
    expect(await Promise.all(all)).toEqual(['shared', 'shared', 'shared', 'shared']);
    expect(load).toHaveBeenCalledTimes(1);
    // the slot is free again: after expiry a new read starts
    c.advance(TTL);
    const next = vi.fn().mockResolvedValue('next');
    expect(await cache.get(next)).toBe('next');
  });

  it('in-flight dedupe also shares a failure, and releases the slot', async () => {
    const c = clock();
    const cache = new LiveRefsCache<string>(TTL, c.now);
    let fail!: () => void;
    const load = vi.fn(() => new Promise<string | null>((resolve) => (fail = () => resolve(null))));
    const all = [cache.get(load), cache.get(load)];
    fail();
    expect(await Promise.all(all)).toEqual([null, null]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(await cache.get(async () => 'again')).toBe('again');
  });

  it('TTL=0 disables the cache: every call reads, no stale value, no dedupe', async () => {
    const c = clock();
    const cache = new LiveRefsCache<string>(0, c.now);
    const load = vi.fn().mockResolvedValueOnce('a').mockResolvedValueOnce('b').mockResolvedValueOnce(null);
    expect(await cache.get(load)).toBe('a');
    expect(await cache.get(load)).toBe('b');
    expect(await cache.get(load)).toBeNull(); // no stale-on-error either
    expect(load).toHaveBeenCalledTimes(3);
  });
});

describe('resolveLiveRefsTtlMs / getLiveRefsCache', () => {
  beforeEach(() => resetLiveRefsCache());

  it('defaults to 5s; 0 disables; junk falls back to the default; clamped', () => {
    expect(DEFAULT_LIVE_REFS_TTL_MS).toBe(5000);
    expect(resolveLiveRefsTtlMs(undefined)).toBe(5000);
    expect(resolveLiveRefsTtlMs('')).toBe(5000);
    expect(resolveLiveRefsTtlMs('0')).toBe(0);
    expect(resolveLiveRefsTtlMs(0)).toBe(0);
    expect(resolveLiveRefsTtlMs('250')).toBe(250);
    expect(resolveLiveRefsTtlMs(' 1500 ')).toBe(1500);
    expect(resolveLiveRefsTtlMs('abc')).toBe(5000);
    expect(resolveLiveRefsTtlMs('-1')).toBe(5000);
    expect(resolveLiveRefsTtlMs('NaN')).toBe(5000);
    expect(resolveLiveRefsTtlMs('9999999')).toBe(MAX_LIVE_REFS_TTL_MS);
  });

  it('one cache per isolate, rebuilt only when the TTL changes', () => {
    const a = getLiveRefsCache({});
    expect(a.ttlMs).toBe(5000);
    expect(getLiveRefsCache({})).toBe(a);
    expect(getLiveRefsCache(undefined)).toBe(a);
    const b = getLiveRefsCache({ LIVE_REFS_CACHE_TTL_MS: '0' });
    expect(b).not.toBe(a);
    expect(b.ttlMs).toBe(0);
  });
});

describe('applyCanaryRefs with the cache (rollback visibility)', () => {
  const live = (candidateId: string, url: string) => ({
    ref: { id: `ref-${candidateId}`, specId: 'spec-1', rung: 'canary', candidateId, commitSha: null, workerVersionId: `v-${candidateId}`, prevRefId: null, action: 'promote', movedBy: 'canary-worker', movedAt: 1 },
    deployment: {
      id: `d-${candidateId}`, candidateId, specId: 'spec-1', status: 'deployed', url, workerVersionId: `v-${candidateId}`, commitSha: null,
      trafficPercentage: 10, holdoutPercentage: 5, autoRollback: true, deployRefId: `ref-${candidateId}`, rollbackReason: null,
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    },
  });

  // A DO whose answer can be changed between calls (promotion, rollback, outage)
  function fakeDo() {
    const state: { data: unknown[]; down: boolean } = { data: [live('cand-a', 'https://a.example')], down: false };
    const fetch = vi.fn(async () =>
      state.down
        ? new Response(JSON.stringify({ success: false, error: 'down' }), { status: 500 })
        : new Response(JSON.stringify({ success: true, data: state.data }), { status: 200 })
    );
    return { state, fetch };
  }

  it('serves the pointer from cache, shows a rollback within the TTL, and bounds staleness on outage', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = clock();
    const cache = new LiveRefsCache(TTL, c.now);
    const specDo = fakeDo();
    const base = getDefaultShadowConfig();
    const targets = async () => (await applyCanaryRefs(base, specDo, cache)).candidatePreviews.get('cand-a');

    expect(await targets()).toBe('https://a.example');
    expect(await targets()).toBe('https://a.example');
    expect(specDo.fetch).toHaveBeenCalledTimes(1);

    // Rollback happens in the DO: cached pointer may live for at most one TTL
    specDo.state.data = [];
    c.advance(TTL - 1);
    expect(await targets()).toBe('https://a.example'); // still inside the TTL
    c.advance(1);
    expect(await targets()).toBeUndefined(); // visible at the TTL
    expect(specDo.fetch).toHaveBeenCalledTimes(2);

    // Promote again, then an outage: old pointer survives one extra TTL, then static config
    specDo.state.data = [live('cand-a', 'https://a2.example')];
    c.advance(TTL);
    expect(await targets()).toBe('https://a2.example');
    specDo.state.down = true;
    c.advance(TTL);
    expect(await targets()).toBe('https://a2.example'); // stale, within 2 x TTL
    c.advance(TTL);
    expect(await targets()).toBeUndefined(); // static config: no canary target
  });

  it('without a cache every call reads the DO (the previous behaviour)', async () => {
    const specDo = fakeDo();
    const base = getDefaultShadowConfig();
    await applyCanaryRefs(base, specDo);
    await applyCanaryRefs(base, specDo);
    expect(specDo.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not mutate the cached refs or the base config', async () => {
    const c = clock();
    const cache = new LiveRefsCache(TTL, c.now);
    const specDo = fakeDo();
    const base = getDefaultShadowConfig();
    const sizeBefore = base.candidatePreviews.size;
    const first = await applyCanaryRefs(base, specDo, cache);
    const second = await applyCanaryRefs(base, specDo, cache);
    expect(base.candidatePreviews.size).toBe(sizeBefore);
    expect(second.candidatePreviews.get('cand-a')).toBe('https://a.example');
    expect(second).not.toBe(first);
  });
});
