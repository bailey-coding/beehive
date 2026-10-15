/**
 * Semantic mock data generators for Beehive UI.
 * 
 * All generators are deterministic: given the same seed/ID and now timestamp,
 * they produce identical output. This is critical for:
 * - Consistent page renders on reload
 * - Testability (tests can assert on exact output)
 * 
 * ALL MOCKED DATA IS CLEARLY LABELED with mockedLabel() or marked mocked:true.
 * 
 * Rules from R7/R8:
 * - Mock commit authors are synthetic (e.g., "agent:sample-a"), never real user logins
 * - No invented numbers next to real ledger entries
 * - Changelog uses real vocabulary from cli/src/types/api.ts:269
 * - Mocks take `now` as parameter for determinism
 * - Times are anchored to entity's created_at, not Date.now()
 */

import { esc, mockedLabel, link, badge, appLink, buildBadge } from './ui-html';

// ============================================================================
// Artifacts URL parsing
// ============================================================================

/**
 * Parse an Artifacts remote URL to extract accountId, namespace, and repoName.
 * Expected format: https://{accountId}.artifacts.cloudflare.net/git/{namespace}/{repoName}.git
 * Returns null if the URL doesn't match the expected pattern.
 */
export function parseArtifactsRemoteUrl(remoteUrl: string): {
  accountId: string;
  namespace: string;
  repoName: string;
} | null {
  try {
    const url = new URL(remoteUrl);
    const hostname = url.hostname;
    
    // Match pattern: {accountId}.artifacts.cloudflare.net
    const hostnameMatch = hostname.match(/^([a-f0-9]{32})\.artifacts\.cloudflare\.net$/i);
    if (!hostnameMatch) {
      return null;
    }
    
    const accountId = hostnameMatch[1];
    
    // Path should be: /git/{namespace}/{repoName}.git
    const pathParts = url.pathname.split('/').filter(Boolean);
    if (pathParts.length < 3) {
      return null;
    }
    
    // pathParts[0] should be "git"
    if (pathParts[0] !== 'git') {
      return null;
    }
    
    const namespace = pathParts[1];
    const repoNameWithExt = pathParts[2];
    
    // Remove .git extension
    const repoName = repoNameWithExt.endsWith('.git') 
      ? repoNameWithExt.slice(0, -4)
      : repoNameWithExt;
    
    if (!namespace || !repoName) {
      return null;
    }
    
    return { accountId, namespace, repoName };
  } catch {
    return null;
  }
}

// ============================================================================
// Artifacts File Fetching
// ============================================================================

/**
 * Environment variables needed for Artifacts API access
 */
export interface ArtifactsUiEnv {
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
}

/**
 * File entry from Artifacts API
 */
export interface ArtifactsFileEntry {
  path: string;
  mode: string;
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  size?: number;
  content?: string;
  download_url?: string;
}

/**
 * Response from Artifacts contents API
 */
export interface ArtifactsContentsResponse {
  repository: { id: string; name: string };
  commit: { sha: string };
  tree: ArtifactsFileEntry[];
  path: string;
}

function artifactsRepoBase(env: ArtifactsUiEnv, namespace: string, repoName: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/artifacts/namespaces/${encodeURIComponent(namespace)}/repos/${encodeURIComponent(repoName)}`;
}

async function artifactsJson(env: ArtifactsUiEnv, url: string): Promise<any | null> {
  try {
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
    });
    if (!response.ok) {
      console.error(`[Artifacts] ${url} -> ${response.status} ${(await response.text()).slice(0, 300)}`);
      return null;
    }
    const data: any = await response.json();
    if (data && data.success === false) {
      console.error(`[Artifacts] ${url} success=false: ${JSON.stringify(data.errors)}`);
      return null;
    }
    return data && data.result !== undefined ? data.result : data;
  } catch (error) {
    console.error(`[Artifacts] Error fetching ${url}:`, error);
    return null;
  }
}

/**
 * Fetch the root tree of a repository at `ref` via log -> commit -> tree.
 * Response shapes for these routes are undocumented, so parsing is defensive
 * (see docs/OPEN-QUESTIONS.md). Returns null if anything is missing.
 */
export async function fetchArtifactsContents(
  env: ArtifactsUiEnv,
  _accountId: string,
  namespace: string,
  repoName: string,
  ref: string,
  _path: string = ''
): Promise<ArtifactsContentsResponse | null> {
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) {
    console.log('[Artifacts] API token or account ID not configured, skipping real fetch');
    return null;
  }
  const base = artifactsRepoBase(env, namespace, repoName);

  const log = await artifactsJson(env, `${base}/log?ref=${encodeURIComponent(ref)}&limit=1`);
  const commits = Array.isArray(log) ? log : log?.commits ?? log?.log ?? [];
  const head = commits[0];
  const commitHash: string | undefined = head?.hash ?? head?.sha ?? head?.id ?? head?.oid;
  if (!commitHash) {
    console.error(`[Artifacts] No commit hash in log response: ${JSON.stringify(log)?.slice(0, 300)}`);
    return null;
  }

  const commit = await artifactsJson(env, `${base}/commit/${commitHash}`);
  const treeRef = commit?.tree ?? commit?.commit?.tree;
  const treeHash: string | undefined = typeof treeRef === 'string' ? treeRef : treeRef?.hash ?? treeRef?.sha;
  if (!treeHash) {
    console.error(`[Artifacts] No tree hash in commit response: ${JSON.stringify(commit)?.slice(0, 300)}`);
    return null;
  }

  const tree = await artifactsJson(env, `${base}/tree/${treeHash}`);
  const raw: any[] = Array.isArray(tree) ? tree : tree?.entries ?? tree?.tree ?? [];
  if (!raw.length) {
    console.error(`[Artifacts] No entries in tree response: ${JSON.stringify(tree)?.slice(0, 300)}`);
    return null;
  }

  const entries: ArtifactsFileEntry[] = raw.map((e) => {
    const t = String(e.type ?? e.kind ?? '');
    const isDir = t === 'tree' || t === 'dir' || t === 'directory' || String(e.mode ?? '') === '040000' || String(e.mode ?? '') === '40000';
    return {
      path: String(e.path ?? e.name),
      mode: String(e.mode ?? ''),
      type: isDir ? 'dir' : 'file',
      size: typeof e.size === 'number' ? e.size : undefined,
    };
  });

  return { repository: { id: '', name: repoName }, commit: { sha: commitHash }, tree: entries, path: '' };
}

/**
 * Fetch a file's text from Cloudflare Artifacts (GET .../file?ref=&path=).
 * Returns null if not found or on error.
 */
export async function fetchArtifactsFileContent(
  env: ArtifactsUiEnv,
  _accountId: string,
  namespace: string,
  repoName: string,
  ref: string,
  filePath: string
): Promise<string | null> {
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) {
    return null;
  }
  try {
    const url = `${artifactsRepoBase(env, namespace, repoName)}/file?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(filePath)}`;
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
    });
    if (!response.ok) {
      if (response.status !== 404) {
        console.error(`[Artifacts] file ${filePath} -> ${response.status}`);
      }
      return null;
    }
    return await response.text();
  } catch (error) {
    console.error(`[Artifacts] Error fetching file ${filePath}:`, error);
    return null;
  }
}

/**
 * Helper to create safe HTML strings (internal use only).
 * All HTML returned from this module is already properly escaped.
 */
function safeHtml(s: string): string {
  return s;
}

/**
 * Type for safe HTML (documentation only, not enforced at runtime).
 */
type SafeHtml = string;

// ============================================================================
// Types
// ============================================================================

/** Real change type vocabulary from cli/src/types/api.ts:269 */
export type ChangeType = 'typo-fix' | 'refactor' | 'behavior-change' | 'security-sensitive' | 'dependency-change' | 'infra';

export interface SemanticHit {
  kind: 'org' | 'repo' | 'spec' | 'candidate' | 'issue' | 'file';
  title: string;
  href?: string;
  snippet: string;
  score: number;
  mocked: boolean;
}

export interface ChangelogEntry {
  at: number; // epoch ms
  category: ChangeType;
  significance: 'high' | 'medium' | 'low';
  summary: string;
  refs: { label: string; href: string }[];
  mocked: boolean;
}

export interface MockCommit {
  sha: string;
  message: string;
  author: string;
  at: number;
  build: {
    status: 'passed' | 'failed' | 'running' | 'skipped';
    rung: 'pre-merge' | 'shadow' | 'train' | 'canary' | 'full';
    durationSec: number;
  };
}

export interface FileNode {
  name: string;
  type: 'dir' | 'file';
  bytes?: number;
  summary?: string;
  children?: FileNode[];
}

// ============================================================================
// Deterministic PRNG (mulberry32)
// ============================================================================

/**
 * Mulberry32 PRNG - fast, decent quality for non-crypto use.
 * Seeded with a 32-bit integer, returns 32-bit integers.
 */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 0x85dbf67b);
    t ^= t >>> 13;
    t = Math.imul(t ^ (t >>> 16), 0x6d2b79f5);
    t ^= t >>> 16;
    state = (state + t) | 0;
    return (state >>> 0) / 0xffffffff;
  };
}

/**
 * Hash a string to a 32-bit integer using FNV-1a.
 * Deterministic across runs.
 */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    hash |= 0;
  }
  return hash >>> 0;
}

/**
 * Create a seeded PRNG from an entity ID.
 */
function seededRandom(entityId: string): () => number {
  return mulberry32(fnv1a(entityId));
}

/**
 * Pick a random element from an array using a seeded PRNG.
 */
function pickRandom<T>(rng: () => number, arr: T[]): T {
  const idx = Math.floor(rng() * arr.length);
  return arr[idx];
}

// ============================================================================
// Fixed pools for mock data
// ============================================================================

const COMMIT_MESSAGES = [
  'feat: add discount calculation',
  'fix: clamp percentage to [0, 100]',
  'refactor: extract pricing utils',
  'test: add regression for negative values',
  'docs: update README with usage',
  'chore: update dependencies',
  'feat: implement URL shortening',
  'fix: handle edge case in redirect',
  'refactor: use Map for lookup',
  'test: add property-based tests',
  'feat: add analytics tracking',
  'fix: prevent null dereference',
];

const CODE_SNIPPETS = [
  'applyDiscount() clamps percentage to [0, 100] using Math.max(0, Math.min(100, pct))',
  'const total = cart.items.reduce((sum, item) => sum + item.price * item.qty, 0)',
  'function shorten(url) { return base62.encode(hash(url)) }',
  'interface PricingConfig { base: number; discount: number; taxRate: number }',
  'type RedirectResult = { url: string; code: number }',
  'export async function fetchWithRetry(url: string, retries = 3) { ... }',
  'const cache = new LRUCache<string, Response>(100)',
  'enum HttpMethod { GET = "GET", POST = "POST", PUT = "PUT", DELETE = "DELETE" }',
  'class UrlShortener { private map = new Map<string, string>() }',
  'function validatePercentage(pct: number): boolean { return pct >= 0 && pct <= 100 }',
];

const FILE_NAMES = [
  'src',
  'lib',
  'utils',
  'types',
  'index.ts',
  'pricing.ts',
  'discount.ts',
  'calculator.ts',
  'shortener.ts',
  'redirect.ts',
  'config.ts',
  'main.ts',
  'package.json',
  'README.md',
  'tsconfig.json',
];

const AGENT_NAMES = [
  'agent:claude-a',
  'agent:vibe-b',
  'agent:gpt-c',
  'agent:mistral-d',
  'agent:sample-a',
  'agent:sample-b',
  'agent:sample-c',
];

const CHANGE_CATEGORIES: ChangeType[] = [
  'typo-fix',
  'refactor',
  'behavior-change',
  'security-sensitive',
  'dependency-change',
  'infra',
];

const SIGNIFICANCE_LEVELS: ('high' | 'medium' | 'low')[] = ['high', 'medium', 'low'];

const BUILD_STATUSES: ('passed' | 'failed' | 'running' | 'skipped')[] = [
  'passed',
  'failed',
  'running',
  'skipped',
];

const ORACLE_RUNGS: ('pre-merge' | 'shadow' | 'train' | 'canary' | 'full')[] = [
  'pre-merge',
  'shadow',
  'train',
  'canary',
  'full',
];

// ============================================================================
// Semantic Search
// ============================================================================

interface SearchableEntity {
  kind: 'org' | 'repo' | 'spec' | 'candidate' | 'issue';
  id: string;
  name: string;
  description?: string;
}

/**
 * Generate semantic search results.
 * 
 * Real entities (from ledger) are matched by substring and get mocked:false.
 * Sample code hits are always mocked:true.
 * 
 * @param query The search query
 * @param entities List of real entities to search through
 * @param entityId The context entity ID (for deterministic mock results)
 * @param now Current timestamp in ms for determinism
 * @returns Up to 8 search hits
 */
export function semanticSearch(
  query: string,
  entities: SearchableEntity[],
  entityId: string,
  now: number
): SemanticHit[] {
  const rng = seededRandom(entityId + ':search:' + query);
  const results: SemanticHit[] = [];
  
  // Normalize query
  const normalizedQuery = query.toLowerCase().trim();
  
  // First: match real entities by substring (not mocked)
  for (const entity of entities) {
    const name = entity.name.toLowerCase();
    const desc = (entity.description || '').toLowerCase();
    
    if (normalizedQuery === '') {
      // Empty query: show example entities
      results.push({
        kind: entity.kind,
        title: entity.name,
        href: `/app/${entity.kind}s/${encodeURIComponent(entity.id)}`,
        snippet: entity.description || '',
        score: 1.0,
        mocked: false,
      });
    } else if (name.includes(normalizedQuery) || desc.includes(normalizedQuery)) {
      // Calculate a deterministic score based on position
      let score = 0.95;
      if (name.startsWith(normalizedQuery)) score = 1.0;
      else if (name.includes(normalizedQuery)) score = 0.9;
      else if (desc.startsWith(normalizedQuery)) score = 0.85;
      else score = 0.8;
      
      // Add tiny jitter for deterministic but varied ordering
      score = Math.round(score * 100 + rng() * 5) / 100;
      
      results.push({
        kind: entity.kind,
        title: entity.name,
        href: `/app/${entity.kind}s/${encodeURIComponent(entity.id)}`,
        snippet: truncateSnippet(entity.description || entity.name, 120),
        score,
        mocked: false,
      });
    }
  }
  
  // Second: add sample code hits if we have room (always mocked)
  const sampleHits: SemanticHit[] = [];
  for (const snippet of CODE_SNIPPETS) {
    if (normalizedQuery === '' || snippet.toLowerCase().includes(normalizedQuery)) {
      // Generate a fake file path
      const filePath = pickRandom(rng, FILE_NAMES.filter(f => !f.endsWith('.json') && !f.endsWith('.md')));
      const score = Math.round((0.5 + rng() * 0.4) * 100) / 100; // 0.5-0.9
      
      sampleHits.push({
        kind: 'file',
        title: filePath,
        // No href for sample code hits - they don't exist in Artifacts
        snippet: truncateSnippet(snippet, 100),
        score,
        mocked: true,
      });
    }
  }
  
  // Combine and sort by score descending
  const allHits = [...results, ...sampleHits];
  allHits.sort((a, b) => b.score - a.score);
  
  // Cap at 8 results
  return allHits.slice(0, 8);
}

/**
 * Truncate a snippet to max length.
 */
function truncateSnippet(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

/**
 * Render search results as HTML.
 */
export function renderSearch(hits: SemanticHit[]): SafeHtml {
  if (hits.length === 0) {
    return safeHtml('<p class="empty">No results found.</p>');
  }
  
  const items = hits.map((hit) => {
    const kindLabel = hit.kind === 'file' ? 'code' : hit.kind;
    const kindBadge = badge('mock', kindLabel);
    // For file hits, href is undefined, so just show the title as text
    // hit.kind can be: 'org', 'repo', 'spec', 'candidate', 'issue', 'file'
    // appLink only accepts: 'orgs', 'repos', 'specs', 'candidates', 'trials'
    // So for 'file' and 'issue', we just use esc()
    const entityKinds = ['org', 'repo', 'spec', 'candidate', 'trial'] as const;
    const hrefHtml = hit.href && entityKinds.includes(hit.kind as any) 
      ? appLink(`${hit.kind}s` as 'orgs' | 'repos' | 'specs' | 'candidates' | 'trials', hit.href.split('/').pop() || '', hit.title) 
      : esc(hit.title);
    const scoreText = hit.score.toFixed(2);
    const snippetEsc = esc(hit.snippet);
    const mockedTag = hit.mocked ? mockedLabel('sample') : '';
    
    return safeHtml(`
      <div class="search-hit">
        <span class="kind">${kindBadge}</span>
        <span class="score">score: ${esc(scoreText)}</span>
        ${hit.mocked ? safeHtml('<span style="float:right;">' + mockedTag + '</span>') : ''}
        <div>${hrefHtml}</div>
        <div style="color:#8b949e;font-size:13px;margin-top:4px;">${snippetEsc}</div>
      </div>
    `);
  });
  
  return safeHtml(`
    <div class="search-results">
      ${mockedLabel()}
      ${items.join('\n')}
    </div>
  `);
}

// ============================================================================
// Semantic Changelog
// ============================================================================

interface ChangelogEntity {
  kind: 'spec' | 'candidate' | 'trial' | 'promotion' | 'issue';
  id: string;
  name: string;
  createdAt: number;
  // Entity-specific fields
  specId?: string;
  candidateId?: string;
  winnerCandidateId?: string;
  candidateAId?: string;
  candidateBId?: string;
  repositoryId?: string;
  stage?: string;
  changeType?: ChangeType;
  description?: string;
}

/**
 * Generate a semantic changelog from ledger entities.
 * 
 * For entities within the last 7 days (from now), create real changelog entries.
 * If fewer than 3 real entries exist, pad with mocked entries.
 * 
 * @param entities List of ledger entities
 * @param entityId The context entity ID for deterministic mock padding
 * @param now Current timestamp in ms
 */
export function semanticChangelog(
  entities: ChangelogEntity[],
  entityId: string,
  now: number
): ChangelogEntry[] {
  const rng = seededRandom(entityId + ':changelog');
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const entries: ChangelogEntry[] = [];
  
  // Process real entities
  for (const entity of entities) {
    const age = now - entity.createdAt;
    if (age > SEVEN_DAYS_MS) continue;
    
    const entry = entityToChangelogEntry(entity, rng);
    if (entry) {
      entries.push(entry);
    }
  }
  
  // Sort by time descending
  entries.sort((a, b) => b.at - a.at);
  
  // Pad with mocked entries if we have fewer than 3
  while (entries.length < 3) {
    entries.push(generateMockChangelogEntry(rng, now, entityId));
  }
  
  return entries;
}

/**
 * Convert a ledger entity to a changelog entry.
 * Uses only real data from the entity - no invented numbers.
 */
function entityToChangelogEntry(entity: ChangelogEntity, rng: () => number): ChangelogEntry | null {
  const category = entity.changeType || pickRandom(rng, CHANGE_CATEGORIES);
  const significance: 'high' | 'medium' | 'low' = 
    entity.kind === 'promotion' ? 'high' :
    entity.kind === 'trial' ? 'high' :
    entity.kind === 'candidate' ? 'medium' : 'medium';
  
  let summary = '';
  let refs: { label: string; href: string }[] = [];
  
  switch (entity.kind) {
    case 'spec':
      summary = `Spec "${esc(entity.name)}" created`;
      refs = [{ label: 'View spec', href: `/app/specs/${encodeURIComponent(entity.id)}` }];
      break;
    case 'candidate':
      summary = `Candidate for spec "${esc(entity.name)}" created`;
      refs = [{ label: 'View candidate', href: `/app/candidates/${encodeURIComponent(entity.id)}` }];
      if (entity.specId) {
        refs.push({ label: 'View spec', href: `/app/specs/${encodeURIComponent(entity.specId)}` });
      }
      break;
    case 'trial':
      summary = `Trial created`;
      if (entity.candidateAId && entity.candidateBId) {
        summary = `Trial: candidate ${entity.candidateAId} vs ${entity.candidateBId}`;
      }
      if (entity.winnerCandidateId) {
        summary += ` - winner: ${entity.winnerCandidateId}`;
      }
      refs = [{ label: 'View trial', href: `/app/trials/${encodeURIComponent(entity.id)}` }];
      if (entity.candidateAId) refs.push({ label: 'Candidate A', href: `/app/candidates/${encodeURIComponent(entity.candidateAId)}` });
      if (entity.candidateBId) refs.push({ label: 'Candidate B', href: `/app/candidates/${encodeURIComponent(entity.candidateBId)}` });
      break;
    case 'promotion':
      summary = `Promotion recorded`;
      if (entity.candidateId) {
        summary = `Candidate ${entity.candidateId} promoted`;
        refs = [{ label: 'View candidate', href: `/app/candidates/${encodeURIComponent(entity.candidateId)}` }];
      }
      break;
    case 'issue':
      summary = `Issue "${esc(entity.name)}" ${entity.stage || 'created'}`;
      refs = [];
      if (entity.repositoryId) {
        refs.push({ label: 'View repo', href: `/app/repos/${encodeURIComponent(entity.repositoryId)}` });
      }
      break;
  }
  
  // If we can't create a meaningful entry, skip it
  if (!summary) return null;
  
  return {
    at: entity.createdAt,
    category,
    significance,
    summary,
    refs,
    mocked: false,
  };
}

/**
 * Generate a mocked changelog entry.
 */
function generateMockChangelogEntry(rng: () => number, now: number, entityId: string): ChangelogEntry {
  const hoursAgo = Math.floor(rng() * 168) + 1; // 1-168 hours ago
  const at = now - hoursAgo * 60 * 60 * 1000;
  
  const category = pickRandom(rng, CHANGE_CATEGORIES);
  const significance = pickRandom(rng, SIGNIFICANCE_LEVELS);
  
  // Generate a deterministic but varied summary
  const templates = [
    'Sample spec updated with new contract',
    'Mock candidate created for testing',
    'Example trial completed successfully',
    'Test promotion executed',
    'Dummy issue resolved',
    'Template repository initialized',
  ];
  const template = pickRandom(rng, templates);
  
  // Add entity ID to make it deterministic but varied
  const hashPart = fnv1a(entityId + ':changelog').toString(36).slice(0, 6);
  
  return {
    at,
    category,
    significance,
    summary: `${template} (mock-${hashPart})`,
    refs: [],
    mocked: true,
  };
}

/**
 * Render changelog entries as HTML.
 */
export function renderChangelog(entries: ChangelogEntry[]): SafeHtml {
  if (entries.length === 0) {
    return safeHtml('<p class="empty">No recent activity.</p>');
  }
  
  const items = entries.map((entry) => {
    const date = new Date(entry.at).toLocaleString();
    const categoryBadge = badge(entry.category, entry.category);
    const sigBadge = badge(entry.significance, entry.significance);
    
    const refsHtml = entry.refs.length > 0
      ? safeHtml('<div class="refs">' + entry.refs.map(r => 
          safeHtml(`<a href="${esc(r.href)}">${esc(r.label)}</a>`)
        ).join(' | ') + '</div>')
      : '';
    
    return safeHtml(`
      <div class="changelog-entry">
        <div class="meta">
          ${categoryBadge} ${sigBadge} <span>${esc(date)}</span>
          ${entry.mocked ? safeHtml(' ' + mockedLabel('entry')) : ''}
        </div>
        <p class="summary">${esc(entry.summary)}</p>
        ${refsHtml}
      </div>
    `);
  });
  
  return safeHtml(`
    <div class="changelog">
      ${mockedLabel('Semantic summary')}
      ${items.join('\n')}
    </div>
  `);
}

// ============================================================================
// Mock Commits
// ============================================================================

/**
 * Generate mock commits for a repository.
 * 
 * @param repoId Repository ID (for seeding)
 * @param linkedSpecId Optional spec ID to link builds to oracle ladder
 * @param now Current timestamp in ms
 * @param count Number of commits to generate (default 8)
 */
export function mockCommits(
  repoId: string,
  linkedSpecId: string | undefined,
  now: number,
  count: number = 8
): MockCommit[] {
  const rng = seededRandom(repoId + ':commits');
  const commits: MockCommit[] = [];
  
  // Use created_at-like anchor: hash of repoId gives us a base time
  const baseTime = fnv1a(repoId) % (30 * 24 * 60 * 60 * 1000); // Within last 30 days
  
  for (let i = 0; i < count; i++) {
    // Time: newer commits first, spaced out
    const hoursAgo = count - i;
    const at = now - baseTime - hoursAgo * 2 * 60 * 60 * 1000;
    
    // Generate deterministic SHA (not real 40-hex to avoid confusion - R7 S6)
    const sha = `sample·${fnv1a(repoId + ':commit:' + i).toString(36).slice(0, 8)}`;
    
    const message = pickRandom(rng, COMMIT_MESSAGES);
    const author = pickRandom(rng, AGENT_NAMES);
    
    // Build status: mostly passed, some variety
    let status = pickRandom(rng, BUILD_STATUSES);
    // If we have a linked spec, make most builds passed and track the ladder
    if (linkedSpecId && i < 6) {
      status = 'passed';
    }
    
    const rung = pickRandom(rng, ORACLE_RUNGS);
    const durationSec = Math.floor(rng() * 600) + 10; // 10-610 seconds
    
    commits.push({
      sha,
      message,
      author,
      at,
      build: { status, rung, durationSec },
    });
  }
  
  return commits;
}

/**
 * Render commits as HTML.
 */
export function renderCommits(commits: MockCommit[]): SafeHtml {
  if (commits.length === 0) {
    return safeHtml('<p class="empty">No commits yet.</p>');
  }
  
  const items = commits.map((commit) => {
    const date = new Date(commit.at).toLocaleString();
    const shaEsc = esc(commit.sha);
    const msgEsc = esc(commit.message);
    const authorEsc = esc(commit.author);
    const buildBadgeHtml = buildBadge(commit.build.status, commit.build.rung);
    const durationEsc = esc(`${commit.build.durationSec}s`);
    
    return safeHtml(`
      <div class="commit">
        <div>
          <span class="sha">${shaEsc}</span> 
          <span class="message">${msgEsc}</span>
        </div>
        <div class="author">${authorEsc} · ${esc(date)}</div>
        <div class="build">
          ${buildBadgeHtml} 
          <span style="color:#8b949e;">in ${durationEsc} on ${esc(commit.build.rung)}</span>
        </div>
      </div>
    `);
  });
  
  return safeHtml(`
    <div class="commits">
      ${mockedLabel('Commits')}
      ${items.join('\n')}
    </div>
  `);
}

// ============================================================================
// Mock File Tree
// ============================================================================

/**
 * Generate a mock file tree for a repository.
 * 
 * Uses a template that matches the "candidate services stay small" guideline.
 * Two templates: price-calculator and url-shortener.
 * 
 * @param repoId Repository ID (for seeding)
 * @param repoType Repository type or name hint
 * @returns Root file tree node
 */
export function mockFileTree(repoId: string, repoType?: string): FileNode {
  const rng = seededRandom(repoId + ':tree');
  const hash = fnv1a(repoId);
  
  // Pick template based on repo name/type
  const useCalculator = repoType?.toLowerCase().includes('price') ||
                       repoType?.toLowerCase().includes('calculator') ||
                       (hash % 2 === 0);
  
  if (useCalculator) {
    return generateCalculatorTree(rng, hash);
  } else {
    return generateShortenerTree(rng, hash);
  }
}

/**
 * Generate a price calculator service tree.
 */
function generateCalculatorTree(rng: () => number, hash: number): FileNode {
  const size = (n: number) => Math.floor(rng() * 500) + 50;
  
  return {
    name: 'price-calculator',
    type: 'dir',
    children: [
      {
        name: 'src',
        type: 'dir',
        children: [
          { name: 'index.ts', type: 'file', bytes: size(1), summary: 'Main entry point and server' },
          { name: 'pricing.ts', type: 'file', bytes: size(2), summary: 'Core pricing calculation logic' },
          { name: 'discount.ts', type: 'file', bytes: size(3), summary: 'Discount application and validation' },
          { name: 'types.ts', type: 'file', bytes: size(4), summary: 'TypeScript interfaces and types' },
          { name: 'utils.ts', type: 'file', bytes: size(5), summary: 'Utility functions' },
        ],
      },
      {
        name: 'tests',
        type: 'dir',
        children: [
          { name: 'pricing.test.ts', type: 'file', bytes: size(6), summary: 'Pricing logic tests' },
          { name: 'discount.test.ts', type: 'file', bytes: size(7), summary: 'Discount validation tests' },
        ],
      },
      { name: 'package.json', type: 'file', bytes: size(8), summary: 'Node.js package configuration' },
      { name: 'tsconfig.json', type: 'file', bytes: size(9), summary: 'TypeScript configuration' },
      { name: 'README.md', type: 'file', bytes: size(10), summary: 'Project documentation' },
    ],
  };
}

/**
 * Generate a URL shortener service tree.
 */
function generateShortenerTree(rng: () => number, hash: number): FileNode {
  const size = (n: number) => Math.floor(rng() * 500) + 50;
  
  return {
    name: 'url-shortener',
    type: 'dir',
    children: [
      {
        name: 'src',
        type: 'dir',
        children: [
          { name: 'index.ts', type: 'file', bytes: size(1), summary: 'Main entry point and HTTP handlers' },
          { name: 'shortener.ts', type: 'file', bytes: size(2), summary: 'URL shortening logic' },
          { name: 'storage.ts', type: 'file', bytes: size(3), summary: 'Key-value storage adapter' },
          { name: 'types.ts', type: 'file', bytes: size(4), summary: 'TypeScript type definitions' },
        ],
      },
      {
        name: 'tests',
        type: 'dir',
        children: [
          { name: 'shortener.test.ts', type: 'file', bytes: size(5), summary: 'Shortening logic tests' },
          { name: 'storage.test.ts', type: 'file', bytes: size(6), summary: 'Storage adapter tests' },
        ],
      },
      { name: 'package.json', type: 'file', bytes: size(7), summary: 'Node.js package configuration' },
      { name: 'wrangler.toml', type: 'file', bytes: size(8), summary: 'Cloudflare Workers configuration' },
      { name: 'README.md', type: 'file', bytes: size(9), summary: 'Project documentation' },
    ],
  };
}

/**
 * Render a file tree as HTML using <details> elements.
 */
export function renderFileTree(node: FileNode, depth: number = 0): SafeHtml {
  const indent = '  '.repeat(depth);
  
  if (node.type === 'file') {
    const summaryEsc = node.summary ? esc(node.summary) : '';
    const bytesEsc = node.bytes ? esc(` (${node.bytes} bytes)`) : '';
    return safeHtml(
      `${indent}<div class="file-item file">${esc(node.name)}${bytesEsc}${summaryEsc ? safeHtml(' <span style="color:#666;">' + summaryEsc + '</span>') : ''}</div>`
    );
  }
  
  // Directory
  const childrenHtml = node.children?.map((child) => renderFileTree(child, depth + 1)).join('\n') || '';
  
  return safeHtml(
    `${indent}<details>
${indent}  <summary>${esc(node.name)}</summary>
${childrenHtml}
${indent}</details>`
  );
}

/**
 * Render a full file tree section.
 * If Artifacts env and remote URL are provided, fetches real file tree from Artifacts.
 * Otherwise falls back to mock data.
 */
export async function renderFileTreeSection(
  repoId: string,
  repoType?: string,
  now?: number,
  env?: ArtifactsUiEnv,
  remoteUrl?: string,
  defaultBranch?: string
): Promise<SafeHtml> {
  let readmeHtml = '';
  let realTree: FileNode | null = null;
  if (env && remoteUrl && defaultBranch) {
    const parsed = parseArtifactsRemoteUrl(remoteUrl);
    if (parsed) {
      const accountId = env.CLOUDFLARE_ACCOUNT_ID || parsed.accountId;
      const contents = await fetchArtifactsContents(env, accountId, parsed.namespace, parsed.repoName, defaultBranch, '');
      if (contents) {
        realTree = buildFileTreeFromArtifacts(contents.tree);
      }
      const readme = await tryFetchReadme(env, accountId, parsed.namespace, parsed.repoName, defaultBranch);
      if (readme) {
        readmeHtml = `<div class="readme-section"><h4>README.md</h4><pre class="readme-content" style="white-space:pre-wrap;">${esc(readme)}</pre></div>`;
      }
    }
  }

  if (realTree) {
    return safeHtml(`
    <div class="file-tree">
      ${readmeHtml}
      ${renderFileTree(realTree)}
    </div>
  `);
  }

  // Fall back to mock tree (README, if fetched, is still real)
  const tree = mockFileTree(repoId, repoType);
  return safeHtml(`
    <div class="file-tree">
      ${readmeHtml}
      ${mockedLabel('File tree')}
      ${renderFileTree(tree)}
    </div>
  `);
}

/**
 * Try to fetch README.md content from Artifacts repository.
 * Checks various possible locations (root, docs, etc.).
 */
async function tryFetchReadme(
  env: ArtifactsUiEnv,
  accountId: string,
  namespace: string,
  repoName: string,
  ref: string
): Promise<string | null> {
  const possiblePaths = ['README.md', 'README.MD', 'readme.md', 'docs/README.md'];
  
  for (const path of possiblePaths) {
    const content = await fetchArtifactsFileContent(
      env,
      accountId,
      namespace,
      repoName,
      ref,
      path
    );
    
    if (content) {
      return content;
    }
  }
  
  return null;
}

/**
 * Build a FileNode tree from Artifacts file entries.
 * Converts flat list of files/dirs into nested tree structure.
 */
function buildFileTreeFromArtifacts(files: ArtifactsFileEntry[]): FileNode {
  const root: FileNode = {
    name: '.',
    type: 'dir',
    children: [],
  };
  
  // Group files by directory
  const dirs: Record<string, FileNode> = {};
  
  for (const file of files) {
    const pathParts = file.path.split('/');
    const name = pathParts.pop()!;
    const dirPath = pathParts.join('/');
    
    const node: FileNode = {
      name,
      type: file.type as 'file' | 'dir',
      bytes: file.size !== undefined ? file.size : undefined,
      summary: file.type === 'file' && file.size !== undefined ? `${file.size} bytes` : undefined,
    };
    
    if (dirPath) {
      // File is in a subdirectory
      if (!dirs[dirPath]) {
        // Create directory structure
        const dirParts = dirPath.split('/');
        let currentPath = '';
        let parent = root;
        
        for (const part of dirParts) {
          currentPath = currentPath ? `${currentPath}/${part}` : part;
          let dir = parent.children!.find(c => c.name === part && c.type === 'dir');
          
          if (!dir) {
            dir = { name: part, type: 'dir' as const, children: [] };
            parent.children!.push(dir);
          }
          
          parent = dir;
        }
        
        dirs[dirPath] = parent;
      }
      
      // Ensure the directory has a children array
      if (!dirs[dirPath].children) {
        dirs[dirPath].children = [];
      }
      dirs[dirPath].children.push(node);
    } else {
      // File is in root
      root.children.push(node);
    }
  }
  
  // Sort children for consistent display
  root.children.sort((a, b) => {
    // Directories first, then files
    if (a.type === 'dir' && b.type !== 'dir') return -1;
    if (a.type !== 'dir' && b.type === 'dir') return 1;
    return a.name.localeCompare(b.name);
  });
  
  return root;
}
