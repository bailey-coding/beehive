/**
 * What a mirrored request may carry to a candidate (docs/M5A-2-GOVERNANCE-PLAN.md, Rev 5, PR-H).
 *
 * Candidates run agent-written, unreviewed code that is publicly reachable on workers.dev and has open outbound network
 * access, so mirrored customer data is a leak path. Everything in a mirrored request except the HTTP method and a route
 * template counts as customer data: body, query string, path segments, x-request-id, user-agent, accept-language.
 *
 *   none      (default) method, a route template and `Accept` only. No body, no query, no path ids.
 *   redacted  as `none`, plus the content type and a body whose JSON string and number leaves are replaced by placeholders.
 *   full      the original request (minus credentials, see candidate-headers.ts). Needs the human-set deploy var
 *             GOVERNANCE_EGRESS_CONTROLLED = "true"; without it the router falls back to `none`.
 *
 * The trusted baseline (beehive-main) is production itself and always gets the original request.
 */

export type MirrorBodyMode = 'none' | 'redacted' | 'full';

export interface MirrorModeEnv {
  MIRROR_BODY_MODE?: string;
  GOVERNANCE_EGRESS_CONTROLLED?: string;
}

/** Unknown or missing values fail closed to `none`; `full` also needs the egress deploy var. */
export function resolveMirrorMode(env: MirrorModeEnv): MirrorBodyMode {
  const raw = (env.MIRROR_BODY_MODE ?? 'none').trim().toLowerCase();
  if (raw === 'redacted') return 'redacted';
  if (raw === 'full') {
    if (env.GOVERNANCE_EGRESS_CONTROLLED === 'true') return 'full';
    console.warn('[Shadow] MIRROR_BODY_MODE=full ignored: GOVERNANCE_EGRESS_CONTROLLED is not "true"; mirroring with mode none');
    return 'none';
  }
  if (raw !== 'none') console.warn(`[Shadow] unknown MIRROR_BODY_MODE '${raw}'; mirroring with mode none`);
  return 'none';
}

// A segment survives only if it looks like a fixed word of a route (lowercase letters, digits and dashes, starting with a
// letter, no longer than 32). Ids, emails, tokens, dates and encoded values become ':id'.
const ROUTE_WORD = /^[a-z][a-z0-9_-]{0,31}$/;
const LOOKS_LIKE_ID = /^(?:[a-z]+-)?[0-9a-f]{8,}(?:-[0-9a-f]+)*$/i;

export function routeTemplate(pathname: string): string {
  const segments = pathname.split('/').map((segment) => {
    if (segment === '') return segment;
    return ROUTE_WORD.test(segment) && !LOOKS_LIKE_ID.test(segment) ? segment : ':id';
  });
  return segments.join('/') || '/';
}

/** JSON string and number leaves become typed placeholders; keys, booleans and null stay. */
export function redactJsonValue(value: unknown, depth = 0): unknown {
  if (depth > 20) return '<deep>';
  if (typeof value === 'string') return '<string>';
  if (typeof value === 'number') return 0;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactJsonValue(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 50)) out[k] = redactJsonValue(v, depth + 1);
    return out;
  }
  return value;
}

/** A redacted JSON body, or undefined when the body is not JSON (dropped, never passed through). */
export function redactBody(bodyBytes: ArrayBuffer | undefined, contentType: string | null): ArrayBuffer | undefined {
  if (!bodyBytes || bodyBytes.byteLength === 0) return undefined;
  if (!contentType || !/^application\/(?:[a-z0-9.+-]+\+)?json\b/i.test(contentType)) return undefined;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bodyBytes));
    return new TextEncoder().encode(JSON.stringify(redactJsonValue(parsed))).buffer as ArrayBuffer;
  } catch {
    return undefined;
  }
}

export interface MirrorTarget {
  /** Path and query appended to the candidate's base URL. */
  pathAndQuery: string;
  headers: Headers;
  body: ArrayBuffer | undefined;
}

/** The request a candidate target receives for `mode`. The baseline is handled by the caller (original request). */
export function mirrorRequestFor(
  mode: MirrorBodyMode,
  url: URL,
  source: Headers,
  bodyBytes: ArrayBuffer | undefined,
  requestId: string,
  fullHeaders: Headers
): MirrorTarget {
  if (mode === 'full') {
    return { pathAndQuery: `${url.pathname}${url.search}`, headers: fullHeaders, body: bodyBytes ? bodyBytes.slice(0) : undefined };
  }
  const headers = new Headers();
  const accept = source.get('accept');
  if (accept !== null) headers.set('accept', accept);
  // The router's own id, so candidate logs still correlate with the Scientist queue without echoing the client's header
  headers.set('x-request-id', requestId);
  if (mode === 'redacted') {
    const body = redactBody(bodyBytes, source.get('content-type'));
    if (body) headers.set('content-type', source.get('content-type') as string);
    return { pathAndQuery: routeTemplate(url.pathname), headers, body };
  }
  return { pathAndQuery: routeTemplate(url.pathname), headers, body: undefined };
}
