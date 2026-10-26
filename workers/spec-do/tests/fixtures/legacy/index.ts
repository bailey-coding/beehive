/**
 * Manifest of legacy ledger shapes for migration-matrix.test.ts.
 * T1: schema.sql as committed at each historical commit (scripts/snapshot-schema-fixtures.sh).
 * T3: synthetic m1 / m2 shapes derived from the first commit (git history has nothing before m3).
 * Plan: docs/MIGRATION-LEGACY-TEST-PLAN.md section 3.
 */
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('./', import.meta.url);

export interface LegacyFixture {
  name: string;
  ddl: string[];
  seed: string[];
  /** schema_version the ledger carries; null = no row */
  startVersion: string | null;
  /** A real gap this shape exposes (docs/OPEN-QUESTIONS.md): the convergence cases are it.fails until a human fixes it */
  finding?: string;
}

// Rows using only columns every historical shape has (organizations, actors, repositories, specs,
// candidates, issues, comments); later NOT NULL columns must default, or the seed itself shows the gap.
export const BASE_SEED = [
  "INSERT INTO organizations (id, name, type, created_at) VALUES ('org-1', 'acme', 'artifacts', 1)",
  "INSERT INTO actors (id, type, name, created_at) VALUES ('act-1', 'human', 'maint', 1)",
  "INSERT INTO actors (id, type, name, github_user_id, created_at) VALUES ('act-2', 'agent', 'bot', '4242', 2)",
  "INSERT INTO repositories (id, name, organization_id, repo_type, remote_url, created_at) VALUES ('repo-1', 'r', 'org-1', 'baseline', 'https://example.invalid/r.git', 1)",
  "INSERT INTO specs (id, name, contract, declared_delta_surface, organization_id, created_by, created_at) VALUES ('spec-1', 's', '{}', '[]', 'org-1', 'act-1', 1)",
  "INSERT INTO candidates (id, spec_id, repository_id, commit_sha, base_commit_sha, agent_id, created_at) VALUES ('cand-1', 'spec-1', 'repo-1', 'sha', 'base', 'act-2', 1)",
  "INSERT INTO issues (id, number, repository_id, title, status, created_at, created_by) VALUES ('iss-1', 1, 'repo-1', 't', 'open', 1, 'act-1')",
  "INSERT INTO entity_history (id, entity_type, entity_id, stage, changed_by, changed_at) VALUES ('h-1', 'spec', 'spec-1', 'draft', 'act-1', 1)",
];

const read = (f: string) => readFileSync(new URL(f, dir), 'utf8');

// schema.sql documents some later columns only in comments: the code added them with ALTER TABLE ADD COLUMN
// (m2, m5, m6, m8), and the file's indexes on them (idx_*_deleted) would fail on the bare tables. A real
// ledger at that version had the columns, so apply the same ALTERs, then the deferred indexes.
const ALTERS: [since: number, sql: string][] = [
  [2, 'ALTER TABLE candidates ADD COLUMN preview_url TEXT'],
  [2, 'ALTER TABLE candidates ADD COLUMN preview_worker_name TEXT'],
  [2, 'ALTER TABLE candidates ADD COLUMN preview_created_at INTEGER'],
  ...['organizations', 'repositories', 'specs', 'candidates', 'issues'].flatMap((t): [number, string][] =>
    ['deleted_at INTEGER', 'deleted_by TEXT', 'delete_reason TEXT'].map((c) => [5, `ALTER TABLE ${t} ADD COLUMN ${c}`] as [number, string])
  ),
  [5, 'ALTER TABLE actors ADD COLUMN role TEXT'],
  [6, 'ALTER TABLE service_accounts ADD COLUMN actor_id TEXT REFERENCES actors(id)'],
  [8, 'ALTER TABLE tournaments ADD COLUMN version INTEGER NOT NULL DEFAULT 1'],
  [8, 'ALTER TABLE tournaments ADD COLUMN failure_reason TEXT'],
  [8, 'ALTER TABLE tournaments ADD COLUMN failed_at TEXT'],
  [8, 'ALTER TABLE tournaments ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0'],
  [8, 'ALTER TABLE merge_trains ADD COLUMN version INTEGER NOT NULL DEFAULT 1'],
];
const DEFERRED_INDEX = /^CREATE INDEX IF NOT EXISTS \w+ ON \w+\((deleted_at|actor_id)\);$/;

function historicalDdl(file: string, version: number): string[] {
  const lines = read(file).split('\n');
  const deferred = lines.filter((l) => DEFERRED_INDEX.test(l));
  const base = lines.filter((l) => !DEFERRED_INDEX.test(l)).join('\n');
  return [base, ...ALTERS.filter(([since]) => since <= version).map(([, sql]) => sql), ...deferred];
}

// m9 meant idempotency_keys at d34db95 and user_tokens at af1165f and 98d43df; neither schema.sql nor the code at
// these two commits creates user_tokens
const NO_USER_TOKENS = /^m(9-d34db95|10-469389b)\.sql$/;

function historical(): LegacyFixture[] {
  return readdirSync(dir)
    .filter((f) => /^m\d+-[0-9a-f]+\.sql$/.test(f))
    .sort((a, b) => Number(a.slice(1).split('-')[0]) - Number(b.slice(1).split('-')[0]) || a.localeCompare(b))
    .map((f) => {
      const startVersion = f.split('-')[0];
      const finding = NO_USER_TOKENS.test(f) ? 'OPEN-QUESTIONS 2026-10-26: a ledger at this commit has no user_tokens and current m9 never creates it' : undefined;
      return { name: f.replace(/\.sql$/, ''), ddl: historicalDdl(f, Number(startVersion.slice(1))), seed: BASE_SEED, startVersion, finding };
    });
}

/** The first commit's schema with service_accounts cut out: an m2 ledger (candidates has no preview columns yet) */
function m2FromFirstCommit(): string {
  const sql = read(readdirSync(dir).filter((f) => /^m3-/.test(f))[0]);
  const at = sql.indexOf('-- SERVICE ACCOUNTS');
  if (at < 0) throw new Error('service_accounts section not found in the first historical schema');
  // cut from the banner line above the heading to the end of the file (the section is last)
  return sql.slice(0, sql.lastIndexOf('-- ====', at));
}

export function legacyFixtures(): LegacyFixture[] {
  const m2 = m2FromFirstCommit();
  return [
    { name: 'm1-synthetic (no schema_version row)', ddl: [m2], seed: BASE_SEED, startVersion: null },
    { name: 'm1-synthetic', ddl: [m2], seed: BASE_SEED, startVersion: 'm1' },
    {
      name: 'm2-synthetic',
      ddl: [m2, 'ALTER TABLE candidates ADD COLUMN preview_url TEXT', 'ALTER TABLE candidates ADD COLUMN preview_worker_name TEXT', 'ALTER TABLE candidates ADD COLUMN preview_created_at INTEGER'],
      seed: BASE_SEED,
      startVersion: 'm2',
    },
    ...historical(),
  ];
}
