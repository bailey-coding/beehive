/**
 * Harden migration tests to catch legacy schema shapes from production dumps.
 * 
 * Problem: Migration tests only saw this repo's SQL; old service_accounts table
 * design passed tests but broke production.
 * 
 * Solution: Add tests that seed legacy shapes from production schema dumps.
 * These tests verify that migrations properly detect and reject incompatible
 * schema shapes, or successfully migrate them.
 * 
 * Task: harden migration tests | Spec: docs/rfos/2026-10-14-migration-failures.md
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeSqliteState, makeSpecDo, type SqliteState } from './sqlite-state';
import { LATEST_VERSION } from './legacy-ledger';

const version = (s: SqliteState) =>
  (s.raw.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as { value: string }).value;
const tables = (s: SqliteState) =>
  (s.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
const columns = (s: SqliteState, table: string) =>
  (s.raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name);

/**
 * Create a fresh latest-version ledger with basic data for testing legacy schema detection.
 * This simulates a production ledger that has been through all migrations.
 */
async function freshLatestLedger(): Promise<SqliteState> {
  const s = makeSqliteState();
  await makeSpecDo(s).init();
  expect(version(s)).toBe(LATEST_VERSION);
  return s;
}

/**
 * Create an m3 ledger with populated data but missing later migrations.
 * This is the baseline for testing legacy schema injection.
 */
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

  // Drop tables added after m3
  const raw = fresh.raw;
  raw.exec('PRAGMA foreign_keys = OFF');
  for (const t of ['canary_metrics', 'canary_deployments', 'deploy_refs', 'service_tokens', 'promotion_states', 'tournaments', 'merge_trains', 'purge_log']) {
    raw.exec(`DROP TABLE ${t}`);
  }
  
  // Drop indexes - try without IF EXISTS first
  const dropIndex = (name: string) => {
    try {
      raw.exec(`DROP INDEX ${name}`);
    } catch (e) {
      // Index might not exist, that's ok
    }
  };
  dropIndex('idx_service_accounts_actor');
  dropIndex('idx_service_accounts_name');
  
  // Drop lifecycle columns from entity tables
  for (const t of ['organizations', 'repositories', 'specs', 'candidates', 'issues']) {
    dropIndex(`idx_${t}_deleted`);
    for (const c of ['deleted_at', 'deleted_by', 'delete_reason']) {
      try {
        raw.exec(`ALTER TABLE ${t} DROP COLUMN ${c}`);
      } catch (e) {
        // Column might not exist, that's ok
      }
    }
  }
  try {
    raw.exec('ALTER TABLE actors DROP COLUMN role');
  } catch (e) {
    // Column might not exist, that's ok
  }
  raw.exec('PRAGMA foreign_keys = ON');
  
  // Set version to m3
  raw.exec("UPDATE metadata SET value = 'm3' WHERE key = 'schema_version'");
  return fresh;
}

// ============================================================================
// LEGACY SCHEMA SHAPES FROM PRODUCTION
// ============================================================================

/**
 * The legacy service_accounts table from production (2026-10-16) that caused
 * the migration failure. It had:
 * - actor_id TEXT NOT NULL UNIQUE
 * - revoked_at INTEGER
 * - Missing: token_hash, token_salt, is_active
 * 
 * This shape is incompatible with the current schema which requires:
 * - token_hash TEXT NOT NULL
 * - token_salt TEXT NOT NULL
 * - is_active BOOLEAN DEFAULT TRUE
 * - actor_id TEXT (nullable, references actors(id))
 */
const LEGACY_SERVICE_ACCOUNTS = `CREATE TABLE service_accounts (
    id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL UNIQUE,
    scopes TEXT NOT NULL,
    organization_id TEXT,
    description TEXT,
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    revoked_at INTEGER,
    FOREIGN KEY (actor_id) REFERENCES actors(id),
    FOREIGN KEY (organization_id) REFERENCES organizations(id)
)`;

/**
 * Another legacy variant: service_accounts with token_hash/token_salt
 * but missing is_active column.
 */
const LEGACY_SERVICE_ACCOUNTS_MISSING_IS_ACTIVE = `CREATE TABLE service_accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    organization_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    token_salt TEXT NOT NULL,
    scopes TEXT NOT NULL CHECK(scopes IN ('read', 'write', 'read_write')),
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    last_used_at INTEGER,
    FOREIGN KEY (organization_id) REFERENCES organizations(id),
    FOREIGN KEY (created_by) REFERENCES actors(id)
)`;

/**
 * Legacy actors table missing the role column (added in m5).
 */
const LEGACY_ACTORS_NO_ROLE = `CREATE TABLE actors (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('human', 'agent')),
    name TEXT NOT NULL,
    github_user_id TEXT,
    trust_score INTEGER DEFAULT 50,
    promotion_authority BOOLEAN DEFAULT FALSE,
    created_at INTEGER NOT NULL
)`;

/**
 * Legacy organizations table missing tombstone columns (added in m5).
 */
const LEGACY_ORGANIZATIONS_NO_TOMBSTONE = `CREATE TABLE organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('github', 'gitlab', 'artifacts')),
    external_id TEXT,
    created_at INTEGER NOT NULL
)`;

/**
 * Legacy promotion_states table missing failure tracking columns (added in m8).
 */
const LEGACY_PROMOTION_STATES_NO_FAILURE = `CREATE TABLE promotion_states (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL,
    spec_id TEXT NOT NULL,
    current_rung TEXT NOT NULL,
    target_rung TEXT NOT NULL,
    status TEXT NOT NULL,
    mode TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    actor_id TEXT,
    metadata TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
)`;

// ============================================================================
// TESTS FOR LEGACY SCHEMA DETECTION
// ============================================================================

afterEach(() => vi.restoreAllMocks());

describe('legacy schema shape detection - service_accounts', () => {
  it('catches the production legacy service_accounts shape (actor_id NOT NULL UNIQUE, missing token_hash/token_salt/is_active)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    
    // Start from m3 ledger
    const old = await populatedM3();
    expect(version(old)).toBe('m3');
    
    // Replace service_accounts with the legacy shape (disable FK temporarily)
    old.raw.exec('PRAGMA foreign_keys = OFF');
    old.raw.exec('DROP TABLE service_accounts');
    old.raw.exec(LEGACY_SERVICE_ACCOUNTS);
    old.raw.exec('PRAGMA foreign_keys = ON');
    
    // Create the reserved actor that the legacy table references
    old.raw.exec(`
      INSERT OR IGNORE INTO actors (id, type, name, github_user_id, trust_score, promotion_authority, created_at) 
      VALUES ('legacy-actor', 'agent', 'legacy-service', NULL, 50, 0, 0)
    `);
    
    // Ensure the org exists
    old.raw.exec(`
      INSERT OR IGNORE INTO organizations (id, name, type, created_at) 
      VALUES ('org-1', 'test-org', 'artifacts', 0)
    `);
    
    // The legacy table needs data to test the migration
    old.raw.exec(`
      INSERT INTO service_accounts (id, actor_id, name, scopes, organization_id, description, created_at, created_by)
      VALUES ('legacy-svc', 'legacy-actor', 'legacy', 'read', 'org-1', 'Legacy account', 0, 'maint')
    `);
    
    // Create a restarted DO over this ledger
    const restarted = makeSqliteState(old.raw, old.kv);
    const spec = makeSpecDo(restarted);
    
    // Migration to m6 should fail with a clear error message
    await expect(spec.init()).rejects.toThrow(/service_accounts has an unexpected shape.*missing: token_hash, token_salt, is_active/s);
    
    // Verify we're stuck at m5 (m4 was additive and succeeded)
    expect(version(restarted)).toBe('m5');
    
    // Verify the table still exists (not dropped)
    expect(tables(restarted)).toContain('service_accounts');
    
    // Verify the legacy columns are present
    const cols = columns(restarted, 'service_accounts');
    expect(cols).toContain('actor_id');
    expect(cols).not.toContain('token_hash');
    expect(cols).not.toContain('token_salt');
    expect(cols).not.toContain('is_active');
    expect(cols).toContain('revoked_at');
  });

  it('catches service_accounts missing only is_active column', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    
    const old = await populatedM3();
    old.raw.exec('PRAGMA foreign_keys = OFF');
    old.raw.exec('DROP TABLE service_accounts');
    old.raw.exec(LEGACY_SERVICE_ACCOUNTS_MISSING_IS_ACTIVE);
    old.raw.exec('PRAGMA foreign_keys = ON');
    
    const restarted = makeSqliteState(old.raw, old.kv);
    const spec = makeSpecDo(restarted);
    
    // Should fail because is_active is missing
    await expect(spec.init()).rejects.toThrow(/service_accounts has an unexpected shape.*missing: is_active/s);
    
    expect(version(restarted)).toBe('m5');
    
    const cols = columns(restarted, 'service_accounts');
    expect(cols).toContain('token_hash');
    expect(cols).toContain('token_salt');
    expect(cols).not.toContain('is_active');
  });

  it('succeeds when service_accounts has all required columns', async () => {
    const old = await populatedM3();
    
    // The m3 ledger already has the correct service_accounts schema
    const restarted = makeSqliteState(old.raw, old.kv);
    const spec = makeSpecDo(restarted);
    
    // Should succeed and reach the latest version
    await spec.init();
    expect(version(restarted)).toBe(LATEST_VERSION);
    
    // Verify service_accounts has all required columns
    const cols = columns(restarted, 'service_accounts');
    expect(cols).toContain('token_hash');
    expect(cols).toContain('token_salt');
    expect(cols).toContain('is_active');
    expect(cols).toContain('actor_id');
  });
});

describe('legacy schema shape detection - actors table', () => {
  it('catches actors table missing role column from legacy schema', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    
    // Create a fresh m3 ledger
    const old = await populatedM3();
    
    // Replace actors table with legacy shape (no role column)
    // Need to drop dependent tables first
    old.raw.exec('PRAGMA foreign_keys = OFF');
    old.raw.exec('DROP TABLE IF EXISTS service_accounts');
    old.raw.exec('DROP TABLE actors');
    old.raw.exec(LEGACY_ACTORS_NO_ROLE);
    
    // Recreate the actor data
    old.raw.exec(`
      INSERT INTO actors (id, type, name, github_user_id, trust_score, promotion_authority, created_at)
      VALUES ('maint', 'human', 'maint', 'maint', 50, 0, 0)
    `);
    
    // Also need to fix the service_accounts to have the right schema for this test
    // (we're testing actors, not service_accounts)
    old.raw.exec(`
      CREATE TABLE service_accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        organization_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        token_salt TEXT NOT NULL,
        scopes TEXT NOT NULL CHECK(scopes IN ('read', 'write', 'read_write')),
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        is_active BOOLEAN DEFAULT TRUE,
        last_used_at INTEGER,
        FOREIGN KEY (organization_id) REFERENCES organizations(id),
        FOREIGN KEY (created_by) REFERENCES actors(id)
      )
    `);
    old.raw.exec('PRAGMA foreign_keys = ON');
    
    const restarted = makeSqliteState(old.raw, old.kv);
    const spec = makeSpecDo(restarted);
    
    // Migration to m5 should succeed (adds role column via ALTER)
    await spec.init();
    
    // Should reach the latest version; m5 adds the role column idempotently
    expect(version(restarted)).toBe(LATEST_VERSION);
    
    // Verify role column was added
    const cols = columns(restarted, 'actors');
    expect(cols).toContain('role');
  });
});

describe('legacy schema shape detection - entity tables', () => {
  it('succeeds when organizations has legacy shape and m5 adds tombstone columns', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    
    const old = await populatedM3();
    
    // Replace organizations with legacy shape (no tombstone columns)
    old.raw.exec('PRAGMA foreign_keys = OFF');
    
    // Just drop and recreate organizations with legacy schema
    old.raw.exec('DROP TABLE organizations');
    old.raw.exec(LEGACY_ORGANIZATIONS_NO_TOMBSTONE);
    
    // Recreate org data
    old.raw.exec(`
      INSERT INTO organizations (id, name, type, external_id, created_at)
      VALUES ('org-1', 'org', 'artifacts', NULL, 0)
    `);
    
    // Fix the repositories to reference the org
    try {
      old.raw.exec("UPDATE repositories SET organization_id = 'org-1' WHERE organization_id IS NULL");
    } catch (e) {}
    
    // Fix service_accounts to reference the org
    try {
      old.raw.exec("UPDATE service_accounts SET organization_id = 'org-1' WHERE organization_id IS NULL");
    } catch (e) {}
    
    old.raw.exec('PRAGMA foreign_keys = ON');
    
    const restarted = makeSqliteState(old.raw, old.kv);
    const spec = makeSpecDo(restarted);
    
    // Migration to m5 should succeed (adds tombstone columns via ALTER)
    await spec.init();
    
    // Should reach the latest version
    expect(version(restarted)).toBe(LATEST_VERSION);
    
    // Verify tombstone columns were added
    const cols = columns(restarted, 'organizations');
    expect(cols).toContain('deleted_at');
    expect(cols).toContain('deleted_by');
    expect(cols).toContain('delete_reason');
  });
});

describe('legacy schema shape detection - promotion ledger tables', () => {
  it('succeeds when tournaments has legacy shape and m8 adds failure tracking columns', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    
    // Create a fresh latest-version ledger
    const old = await freshLatestLedger();
    
    // Replace tournaments with legacy shape (no version/failure columns)
    old.raw.exec('PRAGMA foreign_keys = OFF');
    old.raw.exec('DROP TABLE tournaments');
    old.raw.exec(`
      CREATE TABLE tournaments (
        id TEXT PRIMARY KEY,
        spec_id TEXT NOT NULL,
        status TEXT NOT NULL,
        winner TEXT,
        candidates TEXT NOT NULL,
        comparisons TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    old.raw.exec('PRAGMA foreign_keys = ON');
    
    // Set version back to m7 so m8 migration runs
    old.raw.exec("UPDATE metadata SET value = 'm7' WHERE key = 'schema_version'");
    
    const restarted = makeSqliteState(old.raw, old.kv);
    const spec = makeSpecDo(restarted);
    
    // Should succeed - m8 adds columns idempotently via applyLedgerCas
    await spec.init();
    expect(version(restarted)).toBe(LATEST_VERSION);
    
    // Verify failure columns were added to tournaments
    const cols = columns(restarted, 'tournaments');
    expect(cols).toContain('version');
    expect(cols).toContain('failure_reason');
    expect(cols).toContain('failed_at');
    expect(cols).toContain('attempts');
  });
});

describe('production schema dump simulation', () => {
  /**
   * Simulates loading a production schema dump and verifying that
   * migrations detect incompatibilities.
   */
  it('detects multiple legacy tables in a production dump scenario', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    
    // Start from m3
    const old = await populatedM3();
    
    // Apply multiple legacy schema shapes that might come from production
    old.raw.exec('PRAGMA foreign_keys = OFF');
    
    // Drop service_accounts first since we'll replace it
    old.raw.exec('DROP TABLE service_accounts');
    
    // 1. Legacy actors (no role column)
    old.raw.exec('DROP TABLE actors');
    old.raw.exec(LEGACY_ACTORS_NO_ROLE);
    old.raw.exec(`
      INSERT INTO actors (id, type, name, github_user_id, trust_score, promotion_authority, created_at)
      VALUES ('svc-actor-1', 'agent', 'svc-actor', NULL, 50, 0, 0),
             ('maint', 'human', 'maint', 'maint', 50, 0, 0)
    `);
    
    // 2. Legacy service_accounts (the main issue from production)
    old.raw.exec(LEGACY_SERVICE_ACCOUNTS);
    
    // Insert data
    old.raw.exec(`
      INSERT INTO service_accounts (id, actor_id, name, scopes, organization_id, description, created_at, created_by)
      VALUES ('prod-svc-1', 'svc-actor-1', 'prod-svc', 'read', 'org-1', 'Production service account', 0, 'maint')
    `);
    
    old.raw.exec('PRAGMA foreign_keys = ON');
    
    const restarted = makeSqliteState(old.raw, old.kv);
    const spec = makeSpecDo(restarted);
    
    // Migration should fail on service_accounts (missing token_hash, token_salt, is_active)
    await expect(spec.init()).rejects.toThrow(/service_accounts has an unexpected shape/s);
    
    // Should be stuck at m5
    expect(version(restarted)).toBe('m5');
    
    // Verify the problematic table is still present
    expect(tables(restarted)).toContain('service_accounts');
  });

  it('verifies empty legacy service_accounts table can be dropped and recreated', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    
    const old = await populatedM3();
    
    // Replace with empty legacy service_accounts
    old.raw.exec('PRAGMA foreign_keys = OFF');
    old.raw.exec('DROP TABLE service_accounts');
    old.raw.exec(LEGACY_SERVICE_ACCOUNTS);
    old.raw.exec('PRAGMA foreign_keys = ON');
    
    // No data in the legacy table
    const restarted = makeSqliteState(old.raw, old.kv);
    const spec = makeSpecDo(restarted);
    
    // Should fail on m6
    await expect(spec.init()).rejects.toThrow(/service_accounts has an unexpected shape.*missing: token_hash, token_salt, is_active/s);
    expect(version(restarted)).toBe('m5');
    
    // Drop the empty legacy table
    restarted.raw.exec('PRAGMA foreign_keys = OFF');
    restarted.raw.exec('DROP TABLE service_accounts');
    restarted.raw.exec('PRAGMA foreign_keys = ON');
    
    // Now migration should succeed
    await spec.init();
    expect(version(restarted)).toBe(LATEST_VERSION);
    
    // Verify service_accounts was recreated with correct schema
    const cols = columns(restarted, 'service_accounts');
    expect(cols).toContain('token_hash');
    expect(cols).toContain('token_salt');
    expect(cols).toContain('is_active');
    expect(cols).toContain('actor_id');
  });
});

describe('legacy schema validation utilities', () => {
  it('validates that all expected tables exist after migration', async () => {
    const s = makeSqliteState();
    await makeSpecDo(s).init();
    
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
      'canary_metrics',
      'purge_log',
    ];
    
    for (const table of expectedTables) {
      expect(tables(s), `Table ${table} should exist after migration`).toContain(table);
    }
  });

  it('validates that service_accounts has all required columns after migration', async () => {
    const s = makeSqliteState();
    await makeSpecDo(s).init();
    
    const cols = columns(s, 'service_accounts');
    
    const requiredColumns = [
      'id',
      'name',
      'description',
      'organization_id',
      'token_hash',
      'token_salt',
      'scopes',
      'created_by',
      'created_at',
      'expires_at',
      'is_active',
      'last_used_at',
      'actor_id',
    ];
    
    for (const col of requiredColumns) {
      expect(cols, `service_accounts should have column ${col}`).toContain(col);
    }
    
    // Should NOT have legacy columns
    expect(cols).not.toContain('revoked_at');
  });

  it('validates that actors has all required columns after migration', async () => {
    const s = makeSqliteState();
    await makeSpecDo(s).init();
    
    const cols = columns(s, 'actors');
    
    const requiredColumns = [
      'id',
      'type',
      'name',
      'github_user_id',
      'trust_score',
      'promotion_authority',
      'created_at',
      'role',
    ];
    
    for (const col of requiredColumns) {
      expect(cols, `actors should have column ${col}`).toContain(col);
    }
  });

  it('validates entity tables have tombstone columns after migration', async () => {
    const s = makeSqliteState();
    await makeSpecDo(s).init();
    
    const entityTables = ['organizations', 'repositories', 'specs', 'candidates', 'issues'];
    const tombstoneColumns = ['deleted_at', 'deleted_by', 'delete_reason'];
    
    for (const table of entityTables) {
      const cols = columns(s, table);
      for (const col of tombstoneColumns) {
        expect(cols, `${table} should have tombstone column ${col}`).toContain(col);
      }
    }
  });

  it('validates promotion ledger tables have version columns after migration', async () => {
    const s = makeSqliteState();
    await makeSpecDo(s).init();
    
    // tournaments should have version column
    const tournamentCols = columns(s, 'tournaments');
    expect(tournamentCols).toContain('version');
    expect(tournamentCols).toContain('failure_reason');
    expect(tournamentCols).toContain('failed_at');
    expect(tournamentCols).toContain('attempts');
    
    // merge_trains should have version column
    const mergeTrainCols = columns(s, 'merge_trains');
    expect(mergeTrainCols).toContain('version');
  });
});
