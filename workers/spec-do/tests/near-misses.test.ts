/**
 * Near-miss records (PR-B, docs/M5A-2-GOVERNANCE-PLAN.md "Near-miss hooks"): each loss is written in the same transaction as the
 * write that records it, a redelivery cannot duplicate it, the read route filters it, and a purge removes it (orphans included).
 * Real SQL (node:sqlite, FKs on) through the real router.
 *
 * Task: m5a2-prb | Spec: docs/decisions/0005-org-memory.md, docs/M5A-2-GOVERNANCE-PLAN.md PR-B
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SpecDO } from '../index';
import { makeSqliteState, makeSpecDo, type SqliteState } from './sqlite-state';
import { NEAR_MISS_REASONS, NearMissReasonSchema, type NearMiss } from '../../shared/near-miss';

let store: SqliteState;
let spec: SpecDO;
let actor: string;

async function call(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  const res = await spec.fetch(
    new Request(`https://spec-do.internal${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Actor-ID': actor, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
  return { status: res.status, json: (await res.json()) as any };
}

const rows = () => store.raw.prepare('SELECT * FROM near_misses ORDER BY rowid').all() as Record<string, unknown>[];
const sha = (n: number) => String(n).repeat(40).slice(0, 40);

function seed(name = 'nm-org') {
  const org = spec.createOrganization(name, 'artifacts');
  const repo = spec.createRepository(`${name}-repo`, org.id, 'baseline', undefined, undefined, 'https://example.invalid/r.git', name);
  const s = spec.createSpec(`${name}-spec`, 'd', 'contract', [], org.id, actor);
  const c1 = spec.createCandidate(s.id, repo.id, sha(1), sha(0), actor);
  const c2 = spec.createCandidate(s.id, repo.id, sha(2), sha(0), actor);
  return { org, repo, spec: s, c1, c2 };
}

beforeEach(async () => {
  store = makeSqliteState();
  spec = makeSpecDo(store);
  await spec.init();
  actor = spec.createActor('human', 'maint').id;
});

describe('evidence', () => {
  it('evidence over 8192 UTF-8 bytes is replaced by a marker; a malformed stored value does not break the list', async () => {
    const { spec: s, c1, c2 } = seed('ev-org');
    const trial = spec.createTrial(s.id, c1.id, c2.id, actor);
    // 3000 three-byte characters: under 8192 characters, over 8192 bytes
    await call(`/api/trials/${trial.id}/decide`, 'POST', { winnerId: c1.id, comparisonMetrics: { note: '\u20ac'.repeat(3000) } });
    expect(JSON.parse(rows()[0].evidence as string)).toMatchObject({ truncated: true });
    store.raw.exec("UPDATE near_misses SET evidence = '{not json'");
    const list = await call('/api/near-misses');
    expect(list.status).toBe(200);
    expect(list.json.data[0].evidence).toEqual({ unparsed: '{not json' });
  });
});

describe('NEAR_MISS_REASONS', () => {
  it('is the closed set the writer accepts (the column is free text)', () => {
    expect([...NEAR_MISS_REASONS].sort()).toEqual(['gate_fail', 'slo_rollback', 'tournament_loss', 'train_drop', 'trial_loss']);
    expect(() => NearMissReasonSchema.parse('trial_lost')).toThrow();
  });
});

describe('trial decided: the loser is a trial_loss near-miss', () => {
  it('records the loser with the winner, the trial and the metrics as evidence', async () => {
    const { spec: s, c1, c2 } = seed();
    const trial = spec.createTrial(s.id, c1.id, c2.id, actor);
    const res = await call(`/api/trials/${trial.id}/decide`, 'POST', { winnerId: c1.id, comparisonMetrics: { latency: 12 } });
    expect(res.status).toBe(200);
    const [nm] = rows();
    expect(nm).toMatchObject({ spec_id: s.id, candidate_id: c2.id, reason: 'trial_loss', lost_to_candidate_id: c1.id, trial_id: trial.id, source_ref: trial.id });
    expect(JSON.parse(nm.evidence as string)).toEqual({ comparisonMetrics: { latency: 12 } });
    expect(rows()).toHaveLength(1);
  });

  it('refuses a second decide with 409 and leaves one near-miss and the first winner', async () => {
    const { spec: s, c1, c2 } = seed();
    const trial = spec.createTrial(s.id, c1.id, c2.id, actor);
    await call(`/api/trials/${trial.id}/decide`, 'POST', { winnerId: c1.id, comparisonMetrics: {} });
    const again = await call(`/api/trials/${trial.id}/decide`, 'POST', { winnerId: c2.id, comparisonMetrics: {} });
    expect(again.status).toBe(409);
    expect(rows()).toHaveLength(1);
    expect(spec.getTrial(trial.id)?.winner_id).toBe(c1.id);
  });

  it('refuses a winner that is not one of the two candidates (400), and an unknown trial (404), writing nothing', async () => {
    const { spec: s, c1, c2 } = seed();
    const trial = spec.createTrial(s.id, c1.id, c2.id, actor);
    expect((await call(`/api/trials/${trial.id}/decide`, 'POST', { winnerId: 'someone-else', comparisonMetrics: {} })).status).toBe(400);
    expect((await call('/api/trials/nope/decide', 'POST', { winnerId: c1.id, comparisonMetrics: {} })).status).toBe(404);
    expect(rows()).toHaveLength(0);
    expect(spec.getTrial(trial.id)?.stage).toBe('pending');
  });

  it('is atomic: if the near-miss write fails, the trial stays undecided', async () => {
    const { spec: s, c1, c2 } = seed();
    const trial = spec.createTrial(s.id, c1.id, c2.id, actor);
    vi.spyOn(spec as unknown as { recordNearMiss: () => void }, 'recordNearMiss').mockImplementation(() => { throw new Error('boom'); });
    const res = await call(`/api/trials/${trial.id}/decide`, 'POST', { winnerId: c1.id, comparisonMetrics: {} });
    expect(res.status).toBe(500);
    expect(spec.getTrial(trial.id)?.stage).toBe('pending');
    expect(store.raw.prepare("SELECT COUNT(*) AS n FROM entity_history WHERE entity_type = 'trial' AND stage = 'decided'").get()).toEqual({ n: 0 });
    vi.restoreAllMocks();
  });
});

describe('tournament: newly eliminated or disqualified candidates are tournament_loss near-misses', () => {
  const metrics = { passRate: 1, failureRate: 0, latencyP95: 1, latencyP50: 1, errorRate: 0, throughput: 1, score: 1, conformanceScore: 1, complexityDelta: 0.25, stability: 1 };
  const cand = (candidateId: string, status: string) => ({ candidateId, specId: 'spec-1', score: 50, status, metrics });
  const tournament = (candidates: unknown[], extra: object = {}) => ({
    id: 't1', mode: 'tournament', specId: 'spec-1', candidates, comparisons: [], startedAt: '2026-11-01T00:00:00.000Z', status: 'pending', ...extra,
  });

  it('writes one row per newly eliminated candidate, with the winner and complexity delta, and none on a repeated PATCH', async () => {
    expect((await call('/tournament-status', 'POST', tournament([cand('a', 'competing'), cand('b', 'competing'), cand('c', 'competing')]))).status).toBeLessThan(300);
    expect(rows()).toHaveLength(0);
    expect((await call('/tournament-status/t1', 'PATCH', { status: 'in_progress' })).status).toBe(200);
    expect(rows()).toHaveLength(0);
    expect((await call('/tournament-status/t1', 'PATCH', { candidates: [cand('a', 'winner'), cand('b', 'eliminated'), cand('c', 'disqualified')], winner: 'a' })).status).toBe(200);
    expect(rows().map((r) => [r.candidate_id, r.reason, r.source_ref, r.lost_to_candidate_id, r.complexity_delta])).toEqual([
      ['b', 'tournament_loss', 't1', 'a', 0.25],
      ['c', 'tournament_loss', 't1', 'a', 0.25],
    ]);
    await call('/tournament-status/t1', 'PATCH', { candidates: [cand('a', 'winner'), cand('b', 'eliminated'), cand('c', 'disqualified')] });
    expect(rows()).toHaveLength(2);
    // eliminated -> disqualified is a new status for the same loss: it reaches the unique key, is ignored, and the PATCH succeeds
    const flip = await call('/tournament-status/t1', 'PATCH', { candidates: [cand('a', 'winner'), cand('b', 'disqualified'), cand('c', 'disqualified')] });
    expect(flip.status).toBe(200);
    expect(rows()).toHaveLength(2);
  });

  it('is atomic: if the near-miss write fails, the tournament write is rolled back', async () => {
    await call('/tournament-status', 'POST', tournament([cand('a', 'competing'), cand('b', 'competing')]));
    await call('/tournament-status/t1', 'PATCH', { status: 'in_progress' });
    const version = () => (store.raw.prepare("SELECT version FROM tournaments WHERE id = 't1'").get() as { version: number }).version;
    const v = version();
    vi.spyOn(spec as unknown as { recordNearMiss: () => void }, 'recordNearMiss').mockImplementation(() => { throw new Error('boom'); });
    const res = await call('/tournament-status/t1', 'PATCH', { candidates: [cand('a', 'winner'), cand('b', 'eliminated')] });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(version()).toBe(v);
    vi.restoreAllMocks();
  });
});

describe('merge train: a car that fails, is rolled back or is removed is a train_drop near-miss', () => {
  const car = (candidateId: string, position: number, status = 'waiting', extra: object = {}) => ({ candidateId, specId: 'spec-1', position, status, ...extra });
  const train = (candidates: unknown[]) => ({ id: 'm1', mode: 'merge-train', specId: 'spec-1', candidates, currentPosition: 0, nextMerge: null, status: 'processing' });

  it('records failed and removed (still waiting) cars once each, per car', async () => {
    await call('/merge-train-status', 'POST', train([car('a', 0), car('b', 1), car('c', 2)]));
    await call('/merge-train-status/m1', 'PATCH', { candidates: [car('a', 0, 'merged'), car('b', 1, 'failed', { failureReason: 'conformance' })] });
    expect(rows().map((r) => [r.candidate_id, r.reason, r.source_ref, JSON.parse(r.evidence as string).status])).toEqual([
      ['b', 'train_drop', 'm1#1', 'failed'],
      ['c', 'train_drop', 'm1#2', 'removed'],
    ]);
    await call('/merge-train-status/m1', 'PATCH', { candidates: [car('a', 0, 'merged'), car('b', 1, 'failed', { failureReason: 'conformance' })] });
    expect(rows()).toHaveLength(2);
  });

  it('a re-added car that fails again is a second fact (the promotion worker re-adds a candidate as a new car)', async () => {
    await call('/merge-train-status', 'POST', train([car('b', 0, 'failed')]));
    expect(rows()).toHaveLength(1); // a car created already failed counts, like a tournament POST
    await call('/merge-train-status/m1', 'PATCH', { candidates: [car('b', 0, 'failed'), car('b', 1, 'waiting')] });
    await call('/merge-train-status/m1', 'PATCH', { candidates: [car('b', 0, 'failed'), car('b', 1, 'failed')] });
    expect(rows().map((r) => r.source_ref)).toEqual(['m1#0', 'm1#1']);
  });

  it('removing a merged car is not a loss', async () => {
    await call('/merge-train-status', 'POST', train([car('a', 0, 'merged'), car('b', 1, 'merging')]));
    await call('/merge-train-status/m1', 'PATCH', { candidates: [car('b', 1, 'merging')] });
    expect(rows()).toHaveLength(0);
  });

  it('a failed car later reported rolled_back reaches the unique key and is ignored, not a 500 (INSERT OR IGNORE)', async () => {
    await call('/merge-train-status', 'POST', train([car('a', 0)]));
    await call('/merge-train-status/m1', 'PATCH', { candidates: [car('a', 0, 'failed')] });
    // same car reported failed again under a different status path: rolled_back after failed hits the same (candidate, reason, source_ref)
    const res = await call('/merge-train-status/m1', 'PATCH', { candidates: [car('a', 0, 'rolled_back')] });
    expect(res.status).toBe(200);
    expect(rows()).toHaveLength(1);
  });

  it('files the near-miss under the candidate\'s real spec when the candidate exists', async () => {
    const x = seed('train-spec');
    await call('/merge-train-status', 'POST', train([{ ...car(x.c1.id, 0), specId: 'spec-1' }]));
    await call('/merge-train-status/m1', 'PATCH', { candidates: [{ ...car(x.c1.id, 0, 'failed'), specId: 'spec-1' }] });
    expect(rows()[0].spec_id).toBe(x.spec.id);
  });
});

describe('deploy ref rollback: the candidate that was live is an slo_rollback near-miss', () => {
  it('records the rolled-back candidate with the reason as evidence', async () => {
    const body = (c: string) => ({ candidateId: c, specId: 'spec-a', url: `https://${c}.example.workers.dev`, workerVersionId: `ver-${c}`, commitSha: `sha-${c}`, trafficPercentage: 10, holdoutPercentage: 5 });
    expect((await call('/canary-deployments', 'POST', body('cand-a'), { 'X-Actor-ID': 'canary-worker' })).status).toBe(201);
    expect((await call('/canary-deployments', 'POST', body('cand-b'), { 'X-Actor-ID': 'canary-worker' })).status).toBe(201);
    const rb = await call('/deploy-refs/rollback', 'POST', { specId: 'spec-a', rung: 'canary', reason: 'latency_p95' }, { 'X-Actor-ID': 'operator' });
    expect(rb.status).toBe(200);
    const [nm] = rows();
    expect(nm).toMatchObject({ spec_id: 'spec-a', candidate_id: 'cand-b', reason: 'slo_rollback', rung: 'canary' });
    expect(JSON.parse(nm.evidence as string)).toMatchObject({ reason: 'latency_p95', rolledBackBy: 'operator', workerVersionId: 'ver-cand-b' });
  });
});

describe('gate run failed: a gate_fail near-miss per failed run', () => {
  const finishBody = (status: 'pass' | 'fail') => ({
    status, exitCode: status === 'pass' ? 0 : 1, ...(status === 'fail' ? { failureClass: 'tests_failed' } : {}),
    checks: { tests: 'verified', conformance: 'not_run', complexity: 'not_run' },
    timings: { install: { ms: 1, exit: 0, timedOut: false }, test: { ms: 1, exit: status === 'pass' ? 0 : 1, timedOut: false }, totalMs: 2 },
    counts: { passed: 1, failed: status === 'pass' ? 0 : 1 }, logTail: 'x\n', logSha256: 'a'.repeat(64), instance: 'standard-2',
  });
  const run = async (candidateId: string, commitSha: string, status: 'pass' | 'fail') => {
    const s = await call('/api/gate-runs', 'POST', { candidateId, gate: 'pre-merge', commitSha, decidedBy: actor });
    expect(s.status).toBe(200);
    expect((await call(`/api/gate-runs/${s.json.data.runId}/result`, 'POST', finishBody(status))).status).toBe(200);
    return s.json.data.runId as string;
  };

  it('a failed run records gate_fail with the run as source; a pass records nothing; a later pass keeps the earlier fact', async () => {
    const { spec: s, c1 } = seed('gate-org');
    const failed = await run(c1.id, sha(3), 'fail');
    expect(rows().map((r) => [r.candidate_id, r.reason, r.source_ref, r.rung, r.spec_id])).toEqual([[c1.id, 'gate_fail', failed, 'pre-merge', s.id]]);
    await run(c1.id, sha(4), 'pass');
    expect(rows()).toHaveLength(1);
    // error and not_run are not losses: a run finished with error, and a run started already terminal (error)
    const e = await call('/api/gate-runs', 'POST', { candidateId: c1.id, gate: 'pre-merge', commitSha: sha(5), decidedBy: actor });
    expect((await call(`/api/gate-runs/${e.json.data.runId}/result`, 'POST', { ...finishBody('pass'), status: 'error', failureClass: 'sandbox_unavailable', exitCode: null, counts: null })).status).toBe(200);
    expect((await call('/api/gate-runs', 'POST', { candidateId: c1.id, gate: 'pre-merge', commitSha: sha(6), decidedBy: actor, terminal: { status: 'error', failureClass: 'busy_timeout' } })).status).toBe(200);
    expect(rows()).toHaveLength(1);
    expect(JSON.parse(rows()[0].evidence as string)).toMatchObject({ attempt: 1, commitSha: sha(3), failureClass: 'tests_failed' });
  });
});

describe('GET /api/near-misses', () => {
  it('filters by spec, candidate and reason, newest first, with parsed evidence; rejects a bad query', async () => {
    const a = seed('read-a');
    const b = seed('read-b');
    for (const x of [a, b]) {
      const t = spec.createTrial(x.spec.id, x.c1.id, x.c2.id, actor);
      await call(`/api/trials/${t.id}/decide`, 'POST', { winnerId: x.c1.id, comparisonMetrics: { k: x.org.name } });
    }
    const all = (await call('/api/near-misses')).json.data as NearMiss[];
    expect(all).toHaveLength(2);
    const bySpec = (await call(`/api/near-misses?specId=${a.spec.id}`)).json.data as NearMiss[];
    expect(bySpec).toHaveLength(1);
    expect(bySpec[0]).toMatchObject({ candidateId: a.c2.id, reason: 'trial_loss', evidence: { comparisonMetrics: { k: 'read-a' } } });
    expect(((await call(`/api/near-misses?candidateId=${b.c2.id}&reason=trial_loss`)).json.data as NearMiss[]).map((n) => n.specId)).toEqual([b.spec.id]);
    expect(((await call('/api/near-misses?reason=gate_fail')).json.data as NearMiss[])).toHaveLength(0);
    expect((await call('/api/near-misses?reason=typo')).status).toBe(400);
    expect((await call('/api/near-misses?limit=0')).status).toBe(400);
    expect((await call('/api/near-misses?unknown=1')).status).toBe(400);
    expect(((await call('/api/near-misses?limit=1')).json.data as NearMiss[])).toHaveLength(1);
  });
});

describe('purge', () => {
  it('an organization purge deletes its near-misses, and sweeps orphans an older build left', async () => {
    const x = seed('purge-org');
    const t = spec.createTrial(x.spec.id, x.c1.id, x.c2.id, actor);
    await call(`/api/trials/${t.id}/decide`, 'POST', { winnerId: x.c1.id, comparisonMetrics: {} });
    // an orphan: a row whose candidate a pre-m14 purge already deleted
    store.raw.prepare("INSERT INTO near_misses (id, spec_id, candidate_id, reason, source_ref, created_at) VALUES ('orphan', 's-gone', 'c-gone', 'trial_loss', 't-gone', 1)").run();
    expect(rows()).toHaveLength(2);
    // tombstone then purge through the router, as an operator would (docs/OPS.md "Ledger cleanup")
    store.raw.prepare("UPDATE actors SET role = 'maintainer' WHERE id = ?").run(actor);
    expect((await call('/internal/tombstone', 'POST', { entityType: 'organization', id: x.org.id, reason: 'test' })).status).toBe(200);
    for (const t of ['organizations', 'repositories', 'specs', 'candidates', 'issues']) {
      store.raw.prepare(`UPDATE ${t} SET deleted_at = ? WHERE deleted_at IS NOT NULL`).run(Date.now() - 25 * 3_600_000);
    }
    const dry = await call('/internal/purge', 'POST', { orgNamePrefix: 'purge-' });
    expect(dry.status).toBe(200);
    expect(dry.json.data.counts.near_misses).toBe(2); // the org's row and the orphan
    const purge = await call('/internal/purge', 'POST', { orgNamePrefix: 'purge-', dryRun: false, confirm: dry.json.data.total });
    expect(purge.status).toBe(200);
    expect(rows()).toHaveLength(0);
  });
});
