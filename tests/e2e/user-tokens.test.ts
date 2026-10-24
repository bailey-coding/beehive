/**
 * User tokens E2E (local only, M12): mint with the master admin route; an issue created with
 * a spoofed X-Actor-ID is attributed to the token's actor (the M12 exit criterion); a
 * read_write token of a maintainer cannot close another actor's issue while a maintainer token
 * can; read tokens cannot write; candidate stage is denied (B1); revoke, then 401.
 *
 * Needs the beehive worker on :8787 (scripts/start-e2e-workers.sh). Never runs against
 * production: it mints real credentials and grants a real maintainer role.
 *
 * Task: T6 | Spec: docs/M12-IMPL-PLAN.md §2 T6
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getConfig } from './config';
import { createRequest, ensureMaintainer, readJson } from './helpers';

const config = getConfig();
const isLocal = config.environment === 'local';

async function master(path: string, method = 'GET', body?: unknown, actorId?: string) {
  const res = await fetch(createRequest(path, method, body, actorId ? { 'X-Actor-ID': actorId } : {}));
  return { status: res.status, headers: res.headers, json: (await readJson(res).catch(() => ({}))) as any };
}

async function asUser(token: string, path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(new URL(path, config.baseUrl), {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}

describe.skipIf(!isLocal)('User tokens (local)', () => {
  const run = Date.now();
  let alice: string;
  let maint: string;
  let repoId: string;
  const mint = async (actorId: string, scope: string) => {
    const res = await master('/api/admin/user-tokens', 'POST', { actorId, name: `e2e-${scope}`, scope, expiresInDays: 1 });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    return res.json.data.token as { id: string; plaintext: string };
  };

  beforeAll(async () => {
    const granter = await ensureMaintainer(master, 'e2e-maintainer');
    // User tokens need a human actor with a GitHub id
    alice = (await master('/api/actors', 'POST', { type: 'human', name: `e2e-alice-${run}`, githubUserId: `e2e-${run}-a` })).json.data.id;
    maint = (await master('/api/actors', 'POST', { type: 'human', name: `e2e-maint-${run}`, githubUserId: `e2e-${run}-m` })).json.data.id;
    expect((await master(`/api/admin/actors/${maint}/role`, 'POST', { role: 'maintainer' }, granter)).status).toBe(200);

    const org = await master('/api/organizations', 'POST', { name: `test-org-e2e-usertokens-${run}`, type: 'artifacts' }, maint);
    expect(org.status).toBe(201);
    const repo = await master(
      '/api/repositories',
      'POST',
      { name: `r-${run}`, organizationId: org.json.data.id, repoType: 'baseline', remoteUrl: 'https://example.invalid/r.git', namespace: 'ns' },
      maint
    );
    expect(repo.status).toBe(201);
    repoId = repo.json.data.id;
  });

  afterAll(async () => {
    if (!alice || !maint) return;
    for (const actorId of [alice, maint]) await master('/api/admin/user-tokens/revoke-all', 'POST', { actorId });
  });

  it('a spoofed X-Actor-ID is rewritten: the issue belongs to the token actor', async () => {
    const t = await mint(alice, 'read_write');
    const who = await asUser(t.plaintext, '/api/whoami', 'GET', undefined, { 'X-Actor-ID': maint });
    expect(who.json.data).toMatchObject({ kind: 'user', actorId: alice, scopes: ['read', 'write'], userTokenId: t.id });

    const issue = await asUser(t.plaintext, '/api/issues', 'POST', { repositoryId: repoId, title: 'from a token', createdBy: maint }, { 'X-Actor-ID': maint });
    expect(issue.status, JSON.stringify(issue.json)).toBe(201);
    const got = await master(`/api/issues/${issue.json.data.id}`);
    expect(got.json.data.created_by ?? got.json.data.createdBy).toBe(alice);
  });

  it("a read_write token of a maintainer cannot close another actor's issue; a maintainer token can", async () => {
    const aliceToken = await mint(alice, 'read_write');
    const issue = await asUser(aliceToken.plaintext, '/api/issues', 'POST', { repositoryId: repoId, title: 'close me' });
    expect(issue.status).toBe(201);
    const id = issue.json.data.id as string;

    const rw = await mint(maint, 'read_write');
    expect((await asUser(rw.plaintext, `/api/issues/${id}/status`, 'PATCH', { status: 'closed' })).status).toBe(403);
    expect((await asUser(rw.plaintext, `/api/issues/${id}/comment-policy`, 'PATCH', { commentPolicy: 'locked' })).status).toBe(403);
    expect((await master(`/api/issues/${id}`)).json.data.status).toBe('open');

    const full = await mint(maint, 'maintainer');
    expect((await asUser(full.plaintext, `/api/issues/${id}/status`, 'PATCH', { status: 'closed' })).status).toBe(200);
    expect((await master(`/api/issues/${id}`)).json.data.status).toBe('closed');
  });

  it('read tokens cannot write; no scope reaches candidate stage, gate verdicts or admin routes', async () => {
    const read = await mint(alice, 'read');
    expect((await asUser(read.plaintext, '/api/organizations')).status).toBe(200);
    expect((await asUser(read.plaintext, '/api/issues', 'POST', { repositoryId: repoId, title: 'x' })).status).toBe(403);
    const full = await mint(maint, 'maintainer');
    for (const t of [read, full]) {
      expect((await asUser(t.plaintext, '/api/candidates/x/stage', 'PATCH', { stage: 'promoted' })).status).toBe(403);
      expect((await asUser(t.plaintext, '/api/candidates/x/execute', 'POST', { sandboxRunnerUrl: 'https://example.invalid' })).status).toBe(403);
      expect((await asUser(t.plaintext, '/api/gate-verdicts', 'POST', {})).status).toBe(403);
      expect((await asUser(t.plaintext, '/api/admin/user-tokens', 'POST', { actorId: maint, name: 'x' })).status).toBe(403);
    }
  });

  it('revoke, then the same bearer is 401 on the next request; the list never shows the token', async () => {
    const t = await mint(alice, 'read_write');
    expect((await asUser(t.plaintext, '/api/organizations')).status).toBe(200);
    expect((await master(`/api/admin/user-tokens/${t.id}/revoke`, 'POST')).status).toBe(200);
    expect((await asUser(t.plaintext, '/api/organizations')).status).toBe(401);
    expect((await asUser(t.plaintext, '/health')).status).toBe(401);
    const list = await master(`/api/admin/user-tokens?actorId=${alice}`);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.json)).not.toContain(t.plaintext);
    expect(JSON.stringify(list.json)).not.toContain('token_hash');
  });
});
