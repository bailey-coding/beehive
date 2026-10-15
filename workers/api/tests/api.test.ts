/**
 * Unit tests for Beehive API Worker (workers/api/index.ts)
 * 
 * Tests cover:
 * - API Handlers (12 tests)
 * - Spec DO Operations (10 tests)
 * - Shared Utilities (6 tests)
 * 
 * Total: 28 tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Import the handler
// Note: We import the default export which is the worker handler
import worker from '../index';

// ============================================================================
// Mock Environment
// ============================================================================

const mockSpecDoStub = {
  fetch: vi.fn(),
};

const mockSpecDoNamespace = {
  idFromName: vi.fn().mockReturnValue('do-id-123'),
  get: vi.fn().mockReturnValue(mockSpecDoStub),
};

const mockEnv = {
  SPEC_DO: mockSpecDoNamespace,
  API_AUTH_TOKEN: 'test-auth-token',
};

const mockCtx = {};

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

// ============================================================================
// API Handlers Tests (12 tests)
// ============================================================================

describe('API Handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock implementations
    mockSpecDoStub.fetch.mockReset();
    mockSpecDoNamespace.idFromName.mockReturnValue('do-id-123');
    mockSpecDoNamespace.get.mockReturnValue(mockSpecDoStub);
  });

  // ========================================================================
  // Health Check
  // ========================================================================

  describe('GET /health', () => {
    it('should return healthy status with correct structure', async () => {
      const request = createRequest('/health', 'GET', undefined, {
        Authorization: 'Bearer test-auth-token',
      });
      
      const response = await worker.fetch(request, mockEnv, mockCtx);
      
      expect(response.status).toBe(200);
      const data = await response.json();
      
      expect(data.success).toBe(true);
      expect(data.data.status).toBe('healthy');
      expect(data.data.version).toBeDefined();
      expect(data.data.timestamp).toBeDefined();
      expect(data.data.checks).toBeDefined();
    });

    it('should return 401 for missing auth token', async () => {
      const request = createRequest('/health', 'GET');
      const response = await worker.fetch(request, mockEnv, mockCtx);
      
      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe('Unauthorized');
    });

    it('should return 503 when API_AUTH_TOKEN not configured', async () => {
      const request = createRequest('/health', 'GET');
      const response = await worker.fetch(request, { SPEC_DO: mockSpecDoNamespace }, mockCtx);
      
      expect(response.status).toBe(503);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe('API_AUTH_TOKEN not configured');
    });
  });

  // ========================================================================
  // Organizations
  // ========================================================================

  describe('POST /api/organizations', () => {
    it('should create organization with valid data', async () => {
      const orgData = {
        name: 'Test Org',
        description: 'Test organization',
      };
      
      // Mock Spec DO response
      mockSpecDoStub.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ 
          success: true, 
          data: { id: 'org-123', name: 'Test Org' } 
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      
      const request = createRequest('/api/organizations', 'POST', orgData, {
        Authorization: 'Bearer test-auth-token',
      });
      
      const response = await worker.fetch(request, mockEnv, mockCtx);
      
      expect(response.status).toBe(200);
      expect(mockSpecDoStub.fetch).toHaveBeenCalled();
      
      // sendToSpecDo forwards a Request object to the DO stub
      const forwarded = mockSpecDoStub.fetch.mock.calls[0][0] as Request;
      expect(forwarded.method).toBe('POST');
      expect(new URL(forwarded.url).pathname).toBe('/api/organizations');
      expect(forwarded.headers.get('Content-Type')).toBe('application/json');
    });

    it('should return 401 for missing auth', async () => {
      const orgData = { name: 'Test Org' };
      const request = createRequest('/api/organizations', 'POST', orgData);
      const response = await worker.fetch(request, mockEnv, mockCtx);
      
      expect(response.status).toBe(401);
      expect(mockSpecDoStub.fetch).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/organizations', () => {
    it('should list organizations with default pagination', async () => {
      mockSpecDoStub.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ 
          success: true, 
          data: [{ id: 'org-1', name: 'Org 1' }] 
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      
      const request = createRequest('/api/organizations', 'GET', undefined, {
        Authorization: 'Bearer test-auth-token',
      });
      
      const response = await worker.fetch(request, mockEnv, mockCtx);
      
      expect(response.status).toBe(200);
      expect(mockSpecDoStub.fetch).toHaveBeenCalled();
      
      // Verify pagination defaults
      const callArgs = mockSpecDoStub.fetch.mock.calls[0];
      const requestUrl = (callArgs[0] as Request).url;
      expect(requestUrl).toContain('limit=50');
      expect(requestUrl).toContain('offset=0');
    });

    it('should respect custom pagination parameters', async () => {
      mockSpecDoStub.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, data: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      
      const request = createRequest('/api/organizations?limit=10&offset=20', 'GET', undefined, {
        Authorization: 'Bearer test-auth-token',
      });
      
      const response = await worker.fetch(request, mockEnv, mockCtx);
      
      expect(response.status).toBe(200);
      const callArgs = mockSpecDoStub.fetch.mock.calls[0];
      const requestUrl = (callArgs[0] as Request).url;
      expect(requestUrl).toContain('limit=10');
      expect(requestUrl).toContain('offset=20');
    });
  });

  describe('GET /api/organizations/:id', () => {
    it('should return organization by ID', async () => {
      mockSpecDoStub.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ 
          success: true, 
          data: { id: 'org-123', name: 'Test Org' } 
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      
      const request = createRequest('/api/organizations/org-123', 'GET', undefined, {
        Authorization: 'Bearer test-auth-token',
      });
      
      const response = await worker.fetch(request, mockEnv, mockCtx);
      
      expect(response.status).toBe(200);
      expect(mockSpecDoStub.fetch).toHaveBeenCalled();
      
      const callArgs = mockSpecDoStub.fetch.mock.calls[0];
      const requestUrl = (callArgs[0] as Request).url;
      expect(requestUrl).toContain('/api/organizations/org-123');
    });

    it('should return 404 for non-existent organization', async () => {
      mockSpecDoStub.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ 
          success: false, 
          error: 'Not found' 
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      
      const request = createRequest('/api/organizations/org-999', 'GET', undefined, {
        Authorization: 'Bearer test-auth-token',
      });
      
      const response = await worker.fetch(request, mockEnv, mockCtx);
      
      expect(response.status).toBe(404);
    });
  });

  // ========================================================================
  // Public Pages (no auth required)
  // ========================================================================

  describe('GET / (root)', () => {
    it('should return HTML for root path without auth', async () => {
      const request = createRequest('/', 'GET');
      const response = await worker.fetch(request, mockEnv, mockCtx);
      
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('text/html');
      const html = await response.text();
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('Beehive');
    });
  });

  describe('GET /about', () => {
    it('should return HTML for about page without auth', async () => {
      const request = createRequest('/about', 'GET');
      const response = await worker.fetch(request, mockEnv, mockCtx);
      
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('text/html');
      const html = await response.text();
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('About');
    });
  });

  describe('GET /roadmap', () => {
    it('should return HTML for roadmap page without auth', async () => {
      const request = createRequest('/roadmap', 'GET');
      const response = await worker.fetch(request, mockEnv, mockCtx);
      
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('text/html');
      const html = await response.text();
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('Roadmap');
    });
  });

  // ========================================================================
  // Specs
  // ========================================================================

  describe('POST /api/specs', () => {
    it('should create spec with valid data', async () => {
      const specData = {
        name: 'test-spec',
        description: 'Test spec',
        contract: '{}',
        declaredDeltaSurface: ['endpoint1'],
        organizationId: 'org-1',
      };
      
      mockSpecDoStub.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ 
          success: true, 
          data: { id: 'spec-123', name: 'test-spec' } 
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      
      const request = createRequest('/api/specs', 'POST', specData, {
        Authorization: 'Bearer test-auth-token',
      });
      
      const response = await worker.fetch(request, mockEnv, mockCtx);
      
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
    });

    it('should return 400 for invalid spec data', async () => {
      const invalidData = { name: '' };
      
      mockSpecDoStub.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ 
          success: false, 
          error: 'Validation failed' 
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      
      const request = createRequest('/api/specs', 'POST', invalidData, {
        Authorization: 'Bearer test-auth-token',
      });
      
      const response = await worker.fetch(request, mockEnv, mockCtx);
      
      expect(response.status).toBe(400);
    });
  });

  describe('GET /api/specs', () => {
    it('should list all specs', async () => {
      mockSpecDoStub.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ 
          success: true, 
          data: [{ id: 'spec-1', name: 'Spec 1' }] 
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      
      const request = createRequest('/api/specs', 'GET', undefined, {
        Authorization: 'Bearer test-auth-token',
      });
      
      const response = await worker.fetch(request, mockEnv, mockCtx);
      
      expect(response.status).toBe(200);
    });
  });
});

// ============================================================================
// Spec DO Operations Tests (10 tests)
// ============================================================================

describe('Spec DO Operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpecDoStub.fetch.mockReset();
    mockSpecDoNamespace.idFromName.mockReturnValue('do-id-123');
    mockSpecDoNamespace.get.mockReturnValue(mockSpecDoStub);
  });

  describe('Spec CRUD', () => {
    it('should create spec in DO storage', async () => {
      mockSpecDoStub.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ 
          success: true, 
          data: { id: 'spec-123' } 
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      
      const specData = {
        name: 'test-spec',
        description: 'Test',
        contract: '{}',
        organizationId: 'org-1',
      };
      
      const request = createRequest('/api/specs', 'POST', specData, {
        Authorization: 'Bearer test-auth-token',
      });
      
      const response = await worker.fetch(request, mockEnv, mockCtx);
      
      expect(response.status).toBe(200);
      expect(mockSpecDoNamespace.idFromName).toHaveBeenCalledWith('main');
      expect(mockSpecDoNamespace.get).toHaveBeenCalledWith('do-id-123');
    });

    it('should read spec from DO storage', async () => {
      mockSpecDoStub.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ 
          success: true, 
          data: { id: 'spec-123', name: 'test-spec' } 
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      
      const request = createRequest('/api/specs/spec-123', 'GET', undefined, {
        Authorization: 'Bearer test-auth-token',
      });
      
      const response = await worker.fetch(request, mockEnv, mockCtx);
      
      expect(response.status).toBe(200);
    });
  });

  describe('Candidate Management', () => {
    it('should create candidate linked to spec', async () => {
      mockSpecDoStub.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ 
          success: true, 
          data: { id: 'cand-123', specId: 'spec-123' } 
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      
      const candidateData = {
        specId: 'spec-123',
        repositoryId: 'repo-123',
      };
      
      const request = createRequest('/api/candidates', 'POST', candidateData, {
        Authorization: 'Bearer test-auth-token',
      });
      
      const response = await worker.fetch(request, mockEnv, mockCtx);
      
      expect(response.status).toBe(200);
    });

    it('should store candidate state', async () => {
      // Candidate state is managed through Spec DO
      mockSpecDoStub.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ 
          success: true, 
          data: { id: 'cand-123', stage: 'created' } 
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      
      const request = createRequest('/api/candidates/cand-123', 'GET', undefined, {
        Authorization: 'Bearer test-auth-token',
      });
      
      const response = await worker.fetch(request, mockEnv, mockCtx);
      
      expect(response.status).toBe(200);
    });
  });

  describe('Gate Verdict Storage', () => {
    it('should store gate verdict for candidate', async () => {
      mockSpecDoStub.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ 
          success: true, 
          data: { id: 'verdict-123' } 
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      
      const verdictData = {
        candidateId: 'cand-123',
        gateType: 'pre-merge',
        verdict: 'PASS',
        score: 0.95,
      };
      
      const request = createRequest('/api/gate-verdicts', 'POST', verdictData, {
        Authorization: 'Bearer test-auth-token',
      });
      
      const response = await worker.fetch(request, mockEnv, mockCtx);
      
      expect(response.status).toBe(200);
    });

    it('should retrieve all verdicts for candidate', async () => {
      mockSpecDoStub.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ 
          success: true, 
          data: [{ id: 'verdict-1' }, { id: 'verdict-2' }] 
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      
      const request = createRequest('/api/candidates/cand-123/gate-verdicts', 'GET', undefined, {
        Authorization: 'Bearer test-auth-token',
      });
      
      const response = await worker.fetch(request, mockEnv, mockCtx);
      
      expect(response.status).toBe(200);
    });
  });
});

// ============================================================================
// Shared Tests (6 tests)
// ============================================================================

describe('Shared Utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpecDoStub.fetch.mockReset();
  });

  describe('Auth Middleware', () => {
    it('should return 401 for missing token', async () => {
      const request = createRequest('/api/specs');
      const response = await worker.fetch(request, mockEnv, mockCtx);
      
      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe('Unauthorized');
    });

    it('should return 401 for invalid token', async () => {
      const request = createRequest('/api/specs', 'GET', undefined, {
        Authorization: 'Bearer invalid-token',
      });
      const response = await worker.fetch(request, mockEnv, mockCtx);
      
      expect(response.status).toBe(401);
    });

    it('should return 503 when API_AUTH_TOKEN not configured', async () => {
      const request = createRequest('/api/specs');
      const response = await worker.fetch(request, { SPEC_DO: mockSpecDoNamespace }, mockCtx);
      
      expect(response.status).toBe(503);
      const data = await response.json();
      expect(data.error).toBe('API_AUTH_TOKEN not configured');
    });
  });

  describe('Error Handling', () => {
    it('should handle DO errors gracefully', async () => {
      mockSpecDoStub.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ 
          success: false, 
          error: 'Internal error' 
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      
      const request = createRequest('/api/specs/spec-999', 'GET', undefined, {
        Authorization: 'Bearer test-auth-token',
      });
      
      const response = await worker.fetch(request, mockEnv, mockCtx);
      
      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.success).toBe(false);
    });

    it('should return proper error format', async () => {
      mockSpecDoStub.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ 
          success: false, 
          error: 'Test error message',
          timestamp: Date.now()
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      
      const request = createRequest('/api/organizations', 'POST', { name: '' }, {
        Authorization: 'Bearer test-auth-token',
      });
      
      const response = await worker.fetch(request, mockEnv, mockCtx);
      const data = await response.json();
      
      expect(data.success).toBe(false);
      expect(data.error).toBeDefined();
      expect(data.timestamp).toBeDefined();
    });
  });

  describe('Schema Validation', () => {
    it('should validate spec input', async () => {
      // Missing required fields
      mockSpecDoStub.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ 
          success: false, 
          error: 'Validation failed' 
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      
      const request = createRequest('/api/specs', 'POST', { name: '' }, {
        Authorization: 'Bearer test-auth-token',
      });
      
      const response = await worker.fetch(request, mockEnv, mockCtx);
      
      expect(response.status).toBe(400);
    });
  });
});
