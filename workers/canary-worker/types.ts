import type {
  DurableObjectNamespace,
  Service,
  ExecutionContext,
  Message,
  MessageBatch,
} from '@cloudflare/workers-types';

// Analytics Engine type definition
export interface AnalyticsEngine {
  writeDataPoint: (event: {
    indexes: Array<Record<string, string>>;
    blobs: Array<Record<string, string>>;
    doubles: Array<Record<string, number>>;
  }) => void;
}

// Canary deployment configuration
export interface CanaryConfig {
  candidateId: string;
  specId: string;
  trafficPercentage: number; // 1-100
  holdoutPercentage: number; // 0-100
  autoRollback?: boolean; // default true: SLO triggers may roll this canary back
  rollbackThreshold?: {
    latencyP95: number; // milliseconds
    errorRate: number; // 0-1
  };
}

// Rollback trigger
export interface RollbackTrigger {
  candidateId: string;
  specId: string;
  reason: 'latency' | 'error_rate' | 'manual' | 'slo_violation';
  timestamp: string;
  metrics: {
    latencyP95?: number;
    errorRate?: number;
    requestCount?: number;
  };
}

// Verdict for one live canary deployment (SLO loop, docs/M3-CANARY-SLO-PLAN.md)
export interface DeploymentVerdict {
  deploymentId: string;
  candidateId: string;
  specId: string;
  autoRollback: boolean;
  /** Where the samples came from. 'shadow' is mirrored traffic, not a canary SLO. */
  source: 'shadow' | 'canary';
  /**
   * healthy: enough samples, within SLOs. violation: enough samples, an SLO broken.
   * insufficient_data: fewer than the minimum requests, no verdict. unavailable: the metrics could not be
   * read (old Spec DO, error), no verdict. Only 'violation' can lead to a rollback.
   */
  verdict: 'healthy' | 'violation' | 'insufficient_data' | 'unavailable';
  violations: RollbackTrigger[];
  metrics?: { latencyP95: number | null; errorRate: number | null; requestCount: number };
  detail?: string;
}

// SLO status of all live canaries
export interface SLOStatus {
  healthy: boolean; // no violation (insufficient/unavailable are not "violations", and not a clean bill of health either)
  violations: RollbackTrigger[];
  source: 'shadow' | 'canary';
  windowMinutes: number;
  minRequests: number;
  deployments: DeploymentVerdict[];
}

// Canary deployment record (Spec DO canary_deployments; contract in shared/deploy-refs.ts)
export type { CanaryDeployment } from '../shared/deploy-refs';

// Queue message type
export interface QueueMessage {
  id: string;
  body: unknown;
  timestamp: number;
}

// Environment interface
export interface Env {
  SPEC_DO: DurableObjectNamespace;
  // Tier-1 secret for Spec DO calls (workers/shared/spec-do-auth.ts); no admin token on this worker
  SPEC_DO_INTERNAL_TOKEN?: string;
  PREVIEW_MANAGER: Service;
  ANALYTICS: AnalyticsEngine;
  API_AUTH_TOKEN?: string;
  CANARY_SLO_LATENCY_P95: string;
  CANARY_SLO_ERROR_RATE: string;
  // Optional (SLO loop): defaults 50 requests, 15 minutes, source 'shadow'
  CANARY_SLO_MIN_REQUESTS?: string;
  CANARY_SLO_WINDOW_MINUTES?: string;
  CANARY_SLO_SOURCE?: string;
}
