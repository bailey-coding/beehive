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
  const calls: Array<{ url: string; method: string; body: string | null; redirect: string; xRequestId: string | null; headers: Headers; aborted: () => boolean }> = [];
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
  // The split hashes the full URL, so a query string must be part of the search for a URL inside the canary range
  const urlFor = (method: string, search = '') => {
    for (let i = 0; i < 400_000; i++) if (inCanary(method, `http://localhost/m/${i}${search}`)) return `http://localhost/m/${i}${search}`;
    throw new Error('no url in the canary range');
  };
  const env = (extra: Record<string, string> = {}) => ({
    ...extra,
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
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { if (process.env.DBG) process.stdout.write(m + ' ' + a.join(' ') + '\n'); });
    vi.stubGlobal('fetch', vi.fn(async (input: Request | string, init?: RequestInit) => {
      const req = typeof input === 'string' ? new Request(input, init) : input;
      const body = req.body ? await req.clone().text() : null;
      const signal = req.signal;
      calls.push({ url: req.url, method: req.method, body, redirect: req.redirect, xRequestId: req.headers.get('x-request-id'), headers: req.headers, aborted: () => signal.aborted });
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

  async function settleAll(): Promise<void> {
    let done = false;
    void Promise.allSettled(pending).then(() => { done = true; });
    await settleUntil(() => done);
  }

  afterEach(async () => {
    let settled = false;
    void Promise.allSettled(pending).then(() => { settled = true; });
    await settleUntil(() => settled);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const send = (method: string, body?: string, extraEnv: Record<string, string> = {}, headers: Record<string, string> = {}, search = '') =>
    handler.fetch(new Request(urlFor(method, search), { method, body, headers: { Authorization: 'Bearer tok', 'Content-Type': 'text/plain', ...headers } }), env(extraEnv), ctx);

  const FULL = { MIRROR_BODY_MODE: 'full', GOVERNANCE_EGRESS_CONTROLLED: 'true' };
  const candidateCalls = () => calls.filter((c) => c.url.startsWith('https://cand-a.bz23711.workers.dev'));

  it('by default (mode none) a candidate gets no body, no query string and no path ids, only the method and a route template', async () => {
    const res = await send('POST', '{"email":"a@b.c"}', { MIRROR_ROUTE_WORDS: 'm' }, { 'Content-Type': 'application/json' }, '?token=secret&email=a@b.c');
    expect(res.status).toBe(200);
    const [call] = candidateCalls();
    expect(call.method).toBe('POST');
    expect(call.body).toBeNull();
    expect(call.url).not.toContain('token=');
    expect(call.url).not.toContain('secret');
    expect(call.url).not.toContain('?');
    expect(new URL(call.url).pathname).toBe('/m/:id'); // urlFor() is /m/<number>
  });

  it('MIRROR_BODY_MODE=full without GOVERNANCE_EGRESS_CONTROLLED falls back to none', async () => {
    await send('POST', 'payload-123', { MIRROR_BODY_MODE: 'full' });
    expect(candidateCalls()[0].body).toBeNull();
  });

  it('an unknown MIRROR_BODY_MODE fails closed to none', async () => {
    await send('POST', 'payload-123', { MIRROR_BODY_MODE: 'everything', GOVERNANCE_EGRESS_CONTROLLED: 'true' });
    expect(candidateCalls()[0].body).toBeNull();
  });

  it('mode redacted sends a JSON body with string and number leaves replaced, and drops a non-JSON body', async () => {
    await send('POST', '{"email":"a@b.c","age":41,"ok":true,"items":["x"]}', { MIRROR_BODY_MODE: 'redacted' }, { 'Content-Type': 'application/json' }, '?token=secret');
    const [json] = candidateCalls();
    expect(JSON.parse(json.body as string)).toEqual({ k0: '<string>', k1: 0, k2: true, k3: ['<string>'] }); // keys are positional, never the client's
    expect(json.url).not.toContain('secret');
    calls.length = 0;
    await send('POST', 'plain text with a@b.c', { MIRROR_BODY_MODE: 'redacted' });
    expect(candidateCalls()[0].body).toBeNull();
  });

  it('a write is mirrored to the candidate but has no baseline to compare with, so no Scientist message is queued', async () => {
    const queue = { send: vi.fn(async () => {}) };
    await handler.fetch(new Request(urlFor('POST'), { method: 'POST', body: '{}', headers: { Authorization: 'Bearer tok' } }), { ...env(), SCIENTIST_QUEUE: queue }, ctx);
    await settleUntil(() => candidateCalls().length > 0);
    await settleAll();
    expect(candidateCalls()).toHaveLength(1);
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('the Scientist queue message carries no body, only allowlisted headers and a templated path, and nothing logs data', async () => {
    const queue = { send: vi.fn(async () => {}) };
    const logged: string[] = [];
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
    const secret = 'sk_live_TOPSECRET';
    await handler.fetch(
      new Request(urlFor('GET', `?token=${secret}`), {
        method: 'GET',
        headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json', 'X-Csrf-Token': secret, Cookie: `s=${secret}`, 'X-Forwarded-For': '9.9.9.9' },
      }),
      { ...env({ MIRROR_BODY_MODE: 'full', GOVERNANCE_EGRESS_CONTROLLED: 'true' }), SCIENTIST_QUEUE: queue },
      ctx
    );
    await settleUntil(() => queue.send.mock.calls.length > 0);
    expect(queue.send).toHaveBeenCalledTimes(1);
    const message = (queue.send.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect('body' in message && message.body !== undefined).toBe(false);
    expect(message.headers).toEqual({ 'content-type': 'application/json' });
    expect((message.baseline as { kind: string }).kind).toBe('production');
    expect(message.path).toBe('/:id/:id'); // /m/<n> with no configured route words
    expect(JSON.stringify(message)).not.toContain(secret);
    expect(logged.join('\n')).not.toContain(secret);
  });

  it('the Analytics Engine write carries the route template, never the raw path', async () => {
    const writes: string[] = [];
    const ANALYTICS = { writeDataPoint: vi.fn((point: unknown) => { writes.push(JSON.stringify(point)); }) };
    const queue = { send: vi.fn(async () => {}) };
    const url = urlFor('GET');
    await handler.fetch(new Request(url, { headers: { Authorization: 'Bearer tok' } }), { ...env(), ANALYTICS, SCIENTIST_QUEUE: queue }, ctx);
    await settleUntil(() => writes.some((w) => w.includes(':id')) && queue.send.mock.calls.length > 0);
    // mode none: the candidate saw the router's id as x-request-id, and the queue message carries the same id
    const message = (queue.send.mock.calls[0] as unknown[])[0] as { requestId: string };
    expect(message.requestId).toBe(candidateCalls()[0].xRequestId);
    const raw = new URL(url).pathname; // /m/<number>
    expect(writes.some((w) => w.includes(':id'))).toBe(true);
    expect(writes.every((w) => !w.includes(raw))).toBe(true);
  });

  it('wrangler.toml keeps the safe defaults: mode none, query strings redacted from logs', async () => {
    const { readFileSync } = await import('node:fs');
    const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
    expect(toml).toMatch(/^MIRROR_BODY_MODE = "none"$/m);
    expect(toml).toMatch(/^redact_query_string = true$/m);
    expect(toml).not.toMatch(/^GOVERNANCE_EGRESS_CONTROLLED/m);
  });

  it('the baseline is a like-for-like production answer: the same sanitized request the candidate got, never the caller credentials or query', async () => {
    await send('GET', undefined, {}, { Cookie: 's=secret', 'X-Csrf-Token': 'secret' }, '?q=1&token=secret');
    const base = calls.filter((c) => c.url.startsWith(BASELINE_URL));
    expect(base).toHaveLength(1);
    expect(base[0].url).not.toContain('?');
    expect(base[0].url).not.toContain('secret');
    expect(base[0].headers.get('authorization')).toBeNull();
    expect(base[0].headers.get('cookie')).toBeNull();
    expect(base[0].headers.get('x-csrf-token')).toBeNull();
    // same path as the candidate's
    expect(new URL(base[0].url).pathname).toBe(new URL(candidateCalls()[0].url).pathname);
  });

  it('in mode full the baseline still gets no caller credentials (the candidate allowlist applies to it too)', async () => {
    await send('GET', undefined, FULL, { Cookie: 's=secret' });
    const base = calls.filter((c) => c.url.startsWith(BASELINE_URL));
    expect(base).toHaveLength(1);
    expect(base[0].headers.get('authorization')).toBeNull();
    expect(base[0].headers.get('cookie')).toBeNull();
  });

  it('every request the router sends carries the loop-guard marker header', async () => {
    await send('GET');
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) expect(c.headers.get('x-beehive-mirror')).toBe('1');
  });

  it('no baseline answer, no message: a failing baseline fetch queues nothing', async () => {
    const queue = { send: vi.fn(async () => {}) };
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (input: Request | string, init?: RequestInit) => {
      const req = typeof input === 'string' ? new Request(input, init) : input;
      calls.push({ url: req.url, method: req.method, body: null, redirect: req.redirect, xRequestId: null, headers: req.headers, aborted: () => false });
      if (req.url.startsWith(BASELINE_URL)) throw new Error('boom');
      return new Response('ok');
    });
    await handler.fetch(new Request(urlFor('GET'), { headers: { Authorization: 'Bearer tok' } }), { ...env(), SCIENTIST_QUEUE: queue }, ctx);
    await settleUntil(() => calls.some((c) => c.url.startsWith(BASELINE_URL)));
    await settleAll();
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('a non-2xx baseline answer (a 401) is a real answer and is queued as production', async () => {
    const queue = { send: vi.fn(async () => {}) };
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (input: Request | string, init?: RequestInit) => {
      const req = typeof input === 'string' ? new Request(input, init) : input;
      calls.push({ url: req.url, method: req.method, body: null, redirect: req.redirect, xRequestId: null, headers: req.headers, aborted: () => false });
      return new Response('no', { status: req.url.startsWith(BASELINE_URL) ? 401 : 200 });
    });
    await handler.fetch(new Request(urlFor('GET'), { headers: { Authorization: 'Bearer tok' } }), { ...env(), SCIENTIST_QUEUE: queue }, ctx);
    await settleUntil(() => queue.send.mock.calls.length > 0);
    const message = (queue.send.mock.calls[0] as unknown[])[0] as { baseline: { status: number; kind: string }; candidates: Array<{ candidateId: string }> };
    expect(message.baseline).toMatchObject({ status: 401, kind: 'production' });
    expect(message.candidates.map((c) => c.candidateId)).toEqual(['cand-a']); // the baseline is not one of the candidates
  });

  describe('POST /mirror (descriptor)', () => {
    const mirror = (body: unknown, headers: Record<string, string> = { Authorization: 'Bearer tok' }) =>
      handler.fetch(new Request('http://localhost/mirror', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers }), env(), ctx);

    it('is behind the auth gate', async () => {
      expect((await mirror({ v: 1, method: 'GET', path: '/' }, {})).status).toBe(401);
    });

    it('rejects anything but a strict template descriptor with a 400, before any fetch', async () => {
      for (const bad of [
        'not json',
        { v: 1, method: 'POST', path: '/' },
        { v: 2, method: 'GET', path: '/' },
        { v: 1, method: 'GET', path: '/users/alice@x.com' },
        { v: 1, method: 'GET', path: '/api?x=1' },
        { v: 1, method: 'GET', path: '/a/b/c/d/e/f/g/h/i' },
        { v: 1, method: 'GET', path: '/api', headers: { authorization: 'x' } },
      ]) {
        expect((await mirror(bad)).status).toBe(400);
      }
      expect(calls).toHaveLength(0);
    });

    it('a descriptor is sampled per candidate by a random draw against its split, not by a URL hash', async () => {
      const partial = liveRef('cand-a', 'https://cand-a.bz23711.workers.dev');
      partial.deployment.trafficPercentage = 50;
      const e = { ...env(), SPEC_DO: { idFromName: () => 'id', get: () => ({ fetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: [partial] }), { status: 200 })) }) } };
      const run = async (draw: number) => {
        calls.length = 0;
        vi.spyOn(Math, 'random').mockReturnValue(draw);
        await handler.fetch(new Request('http://localhost/mirror', { method: 'POST', body: JSON.stringify({ v: 1, method: 'GET', path: '/api/:id' }), headers: { Authorization: 'Bearer tok' } }), { ...e, SCIENTIST_QUEUE: { send: vi.fn(async () => {}) } }, ctx);
        await settleAll();
        return candidateCalls().length;
      };
      expect(await run(0.1)).toBe(1);
      expect(await run(0.9)).toBe(0);
    });

    it('accepts, answers 202 at once and fans out regardless of the URL hash gates (many descriptors, every one mirrored)', async () => {
      const queue = { send: vi.fn(async () => {}) };
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      // a draw of 0.5 is far outside the default 1% canary split, which is what the hash gate would have used
      const res = await handler.fetch(new Request('http://localhost/mirror', { method: 'POST', body: JSON.stringify({ v: 1, method: 'GET', path: '/api/:id' }), headers: { Authorization: 'Bearer tok' } }), { ...env(), SCIENTIST_QUEUE: queue }, ctx);
      expect(res.status).toBe(202);
      await settleUntil(() => queue.send.mock.calls.length > 0);
      expect(candidateCalls()).toHaveLength(1);
      expect(queue.send).toHaveBeenCalledTimes(1);
      const message = (queue.send.mock.calls[0] as unknown[])[0] as { path: string; method: string; baseline: { kind: string } };
      expect(message).toMatchObject({ path: '/api/:id', method: 'GET', baseline: { kind: 'production' } });
    });
  });

  it('a POST body reaches the candidate in mode full (with the egress var), and the production baseline is not replayed', async () => {
    const res = await send('POST', 'payload-123', FULL);
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
