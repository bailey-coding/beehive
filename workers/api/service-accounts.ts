/**
 * Master-only admin routes for service accounts. Tokens are generated here,
 * at the edge: the DO only ever receives the hash and a display prefix.
 */

import { generateServiceToken, hashToken, tokenPrefix } from '../shared/service-tokens';
import type { Principal } from '../shared/principal';
import type { SpecDoStub } from '../shared/spec-do-auth';

const DEFAULT_EXPIRES_IN_DAYS = 90;
const MAX_EXPIRES_IN_DAYS = 365;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

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

// X-Actor-ID is the master principal's actor ('unknown' without the header): the DO
// records it as the minting/revoking actor. Fresh headers, never the client's.
function toDo(stub: SpecDoStub, path: string, method: string, actorId: string, body?: unknown): Promise<Response> {
  return stub.fetch(
    new Request(`https://spec-do.internal${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Actor-ID': actorId },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
}

async function doError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : fallback;
  } catch {
    return fallback;
  }
}

function expiresAtFrom(days: unknown): number | Response {
  const d = days ?? DEFAULT_EXPIRES_IN_DAYS;
  if (typeof d !== 'number' || !Number.isInteger(d) || d < 1 || d > MAX_EXPIRES_IN_DAYS) {
    return err(`expiresInDays must be an integer 1-${MAX_EXPIRES_IN_DAYS}`, 400);
  }
  return Date.now() + d * 24 * 60 * 60 * 1000;
}

/** Returns a Response for /api/admin/service-accounts* and /api/whoami, else null. */
export async function handleServiceAccountRoutes(
  request: Request,
  path: string,
  principal: Principal,
  stub: SpecDoStub
): Promise<Response | null> {
  const method = request.method;

  if (path === '/api/whoami' && method === 'GET') {
    return json({
      kind: principal.kind,
      actorId: principal.actorId,
      scopes: principal.scopes,
      serviceAccountId: principal.serviceAccountId ?? null,
    });
  }

  if (!path.startsWith('/api/admin/service-accounts')) return null;

  // Defense in depth: authorize() already restricts /api/admin/* to master.
  if (principal.kind !== 'master') return err('Forbidden', 403);

  if (path === '/api/admin/service-accounts' && method === 'POST') {
    let body: { name?: unknown; scopes?: unknown; description?: unknown; expiresInDays?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return err('Invalid JSON body', 400);
    }
    if (typeof body.name !== 'string' || !NAME_RE.test(body.name)) {
      return err('name must match [a-z0-9][a-z0-9-]{0,62}', 400);
    }
    const scopes = body.scopes ?? ['read'];
    if (!Array.isArray(scopes) || scopes.length !== 1 || scopes[0] !== 'read') {
      return err("Only scopes ['read'] are supported", 400);
    }
    if (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 200)) {
      return err('description must be a string of at most 200 chars', 400);
    }
    const expiresAt = expiresAtFrom(body.expiresInDays);
    if (expiresAt instanceof Response) return expiresAt;

    const plaintext = generateServiceToken();
    let res: Response;
    try {
      res = await toDo(stub, '/internal/service-accounts', 'POST', principal.actorId, {
        name: body.name,
        scopes: ['read'],
        description: body.description,
        tokenHash: await hashToken(plaintext),
        tokenPrefix: tokenPrefix(plaintext),
        expiresAt,
        organizationId: principal.organizationId,
      });
    } catch {
      return err('Auth backend unavailable', 503);
    }
    if (res.status === 409) return err('Service account name already exists', 409);
    if (res.status === 400) return err(await doError(res, 'Invalid request'), 400);
    if (res.status !== 201) return err('Failed to create service account', 502);
    const created = ((await res.json()) as { data: { account: unknown; token: Record<string, unknown> } }).data;
    return json(
      { account: created.account, token: { ...created.token, plaintext } },
      201,
      { 'Cache-Control': 'no-store' }
    );
  }

  if (path === '/api/admin/service-accounts' && method === 'GET') {
    try {
      const res = await toDo(stub, '/internal/service-accounts', 'GET', principal.actorId);
      if (res.status !== 200) return err('Auth backend unavailable', 503);
      return json(((await res.json()) as { data: unknown }).data);
    } catch {
      return err('Auth backend unavailable', 503);
    }
  }

  const revoke = path.match(/^\/api\/admin\/service-accounts\/([^/]+)\/revoke$/);
  if (revoke && method === 'POST') {
    try {
      const res = await toDo(stub, `/internal/service-accounts/${encodeURIComponent(revoke[1])}/revoke`, 'POST', principal.actorId);
      if (res.status === 404) return err('Not found', 404);
      if (res.status !== 200) return err('Auth backend unavailable', 503);
      return json({ revoked: true });
    } catch {
      return err('Auth backend unavailable', 503);
    }
  }

  // Rotation: mint another token for an active account; plaintext returned once.
  const mintToken = path.match(/^\/api\/admin\/service-accounts\/([^/]+)\/tokens$/);
  if (mintToken && method === 'POST') {
    // Body is optional ({ expiresInDays })
    let body: { expiresInDays?: unknown } | null;
    try {
      const text = await request.text();
      body = text ? (JSON.parse(text) as typeof body) : {};
    } catch {
      return err('Invalid JSON body', 400);
    }
    const expiresAt = expiresAtFrom(body?.expiresInDays);
    if (expiresAt instanceof Response) return expiresAt;
    const plaintext = generateServiceToken();
    let res: Response;
    try {
      res = await toDo(stub, `/internal/service-accounts/${encodeURIComponent(mintToken[1])}/tokens`, 'POST', principal.actorId, {
        tokenHash: await hashToken(plaintext),
        tokenPrefix: tokenPrefix(plaintext),
        expiresAt,
      });
    } catch {
      return err('Auth backend unavailable', 503);
    }
    if (res.status === 404) return err('Not found', 404);
    if (res.status === 400 || res.status === 409) return err(await doError(res, 'Invalid request'), res.status);
    if (res.status !== 201) return err('Failed to create service token', 502);
    const created = ((await res.json()) as { data: { token: Record<string, unknown> } }).data;
    return json({ token: { ...created.token, plaintext } }, 201, { 'Cache-Control': 'no-store' });
  }

  const revokeToken = path.match(/^\/api\/admin\/service-accounts\/([^/]+)\/tokens\/([^/]+)\/revoke$/);
  if (revokeToken && method === 'POST') {
    try {
      const res = await toDo(
        stub,
        `/internal/service-accounts/${encodeURIComponent(revokeToken[1])}/tokens/${encodeURIComponent(revokeToken[2])}/revoke`,
        'POST',
        principal.actorId
      );
      if (res.status === 404) return err('Not found', 404);
      if (res.status !== 200) return err('Auth backend unavailable', 503);
      return json({ revoked: true });
    } catch {
      return err('Auth backend unavailable', 503);
    }
  }

  return err('Not found', 404);
}
