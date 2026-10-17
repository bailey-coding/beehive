/**
 * Issue numbering (M8 D1): optional number, atomic per-repository assignment, explicit 4xx.
 * Real SQL (node:sqlite, FKs on) through the real router.
 *
 * Task: D1 | Spec: docs/M8-UI-ISSUES-PLAN.md#4
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SpecDO } from '../index';
import { makeSqliteState, makeSpecDo, type SqliteState } from './sqlite-state';

let store: SqliteState;
let spec: SpecDO;
let actor: string;
let repoA: string;
let repoB: string;

function create(body: Record<string, unknown>, actorId: string | null = actor): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (actorId) headers['X-Actor-ID'] = actorId;
  return spec.fetch(new Request('https://spec-do.internal/api/issues', { method: 'POST', headers, body: JSON.stringify(body) }));
}

async function created(res: Response): Promise<{ id: string; number: number; created_by: string }> {
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { id: string; number: number; created_by: string } }).data;
}

const issueCount = (repo: string) =>
  (store.raw.prepare('SELECT COUNT(*) AS n FROM issues WHERE repository_id = ?').get(repo) as { n: number }).n;

beforeEach(async () => {
  store = makeSqliteState();
  spec = makeSpecDo(store);
  await spec.init();
  actor = spec.createActor('human', 'alice').id;
  const org = spec.createOrganization('acme', 'artifacts');
  repoA = spec.createRepository('a', org.id, 'baseline', undefined, undefined, 'https://example.invalid/a.git', 'ns').id;
  repoB = spec.createRepository('b', org.id, 'baseline', undefined, undefined, 'https://example.invalid/b.git', 'ns').id;
});

afterEach(() => vi.restoreAllMocks());

describe('D1 issue numbering', () => {
  it('assigns 1, 2, 3 per repository with independent counters', async () => {
    const nums = [];
    for (let i = 0; i < 3; i++) nums.push((await created(await create({ repositoryId: repoA, title: `t${i}` }))).number);
    expect(nums).toEqual([1, 2, 3]);
    expect((await created(await create({ repositoryId: repoB, title: 'b' }))).number).toBe(1);
  });

  it('never reuses the number of a tombstoned issue', async () => {
    await created(await create({ repositoryId: repoA, title: 'one' }));
    const two = await created(await create({ repositoryId: repoA, title: 'two' }));
    store.raw.prepare('UPDATE issues SET deleted_at = ? WHERE id = ?').run(Date.now(), two.id);
    expect((await created(await create({ repositoryId: repoA, title: 'three' }))).number).toBe(3);
  });

  it('20 parallel creates get 20 distinct numbers', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => create({ repositoryId: repoA, title: `p${i}` }).then(created))
    );
    expect(new Set(results.map((r) => r.number)).size).toBe(20);
    expect(Math.max(...results.map((r) => r.number))).toBe(20);
    expect(issueCount(repoA)).toBe(20);
  });

  it('honours a free explicit number, then continues after it', async () => {
    expect((await created(await create({ repositoryId: repoA, title: 'x', number: 7 }))).number).toBe(7);
    expect((await created(await create({ repositoryId: repoA, title: 'y' }))).number).toBe(8);
  });

  it('answers an explicit duplicate with 409 and writes no row', async () => {
    await created(await create({ repositoryId: repoA, title: 'x', number: 4 }));
    expect((await create({ repositoryId: repoA, title: 'dup', number: 4 })).status).toBe(409);
    expect(issueCount(repoA)).toBe(1);
  });

  it('counts a tombstoned issue as a duplicate for an explicit number', async () => {
    const first = await created(await create({ repositoryId: repoA, title: 'x', number: 2 }));
    store.raw.prepare('UPDATE issues SET deleted_at = ? WHERE id = ?').run(Date.now(), first.id);
    expect((await create({ repositoryId: repoA, title: 'again', number: 2 })).status).toBe(409);
  });

  it.each([0, -1, 1.5, '3', 'x'])('rejects number %s with 400', async (number) => {
    expect((await create({ repositoryId: repoA, title: 'bad', number })).status).toBe(400);
    expect(issueCount(repoA)).toBe(0);
  });

  it('rejects an unknown repository with 404 and a tombstoned one with 409', async () => {
    expect((await create({ repositoryId: 'no-such-repo', title: 'x' })).status).toBe(404);
    store.raw.prepare('UPDATE repositories SET deleted_at = ? WHERE id = ?').run(Date.now(), repoB);
    expect((await create({ repositoryId: repoB, title: 'x' })).status).toBe(409);
    expect(issueCount(repoB)).toBe(0);
  });

  it('rolls the insert back when the history write fails', async () => {
    vi.spyOn(SpecDO.prototype, 'recordHistory').mockImplementation(() => {
      throw new Error('history down');
    });
    const res = await create({ repositoryId: repoA, title: 'x' });
    expect(res.status).toBe(500);
    expect(issueCount(repoA)).toBe(0);
    vi.restoreAllMocks();
    expect((await created(await create({ repositoryId: repoA, title: 'again' }))).number).toBe(1);
  });

  it('takes the author from the header actor', async () => {
    expect((await created(await create({ repositoryId: repoA, title: 'x' }))).created_by).toBe(actor);
    expect((await created(await create({ repositoryId: repoA, title: 'y', createdBy: actor }))).created_by).toBe(actor);
  });

  it('refuses a body createdBy that differs from the header actor with 403', async () => {
    const other = spec.createActor('human', 'bob').id;
    expect((await create({ repositoryId: repoA, title: 'x', createdBy: other })).status).toBe(403);
    expect(issueCount(repoA)).toBe(0);
  });
});
