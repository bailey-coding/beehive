/**
 * API Types - Shared between CLI and Workers
 * Derived from workers/api/types.ts
 */

// ============================================================================
// BASE TYPES
// ============================================================================

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: number;
}

export interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  timestamp: number;
}

// ============================================================================
// HEALTH
// ============================================================================

export interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  version: string;
  timestamp: number;
  checks: Record<string, 'ok' | 'error'>;
}

// ============================================================================
// ORGANIZATIONS
// ============================================================================

export interface CreateOrganizationRequest {
  name: string;
  type: 'github' | 'gitlab' | 'artifacts';
  externalId?: string;
}

export interface OrganizationResponse {
  id: string;
  name: string;
  type: 'github' | 'gitlab' | 'artifacts';
  externalId?: string;
  createdAt: number;
}

// ============================================================================
// ACTORS
// ============================================================================

export interface CreateActorRequest {
  type: 'human' | 'agent';
  name: string;
  githubUserId?: string;
}

export interface ActorResponse {
  id: string;
  type: 'human' | 'agent';
  name: string;
  githubUserId?: string;
  trustScore: number;
  promotionAuthority: boolean;
  createdAt: number;
}

export interface UpdateActorTrustRequest {
  trustScore: number;
}

// ============================================================================
// REPOSITORIES
// ============================================================================

export interface CreateRepositoryRequest {
  name: string;
  organizationId: string;
  repoType: 'baseline' | 'candidate';
  specId?: string;
  agentId?: string;
  remoteUrl: string;
  namespace: string;
  defaultBranch?: string;
}

export interface RepositoryResponse {
  id: string;
  name: string;
  organizationId: string;
  repoType: 'baseline' | 'candidate';
  specId?: string;
  agentId?: string;
  remoteUrl: string;
  namespace: string;
  defaultBranch: string;
  createdAt: number;
}

// ============================================================================
// SPECS
// ============================================================================

export interface CreateSpecRequest {
  name: string;
  description?: string;
  contract: string | object; // JSON string or object
  declaredDeltaSurface: string[];
  organizationId: string;
}

export interface SpecResponse {
  id: string;
  name: string;
  description?: string;
  contract: string;
  declaredDeltaSurface: string[];
  organizationId: string;
  createdBy: string;
  createdAt: number;
  stage: 'draft' | 'proposed' | 'active' | 'deprecated' | 'archived';
}

export interface UpdateSpecStageRequest {
  stage: 'draft' | 'proposed' | 'active' | 'deprecated' | 'archived';
  notes?: string;
}

// ============================================================================
// CANDIDATES
// ============================================================================

export interface CreateCandidateRequest {
  specId: string;
  repositoryId: string;
  commitSha: string;
  baseCommitSha: string;
  agentId?: string;
}

export interface CandidateResponse {
  id: string;
  specId: string;
  repositoryId: string;
  commitSha: string;
  baseCommitSha: string;
  agentId: string;
  createdAt: number;
  stage: 'pending' | 'passed_premerge' | 'passed_shadow' | 'passed_train' | 'passed_canary' | 'promoted' | 'failed' | 'rolled_back';
  repository?: { remote_url: string };
  base_commit_sha?: string;
  previewUrl?: string;
  previewWorkerName?: string;
  previewCreatedAt?: number;
}

export interface UpdateCandidateStageRequest {
  stage: 'pending' | 'passed_premerge' | 'passed_shadow' | 'passed_train' | 'passed_canary' | 'promoted' | 'failed' | 'rolled_back';
  notes?: string;
}

// ============================================================================
// CANDIDATE CLAIM
// ============================================================================

export interface ClaimSpecRequest {
  specId: string;
}

export interface ClaimSpecResponse {
  candidateId: string;
  repositoryId: string;
  repositoryName?: string;
  repositoryUrl: string;
  namespace: string;
  token: string;
  tokenExpiresAt: number;
  spec: SpecResponse;
}

// ============================================================================
// GATE VERDICTS
// ============================================================================

export interface CreateGateVerdictRequest {
  candidateId: string;
  gate: 'pre-merge' | 'shadow' | 'train' | 'canary' | 'full';
  status: 'pass' | 'fail' | 'pending';
  score: number;
  complexityDelta: number;
  notes?: string;
  decidedBy?: string;
}

export interface GateVerdictResponse {
  id: string;
  candidateId: string;
  gate: 'pre-merge' | 'shadow' | 'train' | 'canary' | 'full';
  status: 'pass' | 'fail' | 'pending';
  score: number;
  complexityDelta: number;
  notes?: string;
  decidedBy: string;
  createdAt: number;
}

// ============================================================================
// TRIALS
// ============================================================================

export interface ComparisonMetrics {
  conformance_score?: { a: number; b: number };
  complexity_delta?: { a: number; b: number };
  performance?: { a: number; b: number };
}

export interface CreateTrialRequest {
  candidateAId: string;
  candidateBId: string;
  specId: string;
  decidedBy?: string;
}

export interface TrialResponse {
  id: string;
  candidateAId: string;
  candidateBId: string;
  specId: string;
  decidedBy: string;
  winnerId?: string;
  comparisonMetrics?: ComparisonMetrics;
  status: 'pending' | 'decided' | 'active';
  createdAt: number;
  decidedAt?: number;
  notes?: string;
}

export interface DecideTrialRequest {
  winnerId: string;
  comparisonMetrics?: ComparisonMetrics;
  decidedBy?: string;
}

// ============================================================================
// PROMOTIONS
// ============================================================================

export type PromotionRung = 'pre-merge' | 'shadow' | 'train' | 'canary' | 'full';

export interface CreatePromotionRequest {
  candidateId: string;
  fromRung: PromotionRung;
  toRung: PromotionRung;
  promotedBy?: string;
  notes?: string;
}

export interface PromotionResponse {
  id: string;
  candidateId: string;
  fromRung: PromotionRung;
  toRung: PromotionRung;
  promotedBy: string;
  notes?: string;
  createdAt: number;
  stage: 'pending' | 'active' | 'rolled_back';
}

// ============================================================================
// ISSUES
// ============================================================================

export type ChangeType = 'typo-fix' | 'refactor' | 'behavior-change' | 'security-sensitive' | 'dependency-change' | 'infra';
export type IssueStatus = 'open' | 'in-progress' | 'resolved' | 'closed';
export type IssueStage = 'triage' | 'specified' | 'implemented' | 'verified' | 'merged';

export interface CreateIssueRequest {
  title: string;
  repositoryId: string;
  description?: string;
  changeType?: ChangeType;
  complexityEstimate?: number;
  reporterTrust?: number;
}

export interface IssueResponse {
  id: string;
  title: string;
  description?: string;
  repositoryId: string;
  createdBy: string;
  createdAt: number;
  status: IssueStatus;
  stage: IssueStage;
  changeType?: ChangeType;
  complexityEstimate?: number;
  reporterTrust?: number;
}

// ============================================================================
// ENTITY HISTORY
// ============================================================================

export type EntityType = 'organization' | 'repository' | 'spec' | 'candidate' | 'actor' | 'gate_verdict' | 'trial' | 'promotion' | 'issue';

export interface EntityHistoryResponse {
  entityType: EntityType;
  entityId: string;
  history: Array<{
    id: string;
    action: string;
    actorId: string;
    timestamp: number;
    changes: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }>;
}

// ============================================================================
// DEBUG / STATE DUMP
// ============================================================================

export interface StateDumpResponse {
  organizations: OrganizationResponse[];
  actors: ActorResponse[];
  repositories: RepositoryResponse[];
  specs: SpecResponse[];
  candidates: CandidateResponse[];
  gateVerdicts: GateVerdictResponse[];
  trials: TrialResponse[];
  promotions: PromotionResponse[];
  issues: IssueResponse[];
  timestamp: number;
}

// ============================================================================
// QUEUE VERIFICATION
// ============================================================================

export interface QueueStatus {
  queueName: string;
  exists: boolean;
  messageCount?: number;
  consumerBound: boolean;
  error?: string;
}

// ============================================================================
// ARTIFACTS VERIFICATION
// ============================================================================

export interface ArtifactRepo {
  id: string;
  name: string;
  owner: string;
  url: string;
  createdAt: string;
}

export interface ArtifactsStatus {
  connected: boolean;
  repositories: ArtifactRepo[];
  canCreateFork: boolean;
  error?: string;
}
