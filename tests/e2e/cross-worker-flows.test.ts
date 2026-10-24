/**
 * Cross-Worker Flow E2E Tests
 * 
 * Tests the complete workflow across all M3 workers:
 * Shadow Router -> Canary Worker -> Promotion Worker
 * 
 * Phase: 4
 * Task: test-phase-4-cross-worker
 * Spec: Testing
 * Confidence: 1.0
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  getConfig,
  validateProductionConfig,
  getTimeout,
  getRetries,
} from './config';
import { createRequest, readJson, fetchWithRetry, createTestContext } from './helpers';
import { WorkerType } from './auth';

// Re-export types from m3-features.test.ts for consistency
type RequestClassification = {
  type: 'canary' | 'holdout' | 'baseline' | 'shadow';
  candidateId?: string;
  weight: number;
};

type CanaryDeployment = {
  id: string;
  candidateId: string;
  specId: string;
  status: 'deployed' | 'superseded' | 'rolled_back';
  url: string;
  trafficPercentage: number;
  createdAt: string;
  updatedAt: string;
};

type CanaryMetrics = {
  requestCount: number;
  errorCount: number;
  latencyP95: number;
  errorRate: number;
  sloCompliance: boolean;
};

type MergeTrainCar = {
  candidateId: string;
  position: number;
  status: 'queued' | 'running' | 'promoted' | 'dropped';
};

/**
 * Create an authenticated fetch for a specific worker
 */
async function fetchWorker(
  path: string,
  method: string = 'GET',
  body?: unknown,
  workerType: WorkerType = 'base'
): Promise<Response> {
  return fetchWithRetry(path, method, body, workerType);
}

/**
 * Shadow Router API helpers
 */
async function getShadowConfig(): Promise<any> {
  // Changed from /shadow/config to /statsig/config to match actual worker routes
  const response = await fetchWorker('/statsig/config', 'GET', undefined, 'shadow');
  return readJson(response);
}

async function classifyRequest(requestId: string, candidateId: string, specId: string): Promise<RequestClassification> {
  // Changed from /shadow/classify to /statsig/classify to match actual worker routes
  const response = await fetchWorker(
    '/statsig/classify',
    'POST',
    { requestId, candidateId, specId, path: '/test', method: 'GET' },
    'shadow'
  );
  // Worker returns the classification itself ({ type, weight, ... }), not wrapped
  return readJson(response) as Promise<RequestClassification>;
}

/**
 * Canary Worker API helpers
 */
async function deployCanary(
  candidateId: string,
  specId: string,
  trafficPercentage: number,
  holdoutPercentage: number = 5
): Promise<{ deployment: CanaryDeployment }> {
  // Changed from /canary/deploy to /deploy-canary to match actual worker routes
  const response = await fetchWorker(
    '/deploy-canary',
    'POST',
    { candidateId, specId, trafficPercentage, holdoutPercentage },
    'canary'
  );
  return readJson(response) as Promise<{ deployment: CanaryDeployment }>;
}

async function getDeployment(deploymentId: string): Promise<{ deployment: CanaryDeployment & { metrics?: CanaryMetrics } }> {
  // Changed from /canary/deployments/:id to /canary-deployments/:id to match actual worker routes
  const response = await fetchWorker(`/canary-deployments/${deploymentId}`, 'GET', undefined, 'canary');
  return readJson(response);
}

// Rollback is a Spec DO deploy-ref move: the spec's canary ref goes back to its previous target
async function rollbackCanary(candidateId: string, specId: string): Promise<{ success?: boolean; deployment: CanaryDeployment; deployRef: { candidateId: string | null; action: string } }> {
  const response = await fetchWorker(
    '/rollback',
    'POST',
    { candidateId, specId, reason: 'manual', timestamp: new Date().toISOString(), metrics: {} },
    'canary'
  );
  expect(response.status).toBe(200);
  return readJson(response) as Promise<{ success?: boolean; deployment: CanaryDeployment; deployRef: { candidateId: string | null; action: string } }>;
}

type SloStatus = {
  healthy: boolean;
  violations: unknown[];
  source: 'shadow' | 'canary';
  windowMinutes: number;
  minRequests: number;
  deployments: { deploymentId: string; verdict: string; metrics?: { latencyP95: number | null; errorRate: number | null; requestCount: number } }[];
};

async function getSloMetrics(): Promise<SloStatus> {
  // Changed from /canary/slo/metrics to /slo-status to match actual worker routes
  const response = await fetchWorker('/slo-status', 'GET', undefined, 'canary');
  return readJson(response) as Promise<SloStatus>;
}

// REMOVED: getSloConfig - no equivalent route exists in canary worker
// async function getSloConfig(): Promise<{ config: { latencyP95: number; errorRate: number } }> {
//   const response = await fetchWorker('/canary/slo/config', 'GET', undefined, 'canary');
//   return readJson(response);
// }

/**
 * Promotion Worker API helpers
 */
async function getPromotionHealth(): Promise<{ status: string; mode: string }> {
  // Route /promotion/health exists in promotion worker
  const response = await fetchWorker('/promotion/health', 'GET', undefined, 'promotion');
  return readJson(response) as Promise<{ status: string; mode: string }>;
}

async function getPromotionMode(): Promise<{ mode: 'tournament' | 'merge-train' }> {
  // Changed from /promotion/mode to /mode to match actual worker routes
  const response = await fetchWorker('/mode', 'GET', undefined, 'promotion');
  return readJson(response) as Promise<{ mode: 'tournament' | 'merge-train' }>;
}

async function setPromotionMode(mode: 'tournament' | 'merge-train'): Promise<{ success: boolean; mode: string }> {
  // Changed from /promotion/mode to /mode to match actual worker routes.
  // The worker answers { success, mode, message }; there is no `newMode` field.
  const response = await fetchWorker('/mode', 'POST', { mode }, 'promotion');
  return readJson(response) as Promise<{ success: boolean; mode: string }>;
}

async function promoteCandidate(
  candidateId: string,
  specId: string,
  fromRung: string,
  toRung: string,
  actorId: string = 'e2e-test-agent'
): Promise<{ success: boolean; promotionId: string; fromRung: string; toRung: string }> {
  // Changed from /promotion/candidates/promote to /promote to match actual worker routes
  const response = await fetchWorker(
    '/promote',
    'POST',
    { candidateId, specId, fromRung, toRung, actorId },
    'promotion'
  );
  return readJson(response);
}

async function getCandidateStatus(candidateId: string): Promise<{
  success: boolean;
  candidateId: string;
  currentRung: string;
  status: string;
  lastPromotion?: any;
}> {
  // Changed from /promotion/candidates/:id/status to /promote/:id to match actual worker routes.
  // The worker nests the latest promotion under `state`; flatten it so tests read
  // `currentRung` / `status` directly. A candidate with no promotion answers
  // { status: 'not_started' } and no `state`.
  const response = await fetchWorker(`/promote/${candidateId}`, 'GET', undefined, 'promotion');
  const body = (await readJson(response)) as {
    success: boolean;
    candidateId: string;
    status?: string;
    state?: { currentRung: string; status: string };
  };
  return {
    success: body.success,
    candidateId: body.candidateId,
    currentRung: body.state?.currentRung as string,
    status: (body.state?.status ?? body.status) as string,
    lastPromotion: body.state,
  };
}

// REMOVED: startMergeTrain - no equivalent route exists in promotion worker
// Promotion trains are joined implicitly through POST /promote, not started via a separate endpoint
// async function startMergeTrain(...)

// REMOVED: getMergeTrain - no equivalent route exists in promotion worker
// async function getMergeTrain(...)

// REMOVED: startTournament - no equivalent route exists in promotion worker
// Tournaments are joined implicitly through POST /promote, not started via a separate endpoint
// async function startTournament(...)

// ============================================================================
// Test Suites
// ============================================================================

describe('Cross-Worker Flow Tests', () => {
  let ctx: ReturnType<typeof createTestContext>;

  beforeAll(() => {
    const config = getConfig();
    
    // Validate environment if running production tests
    if (config.environment === 'production') {
      validateProductionConfig(config);
    }
    
    // Create test context with unique IDs
    ctx = createTestContext();
  });

  beforeEach(() => {
    // Reset context for each test
    ctx = createTestContext();
  });

  // ==========================================================================
  // Health Check Tests
  // ==========================================================================

  describe('Worker Health Checks', () => {
    it('should verify all worker health checks in production', async () => {
      const config = getConfig();
      
      // Skip for local environment - workers may not be running
      if (config.environment === 'local') {
        console.log('Skipping health check tests for local environment');
        return;
      }

      // Shadow Router health
      const shadowResponse = await fetchWorker('/health', 'GET', undefined, 'shadow');
      expect(shadowResponse.status).toBe(200);
      const shadowHealth = await readJson(shadowResponse);
      expect(shadowHealth.status).toBe('healthy');
      expect(shadowHealth.statsig?.enabled).toBe(true);

      // Canary Worker health
      const canaryResponse = await fetchWorker('/health', 'GET', undefined, 'canary');
      expect(canaryResponse.status).toBe(200);
      const canaryHealth = await readJson(canaryResponse);
      expect(canaryHealth.status).toBe('healthy');

      // Promotion Worker health
      const promotionResponse = await fetchWorker('/promotion/health', 'GET', undefined, 'promotion');
      expect(promotionResponse.status).toBe(200);
      const promotionHealth = await readJson(promotionResponse);
      expect(promotionHealth.status).toBe('healthy');
      expect(promotionHealth.mode).toBeDefined();
    });
  });

  // ==========================================================================
  // Statsig Traffic Splitting Flow
  // ==========================================================================

  describe('Statsig Traffic Splitting Flow', () => {
    it('should get Statsig configuration and verify defaults', async () => {
      const config = getConfig();
      
      // Skip for local if mocks are being used
      if (config.environment === 'local') {
        console.log('Note: Using mocks for local environment');
      }

      // /statsig/config returns the config object directly (no success/config wrapper)
      const configData = await getShadowConfig();
      
      expect(configData.enabled).toBe(true);
      
      // Check default split
      const defaultSplit = configData.defaultSplit;
      expect(defaultSplit).toBeDefined();
      expect(defaultSplit.canaryPercentage).toBeDefined();
      expect(defaultSplit.holdoutPercentage).toBeDefined();
      expect(defaultSplit.baselinePercentage).toBeDefined();
      
      // Verify percentages sum to 100
      const total = defaultSplit.canaryPercentage + 
                    defaultSplit.holdoutPercentage + 
                    defaultSplit.baselinePercentage;
      expect(total).toBe(100);
    });

    it('should classify requests with Statsig configuration', async () => {
      const response = await classifyRequest(ctx.candidateId, ctx.candidateId, ctx.specId);
      
      expect(['canary', 'holdout', 'baseline', 'shadow']).toContain(response.type);
      
      // If Statsig is enabled, we should get a valid classification
      // Note: The actual classification depends on the worker's Statsig config
    });

    it('should have consistent Statsig configuration across requests', async () => {
      // Get config twice
      const config1 = await getShadowConfig();
      const config2 = await getShadowConfig();
      
      // Both should have the same structure
      expect(config1.enabled).toBe(config2.enabled);
      expect(config1.defaultSplit).toEqual(config2.defaultSplit);
    });
  });

  // ==========================================================================
  // Canary Deployment Flow
  // ==========================================================================

  describe('Canary Deployment Flow', () => {
    let deploymentId: string;

    it('should deploy a canary with valid configuration', async () => {
      const result = await deployCanary(
        ctx.candidateId,
        ctx.specId,
        10,
        5
      );

      expect(result.deployment).toBeDefined();
      const deployment = result.deployment;
      
      expect(deployment.id).toBeDefined();
      expect(deployment.candidateId).toBe(ctx.candidateId);
      expect(deployment.specId).toBe(ctx.specId);
      expect(deployment.status).toBe('deployed');
      expect(deployment.trafficPercentage).toBe(10);
      expect(deployment.url).toBeDefined();
      
      deploymentId = deployment.id;
    });

    it('should get canary deployment status', async () => {
      // First deploy
      const deployResult = await deployCanary(
        ctx.candidateId,
        ctx.specId,
        10
      );
      const deploymentId = deployResult.deployment.id;

      // Then check status
      const statusResult = await getDeployment(deploymentId);
      
      expect(statusResult.deployment).toBeDefined();
      expect(statusResult.deployment.id).toBe(deploymentId);
      expect(statusResult.deployment.status).toBe('deployed');
    });

  // ==========================================================================
  // REMOVED: SLO Configuration Test
  // ==========================================================================
  // getSloConfig was removed because there's no /canary/slo/config route
  // in the canary worker. The test was testing a route that doesn't exist.
  
  // SLO metrics test remains below, now using /slo-status route

    it('should get canary SLO metrics', async () => {
      // Now uses /slo-status route (changed from /canary/slo/metrics)
      const result = await getSloMetrics();
      
      expect(result.healthy).toBeDefined();
      expect(result.violations).toBeDefined();
      expect(['shadow', 'canary']).toContain(result.source);
      expect(result.windowMinutes).toBeGreaterThan(0);
      expect(Array.isArray(result.deployments)).toBe(true);
    });

    // The shadow router caches the live canary pointers for LIVE_REFS_CACHE_TTL_MS (default 5s,
    // workers/shadow-router/live-refs-cache.ts): a ref move shows up there within that bound, not instantly.
    const SHADOW_FOLLOWS_WITHIN_MS = 5000 + 3000;
    async function shadowSplitsUntil(done: (candidateIds: string[]) => boolean): Promise<string[]> {
      const deadline = Date.now() + SHADOW_FOLLOWS_WITHIN_MS;
      for (;;) {
        const ids = Object.keys((await getShadowConfig()).splits);
        if (done(ids) || Date.now() > deadline) return ids;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    it('should rollback a canary by moving the deploy ref, and the shadow router follows it within the cache TTL', async () => {
      const first = await deployCanary(`${ctx.candidateId}-a`, ctx.specId, 10);
      const second = await deployCanary(`${ctx.candidateId}-b`, ctx.specId, 10);
      expect((await getDeployment(first.deployment.id)).deployment.status).toBe('superseded');

      // The shadow router reads the live canary ref from the Spec DO
      const before = await shadowSplitsUntil((ids) => ids.includes(`${ctx.candidateId}-b`));
      expect(before).toContain(`${ctx.candidateId}-b`);

      const rolled = await rollbackCanary(`${ctx.candidateId}-b`, ctx.specId);
      expect(rolled.success).toBe(true);
      expect(rolled.deployment.status).toBe('rolled_back');
      expect(rolled.deployRef).toMatchObject({ candidateId: `${ctx.candidateId}-a`, action: 'rollback' });
      expect((await getDeployment(first.deployment.id)).deployment.status).toBe('deployed');
      expect((await getDeployment(second.deployment.id)).deployment.status).toBe('rolled_back');

      const after = await shadowSplitsUntil((ids) => !ids.includes(`${ctx.candidateId}-b`) && ids.includes(`${ctx.candidateId}-a`));
      expect(after).not.toContain(`${ctx.candidateId}-b`);
      expect(after).toContain(`${ctx.candidateId}-a`);
    }, 30000);
  });

  // ==========================================================================
  // Promotion Worker Flow
  // ==========================================================================

  describe('Promotion Worker Flow', () => {
    it('should get promotion worker mode', async () => {
      const result = await getPromotionMode();
      
      expect(result.mode).toBeDefined();
      expect(['tournament', 'merge-train']).toContain(result.mode);
    });

    it('should get promotion worker health with mode info', async () => {
      const result = await getPromotionHealth();
      
      expect(result.status).toBe('healthy');
      expect(result.mode).toBeDefined();
    });

    it('should promote candidate through valid rung transitions', async () => {
      // Deploy canary first (required for some transitions)
      await deployCanary(ctx.candidateId, ctx.specId, 10);

      // Promote from shadow to train
      const result1 = await promoteCandidate(
        ctx.candidateId,
        ctx.specId,
        'shadow',
        'train'
      );
      
      expect(result1.success).toBe(true);
      expect(result1.fromRung).toBe('shadow');
      expect(result1.toRung).toBe('train');

      // Promote from train to canary
      const result2 = await promoteCandidate(
        ctx.candidateId,
        ctx.specId,
        'train',
        'canary'
      );
      
      expect(result2.success).toBe(true);
      expect(result2.fromRung).toBe('train');
      expect(result2.toRung).toBe('canary');

      // Check candidate status
      const statusResult = await getCandidateStatus(ctx.candidateId);
      expect(statusResult.currentRung).toBe('canary');
    });

    it('should reject invalid rung transitions', async () => {
      // Try to go backwards (canary -> shadow is invalid)
      const result = await promoteCandidate(
        ctx.candidateId,
        ctx.specId,
        'canary',
        'shadow'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid rung transition');
    });

    it('should get candidate promotion status', async () => {
      // Promote first
      await promoteCandidate(
        ctx.candidateId,
        ctx.specId,
        'shadow',
        'train'
      );

      const result = await getCandidateStatus(ctx.candidateId);
      
      expect(result.success).toBe(true);
      expect(result.candidateId).toBe(ctx.candidateId);
      expect(result.currentRung).toBeDefined();
      expect(result.status).toBeDefined();
    });
  });

  // ==========================================================================
  // REMOVED: Merge-Train Flow and Tournament Flow
  // ==========================================================================
  // These test suites were removed because they test routes that don't exist:
  // - /promotion/merge-train/start (no equivalent)
  // - /promotion/merge-train/:id (no equivalent)  
  // - /promotion/tournament/start (no equivalent)
  // 
  // Per Opus agent: "Tournaments and merge-trains are joined implicitly
  // through POST /promote, not started via separate endpoints. Adding these routes
  // would create a second way in that bypasses the queue."

  // ==========================================================================
  // Oracle Ladder Complete Flow
  // ==========================================================================

  describe('Oracle Ladder Complete Flow', () => {
    it('should simulate the complete oracle ladder flow', async () => {
      const config = getConfig();
      
      // Skip for local - requires all workers to be running
      if (config.environment === 'local') {
        console.log('Skipping oracle ladder flow for local environment');
        return;
      }

      // Step 1: Verify Statsig configuration in shadow router
      const shadowConfig = await getShadowConfig();
      expect(shadowConfig.enabled).toBe(true);

      // Step 2: Classify a request
      const classification = await classifyRequest(
        `oracle-${Date.now()}`,
        ctx.candidateId,
        ctx.specId
      );
      expect(classification.type).toBeDefined();

      // Step 3: Deploy canary
      const deployResult = await deployCanary(
        ctx.candidateId,
        ctx.specId,
        10
      );
      expect(deployResult.success).toBe(true);
      const deploymentId = deployResult.deployment.id;

      // Step 4: Check canary deployment
      const deployment = await getDeployment(deploymentId);
      expect(deployment.deployment.status).toBe('deployed');

      // Step 5: Check SLO metrics
      const sloMetrics = await getSloMetrics();
      expect(sloMetrics.healthy).toBeDefined();

      // Step 6: Promote through ladder
      // Shadow -> Train
      const promo1 = await promoteCandidate(
        ctx.candidateId,
        ctx.specId,
        'shadow',
        'train'
      );
      expect(promo1.success).toBe(true);

      // Train -> Canary
      const promo2 = await promoteCandidate(
        ctx.candidateId,
        ctx.specId,
        'train',
        'canary'
      );
      expect(promo2.success).toBe(true);

      // Step 7: Verify candidate status
      const status = await getCandidateStatus(ctx.candidateId);
      expect(status.currentRung).toBe('canary');

      // Step 8: Check promotion worker health
      const promoHealth = await getPromotionHealth();
      expect(promoHealth.status).toBe('healthy');
    });

    it('should test all valid rung transitions', async () => {
      const validTransitions = [
        { from: 'pre-merge', to: 'shadow' },
        { from: 'shadow', to: 'train' },
        { from: 'train', to: 'canary' },
        { from: 'canary', to: 'full' },
      ];

      for (const transition of validTransitions) {
        const result = await promoteCandidate(
          ctx.candidateId,
          ctx.specId,
          transition.from,
          transition.to
        );

        expect(result.success, `Transition ${transition.from} -> ${transition.to} should succeed`).toBe(true);
      }
    });

    it('should reject all invalid rung transitions', async () => {
      const invalidTransitions = [
        { from: 'canary', to: 'shadow' },  // Can't go backwards
        { from: 'canary', to: 'train' },   // Can't go backwards
        { from: 'shadow', to: 'pre-merge' }, // Can't go backwards
        { from: 'full', to: 'canary' },    // Can't go backwards
        { from: 'train', to: 'pre-merge' }, // Can't skip rungs
      ];

      for (const transition of invalidTransitions) {
        const result = await promoteCandidate(
          ctx.candidateId,
          ctx.specId,
          transition.from,
          transition.to
        );

        expect(result.success, `Transition ${transition.from} -> ${transition.to} should fail`).toBe(false);
      }
    });
  });

  // ==========================================================================
  // Cross-Worker Data Consistency
  // ==========================================================================

  describe('Cross-Worker Data Consistency', () => {
    it('should maintain consistent candidate IDs across workers', async () => {
      // Deploy canary
      const deployResult = await deployCanary(
        ctx.candidateId,
        ctx.specId,
        10
      );
      expect(deployResult.success).toBe(true);
      expect(deployResult.deployment.candidateId).toBe(ctx.candidateId);

      // Promote candidate
      const promoResult = await promoteCandidate(
        ctx.candidateId,
        ctx.specId,
        'shadow',
        'train'
      );
      expect(promoResult.success).toBe(true);
      expect(promoResult.candidateId).toBe(ctx.candidateId);

      // Check candidate status
      const statusResult = await getCandidateStatus(ctx.candidateId);
      expect(statusResult.candidateId).toBe(ctx.candidateId);
    });

    it('should handle concurrent requests gracefully', async () => {
      // This test verifies that multiple concurrent requests don't cause issues
      const promises = [
        getShadowConfig(),
        deployCanary(`${ctx.candidateId}-1`, `${ctx.specId}-1`, 5),
        deployCanary(`${ctx.candidateId}-2`, `${ctx.specId}-2`, 5),
        getPromotionMode(),
      ];

      const results = await Promise.allSettled(promises);
      
      // At least some should succeed
      const successful = results.filter(r => r.status === 'fulfilled');
      expect(successful.length).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // Error Handling Tests
  // ==========================================================================

  describe('Error Handling Tests', () => {
    it('should handle invalid canary deployment data', async () => {
      // Try to deploy with invalid data
      const request = createRequest(
        '/deploy-canary',
        'POST',
        {
          candidateId: '', // Invalid: empty
          specId: ctx.specId,
        },
        {},
        'canary'
      );

      const response = await fetch(request);
      
      // Should return 400 Bad Request
      expect(response.status).toBe(400);
      const data = await readJson(response);
      expect(data.error).toBeDefined();
    });

    it('should handle invalid traffic percentage', async () => {
      // Try to deploy with trafficPercentage > 100
      const request = createRequest(
        '/deploy-canary',
        'POST',
        {
          candidateId: ctx.candidateId,
          specId: ctx.specId,
          trafficPercentage: 150, // Invalid
        },
        {},
        'canary'
      );

      const response = await fetch(request);
      
      expect(response.status).toBe(400);
      const data = await readJson(response);
      expect(data.error).toBeDefined();
    });

    it('should handle invalid promotion request', async () => {
      // Missing required fields
      const request = createRequest(
        '/promote',
        'POST',
        {
          candidateId: ctx.candidateId,
          // Missing specId, fromRung, toRung
        },
        {},
        'promotion'
      );

      const response = await fetch(request);
      
      expect(response.status).toBe(400);
      const data = await readJson(response);
      expect(data.success).toBe(false);
    });
  });

  // ==========================================================================
  // Mode Switching Tests
  // ==========================================================================

  describe('Promotion Mode Switching', () => {
    let originalMode: 'tournament' | 'merge-train';

    beforeAll(async () => {
      // Get current mode
      const modeResult = await getPromotionMode();
      originalMode = modeResult.mode;
    });

    afterAll(async () => {
      // Restore original mode
      try {
        await setPromotionMode(originalMode);
      } catch (error) {
        console.warn('Failed to restore promotion mode:', error);
      }
    });

    it('should switch from tournament to merge-train mode', async () => {
      // Switch to tournament first
      await setPromotionMode('tournament');

      // Switch to merge-train
      const result = await setPromotionMode('merge-train');
      
      expect(result.success).toBe(true);
      expect(result.mode).toBe('merge-train');

      // Verify
      const modeResult = await getPromotionMode();
      expect(modeResult.mode).toBe('merge-train');
    });

    it('should switch from merge-train to tournament mode', async () => {
      // Switch to merge-train first
      await setPromotionMode('merge-train');

      // Switch to tournament
      const result = await setPromotionMode('tournament');
      
      expect(result.success).toBe(true);
      expect(result.mode).toBe('tournament');

      // Verify
      const modeResult = await getPromotionMode();
      expect(modeResult.mode).toBe('tournament');
    });
  });
});
