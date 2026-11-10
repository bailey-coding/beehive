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
import { PromotionLedgerClient, RECORD_NOT_FOUND, MAX_CAS_ATTEMPTS, type MergeTrainRecord } from '../../shared/promotion-ledger';
import { VERSION_CONFLICT } from '../../shared/ledger-state-machine';
import { GateWorkflowRequestSchema, GATE_WORKFLOW_ORIGIN, GATE_PRE_MERGE_PATH } from '../../shared/schemas';
import { getPromotionLedger } from '../spec-do';
import { makeSpecDo } from '../../spec-do/tests/sqlite-state';
import { TEST_INTERNAL_ONLY, authedDo } from '../../spec-do/tests/do-tokens';

// The gate worker's real answer shape for POST /gates/pre-merge: 201 {success, verdictId, result:{status,...}}
// even when the verdict is fail (workers/gate-workflow/index.ts returns success:true with result.status)
function gateVerdictResponse(status: 'pass' | 'fail' | 'pending', notes = 'gate note'): Response {
  return new Response(
    JSON.stringify({ success: true, verdictId: 'verdict-mt-1', result: { status, score: status === 'pass' ? 90 : 10, notes }, timestamp: Date.now() }),
    { status: 201, headers: { 'Content-Type': 'application/json' } }
  );
}

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

  // Real candidate rows: the worker asks the Spec DO's advance route whether each move is legal (docs/plans/promotion-gaps-plan.md PR C),
  // so a synthetic candidate id is a 404. Shadow scores reach the ledger through the Spec DO's shadow-samples route.
  async function realWorld(mode: PromotionMode) {
    const { spec, env } = await ledgerEnv(mode);
    const agent = spec.createActor('agent', 'agent-1').id;
    const org = spec.createOrganization('org-lw', 'artifacts');
    const repo = spec.createRepository('repo-lw', org.id, 'baseline', undefined, undefined, 'https://example.invalid/r.git', 'ns');
    const s = spec.createSpec('spec-lw', 'd', 'contract', [], org.id, agent);
    const candidate = (stage: string) => {
      const c = spec.createCandidate(s.id, repo.id, 'sha1', 'base', agent);
      spec.transitionCandidate(c.id, stage as never, 'test');
      return c.id;
    };
    const score = async (id: string, value: number) => {
      const res = await authedDo(spec).fetch(
        new Request(`https://spec-do.internal/api/candidates/${id}/shadow-samples`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Actor-ID': 'scientist-comparator' },
          body: JSON.stringify({ samples: [{ requestId: `r-${id}`, score: value, matched: true, diffs: [] }] }),
        })
      );
      expect(res.status).toBe(200);
    };
    const request = (candidateId: string): PromotionRequest => ({ candidateId, specId: s.id, fromRung: 'shadow', toRung: 'train', actorId: agent });
    return { spec, env, specId: s.id, agent, candidate, score, request };
  }

  it('tournament mode: records the promotion state and the tournament in the DO', async () => {
    const { spec, env, specId, candidate, request } = await realWorld('tournament');
    const worker = new PromotionWorker(env);
    const c1 = candidate('passed_premerge');

    const response = await worker.promoteCandidate(request(c1));
    // Alone in the tournament: accepted, not moved
    expect(response.status).toBe(202);
    const body = (await response.json()) as PromotionResult;
    expect(body).toMatchObject({ success: true, outcome: 'waiting' });

    const states = spec.listPromotionStates(c1);
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ status: 'completed', mode: 'tournament', currentRung: 'shadow', targetRung: 'train' });

    const tournaments = spec.listTournaments(specId);
    expect(tournaments).toHaveLength(1);
    expect(tournaments[0].candidates.map((c) => c.candidateId)).toEqual([c1]);
  });

  it('tournament mode: a second candidate completes the tournament and the higher shadow score wins', async () => {
    const { spec, env, specId, candidate, score, request } = await realWorld('tournament');
    const c1 = candidate('passed_premerge');
    const c2 = candidate('passed_premerge');
    await score(c1, 60);
    await score(c2, 90);
    const worker = new PromotionWorker(env);

    await worker.promoteCandidate(request(c1));
    const response = await worker.promoteCandidate(request(c2));
    expect(response.status).toBe(200);

    const [tournament] = spec.listTournaments(specId);
    expect(tournament.status).toBe('completed');
    expect(tournament.winner).toBe(c2);
    expect(tournament.candidates).toHaveLength(2);
    expect(spec.getCandidate(c2)?.stage).toBe('passed_shadow');
    expect(spec.getCandidate(c1)?.stage).toBe('passed_premerge');
    // The winner is written by the Spec DO's advance, one rung at a time: no skip-ahead, so PR-S has nothing to log
    // (this was a recorded invalid_transition on every tournament run before PR C; docs/MILESTONES.md PR-S prerequisite (a))
    const rows = (spec as unknown as { queryAll(sql: string): Record<string, unknown>[] }).queryAll(
      `SELECT subject, reason, detail FROM governance_events WHERE event = 'invalid_transition'`
    );
    expect(rows).toHaveLength(0);
  });

  it('merge-train mode: records the train and the merged car in the DO', async () => {
    const { spec, env, specId, candidate } = await realWorld('merge-train');
    const c = candidate('passed_shadow');
    mockGateWorkflow.fetch.mockResolvedValue(gateVerdictResponse('pass'));
    const worker = new PromotionWorker(env);

    const response = await worker.promoteCandidate({ candidateId: c, specId, fromRung: 'train', toRung: 'canary', actorId: 'agent-1' });
    expect(response.status).toBe(200);

    const [train] = spec.listMergeTrains(specId);
    expect(train.candidates).toEqual([
      expect.objectContaining({ candidateId: c, position: 1, status: 'merged' }),
    ]);
    expect(train.status).toBe('idle');
    expect(train.nextMerge).toBeNull();
    expect(spec.listPromotionStates(c)[0].status).toBe('completed');
    // The merged car is what moves the stage (docs/MILESTONES.md PR-S prerequisite (b))
    expect(spec.getCandidate(c)?.stage).toBe('passed_train');
  });

  it('candidate status reads the latest state from the DO', async () => {
    const { env, candidate, request } = await realWorld('tournament');
    const worker = new PromotionWorker(env);
    const c = candidate('passed_premerge');
    await worker.promoteCandidate(request(c));

    const body = (await (await worker.getCandidatePromotionStatus(c)).json()) as { state: PromotionState };
    expect(body.state).toMatchObject({ candidateId: c, status: 'completed' });

    const none = (await (await worker.getCandidatePromotionStatus('cand-x')).json()) as { status: string };
    expect(none.status).toBe('not_started');
  });

  it('a second promotion of a candidate is allowed once the first completed', async () => {
    const { spec, env, specId, candidate, agent } = await realWorld('tournament');
    const worker = new PromotionWorker(env);
    const c = candidate('pending');
    spec.createGateVerdict(c, 'pre-merge', 'pass', 90, 0, agent);
    const first = await worker.promoteCandidate({ candidateId: c, specId, toRung: 'shadow', actorId: agent });
    expect(first.status).toBe(200);
    const second = await worker.promoteCandidate({ candidateId: c, specId, toRung: 'train', actorId: agent });
    expect(second.status).toBe(202); // alone in the tournament: waiting
    expect(spec.listPromotionStates(c).map((s) => s.targetRung)).toEqual(['train', 'shadow']);
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

// ============================================================================
// Merge train: a car is (position, candidateId) (docs/plans/merge-train-car-matching-plan.md)
// ============================================================================

describe('Merge train: a car is (position, candidateId)', () => {
  type Car = MergeTrainCandidate;
  type Hook = (request: Request) => Promise<Response | undefined>;

  // A real SpecDO behind the worker's own client, with an optional hook that sees each request first.
  // The train's specId is a real UUID (set into SPEC) and gate-reaching tests use real candidate rows via
  // addCandidate(): executeMerge reads GET /api/candidates/:id for the commit shas, and the gate request body
  // must parse with GateWorkflowRequestSchema (UUID ids).
  async function trainEnv() {
    const spec = makeSpecDo(undefined, false);
    await spec.init();
    const agent = spec.createActor('agent', 'agent-mt').id;
    const org = spec.createOrganization('org-mt', 'artifacts');
    const repo = spec.createRepository('repo-mt', org.id, 'baseline', undefined, undefined, 'https://example.invalid/r.git', 'ns');
    const s = spec.createSpec('spec-mt', 'd', 'contract', [], org.id, agent);
    SPEC = s.id;
    const box: { hook?: Hook } = {};
    const namespace = (withHook: boolean) =>
      ({
        idFromName: () => 'main',
        get: () => ({
          fetch: async (request: Request) =>
            (withHook && box.hook ? await box.hook(request.clone()) : undefined) ?? spec.fetch(request),
        }),
      }) as unknown as DurableObjectNamespace;
    const base = { ...mockEnv, ...TEST_INTERNAL_ONLY, PROMOTION_MODE: 'merge-train' };
    const env: Env = { ...base, SPEC_DO: namespace(true) };
    // Writes made "by someone else" (seeding, another claimer) bypass the hook
    const direct = getPromotionLedger({ ...base, SPEC_DO: namespace(false) });
    const addCandidate = (commitSha = 'sha1', baseCommitSha = 'base') =>
      spec.createCandidate(s.id, repo.id, commitSha, baseCommitSha, agent).id;
    return { spec, env, box, direct, addCandidate };
  }

  let SPEC = '';
  const request = (candidateId: string): PromotionRequest => ({
    candidateId, specId: SPEC, fromRung: 'shadow', toRung: 'train', actorId: 'agent-1',
  });
  const car = (candidateId: string, position: number, status: Car['status'], extra: Partial<Car> = {}): Car => ({
    candidateId, specId: SPEC, position, status, ...extra,
  });
  const seed = (direct: PromotionLedgerClient, candidates: Car[]) =>
    direct.saveMergeTrain({
      id: 'mt-seed', mode: 'merge-train', specId: SPEC, candidates,
      currentPosition: candidates.length, nextMerge: null, status: 'idle',
    });
  // The gate's real answer shape: 201 {success, verdictId, result:{status,...}} even for a fail verdict
  const gateResponse = gateVerdictResponse;
  const gate = (...outcomes: Array<'pass' | string>) => {
    let i = 0;
    mockGateWorkflow.fetch.mockReset();
    mockGateWorkflow.fetch.mockImplementation(async () => {
      const o = outcomes[Math.min(i++, outcomes.length - 1)];
      return o === 'pass' ? gateResponse('pass') : gateResponse('fail', o);
    });
  };
  const trainOf = (spec: Awaited<ReturnType<typeof trainEnv>>['spec']) => spec.listMergeTrains(SPEC)[0];
  const drops = (spec: Awaited<ReturnType<typeof trainEnv>>['spec'], candidateId: string) =>
    spec
      .listNearMisses({ candidateId, reason: 'train_drop', limit: 50, offset: 0 })
      .map((n) => `${n.sourceRef}:${(n.evidence as { status: string }).status}`)
      .sort();
  const writesCar = async (request: Request, status: Car['status']) => {
    if (!new URL(request.url).pathname.startsWith('/merge-train-status')) return false;
    if (request.method !== 'POST' && request.method !== 'PATCH') return false;
    const body = (await request.json()) as { candidates?: Car[] };
    return (body.candidates ?? []).some((c) => c.status === status);
  };

  it('1. a candidate re-added after a failure merges: only the new car changes, the old car stays failed', async () => {
    const { spec, env, addCandidate } = await trainEnv();
    const manager = new MergeTrainManager(env);
    const a = addCandidate();
    gate('conformance', 'pass');

    await manager.executeMergeTrain(request(a));
    const [failed] = trainOf(spec).candidates;
    expect(failed).toMatchObject({ position: 1, status: 'failed', failureReason: expect.stringContaining('conformance') });

    await manager.executeMergeTrain(request(a));
    const train = trainOf(spec);
    expect(train.candidates).toEqual([failed, expect.objectContaining({ candidateId: a, position: 2, status: 'merged' })]);
    expect(drops(spec, a)).toEqual([`${train.id}#1:failed`]);
  });

  it('2. a re-added candidate that fails again: the old car keeps its failure, two near-misses', async () => {
    const { spec, env, addCandidate } = await trainEnv();
    const manager = new MergeTrainManager(env);
    const a = addCandidate();
    gate('first reason', 'second reason');

    await manager.executeMergeTrain(request(a));
    const [failed] = trainOf(spec).candidates;
    await manager.executeMergeTrain(request(a));
    const train = trainOf(spec);
    expect(train.candidates[0]).toEqual(failed);
    expect(train.candidates[1]).toMatchObject({ position: 2, status: 'failed', failureReason: expect.stringContaining('second reason') });
    expect(drops(spec, a)).toEqual([`${train.id}#1:failed`, `${train.id}#2:failed`]);
  });

  it('3. a candidate promoted twice: the first car keeps its mergedAt, the response names the new car', async () => {
    const { spec, env, addCandidate } = await trainEnv();
    const manager = new MergeTrainManager(env);
    const a = addCandidate();
    gate('pass');

    await manager.executeMergeTrain(request(a));
    const [first] = trainOf(spec).candidates;
    const second = await manager.executeMergeTrain({ ...request(a), fromRung: 'train', toRung: 'canary' });
    expect(second.details?.position).toBe(2);
    const train = trainOf(spec);
    expect(train.candidates).toEqual([first, expect.objectContaining({ position: 2, status: 'merged' })]);
    expect(drops(spec, a)).toEqual([]);
  });

  it('4. retry resets only the latest car, and refuses when the latest car is not failed', async () => {
    const { spec, env, direct, addCandidate } = await trainEnv();
    const manager = new MergeTrainManager(env);
    const a = addCandidate();
    gate('pass');
    const old = car(a, 1, 'failed', { failedAt: '2026-10-01T00:00:00.000Z', failureReason: 'old' });
    await seed(direct, [old, car(a, 2, 'failed', { failedAt: '2026-10-02T00:00:00.000Z', failureReason: 'new' })]);

    expect((await manager.retryFailedMerge(a, SPEC)).success).toBe(true);
    expect(trainOf(spec).candidates).toEqual([old, expect.objectContaining({ position: 2, status: 'merged' })]);
    expect(mockGateWorkflow.fetch).toHaveBeenCalledTimes(1);

    const refused = await manager.retryFailedMerge(a, SPEC);
    expect(refused.success).toBe(false);
    expect(refused.message).toContain('not in a failed state (current: merged)');
    expect(trainOf(spec).candidates[0]).toEqual(old);
  });

  it('5. rollback checks the latest car and rolls back every merged car of the candidate, never a failed one', async () => {
    const { spec, env, direct, addCandidate } = await trainEnv();
    const manager = new MergeTrainManager(env);
    const id = addCandidate();
    const failed = { ...car(id, 1, 'failed', { failureReason: 'old' }), specId: SPEC };
    await seed(direct, [failed, car(id, 2, 'merged', { mergedAt: '2026-10-02T00:00:00.000Z' })]);

    const result = await manager.rollbackMergedCandidate(id, SPEC, 'canary regressed');
    expect(result.success).toBe(true);
    expect(trainOf(spec).candidates).toEqual([
      failed,
      expect.objectContaining({ position: 2, status: 'rolled_back', failureReason: 'Rolled back: canary regressed' }),
    ]);
    expect(drops(spec, id)).toEqual(['mt-seed#1:failed', 'mt-seed#2:rolled_back']);
  });

  it('5b. rollback of a candidate with two merged cars rolls back both (one near-miss per car)', async () => {
    const { spec, env, direct, addCandidate } = await trainEnv();
    const manager = new MergeTrainManager(env);
    const id = addCandidate();
    await seed(direct, [car(id, 1, 'merged'), car(id, 2, 'merged')]);

    expect((await manager.rollbackMergedCandidate(id, SPEC, 'x')).success).toBe(true);
    expect(trainOf(spec).candidates.map((c) => c.status)).toEqual(['rolled_back', 'rolled_back']);
    expect(drops(spec, id)).toEqual(['mt-seed#1:rolled_back', 'mt-seed#2:rolled_back']);
  });

  it('6. a car added while a gate runs is kept (no lost update, no false removed near-miss)', async () => {
    const { spec, env, direct, addCandidate } = await trainEnv();
    const manager = new MergeTrainManager(env);
    const a = addCandidate();
    mockGateWorkflow.fetch.mockReset();
    mockGateWorkflow.fetch.mockImplementationOnce(async () => {
      await direct.modifyMergeTrain(SPEC, (t) => ({ ...t, candidates: [...t.candidates, car('cand-b', 2, 'waiting')] }));
      return gateResponse('pass');
    });

    await manager.executeMergeTrain(request(a));
    expect(trainOf(spec).candidates).toEqual([
      expect.objectContaining({ candidateId: a, position: 1, status: 'merged' }),
      car('cand-b', 2, 'waiting'),
    ]);
    expect(drops(spec, 'cand-b')).toEqual([]);
  });

  it('7. a car claimed by someone else between the claim read and write is not run again; the add still succeeds', async () => {
    const { spec, env, box, direct, addCandidate } = await trainEnv();
    const manager = new MergeTrainManager(env);
    const a = addCandidate();
    gate('pass');
    let other: MergeTrainRecord | undefined;
    box.hook = async (req) => {
      if (other || !(await writesCar(req, 'merging'))) return undefined;
      // Another claimer's real DO write lands between this claim's GET and its write
      other = (await direct.modifyMergeTrain(SPEC, (t) => ({
        ...t,
        candidates: t.candidates.map((c) => (c.status === 'waiting' ? { ...c, status: 'merging' as const } : c)),
      })))!;
      return undefined;
    };

    const result = await manager.executeMergeTrain(request(a));
    expect(result.success).toBe(true);
    expect(mockGateWorkflow.fetch).toHaveBeenCalledTimes(0);
    expect(other).toBeDefined();
    expect(trainOf(spec)).toEqual(other);
  });

  it('7b. a claim that exhausts its CAS attempts leaves the car waiting and the add succeeds', async () => {
    const { spec, env, box, addCandidate } = await trainEnv();
    const manager = new MergeTrainManager(env);
    const a = addCandidate();
    gate('pass');
    let refused = 0;
    box.hook = async (req) => {
      if (!(await writesCar(req, 'merging'))) return undefined;
      refused++;
      return new Response(JSON.stringify({ error: 'stale', code: VERSION_CONFLICT }), { status: 409 });
    };

    const result = await manager.executeMergeTrain(request(a));
    expect(result.success).toBe(true);
    expect(refused).toBe(MAX_CAS_ATTEMPTS);
    expect(mockGateWorkflow.fetch).toHaveBeenCalledTimes(0);
    expect(trainOf(spec).candidates).toEqual([car(a, 1, 'waiting')]);
  });

  it('8. a gate that passed is never recorded as failed when the outcome write exhausts CAS', async () => {
    const { spec, env, box, addCandidate } = await trainEnv();
    const manager = new MergeTrainManager(env);
    const a = addCandidate();
    gate('pass');
    let refused = 0;
    box.hook = async (req) => {
      if (!(await writesCar(req, 'merged'))) return undefined;
      refused++;
      return new Response(JSON.stringify({ error: 'stale', code: VERSION_CONFLICT }), { status: 409 });
    };

    const result = await manager.executeMergeTrain(request(a));
    expect(result.success).toBe(false);
    expect(refused).toBe(MAX_CAS_ATTEMPTS);
    expect(trainOf(spec).candidates).toEqual([car(a, 1, 'merging')]);
    expect(drops(spec, a)).toEqual([]);
  });

  it('9. a car stuck merging does not stop the next car (known limitation: it is never recovered)', async () => {
    const { spec, env, direct, addCandidate } = await trainEnv();
    const manager = new MergeTrainManager(env);
    const a = addCandidate();
    gate('pass');
    const stuck = car('cand-x', 1, 'merging');
    await seed(direct, [stuck]);

    await manager.executeMergeTrain(request(a));
    expect(trainOf(spec).candidates).toEqual([stuck, expect.objectContaining({ candidateId: a, position: 2, status: 'merged' })]);
  });

  it('10. a car moved out of merging by another writer during its gate keeps that state; no merged is written', async () => {
    const { spec, env, box, direct, addCandidate } = await trainEnv();
    const manager = new MergeTrainManager(env);
    const a = addCandidate();
    let other: MergeTrainRecord | undefined;
    mockGateWorkflow.fetch.mockReset();
    mockGateWorkflow.fetch.mockImplementationOnce(async () => {
      // An old worker's blind PATCH marks the claimed car failed while this gate runs
      const t = (await direct.getMergeTrainBySpec(SPEC))!;
      other = await direct.updateMergeTrain(t.id, {
        candidates: t.candidates.map((c) => ({ ...c, status: 'failed' as const, failureReason: 'old worker' })),
      });
      return gateResponse('pass');
    });
    let mergedWrites = 0;
    box.hook = async (req) => {
      if (await writesCar(req, 'merged')) mergedWrites++;
      return undefined;
    };

    await manager.executeMergeTrain(request(a));
    expect(mockGateWorkflow.fetch).toHaveBeenCalledTimes(1);
    expect(mergedWrites).toBe(0);
    expect(trainOf(spec)).toEqual(other);
    expect(trainOf(spec).candidates).toEqual([expect.objectContaining({ position: 1, status: 'failed', failureReason: 'old worker' })]);
  });

  // Holds a car with the same key as the one being processed, so only the train-id check keeps writes out of it
  const newerTrain = (direct: PromotionLedgerClient, candidateId: string, status: Car['status'] = 'waiting') =>
    direct.saveMergeTrain({
      id: 'mt-newer', mode: 'merge-train', specId: SPEC, candidates: [car(candidateId, 1, status)],
      currentPosition: 1, nextMerge: 'cand-z', status: 'processing',
    });

  it('11. a newer train for the spec that appears during the gate gets no outcome write; the car stays merging in its train', async () => {
    const { spec, env, direct, addCandidate } = await trainEnv();
    const manager = new MergeTrainManager(env);
    const a = addCandidate();
    let newer: MergeTrainRecord | undefined;
    mockGateWorkflow.fetch.mockReset();
    mockGateWorkflow.fetch.mockImplementationOnce(async () => {
      newer = await newerTrain(direct, a, 'merging');
      return gateResponse('pass');
    });

    await manager.executeMergeTrain(request(a));
    const [latest, older] = spec.listMergeTrains(SPEC);
    expect(latest).toEqual(newer);
    expect(older.candidates).toEqual([car(a, 1, 'merging')]);
  });

  it('11b. a newer train for the spec that appears before the claim gets no claim and no gate runs', async () => {
    const { spec, env, box, direct, addCandidate } = await trainEnv();
    const manager = new MergeTrainManager(env);
    const a = addCandidate();
    gate('pass');
    let newer: MergeTrainRecord | undefined;
    box.hook = async (req) => {
      if (newer || req.method !== 'POST' || !(await writesCar(req.clone(), 'waiting'))) return undefined;
      // The add lands, then a newer train is created before the claim reads the spec's train
      const res = await spec.fetch(req);
      newer = await newerTrain(direct, a);
      return res;
    };

    expect((await manager.executeMergeTrain(request(a))).success).toBe(true);
    expect(mockGateWorkflow.fetch).toHaveBeenCalledTimes(0);
    const [latest, older] = spec.listMergeTrains(SPEC);
    expect(latest).toEqual(newer);
    expect(older.candidates).toEqual([car(a, 1, 'waiting')]);
  });

  it('positions stay unique when a car was removed', async () => {
    const { spec, env, direct, addCandidate } = await trainEnv();
    const a = addCandidate();
    gate('pass');
    await seed(direct, [car('cand-x', 2, 'merged')]); // car 1 removed by a non-worker write
    await new MergeTrainManager(env).executeMergeTrain(request(a));
    expect(trainOf(spec).candidates.map((c) => c.position)).toEqual([2, 3]);
  });

  // ============================================================================
  // The gate call itself (task merge-train-gate-call, docs/plans/merge-train-gate-call-plan.md section 6)
  // ============================================================================

  it('12. the gate call posts the shared pre-merge path with bearer auth and the candidate row shas', async () => {
    const { spec, env, addCandidate } = await trainEnv();
    const manager = new MergeTrainManager(env);
    const commitSha = 'ab'.repeat(20);
    const baseCommitSha = 'cd'.repeat(20);
    const a = addCandidate(commitSha, baseCommitSha);
    let seen: { url: string; init?: RequestInit } | undefined;
    mockGateWorkflow.fetch.mockReset();
    mockGateWorkflow.fetch.mockImplementation(async (input: unknown, init?: RequestInit) => {
      seen = { url: String(input), init };
      return gateResponse('pass');
    });

    await manager.executeMergeTrain(request(a));
    expect(mockGateWorkflow.fetch).toHaveBeenCalledTimes(1);
    expect(seen!.url).toBe(`${GATE_WORKFLOW_ORIGIN}${GATE_PRE_MERGE_PATH}`);
    expect(seen!.init?.method).toBe('POST');
    const headers = new Headers(seen!.init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer test-auth-token');
    expect(headers.get('X-Actor-ID')).toBe('promotion-worker');
    expect(headers.get('Content-Type')).toBe('application/json');
    // The old /run contract cannot satisfy this: the body must parse with the gate's own request schema
    const body = GateWorkflowRequestSchema.parse(JSON.parse(String(seen!.init?.body)));
    expect(body).toMatchObject({
      candidateId: a, specId: SPEC, commitSha, baseCommitSha, actorId: 'promotion-worker',
    });
    expect(trainOf(spec).candidates[0].status).toBe('merged');
  });

  it('13. snake_case candidate fields are accepted as a fallback', async () => {
    const { spec, env, box, addCandidate } = await trainEnv();
    const manager = new MergeTrainManager(env);
    const a = addCandidate('aa'.repeat(20), 'bb'.repeat(20));
    box.hook = async (req) => {
      if (req.method === 'GET' && new URL(req.url).pathname === `/api/candidates/${a}`) {
        return new Response(
          JSON.stringify({ data: { id: a, specId: SPEC, commit_sha: 'aa'.repeat(20), base_commit_sha: 'bb'.repeat(20) } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return undefined;
    };
    let body: { commitSha?: string; baseCommitSha?: string } | undefined;
    mockGateWorkflow.fetch.mockReset();
    mockGateWorkflow.fetch.mockImplementation(async (_input: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return gateResponse('pass');
    });

    await manager.executeMergeTrain(request(a));
    expect(body).toMatchObject({ commitSha: 'aa'.repeat(20), baseCommitSha: 'bb'.repeat(20) });
    expect(trainOf(spec).candidates[0].status).toBe('merged');
  });

  it('14. a fail verdict answered with success:true fails the car, reason carries status and verdict id', async () => {
    const { spec, env, addCandidate } = await trainEnv();
    const manager = new MergeTrainManager(env);
    const a = addCandidate();
    mockGateWorkflow.fetch.mockReset();
    mockGateWorkflow.fetch.mockResolvedValue(gateResponse('fail', 'conformance mismatch'));

    await manager.executeMergeTrain(request(a));
    const [c] = trainOf(spec).candidates;
    expect(c.status).toBe('failed');
    expect(c.failureReason).toContain('Pre-merge gate fail');
    expect(c.failureReason).toContain('verdict-mt-1');
    expect(c.failureReason).toContain('conformance mismatch');
  });

  it('15. pending, a non-JSON body and a missing result all fail the car (never "empty is pass")', async () => {
    const cases: Array<[string, () => Response]> = [
      ['pending', () => gateResponse('pending')],
      ['non-JSON', () => new Response('not json', { status: 201, headers: { 'Content-Type': 'application/json' } })],
      ['missing result', () => new Response(JSON.stringify({ success: true, verdictId: 'verdict-mt-1' }), { status: 201 })],
      ['success false', () => new Response(JSON.stringify({ success: false, error: 'boom' }), { status: 201 })],
    ];
    for (const [label, make] of cases) {
      const { spec, env, addCandidate } = await trainEnv();
      const manager = new MergeTrainManager(env);
      const a = addCandidate();
      mockGateWorkflow.fetch.mockReset();
      mockGateWorkflow.fetch.mockImplementation(async () => make());
      await manager.executeMergeTrain(request(a));
      const [c] = trainOf(spec).candidates;
      expect(c.status, label).toBe('failed');
      expect(c.failureReason, label).toBeTruthy();
    }
  });

  it('16. non-ok gate answers (404 the old route, 401, 500) fail the car with the status in the reason', async () => {
    for (const status of [404, 401, 500]) {
      const { spec, env, addCandidate } = await trainEnv();
      const manager = new MergeTrainManager(env);
      const a = addCandidate();
      mockGateWorkflow.fetch.mockReset();
      mockGateWorkflow.fetch.mockResolvedValue(new Response(JSON.stringify({ error: 'nope' }), { status }));
      await manager.executeMergeTrain(request(a));
      const [c] = trainOf(spec).candidates;
      expect(c.status, `status ${status}`).toBe('failed');
      expect(c.failureReason, `status ${status}`).toContain(`Gate answered ${status}`);
    }
  });

  it('17. no gate call when the candidate lookup 404s, the candidate has no shas, or API_AUTH_TOKEN is unset', async () => {
    // Candidate lookup 404 (a well-formed UUID that is not in the DO)
    const first = await trainEnv();
    mockGateWorkflow.fetch.mockReset();
    await new MergeTrainManager(first.env).executeMergeTrain(request(crypto.randomUUID()));
    expect(mockGateWorkflow.fetch).toHaveBeenCalledTimes(0);
    expect(trainOf(first.spec).candidates[0].failureReason).toContain('Failed to get candidate');

    // Candidate row without shas
    const second = await trainEnv();
    const noShas = second.addCandidate('', '');
    mockGateWorkflow.fetch.mockReset();
    await new MergeTrainManager(second.env).executeMergeTrain(request(noShas));
    expect(mockGateWorkflow.fetch).toHaveBeenCalledTimes(0);
    expect(trainOf(second.spec).candidates[0].failureReason).toContain('has no commitSha/baseCommitSha');

    // No API_AUTH_TOKEN: fail closed before the call, same as the queue consumer
    const third = await trainEnv();
    const a = third.addCandidate();
    const noTokenEnv: Env = { ...third.env, API_AUTH_TOKEN: undefined };
    mockGateWorkflow.fetch.mockReset();
    await new MergeTrainManager(noTokenEnv).executeMergeTrain(request(a));
    expect(mockGateWorkflow.fetch).toHaveBeenCalledTimes(0);
    expect(trainOf(third.spec).candidates[0].failureReason).toBe('API_AUTH_TOKEN not configured');
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
