/**
 * Master-only admin routes for service accounts. Tokens are generated here,
 * at the edge: the DO only ever receives the hash and a display prefix.
 */

import { generateServiceToken, hashToken, tokenPrefix } from '../shared/service-tokens';
import type { Principal } from '../shared/principal';

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

function toDo(stub: DurableObjectStub, path: string, method: string, body?: unknown): Promise<Response> {
  return stub.fetch(
    new Request(`https://spec-do.internal${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
}

/** Returns a Response for /api/admin/service-accounts* and /api/whoami, else null. */
export async function handleServiceAccountRoutes(
  request: Request,
  path: string,
  principal: Principal,
  stub: DurableObjectStub
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
    const days = body.expiresInDays ?? DEFAULT_EXPIRES_IN_DAYS;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_EXPIRES_IN_DAYS) {
      return err(`expiresInDays must be an integer 1-${MAX_EXPIRES_IN_DAYS}`, 400);
    }

    const plaintext = generateServiceToken();
    const expiresAt = Date.now() + days * 24 * 60 * 60 * 1000;
    let res: Response;
    try {
      res = await toDo(stub, '/internal/service-accounts', 'POST', {
        name: body.name,
        scopes: ['read'],
        description: body.description,
        tokenHash: await hashToken(plaintext),
        tokenPrefix: tokenPrefix(plaintext),
        expiresAt,
        organizationId: principal.organizationId,
        createdBy: principal.actorId,
      });
    } catch {
      return err('Auth backend unavailable', 503);
    }
    if (res.status === 409) return err('Service account name already exists', 409);
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
      const res = await toDo(stub, '/internal/service-accounts', 'GET');
      if (res.status !== 200) return err('Auth backend unavailable', 503);
      return json(((await res.json()) as { data: unknown }).data);
    } catch {
      return err('Auth backend unavailable', 503);
    }
  }

  const revoke = path.match(/^\/api\/admin\/service-accounts\/([^/]+)\/revoke$/);
  if (revoke && method === 'POST') {
    try {
      const res = await toDo(stub, `/internal/service-accounts/${encodeURIComponent(revoke[1])}/revoke`, 'POST');
      if (res.status === 404) return err('Not found', 404);
      if (res.status !== 200) return err('Auth backend unavailable', 503);
      return json({ revoked: true });
    } catch {
      return err('Auth backend unavailable', 503);
    }
  }

  return err('Not found', 404);
}
