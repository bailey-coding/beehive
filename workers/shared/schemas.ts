/**
 * Shared Zod Schemas for Beehive
 * 
 * This file contains all Zod schemas for request/response validation
 * at API boundaries and service-to-service calls.
 * 
 * Usage:
 * - Import schemas from this file in any worker
 * - Use schema.parse() or schema.parseAsync() to validate incoming data
 * - Use schema.safeParse() or schema.safeParseAsync() for graceful handling
 * 
 * Type inference:
 * - type MyType = z.infer<typeof mySchema>;
 * 
 * Why Zod:
 * - Catches field name mismatches (camelCase vs snake_case) at runtime
 * - Validates required vs optional fields
 * - Provides clear error messages for debugging
 * - Type-safe with full TypeScript inference
 */

import { z } from 'zod';

// ============================================================================
// BASE SCHEMAS
// ============================================================================

// UUID v4 regex
export const UUIDSchema = z.string().uuid();

// Pagination parameters
export const PaginationParamsSchema = z.object({
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(50),
  limit: z.number().int().positive().max(100).optional(),
  offset: z.number().int().nonnegative().optional(),
});

// ============================================================================
// HEALTH CHECK SCHEMAS
// ============================================================================

export const HealthResponseSchema = z.object({
  status: z.enum(['healthy', 'degraded', 'unhealthy']),
  version: z.string().optional(),
  timestamp: z.number().int().positive(),
  checks: z.map(z.string(), z.enum(['ok', 'error'])).optional(),
});

// ============================================================================
// ORGANIZATION SCHEMAS
// ============================================================================

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
// ACTOR SCHEMAS
// ============================================================================

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
// REPOSITORY SCHEMAS
// ============================================================================

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
// SPEC SCHEMAS
// ============================================================================

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
// CANDIDATE SCHEMAS
// ============================================================================

// Candidate stage - supports both camelCase and snake_case for compatibility
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
// CLAIM SPEC SCHEMAS
// ============================================================================

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
// GATE VERDICT SCHEMAS
// ============================================================================

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
// TRIAL SCHEMAS
// ============================================================================

export const TrialStageSchema = z.enum(['pending', 'comparing', 'decided']);

// Comparison metrics schema
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
// PROMOTION SCHEMAS
// ============================================================================

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
// ISSUE SCHEMAS
// ============================================================================

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
// ISSUE COMMENT SCHEMAS
// ============================================================================

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
// LINK SCHEMAS
// ============================================================================

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
// HISTORY SCHEMAS
// ============================================================================

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
// FILTER SCHEMAS
// ============================================================================

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
// ARTIFACTS PUSH EVENT SCHEMAS
// ============================================================================

// Schema for Cloudflare Artifacts push events
export const ArtifactsPushEventSchema = z.object({
  id: z.string().min(1),
  type: z.literal('push'),
  repository: z.object({
    name: z.string().min(1),
    namespace: z.string().min(1),
    full_name: z.string().min(1),
  }),
  commit: z.object({
    sha: z.string().min(1),
    message: z.string().optional(),
    author: z.object({
      name: z.string().optional(),
      email: z.string().optional(),
    }).optional(),
    timestamp: z.string().optional(),
  }),
  ref: z.string().min(1),
  base_ref: z.string().optional(),
  created_at: z.string(),
});

// Queue message wrapper
export const QueueMessageSchema = z.object({
  event: ArtifactsPushEventSchema,
  received_at: z.number().int().positive(),
});

// ============================================================================
// PREVIEW MANAGER SCHEMAS
// ============================================================================

// Deploy preview request (from queue-consumer)
export const DeployPreviewRequestBodySchema = z.object({
  candidateId: UUIDSchema,
  repository: z.object({
    name: z.string().min(1),
    namespace: z.string().min(1),
    full_name: z.string().min(1),
  }),
  commit: z.object({
    sha: z.string().min(1),
    message: z.string().optional(),
    author: z.object({
      name: z.string().optional(),
      email: z.string().optional(),
    }).optional(),
    timestamp: z.string().optional(),
  }),
  commitSha: z.string().min(1).optional(),
  baseCommitSha: z.string().optional(),
  timestamp: z.number().int().positive().optional(),
});

// Preview deployment result
export const PreviewDeploymentSchema = z.object({
  previewUrl: z.string().url(),
  workerName: z.string().min(1),
  deployedAt: z.number().int().positive(),
  success: z.boolean(),
  error: z.string().optional(),
});

// Preview config
export const PreviewConfigSchema = z.object({
  candidateId: UUIDSchema,
  repositoryName: z.string().min(1),
  commitSha: z.string().min(1),
  baseCommitSha: z.string().min(1),
  specId: UUIDSchema,
});

// ============================================================================
// GATE WORKFLOW SCHEMAS
// ============================================================================

// Gate workflow request
export const GateWorkflowRequestSchema = z.object({
  candidateId: UUIDSchema,
  specId: UUIDSchema,
  commitSha: z.string().min(1),
  baseCommitSha: z.string().min(1),
  actorId: z.string().min(1),
  namespace: z.string().optional(),
  repoName: z.string().optional(),
});

// Test result schema
export const TestResultSchema = z.object({
  testName: z.string().min(1),
  passed: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  error: z.string().optional(),
});

// Conformance error schema
export const ConformanceErrorSchema = z.object({
  path: z.string().min(1),
  expected: z.string().optional(),
  actual: z.string().optional(),
  severity: z.enum(['error', 'warning']),
});

// Gate workflow result
export const GateWorkflowResultSchema = z.object({
  verdictId: UUIDSchema,
  candidateId: UUIDSchema,
  specId: UUIDSchema.optional(),
  commitSha: z.string().optional(),
  baseCommitSha: z.string().optional(),
  gate: z.literal('pre-merge'),
  status: GateStatusSchema,
  score: z.number().min(0).max(100),
  complexityDelta: z.number(),
  testResults: z.array(TestResultSchema),
  conformanceErrors: z.array(ConformanceErrorSchema),
  notes: z.string().optional(),
  startedAt: z.number().int().positive(),
  completedAt: z.number().int().positive(),
});

// ============================================================================
// SCIENTIST COMPARATOR SCHEMAS
// ============================================================================

// Response data from shadow comparison
export const ResponseDataSchema = z.object({
  candidateId: UUIDSchema,
  specId: UUIDSchema,
  status: z.number().int().positive(),
  headers: z.map(z.string(), z.string()),
  body: z.string().optional(),
  latencyMs: z.number().int().nonnegative(),
});

// Queue message for scientist comparisons
export const ScientistQueueMessageSchema = z.object({
  requestId: UUIDSchema,
  timestamp: z.number().int().positive(),
  path: z.string().min(1),
  method: z.string().min(1),
  headers: z.map(z.string(), z.string()),
  body: z.string().optional(),
  baseline: ResponseDataSchema,
  candidates: z.array(z.object({ ...ResponseDataSchema.shape, previewUrl: z.string().url().optional() })),
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Validate and parse a request body against a schema
 * Returns parsed data or throws with clear error message
 */
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

/**
 * Validate and parse query parameters against a schema
 */
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


// ============================================================================
// SERVICE ACCOUNT SCHEMAS
// ============================================================================

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

export {
  z,
};
