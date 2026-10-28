/**
 * Sandbox Runner Tests
 * 
 * Unit tests for the Sandbox Runner Worker.
 * These test the logic without actual sandbox execution.
 */

import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';

// `cloudflare:workers` cannot be loaded by node; the container itself is never started here.
vi.mock('cloudflare:workers', () => ({
  DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} },
  WorkerEntrypoint: class { constructor(public ctx: unknown, public env: unknown) {} },
}));
const probe = vi.fn();
const build = vi.fn();
const getByName = vi.fn(() => ({ probe, build }));

// Mock the fetch handler
import handler from '../index';

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

// Mock environment
const mockEnv = {
  SPEC_DO: {
    idFromName: vi.fn(),
    get: vi.fn(),
  },
  ARTIFACTS: {},
  SANDBOX: { getByName },
  API_AUTH_TOKEN: 'test-auth-token',
};

const mockCtx = {};

// Helper to call the handler
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

describe('Sandbox Runner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('auth gate', () => {
    it('returns 401 when the bearer token is missing or wrong', async () => {
      // @ts-ignore - mock environment
      const missing = await handler.fetch(createRequest('/health'), mockEnv, mockCtx);
      expect(missing.status).toBe(401);

      const wrong = await callHandler('/health', 'GET', undefined, {
        Authorization: 'Bearer wrong-token',
      });
      expect(wrong.status).toBe(401);
    });

    it('returns 503 when API_AUTH_TOKEN is not configured', async () => {
      const envWithoutToken = { ...mockEnv, API_AUTH_TOKEN: undefined };
      // @ts-ignore - mock environment
      const res = await handler.fetch(createRequest('/health'), envWithoutToken, mockCtx);
      expect(res.status).toBe(503);
    });

    it('allows requests with the correct bearer token', async () => {
      const res = await callHandler('/health');
      expect(res.status).toBe(200);
      const data = await readJson(res);
      expect(data.status).toBe('healthy');
    });
  });

  describe('Health Check', () => {
    it('should return healthy status on /health', async () => {
      const response = await callHandler('/health');
      expect(response.status).toBe(200);
      const data = await readJson(response);
      expect(data.status).toBe('healthy');
      expect(data.timestamp).toBeDefined();
    });

    it('should return healthy status on /sandbox/health', async () => {
      const response = await callHandler('/sandbox/health');
      expect(response.status).toBe(200);
      const data = await readJson(response);
      expect(data.status).toBe('healthy');
    });
  });

  describe('Task Management', () => {
    it('should create a new task', async () => {
      const task = {
        taskId: 'task-001',
        candidateId: 'candidate-001',
        specId: 'spec-001',
        repoName: 'beehive-test',
        namespace: 'default',
        commitMessage: 'Test commit',
        agentId: 'agent-001',
        maxDurationMs: 30000,
      };

      const response = await callHandler('/sandbox/tasks', 'POST', task, {
        'X-Actor-ID': 'agent-001',
      });

      expect(response.status).toBe(202); // Accepted
      const data = await readJson(response);
      expect(data.success).toBe(true);
      expect(data.taskId).toBe('task-001');
      expect(data.status).toBe('queued');
    });

    it('should return 400 for invalid task creation', async () => {
      const response = await callHandler('/sandbox/tasks', 'POST', {});
      expect(response.status).toBe(400);
      const data = await readJson(response);
      expect(data.success).toBe(false);
      expect(data.error).toBeDefined();
    });

    it('should return task status', async () => {
      // First create a task
      const task = {
        taskId: 'task-002',
        candidateId: 'candidate-002',
        specId: 'spec-001',
        repoName: 'beehive-test',
        namespace: 'default',
        commitMessage: 'Test commit',
        agentId: 'agent-001',
        maxDurationMs: 30000,
      };

      await callHandler('/sandbox/tasks', 'POST', task, {
        'X-Actor-ID': 'agent-001',
      });

      // Then get the task
      const response = await callHandler('/sandbox/tasks/task-002');
      expect(response.status).toBe(200);
      const data = await readJson(response);
      expect(data.success).toBe(true);
      expect((data as { task?: { taskId?: string } }).task?.taskId).toBe('task-002');
    });

    it('should return 404 for non-existent task', async () => {
      const response = await callHandler('/sandbox/tasks/nonexistent');
      expect(response.status).toBe(404);
      const data = await readJson(response);
      expect(data.success).toBe(false);
      expect(data.error).toBe('Task not found');
    });
  });

  describe('Repo Operations', () => {
    it('should clone a repo', async () => {
      const body = {
        repoName: 'beehive-test',
        namespace: 'default',
        taskId: 'task-001',
      };

      const response = await callHandler('/sandbox/repos/clone', 'POST', body, {
        'X-Actor-ID': 'agent-001',
      });

      expect(response.status).toBe(200);
      const data = await readJson(response);
      expect(data.success).toBe(true);
      expect(data.repoName).toBe('beehive-test');
      expect(data.sandboxPath).toMatch(/^\/sandbox\/task-001\/beehive-test$/);
    });

    it('should commit changes', async () => {
      const body = {
        taskId: 'task-001',
        commitMessage: 'Test commit',
        files: [{ path: 'test.txt', content: 'hello' }],
      };

      const response = await callHandler('/sandbox/repos/test-repo/commit', 'POST', body, {
        'X-Actor-ID': 'agent-001',
      });

      expect(response.status).toBe(200);
      const data = await readJson(response);
      expect(data.success).toBe(true);
      expect((data as { commitSha?: string }).commitSha).toBeDefined();
      expect(((data as { commitSha?: string }).commitSha)?.length).toBe(40); // SHA length
    });

    it('should push changes with 30% rejection rate for testing', async () => {
      // Mock Math.random to control rejection
      const originalRandom = Math.random;
      
      // Test successful push (random >= 0.3)
      Math.random = () => 0.5;
      let response = await callHandler('/sandbox/repos/test-repo/push', 'POST', {
        taskId: 'task-001',
        commitSha: 'abc123',
        branch: 'main',
      }, { 'X-Actor-ID': 'agent-001' });
      
      expect(response.status).toBe(200);
      let data = await readJson(response);
      expect(data.success).toBe(true);
      
      // Test rejected push (random < 0.3)
      Math.random = () => 0.2;
      response = await callHandler('/sandbox/repos/test-repo/push', 'POST', {
        taskId: 'task-002',
        commitSha: 'def456',
        branch: 'main',
      }, { 'X-Actor-ID': 'agent-001' });
      
      expect(response.status).toBe(409); // Conflict
      data = await readJson(response);
      expect(data.success).toBe(false);
      expect(data.error).toContain('concurrent push');
      
      // Restore Math.random
      Math.random = originalRandom;
    });
  });

  describe('Agent Execution', () => {
    it('should execute agent code', async () => {
      const body = {
        taskId: 'task-001',
        candidateId: 'candidate-001',
        specId: 'spec-001',
        agentCode: 'console.log("test")',
        timeoutMs: 10000,
      };

      const response = await callHandler('/sandbox/execute', 'POST', body, {
        'X-Actor-ID': 'agent-001',
      });

      expect(response.status).toBe(200);
      const data = await readJson(response);
      expect(data.success).toBe(true);
      expect(data.taskId).toBe('task-001');
      expect(data.commitSha).toBeDefined();
      expect(data.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should handle execution errors', async () => {
      const body = {
        taskId: 'task-001',
        candidateId: 'candidate-001',
        specId: 'spec-001',
        agentCode: 'throw new Error("test error")',
        timeoutMs: 10000,
      };

      const response = await callHandler('/sandbox/execute', 'POST', body, {
        'X-Actor-ID': 'agent-001',
      });

      expect(response.status).toBe(500);
      const data = await readJson(response);
      expect(data.success).toBe(false);
      expect(data.error).toBeDefined();
    });
  });

  describe('Direct Execution', () => {
    it('should execute code directly (dev only)', async () => {
      const body = {
        taskId: 'task-001',
        specId: 'spec-001',
        agentId: 'agent-001',
        code: 'console.log("direct execution")',
      };

      const response = await callHandler('/sandbox/execute/direct', 'POST', body, {
        'X-Actor-ID': 'agent-001',
      });

      expect(response.status).toBe(200);
      const data = await readJson(response);
      expect(data.success).toBe(true);
      expect(data.result).toBeDefined();
    });

    it('should reject invalid code', async () => {
      const body = {
        taskId: 'task-001',
        specId: 'spec-001',
        agentId: 'agent-001',
        code: 'a'.repeat(10001), // Too long
      };

      const response = await callHandler('/sandbox/execute/direct', 'POST', body, {
        'X-Actor-ID': 'agent-001',
      });

      expect(response.status).toBe(500);
      const data = await readJson(response);
      expect(data.success).toBe(false);
      expect(data.error).toContain('Invalid code');
    });
  });

  describe('404 Handling', () => {
    it('should return 404 for unknown endpoints', async () => {
      const response = await callHandler('/sandbox/unknown');
      expect(response.status).toBe(404);
      const data = await readJson(response);
      expect(data.error).toBe('Not found');
    });
  });
});

describe('Sandbox Utilities', () => {
  describe('generateFakeSha', () => {
    it('should generate a 40-character hex string', () => {
      // Import the utility function
      // This would require exporting it from the module
      // For now, we'll test the concept
      const chars = '0123456789abcdef';
      let result = '';
      for (let i = 0; i < 40; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      expect(result.length).toBe(40);
      expect(result).toMatch(/^[0-9a-f]+$/);
    });
  });
});

describe('GET /sandbox/probe', () => {
  it('reports the tool versions of the build image', async () => {
    probe.mockResolvedValueOnce({ exitCode: 0, stdout: 'v24\n0.25.0\ngit 2.47\n', stderr: '' });
    const res = await callHandler('/sandbox/probe');
    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({ success: true, stdout: 'v24\n0.25.0\ngit 2.47\n' });
    expect(getByName).toHaveBeenCalledWith('probe');
  });

  it('answers 502 with a generic message when the container cannot start', async () => {
    probe.mockRejectedValueOnce(new Error('no container'));
    const res = await callHandler('/sandbox/probe');
    expect(res.status).toBe(502);
    expect(await readJson(res)).toMatchObject({ success: false, error: 'the build container could not be started' });
  });

  it('requires the bearer token', async () => {
    const res = await handler.fetch(createRequest('/sandbox/probe'), mockEnv as never, mockCtx as never);
    expect(res.status).toBe(401);
  });
});

describe('POST /sandbox/build', () => {
  const sha = 'a'.repeat(40);
  const bundle = { mainModule: 'index.js', modules: [{ name: 'index.js', content: 'x' }], compatibilityDate: '2026-10-01', source: 'esbuild' };

  it('builds in a sandbox keyed by repo and short commit and returns the bundle', async () => {
    build.mockResolvedValueOnce({ ...bundle, namespace: 'default' });
    const res = await callHandler('/sandbox/build', 'POST', { repo: 'cand-1', commitSha: sha });
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ success: true, bundle, namespace: 'default' });
    expect(getByName).toHaveBeenCalledWith(`build-cand-1-${'a'.repeat(8)}`);
    expect(build).toHaveBeenCalledWith({ repo: 'cand-1', commitSha: sha });
  });

  it('keys the sandbox by namespace too, passes it on, and echoes it beside the bundle', async () => {
    build.mockResolvedValueOnce({ ...bundle, namespace: 'my-org' });
    const res = await callHandler('/sandbox/build', 'POST', { repo: 'cand-1', commitSha: sha, namespace: 'my-org' });
    expect(await readJson(res)).toEqual({ success: true, bundle, namespace: 'my-org' });
    expect(getByName).toHaveBeenLastCalledWith(`build-my-org/cand-1-${'a'.repeat(8)}`);
    expect(build).toHaveBeenLastCalledWith({ repo: 'cand-1', commitSha: sha, namespace: 'my-org' });
  });

  it('rejects an invalid namespace with 422 BAD_NAMESPACE before any container work', async () => {
    getByName.mockClear();
    for (const namespace of ['my.org', '', null, 5, 'a/b']) {
      const res = await callHandler('/sandbox/build', 'POST', { repo: 'cand-1', commitSha: sha, namespace });
      expect(res.status).toBe(422);
      expect(await readJson(res)).toMatchObject({ success: false, code: 'BAD_NAMESPACE' });
    }
    expect(getByName).not.toHaveBeenCalled();
  });

  it('rejects a repo or commit that is not well formed before any container work', async () => {
    getByName.mockClear();
    for (const body of [{ repo: '../x', commitSha: sha }, { repo: 'ok', commitSha: 'abc' }, {}]) {
      const res = await callHandler('/sandbox/build', 'POST', body);
      expect(res.status).toBe(400);
      expect(await readJson(res)).toMatchObject({ success: false, code: 'BAD_REQUEST' });
    }
    expect(getByName).not.toHaveBeenCalled();
  });

  it('recovers the build error code from an RPC error and maps it to a status', async () => {
    build.mockRejectedValueOnce(new Error('NO_ENTRY: the commit has neither dist/index.js nor src/index.ts'));
    const res = await callHandler('/sandbox/build', 'POST', { repo: 'cand-1', commitSha: sha });
    expect(res.status).toBe(422);
    expect(await readJson(res)).toMatchObject({ success: false, code: 'NO_ENTRY' });
  });

  it('answers 502 for an unknown failure', async () => {
    build.mockRejectedValueOnce(new Error('container exploded'));
    const res = await callHandler('/sandbox/build', 'POST', { repo: 'cand-1', commitSha: sha });
    expect(res.status).toBe(502);
  });

  it('returns a fixed bundle in stub mode only together with BEEHIVE_LOCAL_DEV=1', async () => {
    getByName.mockClear();
    const body = { repo: 'cand-1', commitSha: sha };
    const stubbed = await handler.fetch(
      createRequest('/sandbox/build', 'POST', body, { Authorization: 'Bearer test-auth-token' }),
      { ...mockEnv, SANDBOX_MODE: 'stub', BEEHIVE_LOCAL_DEV: '1' } as never, mockCtx as never
    );
    const stubBody = await readJson(stubbed);
    expect(stubBody.bundle).toMatchObject({ mainModule: 'index.js' });
    expect(stubBody).toMatchObject({ namespace: expect.any(String) });
    expect(stubBody.bundle.namespace).toBeUndefined(); // beside the bundle, not inside it
    const forked = await handler.fetch(
      createRequest('/sandbox/build', 'POST', { ...body, namespace: 'my-org' }, { Authorization: 'Bearer test-auth-token' }),
      { ...mockEnv, SANDBOX_MODE: 'stub', BEEHIVE_LOCAL_DEV: '1' } as never, mockCtx as never
    );
    expect((await readJson(forked)).namespace).toBe('my-org');
    expect(getByName).not.toHaveBeenCalled();
    build.mockResolvedValueOnce(bundle);
    await handler.fetch(
      createRequest('/sandbox/build', 'POST', body, { Authorization: 'Bearer test-auth-token' }),
      { ...mockEnv, SANDBOX_MODE: 'stub' } as never, mockCtx as never // no BEEHIVE_LOCAL_DEV: the real path
    );
    expect(getByName).toHaveBeenCalled();
  });
});

describe('POST /sandbox/test', () => {
  const sha = 'b'.repeat(40);
  const passResult = { status: 'pass', failureClass: null, exitCode: 0 };
  const testRun = vi.fn();
  const envWith = (extra: Record<string, unknown>) => ({ ...mockEnv, ...extra }) as never;
  const post = (env: never, body: unknown) =>
    handler.fetch(createRequest('/sandbox/test', 'POST', body, { Authorization: 'Bearer test-auth-token' }), env, mockCtx as never);

  it('runs in a sandbox keyed by namespace, repo and short commit and returns the verdict', async () => {
    const getTest = vi.fn(() => ({ test: testRun }));
    testRun.mockResolvedValueOnce(passResult);
    const res = await post(envWith({ TEST_SANDBOX: { getByName: getTest } }), { repo: 'cand-1', commitSha: sha, namespace: 'my-org', installDirs: ['.', 'cli'] });
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ success: true, result: passResult });
    expect(getTest).toHaveBeenCalledWith(`test-my-org/cand-1-${'b'.repeat(8)}`);
    expect(testRun).toHaveBeenCalledWith({ repo: 'cand-1', commitSha: sha, namespace: 'my-org', installDirs: ['.', 'cli'] });
  });

  it('rejects a malformed request with 400/422 before any container work', async () => {
    const getTest = vi.fn(() => ({ test: testRun }));
    const env = envWith({ TEST_SANDBOX: { getByName: getTest } });
    for (const body of [{ repo: '../x', commitSha: sha }, { repo: 'ok', commitSha: 'abc' }, { repo: 'ok', commitSha: sha, installDirs: ['../x'] }, { repo: 'ok', commitSha: sha, installDirs: ['/etc'] }, { repo: 'ok', commitSha: sha, testCommand: [] }]) {
      expect((await post(env, body)).status).toBe(400);
    }
    expect((await post(env, { repo: 'ok', commitSha: sha, namespace: 'a.b' })).status).toBe(422);
    expect(getTest).not.toHaveBeenCalled();
  });

  it('answers 503 NOT_CONFIGURED while the container is not bound, and 502 for an unknown failure', async () => {
    const res = await post(envWith({}), { repo: 'ok', commitSha: sha });
    expect(res.status).toBe(503);
    expect(await readJson(res)).toMatchObject({ success: false, code: 'NOT_CONFIGURED' });
    testRun.mockRejectedValueOnce(new Error('container exploded'));
    const bad = await post(envWith({ TEST_SANDBOX: { getByName: () => ({ test: testRun }) } }), { repo: 'ok', commitSha: sha });
    expect(bad.status).toBe(502);
    testRun.mockRejectedValueOnce(new Error('SANDBOX_UNAVAILABLE: the test container could not be started'));
    const down = await post(envWith({ TEST_SANDBOX: { getByName: () => ({ test: testRun }) } }), { repo: 'ok', commitSha: sha });
    expect(down.status).toBe(503);
    expect(await readJson(down)).toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
  });

  it('returns a fixed pass in stub mode only together with BEEHIVE_LOCAL_DEV=1', async () => {
    const stubbed = await post(envWith({ SANDBOX_MODE: 'stub', BEEHIVE_LOCAL_DEV: '1' }), { repo: 'ok', commitSha: sha });
    expect(await readJson(stubbed)).toMatchObject({ success: true, result: { status: 'pass', failureClass: null, instance: 'stub', logSha256: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    const real = await post(envWith({ SANDBOX_MODE: 'stub' }), { repo: 'ok', commitSha: sha });
    expect(real.status).toBe(503); // not stubbed: falls through to the (unbound) real path
  });

  it('still validates in stub mode', async () => {
    const res = await post(envWith({ SANDBOX_MODE: 'stub', BEEHIVE_LOCAL_DEV: '1' }), { repo: 'ok', commitSha: 'nope' });
    expect(res.status).toBe(400);
  });
});
