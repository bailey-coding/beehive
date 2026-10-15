---
category: planning
status: completed
milestone: m1
audience: human,agent
tags:
  - phase-report
---

# M1 Implementation Plan — Spec Trials, No Live Traffic

**Status:** COMPLETE  
**Created:** 2026-10-11  
**Completed:** 2026-10-11  
**Owner:** Beehive Spike (Human - Spine Work) + Code Agents (Leaf Work)  
**Milestone:** Spec trials — no live traffic, tests-only oracle pipeline

---

## Executive Summary

**M1 is COMPLETE.** The pre-merge oracle pipeline (Spec → Claim → Fork → Push → Queue → Gate → Verdict) works end-to-end. All 7 M1 components deployed and verified with real Cloudflare Artifacts integration. The Spike phase (prerequisite for M1) completed 2026-10-11 with exit criteria met: 3 forks, 3 pushes (first-writer-wins verified against real Artifacts), 3 events, zero manual steps — validated locally (Miniflare, 13/13) and remotely.

**M1 delivers the foundation for agent-native spec trials:**
- **Spec schema** with contract, acceptance criteria, and declared delta surface
- **Orchestrator Worker** coordinating fork → sandbox → cheap-model agents
- **Queue-driven push events** → Gate Workflow with tests-only validation
- **Durable Object ledger** tracking scores, actor identity, and complexity delta
- **Trial UI** for candidate comparison visualization
- **Ledger lifecycle** with soft-delete/tombstones for data safety
- **Admin purge route** for test-data cleanup (authenticated, maintainer-only)

**Feasibility:** YES — M1 completed in 1 day (Oct 11) following Spike completion. All components deployed behind fail-closed auth gate and verified against real Cloudflare Artifacts.

---

## M1 Scope (From MILESTONES.md)

M1 delivers **7 components:**

1. ✅ **Spec schema** — Contract + acceptance + declared delta surface definition
2. ✅ **Orchestrator Worker** — Main `beehive` worker (edge router + API entry point) coordinating fork → sandbox → cheap-model agents
3. ✅ **Push event → Queue** — Cloudflare Artifacts push events routed to queue for async processing
4. ✅ **Gate Workflow (tests only)** — Pre-merge gate with automated tests, property checks, and spec conformance validation
5. ✅ **DO ledger** — SQLite-based Durable Object tracking scores, actor identity, complexity delta
6. ✅ **Trial UI** — Web interface showing candidate comparison and trial results
7. ✅ **Ledger lifecycle** — Soft-delete/tombstones implementation with authenticated admin purge route

---

## Component Breakdown

### 1. Spec Schema (Contract + Acceptance + Declared Delta Surface)

**What it is:** The machine-readable contract that defines what a spec requires, how implementations are validated, and what behaviors are expected to change (declared delta surface).

**Implementation:**
- **File:** `workers/spec-do/schema-inline.ts`
- **Tables:** `specs`, `candidates`, `gate_verdicts`, `trials`, `organizations`, `repositories`, `actors`
- **Schema version:** M1

**Spec structure:**
```typescript
interface Spec {
  id: string;
  name: string;
  description?: string;
  contract: string; // JSON: endpoints, models, workflow
  declared_delta_surface: string; // JSON: array of changed behaviors
  organization_id: string;
  created_by: string;
  stage: 'draft' | 'proposed' | 'active' | 'deprecated' | 'archived';
  created_at: number;
}
```

**Contract schema example:**
```json
{
  "endpoints": [
    {"path": "/shorten", "method": "POST", "response": {"type": "ShortUrl"}},
    {"path": "/redirect/:id", "method": "GET", "response": {"type": "RedirectResponse"}}
  ],
  "models": {
    "ShortUrl": {"id": "string", "url": "string", "createdAt": "number"},
    "RedirectResponse": {"url": "string", "clicks": "number"}
  }
}
```

**Declared delta surface example:**
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

**Files:**
- `workers/spec-do/schema-inline.ts` — SQLite schema as TypeScript constant
- `workers/spec-do/schema.sql` — SQL schema source

**Spine work:** Hand-written by human per sequencing rule (core ledger schema)

---

### 2. Orchestrator Worker (Fork → Sandbox → Cheap-model Agents)

**What it is:** The main edge router and API entry point that coordinates the M1 workflow: creating forks, running sandboxed agents, and managing the spec-to-candidate pipeline.

**Implementation:**
- **File:** `workers/api/index.ts` — Main API worker
- **File:** `workers/spec-do/index.ts` — Spec Durable Object (state management)
- **File:** `wrangler.toml` (root) — Main worker configuration

**Workflow:**
```
1. Agent claims spec via POST /api/specs/{id}/claim
2. Orchestrator creates candidate repository (baseline fork)
3. Sandbox Runner clones candidate repo
4. Agent implements spec in candidate repo
5. Agent commits and pushes to candidate repo
6. Push event triggers Queue Consumer
7. Queue Consumer calls Gate Workflow for validation
```

**Endpoints:**
- `POST /api/specs/{id}/claim` — Agent claims a spec to implement
- `POST /api/candidates` — Create candidate implementation
- `GET /api/specs` — List all specs
- `GET /api/candidates` — List all candidates
- `GET /api/trials` — List all trials

**Files:**
- `workers/api/index.ts` — API endpoints
- `workers/api/types.ts` — TypeScript interfaces

**Leaf work:** API endpoints and glue code are agent-writable

---

### 3. Push Event → Queue Infrastructure

**What it is:** Cloudflare Artifacts push events are captured and routed through Queues for asynchronous processing, decoupling the event source from the gate workflow.

**Implementation:**
- **File:** `workers/queue-consumer/index.ts` — Queue message consumer
- **Binding:** `beehive-artifacts-push` queue
- **Event type:** Artifacts push events from candidate repositories

**Event flow:**
```
Cloudflare Artifacts
    │ Push Event (candidate repo)
    ▼
beehive-artifacts-push Queue
    │ Message: {event: ArtifactsPushEvent, received_at: timestamp}
    ▼
Queue Consumer Worker
    │ Validates message with Zod schema
    │ Looks up candidate by repository
    ▼
Gate Workflow Worker (via Service Binding)
    │ Runs pre-merge validation
    ▼
Spec DO Ledger
    │ Records gate_verdicts
```

**Queue message schema:**
```typescript
interface ArtifactsPushEvent {
  id: string;
  type: 'push';
  repository: {
    name: string;
    namespace: string;
    full_name: string;
  };
  commit: {
    sha: string;
    message?: string;
    author?: { name?: string; email?: string };
    timestamp?: string;
  };
  ref: string;
  base_ref?: string;
  created_at: string;
}
```

**Files:**
- `workers/queue-consumer/index.ts` — Queue message handler
- `workers/queue-consumer/wrangler.toml` — Worker configuration

**Leaf work:** Queue consumer logic is agent-writable

---

### 4. Gate Workflow (Tests Only)

**What it is:** The pre-merge gate that runs automated validation against a candidate implementation: unit tests, property checks, and spec conformance validation. This is the first rung of the oracle ladder.

**Implementation:**
- **File:** `workers/gate-workflow/index.ts` — Gate Workflow Worker
- **Binding:** `beehive-gate-workflow` on workers.dev
- **Gate type:** `pre-merge` (tests only, no live traffic)

**Validation types:**
1. **Unit tests** — Candidate's own test suite
2. **Property checks** — Formal verification of invariants
3. **Spec conformance** — Does implementation match contract?
4. **Complexity delta** — How much does this change affect system complexity?

**Gate verdict:**
```typescript
interface GateWorkflowResult {
  verdictId: string;
  candidateId: string;
  gate: 'pre-merge';
  status: 'pass' | 'fail' | 'pending';
  score: number; // 0-100
  complexityDelta: number; // Measured change in complexity
  testResults: TestResult[];
  conformanceErrors: ConformanceError[];
  notes?: string;
  startedAt: number;
  completedAt: number;
}
```

**Scoring:**
- Tests: 40% weight (pass/fail rate)
- Conformance: 30% weight (contract adherence)
- Complexity: 20% weight (delta magnitude)
- Property checks: 10% weight (formal verification)

**Endpoints:**
- `POST /gates/pre-merge` — Trigger pre-merge gate validation
- `GET /gates/health` — Health check

**Files:**
- `workers/gate-workflow/index.ts` — Gate logic
- `workers/gate-workflow/wrangler.toml` — Worker configuration
- `workers/gate-workflow/tests/gate.test.ts` — Unit tests

**Spine work:** Core gate logic is hand-written (sequencing rule)

---

### 5. DO Ledger (Scores + Actor Identity + Complexity Delta)

**What it is:** The append-only Durable Object SQLite ledger that serves as the source of truth for all coordination state in Beehive. Tracks specs, candidates, verdicts, trials, promotions, and actor identity.

**Implementation:**
- **File:** `workers/spec-do/index.ts` — SpecDO class
- **File:** `workers/spec-do/schema-inline.ts` — SQLite schema
- **Binding:** `beehive` (main worker) → SpecDO Durable Object

**Ledger tables:**
- `organizations` — Project containers
- `repositories` — Source code repositories (baseline and candidate)
- `actors` — Human and agent identities with trust scores
- `specs` — Machine-readable contracts
- `candidates` — Spec implementations
- `gate_verdicts` — Oracle ladder results (pre-merge, shadow, train, canary, full)
- `trials` — Competitive evaluations between candidates
- `promotions` — Candidate promotion history
- `entity_history` — Generic audit trail

**Actor identity:**
```typescript
interface Actor {
  id: string;
  type: 'human' | 'agent';
  name: string;
  github_user_id?: string;
  trust_score: number; // 0-100
  promotion_authority: boolean; // Can promote candidates
  created_at: number;
}
```

**Complexity delta calculation:**
```typescript
function calculateComplexityDelta(
  spec: Spec,
  candidate: Candidate
): number {
  // Analyze diff between baseline and candidate
  // Count changed endpoints, models, dependencies
  // Measure cyclomatic complexity change
  // Return normalized score (0 = no change, 1 = major refactor)
}
```

**Files:**
- `workers/spec-do/index.ts` — Full SpecDO implementation
- `workers/spec-do/schema-inline.ts` — Schema definition
- `workers/spec-do/sql-storage.ts` — SQLite storage layer
- `workers/spec-do/seed.ts` — Development seed data

**Spine work:** DO ledger is hand-written (load-bearing wall)

---

### 6. Trial UI (Candidate Comparison)

**What it is:** Web-based user interface for visualizing trial results, comparing candidates, and monitoring spec implementations through the oracle ladder.

**Implementation:**
- **Directory:** `ui/src/` — React components
- **Framework:** React + TypeScript
- **Styling:** Custom CSS with dark theme

**Pages:**
- `SpecsPage.tsx` — List and manage specs
- `CandidatesPage.tsx` — List and compare candidates
- `TrialsPage.tsx` — View active trials
- `TrialDetailPage.tsx` — Deep dive into trial results

**Components:**
- `CandidateCard.tsx` — Candidate information display
- `TrialCard.tsx` — Trial summary with status
- `ScoreBadge.tsx` — Score visualization
- `StageBadge.tsx` — Current stage in oracle ladder
- `ProgressBar.tsx` — Progress indicators

**Features:**
- Real-time status updates from Spec DO
- Score comparison between candidates
- Stage progression visualization (pre-merge → shadow → train → canary → full)
- Complexity delta display
- Gate verdict history

**Files:**
- `ui/src/pages/*.tsx` — Page components
- `ui/src/components/*.tsx` — Reusable components
- `ui/src/types.ts` — TypeScript interfaces
- `ui/src/services/api.ts` — API client

**Leaf work:** UI is agent-writable

---

### 7. Ledger Lifecycle (Soft-delete/Tombstones + Admin Purge)

**What it is:** The Spec DO is append-only with no delete routes. Records are never destroyed, only marked as deleted (tombstones) for data integrity and auditability.

**Implementation:**
- **Soft-delete:** `deleted_at` timestamp column added to all major tables
- **Tombstones:** Records marked as deleted remain in database, queries filter them out
- **Admin purge:** Authenticated endpoint restricted to maintainer-actor IDs for test-data cleanup

**Finding (2026-10-11):**
The only wipe path is `wrangler delete beehive --force` + redeploy, which destroys all ledger data and worker secrets. This is acceptable for test data but unacceptable once real trials exist.

**M1 solution:**
- Soft-delete/tombstones for specs and candidates
- Admin purge route behind auth gate
- Restricted to maintainer actor IDs only

**Schema additions:**
```sql
ALTER TABLE specs ADD COLUMN deleted_at INTEGER;
ALTER TABLE candidates ADD COLUMN deleted_at INTEGER;
ALTER TABLE gate_verdicts ADD COLUMN deleted_at INTEGER;
ALTER TABLE trials ADD COLUMN deleted_at INTEGER;
```

**Admin purge endpoint:**
```typescript
// POST /api/admin/purge-test-data
// Auth: Requires maintainer promotion_authority
// Body: { confirm: 'DELETE_ALL_TEST_DATA' }
// Response: { purged: number, retained: number }
```

**Spine work:** Ledger lifecycle modifications are hand-written

---

## Must Have / Should Have / Go No-Go Checklists

### Must Have (Blocking - All Complete ✅)

- [x] Spec schema defined and validated (contract + acceptance + declared delta surface)
- [x] Orchestrator Worker deployed (`beehive` main worker)
- [x] Queue infrastructure operational (`beehive-artifacts-push` queue)
- [x] Gate Workflow tests passing (pre-merge gate with tests + conformance)
- [x] DO ledger functional (SQLite Durable Object with all tables)
- [x] Actor identity system working (humans + agents with trust scores)
- [x] Complexity delta calculation implemented (deterministic metrics)
- [x] Trial UI basic functionality (candidate comparison visualization)
- [x] Ledger lifecycle with soft-delete/tombstones (append-only with tombstones)
- [x] Admin purge route with auth (maintainer-only test-data cleanup)

### Should Have (Nice-to-have - All Complete ✅)

- [x] All TypeScript compilation passing
- [x] All workers deployed and health-checked
- [x] Cloudflare Artifacts integration verified
- [x] GitHub Actions auto-deploy workflow configured
- [x] Fail-closed auth gate on all routes (including /health)
- [x] Zod validation on all API inputs

### Won't Have (Deferred to M2+)

- [ ] Workers Builds Previews (M2 feature)
- [ ] Edge mirror Worker / Shadow traffic (M2 feature)
- [ ] Scientist comparator (M2 feature)
- [ ] Analytics Engine metrics (M2 feature)
- [ ] Live traffic validation (M2+)
- [ ] Canary deployments (M3)
- [ ] Auto-rollback (M3)
- [ ] Promotion train (M3)

---

## Go No-Go Checklist

**All items MUST be complete for Go decision:**

- [x] All Must Have items complete
- [x] No blocking issues in production
- [x] All 4 core M1 workers deployed and verified
- [x] Spike exit criteria met (3 forks, 3 pushes, 3 events, zero manual steps)
- [x] Ready for M2 (Empirical oracle)

**Go Decision: ✅ GO - M1 is COMPLETE and ready for M2**

---

## Exit Criteria (From MILESTONES.md)

**M1 Exit Criteria:** All components functional end-to-end
```
spec → claim → develop → push → gate → trial
```

**Verification:**
- [x] Spec creation works
- [x] Agent can claim spec
- [x] Candidate development flow works
- [x] Push events trigger queue
- [x] Queue consumer processes messages
- [x] Gate workflow validates candidates
- [x] Trial UI displays results
- [x] DO ledger persists all state

**Exit Criteria Met: ✅ YES - All criteria verified**

---

## Next Steps

**M1 is COMPLETE. Next milestone: M2 (Empirical oracle)**

M2 builds on M1 by adding:
1. **Workers Builds Previews** — Isolated preview deployments per candidate
2. **Edge Mirror Worker** — Traffic mirroring with response discarding
3. **Scientist Comparator** — Comparison against declared delta surface
4. **Analytics Engine** — Per-candidate metrics collection
5. **Service bindings** — Queue-to-worker communication infrastructure

**See:** `docs/M2-PLAN.md` for detailed M2 implementation plan

---

## Files Summary

### Core Workers (M1)

```
workers/
├── api/                    # Main API worker (edge router)
│   ├── index.ts            # REST API endpoints
│   └── types.ts            # TypeScript interfaces
├── spec-do/                # Spec Durable Object (ledger)
│   ├── index.ts            # SpecDO class implementation
│   ├── schema-inline.ts    # SQLite schema as TS constant
│   ├── schema.sql          # SQL schema source
│   ├── seed.ts             # Development seed data
│   ├── sql-storage.ts      # SQLite storage layer
│   └── sql.d.ts            # TypeScript declarations
├── gate-workflow/          # Pre-merge gate validation
│   ├── index.ts            # Gate workflow logic
│   ├── wrangler.toml       # Worker configuration
│   └── tests/              # Unit tests
│       └── gate.test.ts
├── queue-consumer/         # Queue message processing
│   ├── index.ts            # Message handler
│   └── wrangler.toml       # Worker configuration
└── sandbox-runner/         # Agent sandbox execution
    ├── index.ts            # Sandbox logic
    └── wrangler.toml       # Worker configuration
```

### UI

```
ui/
└── src/
    ├── services/
    │   └── api.ts          # API client
    ├── components/
    │   ├── CandidateCard.tsx
    │   ├── TrialCard.tsx
    │   ├── ScoreBadge.tsx
    │   ├── StageBadge.tsx
    │   └── ProgressBar.tsx
    ├── pages/
    │   ├── SpecsPage.tsx
    │   ├── CandidatesPage.tsx
    │   ├── TrialsPage.tsx
    │   └── TrialDetailPage.tsx
    └── types.ts            # TypeScript interfaces
```

### Shared Code

```
workers/
└── shared/
    └── auth.ts             # Fail-closed authentication gate
```

### Configuration

```
wrangler.toml                 # Root configuration
workers/*/wrangler.toml        # Worker-specific configs
package.json                   # Project scripts and dependencies
```

---

## Resource Requirements

### Cloudflare Services

| Service | Purpose | Configured |
|---------|---------|------------|
| Workers | All workers | ✅ Yes |
| Durable Objects | Spec DO ledger | ✅ Yes |
| Queues | Push event routing | ✅ Yes |
| Artifacts | Candidate repos | ✅ Yes |
| Analytics Engine | Metrics | ❌ No (M2) |
| Workers Builds | Preview deployments | ❌ No (M2) |

### API Tokens & Permissions

Required scopes for M1:
- `Workers Scripts:Edit` — ✅ Configured
- `Workers Queues:Edit` — ✅ Configured
- `Artifacts:Edit` — ✅ Configured
- `Workers Builds:Edit` — ❌ No (M2)
- `Analytics Engine:Edit` — ❌ No (M2)

---

## Risk Assessment

### Low Risk ✅

| Risk | Mitigation | Probability |
|------|------------|-------------|
| Schema migration needed | Versioned schema with migrations | Low |
| Queue message validation | Zod schema validation | Low |
| Auth gate failures | Fail-closed on all routes | Low |

### Medium Risk ⚠️

| Risk | Mitigation | Probability |
|------|------------|-------------|
| DO data loss | Append-only ledger with soft-delete | Low |
| Event ordering issues | Queue provides FIFO guarantees | Low |
| Token scope propagation | Wait and retry after granting | Medium |

### High Risk ❌

| Risk | Mitigation | Probability |
|------|------------|-------------|
| None | All critical risks mitigated | N/A |

---

## Success Criteria Met

### Must Have (All Complete ✅)

- [x] Spec schema defined and validated
- [x] Orchestrator Worker deployed
- [x] Queue infrastructure operational
- [x] Gate Workflow tests passing
- [x] DO ledger functional
- [x] Actor identity system working
- [x] Complexity delta calculation implemented
- [x] Trial UI basic functionality
- [x] Ledger lifecycle with soft-delete/tombstones
- [x] Admin purge route with auth

### Should Have (All Complete ✅)

- [x] All TypeScript compilation passing
- [x] All workers deployed and health-checked
- [x] Cloudflare Artifacts integration verified
- [x] GitHub Actions auto-deploy configured
- [x] Fail-closed auth gate implemented
- [x] Zod validation on all inputs

---

## Verification

### Repository Verification

```bash
# Check M1 workers exist
ls -la workers/api/ workers/spec-do/ workers/gate-workflow/ workers/queue-consumer/ workers/sandbox-runner/

# Check UI exists
ls -la ui/src/

# Check schema
cat workers/spec-do/schema-inline.ts | grep -E "CREATE TABLE|specs|candidates|gate_verdicts|trials"

# Check git history for M1
git log --oneline --all | grep -i "m1\|spike\|spec\|trial\|ledger" | head -20
```

### Deployment Verification

```bash
# Health checks
curl -H "Authorization: Bearer $BEEHIVE_API_TOKEN" \
  https://beehive.bz23711.workers.dev/health

curl -H "Authorization: Bearer $BEEHIVE_API_TOKEN" \
  https://beehive-gate-workflow.bz23711.workers.dev/gates/health

curl -H "Authorization: Bearer $BEEHIVE_API_TOKEN" \
  https://beehive-queue-consumer.bz23711.workers.dev/health

curl -H "Authorization: Bearer $BEEHIVE_API_TOKEN" \
  https://beehive-sandbox-runner.bz23711.workers.dev/health
```

### End-to-End Test

```bash
# Run E2E test
npx tsx scripts/e2e-test.ts

# Or manual test
# 1. Create spec
# 2. Create actor
# 3. Claim spec
# 4. Create candidate
# 5. Push to candidate repo
# 6. Verify gate workflow runs
```

---

## Appendix A: Glossary

| Term | Definition |
|------|------------|
| **Spec** | Machine-readable contract defining requirements |
| **Candidate** | Agent implementation of a spec |
| **Gate** | Validation rung in the oracle ladder (pre-merge, shadow, train, canary, full) |
| **Verdict** | Result of gate validation (pass/fail) |
| **Trial** | Competitive evaluation between candidates |
| **DO** | Durable Object (Cloudflare's stateful storage) |
| **Spine** | Hand-written core: spec schema, DO ledger, promotion train |
| **Leaf** | Agent-written: candidates, tests, glue, API endpoints |
| **Declared Delta Surface** | The spec's definition of what behaviors are allowed to change |
| **Complexity Delta** | Measured change in system complexity from baseline to candidate |

---

## Appendix B: References

- Cloudflare Durable Objects: https://developers.cloudflare.com/durable-objects/
- Cloudflare Queues: https://developers.cloudflare.com/workers/platform/queues/
- Cloudflare Artifacts: https://developers.cloudflare.com/workers/platform/artifacts/
- Zod TypeScript-first schema validation: https://zod.dev
- TypeScript: Everywhere (per architectural rule)

---

## Appendix C: Commit Message Template

```
step: <component> | task: <id> | spec: <clause> | confidence: <0-1>

- Description of changes
- Files modified
- Test coverage
```

---

*Document created: 2026-10-13*
*Status: M1 COMPLETE and verified*
*Owner: Beehive Code Agents (Documentation)*
