/**
 * App layout (M9 L1): landmarks, navigation state, org switcher, breadcrumb builders, escaping
 * rules, flash markup and the shared CSS fixes. Pure string assertions; no DOM library.
 *
 * Task: L1 | Spec: docs/M9-NAV-PLAN.md#2
 */
import { describe, it, expect } from 'vitest';
import {
  appPage, statusPage, renderAccount, isAppHref,
  dashboardCrumb, orgCrumb, repoCrumbs, issuesCrumbs, specCrumbs, candidateCrumbs, trialCrumbs,
  type Chrome, type LayoutOpts, type NavOrgs, type Crumb,
} from '../ui-layout';
import { PAGE_CSS, flash, tabs } from '../ui-html';
import { buildRepoUrl } from '../ui-repo-ref';

function chrome(orgs: NavOrgs = { skipped: true }, path = '/app', login = 'testuser', query = ''): Chrome {
  return { login, url: new URL(`http://localhost${path}${query}`), orgs };
}

const base: LayoutOpts = { title: 'Dashboard', crumbs: [], section: null };

async function render(c: Chrome, opts: Partial<LayoutOpts> = {}, body = '<p>body</p>'): Promise<string> {
  const res = await appPage(async () => c, { ...base, ...opts }, body);
  return res.text();
}

const count = (html: string, needle: string | RegExp) =>
  typeof needle === 'string' ? html.split(needle).length - 1 : (html.match(needle) ?? []).length;

describe('appPage landmarks', () => {
  it('has the skip link first, one h1, one main#main, a labelled nav, a search role and a sign-out form', async () => {
    const html = await render(chrome(), { crumbs: [dashboardCrumb(), { label: 'Here' }] });
    expect(html.indexOf('<body><a class="site-skip" href="#main">')).toBeGreaterThan(0);
    expect(count(html, '<h1>')).toBe(1);
    expect(count(html, '<main id="main"')).toBe(1);
    expect(html).toContain('<nav aria-label="Primary">');
    expect(html).toContain('<nav class="site-crumbs" aria-label="Breadcrumb">');
    expect(html).toContain('role="search"');
    expect(html).toContain('<label class="site-sr" for="site-q">Search (mocked)</label>');
    expect(html).toContain('badge mock');
    expect(html).toContain('<form method="POST" action="/logout"><button class="link">Sign out</button></form>');
    expect(html).toContain('<title>Dashboard - Beehive</title>');
  });

  it('escapes the login and the title', async () => {
    const html = await render(chrome({ skipped: true }, '/app', '<script>alert(1)</script>'), { title: '<img onerror=x>' });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img onerror');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('answers with the given status, no-store and the heading override', async () => {
    const res = await appPage(async () => chrome(), { ...base, status: 404, heading: 'Custom' }, '');
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.text()).toContain('<h1>Custom</h1>');
  });

  it('renders the flash once, inside main, with live-region roles', async () => {
    const html = await render(chrome({ skipped: true }, '/app', 'u', '?ok=Done&error=Bad'));
    expect(count(html, 'class="flash')).toBe(2);
    expect(html).toContain('<div role="status"><p class="flash ok">Done</p></div>');
    expect(html).toContain('<div role="alert"><p class="flash err">Bad</p></div>');
    expect(html.indexOf('<main')).toBeLessThan(html.indexOf('class="flash'));
    expect(await render(chrome({ skipped: true }, '/app', 'u', '?ok=Done'), { flash: false })).not.toContain('class="flash');
  });
});

describe('primary nav and aria-current', () => {
  it('on /app only Dashboard is "page"; the anchor items never are', async () => {
    const html = await render(chrome());
    expect(html).toContain('<a href="/app" aria-current="page">Dashboard</a>');
    expect(count(html, 'aria-current="page"')).toBe(1);
    expect(html).toContain('<a href="/app#repositories">Repositories</a>');
    expect(html).toContain('<a href="/app#specs">Specs</a>');
  });

  it('marks the section with aria-current="true", never "page"', async () => {
    const specs = await render(chrome({ skipped: true }, '/app/specs/s1'), { section: 'specs' });
    expect(specs).toContain('<a href="/app#specs" aria-current="true">Specs</a>');
    expect(specs).not.toContain('<a href="/app" aria-current');
    const repos = await render(chrome({ skipped: true }, '/app/repos/r1'), { section: 'repos', repoUrl: '/app/repos/r1' });
    expect(repos).toContain('<a href="/app#repositories" aria-current="true">Repositories</a>');
    const issues = await render(chrome({ skipped: true }, '/app/repos/r1/issues'), { section: 'issues', repoUrl: '/app/repos/r1' });
    expect(issues).toContain('<a href="/app/repos/r1/issues" aria-current="true">Issues</a>');
    const none = await render(chrome({ skipped: true }, '/app/orgs/o1'), { section: null });
    expect(none).not.toContain('aria-current="true"');
  });

  it('shows Issues only inside a repo', async () => {
    expect(await render(chrome())).not.toContain('>Issues<');
    const inRepo = await render(chrome(), { repoUrl: '/app/repos/acme/widgets', section: 'repos' });
    expect(inRepo).toContain('<a href="/app/repos/acme/widgets/issues">Issues</a>');
    // a repoUrl outside /app is not rendered as a link
    expect(await render(chrome(), { repoUrl: '//evil.example', section: 'repos' })).not.toContain('evil.example');
  });
});

describe('organization switcher', () => {
  const org = (n: number) => ({ id: `org-${String(n).padStart(3, '0')}`, name: `Org ${String(n).padStart(3, '0')}` });
  const many = Array.from({ length: 30 }, (_, i) => org(i));

  it('lists 20, current first, then "All organizations (N)"', async () => {
    const html = await render(chrome({ ok: true, orgs: many, total: 30 }, '/app/orgs/org-025'), { orgId: 'org-025' });
    const switcher = html.slice(html.indexOf('<details class="site-orgs">'), html.indexOf('</details>'));
    expect(count(switcher, '/app/orgs/')).toBe(20);
    expect(switcher).toContain('<summary>Org: <bdi>Org 025</bdi></summary>');
    expect(switcher.indexOf('org-025')).toBeLessThan(switcher.indexOf('org-000'));
    expect(switcher).toContain('<a href="/app/orgs/org-025" aria-current="page">');
    expect(switcher).toContain('All organizations (30)</a>');
  });

  it('marks the current org "true" on a page inside that org', async () => {
    const html = await render(chrome({ ok: true, orgs: [org(1)], total: 1 }, '/app/specs/s'), { orgId: 'org-001' });
    expect(html).toContain('<a href="/app/orgs/org-001" aria-current="true">');
    expect(html).not.toContain('All organizations');
  });

  it('reads 500+ when the read hit its cap', async () => {
    const html = await render(chrome({ ok: true, orgs: many, total: 500 }));
    expect(html).toContain('All organizations (500+)');
  });

  it('shows "No organizations" and a create link when there are none', async () => {
    const html = await render(chrome({ ok: true, orgs: [], total: 0 }));
    expect(html).toContain('No organizations');
    expect(html).toContain('<a href="/app#organizations">Create one</a>');
  });

  it('a failed read says unavailable, never "No organizations"', async () => {
    const html = await render(chrome({ ok: false }));
    expect(html).toContain('Organizations unavailable');
    expect(html).not.toContain('No organizations');
  });

  it('skipped (light chrome) is a plain Organizations link', async () => {
    const html = await render(chrome({ skipped: true }));
    expect(html).toContain('<a class="site-orgs" href="/app#organizations">Organizations</a>');
    expect(html).not.toContain('<details class="site-orgs">');
  });

  it('escapes hostile names, isolates bidi text and truncates long names', async () => {
    const evil = { id: 'evil', name: '"><img src=x onerror=alert(1)>' };
    const rtl = { id: 'rtl', name: 'a‮b' };
    const long = { id: 'long', name: 'x'.repeat(100) };
    const html = await render(chrome({ ok: true, orgs: [evil, rtl, long], total: 3 }));
    expect(html).not.toContain('<img');
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('<bdi>a‮b</bdi>');
    expect(html).toContain(`<bdi title="${'x'.repeat(100)}">${'x'.repeat(40)}…</bdi>`);
  });
});

describe('search', () => {
  it('prefills the escaped query and submits to the action without the query in it', async () => {
    const html = await render(chrome(), { searchAction: '/app/orgs/o1#search', query: '"><b>x' });
    expect(html).toContain('action="/app/orgs/o1#search"');
    expect(html).toContain('value="&quot;&gt;&lt;b&gt;x"');
    expect(html).not.toContain('<b>x');
    expect(count(html, 'name="q"')).toBe(1);
  });

  it('is disabled with a hint when there is no action, or the action is not an app path', async () => {
    for (const searchAction of [undefined, '//evil.example', 'javascript:alert(1)', '/appx']) {
      const html = await render(chrome(), { searchAction });
      expect(html).toContain('disabled placeholder="Open an organization or repository to search"');
      expect(html).not.toContain('evil.example');
    }
  });
});

describe('breadcrumb trail', () => {
  const org = { id: 'o1', name: 'Acme' };
  const repo = { id: 'r1', name: 'widgets', organization_id: 'o1', namespace: 'Acme' };
  const ref = { repo, org, repoUrl: buildRepoUrl(repo, [org]) };

  it('links every crumb but the last, which is text with aria-current', async () => {
    const html = await render(chrome(), { crumbs: [dashboardCrumb(), orgCrumb(org)!, { label: 'Here', href: '/app/x' }] });
    expect(html).toContain('<li><a href="/app"><bdi>Dashboard</bdi></a></li>');
    expect(html).toContain('<li><a href="/app/orgs/o1"><bdi>Acme</bdi></a></li>');
    expect(html).toContain('<li aria-current="page"><bdi>Here</bdi></li>');
    expect(html).not.toContain('href="/app/x"');
  });

  it('builds repo and issue trails with the repo URL as is (no double escape)', () => {
    expect(repoCrumbs(ref).map((c) => [c.label, c.href])).toEqual([
      ['Dashboard', '/app'], ['Acme', '/app/orgs/o1'], ['widgets', '/app/repos/Acme/widgets'],
    ]);
    expect(issuesCrumbs(ref, undefined, '#12').map((c) => c.label)).toEqual(['Dashboard', 'Acme', 'widgets', 'Issues', '#12']);
    expect(issuesCrumbs(ref)[3].href).toBe('/app/repos/Acme/widgets/issues');
    // a UUID-fallback URL containing an escaped quote is not escaped a second time
    const odd = { repo: { id: "a'b" }, org: null, repoUrl: buildRepoUrl({ id: "a'b" }, []) };
    const crumb = repoCrumbs(odd).at(-1) as Crumb;
    expect(crumb.href).toBe('/app/repos/a\'b'.replace("'", '&#39;'));
  });

  it('drops the crumb of a missing org row and never invents a label', () => {
    expect(repoCrumbs({ ...ref, org: null }).map((c) => c.label)).toEqual(['Dashboard', 'widgets']);
    expect(orgCrumb(null)).toBeNull();
    expect(orgCrumb({ id: 'o1' })).toBeNull();
    expect(specCrumbs({ id: 's1', name: 'Pricing' }).map((c) => c.label)).toEqual(['Dashboard', 'Pricing']);
  });

  it('builds spec, candidate and trial trails; an invalid id renders text, not a link', async () => {
    const spec = { id: 's1', name: 'Pricing' };
    expect(specCrumbs(spec, org).map((c) => c.href)).toEqual(['/app', '/app/orgs/o1', '/app/specs/s1']);
    expect(candidateCrumbs({ id: 'abcd1234ffff' }, spec, org).map((c) => c.label)).toEqual(['Dashboard', 'Acme', 'Pricing', 'Candidate abcd1234']);
    expect(trialCrumbs({ id: 'beef5678ffff' }, spec, org).at(-1)?.label).toBe('Trial beef5678');
    expect(candidateCrumbs({ id: 'abcd1234ffff' }).map((c) => c.label)).toEqual(['Dashboard', 'Candidate abcd1234']);
    const bad = specCrumbs({ id: 'a/b', name: 'Odd' }, { id: 'x y', name: 'Bad Org' });
    expect(bad.map((c) => c.href)).toEqual(['/app', undefined, undefined]);
    const html = await render(chrome(), { crumbs: [...bad, { label: 'End' }] });
    expect(html).toContain('<li><bdi>Bad Org</bdi></li>');
  });

  it('renders a crumb with an unsafe href as text, not a link (guard applied at render time)', async () => {
    const crumbs = [
      { label: 'js', href: 'javascript:alert(1)' },
      { label: 'proto', href: '//evil.example/x' },
      { label: 'prefix', href: '/appx' },
      { label: 'quote', href: '/app/x"onmouseover="y' },
      { label: 'End' },
    ];
    const html = await render(chrome(), { crumbs });
    const trail = html.slice(html.indexOf('<nav class="site-crumbs"'), html.indexOf('</nav>', html.indexOf('<nav class="site-crumbs"')));
    expect(trail).not.toContain('href=');
    expect(trail).not.toContain('evil.example');
    for (const label of ['js', 'proto', 'prefix', 'quote']) expect(trail).toContain(`<li><bdi>${label}</bdi></li>`);
  });

  it('escapes crumb labels', async () => {
    const html = await render(chrome(), { crumbs: [dashboardCrumb(), { label: '<script>1</script>' }] });
    expect(html).not.toContain('<script>1');
  });

  it('accepts only /app hrefs', () => {
    for (const ok of ['/app', '/app/orgs/o1', '/app#repositories', '/app?x=1', '/app/repos/a&#39;b']) expect(isAppHref(ok), ok).toBe(true);
    for (const bad of ['/appx', '//evil', 'javascript:alert(1)', 'http://x', '/app/"x', '/app/<x', '/app x', '', undefined]) {
      expect(isAppHref(bad), String(bad)).toBe(false);
    }
  });
});

describe('statusPage', () => {
  it('renders heading, message and a Dashboard > heading trail without a flash', async () => {
    const res = await statusPage(async () => chrome({ skipped: true }, '/app/zzz', 'u', '?ok=hi'), 404, 'Not found', 'Nothing here. <a href="/app">Back to dashboard</a>');
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('<h1>Not found</h1>');
    expect(html).toContain('<li aria-current="page"><bdi>Not found</bdi></li>');
    expect(html).toContain('Back to dashboard');
    expect(html).not.toContain('class="flash');
  });
});

describe('flash, tabs, account', () => {
  it('flash text is capped at 300 characters and escaped', () => {
    const html = flash(new URL(`http://x/?ok=${'a'.repeat(400)}&error=${encodeURIComponent('<b>')}`));
    expect(html).toContain(`${'a'.repeat(300)}…`);
    expect(html).not.toContain('a'.repeat(301));
    expect(html).toContain('&lt;b&gt;');
  });

  it('ok and error differ by more than colour: a bold "Done:" / "Error:" lead-in (WCAG 1.4.1)', () => {
    const ok = flash(new URL('http://x/?ok=Saved'));
    const err = flash(new URL('http://x/?error=Nope'));
    // the <p> shape is pinned by ui-issues.test.ts; the lead-in is generated by the stylesheet
    expect(ok).toContain('<p class="flash ok">Saved</p>');
    expect(err).toContain('<p class="flash err">Nope</p>');
    expect(PAGE_CSS).toMatch(/\.flash\.ok::before \{ content: 'Done: '; font-weight: 700; \}/);
    expect(PAGE_CSS).toMatch(/\.flash\.err::before \{ content: 'Error: '; font-weight: 700; \}/);
  });

  it('tabs are labelled and mark the active one', () => {
    const html = tabs('/app/repos/r', 'issues', ['overview', 'issues']);
    expect(html).toContain('<nav class="tabs" aria-label="Repository sections">');
    expect(html).toContain('aria-current="page" class="tab active">issues<');
    expect(html).toContain('class="tab ">overview<');
  });

  it('renderAccount shows the login and the sign-out form', () => {
    const html = renderAccount(chrome());
    expect(html).toContain('Signed in as <strong><bdi>testuser</bdi></strong>');
    expect(html).toContain('action="/logout"');
  });

  it('renderAccount links to the API tokens settings page (M12), before sign-out', () => {
    const html = renderAccount(chrome());
    expect(html).toContain('<a href="/app/settings/tokens">API tokens</a>');
    expect(html.indexOf('/app/settings/tokens')).toBeLessThan(html.indexOf('action="/logout"'));
  });
});

describe('PAGE_CSS', () => {
  it('has no outline: none, so :focus-visible applies to inputs', () => {
    expect(PAGE_CSS).not.toContain('outline: none');
    expect(PAGE_CSS).toContain(':focus-visible { outline: 2px solid #58a6ff');
  });

  it('scopes the file-tree rules away from the org switcher and fixes the open marker', () => {
    expect(PAGE_CSS).not.toMatch(/(^|\n)\s*summary::before/);
    expect(PAGE_CSS).not.toMatch(/(^|\n)\s*details \{/);
    expect(PAGE_CSS).not.toContain('summary[open]');
    expect(PAGE_CSS).toContain('details[open]:not(.site-orgs) > summary::before');
  });

  // WCAG 2.x contrast ratio of two #rrggbb colours
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  it.each([
    ['link', '#58a6ff', '#0d1117'],
    ['muted', '#8b949e', '#0d1117'],
    ['muted on panel', '#8b949e', '#161b22'],
    ['flash text ok', '#e6edf3', '#12261a'],
    ['flash text err', '#e6edf3', '#2d1417'],
    ['badge green', '#3fb950', '#12261a'],
    ['badge red', '#f85149', '#2d1417'],
    ['mock badge', '#8b949e', '#211c13'],
  ])('%s is at least 4.5:1', (_n, fg, bg) => {
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('uses the new badge and flash colours in the stylesheet', () => {
    expect(PAGE_CSS).toContain('.badge.passed { background: #12261a; color: #3fb950');
    expect(PAGE_CSS).toContain('.badge.failed { background: #2d1417; color: #f85149');
    expect(PAGE_CSS).not.toMatch(/color: #238636;/);
    expect(PAGE_CSS).not.toMatch(/color: #da3633;/);
  });
});
