/**
 * Edge authentication and authorization (master, read-only service tokens, user tokens).
 *
 * authenticate() returns a Principal, or a Response to send back as-is
 * (callers check `instanceof Response`). Fail closed throughout:
 *   - API_AUTH_TOKEN unset                -> 503 (checked first, even for service and user tokens)
 *   - unknown/revoked/expired service tok -> 401
 *   - user token: DO {found:false} -> 401; DO 404 (an old DO without the verify route), any
 *     other status, a throw or a malformed body -> 503. Never anonymous, never master.
 *   - DO error while verifying            -> 503
 */

import { z } from 'zod';
import { jsonError } from '../shared/auth';
import { ActorIdSchema, type Principal, type Scope } from '../shared/principal';
import {
  SERVICE_TOKEN_PREFIX,
  USER_TOKEN_PREFIX,
  constantTimeEqual,
  hashToken,
  looksLikeServiceToken,
  looksLikeUserToken,
} from '../shared/service-tokens';
import type { SpecDoStub } from '../shared/spec-do-auth';

// Stored user_tokens.scope -> principal scopes (hierarchical: maintainer > read_write > read)
const USER_TOKEN_SCOPES: Record<string, Scope[]> = {
  read: ['read'],
  read_write: ['read', 'write'],
  maintainer: ['read', 'write', 'maintainer'],
};

// Verify-route bodies from the Spec DO. Parsed, not cast: anything that does not match is a 503
// (or 401 for found:false), never a half-trusted principal. Lenient on purpose (an old or new DO
// may send extra fields); actorId here is only non-empty, since the DO owns what an id is.
const NonEmpty = z.string().min(1);
const ServiceVerifySchema = z.object({
  success: z.literal(true),
  data: z.object({
    kind: z.literal('service'),
    actorId: NonEmpty,
    serviceAccountId: z.string().optional(),
  }),
});
const UserVerifySchema = z.union([
  z.object({ success: z.literal(true), data: z.object({ found: z.literal(false) }) }),
  z.object({
    success: z.literal(true),
    data: z.object({
      found: z.literal(true),
      actorId: NonEmpty,
      userTokenId: NonEmpty,
      scope: z.enum(['read', 'read_write', 'maintainer']),
    }),
  }),
]);

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
  stub: SpecDoStub
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
    // Only master may assert an actor, so only master's header is validated. Absent or empty is
    // 'unknown' (as before); present but malformed is a 400, never passed on to the DO.
    const asserted = request.headers.get('X-Actor-ID');
    if (asserted) {
      const parsed = ActorIdSchema.safeParse(asserted);
      if (!parsed.success) return jsonError('Invalid X-Actor-ID', 400);
    }
    return {
      kind: 'master',
      actorId: asserted || 'unknown',
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
      const body = ServiceVerifySchema.safeParse(await res.json());
      if (!body.success) return jsonError('Auth backend unavailable', 503);
      const d = body.data.data;
      return {
        kind: 'service',
        actorId: d.actorId,
        // Read-only slice: whatever is stored, a service principal never exceeds read.
        scopes: ['read'],
        promotionAuthority: false,
        organizationId: null,
        serviceAccountId: d.serviceAccountId,
      };
    } catch {
      return jsonError('Auth backend unavailable', 503);
    }
  }

  // User tokens (RFC-0008), Authorization: Bearer only. Every request verifies in the DO (no
  // cache), so a revocation or an expiry applies from the next request.
  if (bearer !== null && bearer.startsWith(USER_TOKEN_PREFIX)) {
    if (!looksLikeUserToken(bearer)) return jsonError('Unauthorized', 401);
    const tokenHash = await hashToken(bearer);
    let res: Response;
    try {
      res = await stub.fetch(
        new Request('https://spec-do.internal/internal/user-tokens/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tokenHash }),
        })
      );
    } catch {
      return jsonError('Auth backend unavailable', 503);
    }
    // The verify route answers 200 for every well-formed hash. Unlike the service branch, a 404
    // is not "no such token": it is a DO that lacks the route (mid-deploy or a rollback), so 503.
    if (res.status !== 200) return jsonError('Auth backend unavailable', 503);
    try {
      const body = UserVerifySchema.safeParse(await res.json());
      if (!body.success) return jsonError('Auth backend unavailable', 503);
      const d = body.data.data;
      if (!d.found) return jsonError('Unauthorized', 401);
      const scopes = USER_TOKEN_SCOPES[d.scope];
      return {
        kind: 'user',
        actorId: d.actorId,
        scopes: [...scopes],
        promotionAuthority: false,
        organizationId: null,
        userTokenId: d.userTokenId,
      };
    } catch {
      return jsonError('Auth backend unavailable', 503);
    }
  }

  return jsonError('Unauthorized', 401);
}

/**
 * Writes a user token may make (S9 matrix, docs/M12-IMPL-PLAN.md section 4). An allow-list: a
 * write route missing here is a 403, so a new route is closed to user tokens until it is added.
 * Never here: actor admin (create, trust, promotion authority), gate verdicts, trials,
 * promotions, candidate stage (no transition guard; rung outcomes go through it) and candidate
 * execute (a client-supplied sandbox URL the DO fetches), lifecycle and /api/admin/*. The DO
 * still applies its own rules (author match, creator-or-maintainer) on every route.
 */
const USER_WRITE_ROUTES: Array<{ method: string; path: RegExp }> = [
  { method: 'POST', path: /^\/api\/organizations$/ },
  { method: 'POST', path: /^\/api\/repositories$/ },
  { method: 'POST', path: /^\/api\/specs$/ },
  // Spec lifecycle stage, not an oracle rung
  { method: 'PATCH', path: /^\/api\/specs\/[^/]+\/stage$/ },
  { method: 'POST', path: /^\/api\/specs\/[^/]+\/claim$/ },
  { method: 'POST', path: /^\/api\/candidates$/ },
  // Starts the real gate workflow; the verdict is written by the gate, not the caller
  { method: 'POST', path: /^\/api\/candidates\/[^/]+\/gate\/pre-merge$/ },
  { method: 'POST', path: /^\/api\/issues$/ },
  { method: 'PATCH', path: /^\/api\/issues\/[^/]+\/stage$/ },
  { method: 'PATCH', path: /^\/api\/issues\/[^/]+\/status$/ },
  { method: 'POST', path: /^\/api\/issues\/[^/]+\/comments$/ },
  { method: 'POST', path: /^\/api\/issue-spec-links$/ },
  { method: 'POST', path: /^\/api\/issue-candidate-links$/ },
];

/** Writes that also need the `maintainer` scope (the DO re-checks the live role). */
const USER_MAINTAINER_ROUTES: Array<{ method: string; path: RegExp }> = [
  { method: 'PATCH', path: /^\/api\/issues\/[^/]+\/comment-policy$/ },
];

const matches = (routes: Array<{ method: string; path: RegExp }>, method: string, path: string) =>
  routes.some((r) => r.method === method && r.path.test(path));

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
  // Service principals are read-only whatever they hold; only user tokens write
  if (p.kind === 'user' && !isRead) {
    if (p.scopes.includes('write') && matches(USER_WRITE_ROUTES, method, path)) return null;
    if (p.scopes.includes('maintainer') && matches(USER_MAINTAINER_ROUTES, method, path)) return null;
  }
  return jsonError('Forbidden', 403);
}

export function requireScope(p: Principal, scope: Scope): Response | null {
  return p.scopes.includes(scope) ? null : jsonError('Forbidden', 403);
}
