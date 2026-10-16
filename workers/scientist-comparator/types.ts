/**
 * Type definitions for Scientist Comparator
 * 
 * This module contains all TypeScript types used by the Scientist Comparator Worker.
 */

import { z } from 'zod';

// ============================================================================
// Queue Message Types
// ============================================================================

/**
 * Message sent from Shadow Router to Scientist Comparator Queue
 * Contains all information needed to perform the comparison
 */
export interface ScientistQueueMessage {
  // Unique identifier for this request
  requestId: string;
  
  // Timestamp when the shadow request was made
  timestamp: number;
  
  // Request metadata
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  
  // Baseline (production) response
  baseline: ResponseData;
  
  // Candidate responses (one per candidate)
  candidates: CandidateResponse[];
}

/**
 * Response data structure
 */
export interface ResponseData {
  candidateId: string;
  specId: string;
  status: number;
  headers: Record<string, string>;
  body?: string;
  latencyMs: number;
}

/**
 * Candidate response with additional metadata
 */
export interface CandidateResponse extends ResponseData {
  // Preview URL that was called
  previewUrl?: string;
}

// Zod schemas for queue messages
export const ResponseDataSchema = z.object({
  candidateId: z.string().uuid(),
  specId: z.string().uuid(),
  status: z.number().int().positive(),
  headers: z.map(z.string(), z.string()),
  body: z.string().optional(),
  latencyMs: z.number().int().nonnegative(),
});

export const CandidateResponseSchema = z.object({
  ...ResponseDataSchema.shape,
  previewUrl: z.string().url().optional(),
});

export const ScientistQueueMessageSchema = z.object({
  requestId: z.string().uuid(),
  timestamp: z.number().int().positive(),
  path: z.string().min(1),
  method: z.string().min(1),
  headers: z.map(z.string(), z.string()),
  body: z.string().optional(),
  baseline: ResponseDataSchema,
  candidates: z.array(CandidateResponseSchema),
});

// ============================================================================
// Delta Surface Types
// ============================================================================

/**
 * Complete declared delta surface from spec
 */
export interface DeltaSurface {
  version: string;
  paths: Record<string, PathDeltaSurface>;
  defaults: PathDeltaSurface;
}

/**
 * Delta surface configuration for a specific path
 */
export interface PathDeltaSurface {
  statusCodes?: {
    allowed?: number[];
    forbidden?: number[];
  };
  response?: {
    body?: BodyDeltaSurface;
    headers?: HeaderDeltaSurface;
  };
  performance?: PerformanceDeltaSurface;
}

/**
 * Body comparison configuration
 */
export interface BodyDeltaSurface {
  // JSON paths that are allowed to differ
  allowedDiffs?: string[];
  
  // JSON paths that must be identical
  forbiddenDiffs?: string[];
  
  // Whether new fields in candidate are allowed
  newFieldsAllowed?: boolean;
  
  // Whether missing fields in candidate are allowed
  missingFieldsAllowed?: boolean;
}

/**
 * Header comparison configuration
 */
export interface HeaderDeltaSurface {
  // Header names (case-insensitive) that are allowed to differ
  allowedDiffs?: string[];
  
  // Header names (case-insensitive) that must be identical
  forbiddenDiffs?: string[];
}

/**
 * Performance comparison configuration
 */
export interface PerformanceDeltaSurface {
  // Maximum absolute latency difference in ms
  maxLatencyDeltaMs?: number;
  
  // Maximum latency ratio (candidate/baseline)
  maxLatencyRatio?: number;
}

// Zod schemas for delta surface
export const BodyDeltaSurfaceSchema = z.object({
  allowedDiffs: z.array(z.string()).optional(),
  forbiddenDiffs: z.array(z.string()).optional(),
  newFieldsAllowed: z.boolean().optional(),
  missingFieldsAllowed: z.boolean().optional(),
});

export const HeaderDeltaSurfaceSchema = z.object({
  allowedDiffs: z.array(z.string()).optional(),
  forbiddenDiffs: z.array(z.string()).optional(),
});

export const PerformanceDeltaSurfaceSchema = z.object({
  maxLatencyDeltaMs: z.number().positive().optional(),
  maxLatencyRatio: z.number().positive().optional(),
});

export const PathDeltaSurfaceSchema = z.object({
  statusCodes: z.object({
    allowed: z.array(z.number().int().positive()).optional(),
    forbidden: z.array(z.number().int().positive()).optional(),
  }).optional(),
  response: z.object({
    body: BodyDeltaSurfaceSchema.optional(),
    headers: HeaderDeltaSurfaceSchema.optional(),
  }).optional(),
  performance: PerformanceDeltaSurfaceSchema.optional(),
});

export const DeltaSurfaceSchema = z.object({
  version: z.string(),
  paths: z.map(z.string(), PathDeltaSurfaceSchema),
  defaults: PathDeltaSurfaceSchema,
});

// ============================================================================
// Comparison Result Types
// ============================================================================

/**
 * Result of comparing status codes
 */
export interface StatusResult {
  match: boolean;
  type: 'status_match' | 'status_mismatch' | 'status_forbidden';
  baselineStatus: number;
  candidateStatus: number;
  severity?: 'error' | 'warning';
}

/**
 * Result of comparing headers
 */
export interface HeaderComparisonResult {
  match: boolean;
  diffs: HeaderDiff[];
}

/**
 * Individual header difference
 */
export interface HeaderDiff {
  header: string; // Normalized (lowercase) header name
  baselineValue?: string;
  candidateValue?: string;
  type: 'forbidden_diff' | 'unexpected_diff' | 'missing_in_candidate' | 'new_in_candidate';
  severity: 'error' | 'warning';
}

/**
 * Result of comparing response bodies
 */
export interface BodyComparisonResult {
  match: boolean;
  diffs: BodyDiff[];
}

/**
 * Individual body field difference
 */
export interface BodyDiff {
  path: string; // JSON path to the differing field
  baselineValue?: unknown;
  candidateValue?: unknown;
  type: 'forbidden_diff' | 'unexpected_diff' | 'new_field' | 'missing_field' | 'type_mismatch';
  severity: 'error' | 'warning';
}

/**
 * Result of comparing performance
 */
export interface PerformanceComparisonResult {
  match: boolean;
  baselineLatencyMs: number;
  candidateLatencyMs: number;
  latencyDeltaMs: number;
  latencyRatio: number;
  issues: PerformanceIssue[];
}

/**
 * Individual performance issue
 */
export interface PerformanceIssue {
  type: 'absolute_delta_exceeded' | 'ratio_exceeded';
  deltaMs?: number;
  ratio?: number;
  threshold: number;
  severity: 'error' | 'warning';
}

// Zod schemas for comparison results
export const StatusResultSchema = z.object({
  match: z.boolean(),
  type: z.enum(['status_match', 'status_mismatch', 'status_forbidden']),
  baselineStatus: z.number().int().positive(),
  candidateStatus: z.number().int().positive(),
  severity: z.enum(['error', 'warning']).optional(),
});

export const HeaderDiffSchema = z.object({
  header: z.string().min(1),
  baselineValue: z.string().optional(),
  candidateValue: z.string().optional(),
  type: z.enum(['forbidden_diff', 'unexpected_diff', 'missing_in_candidate', 'new_in_candidate']),
  severity: z.enum(['error', 'warning']),
});

export const HeaderComparisonResultSchema = z.object({
  match: z.boolean(),
  diffs: z.array(HeaderDiffSchema),
});

export const BodyDiffSchema = z.object({
  path: z.string().min(1),
  baselineValue: z.unknown().optional(),
  candidateValue: z.unknown().optional(),
  type: z.enum(['forbidden_diff', 'unexpected_diff', 'new_field', 'missing_field', 'type_mismatch']),
  severity: z.enum(['error', 'warning']),
});

export const BodyComparisonResultSchema = z.object({
  match: z.boolean(),
  diffs: z.array(BodyDiffSchema),
});

export const PerformanceIssueSchema = z.object({
  type: z.enum(['absolute_delta_exceeded', 'ratio_exceeded']),
  deltaMs: z.number().optional(),
  ratio: z.number().optional(),
  threshold: z.number().positive(),
  severity: z.enum(['error', 'warning']),
});

export const PerformanceComparisonResultSchema = z.object({
  match: z.boolean(),
  baselineLatencyMs: z.number().int().nonnegative(),
  candidateLatencyMs: z.number().int().nonnegative(),
  latencyDeltaMs: z.number().int(),
  latencyRatio: z.number(),
  issues: z.array(PerformanceIssueSchema),
});

/**
 * Complete comparison result for one candidate
 */
export interface CandidateComparisonResult {
  requestId: string;
  candidateId: string;
  specId: string;
  path: string;
  method: string;
  timestamp: number;
  
  // Individual comparison results
  statusComparison: StatusResult;
  headerComparison: HeaderComparisonResult;
  bodyComparison: BodyComparisonResult;
  performanceComparison: PerformanceComparisonResult;
  
  // Aggregated metrics
  score: number; // 0-100
  matched: boolean;
  errors: number;
  warnings: number;
  
  // All diffs combined
  diffs: ComparisonDiff[];
}

/**
 * Combined diff from any comparison component
 */
export interface ComparisonDiff {
  type: 'status' | 'header' | 'body' | 'performance';
  path?: string; // For body diffs
  header?: string; // For header diffs
  severity: 'error' | 'warning' | 'info';
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Result for comparing all candidates for one request
 */
export interface RequestComparisonResult {
  requestId: string;
  timestamp: number;
  path: string;
  method: string;
  
  // Baseline info
  baseline: ResponseData;
  
  // Results for each candidate
  candidates: CandidateComparisonResult[];
  
  // Aggregate stats across all candidates
  totalCandidates: number;
  matchedCandidates: number;
  averageScore: number;
  
  // Timestamp when comparison was completed
  completedAt: number;
}

// ============================================================================
// Storage Types
// ============================================================================

/**
 * Update to apply to candidate in Spec DO
 */
export interface CandidateShadowUpdate {
  candidateId: string;
  specId: string;
  score: number; // New shadow_score (rolling average)
  match: boolean; // New shadow_match value
  metrics: ShadowMetrics; // Updated shadow_metrics JSON
}

/**
 * Metrics stored in candidate.shadow_metrics
 */
export interface ShadowMetrics {
  // Rolling average score
  averageScore: number;
  
  // Total requests compared
  totalRequests: number;
  
  // Requests that matched
  matchedRequests: number;
  
  // Aggregate diff statistics
  aggregateDiffs: {
    total: number;
    byType: Record<string, number>;
    bySeverity: Record<'error' | 'warning' | 'info', number>;
  };
  
  // Last comparison timestamp
  lastComparisonAt: number;
  
  // Last request ID
  lastRequestId: string;
}

// ============================================================================
// Gate Verdict Types
// ============================================================================

/**
 * Verdict for shadow gate
 */
export interface ShadowGateVerdict {
  id: string;
  candidateId: string;
  gate: 'shadow';
  status: 'pass' | 'fail' | 'pending';
  score: number; // 0-100
  notes: string;
  createdAt: number;
  decidedBy: string; // Actor ID (scientist-comparator)
  
  // Shadow-specific metrics
  shadowMetrics: {
    totalRequests: number;
    matchedRequests: number;
    matchRate: number; // 0-1
    averageScore: number;
  };
}

// ============================================================================
// Worker Environment Types
// ============================================================================

/**
 * Environment bindings for Scientist Comparator Worker
 */
export interface ScientistEnv {
  // Auth
  API_AUTH_TOKEN?: string;
  
  // Durable Objects
  SPEC_DO: DurableObjectNamespace;
  // Tier-1 secret for Spec DO calls (workers/shared/spec-do-auth.ts); no admin token on this worker
  SPEC_DO_INTERNAL_TOKEN?: string;
  
  // Analytics Engine
  ANALYTICS: AnalyticsEngine;
  
  // Queues
  SCIENTIST_QUEUE: Queue;
  preview_scientist_comparisons?: Queue;
}

// ============================================================================
// Utility Types
// ============================================================================

/**
 * Cloudflare Queue binding type
 */
export interface Queue {
  send: (message: ScientistQueueMessage) => Promise<void>;
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

/**
 * Durable Object stub for Spec DO
 */
export interface SpecDOStub {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

/**
 * JSON path segment for body comparison
 */
export type JsonPathSegment = string | number;

/**
 * JSON path as array of segments
 */
export type JsonPath = JsonPathSegment[];

// ============================================================================
// Cloudflare Workers Queue Types
// ============================================================================

/**
 * Cloudflare Queue Message type (from workers-types)
 * This is a simplified version for our use case
 */
export interface Message<Body = unknown> {
  id: string;
  timestamp: Date;
  body: Body;
  retryCount: number;
}

/**
 * Message batch for queue consumers
 */
export interface MessageBatch<Body = unknown> {
  readonly messages: readonly Message<Body>[];
  readonly queue: string;
  retryAll(options?: { delaySeconds?: number }): void;
  ackAll(): void;
}

// Export z for creating custom schemas
export { z };
