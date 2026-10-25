/**
 * Which request headers a mirrored request may carry to a target.
 *
 * Candidates run agent-written code, so they must never see the caller's credentials: the router receives
 * `Authorization` (the platform bearer token, or a user's), cookies, and internal headers such as `X-Actor-ID`.
 * Candidates therefore get an allowlist. The baseline target (production `beehive-main`) is trusted code and
 * keeps the original headers, so the comparison is like for like.
 */
export const BASELINE_TARGET_ID = 'beehive-main';

const CANDIDATE_HEADER_ALLOWLIST = ['accept', 'accept-language', 'content-type', 'user-agent', 'x-request-id'];

export function headersForTarget(targetId: string, source: Headers): Headers {
  if (targetId === BASELINE_TARGET_ID) return source;
  const out = new Headers();
  for (const name of CANDIDATE_HEADER_ALLOWLIST) {
    const value = source.get(name);
    if (value !== null) out.set(name, value);
  }
  return out;
}
