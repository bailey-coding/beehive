/**
 * Cloudflare Analytics Engine client for per-candidate metrics
 * 
 * Writes time-series data for:
 * - Shadow traffic comparisons (Scientist)
 * - Candidate performance metrics
 * - Gate workflow execution stats
 * - Queue processing metrics
 * 
 * Analytics Engine datasets are auto-created on first write.
 */

/**
 * Analytics Engine binding type (from wrangler.toml)
 * This is the interface that Cloudflare Workers provides
 */
export interface AnalyticsEngine {
  writeDataPoint(
    event: {
      indexes: Array<{ [key: string]: string }>;
      blobs: Array<{ [key: string]: string }>;
      doubles: Array<{ [key: string]: number }>;
    }
  ): void;
}

/**
 * Metric event types for Beehive M2
 */
export type MetricEventType = 
  | 'shadow_request'
  | 'shadow_comparison'
  | 'candidate_deploy'
  | 'gate_execution'
  | 'queue_message'
  | 'verdict_recorded';

/**
 * Base metric data structure
 */
export interface MetricData {
  eventType: MetricEventType;
  candidateId?: string;
  specId?: string;
  gate?: string;
  timestamp?: number;
}

/**
 * Shadow traffic metrics (Scientist comparator)
 */
export interface ShadowMetrics {
  candidateId: string;
  specId: string;
  requestId: string;
  path: string;
  method: string;
  baselineStatus: number;
  candidateStatus: number;
  baselineLatencyMs: number;
  candidateLatencyMs: number;
  bodyMatched: boolean;
  headersMatched: boolean;
  declaredDeltaSurface: string;
}

/**
 * Candidate deployment metrics
 */
export interface DeployMetrics {
  candidateId: string;
  specId: string;
  previewUrl: string;
  deployDurationMs: number;
  success: boolean;
  error?: string;
}

/**
 * Gate execution metrics
 */
export interface GateMetrics {
  candidateId: string;
  specId: string;
  gate: string;
  status: 'pass' | 'fail' | 'pending';
  score: number;
  complexityDelta: number;
  executionDurationMs: number;
}

/**
 * Queue processing metrics
 */
export interface QueueMetrics {
  queueName: string;
  messagesReceived: number;
  messagesProcessed: number;
  messagesFailed: number;
  processingDurationMs: number;
  isPreview?: boolean;
}

/**
 * Metrics collector - batches writes for efficiency
 */
export class MetricsCollector {
  private events: Array<{
    indexes: Array<{ [key: string]: string }>;
    blobs: Array<{ [key: string]: string }>;
    doubles: Array<{ [key: string]: number }>;
  }> = [];
  
  private readonly ae: AnalyticsEngine;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private flushTimeout: number | null = null;

  constructor(ae: AnalyticsEngine, batchSize: number = 10, flushIntervalMs: number = 5000) {
    this.ae = ae;
    this.batchSize = batchSize;
    this.flushIntervalMs = flushIntervalMs;
  }

  /**
   * Write shadow traffic comparison metrics
   */
  writeShadowMetrics(metrics: ShadowMetrics): void {
    this.addEvent({
      eventType: 'shadow_request',
      candidateId: metrics.candidateId,
      specId: metrics.specId,
      requestId: metrics.requestId,
      path: metrics.path,
      method: metrics.method,
      baselineStatus: metrics.baselineStatus,
      candidateStatus: metrics.candidateStatus,
      baselineLatencyMs: metrics.baselineLatencyMs,
      candidateLatencyMs: metrics.candidateLatencyMs,
      bodyMatched: metrics.bodyMatched ? 1 : 0,
      headersMatched: metrics.headersMatched ? 1 : 0,
      declaredDeltaSurface: metrics.declaredDeltaSurface,
      // Comparison result
      statusMatch: metrics.baselineStatus === metrics.candidateStatus ? 1 : 0,
      // Performance delta
      latencyDelta: metrics.candidateLatencyMs - metrics.baselineLatencyMs,
    });
  }

  /**
   * Write candidate deployment metrics
   */
  writeDeployMetrics(metrics: DeployMetrics): void {
    this.addEvent({
      eventType: 'candidate_deploy',
      candidateId: metrics.candidateId,
      specId: metrics.specId,
      previewUrl: metrics.previewUrl,
      deployDurationMs: metrics.deployDurationMs,
      success: metrics.success ? 1 : 0,
      error: metrics.error || '',
    });
  }

  /**
   * Write gate execution metrics
   */
  writeGateMetrics(metrics: GateMetrics): void {
    this.addEvent({
      eventType: 'gate_execution',
      candidateId: metrics.candidateId,
      specId: metrics.specId,
      gate: metrics.gate,
      status: metrics.status,
      score: metrics.score,
      complexityDelta: metrics.complexityDelta,
      executionDurationMs: metrics.executionDurationMs,
    });
  }

  /**
   * Write queue processing metrics
   */
  writeQueueMetrics(metrics: QueueMetrics): void {
    const event: MetricData & Record<string, string | number | boolean> = {
      eventType: 'queue_message',
      queueName: metrics.queueName,
      messagesReceived: metrics.messagesReceived,
      messagesProcessed: metrics.messagesProcessed,
      messagesFailed: metrics.messagesFailed,
      processingDurationMs: metrics.processingDurationMs,
    };
    
    // Add isPreview if provided
    if (metrics.isPreview !== undefined) {
      event.isPreview = metrics.isPreview;
    }
    
    this.addEvent(event);
  }

  /**
   * Write verdict recorded metrics
   */
  writeVerdictMetrics(
    candidateId: string,
    specId: string,
    gate: string,
    status: 'pass' | 'fail',
    score: number
  ): void {
    this.addEvent({
      eventType: 'verdict_recorded',
      candidateId,
      specId,
      gate,
      status,
      score,
    });
  }

  /**
   * Add a metric event to the batch
   */
  private addEvent(data: MetricData & Record<string, string | number | boolean>): void {
    const event = this.convertToAEEvent(data);
    this.events.push(event);
    
    // Flush if batch size reached
    if (this.events.length >= this.batchSize) {
      this.flush();
    }
    
    // Start flush timeout if not already set
    if (this.flushTimeout === null) {
      this.flushTimeout = setTimeout(() => this.flush(), this.flushIntervalMs) as unknown as number;
    }
  }

  /**
   * Convert metric data to Analytics Engine event format
   */
  private convertToAEEvent(data: MetricData & Record<string, string | number | boolean>): {
    indexes: Array<{ [key: string]: string }>;
    blobs: Array<{ [key: string]: string }>;
    doubles: Array<{ [key: string]: number }>;
  } {
    const indexes: { [key: string]: string } = {};
    const blobs: { [key: string]: string } = {};
    const doubles: { [key: string]: number } = {};

    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'string') {
        if (value.length <= 64) {
          indexes[key] = value;
        } else {
          blobs[key] = value;
        }
      } else if (typeof value === 'number') {
        doubles[key] = value;
      } else if (typeof value === 'boolean') {
        doubles[key] = value ? 1 : 0;
      }
    }

    // Ensure timestamp is set
    if (!doubles.timestamp) {
      doubles.timestamp = Date.now();
    }

    return {
      indexes: [indexes],
      blobs: [blobs],
      doubles: [doubles],
    };
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
}

/**
 * Singleton metrics collector for the current request/context
 * 
 * Usage:
 *   const metrics = getMetricsCollector();
 *   metrics.writeShadowMetrics({ ... });
 *   // Automatically flushed at end of request or when batch size reached
 */
let globalCollector: MetricsCollector | null = null;

export function getMetricsCollector(ae?: AnalyticsEngine): MetricsCollector {
  if (!globalCollector || ae) {
    if (!ae) {
      throw new Error('Analytics Engine binding required. Pass it to getMetricsCollector.');
    }
    globalCollector = new MetricsCollector(ae);
  }
  return globalCollector;
}

export function resetMetricsCollector(): void {
  if (globalCollector) {
    globalCollector.flush();
    globalCollector = null;
  }
}
