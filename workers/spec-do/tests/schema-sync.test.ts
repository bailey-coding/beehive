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
} from '../schema-inline';

const file = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

describe('schema.sql vs schema-inline.ts', () => {
  it('schema.sql is the inline sections concatenated, byte for byte', () => {
    // Base schema (which already holds the m3 service_accounts and m4 promotion ledger
    // sections), then the sections later migrations appended, in migration order
    expect(file).toBe(SCHEMA_SQL + LEDGER_LIFECYCLE_SQL + SERVICE_TOKENS_SQL + DEPLOY_REFS_SQL);
  });

  it('the standalone migration sections are verbatim parts of the base schema', () => {
    expect(SCHEMA_SQL).toContain(SERVICE_ACCOUNTS_SQL.trim());
    expect(SCHEMA_SQL).toContain(PROMOTION_LEDGER_SQL.trim());
  });
});
