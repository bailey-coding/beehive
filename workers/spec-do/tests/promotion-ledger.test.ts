/**
 * SpecDO promotion ledger routes: /promotion-states, /tournament-status,
 * /merge-train-status, and the m3 -> m4 migration that adds their tables.
 * Real SQL (node:sqlite) through the real storage adapter and fetch router.
 *
 * Task: spine-item1-do-routes | Spec: AGENTS.md#state-management
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SpecDO } from '../index';
import { makeSqliteState, makeSpecDo, type SqliteState } from './sqlite-state';
import { RECORD_NOT_FOUND } from '../../shared/promotion-ledger';
import type { PromotionState, TournamentRecord, MergeTrainRecord } from '../../shared/promotion-ledger';

let store: SqliteState;
let spec: SpecDO;

beforeEach(async () => {
  store = makeSqliteState();
  spec = makeSpecDo(store);
  await spec.init();
});

function call(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return spec.fetch(
    new Request(`https://spec-do.internal${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
}

const metrics = {
  passRate: 1, failureRate: 0, latencyP95: 100, latencyP50: 50, errorRate: 0,
  throughput: 100, score: 80, conformanceScore: 100, complexityDelta: 0, stability: 1,
};

function promotionState(overrides: Partial<PromotionState> = {}): PromotionState {
  return {
    id: 'promo_1',
    candidateId: 'cand-1',
    specId: 'spec-1',
    currentRung: 'shadow',
    targetRung: 'train',
    status: 'pending',
    mode: 'tournament',
    startedAt: '2026-10-15T00:00:00.000Z',
    actorId: 'agent-1',
    ...overrides,
  };
}

function tournament(overrides: Partial<TournamentRecord> = {}): TournamentRecord {
  return {
    id: 'tournament_1',
    mode: 'tournament',
    specId: 'spec-1',
    candidates: [{ candidateId: 'cand-1', specId: 'spec-1', score: 80, status: 'competing', metrics }],
    comparisons: [],
    startedAt: '2026-10-15T00:00:00.000Z',
    status: 'pending',
    ...overrides,
  };
}

// Two competing candidates: what a tournament needs to leave 'pending'
const twoCandidates = [
  { candidateId: 'cand-1', specId: 'spec-1', score: 80, status: 'competing' as const, metrics },
  { candidateId: 'cand-2', specId: 'spec-1', score: 70, status: 'competing' as const, metrics },
];

function mergeTrain(overrides: Partial<MergeTrainRecord> = {}): MergeTrainRecord {
  return {
    id: 'mergetrain_1',
    mode: 'merge-train',
    specId: 'spec-1',
    candidates: [{ candidateId: 'cand-1', specId: 'spec-1', position: 1, status: 'waiting' }],
    currentPosition: 1,
    nextMerge: 'cand-1',
    status: 'processing',
    startedAt: '2026-10-15T00:00:00.000Z',
    ...overrides,
  };
}

const tableNames = (s: SqliteState) =>
  (s.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
const schemaVersion = (s: SqliteState) =>
  (s.raw.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as { value: string }).value;

describe('m3 -> m4 migration', () => {
  it('adds the ledger tables to an existing m3 ledger and keeps its rows', async () => {
    // An m3 ledger from before this change: no ledger tables, one existing org
    for (const t of ['promotion_states', 'tournaments', 'merge_trains']) store.raw.exec(`DROP TABLE ${t}`);
    store.raw.exec("UPDATE metadata SET value = 'm3' WHERE key = 'schema_version'");
    spec.createOrganization('existing-org', 'github');

    // Restart: a new SpecDO over the same storage runs runMigrations()
    const restarted = makeSqliteState(store.raw, store.kv);
    await makeSpecDo(restarted).init();

    expect(tableNames(restarted)).toEqual(expect.arrayContaining(['promotion_states', 'tournaments', 'merge_trains']));
    // m4 -> m5, m5 -> m6 (service tokens) and m6 -> m7 (deploy refs) run in the same pass
    expect(schemaVersion(restarted)).toBe('m9');
    expect(store.raw.prepare("SELECT COUNT(*) AS n FROM organizations WHERE name = 'existing-org'").get()).toEqual({ n: 1 });
  });

  it('is idempotent on an m4 ledger', async () => {
    store.raw.exec("UPDATE metadata SET value = 'm3' WHERE key = 'schema_version'");
    await makeSpecDo(makeSqliteState(store.raw, store.kv)).init();
    await makeSpecDo(makeSqliteState(store.raw, store.kv)).init();
    expect(schemaVersion(store)).toBe('m9');
  });
});

describe('/promotion-states', () => {
  it('POST creates a state and returns it (201)', async () => {
    const res = await call('/promotion-states', 'POST', promotionState());
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(promotionState());
  });

  it('POST with a duplicate id is 409 and leaves the first row', async () => {
    await call('/promotion-states', 'POST', promotionState());
    const res = await call('/promotion-states', 'POST', promotionState({ status: 'failed' }));
    expect(res.status).toBe(409);
    const list = (await (await call('/promotion-states')).json()) as PromotionState[];
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe('pending');
  });

  it('POST rejects an invalid payload (400)', async () => {
    const res = await call('/promotion-states', 'POST', { ...promotionState(), currentRung: 'nope' });
    expect(res.status).toBe(400);
    const unknownField = await call('/promotion-states', 'POST', { ...promotionState(), current_rung: 'shadow' });
    expect(unknownField.status).toBe(400);
  });

  it('GET lists all, and by candidateId newest first', async () => {
    await call('/promotion-states', 'POST', promotionState({ id: 'p1' }));
    await call('/promotion-states', 'POST', promotionState({ id: 'p2', candidateId: 'cand-2' }));
    await call('/promotion-states', 'POST', promotionState({ id: 'p3' }));

    const all = (await (await call('/promotion-states')).json()) as PromotionState[];
    expect(all.map((s) => s.id).sort()).toEqual(['p1', 'p2', 'p3']);

    const res = await call('/promotion-states?candidateId=cand-1');
    expect(res.status).toBe(200);
    expect(((await res.json()) as PromotionState[]).map((s) => s.id)).toEqual(['p3', 'p1']);

    const none = await call('/promotion-states?candidateId=unknown');
    expect(await none.json()).toEqual([]);
  });

  it('PATCH merges fields, null clears an optional field', async () => {
    await call('/promotion-states', 'POST', promotionState({ status: 'failed', failedAt: 'x', failureReason: 'boom' }));
    const res = await call('/promotion-states/promo_1', 'PATCH', {
      status: 'pending',
      failedAt: null,
      failureReason: null,
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as PromotionState;
    expect(updated.status).toBe('pending');
    expect(updated).not.toHaveProperty('failedAt');
    expect(updated).not.toHaveProperty('failureReason');
    expect(updated.candidateId).toBe('cand-1');
  });

  it('PATCH of an unknown id is a coded 404; a bad patch is 400', async () => {
    const missing = await call('/promotion-states/nope', 'PATCH', { status: 'completed' });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { code: string }).code).toBe(RECORD_NOT_FOUND);

    await call('/promotion-states', 'POST', promotionState());
    expect((await call('/promotion-states/promo_1', 'PATCH', { status: 'bogus' })).status).toBe(400);
    expect((await call('/promotion-states/promo_1', 'PATCH', { id: 'other' })).status).toBe(400);
  });

  it('runs each write in a transaction', async () => {
    const before = store.transactions.count;
    await call('/promotion-states', 'POST', promotionState());
    await call('/promotion-states/promo_1', 'PATCH', { status: 'in_progress' });
    expect(store.transactions.count - before).toBe(2);
  });

  it('unserved methods and sub-paths are an uncoded 404', async () => {
    const res = await call('/promotion-states/promo_1');
    expect(res.status).toBe(404);
    expect((await res.json()) as object).not.toHaveProperty('code');
  });
});

describe('/tournament-status', () => {
  it('GET by spec with no tournament is a coded 404', async () => {
    const res = await call('/tournament-status?specId=spec-1');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe(RECORD_NOT_FOUND);
  });

  it('GET without specId is 400', async () => {
    expect((await call('/tournament-status')).status).toBe(400);
  });

  it('POST creates (201), re-POST of the same id upserts (200)', async () => {
    const created = await call('/tournament-status', 'POST', tournament());
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ ...tournament(), version: 1, attempts: 0 });

    const next = tournament({ status: 'in_progress', candidates: twoCandidates });
    const again = await call('/tournament-status', 'POST', next, { 'X-Expected-Version': '1' });
    expect(again.status).toBe(200);

    const res = await call('/tournament-status?specId=spec-1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...next, version: 2, attempts: 0 });
  });

  it('GET by spec returns the newest tournament; /all lists every one', async () => {
    await call('/tournament-status', 'POST', tournament({ id: 't1' }));
    await call('/tournament-status', 'POST', tournament({ id: 't2' }));
    await call('/tournament-status', 'POST', tournament({ id: 't3', specId: 'spec-2', candidates: [] }));

    expect(((await (await call('/tournament-status?specId=spec-1')).json()) as TournamentRecord).id).toBe('t2');
    const all = (await (await call('/tournament-status/all')).json()) as TournamentRecord[];
    expect(all.map((t) => t.id).sort()).toEqual(['t1', 't2', 't3']);
  });

  it('PATCH merges top-level fields and returns the record', async () => {
    await call('/tournament-status', 'POST', tournament({ candidates: twoCandidates }));
    await call('/tournament-status/tournament_1', 'PATCH', { status: 'in_progress' });
    const res = await call('/tournament-status/tournament_1', 'PATCH', {
      status: 'completed',
      winner: 'cand-1',
      completedAt: '2026-10-15T01:00:00.000Z',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ...tournament({ candidates: twoCandidates, status: 'completed', winner: 'cand-1', completedAt: '2026-10-15T01:00:00.000Z' }),
      version: 3,
      attempts: 0,
    });
  });

  it('PATCH of an unknown id is a coded 404; invalid payloads are 400', async () => {
    const missing = await call('/tournament-status/nope', 'PATCH', { status: 'completed' });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { code: string }).code).toBe(RECORD_NOT_FOUND);
    expect((await call('/tournament-status', 'POST', { ...tournament(), mode: 'merge-train' })).status).toBe(400);
    expect((await call('/tournament-status', 'POST', 'not json{')).status).toBe(400);
  });

  it('runs each write in a transaction', async () => {
    const before = store.transactions.count;
    await call('/tournament-status', 'POST', tournament({ candidates: twoCandidates }));
    await call('/tournament-status/tournament_1', 'PATCH', { status: 'in_progress' });
    expect(store.transactions.count - before).toBe(2);
  });
});

describe('/merge-train-status', () => {
  it('GET by spec with no train is a coded 404', async () => {
    const res = await call('/merge-train-status?specId=spec-1');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe(RECORD_NOT_FOUND);
  });

  it('POST creates (201) and keeps nextMerge: null round-trip', async () => {
    const res = await call('/merge-train-status', 'POST', mergeTrain({ nextMerge: null, status: 'idle' }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ...mergeTrain({ nextMerge: null, status: 'idle' }), version: 1 });
  });

  it('re-POST of the same id upserts (rollback path)', async () => {
    await call('/merge-train-status', 'POST', mergeTrain());
    const rolledBack = mergeTrain({
      candidates: [{ candidateId: 'cand-1', specId: 'spec-1', position: 1, status: 'rolled_back', failureReason: 'Rolled back: x' }],
    });
    expect((await call('/merge-train-status', 'POST', rolledBack, { 'X-Expected-Version': '1' })).status).toBe(200);
    expect(await (await call('/merge-train-status?specId=spec-1')).json()).toEqual({ ...rolledBack, version: 2 });
  });

  it('GET /all lists every train', async () => {
    await call('/merge-train-status', 'POST', mergeTrain({ id: 'm1' }));
    await call('/merge-train-status', 'POST', mergeTrain({ id: 'm2', specId: 'spec-2' }));
    const all = (await (await call('/merge-train-status/all')).json()) as MergeTrainRecord[];
    expect(all.map((t) => t.id).sort()).toEqual(['m1', 'm2']);
  });

  it('PATCH merges top-level fields; unknown id is a coded 404', async () => {
    await call('/merge-train-status', 'POST', mergeTrain());
    const res = await call('/merge-train-status/mergetrain_1', 'PATCH', {
      status: 'idle',
      nextMerge: null,
      completedAt: '2026-10-15T01:00:00.000Z',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ...mergeTrain({ status: 'idle', nextMerge: null, completedAt: '2026-10-15T01:00:00.000Z' }),
      version: 2,
    });

    const missing = await call('/merge-train-status/nope', 'PATCH', { status: 'idle' });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { code: string }).code).toBe(RECORD_NOT_FOUND);
  });

  it('runs each write in a transaction', async () => {
    const before = store.transactions.count;
    await call('/merge-train-status', 'POST', mergeTrain());
    await call('/merge-train-status/mergetrain_1', 'PATCH', { status: 'paused' });
    expect(store.transactions.count - before).toBe(2);
  });
});
