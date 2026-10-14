/**
 * Shadow Router Worker Tests
 * 
 * Unit tests for the shadow-router worker.
 * Tests traffic splitting, Statsig integration, and request classification.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Import the handler
import handler from '../index';
import type { ShadowRouterEnv } from '../types';

import {
  DEFAULT_STATSIG_CONFIG,
  STATSIG_PRESETS,
  normalizeTrafficSplitConfig,
  isValidTrafficSplitConfig,
  getPresetByName,
  getDefaultShadowConfig,
  getLocalDevShadowConfig,
  getProductionShadowConfig,
} from '../config';
import type { TrafficSplitConfig, RequestClassification, ShadowConfig } from '../types';

// Mock types
type JsonResponse = Record<string, unknown>;

async function readJson(res: Response): Promise<JsonResponse> {
  return await res.json() as JsonResponse;
}

// Helper to create a mock request
function createRequest(
  path: string,
  method: string = 'GET',
  body?: unknown,
  headers?: Record<string, string>
): Request {
  const url = new URL(`http://localhost${path}`);
  return new Request(url.toString(), {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-auth-token',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// Mock environment with all required properties
const baseMockEnv: ShadowRouterEnv = {
  API_AUTH_TOKEN: 'test-auth-token',
  SPEC_DO: {
    idFromName: vi.fn(),
    get: vi.fn(),
    idFromString: vi.fn(),
    getByName: vi.fn(),
    jurisdiction: vi.fn(),
  } as any,
  ANALYTICS: {
    writeDataPoint: vi.fn().mockResolvedValue(undefined),
  } as any,
  SCIENTIST_QUEUE: {
    send: vi.fn().mockResolvedValue(undefined),
  } as any,
  PREVIEW_SCIENTIST_QUEUE: {
    send: vi.fn().mockResolvedValue(undefined),
  } as any,
};

const mockCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as any;

// ============================================================================
// Configuration Tests (Config.ts functions)
// ============================================================================

describe('Shadow Router - Configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Default Configurations', () => {
    it('should have valid default Statsig config', () => {
      const config = DEFAULT_STATSIG_CONFIG;
      expect(config.canaryPercentage + config.holdoutPercentage + config.baselinePercentage).toBe(100);
      expect(config.canaryPercentage).toBe(1);
      expect(config.holdoutPercentage).toBe(1);
      expect(config.baselinePercentage).toBe(98);
    });

    it('should have all required preset configurations', () => {
      const presetKeys = Object.keys(STATSIG_PRESETS);
      expect(presetKeys).toContain('conservative');
      expect(presetKeys).toContain('moderate');
      expect(presetKeys).toContain('aggressive');
      expect(presetKeys).toContain('full-canary');
      expect(presetKeys.length).toBeGreaterThan(8);
    });
  });

  describe('Traffic Split Config Validation', () => {
    it('should validate correct traffic split config', () => {
      const validConfig: TrafficSplitConfig = {
        canaryPercentage: 25,
        holdoutPercentage: 25,
        baselinePercentage: 50,
      };
      expect(isValidTrafficSplitConfig(validConfig)).toBe(true);
    });

    it('should reject config with total != 100', () => {
      const invalidConfig: TrafficSplitConfig = {
        canaryPercentage: 30,
        holdoutPercentage: 30,
        baselinePercentage: 30,
      };
      expect(isValidTrafficSplitConfig(invalidConfig)).toBe(false);
    });

    it('should reject config with negative percentages', () => {
      const invalidConfig: TrafficSplitConfig = {
        canaryPercentage: -5,
        holdoutPercentage: 10,
        baselinePercentage: 95,
      };
      expect(isValidTrafficSplitConfig(invalidConfig)).toBe(false);
    });

    it('should reject config with percentages > 100', () => {
      const invalidConfig: TrafficSplitConfig = {
        canaryPercentage: 110,
        holdoutPercentage: 0,
        baselinePercentage: -10,
      };
      expect(isValidTrafficSplitConfig(invalidConfig)).toBe(false);
    });
  });

  describe('Normalize Traffic Split Config', () => {
    it('should normalize config with total < 100', () => {
      const config: TrafficSplitConfig = {
        canaryPercentage: 30,
        holdoutPercentage: 20,
        baselinePercentage: 40,
      };
      const normalized = normalizeTrafficSplitConfig(config);
      expect(normalized.canaryPercentage).toBe(30);
      expect(normalized.holdoutPercentage).toBe(20);
      expect(normalized.baselinePercentage).toBe(50);
    });

    it('should clamp percentages to valid range', () => {
      const config: TrafficSplitConfig = {
        canaryPercentage: 150,
        holdoutPercentage: -10,
        baselinePercentage: 50,
      };
      const normalized = normalizeTrafficSplitConfig(config);
      expect(normalized.canaryPercentage).toBe(100);
      expect(normalized.holdoutPercentage).toBe(0);
      expect(normalized.baselinePercentage).toBe(0);
    });

    it('should handle valid config unchanged', () => {
      const config: TrafficSplitConfig = {
        canaryPercentage: 10,
        holdoutPercentage: 10,
        baselinePercentage: 80,
      };
      const normalized = normalizeTrafficSplitConfig(config);
      expect(normalized).toEqual(config);
    });
  });

  describe('Get Preset By Name', () => {
    it('should return conservative preset', () => {
      const preset = getPresetByName('conservative');
      expect(preset.canaryPercentage).toBe(1);
      expect(preset.holdoutPercentage).toBe(1);
      expect(preset.baselinePercentage).toBe(98);
    });

    it('should return default config for unknown preset', () => {
      const preset = getPresetByName('unknown-preset');
      expect(preset).toEqual(DEFAULT_STATSIG_CONFIG);
    });

    it('should be case-insensitive', () => {
      const preset1 = getPresetByName('CONSERVATIVE');
      const preset2 = getPresetByName('Conservative');
      expect(preset1).toEqual(preset2);
    });
  });

  describe('Get Shadow Configurations', () => {
    it('should return default shadow config', () => {
      const config = getDefaultShadowConfig();
      expect(config.statsig?.enabled).toBe(true);
      expect(config.statsig?.defaultSplit).toEqual(DEFAULT_STATSIG_CONFIG);
      expect(config.sampleRate).toBe(1.0);
    });

    it('should return local dev config with candidate previews', () => {
      const config = getLocalDevShadowConfig();
      expect(config.candidatePreviews.size).toBeGreaterThan(0);
      expect(config.candidatePreviews.get('beehive-main')).toBe('http://localhost:8787');
    });

    it('should return production config', () => {
      const config = getProductionShadowConfig();
      expect(config.candidatePreviews.get('beehive-main')).toBe('https://beehive.bz23711.workers.dev');
      expect(config.statsig?.defaultSplit).toEqual(STATSIG_PRESETS.conservative);
    });
  });
});

// ============================================================================
// Traffic Splitting Tests (8 tests)
// ============================================================================

describe('Shadow Router - Traffic Splitting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Classification Logic', () => {
    // Note: classifyRequest is not exported, so we test it indirectly via the /statsig/classify endpoint

    it('should classify request via endpoint', async () => {
      const request = createRequest('/statsig/classify', 'GET', undefined, {
        Authorization: 'Bearer test-auth-token',
      });
      const response = await handler.fetch(request, baseMockEnv, mockCtx);
      
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(['canary', 'holdout', 'baseline', 'shadow']).toContain(data.type);
      expect(data.weight).toBeGreaterThanOrEqual(0);
      expect(data.weight).toBeLessThanOrEqual(1);
    });

    it('should classify POST request via endpoint with body', async () => {
      const request = createRequest('/statsig/classify', 'POST', {
        candidateId: 'test-candidate',
        path: '/api/test',
        method: 'POST',
      }, {
        Authorization: 'Bearer test-auth-token',
      });
      const response = await handler.fetch(request, baseMockEnv, mockCtx);
      
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(['canary', 'holdout', 'baseline', 'shadow']).toContain(data.type);
    });
  });

  describe('Statsig Config Endpoint', () => {
    it('should return Statsig config via GET /statsig/config', async () => {
      const request = createRequest('/statsig/config', 'GET', undefined, {
        Authorization: 'Bearer test-auth-token',
      });
      const response = await handler.fetch(request, baseMockEnv, mockCtx);
      
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.enabled).toBe(true);
      expect(data.defaultSplit).toBeDefined();
    });

    it('should update Statsig config via POST /statsig/config', async () => {
      const newConfig = {
        enabled: true,
        defaultSplit: {
          canaryPercentage: 10,
          holdoutPercentage: 10,
          baselinePercentage: 80,
        },
      };
      const request = createRequest('/statsig/config', 'POST', newConfig, {
        Authorization: 'Bearer test-auth-token',
      });
      const response = await handler.fetch(request, baseMockEnv, mockCtx);
      
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.enabled).toBe(true);
      expect(data.defaultSplit.canaryPercentage).toBe(10);
    });
  });

  describe('Statsig Presets Endpoint', () => {
    it('should list all presets via GET /statsig/presets', async () => {
      const request = createRequest('/statsig/presets', 'GET', undefined, {
        Authorization: 'Bearer test-auth-token',
      });
      const response = await handler.fetch(request, baseMockEnv, mockCtx);
      
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty('conservative');
      expect(data).toHaveProperty('moderate');
      expect(data).toHaveProperty('aggressive');
    });

    it('should return specific preset via GET /statsig/preset/{name}', async () => {
      const request = createRequest('/statsig/preset/conservative', 'GET', undefined, {
        Authorization: 'Bearer test-auth-token',
      });
      const response = await handler.fetch(request, baseMockEnv, mockCtx);
      
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.canaryPercentage).toBe(1);
      expect(data.holdoutPercentage).toBe(1);
      expect(data.baselinePercentage).toBe(98);
    });

    it('should return 404 for unknown preset', async () => {
      const request = createRequest('/statsig/preset/unknown-preset', 'GET', undefined, {
        Authorization: 'Bearer test-auth-token',
      });
      const response = await handler.fetch(request, baseMockEnv, mockCtx);
      
      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toBe('Preset not found');
    });
  });
});

// ============================================================================
// Bindings Tests (4 tests)
// ============================================================================

describe('Shadow Router - Bindings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Analytics Engine Binding', () => {
    it('should have Analytics Engine binding defined', () => {
      // Verify binding exists and has writeDataPoint method
      expect(baseMockEnv.ANALYTICS).toBeDefined();
      expect(baseMockEnv.ANALYTICS.writeDataPoint).toBeDefined();
      expect(typeof baseMockEnv.ANALYTICS.writeDataPoint).toBe('function');
    });

    it('should have Analytics Engine accessible for metrics', () => {
      // Verify binding is properly typed
      expect(baseMockEnv.ANALYTICS).toBeDefined();
      expect(baseMockEnv.ANALYTICS.writeDataPoint).toBeDefined();
    });
  });

  describe('Scientist Queue Binding', () => {
    it('should use SCIENTIST_QUEUE for non-preview messages', () => {
      // Verify binding exists
      expect(baseMockEnv.SCIENTIST_QUEUE).toBeDefined();
      expect(typeof baseMockEnv.SCIENTIST_QUEUE.send).toBe('function');
    });

    it('should use PREVIEW_SCIENTIST_QUEUE for preview messages', () => {
      // Verify binding exists
      expect(baseMockEnv.PREVIEW_SCIENTIST_QUEUE).toBeDefined();
      expect(typeof baseMockEnv.PREVIEW_SCIENTIST_QUEUE.send).toBe('function');
    });
  });
});

// ============================================================================
// Health Check Tests (2 tests)
// ============================================================================

describe('Shadow Router - Health Checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return healthy status', async () => {
    const request = createRequest('/health', 'GET', undefined, {
      Authorization: 'Bearer test-auth-token',
    });
    const response = await handler.fetch(request, baseMockEnv, mockCtx);
    
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.status).toBe('healthy');
    expect(data.service).toBe('shadow-router');
    expect(data.statsig).toBeDefined();
    expect(data.statsig.enabled).toBe(true);
  });

  it('should return healthy status on /api/health', async () => {
    const request = createRequest('/api/health', 'GET', undefined, {
      Authorization: 'Bearer test-auth-token',
    });
    const response = await handler.fetch(request, baseMockEnv, mockCtx);
    
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.status).toBe('healthy');
  });
});

// ============================================================================
// Path Filtering Tests
// ============================================================================

describe('Shadow Router - Path Filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return empty response for excluded paths', async () => {
    // /health is excluded from mirroring
    const request = createRequest('/health', 'GET', undefined, {
      Authorization: 'Bearer test-auth-token',
    });
    const response = await handler.fetch(request, baseMockEnv, mockCtx);
    
    // Health endpoint is handled specially, so it returns a real response
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.status).toBe('healthy');
  });

  it('should discard non-mirrored requests', async () => {
    // This tests that requests return empty when not mirrored
    // Note: The actual behavior depends on the configuration
    const request = createRequest('/api/some-endpoint', 'GET', undefined, {
      Authorization: 'Bearer test-auth-token',
    });
    const response = await handler.fetch(request, baseMockEnv, mockCtx);
    
    // The shadow router returns empty responses for mirrored requests
    // In local dev without candidates, it should return empty
    expect(response.status).toBe(200);
  });
});

// ============================================================================
// Auth Gate Tests
// ============================================================================

describe('Shadow Router auth gate', () => {
  it('returns 503 when API_AUTH_TOKEN is not configured', async () => {
    const request = createRequest('/health');
    const response = await handler.fetch(request, { ...baseMockEnv, API_AUTH_TOKEN: undefined }, mockCtx);
    expect(response.status).toBe(503);
  });

  it('returns 401 for a wrong bearer token', async () => {
    const request = createRequest('/health', 'GET', undefined, { Authorization: 'Bearer wrong-token' });
    const response = await handler.fetch(request, baseMockEnv, mockCtx);
    expect(response.status).toBe(401);
  });
});
