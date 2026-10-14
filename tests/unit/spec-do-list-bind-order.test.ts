/**
 * Regression: filtered SpecDO list methods bound [limit, offset] before the
 * filter values, so the filter landed on the LIMIT placeholder and lists came
 * back empty. Runs real SQL (node:sqlite) through the real storage adapter.
 *
 * Task: do-bind-order | Spec: AGENTS.md#state-management
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { SpecDO } from '../../workers/spec-do/index';

// vite strips the `node:` prefix from sqlite; load via require instead.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = DatabaseSyncType;

function makeDO(): { spec: SpecDO; raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  const kv = new Map<string, unknown>();
  const state = {
    storage: {
      get: async (k: string) => kv.get(k),
      put: async (k: string, v: unknown) => void kv.set(k, v),
      sql: {
        exec(query: string, ...bindings: unknown[]) {
          if (bindings.length === 0 && /;\s*\S/.test(query.trim())) {
            raw.exec(query);
            return { next: () => ({ done: true as const }), columnNames: [] };
          }
          const stmt = raw.prepare(query);
          if (!/^\s*(select|pragma)/i.test(query)) {
            stmt.run(...(bindings as never[]));
            return { next: () => ({ done: true as const }), columnNames: [] };
          }
          const rows = stmt.all(...(bindings as never[])) as Record<string, unknown>[];
          let i = 0;
          return {
            next: () => (i < rows.length ? { value: rows[i++] } : { done: true as const }),
            columnNames: stmt.columns().map((c) => c.name),
          };
        },
      },
    },
  };
  const spec = new SpecDO(state as never, {} as never);
  return { spec, raw };
}

let spec: SpecDO;
let raw: DatabaseSync;

beforeEach(async () => {
  ({ spec, raw } = makeDO());
  await spec.init();
});

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();
const setStage = (table: string, id: string, stage: string) =>
  raw.prepare(`UPDATE ${table} SET stage = ? WHERE id = ?`).run(stage, id);

describe('listSpecs bind order', () => {
  it('filters by org, by org+stage, and unfiltered', () => {
    const a1 = spec.createSpec('a1', '', '{}', [], 'org-a', 'u');
    const a2 = spec.createSpec('a2', '', '{}', [], 'org-a', 'u');
    const b1 = spec.createSpec('b1', '', '{}', [], 'org-b', 'u');
    setStage('specs', a2.id, 'active');
    expect(ids(spec.listSpecs(10, 0))).toEqual(ids([a1, a2, b1]));
    expect(ids(spec.listSpecs(10, 0, 'org-a'))).toEqual(ids([a1, a2]));
    expect(ids(spec.listSpecs(10, 0, 'org-a', 'active'))).toEqual([a2.id]);
    expect(ids(spec.listSpecs(10, 0, undefined, 'draft'))).toEqual(ids([a1, b1]));
    expect(spec.listSpecs(1, 0, 'org-a')).toHaveLength(1);
    expect(spec.listSpecs(10, 5, 'org-a')).toHaveLength(0);
  });
});

describe('listCandidates bind order', () => {
  it('filters by spec, spec+agent+stage, and unfiltered', () => {
    const c1 = spec.createCandidate('s1', 'r', 'sha1', 'base', 'ag1');
    const c2 = spec.createCandidate('s1', 'r', 'sha2', 'base', 'ag2');
    const c3 = spec.createCandidate('s2', 'r', 'sha3', 'base', 'ag1');
    setStage('candidates', c2.id, 'failed');
    expect(ids(spec.listCandidates(10, 0))).toEqual(ids([c1, c2, c3]));
    expect(ids(spec.listCandidates(10, 0, 's1'))).toEqual(ids([c1, c2]));
    expect(ids(spec.listCandidates(10, 0, 's1', 'ag2'))).toEqual([c2.id]);
    expect(ids(spec.listCandidates(10, 0, 's1', 'ag2', 'failed'))).toEqual([c2.id]);
    expect(ids(spec.listCandidates(10, 0, undefined, 'ag1'))).toEqual(ids([c1, c3]));
  });
});

describe('listGateVerdicts bind order', () => {
  it('filters by candidate, candidate+gate+status, and unfiltered', () => {
    const v1 = spec.createGateVerdict('c1', 'pre-merge', 'pass', 1, 0, 'u');
    const v2 = spec.createGateVerdict('c1', 'shadow', 'fail', 1, 0, 'u');
    const v3 = spec.createGateVerdict('c2', 'pre-merge', 'pass', 1, 0, 'u');
    expect(ids(spec.listGateVerdicts(10, 0))).toEqual(ids([v1, v2, v3]));
    expect(ids(spec.listGateVerdicts(10, 0, 'c1'))).toEqual(ids([v1, v2]));
    expect(ids(spec.listGateVerdicts(10, 0, 'c1', 'shadow', 'fail'))).toEqual([v2.id]);
    expect(ids(spec.listGateVerdicts(10, 0, undefined, 'pre-merge'))).toEqual(ids([v1, v3]));
  });
});

describe('listTrials bind order', () => {
  it('filters by spec, spec+stage, and unfiltered', () => {
    // createTrial() inserts NULL into trials.decided_at (NOT NULL) - separate bug; seed directly.
    const seed = (id: string, specId: string) => {
      raw
        .prepare(
          `INSERT INTO trials (id, spec_id, candidate_a_id, candidate_b_id, comparison_metrics, decided_at, decided_by)
           VALUES (?, ?, 'a', 'b', '{}', ?, 'u')`
        )
        .run(id, specId, Date.now());
      return { id };
    };
    const t1 = seed('t1', 's1');
    const t2 = seed('t2', 's1');
    const t3 = seed('t3', 's2');
    setStage('trials', t2.id, 'decided');
    expect(ids(spec.listTrials(10, 0))).toEqual(ids([t1, t2, t3]));
    expect(ids(spec.listTrials(10, 0, 's1'))).toEqual(ids([t1, t2]));
    expect(ids(spec.listTrials(10, 0, 's1', 'decided'))).toEqual([t2.id]);
  });
});

describe('listPromotions bind order', () => {
  it('filters by candidate and unfiltered', () => {
    const p1 = spec.createPromotion('c1', 'pre-merge', 'shadow', 'u');
    const p2 = spec.createPromotion('c2', 'pre-merge', 'shadow', 'u');
    expect(ids(spec.listPromotions(10, 0))).toEqual(ids([p1, p2]));
    expect(ids(spec.listPromotions(10, 0, 'c1'))).toEqual([p1.id]);
    expect(spec.listPromotions(10, 0, 'nope')).toEqual([]);
  });
});

describe('listIssues bind order', () => {
  it('filters by repo, repo+stage+status, and unfiltered', () => {
    const i1 = spec.createIssue(1, 'r1', 't', 'b', 'u');
    const i2 = spec.createIssue(2, 'r1', 't', 'b', 'u');
    const i3 = spec.createIssue(1, 'r2', 't', 'b', 'u');
    setStage('issues', i2.id, 'implementing');
    raw.prepare(`UPDATE issues SET status = 'closed' WHERE id = ?`).run(i2.id);
    expect(ids(spec.listIssues(10, 0))).toEqual(ids([i1, i2, i3]));
    expect(ids(spec.listIssues(10, 0, 'r1'))).toEqual(ids([i1, i2]));
    expect(ids(spec.listIssues(10, 0, 'r1', 'implementing', 'closed'))).toEqual([i2.id]);
    expect(ids(spec.listIssues(10, 0, undefined, undefined, 'open'))).toEqual(ids([i1, i3]));
  });
});
