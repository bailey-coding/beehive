/**
 * Safety rules of the mirror path after the 2026-10-25 review: bodies reach every target, writes are not replayed against the
 * production baseline, a live canary ref cannot replace a static target or point outside workers.dev, a hung candidate becomes a
 * recorded 5xx, and the Scientist queue message carries no credentials.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import handler from '../index';
import { applyCanaryRefs, getDefaultShadowConfig, isAcceptableCanaryUrl } from '../config';
import { scientistSafeHeaders } from '../candidate-headers';

const BASELINE_URL = 'https://beehive.bz23711.workers.dev';

const liveRef = (candidateId: string, url: string) => ({
  ref: { id: `ref-${candidateId}`, specId: 'spec-1', rung: 'canary', candidateId, commitSha: null, workerVersionId: 'v', prevRefId: null, action: 'promote', movedBy: 'canary-worker', movedAt: 1 },
  deployment: {
    id: `dep-${candidateId}`, candidateId, specId: 'spec-1', status: 'deployed', url, workerVersionId: 'v', commitSha: null,
    trafficPercentage: 100, holdoutPercentage: 0, autoRollback: true, deployRefId: `ref-${candidateId}`, rollbackReason: null,
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  },
});

const fetcherOf = (refs: unknown[]) => ({
  fetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: refs }), { status: 200 })),
});

describe('applyCanaryRefs: what a live ref may do', () => {
  const base = () => ({ ...getDefaultShadowConfig(), candidatePreviews: new Map([['beehive-main', BASELINE_URL]]) });

  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('accepts a candidate on https workers.dev', async () => {
    const cfg = await applyCanaryRefs(base(), fetcherOf([liveRef('cand-a', 'https://aa11-beehive-candidate-x.bz23711.workers.dev')]));
    expect(cfg.candidatePreviews.get('cand-a')).toBe('https://aa11-beehive-candidate-x.bz23711.workers.dev');
    expect(cfg.canaryDeployments.get('cand-a')).toBe('dep-cand-a');
  });

  it('never lets a live ref replace the static baseline target, and keeps no deployment mapping for it', async () => {
    const cfg = await applyCanaryRefs(base(), fetcherOf([liveRef('beehive-main', 'https://evil.workers.dev')]));
    expect(cfg.candidatePreviews.get('beehive-main')).toBe(BASELINE_URL);
    expect(cfg.canaryDeployments.has('beehive-main')).toBe(false);
  });

  it.each([
    ['another host', 'https://evil.example/'],
    ['plain http', 'http://x.bz23711.workers.dev'],
    ['credentials in the url', 'https://user:pw@x.bz23711.workers.dev'],
    ['a lookalike suffix', 'https://x.workers.dev.evil.example'],
    ['not a url', 'not a url'],
  ])('ignores a live ref whose url is %s', async (_n, url) => {
    const cfg = await applyCanaryRefs(base(), fetcherOf([liveRef('cand-a', url)]));
    expect(cfg.candidatePreviews.has('cand-a')).toBe(false);
    expect(cfg.canaryDeployments.has('cand-a')).toBe(false);
  });

  it('isAcceptableCanaryUrl is strict about the host suffix', () => {
    expect(isAcceptableCanaryUrl('https://a.b.workers.dev/x')).toBe(true);
    expect(isAcceptableCanaryUrl('https://workers.dev')).toBe(false);
    expect(isAcceptableCanaryUrl('ftp://a.workers.dev')).toBe(false);
  });

  it('with the account subdomain configured, only that account\'s Workers pass', () => {
    expect(isAcceptableCanaryUrl('https://a.bz23711.workers.dev', 'bz23711')).toBe(true);
    for (const url of ['https://a.evil.workers.dev', 'https://bz23711.workers.dev', 'https://a.bz237110.workers.dev', 'https://a.bz23711.workers.dev.evil.example']) {
      expect(isAcceptableCanaryUrl(url, 'bz23711'), url).toBe(false);
    }
    expect(isAcceptableCanaryUrl('https://a.evil.workers.dev')).toBe(true); // unset: any workers.dev, as before
  });

  it('a live ref on another account is not mirrored to when the subdomain is configured', async () => {
    const ref = liveRef('cand-x', 'https://aa11-beehive-candidate-x.evil.workers.dev');
    expect((await applyCanaryRefs(base(), fetcherOf([ref]), undefined, 'bz23711')).candidatePreviews.has('cand-x')).toBe(false);
    expect((await applyCanaryRefs(base(), fetcherOf([ref]))).candidatePreviews.has('cand-x')).toBe(true);
  });
});

describe('scientistSafeHeaders', () => {
  it('drops credentials and internal headers, keeps the rest', () => {
    const out = scientistSafeHeaders(new Headers({ Authorization: 'Bearer t', Cookie: 'a=b', 'X-Actor-ID': 'x', 'X-Api-Key': 'k', Accept: 'text/html', 'Content-Type': 'text/plain' }));
    expect(out).toEqual({ accept: 'text/html', 'content-type': 'text/plain' });
  });
});

describe('mirror fan-out through the handler', () => {
  const live = liveRef('cand-a', 'https://cand-a.bz23711.workers.dev');
  const calls: Array<{ url: string; method: string; body: string | null; redirect: string; aborted: () => boolean }> = [];
  let hang = false;
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

  // Same hash as classifyRequest: pick URLs inside the 1% top-level canary split
  function inCanary(method: string, url: string): boolean {
    const id = `${method}:${url}`;
    let hash = 0;
    for (let i = 0; i < id.length; i++) { hash = (hash << 5) - hash + id.charCodeAt(i); hash = hash & hash; }
    return (Math.abs(hash) % 10000) / 10000 < 0.01;
  }
  const urlFor = (method: string) => {
    for (let i = 0; i < 200_000; i++) if (inCanary(method, `http://localhost/m/${i}`)) return `http://localhost/m/${i}`;
    throw new Error('no url in the canary range');
  };
  const env = () => ({
    API_AUTH_TOKEN: 'tok',
    LIVE_REFS_CACHE_TTL_MS: '0',
    SPEC_DO: { idFromName: () => 'id', get: () => ({ fetch: vi.fn(async (input: Request | string) => {
      const u = new URL(typeof input === 'string' ? input : input.url);
      return u.pathname === '/deploy-refs/live' ? new Response(JSON.stringify({ success: true, data: [live] }), { status: 200 }) : new Response('{}', { status: 404 });
    }) }) },
  });

  beforeEach(() => {
    calls.length = 0;
    pending.length = 0;
    hang = false;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async (input: Request | string, init?: RequestInit) => {
      const req = typeof input === 'string' ? new Request(input, init) : input;
      const body = req.body ? await req.clone().text() : null;
      const signal = req.signal;
      calls.push({ url: req.url, method: req.method, body, redirect: req.redirect, aborted: () => signal.aborted });
      if (hang && req.url.startsWith('https://cand-a')) {
        // like a real fetch: never answers, but rejects when the router aborts it
        return new Promise<Response>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      }
      return new Response('ok', { status: 200 });
    }));
  });
  // Only setTimeout is faked; reading a request body and the like is real async work that fake-timer advances do not wait for.
  // A timer the handler creates late (the 10 s candidate abort) is therefore missed by a fixed number of advances, and a test
  // that waits for it hangs. Alternate fake-time advances with a real macrotask turn until the condition holds (bounded).
  async function settleUntil(done: () => boolean): Promise<void> {
    for (let i = 0; i < 2_000 && !done(); i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  afterEach(async () => {
    let settled = false;
    void Promise.allSettled(pending).then(() => { settled = true; });
    await settleUntil(() => settled);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const send = (method: string, body?: string) =>
    handler.fetch(new Request(urlFor(method), { method, body, headers: { Authorization: 'Bearer tok', 'Content-Type': 'text/plain' } }), env(), ctx);

  it('a POST body reaches the candidate, and the production baseline is not replayed', async () => {
    const res = await send('POST', 'payload-123');
    expect(res.status).toBe(200);
    const toCandidate = calls.filter((c) => c.url.startsWith('https://cand-a.bz23711.workers.dev'));
    expect(toCandidate).toHaveLength(1);
    expect(toCandidate[0].method).toBe('POST');
    expect(toCandidate[0].body).toBe('payload-123');
    expect(toCandidate[0].redirect).toBe('manual');
    expect(calls.filter((c) => c.url.startsWith(BASELINE_URL))).toHaveLength(0);
  });

  it('a GET still goes to the baseline as well as the candidate', async () => {
    await send('GET');
    expect(calls.some((c) => c.url.startsWith(BASELINE_URL))).toBe(true);
    expect(calls.some((c) => c.url.startsWith('https://cand-a.bz23711.workers.dev'))).toBe(true);
  });

  it('a candidate that never answers is aborted after the timeout and still answers the caller', async () => {
    hang = true;
    const pendingResponse = send('GET');
    // Advance until the router answers: the abort timer is created only once the handler reaches the candidate fetch, and how
    // long that takes differs between machines and under load (see settleUntil).
    let answered = false;
    void pendingResponse.then(() => { answered = true; });
    await settleUntil(() => answered);
    expect(answered).toBe(true);
    const res = await pendingResponse;
    expect(res.status).toBe(200);
    const hung = calls.find((c) => c.url.startsWith('https://cand-a'));
    expect(hung).toBeDefined();
    expect(hung!.aborted()).toBe(true); // the router gave up on it instead of waiting for the platform limit
  });
});
