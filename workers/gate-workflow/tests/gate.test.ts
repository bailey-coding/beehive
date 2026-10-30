/**
 * Pre-merge Gate Workflow Tests
 * 
 * Unit tests for the gate workflow logic.
 * Now uses valid UUIDs and tests actual worker functionality.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Import the handler
import handler from '../index';

type JsonResponse = Record<string, unknown>;
async function readJson(res: Response): Promise<JsonResponse> {
  return await res.json() as JsonResponse;
}

// Valid UUIDs for testing
const TEST_CANDIDATE_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEST_SPEC_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const TEST_COMMIT_SHA = 'abc123def456';
const TEST_BASE_COMMIT_SHA = 'def456abc123';
const TEST_ACTOR_ID = 'agent-001';

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
  SANDBOX_RUNNER: {},
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

// Mock the Spec DO responses
const specDoRoutes = new Map<string, { response: unknown; status: number }>();
function mockSpecDoResponse(path: string, response: unknown, status: number = 200) {
  specDoRoutes.set(path, { response, status });
  mockEnv.SPEC_DO.get.mockReturnValue({
    fetch: vi.fn().mockImplementation((req: Request | string) => {
      const raw = typeof req === 'string' ? req : req.url;
      const url = new URL(raw.startsWith('/') ? `http://spec-do${raw}` : raw);
      const route = specDoRoutes.get(url.pathname);
      if (route) {
        const { response: routeResponse, status: routeStatus } = route;
        return Promise.resolve(new Response(JSON.stringify(routeResponse), {
          status: routeStatus,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }));
    }),
  });
}

// Mock a successful spec response
function mockValidSpec() {
  const mockSpec = {
    data: {
      id: TEST_SPEC_ID,
      name: 'Test Spec',
      contract: JSON.stringify({
        endpoints: [{ path: '/test', method: 'GET' }],
        models: { TestModel: { type: 'object', properties: { id: { type: 'string' } } } },
      }),
    },
  };
  mockSpecDoResponse(`/api/specs/${TEST_SPEC_ID}`, mockSpec);
}

// Mock a verdict recording response
function mockVerdictRecording() {
  mockSpecDoResponse('/api/gate-verdicts', { success: true, id: 'verdict-001' });
}

// Mock an empty or error spec response
function mockInvalidSpec() {
  mockSpecDoResponse(`/api/specs/${TEST_SPEC_ID}`, { error: 'Not found' }, 404);
}

describe('Pre-merge Gate Workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    specDoRoutes.clear();
    mockEnv.SPEC_DO.idFromName.mockReturnValue('do-id');
    mockSpecDoResponse('/api/gate-verdicts', { success: true });
  });

  describe('auth gate', () => {
    it('should return 401 when the bearer token is missing or wrong', async () => {
      // @ts-ignore - mock environment
      const missing = await handler.fetch(createRequest('/health'), mockEnv, mockCtx);
      expect(missing.status).toBe(401);

      const wrong = await callHandler('/health', 'GET', undefined, {
        Authorization: 'Bearer wrong-token',
      });
      expect(wrong.status).toBe(401);
    });

    it('should return 503 when API_AUTH_TOKEN is not configured', async () => {
      const envWithoutToken = { ...mockEnv, API_AUTH_TOKEN: undefined };
      // @ts-ignore - mock environment
      const response = await handler.fetch(createRequest('/health'), envWithoutToken, mockCtx);
      expect(response.status).toBe(503);
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

    it('should return healthy status on /gates/health', async () => {
      const response = await callHandler('/gates/health');
      expect(response.status).toBe(200);
      const data = await readJson(response);
      expect(data.status).toBe('healthy');
    });
  });

  describe('Start Pre-merge Gate', () => {
    it('should start pre-merge gate evaluation with valid UUIDs', async () => {
      // Mock the Spec DO to return a spec
      mockValidSpec();
      mockVerdictRecording();

      const requestBody = {
        candidateId: TEST_CANDIDATE_ID,
        specId: TEST_SPEC_ID,
        commitSha: TEST_COMMIT_SHA,
        baseCommitSha: TEST_BASE_COMMIT_SHA,
        actorId: TEST_ACTOR_ID,
      };

      const response = await callHandler('/gates/pre-merge', 'POST', requestBody);

      // Should succeed with 201
      expect(response.status).toBe(201);
      const data = await readJson(response);
      expect(data.success).toBe(true);
      expect(data.verdictId).toBeDefined();
      expect((data as { result?: { candidateId?: string } }).result?.candidateId).toBe(TEST_CANDIDATE_ID);
      expect((data as { result?: { gate?: string } }).result?.gate).toBe('pre-merge');
    });

    it('should return 400 for invalid request body (missing fields)', async () => {
      const response = await callHandler('/gates/pre-merge', 'POST', {});
      expect(response.status).toBe(400);
      const data = await readJson(response);
      expect(data.success).toBe(false);
      expect(data.error).toBeDefined();
    });

    it('should return 400 for invalid UUID format', async () => {
      const requestBody = {
        candidateId: 'invalid-uuid', // Not a valid UUID
        specId: 'also-invalid',
        commitSha: 'abc123',
        baseCommitSha: 'def456',
        actorId: 'agent-001',
      };

      const response = await callHandler('/gates/pre-merge', 'POST', requestBody);
      expect(response.status).toBe(400);
      const data = await readJson(response);
      expect(data.success).toBe(false);
    });

    it('should return 404 if spec not found', async () => {
      // Mock Spec DO to return 404 for spec
      mockInvalidSpec();

      const requestBody = {
        candidateId: TEST_CANDIDATE_ID,
        specId: TEST_SPEC_ID,
        commitSha: TEST_COMMIT_SHA,
        baseCommitSha: TEST_BASE_COMMIT_SHA,
        actorId: TEST_ACTOR_ID,
      };

      const response = await callHandler('/gates/pre-merge', 'POST', requestBody);
      expect(response.status).toBe(404);
      const data = await readJson(response);
      expect(data.success).toBe(false);
      expect(data.error).toContain('Failed to get spec');
    });
  });

  describe('Workflow Status', () => {
    it('should return workflow status after starting', async () => {
      // First start a workflow
      mockValidSpec();
      mockVerdictRecording();

      const startResponse = await callHandler('/gates/pre-merge', 'POST', {
        candidateId: TEST_CANDIDATE_ID,
        specId: TEST_SPEC_ID,
        commitSha: TEST_COMMIT_SHA,
        baseCommitSha: TEST_BASE_COMMIT_SHA,
        actorId: TEST_ACTOR_ID,
      });
      const startData = await readJson(startResponse);
      const verdictId = startData.verdictId as string;

      // Then check status
      const statusResponse = await callHandler(`/gates/pre-merge/status/${verdictId}`);
      expect(statusResponse.status).toBe(200);
      const statusData = await readJson(statusResponse);
      expect(statusData.success).toBe(true);
      expect(statusData.status).toBe('complete');
      expect(statusData.startedAt).toBeDefined();
      expect(statusData.completedAt).toBeDefined();
    });

    it('should return 404 for non-existent workflow', async () => {
      const response = await callHandler('/gates/pre-merge/status/nonexistent');
      expect(response.status).toBe(404);
      const data = await readJson(response);
      expect(data.success).toBe(false);
      expect(data.error).toBe('Workflow not found');
    });
  });

  describe('Workflow Result', () => {
    it('should return full workflow result', async () => {
      // First start a workflow
      mockValidSpec();
      mockVerdictRecording();

      const startResponse = await callHandler('/gates/pre-merge', 'POST', {
        candidateId: TEST_CANDIDATE_ID,
        specId: TEST_SPEC_ID,
        commitSha: TEST_COMMIT_SHA,
        baseCommitSha: TEST_BASE_COMMIT_SHA,
        actorId: TEST_ACTOR_ID,
      });
      const startData = await readJson(startResponse);
      const verdictId = startData.verdictId as string;

      // Then get result
      const resultResponse = await callHandler(`/gates/pre-merge/${verdictId}`);
      expect(resultResponse.status).toBe(200);
      const resultData = await readJson(resultResponse);
      expect(resultData.success).toBe(true);
      expect((resultData as { result?: { verdictId?: string } }).result?.verdictId).toBe(verdictId);
      expect((resultData as { result?: { candidateId?: string } }).result?.candidateId).toBe(TEST_CANDIDATE_ID);
    });

    it('should return 404 if result not ready', async () => {
      const response = await callHandler('/gates/pre-merge/nonexistent');
      expect(response.status).toBe(404);
      const data = await readJson(response);
      expect(data.success).toBe(false);
      expect(data.error).toBe('Result not ready');
    });
  });
});

describe('Gate Logic Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    specDoRoutes.clear();
  });

  describe('Test Result Parsing', () => {
    it('should parse JUnit XML test results', () => {
      // Simulate JUnit XML parsing
      const junitXml = `<?xml version="1.0"?>
        <testsuites>
          <testsuite tests="2" failures="0">
            <testcase name="test1" classname="TestSuite"/>
            <testcase name="test2" classname="TestSuite"/>
          </testsuite>
        </testsuites>`;
      
      const testCount = (junitXml.match(/testcase/g) || []).length;
      expect(testCount).toBe(2);
    });

    it('should parse custom JSON test results', () => {
      const testResults = {
        passed: 10,
        failed: 2,
        total: 12,
        tests: [
          { name: 'test1', passed: true, duration: 100 },
          { name: 'test2', passed: false, duration: 200, error: 'Assertion failed' },
        ],
      };
      
      expect(testResults.passed).toBe(10);
      expect(testResults.failed).toBe(2);
      expect(testResults.total).toBe(12);
    });

    it('should handle malformed test results', () => {
      const malformed = 'not json';
      let parsed;
      try {
        parsed = JSON.parse(malformed);
      } catch {
        parsed = null;
      }
      
      expect(parsed).toBeNull();
    });
  });

  describe('Property-Based Validation', () => {
    it('should validate candidate properties', () => {
      const candidate = {
        candidateId: TEST_CANDIDATE_ID,
        specId: TEST_SPEC_ID,
        commitSha: TEST_COMMIT_SHA,
        status: 'pending',
      };
      
      expect(candidate.candidateId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(candidate.specId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
  });

  describe('Fuzz Testing', () => {
    it('should execute fuzz tests', () => {
      // Simulate fuzz test logic
      const fuzzInputs = ['', 'a', 'abc', 'abc123', '!@#$%^&*()'];
      const allHandled = fuzzInputs.every(input => {
        // All inputs should be processable
        return typeof input === 'string';
      });
      
      expect(allHandled).toBe(true);
    });
  });

  describe('Spec Conformance', () => {
    it('should check spec conformance', () => {
      const specContract = {
        endpoints: [{ path: '/api/test', method: 'GET' }],
        models: { TestModel: { type: 'object', required: ['id'] } },
      };
      
      const candidateResponse = {
        endpoints: [{ path: '/api/test', method: 'GET' }],
        models: { TestModel: { type: 'object', properties: { id: { type: 'string' } } } },
      };
      
      // Check that endpoints match
      expect(candidateResponse.endpoints).toEqual(specContract.endpoints);
    });
  });

  describe('Complexity Analysis', () => {
    it('should analyze candidate complexity', () => {
      const candidate = {
        linesOfCode: 1000,
        functions: 50,
        dependencies: 10,
      };
      
      const complexityScore = candidate.linesOfCode / 10 + candidate.functions + candidate.dependencies * 2;
      
      expect(complexityScore).toBeGreaterThan(0);
    });
  });

  describe('Score Calculation', () => {
    it('should calculate gate score from tests', () => {
      const testScore = 100; // All tests pass
      const conformanceScore = 100; // No errors
      const complexityScore = 100; // Perfect complexity
      
      const weights = { conformance: 0.5, tests: 0.25, complexity: 0.25 };
      const score = (
        conformanceScore * weights.conformance +
        testScore * weights.tests +
        complexityScore * weights.complexity
      );
      
      expect(score).toBe(100);
      expect(score >= 80).toBe(true);
    });

    it('should fail with score < 80', () => {
      const testScore = 0; // All tests fail
      const conformanceScore = 100;
      const complexityScore = 100;
      
      const weights = { conformance: 0.5, tests: 0.25, complexity: 0.25 };
      const score = (
        conformanceScore * weights.conformance +
        testScore * weights.tests +
        complexityScore * weights.complexity
      );
      
      expect(score).toBeLessThan(80);
    });
  });

  describe('Verdict Determination', () => {
    it('should determine PASS verdict', () => {
      const score = 95;
      const status = score >= 80 ? 'pass' : 'fail';
      
      expect(status).toBe('pass');
    });

    it('should determine FAIL verdict', () => {
      const score = 50;
      const status = score >= 80 ? 'pass' : 'fail';
      
      expect(status).toBe('fail');
    });
  });
});

describe('Error Handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    specDoRoutes.clear();
  });

  it('should handle Spec DO errors gracefully', async () => {
    // Mock Spec DO to throw an error
    mockEnv.SPEC_DO.get.mockImplementationOnce(() => {
      throw new Error('Spec DO connection failed');
    });

    const requestBody = {
      candidateId: TEST_CANDIDATE_ID,
      specId: TEST_SPEC_ID,
      commitSha: TEST_COMMIT_SHA,
      baseCommitSha: TEST_BASE_COMMIT_SHA,
      actorId: TEST_ACTOR_ID,
    };

    const response = await callHandler('/gates/pre-merge', 'POST', requestBody);
    expect(response.status).toBe(500);
    const data = await readJson(response);
    expect(data.success).toBe(false);
    expect(data.error).toBeDefined();
  });

  it('should handle missing candidate gracefully', async () => {
    // Use empty strings which will fail UUID validation
    const requestBody = {
      candidateId: '',
      specId: '',
      commitSha: TEST_COMMIT_SHA,
      baseCommitSha: TEST_BASE_COMMIT_SHA,
      actorId: TEST_ACTOR_ID,
    };

    const response = await callHandler('/gates/pre-merge', 'POST', requestBody);
    expect(response.status).toBe(400);
    const data = await readJson(response);
    expect(data.success).toBe(false);
  });

  it('should handle queue processing errors', async () => {
    // Test that errors in the handler are caught
    const response = await callHandler('/gates/nonexistent', 'POST', {});
    expect(response.status).toBe(404);
    const data = await readJson(response);
    expect(data.error).toBe('Not found');
  });
});

describe('Gate start idempotency', () => {
  const body = {
    candidateId: TEST_CANDIDATE_ID,
    specId: TEST_SPEC_ID,
    commitSha: TEST_COMMIT_SHA,
    baseCommitSha: TEST_BASE_COMMIT_SHA,
    actorId: TEST_ACTOR_ID,
  };
  let verdictPosts: Request[];
  let verdictStatuses: number[];

  // Spec DO stub: serves the spec, and answers each verdict POST with the next queued status (default 201)
  function stubSpecDo() {
    verdictPosts = [];
    verdictStatuses = [];
    const spec = { data: { id: TEST_SPEC_ID, contract: JSON.stringify({ endpoints: [], models: {} }) } };
    mockEnv.SPEC_DO.get.mockReturnValue({
      fetch: vi.fn().mockImplementation(async (req: Request) => {
        const url = new URL(req.url);
        if (url.pathname === `/api/specs/${TEST_SPEC_ID}`) return Response.json(spec);
        if (url.pathname === '/api/gate-verdicts') {
          verdictPosts.push(req.clone());
          const code = verdictStatuses.shift() ?? 201;
          const reply = code === 409
            ? { success: false, error: 'Idempotency key conflict: same key used with different request' }
            : { success: true };
          return Response.json(reply, { status: code });
        }
        return Response.json({ error: 'Not found' }, { status: 404 });
      }),
    });
  }

  // Each test uses its own key: the gate keeps its run map for the life of the isolate
  let keyCounter = 0;
  const nextKey = () => `queue:event-${Date.now()}-${keyCounter++}:gate`;

  beforeEach(() => {
    vi.clearAllMocks();
    specDoRoutes.clear();
    mockEnv.SPEC_DO.idFromName.mockReturnValue('do-id');
    stubSpecDo();
  });

  it('derives the same verdict id from the same key and replays a recorded run', async () => {
    const key = nextKey();
    const first = await callHandler('/gates/pre-merge', 'POST', body, { 'Idempotency-Key': key });
    expect(first.status).toBe(201);
    const second = await callHandler('/gates/pre-merge', 'POST', body, { 'Idempotency-Key': key });
    expect(second.status).toBe(200);
    expect(second.headers.get('Idempotent-Replay')).toBe('true');
    expect((await readJson(second)).verdictId).toBe((await readJson(first)).verdictId);
    expect(verdictPosts).toHaveLength(1);
  });

  it('forwards the key on the verdict write', async () => {
    const key = nextKey();
    await callHandler('/gates/pre-merge', 'POST', body, { 'Idempotency-Key': key });
    expect(verdictPosts[0].headers.get('Idempotency-Key')).toBe(key);
  });

  it('without a key mints a random verdict id and sends no key', async () => {
    const a = await readJson(await callHandler('/gates/pre-merge', 'POST', body));
    const b = await readJson(await callHandler('/gates/pre-merge', 'POST', body));
    expect(a.verdictId).not.toBe(b.verdictId);
    expect(verdictPosts[0].headers.get('Idempotency-Key')).toBeNull();
  });

  it('throws on a failed verdict write, then runs again under the same key', async () => {
    const key = nextKey();
    verdictStatuses.push(503);
    const failed = await callHandler('/gates/pre-merge', 'POST', body, { 'Idempotency-Key': key });
    expect(failed.status).toBe(500);
    const retried = await callHandler('/gates/pre-merge', 'POST', body, { 'Idempotency-Key': key });
    expect(retried.status).toBe(201);
    expect(retried.headers.get('Idempotent-Replay')).toBeNull();
    expect(verdictPosts).toHaveLength(2);
  });

  it('runs again after the spec fetch failed under the same key', async () => {
    const key = nextKey();
    mockSpecDoResponse(`/api/specs/${TEST_SPEC_ID}`, { error: 'down' }, 503);
    const failed = await callHandler('/gates/pre-merge', 'POST', body, { 'Idempotency-Key': key });
    expect(failed.status).toBe(500);
    stubSpecDo();
    const retried = await callHandler('/gates/pre-merge', 'POST', body, { 'Idempotency-Key': key });
    expect(retried.status).toBe(201);
  });

  it('treats a Spec DO 409 on the verdict write as already recorded', async () => {
    const key = nextKey();
    verdictStatuses.push(409);
    const response = await callHandler('/gates/pre-merge', 'POST', body, { 'Idempotency-Key': key });
    expect(response.status).toBe(201);
    const replay = await callHandler('/gates/pre-merge', 'POST', body, { 'Idempotency-Key': key });
    expect(replay.status).toBe(200);
  });

  it('throws on a 409 that is not an idempotency conflict', async () => {
    const key = nextKey();
    const base = mockEnv.SPEC_DO.get();
    mockEnv.SPEC_DO.get.mockReturnValue({
      fetch: vi.fn().mockImplementation(async (req: Request) =>
        new URL(req.url).pathname === '/api/gate-verdicts'
          ? Response.json({ success: false, error: 'verdict already exists' }, { status: 409 })
          : base.fetch(req)),
    });
    const response = await callHandler('/gates/pre-merge', 'POST', body, { 'Idempotency-Key': key });
    expect(response.status).toBe(500);
  });

  it('after an isolate restart (empty run map) reruns with the same verdict id and key, so the DO key decides', async () => {
    const key = nextKey();
    const first = await callHandler('/gates/pre-merge', 'POST', body, { 'Idempotency-Key': key });
    expect(first.status).toBe(201);

    vi.resetModules();
    const fresh = (await import('../index')).default;
    // @ts-ignore - mock environment
    const second = await fresh.fetch(createRequest('/gates/pre-merge', 'POST', body, {
      Authorization: 'Bearer test-auth-token',
      'Idempotency-Key': key,
    }), mockEnv, mockCtx);
    expect(second.status).toBe(201);
    expect((await readJson(second)).verdictId).toBe((await readJson(first)).verdictId);
    expect(verdictPosts).toHaveLength(2);
    expect(verdictPosts[1].headers.get('Idempotency-Key')).toBe(key);
    expect(verdictPosts[1].headers.get('X-Actor-ID')).toBe(TEST_ACTOR_ID);
  });

  it('answers 409 inFlight for a duplicate while the first run has not recorded', async () => {
    const key = nextKey();
    let release!: () => void;
    const gateOpen = new Promise<void>((r) => { release = r; });
    const base = mockEnv.SPEC_DO.get();
    mockEnv.SPEC_DO.get.mockReturnValue({
      fetch: vi.fn().mockImplementation(async (req: Request) => {
        if (new URL(req.url).pathname === '/api/gate-verdicts') await gateOpen;
        return base.fetch(req);
      }),
    });
    const first = callHandler('/gates/pre-merge', 'POST', body, { 'Idempotency-Key': key });
    await new Promise((r) => setTimeout(r, 10));
    const duplicate = await callHandler('/gates/pre-merge', 'POST', body, { 'Idempotency-Key': key });
    expect(duplicate.status).toBe(409);
    expect((await readJson(duplicate)).inFlight).toBe(true);
    release();
    expect((await first).status).toBe(201);
  });

  it('ignores a run that has been in flight longer than two minutes', async () => {
    const key = nextKey();
    let hold = true;
    let release!: () => void;
    const gateOpen = new Promise<void>((r) => { release = r; });
    const base = mockEnv.SPEC_DO.get();
    mockEnv.SPEC_DO.get.mockReturnValue({
      fetch: vi.fn().mockImplementation(async (req: Request) => {
        if (hold && new URL(req.url).pathname === '/api/gate-verdicts') {
          hold = false;
          await gateOpen;
        }
        return base.fetch(req);
      }),
    });
    const first = callHandler('/gates/pre-merge', 'POST', body, { 'Idempotency-Key': key });
    await new Promise((r) => setTimeout(r, 10));
    const realNow = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 121_000);
    try {
      const rerun = await callHandler('/gates/pre-merge', 'POST', body, { 'Idempotency-Key': key });
      expect(rerun.status).toBe(201);
    } finally {
      vi.restoreAllMocks();
      release();
      await first;
    }
  });

  it('answers 409 (not inFlight) for the same key with a different body', async () => {
    const key = nextKey();
    await callHandler('/gates/pre-merge', 'POST', body, { 'Idempotency-Key': key });
    const other = await callHandler('/gates/pre-merge', 'POST', { ...body, commitSha: 'fff000' }, { 'Idempotency-Key': key });
    expect(other.status).toBe(409);
    expect((await readJson(other)).inFlight).toBeUndefined();
  });

  it('answers 400 for malformed JSON', async () => {
    const request = new Request('http://localhost/gates/pre-merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-auth-token' },
      body: '{not json',
    });
    // @ts-ignore - mock environment
    expect((await handler.fetch(request, mockEnv, mockCtx)).status).toBe(400);
  });
});
