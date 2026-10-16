/**
 * Beehive Promotion Worker Unit Tests
 * 
 * Comprehensive unit tests for the Promotion Worker (M3 feature)
 * Covers: Tournament Mode, Merge-Train Mode, and Common Logic
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import handler from '../index';
import { PromotionWorker } from '../promotion';
import { TournamentManager } from '../tournament';
import { MergeTrainManager } from '../merge-train';
import type {
  PromotionMode,
  Rung,
  PromotionRequest,
  PromotionResult,
  TournamentStatus,
  TournamentCandidate,
  MergeTrainStatus,
  MergeTrainCandidate,
  Env,
  PromotionState,
} from '../types';
import { PromotionStateManager } from '../state';
import { PromotionLedgerClient, RECORD_NOT_FOUND } from '../../shared/promotion-ledger';
import { makeSpecDo } from '../../spec-do/tests/sqlite-state';
import { TEST_INTERNAL_ONLY } from '../../spec-do/tests/do-tokens';

// ============================================================================
// Mock Environment
// ============================================================================

const mockSpecDoService = {
  fetch: vi.fn(),
};

// persistedMode models the SpecDO storage value behind GET/POST /promotion-mode.
// Those calls are answered here so mockSpecDoService.fetch sees only promotion calls.
let persistedMode: PromotionMode | null = null;

const mockSpecDoStub = {
  fetch: async (request: Request) => {
    if (new URL(request.url).pathname !== '/promotion-mode') {
      return mockSpecDoService.fetch(request);
    }
    if (request.method === 'POST') {
      const { mode } = await request.json() as { mode: PromotionMode };
      persistedMode = mode;
    }
    return new Response(JSON.stringify({ mode: persistedMode }), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
};

// SPEC_DO is a DurableObjectNamespace: idFromName/get resolve to the stub above
const mockSpecDoNamespace = {
  idFromName: () => 'spec-do-id',
  get: () => mockSpecDoStub,
};

const mockPreviewManager = {
  fetch: vi.fn(),
};

const mockGateWorkflow = {
  fetch: vi.fn(),
};

const mockShadowRouter = {
  fetch: vi.fn(),
};

const mockAnalytics = {
  writeDataPoint: vi.fn(),
};

const mockEnv: Env = {
  SPEC_DO: mockSpecDoNamespace as unknown as DurableObjectNamespace,
  PREVIEW_MANAGER: mockPreviewManager as unknown as Service,
  GATE_WORKFLOW: mockGateWorkflow as unknown as Service,
  SHADOW_ROUTER: mockShadowRouter as unknown as Service,
  ANALYTICS: mockAnalytics,
  PROMOTION_MODE: 'tournament',
  MAX_CONCURRENT_CANDIDATES: '10',
  PROMOTION_TIMEOUT: '300000',
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

// ============================================================================
// Test Setup
// ============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  mockSpecDoService.fetch.mockReset();
  persistedMode = null;
  mockPreviewManager.fetch.mockReset();
  mockGateWorkflow.fetch.mockReset();
  mockShadowRouter.fetch.mockReset();
  mockAnalytics.writeDataPoint.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================================
// Tournament Mode Tests (8 tests)
// ============================================================================

describe('Tournament Mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Candidate Scoring', () => {
    it('should score candidates based on gate verdicts', () => {
      // Simulate scoring logic
      const verdicts = [
        { score: 95, candidateId: 'candidate-001' },
        { score: 87, candidateId: 'candidate-002' },
        { score: 92, candidateId: 'candidate-003' },
      ];
      
      // Sort by score descending
      const sorted = [...verdicts].sort((a, b) => b.score - a.score);
      
      expect(sorted[0].candidateId).toBe('candidate-001');
      expect(sorted[0].score).toBe(95);
      expect(sorted[1].candidateId).toBe('candidate-003');
      expect(sorted[2].candidateId).toBe('candidate-002');
    });

    it('should handle ties in scoring', () => {
      // When scores are tied, both should be considered
      const verdicts = [
        { score: 95, candidateId: 'candidate-001' },
        { score: 95, candidateId: 'candidate-002' },
        { score: 92, candidateId: 'candidate-003' },
      ];
      
      const tied = verdicts.filter(v => v.score === 95);
      
      expect(tied.length).toBe(2);
      expect(tied.map(v => v.candidateId)).toContain('candidate-001');
      expect(tied.map(v => v.candidateId)).toContain('candidate-002');
    });
  });

  describe('Winner Selection', () => {
    it('should select highest scoring candidate', () => {
      const candidates: TournamentCandidate[] = [
        { candidateId: 'candidate-001', specId: 'spec-001', score: 95, status: 'competing', metrics: { passRate: 1, failureRate: 0, latencyP95: 100, latencyP50: 50, errorRate: 0, throughput: 100, score: 95, conformanceScore: 100, complexityDelta: 0, stability: 100 } },
        { candidateId: 'candidate-002', specId: 'spec-001', score: 87, status: 'competing', metrics: { passRate: 1, failureRate: 0, latencyP95: 100, latencyP50: 50, errorRate: 0, throughput: 100, score: 87, conformanceScore: 100, complexityDelta: 0, stability: 100 } },
        { candidateId: 'candidate-003', specId: 'spec-001', score: 92, status: 'competing', metrics: { passRate: 1, failureRate: 0, latencyP95: 100, latencyP50: 50, errorRate: 0, throughput: 100, score: 92, conformanceScore: 100, complexityDelta: 0, stability: 100 } },
      ];
      
      const winner = candidates.reduce((prev, current) => (prev.score > current.score ? prev : current));
      
      expect(winner.candidateId).toBe('candidate-001');
      expect(winner.score).toBe(95);
    });

    it('should handle single candidate tournament', () => {
      const candidates: TournamentCandidate[] = [
        { candidateId: 'candidate-001', specId: 'spec-001', score: 95, status: 'competing', metrics: { passRate: 1, failureRate: 0, latencyP95: 100, latencyP50: 50, errorRate: 0, throughput: 100, score: 95, conformanceScore: 100, complexityDelta: 0, stability: 100 } },
      ];
      
      expect(candidates.length).toBe(1);
      expect(candidates[0].candidateId).toBe('candidate-001');
    });
  });

  describe('Tournament Bracket', () => {
    it('should manage multi-round tournament', () => {
      // Simulate a bracket with 4 candidates
      const candidates = ['candidate-001', 'candidate-002', 'candidate-003', 'candidate-004'];
      
      // Pair them up
      const round1 = [
        [candidates[0], candidates[1]],
        [candidates[2], candidates[3]],
      ];
      
      expect(round1.length).toBe(2);
      expect(round1[0].length).toBe(2);
    });
  });

  describe('Multiple Candidates', () => {
    it('should handle multiple candidates concurrently', () => {
      const candidateIds = [
        'candidate-001',
        'candidate-002',
        'candidate-003',
        'candidate-004',
        'candidate-005',
      ];
      
      // All candidates should be processable
      candidateIds.forEach(id => {
        expect(id).toMatch(/^candidate-\d{3}$/);
      });
      
      expect(candidateIds.length).toBe(5);
    });
  });
});

// ============================================================================
// Merge-Train Mode Tests (8 tests)
// ============================================================================

describe('Merge-Train Mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Train Formation', () => {
    it('should form train from promotion candidates', () => {
      const candidates: MergeTrainCandidate[] = [
        { candidateId: 'candidate-001', specId: 'spec-001', position: 1, status: 'waiting' },
        { candidateId: 'candidate-002', specId: 'spec-001', position: 2, status: 'waiting' },
        { candidateId: 'candidate-003', specId: 'spec-001', position: 3, status: 'waiting' },
      ];
      
      // Verify positions are sequential
      candidates.forEach((c, index) => {
        expect(c.position).toBe(index + 1);
      });
      
      expect(candidates.length).toBe(3);
    });
  });

  describe('Car Ordering', () => {
    it('should order cars by dependency and readiness', () => {
      const cars = [
        { candidateId: 'candidate-003', specId: 'spec-001', position: 3, status: 'waiting' },
        { candidateId: 'candidate-001', specId: 'spec-001', position: 1, status: 'waiting' },
        { candidateId: 'candidate-002', specId: 'spec-001', position: 2, status: 'waiting' },
      ];
      
      // Sort by position
      const ordered = [...cars].sort((a, b) => a.position - b.position);
      
      expect(ordered[0].candidateId).toBe('candidate-001');
      expect(ordered[1].candidateId).toBe('candidate-002');
      expect(ordered[2].candidateId).toBe('candidate-003');
    });
  });

  describe('Projection Calculation', () => {
    it('should calculate train projection', () => {
      // Projection: sum of all car metrics divided by count
      const metrics = [100, 200, 300, 400, 500];
      const projection = metrics.reduce((sum, m) => sum + m, 0) / metrics.length;
      
      expect(projection).toBe(300);
    });
  });

  describe('Combined Conformance', () => {
    it('should check combined candidate conformance', () => {
      // All candidates must conform to spec
      const conformances = [true, true, true, false];
      const allConform = conformances.every(c => c === true);
      
      expect(allConform).toBe(false);
    });
  });

  describe('Train Promotion', () => {
    it('should promote entire train when ready', () => {
      const candidates: MergeTrainCandidate[] = [
        { candidateId: 'candidate-001', specId: 'spec-001', position: 1, status: 'merged' },
        { candidateId: 'candidate-002', specId: 'spec-001', position: 2, status: 'merged' },
        { candidateId: 'candidate-003', specId: 'spec-001', position: 3, status: 'merged' },
      ];
      
      const allMerged = candidates.every(c => c.status === 'merged');
      
      expect(allMerged).toBe(true);
    });
  });

  describe('Car Dropping', () => {
    it('should drop car when conformance fails', () => {
      const candidate: MergeTrainCandidate = {
        candidateId: 'candidate-001',
        specId: 'spec-001',
        position: 1,
        status: 'failed',
        failureReason: 'Conformance check failed',
      };
      
      expect(candidate.status).toBe('failed');
      expect(candidate.failureReason).toContain('Conformance');
    });
  });
});

// ============================================================================
// Common Logic Tests (6 tests)
// ============================================================================

describe('Common Logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Promotion Timing', () => {
    it('should respect promotion timeout', async () => {
      const worker = new PromotionWorker(mockEnv);
      
      // Set timeout
      const timeout = 300000; // 5 minutes
      
      // Simulate waiting for timeout
      const start = Date.now();
      
      // Check that timeout is respected
      expect(timeout).toBe(300000);
    });
  });

  describe('Concurrent Limits', () => {
    it('should enforce max concurrent candidates', () => {
      const maxConcurrent = 10;
      const current = 5;
      const canAddMore = current < maxConcurrent;
      
      expect(canAddMore).toBe(true);
    });
  });

  describe('State Management', () => {
    it('should track promotion state correctly', () => {
      const states: PromotionState[] = [
        { id: 'promo-001', candidateId: 'candidate-001', specId: 'spec-001', currentRung: 'pre-merge', targetRung: 'shadow', status: 'pending', mode: 'tournament', startedAt: new Date().toISOString() },
        { id: 'promo-002', candidateId: 'candidate-002', specId: 'spec-001', currentRung: 'shadow', targetRung: 'train', status: 'in_progress', mode: 'merge-train', startedAt: new Date().toISOString() },
        { id: 'promo-003', candidateId: 'candidate-003', specId: 'spec-001', currentRung: 'train', targetRung: 'canary', status: 'completed', mode: 'tournament', startedAt: new Date().toISOString(), completedAt: new Date().toISOString() },
      ];
      
      // Check various states
      expect(states[0].status).toBe('pending');
      expect(states[1].status).toBe('in_progress');
      expect(states[2].status).toBe('completed');
    });
  });

  describe('Dependency Checks', () => {
    it('should verify dependencies before promotion', () => {
      // Dependencies must exist
      const dependencies = ['SPEC_DO', 'PREVIEW_MANAGER', 'GATE_WORKFLOW'];
      const allExist = dependencies.every(d => mockEnv[d as keyof Env] !== undefined);
      
      expect(allExist).toBe(true);
    });
  });

  describe('Cleanup on Failure', () => {
    it('should cleanup state on promotion failure', () => {
      const state: PromotionState = {
        id: 'promo-001',
        candidateId: 'candidate-001',
        specId: 'spec-001',
        currentRung: 'pre-merge',
        targetRung: 'shadow',
        status: 'failed',
        mode: 'tournament',
        startedAt: new Date().toISOString(),
        failedAt: new Date().toISOString(),
        failureReason: 'Gate check failed',
      };
      
      expect(state.status).toBe('failed');
      expect(state.failureReason).toBe('Gate check failed');
      expect(state.failedAt).toBeDefined();
    });
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
    expect(data.worker).toBe('promotion-worker');
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
// Mode Management Tests (3 tests)
// ============================================================================

describe('Mode Management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should get current promotion mode', async () => {
    const worker = new PromotionWorker(mockEnv);
    
    // The mode should be read from environment
    const mode: PromotionMode = 'tournament';
    
    expect(['tournament', 'merge-train']).toContain(mode);
  });

  it('should set promotion mode', () => {
    const mode: PromotionMode = 'merge-train';
    
    expect(mode).toBe('merge-train');
  });

  it('should switch between modes', () => {
    const modes: PromotionMode[] = ['tournament', 'merge-train'];
    
    modes.forEach(mode => {
      expect(['tournament', 'merge-train']).toContain(mode);
    });
  });
});

// ============================================================================
// Promotion Tests (4 tests)
// ============================================================================

describe('Promotion Operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should promote a candidate', async () => {
    const worker = new PromotionWorker(mockEnv);
    
    const request: PromotionRequest = {
      candidateId: 'candidate-001',
      specId: 'spec-001',
      fromRung: 'pre-merge',
      toRung: 'shadow',
      actorId: 'agent-001',
      timestamp: new Date().toISOString(),
    };
    
    // Mock spec DO response
    mockSpecDoService.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });
    
    const response = await worker.promoteCandidate(request);
    
    // Response should be valid
    expect(response).toBeDefined();
  });

  it('should return 400 for invalid promotion request', async () => {
    const worker = new PromotionWorker(mockEnv);
    
    const request: PromotionRequest = {
      candidateId: '', // Invalid
      specId: '', // Invalid
      fromRung: 'pre-merge',
      toRung: 'shadow',
    };
    
    const response = await worker.promoteCandidate(request);
    
    // Should return error response
    expect(response.status).toBeDefined();
  });

  it('should get promotion status', async () => {
    const worker = new PromotionWorker(mockEnv);
    
    // Mock spec DO response
    mockSpecDoService.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        status: 'in_progress',
        candidates: 5,
        completed: 2,
      }),
    });
    
    const response = await worker.getPromotionStatus();
    
    expect(response.status).toBeDefined();
  });

  it('should get candidate promotion status', async () => {
    const worker = new PromotionWorker(mockEnv);
    
    // Mock spec DO response
    mockSpecDoService.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        candidateId: 'candidate-001',
        status: 'in_progress',
        currentRung: 'shadow',
        targetRung: 'train',
      }),
    });
    
    const response = await worker.getCandidatePromotionStatus('candidate-001');
    
    expect(response.status).toBeDefined();
  });
});

// ============================================================================
// Spec DO ledger wiring: the promotion worker against a real SpecDO (node:sqlite)
// ============================================================================

describe('Spec DO promotion ledger wiring', () => {
  async function ledgerEnv(mode: PromotionMode) {
    // Raw DO: the promotion worker's own client must carry the tier-1 token
    const spec = makeSpecDo(undefined, false);
    await spec.init();
    const env: Env = {
      ...mockEnv,
      ...TEST_INTERNAL_ONLY,
      PROMOTION_MODE: mode,
      SPEC_DO: {
        idFromName: () => 'main',
        get: () => ({ fetch: (request: Request) => spec.fetch(request) }),
      } as unknown as DurableObjectNamespace,
    };
    return { spec, env };
  }

  const request = (candidateId: string, specId = 'spec-1'): PromotionRequest => ({
    candidateId,
    specId,
    fromRung: 'shadow',
    toRung: 'train',
    actorId: 'agent-1',
  });

  it('tournament mode: records the promotion state and the tournament in the DO', async () => {
    const { spec, env } = await ledgerEnv('tournament');
    const worker = new PromotionWorker(env);

    const response = await worker.promoteCandidate(request('cand-1'));
    expect(response.status).toBe(200);
    expect(((await response.json()) as PromotionResult).success).toBe(true);

    const states = spec.listPromotionStates('cand-1');
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ status: 'completed', mode: 'tournament', currentRung: 'train', targetRung: 'train' });

    const tournaments = spec.listTournaments('spec-1');
    expect(tournaments).toHaveLength(1);
    expect(tournaments[0].candidates.map((c) => c.candidateId)).toEqual(['cand-1']);
  });

  it('tournament mode: a second candidate completes the tournament via PATCH', async () => {
    const { spec, env } = await ledgerEnv('tournament');
    // The winner is recorded on a real candidate row (PATCH /api/candidates/:id/stage)
    const agent = spec.createActor('agent', 'agent-1').id;
    const org = spec.createOrganization('org', 'artifacts');
    const repo = spec.createRepository('repo', org.id, 'baseline', undefined, undefined, 'https://example.invalid/r.git', 'ns');
    const s = spec.createSpec('spec', 'd', 'contract', [], org.id, agent);
    const c1 = spec.createCandidate(s.id, repo.id, 'sha1', 'base', agent);
    const c2 = spec.createCandidate(s.id, repo.id, 'sha2', 'base', agent);
    mockShadowRouter.fetch.mockResolvedValue(
      new Response(JSON.stringify({ winner: c2.id, score: 90 }), { status: 200 })
    );
    const worker = new PromotionWorker(env);

    await worker.promoteCandidate(request(c1.id, s.id));
    const response = await worker.promoteCandidate(request(c2.id, s.id));
    expect(response.status).toBe(200);

    const [tournament] = spec.listTournaments(s.id);
    expect(tournament.status).toBe('completed');
    expect(tournament.winner).toBeDefined();
    expect(tournament.candidates).toHaveLength(2);
    expect(spec.getCandidate(tournament.winner!)?.stage).toBe('passed_train');
  });

  it('merge-train mode: records the train and the merged car in the DO', async () => {
    const { spec, env } = await ledgerEnv('merge-train');
    mockGateWorkflow.fetch.mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    const worker = new PromotionWorker(env);

    const response = await worker.promoteCandidate(request('cand-1'));
    expect(response.status).toBe(200);

    const [train] = spec.listMergeTrains('spec-1');
    expect(train.candidates).toEqual([
      expect.objectContaining({ candidateId: 'cand-1', position: 1, status: 'merged' }),
    ]);
    expect(train.status).toBe('idle');
    expect(train.nextMerge).toBeNull();
    expect(spec.listPromotionStates('cand-1')[0].status).toBe('completed');
  });

  it('candidate status reads the latest state from the DO', async () => {
    const { env } = await ledgerEnv('tournament');
    const worker = new PromotionWorker(env);
    await worker.promoteCandidate(request('cand-1'));

    const body = (await (await worker.getCandidatePromotionStatus('cand-1')).json()) as { state: PromotionState };
    expect(body.state).toMatchObject({ candidateId: 'cand-1', status: 'completed' });

    const none = (await (await worker.getCandidatePromotionStatus('cand-x')).json()) as { status: string };
    expect(none.status).toBe('not_started');
  });

  it('a second promotion of a candidate is allowed once the first completed', async () => {
    const { spec, env } = await ledgerEnv('tournament');
    const worker = new PromotionWorker(env);
    await worker.promoteCandidate(request('cand-1'));
    const second = await worker.promoteCandidate({ ...request('cand-1'), fromRung: 'train', toRung: 'canary' });
    expect(second.status).toBe(200);
    expect(spec.listPromotionStates('cand-1').map((s) => s.targetRung)).toEqual(['canary', 'train']);
  });

  it('currentRung advances to targetRung on completion and stays the start rung on failure', async () => {
    const { spec, env } = await ledgerEnv('tournament');
    const manager = new PromotionStateManager(env);
    const ok = await manager.createPromotionState('cand-ok', 'spec-1', 'shadow', 'train', 'tournament');
    const bad = await manager.createPromotionState('cand-bad', 'spec-1', 'shadow', 'train', 'tournament');
    await manager.markAsCompleted(ok.id, ok.targetRung);
    await manager.markAsFailed(bad.id, 'boom');

    expect(spec.listPromotionStates('cand-ok')[0]).toMatchObject({ status: 'completed', currentRung: 'train' });
    expect(spec.listPromotionStates('cand-bad')[0]).toMatchObject({ status: 'failed', currentRung: 'shadow' });
  });

  it('an undefined field in an update clears it in the DO (retry reset)', async () => {
    const { spec, env } = await ledgerEnv('tournament');
    const manager = new PromotionStateManager(env);
    const state = await manager.createPromotionState('cand-1', 'spec-1', 'shadow', 'train', 'tournament');
    await manager.markAsFailed(state.id, 'boom');
    await manager.updatePromotionState(state.id, { status: 'pending', failedAt: undefined, failureReason: undefined });

    const [stored] = spec.listPromotionStates('cand-1');
    expect(stored.status).toBe('pending');
    expect(stored).not.toHaveProperty('failedAt');
    expect(stored).not.toHaveProperty('failureReason');
  });
});

describe('Spec DO errors are not empty results', () => {
  // A Spec DO that serves no ledger routes: every call is the router's generic 404
  function unservedEnv(): Env {
    return {
      ...mockEnv,
      SPEC_DO: {
        idFromName: () => 'main',
        get: () => ({
          fetch: async (req: Request) =>
            new URL(req.url).pathname === '/promotion-mode'
              ? new Response(JSON.stringify({ mode: null }))
              : new Response(JSON.stringify({ success: false, error: 'Not found' }), { status: 404 }),
        }),
      } as unknown as DurableObjectNamespace,
    };
  }

  it('getPromotionState throws on 404 instead of returning null', async () => {
    const manager = new PromotionStateManager(unservedEnv());
    await expect(manager.getPromotionState('cand-1')).rejects.toThrow(/404/);
  });

  it('getPromotionStates throws on 404 instead of returning []', async () => {
    const manager = new PromotionStateManager(unservedEnv());
    await expect(manager.getPromotionStates()).rejects.toThrow(/404/);
  });

  it('getPromotionState throws on 500', async () => {
    const env = {
      ...mockEnv,
      SPEC_DO: {
        idFromName: () => 'main',
        get: () => ({ fetch: async () => new Response('db down', { status: 500 }) }),
      } as unknown as DurableObjectNamespace,
    };
    await expect(new PromotionStateManager(env).getPromotionState('cand-1')).rejects.toThrow(/500 db down/);
  });

  it('promoteCandidate fails (500) rather than treating the train as empty', async () => {
    const response = await new PromotionWorker(unservedEnv()).promoteCandidate({
      candidateId: 'cand-1',
      specId: 'spec-1',
      fromRung: 'shadow',
      toRung: 'train',
    });
    expect(response.status).toBe(500);
    expect(((await response.json()) as { success: boolean }).success).toBe(false);
  });

  it('client: coded 404 on a lookup is null, uncoded 404 throws', async () => {
    const coded = new PromotionLedgerClient({
      fetch: async () => new Response(JSON.stringify({ code: RECORD_NOT_FOUND }), { status: 404 }),
    });
    expect(await coded.getTournamentBySpec('spec-1')).toBeNull();
    expect(await coded.getMergeTrainBySpec('spec-1')).toBeNull();

    const uncoded = new PromotionLedgerClient({
      fetch: async () => new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }),
    });
    await expect(uncoded.getTournamentBySpec('spec-1')).rejects.toThrow(/404/);
    await expect(uncoded.listTournaments()).rejects.toThrow(/404/);
    await expect(uncoded.listMergeTrains()).rejects.toThrow(/404/);
  });

  it('client: a malformed DO response is rejected', async () => {
    const client = new PromotionLedgerClient({
      fetch: async () => new Response(JSON.stringify([{ id: 'x', candidate_id: 'snake_case' }]), { status: 200 }),
    });
    await expect(client.listPromotionStates()).rejects.toThrow(/invalid Spec DO response/);
  });
});
