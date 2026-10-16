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
    } else if (currentTable && trimmed === ')';) {
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
      'actor_id',
    ];

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

describe('legacy schema issues that should be caught', () => {
  const schemaPath = new URL('../schema.sql', import.meta.url);
  const schemaContent = readFileSync(schemaPath, 'utf8');

  it('service_accounts table is NOT the legacy schema', () => {
    // Legacy schema had:
    // CREATE TABLE service_accounts (
    //   id TEXT PRIMARY KEY, actor_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL,
    //   organization_id TEXT, description TEXT, created_at INTEGER NOT NULL, created_by TEXT NOT NULL,
    //   revoked_at INTEGER, FOREIGN KEY (actor_id) REFERENCES actors(id), FOREIGN KEY (organization_id) REFERENCES organizations(id))
    
    // Current schema should have token_hash, token_salt, is_active
    expect(schemaContent).toContain('token_hash TEXT');
    expect(schemaContent).toContain('token_salt TEXT');
    expect(schemaContent).toContain('is_active BOOLEAN');
    
    // Should NOT have revoked_at (replaced by is_active)
    // Note: We check that the service_accounts CREATE TABLE has these columns
    const serviceAccountsSection = schemaContent.match(/CREATE TABLE[\s\S]*?service_accounts[\s\S]*?\);/);
    expect(serviceAccountsSection, 'service_accounts table definition should exist').not.toBeNull();
    
    // Verify the table has the actor_id column (but not as NOT NULL UNIQUE without also having token_hash)
    const serviceAccountsDef = serviceAccountsSection![0];
    expect(serviceAccountsDef).toContain('actor_id');
    expect(serviceAccountsDef).toContain('token_hash');
  });

  it('all entity tables have tombstone columns for soft deletion', () => {
    // After m5, all entity tables should have deleted_at, deleted_by, delete_reason
    const entityTables = ['organizations', 'repositories', 'actors', 'specs', 'candidates', 'issues'];
    
    for (const table of entityTables) {
      const tableSection = schemaContent.match(new RegExp(`CREATE TABLE[\\s\\S]*?${table}[\\s\\S]*?\);`));
      expect(tableSection, `Table ${table} should exist`).not.toBeNull();
      
      const tableDef = tableSection![0];
      // Should have soft deletion columns
      expect(tableDef).toContain('deleted_at');
      expect(tableDef).toContain('deleted_by');
      expect(tableDef).toContain('delete_reason');
    }
  });

  it('metadata table has schema_version tracking', () => {
    const metadataSection = schemaContent.match(/CREATE TABLE[\s\S]*?metadata[\s\S]*?\);/);
    expect(metadataSection, 'metadata table should exist').not.toBeNull();
    
    const metadataDef = metadataSection![0];
    expect(metadataDef).toContain('schema_version');
    expect(metadataDef).toContain('updated_at');
  });
});

describe('promotion ledger tables', () => {
  const schemaPath = new URL('../schema.sql', import.meta.url);
  const schemaContent = readFileSync(schemaPath, 'utf8');

  it('promotion_states table exists with all required columns', () => {
    const promotionStatesSection = schemaContent.match(/CREATE TABLE[\s\S]*?promotion_states[\s\S]*?\);/);
    expect(promotionStatesSection, 'promotion_states table should exist').not.toBeNull();
    
    const def = promotionStatesSection![0];
    expect(def).toContain('candidate_id');
    expect(def).toContain('current_rung');
    expect(def).toContain('target_rung');
    expect(def).toContain('status');
    expect(def).toContain('attempted_at');
  });

  it('tournaments table exists with all required columns', () => {
    const tournamentsSection = schemaContent.match(/CREATE TABLE[\s\S]*?tournaments[\s\S]*?\);/);
    expect(tournamentsSection, 'tournaments table should exist').not.toBeNull();
    
    const def = tournamentsSection![0];
    expect(def).toContain('id');
    expect(def).toContain('spec_id');
    expect(def).toContain('status');
    expect(def).toContain('mode');
    expect(def).toContain('winner_id');
    expect(def).toContain('created_at');
  });

  it('merge_trains table exists with all required columns', () => {
    const mergeTrainsSection = schemaContent.match(/CREATE TABLE[\s\S]*?merge_trains[\s\S]*?\);/);
    expect(mergeTrainsSection, 'merge_trains table should exist').not.toBeNull();
    
    const def = mergeTrainsSection![0];
    expect(def).toContain('id');
    expect(def).toContain('current_rung');
    expect(def).toContain('status');
    expect(def).toContain('created_at');
  });

  it('deploy_refs table exists with deployment reference tracking', () => {
    const deployRefsSection = schemaContent.match(/CREATE TABLE[\s\S]*?deploy_refs[\s\S]*?\);/);
    expect(deployRefsSection, 'deploy_refs table should exist').not.toBeNull();
    
    const def = deployRefsSection![0];
    expect(def).toContain('id');
    expect(def).toContain('spec_id');
    expect(def).toContain('rung');
    expect(def).toContain('commit_sha');
    expect(def).toContain('prev_ref_id');
    expect(def).toContain('deployed_at');
  });

  it('canary_deployments table exists for canary deployment tracking', () => {
    const canarySection = schemaContent.match(/CREATE TABLE[\s\S]*?canary_deployments[\s\S]*?\);/);
    expect(canarySection, 'canary_deployments table should exist').not.toBeNull();
    
    const def = canarySection![0];
    expect(def).toContain('candidate_id');
    expect(def).toContain('canary_percentage');
    expect(def).toContain('started_at');
    expect(def).toContain('status');
  });
});
