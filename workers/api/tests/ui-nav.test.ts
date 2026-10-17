/**
 * Navigation on the migrated pages (M9 L3-L6): navbar, breadcrumb trail, one flash, one search
 * control, status codes unchanged. Runs handleUi against the real Spec DO behind a recording stub
 * that can override single DO paths (same pattern as ui-issues.test.ts).
 *
 * Task: L3-L6 | Spec: docs/M9-NAV-PLAN.md#5
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { makeSqliteState, makeSpecDo } from '../../spec-do/tests/sqlite-state';
import type { SpecDO } from '../../spec-do/index';
import { handleUi, signSession, type UiEnv } from '../ui';

const TOKEN = 'test-auth-token';
const env: UiEnv = { API_AUTH_TOKEN: TOKEN, GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret', ALLOWED_GITHUB_USERS: 'testuser' };
const ORIGIN = 'http://localhost';

let spec: SpecDO;
let calls: Request[];
let overrides: Array<(req: Request) => Response | undefined>;
let userId: string;
let orgId: string;

const stub = {
  async fetch(req: Request): Promise<Response> {
    calls.push(req.clone());
    for (const o of overrides) {
      const res = o(req);
      if (res) return res;
    }
    return spec.fetch(req);
  },
};

async function ui(path: string, opts: { method?: string; origin?: string | null; form?: Record<string, string> } = {}): Promise<Response> {
  const method = opts.method ?? (opts.form ? 'POST' : 'GET');
  const token = await signSession({ login: 'testuser', actorId: userId, exp: Math.floor(Date.now() / 1000) + 3600 }, TOKEN);
  const headers: Record<string, string> = { Cookie: `__Host-beehive_session=${token}` };
  if (method !== 'GET' && opts.origin !== null) headers.Origin = opts.origin ?? ORIGIN;
  let body: FormData | undefined;
  if (opts.form) {
    body = new FormData();
    for (const [k, v] of Object.entries(opts.form)) body.append(k, v);
  }
  return (await handleUi(new Request(`http://localhost${path}`, { method, headers, body }), env, stub as never)) as Response;
}

const count = (html: string, needle: string) => html.split(needle).length - 1;
const orgListReads = () => calls.filter((c) => c.method === 'GET' && new URL(c.url).pathname === '/api/organizations');

beforeEach(async () => {
  const store = makeSqliteState();
  spec = makeSpecDo(store);
  await spec.init();
  calls = [];
  overrides = [];
  userId = spec.createActor('human', 'user').id;
  orgId = spec.createOrganization('acme', 'artifacts').id;
});

afterEach(() => vi.restoreAllMocks());

// ============================================================================

describe('dashboard (L3)', () => {
  it('renders the navbar, one h1 and the section anchors; no old header', async () => {
    const res = await ui('/app');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<nav aria-label="Primary">');
    expect(count(html, '<h1>')).toBe(1);
    expect(html).toContain('<h1>Dashboard</h1>');
    for (const id of ['organizations', 'repositories', 'specs']) expect(html).toContain(`<section id="${id}">`);
    expect(html).not.toContain('class="bar"');
    expect(count(html, 'Signed in as')).toBe(1);
    expect(count(html, 'action="/logout"')).toBe(1);
    expect(html).toContain(`<a href="/app/orgs/${orgId}">`); // switcher + table
    expect(html).toContain('<summary>Organizations</summary>');
  });

  it('shows each flash exactly once', async () => {
    const html = await (await ui('/app?ok=Created+it&error=Nope')).text();
    expect(count(html, 'class="flash')).toBe(2);
    expect(html).toContain('<p class="flash ok">Created it</p>');
    expect(html).toContain('<p class="flash err">Nope</p>');
  });

  it('reads the organization list exactly once even though the page lists organizations too', async () => {
    await ui('/app');
    expect(orgListReads()).toHaveLength(1);
  });

  it('search is disabled on the dashboard', async () => {
    expect(await (await ui('/app')).text()).toContain('disabled placeholder="Open an organization or repository to search"');
  });

  it('a failing organization list is a 502 page that still has the header and says unavailable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    overrides.push((req) => (new URL(req.url).pathname === '/api/organizations' ? Response.json({ success: false, error: 'boom' }, { status: 500 }) : undefined));
    const res = await ui('/app');
    expect(res.status).toBe(502);
    const html = await res.text();
    expect(html).toContain('could not load this page');
    expect(html).toContain('Organizations unavailable');
    expect(html).not.toContain('No organizations');
  });
});

describe('navigation read failures never fail a page (L2 proof d)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('a DO 404 on the nav read shows unavailable, never "no organizations"; the page keeps its own status', async () => {
    overrides.push((req) => (new URL(req.url).pathname === '/api/organizations' ? Response.json({ success: false, error: 'Not found' }, { status: 404 }) : undefined));
    const res = await ui('/app/nothing-here');
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('Organizations unavailable');
    expect(html).not.toContain('No organizations');
  });

  it('known limitation, pinned: a success reply with non-array data reads as no organizations', async () => {
    overrides.push((req) => (new URL(req.url).pathname === '/api/organizations' ? Response.json({ success: true, data: null }) : undefined));
    const html = await (await ui('/app/nothing-here')).text();
    expect(html).toContain('No organizations');
  });
});

describe('handleUi status pages (L3)', () => {
  it.each([
    ['unknown path', '/app/nothing-here', undefined, 404, 'This page does not exist'],
    ['invalid detail id', '/app/specs/a.b', undefined, 404, 'Invalid ID format'],
    ['non-GET on detail (404, not 405)', '/app/specs/abc', 'DELETE', 404, 'Method not allowed'],
    ['non-GET on repo path (404, not 405)', '/app/repos/acme/widgets', 'PUT', 404, 'Method not allowed'],
    ['unknown repo', '/app/repos/acme/missing', undefined, 404, 'Repository not found'],
    ['invalid repo path', '/app/repos/acme/bad%20name', undefined, 404, 'Invalid path format'],
  ])('%s keeps its status and message and renders inside the layout', async (_n, path, method, status, text) => {
    const res = await ui(path, { method });
    expect(res.status).toBe(status);
    const html = await res.text();
    expect(html).toContain(text);
    expect(html).toContain('<nav aria-label="Primary">');
    expect(html).toContain('<nav class="site-crumbs" aria-label="Breadcrumb">');
    expect(html).toContain('<li aria-current="page"><bdi>Not found</bdi></li>');
    expect(count(html, '<h1>')).toBe(1);
  });

  it('a non-GET status page uses the light chrome: no organization list read', async () => {
    const res = await ui('/app/specs/abc', { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('<a class="site-orgs" href="/app#organizations">Organizations</a>');
    expect(orgListReads()).toHaveLength(0);
  });

  it('cross-origin POST: 403 inside the layout, only /api/actors read', async () => {
    const res = await ui('/app/organizations', { form: { name: 'x', type: 'github' }, origin: 'http://evil.example' });
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain('Cross-origin request blocked.');
    expect(html).toContain('<li aria-current="page"><bdi>Forbidden</bdi></li>');
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/api/actors']);
  });

  it('a successful create redirects without an organization list read', async () => {
    const res = await ui('/app/organizations', { form: { name: 'beta', type: 'github' } });
    expect(res.status).toBe(302);
    expect(orgListReads()).toHaveLength(0);
  });
});

// ============================================================================

describe('issue pages (L4)', () => {
  let widgets: string;
  let issueId: string;

  beforeEach(() => {
    widgets = spec.createRepository('widgets', orgId, 'baseline', undefined, undefined, 'https://example.invalid/w.git', 'acme').id;
    issueId = spec.createIssue(undefined, widgets, 'first bug', 'details', userId).id;
  });

  it('list: Dashboard > acme > widgets > Issues, Issues item current, search to the repo, flash once', async () => {
    const res = await ui('/app/repos/acme/widgets/issues?ok=Saved');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<h1>Issues for widgets</h1>');
    expect(html).toContain('<li><a href="/app"><bdi>Dashboard</bdi></a></li>');
    expect(html).toContain(`<li><a href="/app/orgs/${orgId}"><bdi>acme</bdi></a></li>`);
    expect(html).toContain('<li><a href="/app/repos/acme/widgets"><bdi>widgets</bdi></a></li>');
    expect(html).toContain('<li aria-current="page"><bdi>Issues</bdi></li>');
    expect(html).toContain('<a href="/app/repos/acme/widgets/issues" aria-current="true">Issues</a>');
    expect(html).toContain('action="/app/repos/acme/widgets#search"');
    expect(count(html, 'class="flash')).toBe(1);
    expect(html).not.toContain('class="subbar"');
    expect(html).not.toContain('Back to repository');
    expect(html).toContain(`<summary>Org: <bdi>acme</bdi></summary>`);
  });

  it('new: trail ends Issues > New and the form is intact', async () => {
    const html = await (await ui('/app/repos/acme/widgets/issues/new?error=Issue+needs+a+title.')).text();
    expect(html).toContain('<h1>New Issue for widgets</h1>');
    expect(html).toContain('<li><a href="/app/repos/acme/widgets/issues"><bdi>Issues</bdi></a></li><li aria-current="page"><bdi>New</bdi></li>');
    expect(html).toContain('action="/app/repos/acme/widgets/issues"');
    expect(count(html, 'class="flash')).toBe(1);
  });

  it('detail: trail ends Issues > #n; one flash; no bottom back link', async () => {
    const html = await (await ui(`/app/repos/acme/widgets/issues/${issueId}?ok=Comment+added`)).text();
    expect(html).toContain('<h1>Issue #1: first bug</h1>');
    expect(html).toContain('<li><a href="/app/repos/acme/widgets/issues"><bdi>Issues</bdi></a></li><li aria-current="page"><bdi>#1</bdi></li>');
    expect(count(html, 'class="flash')).toBe(1);
    expect(count(html, '<h1>')).toBe(1);
    expect(html).not.toContain('Back to issues');
    expect(html).toContain(`action="/app/repos/acme/widgets/issues/${issueId}/comments"`);
  });

  it('UUID-form repo URL keeps working with the canonical URL in the trail', async () => {
    const html = await (await ui(`/app/repos/${widgets}/issues`)).text();
    expect(html).toContain('<a href="/app/repos/acme/widgets"><bdi>widgets</bdi></a>');
  });

  it('legacy render without a resolvable repo: Dashboard > Issue #n, no Issues item', async () => {
    overrides.push((req) => (new URL(req.url).pathname === `/api/repositories/${widgets}` ? Response.json({ success: false, error: 'Not found' }, { status: 404 }) : undefined));
    const res = await ui(`/app/issues/${issueId}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<li aria-current="page"><bdi>Issue #1</bdi></li>');
    expect(html).not.toContain('>Issues</a>');
    expect(count(html, '<h1>')).toBe(1);
  });

  it('a private issue is still a 404 inside the layout, without its title', async () => {
    const priv = spec.createIssue(undefined, widgets, 'SECRET-TITLE', 'x', userId).id;
    overrides.push((req) => {
      if (new URL(req.url).pathname !== `/api/issues/${priv}`) return undefined;
      return Response.json({ success: true, data: { id: priv, number: 2, title: 'SECRET-TITLE', repository_id: widgets, visibility: 'private', status: 'open' } });
    });
    const res = await ui(`/app/repos/acme/widgets/issues/${priv}`);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).not.toContain('SECRET-TITLE');
    expect(html).toContain('<nav class="site-crumbs" aria-label="Breadcrumb">');
  });

  // The UUID form resolves its repo with single gets; the 2-part form lists organizations itself
  // (existing behaviour), which would hide a navigation read in these assertions.
  it('keeps 405 for a wrong method on the issue routes, in the layout, with light chrome', async () => {
    const res = await ui(`/app/repos/${widgets}/issues`, { method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(await res.text()).toContain('<li aria-current="page"><bdi>Method not allowed</bdi></li>');
    expect(orgListReads()).toHaveLength(0);
  });

  it('a comment POST redirects with no organization list read and a refused one is a 403 page', async () => {
    const ok = await ui(`/app/repos/${widgets}/issues/${issueId}/comments`, { form: { body: 'hi' } });
    expect(ok.status).toBe(302);
    expect(orgListReads()).toHaveLength(0);
    const bad = await ui(`/app/repos/${widgets}/issues/${issueId}/comments`, { form: { body: 'hi' }, origin: 'http://evil.example' });
    expect(bad.status).toBe(403);
    expect(await bad.text()).toContain('<li aria-current="page"><bdi>Forbidden</bdi></li>');
    expect(orgListReads()).toHaveLength(0);
  });

  it('a repo whose name needs escaping renders escaped in the trail', async () => {
    const odd = spec.createRepository('R&D', orgId, 'baseline', undefined, undefined, 'https://example.invalid/r.git', 'acme').id;
    const html = await (await ui(`/app/repos/${odd}/issues`)).text();
    expect(html).toContain('<bdi>R&amp;D</bdi>');
    expect(html).not.toContain('<bdi>R&D</bdi>');
  });
});

// ============================================================================

describe('org and repo pages (L5)', () => {
  let widgets: string;
  let shop: string;

  beforeEach(() => {
    widgets = spec.createRepository('widgets', orgId, 'baseline', undefined, undefined, 'https://example.invalid/w.git', 'acme').id;
    shop = spec.createRepository('shop', orgId, 'baseline', undefined, undefined, 'https://example.invalid/s.git', 'ns').id;
  });

  it('org page: h1 and trail, h2 Details, one search control kept as results + navbar input', async () => {
    const res = await ui(`/app/orgs/${orgId}?q=wid`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<h1>acme</h1>');
    expect(html).toContain('<li><a href="/app"><bdi>Dashboard</bdi></a></li><li aria-current="page"><bdi>acme</bdi></li>');
    expect(html).toContain('<h2>Details</h2>');
    expect(html).not.toContain('<h3>Details</h3>');
    expect(count(html, 'name="q"')).toBe(1);
    expect(html).toContain(`action="/app/orgs/${orgId}#search"`);
    expect(html).toContain('value="wid"');
    expect(html).toContain('<section class="search-box" id="search">');
    expect(html).toContain('badge mock'); // the results stay labelled as mocked
    expect(html).toContain(`<a href="/app/orgs/${orgId}" aria-current="page"><bdi>acme</bdi></a>`);
    expect(html).not.toContain('aria-current="true"');
    expect(html).not.toContain('class="subbar"');
  });

  it.each([
    ['UUID', () => `/app/repos/${widgets}`, '/app/repos/acme/widgets', 'widgets'],
    ['2-part', () => '/app/repos/acme/widgets', '/app/repos/acme/widgets', 'widgets'],
    ['3-part', () => '/app/repos/acme/ns/shop', '/app/repos/acme/ns/shop', 'shop'],
  ])('repo page via %s URL: trail, tabs, Issues item, one search control', async (_n, path, canonical, name) => {
    const res = await ui(path());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`<h1>${name}</h1>`);
    expect(html).toContain(`<li><a href="/app"><bdi>Dashboard</bdi></a></li><li><a href="/app/orgs/${orgId}"><bdi>acme</bdi></a></li>`);
    expect(html).toContain(`<li aria-current="page"><bdi>${name}</bdi></li>`);
    expect(html).toContain(`<a href="${canonical}/issues">Issues</a>`);
    expect(html).toContain('<a href="/app#repositories" aria-current="true">Repositories</a>');
    expect(html).toContain('<nav class="tabs" aria-label="Repository sections">');
    expect(html).toContain('aria-current="page" class="tab active">overview<');
    expect(html).toContain('<h2>Details</h2>');
    expect(count(html, 'name="q"')).toBe(1);
    expect(html).toContain(`action="${canonical}#search"`);
    expect(html).toContain('<section class="search-box" id="search">');
  });

  it('repo page whose org row is missing renders a shorter trail, never an invented label', async () => {
    overrides.push((req) => (new URL(req.url).pathname === '/api/organizations' && req.method === 'GET' ? Response.json({ success: true, data: [] }) : undefined));
    const res = await ui(`/app/repos/${widgets}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<li><a href="/app"><bdi>Dashboard</bdi></a></li><li aria-current="page"><bdi>widgets</bdi></li>');
    expect(html).toContain('No organizations');
  });

  it('escapes hostile org and repo names in the trail, title and heading', async () => {
    const evilOrg = spec.createOrganization('<img src=x onerror=alert(1)>', 'artifacts').id;
    const evilRepo = spec.createRepository('<b>r</b>', evilOrg, 'baseline', undefined, undefined, 'https://example.invalid/e.git', 'x').id;
    for (const path of [`/app/orgs/${evilOrg}`, `/app/repos/${evilRepo}`]) {
      const html = await (await ui(path)).text();
      expect(html, path).not.toContain('<img src=x');
      expect(html, path).not.toContain('<b>r</b>');
    }
  });

  it('keeps the page status codes: unknown org and repo are 404, a DO failure is 502 inside the layout', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await ui('/app/orgs/missing')).status).toBe(404);
    expect((await ui('/app/repos/missing')).status).toBe(404);
    overrides.push((req) => (new URL(req.url).pathname === '/api/specs' ? Response.json({ success: false, error: 'boom' }, { status: 500 }) : undefined));
    const res = await ui(`/app/orgs/${orgId}`);
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('<nav class="site-crumbs" aria-label="Breadcrumb">');
  });
});

// ============================================================================

describe('spec, candidate and trial pages (L6)', () => {
  let specId: string;
  let c1: string;
  let c2: string;
  let trialId: string;

  beforeEach(() => {
    const repo = spec.createRepository('widgets', orgId, 'candidate', undefined, undefined, 'https://example.invalid/w.git', 'acme').id;
    specId = spec.createSpec('Pricing', 'd', '{"endpoints":[]}', [], orgId, userId).id;
    c1 = spec.createCandidate(specId, repo, 'sha1', 'base', userId).id;
    c2 = spec.createCandidate(specId, repo, 'sha2', 'base', userId).id;
    trialId = spec.createTrial(specId, c1, c2, userId).id;
  });

  const dash = '<li><a href="/app"><bdi>Dashboard</bdi></a></li>';
  const org = () => `<li><a href="/app/orgs/${orgId}"><bdi>acme</bdi></a></li>`;
  const specCrumb = () => `<li><a href="/app/specs/${specId}"><bdi>Pricing</bdi></a></li>`;

  it('spec: Dashboard > org > spec, Specs item current, one search control, h2 Details', async () => {
    const res = await ui(`/app/specs/${specId}?q=pri`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<h1>Pricing</h1>');
    expect(html).toContain(`${dash}${org()}<li aria-current="page"><bdi>Pricing</bdi></li>`);
    expect(html).toContain('<a href="/app#specs" aria-current="true">Specs</a>');
    expect(count(html, 'name="q"')).toBe(1);
    expect(html).toContain(`action="/app/specs/${specId}#search"`);
    expect(html).toContain('value="pri"');
    expect(html).toContain('<h2>Details</h2>');
    expect(html).not.toContain('<h3>Details</h3>');
    expect(html).not.toContain('class="subbar"');
  });

  it('candidate: ... > spec > Candidate xxxxxxxx', async () => {
    const html = await (await ui(`/app/candidates/${c1}`)).text();
    expect(html).toContain(`<h1>Candidate ${c1.slice(0, 8)}</h1>`);
    expect(html).toContain(`${dash}${org()}${specCrumb()}<li aria-current="page"><bdi>Candidate ${c1.slice(0, 8)}</bdi></li>`);
    expect(count(html, 'name="q"')).toBe(1);
    expect(html).toContain(`action="/app/candidates/${c1}#search"`);
    expect(html).toContain('<h2>Details</h2>');
  });

  it('trial: ... > spec (from candidate A) > Trial xxxxxxxx', async () => {
    const res = await ui(`/app/trials/${trialId}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`${dash}${org()}${specCrumb()}<li aria-current="page"><bdi>Trial ${trialId.slice(0, 8)}</bdi></li>`);
    expect(count(html, 'name="q"')).toBe(1);
    expect(html).toContain('<h2>Details</h2>');
  });

  it('trial reads the organization list once (breadcrumb and navigation share it)', async () => {
    await ui(`/app/trials/${trialId}`);
    expect(orgListReads()).toHaveLength(1);
  });

  it('a missing org row drops its crumb on spec, candidate and trial pages', async () => {
    overrides.push((req) => (new URL(req.url).pathname === '/api/organizations' && req.method === 'GET' ? Response.json({ success: true, data: [] }) : undefined));
    for (const [path, last] of [
      [`/app/specs/${specId}`, 'Pricing'],
      [`/app/candidates/${c1}`, `Candidate ${c1.slice(0, 8)}`],
      [`/app/trials/${trialId}`, `Trial ${trialId.slice(0, 8)}`],
    ]) {
      const html = await (await ui(path)).text();
      expect(html, path).not.toContain('<bdi>acme</bdi></a></li><li');
      expect(html, path).toContain(`<li aria-current="page"><bdi>${last}</bdi></li>`);
    }
  });

  it('a spec name with markup is escaped in the trail of its candidate page and the title', async () => {
    const evil = spec.createSpec('<script>alert(1)</script>', 'd', '{}', [], orgId, userId).id;
    const repo = spec.createRepository('r2', orgId, 'candidate', undefined, undefined, 'https://example.invalid/r2.git', 'acme').id;
    const cand = spec.createCandidate(evil, repo, 's', 'b', userId).id;
    for (const path of [`/app/specs/${evil}`, `/app/candidates/${cand}`]) {
      const html = await (await ui(path)).text();
      expect(html, path).not.toContain('<script>alert(1)');
      expect(html, path).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    }
  });

  it('keeps 404 for unknown spec, candidate and trial and 502 for a DO failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const kind of ['specs', 'candidates', 'trials']) expect((await ui(`/app/${kind}/missing`)).status, kind).toBe(404);
    overrides.push((req) => (new URL(req.url).pathname === '/api/promotions' ? Response.json({ success: false, error: 'boom' }, { status: 500 }) : undefined));
    for (const path of [`/app/specs/${specId}`, `/app/candidates/${c1}`, `/app/trials/${trialId}`]) {
      const res = await ui(path);
      expect(res.status, path).toBe(502);
      expect(await res.text()).toContain('could not load this page');
    }
  });
});
