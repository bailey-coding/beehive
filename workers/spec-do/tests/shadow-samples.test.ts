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
import { SpecDOClient } from '../../scientist-comparator/storage/spec-do';
import type { CandidateComparisonResult } from '../../scientist-comparator/types';
import { ShadowSamplesRequestSchema } from '../../shared/shadow-verdict';
import { TEST_INTERNAL_TOKEN } from './do-tokens';
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

  it('the candidate response carries shadowProductionScore/Count only once a production sample exists, and the shadow fields pass the zod schema', async () => {
    const { c1 } = seed();
    await post(c1.id, [sample('p0', 50)]);
    const before = (await call(`/api/candidates/${c1.id}`)).json.data;
    expect(before.shadowScore).toBe(50);
    expect('shadowProductionScore' in before).toBe(false);
    expect('shadowProductionCount' in before).toBe(false);
    await post(c1.id, [sample('p1', 100, { baseline: 'production' }), sample('p2', 80, { baseline: 'production' })]);
    const after = (await call(`/api/candidates/${c1.id}`)).json.data;
    expect(after).toMatchObject({ shadowScore: 76.67, shadowProductionScore: 90, shadowProductionCount: 2 });
    const zr = CandidateResponseSchema.safeParse(after);
    expect(zr.success ? [] : zr.error.issues.filter((i) => String(i.path[0]).startsWith('shadow'))).toEqual([]);
    const list = (await call('/api/candidates')).json.data as Array<Record<string, unknown>>;
    expect(list.find((c) => c.id === c1.id)).toMatchObject({ shadowProductionScore: 90, shadowProductionCount: 2 });
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
      ['a diff type outside the four kinds', { samples: [sample('a', 1, { diffs: [{ type: 'whatever', severity: 'error' }] })] }],
      ['a bad severity', { samples: [sample('a', 1, { diffs: [{ type: 'status', severity: 'fatal' }] })] }],
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


describe('review fixes (PR A review: S1, S3, S5, S6, N2, N3)', () => {
  it('S1: the cap is per baseline, so 1000 placeholder samples do not stop a production sample being recorded', async () => {
    const { c1 } = seed();
    for (let i = 0; i < SHADOW_MAX_SAMPLES / 100; i++) await post(c1.id, many(100, 100, `p${i}`));
    expect((await post(c1.id, [sample('over', 0)])).json.data.capped).toBe(true);
    const prod = await post(c1.id, [sample('prod-1', 50, { baseline: 'production' })]);
    expect(prod.json.data).toMatchObject({ capped: false, sampleCount: SHADOW_MAX_SAMPLES + 1, productionCount: 1, productionAverageScore: 50 });
    expect(row(c1.id)).toMatchObject({ sample_count: SHADOW_MAX_SAMPLES + 1, production_count: 1, production_score_sum: 50 });
  });

  it('S1: production samples have their own cap', async () => {
    const { c1 } = seed();
    for (let i = 0; i < SHADOW_MAX_SAMPLES / 100; i++) await post(c1.id, many(100, 100, `q${i}`).map((x) => ({ ...x, baseline: 'production' })));
    const over = await post(c1.id, [sample('over', 0, { baseline: 'production' })]);
    expect(over.json.data).toMatchObject({ capped: true, productionCount: SHADOW_MAX_SAMPLES });
  });

  it('F1: a batch that mixes baselines across the placeholder cap records the production sample and reports capped', async () => {
    const { c1 } = seed();
    for (let i = 0; i < SHADOW_MAX_SAMPLES / 100; i++) await post(c1.id, many(100, 100, `m${i}`));
    const mixed = await post(c1.id, [sample('late-placeholder', 0), sample('prod', 70, { baseline: 'production' })]);
    expect(mixed.json.data).toMatchObject({ capped: true, sampleCount: SHADOW_MAX_SAMPLES + 1, productionCount: 1 });
    expect(row(c1.id)).toMatchObject({ sample_count: SHADOW_MAX_SAMPLES + 1, production_count: 1, production_score_sum: 70, last_request_id: 'prod' });
  });

  it('F2: non-numeric entries in a stored aggregate are dropped, so the next sample repairs it instead of concatenating strings', async () => {
    const { c1 } = seed();
    await post(c1.id, [sample('a', 100)]);
    store.raw.prepare("UPDATE shadow_scores SET diffs_json = ? WHERE candidate_id = ?").run('{"total":1,"byType":{"status":"x","body":2},"bySeverity":{"error":"y","info":1}}', c1.id);
    await post(c1.id, [sample('b', 100, { diffs: [{ type: 'status', severity: 'error' }] })]);
    expect(JSON.parse(String(row(c1.id)!.diffs_json))).toEqual({ total: 2, byType: { body: 2, status: 1 }, bySeverity: { error: 1, warning: 0, info: 1 } });
  });

  it('F3: a list of more than 100 candidates still finds a shadow row on the last one (the batched lookup is chunked)', async () => {
    const x = seed('big-org');
    const last = (() => {
      let c = x.c2;
      for (let i = 0; i < 105; i++) c = spec.createCandidate(x.spec.id, x.repo.id, sha(3), sha(0), actor);
      return c;
    })();
    await post(last.id, [sample('a', 100)]);
    const list = (await call('/api/candidates?limit=500')).json.data as any[];
    expect(list.length).toBeGreaterThan(105);
    expect(list.find((c) => c.id === last.id)).toMatchObject({ shadowScore: 100 });
    expect(list.filter((c) => c.shadowScore !== undefined)).toHaveLength(1);
  });

  it('flips fail to pass in place too', async () => {
    const { c1 } = seed();
    await post(c1.id, many(SHADOW_MIN_SAMPLES, 0));
    expect(verdictRows(c1.id)[0].status).toBe('fail');
    await post(c1.id, many(SHADOW_MIN_SAMPLES * 4, 100, 'hi'));
    const rows = verdictRows(c1.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pass');
  });

  it('the stored verdict score is floored, so a failing 79.6 is never recorded as the pass line', async () => {
    const { c1 } = seed();
    const scores = [...Array(18).fill(80), 76, 76]; // sum 1592, average 79.6
    await post(c1.id, scores.map((sc, i) => sample(`f${i}`, sc)));
    expect(verdictRows(c1.id)[0]).toMatchObject({ status: 'fail', score: 79 });
  });

  it('the score is rounded to two decimals', async () => {
    const { c1 } = seed();
    await post(c1.id, [sample('a', 100), sample('b', 100), sample('c', 0)]);
    expect((await call(`/api/candidates/${c1.id}`)).json.data.shadowScore).toBe(66.67);
  });

  it('S3: a list response carries each candidate its own shadow fields and none for a candidate with no row', async () => {
    const { c1, c2 } = seed();
    await post(c1.id, [sample('a', 100)]);
    const list = (await call('/api/candidates?limit=100')).json.data as any[];
    expect(list.find((c) => c.id === c1.id)).toMatchObject({ shadowScore: 100, shadowMatch: true });
    expect(list.find((c) => c.id === c2.id).shadowScore).toBeUndefined();
  });

  it('a corrupt diffs_json never makes a candidate a permanent 500: it reads as empty diffs and the next sample repairs it', async () => {
    const { c1 } = seed();
    await post(c1.id, [sample('a', 100)]);
    store.raw.prepare("UPDATE shadow_scores SET diffs_json = '{\"byType\":null}' WHERE candidate_id = ?").run(c1.id);
    const got = (await call(`/api/candidates/${c1.id}`)).json.data;
    expect(JSON.parse(got.shadowMetrics).aggregateDiffs).toEqual({ total: 0, byType: {}, bySeverity: { error: 0, warning: 0, info: 0 } });
    const again = await post(c1.id, [sample('b', 100, { diffs: [{ type: 'body', severity: 'warning' }] })]);
    expect(again.status).toBe(200);
    expect(JSON.parse(String(row(c1.id)!.diffs_json))).toMatchObject({ total: 1, byType: { body: 1 } });
    store.raw.prepare("UPDATE shadow_scores SET diffs_json = 'not json' WHERE candidate_id = ?").run(c1.id);
    expect((await call(`/api/candidates/${c1.id}`)).status).toBe(200);
  });

  it('N2: a malformed percent-escape in the candidate id is a 400, not a 500', async () => {
    const res = await call('/api/candidates/%E0%A4%A/shadow-samples', 'POST', { samples: [sample('a', 1)] });
    expect(res.status).toBe(400);
  });

  it('N3: keyed and unkeyed answers both carry a timestamp', async () => {
    const { c1 } = seed();
    expect(typeof (await post(c1.id, [sample('a', 1)])).json.timestamp).toBe('number');
    expect(typeof (await post(c1.id, [sample('b', 1)], { 'Idempotency-Key': 'k-ts' })).json.timestamp).toBe('number');
  });

  it('S6: the keyed path rolls back too: a failing verdict step leaves no samples, no actor and no idempotency key behind', async () => {
    const { c1 } = seed();
    store.raw.exec('DROP TABLE gate_verdicts');
    const key = { 'Idempotency-Key': `req-1:${c1.id}`, 'X-Actor-ID': SCIENTIST_COMPARATOR_ACTOR };
    const res = await post(c1.id, [sample('req-1', 100)], key);
    expect(res.status).toBe(500);
    expect(row(c1.id)).toBeUndefined();
    expect(store.raw.prepare('SELECT COUNT(*) AS n FROM actors WHERE id = ?').get(SCIENTIST_COMPARATOR_ACTOR)).toEqual({ n: 0 });
    expect(store.raw.prepare('SELECT COUNT(*) AS n FROM idempotency_keys').get()).toEqual({ n: 0 });
  });

  it("S6: the comparator's real request (keyed, header actor not yet an actor row) is accepted by the real Spec DO and parses against the zod schema", async () => {
    const { c1 } = seed();
    const bodies: any[] = [];
    const env = {
      SPEC_DO: {
        idFromName: () => 'main',
        get: () => ({
          fetch: async (input: Request) => {
            if (input.method === 'POST') bodies.push(await input.clone().json());
            return spec.fetch(input);
          },
        }),
      },
      SPEC_DO_INTERNAL_TOKEN: TEST_INTERNAL_TOKEN,
    };
    const client = new SpecDOClient(env as never);
    const result = {
      requestId: 'req-1', candidateId: c1.id, specId: '', path: '/x', method: 'GET', timestamp: 1, score: 90, matched: false, errors: 1, warnings: 0,
      diffs: [{ type: 'status', severity: 'error', message: 'status differs' }],
    } as unknown as CandidateComparisonResult;
    expect(store.raw.prepare('SELECT COUNT(*) AS n FROM actors WHERE id = ?').get(SCIENTIST_COMPARATOR_ACTOR)).toEqual({ n: 0 });
    expect(await client.postShadowSample(c1.id, result)).toBe('recorded');
    expect(ShadowSamplesRequestSchema.safeParse(bodies[0]).success).toBe(true);
    expect(row(c1.id)).toMatchObject({ sample_count: 1, score_sum: 90, production_count: 0 });
    // a redelivery replays
    expect(await client.postShadowSample(c1.id, result)).toBe('recorded');
    expect(row(c1.id)).toMatchObject({ sample_count: 1 });
    // an unknown candidate is the coded not_found
    expect(await client.postShadowSample('c-nope', result)).toBe('not_found');
    // a key over 255 characters is hashed, so a redelivery still replays
    const long = { ...result, requestId: 'r'.repeat(300) };
    expect(await client.postShadowSample(c1.id, long)).toBe('recorded');
    expect(await client.postShadowSample(c1.id, long)).toBe('recorded');
    expect(row(c1.id)).toMatchObject({ sample_count: 2 });
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

  it('replaying the step over a ledger that already has shadow_scores rows keeps them', async () => {
    const fresh = await freshLedger();
    fresh.raw
      .prepare("INSERT INTO shadow_scores (id, candidate_id, sample_count, score_sum, matched_count, diffs_json, last_request_id, updated_at) VALUES ('r1', 'c-1', 3, 270, 3, '{}', 'req', 5)")
      .run();
    fresh.raw.exec("UPDATE metadata SET value = 'm14' WHERE key = 'schema_version'");
    await makeSpecDo(fresh).init();
    expect(readVersion(fresh)).toBe(LATEST_VERSION);
    expect(fresh.raw.prepare('SELECT id, sample_count, score_sum FROM shadow_scores').all()).toEqual([{ id: 'r1', sample_count: 3, score_sum: 270 }]);
  });
});
