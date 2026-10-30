/**
 * API tokens settings page (M12, RFD-0008): `/app/settings/tokens`.
 *
 *   GET  /app/settings/tokens              the session actor's tokens (prefix only) and the mint form
 *   POST /app/settings/tokens              mint for the session actor; a 200 page shows the plaintext once
 *   POST /app/settings/tokens/:id/revoke   revoke one of the session actor's own tokens
 *
 * The token's actor is always `session.actorId`; no form field names an actor. Every POST is
 * same-origin checked, and a mint needs a sign-in from the last 10 minutes, both before any Spec
 * DO call (tokenPrecheck runs ahead of the session-actor lookup in ui.ts). The freshness rule
 * bounds a stolen Beehive cookie only: GitHub often re-authorises silently.
 *
 * The mint answer is a page, not a redirect or flash, with no-store and no-referrer. Reloading it
 * resubmits the POST and mints a second token: the browser asks first, the cap of 10 live tokens
 * bounds it, and the extra token is listed for revocation (docs/M12-IMPL-PLAN.md S13, N2).
 */

import { esc, isValidId, page, tableHtml } from './ui-html';
import { appPage, dashboardCrumb, statusPage, type ChromeSource, type Crumb } from './ui-layout';
import type { IssueViewer, Session } from './ui-pages';
import {
  DEFAULT_USER_TOKEN_DAYS,
  MAX_USER_TOKEN_DAYS,
  MAX_USER_TOKEN_NAME_CHARS,
  checkMintInput,
  decodeSegment,
  listUserTokens,
  mintUserToken,
  revokeUserToken,
  type UserTokenView,
} from './user-tokens';
import type { SpecDoStub } from '../shared/spec-do-auth';

export const TOKENS_PATH = '/app/settings/tokens';
/** A mint needs `0 <= now - session.iat <= this` (seconds). */
export const MINT_FRESHNESS_SECONDS = 600;

export type TokenRoute = { kind: 'list' } | { kind: 'mint' } | { kind: 'revoke'; id: string } | { kind: 'other' };

/** The route under /app/settings/tokens, or null for any other path. */
export function parseTokenRoute(path: string, method: string): TokenRoute | null {
  if (path !== TOKENS_PATH && !path.startsWith(`${TOKENS_PATH}/`)) return null;
  if (path === TOKENS_PATH) {
    if (method === 'GET' || method === 'HEAD') return { kind: 'list' };
    if (method === 'POST') return { kind: 'mint' };
    return { kind: 'other' };
  }
  const revoke = path.match(/^\/app\/settings\/tokens\/([^/]+)\/revoke$/);
  if (revoke && method === 'POST') return { kind: 'revoke', id: revoke[1] };
  return { kind: 'other' };
}

/** Signed in at most MINT_FRESHNESS_SECONDS ago. A missing (pre-M12 cookie) or future iat is not fresh. */
export function isFresh(session: Session, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  const iat = session.iat;
  if (typeof iat !== 'number' || !Number.isFinite(iat)) return false;
  const age = nowSeconds - iat;
  return age >= 0 && age <= MINT_FRESHNESS_SECONDS;
}

/**
 * The checks that precede every Spec DO call: a cross-origin POST is 403, a mint from a session
 * that is not fresh gets the "sign in again" page. Null to proceed.
 */
export function tokenPrecheck(route: TokenRoute, method: string, session: Session, sameOrigin: boolean): Response | null {
  if (method === 'POST' && !sameOrigin) return page('Forbidden', '<p>Cross-origin request blocked.</p>', 403);
  if (route.kind === 'mint' && !isFresh(session)) {
    return page(
      'Sign in again',
      `<p>Creating an API token needs a sign-in from the last ${MINT_FRESHNESS_SECONDS / 60} minutes. ` +
        `<a href="/login">Sign in again</a>, then return to <a href="${TOKENS_PATH}">API tokens</a>.</p>`,
      403
    );
  }
  return null;
}

const crumbs = (tail?: string): Crumb[] => [dashboardCrumb(), { label: 'API tokens', href: TOKENS_PATH }, ...(tail ? [{ label: tail }] : [])];

const UNAVAILABLE = (chrome: ChromeSource) =>
  statusPage(chrome, 503, 'Token service unavailable', `could not reach the token service. Try again shortly. <a href="${TOKENS_PATH}">Back to API tokens</a>`);

function when(ms: number | null): string {
  return typeof ms === 'number' && Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'never';
}

function statusOf(t: UserTokenView, now: number): 'Revoked' | 'Expired' | 'Active' {
  if (t.revokedAt !== null) return 'Revoked';
  return t.expiresAt <= now ? 'Expired' : 'Active';
}

function scopeLabel(scope: string): string {
  return scope === 'read_write' ? 'read and write' : scope;
}

function mintForm(session: Session, viewer: IssueViewer): string {
  if (!isFresh(session)) {
    return `<p>To create a token, <a href="/login">sign in again</a> first: creating one needs a sign-in from the last ${
      MINT_FRESHNESS_SECONDS / 60
    } minutes.</p>`;
  }
  const scopes = [
    ['read', 'Read'],
    ['read_write', 'Read and write'],
    // The Spec DO checks the role again at mint time and on every use
    ...(viewer.isMaintainer ? [['maintainer', 'Maintainer (read, write and maintainer actions)']] : []),
  ];
  return `
    <form method="POST" action="${TOKENS_PATH}" class="stack">
      <div class="form-group">
        <label for="name">Name *</label>
        <input type="text" id="name" name="name" maxlength="${MAX_USER_TOKEN_NAME_CHARS}" placeholder="laptop CLI" required>
      </div>
      <div class="form-group">
        <label for="scope">Scope</label>
        <select id="scope" name="scope">${scopes.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>
      </div>
      <div class="form-group">
        <label for="expiresInDays">Expires in (days, at most ${MAX_USER_TOKEN_DAYS})</label>
        <input type="number" id="expiresInDays" name="expiresInDays" min="1" max="${MAX_USER_TOKEN_DAYS}" value="${DEFAULT_USER_TOKEN_DAYS}" required>
      </div>
      <div class="form-actions"><button type="submit" class="button primary">Create token</button></div>
    </form>`;
}

async function listPage(session: Session, viewer: IssueViewer, stub: SpecDoStub, chrome: ChromeSource): Promise<Response> {
  const list = await listUserTokens(stub, session.actorId, session.actorId);
  // A failed list is never "no tokens" (an older Spec DO answers 404 here)
  if (!list.ok) return UNAVAILABLE(chrome);
  const now = Date.now();
  const rows = list.data
    // Defence in depth: the DO filtered by actor already
    .filter((t) => t.actorId === session.actorId)
    .map((t) => {
      const status = statusOf(t, now);
      const action =
        status === 'Revoked'
          ? ''
          : `<form method="POST" action="${TOKENS_PATH}/${encodeURIComponent(t.id)}/revoke" class="inline"><button class="link">Revoke</button></form>`;
      return [esc(t.name), `<code>${esc(t.prefix)}…</code>`, esc(scopeLabel(t.scope)), esc(when(t.createdAt)), esc(when(t.expiresAt)), esc(when(t.lastUsedAt)), esc(status), action];
    });
  const body = `
    <p>Tokens act as you (<strong>${esc(session.login)}</strong>) on the Beehive API, for the CLI and scripts. Send one as
      <code>Authorization: Bearer &lt;token&gt;</code>.</p>
    <h2>Your tokens</h2>
    ${tableHtml(['Name', 'Prefix', 'Scope', 'Created', 'Expires', 'Last used', 'Status', ''], rows)}
    <h2>Create a token</h2>
    ${mintForm(session, viewer)}`;
  return appPage(chrome, { title: 'API tokens', crumbs: crumbs(), section: null }, body);
}

async function mint(request: Request, session: Session, stub: SpecDoStub, chrome: ChromeSource): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    form = new FormData();
  }
  const text = (name: string) => {
    const v = form.get(name);
    return typeof v === 'string' ? v.trim() : '';
  };
  // Only name, scope and lifetime are read; the token is always for the session's own actor
  const days = text('expiresInDays');
  const input = checkMintInput(text('name'), text('scope') || undefined, days === '' ? undefined : Number(days));
  const back = `<a href="${TOKENS_PATH}">Back to API tokens</a>`;
  if (typeof input === 'string') {
    return appPage(chrome, { title: 'Token not created', crumbs: crumbs('Not created'), section: null, status: 400, flash: false }, `<p>${esc(input)}. ${back}</p>`);
  }

  const minted = await mintUserToken(stub, session.actorId, session.actorId, input, 'session');
  if (!minted.ok) {
    if (minted.status === 503) return UNAVAILABLE(chrome);
    // 400/403/409: the Spec DO's own refusal text (the cap, the maintainer role)
    return appPage(
      chrome,
      { title: 'Token not created', crumbs: crumbs('Not created'), section: null, status: minted.status, flash: false },
      `<p>${esc(minted.error)}. ${back}</p>`
    );
  }

  const t = minted.data;
  const body = `
    <p><strong>Copy this token now. It is not shown again.</strong> Reloading this page creates another token.</p>
    <pre><code>${esc(t.plaintext)}</code></pre>
    <p>${esc(t.name)} · ${esc(scopeLabel(t.scope))} · expires ${esc(when(t.expiresAt))}</p>
    <p>${back}</p>`;
  const res = await appPage(chrome, { title: 'Token created', crumbs: crumbs('Created'), section: null, flash: false }, body);
  // appPage already sends no-store; the plaintext must not leak through a Referer either
  res.headers.set('Cache-Control', 'no-store');
  res.headers.set('Referrer-Policy', 'no-referrer');
  return res;
}

async function revoke(rawId: string, session: Session, stub: SpecDoStub, chrome: ChromeSource): Promise<Response> {
  const id = decodeSegment(rawId);
  const notFound = () => statusPage(chrome, 404, 'Not found', `No such token. <a href="${TOKENS_PATH}">Back to API tokens</a>`);
  if (id === null || !isValidId(id)) return notFound();
  // Owner-scoped: another actor's token is the same 404 as an unknown id
  const result = await revokeUserToken(stub, session.actorId, id, session.actorId);
  if (!result.ok) return result.status === 404 ? notFound() : UNAVAILABLE(chrome);
  return new Response(null, { status: 302, headers: { Location: `${TOKENS_PATH}?ok=${encodeURIComponent('Token revoked')}` } });
}

/** Runs after tokenPrecheck and the session-actor lookup. */
export async function handleTokenSettings(
  route: TokenRoute,
  request: Request,
  session: Session,
  viewer: IssueViewer,
  stub: SpecDoStub,
  chrome: ChromeSource
): Promise<Response> {
  switch (route.kind) {
    case 'list':
      return listPage(session, viewer, stub, chrome);
    case 'mint':
      return mint(request, session, stub, chrome);
    case 'revoke':
      return revoke(route.id, session, stub, chrome);
    default:
      return statusPage(chrome, 404, 'Not found', `Method not allowed. <a href="${TOKENS_PATH}">Back to API tokens</a>`);
  }
}
