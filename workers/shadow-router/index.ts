/**
 * Shadow Router Worker
 * 
 * Implements traffic mirroring for M2 Empirical Oracle and M3 Statsig Traffic Splitting:
 * - Receives production traffic (mirrored from edge)
 * - Fans out to candidate Workers (Workers Builds Previews)
 * - Uses Statsig traffic splitting to allocate traffic to canary/holdout/baseline groups
 * - Discards all candidate responses
 * - Triggers Scientist comparator asynchronously
 * - Writes metrics to Analytics Engine
 */

import { authGate } from '../shared/auth';
import { MetricsCollector } from '../shared/analytics';
import type { Queue } from '../scientist-comparator/types';
import type { AnalyticsEngine } from '../shared/analytics';

// Import Statsig types and config
import type { TrafficSplitConfig, RequestClassification, ShadowConfig } from './types';
import { 
  DEFAULT_STATSIG_CONFIG, 
  STATSIG_PRESETS,
  getLocalDevShadowConfig,
  getProductionShadowConfig,
  normalizeTrafficSplitConfig,
  applyCanaryRefs
} from './config';
import type { SpecDoFetcher } from '../shared/deploy-refs';

// Type for the Analytics Engine binding
declare const ANALYTICS: AnalyticsEngine;

// Type for the Scientist Comparator Queue bindings
declare const SCIENTIST_QUEUE: Queue;
declare const PREVIEW_SCIENTIST_QUEUE: Queue;

// Configuration
export type { ShadowConfig } from './types';
export type { TrafficSplitConfig, RequestClassification } from './types';

/**
 * Get shadow configuration based on environment
 * In production: uses production URLs
 * In local dev: uses localhost URLs with worker ports
 * Includes Statsig traffic splitting configuration
 */
async function getShadowConfig(env: any): Promise<ShadowConfig> {
  // Detect if we're in local development
  const isLocal = env.SPEC_DO?.id?.includes('local') || 
                 process.env.WRANGLER_ENV === 'development' ||
                 process.env.NODE_ENV === 'development';

  // Production uses production worker URLs; either way the canary targets
  // come from the Spec DO deploy refs (the traffic pointer)
  const base = isLocal ? getLocalDevShadowConfig() : getProductionShadowConfig();
  return applyCanaryRefs(base, specDoFetcher(env));
}

function specDoFetcher(env: any): SpecDoFetcher | null {
  if (typeof env.SPEC_DO?.idFromName !== 'function') return null;
  const stub = env.SPEC_DO.get(env.SPEC_DO.idFromName('main'));
  return { fetch: (path, init) => stub.fetch(`https://spec-do.internal${path}`, init) };
}

/**
 * Classify incoming request based on Statsig traffic splitting
 * Determines if request should go to canary, holdout, baseline, or shadow
 * 
 * Traffic is split according to the configured percentages:
 * - canaryPercentage: traffic routed to canary candidate
 * - holdoutPercentage: traffic routed to holdout group (production baseline comparison)
 * - baselinePercentage: traffic routed to baseline group
 * 
 * @param request - The incoming request to classify
 * @param config - Shadow Router configuration
 * @param candidateId - Optional candidate ID for per-candidate splitting
 * @returns RequestClassification with the determined traffic group
 */
function classifyRequest(
  request: Request,
  config: ShadowConfig,
  candidateId?: string
): RequestClassification {
  // If Statsig is disabled, use existing shadow behavior
  if (!config.statsig?.enabled) {
    return { type: 'shadow', weight: 1.0 };
  }

  // Get split config for this spec/candidate
  const splitConfig = candidateId && config.statsig.splits[candidateId]
    ? normalizeTrafficSplitConfig(config.statsig.splits[candidateId])
    : normalizeTrafficSplitConfig(config.statsig.defaultSplit);

  // Generate random number for this request (deterministic based on request for consistency)
  // Use a combination of request URL, method, and timestamp for the random seed
  // This ensures the same request gets the same classification in retries
  const requestIdentifier = `${request.method}:${request.url}`;
  let hash = 0;
  for (let i = 0; i < requestIdentifier.length; i++) {
    const char = requestIdentifier.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  const randomValue = Math.abs(hash) % 10000 / 10000; // Normalize to 0-1

  // Determine classification based on percentages
  // First check: canary group (0 to canaryPercentage)
  if (randomValue < splitConfig.canaryPercentage / 100) {
    return { type: 'canary', candidateId, weight: splitConfig.canaryPercentage / 100 };
  }

  // Second check: holdout group (canaryPercentage to canary+holdout)
  const canaryEnd = splitConfig.canaryPercentage / 100;
  const holdoutEnd = canaryEnd + splitConfig.holdoutPercentage / 100;
  
  if (randomValue >= canaryEnd && randomValue < holdoutEnd) {
    return { type: 'holdout', weight: splitConfig.holdoutPercentage / 100 };
  }

  // Remaining traffic: baseline group
  return { type: 'baseline', weight: splitConfig.baselinePercentage / 100 };
}

/**
 * Log traffic split classification to Analytics Engine
 * 
 * @param classification - The classification result
 * @param candidateId - Optional candidate ID
 * @param metrics - Metrics collector instance
 */
async function logTrafficSplit(
  classification: RequestClassification,
  candidateId: string | undefined,
  metrics: MetricsCollector | null,
  env: any
): Promise<void> {
  // Write to Analytics Engine if metrics available
  if (metrics) {
    // Write traffic split classification metric
    metrics.writeShadowMetrics({
      candidateId: candidateId || 'none',
      specId: '', // TODO: Get from Spec DO
      requestId: crypto.randomUUID(),
      path: '/statsig/classification',
      method: 'INTERNAL',
      baselineStatus: 0,
      candidateStatus: 0,
      baselineLatencyMs: 0,
      candidateLatencyMs: 0,
      bodyMatched: false,
      headersMatched: false,
      declaredDeltaSurface: `traffic_split_${classification.type}`,
    });
  } else {
    // Log to console in local dev
    console.log(`[Statsig] Classification: ${classification.type}`, {
      candidateId: candidateId || 'none',
      weight: classification.weight,
    });
  }

  // Also write directly to Analytics Engine binding if available
  const aeBinding = env.ANALYTICS || (typeof ANALYTICS !== 'undefined' ? ANALYTICS : null);
  if (aeBinding) {
    try {
      await aeBinding.writeDataPoint({
        indexes: [{
          classification: classification.type,
          candidateId: candidateId || 'none',
          timestamp: Date.now().toString(),
        }],
        blobs: [`traffic_split_${classification.type}`],
        doubles: [classification.weight],
      });
    } catch (error) {
      console.error('[Statsig] Failed to write traffic split metric:', error);
    }
  }
}

/**
 * Check if path should be mirrored
 * Enhanced to respect Statsig configuration
 */
function shouldMirror(path: string, config: ShadowConfig): boolean {
  // Check excludes first
  for (const exclude of config.excludePaths) {
    if (path === exclude || path.startsWith(exclude + '/')) {
      return false;
    }
  }
  
  // Check includes
  if (config.mirrorPaths.includes('*')) {
    return true;
  }
  
  for (const mirror of config.mirrorPaths) {
    if (path === mirror || path.startsWith(mirror + '/')) {
      return true;
    }
  }
  
  return false;
}

/**
 * Fan out request to candidate previews with Statsig classification
 * Only sends requests to candidates that match the classification
 * 
 * @param request - The incoming request to fan out
 * @param config - Shadow Router configuration
 * @param metrics - Metrics collector for logging
 * @returns Array of results from candidate fetches
 */
async function fanOutToCandidates(
  request: Request,
  config: ShadowConfig,
  metrics: MetricsCollector | null,
  env: any
): Promise<Array<{ candidateId: string; response: Response; latencyMs: number; classification: RequestClassification }>> {
  const results: Array<{ candidateId: string; response: Response; latencyMs: number; classification: RequestClassification }> = [];
  
  if (config.candidatePreviews.size === 0) {
    console.log('[Shadow] No candidates configured for mirroring');
    return results;
  }
  
  console.log(`[Shadow] Mirroring to ${config.candidatePreviews.size} candidates with Statsig classification`);

  const requestId = crypto.randomUUID();
  const startTime = Date.now();
  
  // Create promises for all candidate fetches
  const promises: Array<Promise<{ candidateId: string; response: Response; latencyMs: number; classification: RequestClassification }>> = [];
  
  for (const [candidateId, previewUrl] of config.candidatePreviews) {
    // Classify this request for this candidate
    const classification = classifyRequest(request, config, candidateId);
    
    // Log the classification
    await logTrafficSplit(classification, candidateId, metrics, env);
    
    // Only send to candidate if classified as canary or shadow (not holdout or baseline)
    // Canary: send to this specific candidate
    // Shadow: send to all candidates (legacy behavior)
    // Holdout: don't send to any candidate (production baseline only)
    // Baseline: don't send to candidates (production only)
    const shouldSendToCandidate = classification.type === 'canary' || classification.type === 'shadow';
    
    if (!shouldSendToCandidate) {
      console.log(`[Shadow] Skipping candidate ${candidateId} - classified as ${classification.type}`);
      continue;
    }
    
    const promise = fetchCandidate(request, previewUrl, candidateId, requestId)
      .then((result) => {
        // Write metrics for this candidate request (if metrics available)
        if (metrics) {
          metrics.writeShadowMetrics({
            candidateId,
            specId: '', // TODO: Get from config
            requestId,
            path: new URL(request.url).pathname,
            method: request.method,
            baselineStatus: 0, // Will be updated by Scientist
            candidateStatus: result.response.status,
            baselineLatencyMs: 0, // Will be updated by Scientist
            candidateLatencyMs: result.latencyMs,
            bodyMatched: false, // Will be updated by Scientist
            headersMatched: false, // Will be updated by Scientist
            declaredDeltaSurface: `statsig_${classification.type}`,
          });
        } else {
          // Log to console in local dev
          console.log(`[Shadow] Candidate ${candidateId}: status=${result.response.status}, latency=${result.latencyMs}ms, classification=${classification.type}`);
        }
        return { ...result, classification };
      });
    promises.push(promise);
  }
  
  // Wait for all candidates to respond
  const settled = await Promise.allSettled(promises);
  
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      results.push(result.value);
    }
  }
  
  return results;
}

/**
 * Fetch a candidate Worker
 */
async function fetchCandidate(
  request: Request,
  previewUrl: string,
  candidateId: string,
  requestId: string
): Promise<{ candidateId: string; response: Response; latencyMs: number }> {
  const startTime = Date.now();
  
  // Build the candidate URL
  const url = new URL(request.url);
  const candidateUrl = `${previewUrl}${url.pathname}${url.search}`;
  
  // Clone request for candidate with absolute URL
  const candidateRequest = new Request(candidateUrl, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });
  
  try {
    console.log(`[Shadow] Fetching candidate ${candidateId} at ${candidateUrl}`);
    const response = await fetch(candidateUrl, candidateRequest);
    const latencyMs = Date.now() - startTime;
    
    return { candidateId, response, latencyMs };
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    console.error(`[Shadow] Candidate fetch failed for ${candidateId}:`, error);
    // Return error response
    return {
      candidateId,
      response: new Response(JSON.stringify({ error: 'Candidate fetch failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
      latencyMs,
    };
  }
}

/**
 * Scientist Queue Message type
 */
interface ScientistQueueMessage {
  requestId: string;
  timestamp: number;
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  isPreview?: boolean;
  baseline: {
    candidateId: string;
    specId: string;
    status: number;
    headers: Record<string, string>;
    body?: string;
    latencyMs: number;
  };
  candidates: Array<{
    candidateId: string;
    specId: string;
    status: number;
    headers: Record<string, string>;
    body?: string;
    latencyMs: number;
    previewUrl?: string;
    isPreview?: boolean;
    classification?: string;
  }>;
}

/**
 * Trigger Scientist comparison by sending to the Scientist Queue
 * Enhanced with Statsig classification information
 */
async function triggerScientist(
  request: Request,
  candidateResponses: Array<{ candidateId: string; response: Response; latencyMs: number; classification: RequestClassification }>,
  metrics: MetricsCollector | null,
  env: any
): Promise<void> {
  if (candidateResponses.length === 0) {
    return;
  }

  const requestId = crypto.randomUUID();
  const timestamp = Date.now();
  const url = new URL(request.url);
  
  // Extract request body if present
  let requestBody: string | undefined;
  try {
    if (request.body) {
      requestBody = await request.clone().text();
    }
  } catch {
    requestBody = undefined;
  }

  // Get baseline response from production
  // For now, we'll use a stub - in production this would be the actual production response
  // For shadow traffic, we need to capture this.
  const baseline: ScientistQueueMessage['baseline'] = {
    candidateId: 'production',
    specId: candidateResponses[0].candidateId,
    status: 200, // Placeholder
    headers: { 'content-type': 'application/json' },
    latencyMs: 50, // Placeholder
  };

  // Prepare candidate data with classification information
  const candidates: ScientistQueueMessage['candidates'] = candidateResponses.map(r => ({
    candidateId: r.candidateId,
    specId: '', // TODO: Get from Spec DO or config
    status: r.response.status,
    headers: Object.fromEntries(r.response.headers.entries()),
    body: undefined, // TODO: Read response body
    latencyMs: r.latencyMs,
    classification: r.classification.type,
    classificationWeight: r.classification.weight,
  }));

  // Create the queue message
  const queueMessage: ScientistQueueMessage = {
    requestId,
    timestamp,
    path: url.pathname,
    method: request.method,
    headers: Object.fromEntries(request.headers.entries()),
    body: requestBody,
    baseline,
    candidates,
  };
  
  try {
    // Determine if any candidate is a preview candidate
    const hasPreviewCandidate = candidateResponses.some(r => 
      r.candidateId.startsWith('preview-') || r.candidateId.includes('-preview')
    );
    
    // Select the appropriate queue
    const queueName = hasPreviewCandidate ? 'preview-scientist-comparisons' : 'beehive-scientist-comparisons';
    const scientistQueue = hasPreviewCandidate 
      ? (env.PREVIEW_SCIENTIST_QUEUE || (typeof PREVIEW_SCIENTIST_QUEUE !== 'undefined' ? PREVIEW_SCIENTIST_QUEUE : null))
      : (env.SCIENTIST_QUEUE || (typeof SCIENTIST_QUEUE !== 'undefined' ? SCIENTIST_QUEUE : null));
    
    // Update queue message with preview flag
    const finalQueueMessage: ScientistQueueMessage = {
      ...queueMessage,
      isPreview: hasPreviewCandidate,
      candidates: queueMessage.candidates.map(c => ({
        ...c,
        isPreview: hasPreviewCandidate,
      })),
    };
    
    if (scientistQueue) {
      // Send to appropriate Scientist Queue
      await scientistQueue.send(finalQueueMessage);
      console.log(`[Shadow] Scientist comparison queued for request ${requestId} (queue: ${queueName})`);
      
      // Write queue metric for Scientist (if metrics available)
      if (metrics) {
        metrics.writeQueueMetrics({
          queueName: queueName,
          messagesReceived: 1,
          messagesProcessed: 0,
          messagesFailed: 0,
          processingDurationMs: 0,
          isPreview: hasPreviewCandidate,
        });
      }
    } else {
      // Queue binding not available - log for debugging
      console.log(`[Shadow] Scientist Queue binding for ${queueName} not available - comparison skipped`);
      console.log('[Shadow] Queue message would have been:', JSON.stringify(finalQueueMessage, null, 2));
    }
  } catch (error) {
    const queueName = 'unknown';
    console.error('[Shadow] Failed to send to Scientist Queue:', error);
    if (metrics) {
      metrics.writeQueueMetrics({
        queueName: queueName,
        messagesReceived: 1,
        messagesProcessed: 0,
        messagesFailed: 1,
        processingDurationMs: 0,
      });
    }
  }
}

/**
 * Request handler
 */
export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
    // Auth gate - fail closed, applies to every route including /health
    const denied = authGate(request, env);
    if (denied) return denied;

    const url = new URL(request.url);
    
    // ========================================================================
    // Statsig Configuration API Endpoints
    // ========================================================================
    
    // GET /statsig/config - Get current Statsig configuration
    if (url.pathname === '/statsig/config' && request.method === 'GET') {
      const config = await getShadowConfig(env);
      return new Response(JSON.stringify(config.statsig), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // POST /statsig/config - Update Statsig configuration
    if (url.pathname === '/statsig/config' && request.method === 'POST') {
      const body = await request.json();
      const currentConfig = await getShadowConfig(env);
      
      // Merge the new configuration (create a new object since config is const)
      const bodyObj = body as Record<string, unknown>;
      const updatedStatsig = {
        ...currentConfig.statsig,
        ...bodyObj,
      };
      
      // Normalize any traffic split configs
      const normalizedStatsig = { ...updatedStatsig };
      if (updatedStatsig.splits) {
        normalizedStatsig.splits = {};
        for (const key in updatedStatsig.splits) {
          normalizedStatsig.splits[key] = normalizeTrafficSplitConfig(updatedStatsig.splits[key]);
        }
      }
      if (updatedStatsig.defaultSplit) {
        normalizedStatsig.defaultSplit = normalizeTrafficSplitConfig(updatedStatsig.defaultSplit);
      }
      
      return new Response(JSON.stringify(normalizedStatsig), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // GET /statsig/presets - List all available presets
    if (url.pathname === '/statsig/presets' && request.method === 'GET') {
      return new Response(JSON.stringify(STATSIG_PRESETS), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // GET /statsig/preset/{name} - Get a specific preset
    const presetMatch = url.pathname.match(/\/statsig\/preset\/(\w+)/);
    if (presetMatch) {
      const presetName = presetMatch[1];
      const preset = STATSIG_PRESETS[presetName];
      
      if (!preset) {
        return new Response(JSON.stringify({ error: 'Preset not found', available: Object.keys(STATSIG_PRESETS) }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      return new Response(JSON.stringify(preset), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // POST /statsig/classify - Classify a request (for testing)
    if (url.pathname === '/statsig/classify' && request.method === 'POST') {
      const config = await getShadowConfig(env);
      const body = await request.json();
      const candidateId = (body as any).candidateId as string | undefined;
      const path = (body as any).path as string | undefined;
      const method = (body as any).method as string | undefined;
      
      // Create a mock request for classification
      const mockRequest = new Request(`https://example.com${path || ''}`, { method: method || 'GET' });
      const classification = classifyRequest(mockRequest, config, candidateId);
      
      return new Response(JSON.stringify(classification), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // GET /statsig/classify - Classify current request (for testing)
    if (url.pathname === '/statsig/classify' && request.method === 'GET') {
      const config = await getShadowConfig(env);
      const classification = classifyRequest(request, config);
      
      return new Response(JSON.stringify(classification), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    
    // ========================================================================
    // Standard Endpoints
    // ========================================================================

    // Health check
    if (url.pathname === '/health' || url.pathname === '/api/health') {
      return new Response(JSON.stringify({ 
        status: 'healthy', 
        service: 'shadow-router',
        statsig: { enabled: true, version: 'M3' }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Get configuration based on environment
    const config = await getShadowConfig(env);
    
    // Check if we should mirror this request
    if (!shouldMirror(url.pathname, config)) {
      // Not a path we mirror - return empty response (discarded anyway)
      return new Response(null, { status: 200 });
    }

    // Sample check
    if (Math.random() > config.sampleRate) {
      // Skipped due to sampling
      return new Response(null, { status: 200 });
    }

    // Initialize metrics collector
    const aeBinding = env.ANALYTICS || (typeof ANALYTICS !== 'undefined' ? ANALYTICS : null);
    const metrics = aeBinding ? new MetricsCollector(aeBinding) : null;

    // Classify this request using Statsig
    const classification = classifyRequest(request, config);
    
    // Log the classification
    if (config.statsig?.enabled) {
      await logTrafficSplit(classification, undefined, metrics, env);
    }
    
    // Only fan out to candidates if not holdout or baseline (which go to production only)
    // Canary and shadow classifications get fanned out to candidates
    const shouldFanOut = classification.type === 'canary' || classification.type === 'shadow';
    
    if (shouldFanOut) {
      // Fan out to candidates with classification
      const candidateResponses = await fanOutToCandidates(request, config, metrics, env);
      
      // Trigger Scientist comparison (async - don't wait)
      if (metrics) {
        ctx.waitUntil(triggerScientist(request, candidateResponses, metrics, env));
        // Flush metrics before returning
        metrics.flush();
      } else {
        console.log('[Shadow] Analytics Engine not available in local dev - metrics logged to console');
        ctx.waitUntil(triggerScientist(request, candidateResponses, null, env));
      }
    } else {
      // Holdout or baseline - don't fan out, just trigger Scientist with empty candidates
      if (config.statsig?.enabled) {
        console.log(`[Shadow] Request classified as ${classification.type} - skipping fan-out`);
      }
      
      // Still trigger Scientist for comparison tracking
      ctx.waitUntil(triggerScientist(request, [], metrics, env));
      if (metrics) {
        metrics.flush();
      }
    }
    
    // Discard all candidate responses - return empty
    // The actual response comes from the production Worker, not the shadow
    return new Response(null, { status: 200 });
  },
};
