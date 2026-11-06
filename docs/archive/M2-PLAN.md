---
category: planning
status: completed
milestone: m2
audience: human,agent
tags:
  - phase-report
---

# M2 Implementation Plan — Empirical Oracle

**Status:** COMPLETE  
**Created:** 2026-10-11  
**Completed:** 2026-10-12  
**Owner:** Code Agents (Leaf Work) + Human (Spine Work as needed)  
**Milestone:** Empirical oracle — live traffic validation against declared delta surface

---

## Executive Summary

**M1 is COMPLETE.** The pre-merge oracle pipeline (Spec → Claim → Fork → Push → Queue → Gate → Verdict) works end-to-end with real Cloudflare Artifacts integration. All 6 success criteria met, 4 workers deployed and verified.

**M2 is COMPLETE (2026-10-12).** All 5 M2 components deployed and operational: Workers Builds Previews, Edge Mirror Worker, Scientist Comparator, Analytics Engine metrics, and queue/service binding infrastructure. Full empirical oracle pipeline verified end-to-end.

**Feasibility:** YES — M2 completed in 2 days (Oct 11-12) with focused scope. All components deployed and health-checked.

---

## M2 Scope (From MILESTONES.md)

M2 delivers **5 components:**

1. ✅ **Sample service on Workers main** — Already done (edge router runs on Workers)
2. ✅ **Workers Builds Previews per candidate** — Preview Manager Worker deployed, creates isolated preview deployments for each candidate
3. ✅ **Edge mirror Worker fanning out and discarding** — Shadow Router Worker deployed, mirrors production traffic to candidates, discards responses
4. ✅ **Scientist comparator against declared delta surface** — Scientist Comparator Worker deployed, compares candidate vs baseline against declared delta surface
5. ✅ **Analytics Engine per-candidate metrics** — All workers instrumented, Analytics Engine dataset `beehive-metrics` capturing per-candidate metrics

---

## Key Questions Answered

### 1. What does Workers Builds Previews mean and how do we implement it?

**What it is:** Cloudflare Workers Builds allows creating **preview deployments** — temporary, isolated Workers instances for each candidate implementation. Each candidate gets its own preview URL that can receive real traffic.

**Implementation approach:**

```typescript
// For each candidate that passes pre-merge:
// 1. Package candidate code as a Worker
// 2. Create a preview deployment via Workers Builds API
// 3. Store preview URL in candidate record
// 4. Route shadow traffic to preview URL
```

**How it works:**
- Candidate repos contain Worker-compatible code (Wrangler config, TypeScript/JS)
- Preview deployments are created programmatically via `cf workers builds create`
- Each preview gets a unique URL: `https://<candidate-id>.bz23711.workers.dev`
- Previews can be deleted when candidate is promoted or failed
- Workers Builds handles the deployment pipeline (build, upload, deploy)

**Dependencies:**
- Candidate repos must be Worker-compatible (entry point, wrangler.toml)
- Cloudflare API token with `Workers Scripts:Edit` and `Workers Builds:Edit`
- Build configuration template for candidates

**Files needed:**
- `workers/shared/builds.ts` — Workers Builds client
- Updates to `workers/spec-do/index.ts` — Store preview URLs
- Updates to `workers/api/index.ts` — Preview management endpoints
- New Worker: `beehive-shadow-router` — Traffic mirroring

**Leaf work:** Entirely agent-writable (glue code, API endpoints, client libraries)

---

### 2. What is Scientist comparator and how does it integrate with declared delta surface?

**What it is:** **Scientist** is a pattern for running production traffic through multiple implementations simultaneously and comparing their outputs. Originally from GitHub, popularized by Stripe. We compare candidate behavior against:
1. The **current production implementation** (baseline)
2. The **declared delta surface** from the spec (contract definition)

**Implementation approach:**

```
┌─────────────────────────────────────────────────────────────────┐
│                      SCIENTIST COMPARISON                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Request ──► Edge Router ───┬───► Baseline Worker (production)     │
│                           │                                         │
│                           ├───► Candidate Preview Worker          │
│                           │     (mirrored request, identical input)│
│                           │                                         │
│                           ▼                                         │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Scientist Comparator (new Worker)                      │   │
│  │                                                             │   │
│  │  Inputs:                                                     │   │
│  │    - baselineResponse: Response from production          │   │
│  │    - candidateResponse: Response from candidate           │   │
│  │    - spec: Declared delta surface (from Spec DO)         │   │
│  │                                                             │   │
│  │  Checks:                                                     │   │
│  │    1. Status code equality                                  │   │
│  │    2. Headers match (allowlist configurable)             │   │
│  │    3. Body equivalence (JSON comparison)                   │   │
│  │    4. Response time within SLO                            │   │
│  │    5. No errors thrown                                     │   │
│  │    6. Declared surface coverage (all declared paths hit) │   │
│  │                                                             │   │
│  │  Outputs:                                                    │   │
│  │    - match: boolean                                          │   │
│  │    - diff: DiffResult[] (mismatched fields)               │   │
│  │    - metrics: ResponseMetrics                               │   │
│  │                                                             │   │
│  └─────────────────────────────────────────────────────────┘   │
│                           │                                         │
│                           ▼                                         │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │   Record in Spec DO:                                       │   │
│  │   - gate_verdicts table (gate='shadow', status, score)    │   │
│  │   - trials table (comparison metrics)                     │   │
│  │   - Analytics Engine (raw metrics)                        │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────┘
```

**Declared Delta Surface Integration:**

The spec's `declared_delta_surface` defines what behaviors are expected to change:

```typescript
// From schema-inline.ts
interface Spec {
  id: string;
  name: string;
  contract: string; // JSON: endpoints, models, workflow
  declared_delta_surface: string; // JSON: array of changed behaviors
  // ...
}
```

Example declared delta surface:
```json
{
  "endpoints": {
    "/shorten": {"method": "POST", "delta": "new"},
    "/redirect/:id": {"method": "GET", "delta": "modified"}
  },
  "models": {
    "ShortUrl": {"delta": "new"},
    "RedirectResponse": {"delta": "modified"}
  },
  "behavior": {
    "caching": {"delta": "modified", "description": "Add 5min cache TTL"},
    "rate_limiting": {"delta": "new", "description": "Add per-IP rate limiting"}
  }
}
```

**Scientist uses this to:**
1. Validate that candidate changes match declared deltas (no surprise changes)
2. Verify that unchanged surfaces still behave identically
3. Confirm declared changes are actually present in candidate

**Implementation:**

```typescript
// workers/scientist-comparator/index.ts

interface ScientistRequest {
  request: Request;
  baselineResponse: Response;
  candidateResponse: Response;
  spec: Spec;
  candidateId: string;
  declaredDeltaSurface: DeclaredDeltaSurface;
}

interface ScientistResult {
  match: boolean;
  overallScore: number;
  checks: {
    statusCode: boolean;
    headers: boolean;
    body: boolean;
    responseTime: boolean;
    declaredSurface: boolean;
    noSurprises: boolean;
  };
  diffs: Diff[];
  metrics: {
    baselineLatencyMs: number;
    candidateLatencyMs: number;
    latencyDeltaMs: number;
  };
}

function compareDeclaredSurface(
  baseline: any,
  candidate: any,
  declaredDeltaSurface: DeclaredDeltaSurface
): { match: boolean; diffs: Diff[] } {
  // Check that declared changes are present
  // Check that undeclared changes are absent
  // Return comparison results
}
```

**Files needed:**
- `workers/scientist-comparator/index.ts` — New Worker
- `workers/scientist-comparator/wrangler.toml` — Worker config
- `workers/shared/scientist.ts` — Comparison logic library
- `workers/spec-do/index.ts` — Store shadow verdicts

**Leaf work:** Entirely agent-writable (comparator logic, Worker implementation)

---

### 3. What does edge mirror Worker fanning out and discarding mean?

**What it is:** A **traffic mirroring** pattern where production requests are **duplicated** to candidate implementations, but the candidate responses are **discarded** (not returned to users). This allows testing candidates with real traffic without affecting production.

**Implementation approach:**

```
┌─────────────────────────────────────────────────────────────────┐
│                    EDGE MIRROR FLOW (SHADOW RUNG)                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                     │
│  User Request                       Production Request              │
│       │                                    │                         │
│       ▼                                    ▼                         │
│  ┌─────────────┐             ┌─────────────────────┐             │
│  │ Edge Router  │────────────►│ Shadow Router Worker │             │
│  │ (beehive)    │             │ (beehive-shadow)     │             │
│  └─────────────┘             └──────────┬──────────┘             │
│                                       │                           │
│                    ┌──────────────────────┼──────────────────┐   │
│                    │                          │                      │   │
│                    ▼                          ▼                      ▼   │
│             ┌──────────────┐           ┌────────┐         ┌─────────┐ │
│             │ Production   │           │ Candidate│         │ Candidate│ │
│             │ Worker       │           │ Preview │         │ Preview  │ │
│             │ (current)    │           │ Worker  │         │ Worker   │ │
│             └──────┬───────┘           └────┬────┘         └────┬────┘ │
│                    │                      │                   │        │
│                    ▼                      ▼                   ▼        │
│             ┌──────────────┐        ┌──────────┐          ┌────────┐  │
│             │ Response     │        │ DISCard  │          │ DISCARD │  │
│             │ (to user)    │        │ Response │          │ Response│  │
│             └──────────────┘        └──────────┘          └────────┘  │
│                                       │                           │        │
│                    ┌──────────────────────┼──────────────────┐   │
│                    │                          │                      │   │
│                    ▼                          ▼                      ▼   │
│             ┌──────────────────────────────────────────────────────┐ │
│             │ Scientist Comparator (aggregate results)             │ │
│             └──────────────────────────────────────────────────────┘ │
│                                                                     │
└─────────────────────────────────────────────────────────────────┘
```

**Key characteristics:**
- **Fan out:** Single request duplicated to N candidates (currently N=1 for M2)
- **Discard:** Candidate responses never reach users
- **Async:** Comparison happens in background, doesn't block user request
- **Sampling:** Can be configured to mirror 100% of traffic or a sample (e.g., 10%)

**Implementation:**

The **Shadow Router Worker** (`beehive-shadow`) handles this:

```typescript
// workers/shadow-router/index.ts

interface Env {
  SPEC_DO: DurableObjectNamespace;
  SCIENTIST: Service; // Binding to Scientist Comparator
  API_AUTH_TOKEN?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Auth check
    const denied = authGate(request, env);
    if (denied) return denied;

    // Get list of candidates in shadow stage from Spec DO
    const candidates = await getShadowCandidates(env.SPEC_DO);

    if (candidates.length === 0) {
      // No candidates to mirror to - just return original response
      return fetchProduction(request);
    }

    // Clone request for each candidate
    const requests = candidates.map(candidate =>
      new Request(candidate.previewUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      })
    );

    // Fetch all in parallel
    const responses = await Promise.allSettled([
      fetchProduction(request),
      ...requests.map(r => fetch(r))
    ]);

    // Production response is always first
    const productionResponse = responses[0];
    
    if (productionResponse.status === 'rejected') {
      // Fallback to production if it fails
      return new Response(JSON.stringify({ error: 'Production failed' }), { status: 500 });
    }

    // Trigger Scientist comparison (async, don't wait)
    // Pass production response + all candidate responses
    const scientistRequests = candidates.map((candidate, index) =>
      triggerScientistComparison(
        request,
        productionResponse.value,
        responses[index + 1],
        candidate,
        env
      )
    );

    // Fire and forget - Scientist runs in background
    Promise.allSettled(scientistRequests);

    // Return production response to user
    return productionResponse.value;
  }
}
```

**Configuration options:**
```typescript
interface ShadowConfig {
  enabled: boolean;
  mirrorPercentage: number; // 0.0 to 1.0 (100%)
  candidateIds: string[]; // Specific candidates to mirror to
  sampleRate: number; // For partial mirroring
}
```

**Files needed:**
- `workers/shadow-router/index.ts` — New Worker for mirroring
- `workers/shadow-router/wrangler.toml` — Worker config
- `workers/spec-do/index.ts` — Track candidates in shadow stage

**Leaf work:** Entirely agent-writable (Worker implementation, routing logic)

---

### 4. What Analytics Engine setup is needed for per-candidate metrics?

**What it is:** Cloudflare Analytics Engine is a time-series database for high-volume metrics. It's the right choice for tracking per-candidate, per-request metrics.

**What to track:**

```typescript
// Metrics schema for Analytics Engine

// 1. Request-level metrics (per request, per candidate)
interface RequestMetric {
  timestamp: number;
  candidateId: string;
  specId: string;
  gate: 'shadow' | 'train' | 'canary' | 'full';
  requestId: string;
  path: string;
  method: string;
  statusCode: number;
  latencyMs: number;
  baselineLatencyMs: number;
  latencyDeltaMs: number;
  bodySizeBytes: number;
  match: boolean; // Scientist comparison result
  diffCount: number;
  // Dimensions
  region: string;
  namespace: string;
}

// 2. Aggregated metrics (per minute/hour)
interface AggregatedMetric {
  timestamp: number;
  candidateId: string;
  interval: '1m' | '5m' | '1h';
  requestCount: number;
  errorCount: number;
  errorRate: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  matchRate: number; // % of requests that matched baseline
  diffSeverity: 'none' | 'low' | 'medium' | 'high';
}

// 3. Business metrics
interface BusinessMetric {
  timestamp: number;
  specId: string;
  candidateId: string;
  agentId: string;
  promotions: number;
  rollbacks: number;
  shadowScore: number;
  trainScore: number;
  timeInStage: number; // Seconds in current stage
}
```

**Implementation approach:**

```typescript
// Step 1: Define Analytics Engine binding
// In each worker's wrangler.toml:

[[analytics_engine]]
binding = "ANALYTICS"

// Step 2: Instrument Scientist Comparator
// workers/scientist-comparator/index.ts

async function recordMetrics(
  env: Env,
  metrics: RequestMetric[]
): Promise<void> {
  const ae = env.ANALYTICS;
  
  for (const metric of metrics) {
    await ae.writeDataPoint({
      indexes: [metric.candidateId, metric.specId, metric.gate],
      blobs: [metric.requestId, metric.path],
      doubles: [
        metric.timestamp,
        metric.latencyMs,
        metric.baselineLatencyMs,
        metric.latencyDeltaMs,
        metric.bodySizeBytes,
        metric.match ? 1 : 0,
        metric.diffCount
      ]
    });
  }
}

// Step 3: Query analytics for dashboards
// workers/api/index.ts - /api/candidates/:id/metrics

async function getCandidateMetrics(
  env: Env,
  candidateId: string,
  startTime: number,
  endTime: number
): Promise<AnalyticsResult> {
  const ae = env.ANALYTICS;
  
  const query = `SELECT 
    COUNT(*) as requestCount,
    AVG(latencyMs) as avgLatency,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latencyMs) as p95Latency,
    AVG(match) * 100 as matchRate
    FROM metrics
    WHERE candidateId = ?
    AND timestamp >= ? AND timestamp <= ?
    GROUP BY interval(5m)`;

  return await ae.query(query, [candidateId, startTime, endTime]);
}
```

**Files needed:**
- `workers/shared/analytics.ts` — Analytics Engine client
- `wrangler.toml` updates — Add Analytics Engine binding to all workers
- `workers/api/index.ts` — Metrics query endpoints

**Leaf work:** Entirely agent-writable (instrumentation, queries, endpoints)

---

### 5. Which parts require spine work (human) vs leaf work (agent)?

**Rule from AGENTS.md:**
> "The orchestration spine is hand-written. Spec schema, DO ledger, promotion train, Workflow sequencing are load-bearing walls. Code agents write leaf functions, glue, tests, and candidate services."

**Spine Work (Human-only):**
- ❌ Spec DO schema changes (specs, candidates, gate_verdicts tables)
- ❌ Core promotion train logic
- ❌ Workflow sequencing (M3+)
- ❌ Ledger lifecycle modifications

**Leaf Work (Agent-writable):**
- ✅ Workers Builds client (`workers/shared/builds.ts`)
- ✅ Shadow Router Worker (`workers/shadow-router/`)
- ✅ Scientist Comparator Worker (`workers/scientist-comparator/`)
- ✅ Analytics Engine client (`workers/shared/analytics.ts`)
- ✅ API endpoints for preview management
- ✅ API endpoints for metrics querying
- ✅ All service bindings and configuration
- ✅ All wrangler.toml files
- ✅ Integration tests
- ✅ Glue code between components

**For M2, the division is clear:**

| Component | Type | Owner | Risk |
|-----------|------|-------|------|
| Workers Builds Previews | Leaf | Agent | Low |
| Edge Mirror Worker | Leaf | Agent | Low |
| Scientist Comparator | Leaf | Agent | Medium |
| Analytics Engine setup | Leaf | Agent | Low |
| Spec DO schema additions | Spine | Human | Medium |
| Gate verdict schema extension | Spine | Human | Medium |

**Spine changes needed for M2:**

The `candidates` table needs a new field for preview URLs, and `gate_verdicts` needs a field for shadow results:

```sql
-- In schema-inline.ts / schema.sql

-- Add to candidates table:
ALTER TABLE candidates ADD COLUMN preview_url TEXT;
ALTER TABLE candidates ADD COLUMN preview_created_at INTEGER;
ALTER TABLE candidates ADD COLUMN preview_deleted_at INTEGER;

-- Add to gate_verdicts table:
ALTER TABLE gate_verdicts ADD COLUMN shadow_match BOOLEAN;
ALTER TABLE gate_verdicts ADD COLUMN shadow_diff TEXT;
ALTER TABLE gate_verdicts ADD COLUMN shadow_score INTEGER;
ALTER TABLE gate_verdicts ADD COLUMN shadow_metrics TEXT;
```

**These schema changes are spine work** and must be done by a human. However, they are **minimal** and **non-controversial** — adding columns to existing tables doesn't change the core logic.

**Recommendation:** Since M1's schema is already deployed and working, and these are additive changes, the human can approve and commit these schema changes quickly, or grant an agent temporary permission to make this specific, well-defined change.

---

### 6. Can we complete M2 before deadline (2026-10-14)?

**YES — with a focused, minimal viable scope.**

**Timeline (3 days, starting 2026-10-11):**

```
Day 0 (Oct 11 - TODAY)     Day 1 (Oct 12)          Day 2 (Oct 13)          Day 3 (Oct 14)
───────────────────────    ────────────────────    ────────────────────    ────────────────────
░ Planning & Investigation    ░ Builds + Shadow        ░ Scientist + AE        ░ Integration & Testing
░ (THIS DOCUMENT)            ░ Router                ░ Comparator            ░ Final verification
░                           ░                       ░                       ░ Submit
```

**Effort estimates:**

| Task | Estimate | Owner | Day |
|------|----------|-------|-----|
| 1. Schema additions (spine) | 30 min | Human | Day 0 |
| 2. Workers Builds client | 1 hour | Agent | Day 1 AM |
| 3. Shadow Router Worker | 2 hours | Agent | Day 1 AM |
| 4. Preview management endpoints | 1 hour | Agent | Day 1 PM |
| 5. Scientist Comparator Worker | 2 hours | Agent | Day 2 AM |
| 6. Scientist comparison logic | 2 hours | Agent | Day 2 AM |
| 7. Analytics Engine client | 1 hour | Agent | Day 2 PM |
| 8. Metrics instrumentation | 1 hour | Agent | Day 2 PM |
| 9. Metrics query endpoints | 1 hour | Agent | Day 2 PM |
| 10. Integration wiring | 2 hours | Agent | Day 3 AM |
| 11. End-to-end testing | 2 hours | Agent | Day 3 AM |
| 12. Documentation | 1 hour | Agent | Day 3 PM |
| **Total** | **~17 hours** | | |

**Parallelization:**
- Builds client + Shadow Router can be done in parallel
- Scientist Comparator + Analytics Engine can be done in parallel
- Integration wiring requires all components to be complete

**Realistic timeline:** 12-15 hours of focused work across 3 days is achievable.

**Critical path:**
```
Schema (0.5h) → Builds Client (1h) → Shadow Router (2h) → 
Scientist (4h) → Integration (2h) → Testing (2h) = 11.5h
```

**With 3 days and potentially multiple agents working in parallel, M2 is feasible.**

---

### 7. What is minimal viable M2 for competition?

**Definition:** The smallest implementation that proves the empirical oracle concept works end-to-end, suitable for competition submission.

**Minimal Viable M2 (MV2):**

1. ✅ **Workers Builds Previews** — Each candidate deployed as a Worker preview
   - Manual preview creation acceptable (auto creation is nice-to-have)
   - At least 1 candidate must have a working preview

2. ✅ **Edge Mirror Worker** — Traffic fanning out and discarding
   - Mirrors requests to exactly 1 candidate preview
   - Discards candidate response (doesn't return to user)
   - 100% mirroring for simplicity (no sampling)
   - No auth on mirror path (for demo purposes)

3. ✅ **Scientist Comparator** — Comparison against declared delta surface
   - Compares status codes only (simplified)
   - Compares response bodies for JSON endpoints
   - Declared surface validation: basic endpoint presence check
   - Scores: pass/fail based on comparison

4. ✅ **Analytics Engine** — Per-candidate metrics
   - Tracks: request count, latency, match rate
   - Stores in Analytics Engine (not just logs)
   - Basic query endpoint to retrieve metrics

5. ✅ **End-to-End Demo** — Live demonstration
   - 1 spec with declared delta surface
   - 1 baseline Worker (production)
   - 1 candidate Worker (preview)
   - Shadow traffic flowing
   - Scientist comparison running
   - Metrics being recorded

**What can be deferred to post-submission:**
- ❌ Automatic preview creation/deletion (manual is fine)
- ❌ Multiple candidate mirroring (1 candidate is enough)
- ❌ Complex declared surface validation (basic is fine)
- ❌ Advanced Analytics Engine queries (basic counts are fine)
- ❌ Authentication on shadow path (not needed for demo)
- ❌ Canary/rollout features (M3)

**MV2 size:** ~8-10 hours of implementation + 2-3 hours testing = **10-13 hours total**

**This is definitely achievable by 2026-10-14.**

---

## Implementation Plan

### Phase 0: Preparation (Day 0 - Oct 11, Today)

**Human tasks:**
- [ ] Review and approve M2-PLAN.md
- [ ] Add schema columns to Spec DO (preview_url, shadow_* fields)
- [ ] Create Analytical Engine instance in Cloudflare dashboard
- [ ] Grant agents access to new services (Workers Builds, Analytics Engine)

**Agent tasks:**
- [ ] Create this M2-PLAN.md document
- [ ] Set up development worktree
- [ ] Create stub files for all new workers
- [ ] Update all wrangler.toml files with required bindings

**Deliverables:**
- ✅ M2-PLAN.md (this document)
- ✅ Schema updates committed
- ✅ Analytics Engine binding configured in all workers

---

### Phase 1: Workers Builds Previews (Day 1 - Oct 12, Morning)

**Objective:** Enable creating Worker preview deployments for candidates

**Tasks:**

1. **Create Workers Builds client**
   - File: `workers/shared/builds.ts`
   - Functions: `createPreview(candidateId, repoUrl)`, `deletePreview(candidateId)`, `listPreviews()`
   - Uses Cloudflare API via `cf workers builds create` or REST API
   - Returns preview URL and build status

2. **Update Spec DO**
   - Add preview URL storage to candidate records
   - Add methods: `setPreviewUrl(candidateId, url)`, `clearPreviewUrl(candidateId)`
   - Update `claimSpec()` to optionally create preview

3. **Add API endpoints**
   - `POST /api/candidates/:id/preview` — Create preview for candidate
   - `GET /api/candidates/:id/preview` — Get preview status/URL
   - `DELETE /api/candidates/:id/preview` — Delete preview

4. **Update gate workflow**
   - After passing pre-merge, automatically trigger preview creation
   - Store preview URL in candidate record
   - Advance candidate to `passed_premerge` stage

**Testing:**
- Create a candidate
- Call preview endpoint
- Verify preview URL is returned and accessible

**Deliverables:**
- `workers/shared/builds.ts`
- Updates to `workers/spec-do/index.ts`
- Updates to `workers/api/index.ts`
- Updates to `workers/gate-workflow/index.ts`

**Time estimate:** 3-4 hours

---

### Phase 2: Edge Mirror Worker (Day 1 - Oct 12, Afternoon)

**Objective:** Mirror production traffic to candidate previews

**Tasks:**

1. **Create Shadow Router Worker**
   - File: `workers/shadow-router/index.ts`
   - Binding: `beehive-shadow` on workers.dev
   - Handles all requests, mirrors to candidate previews
   - Async Scientist comparison trigger

2. **Create wrangler config**
   - File: `workers/shadow-router/wrangler.toml`
   - Name: `beehive-shadow`
   - Bindings: SPEC_DO, SCIENTIST, API_AUTH_TOKEN
   - Routes: (optional for now)

3. **Update Spec DO**
   - Add method: `getShadowCandidates()` — Returns candidates in shadow stage
   - Track which candidates are receiving shadow traffic

4. **Add API endpoints**
   - `GET /api/shadow/config` — Get current shadow configuration
   - `POST /api/shadow/config` — Update shadow configuration
   - `GET /api/shadow/status` — Get shadow traffic status

**Testing:**
- Deploy shadow router
- Send test request
- Verify request is mirrored to candidate preview
- Verify production response is returned

**Deliverables:**
- `workers/shadow-router/` directory
- Updates to `workers/spec-do/index.ts`
- Updates to `workers/api/index.ts`

**Time estimate:** 3-4 hours

---

### Phase 3: Scientist Comparator (Day 2 - Oct 13, Morning)

**Objective:** Compare candidate responses against baseline and declared surface

**Tasks:**

1. **Create Scientist Comparator Worker**
   - File: `workers/scientist-comparator/index.ts`
   - Binding: `beehive-scientist` on workers.dev
   - Compares responses from baseline vs candidate
   - Validates against declared delta surface

2. **Create comparison logic library**
   - File: `workers/shared/scientist.ts`
   - Functions: `compareStatusCodes()`, `compareBodies()`, `compareHeaders()`, `validateDeclaredSurface()`
   - Returns comprehensive comparison result

3. **Create wrangler config**
   - File: `workers/scientist-comparator/wrangler.toml`
   - Name: `beehive-scientist`
   - Bindings: SPEC_DO, ANALYTICS, API_AUTH_TOKEN

4. **Update Spec DO**
   - Add method: `recordShadowVerdict(candidateId, verdict)`
   - Store shadow gate results in gate_verdicts table

**Testing:**
- Send test requests through shadow router
- Verify Scientist receives comparison requests
- Verify verdicts are recorded in Spec DO

**Deliverables:**
- `workers/scientist-comparator/` directory
- `workers/shared/scientist.ts`
- Updates to `workers/spec-do/index.ts`

**Time estimate:** 4-5 hours

---

### Phase 4: Analytics Engine (Day 2 - Oct 13, Afternoon)

**Objective:** Record and query per-candidate metrics

**Tasks:**

1. **Create Analytics Engine client**
   - File: `workers/shared/analytics.ts`
   - Functions: `writeMetric(metric)`, `queryMetrics(query, params)`
   - Handles Analytics Engine data points and queries

2. **Instrument Scientist Comparator**
   - Record metrics for each comparison
   - Track: request count, latency, match rate, diff severity

3. **Instrument Shadow Router**
   - Record metrics for each mirrored request
   - Track: request count, total latency, success rate

4. **Add API endpoints**
   - `GET /api/candidates/:id/metrics` — Get metrics for candidate
   - `GET /api/specs/:id/metrics` — Get metrics for spec
   - `GET /api/metrics/summary` — Get overall metrics

**Testing:**
- Send test requests
- Verify metrics are written to Analytics Engine
- Query metrics via API

**Deliverables:**
- `workers/shared/analytics.ts`
- Updates to `workers/scientist-comparator/index.ts`
- Updates to `workers/shadow-router/index.ts`
- Updates to `workers/api/index.ts`

**Time estimate:** 3-4 hours

---

### Phase 5: Integration & Wiring (Day 3 - Oct 14, Morning)

**Objective:** Wire all components together into a coherent flow

**Tasks:**

1. **Update Shadow Router**
   - Integrate Scientist Comparator calls
   - Pass all required data (request, responses, candidate info)

2. **Update Gate Workflow**
   - After pre-merge pass, advance to shadow stage
   - Trigger preview creation
   - Record stage transition in Spec DO

3. **Update Queue Consumer**
   - For candidates in shadow stage, ensure they're eligible for mirroring
   - Handle shadow-specific events

4. **Update Spec DO**
   - Add stage transition logic for shadow
   - Ensure all new fields are properly handled

5. **Create integration test**
   - Test end-to-end: create spec → claim → develop → push → gate → preview → shadow → compare → metrics

**Testing:**
- Run full integration test
- Verify all components work together
- Fix any wiring issues

**Deliverables:**
- Integration tests in `scripts/`
- All components wired together

**Time estimate:** 4-5 hours

---

### Phase 6: Final Verification & Documentation (Day 3 - Oct 14, Afternoon)

**Objective:** Verify M2 works end-to-end and prepare for submission

**Tasks:**

1. **End-to-end verification**
   - Run `scripts/verify-m2.sh` (to be created)
   - Verify all 5 M2 components working
   - Fix any remaining issues

2. **Create demo script**
   - File: `scripts/demo-m2.sh`
   - Automated demonstration of M2 flow
   - Can be run during competition judging

3. **Update documentation**
   - Update `README.md` with M2 features
   - Update `docs/ARCHITECTURE.md` with new components
   - Update `docs/MILESTONES.md` status
   - Add `docs/M2-IMPLEMENTATION.md` with details

4. **Cleanup and polish**
   - Remove debug logging
   - Ensure all secrets are properly handled
   - Verify all workers deploy successfully

**Deliverables:**
- `scripts/verify-m2.sh`
- `scripts/demo-m2.sh`
- Updated documentation
- All workers deployed and verified

**Time estimate:** 3-4 hours

---

## File Changes Summary

### New Files

```
workers/
├── shadow-router/
│   ├── index.ts
│   └── wrangler.toml
├── scientist-comparator/
│   ├── index.ts
│   └── wrangler.toml
└── shared/
    ├── builds.ts
    ├── scientist.ts
    └── analytics.ts

scripts/
├── verify-m2.sh
└── demo-m2.sh

docs/
└── M2-IMPLEMENTATION.md
```

### Modified Files

```
workers/spec-do/
├── index.ts (preview URLs, shadow verdicts, stage transitions)
└── schema-inline.ts (new columns)

workers/api/
└── index.ts (preview endpoints, metrics endpoints, shadow endpoints)

workers/gate-workflow/
└── index.ts (advance to shadow after pre-merge pass)

workers/queue-consumer/
└── index.ts (shadow stage handling)

wrangler.toml (root) - service bindings
workers/*/wrangler.toml - Analytics Engine bindings
```

---

## Resource Requirements

### Cloudflare Services

| Service | Purpose | Already Configured |
|---------|---------|---------------------|
| Workers | All workers | ✅ Yes |
| Durable Objects | Spec DO | ✅ Yes |
| Queues | Push events | ✅ Yes |
| Artifacts | Candidate repos | ✅ Yes |
| Workers Builds | Preview deployments | ❌ No |
| Analytics Engine | Metrics | ❌ No |

**Action items:**
- Create Analytics Engine instance
- Configure Workers Builds permissions
- Add bindings to all workers

### API Tokens & Permissions

Required scopes:
- `Workers Scripts:Edit` — Already have
- `Workers Queues:Edit` — Already have
- `Workers Builds:Edit` — Need to add
- `Analytics Engine:Edit` — Need to add
- `Artifacts:Edit` — Already have

---

## Risk Assessment

### Low Risk ✅

| Risk | Mitigation | Probability |
|------|------------|-------------|
| Builds API changes | Use documented REST API, not CLI | Low |
| Analytics Engine unavailable | Fallback to logs for demo | Low |
| Preview creation fails | Manual fallback with `wrangler deploy` | Low |

### Medium Risk ⚠️

| Risk | Mitigation | Probability |
|------|------------|-------------|
| Shadow traffic affects production | Discard responses, never return to users | Low |
| Scientist false positives | Start with simple comparisons (status code only) | Medium |
| Performance overhead | Limit to small % of traffic initially | Medium |

### High Risk ❌

| Risk | Mitigation | Probability |
|------|------------|-------------|
| Deadline miss | Focus on MV2, defer nice-to-haves | Medium |
| Spine code breaks | Human review of all schema changes | Low |

---

## Success Criteria

### Must Have (Blocking)

- [x] Workers Builds client can create and delete previews (Preview Manager Worker with Workers Builds API integration)
- [x] Shadow Router mirrors requests to at least 1 candidate (Shadow Router Worker deployed, verified)
- [x] Scientist Comparator compares responses and records verdicts (Scientist Comparator Worker deployed with delta surface validation)
- [x] Analytics Engine receives and stores metrics (Analytics Engine dataset `beehive-metrics` with 10+ rows)
- [x] End-to-end flow works: spec → claim → develop → push → gate → preview → shadow → compare → metrics (Verified via E2E test script)
- [x] All M1 functionality preserved (All 4 M1 workers still deployed and healthy)

### Should Have (Nice-to-have)

- [x] Automatic preview creation on pre-merge pass (Preview Manager Worker triggered via queue-consumer service binding)
- [ ] Automatic shadow traffic enablement (Manual configuration still required)
- [x] Multiple candidate mirroring (Shadow Router supports N candidates)
- [x] Advanced declared surface validation (Full delta surface parsing and comparison)
- [ ] Complex Analytics Engine queries (Basic queries implemented; advanced deferred)
- [ ] Authentication on shadow path (Not required for demo; can be added later)

### Won't Have (Deferred to M3+)

- [ ] Canary deployments
- [ ] Auto-rollback
- [ ] Statsig slicing
- [ ] Tournament mode
- [ ] Two-person merge rule (M5)

---

## Go/No-Go Checklist

Before starting M2 implementation (All completed):

- [x] Human approves M2-PLAN.md
- [x] Schema changes reviewed and approved (Migration system added to Spec DO)
- [x] Analytics Engine instance created (`beehive-metrics` dataset)
- [x] Workers Builds permissions granted
- [x] Development environment ready
- [x] All M1 tests passing

---

## Next Steps

**M2 is COMPLETE. Next milestone: M3 (Promotion train + canary, post-submission).**

All M2 components deployed and verified:
1. Workers Builds Previews per candidate — Complete
2. Edge Mirror Worker — Complete
3. Scientist Comparator — Complete
4. Analytics Engine per-candidate metrics — Complete
5. Queue and service binding infrastructure — Complete

**For M3:** See `docs/MILESTONES.md` for Promotion train + canary requirements.

---

## Appendix A: Glossary

| Term | Definition |
|------|------------|
| **Workers Builds** | Cloudflare's build system for Workers, supports preview deployments |
| **Preview Deployment** | Temporary, isolated Worker instance for testing |
| **Shadow Traffic** | Production traffic mirrored to candidates, responses discarded |
| **Scientist** | Pattern for comparing multiple implementations of the same function |
| **Declared Delta Surface** | The spec's definition of what behaviors are allowed to change |
| **Analytics Engine** | Cloudflare's time-series metrics database |
| **Spine** | Hand-written core: spec schema, DO ledger, promotion train |
| **Leaf** | Agent-written: candidates, tests, glue, API endpoints |

---

## Appendix B: References

- Cloudflare Workers Builds: https://developers.cloudflare.com/workers/platform/builds/
- Cloudflare Analytics Engine: https://developers.cloudflare.com/analytics/
- Scientist Pattern: https://github.com/github/scientist
- TypeScript: Everywhere (per architectural rule)

---

## Appendix C: Commit Message Template

```
step: <component> | task: m2-<feature> | spec: n/a | confidence: <0-1>

- Description of changes
- Files modified
- Test coverage
```

---

*Document created: 2026-10-11*
*Completed: 2026-10-12 (2 days ahead of deadline)*
*Owner: Beehive Code Agents*
