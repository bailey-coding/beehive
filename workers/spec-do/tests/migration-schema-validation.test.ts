/**
 * Schema validation tests to catch issues like the legacy service_accounts table
 * that slipped through because tests only saw this repo's own SQL.
 *
 * These tests verify:
 * 1. The schema.sql file contains all expected tables
 * 2. The schema-inline.ts constants match the schema.sql file
 * 3. All tables have the expected columns
 * 4. No legacy tables with wrong schemas exist
 *
 * Task: address migration test gaps | Spec: AGENTS.md#state-management
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import {
  SCHEMA_SQL,
  SERVICE_ACCOUNTS_SQL,
  PROMOTION_LEDGER_SQL,
  LEDGER_LIFECYCLE_SQL,
  SERVICE_TOKENS_SQL,
  DEPLOY_REFS_SQL,
  LEDGER_CAS_SQL,
  LIFECYCLE_COLUMNS,
} from '../schema-inline';

// Helper to extract table definitions from SQL
function extractTableDefinitions(sql: string): Map<string, string> {
  const tables = new Map<string, string>();
  const lines = sql.split('\n');
  let currentTable: string | null = null;
  let currentDefinition = '';
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Match CREATE TABLE statements
    const createMatch = trimmed.match(/^CREATE TABLE (IF NOT EXISTS\s+)?[`"]?(\w+)[`"]?\s*\(/);
    if (createMatch) {
      if (currentTable) {
        // Save previous table
        tables.set(currentTable, currentDefinition);
      }
      currentTable = createMatch[2];
      currentDefinition = line;
    } else if (currentTable && trimmed === ');') {
      // End of table definition
      currentDefinition += '\n' + line;
      tables.set(currentTable, currentDefinition);
      currentTable = null;
    } else if (currentTable) {
      // Continuation of table definition
      currentDefinition += '\n' + line;
    }
  }
  
  // Don't forget the last table
  if (currentTable) {
    tables.set(currentTable, currentDefinition);
  }
  
  return tables;
}

// Helper to extract columns from a table definition
function extractColumnsFromTable(sql: string): string[] {
  const columns: string[] = [];
  // Simple extraction - look for lines with column definitions
  const lines = sql.split('\n');
  for (const line of lines) {
    // Match column definitions (simplified)
    const match = line.match(/\s*(\w+)\s+(TEXT|INTEGER|BOOLEAN|REAL|BLOB)/);
    if (match) {
      columns.push(match[1]);
    }
  }
  return columns;
}

describe('schema.sql completeness and consistency', () => {
  const schemaPath = new URL('../schema.sql', import.meta.url);
  const schemaContent = readFileSync(schemaPath, 'utf8');
  const schemaTables = extractTableDefinitions(schemaContent);

  it('schema.sql contains all critical tables', () => {
    const expectedTables = [
      'entity_history',
      'organizations',
      'repositories',
      'actors',
      'specs',
      'candidates',
      'gate_verdicts',
      'trials',
      'promotions',
      'issues',
      'issue_comments',
      'issue_spec_links',
      'issue_candidate_links',
      'service_accounts',
      'service_tokens',
      'metadata',
      'promotion_states',
      'tournaments',
      'merge_trains',
      'deploy_refs',
      'canary_deployments',
      'purge_log',
    ];

    for (const table of expectedTables) {
      expect(schemaTables.has(table), `Table ${table} should exist in schema.sql`).toBe(true);
    }
  });

  it('service_accounts table has the current schema with all required columns', () => {
    const serviceAccountsSql = schemaTables.get('service_accounts');
    expect(serviceAccountsSql, 'service_accounts table should exist').not.toBeUndefined();

    const serviceAccountsDefinition = serviceAccountsSql!;
    
    // Required columns in the current schema
    const requiredColumns = [
      'id',
      'name',
      'description',
      'organization_id',
      'scopes',
      'token_hash',
      'token_salt',
      'created_by',
      'created_at',
      'expires_at',
      'is_active',
      'last_used_at',
    ];
    // actor_id is added by the m6 migration in index.ts (ALTER TABLE is not idempotent), so it is
    // checked in the migration tests below, not in the base CREATE TABLE.

    for (const col of requiredColumns) {
      expect(
        serviceAccountsDefinition.includes(col),
        `service_accounts table should have column ${col}`
      ).toBe(true);
    }

    // Legacy schema issues that should NOT be present
    // The legacy service_accounts table had actor_id as NOT NULL UNIQUE
    // and was missing token_hash, token_salt, is_active
    // We verify that token_hash and token_salt exist (from above)
    // and that the table has the CHECK constraint for scopes
    expect(serviceAccountsDefinition).toContain('CHECK(scopes IN');
  });

  it('all tables have proper CHECK constraints where applicable', () => {
    const tablesWithConstraints = [
      { table: 'organizations', constraints: ['type IN'] },
      { table: 'repositories', constraints: ['repo_type IN'] },
      { table: 'actors', constraints: ['type IN'] },
      { table: 'specs', constraints: ['stage IN'] },
      { table: 'candidates', constraints: ['stage IN'] },
      { table: 'service_accounts', constraints: ['scopes IN'] },
    ];

    for (const { table, constraints } of tablesWithConstraints) {
      const tableSql = schemaTables.get(table);
      expect(tableSql, `Table ${table} should exist`).not.toBeUndefined();

      for (const constraint of constraints) {
        expect(
          tableSql!.includes(constraint),
          `Table ${table} should have constraint containing ${constraint}`
        ).toBe(true);
      }
    }
  });
});

describe('schema-inline.ts vs schema.sql synchronization', () => {
  const schemaPath = new URL('../schema.sql', import.meta.url);
  const schemaContent = readFileSync(schemaPath, 'utf8');

  it('SCHEMA_SQL matches the beginning of schema.sql', () => {
    // SCHEMA_SQL should contain the base schema
    expect(schemaContent.startsWith(SCHEMA_SQL.trim())).toBe(true);
  });

  it('all migration SQL sections are present in schema.sql', () => {
    // The schema.sql should contain all the inline SQL sections
    expect(schemaContent).toContain(SERVICE_ACCOUNTS_SQL.trim());
    expect(schemaContent).toContain(PROMOTION_LEDGER_SQL.trim());
    expect(schemaContent).toContain(LEDGER_LIFECYCLE_SQL.trim());
    expect(schemaContent).toContain(SERVICE_TOKENS_SQL.trim());
    expect(schemaContent).toContain(DEPLOY_REFS_SQL.trim());
    expect(schemaContent).toContain(LEDGER_CAS_SQL.trim());
  });
});

// Columns that schema.sql deliberately leaves out of CREATE TABLE and that index.ts adds with a
// PRAGMA-guarded ALTER, because ALTER TABLE ADD COLUMN is not idempotent.
const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

function columnsOf(tables: Map<string, string>, table: string): string[] {
  const def = tables.get(table);
  expect(def, `Table ${table} should exist`).not.toBeUndefined();
  return extractColumnsFromTable(def!);
}

describe('legacy schema issues that should be caught', () => {
  const schemaContent = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const tables = extractTableDefinitions(schemaContent);

  it('service_accounts table is NOT the legacy schema', () => {
    // The legacy table had actor_id NOT NULL UNIQUE, revoked_at, and no token_hash/token_salt/is_active.
    const cols = columnsOf(tables, 'service_accounts');
    for (const col of ['token_hash', 'token_salt', 'is_active']) expect(cols).toContain(col);
    expect(cols).not.toContain('revoked_at');
    // actor_id is added by the m6 migration, nullable.
    expect(indexSource).toContain('ALTER TABLE service_accounts ADD COLUMN actor_id TEXT REFERENCES actors(id)');
  });

  it('entity tables get tombstone columns from the m5 migration', () => {
    for (const table of ['organizations', 'repositories', 'specs', 'candidates', 'issues']) {
      expect(LIFECYCLE_COLUMNS[table], `${table} should get tombstone columns`).toEqual([
        'deleted_at INTEGER',
        'deleted_by TEXT',
        'delete_reason TEXT',
      ]);
    }
    expect(indexSource).toContain('addColumnsIfMissing');
    expect(schemaContent).toContain('idx_organizations_deleted');
  });

  it('metadata table can hold the schema_version row', () => {
    // schema_version is a row (key), not a column.
    const cols = columnsOf(tables, 'metadata');
    for (const col of ['key', 'value', 'updated_at']) expect(cols).toContain(col);
    expect(indexSource).toContain("'schema_version'");
  });
});

describe('promotion ledger tables', () => {
  const schemaContent = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const tables = extractTableDefinitions(schemaContent);

  const expectColumns = (table: string, expected: string[]) => {
    const cols = columnsOf(tables, table);
    for (const col of expected) expect(cols, `${table} should have column ${col}`).toContain(col);
  };

  it('promotion_states table has its columns', () => {
    expectColumns('promotion_states', [
      'candidate_id', 'spec_id', 'current_rung', 'target_rung', 'status', 'mode', 'started_at', 'updated_at',
    ]);
  });

  it('tournaments table has its columns', () => {
    expectColumns('tournaments', ['id', 'spec_id', 'status', 'winner', 'candidates', 'created_at']);
  });

  it('merge_trains table has its columns', () => {
    expectColumns('merge_trains', ['id', 'spec_id', 'status', 'current_position', 'candidates', 'created_at']);
  });

  it('deploy_refs table has deployment reference tracking', () => {
    expectColumns('deploy_refs', ['id', 'spec_id', 'rung', 'candidate_id', 'commit_sha', 'prev_ref_id', 'moved_at']);
  });

  it('canary_deployments table has canary tracking', () => {
    expectColumns('canary_deployments', ['candidate_id', 'spec_id', 'status', 'traffic_percentage', 'created_at']);
  });
});
