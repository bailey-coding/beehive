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
}

import { page, esc, str, table } from './ui-html';
import { orgPage, repoPage, specPage, candidatePage, trialPage, type DoReader, type DoRow, type Session } from './ui-pages';

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
function createDoReader(stub: DurableObjectStub, actorId: string): DoReader {
  return {
    get: async (path: string): Promise<DoRow | null> => {
      const result = await callDo(stub, path, 'GET', undefined, actorId);
      if (!result.success || !result.data) return null;
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
      if (!result.success || !Array.isArray(result.data)) return [];
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
  stub: DurableObjectStub
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
  const actorExists = actorList.success && Array.isArray(actorList.data) &&
    (actorList.data as Row[]).some((a) => pick(a, 'id') === session.actorId);
  if (!actorExists) return redirect('/login', [clearCookie(SESSION_COOKIE)]);

  // CREATE DOREADER - available to all authenticated routes below
  const doReader = createDoReader(stub, session.actorId);

  // Dashboard route
  if (path === '/app' && method === 'GET') return dashboard(url, session, stub, doReader);

  // NEW: Hierarchical repo path: /app/repos/{org}/{namespace}/{repo}
  const repoHierarchicalMatch = path.match(/^\/app\/repos\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (repoHierarchicalMatch) {
    const [, orgSlug, namespaceSlug, repoSlug] = repoHierarchicalMatch;
    
    if (method !== 'GET') {
      return page('Not found', '<p>Method not allowed. <a href="/app">Back to dashboard</a></p>', 404);
    }
    
    // Decode URL-encoded components before validation (Bug #2 fix)
    const orgSlugDecoded = decodeURIComponent(orgSlug);
    const namespaceSlugDecoded = decodeURIComponent(namespaceSlug);
    const repoSlugDecoded = decodeURIComponent(repoSlug);
    
    // Validate path components (allow dots for GitHub-style names)
    const validComponent = /^[A-Za-z0-9_.-]{1,64}$/;
    if (!validComponent.test(orgSlugDecoded) || 
        !validComponent.test(namespaceSlugDecoded) || 
        !validComponent.test(repoSlugDecoded)) {
      return page('Not found', '<p>Invalid path format. <a href="/app">Back to dashboard</a></p>', 404);
    }
    
    // Look up org and repo
    const [orgs, repos] = await Promise.all([
      doReader.list('/api/organizations'),
      doReader.list('/api/repositories')
    ]);
    
    const org = orgs.find((o) => pick(o, 'name') === orgSlugDecoded);
    if (!org) {
      return page('Not found', '<p>Organization not found. <a href="/app">Back to dashboard</a></p>', 404);
    }
    
    // Bug #1 fix: Use same default fallback for namespace as the link builders do
    const repo = repos.find((r) =>
      pick(r, 'organization_id', 'organizationId') === pick(org, 'id') &&
      (pick(r, 'namespace') || 'default') === namespaceSlugDecoded &&
      pick(r, 'name') === repoSlugDecoded
    );
    
    if (!repo) {
      return page('Not found', '<p>Repository not found. <a href="/app">Back to dashboard</a></p>', 404);
    }
    
    // Render using UUID (all existing page code works unchanged)
    return repoPage(pick(repo, 'id'), url, session, doReader);
  }

  // NEW: Detail page routes (GET only, after actor check - R9)
  // Match /app/orgs/:id, /app/repos/:id, /app/specs/:id, /app/candidates/:id, /app/trials/:id
  const detailMatch = path.match(/^\/app\/(orgs|repos|specs|candidates|trials)\/([^/]+)$/);
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
    
    switch (kind) {
      case 'orgs':
        return orgPage(id, url, session, doReader);
      case 'repos':
        return repoPage(id, url, session, doReader);
      case 'specs':
        return specPage(id, url, session, doReader);
      case 'candidates':
        return candidatePage(id, url, session, doReader);
      case 'trials':
        return trialPage(id, url, session, doReader);
      default:
        return page('Not found', '<p>Unknown entity type. <a href="/app">Back to dashboard</a></p>', 404);
    }
  }

  // POST routes for create forms (unchanged)
  if (method === 'POST') {
    if (!sameOrigin(request)) return page('Forbidden', '<p>Cross-origin request blocked.</p>', 403);
    const form = await request.formData();
    if (path === '/app/organizations') return createOrganization(form, session, stub);
    if (path === '/app/repositories') return createRepository(form, session, stub);
    if (path === '/app/specs') return createSpec(form, session, stub);
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
  stub: DurableObjectStub
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

async function ensureActor(stub: DurableObjectStub, login: string, githubId: string): Promise<string | null> {
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

async function dashboard(url: URL, session: Session, stub: DurableObjectStub, doReader: DoReader): Promise<Response> {
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
    
    // Build repo URL with fallback to UUID (Bug #3 fix)
    let repoUrl: string;
    if (org) {
      const orgName = pick(org, 'name');
      const namespace = pick(r, 'namespace') || 'default';
      const repoName = pick(r, 'name') || pick(r, 'id');
      const validComponent = /^[A-Za-z0-9_.-]{1,64}$/;
      if (validComponent.test(orgName) && validComponent.test(namespace) && validComponent.test(repoName)) {
        repoUrl = `/app/repos/${esc(encodeURIComponent(orgName))}/${esc(encodeURIComponent(namespace))}/${esc(encodeURIComponent(repoName))}`;
      } else {
        repoUrl = `/app/repos/${esc(encodeURIComponent(pick(r, 'id')))}`;
      }
    } else {
      repoUrl = `/app/repos/${esc(encodeURIComponent(pick(r, 'id')))}`;
    }
    
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
      ${table(['Name', 'Type', 'ID'], orgRows)}
      <form method="POST" action="/app/organizations" class="inline">
        <input name="name" placeholder="Name" required>
        <select name="type">${ORG_TYPES.map((t) => `<option>${t}</option>`).join('')}</select>
        <input name="externalId" placeholder="External ID (optional)">
        <button>Create organization</button>
      </form>
    </section>

    <section>
      <h2>Repositories (${repos.length})</h2>
      ${table(
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
      ${table(
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
}

async function createOrganization(form: FormData, session: Session, stub: DurableObjectStub): Promise<Response> {
  const name = field(form, 'name');
  const type = field(form, 'type');
  const externalId = field(form, 'externalId');
  if (!name || !ORG_TYPES.includes(type)) return back('error', 'Organization needs a name and a valid type.');
  const payload: Row = { name, type };
  if (externalId) payload.externalId = externalId;
  return submit(stub, '/api/organizations', payload, session, `Created organization ${name}`);
}

async function createRepository(form: FormData, session: Session, stub: DurableObjectStub): Promise<Response> {
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

async function createSpec(form: FormData, session: Session, stub: DurableObjectStub): Promise<Response> {
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

async function submit(
  stub: DurableObjectStub,
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
  stub: DurableObjectStub,
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
