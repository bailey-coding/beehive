/**
 * Issue wire shape: every issue response carries the camelCase names IssueResponse documents AND
 * the legacy snake_case row fields (additive, so a mixed-version deploy keeps working).
 *
 * Task: FOCUS drift 'created_by vs createdBy' | Spec: workers/api/types.ts IssueResponse
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SpecDO } from '../index';
import { makeSqliteState, makeSpecDo, type SqliteState } from './sqlite-state';

let store: SqliteState;
let spec: SpecDO;
let actor: string;
let repo: string;

const call = (path: string, method = 'GET', body?: unknown) =>
  spec.fetch(
    new Request(`https://spec-do.internal${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Actor-ID': actor },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
const data = async (res: Response) => ((await res.json()) as { data: any }).data;

beforeEach(async () => {
  store = makeSqliteState();
  spec = makeSpecDo(store);
  await spec.init();
  actor = spec.createActor('human', 'alice').id;
  store.raw.prepare(`UPDATE actors SET role = 'maintainer' WHERE id = ?`).run(actor);
  const org = spec.createOrganization('acme', 'artifacts');
  repo = spec.createRepository('a', org.id, 'baseline', undefined, undefined, 'https://example.invalid/a.git', 'ns').id;
});

function expectBothShapes(i: any) {
  expect(i.createdBy).toBe(actor);
  expect(i.created_by).toBe(actor);
  expect(i.repositoryId).toBe(repo);
  expect(i.repository_id).toBe(repo);
  expect(i.createdAt).toBe(i.created_at);
  expect(i.commentPolicy).toBe(i.comment_policy);
  expect(typeof i.createdAt).toBe('number');
}

describe('issue responses carry both naming styles', () => {
  it('create, get, list, stage, status and comment-policy', async () => {
    const created = await data(await call('/api/issues', 'POST', { repositoryId: repo, title: 't', createdBy: actor }));
    expectBothShapes(created);
    expectBothShapes(await data(await call(`/api/issues/${created.id}`)));
    const list = await data(await call(`/api/issues?repositoryId=${repo}`));
    expect(list).toHaveLength(1);
    expectBothShapes(list[0]);
    expectBothShapes(await data(await call(`/api/issues/${created.id}/stage`, 'PATCH', { stage: 'spec_needed' })));
    const closed = await data(await call(`/api/issues/${created.id}/status`, 'PATCH', { status: 'closed' }));
    expectBothShapes(closed);
    expect(closed.closedBy).toBe(actor);
    expect(closed.closed_by).toBe(actor);
    const policy = await data(await call(`/api/issues/${created.id}/comment-policy`, 'PATCH', { commentPolicy: 'locked' }));
    expect(policy.commentPolicy).toBe('locked');
    expect(policy.comment_policy).toBe('locked');
  });

  it('a missing issue is still 404', async () => {
    expect((await call('/api/issues/nope')).status).toBe(404);
  });
});
