/**
 * SpecDO service accounts and tokens (m5 -> m6): one actor per account, tokens
 * in service_tokens (SHA-256 hash + display prefix only), create / verify /
 * rotate / revoke / expire, lifecycle defence in depth, and the migration.
 * Real SQL (node:sqlite, FKs on) through the real router.
 *
 * Task: service-accounts | Spec: AGENTS.md#state-management
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach } from 'vitest';
import { SpecDO } from '../index';
import { SCHEMA_SQL, SERVICE_TOKENS_SQL, DEPLOY_REFS_SQL, LEDGER_CAS_SQL, USER_TOKENS_SQL, IDEMPOTENCY_KEYS_SQL, CANARY_METRICS_SQL } from '../schema-inline';
import { makeSqliteState, makeSpecDo, type SqliteState } from './sqlite-state';
import { LATEST_VERSION } from './legacy-ledger';
import { generateServiceToken, hashToken, tokenPrefix } from '../../shared/service-tokens';

let store: SqliteState;
let spec: SpecDO;

const DAY = 24 * 3_600_000;

function call(path: string, method = 'GET', body?: unknown, actorId?: string): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
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

async function tokenBody(plaintext = generateServiceToken(), expiresAt = Date.now() + 30 * DAY) {
  return { plaintext, tokenHash: await hashToken(plaintext), tokenPrefix: tokenPrefix(plaintext), expiresAt };
}

async function mint(name = 'monitor', actorId?: string, extra: Record<string, unknown> = {}) {
  const t = await tokenBody();
  const res = await call(
    '/internal/service-accounts',
    'POST',
    { name, scopes: ['read'], tokenHash: t.tokenHash, tokenPrefix: t.tokenPrefix, expiresAt: t.expiresAt, ...extra },
    actorId
  );
  return { res, plaintext: t.plaintext, hash: t.tokenHash, body: res.status === 201 ? await data(res) : await res.json() };
}

const verify = (tokenHash: string) => call('/internal/service-tokens/verify', 'POST', { tokenHash });
const count = (sql: string, ...params: string[]) => (store.raw.prepare(sql).get(...params) as { n: number }).n;

beforeEach(async () => {
  store = makeSqliteState();
  spec = makeSpecDo(store);
  await spec.init();
});

describe('create', () => {
  it('creates actor + account + first token in one transaction and returns { account, token }', async () => {
    const { res, plaintext, hash, body } = await mint();
    expect(res.status).toBe(201);
    const { account, token } = body;
    expect(account).toMatchObject({ name: 'monitor', scopes: ['read'], isActive: true, organizationId: 'beehive-system' });
    expect(token).toMatchObject({ prefix: plaintext.slice(0, 12), scopes: ['read'], revokedAt: null });
    expect(account.tokens).toEqual([token]);

    const actor = store.raw.prepare('SELECT * FROM actors WHERE id = ?').get(account.actorId) as any;
    expect(actor).toMatchObject({ type: 'agent', name: 'svc:monitor', promotion_authority: 0, role: null });
    const row = store.raw.prepare('SELECT * FROM service_accounts WHERE id = ?').get(account.id) as any;
    expect(row).toMatchObject({ actor_id: account.actorId, token_hash: '', token_salt: '', scopes: 'read', is_active: 1 });
    const tok = store.raw.prepare('SELECT * FROM service_tokens').all() as any[];
    expect(tok).toHaveLength(1);
    expect(tok[0]).toMatchObject({ account_id: account.id, token_hash: hash, token_prefix: plaintext.slice(0, 12), revoked_at: null });

    // Hash at rest only; no hash in the response
    const everything = JSON.stringify(store.raw.prepare('SELECT * FROM service_tokens, service_accounts, actors, entity_history').all());
    expect(everything).not.toContain(plaintext);
    expect(everything).not.toContain(plaintext.slice(12));
    expect(JSON.stringify(body)).not.toContain(hash);
    expect(JSON.stringify(body)).not.toContain('token_hash');
  });

  it('attributes to the X-Actor-ID actor, or to the reserved master actor without one', async () => {
    const alice = spec.createActor('human', 'alice').id;
    expect((await mint('a', alice)).body.account.createdBy).toBe(alice);
    expect((await mint('b')).body.account.createdBy).toBe('master');
    expect((await mint('c', 'unknown')).body.account.createdBy).toBe('master');
    expect(store.raw.prepare("SELECT type, promotion_authority, role FROM actors WHERE id = 'master'").get()).toEqual({
      type: 'human',
      promotion_authority: 0,
      role: null,
    });
  });

  it('ignores createdBy in the body: only the X-Actor-ID header counts', async () => {
    const alice = spec.createActor('human', 'alice').id;
    const { body } = await mint('x', undefined, { createdBy: alice });
    expect(body.account.createdBy).toBe('master');
  });

  it('refuses an unknown minting actor (400) and a service actor as minter (403)', async () => {
    expect((await mint('a', 'no-such-actor')).res.status).toBe(400);
    const { body } = await mint('first');
    const res = await mint('second', body.account.actorId);
    expect(res.res.status).toBe(403);
    expect(count('SELECT COUNT(*) AS n FROM service_accounts')).toBe(1);
  });

  it('validates input (defence in depth behind the edge)', async () => {
    const good = await tokenBody();
    const base = { name: 'ok', scopes: ['read'], tokenHash: good.tokenHash, tokenPrefix: good.tokenPrefix, expiresAt: good.expiresAt };
    const bad: Record<string, unknown>[] = [
      { scopes: ['read', 'write'] },
      { scopes: ['write'] },
      { scopes: 'read' },
      { name: 'Bad Name' },
      { name: '' },
      { tokenHash: good.plaintext }, // plaintext is never accepted as a hash
      { tokenHash: good.tokenHash.toUpperCase() },
      { tokenHash: '' },
      { tokenPrefix: good.plaintext },
      { expiresAt: Date.now() - 1000 },
      { expiresAt: Date.now() + 400 * DAY },
      { expiresAt: null },
      { description: 'x'.repeat(201) },
    ];
    for (const patch of bad) {
      const res = await call('/internal/service-accounts', 'POST', { ...base, ...patch });
      expect(res.status, JSON.stringify(patch)).toBe(400);
    }
    expect((await call('/internal/service-accounts', 'POST', 'nope')).status).toBe(400);
    expect(count('SELECT COUNT(*) AS n FROM service_accounts')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM service_tokens')).toBe(0);
  });

  it('duplicate name -> 409, also after revocation', async () => {
    const { body } = await mint();
    expect((await mint()).res.status).toBe(409);
    await call(`/internal/service-accounts/${body.account.id}/revoke`, 'POST');
    expect((await mint()).res.status).toBe(409);
  });

  it('rolls back actor and account when the token insert fails', async () => {
    const first = await mint('one');
    const actorsBefore = count('SELECT COUNT(*) AS n FROM actors');
    // Same hash under a new name: the unique hash index fails the token insert
    const res = await call('/internal/service-accounts', 'POST', {
      name: 'two',
      scopes: ['read'],
      tokenHash: first.hash,
      tokenPrefix: first.plaintext.slice(0, 12),
      expiresAt: Date.now() + DAY,
    });
    expect(res.status).toBe(500);
    expect(count("SELECT COUNT(*) AS n FROM service_accounts WHERE name = 'two'")).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM actors')).toBe(actorsBefore);
  });

  it('refuses a tombstoned organization', async () => {
    const org = spec.createOrganization('gone', 'artifacts');
    store.raw.prepare('UPDATE organizations SET deleted_at = ? WHERE id = ?').run(Date.now(), org.id);
    expect((await mint('x', undefined, { organizationId: org.id })).res.status).toBe(409);
    expect((await mint('y', undefined, { organizationId: 'no-such-org' })).res.status).toBe(400);
  });
});

describe('verify', () => {
  it('returns a service principal by hash lookup and records last_used_at (throttled)', async () => {
    const { hash, body } = await mint();
    const res = await verify(hash);
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual({
      kind: 'service',
      actorId: body.account.actorId,
      serviceAccountId: body.account.id,
      tokenId: body.token.id,
      scopes: ['read'],
      organizationId: 'beehive-system',
      promotionAuthority: false,
    });
    const used = (store.raw.prepare('SELECT last_used_at FROM service_tokens').get() as any).last_used_at;
    expect(used).toBeGreaterThan(0);
    expect((store.raw.prepare('SELECT last_used_at FROM service_accounts').get() as any).last_used_at).toBe(used);

    // Within a minute: no second write
    store.raw.prepare('UPDATE service_tokens SET last_used_at = ?').run(used - 1);
    await verify(hash);
    expect((store.raw.prepare('SELECT last_used_at FROM service_tokens').get() as any).last_used_at).toBe(used - 1);
  });

  it('unknown hash -> 404; non-hash input (e.g. plaintext) -> 400', async () => {
    const { plaintext } = await mint();
    expect((await verify(await hashToken(generateServiceToken()))).status).toBe(404);
    expect((await verify(plaintext)).status).toBe(400);
    expect((await call('/internal/service-tokens/verify', 'POST', {})).status).toBe(400);
  });

  it('expired token -> 404', async () => {
    const { hash } = await mint();
    store.raw.prepare('UPDATE service_tokens SET expires_at = ?').run(Date.now() - 1);
    expect((await verify(hash)).status).toBe(404);
  });

  it('inactive account -> 404 even if its token row is not revoked', async () => {
    const { hash } = await mint();
    store.raw.prepare('UPDATE service_accounts SET is_active = 0').run();
    expect((await verify(hash)).status).toBe(404);
  });

  it('account in a tombstoned organization -> 404', async () => {
    const { hash } = await mint();
    store.raw.prepare("UPDATE organizations SET deleted_at = ? WHERE id = 'beehive-system'").run(Date.now());
    expect((await verify(hash)).status).toBe(404);
  });

  it('a pre-m6 account (no actor_id, hash on the account row) never authenticates', async () => {
    const hash = await hashToken(generateServiceToken());
    store.raw.prepare("INSERT OR IGNORE INTO organizations (id, name, type, created_at) VALUES ('o', 'o', 'github', 0)").run();
    store.raw.prepare("INSERT INTO actors (id, type, name, created_at) VALUES ('h', 'human', 'h', 0)").run();
    store.raw
      .prepare(
        `INSERT INTO service_accounts (id, name, organization_id, token_hash, token_salt, scopes, created_by, created_at, is_active)
         VALUES ('legacy', 'legacy', 'o', ?, 'salt', 'read_write', 'h', 0, 1)`
      )
      .run(hash);
    expect((await verify(hash)).status).toBe(404);
    const list = await data<any[]>(await call('/internal/service-accounts'));
    expect(list.find((a) => a.id === 'legacy')).toMatchObject({ actorId: null, tokens: [], scopes: ['read', 'write'] });
    // Cannot be "upgraded" by minting a token onto it
    const t = await tokenBody();
    expect((await call('/internal/service-accounts/legacy/tokens', 'POST', t)).status).toBe(409);
    // But it can be revoked
    expect((await call('/internal/service-accounts/legacy/revoke', 'POST')).status).toBe(200);
  });

  it('missing service_tokens table -> 500 (the edge maps this to 503)', async () => {
    const { hash } = await mint();
    store.raw.exec('DROP TABLE service_tokens');
    expect((await verify(hash)).status).toBe(500);
  });
});

describe('rotate and revoke', () => {
  it('a second token works alongside the first; revoking one leaves the other', async () => {
    const first = await mint();
    const id = first.body.account.id;
    const t2 = await tokenBody();
    const res = await call(`/internal/service-accounts/${id}/tokens`, 'POST', t2);
    expect(res.status).toBe(201);
    const { token } = await data(res);
    expect(token.prefix).toBe(t2.plaintext.slice(0, 12));
    expect((await verify(t2.tokenHash)).status).toBe(200);

    expect((await call(`/internal/service-accounts/${id}/tokens/${first.body.token.id}/revoke`, 'POST')).status).toBe(200);
    expect((await call(`/internal/service-accounts/${id}/tokens/${first.body.token.id}/revoke`, 'POST')).status).toBe(200);
    expect((await verify(first.hash)).status).toBe(404);
    expect((await verify(t2.tokenHash)).status).toBe(200);
  });

  it('token revoke needs the matching account; unknown -> 404', async () => {
    const a = await mint('a');
    const b = await mint('b');
    expect((await call(`/internal/service-accounts/${b.body.account.id}/tokens/${a.body.token.id}/revoke`, 'POST')).status).toBe(404);
    expect((await call(`/internal/service-accounts/nope/tokens/nope/revoke`, 'POST')).status).toBe(404);
    expect((await verify(a.hash)).status).toBe(200);
  });

  it('account revoke deactivates the account, revokes every token, is idempotent, and is audited', async () => {
    const alice = spec.createActor('human', 'alice').id;
    const first = await mint();
    const id = first.body.account.id;
    const t2 = await tokenBody();
    await call(`/internal/service-accounts/${id}/tokens`, 'POST', t2);
    expect((await call(`/internal/service-accounts/${id}/revoke`, 'POST', undefined, alice)).status).toBe(200);
    expect((await call(`/internal/service-accounts/${id}/revoke`, 'POST', undefined, alice)).status).toBe(200);
    expect((await verify(first.hash)).status).toBe(404);
    expect((await verify(t2.tokenHash)).status).toBe(404);
    expect(count('SELECT COUNT(*) AS n FROM service_tokens WHERE revoked_at IS NULL')).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM entity_history WHERE stage = 'revoked' AND changed_by = ?", alice)).toBe(1);
    // A revoked account gets no new tokens
    expect((await call(`/internal/service-accounts/${id}/tokens`, 'POST', await tokenBody())).status).toBe(409);
    expect((await call('/internal/service-accounts/nope/revoke', 'POST')).status).toBe(404);
  });

  it('rotation validates like create and 404s an unknown account', async () => {
    const { body } = await mint();
    const t = await tokenBody();
    expect((await call(`/internal/service-accounts/${body.account.id}/tokens`, 'POST', { ...t, tokenHash: t.plaintext })).status).toBe(400);
    expect((await call(`/internal/service-accounts/${body.account.id}/tokens`, 'POST', { ...t, expiresAt: 1 })).status).toBe(400);
    expect((await call('/internal/service-accounts/nope/tokens', 'POST', t)).status).toBe(404);
  });

  it('list never exposes token_hash or token_salt', async () => {
    const { hash } = await mint();
    const text = await (await call('/internal/service-accounts')).text();
    expect(text).not.toContain(hash);
    expect(text).not.toContain('token_hash');
    expect(text).not.toContain('token_salt');
    expect(text).not.toContain('tokenHash');
  });
});

describe('service actors and the ledger lifecycle (defence in depth)', () => {
  let svc: string;
  let maintainer: string;
  beforeEach(async () => {
    svc = (await mint()).body.account.actorId;
    maintainer = spec.createActor('human', 'maint').id;
    store.raw.prepare(`UPDATE actors SET role = 'maintainer' WHERE id = ?`).run(maintainer);
  });

  it('tombstone, purge and role change with a service actor -> 403', async () => {
    const org = spec.createOrganization('o', 'artifacts');
    for (const [path, body] of [
      ['/internal/tombstone', { entityType: 'organization', id: org.id }],
      ['/internal/purge', { orgIds: [org.id], dryRun: true }],
      [`/internal/actors/${svc}/role`, { role: 'maintainer' }],
      [`/internal/actors/${maintainer}/role`, { role: null }],
    ] as const) {
      const res = await call(path, 'POST', body, svc);
      expect(res.status, path).toBe(403);
    }
    expect(count('SELECT COUNT(*) AS n FROM organizations WHERE id = ? AND deleted_at IS NULL', org.id)).toBe(1);
  });

  it('a maintainer cannot grant a role to a service actor', async () => {
    const res = await call(`/internal/actors/${svc}/role`, 'POST', { role: 'maintainer' }, maintainer);
    expect(res.status).toBe(403);
    expect(store.raw.prepare('SELECT role FROM actors WHERE id = ?').get(svc)).toEqual({ role: null });
  });

  it('a service actor with a role set out of band is still not a maintainer', async () => {
    store.raw.prepare(`UPDATE actors SET role = 'maintainer' WHERE id = ?`).run(svc);
    expect(spec.isMaintainer(svc, false)).toBe(false);
    expect((await call('/api/organizations?include_deleted=1', 'GET', undefined, svc)).status).toBe(403);
    expect(spec.isMaintainer(maintainer, false)).toBe(true);
  });
});

describe('m5 -> m6 migration', () => {
  const columns = (s: SqliteState, table: string) =>
    (s.raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  const version = (s: SqliteState) =>
    (s.raw.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as { value: string }).value;

  it('a fresh ledger has actor_id and service_tokens before its first request', () => {
    expect(columns(store, 'service_accounts')).toContain('actor_id');
    expect(columns(store, 'service_tokens')).toEqual(
      expect.arrayContaining(['account_id', 'token_hash', 'token_prefix', 'expires_at', 'revoked_at', 'last_used_at'])
    );
  });

  it('adds actor_id and service_tokens to an m5 ledger, keeps legacy rows, and is idempotent', async () => {
    // An m5 ledger: service_accounts without actor_id, no service_tokens, one legacy account
    const raw = makeSqliteState().raw;
    const fresh = makeSqliteState(raw);
    const old = makeSpecDo(fresh);
    await old.init();
    raw.exec('DROP TABLE service_tokens');
    raw.exec('DROP INDEX idx_service_accounts_actor');
    raw.exec('DROP INDEX idx_service_accounts_name');
    raw.exec('PRAGMA foreign_keys = OFF');
    raw.exec('ALTER TABLE service_accounts DROP COLUMN actor_id');
    raw.exec('PRAGMA foreign_keys = ON');
    expect(columns(fresh, 'service_accounts')).not.toContain('actor_id');
    const org = old.createOrganization('existing-org', 'github');
    const human = old.createActor('human', 'h').id;
    raw
      .prepare(
        `INSERT INTO service_accounts (id, name, organization_id, token_hash, token_salt, scopes, created_by, created_at, is_active)
         VALUES ('legacy', 'legacy', ?, 'abc', 'salt', 'read', ?, 0, 1)`
      )
      .run(org.id, human);
    raw.exec("UPDATE metadata SET value = 'm5' WHERE key = 'schema_version'");

    const restarted = makeSqliteState(raw, fresh.kv);
    spec = makeSpecDo(restarted);
    store = restarted;
    await spec.init();
    expect(version(restarted)).toBe(LATEST_VERSION);
    expect(columns(restarted, 'service_accounts')).toContain('actor_id');
    expect(columns(restarted, 'service_tokens').length).toBeGreaterThan(0);
    expect(raw.prepare("SELECT actor_id, token_hash FROM service_accounts WHERE id = 'legacy'").get()).toEqual({
      actor_id: null,
      token_hash: 'abc',
    });
    // New accounts work on the migrated ledger
    const { hash } = await mint('after-migration');
    expect((await verify(hash)).status).toBe(200);

    await makeSpecDo(makeSqliteState(raw, fresh.kv)).init();
    expect(version(restarted)).toBe(LATEST_VERSION);
    expect(count("SELECT COUNT(*) AS n FROM service_accounts WHERE name = 'after-migration'")).toBe(1);
  });

  it('schema.sql and schema-inline.ts agree byte for byte', () => {
    const file = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
    expect(file.startsWith(SCHEMA_SQL)).toBe(true);
    // m11 (canary metrics) is the last section, after m10 (idempotency keys), after m9 (user tokens), m8 (ledger versions), m7 (deploy refs) and m6
    expect(file.endsWith(SERVICE_TOKENS_SQL + DEPLOY_REFS_SQL + LEDGER_CAS_SQL + USER_TOKENS_SQL + IDEMPOTENCY_KEYS_SQL + CANARY_METRICS_SQL)).toBe(true);
  });
});
