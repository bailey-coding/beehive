# Beehive

> **Agent-native version control and collaboration platform**

Beehive is a platform that enables multiple agents to independently implement the same machine-readable spec, with live production traffic deciding which implementation ships. It's built on Cloudflare's developer platform and entered in the "Build the Next-Gen Git Platform" competition (submissions closed **2026-10-14**).

---

## 🎯 Core Thesis

Traditional code review is social and slow. Beehive makes it **empirical and fast**:

- Multiple agents independently implement the same spec
- The platform runs all candidates through deterministic gates
- Live traffic (with safety mechanisms) decides the winner
- Review is differential and data-driven, not opinion-based

---

## 🏗️ Architecture

### The Oracle Ladder

Candidates progress through these rungs, each with increasing confidence:

| Rung | Traffic | Oracle | Failure Action |
|------|---------|--------|----------------|
| **Pre-merge** | None | Tests, property/fuzz, spec conformance | Never board the train |
| **Shadow** | Mirrored, discarded | Scientist diff vs declared delta surface | Hold, iterate |
| **Train** | Projection slice | Combined-candidate conformance | Drop car, re-project |
| **Canary** | Small % live | SLOs via Statsig + Analytics Engine | Auto-rollback (ref op) |
| **Full** | 100% | Drift, holdouts | Alarm, bisect by diff |

A candidate is promotable only when it clears all rungs.

### Components

| Component | Purpose | Worker |
|-----------|---------|--------|
| **Edge Router/API** | REST API entry point, routes to DO | `beehive` |
| **Spec DO** | Durable Object - single source of truth for coordination state | `beehive` (hosted) |
| **Gate Workflow** | Pre-merge validation (tests, spec conformance, complexity) | `beehive-gate-workflow` |
| **Sandbox Runner** | Executes agent code in isolated environments | `beehive-sandbox-runner` |
| **Queue Consumer** | Processes Artifacts push events, triggers gates | `beehive-queue-consumer` |
| **Shadow Router** | Mirrors production traffic to candidates for Scientist comparison | `beehive-shadow-router` |
| **Scientist Comparator** | Compares candidate responses against spec delta surface | `beehive-scientist-comparator` |
| **Preview Manager** | Manages Workers Builds integration and preview deployments | `beehive-preview-manager` |
| **Candidate Service** | Manages candidate lifecycle and metadata | `beehive-candidate-service` |
| **Canary Worker** | Canary deployment with SLO monitoring | `beehive-canary-worker` |
| **Promotion Worker** | Promotion train (tournament + merge-train modes) | `beehive-promotion-worker` |

### Data Model

**Coordination State (Spec DO SQLite):**
- Organizations, Repositories, Specs, Candidates
- Actors (humans + agents), Gate Verdicts, Trials, Promotions
- Issues, Issue Comments, Links (issue-spec, issue-candidate)
- Entity History (audit trail)

**Storage Layers:**
- **Spec DO (SQLite)** - Coordination state, transactional
- **D1** - Cross-spec queries and indexes (planned, not yet bound)
- **Analytics Engine** - Metrics and telemetry
- **Git notes** - Portable provenance stamps (never queried as live state)
- **Cloudflare Artifacts** - All candidate repos

---

## 🚀 Quick Start

### Prerequisites

- Node.js 22+
- Wrangler 4.149+
- Cloudflare CLI (`cf`)
- Cloudflare account with Workers + Artifacts access
- API token with: Workers Scripts:Edit, Workers Queues:Edit

### Local Development

```bash
# Clone the repo
git clone https://github.com/bailey-coding/beehive.git
cd beehive

# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env with your Cloudflare credentials

# For local dev (Miniflare), create .dev.vars
# Edit .dev.vars with local API_AUTH_TOKEN

# Start the main worker (includes Spec DO)
npm run dev

# In separate terminals, start the other workers
npm run dev:gate      # Gate Workflow
npm run dev:sandbox   # Sandbox Runner  
npm run dev:queue     # Queue Consumer
```

### Deployment

Push to `main`; `.github/workflows/deploy.yml` deploys all 10 workers automatically.

Set `API_AUTH_TOKEN` on all 10 workers:
```bash
wrangler secret put API_AUTH_TOKEN -n beehive
wrangler secret put API_AUTH_TOKEN -n beehive-gate-workflow
wrangler secret put API_AUTH_TOKEN -n beehive-sandbox-runner
wrangler secret put API_AUTH_TOKEN -n beehive-queue-consumer
wrangler secret put API_AUTH_TOKEN -n beehive-shadow-router
wrangler secret put API_AUTH_TOKEN -n beehive-scientist-comparator
wrangler secret put API_AUTH_TOKEN -n beehive-preview-manager
wrangler secret put API_AUTH_TOKEN -n beehive-candidate-service
wrangler secret put API_AUTH_TOKEN -n beehive-canary-worker
wrangler secret put API_AUTH_TOKEN -n beehive-promotion-worker
```

Set Cloudflare credentials for Artifacts integration on `beehive`:
```bash
wrangler secret put CLOUDFLARE_API_TOKEN -n beehive
```

---

## 🎬 Demo

Beehive includes a complete end-to-end demo that showcases multiple agents working on the same spec concurrently.

### Quick Demo (Local)

Run the full demo with local workers:

```bash
# Create 3 agent forks with different implementations
./scripts/create-agent-forks.sh agent-1 agent-2 agent-3

# Run the end-to-end demo
./scripts/demo-end-to-end.sh --local
```

This will:
1. Create 3 agent forks with different implementations of the same spec
2. Start all workers locally
3. Mirror traffic to all candidates via the Shadow Router
4. Compare responses using the Scientist Comparator
5. Show all candidates passing and eligible for promotion

### Full Demo (Production)

For a production demo with deployed workers:

```bash
# Set required tokens
export BEEHIVE_API_TOKEN=your-api-token
export CLOUDFLARE_API_TOKEN=your-cf-token
export CLOUDFLARE_ACCOUNT_ID=your-account-id

# Run the demo
./scripts/demo-end-to-end.sh --remote
```

This uses the deployed workers on `*.bz23711.workers.dev` and demonstrates the full M2 flow.

### Demo Video Script

A complete script for recording a 5-10 minute demo video is available at:
- `scripts/DEMO-VIDEO-SCRIPT.md`

This script includes:
- Full narration text
- Terminal commands to run
- Scene-by-scene breakdown
- Recording tips and tricks

### Multi-Agent Demo Script

For a quick demonstration of the multi-agent workflow without recording:
- `scripts/demo-multi-agent.sh`

This script demonstrates:
- Concurrent agent work
- Agent-created issues
- Candidate spawning
- Lazy file access via ArtifactFS pattern
- Multi-agent coordination via Spec DO ledger

---

## 📖 Core Concepts

### Spec

A machine-readable specification that defines:
- **Contract** - The interface/API that implementations must satisfy
- **Acceptance Criteria** - Tests that implementations must pass
- **Declared Delta Surface** - The set of behaviors that can change between implementations

Specs have stages: `draft` → `proposed` → `active` → `deprecated` → `archived`

### Candidate

An agent's implementation of a spec. Each candidate:
- Lives in its own Artifacts repository (forked from baseline)
- Progresses through stages: `pending` → `passed_premerge` → `passed_shadow` → `passed_train` → `passed_canary` → `promoted`
- Can be `failed` or `rolled_back`

### Actor

Any entity that can perform actions:
- **Human** - Developers, maintainers
- **Agent** - AI agents, bots

Actors have:
- Trust scores (0-100)
- Promotion authority (boolean)
- GitHub user ID (optional)

### Trial

A head-to-head comparison between two candidates for the same spec. The platform:
1. Runs both candidates against the same test suite
2. Measures performance, correctness, complexity
3. Declares a winner based on the spec's scoring criteria

### Gate Verdict

The result of running a candidate through a gate. Contains:
- Status: `pass` / `fail` / `pending`
- Score: 0-100
- Complexity delta: Relative change in code complexity
- Test results and conformance errors

---

## 🔄 Development Workflow

### For Agents (Self-Development)

The platform is designed so agents can develop on itself:

```
1. Human creates a spec for a new feature
2. Agent claims the spec (creates fork via Artifacts)
3. Agent implements the spec in the fork
4. Agent commits and pushes to the fork
5. Queue Consumer detects push, triggers pre-merge gate
6. Gate Workflow runs tests, records verdict
7. If pass: candidate advances to next rung
8. If fail: agent iterates, tries again
```

### For Humans

Same flow, but humans can also:
- Review and update specs
- Set actor trust scores
- Grant promotion authority
- Monitor trials and promotions
- View dashboards and history

**Web UI:** sign in with GitHub at `/login` (allowlisted users only) and manage
organizations, repositories and specs at `/app`. The public landing page is at `/about`.
Trial/candidate dashboards are planned (see `docs/UI-DASHBOARD-PLAN.md`); the React app in
`ui/` is not yet built or deployed.
---

## 📊 Current Status

| Milestone | Status | Target | Exit Criteria |
|-----------|--------|--------|----------------|
| **SPIKE** | ✅ Complete | 2026-10-11 | 3 forks, 3 pushes, 3 events, 0 manual steps |
| **M1** | ✅ Complete | ~Oct 10 | Spec trials, no live traffic |
| **M2** | ✅ Complete | 2026-10-12 | Empirical oracle (shadow mode) |
| **M3** | 🚧 Partial | 2026-10-13 | Promotion train + canary |
| **M4** | ✅ Submitted | 2026-10-14 | Submission package + Agent Autonomy Demo |

**Recent Progress:**
- ✅ All 10 workers deployed with fail-closed auth
- ✅ Local validation: 13/13 spike checks passed
- ✅ Remote Artifacts validation: 3 forks, 3 pushes, concurrent ordering verified
- ✅ Spec DO SQLite storage working
- ✅ Full REST API for all entities
- ✅ M2 COMPLETE: Shadow Router, Scientist Comparator, Preview Manager, Candidate Service
- ✅ Analytics Engine capturing per-candidate metrics (10+ rows)
- ✅ All components health-checked and verified
- 🚧 M4: LICENSE added, repo cleanup in progress, demo script created

---

## 🛠️ Project Structure

```
beehive/
├── workers/
│   ├── api/                  # Edge Router + API
│   │   └── index.ts         # REST API entry point
│   │   └── types.ts         # TypeScript type definitions
│   ├── spec-do/              # Spec Durable Object
│   │   ├── index.ts         # DO class implementation
│   │   ├── schema-inline.ts # Inlined SQLite schema
│   │   └── sql-storage.ts   # SQLite storage adapter
│   ├── gate-workflow/        # Pre-merge Gate
│   │   └── index.ts         # Gate workflow logic
│   ├── sandbox-runner/      # Sandbox execution
│   │   └── index.ts         # Execution environment
│   ├── queue-consumer/      # Event processing
│   │   └── index.ts         # Push event handler
│   └── shared/
│       └── auth.ts          # Bearer-token auth gate
├── ui/                      # Frontend (Phase 0)
│   └── src/
│       ├── components/      # React components
│       ├── pages/           # Page components
│       └── services/        # API client
├── scripts/                 # Utility scripts
│   ├── spike-local.sh       # Local spike validation
│   ├── spike-validation.sh  # Remote spike validation
│   └── synthetic-monitoring.sh
├── docs/                    # Documentation
│   ├── SETUP.md            # Comprehensive setup guide
│   ├── MILESTONES.md        # Project milestones
│   ├── ARCHITECTURE.md      # Architecture decisions
│   ├── OPEN-QUESTIONS.md    # Known issues & findings
│   ├── ARTIFACTS-SETUP.md  # Artifacts configuration
│   └── UI-DASHBOARD-PLAN.md # Dashboard roadmap
├── wrangler.toml            # Main worker config
└── package.json             # Project config
```

---

## 📝 Non-Negotiable Rules

1. **TypeScript everywhere** - Zig→WASM only for profiled CPU-bound kernels
2. **Orchestration spine is hand-written** - Spec schema, DO ledger, promotion train, workflow sequencing
3. **Fork, don't contend** - Never design "many agents push one repo/one branch"
4. **Coordination state lives in Workers-native stores**
   - Scores, verdicts, train state → Spec DO (SQLite)
   - Metric streams → Analytics Engine
   - Cross-spec indexes → D1
   - Git notes only for portable provenance
5. **Always-pushed invariant** - No task reaches done/failed without a final push
6. **No external CI** - Validation via Sandboxes/Workflows, deploys via Workers Builds
7. **Rollback is a ref operation** - Promotion and demotion must remain equally cheap

---

## 🤝 Contributing

### Commit Message Format

```
step: <description> | task: <id> | spec: <clause> | confidence: <0-1>
```

Examples:
```
step: implement artifacts integration | task: artifacts-integration | spec: n/a | confidence: 0.95
step: fix wrangler configs | task: worker-auth-and-deploy-config | spec: n/a | confidence: 0.9
```

### Agent Working Conventions

- Follow the milestone plan; don't skip to M3 features during M1
- Undocumented Artifacts behavior → write to `docs/OPEN-QUESTIONS.md`
- Candidate services stay small and stateless
- Every module reachable from Workflow, Queue consumer, or edge router
- Spin work is hand-written; leaf functions can be agent-generated

---

## 📞 Support

- **Issues**: Report in GitHub Issues
- **Questions**: Check `docs/OPEN-QUESTIONS.md` first
- **Architecture**: See `docs/ARCHITECTURE.md` and `docs/MILESTONES.md`
- **Setup Guide**: Complete installation instructions in `docs/SETUP.md`

---

## 📄 License

MIT License - see LICENSE file for details.
