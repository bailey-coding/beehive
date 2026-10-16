/**
 * TypeScript type definitions for the Beehive Promotion Worker
 * M3 Promotion Implementation
 */

// ============================================================================
// Core Types
// ============================================================================

// Ledger payloads (validated at the Spec DO boundary) live in the shared module
export type {
  PromotionMode,
  Rung,
  PromotionState,
  TournamentStatus,
  TournamentCandidate,
  CandidateComparison,
  MergeTrainStatus,
  MergeTrainCandidate,
  CandidateMetrics,
} from '../shared/promotion-ledger';
import type { PromotionMode, Rung } from '../shared/promotion-ledger';

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
  // Tier-1 secret for Spec DO calls (workers/shared/spec-do-auth.ts); no admin token on this worker
  SPEC_DO_INTERNAL_TOKEN?: string;
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
