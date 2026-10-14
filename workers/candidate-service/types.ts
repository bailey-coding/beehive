/**
 * Type definitions for Candidate Service Worker
 */

import { z } from 'zod';

// ============================================================================
// Environment Types
// ============================================================================

/**
 * Environment bindings for Candidate Service Worker
 */
export interface CandidateServiceEnv {
  // Auth
  API_AUTH_TOKEN?: string;
  
  // Cloudflare configuration
  CLOUDFLARE_ACCOUNT_ID: string;
  /** Your workers.dev subdomain (the part before `.workers.dev`). */
  WORKERS_SUBDOMAIN?: string;
  CLOUDFLARE_API_TOKEN?: string;
  
  // Durable Objects
  SPEC_DO: DurableObjectNamespace;
  
  // Analytics Engine
  ANALYTICS: AnalyticsEngine;
}

// ============================================================================
// Candidate Types
// ============================================================================

/**
 * Candidate record with full details
 */
export interface Candidate {
  id: string;
  specId: string;
  repositoryId: string;
  commitSha: string;
  baseCommitSha: string;
  agentId: string;
  createdAt: number;
  stage: 'pending' | 'passed_premerge' | 'passed_shadow' | 'passed_train' | 'passed_canary' | 'promoted' | 'failed' | 'rolled_back';
  previewUrl?: string;
  previewWorkerName?: string;
  previewDeployedAt?: number;
  shadowMatch?: boolean;
  shadowScore?: number;
  shadowMetrics?: string;
  repository?: {
    id: string;
    name: string;
    organization_id: string;
    repo_type: 'baseline' | 'candidate';
    spec_id?: string;
    agent_id?: string;
    remote_url: string;
    namespace: string;
    default_branch: string;
    created_at: number;
  };
}

// Zod schemas
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

export const CandidateSchema = z.object({
  id: z.string().uuid(),
  specId: z.string().uuid(),
  repositoryId: z.string().uuid(),
  commitSha: z.string(),
  baseCommitSha: z.string(),
  agentId: z.string().uuid(),
  createdAt: z.number().int().positive(),
  stage: CandidateStageSchema,
  previewUrl: z.string().url().optional(),
  previewWorkerName: z.string().optional(),
  previewDeployedAt: z.number().int().positive().optional(),
  shadowMatch: z.boolean().optional(),
  shadowScore: z.number().optional(),
  shadowMetrics: z.string().optional(),
  repository: z.object({
    id: z.string().uuid(),
    name: z.string(),
    organization_id: z.string().uuid(),
    repo_type: z.enum(['baseline', 'candidate']),
    spec_id: z.string().uuid().optional(),
    agent_id: z.string().uuid().optional(),
    remote_url: z.string(),
    namespace: z.string(),
    default_branch: z.string(),
    created_at: z.number().int().positive(),
  }).optional(),
});

// ============================================================================
// API Request/Response Types
// ============================================================================

/**
 * Request to deploy a candidate preview
 */
export interface DeployPreviewRequest {
  candidateId: string;
  commitSha?: string;
  forceRedeploy?: boolean;
}

/**
 * Response for preview deployment
 */
export interface DeployPreviewResponse {
  success: boolean;
  previewUrl?: string;
  previewWorkerName?: string;
  deployedAt?: number;
  error?: string;
  candidate?: Candidate;
}

/**
 * Request to check candidate health
 */
export interface HealthCheckRequest {
  candidateId: string;
  previewUrl?: string;
}

/**
 * Response for health check
 */
export interface HealthCheckResponse {
  healthy: boolean;
  candidateId: string;
  previewUrl?: string;
  latencyMs?: number;
  statusCode?: number;
  error?: string;
  checkedAt: number;
}

/**
 * Request to get candidate info
 */
export interface GetCandidateRequest {
  candidateId: string;
}

/**
 * Response with candidate info
 */
export interface GetCandidateResponse {
  candidate?: Candidate;
  error?: string;
}

/**
 * Request to update candidate preview
 */
export interface UpdatePreviewRequest {
  candidateId: string;
  previewUrl: string;
  previewWorkerName: string;
}

/**
 * Response for preview update
 */
export interface UpdatePreviewResponse {
  success: boolean;
  candidate?: Candidate;
  error?: string;
}

// Zod schemas for API types
export const DeployPreviewRequestSchema = z.object({
  candidateId: z.string().uuid(),
  commitSha: z.string().optional(),
  forceRedeploy: z.boolean().optional(),
});

export const DeployPreviewResponseSchema = z.object({
  success: z.boolean(),
  previewUrl: z.string().url().optional(),
  previewWorkerName: z.string().optional(),
  deployedAt: z.number().int().positive().optional(),
  error: z.string().optional(),
  candidate: CandidateSchema.optional(),
});

export const HealthCheckRequestSchema = z.object({
  candidateId: z.string().uuid(),
  previewUrl: z.string().url().optional(),
});

export const HealthCheckResponseSchema = z.object({
  healthy: z.boolean(),
  candidateId: z.string().uuid(),
  previewUrl: z.string().url().optional(),
  latencyMs: z.number().int().nonnegative().optional(),
  statusCode: z.number().int().positive().optional(),
  error: z.string().optional(),
  checkedAt: z.number().int().positive(),
});

export const GetCandidateRequestSchema = z.object({
  candidateId: z.string().uuid(),
});

export const GetCandidateResponseSchema = z.object({
  candidate: CandidateSchema.optional(),
  error: z.string().optional(),
});

export const UpdatePreviewRequestSchema = z.object({
  candidateId: z.string().uuid(),
  previewUrl: z.string().url(),
  previewWorkerName: z.string().min(1),
});

export const UpdatePreviewResponseSchema = z.object({
  success: z.boolean(),
  candidate: CandidateSchema.optional(),
  error: z.string().optional(),
});

// ============================================================================
// Cloudflare Types
// ============================================================================

/**
 * Cloudflare Analytics Engine binding type
 */
export interface AnalyticsEngine {
  writeDataPoint: (event: {
    indexes: Array<Record<string, string>>;
    blobs: Array<Record<string, string>>;
    doubles: Array<Record<string, number>>;
  }) => void;
}

// ============================================================================
// Worker Exports
// ============================================================================

export type ExportedHandler<E = unknown> = {
  fetch: (request: Request, env: E, ctx: ExecutionContext) => Promise<Response>;
};

// Export z for creating custom schemas
export { z };
