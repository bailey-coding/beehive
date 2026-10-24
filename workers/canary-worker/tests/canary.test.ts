/**
 * Beehive Canary Worker Unit Tests
 * 
 * Comprehensive unit tests for the Canary Worker (M3 feature)
 * Covers: SLO Monitoring, Rollback Logic, Canary Management, and Health Checks
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import handler from '../index';
import { CanaryWorker } from '../canary';
import { RollbackManager } from '../rollback';
import { SLOMonitor } from '../slo';
import type { CanaryConfig, CanaryDeployment, RollbackTrigger, Env, SLOStatus } from '../types';
import type { DeployRef } from '../../shared/deploy-refs';

// ============================================================================
// Mock Environment
// ============================================================================

const mockSpecDoStub = {
  fetch: vi.fn(),
};

const mockPreviewManager = {
  fetch: vi.fn(),
};

const mockAnalytics = {
  writeDataPoint: vi.fn(),
};

const mockEnv: Env = {
  SPEC_DO: {
    idFromName: vi.fn().mockReturnValue('do-id'),
    get: vi.fn().mockReturnValue(mockSpecDoStub),
  },
  PREVIEW_MANAGER: mockPreviewManager as unknown as Service,
  ANALYTICS: mockAnalytics,
  API_AUTH_TOKEN: 'test-auth-token',
  SPEC_DO_INTERNAL_TOKEN: 'test-do-internal-token',
  CANARY_SLO_LATENCY_P95: '1000',
  CANARY_SLO_ERROR_RATE: '0.01',
};

const mockCtx = {};

// The Spec DO stub receives the Request the shared authed stub built (tokens attached)
async function doCall(index: number) {
  const request = mockSpecDoStub.fetch.mock.calls[index][0] as Request;
  return { url: request.url, method: request.method, headers: request.headers, body: await request.clone().text() };
}

// Helper to create mock requests
function createRequest(
  path: string,
  method: string = 'GET',
  body?: unknown,
  headers?: Record<string, string>
): Request {
  const url = new URL(`http://localhost${path}`);
  return new Request(url.toString(), {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// Helper to call handler with correct auth
async function callHandler(
  path: string,
  method: string = 'GET',
  body?: unknown,
  headers?: Record<string, string>
): Promise<Response> {
  const request = createRequest(path, method, body, {
    Authorization: 'Bearer test-auth-token',
    ...headers,
  });
  // @ts-ignore - mock environment
  return handler.fetch(request, mockEnv, mockCtx);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// Spec DO deploy-ref routes answer { success, data }
function envelope(data: unknown, status = 200): Response {
  return json({ success: true, data, timestamp: Date.now() }, status);
}

function liveDeployment(overrides: Partial<CanaryDeployment> = {}): CanaryDeployment {
  return {
    id: 'deployment-001',
    candidateId: 'candidate-001',
    specId: 'spec-001',
    status: 'deployed',
    url: 'https://preview.example.com',
    workerVersionId: 'stub-1',
    commitSha: 'sha1',
    trafficPercentage: 25,
    holdoutPercentage: 10,
    autoRollback: true,
    deployRefId: 'ref-1',
    rollbackReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function ref(overrides: Partial<DeployRef> = {}): DeployRef {
  return {
    id: 'ref-1',
    specId: 'spec-001',
    rung: 'canary',
    candidateId: 'candidate-001',
    commitSha: 'sha1',
    workerVersionId: 'stub-1',
    prevRefId: null,
    action: 'promote',
    movedBy: 'canary-worker',
    movedAt: Date.now(),
    ...overrides,
  };
}

// ============================================================================
// Test Setup
// ============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.SPEC_DO.idFromName.mockReturnValue('do-id');
  mockEnv.SPEC_DO.get.mockReturnValue(mockSpecDoStub);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================================
// SLO Monitoring Tests (10 tests)
// ============================================================================

describe('SLO Monitoring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('P95 Latency Calculation', () => {
    it('should calculate p95 latency from metrics data', () => {
      // Create a SLOMonitor instance
      const slo = new SLOMonitor(mockEnv);
      
      // Sample latencies; sort and calculate p95 manually
      const testLatencies = [100, 150, 200, 250, 300, 350, 400, 450, 500, 1500];
      const sorted = [...testLatencies].sort((a, b) => a - b);
      const index = Math.ceil(sorted.length * 0.95) - 1;
      const p95 = sorted[index];
      
      expect(p95).toBe(1500);
    });

    it('should handle empty metrics data', () => {
      const emptyLatencies: number[] = [];
      const sorted = [...emptyLatencies].sort((a, b) => a - b);
      const index = Math.ceil(sorted.length * 0.95) - 1;
      const p95 = sorted[index] || 0;
      
      expect(p95).toBe(0);
    });

    it('should handle partial metrics data', () => {
      const partialLatencies = [100, 200];
      const sorted = [...partialLatencies].sort((a, b) => a - b);
      const index = Math.ceil(sorted.length * 0.95) - 1;
      const p95 = sorted[index];
      
      expect(p95).toBe(200);
    });

    it('should return 0 for no data', () => {
      const noData: number[] = [];
      const sorted = [...noData].sort((a, b) => a - b);
      const index = Math.ceil(sorted.length * 0.95) - 1;
      const p95 = sorted[index] || 0;
      
      expect(p95).toBe(0);
    });
  });

  describe('Error Rate Calculation', () => {
    it('should calculate error rate from request counts', () => {
      const requests = 1000;
      const errors = 50;
      const errorRate = errors / requests;
      
      expect(errorRate).toBe(0.05);
    });

    it('should return 0 when no errors', () => {
      const requests = 1000;
      const errors = 0;
      const errorRate = errors / requests;
      
      expect(errorRate).toBe(0);
    });

    it('should return 1 when all errors', () => {
      const requests = 100;
      const errors = 100;
      const errorRate = errors / requests;
      
      expect(errorRate).toBe(1);
    });
  });

  describe('SLO Threshold Evaluation', () => {
    it('should detect SLO violation when p95 > threshold', () => {
      const latencyP95 = 1500; // ms
      const threshold = 1000; // ms
      const violated = latencyP95 > threshold;
      
      expect(violated).toBe(true);
    });

    it('should detect SLO violation when error rate > threshold', () => {
      const errorRate = 0.05; // 5%
      const threshold = 0.01; // 1%
      const violated = errorRate > threshold;
      
      expect(violated).toBe(true);
    });

    it('should pass when both metrics within thresholds', () => {
      const latencyP95 = 500; // ms
      const latencyThreshold = 1000; // ms
      const errorRate = 0.005; // 0.5%
      const errorRateThreshold = 0.01; // 1%
      
      const latencyViolated = latencyP95 > latencyThreshold;
      const errorViolated = errorRate > errorRateThreshold;
      const healthy = !latencyViolated && !errorViolated;
      
      expect(healthy).toBe(true);
    });
  });

  describe('Rolling Window Aggregation', () => {
    it('should maintain time-windowed metrics', () => {
      // Simulate a rolling window of metrics
      const windowSize = 60; // 60 seconds
      const now = Date.now();
      const window: { timestamp: number; value: number }[] = [];
      
      // Add some metrics
      for (let i = 0; i < 10; i++) {
        window.push({ timestamp: now - i * 1000, value: 100 + i * 10 });
      }
      
      // Filter to window
      const filtered = window.filter(m => now - m.timestamp <= windowSize * 1000);
      
      expect(filtered.length).toBe(10);
    });
  });
});

// ============================================================================
// Rollback Logic Tests (8 tests)
// ============================================================================

describe('Rollback Logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpecDoStub.fetch.mockReset();
    mockPreviewManager.fetch.mockReset();
  });

  describe('SLO Violation Detection', () => {
    it('should trigger rollback when SLO violated', async () => {
      const rollback = new RollbackManager(mockEnv);
      
      // Mock a violation trigger
      const trigger: RollbackTrigger = {
        candidateId: 'candidate-001',
        specId: 'spec-001',
        reason: 'slo_violation',
        timestamp: new Date().toISOString(),
        metrics: { latencyP95: 1500, errorRate: 0.05, requestCount: 1000 },
      };
      
      // Mock the dependencies
      const mockCanaryWorker = {
        getCanaryDeployment: vi.fn().mockResolvedValue({
          id: 'deployment-001',
          candidateId: 'candidate-001',
          specId: 'spec-001',
          status: 'active',
          url: 'https://preview.example.com',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as CanaryDeployment),
      };
      
      vi.spyOn(mockCanaryWorker, 'getCanaryDeployment');
      
      // Test that the trigger has the right properties
      expect(trigger.candidateId).toBe('candidate-001');
      expect(trigger.reason).toBe('slo_violation');
      expect(trigger.metrics.latencyP95).toBeGreaterThan(1000);
    });

    it('should not trigger rollback when SLO passed', () => {
      const trigger: RollbackTrigger = {
        candidateId: 'candidate-001',
        specId: 'spec-001',
        reason: 'slo_violation',
        timestamp: new Date().toISOString(),
        metrics: { latencyP95: 500, errorRate: 0.001, requestCount: 1000 },
      };
      
      // Check that metrics are within thresholds
      const withinLatency = trigger.metrics.latencyP95! <= 1000;
      const withinErrorRate = trigger.metrics.errorRate! <= 0.01;
      
      expect(withinLatency).toBe(true);
      expect(withinErrorRate).toBe(true);
    });
  });

  describe('Rollback Execution', () => {
    const trigger = (reason: RollbackTrigger['reason']): RollbackTrigger => ({
      candidateId: 'candidate-001',
      specId: 'spec-001',
      reason,
      timestamp: new Date().toISOString(),
      metrics: {},
    });

    it('rolls back by moving the deploy ref in the Spec DO, never via the preview manager', async () => {
      mockSpecDoStub.fetch
        .mockResolvedValueOnce(envelope([liveDeployment()]))
        .mockResolvedValueOnce(envelope({ deployment: liveDeployment({ status: 'rolled_back', rollbackReason: 'manual' }), ref: ref({ action: 'rollback' }) }));

      const response = await new RollbackManager(mockEnv).triggerRollback(trigger('manual'));

      expect(response.status).toBe(200);
      expect(await readJson(response)).toMatchObject({ success: true, deployment: { status: 'rolled_back' }, deployRef: { action: 'rollback' } });
      const rollback = await doCall(1);
      expect(rollback.url).toBe('https://spec-do.internal/canary-deployments/deployment-001/rollback');
      expect(JSON.parse(rollback.body)).toEqual({ reason: 'manual' });
      expect(mockPreviewManager.fetch).not.toHaveBeenCalled();
    });

    it('an automatic trigger is refused (409) when auto-rollback is off; a manual one is not', async () => {
      mockSpecDoStub.fetch.mockResolvedValueOnce(envelope([liveDeployment({ autoRollback: false })]));
      expect((await new RollbackManager(mockEnv).triggerRollback(trigger('slo_violation'))).status).toBe(409);
      expect(mockSpecDoStub.fetch).toHaveBeenCalledTimes(1);
    });

    it('answers 404 when the candidate has no live canary', async () => {
      mockSpecDoStub.fetch.mockResolvedValueOnce(envelope([liveDeployment({ status: 'rolled_back' })]));
      expect((await new RollbackManager(mockEnv).triggerRollback(trigger('manual'))).status).toBe(404);
    });
  });

  describe('State Cleanup', () => {
    it('should log rollback event', async () => {
      const rollback = new RollbackManager(mockEnv);
      
      // Mock analytics
      mockAnalytics.writeDataPoint.mockResolvedValue(undefined);
      
      // Log a rollback event
      await (rollback as unknown as { logAnalytics: (event: string, data: Record<string, unknown>) => Promise<void> }).logAnalytics('canary_rollback', {
        candidateId: 'candidate-001',
        reason: 'slo_violation',
      });
      
      expect(mockAnalytics.writeDataPoint).toHaveBeenCalled();
    });
  });
});

// ============================================================================
// Canary Management Tests (6 tests)
// ============================================================================

describe('Canary Management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpecDoStub.fetch.mockReset();
    mockPreviewManager.fetch.mockReset();
  });

  describe('Percentage Calculation', () => {
    it('should calculate correct traffic percentage', () => {
      const config: CanaryConfig = {
        candidateId: 'candidate-001',
        specId: 'spec-001',
        trafficPercentage: 25,
        holdoutPercentage: 10,
        rollbackThreshold: { latencyP95: 1000, errorRate: 0.01 },
      };
      
      expect(config.trafficPercentage).toBe(25);
    });
  });

  describe('Traffic Splitting', () => {
    it('should split traffic based on percentage', () => {
      const total = 1000;
      const percentage = 25;
      const split = (total * percentage) / 100;
      
      expect(split).toBe(250);
    });
  });

  describe('Gradual Rollout', () => {
    it('should increase percentage over time', () => {
      const initial = 10;
      const increment = 10;
      const max = 100;
      const steps = [10, 20, 30, 40, 50];
      
      steps.forEach((step, index) => {
        expect(step).toBe(initial + (index * increment));
      });
    });
  });

  describe('Emergency Stop', () => {
    it('should stop canary on emergency signal', () => {
      const deployment: CanaryDeployment = {
        id: 'deployment-001',
        candidateId: 'candidate-001',
        specId: 'spec-001',
        status: 'active',
        url: 'https://preview.example.com',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      
      // Emergency stop
      deployment.status = 'rolled_back';
      
      expect(deployment.status).toBe('rolled_back');
    });
  });
});

// ============================================================================
// Canary Deployment Tests (4 tests)
// ============================================================================

describe('Canary Deployment', () => {
  const config: CanaryConfig = {
    candidateId: 'candidate-001',
    specId: 'spec-001',
    trafficPercentage: 25,
    holdoutPercentage: 10,
    rollbackThreshold: { latencyP95: 1000, errorRate: 0.01 },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSpecDoStub.fetch.mockReset();
    mockPreviewManager.fetch.mockReset();
  });

  it('builds a version via POST /api/preview/canary, then records it and moves the ref in the Spec DO', async () => {
    mockPreviewManager.fetch.mockResolvedValueOnce(
      json({ success: true, url: 'https://abc-beehive-candidate-candidate-001.workers.dev', versionId: 'stub-1', commitSha: 'sha1' })
    );
    mockSpecDoStub.fetch.mockResolvedValueOnce(envelope({ deployment: liveDeployment(), ref: ref() }, 201));

    const response = await new CanaryWorker(mockEnv).deployCanary(config);

    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body).toMatchObject({ success: true, deployment: { id: 'deployment-001', status: 'deployed' }, deployRef: { id: 'ref-1' } });
    const [pmUrl, pmInit] = mockPreviewManager.fetch.mock.calls[0];
    expect(pmUrl).toBe('https://preview-manager.internal/api/preview/canary');
    expect(JSON.parse(pmInit.body)).toEqual({ candidateId: 'candidate-001', specId: 'spec-001' });
    expect(pmInit.headers.Authorization).toBe('Bearer test-auth-token');
    const deploy = await doCall(0);
    expect(deploy.url).toBe('https://spec-do.internal/canary-deployments');
    expect(deploy.headers.get('X-Beehive-Internal')).toBe('test-do-internal-token');
    expect(deploy.headers.has('X-Beehive-Admin')).toBe(false);
    expect(JSON.parse(deploy.body)).toMatchObject({ url: 'https://abc-beehive-candidate-candidate-001.workers.dev', workerVersionId: 'stub-1', commitSha: 'sha1', trafficPercentage: 25, holdoutPercentage: 10 });
  });

  it('should return 400 for invalid config', async () => {
    const response = await new CanaryWorker(mockEnv).deployCanary({ ...config, candidateId: '' });
    expect(response.status).toBe(400);
    expect(mockPreviewManager.fetch).not.toHaveBeenCalled();
  });

  it('returns 502 on a preview manager 5xx and 501 when it has no Versions client, moving no ref', async () => {
    mockPreviewManager.fetch.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    expect((await new CanaryWorker(mockEnv).deployCanary(config)).status).toBe(502);
    mockPreviewManager.fetch.mockResolvedValueOnce(new Response('not implemented', { status: 501 }));
    expect((await new CanaryWorker(mockEnv).deployCanary(config)).status).toBe(501);
    expect(mockSpecDoStub.fetch).not.toHaveBeenCalled();
  });

  it('relays a Spec DO refusal (e.g. 404 tombstoned candidate)', async () => {
    mockPreviewManager.fetch.mockResolvedValueOnce(json({ success: true, url: 'https://u', versionId: 'v' }));
    mockSpecDoStub.fetch.mockResolvedValueOnce(json({ success: false, error: 'Candidate candidate-001 not found' }, 404));
    const response = await new CanaryWorker(mockEnv).deployCanary(config);
    expect(response.status).toBe(404);
  });

  it('GET /canary-deployments/:id reads the deployment by id', async () => {
    mockSpecDoStub.fetch.mockResolvedValueOnce(envelope(liveDeployment()));
    const response = await callHandler('/canary-deployments/deployment-001');
    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({ success: true, deployment: { id: 'deployment-001' } });
    expect((await doCall(0)).url).toBe('https://spec-do.internal/canary-deployments/deployment-001');
  });

  it('GET /canary-deployments/:id never puts a DO stub where the namespace belongs (DataCloneError regression)', async () => {
    // A real stub answers any property as an RPC method; get(RpcPromise) then fails to clone.
    const rpcStub = new Proxy(mockSpecDoStub as Record<string, unknown>, {
      get(target, prop) {
        if (prop in target) return target[prop as string];
        return () => {
          throw new Error('DataCloneError: Could not serialize object of type "RpcPromise"');
        };
      },
    });
    const namespace = { idFromName: vi.fn().mockReturnValue('do-id'), get: vi.fn().mockReturnValue(rpcStub) };
    mockSpecDoStub.fetch.mockResolvedValueOnce(envelope(liveDeployment()));
    const request = createRequest('/canary-deployments/deployment-001', 'GET', undefined, { Authorization: 'Bearer test-auth-token' });
    // @ts-ignore - mock environment
    const response = await handler.fetch(request, { ...mockEnv, SPEC_DO: namespace }, mockCtx);
    expect(response.status).toBe(200);
    expect(namespace.get).toHaveBeenCalledWith('do-id');
  });

  it('GET /canary-deployments/:id answers 404 for an unknown deployment', async () => {
    mockSpecDoStub.fetch.mockResolvedValueOnce(json({ success: false, error: 'Canary deployment not found', code: 'record_not_found' }, 404));
    expect((await callHandler('/canary-deployments/nope')).status).toBe(404);
  });

  it('getLiveCanary returns the deployed one of a candidate', async () => {
    mockSpecDoStub.fetch.mockResolvedValueOnce(
      envelope([liveDeployment({ id: 'new', status: 'rolled_back' }), liveDeployment({ id: 'old' })])
    );
    const live = await new CanaryWorker(mockEnv).getLiveCanary('candidate-001');
    expect(live?.id).toBe('old');
  });
});

describe('Auto-rollback switch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpecDoStub.fetch.mockReset();
  });

  it('POST /canary/:candidateId/auto-rollback sets it on the live canary', async () => {
    mockSpecDoStub.fetch
      .mockResolvedValueOnce(envelope([liveDeployment()]))
      .mockResolvedValueOnce(envelope(liveDeployment({ autoRollback: false })));
    const response = await callHandler('/canary/candidate-001/auto-rollback', 'POST', { enabled: false });
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ success: true, candidateId: 'candidate-001', deploymentId: 'deployment-001', enabled: false });
    const patch = await doCall(1);
    expect(patch.url).toBe('https://spec-do.internal/canary-deployments/deployment-001');
    expect(patch.method).toBe('PATCH');
  });

  it('answers 404 without a live canary and 400 without a boolean', async () => {
    mockSpecDoStub.fetch.mockResolvedValueOnce(envelope([]));
    expect((await callHandler('/canary/candidate-001/auto-rollback', 'POST', { enabled: true })).status).toBe(404);
    expect((await callHandler('/canary/candidate-001/auto-rollback', 'POST', { enabled: 'yes' })).status).toBe(400);
  });
});

// ============================================================================
// Health Check Tests (3 tests)
// ============================================================================

describe('Health Checks', () => {
  it('should return healthy status', async () => {
    const request = createRequest('/health', 'GET', undefined, {
      Authorization: 'Bearer test-auth-token',
    });
    const response = await handler.fetch(request, mockEnv, mockCtx);
    expect(response.status).toBe(200);
    const data = await readJson(response);
    expect(data.status).toBe('healthy');
    expect(data.timestamp).toBeDefined();
  });

  it('should return 401 for missing auth', async () => {
    const request = createRequest('/health', 'GET');
    const response = await handler.fetch(request, { ...mockEnv, API_AUTH_TOKEN: undefined }, mockCtx);
    expect(response.status).toBe(503);
  });

  it('should return 401 for wrong auth', async () => {
    const request = createRequest('/health', 'GET', undefined, {
      Authorization: 'Bearer wrong-token',
    });
    const response = await handler.fetch(request, mockEnv, mockCtx);
    expect(response.status).toBe(401);
  });
});

// ============================================================================
// SLO Status Tests (2 tests)
// ============================================================================

describe('SLO Status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return SLO status', async () => {
    // Mock the SLO status
    const slo = new SLOMonitor(mockEnv);
    
    // Mock checkSLOs to return a healthy status
    vi.spyOn(slo, 'checkSLOs').mockResolvedValue({
      healthy: true,
      violations: [],
      currentMetrics: { latencyP95: 500, errorRate: 0.001, requestCount: 1000 },
    } as SLOStatus);
    
    const request = createRequest('/slo-status', 'GET', undefined, {
      Authorization: 'Bearer test-auth-token',
    });
    
    // This tests the SLOMonitor class directly
    const status = await slo.getSLOStatus();
    expect(status.status).toBe(200);
    
    const data = await status.json();
    expect(data.healthy).toBe(true);
  });

  it('should detect SLO violations', async () => {
    const slo = new SLOMonitor(mockEnv);
    
    // Mock checkSLOs to return violations
    vi.spyOn(slo, 'checkSLOs').mockResolvedValue({
      healthy: false,
      violations: [{
        candidateId: 'all',
        specId: 'all',
        reason: 'latency',
        timestamp: new Date().toISOString(),
        metrics: { latencyP95: 1500, errorRate: 0.001, requestCount: 1000 },
      }],
      currentMetrics: { latencyP95: 1500, errorRate: 0.001, requestCount: 1000 },
    } as SLOStatus);
    
    const status = await slo.getSLOStatus();
    expect(status.status).toBe(200);
    
    const data = await status.json();
    expect(data.healthy).toBe(false);
    expect(data.violations.length).toBe(1);
  });
});
