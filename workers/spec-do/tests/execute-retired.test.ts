/**
 * POST /api/candidates/:id/execute is retired (docs/plans/retire-execute-plan.md): the Spec DO answers 410 route_retired before
 * reading the body or the candidate, the same body for a known and an unknown id, and changes nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SpecDO } from '../index';
import { makeSqliteState, makeSpecDo, type SqliteState } from './sqlite-state';
import { ROUTE_RETIRED } from '../../shared/retired-route';

let store: SqliteState;
let spec: SpecDO;
let actor: string;

beforeEach(async () => {
  store = makeSqliteState();
  spec = makeSpecDo(store);
  await spec.init();
  actor = spec.createActor('human', 'maint').id;
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const post = (id: string, body?: string) =>
  spec.fetch(new Request(`https://spec-do.internal/api/candidates/${id}/execute`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Actor-ID': actor }, body,
  }));

const snapshot = () => JSON.stringify([
  store.raw.prepare('SELECT id, stage, commit_sha FROM candidates ORDER BY id').all(),
  store.raw.prepare('SELECT COUNT(*) AS n FROM entity_history').get(),
  store.raw.prepare('SELECT COUNT(*) AS n FROM governance_events').get(),
]);

describe('POST /api/candidates/:id/execute (retired)', () => {
  it('answers 410 route_retired for a known and an unknown candidate with the same body, and changes nothing, fetching nothing', async () => {
    const org = spec.createOrganization('ex-org', 'artifacts');
    const repo = spec.createRepository('ex-repo', org.id, 'baseline', undefined, undefined, 'https://example.invalid/r.git', 'ex-org');
    const s = spec.createSpec('ex-spec', 'd', 'contract', [], org.id, actor);
    const c = spec.createCandidate(s.id, repo.id, 'a'.repeat(40), 'b'.repeat(40), actor);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const before = snapshot();

    const known = await post(c.id, JSON.stringify({ sandboxRunnerUrl: 'https://attacker.invalid' }));
    const unknown = await post('no-such-candidate', JSON.stringify({}));
    expect(known.status).toBe(410);
    expect(unknown.status).toBe(410);
    const [a, b] = [await known.json() as Record<string, unknown>, await unknown.json() as Record<string, unknown>];
    expect(a).toMatchObject({ success: false, code: ROUTE_RETIRED });
    expect(String(a.error)).toContain('/gate/pre-merge');
    expect({ ...a, timestamp: 0 }).toEqual({ ...b, timestamp: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(snapshot()).toBe(before);
  });

  it('answers 410 with an empty or non-JSON body', async () => {
    expect((await post('x')).status).toBe(410);
    expect((await post('x', '{not json')).status).toBe(410);
  });
});
