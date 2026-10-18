/**
 * GET /api/actors?github_user_id= (M12 T0): the filter narrows the list, the order stays newest first
 * (so the first row is the newest duplicate, as the unfiltered list gave), and no filter is today's list.
 *
 * Task: T0 | Spec: docs/M12-IMPL-PLAN.md
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SpecDO } from '../index';
import { makeSqliteState, makeSpecDo, type SqliteState } from './sqlite-state';

let store: SqliteState;
let spec: SpecDO;

async function list(query = ''): Promise<{ id: string; github_user_id?: string }[]> {
  const res = await spec.fetch(new Request(`https://spec-do.internal/api/actors${query}`));
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { id: string; github_user_id?: string }[] }).data;
}

function actorAt(name: string, githubUserId: string | undefined, createdAt: number): string {
  const id = spec.createActor('human', name, githubUserId).id;
  store.raw.prepare('UPDATE actors SET created_at = ? WHERE id = ?').run(createdAt, id);
  return id;
}

beforeEach(async () => {
  store = makeSqliteState();
  spec = makeSpecDo(store);
  await spec.init();
});

describe('GET /api/actors github_user_id filter', () => {
  it('returns only the rows with that GitHub id, newest first', async () => {
    const oldest = actorAt('a', '42', 100);
    actorAt('b', '7', 200);
    const newest = actorAt('a-again', '42', 300);
    expect((await list('?github_user_id=42')).map((a) => a.id)).toEqual([newest, oldest]);
    expect((await list('?github_user_id=7')).map((a) => a.github_user_id)).toEqual(['7']);
  });

  it('finds a row that is past the first 500 of the unfiltered list', async () => {
    const target = actorAt('target', '999', 1);
    for (let i = 0; i < 500; i++) actorAt(`u${i}`, `g${i}`, 1000 + i);
    expect((await list('?limit=500&offset=0')).map((a) => a.id)).not.toContain(target);
    expect((await list('?github_user_id=999&limit=500&offset=0')).map((a) => a.id)).toEqual([target]);
  });

  it('an unknown or empty GitHub id gives an empty list, never the unfiltered one', async () => {
    actorAt('a', '42', 100);
    actorAt('agent', undefined, 200);
    expect(await list('?github_user_id=nope')).toEqual([]);
    expect(await list('?github_user_id=')).toEqual([]);
  });

  it('without the filter the list is unchanged: every actor, newest first', async () => {
    const a = actorAt('a', '42', 100);
    const b = actorAt('b', undefined, 200);
    expect((await list('?limit=50&offset=0')).map((x) => x.id)).toEqual([b, a]);
  });
});
