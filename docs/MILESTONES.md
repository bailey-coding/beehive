---
category: planning
status: active
audience: human,agent
---


# Milestones

**Current phase: M2 — Empirical oracle COMPLETE.** M2 completed 2026-10-12 with all 4 workers deployed and operational: shadow-router (traffic mirroring), scientist-comparator (declared delta surface validation), preview-manager (Workers Builds integration), candidate-service (preview operations). Analytics Engine capturing per-candidate metrics (10+ rows). All components health-checked and verified. SPIKE completed 2026-10-11 with exit criteria met: 3 forks, 3 pushes (first-writer-wins verified against real Artifacts), 3 events, zero manual steps — validated locally (Miniflare, 13/13) and remotely. Findings in `docs/OPEN-QUESTIONS.md`.

**Spike — prove the riskiest assumption.** Baseline repo → fork 3× via binding → sandbox
runner clones one fork → hardcoded "agent" commits+pushes → push event via Queues →
consumer logs it.
**Exit criteria:** 3 forks, 3 pushes, 3 events received, zero manual steps. Any Artifacts
surprise → write into OPEN-QUESTIONS.md immediately.

**M1 — Spec trials, no live traffic (to ~Oct 10).** Spec schema (contract + acceptance +
declared delta surface); orchestrator Worker (fork → sandbox → cheap-model agents); push
event → Queue → gate Workflow (tests only); DO ledger with scores + actor identity +
complexity delta; trial UI showing candidate comparison.
- **Ledger lifecycle (spine work).** The Spec DO is append-only with no delete routes
  (2026-10-11 finding in OPEN-QUESTIONS.md: the only wipe is `wrangler delete beehive
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

**M3 — Promotion train + Architectural Foundation (2–3 days).** Statsig slicing,
speculative projection forks, tournament vs merge-train modes, canary with auto-rollback.
**Varda-inspired spine work:**
- **Durable Object Facets for per-candidate isolation** — Spec DO spawns a facet (with isolated SQLite) for each candidate; supervisor pattern controls access
- **Basic capability minting** — Gate verdicts grant time-bound, scoped capabilities to agents (read-only trial access, merge permission)
- **Shadow → Train transition via facets** — Each train car = isolated facet for safe concurrent promotion
- **Local workerd validation** — Ensure spine runs locally for demo and development
- **ArtifactFS integration** — Mount candidate repos as lazy-loaded filesystems; agents hydrate only files they touch (no full clones)
- **Capability-scoped mounting** — Spec DO mints capabilities with path restrictions; ArtifactFS respects these scopes at mount time
**Exit criteria:** Promotion pipeline operational with isolated candidate execution; capability-based access control between Spec DO and candidate grains; ArtifactFS lazy-loading verified for agent workspaces.

**M4 — Submission package + Agent Autonomy Demo (1–2 days).** Demo video (one spec, three agents, live winner), MIT/Apache LICENSE, repo cleanup, 5–10 min video requirement.
**Agent autonomy:**
- **Agent-created issues/specs** — When agents detect out-of-scope problems, they create new issues and optionally draft new spec candidates
- **Change-type classification** — Agents tag meta/infra issues with appropriate change types for routing
- **Semantic search integration** — Index repo metadata (not contents) for agents to find relevant files; ArtifactFS hydrates only matched files
- **Repo-per-agent pattern** — Demonstrate per-agent ArtifactFS mounts with lazy loading; show bandwidth/memory efficiency vs full clones
- **Demo script:** Show concurrent agent work, issue creation, candidate spawning, and lazy file access
**Exit criteria:** Competition submission complete with video demonstrating multi-agent coordination, autonomous issue/spec generation, and ArtifactFS lazy-loading benefits (startup time <1s, minimal bandwidth usage).

**M5 — Trust & Governance Layer (post-submission, hardening phase).** Issue intake and
merge governance as first-class platform mechanics with Varda-inspired enhancements:

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

**M6.2 — OCAP CI Security (post-submission, 2–3 days).** Service-scoped object-capability model for CI workflows, supporting both polyrepo and monorepo patterns. See full plan in `docs/OCAP-CI-PLAN.md`.
- **Service registry** — Services as first-class entities in Spec DO, with path prefixes for monorepos
- **Capability validation in gate workflow** — PRs can only modify services the actor has capabilities for
- **Scoped token generation** — CI workflows receive tokens limited to specific services and resources
- **Service-aware deployment** — Deployment requests validated against service capabilities before execution
- **Migration path** — Auto-register services from existing repos, phase out repo-wide tokens
**Exit criteria:** Services tracked in Spec DO; gate workflow enforces service capabilities; scoped tokens generated and validated; migration complete for existing repos; both polyrepo and monorepo patterns fully supported.

**M6.5 — Semantic Navigation & Change Intelligence (post-submission, 3–5 days).** Build the functional semantic layer for codebase navigation and change understanding. See full plan in `docs/SEMANTIC-NAVIGATION-PLAN.md`.
- **Semantic Index** — Index codebase entities (functions, classes, endpoints, types) with vector embeddings for intelligent search and discovery
- **Change Tracker** — Parse and semantically categorize commits, diffs, and builds (bug-fix, feature, refactor, config, dependency, test) with >90% accuracy
- **Navigation Graph** — Build relationship graph between entities (calls, imports, inheritance) with sub-100ms query latency
- **UI Integration** — Replace M6 mocked semantic features with real implementation: semantic search, semantic changelog, impact analysis
- **Agent Integration** — Enable agents to use semantic navigation for file discovery and change tracing, reducing token usage by >20%
**Exit criteria:** Semantic search operational with >80% recall and sub-500ms latency; change classification >90% accurate; navigation graph covers >95% of entities; all M6 mocked features use real data; agents successfully use semantic navigation.

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

**Architecture of distrust principle:** "The agent cannot be trusted, so build so that its mistakes cannot matter." — Every agent starts with zero capabilities; authority flows only through explicit capability grants.

- **Enriched issue intake.** Every reported issue carries, from creation:
  - *Complexity estimate* (reuses the complexity-delta scoring components, applied
    predictively to the change rather than post-hoc).
  - *Change-type classification* with confidence (typo-fix / refactor / behavior-change /
    security-sensitive / dependency-change / infra). Change type drives the gate policy:
    which oracles are mandatory, which can be skipped.
  - *Reporter trust level* and **cost attribution** — who foots the agent bill for
    spec→candidate runs triggered by this issue (reporter, project budget, or
    trusted-reporter waiver). A low-trust reporter requesting agent time on a
    security-sensitive change type should route differently than a maintainer asking
    for a typo fix, even with identical issue text.
- **Actor trust registry.** Extends the M1 actor identity model: trust scores per
  reporter/initiator, calibrated by measured outcomes (their past issues' promoted
  candidates, SLO outcomes, near-miss rate). Trust gates: agent-budget authorization,
  oracle-skipping privileges, and promotion authority (per ADR 0005).
- **Two-person merge rule (supply-chain defense).** Merges of designated change types
  (security-sensitive, dependency changes, anything touching auth/secrets/build
  pipeline, or any promotion initiated by an actor below a trust threshold) require
  approval from **two distinct maintainers** — the design lesson of recent supply-chain
  compromises (xz-style lone-maintainer social engineering, hijacked dependencies): a
  single trusted human is a single point of failure. The DO ledger records both
  approvals on the promotion record; the two approvals must come from different actor
  IDs (agents cannot hold maintainer approval authority — approvals are human-only
  capabilities, per the OCAP principle).
- **Bootstrap posture.** Until a second maintainer exists: the founder is sole
  author+maintainer, but the ledger schema, change-type classification, and approval
  fields ship from day one (populated with self-approvals marked as such) so governance
  is retrofittable by policy change, not schema migration.
- **Full object-capability model** — Cap'n Proto or similar for Spec DO ↔ grain communication, enforcing "only connectivity begets connectivity"
- **Grain-level versioning and rollback** — Each candidate facet maintains state snapshots; rollback restores grain to previous version without affecting others
- **Agent authorization for issue/spec creation** — Trust registry tracks which agents are authorized to create issues and specs (prevents runaway agent generation)
- **Gatekeeper granular controls** — Repository scoping, field masking, rate limiting, human approval gates for side-effecting writes
- **V8 isolate performance** — Leverage Workers/Durable Objects (V8 isolates) for 10x-100x faster cold starts vs containers, enabling per-agent isolation at scale
- **Idempotent operations** — All Spec DO mutations include idempotency keys; handle at-least-once Queue delivery without ordering guarantees

**Sequencing rule:** agents write candidates and glue; you write the orchestration spine.
If a task touches the spec schema, DO ledger, or train logic, it belongs to a human or a
single carefully supervised session — not to an autonomous agent run.
