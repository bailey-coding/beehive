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

// A path segment survives only if it is a known route word. Slugs, usernames, short tokens and ids are customer data, and no
// pattern separates them from route words, so the rule is an allowlist (inverted after review): a small fixed list plus the words
// the deploy configures in MIRROR_ROUTE_WORDS (comma separated, the mirrored service's own route names).
const ROUTE_WORD = /^[a-z][a-z0-9_-]{0,31}$/;
const DEFAULT_ROUTE_WORDS = ['api', 'health', 'healthz', 'v1', 'v2', 'v3', 'static', 'assets'];
const MAX_TEMPLATE_SEGMENTS = 8;
const MAX_TEMPLATE_CHARS = 128;

export function routeWords(env: { MIRROR_ROUTE_WORDS?: string }): ReadonlySet<string> {
  const words = new Set(DEFAULT_ROUTE_WORDS);
  for (const raw of (env.MIRROR_ROUTE_WORDS ?? '').split(',')) {
    const word = raw.trim().toLowerCase();
    if (ROUTE_WORD.test(word)) words.add(word);
  }
  return words;
}

/**
 * The path with every segment that is not a known route word replaced by ':id'. Bounded in segment count and length (a path of
 * many segments is a covert channel), with empty segments collapsed. Always starts with '/'.
 */
export function routeTemplate(pathname: string, words: ReadonlySet<string> = new Set(DEFAULT_ROUTE_WORDS)): string {
  const kept = pathname.split('/').filter((segment) => segment !== '').slice(0, MAX_TEMPLATE_SEGMENTS);
  const template = '/' + kept.map((segment) => (words.has(segment) ? segment : ':id')).join('/');
  return template.slice(0, MAX_TEMPLATE_CHARS);
}

const MAX_REDACTED_NODES = 2000;

/**
 * JSON string and number leaves become typed placeholders, and object keys become positional names (`k0`, `k1`, ...): a key can be
 * data (`{"alice@x.com": 1}`). Booleans, null and the shape of arrays and objects still show, so `redacted` leaks structure and is
 * never for untrusted-origin candidates. Returns undefined when the value has more than MAX_REDACTED_NODES nodes.
 */
export function redactJsonValue(value: unknown, depth = 0, budget = { nodes: 0 }): unknown {
  if (++budget.nodes > MAX_REDACTED_NODES) return undefined;
  if (depth > 20) return '<deep>';
  if (typeof value === 'string') return '<string>';
  if (typeof value === 'number') return 0;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactJsonValue(v, depth + 1, budget));
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 50);
    return Object.fromEntries(entries.map(([, v], i) => [`k${i}`, redactJsonValue(v, depth + 1, budget)]));
  }
  return value;
}

/** A redacted JSON body, or undefined when the body is not JSON (dropped, never passed through). */
export function redactBody(bodyBytes: ArrayBuffer | undefined, contentType: string | null): ArrayBuffer | undefined {
  if (!bodyBytes || bodyBytes.byteLength === 0) return undefined;
  if (!contentType || !/^application\/(?:[a-z0-9.+-]+\+)?json\s*(?:;|$)/i.test(contentType)) return undefined;
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bodyBytes));
    const budget = { nodes: 0 };
    const redacted = redactJsonValue(parsed, 0, budget);
    if (budget.nodes > MAX_REDACTED_NODES) return undefined;
    return new TextEncoder().encode(JSON.stringify(redacted)).buffer as ArrayBuffer;
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
  fullHeaders: Headers,
  words: ReadonlySet<string> = new Set(DEFAULT_ROUTE_WORDS)
): MirrorTarget {
  if (mode === 'full') {
    return { pathAndQuery: `${url.pathname}${url.search}`, headers: fullHeaders, body: bodyBytes ? bodyBytes.slice(0) : undefined };
  }
  const headers = new Headers();
  const accept = source.get('accept');
  if (accept !== null) headers.set('accept', accept);
  // The router's own id for this fan-out, never the client's header (it is not the Scientist queue's id)
  headers.set('x-request-id', requestId);
  if (mode === 'redacted') {
    const body = redactBody(bodyBytes, source.get('content-type'));
    // A constant: the source value can carry parameters or duplicated headers with data in them
    if (body) headers.set('content-type', 'application/json');
    return { pathAndQuery: routeTemplate(url.pathname, words), headers, body };
  }
  return { pathAndQuery: routeTemplate(url.pathname, words), headers, body: undefined };
}
