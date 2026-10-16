/**
 * Promotion ledger concurrency and state machine: version compare-and-swap on tournaments and
 * merge trains (X-Expected-Version), the tournament status machine, and the client's
 * read-modify-write retry. Real SQL through the real fetch router.
 *
 * Task: ledger-cas | Spec: AGENTS.md#state-management
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SpecDO } from '../index';
import { makeSqliteState, makeSpecDo } from './sqlite-state';
import {
  PromotionLedgerClient,
  VersionConflictError,
  type TournamentRecord,
  type MergeTrainRecord,
} from '../../shared/promotion-ledger';
import { MAX_TOURNAMENT_ATTEMPTS } from '../../shared/ledger-state-machine';

let spec: SpecDO;

beforeEach(async () => {
  spec = makeSpecDo(makeSqliteState());
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

const at = (version: number) => ({ 'X-Expected-Version': String(version) });
const code = async (res: Response) => ((await res.json()) as { code?: string }).code;

const metrics = {
  passRate: 1, failureRate: 0, latencyP95: 100, latencyP50: 50, errorRate: 0,
  throughput: 100, score: 80, conformanceScore: 100, complexityDelta: 0, stability: 1,
};
const candidate = (candidateId: string, status: 'competing' | 'eliminated' = 'competing') => ({
  candidateId, specId: 'spec-1', score: 80, status, metrics,
});

function tournament(overrides: Partial<TournamentRecord> = {}): TournamentRecord {
  return {
    id: 't1',
    mode: 'tournament',
    specId: 'spec-1',
    candidates: [candidate('c1'), candidate('c2')],
    comparisons: [],
    startedAt: '2026-10-16T00:00:00.000Z',
    status: 'pending',
    ...overrides,
  };
}

function train(overrides: Partial<MergeTrainRecord> = {}): MergeTrainRecord {
  return {
    id: 'm1',
    mode: 'merge-train',
    specId: 'spec-1',
    candidates: [],
    currentPosition: 0,
    nextMerge: null,
    status: 'idle',
    ...overrides,
  };
}

const read = async (path: string) => (await (await call(path)).json()) as Record<string, unknown>;

describe('version compare-and-swap', () => {
  it('a new record starts at version 1 and every write bumps it', async () => {
    expect(((await (await call('/tournament-status', 'POST', tournament())).json()) as TournamentRecord).version).toBe(1);
    await call('/tournament-status/t1', 'PATCH', { status: 'in_progress' });
    expect((await read('/tournament-status?specId=spec-1')).version).toBe(2);
    await call('/merge-train-status', 'POST', train());
    await call('/merge-train-status/m1', 'PATCH', { status: 'processing' });
    expect((await read('/merge-train-status?specId=spec-1')).version).toBe(2);
  });

  it('replacing an existing record without a version is 409 version_required', async () => {
    await call('/tournament-status', 'POST', tournament());
    const res = await call('/tournament-status', 'POST', tournament());
    expect(res.status).toBe(409);
    expect(await code(res)).toBe('version_required');
  });

  it('replacing with a stale version is 409 version_conflict and writes nothing', async () => {
    await call('/merge-train-status', 'POST', train());
    expect((await call('/merge-train-status', 'POST', train({ status: 'processing' }), at(1))).status).toBe(200);

    const stale = await call('/merge-train-status', 'POST', train({ status: 'paused' }), at(1));
    expect(stale.status).toBe(409);
    expect(await code(stale)).toBe('version_conflict');
    expect(await read('/merge-train-status?specId=spec-1')).toMatchObject({ status: 'processing', version: 2 });
  });

  it('PATCH applies without a version (server-side merge) but honours one when sent', async () => {
    await call('/merge-train-status', 'POST', train());
    expect((await call('/merge-train-status/m1', 'PATCH', { status: 'processing' })).status).toBe(200);
    const stale = await call('/merge-train-status/m1', 'PATCH', { status: 'paused' }, at(1));
    expect(stale.status).toBe(409);
    expect(await code(stale)).toBe('version_conflict');
    expect((await call('/merge-train-status/m1', 'PATCH', { status: 'paused' }, at(2))).status).toBe(200);
  });

  it('a malformed X-Expected-Version is 400', async () => {
    await call('/tournament-status', 'POST', tournament());
    for (const bad of ['abc', '0', '-1', '1.5']) {
      expect((await call('/tournament-status', 'POST', tournament(), { 'X-Expected-Version': bad })).status).toBe(400);
    }
  });

  it('a version in the request body is ignored: the DO owns it', async () => {
    const res = await call('/tournament-status', 'POST', { ...tournament(), version: 99, attempts: 5 });
    expect(await res.json()).toMatchObject({ version: 1, attempts: 0 });
  });
});

describe('tournament state machine', () => {
  const put = (patch: Record<string, unknown>) => call('/tournament-status/t1', 'PATCH', patch);
  const status = async () => (await read('/tournament-status?specId=spec-1')).status;

  beforeEach(async () => {
    await call('/tournament-status', 'POST', tournament());
  });

  it('a new tournament must start pending', async () => {
    const res = await call('/tournament-status', 'POST', tournament({ id: 't2', status: 'in_progress' }));
    expect(res.status).toBe(409);
    expect(await code(res)).toBe('invalid_transition');
  });

  it('pending -> in_progress needs two competing candidates', async () => {
    await call('/tournament-status', 'POST', tournament({ id: 't2', specId: 'spec-2', candidates: [candidate('c1')] }));
    const res = await call('/tournament-status/t2', 'PATCH', { status: 'in_progress' });
    expect(res.status).toBe(409);
    expect(await code(res)).toBe('invalid_transition');
    expect((await put({ status: 'in_progress' })).status).toBe(200);
  });

  it('pending cannot jump to completed or failed', async () => {
    expect(await code(await put({ status: 'completed', winner: 'c1', completedAt: 'x' }))).toBe('invalid_transition');
    expect(await code(await put({ status: 'failed', failureReason: 'x' }))).toBe('invalid_transition');
    expect(await status()).toBe('pending');
  });

  it('completed needs a winner who is a candidate, and completedAt', async () => {
    await put({ status: 'in_progress' });
    expect(await code(await put({ status: 'completed', completedAt: 'x' }))).toBe('invalid_transition');
    expect(await code(await put({ status: 'completed', winner: 'ghost', completedAt: 'x' }))).toBe('invalid_transition');
    expect(await code(await put({ status: 'completed', winner: 'c1' }))).toBe('invalid_transition');
    expect((await put({ status: 'completed', winner: 'c1', completedAt: 'x' })).status).toBe(200);
  });

  it('completed is terminal', async () => {
    await put({ status: 'in_progress' });
    await put({ status: 'completed', winner: 'c1', completedAt: 'x' });
    for (const next of ['pending', 'in_progress', 'failed']) {
      const res = await put({ status: next, failureReason: 'x' });
      expect(res.status).toBe(409);
      expect(await code(res)).toBe('invalid_transition');
    }
    expect(await status()).toBe('completed');
  });

  it('failed needs a reason, is stamped with failedAt, and counts an attempt', async () => {
    await put({ status: 'in_progress' });
    expect(await code(await put({ status: 'failed' }))).toBe('invalid_transition');
    const res = await put({ status: 'failed', failureReason: 'promotion 500' });
    expect(await res.json()).toMatchObject({ status: 'failed', failureReason: 'promotion 500', attempts: 1 });
    expect(((await read('/tournament-status?specId=spec-1')).failedAt as string).length).toBeGreaterThan(0);
  });

  it('writing failed again does not count another attempt', async () => {
    await put({ status: 'in_progress' });
    await put({ status: 'failed', failureReason: 'a' });
    const again = await put({ status: 'failed', failureReason: 'b' });
    expect(await again.json()).toMatchObject({ failureReason: 'b', attempts: 1 });
  });

  it('failed -> in_progress retries, and leaving failed clears the failure details', async () => {
    await put({ status: 'in_progress' });
    await put({ status: 'failed', failureReason: 'a' });
    const retry = (await (await put({ status: 'in_progress' })).json()) as TournamentRecord;
    expect(retry.status).toBe('in_progress');
    expect(retry.attempts).toBe(1);
    expect(retry.failureReason).toBeUndefined();
    expect(retry.failedAt).toBeUndefined();
  });

  it(`retries stop after ${MAX_TOURNAMENT_ATTEMPTS} failures; failed -> pending resets the path`, async () => {
    for (let i = 0; i < MAX_TOURNAMENT_ATTEMPTS; i++) {
      expect((await put({ status: 'in_progress' })).status).toBe(200);
      expect((await put({ status: 'failed', failureReason: `try ${i}` })).status).toBe(200);
    }
    const exhausted = await put({ status: 'in_progress' });
    expect(exhausted.status).toBe(409);
    expect(await code(exhausted)).toBe('retries_exhausted');

    const reset = await put({ status: 'pending' });
    expect(await reset.json()).toMatchObject({ status: 'pending', attempts: 0 });
    expect((await put({ status: 'in_progress' })).status).toBe(200);
  });
});

describe('client read-modify-write', () => {
  const client = () =>
    new PromotionLedgerClient({
      fetch: (path: string, init?: RequestInit) => spec.fetch(new Request(`https://spec-do.internal${path}`, init)),
    });

  it('re-reads and re-applies when another writer got in between', async () => {
    const ledger = client();
    await ledger.saveTournament(tournament({ candidates: [candidate('c1')] }));

    let calls = 0;
    const saved = await ledger.modifyTournament('spec-1', (current) => {
      calls++;
      if (calls === 1) {
        // a concurrent writer adds c2 after we read, before we save
        void call('/tournament-status/t1', 'PATCH', { candidates: [candidate('c1'), candidate('c2')] });
      }
      return { ...current, candidates: [...current.candidates, candidate('c3')] };
    });

    expect(calls).toBe(2);
    // neither concurrent addition was lost
    expect(saved?.candidates.map((c) => c.candidateId)).toEqual(['c1', 'c2', 'c3']);
  });

  it('surfaces the conflict once the retries run out', async () => {
    const ledger = client();
    await ledger.saveMergeTrain(train());
    await expect(
      ledger.modifyMergeTrain('spec-1', (current) => {
        void call('/merge-train-status/m1', 'PATCH', { currentPosition: current.currentPosition + 1 });
        return { ...current, status: 'processing' };
      })
    ).rejects.toBeInstanceOf(VersionConflictError);
  });

  it('returns null for a spec with no record, and leaves the record alone when mutate returns null', async () => {
    const ledger = client();
    expect(await ledger.modifyTournament('nope', (c) => c)).toBeNull();
    await ledger.saveTournament(tournament());
    const same = await ledger.modifyTournament('spec-1', () => null);
    expect(same?.version).toBe(1);
  });
});

describe('m7 -> m8 migration', () => {
  it('adds version/failure columns to an existing ledger, keeping rows, and is idempotent', async () => {
    await call('/tournament-status', 'POST', tournament());
    await call('/merge-train-status', 'POST', train());
    const columns = (table: string) =>
      (spec as unknown as { queryAll(sql: string): { name: string }[] })
        .queryAll(`PRAGMA table_info(${table})`)
        .map((c) => c.name);
    expect(columns('tournaments')).toEqual(expect.arrayContaining(['version', 'attempts', 'failed_at', 'failure_reason']));
    expect(columns('merge_trains')).toContain('version');
  });
});
