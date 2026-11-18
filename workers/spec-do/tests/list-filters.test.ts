/**
 * Opt-in list filters (docs/plans/wave-1-plan.md part D, review b2 S3): GET /api/repositories?namespace=&name= finds any row, not just the
 * newest 100; one of the two alone is ignored; GET /api/candidates?repositoryId= narrows to one repository.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeSqliteState, makeSpecDo, type SqliteState } from './sqlite-state';
import type { SpecDO } from '../index';

let store: SqliteState;
let spec: SpecDO;
let orgId: string;

beforeEach(async () => {
  store = makeSqliteState();
  spec = makeSpecDo(store);
  await spec.init();
  orgId = spec.createOrganization('acme', 'artifacts').id;
});

const get = async (path: string) => {
  const res = await spec.fetch(new Request(`https://spec-do.internal${path}`));
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Array<Record<string, unknown>> }).data;
};

describe('GET /api/repositories namespace + name', () => {
  beforeEach(() => {
    for (let i = 0; i < 101; i++) {
      spec.createRepository(`repo-${i}`, orgId, 'candidate', undefined, undefined, `https://x/git/acme/repo-${i}.git`, 'acme');
      store.raw.prepare('UPDATE repositories SET created_at = ? WHERE name = ?').run(1_000 + i, `repo-${i}`);
    }
  });

  it('finds the oldest of 101 rows, which an unfiltered limit=100 page misses', async () => {
    expect((await get('/api/repositories?limit=100')).some((r) => r.name === 'repo-0')).toBe(false);
    const rows = await get('/api/repositories?limit=100&namespace=acme&name=repo-0');
    expect(rows.map((r) => r.name)).toEqual(['repo-0']);
  });

  it('matches namespace and name together', async () => {
    expect(await get('/api/repositories?limit=100&namespace=other&name=repo-0')).toEqual([]);
  });

  it.each([['namespace=acme'], ['name=repo-0']])('ignores one parameter alone (%s): the usual first page', async (q) => {
    expect(await get(`/api/repositories?limit=100&${q}`)).toHaveLength(100);
  });
});

describe('GET /api/candidates repositoryId', () => {
  it('narrows to the candidates of one repository', async () => {
    const agent = spec.createActor('agent', 'a').id;
    const s = spec.createSpec('s', 'd', '{}', [], orgId, agent);
    const r1 = spec.createRepository('r1', orgId, 'candidate', undefined, undefined, 'https://x/git/acme/r1.git', 'acme');
    const r2 = spec.createRepository('r2', orgId, 'candidate', undefined, undefined, 'https://x/git/acme/r2.git', 'acme');
    const c1 = spec.createCandidate(s.id, r1.id, 'a'.repeat(40), 'base', agent).id;
    spec.createCandidate(s.id, r2.id, 'b'.repeat(40), 'base', agent);
    expect((await get(`/api/candidates?limit=100&repositoryId=${r1.id}`)).map((c) => c.id)).toEqual([c1]);
    expect(await get('/api/candidates?limit=100')).toHaveLength(2);
  });
});
