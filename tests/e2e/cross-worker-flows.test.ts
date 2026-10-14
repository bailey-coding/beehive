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
  status: 'active' | 'deployed' | 'rolled_back' | 'failed';
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
  const response = await fetchWorker('/shadow/config', 'GET', undefined, 'shadow');
  return readJson(response);
}

async function classifyRequest(requestId: string, candidateId: string, specId: string): Promise<{ classification: RequestClassification }> {
  const response = await fetchWorker(
    '/shadow/classify',
    'POST',
    { requestId, candidateId, specId, path: '/test', method: 'GET' },
    'shadow'
  );
  return readJson(response) as Promise<{ classification: RequestClassification }>;
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
  const response = await fetchWorker(
    '/canary/deploy',
    'POST',
    { candidateId, specId, trafficPercentage, holdoutPercentage },
    'canary'
  );
  return readJson(response) as Promise<{ deployment: CanaryDeployment }>;
}

async function getDeployment(deploymentId: string): Promise<{ deployment: CanaryDeployment & { metrics?: CanaryMetrics } }> {
  const response = await fetchWorker(`/canary/deployments/${deploymentId}`, 'GET', undefined, 'canary');
  return readJson(response);
}

async function rollbackDeployment(deploymentId: string): Promise<{ success: boolean; status: string }> {
  const response = await fetchWorker(`/canary/deployments/${deploymentId}/rollback`, 'POST', undefined, 'canary');
  return readJson(response) as Promise<{ success: boolean; status: string }>;
}

async function getSloMetrics(): Promise<{ metrics: CanaryMetrics & { compliance: boolean } }> {
  const response = await fetchWorker('/canary/slo/metrics', 'GET', undefined, 'canary');
  return readJson(response) as Promise<{ metrics: CanaryMetrics & { compliance: boolean } }>;
}

async function getSloConfig(): Promise<{ config: { latencyP95: number; errorRate: number } }> {
  const response = await fetchWorker('/canary/slo/config', 'GET', undefined, 'canary');
  return readJson(response);
}

/**
 * Promotion Worker API helpers
 */
async function getPromotionHealth(): Promise<{ status: string; mode: string }> {
  const response = await fetchWorker('/promotion/health', 'GET', undefined, 'promotion');
  return readJson(response) as Promise<{ status: string; mode: string }>;
}

async function getPromotionMode(): Promise<{ mode: 'tournament' | 'merge-train' }> {
  const response = await fetchWorker('/promotion/mode', 'GET', undefined, 'promotion');
  return readJson(response) as Promise<{ mode: 'tournament' | 'merge-train' }>;
}

async function setPromotionMode(mode: 'tournament' | 'merge-train'): Promise<{ success: boolean; newMode: string }> {
  const response = await fetchWorker('/promotion/mode', 'POST', { mode }, 'promotion');
  return readJson(response) as Promise<{ success: boolean; newMode: string }>;
}

async function promoteCandidate(
  candidateId: string,
  specId: string,
  fromRung: string,
  toRung: string,
  actorId: string = 'e2e-test-agent'
): Promise<{ success: boolean; promotionId: string; fromRung: string; toRung: string }> {
  const response = await fetchWorker(
    '/promotion/candidates/promote',
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
  const response = await fetchWorker(`/promotion/candidates/${candidateId}/status`, 'GET', undefined, 'promotion');
  return readJson(response);
}

async function startMergeTrain(
  cars: { candidateId: string; position: number }[],
  projection: number = 100
): Promise<{ success: boolean; trainId: string; cars: MergeTrainCar[] }> {
  const response = await fetchWorker(
    '/promotion/merge-train/start',
    'POST',
    { cars, projection },
    'promotion'
  );
  return readJson(response) as Promise<{ success: boolean; trainId: string; cars: MergeTrainCar[] }>;
}

async function getMergeTrain(trainId: string): Promise<{
  success: boolean;
  trainId: string;
  cars: MergeTrainCar[];
  projection: number;
  status: string;
}> {
  const response = await fetchWorker(`/promotion/merge-train/${trainId}`, 'GET', undefined, 'promotion');
  return readJson(response);
}

async function startTournament(
  participants: { candidateId: string; score: number; position: number }[]
): Promise<{ success: boolean; tournamentId: string; participants: any[] }> {
  const response = await fetchWorker(
    '/promotion/tournament/start',
    'POST',
    { participants },
    'promotion'
  );
  return readJson(response);
}

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
      const shadowResponse = await fetchWorker('/shadow/health', 'GET', undefined, 'shadow');
      expect(shadowResponse.status).toBe(200);
      const shadowHealth = await readJson(shadowResponse);
      expect(shadowHealth.status).toBe('healthy');
      expect(shadowHealth.statsigEnabled).toBe(true);

      // Canary Worker health
      const canaryResponse = await fetchWorker('/canary/health', 'GET', undefined, 'canary');
      expect(canaryResponse.status).toBe(200);
      const canaryHealth = await readJson(canaryResponse);
      expect(canaryHealth.status).toBe('healthy');
      expect(canaryHealth.activeDeployments).toBeDefined();

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

      const response = await getShadowConfig();
      
      expect(response.success).toBe(true);
      expect(response.config).toBeDefined();
      
      const configData = response.config as any;
      expect(configData.enabled).toBe(true);
      expect(configData.statsig).toBeDefined();
      expect(configData.statsig.enabled).toBe(true);
      
      // Check default split
      const defaultSplit = configData.statsig.defaultSplit;
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
      
      expect(response.classification).toBeDefined();
      expect(response.classification.type).toBeOneOf([
        'canary',
        'holdout',
        'baseline',
        'shadow'
      ]);
      
      // If Statsig is enabled, we should get a valid classification
      // Note: The actual classification depends on the worker's Statsig config
    });

    it('should have consistent Statsig configuration across requests', async () => {
      // Get config twice
      const config1 = await getShadowConfig();
      const config2 = await getShadowConfig();
      
      // Both should have the same structure
      expect(config1.success).toBe(config2.success);
      expect((config1.config as any)?.statsig?.enabled).toBe(
        (config2.config as any)?.statsig?.enabled
      );
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

    it('should get canary SLO configuration', async () => {
      const result = await getSloConfig();
      
      expect(result.config).toBeDefined();
      expect(result.config.latencyP95).toBeDefined();
      expect(result.config.errorRate).toBeDefined();
    });

    it('should get canary SLO metrics', async () => {
      const result = await getSloMetrics();
      
      expect(result.metrics).toBeDefined();
      expect(result.metrics.requestCount).toBeDefined();
      expect(result.metrics.errorCount).toBeDefined();
      expect(result.metrics.latencyP95).toBeDefined();
      expect(result.metrics.errorRate).toBeDefined();
      expect(result.metrics.compliance).toBeDefined();
    });

    it('should rollback a canary deployment', async () => {
      // Deploy first
      const deployResult = await deployCanary(
        ctx.candidateId,
        ctx.specId,
        10
      );
      const deploymentId = deployResult.deployment.id;

      // Rollback
      const rollbackResult = await rollbackDeployment(deploymentId);
      
      expect(rollbackResult.success).toBe(true);
      expect(rollbackResult.status).toBe('rolled_back');
      
      // Verify rollback
      const statusResult = await getDeployment(deploymentId);
      expect(statusResult.deployment.status).toBe('rolled_back');
    });
  });

  // ==========================================================================
  // Promotion Worker Flow
  // ==========================================================================

  describe('Promotion Worker Flow', () => {
    it('should get promotion worker mode', async () => {
      const result = await getPromotionMode();
      
      expect(result.mode).toBeDefined();
      expect(result.mode).toBeOneOf(['tournament', 'merge-train']);
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
  // Merge-Train Flow
  // ==========================================================================

  describe('Merge-Train Flow', () => {
    let trainId: string;

    it('should start a merge-train', async () => {
      const cars = [
        { candidateId: `${ctx.candidateId}-1`, position: 1 },
        { candidateId: `${ctx.candidateId}-2`, position: 2 },
        { candidateId: `${ctx.candidateId}-3`, position: 3 },
      ];

      const result = await startMergeTrain(cars, 100);
      
      expect(result.success).toBe(true);
      expect(result.trainId).toBeDefined();
      expect(result.cars).toBeDefined();
      expect(result.cars.length).toBe(3);
      
      trainId = result.trainId;
    });

    it('should get merge-train status', async () => {
      // Start a train first
      const cars = [
        { candidateId: `${ctx.candidateId}-1`, position: 1 },
        { candidateId: `${ctx.candidateId}-2`, position: 2 },
      ];

      const startResult = await startMergeTrain(cars);
      const trainId = startResult.trainId;

      // Get status
      const result = await getMergeTrain(trainId);
      
      expect(result.success).toBe(true);
      expect(result.trainId).toBe(trainId);
      expect(result.cars).toBeDefined();
      expect(result.status).toBeDefined();
      expect(result.projection).toBeDefined();
    });
  });

  // ==========================================================================
  // Tournament Flow
  // ==========================================================================

  describe('Tournament Flow', () => {
    it('should start a tournament', async () => {
      const participants = [
        { candidateId: `${ctx.candidateId}-1`, score: 0, position: 1 },
        { candidateId: `${ctx.candidateId}-2`, score: 0, position: 2 },
        { candidateId: `${ctx.candidateId}-3`, score: 0, position: 3 },
      ];

      const result = await startTournament(participants);
      
      expect(result.success).toBe(true);
      expect(result.tournamentId).toBeDefined();
      expect(result.participants).toBeDefined();
      expect(result.participants.length).toBe(3);
    });
  });

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
      expect(shadowConfig.success).toBe(true);
      expect((shadowConfig.config as any)?.statsig?.enabled).toBe(true);

      // Step 2: Classify a request
      const classification = await classifyRequest(
        `oracle-${Date.now()}`,
        ctx.candidateId,
        ctx.specId
      );
      expect(classification.classification).toBeDefined();

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
      expect(sloMetrics.metrics.compliance).toBeDefined();

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
        '/canary/deploy',
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
      expect(data.success).toBe(false);
    });

    it('should handle invalid traffic percentage', async () => {
      // Try to deploy with trafficPercentage > 100
      const request = createRequest(
        '/canary/deploy',
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
      expect(data.success).toBe(false);
    });

    it('should handle invalid promotion request', async () => {
      // Missing required fields
      const request = createRequest(
        '/promotion/candidates/promote',
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
      expect(result.newMode).toBe('merge-train');

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
      expect(result.newMode).toBe('tournament');

      // Verify
      const modeResult = await getPromotionMode();
      expect(modeResult.mode).toBe('tournament');
    });
  });
});
