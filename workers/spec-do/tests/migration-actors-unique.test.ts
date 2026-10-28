/**
 * migration m12: partial UNIQUE index on actors.github_user_id (WHERE NOT NULL AND != '').
 *
 * Decision (maintainer, 2026-10-26, approved 2026-10-27): on duplicates the step REFUSES with a named error
 * (DuplicateGithubIdentityError) that lists the duplicated values and actor ids; it never skips the index,
 * never deletes, never merges. The check runs before the index is created, so a refusal leaves the ledger at
 * m11 with every row intact, and init() rethrows (a full outage until a human resolves it: docs/OPS.md).
 *
 * Plan: docs/MIGRATION-LEGACY-TEST-PLAN.md section 6. Names carry "migration" so the CI job picks them up.
 *
 * Task: m12-actors-unique | Spec: docs/MIGRATION-LEGACY-TEST-PLAN.md#6
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { SpecDO, DuplicateGithubIdentityError } from '../index';
import { makeSqliteState, makeSpecDo, type SqliteState } from './sqlite-state';
import { loadLegacyLedger, readVersion, freshLedger, LATEST_VERSION } from './legacy-ledger';
import { legacyFixtures } from './fixtures/legacy';

type Row = Record<string, unknown>;
const INDEX = 'idx_actors_github_user_id_unique';
const all = (s: SqliteState, sql: string) => s.raw.prepare(sql).all() as Row[];
const hasIndex = (s: SqliteState) => all(s, `SELECT name FROM sqlite_master WHERE type = 'index' AND name = '${INDEX}'`).length === 1;
// the columns every shape has: earlier steps (m5 adds actors.role) may append others before m12 refuses
const actorRows = (s: SqliteState) => all(s, 'SELECT id, type, name, github_user_id, created_at FROM actors ORDER BY id').map((r) => JSON.stringify(r));
const objects = (s: SqliteState) => JSON.stringify(all(s, 'SELECT type, name, sql FROM sqlite_master ORDER BY type, name'));
const dbOf = (spec: SpecDO) => (spec as unknown as { db: unknown }).db;

afterEach(() => vi.restoreAllMocks());

function insertActor(s: SqliteState, id: string, githubUserId: string | null, name = id): void {
  s.raw
    .prepare("INSERT INTO actors (id, type, name, github_user_id, created_at) VALUES (?, 'human', ?, ?, 1)")
    .run(id, name, githubUserId);
}

/** An m11 ledger: today's schema minus the m12 index, at version m11 (the state production is in before this deploy) */
async function m11Ledger(): Promise<SqliteState> {
  const s = await freshLedger();
  s.raw.exec(`DROP INDEX ${INDEX}`);
  s.raw.prepare("UPDATE metadata SET value = 'm11' WHERE key = 'schema_version'").run();
  return makeSqliteState(s.raw, s.kv);
}

describe('migration m12: unique index on actors.github_user_id', () => {
  it('the latest version is m12 and a fresh ledger has the partial index and starts there', async () => {
    expect(Number(LATEST_VERSION.slice(1))).toBeGreaterThanOrEqual(12); // m12 shipped; later steps move LATEST_VERSION on
    const fresh = await freshLedger();
    expect(readVersion(fresh)).toBe(LATEST_VERSION);
    expect(hasIndex(fresh)).toBe(true);
    const sql = all(fresh, `SELECT sql FROM sqlite_master WHERE name = '${INDEX}'`)[0].sql as string;
    expect(sql).toMatch(/CREATE UNIQUE INDEX/);
    expect(sql).toMatch(/WHERE github_user_id IS NOT NULL AND github_user_id != ''/);
  });

  it('clean ledger with many NULL and empty-string github_user_id values: creates the index, rows kept, rerun is a no-op', async () => {
    const s = await m11Ledger();
    insertActor(s, 'h1', 'gh-1');
    insertActor(s, 'h2', 'gh-2');
    for (let i = 0; i < 5; i++) insertActor(s, `n${i}`, null);
    for (let i = 0; i < 3; i++) insertActor(s, `e${i}`, '');
    const before = actorRows(s);

    await makeSpecDo(s).init();

    expect(readVersion(s)).toBe(LATEST_VERSION);
    expect(hasIndex(s)).toBe(true);
    expect(actorRows(s)).toEqual(before);

    const schema = objects(s);
    await makeSpecDo(makeSqliteState(s.raw, s.kv)).init();
    expect(objects(s)).toBe(schema);
    expect(actorRows(s)).toEqual(before);

    // re-running the step itself from m11 is a no-op too (the index is there already)
    s.raw.prepare("UPDATE metadata SET value = 'm11' WHERE key = 'schema_version'").run();
    await makeSpecDo(makeSqliteState(s.raw, s.kv)).init();
    expect(readVersion(s)).toBe(LATEST_VERSION);
    expect(objects(s)).toBe(schema);
    expect(actorRows(s)).toEqual(before);
  });

  it('NULL and empty-string rows never collide with each other or with a real id, once the index exists', async () => {
    const s = await freshLedger();
    insertActor(s, 'a', null);
    insertActor(s, 'b', null);
    insertActor(s, 'c', '');
    insertActor(s, 'd', '');
    insertActor(s, 'e', 'gh-1');
    expect(() => insertActor(s, 'f', 'gh-1')).toThrow(/UNIQUE constraint failed/);
    expect(all(s, 'SELECT COUNT(*) AS n FROM actors')[0].n).toBe(5);
  });

  it('empty-string duplicates are not duplicates: they mean "no GitHub identity", like NULL, and pass', async () => {
    const s = await m11Ledger();
    insertActor(s, 'e1', '');
    insertActor(s, 'e2', '');
    await makeSpecDo(s).init();
    expect(readVersion(s)).toBe(LATEST_VERSION);
    expect(hasIndex(s)).toBe(true);
  });

  describe('duplicates', () => {
    async function duplicated(): Promise<{ s: SqliteState; spec: SpecDO }> {
      const s = await m11Ledger();
      insertActor(s, 'zeta', '4242', 'secret-name-zeta');
      insertActor(s, 'alpha', '4242', 'secret-name-alpha');
      insertActor(s, 'gamma', '7', 'secret-name-gamma');
      insertActor(s, 'delta', '7', 'secret-name-delta');
      insertActor(s, 'epsilon', '7', 'secret-name-epsilon');
      insertActor(s, 'solo', '99');
      insertActor(s, 'null1', null);
      return { s, spec: makeSpecDo(s) };
    }

    it('REFUSES with the named error, listing the duplicated values and their actor ids and nothing else', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { spec } = await duplicated();
      const err = await spec.init().then(
        () => null,
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(DuplicateGithubIdentityError);
      const e = err as DuplicateGithubIdentityError;
      expect(e.name).toBe('DuplicateGithubIdentityError');
      expect(e.duplicates).toEqual([
        { githubUserId: '4242', actorIds: ['alpha', 'zeta'] },
        { githubUserId: '7', actorIds: ['delta', 'epsilon', 'gamma'] },
      ]);
      expect(e.message).toContain('"4242" -> alpha, zeta');
      expect(e.message).toContain('"7" -> delta, epsilon, gamma');
      // never a name, a non-duplicated id or an unrelated actor
      expect(e.message).not.toMatch(/secret-name|solo|null1|"99"/);
    });

    it('leaves no partial state: still m11, no index, every row intact, db unset', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { s, spec } = await duplicated();
      const rowsBefore = actorRows(s);
      const schemaBefore = objects(s);

      await expect(spec.init()).rejects.toThrow(/^DuplicateGithubIdentityError: m12 refused, 2 github_user_id value\(s\)/);

      expect(readVersion(s)).toBe('m11');
      expect(hasIndex(s)).toBe(false);
      expect(dbOf(spec)).toBeNull();
      expect(actorRows(s)).toEqual(rowsBefore);
      expect(objects(s)).toBe(schemaBefore);
      // it keeps refusing on every later request until a human acts (the outage is visible, not silent)
      await expect(spec.init()).rejects.toBeInstanceOf(DuplicateGithubIdentityError);
      expect(readVersion(s)).toBe('m11');
    });

    it('a request to the DO fails while the duplicate stands (full outage), it does not serve a half-migrated ledger', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { s, spec } = await duplicated();
      const res = await spec.fetch(new Request('https://spec-do.internal/api/organizations')).catch((e: unknown) => e);
      const failed = res instanceof Error ? true : (res as Response).status >= 500;
      expect(failed).toBe(true);
      expect(readVersion(s)).toBe('m11');
    });

    it('after a human resolves the duplicates, a retry on the same DO reaches m12 and the index exists', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { s, spec } = await duplicated();
      await expect(spec.init()).rejects.toBeInstanceOf(DuplicateGithubIdentityError);

      // the human fix: give the extra rows no identity (the maintainer decides which; the migration never does)
      s.raw.prepare("UPDATE actors SET github_user_id = NULL WHERE id IN ('zeta', 'delta', 'epsilon')").run();
      await spec.init();

      expect(readVersion(s)).toBe(LATEST_VERSION);
      expect(hasIndex(s)).toBe(true);
      expect(all(s, 'SELECT COUNT(*) AS n FROM actors')[0].n).toBe(7);
      expect(() => insertActor(s, 'again', '4242')).toThrow(/UNIQUE constraint failed/);
    });

    it('ids that differ only in case are not duplicates (the index is exact, like the lookups)', async () => {
      const s = await m11Ledger();
      insertActor(s, 'x', 'Abc');
      insertActor(s, 'y', 'abc');
      await makeSpecDo(s).init();
      expect(readVersion(s)).toBe(LATEST_VERSION);
    });
  });

  describe('every legacy ledger shape in the matrix', () => {
    describe.each(legacyFixtures().map((f) => [f.name, f] as const))('from %s', (_name, fx) => {
      const start = () => loadLegacyLedger({ ddl: fx.ddl, seed: fx.seed, version: fx.startVersion });

      it('migrates to m12 with the index (the matrix seed holds no duplicate)', async () => {
        const s = start();
        await makeSpecDo(s).init();
        expect(readVersion(s)).toBe(LATEST_VERSION);
        expect(hasIndex(s)).toBe(true);
      });

      it('refuses when, and only when, the shape genuinely holds a duplicate; rows survive and the fix lets it finish', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const s = start();
        insertActor(s, 'dup-1', 'shared-id');
        insertActor(s, 'dup-2', 'shared-id');
        const rows = actorRows(s);

        const spec = makeSpecDo(s);
        await expect(spec.init()).rejects.toThrow(/DuplicateGithubIdentityError.*"shared-id" -> dup-1, dup-2/);
        // every earlier step ran (they are additive); only m12 was refused
        expect(readVersion(s)).toBe('m11');
        expect(hasIndex(s)).toBe(false);
        expect(actorRows(s)).toEqual(rows);

        s.raw.prepare("UPDATE actors SET github_user_id = NULL WHERE id = 'dup-2'").run();
        await spec.init();
        expect(readVersion(s)).toBe(LATEST_VERSION);
        expect(hasIndex(s)).toBe(true);
      });
    });
  });
});

describe('migration m12: duplicate GitHub identity through the API (clean error, not a constraint 500)', () => {
  const post = (spec: SpecDO, body: unknown, headers: Record<string, string> = {}) =>
    spec.fetch(
      new Request('https://spec-do.internal/api/actors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      })
    );

  it('a second actor with one GitHub id is 409 with a clear message that names the existing actor; no row is added', async () => {
    const s = await freshLedger();
    const spec = makeSpecDo(s);
    const first = await post(spec, { type: 'human', name: 'alice', githubUserId: '4242' });
    expect(first.status).toBe(201);
    const id = ((await first.json()) as { data: { id: string } }).data.id;

    const second = await post(spec, { type: 'human', name: 'alice-again', githubUserId: '4242' });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe(`an actor with github_user_id "4242" already exists (${id})`);
    expect(all(s, 'SELECT COUNT(*) AS n FROM actors')[0].n).toBe(1);
  });

  it('actors without a GitHub identity (omitted, null or empty) are never a conflict', async () => {
    const s = await freshLedger();
    const spec = makeSpecDo(s);
    for (const githubUserId of [undefined, undefined, null, null, '', '']) {
      expect((await post(spec, { type: 'agent', name: 'bot', githubUserId })).status).toBe(201);
    }
    expect(all(s, 'SELECT COUNT(*) AS n FROM actors')[0].n).toBe(6);
    // '' is stored as NULL, as before
    expect(all(s, 'SELECT COUNT(*) AS n FROM actors WHERE github_user_id IS NULL')[0].n).toBe(6);
  });

  it('a retry with the same Idempotency-Key replays the 201 (it is not turned into a 409), and a new key conflicts', async () => {
    const s = await freshLedger();
    const spec = makeSpecDo(s);
    const body = { type: 'human', name: 'alice', githubUserId: '4242' };
    const first = await post(spec, body, { 'Idempotency-Key': 'k-1' });
    const replay = await post(spec, body, { 'Idempotency-Key': 'k-1' });
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers.get('Idempotent-Replay')).toBe('true');
    const other = await post(spec, body, { 'Idempotency-Key': 'k-2' });
    expect(other.status).toBe(409);
    // the refused request left no idempotency key behind: a later retry of it is refused again, not replayed
    const again = await post(spec, body, { 'Idempotency-Key': 'k-2' });
    expect(again.status).toBe(409);
    expect(all(s, 'SELECT COUNT(*) AS n FROM actors')[0].n).toBe(1);
  });

  it('the index backs the check: a raw duplicate insert that bypasses createActor still cannot happen', async () => {
    const s = await freshLedger();
    insertActor(s, 'a', 'gh-1');
    expect(() => insertActor(s, 'b', 'gh-1')).toThrow(/UNIQUE constraint failed/);
  });

  it('seed.ts INSERT OR IGNORE skips a duplicate github id instead of throwing', async () => {
    const s = await freshLedger();
    insertActor(s, 'a', 'gh-1');
    const stmt = s.raw.prepare(
      "INSERT OR IGNORE INTO actors (id, type, name, github_user_id, trust_score, promotion_authority, created_at) VALUES ('b', 'human', 'b', 'gh-1', 50, 0, 1)"
    );
    expect(() => stmt.run()).not.toThrow();
    expect(all(s, 'SELECT COUNT(*) AS n FROM actors')[0].n).toBe(1);
  });
});
