/**
 * Beehive Spec Durable Object
 * 
 * Orchestration spine - hand-written, not agent-generated.
 * This is the single source of truth for all coordination state.
 * 
 * Tables: organizations, repositories, actors, specs, candidates,
 *         gate_verdicts, trials, promotions, issues, and their links;
 *         promotion ledger: promotion_states, tournaments, merge_trains.
 */

import { DurableObject } from '@cloudflare/workers-types/experimental';
import { createSqlStorage, SqlDb } from './sql-storage';

// Schema SQL (inlined; esbuild has no ?raw loader for .sql in wrangler builds)
import {
  SCHEMA_SQL,
  SERVICE_ACCOUNTS_SQL,
  PROMOTION_LEDGER_SQL,
  LEDGER_LIFECYCLE_SQL,
  LIFECYCLE_COLUMNS,
  SERVICE_TOKENS_SQL,
  DEPLOY_REFS_SQL,
} from './schema-inline';

// The version runMigrations() must end at; bump with each new migration step
const LATEST_SCHEMA_VERSION = 'm8';

class ConflictError extends Error {}

/** Parsed X-Expected-Version: null when absent, 'invalid' when not a positive integer. */
function expectedVersion(request: Request): number | null | 'invalid' {
  const raw = request.headers.get(EXPECTED_VERSION_HEADER);
  if (raw === null) return null;
  return /^[1-9]\d*$/.test(raw) ? Number(raw) : 'invalid';
}

/**
 * Compare-and-swap check. `actual` is the stored version (null = new record). A new record needs
 * no version. For an existing one a mismatch is always refused; a missing version is refused
 * unless `optional` (PATCH, which merges server-side).
 */
function checkExpectedVersion(
  actual: number | null,
  expected: number | null,
  optional: boolean
): { code: string; message: string } | null {
  if (actual === null) return null;
  if (expected === null) {
    return optional
      ? null
      : { code: VERSION_REQUIRED, message: `record is at version ${actual}; send ${EXPECTED_VERSION_HEADER} to replace it` };
  }
  return expected === actual
    ? null
    : { code: VERSION_CONFLICT, message: `record is at version ${actual}, not ${expected}; re-read and retry` };
}
class NotFoundError extends Error {}
class ForbiddenError extends Error {}
class BadRequestError extends Error {}

const COMMENT_POLICIES = ['open', 'maintainers_only', 'locked'];
const MAX_COMMENT_CHARS = 10_000;
// An explicit issue number above this is refused: a float-sized one would make MAX+1 return itself
const MAX_ISSUE_NUMBER = 2_147_483_647;

// /promotion-states, /tournament-status, /merge-train-status, each with an optional /<id> segment
const LEDGER_ROUTE = /^(\/promotion-states|\/tournament-status|\/merge-train-status)(?:\/([^\/]+))?$/;

// Deploy refs: d is the head of its (spec, rung) chain when no row names it as prev_ref_id
const DEPLOY_HEAD = 'NOT EXISTS (SELECT 1 FROM deploy_refs n WHERE n.prev_ref_id = d.id)';

// Ledger lifecycle. Bound parameters per statement stay <= 100 (DO SQLite limit).
const MAX_BOUND_PARAMS = 100;
// Tables whose rows get an entity_history row on tombstone/purge. organizations and
// repositories are missing from the entity_history CHECK (widening it needs a table
// rebuild), so their audit trail is purge_log only.
const HISTORY_TYPES: Partial<Record<string, 'spec' | 'candidate' | 'issue'>> = {
  specs: 'spec',
  candidates: 'candidate',
  issues: 'issue',
};
// Row-id sets of one organization (each `?` binds the org id)
const ORG_REPOS = 'SELECT id FROM repositories WHERE organization_id = ?';
const ORG_SPECS = 'SELECT id FROM specs WHERE organization_id = ?';
const ORG_CANDIDATES = `SELECT id FROM candidates WHERE spec_id IN (${ORG_SPECS}) OR repository_id IN (${ORG_REPOS})`;
const ORG_ISSUES = `SELECT id FROM issues WHERE repository_id IN (${ORG_REPOS})`;
// Hard-delete order for one organization: children before parents (FK order).
// Dependent rows (comments, links, verdicts, trials, promotions) go with the
// tombstoned rows they reference. entity_history, purge_log and the promotion
// ledger tables have no FKs and are never purged.
const ORG_PURGE_ORDER: [table: string, where: string][] = [
  ['issue_comments', `issue_id IN (${ORG_ISSUES})`],
  ['issue_candidate_links', `issue_id IN (${ORG_ISSUES}) OR candidate_id IN (${ORG_CANDIDATES})`],
  ['issue_spec_links', `issue_id IN (${ORG_ISSUES}) OR spec_id IN (${ORG_SPECS})`],
  ['gate_verdicts', `candidate_id IN (${ORG_CANDIDATES})`],
  ['promotions', `candidate_id IN (${ORG_CANDIDATES})`],
  [
    'trials',
    `spec_id IN (${ORG_SPECS}) OR candidate_a_id IN (${ORG_CANDIDATES}) OR candidate_b_id IN (${ORG_CANDIDATES}) OR winner_id IN (${ORG_CANDIDATES})`,
  ],
  ['issues', `id IN (${ORG_ISSUES})`],
  ['candidates', `id IN (${ORG_CANDIDATES})`],
  ['repositories', 'organization_id = ?'],
  ['specs', 'organization_id = ?'],
  ['organizations', 'id = ?'],
];

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const placeholders = (n: number) => Array(n).fill('?').join(', ');

// Service tokens. The edge validates the same rules; the DO re-checks them because
// it is the store of record and is reachable from every worker with a SPEC_DO binding.
const SERVICE_ACCOUNT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SERVICE_TOKEN_HASH = /^[0-9a-f]{64}$/;
const SERVICE_TOKEN_PREFIX_SHAPE = /^bh_svc_[A-Za-z0-9_-]{5}$/;
const MAX_SERVICE_TOKEN_LIFETIME_MS = 366 * 24 * 3_600_000;
// last_used_at is a write on the read path; record it at most once per minute per token
const LAST_USED_RESOLUTION_MS = 60_000;
// Mints by the master token without X-Actor-ID are attributed to this reserved actor,
// and accounts minted without an organization belong to this reserved org (both FK targets).
const MASTER_ACTOR_ID = RESERVED_ACTOR_ID;
const SYSTEM_ORG_ID = RESERVED_ORGANIZATION_ID;

// Explicit column lists: views never select token_hash or token_salt
const SERVICE_ACCOUNT_COLUMNS =
  'id, name, description, organization_id, actor_id, scopes, created_by, created_at, is_active, last_used_at';
const SERVICE_TOKEN_COLUMNS =
  'id, account_id, token_prefix, scopes, created_by, created_at, expires_at, revoked_at, last_used_at';

interface ServiceTokenInput {
  tokenHash: string;
  tokenPrefix: string;
  expiresAt: number;
}

function checkServiceTokenInput(body: Record<string, unknown>, at: number): ServiceTokenInput {
  const { tokenHash, tokenPrefix, expiresAt } = body;
  if (typeof tokenHash !== 'string' || !SERVICE_TOKEN_HASH.test(tokenHash)) {
    throw new BadRequestError('tokenHash must be a lowercase SHA-256 hex digest');
  }
  if (typeof tokenPrefix !== 'string' || !SERVICE_TOKEN_PREFIX_SHAPE.test(tokenPrefix)) {
    throw new BadRequestError('tokenPrefix must be the first 12 chars of a bh_svc_ token');
  }
  if (typeof expiresAt !== 'number' || !Number.isInteger(expiresAt) || expiresAt <= at || expiresAt > at + MAX_SERVICE_TOKEN_LIFETIME_MS) {
    throw new BadRequestError('expiresAt must be a future epoch-ms time at most 366 days away');
  }
  return { tokenHash, tokenPrefix, expiresAt };
}

// Stored scope column -> scope list ('read_write' only on pre-m6 accounts)
function scopesOf(stored: unknown): string[] {
  return stored === 'read_write' ? ['read', 'write'] : [String(stored)];
}

function tokenView(t: Record<string, unknown>): Record<string, unknown> {
  return {
    id: t.id,
    prefix: t.token_prefix,
    scopes: scopesOf(t.scopes),
    createdBy: t.created_by,
    createdAt: t.created_at,
    expiresAt: t.expires_at,
    revokedAt: t.revoked_at ?? null,
    lastUsedAt: t.last_used_at ?? null,
  };
}

function accountView(r: Record<string, unknown>, tokens: Record<string, unknown>[]): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? null,
    actorId: r.actor_id ?? null,
    organizationId: r.organization_id,
    scopes: scopesOf(r.scopes),
    isActive: r.is_active === 1,
    createdBy: r.created_by,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at ?? null,
    tokens: tokens.map(tokenView),
  };
}
const bindCount = (sql: string) => (sql.match(/\?/g) || []).length;

// Service binding type for Gate Workflow
type Service = { fetch: (request: Request) => Promise<Response> };

// Seed data for local development
import { seedDatabase, isSeeded } from './seed';

// Artifacts client
import { createFork, createRepoToken, type ArtifactsConfig } from '../shared/artifacts';
import { specDoAuthGate } from '../shared/spec-do-auth';

// Promotion ledger contract (shared with the promotion worker)
import type { ZodType } from 'zod';
import {
  LEDGER_PATHS,
  LIST_ALL_SUFFIX,
  RECORD_NOT_FOUND,
  PromotionStateSchema,
  PromotionStatePatchSchema,
  TournamentRecordSchema,
  TournamentPatchSchema,
  MergeTrainRecordSchema,
  MergeTrainPatchSchema,
  type PromotionState,
  type TournamentRecord,
  type MergeTrainRecord,
} from '../shared/promotion-ledger';
import {
  EXPECTED_VERSION_HEADER,
  VERSION_CONFLICT,
  VERSION_REQUIRED,
  checkTournamentTransition,
} from '../shared/ledger-state-machine';

// Ledger lifecycle contract (tombstones, maintainer role, purge; shared with the edge)
import {
  TombstoneRequestSchema,
  RESERVED_ORGANIZATION_ID,
  RESERVED_ACTOR_ID,
  PurgeRequestSchema,
  SetActorRoleRequestSchema,
  LIFECYCLE_PATHS,
  INCLUDE_DELETED_PARAM,
  PURGE_BATCH_SIZE,
  DEFAULT_PURGE_MIN_AGE_HOURS,
  type TombstoneEntity,
  type TombstoneResult,
  type ParsedPurgeRequest,
  type PurgeResult,
  type PurgeSkipped,
  type ActorRole,
  type SetActorRoleResult,
} from '../shared/ledger-lifecycle';

// Deploy refs + canary deployments contract (shared with the canary worker and shadow router)
import {
  DEPLOY_ROUTE,
  DeployRefSchema,
  DeployRungSchema,
  CanaryDeploymentSchema,
  CanaryDeployRequestSchema,
  CanaryPatchSchema,
  RollbackRequestSchema,
  RefRollbackRequestSchema,
  type DeployRef,
  type DeployRung,
  type CanaryDeployment,
  type CanaryDeployRequest,
  type CanaryMoveResult,
  type LiveRef,
} from '../shared/deploy-refs';

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
  UpdateIssueStatusRequest,
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
} from '../api/types';

interface Env {
  SPEC_DO: DurableObjectNamespace;
  GATE_WORKFLOW: Service;
  API_AUTH_TOKEN?: string;
  // Two-tier internal auth for the DO's own fetch router (workers/shared/spec-do-auth.ts)
  SPEC_DO_INTERNAL_TOKEN?: string;
  SPEC_DO_ADMIN_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  // Minimum tombstone age before purge may hard-delete (hours, default 24). Local e2e sets 0.
  PURGE_MIN_AGE_HOURS?: string;
}

// Tombstone columns, present on organizations/repositories/specs/candidates/issues rows
// only when the row is tombstoned (live rows serialize exactly as before m5)
interface TombstoneFields {
  deleted_at?: number;
  deleted_by?: string;
  delete_reason?: string;
}

interface ActorRow {
  id: string;
  type: 'human' | 'agent';
  name: string;
  github_user_id?: string;
  trust_score: number;
  promotion_authority: boolean;
  created_at: number;
  role?: ActorRole;
}

interface SpecRow extends TombstoneFields {
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

interface CandidateRow extends TombstoneFields {
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

interface IssueRow extends TombstoneFields {
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

interface OrganizationRow extends TombstoneFields {
  id: string;
  name: string;
  type: 'github' | 'gitlab' | 'artifacts';
  external_id?: string;
  created_at: number;
}

interface RepositoryRow extends TombstoneFields {
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

// Helper to generate UUIDs
function generateId(): string {
  return crypto.randomUUID();
}

// Helper to get current timestamp
function now(): number {
  return Date.now();
}

// SQL NULL -> absent key, for records whose optional fields are undefined, not null
// WHERE fragment hiding tombstoned rows. Constant SQL, never user input.
function liveFilter(includeDeleted: boolean): string {
  return includeDeleted ? '1 = 1' : 'deleted_at IS NULL';
}

function tombstoneFieldsOf(row: Record<string, unknown>): TombstoneFields {
  if (row.deleted_at == null) return {};
  return {
    deleted_at: row.deleted_at as number,
    deleted_by: (row.deleted_by as string | null) ?? undefined,
    delete_reason: (row.delete_reason as string | null) ?? undefined,
  };
}

function dropNulls(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
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
    // this.db stays unset until every schema step has succeeded: a failure propagates
    // out of init() (requests fail visibly) and the next request retries from scratch,
    // instead of serving on a half-migrated schema.
    const db = createSqlStorage(this.state);
    this.db = db;
    try {
      await this.initSchema();
    } catch (e) {
      this.db = null;
      console.error('[SpecDO] init failed:', e instanceof Error ? e.message : String(e));
      throw e;
    }

    // Seed database in development if not already seeded
    // This only runs in local development (Miniflare)
    if ('DEV' in this.env && (this.env as { DEV?: string }).DEV === 'local' && !isSeeded(db)) {
      seedDatabase(db);
    }
  }

  private async initSchema(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');
    // Check if we need to initialize the schema
    const initSql = await this.state.storage.get<string>('schema_init');
    if (!initSql) {
      // Execute schema
      this.db.exec(SCHEMA_SQL);
      // service_accounts: a fresh ledger needs them before its first request
      this.db.exec(SERVICE_ACCOUNTS_SQL);
      // Tombstone columns + purge_log: likewise
      this.applyLedgerLifecycle();
      // service_accounts.actor_id + service_tokens: likewise
      this.applyServiceTokens();
      // deploy_refs + canary_deployments: likewise
      this.db.exec(DEPLOY_REFS_SQL);
      // version / failure columns on tournaments + merge_trains: likewise
      this.applyLedgerCas();

      // Initialize metadata. A fresh ledger has every section applied, so it starts at the
      // latest version. INSERT OR IGNORE: a retry after a failed first init keeps what is there.
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
      insertMeta('schema_version', LATEST_SCHEMA_VERSION);
      insertMeta('initialized_at', String(now()));

      // Last: if anything above threw, the next init() takes this branch again (all idempotent)
      await this.state.storage.put('schema_init', 'true');
    }

    // Also after a fresh init: a retry that got past the metadata insert on an older
    // version, or a ledger whose version row predates this code, converges here.
    await this.runMigrations();
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

  /** True when the actor belongs to a service account (pre-m6 accounts have none). */
  isServiceActor(actorId: string): boolean {
    return this.queryAll(`SELECT 1 AS x FROM service_accounts WHERE actor_id = ? LIMIT 1`, actorId).length > 0;
  }

  /**
   * Principal for a presented token's SHA-256 hash, or null when the token is
   * unknown, revoked or expired, or its account is revoked, has no actor, or
   * belongs to a tombstoned organization. Lookup is by hash (unique index); the
   * DO never sees plaintext. Reads promotion_authority live; the edge ignores it.
   */
  verifyServiceTokenHash(tokenHash: string): Record<string, unknown> | null {
    if (!SERVICE_TOKEN_HASH.test(tokenHash)) return null;
    const at = now();
    const r = this.queryAll(
      `SELECT st.id AS token_id, st.scopes, st.last_used_at,
              sa.id AS account_id, sa.actor_id, sa.organization_id, ac.promotion_authority
       FROM service_tokens st
       JOIN service_accounts sa ON sa.id = st.account_id
       JOIN actors ac ON ac.id = sa.actor_id
       JOIN organizations o ON o.id = sa.organization_id
       WHERE st.token_hash = ? AND st.revoked_at IS NULL AND st.expires_at > ?
         AND sa.is_active = 1 AND o.deleted_at IS NULL`,
      tokenHash,
      at
    )[0];
    if (!r) return null;
    if (r.last_used_at == null || at - (r.last_used_at as number) >= LAST_USED_RESOLUTION_MS) {
      this.state.storage.transactionSync(() => {
        this.run(`UPDATE service_tokens SET last_used_at = ? WHERE id = ?`, at, r.token_id as string);
        this.run(`UPDATE service_accounts SET last_used_at = ? WHERE id = ?`, at, r.account_id as string);
      });
    }
    return {
      kind: 'service',
      actorId: r.actor_id,
      serviceAccountId: r.account_id,
      tokenId: r.token_id,
      scopes: scopesOf(r.scopes),
      organizationId: r.organization_id,
      promotionAuthority: Boolean(r.promotion_authority),
    };
  }

  /** Account row plus its tokens (prefix and lifecycle only: never token_hash). */
  private serviceAccountView(id: string): Record<string, unknown> | null {
    const r = this.queryAll(`SELECT ${SERVICE_ACCOUNT_COLUMNS} FROM service_accounts WHERE id = ?`, id)[0];
    if (!r) return null;
    const tokens = this.queryAll(
      `SELECT ${SERVICE_TOKEN_COLUMNS} FROM service_tokens WHERE account_id = ? ORDER BY created_at, id`,
      id
    );
    return accountView(r, tokens);
  }

  listServiceAccounts(): Record<string, unknown>[] {
    const tokens = new Map<string, Record<string, unknown>[]>();
    for (const t of this.queryAll(`SELECT ${SERVICE_TOKEN_COLUMNS} FROM service_tokens ORDER BY created_at, id`)) {
      const list = tokens.get(t.account_id as string) ?? [];
      list.push(t);
      tokens.set(t.account_id as string, list);
    }
    return this.queryAll(`SELECT ${SERVICE_ACCOUNT_COLUMNS} FROM service_accounts ORDER BY created_at DESC, id`).map((r) =>
      accountView(r, tokens.get(r.id as string) ?? [])
    );
  }

  /**
   * FK-valid creator: an existing actor that is not a service account's, or the
   * reserved master actor when the master token sent no X-Actor-ID. Runs inside
   * the caller's transaction.
   */
  private resolveMinter(createdBy: unknown, at: number): string {
    if (createdBy === undefined || createdBy === null || createdBy === 'unknown') {
      this.run(
        `INSERT OR IGNORE INTO actors (id, type, name, promotion_authority, created_at)
         VALUES (?, 'human', 'master token (unattributed)', 0, ?)`,
        MASTER_ACTOR_ID,
        at
      );
      return MASTER_ACTOR_ID;
    }
    if (typeof createdBy !== 'string' || !this.queryAll(`SELECT 1 AS x FROM actors WHERE id = ?`, createdBy).length) {
      throw new BadRequestError('createdBy (X-Actor-ID) must be an existing actor');
    }
    if (this.isServiceActor(createdBy)) throw new ForbiddenError('a service account cannot mint service tokens');
    return createdBy;
  }

  /** A live organization; without one, the reserved system organization. Inside the caller's transaction. */
  private resolveServiceOrganization(organizationId: unknown, at: number): string {
    if (organizationId === undefined || organizationId === null) {
      this.run(
        `INSERT OR IGNORE INTO organizations (id, name, type, created_at) VALUES (?, ?, 'artifacts', ?)`,
        SYSTEM_ORG_ID,
        SYSTEM_ORG_ID,
        at
      );
      organizationId = SYSTEM_ORG_ID;
    }
    if (typeof organizationId !== 'string') throw new BadRequestError('organizationId must be a string');
    const org = this.queryAll(`SELECT deleted_at FROM organizations WHERE id = ?`, organizationId)[0];
    if (!org) throw new BadRequestError(`organization ${organizationId} not found`);
    if (org.deleted_at != null) throw new ConflictError(`organization ${organizationId} is tombstoned`);
    return organizationId;
  }

  private insertServiceToken(accountId: string, token: ServiceTokenInput, createdBy: string, at: number): string {
    const id = generateId();
    this.run(
      `INSERT INTO service_tokens (id, account_id, token_hash, token_prefix, scopes, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, 'read', ?, ?, ?)`,
      id,
      accountId,
      token.tokenHash,
      token.tokenPrefix,
      createdBy,
      at,
      token.expiresAt
    );
    return id;
  }

  /**
   * Actor + account + first token in one transaction. Read scope only. Returns
   * the account and token views; the caller (edge) adds the plaintext it holds.
   */
  createServiceAccount(body: Record<string, unknown>): { account: Record<string, unknown>; token: Record<string, unknown> } {
    const { name, description, scopes } = body;
    if (typeof name !== 'string' || !SERVICE_ACCOUNT_NAME.test(name)) {
      throw new BadRequestError('name must match [a-z0-9][a-z0-9-]{0,62}');
    }
    if (!Array.isArray(scopes) || scopes.length !== 1 || scopes[0] !== 'read') {
      throw new BadRequestError("Only scopes ['read'] are supported");
    }
    if (description !== undefined && description !== null && (typeof description !== 'string' || description.length > 200)) {
      throw new BadRequestError('description must be a string of at most 200 chars');
    }
    const at = now();
    const token = checkServiceTokenInput(body, at);
    return this.state.storage.transactionSync(() => {
      if (this.queryAll(`SELECT 1 AS x FROM service_accounts WHERE name = ?`, name).length) {
        throw new ConflictError(`service account ${name} already exists`);
      }
      const createdBy = this.resolveMinter(body.createdBy, at);
      const organizationId = this.resolveServiceOrganization(body.organizationId, at);
      const accountId = generateId();
      const actorId = generateId();
      this.run(
        `INSERT INTO actors (id, type, name, trust_score, promotion_authority, created_at) VALUES (?, 'agent', ?, 0, 0, ?)`,
        actorId,
        `svc:${name}`,
        at
      );
      // token_hash/token_salt are legacy NOT NULL columns: tokens live in service_tokens
      this.run(
        `INSERT INTO service_accounts
           (id, name, description, organization_id, token_hash, token_salt, scopes, created_by, created_at, is_active, actor_id)
         VALUES (?, ?, ?, ?, '', '', 'read', ?, ?, 1, ?)`,
        accountId,
        name,
        (description as string | undefined) ?? null,
        organizationId,
        createdBy,
        at,
        actorId
      );
      const tokenId = this.insertServiceToken(accountId, token, createdBy, at);
      this.recordHistory('service_account', accountId, 'created', createdBy, undefined, JSON.stringify({ actorId, tokenId }));
      const account = this.serviceAccountView(accountId)!;
      const tokens = account.tokens as Record<string, unknown>[];
      return { account, token: tokens[0] };
    });
  }

  /** Another token for an active account (rotation). Read scope only. */
  createServiceToken(accountId: string, body: Record<string, unknown>): Record<string, unknown> {
    const at = now();
    const token = checkServiceTokenInput(body, at);
    return this.state.storage.transactionSync(() => {
      const account = this.queryAll(`SELECT is_active, actor_id FROM service_accounts WHERE id = ?`, accountId)[0];
      if (!account) throw new NotFoundError(`service account ${accountId} not found`);
      if (account.is_active !== 1) throw new ConflictError(`service account ${accountId} is revoked`);
      if (account.actor_id == null) {
        throw new ConflictError(`service account ${accountId} predates service tokens (no actor); mint a new account`);
      }
      const createdBy = this.resolveMinter(body.createdBy, at);
      const tokenId = this.insertServiceToken(accountId, token, createdBy, at);
      this.recordHistory('service_account', accountId, 'token_created', createdBy, undefined, JSON.stringify({ tokenId }));
      return tokenView(this.queryAll(`SELECT ${SERVICE_TOKEN_COLUMNS} FROM service_tokens WHERE id = ?`, tokenId)[0]);
    });
  }

  /** Deactivates the account and revokes all its tokens. Idempotent; false when unknown. */
  revokeServiceAccount(id: string, actorId: string): boolean {
    return this.state.storage.transactionSync(() => {
      const account = this.queryAll(`SELECT is_active FROM service_accounts WHERE id = ?`, id)[0];
      if (!account) return false;
      const at = now();
      const live = this.queryAll(`SELECT id FROM service_tokens WHERE account_id = ? AND revoked_at IS NULL`, id);
      if (account.is_active !== 0 || live.length) {
        this.run(`UPDATE service_accounts SET is_active = 0 WHERE id = ?`, id);
        this.run(`UPDATE service_tokens SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL`, at, id);
        this.recordHistory('service_account', id, 'revoked', actorId, undefined, JSON.stringify({ tokenIds: live.map((t) => t.id) }));
      }
      return true;
    });
  }

  /** Revokes one token of an account. Idempotent; false when the pair is unknown. */
  revokeServiceToken(accountId: string, tokenId: string, actorId: string): boolean {
    return this.state.storage.transactionSync(() => {
      const token = this.queryAll(`SELECT revoked_at FROM service_tokens WHERE id = ? AND account_id = ?`, tokenId, accountId)[0];
      if (!token) return false;
      if (token.revoked_at == null) {
        this.run(`UPDATE service_tokens SET revoked_at = ? WHERE id = ?`, now(), tokenId);
        this.recordHistory('service_account', accountId, 'token_revoked', actorId, undefined, JSON.stringify({ tokenId }));
      }
      return true;
    });
  }

  /**
   * Run schema migrations for existing databases, one step per version, in order.
   * Every step is additive and idempotent (IF NOT EXISTS, or an ALTER behind a PRAGMA
   * check), so a step that failed halfway is safe to retry. A failing step is logged and
   * rethrown: init() then fails and leaves this.db unset, so the next request retries.
   * Ends with an assertion that the ledger is at LATEST_SCHEMA_VERSION.
   */
  async runMigrations(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    const steps: [version: string, apply: () => void][] = [
      // m1 -> m2: preview columns on candidates
      ['m2', () => this.addColumnsIfMissing('candidates', [
        'preview_url TEXT',
        'preview_worker_name TEXT',
        'preview_created_at INTEGER',
      ])],
      // m2 -> m3: service accounts (read-only token slice)
      ['m3', () => this.db!.exec(SERVICE_ACCOUNTS_SQL)],
      // m3 -> m4: promotion ledger tables (promotion_states, tournaments, merge_trains)
      ['m4', () => this.db!.exec(PROMOTION_LEDGER_SQL)],
      // m4 -> m5: ledger lifecycle (tombstone columns, actors.role, purge_log)
      ['m5', () => this.applyLedgerLifecycle()],
      // m5 -> m6: service tokens (service_accounts.actor_id, service_tokens)
      ['m6', () => this.applyServiceTokens()],
      // m6 -> m7: deploy refs + canary deployments
      ['m7', () => this.db!.exec(DEPLOY_REFS_SQL)],
      // m7 -> m8: version columns on tournaments + merge_trains, tournament failure columns
      ['m8', () => this.applyLedgerCas()],
    ];
    if (steps[steps.length - 1][0] !== LATEST_SCHEMA_VERSION) {
      throw new Error('SpecDO migration steps do not end at LATEST_SCHEMA_VERSION');
    }
    const order = ['m1', ...steps.map(([v]) => v)];

    for (const [target, apply] of steps) {
      const current = this.readSchemaVersion();
      const at = order.indexOf(current);
      if (at < 0) throw new Error(`Unknown schema_version '${current}'`);
      if (at >= order.indexOf(target)) continue;
      try {
        apply();
        this.writeSchemaVersion(target);
      } catch (e) {
        console.error(`[SpecDO] Migration to ${target} failed:`, e instanceof Error ? e.message : String(e));
        throw e;
      }
    }

    const final = this.readSchemaVersion();
    if (final !== LATEST_SCHEMA_VERSION) {
      const msg = `schema_version is '${final}' after migrations, expected '${LATEST_SCHEMA_VERSION}'`;
      console.error(`[SpecDO] ${msg}`);
      throw new Error(msg);
    }
  }

  /** A ledger with no schema_version row predates versioning: treated as m1. */
  private readSchemaVersion(): string {
    const rows = this.queryAll('SELECT value FROM metadata WHERE key = ?', 'schema_version');
    return rows.length ? (rows[0].value as string) : 'm1';
  }

  private writeSchemaVersion(version: string): void {
    this.run('INSERT OR REPLACE INTO metadata (key, value, updated_at) VALUES (?, ?, ?)', 'schema_version', version, now());
  }

  private addColumnsIfMissing(table: string, columns: string[]): void {
    if (!this.db) throw new Error('Database not initialized');
    const existing = new Set(this.queryAll(`PRAGMA table_info(${table})`).map((c) => c.name as string));
    for (const column of columns) {
      if (!existing.has(column.split(' ')[0])) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
    }
  }

  /**
   * Idempotent: service_accounts (an m2 ledger may not have it yet), its actor_id
   * column if missing, then service_tokens and indexes. Pre-m6 accounts keep
   * actor_id NULL and have no token rows, so they cannot authenticate (fail closed).
   */
  private applyServiceTokens(): void {
    if (!this.db) throw new Error('Database not initialized');
    // CREATE TABLE IF NOT EXISTS keeps a table of another design as it is, and the first index on a
    // missing column then fails with a cryptic error. Name the cause instead; never drop it here.
    const have = this.queryAll(`PRAGMA table_info(service_accounts)`).map((c) => c.name as string);
    const missing = ['token_hash', 'token_salt', 'is_active'].filter((c) => !have.includes(c));
    if (have.length && missing.length) {
      throw new Error(
        `service_accounts has an unexpected shape (columns: ${have.join(', ')}; missing: ${missing.join(', ')}). ` +
          `If the table is empty, DROP TABLE service_accounts and the next request recreates it; otherwise migrate its rows first.`
      );
    }
    this.db.exec(SERVICE_ACCOUNTS_SQL);
    const existing = new Set(this.queryAll(`PRAGMA table_info(service_accounts)`).map((c) => c.name as string));
    if (!existing.has('actor_id')) {
      this.db.exec(`ALTER TABLE service_accounts ADD COLUMN actor_id TEXT REFERENCES actors(id)`);
    }
    this.db.exec(SERVICE_TOKENS_SQL);
  }

  /** Idempotent: adds only the version / failure columns that are missing (see schema.sql, m7 -> m8). */
  private applyLedgerCas(): void {
    this.addColumnsIfMissing('tournaments', [
      'version INTEGER NOT NULL DEFAULT 1',
      'failure_reason TEXT',
      'failed_at TEXT',
      'attempts INTEGER NOT NULL DEFAULT 0',
    ]);
    this.addColumnsIfMissing('merge_trains', ['version INTEGER NOT NULL DEFAULT 1']);
  }

  /** Idempotent: adds only the lifecycle columns that are missing, then purge_log and indexes. */
  private applyLedgerLifecycle(): void {
    if (!this.db) throw new Error('Database not initialized');
    for (const [table, columns] of Object.entries(LIFECYCLE_COLUMNS)) {
      const existing = new Set(this.queryAll(`PRAGMA table_info(${table})`).map((c) => c.name as string));
      for (const column of columns) {
        if (!existing.has(column.split(' ')[0])) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
      }
    }
    this.db.exec(LEDGER_LIFECYCLE_SQL);
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
    // A tombstoned org frees its name; purge only ever touches the tombstoned row.
    const dup = this.db.prepare(`SELECT id FROM organizations WHERE name = ? AND deleted_at IS NULL LIMIT 1`);
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

  getOrganization(id: string, includeDeleted = false): OrganizationRow | null {
    if (!this.db) throw new Error('Database not initialized');
    
    const stmt = this.db.prepare(
      `SELECT * FROM organizations WHERE id = ? AND ${liveFilter(includeDeleted)}`
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

  getSpec(id: string, includeDeleted = false): SpecRow | null {
    if (!this.db) throw new Error('Database not initialized');
    
    const stmt = this.db.prepare(
      `SELECT * FROM specs WHERE id = ? AND ${liveFilter(includeDeleted)}`
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

  getCandidate(id: string, includeDeleted = false): CandidateRow | null {
    if (!this.db) throw new Error('Database not initialized');
    
    const stmt = this.db.prepare(
      `SELECT * FROM candidates WHERE id = ? AND ${liveFilter(includeDeleted)}`
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
    // decided_at is NOT NULL; 0 = not decided yet (matches the returned row; decideTrial sets it)
    stmt.bind(id, specId, candidateAId, candidateBId, null, comparisonMetrics, 0, decidedBy, 'pending');
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

  /**
   * Local error mapper for the issue routes only. The main fetch catch maps just ConflictError,
   * and callers branch on 404 elsewhere, so it is deliberately not widened. Anything unmapped
   * is rethrown to it unchanged.
   */
  private issueRoute(successStatus: number, fn: () => unknown): Response {
    const reply = (success: boolean, status: number, extra: Record<string, unknown>) =>
      new Response(JSON.stringify({ success, ...extra, timestamp: Date.now() }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    try {
      return reply(true, successStatus, { data: fn() });
    } catch (e) {
      const status =
        e instanceof BadRequestError ? 400 : e instanceof ForbiddenError ? 403 : e instanceof NotFoundError ? 404 : e instanceof ConflictError ? 409 : 0;
      if (!status) throw e;
      return reply(false, status, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * The header actor must be a row in `actors` and not a service account's actor. 'unknown' (no
   * header) and unknown ids are refused with 403, so issue writes never rest on a bare string.
   * Only as strong as the edge: a master-token holder can still assert any existing actor id.
   */
  private requireIssueActor(actorId: string): void {
    if (actorId === 'unknown' || !this.queryAll(`SELECT 1 AS x FROM actors WHERE id = ?`, actorId).length) {
      throw new ForbiddenError('X-Actor-ID must name an existing actor');
    }
    if (this.isServiceActor(actorId)) throw new ForbiddenError('service account actors cannot write issues');
  }

  /** The author is the header actor; a body that names someone else is refused, never trusted. */
  private requireSameAuthor(bodyCreatedBy: unknown, actorId: string): void {
    if (bodyCreatedBy !== undefined && bodyCreatedBy !== null && bodyCreatedBy !== '' && bodyCreatedBy !== actorId) {
      throw new ForbiddenError('createdBy must match the X-Actor-ID header');
    }
  }

  /**
   * `number` is optional: omitted, it is MAX(number)+1 for the repository (tombstoned issues count,
   * so a number is never reused). All checks, the INSERT and the history row run in one
   * transactionSync, so concurrent creates cannot take the same number and a failed history write
   * leaves no row. Throws BadRequestError / NotFoundError / ConflictError (see issueRoute).
   */
  createIssue(
    number: number | undefined,
    repositoryId: string,
    title: string,
    body: string,
    createdBy: string,
    labels?: string[]
  ): IssueRow {
    if (!this.db) throw new Error('Database not initialized');
    if (number !== undefined && number !== null && (!Number.isSafeInteger(number) || number < 1 || number > MAX_ISSUE_NUMBER)) {
      throw new BadRequestError(`number must be an integer between 1 and ${MAX_ISSUE_NUMBER}`);
    }

    const id = generateId();
    const labelsJson = labels ? JSON.stringify(labels) : null;

    return this.state.storage.transactionSync(() => {
      const repo = this.queryAll(`SELECT deleted_at FROM repositories WHERE id = ?`, repositoryId)[0];
      if (!repo) throw new NotFoundError('repository not found');
      if (repo.deleted_at != null) throw new ConflictError('repository is tombstoned');

      let assigned: number;
      if (number === undefined || number === null) {
        assigned = (this.queryAll(`SELECT COALESCE(MAX(number), 0) + 1 AS n FROM issues WHERE repository_id = ?`, repositoryId)[0].n as number);
      } else {
        if (this.queryAll(`SELECT 1 AS x FROM issues WHERE repository_id = ? AND number = ?`, repositoryId, number).length) {
          throw new ConflictError(`issue number ${number} is already used in this repository`);
        }
        assigned = number;
      }

      const stmt = this.db!.prepare(
        `INSERT INTO issues 
         (id, number, repository_id, title, body, status, labels, created_at, created_by, comment_policy, visibility, stage) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      stmt.bind(id, assigned, repositoryId, title, body, 'open', labelsJson, now(), createdBy, 'open', 'public', 'reported');
      stmt.step();
      stmt.free();

      this.recordHistory('issue', id, 'reported', createdBy, 'Issue created');

      return {
        id,
        number: assigned,
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
    });
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
      ...tombstoneFieldsOf(row),
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
      ...tombstoneFieldsOf(row),
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
      ...(row.role ? { role: row.role as ActorRole } : {}),
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
      ...tombstoneFieldsOf(row),
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
      ...tombstoneFieldsOf(row),
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
      ...(row.deleted_at != null
        ? { deletedAt: row.deleted_at, deletedBy: row.deleted_by, deleteReason: row.delete_reason }
        : {}),
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
      ...tombstoneFieldsOf(row),
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

  // Promotion mode is train state: persisted in DO storage so every promotion
  // worker isolate reads the same value. Null means "never set" (use env default).
  async getPromotionMode(): Promise<'tournament' | 'merge-train' | null> {
    return (await this.state.storage.get<'tournament' | 'merge-train'>('promotion_mode')) ?? null;
  }

  async setPromotionMode(mode: 'tournament' | 'merge-train'): Promise<'tournament' | 'merge-train'> {
    if (mode !== 'tournament' && mode !== 'merge-train') {
      throw new Error(`Invalid promotion mode: ${String(mode)}`);
    }
    await this.state.storage.put('promotion_mode', mode);
    return mode;
  }

  private async handleInternal(request: Request, path: string, method: string): Promise<Response> {
    const lifecycle = await this.handleLifecycle(request, path, method);
    if (lifecycle) return lifecycle;

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

    // Service accounts: master-only at the edge. X-Actor-ID is the minting/revoking actor (audit).
    const actorId = request.headers.get('X-Actor-ID') || 'unknown';
    const accountRoute = path.match(/^\/internal\/service-accounts\/([^\/]+)\/(revoke|tokens)$/);
    const tokenRevoke = path.match(/^\/internal\/service-accounts\/([^\/]+)\/tokens\/([^\/]+)\/revoke$/);
    const readBody = async (): Promise<Record<string, unknown>> => {
      try {
        const body = await request.json();
        if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
      } catch {
        // fall through
      }
      throw new BadRequestError('invalid JSON body');
    };
    try {
      if (path === '/internal/service-accounts' && method === 'POST') {
        const body = await readBody();
        // The minting actor comes from the header, never from the body
        return json(this.createServiceAccount({ ...body, createdBy: request.headers.get('X-Actor-ID') ?? undefined }), 201);
      }
      if (path === '/internal/service-accounts' && method === 'GET') {
        return json(this.listServiceAccounts());
      }
      if (accountRoute && method === 'POST' && accountRoute[2] === 'revoke') {
        return this.revokeServiceAccount(decodeURIComponent(accountRoute[1]), actorId)
          ? json({ revoked: true })
          : fail('Not found', 404);
      }
      if (accountRoute && method === 'POST' && accountRoute[2] === 'tokens') {
        const body = await readBody();
        const token = this.createServiceToken(decodeURIComponent(accountRoute[1]), {
          ...body,
          createdBy: request.headers.get('X-Actor-ID') ?? undefined,
        });
        return json({ token }, 201);
      }
      if (tokenRevoke && method === 'POST') {
        return this.revokeServiceToken(decodeURIComponent(tokenRevoke[1]), decodeURIComponent(tokenRevoke[2]), actorId)
          ? json({ revoked: true })
          : fail('Not found', 404);
      }
    } catch (e) {
      const status =
        e instanceof BadRequestError ? 400 : e instanceof ForbiddenError ? 403 : e instanceof NotFoundError ? 404 : e instanceof ConflictError ? 409 : 0;
      if (status) return fail(e instanceof Error ? e.message : String(e), status);
      throw e;
    }
    if (path === '/internal/service-tokens/verify' && method === 'POST') {
      const { tokenHash } = (await request.json()) as { tokenHash?: unknown };
      if (typeof tokenHash !== 'string' || !SERVICE_TOKEN_HASH.test(tokenHash)) return fail('tokenHash must be a SHA-256 hex digest', 400);
      const principal = this.verifyServiceTokenHash(tokenHash);
      return principal ? json(principal) : fail('Not found', 404);
    }
    return fail('Not found', 404);
  }

  // ============================================================================
  // LEDGER LIFECYCLE (tombstones, maintainer role, purge)
  // Contract: workers/shared/ledger-lifecycle.ts. Each write runs in one
  // transactionSync; purge runs one per batch. Audit rows go to purge_log, and to
  // entity_history for the types its CHECK allows (spec, candidate, issue).
  // ============================================================================

  /**
   * role='maintainer', and not a service account's actor. Service principals never
   * reach the lifecycle routes (edge: master only); the DO refuses them as well.
   */
  isMaintainer(actorId: string): boolean {
    return (
      this.queryAll(
        `SELECT 1 AS ok FROM actors a WHERE a.id = ? AND a.role = 'maintainer'
           AND NOT EXISTS (SELECT 1 FROM service_accounts sa WHERE sa.actor_id = a.id)`,
        actorId
      ).length > 0
    );
  }

  private purgeMinAgeHours(): number {
    const raw = this.env?.PURGE_MIN_AGE_HOURS;
    if (raw === undefined || raw.trim() === '') return DEFAULT_PURGE_MIN_AGE_HOURS;
    const hours = Number(raw);
    return Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_PURGE_MIN_AGE_HOURS;
  }

  // The tombstoned entity first, then what cascades from it (logically downward)
  private tombstoneScope(entityType: TombstoneEntity, id: string): { table: string; where: string; params: string[] }[] {
    switch (entityType) {
      case 'organization':
        return [
          { table: 'organizations', where: 'id = ?', params: [id] },
          { table: 'repositories', where: 'organization_id = ?', params: [id] },
          { table: 'specs', where: 'organization_id = ?', params: [id] },
          { table: 'candidates', where: `id IN (${ORG_CANDIDATES})`, params: [id, id] },
          { table: 'issues', where: `id IN (${ORG_ISSUES})`, params: [id] },
        ];
      case 'repository':
        return [
          { table: 'repositories', where: 'id = ?', params: [id] },
          { table: 'candidates', where: 'repository_id = ?', params: [id] },
          { table: 'issues', where: 'repository_id = ?', params: [id] },
        ];
      case 'spec':
        return [
          { table: 'specs', where: 'id = ?', params: [id] },
          { table: 'candidates', where: 'spec_id = ?', params: [id] },
        ];
      case 'candidate':
        return [{ table: 'candidates', where: 'id = ?', params: [id] }];
    }
  }

  /**
   * Of these candidates, the ones with an active promotion, an in-flight promotion
   * state, or a live deploy ref (the head of some (spec, rung) points at them).
   */
  private activePromotionsAmong(candidateIds: string[]): string[] {
    const found = new Set<string>();
    for (const ids of chunk(candidateIds, MAX_BOUND_PARAMS)) {
      const marks = placeholders(ids.length);
      const rows = [
        ...this.queryAll(`SELECT candidate_id FROM promotions WHERE stage = 'active' AND candidate_id IN (${marks})`, ...ids),
        ...this.queryAll(
          `SELECT candidate_id FROM promotion_states WHERE status IN ('pending', 'in_progress') AND candidate_id IN (${marks})`,
          ...ids
        ),
        ...this.queryAll(`SELECT d.candidate_id FROM deploy_refs d WHERE ${DEPLOY_HEAD} AND d.candidate_id IN (${marks})`, ...ids),
      ];
      for (const r of rows) found.add(r.candidate_id as string);
    }
    return [...found].sort();
  }

  private logLifecycle(entry: {
    id?: string;
    action: 'tombstone' | 'purge' | 'role_change';
    requestedBy: string;
    selector: unknown;
    dryRun?: boolean;
    counts?: Record<string, number>;
    outcome: 'completed' | 'dry_run' | 'refused' | 'running' | 'failed';
    detail?: string;
    startedAt: number;
    finishedAt?: number;
  }): string {
    const id = entry.id ?? generateId();
    this.run(
      `INSERT INTO purge_log (id, action, requested_by, selector_json, dry_run, counts_json, outcome, detail, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      entry.action,
      entry.requestedBy,
      JSON.stringify(entry.selector),
      entry.dryRun ? 1 : 0,
      entry.counts ? JSON.stringify(entry.counts) : null,
      entry.outcome,
      entry.detail ?? null,
      entry.startedAt,
      entry.finishedAt ?? null
    );
    return id;
  }

  private finishLifecycleLog(id: string, outcome: 'completed' | 'failed', detail: string | null): void {
    this.run(`UPDATE purge_log SET outcome = ?, detail = ?, finished_at = ? WHERE id = ?`, outcome, detail, now(), id);
  }

  /**
   * Soft delete with a logical cascade (org -> repos, specs, their candidates and
   * issues; repo -> candidates, issues; spec -> candidates), one transaction.
   * Refused while a candidate in scope has an active or in-flight promotion.
   */
  tombstone(entityType: TombstoneEntity, id: string, actorId: string, reason?: string): TombstoneResult {
    if (entityType === 'organization' && id === RESERVED_ORGANIZATION_ID) {
      throw new ForbiddenError(`organization ${id} is reserved (service-account mints depend on it) and cannot be tombstoned`);
    }
    const scope = this.tombstoneScope(entityType, id);
    return this.state.storage.transactionSync(() => {
      const root = this.queryAll(`SELECT deleted_at FROM ${scope[0].table} WHERE id = ?`, id)[0];
      if (!root) throw new NotFoundError(`${entityType} ${id} not found`);
      if (root.deleted_at != null) throw new ConflictError(`${entityType} ${id} is already tombstoned`);

      const ids = scope.map(({ table, where, params }) =>
        this.queryAll(`SELECT id FROM ${table} WHERE deleted_at IS NULL AND (${where})`, ...params).map((r) => r.id as string)
      );
      const active = this.activePromotionsAmong(ids[scope.findIndex((s) => s.table === 'candidates')]);
      if (active.length) throw new ConflictError(`candidates with an active promotion: ${active.join(', ')}`);

      const deletedAt = now();
      const counts: Record<string, number> = {};
      scope.forEach(({ table, where, params }, i) => {
        this.run(
          `UPDATE ${table} SET deleted_at = ?, deleted_by = ?, delete_reason = ? WHERE deleted_at IS NULL AND (${where})`,
          deletedAt,
          actorId,
          reason ?? null,
          ...params
        );
        counts[table] = ids[i].length;
        const historyType = HISTORY_TYPES[table];
        if (historyType) {
          const metadata = JSON.stringify({ tombstoneRoot: { entityType, id } });
          for (const rowId of ids[i]) this.recordHistory(historyType, rowId, 'tombstoned', actorId, reason, metadata);
        }
      });
      this.logLifecycle({
        action: 'tombstone',
        requestedBy: actorId,
        selector: { entityType, id, reason },
        counts,
        outcome: 'completed',
        startedAt: deletedAt,
        finishedAt: now(),
      });
      return { entityType, id, deletedAt, counts };
    });
  }

  /** Why an organization matched by a purge selector cannot be purged, or null. */
  private purgeBlocker(org: Record<string, unknown>, cutoff: number): PurgeSkipped['reason'] | null {
    const orgId = org.id as string;
    if (orgId === RESERVED_ORGANIZATION_ID) return 'reserved';
    if (org.deleted_at == null) return 'not_tombstoned';
    if ((org.deleted_at as number) > cutoff) return 'too_recent';
    if (this.queryAll(`SELECT 1 AS x FROM service_accounts WHERE organization_id = ? LIMIT 1`, orgId).length) {
      return 'service_accounts';
    }
    for (const { table, where, params } of this.tombstoneScope('organization', orgId).slice(1)) {
      const live = this.queryAll(
        `SELECT 1 AS x FROM ${table} WHERE (${where}) AND (deleted_at IS NULL OR deleted_at > ?) LIMIT 1`,
        ...params,
        cutoff
      );
      if (live.length) return 'live_descendants';
    }
    // A repository of another org that points at one of these specs would block the FK delete
    const external = this.queryAll(
      `SELECT 1 AS x FROM repositories WHERE spec_id IN (${ORG_SPECS}) AND organization_id != ? LIMIT 1`,
      orgId,
      orgId
    );
    return external.length ? 'live_descendants' : null;
  }

  private planPurge(req: ParsedPurgeRequest, cutoff: number) {
    const orgs =
      req.orgNamePrefix !== undefined
        ? this.queryAll(
            `SELECT id, name, deleted_at FROM organizations WHERE substr(name, 1, length(?)) = ? ORDER BY created_at`,
            req.orgNamePrefix,
            req.orgNamePrefix
          )
        : chunk([...new Set(req.orgIds ?? [])], MAX_BOUND_PARAMS).flatMap((ids) =>
            this.queryAll(`SELECT id, name, deleted_at FROM organizations WHERE id IN (${placeholders(ids.length)})`, ...ids)
          );

    const orgIds: string[] = [];
    const skipped: PurgeSkipped[] = [];
    for (const org of orgs) {
      const reason = this.purgeBlocker(org, cutoff);
      if (reason) skipped.push({ orgId: org.id as string, name: org.name as string, reason });
      else orgIds.push(org.id as string);
    }

    const ids = new Map<string, Set<string>>(ORG_PURGE_ORDER.map(([table]) => [table, new Set<string>()]));
    for (const orgId of orgIds) {
      for (const [table, where] of ORG_PURGE_ORDER) {
        const rows = this.queryAll(`SELECT id FROM ${table} WHERE ${where}`, ...Array(bindCount(where)).fill(orgId));
        for (const r of rows) ids.get(table)!.add(r.id as string);
      }
    }
    const rows: [string, string][] = ORG_PURGE_ORDER.flatMap(([table]) => [...ids.get(table)!].map((id): [string, string] => [table, id]));
    const counts = Object.fromEntries(ORG_PURGE_ORDER.map(([table]) => [table, ids.get(table)!.size]));
    return { orgIds, skipped, rows, counts, total: rows.length, candidateIds: [...ids.get('candidates')!] };
  }

  /** One purge batch (<= PURGE_BATCH_SIZE rows, already in FK order). Runs inside transactionSync. */
  private deleteBatch(batch: [string, string][], actorId: string, purgeId: string): void {
    const active = this.activePromotionsAmong(batch.filter(([t]) => t === 'candidates').map(([, id]) => id));
    if (active.length) throw new ConflictError(`candidates gained an active promotion: ${active.join(', ')}`);
    const metadata = JSON.stringify({ purgeId });
    let i = 0;
    while (i < batch.length) {
      const table = batch[i][0];
      const ids: string[] = [];
      while (i < batch.length && batch[i][0] === table) ids.push(batch[i++][1]);
      for (const part of chunk(ids, MAX_BOUND_PARAMS)) {
        this.run(`DELETE FROM ${table} WHERE id IN (${placeholders(part.length)})`, ...part);
      }
      const historyType = HISTORY_TYPES[table];
      if (historyType) for (const id of ids) this.recordHistory(historyType, id, 'purged', actorId, undefined, metadata);
    }
  }

  /**
   * Hard delete of tombstoned organizations (and everything under them) older than
   * PURGE_MIN_AGE_HOURS. Dry run by default; a real run needs confirm === the
   * current dry-run total. Batches of <= PURGE_BATCH_SIZE rows, one transaction
   * each, yielding between batches so promotion decisions can interleave.
   */
  async purge(req: ParsedPurgeRequest, actorId: string): Promise<PurgeResult> {
    if (!this.isMaintainer(actorId)) throw new ForbiddenError('purge requires a maintainer actor (X-Actor-ID with role=maintainer)');
    // Named explicitly: refuse outright. A name-prefix match skips it instead (purgeBlocker 'reserved').
    if (req.orgIds?.includes(RESERVED_ORGANIZATION_ID)) {
      throw new ForbiddenError(`organization ${RESERVED_ORGANIZATION_ID} is reserved and cannot be purged`);
    }

    const startedAt = now();
    const minAgeHours = this.purgeMinAgeHours();
    const plan = this.planPurge(req, startedAt - minAgeHours * 3_600_000);
    const purgeId = generateId();
    const selector = req.orgNamePrefix !== undefined ? { orgNamePrefix: req.orgNamePrefix } : { orgIds: req.orgIds };
    const log = { id: purgeId, action: 'purge' as const, requestedBy: actorId, selector, dryRun: req.dryRun, counts: plan.counts, startedAt };
    const result = (batches: number): PurgeResult => ({
      purgeId,
      dryRun: req.dryRun,
      minAgeHours,
      orgIds: plan.orgIds,
      skipped: plan.skipped,
      counts: plan.counts,
      total: plan.total,
      batches,
    });
    const refuse = (detail: string) => {
      this.logLifecycle({ ...log, outcome: 'refused', detail, finishedAt: now() });
      return new ConflictError(detail);
    };

    const active = this.activePromotionsAmong(plan.candidateIds);
    if (active.length) throw refuse(`refused: candidates with an active promotion: ${active.join(', ')}`);
    if (req.dryRun) {
      this.logLifecycle({ ...log, outcome: 'dry_run', finishedAt: now() });
      return result(0);
    }
    if (req.confirm !== plan.total) {
      throw refuse(`confirm ${req.confirm} does not match the current dry-run total ${plan.total}; rerun the dry run`);
    }

    this.logLifecycle({ ...log, outcome: 'running' });
    const batches = chunk(plan.rows, PURGE_BATCH_SIZE);
    let done = 0;
    try {
      for (const batch of batches) {
        this.state.storage.transactionSync(() => this.deleteBatch(batch, actorId, purgeId));
        done++;
        if (done < batches.length) await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } catch (e) {
      const detail = `stopped after ${done} of ${batches.length} batches: ${e instanceof Error ? e.message : String(e)}`;
      this.finishLifecycleLog(purgeId, 'failed', detail);
      throw new ConflictError(`purge ${detail}; rerun the dry run`);
    }
    this.finishLifecycleLog(purgeId, 'completed', null);
    return result(batches.length);
  }

  /**
   * Grant or revoke the maintainer role. The caller must be a maintainer, except
   * the bootstrap case: with no maintainer yet, an actor may grant it to itself.
   */
  setActorRole(targetId: string, role: ActorRole | null, callerId: string): SetActorRoleResult {
    return this.state.storage.transactionSync(() => {
      if (!this.queryAll(`SELECT 1 AS x FROM actors WHERE id = ?`, targetId).length) {
        throw new NotFoundError(`actor ${targetId} not found`);
      }
      if (role !== null && this.isServiceActor(targetId)) {
        throw new ForbiddenError('a service account actor cannot hold a role');
      }
      const maintainers = this.queryAll(`SELECT COUNT(*) AS n FROM actors WHERE role = 'maintainer'`)[0].n as number;
      const bootstrap = maintainers === 0 && role === 'maintainer' && callerId === targetId;
      if (!bootstrap && !this.isMaintainer(callerId)) {
        throw new ForbiddenError('changing a role requires a maintainer actor (or self-grant while none exists)');
      }
      this.run(`UPDATE actors SET role = ? WHERE id = ?`, role, targetId);
      const at = now();
      this.logLifecycle({
        action: 'role_change',
        requestedBy: callerId,
        selector: { actorId: targetId, role, bootstrap },
        outcome: 'completed',
        startedAt: at,
        finishedAt: at,
      });
      return { actorId: targetId, role };
    });
  }

  private async handleLifecycle(request: Request, path: string, method: string): Promise<Response | null> {
    const roleRoute = path.match(/^\/internal\/actors\/([^\/]+)\/role$/);
    if (method !== 'POST' || !(path === LIFECYCLE_PATHS.tombstone || path === LIFECYCLE_PATHS.purge || roleRoute)) {
      return null;
    }
    const respond = (body: Record<string, unknown>, status: number) =>
      new Response(JSON.stringify({ success: status < 400, ...body, timestamp: Date.now() }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    const actorId = request.headers.get('X-Actor-ID') || 'unknown';
    // Defence in depth: the edge allows these routes for the master principal only.
    // A service account's actor never tombstones, purges or changes a role.
    if (this.isServiceActor(actorId)) return respond({ error: 'service account actors cannot use lifecycle routes' }, 403);

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return respond({ error: 'invalid JSON body' }, 400);
    }
    try {
      if (path === LIFECYCLE_PATHS.tombstone) {
        const body = TombstoneRequestSchema.safeParse(raw);
        if (!body.success) return respond({ error: body.error.message }, 400);
        return respond({ data: this.tombstone(body.data.entityType, body.data.id, actorId, body.data.reason) }, 200);
      }
      if (path === LIFECYCLE_PATHS.purge) {
        const body = PurgeRequestSchema.safeParse(raw);
        if (!body.success) return respond({ error: body.error.message }, 400);
        return respond({ data: await this.purge(body.data, actorId) }, 200);
      }
      const body = SetActorRoleRequestSchema.safeParse(raw);
      if (!body.success) return respond({ error: body.error.message }, 400);
      return respond({ data: this.setActorRole(decodeURIComponent(roleRoute![1]), body.data.role, actorId) }, 200);
    } catch (e) {
      const status = e instanceof NotFoundError ? 404 : e instanceof ForbiddenError ? 403 : e instanceof ConflictError ? 409 : 500;
      return respond({ error: e instanceof Error ? e.message : String(e) }, status);
    }
  }

  // ============================================================================
  // PROMOTION LEDGER (promotion states, tournaments, merge trains)
  // Payload shapes: workers/shared/promotion-ledger.ts. Responses are the bare
  // records the promotion worker reads. Every write runs in one transactionSync.
  // ============================================================================

  private async handlePromotionLedger(
    request: Request,
    url: URL,
    collection: string,
    rawId: string | undefined,
    method: string
  ): Promise<Response> {
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const fail = (error: string, status: number, code?: string) =>
      json({ success: false, error, ...(code ? { code } : {}), timestamp: Date.now() }, status);
    // Coded so the client can tell "no such record" from "no such route"
    const notFound = (what: string) => fail(`${what} not found`, 404, RECORD_NOT_FOUND);

    const id = rawId === undefined ? undefined : decodeURIComponent(rawId);
    const isListAll = id !== undefined && `/${id}` === LIST_ALL_SUFFIX;

    let body: unknown;
    if (method === 'POST' || method === 'PATCH') {
      try {
        body = await request.json();
      } catch {
        return fail('Invalid JSON body', 400);
      }
    }
    const parse = <T>(schema: ZodType<T>, what: string): { data: T } | { error: Response } => {
      const parsed = schema.safeParse(body);
      return parsed.success
        ? { data: parsed.data }
        : { error: fail(`Invalid ${what}: ${parsed.error.message}`, 400) };
    };

    if (collection === LEDGER_PATHS.promotionStates) {
      if (id === undefined && method === 'GET') {
        return json(this.listPromotionStates(url.searchParams.get('candidateId') ?? undefined));
      }
      if (id === undefined && method === 'POST') {
        const p = parse(PromotionStateSchema, 'promotion state');
        if ('error' in p) return p.error;
        return json(this.createPromotionState(p.data), 201);
      }
      if (id !== undefined && method === 'PATCH') {
        const p = parse(PromotionStatePatchSchema, 'promotion state patch');
        if ('error' in p) return p.error;
        const updated = this.patchPromotionState(id, p.data);
        return updated ? json(updated) : notFound('Promotion state');
      }
    }

    if (collection === LEDGER_PATHS.tournaments) {
      if (isListAll && method === 'GET') {
        return json(this.listTournaments());
      }
      if (id === undefined && method === 'GET') {
        const specId = url.searchParams.get('specId');
        if (!specId) return fail('specId required', 400);
        const tournament = this.listTournaments(specId)[0];
        return tournament ? json(tournament) : notFound('Tournament');
      }
      if (id === undefined && method === 'POST') {
        const p = parse(TournamentRecordSchema, 'tournament');
        if ('error' in p) return p.error;
        const expected = expectedVersion(request);
        if (expected === 'invalid') return fail(`Invalid ${EXPECTED_VERSION_HEADER}`, 400);
        const result = this.state.storage.transactionSync(() =>
          this.applyTournamentWrite(p.data.id, () => p.data, expected)
        );
        if (result === null) return notFound('Tournament'); // only a PATCH can miss
        if ('refused' in result) return fail(result.refused.message, 409, result.refused.code);
        return json(result.record, result.created ? 201 : 200);
      }
      if (id !== undefined && !isListAll && method === 'PATCH') {
        const p = parse(TournamentPatchSchema, 'tournament patch');
        if ('error' in p) return p.error;
        const expected = expectedVersion(request);
        if (expected === 'invalid') return fail(`Invalid ${EXPECTED_VERSION_HEADER}`, 400);
        const result = this.state.storage.transactionSync(() =>
          this.applyTournamentWrite(id, (current) => TournamentRecordSchema.parse({ ...current, ...p.data, id }), expected, true)
        );
        if (result === null) return notFound('Tournament');
        if ('refused' in result) return fail(result.refused.message, 409, result.refused.code);
        return json(result.record);
      }
    }

    if (collection === LEDGER_PATHS.mergeTrains) {
      if (isListAll && method === 'GET') {
        return json(this.listMergeTrains());
      }
      if (id === undefined && method === 'GET') {
        const specId = url.searchParams.get('specId');
        if (!specId) return fail('specId required', 400);
        const train = this.listMergeTrains(specId)[0];
        return train ? json(train) : notFound('Merge train');
      }
      if (id === undefined && method === 'POST') {
        const p = parse(MergeTrainRecordSchema, 'merge train');
        if ('error' in p) return p.error;
        const expected = expectedVersion(request);
        if (expected === 'invalid') return fail(`Invalid ${EXPECTED_VERSION_HEADER}`, 400);
        const result = this.state.storage.transactionSync(() =>
          this.applyMergeTrainWrite(p.data.id, () => p.data, expected)
        );
        if (result === null) return notFound('Merge train'); // only a PATCH can miss
        if ('refused' in result) return fail(result.refused.message, 409, result.refused.code);
        return json(result.record, result.created ? 201 : 200);
      }
      if (id !== undefined && !isListAll && method === 'PATCH') {
        const p = parse(MergeTrainPatchSchema, 'merge train patch');
        if ('error' in p) return p.error;
        const expected = expectedVersion(request);
        if (expected === 'invalid') return fail(`Invalid ${EXPECTED_VERSION_HEADER}`, 400);
        const result = this.state.storage.transactionSync(() =>
          this.applyMergeTrainWrite(id, (current) => MergeTrainRecordSchema.parse({ ...current, ...p.data, id }), expected, true)
        );
        if (result === null) return notFound('Merge train');
        if ('refused' in result) return fail(result.refused.message, 409, result.refused.code);
        return json(result.record);
      }
    }

    return fail('Not found', 404);
  }

  /** Newest first: the promotion worker treats element 0 as the candidate's current state. */
  listPromotionStates(candidateId?: string): PromotionState[] {
    const rows = candidateId
      ? this.queryAll(
          'SELECT * FROM promotion_states WHERE candidate_id = ? ORDER BY created_at DESC, rowid DESC',
          candidateId
        )
      : this.queryAll('SELECT * FROM promotion_states ORDER BY created_at DESC, rowid DESC');
    return rows.map((r) => this.rowToPromotionState(r));
  }

  createPromotionState(state: PromotionState): PromotionState {
    return this.state.storage.transactionSync(() => {
      if (this.getPromotionState(state.id)) {
        throw new ConflictError(`Promotion state '${state.id}' already exists`);
      }
      const ts = now();
      this.run(
        `INSERT INTO promotion_states (id, candidate_id, spec_id, current_rung, target_rung, status, mode,
           started_at, completed_at, failed_at, failure_reason, rollback_reason, actor_id, metadata,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ...this.promotionStateColumns(state),
        ts,
        ts
      );
      return this.getPromotionState(state.id)!;
    });
  }

  /** Null when the id is unknown. A null field in the patch clears that field. */
  patchPromotionState(
    id: string,
    patch: Record<string, unknown>
  ): PromotionState | null {
    return this.state.storage.transactionSync(() => {
      const current = this.getPromotionState(id);
      if (!current) return null;
      const merged: Record<string, unknown> = { ...current };
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete merged[key];
        else merged[key] = value;
      }
      const next = PromotionStateSchema.parse({ ...merged, id });
      const [, ...columns] = this.promotionStateColumns(next);
      this.run(
        `UPDATE promotion_states SET candidate_id = ?, spec_id = ?, current_rung = ?, target_rung = ?,
           status = ?, mode = ?, started_at = ?, completed_at = ?, failed_at = ?, failure_reason = ?,
           rollback_reason = ?, actor_id = ?, metadata = ?, updated_at = ?
         WHERE id = ?`,
        ...columns,
        now(),
        id
      );
      return this.getPromotionState(id);
    });
  }

  private getPromotionState(id: string): PromotionState | null {
    const row = this.queryAll('SELECT * FROM promotion_states WHERE id = ?', id)[0];
    return row ? this.rowToPromotionState(row) : null;
  }

  // Column order of promotion_states from id through metadata
  private promotionStateColumns(s: PromotionState): (string | null)[] {
    return [
      s.id,
      s.candidateId,
      s.specId,
      s.currentRung,
      s.targetRung,
      s.status,
      s.mode,
      s.startedAt,
      s.completedAt ?? null,
      s.failedAt ?? null,
      s.failureReason ?? null,
      s.rollbackReason ?? null,
      s.actorId ?? null,
      s.metadata === undefined ? null : JSON.stringify(s.metadata),
    ];
  }

  private rowToPromotionState(r: Record<string, unknown>): PromotionState {
    return PromotionStateSchema.parse(
      dropNulls({
        id: r.id,
        candidateId: r.candidate_id,
        specId: r.spec_id,
        currentRung: r.current_rung,
        targetRung: r.target_rung,
        status: r.status,
        mode: r.mode,
        startedAt: r.started_at,
        completedAt: r.completed_at,
        failedAt: r.failed_at,
        failureReason: r.failure_reason,
        rollbackReason: r.rollback_reason,
        actorId: r.actor_id,
        metadata: r.metadata == null ? null : JSON.parse(r.metadata as string),
      })
    );
  }

  /** Newest first; filtered to one spec when specId is given. */
  listTournaments(specId?: string): TournamentRecord[] {
    const rows = specId
      ? this.queryAll('SELECT * FROM tournaments WHERE spec_id = ? ORDER BY created_at DESC, rowid DESC', specId)
      : this.queryAll('SELECT * FROM tournaments ORDER BY created_at DESC, rowid DESC');
    return rows.map((r) => this.rowToTournament(r));
  }

  private getTournament(id: string): TournamentRecord | null {
    const row = this.queryAll('SELECT * FROM tournaments WHERE id = ?', id)[0];
    return row ? this.rowToTournament(row) : null;
  }

  /**
   * The one write path for tournaments (run inside transactionSync). `build` gets the current
   * record (null when `id` is new) and returns the record to store. Refuses with a coded 409
   * reason when the caller's version is stale or missing, or the status transition is not allowed.
   * `patch` = the caller is changing an existing record: a missing id answers null (404), and
   * a missing expected version is accepted (the PATCH merge is atomic on its own).
   */
  private applyTournamentWrite(
    id: string,
    build: (current: TournamentRecord | null) => TournamentRecord,
    expected: number | null,
    patch = false
  ): { record: TournamentRecord; created: boolean } | { refused: { code: string; message: string } } | null {
    const row = this.queryAll('SELECT version, attempts FROM tournaments WHERE id = ?', id)[0];
    const current = this.getTournament(id);
    if (!current && patch) return null;
    const stale = checkExpectedVersion(current ? (row.version as number) : null, expected, patch);
    if (stale) return { refused: stale };

    const next = build(current);
    const attempts = current ? (row.attempts as number) : 0;
    const violation = checkTournamentTransition(current, next, attempts);
    if (violation) return { refused: violation };

    const entersFailed = next.status === 'failed' && current?.status !== 'failed';
    const resets = next.status === 'pending' && current?.status === 'failed';
    this.writeTournament(next, {
      version: current ? (row.version as number) + 1 : 1,
      attempts: resets ? 0 : attempts + (entersFailed ? 1 : 0),
      // failure details belong to 'failed' only; entering it stamps failedAt, leaving it clears both
      failedAt: next.status === 'failed' ? (entersFailed ? new Date().toISOString() : (next.failedAt ?? current?.failedAt ?? null)) : null,
      failureReason: next.status === 'failed' ? (next.failureReason ?? null) : null,
    });
    return { record: this.getTournament(id)!, created: !current };
  }

  // Upsert by id; version, attempts and the failure columns come from applyTournamentWrite
  private writeTournament(
    t: TournamentRecord,
    meta: { version: number; attempts: number; failedAt: string | null; failureReason: string | null }
  ): void {
    const ts = now();
    this.run(
      `INSERT INTO tournaments (id, spec_id, status, winner, candidates, comparisons, started_at, completed_at,
         created_at, updated_at, version, attempts, failed_at, failure_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET spec_id = excluded.spec_id, status = excluded.status,
         winner = excluded.winner, candidates = excluded.candidates, comparisons = excluded.comparisons,
         started_at = excluded.started_at, completed_at = excluded.completed_at, updated_at = excluded.updated_at,
         version = excluded.version, attempts = excluded.attempts, failed_at = excluded.failed_at,
         failure_reason = excluded.failure_reason`,
      t.id,
      t.specId,
      t.status,
      t.winner ?? null,
      JSON.stringify(t.candidates),
      JSON.stringify(t.comparisons),
      t.startedAt,
      t.completedAt ?? null,
      ts,
      ts,
      meta.version,
      meta.attempts,
      meta.failedAt,
      meta.failureReason
    );
  }

  private rowToTournament(r: Record<string, unknown>): TournamentRecord {
    return TournamentRecordSchema.parse(
      dropNulls({
        id: r.id,
        mode: 'tournament',
        specId: r.spec_id,
        candidates: JSON.parse(r.candidates as string),
        winner: r.winner,
        comparisons: JSON.parse(r.comparisons as string),
        startedAt: r.started_at,
        completedAt: r.completed_at,
        status: r.status,
        failedAt: r.failed_at,
        failureReason: r.failure_reason,
        version: r.version,
        attempts: r.attempts,
      })
    );
  }

  /** Newest first; filtered to one spec when specId is given. */
  listMergeTrains(specId?: string): MergeTrainRecord[] {
    const rows = specId
      ? this.queryAll('SELECT * FROM merge_trains WHERE spec_id = ? ORDER BY created_at DESC, rowid DESC', specId)
      : this.queryAll('SELECT * FROM merge_trains ORDER BY created_at DESC, rowid DESC');
    return rows.map((r) => this.rowToMergeTrain(r));
  }

  private getMergeTrain(id: string): MergeTrainRecord | null {
    const row = this.queryAll('SELECT * FROM merge_trains WHERE id = ?', id)[0];
    return row ? this.rowToMergeTrain(row) : null;
  }

  /** The one write path for merge trains; same contract as applyTournamentWrite (no status machine). */
  private applyMergeTrainWrite(
    id: string,
    build: (current: MergeTrainRecord | null) => MergeTrainRecord,
    expected: number | null,
    patch = false
  ): { record: MergeTrainRecord; created: boolean } | { refused: { code: string; message: string } } | null {
    const row = this.queryAll('SELECT version FROM merge_trains WHERE id = ?', id)[0];
    const current = this.getMergeTrain(id);
    if (!current && patch) return null;
    const stale = checkExpectedVersion(current ? (row.version as number) : null, expected, patch);
    if (stale) return { refused: stale };

    this.writeMergeTrain(build(current), current ? (row.version as number) + 1 : 1);
    return { record: this.getMergeTrain(id)!, created: !current };
  }

  // Upsert by id; the version comes from applyMergeTrainWrite
  private writeMergeTrain(t: MergeTrainRecord, version: number): void {
    const ts = now();
    this.run(
      `INSERT INTO merge_trains (id, spec_id, status, current_position, next_merge, candidates, started_at,
         completed_at, created_at, updated_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET spec_id = excluded.spec_id, status = excluded.status,
         current_position = excluded.current_position, next_merge = excluded.next_merge,
         candidates = excluded.candidates, started_at = excluded.started_at,
         completed_at = excluded.completed_at, updated_at = excluded.updated_at, version = excluded.version`,
      t.id,
      t.specId,
      t.status,
      t.currentPosition,
      t.nextMerge,
      JSON.stringify(t.candidates),
      t.startedAt ?? null,
      t.completedAt ?? null,
      ts,
      ts,
      version
    );
  }

  private rowToMergeTrain(r: Record<string, unknown>): MergeTrainRecord {
    return MergeTrainRecordSchema.parse({
      ...dropNulls({
        id: r.id,
        mode: 'merge-train',
        specId: r.spec_id,
        candidates: JSON.parse(r.candidates as string),
        currentPosition: r.current_position,
        status: r.status,
        startedAt: r.started_at,
        completedAt: r.completed_at,
        version: r.version,
      }),
      // nextMerge is nullable, not optional
      nextMerge: r.next_merge ?? null,
    });
  }

  // ============================================================================
  // DEPLOY REFS + CANARY DEPLOYMENTS
  // Payload shapes: workers/shared/deploy-refs.ts. Envelope { success, data }.
  // A pointer move and its canary_deployments / promotions updates run in one
  // transactionSync. Promotion and rollback both insert the new head.
  // ============================================================================

  private async handleDeployRefs(
    request: Request,
    url: URL,
    collection: string,
    rawId: string | undefined,
    sub: string | undefined,
    method: string
  ): Promise<Response> {
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify({ success: true, data, timestamp: Date.now() }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    const fail = (error: string, status: number, code?: string) =>
      new Response(JSON.stringify({ success: false, error, ...(code ? { code } : {}), timestamp: Date.now() }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    const notFound = (what: string) => fail(`${what} not found`, 404, RECORD_NOT_FOUND);

    const actorId = request.headers.get('X-Actor-ID') || 'system';
    const id = rawId === undefined ? undefined : decodeURIComponent(rawId);

    let body: unknown;
    if (method === 'POST' || method === 'PATCH') {
      try {
        body = await request.json();
      } catch {
        return fail('Invalid JSON body', 400);
      }
    }
    const parse = <T>(schema: ZodType<T>, what: string): { data: T } | { error: Response } => {
      const parsed = schema.safeParse(body);
      return parsed.success ? { data: parsed.data } : { error: fail(`Invalid ${what}: ${parsed.error.message}`, 400) };
    };
    const rungParam = DeployRungSchema.safeParse(url.searchParams.get('rung'));

    try {
      if (collection === 'canary-deployments') {
        if (id === undefined && method === 'GET') {
          const candidateId = url.searchParams.get('candidateId');
          if (!candidateId) return fail('candidateId required', 400);
          return json(this.listCanaryDeployments(candidateId));
        }
        if (id === undefined && method === 'POST') {
          const p = parse(CanaryDeployRequestSchema, 'canary deployment');
          if ('error' in p) return p.error;
          return json(this.deployCanary(p.data, actorId), 201);
        }
        if (id !== undefined && sub === undefined && method === 'GET') {
          const deployment = this.getCanaryDeployment(id);
          return deployment ? json(deployment) : notFound('Canary deployment');
        }
        if (id !== undefined && sub === undefined && method === 'PATCH') {
          const p = parse(CanaryPatchSchema, 'canary deployment patch');
          if ('error' in p) return p.error;
          const deployment = this.setCanaryAutoRollback(id, p.data.autoRollback);
          return deployment ? json(deployment) : notFound('Canary deployment');
        }
        if (id !== undefined && sub === 'rollback' && method === 'POST') {
          const p = parse(RollbackRequestSchema, 'rollback');
          if ('error' in p) return p.error;
          return json(this.rollbackCanary(id, p.data.reason, actorId));
        }
      }

      if (collection === 'deploy-refs' && sub === undefined) {
        if ((id === undefined || id === 'head') && method === 'GET') {
          const specId = url.searchParams.get('specId');
          if (!specId || !rungParam.success) return fail('specId and rung (canary|full) required', 400);
          if (id === undefined) return json(this.listDeployRefs(specId, rungParam.data));
          const head = this.deployHead(specId, rungParam.data);
          return head ? json(head) : notFound('Deploy ref');
        }
        if (id === 'live' && method === 'GET') {
          if (!rungParam.success) return fail('rung (canary|full) required', 400);
          return json(this.liveRefs(rungParam.data));
        }
        if (id === 'rollback' && method === 'POST') {
          const p = parse(RefRollbackRequestSchema, 'rollback');
          if ('error' in p) return p.error;
          const { specId, rung, reason } = p.data;
          return json(this.state.storage.transactionSync(() => this.rollbackHead(specId, rung, reason, actorId)));
        }
      }
    } catch (e) {
      if (e instanceof NotFoundError) return fail(e.message, 404, RECORD_NOT_FOUND);
      if (e instanceof ConflictError) return fail(e.message, 409);
      throw e;
    }

    return fail('Not found', 404);
  }

  /** The head of a (spec, rung) chain, or null before its first move. */
  deployHead(specId: string, rung: DeployRung): DeployRef | null {
    const row = this.queryAll(`SELECT * FROM deploy_refs d WHERE d.spec_id = ? AND d.rung = ? AND ${DEPLOY_HEAD}`, specId, rung)[0];
    return row ? this.rowToDeployRef(row) : null;
  }

  /** The chain from the head back to the first move (newest first). */
  listDeployRefs(specId: string, rung: DeployRung): DeployRef[] {
    const byId = new Map(
      this.queryAll('SELECT * FROM deploy_refs WHERE spec_id = ? AND rung = ?', specId, rung).map((r) => [
        r.id as string,
        this.rowToDeployRef(r),
      ])
    );
    const chain: DeployRef[] = [];
    for (let ref = this.deployHead(specId, rung); ref; ref = ref.prevRefId ? byId.get(ref.prevRefId) ?? null : null) {
      chain.push(ref);
    }
    return chain;
  }

  /** Heads that point at a candidate, with the canary deployment each one serves. */
  liveRefs(rung: DeployRung): LiveRef[] {
    return this.queryAll(`SELECT * FROM deploy_refs d WHERE d.rung = ? AND d.candidate_id IS NOT NULL AND ${DEPLOY_HEAD}`, rung).map(
      (r) => {
        const ref = this.rowToDeployRef(r);
        return { ref, deployment: rung === 'canary' ? this.canaryForRef(ref) : null };
      }
    );
  }

  /** Record a canary and move the spec's canary ref to it, in one transaction. */
  deployCanary(request: CanaryDeployRequest, actorId: string): CanaryMoveResult {
    return this.state.storage.transactionSync(() => {
      // Ids need no ledger row (like the promotion ledger), but a tombstoned one is gone
      const candidate = this.queryAll('SELECT deleted_at FROM candidates WHERE id = ?', request.candidateId)[0];
      if (candidate && candidate.deleted_at != null) throw new NotFoundError(`Candidate ${request.candidateId} not found`);
      const spec = this.queryAll('SELECT deleted_at FROM specs WHERE id = ?', request.specId)[0];
      if (spec && spec.deleted_at != null) throw new NotFoundError(`Spec ${request.specId} not found`);

      const ref = this.moveDeployRef(
        request.specId,
        'canary',
        { candidateId: request.candidateId, commitSha: request.commitSha ?? null, workerVersionId: request.workerVersionId },
        'promote',
        actorId
      );
      const id = generateId();
      const ts = now();
      this.run(
        `INSERT INTO canary_deployments (id, candidate_id, spec_id, status, url, worker_version_id, commit_sha,
           traffic_percentage, holdout_percentage, auto_rollback, deploy_ref_id, rollback_reason, created_at, updated_at)
         VALUES (?, ?, ?, 'deployed', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        id,
        request.candidateId,
        request.specId,
        request.url,
        request.workerVersionId,
        request.commitSha ?? null,
        request.trafficPercentage,
        request.holdoutPercentage,
        request.autoRollback === false ? 0 : 1,
        ref.id,
        ts,
        ts
      );
      this.syncCanaryStatuses(request.specId);
      return { deployment: this.getCanaryDeployment(id)!, ref };
    });
  }

  /** Roll back a live canary: its spec's canary ref moves to the previous target. */
  rollbackCanary(id: string, reason: string, actorId: string): CanaryMoveResult {
    return this.state.storage.transactionSync(() => {
      const deployment = this.getCanaryDeployment(id);
      if (!deployment) throw new NotFoundError(`Canary deployment ${id} not found`);
      const head = this.deployHead(deployment.specId, 'canary');
      if (deployment.status !== 'deployed' || head?.workerVersionId !== deployment.workerVersionId) {
        throw new ConflictError(`Canary deployment ${id} is not live (status ${deployment.status})`);
      }
      const ref = this.rollbackHead(deployment.specId, 'canary', reason, actorId);
      return { deployment: this.getCanaryDeployment(id)!, ref };
    });
  }

  listCanaryDeployments(candidateId: string): CanaryDeployment[] {
    return this.queryAll('SELECT * FROM canary_deployments WHERE candidate_id = ? ORDER BY created_at DESC, rowid DESC', candidateId).map(
      (r) => this.rowToCanaryDeployment(r)
    );
  }

  getCanaryDeployment(id: string): CanaryDeployment | null {
    const row = this.queryAll('SELECT * FROM canary_deployments WHERE id = ?', id)[0];
    return row ? this.rowToCanaryDeployment(row) : null;
  }

  setCanaryAutoRollback(id: string, autoRollback: boolean): CanaryDeployment | null {
    return this.state.storage.transactionSync(() => {
      if (!this.getCanaryDeployment(id)) return null;
      this.run('UPDATE canary_deployments SET auto_rollback = ?, updated_at = ? WHERE id = ?', autoRollback ? 1 : 0, now(), id);
      return this.getCanaryDeployment(id);
    });
  }

  /** Insert the new head of (spec, rung). Runs inside transactionSync. */
  private moveDeployRef(
    specId: string,
    rung: DeployRung,
    target: { candidateId: string | null; commitSha: string | null; workerVersionId: string | null },
    action: DeployRef['action'],
    actorId: string
  ): DeployRef {
    const head = this.deployHead(specId, rung);
    const id = generateId();
    this.run(
      `INSERT INTO deploy_refs (id, spec_id, rung, candidate_id, commit_sha, worker_version_id, prev_ref_id, action, moved_by, moved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      specId,
      rung,
      target.candidateId,
      target.commitSha,
      target.workerVersionId,
      head?.id ?? null,
      action,
      actorId,
      now()
    );
    return this.rowToDeployRef(this.queryAll('SELECT * FROM deploy_refs WHERE id = ?', id)[0]);
  }

  /**
   * Move the head to the target of head.prev_ref_id (the empty ref when there is
   * none), mark the candidate's active promotion to this rung rolled back, and
   * re-derive canary statuses from the new head. Runs inside transactionSync.
   */
  private rollbackHead(specId: string, rung: DeployRung, reason: string, actorId: string): DeployRef {
    const head = this.deployHead(specId, rung);
    if (!head) throw new NotFoundError(`Deploy ref ${specId}/${rung} not found`);
    const prevRow = head.prevRefId ? this.queryAll('SELECT * FROM deploy_refs WHERE id = ?', head.prevRefId)[0] : undefined;
    const prev = prevRow ? this.rowToDeployRef(prevRow) : null;
    const ref = this.moveDeployRef(
      specId,
      rung,
      { candidateId: prev?.candidateId ?? null, commitSha: prev?.commitSha ?? null, workerVersionId: prev?.workerVersionId ?? null },
      'rollback',
      actorId
    );
    if (head.candidateId) {
      this.run(
        `UPDATE promotions SET stage = 'rolled_back', rollback_reason = ? WHERE candidate_id = ? AND to_rung = ? AND stage = 'active'`,
        reason,
        head.candidateId,
        rung
      );
    }
    if (rung === 'canary') {
      if (head.workerVersionId) {
        this.run(
          `UPDATE canary_deployments SET status = 'rolled_back', rollback_reason = ?, updated_at = ?
           WHERE spec_id = ? AND worker_version_id = ? AND status = 'deployed'`,
          reason,
          now(),
          specId,
          head.workerVersionId
        );
      }
      this.syncCanaryStatuses(specId);
    }
    return ref;
  }

  /** The canary the head points at is 'deployed'; any other 'deployed' one is superseded. */
  private syncCanaryStatuses(specId: string): void {
    const head = this.deployHead(specId, 'canary');
    const live = head ? this.canaryForRef(head) : null;
    const ts = now();
    this.run(
      `UPDATE canary_deployments SET status = 'superseded', updated_at = ? WHERE spec_id = ? AND status = 'deployed' AND id IS NOT ?`,
      ts,
      specId,
      live?.id ?? null
    );
    if (live && live.status !== 'deployed') {
      this.run(`UPDATE canary_deployments SET status = 'deployed', updated_at = ? WHERE id = ?`, ts, live.id);
    }
  }

  /** Newest canary deployment of the ref's spec and worker version, if any. */
  private canaryForRef(ref: DeployRef): CanaryDeployment | null {
    if (!ref.workerVersionId) return null;
    const row = this.queryAll(
      'SELECT * FROM canary_deployments WHERE spec_id = ? AND worker_version_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      ref.specId,
      ref.workerVersionId
    )[0];
    return row ? this.rowToCanaryDeployment(row) : null;
  }

  private rowToDeployRef(r: Record<string, unknown>): DeployRef {
    return DeployRefSchema.parse({
      id: r.id,
      specId: r.spec_id,
      rung: r.rung,
      candidateId: r.candidate_id ?? null,
      commitSha: r.commit_sha ?? null,
      workerVersionId: r.worker_version_id ?? null,
      prevRefId: r.prev_ref_id ?? null,
      action: r.action,
      movedBy: r.moved_by,
      movedAt: r.moved_at,
    });
  }

  private rowToCanaryDeployment(r: Record<string, unknown>): CanaryDeployment {
    return CanaryDeploymentSchema.parse({
      id: r.id,
      candidateId: r.candidate_id,
      specId: r.spec_id,
      status: r.status,
      url: r.url,
      workerVersionId: r.worker_version_id,
      commitSha: r.commit_sha ?? null,
      trafficPercentage: r.traffic_percentage,
      holdoutPercentage: r.holdout_percentage,
      autoRollback: Number(r.auto_rollback) === 1,
      deployRefId: r.deploy_ref_id,
      rollbackReason: r.rollback_reason ?? null,
      createdAt: new Date(r.created_at as number).toISOString(),
      updatedAt: new Date(r.updated_at as number).toISOString(),
    });
  }

  // Fetch from Durable Object
  async fetch(request: Request): Promise<Response> {
    // Internal token check first: before routing, before the schema is touched
    const denied = specDoAuthGate(request, this.env);
    if (denied) return denied;

    // Promotion mode is key-value state: answer before the SQL schema is touched
    if (new URL(request.url).pathname === '/promotion-mode') {
      const modeHeaders = { 'Content-Type': 'application/json' };
      try {
        if (request.method === 'GET') {
          return new Response(JSON.stringify({ mode: await this.getPromotionMode() }), { headers: modeHeaders });
        }
        if (request.method === 'POST') {
          const { mode } = (await request.json()) as { mode: 'tournament' | 'merge-train' };
          return new Response(JSON.stringify({ mode: await this.setPromotionMode(mode) }), { headers: modeHeaders });
        }
        return new Response('Method not allowed', { status: 405 });
      } catch (error) {
        return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), {
          status: 400,
          headers: modeHeaders,
        });
      }
    }

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

      // Promotion ledger: called by the promotion worker over the SPEC_DO binding
      const ledgerRoute = path.match(LEDGER_ROUTE);
      if (ledgerRoute) {
        return await this.handlePromotionLedger(request, url, ledgerRoute[1], ledgerRoute[2], method);
      }

      // Deploy refs + canary deployments: canary worker and shadow router, over the SPEC_DO binding
      const deployRoute = path.match(DEPLOY_ROUTE);
      if (deployRoute) {
        return await this.handleDeployRefs(request, url, deployRoute[1], deployRoute[2], deployRoute[3], method);
      }

      // Extract actor ID from headers
      const actorId = request.headers.get('X-Actor-ID') || 'unknown';

      // Tombstoned rows are visible only to maintainers, and only on request
      const includeDeleted = url.searchParams.get(INCLUDE_DELETED_PARAM) === '1';
      if (includeDeleted && !this.isMaintainer(actorId)) {
        return new Response(
          JSON.stringify({ success: false, error: `${INCLUDE_DELETED_PARAM} requires a maintainer actor`, timestamp: Date.now() }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        );
      }
      
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
        const orgs = this.listOrganizations(limit, offset, includeDeleted);
        return new Response(JSON.stringify({ success: true, data: orgs, timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (path.match(/^\/api\/organizations\/[^\/]+$/) && method === 'GET') {
        const id = this.extractId(path);
        const org = this.getOrganization(id, includeDeleted);
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
        const repos = this.listRepositories(limit, offset, includeDeleted);
        return new Response(JSON.stringify({ success: true, data: repos, timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (path.match(/^\/api\/repositories\/[^\/]+$/) && method === 'GET') {
        const id = this.extractId(path);
        const repo = this.getRepository(id, includeDeleted);
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
        const specs = this.listSpecs(limit, offset, organizationId, stage, includeDeleted);
        return new Response(JSON.stringify({ success: true, data: specs, timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (path.match(/^\/api\/specs\/[^\/]+$/) && method === 'GET') {
        const id = this.extractId(path);
        const spec = this.getSpec(id, includeDeleted);
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
        const candidates = this.listCandidates(limit, offset, specId, agentId, stage, includeDeleted);
        return new Response(JSON.stringify({ success: true, data: candidates.map(c => this.candidateRowToResponse(c)), timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (path.match(/^\/api\/candidates\/[^\/]+$/) && method === 'GET') {
        const id = this.extractId(path);
        const candidate = this.getCandidate(id, includeDeleted);
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
        return this.issueRoute(201, () => {
          this.requireIssueActor(actorId);
          this.requireSameAuthor(body.createdBy, actorId);
          return this.createIssue(body.number, body.repositoryId, body.title, body.body || '', actorId, body.labels);
        });
      }
      
      if (path === '/api/issues' && method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit') || '50');
        const offset = parseInt(url.searchParams.get('offset') || '0');
        const repositoryId = url.searchParams.get('repositoryId') ?? undefined;
        const stage = url.searchParams.get('stage') ?? undefined;
        const status = url.searchParams.get('status') ?? undefined;
        const issues = this.listIssues(limit, offset, repositoryId, stage, status, includeDeleted);
        return new Response(JSON.stringify({ success: true, data: issues, timestamp: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      if (path.match(/^\/api\/issues\/[^\/]+$/) && method === 'GET') {
        const id = this.extractId(path);
        const issue = this.getIssue(id, includeDeleted);
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
      
      if (path.match(/^\/api\/issues\/[^\/]+\/status$/) && method === 'PATCH') {
        const id = this.extractParentId(path);
        const body: UpdateIssueStatusRequest = await request.json();
        return this.issueRoute(200, () => {
          this.requireIssueActor(actorId);
          this.setIssueStatus(id, body.status, actorId);
          return this.getIssue(id);
        });
      }

      if (path.match(/^\/api\/issues\/[^\/]+\/comment-policy$/) && method === 'PATCH') {
        const id = this.extractParentId(path);
        const body: UpdateIssueCommentPolicyRequest = await request.json();
        return this.issueRoute(200, () => {
          this.requireIssueActor(actorId);
          this.updateIssueCommentPolicy(id, body.commentPolicy, actorId);
          return this.getIssue(id);
        });
      }
      
      // ============================================================================
      // ISSUE COMMENTS
      // ============================================================================
      
      if (path.match(/^\/api\/issues\/[^\/]+\/comments$/) && method === 'POST') {
        const id = this.extractParentId(path);
        const body: CreateIssueCommentRequest = await request.json();
        return this.issueRoute(201, () => {
          this.requireIssueActor(actorId);
          this.requireSameAuthor(body.createdBy, actorId);
          return this.createIssueComment(id, body.body, actorId);
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

  listOrganizations(limit: number, offset: number, includeDeleted = false): OrganizationRow[] {
    if (!this.db) return [];
    const stmt = this.db.prepare(
      `SELECT * FROM organizations WHERE ${liveFilter(includeDeleted)} ORDER BY created_at DESC LIMIT ? OFFSET ?`
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

  listRepositories(limit: number, offset: number, includeDeleted = false): RepositoryRow[] {
    if (!this.db) return [];
    const stmt = this.db.prepare(
      `SELECT * FROM repositories WHERE ${liveFilter(includeDeleted)} ORDER BY created_at DESC LIMIT ? OFFSET ?`
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

  getRepository(id: string, includeDeleted = false): RepositoryRow | null {
    if (!this.db) return null;
    const stmt = this.db.prepare(`SELECT * FROM repositories WHERE id = ? AND ${liveFilter(includeDeleted)}`);
    stmt.bind(id);
    const has = stmt.step();
    const row = has ? this.rowToRepository(stmt) : null;
    stmt.free();
    return row;
  }

  listSpecs(limit: number, offset: number, organizationId?: string, stage?: string, includeDeleted = false): SpecRow[] {
    if (!this.db) return [];
    let query = `SELECT * FROM specs WHERE ${liveFilter(includeDeleted)}`;
    const params: (string | number | null)[] = [];
    
    if (organizationId) {
      query += ' AND organization_id = ?';
      params.push(organizationId);
    }
    if (stage) {
      query += ' AND stage = ?';
      params.push(stage);
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

  listCandidates(
    limit: number,
    offset: number,
    specId?: string,
    agentId?: string,
    stage?: string,
    includeDeleted = false
  ): CandidateRow[] {
    if (!this.db) return [];
    let query = `SELECT * FROM candidates WHERE ${liveFilter(includeDeleted)}`;
    const params: (string | number | null)[] = [];
    
    if (specId) {
      query += ' AND spec_id = ?';
      params.push(specId);
    }
    if (agentId) {
      query += ' AND agent_id = ?';
      params.push(agentId);
    }
    if (stage) {
      query += ' AND stage = ?';
      params.push(stage);
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

  listIssues(
    limit: number,
    offset: number,
    repositoryId?: string,
    stage?: string,
    status?: string,
    includeDeleted = false
  ): IssueRow[] {
    if (!this.db) return [];
    let query = `SELECT * FROM issues WHERE ${liveFilter(includeDeleted)}`;
    const params: (string | number | null)[] = [];
    
    if (repositoryId) {
      query += ' AND repository_id = ?';
      params.push(repositoryId);
    }
    if (stage) {
      query += ' AND stage = ?';
      params.push(stage);
    }
    if (status) {
      query += ' AND status = ?';
      params.push(status);
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

  getIssue(id: string, includeDeleted = false): IssueRow | null {
    if (!this.db) return null;
    const stmt = this.db.prepare(`SELECT * FROM issues WHERE id = ? AND ${liveFilter(includeDeleted)}`);
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

  /** Maintainer only: without that, any actor could undo a lock. Throws Forbidden/BadRequest/NotFound. */
  updateIssueCommentPolicy(id: string, commentPolicy: string, changedBy: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.state.storage.transactionSync(() => {
      if (!this.isMaintainer(changedBy)) throw new ForbiddenError('changing the comment policy requires a maintainer actor');
      if (!COMMENT_POLICIES.includes(commentPolicy)) {
        throw new BadRequestError(`commentPolicy must be one of ${COMMENT_POLICIES.join(', ')}`);
      }
      this.requireLiveIssue(id);
      const stmt = this.db!.prepare(`UPDATE issues SET comment_policy = ? WHERE id = ?`);
      stmt.bind(commentPolicy, id);
      stmt.step();
      stmt.free();
      this.recordHistory('issue', id, commentPolicy as EntityStage, changedBy, 'Comment policy updated');
    });
  }

  /**
   * Close or reopen: the issue's creator or a maintainer (403 otherwise). The same status again
   * is a no-op. `stage` is left alone; the history row carries the current one.
   */
  setIssueStatus(id: string, status: string, changedBy: string): void {
    if (!this.db) throw new Error('Database not initialized');
    if (status !== 'open' && status !== 'closed') throw new BadRequestError("status must be 'open' or 'closed'");
    this.state.storage.transactionSync(() => {
      const issue = this.requireLiveIssue(id);
      if (issue.created_by !== changedBy && !this.isMaintainer(changedBy)) {
        throw new ForbiddenError('only the issue creator or a maintainer may close or reopen it');
      }
      if (issue.status === status) return;
      const closing = status === 'closed';
      const stmt = this.db!.prepare(`UPDATE issues SET status = ?, closed_at = ?, closed_by = ? WHERE id = ?`);
      stmt.bind(status, closing ? now() : null, closing ? changedBy : null, id);
      stmt.step();
      stmt.free();
      this.recordHistory('issue', id, issue.stage as EntityStage, changedBy, closing ? 'Issue closed' : 'Issue reopened');
    });
  }

  /** The issue row, or NotFoundError when it is unknown or tombstoned */
  private requireLiveIssue(id: string): Record<string, unknown> {
    const issue = this.queryAll(`SELECT comment_policy, status, created_by, stage FROM issues WHERE id = ? AND deleted_at IS NULL`, id)[0];
    if (!issue) throw new NotFoundError('issue not found');
    return issue;
  }

  /**
   * Rules: live issue (404), non-empty body of at most MAX_COMMENT_CHARS (400). A `locked` or
   * `maintainers_only` issue takes comments from maintainers only (403 for anyone else); `open`
   * takes everyone's, and a `closed` issue still accepts comments. One transaction.
   */
  createIssueComment(issueId: string, body: string, createdBy: string): IssueCommentResponse {
    if (!this.db) throw new Error('Database not initialized');
    if (typeof body !== 'string' || body.trim() === '') throw new BadRequestError('body must be a non-empty string');
    if (body.length > MAX_COMMENT_CHARS) throw new BadRequestError(`body must be at most ${MAX_COMMENT_CHARS} characters`);
    return this.state.storage.transactionSync(() => {
      const issue = this.requireLiveIssue(issueId);
      if (issue.comment_policy !== 'open' && !this.isMaintainer(createdBy)) {
        throw new ForbiddenError(`issue is ${issue.comment_policy}: only maintainers may comment`);
      }
      const id = generateId();
      const stmt = this.db!.prepare(
        `INSERT INTO issue_comments (id, issue_id, body, created_by, created_at) VALUES (?, ?, ?, ?, ?)`
      );
      stmt.bind(id, issueId, body, createdBy, now());
      stmt.step();
      stmt.free();
      return { id, issueId, body, createdBy, createdAt: now() };
    });
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
      `SELECT id FROM repositories WHERE organization_id = ? AND name = ? AND deleted_at IS NULL LIMIT 1`
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
