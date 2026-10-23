/**
 * SpecDO user tokens (M12, RFC-0008): mint / list / revoke / revoke-all / verify on the
 * m9 user_tokens table, the human-with-GitHub-id rule, the maintainer scope, the 90-day
 * ceiling, the cap of 10 live tokens, and "never store or log the plaintext or the hash".
 * Real SQL (node:sqlite, FKs on) through the real router. Rows refer to the security
 * checklist in docs/M12-IMPL-PLAN.md section 4 (S2-S11).
 *
 * Task: T3 | Spec: docs/M12-IMPL-PLAN.md §1 PR-B, §4
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SpecDO } from '../index';
import { makeSqliteState, makeSpecDo, type SqliteState } from './sqlite-state';
import { generateServiceToken, generateUserToken, hashToken, tokenPrefix } from '../../shared/service-tokens';

let store: SqliteState;
let spec: SpecDO;
let alice: string; // human with a GitHub id
let maint: string; // human maintainer with a GitHub id

const DAY = 24 * 3_600_000;

function call(path: string, method = 'GET', body?: unknown, actorId?: string, extra: Record<string, string> = {}): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
  if (actorId) headers['X-Actor-ID'] = actorId;
  return spec.fetch(
    new Request(`https://spec-do.internal${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
}

async function data<T = any>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

interface MintOpts {
  actorId?: string;
  scope?: string;
  createdVia?: string;
  minter?: string;
  name?: string;
  expiresAt?: number;
  headers?: Record<string, string>;
  plaintext?: string;
}

async function mint(o: MintOpts = {}) {
  const plaintext = o.plaintext ?? generateUserToken();
  const hash = await hashToken(plaintext);
  const res = await call(
    '/internal/user-tokens',
    'POST',
    {
      actorId: o.actorId ?? alice,
      name: o.name ?? 'laptop',
      scope: o.scope ?? 'read_write',
      createdVia: o.createdVia ?? 'admin',
      tokenHash: hash,
      tokenPrefix: tokenPrefix(plaintext),
      expiresAt: o.expiresAt ?? Date.now() + 30 * DAY,
    },
    o.minter,
    o.headers
  );
  const body = (await res.json()) as any;
  return { res, plaintext, hash, token: body.data, body };
}

const verify = (tokenHash: string) => call('/internal/user-tokens/verify', 'POST', { tokenHash });
const verified = async (plaintext: string) => data(await verify(await hashToken(plaintext)));
const count = (sql: string, ...params: (string | number)[]) => (store.raw.prepare(sql).get(...params) as { n: number }).n;
// Backdate a token so it expired a moment ago (created_at too: the CHECK wants expires_at > created_at)
const expire = (id: string) =>
  store.raw.prepare('UPDATE user_tokens SET created_at = ?, expires_at = ? WHERE id = ?').run(Date.now() - 2 * DAY, Date.now() - 1, id);

beforeEach(async () => {
  store = makeSqliteState();
  spec = makeSpecDo(store);
  await spec.init();
  alice = spec.createActor('human', 'alice', '1001').id;
  maint = spec.createActor('human', 'maint', '1002').id;
  store.raw.prepare(`UPDATE actors SET role = 'maintainer' WHERE id = ?`).run(maint);
});

afterEach(() => vi.restoreAllMocks());

describe('mint', () => {
  it('stores the hash and the 12-char prefix, never the plaintext, and returns a view without the hash (S2)', async () => {
    const { res, plaintext, hash, token, body } = await mint({ minter: maint });
    expect(res.status).toBe(201);
    expect(token).toMatchObject({
      actorId: alice,
      name: 'laptop',
      prefix: plaintext.slice(0, 12),
      scope: 'read_write',
      createdBy: maint,
      createdVia: 'admin',
      revokedAt: null,
      revokedBy: null,
      lastUsedAt: null,
    });
    expect(token.expiresAt).toBeGreaterThan(token.createdAt);
    const row = store.raw.prepare('SELECT * FROM user_tokens').get() as any;
    expect(row.token_hash).toBe(hash);
    expect(row.token_prefix).toBe(plaintext.slice(0, 12));
    const everything = JSON.stringify(store.raw.prepare('SELECT * FROM user_tokens, actors, entity_history').all());
    expect(everything).not.toContain(plaintext);
    expect(everything).not.toContain(plaintext.slice(12));
    expect(JSON.stringify(body)).not.toContain(hash);
    expect(JSON.stringify(body)).not.toContain('token_hash');
    expect(JSON.stringify(body)).not.toContain('tokenHash');
  });

  it('admin: attributes to X-Actor-ID, or to the reserved master actor without one', async () => {
    expect((await mint({ minter: maint })).token.createdBy).toBe(maint);
    expect((await mint()).token.createdBy).toBe('master');
    expect((await mint({ minter: 'unknown' })).token.createdBy).toBe('master');
    expect((await mint({ minter: 'no-such-actor' })).res.status).toBe(400);
  });

  it('session: the minter must be the target actor (defence in depth, N1)', async () => {
    expect((await mint({ createdVia: 'session', minter: alice })).res.status).toBe(201);
    expect((await mint({ createdVia: 'session', minter: maint })).res.status).toBe(403);
    expect((await mint({ createdVia: 'session' })).res.status).toBe(403);
    expect(count('SELECT COUNT(*) AS n FROM user_tokens')).toBe(1);
    expect((store.raw.prepare('SELECT created_by, created_via FROM user_tokens').get() as any)).toEqual({ created_by: alice, created_via: 'session' });
  });

  it('only human actors with a GitHub id, never an agent, a service actor or an unknown actor (S5)', async () => {
    const agent = spec.createActor('agent', 'bot', '2001').id;
    const noGithub = spec.createActor('human', 'nogh').id;
    const emptyGithub = spec.createActor('human', 'emptygh').id;
    store.raw.prepare(`UPDATE actors SET github_user_id = '' WHERE id = ?`).run(emptyGithub);
    // A service account's actor, made to look human with a GitHub id out of band
    const svcPlain = generateServiceToken();
    const account = spec.createServiceAccount({
      name: 'svc',
      scopes: ['read'],
      tokenHash: await hashToken(svcPlain),
      tokenPrefix: tokenPrefix(svcPlain),
      expiresAt: Date.now() + DAY,
    }).account;
    store.raw.prepare(`UPDATE actors SET type = 'human', github_user_id = '3001' WHERE id = ?`).run(account.actorId as string);

    for (const actorId of [agent, noGithub, emptyGithub, account.actorId as string]) {
      expect((await mint({ actorId })).res.status, actorId).toBe(403);
    }
    expect((await mint({ actorId: 'no-such-actor' })).res.status).toBe(400);
    // A service actor is never a minter either
    expect((await mint({ minter: account.actorId as string })).res.status).toBe(403);
    expect(count('SELECT COUNT(*) AS n FROM user_tokens')).toBe(0);
  });

  it('maintainer scope: only while the target holds the role, and never on a capped request (S6)', async () => {
    expect((await mint({ actorId: alice, scope: 'maintainer' })).res.status).toBe(403);
    expect((await mint({ actorId: maint, scope: 'maintainer' })).res.status).toBe(201);
    expect((await mint({ actorId: maint, scope: 'maintainer', headers: { 'X-Beehive-Maintainer-Cap': '1' } })).res.status).toBe(403);
    expect(count(`SELECT COUNT(*) AS n FROM user_tokens WHERE scope = 'maintainer'`)).toBe(1);
  });

  it('validates input (defence in depth behind the edge)', async () => {
    const plaintext = generateUserToken();
    const base = {
      actorId: alice,
      name: 'n',
      scope: 'read',
      createdVia: 'admin',
      tokenHash: await hashToken(plaintext),
      tokenPrefix: tokenPrefix(plaintext),
      expiresAt: Date.now() + DAY,
    };
    const svc = generateServiceToken();
    const bad: Record<string, unknown>[] = [
      { actorId: '' },
      { actorId: 7 },
      { name: '' },
      { name: '   ' },
      { name: 'x'.repeat(65) },
      { name: 3 },
      { scope: 'write' },
      { scope: 'read,write' },
      { scope: ['read'] },
      { createdVia: 'cli' },
      { createdVia: undefined },
      { tokenHash: plaintext },
      { tokenHash: base.tokenHash.toUpperCase() },
      { tokenPrefix: tokenPrefix(svc) },
      { tokenPrefix: plaintext },
      { expiresAt: Date.now() - 1000 },
      { expiresAt: Date.now() + 91 * DAY },
      { expiresAt: Date.now() + 1.5 },
      { expiresAt: null },
    ];
    for (const patch of bad) {
      const res = await call('/internal/user-tokens', 'POST', { ...base, ...patch });
      expect(res.status, JSON.stringify(patch)).toBe(400);
    }
    expect((await call('/internal/user-tokens', 'POST', 'nope')).status).toBe(400);
    expect(count('SELECT COUNT(*) AS n FROM user_tokens')).toBe(0);
    // Exactly 90 days and a 64-char name are fine
    expect((await call('/internal/user-tokens', 'POST', { ...base, name: 'x'.repeat(64), expiresAt: Date.now() + 90 * DAY })).status).toBe(201);
  });

  it('an expiresAt beyond 90 days + 1 min is refused by the DO itself (S7)', async () => {
    expect((await mint({ expiresAt: Date.now() + 90 * DAY + 2 * 60_000 })).res.status).toBe(400);
    expect((await mint({ expiresAt: Date.now() + 90 * DAY + 30_000 })).res.status).toBe(201);
  });

  it('caps live tokens at 10 per actor (409 beyond); revoked and expired ones do not count', async () => {
    const tokens = [];
    for (let i = 0; i < 10; i++) tokens.push(await mint({ name: `t${i}` }));
    expect(tokens.every((t) => t.res.status === 201)).toBe(true);
    const over = await mint({ name: 'eleventh' });
    expect(over.res.status).toBe(409);
    // Another actor is unaffected
    expect((await mint({ actorId: maint })).res.status).toBe(201);

    await call(`/internal/user-tokens/${tokens[0].token.id}/revoke`, 'POST');
    expect((await mint({ name: 'after-revoke' })).res.status).toBe(201);
    expect((await mint({ name: 'full-again' })).res.status).toBe(409);
    expire(tokens[1].token.id);
    expect((await mint({ name: 'after-expiry' })).res.status).toBe(201);
  });

  it('12 parallel mints give exactly 10 created and 2 conflicts (S11)', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => mint({ name: `p${i}` })));
    const statuses = results.map((r) => r.res.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(10);
    expect(statuses.filter((s) => s === 409)).toHaveLength(2);
    expect(count('SELECT COUNT(*) AS n FROM user_tokens WHERE actor_id = ?', alice)).toBe(10);
  });

  it('a duplicate hash is a 409, not a 500, and inserts nothing', async () => {
    const plaintext = generateUserToken();
    expect((await mint({ plaintext })).res.status).toBe(201);
    expect((await mint({ plaintext, actorId: maint })).res.status).toBe(409);
    expect(count('SELECT COUNT(*) AS n FROM user_tokens')).toBe(1);
  });
});

describe('verify (tier 1, always 200 for a well-formed hash)', () => {
  it('returns the actor, the token id and the scope, and records last_used_at at most once a minute', async () => {
    const { plaintext, token } = await mint();
    const res = await verify(await hashToken(plaintext));
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual({ found: true, actorId: alice, userTokenId: token.id, scope: 'read_write' });
    const used = (store.raw.prepare('SELECT last_used_at FROM user_tokens').get() as any).last_used_at;
    expect(used).toBeGreaterThan(0);
    store.raw.prepare('UPDATE user_tokens SET last_used_at = ?').run(used - 1);
    await verify(await hashToken(plaintext));
    expect((store.raw.prepare('SELECT last_used_at FROM user_tokens').get() as any).last_used_at).toBe(used - 1);
    store.raw.prepare('UPDATE user_tokens SET last_used_at = ?').run(used - 60_000);
    await verify(await hashToken(plaintext));
    expect((store.raw.prepare('SELECT last_used_at FROM user_tokens').get() as any).last_used_at).toBeGreaterThanOrEqual(used);
  });

  it('unknown, revoked, expired, and tokens of a deleted, agent, GitHub-less or service actor: 200 {found:false} (S4)', async () => {
    expect(await verified(generateUserToken())).toEqual({ found: false });

    const revoked = await mint({ name: 'revoked' });
    await call(`/internal/user-tokens/${revoked.token.id}/revoke`, 'POST');
    expect(await verified(revoked.plaintext)).toEqual({ found: false });

    const expired = await mint({ name: 'expired' });
    expire(expired.token.id);
    expect(await verified(expired.plaintext)).toEqual({ found: false });

    const deletedActor = spec.createActor('human', 'gone', '4001').id;
    const ofDeleted = await mint({ actorId: deletedActor });
    store.raw.exec('PRAGMA foreign_keys = OFF');
    store.raw.prepare('DELETE FROM actors WHERE id = ?').run(deletedActor);
    store.raw.exec('PRAGMA foreign_keys = ON');
    expect(await verified(ofDeleted.plaintext)).toEqual({ found: false });

    const turned = spec.createActor('human', 'turned', '4002').id;
    const ofTurned = await mint({ actorId: turned });
    store.raw.prepare(`UPDATE actors SET type = 'agent' WHERE id = ?`).run(turned);
    expect(await verified(ofTurned.plaintext)).toEqual({ found: false });
    store.raw.prepare(`UPDATE actors SET type = 'human', github_user_id = NULL WHERE id = ?`).run(turned);
    expect(await verified(ofTurned.plaintext)).toEqual({ found: false });

    const svcLater = spec.createActor('human', 'svc-later', '4003').id;
    const ofSvc = await mint({ actorId: svcLater });
    store.raw.exec(`INSERT OR IGNORE INTO organizations (id, name, type, created_at) VALUES ('beehive-system', 'beehive-system', 'artifacts', 0)`);
    store.raw
      .prepare(
        `INSERT INTO service_accounts (id, name, organization_id, token_hash, token_salt, scopes, created_by, created_at, is_active, actor_id)
         VALUES ('sa', 'sa', 'beehive-system', '', '', 'read', ?, 0, 1, ?)`
      )
      .run(maint, svcLater);
    expect(await verified(ofSvc.plaintext)).toEqual({ found: false });
  });

  it('a non-hash body (plaintext, missing, uppercase) is a 400, never found', async () => {
    const { plaintext, hash } = await mint();
    expect((await verify(plaintext)).status).toBe(400);
    expect((await verify(hash.toUpperCase())).status).toBe(400);
    expect((await call('/internal/user-tokens/verify', 'POST', {})).status).toBe(400);
    expect((await call('/internal/user-tokens/verify', 'POST', 'x')).status).toBe(400);
  });

  it('a service-token hash is not a user token, and a user-token hash is not a service token', async () => {
    const { hash } = await mint();
    expect((await call('/internal/service-tokens/verify', 'POST', { tokenHash: hash })).status).toBe(404);
    expect(await data(await verify(await hashToken(generateServiceToken())))).toEqual({ found: false });
  });

  it('keeps the maintainer scope after a demotion; isMaintainer reads the role live (S6)', async () => {
    const org = spec.createOrganization('acme', 'artifacts');
    const repo = spec.createRepository('r', org.id, 'baseline', undefined, undefined, 'https://example.invalid/r.git', 'ns');
    const issue = spec.createIssue(undefined, repo.id, 'bug', 'body', alice);
    const { plaintext } = await mint({ actorId: maint, scope: 'maintainer' });
    const patch = () => call(`/api/issues/${issue.id}/comment-policy`, 'PATCH', { commentPolicy: 'locked' }, maint);
    expect((await patch()).status).toBe(200);
    store.raw.prepare(`UPDATE actors SET role = NULL WHERE id = ?`).run(maint);
    expect((await verified(plaintext)).scope).toBe('maintainer');
    expect((await patch()).status).toBe(403);
  });
});

describe('revoke', () => {
  it('is idempotent: 200 twice, the first revoked_at and revoked_by are kept (S8), and verify then fails (S10)', async () => {
    const { plaintext, token } = await mint();
    const first = await call(`/internal/user-tokens/${token.id}/revoke`, 'POST', undefined, maint);
    expect(first.status).toBe(200);
    const firstRow = store.raw.prepare('SELECT revoked_at, revoked_by FROM user_tokens').get() as any;
    expect(firstRow.revoked_by).toBe(maint);
    expect(firstRow.revoked_at).toBeGreaterThan(0);
    expect(await verified(plaintext)).toEqual({ found: false });

    const second = await call(`/internal/user-tokens/${token.id}/revoke`, 'POST', undefined, alice);
    expect(second.status).toBe(200);
    expect(store.raw.prepare('SELECT revoked_at, revoked_by FROM user_tokens').get()).toEqual(firstRow);
    expect((await data(second)).token.revokedBy).toBe(maint);
  });

  it('without X-Actor-ID is attributed to the reserved master actor', async () => {
    const { token } = await mint();
    expect((await call(`/internal/user-tokens/${token.id}/revoke`, 'POST')).status).toBe(200);
    expect((store.raw.prepare('SELECT revoked_by FROM user_tokens').get() as any).revoked_by).toBe('master');
  });

  it("with { actorId }, another actor's token and an unknown id are the same 404 (S4)", async () => {
    const { token } = await mint({ actorId: maint });
    const other = await call(`/internal/user-tokens/${token.id}/revoke`, 'POST', { actorId: alice }, alice);
    const unknown = await call('/internal/user-tokens/no-such-token/revoke', 'POST', { actorId: alice }, alice);
    expect(other.status).toBe(404);
    expect(unknown.status).toBe(404);
    const strip = async (r: Response) => ({ ...((await r.json()) as any), timestamp: 0 });
    expect(await strip(other)).toEqual(await strip(unknown));
    expect(count('SELECT COUNT(*) AS n FROM user_tokens WHERE revoked_at IS NOT NULL')).toBe(0);
    // Its owner can
    expect((await call(`/internal/user-tokens/${token.id}/revoke`, 'POST', { actorId: maint }, maint)).status).toBe(200);
  });

  it('a malformed body is 400', async () => {
    const { token } = await mint();
    expect((await call(`/internal/user-tokens/${token.id}/revoke`, 'POST', [])).status).toBe(400);
    expect((await call(`/internal/user-tokens/${token.id}/revoke`, 'POST', { actorId: 5 })).status).toBe(400);
    expect(count('SELECT COUNT(*) AS n FROM user_tokens WHERE revoked_at IS NOT NULL')).toBe(0);
  });
});

describe('revoke-all', () => {
  it("revokes every live token of that actor only, keeps earlier revocations, and counts what it revoked (S8)", async () => {
    const a1 = await mint({ name: 'a1' });
    const a2 = await mint({ name: 'a2' });
    const a3 = await mint({ name: 'a3' });
    const m1 = await mint({ actorId: maint, name: 'm1' });
    await call(`/internal/user-tokens/${a3.token.id}/revoke`, 'POST', undefined, alice);
    const a3Row = store.raw.prepare('SELECT revoked_at, revoked_by FROM user_tokens WHERE id = ?').get(a3.token.id);

    const res = await call('/internal/user-tokens/revoke-all', 'POST', { actorId: alice }, maint);
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual({ revoked: 2 });
    for (const t of [a1, a2]) expect(await verified(t.plaintext)).toEqual({ found: false });
    expect(store.raw.prepare('SELECT revoked_at, revoked_by FROM user_tokens WHERE id = ?').get(a3.token.id)).toEqual(a3Row);
    expect((await verified(m1.plaintext)).found).toBe(true);
    expect(count('SELECT COUNT(*) AS n FROM user_tokens WHERE revoked_by = ?', maint)).toBe(2);

    expect(await data(await call('/internal/user-tokens/revoke-all', 'POST', { actorId: alice }))).toEqual({ revoked: 0 });
  });

  it('an unknown actor is 404 and a missing actorId 400', async () => {
    expect((await call('/internal/user-tokens/revoke-all', 'POST', { actorId: 'nope' })).status).toBe(404);
    expect((await call('/internal/user-tokens/revoke-all', 'POST', {})).status).toBe(400);
  });
});

describe('list', () => {
  it('lists all, or one actor, newest first, including revoked, never with the hash', async () => {
    const t1 = await mint({ name: 'one' });
    store.raw.prepare('UPDATE user_tokens SET created_at = created_at - 1000').run();
    const t2 = await mint({ name: 'two' });
    await mint({ actorId: maint, name: 'theirs' });
    await call(`/internal/user-tokens/${t1.token.id}/revoke`, 'POST');

    const mine = await data<any[]>(await call(`/internal/user-tokens?actorId=${alice}`));
    expect(mine.map((t) => t.name)).toEqual(['two', 'one']);
    expect(mine[1].revokedAt).not.toBeNull();
    expect(mine[0].id).toBe(t2.token.id);
    const all = await data<any[]>(await call('/internal/user-tokens'));
    expect(all).toHaveLength(3);
    const text = JSON.stringify(all);
    expect(text).not.toContain('token_hash');
    expect(text).not.toContain(t1.hash);
    expect(text).not.toContain(t2.hash);
    expect(await data(await call('/internal/user-tokens?actorId=nobody'))).toEqual([]);
  });
});

describe('never logs a token or its hash (S3)', () => {
  it('mint, verify (good and bad), revoke and revoke-all write neither to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const { plaintext, hash, token } = await mint();
    await verify(hash);
    const bad = generateUserToken();
    await verify(await hashToken(bad));
    await verify(plaintext);
    await mint({ plaintext });
    await call(`/internal/user-tokens/${token.id}/revoke`, 'POST');
    await call('/internal/user-tokens/revoke-all', 'POST', { actorId: alice });
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    for (const secret of [plaintext, hash, bad, await hashToken(bad), plaintext.slice(12)]) expect(logged).not.toContain(secret);
  });
});
