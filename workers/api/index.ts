/**
 * Beehive Edge Router
 * 
 * REST API entry point. Routes requests to the appropriate Durable Object
 * or handles directly for read-only operations.
 * 
 * This is the orchestration spine - hand-written, not agent-generated.
 */


interface Env {
  SPEC_DO: DurableObjectNamespace;
  // Spec DO tokens (workers/shared/spec-do-auth.ts); this is the only worker holding the admin token
  SPEC_DO_INTERNAL_TOKEN?: string;
  SPEC_DO_ADMIN_TOKEN?: string;
  API_AUTH_TOKEN?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  ALLOWED_GITHUB_USERS?: string;
  // wrangler.toml [[analytics_engine_datasets]]; optional so a missing binding never fails a request
  ANALYTICS?: AnalyticsEngineDataset;
}

import { authenticate, authorize, withAuth, withActor, type ActorRequest } from '../shared/principal';
import { handleServiceAccountRoutes } from './service-accounts';
import { handleUserTokenRoutes } from './user-tokens';
import { handleLifecycleRoutes } from './lifecycle';
import { handleUi } from './ui';


// Import types for JSDoc
import type {
  ApiResponse,
  PaginatedResponse,
  CreateOrganizationRequest,
  OrganizationResponse,
  CreateActorRequest,
  ActorResponse,
  UpdateActorTrustRequest,
  CreateRepositoryRequest,
  RepositoryResponse,
  CreateSpecRequest,
  SpecResponse,
  UpdateSpecStageRequest,
  CreateCandidateRequest,
  CandidateResponse,
  UpdateCandidateStageRequest,
  CreateGateVerdictRequest,
  GateVerdictResponse,
  CreateTrialRequest,
  TrialResponse,
  DecideTrialRequest,
  CreatePromotionRequest,
  PromotionResponse,
  CreateIssueRequest,
  IssueResponse,
  UpdateIssueStageRequest,
  UpdateIssueCommentPolicyRequest,
  CreateIssueCommentRequest,
  IssueCommentResponse,
  CreateIssueSpecLinkRequest,
  IssueSpecLinkResponse,
  CreateIssueCandidateLinkRequest,
  IssueCandidateLinkResponse,
  EntityHistoryResponse,
  GetHistoryRequest,
  ListFilter,
  HealthResponse,
} from './types';
import { getSpecDoStub, maintainerCappedStub, type SpecDoStub } from '../shared/spec-do-auth';

// Helper to generate ID for Spec DO lookup
const DEFAULT_SPEC_DO_NAME = 'main';

export { SpecDO } from '../spec-do/index';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Public endpoints - no auth required
    if (path === '/' || path === '/about' || path === '/roadmap') {
      return handlePublicPage(path);
    }

    // Browser UI: GitHub login + management pages (own session auth, not the bearer token)
    const uiResponse = await handleUi(
      request,
      env,
      getSpecDoStub(env, DEFAULT_SPEC_DO_NAME)
    );
    if (uiResponse) return uiResponse;

    // Auth - fail closed, applies to every other route including /health.
    // Master token keeps full access; service tokens are read-only; user tokens write through
    // an allow-list (deny by default, workers/api/principal.ts).
    const authStub = getSpecDoStub(env, DEFAULT_SPEC_DO_NAME);
    const principal = await authenticate(request, env, authStub);
    if (principal instanceof Response) return principal;
    const forbidden = authorize(principal, method, path);
    if (forbidden) return forbidden;
    if (principal.kind === 'master') {
      logMasterActorAssertion(request, url, env);
    } else {
      // Never trust a client-supplied actor (service and user tokens): rewrite before any handler reads it.
      const headers = new Headers(request.headers);
      headers.set('X-Actor-ID', principal.actorId);
      request = new Request(request, { headers });

    // Wrap request with auth context for compile-time safety
    const authedRequest = withAuth(request, principal);
    const actorRequest = withActor(authedRequest, principal);
    if (actorRequest instanceof Response) return actorRequest;

    }
    // Maintainer cap (M12): a user token without the maintainer scope never exercises its actor's
    // maintainer role. Wrapped once, here; only this stub is used below (handlers build fresh
    // headers, so the stub is the one place that reaches every DO request).
    const specDoStub =
      principal.kind === 'user' && !principal.scopes.includes('maintainer') ? maintainerCappedStub(authStub) : authStub;

    const adminResponse = await handleServiceAccountRoutes(request, path, principal, specDoStub);
    if (adminResponse) return adminResponse;

    const userTokenResponse = await handleUserTokenRoutes(request, path, principal, specDoStub);
    if (userTokenResponse) return userTokenResponse;

    // Ledger lifecycle: tombstones, purge, maintainer role, ?include_deleted=1 reads
    const lifecycleResponse = await handleLifecycleRoutes(request, url, principal, specDoStub);
    if (lifecycleResponse) return lifecycleResponse;

    // Health check
    if (path === '/health' || path === '/api/health') {
      return handleHealth(request, specDoStub);
    }

    // ============================================================================
    // ORGANIZATIONS
    // ============================================================================

    if (path === '/api/organizations' && method === 'POST') {
      return handleCreateOrganization(request, specDoStub);
    }
    if (path === '/api/organizations' && method === 'GET') {
      return handleListOrganizations(request, specDoStub);
    }
    if (path.match(/^\/api\/organizations\/[^\/]+$/) && method === 'GET') {
      return handleGetOrganization(request, specDoStub);
    }

    // ============================================================================
    // ACTORS
    // ============================================================================

    if (path === '/api/actors' && method === 'POST') {
      return handleCreateActor(request, specDoStub);
    }
    if (path === '/api/actors' && method === 'GET') {
      return handleListActors(request, specDoStub);
    }
    if (path.match(/^\/api\/actors\/[^\/]+$/) && method === 'GET') {
      return handleGetActor(request, specDoStub);
    }
    if (path.match(/^\/api\/actors\/[^\/]+\/trust$/) && method === 'PATCH') {
      return handleUpdateActorTrust(request, specDoStub);
    }
    if (path.match(/^\/api\/actors\/[^\/]+\/promotion-authority$/) && method === 'PATCH') {
      return handleGrantPromotionAuthority(request, specDoStub);
    }

    // ============================================================================
    // REPOSITORIES
    // ============================================================================

    if (path === '/api/repositories' && method === 'POST') {
      return handleCreateRepository(request, specDoStub);
    }
    if (path === '/api/repositories' && method === 'GET') {
      return handleListRepositories(request, specDoStub);
    }
    if (path.match(/^\/api\/repositories\/[^\/]+$/) && method === 'GET') {
      return handleGetRepository(request, specDoStub);
    }

    // ============================================================================
    // SPECS
    // ============================================================================

    if (path === '/api/specs' && method === 'POST') {
      return handleCreateSpec(request, specDoStub);
    }
    if (path === '/api/specs' && method === 'GET') {
      return handleListSpecs(request, specDoStub);
    }
    if (path.match(/^\/api\/specs\/[^\/]+$/) && method === 'GET') {
      return handleGetSpec(request, specDoStub);
    }
    if (path.match(/^\/api\/specs\/[^\/]+\/stage$/) && method === 'PATCH') {
      return handleUpdateSpecStage(request, specDoStub);
    }
    if (path.match(/^\/api\/specs\/[^\/]+\/claim$/) && method === 'POST') {
      return handleClaimSpec(request, specDoStub);
    }

    // ============================================================================
    // CANDIDATES
    // ============================================================================

    if (path === '/api/candidates' && method === 'POST') {
      return handleCreateCandidate(request, specDoStub);
    }
    if (path === '/api/candidates' && method === 'GET') {
      return handleListCandidates(request, specDoStub);
    }
    if (path.match(/^\/api\/candidates\/[^\/]+$/) && method === 'GET') {
      return handleGetCandidate(request, specDoStub);
    }
    if (path.match(/^\/api\/candidates\/[^\/]+\/stage$/) && method === 'PATCH') {
      return handleUpdateCandidateStage(request, specDoStub);
    }

    // ============================================================================
    // GATE VERDICTS
    // ============================================================================

    if (path === '/api/gate-verdicts' && method === 'POST') {
      return handleCreateGateVerdict(request, specDoStub);
    }
    if (path === '/api/gate-verdicts' && method === 'GET') {
      return handleListGateVerdicts(request, specDoStub);
    }
    if (path.match(/^\/api\/candidates\/[^\/]+\/gate-verdicts$/) && method === 'GET') {
      return handleGetGateVerdictsForCandidate(request, specDoStub);
    }

    // ============================================================================
    // GATE WORKFLOW
    // ============================================================================

    // POST /api/candidates/:id/gate/pre-merge - Run pre-merge gate
    if (path.match(/^\/api\/candidates\/[^\/]+\/gate\/pre-merge$/) && method === 'POST') {
      return handleRunPreMergeGate(request, specDoStub);
    }

    // GET /api/gate-verdicts/:id - Get gate verdict
    if (path.match(/^\/api\/gate-verdicts\/[^\/]+$/) && method === 'GET') {
      return handleGetGateVerdict(request, specDoStub);
    }

    // ============================================================================
    // TRIALS
    // ============================================================================

    if (path === '/api/trials' && method === 'POST') {
      return handleCreateTrial(request, specDoStub);
    }
    if (path === '/api/trials' && method === 'GET') {
      return handleListTrials(request, specDoStub);
    }
    if (path.match(/^\/api\/trials\/[^\/]+$/) && method === 'GET') {
      return handleGetTrial(request, specDoStub);
    }
    if (path.match(/^\/api\/trials\/[^\/]+\/decide$/) && method === 'POST') {
      return handleDecideTrial(request, specDoStub);
    }

    // ============================================================================
    // PROMOTIONS
    // ============================================================================

    if (path === '/api/promotions' && method === 'POST') {
      return handleCreatePromotion(request, specDoStub);
    }
    if (path === '/api/promotions' && method === 'GET') {
      return handleListPromotions(request, specDoStub);
    }

    // ============================================================================
    // ISSUES
    // ============================================================================

    if (path === '/api/issues' && method === 'POST') {
      return handleCreateIssue(request, specDoStub);
    }
    if (path === '/api/issues' && method === 'GET') {
      return handleListIssues(request, specDoStub);
    }
    if (path.match(/^\/api\/issues\/[^\/]+$/) && method === 'GET') {
      return handleGetIssue(request, specDoStub);
    }
    if (path.match(/^\/api\/issues\/[^\/]+\/stage$/) && method === 'PATCH') {
      return handleUpdateIssueStage(request, specDoStub);
    }
    if (path.match(/^\/api\/issues\/[^\/]+\/status$/) && method === 'PATCH') {
      return handleUpdateIssueStatus(request, specDoStub);
    }
    if (path.match(/^\/api\/issues\/[^\/]+\/comment-policy$/) && method === 'PATCH') {
      return handleUpdateIssueCommentPolicy(request, specDoStub);
    }

    // ============================================================================
    // ISSUE COMMENTS
    // ============================================================================

    if (path.match(/^\/api\/issues\/[^\/]+\/comments$/) && method === 'POST') {
      return handleCreateIssueComment(request, specDoStub);
    }
    if (path.match(/^\/api\/issues\/[^\/]+\/comments$/) && method === 'GET') {
      return handleListIssueComments(request, specDoStub);
    }

    // ============================================================================
    // LINKS
    // ============================================================================

    if (path === '/api/issue-spec-links' && method === 'POST') {
      return handleCreateIssueSpecLink(request, specDoStub);
    }
    if (path === '/api/issue-candidate-links' && method === 'POST') {
      return handleCreateIssueCandidateLink(request, specDoStub);
    }

    // ============================================================================
    // SERVICE ACCOUNTS
    // ============================================================================

    // Retired: the pre-m6 token scheme (hash on the account row). Its list exposed
    // token_hash/token_salt to any read principal. Use /api/admin/service-accounts.
    if (path === '/api/service-accounts' || path.startsWith('/api/service-accounts/')) {
      return new Response(
        JSON.stringify({ success: false, error: 'Gone: use /api/admin/service-accounts (master token)', timestamp: Date.now() }),
        { status: 410, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // ============================================================================
    // HISTORY
    // ============================================================================

    if (path.match(/^\/api\/entities\/[^\/]+\/[^\/]+\/history$/) && method === 'GET') {
      return handleGetEntityHistory(request, specDoStub);
    }

    // ============================================================================
    // SANDBOX INTEGRATION
    // ============================================================================

    // POST /api/candidates/:id/execute - Execute candidate in sandbox
    if (path.match(/^\/api\/candidates\/[^\/]+\/execute$/) && method === 'POST') {
      return handleExecuteCandidate(request, specDoStub);
    }

    // ============================================================================
    // 404
    // ============================================================================

    return new Response(
      JSON.stringify({
        success: false,
        error: 'Not found',
        timestamp: Date.now(),
      }),
      { status: 404, headers: { 'Content-Type': 'application/json' } }
    );
  },
} satisfies ExportedHandler<Env>;

// Type definition
type ExportedHandler<E = unknown> = {
  fetch: (request: Request, env: E, ctx: ExecutionContext) => Promise<Response>;
};

// ============================================================================
// HANDLER IMPLEMENTATIONS
// ============================================================================

// Always take the pathname only: a query string must never influence resource IDs.
function pathnameOf(urlOrPath: string): string {
  return urlOrPath.split(/[?#]/)[0];
}

function extractId(urlOrPath: string): string {
  const path = pathnameOf(urlOrPath);
  const match = path.match(/\/[^\/]+$/);
  return match ? match[0].substring(1) : '';
}

function extractParentId(urlOrPath: string): string {
  const path = pathnameOf(urlOrPath);
  const parts = path.split('/');
  return parts[parts.length - 2];
}

// ============================================================================
// MASTER TOKEN STAGE 1 (RFC-0008 section 5): log, change nothing
// ============================================================================

const MAX_LOGGED_ACTOR_CHARS = 128;

/** url.pathname with every segment that is not a lowercase word replaced by ':id' (ids stay out of the AE blob) */
function pathClass(pathname: string): string {
  return pathname
    .split('/')
    .map((s) => (s === '' || /^[a-z][a-z-]*$/.test(s) ? s : ':id'))
    .join('/')
    .slice(0, 256);
}

/**
 * One Workers Logs line and one Analytics Engine point per master request that names an actor
 * (the evidence for the stage-2 decision; Workers Logs keep 7 days, AE longer). Fields: method,
 * pathname, the client's X-Actor-ID (truncated: it is client-controlled) and cf-ray. Never the
 * query string, other headers, the body or any token. Never fails the request.
 */
function logMasterActorAssertion(request: Request, url: URL, env: Env): void {
  const asserted = request.headers.get('X-Actor-ID');
  if (!asserted || asserted === 'unknown') return;
  const actorId = asserted.slice(0, MAX_LOGGED_ACTOR_CHARS);
  console.log(
    JSON.stringify({
      event: 'master_actor_assertion',
      method: request.method,
      path: url.pathname,
      actorId,
      ray: request.headers.get('cf-ray'),
    })
  );
  try {
    env.ANALYTICS?.writeDataPoint({ indexes: ['master_actor_assertion'], blobs: [actorId, request.method, pathClass(url.pathname)] });
  } catch (error) {
    console.error('[master_actor_assertion] Analytics Engine write failed:', error instanceof Error ? error.message : String(error));
  }
}

function makeApiResponse<T>(data: T, status = 200): Response {
  return new Response(
    JSON.stringify({
      success: true,
      data,
      timestamp: Date.now(),
    }),
    { status, headers: { 'Content-Type': 'application/json' } }
  );
}

function makeErrorResponse(error: string, status = 400): Response {
  return new Response(
    JSON.stringify({
      success: false,
      error,
      timestamp: Date.now(),
    }),
    { status, headers: { 'Content-Type': 'application/json' } }
  );
}

async function sendToSpecDo(
  stub: SpecDoStub,
  path: string,
  method: string,
  body?: unknown,
  actorId?: string
): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (actorId) headers['X-Actor-ID'] = actorId;

  const request = new Request(`https://spec-do.internal${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  return stub.fetch(request);
}

// ============================================================================
// PUBLIC PAGES (no auth required)
// ============================================================================

function getRoadmapPage(): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Beehive - Roadmap</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0a;
      color: #e5e5e5;
      line-height: 1.6;
      min-height: 100vh;
    }
    .container { 
      max-width: 1200px; 
      margin: 0 auto; 
      padding: 40px 20px;
    }
    header { 
      margin-bottom: 60px;
      border-bottom: 1px solid #333;
      padding-bottom: 40px;
    }
    h1 { 
      font-size: 2.5rem; 
      margin-bottom: 10px;
      background: linear-gradient(90deg, #ff6b6b, #4ecdc4, #45b7d1);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .subtitle { 
      font-size: 1.2rem; 
      color: #888;
    }
    .section { 
      margin-bottom: 50px;
    }
    .section h2 { 
      font-size: 1.5rem; 
      margin-bottom: 20px;
      color: #fff;
    }
    .section p { 
      margin-bottom: 15px;
      max-width: 700px;
    }
    a { 
      color: #4ecdc4; 
      text-decoration: none;
    }
    a:hover { 
      text-decoration: underline;
    }
    .badge { 
      display: inline-block;
      background: #333;
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 0.85rem;
      margin-right: 10px;
      color: #888;
    }
    .badges { 
      margin: 20px 0;
    }
    .milestone-table { 
      width: 100%;
      border-collapse: collapse;
      margin: 20px 0;
    }
    .milestone-table th, .milestone-table td { 
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid #333;
    }
    .milestone-table th { 
      background: #1a1a1a;
      color: #fff;
    }
    .status {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 0.75rem;
      white-space: nowrap;
    }
    .status.live { background: #12361f; color: #4ade80; }
    .status.complete { background: #12361f; color: #4ade80; }
    .status.partial { background: #3a2f10; color: #facc15; }
    .status.planned { background: #262626; color: #999; }
    .timeline {
      position: relative;
      padding-left: 40px;
      margin: 30px 0;
    }
    .timeline::before {
      content: '';
      position: absolute;
      left: 15px;
      top: 0;
      bottom: 0;
      width: 2px;
      background: #333;
    }
    .timeline-item {
      position: relative;
      padding-left: 30px;
      margin-bottom: 30px;
    }
    .timeline-item::before {
      content: '';
      position: absolute;
      left: -30px;
      top: 5px;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #4ecdc4;
    }
    .timeline-date {
      color: #888;
      font-size: 0.9rem;
      margin-bottom: 5px;
    }
    .timeline-title {
      font-weight: 600;
      color: #fff;
      margin-bottom: 10px;
    }
    .timeline-desc {
      color: #aaa;
      margin-bottom: 10px;
    }
    .timeline-tags {
      font-size: 0.85rem;
    }
    .timeline-tags .badge {
      background: #262626;
      color: #888;
    }
    .lanes {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 16px;
      margin: 20px 0;
    }
    .lane {
      background: #141414;
      border: 1px solid #333;
      border-radius: 8px;
      padding: 16px 20px;
    }
    .lane h3 { margin-bottom: 8px; color: #fff; }
    .lane .example { color: #aaa; font-style: italic; margin-bottom: 10px; }
    footer {
      margin-top: 60px;
      padding-top: 40px;
      border-top: 1px solid #333;
      color: #666;
      font-size: 0.9rem;
    }
    .navbar {
      padding: 15px 0;
      margin-bottom: 20px;
      border-bottom: 1px solid #333;
    }
    .navbar a {
      color: #4ecdc4;
      text-decoration: none;
      margin: 0 10px;
      font-weight: 500;
    }
    .navbar a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="container">
    <nav class="navbar">
      <a href="/about">About</a> | 
      <a href="/roadmap">Roadmap</a> | 
      <a href="/app">App</a> | 
      <a href="/login">Login</a>
    </nav>
    <header>
      <h1>Beehive Roadmap</h1>
      <p class="subtitle">From submission to production and beyond</p>
      <div class="badges">
        <span class="badge">Competition entry submitted</span>
        <span class="badge">Spike, M1, M2 Complete</span>
        <span class="badge">M3 Partial</span>
        <span class="badge">M6 UI Mocked</span>
      </div>
    </header>

    <section class="section">
      <h2>🚀 Milestone Status</h2>
      <p>
        What is implemented and deployed today, and what is still open:
      </p>
      <table class="milestone-table">
        <thead>
          <tr><th>Milestone</th><th>Duration</th><th>Status</th><th>Deliverables</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>Spike</strong></td>
            <td>1 day</td>
            <td><span class="status complete">Complete</span></td>
            <td>3 forks, 3 pushes, 3 events, zero manual steps</td>
          </tr>
          <tr>
            <td><strong>M1 — Spec Trials</strong></td>
            <td>~Oct 10</td>
            <td><span class="status complete">Complete</span></td>
            <td>Spec schema, orchestrator Worker, DO ledger, trial UI, gate Workflow</td>
          </tr>
          <tr>
            <td><strong>M2 — Empirical Oracle</strong></td>
            <td>Oct 12</td>
            <td><span class="status complete">Complete</span></td>
            <td>Workers Builds Previews, Shadow Router, Scientist Comparator, Analytics Engine, Queue infrastructure</td>
          </tr>
          <tr>
            <td><strong>M3 — Promotion Train</strong></td>
            <td>2-3 days</td>
            <td><span class="status partial">Partial</span></td>
            <td>Built: promotion worker (tournament and merge-train modes), canary worker, local traffic-split config. Not built: speculative projection forks, wired canary auto-rollback, DO Facets, capability minting, ArtifactFS</td>
          </tr>
          <tr>
            <td><strong>M6 — Semantic Dashboard UI</strong></td>
            <td>1-2 days</td>
            <td><span class="status partial">Mocked</span></td>
            <td>Semantic search and changelog UI with clearly labelled mock data, repo detail pages, cross-linked navigation</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="section">
      <h2>📍 Current Focus (Post-Submission)</h2>
      <div class="timeline">
        <div class="timeline-item">
          <div class="timeline-date">Now</div>
          <div class="timeline-title">M3 completion and M4 agent autonomy</div>
          <div class="timeline-desc">
            Submission package is in (demo video, MIT license). Open work: wire canary auto-rollback, add speculative projection forks, and the agent-autonomy flow (agent-created issues and specs) for a live end-to-end demo.
          </div>
          <div class="timeline-tags">
            <span class="badge">Priority: High</span>
            <span class="badge">Status: In Progress</span>
          </div>
        </div>
      </div>
    </section>

    <section class="section">
      <h2>🎯 Upcoming Milestones</h2>
      <p>
        Post-submission roadmap for hardening and expansion:
      </p>
      <div class="timeline">
        <div class="timeline-item">
          <div class="timeline-date">Post-Submission</div>
          <div class="timeline-title">M5 — Trust & Governance Layer</div>
          <div class="timeline-desc">
            Issue intake and merge governance as first-class platform mechanics with Varda-inspired enhancements: enriched issue intake with complexity estimates, change-type classification, reporter trust levels, cost attribution, actor trust registry, two-person merge rule, full OCAP model, grain-level versioning and rollback, agent authorization for issue/spec creation, gatekeeper granular controls
          </div>
          <div class="timeline-tags">
            <span class="badge">Priority: High</span>
            <span class="badge">Status: Planned</span>
          </div>
        </div>
        <div class="timeline-item">
          <div class="timeline-date">Post-Submission</div>
          <div class="timeline-title">M6.5 — Semantic Navigation & Change Intelligence</div>
          <div class="timeline-desc">
            Functional semantic layer for codebase navigation and change understanding: metadata indexing, semantic search core, change semantics, navigation graph, UI integration, agent integration. See <a href="https://github.com/bailey-coding/beehive/blob/main/docs/SEMANTIC-NAVIGATION-PLAN.md">full plan</a>.
          </div>
          <div class="timeline-tags">
            <span class="badge">Priority: High</span>
            <span class="badge">Status: Planned</span>
            <span class="badge">6 Phases</span>
            <span class="badge">10-15 days</span>
          </div>
        </div>
        <div class="timeline-item">
          <div class="timeline-date">Post-Submission</div>
          <div class="timeline-title">M7 — Session Provenance &amp; Intent Index</div>
          <div class="timeline-desc">
            Link every candidate and commit to the agent session that produced it: provenance trailer, redacted session records, a cross-spec intent index, and successor handoff from held candidates.
          </div>
          <div class="timeline-tags">
            <span class="badge">Priority: Medium</span>
            <span class="badge">Status: Planned</span>
          </div>
        </div>
        <div class="timeline-item">
          <div class="timeline-date">Future</div>
          <div class="timeline-title">UI Dashboard Phase 4 — Full Semantic Intelligence</div>
          <div class="timeline-desc">
            Replace all mocked semantic features with real semantic processing: actual semantic search, real changelog categorization, impact analysis. See <a href="https://github.com/bailey-coding/beehive/blob/main/docs/UI-DASHBOARD-PLAN.md">UI Dashboard Plan</a>.
          </div>
          <div class="timeline-tags">
            <span class="badge">Priority: Medium</span>
            <span class="badge">Status: Planned</span>
          </div>
        </div>
      </div>
    </section>

    <section class="section">
      <h2>📊 The Oracle Ladder</h2>
      <p>
        Our validation and promotion pipeline. Each candidate must clear all rungs to be promotable:
      </p>
      <table class="milestone-table">
        <thead>
          <tr><th>Rung</th><th>Traffic</th><th>Oracle</th><th>Failure Action</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>Pre-merge</strong></td>
            <td>None</td>
            <td>Tests, property/fuzz, spec conformance</td>
            <td>Never board the train</td>
          </tr>
          <tr>
            <td><strong>Shadow</strong></td>
            <td>Mirrored, discarded</td>
            <td>Scientist diff vs spec's declared delta surface</td>
            <td>Hold, iterate</td>
          </tr>
          <tr>
            <td><strong>Train</strong></td>
            <td>Projection slice</td>
            <td>Combined-candidate conformance</td>
            <td>Drop car, re-project</td>
          </tr>
          <tr>
            <td><strong>Canary</strong></td>
            <td>Small % live</td>
            <td>SLOs via Statsig + Analytics Engine</td>
            <td>Auto-rollback (ref op)</td>
          </tr>
          <tr>
            <td><strong>Full</strong></td>
            <td>100%</td>
            <td>Drift, holdouts</td>
            <td>Alarm, bisect by diff</td>
          </tr>
        </tbody>
      </table>
      <p>
        A candidate is promotable only when it clears all rungs. The Spec DO is the single serialization point for promotion decisions.
      </p>
    </section>

    <section class="section">
      <h2>🏗️ Architectural Principles</h2>
      <p>
        Non-negotiable rules that guide all development:
      </p>
      <div class="lanes">
        <div class="lane">
          <h3>📜 TypeScript Everywhere</h3>
          <p>Zig→WASM only for profiled CPU-bound kernels after measurement justifies it.</p>
        </div>
        <div class="lane">
          <h3>⚙️ Orchestration Spine is Hand-Written</h3>
          <p>Spec schema, DO ledger, promotion train, Workflow sequencing are load-bearing walls.</p>
        </div>
        <div class="lane">
          <h3>🍴 Fork, Don't Contend</h3>
          <p>Never design "many agents push one repo/one branch" flows. Always fork-per-agent.</p>
        </div>
        <div class="lane">
          <h3>💾 Coordination State in Workers Stores</h3>
          <p>Scores, verdicts, train state → Spec DO (SQLite). Metrics → Analytics Engine. Indexes → D1.</p>
        </div>
        <div class="lane">
          <h3>📤 Always-Pushed Invariant</h3>
          <p>No agent task reaches done/failed without a final push. Intermediate states → <code>scratch/*</code>.</p>
        </div>
        <div class="lane">
          <h3>🚫 No External CI</h3>
          <p>Validation = Workflows. Deploys = Workers Builds.</p>
        </div>
      </div>
    </section>

    <footer>
      <p>
        <a href="/about">About Beehive</a> | 
        <a href="https://github.com/bailey-coding/beehive">Source Code</a> | 
        Competition Submission: October 14, 2026
      </p>
    </footer>
  </div>
</body>
</html>
`;
}

async function handlePublicPage(path: string): Promise<Response> {
  const html = getPublicPageHtml(path);
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function getPublicPageHtml(path: string): string {
  if (path === '/roadmap') {
    return getRoadmapPage();
  }
  if (path === '/about' || path === '/') {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Beehive - Agent-Native Version Control</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0a;
      color: #e5e5e5;
      line-height: 1.6;
      min-height: 100vh;
    }
    .container { 
      max-width: 1200px; 
      margin: 0 auto; 
      padding: 40px 20px;
    }
    header { 
      margin-bottom: 60px;
      border-bottom: 1px solid #333;
      padding-bottom: 40px;
    }
    h1 { 
      font-size: 2.5rem; 
      margin-bottom: 10px;
      background: linear-gradient(90deg, #ff6b6b, #4ecdc4, #45b7d1);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .subtitle { 
      font-size: 1.2rem; 
      color: #888;
    }
    .section { 
      margin-bottom: 50px;
    }
    .section h2 { 
      font-size: 1.5rem; 
      margin-bottom: 20px;
      color: #fff;
    }
    .section p { 
      margin-bottom: 15px;
      max-width: 700px;
    }
    .code { 
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 8px;
      padding: 20px;
      font-family: 'Monaco', 'Menlo', monospace;
      font-size: 0.9rem;
      overflow-x: auto;
      margin: 20px 0;
    }
    .code .keyword { color: #ff6b6b; }
    .code .string { color: #4ecdc4; }
    .code .comment { color: #666; }
    a { 
      color: #4ecdc4; 
      text-decoration: none;
    }
    a:hover { 
      text-decoration: underline;
    }
    .badge { 
      display: inline-block;
      background: #333;
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 0.85rem;
      margin-right: 10px;
      color: #888;
    }
    .badges { 
      margin: 20px 0;
    }
    .oracle-table { 
      width: 100%;
      border-collapse: collapse;
      margin: 20px 0;
    }
    .oracle-table th, .oracle-table td { 
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid #333;
    }
    .oracle-table th { 
      background: #1a1a1a;
      color: #fff;
    }
    .lanes {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 16px;
      margin: 20px 0;
    }
    .lane {
      background: #141414;
      border: 1px solid #333;
      border-radius: 8px;
      padding: 16px 20px;
    }
    .lane h3 { margin-bottom: 8px; color: #fff; }
    .lane .example { color: #aaa; font-style: italic; margin-bottom: 10px; }
    .flow { margin: 16px 0 16px 24px; }
    .flow li { margin-bottom: 10px; }
    .status {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 0.75rem;
      white-space: nowrap;
    }
    .status.live { background: #12361f; color: #4ade80; }
    .status.partial { background: #3a2f10; color: #facc15; }
    .status.planned { background: #262626; color: #999; }
    footer {
      margin-top: 60px;
      padding-top: 40px;
      border-top: 1px solid #333;
      color: #666;
      font-size: 0.9rem;
    }
    .navbar {
      padding: 15px 0;
      margin-bottom: 20px;
      border-bottom: 1px solid #333;
    }
    .navbar a {
      color: #4ecdc4;
      text-decoration: none;
      margin: 0 10px;
      font-weight: 500;
    }
    .navbar a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="container">
    <nav class="navbar">
      <a href="/about">About</a> | 
      <a href="/roadmap">Roadmap</a> | 
      <a href="/app">App</a> | 
      <a href="/login">Login</a>
    </nav>
    <header>
      <h1>Beehive</h1>
      <p class="subtitle">Agent-native version control and collaboration platform</p>
      <div class="badges">
        <span class="badge">Cloudflare Workers</span>
        <span class="badge">Durable Objects</span>
        <span class="badge">Artifacts</span>
        <span class="badge">MIT License</span>
      </div>
    </header>

    <section class="section">
      <h2>🎯 The Core Thesis</h2>
      <p>
        Traditional code review is <strong>social and slow</strong>.
        Beehive makes it <strong>empirical and fast</strong>:
      </p>
      <ul>
        <li><strong>Multiple agents</strong> independently implement the same machine-readable spec</li>
        <li><strong>The platform runs</strong> all candidates through deterministic gates</li>
        <li><strong>Live traffic</strong> (with safety mechanisms) decides the winner</li>
        <li><strong>Review</strong> is differential and data-driven, not opinion-based</li>
      </ul>
    </section>

    <section class="section">
      <h2>🧭 From Issue to Main: The Product Flow</h2>
      <p>
        Picture a large project like Kubernetes hosted on Beehive. Not every change deserves
        a tournament. Beehive routes work by how well-specified and how risky it is:
      </p>
      <div class="lanes">
        <div class="lane">
          <h3>Fast lane: one implementer</h3>
          <p class="example">"Typo in the kubectl drain help text."</p>
          <p>
            The issue is obvious and the fix is small. A single agent, or a human, picks it
            up and opens one candidate. It still has to clear the pre-merge gate (tests,
            lint, spec conformance), but there's nothing to compare it against, so there's
            no tournament. Humans are first-class actors: a maintainer's own branch is just
            another candidate on the same ladder.
          </p>
        </div>
        <div class="lane">
          <h3>Contested lane: many candidates</h3>
          <p class="example">"Kubelet image pulls should back off exponentially, capped at 5 minutes."</p>
          <p>
            The behaviour change is precisely specified and observable, and there are several
            reasonable ways to build it. That makes it worth running in parallel: several agents
            each build their own version, and evidence, not opinion, picks the winner.
          </p>
        </div>
      </div>

      <p>For a contested change, here is what a maintainer sees:</p>
      <ol class="flow">
        <li><strong>Issue → spec.</strong> Someone files an issue. A maintainer, or an agent,
          turns it into a machine-readable spec: the contract, acceptance tests, and a
          <em>declared delta surface</em> listing exactly which behaviour is allowed to change.</li>
        <li><strong>Agents fan out.</strong> Several agents claim the spec. Each forks the
          project's baseline into its <em>own</em> repository. Nobody pushes to a shared
          branch, so there are no merge fights.</li>
        <li><strong>Candidates prepare.</strong> Each agent implements, tests, and pushes its
          candidate. Every intermediate state is pushed, so nothing is lost if an agent dies
          mid-task.</li>
        <li><strong>Quality gates.</strong> Each candidate runs in a sandbox: tests,
          property/fuzz checks, spec conformance, and a complexity-delta score. Failures never
          board the train.</li>
        <li><strong>Shadow traffic.</strong> Real production requests are mirrored to each
          survivor and the responses are discarded. A comparator diffs each candidate against
          today's behaviour: differences inside the declared delta surface are expected, and
          anything outside it is a regression.</li>
        <li><strong>Real traffic.</strong> The best candidates get a small canary slice of
          live users. If SLOs (errors, latency) degrade, the candidate is rolled back
          automatically.</li>
        <li><strong>Promotion and merge.</strong> The winner is promoted, merged into the
          project's <code>main</code>, and stamped with its provenance: which spec, which
          agent, which evidence. Rolling back is as cheap as promoting.</li>
      </ol>
    </section>

    <section class="section">
      <h2>⚙️ Under the Hood: How Each Step Is Built</h2>
      <p>
        Every step maps to a Cloudflare primitive. Status is honest as of the submission:
        <span class="status live">Live</span> is deployed and tested,
        <span class="status partial">Partial</span> works with gaps, and
        <span class="status planned">Planned</span> is designed but not built.
      </p>
      <table class="oracle-table">
        <thead>
          <tr><th>Step</th><th>Implementation</th><th>Status</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Issue → spec</td>
            <td>Issues, specs and their links are rows in the <strong>Spec Durable Object</strong>
              (SQLite), the single serialization point for every decision. Create them via the
              REST API or the signed-in web UI.</td>
            <td><span class="status live">Live</span></td>
          </tr>
          <tr>
            <td>Choosing the lane</td>
            <td>Change-type classification (typo / refactor / behaviour change /
              security-sensitive) and reporter trust decide how many agents run and which rungs
              are mandatory. Today a maintainer makes that call.</td>
            <td><span class="status planned">Planned (M5)</span></td>
          </tr>
          <tr>
            <td>Agents fan out</td>
            <td>Agents claim the spec in the DO ledger, and each gets its own
              <strong>Cloudflare Artifacts</strong> repo ("fork, don't contend"). Today the claim
              creates an empty repo rather than a true fork of the baseline. Switching to the
              Artifacts binding's native fork is next.</td>
            <td><span class="status partial">Partial</span></td>
          </tr>
          <tr>
            <td>Quality gates</td>
            <td><strong>Workflows</strong> (gate workflow) drive <strong>Sandboxes</strong>
              (sandbox runner): clone, test, check conformance, score complexity. Verdicts are
              written to the ledger. No external CI.</td>
            <td><span class="status live">Live</span></td>
          </tr>
          <tr>
            <td>Shadow traffic</td>
            <td>The shadow router mirrors requests to <strong>Workers Builds</strong> previews
              of each candidate. The scientist comparator diffs status, headers, body and
              latency against the declared delta surface.</td>
            <td><span class="status live">Live</span></td>
          </tr>
          <tr>
            <td>Train / tournament</td>
            <td>The promotion worker runs in <em>tournament</em> mode (best of N) or
              <em>merge-train</em> mode (merge queued candidates one at a time, marking any car
              that fails as failed so it can be retried).</td>
            <td><span class="status live">Live</span></td>
          </tr>
          <tr>
            <td>Canary</td>
            <td>The shadow router splits live traffic into canary, holdout and baseline groups
              with <strong>Statsig</strong>. The canary worker ramps the traffic percentage,
              tracks SLO metrics in <strong>Analytics Engine</strong>, and triggers auto-rollback
              through <strong>Queues</strong>.</td>
            <td><span class="status live">Live</span></td>
          </tr>
          <tr>
            <td>Promote + merge to main</td>
            <td>The promotion decision is recorded in the ledger today. Updating the upstream
              <code>main</code> ref to the winner's commit (a ref operation, so demotion is
              equally cheap), plus provenance stamps in git notes, is not wired up yet.</td>
            <td><span class="status partial">Partial</span></td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="section">
      <h2>🏗️ The Oracle Ladder</h2>
      <p>
        Candidates progress through these rungs, each with increasing confidence:
      </p>
      <table class="oracle-table">
        <thead>
          <tr>
            <th>Rung</th>
            <th>Traffic</th>
            <th>Oracle</th>
            <th>Failure Action</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>Pre-merge</strong></td>
            <td>None</td>
            <td>Tests, property/fuzz, spec conformance</td>
            <td>Never board the train</td>
          </tr>
          <tr>
            <td><strong>Shadow</strong></td>
            <td>Mirrored, discarded</td>
            <td>Scientist diff vs declared delta surface</td>
            <td>Hold, iterate</td>
          </tr>
          <tr>
            <td><strong>Train</strong></td>
            <td>Projection slice</td>
            <td>Combined-candidate conformance</td>
            <td>Drop car, re-project</td>
          </tr>
          <tr>
            <td><strong>Canary</strong></td>
            <td>Small % live</td>
            <td>SLOs via Statsig + Analytics Engine</td>
            <td>Auto-rollback (ref op)</td>
          </tr>
          <tr>
            <td><strong>Full</strong></td>
            <td>100%</td>
            <td>Drift, holdouts</td>
            <td>Alarm, bisect by diff</td>
          </tr>
        </tbody>
      </table>
      <p>
        A candidate is promotable only when it clears all rungs.
      </p>
    </section>

    <section class="section">
      <h2>🔮 Vision: Semantic Dashboard</h2>
      <p>
        The logged-in UI (<code>/app</code>) is evolving towards a semantic-first experience:
      </p>
      <ul>
        <li><strong>Semantic search</strong> over your codebase and specs, helping you find
          relevant files, specs, and issues instantly</li>
        <li><strong>Semantic changelog</strong> summarizing recent activity across orgs and repos
          by category and significance</li>
        <li><strong>Repository workspaces</strong> with tabs for issues, specs, commits, builds,
          and file exploration</li>
        <li><strong>Cross-linked navigation</strong> — specs link to candidates, candidates to trials,
          repos to their specs, orgs to their projects</li>
      </ul>
      <p>
        These features are being added progressively. Current UI provides create/list for
        orgs, repos, and specs with GitHub OAuth login.
      </p>
    </section>

    <section class="section">
      <h2>🚀 Quick Demo</h2>
      <p>
        Try it yourself! This demo shows 3 agents implementing the same spec concurrently:
      </p>
      <div class="code">
<span class="comment"># Clone and setup</span><br>
$ git clone https://github.com/bailey-coding/beehive.git<br>
$ cd beehive<br>
$ npm install<br>
<br>
<span class="comment"># Create 3 agent forks</span><br>
$ ./scripts/create-agent-forks.sh agent-1 agent-2 agent-3<br>
<br>
<span class="comment"># Run the demo</span><br>
$ ./scripts/demo-end-to-end.sh --local
      </div>
      <p>
        Or <a href="https://github.com/bailey-coding/beehive">view the source code</a>.
      </p>
    </section>

    <section class="section">
      <h2>📚 Documentation</h2>
      <ul>
        <li><a href="https://github.com/bailey-coding/beehive/blob/main/README.md">README - Project Overview</a></li>
        <li><a href="https://github.com/bailey-coding/beehive/blob/main/docs/ARCHITECTURE.md">Architecture Deep Dive</a></li>
        <li><a href="https://github.com/bailey-coding/beehive/blob/main/docs/MILESTONES.md">Project Milestones</a></li>
        <li><a href="https://github.com/bailey-coding/beehive/blob/main/docs/STATSIG-INTEGRATION.md">Statsig Integration</a></li>
        <li><a href="https://github.com/bailey-coding/beehive/blob/main/cli/README.md">CLI Reference</a></li>
        <li><a href="https://github.com/bailey-coding/beehive/blob/main/SUBMISSION.md">Competition Submission</a></li>
      </ul>
    </section>

    <section class="section">
      <h2>💡 Key Concepts</h2>
      
      <h3>Spec</h3>
      <p>
        A machine-readable specification that defines the contract (interface/API),
        acceptance criteria (tests), and declared delta surface (allowed behavior changes).
      </p>

      <h3>Candidate</h3>
      <p>
        An agent's implementation of a spec. Each candidate lives in its own Artifacts
        repository and progresses through stages: pending → passed_premerge → passed_shadow →
        passed_train → passed_canary → promoted.
      </p>

      <h3>Actor</h3>
      <p>
        Any entity that can perform actions: humans or agents. Actors have trust scores,
        promotion authority, and unique identities.
      </p>

      <h3>Scientist Comparator</h3>
      <p>
        Compares candidate responses against the baseline and declared delta surface.
        Validates status codes, headers, body content, and performance.
      </p>
    </section>

    <section class="section">
      <h2>📊 Current Status</h2>
      <div class="badges">
        <span class="badge" style="background: #28a745; color: #fff;">✅ SPIKE Complete</span>
        <span class="badge" style="background: #28a745; color: #fff;">✅ M1 Complete</span>
        <span class="badge" style="background: #28a745; color: #fff;">✅ M2 Complete</span>
        <span class="badge" style="background: #d29922; color: #fff;">🚧 M3 Partial</span>
        <span class="badge">📦 M4 Submission: Oct 14</span>
      </div>
      <p>
        All 10 workers are deployed on Cloudflare's global network and fail closed on
        auth. 550+ unit tests and a local cross-worker E2E suite cover every worker.
      </p>
      <ul>
        <li>✅ Core: API + Spec DO, gate workflow, sandbox runner, queue consumer</li>
        <li>✅ Empirical oracle (M2): shadow router, scientist comparator, preview manager, candidate service</li>
        <li>🚧 Promotion train (M3): promotion worker (tournament and merge-train modes) and canary worker with a local traffic-split config; canary rollback is a Spec DO ref move, but the SLO trigger is not wired and there is no Statsig SDK integration</li>
        <li>✅ Spec DO with SQLite storage working</li>
        <li>✅ Artifacts integration validated</li>
        <li>✅ End-to-end demo flow working</li>
      </ul>
    </section>

    <section class="section">
      <h2>🏆 Competition</h2>
      <p>
        Beehive is entered in <strong>Cloudflare's "Build the Next-Gen Git Platform" competition</strong>.
        Submission deadline: <strong>October 14, 2026</strong>.
      </p>
      <p>
        <a href="https://github.com/bailey-coding/beehive">View Source on GitHub</a>
      </p>
    </section>

    <footer>
      <p>
        &copy; 2026 Bailey Coding Beehive | 
        <a href="https://github.com/bailey-coding/beehive/blob/main/LICENSE">MIT License</a> |
        Built with ❤️ on Cloudflare Workers
      </p>
    </footer>
  </div>
</body>
</html>
    `;
  }
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>404 - Beehive</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
           background: #0a0a0a; color: #e5e5e5; height: 100vh; 
           margin: 0; display: flex; align-items: center; justify-content: center; 
           text-align: center; }
  </style>
</head>
<body>
  <div>
    <h1>404 - Not Found</h1>
    <p>This page doesn't exist.</p>
    <p><a href="/about">Visit the About page</a></p>
  </div>
</body>
</html>`;
}

// HEALTH
// ============================================================================

async function handleHealth(_request: Request, specDoStub: SpecDoStub): Promise<Response> {
  // The Spec DO's /health answers only after its init() (schema + migrations) succeeded, so a ledger
  // stuck on a failed migration shows here. The ledger is the only database: both checks share the result.
  let ledgerOk = false;
  try {
    const doResponse = await specDoStub.fetch('/health');
    ledgerOk = doResponse.ok;
    if (!ledgerOk) console.error(`[Health] Spec DO /health answered ${doResponse.status}`);
  } catch (error) {
    console.error('[Health] Spec DO /health failed:', error);
  }

  const check = ledgerOk ? 'ok' : 'error';
  const health: import('./types').HealthResponse = {
    status: ledgerOk ? 'healthy' : 'unhealthy',
    version: '0.1.0',
    timestamp: Date.now(),
    checks: { database: check, durableObject: check },
  };
  if (ledgerOk) return makeApiResponse(health);
  // 503 so monitors and scripts that look at the status code see a broken ledger
  return new Response(
    JSON.stringify({ success: false, error: 'Spec DO unavailable', data: health, timestamp: Date.now() }),
    { status: 503, headers: { 'Content-Type': 'application/json' } }
  );
}

// ============================================================================
// ORGANIZATIONS
// ============================================================================

async function handleCreateOrganization(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const body: import('./types').CreateOrganizationRequest = await request.json();
  const actorId = request.headers.get('X-Actor-ID') || 'unknown';
  const response = await sendToSpecDo(stub, '/api/organizations', 'POST', body, actorId);
  return response;
}

async function handleListOrganizations(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const url = new URL(request.url);
  const limit = parseInt(url.searchParams.get('limit') || '50');
  const offset = parseInt(url.searchParams.get('offset') || '0');
  const response = await sendToSpecDo(stub, `/api/organizations?limit=${limit}&offset=${offset}`, 'GET');
  return response;
}

async function handleGetOrganization(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const id = extractId(request.url);
  const response = await sendToSpecDo(stub, `/api/organizations/${id}`, 'GET');
  return response;
}

// ============================================================================
// ACTORS
// ============================================================================

async function handleCreateActor(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const body: import('./types').CreateActorRequest = await request.json();
  const actorId = request.headers.get('X-Actor-ID') || 'unknown';
  const response = await sendToSpecDo(stub, '/api/actors', 'POST', body, actorId);
  return response;
}

async function handleListActors(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const url = new URL(request.url);
  const limit = parseInt(url.searchParams.get('limit') || '50');
  const offset = parseInt(url.searchParams.get('offset') || '0');
  const response = await sendToSpecDo(stub, `/api/actors?limit=${limit}&offset=${offset}`, 'GET');
  return response;
}

async function handleGetActor(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const id = extractId(request.url);
  const response = await sendToSpecDo(stub, `/api/actors/${id}`, 'GET');
  return response;
}

async function handleUpdateActorTrust(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const id = extractParentId(request.url);
  const body: import('./types').UpdateActorTrustRequest = await request.json();
  const actorId = request.headers.get('X-Actor-ID') || 'unknown';
  const response = await sendToSpecDo(stub, `/api/actors/${id}/trust`, 'PATCH', body, actorId);
  return response;
}

async function handleGrantPromotionAuthority(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const id = extractParentId(request.url);
  const actorId = request.headers.get('X-Actor-ID') || 'unknown';
  const response = await sendToSpecDo(stub, `/api/actors/${id}/promotion-authority`, 'PATCH', undefined, actorId);
  return response;
}

// ============================================================================
// REPOSITORIES
// ============================================================================

async function handleCreateRepository(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const body: import('./types').CreateRepositoryRequest = await request.json();
  const actorId = request.headers.get('X-Actor-ID') || 'unknown';
  const response = await sendToSpecDo(stub, '/api/repositories', 'POST', body, actorId);
  return response;
}

async function handleListRepositories(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const url = new URL(request.url);
  const limit = parseInt(url.searchParams.get('limit') || '50');
  const offset = parseInt(url.searchParams.get('offset') || '0');
  const response = await sendToSpecDo(stub, `/api/repositories?limit=${limit}&offset=${offset}`, 'GET');
  return response;
}

async function handleGetRepository(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const id = extractId(request.url);
  const response = await sendToSpecDo(stub, `/api/repositories/${id}`, 'GET');
  return response;
}

// ============================================================================
// SPECS
// ============================================================================

async function handleCreateSpec(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const body: import('./types').CreateSpecRequest = await request.json();
  const actorId = request.headers.get('X-Actor-ID') || 'unknown';
  const response = await sendToSpecDo(stub, '/api/specs', 'POST', body, actorId);
  return response;
}

async function handleListSpecs(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const url = new URL(request.url);
  const params = new URLSearchParams();
  params.set('limit', url.searchParams.get('limit') || '50');
  params.set('offset', url.searchParams.get('offset') || '0');
  if (url.searchParams.get('organizationId')) params.set('organizationId', url.searchParams.get('organizationId')!);
  if (url.searchParams.get('stage')) params.set('stage', url.searchParams.get('stage')!);
  const response = await sendToSpecDo(stub, `/api/specs?${params.toString()}`, 'GET');
  return response;
}

async function handleGetSpec(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const id = extractId(request.url);
  const response = await sendToSpecDo(stub, `/api/specs/${id}`, 'GET');
  return response;
}

async function handleUpdateSpecStage(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const id = extractParentId(request.url);
  const body: import('./types').UpdateSpecStageRequest = await request.json();
  const actorId = request.headers.get('X-Actor-ID') || 'unknown';
  const response = await sendToSpecDo(stub, `/api/specs/${id}/stage`, 'PATCH', body, actorId);
  return response;
}

// ============================================================================
// CANDIDATES
// ============================================================================

async function handleClaimSpec(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const specId = extractParentId(request.url);
  const body: import('./types').ClaimSpecRequest = await request.json();
  const actorId = request.headers.get('X-Actor-ID') || 'unknown';
  
  // Call Spec DO to claim the spec - it now returns real data from Artifacts API
  const doResponse = await sendToSpecDo(stub, `/api/specs/${specId}/claim`, 'POST', body, actorId);
  
  if (!doResponse.ok) {
    return doResponse;
  }
  
  const doEnvelope = await doResponse.json() as { data?: import('./types').ClaimSpecResponse };
  const doData = doEnvelope.data ?? ({} as import('./types').ClaimSpecResponse);
  
  // Pass through the real data from Spec DO (which now calls Artifacts API)
  return makeApiResponse<import('./types').ClaimSpecResponse>(doData);
}

async function handleCreateCandidate(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const body: import('./types').CreateCandidateRequest = await request.json();
  const actorId = request.headers.get('X-Actor-ID') || 'unknown';
  const response = await sendToSpecDo(stub, '/api/candidates', 'POST', { ...body, agentId: actorId }, actorId);
  return response;
}

async function handleListCandidates(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const url = new URL(request.url);
  const params = new URLSearchParams();
  params.set('limit', url.searchParams.get('limit') || '50');
  params.set('offset', url.searchParams.get('offset') || '0');
  if (url.searchParams.get('specId')) params.set('specId', url.searchParams.get('specId')!);
  if (url.searchParams.get('agentId')) params.set('agentId', url.searchParams.get('agentId')!);
  if (url.searchParams.get('stage')) params.set('stage', url.searchParams.get('stage')!);
  const response = await sendToSpecDo(stub, `/api/candidates?${params.toString()}`, 'GET');
  return response;
}

async function handleGetCandidate(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const id = extractId(request.url);
  const response = await sendToSpecDo(stub, `/api/candidates/${id}`, 'GET');
  return response;
}

async function handleUpdateCandidateStage(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const id = extractParentId(request.url);
  const body: import('./types').UpdateCandidateStageRequest = await request.json();
  const actorId = request.headers.get('X-Actor-ID') || 'unknown';
  const response = await sendToSpecDo(stub, `/api/candidates/${id}/stage`, 'PATCH', body, actorId);
  return response;
}

// ============================================================================
// GATE VERDICTS
// ============================================================================

async function handleCreateGateVerdict(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const body: import('./types').CreateGateVerdictRequest = await request.json();
  const actorId = request.headers.get('X-Actor-ID') || 'unknown';
  const response = await sendToSpecDo(stub, '/api/gate-verdicts', 'POST', { ...body, decidedBy: actorId }, actorId);
  return response;
}

async function handleListGateVerdicts(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const url = new URL(request.url);
  const params = new URLSearchParams();
  params.set('limit', url.searchParams.get('limit') || '50');
  params.set('offset', url.searchParams.get('offset') || '0');
  if (url.searchParams.get('candidateId')) params.set('candidateId', url.searchParams.get('candidateId')!);
  if (url.searchParams.get('gate')) params.set('gate', url.searchParams.get('gate')!);
  if (url.searchParams.get('status')) params.set('status', url.searchParams.get('status')!);
  const response = await sendToSpecDo(stub, `/api/gate-verdicts?${params.toString()}`, 'GET');
  return response;
}

async function handleGetGateVerdictsForCandidate(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const id = extractParentId(request.url);
  const response = await sendToSpecDo(stub, `/api/candidates/${id}/gate-verdicts`, 'GET');
  return response;
}

// ============================================================================
// TRIALS
// ============================================================================

async function handleCreateTrial(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const body: import('./types').CreateTrialRequest = await request.json();
  const actorId = request.headers.get('X-Actor-ID') || 'unknown';
  const response = await sendToSpecDo(stub, '/api/trials', 'POST', { ...body, decidedBy: actorId }, actorId);
  return response;
}

async function handleListTrials(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const url = new URL(request.url);
  const params = new URLSearchParams();
  params.set('limit', url.searchParams.get('limit') || '50');
  params.set('offset', url.searchParams.get('offset') || '0');
  if (url.searchParams.get('specId')) params.set('specId', url.searchParams.get('specId')!);
  if (url.searchParams.get('stage')) params.set('stage', url.searchParams.get('stage')!);
  const response = await sendToSpecDo(stub, `/api/trials?${params.toString()}`, 'GET');
  return response;
}

async function handleGetTrial(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const id = extractId(request.url);
  const response = await sendToSpecDo(stub, `/api/trials/${id}`, 'GET');
  return response;
}

async function handleDecideTrial(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const id = extractParentId(request.url);
  const body: import('./types').DecideTrialRequest = await request.json();
  const actorId = request.headers.get('X-Actor-ID') || 'unknown';
  const response = await sendToSpecDo(stub, `/api/trials/${id}/decide`, 'POST', { ...body, decidedBy: actorId }, actorId);
  return response;
}

// ============================================================================
// PROMOTIONS
// ============================================================================

async function handleCreatePromotion(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const body: import('./types').CreatePromotionRequest = await request.json();
  const actorId = request.headers.get('X-Actor-ID') || 'unknown';
  const response = await sendToSpecDo(stub, '/api/promotions', 'POST', { ...body, promotedBy: actorId }, actorId);
  return response;
}

async function handleListPromotions(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const url = new URL(request.url);
  const params = new URLSearchParams();
  params.set('limit', url.searchParams.get('limit') || '50');
  params.set('offset', url.searchParams.get('offset') || '0');
  if (url.searchParams.get('candidateId')) params.set('candidateId', url.searchParams.get('candidateId')!);
  const response = await sendToSpecDo(stub, `/api/promotions?${params.toString()}`, 'GET');
  return response;
}

// ============================================================================
// ISSUES
// ============================================================================

async function handleCreateIssue(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const body: import('./types').CreateIssueRequest = await request.json();
  const actorId = request.headers.get('X-Actor-ID') || 'unknown';
  const response = await sendToSpecDo(stub, '/api/issues', 'POST', { ...body, createdBy: actorId }, actorId);
  return response;
}

async function handleListIssues(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const url = new URL(request.url);
  const params = new URLSearchParams();
  params.set('limit', url.searchParams.get('limit') || '50');
  params.set('offset', url.searchParams.get('offset') || '0');
  if (url.searchParams.get('repositoryId')) params.set('repositoryId', url.searchParams.get('repositoryId')!);
  if (url.searchParams.get('stage')) params.set('stage', url.searchParams.get('stage')!);
  if (url.searchParams.get('status')) params.set('status', url.searchParams.get('status')!);
  const response = await sendToSpecDo(stub, `/api/issues?${params.toString()}`, 'GET');
  return response;
}

async function handleGetIssue(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const id = extractId(request.url);
  const response = await sendToSpecDo(stub, `/api/issues/${id}`, 'GET');
  return response;
}

async function handleUpdateIssueStage(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const id = extractParentId(request.url);
  const body: import('./types').UpdateIssueStageRequest = await request.json();
  const actorId = request.headers.get('X-Actor-ID') || 'unknown';
  const response = await sendToSpecDo(stub, `/api/issues/${id}/stage`, 'PATCH', body, actorId);
  return response;
}

async function handleUpdateIssueStatus(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const id = extractParentId(request.url);
  const body: import('./types').UpdateIssueStatusRequest = await request.json();
  const actorId = request.headers.get('X-Actor-ID') || 'unknown';
  const response = await sendToSpecDo(stub, `/api/issues/${id}/status`, 'PATCH', body, actorId);
  return response;
}

async function handleUpdateIssueCommentPolicy(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const id = extractParentId(request.url);
  const body: import('./types').UpdateIssueCommentPolicyRequest = await request.json();
  const actorId = request.headers.get('X-Actor-ID') || 'unknown';
  const response = await sendToSpecDo(stub, `/api/issues/${id}/comment-policy`, 'PATCH', body, actorId);
  return response;
}

// ============================================================================
// ISSUE COMMENTS
// ============================================================================

async function handleCreateIssueComment(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const id = extractParentId(request.url);
  const body: import('./types').CreateIssueCommentRequest = await request.json();
  const actorId = request.headers.get('X-Actor-ID') || 'unknown';
  const response = await sendToSpecDo(stub, `/api/issues/${id}/comments`, 'POST', { ...body, createdBy: actorId, issueId: id }, actorId);
  return response;
}

async function handleListIssueComments(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const id = extractParentId(request.url);
  const response = await sendToSpecDo(stub, `/api/issues/${id}/comments`, 'GET');
  return response;
}

// ============================================================================
// LINKS
// ============================================================================

async function handleCreateIssueSpecLink(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const body: import('./types').CreateIssueSpecLinkRequest = await request.json();
  const actorId = request.headers.get('X-Actor-ID') || 'unknown';
  const response = await sendToSpecDo(stub, '/api/issue-spec-links', 'POST', body, actorId);
  return response;
}

async function handleCreateIssueCandidateLink(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const body: import('./types').CreateIssueCandidateLinkRequest = await request.json();
  const actorId = request.headers.get('X-Actor-ID') || 'unknown';
  const response = await sendToSpecDo(stub, '/api/issue-candidate-links', 'POST', body, actorId);
  return response;
}

// ============================================================================
// HISTORY
// ============================================================================

async function handleGetEntityHistory(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const pathParts = pathnameOf(request.url).split('/');
  const entityType = pathParts[pathParts.length - 3] as import('./types').GetHistoryRequest['entityType'];
  const entityId = pathParts[pathParts.length - 2];
  const response = await sendToSpecDo(stub, `/api/entities/${entityType}/${entityId}/history`, 'GET');
  return response;
}

// ============================================================================
// SANDBOX INTEGRATION
// ============================================================================

async function handleExecuteCandidate(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const id = extractParentId(request.url);
  const body = await request.json() as { sandboxRunnerUrl?: string };
  const actorId = request.headers.get('X-Actor-ID') || 'unknown';

  // Extract sandbox runner URL from body or use default
  const sandboxRunnerUrl = body.sandboxRunnerUrl || 'https://beehive.example.com';

  const response = await sendToSpecDo(stub, `/api/candidates/${id}/execute`, 'POST', {
    ...body,
    sandboxRunnerUrl,
  }, actorId);
  return response;
}

// ============================================================================
// GATE WORKFLOW
// ============================================================================

async function handleRunPreMergeGate(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const id = extractParentId(request.url);
  const body = await request.json() as unknown;
  const actorId = request.headers.get('X-Actor-ID') || 'unknown';
  const response = await sendToSpecDo(stub, `/api/candidates/${id}/gate/pre-merge`, 'POST', body, actorId);
  return response;
}

async function handleGetGateVerdict(
  request: Request,
  stub: SpecDoStub
): Promise<Response> {
  const id = extractId(request.url);
  const response = await sendToSpecDo(stub, `/api/gate-verdicts/${id}`, 'GET');
  return response;
}
