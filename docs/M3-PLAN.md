---
category: planning
status: completed
milestone: m3
audience: human,agent
tags:
  - phase-report
---

# M3 Implementation Plan — Promotion Train + Canary

**Status:** PLANNED  
**Created:** 2026-10-13  
**Period:** Post-submission (2026-10-14+) unless time allows  
**Owner:** Code Agents (Leaf Work) + Human (Spine Work as needed)  
**Milestone:** Promotion train + canary — Statsig slicing, speculative projection forks, tournament vs merge-train modes, canary with auto-rollback

---

## Executive Summary

**M1 is COMPLETE.** The spec trials pipeline with DO ledger, actor identity, and complexity delta works end-to-end.

**M2 is COMPLETE.** All 5 M2 components deployed: Workers Builds Previews, Shadow Router, Scientist Comparator, Analytics Engine metrics, queue and service binding infrastructure. Full empirical oracle pipeline verified.

**M3 introduces production-grade promotion mechanics.** Building on the oracle ladder, M3 implements the **Train** and **Canary** rungs:
- **Statsig slicing** for traffic percentage allocation to canary deployments
- **Speculative projection forks** for testing candidates with shadow traffic before promotion
- **Tournament vs merge-train modes** for configurable promotion strategies
- **Canary with auto-rollback** for safe live deployments with SLO-based automatic rollback

**Current state:** M3 is **PLANNED** - no implementation exists yet. Schema foundations are present (candidate stages include `passed_canary` and `rolled_back`, promotions table supports `from_rung`/`to_rung` including canary and full).

**Feasibility:** YES — for post-submission hardening phase. Time constraints for 2026-10-14 deadline make M3 suitable for M4 submission package preparation rather than pre-deadline completion.

---

## M3 Scope (From MILESTONES.md)

M3 delivers **core promotion mechanics with Varda-inspired architectural foundation:**

### Core Components
1. ⏳ **Statsig slicing** — Traffic percentage allocation for canary deployments (1%, 5%, 10%, 25%, 50%)
2. ⏳ **Speculative projection forks** — Create candidate forks for testing with shadow traffic projection
3. ⏳ **Tournament vs merge-train modes** — Different promotion strategies (multiple candidates compete vs sequential merging)
4. ⏳ **Canary with auto-rollback** — Canary deployment worker with SLO monitoring and automatic rollback on violation

### Varda-Inspired Spine Work (Architectural Foundation)
5. ⏳ **Durable Object Facets for per-candidate isolation** — Spec DO spawns a facet (with isolated SQLite) for each candidate; supervisor pattern controls access
6. ⏳ **Basic capability minting** — Gate verdicts grant time-bound, scoped capabilities to agents (read-only trial access, merge permission)
7. ⏳ **Shadow → Train transition via facets** — Each train car = isolated facet for safe concurrent promotion
8. ⏳ **Local workerd validation** — Ensure spine runs locally for demo and development
9. ⏳ **ArtifactFS integration** — Mount candidate repos as lazy-loaded filesystems; agents hydrate only files they touch (no full clones)
10. ⏳ **Capability-scoped mounting** — Spec DO mints capabilities with path restrictions; ArtifactFS respects these scopes at mount time

**Exit criteria:** Promotion pipeline operational with isolated candidate execution; capability-based access control between Spec DO and candidate grains; ArtifactFS lazy-loading verified for agent workspaces.

---

## Key Questions Answered

### 1. What does Statsig slicing mean and how do we implement it?

**What it is:** **Statsig** is a feature management platform that provides traffic splitting capabilities. We use it to allocate a percentage of live production traffic to canary deployments while maintaining a holdout group for baseline comparison.

**Implementation approach:**

```typescript
// In Canary Router Worker (beehive-canary)

interface CanaryConfig {
  enabled: boolean;
  trafficPercentage: number; // 0.01 = 1%, 0.05 = 5%, etc.
  candidateId: string;
  holdoutPercentage: number; // Typically 50% - traffic that always goes to production
  gate: 'canary' | 'full';
}

// Statsig SDK integration
import { Statsig } from '@statsig/sdk';

const statsig = new Statsig('beehive-canary-key');

function getCanaryAllocation(userId: string, candidateId: string): CanaryAllocation {
  const allocation = statsig.getExperiment(
    `canary_${candidateId}`,
    userId,
    {
      customIDs: { candidateId },
      // Pre-configured allocation in Statsig dashboard
    }
  );
  
  return {
    userId,
    candidateId,
    allocatedToCanary: allocation.parameterValue === 'canary',
    allocationGroup: allocation.parameterValue, // 'canary' | 'holdout' | 'production'
  };
}

// Edge router logic
function routeRequest(request: Request, env: Env): Response {
  const userId = getUserIdFromRequest(request);
  const candidate = await getCanaryCandidate(env.SPEC_DO);
  
  if (candidate) {
    const allocation = getCanaryAllocation(userId, candidate.id);
    
    if (allocation.allocatedToCanary) {
      // Route to canary worker
      return routeToCanaryWorker(request, candidate.previewUrl, env);
    }
    // Route to production
    return routeToProduction(request, env);
  }
  
  // No canary active - route to production
  return routeToProduction(request, env);
}
```

**Statsig configuration in dashboard:**
- Experiment: `canary_${candidateId}` per candidate
- Parameter: `allocation` with values `canary`, `holdout`, `production`
- Traffic allocation: Configurable percentages via Statsig UI
- Dynamic configuration: Can adjust without redeployment

**Files needed:**
- `workers/canary-router/index.ts` — New Worker for canary traffic routing
- `workers/canary-router/wrangler.toml` — Worker config with Statsig SDK
- `workers/shared/statsig.ts` — Statsig client library
- `package.json` — Add `@statsig/sdk` dependency

**Leaf work:** Entirely agent-writable (Worker implementation, client library, configuration)

---

### 2. What are speculative projection forks and how do they work?

**What it is:** A **projection fork** is a speculative deployment of a candidate that receives **mirrored production traffic** (like shadow) but with the purpose of **predicting** how the candidate would perform under real load before actual promotion. Unlike pure shadow testing (discard responses), projection forks can optionally return responses to a subset of users or use synthetic load testing.

**Use cases:**
1. **Performance projection:** Estimate latency, error rates, resource usage
2. **Capacity planning:** Predict infrastructure requirements
3. **Risk scoring:** Calculate promotion risk based on projected metrics
4. **Tournament evaluation:** Compare multiple candidates simultaneously

**Implementation approach:**

```
┌─────────────────────────────────────────────────────────────────┐
│                  SPECULATIVE PROJECTION FLOW                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────┐     ┌─────────────────┐     ┌───────────────┐   │
│  │ Production  │────►│  Train Router    │────►│ Projection   │   │
│  │   Worker    │     │  (beehive-train) │     │  Workers      │   │
│  └─────────────┘     └────────┬────────┘     │ (Preview N)    │   │
│                             │                    └──────┬────────┘   │
│                             │                           │            │
│                    ┌────────────┴────────────┐            │
│                    │                             │            │
│                    ▼                             ▼            │
│              ┌─────────────┐             ┌─────────────┐       │
│              │  Collect     │             │  Aggregate   │       │
│              │  Metrics    │             │  Projection │       │
│              └──────┬──────┘             │  Results    │       │
│                     │                       └──────┬──────┘       │
│                     │                              │            │
│                     └──────────────────────────┼────────────┘   │
│                                              │                   │
│                    ┌─────────────────────────────┼─────┐       │
│                    │                           │         │       │
│                    ▼                           ▼         ▼       │
│              ┌─────────────┐          ┌────────┐ ┌────────┐    │
│              │  Spec DO    │          │  Stats  │ │  Risk   │    │
│              │  (Update    │          │  &     │ │  Score  │    │
│              │   metrics)  │          │  SLOs  │ │         │    │
│              └─────────────┘          └────────┘ └────────┘    │
│                                                                     │
└─────────────────────────────────────────────────────────────────┘
```

**Projection types:**

```typescript
// workers/shared/projection.ts

type ProjectionType = 'shadow' | 'synthetic' | 'live-slice';

interface ProjectionConfig {
  type: ProjectionType;
  candidateIds: string[];
  trafficPercentage: number; // For live-slice: % of production traffic
  syntheticLoad?: {
    rps: number; // Requests per second
    duration: number; // Seconds
    payload?: any;
  };
  metricsToTrack: MetricType[];
}

// Shadow projection (M2-style, discard responses)
function shadowProjection(candidateId: string, env: Env): ProjectionResult {
  // Use existing shadow router infrastructure
  // Collect metrics without affecting users
}

// Synthetic projection (load testing)
function syntheticProjection(config: ProjectionConfig, env: Env): ProjectionResult {
  // Generate synthetic traffic at configured RPS
  // Measure performance under load
}

// Live slice projection (small % of real traffic)
function liveSliceProjection(config: ProjectionConfig, env: Env): ProjectionResult {
  // Route small % of production traffic to candidate
  // Return responses to users (unlike shadow)
}
```

**Files needed:**
- `workers/train-router/index.ts` — New Worker for train traffic management
- `workers/train-router/wrangler.toml` — Worker config
- `workers/shared/projection.ts` — Projection library
- Updates to `workers/spec-do/index.ts` — Store projection results

**Leaf work:** Entirely agent-writable (Worker implementation, projection logic, metrics collection)

---

### 3. What are tournament vs merge-train modes and how do they differ?

**What they are:** Two different **promotion strategies** for advancing candidates through the oracle ladder.

**Tournament Mode:**
- **Multiple candidates compete simultaneously** for the same spec
- **Winner takes all** - only the best candidate is promoted
- **Head-to-head comparisons** between all candidates
- **Best for:** specs with clear winning criteria, multiple independent implementations
- **Example:** 5 agents submit URL shortener implementations → compare all → promote 1 winner

**Merge-Train Mode:**
- **Candidates are promoted sequentially** in order of arrival or priority
- **Each candidate must pass all gates** before next is considered
- **Merged into production one at a time**
- **Best for:** incremental improvements, linear development workflows
- **Example:** Candidate A passes shadow → promoted to train; Candidate B waits for A to reach canary

**Comparison:**

| Aspect | Tournament Mode | Merge-Train Mode |
|--------|-----------------|------------------|
| Competition | Multiple candidates simultaneously | Sequential, one at a time |
| Promotion speed | Faster (parallel testing) | Slower (serial testing) |
| Risk | Higher (more candidates in flight) | Lower (fewer concurrent) |
| Use case | Multiple independent implementations | Incremental improvements |
| Resource usage | Higher (all candidates deployed) | Lower (fewer deployments) |
| Winner selection | Best performer promoted | First to pass promoted |

**Implementation approach:**

```typescript
// workers/shared/promotion-modes.ts

type PromotionMode = 'tournament' | 'merge-train';

interface ModeConfig {
  mode: PromotionMode;
  tournament?: {
    candidateIds: string[];
    comparisonMethod: 'head-to-head' | 'round-robin' | 'score-based';
    maxConcurrent: number;
  };
  mergeTrain?: {
    queue: string[]; // Ordered list of candidate IDs
    priorityField?: string; // Field to use for ordering (created_at, score, etc.)
  };
}

function getNextPromotion(modeConfig: ModeConfig, env: Env): PromotionDecision {
  switch (modeConfig.mode) {
    case 'tournament':
      return getTournamentWinner(modeConfig.tournament!, env);
    case 'merge-train':
      return getNextInTrain(modeConfig.mergeTrain!, env);
  }
}

function getTournamentWinner(config: TournamentConfig, env: Env): PromotionDecision {
  // 1. Get all candidates in tournament
  const candidates = await getTournamentCandidates(config.candidateIds, env);
  
  // 2. Run head-to-head comparisons or score-based evaluation
  const results = await compareAllCandidates(candidates, config.comparisonMethod, env);
  
  // 3. Select winner
  const winner = selectWinner(results, candidates);
  
  return {
    candidateId: winner.id,
    action: 'promote',
    fromRung: 'shadow',
    toRung: 'canary',
    reason: `Tournament winner: ${winner.id}`,
    metrics: results,
  };
}

function getNextInTrain(config: MergeTrainConfig, env: Env): PromotionDecision {
  // 1. Get first candidate in queue that has passed current gate
  const nextCandidate = await findNextReadyCandidate(config.queue, env);
  
  if (!nextCandidate) {
    return { action: 'wait', reason: 'No candidates ready for promotion' };
  }
  
  return {
    candidateId: nextCandidate.id,
    action: 'promote',
    fromRung: nextCandidate.currentRung,
    toRung: getNextRung(nextCandidate.currentRung),
    reason: `Next in merge train: ${nextCandidate.id}`,
  };
}
```

**Configuration via Spec:**

```typescript
// Extended Spec schema
interface Spec {
  id: string;
  name: string;
  // ... existing fields
  promotionMode: PromotionMode;
  promotionConfig?: ModeConfig;
}
```

**Files needed:**
- `workers/shared/promotion-modes.ts` — Mode logic library
- Updates to `workers/spec-do/schema-inline.ts` — Add promotion_mode field to specs table
- Updates to `workers/gate-workflow/index.ts` — Mode-aware promotion logic

**Spine vs Leaf:**
- **Spine:** Spec schema changes (promotion_mode field) - Human
- **Leaf:** Mode logic implementation - Agent

---

### 4. What is canary with auto-rollback and how does it work?

**What it is:** A **canary deployment** routes a small percentage of live production traffic to a candidate implementation. **Auto-rollback** automatically reverts to the previous version if SLO (Service Level Objective) violations are detected.

**Oracle ladder position:**
- **Canary rung** comes after **Train** and before **Full**
- Traffic: small % live (typically 1-10%)
- Oracle: SLOs via Statsig + Analytics Engine
- Failure action: **auto-rollback** (ref operation)

**Implementation approach:**

```
┌─────────────────────────────────────────────────────────────────┐
│                      CANARY + AUTO-ROLLBACK FLOW                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Request ──► Edge Router ──► Canary Router ──► Canary Worker       │
│                                      │                                  │
│                                      │ Statsig Slicing                 │
│                                      │ (1-10% to canary, rest to prod) │
│                                      ▼                                  │
│                           ┌─────────────────┐                            │
│                           │ Canary Monitor   │                            │
│                           │ (Durable Object) │                            │
│                           └────────┬────────┘                            │
│                                    │                                     │
│                    ┌───────────────────┼───────────────────┐           │
│                    ▼                   ▼                   ▼           │
│              ┌────────────┐   ┌──────────────┐   ┌────────────┐      │
│              │ SLO Check   │   │ Metrics      │   │ Rollback   │      │
│              │ (Latency)   │   │ Collection   │   │ Trigger    │      │
│              └────────────┘   └──────────────┘   └────────────┘      │
│                                    │                                     │
│                                    ▼                                     │
│                           ┌─────────────────┐                            │
│                           │ Statsig +       │                            │
│                           │ Analytics Engine│                            │
│                           └─────────────────┘                            │
│                                    │                                     │
│                    ┌───────────────────┴───────────────────┐           │
│                    ▼                                           ▼           │
│              ┌────────────┐                           ┌────────────┐      │
│              │ SLO OK      │                           │ SLO VIOLATED│      │
│              │ Continue    │                           │ Rollback   │      │
│              │ Canary      │                           │ to Previous│      │
│              └────────────┘                           └────────────┘      │
│                                                                     │
└─────────────────────────────────────────────────────────────────┘
```

**SLO Definition:**

```typescript
// workers/shared/slo.ts

interface SLOConfig {
  name: string;
  description: string;
  metrics: SLOMetric[];
  window: number; // Seconds (e.g., 300 = 5 minutes)
  threshold: number; // 0-1, e.g., 0.99 = 99%
  severity: 'low' | 'medium' | 'high';
}

interface SLOMetric {
  type: 'latency' | 'error_rate' | 'match_rate' | 'throughput';
  aggregation: 'avg' | 'p50' | 'p95' | 'p99' | 'count';
  target: number;
  operator: '<' | '<=' | '>' | '>=' | '==' | '!=';
}

// Example canary SLO
const CANARY_SLO: SLOConfig = {
  name: 'canary-slo',
  description: 'Canary deployment SLO for URL shortener',
  window: 300, // 5 minutes
  threshold: 0.99, // 99% of requests must pass
  severity: 'high',
  metrics: [
    {
      type: 'latency',
      aggregation: 'p95',
      target: 100, // ms
      operator: '<=',
    },
    {
      type: 'error_rate',
      aggregation: 'count',
      target: 0,
      operator: '==',
    },
    {
      type: 'match_rate',
      aggregation: 'avg',
      target: 0.99,
      operator: '>=',
    },
  ],
};
```

**Auto-rollback trigger:**

```typescript
// workers/canary-monitor/index.ts (Durable Object)

interface CanaryState {
  candidateId: string;
  specId: string;
  startTime: number;
  currentRung: 'canary';
  sloConfigs: SLOConfig[];
  violationCount: number;
  rollbackCount: number;
}

class CanaryMonitorDO {
  state: CanaryState;
  env: Env;
  
  async checkSLOs(): Promise<RollbackDecision> {
    const metrics = await this.fetchMetrics();
    
    for (const slo of this.state.sloConfigs) {
      const passed = this.evaluateSLO(slo, metrics);
      
      if (!passed) {
        this.state.violationCount++;
        
        if (this.state.violationCount >= MAX_VIOLATIONS) {
          return {
            action: 'rollback',
            candidateId: this.state.candidateId,
            reason: `SLO ${slo.name} violated after ${this.state.violationCount} checks`,
            severity: slo.severity,
            timestamp: Date.now(),
          };
        }
      } else {
        this.state.violationCount = 0; // Reset on pass
      }
    }
    
    return { action: 'continue' };
  }
  
  async executeRollback(decision: RollbackDecision): Promise<void> {
    // 1. Update candidate stage in Spec DO
    await this.env.SPEC_DO.fetch(
      `/api/candidates/${this.state.candidateId}/rollback`,
      {
        method: 'POST',
        body: JSON.stringify({
          reason: decision.reason,
          timestamp: decision.timestamp,
        }),
      }
    );
    
    // 2. Update promotions table
    await this.recordRollbackInLedger(decision);
    
    // 3. Notify via webhook/queue
    await this.notifyRollback(decision);
    
    // 4. Update CanaryMonitor state
    this.state.rollbackCount++;
    this.state.currentRung = 'rolled_back';
  }
}
```

**Rollback as ref operation:**
Following the architectural rule: **Rollback is a ref operation** - promotion and demotion must remain equally cheap. In practice:
- **Rollback** = Update candidate stage to `rolled_back` in Spec DO
- **Promotion** = Update candidate stage to next rung
- Both are simple database updates, O(1) operations

**Files needed:**
- `workers/canary-router/index.ts` — New Worker for canary traffic routing
- `workers/canary-monitor/index.ts` — New Durable Object for SLO monitoring
- `workers/canary-monitor/wrangler.toml` — DO class definition
- `workers/shared/slo.ts` — SLO configuration and evaluation library
- Updates to `workers/spec-do/schema-inline.ts` — Add rollback-specific fields
- Updates to `workers/gate-workflow/index.ts` — Rollback trigger integration

---

### 5. Which parts require spine work (human) vs leaf work (agent)?

**Rule from AGENTS.md:**
> "The orchestration spine is hand-written. Spec schema, DO ledger, promotion train, Workflow sequencing are load-bearing walls. Code agents write leaf functions, glue, tests, and candidate services."

**Spine Work (Human-only):**
- ❌ Spec DO schema changes (new tables for canary state, promotion modes)
- ❌ Core promotion train logic (rung advancement rules)
- ❌ Workflow sequencing for canary monitoring
- ❌ Ledger lifecycle modifications for rollback
- ❌ Tournament/merge-train mode selection in spec schema

**Leaf Work (Agent-writable):**
- ✅ Canary Router Worker (`workers/canary-router/`)
- ✅ Canary Monitor DO (`workers/canary-monitor/`)
- ✅ Train Router Worker (`workers/train-router/`)
- ✅ Statsig client library (`workers/shared/statsig.ts`)
- ✅ SLO library (`workers/shared/slo.ts`)
- ✅ Projection library (`workers/shared/projection.ts`)
- ✅ Promotion modes library (`workers/shared/promotion-modes.ts`)
- ✅ API endpoints for canary management
- ✅ API endpoints for rollback triggering
- ✅ All wrangler.toml files
- ✅ Integration tests
- ✅ Glue code between components

**For M3, the division is:**

| Component | Type | Owner | Risk |
|-----------|------|-------|------|
| Canary Router Worker | Leaf | Agent | Low |
| Canary Monitor DO | Leaf | Agent | Low |
| Train Router Worker | Leaf | Agent | Medium |
| Statsig Integration | Leaf | Agent | Low |
| SLO Configuration | Leaf | Agent | Medium |
| Auto-Rollback Logic | Leaf | Agent | Medium |
| Spec DO schema (promotion modes, rollback fields) | Spine | Human | Medium |
| Core promotion train logic | Spine | Human | High |

**Spine changes needed for M3:**

The `specs` table needs a field for promotion mode, and `candidates`/`promotions` tables need additional rollback tracking:

```sql
-- In schema-inline.ts

-- Add to specs table:
ALTER TABLE specs ADD COLUMN promotion_mode TEXT 
  CHECK(promotion_mode IN ('tournament', 'merge-train', 'default')) 
  DEFAULT 'default';

ALTER TABLE specs ADD COLUMN promotion_config TEXT; -- JSON

-- Add to candidates table:
ALTER TABLE candidates ADD COLUMN rollback_reason TEXT;
ALTER TABLE candidates ADD COLUMN rollback_timestamp INTEGER;
ALTER TABLE candidates ADD COLUMN canary_started_at INTEGER;
ALTER TABLE candidates ADD COLUMN canary_ended_at INTEGER;

-- Add to promotions table:
ALTER TABLE promotions ADD COLUMN rollback_trigger TEXT;
ALTER TABLE promotions ADD COLUMN rollback_metrics TEXT;
```

**These schema changes are spine work** and must be done by a human. They are **additive** and **backward-compatible**.

---

### 6. Can we complete M3 before deadline (2026-10-14)?

**NO — M3 is post-deadline unless time allows.**

**Assessment:**
- M3 is explicitly marked as "post-deadline unless time allows" in MILESTONES.md
- Today is 2026-10-13 (submission day -1)
- M3 requires Statsig account setup (external dependency)
- M3 requires significant new infrastructure (4+ new workers/DOs)
- M2 was just completed on 2026-10-12
- Submission deadline is 2026-10-14

**Recommended approach:**
- **M3 remains PLANNED** for post-submission hardening phase
- **M4 (Submission package)** is the priority for 2026-10-14
- **M3 can be partially demonstrated** if basic canary routing is implemented
- **Full M3 implementation** is a M5+ activity

**Minimal viable M3 for post-submission:**

If time permits on 2026-10-13 evening or 2026-10-14 early:
- ✅ Basic canary routing without Statsig (simple percentage-based splitting)
- ✅ Canary worker that routes N% of traffic to candidate
- ❌ Statsig integration (requires account setup)
- ❌ Auto-rollback (requires SLO monitoring infrastructure)
- ❌ Tournament/merge-train modes (requires multiple candidates)
- ❌ Speculative projection forks (requires train infrastructure)

**MV3 size:** ~4-6 hours for basic canary routing only

---

### 7. What is minimal viable M3 for post-submission hardening?

**Definition:** The smallest implementation that proves the canary + rollback concept works end-to-end, suitable for post-submission iteration.

**Minimal Viable M3 (MV3):**

1. ✅ **Basic Canary Routing** — Simple percentage-based traffic splitting without Statsig
   - Route X% of traffic to canary candidate
   - Route (100-X)% to production
   - No external dependencies

2. ✅ **Canary Worker** — Dedicated worker for canary traffic handling
   - Receives canary traffic from router
   - Forwards to candidate preview
   - Returns responses to users

3. ✅ **Simple SLO Monitoring** — Basic metrics-based health checks
   - Track request count, error rate, average latency
   - Simple threshold checks (e.g., error rate < 1%)
   - In-memory or Spec DO-based tracking

4. ✅ **Manual Rollback** — Admin endpoint to trigger rollback
   - POST /api/candidates/:id/rollback
   - Updates candidate stage to `rolled_back`
   - Updates promotions table

5. ✅ **Metrics Dashboard** — Basic canary metrics visibility
   - GET /api/candidates/:id/canary/metrics
   - Returns current metrics for canary

**What can be deferred to later:**
- ❌ Statsig integration (external dependency)
- ❌ Auto-rollback (complex SLO monitoring)
- ❌ Tournament mode (requires multiple candidates)
- ❌ Merge-train mode (requires queue management)
- ❌ Speculative projection forks (requires shadow train)
- ❌ Advanced Analytics Engine queries

**MV3 size:** ~8-10 hours of implementation

---

## Implementation Plan

### Phase 0: Preparation (Post-submission)

**Human tasks:**
- [ ] Review and approve M3-PLAN.md
- [ ] Add schema columns to Spec DO (promotion_mode, rollback fields)
- [ ] Create Statsig account and get API keys
- [ ] Set up Statsig experiments for canary allocation
- [ ] Grant agents access to Statsig (if needed)

**Agent tasks:**
- [ ] Create this M3-PLAN.md document
- [ ] Set up development worktree
- [ ] Create stub files for all new workers
- [ ] Update all wrangler.toml files with required bindings
- [ ] Add dependencies to package.json

**Deliverables:**
- ✅ M3-PLAN.md (this document)
- ⏳ Schema updates committed
- ⏳ Statsig account configured

---

### Phase 1: Statsig Slicing (Post-submission, Day 1)

**Objective:** Implement Statsig-based traffic allocation for canary deployments

**Tasks:**

1. **Create Statsig client library**
   - File: `workers/shared/statsig.ts`
   - Functions: `getExperiment()`, `getAllocation()`, `logEvent()`
   - Initialize Statsig SDK with API key

2. **Create Canary Router Worker**
   - File: `workers/canary-router/index.ts`
   - Handle all requests, allocate to canary or production based on Statsig
   - Support multiple concurrent canary deployments

3. **Create wrangler config**
   - File: `workers/canary-router/wrangler.toml`
   - Name: `beehive-canary`
   - Bindings: SPEC_DO, STATSIG (or use env vars for API key)

4. **Add API endpoints**
   - `GET /api/canary/config` — Get current canary configuration
   - `POST /api/canary/config` — Update canary configuration
   - `GET /api/canary/allocations` — Get current allocations

**Testing:**
- Deploy canary router
- Configure Statsig experiment with 5% allocation
- Send test requests
- Verify 5% go to canary, 95% to production

**Deliverables:**
- `workers/shared/statsig.ts`
- `workers/canary-router/` directory
- Updates to `workers/api/index.ts`

**Time estimate:** 3-4 hours

---

### Phase 2: Speculative Projection Forks (Post-submission, Day 2)

**Objective:** Implement speculative projection forks for candidate testing

**Tasks:**

1. **Create Projection library**
   - File: `workers/shared/projection.ts`
   - Functions: `createProjectionFork()`, `runShadowProjection()`, `getProjectionResults()`
   - Support shadow, synthetic, and live-slice projection types

2. **Create Train Router Worker**
   - File: `workers/train-router/index.ts`
   - Handle train traffic allocation
   - Manage projection forks
   - Route to appropriate candidate or production

3. **Create wrangler config**
   - File: `workers/train-router/wrangler.toml`
   - Name: `beehive-train`
   - Bindings: SPEC_DO, PREVIEW_MANAGER, ANALYTICS

4. **Update Spec DO**
   - Add method: `getProjectionResults(candidateId)`
   - Add method: `storeProjectionResults(candidateId, results)`
   - Track projection metrics

5. **Add API endpoints**
   - `POST /api/candidates/:id/project` — Create projection fork
   - `GET /api/candidates/:id/projection` — Get projection results
   - `GET /api/projections` — List all active projections

**Testing:**
- Create projection fork for candidate
- Run shadow projection
- Verify metrics are collected
- Verify projection results are stored

**Deliverables:**
- `workers/shared/projection.ts`
- `workers/train-router/` directory
- Updates to `workers/spec-do/index.ts`
- Updates to `workers/api/index.ts`

**Time estimate:** 4-5 hours

---

### Phase 3: Tournament vs Merge-Train Modes (Post-submission, Day 3)

**Objective:** Implement configurable promotion modes

**Tasks:**

1. **Create Promotion Modes library**
   - File: `workers/shared/promotion-modes.ts`
   - Functions: `getNextPromotion()`, `getTournamentWinner()`, `getNextInTrain()`
   - Support tournament and merge-train logic

2. **Update Spec schema**
   - Add `promotion_mode` field to specs table
   - Add `promotion_config` field (JSON)

3. **Update Gate Workflow**
   - Integrate promotion mode logic
   - Handle mode-specific promotion rules
   - Update stage transitions based on mode

4. **Add API endpoints**
   - `GET /api/specs/:id/promotion-mode` — Get promotion mode
   - `POST /api/specs/:id/promotion-mode` — Set promotion mode
   - `GET /api/specs/:id/promotion-queue` — Get promotion queue (merge-train)

**Testing:**
- Set spec to tournament mode
- Create multiple candidates
- Verify tournament winner is selected
- Set spec to merge-train mode
- Verify sequential promotion

**Deliverables:**
- `workers/shared/promotion-modes.ts`
- Updates to `workers/spec-do/schema-inline.ts`
- Updates to `workers/gate-workflow/index.ts`
- Updates to `workers/api/index.ts`

**Time estimate:** 3-4 hours

---

### Phase 4: Canary with Auto-Rollback (Post-submission, Day 4-5)

**Objective:** Implement canary deployments with automatic SLO-based rollback

**Tasks:**

1. **Create SLO library**
   - File: `workers/shared/slo.ts`
   - Functions: `defineSLO()`, `evaluateSLO()`, `checkSLOs()`
   - Support multiple SLO configurations

2. **Create Canary Monitor Durable Object**
   - File: `workers/canary-monitor/index.ts`
   - Class: `CanaryMonitorDO`
   - Track canary state and metrics
   - Evaluate SLOs periodically
   - Trigger rollback on violation

3. **Create wrangler config**
   - File: `workers/canary-monitor/wrangler.toml`
   - DO class: `CanaryMonitorDO`
   - Bindings: SPEC_DO, ANALYTICS

4. **Update Canary Router**
   - Integrate Canary Monitor for SLO checking
   - Add rollback trigger
   - Handle rollback state

5. **Update Spec DO**
   - Add method: `triggerRollback(candidateId, reason)`
   - Add method: `getCanaryStatus(candidateId)`
   - Update candidate stage on rollback

6. **Add API endpoints**
   - `POST /api/candidates/:id/canary/start` — Start canary deployment
   - `POST /api/candidates/:id/canary/stop` — Stop canary deployment
   - `POST /api/candidates/:id/rollback` — Manual rollback trigger
   - `GET /api/candidates/:id/canary/metrics` — Get canary metrics
   - `GET /api/candidates/:id/canary/slo` — Get SLO status

**Testing:**
- Start canary deployment for candidate
- Configure SLO with latency threshold
- Send traffic to canary
- Trigger SLO violation (e.g., high latency)
- Verify auto-rollback triggers
- Verify candidate stage updated to `rolled_back`

**Deliverables:**
- `workers/shared/slo.ts`
- `workers/canary-monitor/` directory
- Updates to `workers/canary-router/index.ts`
- Updates to `workers/spec-do/index.ts`
- Updates to `workers/api/index.ts`

**Time estimate:** 5-6 hours

---

### Phase 5: Integration & Wiring (Post-submission, Day 6)

**Objective:** Wire all M3 components together into a coherent flow

**Tasks:**

1. **Update Canary Router**
   - Integrate with Train Router for projection
   - Integrate with Canary Monitor for SLO checking
   - Handle all edge cases

2. **Update Train Router**
   - Integrate with Projection library
   - Handle mode-specific routing

3. **Update Gate Workflow**
   - Integrate with promotion modes
   - Handle canary stage transitions
   - Trigger canary start after train pass

4. **Update Queue Consumer**
   - Handle canary-related events
   - Trigger canary monitoring

5. **Create integration tests**
   - Test end-to-end: candidate → train → canary → rollback
   - Test tournament mode
   - Test merge-train mode

**Testing:**
- Run full integration test
- Verify all components work together
- Fix any wiring issues

**Deliverables:**
- Integration tests in `scripts/`
- All components wired together

**Time estimate:** 4-5 hours

---

### Phase 6: Final Verification & Documentation (Post-submission, Day 7)

**Objective:** Verify M3 works end-to-end and prepare for M4 submission

**Tasks:**

1. **End-to-end verification**
   - Run `scripts/verify-m3.sh` (to be created)
   - Verify all 4 M3 components working
   - Fix any remaining issues

2. **Create demo script**
   - File: `scripts/demo-m3.sh`
   - Automated demonstration of M3 flow

3. **Update documentation**
   - Update `README.md` with M3 features
   - Update `docs/ARCHITECTURE.md` with new components
   - Update `docs/MILESTONES.md` status
   - Add `docs/M3-IMPLEMENTATION.md` with details

4. **Cleanup and polish**
   - Remove debug logging
   - Ensure all secrets are properly handled
   - Verify all workers deploy successfully

**Deliverables:**
- `scripts/verify-m3.sh`
- `scripts/demo-m3.sh`
- Updated documentation
- All workers deployed and verified

**Time estimate:** 3-4 hours

---

## File Changes Summary

### New Files

```
workers/
├── canary-router/
│   ├── index.ts
│   └── wrangler.toml
├── canary-monitor/
│   ├── index.ts
│   └── wrangler.toml
├── train-router/
│   ├── index.ts
│   └── wrangler.toml
└── shared/
    ├── statsig.ts
    ├── projection.ts
    ├── slo.ts
    └── promotion-modes.ts

scripts/
├── verify-m3.sh
└── demo-m3.sh

docs/
└── M3-IMPLEMENTATION.md
```

### Modified Files

```
workers/spec-do/
├── index.ts (promotion modes, rollback, projection results)
└── schema-inline.ts (promotion_mode, rollback fields, projection results)

workers/api/
└── index.ts (canary endpoints, projection endpoints, rollback endpoints)

workers/gate-workflow/
└── index.ts (canary stage transitions, mode-aware promotion)

workers/queue-consumer/
└── index.ts (canary event handling)

package.json - Statsig dependency
wrangler.toml (root) - service bindings for new workers
workers/*/wrangler.toml - Updated bindings
```

---

## Resource Requirements

### Cloudflare Services

| Service | Purpose | Already Configured |
|---------|---------|---------------------|
| Workers | All workers | ✅ Yes |
| Durable Objects | Spec DO, Canary Monitor | ✅ Yes (Spec DO) |
| Queues | Events and messages | ✅ Yes |
| Artifacts | Candidate repos | ✅ Yes |
| Workers Builds | Preview deployments | ✅ Yes |
| Analytics Engine | Metrics | ✅ Yes |

**New requirements for M3:**
- **Statsig account** - Need to create and configure
- **Statsig API key** - Need for SDK integration
- **New Workers** - Canary Router, Train Router (2 new)
- **New Durable Objects** - Canary Monitor (1 new DO class)

### External Services

| Service | Purpose | Required |
|---------|---------|----------|
| Statsig | Traffic splitting, feature flags | ✅ Required |

**Action items:**
- Create Statsig account
- Configure Statsig experiments for canary allocation
- Get Statsig API keys for Workers integration
- Add Statsig SDK to dependencies

### API Tokens & Permissions

Required scopes for new Workers:
- `Workers Scripts:Edit` — Already have
- `Workers Queues:Edit` — Already have
- `Workers Builds:Edit` — Already have
- `Analytics Engine:Edit` — Already have
- **Statsig API token** — Need to add as secret to all relevant workers

---

## Risk Assessment

### Low Risk ✅

| Risk | Mitigation | Probability |
|------|------------|-------------|
| Statsig unavailable | Fallback to simple percentage splitting | Low |
| Projection overhead | Limit projection concurrency | Low |
| Tournament mode complexity | Start with merge-train only | Low |

### Medium Risk ⚠️

| Risk | Mitigation | Probability |
|------|------------|-------------|
| Auto-rollback false positives | Require multiple SLO violations | Medium |
| Statsig integration issues | Test with Statsig sandbox first | Medium |
| Performance impact on production | Use small canary percentages initially | Medium |
| DO memory limits for Canary Monitor | Store minimal state, use Analytics Engine for metrics | Medium |

### High Risk ❌

| Risk | Mitigation | Probability |
|------|------------|-------------|
| Statsig account not available | Implement without Statsig first (basic splitting) | Low |
| Spine code breaks | Human review of all schema changes | Low |

---

## Success Criteria

### Must Have (Blocking)

- [ ] Statsig integration functional (or basic percentage splitting as fallback)
- [ ] Basic canary deployment capability (traffic splitting to candidate)
- [ ] Canary Worker routing traffic correctly
- [ ] Auto-rollback mechanism implemented (SLO monitoring + trigger)
- [ ] Rollback is a ref operation (simple stage update, O(1))
- [ ] All M2 functionality preserved

### Should Have (Nice-to-have)

- [ ] Speculative projection forks (shadow projection)
- [ ] Tournament mode implementation
- [ ] Merge-train mode implementation
- [ ] Comprehensive canary metrics dashboard
- [ ] Automated promotion decision logic
- [ ] Synthetic load testing for projection

### Won't Have (Deferred to M4+)

- [ ] Live slice projection (complex traffic routing)
- [ ] Advanced Statsig experimentation features
- [ ] Multi-region canary deployments
- [ ] Blue-green deployments

---

## Go/No-Go Checklist

Before starting M3 implementation:

- [ ] Human approves M3-PLAN.md
- [ ] Schema changes reviewed and approved
- [ ] Statsig account created and configured
- [ ] Statsig API keys available
- [ ] All M2 tests passing
- [ ] Development environment ready

---

## Next Steps

**M3 is PLANNED for post-submission.** M4 (Submission package) is the priority for 2026-10-14.

After submission:
1. **Set up Statsig** - Account, experiments, API keys
2. **Implement Canary Router** - Basic traffic splitting first
3. **Implement Canary Monitor** - SLO checking and rollback
4. **Implement Train Router** - Projection forks
5. **Implement Promotion Modes** - Tournament and merge-train
6. **Integrate and test** - End-to-end verification

**For M4:** See `docs/MILESTONES.md` for Submission package requirements.

---

## Appendix A: Glossary

| Term | Definition |
|------|------------|
| **Statsig** | Feature management platform for traffic splitting and experimentation |
| **Canary Deployment** | Routing small % of production traffic to a new version |
| **Holdout** | Traffic that always goes to production for baseline comparison |
| **Auto-Rollback** | Automatic reversion to previous version on SLO violation |
| **Projection Fork** | Speculative deployment for testing with shadow/synthetic traffic |
| **Tournament Mode** | Multiple candidates compete, winner promoted |
| **Merge-Train Mode** | Candidates promoted sequentially |
| **SLO** | Service Level Objective - measurable reliability target |
| **Spine** | Hand-written core: spec schema, DO ledger, promotion train |
| **Leaf** | Agent-written: candidates, tests, glue, API endpoints |
| **DO** | Durable Object - Cloudflare's stateful storage primitive |

---

## Appendix B: References

- Cloudflare Workers: https://developers.cloudflare.com/workers/
- Cloudflare Durable Objects: https://developers.cloudflare.com/workers/learning/using-durable-objects/
- Cloudflare Analytics Engine: https://developers.cloudflare.com/analytics/
- Statsig: https://www.statsig.com/
- Statsig SDK: https://docs.statsig.com/
- TypeScript: Everywhere (per architectural rule)

---

## Appendix C: Commit Message Template

```
step: <component> | task: m3-<feature> | spec: <clause> | confidence: <0-1>

- Description of changes
- Files modified
- Test coverage
```

---

*Document created: 2026-10-13*
*Status: PLANNED (Post-submission)*
*Owner: Beehive Code Agents*
