/**
 * Build a Spec DO ledger in a shape this repo's current SQL would never produce (historical or
 * synthetic DDL), so SpecDO.init() runs its real migrations over it.
 * Plan: docs/MIGRATION-LEGACY-TEST-PLAN.md section 4.
 */
import { makeSqliteState, makeSpecDo, type SqliteState } from './sqlite-state';

export interface LegacyLedger {
  /** DDL statements, run with foreign keys off (a legacy shape need not satisfy today's references) */
  ddl: string[];
  /** Seed statements, run after the DDL, also with foreign keys off */
  seed?: string[];
  /** schema_version row to write; null writes none (a ledger that predates versioning reads as m1) */
  version: string | null;
  /** Write the `schema_init` key, as a ledger that already ran initSchema has (default true) */
  schemaInit?: boolean;
}

export function loadLegacyLedger(l: LegacyLedger): SqliteState {
  const s = makeSqliteState();
  s.raw.exec('PRAGMA foreign_keys = OFF');
  for (const sql of l.ddl) s.raw.exec(sql);
  for (const sql of l.seed ?? []) s.raw.exec(sql);
  if (l.version !== null) {
    s.raw.exec(`INSERT OR REPLACE INTO metadata (key, value, updated_at) VALUES ('schema_version', '${l.version}', 0)`);
  }
  s.raw.exec('PRAGMA foreign_keys = ON');
  if (l.schemaInit ?? true) s.kv.set('schema_init', 'true');
  return s;
}

export const readVersion = (s: SqliteState): string =>
  (s.raw.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as { value: string }).value;

/** The version a fresh ledger reaches. Read from a real init, so no export from index.ts is needed. */
export async function freshLedger(): Promise<SqliteState> {
  const s = makeSqliteState();
  await makeSpecDo(s).init();
  return s;
}

/** The latest schema version, from a fresh ledger: tests assert against this instead of a literal 'm<N>' */
export const LATEST_VERSION: string = readVersion(await freshLedger());
