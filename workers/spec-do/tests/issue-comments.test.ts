/**
 * Issue comment rules and comment-policy authorisation (M8 D2). Exact statuses, never 500.
 * Real SQL (node:sqlite, FKs on) through the real router.
 *
 * Task: D2 | Spec: docs/M8-UI-ISSUES-PLAN.md#4 and #15
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SpecDO } from '../index';
import { generateServiceToken, hashToken, tokenPrefix } from '../../shared/service-tokens';
import { makeSqliteState, makeSpecDo, type SqliteState } from './sqlite-state';

let store: SqliteState;
let spec: SpecDO;
let maintainer: string;
let user: string;
let serviceActor: string;
let issueId: string;

function call(path: string, method: string, body?: unknown, actorId?: string): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (actorId) headers['X-Actor-ID'] = actorId;
  return spec.fetch(
    new Request(`https://spec-do.internal${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  );
}

const comment = (body: unknown, actorId?: string, extra: Record<string, unknown> = {}, id = issueId) =>
  call(`/api/issues/${id}/comments`, 'POST', { body, ...extra }, actorId);
const setPolicy = (commentPolicy: unknown, actorId?: string, id = issueId) =>
  call(`/api/issues/${id}/comment-policy`, 'PATCH', { commentPolicy }, actorId);

const commentCount = () => (store.raw.prepare('SELECT COUNT(*) AS n FROM issue_comments').get() as { n: number }).n;
const policy = () => (store.raw.prepare('SELECT comment_policy AS p FROM issues WHERE id = ?').get(issueId) as { p: string }).p;

beforeEach(async () => {
  store = makeSqliteState();
  spec = makeSpecDo(store);
  await spec.init();
  maintainer = spec.createActor('human', 'maint').id;
  user = spec.createActor('human', 'user').id;
  store.raw.prepare(`UPDATE actors SET role = 'maintainer' WHERE id = ?`).run(maintainer);
  const org = spec.createOrganization('acme', 'artifacts');
  const repo = spec.createRepository('r', org.id, 'baseline', undefined, undefined, 'https://example.invalid/r.git', 'ns');
  issueId = spec.createIssue(undefined, repo.id, 'bug', 'body', user).id;
  // A service account's actor, even if it was somehow given the maintainer role, is never one
  const plaintext = generateServiceToken();
  const account = spec.createServiceAccount({
    name: 'svc',
    scopes: ['read'],
    createdBy: maintainer,
    tokenHash: await hashToken(plaintext),
    tokenPrefix: tokenPrefix(plaintext),
    expiresAt: Date.now() + 86_400_000,
  }).account;
  serviceActor = (account.actorId ?? account.actor_id) as string;
  store.raw.prepare(`UPDATE actors SET role = 'maintainer' WHERE id = ?`).run(serviceActor);
});

afterEach(() => vi.restoreAllMocks());

describe('D2 comment-policy PATCH', () => {
  it('lets a maintainer set every valid value', async () => {
    for (const p of ['maintainers_only', 'locked', 'open']) {
      expect((await setPolicy(p, maintainer)).status).toBe(200);
      expect(policy()).toBe(p);
    }
  });

  it('refuses a non-maintainer and a service actor with 403, leaving the policy alone', async () => {
    expect((await setPolicy('locked', user)).status).toBe(403);
    expect((await setPolicy('locked', serviceActor)).status).toBe(403);
    expect((await setPolicy('locked')).status).toBe(403);
    expect(policy()).toBe('open');
  });

  it('answers a bad value with 400 and an unknown or tombstoned issue with 404', async () => {
    expect((await setPolicy('closed', maintainer)).status).toBe(400);
    expect((await setPolicy(undefined, maintainer)).status).toBe(400);
    expect((await setPolicy('locked', maintainer, 'no-such-issue')).status).toBe(404);
    store.raw.prepare('UPDATE issues SET deleted_at = ? WHERE id = ?').run(Date.now(), issueId);
    expect((await setPolicy('locked', maintainer)).status).toBe(404);
  });
});

describe('D2 comments', () => {
  it('accepts an open issue and records the header actor as author', async () => {
    const res = await comment('hello', user);
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: { createdBy: string } }).data.createdBy).toBe(user);
  });

  it('locked: a maintainer may comment, anyone else gets 403', async () => {
    await setPolicy('locked', maintainer);
    expect((await comment('from maintainer', maintainer)).status).toBe(201);
    expect((await comment('from user', user)).status).toBe(403);
    expect((await comment('from service', serviceActor)).status).toBe(403);
    expect(commentCount()).toBe(1);
  });

  it('maintainers_only splits the same way', async () => {
    await setPolicy('maintainers_only', maintainer);
    expect((await comment('m', maintainer)).status).toBe(201);
    expect((await comment('u', user)).status).toBe(403);
  });

  it('a closed issue still accepts comments', async () => {
    store.raw.prepare(`UPDATE issues SET status = 'closed' WHERE id = ?`).run(issueId);
    expect((await comment('after close', user)).status).toBe(201);
  });

  it('answers a tombstoned or unknown issue with 404', async () => {
    store.raw.prepare('UPDATE issues SET deleted_at = ? WHERE id = ?').run(Date.now(), issueId);
    expect((await comment('x', user)).status).toBe(404);
    expect((await comment('x', user, {}, 'no-such-issue')).status).toBe(404);
    expect(commentCount()).toBe(0);
  });

  it.each([['empty', ''], ['whitespace', '   '], ['non-string', 42], ['missing', undefined], ['oversize', 'x'.repeat(10_001)]])(
    'rejects a %s body with 400',
    async (_name, body) => {
      expect((await comment(body, user)).status).toBe(400);
      expect(commentCount()).toBe(0);
    }
  );

  it('accepts exactly 10,000 characters', async () => {
    expect((await comment('x'.repeat(10_000), user)).status).toBe(201);
  });

  it('refuses a body createdBy that differs from the header actor with 403, accepts a matching one', async () => {
    expect((await comment('x', user, { createdBy: maintainer })).status).toBe(403);
    expect((await comment('x', user, { createdBy: user })).status).toBe(201);
    expect(commentCount()).toBe(1);
  });
});

describe('D3 PATCH /api/issues/:id/status', () => {
  const setStatus = (status: unknown, actorId?: string, id = issueId) =>
    call(`/api/issues/${id}/status`, 'PATCH', { status }, actorId);
  const row = () =>
    store.raw.prepare('SELECT status, closed_at, closed_by, stage FROM issues WHERE id = ?').get(issueId) as {
      status: string;
      closed_at: number | null;
      closed_by: string | null;
      stage: string;
    };
  const history = () =>
    store.raw.prepare(`SELECT stage, changed_by, notes FROM entity_history WHERE entity_id = ? AND notes LIKE 'Issue %' ORDER BY changed_at, rowid`).all(
      issueId
    ) as { stage: string; changed_by: string; notes: string }[];

  it('lets the creator close and reopen; reopen clears closed_at and closed_by', async () => {
    expect((await setStatus('closed', user)).status).toBe(200);
    expect(row()).toMatchObject({ status: 'closed', closed_by: user, stage: 'reported' });
    expect(row().closed_at).toBeGreaterThan(0);
    expect((await setStatus('open', user)).status).toBe(200);
    expect(row()).toMatchObject({ status: 'open', closed_at: null, closed_by: null, stage: 'reported' });
    expect(history().map((h) => [h.notes, h.stage, h.changed_by])).toEqual([
      ['Issue created', 'reported', user],
      ['Issue closed', 'reported', user],
      ['Issue reopened', 'reported', user],
    ]);
  });

  it('lets a maintainer close an issue they did not create', async () => {
    expect((await setStatus('closed', maintainer)).status).toBe(200);
    expect(row().closed_by).toBe(maintainer);
  });

  it('refuses another actor, a service actor and a missing actor with 403', async () => {
    const other = spec.createActor('human', 'other').id;
    for (const who of [other, serviceActor, undefined]) expect((await setStatus('closed', who)).status).toBe(403);
    expect(row().status).toBe('open');
  });

  it('is idempotent: the same status again is 200 and adds no history', async () => {
    await setStatus('closed', user);
    const before = history().length;
    const closedAt = row().closed_at;
    expect((await setStatus('closed', user)).status).toBe(200);
    expect(history().length).toBe(before);
    expect(row().closed_at).toBe(closedAt);
  });

  it('answers a bad value with 400 and an unknown or tombstoned issue with 404', async () => {
    expect((await setStatus('merged', user)).status).toBe(400);
    expect((await setStatus(undefined, user)).status).toBe(400);
    expect((await setStatus('closed', user, 'no-such-issue')).status).toBe(404);
    store.raw.prepare('UPDATE issues SET deleted_at = ? WHERE id = ?').run(Date.now(), issueId);
    expect((await setStatus('closed', user)).status).toBe(404);
  });
});
