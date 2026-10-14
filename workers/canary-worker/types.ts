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
  rollbackThreshold: {
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

// SLO status
export interface SLOStatus {
  healthy: boolean;
  violations: RollbackTrigger[];
  currentMetrics: {
    latencyP95: number;
    errorRate: number;
    requestCount: number;
  };
}

// Canary deployment result
export interface CanaryDeployment {
  id: string;
  candidateId: string;
  specId: string;
  status: 'deploying' | 'active' | 'rolling_back' | 'rolled_back' | 'failed';
  url: string;
  createdAt: string;
  updatedAt: string;
}

// Queue message type
export interface QueueMessage {
  id: string;
  body: unknown;
  timestamp: number;
}

// Environment interface
export interface Env {
  SPEC_DO: DurableObjectNamespace;
  PREVIEW_MANAGER: Service;
  ANALYTICS: AnalyticsEngine;
  API_AUTH_TOKEN?: string;
  CANARY_SLO_LATENCY_P95: string;
  CANARY_SLO_ERROR_RATE: string;
}
