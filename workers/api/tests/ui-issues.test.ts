/**
 * Repo issue pages (M8 U2/U3): routing, scoping, writes, CSRF, private issues, the legacy route.
 * Runs handleUi against the real Spec DO (real SQL, FKs on) behind a recording stub that keeps
 * the R1 rule (no filtered list params) and can override single DO paths to simulate failures.
 *
 * Task: U4 | Spec: docs/M8-UI-ISSUES-PLAN.md#8
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { makeSqliteState, makeSpecDo, type SqliteState } from '../../spec-do/tests/sqlite-state';
import type { SpecDO } from '../../spec-do/index';
import { handleUi, signSession, type UiEnv } from '../ui';

const TOKEN = 'test-auth-token';
const env: UiEnv = { API_AUTH_TOKEN: TOKEN, GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret', ALLOWED_GITHUB_USERS: 'testuser' };
const ORIGIN = 'http://localhost';

let store: SqliteState;
let spec: SpecDO;
let calls: Request[];
let overrides: Array<(req: Request) => Response | undefined>;
let userId: string;
let otherId: string;
let maintainerId: string;
let orgId: string;
let repos: Record<string, string>;

const FILTERED = ['organizationId', 'repositoryId', 'specId', 'candidateId', 'agentId', 'stage', 'status'];

const stub = {
  async fetch(req: Request): Promise<Response> {
    calls.push(req.clone());
    const url = new URL(req.url);
    for (const p of FILTERED) {
      if (url.searchParams.has(p)) throw new Error(`BLOCKED: filtered list call with ${p} (R1)`);
    }
    for (const o of overrides) {
      const res = o(req);
      if (res) return res;
    }
    return spec.fetch(req);
  },
};

async function cookie(actorId: string): Promise<string> {
  const s = await signSession({ login: 'testuser', actorId, exp: Math.floor(Date.now() / 1000) + 3600 }, TOKEN);
  return `__Host-beehive_session=${s}`;
}

interface Opts {
  actor?: string;
  origin?: string | null;
  form?: Record<string, string>;
  method?: string;
}

async function ui(path: string, opts: Opts = {}): Promise<Response> {
  const method = opts.method ?? (opts.form ? 'POST' : 'GET');
  const headers: Record<string, string> = { Cookie: await cookie(opts.actor ?? userId) };
  if (method !== 'GET' && opts.origin !== null) headers.Origin = opts.origin ?? ORIGIN;
  let body: FormData | undefined;
  if (opts.form) {
    body = new FormData();
    for (const [k, v] of Object.entries(opts.form)) body.append(k, v);
  }
  const res = await handleUi(new Request(`http://localhost${path}`, { method, headers, body }), env, stub as never);
  return res as Response;
}

const sql = (q: string, ...args: unknown[]) => store.raw.prepare(q).run(...(args as never[]));
const count = (table: string) => (store.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const writes = () => calls.filter((c) => c.method !== 'GET');

function newIssue(repoName: string, title = 'bug', createdBy = userId): string {
  return spec.createIssue(undefined, repos[repoName], title, 'details', createdBy).id;
}

function decodedMessage(res: Response, key: 'ok' | 'error'): string | null {
  const loc = res.headers.get('Location') as string;
  return new URL(loc, 'http://localhost').searchParams.get(key);
}

beforeEach(async () => {
  store = makeSqliteState();
  spec = makeSpecDo(store);
  await spec.init();
  calls = [];
  overrides = [];
  userId = spec.createActor('human', 'user').id;
  otherId = spec.createActor('human', 'other').id;
  maintainerId = spec.createActor('human', 'maint').id;
  sql(`UPDATE actors SET role = 'maintainer' WHERE id = ?`, maintainerId);
  orgId = spec.createOrganization('acme', 'artifacts').id;
  const mk = (name: string, ns: string) =>
    spec.createRepository(name, orgId, 'baseline', undefined, undefined, `https://example.invalid/${name}.git`, ns).id;
  repos = {
    widgets: mk('widgets', 'acme'), // 2-part
    shop: mk('shop', 'ns'), // 3-part
    issues: mk('issues', 'ns'), // a repo named like the route word
    new: mk('new', 'acme'),
    other: mk('other', 'acme'),
    'R&D': mk('R&D', 'acme'), // unsafe in a URL: UUID form only
  };
});

afterEach(() => vi.restoreAllMocks());

// ============================================================================

describe('GET list / new / detail', () => {
  it.each([
    ['2-part', '/app/repos/acme/widgets', 'widgets'],
    ['3-part', '/app/repos/acme/ns/shop', 'shop'],
  ])('%s URL: list, new and detail answer 200 and link to the canonical URL', async (_n, base, repoName) => {
    const id = newIssue(repoName, 'first bug');
    const list = await ui(`${base}/issues`);
    expect(list.status).toBe(200);
    const html = await list.text();
    expect(html).toContain(`href="${base}/issues/${id}"`);
    expect(html).toContain('first bug');
    expect((await ui(`${base}/issues/new`)).status).toBe(200);
    const detail = await ui(`${base}/issues/${id}`);
    expect(detail.status).toBe(200);
    expect(await detail.text()).toContain('first bug');
  });

  it('UUID URL: list, new and detail answer 200', async () => {
    const id = newIssue('shop', 'by uuid');
    const base = `/app/repos/${repos.shop}`;
    expect((await ui(`${base}/issues`)).status).toBe(200);
    expect((await ui(`${base}/issues/new`)).status).toBe(200);
    const detail = await ui(`${base}/issues/${id}`);
    expect(detail.status).toBe(200);
    // links on the page use the canonical URL, not the UUID form
    expect(await detail.text()).toContain('href="/app/repos/acme/ns/shop"');
  });

  it('the new-issue form posts to the repo and has no number field', async () => {
    const html = await (await ui('/app/repos/acme/widgets/issues/new')).text();
    expect(html).toContain('action="/app/repos/acme/widgets/issues"');
    expect(html).not.toMatch(/name="number"/);
  });

  it('repos named "issues" and "new" still resolve', async () => {
    // /app/repos/acme/ns/issues: no repo "ns" in org acme, so the issue-list reading falls through to repo "issues"
    const repoPage = await ui('/app/repos/acme/ns/issues');
    expect(repoPage.status).toBe(200);
    expect(await repoPage.text()).toContain('issues');
    expect((await ui('/app/repos/acme/new')).status).toBe(200);
    // and their own issue pages work
    const id = newIssue('issues', 'in the issues repo');
    expect(await (await ui('/app/repos/acme/ns/issues/issues')).text()).toContain('in the issues repo');
    expect((await ui(`/app/repos/acme/ns/issues/issues/${id}`)).status).toBe(200);
    expect((await ui('/app/repos/acme/new/issues')).status).toBe(200);
    expect((await ui('/app/repos/acme/new/issues/new')).status).toBe(200);
  });

  it('an issue under another repo\'s URL is 404', async () => {
    const id = newIssue('widgets');
    expect((await ui(`/app/repos/acme/other/issues/${id}`)).status).toBe(404);
    expect((await ui(`/app/repos/acme/ns/shop/issues/${id}`)).status).toBe(404);
    expect((await ui(`/app/repos/${repos.other}/issues/${id}`)).status).toBe(404);
    expect((await ui(`/app/repos/acme/widgets/issues/${id}`)).status).toBe(200);
  });

  it('unknown repo, unknown issue, bad issue id and bad escapes are 404, never 500', async () => {
    expect((await ui('/app/repos/acme/nope/issues')).status).toBe(404);
    expect((await ui('/app/repos/acme/widgets/issues/does-not-exist')).status).toBe(404);
    expect((await ui('/app/repos/acme/widgets/issues/a%2Fb')).status).toBe(404);
    expect((await ui('/app/repos/acme/%E0%A4%A/issues')).status).toBe(404);
    expect((await ui('/app/repos/acme/../issues')).status).toBe(404);
    expect((await ui('/app/repos/a/b/c/d/issues')).status).toBe(404);
  });

  it('wrong methods are 405 once the repo resolved', async () => {
    const id = newIssue('widgets');
    expect((await ui(`/app/repos/acme/widgets/issues/${id}`, { form: { x: 'y' } })).status).toBe(405);
    expect((await ui('/app/repos/acme/widgets/issues/new', { form: { x: 'y' } })).status).toBe(405);
    expect((await ui(`/app/repos/acme/widgets/issues/${id}/comments`)).status).toBe(405);
    expect((await ui(`/app/repos/acme/widgets/issues/${id}/status`)).status).toBe(405);
  });

  it('does not double-escape the repository name in the header', async () => {
    const html = await (await ui(`/app/repos/${repos['R&D']}/issues`)).text();
    expect(html).toContain('Issues for R&amp;D');
    expect(html).not.toContain('R&amp;amp;D');
  });

  it('renders the ok/error flash escaped', async () => {
    const html = await (await ui('/app/repos/acme/widgets/issues?ok=Done%20%3Cb%3E&error=Bad%20%26%20sad')).text();
    expect(html).toContain('<p class="flash ok">Done &lt;b&gt;</p>');
    expect(html).toContain('<p class="flash err">Bad &amp; sad</p>');
  });
});

// ============================================================================

describe('create', () => {
  it('sends no number, the DO assigns it, and the Location is encoded', async () => {
    const res = await ui('/app/repos/acme/widgets/issues', { form: { title: '#1 bug & more', body: 'b', labels: 'a, b' } });
    expect(res.status).toBe(302);
    const post = writes().find((c) => new URL(c.url).pathname === '/api/issues')!;
    const sent = await post.json();
    expect(sent).toEqual({ repositoryId: repos.widgets, title: '#1 bug & more', body: 'b', labels: ['a', 'b'] });
    expect(post.headers.get('X-Actor-ID')).toBe(userId);

    const row = store.raw.prepare('SELECT id, number, created_by FROM issues').get() as { id: string; number: number; created_by: string };
    expect(row.number).toBe(1);
    expect(row.created_by).toBe(userId);
    const loc = res.headers.get('Location') as string;
    expect(loc.startsWith(`/app/repos/acme/widgets/issues/${row.id}?ok=`)).toBe(true);
    expect(loc).not.toContain(' ');
    expect(decodedMessage(res, 'ok')).toBe('Created issue #1');

    const second = await ui('/app/repos/acme/widgets/issues', { form: { title: 'two' } });
    expect(decodedMessage(second, 'ok')).toBe('Created issue #2');
  });

  it('a title with # & ? survives the redirect and shows on the detail page', async () => {
    const res = await ui('/app/repos/acme/widgets/issues', { form: { title: 'a # b ? c & d' } });
    const follow = await ui(res.headers.get('Location') as string);
    expect(follow.status).toBe(200);
    const html = await follow.text();
    expect(html).toContain('a # b ? c &amp; d');
    expect(html).toContain('Created issue #1');
  });

  it('parallel creates through the UI get distinct numbers', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => ui('/app/repos/acme/widgets/issues', { form: { title: `p${i}` } }))
    );
    expect(results.every((r) => r.status === 302)).toBe(true);
    const numbers = (store.raw.prepare('SELECT number FROM issues ORDER BY number').all() as Array<{ number: number }>).map((r) => r.number);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('works on the 3-part and UUID URLs too', async () => {
    expect((await ui('/app/repos/acme/ns/shop/issues', { form: { title: 'three' } })).status).toBe(302);
    expect((await ui(`/app/repos/${repos.shop}/issues`, { form: { title: 'uuid' } })).status).toBe(302);
    expect(count('issues')).toBe(2);
  });

  it('an empty title goes back to the form without calling the DO', async () => {
    const res = await ui('/app/repos/acme/widgets/issues', { form: { title: '  ' } });
    expect(res.headers.get('Location')).toMatch(/^\/app\/repos\/acme\/widgets\/issues\/new\?error=/);
    expect(writes()).toHaveLength(0);
  });

  it('a DO failure redirects to the form with fixed text; the DO message goes to the log only', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    overrides.push((req) =>
      req.method === 'POST' && new URL(req.url).pathname === '/api/issues'
        ? Response.json({ success: false, error: 'SQLITE_CONSTRAINT secret detail' }, { status: 500 })
        : undefined
    );
    const res = await ui('/app/repos/acme/widgets/issues', { form: { title: 't' } });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toMatch(/^\/app\/repos\/acme\/widgets\/issues\/new\?error=/);
    expect(decodedMessage(res, 'error')).toBe('Could not create issue');
    expect(res.headers.get('Location')).not.toContain('SQLITE');
    expect(log).toHaveBeenCalled();
    expect(count('issues')).toBe(0);
  });

  it('an ok response without success:true is a failure, not a created issue', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    overrides.push((req) =>
      req.method === 'POST' && new URL(req.url).pathname === '/api/issues' ? Response.json({ data: { id: 'x', number: 9 } }) : undefined
    );
    const res = await ui('/app/repos/acme/widgets/issues', { form: { title: 't' } });
    expect(decodedMessage(res, 'error')).toBe('Could not create issue');
  });

  it('the DO 404 of an old Spec DO on a write is a failure too', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    overrides.push((req) =>
      req.method === 'POST' ? Response.json({ success: false, error: 'Not found' }, { status: 404 }) : undefined
    );
    const res = await ui('/app/repos/acme/widgets/issues', { form: { title: 't' } });
    expect(decodedMessage(res, 'error')).toBe('Could not create issue');
  });
});

// ============================================================================

describe('Response.ok on reads', () => {
  it('a 404 from /api/repositories is a 502, not an empty list or "Repository not found"', async () => {
    overrides.push((req) => (new URL(req.url).pathname === '/api/repositories' ? Response.json({ success: false, error: 'Not found' }, { status: 404 }) : undefined));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const path of ['/app/repos/acme/widgets/issues', '/app/repos/acme/widgets/issues/new', '/app/repos/acme/ns/shop/issues/anything']) {
      const res = await ui(path);
      expect(res.status).toBe(502);
      expect(await res.text()).not.toContain('Repository not found');
    }
    const post = await ui('/app/repos/acme/widgets/issues', { form: { title: 't' } });
    expect(post.status).toBe(502);
    expect(count('issues')).toBe(0);
  });

  it('a 500 from /api/issues is a 502 on the list page', async () => {
    overrides.push((req) => (new URL(req.url).pathname === '/api/issues' ? Response.json({ success: false, error: 'boom' }, { status: 500 }) : undefined));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await ui('/app/repos/acme/widgets/issues')).status).toBe(502);
  });

  it('pins defect 11: a DO catch-all 404 on the UUID-form repo read looks like "not found" (404 page)', async () => {
    overrides.push((req) =>
      new URL(req.url).pathname === `/api/repositories/${repos.widgets}` ? Response.json({ success: false, error: 'Not found' }, { status: 404 }) : undefined
    );
    // Follow-up (distinct entity-404 error) should turn this into a 502
    expect((await ui(`/app/repos/${repos.widgets}/issues`)).status).toBe(404);
  });
});

// ============================================================================

describe('CSRF: one sameOrigin check on every new POST', () => {
  it('cross-origin and missing-Origin requests are 403 on create, comment, status and the shim, with no DO writes', async () => {
    const id = newIssue('widgets');
    const base = '/app/repos/acme/widgets/issues';
    const cases: Array<[string, Record<string, string>]> = [
      [base, { title: 't' }],
      [`${base}/${id}/comments`, { body: 'hi' }],
      [`${base}/${id}/status`, { status: 'closed' }],
      ['/app/issue_comments', { issueId: id, body: 'hi' }],
    ];
    for (const [path, form] of cases) {
      for (const origin of ['http://evil.example', null]) {
        calls = [];
        const res = await ui(path, { form, origin });
        expect(res.status, `${path} origin=${origin}`).toBe(403);
        expect(writes()).toHaveLength(0);
      }
    }
    expect(count('issues')).toBe(1);
    expect(count('issue_comments')).toBe(0);
    expect(store.raw.prepare('SELECT status FROM issues').get()).toEqual({ status: 'open' });
  });

  it('the origin is checked before any DO read on the new routes', async () => {
    const id = newIssue('widgets');
    calls = [];
    // session check reads /api/actors; nothing about repos or issues may be read
    const res = await ui(`/app/repos/acme/widgets/issues/${id}/comments`, { form: { body: 'x' }, origin: null });
    expect(res.status).toBe(403);
    const paths = calls.map((c) => new URL(c.url).pathname);
    expect(paths.every((p) => p === '/api/actors')).toBe(true);
  });
});

// ============================================================================

describe('comments', () => {
  it('posts to /api/issues/:id/comments with only the body; the actor is the header', async () => {
    const id = newIssue('widgets');
    const res = await ui(`/app/repos/acme/widgets/issues/${id}/comments`, { form: { body: ' hello ', createdBy: 'forged' }, actor: otherId });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`/app/repos/acme/widgets/issues/${id}?ok=Comment%20added#comments`);
    const post = writes().find((c) => new URL(c.url).pathname === `/api/issues/${id}/comments`)!;
    expect(await post.json()).toEqual({ body: 'hello' });
    expect(post.headers.get('X-Actor-ID')).toBe(otherId);
    const row = store.raw.prepare('SELECT created_by, body FROM issue_comments').get();
    expect(row).toEqual({ created_by: otherId, body: 'hello' });
    // shown on the page, on a closed issue as well
    sql(`UPDATE issues SET status = 'closed' WHERE id = ?`, id);
    const html = await (await ui(`/app/repos/acme/widgets/issues/${id}`)).text();
    expect(html).toContain('hello');
    expect(html).toContain(`action="/app/repos/acme/widgets/issues/${id}/comments"`);
  });

  it('empty and oversized comments are rejected before the DO', async () => {
    const id = newIssue('widgets');
    const empty = await ui(`/app/repos/acme/widgets/issues/${id}/comments`, { form: { body: '   ' } });
    expect(decodedMessage(empty, 'error')).toBe('Comment cannot be empty.');
    const big = await ui(`/app/repos/acme/widgets/issues/${id}/comments`, { form: { body: 'x'.repeat(10_001) } });
    expect(decodedMessage(big, 'error')).toMatch(/too long/);
    expect(writes()).toHaveLength(0);
  });

  it('a locked issue: a non-maintainer sees "Locked" and no form, and cannot post through the UI', async () => {
    const id = newIssue('widgets');
    sql(`UPDATE issues SET comment_policy = 'locked' WHERE id = ?`, id);
    const html = await (await ui(`/app/repos/acme/widgets/issues/${id}`, { actor: otherId })).text();
    expect(html).toContain('Locked');
    expect(html).not.toContain('/comments"');

    const res = await ui(`/app/repos/acme/widgets/issues/${id}/comments`, { form: { body: 'sneaky' }, actor: otherId });
    expect(res.status).toBe(302);
    expect(decodedMessage(res, 'error')).toMatch(/locked/);
    expect(count('issue_comments')).toBe(0);

    // the issue creator is not a maintainer either
    const byCreator = await ui(`/app/repos/acme/widgets/issues/${id}/comments`, { form: { body: 'sneaky' }, actor: userId });
    expect(decodedMessage(byCreator, 'error')).toMatch(/locked/);
    expect(count('issue_comments')).toBe(0);
  });

  it('a locked issue: a maintainer sees the form and can comment', async () => {
    const id = newIssue('widgets');
    sql(`UPDATE issues SET comment_policy = 'locked' WHERE id = ?`, id);
    const html = await (await ui(`/app/repos/acme/widgets/issues/${id}`, { actor: maintainerId })).text();
    expect(html).toContain('/comments"');
    const res = await ui(`/app/repos/acme/widgets/issues/${id}/comments`, { form: { body: 'ok' }, actor: maintainerId });
    expect(decodedMessage(res, 'ok')).toBe('Comment added');
    expect(count('issue_comments')).toBe(1);
  });

  it('maintainers_only: non-maintainers get a notice instead of the form', async () => {
    const id = newIssue('widgets');
    sql(`UPDATE issues SET comment_policy = 'maintainers_only' WHERE id = ?`, id);
    const html = await (await ui(`/app/repos/acme/widgets/issues/${id}`, { actor: otherId })).text();
    expect(html).not.toContain('/comments"');
    expect(html).toContain('Only maintainers can comment');
    const res = await ui(`/app/repos/acme/widgets/issues/${id}/comments`, { form: { body: 'x' }, actor: otherId });
    expect(decodedMessage(res, 'error')).toMatch(/maintainers/);
    expect(count('issue_comments')).toBe(0);
  });

  it('a comment on an issue under another repo\'s URL is 404 and writes nothing', async () => {
    const id = newIssue('widgets');
    const res = await ui(`/app/repos/acme/other/issues/${id}/comments`, { form: { body: 'x' } });
    expect(res.status).toBe(404);
    expect(count('issue_comments')).toBe(0);
  });

  it('an unexpected DO status shows generic text, not the DO message', async () => {
    const id = newIssue('widgets');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    overrides.push((req) =>
      req.method === 'POST' && new URL(req.url).pathname.endsWith('/comments')
        ? Response.json({ success: false, error: 'internal secret' }, { status: 500 })
        : undefined
    );
    const res = await ui(`/app/repos/acme/widgets/issues/${id}/comments`, { form: { body: 'x' } });
    expect(decodedMessage(res, 'error')).toBe('Could not add comment');
  });
});

// ============================================================================

describe('close / reopen', () => {
  it('creator and maintainer see the button, others do not', async () => {
    const id = newIssue('widgets', 'bug', userId);
    const base = `/app/repos/acme/widgets/issues/${id}`;
    expect(await (await ui(base, { actor: userId })).text()).toContain('Close issue');
    expect(await (await ui(base, { actor: maintainerId })).text()).toContain('Close issue');
    expect(await (await ui(base, { actor: otherId })).text()).not.toContain('Close issue');
  });

  it('close then reopen through the UI', async () => {
    const id = newIssue('widgets');
    const base = `/app/repos/acme/widgets/issues/${id}`;
    const closed = await ui(`${base}/status`, { form: { status: 'closed' } });
    expect(closed.headers.get('Location')).toBe(`${base}?ok=Issue%20closed`);
    expect(store.raw.prepare('SELECT status, closed_by FROM issues').get()).toEqual({ status: 'closed', closed_by: userId });
    expect(await (await ui(base)).text()).toContain('Reopen issue');
    const reopened = await ui(`${base}/status`, { form: { status: 'open' }, actor: maintainerId });
    expect(decodedMessage(reopened, 'ok')).toBe('Issue reopened');
    expect(store.raw.prepare('SELECT status, closed_at FROM issues').get()).toEqual({ status: 'open', closed_at: null });
  });

  it('someone else gets the DO\'s 403 as a flash and the issue is unchanged', async () => {
    const id = newIssue('widgets');
    const res = await ui(`/app/repos/acme/widgets/issues/${id}/status`, { form: { status: 'closed' }, actor: otherId });
    expect(decodedMessage(res, 'error')).toMatch(/creator or a maintainer/);
    expect(store.raw.prepare('SELECT status FROM issues').get()).toEqual({ status: 'open' });
  });

  it('a bad status value never reaches the DO', async () => {
    const id = newIssue('widgets');
    const res = await ui(`/app/repos/acme/widgets/issues/${id}/status`, { form: { status: 'bogus' } });
    expect(decodedMessage(res, 'error')).toBe('Status must be open or closed.');
    expect(writes()).toHaveLength(0);
  });

  it('an old Spec DO (catch-all 404 on PATCH) shows "not available yet", never a silent no-op', async () => {
    const id = newIssue('widgets');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    overrides.push((req) =>
      req.method === 'PATCH' ? Response.json({ success: false, error: 'Not found' }, { status: 404 }) : undefined
    );
    const res = await ui(`/app/repos/acme/widgets/issues/${id}/status`, { form: { status: 'closed' } });
    expect(decodedMessage(res, 'error')).toBe('Closing and reopening is not available yet');
  });

  it('closing an issue under another repo\'s URL is 404', async () => {
    const id = newIssue('widgets');
    const res = await ui(`/app/repos/acme/other/issues/${id}/status`, { form: { status: 'closed' } });
    expect(res.status).toBe(404);
    expect(store.raw.prepare('SELECT status FROM issues').get()).toEqual({ status: 'open' });
  });
});

// ============================================================================

describe('private issues', () => {
  it('are 404 on detail, comment, status, the legacy route and the shim; hidden from the list', async () => {
    const id = newIssue('widgets', 'secret plan');
    sql(`UPDATE issues SET visibility = 'private' WHERE id = ?`, id);
    const base = '/app/repos/acme/widgets/issues';

    expect((await ui(`${base}/${id}`)).status).toBe(404);
    expect((await ui(`${base}/${id}/comments`, { form: { body: 'x' } })).status).toBe(404);
    expect((await ui(`${base}/${id}/status`, { form: { status: 'closed' } })).status).toBe(404);
    const legacy = await ui(`/app/issues/${id}`);
    expect(legacy.status).toBe(404);
    expect(legacy.headers.get('Location')).toBeNull();
    const shim = await ui('/app/issue_comments', { form: { issueId: id, body: 'x' } });
    expect(shim.headers.get('Location')).toMatch(/^\/app\?error=/);
    expect(await (await ui(`${base}`)).text()).not.toContain('secret plan');
    expect(count('issue_comments')).toBe(0);
    expect(store.raw.prepare('SELECT status FROM issues').get()).toEqual({ status: 'open' });
  });
});

// ============================================================================

describe('legacy /app/issues/:id and /app/issue_comments', () => {
  it('GET 302s to the canonical URL, 404 for an unknown issue', async () => {
    const w = newIssue('widgets');
    const s = newIssue('shop');
    expect((await ui(`/app/issues/${w}`)).headers.get('Location')).toBe(`/app/repos/acme/widgets/issues/${w}`);
    expect((await ui(`/app/issues/${s}`)).headers.get('Location')).toBe(`/app/repos/acme/ns/shop/issues/${s}`);
    expect((await ui('/app/issues/nope')).status).toBe(404);
  });

  it('renders in place (read-only) when the repository cannot be resolved', async () => {
    const id = newIssue('widgets', 'orphan view');
    overrides.push((req) =>
      new URL(req.url).pathname === `/api/repositories/${repos.widgets}` ? Response.json({ success: false, error: 'Not found' }, { status: 404 }) : undefined
    );
    const res = await ui(`/app/issues/${id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('orphan view');
    expect(html).not.toContain('/comments"');
    expect(html).not.toContain('Close issue');
  });

  it('the shim comments on the issue and redirects to the canonical URL', async () => {
    const id = newIssue('shop');
    const res = await ui('/app/issue_comments', { form: { issueId: id, body: 'via shim' } });
    expect(res.headers.get('Location')).toBe(`/app/repos/acme/ns/shop/issues/${id}?ok=Comment%20added#comments`);
    expect(count('issue_comments')).toBe(1);
  });
});

// ============================================================================

describe('link text', () => {
  it('is never empty: an issue with an empty title still gets a label, on the list, repo tab and spec page', async () => {
    const id = newIssue('widgets', 'x');
    sql(`UPDATE issues SET title = '' WHERE id = ?`, id);
    const namedId = newIssue('widgets', 'named one');
    const specId = spec.createSpec('s', 'd', '{}', [], orgId, userId).id;
    sql(`UPDATE repositories SET spec_id = ? WHERE id = ?`, specId, repos.widgets);

    const pages = [
      '/app/repos/acme/widgets/issues',
      '/app/repos/acme/widgets?tab=issues',
      `/app/specs/${specId}`,
    ];
    for (const path of pages) {
      const html = await (await ui(path)).text();
      const links = [...html.matchAll(/<a href="([^"]*\/issues\/([^"]+))">([^<]*)<\/a>/g)];
      const mine = links.filter((m) => m[2] === id || m[2] === namedId);
      expect(mine.length, path).toBe(2);
      for (const m of mine) {
        expect(m[3].trim().length, `${path} ${m[1]}`).toBeGreaterThan(0);
        expect(m[1], path).toBe(`/app/repos/acme/widgets/issues/${m[2]}`);
      }
      expect(html, path).toContain('#2: named one');
      expect(html, path).toMatch(/#1(?!:)|Issue [a-z0-9]{8}/);
    }
  });
});
