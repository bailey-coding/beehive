/**
 * Edge side of user tokens (M12, RFC-0008): authenticate() for bh_usr_ (every verify outcome
 * to its status), the S9 route-class matrix with a default-deny enumeration of every write
 * route the edge dispatches, the X-Actor-ID rewrite, the maintainer cap on every DO request,
 * the master-only admin routes, whoami, and the master stage-1 log line.
 *
 * Two DOs: the real SpecDO over node:sqlite (end to end), and a recording fake for exact
 * control over what verify answers and what each handler sends.
 *
 * Task: T4 | Spec: docs/M12-IMPL-PLAN.md §1 PR-B, §4 (S3, S4, S5, S7, S9, S10, S12, S15), F1, B1
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../index';
import { authorize } from '../principal';
import { SpecDO } from '../../spec-do/index';
import { TEST_DO_TOKENS } from '../../spec-do/tests/do-tokens';
import { makeSqliteState, type SqliteState } from '../../spec-do/tests/sqlite-state';
import { generateServiceToken, generateUserToken, hashToken } from '../../shared/service-tokens';
import type { Principal } from '../../shared/principal';

const MASTER = 'master-token-for-tests';
const CAP = 'x-beehive-maintainer-cap';
const DAY = 24 * 3_600_000;

interface Seen {
  path: string;
  method: string;
  headers: Headers;
  body: string;
}

type DoLike = { fetch(request: Request): Promise<Response> };

function env(doLike: DoLike, extra: Record<string, unknown> = {}) {
  const seen: Seen[] = [];
  const stub = {
    fetch: async (req: Request) => {
      seen.push({ path: new URL(req.url).pathname, method: req.method, headers: req.headers, body: await req.clone().text() });
      return doLike.fetch(req);
    },
  };
  return { seen, env: { SPEC_DO: { idFromName: () => 'id', get: () => stub }, API_AUTH_TOKEN: MASTER, ...TEST_DO_TOKENS, ...extra } };
}

function send(e: unknown, path: string, method = 'GET', opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return worker.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
    e as never,
    {} as never
  );
}

const ok = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ success: status < 400, data, timestamp: Date.now() }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const strip = async (r: Response) => ({ ...((await r.json()) as Record<string, unknown>), timestamp: 0 });

afterEach(() => vi.restoreAllMocks());

// ============================================================================
// Real DO, end to end
// ============================================================================

describe('with the real Spec DO', () => {
  let store: SqliteState;
  let real: SpecDO;
  let ctx: ReturnType<typeof env>;
  let alice: string;
  let maint: string;

  beforeEach(async () => {
    store = makeSqliteState();
    real = new SpecDO(store.state as never, { ...TEST_DO_TOKENS } as never);
    await real.init();
    alice = real.createActor('human', 'alice', '1001').id;
    maint = real.createActor('human', 'maint', '1002').id;
    store.raw.prepare(`UPDATE actors SET role = 'maintainer' WHERE id = ?`).run(maint);
    ctx = env(real);
  });

  const adminMint = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    send(ctx.env, '/api/admin/user-tokens', 'POST', { token: MASTER, body, headers });

  async function token(actorId = alice, scope = 'read_write') {
    const res = await adminMint({ actorId, name: 'cli', scope, expiresInDays: 30 });
    expect(res.status).toBe(201);
    return ((await res.json()) as any).data.token as { id: string; plaintext: string; prefix: string };
  }

  it('admin mint: 201 with the plaintext once, no-store, attributed to X-Actor-ID or the master actor', async () => {
    const res = await adminMint({ actorId: alice, name: 'laptop', scope: 'read', expiresInDays: 7 }, { 'X-Actor-ID': maint });
    expect(res.status).toBe(201);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const t = ((await res.json()) as any).data.token;
    expect(t.plaintext).toMatch(/^bh_usr_[A-Za-z0-9_-]{43}$/);
    expect(t).toMatchObject({ actorId: alice, name: 'laptop', scope: 'read', createdBy: maint, createdVia: 'admin', prefix: t.plaintext.slice(0, 12) });
    expect(t.expiresAt - t.createdAt).toBeGreaterThan(7 * DAY - 60_000);
    expect(t.expiresAt - t.createdAt).toBeLessThanOrEqual(7 * DAY);
    const row = store.raw.prepare('SELECT token_hash FROM user_tokens').get() as any;
    expect(row.token_hash).toBe(await hashToken(t.plaintext));
    expect(JSON.stringify(store.raw.prepare('SELECT * FROM user_tokens').all())).not.toContain(t.plaintext);

    const unattributed = ((await (await adminMint({ actorId: alice, name: 'x' })).json()) as any).data.token;
    expect(unattributed).toMatchObject({ createdBy: 'master', scope: 'read' });
    expect(unattributed.expiresAt - unattributed.createdAt).toBeGreaterThan(30 * DAY - 60_000);
  });

  it('admin mint validates at the edge: 91 days, a bad scope or name, no actorId are 400 with no DO write (S7)', async () => {
    const bad: Record<string, unknown>[] = [
      { actorId: alice, name: 'x', expiresInDays: 91 },
      { actorId: alice, name: 'x', expiresInDays: 0 },
      { actorId: alice, name: 'x', expiresInDays: 1.5 },
      { actorId: alice, name: 'x', expiresInDays: '30' },
      { actorId: alice, name: 'x', scope: 'write' },
      { actorId: alice, name: '' },
      { actorId: alice, name: 'x'.repeat(65) },
      { name: 'x' },
    ];
    for (const b of bad) expect((await adminMint(b)).status, JSON.stringify(b)).toBe(400);
    expect((await send(ctx.env, '/api/admin/user-tokens', 'POST', { token: MASTER, headers: { 'Content-Type': 'application/json' } })).status).toBe(400);
    expect(store.raw.prepare('SELECT COUNT(*) AS n FROM user_tokens').get()).toEqual({ n: 0 });
  });

  it('admin mint passes the DO refusal on: agent target 403, unknown actor 400, maintainer scope for a non-maintainer 403', async () => {
    const agent = real.createActor('agent', 'bot', '9').id;
    expect((await adminMint({ actorId: agent, name: 'x' })).status).toBe(403);
    expect((await adminMint({ actorId: 'nope', name: 'x' })).status).toBe(400);
    expect((await adminMint({ actorId: alice, name: 'x', scope: 'maintainer' })).status).toBe(403);
    expect((await adminMint({ actorId: maint, name: 'x', scope: 'maintainer' })).status).toBe(201);
  });

  it('whoami reports kind user, the actor, the scopes and the token id (not the token)', async () => {
    const t = await token(alice, 'read_write');
    const res = await send(ctx.env, '/api/whoami', 'GET', { token: t.plaintext });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data).toEqual({
      kind: 'user',
      actorId: alice,
      scopes: ['read', 'write'],
      serviceAccountId: null,
      userTokenId: t.id,
    });
    const m = await token(maint, 'maintainer');
    expect(((await (await send(ctx.env, '/api/whoami', 'GET', { token: m.plaintext })).json()) as any).data.scopes).toEqual([
      'read',
      'write',
      'maintainer',
    ]);
    const r = await token(alice, 'read');
    expect(((await (await send(ctx.env, '/api/whoami', 'GET', { token: r.plaintext })).json()) as any).data.scopes).toEqual(['read']);
  });

  it('unknown, revoked, expired, deleted-actor, service-actor and malformed tokens: the same 401 body (S4)', async () => {
    const revoked = await token();
    await send(ctx.env, `/api/admin/user-tokens/${revoked.id}/revoke`, 'POST', { token: MASTER });
    const expired = await token();
    store.raw.prepare('UPDATE user_tokens SET created_at = ?, expires_at = ? WHERE id = ?').run(Date.now() - 2 * DAY, Date.now() - 1, expired.id);
    const gone = real.createActor('human', 'gone', '1003').id;
    const ofGone = await token(gone);
    store.raw.exec('PRAGMA foreign_keys = OFF');
    store.raw.prepare('DELETE FROM actors WHERE id = ?').run(gone);
    store.raw.exec('PRAGMA foreign_keys = ON');
    const svcLater = real.createActor('human', 'svc', '1004').id;
    const ofSvc = await token(svcLater);
    store.raw.exec(`INSERT OR IGNORE INTO organizations (id, name, type, created_at) VALUES ('beehive-system', 'beehive-system', 'artifacts', 0)`);
    store.raw
      .prepare(
        `INSERT INTO service_accounts (id, name, organization_id, token_hash, token_salt, scopes, created_by, created_at, is_active, actor_id)
         VALUES ('sa', 'sa', 'beehive-system', '', '', 'read', ?, 0, 1, ?)`
      )
      .run(maint, svcLater);

    const cases = [generateUserToken(), revoked.plaintext, expired.plaintext, ofGone.plaintext, ofSvc.plaintext, 'bh_usr_short'];
    const bodies = [];
    for (const t of cases) {
      const res = await send(ctx.env, '/api/whoami', 'GET', { token: t });
      expect(res.status, t).toBe(401);
      bodies.push(await strip(res));
    }
    for (const b of bodies) expect(b).toEqual({ success: false, error: 'Unauthorized', timestamp: 0 });
  });

  it('revoke, then the very next request with the same bearer is 401 (S10); revoke is idempotent', async () => {
    const t = await token();
    expect((await send(ctx.env, '/api/organizations', 'GET', { token: t.plaintext })).status).toBe(200);
    const r1 = await send(ctx.env, `/api/admin/user-tokens/${t.id}/revoke`, 'POST', { token: MASTER });
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as any).data).toMatchObject({ revoked: true, token: { id: t.id } });
    expect((await send(ctx.env, '/api/organizations', 'GET', { token: t.plaintext })).status).toBe(401);
    expect((await send(ctx.env, `/api/admin/user-tokens/${t.id}/revoke`, 'POST', { token: MASTER })).status).toBe(200);
    expect((await send(ctx.env, '/api/admin/user-tokens/nope/revoke', 'POST', { token: MASTER })).status).toBe(404);
    expect((await send(ctx.env, '/api/admin/user-tokens/%E0%A4%A/revoke', 'POST', { token: MASTER })).status).toBe(404);
  });

  it('revoke-all revokes that actor only; list shows prefixes and never a hash', async () => {
    const a1 = await token(alice);
    const a2 = await token(alice);
    const m1 = await token(maint);
    const res = await send(ctx.env, '/api/admin/user-tokens/revoke-all', 'POST', { token: MASTER, body: { actorId: alice } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data).toEqual({ revoked: 2 });
    for (const t of [a1, a2]) expect((await send(ctx.env, '/api/whoami', 'GET', { token: t.plaintext })).status).toBe(401);
    expect((await send(ctx.env, '/api/whoami', 'GET', { token: m1.plaintext })).status).toBe(200);
    expect((await send(ctx.env, '/api/admin/user-tokens/revoke-all', 'POST', { token: MASTER, body: { actorId: 'nope' } })).status).toBe(404);
    expect((await send(ctx.env, '/api/admin/user-tokens/revoke-all', 'POST', { token: MASTER, body: {} })).status).toBe(400);

    const list = await send(ctx.env, `/api/admin/user-tokens?actorId=${alice}`, 'GET', { token: MASTER });
    expect(list.status).toBe(200);
    const text = await list.text();
    const rows = JSON.parse(text).data;
    expect(rows).toHaveLength(2);
    expect(rows.every((r: any) => r.revokedAt !== null && r.prefix.startsWith('bh_usr_'))).toBe(true);
    for (const t of [a1, a2]) {
      expect(text).not.toContain(t.plaintext);
      expect(text).not.toContain(await hashToken(t.plaintext));
    }
    expect(((await (await send(ctx.env, '/api/admin/user-tokens', 'GET', { token: MASTER })).json()) as any).data).toHaveLength(3);
  });

  it('revoke and revoke-all pass a client error through: a mistyped X-Actor-ID is 400, a service actor 403, never 503 (review S2)', async () => {
    const t = await token(alice);
    const svc = await send(ctx.env, '/api/admin/service-accounts', 'POST', { token: MASTER, body: { name: 'mon', scopes: ['read'] } });
    const svcActor = ((await svc.json()) as any).data.account.actorId as string;
    const revoke = (actor: string) =>
      send(ctx.env, `/api/admin/user-tokens/${t.id}/revoke`, 'POST', { token: MASTER, headers: { 'X-Actor-ID': actor } });
    const revokeAll = (actor: string) =>
      send(ctx.env, '/api/admin/user-tokens/revoke-all', 'POST', { token: MASTER, headers: { 'X-Actor-ID': actor }, body: { actorId: alice } });

    for (const [call, label] of [[revoke, 'revoke'], [revokeAll, 'revoke-all']] as const) {
      const typo = await call('typo-actor');
      expect(typo.status, label).toBe(400);
      expect(((await typo.json()) as any).error, label).toMatch(/must be an existing actor/);
      const bySvc = await call(svcActor);
      expect(bySvc.status, label).toBe(403);
      expect(((await bySvc.json()) as any).error, label).toMatch(/service account/);
    }
    // Nothing was revoked, and the token still works
    expect(store.raw.prepare('SELECT revoked_at FROM user_tokens WHERE id = ?').get(t.id)).toEqual({ revoked_at: null });
    expect((await send(ctx.env, '/api/whoami', 'GET', { token: t.plaintext })).status).toBe(200);
    // With a real actor both work
    expect((await revoke(maint)).status).toBe(200);
    expect((await revokeAll(maint)).status).toBe(200);
  });

  it('a user or service token cannot reach the admin routes or mint (S5)', async () => {
    const m = await token(maint, 'maintainer');
    const svc = await send(ctx.env, '/api/admin/service-accounts', 'POST', { token: MASTER, body: { name: 'mon', scopes: ['read'] } });
    const svcToken = ((await svc.json()) as any).data.token.plaintext;
    for (const bearer of [m.plaintext, svcToken]) {
      expect((await send(ctx.env, '/api/admin/user-tokens', 'POST', { token: bearer, body: { actorId: maint, name: 'x' } })).status).toBe(403);
      expect((await send(ctx.env, '/api/admin/user-tokens', 'GET', { token: bearer })).status).toBe(403);
      expect((await send(ctx.env, '/api/admin/user-tokens/revoke-all', 'POST', { token: bearer, body: { actorId: maint } })).status).toBe(403);
    }
    expect(store.raw.prepare('SELECT COUNT(*) AS n FROM user_tokens').get()).toEqual({ n: 1 });
  });

  it('an issue created with a spoofed X-Actor-ID is attributed to the token actor (M12 exit)', async () => {
    const t = await token(alice);
    const org = real.createOrganization('acme', 'artifacts');
    const repo = real.createRepository('r', org.id, 'baseline', undefined, undefined, 'https://example.invalid/r.git', 'ns');
    const res = await send(ctx.env, '/api/issues', 'POST', {
      token: t.plaintext,
      headers: { 'X-Actor-ID': maint },
      body: { repositoryId: repo.id, title: 'hello', createdBy: maint },
    });
    expect(res.status).toBe(201);
    // createIssue answers snake_case (created_by), whatever IssueResponse says
    expect(((await res.json()) as any).data.created_by).toBe(alice);
    expect(store.raw.prepare('SELECT created_by FROM issues').get()).toEqual({ created_by: alice });
  });

  it("a read_write token of a maintainer cannot close another actor's issue; a maintainer token can", async () => {
    const org = real.createOrganization('acme', 'artifacts');
    const repo = real.createRepository('r', org.id, 'baseline', undefined, undefined, 'https://example.invalid/r.git', 'ns');
    const issue = real.createIssue(undefined, repo.id, 'bug', 'body', alice);
    const rw = await token(maint, 'read_write');
    const close = (bearer: string) => send(ctx.env, `/api/issues/${issue.id}/status`, 'PATCH', { token: bearer, body: { status: 'closed' } });
    expect((await close(rw.plaintext)).status).toBe(403);
    expect(store.raw.prepare('SELECT status FROM issues').get()).toEqual({ status: 'open' });
    const full = await token(maint, 'maintainer');
    expect((await close(full.plaintext)).status).toBe(200);
    expect(store.raw.prepare('SELECT status FROM issues').get()).toEqual({ status: 'closed' });
  });

  it('never logs the plaintext, the hash or the Authorization value (S3)', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const t = await token();
    const bad = generateUserToken();
    await send(ctx.env, '/api/whoami', 'GET', { token: t.plaintext, headers: { 'X-Actor-ID': maint } });
    await send(ctx.env, '/api/whoami', 'GET', { token: bad });
    await send(ctx.env, '/api/issues', 'POST', { token: t.plaintext, body: { title: 'x' } });
    await send(ctx.env, `/api/admin/user-tokens/${t.id}/revoke`, 'POST', { token: MASTER, headers: { 'X-Actor-ID': maint } });
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    for (const secret of [t.plaintext, await hashToken(t.plaintext), bad, await hashToken(bad), MASTER, t.plaintext.slice(12)]) {
      expect(logged).not.toContain(secret);
    }
  });
});

// ============================================================================
// Fake DO: every verify outcome, and what each handler sends
// ============================================================================

/** A DO whose verify answers `verify(hash)`; every other route answers 200 with an empty object. */
function fakeDo(verify: (body: { tokenHash: string }) => Response | Promise<Response>): DoLike {
  return {
    fetch: async (req: Request) => {
      const path = new URL(req.url).pathname;
      if (path === '/internal/user-tokens/verify') return verify((await req.json()) as { tokenHash: string });
      if (path === '/health') return new Response('OK');
      return ok({ id: 'x' }, req.method === 'POST' ? 201 : 200);
    },
  };
}

const userDo = (scope: string, actorId = 'actor-1') =>
  fakeDo(() => ok({ found: true, actorId, userTokenId: 'tok-1', scope }));

describe('authenticate: every verify outcome to its status (S15)', () => {
  const T = generateUserToken();
  const whoami = (doLike: DoLike, extra: Record<string, unknown> = {}, token = T) => {
    const ctx = env(doLike, extra);
    return { ctx, res: send(ctx.env, '/api/whoami', 'GET', { token }) };
  };

  it('found:true -> the user principal; the DO got only the hash', async () => {
    const { ctx, res } = whoami(userDo('read'));
    expect((await res).status).toBe(200);
    expect(ctx.seen).toHaveLength(1);
    expect(ctx.seen[0].path).toBe('/internal/user-tokens/verify');
    expect(JSON.parse(ctx.seen[0].body)).toEqual({ tokenHash: await hashToken(T) });
    expect(ctx.seen[0].body).not.toContain(T);
  });

  it('found:false -> 401', async () => {
    expect((await whoami(fakeDo(() => ok({ found: false }))).res).status).toBe(401);
  });

  it.each([
    ['an old DO without the route (404)', () => new Response(JSON.stringify({ success: false, error: 'Not found' }), { status: 404 })],
    ['500', () => new Response('boom', { status: 500 })],
    ['401 from the DO gate', () => new Response('{}', { status: 401 })],
    ['201', () => ok({ found: true, actorId: 'a', userTokenId: 't', scope: 'read' }, 201)],
    ['not JSON', () => new Response('not json', { status: 200 })],
    ['success:false', () => new Response(JSON.stringify({ success: false, data: { found: false } }), { status: 200 })],
    ['found missing', () => ok({ actorId: 'a', userTokenId: 't', scope: 'read' })],
    ['found "true"', () => ok({ found: 'true', actorId: 'a', userTokenId: 't', scope: 'read' })],
    ['an unknown scope', () => ok({ found: true, actorId: 'a', userTokenId: 't', scope: 'admin' })],
    ['an inherited scope name', () => ok({ found: true, actorId: 'a', userTokenId: 't', scope: 'constructor' })],
    ['no actorId', () => ok({ found: true, userTokenId: 't', scope: 'read' })],
    ['an empty actorId', () => ok({ found: true, actorId: '', userTokenId: 't', scope: 'read' })],
    ['no userTokenId', () => ok({ found: true, actorId: 'a', scope: 'read' })],
    ['no data', () => new Response(JSON.stringify({ success: true }), { status: 200 })],
  ])('%s -> 503, never 401, anonymous or master', async (_n, answer) => {
    const res = await whoami(fakeDo(answer as () => Response)).res;
    expect(res.status).toBe(503);
  });

  it('a throw -> 503', async () => {
    const res = await whoami(fakeDo(() => {
      throw new Error('network');
    })).res;
    expect(res.status).toBe(503);
  });

  it('a malformed bh_usr_ token -> 401 with no DO call', async () => {
    for (const bad of ['bh_usr_', 'bh_usr_abc', T + 'x', T.slice(0, -1) + '=']) {
      const { ctx, res } = whoami(userDo('read'), {}, bad);
      expect((await res).status, bad).toBe(401);
      expect(ctx.seen).toHaveLength(0);
    }
  });

  it('API_AUTH_TOKEN unset -> 503 before any DO call', async () => {
    const { ctx, res } = whoami(userDo('read'), { API_AUTH_TOKEN: undefined });
    expect((await res).status).toBe(503);
    expect(ctx.seen).toHaveLength(0);
  });

  it('a bh_usr_ token in X-API-Token is not accepted (Bearer only)', async () => {
    const ctx = env(userDo('read_write'));
    const res = await send(ctx.env, '/api/whoami', 'GET', { headers: { 'X-API-Token': T } });
    expect(res.status).toBe(401);
    expect(ctx.seen).toHaveLength(0);
  });

  it('admin routes against an old DO (404 on every user-token route) are 503, never "no tokens"', async () => {
    const old: DoLike = { fetch: async () => new Response(JSON.stringify({ success: false, error: 'Not found' }), { status: 404 }) };
    const ctx = env(old);
    expect((await send(ctx.env, '/api/admin/user-tokens', 'GET', { token: MASTER })).status).toBe(503);
    expect((await send(ctx.env, '/api/admin/user-tokens', 'POST', { token: MASTER, body: { actorId: 'a', name: 'x' } })).status).toBe(503);
    expect((await send(ctx.env, '/api/admin/user-tokens/t1/revoke', 'POST', { token: MASTER })).status).toBe(503);
    expect((await send(ctx.env, '/api/admin/user-tokens/revoke-all', 'POST', { token: MASTER, body: { actorId: 'a' } })).status).toBe(503);
    // and a user token against it is 503 (the verify route is missing too)
    expect((await send(ctx.env, '/api/whoami', 'GET', { token: T })).status).toBe(503);
  });

  it('revoke and revoke-all: a DO 5xx stays 503, a DO 400/403 passes through with its message', async () => {
    const answer = (status: number, error: string): DoLike => ({
      fetch: async () => new Response(JSON.stringify({ success: false, error }), { status }),
    });
    const routes = [
      ['/api/admin/user-tokens/t1/revoke', undefined],
      ['/api/admin/user-tokens/revoke-all', { actorId: 'a' }],
    ] as const;
    for (const [path, body] of routes) {
      for (const [status, expected] of [[500, 503], [502, 503], [400, 400], [403, 403]] as const) {
        const ctx = env(answer(status, `do says ${status}`));
        const res = await send(ctx.env, path, 'POST', { token: MASTER, body });
        expect(res.status, `${path} ${status}`).toBe(expected);
        const text = ((await res.json()) as any).error;
        expect(text, `${path} ${status}`).toBe(expected === 503 ? 'Token service unavailable' : `do says ${status}`);
      }
    }
  });
});

// ============================================================================
// S9: route classes, default deny
// ============================================================================

type RouteClass = 'write' | 'maintainer' | 'denied';

/**
 * Every non-GET route the edge dispatches, with a concrete path and its class. index.ts is
 * checked against its source below; the lifecycle, service-account and user-token routes are
 * listed by hand (all denied: they are DELETE or under /api/admin/).
 */
const WRITE_ROUTES: Array<[method: string, path: string, cls: RouteClass]> = [
  ['POST', '/api/organizations', 'write'],
  ['POST', '/api/actors', 'denied'],
  ['PATCH', '/api/actors/x1/trust', 'denied'],
  ['PATCH', '/api/actors/x1/promotion-authority', 'denied'],
  ['POST', '/api/repositories', 'write'],
  ['POST', '/api/specs', 'write'],
  ['PATCH', '/api/specs/x1/stage', 'write'],
  ['POST', '/api/specs/x1/claim', 'write'],
  ['POST', '/api/candidates', 'write'],
  ['PATCH', '/api/candidates/x1/stage', 'denied'],
  ['POST', '/api/gate-verdicts', 'denied'],
  ['POST', '/api/candidates/x1/gate/pre-merge', 'write'],
  ['POST', '/api/trials', 'denied'],
  ['POST', '/api/trials/x1/decide', 'denied'],
  ['POST', '/api/promotions', 'denied'],
  ['POST', '/api/issues', 'write'],
  ['PATCH', '/api/issues/x1/stage', 'write'],
  ['PATCH', '/api/issues/x1/status', 'write'],
  ['PATCH', '/api/issues/x1/comment-policy', 'maintainer'],
  ['POST', '/api/issues/x1/comments', 'write'],
  ['POST', '/api/issue-spec-links', 'write'],
  ['POST', '/api/issue-candidate-links', 'write'],
  ['POST', '/api/candidates/x1/execute', 'denied'],
];

const OTHER_MODULE_ROUTES: Array<[method: string, path: string]> = [
  // lifecycle.ts
  ['DELETE', '/api/organizations/x1'],
  ['DELETE', '/api/repositories/x1'],
  ['DELETE', '/api/specs/x1'],
  ['DELETE', '/api/candidates/x1'],
  ['POST', '/api/admin/purge'],
  ['POST', '/api/admin/actors/x1/role'],
  // service-accounts.ts
  ['POST', '/api/admin/service-accounts'],
  ['POST', '/api/admin/service-accounts/x1/revoke'],
  ['POST', '/api/admin/service-accounts/x1/tokens'],
  ['POST', '/api/admin/service-accounts/x1/tokens/x2/revoke'],
  // user-tokens.ts
  ['POST', '/api/admin/user-tokens'],
  ['POST', '/api/admin/user-tokens/x1/revoke'],
  ['POST', '/api/admin/user-tokens/revoke-all'],
  // retired, 410 for master
  ['POST', '/api/service-accounts'],
];

const SCOPES: Record<string, Principal['scopes']> = {
  read: ['read'],
  read_write: ['read', 'write'],
  maintainer: ['read', 'write', 'maintainer'],
};
const userPrincipal = (scopes: Principal['scopes']): Principal => ({
  kind: 'user',
  actorId: 'a',
  scopes,
  promotionAuthority: false,
  organizationId: null,
  userTokenId: 't',
});
const allowed = (scope: string, cls: RouteClass) =>
  cls === 'write' ? scope !== 'read' : cls === 'maintainer' ? scope === 'maintainer' : false;

describe('S9 default-deny', () => {
  it('the table lists exactly the write routes index.ts dispatches', () => {
    const src = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const found = new Set<string>();
    const re = /if \(path(?: === '([^']+)'|\.match\(\/\^(.+?)\$\/\)) && method === '(POST|PATCH|PUT|DELETE)'\)/g;
    for (const m of src.matchAll(re)) {
      const path = m[1] ?? m[2].replace(/\[\^\\\/\]\+/g, 'x1').replace(/\\\//g, '/');
      found.add(`${m[3]} ${path}`);
    }
    expect(found.size).toBeGreaterThan(20);
    expect([...found].sort()).toEqual(WRITE_ROUTES.map(([m, p]) => `${m} ${p}`).sort());
  });

  it.each(Object.keys(SCOPES))('authorize(): every write route for a %s token matches its class', (scope) => {
    for (const [method, path, cls] of WRITE_ROUTES) {
      const res = authorize(userPrincipal(SCOPES[scope]), method, path);
      expect(res === null, `${scope} ${method} ${path}`).toBe(allowed(scope, cls));
      if (res) expect(res.status).toBe(403);
    }
    for (const [method, path] of OTHER_MODULE_ROUTES) {
      expect(authorize(userPrincipal(SCOPES[scope]), method, path)?.status, `${scope} ${method} ${path}`).toBe(403);
    }
  });

  it.each(Object.keys(SCOPES))('authorize(): reads for a %s token: non-admin GET/HEAD yes, /api/admin no', (scope) => {
    const p = userPrincipal(SCOPES[scope]);
    for (const path of ['/health', '/api/health', '/api/whoami', '/api/issues', '/api/issues/x1/comments', '/api/actors']) {
      expect(authorize(p, 'GET', path), path).toBeNull();
      expect(authorize(p, 'HEAD', path), path).toBeNull();
    }
    for (const path of ['/api/admin', '/api/admin/user-tokens', '/api/admin/service-accounts']) {
      expect(authorize(p, 'GET', path)?.status, path).toBe(403);
    }
  });

  it('authorize(): unknown write routes and methods are denied for every scope', () => {
    const probes: Array<[string, string]> = [
      ['POST', '/api/whatever'],
      ['PUT', '/api/issues'],
      ['DELETE', '/api/issues/x1'],
      ['POST', '/api/issues/x1/comments/x2'],
      ['POST', '/api/issues/'],
      ['POST', '/health'],
      ['PATCH', '/api/issues/x1/comment-policy/'],
      ['OPTIONS', '/api/issues'],
      ['post', '/api/issues'],
    ];
    for (const scope of Object.keys(SCOPES)) {
      for (const [method, path] of probes) {
        expect(authorize(userPrincipal(SCOPES[scope]), method, path)?.status, `${scope} ${method} ${path}`).toBe(403);
      }
    }
  });

  it('a service principal stays read-only, whatever scopes it carries', () => {
    const svc: Principal = { kind: 'service', actorId: 'a', scopes: ['read', 'write', 'maintainer'], promotionAuthority: false, organizationId: null };
    for (const [method, path] of WRITE_ROUTES) expect(authorize(svc, method, path)?.status, `${method} ${path}`).toBe(403);
  });

  it.each(Object.keys(SCOPES))('through the worker: every denied route is 403 for a %s token, before any handler DO call', async (scope) => {
    for (const [method, path, cls] of WRITE_ROUTES) {
      if (allowed(scope, cls)) continue;
      const ctx = env(userDo(scope));
      const res = await send(ctx.env, path, method, { token: generateUserToken(), body: { sandboxRunnerUrl: 'https://evil.example' } });
      expect(res.status, `${scope} ${method} ${path}`).toBe(403);
      expect(ctx.seen.map((s) => s.path), `${scope} ${method} ${path}`).toEqual(['/internal/user-tokens/verify']);
    }
    for (const [method, path] of OTHER_MODULE_ROUTES) {
      const ctx = env(userDo(scope));
      const res = await send(ctx.env, path, method, { token: generateUserToken(), body: {} });
      expect(res.status, `${scope} ${method} ${path}`).toBe(403);
      expect(ctx.seen.map((s) => s.path)).toEqual(['/internal/user-tokens/verify']);
    }
    // include_deleted reads are master-only (lifecycle.ts)
    const ctx = env(userDo(scope));
    expect((await send(ctx.env, '/api/organizations?include_deleted=1', 'GET', { token: generateUserToken() })).status).toBe(403);
  });
});

// ============================================================================
// X-Actor-ID rewrite and the maintainer cap on every DO request (F1)
// ============================================================================

describe('X-Actor-ID rewrite and the maintainer cap', () => {
  it('a spoofed X-Actor-ID is replaced by the token actor on every DO request, and in the body fields the edge sets', async () => {
    const ctx = env(userDo('read_write', 'alice'));
    await send(ctx.env, '/api/issues', 'POST', {
      token: generateUserToken(),
      headers: { 'X-Actor-ID': 'maint' },
      body: { repositoryId: 'r', title: 't', createdBy: 'maint' },
    });
    const doCall = ctx.seen.find((s) => s.path === '/api/issues')!;
    expect(doCall.headers.get('X-Actor-ID')).toBe('alice');
    expect(JSON.parse(doCall.body).createdBy).toBe('alice');
  });

  const allowedWrites = WRITE_ROUTES.filter(([, , cls]) => cls === 'write');

  it.each(['read_write', 'read'])('%s token of a maintainer actor: every DO request of every allowed route carries the cap', async (scope) => {
    const routes: Array<[string, string]> = [
      ['GET', '/health'],
      ['GET', '/api/health'],
      ['GET', '/api/issues'],
      ['GET', '/api/whoami'],
      ...(scope === 'read_write' ? allowedWrites.map(([m, p]) => [m, p] as [string, string]) : []),
    ];
    for (const [method, path] of routes) {
      const ctx = env(userDo(scope, 'maint'));
      const res = await send(ctx.env, path, method, { token: generateUserToken(), body: method === 'GET' ? undefined : {} });
      expect([401, 403, 503], `${method} ${path}`).not.toContain(res.status);
      const handlerCalls = ctx.seen.filter((s) => s.path !== '/internal/user-tokens/verify');
      if (path !== '/api/whoami') expect(handlerCalls.length, `${method} ${path}`).toBeGreaterThan(0);
      for (const c of handlerCalls) expect(c.headers.get(CAP), `${method} ${path} -> ${c.path}`).toBe('1');
      // The verify call itself is not capped (it is made before the principal exists)
      expect(ctx.seen[0].headers.get(CAP)).toBeNull();
    }
  });

  it('a maintainer token sends the cap on no request, including comment-policy', async () => {
    for (const [method, path] of [['GET', '/health'], ...allowedWrites, ['PATCH', '/api/issues/x1/comment-policy']] as Array<[string, string]>) {
      const ctx = env(userDo('maintainer', 'maint'));
      const res = await send(ctx.env, path, method, { token: generateUserToken(), body: method === 'GET' ? undefined : {} });
      expect([401, 403, 503], `${method} ${path}`).not.toContain(res.status);
      for (const c of ctx.seen) expect(c.headers.get(CAP), `${method} ${path}`).toBeNull();
    }
  });

  it('master and service principals never send the cap', async () => {
    const svc = fakeDo(() => ok({ found: false }));
    const ctx = env({
      fetch: async (req: Request) =>
        new URL(req.url).pathname === '/internal/service-tokens/verify'
          ? ok({ kind: 'service', actorId: 'svc', serviceAccountId: 'sa' })
          : svc.fetch(req),
    });
    await send(ctx.env, '/api/issues', 'POST', { token: MASTER, body: {}, headers: { 'X-Actor-ID': 'maint' } });
    await send(ctx.env, '/api/issues', 'GET', { token: generateServiceToken() });
    expect(ctx.seen.length).toBeGreaterThan(1);
    for (const c of ctx.seen) expect(c.headers.get(CAP)).toBeNull();
  });
});

// ============================================================================
// S12: master stage-1 log
// ============================================================================

describe('master stage-1 log (S12)', () => {
  function withAnalytics() {
    const points: unknown[] = [];
    const ctx = env(fakeDo(() => ok({ found: false })), { ANALYTICS: { writeDataPoint: (p: unknown) => points.push(p) } });
    return { ctx, points };
  }

  it('one JSON line and one AE point with exactly the agreed fields, no query string, headers or token', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { ctx, points } = withAnalytics();
    await send(ctx.env, '/api/issues/abc-123/comments?secret=q', 'POST', {
      token: MASTER,
      headers: { 'X-Actor-ID': 'actor-7', 'cf-ray': 'ray-1', Cookie: 'c=1' },
      body: { body: 'hi' },
    });
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('master_actor_assertion'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      event: 'master_actor_assertion',
      method: 'POST',
      path: '/api/issues/abc-123/comments',
      actorId: 'actor-7',
      ray: 'ray-1',
    });
    expect(points).toEqual([{ indexes: ['master_actor_assertion'], blobs: ['actor-7', 'POST', '/api/issues/:id/comments'] }]);
    const everything = JSON.stringify(log.mock.calls) + JSON.stringify(points);
    for (const s of [MASTER, 'secret=q', 'c=1', 'Bearer']) expect(everything).not.toContain(s);
  });

  it('truncates a 300-char actor to 128', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { ctx, points } = withAnalytics();
    await send(ctx.env, '/api/organizations', 'GET', { token: MASTER, headers: { 'X-Actor-ID': 'a'.repeat(300) } });
    const line = JSON.parse(log.mock.calls.map((c) => String(c[0])).find((l) => l.includes('master_actor_assertion'))!);
    expect(line.actorId).toBe('a'.repeat(128));
    expect((points[0] as { blobs: string[] }).blobs[0]).toBe('a'.repeat(128));
  });

  it('no line and no point without X-Actor-ID, with "unknown", or for a user or service principal', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { ctx, points } = withAnalytics();
    await send(ctx.env, '/api/organizations', 'GET', { token: MASTER });
    await send(ctx.env, '/api/organizations', 'GET', { token: MASTER, headers: { 'X-Actor-ID': 'unknown' } });
    const userCtx = env(userDo('read'), { ANALYTICS: { writeDataPoint: (p: unknown) => points.push(p) } });
    await send(userCtx.env, '/api/organizations', 'GET', { token: generateUserToken(), headers: { 'X-Actor-ID': 'spoof' } });
    expect(log.mock.calls.filter((c) => String(c[0]).includes('master_actor_assertion'))).toHaveLength(0);
    expect(points).toHaveLength(0);
  });

  it('an Analytics Engine failure never fails the request', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = env(fakeDo(() => ok({ found: false })), {
      ANALYTICS: {
        writeDataPoint: () => {
          throw new Error('ae down');
        },
      },
    });
    expect((await send(ctx.env, '/api/organizations', 'GET', { token: MASTER, headers: { 'X-Actor-ID': 'a' } })).status).toBe(200);
  });
});
