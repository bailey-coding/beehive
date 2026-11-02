/**
 * Log-only transition checks in the Spec DO (PR-S): every candidate stage write and promotion-state write computes
 * the table (c)/(d) check in the write's transaction; a violation writes one invalid_transition row in
 * governance_events and the write still lands with today's response. Real SQL (node:sqlite) through the real router.
 *
 * Task: pr-s | Spec: docs/plans/pr-s-state-machine-plan.md sections 4, 5 and 8 (incl. review 1 dispositions)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SpecDO } from '../index';
import { makeSqliteState, makeSpecDo, type SqliteState } from './sqlite-state';
import {
  INVALID_TRANSITION_CAP_PER_WINDOW,
  INVALID_TRANSITION_WINDOW_MS,
  MAX_GOVERNANCE_DETAIL_BYTES,
} from '../../shared/governance-state-machine';

// Lets one test make the pure check throw, to prove the check runs inside the DO's try (review S1)
const hooks = vi.hoisted(() => ({ throwInCheck: false }));
vi.mock('../../shared/governance-state-machine', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../shared/governance-state-machine')>();
  return {
    ...mod,
    checkCandidateTransition: (...args: Parameters<typeof mod.checkCandidateTransition>) => {
      if (hooks.throwInCheck) throw new Error('injected check failure');
      return mod.checkCandidateTransition(...args);
    },
  };
});

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

const events = () => store.raw.prepare('SELECT * FROM governance_events ORDER BY rowid').all() as Record<string, any>[];
const history = (id: string) =>
  store.raw.prepare(`SELECT stage FROM entity_history WHERE entity_type = 'candidate' AND entity_id = ? ORDER BY rowid`).all(id) as { stage: string }[];
const stageOf = (id: string) => (store.raw.prepare('SELECT stage FROM candidates WHERE id = ?').get(id) as { stage: string }).stage;
const setStage = (id: string, stage: string) => store.raw.prepare('UPDATE candidates SET stage = ? WHERE id = ?').run(stage, id);
const patchStage = (id: string, stage: string, notes?: string) => call(`/api/candidates/${id}/stage`, 'PATCH', { stage, notes });

let orgName: string;
function seed(name = 'gov-org') {
  orgName = name;
  const org = spec.createOrganization(name, 'artifacts');
  const repo = spec.createRepository(`${name}-repo`, org.id, 'baseline', undefined, undefined, 'https://example.invalid/r.git', name);
  const s = spec.createSpec(`${name}-spec`, 'd', 'contract', [], org.id, actor);
  const c = spec.createCandidate(s.id, repo.id, 'a'.repeat(40), 'b'.repeat(40), actor);
  return { org, repo, spec: s, c };
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  hooks.throwInCheck = false;
  store = makeSqliteState();
  spec = makeSpecDo(store);
  await spec.init();
  actor = spec.createActor('agent', 'gov-agent').id;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('candidate stage PATCH: log-only', () => {
  it('a violation (pending -> passed_train) answers 200, writes the stage and history, and exactly one event', async () => {
    const { c, spec: s } = seed();
    const res = await patchStage(c.id, 'passed_train', 'secret client note');
    expect(res.status).toBe(200);
    expect(res.json.data.stage).toBe('passed_train');
    expect(stageOf(c.id)).toBe('passed_train');
    expect(history(c.id).map((h) => h.stage)).toEqual(['pending', 'passed_train']);

    const rows = events();
    expect(rows).toHaveLength(1);
    const [e] = rows;
    expect(e).toMatchObject({
      event: 'invalid_transition',
      actor_id: null,
      asserted_actor_id: actor,
      subject: `candidate:${c.id}`,
      reason: 'candidate_stage:pending->passed_train',
    });
    expect(e.detail).not.toContain('secret client note');
    expect(new TextEncoder().encode(e.detail).length).toBeLessThanOrEqual(MAX_GOVERNANCE_DETAIL_BYTES);
    expect(JSON.parse(e.detail)).toEqual({
      v: 1, machine: 'candidate_stage', rule: 'skip_ahead', from: 'pending', to: 'passed_train', enforceable: true,
      source: 'stage_patch', candidateId: c.id, specId: s.id, orgName,
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('the full valid ladder and a rollback write no event', async () => {
    const { c } = seed();
    for (const stage of ['passed_premerge', 'passed_shadow', 'passed_train', 'passed_canary', 'promoted', 'rolled_back']) {
      expect((await patchStage(c.id, stage)).status).toBe(200);
    }
    expect(stageOf(c.id)).toBe('rolled_back');
    expect(events()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('same-state writes write no event', async () => {
    const { c } = seed();
    await patchStage(c.id, 'passed_premerge');
    await patchStage(c.id, 'passed_premerge');
    await patchStage(c.id, 'passed_premerge');
    expect(history(c.id)).toHaveLength(4);
    expect(events()).toEqual([]);
  });

  it('runs the stage write, history and event in one transaction', async () => {
    const { c } = seed();
    const before = store.transactions.count;
    await patchStage(c.id, 'passed_train');
    expect(store.transactions.count - before).toBe(1);
    expect(events()).toHaveLength(1);
  });

  it('a throw in recordHistory now rolls back the stage UPDATE', async () => {
    const { c } = seed();
    vi.spyOn(spec as any, 'recordHistory').mockImplementation(() => { throw new Error('history down'); });
    const res = await patchStage(c.id, 'passed_premerge');
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(stageOf(c.id)).toBe('pending');
    expect(events()).toEqual([]);
  });

  it('an unknown id keeps the old behavior (history row, 404) and writes no event', async () => {
    const res = await patchStage('no-such-candidate', 'promoted');
    expect(res.status).toBe(404);
    expect(history('no-such-candidate').map((h) => h.stage)).toEqual(['promoted']);
    expect(events()).toEqual([]);
  });

  it('an unknown stage still fails the CHECK (500, no history row) and writes no event', async () => {
    const { c } = seed();
    const res = await patchStage(c.id, 'bogus');
    expect(res.status).toBe(500);
    expect(stageOf(c.id)).toBe('pending');
    expect(history(c.id)).toHaveLength(1);
    expect(events()).toEqual([]);
  });

  it('a tombstoned candidate writes no event (log only for a live row)', async () => {
    const { c } = seed();
    store.raw.prepare('UPDATE candidates SET deleted_at = ? WHERE id = ?').run(Date.now(), c.id);
    await patchStage(c.id, 'promoted');
    expect(events()).toEqual([]);
  });

  it('failed -> passed_premerge via PATCH is reset_needs_execute (no legal re-run path exists since execute was retired)', async () => {
    const { c } = seed();
    setStage(c.id, 'failed');
    await patchStage(c.id, 'passed_premerge');
    expect(events().map((e) => JSON.parse(e.detail).rule)).toEqual(['reset_needs_execute']);
  });
});

describe('flood control', () => {
  it('one row per (subject, edge) per window; a new window writes again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
    const { c } = seed();
    for (let i = 0; i < 3; i++) {
      setStage(c.id, 'pending');
      await patchStage(c.id, 'passed_train');
    }
    expect(events()).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(3);

    vi.setSystemTime(new Date(Date.now() + INVALID_TRANSITION_WINDOW_MS + 1));
    setStage(c.id, 'pending');
    await patchStage(c.id, 'passed_train');
    expect(events()).toHaveLength(2);
  });

  it(`caps the window at ${INVALID_TRANSITION_CAP_PER_WINDOW} rows; the row that reaches the cap says so`, async () => {
    const { repo, spec: s } = seed();
    const ids = Array.from({ length: INVALID_TRANSITION_CAP_PER_WINDOW + 1 }, (_, i) =>
      spec.createCandidate(s.id, repo.id, String(i).padStart(40, '0'), 'b'.repeat(40), actor).id
    );
    for (const id of ids) await patchStage(id, 'passed_shadow');
    const rows = events();
    expect(rows).toHaveLength(INVALID_TRANSITION_CAP_PER_WINDOW);
    expect(rows.filter((r) => JSON.parse(r.detail).capReached === true).map((r) => r.subject)).toEqual([
      `candidate:${ids[INVALID_TRANSITION_CAP_PER_WINDOW - 1]}`,
    ]);
    expect(warn).toHaveBeenCalledTimes(INVALID_TRANSITION_CAP_PER_WINDOW + 1);
    for (const id of ids) expect(stageOf(id)).toBe('passed_shadow');
  });
});

describe('flood control: trailing-hour window', () => {
  it('capReached repeats when the oldest row leaves the trailing hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date('2026-11-01T00:00:00Z').getTime();
    vi.setSystemTime(t0);
    const { repo, spec: s } = seed();
    const make = (i: number) => spec.createCandidate(s.id, repo.id, String(i).padStart(40, '0'), 'b'.repeat(40), actor).id;
    await patchStage(make(0), 'passed_shadow'); // the oldest row, at t0
    vi.setSystemTime(t0 + 60_000);
    for (let i = 1; i < INVALID_TRANSITION_CAP_PER_WINDOW; i++) await patchStage(make(i), 'passed_shadow');
    const capped = () => events().filter((r) => JSON.parse(r.detail).capReached === true);
    expect(events()).toHaveLength(INVALID_TRANSITION_CAP_PER_WINDOW);
    expect(capped()).toHaveLength(1);

    // Past the oldest row only: 99 rows remain in the trailing hour, so the next row reaches the cap again
    vi.setSystemTime(t0 + INVALID_TRANSITION_WINDOW_MS + 1);
    const late = make(1000);
    await patchStage(late, 'passed_shadow');
    expect(capped().map((r) => r.subject)).toEqual([
      events()[INVALID_TRANSITION_CAP_PER_WINDOW - 1].subject,
      `candidate:${late}`,
    ]);
  });
});

describe('subject and rollback edges', () => {
  it('a PATCH pending -> rolled_back answers 200 and writes one non-enforceable rollback_before_train row', async () => {
    const { c } = seed();
    const res = await patchStage(c.id, 'rolled_back');
    expect(res.status).toBe(200);
    expect(stageOf(c.id)).toBe('rolled_back');
    const rows = events();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].detail)).toMatchObject({ rule: 'rollback_before_train', enforceable: false, from: 'pending', to: 'rolled_back' });
  });

  it('truncates subject to 256 characters', async () => {
    const id = 'p'.repeat(400);
    const res = await call('/promotion-states', 'POST', {
      id, candidateId: 'cand-1', specId: 'spec-1', currentRung: 'shadow', targetRung: 'train',
      status: 'failed', mode: 'tournament', startedAt: '2026-11-01T00:00:00.000Z',
    });
    expect(res.status).toBe(201);
    const [e] = events();
    expect(e.subject).toHaveLength(256);
    expect(e.subject).toBe(`promotion_state:${id}`.slice(0, 256));
  });
});

describe('failure isolation', () => {
  it('a failing event INSERT (trigger RAISE(ABORT)) leaves the PATCH at 200 with stage and history committed', async () => {
    const { c } = seed();
    store.raw.exec(`CREATE TRIGGER gov_fail BEFORE INSERT ON governance_events BEGIN SELECT RAISE(ABORT, 'x'); END`);
    const res = await patchStage(c.id, 'passed_train');
    expect(res.status).toBe(200);
    expect(stageOf(c.id)).toBe('passed_train');
    expect(history(c.id).map((h) => h.stage)).toEqual(['pending', 'passed_train']);
    expect(events()).toEqual([]);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('a throwing check leaves the PATCH at 200 with stage and history written', async () => {
    const { c } = seed();
    hooks.throwInCheck = true;
    const res = await patchStage(c.id, 'passed_train');
    expect(res.status).toBe(200);
    expect(stageOf(c.id)).toBe('passed_train');
    expect(history(c.id).map((h) => h.stage)).toEqual(['pending', 'passed_train']);
    expect(events()).toEqual([]);
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe('promotion-state status: log-only', () => {
  const state = (overrides: Record<string, unknown> = {}) => ({
    id: 'promo_1', candidateId: 'cand-1', specId: 'spec-1', currentRung: 'shadow', targetRung: 'train',
    status: 'pending', mode: 'tournament', startedAt: '2026-11-01T00:00:00.000Z', actorId: 'promotion-agent', ...overrides,
  });

  it('the worker flows (run, retry, cancel) write no event', async () => {
    expect((await call('/promotion-states', 'POST', state())).status).toBe(201);
    for (const status of ['in_progress', 'failed', 'pending', 'in_progress', 'completed']) {
      expect((await call('/promotion-states/promo_1', 'PATCH', { status })).status).toBe(200);
    }
    await call('/promotion-states', 'POST', state({ id: 'promo_2' }));
    await call('/promotion-states/promo_2', 'PATCH', { status: 'cancelled' });
    expect(events()).toEqual([]);
  });

  it('a create that does not start pending is 201 and one initial_not_pending event (asserted actor from the header)', async () => {
    const res = await call('/promotion-states', 'POST', state({ status: 'failed' }), { 'X-Actor-ID': 'promotion-worker' });
    expect(res.status).toBe(201);
    const [e] = events();
    expect(events()).toHaveLength(1);
    expect(e).toMatchObject({ subject: 'promotion_state:promo_1', asserted_actor_id: 'promotion-worker', reason: 'promotion_state:none->failed' });
    expect(JSON.parse(e.detail)).toMatchObject({ rule: 'initial_not_pending', from: null, enforceable: false, orgName: null });
  });

  it('completed -> in_progress is 200 and one terminal event (asserted actor = the row actor)', async () => {
    await call('/promotion-states', 'POST', state());
    await call('/promotion-states/promo_1', 'PATCH', { status: 'in_progress' });
    await call('/promotion-states/promo_1', 'PATCH', { status: 'completed' });
    const res = await call('/promotion-states/promo_1', 'PATCH', { status: 'in_progress' });
    expect(res.status).toBe(200);
    expect((await res.json).status).toBe('in_progress');
    const [e] = events();
    expect(events()).toHaveLength(1);
    expect(e).toMatchObject({ asserted_actor_id: 'promotion-agent', reason: 'promotion_state:completed->in_progress' });
    expect(JSON.parse(e.detail)).toMatchObject({ rule: 'terminal', enforceable: true });
  });

  it('a PATCH of non-status fields, a PATCH on an unknown id and a duplicate create write no event', async () => {
    await call('/promotion-states', 'POST', state());
    expect((await call('/promotion-states/promo_1', 'PATCH', { targetRung: 'canary' })).status).toBe(200);
    expect((await call('/promotion-states/nope', 'PATCH', { status: 'completed' })).status).toBe(404);
    expect((await call('/promotion-states', 'POST', state({ status: 'failed' }))).status).toBe(409);
    expect(events()).toEqual([]);
  });
});
