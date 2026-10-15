# Beehive Code Agent Context Pack

Agents read this file first; `docs/` is the reference layer (see Pointers at the end).

---

## What this project is

**Beehive** (working title; formerly "Spec-Trial") is an agent-native version control and
collaboration platform built on Cloudflare's developer platform, entered in Cloudflare's
"Build the Next-Gen Git Platform" competition (submissions close **2026-10-14**).

The core thesis: multiple agents independently implement the same machine-readable spec;
live production traffic — layered over deterministic gates — decides which implementation
ships. Review is differential and empirical, not social.

This is **not** "GitHub with agents bolted on." The platform treats specs, candidates,
verdicts, and outcomes as first-class, linked artifacts.

### Non-negotiable architectural rules

1. **TypeScript everywhere.** Zig→WASM only for profiled CPU-bound kernels — and only
   after a measurement justifies it.
2. **Orchestration spine is hand-written.** Spec schema, DO ledger, promotion train,
   Workflow sequencing are load-bearing walls. Code agents write leaf functions, glue,
   tests, and candidate services.
3. **Fork, don't contend.** Never design a "many agents push one repo/one branch" flow.
4. **Coordination state lives in Workers-native stores, never in the repo.**
   - Scores, verdicts, train state → **spec Durable Object (SQLite)**, transactional.
   - Metric streams → **Analytics Engine**. Cross-spec indexes → **D1**.
   - Git notes only for portable provenance stamps — never queried as live state.
5. **The always-pushed invariant.** No agent task reaches done/failed without a final
   push. Intermediate states go to `scratch/*` refs. Nothing is ever local-only.
6. **No external CI.** Validation = Sandboxes via Workflows (Cloudflare CI SDK pattern).
   Deploys = Workers Builds (candidate pipeline; the platform's own workers deploy via
   GitHub Actions `deploy.yml`, see `docs/OPS.md`).
7. **Rollback is a ref operation.** Promotion and demotion must remain equally cheap.

### The oracle ladder (memorize)

| Rung | Traffic | Oracle | Failure action |
|---|---|---|---|
| Pre-merge | none | tests, property/fuzz, spec conformance | never board the train |
| Shadow | mirrored, discarded | Scientist diff vs spec's declared delta surface | hold, iterate |
| Train | projection slice | combined-candidate conformance | drop car, re-project |
| Canary | small % live | SLOs via Statsig + Analytics Engine | auto-rollback (ref op) |
| Full | 100% | drift, holdouts | alarm, bisect by diff |

A candidate is promotable only when it clears all rungs. The spec DO is the single
serialization point for promotion decisions.

### Working conventions

- Work only on the current phase in `docs/MILESTONES.md`; spine items (rule 2) need a human.
- Undocumented Artifacts behavior → write a finding into `docs/OPEN-QUESTIONS.md`, never
  a silent workaround.
- Candidate services stay small and stateless (price calculator / URL shortener shape).
- Every module must be reachable from a Workflow, Queue consumer, or the edge router.
- Commit messages: `step: <desc> | task: <id> | spec: <clause> | confidence: <0-1>`.

---

## Agent Efficiency Guidelines

### Token and context optimization

- **Reference first, generate later.** Read `AGENTS.md` in full. Read `docs/ARCHITECTURE.md` and relevant ADRs by section (grep for the headings you need), not whole-file, because every read is resent on every later turn. The answer is usually already documented.
- **Use grep before asking.** Search existing docs, decisions, and open questions before requesting clarification.
- **Batch edits.** Group related file changes into single commits with descriptive messages.
- **Prefer search_replace over rewrite.** Edit files in-place to preserve existing structure and comments.
- **Avoid redundant summaries.** Skip generic explanations; state facts, decisions, and actionable items only.
- **Keep the context pack lean.** `AGENTS.md` is loaded into every turn. Add a note here only after the same mistake happens twice, and prune stale notes. Keep this file under ~200 lines.
- **Reference files by path, don't paste.** Point at `path:line` instead of pasting file contents or logs. Trim logs and stack traces to the relevant 20–30 lines.
- **Clear and compact between phases.** Start a fresh session for unrelated work (new milestone, new worker). Compact mid-task only when a long task must continue. Hand off state via a committed doc, not chat history.
- **Plan before multi-file changes.** For work touching more than 2–3 files (especially across workers or the spec DO schema), write a file-by-file plan and get it accepted before editing.
- **Check usage.** Use `/cost` and `/context` (or your agent's equivalents) to see what is loaded before a long run.

### Model routing and delegation

Tiers: heavy (hard debugging, spec/architecture, promotion-train logic; plan first), default
(features, tests), light (lookups, edits). Orchestrator: spawn agents via its API. Inside a
Worker: never use orchestrator spawning; run solo or use `tools.subagent`. Table and detail:
`docs/AGENT-ROUTING.md`.

### Working patterns

- **Fork-per-agent invariant.** Each agent works in its own fork. Never push to shared branches.
- **Always-pushed invariant.** Every task ends with a push. Use `scratch/*` refs for intermediate states. Applies to candidate forks and `scratch/*`; pushing `main` deploys production, so only on explicit human approval.
- **GitHub auto-deploy.** Never run `wrangler deploy` — pushing to GitHub automatically deploys all workers via GitHub Actions workflows. `wrangler deploy --dry-run` is fine for validation.
- **Deterministic outputs.** Commit messages follow the format: `step: <desc> | task: <id> | spec: <clause> | confidence: <0-1>`.
- **Document surprises immediately.** Any undocumented Artifacts behavior goes straight to `docs/OPEN-QUESTIONS.md`.
- **Avoid duplicate work.** Before creating new agents, check if existing agents or subagents have already completed the task. Flag overlaps explicitly: "Agent X already delivered Y. Creating new agents will duplicate work. Confirm?"
- **Use isolated workspaces.** When running concurrent agents on the same repo, use separate worktrees (`--new-workspace worktree --worktree-slug <name>`) or branches (`--new-branch <name>`) to prevent merge conflicts and file contention.

### State management

- **Spec DO is source of truth.** All coordination state (scores, verdicts, train state) lives in the Durable Object SQLite store.
- **Git notes are for provenance only.** Never query git notes for live state; use them only for auditable history.
- **D1 for cross-spec queries.** Use D1 for any queries that span multiple specs.
- **Analytics Engine for metrics.** All performance and telemetry data goes to Analytics Engine.

---

## Cloudflare Artifacts

**Required for Beehive:** All candidate repos live in Cloudflare Artifacts.  
See `docs/ARTIFACTS-SETUP.md` for verified setup patterns, CLI commands, authentication, and pricing.

---

## Deployment Topology & Ops

Ten Workers, deployed by `.github/workflows/deploy.yml` on every push to `main`; each has its
own wrangler config and the worker `name` there is the source of truth for URLs. The web UI
is served by the `beehive` worker (`workers/api/ui.ts`); the React app in `ui/` is **not**
built or deployed. Topology, secrets, token scopes, ledger wipe: `docs/OPS.md`.

**Never run e2e against production without human approval.** The Spec DO ledger has no
delete routes; the only cleanup deletes the `beehive` worker (all ledger data and secrets).

Config rules that bit this repo twice:
- Service bindings take `binding = "..."`, never `name = "..."`.
- Queue consumers attach via `[[queues.consumers]]`; `[[queues]]` is the producer form.

Auth is fail-closed on every fetch entry point (`workers/shared/auth.ts`): missing
`API_AUTH_TOKEN` → 503, wrong bearer → 401, including `/health` and local dev. Workers read
`API_AUTH_TOKEN` (`.dev.vars` locally). Clients must send `Authorization: Bearer`, from
`BEEHIVE_API_TOKEN` in `.env`; local e2e uses `local.apiToken` in `tests/e2e/config.ts`,
which must match `.dev.vars`.

Local e2e (`npm run test:e2e:local`) makes real HTTP calls: start the workers on ports
8787–8790 first (`docs/SETUP.md`). Before marking a milestone item done, grep for the
implementation; docs have drifted from code before.

See `docs/OPEN-QUESTIONS.md` for dated findings (Artifacts behavior, wrangler config
gotchas, deploy learnings).

---

## Data Model Reference

For implementation, see the canonical schema definitions:
- **M1 Core Entities:** Spec DO SQLite tables for `organizations`, `repositories`, `specs`, `candidates`, `actors`, `gate_verdicts`, `trials`, `promotions`
- **GitHub Integration:** `issues`, `issue_comments`, `issue_spec_links`, `issue_candidate_links` with `comment_policy` and `visibility` controls
- **Storage Layers:** Spec DO (SQLite) for coordination, D1 for indexes, Analytics Engine for metrics, Git notes for provenance

> Read `docs/ARCHITECTURE.md` next. Do not begin implementation before understanding both this file and the architecture document.

**Pointers:** `docs/SETUP.md` (local dev, e2e, self-hosting) · `docs/OPS.md` (topology, secrets,
ledger wipe) · `docs/TROUBLESHOOTING.md` (symptoms) · `docs/AGENT-ROUTING.md` (model tiers,
spawning) · `docs/FOCUS.md` (current open items) · `docs/MILESTONES.md` (plan).
