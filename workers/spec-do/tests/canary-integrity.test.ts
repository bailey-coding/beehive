/**
 * deployCanary integrity (wave-2a-plan part B): a canary needs a live candidate filed under the named spec, and a commit that is the
 * candidate's when both are known. A candidate below passed_train is accepted and logged (maintainer decision M1); a canary head running another
 * commit is logged on a real advance, never on a dry run (evidence unchanged in 2a). Real SQL (node:sqlite) through the real router.
 *
 * Task: wave-2a part B | Spec: docs/plans/wave-2a-plan.md part B; review a-S4, b1-S8
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SpecDO } from '../index';
import { makeSqliteState, makeSpecDo, type SqliteState } from './sqlite-state';
import { seedLedgerCandidate } from './ledger-seed';

let store: SqliteState;
let spec: SpecDO;

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

async function call(path: string, method = 'GET', body?: unknown) {
  const res = await spec.fetch(
    new Request(`https://spec-do.internal${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Actor-ID': 'canary-worker' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
  return { status: res.status, json: (await res.json()) as any };
}

const canary = (candidateId: string, specId: string, extra: Record<string, unknown> = {}) =>
  call('/canary-deployments', 'POST', {
    candidateId, specId, url: `https://${candidateId}.example.workers.dev`, workerVersionId: 'v', trafficPercentage: 10, holdoutPercentage: 0, ...extra,
  });
const count = (sql: string, ...p: unknown[]) => (store.raw.prepare(sql).get(...(p as never[])) as { n: number }).n;
const refs = () => count('SELECT COUNT(*) AS n FROM deploy_refs');
const events = (event: string) => store.raw.prepare('SELECT * FROM governance_events WHERE event = ?').all(event) as Record<string, any>[];

beforeEach(async () => {
  store = makeSqliteState();
  spec = makeSpecDo(store);
  await spec.init();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('deployCanary: the candidate must be live and under the named spec', () => {
  it.fails('refuses a candidate id with no ledger row: coded 404, no deploy ref, no canary', async () => {
    seedLedgerCandidate(store.raw, 'real', 'spec-a');
    const r = await canary('ghost', 'spec-a');
    expect(r.status).toBe(404);
    expect(r.json.code).toBe('candidate_not_found');
    expect(refs()).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM canary_deployments')).toBe(0);
  });

  it.fails('refuses a spec id with no ledger row: coded 404', async () => {
    seedLedgerCandidate(store.raw, 'cand', 'spec-a');
    const r = await canary('cand', 'ghost-spec');
    expect(r.status).toBe(404);
    expect(r.json.code).toBe('spec_not_found');
    expect(refs()).toBe(0);
  });

  it.fails('refuses a candidate filed under another spec: 409 spec_mismatch, no deploy ref', async () => {
    seedLedgerCandidate(store.raw, 'cand', 'spec-a');
    seedLedgerCandidate(store.raw, 'other', 'spec-b');
    const r = await canary('cand', 'spec-b');
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('spec_mismatch');
    expect(refs()).toBe(0);
  });

  it('refuses a tombstoned candidate (as today) and a tombstoned spec', async () => {
    seedLedgerCandidate(store.raw, 'cand', 'spec-a');
    store.raw.prepare('UPDATE candidates SET deleted_at = 1 WHERE id = ?').run('cand');
    expect((await canary('cand', 'spec-a')).status).toBe(404);
    seedLedgerCandidate(store.raw, 'cand2', 'spec-b');
    store.raw.prepare('UPDATE specs SET deleted_at = 1 WHERE id = ?').run('spec-b');
    expect((await canary('cand2', 'spec-b')).status).toBe(404);
    expect(refs()).toBe(0);
  });

  it.fails('refuses a commit that is not the candidate\'s: 409 commit_mismatch', async () => {
    seedLedgerCandidate(store.raw, 'cand', 'spec-a', { commitSha: SHA_A });
    const r = await canary('cand', 'spec-a', { commitSha: SHA_B });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('commit_mismatch');
    expect(refs()).toBe(0);
  });

  it('accepts the candidate\'s own commit, no commit, and any commit when the candidate has none (claimed candidates)', async () => {
    seedLedgerCandidate(store.raw, 'c1', 'spec-a', { commitSha: SHA_A });
    expect((await canary('c1', 'spec-a', { commitSha: SHA_A })).status).toBe(201);
    seedLedgerCandidate(store.raw, 'c2', 'spec-b', { commitSha: SHA_A });
    expect((await canary('c2', 'spec-b')).status).toBe(201);
    seedLedgerCandidate(store.raw, 'c3', 'spec-c');
    expect((await canary('c3', 'spec-c', { commitSha: SHA_B })).status).toBe(201);
  });
});

describe('deployCanary: stage precondition is logged, not enforced (maintainer decision M1)', () => {
  it.fails('a pending candidate is deployed and one canary_stage_precondition row is written', async () => {
    seedLedgerCandidate(store.raw, 'cand', 'spec-a');
    expect((await canary('cand', 'spec-a')).status).toBe(201);
    const rows = events('canary_stage_precondition');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].detail)).toMatchObject({ candidateId: 'cand', specId: 'spec-a', stage: 'pending' });
  });

  it('a passed_train candidate writes no row', async () => {
    seedLedgerCandidate(store.raw, 'cand', 'spec-a', { stage: 'passed_train' });
    expect((await canary('cand', 'spec-a')).status).toBe(201);
    expect(events('canary_stage_precondition')).toEqual([]);
  });
});

describe('canary evidence and the commit (log-only in 2a)', () => {
  // The candidate moved to another commit after its canary was deployed (no route writes commit_sha yet, so the test sets it directly)
  const setup = async () => {
    seedLedgerCandidate(store.raw, 'cand', 'spec-a', { commitSha: SHA_A, stage: 'passed_train' });
    expect((await canary('cand', 'spec-a', { commitSha: SHA_A })).status).toBe(201);
    store.raw.prepare('UPDATE deploy_refs SET moved_at = moved_at - 3600000').run();
    store.raw.prepare('UPDATE candidates SET commit_sha = ? WHERE id = ?').run(SHA_B, 'cand');
  };

  it.fails('a real advance(full) logs one commit_mismatch row and still moves (evidence unchanged in 2a)', async () => {
    await setup();
    const r = await call('/api/candidates/cand/advance', 'POST', { toRung: 'full' });
    expect(r.status).toBe(200);
    expect(r.json.data.stage).toBe('promoted');
    const rows = events('commit_mismatch');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].detail)).toMatchObject({ rung: 'canary', evidenceCommit: SHA_A, candidateCommit: SHA_B });
  });

  it('a dry run writes no row', async () => {
    await setup();
    expect((await call('/api/candidates/cand/advance', 'POST', { toRung: 'full', dryRun: true })).status).toBe(200);
    expect(events('commit_mismatch')).toEqual([]);
  });
});
