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

// Queue messages as the runtime delivers them: attempts starts at 1, retry/ack are spies
function makeMessage(body: unknown, overrides: Record<string, unknown> = {}) {
  return { id: 'msg-1', body, timestamp: Date.now(), attempts: 1, retry: vi.fn(), ack: vi.fn(), ...overrides };
}

// Fills in the runtime-provided fields on legacy test literals, then runs the consumer
function runQueue(batch: MessageBatch<any>, env: unknown): Promise<void> {
  for (const m of batch.messages as any[]) {
    m.retry ??= vi.fn();
    m.ack ??= vi.fn();
    m.attempts ??= 1;
  }
  return worker.queue(batch, env as any, mockCtx as any);
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
      await runQueue(batch, mockEnv);

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

      await runQueue(batch, mockEnv);

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

      await runQueue(batch, mockEnv);

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
      await expect(runQueue(batch, mockEnv)).resolves.toBeUndefined();
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

      await runQueue(batch, mockEnv);

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

      await runQueue(batch, { ...mockEnv, preview_artifacts_push: mockQueueBinding });

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
      await expect(runQueue(batch, mockEnv)).resolves.toBeUndefined();
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

      await runQueue(batch, mockEnv);

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

      await runQueue(batch, mockEnv);

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

      await runQueue(batch, { ...mockEnv, preview_artifacts_push: mockQueueBinding });

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
      await expect(runQueue(batch, mockEnv)).resolves.toBeUndefined();
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

      await runQueue(batch, mockEnv);
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

      await runQueue(batch, mockEnv);
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

      await runQueue(batch, mockEnv);
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

      await runQueue(batch, { ...mockEnv, preview_artifacts_push: mockQueueBinding });
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

// ============================================================================
// Retry, classification and idempotency (docs/M5A-2-IMPL-PLAN.md section 2)
// ============================================================================

describe('Retry, classification and idempotency', () => {
  const QUEUE = 'beehive-artifacts-push';

  function pushBody(id = 'evt-1') {
    return {
      event: {
        id,
        type: 'push' as const,
        repository: { name: 'repo', namespace: 'ns', full_name: 'ns/repo' },
        commit: { sha: 'abc123' },
        ref: 'main',
        created_at: '2026-10-30T00:00:00Z',
      },
      received_at: Date.now(),
    };
  }

  type Routes = { repos?: Response | Error; candidates?: Response | Error; history?: Response | Error };
  let specDoRequests: Request[];

  // Spec DO stub keyed by path; the defaults describe a repo with one candidate and a history write that works
  function stubSpecDo(routes: Routes = {}) {
    specDoRequests = [];
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    mockSpecDoStub.fetch.mockImplementation(async (req: Request) => {
      specDoRequests.push(req.clone());
      const path = new URL(req.url).pathname;
      const pick = (r: Response | Error | undefined, dflt: Response) => {
        if (r instanceof Error) throw r;
        return r ?? dflt;
      };
      if (path === '/api/repositories') return pick(routes.repos, json({ data: [{ id: 'repo-1', remote_url: 'ns/repo' }] }));
      if (path === '/api/candidates') return pick(routes.candidates, json({ data: [{ id: 'cand-1', repositoryId: 'repo-1', specId: 'spec-1' }] }));
      if (path.endsWith('/history')) return pick(routes.history, json({ success: true }, 201));
      return json({ error: 'Not found' }, 404);
    });
  }

  function stubGate(response: Response | Error = Response.json({ success: true }, { status: 201 })) {
    mockGateWorkflowService.fetch.mockImplementation(async () => {
      if (response instanceof Error) throw response;
      return response.clone();
    });
  }

  async function run(overrides: Record<string, unknown> = {}, opts: { queue?: string; env?: Record<string, unknown>; id?: string } = {}) {
    const message = makeMessage(pushBody(opts.id), overrides);
    const batch = { queue: opts.queue ?? QUEUE, messages: [message] } as unknown as MessageBatch<any>;
    await runQueue(batch, { ...mockEnv, ...opts.env });
    return message;
  }

  const status = (code: number, body: unknown = {}) => Response.json(body, { status: code });

  beforeEach(() => {
    vi.clearAllMocks();
    mockSpecDoStub.fetch.mockReset();
    mockGateWorkflowService.fetch.mockReset();
    mockPreviewManagerService.fetch.mockReset();
    stubSpecDo();
    stubGate();
  });

  it('sends keyed gate and history requests and does not retry on success', async () => {
    const message = await run();
    expect(message.retry).not.toHaveBeenCalled();
    const gate = mockGateWorkflowService.fetch.mock.calls[0][0] as Request;
    expect(gate.headers.get('Idempotency-Key')).toBe(`${QUEUE}:evt-1:gate`);
    const history = specDoRequests.find((r) => r.url.endsWith('/history'))!;
    expect(history.headers.get('Idempotency-Key')).toBe(`${QUEUE}:evt-1`);
  });

  it('a redelivery sends the same keys', async () => {
    await run();
    await run();
    const keys = mockGateWorkflowService.fetch.mock.calls.map((c) => (c[0] as Request).headers.get('Idempotency-Key'));
    expect(keys[0]).toBe(keys[1]);
    const historyKeys = specDoRequests.filter((r) => r.url.endsWith('/history')).map((r) => r.headers.get('Idempotency-Key'));
    expect(historyKeys[0]).toBe(historyKeys[1]);
  });

  it('hashes an over-long event key so both keys stay within 255 characters', async () => {
    await run({}, { id: 'e'.repeat(300) });
    const gateKey = (mockGateWorkflowService.fetch.mock.calls[0][0] as Request).headers.get('Idempotency-Key')!;
    const historyKey = specDoRequests.find((r) => r.url.endsWith('/history'))!.headers.get('Idempotency-Key')!;
    expect(historyKey.startsWith('h1:')).toBe(true);
    expect(gateKey).toBe(`${historyKey}:gate`);
    expect(gateKey.length).toBeLessThanOrEqual(255);
  });

  describe('gate answers', () => {
    it.each([500, 503, 408, 429, 401, 403])('retries on %i', async (code) => {
      stubGate(status(code));
      const message = await run();
      expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    });

    it.each([400, 404, 422])('drops on %i without retry', async (code) => {
      stubGate(status(code));
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const message = await run();
      expect(message.retry).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(expect.stringContaining('permanent'));
      error.mockRestore();
    });

    it('retries soon on a 409 inFlight, drops a plain 409', async () => {
      stubGate(status(409, { inFlight: true }));
      const inFlight = await run();
      expect(inFlight.retry).toHaveBeenCalledWith({ delaySeconds: 35 });

      stubGate(status(409, { error: 'Idempotency key conflict' }));
      const conflict = await run();
      expect(conflict.retry).not.toHaveBeenCalled();
    });

    it('keeps retrying an in-flight run long enough to outlast the gate stale window (120 s)', async () => {
      stubGate(status(409, { inFlight: true }));
      let waited = 0;
      for (const attempts of [1, 2, 3, 4]) {
        const message = await run({ attempts });
        waited += (message.retry.mock.calls[0][0] as { delaySeconds: number }).delaySeconds;
      }
      expect(waited).toBeGreaterThan(120);
    });

    it('retries when the gate fetch throws', async () => {
      stubGate(new Error('service unavailable'));
      const message = await run();
      expect(message.retry).toHaveBeenCalled();
    });

    it('does not write history when the gate failed', async () => {
      stubGate(status(503));
      await run();
      expect(specDoRequests.some((r) => r.url.endsWith('/history'))).toBe(false);
    });
  });

  describe('history answers', () => {
    it('retries on a 5xx', async () => {
      stubSpecDo({ history: status(503) });
      expect((await run()).retry).toHaveBeenCalled();
    });

    it('logs and drops a 409 as a key reused with a different body', async () => {
      stubSpecDo({ history: status(409) });
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const message = await run();
      expect(message.retry).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(expect.stringContaining('different body'));
      error.mockRestore();
    });

    it('drops a 400', async () => {
      stubSpecDo({ history: status(400) });
      expect((await run()).retry).not.toHaveBeenCalled();
    });

    it('treats a replay (201 + Idempotent-Replay) as success', async () => {
      stubSpecDo({ history: Response.json({ success: true }, { status: 201, headers: { 'Idempotent-Replay': 'true' } }) });
      expect((await run()).retry).not.toHaveBeenCalled();
    });
  });

  describe('lookups', () => {
    it('retries when the repository is not found yet, then gives up at the attempt cap', async () => {
      stubSpecDo({ repos: Response.json({ data: [] }) });
      expect((await run()).retry).toHaveBeenCalledWith({ delaySeconds: 30 });
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const last = await run({ attempts: 5 });
      expect(last.retry).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(expect.stringContaining('Giving up'));
      error.mockRestore();
    });

    it('retries when the candidate is not found yet', async () => {
      stubSpecDo({ candidates: Response.json({ data: [] }) });
      expect((await run()).retry).toHaveBeenCalled();
    });

    it('retries a Spec DO 5xx or 401 and drops a 404 on the repositories lookup', async () => {
      stubSpecDo({ repos: status(503) });
      expect((await run()).retry).toHaveBeenCalled();
      stubSpecDo({ repos: status(401) });
      expect((await run()).retry).toHaveBeenCalled();
      stubSpecDo({ repos: status(404) });
      expect((await run()).retry).not.toHaveBeenCalled();
    });

    it('retries when a lookup body is not JSON', async () => {
      stubSpecDo({ repos: new Response('not json', { status: 200 }) });
      expect((await run()).retry).toHaveBeenCalled();
    });
  });

  it('retries slowly when API_AUTH_TOKEN is not configured', async () => {
    const message = await run({}, { env: { API_AUTH_TOKEN: undefined } });
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 3600 });
    expect(mockGateWorkflowService.fetch).not.toHaveBeenCalled();
  });

  it('drops a message that fails validation without retry', async () => {
    const message = makeMessage({ event: { id: '' } });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runQueue({ queue: QUEUE, messages: [message] } as unknown as MessageBatch<any>, mockEnv);
    expect(message.retry).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('backs off exponentially, capped at 900 seconds, and gives up at attempt 5', async () => {
    stubGate(status(503));
    const delays: Array<number | undefined> = [];
    for (const attempts of [1, 2, 3, 4]) {
      const message = await run({ attempts });
      delays.push((message.retry.mock.calls[0]?.[0] as { delaySeconds?: number } | undefined)?.delaySeconds);
    }
    expect(delays).toEqual([30, 60, 120, 240]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await run({ attempts: 5 })).retry).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('one bad message does not stop or retry the others in the batch', async () => {
    const bad = makeMessage({ event: { id: '' } }, { id: 'bad' });
    const good = makeMessage(pushBody('evt-ok'), { id: 'good' });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runQueue({ queue: QUEUE, messages: [bad, good] } as unknown as MessageBatch<any>, mockEnv);
    error.mockRestore();
    expect(bad.retry).not.toHaveBeenCalled();
    expect(good.retry).not.toHaveBeenCalled();
    expect(mockGateWorkflowService.fetch).toHaveBeenCalledTimes(1);
  });

  describe('preview deployment (best effort)', () => {
    const PREVIEW_QUEUE = 'preview-artifacts-push';

    it('runs on the first delivery only', async () => {
      mockPreviewManagerService.fetch.mockResolvedValue(Response.json({ success: true }));
      await run({}, { queue: PREVIEW_QUEUE });
      expect(mockPreviewManagerService.fetch).toHaveBeenCalledTimes(1);
      await run({ attempts: 2 }, { queue: PREVIEW_QUEUE });
      expect(mockPreviewManagerService.fetch).toHaveBeenCalledTimes(1);
    });

    it('a preview failure never causes a retry', async () => {
      mockPreviewManagerService.fetch.mockRejectedValue(new Error('preview down'));
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const message = await run({}, { queue: PREVIEW_QUEUE });
      error.mockRestore();
      expect(message.retry).not.toHaveBeenCalled();
    });
  });
});
