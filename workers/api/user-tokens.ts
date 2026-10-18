/**
 * User tokens (RFC-0008) at the edge: the DO client shared by the master-only admin routes
 * here and the UI settings page (ui-tokens.ts), and the admin routes themselves.
 *
 *   POST /api/admin/user-tokens {actorId, name, scope?, expiresInDays?}  mint; plaintext once, no-store
 *   GET  /api/admin/user-tokens[?actorId=]                               list (prefix only, never a hash)
 *   POST /api/admin/user-tokens/:id/revoke                               revoke one (idempotent)
 *   POST /api/admin/user-tokens/revoke-all {actorId}                     revoke every live token of an actor
 *
 * Tokens are generated here: the DO only ever receives the hash and the display prefix.
 * Every DO answer is checked: an older DO without these routes answers 404 'Not found', which
 * is a 503 here, never "no tokens" or "no such token" (USER_TOKEN_NOT_FOUND marks the real ones).
 */

import { generateUserToken, hashToken, tokenPrefix } from '../shared/service-tokens';
import type { Principal } from '../shared/principal';
import { USER_TOKEN_ACTOR_NOT_FOUND, USER_TOKEN_NOT_FOUND, type SpecDoStub } from '../shared/spec-do-auth';

export const USER_TOKEN_SCOPE_VALUES = ['read', 'read_write', 'maintainer'] as const;
export type UserTokenScope = (typeof USER_TOKEN_SCOPE_VALUES)[number];
export const DEFAULT_USER_TOKEN_DAYS = 30;
export const MAX_USER_TOKEN_DAYS = 90;
export const MAX_USER_TOKEN_NAME_CHARS = 64;
const UNAVAILABLE = 'Token service unavailable';
const DAY_MS = 24 * 60 * 60 * 1000;

/** A token as the DO lists it (never the hash), plus the plaintext right after a mint. */
export interface UserTokenView {
  id: string;
  actorId: string;
  name: string;
  prefix: string;
  scope: UserTokenScope;
  createdBy: string;
  createdVia: 'session' | 'admin';
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  revokedBy: string | null;
  lastUsedAt: number | null;
}

export type DoResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

export interface MintInput {
  name: string;
  scope: UserTokenScope;
  expiresAt: number;
}

/** Validates name, scope (default read) and expiresInDays (integer 1-90, default 30). */
export function checkMintInput(name: unknown, scope: unknown, expiresInDays: unknown): MintInput | string {
  if (typeof name !== 'string' || name.trim() === '' || name.trim().length > MAX_USER_TOKEN_NAME_CHARS) {
    return `name must be a non-empty string of at most ${MAX_USER_TOKEN_NAME_CHARS} chars`;
  }
  const s = scope ?? 'read';
  if (typeof s !== 'string' || !(USER_TOKEN_SCOPE_VALUES as readonly string[]).includes(s)) {
    return `scope must be one of ${USER_TOKEN_SCOPE_VALUES.join(', ')}`;
  }
  const d = expiresInDays ?? DEFAULT_USER_TOKEN_DAYS;
  if (typeof d !== 'number' || !Number.isInteger(d) || d < 1 || d > MAX_USER_TOKEN_DAYS) {
    return `expiresInDays must be an integer 1-${MAX_USER_TOKEN_DAYS}`;
  }
  return { name: name.trim(), scope: s as UserTokenScope, expiresAt: Date.now() + d * DAY_MS };
}

// X-Actor-ID is the minting/revoking actor (the DO maps 'unknown' to the reserved master
// actor). Fresh headers, never the client's.
function toDo(stub: SpecDoStub, path: string, method: string, actorId: string, body?: unknown): Promise<Response> {
  return stub.fetch(
    new Request(`https://spec-do.internal${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Actor-ID': actorId },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
}

async function errorOf(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : null;
  } catch {
    return null;
  }
}

async function dataOf<T>(res: Response): Promise<DoResult<T>> {
  try {
    const body = (await res.json()) as { success?: unknown; data?: T };
    if (body.success !== true || body.data === undefined) return { ok: false, status: 503, error: UNAVAILABLE };
    return { ok: true, data: body.data };
  } catch {
    return { ok: false, status: 503, error: UNAVAILABLE };
  }
}

/**
 * Mints a token for `actorId`. The plaintext exists only in the returned value. 400/403/409
 * from the DO are passed on with its message; anything else (an old DO's 404, 5xx, a throw)
 * is 503.
 */
export async function mintUserToken(
  stub: SpecDoStub,
  minterActorId: string,
  actorId: string,
  input: MintInput,
  createdVia: 'session' | 'admin'
): Promise<DoResult<UserTokenView & { plaintext: string }>> {
  const plaintext = generateUserToken();
  let res: Response;
  try {
    res = await toDo(stub, '/internal/user-tokens', 'POST', minterActorId, {
      actorId,
      name: input.name,
      scope: input.scope,
      createdVia,
      tokenHash: await hashToken(plaintext),
      tokenPrefix: tokenPrefix(plaintext),
      expiresAt: input.expiresAt,
    });
  } catch {
    return { ok: false, status: 503, error: UNAVAILABLE };
  }
  if (res.status === 400 || res.status === 403 || res.status === 409) {
    return { ok: false, status: res.status, error: (await errorOf(res)) ?? 'Invalid request' };
  }
  if (res.status !== 201) return { ok: false, status: 503, error: UNAVAILABLE };
  const created = await dataOf<UserTokenView>(res);
  if (!created.ok) return created;
  if (typeof created.data.id !== 'string' || typeof created.data.prefix !== 'string') {
    return { ok: false, status: 503, error: UNAVAILABLE };
  }
  return { ok: true, data: { ...created.data, plaintext } };
}

/** Every token (of one actor when given), newest first. Only a 200 with a list is a list. */
export async function listUserTokens(stub: SpecDoStub, callerActorId: string, actorId: string | null): Promise<DoResult<UserTokenView[]>> {
  const query = actorId === null ? '' : `?actorId=${encodeURIComponent(actorId)}`;
  let res: Response;
  try {
    res = await toDo(stub, `/internal/user-tokens${query}`, 'GET', callerActorId);
  } catch {
    return { ok: false, status: 503, error: UNAVAILABLE };
  }
  if (res.status !== 200) return { ok: false, status: 503, error: UNAVAILABLE };
  const list = await dataOf<UserTokenView[]>(res);
  if (list.ok && !Array.isArray(list.data)) return { ok: false, status: 503, error: UNAVAILABLE };
  return list;
}

/** Revokes one token; with `ownerActorId`, only that actor's (another's is a 404, like an unknown id). */
export async function revokeUserToken(
  stub: SpecDoStub,
  revokerActorId: string,
  tokenId: string,
  ownerActorId: string | null
): Promise<DoResult<{ revoked: true; token: UserTokenView }>> {
  let res: Response;
  try {
    res = await toDo(
      stub,
      `/internal/user-tokens/${encodeURIComponent(tokenId)}/revoke`,
      'POST',
      revokerActorId,
      ownerActorId === null ? undefined : { actorId: ownerActorId }
    );
  } catch {
    return { ok: false, status: 503, error: UNAVAILABLE };
  }
  if (res.status === 404 && (await errorOf(res)) === USER_TOKEN_NOT_FOUND) return { ok: false, status: 404, error: 'Not found' };
  if (res.status !== 200) return { ok: false, status: 503, error: UNAVAILABLE };
  return dataOf(res);
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ success: status < 400, data, timestamp: Date.now() }), {
    status,
    headers: { 'Content-Type': 'application/json', ...extra },
  });
}

function err(error: string, status: number): Response {
  return new Response(JSON.stringify({ success: false, error, timestamp: Date.now() }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const relay = <T>(r: DoResult<T>, status = 200): Response => (r.ok ? json(r.data, status) : err(r.error, r.status));

/** A decoded path segment, or null for a malformed escape (a 404, not a 500). */
export function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

async function readObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Returns a Response for /api/admin/user-tokens*, else null. */
export async function handleUserTokenRoutes(
  request: Request,
  path: string,
  principal: Principal,
  stub: SpecDoStub
): Promise<Response | null> {
  if (path !== '/api/admin/user-tokens' && !path.startsWith('/api/admin/user-tokens/')) return null;
  // Defense in depth: authorize() already restricts /api/admin/* to master
  if (principal.kind !== 'master') return err('Forbidden', 403);
  const method = request.method;

  if (path === '/api/admin/user-tokens' && method === 'POST') {
    const body = await readObject(request);
    if (!body) return err('Invalid JSON body', 400);
    if (typeof body.actorId !== 'string' || body.actorId === '') return err('actorId must be a non-empty string', 400);
    const input = checkMintInput(body.name, body.scope, body.expiresInDays);
    if (typeof input === 'string') return err(input, 400);
    const minted = await mintUserToken(stub, principal.actorId, body.actorId, input, 'admin');
    if (!minted.ok) return err(minted.error, minted.status);
    return json({ token: minted.data }, 201, { 'Cache-Control': 'no-store' });
  }

  if (path === '/api/admin/user-tokens' && method === 'GET') {
    return relay(await listUserTokens(stub, principal.actorId, new URL(request.url).searchParams.get('actorId')));
  }

  if (path === '/api/admin/user-tokens/revoke-all' && method === 'POST') {
    const body = await readObject(request);
    if (!body) return err('Invalid JSON body', 400);
    if (typeof body.actorId !== 'string' || body.actorId === '') return err('actorId must be a non-empty string', 400);
    let res: Response;
    try {
      res = await toDo(stub, '/internal/user-tokens/revoke-all', 'POST', principal.actorId, { actorId: body.actorId });
    } catch {
      return err(UNAVAILABLE, 503);
    }
    if (res.status === 404 && (await errorOf(res)) === USER_TOKEN_ACTOR_NOT_FOUND) return err('Not found', 404);
    if (res.status !== 200) return err(UNAVAILABLE, 503);
    return relay(await dataOf(res));
  }

  const revoke = path.match(/^\/api\/admin\/user-tokens\/([^/]+)\/revoke$/);
  if (revoke && method === 'POST') {
    const tokenId = decodeSegment(revoke[1]);
    if (tokenId === null) return err('Not found', 404);
    return relay(await revokeUserToken(stub, principal.actorId, tokenId, null));
  }

  return err('Not found', 404);
}
