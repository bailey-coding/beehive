/**
 * UI Tests for Beehive M6 Semantic Dashboard
 * 
 * Tests cover:
 * - handleUi authentication and authorization
 * - Detail page routing and rendering
 * - Cross-links between entities
 * - Mock data generation and determinism
 * - XSS protection
 * - Filtered list route rejection (R1, R3)
 * - ID validation (R5)
 * - URL encoding (R5)
 * - Safe URL rendering (R6)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleUi, signSession, type UiEnv } from '../ui';
import type { Session } from '../ui-pages';
import { page, esc, str, table, tableHtml, link, badge, appLink, visibilityBadge, mockedLabel, isValidId, pick } from '../ui-html';
import { 
  semanticSearch, renderSearch, 
  semanticChangelog, renderChangelog, 
  mockCommits, renderCommits, 
  mockFileTree, renderFileTree, 
  type SemanticHit, type ChangelogEntry
} from '../ui-semantic';

// ============================================================================
// Test Environment Setup
// ============================================================================

const TEST_API_AUTH_TOKEN = 'test-auth-token';
const TEST_GITHUB_CLIENT_ID = 'test-github-client-id';
const TEST_GITHUB_CLIENT_SECRET = 'test-github-client-secret';
const TEST_ALLOWED_USERS = 'testuser';

const mockEnv: UiEnv = {
  API_AUTH_TOKEN: TEST_API_AUTH_TOKEN,
  GITHUB_CLIENT_ID: TEST_GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET: TEST_GITHUB_CLIENT_SECRET,
  ALLOWED_GITHUB_USERS: TEST_ALLOWED_USERS,
};

// Mock DurableObjectStub
class MockDurableObjectStub {
  private handlers: Map<string, (req: Request) => Promise<Response>> = new Map();
  
  // Register a handler for a specific path
  on(path: string, handler: (req: Request) => Promise<Response>): void {
    this.handlers.set(path, handler);
  }
  
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname + url.search;
    
    // Check for filtered list calls - MUST FAIL (R3)
    const filteredParams = ['organizationId', 'repositoryId', 'specId', 'candidateId', 'agentId', 'stage', 'status'];
    if (url.search.includes('?')) {
      const params = new URLSearchParams(url.search);
      for (const param of filteredParams) {
        if (params.has(param)) {
          // This should never happen in production code
          throw new Error(`BLOCKED: Filtered list call with param ${param}. Use unfiltered list + UI filtering instead (R1).`);
        }
      }
    }
    
    // Look for exact match
    const handler = this.handlers.get(path);
    if (handler) {
      return handler(req);
    }
    
    // Default: return empty for unknown paths
    return new Response(JSON.stringify({ success: false, error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// Helper to create a mock actor response
function mockActor(actorId: string, login: string): any {
  return {
    success: true,
    data: {
      id: actorId,
      type: 'human',
      name: login,
      github_user_id: '12345',
      trust_score: 0.5,
      promotion_authority: false,
      created_at: Date.now(),
    },
  };
}

// Helper to create test session
async function createTestSession(login: string = 'testuser', actorId: string = 'actor-123'): Promise<string> {
  const session: Session = {
    login,
    actorId,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 12,
  };
  return await signSession(session, TEST_API_AUTH_TOKEN);
}

// Helper to create request with session cookie
function createRequest(path: string, method: string = 'GET', cookie?: string): Request {
  const url = new URL(`http://localhost${path}`);
  const headers: HeadersInit = { 'Content-Type': 'application/json' };
  if (cookie) {
    headers['Cookie'] = `${SESSION_COOKIE}=${cookie}`;
  }
  return new Request(url.toString(), { method, headers });
}

// ============================================================================
// Fixtures
// ============================================================================

// Test fixtures use camelCase for candidates (R3), snake_case for others
const fixtureOrgs = [
  { id: 'org-001', name: 'Test Org 1', type: 'github', created_at: Date.now() - 86400000 },
  { id: 'org-002', name: 'Test Org 2', type: 'artifacts', created_at: Date.now() - 72000000 },
];

const fixtureRepos = [
  { id: 'repo-001', name: 'price-calculator', organization_id: 'org-001', repo_type: 'candidate', spec_id: 'spec-001', remote_url: 'https://github.com/test/price-calc', namespace: 'test', created_at: Date.now() - 64800000 },
  { id: 'repo-002', name: 'url-shortener', organization_id: 'org-001', repo_type: 'candidate', spec_id: 'spec-001', remote_url: 'https://github.com/test/url-short', namespace: 'test', created_at: Date.now() - 57600000 },
  { id: 'repo-003', name: 'baseline-service', organization_id: 'org-002', repo_type: 'baseline', remote_url: 'https://github.com/test/baseline', namespace: 'test', created_at: Date.now() - 43200000 },
];

// Candidates use camelCase (R3)
const fixtureCandidates = [
  { id: 'cand-001', specId: 'spec-001', repositoryId: 'repo-001', commitSha: 'abc123', baseCommitSha: 'def456', agentId: 'agent-001', createdAt: Date.now() - 345600000, stage: 'pending', previewUrl: 'https://preview.test.dev' },
  { id: 'cand-002', specId: 'spec-001', repositoryId: 'repo-002', commitSha: 'ghi789', baseCommitSha: 'jkl012', agentId: 'agent-002', createdAt: Date.now() - 259200000, stage: 'passed_premerge', previewUrl: 'https://preview2.test.dev' },
];

const fixtureSpecs = [
  { id: 'spec-001', name: 'Pricing Service', description: 'Handles price calculations', contract: '{"endpoints":[{"method":"GET","path":"/health"}]}', declared_delta_surface: 'GET /price\nPOST /discount', organization_id: 'org-001', created_by: 'actor-001', created_at: Date.now() - 36000000, stage: 'active' },
  { id: 'spec-002', name: 'URL Shortener', description: 'Shortens URLs', contract: '{"endpoints":[{"method":"POST","path":"/shorten"}]}', declared_delta_surface: 'POST /shorten\nGET /expand', organization_id: 'org-002', created_by: 'actor-001', created_at: Date.now() - 172800000, stage: 'draft' },
];

const fixtureTrials = [
  { id: 'trial-001', candidate_a_id: 'cand-001', candidate_b_id: 'cand-002', winner_candidate_id: 'cand-002', decision: 'cand-002 won on latency', created_at: Date.now() - 86400000, comparison_metrics: '{"p95_latency":-18,"p99_latency":-25}' },
];

const fixturePromotions = [
  { id: 'promo-001', candidate_id: 'cand-002', stage: 'canary', created_at: Date.now() - 43200000 },
];

const fixtureIssues = [
  { id: 'issue-001', title: 'Add discount validation', repository_id: 'repo-001', change_type: 'behavior-change', stage: 'implemented', visibility: 'public', created_at: Date.now() - 86400000 },
  { id: 'issue-002', title: 'Fix null dereference', repository_id: 'repo-001', change_type: 'security-sensitive', stage: 'resolved', visibility: 'internal', created_at: Date.now() - 72000000 },
  { id: 'issue-003', title: 'Private security issue', repository_id: 'repo-001', change_type: 'security-sensitive', stage: 'triage', visibility: 'private', created_at: Date.now() - 57600000 },
];

const fixtureIssueComments = [
  { id: 'comment-001', issue_id: 'issue-001', body: 'This looks good', created_by: 'actor-001', created_at: Date.now() - 86400000 },
  { id: 'comment-002', issue_id: 'issue-001', body: 'Needs more tests', created_by: 'actor-002', created_at: Date.now() - 72000000 },
];

const fixtureActors = [
  { id: 'actor-001', type: 'human', name: 'testuser', github_user_id: '12345', trust_score: 0.5, promotion_authority: false, created_at: Date.now() },
  { id: 'actor-002', type: 'agent', name: 'agent-001', github_user_id: undefined, trust_score: 0.7, promotion_authority: true, created_at: Date.now() },
  { id: 'actor-123', type: 'human', name: 'testuser', github_user_id: '12345', trust_score: 0.5, promotion_authority: false, created_at: Date.now() },
];

// ============================================================================
// Helper to create a mock DO stub with fixtures
// ============================================================================

function createMockStub(): MockDurableObjectStub {
  const stub = new MockDurableObjectStub();
  
  // Register handlers for list endpoints
  stub.on('/api/organizations?limit=500&offset=0', async () => {
    return new Response(JSON.stringify({ success: true, data: fixtureOrgs }), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
  
  stub.on('/api/repositories?limit=500&offset=0', async () => {
    return new Response(JSON.stringify({ success: true, data: fixtureRepos }), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
  
  stub.on('/api/specs?limit=500&offset=0', async () => {
    return new Response(JSON.stringify({ success: true, data: fixtureSpecs }), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
  
  stub.on('/api/candidates?limit=500&offset=0', async () => {
    // Candidates use camelCase (R3)
    return new Response(JSON.stringify({ success: true, data: fixtureCandidates }), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
  
  stub.on('/api/trials?limit=500&offset=0', async () => {
    return new Response(JSON.stringify({ success: true, data: fixtureTrials }), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
  
  stub.on('/api/promotions?limit=500&offset=0', async () => {
    return new Response(JSON.stringify({ success: true, data: fixturePromotions }), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
  
  stub.on('/api/issues?limit=500&offset=0', async () => {
    return new Response(JSON.stringify({ success: true, data: fixtureIssues }), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
  
  // Issue comments - correct route is /api/issues/:id/comments
  stub.on('/api/issues/issue-001/comments', async (req) => {
    if (req.method === 'GET') {
      return new Response(JSON.stringify({ success: true, data: fixtureIssueComments.filter(c => c.issue_id === 'issue-001') }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (req.method === 'POST') {
      const body = await req.json();
      return new Response(JSON.stringify({ success: true, data: { id: 'new-comment', ...body } }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ success: false, error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  
  // Also handle with query params (doReader.list adds these)
  stub.on('/api/issues/issue-001/comments?limit=500&offset=0', async () => {
    return new Response(JSON.stringify({ success: true, data: fixtureIssueComments.filter(c => c.issue_id === 'issue-001') }), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
  
  // Actor lookup (required for auth - R3)
  stub.on('/api/actors?limit=500&offset=0', async () => {
    return new Response(JSON.stringify({ success: true, data: fixtureActors }), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
  
  // Single-record GETs
  for (const org of fixtureOrgs) {
    stub.on(`/api/organizations/${org.id}`, async () => {
      return new Response(JSON.stringify({ success: true, data: org }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
  }
  
  for (const repo of fixtureRepos) {
    stub.on(`/api/repositories/${repo.id}`, async () => {
      return new Response(JSON.stringify({ success: true, data: repo }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
  }
  
  for (const spec of fixtureSpecs) {
    stub.on(`/api/specs/${spec.id}`, async () => {
      return new Response(JSON.stringify({ success: true, data: spec }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
  }
  
  for (const issue of fixtureIssues) {
    stub.on(`/api/issues/${issue.id}`, async () => {
      return new Response(JSON.stringify({ success: true, data: issue }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
  }
  
  for (const candidate of fixtureCandidates) {
    stub.on(`/api/candidates/${candidate.id}`, async () => {
      return new Response(JSON.stringify({ success: true, data: candidate }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
    // Gate verdicts for candidate
    stub.on(`/api/candidates/${candidate.id}/gate-verdicts`, async () => {
      return new Response(JSON.stringify({ success: true, data: [] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
  }
  
  for (const trial of fixtureTrials) {
    stub.on(`/api/trials/${trial.id}`, async () => {
      return new Response(JSON.stringify({ success: true, data: trial }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
  }
  
  return stub;
}

// ============================================================================
// Test Suites
// ============================================================================

// Re-export types for tests
const SESSION_COOKIE = '__Host-beehive_session';

describe('UI HTML Helpers', () => {
  describe('esc()', () => {
    it('escapes HTML special characters', () => {
      expect(esc('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(esc('a & b')).toBe('a &amp; b');
      expect(esc('"quoted"')).toBe('&quot;quoted&quot;');
      expect(esc("it's")).toBe("it&#39;s");
    });
  });

  describe('str()', () => {
    it('converts values to strings', () => {
      expect(str(null)).toBe('');
      expect(str(undefined)).toBe('');
      expect(str(123)).toBe('123');
      expect(str('hello')).toBe('hello');
    });
  });

  describe('isValidId()', () => {
    it('accepts valid IDs', () => {
      expect(isValidId('org-001')).toBe(true);
      expect(isValidId('repo_123')).toBe(true);
      expect(isValidId('spec-abc-def')).toBe(true);
      expect(isValidId('a')).toBe(true);
      expect(isValidId('1234567890123456789012345678901234567890123456789012345')).toBe(true); // 56 chars, valid
      expect(isValidId('a'.repeat(65))).toBe(false); // > 64 chars
    });

    it('rejects invalid IDs', () => {
      expect(isValidId('')).toBe(false);
      expect(isValidId('..')).toBe(false);
      expect(isValidId('a/b')).toBe(false); // path traversal
      expect(isValidId('a?b')).toBe(false);
      expect(isValidId('javascript:alert(1)')).toBe(false);
    });
  });

  describe('pick()', () => {
    it('picks snake_case values', () => {
      const row = { organization_id: 'org-1', name: 'test' };
      expect(pick(row, 'organization_id')).toBe('org-1');
    });

    it('picks camelCase values as fallback', () => {
      const row = { organizationId: 'org-1', name: 'test' };
      expect(pick(row, 'organization_id', 'organizationId')).toBe('org-1');
    });

    it('returns empty string for missing values', () => {
      const row = { name: 'test' };
      expect(pick(row, 'organization_id')).toBe('');
    });
  });

  describe('link()', () => {
    it('renders http URLs as links', () => {
      const html = link('https://example.com', 'Example');
      expect(html).toContain('href="https://example.com"');
      expect(html).toContain('Example');
    });

    it('renders http URLs as links', () => {
      const html = link('http://example.com', 'Example');
      expect(html).toContain('href="http://example.com"');
    });

    it('does not render javascript: URLs as links (R6)', () => {
      const html = link('javascript:alert(1)', 'XSS');
      expect(html).not.toContain('href=');
      expect(html).toContain('javascript:alert(1)'); // Escaped as text
    });

    it('escapes text content', () => {
      const html = link('https://example.com', '<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;');
    });
  });

  describe('appLink()', () => {
    it('creates links to app pages', () => {
      const html = appLink('repos', 'repo-123', 'My Repo');
      expect(html).toContain('href="/app/repos/repo-123"');
      expect(html).toContain('My Repo');
    });

    it('URL-encodes IDs', () => {
      // Valid IDs that need encoding: none exist with current regex (only alphanumeric, -, _)
      // So test that valid IDs are not double-encoded
      const html = appLink('specs', 'spec-123', 'Spec');
      expect(html).toContain('href="/app/specs/spec-123"');
    });

    it('rejects invalid IDs', () => {
      const html = appLink('repos', 'a/b', 'Repo');
      expect(html).not.toContain('href=');
    });
  });

  describe('badge()', () => {
    it('creates badges with escaped text', () => {
      const html = badge('passed', 'Test <passed>');
      expect(html).toContain('&lt;passed&gt;');
      expect(html).toContain('class="badge passed"');
    });
  });

  describe('table()', () => {
    it('escapes cell values', () => {
      const html = table(['Name'], [['<script>alert(1)</script>']]);
      expect(html).toContain('&lt;script&gt;');
    });

    it('renders empty state', () => {
      const html = table(['Name'], []);
      expect(html).toContain('None yet');
    });
  });

  describe('tableHtml()', () => {
    it('does not double-escape pre-escaped content', () => {
      const safeHtml = '<a href="/test">link</a>' as any;
      const html = tableHtml(['Link'], [[safeHtml]]);
      expect(html).toContain('href="/test"');
    });
  });

  describe('page()', () => {
    it('wraps content in HTML page', () => {
      const html = page('Test', '<p>Hello</p>');
      expect(html.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    });

    it('sets status code', () => {
      const html = page('Test', '<p>Hello</p>', 404);
      expect(html.status).toBe(404);
    });
  });
});

describe('Semantic Mock Generators', () => {
  const NOW = 1700000000000; // Fixed timestamp for determinism (R8)

  describe('mockCommits()', () => {
    it('generates deterministic commits for same repo ID', () => {
      const commits1 = mockCommits('repo-001', undefined, NOW);
      const commits2 = mockCommits('repo-001', undefined, NOW);
      expect(commits1).toEqual(commits2);
    });

    it('generates different commits for different repo IDs', () => {
      const commits1 = mockCommits('repo-001', undefined, NOW);
      const commits2 = mockCommits('repo-002', undefined, NOW);
      expect(commits1).not.toEqual(commits2);
    });

    it('uses synthetic agent names, never real user logins (R7)', () => {
      const commits = mockCommits('repo-001', undefined, NOW, 8);
      const authors = commits.map((c) => c.author);
      // All should be agent: prefixes
      authors.forEach((author) => {
        expect(author).toMatch(/^agent:/);
      });
    });

    it('generates non-real SHAs (R7 S6)', () => {
      const commits = mockCommits('repo-001', undefined, NOW, 8);
      commits.forEach((commit) => {
        // Should not look like real 40-hex SHAs
        expect(commit.sha).toMatch(/^sample\·/);
      });
    });

    it('times are anchored to now parameter (R8)', () => {
      const commits1 = mockCommits('repo-001', undefined, NOW, 1);
      const commits2 = mockCommits('repo-001', undefined, NOW + 1000, 1);
      expect(commits1[0].at).not.toBe(commits2[0].at);
    });
  });

  describe('semanticSearch()', () => {
    it('matches real entities by substring', () => {
      const entities = [{ kind: 'spec', id: 'spec-1', name: 'Pricing Service', description: 'Handles price calculations' }];
      const results = semanticSearch('price', entities, 'test-id', NOW);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].mocked).toBe(false);
      expect(results[0].title).toBe('Pricing Service');
    });

    it('includes sample code hits for empty query', () => {
      const entities: any[] = [];
      const results = semanticSearch('', entities, 'test-id', NOW);
      expect(results.length).toBeGreaterThan(0);
      // Should have some mocked hits
      expect(results.some((r) => r.mocked)).toBe(true);
    });

    it('caps results at 8', () => {
      const entities = Array.from({ length: 20 }, (_, i) => ({
        kind: 'spec' as const,
        id: `spec-${i}`,
        name: `Spec ${i}`,
        description: 'test',
      }));
      const results = semanticSearch('test', entities, 'test-id', NOW);
      expect(results.length).toBeLessThanOrEqual(8);
    });

    it('escapes HTML in results', () => {
      const entities = [{ kind: 'spec', id: 'spec-1', name: '<script>alert(1)</script>', description: '' }];
      const results = semanticSearch('script', entities, 'test-id', NOW);
      expect(results[0].title).toBe('<script>alert(1)</script>'); // Not escaped in data
      // But when rendered via renderSearch, it should be escaped
      const html = renderSearch(results);
      expect(html).toContain('&lt;script&gt;');
    });

    it('labels mocked entries', () => {
      const entities: any[] = [];
      const results = semanticSearch('test', entities, 'test-id', NOW);
      // Sample code hits should be mocked
      results.filter((r) => r.mocked).forEach((r) => {
        expect(r.mocked).toBe(true);
      });
    });
  });

  describe('semanticChangelog()', () => {
    it('uses ChangeType vocabulary from cli/src/types/api.ts:269 (R10)', () => {
      const entities = [
        { kind: 'spec', id: 'spec-1', name: 'Test', createdAt: NOW - 1000, changeType: 'behavior-change' as any },
      ];
      const changelog = semanticChangelog(entities, 'test-id', NOW);
      expect(changelog[0].category).toBe('behavior-change');
    });

    it('pads with mocked entries when fewer than 3 real entries', () => {
      const entities: any[] = [];
      const changelog = semanticChangelog(entities, 'test-id', NOW);
      expect(changelog.length).toBe(3);
      expect(changelog.every((e) => e.mocked)).toBe(true);
    });

    it('times are anchored to entity created_at (R8)', () => {
      const createdAt = NOW - 86400000;
      const entities = [{ kind: 'spec', id: 'spec-1', name: 'Test', createdAt, changeType: 'refactor' as any }];
      const changelog = semanticChangelog(entities, 'test-id', NOW);
      expect(changelog[0].at).toBe(createdAt);
    });

    it('labels mocked entries', () => {
      const entities: any[] = [];
      const changelog = semanticChangelog(entities, 'test-id', NOW);
      changelog.forEach((e) => {
        expect(e.mocked).toBe(true);
      });
    });
  });

  describe('mockFileTree()', () => {
    it('generates deterministic trees for same repo ID', () => {
      const tree1 = mockFileTree('repo-001');
      const tree2 = mockFileTree('repo-001');
      expect(tree1).toEqual(tree2);
    });

    it('generates different trees for different repo IDs', () => {
      const tree1 = mockFileTree('repo-001');
      const tree2 = mockFileTree('repo-002');
      expect(tree1).not.toEqual(tree2);
    });
  });
});

describe('handleUi Authentication', () => {
  let mockStub: MockDurableObjectStub;
  let sessionCookie: string;

  beforeEach(async () => {
    mockStub = createMockStub();
    sessionCookie = await createTestSession();
  });

  describe('unauthenticated access', () => {
    it('redirects to /login when no session', async () => {
      const request = createRequest('/app', 'GET');
      const response = await handleUi(request, mockEnv, mockStub as any);
      expect(response?.status).toBe(302);
      expect(response?.headers.get('Location')).toBe('/login');
    });

    it('redirects to /login for detail pages when no session', async () => {
      const request = createRequest('/app/repos/repo-001', 'GET');
      const response = await handleUi(request, mockEnv, mockStub as any);
      expect(response?.status).toBe(302);
      expect(response?.headers.get('Location')).toBe('/login');
    });
  });

  describe('authenticated access', () => {
    let sessionCookie: string;

    beforeEach(async () => {
      sessionCookie = await createTestSession();
    });

    it('renders dashboard for authenticated user', async () => {
      const request = createRequest('/app', 'GET', sessionCookie);
      const response = await handleUi(request, mockEnv, mockStub as any);
      expect(response?.status).toBe(200);
      const body = await response?.text();
      expect(body).toContain('Dashboard');
    });

    it('renders org detail page', async () => {
      const request = createRequest('/app/orgs/org-001', 'GET', sessionCookie);
      const response = await handleUi(request, mockEnv, mockStub as any);
      expect(response?.status).toBe(200);
      const body = await response?.text();
      expect(body).toContain('Test Org 1');
    });

    it('renders repo detail page', async () => {
      const request = createRequest('/app/repos/repo-001', 'GET', sessionCookie);
      const response = await handleUi(request, mockEnv, mockStub as any);
      expect(response?.status).toBe(200);
      const body = await response?.text();
      expect(body).toContain('price-calculator');
    });

    describe('hierarchical repo routes', () => {
      beforeEach(() => {
        const jsonList = (data: unknown) => async () =>
          new Response(JSON.stringify({ success: true, data }), { headers: { 'Content-Type': 'application/json' } });
        const acme = { id: 'org-ns', name: 'acme', type: 'artifacts', created_at: Date.now() };
        const repos = [
          { id: 'repo-same', name: 'widgets', organization_id: 'org-ns', repo_type: 'baseline', namespace: 'acme', created_at: Date.now() },
          { id: 'repo-custom', name: 'gadgets', organization_id: 'org-ns', repo_type: 'baseline', namespace: 'custom', created_at: Date.now() },
        ];
        mockStub.on('/api/organizations?limit=500&offset=0', jsonList([...fixtureOrgs, acme]));
        mockStub.on('/api/repositories?limit=500&offset=0', jsonList([...fixtureRepos, ...repos]));
        mockStub.on(`/api/organizations/${acme.id}`, jsonList(acme));
        for (const r of repos) mockStub.on(`/api/repositories/${r.id}`, jsonList(r));
      });

      it('resolves 2-part /app/repos/{org}/{repo} when namespace equals org name', async () => {
        const request = createRequest('/app/repos/acme/widgets', 'GET', sessionCookie);
        const response = await handleUi(request, mockEnv, mockStub as any);
        expect(response?.status).toBe(200);
        expect(await response?.text()).toContain('widgets');
      });

      it('resolves 3-part /app/repos/{org}/{namespace}/{repo} for custom namespaces', async () => {
        const request = createRequest('/app/repos/acme/custom/gadgets', 'GET', sessionCookie);
        const response = await handleUi(request, mockEnv, mockStub as any);
        expect(response?.status).toBe(200);
        expect(await response?.text()).toContain('gadgets');
      });

      it('returns 404 for 2-part path when repo namespace differs from org name', async () => {
        const request = createRequest('/app/repos/acme/gadgets', 'GET', sessionCookie);
        const response = await handleUi(request, mockEnv, mockStub as any);
        expect(response?.status).toBe(404);
      });
    });

    it('renders spec detail page', async () => {
      const request = createRequest('/app/specs/spec-001', 'GET', sessionCookie);
      const response = await handleUi(request, mockEnv, mockStub as any);
      expect(response?.status).toBe(200);
      const body = await response?.text();
      expect(body).toContain('Pricing Service');
    });

    it('renders candidate detail page', async () => {
      const request = createRequest('/app/candidates/cand-001', 'GET', sessionCookie);
      const response = await handleUi(request, mockEnv, mockStub as any);
      expect(response?.status).toBe(200);
      const body = await response?.text();
      expect(body).toContain('Candidate');
    });

    it('renders trial detail page', async () => {
      const request = createRequest('/app/trials/trial-001', 'GET', sessionCookie);
      const response = await handleUi(request, mockEnv, mockStub as any);
      expect(response?.status).toBe(200);
      const body = await response?.text();
      expect(body).toContain('Trial');
    });

    it('returns 404 for invalid entity type', async () => {
      const request = createRequest('/app/invalid/id-123', 'GET', sessionCookie);
      const response = await handleUi(request, mockEnv, mockStub as any);
      expect(response?.status).toBe(404);
    });

    it('returns 404 for invalid ID format (R5)', async () => {
      const request = createRequest('/app/repos/a%2Fb', 'GET', sessionCookie);
      const response = await handleUi(request, mockEnv, mockStub as any);
      expect(response?.status).toBe(404);
    });

    it('returns 404 for unknown org ID', async () => {
      const request = createRequest('/app/orgs/nonexistent', 'GET', sessionCookie);
      const response = await handleUi(request, mockEnv, mockStub as any);
      expect(response?.status).toBe(404);
      const body = await response?.text();
      expect(body).toContain('not found');
    });

    it('returns 404 for unknown repo ID', async () => {
      const request = createRequest('/app/repos/nonexistent', 'GET', sessionCookie);
      const response = await handleUi(request, mockEnv, mockStub as any);
      expect(response?.status).toBe(404);
    });

    it('returns 404 for unknown spec ID', async () => {
      const request = createRequest('/app/specs/nonexistent', 'GET', sessionCookie);
      const response = await handleUi(request, mockEnv, mockStub as any);
      expect(response?.status).toBe(404);
    });

    it('returns 404 for unknown candidate ID', async () => {
      const request = createRequest('/app/candidates/nonexistent', 'GET', sessionCookie);
      const response = await handleUi(request, mockEnv, mockStub as any);
      expect(response?.status).toBe(404);
    });

    it('returns 404 for unknown trial ID', async () => {
      const request = createRequest('/app/trials/nonexistent', 'GET', sessionCookie);
      const response = await handleUi(request, mockEnv, mockStub as any);
      expect(response?.status).toBe(404);
    });
  });

  describe('cross-origin protection', () => {
    it('blocks POST to /logout without same origin', async () => {
      const request = new Request('http://localhost/app/logout', {
        method: 'POST',
        headers: { Origin: 'http://evil.com', Cookie: `${SESSION_COOKIE}=${sessionCookie}` },
      });
      const response = await handleUi(request, mockEnv, mockStub as any);
      expect(response?.status).toBe(403);
    });

    it('blocks POST to create routes without same origin', async () => {
      const request = new Request('http://localhost/app/organizations', {
        method: 'POST',
        headers: { Origin: 'http://evil.com', Cookie: `${SESSION_COOKIE}=${sessionCookie}` },
      });
      const response = await handleUi(request, mockEnv, mockStub as any);
      expect(response?.status).toBe(403);
    });
  });

  describe('GET-only for detail pages (R9)', () => {
    it('returns 404 for POST to detail page', async () => {
      const sessionCookie = await createTestSession();
      const request = createRequest('/app/repos/repo-001', 'POST', sessionCookie);
      const response = await handleUi(request, mockEnv, mockStub as any);
      expect(response?.status).toBe(404);
    });
  });
});

describe('Cross-links and Navigation', () => {
  let mockStub: MockDurableObjectStub;
  let sessionCookie: string;

  beforeEach(async () => {
    mockStub = createMockStub();
    sessionCookie = await createTestSession();
  });

  it('dashboard links to org detail pages', async () => {
    const request = createRequest('/app', 'GET', sessionCookie);
    const response = await handleUi(request, mockEnv, mockStub as any);
    const body = await response?.text();
    expect(body).toContain('href="/app/orgs/org-001"');
    expect(body).toContain('Test Org 1');
  });

  it('dashboard links to repo detail pages', async () => {
    const request = createRequest('/app', 'GET', sessionCookie);
    const response = await handleUi(request, mockEnv, mockStub as any);
    const body = await response?.text();
    expect(body).toContain('href="/app/repos/repo-001"');
    expect(body).toContain('price-calculator');
  });

  it('dashboard links to spec detail pages', async () => {
    const request = createRequest('/app', 'GET', sessionCookie);
    const response = await handleUi(request, mockEnv, mockStub as any);
    const body = await response?.text();
    expect(body).toContain('href="/app/specs/spec-001"');
    expect(body).toContain('Pricing Service');
  });

  it('org page links to repo detail pages', async () => {
    const request = createRequest('/app/orgs/org-001', 'GET', sessionCookie);
    const response = await handleUi(request, mockEnv, mockStub as any);
    const body = await response?.text();
    expect(body).toContain('href="/app/repos/repo-001"');
    expect(body).toContain('price-calculator');
  });

  it('org page links to spec detail pages', async () => {
    const request = createRequest('/app/orgs/org-001', 'GET', sessionCookie);
    const response = await handleUi(request, mockEnv, mockStub as any);
    const body = await response?.text();
    expect(body).toContain('href="/app/specs/spec-001"');
  });

  it('repo page links to org detail page', async () => {
    const request = createRequest('/app/repos/repo-001', 'GET', sessionCookie);
    const response = await handleUi(request, mockEnv, mockStub as any);
    const body = await response?.text();
    expect(body).toContain('href="/app/orgs/org-001"');
  });

  it('repo page links to spec detail page', async () => {
    const request = createRequest('/app/repos/repo-001', 'GET', sessionCookie);
    const response = await handleUi(request, mockEnv, mockStub as any);
    const body = await response?.text();
    expect(body).toContain('href="/app/specs/spec-001"');
  });

  it('repo page links to candidate detail pages', async () => {
    const request = createRequest('/app/repos/repo-001', 'GET', sessionCookie);
    const response = await handleUi(request, mockEnv, mockStub as any);
    const body = await response?.text();
    // repo-001 has candidate cand-001
    expect(body).toContain('href="/app/candidates/cand-001"');
  });

  it('spec page links to candidate detail pages', async () => {
    const request = createRequest('/app/specs/spec-001', 'GET', sessionCookie);
    const response = await handleUi(request, mockEnv, mockStub as any);
    const body = await response?.text();
    expect(body).toContain('href="/app/candidates/cand-001"');
  });

  it('spec page links to trial detail pages', async () => {
    const request = createRequest('/app/specs/spec-001', 'GET', sessionCookie);
    const response = await handleUi(request, mockEnv, mockStub as any);
    const body = await response?.text();
    expect(body).toContain('href="/app/trials/trial-001"');
  });

  it('candidate page links to spec detail page', async () => {
    const request = createRequest('/app/candidates/cand-001', 'GET', sessionCookie);
    const response = await handleUi(request, mockEnv, mockStub as any);
    const body = await response?.text();
    expect(body).toContain('href="/app/specs/spec-001"');
  });

  it('candidate page links to repo detail page', async () => {
    const request = createRequest('/app/candidates/cand-001', 'GET', sessionCookie);
    const response = await handleUi(request, mockEnv, mockStub as any);
    const body = await response?.text();
    expect(body).toContain('href="/app/repos/repo-001"');
  });

  it('candidate page has promotion anchors', async () => {
    // cand-002 has a promotion (promo-001)
    const request = createRequest('/app/candidates/cand-002', 'GET', sessionCookie);
    const response = await handleUi(request, mockEnv, mockStub as any);
    const body = await response?.text();
    expect(body).toContain('id="promotion-promo-001"');
  });

  it('trial page links to candidate detail pages', async () => {
    const request = createRequest('/app/trials/trial-001', 'GET', sessionCookie);
    const response = await handleUi(request, mockEnv, mockStub as any);
    const body = await response?.text();
    expect(body).toContain('href="/app/candidates/cand-001"');
    expect(body).toContain('href="/app/candidates/cand-002"');
  });
});

describe('Mocked Data Labeling', () => {
  let mockStub: MockDurableObjectStub;
  let sessionCookie: string;

  beforeEach(async () => {
    mockStub = createMockStub();
    sessionCookie = await createTestSession();
  });

  it('search section has Mocked label', async () => {
    const request = createRequest('/app/repos/repo-001?q=price', 'GET', sessionCookie);
    const response = await handleUi(request, mockEnv, mockStub as any);
    const body = await response?.text();
    expect(body).toContain('Mocked');
  });

  it('changelog section has Mocked label', async () => {
    const request = createRequest('/app/repos/repo-001', 'GET', sessionCookie);
    const response = await handleUi(request, mockEnv, mockStub as any);
    const body = await response?.text();
    expect(body).toContain('Mocked');
    expect(body).toContain('Semantic summary');
  });

  it('commits section has Mocked label', async () => {
    const request = createRequest('/app/repos/repo-001?tab=commits', 'GET', sessionCookie);
    const response = await handleUi(request, mockEnv, mockStub as any);
    const body = await response?.text();
    expect(body).toContain('Mocked');
    expect(body).toContain('Commits');
  });

  it('file tree section has Mocked label', async () => {
    const request = createRequest('/app/repos/repo-001?tab=files', 'GET', sessionCookie);
    const response = await handleUi(request, mockEnv, mockStub as any);
    const body = await response?.text();
    expect(body).toContain('Mocked');
    expect(body).toContain('File tree');
  });
});

describe('XSS Protection (R6)', () => {
  let mockStub: MockDurableObjectStub;
  let sessionCookie: string;

  beforeEach(async () => {
    mockStub = createMockStub();
    sessionCookie = await createTestSession();
  });

  it('escapes spec name with HTML in dashboard', async () => {
    // Create a mock spec with HTML in name
    const maliciousStub = createMockStub();
    maliciousStub.on('/api/specs?limit=500&offset=0', async () => {
      return new Response(JSON.stringify({
        success: true,
        data: [{ id: 'spec-xss', name: '<script>alert(1)</script>', organization_id: 'org-001' }]
      }), { headers: { 'Content-Type': 'application/json' } });
    });
    
    const request = createRequest('/app', 'GET', sessionCookie);
    const response = await handleUi(request, mockEnv, maliciousStub as any);
    const body = await response?.text();
    expect(body).not.toContain('<script>');
    expect(body).toContain('&lt;script&gt;');
  });

  it('escapes spec name with HTML in spec detail page', async () => {
    const maliciousStub = createMockStub();
    maliciousStub.on('/api/specs/spec-xss', async () => {
      return new Response(JSON.stringify({
        success: true,
        data: { id: 'spec-xss', name: '<img onerror=alert(1)>', description: 'test', contract: '{}', organization_id: 'org-001' }
      }), { headers: { 'Content-Type': 'application/json' } });
    });
    
    const request = createRequest('/app/specs/spec-xss', 'GET', sessionCookie);
    const response = await handleUi(request, mockEnv, maliciousStub as any);
    const body = await response?.text();
    // The name is escaped text, so "onerror=" may appear; no raw <img> element may.
    expect(body).not.toContain('<img');
    expect(body).toContain('&lt;img');
  });

  it('escapes search query with HTML', async () => {
    const request = createRequest('/app/repos/repo-001?q=<script>alert(1)</script>', 'GET', sessionCookie);
    const response = await handleUi(request, mockEnv, mockStub as any);
    const body = await response?.text();
    expect(body).not.toContain('<script>');
    expect(body).toContain('&lt;script&gt;');
  });

  it('escapes contract JSON in spec page', async () => {
    // Contract is stored as stringified JSON, but could be malicious
    const maliciousStub = createMockStub();
    maliciousStub.on('/api/specs/spec-xss', async () => {
      return new Response(JSON.stringify({
        success: true,
        data: { 
          id: 'spec-xss', 
          name: 'Test', 
          contract: '{"malicious": "<script>alert(1)</script>"}',
          organization_id: 'org-001'
        }
      }), { headers: { 'Content-Type': 'application/json' } });
    });
    
    const request = createRequest('/app/specs/spec-xss', 'GET', sessionCookie);
    const response = await handleUi(request, mockEnv, maliciousStub as any);
    const body = await response?.text();
    expect(body).toContain('&lt;script&gt;');
  });

  it('does not render javascript: URLs as links', async () => {
    const maliciousStub = createMockStub();
    maliciousStub.on('/api/repos?limit=500&offset=0', async () => {
      return new Response(JSON.stringify({
        success: true,
        data: [{ id: 'repo-xss', name: 'XSS Repo', remote_url: 'javascript:alert(1)', organization_id: 'org-001' }]
      }), { headers: { 'Content-Type': 'application/json' } });
    });
    // repoPage reads /api/repositories/:id
    maliciousStub.on('/api/repositories/repo-xss', async () => {
      return new Response(JSON.stringify({
        success: true,
        data: { id: 'repo-xss', name: 'XSS Repo', remote_url: 'javascript:alert(1)', organization_id: 'org-001' }
      }), { headers: { 'Content-Type': 'application/json' } });
    });
    
    const request = createRequest('/app/repos/repo-xss', 'GET', sessionCookie);
    const response = await handleUi(request, mockEnv, maliciousStub as any);
    const body = await response?.text();
    // Should not have a clickable javascript: link
    expect(body).not.toContain('href="javascript:');
    // Should show the URL as escaped text
    expect(body).toContain('javascript:alert(1)');
  });

  it('does not render javascript: URLs in previewUrl', async () => {
    const maliciousStub = createMockStub();
    // candidates use camelCase
    maliciousStub.on('/api/candidates?limit=500&offset=0', async () => {
      return new Response(JSON.stringify({
        success: true,
        data: [{ id: 'cand-xss', specId: 'spec-001', repositoryId: 'repo-001', previewUrl: 'javascript:alert(1)' }]
      }), { headers: { 'Content-Type': 'application/json' } });
    });
    maliciousStub.on('/api/candidates/cand-xss', async () => {
      return new Response(JSON.stringify({
        success: true,
        data: { id: 'cand-xss', specId: 'spec-001', repositoryId: 'repo-001', previewUrl: 'javascript:alert(1)' }
      }), { headers: { 'Content-Type': 'application/json' } });
    });
    
    const request = createRequest('/app/candidates/cand-xss', 'GET', sessionCookie);
    const response = await handleUi(request, mockEnv, maliciousStub as any);
    const body = await response?.text();
    expect(body).not.toContain('href="javascript:');
  });
});

describe('Repo Page Tabs', () => {
  let mockStub: MockDurableObjectStub;
  let sessionCookie: string;

  beforeEach(async () => {
    mockStub = createMockStub();
    sessionCookie = await createTestSession();
  });

  it('renders overview tab by default', async () => {
    const request = createRequest('/app/repos/repo-001', 'GET', sessionCookie);
    const response = await handleUi(request, mockEnv, mockStub as any);
    const body = await response?.text();
    expect(body).toContain('class="tab active"');
    expect(body).toContain('overview');
  });

  it('renders issues tab', async () => {
    const request = createRequest('/app/repos/repo-001?tab=issues', 'GET', sessionCookie);
    const response = await handleUi(request, mockEnv, mockStub as any);
    const body = await response?.text();
    expect(body).toContain('href="/app/repos/repo-001?tab=issues"');
    expect(body).toContain('class="tab active"');
  });

  it('renders specs tab', async () => {
    const request = createRequest('/app/repos/repo-001?tab=specs', 'GET', sessionCookie);
    const response = await handleUi(request, mockEnv, mockStub as any);
    const body = await response?.text();
    expect(body).toContain('href="/app/repos/repo-001?tab=specs"');
  });

  it('renders commits tab', async () => {
    const request = createRequest('/app/repos/repo-001?tab=commits', 'GET', sessionCookie);
    const response = await handleUi(request, mockEnv, mockStub as any);
    const body = await response?.text();
    expect(body).toContain('Mocked');
    expect(body).toContain('Commits');
  });

  it('renders files tab', async () => {
    const request = createRequest('/app/repos/repo-001?tab=files', 'GET', sessionCookie);
    const response = await handleUi(request, mockEnv, mockStub as any);
    const body = await response?.text();
    expect(body).toContain('Mocked');
    expect(body).toContain('File tree');
  });

  it('falls back to overview for invalid tab', async () => {
    const request = createRequest('/app/repos/repo-001?tab=invalid', 'GET', sessionCookie);
    const response = await handleUi(request, mockEnv, mockStub as any);
    const body = await response?.text();
    // tab labels are rendered lowercase; the active tab carries the `active` class
    expect(body).toContain('class="tab active">overview<');
  });
});

describe('Private Issues Filtering (R9)', () => {
  let mockStub: MockDurableObjectStub;
  let sessionCookie: string;

  beforeEach(async () => {
    mockStub = createMockStub();
    sessionCookie = await createTestSession();
  });

  it('hides private issues from repo issues tab', async () => {
    const request = createRequest('/app/repos/repo-001?tab=issues', 'GET', sessionCookie);
    const response = await handleUi(request, mockEnv, mockStub as any);
    const body = await response?.text();
    // repo-001 has issues: issue-001 (public), issue-002 (internal), issue-003 (private)
    expect(body).toContain('issue-001');
    expect(body).toContain('issue-002');
    expect(body).not.toContain('issue-003');
  });

  it('hides private issues from spec page', async () => {
    const request = createRequest('/app/specs/spec-001', 'GET', sessionCookie);
    const response = await handleUi(request, mockEnv, mockStub as any);
    const body = await response?.text();
    // spec-001 -> repo-001 -> issues-001, 002, 003
    expect(body).toContain('issue-001');
    expect(body).toContain('issue-002');
    expect(body).not.toContain('issue-003');
  });

  it('shows visibility badges on issues', async () => {
    const request = createRequest('/app/repos/repo-001?tab=issues', 'GET', sessionCookie);
    const response = await handleUi(request, mockEnv, mockStub as any);
    const body = await response?.text();
    expect(body).toContain('badge public');
    expect(body).toContain('badge internal');
  });
});

describe('DoReader Filtered List Rejection (R1, R3)', () => {
  let mockStub: MockDurableObjectStub;

  beforeEach(() => {
    mockStub = new MockDurableObjectStub();
    // Don't register any handlers - should fail on filtered calls
  });

  it('throws error on filtered list call with organizationId', async () => {
    mockStub.on('/api/specs?organizationId=org-001&limit=100&offset=0', async () => {
      throw new Error('Should not be called');
    });
    
    // Try to make a request that would use a filtered list
    // The DoReader in ui.ts should NOT do this
    // MockDurableObjectStub.fetch is async, so the block surfaces as a rejection
    const req = new Request('http://localhost/api/specs?organizationId=org-001&limit=100&offset=0');
    await expect(mockStub.fetch(req)).rejects.toThrow(/BLOCKED/);
  });
});

describe('Regression Tests', () => {
  let mockStub: MockDurableObjectStub;
  let sessionCookie: string;

  beforeEach(async () => {
    mockStub = createMockStub();
    // The create forms POST to these DO routes; the mock has no default POST handlers
    for (const path of ['/api/organizations', '/api/repositories', '/api/specs']) {
      mockStub.on(path, async () =>
        new Response(JSON.stringify({ success: true, data: { id: 'new-1' } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    }
    sessionCookie = await createTestSession();
  });

  it('POST /app/organizations still works', async () => {
    const formData = new FormData();
    formData.append('name', 'New Org');
    formData.append('type', 'github');
    
    const request = new Request('http://localhost/app/organizations', {
      method: 'POST',
      headers: { 
        'Cookie': `${SESSION_COOKIE}=${sessionCookie}`,
        'Origin': 'http://localhost',
      },
      body: formData,
    });
    
    const response = await handleUi(request, mockEnv, mockStub as any);
    expect(response?.status).toBe(302);
    expect(response?.headers.get('Location')).toContain('/app?ok=');
  });

  it('POST /app/repositories still works', async () => {
    const formData = new FormData();
    formData.append('name', 'New Repo');
    formData.append('organizationId', 'org-001');
    formData.append('repoType', 'candidate');
    formData.append('remoteUrl', 'https://github.com/test/new');
    formData.append('namespace', 'test');
    
    const request = new Request('http://localhost/app/repositories', {
      method: 'POST',
      headers: { 
        'Cookie': `${SESSION_COOKIE}=${sessionCookie}`,
        'Origin': 'http://localhost',
      },
      body: formData,
    });
    
    const response = await handleUi(request, mockEnv, mockStub as any);
    expect(response?.status).toBe(302);
    expect(response?.headers.get('Location')).toContain('/app?ok=');
  });

  it('POST /app/specs still works', async () => {
    const formData = new FormData();
    formData.append('name', 'New Spec');
    formData.append('organizationId', 'org-001');
    formData.append('contract', '{"test":true}');
    
    const request = new Request('http://localhost/app/specs', {
      method: 'POST',
      headers: { 
        'Cookie': `${SESSION_COOKIE}=${sessionCookie}`,
        'Origin': 'http://localhost',
      },
      body: formData,
    });
    
    const response = await handleUi(request, mockEnv, mockStub as any);
    expect(response?.status).toBe(302);
    expect(response?.headers.get('Location')).toContain('/app?ok=');
  });

  it('POST with cross-origin Origin returns 403', async () => {
    const formData = new FormData();
    formData.append('name', 'New Org');
    formData.append('type', 'github');
    
    const request = new Request('http://localhost/app/organizations', {
      method: 'POST',
      headers: { 
        'Cookie': `${SESSION_COOKIE}=${sessionCookie}`,
        'Origin': 'http://evil.com',
        'Content-Type': 'multipart/form-data',
      },
      body: formData,
    });
    
    const response = await handleUi(request, mockEnv, mockStub as any);
    expect(response?.status).toBe(403);
  });

  it('GET /login redirects to GitHub', async () => {
    const request = createRequest('/login', 'GET');
    const response = await handleUi(request, mockEnv, mockStub as any);
    expect(response?.status).toBe(302);
    expect(response?.headers.get('Location')).toContain('github.com/login/oauth/authorize');
  });

  describe('Issue Comments Route Bug (Task 1)', () => {
    it('FAILS: POST /app/issue_comments calls /api/issue_comments instead of /api/issues/:id/comments', async () => {
      // This test verifies the bug exists: UI calls /api/issue_comments which doesn't exist
      // After fix, it should call /api/issues/issue-001/comments
      const formData = new FormData();
      formData.append('issueId', 'issue-001');
      formData.append('body', 'Test comment');

      const request = new Request('http://localhost/app/issue_comments', {
        method: 'POST',
        headers: { 
          'Cookie': `${SESSION_COOKIE}=${sessionCookie}`,
          'Origin': 'http://localhost',
        },
        body: formData,
      });

      const response = await handleUi(request, mockEnv, mockStub as any);
      // Currently this fails because /api/issue_comments doesn't exist
      // After fix, it should succeed
      expect(response?.status).toBe(302);
      expect(response?.headers.get('Location')).toContain('/app?ok=');
    });

    it('FAILS: GET /app/issues/:id shows empty comments because list uses /api/issue_comments', async () => {
      // This test verifies the bug exists: UI calls /api/issue_comments for list which doesn't exist
      // After fix, it should call /api/issues/issue-001/comments
      const request = new Request('http://localhost/app/issues/issue-001', {
        method: 'GET',
        headers: { 
          'Cookie': `${SESSION_COOKIE}=${sessionCookie}`,
        },
      });

      const response = await handleUi(request, mockEnv, mockStub as any);
      // Currently this returns empty comments because /api/issue_comments doesn't exist
      // After fix, it should show the actual comments
      expect(response?.status).toBe(200);
      const body = await response?.text();
      // Should show the comments, not "No comments yet"
      expect(body).toContain('This looks good');
    });
  });

  describe('DoReader Error Surfacing Bug (Task 2)', () => {
    it('FAILS: doReader.list returns empty array for 404 instead of surfacing error', async () => {
      // Create a stub that returns 404 for specs list
      const errorStub = new MockDurableObjectStub();
      errorStub.on('/api/actors?limit=500&offset=0', async () => {
        return new Response(JSON.stringify({ success: true, data: fixtureActors }), {
          headers: { 'Content-Type': 'application/json' },
        });
      });
      // Return 404 for repos list to trigger error
      errorStub.on('/api/repositories?limit=500&offset=0', async () => {
        return new Response(JSON.stringify({ success: false, error: 'Not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const sessionCookie = await createTestSession();
      const request = new Request('http://localhost/app', {
        method: 'GET',
        headers: { 
          'Cookie': `${SESSION_COOKIE}=${sessionCookie}`,
        },
      });

      const response = await handleUi(request, mockEnv, errorStub as any);
      // Currently returns 200 with empty list, but should surface error
      expect(response?.status).toBe(200);
      const body = await response?.text();
      // Should show error message, not empty list
      expect(body).toContain('could not load');
    });

    it('FAILS: doReader.get returns null for 404 instead of surfacing error', async () => {
      // Create a stub that returns 404 for a specific spec
      const errorStub = new MockDurableObjectStub();
      errorStub.on('/api/actors?limit=500&offset=0', async () => {
        return new Response(JSON.stringify({ success: true, data: fixtureActors }), {
          headers: { 'Content-Type': 'application/json' },
        });
      });
      errorStub.on('/api/specs?limit=500&offset=0', async () => {
        return new Response(JSON.stringify({ success: true, data: fixtureSpecs }), {
          headers: { 'Content-Type': 'application/json' },
        });
      });
      errorStub.on('/api/specs/nonexistent', async () => {
        return new Response(JSON.stringify({ success: false, error: 'Not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const sessionCookie = await createTestSession();
      const request = new Request('http://localhost/app/specs/nonexistent', {
        method: 'GET',
        headers: { 
          'Cookie': `${SESSION_COOKIE}=${sessionCookie}`,
        },
      });

      const response = await handleUi(request, mockEnv, errorStub as any);
      // Currently returns 200 with "Not found" page, but should surface error
      expect(response?.status).toBe(200);
      const body = await response?.text();
      // Should show error message, not "Not found" from the page function
      expect(body).toContain('could not load');
    });
  });
});
