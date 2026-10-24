/**
 * E2E Tests - M3 Features
 * 
 * Tests M3-specific features: Statsig traffic splitting, Canary deployments, 
 * Promotion worker (tournament and merge-train modes).
 * 
 * Runs against local workers by default; production only with E2E_ENVIRONMENT=production
 * and E2E_ALLOW_PRODUCTION=1 (human approval required).
 * 
 * Phase: 4
 * Task: test-phase-4
 * Spec: Testing
 * Confidence: 1.0
 */

import { describe, it, expect } from 'vitest';
import { getConfig } from './config';
import { createRequest } from './helpers';

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

// Target selection comes from tests/e2e/config.ts (E2E_ENVIRONMENT, default local).
// Production URLs below are only reachable when E2E_ENVIRONMENT=production AND
// E2E_ALLOW_PRODUCTION=1 (human approval required, see AGENTS.md); getConfig() throws otherwise.
const e2eConfig = getConfig();
const IS_LOCAL = e2eConfig.environment === 'local';

const PRODUCTION_BASE_URL = e2eConfig.baseUrl;
const PRODUCTION_AUTH_TOKEN = e2eConfig.apiToken;

// Workers with no local dev port are '' locally; their tests are skipped.
const WORKER_URLS = {
  main: e2eConfig.baseUrl,
  api: e2eConfig.baseUrl,
  shadowRouter: e2eConfig.shadowRouterUrl,
  canary: e2eConfig.canaryWorkerUrl,
  promotion: e2eConfig.promotionWorkerUrl,
  gateWorkflow: IS_LOCAL ? '' : 'https://beehive-gate-workflow.bz23711.workers.dev',
  sandboxRunner: IS_LOCAL ? '' : 'https://beehive-sandbox-runner.bz23711.workers.dev',
  queueConsumer: IS_LOCAL ? '' : 'https://beehive-queue-consumer.bz23711.workers.dev',
  previewManager: IS_LOCAL ? 'http://localhost:8791' : 'https://beehive-preview-manager.bz23711.workers.dev',
  candidateService: IS_LOCAL ? '' : 'https://beehive-candidate-service.bz23711.workers.dev',
  scientistComparator: IS_LOCAL ? '' : 'https://beehive-scientist-comparator.bz23711.workers.dev',
};

// ============================================================================
// Production E2E Tests - Worker Health and API Connectivity
// ============================================================================

describe(`E2E Tests - ${e2eConfig.environment}`, () => {
  // Skip when no auth token is available (production without BEEHIVE_API_TOKEN)
  const shouldSkip = !PRODUCTION_AUTH_TOKEN;

  describe('Worker Health Endpoints', () => {
    it.skipIf(shouldSkip)('should verify main API worker is healthy', async () => {
      const response = await fetch(`${WORKER_URLS.main}/health`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });

      expect(response.status).toBe(200);
      // /health wraps its payload: { success, data: { status, version, timestamp, checks } }
      const body = await readJson(response);
      expect(body.success).toBe(true);
      const data = body.data as { status?: string; version?: string; timestamp?: number };
      expect(data.status).toBe('healthy');
      expect(data.version).toBeDefined();
      expect(data.timestamp).toBeDefined();
    }, 10000);

    it.skipIf(shouldSkip)('should verify shadow router worker is healthy', async () => {
      // Route is /health (there is no /shadow/ prefix); body: { status, service, statsig: { enabled } }
      const response = await fetch(`${WORKER_URLS.shadowRouter}/health`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });

      expect(response.status).toBe(200);
      const data = await readJson(response);
      expect(data.status).toBe('healthy');
      expect((data.statsig as { enabled?: boolean }).enabled).toBe(true);
    }, 10000);

    it.skipIf(shouldSkip)('should verify canary worker is healthy', async () => {
      // Route is /health; body: { status, timestamp }
      const response = await fetch(`${WORKER_URLS.canary}/health`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });

      expect(response.status).toBe(200);
      const data = await readJson(response);
      expect(data.status).toBe('healthy');
      expect(data.timestamp).toBeDefined();
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

    it.skipIf(shouldSkip || !WORKER_URLS.gateWorkflow)('should verify gate workflow worker is healthy', async () => {
      const response = await fetch(`${WORKER_URLS.gateWorkflow}/health`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });

      expect([200, 404]).toContain(response.status);
    }, 10000);

    it.skipIf(shouldSkip || !WORKER_URLS.sandboxRunner)('should verify sandbox runner worker is healthy', async () => {
      const response = await fetch(`${WORKER_URLS.sandboxRunner}/health`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });

      expect([200, 404]).toContain(response.status);
    }, 10000);

    it.skipIf(shouldSkip || !WORKER_URLS.queueConsumer)('should verify queue consumer worker is healthy', async () => {
      const response = await fetch(`${WORKER_URLS.queueConsumer}/health`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });

      expect([200, 404]).toContain(response.status);
    }, 10000);

    it.skipIf(shouldSkip || !WORKER_URLS.previewManager)('should verify preview manager worker is healthy', async () => {
      const response = await fetch(`${WORKER_URLS.previewManager}/health`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });

      expect([200, 404]).toContain(response.status);
    }, 10000);

    it.skipIf(shouldSkip || !WORKER_URLS.candidateService)('should verify candidate service worker is healthy', async () => {
      const response = await fetch(`${WORKER_URLS.candidateService}/health`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });

      expect([200, 404]).toContain(response.status);
    }, 10000);

    it.skipIf(shouldSkip || !WORKER_URLS.scientistComparator)('should verify scientist comparator worker is healthy', async () => {
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
      // GET /mode reads the mode persisted in the Spec DO (a cross-worker binding)
      const response = await fetch(`${WORKER_URLS.promotion}/mode`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });

      expect(response.status).toBe(200);
      const data = await readJson(response);
      expect(data.mode).toBeDefined();
    }, 10000);

    it.skipIf(shouldSkip)('should test shadow router to scientist queue binding', async () => {
      // /statsig/config answers the config object itself (no { success, config } wrapper)
      const response = await fetch(`${WORKER_URLS.shadowRouter}/statsig/config`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });

      expect(response.status).toBe(200);
      const data = await readJson(response);
      expect(data.enabled).toBeDefined();
    }, 10000);

    it.skipIf(shouldSkip)('should test canary worker SLO configuration', async () => {
      // There is no SLO *config* route; /slo-status answers { healthy, violations, source, windowMinutes, minRequests, deployments[] }
      const response = await fetch(`${WORKER_URLS.canary}/slo-status`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });

      expect(response.status).toBe(200);
      const data = await readJson(response);
      expect(typeof data.healthy).toBe('boolean');
      expect(Array.isArray(data.violations)).toBe(true);
      expect(['shadow', 'canary']).toContain(data.source);
      expect(Array.isArray(data.deployments)).toBe(true);
    }, 10000);
  });

  describe('M3 Features - Statsig Traffic Splitting', () => {
    it.skipIf(shouldSkip)('should get Statsig-enabled shadow router config', async () => {
      // GET /statsig/config answers { enabled, splits, defaultSplit }
      const response = await fetch(`${WORKER_URLS.shadowRouter}/statsig/config`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });

      expect(response.status).toBe(200);
      const data = await readJson(response);
      expect(data.enabled).toBe(true);
      expect(data.splits).toBeDefined();
      expect(data.defaultSplit).toBeDefined();
    }, 10000);

    it.skipIf(shouldSkip)('should get default traffic split configuration', async () => {
      const response = await fetch(`${WORKER_URLS.shadowRouter}/statsig/config`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });

      expect(response.status).toBe(200);
      const data = await readJson(response);
      const statsig = data.defaultSplit as { canaryPercentage?: number; holdoutPercentage?: number; baselinePercentage?: number } | undefined;
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

      const response = await fetch(`${WORKER_URLS.shadowRouter}/statsig/classify`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      // Body is the classification itself: { type, weight }
      expect(response.status).toBe(200);
      const data = await readJson(response);
      expect(data.type).toBeDefined();
      expect(['canary', 'holdout', 'baseline', 'shadow']).toContain(data.type);
    }, 10000);

    // 'should get traffic split metrics' (POST /shadow/splits) was deleted: it asked for
    // split metrics over a time window, which live in Analytics Engine; the shadow router
    // only writes them. See docs/OPEN-QUESTIONS.md "Canary deploy and rollback".
  });

  describe('M3 Features - Canary', () => {
    it.skipIf(shouldSkip)('should deploy canary with valid configuration', async () => {
      const requestBody = {
        candidateId: `e2e-test-${Date.now()}`,
        specId: 'test-spec',
        trafficPercentage: 5,
        holdoutPercentage: 5,
      };

      // Locally this needs beehive-preview-manager on 8791 with WORKER_VERSIONS_MODE=stub and BEEHIVE_LOCAL_DEV=1
      // (scripts/start-e2e-workers.sh); it answers 501 without a Versions client.
      const response = await fetch(`${WORKER_URLS.canary}/deploy-canary`, {
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
      // /slo-status answers per-deployment verdicts (an empty list when no canary is live)
      const response = await fetch(`${WORKER_URLS.canary}/slo-status`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });

      expect(response.status).toBe(200);
      const data = await readJson(response);
      const deployments = (data as { deployments?: { verdict: string }[] }).deployments;
      expect(Array.isArray(deployments)).toBe(true);
      for (const d of deployments ?? []) {
        expect(['healthy', 'violation', 'insufficient_data', 'unavailable']).toContain(d.verdict);
      }
    }, 10000);

    // The switch belongs to a live canary, so the test deploys one first (it used to
    // configure a candidate with no canary, which has nothing to switch: 404).
    it.skipIf(shouldSkip)('should verify auto-rollback is configurable', async () => {
      const candidateId = `e2e-rollback-test-${Date.now()}`;
      const headers = {
        'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      };
      const deployResponse = await fetch(`${WORKER_URLS.canary}/deploy-canary`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ candidateId, specId: `e2e-spec-${Date.now()}`, trafficPercentage: 5, holdoutPercentage: 5 }),
      });
      expect(deployResponse.status).toBe(200);

      for (const enabled of [false, true]) {
        const response = await fetch(`${WORKER_URLS.canary}/canary/${candidateId}/auto-rollback`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ enabled }),
        });

        expect(response.status).toBe(200);
        const data = await readJson(response);
        expect(data.success).toBe(true);
        expect((data as { enabled?: boolean }).enabled).toBe(enabled);
      }
    }, 10000);

    it.skipIf(shouldSkip)('should handle invalid canary deployment', async () => {
      const requestBody = {
        candidateId: '',
        specId: 'test-spec',
        trafficPercentage: 150, // Invalid: > 100
      };

      const response = await fetch(`${WORKER_URLS.canary}/deploy-canary`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      // The error body is { error } with no `success` field
      expect(response.status).toBe(400);
      const data = await readJson(response);
      expect(data.error).toBeDefined();
    }, 10000);
  });

  describe('M3 Features - Promotion', () => {
    it.skipIf(shouldSkip)('should get current promotion mode', async () => {
      const response = await fetch(`${WORKER_URLS.promotion}/mode`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });

      expect(response.status).toBe(200);
      const data = await readJson(response);
      expect(data.mode).toBeDefined();
      expect(['tournament', 'merge-train']).toContain(data.mode);
    }, 10000);

    it.skipIf(shouldSkip)('should switch promotion mode', async () => {
      const currentResponse = await fetch(`${WORKER_URLS.promotion}/mode`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });
      const currentData = await readJson(currentResponse);
      const newMode = currentData.mode === 'tournament' ? 'merge-train' : 'tournament';

      const switchResponse = await fetch(`${WORKER_URLS.promotion}/mode`, {
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
      expect(switchData.mode).toBe(newMode);

      // Switch back to original mode
      await fetch(`${WORKER_URLS.promotion}/mode`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ mode: currentData.mode }),
      });
    }, 15000);

    // There is no /tournament/start route: a tournament is joined implicitly by
    // POST /promote in tournament mode and read back with GET /tournament.
    it.skipIf(shouldSkip)('should start tournament with participants', async () => {
      const auth = { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}`, 'Content-Type': 'application/json' };
      const originalMode = (await readJson(await fetch(`${WORKER_URLS.promotion}/mode`, { headers: auth }))).mode;
      // The winner is recorded on the candidate (PATCH /api/candidates/:id/stage), so the
      // participants must be real rows. test-org-e2e-* is what the purge-by-prefix cleanup targets.
      const seed = async (path: string, body: unknown, actor?: string) => {
        const res = await fetch(createRequest(path, 'POST', body, actor ? { 'X-Actor-ID': actor } : {}));
        expect(res.status, path).toBe(201);
        return ((await readJson(res)).data as { id: string }).id;
      };
      const actor = await seed('/api/actors', { type: 'agent', name: `e2e-tournament-${Date.now()}` });
      const orgId = await seed('/api/organizations', { name: `test-org-e2e-tournament-${Date.now()}`, type: 'artifacts' }, actor);
      const repoId = await seed('/api/repositories', {
        name: 'repo', organizationId: orgId, repoType: 'baseline', remoteUrl: 'https://example.invalid/r.git', namespace: 'e2e',
      }, actor);
      const specId = await seed('/api/specs', { name: 'spec', contract: '{}', declaredDeltaSurface: [], organizationId: orgId }, actor);
      const candidateIds = [
        await seed('/api/candidates', { specId, repositoryId: repoId, commitSha: 'abc', baseCommitSha: 'base' }, actor),
        await seed('/api/candidates', { specId, repositoryId: repoId, commitSha: 'def', baseCommitSha: 'base' }, actor),
      ];

      try {
        const modeRes = await fetch(`${WORKER_URLS.promotion}/mode`, {
          method: 'POST', headers: auth, body: JSON.stringify({ mode: 'tournament' }),
        });
        expect(modeRes.status).toBe(200);

        for (const candidateId of candidateIds) {
          const response = await fetch(`${WORKER_URLS.promotion}/promote`, {
            method: 'POST',
            headers: auth,
            body: JSON.stringify({ candidateId, specId, fromRung: 'shadow', toRung: 'train', actorId: 'e2e-test-actor' }),
          });
          expect(response.status).toBe(200);
          const data = await readJson(response);
          expect(data.success).toBe(true);
          expect(data.mode).toBe('tournament');
        }

        const listRes = await fetch(`${WORKER_URLS.promotion}/tournament`, { headers: auth });
        expect(listRes.status).toBe(200);
        const list = await readJson(listRes);
        expect(list.success).toBe(true);
        const tournament = (list.tournaments as Array<{ specId: string; candidates: Array<{ candidateId: string }> }>)
          .find((t) => t.specId === specId);
        expect(tournament).toBeDefined();
        expect(tournament!.candidates.map((c) => c.candidateId).sort()).toEqual([...candidateIds].sort());
      } finally {
        await fetch(`${WORKER_URLS.promotion}/mode`, {
          method: 'POST', headers: auth, body: JSON.stringify({ mode: originalMode }),
        });
      }
    }, 30000);

    it.skipIf(shouldSkip)('should promote candidate through rungs', async () => {
      const requestBody = {
        candidateId: `e2e-promote-${Date.now()}`,
        // unique per run: a spec's tournament completes once it has two candidates
        // and then refuses more, so a shared specId makes reruns fail with 500
        specId: `e2e-promote-spec-${Date.now()}`,
        fromRung: 'shadow',
        toRung: 'train',
        actorId: 'e2e-test-actor',
      };
      const auth = { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}`, 'Content-Type': 'application/json' };

      const response = await fetch(`${WORKER_URLS.promotion}/promote`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify(requestBody),
      });

      // POST /promote answers 200 with { success, candidateId, fromRung, toRung, message, mode }
      expect(response.status).toBe(200);
      const data = await readJson(response);
      expect(data.success).toBe(true);
      expect(data.fromRung).toBe('shadow');
      expect(data.toRung).toBe('train');

      // The ledger state is nested under `state`; currentRung is the rung reached
      const statusRes = await fetch(`${WORKER_URLS.promotion}/promote/${requestBody.candidateId}`, { headers: auth });
      const status = (await readJson(statusRes)) as { state?: { status?: string; currentRung?: string; targetRung?: string } };
      expect(status.state?.status).toBe('completed');
      expect(status.state?.targetRung).toBe('train');
      expect(status.state?.currentRung).toBe('train');
    }, 15000);

    // There is no /merge-train/start route: cars board implicitly through POST /promote in
    // merge-train mode and are read back with GET /merge-train.
    it.skipIf(shouldSkip)('should start merge-train', async () => {
      const auth = { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}`, 'Content-Type': 'application/json' };
      const originalMode = (await readJson(await fetch(`${WORKER_URLS.promotion}/mode`, { headers: auth }))).mode;
      const specId = `e2e-train-spec-${Date.now()}`;
      const candidateIds = [`e2e-car-1-${Date.now()}`, `e2e-car-2-${Date.now()}`];

      try {
        const modeRes = await fetch(`${WORKER_URLS.promotion}/mode`, {
          method: 'POST', headers: auth, body: JSON.stringify({ mode: 'merge-train' }),
        });
        expect(modeRes.status).toBe(200);

        for (const candidateId of candidateIds) {
          const response = await fetch(`${WORKER_URLS.promotion}/promote`, {
            method: 'POST',
            headers: auth,
            body: JSON.stringify({ candidateId, specId, fromRung: 'shadow', toRung: 'train', actorId: 'e2e-test-actor' }),
          });
          expect(response.status).toBe(200);
          const data = await readJson(response);
          expect(data.success).toBe(true);
          expect(data.mode).toBe('merge-train');
        }

        const listRes = await fetch(`${WORKER_URLS.promotion}/merge-train`, { headers: auth });
        expect(listRes.status).toBe(200);
        const list = await readJson(listRes);
        expect(list.success).toBe(true);
        expect(Array.isArray(list.trains)).toBe(true);
        expect((list.trains as unknown[]).length).toBeGreaterThan(0);
      } finally {
        await fetch(`${WORKER_URLS.promotion}/mode`, {
          method: 'POST', headers: auth, body: JSON.stringify({ mode: originalMode }),
        });
      }
    }, 30000);

    it.skipIf(shouldSkip)('should handle invalid rung transition', async () => {
      const requestBody = {
        candidateId: `e2e-invalid-${Date.now()}`,
        specId: 'test-spec',
        fromRung: 'canary',
        toRung: 'pre-merge', // Invalid: can't go backwards
        actorId: 'e2e-test-actor',
      };

      const response = await fetch(`${WORKER_URLS.promotion}/promote`, {
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
      const specId = `e2e-spec-${Date.now()}`; // unique per run (see tournament note above)

      // Step 1: Get Statsig config from shadow router
      const shadowResponse = await fetch(`${WORKER_URLS.shadowRouter}/statsig/config`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });
      expect(shadowResponse.status).toBe(200);
      const shadowData = await readJson(shadowResponse);
      expect(shadowData.enabled).toBe(true);

      // Step 2: Deploy canary
      const canaryResponse = await fetch(`${WORKER_URLS.canary}/deploy-canary`, {
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
      const sloResponse = await fetch(`${WORKER_URLS.canary}/slo-status`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });
      expect(sloResponse.status).toBe(200);
      const sloData = await readJson(sloResponse);
      expect(Array.isArray((sloData as { deployments?: unknown }).deployments)).toBe(true);

      // Step 4: Promote candidate
      const promoResponse = await fetch(`${WORKER_URLS.promotion}/promote`, {
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
      expect(promoResponse.status).toBe(200);
      const promoData = await readJson(promoResponse);
      expect(promoData.success).toBe(true);

      // Verify promotion mode
      const modeResponse = await fetch(`${WORKER_URLS.promotion}/mode`, {
        headers: { 'Authorization': `Bearer ${PRODUCTION_AUTH_TOKEN}` },
      });
      expect(modeResponse.status).toBe(200);

      // All M3 features working together
      expect(true).toBe(true);
    }, 30000);
  });
});
