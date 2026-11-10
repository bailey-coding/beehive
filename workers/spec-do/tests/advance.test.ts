/**
 * `advance` (promotion-gaps PR B, docs/plans/promotion-gaps-plan.md sections 3.4, 11-13): the one place a candidate moves up the
 * ladder. Stage = last rung passed; the evidence checked is the evidence of the rung being left; shadow and train evidence are
 * log-only (a governance event, never a refusal); pre-merge and canary are enforced. Real SQL (node:sqlite, foreign keys on)
 * through the real router.
 *
 * Task: promotion-gaps | Spec: docs/plans/promotion-gaps-plan.md PR B
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SpecDO } from '../index';
import { makeSqliteState, makeSpecDo, type SqliteState } from './sqlite-state';
import { authedDo, TEST_DO_TOKENS } from './do-tokens';
import {
  ADVANCE_STAGE_ORDER,
  AdvanceResultSchema,
  EVIDENCE_MODE,
  decideAdvance,
  currentRungOf,
  type AdvanceToRung,
} from '../../shared/promotion-advance';
import { CANDIDATE_NOT_FOUND } from '../../shared/shadow-verdict';

let store: SqliteState;
let spec: SpecDO;
let actor: string;

async function call(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}, target: SpecDO = spec) {
  const res = await target.fetch(
    new Request(`https://spec-do.internal${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Actor-ID': actor, ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    })
  );
  return { status: res.status, json: (await res.json()) as any };
}

const sha = (n: number) => String(n).repeat(40).slice(0, 40);
const advance = (id: string, body: unknown, target: SpecDO = spec) => call(`/api/candidates/${id}/advance`, 'POST', body, {}, target);
const stageOf = (id: string) => (store.raw.prepare('SELECT stage FROM candidates WHERE id = ?').get(id) as { stage: string }).stage;
const setStage = (id: string, stage: string) => store.raw.prepare('UPDATE candidates SET stage = ? WHERE id = ?').run(stage, id);
const count = (sql: string, ...p: string[]) => (store.raw.prepare(sql).get(...p) as { n: number }).n;
const history = (id: string) => count("SELECT COUNT(*) AS n FROM entity_history WHERE entity_type = 'candidate' AND entity_id = ?", id);
const events = (name: string) => store.raw.prepare('SELECT * FROM governance_events WHERE event = ? ORDER BY created_at').all(name) as Record<string, unknown>[];
const verdict = (id: string, gate: 'pre-merge' | 'shadow', status: 'pass' | 'fail' | 'pending') =>
  spec.createGateVerdict(id, gate, status, status === 'pass' ? 90 : 10, 0, actor);

function seed(name = 'adv-org') {
  const org = spec.createOrganization(name, 'artifacts');
  const repo = spec.createRepository(`${name}-repo`, org.id, 'baseline', undefined, undefined, 'https://example.invalid/r.git', name);
  const s = spec.createSpec(`${name}-spec`, 'd', 'contract', [], org.id, actor);
  const c = spec.createCandidate(s.id, repo.id, sha(1), sha(0), actor);
  return { org, repo, spec: s, c };
}

async function deployCanary(candidateId: string, specId: string) {
  const res = await call('/canary-deployments', 'POST', {
    candidateId,
    specId,
    url: `https://${candidateId}.example.workers.dev`,
    workerVersionId: `ver-${candidateId}`,
    commitSha: sha(1),
    trafficPercentage: 10,
    holdoutPercentage: 5,
  });
  expect(res.status).toBe(201);
}
const ageCanary = (minutes: number) => store.raw.prepare('UPDATE deploy_refs SET moved_at = moved_at - ?').run(minutes * 60_000);

function specDoWithSoak(value: string): SpecDO {
  return authedDo(new SpecDO(store.state as never, { ...TEST_DO_TOKENS, CANARY_MIN_SOAK_MINUTES: value } as never));
}

beforeEach(async () => {
  store = makeSqliteState();
  spec = makeSpecDo(store);
  await spec.init();
  actor = spec.createActor('human', 'maint').id;
});

describe('decideAdvance (pure)', () => {
  const TO: AdvanceToRung[] = ['shadow', 'train', 'canary', 'full'];

  it('only the next rung is legal from each stage, and the stage written is the rung just passed', () => {
    expect(decideAdvance('pending', 'shadow')).toEqual({ kind: 'go', leaving: 'pre-merge', writes: ['passed_premerge'] });
    expect(decideAdvance('passed_premerge', 'train')).toEqual({ kind: 'go', leaving: 'shadow', writes: ['passed_shadow'] });
    expect(decideAdvance('passed_shadow', 'canary')).toEqual({ kind: 'go', leaving: 'train', writes: ['passed_train'] });
    expect(decideAdvance('passed_train', 'full')).toEqual({ kind: 'go', leaving: 'canary', writes: ['passed_canary', 'promoted'] });
    expect(decideAdvance('passed_canary', 'full')).toEqual({ kind: 'go', leaving: 'canary', writes: ['promoted'] });
  });

  it('every other (stage, toRung) pair is a no-op (already there) or refused', () => {
    const legal = new Set(['pending>shadow', 'passed_premerge>train', 'passed_shadow>canary', 'passed_train>full', 'passed_canary>full']);
    const noop = new Set(['passed_premerge>shadow', 'passed_shadow>train', 'passed_train>canary', 'promoted>full']);
    for (const stage of [...ADVANCE_STAGE_ORDER, 'failed', 'rolled_back']) {
      for (const to of TO) {
        const d = decideAdvance(stage, to);
        const key = `${stage}>${to}`;
        if (legal.has(key)) expect(d.kind, key).toBe('go');
        else if (noop.has(key)) expect(d.kind, key).toBe('noop');
        else expect(d, key).toMatchObject({ kind: 'refuse', code: 'not_next_rung' });
      }
    }
  });

  it('a replay is a no-op BEFORE the fromRung check; a mismatch on a real move is stale_from_rung', () => {
    expect(decideAdvance('promoted', 'full', 'canary')).toEqual({ kind: 'noop' });
    expect(decideAdvance('passed_premerge', 'shadow', 'pre-merge')).toEqual({ kind: 'noop' });
    expect(decideAdvance('pending', 'shadow', 'shadow')).toMatchObject({ kind: 'refuse', code: 'stale_from_rung' });
    expect(decideAdvance('pending', 'shadow', 'pre-merge').kind).toBe('go');
  });

  it('failed and rolled_back cannot move (a new commit must pass the rungs again)', () => {
    for (const stage of ['failed', 'rolled_back']) expect(decideAdvance(stage, 'shadow', 'pre-merge')).toMatchObject({ kind: 'refuse', code: 'not_next_rung' });
    expect(currentRungOf('failed')).toBeNull();
  });

  it('the evidence mode table: pre-merge and canary enforce, shadow and train log', () => {
    expect(EVIDENCE_MODE).toEqual({ 'pre-merge': 'enforce', shadow: 'log', train: 'log', canary: 'enforce' });
  });
});

describe('POST /api/candidates/:id/advance: request and lookup', () => {
  it('an unknown candidate is a coded 404, so a caller can tell it from an older Spec DO with no route', async () => {
    const res = await advance('c-nope', { toRung: 'shadow' });
    expect(res.status).toBe(404);
    expect(res.json.error).toBe(CANDIDATE_NOT_FOUND);
  });

  it('a tombstoned candidate is the same coded 404', async () => {
    const { c } = seed();
    store.raw.prepare("UPDATE actors SET role = 'maintainer' WHERE id = ?").run(actor);
    expect((await call('/internal/tombstone', 'POST', { entityType: 'candidate', id: c.id, reason: 't' })).status).toBe(200);
    const res = await advance(c.id, { toRung: 'shadow' });
    expect(res.status).toBe(404);
    expect(res.json.error).toBe(CANDIDATE_NOT_FOUND);
  });

  it.each([
    ['no toRung', {}],
    ['pre-merge as the target', { toRung: 'pre-merge' }],
    ['an unknown field (mode is not a caller choice)', { toRung: 'shadow', mode: 'log' }],
    ['a bad fromRung', { toRung: 'shadow', fromRung: 'warp' }],
    ['notes over 500 characters', { toRung: 'shadow', notes: 'n'.repeat(501) }],
    ['a non-boolean dryRun', { toRung: 'shadow', dryRun: 'yes' }],
    ['a body that is not JSON', 'not json'],
  ])('rejects %s with a 400 and writes nothing', async (_name, body) => {
    const { c } = seed();
    verdict(c.id, 'pre-merge', 'pass');
    const before = history(c.id);
    const res = await advance(c.id, body);
    expect(res.status).toBe(400);
    expect(stageOf(c.id)).toBe('pending');
    expect(history(c.id)).toBe(before);
  });

  it('a malformed percent-escape in the id is a 400', async () => {
    expect((await call('/api/candidates/%E0%A4%A/advance', 'POST', { toRung: 'shadow' })).status).toBe(400);
  });
});

describe('pending -> shadow (pre-merge evidence, enforced)', () => {
  it.each([
    ['no verdict', null, /no pre-merge gate verdict/],
    ['a failed verdict', 'fail', /pre-merge gate verdict is fail/],
    ['a pending verdict', 'pending', /still pending/],
  ])('%s refuses with 409 evidence_missing and writes nothing', async (_name, status, message) => {
    const { c } = seed();
    if (status) verdict(c.id, 'pre-merge', status as 'fail' | 'pending');
    const before = history(c.id);
    const res = await advance(c.id, { toRung: 'shadow' });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: 'evidence_missing', evidence: [{ rung: 'pre-merge', mode: 'enforce' }] });
    expect(res.json.error).toMatch(message);
    expect(res.json.evidence[0].status).toBe(status === 'fail' ? 'failed' : 'missing');
    expect(stageOf(c.id)).toBe('pending');
    expect(history(c.id)).toBe(before);
    expect(events('evidence_missing')).toHaveLength(0);
  });

  it('a passing verdict moves the candidate to passed_premerge with one history row naming the actor, and no invalid_transition', async () => {
    const { c } = seed();
    verdict(c.id, 'pre-merge', 'pass');
    const before = history(c.id);
    const res = await advance(c.id, { toRung: 'shadow', fromRung: 'pre-merge', notes: 'gate passed' }, spec);
    expect(res.status).toBe(200);
    expect(AdvanceResultSchema.safeParse(res.json.data).success).toBe(true);
    expect(res.json.data).toMatchObject({ fromRung: 'pre-merge', toRung: 'shadow', stage: 'passed_premerge', previousStage: 'pending', noop: false, dryRun: false, writes: ['passed_premerge'] });
    expect(stageOf(c.id)).toBe('passed_premerge');
    expect(history(c.id)).toBe(before + 1);
    const row = store.raw.prepare("SELECT stage, changed_by, notes FROM entity_history WHERE entity_type = 'candidate' AND entity_id = ? ORDER BY rowid DESC LIMIT 1").get(c.id);
    expect(row).toEqual({ stage: 'passed_premerge', changed_by: actor, notes: 'gate passed' });
    expect(events('invalid_transition')).toHaveLength(0);
  });
});

describe('passed_premerge -> train (shadow evidence, LOG-ONLY)', () => {
  it('missing shadow evidence is recorded as a governance event and the move still lands', async () => {
    const { c } = seed();
    setStage(c.id, 'passed_premerge');
    const res = await advance(c.id, { toRung: 'train' });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ stage: 'passed_shadow', evidence: [{ rung: 'shadow', status: 'missing', mode: 'log' }] });
    expect(stageOf(c.id)).toBe('passed_shadow');
    const [e] = events('evidence_missing');
    expect(e).toMatchObject({ subject: `candidate:${c.id}`, reason: 'shadow:missing', asserted_actor_id: actor });
    expect(JSON.parse(String(e.detail))).toMatchObject({ v: 1, candidateId: c.id, rung: 'shadow', mode: 'log', fromStage: 'passed_premerge', toRung: 'train' });
  });

  it('a failed shadow verdict is also only logged (status failed), never a refusal, until the rung is flipped to enforce', async () => {
    const { c } = seed();
    setStage(c.id, 'passed_premerge');
    verdict(c.id, 'shadow', 'fail');
    const res = await advance(c.id, { toRung: 'train' });
    expect(res.status).toBe(200);
    expect(res.json.data.evidence[0]).toMatchObject({ status: 'failed', mode: 'log' });
    expect(events('evidence_missing')[0].reason).toBe('shadow:failed');
  });

  it('a passing shadow verdict is met and writes no event', async () => {
    const { c } = seed();
    setStage(c.id, 'passed_premerge');
    verdict(c.id, 'shadow', 'pass');
    const res = await advance(c.id, { toRung: 'train' });
    expect(res.json.data.evidence[0]).toMatchObject({ status: 'met' });
    expect(events('evidence_missing')).toHaveLength(0);
  });

  it('the event is deduplicated per candidate and rung for an hour', async () => {
    const { c } = seed();
    for (let i = 0; i < 3; i++) {
      setStage(c.id, 'passed_premerge');
      expect((await advance(c.id, { toRung: 'train' })).status).toBe(200);
    }
    expect(events('evidence_missing')).toHaveLength(1);
  });
});

describe('passed_shadow -> canary (train evidence, LOG-ONLY)', () => {
  it('no merged car: logged, and the move lands', async () => {
    const { c } = seed();
    setStage(c.id, 'passed_shadow');
    const res = await advance(c.id, { toRung: 'canary' });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ stage: 'passed_train', evidence: [{ rung: 'train', status: 'missing', mode: 'log' }] });
    expect(events('evidence_missing')[0].reason).toBe('train:missing');
  });

  it('a merged car of this candidate is met; a waiting car, another candidate\'s car and an unreadable train are not', async () => {
    const { c, spec: s } = seed();
    const insert = (candidates: string) =>
      store.raw
        .prepare("INSERT INTO merge_trains (id, spec_id, status, current_position, next_merge, candidates, created_at, updated_at) VALUES (?, ?, 'idle', 0, NULL, ?, 1, 1)")
        .run(`t-${Math.random()}`, s.id, candidates);
    const car = (candidateId: string, status: string) => JSON.stringify([{ candidateId, specId: s.id, position: 0, status }]);
    const evidenceFor = async () => {
      setStage(c.id, 'passed_shadow');
      return (await advance(c.id, { toRung: 'canary', dryRun: true })).json.data.evidence[0].status;
    };
    insert('not json');
    insert(car(c.id, 'waiting'));
    insert(car('someone-else', 'merged'));
    expect(await evidenceFor()).toBe('missing');
    insert(car(c.id, 'merged'));
    expect(await evidenceFor()).toBe('met');
  });
});

describe('passed_train -> full (canary evidence, enforced; promoted only from passed_canary)', () => {
  it('a candidate that is not the live canary is refused', async () => {
    const { c, spec: s } = seed();
    setStage(c.id, 'passed_train');
    const res = await advance(c.id, { toRung: 'full' });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: 'evidence_missing', evidence: [{ rung: 'canary', mode: 'enforce', status: 'missing' }] });
    expect(res.json.evidence[0].detail).toMatch(/not the live canary/);
    await deployCanary('someone-else', s.id);
    expect((await advance(c.id, { toRung: 'full' })).status).toBe(409);
    expect(stageOf(c.id)).toBe('passed_train');
  });

  it('the live canary must have soaked: just deployed is refused with the minutes in the message, 16 minutes is accepted', async () => {
    const { c, spec: s } = seed();
    setStage(c.id, 'passed_train');
    await deployCanary(c.id, s.id);
    const early = await advance(c.id, { toRung: 'full' });
    expect(early.status).toBe(409);
    expect(early.json.error).toMatch(/live 0 of 15 minutes/);
    ageCanary(14);
    expect((await advance(c.id, { toRung: 'full' })).status).toBe(409);
    ageCanary(2);
    const ok = await advance(c.id, { toRung: 'full', fromRung: 'canary' });
    expect(ok.status).toBe(200);
    expect(ok.json.data).toMatchObject({ stage: 'promoted', previousStage: 'passed_train', writes: ['passed_canary', 'promoted'] });
    expect(stageOf(c.id)).toBe('promoted');
  });

  it('writes passed_canary then promoted as two history rows and no invalid_transition (promoted is reached only from passed_canary)', async () => {
    const { c, spec: s } = seed();
    setStage(c.id, 'passed_train');
    await deployCanary(c.id, s.id);
    ageCanary(20);
    const before = history(c.id);
    expect((await advance(c.id, { toRung: 'full' })).status).toBe(200);
    expect(history(c.id)).toBe(before + 2);
    const stages = store.raw.prepare("SELECT stage FROM entity_history WHERE entity_type = 'candidate' AND entity_id = ? ORDER BY rowid DESC LIMIT 2").all(c.id);
    expect(stages).toEqual([{ stage: 'promoted' }, { stage: 'passed_canary' }]);
    expect(events('invalid_transition')).toHaveLength(0);
  });

  it('from passed_canary only promoted is written, and the canary evidence is still required', async () => {
    const { c, spec: s } = seed();
    setStage(c.id, 'passed_canary');
    expect((await advance(c.id, { toRung: 'full' })).status).toBe(409);
    await deployCanary(c.id, s.id);
    ageCanary(20);
    const res = await advance(c.id, { toRung: 'full' });
    expect(res.json.data).toMatchObject({ stage: 'promoted', writes: ['promoted'] });
  });

  it('a canary that was superseded or rolled back is not evidence', async () => {
    const { c, spec: s } = seed();
    setStage(c.id, 'passed_train');
    await deployCanary(c.id, s.id);
    ageCanary(20);
    await deployCanary('later-candidate', s.id);
    expect((await advance(c.id, { toRung: 'full' })).status).toBe(409);
    // rolling the later one back restores this candidate as the head: live again, soaked from the rollback move
    const rb = await call('/deploy-refs/rollback', 'POST', { specId: s.id, rung: 'canary', reason: 'manual' }, { 'X-Actor-ID': 'operator' });
    expect(rb.status).toBe(200);
    const fresh = await advance(c.id, { toRung: 'full' });
    expect(fresh.status).toBe(409);
    expect(fresh.json.error).toMatch(/live 0 of 15 minutes/);
  });

  it('the soak override shortens the soak only below the default; anything else is the default', async () => {
    const { c, spec: s } = seed();
    setStage(c.id, 'passed_train');
    await deployCanary(c.id, s.id);
    const zero = specDoWithSoak('0');
    expect((await advance(c.id, { toRung: 'full', dryRun: true }, zero)).status).toBe(200);
    for (const bad of ['15', '99', '-1', 'abc', '1.5', '']) {
      expect((await advance(c.id, { toRung: 'full', dryRun: true }, specDoWithSoak(bad))).status, `override ${JSON.stringify(bad)}`).toBe(409);
    }
    expect((await advance(c.id, { toRung: 'full', dryRun: true }, specDoWithSoak('10'))).json.error).toMatch(/live 0 of 10 minutes/);
  });
});

describe('replays, order of checks, dry run, atomicity', () => {
  it('a redelivered move is a 200 no-op with no write, even when the caller still says the old fromRung and the evidence is gone', async () => {
    const { c } = seed();
    verdict(c.id, 'pre-merge', 'pass');
    expect((await advance(c.id, { toRung: 'shadow', fromRung: 'pre-merge' })).status).toBe(200);
    const before = history(c.id);
    store.raw.exec('DELETE FROM gate_verdicts');
    const again = await advance(c.id, { toRung: 'shadow', fromRung: 'pre-merge' });
    expect(again.status).toBe(200);
    expect(again.json.data).toMatchObject({ noop: true, writes: [], evidence: [], stage: 'passed_premerge' });
    expect(history(c.id)).toBe(before);
    setStage(c.id, 'promoted');
    expect((await advance(c.id, { toRung: 'full', fromRung: 'canary' })).json.data.noop).toBe(true);
  });

  it('stale_from_rung: a caller acting on old state is refused before any evidence is read', async () => {
    const { c } = seed();
    const res = await advance(c.id, { toRung: 'shadow', fromRung: 'shadow' });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('stale_from_rung');
    expect(res.json.evidence).toBeUndefined();
  });

  it.each([
    ['pending', 'train'],
    ['pending', 'canary'],
    ['pending', 'full'],
    ['passed_premerge', 'full'],
    ['passed_train', 'shadow'],
    ['promoted', 'shadow'],
    ['failed', 'shadow'],
    ['rolled_back', 'full'],
  ])('not_next_rung: %s -> %s is refused with no write', async (stage, to) => {
    const { c } = seed();
    setStage(c.id, stage);
    const before = history(c.id);
    const res = await advance(c.id, { toRung: to });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('not_next_rung');
    expect(stageOf(c.id)).toBe(stage);
    expect(history(c.id)).toBe(before);
  });

  it('a dry run decides and reports but writes nothing: no stage, no history, no governance event; an enforced refusal is still a 409', async () => {
    const { c, spec: s } = seed();
    setStage(c.id, 'passed_premerge');
    const eventsBefore = count('SELECT COUNT(*) AS n FROM governance_events');
    const historyBefore = history(c.id);
    const dry = await advance(c.id, { toRung: 'train', dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.json.data).toMatchObject({ dryRun: true, noop: false, stage: 'passed_premerge', writes: ['passed_shadow'], evidence: [{ rung: 'shadow', status: 'missing' }] });
    expect(stageOf(c.id)).toBe('passed_premerge');
    expect(history(c.id)).toBe(historyBefore);
    expect(count('SELECT COUNT(*) AS n FROM governance_events')).toBe(eventsBefore);

    setStage(c.id, 'passed_train');
    const refused = await advance(c.id, { toRung: 'full', dryRun: true });
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe('evidence_missing');
    await deployCanary(c.id, s.id);
    ageCanary(20);
    expect((await advance(c.id, { toRung: 'full', dryRun: true })).json.data).toMatchObject({ stage: 'passed_train', writes: ['passed_canary', 'promoted'] });
    expect(stageOf(c.id)).toBe('passed_train');
  });

  it('is atomic: a failing history write rolls the stage back too', async () => {
    const { c } = seed();
    verdict(c.id, 'pre-merge', 'pass');
    store.raw.exec('DROP TABLE entity_history');
    const res = await advance(c.id, { toRung: 'shadow' });
    expect(res.status).toBe(500);
    expect(stageOf(c.id)).toBe('pending');
  });

  it('climbs the whole ladder one rung at a time with evidence, ending promoted with no invalid_transition rows', async () => {
    const { c, spec: s } = seed();
    verdict(c.id, 'pre-merge', 'pass');
    expect((await advance(c.id, { toRung: 'shadow', fromRung: 'pre-merge' })).json.data.stage).toBe('passed_premerge');
    verdict(c.id, 'shadow', 'pass');
    expect((await advance(c.id, { toRung: 'train', fromRung: 'shadow' })).json.data.stage).toBe('passed_shadow');
    expect((await advance(c.id, { toRung: 'canary', fromRung: 'train' })).json.data.stage).toBe('passed_train');
    await deployCanary(c.id, s.id);
    ageCanary(20);
    expect((await advance(c.id, { toRung: 'full', fromRung: 'canary' })).json.data.stage).toBe('promoted');
    expect(events('invalid_transition')).toHaveLength(0);
    expect(events('evidence_missing').map((e) => e.reason)).toEqual(['train:missing']);
  });
});
