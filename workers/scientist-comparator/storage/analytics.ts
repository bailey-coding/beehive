/**
 * Analytics Engine Storage Client
 * 
 * Provides utilities for writing comparison metrics to Analytics Engine.
 */

import type {
  CandidateComparisonResult,
  RequestComparisonResult,
  ScientistQueueMessage,
} from '../types';
import type { AnalyticsEngine } from '../types';

// ============================================================================
// Analytics Engine Client
// ============================================================================

/**
 * Client for writing metrics to Analytics Engine
 */
export class AnalyticsClient {
  private readonly ae: AnalyticsEngine;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private events: Array<{
    indexes: Array<Record<string, string>>;
    blobs: Array<Record<string, string>>;
    doubles: Array<Record<string, number>>;
  }> = [];
  private flushTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(ae: AnalyticsEngine, batchSize: number = 10, flushIntervalMs: number = 5000) {
    this.ae = ae;
    this.batchSize = batchSize;
    this.flushIntervalMs = flushIntervalMs;
  }

  /**
   * Write a comparison metric event
   */
  writeComparisonEvent(result: CandidateComparisonResult): void {
    this.addEvent(this.convertToAEEvent(result));
  }

  /**
   * Write a request comparison event (aggregated across candidates)
   */
  writeRequestEvent(message: ScientistQueueMessage, result: RequestComparisonResult): void {
    this.addEvent(this.convertRequestToAEEvent(message, result));
  }

  /**
   * Write a shadow metrics event
   */
  writeShadowMetricsEvent(
    candidateId: string,
    specId: string,
    metrics: {
      score: number;
      matched: boolean;
      errors: number;
      warnings: number;
      timestamp: number;
    }
  ): void {
    this.addEvent({
      indexes: [
        { eventType: 'shadow_metrics' },
        { candidateId },
        { specId },
      ],
      blobs: [],
      doubles: [
        { score: metrics.score },
        { matched: metrics.matched ? 1 : 0 },
        { errors: metrics.errors },
        { warnings: metrics.warnings },
        { timestamp: metrics.timestamp },
      ],
    });
  }

  /**
   * Write a candidate aggregate metrics event
   */
  writeCandidateMetricsEvent(
    candidateId: string,
    specId: string,
    metrics: {
      averageScore: number;
      matchRate: number;
      totalRequests: number;
      errorRate: number;
      warningRate: number;
      timestamp: number;
    }
  ): void {
    this.addEvent({
      indexes: [
        { eventType: 'candidate_metrics' },
        { candidateId },
        { specId },
      ],
      blobs: [],
      doubles: [
        { averageScore: metrics.averageScore },
        { matchRate: metrics.matchRate },
        { totalRequests: metrics.totalRequests },
        { errorRate: metrics.errorRate },
        { warningRate: metrics.warningRate },
        { timestamp: metrics.timestamp },
      ],
    });
  }

  /**
   * Write queue processing metrics
   */
  writeQueueMetricsEvent(metrics: {
    queueName: string;
    messagesReceived: number;
    messagesProcessed: number;
    messagesFailed: number;
    processingDurationMs: number;
    timestamp: number;
    isPreview?: boolean;
  }): void {
    const doubles: Array<Record<string, number>> = [
      { messagesReceived: metrics.messagesReceived },
      { messagesProcessed: metrics.messagesProcessed },
      { messagesFailed: metrics.messagesFailed },
      { processingDurationMs: metrics.processingDurationMs },
      { timestamp: metrics.timestamp },
    ];
    
    // Add isPreview as a double (0 or 1) if provided
    if (metrics.isPreview !== undefined) {
      doubles.push({ isPreview: metrics.isPreview ? 1 : 0 });
    }
    
    this.addEvent({
      indexes: [
        { eventType: 'queue_metrics' },
        { queueName: metrics.queueName },
      ],
      blobs: [],
      doubles: doubles,
    });
  }

  /**
   * Convert candidate comparison result to AE event
   */
  private convertToAEEvent(result: CandidateComparisonResult): {
    indexes: Array<Record<string, string>>;
    blobs: Array<Record<string, string>>;
    doubles: Array<Record<string, number>>;
  } {
    const indexes: Record<string, string> = {
      eventType: 'shadow_comparison',
      requestId: result.requestId,
      candidateId: result.candidateId,
      specId: result.specId,
      path: result.path,
      method: result.method,
    };

    const blobs: Record<string, string> = {
      diffs: JSON.stringify(result.diffs),
    };

    const doubles: Record<string, number> = {
      score: result.score,
      matched: result.matched ? 1 : 0,
      baselineStatus: result.statusComparison.baselineStatus,
      candidateStatus: result.statusComparison.candidateStatus,
      statusMatch: result.statusComparison.match ? 1 : 0,
      baselineLatencyMs: result.performanceComparison.baselineLatencyMs,
      candidateLatencyMs: result.performanceComparison.candidateLatencyMs,
      latencyDeltaMs: result.performanceComparison.latencyDeltaMs,
      latencyRatio: result.performanceComparison.latencyRatio,
      headersMatch: result.headerComparison.match ? 1 : 0,
      bodyMatch: result.bodyComparison.match ? 1 : 0,
      performanceMatch: result.performanceComparison.match ? 1 : 0,
      errors: result.errors,
      warnings: result.warnings,
      timestamp: result.timestamp,
    };

    return {
      indexes: [indexes],
      blobs: [blobs],
      doubles: [doubles],
    };
  }

  /**
   * Convert request comparison result to AE event
   */
  private convertRequestToAEEvent(
    message: ScientistQueueMessage,
    result: RequestComparisonResult
  ): {
    indexes: Array<Record<string, string>>;
    blobs: Array<Record<string, string>>;
    doubles: Array<Record<string, number>>;
  } {
    const indexes: Record<string, string> = {
      eventType: 'shadow_request',
      requestId: result.requestId,
      path: result.path,
      method: result.method,
    };

    const blobs: Record<string, string> = {};

    const doubles: Record<string, number> = {
      baselineStatus: result.baseline.status,
      baselineLatencyMs: result.baseline.latencyMs,
      totalCandidates: result.totalCandidates,
      matchedCandidates: result.matchedCandidates,
      averageScore: result.averageScore,
      timestamp: result.timestamp,
    };

    return {
      indexes: [indexes],
      blobs: [blobs],
      doubles: [doubles],
    };
  }

  /**
   * Add an event to the batch
   */
  private addEvent(event: {
    indexes: Array<Record<string, string>>;
    blobs: Array<Record<string, string>>;
    doubles: Array<Record<string, number>>;
  }): void {
    this.events.push(event);

    // Flush if batch size reached
    if (this.events.length >= this.batchSize) {
      this.flush();
    }

    // Start flush timeout if not already set
    if (this.flushTimeout === null) {
      this.flushTimeout = setTimeout(() => this.flush(), this.flushIntervalMs);
    }
  }

  /**
   * Flush all buffered events to Analytics Engine
   */
  flush(): void {
    if (this.flushTimeout !== null) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }

    if (this.events.length === 0) {
      return;
    }

    try {
      for (const event of this.events) {
        this.ae.writeDataPoint(event);
      }
      this.events = [];
    } catch (error) {
      console.error('[Analytics] Failed to write metrics:', error);
    }
  }

  /**
   * Manually flush and clear buffer
   */
  clear(): void {
    this.flush();
    this.events = [];
  }

  /**
   * Get the number of buffered events
   */
  getBufferSize(): number {
    return this.events.length;
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Create a metrics collector for a request context
 * Automatically flushes at the end of the request
 */
export function createMetricsCollector(
  ae: AnalyticsEngine,
  batchSize?: number,
  flushIntervalMs?: number
): AnalyticsClient {
  return new AnalyticsClient(ae, batchSize, flushIntervalMs);
}

// ============================================================================
// Exports
// ============================================================================

export type { AnalyticsEngine, CandidateComparisonResult, RequestComparisonResult, ScientistQueueMessage };
