/**
 * Beehive API Types
 * 
 * Request/response types for the Beehive REST API.
 * 
 * Zod schemas are exported for runtime validation at API boundaries.
 * TypeScript interfaces are kept for backwards compatibility and type inference.
 */

import { z } from 'zod';

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

// UUID helper
export const UUIDSchema = z.string().uuid();

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

// Zod schemas
export const OrganizationTypeSchema = z.enum(['github', 'gitlab', 'artifacts']);

export const CreateOrganizationRequestSchema = z.object({
  name: z.string().min(1),
  type: OrganizationTypeSchema,
  externalId: z.string().optional(),
});

export const OrganizationResponseSchema = z.object({
  id: UUIDSchema,
  name: z.string(),
  type: OrganizationTypeSchema,
  externalId: z.string().optional(),
  createdAt: z.number().int().positive(),
});

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

// Zod schemas
export const ActorTypeSchema = z.enum(['human', 'agent']);

export const CreateActorRequestSchema = z.object({
  type: ActorTypeSchema,
  name: z.string().min(1),
  githubUserId: z.string().optional(),
});

export const ActorResponseSchema = z.object({
  id: UUIDSchema,
  type: ActorTypeSchema,
  name: z.string(),
  githubUserId: z.string().optional(),
  trustScore: z.number().int().min(0).max(100),
  promotionAuthority: z.boolean(),
  createdAt: z.number().int().positive(),
});

export const UpdateActorTrustRequestSchema = z.object({
  trustScore: z.number().int().min(0).max(100),
});

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

// Zod schemas
export const RepoTypeSchema = z.enum(['baseline', 'candidate']);

export const CreateRepositoryRequestSchema = z.object({
  name: z.string().min(1),
  organizationId: UUIDSchema,
  repoType: RepoTypeSchema,
  specId: UUIDSchema.optional(),
  agentId: UUIDSchema.optional(),
  remoteUrl: z.string().url(),
  namespace: z.string().min(1),
  defaultBranch: z.string().optional(),
});

export const RepositoryResponseSchema = z.object({
  id: UUIDSchema,
  name: z.string(),
  organizationId: UUIDSchema,
  repoType: RepoTypeSchema,
  specId: UUIDSchema.optional(),
  agentId: UUIDSchema.optional(),
  remoteUrl: z.string(),
  namespace: z.string(),
  defaultBranch: z.string().optional(),
  createdAt: z.number().int().positive(),
});

// ============================================================================
// SPECS
// ============================================================================

export interface CreateSpecRequest {
  name: string;
  description?: string;
  contract: string; // JSON string
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

// Zod schemas
export const SpecStageSchema = z.enum([
  'draft', 'proposed', 'active', 'deprecated', 'archived'
]);

export const CreateSpecRequestSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  contract: z.string(),
  declaredDeltaSurface: z.array(z.string()).optional().default([]),
  organizationId: UUIDSchema,
});

export const SpecResponseSchema = z.object({
  id: UUIDSchema,
  name: z.string(),
  description: z.string().optional(),
  contract: z.string(),
  declaredDeltaSurface: z.array(z.string()).optional(),
  organizationId: UUIDSchema,
  createdBy: z.string(),
  createdAt: z.number().int().positive(),
  stage: SpecStageSchema,
});

export const UpdateSpecStageRequestSchema = z.object({
  stage: SpecStageSchema,
  notes: z.string().optional(),
});

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
  // Shadow fields
  shadowMatch?: boolean;
  shadowScore?: number;
  shadowMetrics?: string;
  // Tombstone (present only on tombstoned rows, visible with ?include_deleted=1)
  deletedAt?: number;
  deletedBy?: string;
  deleteReason?: string;
}

export interface UpdateCandidateStageRequest {
  stage: 'pending' | 'passed_premerge' | 'passed_shadow' | 'passed_train' | 'passed_canary' | 'promoted' | 'failed' | 'rolled_back';
  notes?: string;
}

// Zod schemas - Candidate types are critical for preventing field name mismatches
export const CandidateStageSchema = z.enum([
  'pending',
  'passed_premerge',
  'passed_shadow', 
  'passed_train',
  'passed_canary',
  'promoted',
  'failed',
  'rolled_back',
]);

export const CreateCandidateRequestSchema = z.object({
  specId: UUIDSchema,
  repositoryId: UUIDSchema,
  commitSha: z.string().min(1),
  baseCommitSha: z.string().min(1),
  agentId: UUIDSchema.optional(),
});

// Main Candidate response schema - includes both camelCase and snake_case for backwards compatibility
export const CandidateResponseSchema = z.object({
  id: UUIDSchema,
  specId: UUIDSchema,
  repositoryId: UUIDSchema,
  commitSha: z.string(),
  baseCommitSha: z.string(),
  agentId: UUIDSchema,
  createdAt: z.number().int().positive(),
  stage: CandidateStageSchema,
  // Preview fields
  previewUrl: z.string().url().optional(),
  previewWorkerName: z.string().optional(),
  previewCreatedAt: z.number().int().positive().optional(),
  // Legacy snake_case support for database compatibility
  base_commit_sha: z.string().optional(),
  // Repository info
  repository: z.object({
    remote_url: z.string().optional(),
    namespace: z.string().optional(),
  }).optional(),
  // Shadow fields
  shadowMatch: z.boolean().optional(),
  shadowScore: z.number().optional(),
  shadowMetrics: z.string().optional(),
});

export const UpdateCandidateStageRequestSchema = z.object({
  stage: CandidateStageSchema,
  notes: z.string().optional(),
});

// ============================================================================
// CANDIDATE CLAIM (Agent workflow)
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

// Zod schemas
export const ClaimSpecRequestSchema = z.object({
  specId: UUIDSchema,
});

export const ClaimSpecResponseSchema = z.object({
  candidateId: UUIDSchema,
  repositoryId: UUIDSchema,
  repositoryName: z.string().optional(),
  repositoryUrl: z.string().url(),
  namespace: z.string(),
  token: z.string(),
  tokenExpiresAt: z.number().int().positive(),
  spec: SpecResponseSchema,
});

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
  createdAt: number;
  decidedBy: string;
  stage: 'pending' | 'passed' | 'failed';
}

// Zod schemas
export const GateSchema = z.enum(['pre-merge', 'shadow', 'train', 'canary', 'full']);
export const GateStatusSchema = z.enum(['pass', 'fail', 'pending']);
export const GateVerdictStageSchema = z.enum(['pending', 'passed', 'failed']);

export const CreateGateVerdictRequestSchema = z.object({
  candidateId: UUIDSchema,
  gate: GateSchema,
  status: GateStatusSchema,
  score: z.number().min(0).max(100),
  complexityDelta: z.number(),
  notes: z.string().optional(),
  decidedBy: z.string().optional(),
});

export const GateVerdictResponseSchema = z.object({
  id: UUIDSchema,
  candidateId: UUIDSchema,
  gate: GateSchema,
  status: GateStatusSchema,
  score: z.number(),
  complexityDelta: z.number(),
  notes: z.string().optional(),
  createdAt: z.number().int().positive(),
  decidedBy: z.string(),
  stage: GateVerdictStageSchema,
});

// ============================================================================
// TRIALS
// ============================================================================

export interface CreateTrialRequest {
  specId: string;
  candidateAId: string;
  candidateBId: string;
  decidedBy?: string;
}

export interface ComparisonMetrics {
  conformance_score?: { a: number; b: number };
  complexity_delta?: { a: number; b: number };
  performance?: { a: number; b: number };
}

export interface TrialResponse {
  id: string;
  specId: string;
  candidateAId: string;
  candidateBId: string;
  winnerId?: string;
  comparisonMetrics: ComparisonMetrics;
  decidedAt?: number;
  decidedBy?: string;
  stage: 'pending' | 'comparing' | 'decided';
}

export interface DecideTrialRequest {
  winnerId: string;
  comparisonMetrics: ComparisonMetrics;
  decidedBy?: string;
}

// Zod schemas
export const TrialStageSchema = z.enum(['pending', 'comparing', 'decided']);

export const ComparisonMetricsSchema = z.object({
  conformance_score: z.object({
    a: z.number().optional(),
    b: z.number().optional(),
  }).optional(),
  complexity_delta: z.object({
    a: z.number().optional(),
    b: z.number().optional(),
  }).optional(),
  performance: z.object({
    a: z.number().optional(),
    b: z.number().optional(),
  }).optional(),
});

export const CreateTrialRequestSchema = z.object({
  specId: UUIDSchema,
  candidateAId: UUIDSchema,
  candidateBId: UUIDSchema,
  decidedBy: z.string().optional(),
});

export const TrialResponseSchema = z.object({
  id: UUIDSchema,
  specId: UUIDSchema,
  candidateAId: UUIDSchema,
  candidateBId: UUIDSchema,
  winnerId: UUIDSchema.optional(),
  comparisonMetrics: ComparisonMetricsSchema,
  decidedAt: z.number().int().positive().optional(),
  decidedBy: z.string().optional(),
  stage: TrialStageSchema,
});

export const DecideTrialRequestSchema = z.object({
  winnerId: UUIDSchema,
  comparisonMetrics: ComparisonMetricsSchema.optional(),
  decidedBy: z.string().optional(),
});

// ============================================================================
// PROMOTIONS
// ============================================================================

export interface CreatePromotionRequest {
  candidateId: string;
  fromRung: 'pre-merge' | 'shadow' | 'train' | 'canary' | 'full';
  toRung: 'pre-merge' | 'shadow' | 'train' | 'canary' | 'full';
  promotedBy?: string;
}

export interface PromotionResponse {
  id: string;
  candidateId: string;
  fromRung: 'pre-merge' | 'shadow' | 'train' | 'canary' | 'full';
  toRung: 'pre-merge' | 'shadow' | 'train' | 'canary' | 'full';
  promotedAt: number;
  promotedBy: string;
  rollbackReason?: string;
  stage: 'pending' | 'active' | 'rolled_back';
}

// Zod schemas
export const PromotionStageSchema = z.enum(['pending', 'active', 'rolled_back']);

export const CreatePromotionRequestSchema = z.object({
  candidateId: UUIDSchema,
  fromRung: GateSchema,
  toRung: GateSchema,
  promotedBy: z.string().optional(),
});

export const PromotionResponseSchema = z.object({
  id: UUIDSchema,
  candidateId: UUIDSchema,
  fromRung: GateSchema,
  toRung: GateSchema,
  promotedAt: z.number().int().positive(),
  promotedBy: z.string(),
  rollbackReason: z.string().optional(),
  stage: PromotionStageSchema,
});

// ============================================================================
// ISSUES
// ============================================================================

export interface CreateIssueRequest {
  /** Optional: the Spec DO assigns the next number for the repository when omitted */
  number?: number;
  repositoryId: string;
  title: string;
  body?: string;
  labels?: string[];
  createdBy?: string;
}

export interface IssueResponse {
  id: string;
  number: number;
  repositoryId: string;
  title: string;
  body?: string;
  status: 'open' | 'closed';
  labels?: string[];
  createdAt: number;
  createdBy: string;
  closedAt?: number;
  closedBy?: string;
  commentPolicy: 'open' | 'maintainers_only' | 'locked';
  visibility: 'public' | 'internal' | 'private';
  stage: 'reported' | 'spec_needed' | 'spec_defining' | 'spec_defined' | 'implementing' | 'validating' | 'merged' | 'closed';
}

export interface UpdateIssueStageRequest {
  stage: 'reported' | 'spec_needed' | 'spec_defining' | 'spec_defined' | 'implementing' | 'validating' | 'merged' | 'closed';
  notes?: string;
}

export interface UpdateIssueStatusRequest {
  status: 'open' | 'closed';
}

export interface UpdateIssueCommentPolicyRequest {
  commentPolicy: 'open' | 'maintainers_only' | 'locked';
}

// Zod schemas
export const IssueStatusSchema = z.enum(['open', 'closed']);
export const CommentPolicySchema = z.enum(['open', 'maintainers_only', 'locked']);
export const VisibilitySchema = z.enum(['public', 'internal', 'private']);
export const IssueStageSchema = z.enum([
  'reported', 'spec_needed', 'spec_defining', 'spec_defined', 
  'implementing', 'validating', 'merged', 'closed'
]);

export const CreateIssueRequestSchema = z.object({
  number: z.number().int().positive().optional(),
  repositoryId: UUIDSchema,
  title: z.string().min(1),
  body: z.string().optional(),
  labels: z.array(z.string()).optional(),
  createdBy: z.string().optional(),
});

export const IssueResponseSchema = z.object({
  id: UUIDSchema,
  number: z.number().int().positive(),
  repositoryId: UUIDSchema,
  title: z.string(),
  body: z.string().optional(),
  status: IssueStatusSchema,
  labels: z.array(z.string()).optional(),
  createdAt: z.number().int().positive(),
  createdBy: z.string(),
  closedAt: z.number().int().positive().optional(),
  closedBy: z.string().optional(),
  commentPolicy: CommentPolicySchema,
  visibility: VisibilitySchema,
  stage: IssueStageSchema,
});

export const UpdateIssueStageRequestSchema = z.object({
  stage: IssueStageSchema,
  notes: z.string().optional(),
});

export const UpdateIssueCommentPolicyRequestSchema = z.object({
  commentPolicy: CommentPolicySchema,
});

// ============================================================================
// ISSUE COMMENTS
// ============================================================================

export interface CreateIssueCommentRequest {
  issueId: string;
  body: string;
  createdBy?: string;
}

export interface IssueCommentResponse {
  id: string;
  issueId: string;
  body: string;
  createdBy: string;
  createdAt: number;
  editedAt?: number;
  editedBy?: string;
}

// Zod schemas
export const CreateIssueCommentRequestSchema = z.object({
  issueId: UUIDSchema,
  body: z.string().min(1),
  createdBy: z.string().optional(),
});

export const IssueCommentResponseSchema = z.object({
  id: UUIDSchema,
  issueId: UUIDSchema,
  body: z.string(),
  createdBy: z.string(),
  createdAt: z.number().int().positive(),
  editedAt: z.number().int().positive().optional(),
  editedBy: z.string().optional(),
});

// ============================================================================
// LINKS
// ============================================================================

export interface CreateIssueSpecLinkRequest {
  issueId: string;
  specId: string;
  relationship: 'requests-new' | 'requests-change' | 'reports-bug';
}

export interface IssueSpecLinkResponse {
  id: string;
  issueId: string;
  specId: string;
  relationship: 'requests-new' | 'requests-change' | 'reports-bug';
  createdAt: number;
}

export interface CreateIssueCandidateLinkRequest {
  issueId: string;
  candidateId: string;
  relationship: 'reports-bug' | 'requests-fix' | 'linked';
}

export interface IssueCandidateLinkResponse {
  id: string;
  issueId: string;
  candidateId: string;
  relationship: 'reports-bug' | 'requests-fix' | 'linked';
  createdAt: number;
}

// Zod schemas
export const IssueSpecRelationshipSchema = z.enum(['requests-new', 'requests-change', 'reports-bug']);
export const IssueCandidateRelationshipSchema = z.enum(['reports-bug', 'requests-fix', 'linked']);

export const CreateIssueSpecLinkRequestSchema = z.object({
  issueId: UUIDSchema,
  specId: UUIDSchema,
  relationship: IssueSpecRelationshipSchema,
});

export const IssueSpecLinkResponseSchema = z.object({
  id: UUIDSchema,
  issueId: UUIDSchema,
  specId: UUIDSchema,
  relationship: IssueSpecRelationshipSchema,
  createdAt: z.number().int().positive(),
});

export const CreateIssueCandidateLinkRequestSchema = z.object({
  issueId: UUIDSchema,
  candidateId: UUIDSchema,
  relationship: IssueCandidateRelationshipSchema,
});

export const IssueCandidateLinkResponseSchema = z.object({
  id: UUIDSchema,
  issueId: UUIDSchema,
  candidateId: UUIDSchema,
  relationship: IssueCandidateRelationshipSchema,
  createdAt: z.number().int().positive(),
});

// ============================================================================
// HISTORY
// ============================================================================

export interface EntityHistoryResponse {
  id: string;
  entityType: 'issue' | 'candidate' | 'spec' | 'trial' | 'promotion' | 'gate_verdict';
  entityId: string;
  stage: string;
  changedBy: string;
  changedAt: number;
  notes?: string;
  metadata?: string;
}

export interface GetHistoryRequest {
  entityType: 'issue' | 'candidate' | 'spec' | 'trial' | 'promotion' | 'gate_verdict';
  entityId: string;
}

// Zod schemas
export const EntityTypeSchema = z.enum([
  'issue', 'candidate', 'spec', 'trial', 'promotion', 'gate_verdict'
]);

export const GetHistoryRequestSchema = z.object({
  entityType: EntityTypeSchema,
  entityId: UUIDSchema,
});

export const EntityHistoryResponseSchema = z.object({
  id: UUIDSchema,
  entityType: EntityTypeSchema,
  entityId: UUIDSchema,
  stage: z.string(),
  changedBy: z.string(),
  changedAt: z.number().int().positive(),
  notes: z.string().optional(),
  metadata: z.string().optional(),
});

// ============================================================================
// FILTERS / QUERY PARAMS
// ============================================================================

export interface ListFilter {
  stage?: string;
  organizationId?: string;
  specId?: string;
  agentId?: string;
  repositoryId?: string;
  limit?: number;
  offset?: number;
}

// Zod schema for list filters
export const ListFilterSchema = z.object({
  stage: z.string().optional(),
  organizationId: UUIDSchema.optional(),
  specId: UUIDSchema.optional(),
  agentId: UUIDSchema.optional(),
  repositoryId: UUIDSchema.optional(),
  limit: z.number().int().positive().max(100).optional(),
  offset: z.number().int().nonnegative().optional(),
});

// ============================================================================
// HEALTH
// ============================================================================

export interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  version: string;
  timestamp: number;
  checks: {
    database: 'ok' | 'error';
    durableObject: 'ok' | 'error';
  };
}

// Zod schema
export const HealthResponseSchema = z.object({
  status: z.enum(['healthy', 'degraded', 'unhealthy']),
  version: z.string().optional(),
  timestamp: z.number().int().positive(),
  checks: z.object({
    database: z.enum(['ok', 'error']),
    durableObject: z.enum(['ok', 'error']),
  }).optional(),
});


// ============================================================================
// SERVICE ACCOUNTS
// ============================================================================

export type ServiceAccountScope = 'read' | 'write' | 'read_write';

export interface CreateServiceAccountRequest {
  name: string;
  description?: string;
  organizationId: string;
  scopes: ServiceAccountScope;
  expiresAt?: number;
}

export interface ServiceAccountResponse {
  id: string;
  name: string;
  description?: string;
  organizationId: string;
  token?: string;
  scopes: ServiceAccountScope;
  createdBy: string;
  createdAt: number;
  expiresAt?: number;
  isActive: boolean;
  lastUsedAt?: number;
}

export interface ListServiceAccountsRequest {
  organizationId?: string;
  isActive?: boolean;
  scope?: ServiceAccountScope;
  limit?: number;
  offset?: number;
}

export interface RevokeServiceAccountRequest {
  reason?: string;
}

// Zod schemas
export const ServiceAccountScopeSchema = z.enum(['read', 'write', 'read_write']);

export const CreateServiceAccountRequestSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  organizationId: UUIDSchema,
  scopes: ServiceAccountScopeSchema,
  expiresAt: z.number().int().positive().optional(),
});

export const ServiceAccountResponseSchema = z.object({
  id: UUIDSchema,
  name: z.string(),
  description: z.string().optional(),
  organizationId: UUIDSchema,
  token: z.string().optional(),
  scopes: ServiceAccountScopeSchema,
  createdBy: z.string(),
  createdAt: z.number().int().positive(),
  expiresAt: z.number().int().positive().optional(),
  isActive: z.boolean(),
  lastUsedAt: z.number().int().positive().optional(),
});

export const ListServiceAccountsRequestSchema = z.object({
  organizationId: UUIDSchema.optional(),
  isActive: z.boolean().optional(),
  scope: ServiceAccountScopeSchema.optional(),
  limit: z.number().int().positive().max(100).optional(),
  offset: z.number().int().nonnegative().optional(),
});

export const RevokeServiceAccountRequestSchema = z.object({
  reason: z.string().optional(),
});

// ============================================================================
// EXPORTS
// ============================================================================

// Export z for creating custom schemas
export { z };

// Helper to validate request body
export function validateRequest<T>(
  request: Request,
  schema: z.ZodSchema<T>
): Promise<T> {
  return request.json().then((body) => {
    const result = schema.safeParse(body);
    if (!result.success) {
      const errors = result.error.issues.map((issue) => {
        const path = issue.path.join('.');
        return `${path}: ${issue.message}`;
      });
      throw new Error(`Validation failed: ${errors.join('; ')}`);
    }
    return result.data;
  });
}

// Helper to validate query parameters
export function validateQueryParams<T extends Record<string, unknown>>(
  url: URL,
  schema: z.ZodSchema<T>
): T {
  const params: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams.entries()) {
    params[key] = value;
  }
  const result = schema.safeParse(params);
  if (!result.success) {
    const errors = result.error.issues.map((issue) => {
      const path = issue.path.join('.');
      return `${path}: ${issue.message}`;
    });
    throw new Error(`Query validation failed: ${errors.join('; ')}`);
  }
  return result.data;
}

