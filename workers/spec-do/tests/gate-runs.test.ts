/**
 * Gate runs in the Spec DO (m13): start (dedupe, quota, caps, attempt numbering, idempotent redelivery, terminal), finish
 * (compare-and-set, summary upsert in the same transaction), reads (latest per sha, stale running rows). Real DO on node:sqlite
 * with foreign keys on. Time is a variable clock behind Date.now, so no timers are involved.
 *
 * Task: real-gate-slice5 | Spec: docs/REAL-GATE-IMPL-PLAN.md §3
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SpecDO } from '../index';
import { makeSqliteState, makeSpecDo, type SqliteState } from './sqlite-state';
import {
  GATE_LOG_TAIL_MAX_BYTES,
  GATE_RUN_QUOTA_WINDOW_MS,
  GATE_RUN_STALE_MS,
  MAX_GATE_RUNS_PER_ORG_PER_DAY,
  MAX_GATE_RUN_ATTEMPTS_PER_SHA,
  FinishGateRunRequestSchema,
  StartGateRunResultSchema,
  GateRunSchema,
} from '../../shared/gate-run-schema';

let store: SqliteState;
let spec: SpecDO;
let actor: string;
let clock: number;

const sha = (n: number) => n.toString(16).padStart(40, '0');
const count = (sql: string, ...binds: unknown[]) => (store.raw.prepare(sql).get(...(binds as never[])) as { n: number }).n;
const runRows = () => count('SELECT COUNT(*) AS n FROM gate_runs');

async function call(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  const res = await spec.fetch(
    new Request(`https://spec-do.internal${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    })
  );
  const json = (await res.json()) as any;
  return { status: res.status, headers: res.headers, json };
}

/** org -> repo -> spec -> candidate; the namespace is the org name */
function seed(name: string) {
  const org = spec.createOrganization(name, 'artifacts');
  const repo = spec.createRepository(`${name}-repo`, org.id, 'baseline', undefined, undefined, 'https://example.invalid/r.git', name);
  const s = spec.createSpec(`${name}-spec`, 'd', 'contract', [], org.id, actor);
  const cand = spec.createCandidate(s.id, repo.id, sha(1), sha(0), actor);
  return { org, repo, spec: s, cand };
}
/** a second candidate in the same repository */
const secondCandidate = (s: ReturnType<typeof seed>) => spec.createCandidate(s.spec.id, s.repo.id, sha(2), sha(0), actor);

const start = (candidateId: string, commitSha: string, extra: object = {}, headers: Record<string, string> = {}) =>
  call('/api/gate-runs', 'POST', { candidateId, gate: 'pre-merge', commitSha, decidedBy: actor, ...extra }, headers);

const passBody = (extra: object = {}) => ({
  status: 'pass',
  exitCode: 0,
  checks: { tests: 'verified', conformance: 'not_run', complexity: 'not_run' },
  timings: { install: { ms: 1000, exit: 0, timedOut: false }, test: { ms: 2000, exit: 0, timedOut: false }, totalMs: 3200 },
  counts: { passed: 12, failed: 0 },
  logTail: 'ok\n',
  logSha256: 'a'.repeat(64),
  instance: 'standard-2',
  ...extra,
});
const failBody = (extra: object = {}) =>
  passBody({ status: 'fail', failureClass: 'tests_failed', exitCode: 1, counts: { passed: 3, failed: 1 }, ...extra });
const errorBody = (extra: object = {}) =>
  passBody({ status: 'error', failureClass: 'sandbox_unavailable', exitCode: null, counts: null, ...extra });

const finish = (runId: string, body: object) => call(`/api/gate-runs/${runId}/result`, 'POST', body);
/** start + finish in one go */
async function runTo(candidateId: string, commitSha: string, body: object) {
  const s = await start(candidateId, commitSha);
  expect(s.status).toBe(200);
  const f = await finish(s.json.data.runId, body);
  expect(f.status).toBe(200);
  return s.json.data.runId as string;
}
const summary = (candidateId: string) =>
  store.raw.prepare("SELECT * FROM gate_verdicts WHERE candidate_id = ? AND gate = 'pre-merge'").all(candidateId) as any[];

beforeEach(async () => {
  clock = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  store = makeSqliteState();
  spec = makeSpecDo(store);
  await spec.init();
  actor = spec.createActor('human', 'maint').id;
});
afterEach(() => vi.restoreAllMocks());

describe('gate-run schemas (strict)', () => {
  it('start: unknown fields, a short or uppercase sha, another gate, a bad terminal and bad JSON are 400, nothing is written', async () => {
    const s = seed('org-a');
    const bad: [string, object | string][] = [
      ['unknown field', { candidateId: s.cand.id, gate: 'pre-merge', commitSha: sha(5), decidedBy: actor, extra: 1 }],
      ['short sha', { candidateId: s.cand.id, gate: 'pre-merge', commitSha: 'abc1234', decidedBy: actor }],
      ['uppercase sha', { candidateId: s.cand.id, gate: 'pre-merge', commitSha: 'A'.repeat(40), decidedBy: actor }],
      ['a ref', { candidateId: s.cand.id, gate: 'pre-merge', commitSha: 'main', decidedBy: actor }],
      ['other gate', { candidateId: s.cand.id, gate: 'canary', commitSha: sha(5), decidedBy: actor }],
      ['terminal pass', { candidateId: s.cand.id, gate: 'pre-merge', commitSha: sha(5), decidedBy: actor, terminal: { status: 'pass', failureClass: 'quota' } }],
      ['terminal class', { candidateId: s.cand.id, gate: 'pre-merge', commitSha: sha(5), decidedBy: actor, terminal: { status: 'error', failureClass: 'made_up' } }],
      ['missing decidedBy', { candidateId: s.cand.id, gate: 'pre-merge', commitSha: sha(5) }],
      ['not json', '{nope'],
    ];
    for (const [label, body] of bad) {
      const res = await call('/api/gate-runs', 'POST', body);
      expect(res.status, label).toBe(400);
      expect(res.json.success, label).toBe(false);
    }
    expect(runRows()).toBe(0);
  });

  it('finish: statuses and classes outside the vocabulary, a missing class, an over-long log and unknown fields are 400', async () => {
    const s = seed('org-a');
    const { json } = await start(s.cand.id, sha(5));
    const id = json.data.runId;
    const bad: [string, object][] = [
      ['running', passBody({ status: 'running' })],
      ['not_run', passBody({ status: 'not_run', failureClass: 'quota' })],
      ['fail without a class', passBody({ status: 'fail' })],
      ['pass with a class', passBody({ failureClass: 'tests_failed' })],
      ['unknown class', failBody({ failureClass: 'abandoned' })],
      ['tests check', passBody({ checks: { tests: 'pass', conformance: 'not_run', complexity: 'not_run' } })],
      ['conformance pass', passBody({ checks: { tests: 'verified', conformance: 'pass', complexity: 'not_run' } })],
      ['complexity number', passBody({ checks: { tests: 'verified', conformance: 'not_run', complexity: 0 } })],
      ['unknown field', passBody({ score: 100 })],
      ['sha256', passBody({ logSha256: 'xyz' })],
      ['counts', passBody({ counts: { passed: -1, failed: 0 } })],
      ['log over 32 KiB', passBody({ logTail: 'x'.repeat(GATE_LOG_TAIL_MAX_BYTES + 1) })],
      ['log over 32 KiB in bytes, not characters', passBody({ logTail: 'é'.repeat(GATE_LOG_TAIL_MAX_BYTES / 2 + 1) })],
    ];
    for (const [label, body] of bad) {
      const res = await finish(id, body);
      expect(res.status, label).toBe(400);
    }
    expect((await finish(id, passBody({ logTail: 'x'.repeat(GATE_LOG_TAIL_MAX_BYTES) }))).status).toBe(200);
  });

  it('the shared schemas accept what the routes answer (the gate parses with them)', async () => {
    const s = seed('org-a');
    const started = await start(s.cand.id, sha(5));
    expect(StartGateRunResultSchema.parse(started.json.data)).toMatchObject({ attempt: 1, repo: 'org-a-repo', namespace: 'org-a', status: 'running' });
    const done = await finish(started.json.data.runId, passBody());
    expect(GateRunSchema.parse(done.json.data).status).toBe('pass');
    expect(FinishGateRunRequestSchema.safeParse(passBody()).success).toBe(true);
    const list = await call(`/api/candidates/${s.cand.id}/gate-runs`);
    for (const r of list.json.data) GateRunSchema.parse(r);
  });
});

describe('start', () => {
  it('inserts a running run, resolves repo and namespace from the ledger, and attempt 1', async () => {
    const s = seed('org-a');
    const r = await start(s.cand.id, sha(5));
    expect(r.status).toBe(200);
    expect(r.json.data).toEqual({ runId: expect.any(String), attempt: 1, repo: 'org-a-repo', namespace: 'org-a', status: 'running' });
    expect(store.raw.prepare('SELECT status, decided_by, finished_at FROM gate_runs').all()).toEqual([
      { status: 'running', decided_by: actor, finished_at: null },
    ]);
  });

  it('unknown candidate is 404, unknown decidedBy 400, a repository without a valid namespace 400; nothing is written', async () => {
    const s = seed('org-a');
    expect((await start('nope', sha(5))).status).toBe(404);
    expect((await start(s.cand.id, sha(5), { decidedBy: 'ghost' })).status).toBe(400);
    store.raw.prepare("UPDATE repositories SET namespace = 'bad name!' WHERE id = ?").run(s.repo.id);
    const bad = await start(s.cand.id, sha(5));
    expect(bad.status).toBe(400);
    expect(bad.json.error).toContain('namespace');
    expect(runRows()).toBe(0);
  });

  it('a tombstoned candidate is 404', async () => {
    const s = seed('org-a');
    store.raw.prepare('UPDATE candidates SET deleted_at = 1 WHERE id = ?').run(s.cand.id);
    expect((await start(s.cand.id, sha(5))).status).toBe(404);
  });

  describe('dedupe', () => {
    it('the same sha while running, and after pass or fail, answers deduped with the existing run and writes nothing', async () => {
      const s = seed('org-a');
      const first = await start(s.cand.id, sha(5));
      const id = first.json.data.runId;
      expect((await start(s.cand.id, sha(5))).json.data).toEqual({ deduped: true, runId: id });
      expect(runRows()).toBe(1);

      await finish(id, passBody());
      expect((await start(s.cand.id, sha(5))).json.data).toEqual({ deduped: true, runId: id });

      const s2 = seed('org-b');
      const other = await runTo(s2.cand.id, sha(6), failBody());
      expect((await start(s2.cand.id, sha(6))).json.data).toEqual({ deduped: true, runId: other });
      expect(runRows()).toBe(2);
    });

    it('after an error run the same sha starts attempt 2 and the summary follows; a new sha is attempt 1', async () => {
      const s = seed('org-a');
      await runTo(s.cand.id, sha(5), errorBody());
      const again = await start(s.cand.id, sha(5));
      expect(again.json.data).toMatchObject({ attempt: 2, status: 'running' });
      await finish(again.json.data.runId, errorBody());
      const third = await start(s.cand.id, sha(5));
      expect(third.json.data.attempt).toBe(3);
      await finish(third.json.data.runId, passBody());
      expect(store.raw.prepare('SELECT attempt, status FROM gate_runs ORDER BY attempt').all()).toEqual([
        { attempt: 1, status: 'error' },
        { attempt: 2, status: 'error' },
        { attempt: 3, status: 'pass' },
      ]);
      expect(summary(s.cand.id)).toHaveLength(1);
      expect(summary(s.cand.id)[0]).toMatchObject({ status: 'pass', score: 100 });

      const fresh = await start(s.cand.id, sha(6));
      expect(fresh.json.data.attempt).toBe(1);
    });

    it('a stale running row does not dedupe: the same sha starts the next attempt', async () => {
      const s = seed('org-a');
      await start(s.cand.id, sha(5));
      clock += GATE_RUN_STALE_MS + 1;
      expect((await start(s.cand.id, sha(5))).json.data).toMatchObject({ attempt: 2, status: 'running' });
    });
  });

  describe('caps', () => {
    it('one running per repository: the second start is 409 busy, writes no row and leaves no idempotency key', async () => {
      const s = seed('org-a');
      const c2 = secondCandidate(s);
      await start(s.cand.id, sha(5));
      const keys = () => count('SELECT COUNT(*) AS n FROM idempotency_keys');
      const before = [runRows(), keys()];
      const busy = await start(c2.id, sha(7), {}, { 'Idempotency-Key': 'gate-run:msg-1' });
      expect(busy.status).toBe(409);
      expect(busy.json).toMatchObject({ success: false, code: 'busy', reason: 'repository' });
      expect([runRows(), keys()]).toEqual(before);
    });

    it('once the repository run finishes, the same message key (re-sent after the delay) starts', async () => {
      const s = seed('org-a');
      const c2 = secondCandidate(s);
      const first = await start(s.cand.id, sha(5));
      expect((await start(c2.id, sha(7), {}, { 'Idempotency-Key': 'gate-run:msg-1' })).status).toBe(409);
      await finish(first.json.data.runId, passBody());
      const retry = await start(c2.id, sha(7), {}, { 'Idempotency-Key': 'gate-run:msg-1' });
      expect(retry.status).toBe(200);
      expect(retry.json.data).toMatchObject({ attempt: 1, status: 'running' });
    });

    it('three running across the ledger: the fourth (another repository) is 409 busy global', async () => {
      const orgs = ['org-a', 'org-b', 'org-c', 'org-d'].map(seed);
      for (const o of orgs.slice(0, 3)) expect((await start(o.cand.id, sha(5))).status).toBe(200);
      const busy = await start(orgs[3].cand.id, sha(5));
      expect(busy.status).toBe(409);
      expect(busy.json).toMatchObject({ code: 'busy', reason: 'global' });
      expect(runRows()).toBe(3);
    });

    it('a stale running row frees its slot and is reported error/abandoned at read time without being rewritten', async () => {
      const s = seed('org-a');
      const c2 = secondCandidate(s);
      const first = await start(s.cand.id, sha(5));
      clock += GATE_RUN_STALE_MS - 1;
      expect((await start(c2.id, sha(7))).status).toBe(409);
      clock += 2;
      expect((await start(c2.id, sha(7))).status).toBe(200);

      const read = await call(`/api/gate-runs/${first.json.data.runId}`);
      expect(read.json.data).toMatchObject({ status: 'error', failureClass: 'abandoned', stale: true, finishedAt: null });
      expect(store.raw.prepare('SELECT status, failure_class FROM gate_runs WHERE id = ?').get(first.json.data.runId)).toEqual({
        status: 'running',
        failure_class: null,
      });
    });
  });

  describe('organization quota', () => {
    /** n finished runs for the org, spread so the caps never matter */
    function insertRuns(candidateId: string, n: number, at: number, status = 'pass') {
      const ins = store.raw.prepare(
        `INSERT INTO gate_runs (id, candidate_id, gate, commit_sha, attempt, status, decided_by, started_at, finished_at)
         VALUES (?, ?, 'pre-merge', ?, 1, ?, ?, ?, ?)`
      );
      for (let i = 0; i < n; i++) ins.run(`bulk-${candidateId}-${i}-${at}`, candidateId, sha(1000 + i), status, actor, at, at);
    }

    it('the 51st run in 24 h writes a not_run/quota row and answers quota; a repeat for the sha writes no second row', async () => {
      const s = seed('org-a');
      insertRuns(s.cand.id, MAX_GATE_RUNS_PER_ORG_PER_DAY - 1, clock - 1000);
      const last = await start(s.cand.id, sha(5));
      expect(last.json.data).toMatchObject({ attempt: 1, status: 'running' });
      await finish(last.json.data.runId, passBody());

      const over = await start(s.cand.id, sha(6));
      expect(over.status).toBe(200);
      expect(over.json.data).toEqual({ quota: true, runId: expect.any(String) });
      expect(store.raw.prepare('SELECT status, failure_class FROM gate_runs WHERE id = ?').get(over.json.data.runId)).toEqual({
        status: 'not_run',
        failure_class: 'quota',
      });
      const rows = runRows();
      expect((await start(s.cand.id, sha(6))).json.data).toEqual(over.json.data);
      expect(runRows()).toBe(rows);
      // the summary shows pending (not_run), the true value is in gate_runs
      expect(summary(s.cand.id)[0]).toMatchObject({ status: 'pending', score: 0 });
    });

    it('is per organization: another organization still starts; runs older than 24 h do not count', async () => {
      const a = seed('org-a');
      const b = seed('org-b');
      insertRuns(a.cand.id, MAX_GATE_RUNS_PER_ORG_PER_DAY, clock - 1000);
      expect((await start(b.cand.id, sha(5))).json.data).toMatchObject({ status: 'running' });
      expect((await start(a.cand.id, sha(5))).json.data).toHaveProperty('quota', true);
      clock += GATE_RUN_QUOTA_WINDOW_MS;
      // attempt 2: the refusal row of the first try is attempt 1 of this sha and does not dedupe (not_run may be re-run)
      expect((await start(a.cand.id, sha(5))).json.data).toMatchObject({ attempt: 2, status: 'running' });
    });

    it('not_run and busy_timeout rows never count against the quota', async () => {
      const s = seed('org-a');
      insertRuns(s.cand.id, MAX_GATE_RUNS_PER_ORG_PER_DAY, clock - 1000, 'not_run');
      expect((await start(s.cand.id, sha(5))).json.data).toMatchObject({ status: 'running' });
      const t = seed('org-b');
      for (let i = 0; i < MAX_GATE_RUNS_PER_ORG_PER_DAY; i++) {
        await start(t.cand.id, sha(2000 + i), { terminal: { status: 'error', failureClass: 'busy_timeout' } });
      }
      expect((await start(t.cand.id, sha(5))).json.data).toMatchObject({ status: 'running' });
    });
  });

  describe('terminal', () => {
    it('inserts a finished row, skips the caps and the quota, numbers the attempt and updates the summary', async () => {
      const s = seed('org-a');
      const c2 = secondCandidate(s);
      await start(s.cand.id, sha(5)); // the repository slot is taken
      const t = await start(c2.id, sha(7), { terminal: { status: 'error', failureClass: 'busy_timeout' } });
      expect(t.status).toBe(200);
      expect(t.json.data).toMatchObject({ attempt: 1, status: 'error' });
      expect(store.raw.prepare('SELECT status, failure_class, finished_at, checks FROM gate_runs WHERE id = ?').get(t.json.data.runId)).toEqual({
        status: 'error',
        failure_class: 'busy_timeout',
        finished_at: clock,
        checks: JSON.stringify({ tests: 'unverified', conformance: 'not_run', complexity: 'not_run' }),
      });
      expect(summary(c2.id)[0]).toMatchObject({ status: 'pending', score: 0 });
      // after an error row the same sha may run again
      expect(await start(c2.id, sha(7), { terminal: { status: 'error', failureClass: 'sandbox_unavailable' } }).then((r) => r.json.data.attempt)).toBe(2);
    });

    it('is deduped like any start when a live or passed run exists', async () => {
      const s = seed('org-a');
      const id = await runTo(s.cand.id, sha(5), passBody());
      const t = await start(s.cand.id, sha(5), { terminal: { status: 'error', failureClass: 'sandbox_unavailable' } });
      expect(t.json.data).toEqual({ deduped: true, runId: id });
    });
  });

  describe('attempt cap per sha', () => {
    const terminal = { terminal: { status: 'error', failureClass: 'sandbox_unavailable' } };

    it('the 11th start on one sha, terminal or not, is 409 too_many_attempts and writes nothing; another sha and org are unaffected', async () => {
      const s = seed('org-a');
      for (let i = 1; i <= MAX_GATE_RUN_ATTEMPTS_PER_SHA; i++) {
        expect((await start(s.cand.id, sha(5), terminal)).json.data.attempt).toBe(i);
      }
      const keys = () => count('SELECT COUNT(*) AS n FROM idempotency_keys');
      const before = [runRows(), keys(), count('SELECT COUNT(*) AS n FROM entity_history')];
      for (const extra of [terminal, {}]) {
        const res = await start(s.cand.id, sha(5), extra, { 'Idempotency-Key': `gate-run:cap-${Object.keys(extra).length}` });
        expect(res.status).toBe(409);
        expect(res.json).toMatchObject({ success: false, code: 'too_many_attempts' });
      }
      expect([runRows(), keys(), count('SELECT COUNT(*) AS n FROM entity_history')]).toEqual(before);
      expect((await start(s.cand.id, sha(6))).json.data).toMatchObject({ attempt: 1, status: 'running' });
    });

    it('a pass or fail on the sha still dedupes before the cap, and a live running run is not an error', async () => {
      const s = seed('org-a');
      for (let i = 1; i < MAX_GATE_RUN_ATTEMPTS_PER_SHA; i++) await start(s.cand.id, sha(5), terminal);
      const last = await runTo(s.cand.id, sha(5), passBody());
      expect(store.raw.prepare('SELECT MAX(attempt) AS n FROM gate_runs').get()).toEqual({ n: MAX_GATE_RUN_ATTEMPTS_PER_SHA });
      expect((await start(s.cand.id, sha(5))).json.data).toEqual({ deduped: true, runId: last });
    });
  });

  describe('idempotent redelivery (Idempotency-Key)', () => {
    it('a redelivered message replays its own run: one row, the stored body, even after the run finished', async () => {
      const s = seed('org-a');
      const headers = { 'Idempotency-Key': 'gate-run:msg-42' };
      const first = await start(s.cand.id, sha(5), {}, headers);
      const replay = await start(s.cand.id, sha(5), {}, headers);
      expect(replay.headers.get('Idempotent-Replay')).toBe('true');
      expect(replay.json.data).toEqual(first.json.data);
      expect(runRows()).toBe(1);

      await finish(first.json.data.runId, errorBody());
      const late = await start(s.cand.id, sha(5), {}, headers);
      expect(late.json.data).toEqual(first.json.data);
      expect(runRows()).toBe(1);
    });

    it('the same key with a different body is 409 and writes nothing', async () => {
      const s = seed('org-a');
      const headers = { 'Idempotency-Key': 'gate-run:msg-42' };
      await start(s.cand.id, sha(5), {}, headers);
      const clash = await start(s.cand.id, sha(6), {}, headers);
      expect(clash.status).toBe(409);
      expect(clash.json.error).toContain('Idempotency key conflict');
      expect(runRows()).toBe(1);
    });

    it('without a key a redelivery is still not a second run (dedupe)', async () => {
      const s = seed('org-a');
      await start(s.cand.id, sha(5));
      await start(s.cand.id, sha(5));
      expect(runRows()).toBe(1);
    });
  });
});

describe('finish', () => {
  it('writes the result once: fields, counts, log, duration and finishedAt', async () => {
    const s = seed('org-a');
    const { json } = await start(s.cand.id, sha(5));
    clock += 5000;
    const res = await finish(json.data.runId, passBody({ imageDigest: 'sha256:abc', runner: 'test-sandbox' }));
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({
      status: 'pass',
      failureClass: null,
      exitCode: 0,
      counts: { passed: 12, failed: 0 },
      checks: { tests: 'verified', conformance: 'not_run', complexity: 'not_run' },
      instance: 'standard-2',
      imageDigest: 'sha256:abc',
      runner: 'test-sandbox',
      durationMs: 3200,
      logTail: 'ok\n',
      logSha256: 'a'.repeat(64),
      logTruncated: false,
      finishedAt: clock,
      stale: false,
    });
  });

  it('terminal states are written once: an identical replay is 200, a different body 409, an unknown run 404', async () => {
    const s = seed('org-a');
    const id = (await start(s.cand.id, sha(5))).json.data.runId;
    expect((await finish(id, failBody())).status).toBe(200);
    const stamp = store.raw.prepare('SELECT finished_at FROM gate_runs WHERE id = ?').get(id);
    clock += 1000;
    expect((await finish(id, failBody())).status).toBe(200);
    expect(store.raw.prepare('SELECT finished_at FROM gate_runs WHERE id = ?').get(id)).toEqual(stamp);
    const other = await finish(id, passBody());
    expect(other.status).toBe(409);
    expect(other.json.error).toContain('already fail');
    expect((await finish('nope', passBody())).status).toBe(404);
    expect(store.raw.prepare('SELECT status FROM gate_runs WHERE id = ?').get(id)).toEqual({ status: 'fail' });
  });

  it('a replay compares by value, not by key order: a stored result with reordered JSON keys, or a reordered body, is still 200', async () => {
    const s = seed('org-a');
    const id = (await start(s.cand.id, sha(5))).json.data.runId;
    expect((await finish(id, passBody())).status).toBe(200);
    // the same value written with the keys the other way round (a row from another writer or version)
    store.raw
      .prepare('UPDATE gate_runs SET checks = ?, timings = ? WHERE id = ?')
      .run(
        '{"complexity":"not_run","conformance":"not_run","tests":"verified"}',
        '{"totalMs":3200,"test":{"timedOut":false,"exit":0,"ms":2000},"install":{"timedOut":false,"exit":0,"ms":1000}}',
        id
      );
    expect((await finish(id, passBody())).status).toBe(200);
    // and a request whose own keys are reordered
    const raw =
      '{"instance":"standard-2","logSha256":"' + 'a'.repeat(64) + '","logTail":"ok\\n","counts":{"failed":0,"passed":12},"timings":{"totalMs":3200,"test":{"timedOut":false,"exit":0,"ms":2000},"install":{"timedOut":false,"exit":0,"ms":1000}},"checks":{"complexity":"not_run","conformance":"not_run","tests":"verified"},"exitCode":0,"status":"pass"}';
    expect((await call(`/api/gate-runs/${id}/result`, 'POST', raw)).status).toBe(200);
    // a different value is still a conflict
    expect((await finish(id, passBody({ timings: { totalMs: 1 } }))).status).toBe(409);
  });

  it('a terminal-start row cannot be finished with a different result', async () => {
    const s = seed('org-a');
    const t = await start(s.cand.id, sha(5), { terminal: { status: 'error', failureClass: 'busy_timeout' } });
    expect((await finish(t.json.data.runId, passBody())).status).toBe(409);
  });

  it('a result that arrives after the run went stale is still recorded (the stored status was running)', async () => {
    const s = seed('org-a');
    const id = (await start(s.cand.id, sha(5))).json.data.runId;
    clock += GATE_RUN_STALE_MS + 1000;
    expect((await call(`/api/gate-runs/${id}`)).json.data.status).toBe('error');
    expect((await finish(id, passBody())).status).toBe(200);
    expect((await call(`/api/gate-runs/${id}`)).json.data).toMatchObject({ status: 'pass', stale: false });
  });

  describe('legacy summary (gate_verdicts), same transaction', () => {
    it('upserts one row per (candidate, gate): the same id and history, score 100 / 0, notes carry the not-measured checks', async () => {
      const s = seed('org-a');
      await runTo(s.cand.id, sha(5), failBody());
      const [first] = summary(s.cand.id);
      expect(first).toMatchObject({ status: 'fail', score: 0, complexity_delta: 0, decided_by: actor });
      expect(first.notes).toMatch(/^complexity not measured; conformance not run; gate run .* attempt 1 at [0-9a-f]{12}: fail \(tests_failed\)$/);

      clock += 1000;
      await runTo(s.cand.id, sha(6), passBody());
      const rows = summary(s.cand.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: first.id, status: 'pass', score: 100, created_at: clock });
      expect(count("SELECT COUNT(*) AS n FROM entity_history WHERE entity_type = 'gate_verdict' AND entity_id = ?", first.id)).toBe(2);
    });

    it('existing readers keep working: GET /api/gate-verdicts and /api/candidates/:id/gate-verdicts show the summary', async () => {
      const s = seed('org-a');
      await runTo(s.cand.id, sha(5), passBody());
      const list = await call(`/api/gate-verdicts?candidateId=${s.cand.id}`);
      expect(list.json.data).toHaveLength(1);
      expect(list.json.data[0]).toMatchObject({ gate: 'pre-merge', status: 'pass' });
      const per = await call(`/api/candidates/${s.cand.id}/gate-verdicts`);
      expect(per.json.data).toHaveLength(1);
    });

    it('a pass with no parsable counts says so; error and not_run map to pending', async () => {
      const s = seed('org-a');
      await runTo(s.cand.id, sha(5), passBody({ checks: { tests: 'unverified', conformance: 'not_run', complexity: 'not_run' }, counts: null }));
      expect(summary(s.cand.id)[0].notes).toMatch(/^pass indistinguishable from no tests; complexity not measured/);
      await runTo(s.cand.id, sha(6), errorBody());
      expect(summary(s.cand.id)[0]).toMatchObject({ status: 'pending', score: 0 });
    });

    it('a late result of an older run does not overwrite the summary, but is recorded in gate_runs', async () => {
      const s = seed('org-a');
      const old = (await start(s.cand.id, sha(5))).json.data.runId;
      clock += GATE_RUN_STALE_MS + 1;
      const newer = (await start(s.cand.id, sha(6))).json.data.runId;
      await finish(newer, passBody());
      clock += 1000;
      await finish(old, failBody());
      expect(summary(s.cand.id)[0]).toMatchObject({ status: 'pass' });
      expect(summary(s.cand.id)[0].notes).toContain(newer);
      expect(store.raw.prepare('SELECT status FROM gate_runs WHERE id = ?').get(old)).toEqual({ status: 'fail' });
    });

    it('rolls back with the run: a failing summary write leaves the run running', async () => {
      const s = seed('org-a');
      const id = (await start(s.cand.id, sha(5))).json.data.runId;
      store.raw.exec('PRAGMA foreign_keys = OFF');
      store.raw.exec("UPDATE gate_runs SET decided_by = 'ghost' WHERE id = '" + id + "'");
      store.raw.exec('PRAGMA foreign_keys = ON');
      const res = await finish(id, passBody());
      expect(res.status).toBe(500);
      expect(store.raw.prepare('SELECT status FROM gate_runs WHERE id = ?').get(id)).toEqual({ status: 'running' });
      expect(summary(s.cand.id)).toHaveLength(0);
    });

    it('the old verdict route is unchanged for other gates and for candidates without runs', async () => {
      const s = seed('org-a');
      const shadow = await call('/api/gate-verdicts', 'POST', { candidateId: s.cand.id, gate: 'shadow', status: 'pass', score: 90, complexityDelta: 1, decidedBy: actor });
      expect(shadow.status).toBe(201);
      const legacy = await call('/api/gate-verdicts', 'POST', { candidateId: s.cand.id, gate: 'pre-merge', status: 'pass', score: 80, complexityDelta: 2, decidedBy: actor });
      expect(legacy.status).toBe(201);
      expect(summary(s.cand.id)).toHaveLength(1);
      // a legacy verdict is not a run: it never dedupes one
      expect((await start(s.cand.id, sha(5))).json.data).toMatchObject({ attempt: 1, status: 'running' });
    });
  });
});

describe('reads', () => {
  async function history() {
    const s = seed('org-a');
    await runTo(s.cand.id, sha(5), errorBody());
    clock += 10;
    await runTo(s.cand.id, sha(5), failBody({ logTail: 'boom\n' }));
    clock += 10;
    await runTo(s.cand.id, sha(6), passBody());
    return s;
  }

  it('lists every attempt of a candidate newest first, without the log unless includeLog=1', async () => {
    const s = await history();
    for (const url of [`/api/candidates/${s.cand.id}/gate-runs`, `/api/gate-runs?candidateId=${s.cand.id}`]) {
      const res = await call(url);
      expect(res.status).toBe(200);
      expect(res.json.data.map((r: any) => [r.commitSha.slice(-1), r.attempt, r.status])).toEqual([
        ['6', 1, 'pass'],
        ['5', 2, 'fail'],
        ['5', 1, 'error'],
      ]);
      expect(res.json.data[0]).not.toHaveProperty('logTail');
    }
    const withLog = await call(`/api/candidates/${s.cand.id}/gate-runs?includeLog=1&commitSha=${sha(5)}`);
    expect(withLog.json.data.map((r: any) => r.logTail)).toEqual(['boom\n', 'ok\n']);
  });

  it('latest=1 keeps the highest attempt of each sha; commitSha filters', async () => {
    const s = await history();
    const latest = await call(`/api/candidates/${s.cand.id}/gate-runs?latest=1`);
    expect(latest.json.data.map((r: any) => [r.commitSha.slice(-1), r.attempt, r.status])).toEqual([
      ['6', 1, 'pass'],
      ['5', 2, 'fail'],
    ]);
    const one = await call(`/api/candidates/${s.cand.id}/gate-runs?latest=1&commitSha=${sha(5)}`);
    expect(one.json.data).toHaveLength(1);
    expect(one.json.data[0]).toMatchObject({ attempt: 2, status: 'fail' });
    const none = await call(`/api/candidates/${s.cand.id}/gate-runs?commitSha=${sha(9)}`);
    expect(none.json.data).toEqual([]);
  });

  it('a stale running run in a list is reported error/abandoned and does not hide the finished ones', async () => {
    const s = await history();
    const id = (await start(s.cand.id, sha(7))).json.data.runId;
    clock += GATE_RUN_STALE_MS + 1;
    const latest = await call(`/api/candidates/${s.cand.id}/gate-runs?latest=1&commitSha=${sha(7)}`);
    expect(latest.json.data[0]).toMatchObject({ id, status: 'error', failureClass: 'abandoned', stale: true });
  });

  it('detail returns the log tail; unknown run, unknown candidate and a missing or malformed query are errors, not empty', async () => {
    const s = await history();
    const first = (await call(`/api/gate-runs?candidateId=${s.cand.id}`)).json.data[1];
    expect((await call(`/api/gate-runs/${first.id}`)).json.data.logTail).toBe('boom\n');
    expect((await call('/api/gate-runs/nope')).status).toBe(404);
    expect((await call('/api/candidates/nope/gate-runs')).status).toBe(404);
    expect((await call('/api/gate-runs')).status).toBe(400);
    expect((await call(`/api/gate-runs?candidateId=${s.cand.id}&commitSha=main`)).status).toBe(400);
  });
});
