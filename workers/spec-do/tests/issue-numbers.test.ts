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

  it('20 parallel creates get 20 distinct numbers (the handler is synchronous after request.json(), so this does not by itself prove the transaction)', async () => {
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

  it('accepts the largest allowed number (2^31-1) and the next auto number is distinct', async () => {
    expect((await created(await create({ repositoryId: repoA, title: 'max', number: 2_147_483_647 }))).number).toBe(2_147_483_647);
    expect((await created(await create({ repositoryId: repoA, title: 'next' }))).number).toBe(2_147_483_648);
    expect((await created(await create({ repositoryId: repoA, title: 'after' }))).number).toBe(2_147_483_649);
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

  it.each([0, -1, 1.5, '3', 'x', 1e300, 2 ** 53, 2_147_483_648])('rejects number %s with 400', async (number) => {
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

  it('a failure after the number is read and the row inserted leaves nothing behind; the next create reuses that number', async () => {
    // Every third history write fails, i.e. after the number was read and the issue inserted
    const real = SpecDO.prototype.recordHistory;
    let calls = 0;
    vi.spyOn(SpecDO.prototype, 'recordHistory').mockImplementation(function (this: SpecDO, ...args: Parameters<SpecDO['recordHistory']>) {
      if (++calls % 3 === 0) throw new Error('history down');
      return real.apply(this, args);
    });
    const statuses = await Promise.all(Array.from({ length: 9 }, (_, i) => create({ repositoryId: repoA, title: `f${i}` }).then((r) => r.status)));
    expect(statuses.filter((s) => s === 500)).toHaveLength(3);
    const numbers = (store.raw.prepare('SELECT number FROM issues WHERE repository_id = ? ORDER BY number').all(repoA) as { number: number }[]).map((r) => r.number);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6]); // no orphan rows, no gaps
    const histories = (store.raw.prepare(`SELECT COUNT(*) AS n FROM entity_history WHERE entity_type = 'issue'`).get() as { n: number }).n;
    expect(histories).toBe(6);
    vi.restoreAllMocks();
    expect((await created(await create({ repositoryId: repoA, title: 'next' }))).number).toBe(7);
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

describe('malformed create requests are 400 with a fixed message, never a 500 with SQLite text', () => {
  const raw = (body: string) =>
    spec.fetch(new Request('https://spec-do.internal/api/issues', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Actor-ID': actor }, body }));

  it.each([
    ['no title', { repositoryId: 'x' }],
    ['non-string title', { repositoryId: 'x', title: 5 }],
    ['blank title', { repositoryId: 'x', title: '  ' }],
    ['no repositoryId', { title: 't' }],
    ['non-string body', { repositoryId: 'x', title: 't', body: 5 }],
    ['bad labels', { repositoryId: 'x', title: 't', labels: [1] }],
  ])('%s', async (_name, payload) => {
    const res = await create(payload);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).not.toMatch(/sqlite|parameter/i);
  });

  it.each([['invalid JSON', '{nope'], ['null', 'null'], ['array', '[]'], ['string', '"x"'], ['empty', '']])('%s body', async (_name, text) => {
    const res = await raw(text);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { success: boolean }).success).toBe(false);
  });

  it('an unknown actor still gets 403 before the body is read', async () => {
    const res = await spec.fetch(
      new Request('https://spec-do.internal/api/issues', { method: 'POST', headers: { 'X-Actor-ID': 'nobody' }, body: '{nope' })
    );
    expect(res.status).toBe(403);
  });
});
