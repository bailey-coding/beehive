/**
 * Principal types shared by the edge (and, later, the fork-token endpoint).
 *
 * Produced today: `master`, `service` (always `read` only) and `user` (a `bh_usr_`
 * token of one human actor, RFC-0008). `session` is reserved so the fork-token work
 * can extend the interface without reshaping it.
 */

import { z } from 'zod';
import { jsonError } from './auth';

/**
 * A client-asserted X-Actor-ID (master token only; service and user tokens get it overwritten).
 * Deliberately loose: actor ids are UUIDs but ids like 'queue-consumer' exist, so this rejects only
 * what can never be an id (empty, over-long, whitespace or non-printable characters).
 */
export const ACTOR_ID_MAX_CHARS = 128;
export const ActorIdSchema = z
  .string()
  .min(1)
  .max(ACTOR_ID_MAX_CHARS)
  .regex(/^[\x21-\x7e]+$/);

export type Scope = 'read' | 'write' | 'maintainer';

export interface Principal {
  kind: 'master' | 'service' | 'user' | 'session';
  /** FK-valid actors.id; 'unknown' only for master without X-Actor-ID. */
  actorId: string;
  /**
   * master: ['read','write']; write implies read, maintainer implies write. A user token's
   * stored scope maps read -> ['read'], read_write -> ['read','write'],
   * maintainer -> ['read','write','maintainer'].
   */
  scopes: Scope[];
  /** service: live actors.promotion_authority; master: true. Not enforced yet. */
  promotionAuthority: boolean;
  /** Write confinement (deferred); null = unconfined. */
  organizationId: string | null;
  serviceAccountId?: string;
  /** user: user_tokens.id of the presented token (never the token or its hash). */
  userTokenId?: string;
  githubLogin?: string;
}


// =============================================================================
// Custom Request Types for compile-time auth safety
// "Validate by parsing" principle: encode auth invariants in the type system
// =============================================================================

// Branded type symbols (unique per type to prevent structural compatibility)
declare const AuthedRequestBrand: unique symbol;
declare const ActorRequestBrand: unique symbol;
declare const ReadRequestBrand: unique symbol;
declare const WriteRequestBrand: unique symbol;
declare const MaintainerRequestBrand: unique symbol;

/**
 * Base authenticated request - carries a validated Principal.
 * Guarantees: authentication has passed, principal is available.
 */
export type AuthedRequest = Request & {
  [AuthedRequestBrand]: never;
  principal: Principal;
};

/**
 * Request with a guaranteed actorId.
 * Guarantees: actorId is a non-empty string. Master without X-Actor-ID carries 'unknown'; routes
 * that need a real actor reject it themselves (as before), so health/bootstrap keep working.
 */
export type ActorRequest = AuthedRequest & {
  [ActorRequestBrand]: never;
  actorId: string;
};

/**
 * Request with guaranteed read scope.
 * Guarantees: principal.scopes includes 'read'.
 */
export type ReadRequest = ActorRequest & {
  [ReadRequestBrand]: never;
  scopes: Scope[] & ['read', ...Scope[]];
};

/**
 * Request with guaranteed write scope.
 * Guarantees: principal.scopes includes 'write' (which implies 'read').
 */
export type WriteRequest = ActorRequest & {
  [WriteRequestBrand]: never;
  scopes: Scope[] & ['write', ...Scope[]];
};

/**
 * Request with guaranteed maintainer scope.
 * Guarantees: principal.scopes includes 'maintainer' (which implies 'write' and 'read').
 */
export type MaintainerRequest = ActorRequest & {
  [MaintainerRequestBrand]: never;
  scopes: Scope[] & ['maintainer', ...Scope[]];
};


// =============================================================================
// Wrapper Helpers: Transform Request + Principal into typed requests
// Fail-closed: return Response on failure, never throw
// =============================================================================

/**
 * Wrap a plain Request with a Principal to create an AuthedRequest.
 * Use at the edge after authenticate() passes.
 */
export function withAuth(request: Request, principal: Principal): AuthedRequest {
  return Object.assign(request, { principal }) as AuthedRequest;
}

/**
 * Wrap an AuthedRequest with actorId guarantee to create an ActorRequest.
 * Returns 503 if principal has no actorId (should never happen in practice). 'unknown' (master
 * without X-Actor-ID) is allowed through: rejecting it here would break /health and bootstrap.
 */
export function withActor(request: Request, principal: Principal): ActorRequest | Response {
  if (!principal.actorId) {
    return jsonError('Actor required', 503);
  }
  return Object.assign(request, {
    principal,
    actorId: principal.actorId,
  }) as ActorRequest;
}

/**
 * Assert read scope on an AuthedRequest.
 * Returns 403 if scope not present.
 * Note: This asserts; actual enforcement is in authorize() (defense in depth).
 */
export function withReadScope(req: AuthedRequest): ReadRequest | Response {
  if (!req.principal.scopes.includes('read')) {
    return jsonError('Forbidden', 403);
  }
  return Object.assign(req, {
    scopes: req.principal.scopes as Scope[] & ['read', ...Scope[]],
  }) as ReadRequest;
}

/**
 * Assert write scope on an AuthedRequest.
 * Returns 403 if scope not present.
 * Note: This asserts; actual enforcement is in authorize() (defense in depth).
 */
export function withWriteScope(req: AuthedRequest): WriteRequest | Response {
  if (!req.principal.scopes.includes('write')) {
    return jsonError('Forbidden', 403);
  }
  return Object.assign(req, {
    scopes: req.principal.scopes as Scope[] & ['write', ...Scope[]],
  }) as WriteRequest;
}

/**
 * Assert maintainer scope on an AuthedRequest.
 * Returns 403 if scope not present.
 * Note: This asserts; actual enforcement is in authorize() (defense in depth).
 */
export function withMaintainerScope(req: AuthedRequest): MaintainerRequest | Response {
  if (!req.principal.scopes.includes('maintainer')) {
    return jsonError('Forbidden', 403);
  }
  return Object.assign(req, {
    scopes: req.principal.scopes as Scope[] & ['maintainer', ...Scope[]],
  }) as MaintainerRequest;
}
