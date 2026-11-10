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

const tournament = {
  id: 't1',
  specId: 's1',
  status: 'in_progress',
  candidates: [
    { candidateId: 'c1', status: 'competing' },
    { candidateId: 'c2', status: 'competing' },
  ],
};

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

  it('a candidate with no shadow score reads as null, and a score of 0 as 0', async () => {
    const answers: Record<string, unknown> = { c1: { id: 'c1' }, c2: { id: 'c2', shadowScore: 0 } };
    const { env } = envWith((request) => json({ success: true, data: answers[new URL(request.url).pathname.split('/').pop()!] }));
    const manager = new TournamentManager(env) as any;
    expect(await manager.readShadowScore('c1')).toBeNull();
    expect(await manager.readShadowScore('c2')).toBe(0);
  });

  const run = (respond: (request: Request) => Response | Promise<Response>) => {
    const { env, calls } = envWith(respond);
    const manager = new TournamentManager(env) as any;
    vi.spyOn(manager, 'getOrCreateTournament').mockResolvedValue(tournament);
    vi.spyOn(manager, 'addCandidateToTournament').mockResolvedValue(tournament);
    const update = vi.spyOn(manager, 'updateTournament').mockResolvedValue(undefined);
    const execute = () =>
      manager.executeTournament({ candidateId: 'c2', specId: 's1', fromRung: 'shadow', toRung: 'train', actorId: 'agent-1' });
    return { calls, update, execute };
  };
  const advanced = { fromRung: 'shadow', toRung: 'train', stage: 'passed_shadow', previousStage: 'passed_premerge', noop: false, dryRun: false, writes: ['passed_shadow'], evidence: [] };
  const route = (overrides: Record<string, (request: Request) => Response | Promise<Response>> = {}) => (request: Request): Response | Promise<Response> => {
    const path = `${request.method} ${new URL(request.url).pathname}`;
    if (overrides[path]) return overrides[path](request);
    if (path === 'GET /api/candidates/c1') return json({ success: true, data: { shadowScore: 90 } });
    if (path === 'GET /api/candidates/c2') return json({ success: true, data: { shadowScore: 50 } });
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
    // dry-run each entrant, read both scores, advance the winner, THEN record the trial
    expect(paths).toEqual([
      'POST /api/candidates/c1/advance', 'POST /api/candidates/c2/advance', 'GET /api/candidates/c1', 'GET /api/candidates/c2',
      'POST /api/candidates/c1/advance', 'POST /api/trials', 'POST /api/trials/tr1/decide',
    ]);
    expect(await calls[0].json()).toMatchObject({ dryRun: true, toRung: 'train', fromRung: 'shadow' });
    const adv = calls[4];
    expect(adv.headers.get('X-Actor-ID')).toBe('agent-1');
    expect(await adv.json()).toMatchObject({ toRung: 'train', fromRung: 'shadow' });
    expect(calls[4].method + calls[4].url).not.toContain('dryRun');
    expect(calls[5].headers.get('Idempotency-Key')).toBe('tournament:t1:c1:c2');
    expect(update).toHaveBeenCalledWith('t1', expect.objectContaining({ winner: 'c1' }));
    expect(update).toHaveBeenCalledWith('t1', expect.objectContaining({ status: 'completed', winner: 'c1' }));
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
    expect(update).toHaveBeenCalledWith('t1', expect.objectContaining({ status: 'failed', failureReason: expect.stringContaining('not_next_rung') }));
    expect(update).not.toHaveBeenCalledWith('t1', expect.objectContaining({ status: 'completed' }));
  });

  it('an older Spec DO without the advance route disqualifies nobody into a win: the tournament refuses, naming ledger_too_old', async () => {
    const { execute } = run(route({
      'POST /api/candidates/c1/advance': () => json({ success: false, error: 'Not found' }, 404),
      'POST /api/candidates/c2/advance': () => json({ success: false, error: 'Not found' }, 404),
    }));
    const result = await execute();
    expect(result).toMatchObject({ success: false, code: 'not_enough_entrants' });
    expect(result.message).toContain('ledger_too_old');
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
