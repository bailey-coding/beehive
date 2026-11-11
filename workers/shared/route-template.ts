/**
 * Route templates: a mirrored path keeps only known route words, every other segment becomes ':id'.
 * Shared by the shadow router and the edge mirror source (workers/api/mirror.ts) so both template alike.
 */

// A path segment survives only if it is a known route word. Slugs, usernames, short tokens and ids are customer data, and no
// pattern separates them from route words, so the rule is an allowlist (inverted after review): a small fixed list plus the words
// the deploy configures in MIRROR_ROUTE_WORDS (comma separated, the mirrored service's own route names).
export const ROUTE_WORD = /^[a-z][a-z0-9_-]{0,31}$/;
// The platform's own public pages and API route words are defaults, so the edge (which has no router config) and the router template alike.
export const DEFAULT_ROUTE_WORDS = ['api', 'health', 'healthz', 'v1', 'v2', 'v3', 'static', 'assets', 'about', 'roadmap', 'app'];
export const MAX_TEMPLATE_SEGMENTS = 8;
export const MAX_TEMPLATE_CHARS = 128;

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

