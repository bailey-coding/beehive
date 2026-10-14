/**
 * Scientist Comparator Worker
 * 
 * Cloudflare Worker that implements the Shadow rung of the oracle ladder.
 * Consumes messages from the beehive-scientist-comparisons queue and performs
 * comparison of candidate responses against baseline using the declared delta surface.
 */

import { authGate } from '../shared/auth';
import type { ScientistEnv, ScientistQueueMessage, Message } from './types';
import { parseDeltaSurface, getDefaultDeltaSurface, matchPath } from './delta-surface';
import {
  normalizeResponse,
  compareStatusCodes,
  compareHeaders,
  compareBodies,
  comparePerformance,
} from './comparison';
import { calculateCandidateScore } from './scoring';
import { SpecDOClient } from './storage/spec-do';
import { AnalyticsClient } from './storage/analytics';
import { Logger, createLogger, withErrorHandling } from './utils';

// Re-export Message type for queue handler
export type { Message };

// ============================================================================
// Constants
// ============================================================================

const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1000, 5000, 10000];
const BATCH_SIZE = 10;
const FLUSH_INTERVAL_MS = 5000;

// ============================================================================
// Worker Implementation
// ============================================================================

const scientistHandler = {
  async fetch(request: Request, env: ScientistEnv, ctx: ExecutionContext): Promise<Response> {
    // Auth gate - fail closed, applies to every route including /health
    const denied = authGate(request, env);
    if (denied) return denied;

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Initialize logger
    const logger = createLogger({ prefix: 'Scientist' });

    // ==========================================================================
    // HEALTH CHECK
    // ==========================================================================

    if (path === '/health' || path === '/api/health') {
      return new Response(JSON.stringify({
        status: 'healthy',
        service: 'scientist-comparator',
        timestamp: Date.now(),
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ==========================================================================
    // METRICS ENDPOINT (for debugging)
    // ==========================================================================

    if (path === '/api/metrics' && method === 'GET') {
      // This would need proper auth and implementation
      return new Response(JSON.stringify({
        error: 'Metrics endpoint not yet implemented',
      }), {
        status: 501,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ==========================================================================
    // 404 for unknown routes
    // ==========================================================================

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  },

  // ==========================================================================
  // QUEUE CONSUMER
  // ==========================================================================

  async queue(batch: MessageBatch<ScientistQueueMessage>, env: ScientistEnv, ctx: ExecutionContext): Promise<void> {
    const logger = createLogger({ prefix: 'Scientist-Queue' });
    
    // Determine which queue this batch came from
    const queueName = batch.queue;
    const isPreview = queueName === 'preview-scientist-comparisons';
    
    logger.info(`[${queueName}] Processing batch of ${batch.messages.length} messages, isPreview=${isPreview}`);

    // Initialize clients
    const specDoClient = new SpecDOClient(env.SPEC_DO);
    const analyticsClient = new AnalyticsClient(
      env.ANALYTICS,
      BATCH_SIZE,
      FLUSH_INTERVAL_MS
    );

    // Process each message in the batch
    const processingPromises = batch.messages.map(async (message) => {
      try {
        logger.debug(`[${queueName}] Processing message ${message.id}`);
        
        // Parse the message body
        const messageBody = parseQueueMessage(message.body);
        if (!messageBody) {
          logger.error(`[${queueName}] Failed to parse message ${message.id}`);
          return;
        }

        // Process the comparison with preview flag
        await processComparison(messageBody, specDoClient, analyticsClient, logger, isPreview, queueName);

        logger.debug(`Completed message ${message.id}`);
      } catch (error) {
        logger.error(`Error processing message ${message.id}: ${error}`);
        // Errors will trigger retry for the message
      }
    });

    // Wait for all messages to be processed
    await Promise.allSettled(processingPromises);

    // Flush any remaining metrics
    analyticsClient.flush();

    // Acknowledge all messages in the batch
    batch.ackAll();

    logger.info(`Batch processing complete`);
  },
};

// Export the handler
export default scientistHandler;

// Type assertion for better type checking
type ScientistExportedHandler<E = unknown> = {
  fetch: (request: Request, env: E, ctx: ExecutionContext) => Promise<Response>;
  queue: (batch: MessageBatch<ScientistQueueMessage>, env: E, ctx: ExecutionContext) => Promise<void>;
};

// This satisfies check ensures our handler matches the expected shape
const _typeCheck: ScientistExportedHandler<ScientistEnv> = scientistHandler;

// ============================================================================
// Message Processing
// ============================================================================

/**
 * Parse a queue message body
 */
function parseQueueMessage(body: unknown): ScientistQueueMessage | null {
  try {
    if (typeof body === 'string') {
      return JSON.parse(body) as ScientistQueueMessage;
    }
    if (typeof body === 'object' && body !== null) {
      return body as ScientistQueueMessage;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Process a single comparison message
 */
async function processComparison(
  message: ScientistQueueMessage,
  specDoClient: SpecDOClient,
  analyticsClient: AnalyticsClient,
  logger: Logger,
  isPreview: boolean = false,
  queueName: string = 'beehive-scientist-comparisons'
): Promise<void> {
  const startTime = Date.now();

  logger.debug(`Starting comparison for request ${message.requestId}`, {
    path: message.path,
    candidates: message.candidates.length,
  });

  // Get declared delta surface for each spec
  // Group candidates by spec for efficiency
  const specs = await getSpecsForCandidates(message.candidates, specDoClient);

  // Process each candidate
  const candidateResults = await Promise.all(
    message.candidates.map(async (candidate) => {
      const specId = candidate.specId;
      const spec = specs.get(specId);
      const deltaSurface = spec ? parseDeltaSurface(spec.declaredDeltaSurface) : getDefaultDeltaSurface();

      return compareCandidate(
        message,
        candidate,
        message.baseline,
        deltaSurface,
        specDoClient,
        logger
      );
    })
  );

  // Calculate aggregate metrics
  const totalCandidates = candidateResults.length;
  const matchedCandidates = candidateResults.filter(r => r.matched).length;
  const averageScore = candidateResults.reduce((sum, r) => sum + r.score, 0) / totalCandidates;

  // Record results in Spec DO
  await specDoClient.recordRequestComparison(message, {
    requestId: message.requestId,
    timestamp: message.timestamp,
    path: message.path,
    method: message.method,
    baseline: message.baseline,
    candidates: candidateResults,
    totalCandidates,
    matchedCandidates,
    averageScore,
    completedAt: Date.now(),
  });

  // Write metrics to Analytics Engine
  for (const result of candidateResults) {
    analyticsClient.writeComparisonEvent(result);
  }
  analyticsClient.writeRequestEvent(message, {
    requestId: message.requestId,
    timestamp: message.timestamp,
    path: message.path,
    method: message.method,
    baseline: message.baseline,
    candidates: candidateResults,
    totalCandidates,
    matchedCandidates,
    averageScore,
    completedAt: Date.now(),
  });

  // Write queue processing metrics
  analyticsClient.writeQueueMetricsEvent({
    queueName: queueName,
    messagesReceived: 1,
    messagesProcessed: 1,
    messagesFailed: 0,
    processingDurationMs: Date.now() - startTime,
    timestamp: Date.now(),
    isPreview: isPreview,
  });

  logger.debug(`Comparison complete for request ${message.requestId}`, {
    totalCandidates,
    matchedCandidates,
    averageScore: averageScore.toFixed(2),
    durationMs: Date.now() - startTime,
  });
}

/**
 * Get specs for all unique spec IDs in the candidates
 */
async function getSpecsForCandidates(
  candidates: Array<{ specId: string }>,
  specDoClient: SpecDOClient
): Promise<Map<string, { id: string; declaredDeltaSurface: string }>> {
  const specIds = new Set(candidates.map(c => c.specId));
  const specs = new Map<string, { id: string; declaredDeltaSurface: string }>();

  for (const specId of specIds) {
    const spec = await specDoClient.getSpec(specId);
    if (spec) {
      specs.set(specId, spec);
    }
  }

  return specs;
}

/**
 * Compare a single candidate against the baseline
 */
async function compareCandidate(
  message: ScientistQueueMessage,
  candidate: { specId: string; candidateId: string; status: number; headers: Record<string, string>; body?: string; latencyMs: number },
  baseline: { status: number; headers: Record<string, string>; body?: string; latencyMs: number },
  deltaSurface: any, // DeltaSurface type
  specDoClient: SpecDOClient,
  logger: Logger
): Promise<import('./types').CandidateComparisonResult> {
  const requestId = message.requestId;
  const candidateId = candidate.candidateId;
  const specId = candidate.specId;
  const path = message.path;
  const method = message.method;
  const timestamp = message.timestamp;

  logger.debug(`Comparing candidate ${candidateId} for spec ${specId}`, { path, method });

  // Normalize responses - use partial objects with required fields
  const baselineWithIds = { ...baseline, candidateId: '', specId: '' };
  const candidateWithIds = { ...candidate, candidateId, specId };
  const normalizedBaseline = normalizeResponse(baselineWithIds);
  const normalizedCandidate = normalizeResponse(candidateWithIds);

  // Get the path-specific configuration from delta surface
  const pathConfig = matchPath(deltaSurface, path);

  // Compare status codes
  const statusComparison = compareStatusCodes(
    baseline.status,
    candidate.status,
    deltaSurface,
    path
  );

  // Compare headers
  const headerComparison = compareHeaders(
    baseline.headers,
    candidate.headers,
    deltaSurface,
    path
  );

  // Compare bodies
  const bodyComparison = compareBodies(
    baseline.body,
    candidate.body,
    deltaSurface,
    path,
    baseline.headers['content-type']
  );

  // Compare performance
  const performanceComparison = comparePerformance(
    baseline.latencyMs,
    candidate.latencyMs,
    deltaSurface,
    path
  );

  // Collect all diffs
  const diffs: Array<import('./types').ComparisonDiff> = [];

  // Add status diffs if not matched
  if (!statusComparison.match) {
    diffs.push({
      type: 'status',
      severity: statusComparison.severity || 'warning',
      message: `Status code mismatch: baseline=${statusComparison.baselineStatus}, candidate=${statusComparison.candidateStatus}`,
      details: {
        baselineStatus: statusComparison.baselineStatus,
        candidateStatus: statusComparison.candidateStatus,
        type: statusComparison.type,
      },
    });
  }

  // Add header diffs
  for (const diff of headerComparison.diffs) {
    diffs.push({
      type: 'header',
      header: diff.header,
      severity: diff.severity,
      message: `Header ${diff.header} differs: baseline="${diff.baselineValue}", candidate="${diff.candidateValue}"`,
      details: {
        baselineValue: diff.baselineValue,
        candidateValue: diff.candidateValue,
        type: diff.type,
      },
    });
  }

  // Add body diffs
  for (const diff of bodyComparison.diffs) {
    diffs.push({
      type: 'body',
      path: diff.path,
      severity: diff.severity,
      message: `Body field ${diff.path || 'root'} differs`,
      details: {
        baselineValue: diff.baselineValue,
        candidateValue: diff.candidateValue,
        type: diff.type,
      },
    });
  }

  // Add performance diffs
  for (const issue of performanceComparison.issues) {
    diffs.push({
      type: 'performance',
      severity: issue.severity,
      message: `${issue.type}: ${issue.type === 'absolute_delta_exceeded' 
        ? `Delta ${issue.deltaMs}ms exceeds threshold ${issue.threshold}ms`
        : `Ratio ${issue.ratio?.toFixed(2)}x exceeds threshold ${issue.threshold}x`}`,
      details: issue as unknown as Record<string, unknown>,
    });
  }

  // Count errors and warnings
  const errors = diffs.filter(d => d.severity === 'error').length;
  const warnings = diffs.filter(d => d.severity === 'warning').length;

  // Calculate score
  const score = calculateCandidateScore({
    requestId,
    candidateId,
    specId,
    path,
    method,
    timestamp,
    statusComparison,
    headerComparison,
    bodyComparison,
    performanceComparison,
    score: 0, // Will be calculated
    matched: false, // Will be calculated
    errors,
    warnings,
    diffs,
  });

  const matched = score >= 80;

  logger.debug(`Candidate ${candidateId} comparison complete`, {
    score,
    matched,
    errors,
    warnings,
  });

  return {
    requestId,
    candidateId,
    specId,
    path,
    method,
    timestamp,
    statusComparison,
    headerComparison,
    bodyComparison,
    performanceComparison,
    score,
    matched,
    errors,
    warnings,
    diffs,
  };
}

// ============================================================================
// Exports
// ============================================================================

export type { ScientistEnv };
export { processComparison };
