/**
 * Beehive Spec Durable Object
 * 
 * Orchestration spine - hand-written, not agent-generated.
 * This is the single source of truth for all coordination state.
 * 
 * Tables: organizations, repositories, actors, specs, candidates, 
 *         gate_verdicts, trials, promotions, issues, and their links.
 */

import { DurableObject } from '@cloudflare/workers-types/experimental';
import { createSqlStorage, SqlDb } from './sql-storage';

// Schema SQL (inlined; esbuild has no ?raw loader for .sql in wrangler builds)
import { SCHEMA_SQL, SERVICE_ACCOUNTS_SQL } from './schema-inline';

class ConflictError extends Error {}

// Service binding type for Gate Workflow
type Service = { fetch: (request: Request) => Promise<Response> };

// Seed data for local development
import { seedDatabase, isSeeded } from './seed';

// Artifacts client
import { createFork, createRepoToken, type ArtifactsConfig } from '../shared/artifacts';

// Types
import type {
  CreateOrganizationRequest,
  CreateActorRequest,
  UpdateActorTrustRequest,
  CreateRepositoryRequest,
  CreateSpecRequest,
  UpdateSpecStageRequest,
  CreateCandidateRequest,
  UpdateCandidateStageRequest,
  CreateGateVerdictRequest,
  CreateTrialRequest,
  DecideTrialRequest,
  CreatePromotionRequest,
  CreateIssueRequest,
  UpdateIssueStageRequest,
  UpdateIssueCommentPolicyRequest,
  CreateIssueCommentRequest,
  CreateIssueSpecLinkRequest,
  CreateIssueCandidateLinkRequest,
  ComparisonMetrics,
  OrganizationResponse,
  ActorResponse,
  RepositoryResponse,
  SpecResponse,
  CandidateResponse,
  GateVerdictResponse,
  TrialResponse,
  PromotionResponse,
  IssueResponse,
  IssueCommentResponse,
  IssueSpecLinkResponse,
  IssueCandidateLinkResponse,
  CreateServiceAccountRequest,
} from '../api/types';

interface Env {
  SPEC_DO: DurableObjectNamespace;
  GATE_WORKFLOW: Service;
  API_AUTH_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
}

interface ActorRow {
  id: string;
  type: 'human' | 'agent';
  name: string;
  github_user_id?: string;
  trust_score: number;
  promotion_authority: boolean;
  created_at: number;
}

interface SpecRow {
  id: string;
  name: string;
  description?: string;
  contract: string;
  declared_delta_surface: string;
  organization_id: string;
  created_by: string;
  created_at: number;
  stage: 'draft' | 'proposed' | 'active' | 'deprecated' | 'archived';
}

interface CandidateRow {
  id: string;
  spec_id: string;
  repository_id: string;
  commit_sha: string;
  base_commit_sha: string;
  agent_id: string;
  created_at: number;
  stage: 'pending' | 'passed_premerge' | 'passed_shadow' | 'passed_train' | 'passed_canary' | 'promoted' | 'failed' | 'rolled_back';
  preview_url?: string;
  preview_worker_name?: string;
  preview_created_at?: number;
  shadow_match?: boolean;
  shadow_score?: number;
  shadow_metrics?: string;
}

interface GateVerdictRow {
  id: string;
  candidate_id: string;
  gate: 'pre-merge' | 'shadow' | 'train' | 'canary' | 'full';
  status: 'pass' | 'fail' | 'pending';
  score: number;
  complexity_delta: number;
  notes?: string;
  created_at: number;
  decided_by: string;
  stage: 'pending' | 'passed' | 'failed';
}

interface TrialRow {
  id: string;
  spec_id: string;
  candidate_a_id: string;
  candidate_b_id: string;
  winner_id?: string;
  comparison_metrics: string; // JSON
  decided_at: number;
  decided_by: string;
  stage: 'pending' | 'comparing' | 'decided';
}

interface IssueRow {
  id: string;
  number: number;
  repository_id: string;
  title: string;
  body?: string;
  status: 'open' | 'closed';
  labels?: string;
  created_at: number;
  created_by: string;
  closed_at?: number;
  closed_by?: string;
  comment_policy: 'open' | 'maintainers_only' | 'locked';
  visibility: 'public' | 'internal' | 'private';
  stage: 'reported' | 'spec_needed' | 'spec_defining' | 'spec_defined' | 'implementing' | 'validating' | 'merged' | 'closed';
}

interface OrganizationRow {
  id: string;
  name: string;
  type: 'github' | 'gitlab' | 'artifacts';
  external_id?: string;
  created_at: number;
}

interface RepositoryRow {
  id: string;
  name: string;
  organization_id: string;
  repo_type: 'baseline' | 'candidate';
  spec_id?: string;
  agent_id?: string;
  external_id?: string;
  remote_url: string;
  namespace: string;
  default_branch: string;
  created_at: number;
}

interface PromotionRow {
  id: string;
  candidate_id: string;
  promoted_to: string;
  promoted_at: number;
  promoted_by: string;
  notes?: string;
}

interface IssueCommentRow {
  id: string;
  issue_id: string;
  body: string;
  created_by: string;
  created_at: number;
}

// Entity types for history tracking
type EntityType = 'issue' | 'candidate' | 'spec' | 'trial' | 'promotion' | 'gate_verdict' | 'service_account';
type EntityStage = string; // Varies by entity type

interface EntityHistoryRow {
  id: string;
  entity_type: EntityType;
  entity_id: string;
  stage: EntityStage;
  changed_by: string;
  changed_at: number;
  notes?: string;
  metadata?: string;
}

// Service Account types
interface ServiceAccountRow {
  id: string;
  name: string;
  description?: string;
  organization_id: string;
  token_hash: string;
  token_salt: string;
  scopes: 'read' | 'write' | 'read_write';
  created_by: string;
  created_at: number;
  expires_at?: number;
  is_active: boolean;
  last_used_at?: number;
}

// Helper to generate UUIDs
function generateId(): string {
  return crypto.randomUUID();
}

// Helper to get current timestamp
function now(): number {
  return Date.now();
}

export class SpecDO {
  state: DurableObjectState;
  env: Env;
  db: SqlDb | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async init() {
    // Initialize SQLite database
    this.db = createSqlStorage(this.state);
    
    // Check if we need to initialize the schema
    const initSql = await this.state.storage.get<string>('schema_init');
    if (!initSql) {
      // Execute schema
      this.db.exec(SCHEMA_SQL);
      
      // Mark as initialized
      await this.state.storage.put('schema_init', 'true');
      
      // Initialize metadata
      // Fresh statement per write: the adapter does not re-execute a reused
      // statement after its first step(), which silently dropped the second row.
      const insertMeta = (key: string, value: string) => {
        const stmt = this.db!.prepare(
          'INSERT OR IGNORE INTO metadata (key, value, updated_at) VALUES (?, ?, ?)'
        );
        stmt.bind(key, value, now());
        stmt.step();
        stmt.free();
      };
      insertMeta('schema_version', 'm2');
      insertMeta('initialized_at', String(now()));
    } else {
      // Run schema migrations for existing databases
      await this.runMigrations();
    }

    this.ensureServiceAccountTables();
    
    // Seed database in development if not already seeded
    // This only runs in local development (Miniflare)
    if ('DEV' in this.env && (this.env as { DEV?: string }).DEV === 'local' && !isSeeded(this.db)) {
      seedDatabase(this.db);
    }
  }

  /**
   * Additive, idempotent. Errors are logged, never thrown: init() runs outside
   * fetch's try, and the master-token path must survive a DDL failure.
   * Service-token verify then fails closed (503) because the tables are missing.
   */
  private ensureServiceAccountTables(): void {
    if (!this.db) return;
    try {
      this.db.exec(SERVICE_ACCOUNTS_SQL);
      // Only advance m2 -> m3; never mask a stuck m1.
      const stmt = this.db.prepare(
        "UPDATE metadata SET value = 'm3', updated_at = ? WHERE key = 'schema_version' AND value = 'm2'"
      );
      stmt.bind(now());
      stmt.step();
      stmt.free();
    } catch (e) {
      console.log('[SpecDO] service account tables unavailable:', e instanceof Error ? e.message : String(e));
    }
  }

  // ============================================================================
  // SERVICE ACCOUNTS (read-only token slice)
  // ============================================================================

  private queryAll(sql: string, ...values: (string | number | null)[]): Record<string, unknown>[] {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare(sql);
    if (values.length) stmt.bind(...values);
    const rows: Record<string, unknown>[] = [];
    while (stmt.step()) {
      const row = stmt.getRow();
      if (row) rows.push(row);
    }
    stmt.free();
    return rows;
  }

  private run(sql: string, ...values: (string | number | null)[]): void {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare(sql);
    if (values.length) stmt.bind(...values);
    stmt.step();
    stmt.free();
  }

  /** Null when the token is unknown, revoked or expired. Reads promotion_authority live. */
  verifyServiceTokenHash(tokenHash: string): Record<string, unknown> | null {
    const rows = this.queryAll(
      `SELECT sa.expires_at AS token_expires, sa.is_active AS account_active,
              sa.id AS account_id, sa.actor_id, sa.scopes, sa.organization_id,
              ac.promotion_authority
       FROM service_accounts sa
       JOIN actors ac ON ac.id = sa.actor_id
       WHERE sa.token_hash = ? AND sa.is_active = 1`,
      tokenHash
    );
    const r = rows[0];
    if (!r) return null;
    if ((r.token_expires != null && (r.token_expires as number) <= now())) return null;
    return {
      actorId: r.actor_id,
      serviceAccountId: r.account_id,
      scopes: r.scopes,
      organizationId: r.organization_id,
      promotionAuthority: Boolean(r.promotion_authority),
    };
  }

  /**
   * Run schema migrations for existing databases
   * This ensures that ALTER TABLE statements are executed even for DOs
   * that were created before certain columns were added to the schema.
   */
  async runMigrations(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');
    
    // Get current schema version
    const getVersion = this.db.prepare('SELECT value FROM metadata WHERE key = ?');
    getVersion.bind('schema_version');
    let currentVersion = 'm1';
    if (getVersion.step()) {
      currentVersion = getVersion.get(0) as string;
    }
    getVersion.free();
    
    // Migration from m1 to m2: Add preview columns to candidates table
    // SQLite's ALTER TABLE ADD COLUMN is idempotent, so we can run it safely
    if (currentVersion === 'm1') {
      try {
        this.db.exec(`
          ALTER TABLE candidates ADD COLUMN preview_url TEXT;
          ALTER TABLE candidates ADD COLUMN preview_worker_name TEXT;
          ALTER TABLE candidates ADD COLUMN preview_created_at INTEGER;
        `);
        
        // Update schema version
        const updateVersion = this.db.prepare(
          'INSERT OR REPLACE INTO metadata (key, value, updated_at) VALUES (?, ?, ?)'
        );
        updateVersion.bind('schema_version', 'm2', now());
        updateVersion.step();
        updateVersion.free();
      } catch (e) {
        // If migration fails (e.g., columns already exist), that's okay
        console.log('[SpecDO] Migration to m2: columns may already exist, continuing');
      }
    }
  }

  // ============================================================================
  // ENTITY HISTORY
  // ============================================================================

  recordHistory(
    entityType: EntityType,
    entityId: string,
    stage: EntityStage,
    changedBy: string,
    notes?: string,
    metadata?: string
  ): void {
    if (!this.db) throw new Error('Database not initialized');
    
    const stmt = this.db.prepare(
      `INSERT INTO entity_history (id, entity_type, entity_id, stage, changed_by, changed_at, notes, metadata) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.bind(
      generateId(),
      entityType,
      entityId,
      stage,
      changedBy,
      now(),
      notes || null,
      metadata || null
    );
    stmt.step();
    stmt.free();
  }

  // ============================================================================
  // ORGANIZATIONS
  // ============================================================================

  createOrganization(
    name: string,
    type: 'github' | 'gitlab' | 'artifacts',
    externalId?: string
  ): { id: string; name: string; type: string; externalId?: string; createdAt: number } {
    if (!this.db) throw new Error('Database not initialized');

    // The DO is single-threaded and this check + insert has no await between them,
    // so this is race-free. Not a UNIQUE index: existing ledgers already hold duplicates.
    const dup = this.db.prepare(`SELECT id FROM organizations WHERE name = ? LIMIT 1`);
    dup.bind(name);
    const exists = dup.step();
    dup.free();
    if (exists) throw new ConflictError(`Organization '${name}' already exists`);

    const id = generateId();
    const stmt = this.db.prepare(
      `INSERT INTO organizations (id, name, type, external_id, created_at) 
       VALUES (?, ?, ?, ?, ?)`
    );
    stmt.bind(id, name, type, externalId || null, now());
    stmt.step();
    stmt.free();
    
    return {
      id,
      name,
      type,
      externalId,
      createdAt: now(),
    };
  }

  getOrganization(id: string): OrganizationRow | null {
    if (!this.db) throw new Error('Database not initialized');
    
    const stmt = this.db.prepare(
      `SELECT * FROM organizations WHERE id = ?`
    );
    stmt.bind(id);
    const has = stmt.step();
    const row = has ? this.rowToOrganization(stmt) : null;
    stmt.free();
    
    if (!row) return null;
    return row;
  }

  // ============================================================================
  // ACTORS
  // ============================================================================

  createActor(
    type: 'human' | 'agent',
    name: string,
    githubUserId?: string
  ): ActorRow {
    if (!this.db) throw new Error('Database not initialized');
    
    const id = generateId();
    const stmt = this.db.prepare(
      `INSERT INTO actors (id, type, name, github_user_id, trust_score, promotion_authority, created_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.bind(id, type, name, githubUserId || null, 50, 0, now());
    stmt.step();
    stmt.free();
    
    return {
      id,
      type,
      name,
      github_user_id: githubUserId,
      trust_score: 50,
      promotion_authority: false,
      created_at: now(),
    };
  }

  getActor(id: string): ActorRow | null {
    if (!this.db) throw new Error('Database not initialized');
    
    const stmt = this.db.prepare(
      `SELECT * FROM actors WHERE id = ?`
    );
    stmt.bind(id);
    const has = stmt.step();
    const row = has ? this.rowToActor(stmt) : null;
    stmt.free();
    
    if (!row) return null;
    return row;
  }

  updateActorTrustScore(id: string, score: number): void {
    if (!this.db) throw new Error('Database not initialized');
    
    const stmt = this.db.prepare(
      `UPDATE actors SET trust_score = ? WHERE id = ?`
    );
    stmt.bind(score, id);
    stmt.step();
    stmt.free();
  }

  grantPromotionAuthority(id: string): void {
    if (!this.db) throw new Error('Database not initialized');
    
    const stmt = this.db.prepare(
      `UPDATE actors SET promotion_authority = true WHERE id = ?`
    );
    stmt.bind(id);
    stmt.step();
    stmt.free();
  }

  // ============================================================================
  // SPECS
  // ============================================================================

  createSpec(
    name: string,
    description: string,
    contract: string,
    declaredDeltaSurface: string[],
    organizationId: string,
    createdBy: string
  ): SpecRow {
    if (!this.db) throw new Error('Database not initialized');
    
    const id = generateId();
    const declaredDeltaSurfaceJson = JSON.stringify(declaredDeltaSurface);
    
    const stmt = this.db.prepare(
      `INSERT INTO specs (id, name, description, contract, declared_delta_surface, organization_id, created_by, created_at, stage) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.bind(id, name, description, contract, declaredDeltaSurfaceJson, organizationId, createdBy, now(), 'draft');
    stmt.step();
    stmt.free();
    
    // Record history
    this.recordHistory('spec', id, 'draft', createdBy, 'Spec created');
    
    return {
      id,
      name,
      description,
      contract,
      declared_delta_surface: declaredDeltaSurfaceJson,
      organization_id: organizationId,
      created_by: createdBy,
      created_at: now(),
      stage: 'draft',
    };
  }

  getSpec(id: string): SpecRow | null {
    if (!this.db) throw new Error('Database not initialized');
    
    const stmt = this.db.prepare(
      `SELECT * FROM specs WHERE id = ?`
    );
    stmt.bind(id);
    const has = stmt.step();
    const row = has ? this.rowToSpec(stmt) : null;
    stmt.free();
    
    if (!row) return null;
    return row;
  }

  transitionSpec(id: string, newStage: SpecRow['stage'], changedBy: string, notes?: string): void {
    if (!this.db) throw new Error('Database not initialized');
    
    // Update spec
    const updateStmt = this.db.prepare(
      `UPDATE specs SET stage = ? WHERE id = ?`
    );
    updateStmt.bind(newStage, id);
    updateStmt.step();
    updateStmt.free();
    
    // Record history
    this.recordHistory('spec', id, newStage, changedBy, notes);
  }

  // ============================================================================
  // CANDIDATES
  // ============================================================================

  createCandidate(
    specId: string,
    repositoryId: string,
    commitSha: string,
    baseCommitSha: string,
    agentId: string
  ): CandidateRow {
    if (!this.db) throw new Error('Database not initialized');
    
    const id = generateId();
    const stmt = this.db.prepare(
      `INSERT INTO candidates (id, spec_id, repository_id, commit_sha, base_commit_sha, agent_id, created_at, stage) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.bind(id, specId, repositoryId, commitSha, baseCommitSha, agentId, now(), 'pending');
    stmt.step();
    stmt.free();
    
    // Record history
    this.recordHistory('candidate', id, 'pending', agentId, 'Candidate created');
    
    return {
      id,
      spec_id: specId,
      repository_id: repositoryId,
      commit_sha: commitSha,
      base_commit_sha: baseCommitSha,
      agent_id: agentId,
      created_at: now(),
      stage: 'pending',
      preview_url: undefined,
      preview_worker_name: undefined,
      preview_created_at: undefined,
      shadow_match: undefined,
      shadow_score: undefined,
      shadow_metrics: undefined,
    };
  }

  getCandidate(id: string): CandidateRow | null {
    if (!this.db) throw new Error('Database not initialized');
    
    const stmt = this.db.prepare(
      `SELECT * FROM candidates WHERE id = ?`
    );
    stmt.bind(id);
    const has = stmt.step();
    const row = has ? this.rowToCandidate(stmt) : null;
    stmt.free();
    
    if (!row) return null;
    return row;
  }

  transitionCandidate(id: string, newStage: CandidateRow['stage'], changedBy: string, notes?: string): void {
    if (!this.db) throw new Error('Database not initialized');
    
    const updateStmt = this.db.prepare(
      `UPDATE candidates SET stage = ? WHERE id = ?`
    );
    updateStmt.bind(newStage, id);
    updateStmt.step();
    updateStmt.free();
    
    this.recordHistory('candidate', id, newStage, changedBy, notes);
  }

  updateCandidatePreview(
    id: string,
    previewUrl: string,
    previewWorkerName?: string,
    previewCreatedAt?: number
  ): void {
    if (!this.db) throw new Error('Database not initialized');
    
    const updateStmt = this.db.prepare(
      `UPDATE candidates SET preview_url = ?, preview_worker_name = ?, preview_created_at = ? WHERE id = ?`
    );
    updateStmt.bind(previewUrl, previewWorkerName || null, previewCreatedAt || 0, id);
    updateStmt.step();
    updateStmt.free();
  }

  // ============================================================================
  // CANDIDATE CLAIM (Agent claims a spec, platform creates fork)
  // ============================================================================

  async claimSpec(
    specId: string,
    agentId: string
  ): Promise<{
    candidateId: string;
    repositoryId: string;
    repositoryName: string;
    repositoryUrl: string;
    namespace: string;
    token: string;
    tokenExpiresAt: number;
    spec: SpecRow;
  }> {
    if (!this.db) throw new Error('Database not initialized');

    const spec = this.getSpec(specId);
    if (!spec) {
      throw new Error(`Spec not found: ${specId}`);
    }

    // Use org name as namespace for isolation
    const org = this.getOrganization(spec.organization_id);
    if (!org) {
      throw new Error(`Organization not found: ${spec.organization_id}`);
    }
    const namespace = org.name;
    const repoName = `candidate-${specId.slice(0, 8)}-${agentId.slice(0, 8)}`;

    // Get Artifacts config from environment
    const artifactsConfig: ArtifactsConfig = {
      accountId: this.env.CLOUDFLARE_ACCOUNT_ID || '',
      apiToken: this.env.CLOUDFLARE_API_TOKEN || '',
      namespace,
    };

    // Create real fork via Artifacts API
    const fork = await createFork(artifactsConfig, spec.name, repoName, agentId);

    const repositoryId = generateId();
    const remoteUrl = fork.remoteUrl;

    const repoStmt = this.db.prepare(
      `INSERT INTO repositories 
       (id, name, organization_id, repo_type, spec_id, agent_id, remote_url, namespace, default_branch, created_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    repoStmt.bind(
      repositoryId,
      repoName,
      spec.organization_id,
      'candidate',
      specId,
      agentId,
      remoteUrl,
      namespace,
      'main',
      now()
    );
    repoStmt.step();
    repoStmt.free();

    const candidateId = generateId();
    const candidateStmt = this.db.prepare(
      `INSERT INTO candidates 
       (id, spec_id, repository_id, commit_sha, base_commit_sha, agent_id, created_at, stage) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    candidateStmt.bind(
      candidateId,
      specId,
      repositoryId,
      '',
      '',
      agentId,
      now(),
      'pending'
    );
    candidateStmt.step();
    candidateStmt.free();

    this.recordHistory('candidate', candidateId, 'pending', agentId, 'Candidate claimed spec');

    return {
      candidateId,
      repositoryId,
      repositoryName: repoName,
      repositoryUrl: fork.remoteUrl,
      namespace: fork.namespace,
      token: fork.token,
      tokenExpiresAt: fork.tokenExpiresAt,
      spec,
    };
  }

  // ============================================================================
  // GATE VERDICTS
  // ============================================================================

  createGateVerdict(
    candidateId: string,
    gate: GateVerdictRow['gate'],
    status: GateVerdictRow['status'],
    score: number,
    complexityDelta: number,
    decidedBy: string,
    notes?: string
  ): GateVerdictRow {
    if (!this.db) throw new Error('Database not initialized');
    
    const id = generateId();
    const stmt = this.db.prepare(
      `INSERT INTO gate_verdicts 
       (id, candidate_id, gate, status, score, complexity_delta, notes, created_at, decided_by, stage) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.bind(id, candidateId, gate, status, score, complexityDelta, notes || null, now(), decidedBy, 'pending');
    stmt.step();
    stmt.free();
    
    this.recordHistory('gate_verdict', id, status, decidedBy, notes);
    
    return {
      id,
      candidate_id: candidateId,
      gate,
      status,
      score,
      complexity_delta: complexityDelta,
      notes,
      created_at: now(),
      decided_by: decidedBy,
      stage: 'pending',
    };
  }

  getGateVerdict(candidateId: string, gate: GateVerdictRow['gate']): GateVerdictRow | null {
    if (!this.db) throw new Error('Database not initialized');
    
    const stmt = this.db.prepare(
      `SELECT * FROM gate_verdicts WHERE candidate_id = ? AND gate = ?`
    );
    stmt.bind(candidateId, gate);
    const has = stmt.step();
    const row = has ? this.rowToGateVerdict(stmt) : null;
    stmt.free();
    
    if (!row) return null;
    return row;
  }

  // ============================================================================
  // TRIALS
  // ============================================================================

  createTrial(
    specId: string,
    candidateAId: string,
    candidateBId: string,
    decidedBy: string
  ): TrialRow {
    if (!this.db) throw new Error('Database not initialized');
    
    const id = generateId();
    const comparisonMetrics = JSON.stringify({});
    
    const stmt = this.db.prepare(
      `INSERT INTO trials 
       (id, spec_id, candidate_a_id, candidate_b_id, winner_id, comparison_metrics, decided_at, decided_by, stage) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.bind(id, specId, candidateAId, candidateBId, null, comparisonMetrics, null, decidedBy, 'pending');
    stmt.step();
    stmt.free();
    
    this.recordHistory('trial', id, 'pending', decidedBy, 'Trial created');
    
    return {
      id,
      spec_id: specId,
      candidate_a_id: candidateAId,
      candidate_b_id: candidateBId,
      decided_at: 0,
      decided_by: decidedBy,
      stage: 'pending',
      comparison_metrics: comparisonMetrics,
    };
  }

  decideTrial(
    trialId: string,
    winnerId: string,
    comparisonMetrics: Record<string, any>,
    decidedBy: string
  ): void {
    if (!this.db) throw new Error('Database not initialized');
    
    const metricsJson = JSON.stringify(comparisonMetrics);
    
    const stmt = this.db.prepare(
      `UPDATE trials SET winner_id = ?, comparison_metrics = ?, decided_at = ?, decided_by = ?, stage = ? 
       WHERE id = ?`
    );
    stmt.bind(winnerId, metricsJson, now(), decidedBy, 'decided', trialId);
    stmt.step();
    stmt.free();
    
    this.recordHistory('trial', trialId, 'decided', decidedBy, 'Trial decided');
  }

  getTrial(id: string): TrialRow | null {
    if (!this.db) throw new Error('Database not initialized');
    
    const stmt = this.db.prepare(
      `SELECT * FROM trials WHERE id = ?`
    );
    stmt.bind(id);
    const has = stmt.step();
    const row = has ? this.rowToTrial(stmt) : null;
    stmt.free();
    
    if (!row) return null;
    return row;
  }

  // ============================================================================
  // ISSUES
  // ============================================================================

  createIssue(
    number: number,
    repositoryId: string,
    title: string,
    body: string,
    createdBy: string,
    labels?: string[]
  ): IssueRow {
    if (!this.db) throw new Error('Database not initialized');
    
    const id = generateId();
    const labelsJson = labels ? JSON.stringify(labels) : null;
    
    const stmt = this.db.prepare(
      `INSERT INTO issues 
       (id, number, repository_id, title, body, status, labels, created_at, created_by, comment_policy, visibility, stage) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.bind(id, number, repositoryId, title, body, 'open', labelsJson, now(), createdBy, 'open', 'public', 'reported');
    stmt.step();
    stmt.free();
    
    this.recordHistory('issue', id, 'reported', createdBy, 'Issue created');
    
    return {
      id,
      number,
      repository_id: repositoryId,
      title,
      body: body ?? undefined,
      status: 'open',
      labels: labelsJson ?? undefined,
      created_at: now(),
      created_by: createdBy,
      comment_policy: 'open',
      visibility: 'public',
      stage: 'reported',
    };
  }

  transitionIssue(id: string, newStage: IssueRow['stage'], changedBy: string, notes?: string): void {
    if (!this.db) throw new Error('Database not initialized');
    
    const updateStmt = this.db.prepare(
      `UPDATE issues SET stage = ? WHERE id = ?`
    );
    updateStmt.bind(newStage, id);
    updateStmt.step();
    updateStmt.free();
    
    this.recordHistory('issue', id, newStage, changedBy, notes);
  }

  // ============================================================================
  // PROMOTIONS
  // ============================================================================

  createPromotion(
    candidateId: string,
    fromRung: 'pre-merge' | 'shadow' | 'train' | 'canary' | 'full',
    toRung: 'pre-merge' | 'shadow' | 'train' | 'canary' | 'full',
    promotedBy: string
  ): { id: string; candidateId: string; fromRung: string; toRung: string; promotedAt: number; promotedBy: string } {
    if (!this.db) throw new Error('Database not initialized');
    
    const id = generateId();
    const stmt = this.db.prepare(
      `INSERT INTO promotions (id, candidate_id, from_rung, to_rung, promoted_at, promoted_by, stage) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.bind(id, candidateId, fromRung, toRung, now(), promotedBy, 'pending');
    stmt.step();
    stmt.free();
    
    this.recordHistory('promotion', id, 'pending', promotedBy, 'Promotion created');
    
    return {
      id,
      candidateId,
      fromRung,
      toRung,
      promotedAt: now(),
      promotedBy,
    };
  }

  // ============================================================================
  // UTILITY - Row Converters
  // ============================================================================

  private rowToObject(stmt: { getRow(): Record<string, unknown> | null }): Record<string, any> {
    return stmt.getRow() ?? {};
  }

  private rowToOrganization(stmt: { getRow(): Record<string, unknown> | null }): OrganizationRow | null {
    const row = stmt.getRow();
    if (!row) return null;
    return {
      id: row.id as string,
      name: row.name as string,
      type: row.type as 'github' | 'gitlab' | 'artifacts',
      external_id: row.external_id as string | undefined,
      created_at: row.created_at as number,
    };
  }

  private rowToRepository(stmt: { getRow(): Record<string, unknown> | null }): RepositoryRow | null {
    const row = stmt.getRow();
    if (!row) return null;
    return {
      id: row.id as string,
      name: row.name as string,
      organization_id: row.organization_id as string,
      repo_type: row.repo_type as 'baseline' | 'candidate',
      spec_id: row.spec_id as string | undefined,
      agent_id: row.agent_id as string | undefined,
      external_id: row.external_id as string | undefined,
      remote_url: row.remote_url as string,
      namespace: row.namespace as string,
      default_branch: row.default_branch as string,
      created_at: row.created_at as number,
    };
  }

  private rowToActor(stmt: { getRow(): Record<string, unknown> | null }): ActorRow | null {
    const row = stmt.getRow();
    if (!row) return null;
    return {
      id: row.id as string,
      type: row.type as 'human' | 'agent',
      name: row.name as string,
      github_user_id: row.github_user_id as string | undefined,
      trust_score: row.trust_score as number,
      promotion_authority: Boolean(row.promotion_authority),
      created_at: row.created_at as number,
    };
  }

  private rowToSpec(stmt: { getRow(): Record<string, unknown> | null }): SpecRow | null {
    const row = stmt.getRow();
    if (!row) return null;
    return {
      id: row.id as string,
      name: row.name as string,
      description: row.description as string | undefined,
      contract: row.contract as string,
      declared_delta_surface: row.declared_delta_surface as string,
      organization_id: row.organization_id as string,
      created_by: row.created_by as string,
      created_at: row.created_at as number,
      stage: row.stage as 'draft' | 'proposed' | 'active' | 'deprecated' | 'archived',
    };
  }

  private rowToCandidate(stmt: { getRow(): Record<string, unknown> | null }): CandidateRow | null {
    const row = stmt.getRow();
    if (!row) return null;
    return {
      id: row.id as string,
      spec_id: row.spec_id as string,
      repository_id: row.repository_id as string,
      commit_sha: row.commit_sha as string,
      base_commit_sha: row.base_commit_sha as string,
      agent_id: row.agent_id as string,
      created_at: row.created_at as number,
      stage: row.stage as 'pending' | 'passed_premerge' | 'passed_shadow' | 'passed_train' | 'passed_canary' | 'promoted' | 'failed' | 'rolled_back',
      preview_url: row.preview_url as string | undefined,
      preview_worker_name: row.preview_worker_name as string | undefined,
      preview_created_at: row.preview_created_at as number | undefined,
      shadow_match: row.shadow_match as boolean | undefined,
      shadow_score: row.shadow_score as number | undefined,
      shadow_metrics: row.shadow_metrics as string | undefined,
    };
  }

  /**
   * Convert internal CandidateRow (snake_case) to API CandidateResponse (camelCase)
   */
  private candidateRowToResponse(row: CandidateRow): CandidateResponse {
    return {
      id: row.id,
      specId: row.spec_id,
      repositoryId: row.repository_id,
      commitSha: row.commit_sha,
      baseCommitSha: row.base_commit_sha,
      agentId: row.agent_id,
      createdAt: row.created_at,
      stage: row.stage,
      previewUrl: row.preview_url,
      previewWorkerName: row.preview_worker_name,
      previewCreatedAt: row.preview_created_at,
      shadowMatch: row.shadow_match,
      shadowScore: row.shadow_score,
      shadowMetrics: row.shadow_metrics,
    };
  }

  private rowToGateVerdict(stmt: { getRow(): Record<string, unknown> | null }): GateVerdictRow | null {
    const row = stmt.getRow();
    if (!row) return null;
    return {
      id: row.id as string,
      candidate_id: row.candidate_id as string,
      gate: row.gate as 'pre-merge' | 'shadow' | 'train' | 'canary' | 'full',
      status: row.status as 'pass' | 'fail' | 'pending',
      score: row.score as number,
      complexity_delta: row.complexity_delta as number,
      notes: row.notes as string | undefined,
      created_at: row.created_at as number,
      decided_by: row.decided_by as string,
      stage: row.stage as 'pending' | 'passed' | 'failed',
    };
  }

  private rowToTrial(stmt: { getRow(): Record<string, unknown> | null }): TrialRow | null {
    const row = stmt.getRow();
    if (!row) return null;
    return {
      id: row.id as string,
      spec_id: row.spec_id as string,
      candidate_a_id: row.candidate_a_id as string,
      candidate_b_id: row.candidate_b_id as string,
      winner_id: row.winner_id as string | undefined,
      comparison_metrics: row.comparison_metrics as string,
      decided_at: row.decided_at as number,
      decided_by: row.decided_by as string,
      stage: row.stage as 'pending' | 'comparing' | 'decided',
    };
  }

  private rowToPromotion(stmt: { getRow(): Record<string, unknown> | null }): PromotionRow | null {
    const row = stmt.getRow();
    if (!row) return null;
    return {
      id: row.id as string,
      candidate_id: row.candidate_id as string,
      promoted_to: row.promoted_to as string,
      promoted_at: row.promoted_at as number,
      promoted_by: row.promoted_by as string,
      notes: row.notes as string | undefined,
    };
  }

  private rowToIssue(stmt: { getRow(): Record<string, unknown> | null }): IssueRow | null {
    const row = stmt.getRow();
    if (!row) return null;
    return {
      id: row.id as string,
      number: row.number as number,
      repository_id: row.repository_id as string,
      title: row.title as string,
      body: row.body as string | undefined,
      status: row.status as 'open' | 'closed',
      labels: row.labels as string | undefined,
      created_at: row.created_at as number,
      created_by: row.created_by as string,
      closed_at: row.closed_at as number | undefined,
      closed_by: row.closed_by as string | undefined,
      comment_policy: row.comment_policy as 'open' | 'maintainers_only' | 'locked',
      visibility: row.visibility as 'public' | 'internal' | 'private',
      stage: row.stage as 'reported' | 'spec_needed' | 'spec_defining' | 'spec_defined' | 'implementing' | 'validating' | 'merged' | 'closed',
    };
  }

  private rowToIssueComment(stmt: { getRow(): Record<string, unknown> | null }): IssueCommentRow | null {
    const row = stmt.getRow();
    if (!row) return null;
    return {
      id: row.id as string,
      issue_id: row.issue_id as string,
      body: row.body as string,
      created_by: row.created_by as string,
      created_at: row.created_at as number,
    };
  }

  private rowToEntityHistory(stmt: { getRow(): Record<string, unknown> | null }): EntityHistoryRow | null {
    const row = stmt.getRow();
    if (!row) return null;
    return {
      id: row.id as string,
      entity_type: row.entity_type as EntityType,
      entity_id: row.entity_id as string,
      stage: row.stage as EntityStage,
      changed_by: row.changed_by as string,
      changed_at: row.changed_at as number,
      notes: row.notes as string | undefined,
      metadata: row.metadata as string | undefined,
    };
  }

  private async handleInternal(request: Request, path: string, method: string): Promise<Response> {
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify({ success: status < 400, data, timestamp: Date.now() }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    const fail = (error: string, status: number) =>
      new Response(JSON.stringify({ success: false, error, timestamp: Date.now() }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (path === '/internal/service-accounts' && method === 'POST') {
      const body = (await request.json()) as {
        name: string;
        scopes: string[];
        description?: string;
        tokenHash: string;
        tokenPrefix: string;
        tokenSalt?: string;
        expiresAt: number | null;
        organizationId?: string;
        createdBy?: string;
      };
      // Convert old format to new format
      // Old: scopes as string[], tokenPrefix
      // New: scopes as union type, tokenSalt
      const scope = body.scopes?.[0] as 'read' | 'write' | 'read_write' | undefined;
      const sa = this.createServiceAccount(
        body.name,
        body.description ?? '',
        body.organizationId ?? 'default',
        body.tokenHash,
        body.tokenSalt ?? body.tokenPrefix, // Use tokenSalt if provided, otherwise fall back to tokenPrefix
        scope ?? 'read',
        body.createdBy ?? 'master',
        body.expiresAt ?? undefined
      );
      return json(sa, 201);
    }
    if (path === '/internal/service-accounts' && method === 'GET') {
      return json(this.listServiceAccounts());
    }
    const revoke = path.match(/^\/internal\/service-accounts\/([^\/]+)\/revoke$/);
    if (revoke && method === 'POST') {
      return this.revokeServiceAccount(revoke[1]) ? json({ revoked: true }) : fail('Not found', 404);
    }
    if (path === '/internal/service-tokens/verify' && method === 'POST') {
      const { tokenHash } = (await request.json()) as { tokenHash?: string };
      if (!tokenHash) return fail('tokenHash required', 400);
      const principal = this.verifyServiceTokenHash(tokenHash);
      return principal ? json(principal) : fail('Not found', 404);
    }
    return fail('Not found', 404);
  }

  // Fetch from Durable Object
  async fetch(request: Request): Promise<Response> {
    if (!this.db) {
      await this.init();
    }
    
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    
    try {
      if (path === '/health' || path === '/api/health') {
        return new Response('OK', { status: 200 });
      }
      
      // Internal routes: built only by the beehive edge with fixed paths.
      if (path.startsWith('/internal/')) {
        return await this.handleInternal(request, path, method);
      }

      // Extract actor ID from headers
      const actorId = request.headers.get('X-Actor-ID') || 'unknown';
      
      // ============================================================================
      // ORGANIZATIONS
      // ============================================================================
      
      if (path === '/api/organizations' && method === 'POST') {
        const body: CreateOrganizationRequest = await request.json();
        const org = this.createOrganization(body.name, body.type, body.externalId);
        return new Response(JSON.stringify({ success: true, data: org, timestamp: Date.now() }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (path === '/api/organizations' && method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit') || '50');
        const offset = parseInt(url.searchParams.get('offset') || '0');
        const orgs = this.listOrganizations(limit, offset);
        return new Response(JSON.stringify({ success: true, data: orgs, timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (path.match(/^\/api\/organizations\/[^\/]+$/) && method === 'GET') {
        const id = this.extractId(path);
        const org = this.getOrganization(id);
        if (!org) {
          return new Response(JSON.stringify({ success: false, error: 'Not found', timestamp: Date.now() }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ success: true, data: org, timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      // ============================================================================
      // ACTORS
      // ============================================================================
      
      if (path === '/api/actors' && method === 'POST') {
        const body: CreateActorRequest = await request.json();
        const actor = this.createActor(body.type, body.name, body.githubUserId);
        return new Response(JSON.stringify({ success: true, data: actor, timestamp: Date.now() }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (path === '/api/actors' && method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit') || '50');
        const offset = parseInt(url.searchParams.get('offset') || '0');
        const actors = this.listActors(limit, offset);
        return new Response(JSON.stringify({ success: true, data: actors, timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (path.match(/^\/api\/actors\/[^\/]+$/) && method === 'GET') {
        const id = this.extractId(path);
        const actor = this.getActor(id);
        if (!actor) {
          return new Response(JSON.stringify({ success: false, error: 'Not found', timestamp: Date.now() }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ success: true, data: actor, timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (path.match(/^\/api\/actors\/[^\/]+\/trust$/) && method === 'PATCH') {
        const id = this.extractParentId(path);
        const body: UpdateActorTrustRequest = await request.json();
        this.updateActorTrustScore(id, body.trustScore);
        const actor = this.getActor(id);
        return new Response(JSON.stringify({ success: true, data: actor, timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (path.match(/^\/api\/actors\/[^\/]+\/promotion-authority$/) && method === 'PATCH') {
        const id = this.extractParentId(path);
        this.grantPromotionAuthority(id);
        const actor = this.getActor(id);
        return new Response(JSON.stringify({ success: true, data: actor, timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      // ============================================================================
      // REPOSITORIES
      // ============================================================================
      
      if (path === '/api/repositories' && method === 'POST') {
        const body: CreateRepositoryRequest = await request.json();
        const repo = this.createRepository(
          body.name,
          body.organizationId,
          body.repoType,
          body.specId,
          body.agentId,
          body.remoteUrl,
          body.namespace,
          body.defaultBranch
        );
        return new Response(JSON.stringify({ success: true, data: repo, timestamp: Date.now() }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (path === '/api/repositories' && method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit') || '50');
        const offset = parseInt(url.searchParams.get('offset') || '0');
        const repos = this.listRepositories(limit, offset);
        return new Response(JSON.stringify({ success: true, data: repos, timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (path.match(/^\/api\/repositories\/[^\/]+$/) && method === 'GET') {
        const id = this.extractId(path);
        const repo = this.getRepository(id);
        if (!repo) {
          return new Response(JSON.stringify({ success: false, error: 'Not found', timestamp: Date.now() }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ success: true, data: repo, timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      // ============================================================================
      // SPECS
      // ============================================================================
      
      if (path === '/api/specs' && method === 'POST') {
        const body: CreateSpecRequest = await request.json();
        const spec = this.createSpec(
          body.name,
          body.description || '',
          body.contract,
          body.declaredDeltaSurface,
          body.organizationId,
          actorId
        );
        return new Response(JSON.stringify({ success: true, data: spec, timestamp: Date.now() }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (path === '/api/specs' && method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit') || '50');
        const offset = parseInt(url.searchParams.get('offset') || '0');
        const organizationId = url.searchParams.get('organizationId') ?? undefined;
        const stage = url.searchParams.get('stage') ?? undefined;
        const specs = this.listSpecs(limit, offset, organizationId, stage);
        return new Response(JSON.stringify({ success: true, data: specs, timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (path.match(/^\/api\/specs\/[^\/]+$/) && method === 'GET') {
        const id = this.extractId(path);
        const spec = this.getSpec(id);
        if (!spec) {
          return new Response(JSON.stringify({ success: false, error: 'Not found', timestamp: Date.now() }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ success: true, data: spec, timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (path.match(/^\/api\/specs\/[^\/]+\/claim$/) && method === 'POST') {
        const id = this.extractParentId(path);
        const body = await request.json() as { agentId?: string };
        try {
          const result = await this.claimSpec(id, body.agentId || actorId);
          return new Response(JSON.stringify({ success: true, data: result, timestamp: Date.now() }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const notFound = message.includes('Spec not found');
          return new Response(JSON.stringify({ success: false, error: message, timestamp: Date.now() }), {
            status: notFound ? 404 : 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      if (path.match(/^\/api\/specs\/[^\/]+\/stage$/) && method === 'PATCH') {
        const id = this.extractParentId(path);
        const body: UpdateSpecStageRequest = await request.json();
        this.transitionSpec(id, body.stage, actorId, body.notes);
        const spec = this.getSpec(id);
        return new Response(JSON.stringify({ success: true, data: spec, timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      // ============================================================================
      // CANDIDATES
      // ============================================================================
      
      if (path === '/api/candidates' && method === 'POST') {
        const body: CreateCandidateRequest = await request.json();
        const candidate = this.createCandidate(
          body.specId,
          body.repositoryId,
          body.commitSha,
          body.baseCommitSha,
          body.agentId || actorId
        );
        return new Response(JSON.stringify({ success: true, data: this.candidateRowToResponse(candidate), timestamp: Date.now() }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (path === '/api/candidates' && method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit') || '50');
        const offset = parseInt(url.searchParams.get('offset') || '0');
        const specId = url.searchParams.get('specId') ?? undefined;
        const agentId = url.searchParams.get('agentId') ?? undefined;
        const stage = url.searchParams.get('stage') ?? undefined;
        const candidates = this.listCandidates(limit, offset, specId, agentId, stage);
        return new Response(JSON.stringify({ success: true, data: candidates.map(c => this.candidateRowToResponse(c)), timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (path.match(/^\/api\/candidates\/[^\/]+$/) && method === 'GET') {
        const id = this.extractId(path);
        const candidate = this.getCandidate(id);
        if (!candidate) {
          return new Response(JSON.stringify({ success: false, error: 'Not found', timestamp: Date.now() }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ success: true, data: this.candidateRowToResponse(candidate), timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (path.match(/^\/api\/candidates\/[^\/]+\/stage$/) && method === 'PATCH') {
        const id = this.extractParentId(path);
        const body: UpdateCandidateStageRequest = await request.json();
        this.transitionCandidate(id, body.stage, actorId, body.notes);
        const candidate = this.getCandidate(id);
        if (!candidate) {
          return new Response(JSON.stringify({ success: false, error: 'Not found', timestamp: Date.now() }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ success: true, data: this.candidateRowToResponse(candidate), timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (path.match(/^\/api\/candidates\/[^\/]+\/preview$/) && method === 'PUT') {
        const id = this.extractParentId(path);
        const body = await request.json() as { previewUrl?: string; previewWorkerName?: string; previewDeployedAt?: number; previewCreatedAt?: number };
        this.updateCandidatePreview(
          id,
          body.previewUrl || '',
          body.previewWorkerName,
          body.previewDeployedAt || body.previewCreatedAt
        );
        const candidate = this.getCandidate(id);
        if (!candidate) {
          return new Response(JSON.stringify({ success: false, error: 'Not found', timestamp: Date.now() }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ success: true, data: this.candidateRowToResponse(candidate), timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      // ============================================================================
      // GATE VERDICTS
      // ============================================================================
      
      if (path === '/api/gate-verdicts' && method === 'POST') {
        const body: CreateGateVerdictRequest = await request.json();
        const verdict = this.createGateVerdict(
          body.candidateId,
          body.gate,
          body.status,
          body.score,
          body.complexityDelta,
          body.decidedBy || actorId,
          body.notes
        );
        return new Response(JSON.stringify({ success: true, data: verdict, timestamp: Date.now() }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (path === '/api/gate-verdicts' && method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit') || '50');
        const offset = parseInt(url.searchParams.get('offset') || '0');
        const candidateId = url.searchParams.get('candidateId') ?? undefined;
        const gate = url.searchParams.get('gate') ?? undefined;
        const status = url.searchParams.get('status') ?? undefined;
        const verdicts = this.listGateVerdicts(limit, offset, candidateId, gate, status);
        return new Response(JSON.stringify({ success: true, data: verdicts, timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (path.match(/^\/api\/candidates\/[^\/]+\/gate-verdicts$/) && method === 'GET') {
        const id = this.extractParentId(path);
        const verdicts = this.getGateVerdictsForCandidate(id);
        return new Response(JSON.stringify({ success: true, data: verdicts, timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      // ============================================================================
      // TRIALS
      // ============================================================================
      
      if (path === '/api/trials' && method === 'POST') {
        const body: CreateTrialRequest = await request.json();
        const trial = this.createTrial(
          body.specId,
          body.candidateAId,
          body.candidateBId,
          body.decidedBy || actorId
        );
        return new Response(JSON.stringify({ success: true, data: trial, timestamp: Date.now() }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (path === '/api/trials' && method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit') || '50');
        const offset = parseInt(url.searchParams.get('offset') || '0');
        const specId = url.searchParams.get('specId') ?? undefined;
        const stage = url.searchParams.get('stage') ?? undefined;
        const trials = this.listTrials(limit, offset, specId, stage);
        return new Response(JSON.stringify({ success: true, data: trials, timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (path.match(/^\/api\/trials\/[^\/]+$/) && method === 'GET') {
        const id = this.extractId(path);
        const trial = this.getTrial(id);
        if (!trial) {
          return new Response(JSON.stringify({ success: false, error: 'Not found', timestamp: Date.now() }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ success: true, data: trial, timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (path.match(/^\/api\/trials\/[^\/]+\/decide$/) && method === 'POST') {
        const id = this.extractParentId(path);
        const body: DecideTrialRequest = await request.json();
        this.decideTrial(id, body.winnerId, body.comparisonMetrics, body.decidedBy || actorId);
        const trial = this.getTrial(id);
        return new Response(JSON.stringify({ success: true, data: trial, timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      // ============================================================================
      // PROMOTIONS
      // ============================================================================
      
      if (path === '/api/promotions' && method === 'POST') {
        const body: CreatePromotionRequest = await request.json();
        const promotion = this.createPromotion(
          body.candidateId,
          body.fromRung,
          body.toRung,
          body.promotedBy || actorId
        );
        return new Response(JSON.stringify({ success: true, data: promotion, timestamp: Date.now() }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (path === '/api/promotions' && method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit') || '50');
        const offset = parseInt(url.searchParams.get('offset') || '0');
        const candidateId = url.searchParams.get('candidateId') ?? undefined;
        const promotions = this.listPromotions(limit, offset, candidateId);
        return new Response(JSON.stringify({ success: true, data: promotions, timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      // ============================================================================
      // ISSUES
      // ============================================================================
      
      if (path === '/api/issues' && method === 'POST') {
        const body: CreateIssueRequest = await request.json();
        const issue = this.createIssue(
          body.number,
          body.repositoryId,
          body.title,
          body.body || '',
          body.createdBy || actorId,
          body.labels
        );
        return new Response(JSON.stringify({ success: true, data: issue, timestamp: Date.now() }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (path === '/api/issues' && method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit') || '50');
        const offset = parseInt(url.searchParams.get('offset') || '0');
        const repositoryId = url.searchParams.get('repositoryId') ?? undefined;
        const stage = url.searchParams.get('stage') ?? undefined;
        const status = url.searchParams.get('status') ?? undefined;
        const issues = this.listIssues(limit, offset, repositoryId, stage, status);
        return new Response(JSON.stringify({ success: true, data: issues, timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (path.match(/^\/api\/issues\/[^\/]+$/) && method === 'GET') {
        const id = this.extractId(path);
        const issue = this.getIssue(id);
        if (!issue) {
          return new Response(JSON.stringify({ success: false, error: 'Not found', timestamp: Date.now() }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ success: true, data: issue, timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (path.match(/^\/api\/issues\/[^\/]+\/stage$/) && method === 'PATCH') {
        const id = this.extractParentId(path);
        const body: UpdateIssueStageRequest = await request.json();
        this.transitionIssue(id, body.stage, actorId, body.notes);
        const issue = this.getIssue(id);
        return new Response(JSON.stringify({ success: true, data: issue, timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (path.match(/^\/api\/issues\/[^\/]+\/comment-policy$/) && method === 'PATCH') {
        const id = this.extractParentId(path);
        const body: UpdateIssueCommentPolicyRequest = await request.json();
        this.updateIssueCommentPolicy(id, body.commentPolicy, actorId);
        const issue = this.getIssue(id);
        return new Response(JSON.stringify({ success: true, data: issue, timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      // ============================================================================
      // ISSUE COMMENTS
      // ============================================================================
      
      if (path.match(/^\/api\/issues\/[^\/]+\/comments$/) && method === 'POST') {
        const id = this.extractParentId(path);
        const body: CreateIssueCommentRequest = await request.json();
        const comment = this.createIssueComment(
          id,
          body.body,
          body.createdBy || actorId
        );
        return new Response(JSON.stringify({ success: true, data: comment, timestamp: Date.now() }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (path.match(/^\/api\/issues\/[^\/]+\/comments$/) && method === 'GET') {
        const id = this.extractParentId(path);
        const comments = this.listIssueComments(id);
        return new Response(JSON.stringify({ success: true, data: comments, timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      // ============================================================================
      // LINKS
      // ============================================================================
      
      if (path === '/api/issue-spec-links' && method === 'POST') {
        const body: CreateIssueSpecLinkRequest = await request.json();
        const link = this.createIssueSpecLink(
          body.issueId,
          body.specId,
          body.relationship
        );
        return new Response(JSON.stringify({ success: true, data: link, timestamp: Date.now() }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (path === '/api/issue-candidate-links' && method === 'POST') {
        const body: CreateIssueCandidateLinkRequest = await request.json();
        const link = this.createIssueCandidateLink(
          body.issueId,
          body.candidateId,
          body.relationship
        );
        return new Response(JSON.stringify({ success: true, data: link, timestamp: Date.now() }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      // ============================================================================
      // HISTORY
      // ============================================================================
      
      if (path.match(/^\/api\/entities\/[^\/]+\/[^\/]+\/history$/) && method === 'GET') {
        const pathParts = path.split('/');
        const entityType = pathParts[pathParts.length - 3] as EntityType;
        const entityId = pathParts[pathParts.length - 2];
        const history = this.getEntityHistory(entityType, entityId);
        return new Response(JSON.stringify({ success: true, data: history, timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // ============================================================================
      // SANDBOX EXECUTION
      // ============================================================================

      if (path.match(/^\/api\/candidates\/[^\/]+\/execute$/) && method === 'POST') {
        const id = this.extractParentId(path);
        const body = await request.json() as { commitMessage?: string; sandboxRunnerUrl?: string };
        
        // Get candidate to find repo details
        const candidate = this.getCandidate(id);
        if (!candidate) {
          return new Response(JSON.stringify({ success: false, error: 'Candidate not found', timestamp: Date.now() }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        
        // Get repo to find namespace
        const repo = this.getRepository(candidate.repository_id);
        if (!repo) {
          return new Response(JSON.stringify({ success: false, error: 'Repository not found', timestamp: Date.now() }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        
        // Execute in sandbox
        const result = await this.executeCandidateInSandbox(
          id,
          candidate.spec_id,
          repo.name,
          repo.namespace,
          body.commitMessage || 'Agent implementation',
          actorId,
          body.sandboxRunnerUrl || 'http://localhost:8787' // Default for local dev
        );
        
        if (!result.success) {
          return new Response(JSON.stringify({ success: false, error: result.error, timestamp: Date.now() }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        
        return new Response(JSON.stringify({ ...result, success: true, timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      // ============================================================================
      // GATE WORKFLOW
      // ============================================================================
      // GATE WORKFLOW TRIGGER
      // ============================================================================

      if (path.match(/^\/api\/candidates\/[^\/]+\/gate\/pre-merge$/) && method === 'POST') {
        const candidateId = this.extractParentId(path);
        const body = await request.json() as {
          commitSha?: string;
          baseCommitSha?: string;
          message?: string;
          timestamp?: string;
        };
        const actorId = request.headers.get('X-Actor-ID') || 'queue-consumer';

        // Get candidate to find spec_id and repository
        const candidate = this.getCandidate(candidateId);
        if (!candidate) {
          return new Response(JSON.stringify({
            success: false,
            error: `Candidate not found: ${candidateId}`,
            timestamp: now(),
          }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Get spec for contract
        const spec = this.getSpec(candidate.spec_id);
        if (!spec) {
          return new Response(JSON.stringify({
            success: false,
            error: `Spec not found: ${candidate.spec_id}`,
            timestamp: now(),
          }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Get repository for namespace/remote info
        const repo = this.getRepository(candidate.repository_id);
        if (!repo) {
          return new Response(JSON.stringify({
            success: false,
            error: `Repository not found: ${candidate.repository_id}`,
            timestamp: now(),
          }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Build gate workflow request
        const gateRequest = {
          candidateId,
          specId: spec.id,
          commitSha: body.commitSha || candidate.commit_sha,
          baseCommitSha: body.baseCommitSha || candidate.base_commit_sha,
          actorId,
          namespace: repo.namespace,
          repoName: repo.name,
        };

        // Get Gate Workflow service binding
        const gateWorkflowStub = this.env.GATE_WORKFLOW;
        
        if (!gateWorkflowStub) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Gate workflow binding not configured',
            timestamp: now(),
          }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Call Gate Workflow
        const gateResponse = await gateWorkflowStub.fetch(
          new Request('https://gate-workflow/gates/pre-merge', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.env.API_AUTH_TOKEN}`,
              'X-Actor-ID': actorId,
            },
            body: JSON.stringify(gateRequest),
          })
        );

        if (!gateResponse.ok) {
          const error = await gateResponse.text();
          console.error(`[SpecDO] Gate workflow failed: ${error}`);
          return new Response(JSON.stringify({
            success: false,
            error: `Gate workflow failed: ${error}`,
            timestamp: now(),
          }), {
            status: 502,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const gateResult = await gateResponse.json();
        return new Response(JSON.stringify(gateResult), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // ============================================================================
      // SERVICE ACCOUNTS
      // ============================================================================
      
      if (path === '/api/service-accounts' && method === 'POST') {
        const body: CreateServiceAccountRequest = await request.json();
        const { generateTokenSet } = await import('../shared/auth');
        const { token, hash, salt } = await generateTokenSet();
        const sa = this.createServiceAccount(
          body.name,
          body.description || '',
          body.organizationId,
          hash,
          salt,
          body.scopes,
          actorId,
          body.expiresAt
        );
        return new Response(JSON.stringify({
          success: true,
          data: { ...sa, token },
          timestamp: Date.now()
        }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (path === '/api/service-accounts' && method === 'GET') {
        const organizationId = url.searchParams.get('organizationId') ?? undefined;
        const isActive = url.searchParams.get('isActive');
        const scope = url.searchParams.get('scope') as 'read' | 'write' | 'read_write' | undefined;
        const limit = parseInt(url.searchParams.get('limit') || '100');
        const offset = parseInt(url.searchParams.get('offset') || '0');
        const sas = this.listServiceAccounts(
          organizationId,
          isActive ? isActive === 'true' : undefined,
          scope,
          limit,
          offset
        );
        return new Response(JSON.stringify({ success: true, data: sas, timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (path.match(/^\/api\/service-accounts\/[^\/]+$/) && method === 'GET') {
        const id = this.extractId(path);
        const sa = this.getServiceAccount(id);
        if (!sa) {
          return new Response(JSON.stringify({ success: false, error: 'Not found', timestamp: Date.now() }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ success: true, data: sa, timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (path.match(/^\/api\/service-accounts\/[^\/]+\/revoke$/) && method === 'POST') {
        const id = this.extractParentId(path);
        const body: { reason?: string } = await request.json();
        const success = this.revokeServiceAccount(id, body.reason);
        if (!success) {
          return new Response(JSON.stringify({ success: false, error: 'Not found', timestamp: Date.now() }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ success: true, timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (path.match(/^\/api\/service-accounts\/[^\/]+\/verify$/) && method === 'POST') {
        const id = this.extractParentId(path);
        const body: { token: string } = await request.json();
        const isValid = await this.verifyServiceAccountToken(id, body.token);
        if (!isValid) {
          return new Response(JSON.stringify({ success: false, isValid: false, error: 'Invalid token', timestamp: Date.now() }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const sa = this.getServiceAccount(id);
        if (!sa) {
          return new Response(JSON.stringify({ success: false, isValid: false, error: 'Not found', timestamp: Date.now() }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ success: true, isValid: true, scopes: sa.scopes, timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // ============================================================================
      // 404
      // ============================================================================
      
      return new Response(JSON.stringify({ success: false, error: 'Not found', timestamp: Date.now() }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(
        JSON.stringify({ success: false, error: message, timestamp: Date.now() }),
        { status: error instanceof ConflictError ? 409 : 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  private extractId(path: string): string {
    const match = path.match(/\/[^\/]+$/);
    return match ? match[0].substring(1) : '';
  }

  private extractParentId(path: string): string {
    const parts = path.split('/');
    return parts[parts.length - 2];
  }

  // ============================================================================
  // LIST METHODS (for GET endpoints)
  // ============================================================================

  listOrganizations(limit: number, offset: number): OrganizationRow[] {
    if (!this.db) return [];
    const stmt = this.db.prepare(
      `SELECT * FROM organizations ORDER BY created_at DESC LIMIT ? OFFSET ?`
    );
    stmt.bind(limit, offset);
    const rows: OrganizationRow[] = [];
    while (stmt.step()) {
      const row = this.rowToOrganization(stmt);
      if (row) rows.push(row);
    }
    stmt.free();
    return rows;
  }

  listActors(limit: number, offset: number): ActorRow[] {
    if (!this.db) return [];
    const stmt = this.db.prepare(
      `SELECT * FROM actors ORDER BY created_at DESC LIMIT ? OFFSET ?`
    );
    stmt.bind(limit, offset);
    const rows: ActorRow[] = [];
    while (stmt.step()) {
      const row = this.rowToActor(stmt);
      if (row) rows.push(row);
    }
    stmt.free();
    return rows;
  }

  listRepositories(limit: number, offset: number): RepositoryRow[] {
    if (!this.db) return [];
    const stmt = this.db.prepare(
      `SELECT * FROM repositories ORDER BY created_at DESC LIMIT ? OFFSET ?`
    );
    stmt.bind(limit, offset);
    const rows: RepositoryRow[] = [];
    while (stmt.step()) {
      const row = this.rowToRepository(stmt);
      if (row) rows.push(row);
    }
    stmt.free();
    return rows;
  }

  getRepository(id: string): RepositoryRow | null {
    if (!this.db) return null;
    const stmt = this.db.prepare(`SELECT * FROM repositories WHERE id = ?`);
    stmt.bind(id);
    const has = stmt.step();
    const row = has ? this.rowToRepository(stmt) : null;
    stmt.free();
    return row;
  }

  listSpecs(limit: number, offset: number, organizationId?: string, stage?: string): SpecRow[] {
    if (!this.db) return [];
    let query = `SELECT * FROM specs`;
    const params: (string | number | null)[] = [];
    
    if (organizationId || stage) {
      query += ' WHERE';
      if (organizationId) {
        query += ' organization_id = ?';
        params.push(organizationId);
      }
      if (stage) {
        if (organizationId) query += ' AND';
        query += ' stage = ?';
        params.push(stage);
      }
    }
    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    
    const stmt = this.db.prepare(query);
    params.forEach(p => stmt.bind(p));
    const rows: SpecRow[] = [];
    while (stmt.step()) {
      const row = this.rowToSpec(stmt);
      if (row) rows.push(row);
    }
    stmt.free();
    return rows;
  }

  listCandidates(limit: number, offset: number, specId?: string, agentId?: string, stage?: string): CandidateRow[] {
    if (!this.db) return [];
    let query = `SELECT * FROM candidates`;
    const params: (string | number | null)[] = [];
    
    if (specId || agentId || stage) {
      query += ' WHERE';
      if (specId) {
        query += ' spec_id = ?';
        params.push(specId);
      }
      if (agentId) {
        if (specId) query += ' AND';
        query += ' agent_id = ?';
        params.push(agentId);
      }
      if (stage) {
        if (specId || agentId) query += ' AND';
        query += ' stage = ?';
        params.push(stage);
      }
    }
    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    
    const stmt = this.db.prepare(query);
    params.forEach(p => stmt.bind(p));
    const rows: CandidateRow[] = [];
    while (stmt.step()) {
      const row = this.rowToCandidate(stmt);
      if (row) rows.push(row);
    }
    stmt.free();
    return rows;
  }

  listGateVerdicts(limit: number, offset: number, candidateId?: string, gate?: string, status?: string): GateVerdictRow[] {
    if (!this.db) return [];
    let query = `SELECT * FROM gate_verdicts`;
    const params: (string | number | null)[] = [];
    
    if (candidateId || gate || status) {
      query += ' WHERE';
      if (candidateId) {
        query += ' candidate_id = ?';
        params.push(candidateId);
      }
      if (gate) {
        if (candidateId) query += ' AND';
        query += ' gate = ?';
        params.push(gate);
      }
      if (status) {
        if (candidateId || gate) query += ' AND';
        query += ' status = ?';
        params.push(status);
      }
    }
    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    
    const stmt = this.db.prepare(query);
    params.forEach(p => stmt.bind(p));
    const rows: GateVerdictRow[] = [];
    while (stmt.step()) {
      const row = this.rowToGateVerdict(stmt);
      if (row) rows.push(row);
    }
    stmt.free();
    return rows;
  }

  getGateVerdictsForCandidate(candidateId: string): GateVerdictRow[] {
    if (!this.db) return [];
    const stmt = this.db.prepare(`SELECT * FROM gate_verdicts WHERE candidate_id = ? ORDER BY created_at DESC`);
    stmt.bind(candidateId);
    const rows: GateVerdictRow[] = [];
    while (stmt.step()) {
      const row = this.rowToGateVerdict(stmt);
      if (row) rows.push(row);
    }
    stmt.free();
    return rows;
  }

  listTrials(limit: number, offset: number, specId?: string, stage?: string): TrialRow[] {
    if (!this.db) return [];
    let query = `SELECT * FROM trials`;
    const params: (string | number | null)[] = [];
    
    if (specId || stage) {
      query += ' WHERE';
      if (specId) {
        query += ' spec_id = ?';
        params.push(specId);
      }
      if (stage) {
        if (specId) query += ' AND';
        query += ' stage = ?';
        params.push(stage);
      }
    }
    query += ' ORDER BY decided_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    
    const stmt = this.db.prepare(query);
    params.forEach(p => stmt.bind(p));
    const rows: TrialRow[] = [];
    while (stmt.step()) {
      const row = this.rowToTrial(stmt);
      if (row) rows.push(row);
    }
    stmt.free();
    return rows;
  }

  listPromotions(limit: number, offset: number, candidateId?: string): PromotionRow[] {
    if (!this.db) return [];
    let query = `SELECT * FROM promotions`;
    const params: (string | number | null)[] = [];
    
    if (candidateId) {
      query += ' WHERE candidate_id = ?';
      params.push(candidateId);
    }
    query += ' ORDER BY promoted_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    
    const stmt = this.db.prepare(query);
    params.forEach(p => stmt.bind(p));
    const rows: PromotionRow[] = [];
    while (stmt.step()) {
      const row = this.rowToPromotion(stmt);
      if (row) rows.push(row);
    }
    stmt.free();
    return rows;
  }

  listIssues(limit: number, offset: number, repositoryId?: string, stage?: string, status?: string): IssueRow[] {
    if (!this.db) return [];
    let query = `SELECT * FROM issues`;
    const params: (string | number | null)[] = [];
    
    if (repositoryId || stage || status) {
      query += ' WHERE';
      if (repositoryId) {
        query += ' repository_id = ?';
        params.push(repositoryId);
      }
      if (stage) {
        if (repositoryId) query += ' AND';
        query += ' stage = ?';
        params.push(stage);
      }
      if (status) {
        if (repositoryId || stage) query += ' AND';
        query += ' status = ?';
        params.push(status);
      }
    }
    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    
    const stmt = this.db.prepare(query);
    params.forEach(p => stmt.bind(p));
    const rows: IssueRow[] = [];
    while (stmt.step()) {
      const row = this.rowToIssue(stmt);
      if (row) rows.push(row);
    }
    stmt.free();
    return rows;
  }

  getIssue(id: string): IssueRow | null {
    if (!this.db) return null;
    const stmt = this.db.prepare(`SELECT * FROM issues WHERE id = ?`);
    stmt.bind(id);
    const has = stmt.step();
    const row = has ? this.rowToIssue(stmt) : null;
    stmt.free();
    return row;
  }

  listIssueComments(issueId: string): IssueCommentRow[] {
    if (!this.db) return [];
    const stmt = this.db.prepare(`SELECT * FROM issue_comments WHERE issue_id = ? ORDER BY created_at DESC`);
    stmt.bind(issueId);
    const rows: IssueCommentRow[] = [];
    while (stmt.step()) {
      const row = this.rowToIssueComment(stmt);
      if (row) rows.push(row);
    }
    stmt.free();
    return rows;
  }

  getEntityHistory(entityType: string, entityId: string): EntityHistoryRow[] {
    if (!this.db) return [];
    const stmt = this.db.prepare(`SELECT * FROM entity_history WHERE entity_type = ? AND entity_id = ? ORDER BY changed_at DESC`);
    stmt.bind(entityType, entityId);
    const rows: EntityHistoryRow[] = [];
    while (stmt.step()) {
      const row = this.rowToEntityHistory(stmt);
      if (row) rows.push(row);
    }
    stmt.free();
    return rows;
  }

  // ============================================================================
  // CREATE METHODS FOR LINKS
  // ============================================================================

  createIssueSpecLink(issueId: string, specId: string, relationship: 'requests-new' | 'requests-change' | 'reports-bug'): IssueSpecLinkResponse {
    if (!this.db) throw new Error('Database not initialized');
    const id = generateId();
    const stmt = this.db.prepare(
      `INSERT INTO issue_spec_links (id, issue_id, spec_id, relationship, created_at) VALUES (?, ?, ?, ?, ?)`
    );
    stmt.bind(id, issueId, specId, relationship, now());
    stmt.step();
    stmt.free();
    return { id, issueId, specId, relationship, createdAt: now() };
  }

  createIssueCandidateLink(issueId: string, candidateId: string, relationship: 'reports-bug' | 'requests-fix' | 'linked'): IssueCandidateLinkResponse {
    if (!this.db) throw new Error('Database not initialized');
    const id = generateId();
    const stmt = this.db.prepare(
      `INSERT INTO issue_candidate_links (id, issue_id, candidate_id, relationship, created_at) VALUES (?, ?, ?, ?, ?)`
    );
    stmt.bind(id, issueId, candidateId, relationship, now());
    stmt.step();
    stmt.free();
    return { id, issueId, candidateId, relationship, createdAt: now() };
  }

  // ============================================================================
  // UPDATE METHODS
  // ============================================================================

  updateIssueCommentPolicy(id: string, commentPolicy: string, changedBy: string): void {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare(`UPDATE issues SET comment_policy = ? WHERE id = ?`);
    stmt.bind(commentPolicy, id);
    stmt.step();
    stmt.free();
    this.recordHistory('issue', id, commentPolicy, changedBy, 'Comment policy updated');
  }

  createIssueComment(issueId: string, body: string, createdBy: string): IssueCommentResponse {
    if (!this.db) throw new Error('Database not initialized');
    const id = generateId();
    const stmt = this.db.prepare(
      `INSERT INTO issue_comments (id, issue_id, body, created_by, created_at) VALUES (?, ?, ?, ?, ?)`
    );
    stmt.bind(id, issueId, body, createdBy, now());
    stmt.step();
    stmt.free();
    return { id, issueId, body, createdBy, createdAt: now() };
  }

  createRepository(
    name: string,
    organizationId: string,
    repoType: 'baseline' | 'candidate',
    specId: string | undefined,
    agentId: string | undefined,
    remoteUrl: string,
    namespace: string,
    defaultBranch: string = 'main'
  ): RepositoryResponse {
    if (!this.db) throw new Error('Database not initialized');

    const dup = this.db.prepare(
      `SELECT id FROM repositories WHERE organization_id = ? AND name = ? LIMIT 1`
    );
    dup.bind(organizationId, name);
    const exists = dup.step();
    dup.free();
    if (exists) throw new ConflictError(`Repository '${name}' already exists in this organization`);

    const id = generateId();
    const stmt = this.db.prepare(
      `INSERT INTO repositories (id, name, organization_id, repo_type, spec_id, agent_id, remote_url, namespace, default_branch, created_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.bind(id, name, organizationId, repoType, specId || null, agentId || null, remoteUrl, namespace, defaultBranch, now());
    stmt.step();
    stmt.free();
    return {
      id,
      name,
      organizationId,
      repoType,
      specId,
      agentId,
      remoteUrl,
      namespace,
      defaultBranch,
      createdAt: now(),
    };
  }

  // ============================================================================
  // SANDBOX INTEGRATION
  // ============================================================================

  /**
   * Execute a candidate implementation in the sandbox
   * Creates a task and calls the Sandbox Runner Worker
   */
  async executeCandidateInSandbox(
    candidateId: string,
    specId: string,
    repoName: string,
    namespace: string,
    commitMessage: string,
    agentId: string,
    sandboxRunnerUrl: string
  ): Promise<{ success: boolean; taskId: string; commitSha?: string; error?: string }> {
    if (!this.db) throw new Error('Database not initialized');

    const taskId = generateId();

    try {
      // Create the task in the sandbox runner
      const task = {
        taskId,
        candidateId,
        specId,
        repoName,
        namespace,
        commitMessage,
        agentId,
        maxDurationMs: 30000,
      };

      // Call the Sandbox Runner Worker
      const sandboxResponse = await fetch(`${sandboxRunnerUrl}/sandbox/tasks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Actor-ID': agentId,
        },
        body: JSON.stringify(task),
      });

      if (!sandboxResponse.ok) {
        throw new Error(`Sandbox Runner returned ${sandboxResponse.status}`);
      }

      const sandboxData = await sandboxResponse.json() as { success?: boolean; error?: string; taskId?: string };

      // Poll for task completion
      const resultResponse = await this.pollForResult(sandboxRunnerUrl, taskId, 30000, 100);
      const resultData = await resultResponse.json() as { success?: boolean; error?: string; commitSha?: string };

      if (!resultData.success) {
        throw new Error(resultData.error || 'Sandbox execution failed');
      }

      const commitSha = resultData.commitSha;

      // Update candidate with the commit SHA
      const updateStmt = this.db.prepare(
        `UPDATE candidates SET commit_sha = ?, stage = ? WHERE id = ?`
      );
      updateStmt.bind(commitSha ?? '', 'passed_premerge', candidateId);
      updateStmt.step();
      updateStmt.free();

      // Record history
      this.recordHistory('candidate', candidateId, 'passed_premerge', agentId, 'Executed in sandbox');

      return {
        success: true,
        taskId,
        commitSha,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      // Update candidate with failure
      const updateStmt = this.db.prepare(
        `UPDATE candidates SET stage = ? WHERE id = ?`
      );
      updateStmt.bind('failed', candidateId);
      updateStmt.step();
      updateStmt.free();

      this.recordHistory('candidate', candidateId, 'failed', agentId, `Sandbox error: ${message}`);

      return {
        success: false,
        taskId,
        error: message,
      };
    }
  }

  /**
   * Poll for task result with timeout
   */

  // ============================================================================
  // SERVICE ACCOUNTS
  // ============================================================================

  createServiceAccount(
    name: string,
    description: string,
    organizationId: string,
    tokenHash: string,
    tokenSalt: string,
    scopes: 'read' | 'write' | 'read_write',
    createdBy: string,
    expiresAt?: number
  ): ServiceAccountRow {
    if (!this.db) throw new Error('Database not initialized');

    const id = generateId();
    const stmt = this.db.prepare(
      `INSERT INTO service_accounts 
        (id, name, description, organization_id, token_hash, token_salt, scopes, created_by, created_at, expires_at, is_active) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.bind(
      id,
      name,
      description || null,
      organizationId,
      tokenHash,
      tokenSalt,
      scopes,
      createdBy,
      now(),
      expiresAt || null,
      1
    );
    stmt.step();
    stmt.free();

    return {
      id,
      name,
      description,
      organization_id: organizationId,
      token_hash: tokenHash,
      token_salt: tokenSalt,
      scopes,
      created_by: createdBy,
      created_at: now(),
      expires_at: expiresAt,
      is_active: true,
    };
  }

  getServiceAccount(id: string): ServiceAccountRow | null {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(
      `SELECT * FROM service_accounts WHERE id = ?`
    );
    stmt.bind(id);
    const has = stmt.step();
    const row = has ? this.rowToServiceAccount(stmt) : null;
    stmt.free();

    return row;
  }

  listServiceAccounts(
    organizationId?: string,
    isActive?: boolean,
    scope?: 'read' | 'write' | 'read_write',
    limit: number = 100,
    offset: number = 0
  ): ServiceAccountRow[] {
    if (!this.db) throw new Error('Database not initialized');

    let sql = `
      SELECT * FROM service_accounts
      WHERE 1=1
    `;
    const params: (string | number | null)[] = [];

    if (organizationId) {
      sql += ` AND organization_id = ?`;
      params.push(organizationId);
    }
    if (isActive !== undefined) {
      sql += ` AND is_active = ?`;
      params.push(isActive ? 1 : 0);
    }
    if (scope) {
      sql += ` AND scopes = ?`;
      params.push(scope);
    }

    sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const stmt = this.db.prepare(sql);
    params.forEach((param, index) => stmt.bind(index + 1, param));

    const rows: ServiceAccountRow[] = [];
    while (stmt.step()) {
      rows.push(this.rowToServiceAccount(stmt));
    }
    stmt.free();

    return rows;
  }

  revokeServiceAccount(id: string, reason?: string): boolean {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(
      `UPDATE service_accounts SET is_active = 0 WHERE id = ?`
    );
    stmt.bind(id);
    stmt.step();
    stmt.free();

    this.recordHistory(
      'service_account',
      id,
      'revoked',
      'system',
      reason || 'Revoked by admin'
    );
    return true;
  }

  async verifyServiceAccountToken(
    serviceAccountId: string,
    token: string
  ): Promise<boolean> {
    const sa = this.getServiceAccount(serviceAccountId);
    if (!sa || !sa.is_active) {
      return false;
    }

    if (sa.expires_at && sa.expires_at < Date.now()) {
      return false;
    }

    const { verifyToken } = await import('../shared/auth');
    return verifyToken(token, sa.token_hash, sa.token_salt);
  }

  // Helper to convert SQLite row to ServiceAccountRow
  private rowToServiceAccount(stmt: any): ServiceAccountRow {
    return {
      id: stmt.get(0) as string,
      name: stmt.get(1) as string,
      description: stmt.get(2) as string | undefined,
      organization_id: stmt.get(3) as string,
      token_hash: stmt.get(4) as string,
      token_salt: stmt.get(5) as string,
      scopes: stmt.get(6) as 'read' | 'write' | 'read_write',
      created_by: stmt.get(7) as string,
      created_at: stmt.get(8) as number,
      expires_at: stmt.get(9) as number | undefined,
      is_active: (stmt.get(10) as number) === 1,
      last_used_at: stmt.get(11) as number | undefined,
    };
  }


  private async pollForResult(
    sandboxRunnerUrl: string,
    taskId: string,
    timeoutMs: number,
    intervalMs: number
  ): Promise<Response> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const response = await fetch(`${sandboxRunnerUrl}/sandbox/tasks/${taskId}/result`);
      const data = await response.json() as { success?: boolean; error?: string; commitSha?: string };

      if (data.success !== undefined) {
        return response;
      }

      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }

    throw new Error('Task result polling timed out');
  }
}

export default SpecDO;
