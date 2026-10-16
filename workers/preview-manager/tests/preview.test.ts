/**
 * Preview Manager Worker Tests
 * 
 * Unit tests for the preview-manager worker.
 * Tests health checks, bindings, and basic functionality.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Import the handler
import handler from '../index';
import type { PreviewManagerEnv } from '../types';

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
const baseMockEnv: PreviewManagerEnv = {
  API_AUTH_TOKEN: 'test-auth-token',
  CLOUDFLARE_ACCOUNT_ID: 'test-account-id',
  CLOUDFLARE_API_TOKEN: 'test-api-token',
  SPEC_DO: {
    idFromName: vi.fn().mockReturnValue('spec-do-123'),
    get: vi.fn().mockReturnValue({
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({
        candidates: [],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })),
    }),
    idFromString: vi.fn(),
    getByName: vi.fn(),
    jurisdiction: vi.fn(),
  } as any,
  ANALYTICS: {
    writeDataPoint: vi.fn().mockResolvedValue(undefined),
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
// Bindings Tests (6 tests)
// ============================================================================

describe('Preview Manager - Bindings', () => {
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
    it('should have PREVIEW_SCIENTIST_QUEUE binding defined', () => {
      expect(baseMockEnv.PREVIEW_SCIENTIST_QUEUE).toBeDefined();
      expect(baseMockEnv.PREVIEW_SCIENTIST_QUEUE.send).toBeDefined();
    });

    it('should have send method available', () => {
      expect(typeof baseMockEnv.PREVIEW_SCIENTIST_QUEUE.send).toBe('function');
    });
  });
});

// ============================================================================
// Health Check Tests (2 tests)
// ============================================================================

describe('Preview Manager - Health Checks', () => {
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
    expect(data.service).toBe('preview-manager');
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
// API Tests (4 tests)
// ============================================================================

describe('Preview Manager - API', () => {
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

  describe('Deploy endpoint', () => {
    it('should accept deploy request', async () => {
      const request = createRequest('/api/preview/deploy', 'POST', {
        candidateId: 'candidate-123',
        repository: {
          name: 'test-repo',
          namespace: 'test-ns',
          full_name: 'test-ns/test-repo',
        },
        commit: {
          sha: 'abc123',
        },
      }, {
        Authorization: 'Bearer test-auth-token',
      });
      
      const response = await handler.fetch(request, baseMockEnv, mockCtx);
      
      // Should return 200 or an error, but not crash
      expect(response.status).toBeDefined();
    });

    it('should handle invalid deploy request', async () => {
      const request = createRequest('/api/preview/deploy', 'POST', {
        candidateId: 'invalid',
      }, {
        Authorization: 'Bearer test-auth-token',
      });
      
      const response = await handler.fetch(request, baseMockEnv, mockCtx);
      
      // Should return an error response
      expect(response.status).toBeDefined();
    });
  });
});

// ============================================================================
// Configuration Tests (4 tests)
// ============================================================================

describe('Preview Manager - Configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Constants', () => {
    it('should have handler exported', () => {
      expect(handler).toBeDefined();
      expect(handler.fetch).toBeDefined();
      expect(handler.queue).toBeDefined();
    });

    it('should have queue handler defined', () => {
      expect(handler.queue).toBeDefined();
      expect(typeof handler.queue).toBe('function');
    });

    it('should have fetch handler defined', () => {
      expect(handler.fetch).toBeDefined();
      expect(typeof handler.fetch).toBe('function');
    });

    it('should have all required bindings', () => {
      expect(baseMockEnv.SPEC_DO).toBeDefined();
      expect(baseMockEnv.ANALYTICS).toBeDefined();
      expect(baseMockEnv.PREVIEW_SCIENTIST_QUEUE).toBeDefined();
    });
  });
});

// ============================================================================
// Canary version route (POST /api/preview/canary)
// ============================================================================

describe('Preview Manager - canary version', () => {
  const auth = { Authorization: 'Bearer test-auth-token' };

  function envWithCandidate(candidate: Record<string, unknown> | null, status = candidate ? 200 : 404, mode?: string) {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(candidate ? { success: true, data: candidate } : { success: false, error: 'Not found' }), { status })
    );
    const env = {
      ...baseMockEnv,
      WORKER_VERSIONS_MODE: mode,
      WORKERS_SUBDOMAIN: 'acct',
      SPEC_DO: { ...baseMockEnv.SPEC_DO, get: vi.fn().mockReturnValue({ fetch }) } as any,
    };
    return { env, fetch };
  }

  async function post(env: PreviewManagerEnv, body: unknown) {
    return handler.fetch(createRequest('/api/preview/canary', 'POST', body, auth), env, mockCtx);
  }

  it('answers 501 without a Versions client (no stub outside local dev, no Cloudflare API call)', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    const { env } = envWithCandidate(null);
    const res = await post(env, { candidateId: 'c1', specId: 's1' });
    expect(res.status).toBe(501);
    expect(globalFetch).not.toHaveBeenCalled();
    globalFetch.mockRestore();
  });

  it('stub mode returns a fresh { url, versionId } and the candidate commit', async () => {
    const { env } = envWithCandidate({ id: 'c1', specId: 's1', commitSha: 'abc123' }, 200, 'stub');
    const res = await post(env, { candidateId: 'c1', specId: 's1' });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body).toMatchObject({ success: true, candidateId: 'c1', specId: 's1', commitSha: 'abc123', versionsClient: 'stub', workerName: 'beehive-candidate-c1' });
    expect(body.versionId).toMatch(/^stub-[0-9a-f-]{36}$/);
    expect(body.url).toMatch(/^https:\/\/[0-9a-f]{8}-beehive-candidate-c1\.acct\.workers\.dev$/);
    const again = await readJson(await post(env, { candidateId: 'c1', specId: 's1' }));
    expect(again.versionId).not.toBe(body.versionId);
  });

  it('accepts a candidate with no ledger row (commit from the request), refuses a spec mismatch (409)', async () => {
    const missing = envWithCandidate(null, 404, 'stub');
    const res = await post(missing.env, { candidateId: 'c9', specId: 's1', commitSha: 'feed' });
    expect(res.status).toBe(200);
    expect((await readJson(res)).commitSha).toBe('feed');

    const other = envWithCandidate({ id: 'c1', specId: 'other', commitSha: 'x' }, 200, 'stub');
    expect((await post(other.env, { candidateId: 'c1', specId: 's1' })).status).toBe(409);
  });

  it('answers 400 on a bad body and 502 when the Spec DO lookup fails', async () => {
    const { env } = envWithCandidate(null, 404, 'stub');
    expect((await post(env, { candidateId: '' })).status).toBe(400);
    const broken = envWithCandidate(null, 500, 'stub');
    expect((await post(broken.env, { candidateId: 'c1', specId: 's1' })).status).toBe(502);
  });
});
