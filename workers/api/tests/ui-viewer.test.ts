/**
 * Read-only viewer sign-in: with OPEN_VIEWER_SIGNIN = "true", a GitHub user outside
 * ALLOWED_GITHUB_USERS gets a signed viewer session that has no actor row, reads pages with GET/HEAD
 * only, never reaches the token pages or the new-issue form, and never sees internal or private issues.
 * Runs handleUi against the real Spec DO behind a recording stub.
 *
 * Task: viewer-signin | Spec: docs/plans/viewer-signin-plan.md
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeSqliteState, makeSpecDo, type SqliteState } from '../../spec-do/tests/sqlite-state';
import type { SpecDO } from '../../spec-do/index';
import { handleUi, signSession, type UiEnv } from '../ui';

const TOKEN = 'test-auth-token';
const BASE_ENV: UiEnv = { API_AUTH_TOKEN: TOKEN, GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret', ALLOWED_GITHUB_USERS: 'member' };
const OPEN_ENV: UiEnv = { ...BASE_ENV, OPEN_VIEWER_SIGNIN: 'true' };
const ORIGIN = 'http://localhost';
const REPO = '/app/repos/acme/widgets';

let store: SqliteState;
let spec: SpecDO;
let calls: Request[];
let repoId: string;
let memberId: string;
let orgId: string;

const stub = {
  async fetch(req: Request): Promise<Response> {
    calls.push(req.clone());
    return spec.fetch(req);
  },
};

const count = (table: string) => (store.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

async function viewerCookie(login = 'stranger', extra: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const s = await signSession({ login, actorId: '', viewer: true, iat: now, exp: now + 3600, ...extra } as never, TOKEN);
  return `__Host-beehive_session=${s}`;
}

async function memberCookie(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return `__Host-beehive_session=${await signSession({ login: 'member', actorId: memberId, iat: now, exp: now + 3600 }, TOKEN)}`;
}

async function ui(path: string, opts: { cookie: string; method?: string; form?: Record<string, string>; env?: UiEnv }): Promise<Response> {
  const method = opts.method ?? (opts.form ? 'POST' : 'GET');
  const headers: Record<string, string> = { Cookie: opts.cookie };
  if (method !== 'GET' && method !== 'HEAD') headers.Origin = ORIGIN;
  let body: FormData | undefined;
  if (opts.form) {
    body = new FormData();
    for (const [k, v] of Object.entries(opts.form)) body.append(k, v);
  }
  return (await handleUi(new Request(`http://localhost${path}`, { method, headers, body }), opts.env ?? OPEN_ENV, stub as never)) as Response;
}

function stubGitHub(login: string, id: number) {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const u = String(input);
    if (u.includes('/login/oauth/access_token')) return Response.json({ access_token: 'gh-token' });
    if (u.includes('api.github.com/user')) return Response.json({ login, id });
    throw new Error(`unexpected fetch ${u}`);
  });
}

async function callback(env: UiEnv): Promise<Response> {
  return (await handleUi(
    new Request('http://localhost/auth/callback?code=c&state=s', { headers: { Cookie: '__Host-beehive_oauth_state=s' } }),
    env,
    stub as never
  )) as Response;
}

beforeEach(async () => {
  store = makeSqliteState();
  spec = makeSpecDo(store);
  await spec.init();
  calls = [];
  memberId = spec.createActor('human', 'member').id;
  orgId = spec.createOrganization('acme', 'artifacts').id;
  repoId = spec.createRepository('widgets', orgId, 'baseline', undefined, undefined, 'https://example.invalid/w.git', 'acme').id;
});

afterEach(() => vi.unstubAllGlobals());

describe('sign-in', () => {
  it('without OPEN_VIEWER_SIGNIN a non-member is refused as before: no session, no actor row', async () => {
    stubGitHub('stranger', 999);
    const actors = count('actors');
    const res = await callback(BASE_ENV);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('is not allowed');
    expect(res.headers.getSetCookie().some((c) => c.startsWith('__Host-beehive_session=') && !c.startsWith('__Host-beehive_session=;'))).toBe(false);
    expect(count('actors')).toBe(actors);
  });

  it('with OPEN_VIEWER_SIGNIN a non-member gets a viewer session and nothing is written to the ledger', async () => {
    stubGitHub('stranger', 999);
    const actors = count('actors');
    const res = await callback(OPEN_ENV);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/app');
    expect(count('actors')).toBe(actors);
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);

    const session = res.headers.getSetCookie().find((c) => c.startsWith('__Host-beehive_session='))!.split(';')[0];
    const app = await ui('/app', { cookie: session });
    expect(app.status).toBe(200);
    const html = await app.text();
    expect(html).toContain('(read-only)');
    expect(html).toContain('read-only access');
    expect(html).not.toContain('action="/app/organizations"');
    expect(html).not.toContain('action="/app/repositories"');
    expect(html).not.toContain('action="/app/specs"');
    expect(html).not.toContain('/app/settings/tokens');
  });

  it('a member still signs in as a member when open sign-in is on', async () => {
    stubGitHub('member', 4242);
    const res = await callback(OPEN_ENV);
    expect(res.status).toBe(302);
    const session = res.headers.getSetCookie().find((c) => c.startsWith('__Host-beehive_session='))!.split(';')[0];
    const html = await (await ui('/app', { cookie: session })).text();
    expect(html).not.toContain('(read-only)');
    expect(html).toContain('action="/app/organizations"');
  });
});

describe('viewer session', () => {
  it('sends no X-Actor-ID and never looks up an actor', async () => {
    const res = await ui('/app', { cookie: await viewerCookie() });
    expect(res.status).toBe(200);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.method).toBe('GET');
      expect(c.headers.get('X-Actor-ID')).toBeNull();
      expect(new URL(c.url).pathname.startsWith('/api/actors')).toBe(false);
    }
  });

  it.each([
    ['/app/organizations', { name: 'evil', type: 'artifacts' }],
    ['/app/repositories', { name: 'evil' }],
    ['/app/specs', { name: 'evil' }],
    ['/app/issue_comments', { issueId: 'x', body: 'hi' }],
    [`${REPO}/issues`, { title: 'spam' }],
    ['/app/settings/tokens', { label: 't' }],
  ])('POST %s is 403 before any Spec DO call', async (path, form) => {
    const res = await ui(path, { cookie: await viewerCookie(), form });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Read-only access');
    expect(calls).toEqual([]);
  });

  it.each(['PUT', 'PATCH', 'DELETE'])('%s is 403 before any Spec DO call', async (method) => {
    const res = await ui(`${REPO}/issues/x/status`, { cookie: await viewerCookie(), method });
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('the token page is 403 before any Spec DO call', async () => {
    const res = await ui('/app/settings/tokens', { cookie: await viewerCookie() });
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('the new-issue form is 403 and the list offers no "New Issue" button', async () => {
    expect((await ui(`${REPO}/issues/new`, { cookie: await viewerCookie() })).status).toBe(403);
    const list = await ui(`${REPO}/issues`, { cookie: await viewerCookie() });
    expect(list.status).toBe(200);
    expect(await list.text()).not.toContain('/issues/new');
  });

  it('sees public issues read-only, and internal or private issues not at all', async () => {
    const pub = spec.createIssue(undefined, repoId, 'public bug', 'details', memberId).id;
    const internal = spec.createIssue(undefined, repoId, 'internal bug', 'details', memberId).id;
    const priv = spec.createIssue(undefined, repoId, 'private bug', 'details', memberId).id;
    store.raw.prepare(`UPDATE issues SET visibility = 'internal' WHERE id = ?`).run(internal);
    store.raw.prepare(`UPDATE issues SET visibility = 'private' WHERE id = ?`).run(priv);
    const cookie = await viewerCookie();

    const list = await (await ui(`${REPO}/issues`, { cookie })).text();
    expect(list).toContain('public bug');
    expect(list).not.toContain('internal bug');
    expect(list).not.toContain('private bug');

    const detail = await ui(`${REPO}/issues/${pub}`, { cookie });
    expect(detail.status).toBe(200);
    const html = await detail.text();
    expect(html).toContain('read-only access');
    // The layout's sign-out form is the only POST form left.
    expect(html).not.toContain('/comments" class="comment-form"');
    expect(html).not.toContain('/status" class="inline"');

    expect((await ui(`${REPO}/issues/${internal}`, { cookie })).status).toBe(404);
    expect((await ui(`${REPO}/issues/${priv}`, { cookie })).status).toBe(404);
    expect((await ui(`/app/issues/${internal}`, { cookie })).status).toBe(404);

  });

  it('the changelog on repo, org and spec pages counts public issues only for a viewer, and never private ones', async () => {
    // The changelog renders issues as `Issue "<name>" reported` (issues have no name, so it is empty: a separate,
    // pre-existing bug), so count entries rather than match titles.
    const specId = spec.createSpec('shortener', 'd', '{"endpoints":[]}', [], orgId, memberId).id;
    const linked = spec.createRepository('linked', orgId, 'baseline', specId, undefined, 'https://example.invalid/l.git', 'acme').id;
    for (const visibility of ['public', 'internal', 'private']) {
      const id = spec.createIssue(undefined, linked, `${visibility} bug`, 'details', memberId).id;
      store.raw.prepare(`UPDATE issues SET visibility = ? WHERE id = ?`).run(visibility, id);
    }
    const issueEntries = (html: string) => (html.match(/<p class="summary">Issue &quot;/g) ?? []).length;
    const viewer = await viewerCookie();
    const member = await memberCookie();
    for (const page of ['/app/repos/acme/linked', `/app/orgs/${orgId}`, `/app/specs/${specId}`]) {
      const asViewer = await ui(page, { cookie: viewer });
      expect(asViewer.status, page).toBe(200);
      expect(issueEntries(await asViewer.text()), page).toBe(1);
      const asMember = await ui(page, { cookie: member });
      expect(asMember.status, page).toBe(200);
      expect(issueEntries(await asMember.text()), page).toBe(2);
    }
  });

  it('HEAD reads like GET, and the token page is 403 for HEAD too', async () => {
    const pub = spec.createIssue(undefined, repoId, 'public bug', 'details', memberId).id;
    expect((await ui(`${REPO}/issues/${pub}`, { cookie: await viewerCookie(), method: 'HEAD' })).status).toBe(200);
    calls = [];
    expect((await ui('/app/settings/tokens', { cookie: await viewerCookie(), method: 'HEAD' })).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('the files tab makes no Artifacts API call for a viewer (placeholder tree), but does for a member', async () => {
    const remote = 'https://0123456789abcdef0123456789abcdef.artifacts.cloudflare.net/git/acme/src.git';
    spec.createRepository('src', orgId, 'baseline', undefined, undefined, remote, 'acme');
    const fetched: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return Response.json({ success: false }, { status: 404 });
    });
    const env = { ...OPEN_ENV, CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef', CLOUDFLARE_API_TOKEN: 'cf-token' };
    const asViewer = await ui('/app/repos/acme/src?tab=files', { cookie: await viewerCookie(), env });
    expect(asViewer.status).toBe(200);
    expect(fetched).toEqual([]);
    await ui('/app/repos/acme/src?tab=files', { cookie: await memberCookie(), env });
    expect(fetched.length).toBeGreaterThan(0);
  });

  it('a member still sees internal issues', async () => {
    const internal = spec.createIssue(undefined, repoId, 'internal bug', 'details', memberId).id;
    store.raw.prepare(`UPDATE issues SET visibility = 'internal' WHERE id = ?`).run(internal);
    expect((await ui(`${REPO}/issues/${internal}`, { cookie: await memberCookie() })).status).toBe(200);
  });
});

describe('viewer cookie validity', () => {
  it('is dropped once OPEN_VIEWER_SIGNIN is off', async () => {
    const res = await ui('/app', { cookie: await viewerCookie(), env: BASE_ENV });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/login');
    expect(res.headers.get('Set-Cookie')).toMatch(/__Host-beehive_session=;/);
    expect(calls).toEqual([]);
  });

  it('is dropped once the login is on the allowlist, so it signs in again as a member', async () => {
    const res = await ui('/app', { cookie: await viewerCookie('Member') });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/login');
    expect(calls).toEqual([]);
  });

  it.each([
    ['a viewer flag with an actor id', { actorId: 'some-actor' }],
    ['a viewer flag that is not true', { viewer: 'yes' }],
  ])('rejects %s (treated as signed out)', async (_name, extra) => {
    const res = await ui('/app', { cookie: await viewerCookie('stranger', extra) });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/login');
    expect(calls).toEqual([]);
  });

  it('drops a member cookie once the login is removed from the allowlist', async () => {
    const res = await ui('/app', { cookie: await memberCookie(), env: { ...OPEN_ENV, ALLOWED_GITHUB_USERS: 'someone-else' } });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/login');
    expect(res.headers.get('Set-Cookie')).toMatch(/__Host-beehive_session=;/);
    expect(calls).toEqual([]);
  });

  it('rejects a member cookie with an empty actor id', async () => {
    const now = Math.floor(Date.now() / 1000);
    const bad = `__Host-beehive_session=${await signSession({ login: 'member', actorId: '', iat: now, exp: now + 3600 }, TOKEN)}`;
    const res = await ui('/app', { cookie: bad });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/login');
  });
});
