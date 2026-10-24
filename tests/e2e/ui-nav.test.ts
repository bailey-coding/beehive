/**
 * Site navigation E2E (local only): the layout, breadcrumbs, navbar and org switcher against the
 * real beehive worker and Spec DO. Needs the workers started with E2E_UI=1
 * (scripts/start-e2e-workers.sh gives the beehive worker dummy GitHub OAuth vars). OAuth is never
 * exercised: the session cookie is forged with signSession and the local API_AUTH_TOKEN.
 *
 * Only links to organizations THIS run created are followed (other suites' orgs vanish mid-run);
 * the switcher cap is asserted by count, never by specific names. Cleanup: tombstone + purge by prefix.
 * Never runs against production.
 *
 * Task: L8 | Spec: docs/M9-NAV-PLAN.md#5
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getConfig } from './config';
import { createRequest, ensureMaintainer, readJson } from './helpers';
import { signSession } from '../../workers/api/ui';

const config = getConfig();
const isLocal = config.environment === 'local';
const PREFIX = 'e2e-ui-nav-';

async function api(path: string, method = 'GET', body?: unknown, actorId?: string) {
  const res = await fetch(createRequest(path, method, body, actorId ? { 'X-Actor-ID': actorId } : {}));
  return { status: res.status, json: await readJson(res).catch(() => ({})) };
}

/** The UI answers 503 when the worker has no GitHub vars (E2E_UI unset): then this suite skips. */
async function uiConfigured(): Promise<boolean> {
  if (!isLocal) return false;
  try {
    const res = await fetch(`${config.baseUrl}/app`, { redirect: 'manual' });
    return res.status !== 503;
  } catch {
    return false;
  }
}

const enabled = await uiConfigured();

describe.skipIf(!isLocal || !enabled)('Site navigation (local UI)', () => {
  const runId = `${PREFIX}${Date.now()}`;
  const origin = new URL(config.baseUrl).origin;
  const orgIds: string[] = [];
  let maintainer: string;
  let creator: string;
  let cookie: string;
  let mainOrgId: string;
  let mainOrgName: string;
  let repoId: string;
  let specId: string;
  let candidateId: string;
  let trialId: string;
  let issueId: string;

  async function get(path: string, redirect: RequestRedirect = 'manual') {
    return fetch(`${config.baseUrl}${path}`, { headers: { Cookie: cookie }, redirect });
  }

  async function post(path: string, form: Record<string, string>, originHeader: string | null = origin) {
    const headers: Record<string, string> = { Cookie: cookie };
    if (originHeader !== null) headers.Origin = originHeader;
    return fetch(`${config.baseUrl}${path}`, { method: 'POST', headers, body: new URLSearchParams(form), redirect: 'manual' });
  }

  const count = (html: string, needle: string) => html.split(needle).length - 1;
  const between = (html: string, from: string, to: string) => {
    const a = html.indexOf(from);
    const b = html.indexOf(to, a);
    return a < 0 || b < 0 ? '' : html.slice(a, b);
  };
  const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);

  async function createOrg(name: string): Promise<string> {
    const org = await api('/api/organizations', 'POST', { name, type: 'artifacts' }, maintainer);
    expect(org.status).toBe(201);
    const id = (org.json.data as { id: string }).id;
    orgIds.push(id);
    return id;
  }

  beforeAll(async () => {
    maintainer = await ensureMaintainer(api, 'e2e-ui-nav-maintainer');
    creator = ((await api('/api/actors', 'POST', { type: 'human', name: 'e2e-ui-nav-creator' })).json.data as { id: string }).id;
    const session = await signSession({ login: 'e2e-ui-user', actorId: creator, exp: Math.floor(Date.now() / 1000) + 3600 }, config.apiToken);
    cookie = `__Host-beehive_session=${session}`;

    mainOrgName = `${runId}-main`;
    mainOrgId = await createOrg(mainOrgName);
    // 24 more so the switcher cap (20) is exceeded whatever else the local ledger holds
    for (let i = 0; i < 24; i++) await createOrg(`${runId}-${String(i).padStart(2, '0')}`);

    const repo = await api('/api/repositories', 'POST', {
      name: 'shop', organizationId: mainOrgId, repoType: 'baseline', remoteUrl: 'https://example.invalid/r.git', namespace: 'ns',
    }, maintainer);
    expect(repo.status).toBe(201);
    repoId = (repo.json.data as { id: string }).id;
    const spec = await api('/api/specs', 'POST', { name: 'pricing', contract: '{}', declaredDeltaSurface: [], organizationId: mainOrgId }, maintainer);
    expect(spec.status).toBe(201);
    specId = (spec.json.data as { id: string }).id;
    const cands: string[] = [];
    for (const sha of ['abc', 'def']) {
      const c = await api('/api/candidates', 'POST', { specId, repositoryId: repoId, commitSha: sha, baseCommitSha: 'base' }, maintainer);
      expect(c.status).toBe(201);
      cands.push((c.json.data as { id: string }).id);
    }
    candidateId = cands[0];
    const trial = await api('/api/trials', 'POST', { specId, candidateAId: cands[0], candidateBId: cands[1] }, maintainer);
    expect(trial.status).toBe(201);
    trialId = (trial.json.data as { id: string }).id;
    const issue = await api('/api/issues', 'POST', { repositoryId: repoId, title: 'nav issue' }, creator);
    expect(issue.status).toBe(201);
    issueId = (issue.json.data as { id: string }).id;
  });

  afterAll(async () => {
    for (const id of orgIds) await api(`/api/organizations/${id}`, 'DELETE', { reason: 'e2e ui-nav cleanup' }, maintainer);
    if (!orgIds.length) return;
    const dry = await api('/api/admin/purge', 'POST', { orgNamePrefix: PREFIX }, maintainer);
    const total = (dry.json.data as { total: number }).total;
    await api('/api/admin/purge', 'POST', { orgNamePrefix: PREFIX, dryRun: false, confirm: total }, maintainer);
  });

  const pages = () => [
    ['dashboard', '/app'],
    ['org', `/app/orgs/${mainOrgId}`],
    ['repo (3-part)', `/app/repos/${mainOrgName}/ns/shop`],
    ['repo (UUID)', `/app/repos/${repoId}`],
    ['issues list', `/app/repos/${mainOrgName}/ns/shop/issues`],
    ['issue new', `/app/repos/${mainOrgName}/ns/shop/issues/new`],
    ['issue detail', `/app/repos/${mainOrgName}/ns/shop/issues/${issueId}`],
    ['spec', `/app/specs/${specId}`],
    ['candidate', `/app/candidates/${candidateId}`],
    ['trial', `/app/trials/${trialId}`],
  ] as const;

  it('every page type renders the layout: skip link, one h1, primary nav, search, sign-out', async () => {
    for (const [name, path] of pages()) {
      const res = await get(path);
      expect(res.status, name).toBe(200);
      const html = await res.text();
      expect(html, name).toContain('<a class="site-skip" href="#main">');
      expect(count(html, '<h1>'), name).toBe(1);
      expect(html, name).toContain('<nav aria-label="Primary">');
      expect(html, name).toContain('role="search"');
      expect(count(html, 'action="/logout"'), name).toBe(1);
      expect(html, name).not.toContain('class="subbar"');
      expect(count(html, 'class="flash'), name).toBe(0);
    }
  });

  it('every breadcrumb and navbar link on every page answers 200; own-suite switcher links too', async () => {
    const followed = new Set<string>();
    for (const [name, path] of pages()) {
      const html = await (await get(path)).text();
      const crumbs = hrefs(between(html, '<nav class="site-crumbs"', '</nav>'));
      const primary = hrefs(between(html, '<nav aria-label="Primary">', '</nav>'));
      const switcher = between(html, '<details class="site-orgs">', '</details>');
      // switcher links to orgs of this run only (other suites' orgs may be purged mid-run)
      const own = [...switcher.matchAll(/<a href="([^"]+)"[^>]*><bdi>([^<]*)<\/bdi>/g)]
        .filter((m) => m[2].startsWith(runId))
        .map((m) => m[1]);
      for (const href of [...crumbs, ...primary, ...own]) {
        const target = href.split('#')[0];
        if (followed.has(target)) continue;
        followed.add(target);
        const res = await get(target);
        expect(res.status, `${name}: ${target}`).toBe(200);
        await res.arrayBuffer();
      }
    }
    expect(followed.has('/app')).toBe(true);
    expect(followed.has(`/app/orgs/${mainOrgId}`)).toBe(true);
    expect(followed.has(`/app/repos/${mainOrgName}/ns/shop/issues`)).toBe(true);
  });

  it('breadcrumb trails name the real hierarchy', async () => {
    const issue = await (await get(`/app/repos/${mainOrgName}/ns/shop/issues/${issueId}`)).text();
    const trail = between(issue, '<nav class="site-crumbs"', '</nav>');
    const labels = [...trail.matchAll(/<bdi[^>]*>([^<]*)<\/bdi>/g)].map((m) => m[1]);
    expect(labels).toEqual(['Dashboard', mainOrgName, 'shop', 'Issues', '#1']);
    expect(issue).toContain('<li aria-current="page"><bdi>#1</bdi></li>');
    const trialHtml = await (await get(`/app/trials/${trialId}`)).text();
    const trialLabels = [...between(trialHtml, '<nav class="site-crumbs"', '</nav>').matchAll(/<bdi[^>]*>([^<]*)<\/bdi>/g)].map((m) => m[1]);
    expect(trialLabels).toEqual(['Dashboard', mainOrgName, 'pricing', `Trial ${trialId.slice(0, 8)}`]);
  });

  it('the org switcher shows at most 20 organizations and links to all of them', async () => {
    const html = await (await get('/app')).text();
    const switcher = between(html, '<details class="site-orgs">', '</details>');
    expect(count(switcher, 'href="/app/orgs/')).toBeLessThanOrEqual(20);
    expect(switcher).toMatch(/All organizations \((\d+\+?)\)<\/a>/);
    const total = Number(/All organizations \((\d+)/.exec(switcher)?.[1] ?? '0');
    expect(total).toBeGreaterThanOrEqual(25);
    // on an org page the current org is listed first, whatever its name sorts like
    const orgPage = await (await get(`/app/orgs/${mainOrgId}`)).text();
    const first = between(orgPage, '<details class="site-orgs">', '</details>').match(/<a href="([^"]+)"/)?.[1];
    expect(first).toBe(`/app/orgs/${mainOrgId}`);
    expect(orgPage).toContain(`<a href="/app/orgs/${mainOrgId}" aria-current="page">`);
  });

  it('create org, repo, spec and issue through the forms still work, each with exactly one flash', async () => {
    const orgName = `${runId}-form`;
    const org = await post('/app/organizations', { name: orgName, type: 'artifacts' });
    expect(org.status).toBe(302);
    const location = org.headers.get('location') as string;
    expect(decodeURIComponent(location)).toContain(`?ok=Created organization ${orgName}`);
    const landed = await (await get(location)).text();
    expect(count(landed, 'class="flash'), 'one flash after a create redirect').toBe(1);
    expect(landed).toContain(`Created organization ${orgName}`);
    const created = (await api('/api/organizations?limit=1000')).json.data as { id: string; name: string }[];
    const formOrg = created.find((o) => o.name === orgName);
    expect(formOrg).toBeDefined();
    orgIds.push(formOrg!.id);

    const repo = await post('/app/repositories', {
      name: 'formrepo', organizationId: formOrg!.id, repoType: 'baseline', remoteUrl: 'https://example.invalid/f.git', namespace: 'ns',
    });
    expect(decodeURIComponent(repo.headers.get('location') as string)).toContain('?ok=Created repository formrepo');
    const spec = await post('/app/specs', { name: 'formspec', organizationId: formOrg!.id, contract: '{}' });
    expect(decodeURIComponent(spec.headers.get('location') as string)).toContain('?ok=Created spec formspec');
    const issue = await post(`/app/repos/${mainOrgName}/ns/shop/issues`, { title: 'form issue' });
    expect(issue.status).toBe(302);
    const issueLanded = await (await get(issue.headers.get('location') as string)).text();
    expect(count(issueLanded, 'class="flash')).toBe(1);
  });

  it('status pages keep their codes and render inside the layout', async () => {
    const missing = await get('/app/specs/does-not-exist');
    expect(missing.status).toBe(404);
    const html = await missing.text();
    expect(html).toContain('<nav class="site-crumbs" aria-label="Breadcrumb">');
    expect(html).toContain('<li aria-current="page"><bdi>Not found</bdi></li>');
    const wrongMethod = await post(`/app/repos/${mainOrgName}/ns/shop/issues/${issueId}`, {});
    expect(wrongMethod.status).toBe(405);
    const crossOrigin = await post('/app/organizations', { name: 'x', type: 'artifacts' }, 'http://evil.example');
    expect(crossOrigin.status).toBe(403);
    expect(await crossOrigin.text()).toContain('<li aria-current="page"><bdi>Forbidden</bdi></li>');
  });

  it('sign out clears the cookie and goes to /about; the pre-session shell links the brand to /about', async () => {
    const out = await post('/logout', {});
    expect(out.status).toBe(302);
    expect(out.headers.get('location')).toBe('/about');
    expect(out.headers.get('set-cookie') ?? '').toMatch(/__Host-beehive_session=;.*Max-Age=0/);
    const refused = await post('/logout', {}, 'http://evil.example');
    expect(refused.status).toBe(403);
    const html = await refused.text();
    expect(html).toContain('<a class="site-brand" href="/about">Beehive</a>');
    expect(html).not.toContain('aria-label="Primary"');
  });
});
