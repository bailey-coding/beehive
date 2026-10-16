/**
 * UI page handlers for Beehive detail pages.
 * 
 * Each page handler:
 * - Takes (id, url, session, doReader) parameters
 * - Reads data from Spec DO via doReader (unfiltered lists only - R1)
 * - Filters data in the UI using pick() helper
 * - Returns a Response
 * 
 * Authorization: All handlers assume auth has already been checked in handleUi.
 * Any allowlisted user can see all orgs - this is existing behavior (R9).
 */

import { esc, str, table, tableHtml, page, appLink, badge, stageBadge, visibilityBadge, mockedLabel, isValidId, pick, tabs } from './ui-html';
import { 
  semanticSearch, renderSearch, 
  semanticChangelog, renderChangelog,
  mockCommits, renderCommits,
  mockFileTree, renderFileTree, renderFileTreeSection,
  type ArtifactsUiEnv
} from './ui-semantic';

// Session type (re-exported from ui.ts for tests)
export interface Session {
  login: string;
  actorId: string;
  exp: number;
}

// ============================================================================
// Types
// ============================================================================

/**
 * Row from Spec DO - can be snake_case or camelCase depending on endpoint.
 */
export interface DoRow {
  [key: string]: unknown;
  id?: string;
}

/**
 * DoReader interface for reading from Spec DO.
 * Uses only unfiltered list routes per R1.
 */
export interface DoReader {
  /** Get a single record by ID */
  get(path: string): Promise<DoRow | null>;
  /** List all records (unfiltered) - DO NOT pass filter params per R1 */
  list(path: string, limit?: number): Promise<DoRow[]>;
}

// ============================================================================
// Error handling helper
// ============================================================================

/**
 * Wrap a page body function with error handling for doReader failures.
 * Per AGENTS.md: "Check Response.ok; a 404 is an error, never empty"
 */
export async function withDoReaderErrorHandling(
  fn: () => Promise<Response>
): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    // Return an error page with the error message
    return page('Error', `<p>could not load: ${esc(errorMessage)}</p><p><a href="/app">Back to dashboard</a></p>`, 200);
  }
}

// ============================================================================
// Shared helpers
// ============================================================================

/**
 * Filter rows by a field value.
 */
function filterRows(rows: DoRow[], field: string, value: string): DoRow[] {
  return rows.filter((row) => pick(row, field) === value || pick(row, field, field.toLowerCase()) === value);
}

/**
 * Format a timestamp for display.
 */
function formatDate(ts: number | string | undefined): string {
  if (!ts) return '';
  const num = typeof ts === 'string' ? parseInt(ts, 10) : ts;
  if (isNaN(num)) return '';
  return new Date(num).toLocaleString();
}

/**
 * Create a subheader with back link and title.
 */
function subHeader(title: string, backHref: string = '/app', backText: string = 'Back to dashboard'): string {
  return `
    <div class="subbar">
      <a href="${esc(backHref)}" class="link">&larr; ${esc(backText)}</a>
      <h2>${esc(title)}</h2>
    </div>
  `;
}

// ============================================================================
// Entity access helpers (handle both snake_case and camelCase)
// ============================================================================

function getId(row: DoRow): string {
  return pick(row, 'id');
}

function getName(row: DoRow): string {
  return pick(row, 'name');
}

function getType(row: DoRow): string {
  return pick(row, 'type');
}

function getOrganizationId(row: DoRow): string {
  return pick(row, 'organization_id', 'organizationId');
}

function getRepositoryId(row: DoRow): string {
  return pick(row, 'repository_id', 'repositoryId');
}

function getSpecId(row: DoRow): string {
  return pick(row, 'spec_id', 'specId');
}

function getStage(row: DoRow): string {
  return pick(row, 'stage');
}

function getDescription(row: DoRow): string {
  return pick(row, 'description');
}

function getCreatedAt(row: DoRow): number {
  const val = pick(row, 'created_at', 'createdAt');
  return val ? parseInt(val as string, 10) : 0;
}

function getContract(row: DoRow): string {
  return pick(row, 'contract');
}

function getDeclaredDeltaSurface(row: DoRow): string {
  return pick(row, 'declared_delta_surface', 'declaredDeltaSurface');
}

function getRemoteUrl(row: DoRow): string {
  return pick(row, 'remote_url', 'remoteUrl');
}

function getVisibility(row: DoRow): string {
  return pick(row, 'visibility');
}

function getNamespace(row: DoRow): string {
  return pick(row, 'namespace');
}

/**
 * Build a hierarchical repo URL or fall back to UUID URL.
 * Falls back when: org not found, namespace empty, or any component has invalid characters.
 */
function buildRepoUrl(repo: DoRow, orgs: DoRow[], repoIdFallback?: string): string {
  const id = repoIdFallback || pick(repo, 'id');
  const repoOrg = orgs.find((o) => pick(o, 'id') === pick(repo, 'organization_id', 'organizationId'));
  
  if (!repoOrg) {
    // Fallback to UUID URL if org not found (Bug #3 fix)
    return `/app/repos/${esc(encodeURIComponent(id))}`;
  }
  
  const orgName = pick(repoOrg, 'name');
  const namespace = pick(repo, 'namespace') || 'default';
  const repoName = pick(repo, 'name') || id;
  
  // Validate all components have allowed characters (Bug #2 fix)
  const validComponent = /^[A-Za-z0-9_.-]{1,64}$/;
  if (!validComponent.test(orgName) || 
      !validComponent.test(namespace) || 
      !validComponent.test(repoName)) {
    // Fallback to UUID URL if any component has invalid characters
    return `/app/repos/${esc(encodeURIComponent(id))}`;
  }
  
  // If namespace equals orgName, use 2-part URL; otherwise use 3-part
  const namespacePart = namespace === orgName ? '' : `/${esc(encodeURIComponent(namespace))}`;
  return `/app/repos/${esc(encodeURIComponent(orgName))}${namespacePart}/${esc(encodeURIComponent(repoName))}`;
}

// Export buildRepoUrl for use in ui.ts
export { buildRepoUrl };

// ============================================================================
// Organization Page
// ============================================================================

/**
 * Render organization detail page with repos, specs, search, and changelog.
 */
export async function orgPage(
  id: string,
  url: URL,
  session: Session,
  doReader: DoReader
): Promise<Response> {
  if (!isValidId(id)) {
    return page('Not found', '<p>Invalid organization ID.</p>', 404);
  }
  
  const [org, repos, specs, candidates, trials, promotions, issues] = await Promise.all([
    doReader.get(`/api/organizations/${encodeURIComponent(id)}`),
    doReader.list('/api/repositories', 500),
    doReader.list('/api/specs', 500),
    doReader.list('/api/candidates', 500),
    doReader.list('/api/trials', 500),
    doReader.list('/api/promotions', 500),
    doReader.list('/api/issues', 500),
  ]);
  
  if (!org) {
    return page('Not found', '<p>Organization not found. <a href="/app">Back to dashboard</a></p>', 404);
  }
  
  // Filter in UI (R1)
  const orgRepos = repos.filter((r) => getOrganizationId(r) === id);
  const orgSpecs = specs.filter((s) => getOrganizationId(s) === id);
  const orgIssues = issues.filter((i) => {
    const repo = repos.find((r) => getId(r) === getRepositoryId(i));
    return repo && getOrganizationId(repo) === id;
  });
  
  // Build searchable entities
  const searchableEntities = [
    ...orgRepos.map((r) => ({ kind: 'repo' as const, id: getId(r), name: getName(r), description: getDescription(r) || undefined })),
    ...orgSpecs.map((s) => ({ kind: 'spec' as const, id: getId(s), name: getName(s), description: getDescription(s) || undefined })),
  ];
  
  const query = url.searchParams.get('q') || '';
  const searchResults = semanticSearch(query, searchableEntities, id, Date.now());
  
  // Build changelog entities
  const changelogEntities = [
    ...orgSpecs.map((s) => toChangelogEntity('spec', s)),
    ...candidates.map((c) => toChangelogEntity('candidate', c)),
    ...trials.map((t) => toChangelogEntity('trial', t)),
    ...promotions.map((p) => toChangelogEntity('promotion', p)),
    ...orgIssues.map((i) => toChangelogEntity('issue', i)),
  ];
  const changelog = semanticChangelog(changelogEntities, id, Date.now());
  
  // Render tables
  const reposRows = orgRepos.map((r) => [
    `<a href="${buildRepoUrl(r, [org])}">${esc(getName(r))}</a>`,
    esc(getType(r)),
    `<a href="/app/specs/${esc(encodeURIComponent(getSpecId(r)))}">${esc(getSpecId(r) || 'none')}</a>`,
  ]);
  
  const specsRows = orgSpecs.map((s) => [
    `<a href="/app/specs/${esc(encodeURIComponent(getId(s)))}">${esc(getName(s))}</a>`,
    esc(getStage(s)),
    esc(formatDate(getCreatedAt(s))),
  ]);
  
  const body = `
    ${subHeader(getName(org), '/app', 'All organizations')}
    
    <section class="details-section">
      <h3>Details</h3>
      <dl>
        <dt>ID</dt><dd>${esc(getId(org))}</dd>
        <dt>Type</dt><dd>${esc(getType(org))}</dd>
        <dt>Created</dt><dd>${esc(formatDate(getCreatedAt(org)))}</dd>
      </dl>
    </section>
    
    <section>
      <h2>Repositories (${orgRepos.length})</h2>
      ${tableHtml(['Name', 'Type', 'Spec'], reposRows)}
    </section>
    
    <section>
      <h2>Specs (${orgSpecs.length})</h2>
      ${tableHtml(['Name', 'Stage', 'Created'], specsRows)}
    </section>
    
    <section class="search-box">
      <h2>Search</h2>
      <form method="GET" action="/app/orgs/${esc(encodeURIComponent(id))}">
        <input type="search" name="q" value="${esc(query)}" placeholder="Search in this organization...">
        <button type="submit">Search</button>
      </form>
      ${renderSearch(searchResults)}
    </section>
    
    <section>
      <h2>Recent Activity</h2>
      ${renderChangelog(changelog)}
    </section>
    
    <p style="color:#8b949e;font-size:12px;">
      Note: Any allowlisted user can see all organizations (existing behavior).
    </p>
  `;
  
  return page(getName(org), body);
}

// ============================================================================
// Changelog entity conversion
// ============================================================================

function toChangelogEntity(kind: 'spec' | 'candidate' | 'trial' | 'promotion' | 'issue', row: DoRow): any {
  const entity: any = {
    kind,
    id: getId(row),
    name: getName(row),
    createdAt: getCreatedAt(row),
  };
  
  if (kind === 'candidate') {
    entity.specId = getSpecId(row);
    entity.repositoryId = getRepositoryId(row);
  } else if (kind === 'trial') {
    entity.candidateAId = pick(row, 'candidate_a_id', 'candidateAId');
    entity.candidateBId = pick(row, 'candidate_b_id', 'candidateBId');
    entity.winnerCandidateId = pick(row, 'winner_candidate_id', 'winnerCandidateId');
  } else if (kind === 'promotion') {
    entity.candidateId = pick(row, 'candidate_id', 'candidateId');
  } else if (kind === 'issue') {
    entity.repositoryId = getRepositoryId(row);
    entity.changeType = pick(row, 'change_type', 'changeType');
    entity.stage = getStage(row);
  }
  
  return entity;
}

// ============================================================================
// Repository Page
// ============================================================================

/**
 * Render repository detail page with tabs.
 */
export async function repoPage(
  id: string,
  url: URL,
  session: Session,
  doReader: DoReader,
  env?: ArtifactsUiEnv
): Promise<Response> {
  if (!isValidId(id)) {
    return page('Not found', '<p>Invalid repository ID.</p>', 404);
  }
  
  const [repo, orgs, specs, candidates, issues, trials, promotions] = await Promise.all([
    doReader.get(`/api/repositories/${encodeURIComponent(id)}`),
    doReader.list('/api/organizations', 500),
    doReader.list('/api/specs', 500),
    doReader.list('/api/candidates', 500),
    doReader.list('/api/issues', 500),
    doReader.list('/api/trials', 500),
    doReader.list('/api/promotions', 500),
  ]);
  
  if (!repo) {
    return page('Not found', '<p>Repository not found. <a href="/app">Back to dashboard</a></p>', 404);
  }
  
  const repoOrg = orgs.find((o) => getId(o) === getOrganizationId(repo));
  const linkedSpec = specs.find((s) => getId(s) === getSpecId(repo));
  const repoIssues = issues.filter((i) => getRepositoryId(i) === id);
  const repoCandidates = candidates.filter((c) => getRepositoryId(c) === id);
  const repoSpecs = specs.filter((s) => getId(s) === getSpecId(repo));
  
  // Build hierarchical URL with fallback to UUID if invalid (Bug #3 fix)
  const hierarchicalRepoPath = buildRepoUrl(repo, orgs, id);
  
  const tab = url.searchParams.get('tab') || 'overview';
  const validTabs = ['overview', 'issues', 'specs', 'trials', 'commits', 'files'];
  const activeTab = validTabs.includes(tab) ? tab : 'overview';
  
  // Build searchable entities
  const searchableEntities = [
    ...repoSpecs.map((s) => ({ kind: 'spec' as const, id: getId(s), name: getName(s), description: getDescription(s) || undefined })),
    ...repoIssues.map((i) => ({ kind: 'issue' as const, id: getId(i), name: getName(i), description: getDescription(i) || undefined })),
  ];
  
  const query = url.searchParams.get('q') || '';
  const searchResults = semanticSearch(query, searchableEntities, id, Date.now());
  
  const changelogEntities = [
    ...repoSpecs.map((s) => toChangelogEntity('spec', s)),
    ...repoCandidates.map((c) => toChangelogEntity('candidate', c)),
    ...trials.map((t) => toChangelogEntity('trial', t)),
    ...promotions.map((p) => toChangelogEntity('promotion', p)),
    ...repoIssues.map((i) => toChangelogEntity('issue', i)),
  ];
  const changelog = semanticChangelog(changelogEntities, id, Date.now());
  
  const commits = mockCommits(id, linkedSpec ? getId(linkedSpec) : undefined, Date.now(), 8);
  
  const tabContent = await renderRepoTab(activeTab, repo, repoOrg, linkedSpec, repoIssues, repoCandidates, repoSpecs, commits, trials, promotions, env);
  
  const body = `
    ${subHeader(getName(repo), '/app', 'All repositories')}
    
    <section class="details-section">
      <h3>Details</h3>
      <dl>
        <dt>ID</dt><dd>${esc(getId(repo))}</dd>
        <dt>Organization</dt><dd>${repoOrg ? `<a href="/app/orgs/${esc(encodeURIComponent(getId(repoOrg)))}">${esc(getName(repoOrg))}</a>` : 'N/A'}</dd>
        <dt>Type</dt><dd>${esc(getType(repo))}</dd>
        <dt>Remote URL</dt><dd>${esc(getRemoteUrl(repo))}</dd>
        <dt>Spec</dt><dd>${linkedSpec ? `<a href="/app/specs/${esc(encodeURIComponent(getId(linkedSpec)))}">${esc(getName(linkedSpec))}</a>` : 'none'}</dd>
        <dt>Namespace</dt><dd>${esc(pick(repo, 'namespace'))}</dd>
        <dt>Default branch</dt><dd>${esc(pick(repo, 'default_branch', 'defaultBranch'))}</dd>
        <dt>Created</dt><dd>${esc(formatDate(getCreatedAt(repo)))}</dd>
      </dl>
    </section>
    
    ${tabs(hierarchicalRepoPath, activeTab, validTabs)}
    
    ${tabContent}
    
    <section class="search-box">
      <h2>Search</h2>
      <form method="GET" action="${hierarchicalRepoPath}">
        <input type="search" name="q" value="${esc(query)}" placeholder="Search in this repository...">
        <button type="submit">Search</button>
      </form>
      ${renderSearch(searchResults)}
    </section>
    
    <section>
      <h2>Recent Activity</h2>
      ${renderChangelog(changelog)}
    </section>
  `;
  
  return page(getName(repo), body);
}

/**
 * Render repository tab content.
 */
async function renderRepoTab(
  tab: string,
  repo: DoRow,
  org: DoRow | undefined,
  spec: DoRow | undefined,
  issues: DoRow[],
  candidates: DoRow[],
  specs: DoRow[],
  commits: any[],
  trials: DoRow[],
  promotions: DoRow[],
  env?: ArtifactsUiEnv
): Promise<string> {
  switch (tab) {
    case 'overview':
      return renderRepoOverview(repo, org, spec, candidates, trials, promotions);
    case 'issues':
      return renderRepoIssues(issues);
    case 'specs':
      return renderRepoSpecs(specs);
    case 'trials':
      return renderRepoTrials(trials, candidates);
    case 'commits':
      return renderCommits(commits).toString();
    case 'files':
      // Try to fetch real file tree from Artifacts if configured
      const remoteUrl = getRemoteUrl(repo);
      const defaultBranch = pick(repo, 'default_branch', 'defaultBranch') || 'main';
      
      const result = await renderFileTreeSection(
        getId(repo),
        pick(repo, 'repo_type', 'repoType'),
        undefined,
        env,
        remoteUrl || undefined,
        defaultBranch || undefined
      );
      return result.toString();
    default:
      return renderRepoOverview(repo, org, spec, candidates, trials, promotions);
  }
}

/**
 * Render repository overview tab.
 */
function renderRepoOverview(
  repo: DoRow,
  org: DoRow | undefined,
  spec: DoRow | undefined,
  candidates: DoRow[],
  trials: DoRow[],
  promotions: DoRow[]
): string {
  const repoCandidates = candidates.filter((c) => getRepositoryId(c) === getId(repo));
  
  const candidateRows = repoCandidates.map((c) => [
    `<a href="/app/candidates/${esc(encodeURIComponent(getId(c)))}">${esc(getId(c).slice(0, 8))}</a>`,
    stageBadge(getStage(c)),
    esc(formatDate(getCreatedAt(c))),
  ]);
  
  const repoTrialRows = trials
    .filter((t) => {
      const a = pick(t, 'candidate_a_id', 'candidateAId');
      const b = pick(t, 'candidate_b_id', 'candidateBId');
      return repoCandidates.some((c) => getId(c) === a || getId(c) === b);
    })
    .map((t) => [
      `<a href="/app/trials/${esc(encodeURIComponent(getId(t)))}">${esc(getId(t).slice(0, 8))}</a>`,
      esc(pick(t, 'winner_candidate_id', 'winnerCandidateId') || 'pending'),
      esc(formatDate(getCreatedAt(t))),
    ]);
  
  const repoPromoRows = promotions
    .filter((p) => repoCandidates.some((c) => getId(c) === pick(p, 'candidate_id', 'candidateId')))
    .map((p) => [
      `<a href="/app/candidates/${esc(encodeURIComponent(pick(p, 'candidate_id', 'candidateId') || ''))}">${esc((pick(p, 'candidate_id', 'candidateId') || '').slice(0, 8))}</a>`,
      esc(formatDate(getCreatedAt(p))),
    ]);
  
  return `
    <section>
      <h3>Linked Spec</h3>
      ${spec ? `
        <p><a href="/app/specs/${esc(encodeURIComponent(getId(spec)))}">${esc(getName(spec))}</a> (${esc(getStage(spec))})</p>
        <p>${esc(getDescription(spec) || 'No description')}</p>
      ` : '<p class="empty">No linked spec</p>'}
    </section>
    
    <section>
      <h3>Candidates (${repoCandidates.length})</h3>
      ${tableHtml(['ID', 'Stage', 'Created'], candidateRows)}
    </section>
    
    <section>
      <h3>Trials (${repoTrialRows.length})</h3>
      ${tableHtml(['ID', 'Winner', 'Created'], repoTrialRows)}
    </section>
    
    <section>
      <h3>Promotions (${repoPromoRows.length})</h3>
      ${tableHtml(['Candidate', 'Promoted at'], repoPromoRows)}
    </section>
  `;
}

/**
 * Render repository issues tab.
 */
function renderRepoIssues(issues: DoRow[]): string {
  const publicIssues = issues.filter((i) => {
    const visibility = getVisibility(i);
    return !visibility || visibility === 'public' || visibility === 'internal';
  });
  
  const rows = publicIssues.map((i) => [
    `<a href="/app/issues/${esc(encodeURIComponent(getId(i)))}">${esc(getName(i))}</a>`,
    visibilityBadge(getVisibility(i) || 'public'),
    esc(pick(i, 'change_type', 'changeType') || ''),
    esc(getStage(i) || ''),
    esc(formatDate(getCreatedAt(i))),
  ]);
  
  return `
    <section>
      <p style="color:#8b949e;font-size:12px; margin-bottom: 8px;">
        Private issues are hidden from this view.
      </p>
      ${tableHtml(['Title', 'Visibility', 'Type', 'Stage', 'Created'], rows)}
    </section>
  `;
}

/**
 * Render repository specs tab.
 */
function renderRepoSpecs(specs: DoRow[]): string {
  const rows = specs.map((s) => [
    `<a href="/app/specs/${esc(encodeURIComponent(getId(s)))}">${esc(getName(s))}</a>`,
    esc(getStage(s)),
    esc(formatDate(getCreatedAt(s))),
    esc(getDescription(s) || ''),
  ]);
  
  return `
    <section>
      ${tableHtml(['Name', 'Stage', 'Created', 'Description'], rows)}
    </section>
  `;
}

/**
 * Render repository trials tab.
 */
function renderRepoTrials(trials: DoRow[], candidates: DoRow[]): string {
  const repoCandidates = candidates;
  
  const trialRows = trials
    .filter((t) => {
      const a = pick(t, 'candidate_a_id', 'candidateAId');
      const b = pick(t, 'candidate_b_id', 'candidateBId');
      return repoCandidates.some((c) => getId(c) === a || getId(c) === b);
    })
    .map((t) => {
      const aId = pick(t, 'candidate_a_id', 'candidateAId') || '';
      const bId = pick(t, 'candidate_b_id', 'candidateBId') || '';
      const winnerId = pick(t, 'winner_candidate_id', 'winnerCandidateId') || '';
      return [
        `<a href="/app/trials/${esc(encodeURIComponent(getId(t)))}">${esc(getId(t).slice(0, 8))}</a>`,
        `<a href="/app/candidates/${esc(encodeURIComponent(aId))}">${esc(aId.slice(0, 8))}</a>`,
        `<a href="/app/candidates/${esc(encodeURIComponent(bId))}">${esc(bId.slice(0, 8))}</a>`,
        esc(winnerId ? winnerId.slice(0, 8) : 'pending'),
        esc(formatDate(getCreatedAt(t))),
      ];
    });
  
  return `
    <section>
      <p style="color:#8b949e;font-size:12px; margin-bottom: 8px;">
        Trials involving candidates from this repository.
      </p>
      ${tableHtml(['ID', 'Candidate A', 'Candidate B', 'Winner', 'Created'], trialRows)}
    </section>
  `;
}

// ============================================================================
// Spec Page
// ============================================================================

/**
 * Render spec detail page.
 * Note: Does NOT build "linked issues" section (R4) - shows issues in linked repos instead.
 */
export async function specPage(
  id: string,
  url: URL,
  session: Session,
  doReader: DoReader
): Promise<Response> {
  if (!isValidId(id)) {
    return page('Not found', '<p>Invalid spec ID.</p>', 404);
  }
  
  return withDoReaderErrorHandling(async () => {
    const [spec, orgs, repos, candidates, trials, promotions, issues] = await Promise.all([
      doReader.get(`/api/specs/${encodeURIComponent(id)}`),
      doReader.list('/api/organizations', 500),
      doReader.list('/api/repositories', 500),
      doReader.list('/api/candidates', 500),
      doReader.list('/api/trials', 500),
      doReader.list('/api/promotions', 500),
      doReader.list('/api/issues', 500),
    ]);
    
    if (!spec) {
      return page('Not found', '<p>Spec not found. <a href="/app">Back to dashboard</a></p>', 404);
    }
  
  const specOrg = orgs.find((o) => getId(o) === getOrganizationId(spec));
  const linkedRepos = repos.filter((r) => getSpecId(r) === id);
  const specCandidates = candidates.filter((c) => getSpecId(c) === id);
  const specTrials = trials.filter((t) => {
    const a = pick(t, 'candidate_a_id', 'candidateAId');
    const b = pick(t, 'candidate_b_id', 'candidateBId');
    return specCandidates.some((c) => getId(c) === a || getId(c) === b);
  });
  
  const linkedRepoIds = new Set(linkedRepos.map(getId));
  const linkedIssues = issues.filter((i) => linkedRepoIds.has(getRepositoryId(i)));
  
  const searchableEntities = [
    ...linkedRepos.map((r) => ({ kind: 'repo' as const, id: getId(r), name: getName(r), description: getDescription(r) || undefined })),
    ...specCandidates.map((c) => ({ kind: 'candidate' as const, id: getId(c), name: getId(c), description: getDescription(c) || undefined })),
  ];
  
  const query = url.searchParams.get('q') || '';
  const searchResults = semanticSearch(query, searchableEntities, id, Date.now());
  
  const changelogEntities = [
    toChangelogEntity('spec', spec),
    ...specCandidates.map((c) => toChangelogEntity('candidate', c)),
    ...specTrials.map((t) => toChangelogEntity('trial', t)),
    ...promotions.filter((p) => specCandidates.some((c) => getId(c) === pick(p, 'candidate_id', 'candidateId')))
      .map((p) => toChangelogEntity('promotion', p)),
    ...linkedIssues.map((i) => toChangelogEntity('issue', i)),
  ];
  const changelog = semanticChangelog(changelogEntities, id, Date.now());
  
  // Render contract safely (R6)
  let contractDisplay = '';
  try {
    const contract = getContract(spec);
    if (contract) {
      const parsed = JSON.parse(contract);
      contractDisplay = `<pre class="contract-display">${esc(JSON.stringify(parsed, null, 2))}</pre>`;
    }
  } catch {
    contractDisplay = `<pre class="contract-display">${esc(getContract(spec))}</pre>`;
  }
  
  // Render declared delta surface safely
  let deltaDisplay = '';
  try {
    const delta = getDeclaredDeltaSurface(spec);
    if (delta) {
      const parsed = JSON.parse(delta);
      deltaDisplay = `<pre class="contract-display">${esc(JSON.stringify(parsed, null, 2))}</pre>`;
    }
  } catch {
    deltaDisplay = `<pre class="contract-display">${esc(getDeclaredDeltaSurface(spec))}</pre>`;
  }
  
  const candidateRows = specCandidates.map((c) => {
    const candidateRepo = repos.find((r) => getId(r) === getRepositoryId(c));
    const repoUrl = candidateRepo ? buildRepoUrl(candidateRepo, orgs) : `/app/repos/${esc(encodeURIComponent(getRepositoryId(c)))}`;
    return [
      `<a href="/app/candidates/${esc(encodeURIComponent(getId(c)))}">${esc(getId(c).slice(0, 8))}</a>`,
      `<a href="${repoUrl}">${esc(getRepositoryId(c).slice(0, 8))}</a>`,
      stageBadge(getStage(c)),
      esc(formatDate(getCreatedAt(c))),
    ];
  });
  
  const trialRows = specTrials.map((t) => {
    const aId = pick(t, 'candidate_a_id', 'candidateAId') || '';
    const bId = pick(t, 'candidate_b_id', 'candidateBId') || '';
    const winnerId = pick(t, 'winner_candidate_id', 'winnerCandidateId') || '';
    return [
      `<a href="/app/trials/${esc(encodeURIComponent(getId(t)))}">${esc(getId(t).slice(0, 8))}</a>`,
      `<a href="/app/candidates/${esc(encodeURIComponent(aId))}">${esc(aId.slice(0, 8))}</a>`,
      `<a href="/app/candidates/${esc(encodeURIComponent(bId))}">${esc(bId.slice(0, 8))}</a>`,
      esc(winnerId ? winnerId.slice(0, 8) : 'pending'),
      esc(formatDate(getCreatedAt(t))),
    ];
  });
  
  const repoRows = linkedRepos.map((r) => [
    `<a href="${buildRepoUrl(r, orgs)}">${esc(getName(r))}</a>`,
    esc(getType(r)),
    esc(formatDate(getCreatedAt(r))),
  ]);
  
  const issueRows = linkedIssues
    .filter((i) => {
      const visibility = getVisibility(i);
      return !visibility || visibility === 'public' || visibility === 'internal';
    })
    .map((i) => [
      `<a href="/app/issues/${esc(encodeURIComponent(getId(i)))}">${esc(getName(i))}</a>`,
      visibilityBadge(getVisibility(i) || 'public'),
      esc(pick(i, 'change_type', 'changeType') || ''),
      esc(getStage(i) || ''),
    ]);
  
  const body = `
    ${subHeader(getName(spec), '/app', 'All specs')}
    
    <section class="details-section">
      <h3>Details</h3>
      <dl>
        <dt>ID</dt><dd>${esc(getId(spec))}</dd>
        <dt>Organization</dt><dd>${specOrg ? `<a href="/app/orgs/${esc(encodeURIComponent(getId(specOrg)))}">${esc(getName(specOrg))}</a>` : 'N/A'}</dd>
        <dt>Stage</dt><dd>${stageBadge(getStage(spec))}</dd>
        <dt>Created</dt><dd>${esc(formatDate(getCreatedAt(spec)))}</dd>
      </dl>
    </section>
    
    <section>
      <h2>Contract</h2>
      ${contractDisplay || '<p class="empty">No contract defined</p>'}
    </section>
    
    <section>
      <h2>Declared Delta Surface</h2>
      ${deltaDisplay || '<p class="empty">No delta surface defined</p>'}
    </section>
    
    <section>
      <h2>Description</h2>
      <p>${esc(getDescription(spec) || 'No description')}</p>
    </section>
    
    <section>
      <h2>Linked Repositories (${linkedRepos.length})</h2>
      ${tableHtml(['Name', 'Type', 'Created'], repoRows)}
    </section>
    
    <section>
      <h2>Candidates (${specCandidates.length})</h2>
      ${tableHtml(['ID', 'Repository', 'Stage', 'Created'], candidateRows)}
    </section>
    
    <section>
      <h2>Trials (${specTrials.length})</h2>
      ${tableHtml(['ID', 'Candidate A', 'Candidate B', 'Winner', 'Created'], trialRows)}
    </section>
    
    <section>
      <h2>Issues in Linked Repositories (${issueRows.length})</h2>
      <p style="color:#8b949e;font-size:12px; margin-bottom: 8px;">
        Issues in repos that reference this spec. Private issues are hidden.
      </p>
      ${tableHtml(['Title', 'Visibility', 'Type', 'Stage'], issueRows)}
    </section>
    
    <section class="search-box">
      <h2>Search</h2>
      <form method="GET" action="/app/specs/${esc(encodeURIComponent(id))}">
        <input type="search" name="q" value="${esc(query)}" placeholder="Search in this spec...">
        <button type="submit">Search</button>
      </form>
      ${renderSearch(searchResults)}
    </section>
    
    <section>
      <h2>Recent Activity</h2>
      ${renderChangelog(changelog)}
    </section>
  `;
  
    return page(getName(spec), body);
  });
}

// ============================================================================
// Candidate Page
// ============================================================================

/**
 * Render candidate detail page.
 */
export async function candidatePage(
  id: string,
  url: URL,
  session: Session,
  doReader: DoReader
): Promise<Response> {
  if (!isValidId(id)) {
    return page('Not found', '<p>Invalid candidate ID.</p>', 404);
  }
  
  const [candidate, specs, orgs, repos, trialsList, promotionsList, verdicts] = await Promise.all([
    doReader.get(`/api/candidates/${encodeURIComponent(id)}`),
    doReader.list('/api/specs', 500),
    doReader.list('/api/organizations', 500),
    doReader.list('/api/repositories', 500),
    doReader.list('/api/trials', 500),
    doReader.list('/api/promotions', 500),
    doReader.get(`/api/candidates/${encodeURIComponent(id)}/gate-verdicts`),
  ]);
  
  if (!candidate) {
    return page('Not found', '<p>Candidate not found. <a href="/app">Back to dashboard</a></p>', 404);
  }
  
  const spec = specs.find((s) => getId(s) === getSpecId(candidate));
  const repo = repos.find((r) => getId(r) === getRepositoryId(candidate));
  const repoHierarchicalUrl = repo ? buildRepoUrl(repo, orgs) : null;
  
  const candidateTrials = trialsList.filter((t) => {
    const a = pick(t, 'candidate_a_id', 'candidateAId');
    const b = pick(t, 'candidate_b_id', 'candidateBId');
    return getId(candidate) === a || getId(candidate) === b;
  });
  
  const candidatePromotions = promotionsList.filter(
    (p) => pick(p, 'candidate_id', 'candidateId') === getId(candidate)
  );
  
  const gateVerdicts = Array.isArray(verdicts) ? (verdicts as any[]) : [];
  
  const searchableEntities = [
    spec ? { kind: 'spec' as const, id: getId(spec), name: getName(spec), description: getDescription(spec) || undefined } : null,
    repo ? { kind: 'repo' as const, id: getId(repo), name: getName(repo), description: getDescription(repo) || undefined } : null,
  ].filter(Boolean) as any[];
  
  const query = url.searchParams.get('q') || '';
  const searchResults = semanticSearch(query, searchableEntities, id, Date.now());
  
  const changelogEntities = [
    toChangelogEntity('candidate', candidate),
    ...candidateTrials.map((t) => toChangelogEntity('trial', t)),
    ...candidatePromotions.map((p) => toChangelogEntity('promotion', p)),
  ];
  const changelog = semanticChangelog(changelogEntities, id, Date.now());
  
  let contractDisplay = '';
  if (spec) {
    try {
      const contract = getContract(spec);
      if (contract) {
        const parsed = JSON.parse(contract);
        contractDisplay = `<pre class="contract-display">${esc(JSON.stringify(parsed, null, 2))}</pre>`;
      }
    } catch {
      contractDisplay = `<pre class="contract-display">${esc(getContract(spec))}</pre>`;
    }
  }
  
  const verdictRows = gateVerdicts.map((v: any) => [
    esc(pick(v, 'gate_name', 'gateName') || getId(v)),
    badge(pick(v, 'status', 'verdictStatus') || '', pick(v, 'status', 'verdictStatus') || ''),
    esc(formatDate(pick(v, 'decided_at', 'decidedAt'))),
  ]);
  
  const trialRows = candidateTrials.map((t) => {
    const otherId = pick(t, 'candidate_a_id', 'candidateAId') === getId(candidate) 
      ? pick(t, 'candidate_b_id', 'candidateBId') 
      : pick(t, 'candidate_a_id', 'candidateAId');
    const isWinner = pick(t, 'winner_candidate_id', 'winnerCandidateId') === getId(candidate);
    return [
      `<a href="/app/trials/${esc(encodeURIComponent(getId(t)))}">${esc(getId(t).slice(0, 8))}</a>`,
      `<a href="/app/candidates/${esc(encodeURIComponent(otherId || ''))}">${esc((otherId || '').slice(0, 8))}</a>`,
      esc(isWinner ? 'Winner' : pick(t, 'winner_candidate_id', 'winnerCandidateId') ? 'Loser' : 'Pending'),
      esc(formatDate(getCreatedAt(t))),
    ];
  });
  
  const promoRows = candidatePromotions.map((p) => {
    const promoId = getId(p);
    return [
      `<a href="#promotion-${esc(promoId)}">${esc(promoId.slice(0, 8))}</a>`,
      esc(pick(p, 'stage', 'promotionStage') || getStage(p) || ''),
      esc(formatDate(getCreatedAt(p))),
    ];
  });
  
  const promoDetails = candidatePromotions.map((p) => {
    const promoId = getId(p);
    return `
      <div id="promotion-${esc(promoId)}" style="margin: 24px 0; padding: 16px; background: #161b22; border-radius: 6px; border: 1px solid #30363d;">
        <h3>Promotion ${esc(promoId.slice(0, 8))}</h3>
        <dl>
          <dt>Stage</dt><dd>${esc(pick(p, 'stage', 'promotionStage') || getStage(p) || '')}</dd>
          <dt>Created</dt><dd>${esc(formatDate(getCreatedAt(p)))}</dd>
        </dl>
      </div>
    `;
  }).join('');
  
  const body = `
    ${subHeader(`Candidate ${getId(candidate).slice(0, 8)}`, '/app', 'All candidates')}
    
    <section class="details-section">
      <h3>Details</h3>
      <dl>
        <dt>ID</dt><dd>${esc(getId(candidate))}</dd>
        <dt>Spec</dt><dd>${spec ? `<a href="/app/specs/${esc(encodeURIComponent(getId(spec)))}">${esc(getName(spec))}</a>` : 'N/A'}</dd>
        <dt>Repository</dt><dd>${repo ? `<a href="${repoHierarchicalUrl}">${esc(getName(repo))}</a>` : 'N/A'}</dd>
        <dt>Stage</dt><dd>${stageBadge(getStage(candidate))}</dd>
        <dt>Commit SHA</dt><dd style="font-family:monospace;">${esc(pick(candidate, 'commit_sha', 'commitSha') || '')}</dd>
        <dt>Base Commit SHA</dt><dd style="font-family:monospace;">${esc(pick(candidate, 'base_commit_sha', 'baseCommitSha') || '')}</dd>
        <dt>Agent</dt><dd>${esc(pick(candidate, 'agent_id', 'agentId') || '')}</dd>
        <dt>Created</dt><dd>${esc(formatDate(getCreatedAt(candidate)))}</dd>
        <dt>Preview URL</dt><dd>${esc(getRemoteUrl(candidate))}</dd>
      </dl>
    </section>
    
    <section>
      <h2>Contract (from spec)</h2>
      ${contractDisplay || '<p class="empty">No spec linked</p>'}
    </section>
    
    <section>
      <h2>Gate Verdicts (${gateVerdicts.length})</h2>
      ${tableHtml(['Gate', 'Status', 'Decided'], verdictRows)}
    </section>
    
    <section>
      <h2>Trials (${candidateTrials.length})</h2>
      ${tableHtml(['Trial ID', 'Opponent', 'Result', 'Created'], trialRows)}
    </section>
    
    <section>
      <h2>Promotions (${candidatePromotions.length})</h2>
      ${tableHtml(['Promotion ID', 'Stage', 'Promoted at'], promoRows)}
      ${promoDetails}
    </section>
    
    <section class="search-box">
      <h2>Search</h2>
      <form method="GET" action="/app/candidates/${esc(encodeURIComponent(id))}">
        <input type="search" name="q" value="${esc(query)}" placeholder="Search for this candidate...">
        <button type="submit">Search</button>
      </form>
      ${renderSearch(searchResults)}
    </section>
    
    <section>
      <h2>Recent Activity</h2>
      ${renderChangelog(changelog)}
    </section>
  `;
  
  return page(`Candidate ${getId(candidate).slice(0, 8)}`, body);
}

// ============================================================================
// Trial Page
// ============================================================================

/**
 * Render trial detail page.
 */
export async function trialPage(
  id: string,
  url: URL,
  session: Session,
  doReader: DoReader
): Promise<Response> {
  if (!isValidId(id)) {
    return page('Not found', '<p>Invalid trial ID.</p>', 404);
  }
  
  const [trial, specs, candidates, promotionsList] = await Promise.all([
    doReader.get(`/api/trials/${encodeURIComponent(id)}`),
    doReader.list('/api/specs', 500),
    doReader.list('/api/candidates', 500),
    doReader.list('/api/promotions', 500),
  ]);
  
  if (!trial) {
    return page('Not found', '<p>Trial not found. <a href="/app">Back to dashboard</a></p>', 404);
  }
  
  const candidateA = candidates.find((c) => getId(c) === pick(trial, 'candidate_a_id', 'candidateAId'));
  const candidateB = candidates.find((c) => getId(c) === pick(trial, 'candidate_b_id', 'candidateBId'));
  const winner = candidates.find((c) => getId(c) === pick(trial, 'winner_candidate_id', 'winnerCandidateId'));
  
  const specA = candidateA ? specs.find((s) => getId(s) === getSpecId(candidateA)) : undefined;
  const specB = candidateB ? specs.find((s) => getId(s) === getSpecId(candidateB)) : undefined;
  
  const winnerPromotions = winner
    ? promotionsList.filter((p) => pick(p, 'candidate_id', 'candidateId') === getId(winner))
    : [];
  
  let metricsDisplay = '';
  try {
    const metrics = pick(trial, 'comparison_metrics', 'comparisonMetrics');
    if (metrics && typeof metrics === 'string') {
      const parsed = JSON.parse(metrics);
      metricsDisplay = `<pre class="contract-display">${esc(JSON.stringify(parsed, null, 2))}</pre>`;
    }
  } catch {
    metricsDisplay = `<pre class="contract-display">${esc(str(pick(trial, 'comparison_metrics', 'comparisonMetrics')))}</pre>`;
  }
  
  const searchableEntities = [];
  if (candidateA) {
    searchableEntities.push({ kind: 'candidate' as const, id: getId(candidateA), name: getId(candidateA), description: specA ? getName(specA) : undefined });
  }
  if (candidateB) {
    searchableEntities.push({ kind: 'candidate' as const, id: getId(candidateB), name: getId(candidateB), description: specB ? getName(specB) : undefined });
  }
  
  const query = url.searchParams.get('q') || '';
  const searchResults = semanticSearch(query, searchableEntities, id, Date.now());
  
  const changelogEntities = [toChangelogEntity('trial', trial)];
  const changelog = semanticChangelog(changelogEntities, id, Date.now());
  
  const idSlice = (c: DoRow | undefined) => c ? getId(c).slice(0, 8) : 'N/A';
  
  const body = `
    ${subHeader(`Trial ${getId(trial).slice(0, 8)}`, '/app', 'All trials')}
    
    <section class="details-section">
      <h3>Details</h3>
      <dl>
        <dt>ID</dt><dd>${esc(getId(trial))}</dd>
        <dt>Candidate A</dt><dd>${candidateA ? `<a href="/app/candidates/${esc(encodeURIComponent(getId(candidateA)))}">${esc(idSlice(candidateA))}</a>` : 'N/A'}</dd>
        <dt>Candidate B</dt><dd>${candidateB ? `<a href="/app/candidates/${esc(encodeURIComponent(getId(candidateB)))}">${esc(idSlice(candidateB))}</a>` : 'N/A'}</dd>
        <dt>Winner</dt><dd>${winner ? `<a href="/app/candidates/${esc(encodeURIComponent(getId(winner)))}">${esc(idSlice(winner))}</a>` : 'Pending'}</dd>
        <dt>Decision</dt><dd>${esc(pick(trial, 'decision', 'trialDecision') || '')}</dd>
        <dt>Created</dt><dd>${esc(formatDate(getCreatedAt(trial)))}</dd>
      </dl>
    </section>
    
    <section>
      <h2>Comparison Metrics</h2>
      ${metricsDisplay || '<p class="empty">No metrics recorded</p>'}
    </section>
    
    ${winner ? `
    <section>
      <h2>Winner Promotions</h2>
      ${winnerPromotions.length > 0 ? winnerPromotions.map((p) => {
        const pId = getId(p);
        return `<p><a href="/app/candidates/${esc(encodeURIComponent(getId(winner)))}}#promotion-${esc(pId)}">Promotion ${esc(pId.slice(0, 8))}</a> (${esc(pick(p, 'stage', 'promotionStage') || getStage(p) || '')}) - ${esc(formatDate(getCreatedAt(p)))}</p>`;
      }).join('') : '<p class="empty">No promotions for winner yet</p>'}
    </section>
    ` : ''}
    
    <section class="search-box">
      <h2>Search</h2>
      <form method="GET" action="/app/trials/${esc(encodeURIComponent(id))}">
        <input type="search" name="q" value="${esc(query)}" placeholder="Search for this trial...">
        <button type="submit">Search</button>
      </form>
      ${renderSearch(searchResults)}
    </section>
    
    <section>
      <h2>Recent Activity</h2>
      ${renderChangelog(changelog)}
    </section>
  `;
  
  return page(`Trial ${getId(trial).slice(0, 8)}`, body);
}

// ============================================================================
// Issue Pages (Repo-level, like GitHub)
// ============================================================================

/**
 * Helper to get issue-specific fields from a row.
 */
function getIssueNumber(row: DoRow): string {
  return str(pick(row, 'number'));
}

function getIssueTitle(row: DoRow): string {
  return str(pick(row, 'title'));
}

function getIssueBody(row: DoRow): string {
  return str(pick(row, 'body'));
}

function getIssueStatus(row: DoRow): string {
  return str(pick(row, 'status'));
}

function getIssueStage(row: DoRow): string {
  return str(pick(row, 'stage'));
}

function getIssueLabels(row: DoRow): string[] {
  const labels = pick(row, 'labels');
  if (!labels) return [];
  if (Array.isArray(labels)) return labels.map(str);
  if (typeof labels === 'string') return labels.split(',').map((s) => str(s).trim()).filter(Boolean);
  return [];
}

function getIssueCommentPolicy(row: DoRow): string {
  return str(pick(row, 'comment_policy', 'commentPolicy'));
}

function getIssueVisibility(row: DoRow): string {
  return str(pick(row, 'visibility'));
}

function getClosedAt(row: DoRow): number | undefined {
  const val = row.closed_at ?? row.closedAt;
  return typeof val === 'number' ? val : undefined;
}

function getClosedBy(row: DoRow): string {
  return str(pick(row, 'closed_by', 'closedBy'));
}

/**
 * Render a single issue row for a table.
 */
function renderIssueRow(issue: DoRow, repoId?: string): string[] {
  const issueId = getId(issue);
  const repoIdFromIssue = getRepositoryId(issue);
  const displayRepoId = repoId || repoIdFromIssue;
  
  return [
    `<a href="/app/repos/${esc(encodeURIComponent(displayRepoId))}/issues/${esc(encodeURIComponent(issueId))}">#${esc(getIssueNumber(issue))}: ${esc(getIssueTitle(issue))}</a>`,
    visibilityBadge(getIssueVisibility(issue) || 'public'),
    stageBadge(getIssueStage(issue)),
    getIssueLabels(issue).map((l) => `<span class="label">${esc(l)}</span>`).join(''),
    esc(formatDate(getCreatedAt(issue))),
  ];
}

/**
 * List issues for a repository.
 */
export async function repoIssuesPage(
  repoId: string,
  url: URL,
  session: Session,
  doReader: DoReader
): Promise<Response> {
  if (!isValidId(repoId)) {
    return page('Not found', '<p>Invalid repository ID.</p>', 404);
  }
  
  const [repo, issues, orgs, specs] = await Promise.all([
    doReader.get(`/api/repositories/${encodeURIComponent(repoId)}`),
    doReader.list('/api/issues', 500),
    doReader.list('/api/organizations', 500),
    doReader.list('/api/specs', 500),
  ]);
  
  if (!repo) {
    return page('Not found', '<p>Repository not found. <a href="/app">Back to dashboard</a></p>', 404);
  }
  
  // Filter issues for this repo
  const repoIssues = issues.filter((i) => getRepositoryId(i) === repoId);
  const publicIssues = repoIssues.filter((i) => {
    const visibility = getIssueVisibility(i);
    return !visibility || visibility === 'public' || visibility === 'internal';
  });
  
  // Build repo URL for navigation
  const orgId = getOrganizationId(repo);
  const org = orgs.find((o) => getId(o) === orgId);
  const repoUrl = org ? buildRepoUrl(repo, orgs) : `/app/repos/${esc(encodeURIComponent(repoId))}`;
  
  // Get spec for this repo if any
  const spec = specs.find((s) => getRepositoryId(s) === repoId);
  
  const issueRows = publicIssues.map((i) => renderIssueRow(i, repoId));
  
  const notice = url.searchParams.get('ok');
  
  const body = `
    ${subHeader(`Issues for ${esc(getName(repo))}`, repoUrl)}
    
    ${notice ? `<p class="flash ok">${esc(notice)}</p>` : ''}
    
    <section class="action-bar">
      <a href="${repoUrl}/issues/new" class="button">New Issue</a>
    </section>
    
    <section>
      <h2>Issues (${publicIssues.length} of ${repoIssues.length} total)</h2>
      ${publicIssues.length > 0 ? tableHtml(
        ['Issue', 'Visibility', 'Stage', 'Labels', 'Created'],
        issueRows
      ) : '<p class="empty">No issues found. <a href="' + repoUrl + '/issues/new">Create one</a></p>'}
    </section>
    
    ${spec ? `
    <section>
      <h2>Linked Spec</h2>
      <p><a href="/app/specs/${esc(encodeURIComponent(getId(spec)))}">${esc(getName(spec))}</a> (${esc(getStage(spec))})</p>
    </section>
    ` : ''}
    
    <p><a href="${repoUrl}">Back to repository</a></p>
  `;
  
  return page(`Issues - ${getName(repo)}`, body);
}

/**
 * Form to create a new issue for a repository.
 */
export async function newIssuePage(
  repoId: string,
  url: URL,
  session: Session,
  doReader: DoReader
): Promise<Response> {
  if (!isValidId(repoId)) {
    return page('Not found', '<p>Invalid repository ID.</p>', 404);
  }
  
  const [repo, orgs] = await Promise.all([
    doReader.get(`/api/repositories/${encodeURIComponent(repoId)}`),
    doReader.list('/api/organizations', 500),
  ]);
  
  if (!repo) {
    return page('Not found', '<p>Repository not found. <a href="/app">Back to dashboard</a></p>', 404);
  }
  
  // Build repo URL
  const orgId = getOrganizationId(repo);
  const org = orgs.find((o) => getId(o) === orgId);
  const repoUrl = org ? buildRepoUrl(repo, orgs) : `/app/repos/${esc(encodeURIComponent(repoId))}`;
  
  const error = url.searchParams.get('error');
  
  const body = `
    ${subHeader(`New Issue for ${esc(getName(repo))}`, repoUrl)}
    
    ${error ? `<p class="flash err">${esc(error)}</p>` : ''}
    
    <form method="POST" action="${repoUrl}/issues" class="stack">
      <div class="form-group">
        <label for="title">Title *</label>
        <input type="text" id="title" name="title" placeholder="Brief description of the issue" required>
      </div>
      
      <div class="form-group">
        <label for="body">Description</label>
        <textarea id="body" name="body" rows="10" placeholder="Detailed description..."></textarea>
      </div>
      
      <div class="form-group">
        <label for="labels">Labels (comma-separated)</label>
        <input type="text" id="labels" name="labels" placeholder="bug, enhancement, documentation">
      </div>
      
      <div class="form-actions">
        <button type="submit" class="button primary">Create Issue</button>
        <a href="${repoUrl}/issues" class="button">Cancel</a>
      </div>
    </form>
    
    <p><a href="${repoUrl}">Back to repository</a></p>
  `;
  
  return page(`New Issue - ${getName(repo)}`, body);
}

/**
 * View a single issue.
 */
export async function issuePage(
  issueId: string,
  url: URL,
  session: Session,
  doReader: DoReader
): Promise<Response> {
  if (!isValidId(issueId)) {
    return page('Not found', '<p>Invalid issue ID.</p>', 404);
  }
  
  return withDoReaderErrorHandling(async () => {
    const [issue, repos, orgs, comments] = await Promise.all([
      doReader.get(`/api/issues/${encodeURIComponent(issueId)}`),
      doReader.list('/api/repositories', 500),
      doReader.list('/api/organizations', 500),
      doReader.list(`/api/issues/${encodeURIComponent(issueId)}/comments`, 500),
    ]);
    
    if (!issue) {
      return page('Not found', '<p>Issue not found. <a href="/app">Back to dashboard</a></p>', 404);
    }
    
    // Find the repo this issue belongs to
    const repoId = getRepositoryId(issue);
    const repo = repos.find((r) => getId(r) === repoId);
    const orgId = repo ? getOrganizationId(repo) : undefined;
    const org = orgId ? orgs.find((o) => getId(o) === orgId) : undefined;
    
    // Get comments for this issue (already filtered by issue_id from the route)
    const issueComments = comments;
    
    // Get spec for this repo if any
    const specs = await doReader.list('/api/specs', 500);
    const spec = specs.find((s) => getRepositoryId(s) === repoId);
    
    // Build repo URL
    const repoUrl = repo ? (org ? buildRepoUrl(repo, orgs) : `/app/repos/${esc(encodeURIComponent(repoId))}`) : null;
    
    const labels = getIssueLabels(issue);
    const isOpen = getIssueStatus(issue) === 'open';
    
    const body = `
      ${repoUrl ? subHeader(`Issue #${getIssueNumber(issue)}: ${esc(getIssueTitle(issue))}`, repoUrl + '/issues') : `<h1>Issue #${getIssueNumber(issue)}: ${esc(getIssueTitle(issue))}</h1>`}
      
      <section class="details-section">
        <dl>
          <dt>Status</dt><dd>${isOpen ? '<span class="badge open">Open</span>' : '<span class="badge closed">Closed</span>'}</dd>
          <dt>Stage</dt><dd>${stageBadge(getIssueStage(issue))}</dd>
          <dt>Visibility</dt><dd>${visibilityBadge(getIssueVisibility(issue) || 'public')}</dd>
          <dt>Labels</dt><dd>${labels.length > 0 ? labels.map((l) => `<span class="label">${esc(l)}</span>`).join('') : '<span class="empty">none</span>'}</dd>
          <dt>Repository</dt><dd>${repo ? `<a href="${esc(repoUrl || '')}">${esc(getName(repo))}</a>` : esc(repoId || 'Unknown')}</dd>
          ${spec ? `<dt>Spec</dt><dd><a href="/app/specs/${esc(encodeURIComponent(getId(spec)))}">${esc(getName(spec))}</a></dd>` : ''}
          <dt>Created</dt><dd>${esc(formatDate(getCreatedAt(issue)))} by ${esc(getName(issue) || getId(issue))}</dt>
          ${getClosedAt(issue) ? `<dt>Closed</dt><dd>${esc(formatDate(getClosedAt(issue)))} by ${esc(getClosedBy(issue))}</dd>` : ''}
        </dl>
      </section>
      
      ${getIssueBody(issue) ? `
      <section>
        <h2>Description</h2>
        <div class="markdown">${esc(getIssueBody(issue))}</div>
      </section>
      ` : ''}
      
      <section>
        <h2>Comments (${issueComments.length})</h2>
        ${issueComments.length > 0 ? `
          <div class="comments">
            ${issueComments.map((c) => {
              const commentBody = esc(str(pick(c, 'body')));
              const commentCreatedAt = formatDate(getCreatedAt(c));
              const commentCreatedBy = esc(str(pick(c, 'created_by', 'createdBy')) || getId(c));
              return `
                <article class="comment">
                  <header>
                    <span class="comment-author">${commentCreatedBy}</span>
                    <span class="comment-date">${commentCreatedAt}</span>
                  </header>
                  <div class="comment-body">${commentBody}</div>
                </article>
              `;
            }).join('')}
          </div>
        ` : '<p class="empty">No comments yet</p>'}
        
        ${isOpen ? `
          <form method="POST" action="/app/issue_comments" class="comment-form">
            <input type="hidden" name="issueId" value="${esc(issueId)}">
            <textarea name="body" placeholder="Add a comment..." rows="4" required></textarea>
            <button type="submit">Comment</button>
          </form>
        ` : ''}
      </section>
      
      <p><a href="${repoUrl ? repoUrl + '/issues' : '/app'}">Back to issues</a></p>
    `;
    
    return page(`Issue #${getIssueNumber(issue)} - ${getIssueTitle(issue)}`, body);
  });
}

