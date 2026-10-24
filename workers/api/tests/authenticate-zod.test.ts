/**
 * authenticate() input validation: the master X-Actor-ID header and the Spec DO verify bodies
 * are parsed with zod. Malformed input fails closed (400 / 503), never a half-trusted principal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { authenticate, resetUserTokenFailures, USER_TOKEN_FAIL_LIMIT, USER_TOKEN_FAIL_WINDOW_MS } from '../principal';
import { generateServiceToken, generateUserToken } from '../../shared/service-tokens';
import type { SpecDoStub } from '../../shared/spec-do-auth';

const MASTER = 'master-token-for-tests';
const env = { API_AUTH_TOKEN: MASTER };

function stubReturning(status: number, body: unknown): SpecDoStub {
  return { fetch: async () => new Response(JSON.stringify(body), { status }) } as unknown as SpecDoStub;
}
const unused = stubReturning(500, {});

function masterReq(actor?: string): Request {
  const headers: Record<string, string> = { Authorization: `Bearer ${MASTER}` };
  if (actor !== undefined) headers['X-Actor-ID'] = actor;
  return new Request('https://x/api/actors', { headers });
}

async function status(r: Response | { kind: string }): Promise<number | string> {
  return r instanceof Response ? r.status : r.kind;
}

describe('master X-Actor-ID', () => {
  it('absent -> unknown actor, not an error', async () => {
    expect(await authenticate(masterReq(), env, unused)).toMatchObject({ kind: 'master', actorId: 'unknown' });
  });
  it.each(['a'.repeat(36), 'queue-consumer', crypto.randomUUID()])('accepts %s', async (id) => {
    expect(await authenticate(masterReq(id), env, unused)).toMatchObject({ kind: 'master', actorId: id });
  });
  it.each([['over-long', 'a'.repeat(129)], ['inner space', 'two words'], ['non-ascii', 'acteur-é']])(
    'rejects %s with 400',
    async (_n, id) => {
      expect(await status(await authenticate(masterReq(id), env, unused))).toBe(400);
    }
  );
  it('logs a bounded printable copy of a rejected id and says what is allowed', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = (await authenticate(masterReq('two words' + 'x'.repeat(300)), env, unused)) as Response;
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('printable ASCII');
    const line = JSON.parse(String(log.mock.calls[0][0]));
    expect(line.event).toBe('master_actor_rejected');
    expect(line.actorId).toHaveLength(128);
    expect(line.actorId).not.toContain(' ');
    log.mockRestore();
  });
  it('a wrong master token is still 401, not 400', async () => {
    const req = new Request('https://x/', { headers: { Authorization: 'Bearer nope', 'X-Actor-ID': 'two words' } });
    expect(await status(await authenticate(req, env, unused))).toBe(401);
  });
});

describe('service verify body', () => {
  const tok = generateServiceToken();
  const req = () => new Request('https://x/', { headers: { Authorization: `Bearer ${tok}` } });
  const ok = { success: true, data: { kind: 'service', actorId: 'a1', serviceAccountId: 's1', extra: 1 } };
  it('valid -> read-only service principal', async () => {
    expect(await authenticate(req(), env, stubReturning(200, ok))).toMatchObject({
      kind: 'service', actorId: 'a1', scopes: ['read'], serviceAccountId: 's1',
    });
  });
  it.each([
    ['success false', { success: false, data: ok.data }],
    ['wrong kind', { success: true, data: { ...ok.data, kind: 'user' } }],
    ['empty actorId', { success: true, data: { ...ok.data, actorId: '' } }],
    ['numeric actorId', { success: true, data: { ...ok.data, actorId: 7 } }],
    ['no data', { success: true }],
    ['not an object', 'nope'],
  ])('%s -> 503', async (_n, body) => {
    expect(await status(await authenticate(req(), env, stubReturning(200, body)))).toBe(503);
  });
});

describe('user verify body', () => {
  const tok = generateUserToken();
  const req = () => new Request('https://x/', { headers: { Authorization: `Bearer ${tok}` } });
  const found = { found: true, actorId: 'a1', userTokenId: 't1', scope: 'read_write' };
  it('maps each stored scope', async () => {
    for (const [scope, scopes] of [['read', ['read']], ['read_write', ['read', 'write']], ['maintainer', ['read', 'write', 'maintainer']]] as const) {
      expect(await authenticate(req(), env, stubReturning(200, { success: true, data: { ...found, scope } }))).toMatchObject({
        kind: 'user', userTokenId: 't1', scopes,
      });
    }
  });
  it('found:false -> 401', async () => {
    expect(await status(await authenticate(req(), env, stubReturning(200, { success: true, data: { found: false } })))).toBe(401);
  });
  it.each([
    ['success false', { success: false, data: found }],
    ['unknown scope', { success: true, data: { ...found, scope: 'root' } }],
    ['prototype-key scope', { success: true, data: { ...found, scope: 'constructor' } }],
    ['empty userTokenId', { success: true, data: { ...found, userTokenId: '' } }],
    ['missing actorId', { success: true, data: { found: true, userTokenId: 't1', scope: 'read' } }],
    ['found not boolean', { success: true, data: { ...found, found: 'true' } }],
  ])('%s -> 503', async (_n, body) => {
    expect(await status(await authenticate(req(), env, stubReturning(200, body)))).toBe(503);
  });
  it('404 from an old DO -> 503, not 401', async () => {
    expect(await status(await authenticate(req(), env, stubReturning(404, {})))).toBe(503);
  });
});

describe('failed user-token verification limit (per IP, best effort)', () => {
  const tok = generateUserToken();
  const reqFrom = (ip?: string) =>
    new Request('https://x/', { headers: { Authorization: `Bearer ${tok}`, ...(ip ? { 'cf-connecting-ip': ip } : {}) } });
  const notFound = { success: true, data: { found: false } };
  const good = { success: true, data: { found: true, actorId: 'a1', userTokenId: 't1', scope: 'read' } };
  const countingStub = (body: unknown) => {
    let calls = 0;
    const stub = { fetch: async () => (calls++, new Response(JSON.stringify(body), { status: 200 })) } as unknown as SpecDoStub;
    return { stub, calls: () => calls };
  };
  beforeEach(() => {
    resetUserTokenFailures();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('answers 429 with Retry-After and stops hitting the DO after the limit', async () => {
    const { stub, calls } = countingStub(notFound);
    for (let i = 0; i < USER_TOKEN_FAIL_LIMIT; i++) expect(await status(await authenticate(reqFrom('1.1.1.1'), env, stub))).toBe(401);
    const blocked = (await authenticate(reqFrom('1.1.1.1'), env, stub)) as Response;
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('60');
    expect(calls()).toBe(USER_TOKEN_FAIL_LIMIT);
  });
  it('is per IP, and the window expires', async () => {
    const { stub } = countingStub(notFound);
    for (let i = 0; i < USER_TOKEN_FAIL_LIMIT; i++) await authenticate(reqFrom('1.1.1.1'), env, stub);
    expect(await status(await authenticate(reqFrom('2.2.2.2'), env, stub))).toBe(401);
    vi.advanceTimersByTime(USER_TOKEN_FAIL_WINDOW_MS + 1);
    expect(await status(await authenticate(reqFrom('1.1.1.1'), env, stub))).toBe(401);
  });
  it('a success forgives one failure only; 503s do not count; no IP header means no limiting', async () => {
    const bad = countingStub(notFound);
    for (let i = 0; i < USER_TOKEN_FAIL_LIMIT - 1; i++) await authenticate(reqFrom('3.3.3.3'), env, bad.stub);
    await authenticate(reqFrom('3.3.3.3'), env, countingStub(good).stub);
    // one success forgave one failure: 18 failures stand, so 2 more are allowed before the block
    expect(await status(await authenticate(reqFrom('3.3.3.3'), env, bad.stub))).toBe(401);
    expect(await status(await authenticate(reqFrom('3.3.3.3'), env, bad.stub))).toBe(401);
    expect(await status(await authenticate(reqFrom('3.3.3.3'), env, bad.stub))).toBe(429);
    const broken = countingStub({ nonsense: true });
    for (let i = 0; i < USER_TOKEN_FAIL_LIMIT + 5; i++) expect(await status(await authenticate(reqFrom('4.4.4.4'), env, broken.stub))).toBe(503);
    for (let i = 0; i < USER_TOKEN_FAIL_LIMIT + 5; i++) expect(await status(await authenticate(reqFrom(), env, bad.stub))).toBe(401);
  });
});
