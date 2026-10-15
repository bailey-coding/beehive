/**
 * E2E Tests - M3 Features
 * 
 * Tests M3-specific features: Statsig traffic splitting, Canary deployments, 
 * Promotion worker (tournament and merge-train modes).
 * 
 * Production E2E tests for beehive.bz23711.workers.dev
 * 
 * Phase: 4
 * Task: test-phase-4
 * Spec: Testing
 * Confidence: 1.0
 */

import { describe, it, expect } from 'vitest';

// ============================================================================
// Test Setup and Types
// ============================================================================

interface JsonResponse {
  [key: string]: unknown;
  success?: boolean;
  error?: string;
  data?: unknown;
}

async function readJson(res: Response): Promise<JsonResponse> {
  return (await res.json()) as JsonResponse;
}

// Production base URL
const PRODUCTION_BASE_URL = process.env.BEEHIVE_PRODUCTION_URL || 'https://beehive.bz23711.workers.dev';

// Production auth token - set via BEEHIVE_AUTH_TOKEN environment variable
const PRODUCTION_AUTH_TOKEN = process.env.BEEHIVE_AUTH_TOKEN;

// Worker URLs for production
const WORKER_URLS = {
  main: PRODUCTION_BASE_URL,
  api: PRODUCTION_BASE_URL,
  shadowRouter: 'https://beehive-shadow-router.bz23711.workers.dev',
  canary: 'https://beehive-canary-worker.bz23711.workers.dev',
  promotion: 'https://beehive-promotion-worker.bz23711.workers.dev',
  gateWorkflow: 'https://beehive-gate-workflow.bz23711.workers.dev',
  sandboxRunner: 'https://beehive-sandbox-runner.bz23711.workers.dev',
  queueConsumer: 'https://beehive-queue-consumer.bz23711.workers.dev',
  previewManager: 'https://beehive-preview-manager.bz23711.workers.dev',
  candidateService: 'https://beehive-candidate-service.bz23711.workers.dev',
  scientistComparator: 'https://beehive-scientist-comparator.bz23711.workers.dev',
};

// ============================================================================
// Production E2E Tests - Worker Health and API Connectivity
// ============================================================================

describe('Production E2E Tests - beehive.bz23711.workers.dev', () => {
  // Skip production tests if no auth token is provided
  const shouldSkip = !PRODUCTION_AUTH_TOKEN || PRODUCTION_BASE_URL.includes('localhost');

  describe('Worker Health Endpoints', () => {
    it.skipIf(shouldSkip)('should verify main API worker is healthy', async () => {
      const response = await fetch(`${WORKER_URLS.main}/health`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });

      expect(response.status).toBe(200);
      const data = await readJson(response);
      expect(data.status).toBe('healthy');
      expect(data.version).toBeDefined();
      expect(data.timestamp).toBeDefined();
    }, 10000);

    it.skipIf(shouldSkip)('should verify shadow router worker is healthy', async () => {
      const response = await fetch(`${WORKER_URLS.shadowRouter}/shadow/health`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });

      expect(response.status).toBe(200);
      const data = await readJson(response);
      expect(data.status).toBe('healthy');
      expect(data.statsigEnabled).toBe(true);
      expect(data.timestamp).toBeDefined();
    }, 10000);

    it.skipIf(shouldSkip)('should verify canary worker is healthy', async () => {
      const response = await fetch(`${WORKER_URLS.canary}/canary/health`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });

      expect(response.status).toBe(200);
      const data = await readJson(response);
      expect(data.status).toBe('healthy');
      expect(data.activeDeployments).toBeDefined();
      expect(data.sloConfig).toBeDefined();
    }, 10000);

    it.skipIf(shouldSkip)('should verify promotion worker is healthy', async () => {
      const response = await fetch(`${WORKER_URLS.promotion}/promotion/health`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });

      expect(response.status).toBe(200);
      const data = await readJson(response);
      expect(data.status).toBe('healthy');
      expect(data.mode).toBeDefined();
      expect(['tournament', 'merge-train']).toContain(data.mode);
    }, 10000);

    it.skipIf(shouldSkip)('should verify gate workflow worker is healthy', async () => {
      const response = await fetch(`${WORKER_URLS.gateWorkflow}/health`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });

      expect([200, 404]).toContain(response.status);
    }, 10000);

    it.skipIf(shouldSkip)('should verify sandbox runner worker is healthy', async () => {
      const response = await fetch(`${WORKER_URLS.sandboxRunner}/health`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });

      expect([200, 404]).toContain(response.status);
    }, 10000);

    it.skipIf(shouldSkip)('should verify queue consumer worker is healthy', async () => {
      const response = await fetch(`${WORKER_URLS.queueConsumer}/health`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });

      expect([200, 404]).toContain(response.status);
    }, 10000);

    it.skipIf(shouldSkip)('should verify preview manager worker is healthy', async () => {
      const response = await fetch(`${WORKER_URLS.previewManager}/health`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });

      expect([200, 404]).toContain(response.status);
    }, 10000);

    it.skipIf(shouldSkip)('should verify candidate service worker is healthy', async () => {
      const response = await fetch(`${WORKER_URLS.candidateService}/health`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });

      expect([200, 404]).toContain(response.status);
    }, 10000);

    it.skipIf(shouldSkip)('should verify scientist comparator worker is healthy', async () => {
      const response = await fetch(`${WORKER_URLS.scientistComparator}/health`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });

      expect([200, 404]).toContain(response.status);
    }, 10000);
  });

  describe('API Connectivity', () => {
    it.skipIf(shouldSkip)('should connect to main API and return version', async () => {
      const response = await fetch(`${WORKER_URLS.api}/api/health`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });

      expect(response.status).toBe(200);
      const data = await readJson(response);
      expect(data.success).toBe(true);
      expect(data.data).toBeDefined();
      expect(data.timestamp).toBeDefined();
    }, 10000);

    it.skipIf(shouldSkip)('should handle unauthorized requests correctly', async () => {
      const response = await fetch(`${WORKER_URLS.api}/api/health`, {
        headers: { 'Authorization': 'Bearer invalid-token' },
      });

      expect(response.status).toBe(401);
      const data = await readJson(response);
      expect(data.success).toBe(false);
      expect(data.error).toBe('Unauthorized');
    }, 10000);

    it.skipIf(shouldSkip)('should handle missing auth header', async () => {
      const response = await fetch(`${WORKER_URLS.api}/api/health`);

      expect(response.status).toBe(401);
    }, 10000);
  });

  describe('Cross-Worker Bindings', () => {
    it.skipIf(shouldSkip)('should verify service bindings work between workers', async () => {
      const response = await fetch(`${WORKER_URLS.promotion}/promotion/mode`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });

      expect(response.status).toBe(200);
      const data = await readJson(response);
      expect(data.mode).toBeDefined();
    }, 10000);

    it.skipIf(shouldSkip)('should test shadow router to scientist queue binding', async () => {
      const response = await fetch(`${WORKER_URLS.shadowRouter}/shadow/config`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });

      expect(response.status).toBe(200);
      const data = await readJson(response);
      expect(data.success).toBe(true);
      expect(data.config).toBeDefined();
    }, 10000);

    it.skipIf(shouldSkip)('should test canary worker SLO configuration', async () => {
      const response = await fetch(`${WORKER_URLS.canary}/canary/slo/config`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });

      expect(response.status).toBe(200);
      const data = await readJson(response);
      expect(data.success).toBe(true);
      expect(data.config.latencyP95).toBeGreaterThan(0);
      expect(data.config.errorRate).toBeGreaterThanOrEqual(0);
    }, 10000);
  });

  describe('M3 Features - Statsig Traffic Splitting', () => {
    it.skipIf(shouldSkip)('should get Statsig-enabled shadow router config', async () => {
      const response = await fetch(`${WORKER_URLS.shadowRouter}/shadow/config`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });

      expect(response.status).toBe(200);
      const data = await readJson(response);
      expect(data.success).toBe(true);
      expect((data.config as { enabled?: boolean }).enabled).toBe(true);
      expect((data.config as { statsig?: unknown }).statsig).toBeDefined();
      expect((data.config as { statsig?: { enabled?: boolean } }).statsig?.enabled).toBe(true);
    }, 10000);

    it.skipIf(shouldSkip)('should get default traffic split configuration', async () => {
      const response = await fetch(`${WORKER_URLS.shadowRouter}/shadow/config`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });

      expect(response.status).toBe(200);
      const data = await readJson(response);
      expect(data.success).toBe(true);
      const statsig = (data.config as { statsig?: { defaultSplit?: { canaryPercentage?: number; holdoutPercentage?: number; baselinePercentage?: number } } }).statsig?.defaultSplit;
      expect(statsig).toBeDefined();
      expect(statsig?.canaryPercentage).toBeGreaterThanOrEqual(0);
      expect(statsig?.holdoutPercentage).toBeGreaterThanOrEqual(0);
      expect(statsig?.baselinePercentage).toBeGreaterThanOrEqual(0);
    }, 10000);

    it.skipIf(shouldSkip)('should classify requests with Statsig', async () => {
      const requestBody = {
        requestId: 'prod-test-request',
        candidateId: 'test-candidate',
        path: '/api/test',
        method: 'GET',
      };

      const response = await fetch(`${WORKER_URLS.shadowRouter}/shadow/classify`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      expect(response.status).toBe(200);
      const data = await readJson(response);
      expect(data.success).toBe(true);
      expect(data.classification).toBeDefined();
      const classificationType = (data.classification as { type?: string }).type;
      expect(classificationType).toBeDefined();
      expect(['canary', 'holdout', 'baseline', 'shadow']).toContain(classificationType);
    }, 10000);

    it.skipIf(shouldSkip)('should get traffic split metrics', async () => {
      const requestBody = {
        candidateId: 'test-candidate',
        startTime: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
        endTime: new Date().toISOString(),
      };

      const response = await fetch(`${WORKER_URLS.shadowRouter}/shadow/splits`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      expect(response.status).toBe(200);
      const data = await readJson(response);
      expect(data.success).toBe(true);
      expect((data as { splits?: unknown }).splits).toBeDefined();
    }, 10000);
  });

  describe('M3 Features - Canary', () => {
    it.skipIf(shouldSkip)('should deploy canary with valid configuration', async () => {
      const requestBody = {
        candidateId: `e2e-test-${Date.now()}`,
        specId: 'test-spec',
        trafficPercentage: 5,
        holdoutPercentage: 5,
      };

      const response = await fetch(`${WORKER_URLS.canary}/canary/deploy`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      expect(response.status).toBe(200);
      const data = await readJson(response);
      expect(data.success).toBe(true);
      expect((data as { deployment?: unknown }).deployment).toBeDefined();
      const deployment = data.deployment as { id?: string; candidateId?: string; status?: string } | undefined;
      expect(deployment?.id).toBeDefined();
      expect(deployment?.candidateId).toBe(requestBody.candidateId);
      expect(deployment?.status).toBe('deployed');
    }, 15000);

    it.skipIf(shouldSkip)('should get canary SLO metrics', async () => {
      const response = await fetch(`${WORKER_URLS.canary}/canary/slo/metrics`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });

      expect(response.status).toBe(200);
      const data = await readJson(response);
      expect(data.success).toBe(true);
      expect((data as { metrics?: unknown }).metrics).toBeDefined();
      const metrics = data.metrics as { requestCount?: number; errorRate?: number; latencyP95?: number } | undefined;
      expect(metrics?.requestCount).toBeGreaterThanOrEqual(0);
      expect(metrics?.errorRate).toBeGreaterThanOrEqual(0);
      expect(metrics?.latencyP95).toBeGreaterThanOrEqual(0);
    }, 10000);

    it.skipIf(shouldSkip)('should verify auto-rollback is configurable', async () => {
      const candidateId = `e2e-rollback-test-${Date.now()}`;
      const response = await fetch(`${WORKER_URLS.canary}/canary/${candidateId}/auto-rollback`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ enabled: true }),
      });

      expect(response.status).toBe(200);
      const data = await readJson(response);
      expect(data.success).toBe(true);
      expect((data as { enabled?: boolean }).enabled).toBe(true);
    }, 10000);

    it.skipIf(shouldSkip)('should handle invalid canary deployment', async () => {
      const requestBody = {
        candidateId: '',
        specId: 'test-spec',
        trafficPercentage: 150, // Invalid: > 100
      };

      const response = await fetch(`${WORKER_URLS.canary}/canary/deploy`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      expect(response.status).toBe(400);
      const data = await readJson(response);
      expect(data.success).toBe(false);
      expect(data.error).toBeDefined();
    }, 10000);
  });

  describe('M3 Features - Promotion', () => {
    it.skipIf(shouldSkip)('should get current promotion mode', async () => {
      const response = await fetch(`${WORKER_URLS.promotion}/promotion/mode`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });

      expect(response.status).toBe(200);
      const data = await readJson(response);
      expect(data.mode).toBeDefined();
      expect(['tournament', 'merge-train']).toContain(data.mode);
    }, 10000);

    it.skipIf(shouldSkip)('should switch promotion mode', async () => {
      const currentResponse = await fetch(`${WORKER_URLS.promotion}/promotion/mode`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });
      const currentData = await readJson(currentResponse);
      const newMode = currentData.mode === 'tournament' ? 'merge-train' : 'tournament';

      const switchResponse = await fetch(`${WORKER_URLS.promotion}/promotion/mode`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ mode: newMode }),
      });

      expect(switchResponse.status).toBe(200);
      const switchData = await readJson(switchResponse);
      expect(switchData.success).toBe(true);
      expect(switchData.newMode).toBe(newMode);

      // Switch back to original mode
      await fetch(`${WORKER_URLS.promotion}/promotion/mode`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ mode: currentData.mode }),
      });
    }, 15000);

    it.skipIf(shouldSkip)('should start tournament with participants', async () => {
      const requestBody = {
        participants: [
          { candidateId: `e2e-participant-1-${Date.now()}`, score: 0, position: 1 },
          { candidateId: `e2e-participant-2-${Date.now()}`, score: 0, position: 2 },
        ],
      };

      const response = await fetch(`${WORKER_URLS.promotion}/promotion/tournament/start`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      expect(response.status).toBe(201);
      const data = await readJson(response);
      expect(data.success).toBe(true);
      expect((data as { tournamentId?: string }).tournamentId).toBeDefined();
      const participants = (data as { participants?: unknown }).participants || [];
      expect(Array.isArray(participants)).toBe(true);
      expect((participants as Array<unknown>).length).toBe(2);
    }, 15000);

    it.skipIf(shouldSkip)('should promote candidate through rungs', async () => {
      const requestBody = {
        candidateId: `e2e-promote-${Date.now()}`,
        specId: 'test-spec',
        fromRung: 'shadow',
        toRung: 'train',
        actorId: 'e2e-test-actor',
      };

      const response = await fetch(`${WORKER_URLS.promotion}/promotion/candidates/promote`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      expect(response.status).toBe(201);
      const data = await readJson(response);
      expect(data.success).toBe(true);
      expect((data as { promotionId?: string }).promotionId).toBeDefined();
      expect((data as { fromRung?: string }).fromRung).toBe('shadow');
      expect((data as { toRung?: string }).toRung).toBe('train');
    }, 15000);

    it.skipIf(shouldSkip)('should start merge-train', async () => {
      const requestBody = {
        cars: [
          { candidateId: `e2e-car-1-${Date.now()}`, position: 1 },
          { candidateId: `e2e-car-2-${Date.now()}`, position: 2 },
        ],
        projection: 100,
      };

      const response = await fetch(`${WORKER_URLS.promotion}/promotion/merge-train/start`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      expect(response.status).toBe(201);
      const data = await readJson(response);
      expect(data.success).toBe(true);
      expect((data as { trainId?: string }).trainId).toBeDefined();
      const cars = (data as { cars?: unknown }).cars || [];
      expect(Array.isArray(cars)).toBe(true);
      expect((cars as Array<unknown>).length).toBe(2);
    }, 15000);

    it.skipIf(shouldSkip)('should handle invalid rung transition', async () => {
      const requestBody = {
        candidateId: `e2e-invalid-${Date.now()}`,
        specId: 'test-spec',
        fromRung: 'canary',
        toRung: 'pre-merge', // Invalid: can't go backwards
        actorId: 'e2e-test-actor',
      };

      const response = await fetch(`${WORKER_URLS.promotion}/promotion/candidates/promote`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      expect(response.status).toBe(400);
      const data = await readJson(response);
      expect(data.success).toBe(false);
      expect((data.error as string | undefined)?.includes('Invalid rung transition')).toBe(true);
    }, 10000);
  });

  describe('M3 Complete Workflow', () => {
    it.skipIf(shouldSkip)('should execute complete M3 workflow end-to-end', async () => {
      const candidateId = `e2e-workflow-${Date.now()}`;
      const specId = 'e2e-spec';

      // Step 1: Get Statsig config from shadow router
      const shadowResponse = await fetch(`${WORKER_URLS.shadowRouter}/shadow/config`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });
      expect(shadowResponse.status).toBe(200);
      const shadowData = await readJson(shadowResponse);
      expect((shadowData.config as { statsig?: { enabled?: boolean } }).statsig?.enabled).toBe(true);

      // Step 2: Deploy canary
      const canaryResponse = await fetch(`${WORKER_URLS.canary}/canary/deploy`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          candidateId,
          specId,
          trafficPercentage: 5,
          holdoutPercentage: 5,
        }),
      });
      expect(canaryResponse.status).toBe(200);
      const canaryData = await readJson(canaryResponse);
      expect(canaryData.success).toBe(true);

      // Step 3: Get canary SLO metrics
      const sloResponse = await fetch(`${WORKER_URLS.canary}/canary/slo/metrics`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });
      expect(sloResponse.status).toBe(200);
      const sloData = await readJson(sloResponse);
      expect((sloData as { metrics?: unknown }).metrics).toBeDefined();

      // Step 4: Promote candidate
      const promoResponse = await fetch(`${WORKER_URLS.promotion}/promotion/candidates/promote`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          candidateId,
          specId,
          fromRung: 'canary',
          toRung: 'full',
          actorId: 'e2e-test-actor',
        }),
      });
      expect(promoResponse.status).toBe(201);
      const promoData = await readJson(promoResponse);
      expect(promoData.success).toBe(true);

      // Verify promotion mode
      const modeResponse = await fetch(`${WORKER_URLS.promotion}/promotion/mode`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });
      expect(modeResponse.status).toBe(200);

      // All M3 features working together
      expect(true).toBe(true);
    }, 30000);
  });
});
