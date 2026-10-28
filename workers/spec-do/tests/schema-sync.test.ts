/**
 * schema.sql is the readable source; schema-inline.ts is the copy wrangler/esbuild
 * bundles (no ?raw loader for .sql). They must agree byte for byte, or a fresh DO and
 * a migrated DO build different schemas. Runs in `npm test`, so CI catches drift.
 *
 * Task: review-fix-5-schema-sync | Spec: AGENTS.md#state-management
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  SCHEMA_SQL,
  SERVICE_ACCOUNTS_SQL,
  PROMOTION_LEDGER_SQL,
  LEDGER_LIFECYCLE_SQL,
  SERVICE_TOKENS_SQL,
  DEPLOY_REFS_SQL,
  LEDGER_CAS_SQL,
  USER_TOKENS_SQL,
  IDEMPOTENCY_KEYS_SQL,
  CANARY_METRICS_SQL,
  ACTORS_GITHUB_UNIQUE_SQL,
  GATE_RUNS_SQL,
} from '../schema-inline';

const file = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

describe('schema.sql vs schema-inline.ts', () => {
  it('schema.sql is the inline sections concatenated, byte for byte', () => {
    // Base schema (which already holds the m3 service_accounts and m4 promotion ledger
    // sections), then the sections later migrations appended, in migration order
    expect(file).toBe(SCHEMA_SQL + LEDGER_LIFECYCLE_SQL + SERVICE_TOKENS_SQL + DEPLOY_REFS_SQL + LEDGER_CAS_SQL + USER_TOKENS_SQL + IDEMPOTENCY_KEYS_SQL + CANARY_METRICS_SQL + ACTORS_GITHUB_UNIQUE_SQL + GATE_RUNS_SQL);
  });

  it('m9 references actors only and adds no index on actors (a unique github_user_id index is m12)', () => {
    const sql = USER_TOKENS_SQL.replace(/--.*$/gm, '');
    expect(sql.match(/REFERENCES\s+\w+/g)).toEqual(['REFERENCES actors', 'REFERENCES actors', 'REFERENCES actors']);
    expect(sql.match(/\bON\s+\w+/gi)).toEqual(['ON user_tokens', 'ON user_tokens']);
    expect(sql).not.toMatch(/\b(DROP|ALTER|DELETE|UPDATE|INSERT)\b/i);
  });

  it('m11 canary_metrics is one additive table: no foreign keys, no destructive statements', () => {
    const sql = CANARY_METRICS_SQL.replace(/--.*$/gm, '');
    expect(sql.match(/CREATE TABLE IF NOT EXISTS \w+/g)).toEqual(['CREATE TABLE IF NOT EXISTS canary_metrics']);
    expect(sql).not.toMatch(/REFERENCES|FOREIGN KEY/i);
    expect(sql).not.toMatch(/\b(DROP|ALTER|DELETE|UPDATE|INSERT)\b/i);
  });

  it('m12 is one partial unique index on actors.github_user_id and nothing else', () => {
    const sql = ACTORS_GITHUB_UNIQUE_SQL.replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim();
    expect(sql).toBe(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_actors_github_user_id_unique ON actors(github_user_id) WHERE github_user_id IS NOT NULL AND github_user_id != '';"
    );
  });

  it('m13 is one additive gate_runs table with its indexes, a foreign key to actors only, and nothing destructive', () => {
    const sql = GATE_RUNS_SQL.replace(/--.*$/gm, '');
    expect(sql.match(/CREATE TABLE IF NOT EXISTS \w+/g)).toEqual(['CREATE TABLE IF NOT EXISTS gate_runs']);
    expect(sql.match(/CREATE INDEX IF NOT EXISTS \w+/g)).toHaveLength(3);
    // docs/OPS.md rollback floor: only actors (never a table in ORG_PURGE_ORDER); candidate_id is a logical reference
    expect(sql.match(/REFERENCES\s+\w+/g)).toEqual(['REFERENCES actors']);
    expect(sql).not.toMatch(/\b(DROP|ALTER|DELETE|UPDATE|INSERT)\b/i);
  });

  it('the base candidates table carries the preview columns that the m2 step adds to migrated ledgers', () => {
    const candidates = SCHEMA_SQL.slice(SCHEMA_SQL.indexOf('CREATE TABLE IF NOT EXISTS candidates'), SCHEMA_SQL.indexOf('CREATE INDEX IF NOT EXISTS idx_candidates_spec'));
    for (const c of ['preview_url TEXT', 'preview_worker_name TEXT', 'preview_created_at INTEGER']) expect(candidates).toContain(c);
  });

  it('the standalone migration sections are verbatim parts of the base schema', () => {
    expect(SCHEMA_SQL).toContain(SERVICE_ACCOUNTS_SQL.trim());
    expect(SCHEMA_SQL).toContain(PROMOTION_LEDGER_SQL.trim());
  });
});
