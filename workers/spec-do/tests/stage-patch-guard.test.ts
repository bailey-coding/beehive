/**
 * Stage PATCH integrity (wave-2a-plan part A): the candidate stage PATCH writes only `failed` and `rolled_back` (every other move goes through
 * `advance`), and every stage PATCH (candidate, spec, issue) answers 404 before any write for an unknown or tombstoned row and 400 for an
 * unknown stage. Real SQL (node:sqlite) through the real router.
 *
 * Task: wave-2a part A | Spec: docs/plans/wave-2a-plan.md part A; review b1-S1, a-S2
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SpecDO } from '../index';
import { makeSqliteState, makeSpecDo, type SqliteState } from './sqlite-state';
import { CANDIDATE_LADDER } from '../../shared/governance-state-machine';
import { SpecStageSchema, IssueStageSchema } from '../../shared/schemas';
import { SCHEMA_SQL } from '../schema-inline';

let store: SqliteState;
let spec: SpecDO;
let actor: string;

async function call(path: string, method = 'GET', body?: unknown) {
  const res = await spec.fetch(
    new Request(`https://spec-do.internal${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Actor-ID': actor },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
  return { status: res.status, json: (await res.json()) as any };
}

const row = (table: string, id: string) => store.raw.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, any> | undefined;
const historyCount = (type: string, id: string) =>
  (store.raw.prepare('SELECT COUNT(*) AS n FROM entity_history WHERE entity_type = ? AND entity_id = ?').get(type, id) as { n: number }).n;
const tombstone = (table: string, id: string) => store.raw.prepare(`UPDATE ${table} SET deleted_at = ? WHERE id = ?`).run(Date.now(), id);
const setStage = (id: string, stage: string) => store.raw.prepare('UPDATE candidates SET stage = ? WHERE id = ?').run(stage, id);

function seed() {
  const org = spec.createOrganization('stage-org', 'artifacts');
  const repo = spec.createRepository('stage-repo', org.id, 'baseline', undefined, undefined, 'https://example.invalid/r.git', 'stage-org');
  const s = spec.createSpec('stage-spec', 'd', 'contract', [], org.id, actor);
  const c = spec.createCandidate(s.id, repo.id, 'a'.repeat(40), 'b'.repeat(40), actor);
  const issue = spec.createIssue(undefined, repo.id, 'an issue', 'body', actor);
  return { org, repo, spec: s, c, issue };
}

beforeEach(async () => {
  store = makeSqliteState();
  spec = makeSpecDo(store);
  await spec.init();
  actor = spec.createActor('agent', 'stage-agent').id;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe('candidate stage PATCH: only failed and rolled_back', () => {
  it.fails('refuses an upward move with 409 use_advance and leaves the stage alone', async () => {
    const { c } = seed();
    const before = historyCount('candidate', c.id);
    const r = await call(`/api/candidates/${c.id}/stage`, 'PATCH', { stage: 'promoted' });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('use_advance');
    expect(row('candidates', c.id)!.stage).toBe('pending');
    expect(historyCount('candidate', c.id)).toBe(before);
  });

  it.fails('refuses a one-step forward move too (only advance checks evidence)', async () => {
    const { c } = seed();
    const r = await call(`/api/candidates/${c.id}/stage`, 'PATCH', { stage: 'passed_premerge' });
    expect(r.status).toBe(409);
    expect(row('candidates', c.id)!.stage).toBe('pending');
  });

  it.fails('refuses a backward ladder move', async () => {
    const { c } = seed();
    setStage(c.id, 'passed_train');
    const r = await call(`/api/candidates/${c.id}/stage`, 'PATCH', { stage: 'passed_shadow' });
    expect(r.status).toBe(409);
    expect(row('candidates', c.id)!.stage).toBe('passed_train');
  });

  it.each(CANDIDATE_LADDER)('still writes failed and rolled_back from %s (rule 7)', async (from) => {
    const { c } = seed();
    setStage(c.id, from);
    for (const to of ['failed', 'rolled_back'] as const) {
      setStage(c.id, from);
      const r = await call(`/api/candidates/${c.id}/stage`, 'PATCH', { stage: to });
      expect(r.status, `${from} -> ${to}`).toBe(200);
      expect(row('candidates', c.id)!.stage).toBe(to);
    }
  });

  it('answers 200 for the same stage (idempotent)', async () => {
    const { c } = seed();
    setStage(c.id, 'passed_shadow');
    expect((await call(`/api/candidates/${c.id}/stage`, 'PATCH', { stage: 'passed_shadow' })).status).toBe(200);
  });

  it.fails('answers 404 for a tombstoned candidate and does not write (today the write commits before the 404)', async () => {
    const { c } = seed();
    tombstone('candidates', c.id);
    const before = historyCount('candidate', c.id);
    const r = await call(`/api/candidates/${c.id}/stage`, 'PATCH', { stage: 'failed' });
    expect(r.status).toBe(404);
    expect(r.json.error).toBe('candidate_not_found');
    expect(row('candidates', c.id)!.stage).toBe('pending');
    expect(historyCount('candidate', c.id)).toBe(before);
  });

  it.fails('answers 404 for an unknown candidate and writes no history row', async () => {
    const r = await call('/api/candidates/nope/stage', 'PATCH', { stage: 'failed' });
    expect(r.status).toBe(404);
    expect(historyCount('candidate', 'nope')).toBe(0);
  });

  it.fails('answers 400 for an unknown stage', async () => {
    const { c } = seed();
    const r = await call(`/api/candidates/${c.id}/stage`, 'PATCH', { stage: 'shipped' });
    expect(r.status).toBe(400);
    expect(row('candidates', c.id)!.stage).toBe('pending');
  });
});

describe.each([
  { kind: 'spec', table: 'specs', path: 'specs', good: 'active', initial: 'draft' },
  { kind: 'issue', table: 'issues', path: 'issues', good: 'spec_needed', initial: 'reported' },
] as const)('$kind stage PATCH integrity', ({ kind, table, path, good, initial }) => {
  const idOf = (s: ReturnType<typeof seed>) => (kind === 'spec' ? s.spec.id : s.issue.id);

  it.fails('answers 404 for an unknown id and writes no history row', async () => {
    const r = await call(`/api/${path}/nope/stage`, 'PATCH', { stage: good });
    expect(r.status).toBe(404);
    expect(historyCount(kind, 'nope')).toBe(0);
  });

  it.fails('answers 404 for a tombstoned row and leaves its stage alone', async () => {
    const id = idOf(seed());
    tombstone(table, id);
    const before = historyCount(kind, id);
    const r = await call(`/api/${path}/${id}/stage`, 'PATCH', { stage: good });
    expect(r.status).toBe(404);
    expect(row(table, id)!.stage).toBe(initial);
    expect(historyCount(kind, id)).toBe(before);
  });

  it.fails('answers 400 for an unknown stage, not a 500 from the CHECK constraint', async () => {
    const id = idOf(seed());
    const r = await call(`/api/${path}/${id}/stage`, 'PATCH', { stage: 'nonsense' });
    expect(r.status).toBe(400);
    expect(row(table, id)!.stage).toBe(initial);
  });

  it('still writes a valid stage', async () => {
    const id = idOf(seed());
    const r = await call(`/api/${path}/${id}/stage`, 'PATCH', { stage: good });
    expect(r.status).toBe(200);
    expect(row(table, id)!.stage).toBe(good);
  });
});

describe('stage lists match the schema CHECK constraints', () => {
  const checkList = (table: string) => {
    const ddl = SCHEMA_SQL.slice(SCHEMA_SQL.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`));
    const m = /stage TEXT[^\n]*?CHECK\s*\(\s*stage IN \(([^)]*)\)/s.exec(ddl);
    return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
  };
  it('specs', () => expect(checkList('specs')).toEqual([...SpecStageSchema.options].sort()));
  it('issues', () => expect(checkList('issues')).toEqual([...IssueStageSchema.options].sort()));
});
