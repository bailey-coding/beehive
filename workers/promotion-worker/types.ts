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
  /** Optional: the Spec DO derives the rung a candidate is on from its stage. When given, a mismatch is a 409 stale_from_rung */
  fromRung?: Rung;
  toRung: Rung;
  actorId?: string;
  timestamp?: string;
}

/**
 * What a successful promotion call did for the requesting candidate. `moved` is the only outcome that advanced its stage;
 * `waiting` (alone in a tournament), `eliminated` (lost the tournament) and `queued` (a merge-train car not yet merged) finished
 * without moving it, and `noop` means it was already there. docs/plans/promotion-gaps-plan.md sections 3.5, 11 (N5), 12 (V1).
 */
export type PromotionOutcome = 'moved' | 'waiting' | 'eliminated' | 'queued' | 'noop';

/** A candidate whose stage this call advanced (not always the requester: a tournament winner, a merged car) */
export interface PromotionMove {
  candidateId: string;
  fromRung: Rung;
  toRung: Rung;
}

/** A request whose from-rung has been resolved (the Spec DO derives it from the candidate's stage) */
export type ResolvedPromotionRequest = PromotionRequest & { fromRung: Rung };

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
  /** Set on success */
  outcome?: PromotionOutcome;
  /** Set on failure: a stable reason (stale_from_rung, not_next_rung, evidence_missing, candidate_not_found, ledger_too_old, tie, no_shadow_evidence, ...) */
  code?: string;
  /** Candidates whose stage was advanced by this call */
  moves?: PromotionMove[];
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
