# Beehive Code Agent Context Pack

Four ready-to-commit files for bootstrapping the project repo. Commit each to the path
shown in its header. The agent reads `AGENTS.md` first; the rest are its reference layer.

**Current agent**: `Vibe Code` running on `mistral-medium-3-5` (previously `Vibe Nuage Agent`).

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
   Deploys = Workers Builds.
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

- Follow the milestone plan; do not skip ahead to M3 features during the spike.
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
- **Leverage the milestone plan.** Do not implement M3+ features during M1. Check `docs/MILESTONES.md` for current phase.
- **Keep the context pack lean.** `AGENTS.md` is loaded into every turn. Add a note here only after the same mistake happens twice, and prune stale notes. Keep this file under ~200 lines.
- **Reference files by path, don't paste.** Point at `path:line` instead of pasting file contents or logs. Trim logs and stack traces to the relevant 20–30 lines.
- **Clear and compact between phases.** Start a fresh session for unrelated work (new milestone, new worker). Compact mid-task only when a long task must continue. Hand off state via a committed doc, not chat history.
- **Plan before multi-file changes.** For work touching more than 2–3 files (especially across workers or the spec DO schema), write a file-by-file plan and get it accepted before editing.
- **Check usage.** Use `/cost` and `/context` (or your agent's equivalents) to see what is loaded before a long run.

### Model routing (match model to task)

Applies to agents running `mistral-medium-3-5`. Tiers are conceptual; map each to whichever Mistral model is configured for the provider.

| Tier | Use for | Model |
|---|---|---|
| Heavy | Hard debugging, wide cross-cutting refactors, spec/architecture decisions, promotion-train logic | `mistral-medium-3-5`, plan first; escalate to a larger model only if one is configured and the task justifies it |
| Default | Features, tests, known-bug fixes, refactors within one worker | `mistral-medium-3-5` |
| Light | Lookups, grep/search, simple edits, formatting, scripted or high-volume runs | `mistral-medium-3-5`, or a smaller Mistral model if one is configured; keep these prompts short |

- Rule of thumb: spend heavy-tier effort on planning, not on re-running large diffs.
- Do not spawn a heavy-tier agent for a light-tier task. Check which models are configured before assuming a cheaper model exists.

### Working patterns

- **Fork-per-agent invariant.** Each agent works in its own fork. Never push to shared branches.
- **Always-pushed invariant.** Every task ends with a push. Use `scratch/*` refs for intermediate states.
- **GitHub auto-deploy.** Never run `wrangler deploy` — pushing to GitHub automatically deploys all workers via GitHub Actions workflows.
- **Deterministic outputs.** Commit messages follow the format: `step: <desc> | task: <id> | spec: <clause> | confidence: <0-1>`.
- **Document surprises immediately.** Any undocumented Artifacts behavior goes straight to `docs/OPEN-QUESTIONS.md`.
- **Avoid duplicate work.** Before creating new agents, check if existing agents or subagents have already completed the task. Flag overlaps explicitly: "Agent X already delivered Y. Creating new agents will duplicate work. Confirm?"
- **Use isolated workspaces.** When running concurrent agents on the same repo, use separate worktrees (`--new-workspace worktree --worktree-slug <name>`) or branches (`--new-branch <name>`) to prevent merge conflicts and file contention.

### Agent Delegation & Spawning

- **In an agent orchestrator**: Spawn agents through the orchestrator's own API so they are tracked and visible in its UI. You can specify different models and thinking options.
- **In Cloudflare Workers**: Do **not** use the orchestrator's agent spawning. Worker-based bees should either run solo or use Vibe's native `tools.subagent` namespace if parallelism is needed—these subagents are not visible in the orchestrator, and Workers lack its UI access anyway.

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

## Deployment Topology & Ops (verified 2026-10-13)

Ten Workers on `*.bz23711.workers.dev`, deployed by `.github/workflows/deploy.yml` on every push to
`main` (it runs the `package.json` `deploy:*` scripts; each worker has its own wrangler config):

- `beehive` — edge router/API; hosts the `SpecDO` class (root `wrangler.toml`).
- `beehive-gate-workflow`, `beehive-sandbox-runner`, `beehive-queue-consumer` — configs
  at `workers/<name>/wrangler.toml`; the Spec DO is bound cross-script via
  `script_name = "beehive"`.
- M2/M3 workers: `beehive-shadow-router`, `beehive-scientist-comparator`,
  `beehive-preview-manager`, `beehive-candidate-service`, `beehive-canary-worker`,
  `beehive-promotion-worker`. Note the worker `name` in each `wrangler.toml` is the
  source of truth for URLs (older docs used shortened names).

**Web UI** (verified 2026-10-13): served by the `beehive` worker itself, not a separate
app. `/about` is public; `/login` -> GitHub OAuth -> `/app` (create orgs, repos, specs).
Code: `workers/api/ui.ts`. Access is limited to `ALLOWED_GITHUB_USERS` (var in root
`wrangler.toml`); secrets `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are set on `beehive`.
Sessions are HMAC-signed with `API_AUTH_TOKEN`. The React app in `ui/` is **not built or
deployed** (no build config); don't assume it is live.

Config rules that bit this repo twice:
- Service bindings take `binding = "..."`, never `name = "..."`.
- Queue consumers attach via `[[queues.consumers]]`; `[[queues]]` is the producer form.

Auth is fail-closed on every fetch entry point (`workers/shared/auth.ts`): missing
`API_AUTH_TOKEN` → 503, wrong bearer → 401, including `/health`. Set the secret on each
worker with `wrangler secret put API_AUTH_TOKEN`; local dev uses `.dev.vars` (gitignored);
tooling reads `BEEHIVE_API_TOKEN` from `.env` (gitignored).

Deploy token scopes: Workers Scripts:Edit + Workers Queues:Edit. Permission edits take
minutes to propagate — a fresh 403 right after granting scopes is expected; wait and
retry before debugging.

The Spec DO ledger has no delete routes. To wipe it (done 2026-10-13 to clear 27 `test-org-e2e-*`
orgs left by E2E runs against production): `wrangler delete --name beehive --force`, push to
`main` to redeploy, then re-put the secrets that live on `beehive` only: `API_AUTH_TOKEN`,
`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`. Other workers keep their own secrets. A `1042`
response means the worker is not deployed yet. When scripting the wait, watch the run for the
new SHA (`gh run watch <id>`); `gh run list --limit 1` can still return the previous run.
The `KV namespaces ... Authentication error` printed by `wrangler delete` is harmless.

See `docs/OPEN-QUESTIONS.md` for dated findings (Artifacts behavior, wrangler config
gotchas, deploy learnings).

---

## Data Model Reference

For implementation, see the canonical schema definitions:
- **M1 Core Entities:** Spec DO SQLite tables for `organizations`, `repositories`, `specs`, `candidates`, `actors`, `gate_verdicts`, `trials`, `promotions`
- **GitHub Integration:** `issues`, `issue_comments`, `issue_spec_links`, `issue_candidate_links` with `comment_policy` and `visibility` controls
- **Storage Layers:** Spec DO (SQLite) for coordination, D1 for indexes, Analytics Engine for metrics, Git notes for provenance

> Read `docs/ARCHITECTURE.md` next. Do not begin implementation before understanding both this file and the architecture document.
