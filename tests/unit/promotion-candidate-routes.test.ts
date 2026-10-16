/**
 * The promotion worker records tournament winners and merge-train rollbacks on the candidate through
 * routes the Spec DO serves (PATCH /api/candidates/:id/stage, GET /api/candidates/:id). It once called
 * routes that do not exist and never noticed (docs/OPEN-QUESTIONS.md 2026-10-16).
 */
import { describe, it, expect, vi } from 'vitest';
import { TournamentManager } from '../../workers/promotion-worker/tournament';
import { MergeTrainManager } from '../../workers/promotion-worker/merge-train';

const TOKEN = 'worker-tier1-token';

function envWith(respond: (request: Request) => Response) {
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

  it('falls back to defaults when the candidate read is rejected', async () => {
    const { env } = envWith(() => json({ success: false }, 404));
    const metrics = await (new TournamentManager(env) as any).getCandidateMetrics('c1');
    expect(metrics.score).toBe(80);
  });

  it('records the winner with PATCH /api/candidates/:id/stage', async () => {
    const { env, calls } = envWith(() => json({ success: true, data: {} }));
    const manager = new TournamentManager(env) as any;
    const update = vi.spyOn(manager, 'updateTournament').mockResolvedValue(undefined);
    await manager.promoteTournamentWinner({ candidateId: 'c1' }, 'canary', tournament);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PATCH');
    expect(new URL(calls[0].url).pathname).toBe('/api/candidates/c1/stage');
    expect(calls[0].headers.get('X-Actor-ID')).toBe('promotion-worker');
    expect(await calls[0].json()).toMatchObject({ stage: 'passed_canary' });
    expect(update).toHaveBeenCalledWith('t1', expect.objectContaining({ winner: 'c1' }));
  });

  it('maps the full rung to the promoted stage', async () => {
    const { env, calls } = envWith(() => json({ success: true, data: {} }));
    const manager = new TournamentManager(env) as any;
    vi.spyOn(manager, 'updateTournament').mockResolvedValue(undefined);
    await manager.promoteTournamentWinner({ candidateId: 'c1' }, 'full', tournament);
    expect(await calls[0].json()).toMatchObject({ stage: 'promoted' });
  });

  it('fails the tournament when the winner promotion is rejected', async () => {
    const { env } = envWith(() => json({ success: false, error: 'Not found' }, 404));
    const manager = new TournamentManager(env) as any;
    vi.spyOn(manager, 'getOrCreateTournament').mockResolvedValue(tournament);
    vi.spyOn(manager, 'addCandidateToTournament').mockResolvedValue(tournament);
    vi.spyOn(manager, 'runTournamentComparisons').mockResolvedValue([]);
    vi.spyOn(manager, 'determineTournamentWinner').mockReturnValue({ candidateId: 'c1' });
    const update = vi.spyOn(manager, 'updateTournament').mockResolvedValue(undefined);
    const complete = vi.spyOn(manager, 'completeTournament').mockResolvedValue(undefined);

    const result = await manager.executeTournament({
      candidateId: 'c1', specId: 's1', fromRung: 'shadow', toRung: 'canary',
    });

    expect(result.success).toBe(false);
    expect(complete).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ status: 'failed', failureReason: expect.stringContaining('404') })
    );
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
