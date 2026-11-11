/**
 * Which request headers a mirrored request may carry to a target.
 *
 * Candidates run agent-written code, so they must never see the caller's credentials: the router receives
 * `Authorization` (the platform bearer token, or a user's), cookies, and internal headers such as `X-Actor-ID`.
 * Every target, the production baseline included, gets the allowlist: the baseline is fetched with the same sanitized
 * request as the candidates, so the comparison is like for like and no credential is replayed.
 */
export const BASELINE_TARGET_ID = 'beehive-main';

const CANDIDATE_HEADER_ALLOWLIST = ['accept', 'accept-language', 'content-type', 'user-agent', 'x-request-id'];

export function headersForTarget(_targetId: string, source: Headers): Headers {
  const out = new Headers();
  for (const name of CANDIDATE_HEADER_ALLOWLIST) {
    const value = source.get(name);
    if (value !== null) out.set(name, value);
  }
  return out;
}

// An allowlist, not a denylist: a denylist of five names let x-csrf-token, x-auth-token, cf-access-jwt-assertion, x-forwarded-for and
// similar land in queue messages. The comparator never reads request headers.
const QUEUE_REQUEST_HEADER_ALLOWLIST = ['accept', 'content-type'];
const QUEUE_RESPONSE_HEADER_ALLOWLIST = ['content-type', 'content-length', 'cache-control', 'etag'];
const MAX_QUEUE_HEADER_VALUE_CHARS = 200;

function pickHeaders(source: Headers, allow: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of allow) {
    const value = source.get(name);
    if (value !== null) out[name] = value.slice(0, MAX_QUEUE_HEADER_VALUE_CHARS);
  }
  return out;
}

/** Request headers kept in a Scientist queue message: an allowlist, so credentials and unknown headers are never persisted. */
export function scientistSafeHeaders(source: Headers): Record<string, string> {
  return pickHeaders(source, QUEUE_REQUEST_HEADER_ALLOWLIST);
}

/** Candidate response headers kept in a Scientist queue message: a short allowlist with bounded values (the candidate is untrusted). */
export function scientistSafeResponseHeaders(source: Headers): Record<string, string> {
  return pickHeaders(source, QUEUE_RESPONSE_HEADER_ALLOWLIST);
}
