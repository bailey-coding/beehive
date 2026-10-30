# Contributing to Beehive

Thank you for contributing to Beehive! This document explains how to contribute to the project.

---

## 🚀 Getting Started

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

# For local dev (Miniflare), set dev vars
cp .dev.vars.example .dev.vars
# Edit .dev.vars with local API_AUTH_TOKEN

# Start the main worker (includes Spec DO)
npm run dev

# In separate terminals, start the other workers
npm run dev:gate      # Gate Workflow
npm run dev:sandbox   # Sandbox Runner  
npm run dev:queue     # Queue Consumer
```

### Deployment

```bash
# Create the queue
npm run queue:create

# Set secrets on all workers
wrangler secret put API_AUTH_TOKEN -n beehive
wrangler secret put API_AUTH_TOKEN -n beehive-gate-workflow
wrangler secret put API_AUTH_TOKEN -n beehive-sandbox-runner
wrangler secret put API_AUTH_TOKEN -n beehive-queue-consumer

# Set Cloudflare credentials for Artifacts integration
wrangler secret put CLOUDFLARE_API_TOKEN -n beehive

# Deploy all workers
npm run deploy
npm run deploy:gate
npm run deploy:sandbox
npm run deploy:queue
```

---

## 📝 Commit Message Format

All commits must follow this format:

```
step: <description> | task: <id> | spec: <clause> | confidence: <0-1>
```

**Example:**
```
step: implement artifacts integration | task: artifacts-integration | spec: n/a | confidence: 0.95
step: fix wrangler configs | task: worker-auth-and-deploy-config | spec: n/a | confidence: 0.9
step: advance phase status from SPIKE to M1 | task: knowledge-capture | spec: n/a | confidence: 1.0
```

**Fields:**
- `step`: What changed (imperative, present tense)
- `task`: Task identifier or category
- `spec`: Relevant spec clause (or `n/a`)
- `confidence`: 0.0-1.0, your confidence in the change

---

## 🤖 Agent Working Conventions

If you're an AI agent contributing to Beehive, follow these rules:

### Before Writing Code

1. **Reference first, generate later** - Always read:
   - `AGENTS.md` (agent conventions)
   - `docs/ARCHITECTURE.md` (technical design)
   - Relevant ADRs in `docs/decisions/`

2. **Use grep before asking** - Search existing docs, decisions, and open questions

3. **Leverage the milestone plan** - Check `docs/MILESTONES.md` for current phase

### During Development

1. **Follow the sequencing rule:**
   - Agents write candidates and glue
   - **Agents may write the orchestration spine** (Spec schema, DO ledger, promotion train, workflow sequencing) under plan + review: a written plan reviewed by an independent agent before code, and an independent agent review of the implementation before merge
   - If a task touches spine code, say so in the plan and PR

2. **Follow non-negotiable rules:**
   - TypeScript everywhere
   - Orchestration spine is agent-written under plan + review
   - Fork, don't contend (never many agents push one repo/branch)
   - Coordination state in Workers-native stores (not in repo)
   - Always-pushed invariant (every task ends with a push)
   - No external CI
   - Rollback is a ref operation

3. **Document surprises immediately:**
   - Any undocumented Artifacts behavior → `docs/OPEN-QUESTIONS.md`
   - Never implement silent workarounds

4. **Keep candidates small and stateless** (price calculator / URL shortener shape)

5. **Ensure reachability:** Every module must be reachable from a Workflow, Queue consumer, or the edge router

### Code Quality

- **Batch edits** - Group related changes into single commits
- **Prefer search_replace over rewrite** - Edit files in-place
- **Avoid redundant summaries** - State facts, decisions, actionable items only
- **Match existing style** - Indentation, naming, error handling density
- **Minimal diff** - Don't touch what wasn't asked

### Testing

- Run `npm run typecheck` before committing
- Run `npm run lint` before committing
- Tests should pass (when applicable)

---

## 🏗️ Architecture Guidelines

### What to Read First

1. **README.md** - Project overview, core thesis, quick start
2. **AGENTS.md** - Agent conventions, non-negotiable rules
3. **docs/ARCHITECTURE.md** - Technical deep dive
4. **docs/MILESTONES.md** - Project phases and current status
5. **docs/OPEN-QUESTIONS.md** - Known issues and findings

### Where to Store Data

| Purpose | Storage | When to Use |
|---------|---------|-------------|
| Coordination state | Spec DO (SQLite) | Scores, verdicts, train state |
| Cross-spec queries | D1 | Queries spanning multiple specs |
| Metric streams | Analytics Engine | Performance and telemetry |
| Provenance | Git notes | Portable history stamps |
| Candidate repos | Cloudflare Artifacts | All implementation repos |

### Service Bindings

- Use `binding` (never `name`) for service bindings
- Queue consumers use `[[queues.consumers]]` (not `[[queues]]`)
- Cross-script DO bindings need `script_name` in the binding entry

---

## 📊 Current Project Status

| Milestone | Status | Target | Exit Criteria |
|-----------|--------|--------|----------------|
| **SPIKE** | ✅ Complete | 2026-10-11 | 3 forks, 3 pushes, 3 events, 0 manual steps |
| **M1** | 🚧 In Progress | ~Oct 10 | Spec trials, no live traffic |
| **M2** | ⬜ Planned | Stretch | Empirical oracle (shadow mode) |
| **M3** | ⬜ Planned | Post-deadline | Promotion train + canary |
| **M4** | ⬜ Planned | Submission | Demo video, cleanup |

**Recent Progress:**
- ✅ All 4 workers deployed with fail-closed auth
- ✅ Local validation: 13/13 spike checks passed
- ✅ Remote Artifacts validation: concurrent ordering verified
- ✅ Spec DO SQLite storage working
- ✅ Full REST API for all entities
- ✅ Artifacts integration for spec claim
- ✅ Queue-gate wiring complete

---

## 🤝 Reporting Issues

- **Bugs/Features**: GitHub Issues
- **Undocumented Artifacts behavior**: Add to `docs/OPEN-QUESTIONS.md` immediately
- **Questions**: Check existing docs first, then ask

---

## 📄 License

By contributing, you agree that your contributions will be licensed under the **MIT License**. See [LICENSE](LICENSE) for details.
