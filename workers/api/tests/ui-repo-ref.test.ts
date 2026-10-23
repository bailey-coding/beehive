/**
 * ui-repo-ref: issue route parsing, the shared component validator and ref resolution.
 */

import { describe, it, expect } from 'vitest';
import { parseRepoIssuesPath, resolveRepoRef, validComponent, buildRepoUrl } from '../ui-repo-ref';
import type { DoReader, DoRow } from '../ui-pages';

const orgs: DoRow[] = [
  { id: 'org-1', name: 'acme' },
  { id: 'org-2', name: 'weird' },
];
const repos: DoRow[] = [
  { id: 'repo-1', name: 'widgets', organization_id: 'org-1', namespace: 'acme' },
  { id: 'repo-2', name: 'shop', organization_id: 'org-1', namespace: 'ns' },
  { id: 'repo-3', name: 'issues', organization_id: 'org-1', namespace: 'ns' },
  { id: 'repo-4', name: 'new', organization_id: 'org-1', namespace: 'acme' },
  { id: 'repo-5', name: '..', organization_id: 'org-1', namespace: 'acme' },
  { id: 'repo-6', name: 'bare', organization_id: 'org-1' },
];

function reader(overrides: Partial<DoReader> = {}): DoReader {
  return {
    get: async (path) => {
      const [, , kind, id] = path.split('/');
      const rows = kind === 'repositories' ? repos : orgs;
      return rows.find((r) => r.id === id) ?? null;
    },
    list: async (path) => (path === '/api/organizations' ? orgs : repos),
    ...overrides,
  };
}

describe('validComponent', () => {
  it('accepts names and refuses dot segments, empties and long values', () => {
    expect(validComponent('acme')).toBe(true);
    expect(validComponent('a.b-c_d')).toBe(true);
    expect(validComponent('.')).toBe(false);
    expect(validComponent('..')).toBe(false);
    expect(validComponent('')).toBe(false);
    expect(validComponent('a'.repeat(65))).toBe(false);
    expect(validComponent('a b')).toBe(false);
  });
});

describe('parseRepoIssuesPath', () => {
  it('parses every route shape for 3-part, 2-part and UUID refs', () => {
    const refs: Array<[string, string[]]> = [
      ['acme/ns/shop', ['acme', 'ns', 'shop']],
      ['acme/widgets', ['acme', 'widgets']],
      ['repo-1', ['repo-1']],
    ];
    for (const [ref, segments] of refs) {
      const base = `/app/repos/${ref}/issues`;
      expect(parseRepoIssuesPath(base, 'GET')).toEqual({ kind: 'list', refSegments: segments });
      expect(parseRepoIssuesPath(base, 'POST')).toEqual({ kind: 'create', refSegments: segments });
      expect(parseRepoIssuesPath(`${base}/new`, 'GET')).toEqual({ kind: 'new', refSegments: segments });
      expect(parseRepoIssuesPath(`${base}/abc123`, 'GET')).toEqual({ kind: 'detail', refSegments: segments, issueId: 'abc123' });
      expect(parseRepoIssuesPath(`${base}/abc123/comments`, 'POST')).toEqual({ kind: 'comment', refSegments: segments, issueId: 'abc123' });
      expect(parseRepoIssuesPath(`${base}/abc123/status`, 'POST')).toEqual({ kind: 'status', refSegments: segments, issueId: 'abc123' });
    }
  });

  it('backtracks: acme/widgets/issues is ref acme/widgets', () => {
    expect(parseRepoIssuesPath('/app/repos/acme/widgets/issues', 'GET')?.refSegments).toEqual(['acme', 'widgets']);
  });

  it('reads acme/ns/issues as the issues of acme/ns first (fall-through is the caller\'s job)', () => {
    expect(parseRepoIssuesPath('/app/repos/acme/ns/issues', 'GET')).toEqual({ kind: 'list', refSegments: ['acme', 'ns'] });
  });

  it('reads acme/issues/new as the new-issue form of ref acme', () => {
    expect(parseRepoIssuesPath('/app/repos/acme/issues/new', 'GET')).toEqual({ kind: 'new', refSegments: ['acme'] });
  });

  it('rejects dot segments, encoded dot segments, bad escapes, 4+ segments and trailing slash', () => {
    expect(parseRepoIssuesPath('/app/repos/acme/../issues', 'GET')).toBeNull();
    expect(parseRepoIssuesPath('/app/repos/acme/./issues', 'GET')).toBeNull();
    expect(parseRepoIssuesPath('/app/repos/acme/%2e/issues', 'GET')).toBeNull();
    expect(parseRepoIssuesPath('/app/repos/acme/%2E%2E/issues', 'GET')).toBeNull();
    expect(parseRepoIssuesPath('/app/repos/acme/%E0%A4%A/issues', 'GET')).toBeNull();
    expect(parseRepoIssuesPath('/app/repos/a/b/c/d/issues', 'GET')).toBeNull();
    expect(parseRepoIssuesPath('/app/repos/acme/widgets/issues/', 'GET')).toBeNull();
    expect(parseRepoIssuesPath('/app/repos/acme/widgets', 'GET')).toBeNull();
    expect(parseRepoIssuesPath('/app/repos/bad%20name/x/issues', 'GET')).toBeNull();
  });

  it('decodes percent-escaped refs and issue ids', () => {
    expect(parseRepoIssuesPath('/app/repos/ac%6De/widgets/issues/i%2Dd', 'GET')).toEqual({
      kind: 'detail',
      refSegments: ['acme', 'widgets'],
      issueId: 'i-d',
    });
  });

  it('leaves a malformed issue id to the caller but rejects an undecodable one', () => {
    expect(parseRepoIssuesPath('/app/repos/acme/widgets/issues/a%2Fb', 'GET')?.issueId).toBe('a/b');
    expect(parseRepoIssuesPath('/app/repos/acme/widgets/issues/%E0%A4%A', 'GET')).toBeNull();
  });
});

describe('resolveRepoRef', () => {
  it('resolves the 3-part form', async () => {
    const r = await resolveRepoRef(reader(), ['acme', 'ns', 'shop']);
    expect(r?.repo.id).toBe('repo-2');
    expect(r?.repoUrl).toBe('/app/repos/acme/ns/shop');
  });

  it('resolves the 2-part form (namespace === org)', async () => {
    const r = await resolveRepoRef(reader(), ['acme', 'widgets']);
    expect(r?.repo.id).toBe('repo-1');
    expect(r?.repoUrl).toBe('/app/repos/acme/widgets');
  });

  it('resolves the UUID form to the canonical URL', async () => {
    const r = await resolveRepoRef(reader(), ['repo-2']);
    expect(r?.repo.id).toBe('repo-2');
    expect(r?.repoUrl).toBe('/app/repos/acme/ns/shop');
  });

  it('resolves repos named issues and new', async () => {
    expect((await resolveRepoRef(reader(), ['acme', 'ns', 'issues']))?.repo.id).toBe('repo-3');
    expect((await resolveRepoRef(reader(), ['acme', 'new']))?.repo.id).toBe('repo-4');
  });

  it('defaults a missing namespace to "default"', async () => {
    expect((await resolveRepoRef(reader(), ['acme', 'default', 'bare']))?.repo.id).toBe('repo-6');
    expect(await resolveRepoRef(reader(), ['acme', 'bare'])).toBeNull();
  });

  it('returns null for unknown org, repo, namespace and id', async () => {
    expect(await resolveRepoRef(reader(), ['nope', 'widgets'])).toBeNull();
    expect(await resolveRepoRef(reader(), ['acme', 'nope'])).toBeNull();
    expect(await resolveRepoRef(reader(), ['acme', 'other', 'shop'])).toBeNull();
    expect(await resolveRepoRef(reader(), ['repo-999'])).toBeNull();
    expect(await resolveRepoRef(reader(), [])).toBeNull();
  });

  it('gives a repo named ".." the UUID URL, and refuses ".." as a segment', async () => {
    const r = await resolveRepoRef(reader(), ['repo-5']);
    expect(r?.repoUrl).toBe('/app/repos/repo-5');
    expect(await resolveRepoRef(reader(), ['acme', '..'])).toBeNull();
  });

  it('throws on a DO error instead of reporting "not found"', async () => {
    const failing = reader({ list: async () => { throw new Error('Spec DO error: boom'); } });
    await expect(resolveRepoRef(failing, ['acme', 'widgets'])).rejects.toThrow('boom');
    const failingGet = reader({ get: async () => { throw new Error('Spec DO error: boom'); } });
    await expect(resolveRepoRef(failingGet, ['repo-1'])).rejects.toThrow('boom');
  });
});

describe('buildRepoUrl', () => {
  it('uses 2-part for namespace === org, 3-part otherwise, UUID when the org is missing or a name is unsafe', () => {
    expect(buildRepoUrl(repos[0], orgs)).toBe('/app/repos/acme/widgets');
    expect(buildRepoUrl(repos[1], orgs)).toBe('/app/repos/acme/ns/shop');
    expect(buildRepoUrl(repos[0], [])).toBe('/app/repos/repo-1');
    expect(buildRepoUrl(repos[4], orgs)).toBe('/app/repos/repo-5');
    expect(buildRepoUrl({ id: 'r', name: 'x y', organization_id: 'org-1' }, orgs)).toBe('/app/repos/r');
  });
});
