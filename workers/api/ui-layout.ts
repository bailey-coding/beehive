/**
 * App layout for the session pages (docs/M9-NAV-PLAN.md section 2): skip link, header with
 * brand, primary nav, organization switcher, search and account, breadcrumb trail, `<main>` with
 * the page title, the flash and the page body. One module renders all of it, so a page cannot
 * forget the navigation or render the flash twice.
 *
 * Pure except `loadChrome`, the only place that reads the organization list for the switcher.
 * No JavaScript: the switcher is a `<details>`, the search a plain GET form.
 */

import { esc, flash, isValidId, mockedLabel, pick, PAGE_CSS, type SafeHtml } from './ui-html';
import type { DoReader, DoRow, Session } from './ui-pages';

function safe(s: string): SafeHtml {
  return s as SafeHtml;
}

// ============================================================================
// Types
// ============================================================================

/** Which primary nav item is "the section" of a page; org and status pages use null. */
export type NavSection = 'repos' | 'specs' | 'issues' | null;

/**
 * One breadcrumb. `href` is an HTML-safe app path (builders encode and escape it; `buildRepoUrl`
 * output is already escaped and is used as is). No href, or an href outside `/app`, renders text.
 */
export interface Crumb {
  label: string;
  href?: string;
}

export type NavOrgs =
  | { ok: true; orgs: { id: string; name: string }[]; total: number }
  | { ok: false }
  | { skipped: true };

/** Per-request navigation data. An interface so later milestones can add a user menu or counts. */
export interface Chrome {
  login: string;
  url: URL;
  orgs: NavOrgs;
}

/** Built once per request; a page awaits it only when it is about to render. */
export type ChromeSource = () => Promise<Chrome>;

export interface LayoutOpts {
  /** `<title>` text and, unless `heading` is set, the `<h1>`. */
  title: string;
  heading?: string;
  crumbs: Crumb[];
  section: NavSection;
  /** Current organization, for the switcher. */
  orgId?: string;
  /** Escaped repo URL (from `buildRepoUrl`); enables the "Issues" nav item. */
  repoUrl?: string;
  /** HTML-safe `/app` path the search form submits to (GET `?q=`); absent = search disabled. */
  searchAction?: string;
  query?: string;
  status?: number;
  /** Render the `ok`/`error` flash from the URL (default true). */
  flash?: boolean;
}

// ============================================================================
// Chrome source (lazy, method-aware)
// ============================================================================


/** Memoise an async function: the in-flight promise is shared, rejections included. */
export function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | undefined;
  return () => (p ??= fn());
}

/** The light chrome: no organization list, and therefore no Spec DO read. */
export function lightChrome(session: Session, url: URL): Chrome {
  return { login: session.login, url, orgs: { skipped: true } };
}

/**
 * Reads the organization list for the switcher. Never throws: a Spec DO failure (including a 404,
 * which the reader raises as an error) becomes `{ ok: false }`, which renders as "unavailable",
 * never as "no organizations". A reply the reader maps to `[]` (non-array data) still shows as none.
 */
export async function loadChrome(reader: DoReader, session: Session, url: URL): Promise<Chrome> {
  try {
    const rows = await reader.list('/api/organizations', ORG_READ_LIMIT);
    const orgs = rows
      .map((o) => ({ id: pick(o, 'id'), name: pick(o, 'name') }))
      .filter((o) => isValidId(o.id));
    return { login: session.login, url, orgs: { ok: true, orgs, total: orgs.length } };
  } catch (error) {
    console.error('Navigation organization list error:', error);
    return { login: session.login, url, orgs: { ok: false } };
  }
}

/**
 * The per-request source. GET/HEAD pages read the organization list (once, only when a page
 * renders); every other method gets the light chrome, so writes, refused writes and the
 * cross-origin 403 add no read.
 */
export function makeChromeSource(method: string, reader: DoReader, session: Session, url: URL): ChromeSource {
  if (method === 'GET' || method === 'HEAD') return once(() => loadChrome(reader, session, url));
  return once(async () => lightChrome(session, url));
}

/**
 * Wraps a reader so identical reads within one request share one in-flight promise (rejections
 * too). Used for GET requests only, so the navigation read and a page's own `Promise.all` do not
 * read the same list twice.
 */
export function memoizeReader(reader: DoReader): DoReader {
  const gets = new Map<string, Promise<DoRow | null>>();
  const lists = new Map<string, Promise<DoRow[]>>();
  return {
    get: (path) => {
      let p = gets.get(path);
      if (!p) gets.set(path, (p = reader.get(path)));
      return p;
    },
    list: (path, limit) => {
      const key = `${path}|${limit ?? ''}`;
      let p = lists.get(key);
      if (!p) lists.set(key, (p = reader.list(path, limit)));
      return p;
    },
  };
}

const SWITCHER_LIMIT = 20;
const ORG_READ_LIMIT = 500;

// ============================================================================
// Text and href rules (plan 2.4)
// ============================================================================

const MAX_LABEL_CHARS = 40;

/** Truncated to 40 code points, escaped, full text in `title`, isolated for bidi (`<bdi>`). */
function labelHtml(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= MAX_LABEL_CHARS) return `<bdi>${esc(text)}</bdi>`;
  return `<bdi title="${esc(text)}">${esc(`${chars.slice(0, MAX_LABEL_CHARS).join('')}…`)}</bdi>`;
}

/**
 * An href is rendered only when it is `/app` or starts `/app/`, `/app?` or `/app#` and carries
 * no quote, angle bracket or whitespace (`/appx`, `//evil`, `javascript:` all fail).
 */
export function isAppHref(href: string | undefined): href is string {
  return !!href && /^\/app(?:[/?#][^"'<>\s]*)?$/.test(href);
}

function appHref(kind: 'orgs' | 'specs' | 'candidates' | 'trials', id: string): string | undefined {
  return isValidId(id) ? `/app/${kind}/${esc(encodeURIComponent(id))}` : undefined;
}

// ============================================================================
// Breadcrumb trail builders (pure)
// ============================================================================

export function dashboardCrumb(): Crumb {
  return { label: 'Dashboard', href: '/app' };
}

/** A missing or tombstoned org row has no crumb: never an invented label. */
export function orgCrumb(org: DoRow | null | undefined): Crumb | null {
  if (!org) return null;
  const name = pick(org, 'name');
  if (!name) return null;
  return { label: name, href: appHref('orgs', pick(org, 'id')) };
}

function trail(...parts: Array<Crumb | Array<Crumb | null> | null | undefined>): Crumb[] {
  return parts.flat().filter((c): c is Crumb => !!c);
}

export function repoCrumbs(ref: { repo: DoRow; org: DoRow | null; repoUrl: string }, org?: DoRow | null): Crumb[] {
  return trail(dashboardCrumb(), orgCrumb(org ?? ref.org), { label: pick(ref.repo, 'name') || 'Repository', href: ref.repoUrl });
}

/** `... > repo > Issues [> tail]`; the tail is the current page (`#12`, `New`). */
export function issuesCrumbs(ref: { repo: DoRow; org: DoRow | null; repoUrl: string }, org?: DoRow | null, tail?: string): Crumb[] {
  return trail(repoCrumbs(ref, org), { label: 'Issues', href: `${ref.repoUrl}/issues` }, tail ? { label: tail } : null);
}

export function specCrumbs(spec: DoRow, org?: DoRow | null): Crumb[] {
  return trail(dashboardCrumb(), orgCrumb(org), { label: pick(spec, 'name') || 'Spec', href: appHref('specs', pick(spec, 'id')) });
}

export function candidateCrumbs(candidate: DoRow, spec?: DoRow | null, org?: DoRow | null): Crumb[] {
  const label = `Candidate ${pick(candidate, 'id').slice(0, 8)}`;
  return trail(spec ? specCrumbs(spec, org) : [dashboardCrumb(), orgCrumb(org)], { label });
}

/** `spec` is the spec of candidate A, else of candidate B (the caller picks). */
export function trialCrumbs(trial: DoRow, spec?: DoRow | null, org?: DoRow | null): Crumb[] {
  const label = `Trial ${pick(trial, 'id').slice(0, 8)}`;
  return trail(spec ? specCrumbs(spec, org) : [dashboardCrumb(), orgCrumb(org)], { label });
}

// ============================================================================
// Renderers
// ============================================================================

/** Login and sign-out in one place (a later user menu replaces this function). */
export function renderAccount(chrome: Chrome): SafeHtml {
  return safe(
    `<div class="site-account"><span>Signed in as <strong>${labelHtml(chrome.login)}</strong></span>` +
      `<form method="POST" action="/logout"><button class="link">Sign out</button></form></div>`
  );
}

function navItem(label: string, href: string, current: 'page' | 'true' | null): string {
  return `<li><a href="${href}"${current ? ` aria-current="${current}"` : ''}>${esc(label)}</a></li>`;
}

function renderPrimaryNav(chrome: Chrome, opts: LayoutOpts): string {
  const items = [
    navItem('Dashboard', '/app', chrome.url.pathname === '/app' ? 'page' : null),
    // Anchors on the dashboard: the fragment never reaches the server, so they are never "page".
    navItem('Repositories', '/app#repositories', opts.section === 'repos' ? 'true' : null),
    navItem('Specs', '/app#specs', opts.section === 'specs' ? 'true' : null),
  ];
  if (isAppHref(opts.repoUrl)) items.push(navItem('Issues', `${opts.repoUrl}/issues`, opts.section === 'issues' ? 'true' : null));
  return `<nav aria-label="Primary"><ul>${items.join('')}</ul></nav>`;
}

function renderSwitcher(chrome: Chrome, opts: LayoutOpts): string {
  const orgs = chrome.orgs;
  if ('skipped' in orgs) return `<a class="site-orgs" href="/app#organizations">Organizations</a>`;
  if (!orgs.ok) return `<a class="site-orgs" href="/app">Organizations unavailable</a>`;

  const current = orgs.orgs.find((o) => o.id === opts.orgId);
  const sorted = orgs.orgs
    .filter((o) => o !== current)
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const shown = (current ? [current, ...sorted] : sorted).slice(0, SWITCHER_LIMIT);

  const summary = current ? `Org: ${labelHtml(current.name)}` : 'Organizations';
  const items = shown.map((o) => {
    const href = `/app/orgs/${esc(encodeURIComponent(o.id))}`;
    const mark = o.id === opts.orgId ? (chrome.url.pathname === `/app/orgs/${o.id}` ? 'page' : 'true') : null;
    return `<li><a href="${href}"${mark ? ` aria-current="${mark}"` : ''}>${labelHtml(o.name)}</a></li>`;
  });
  if (orgs.total === 0) items.push('<li>No organizations</li>', '<li><a href="/app#organizations">Create one</a></li>');
  if (orgs.total > SWITCHER_LIMIT) {
    items.push(`<li><a href="/app#organizations">All organizations (${orgs.total >= ORG_READ_LIMIT ? `${ORG_READ_LIMIT}+` : orgs.total})</a></li>`);
  }
  return `<details class="site-orgs"><summary>${summary}</summary><ul>${items.join('')}</ul></details>`;
}

function renderSearch(opts: LayoutOpts): string {
  const enabled = isAppHref(opts.searchAction);
  const hint = 'Open an organization or repository to search';
  const control = enabled
    ? `<input id="site-q" type="search" name="q" value="${esc(opts.query ?? '')}">`
    : `<input id="site-q" type="search" name="q" disabled placeholder="${hint}" title="${hint}">`;
  return (
    `<form class="site-search" role="search" method="GET" action="${enabled ? opts.searchAction : '/app'}">` +
    `<label class="site-sr" for="site-q">Search (mocked)</label>${control} ${mockedLabel()}</form>`
  );
}

function renderBreadcrumbs(crumbs: Crumb[]): string {
  if (crumbs.length === 0) return '';
  const last = crumbs.length - 1;
  const items = crumbs.map((c, i) => {
    if (i === last) return `<li aria-current="page">${labelHtml(c.label)}</li>`;
    return `<li>${isAppHref(c.href) ? `<a href="${c.href}">${labelHtml(c.label)}</a>` : labelHtml(c.label)}</li>`;
  });
  return `<nav class="site-crumbs" aria-label="Breadcrumb"><ol>${items.join('')}</ol></nav>`;
}

/** Renders a session page inside the layout. Awaits the chrome here, i.e. only when it renders. */
export async function appPage(chrome: ChromeSource, opts: LayoutOpts, body: string): Promise<Response> {
  const c = await chrome();
  const flashHtml = opts.flash === false ? '' : flash(c.url);
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)} - Beehive</title>
<style>
${PAGE_CSS}
</style></head>
<body><a class="site-skip" href="#main">Skip to content</a>
<header class="site-header"><a class="site-brand" href="/app">Beehive</a>
${renderPrimaryNav(c, opts)}
${renderSwitcher(c, opts)}
${renderSearch(opts)}
${renderAccount(c)}</header>
${renderBreadcrumbs(opts.crumbs)}
<main id="main" tabindex="-1"><h1>${esc(opts.heading ?? opts.title)}</h1>${flashHtml ? `<div class="site-flash">${flashHtml}</div>` : ''}${body}</main></body></html>`;
  return new Response(html, {
    status: opts.status ?? 200,
    headers: new Headers({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }),
  });
}

/**
 * 403/404/405/502 for a session user. `heading` is a code constant, `message` is HTML built from
 * constants (any dynamic piece must go through `esc()` first). The trail is Dashboard > heading.
 */
export function statusPage(chrome: ChromeSource, status: number, heading: string, message: string): Promise<Response> {
  return appPage(
    chrome,
    { title: heading, crumbs: [dashboardCrumb(), { label: heading }], section: null, status, flash: false },
    `<p>${message}</p>`
  );
}
