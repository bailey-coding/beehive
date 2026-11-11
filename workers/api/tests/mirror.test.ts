/**
 * The mirror source (docs/plans/shadow-router-followup-plan.md slice M, Review 2 S1/S2): off by default, template-only descriptors,
 * loop guard, rate and concurrency caps, and a wrapper that can never change a response.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mirrorAfterResponse, describeRequest, mirrorPercent, mirrorCounters, resetMirrorState, type MirrorEnv } from '../mirror';
import handler from '../index';

const ok = () => new Response('{}', { status: 202 });
function env(extra: Partial<MirrorEnv> = {}) {
  const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) => ok());
  return { fetchMock, env: { MIRROR_SAMPLE_PERCENT: '100', API_AUTH_TOKEN: 'tok', SHADOW_ROUTER: { fetch: fetchMock }, ...extra } as MirrorEnv };
}
const input = (over: Partial<{ method: string; pathname: string; marked: boolean }> = {}) => ({ method: 'GET', pathname: '/api/specs/abc-123', marked: false, ...over });
beforeEach(() => resetMirrorState());

describe('gate', () => {
  it.each([undefined, '', '0', 'abc', '-1', '101', '1.5', ' ', '1e2'])('MIRROR_SAMPLE_PERCENT=%j is off: no work, no I/O', (v) => {
    const { env: e, fetchMock } = env({ MIRROR_SAMPLE_PERCENT: v });
    expect(mirrorAfterResponse(input(), e)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('parses an integer 0-100', () => {
    expect(mirrorPercent({ MIRROR_SAMPLE_PERCENT: '7' })).toBe(7);
    expect(mirrorPercent({ MIRROR_SAMPLE_PERCENT: '100' })).toBe(100);
  });
  it('is off without the binding or the token', () => {
    expect(mirrorAfterResponse(input(), { ...env().env, SHADOW_ROUTER: undefined })).toBeNull();
    expect(mirrorAfterResponse(input(), { ...env().env, API_AUTH_TOKEN: undefined })).toBeNull();
  });
  it('samples with a random draw against the percent', () => {
    const { env: e } = env({ MIRROR_SAMPLE_PERCENT: '10' });
    expect(mirrorAfterResponse(input(), e, { random: () => 0.5 })).toBeNull();
    expect(mirrorAfterResponse(input(), e, { random: () => 0.05 })).not.toBeNull();
  });
});

describe('what is mirrored', () => {
  it('only GET and HEAD, never health, the router paths or a marked (router-sent) request', () => {
    const { env: e } = env();
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(mirrorAfterResponse(input({ method: m }), e)).toBeNull();
    for (const p of ['/health', '/api/health', '/mirror', '/statsig/config']) expect(mirrorAfterResponse(input({ pathname: p }), e)).toBeNull();
    expect(mirrorAfterResponse(input({ marked: true }), e)).toBeNull();
    expect(mirrorAfterResponse(input({ method: 'head' }), e)).not.toBeNull();
  });
  it('the descriptor is {v, method, path} with a route template: ids, slugs and tokens never appear', async () => {
    const { env: e, fetchMock } = env();
    await mirrorAfterResponse(input({ pathname: '/api/specs/9f2c/candidates/alice@example.com/about' }), e);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://shadow-router.internal/mirror');
    expect(JSON.parse(init!.body as string)).toEqual({ v: 1, method: 'GET', path: '/api/specs/:id/candidates/:id/about' });
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(init!.body as string).not.toContain('alice');
  });
  it('about and roadmap are route words, a user-chosen word is not', () => {
    expect(describeRequest('GET', '/about', {})?.path).toBe('/about');
    expect(describeRequest('GET', '/roadmap', {})?.path).toBe('/roadmap');
    expect(describeRequest('GET', '/secret-token-xyz', {})?.path).toBe('/:id');
  });
});

describe('caps and failures', () => {
  it('a router answer that is not OK (an older router: 404) counts as failed, never as sent', async () => {
    const { env: e, fetchMock } = env();
    fetchMock.mockResolvedValue(new Response('nf', { status: 404 }));
    await mirrorAfterResponse(input(), e);
    expect(mirrorCounters).toMatchObject({ sent: 0, failed: 1 });
  });
  it('a throwing binding is swallowed and counted', async () => {
    const { env: e, fetchMock } = env();
    fetchMock.mockRejectedValue(new Error('down'));
    await expect(mirrorAfterResponse(input(), e)).resolves.toBeUndefined();
    expect(mirrorCounters.failed).toBe(1);
  });
  it('caps in-flight mirrors at 10', async () => {
    const { env: e, fetchMock } = env();
    let release!: () => void;
    fetchMock.mockImplementation(() => new Promise<Response>((r) => { release = () => r(ok()); }));
    const t = () => 1_000_000; // a frozen clock: no refill, but 20 tokens
    const started = Array.from({ length: 12 }, () => mirrorAfterResponse(input(), e, { now: t }));
    expect(started.filter(Boolean)).toHaveLength(10);
    expect(mirrorCounters.droppedInFlight).toBe(2);
    release();
  });
  it('rate-limits with a token bucket (20 burst, 10 per second)', async () => {
    const { env: e } = env();
    let now = 5_000_000;
    let n = 0;
    for (let i = 0; i < 30; i++) {
      const w = mirrorAfterResponse(input(), e, { now: () => now });
      if (w) { n++; await w; }
    }
    expect(n).toBe(20);
    expect(mirrorCounters.droppedRate).toBe(10);
    now += 1_000; // one second refills 10
    let m = 0;
    for (let i = 0; i < 15; i++) { const w = mirrorAfterResponse(input(), e, { now: () => now }); if (w) { m++; await w; } }
    expect(m).toBe(10);
  });
});

describe('the wrapped handler', () => {
  it('never changes the response and schedules the mirror through ctx.waitUntil; off means no waitUntil', async () => {
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    const { env: e, fetchMock } = env();
    const base = { SPEC_DO: {} as DurableObjectNamespace };
    const off = await handler.fetch(new Request('https://x/'), { ...base } as never, ctx);
    expect(off.status).toBe(200);
    expect(waits).toHaveLength(0);
    const on = await handler.fetch(new Request('https://x/about'), { ...base, ...e } as never, ctx);
    expect(on.status).toBe(200);
    expect(waits).toHaveLength(1);
    await waits[0];
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({ v: 1, method: 'GET', path: '/about' });
  });
  it('a request carrying the loop-guard header is answered but never mirrored', async () => {
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    const { env: e, fetchMock } = env();
    const res = await handler.fetch(new Request('https://x/', { headers: { 'x-beehive-mirror': '1' } }), { SPEC_DO: {}, ...e } as never, ctx);
    expect(res.status).toBe(200);
    expect(waits).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('a throwing mirror cannot affect the response', async () => {
    const ctx = { waitUntil: () => { throw new Error('boom'); }, passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    const { env: e } = env();
    const res = await handler.fetch(new Request('https://x/'), { SPEC_DO: {}, ...e } as never, ctx);
    expect(res.status).toBe(200);
  });
});
