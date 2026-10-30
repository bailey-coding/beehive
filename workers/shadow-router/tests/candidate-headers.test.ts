/**
 * Mirrored requests must not carry the caller's credentials to candidate code (agent-written, untrusted), while the
 * trusted production baseline keeps them. Unit tests of the allowlist plus one run through the real handler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import handler from '../index';
import { BASELINE_TARGET_ID, headersForTarget } from '../candidate-headers';

const incoming = () => new Headers({
  Authorization: 'Bearer platform-token', Cookie: 'session=abc', 'X-Actor-ID': 'actor-1', 'X-Api-Key': 'k', 'Proxy-Authorization': 'p',
  Accept: 'application/json', 'Accept-Language': 'en', 'Content-Type': 'text/plain', 'User-Agent': 'ua/1', 'X-Request-Id': 'r-1',
});

describe('headersForTarget', () => {
  it('gives a candidate only the allowlisted headers, never credentials or internal headers', () => {
    const out = headersForTarget('cand-a', incoming());
    expect([...out.keys()].sort()).toEqual(['accept', 'accept-language', 'content-type', 'user-agent', 'x-request-id']);
    for (const secret of ['authorization', 'cookie', 'x-actor-id', 'x-api-key', 'proxy-authorization']) expect(out.has(secret)).toBe(false);
  });

  it('leaves the trusted baseline untouched', () => {
    const src = incoming();
    expect(headersForTarget(BASELINE_TARGET_ID, src)).toBe(src);
  });

  it('copes with a request that has none of the allowed headers', () => {
    expect([...headersForTarget('cand-a', new Headers({ Authorization: 'x' })).keys()]).toEqual([]);
  });
});

describe('shadow router -> candidate request headers (through the handler)', () => {
  // Same hash as classifyRequest: pick a URL inside the 1% top-level canary split
  function inCanary(url: string): boolean {
    const id = `GET:${url}`;
    let hash = 0;
    for (let i = 0; i < id.length; i++) { hash = (hash << 5) - hash + id.charCodeAt(i); hash = hash & hash; }
    return (Math.abs(hash) % 10000) / 10000 < 0.01;
  }
  const live = {
    ref: { id: 'ref-a', specId: 'spec-1', rung: 'canary', candidateId: 'cand-a', commitSha: null, workerVersionId: 'v', prevRefId: null, action: 'promote', movedBy: 'canary-worker', movedAt: 1 },
    deployment: {
      id: 'dep-a', candidateId: 'cand-a', specId: 'spec-1', status: 'deployed', url: 'https://cand-a.bz23711.workers.dev', workerVersionId: 'v', commitSha: null,
      trafficPercentage: 100, holdoutPercentage: 0, autoRollback: true, deployRefId: 'ref-a', rollbackReason: null,
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    },
  };
  const seen: Array<{ url: string; headers: Headers }> = [];

  beforeEach(() => {
    seen.length = 0;
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async (input: Request | string, init?: Request) => {
      const url = typeof input === 'string' ? input : input.url;
      seen.push({ url, headers: new Headers((init as Request | undefined)?.headers ?? (typeof input === 'string' ? undefined : input.headers)) });
      return new Response('ok', { status: 200 });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('a live canary candidate receives no Authorization, Cookie or X-Actor-ID, but keeps Accept', async () => {
    const stub = { fetch: vi.fn(async (input: Request | string) => {
      const u = new URL(typeof input === 'string' ? input : input.url);
      return u.pathname === '/deploy-refs/live' ? new Response(JSON.stringify({ success: true, data: [live] }), { status: 200 }) : new Response('{}', { status: 404 });
    }) };
    const env = { API_AUTH_TOKEN: 'tok', LIVE_REFS_CACHE_TTL_MS: '0', SPEC_DO: { idFromName: () => 'id', get: () => stub } };
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    let url = '';
    for (let i = 0; i < 100_000 && !url; i++) if (inCanary(`http://localhost/h/${i}`)) url = `http://localhost/h/${i}`;
    expect(url).not.toBe('');
    const res = await handler.fetch(new Request(url, { headers: { Authorization: 'Bearer tok', Cookie: 'session=abc', 'X-Actor-ID': 'actor-1', Accept: 'text/html' } }), env, ctx);
    expect(res.status).toBe(200);
    const toCandidate = seen.filter((s) => s.url.startsWith('https://cand-a.bz23711.workers.dev'));
    expect(toCandidate.length).toBeGreaterThan(0);
    for (const call of toCandidate) {
      expect(call.headers.get('authorization')).toBeNull();
      expect(call.headers.get('cookie')).toBeNull();
      expect(call.headers.get('x-actor-id')).toBeNull();
      expect(call.headers.get('accept')).toBe('text/html');
    }
  });
});
