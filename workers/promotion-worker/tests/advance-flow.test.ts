/**
 * The promotion worker on `advance` (promotion-gaps PR C, docs/plans/promotion-gaps-plan.md sections 3.5, 11 N5, 12 V1/V2, 14): the Spec DO decides
 * whether a candidate may move; the worker runs the competitive step for it (the tournament for shadow -> train, the merge train for
 * train -> canary) or advances directly, and reports what happened with a stable code. Real SQL (node:sqlite, foreign keys on) behind the
 * worker's own client.
 *
 * Task: promotion-gaps | Spec: docs/plans/promotion-gaps-plan.md PR C
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PromotionWorker } from '../promotion';
import type { Env, PromotionMode, PromotionRequest, PromotionResult } from '../types';
import { makeSqliteState, makeSpecDo } from '../../spec-do/tests/sqlite-state';
import { authedDo, TEST_INTERNAL_ONLY } from '../../spec-do/tests/do-tokens';
import { getPromotionLedger } from '../spec-do';
import { decideTournament } from '../tournament';

const gateFetch = vi.fn();
const shadowRouterFetch = vi.fn();

function gateResponse(status: 'pass' | 'fail', notes = 'gate note'): Response {
  return new Response(JSON.stringify({ success: true, verdictId: 'v-1', result: { status, score: status === 'pass' ? 90 : 10, notes }, timestamp: Date.now() }), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
}

type Hook = (request: Request) => Promise<Response | undefined>;

async function world(mode: PromotionMode) {
  const store = makeSqliteState();
  const spec = makeSpecDo(store, false);
  await spec.init();
  const direct = authedDo(spec);
  const agent = spec.createActor('agent', 'agent-1').id;
  const org = spec.createOrganization('org-pf', 'artifacts');
  const repo = spec.createRepository('repo-pf', org.id, 'baseline', undefined, undefined, 'https://example.invalid/r.git', 'ns');
  const s = spec.createSpec('spec-pf', 'd', 'contract', [], org.id, agent);
  const box: { hook?: Hook } = {};
  const env = {
    SPEC_DO: {
      idFromName: () => 'main',
      get: () => ({ fetch: async (request: Request) => (box.hook ? await box.hook(request.clone()) : undefined) ?? spec.fetch(request) }),
    },
    GATE_WORKFLOW: { fetch: gateFetch },
    SHADOW_ROUTER: { fetch: shadowRouterFetch },
    PREVIEW_MANAGER: { fetch: vi.fn() },
    ANALYTICS: { writeDataPoint: vi.fn() },
    PROMOTION_MODE: mode,
    MAX_CONCURRENT_CANDIDATES: '10',
    PROMOTION_TIMEOUT: '300000',
    API_AUTH_TOKEN: 'test-auth-token',
    ...TEST_INTERNAL_ONLY,
  } as unknown as Env;
  const worker = new PromotionWorker(env);

  let n = 0;
  const candidate = (stage = 'pending') => {
    n += 1;
    const id = spec.createCandidate(s.id, repo.id, `sha${n}`, 'base', agent).id;
    if (stage !== 'pending') store.raw.prepare('UPDATE candidates SET stage = ? WHERE id = ?').run(stage, id);
    return id;
  };
  const stageOf = (id: string) => (store.raw.prepare('SELECT stage FROM candidates WHERE id = ?').get(id) as { stage: string }).stage;
  const promote = async (body: Partial<PromotionRequest> & { candidateId: string; toRung: PromotionRequest['toRung'] }) => {
    const res = await worker.promoteCandidate({ specId: s.id, actorId: agent, ...body } as PromotionRequest);
    return { status: res.status, json: (await res.json()) as PromotionResult & Record<string, any> };
  };
  const samples = async (id: string, score: number) => {
    const res = await direct.fetch(
      new Request(`https://spec-do.internal/api/candidates/${id}/shadow-samples`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Actor-ID': 'scientist-comparator' },
        body: JSON.stringify({ samples: [{ requestId: `r-${id}-${score}-${Math.random()}`, score, matched: score >= 100, diffs: [] }] }),
      })
    );
    expect(res.status).toBe(200);
  };
  const passPremerge = (id: string) => spec.createGateVerdict(id, 'pre-merge', 'pass', 90, 0, agent);
  const deployCanary = async (id: string, minutesAgo = 20) => {
    const res = await direct.fetch(
      new Request('https://spec-do.internal/canary-deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Actor-ID': 'canary-worker' },
        body: JSON.stringify({ candidateId: id, specId: s.id, url: `https://${id}.example.workers.dev`, workerVersionId: `ver-${id}`, commitSha: 'sha', trafficPercentage: 10, holdoutPercentage: 5 }),
      })
    );
    expect(res.status).toBe(201);
    store.raw.prepare('UPDATE deploy_refs SET moved_at = moved_at - ?').run(minutesAgo * 60_000);
  };
  const states = (id: string) => spec.listPromotionStates(id);
  const count = (sql: string) => (store.raw.prepare(sql).get() as { n: number }).n;
  const events = (name: string) => store.raw.prepare('SELECT * FROM governance_events WHERE event = ?').all(name) as Record<string, unknown>[];
  return { store, spec, env, worker, box, agent, specId: s.id, candidate, stageOf, promote, samples, passPremerge, deployCanary, states, count, events };
}

beforeEach(() => {
  gateFetch.mockReset();
  shadowRouterFetch.mockReset();
  vi.restoreAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('decideTournament (pure)', () => {
  it('ranks by score and names the runner-up', () => {
    expect(decideTournament([{ candidateId: 'a', score: 60 }, { candidateId: 'b', score: 90 }, { candidateId: 'c', score: 75 }])).toMatchObject({
      kind: 'winner', winnerId: 'b', runnerUpId: 'c', scores: { b: 90, c: 75, a: 60 },
    });
  });
  it('a score of 0 is a real score, not a missing one: it loses to 50 and wins against nothing', () => {
    expect(decideTournament([{ candidateId: 'a', score: 0 }, { candidateId: 'b', score: 50 }])).toMatchObject({ kind: 'winner', winnerId: 'b' });
  });
  it('any entrant without a score refuses with no_shadow_evidence, and so does a lone entrant', () => {
    expect(decideTournament([{ candidateId: 'a', score: 80 }, { candidateId: 'b', score: null }])).toMatchObject({ kind: 'refused', code: 'no_shadow_evidence' });
    expect(decideTournament([{ candidateId: 'a', score: null }, { candidateId: 'b', score: null }])).toMatchObject({ kind: 'refused', code: 'no_shadow_evidence' });
    expect(decideTournament([{ candidateId: 'a', score: 80 }])).toMatchObject({ kind: 'refused', code: 'no_shadow_evidence' });
  });
  it('a tie for first refuses with tie, a tie below first does not', () => {
    expect(decideTournament([{ candidateId: 'a', score: 80 }, { candidateId: 'b', score: 80 }])).toMatchObject({ kind: 'refused', code: 'tie' });
    expect(decideTournament([{ candidateId: 'a', score: 80 }, { candidateId: 'b', score: 70 }, { candidateId: 'c', score: 70 }])).toMatchObject({ kind: 'winner', winnerId: 'a' });
  });
});

describe.each(['tournament', 'merge-train'] as PromotionMode[])('direct moves, %s mode', (mode) => {
  it('pending -> shadow with a pre-merge pass: moved, the promotion state completes at shadow, no tournament or train is created', async () => {
    const w = await world(mode);
    const c = w.candidate();
    w.passPremerge(c);
    const res = await w.promote({ candidateId: c, toRung: 'shadow' });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ success: true, outcome: 'moved', fromRung: 'pre-merge', toRung: 'shadow', moves: [{ candidateId: c, fromRung: 'pre-merge', toRung: 'shadow' }] });
    expect(w.stageOf(c)).toBe('passed_premerge');
    expect(w.states(c)).toMatchObject([{ status: 'completed', currentRung: 'shadow', targetRung: 'shadow', mode }]);
    expect(w.spec.listTournaments(w.specId)).toHaveLength(0);
    expect(w.spec.listMergeTrains(w.specId)).toHaveLength(0);
  });

  it('missing pre-merge evidence is a 409 evidence_missing with the Spec DO reason, and nothing is created in the promotion ledger', async () => {
    const w = await world(mode);
    const c = w.candidate();
    const res = await w.promote({ candidateId: c, toRung: 'shadow' });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ success: false, code: 'evidence_missing' });
    expect(res.json.error).toMatch(/no pre-merge gate verdict/);
    expect(w.stageOf(c)).toBe('pending');
    expect(w.states(c)).toHaveLength(0);
  });

  it('an unknown candidate is a 404 candidate_not_found', async () => {
    const w = await world(mode);
    const res = await w.promote({ candidateId: 'c-nope', toRung: 'shadow' });
    expect(res.status).toBe(404);
    expect(res.json.code).toBe('candidate_not_found');
    expect(w.states('c-nope')).toHaveLength(0);
  });

  it("an older Spec DO's code-less 404 on advance is a 503 ledger_too_old, never 'unknown candidate'", async () => {
    const w = await world(mode);
    const c = w.candidate();
    w.box.hook = async (request) =>
      new URL(request.url).pathname.endsWith('/advance') ? Response.json({ success: false, error: 'Not found' }, { status: 404 }) : undefined;
    const res = await w.promote({ candidateId: c, toRung: 'shadow' });
    expect(res.status).toBe(503);
    expect(res.json.code).toBe('ledger_too_old');
    expect(w.states(c)).toHaveLength(0);
  });

  it('a Spec DO 500, a network error and an unparsable body on advance are 502 ledger_error', async () => {
    const w = await world(mode);
    const c = w.candidate();
    for (const hook of [
      async () => Response.json({ success: false, error: 'boom' }, { status: 500 }),
      async () => {
        throw new Error('network down');
      },
      async () => Response.json({ success: true, data: { nope: 1 } }),
    ] as Hook[]) {
      w.box.hook = async (request) => (new URL(request.url).pathname.endsWith('/advance') ? hook(request) : undefined);
      const res = await w.promote({ candidateId: c, toRung: 'shadow' });
      expect(res.status).toBe(502);
      expect(res.json.code).toBe('ledger_error');
    }
    expect(w.states(c)).toHaveLength(0);
  });

  it('a repeated request for a move that already happened is a 200 noop with no new promotion state', async () => {
    const w = await world(mode);
    const c = w.candidate();
    w.passPremerge(c);
    await w.promote({ candidateId: c, toRung: 'shadow', fromRung: 'pre-merge' });
    const again = await w.promote({ candidateId: c, toRung: 'shadow', fromRung: 'pre-merge' });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ success: true, outcome: 'noop' });
    expect(w.states(c)).toHaveLength(1);
  });

  it('fromRung is optional (the Spec DO derives it); a wrong one is a 409 stale_from_rung and creates no state', async () => {
    const w = await world(mode);
    const c = w.candidate();
    w.passPremerge(c);
    const stale = await w.promote({ candidateId: c, toRung: 'shadow', fromRung: 'shadow' });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('stale_from_rung');
    expect(w.states(c)).toHaveLength(0);
    const derived = await w.promote({ candidateId: c, toRung: 'shadow' });
    expect(derived.json).toMatchObject({ success: true, fromRung: 'pre-merge' });
  });

  it('skipping a rung is a 409 not_next_rung', async () => {
    const w = await world(mode);
    const c = w.candidate();
    const res = await w.promote({ candidateId: c, toRung: 'canary' });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('not_next_rung');
  });

  it.each(['pre-merge', 'warp', undefined])('toRung %s is a 400', async (toRung) => {
    const w = await world(mode);
    const c = w.candidate();
    const res = await w.promote({ candidateId: c, toRung: toRung as never });
    expect(res.status).toBe(400);
  });

  it('canary -> full needs a live, soaked canary: refused without, moved with, promoted via passed_canary', async () => {
    const w = await world(mode);
    const c = w.candidate('passed_train');
    const refused = await w.promote({ candidateId: c, toRung: 'full' });
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe('evidence_missing');
    expect(refused.json.error).toMatch(/not the live canary/);
    await w.deployCanary(c);
    const ok = await w.promote({ candidateId: c, toRung: 'full', fromRung: 'canary' });
    expect(ok.status).toBe(200);
    expect(ok.json.outcome).toBe('moved');
    expect(w.stageOf(c)).toBe('promoted');
    expect(w.count("SELECT COUNT(*) AS n FROM governance_events WHERE event = 'invalid_transition'")).toBe(0);
  });
});

describe('tournament mode: shadow -> train is the competition', () => {
  async function two(scoreA: number | null, scoreB: number | null) {
    const w = await world('tournament');
    const a = w.candidate('passed_premerge');
    const b = w.candidate('passed_premerge');
    if (scoreA !== null) await w.samples(a, scoreA);
    if (scoreB !== null) await w.samples(b, scoreB);
    return { w, a, b };
  }

  it('the first entrant waits: 202, its state finishes at the rung it started from, nothing moves', async () => {
    const { w, a } = await two(70, 90);
    const res = await w.promote({ candidateId: a, toRung: 'train' });
    expect(res.status).toBe(202);
    expect(res.json).toMatchObject({ success: true, outcome: 'waiting' });
    expect(w.stageOf(a)).toBe('passed_premerge');
    expect(w.states(a)).toMatchObject([{ status: 'completed', currentRung: 'shadow', targetRung: 'train' }]);
    expect(w.spec.listTournaments(w.specId)[0].status).toBe('pending');
  });

  it('the higher shadow score wins even when it arrives second; the loser stays on shadow with a near-miss and the decision is a trial', async () => {
    const { w, a, b } = await two(60, 90);
    await w.promote({ candidateId: a, toRung: 'train' });
    const res = await w.promote({ candidateId: b, toRung: 'train' });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ success: true, outcome: 'moved', moves: [{ candidateId: b, fromRung: 'shadow', toRung: 'train' }] });
    expect(res.json.details).toMatchObject({ winner: b, scores: { [a]: 60, [b]: 90 } });
    expect(w.stageOf(b)).toBe('passed_shadow');
    expect(w.stageOf(a)).toBe('passed_premerge');
    const [t] = w.spec.listTournaments(w.specId);
    expect(t).toMatchObject({ status: 'completed', winner: b });
    expect(w.states(b)).toMatchObject([{ status: 'completed', currentRung: 'train' }]);
    const trials = w.store.raw.prepare('SELECT winner_id, decided_by, stage FROM trials').all();
    expect(trials).toEqual([{ winner_id: b, decided_by: w.agent, stage: 'decided' }]);
    expect(w.spec.listNearMisses({ candidateId: a, reason: 'trial_loss', limit: 10, offset: 0 })).toHaveLength(1);
  });

  it('the first arrival wins when its score is higher: the second arrival is eliminated (200, outcome eliminated), and the winner gets its own completed state', async () => {
    const { w, a, b } = await two(90, 60);
    await w.promote({ candidateId: a, toRung: 'train' });
    const res = await w.promote({ candidateId: b, toRung: 'train' });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ success: true, outcome: 'eliminated', moves: [{ candidateId: a, toRung: 'train' }] });
    expect(w.stageOf(a)).toBe('passed_shadow');
    expect(w.stageOf(b)).toBe('passed_premerge');
    // the loser's state ends where it started; the winner, who had finished as waiting, has a new state that moved
    expect(w.states(b)).toMatchObject([{ status: 'completed', currentRung: 'shadow' }]);
    expect(w.states(a).map((s) => [s.status, s.currentRung])).toEqual([['completed', 'train'], ['completed', 'shadow']]);
  });

  it('arrival order never decides: a score that lands after a candidate joined counts', async () => {
    const { w, a, b } = await two(null, 50);
    await w.promote({ candidateId: a, toRung: 'train' }); // joins with no score at all
    await w.samples(a, 95); // the score lands after the join
    const res = await w.promote({ candidateId: b, toRung: 'train' });
    expect(res.json.details).toMatchObject({ winner: a, scores: { [a]: 95, [b]: 50 } });
  });

  it('a score of 0 against 50: 50 wins (0 is a score, not a default of 80)', async () => {
    const { w, a, b } = await two(0, 50);
    await w.promote({ candidateId: a, toRung: 'train' });
    const res = await w.promote({ candidateId: b, toRung: 'train' });
    expect(res.json.details).toMatchObject({ winner: b });
  });

  it('no shadow scores at all (production today) is a 409 no_shadow_evidence, the tournament fails retryably, and nothing moves', async () => {
    const { w, a, b } = await two(null, null);
    await w.promote({ candidateId: a, toRung: 'train' });
    const res = await w.promote({ candidateId: b, toRung: 'train' });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ success: false, code: 'no_shadow_evidence' });
    expect(w.stageOf(a)).toBe('passed_premerge');
    expect(w.stageOf(b)).toBe('passed_premerge');
    expect(w.spec.listTournaments(w.specId)[0].status).toBe('failed');
    expect(w.states(b)).toMatchObject([{ status: 'failed' }]);
    expect(w.store.raw.prepare('SELECT COUNT(*) AS n FROM trials').get()).toEqual({ n: 0 });
  });

  it('one entrant without a score also refuses, and the retry after the score lands decides', async () => {
    const { w, a, b } = await two(80, null);
    await w.promote({ candidateId: a, toRung: 'train' });
    expect((await w.promote({ candidateId: b, toRung: 'train' })).json.code).toBe('no_shadow_evidence');
    await w.samples(b, 85);
    const retry = await w.worker.retryPromotion(b, w.agent);
    expect(retry.status).toBe(200);
    expect(w.stageOf(b)).toBe('passed_shadow');
    expect(w.spec.listTournaments(w.specId)[0]).toMatchObject({ status: 'completed', winner: b });
  });

  it('a tie for first is a 409 tie, never arrival order', async () => {
    const { w, a, b } = await two(80, 80);
    await w.promote({ candidateId: a, toRung: 'train' });
    const res = await w.promote({ candidateId: b, toRung: 'train' });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('tie');
    expect(w.stageOf(a)).toBe('passed_premerge');
  });

  it('never calls the nonexistent /compare route', async () => {
    const { w, a, b } = await two(60, 90);
    await w.promote({ candidateId: a, toRung: 'train' });
    await w.promote({ candidateId: b, toRung: 'train' });
    expect(shadowRouterFetch).not.toHaveBeenCalled();
  });

  it('without an actorId the trial is skipped and said so, and the winner still moves', async () => {
    const { w, a, b } = await two(60, 90);
    await w.promote({ candidateId: a, toRung: 'train', actorId: undefined });
    const res = await w.promote({ candidateId: b, toRung: 'train', actorId: undefined });
    expect(res.json.outcome).toBe('moved');
    expect(String(res.json.details?.trial)).toMatch(/skipped/);
    expect(w.store.raw.prepare('SELECT COUNT(*) AS n FROM trials').get()).toEqual({ n: 0 });
  });

  it("a winner the Spec DO refuses to advance fails the tournament with the DO's code (retryable), and records no winner", async () => {
    const { w, a, b } = await two(60, 90);
    await w.promote({ candidateId: a, toRung: 'train' });
    w.store.raw.prepare("UPDATE candidates SET stage = 'rolled_back' WHERE id = ?").run(b); // the winner is no longer promotable
    const res = await w.promote({ candidateId: b, toRung: 'train' });
    // b's own pre-check already refuses a rolled-back candidate before it joins
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('not_next_rung');
    // the other way round: the leader changes stage between the join and the decision
    const x = await two(95, 10);
    await x.w.promote({ candidateId: x.a, toRung: 'train' });
    x.w.box.hook = async (request) => {
      if (new URL(request.url).pathname.endsWith('/advance')) {
        x.w.store.raw.prepare("UPDATE candidates SET stage = 'failed' WHERE id = ?").run(x.a);
      }
      return undefined;
    };
    const lost = await x.w.promote({ candidateId: x.b, toRung: 'train' });
    expect(lost.status).toBe(409);
    expect(lost.json.code).toBe('not_next_rung');
    expect(x.w.spec.listTournaments(x.w.specId)[0]).toMatchObject({ status: 'failed' });
    expect(x.w.spec.listTournaments(x.w.specId)[0].winner).toBeUndefined();
    expect(x.w.states(x.b)[0].status).toBe('failed');
  });

  it('a completed tournament refuses a third candidate with 409 tournament_completed', async () => {
    const { w, a, b } = await two(60, 90);
    const c = w.candidate('passed_premerge');
    await w.samples(c, 99);
    await w.promote({ candidateId: a, toRung: 'train' });
    await w.promote({ candidateId: b, toRung: 'train' });
    const res = await w.promote({ candidateId: c, toRung: 'train' });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('tournament_completed');
  });

  it('the other moves in tournament mode are direct: train -> canary creates no second tournament', async () => {
    const { w, a, b } = await two(60, 90);
    await w.promote({ candidateId: a, toRung: 'train' });
    await w.promote({ candidateId: b, toRung: 'train' });
    const res = await w.promote({ candidateId: b, toRung: 'canary', fromRung: 'train' });
    expect(res.status).toBe(200);
    expect(res.json.outcome).toBe('moved');
    expect(w.stageOf(b)).toBe('passed_train');
    expect(w.spec.listTournaments(w.specId)).toHaveLength(1);
    // train evidence is log-only: no merged car exists in tournament mode, and that is recorded, not refused
    expect(w.events('evidence_missing').map((e) => e.reason)).toContain('train:missing');
  });
});

describe('merge-train mode: train -> canary is the train', () => {
  it('a candidate whose car merges is advanced: moved, its stage is passed_train, and the train evidence is met (nothing logged)', async () => {
    const w = await world('merge-train');
    const c = w.candidate('passed_shadow');
    gateFetch.mockResolvedValue(gateResponse('pass'));
    const res = await w.promote({ candidateId: c, toRung: 'canary', fromRung: 'train' });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ success: true, outcome: 'moved', moves: [{ candidateId: c, fromRung: 'train', toRung: 'canary' }] });
    expect(w.stageOf(c)).toBe('passed_train');
    expect(w.spec.listMergeTrains(w.specId)[0].candidates).toEqual([expect.objectContaining({ candidateId: c, status: 'merged' })]);
    expect(w.states(c)).toMatchObject([{ status: 'completed', currentRung: 'canary' }]);
    expect(w.events('evidence_missing')).toHaveLength(0);
    expect(w.events('invalid_transition')).toHaveLength(0);
  });

  it('a failing gate is a 409 gate_failed: the car fails, the stage does not move, the promotion state fails', async () => {
    const w = await world('merge-train');
    const c = w.candidate('passed_shadow');
    gateFetch.mockResolvedValue(gateResponse('fail', 'conformance'));
    const res = await w.promote({ candidateId: c, toRung: 'canary' });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ success: false, code: 'gate_failed' });
    expect(res.json.message).toMatch(/conformance/);
    expect(w.stageOf(c)).toBe('passed_shadow');
    expect(w.states(c)).toMatchObject([{ status: 'failed' }]);
  });

  it('a car queued behind another is 202 queued; the car that merged first is the one that moved, with its own promotion state', async () => {
    const w = await world('merge-train');
    const first = w.candidate('passed_shadow');
    const second = w.candidate('passed_shadow');
    gateFetch.mockResolvedValue(gateResponse('pass'));
    await getPromotionLedger(w.env).saveMergeTrain({
      id: 'mt-seed', mode: 'merge-train', specId: w.specId,
      candidates: [{ candidateId: first, specId: w.specId, position: 1, status: 'waiting' }],
      currentPosition: 1, nextMerge: first, status: 'idle',
    });
    const res = await w.promote({ candidateId: second, toRung: 'canary' });
    expect(res.status).toBe(202);
    expect(res.json).toMatchObject({ success: true, outcome: 'queued', moves: [{ candidateId: first, toRung: 'canary' }] });
    expect(w.stageOf(first)).toBe('passed_train');
    expect(w.stageOf(second)).toBe('passed_shadow');
    // the requester's attempt ends where it started; the candidate that moved has a state that says so
    expect(w.states(second)).toMatchObject([{ status: 'completed', currentRung: 'train' }]);
    expect(w.states(first)).toMatchObject([{ status: 'completed', currentRung: 'canary' }]);
  });

  it("a merged car the Spec DO refuses to advance is not a promotion: the car stays merged, the code is relayed, the state fails", async () => {
    const w = await world('merge-train');
    const c = w.candidate('passed_shadow');
    gateFetch.mockImplementation(async () => {
      // the candidate was rolled back while its gate ran
      w.store.raw.prepare("UPDATE candidates SET stage = 'rolled_back' WHERE id = ?").run(c);
      return gateResponse('pass');
    });
    const res = await w.promote({ candidateId: c, toRung: 'canary' });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('not_next_rung');
    expect(w.spec.listMergeTrains(w.specId)[0].candidates[0].status).toBe('merged');
    expect(w.stageOf(c)).toBe('rolled_back');
    expect(w.states(c)).toMatchObject([{ status: 'failed' }]);
  });

  it('shadow -> train in merge-train mode is a direct advance: no train, no tournament', async () => {
    const w = await world('merge-train');
    const c = w.candidate('passed_premerge');
    const res = await w.promote({ candidateId: c, toRung: 'train' });
    expect(res.status).toBe(200);
    expect(w.stageOf(c)).toBe('passed_shadow');
    expect(w.spec.listMergeTrains(w.specId)).toHaveLength(0);
    expect(w.spec.listTournaments(w.specId)).toHaveLength(0);
  });
});

describe('retry and queue', () => {
  it('retryPromotion omits the failed attempt\'s fromRung, so a candidate that moved on is not a stale 409', async () => {
    const w = await world('tournament');
    const c = w.candidate();
    expect((await w.promote({ candidateId: c, toRung: 'shadow', fromRung: 'pre-merge' })).status).toBe(409);
    expect(w.states(c)).toHaveLength(0);
    w.passPremerge(c);
    // a failed state exists once an attempt got past the pre-check: make one by failing the real move after a passing dry run
    let calls = 0;
    w.box.hook = async (request) => {
      if (new URL(request.url).pathname.endsWith('/advance') && calls++ === 1) return Response.json({ success: false, error: 'boom' }, { status: 500 });
      return undefined;
    };
    const failed = await w.promote({ candidateId: c, toRung: 'shadow', fromRung: 'pre-merge' });
    expect(failed.status).toBe(502);
    expect(w.states(c)[0].status).toBe('failed');
    w.box.hook = undefined;
    const retry = await w.worker.retryPromotion(c, w.agent);
    expect(retry.status).toBe(200);
    expect(w.stageOf(c)).toBe('passed_premerge');
  });

  it('a queue message goes through the same path', async () => {
    const w = await world('tournament');
    const c = w.candidate();
    w.passPremerge(c);
    await w.worker.processQueueMessage({ id: 'm1', timestamp: Date.now(), body: JSON.stringify({ candidateId: c, specId: w.specId, toRung: 'shadow' }) });
    expect(w.stageOf(c)).toBe('passed_premerge');
  });
});
