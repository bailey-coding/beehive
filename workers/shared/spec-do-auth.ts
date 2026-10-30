/**
 * Two-tier internal auth for the Spec DO's fetch router (blast-radius reduction).
 *
 * Any worker with the cross-script SPEC_DO binding can call the DO directly, so the DO checks
 * a token of its own, independent of the edge's API_AUTH_TOKEN:
 *   - tier 1, SPEC_DO_INTERNAL_TOKEN in `X-Beehive-Internal`: every DO route.
 *   - tier 2, SPEC_DO_ADMIN_TOKEN in `X-Beehive-Admin`, additionally: privileged routes only
 *     (isAdminRoute below). Only the `beehive` API worker is given the admin token.
 *
 * Fail-closed, like workers/shared/auth.ts: the DO's own secret unset -> 503; missing or wrong
 * tier-1 token -> 401; valid tier-1 token without the admin token on an admin route -> 403.
 * Token values are never logged or echoed.
 *
 * Callers never set the headers by hand: getSpecDoStub(env) returns a stub whose fetch attaches
 * whatever tokens that worker's env holds (the admin token only on admin routes).
 */

export const INTERNAL_TOKEN_HEADER = 'X-Beehive-Internal';
export const ADMIN_TOKEN_HEADER = 'X-Beehive-Admin';

/**
 * Sent by the edge on every DO request made for a user token without the `maintainer` scope.
 * Its presence (any value) makes every isMaintainer decision of that request false. No header
 * means full power, as for the UI session, an old edge and the nine other workers, so a
 * spoofed header can only remove power.
 */
export const MAINTAINER_CAP_HEADER = 'X-Beehive-Maintainer-Cap';

/**
 * The `error` of the user-token routes' own 404s. A DO without those routes (an older
 * deploy) answers 404 'Not found' instead, which the edge must treat as 503, never as
 * "no such token" or "no tokens".
 */
export const USER_TOKEN_NOT_FOUND = 'user token not found';
export const USER_TOKEN_ACTOR_NOT_FOUND = 'actor not found';

const SPEC_DO_ORIGIN = 'https://spec-do.internal';
const DEFAULT_SPEC_DO_NAME = 'main';

/** The DO's own secrets (DO host: the `beehive` worker). */
export interface SpecDoAuthEnv {
  SPEC_DO_INTERNAL_TOKEN?: string;
  SPEC_DO_ADMIN_TOKEN?: string;
}

/** A calling worker's env: the binding plus whichever tokens that worker was given. */
export interface SpecDoCallerEnv extends SpecDoAuthEnv {
  SPEC_DO: DurableObjectNamespace;
}

export type SpecDoStub = Pick<DurableObjectStub, 'fetch'>;

const ADMIN_PATTERNS: Array<{ method: string; path: RegExp }> = [
  // Ledger lifecycle (workers/shared/ledger-lifecycle.ts LIFECYCLE_PATHS)
  { method: 'POST', path: /^\/internal\/tombstone$/ },
  { method: 'POST', path: /^\/internal\/purge$/ },
  { method: 'POST', path: /^\/internal\/actors\/[^/]+\/role$/ },
  // Service accounts and tokens: list, mint, revoke, token mint/rotate/revoke.
  // /internal/service-tokens/verify (the edge's per-request token check) is tier 1.
  { method: '*', path: /^\/internal\/service-accounts(?:\/.*)?$/ },
  // User tokens: mint, list, revoke, revoke-all (RFD-0008). /internal/user-tokens/verify is
  // tier 1, like the service-token verify; the lookahead excludes exactly that path.
  { method: '*', path: /^\/internal\/user-tokens(?!\/verify$)(?:\/.*)?$/ },
  // Sets the flag that lets an actor promote; the edge allows it for the master principal only
  { method: 'PATCH', path: /^\/api\/actors\/[^/]+\/promotion-authority$/ },
];

/** Routes that need the admin token on top of the internal one. Single source for DO and clients. */
export function isAdminRoute(method: string, pathname: string): boolean {
  const m = method.toUpperCase();
  return ADMIN_PATTERNS.some((p) => (p.method === '*' || p.method === m) && p.path.test(pathname));
}

/**
 * Constant-time string comparison: the loop always covers the longer input, so timing depends
 * on length only (never on where the first difference is).
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  const len = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < len; i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}

function deny(error: string, status: number): Response {
  return new Response(JSON.stringify({ success: false, error, timestamp: Date.now() }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Returns a Response when the request must not reach the DO's router, or null to proceed.
 * Runs before any routing or schema work.
 */
export function specDoAuthGate(request: Request, env: SpecDoAuthEnv | undefined): Response | null {
  const internal = env?.SPEC_DO_INTERNAL_TOKEN;
  if (!internal) return deny('SPEC_DO_INTERNAL_TOKEN not configured', 503);

  const admin = isAdminRoute(request.method, new URL(request.url).pathname);
  const adminSecret = env?.SPEC_DO_ADMIN_TOKEN;
  if (admin && !adminSecret) return deny('SPEC_DO_ADMIN_TOKEN not configured', 503);

  const presented = request.headers.get(INTERNAL_TOKEN_HEADER);
  if (presented === null || !timingSafeEqual(presented, internal)) return deny('Unauthorized', 401);

  if (admin) {
    const adminPresented = request.headers.get(ADMIN_TOKEN_HEADER);
    if (adminPresented === null || !timingSafeEqual(adminPresented, adminSecret as string)) {
      return deny('Forbidden', 403);
    }
  }
  return null;
}

/**
 * A Spec DO stub whose fetch attaches this worker's tokens. Accepts relative or absolute URLs,
 * strings, URLs or Requests (DO stubs require absolute URLs, so relative ones resolve against
 * an internal origin).
 */
function toDoRequest(input: RequestInfo | URL, init?: RequestInit): Request {
  return typeof input === 'string' || input instanceof URL
    ? new Request(new URL(input.toString(), SPEC_DO_ORIGIN), init)
    : new Request(input, init);
}

export function authedSpecDoStub(stub: SpecDoStub, env: SpecDoAuthEnv): SpecDoStub {
  return {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const request = toDoRequest(input, init);
      if (env.SPEC_DO_INTERNAL_TOKEN) request.headers.set(INTERNAL_TOKEN_HEADER, env.SPEC_DO_INTERNAL_TOKEN);
      if (env.SPEC_DO_ADMIN_TOKEN && isAdminRoute(request.method, new URL(request.url).pathname)) {
        request.headers.set(ADMIN_TOKEN_HEADER, env.SPEC_DO_ADMIN_TOKEN);
      }
      return stub.fetch(request);
    },
  };
}

/**
 * The same stub with MAINTAINER_CAP_HEADER on every request, whatever its input form (the edge
 * wraps its stub once for a user token without the maintainer scope, so no handler can forget).
 */
export function maintainerCappedStub(stub: SpecDoStub): SpecDoStub {
  return {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const request = toDoRequest(input, init);
      request.headers.set(MAINTAINER_CAP_HEADER, '1');
      return stub.fetch(request);
    },
  };
}

/** The Spec DO stub for a worker's env, with that worker's tokens attached to every call. */
export function getSpecDoStub(env: SpecDoCallerEnv, name: string = DEFAULT_SPEC_DO_NAME): SpecDoStub {
  return authedSpecDoStub(env.SPEC_DO.get(env.SPEC_DO.idFromName(name)), env);
}
