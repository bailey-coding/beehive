/**
 * Migration matrix: SpecDO.init() over every historical ledger shape (schema.sql as committed at each
 * commit, plus synthetic m1 / m2). For each: init reaches the latest version, nothing is lost, a second
 * init (and a re-run of every step) changes nothing, and the result has a fresh ledger's columns and indexes.
 *
 * Plan: docs/MIGRATION-LEGACY-TEST-PLAN.md section 5 (A1 to A4). A failure here is a finding for
 * docs/OPEN-QUESTIONS.md, not a reason to patch the migration code (spine).
 *
 * Task: migration-legacy-slice1 | Spec: docs/MIGRATION-LEGACY-TEST-PLAN.md#10
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { makeSpecDo, type SqliteState } from './sqlite-state';
import { loadLegacyLedger, readVersion, freshLedger, LATEST_VERSION } from './legacy-ledger';
import { legacyFixtures } from './fixtures/legacy';

type Row = Record<string, unknown>;
const all = (s: SqliteState, sql: string) => s.raw.prepare(sql).all() as Row[];

const userTables = (s: SqliteState) =>
  all(s, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name as string);
const columnsOf = (s: SqliteState, t: string) => all(s, `PRAGMA table_info(${t})`);
const master = (s: SqliteState) => all(s, "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name");
const indexNames = (s: SqliteState, t: string) =>
  all(s, `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = '${t}' AND name NOT LIKE 'sqlite_%' ORDER BY name`).map((r) => r.name);

/** Every row of every table, serialised: the schema_version row is the one thing a migration must change */
function rowsDump(s: SqliteState): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const t of userTables(s)) {
    const where = t === 'metadata' ? " WHERE key != 'schema_version'" : '';
    out[t] = all(s, `SELECT * FROM ${t}${where}`).map((r) => JSON.stringify(r)).sort();
  }
  return out;
}

/** The rows of `before`'s tables, restricted to the columns they had then */
function originalColumnRows(s: SqliteState, before: { table: string; cols: string[] }[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const { table, cols } of before) {
    const where = table === 'metadata' ? " WHERE key != 'schema_version'" : '';
    out[table] = all(s, `SELECT ${cols.join(', ')} FROM ${table}${where}`).map((r) => JSON.stringify(r)).sort();
  }
  return out;
}

afterEach(() => vi.restoreAllMocks());

// Finding (OPEN-QUESTIONS 2026-10-26): a fresh ledger lacks these three columns that every migrated ledger
// has, and updateCandidatePreview writes them. A4 leaves them out so it still checks everything else.
const PREVIEW_COLUMNS = ['preview_url', 'preview_worker_name', 'preview_created_at'];

describe('migration matrix: init over every historical ledger shape', () => {
  it.fails('a fresh ledger has the candidates preview columns that every migrated ledger has', async () => {
    const fresh = await freshLedger();
    expect(columnsOf(fresh, 'candidates').map((c) => c.name)).toEqual(expect.arrayContaining(PREVIEW_COLUMNS));
  });

  it('the latest version is the fresh ledger version and the matrix starts below it', () => {
    expect(LATEST_VERSION).toMatch(/^m\d+$/);
    expect(legacyFixtures().length).toBeGreaterThanOrEqual(14);
  });

  describe.each(legacyFixtures().map((f) => [f.name, f] as const))('from %s', (_name, fx) => {
    const start = () => loadLegacyLedger({ ddl: fx.ddl, seed: fx.seed, version: fx.startVersion });

    it('A1: init resolves and reaches the latest version', async () => {
      const s = start();
      await makeSpecDo(s).init();
      expect(readVersion(s)).toBe(LATEST_VERSION);
    });

    it('A2: nothing is lost: every object and every original column value survives', async () => {
      const s = start();
      const objectsBefore = master(s);
      const tablesBefore = userTables(s).map((table) => ({ table, cols: columnsOf(s, table).map((c) => c.name as string) }));
      const rowsBefore = originalColumnRows(s, tablesBefore);
      expect(Object.values(rowsBefore).flat().length).toBeGreaterThan(0);

      await makeSpecDo(s).init();

      const after = new Map(master(s).map((o) => [`${o.type}:${o.name}`, o]));
      for (const o of objectsBefore) {
        const kept = after.get(`${o.type}:${o.name}`);
        expect(kept, `${o.type} ${o.name} was dropped`).toBeDefined();
        if (o.type === 'index') expect(kept!.sql, `index ${o.name} was redefined`).toBe(o.sql);
      }
      expect(originalColumnRows(s, tablesBefore)).toEqual(rowsBefore);
    });

    // A3 and A4 compare against a fresh ledger or a rerun; a shape with a recorded finding is expected to fail them
    const convergent = fx.finding ? it.fails : it;

    convergent('A3: a second init changes nothing, and re-running any step from its predecessor changes nothing', async () => {
      const s = start();
      await makeSpecDo(s).init();
      const objects = master(s);
      const rows = rowsDump(s);

      await makeSpecDo(s).init();
      expect(master(s)).toEqual(objects);
      expect(rowsDump(s)).toEqual(rows);

      for (let n = 1; n < Number(LATEST_VERSION.slice(1)); n++) {
        s.raw.exec(`UPDATE metadata SET value = 'm${n}' WHERE key = 'schema_version'`);
        await makeSpecDo(s).init();
        expect(readVersion(s), `re-run from m${n}`).toBe(LATEST_VERSION);
        expect(master(s), `re-run from m${n}`).toEqual(objects);
        expect(rowsDump(s), `re-run from m${n}`).toEqual(rows);
      }
    });

    convergent('A4: the result has the same tables, columns and indexes as a fresh ledger', async () => {
      const s = start();
      await makeSpecDo(s).init();
      const fresh = await freshLedger();
      expect(userTables(s)).toEqual(userTables(fresh));
      const skip = (t: string, name: unknown) => t === 'candidates' && PREVIEW_COLUMNS.includes(String(name));
      const byName = (a: { name: unknown }, b: { name: unknown }) => String(a.name).localeCompare(String(b.name));
      for (const t of userTables(fresh)) {
        const shape = (x: SqliteState) => columnsOf(x, t).filter((c) => !skip(t, c.name)).map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, dflt: c.dflt_value, pk: c.pk }));
        // column order differs when a column was appended by ALTER: compare sorted by name
        expect(shape(s).sort(byName), `columns of ${t}`).toEqual(shape(fresh).sort(byName));
        expect(indexNames(s, t), `indexes of ${t}`).toEqual(indexNames(fresh, t));
      }
    });
  });
});
