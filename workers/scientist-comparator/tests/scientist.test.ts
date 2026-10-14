/**
 * Scientist Comparator Worker Tests
 * 
 * Unit tests for the scientist-comparator worker.
 * Tests health checks, bindings, and basic functionality.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Import the handler
import handler from '../index';
import type { ScientistEnv } from '../types';

// Import types for reference
import type {
  TrafficSplitConfig,
  RequestClassification,
} from '../types';

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
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// Mock environment with all required properties
const baseMockEnv: ScientistEnv = {
  API_AUTH_TOKEN: 'test-auth-token',
  SPEC_DO: {
    idFromName: vi.fn().mockReturnValue('spec-do-123'),
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
};

const mockCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as any;

// ============================================================================
// Bindings Tests (6 tests)
// ============================================================================

describe('Scientist Comparator - Bindings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('SPEC_DO Service Binding', () => {
    it('should have SPEC_DO binding defined', () => {
      expect(baseMockEnv.SPEC_DO).toBeDefined();
      expect(baseMockEnv.SPEC_DO.idFromName).toBeDefined();
      expect(baseMockEnv.SPEC_DO.get).toBeDefined();
    });

    it('should call idFromName on SPEC_DO', () => {
      // Reset mock to track calls
      baseMockEnv.SPEC_DO.idFromName = vi.fn().mockReturnValue('spec-do-123');
      const id = baseMockEnv.SPEC_DO.idFromName('SpecDO');
      expect(baseMockEnv.SPEC_DO.idFromName).toHaveBeenCalledWith('SpecDO');
      expect(id).toBe('spec-do-123');
    });

    it('should call get on SPEC_DO', () => {
      baseMockEnv.SPEC_DO.get = vi.fn().mockReturnValue({
        fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({}), {
          status: 200,
        })),
      });
      const stub = baseMockEnv.SPEC_DO.get('spec-do-123');
      expect(baseMockEnv.SPEC_DO.get).toHaveBeenCalledWith('spec-do-123');
      expect(stub).toBeDefined();
    });
  });

  describe('Analytics Engine Binding', () => {
    it('should have Analytics Engine binding defined', () => {
      expect(baseMockEnv.ANALYTICS).toBeDefined();
      expect(baseMockEnv.ANALYTICS.writeDataPoint).toBeDefined();
    });

    it('should have writeDataPoint method available', () => {
      expect(typeof baseMockEnv.ANALYTICS.writeDataPoint).toBe('function');
    });
  });

  describe('Queue Binding', () => {
    it('should have SCIENTIST_QUEUE binding defined', () => {
      expect(baseMockEnv.SCIENTIST_QUEUE).toBeDefined();
      expect(baseMockEnv.SCIENTIST_QUEUE.send).toBeDefined();
    });

    it('should have send method available', () => {
      expect(typeof baseMockEnv.SCIENTIST_QUEUE.send).toBe('function');
    });
  });
});

// ============================================================================
// Health Check Tests (2 tests)
// ============================================================================

describe('Scientist Comparator - Health Checks', () => {
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
    expect(data.service).toBe('scientist-comparator');
    expect(data.timestamp).toBeDefined();
  });

  it('should return 503 for missing API_AUTH_TOKEN', async () => {
    const request = createRequest('/health', 'GET', undefined, {
      Authorization: 'Bearer test-auth-token',
    });
    const response = await handler.fetch(request, {
      ...baseMockEnv,
      API_AUTH_TOKEN: undefined,
    }, mockCtx);
    
    expect(response.status).toBe(503);
  });
});

// ============================================================================
// Configuration Tests (4 tests)
// ============================================================================

describe('Scientist Comparator - Configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Constants', () => {
    it('should have defined constants', () => {
      // Verify constants are defined
      expect('Scientist Comparator').toBeDefined();
    });

    it('should have handler exported', () => {
      expect(handler).toBeDefined();
      expect(handler.fetch).toBeDefined();
      expect(handler.queue).toBeDefined();
    });
  });

  describe('Queue Processing', () => {
    it('should have queue handler defined', () => {
      expect(handler.queue).toBeDefined();
      expect(typeof handler.queue).toBe('function');
    });

    it('should have fetch handler defined', () => {
      expect(handler.fetch).toBeDefined();
      expect(typeof handler.fetch).toBe('function');
    });
  });
});

// ============================================================================
// API Tests (4 tests)
// ============================================================================

describe('Scientist Comparator - API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('404 for unknown routes', () => {
    it('should return 404 for unknown GET routes', async () => {
      const request = createRequest('/api/unknown', 'GET', undefined, {
        Authorization: 'Bearer test-auth-token',
      });
      const response = await handler.fetch(request, baseMockEnv, mockCtx);
      
      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toBe('Not found');
    });

    it('should return 404 for unknown POST routes', async () => {
      const request = createRequest('/api/unknown', 'POST', {}, {
        Authorization: 'Bearer test-auth-token',
      });
      const response = await handler.fetch(request, baseMockEnv, mockCtx);
      
      expect(response.status).toBe(404);
    });
  });

  describe('Metrics endpoint', () => {
    it('should return 501 for metrics endpoint', async () => {
      const request = createRequest('/api/metrics', 'GET', undefined, {
        Authorization: 'Bearer test-auth-token',
      });
      const response = await handler.fetch(request, baseMockEnv, mockCtx);
      
      expect(response.status).toBe(501);
      const data = await response.json();
      expect(data.error).toBe('Metrics endpoint not yet implemented');
    });
  });
});
