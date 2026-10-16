/**
 * Type definitions for Preview Manager Worker
 */

import { z } from 'zod';

// ============================================================================
// Cloudflare Service Binding Type
// ============================================================================

/**
 * Cloudflare Service binding type for calling other Workers
 */
export interface Service {
  fetch: (request: Request) => Promise<Response>;
}

// ============================================================================
// Environment Types
// ============================================================================

/**
 * Environment bindings for Preview Manager Worker
 */
export interface PreviewManagerEnv {
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
  
  // Queue for sending preview comparisons
  PREVIEW_SCIENTIST_QUEUE: Queue;

  // 'stub' selects the local Workers Versions stand-in (versions.ts); unset -> 501
  WORKER_VERSIONS_MODE?: string;
}

// ============================================================================
// API Request Types
// ============================================================================

/**
 * Request body for preview deployment
 */
export interface DeployPreviewRequestBody {
  candidateId: string;
  repository: {
    name: string;
    namespace: string;
    full_name: string;
  };
  commit: {
    sha: string;
    message: string;
    author: {
      name: string;
      email: string;
    };
    timestamp: string;
  };
  commitSha?: string;
  baseCommitSha?: string;
  timestamp?: number;
}

// Zod schema for deploy preview request
export const DeployPreviewRequestBodySchema = z.object({
  candidateId: z.string().uuid(),
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

// Body of POST /api/preview/canary (canary worker). Ids need no ledger row,
// like the promotion ledger; when the candidate exists its commit is used.
export const CanaryVersionRequestSchema = z
  .object({
    candidateId: z.string().min(1),
    specId: z.string().min(1),
    commitSha: z.string().min(1).optional(),
  })
  .strict();

export type CanaryVersionRequest = z.infer<typeof CanaryVersionRequestSchema>;

// ============================================================================
// Queue Message Types
// ============================================================================

/**
 * Artifacts push event from Cloudflare Artifacts
 */
export interface ArtifactsPushEvent {
  id: string;
  type: 'push';
  repository: {
    name: string;
    namespace: string;
    full_name: string;
  };
  commit: {
    sha: string;
    message: string;
    author: {
      name: string;
      email: string;
    };
    timestamp: string;
  };
  ref: string;
  base_ref?: string;
  created_at: string;
}

/**
 * Queue message wrapper
 */
export interface PreviewQueueMessage {
  event: ArtifactsPushEvent;
  received_at: number;
}

// Zod schemas for queue messages
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

export const PreviewQueueMessageSchema = z.object({
  event: ArtifactsPushEventSchema,
  received_at: z.number().int().positive(),
});

// ============================================================================
// Preview Types
// ============================================================================

/**
 * Preview deployment configuration
 */
export interface PreviewConfig {
  candidateId: string;
  repositoryName: string;
  commitSha: string;
  baseCommitSha: string;
  specId: string;
}

/**
 * Preview deployment result
 */
export interface PreviewDeployment {
  previewUrl: string;
  workerName: string;
  deployedAt: number;
  success: boolean;
  error?: string;
}

/**
 * Candidate record from Spec DO
 */
export interface Candidate {
  id: string;
  specId: string;
  repositoryId: string;
  commitSha: string;
  baseCommitSha: string;
  base_commit_sha?: string;
  repository?: {
    remote_url: string;
    namespace: string;
  };
  previewUrl?: string;
  previewWorkerName?: string;
  previewDeployedAt?: number;
  stage: string;
  agentId?: string;
}

// Zod schemas for preview types
export const PreviewConfigSchema = z.object({
  candidateId: z.string().uuid(),
  repositoryName: z.string().min(1),
  commitSha: z.string().min(1),
  baseCommitSha: z.string().min(1),
  specId: z.string().uuid(),
});

export const PreviewDeploymentSchema = z.object({
  previewUrl: z.string().url(),
  workerName: z.string().min(1),
  deployedAt: z.number().int().positive(),
  success: z.boolean(),
  error: z.string().optional(),
});

export const CandidateSchema = z.object({
  id: z.string().uuid(),
  specId: z.string().uuid(),
  repositoryId: z.string().uuid(),
  commitSha: z.string(),
  baseCommitSha: z.string(),
  base_commit_sha: z.string().optional(),
  repository: z.object({
    remote_url: z.string().optional(),
    namespace: z.string().optional(),
  }).optional(),
  previewUrl: z.string().url().optional(),
  previewWorkerName: z.string().optional(),
  previewDeployedAt: z.number().int().positive().optional(),
  stage: z.string(),
  agentId: z.string().optional(),
});

// ============================================================================
// Cloudflare Types
// ============================================================================

/**
 * Cloudflare Workers Queue binding type
 */
export interface Queue {
  send: (message: unknown) => Promise<void>;
}

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
  queue: (batch: MessageBatch<PreviewQueueMessage>, env: E, ctx: ExecutionContext) => Promise<void>;
};

// Export z for creating custom schemas
export { z };


