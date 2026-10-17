/**
 * Beehive web UI: GitHub OAuth login and server-rendered management pages.
 *
 * Lives in the edge router so the browser never sees API_AUTH_TOKEN. Access is
 * limited to the GitHub logins in ALLOWED_GITHUB_USERS; the session is a signed,
 * HttpOnly cookie. Writes go straight to the Spec DO, the same path the REST
 * handlers use.
 */

export interface UiEnv {
  API_AUTH_TOKEN?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  ALLOWED_GITHUB_USERS?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
}

import { page, esc, str, table, tableHtml, isValidId } from './ui-html';
import { orgPage, repoPage, specPage, candidatePage, trialPage, repoIssuesPage, newIssuePage, issuePage, type DoReader, type DoRow, type Session, type IssueViewer } from './ui-pages';
import { parseRepoIssuesPath, resolveRepoRef, buildRepoUrl, validComponent, type RepoIssuesRoute, type RepoRef } from './ui-repo-ref';
import type { SpecDoStub } from '../shared/spec-do-auth';

// Re-export Session for use by tests
export type { Session };

const SESSION_COOKIE = '__Host-beehive_session';
const STATE_COOKIE = '__Host-beehive_oauth_state';
const SESSION_TTL_SECONDS = 60 * 60 * 12;

const ORG_TYPES = ['github', 'gitlab', 'artifacts'];
const REPO_TYPES = ['baseline', 'candidate'];

interface Row {
  [key: string]: unknown;
}

// ============================================================================
// DoReader implementation for Spec DO access
// ============================================================================

/**
 * DoReader implementation that uses callDo to read from Spec DO.
 * Note: Only uses UNFILTERED list routes per R1 (filtered routes return empty).
 * Filtering is done in the UI code.
 */
function createDoReader(stub: SpecDoStub, actorId: string): DoReader {
  return {
    get: async (path: string): Promise<DoRow | null> => {
      const result = await callDo(stub, path, 'GET', undefined, actorId);
      if (!result.success) {
        // AGENTS.md rule: Check Response.ok; a 404 is an error, never empty
        // However, for entity GET requests, a 'Not found' error means the entity doesn't exist
        // which is a legitimate 404 that should return null, not an error
        if (result.error === 'Not found') {
          return null;
        }
        throw new Error(`Spec DO error: ${result.error || 'Unknown error'}`);
      }
      if (!result.data) return null;
      return result.data as DoRow;
    },
    list: async (path: string, limit: number = 500): Promise<DoRow[]> => {
      // Build query string properly with URLSearchParams (R2)
      const searchParams = new URLSearchParams();
      searchParams.set('limit', String(limit));
      searchParams.set('offset', '0');
      const queryString = searchParams.toString();
      
      // CRITICAL: Do NOT pass filter params (R1, R3)
      // Filtered routes like /api/specs?organizationId=X return empty in production
      // due to bind order bug. All filtering happens in the UI.
      const result = await callDo(stub, `${path}?${queryString}`, 'GET', undefined, actorId);
      if (!result.success) {
        // AGENTS.md rule: Check Response.ok; a 404 is an error, never empty
        // For list requests, any error means we couldn't load the data
        throw new Error(`Spec DO error: ${result.error || 'Unknown error'}`);
      }
      if (!Array.isArray(result.data)) return [];
      return result.data as DoRow[];
    },
  };
}

// ============================================================================
// Entry point
// ============================================================================

/** Returns a Response for UI routes, or null when the path is not a UI route. */
export async function handleUi(
  request: Request,
  env: UiEnv,
  stub: SpecDoStub
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  const isUiRoute =
    path === '/login' || path === '/logout' || path === '/auth/callback' || path === '/app' || path.startsWith('/app/');
  if (!isUiRoute) return null;

  if (!env.API_AUTH_TOKEN || !env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return page('Not configured', '<p>GitHub login is not configured on this worker.</p>', 503);
  }

  if (path === '/login' && method === 'GET') return startLogin(url, env);
  if (path === '/auth/callback' && method === 'GET') return finishLogin(request, url, env, stub);

  const session = await readSession(request, env);

  // Check POST to /logout before session check (R9)
  if (path === '/logout' && method === 'POST') {
    if (!sameOrigin(request)) return page('Forbidden', '<p>Cross-origin request blocked.</p>', 403);
    return redirect('/about', [clearCookie(SESSION_COOKIE)]);
  }

  if (!session) return redirect('/login');

  // A valid signature does not prove the actor still exists (the ledger can be wiped).
  // Force a fresh login so ensureActor re-creates it instead of failing on a foreign key.
  const actorList = await callDo(stub, '/api/actors?limit=500&offset=0', 'GET');
  const actorRow = actorList.success && Array.isArray(actorList.data)
    ? (actorList.data as Row[]).find((a) => pick(a, 'id') === session.actorId)
    : undefined;
  if (!actorRow) return redirect('/login', [clearCookie(SESSION_COOKIE)]);
  // Only decides what the pages offer; the Spec DO re-checks every write. Sessions are never service accounts.
  const viewer: IssueViewer = { actorId: session.actorId, isMaintainer: pick(actorRow, 'role') === 'maintainer' };

  // CREATE DOREADER - available to all authenticated routes below
  const doReader = createDoReader(stub, session.actorId);

  // Dashboard route
  if (path === '/app' && method === 'GET') return dashboard(url, session, stub, doReader);

  // Issue routes come first, GET and POST together (docs/M8-UI-ISSUES-PLAN.md section 2). When the
  // ref does not resolve they fall through, so repos named "issues" or "new" keep working.
  const issueRoute = parseRepoIssuesPath(path, method);
  if (issueRoute) {
    const handled = await handleRepoIssues(issueRoute, request, url, session, viewer, stub, doReader);
    if (handled) return handled;
  }

  // Hierarchical repo path: /app/repos/{org}/{namespace}/{repo}, or the 2-part
  // /app/repos/{org}/{repo} form used when namespace === org name; /app/repos/{id} is handled below.
  const repoHierarchicalMatch = path.match(/^\/app\/repos\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/);
  if (repoHierarchicalMatch) {
    if (method !== 'GET') {
      return page('Not found', '<p>Method not allowed. <a href="/app">Back to dashboard</a></p>', 404);
    }
    const segments: string[] = [];
    for (const part of repoHierarchicalMatch.slice(1)) {
      if (part === undefined) continue;
      try {
        segments.push(decodeURIComponent(part));
      } catch {
        return page('Not found', '<p>Invalid path format. <a href="/app">Back to dashboard</a></p>', 404);
      }
    }
    if (!segments.every(validComponent)) {
      return page('Not found', '<p>Invalid path format. <a href="/app">Back to dashboard</a></p>', 404);
    }

    try {
      const ref = await resolveRepoRef(doReader, segments);
      if (!ref) {
        return page('Not found', '<p>Repository not found. <a href="/app">Back to dashboard</a></p>', 404);
      }
      // Render using UUID (all existing page code works unchanged)
      return await repoPage(pick(ref.repo, 'id'), url, session, doReader, env);
    } catch (error) {
      console.error('Repo page error:', error);
      return page('Error', '<p>could not load this page</p><p><a href="/app">Back to dashboard</a></p>', 502);
    }
  }

  // NEW: Detail page routes (GET only, after actor check - R9)
  // Match /app/orgs/:id, /app/repos/:id, /app/specs/:id, /app/candidates/:id, /app/trials/:id, /app/issues/:id
  const detailMatch = path.match(/^\/app\/(orgs|repos|specs|candidates|trials|issues)\/([^/]+)$/);
  if (detailMatch) {
    const [, kind, id] = detailMatch;
    
    // Detail pages are GET-only (R9)
    if (method !== 'GET') {
      return page('Not found', '<p>Method not allowed. <a href="/app">Back to dashboard</a></p>', 404);
    }
    
    // Validate ID format (R5)
    // Reject anything that doesn't match alphanumeric/hyphen/underscore pattern
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      return page('Not found', '<p>Invalid ID format. <a href="/app">Back to dashboard</a></p>', 404);
    }
    
    try {
      switch (kind) {
        case 'orgs':
          return await orgPage(id, url, session, doReader);
        case 'repos':
          return await repoPage(id, url, session, doReader, env);
        case 'issues':
          return await legacyIssue(id, url, session, viewer, doReader);
        case 'specs':
          return await specPage(id, url, session, doReader);
        case 'candidates':
          return await candidatePage(id, url, session, doReader);
        case 'trials':
          return await trialPage(id, url, session, doReader);
        default:
          return page('Not found', '<p>Unknown entity type. <a href="/app">Back to dashboard</a></p>', 404);
      }
    } catch (error) {
      console.error('Detail page error:', error);
      return page('Error', '<p>could not load this page</p><p><a href="/app">Back to dashboard</a></p>', 502);
    }
  }

  // POST routes for create forms (unchanged)
  if (method === 'POST') {
    if (!sameOrigin(request)) return page('Forbidden', '<p>Cross-origin request blocked.</p>', 403);
    const form = await request.formData();
    if (path === '/app/organizations') return createOrganization(form, session, stub);
    if (path === '/app/repositories') return createRepository(form, session, stub);
    if (path === '/app/specs') return createSpec(form, session, stub);
    
    // Compat shim for comment forms rendered before the issue pages moved under the repo URL.
    if (path === '/app/issue_comments') return legacyIssueComment(form, session, doReader, stub);
  }

  return page('Not found', '<p>This page does not exist. <a href="/app">Back to dashboard</a></p>', 404);
}

// ============================================================================
// OAuth
// ============================================================================

function startLogin(url: URL, env: UiEnv): Response {
  const state = randomToken();
  const authorize = new URL('https://github.com/login/oauth/authorize');
  authorize.searchParams.set('client_id', env.GITHUB_CLIENT_ID as string);
  authorize.searchParams.set('redirect_uri', `${url.origin}/auth/callback`);
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('scope', 'read:user');
  return redirect(authorize.toString(), [cookie(STATE_COOKIE, state, 600)]);
}

async function finishLogin(
  request: Request,
  url: URL,
  env: UiEnv,
  stub: SpecDoStub
): Promise<Response> {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expected = getCookie(request, STATE_COOKIE);
  if (!code || !state || !expected || state !== expected) {
    return page('Login failed', '<p>Invalid or expired login attempt. <a href="/login">Try again</a></p>', 400, [
      clearCookie(STATE_COOKIE),
    ]);
  }

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}/auth/callback`,
    }),
  });
  const tokenBody = (await tokenRes.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!tokenBody.access_token) {
    // GitHub's error codes and descriptions are safe to show; they never include secrets.
    const reason = tokenBody.error
      ? `${esc(tokenBody.error)}: ${esc(tokenBody.error_description || 'no description')}`
      : `HTTP ${tokenRes.status}, no token in response`;
    return page(
      'Login failed',
      `<p>GitHub did not return a token (${reason}). <a href="/login">Try again</a></p>`,
      502,
      [clearCookie(STATE_COOKIE)]
    );
  }

  const userRes = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${tokenBody.access_token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'beehive-ui',
    },
  });
  const user = (await userRes.json().catch(() => ({}))) as { login?: string; id?: number };
  if (!user.login || !user.id) {
    return page('Login failed', '<p>Could not read your GitHub profile.</p>', 502, [clearCookie(STATE_COOKIE)]);
  }

  const allowed = (env.ALLOWED_GITHUB_USERS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed.includes(user.login.toLowerCase())) {
    return page('Access denied', `<p>GitHub user <strong>${esc(user.login)}</strong> is not allowed.</p>`, 403, [
      clearCookie(STATE_COOKIE),
    ]);
  }

  const actorId = await ensureActor(stub, user.login, String(user.id));
  if (!actorId) {
    return page('Login failed', '<p>Could not create your actor record.</p>', 500, [clearCookie(STATE_COOKIE)]);
  }

  const token = await signSession(
    { login: user.login, actorId, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS },
    env.API_AUTH_TOKEN as string
  );
  return redirect('/app', [cookie(SESSION_COOKIE, token, SESSION_TTL_SECONDS), clearCookie(STATE_COOKIE)]);
}

async function ensureActor(stub: SpecDoStub, login: string, githubId: string): Promise<string | null> {
  const list = await callDo(stub, '/api/actors?limit=500&offset=0', 'GET');
  const rows = Array.isArray(list.data) ? (list.data as Row[]) : [];
  const existing = rows.find((a) => a.github_user_id === githubId || a.githubUserId === githubId);
  if (existing && typeof existing.id === 'string') return existing.id;

  const created = await callDo(stub, '/api/actors', 'POST', { type: 'human', name: login, githubUserId: githubId });
  const actor = created.data as Row | undefined;
  return actor && typeof actor.id === 'string' ? actor.id : null;
}

// ============================================================================
// Pages and actions
// ============================================================================

/**
 * Helper to pick a value from a row, trying both snake_case and camelCase.
 * Used for filtering in UI (R1).
 */
function pick(row: Row, snake: string, camel?: string): string {
  if (row[snake] !== undefined) return str(row[snake]);
  if (camel && row[camel] !== undefined) return str(row[camel]);
  return '';
}

/**
 * Format a timestamp for display.
 */
function formatDate(ts: number | string | undefined): string {
  if (!ts) return '';
  const num = typeof ts === 'string' ? parseInt(ts, 10) : ts;
  if (isNaN(num)) return '';
  return new Date(num).toLocaleString();
}

async function dashboard(url: URL, session: Session, stub: SpecDoStub, doReader: DoReader): Promise<Response> {
  try {
    const [orgs, repos, specs] = await Promise.all([
      doReader.list('/api/organizations'),
      doReader.list('/api/repositories'),
      doReader.list('/api/specs'),
    ]);

  const notice = url.searchParams.get('ok');
  const error = url.searchParams.get('error');
  
  // Build name lookup maps
  const orgName = new Map(orgs.map((o) => [pick(o, 'id'), pick(o, 'name')]));
  const repoName = new Map(repos.map((r) => [pick(r, 'id'), pick(r, 'name')]));
  const specName = new Map(specs.map((s) => [pick(s, 'id'), pick(s, 'name')]));

  const orgOptions = orgs.length
    ? orgs.map((o) => `<option value="${esc(pick(o, 'id'))}">${esc(pick(o, 'name'))}</option>`).join('')
    : '<option value="" disabled selected>Create an organization first</option>';

  // Create cross-links to detail pages (Step 4)
  // Org rows with links
  const orgRows = orgs.map((o) => [
    `<a href="/app/orgs/${esc(encodeURIComponent(pick(o, 'id')))}">${esc(pick(o, 'name'))}</a>`,
    str(pick(o, 'type')),
    str(pick(o, 'id')),
  ]);

  // Repo rows with links and spec links
  const repoRows = repos.map((r) => {
    const orgId = pick(r, 'organization_id', 'organizationId');
    const org = orgs.find((o) => pick(o, 'id') === orgId);
    const specId = pick(r, 'spec_id', 'specId');
    const spec = specs.find((s) => pick(s, 'id') === specId);
    
    const repoUrl = buildRepoUrl(r, org ? [org] : []);
    
    return [
      `<a href="${repoUrl}">${esc(pick(r, 'name'))}</a>`,
      org ? `<a href="/app/orgs/${esc(encodeURIComponent(pick(org, 'id')))}">${esc(pick(org, 'name'))}</a>` : '',
      str(pick(r, 'repo_type', 'repoType')),
      spec ? `<a href="/app/specs/${esc(encodeURIComponent(pick(spec, 'id')))}">${esc(pick(spec, 'name'))}</a>` : 'none',
    ];
  });

  // Spec rows with links and org links
  const specRows = specs.map((s) => {
    const orgId = pick(s, 'organization_id', 'organizationId');
    const org = orgs.find((o) => pick(o, 'id') === orgId);
    return [
      `<a href="/app/specs/${esc(encodeURIComponent(pick(s, 'id')))}">${esc(pick(s, 'name'))}</a>`,
      org ? `<a href="/app/orgs/${esc(encodeURIComponent(pick(org, 'id')))}">${esc(pick(org, 'name'))}</a>` : '',
      str(pick(s, 'stage')),
      str(pick(s, 'id')),
    ];
  });

  const body = `
    <header class="bar">
      <span>Signed in as <strong>${esc(session.login)}</strong></span>
      <form method="POST" action="/logout"><button class="link">Sign out</button></form>
    </header>
    ${notice ? `<p class="flash ok">${esc(notice)}</p>` : ''}
    ${error ? `<p class="flash err">${esc(error)}</p>` : ''}

    <section>
      <h2>Organizations (${orgs.length})</h2>
      ${tableHtml(['Name', 'Type', 'ID'], orgRows)}
      <form method="POST" action="/app/organizations" class="inline">
        <input name="name" placeholder="Name" required>
        <select name="type">${ORG_TYPES.map((t) => `<option>${t}</option>`).join('')}</select>
        <input name="externalId" placeholder="External ID (optional)">
        <button>Create organization</button>
      </form>
    </section>

    <section>
      <h2>Repositories (${repos.length})</h2>
      ${tableHtml(
        ['Name', 'Org', 'Type', 'Spec'],
        repoRows
      )}
      <form method="POST" action="/app/repositories" class="stack">
        <input name="name" placeholder="Name" required>
        <select name="organizationId" required>${orgOptions}</select>
        <select name="repoType">${REPO_TYPES.map((t) => `<option>${t}</option>`).join('')}</select>
        <input name="remoteUrl" placeholder="Remote URL (https://...)" required>
        <input name="namespace" placeholder="Namespace" required>
        <input name="defaultBranch" placeholder="Default branch (main)">
        <button>Create repository</button>
      </form>
    </section>

    <section>
      <h2>Specs (${specs.length})</h2>
      ${tableHtml(
        ['Name', 'Org', 'Stage', 'ID'],
        specRows
      )}
      <form method="POST" action="/app/specs" class="stack">
        <input name="name" placeholder="Name" required>
        <select name="organizationId" required>${orgOptions}</select>
        <input name="description" placeholder="Description (optional)">
        <textarea name="contract" rows="8" placeholder='Contract as JSON, e.g. {"endpoints":[{"method":"GET","path":"/health"}]}' required></textarea>
        <textarea name="declaredDeltaSurface" rows="3" placeholder="Declared delta surface, one entry per line"></textarea>
        <button>Create spec</button>
      </form>
    </section>`;

    return page('Dashboard', body);
  } catch (error) {
    console.error('Dashboard error:', error);
    return page('Error', '<p>could not load this page</p><p><a href="/app">Back to dashboard</a></p>', 502);
  }
}

async function createOrganization(form: FormData, session: Session, stub: SpecDoStub): Promise<Response> {
  const name = field(form, 'name');
  const type = field(form, 'type');
  const externalId = field(form, 'externalId');
  if (!name || !ORG_TYPES.includes(type)) return back('error', 'Organization needs a name and a valid type.');
  const payload: Row = { name, type };
  if (externalId) payload.externalId = externalId;
  return submit(stub, '/api/organizations', payload, session, `Created organization ${name}`);
}

async function createRepository(form: FormData, session: Session, stub: SpecDoStub): Promise<Response> {
  const name = field(form, 'name');
  const organizationId = field(form, 'organizationId');
  const repoType = field(form, 'repoType');
  const remoteUrl = field(form, 'remoteUrl');
  const namespace = field(form, 'namespace');
  const defaultBranch = field(form, 'defaultBranch');
  if (!name || !organizationId || !remoteUrl || !namespace || !REPO_TYPES.includes(repoType)) {
    return back('error', 'Repository needs a name, organization, type, remote URL and namespace.');
  }
  const payload: Row = { name, organizationId, repoType, remoteUrl, namespace };
  if (defaultBranch) payload.defaultBranch = defaultBranch;
  return submit(stub, '/api/repositories', payload, session, `Created repository ${name}`);
}

async function createSpec(form: FormData, session: Session, stub: SpecDoStub): Promise<Response> {
  const name = field(form, 'name');
  const organizationId = field(form, 'organizationId');
  const description = field(form, 'description');
  const contract = field(form, 'contract');
  if (!name || !organizationId || !contract) return back('error', 'Spec needs a name, organization and contract.');
  try {
    JSON.parse(contract);
  } catch {
    return back('error', 'Contract must be valid JSON.');
  }
  const declaredDeltaSurface = field(form, 'declaredDeltaSurface')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const payload: Row = { name, organizationId, contract, declaredDeltaSurface };
  if (description) payload.description = description;
  return submit(stub, '/api/specs', payload, session, `Created spec ${name}`);
}

// ============================================================================
// Issue routes (docs/M8-UI-ISSUES-PLAN.md sections 5-7)
// ============================================================================

const MAX_COMMENT_CHARS = 10_000;
const NO_REPO_PAGE = () => page('Not found', '<p>Repository not found. <a href="/app">Back to dashboard</a></p>', 404);
const NOT_FOUND_ISSUE = () => page('Not found', '<p>Issue not found. <a href="/app">Back to dashboard</a></p>', 404);
const LOAD_ERROR = () =>
  page('Error', '<p>could not load this page</p><p><a href="/app">Back to dashboard</a></p>', 502);
const FORBIDDEN_ORIGIN = () => page('Forbidden', '<p>Cross-origin request blocked.</p>', 403);
const METHOD_NOT_ALLOWED = () => page('Method not allowed', '<p>Method not allowed. <a href="/app">Back to dashboard</a></p>', 405);

const POST_KINDS = new Set(['create', 'comment', 'status']);

/**
 * Handles one parsed issue route. Returns null when the ref does not resolve, so the caller
 * falls through to the older repo routes (a repo may be literally named "issues" or "new").
 */
async function handleRepoIssues(
  route: RepoIssuesRoute,
  request: Request,
  url: URL,
  session: Session,
  viewer: IssueViewer,
  stub: SpecDoStub,
  doReader: DoReader
): Promise<Response | null> {
  const isPostKind = POST_KINDS.has(route.kind);
  const method = request.method;

  // One origin check, before any DO read, for every state-changing issue route.
  if (method === 'POST' && isPostKind && !sameOrigin(request)) return FORBIDDEN_ORIGIN();

  let ref: RepoRef | null;
  try {
    ref = await resolveRepoRef(doReader, route.refSegments);
  } catch (error) {
    console.error('Issue route repo lookup error:', error);
    return LOAD_ERROR();
  }
  if (!ref) return null;

  const allowed = isPostKind ? method === 'POST' : method === 'GET' || method === 'HEAD';
  if (!allowed) return METHOD_NOT_ALLOWED();

  try {
    switch (route.kind) {
      case 'list':
        return await repoIssuesPage(ref, url, session, doReader);
      case 'new':
        return newIssuePage(ref, url, session);
      case 'detail': {
        const issueId = route.issueId as string;
        if (!isValidId(issueId)) return page('Not found', '<p>Invalid issue ID.</p>', 404);
        return await issuePage(issueId, ref, url, session, doReader, viewer);
      }
      case 'create':
        return await createIssue(await readForm(request), ref, session, stub);
      case 'comment':
      case 'status': {
        const issueId = route.issueId as string;
        if (!isValidId(issueId)) return page('Not found', '<p>Invalid issue ID.</p>', 404);
        const issue = await doReader.get(`/api/issues/${encodeURIComponent(issueId)}`);
        // Private or out-of-repo issues are 404 before anything is written or disclosed.
        if (!issue || pick(issue, 'repository_id', 'repositoryId') !== pick(ref.repo, 'id') || pick(issue, 'visibility') === 'private') {
          return NOT_FOUND_ISSUE();
        }
        const form = await readForm(request);
        return route.kind === 'comment'
          ? await addComment(form, ref, issueId, session, stub)
          : await setStatus(form, ref, issueId, session, stub);
      }
    }
  } catch (error) {
    console.error('Issue route error:', route.kind, error);
    if (route.kind === 'list' || route.kind === 'new' || route.kind === 'detail') return LOAD_ERROR();
    return page('Error', '<p>could not complete this request</p><p><a href="/app">Back to dashboard</a></p>', 502);
  }
}

async function readForm(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    return new FormData();
  }
}

/** Redirect carrying an encoded flash message: `#`, `&` and spaces in a message cannot break the Location. */
function flashRedirect(base: string, kind: 'ok' | 'error', message: string, fragment = ''): Response {
  return redirect(`${base}?${kind}=${encodeURIComponent(message)}${fragment}`);
}

/**
 * Create an issue. The number is not sent: the Spec DO assigns it atomically, and the author is
 * the actor header, never a form field.
 */
async function createIssue(form: FormData, ref: RepoRef, session: Session, stub: SpecDoStub): Promise<Response> {
  const newUrl = `${ref.repoUrl}/issues/new`;
  const title = field(form, 'title');
  if (!title) return flashRedirect(newUrl, 'error', 'Issue needs a title.');
  const body = field(form, 'body');
  const labels = field(form, 'labels');

  const result = await doWrite(stub, '/api/issues', 'POST', {
    repositoryId: pick(ref.repo, 'id'),
    title,
    body: body || undefined,
    labels: labels ? labels.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
  }, session.actorId);
  if (!result.ok) {
    console.error('Create issue failed:', result.status, result.error);
    return flashRedirect(newUrl, 'error', 'Could not create issue');
  }

  const issue = result.data as Row | null;
  const id = issue ? pick(issue, 'id') : '';
  if (!id) {
    console.error('Create issue returned no id');
    return flashRedirect(newUrl, 'error', 'Could not create issue');
  }
  return flashRedirect(`${ref.repoUrl}/issues/${encodeURIComponent(id)}`, 'ok', createdMessage(pick(issue as Row, 'number')));
}

/** Add a comment. The DO enforces the comment policy; its 4xx text is shown, anything else is generic. */
async function addComment(form: FormData, ref: RepoRef, issueId: string, session: Session, stub: SpecDoStub): Promise<Response> {
  const issueUrl = `${ref.repoUrl}/issues/${encodeURIComponent(issueId)}`;
  const body = field(form, 'body');
  if (!body) return flashRedirect(issueUrl, 'error', 'Comment cannot be empty.', '#comments');
  if (body.length > MAX_COMMENT_CHARS) {
    return flashRedirect(issueUrl, 'error', `Comment is too long (at most ${MAX_COMMENT_CHARS} characters).`, '#comments');
  }

  const result = await doWrite(stub, `/api/issues/${encodeURIComponent(issueId)}/comments`, 'POST', { body }, session.actorId);
  if (!result.ok) {
    console.error('Add comment failed:', result.status, result.error);
    return flashRedirect(issueUrl, 'error', writeFailure(result, 'Could not add comment'), '#comments');
  }
  return flashRedirect(issueUrl, 'ok', 'Comment added', '#comments');
}

/** Close or reopen. An old Spec DO without the route answers its catch-all 404; say so rather than do nothing. */
async function setStatus(form: FormData, ref: RepoRef, issueId: string, session: Session, stub: SpecDoStub): Promise<Response> {
  const issueUrl = `${ref.repoUrl}/issues/${encodeURIComponent(issueId)}`;
  const status = field(form, 'status');
  if (status !== 'open' && status !== 'closed') return flashRedirect(issueUrl, 'error', 'Status must be open or closed.');

  const result = await doWrite(stub, `/api/issues/${encodeURIComponent(issueId)}/status`, 'PATCH', { status }, session.actorId);
  if (!result.ok) {
    console.error('Set issue status failed:', result.status, result.error);
    if (result.status === 404 && result.error === 'Not found') {
      return flashRedirect(issueUrl, 'error', 'Closing and reopening is not available yet');
    }
    return flashRedirect(issueUrl, 'error', writeFailure(result, status === 'closed' ? 'Could not close issue' : 'Could not reopen issue'));
  }
  return flashRedirect(issueUrl, 'ok', status === 'closed' ? 'Issue closed' : 'Issue reopened');
}

function createdMessage(number: string): string {
  return number ? `Created issue #${number}` : 'Created issue';
}

/** The DO's own refusal text (fixed strings for 400/403/409) is user-facing; everything else is a generic message. */
function writeFailure(result: { status: number; error: string }, fallback: string): string {
  if (![400, 403, 409].includes(result.status) || !result.error) return fallback;
  // Identity checks are internal wording (header names, service accounts); the user only needs to log in again.
  if (/X-Actor-ID|service account|createdBy/i.test(result.error)) return 'Your session is out of date; log in again.';
  return result.error;
}

/**
 * Legacy `GET /app/issues/:id`: redirect to the canonical repo URL. Private and missing issues are
 * 404 before any redirect, so a private issue's canonical URL is never disclosed. If the
 * repository cannot be resolved the issue renders in place.
 */
async function legacyIssue(id: string, url: URL, session: Session, viewer: IssueViewer, doReader: DoReader): Promise<Response> {
  const issue = await doReader.get(`/api/issues/${encodeURIComponent(id)}`);
  if (!issue || pick(issue, 'visibility') === 'private') return NOT_FOUND_ISSUE();
  const repoId = pick(issue, 'repository_id', 'repositoryId');
  const ref = repoId ? await resolveRepoRef(doReader, [repoId]) : null;
  if (!ref) return issuePage(id, null, url, session, doReader, viewer);
  return redirect(`${ref.repoUrl}/issues/${encodeURIComponent(id)}`);
}

/**
 * Compat shim for `POST /app/issue_comments` (forms rendered before the move). Reads the issue,
 * derives its repository and runs the same comment path. Remove after one release.
 */
async function legacyIssueComment(form: FormData, session: Session, doReader: DoReader, stub: SpecDoStub): Promise<Response> {
  const issueId = field(form, 'issueId');
  if (!isValidId(issueId)) return back('error', 'Comment needs an issue.');
  try {
    const issue = await doReader.get(`/api/issues/${encodeURIComponent(issueId)}`);
    if (!issue || pick(issue, 'visibility') === 'private') return back('error', 'Issue not found.');
    const repoId = pick(issue, 'repository_id', 'repositoryId');
    const ref = repoId ? await resolveRepoRef(doReader, [repoId]) : null;
    if (!ref) return back('error', 'Issue not found.');
    return await addComment(form, ref, issueId, session, stub);
  } catch (error) {
    console.error('Legacy comment error:', error);
    return back('error', 'Could not add comment');
  }
}

async function submit(
  stub: SpecDoStub,
  path: string,
  payload: Row,
  session: Session,
  okMessage: string
): Promise<Response> {
  const result = await callDo(stub, path, 'POST', payload, session.actorId);
  if (result.success === false) return back('error', String(result.error || 'Request failed'));
  return back('ok', okMessage);
}

// ============================================================================
// Spec DO access
// ============================================================================

async function callDo(
  stub: SpecDoStub,
  path: string,
  method: string,
  body?: unknown,
  actorId?: string
): Promise<{ success?: boolean; data?: unknown; error?: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (actorId) headers['X-Actor-ID'] = actorId;
  try {
    const res = await stub.fetch(
      new Request(`https://spec-do.internal${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      })
    );
    const json = (await res.json().catch(() => null)) as { success?: boolean; data?: unknown; error?: unknown } | null;
    if (!json) return { success: false, error: `Spec DO returned ${res.status}` };
    if (!res.ok && json.success === undefined) return { success: false, error: `Spec DO returned ${res.status}` };
    return json;
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Spec DO unreachable' };
  }
}

type WriteResult = { ok: true; data: unknown } | { ok: false; status: number; error: string };

/**
 * Write to the Spec DO. Succeeds only on an ok response whose body says `success: true`; a 404
 * (including the catch-all of an older DO) is a failure, never an empty success.
 */
async function doWrite(stub: SpecDoStub, path: string, method: string, body: unknown, actorId: string): Promise<WriteResult> {
  try {
    const res = await stub.fetch(
      new Request(`https://spec-do.internal${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Actor-ID': actorId },
        body: JSON.stringify(body),
      })
    );
    const json = (await res.json().catch(() => null)) as { success?: boolean; data?: unknown; error?: unknown } | null;
    if (res.ok && json?.success === true) return { ok: true, data: json.data };
    return { ok: false, status: res.status, error: typeof json?.error === 'string' ? json.error : `Spec DO returned ${res.status}` };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : 'Spec DO unreachable' };
  }
}

// ============================================================================
// Session, cookies, helpers
// ============================================================================

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function randomToken(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(24)));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`beehive-ui-session:${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

// Export for tests
export async function signSession(session: Session, secret: string): Promise<string> {
  const payload = b64url(new TextEncoder().encode(JSON.stringify(session)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(payload));
  return `${payload}.${b64url(sig)}`;
}

async function readSession(request: Request, env: UiEnv): Promise<Session | null> {
  const raw = getCookie(request, SESSION_COOKIE);
  if (!raw || !env.API_AUTH_TOKEN) return null;
  const [payload, sig] = raw.split('.');
  if (!payload || !sig) return null;
  try {
    const ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(env.API_AUTH_TOKEN),
      fromB64url(sig),
      new TextEncoder().encode(payload)
    );
    if (!ok) return null;
    const session = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as Session;
    if (!session.login || !session.actorId || session.exp < Math.floor(Date.now() / 1000)) return null;
    return session;
  } catch {
    return null;
  }
}

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function clearCookie(name: string): string {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  return origin === new URL(request.url).origin;
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(null, { status: 302, headers });
}

function back(kind: 'ok' | 'error', message: string): Response {
  return redirect(`/app?${kind}=${encodeURIComponent(message)}`);
}

function field(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
}
