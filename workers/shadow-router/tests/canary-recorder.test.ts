/**
 * Shadow router -> Spec DO canary metrics (M3 SLO loop): aggregation, batching, best-effort failure
 * handling, and the candidate -> deployment map from the deploy refs.
 */
import { describe, expect, it, vi } from 'vitest';
import { CanaryMetricsRecorder, FLUSH_AFTER_MS, FLUSH_AFTER_SAMPLES } from '../canary-recorder';
import { applyCanaryRefs, getDefaultShadowConfig } from '../config';
import { LATENCY_BUCKET_COUNT, type SpecDoFetcher } from '../../shared/deploy-refs';

const NOW = Date.UTC(2026, 9, 24, 12, 0, 30);
const MIN = Math.floor(NOW / 60_000);

function fakeDo(status = 201, body: unknown = { success: true, data: { recorded: 1 } }) {
  const calls: { path: string; body: any }[] = [];
  const fetcher: SpecDoFetcher = {
    fetch: vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(body), { status });
    }),
  };
  return { fetcher, calls };
}

describe('CanaryMetricsRecorder', () => {
  it('aggregates per deployment and minute into one POST of samples', async () => {
    const r = new CanaryMetricsRecorder();
    r.add('dep-1', 200, 5, NOW);
    r.add('dep-1', 502, 300, NOW + 1000);
    r.add('dep-1', 200, 40, NOW + 61_000); // next minute
    r.add('dep-2', 200, 7, NOW);
    const { fetcher, calls } = fakeDo();
    await r.flush(fetcher);

    expect(calls).toHaveLength(2);
    const d1 = calls.find((c) => c.body.deploymentId === 'dep-1')!;
    expect(d1.path).toBe('/canary-metrics');
    expect(d1.body.source).toBe('shadow');
    expect(d1.body.samples).toHaveLength(2);
    const first = d1.body.samples.find((s: any) => s.minuteBucket === MIN);
    expect(first).toMatchObject({ requests: 2, errors: 1, latencySumMs: 305, latencyMaxMs: 300 });
    expect(first.latencyBuckets).toHaveLength(LATENCY_BUCKET_COUNT);
    expect(first.latencyBuckets.reduce((a: number, b: number) => a + b, 0)).toBe(2);
  });

  it('counts only 5xx as errors; ignores impossible latencies', async () => {
    const r = new CanaryMetricsRecorder();
    r.add('d', 404, 5, NOW);
    r.add('d', 500, 5, NOW);
    r.add('d', 200, -1, NOW);
    r.add('d', 200, NaN, NOW);
    const { fetcher, calls } = fakeDo();
    await r.flush(fetcher);
    expect(calls[0].body.samples[0]).toMatchObject({ requests: 2, errors: 1 });
  });

  it('flushes after N samples or T ms, and an empty recorder never flushes', () => {
    const r = new CanaryMetricsRecorder();
    expect(r.shouldFlush(NOW)).toBe(false);
    r.add('d', 200, 5, NOW);
    expect(r.shouldFlush(NOW + FLUSH_AFTER_MS - 1)).toBe(false);
    expect(r.shouldFlush(NOW + FLUSH_AFTER_MS)).toBe(true);
    const r2 = new CanaryMetricsRecorder();
    for (let i = 0; i < FLUSH_AFTER_SAMPLES; i++) r2.add('d', 200, 5, NOW);
    expect(r2.shouldFlush(NOW)).toBe(true);
  });

  it('takes the pending set first: a second flush sends nothing, nothing is double-sent', async () => {
    const r = new CanaryMetricsRecorder();
    r.add('d', 200, 5, NOW);
    const { fetcher, calls } = fakeDo();
    await Promise.all([r.flush(fetcher), r.flush(fetcher)]);
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['an old Spec DO (404)', 404, { success: false, error: 'Not found' }],
    ['a rolled-back deployment (409)', 409, { success: false, error: 'rolled_back' }],
    ['a server error', 500, { success: false, error: 'boom' }],
    ['a malformed 201', 201, { success: true, data: { nope: 1 } }],
  ])('%s is logged and dropped, never thrown', async (_n, status, body) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = new CanaryMetricsRecorder();
    r.add('d', 200, 5, NOW);
    await expect(r.flush(fakeDo(status, body).fetcher)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a throwing Spec DO and a missing binding are both harmless', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = new CanaryMetricsRecorder();
    r.add('d', 200, 5, NOW);
    await expect(r.flush({ fetch: async () => { throw new Error('down'); } })).resolves.toBeUndefined();
    r.add('d', 200, 5, NOW);
    await expect(r.flush(null)).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it('splits more than 60 minute-samples for one deployment into several POSTs', async () => {
    const r = new CanaryMetricsRecorder();
    for (let i = 0; i < 65; i++) r.add('d', 200, 5, NOW + i * 60_000);
    const { fetcher, calls } = fakeDo();
    await r.flush(fetcher);
    expect(calls.map((c) => c.body.samples.length)).toEqual([60, 5]);
  });
});

describe('applyCanaryRefs exposes candidate -> deployment id', () => {
  const live = (candidateId: string) => ({
    ref: { id: `ref-${candidateId}`, specId: 'spec-1', rung: 'canary', candidateId, commitSha: null, workerVersionId: 'v', prevRefId: null, action: 'promote', movedBy: 'canary-worker', movedAt: 1 },
    deployment: {
      id: `dep-${candidateId}`, candidateId, specId: 'spec-1', status: 'deployed', url: `https://${candidateId}.bz23711.workers.dev`, workerVersionId: 'v', commitSha: null,
      trafficPercentage: 10, holdoutPercentage: 5, autoRollback: true, deployRefId: `ref-${candidateId}`, rollbackReason: null,
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    },
  });

  it('maps live canary candidates; static candidates and an outage leave the map empty', async () => {
    const base = getDefaultShadowConfig();
    const up: SpecDoFetcher = { fetch: async () => new Response(JSON.stringify({ success: true, data: [live('cand-a')] }), { status: 200 }) };
    const cfg = await applyCanaryRefs(base, up);
    expect(cfg.canaryDeployments?.get('cand-a')).toBe('dep-cand-a');
    expect([...(base.canaryDeployments ?? [])]).toEqual([]);

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const down: SpecDoFetcher = { fetch: async () => new Response('{}', { status: 500 }) };
    expect((await applyCanaryRefs(base, down)).canaryDeployments?.size ?? 0).toBe(0);
  });
});

describe('scheduleTailFlush (the tail of a burst reaches the Spec DO without another request)', () => {
  it('flushes what is pending after the wait, once, and nothing is double-sent', async () => {
    vi.useFakeTimers();
    try {
      const r = new CanaryMetricsRecorder();
      const { fetcher, calls } = fakeDo();
      for (let i = 0; i < 7; i++) r.add('d', 200, 5, NOW); // fewer than FLUSH_AFTER_SAMPLES
      expect(r.shouldFlush(NOW)).toBe(false);
      const tail = r.scheduleTailFlush(fetcher)!;
      expect(tail).not.toBeNull();
      await vi.advanceTimersByTimeAsync(FLUSH_AFTER_MS - 1);
      expect(calls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      await tail;
      expect(calls).toHaveLength(1);
      expect(calls[0].body.samples.reduce((n: number, s: any) => n + s.requests, 0)).toBe(7);
      await r.flush(fetcher); // nothing left, nothing re-sent
      expect(calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('schedules at most one tail flush at a time, none when empty, and a new one after it completes', async () => {
    vi.useFakeTimers();
    try {
      const r = new CanaryMetricsRecorder();
      const { fetcher, calls } = fakeDo();
      expect(r.scheduleTailFlush(fetcher)).toBeNull(); // nothing pending
      r.add('d', 200, 5, NOW);
      const first = r.scheduleTailFlush(fetcher)!;
      expect(r.scheduleTailFlush(fetcher)).toBeNull(); // already outstanding
      r.add('d', 200, 5, NOW); // arrives while the timer runs: goes out with the same flush
      await vi.advanceTimersByTimeAsync(FLUSH_AFTER_MS);
      await first;
      expect(calls).toHaveLength(1);
      expect(calls[0].body.samples[0].requests).toBe(2);
      r.add('d', 200, 5, NOW);
      expect(r.scheduleTailFlush(fetcher)).not.toBeNull(); // a later burst gets its own
    } finally {
      vi.useRealTimers();
    }
  });

  it('is harmless when the count threshold already flushed the samples, when the Spec DO throws, and with no binding', async () => {
    vi.useFakeTimers();
    try {
      const r = new CanaryMetricsRecorder();
      const { fetcher, calls } = fakeDo();
      r.add('d', 200, 5, NOW);
      const tail = r.scheduleTailFlush(fetcher)!;
      await r.flush(fetcher); // flushed early by the count/age path
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(FLUSH_AFTER_MS);
      await tail;
      expect(calls).toHaveLength(1); // the timer found nothing to send

      const broken: SpecDoFetcher = { fetch: vi.fn(async () => { throw new Error('do down'); }) };
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      r.add('d', 200, 5, NOW);
      const t2 = r.scheduleTailFlush(broken)!;
      await vi.advanceTimersByTimeAsync(FLUSH_AFTER_MS);
      await expect(t2).resolves.toBeUndefined();
      r.add('d', 200, 5, NOW);
      const t3 = r.scheduleTailFlush(null)!;
      await vi.advanceTimersByTimeAsync(FLUSH_AFTER_MS);
      await expect(t3).resolves.toBeUndefined();
      warn.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('samples added while a tail flush is in flight get their own tail flush instead of being stranded', async () => {
    vi.useFakeTimers();
    try {
      const r = new CanaryMetricsRecorder();
      const gate: { release: () => void } = { release: () => {} };
      const posts: any[] = [];
      const slow: SpecDoFetcher = {
        fetch: vi.fn(async (_path: string, init?: RequestInit) => {
          posts.push(JSON.parse(String(init?.body)));
          await new Promise<void>((resolve) => { gate.release = resolve; }); // the Spec DO call hangs until released
          return new Response(JSON.stringify({ success: true, data: { recorded: 1 } }), { status: 201 });
        }),
      };
      r.add('d', 200, 5, NOW);
      const first = r.scheduleTailFlush(slow)!;
      await vi.advanceTimersByTimeAsync(FLUSH_AFTER_MS); // timer fired: the flush has taken the pending set and is waiting on the Spec DO
      expect(posts).toHaveLength(1);
      r.add('d', 200, 5, NOW); // arrives during the in-flight POST
      const second = r.scheduleTailFlush(slow);
      expect(second).not.toBeNull(); // not blocked by the flush that is still running
      gate.release();
      await first;
      await vi.advanceTimersByTimeAsync(FLUSH_AFTER_MS);
      gate.release();
      await second;
      expect(posts).toHaveLength(2);
      expect(posts[1].samples.reduce((n: number, s: any) => n + s.requests, 0)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

