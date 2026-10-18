---
category: planning
status: active
audience: human,agent
---


# Milestones

**Current phase: post-submission (2026-10-15).** Competition entry and demo video submitted.

**Recommended execution order (Opus agent review 2026-10-15):**
0. Stabilize (fix tests, CI gates, commit docs) → M5a (idempotency + bootstrap schema) → M7 (session provenance) → Capability minting (M3 + M6.2 merged) → M5b (trust registry calibration) → M6.5 (semantic navigation) → M6.2 items deferred

Mocked semantic UI (M6) is in the API worker; real semantic layer (M6.5) is not built. M3 train/canary/promotion workers exist in `workers/`; the Varda-inspired spine items (DO facets, capability minting, ArtifactFS) have no implementation in the repo and remain open. M2 completed 2026-10-12 with all 4 workers deployed and operational: shadow-router (traffic mirroring), scientist-comparator (declared delta surface validation), preview-manager (Workers Builds integration), candidate-service (preview operations). Analytics Engine capturing per-candidate metrics (10+ rows). All components health-checked and verified. SPIKE completed 2026-10-11 with exit criteria met: 3 forks, 3 pushes (first-writer-wins verified against real Artifacts), 3 events, zero manual steps — validated locally (Miniflare, 13/13) and remotely. Findings in `docs/OPEN-QUESTIONS.md`.

**Spike — prove the riskiest assumption.** Baseline repo → fork 3× via binding → sandbox
runner clones one fork → hardcoded "agent" commits+pushes → push event via Queues →
consumer logs it.
**Exit criteria:** 3 forks, 3 pushes, 3 events received, zero manual steps. Any Artifacts
surprise → write into OPEN-QUESTIONS.md immediately.

**M1 — Spec trials, no live traffic (to ~Oct 10).** Spec schema (contract + acceptance +
declared delta surface); orchestrator Worker (fork → sandbox → cheap-model agents); push
event → Queue → gate Workflow (tests only); DO ledger with scores + actor identity +
complexity delta; trial UI showing candidate comparison.
- **Ledger lifecycle (spine work) — implemented and merged to `main` (2026-10-16); the live
  Spec DO is still on m3 until the maintainer deploys, so production has no delete routes
  yet.** Tombstones + maintainer-only purge, migration m4 -> m5; usage in `docs/OPS.md`
  ("Ledger cleanup"), gaps in OPEN-QUESTIONS 2026-10-15 "Ledger lifecycle". Original finding:
  the Spec DO is append-only with no delete routes
  (2026-10-13 finding in OPEN-QUESTIONS.md: the only wipe is `wrangler delete beehive
  --force` + redeploy, which destroys all ledger data and worker secrets — fine for
  test data, unacceptable once real trials exist). Ship with M1: soft-delete/tombstones
  for specs and candidates (ledger records are never destroyed, only marked), plus one
  authenticated admin purge route for test-data cleanup behind the auth gate, restricted
  to maintainer-actor IDs. Per the sequencing rule, this is hand-written spine.

**M2 — Empirical oracle COMPLETE (2026-10-12).** All 5 components delivered and deployed:

- **Workers Builds Previews per candidate** — Preview Manager Worker creates isolated Worker preview deployments for each candidate via Workers Builds API, stores preview URLs in Spec DO
- **Edge mirror Worker fanning out and discarding** — Shadow Router Worker mirrors production traffic to candidate previews, discards candidate responses (never returned to users), triggers async Scientist comparison
- **Scientist comparator against declared delta surface** — Scientist Comparator Worker validates candidate behavior against spec's declared delta surface (status codes, headers, body, response time, declared surface coverage)
- **Analytics Engine per-candidate metrics** — All 4 M2 workers instrumented with Analytics Engine, capturing request counts, latency percentiles, match rates, diff severities per candidate
- **Service bindings and queue infrastructure** — Queue-based communication with separate preview/production queues (`beehive-scientist-comparisons`, `preview-scientist-comparisons`, `preview-artifacts-push`, `preview-artifacts-events`), service bindings between queue-consumer → preview-manager

**Exit criteria met:** All M1 functionality preserved; end-to-end flow verified: spec → claim → develop → push → gate → preview → shadow → compare → metrics. Schema migration system added for existing Spec DO instances.

**M3 — Promotion train + Architectural Foundation (2–3 days).** PARTIAL: `promotion-worker`
(tournament and merge-train modes), `canary-worker` (rollback), and Statsig config in
`shadow-router` (local traffic-split config, no Statsig SDK) exist. Facets, capability minting,
and ArtifactFS below are not implemented; canary auto-rollback is not wired (monitor never
called, `getMetric` returns 0), `canary-rollback-triggers` and `promotion-events` have no
producers, and speculative projection forks have no code.
Statsig slicing, speculative projection forks, tournament vs merge-train modes, canary with
auto-rollback.
**Varda-inspired spine work (OPEN):**
- **Durable Object Facets for per-candidate isolation** — Spec DO spawns a facet (with isolated SQLite) for each candidate; supervisor pattern controls access
- **Basic capability minting** — Gate verdicts grant time-bound, scoped capabilities to agents (read-only trial access, merge permission)
- **Shadow → Train transition via facets** — Each train car = isolated facet for safe concurrent promotion
- **Local workerd validation** — Ensure spine runs locally for demo and development
- **ArtifactFS integration** — Mount candidate repos as lazy-loaded filesystems; agents hydrate only files they touch (no full clones)
- **Capability-scoped mounting** — Spec DO mints capabilities with path restrictions; ArtifactFS respects these scopes at mount time
**Exit criteria:** Promotion pipeline operational with isolated candidate execution; capability-based access control between Spec DO and candidate grains; ArtifactFS lazy-loading verified for agent workspaces.

**M4 — Submission package + Agent Autonomy Demo (1–2 days).** SUBMITTED (reported by
maintainer 2026-10-15; demo video recorded, LICENSE is MIT). Agent-autonomy items below were not verified in the
repo; treat as open unless a commit says otherwise. Demo video (one spec, three agents, live winner), MIT/Apache LICENSE, repo cleanup, 5–10 min video requirement.
**Agent autonomy:**
- **Agent-created issues/specs** — When agents detect out-of-scope problems, they create new issues and optionally draft new spec candidates
- **Change-type classification** — Agents tag meta/infra issues with appropriate change types for routing
- **Semantic search integration** — Index repo metadata (not contents) for agents to find relevant files; ArtifactFS hydrates only matched files
- **Repo-per-agent pattern** — Demonstrate per-agent ArtifactFS mounts with lazy loading; show bandwidth/memory efficiency vs full clones
- **Demo script:** Show concurrent agent work, issue creation, candidate spawning, and lazy file access
**Exit criteria:** Competition submission complete with video demonstrating multi-agent coordination, autonomous issue/spec generation, and ArtifactFS lazy-loading benefits (startup time <1s, minimal bandwidth usage).

**M5a — Trust & Governance Layer: Core Schema (post-submission, do next).** 
Bootstrap governance with minimal viable ledger changes and change-type classification:

**Architecture of distrust principle:** "The agent cannot be trusted, so build so that its mistakes cannot matter." Every agent starts with zero capabilities; authority flows only through explicit capability grants.

- **Idempotent operations** — All Spec DO mutations include idempotency keys; handle at-least-once Queue delivery without ordering guarantees. **CORRECTNESS BUG: Queue delivery is at-least-once and double-writes are possible today.**
- **Bootstrap schema fields.** Ledger fields that ship from day one: change-type classification, approval records, self-approval markers, cost attribution. This stops later governance work from needing a migration.
- **Change-type classification** with confidence (typo-fix / refactor / behavior-change / security-sensitive / dependency-change / infra). Change type drives the gate policy: which oracles are mandatory, which can be skipped. **Note: Also an open M4 agent-autonomy item; do once and count for both.**
- **Two-person merge rule enforced at Spec DO promotion step.** Starting in bootstrap mode (self-approvals marked as such) so governance is retrofittable by policy change, not schema migration.
**Exit criteria:** Idempotency keys prevent double-writes; bootstrap fields added to ledger; change-type classification operational; two-person rule logic in place (even if only self-approvals for now).

---

**M5b — Trust & Governance Layer: Calibration (deferred).** Trust registry and advanced features that need measured outcomes:

- **Enriched issue intake.** Every reported issue carries, from creation: complexity estimate (reuses complexity-delta scoring), reporter trust level, and cost attribution.
- **Actor trust registry.** Extends M1: trust scores per reporter/initiator, calibrated by measured outcomes (promoted candidates, SLO outcomes, near-miss rate). Trust gates: agent-budget authorization, oracle-skipping privileges, promotion authority (per ADR 0005).
- **Full object-capability model** — Cap'n Proto or similar for Spec DO ↔ grain communication. **Note: Merged with M6.2 capability work and M3 capability minting into a single capability system.**
- **Grain-level versioning and rollback** — Each candidate facet maintains state snapshots; rollback restores grain to previous version without affecting others
- **Agent authorization for issue/spec creation** — Trust registry tracks which agents are authorized to create issues and specs (prevents runaway agent generation)
- **Gatekeeper granular controls** — Repository scoping, field masking, rate limiting, human approval gates for side-effecting writes
- **V8 isolate performance** — Leverage Workers/Durable Objects (V8 isolates) for 10x-100x faster cold starts vs containers, enabling per-agent isolation at scale
**Exit criteria:** Trust registry calibrated with real outcome data; OCAP model unified across M3/M5/M6.2; fine-grained access controls operational.
**Defer until:** M7 provides outcome data for calibration, and capability minting (M3) is built.

**M6 — Semantic Dashboard UI (post-submission, 1–2 days).** Bring the logged-in UI
closer to the platform vision with semantic intelligence at its core, even if mocked initially.
- **Semantic search & changelog in main views** — Every org and repo page shows semantic
  search over the codebase and a semantic changelog summarizing recent activity
- **Repository detail pages** — Each repo displays its linked spec, commits with builds,
  explorable file tree, and tabs for issues/specs
- **Linked navigation** — List and detail pages cross-link (specs → candidates → trials →
  promotion records, repos → their specs, orgs → their repos)
- **Mocked examples for now** — Use fake but realistic semantic data to demonstrate the vision
  before the actual semantic layer is built
- **Preserve server-rendered approach** — Continue rendering in the API worker to avoid
  build pipeline complexity
**Exit criteria:** Semantic UI concepts visible and navigable; all existing `/app` functions
(creating orgs/repos/specs) still work; mocked semantic sections clearly labeled as such.

**M6.2 — OCAP CI Security (merged with M3 capability minting, do after M5a and M12 verified identity).** Service-scoped object-capability model for CI workflows. **NOTE: Capability validation and OCAP model merged with M3 capability minting and M5's OCAP items into a single capability system.** See full plan in `docs/OCAP-CI-PLAN.md`.
- **Service registry** — Services as first-class entities in Spec DO, with path prefixes for monorepos
- **Capability validation in gate workflow** — PRs can only modify services the actor has capabilities for. **Unified with M5 capability model.**
- **Scoped token generation** — CI workflows receive tokens limited to specific services and resources
- **Service-aware deployment** — Deployment requests validated against service capabilities before execution
- **Migration path** — Auto-register services from existing repos, phase out repo-wide tokens
**Exit criteria:** Services tracked in Spec DO; gate workflow enforces service capabilities; scoped tokens generated and validated; migration complete for existing repos; both polyrepo and monorepo patterns fully supported; **single unified capability system built (not two separate ones).**

**M6.5 — Semantic Navigation & Change Intelligence (push back, do last).** Build the functional semantic layer. **NOTE: Exit criteria cannot be checked without an evaluation setup. M6 mocked UI is enough for demos. If semantic search is needed now, M7's D1 intent index provides a cheaper alternative.** See full plan in `docs/SEMANTIC-NAVIGATION-PLAN.md`.
- **Semantic Index** — Index codebase entities (functions, classes, endpoints, types) with vector embeddings
- **Change Tracker** — Parse and semantically categorize commits, diffs, and builds (bug-fix, feature, refactor, config, dependency, test) with >90% accuracy
- **Navigation Graph** — Build relationship graph between entities (calls, imports, inheritance) with sub-100ms query latency
- **UI Integration** — Replace M6 mocked semantic features with real implementation: semantic search, semantic changelog, impact analysis
- **Agent Integration** — Enable agents to use semantic navigation for file discovery and change tracing, reducing token usage by >20%
**Exit criteria:** Semantic search operational with >80% recall and sub-500ms latency; change classification >90% accurate; navigation graph covers >95% of entities; all M6 mocked features use real data; agents successfully use semantic navigation. **Note: Build eval set before index.**

**M7 — Session Provenance & Intent Index (post-submission, 2–4 days).** Link every candidate
and commit to the agent session that produced it, so review can use rationale as well as
outcome. Inspired by Entire's checkpoints (commit trailer → session record); Beehive's
addition is joining rationale to oracle-ladder outcomes.
- **Provenance trailer** — Commits carry a `Beehive-Trial: <candidate-id>` trailer pointing
  at the Spec DO record. Pointer only; never queried as live state (rule 4).
- **Session records** — Agent transcript, tool activity, and token usage stored per
  candidate (R2 body, DO row with metadata and content hash). A git note holds only the hash
  for portable provenance.
- **Redaction at the sandbox boundary** — Secrets scrubbed before a transcript reaches R2,
  D1, or Analytics Engine; redaction counts recorded on the session row.
- **Intent index (D1)** — Cross-spec search over spec clauses, candidate rationale, and
  verdict reasons ("which candidates failed this clause before, and why?").
- **Successor handoff** — A candidate held at shadow can seed a new fork with the prior
  session summary and diff verdict (iterate, don't contend).
**Exit criteria:** Every new commit resolves to a trial and session record; no secret
fixtures survive redaction in tests; intent search returns prior failures for a clause;
one successor candidate demonstrably starts from a prior session.

**M8 — Surface parity and route correctness (proposed 2026-10-16, not started).** Make the
API, CLI and UI agree, and remove calls to routes that do not exist. Source of truth:
`docs/FEATURE-PARITY.md` (read from code only; confirm each "broken" claim at runtime first).
- **Route correctness: done 2026-10-16** (`agent/promotion-routes-fix`): the promotion worker's calls to
  nonexistent Spec DO routes now use `GET /api/candidates/:id` and `PATCH /api/candidates/:id/stage`
  (`docs/OPEN-QUESTIONS.md` 2026-10-16). Deployed once the merge is pushed and `git push cf main` runs.
- **UI:** `doReader` surfaces errors instead of turning 404/500 into empty lists.
- **UI issue pages: done 2026-10-17** (PR 1, the Spec DO half, and PR 2, the UI, are on `main`). Issue
  comments use `/api/issues/:id/comments`; the repo issue pages (list, new, detail, comment, close/reopen) are reachable in the 2-part,
  3-part and UUID URL forms and scoped to their repo. 13 of the 14 defects in `docs/M8-UI-ISSUES-PLAN.md` section 1 are fixed; defect 11
  (`doReader.get` maps a DO catch-all 404 to "not found") is deliberately left open and pinned by a test for the follow-up. Live once the
  maintainer pushes to the Artifacts repo.
- **CLI fixes:** `promotion create`/`trial decide` bodies, `health extended` path, `promotion get`;
  register missing options and implement the create stubs; delete dead `workflow`,
  `deployment`, `environment` groups.
- **CLI additions:** commands for existing API routes (comments, stage, links, execute);
  `service-account` group.
- **Out of scope:** UI extras (parity task 8); read-only ledger/canary view and `rollback`
  wrapper (parity task 9, needs sign-off); edge `/health` fix; tournament creation race.
- **Exit criteria:** every CLI command parses with its flags (smoke test); no UI page maps an
  error to an empty list; no client calls a missing route; local e2e green.
- **Sequencing:** CLI tasks share `cli/src/utils/api-client.ts` and `cli/src/index.ts`; run
  them serially, each branch cut from `main`.
- **UI issue pages (plan):** `docs/M8-UI-ISSUES-PLAN.md`, reviewed in
  `docs/M8-UI-ISSUES-PLAN-REVIEW.md`, `docs/M8-PR1-REVIEW.md`, `docs/M8-PR1-RECHECK.md`, `docs/M8-PR2-REVIEW.md` and, for the CLI actor stopgap, `docs/CLI-DEFAULT-ACTOR-REVIEW.md`. Two PRs: Spec DO changes first, then the UI (both done, see above).

**M9 — Site navigation (implemented 2026-10-17 on `agent/m9-nav`; not yet merged or deployed, independent review L9 pending).** Give the
logged-in `/app` UI one shared layout with real navigation. Plan: `docs/M9-NAV-PLAN.md` (v2), reviewed in `docs/M9-NAV-PLAN-REVIEW.md`.
Code: `workers/api/ui-layout.ts` (`appPage`, `statusPage`, trail builders, lazy chrome source).
- **Navbar: done.** Brand link, org switcher (20 orgs, then "All organizations (N)"), Dashboard / Repositories / Specs
  (dashboard anchors), signed-in user and sign-out. "Issues" is contextual: it appears only inside a repo (no cross-repo
  issue index exists).
- **Breadcrumbs: done.** `Dashboard › org › repo › Issues › #12` and the spec, candidate, trial and status-page trails.
- **Search box: done.** One mocked search box per page (navbar), labelled "Search (mocked)"; the in-page search forms are
  gone, the results sections stay. Disabled where a page has no results.
- **Shared layout pieces: done.** One flash area with live-region roles, current-page marks, skip link, landmarks,
  contrast fixes (flash text, status badges), focus ring.
- **Out of scope (see M10):** user menu, notifications, command palette.
- **Exit criteria:** every `/app` session page uses the layout (pre-login pages use a minimal shell); existing `/app`
  functions (create org, repo, spec, issue) still work; no new fetch maps an error to an empty list (a failed nav read says
  "unavailable"); local e2e green. Manual visual checklist: `docs/M9-NAV-PLAN.md` section 5.

**M10 — Account menu and notifications (proposed 2026-10-17, future).** Needs the M9 layout.
- **User menu:** profile, API tokens and service accounts, sign-out.
- **Notifications:** promotion, canary rollback and gate results. Open decision for a human: where the state
  lives. By the architecture rules it is a Spec DO table (not the repo), which is spine-adjacent.
- **Command palette:** keyboard-driven navigation and search.
- **Exit criteria:** to be set when the notification storage decision is made.

**M11 — Issue links and closed-issue comment setting (proposed 2026-10-17, future; after M9).** Both need a
Spec DO schema change, so they ship together in one additive migration, in their own two pushes (the first
makes an old DO tolerate an unknown `schema_version`; see `docs/M8-UI-ISSUES-PLAN.md` "Deferred"). Plan first;
spine work, a human reviews.
- **Issue-to-issue links:** a new `issue_issue_links` table, routes and UI ("follow-up of", "see also"),
  limited to issues in the same organisation.
- **Closed-issue comment setting:** a per-repository setting for whether closed issues accept comments
  (default: they do). A new column, not a new `comment_policy` value.
- **Also here if wanted:** unique `(repository_id, number)` index (re-run the duplicate check first), a
  distinct entity-404 error, number-based issue URLs.
- **Exit criteria:** migration applied with an old and a new DO both serving; `migrations.test.ts` and
  `schema-sync.test.ts` green; org purge still works; local e2e green.

**M12 — Verified identity and user tokens (proposed 2026-10-17, future; capability minting (M3 + M6.2) depends on it).**
Today `authenticate()` (`workers/api/principal.ts`) knows only the master token, whose actor is the client-sent
`X-Actor-ID`, and read-only service tokens; UI users arrive through a GitHub session. A capability granted to an
actor that anyone holding the master token can claim proves nothing, so minting needs a verified principal first.
Spine work: a human designs it; start from the 2026-10-17 proposal in `docs/OPEN-QUESTIONS.md`.
- **User tokens:** `authenticate()` returns a `kind: 'user'` principal; where tokens are minted, stored (hashed),
  scoped, expired and revoked; how a token maps to an `actors` row.
- **Master token:** what happens to actor assertion once user tokens exist (keep for break-glass admin only?).
- **CLI:** login/token storage replaces the default-actor stopgap below.
- **Stopgap until then (small, CLI only):** apply `defaultActor` (config) or `BEEHIVE_ACTOR` (env) to every request
  as `X-Actor-ID`, `--actor` still overriding; the actor must be a real `actors` row. This is attribution, not
  authentication; document it as an admin stopgap in `docs/OPS.md`.
- **Exit criteria:** to be set in the design; at minimum, a write by a user token cannot name a different actor.

---

## Future / Optional

- **WfP: Workers for Platforms Migration** — Migrate candidate execution to Workers for Platforms
  - Replace Artifacts-based candidate deployments with User Workers
  - Use dynamic dispatch Worker for Shadow/Canary/Train routing
  - Benefit: Native isolation, simplified deployment, built-in observability
  - Blocked: Requires Workers for Platforms paid tier
  - Confidence: 0.95 (architectural fit verified)

---

**Sequencing rule:** agents write candidates and glue; you write the orchestration spine.
If a task touches the spec schema, DO ledger, or train logic, it belongs to a human or a
single carefully supervised session — not to an autonomous agent run.
