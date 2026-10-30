/**
 * Shadow router fetch() -> fan-out -> canary metrics -> Spec DO, through the real handler. Guards the
 * wiring (a deleted recordCanaryMetrics call must fail a test) and the best-effort rule (the router's
 * answer never depends on the Spec DO accepting metrics).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import handler from '../index';
import { FLUSH_AFTER_MS, FLUSH_AFTER_SAMPLES } from '../canary-recorder';

// Same hash as classifyRequest: the top-level split is 1% canary by default, so pick URLs that land in it
function inTopLevelCanary(url: string, method = 'GET'): boolean {
  const id = `${method}:${url}`;
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash << 5) - hash + id.charCodeAt(i);
    hash = hash & hash;
  }
  return (Math.abs(hash) % 10000) / 10000 < 0.01;
}

function mirroredUrls(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < n && i < 100_000; i++) {
    const url = `http://localhost/work/${i}`;
    if (inTopLevelCanary(url)) out.push(url);
  }
  expect(out).toHaveLength(n);
  return out;
}

const live = {
  ref: { id: 'ref-a', specId: 'spec-1', rung: 'canary', candidateId: 'cand-a', commitSha: null, workerVersionId: 'v', prevRefId: null, action: 'promote', movedBy: 'canary-worker', movedAt: 1 },
  deployment: {
    id: 'dep-a', candidateId: 'cand-a', specId: 'spec-1', status: 'deployed', url: 'https://cand-a.bz23711.workers.dev', workerVersionId: 'v', commitSha: null,
    trafficPercentage: 100, holdoutPercentage: 0, autoRollback: true, deployRefId: 'ref-a', rollbackReason: null,
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  },
};

function makeEnv(metricsStatus: number) {
  const posts: any[] = [];
  const stub = {
    fetch: vi.fn(async (input: Request | string) => {
      const req = typeof input === 'string' ? new Request(input) : input;
      const url = new URL(req.url);
      if (url.pathname === '/deploy-refs/live') return new Response(JSON.stringify({ success: true, data: [live] }), { status: 200 });
      if (url.pathname === '/canary-metrics' && req.method === 'POST') {
        posts.push(await req.json());
        return new Response(JSON.stringify(metricsStatus < 400 ? { success: true, data: { recorded: 1 } } : { success: false, error: 'x' }), { status: metricsStatus });
      }
      return new Response('{}', { status: 404 });
    }),
  };
  const env = {
    API_AUTH_TOKEN: 'tok',
    LIVE_REFS_CACHE_TTL_MS: '0',
    SPEC_DO: { idFromName: () => 'id', get: () => stub },
  };
  return { env, posts };
}

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

beforeEach(() => {
  // The recorder's tail flush waits FLUSH_AFTER_MS inside ctx.waitUntil; fake only the timers so it can be advanced
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  pending.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // The mirrored candidate call: one 200, one 503, so errors are counted
  let n = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Request | string) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!url.startsWith('https://cand-a.bz23711.workers.dev')) return new Response('ok', { status: 200 }); // static candidates
      return new Response('ok', { status: n++ % 10 === 0 ? 503 : 200 });
    })
  );
});
afterEach(async () => {
  await vi.advanceTimersByTimeAsync(FLUSH_AFTER_MS); // let any outstanding tail flush finish so the shared recorder is idle again
  await Promise.allSettled(pending);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mirror(env: unknown, count: number, settle = true): Promise<Response[]> {
  const responses: Response[] = [];
  for (const url of mirroredUrls(count)) {
    responses.push(await handler.fetch(new Request(url, { headers: { Authorization: 'Bearer tok' } }), env, ctx));
  }
  if (settle) {
    await vi.advanceTimersByTimeAsync(FLUSH_AFTER_MS); // outstanding tail flushes run (a no-op once the count threshold flushed)
    await Promise.allSettled(pending);
  }
  return responses;
}

describe('shadow router -> canary metrics wiring', () => {
  it('mirrored results for a live canary reach the Spec DO as shadow samples', async () => {
    const { env, posts } = makeEnv(201);
    const responses = await mirror(env, FLUSH_AFTER_SAMPLES);
    expect(responses.every((r) => r.status === 200)).toBe(true);

    expect(posts.length).toBeGreaterThanOrEqual(1);
    const total = posts.flatMap((p) => p.samples).reduce((a: number, s: any) => a + s.requests, 0);
    const errors = posts.flatMap((p) => p.samples).reduce((a: number, s: any) => a + s.errors, 0);
    expect(posts.every((p) => p.deploymentId === 'dep-a' && p.source === 'shadow')).toBe(true);
    expect(total).toBe(FLUSH_AFTER_SAMPLES);
    expect(errors).toBe(2); // every 10th mirrored call answered 503
  });

  it('a Spec DO that rejects the metrics (404 old DO, 409 rolled back) never changes the router answer', async () => {
    for (const status of [404, 409, 500]) {
      const { env, posts } = makeEnv(status);
      const responses = await mirror(env, FLUSH_AFTER_SAMPLES);
      expect(responses.every((r) => r.status === 200)).toBe(true);
      expect(posts.length).toBeGreaterThanOrEqual(1); // it tried, was refused, carried on
    }
  });

  it('the tail of a short burst (fewer than FLUSH_AFTER_SAMPLES) is posted after FLUSH_AFTER_MS without another request', async () => {
    const { env, posts } = makeEnv(201);
    const responses = await mirror(env, FLUSH_AFTER_SAMPLES - 5, false);
    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(posts).toHaveLength(0); // not enough samples and not old enough: nothing sent yet
    await vi.advanceTimersByTimeAsync(FLUSH_AFTER_MS - 1);
    expect(posts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.allSettled(pending);
    const total = posts.flatMap((p) => p.samples).reduce((a: number, s: any) => a + s.requests, 0);
    expect(total).toBe(FLUSH_AFTER_SAMPLES - 5);
  });
});
