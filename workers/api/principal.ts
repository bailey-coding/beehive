/**
 * Edge authentication and authorization (read-only service-token slice).
 *
 * authenticate() returns a Principal, or a Response to send back as-is
 * (callers check `instanceof Response`). Fail closed throughout:
 *   - API_AUTH_TOKEN unset                -> 503 (checked first, even for service tokens)
 *   - unknown/revoked/expired service tok -> 401
 *   - DO error while verifying            -> 503
 */

import { jsonError } from '../shared/auth';
import type { Principal, Scope } from '../shared/principal';
import { SERVICE_TOKEN_PREFIX, constantTimeEqual, hashToken, looksLikeServiceToken } from '../shared/service-tokens';

export interface AuthEnv {
  API_AUTH_TOKEN?: string;
}

function bearerOf(request: Request): string | null {
  const header = request.headers.get('Authorization');
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length);
}

export async function authenticate(
  request: Request,
  env: AuthEnv,
  stub: DurableObjectStub
): Promise<Principal | Response> {
  const master = env.API_AUTH_TOKEN;
  if (!master) return jsonError('API_AUTH_TOKEN not configured', 503);

  const bearer = bearerOf(request);
  const apiToken = request.headers.get('X-API-Token');

  // Master token (Authorization or X-API-Token): unchanged behavior and actor semantics.
  if (
    (bearer !== null && (await constantTimeEqual(bearer, master))) ||
    (apiToken !== null && (await constantTimeEqual(apiToken, master)))
  ) {
    return {
      kind: 'master',
      actorId: request.headers.get('X-Actor-ID') || 'unknown',
      scopes: ['read', 'write'],
      promotionAuthority: true,
      organizationId: null,
    };
  }

  // Service tokens are accepted only via Authorization: Bearer.
  if (bearer !== null && bearer.startsWith(SERVICE_TOKEN_PREFIX)) {
    if (!looksLikeServiceToken(bearer)) return jsonError('Unauthorized', 401);
    const tokenHash = await hashToken(bearer);
    let res: Response;
    try {
      res = await stub.fetch(
        new Request('https://spec-do.internal/internal/service-tokens/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tokenHash }),
        })
      );
    } catch {
      return jsonError('Auth backend unavailable', 503);
    }
    if (res.status === 404) return jsonError('Unauthorized', 401);
    if (res.status !== 200) return jsonError('Auth backend unavailable', 503);
    try {
      const body = (await res.json()) as {
        success?: boolean;
        data?: { kind?: string; actorId: string; serviceAccountId: string; promotionAuthority?: boolean };
      };
      if (!body.success || body.data?.kind !== 'service' || typeof body.data.actorId !== 'string' || !body.data.actorId) {
        return jsonError('Auth backend unavailable', 503);
      }
      return {
        kind: 'service',
        actorId: body.data.actorId,
        // Read-only slice: whatever is stored, a service principal never exceeds read.
        scopes: ['read'],
        promotionAuthority: false,
        organizationId: null,
        serviceAccountId: body.data.serviceAccountId,
      };
    } catch {
      return jsonError('Auth backend unavailable', 503);
    }
  }

  return jsonError('Unauthorized', 401);
}

/**
 * Deny-by-default route policy. `path` MUST be url.pathname (never request.url).
 * Returns a 403 Response, or null when allowed.
 */
export function authorize(p: Principal, method: string, path: string): Response | null {
  if (p.kind === 'master') return null;
  const isRead = method === 'GET' || method === 'HEAD';
  if (isRead && p.scopes.includes('read')) {
    if (path === '/health' || path === '/api/health' || path === '/api/whoami') return null;
    if (path.startsWith('/api/') && !path.startsWith('/api/admin/') && path !== '/api/admin') return null;
  }
  return jsonError('Forbidden', 403);
}

export function requireScope(p: Principal, scope: Scope): Response | null {
  return p.scopes.includes(scope) ? null : jsonError('Forbidden', 403);
}
