/**
 * Shadow Router Type Definitions
 * Extended for M3 Statsig Traffic Splitting
 */

import type { AnalyticsEngine } from '../shared/analytics';
import type { Queue } from '../scientist-comparator/types';

// Type for the Analytics Engine binding
declare const ANALYTICS: AnalyticsEngine;

// Type for the Scientist Comparator Queue bindings
declare const SCIENTIST_QUEUE: Queue;
declare const PREVIEW_SCIENTIST_QUEUE: Queue;

// ============================================================================
// Statsig Traffic Splitting Types
// ============================================================================

/**
 * Traffic split configuration for a spec or candidate
 * Percentages should sum to 100
 */
export interface TrafficSplitConfig {
  canaryPercentage: number;    // 0-100: percentage of traffic to canary candidate
  holdoutPercentage: number;   // 0-100: percentage of traffic to holdout group (production baseline)
  baselinePercentage: number;  // Calculated: 100 - canary - holdout
}

/**
 * Classification result for a request
 * Determines which traffic group the request belongs to
 */
export interface RequestClassification {
  type: 'canary' | 'holdout' | 'baseline' | 'shadow';
  candidateId?: string;
  weight: number; // 0-1: proportional weight of this classification
}

// ============================================================================
// Shadow Router Configuration Types
// ============================================================================

/**
 * Extended Shadow Router Configuration with Statsig support
 */
export interface ShadowConfig {
  // ===== Existing Fields =====
  
  // Candidate preview URLs to mirror traffic to
  candidatePreviews: Map<string, string>; // candidateId -> previewUrl

  // candidateId -> live canary deployment id (from the deploy refs). Absent/empty for static
  // candidates, which have no deployment and so no canary metrics.
  canaryDeployments?: Map<string, string>;
  
  // Sample rate (0.0 - 1.0)
  sampleRate: number;
  
  // Paths to mirror (default: all)
  mirrorPaths: string[];
  
  // Paths to exclude
  excludePaths: string[];

  // ===== New Statsig Fields =====
  
  /**
   * Statsig traffic splitting configuration
   */
  statsig: {
    // Whether Statsig traffic splitting is enabled
    enabled: boolean;
    
    // Per-candidate/spec traffic split configurations
    splits: Record<string, TrafficSplitConfig>; // key: specId or candidateId
    
    // Default split configuration for requests without a specific config
    defaultSplit: TrafficSplitConfig;
  };
}

/**
 * Configuration for building Shadow Router in different environments
 */
export interface ShadowRouterEnv {
  SPEC_DO?: any;
  // Tier-1 secret for Spec DO calls (workers/shared/spec-do-auth.ts); no admin token on this worker
  SPEC_DO_INTERNAL_TOKEN?: string;
  // Live canary pointer cache TTL in ms (default 5000, 0 disables; workers/shadow-router/live-refs-cache.ts)
  LIVE_REFS_CACHE_TTL_MS?: string;
  ANALYTICS?: AnalyticsEngine;
  SCIENTIST_QUEUE?: Queue;
  PREVIEW_SCIENTIST_QUEUE?: Queue;
  API_AUTH_TOKEN?: string;
}

// ============================================================================
// Metrics Types
// ============================================================================

/**
 * Traffic split classification metrics
 */
export interface TrafficSplitMetrics {
  classification: string;
  candidateId: string;
  weight: number;
  timestamp: number;
}

// Re-export existing types for convenience
export type { AnalyticsEngine };
export type { Queue };
