/**
 * Repo references in UI URLs: parsing of the issue routes and the one place that turns
 * `/app/repos/<ref>` into a repository row.
 *
 * A ref is 1-3 path segments: `<repo uuid>`, `<org>/<repo>` (namespace === org) or
 * `<org>/<namespace>/<repo>`. Reads go through the DoReader (unfiltered lists only, R1) and
 * throw on any DO error, so a failed read is never mistaken for "not found".
 */

import { esc, isValidId, pick } from './ui-html';
import type { DoReader, DoRow } from './ui-pages';

const COMPONENT = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * One validator for every URL component built or accepted by the UI. `.` and `..` match the
 * character class but are dot segments, which URL parsers collapse, so they are refused.
 */
export function validComponent(s: string): boolean {
  return COMPONENT.test(s) && s !== '.' && s !== '..';
}

/**
 * Build a hierarchical repo URL or fall back to the UUID URL.
 * Falls back when: org not found, or any component is not a valid URL component.
 * Every component is `[A-Za-z0-9_.-]`, so the escaped result equals the raw one and is safe in `Location`.
 */
export function buildRepoUrl(repo: DoRow, orgs: DoRow[], repoIdFallback?: string): string {
  const id = repoIdFallback || pick(repo, 'id');
  const uuidUrl = `/app/repos/${esc(encodeURIComponent(id))}`;
  const repoOrg = orgs.find((o) => pick(o, 'id') === pick(repo, 'organization_id', 'organizationId'));
  if (!repoOrg) return uuidUrl;

  const orgName = pick(repoOrg, 'name');
  const namespace = pick(repo, 'namespace') || 'default';
  const repoName = pick(repo, 'name') || id;
  if (!validComponent(orgName) || !validComponent(namespace) || !validComponent(repoName)) return uuidUrl;

  // If namespace equals orgName, use 2-part URL; otherwise use 3-part
  const namespacePart = namespace === orgName ? '' : `/${esc(encodeURIComponent(namespace))}`;
  return `/app/repos/${esc(encodeURIComponent(orgName))}${namespacePart}/${esc(encodeURIComponent(repoName))}`;
}

// ============================================================================
// Issue route parsing (pure)
// ============================================================================

const ISSUE_ACTION = /^\/app\/repos\/([^/]+(?:\/[^/]+){0,2})\/issues\/([^/]+)\/(comments|status)$/;
const REPO_ISSUES = /^\/app\/repos\/([^/]+(?:\/[^/]+){0,2})\/issues(?:\/([^/]+))?$/;

export type RepoIssuesKind = 'list' | 'new' | 'detail' | 'create' | 'comment' | 'status';

export interface RepoIssuesRoute {
  kind: RepoIssuesKind;
  /** Decoded, validated ref segments (1-3). */
  refSegments: string[];
  /** Decoded but not yet validated; only for `detail`, `comment` and `status`. */
  issueId?: string;
}

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

function parseRef(raw: string): string[] | null {
  const segments: string[] = [];
  for (const part of raw.split('/')) {
    const decoded = decode(part);
    if (decoded === null) return null;
    segments.push(decoded);
  }
  // A single segment is a repo id; two or three are org/ns/repo names.
  const ok = segments.length === 1 ? isValidId(segments[0]) : segments.every(validComponent);
  return ok ? segments : null;
}

/**
 * Match a path against the issue routes. Whether the method is allowed for the kind is the
 * caller's decision (405 after the ref resolved); only a POST to the bare list URL is `create`.
 * Returns null when no issue route matches or the ref is malformed.
 */
export function parseRepoIssuesPath(path: string, method: string): RepoIssuesRoute | null {
  const action = path.match(ISSUE_ACTION);
  if (action) {
    const refSegments = parseRef(action[1]);
    const issueId = decode(action[2]);
    if (!refSegments || issueId === null) return null;
    return { kind: action[3] === 'comments' ? 'comment' : 'status', refSegments, issueId };
  }

  const m = path.match(REPO_ISSUES);
  if (!m) return null;
  const refSegments = parseRef(m[1]);
  if (!refSegments) return null;
  if (m[2] === undefined) return { kind: method === 'POST' ? 'create' : 'list', refSegments };
  const second = decode(m[2]);
  if (second === null) return null;
  if (second === 'new') return { kind: 'new', refSegments };
  return { kind: 'detail', refSegments, issueId: second };
}

// ============================================================================
// Resolution
// ============================================================================

export interface RepoRef {
  repo: DoRow;
  org: DoRow | null;
  /** Canonical URL (`/app/repos/...`), already safe for HTML and `Location`. */
  repoUrl: string;
}

/**
 * Resolve ref segments to a repository. Returns null when the repo does not exist; throws on
 * any DO error (the caller answers 502).
 */
export async function resolveRepoRef(reader: DoReader, segments: string[]): Promise<RepoRef | null> {
  if (segments.length === 1) {
    if (!isValidId(segments[0])) return null;
    const repo = await reader.get(`/api/repositories/${encodeURIComponent(segments[0])}`);
    if (!repo) return null;
    const orgId = pick(repo, 'organization_id', 'organizationId');
    const org = orgId && isValidId(orgId) ? await reader.get(`/api/organizations/${encodeURIComponent(orgId)}`) : null;
    return { repo, org, repoUrl: buildRepoUrl(repo, org ? [org] : []) };
  }

  if (segments.length < 1 || segments.length > 3 || !segments.every(validComponent)) return null;
  const orgName = segments[0];
  const namespace = segments.length === 3 ? segments[1] : orgName;
  const repoName = segments[segments.length - 1];

  const [orgs, repos] = await Promise.all([reader.list('/api/organizations'), reader.list('/api/repositories')]);
  const org = orgs.find((o) => pick(o, 'name') === orgName);
  if (!org) return null;
  const repo = repos.find(
    (r) =>
      pick(r, 'organization_id', 'organizationId') === pick(org, 'id') &&
      (pick(r, 'namespace') || 'default') === namespace &&
      pick(r, 'name') === repoName
  );
  if (!repo) return null;
  return { repo, org, repoUrl: buildRepoUrl(repo, orgs) };
}
