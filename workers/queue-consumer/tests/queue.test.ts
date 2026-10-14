/**
 * Unit tests for Beehive Queue Consumer Worker (workers/queue-consumer/index.ts)
 * 
 * Tests cover:
 * - Message Processing (10 tests)
 * - Queue Bindings (6 tests)
 * 
 * Total: 16 tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Import the handler
import worker from '../index';
import type { MessageBatch } from '@cloudflare/workers-types';

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

const mockGateWorkflowService = {
  fetch: vi.fn(),
};

const mockPreviewManagerService = {
  fetch: vi.fn(),
};

const mockQueueBinding = {
  send: vi.fn(),
  sendBatch: vi.fn(),
};

const mockEnv = {
  SPEC_DO: mockSpecDoNamespace,
  GATE_WORKFLOW: mockGateWorkflowService,
  PREVIEW_MANAGER: mockPreviewManagerService,
  API_AUTH_TOKEN: 'test-auth-token',
  preview_artifacts_push: mockQueueBinding,
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
// Message Processing Tests (10 tests)
// ============================================================================

describe('Queue Message Processing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpecDoStub.fetch.mockReset();
    mockGateWorkflowService.fetch.mockReset();
    mockPreviewManagerService.fetch.mockReset();
  });

  describe('Artifacts Push Event', () => {
    it('should parse artifacts push event correctly', async () => {
      // Create a valid queue message
      const validMessage = {
        event: {
          id: 'push-123',
          type: 'push' as const,
          repository: {
            name: 'test-repo',
            namespace: 'test-ns',
            full_name: 'test-ns/test-repo',
          },
          commit: {
            sha: 'abc123',
            message: 'Test commit',
          },
          ref: 'main',
          base_ref: 'main',
          created_at: '2026-10-13T00:00:00Z',
        },
        received_at: Date.now(),
      };

      // Mock Spec DO responses
      mockSpecDoStub.fetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: [{ remote_url: 'test-ns/test-repo', id: 'repo-123' }] }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: [{ repositoryId: 'repo-123', id: 'cand-123' }] }), { status: 200 }));

      mockGateWorkflowService.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), { status: 200 })
      );

      mockSpecDoStub.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), { status: 200 })
      );

      // Create a mock batch
      const batch = {
        queue: 'beehive-artifacts-push',
        messages: [
          {
            id: 'msg-1',
            body: validMessage,
            timestamp: Date.now(),
            retryCount: 0,
          },
        ],
      } as unknown as MessageBatch<any>;

      // Call the queue handler
      await worker.queue(batch, mockEnv, mockCtx);

      // Verify Spec DO was called to fetch repositories
      expect(mockSpecDoStub.fetch).toHaveBeenCalled();
    });

    it('should extract repository info from event', async () => {
      const message = {
        event: {
          id: 'push-123',
          type: 'push' as const,
          repository: {
            name: 'my-repo',
            namespace: 'my-ns',
            full_name: 'my-ns/my-repo',
          },
          commit: {
            sha: 'def456',
            message: 'Another test',
          },
          ref: 'feature-branch',
          created_at: '2026-10-13T00:00:00Z',
        },
        received_at: Date.now(),
      };

      mockSpecDoStub.fetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: [{ remote_url: 'my-ns/my-repo', id: 'repo-456' }] }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: [{ repositoryId: 'repo-456', id: 'cand-456' }] }), { status: 200 }));

      mockGateWorkflowService.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), { status: 200 })
      );

      mockSpecDoStub.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), { status: 200 })
      );

      const batch = {
        queue: 'beehive-artifacts-push',
        messages: [{ id: 'msg-1', body: message, timestamp: Date.now(), retryCount: 0 }],
      } as unknown as MessageBatch<any>;

      await worker.queue(batch, mockEnv, mockCtx);

      // Verify repository info was used in calls
      expect(mockSpecDoStub.fetch).toHaveBeenCalled();
    });

    it('should extract commit info from event', async () => {
      const message = {
        event: {
          id: 'push-123',
          type: 'push' as const,
          repository: {
            name: 'test-repo',
            namespace: 'test-ns',
            full_name: 'test-ns/test-repo',
          },
          commit: {
            sha: 'ghi789',
            message: 'Commit with author',
            author: {
              name: 'Test User',
              email: 'test@example.com',
            },
          },
          ref: 'main',
          created_at: '2026-10-13T00:00:00Z',
        },
        received_at: Date.now(),
      };

      mockSpecDoStub.fetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: [{ remote_url: 'test-ns/test-repo', id: 'repo-789' }] }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: [{ repositoryId: 'repo-789', id: 'cand-789' }] }), { status: 200 }));

      mockGateWorkflowService.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), { status: 200 })
      );

      mockSpecDoStub.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), { status: 200 })
      );

      const batch = {
        queue: 'beehive-artifacts-push',
        messages: [{ id: 'msg-1', body: message, timestamp: Date.now(), retryCount: 0 }],
      } as unknown as MessageBatch<any>;

      await worker.queue(batch, mockEnv, mockCtx);

      // Verify commit info was passed to gate workflow
      expect(mockGateWorkflowService.fetch).toHaveBeenCalled();
      const gateCall = mockGateWorkflowService.fetch.mock.calls[0];
      const gateRequest = gateCall[0] as Request;
      const gateBody = await gateRequest.json();
      expect(gateBody.commitSha).toBe('ghi789');
    });

    it('should handle malformed event data', async () => {
      // Invalid message - missing required fields
      const invalidMessage = {
        event: {
          id: '', // Empty ID
          type: 'push',
          repository: {
            name: '',
            namespace: '',
            full_name: '',
          },
          commit: {
            sha: '',
          },
          ref: '',
          created_at: '',
        },
        received_at: Date.now(),
      };

      // This should cause validation to fail
      const batch = {
        queue: 'beehive-artifacts-push',
        messages: [{ id: 'msg-1', body: invalidMessage, timestamp: Date.now(), retryCount: 0 }],
      } as unknown as MessageBatch<any>;

      // Should not throw, but should handle gracefully
      await expect(worker.queue(batch, mockEnv, mockCtx)).resolves.toBeUndefined();
    });
  });

  describe('Event Type Routing', () => {
    it('should route push events to gate workflow', async () => {
      const message = {
        event: {
          id: 'push-123',
          type: 'push' as const,
          repository: {
            name: 'test-repo',
            namespace: 'test-ns',
            full_name: 'test-ns/test-repo',
          },
          commit: {
            sha: 'abc123',
            message: 'Test',
          },
          ref: 'main',
          created_at: '2026-10-13T00:00:00Z',
        },
        received_at: Date.now(),
      };

      mockSpecDoStub.fetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: [{ remote_url: 'test-ns/test-repo', id: 'repo-123' }] }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: [{ repositoryId: 'repo-123', id: 'cand-123' }] }), { status: 200 }));

      mockGateWorkflowService.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), { status: 200 })
      );

      mockSpecDoStub.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), { status: 200 })
      );

      const batch = {
        queue: 'beehive-artifacts-push',
        messages: [{ id: 'msg-1', body: message, timestamp: Date.now(), retryCount: 0 }],
      } as unknown as MessageBatch<any>;

      await worker.queue(batch, mockEnv, mockCtx);

      expect(mockGateWorkflowService.fetch).toHaveBeenCalled();
    });

    it('should route push events to preview manager when queue is preview-artifacts-push', async () => {
      const message = {
        event: {
          id: 'push-123',
          type: 'push' as const,
          repository: {
            name: 'test-repo',
            namespace: 'test-ns',
            full_name: 'test-ns/test-repo',
          },
          commit: {
            sha: 'abc123',
            message: 'Test',
          },
          ref: 'main',
          created_at: '2026-10-13T00:00:00Z',
        },
        received_at: Date.now(),
      };

      mockSpecDoStub.fetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: [{ remote_url: 'test-ns/test-repo', id: 'repo-123' }] }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: [{ repositoryId: 'repo-123', id: 'cand-123' }] }), { status: 200 }));

      mockPreviewManagerService.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), { status: 200 })
      );

      const batch = {
        queue: 'preview-artifacts-push',
        messages: [{ id: 'msg-1', body: message, timestamp: Date.now(), retryCount: 0 }],
      } as unknown as MessageBatch<any>;

      await worker.queue(batch, { ...mockEnv, preview_artifacts_push: mockQueueBinding }, mockCtx);

      expect(mockPreviewManagerService.fetch).toHaveBeenCalled();
    });

    it('should ignore unknown event types', async () => {
      const message = {
        event: {
          id: 'event-123',
          type: 'unknown' as any,
          repository: {
            name: 'test-repo',
            namespace: 'test-ns',
            full_name: 'test-ns/test-repo',
          },
          commit: {
            sha: 'abc123',
          },
          ref: 'main',
          created_at: '2026-10-13T00:00:00Z',
        },
        received_at: Date.now(),
      };

      // For non-push events, the queue consumer should still process but won't trigger gate
      mockSpecDoStub.fetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: [] }), { status: 200 }));

      const batch = {
        queue: 'beehive-artifacts-push',
        messages: [{ id: 'msg-1', body: message, timestamp: Date.now(), retryCount: 0 }],
      } as unknown as MessageBatch<any>;

      // This might throw due to type validation, but we expect it to be handled
      await expect(worker.queue(batch, mockEnv, mockCtx)).resolves.toBeUndefined();
    });
  });

  describe('Gate Trigger', () => {
    it('should trigger gate workflow for candidate', async () => {
      const message = {
        event: {
          id: 'push-123',
          type: 'push' as const,
          repository: {
            name: 'test-repo',
            namespace: 'test-ns',
            full_name: 'test-ns/test-repo',
          },
          commit: {
            sha: 'abc123',
            message: 'Test commit',
          },
          ref: 'main',
          base_ref: 'main',
          created_at: '2026-10-13T00:00:00Z',
        },
        received_at: Date.now(),
      };

      mockSpecDoStub.fetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: [{ remote_url: 'test-ns/test-repo', id: 'repo-123' }] }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: [{ repositoryId: 'repo-123', id: 'cand-123', specId: 'spec-123' }] }), { status: 200 }));

      mockGateWorkflowService.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, gateId: 'gate-123' }), { status: 200 })
      );

      mockSpecDoStub.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), { status: 200 })
      );

      const batch = {
        queue: 'beehive-artifacts-push',
        messages: [{ id: 'msg-1', body: message, timestamp: Date.now(), retryCount: 0 }],
      } as unknown as MessageBatch<any>;

      await worker.queue(batch, mockEnv, mockCtx);

      expect(mockGateWorkflowService.fetch).toHaveBeenCalled();
      const gateCall = mockGateWorkflowService.fetch.mock.calls[0];
      const gateRequest = gateCall[0] as Request;
      expect(gateRequest.method).toBe('POST');
    });

    it('should pass correct candidate info to gate', async () => {
      const message = {
        event: {
          id: 'push-123',
          type: 'push' as const,
          repository: {
            name: 'test-repo',
            namespace: 'test-ns',
            full_name: 'test-ns/test-repo',
          },
          commit: {
            sha: 'def456',
            message: 'Another test',
          },
          ref: 'feature-branch',
          base_ref: 'main',
          created_at: '2026-10-13T00:00:00Z',
        },
        received_at: Date.now(),
      };

      mockSpecDoStub.fetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: [{ remote_url: 'test-ns/test-repo', id: 'repo-456' }] }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: [{ repositoryId: 'repo-456', id: 'cand-456', specId: 'spec-456', baseCommitSha: 'abc123' }] }), { status: 200 }));

      mockGateWorkflowService.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), { status: 200 })
      );

      mockSpecDoStub.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), { status: 200 })
      );

      const batch = {
        queue: 'beehive-artifacts-push',
        messages: [{ id: 'msg-1', body: message, timestamp: Date.now(), retryCount: 0 }],
      } as unknown as MessageBatch<any>;

      await worker.queue(batch, mockEnv, mockCtx);

      const gateCall = mockGateWorkflowService.fetch.mock.calls[0];
      const gateRequest = gateCall[0] as Request;
      const gateBody = await gateRequest.json();
      expect(gateBody.candidateId).toBe('cand-456');
      expect(gateBody.commitSha).toBe('def456');
    });
  });

  describe('Preview Trigger', () => {
    it('should trigger preview deployment', async () => {
      const message = {
        event: {
          id: 'push-123',
          type: 'push' as const,
          repository: {
            name: 'test-repo',
            namespace: 'test-ns',
            full_name: 'test-ns/test-repo',
          },
          commit: {
            sha: 'abc123',
            message: 'Test commit',
          },
          ref: 'main',
          created_at: '2026-10-13T00:00:00Z',
        },
        received_at: Date.now(),
      };

      mockSpecDoStub.fetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: [{ remote_url: 'test-ns/test-repo', id: 'repo-789' }] }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: [{ repositoryId: 'repo-789', id: 'cand-789' }] }), { status: 200 }));

      mockPreviewManagerService.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, previewId: 'preview-123' }), { status: 200 })
      );

      const batch = {
        queue: 'preview-artifacts-push',
        messages: [{ id: 'msg-1', body: message, timestamp: Date.now(), retryCount: 0 }],
      } as unknown as MessageBatch<any>;

      await worker.queue(batch, { ...mockEnv, preview_artifacts_push: mockQueueBinding }, mockCtx);

      expect(mockPreviewManagerService.fetch).toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('should handle queue processing errors gracefully', async () => {
      // Create a message that will cause an error in processing
      const message = {
        event: {
          id: 'push-123',
          type: 'push' as const,
          repository: {
            name: 'test-repo',
            namespace: 'test-ns',
            full_name: 'test-ns/test-repo',
          },
          commit: {
            sha: 'abc123',
            message: 'Test',
          },
          ref: 'main',
          created_at: '2026-10-13T00:00:00Z',
        },
        received_at: Date.now(),
      };

      // Mock Spec DO to return error
      mockSpecDoStub.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false, error: 'Not found' }), { status: 404 })
      );

      const batch = {
        queue: 'beehive-artifacts-push',
        messages: [{ id: 'msg-1', body: message, timestamp: Date.now(), retryCount: 0 }],
      } as unknown as MessageBatch<any>;

      // Should not throw
      await expect(worker.queue(batch, mockEnv, mockCtx)).resolves.toBeUndefined();
    });
  });
});

// ============================================================================
// Queue Binding Tests (6 tests)
// ============================================================================

describe('Queue Bindings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpecDoStub.fetch.mockReset();
  });

  describe('beehive-artifacts-push', () => {
    it('should consume messages from queue via fetch', async () => {
      // Queue consumer receives messages via the queue() function
      const message = {
        event: {
          id: 'push-123',
          type: 'push' as const,
          repository: {
            name: 'test-repo',
            namespace: 'test-ns',
            full_name: 'test-ns/test-repo',
          },
          commit: {
            sha: 'abc123',
            message: 'Test',
          },
          ref: 'main',
          created_at: '2026-10-13T00:00:00Z',
        },
        received_at: Date.now(),
      };

      mockSpecDoStub.fetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: [] }), { status: 200 }));

      const batch = {
        queue: 'beehive-artifacts-push',
        messages: [{ id: 'msg-1', body: message, timestamp: Date.now(), retryCount: 0 }],
      } as unknown as MessageBatch<any>;

      await worker.queue(batch, mockEnv, mockCtx);
      expect(mockSpecDoStub.fetch).toHaveBeenCalled();
    });

    it('should handle batch messages', async () => {
      const messages = [
        {
          id: 'msg-1',
          body: {
            event: {
              id: 'push-1',
              type: 'push' as const,
              repository: { name: 'repo-1', namespace: 'ns', full_name: 'ns/repo-1' },
              commit: { sha: 'a1' },
              ref: 'main',
              created_at: '2026-10-13T00:00:00Z',
            },
            received_at: Date.now(),
          },
          timestamp: Date.now(),
          retryCount: 0,
        },
        {
          id: 'msg-2',
          body: {
            event: {
              id: 'push-2',
              type: 'push' as const,
              repository: { name: 'repo-2', namespace: 'ns', full_name: 'ns/repo-2' },
              commit: { sha: 'a2' },
              ref: 'main',
              created_at: '2026-10-13T00:00:00Z',
            },
            received_at: Date.now(),
          },
          timestamp: Date.now(),
          retryCount: 0,
        },
      ];

      mockSpecDoStub.fetch
        .mockResolvedValue(new Response(JSON.stringify({ success: true, data: [] }), { status: 200 }));

      const batch = {
        queue: 'beehive-artifacts-push',
        messages: messages as any,
      } as unknown as MessageBatch<any>;

      await worker.queue(batch, mockEnv, mockCtx);
      expect(mockSpecDoStub.fetch).toHaveBeenCalled();
    });
  });

  describe('Service Bindings', () => {
    it('should call SPEC_DO service correctly', async () => {
      const message = {
        event: {
          id: 'push-123',
          type: 'push' as const,
          repository: {
            name: 'test-repo',
            namespace: 'test-ns',
            full_name: 'test-ns/test-repo',
          },
          commit: {
            sha: 'abc123',
            message: 'Test',
          },
          ref: 'main',
          created_at: '2026-10-13T00:00:00Z',
        },
        received_at: Date.now(),
      };

      mockSpecDoStub.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, data: [] }), { status: 200 })
      );

      const batch = {
        queue: 'beehive-artifacts-push',
        messages: [{ id: 'msg-1', body: message, timestamp: Date.now(), retryCount: 0 }],
      } as unknown as MessageBatch<any>;

      await worker.queue(batch, mockEnv, mockCtx);
      expect(mockSpecDoNamespace.idFromName).toHaveBeenCalled();
      expect(mockSpecDoNamespace.get).toHaveBeenCalled();
    });

    it('should call PREVIEW_MANAGER service correctly', async () => {
      const message = {
        event: {
          id: 'push-123',
          type: 'push' as const,
          repository: {
            name: 'test-repo',
            namespace: 'test-ns',
            full_name: 'test-ns/test-repo',
          },
          commit: {
            sha: 'abc123',
            message: 'Test',
          },
          ref: 'main',
          created_at: '2026-10-13T00:00:00Z',
        },
        received_at: Date.now(),
      };

      mockSpecDoStub.fetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: [{ remote_url: 'test-ns/test-repo', id: 'repo-123' }] }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: [{ repositoryId: 'repo-123', id: 'cand-123' }] }), { status: 200 }));

      mockPreviewManagerService.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), { status: 200 })
      );

      const batch = {
        queue: 'preview-artifacts-push',
        messages: [{ id: 'msg-1', body: message, timestamp: Date.now(), retryCount: 0 }],
      } as unknown as MessageBatch<any>;

      await worker.queue(batch, { ...mockEnv, preview_artifacts_push: mockQueueBinding }, mockCtx);
      expect(mockPreviewManagerService.fetch).toHaveBeenCalled();
    });
  });
});

// ============================================================================
// Health Check Tests (3 tests)
// ============================================================================

describe('Health Checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return healthy status', async () => {
    const request = createRequest('/health', 'GET', undefined, {
      Authorization: 'Bearer test-auth-token',
    });
    
    const response = await worker.fetch(request, mockEnv, mockCtx);
    
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.status).toBe('healthy');
    expect(data.timestamp).toBeDefined();
  });

  it('should return 401 for missing auth', async () => {
    const request = createRequest('/health', 'GET');
    const response = await worker.fetch(request, mockEnv, mockCtx);
    
    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.success).toBe(false);
  });

  it('should return 401 for wrong auth', async () => {
    const request = createRequest('/health', 'GET', undefined, {
      Authorization: 'Bearer wrong-token',
    });
    const response = await worker.fetch(request, mockEnv, mockCtx);
    
    expect(response.status).toBe(401);
  });
});
