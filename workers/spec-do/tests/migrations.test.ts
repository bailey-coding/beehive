/**
 * SpecDO init and runMigrations: a failing step fails init() loudly (no half-migrated
 * schema served, next request retries), a populated m3 ledger reaches m11 with its rows,
 * a rerun is a no-op, a fresh ledger starts at m11, and m8 -> m9 (user_tokens) keeps rows.
 *
 * Task: review-fixes | Spec: AGENTS.md#state-management
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeSqliteState, makeSpecDo, type SqliteState } from './sqlite-state';
import { LATEST_VERSION } from './legacy-ledger';

const version = (s: SqliteState) =>
  (s.raw.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as { value: string }).value;
const count = (s: SqliteState, table: string) =>
  (s.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const tables = (s: SqliteState) =>
  (s.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);

/** Seed a populated ledger, then strip everything m4..m11 added, leaving an m3 shape */
async function populatedM3(): Promise<SqliteState> {
  const fresh = makeSqliteState();
  const spec = makeSpecDo(fresh);
  await spec.init();
  const actor = spec.createActor('human', 'maint').id;
  const org = spec.createOrganization('org', 'artifacts');
  const repo = spec.createRepository('repo', org.id, 'baseline', undefined, undefined, 'https://example.invalid/r.git', 'ns');
  const s = spec.createSpec('spec', 'd', 'contract', [], org.id, actor);
  spec.createCandidate(s.id, repo.id, 'sha', 'base', actor);
  fresh.raw
    .prepare(
      `INSERT INTO service_accounts (id, name, organization_id, token_hash, token_salt, scopes, created_by, created_at, is_active)
       VALUES ('legacy', 'legacy', ?, 'abc', 'salt', 'read', ?, 0, 1)`
    )
    .run(org.id, actor);

  const raw = fresh.raw;
  for (const t of ['canary_metrics', 'user_tokens', 'canary_deployments', 'deploy_refs', 'service_tokens', 'promotion_states', 'tournaments', 'merge_trains', 'purge_log']) {
    raw.exec(`DROP TABLE ${t}`);
  }
  raw.exec('DROP INDEX idx_service_accounts_actor');
  raw.exec('DROP INDEX idx_service_accounts_name');
  raw.exec('PRAGMA foreign_keys = OFF');
  raw.exec('ALTER TABLE service_accounts DROP COLUMN actor_id');
  raw.exec('PRAGMA foreign_keys = ON');
  for (const t of ['organizations', 'repositories', 'specs', 'candidates', 'issues']) {
    raw.exec(`DROP INDEX idx_${t}_deleted`);
    for (const c of ['deleted_at', 'deleted_by', 'delete_reason']) raw.exec(`ALTER TABLE ${t} DROP COLUMN ${c}`);
  }
  raw.exec('ALTER TABLE actors DROP COLUMN role');
  raw.exec("UPDATE metadata SET value = 'm3' WHERE key = 'schema_version'");
  return fresh;
}

afterEach(() => vi.restoreAllMocks());

describe('fresh ledger', () => {
  it('starts at m11 on the first init, not m3, with user_tokens', async () => {
    const s = makeSqliteState();
    await makeSpecDo(s).init();
    expect(version(s)).toBe(LATEST_VERSION);
    expect(tables(s)).toContain('user_tokens');
  });
});

describe('m8 -> m9 (user_tokens)', () => {
  it('adds user_tokens and its two indexes to a populated m8 ledger, keeps every row, and is idempotent', async () => {
    const first = makeSqliteState();
    const spec = makeSpecDo(first);
    await spec.init();
    const actor = spec.createActor('human', 'alice', '4242').id;
    const org = spec.createOrganization('org', 'artifacts');
    const repo = spec.createRepository('repo', org.id, 'baseline', undefined, undefined, 'https://example.invalid/r.git', 'ns');
    spec.createIssue(1, repo.id, 'bug', 'body', actor);
    first.raw.exec('DROP TABLE user_tokens');
    first.raw.exec("UPDATE metadata SET value = 'm8' WHERE key = 'schema_version'");
    const before = Object.fromEntries(['actors', 'organizations', 'repositories', 'issues'].map((t) => [t, count(first, t)]));
    const actorsSql = () => first.raw.prepare("SELECT sql FROM sqlite_master WHERE tbl_name = 'actors' ORDER BY name").all();
    const actorsBefore = JSON.stringify(actorsSql());

    const restarted = makeSqliteState(first.raw, first.kv);
    await makeSpecDo(restarted).init();
    expect(version(restarted)).toBe(LATEST_VERSION);
    expect(tables(restarted)).toContain('user_tokens');
    const indexes = (first.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'user_tokens'").all() as { name: string }[])
      .map((r) => r.name)
      .filter((n) => !n.startsWith('sqlite_autoindex'))
      .sort();
    expect(indexes).toEqual(['idx_user_tokens_actor', 'idx_user_tokens_hash']);
    for (const [t, n] of Object.entries(before)) expect(count(restarted, t)).toBe(n);
    // No index on actors and no change to its definition
    expect(JSON.stringify(actorsSql())).toBe(actorsBefore);

    const snapshot = () => JSON.stringify(first.raw.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all());
    const schemaBefore = snapshot();
    await makeSpecDo(makeSqliteState(first.raw, first.kv)).init();
    expect(version(restarted)).toBe(LATEST_VERSION);
    expect(snapshot()).toBe(schemaBefore);
  });

  it('a fresh m9 ledger and a migrated one build the same user_tokens', async () => {
    const fresh = makeSqliteState();
    await makeSpecDo(fresh).init();
    const migrated = makeSqliteState();
    await makeSpecDo(migrated).init();
    migrated.raw.exec('DROP TABLE user_tokens');
    migrated.raw.exec("UPDATE metadata SET value = 'm8' WHERE key = 'schema_version'");
    await makeSpecDo(makeSqliteState(migrated.raw, migrated.kv)).init();
    const ddl = (s: SqliteState) =>
      JSON.stringify(s.raw.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'user_tokens' ORDER BY name").all());
    expect(ddl(migrated)).toBe(ddl(fresh));
  });
});

describe('service_accounts of another design (seen on the live ledger, 2026-10-16)', () => {
  const LEGACY = `CREATE TABLE service_accounts (
    id TEXT PRIMARY KEY, actor_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL,
    organization_id TEXT, description TEXT, created_at INTEGER NOT NULL, created_by TEXT NOT NULL,
    revoked_at INTEGER, FOREIGN KEY (actor_id) REFERENCES actors(id), FOREIGN KEY (organization_id) REFERENCES organizations(id))`;

  it('stops m6 with a message naming the table and the way out; dropping the empty table lets it finish', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const old = await populatedM3();
    old.raw.exec('DROP TABLE service_accounts');
    old.raw.exec(LEGACY);
    const restarted = makeSqliteState(old.raw, old.kv);
    const spec = makeSpecDo(restarted);

    await expect(spec.init()).rejects.toThrow(/service_accounts has an unexpected shape.*missing: token_hash, token_salt, is_active/s);
    // m4 and m5 are additive and committed; m6 did not advance, and nothing was dropped
    expect(version(restarted)).toBe('m5');
    expect(tables(restarted)).toContain('service_accounts');

    restarted.raw.exec('DROP TABLE service_accounts');
    await spec.init();
    expect(version(restarted)).toBe(LATEST_VERSION);
    expect(tables(restarted)).toContain('service_tokens');
  });
});

describe('failing migration step', () => {
  it('makes init() throw, leaves db unset, and a retry succeeds once the cause is removed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const old = await populatedM3();
    const restarted = makeSqliteState(old.raw, old.kv);
    // Force the m7 step to fail: the adapter's exec throws on the deploy_refs DDL while `broken`
    let broken = true;
    const realExec = (restarted.state as any).storage.sql.exec;
    (restarted.state as any).storage.sql.exec = (query: string, ...b: unknown[]) => {
      if (broken && /CREATE TABLE IF NOT EXISTS deploy_refs/.test(query)) throw new Error('simulated DDL failure');
      return realExec(query, ...b);
    };
    const spec = makeSpecDo(restarted);

    await expect(spec.init()).rejects.toThrow('simulated DDL failure');
    expect(spec.db).toBeNull();
    // Earlier steps committed their own version; the failed step did not advance it
    expect(version(restarted)).toBe('m6');
    expect(tables(restarted)).not.toContain('deploy_refs');
    // Requests fail visibly while broken (fetch re-runs init because db is unset)
    await expect(spec.fetch(new Request('https://spec-do.internal/organizations'))).rejects.toThrow('simulated DDL failure');

    broken = false;
    await spec.init();
    expect(spec.db).not.toBeNull();
    expect(version(restarted)).toBe(LATEST_VERSION);
    expect(tables(restarted)).toContain('deploy_refs');
  });
});

describe('m3 -> m11 on a populated ledger', () => {
  it('keeps every row, ends at m11, and a rerun is a no-op', async () => {
    const old = await populatedM3();
    const before = Object.fromEntries(
      ['organizations', 'actors', 'specs', 'candidates', 'service_accounts'].map((t) => [t, count(old, t)])
    );
    expect(version(old)).toBe('m3');
    expect(before.service_accounts).toBe(1);

    const restarted = makeSqliteState(old.raw, old.kv);
    await makeSpecDo(restarted).init();
    expect(version(restarted)).toBe(LATEST_VERSION);
    expect(tables(restarted)).toContain('user_tokens');
    for (const [t, n] of Object.entries(before)) expect(count(restarted, t)).toBe(n);
    expect(old.raw.prepare("SELECT actor_id, token_hash FROM service_accounts WHERE id = 'legacy'").get()).toEqual({
      actor_id: null,
      token_hash: 'abc',
    });

    // Rerun: no-op (same version row, no schema change)
    const snapshot = () =>
      JSON.stringify(old.raw.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all());
    const updatedAt = () => old.raw.prepare("SELECT updated_at FROM metadata WHERE key = 'schema_version'").get();
    const [schemaBefore, stampBefore] = [snapshot(), updatedAt()];
    await makeSpecDo(makeSqliteState(old.raw, old.kv)).init();
    expect(version(restarted)).toBe(LATEST_VERSION);
    expect(snapshot()).toBe(schemaBefore);
    expect(updatedAt()).toEqual(stampBefore);
    for (const [t, n] of Object.entries(before)) expect(count(restarted, t)).toBe(n);
  });
});

// ============================================================================
// Rollback floor (M12 T1, push A): this code over a ledger a newer deploy migrated
// ============================================================================

describe('a ledger newer than this code (m<N> above m11)', () => {
  const FUTURE_TABLE = `CREATE TABLE future_tokens (
    id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL,
    FOREIGN KEY (actor_id) REFERENCES actors(id))`;

  /** An m11 ledger with one actor, then a hypothetical later migration: an extra table that references actors, a higher version. */
  async function newerLedger(v: string): Promise<{ s: SqliteState; actorId: string }> {
    const first = makeSqliteState();
    const spec = makeSpecDo(first);
    await spec.init();
    const actorId = spec.createActor('human', 'alice', '4242').id;
    first.raw.exec(FUTURE_TABLE);
    first.raw.prepare("INSERT INTO future_tokens (id, actor_id, name, created_at) VALUES ('t1', ?, 'laptop', 1)").run(actorId);
    first.raw.prepare("UPDATE metadata SET value = ? WHERE key = 'schema_version'").run(v);
    return { s: makeSqliteState(first.raw, first.kv), actorId };
  }

  const call = (spec: ReturnType<typeof makeSpecDo>, path: string, method = 'GET', body?: unknown, actorId?: string) =>
    spec.fetch(
      new Request(`https://spec-do.internal${path}`, {
        method,
        headers: actorId ? { 'X-Actor-ID': actorId } : {},
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    );

  it.each(['m12', 'm13', 'm99', 'm100', 'm999999'])(
    'init() at %s warns once, runs no step, and leaves the version and the extra table alone',
    async (v) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { s } = await newerLedger(v);
      const snapshot = () => JSON.stringify(s.raw.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all());
      const stamp = () => s.raw.prepare("SELECT updated_at FROM metadata WHERE key = 'schema_version'").get();
      const [schemaBefore, stampBefore] = [snapshot(), stamp()];

      await makeSpecDo(s).init();

      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(`'${v}'`);
      expect(version(s)).toBe(v);
      expect(snapshot()).toBe(schemaBefore);
      expect(stamp()).toEqual(stampBefore);
      expect(count(s, 'future_tokens')).toBe(1);
    }
  );

  it('serves reads over an m99 ledger, including rows that reference the extra table', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { s, actorId } = await newerLedger('m99');
    const spec = makeSpecDo(s);
    // No init() call: the router initialises on the first request, as in production
    const actor = await call(spec, `/api/actors/${actorId}`);
    expect(actor.status).toBe(200);
    expect(((await actor.json()) as { data: { id: string } }).data.id).toBe(actorId);
    const list = await call(spec, '/api/actors?github_user_id=4242');
    expect(((await list.json()) as { data: unknown[] }).data).toHaveLength(1);
    expect((await call(spec, '/api/organizations')).status).toBe(200);
    expect((await call(spec, '/health')).status).toBe(200);
  });

  it('serves writes over an m99 ledger: an actor, an organization, an issue, a comment', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { s, actorId } = await newerLedger('m99');
    const spec = makeSpecDo(s);

    const bob = await call(spec, '/api/actors', 'POST', { type: 'human', name: 'bob', githubUserId: '7' });
    expect(bob.status).toBe(201);
    const bobId = ((await bob.json()) as { data: { id: string } }).data.id;

    await spec.init();
    const org = spec.createOrganization('acme', 'artifacts');
    const repo = spec.createRepository('r', org.id, 'baseline', undefined, undefined, 'https://example.invalid/r.git', 'ns');
    const issue = await call(spec, '/api/issues', 'POST', { repositoryId: repo.id, title: 'first' }, bobId);
    expect(issue.status).toBe(201);
    const issueId = ((await issue.json()) as { data: { id: string } }).data.id;
    const comment = await call(spec, `/api/issues/${issueId}/comments`, 'POST', { body: 'hello' }, actorId);
    expect(comment.status).toBe(201);

    expect(count(s, 'actors')).toBe(2);
    expect(count(s, 'issues')).toBe(1);
    expect(count(s, 'issue_comments')).toBe(1);
    // The extra table and its row are untouched, and its reference into actors still resolves
    expect(count(s, 'future_tokens')).toBe(1);
    expect(s.raw.prepare('SELECT COUNT(*) AS n FROM future_tokens t JOIN actors a ON a.id = t.actor_id').get()).toEqual({ n: 1 });
    expect(version(s)).toBe('m99');
  });

  it('an m11 ledger is unchanged: no warning, no step, still m11', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = makeSqliteState();
    await makeSpecDo(s).init();
    await makeSpecDo(makeSqliteState(s.raw, s.kv)).init();
    expect(version(s)).toBe(LATEST_VERSION);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['mx', 'm', 'm9a', 'x9', 'M9', '9', 'm-1', 'm1.5', 'm 9', 'm0', 'm08', 'm8x', '', 'm9\n', 'm09', 'm1000000', `m${'9'.repeat(400)}`])(
    'the unparseable or unknown version %j still fails closed, with no warning',
    async (v) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { s } = await newerLedger(v);
      const spec = makeSpecDo(s);
      await expect(spec.init()).rejects.toThrow(`Unknown schema_version '${v}'`);
      expect(spec.db).toBeNull();
      expect(warn).not.toHaveBeenCalled();
      expect(version(s)).toBe(v);
    }
  );
});
