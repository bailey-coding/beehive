/**
 * SpecDO init and runMigrations: a failing step fails init() loudly (no half-migrated
 * schema served, next request retries), a populated m3 ledger reaches m7 with its rows,
 * a rerun is a no-op, and a fresh ledger starts at m8.
 *
 * Task: review-fixes | Spec: AGENTS.md#state-management
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeSqliteState, makeSpecDo, type SqliteState } from './sqlite-state';

const version = (s: SqliteState) =>
  (s.raw.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as { value: string }).value;
const count = (s: SqliteState, table: string) =>
  (s.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const tables = (s: SqliteState) =>
  (s.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);

/** Seed a populated ledger, then strip everything m4..m7 added, leaving an m3 shape */
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
  for (const t of ['canary_deployments', 'deploy_refs', 'service_tokens', 'promotion_states', 'tournaments', 'merge_trains', 'purge_log']) {
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
  it('starts at m8 on the first init, not m3', async () => {
    const s = makeSqliteState();
    await makeSpecDo(s).init();
    expect(version(s)).toBe('m8');
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
    expect(version(restarted)).toBe('m8');
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
    expect(version(restarted)).toBe('m8');
    expect(tables(restarted)).toContain('deploy_refs');
  });
});

describe('m3 -> m8 on a populated ledger', () => {
  it('keeps every row, ends at m8, and a rerun is a no-op', async () => {
    const old = await populatedM3();
    const before = Object.fromEntries(
      ['organizations', 'actors', 'specs', 'candidates', 'service_accounts'].map((t) => [t, count(old, t)])
    );
    expect(version(old)).toBe('m3');
    expect(before.service_accounts).toBe(1);

    const restarted = makeSqliteState(old.raw, old.kv);
    await makeSpecDo(restarted).init();
    expect(version(restarted)).toBe('m8');
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
    expect(version(restarted)).toBe('m8');
    expect(snapshot()).toBe(schemaBefore);
    expect(updatedAt()).toEqual(stampBefore);
    for (const [t, n] of Object.entries(before)) expect(count(restarted, t)).toBe(n);
  });
});
