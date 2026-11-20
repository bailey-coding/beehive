/**
 * The promotion worker reads and moves candidates only through routes the Spec DO serves: GET /api/candidates/:id, POST
 * /api/candidates/:id/advance (a tournament winner; docs/plans/promotion-gaps-plan.md PR C) and PATCH /api/candidates/:id/stage (a
 * merge-train rollback, which is never gated). It once called routes that do not exist and never noticed (docs/OPEN-QUESTIONS.md 2026-10-16).
 */
import { describe, it, expect, vi } from 'vitest';
import { TournamentManager } from '../../workers/promotion-worker/tournament';
import { MergeTrainManager } from '../../workers/promotion-worker/merge-train';

const TOKEN = 'worker-tier1-token';

function envWith(respond: (request: Request) => Response | Promise<Response>) {
  const calls: Request[] = [];
  const stub = {
    fetch: async (request: Request) => {
      calls.push(request);
      return respond(request);
    },
  };
  const env = { SPEC_DO: { idFromName: () => 'id', get: () => stub }, SPEC_DO_INTERNAL_TOKEN: TOKEN } as never;
  return { env, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const metrics = { passRate: 0, failureRate: 0, latencyP95: 0, latencyP50: 0, errorRate: 0, throughput: 0, score: 0, conformanceScore: 0, complexityDelta: 0, stability: 0 };
const entrant = (candidateId: string, status = 'competing') => ({ candidateId, specId: 's1', score: 0, status, metrics });
const tournament = {
  id: 't1',
  mode: 'tournament',
  specId: 's1',
  status: 'pending',
  candidates: [entrant('c1'), entrant('c2')],
  comparisons: [] as unknown[],
  startedAt: '2026-11-01T00:00:00.000Z',
  version: 1,
};
/** Enough samples for a tournament score (wave-2a part D1) */
const scored = (shadowScore: number, totalRequests = 20) => ({ shadowScore, shadowMetrics: JSON.stringify({ totalRequests }) });

describe('tournament candidate routes', () => {
  it('reads metrics from GET /api/candidates/:id', async () => {
    const { env, calls } = envWith(() =>
      json({ success: true, data: { shadowScore: 91, shadowMetrics: JSON.stringify({ latencyP95: 7 }) } })
    );
    const metrics = await (new TournamentManager(env) as any).getCandidateMetrics('c1');
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(['GET /api/candidates/c1']);
    expect(metrics.score).toBe(91);
    expect(metrics.latencyP95).toBe(7);
  });

  it('a rejected candidate read is an error, never defaults (a 404 is not "empty")', async () => {
    const { env } = envWith(() => json({ success: false }, 404));
    await expect((new TournamentManager(env) as any).getCandidateMetrics('c1')).rejects.toThrow(/404/);
    await expect((new TournamentManager(env) as any).readShadowScore('c1')).rejects.toThrow(/404/);
  });

  it('a candidate with no shadow score, or fewer than SHADOW_MIN_SAMPLES samples, reads as null, and a score of 0 as 0', async () => {
    const answers: Record<string, unknown> = {
      c1: { id: 'c1' },
      c2: { id: 'c2', ...scored(0) },
      c3: { id: 'c3', ...scored(100, 19) }, // one short of the minimum (wave-2a part D1)
      c4: { id: 'c4', shadowScore: 100 }, // no count at all: fail closed
      c5: { id: 'c5', shadowScore: 100, shadowMetrics: '{not json' },
    };
    const { env } = envWith((request) => json({ success: true, data: answers[new URL(request.url).pathname.split('/').pop()!] }));
    const manager = new TournamentManager(env) as any;
    expect(await manager.readShadowScore('c1')).toBeNull();
    expect(await manager.readShadowScore('c2')).toBe(0);
    expect(await manager.readShadowScore('c3')).toBeNull();
    expect(await manager.readShadowScore('c4')).toBeNull();
    expect(await manager.readShadowScore('c5')).toBeNull();
  });

  // The tournament record the ledger holds: GET by spec answers it, a POST replaces it (the worker's compare-and-swap writes, wave-2a part D3)
  let stored: Record<string, any>;
  const writes: Array<Record<string, any>> = [];
  const run = (respond: (request: Request) => Response | Promise<Response>) => {
    stored = structuredClone(tournament);
    writes.length = 0;
    const { env, calls } = envWith(async (request) => {
      const u = new URL(request.url);
      if (u.pathname === '/tournament-status' && request.method === 'GET') return json(stored);
      if (u.pathname === '/tournament-status' && request.method === 'POST') {
        const body = (await request.clone().json()) as Record<string, any>;
        writes.push(body);
        stored = { ...body, version: stored.version + 1 };
        return json(stored);
      }
      return respond(request);
    });
    const manager = new TournamentManager(env) as any;
    vi.spyOn(manager, 'getOrCreateTournament').mockImplementation(async () => stored);
    vi.spyOn(manager, 'addCandidateToTournament').mockImplementation(async () => stored);
    const update = vi.spyOn(manager, 'updateTournament').mockResolvedValue(undefined);
    const execute = () =>
      manager.executeTournament({ candidateId: 'c2', specId: 's1', fromRung: 'shadow', toRung: 'train', actorId: 'agent-1' });
    return { calls, update, execute };
  };
  const advanced = { fromRung: 'shadow', toRung: 'train', stage: 'passed_shadow', previousStage: 'passed_premerge', noop: false, dryRun: false, writes: ['passed_shadow'], evidence: [] };
  const route = (overrides: Record<string, (request: Request) => Response | Promise<Response>> = {}) => (request: Request): Response | Promise<Response> => {
    const path = `${request.method} ${new URL(request.url).pathname}`;
    if (overrides[path]) return overrides[path](request);
    if (path === 'GET /api/candidates/c1') return json({ success: true, data: scored(90) });
    if (path === 'GET /api/candidates/c2') return json({ success: true, data: scored(85) });
    if (path === 'POST /api/trials') return json({ success: true, data: { id: 'tr1' } }, 201);
    if (path === 'POST /api/trials/tr1/decide') return json({ success: true, data: {} });
    // Every entrant's dry run, and the winner's real advance
    if (path === 'POST /api/candidates/c1/advance' || path === 'POST /api/candidates/c2/advance') return json({ success: true, data: advanced });
    return json({ success: false, error: `unexpected ${path}` }, 500);
  };

  it('moves the winner with POST /api/candidates/:id/advance, never the stage PATCH, and never /compare', async () => {
    const { calls, update, execute } = run(route());
    const result = await execute();
    expect(result).toMatchObject({ success: true, outcome: 'eliminated', moves: [{ candidateId: 'c1', fromRung: 'shadow', toRung: 'train' }] });
    const paths = calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
    // dry-run each entrant, read both scores, CLAIM the winner (read + versioned write), advance it, complete (read + write), THEN the trial
    expect(paths).toEqual([
      'POST /api/candidates/c1/advance', 'POST /api/candidates/c2/advance', 'GET /api/candidates/c1', 'GET /api/candidates/c2',
      'GET /tournament-status', 'POST /tournament-status',
      'POST /api/candidates/c1/advance',
      'GET /tournament-status', 'POST /tournament-status',
      'POST /api/trials', 'POST /api/trials/tr1/decide',
    ]);
    expect(await calls[0].json()).toMatchObject({ dryRun: true, toRung: 'train', fromRung: 'shadow' });
    const adv = calls[6];
    expect(adv.headers.get('X-Actor-ID')).toBe('agent-1');
    const advBody = (await adv.json()) as Record<string, unknown>;
    expect(advBody).toMatchObject({ toRung: 'train', fromRung: 'shadow' });
    expect(advBody.dryRun).toBeUndefined();
    expect(calls[5].headers.get('X-Expected-Version')).toBe('1');
    expect(calls[9].headers.get('Idempotency-Key')).toBe('tournament:t1:c1:c2');
    // the claim: in_progress with the winner and the contested loser, before the move; then the completion
    expect(writes[0]).toMatchObject({ status: 'in_progress', winner: 'c1', comparisons: [{ candidate1: 'c1', candidate2: 'c2', winner: 'c1' }] });
    expect(writes[1]).toMatchObject({ status: 'completed', winner: 'c1', completedAt: expect.any(String) });
    expect(Object.fromEntries(writes[1].candidates.map((c: any) => [c.candidateId, c.status]))).toEqual({ c1: 'winner', c2: 'eliminated' });
    expect(update).not.toHaveBeenCalled();
  });

  it("fails the tournament, retryably, when the winner's advance is rejected, and relays the Spec DO's code", async () => {
    // The dry runs pass (the entrants are eligible); the real advance of the winner is refused
    const { update, execute } = run(route({
      'POST /api/candidates/c1/advance': async (request) =>
        ((await request.clone().json()) as { dryRun?: boolean }).dryRun
          ? json({ success: true, data: advanced })
          : json({ success: false, error: 'Cannot move to train from stage failed', code: 'not_next_rung' }, 409),
    }));
    const result = await execute();
    expect(result).toMatchObject({ success: false, code: 'not_next_rung' });
    // the claim, then ONE full-record failure write that clears the claimed winner and the contested set (a PATCH could not clear them)
    expect(writes.map((w) => w.status)).toEqual(['in_progress', 'failed']);
    expect(writes[1]).toMatchObject({ failureReason: expect.stringContaining('not_next_rung'), comparisons: [] });
    expect(writes[1].winner).toBeUndefined();
    expect(update).not.toHaveBeenCalled();
  });

  it('an older Spec DO without the advance route stops the attempt as ledger_too_old: nobody is disqualified, nothing is written', async () => {
    const { update, calls, execute } = run(route({
      'POST /api/candidates/c1/advance': () => json({ success: false, error: 'Not found' }, 404),
      'POST /api/candidates/c2/advance': () => json({ success: false, error: 'Not found' }, 404),
    }));
    const result = await execute();
    expect(result).toMatchObject({ success: false, code: 'ledger_too_old' });
    expect(update).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(calls.every((c) => c.method === 'POST' && new URL(c.url).pathname.endsWith('/advance'))).toBe(true);
  });

  it('a transient ledger error while re-checking an entrant is a 502 ledger_error that disqualifies nobody (a healthy entrant must not be knocked out by a 5xx)', async () => {
    const { update, execute } = run(route({ 'POST /api/candidates/c1/advance': () => json({ success: false, error: 'boom' }, 500) }));
    const result = await execute();
    expect(result).toMatchObject({ success: false, code: 'ledger_error' });
    expect(update).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('completing a claimed tournament is ONE write (status, statuses, completion): losers are the contested set stored at the claim, a late entrant stays competing', async () => {
    run(() => json({ success: false }, 500));
    stored = {
      ...structuredClone(tournament),
      status: 'in_progress',
      winner: 'c1',
      comparisons: [{ candidate1: 'c1', candidate2: 'c2', winner: 'c1', comparisonScore: 5, comparedAt: '2026-11-01T00:00:00.000Z' }],
      candidates: [entrant('c1'), entrant('c2'), entrant('c3', 'disqualified'), entrant('late')],
    };
    const { env } = envWith(async (request) => {
      if (request.method === 'GET') return json(stored);
      const body = (await request.clone().json()) as Record<string, any>;
      writes.push(body);
      return json({ ...body, version: 2 });
    });
    const manager = new TournamentManager(env) as any;
    expect(await manager.completeClaimed('t1', 's1')).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ status: 'completed', winner: 'c1', completedAt: expect.any(String) });
    expect(Object.fromEntries(writes[0].candidates.map((c: any) => [c.candidateId, c.status]))).toEqual({ c1: 'winner', c2: 'eliminated', c3: 'disqualified', late: 'competing' });
  });

});

describe('merge train rollback', () => {
  const train = {
    id: 'm1',
    candidates: [{ candidateId: 'c1', status: 'merged' }],
  };

  it('records the rollback on the candidate with its reason', async () => {
    const { env, calls } = envWith(() => json({ success: true, data: {} }));
    const manager = new MergeTrainManager(env) as any;
    vi.spyOn(manager, 'modifyMergeTrain').mockImplementation(async (_s: string, fn: (t: unknown) => unknown) => fn(train));
    const result = await manager.rollbackMergedCandidate('c1', 's1', 'canary regressed');
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PATCH');
    expect(new URL(calls[0].url).pathname).toBe('/api/candidates/c1/stage');
    expect(await calls[0].json()).toEqual({
      stage: 'rolled_back',
      notes: 'Rolled back from merge train: canary regressed',
    });
  });

  it('reports a rejected rollback record as a failure', async () => {
    const { env } = envWith(() => json({ success: false }, 500));
    const manager = new MergeTrainManager(env) as any;
    vi.spyOn(manager, 'modifyMergeTrain').mockImplementation(async (_s: string, fn: (t: unknown) => unknown) => fn(train));
    const result = await manager.rollbackMergedCandidate('c1', 's1', 'x');
    expect(result.success).toBe(false);
    expect(result.message).toContain('500');
  });
});

describe('merge train capacity', () => {
  it('the capacity check inside the compare-and-swap write (a car added between the check and the write) is the same coded refusal as the check before it', async () => {
    const { env } = envWith(() => json({ success: true, data: {} }));
    const manager = new MergeTrainManager({ ...(env as object), MAX_CONCURRENT_CANDIDATES: '1' } as never) as any;
    vi.spyOn(manager, 'getOrCreateMergeTrain').mockResolvedValue({ id: 'm1', specId: 's1', candidates: [], currentPosition: 0, status: 'idle' });
    vi.spyOn(manager, 'modifyMergeTrain').mockRejectedValue(new Error('Maximum concurrent candidates (1) reached. Please wait.'));
    const result = await manager.executeMergeTrain({ candidateId: 'c1', specId: 's1', fromRung: 'train', toRung: 'canary' });
    expect(result).toMatchObject({ success: false, code: 'train_full' });
  });

  it('any other error is merge_train_error', async () => {
    const { env } = envWith(() => json({ success: true, data: {} }));
    const manager = new MergeTrainManager(env) as any;
    vi.spyOn(manager, 'getOrCreateMergeTrain').mockRejectedValue(new Error('ledger exploded'));
    const result = await manager.executeMergeTrain({ candidateId: 'c1', specId: 's1', fromRung: 'train', toRung: 'canary' });
    expect(result).toMatchObject({ success: false, code: 'merge_train_error' });
  });
});
