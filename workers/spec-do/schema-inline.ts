// Generated from schema.sql — inlined as a TS constant so wrangler/esbuild can bundle it.
export const SCHEMA_SQL = `-- Beehive Spec Durable Object SQLite Schema
-- This is the orchestration spine - hand-written, not agent-generated
-- Version: M1

-- ============================================================================
-- ENTITY HISTORY (Generic audit trail for all entities)
-- ============================================================================

CREATE TABLE IF NOT EXISTS entity_history (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK(entity_type IN (
    'issue', 'candidate', 'spec', 'trial', 'promotion', 'gate_verdict', 'service_account'
  )),
  entity_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  notes TEXT,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_entity_history_entity ON entity_history(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_history_stage ON entity_history(entity_type, stage);
CREATE INDEX IF NOT EXISTS idx_entity_history_time ON entity_history(changed_at);

-- ============================================================================
-- ORGANIZATIONS
-- ============================================================================

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('github', 'gitlab', 'artifacts')),
  external_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_organizations_type ON organizations(type);

-- ============================================================================
-- REPOSITORIES
-- ============================================================================

CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  repo_type TEXT NOT NULL CHECK(repo_type IN ('baseline', 'candidate')),
  spec_id TEXT,
  agent_id TEXT,
  remote_url TEXT NOT NULL,
  namespace TEXT,
  default_branch TEXT DEFAULT 'main',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id),
  FOREIGN KEY (spec_id) REFERENCES specs(id),
  FOREIGN KEY (agent_id) REFERENCES actors(id)
);

CREATE INDEX IF NOT EXISTS idx_repositories_org ON repositories(organization_id);
CREATE INDEX IF NOT EXISTS idx_repositories_type ON repositories(repo_type);
CREATE INDEX IF NOT EXISTS idx_repositories_spec ON repositories(spec_id);

-- ============================================================================
-- ACTORS
-- ============================================================================

CREATE TABLE IF NOT EXISTS actors (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('human', 'agent')),
  name TEXT NOT NULL,
  github_user_id TEXT,
  trust_score INTEGER DEFAULT 50,
  promotion_authority BOOLEAN DEFAULT FALSE,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_actors_type ON actors(type);

-- ============================================================================
-- SPECS (Machine-readable contracts/definitions)
-- ============================================================================

CREATE TABLE IF NOT EXISTS specs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  contract TEXT NOT NULL,
  declared_delta_surface TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  stage TEXT DEFAULT 'draft' CHECK(stage IN ('draft', 'proposed', 'active', 'deprecated', 'archived')),
  FOREIGN KEY (organization_id) REFERENCES organizations(id),
  FOREIGN KEY (created_by) REFERENCES actors(id)
);

CREATE INDEX IF NOT EXISTS idx_specs_org ON specs(organization_id);
CREATE INDEX IF NOT EXISTS idx_specs_stage ON specs(stage);

-- ============================================================================
-- CANDIDATES (Implementations of specs)
-- ============================================================================

CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  base_commit_sha TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  stage TEXT DEFAULT 'pending' CHECK(stage IN (
    'pending', 'passed_premerge', 'passed_shadow', 'passed_train',
    'passed_canary', 'promoted', 'failed', 'rolled_back'
  )),
  FOREIGN KEY (spec_id) REFERENCES specs(id),
  FOREIGN KEY (repository_id) REFERENCES repositories(id),
  FOREIGN KEY (agent_id) REFERENCES actors(id)
);

CREATE INDEX IF NOT EXISTS idx_candidates_spec ON candidates(spec_id);
CREATE INDEX IF NOT EXISTS idx_candidates_stage ON candidates(stage);
CREATE INDEX IF NOT EXISTS idx_candidates_repo ON candidates(repository_id);

-- ============================================================================
-- GATE VERDICTS (Oracle ladder results)
-- ============================================================================

CREATE TABLE IF NOT EXISTS gate_verdicts (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  gate TEXT NOT NULL CHECK(gate IN ('pre-merge', 'shadow', 'train', 'canary', 'full')),
  status TEXT NOT NULL CHECK(status IN ('pass', 'fail', 'pending')),
  score INTEGER NOT NULL,
  complexity_delta REAL NOT NULL,
  notes TEXT,
  created_at INTEGER NOT NULL,
  decided_by TEXT NOT NULL,
  stage TEXT DEFAULT 'pending' CHECK(stage IN ('pending', 'passed', 'failed')),
  FOREIGN KEY (candidate_id) REFERENCES candidates(id),
  FOREIGN KEY (decided_by) REFERENCES actors(id),
  UNIQUE(candidate_id, gate)
);

CREATE INDEX IF NOT EXISTS idx_gate_verdicts_candidate ON gate_verdicts(candidate_id);
CREATE INDEX IF NOT EXISTS idx_gate_verdicts_gate ON gate_verdicts(gate);

-- ============================================================================
-- TRIALS (Competitive evaluations between candidates)
-- ============================================================================

CREATE TABLE IF NOT EXISTS trials (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL,
  candidate_a_id TEXT NOT NULL,
  candidate_b_id TEXT NOT NULL,
  winner_id TEXT,
  comparison_metrics TEXT NOT NULL,
  decided_at INTEGER NOT NULL,
  decided_by TEXT NOT NULL,
  stage TEXT DEFAULT 'pending' CHECK(stage IN ('pending', 'comparing', 'decided')),
  FOREIGN KEY (spec_id) REFERENCES specs(id),
  FOREIGN KEY (candidate_a_id) REFERENCES candidates(id),
  FOREIGN KEY (candidate_b_id) REFERENCES candidates(id),
  FOREIGN KEY (winner_id) REFERENCES candidates(id),
  FOREIGN KEY (decided_by) REFERENCES actors(id)
);

CREATE INDEX IF NOT EXISTS idx_trials_spec ON trials(spec_id);
CREATE INDEX IF NOT EXISTS idx_trials_stage ON trials(stage);

-- ============================================================================
-- PROMOTIONS
-- ============================================================================

CREATE TABLE IF NOT EXISTS promotions (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  from_rung TEXT NOT NULL CHECK(from_rung IN ('pre-merge', 'shadow', 'train', 'canary', 'full')),
  to_rung TEXT NOT NULL CHECK(to_rung IN ('pre-merge', 'shadow', 'train', 'canary', 'full')),
  promoted_at INTEGER NOT NULL,
  promoted_by TEXT NOT NULL,
  rollback_reason TEXT,
  stage TEXT DEFAULT 'pending' CHECK(stage IN ('pending', 'active', 'rolled_back')),
  FOREIGN KEY (candidate_id) REFERENCES candidates(id),
  FOREIGN KEY (promoted_by) REFERENCES actors(id)
);

CREATE INDEX IF NOT EXISTS idx_promotions_candidate ON promotions(candidate_id);

-- ============================================================================
-- ISSUES (Bug reports, feature requests)
-- ============================================================================

CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL,
  repository_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  status TEXT NOT NULL CHECK(status IN ('open', 'closed')),
  labels TEXT,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  closed_at INTEGER,
  closed_by TEXT,
  comment_policy TEXT DEFAULT 'open' CHECK(comment_policy IN ('open', 'maintainers_only', 'locked')),
  visibility TEXT DEFAULT 'public' CHECK(visibility IN ('public', 'internal', 'private')),
  stage TEXT DEFAULT 'reported' CHECK(stage IN (
    'reported', 'spec_needed', 'spec_defining', 'spec_defined',
    'implementing', 'validating', 'merged', 'closed'
  )),
  FOREIGN KEY (repository_id) REFERENCES repositories(id),
  FOREIGN KEY (created_by) REFERENCES actors(id),
  FOREIGN KEY (closed_by) REFERENCES actors(id)
);

CREATE INDEX IF NOT EXISTS idx_issues_repo ON issues(repository_id);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
CREATE INDEX IF NOT EXISTS idx_issues_stage ON issues(stage);

-- ============================================================================
-- ISSUE-SPEC LINKS
-- ============================================================================

CREATE TABLE IF NOT EXISTS issue_spec_links (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  spec_id TEXT NOT NULL,
  relationship TEXT NOT NULL CHECK(relationship IN ('requests-new', 'requests-change', 'reports-bug')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (issue_id) REFERENCES issues(id),
  FOREIGN KEY (spec_id) REFERENCES specs(id)
);

CREATE INDEX IF NOT EXISTS idx_issue_spec_links_issue ON issue_spec_links(issue_id);
CREATE INDEX IF NOT EXISTS idx_issue_spec_links_spec ON issue_spec_links(spec_id);

-- ============================================================================
-- ISSUE-CANDIDATE LINKS
-- ============================================================================

CREATE TABLE IF NOT EXISTS issue_candidate_links (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  relationship TEXT NOT NULL CHECK(relationship IN ('reports-bug', 'requests-fix', 'linked')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (issue_id) REFERENCES issues(id),
  FOREIGN KEY (candidate_id) REFERENCES candidates(id)
);

CREATE INDEX IF NOT EXISTS idx_issue_candidate_links_issue ON issue_candidate_links(issue_id);
CREATE INDEX IF NOT EXISTS idx_issue_candidate_links_candidate ON issue_candidate_links(candidate_id);

-- ============================================================================
-- ISSUE COMMENTS
-- ============================================================================

CREATE TABLE IF NOT EXISTS issue_comments (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  edited_by TEXT,
  FOREIGN KEY (issue_id) REFERENCES issues(id),
  FOREIGN KEY (created_by) REFERENCES actors(id),
  FOREIGN KEY (edited_by) REFERENCES actors(id)
);

CREATE INDEX IF NOT EXISTS idx_issue_comments_issue ON issue_comments(issue_id);

-- ============================================================================
-- METADATA
-- ============================================================================

CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
-- ============================================================================
-- SERVICE ACCOUNTS
-- ============================================================================

CREATE TABLE IF NOT EXISTS service_accounts (
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
);

CREATE INDEX IF NOT EXISTS idx_service_accounts_org ON service_accounts(organization_id);
CREATE INDEX IF NOT EXISTS idx_service_accounts_active ON service_accounts(is_active);
CREATE INDEX IF NOT EXISTS idx_service_accounts_token ON service_accounts(token_hash);

-- ============================================================================
-- PROMOTION LEDGER (promotion worker train state; m3 -> m4, additive)
-- Ids are not foreign keys: the promotion worker records candidates and specs
-- by id before (or without) their M1 rows existing. Timestamps are the ISO
-- strings the worker sends. Nested lists are JSON (the worker reads and writes
-- the whole tournament / train object).
-- ============================================================================

CREATE TABLE IF NOT EXISTS promotion_states (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  spec_id TEXT NOT NULL,
  current_rung TEXT NOT NULL,
  target_rung TEXT NOT NULL,
  status TEXT NOT NULL,
  mode TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  failed_at TEXT,
  failure_reason TEXT,
  rollback_reason TEXT,
  actor_id TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_promotion_states_candidate ON promotion_states(candidate_id, created_at);

CREATE TABLE IF NOT EXISTS tournaments (
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
);

CREATE INDEX IF NOT EXISTS idx_tournaments_spec ON tournaments(spec_id, created_at);

CREATE TABLE IF NOT EXISTS merge_trains (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL,
  status TEXT NOT NULL,
  current_position INTEGER NOT NULL,
  next_merge TEXT,
  candidates TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_merge_trains_spec ON merge_trains(spec_id, created_at);
`;

// Service Accounts table SQL - for m2->m3 migration
export const SERVICE_ACCOUNTS_SQL = `
-- ============================================================================
-- SERVICE ACCOUNTS
-- ============================================================================

CREATE TABLE IF NOT EXISTS service_accounts (
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
);

CREATE INDEX IF NOT EXISTS idx_service_accounts_org ON service_accounts(organization_id);
CREATE INDEX IF NOT EXISTS idx_service_accounts_active ON service_accounts(is_active);
CREATE INDEX IF NOT EXISTS idx_service_accounts_token ON service_accounts(token_hash);
`;

// Promotion ledger tables SQL - for m3->m4 migration (CREATE TABLE IF NOT EXISTS only)
export const PROMOTION_LEDGER_SQL = `
-- ============================================================================
-- PROMOTION LEDGER (promotion worker train state; m3 -> m4, additive)
-- Ids are not foreign keys: the promotion worker records candidates and specs
-- by id before (or without) their M1 rows existing. Timestamps are the ISO
-- strings the worker sends. Nested lists are JSON (the worker reads and writes
-- the whole tournament / train object).
-- ============================================================================

CREATE TABLE IF NOT EXISTS promotion_states (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  spec_id TEXT NOT NULL,
  current_rung TEXT NOT NULL,
  target_rung TEXT NOT NULL,
  status TEXT NOT NULL,
  mode TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  failed_at TEXT,
  failure_reason TEXT,
  rollback_reason TEXT,
  actor_id TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_promotion_states_candidate ON promotion_states(candidate_id, created_at);

CREATE TABLE IF NOT EXISTS tournaments (
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
);

CREATE INDEX IF NOT EXISTS idx_tournaments_spec ON tournaments(spec_id, created_at);

CREATE TABLE IF NOT EXISTS merge_trains (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL,
  status TEXT NOT NULL,
  current_position INTEGER NOT NULL,
  next_merge TEXT,
  candidates TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_merge_trains_spec ON merge_trains(spec_id, created_at);
`;

// Ledger lifecycle (m4 -> m5, additive). Run after the tombstone columns exist:
// SpecDO.applyLedgerLifecycle() adds them first (PRAGMA-guarded ALTER TABLE).
export const LIFECYCLE_COLUMNS: Record<string, string[]> = {
  organizations: ['deleted_at INTEGER', 'deleted_by TEXT', 'delete_reason TEXT'],
  repositories: ['deleted_at INTEGER', 'deleted_by TEXT', 'delete_reason TEXT'],
  specs: ['deleted_at INTEGER', 'deleted_by TEXT', 'delete_reason TEXT'],
  candidates: ['deleted_at INTEGER', 'deleted_by TEXT', 'delete_reason TEXT'],
  issues: ['deleted_at INTEGER', 'deleted_by TEXT', 'delete_reason TEXT'],
  actors: ['role TEXT'],
};

export const LEDGER_LIFECYCLE_SQL = `
-- ============================================================================
-- LEDGER LIFECYCLE (tombstones + purge; m4 -> m5, additive)
-- Columns are added in code (SpecDO.applyLedgerLifecycle) behind a PRAGMA
-- table_info check, because ALTER TABLE ADD COLUMN is not idempotent:
--   organizations, repositories, specs, candidates, issues:
--     deleted_at INTEGER, deleted_by TEXT, delete_reason TEXT
--   actors: role TEXT  ('maintainer' or NULL)
-- purge_log is the lifecycle audit trail (tombstone, purge, role_change). It has
-- no foreign keys and is never purged, like entity_history.
-- ============================================================================

CREATE TABLE IF NOT EXISTS purge_log (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  selector_json TEXT NOT NULL,
  dry_run INTEGER NOT NULL DEFAULT 0,
  counts_json TEXT,
  outcome TEXT NOT NULL,
  detail TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_purge_log_time ON purge_log(started_at);
CREATE INDEX IF NOT EXISTS idx_organizations_deleted ON organizations(deleted_at);
CREATE INDEX IF NOT EXISTS idx_repositories_deleted ON repositories(deleted_at);
CREATE INDEX IF NOT EXISTS idx_specs_deleted ON specs(deleted_at);
CREATE INDEX IF NOT EXISTS idx_candidates_deleted ON candidates(deleted_at);
CREATE INDEX IF NOT EXISTS idx_issues_deleted ON issues(deleted_at);
`;

// Service tokens (m5 -> m6, additive). Byte-identical to the last section of schema.sql.
// Run after service_accounts.actor_id exists: SpecDO.applyServiceTokens() adds it first.
export const SERVICE_TOKENS_SQL = `
-- ============================================================================
-- SERVICE TOKENS (m5 -> m6, additive)
-- service_accounts.actor_id (TEXT REFERENCES actors(id)) is added in code
-- (SpecDO.applyServiceTokens) behind a PRAGMA table_info check, because
-- ALTER TABLE ADD COLUMN is not idempotent. Each account owns one actor row
-- (type 'agent': the actors.type CHECK has no 'service'). A token row stores the
-- SHA-256 hex of the plaintext and a display prefix, never the plaintext.
-- service_accounts.token_hash/token_salt are legacy NOT NULL columns, written as
-- '' and never read. Accounts without actor_id, or without a service_tokens
-- row, cannot authenticate.
-- ============================================================================

CREATE TABLE IF NOT EXISTS service_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  scopes TEXT NOT NULL CHECK(scopes IN ('read', 'write', 'read_write')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER,
  FOREIGN KEY (account_id) REFERENCES service_accounts(id),
  FOREIGN KEY (created_by) REFERENCES actors(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_service_tokens_hash ON service_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_service_tokens_account ON service_tokens(account_id);
CREATE INDEX IF NOT EXISTS idx_service_accounts_actor ON service_accounts(actor_id);
CREATE INDEX IF NOT EXISTS idx_service_accounts_name ON service_accounts(name);
`;

// Deploy refs + canary deployments (m6 -> m7, additive). Byte-identical to the last
// section of schema.sql. CREATE TABLE/INDEX IF NOT EXISTS only: safe to rerun.
export const DEPLOY_REFS_SQL = `
-- ============================================================================
-- DEPLOY REFS + CANARY DEPLOYMENTS (m6 -> m7, additive)
-- deploy_refs is the traffic pointer per (spec_id, rung) and the source of
-- truth for rollback. Rows are append-only: every move inserts a row whose
-- prev_ref_id is the head it replaces (the unique index keeps the chain
-- linear), and the head is the row no other row points back to. Promotion
-- moves the head to a new target, rollback to the target of head.prev_ref_id;
-- candidate_id NULL is the empty ref (no candidate on that rung). The Artifacts
-- production ref is a provenance mirror, never read here. canary_deployments
-- records each canary and the ref row it created. Ids are not foreign keys,
-- like the promotion ledger. Timestamps are epoch milliseconds.
-- ============================================================================

CREATE TABLE IF NOT EXISTS deploy_refs (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL,
  rung TEXT NOT NULL CHECK(rung IN ('canary', 'full')),
  candidate_id TEXT,
  commit_sha TEXT,
  worker_version_id TEXT,
  prev_ref_id TEXT,
  action TEXT NOT NULL CHECK(action IN ('promote', 'rollback')),
  moved_by TEXT NOT NULL,
  moved_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_deploy_refs_prev ON deploy_refs(prev_ref_id);
CREATE INDEX IF NOT EXISTS idx_deploy_refs_spec_rung ON deploy_refs(spec_id, rung);
CREATE INDEX IF NOT EXISTS idx_deploy_refs_candidate ON deploy_refs(candidate_id);

CREATE TABLE IF NOT EXISTS canary_deployments (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  spec_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('deployed', 'superseded', 'rolled_back')),
  url TEXT NOT NULL,
  worker_version_id TEXT NOT NULL,
  commit_sha TEXT,
  traffic_percentage REAL NOT NULL,
  holdout_percentage REAL NOT NULL,
  auto_rollback INTEGER NOT NULL DEFAULT 1,
  deploy_ref_id TEXT NOT NULL,
  rollback_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_canary_deployments_candidate ON canary_deployments(candidate_id, created_at);
CREATE INDEX IF NOT EXISTS idx_canary_deployments_spec ON canary_deployments(spec_id, status);
`;

// Ledger versions + tournament failure columns (m7 -> m8). Comment-only: the columns are
// added by SpecDO.applyLedgerCas. Byte-identical to the last section of schema.sql.
export const LEDGER_CAS_SQL = `
-- ============================================================================
-- LEDGER VERSIONS + TOURNAMENT FAILURES (m7 -> m8, additive)
-- Columns are added in code (SpecDO.applyLedgerCas) behind a PRAGMA
-- table_info check, because ALTER TABLE ADD COLUMN is not idempotent:
--   tournaments, merge_trains:
--     version INTEGER NOT NULL DEFAULT 1   bumped by every write; a POST over an
--       existing row, or a PATCH that sends X-Expected-Version, applies only if it
--       still matches (compare-and-swap, checked in the write's transaction)
--   tournaments only:
--     failure_reason TEXT, failed_at TEXT, attempts INTEGER NOT NULL DEFAULT 0
--       attempts counts entries into 'failed'; workers/shared/ledger-state-machine.ts
--       holds the status transition rules the DO enforces
-- ============================================================================
`;

// User tokens (m8 -> m9). Byte-identical to its section of schema.sql.
export const USER_TOKENS_SQL = `
-- ============================================================================
-- USER TOKENS (m8 -> m9, additive; RFD-0008)
-- One row per bh_usr_ token of one human actor. The actor must be type 'human'
-- with a github_user_id and not a service account's actor (checked in code at
-- mint and again at verify). token_hash is the SHA-256 hex of the plaintext and
-- token_prefix its first 12 chars; the plaintext is never stored. scope is
-- hierarchical: maintainer > read_write > read. The 90-day lifetime ceiling and
-- the cap of 10 live tokens per actor are enforced in code
-- (SpecDO.mintUserToken), so either can change without a table rebuild. The
-- table references actors only, and m9 adds no index on actors (a unique
-- actors.github_user_id index is M11's, now m12). Timestamps are epoch milliseconds.
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_tokens (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 64),
  token_hash TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('read', 'read_write', 'maintainer')),
  created_by TEXT NOT NULL,
  created_via TEXT NOT NULL CHECK(created_via IN ('session', 'admin')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
  revoked_at INTEGER,
  revoked_by TEXT,
  last_used_at INTEGER,
  FOREIGN KEY (actor_id) REFERENCES actors(id),
  FOREIGN KEY (created_by) REFERENCES actors(id),
  FOREIGN KEY (revoked_by) REFERENCES actors(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_tokens_hash ON user_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_user_tokens_actor ON user_tokens(actor_id);
`;

// Idempotency keys table (m9 -> m10, additive). Prevents double-writes from at-least-once queue delivery.
export const IDEMPOTENCY_KEYS_SQL = `
-- ============================================================================
-- IDEMPOTENCY KEYS (m9 -> m10, additive)
-- Prevents double-writes from at-least-once Queue delivery.
-- key_hash is SHA-256 of [actor, method, path, key], so a key cannot be replayed across actors or routes.
-- The row is written in the same transaction as the mutation it guards.
-- ============================================================================

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('POST', 'PATCH', 'PUT', 'DELETE')),
  request_hash TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires ON idempotency_keys(expires_at);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_endpoint ON idempotency_keys(endpoint, created_at);
`;

// Canary metrics (m10 -> m11, additive). Per-deployment, per-minute, per-source request outcomes the SLO loop reads.
export const CANARY_METRICS_SQL = `
-- ============================================================================
-- CANARY METRICS (m10 -> m11, additive)
-- One row per (deployment, epoch minute, source). source 'shadow' is mirrored traffic and is never
-- reported as a canary SLO. No foreign keys and no org column (like canary_deployments), so org purge
-- does not touch it; rows older than 24 hours are pruned on every write and read.
-- ============================================================================

CREATE TABLE IF NOT EXISTS canary_metrics (
  deployment_id TEXT NOT NULL,
  minute_bucket INTEGER NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('shadow', 'canary')),
  requests INTEGER NOT NULL,
  errors INTEGER NOT NULL,
  latency_sum_ms REAL NOT NULL,
  latency_max_ms REAL NOT NULL,
  latency_buckets TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (deployment_id, minute_bucket, source)
);

CREATE INDEX IF NOT EXISTS idx_canary_metrics_minute ON canary_metrics(minute_bucket);
`;
