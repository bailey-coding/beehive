---
category: architecture
status: active
audience: human,agent
tags:
  - core
  - design
---

# Beehive Architecture

> **Technical deep dive for implementers**
> 
> *Read this after `AGENTS.md` and before implementation.*

This document explains **how Beehive works** at a technical level. For the **why** (core thesis) and **what** (features), see `README.md`. For agent-specific conventions, see `AGENTS.md`.

---

## 🏗️ System Overview

Beehive is a **multi-worker Cloudflare application** with a **Durable Object** at its core:

```
┌─────────────────────────────────────────────────────────────────┐
│                        Cloudflare Edge                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐     │
│  │  Edge Router  │    │ Gate Workflow│    │ Sandbox      │     │
│  │  (beehive)    │◄───► (beehive-   │    │ Runner       │     │
│  │              │    │  gate-       │    │ (beehive-    │     │
│  │ - REST API   │    │  workflow)   │    │  sandbox-    │     │
│  │ - Auth gate  │    │              │    │  runner)     │     │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘     │
│         │                   │                    │                │
│         ▼                   ▼                    ▼                │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    Spec DO (Durable Object)                   │   │
│  │                  SQLite-backed, single source                  │   │
│  │  - Organizations, Repositories, Specs, Candidates              │   │
│  │  - Actors, Gate Verdicts, Trials, Promotions                   │   │
│  │  - Issues, Comments, Links, Entity History                    │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                       │
│                              ▼                                       │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                Cloudflare Artifacts                           │   │
│  │  - All candidate repositories (forks)                         │   │
│  │  - Baseline repositories                                    │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────┐                                                 │
│  │ Queue Consumer│◄──────────────────────────────────────────────┘   │
│  │ (beehive-    │     Artifacts Push Events                       │
│  │  queue-     │                                                 │
│  │  consumer)  │                                                 │
│  └──────────────┘                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📦 Component Details

### 1. Edge Router / API Worker (`beehive`)

**Purpose:** REST API entry point, request routing, authentication

**Responsibilities:**
- Bearer token authentication (fail-closed)
- Route requests to appropriate services or Durable Objects
- Handle all CRUD operations for entities
- Trigger workflows (gates, sandbox execution)

**Config:** `wrangler.toml` (root)

**Bindings:**
- `SPEC_DO` → SpecDO class (Durable Object)

---

### 2. Spec Durable Object (`SpecDO`)

**Purpose:** Single source of truth for all coordination state

**Implementation:** SQLite via `state.storage.sql` (Cloudflare's native DO storage)

**Schema:** See `workers/spec-do/schema-inline.ts` (generated from `schema.sql`)

**Tables:**
- `organizations` - Project/organization containers
- `repositories` - Git repos (baseline + candidate forks)
- `specs` - Machine-readable specifications
- `candidates` - Agent implementations of specs
- `actors` - Humans and agents
- `gate_verdicts` - Results of gate evaluations
- `trials` - Head-to-head candidate comparisons
- `promotions` - Successful candidate promotions
- `issues` - GitHub-style issues
- `issue_comments` - Issue discussions
- `issue_spec_links`, `issue_candidate_links` - Issue tracking
- `entity_history` - Audit trail for all entities
- `metadata` - System metadata

**Key Characteristics:**
- Append-only ledger (no delete routes)
- Soft-delete via tombstones for M1
- Transactional across all tables
- Single instance per namespace (`main`)

**Why Durable Object?**
- Consistent view of state across all workers
- Transactional updates (SQLite)
- Persistent storage that survives worker restarts
- Low-latency access (same region as workers)

---

### 3. Gate Workflow Worker (`beehive-gate-workflow`)

**Purpose:** Execute the **pre-merge oracle** — validate candidates before they advance

> **Status (2026-10-27): simulated.** `workers/gate-workflow/index.ts` returns hard-coded unit-test passes, derives complexity from a hash of the candidate id, adds a conformance warning at random (10%), and the sandbox runner's clone is a logged simulation. The steps below are the design; a real gate is planned in `docs/REAL-GATE-IMPL-PLAN.md`.

**Implementation:** Cloudflare Worker with Workflow-like execution

**Responsibilities:**
1. Clone candidate repository
2. Install dependencies
3. Run test suites:
   - Unit tests
   - Property-based tests
   - Spec conformance validation
4. Calculate complexity delta
5. Aggregate results into verdict
6. Record verdict in Spec DO

**Oracle Steps (Pre-merge):**
```
1. Clone candidate repo from Artifacts
2. Run unit tests (npm test / pytest / etc.)
3. Run property tests (hypothesis / fast-check style)
4. Validate spec conformance (contract matching)
5. Calculate complexity delta (LOC, cyclomatic, deps)
6. Weighted scoring: conformance 50% + tests 25% + complexity 25%
7. Pass threshold: >= 80/100
```

**Config:** `workers/gate-workflow/wrangler.toml`

**Bindings:**
- `SPEC_DO` → SpecDO class
- `ARTIFACTS` → Cloudflare Artifacts (future)
- `SANDBOX_RUNNER` → Sandbox Runner service

---

### 4. Sandbox Runner Worker (`beehive-sandbox-runner`)

**Purpose:** Execute agent code in isolated, safe environments

**Responsibilities:**
- Clone candidate repositories
- Install dependencies
- Execute agent-provided code
- Commit changes to candidate repos
- Push to Artifacts

**Execution Modes:**
1. **Full sandbox** - Complete repo clone + dependency install + execution
2. **Direct execution** - Simple code evaluation (dev only, no untrusted code)

**Config:** `workers/sandbox-runner/wrangler.toml`

**Bindings:**
- `SPEC_DO` → SpecDO class
- `ARTIFACTS` → Cloudflare Artifacts
- `SANDBOX` → Cloudflare Sandbox SDK (future)

---

### 5. Queue Consumer Worker (`beehive-queue-consumer`)

**Purpose:** Process asynchronous events from Cloudflare Artifacts

**Responsibilities:**
- Consume push events from Artifacts Queue
- Match events to candidates (by repository URL)
- Trigger appropriate workflows (pre-merge gate)
- Record events in entity history

**Event Flow:**
```
Artifacts Push → Queue → Consumer → Find Candidate → Trigger Gate → Record History
```

**Config:** `workers/queue-consumer/wrangler.toml`

**Bindings:**
- `SPEC_DO` → SpecDO class (cross-script via `script_name = "beehive"`)
- `GATE_WORKFLOW` → Gate Workflow service
- `PREVIEW_MANAGER` → Preview Manager service
- Queue consumers for `beehive-artifacts-push`, `preview-artifacts-push`, `preview-artifacts-events` queues

---

### 6. Shadow Router Worker (`beehive-shadow-router`)

**Purpose:** Mirror production traffic to candidate Workers for Scientist comparison

**Responsibilities:**
- Mirror requests to candidate implementations
- Discard candidate responses (comparison is async)
- Send comparison requests to Scientist Comparator queue

**Config:** `workers/shadow-router/wrangler.toml`

**Bindings:**
- `ANALYTICS` → Analytics Engine dataset
- Queue producers for `beehive-scientist-comparisons` and `preview-scientist-comparisons`

---

### 7. Scientist Comparator Worker (`beehive-scientist-comparator`)

**Purpose:** Compare candidate responses against spec delta surface (M2 Shadow oracle)

**Responsibilities:**
- Consume comparison requests from queue
- Compare candidate responses against baseline
- Validate against declared delta surface
- Record comparison results in Spec DO

**Config:** `workers/scientist-comparator/wrangler.toml`

**Bindings:**
- `SPEC_DO` → SpecDO class (cross-script via `script_name = "beehive"`)
- `ANALYTICS` → Analytics Engine dataset
- Queue consumers for `beehive-scientist-comparisons` and `preview-scientist-comparisons`

---

### 8. Preview Manager Worker (`beehive-preview-manager`)

**Purpose:** Manage Workers Builds preview deployments for candidates

**Responsibilities:**
- Create preview deployments for candidates
- Manage preview lifecycle
- Send preview events to comparison queues

**Config:** `workers/preview-manager/wrangler.toml`

**Bindings:**
- `SPEC_DO` → SpecDO class (cross-script via `script_name = "beehive"`)
- `ANALYTICS` → Analytics Engine dataset
- Queue producer for `preview-scientist-comparisons`

---

### 9. Candidate Service Worker (`beehive-candidate-service`)

**Purpose:** Manage candidate lifecycle and metadata

**Responsibilities:**
- Candidate CRUD operations
- Candidate state management
- Integration with Spec DO

**Config:** `workers/candidate-service/wrangler.toml`

**Bindings:**
- `SPEC_DO` → SpecDO class (cross-script via `script_name = "beehive"`)
- `ANALYTICS` → Analytics Engine dataset

---

### 10. Canary Worker (`beehive-canary-worker`)

**Purpose:** Handle canary deployments with SLO monitoring and auto-rollback (M3 Canary oracle)

**Responsibilities:**
- Deploy candidates to canary
- Monitor SLOs from Analytics Engine samples (no Statsig integration; traffic groups use a local hash split)
- Trigger auto-rollback on SLO violations
- Record canary results

**Config:** `workers/canary-worker/wrangler.toml`

**Bindings:**
- `SPEC_DO` → SpecDO class (cross-script via `script_name = "beehive"`)
- `PREVIEW_MANAGER` → Preview Manager service
- `ANALYTICS` → Analytics Engine dataset
- Queue consumer for `canary-rollback-triggers`

---

### 11. Promotion Worker (`beehive-promotion-worker`)

**Purpose:** Implement M3 promotion train (tournament and merge-train modes)

**Responsibilities:**
- Tournament mode: multiple candidates compete, winner advances
- Merge-train mode: sequential promotion with validation
- Coordinate with other workers (Gate, Shadow, Preview)
- Record promotion decisions in Spec DO

**Config:** `workers/promotion-worker/wrangler.toml`

**Bindings:**
- `SPEC_DO` → SpecDO class (via `[[services]]` service binding to `beehive`)
- `PREVIEW_MANAGER` → Preview Manager service
- `GATE_WORKFLOW` → Gate Workflow service
- `SHADOW_ROUTER` → Shadow Router service
- `ANALYTICS` → Analytics Engine dataset
- Queue consumer for `promotion-events`

---

## 🔄 Data Flow

### The Candidate Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│                         CANDIDATE LIFECYCLE                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐  │
│  │  Claim   │────►│  Commit  │────►│   Push   │────►│  Queue   │  │
│  │  Spec    │     │  Code    │     │  to Repo │     │ Consumer │  │
│  └──────────┘     └──────────┘     └──────────┘     └──────┬────┘  │
│                                                        │         │
│                        ┌───────────────────────────────────┼─────────┤
│                        │                                   │    │
│                        ▼                                   ▼    │
│  ┌──────────────────────────┐              ┌────────────────────┼──┐ │
│  │ Create Fork in Artifacts  │              │ Trigger Pre-Merge  │  │ │
│  │ - Real repository         │              │ Gate Workflow      │  │ │
│  │ - Write token             │              │                    │  │ │
│  └──────────────┬───────────┘              └──────────┬─────────┘  │ │
│                 │                                          │          │
│                 └──────────────────────────────────────┬────────┘  │
│                                                              │         │
│                              ┌────────────────────────────────▼─────┐  │
│                              │                     Gate Workflow          │  │
│                              │  ┌─────────┐  ┌─────────┐  ┌─────────┐ │  │
│                              │  │  Clone   │  │  Tests   │  │Conformance│ │  │
│                              │  │  Repo    │──►│  (unit,  │──►│ Validation│ │  │
│                              │  │         │  │ property)│  │         │ │  │
│                              │  └─────────┘  └─────────┘  └─────────┘ │  │
│                              │           └──────────────────┬──────────┘  │
│                              │                                │              │
│                              │                    ┌───────────▼───────┐  │
│                              │                    │    Verdict        │  │
│                              │                    │ - Score: 0-100    │  │
│                              │                    │ - Status: pass/fail│  │
│                              │                    └───────────┬───────┘  │
│                              │                                │              │
│                              └────────────────────────────►│              │
│                                                            │              │
│                         ┌───────────────────────────────────▼────────┐ │
│                         │              Update Candidate Stage              │ │
│                         │   pending → passed_premerge → passed_shadow     │ │
│                         └─────────────────────────────────────────────┘ │
│                                                                     │
└─────────────────────────────────────────────────────────────────┘
```

### The Promotion Train

For M3+, candidates that pass pre-merge advance through:

```
passed_premerge → passed_shadow → passed_train → passed_canary → promoted
                      ↑                ↑               ↑
                  (M2)           (M2/M3)        (M3)
```

Each rung has:
- Different traffic patterns (none → mirrored → projection → small % → 100%)
- Different oracles (tests → Scientist diff → conformance → SLOs)
- Different failure actions (hold → iterate → drop → rollback)

---

## 🗃️ Storage Architecture

### Storage Layers by Purpose

| Purpose | Storage | Rationale |
|---------|---------|-----------|
| Coordination state | Spec DO (SQLite) | Transactional, consistent, low-latency |
| Cross-spec queries | D1 | SQL, indexed, multi-spec (planned, not yet bound) |
| Metric streams | Analytics Engine | High-volume, time-series |
| Provenance | Git notes | Portable, auditable, never live state |
| Candidate repos | Cloudflare Artifacts | Git-native, versioned |

### Spec DO Schema Design

**Why SQLite in DO?**
- Native Cloudflare support (`state.storage.sql`)
- ACID transactions across all tables
- No external dependencies
- Durable (survives worker restarts)

**Key Tables:**

```
┌─────────────────────────┐
│        specs             │
├─────────────────────────┤
│ id | name | contract    │
│    | desc | declared_   │
│    |      | delta_surface│
│    | org  | stage       │
└────────┬────────────────┘
         │
         ├──────────┬─────────────┐
         │          │
┌────────▼──────┐ ┌──────▼─────────┐
│   candidates   │ │  gate_verdicts  │
├───────────────┤ ├────────────────┤
│ id | spec_id   │ │ id | candidate_id│
│    | repo_id   │ │    | gate        │
│    | commit   │ │    | status      │
│    | agent_id │ │    | score       │
│    | stage    │ │    | complexity  │
└───────────────┘ └────────────────┘
```

### Entity Relationships

```
Organization
    └── Repository (baseline or candidate)
            └── Spec (owns baseline repo)
                └── Candidate (implemented in candidate repo)
                    └── Gate Verdict (per gate: pre-merge, shadow, etc.)
                    └── Trial (compares two candidates)
                    └── Promotion (advances candidate)

Actor
    └── Candidate (agent_id)
    └── Gate Verdict (decided_by)
    └── Trial (decided_by)
    └── Promotion (promoted_by)

Issue
    ├── Issue Spec Link
    └── Issue Candidate Link
        └── Spec or Candidate
```

---

## 🔒 Security Model

### Authentication: Fail-Closed by Design

Every worker with a `fetch` entry point:

```typescript
// workers/shared/auth.ts
export function authGate(request: Request, env: AuthEnv): Response | null {
  const expected = env.API_AUTH_TOKEN;
  
  if (!expected) {
    return jsonError('API_AUTH_TOKEN not configured', 503);  // Fail closed
  }
  
  const authorization = request.headers.get('Authorization');
  if (authorization === `Bearer ${expected}`) {
    return null;  // Allow
  }
  
  return jsonError('Unauthorized', 401);
}
```

**Key principles:**
- No token → 503 (service unavailable, not 401)
- Wrong token → 401 (unauthorized)
- Auth applies to **every route**, including `/health`
- No exceptions, no bypasses

### Token Management

**Production:**
```bash
# Set on each worker
wrangler secret put API_AUTH_TOKEN -n beehive
wrangler secret put API_AUTH_TOKEN -n beehive-gate-workflow
wrangler secret put API_AUTH_TOKEN -n beehive-sandbox-runner
wrangler secret put API_AUTH_TOKEN -n beehive-queue-consumer
```

**Local Development:**
```bash
# .dev.vars (gitignored)
API_AUTH_TOKEN=your-dev-token

# .env (gitignored, for tooling)
BEEHIVE_API_TOKEN=your-dev-token
```

### Cloudflare Permissions

**Required scopes for deployment:**
- `Workers Scripts:Edit` - Deploy workers, manage secrets
- `Workers Queues:Edit` - Create and manage queues
- `User -> Memberships:Read` - Check delete impact (optional, `--force` bypasses)

**Token propagation delay:** 2-3 minutes after granting scopes. Fresh 403s are expected.

---

## ⚡ Performance & Scalability

### Workers Scaling

- Each worker scales independently
- Stateless where possible (state in Spec DO)
- No shared mutable state between requests

### Durable Object Limits

- 10 GB storage per DO (SQLite)
- Large monorepos: Out of scope (confirmed in OPEN-QUESTIONS.md)
- Current sample services: Comfortably under limit

### Queue Processing

- At-least-once delivery assumed
- Queue consumers are idempotent
- Push event ordering: Enforced by Artifacts (first-writer-wins, second rejected)

---

## 🔗 Service Interactions

### Workers → Spec DO

Most workers bind to the Spec DO via Durable Object bindings. There are two patterns:

**Same-script DO (beehive worker):**
```toml
# In wrangler.toml (root)
[[durable_objects.bindings]]
name = "SPEC_DO"
class_name = "SpecDO"
```

**Cross-script DO (other workers):**
```toml
# In queue-consumer/wrangler.toml, scientist-comparator/wrangler.toml, etc.
[[durable_objects.bindings]]
name = "SPEC_DO"
class_name = "SpecDO"
script_name = "beehive"
```

**Exception:** `shadow-router` has no SPEC_DO binding. `promotion-worker` binds to the `beehive` worker via a service binding instead of a DO binding:
```toml
# In promotion-worker/wrangler.toml
[[services]]
binding = "SPEC_DO"
service = "beehive"
```

### Workers → Workers (Service Bindings)

Service bindings use the `binding` field, never `name`. Examples from real configs:

```toml
# In queue-consumer/wrangler.toml
[[services]]
binding = "GATE_WORKFLOW"
service = "beehive-gate-workflow"

[[services]]
binding = "PREVIEW_MANAGER"
service = "beehive-preview-manager"

# In canary-worker/wrangler.toml
[[services]]
binding = "PREVIEW_MANAGER"
service = "beehive-preview-manager"

# In promotion-worker/wrangler.toml
[[services]]
binding = "SPEC_DO"
service = "beehive"
[[services]]
binding = "PREVIEW_MANAGER"
service = "beehive-preview-manager"
[[services]]
binding = "GATE_WORKFLOW"
service = "beehive-gate-workflow"
[[services]]
binding = "SHADOW_ROUTER"
service = "beehive-shadow-router"
```

**Note:** No worker has a `SANDBOX_RUNNER` service binding.

### Workers → Queues

**Producer form uses `[[queues.producers]]`:**
```toml
# In shadow-router/wrangler.toml
[[queues.producers]]
binding = "SCIENTIST_QUEUE"
queue = "beehive-scientist-comparisons"

[[queues.producers]]
binding = "PREVIEW_SCIENTIST_QUEUE"
queue = "preview-scientist-comparisons"

# In preview-manager/wrangler.toml
[[queues.producers]]
queue = "preview-scientist-comparisons"
binding = "PREVIEW_SCIENTIST_QUEUE"
```

**Consumer form uses `[[queues.consumers]]` without a binding:**
```toml
# In queue-consumer/wrangler.toml
[[queues.consumers]]
queue = "beehive-artifacts-push"
max_batch_size = 100
max_batch_timeout = 30

# In scientist-comparator/wrangler.toml
[[queues.consumers]]
queue = "beehive-scientist-comparisons"
max_batch_size = 100
max_batch_timeout = 30

# In canary-worker/wrangler.toml
[[queues.consumers]]
  queue = "canary-rollback-triggers"
  max_batch_size = 100
  max_batch_timeout = 30

# In promotion-worker/wrangler.toml
[[queues.consumers]]
  queue = "promotion-events"
  max_batch_size = 100
  max_batch_timeout = 30
```

---

## 🧩 Design Decisions

For detailed rationales and the ADR (Architecture Decision Record) process, see [docs/decisions/README.md](docs/decisions/README.md):

| ADR | Decision | Status |
|-----|----------|--------|
| [0001](./docs/decisions/0001-vcs-client-model.md) | VCS Client Model (Sapling-first) | Accepted |
| [0002](./docs/decisions/0002-coordination-state.md) | Coordination State (DO SQLite) | Accepted |
| [0003](./docs/decisions/0003-language.md) | Language (TypeScript) | Accepted |
| [0004](./docs/decisions/0004-ci.md) | CI and Builds | Accepted |
| [0005](./docs/decisions/0005-org-memory.md) | Organizational Memory | Proposed |
| [0006](./docs/decisions/0006-deploy-path.md) | Deploy path: GitHub CI-only, one Artifacts push | Accepted |
| [0007](./docs/decisions/0007-fail-closed-edge-auth.md) | Fail-closed edge authentication | Accepted |
| [0008](./docs/decisions/0008-tombstone-then-purge.md) | Tombstone, then guarded purge | Accepted |

**Note:** For proposing new features or major changes, use the [RFC process](docs/rfcs/README.md). For documenting learnings from incidents, use the [RFO process](docs/rfos/README.md).

---

## 📚 Related Documentation

| Document | Purpose |
|----------|---------|
| `README.md` | Entry point, quick start, project overview |
| `AGENTS.md` | Agent working conventions, rules, patterns |
| `docs/MILESTONES.md` | Project phases, timeline, exit criteria |
| `docs/OPEN-QUESTIONS.md` | Findings, issues, undocumented behavior |
| `docs/ARTIFACTS-SETUP.md` | Cloudflare Artifacts configuration |
| `docs/UI-DASHBOARD-PLAN.md` | Dashboard implementation roadmap |
| `docs/decisions/README.md` | ADR process and all Architecture Decision Records |
| `docs/rfcs/README.md` | RFC process for proposing new features |
| `docs/rfos/README.md` | RFO process for incident post-mortems |
| `docs/templates/README.md` | Reusable templates for documentation |

---

## ✅ Implementation Checklist

Before implementing any feature, ensure you understand:

- [ ] How the Spec DO stores and retrieves state
- [ ] Which worker handles which responsibility
- [ ] How workers communicate (bindings vs HTTP)
- [ ] The authentication model (fail-closed)
- [ ] The data flow for your feature
- [ ] Where to store new data (Spec DO? D1? Analytics Engine?)

> **Do not begin implementation before understanding this document and AGENTS.md.**
