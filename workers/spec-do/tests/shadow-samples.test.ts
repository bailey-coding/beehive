/**
 * Shadow samples (PR A, docs/plans/promotion-gaps-plan.md sections 3.1-3.2, 11-12): the comparator's per-request scores are summed per
 * candidate in shadow_scores, the shadow verdict is derived in the same transaction, a redelivery cannot double-count, and a purge
 * removes the row (orphans included). Real SQL (node:sqlite, foreign keys on) through the real router.
 *
 * Task: promotion-gaps | Spec: docs/plans/promotion-gaps-plan.md PR A
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { SpecDO } from '../index';
import { makeSqliteState, makeSpecDo, type SqliteState } from './sqlite-state';
import { loadLegacyLedger, readVersion, LATEST_VERSION, freshLedger } from './legacy-ledger';
import { CandidateResponseSchema } from '../../shared/schemas';
import {
  CANDIDATE_NOT_FOUND,
  SCIENTIST_COMPARATOR_ACTOR,
  SHADOW_MAX_SAMPLES,
  SHADOW_MIN_SAMPLES,
  shadowVerdict,
} from '../../shared/shadow-verdict';

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
  return { status: res.status, headers: res.headers, json: (await res.json()) as any };
}

const sha = (n: number) => String(n).repeat(40).slice(0, 40);
const sample = (requestId: string, score: number, extra: Record<string, unknown> = {}) => ({
  requestId,
  score,
  matched: score >= 100,
  diffs: [],
  ...extra,
});
const post = (candidateId: string, samples: unknown[], headers: Record<string, string> = {}) =>
  call(`/api/candidates/${candidateId}/shadow-samples`, 'POST', { samples }, headers);
const row = (candidateId: string) =>
  store.raw.prepare('SELECT * FROM shadow_scores WHERE candidate_id = ?').get(candidateId) as Record<string, unknown> | undefined;
const verdictRows = (candidateId: string) =>
  store.raw.prepare("SELECT * FROM gate_verdicts WHERE candidate_id = ? AND gate = 'shadow'").all(candidateId) as Record<string, unknown>[];
const many = (n: number, score: number, prefix = 'r') => Array.from({ length: n }, (_, i) => sample(`${prefix}-${i}`, score));

function seed(name = 'ss-org') {
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

describe('shadowVerdict (pure)', () => {
  it('is pending below the minimum, then pass at 80 and fail below', () => {
    expect(shadowVerdict(SHADOW_MIN_SAMPLES - 1, 100)).toBe('pending');
    expect(shadowVerdict(SHADOW_MIN_SAMPLES, 80)).toBe('pass');
    expect(shadowVerdict(SHADOW_MIN_SAMPLES, 79.99)).toBe('fail');
    expect(shadowVerdict(1000, 100)).toBe('pass');
  });
});

describe('POST /api/candidates/:id/shadow-samples', () => {
  it('sums samples across calls and reads back a running average, with the baseline split', async () => {
    const { c1 } = seed();
    const a = await post(c1.id, [sample('a', 100, { baseline: 'production' }), sample('b', 50)]);
    expect(a.status).toBe(200);
    expect(a.json.data).toMatchObject({ sampleCount: 2, productionCount: 1, averageScore: 75, productionAverageScore: 100, matchedCount: 1, verdict: 'pending', capped: false });
    const b = await post(c1.id, [sample('c', 0, { diffs: [{ type: 'status', severity: 'error' }] })]);
    expect(b.json.data).toMatchObject({ sampleCount: 3, averageScore: 50, matchedCount: 1 });
    expect(row(c1.id)).toMatchObject({ sample_count: 3, production_count: 1, score_sum: 150, production_score_sum: 100, matched_count: 1, last_request_id: 'c' });
    expect(JSON.parse(String(row(c1.id)!.diffs_json))).toEqual({ total: 1, byType: { status: 1 }, bySeverity: { error: 1, warning: 0, info: 0 } });
  });

  it('a sample defaults to the placeholder baseline, so it never counts as production evidence', async () => {
    const { c1 } = seed();
    const res = await post(c1.id, [{ requestId: 'x', score: 90, matched: true }]);
    expect(res.json.data).toMatchObject({ sampleCount: 1, productionCount: 0, productionAverageScore: null });
  });

  it('the candidate response carries the score, a boolean match and a metrics JSON string that parses, and passes the zod schema', async () => {
    const { c1 } = seed();
    expect((await call(`/api/candidates/${c1.id}`)).json.data.shadowScore).toBeUndefined();
    await post(c1.id, [sample('a', 100), sample('b', 100)]);
    const got = (await call(`/api/candidates/${c1.id}`)).json.data;
    expect(got).toMatchObject({ shadowScore: 100, shadowMatch: true });
    expect(typeof got.shadowMetrics).toBe('string');
    expect(JSON.parse(got.shadowMetrics)).toMatchObject({ averageScore: 100, totalRequests: 2, matchedRequests: 2, lastRequestId: 'b' });
    // Only the shadow fields: the preview fields come back null from the DB and fail this schema today (pre-existing, not PR A)
    const zr = CandidateResponseSchema.safeParse(got);
    const shadowIssues = zr.success ? [] : zr.error.issues.filter((i) => String(i.path[0]).startsWith('shadow'));
    expect(shadowIssues).toEqual([]);
    await post(c1.id, [sample('c', 10)]);
    expect((await call(`/api/candidates/${c1.id}`)).json.data.shadowMatch).toBe(false);
    // the list route carries them too
    const list = (await call('/api/candidates')).json.data as any[];
    expect(list.find((c) => c.id === c1.id).shadowScore).toBeCloseTo(70, 5);
  });

  describe('idempotency', () => {
    it('a redelivery under the same key and body replays and does not double-count', async () => {
      const { c1 } = seed();
      const key = { 'Idempotency-Key': `req-1:${c1.id}` };
      const first = await post(c1.id, [sample('req-1', 100)], key);
      const second = await post(c1.id, [sample('req-1', 100)], key);
      expect(first.status).toBe(200);
      expect(second.headers.get('Idempotent-Replay')).toBe('true');
      expect(second.json).toEqual(first.json);
      expect(row(c1.id)).toMatchObject({ sample_count: 1, score_sum: 100 });
    });

    it('the same key with a different body is a 409 and records nothing', async () => {
      const { c1 } = seed();
      const key = { 'Idempotency-Key': `req-1:${c1.id}` };
      await post(c1.id, [sample('req-1', 100)], key);
      const conflict = await post(c1.id, [sample('req-1', 5)], key);
      expect(conflict.status).toBe(409);
      expect(row(c1.id)).toMatchObject({ sample_count: 1, score_sum: 100 });
    });

    it('a keyed body must hold exactly one sample', async () => {
      const { c1 } = seed();
      const res = await post(c1.id, [sample('a', 1), sample('b', 2)], { 'Idempotency-Key': 'k' });
      expect(res.status).toBe(400);
      expect(res.json.error).toMatch(/exactly one sample/);
      expect(row(c1.id)).toBeUndefined();
    });

    it('an unkeyed batch is one transaction: a verdict failure rolls the samples back', async () => {
      const { c1 } = seed();
      // Break the verdict write (the actor row it needs is created inside the same transaction)
      store.raw.exec('DROP TABLE gate_verdicts');
      const res = await post(c1.id, many(SHADOW_MIN_SAMPLES, 100));
      expect(res.status).toBe(500);
      expect(row(c1.id)).toBeUndefined();
      expect(store.raw.prepare('SELECT COUNT(*) AS n FROM actors WHERE id = ?').get(SCIENTIST_COMPARATOR_ACTOR)).toEqual({ n: 0 });
    });
  });

  describe('404 and validation', () => {
    it('an unknown candidate is a coded 404, so a caller can tell it from an older Spec DO that has no route', async () => {
      const res = await post('c-nope', [sample('a', 1)]);
      expect(res.status).toBe(404);
      expect(res.json.error).toBe(CANDIDATE_NOT_FOUND);
    });

    it('a tombstoned candidate is the same coded 404 and nothing is recorded', async () => {
      const { c1 } = seed();
      store.raw.prepare("UPDATE actors SET role = 'maintainer' WHERE id = ?").run(actor);
      expect((await call('/internal/tombstone', 'POST', { entityType: 'candidate', id: c1.id, reason: 't' })).status).toBe(200);
      const res = await post(c1.id, [sample('a', 1)]);
      expect(res.status).toBe(404);
      expect(res.json.error).toBe(CANDIDATE_NOT_FOUND);
      expect(row(c1.id)).toBeUndefined();
    });

    it.each([
      ['no samples', { samples: [] }],
      ['an unknown field', { samples: [sample('a', 1)], extra: 1 }],
      ['an unknown sample field', { samples: [{ ...sample('a', 1), extra: 1 }] }],
      ['a score over 100', { samples: [sample('a', 101)] }],
      ['a negative score', { samples: [sample('a', -1)] }],
      ['a bad severity', { samples: [sample('a', 1, { diffs: [{ type: 't', severity: 'fatal' }] })] }],
      ['an unknown baseline', { samples: [sample('a', 1, { baseline: 'fake' })] }],
      ['more than 100 samples', { samples: many(101, 1) }],
    ])('rejects %s with a 400 and records nothing', async (_name, body) => {
      const { c1 } = seed();
      const res = await call(`/api/candidates/${c1.id}/shadow-samples`, 'POST', body);
      expect(res.status).toBe(400);
      expect(row(c1.id)).toBeUndefined();
    });
  });

  describe('the shadow verdict', () => {
    it('stays pending (no gate verdict row) below the minimum, then writes pass', async () => {
      const { c1 } = seed();
      const early = await post(c1.id, many(SHADOW_MIN_SAMPLES - 1, 100));
      expect(early.json.data.verdict).toBe('pending');
      expect(verdictRows(c1.id)).toHaveLength(0);
      const done = await post(c1.id, [sample('last', 100)]);
      expect(done.json.data.verdict).toBe('pass');
      const [v] = verdictRows(c1.id);
      expect(v).toMatchObject({ status: 'pass', score: 100, decided_by: SCIENTIST_COMPARATOR_ACTOR });
      expect(String(v.notes)).toContain(`${SHADOW_MIN_SAMPLES} samples (0 against production)`);
    });

    it('flips pass to fail in place as the average drops, with one row per (candidate, gate)', async () => {
      const { c1 } = seed();
      await post(c1.id, many(SHADOW_MIN_SAMPLES, 100));
      expect(verdictRows(c1.id)[0].status).toBe('pass');
      const flipped = await post(c1.id, many(SHADOW_MIN_SAMPLES, 0, 'low'));
      expect(flipped.json.data).toMatchObject({ verdict: 'fail', averageScore: 50 });
      const rows = verdictRows(c1.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('fail');
      const history = store.raw.prepare("SELECT COUNT(*) AS n FROM entity_history WHERE entity_type = 'gate_verdict' AND entity_id = ?").get(rows[0].id) as { n: number };
      expect(history.n).toBe(2);
    });

    it('does not rewrite the verdict when its status is unchanged', async () => {
      const { c1 } = seed();
      await post(c1.id, many(SHADOW_MIN_SAMPLES, 100));
      const before = verdictRows(c1.id)[0];
      await post(c1.id, many(5, 100, 'more'));
      expect(verdictRows(c1.id)[0]).toEqual(before);
    });

    it('a score of 0 is a real score, not a missing one', async () => {
      const { c1 } = seed();
      await post(c1.id, many(SHADOW_MIN_SAMPLES, 0));
      expect((await call(`/api/candidates/${c1.id}`)).json.data.shadowScore).toBe(0);
      expect(verdictRows(c1.id)[0].status).toBe('fail');
    });

    it('works with foreign keys on: the reserved actor is created lazily, once, as an agent', async () => {
      const { c1, c2 } = seed();
      expect(store.raw.prepare('SELECT COUNT(*) AS n FROM actors WHERE id = ?').get(SCIENTIST_COMPARATOR_ACTOR)).toEqual({ n: 0 });
      expect((await post(c1.id, many(SHADOW_MIN_SAMPLES, 100))).status).toBe(200);
      expect((await post(c2.id, many(SHADOW_MIN_SAMPLES, 100))).status).toBe(200);
      expect(store.raw.prepare('SELECT type, promotion_authority FROM actors WHERE id = ?').all(SCIENTIST_COMPARATOR_ACTOR)).toEqual([{ type: 'agent', promotion_authority: 0 }]);
      expect(store.raw.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    });
  });

  describe('the sample cap', () => {
    it(`stops recording at ${SHADOW_MAX_SAMPLES} samples, answers capped, and writes nothing more`, async () => {
      const { c1 } = seed();
      for (let i = 0; i < SHADOW_MAX_SAMPLES / 100; i++) expect((await post(c1.id, many(100, 100, `b${i}`))).json.data.capped).toBe(false);
      expect(row(c1.id)).toMatchObject({ sample_count: SHADOW_MAX_SAMPLES });
      const over = await post(c1.id, [sample('over', 0)]);
      expect(over.status).toBe(200);
      expect(over.json.data).toMatchObject({ capped: true, sampleCount: SHADOW_MAX_SAMPLES, averageScore: 100, verdict: 'pass' });
      expect(row(c1.id)).toMatchObject({ sample_count: SHADOW_MAX_SAMPLES, score_sum: SHADOW_MAX_SAMPLES * 100 });
    });

    it('a batch that crosses the cap records only what fits', async () => {
      const { c1 } = seed();
      for (let i = 0; i < 9; i++) await post(c1.id, many(100, 100, `b${i}`));
      await post(c1.id, many(99, 100, 'fill'));
      const cross = await post(c1.id, many(5, 0, 'cross'));
      expect(cross.json.data).toMatchObject({ sampleCount: SHADOW_MAX_SAMPLES, capped: true });
      expect(row(c1.id)).toMatchObject({ sample_count: SHADOW_MAX_SAMPLES, score_sum: 999 * 100 });
    });
  });
});

describe('purge', () => {
  it('an organization purge deletes its shadow_scores row, and sweeps an orphan an older build left', async () => {
    const x = seed('purge-org');
    await post(x.c1.id, [sample('a', 100)]);
    // an orphan: a row whose candidate a pre-m15 purge already deleted
    store.raw
      .prepare("INSERT INTO shadow_scores (id, candidate_id, sample_count, score_sum, matched_count, diffs_json, last_request_id, updated_at) VALUES ('orphan', 'c-gone', 1, 1, 0, '{}', 'r', 1)")
      .run();
    expect(store.raw.prepare('SELECT COUNT(*) AS n FROM shadow_scores').get()).toEqual({ n: 2 });
    store.raw.prepare("UPDATE actors SET role = 'maintainer' WHERE id = ?").run(actor);
    expect((await call('/internal/tombstone', 'POST', { entityType: 'organization', id: x.org.id, reason: 'test' })).status).toBe(200);
    for (const t of ['organizations', 'repositories', 'specs', 'candidates', 'issues']) {
      store.raw.prepare(`UPDATE ${t} SET deleted_at = ? WHERE deleted_at IS NOT NULL`).run(Date.now() - 25 * 3_600_000);
    }
    const dry = await call('/internal/purge', 'POST', { orgNamePrefix: 'purge-' });
    expect(dry.status).toBe(200);
    expect(dry.json.data.counts.shadow_scores).toBe(2);
    const purge = await call('/internal/purge', 'POST', { orgNamePrefix: 'purge-', dryRun: false, confirm: dry.json.data.total });
    expect(purge.status).toBe(200);
    expect(store.raw.prepare('SELECT COUNT(*) AS n FROM shadow_scores').get()).toEqual({ n: 0 });
  });
});

describe('migration m15', () => {
  it('a fresh ledger has the table without running a step', async () => {
    expect(Number(LATEST_VERSION.slice(1))).toBeGreaterThanOrEqual(15);
    const fresh = await freshLedger();
    expect(readVersion(fresh)).toBe(LATEST_VERSION);
    const cols = (fresh.raw.prepare('PRAGMA table_info(shadow_scores)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['id', 'candidate_id', 'sample_count', 'score_sum', 'production_count', 'diffs_json']));
    expect(fresh.raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'shadow_scores'").get()).toBeTruthy();
  });

  it('a ledger at m14 gains the table and keeps its rows; the step has no foreign key (rollback floor)', async () => {
    const fresh = await freshLedger();
    fresh.raw.exec('DROP TABLE shadow_scores');
    fresh.raw.exec("UPDATE metadata SET value = 'm14' WHERE key = 'schema_version'");
    const before = fresh.raw.prepare('SELECT COUNT(*) AS n FROM metadata').get();
    await makeSpecDo(fresh).init();
    expect(readVersion(fresh)).toBe(LATEST_VERSION);
    expect(fresh.raw.prepare('SELECT COUNT(*) AS n FROM shadow_scores').get()).toEqual({ n: 0 });
    expect(fresh.raw.prepare('SELECT COUNT(*) AS n FROM metadata').get()).toEqual(before);
    expect(fresh.raw.prepare('PRAGMA foreign_key_list(shadow_scores)').all()).toEqual([]);
  });
});
