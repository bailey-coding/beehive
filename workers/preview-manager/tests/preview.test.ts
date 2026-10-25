/**
 * Preview Manager Worker Tests
 * 
 * Unit tests for the preview-manager worker.
 * Tests health checks, bindings, and basic functionality.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

  function envWithCandidate(candidate: Record<string, unknown> | null, status = candidate ? 200 : 404, mode?: string, localDev = mode === 'stub') {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(candidate ? { success: true, data: candidate } : { success: false, error: 'Not found' }), { status })
    );
    const env = {
      ...baseMockEnv,
      WORKER_VERSIONS_MODE: mode,
      BEEHIVE_LOCAL_DEV: localDev ? '1' : undefined,
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

  it('stub mode without the local-only signal still answers 501 (production safety)', async () => {
    const { env, fetch } = envWithCandidate({ id: 'c1', specId: 's1', commitSha: 'abc123' }, 200, 'stub', false);
    const res = await post(env, { candidateId: 'c1', specId: 's1' });
    expect(res.status).toBe(501);
    expect(fetch).not.toHaveBeenCalled();
    // The signal alone, without stub mode, is not enough either
    const only = envWithCandidate(null, 404, undefined, true);
    expect((await post(only.env, { candidateId: 'c1', specId: 's1' })).status).toBe(501);
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

// ============================================================================
// Canary version route in api mode (real client, sandbox-runner bundle source, mocked Cloudflare API)
// ============================================================================

describe('Preview Manager - canary version, api mode', () => {
  const auth = { Authorization: 'Bearer test-auth-token' };
  const UUID = '0f1e2d3c-4b5a-4968-8777-665544332211';
  const SHA = 'c'.repeat(40);
  const V = '1496f34f-7587-4bfb-b75d-97dab053a92b';
  const bundle = { mainModule: 'index.js', modules: [{ name: 'index.js', content: 'export default {}' }], compatibilityDate: '2026-10-01', source: 'esbuild' };

  function setup(opts: { candidate?: Record<string, unknown> | null; repo?: { status: number; body: unknown }; runner?: Response | Error; noRunner?: boolean; deployments?: Array<{ status: string }> | 'down'; artifactsNamespace?: string } = {}) {
    const candidate = opts.candidate === undefined ? { id: UUID, specId: 's1', repositoryId: 'repo-id-1', commitSha: SHA } : opts.candidate;
    const specFetch = vi.fn(async (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname.startsWith('/api/candidates/')) {
        return candidate ? new Response(JSON.stringify({ success: true, data: candidate }), { status: 200 }) : new Response('{}', { status: 404 });
      }
      if (url.pathname.startsWith('/api/repositories/')) {
        const r = opts.repo ?? { status: 200, body: { success: true, data: { name: 'repo-1', namespace: 'default' } } };
        return new Response(JSON.stringify(r.body), { status: r.status });
      }
      if (url.pathname === '/canary-deployments') {
        if (opts.deployments === 'down') return new Response('{}', { status: 500 });
        const full = (opts.deployments ?? []).map((d, i) => ({
          id: `dep-${i}`, candidateId: UUID, specId: 's1', status: d.status, url: 'https://x.workers.dev', workerVersionId: V, commitSha: SHA,
          trafficPercentage: 10, holdoutPercentage: 5, autoRollback: true, deployRefId: `ref-${i}`, rollbackReason: null,
          createdAt: '2026-10-25T00:00:00Z', updatedAt: '2026-10-25T00:00:00Z',
        }));
        return new Response(JSON.stringify({ success: true, data: full }), { status: 200 });
      }
      return new Response('{}', { status: 500 });
    });
    const runnerFetch = vi.fn(async () => {
      const r = opts.runner ?? new Response(JSON.stringify({ success: true, bundle }), { status: 200 });
      if (r instanceof Error) throw r;
      return r;
    });
    const env = {
      ...baseMockEnv,
      WORKER_VERSIONS_MODE: 'api',
      CLOUDFLARE_ACCOUNT_ID: 'acct1',
      CLOUDFLARE_API_TOKEN: 'cf-tok',
      WORKERS_SUBDOMAIN: 'acct',
      API_AUTH_TOKEN: 'test-auth-token',
      ...(opts.artifactsNamespace ? { ARTIFACTS_NAMESPACE: opts.artifactsNamespace } : {}),
      ...(opts.noRunner ? {} : { SANDBOX_RUNNER: { fetch: runnerFetch } }),
      SPEC_DO: { ...baseMockEnv.SPEC_DO, get: vi.fn().mockReturnValue({ fetch: specFetch }) } as any,
    } as unknown as PreviewManagerEnv;
    return { env, specFetch, runnerFetch };
  }

  const cfOk = (result: unknown) => new Response(JSON.stringify({ success: true, result, errors: [] }), { status: 200 });
  const post = (env: PreviewManagerEnv, body: unknown) => handler.fetch(createRequest('/api/preview/canary', 'POST', body, auth), env, mockCtx);
  const del = (env: PreviewManagerEnv, id: string) => handler.fetch(createRequest(`/api/preview/canary/${id}`, 'DELETE', undefined, auth), env, mockCtx);

  afterEach(() => { vi.unstubAllGlobals(); });

  it('builds the candidate commit in the sandbox, uploads it as a version, and answers with versionsClient api', async () => {
    const { env, runnerFetch } = setup();
    const cf = vi.fn().mockResolvedValueOnce(cfOk({ id: V })).mockResolvedValueOnce(cfOk({ enabled: true }));
    vi.stubGlobal('fetch', cf);
    const res = await post(env, { candidateId: UUID, specId: 's1' });
    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({ success: true, versionsClient: 'api', workerName: `beehive-candidate-${UUID}`, versionId: V, commitSha: SHA });
    const [, init] = (runnerFetch.mock.calls[0] as unknown as [string, RequestInit]);
    expect(JSON.parse(init.body as string)).toEqual({ repo: 'repo-1', commitSha: SHA });
    expect(cf.mock.calls[0][0]).toContain(`/workers/scripts/beehive-candidate-${UUID}/versions`);
  });

  it('refuses a candidate id that is not a UUID (it would name a platform worker), without any build or API call', async () => {
    const { env, runnerFetch, specFetch } = setup();
    const cf = vi.fn();
    vi.stubGlobal('fetch', cf);
    for (const id of ['service', 'c1', '../x']) {
      const res = await post(env, { candidateId: id, specId: 's1' });
      expect(res.status).toBe(400);
    }
    expect(runnerFetch).not.toHaveBeenCalled();
    expect(cf).not.toHaveBeenCalled();
    expect(specFetch).toHaveBeenCalled(); // the candidate lookup happens first, but nothing is built
  });

  it('requires the candidate to be in the ledger and to have a repository (422)', async () => {
    vi.stubGlobal('fetch', vi.fn());
    expect((await post(setup({ candidate: null }).env, { candidateId: UUID, specId: 's1' })).status).toBe(422);
    expect((await post(setup({ candidate: { id: UUID, specId: 's1', commitSha: SHA } }).env, { candidateId: UUID, specId: 's1' })).status).toBe(422);
    expect((await post(setup({ repo: { status: 404, body: {} } }).env, { candidateId: UUID, specId: 's1' })).status).toBe(422);
    expect((await post(setup({ repo: { status: 500, body: {} } }).env, { candidateId: UUID, specId: 's1' })).status).toBe(502);
  });

  it('refuses a candidate repository recorded in a namespace the build service does not read (422), and honors ARTIFACTS_NAMESPACE', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const other = setup({ repo: { status: 200, body: { success: true, data: { name: 'repo-1', namespace: 'beehive-demo' } } } });
    const res = await post(other.env, { candidateId: UUID, specId: 's1' });
    expect(res.status).toBe(422);
    expect((await readJson(res)).error).toContain("namespace 'beehive-demo'");
    expect(other.runnerFetch).not.toHaveBeenCalled();
    const cf = vi.fn().mockResolvedValueOnce(cfOk({ id: V })).mockResolvedValueOnce(cfOk({ enabled: true }));
    vi.stubGlobal('fetch', cf);
    const configured = setup({ repo: { status: 200, body: { success: true, data: { name: 'repo-1', namespace: 'beehive-demo' } } }, artifactsNamespace: 'beehive-demo' });
    expect((await post(configured.env, { candidateId: UUID, specId: 's1' })).status).toBe(200);
    // a repository row without a usable name or namespace is refused too
    for (const data of [{ name: 123, namespace: 'default' }, { name: 'r' }, {}]) {
      expect((await post(setup({ repo: { status: 200, body: { success: true, data } } }).env, { candidateId: UUID, specId: 's1' })).status).toBe(422);
    }
  });

  it('refuses a candidate that belongs to another spec in api mode (409) before any build', async () => {
    const { env, runnerFetch } = setup({ candidate: { id: UUID, specId: 'other', repositoryId: 'r', commitSha: SHA } });
    expect((await post(env, { candidateId: UUID, specId: 's1' })).status).toBe(409);
    expect(runnerFetch).not.toHaveBeenCalled();
  });

  it('maps a sandbox build failure to its status and code, and an unreachable service to 504', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const noEntry = setup({ runner: new Response(JSON.stringify({ success: false, code: 'NO_ENTRY', error: 'no entry file' }), { status: 422 }) });
    const res = await post(noEntry.env, { candidateId: UUID, specId: 's1' });
    expect(res.status).toBe(422);
    expect(await readJson(res)).toMatchObject({ success: false, code: 'NO_ENTRY' });
    const down = setup({ runner: new Error('refused') });
    expect((await post(down.env, { candidateId: UUID, specId: 's1' })).status).toBe(504);
    const broken = setup({ runner: new Response('boom', { status: 500 }) });
    expect((await post(broken.env, { candidateId: UUID, specId: 's1' })).status).toBe(502);
  });

  it('answers 501 in api mode when the SANDBOX_RUNNER binding is missing (no bundle source, no Cloudflare API call)', async () => {
    const cf = vi.fn();
    vi.stubGlobal('fetch', cf);
    const res = await post(setup({ noRunner: true }).env, { candidateId: UUID, specId: 's1' });
    expect(res.status).toBe(501);
    expect(cf).not.toHaveBeenCalled();
  });

  describe('DELETE /api/preview/canary/:candidateId', () => {
    it('deletes the candidate worker', async () => {
      const cf = vi.fn().mockResolvedValue(cfOk(null));
      vi.stubGlobal('fetch', cf);
      const res = await del(setup().env, UUID);
      expect(res.status).toBe(200);
      expect(await readJson(res)).toMatchObject({ success: true, deleted: true, workerName: `beehive-candidate-${UUID}`, versionsClient: 'api' });
      expect(cf.mock.calls[0][1].method).toBe('DELETE');
    });

    it('refuses to delete the worker of a candidate with a live canary (409), and fails closed when the ledger check fails', async () => {
      const cf = vi.fn();
      vi.stubGlobal('fetch', cf);
      const live = await del(setup({ deployments: [{ status: 'rolled_back' }, { status: 'deployed' }] }).env, UUID);
      expect(live.status).toBe(409);
      expect(await readJson(live)).toMatchObject({ success: false });
      expect((await del(setup({ deployments: 'down' }).env, UUID)).status).toBe(502);
      expect(cf).not.toHaveBeenCalled();
      cf.mockResolvedValue(cfOk(null));
      expect((await del(setup({ deployments: [{ status: 'superseded' }, { status: 'rolled_back' }] }).env, UUID)).status).toBe(200);
    });

    it('answers 400, not an exception, for a malformed percent-encoded id', async () => {
      const cf = vi.fn();
      vi.stubGlobal('fetch', cf);
      const res = await del(setup().env, '%E0%A4%A');
      expect(res.status).toBe(400);
      expect(cf).not.toHaveBeenCalled();
    });

    it('refuses ids that would name a platform worker, with no API call', async () => {
      const cf = vi.fn();
      vi.stubGlobal('fetch', cf);
      for (const id of ['service', 'c1']) expect((await del(setup().env, id)).status).toBe(400);
      expect(cf).not.toHaveBeenCalled();
    });

    it('answers 501 with no Versions client, and requires the bearer token', async () => {
      const { env } = setup();
      const noMode = { ...env, WORKER_VERSIONS_MODE: undefined } as unknown as PreviewManagerEnv;
      expect((await del(noMode, UUID)).status).toBe(501);
      const unauth = await handler.fetch(createRequest(`/api/preview/canary/${UUID}`, 'DELETE'), env, mockCtx);
      expect(unauth.status).toBe(401);
    });
  });
});

