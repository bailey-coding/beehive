/**
 * TypeScript type definitions for the Beehive Promotion Worker
 * M3 Promotion Implementation
 */

// ============================================================================
// Core Types
// ============================================================================

// Promotion mode
export type PromotionMode = 'tournament' | 'merge-train';

// Rung types based on the oracle ladder
export type Rung = 'pre-merge' | 'shadow' | 'train' | 'canary' | 'full';

// ============================================================================
// Request/Response Types
// ============================================================================

// Candidate promotion request
export interface PromotionRequest {
  candidateId: string;
  specId: string;
  fromRung: Rung;
  toRung: Rung;
  actorId?: string;
  timestamp?: string;
}

// Promotion result
export interface PromotionResult {
  success: boolean;
  candidateId: string;
  specId: string;
  fromRung: Rung;
  toRung: Rung;
  message: string;
  timestamp: string;
  mode?: PromotionMode;
  details?: Record<string, unknown>;
}

// ============================================================================
// Tournament Mode Types
// ============================================================================

// Tournament status
export interface TournamentStatus {
  mode: 'tournament';
  specId: string;
  candidates: TournamentCandidate[];
  winner?: string;
  comparisons: CandidateComparison[];
  startedAt: string;
  completedAt?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
}

// Tournament candidate
export interface TournamentCandidate {
  candidateId: string;
  specId: string;
  score: number;
  status: 'competing' | 'winner' | 'eliminated' | 'disqualified';
  metrics: CandidateMetrics;
  promotedAt?: string;
}

// Candidate comparison result
export interface CandidateComparison {
  candidate1: string;
  candidate2: string;
  winner: string;
  comparisonScore: number;
  comparedAt: string;
  criteria?: Record<string, number>;
}

// ============================================================================
// Merge-Train Mode Types
// ============================================================================

// Merge-train status
export interface MergeTrainStatus {
  mode: 'merge-train';
  specId: string;
  candidates: MergeTrainCandidate[];
  currentPosition: number;
  nextMerge: string | null;
  status: 'idle' | 'processing' | 'paused' | 'failed';
  startedAt?: string;
  completedAt?: string;
}

// Merge-train candidate
export interface MergeTrainCandidate {
  candidateId: string;
  specId: string;
  position: number;
  status: 'waiting' | 'merging' | 'merged' | 'failed' | 'rolled_back';
  mergedAt?: string;
  failedAt?: string;
  failureReason?: string;
}

// ============================================================================
// Candidate Metrics
// ============================================================================

// Candidate metrics for scoring and comparison
export interface CandidateMetrics {
  passRate: number;
  failureRate: number;
  latencyP95: number;
  latencyP50: number;
  errorRate: number;
  throughput: number;
  score: number;
  conformanceScore: number;
  complexityDelta: number;
  stability: number;
}

// ============================================================================
// Promotion State (Spec DO)
// ============================================================================

// Promotion state stored in Spec DO
export interface PromotionState {
  id: string;
  candidateId: string;
  specId: string;
  currentRung: Rung;
  targetRung: Rung;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'rolled_back' | 'cancelled';
  mode: PromotionMode;
  startedAt: string;
  completedAt?: string;
  failedAt?: string;
  failureReason?: string;
  rollbackReason?: string;
  actorId?: string;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Service Bindings
// ============================================================================

// Import types from Cloudflare Workers
// Using the global Service type from @cloudflare/workers-types
// which is already available in the global scope

// Analytics Engine type
type AnalyticsEngine = {
  writeDataPoint: (point?: { indexes?: (ArrayBuffer | string | null)[]; doubles?: number[]; blobs?: (ArrayBuffer | string | null)[] }) => void;
};

// Environment interface for the worker
export interface Env {
  SPEC_DO: DurableObjectNamespace;
  PREVIEW_MANAGER: Service;
  GATE_WORKFLOW: Service;
  SHADOW_ROUTER: Service;
  ANALYTICS: AnalyticsEngine;
  PROMOTION_MODE: string;
  MAX_CONCURRENT_CANDIDATES: string;
  PROMOTION_TIMEOUT: string;
  API_AUTH_TOKEN?: string;
}

// ============================================================================
// Analytics Types
// ============================================================================

// Analytics event for promotion tracking
export interface PromotionAnalytics {
  event: 'promotion_started' | 'promotion_completed' | 'promotion_failed' | 'tournament_started' | 'tournament_completed' | 'merge_started' | 'merge_completed' | 'merge_failed';
  candidateId: string;
  specId: string;
  mode: PromotionMode;
  fromRung: Rung;
  toRung: Rung;
  success: boolean;
  durationMs?: number;
  score?: number;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Response Types
// ============================================================================

// Response wrapper
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: string;
}

// Status response
export interface StatusResponse {
  status: string;
  mode: PromotionMode;
  uptime: number;
  lastProcessed?: string;
  queueDepth?: number;
}
