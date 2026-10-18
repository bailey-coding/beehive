---
category: planning
status: active
audience: human,agent
---


*This document is a living focus tracker. Update it at the start/end of each session.
Completed items are removed, not struck through; history lives in git.*

**Last updated:** 2026-10-17

## Where we are

- The agent stack is merged and on `origin/main`: spine items 1 and 3 (promotion ledger routes,
  ledger lifecycle), CI-only workflow, service tokens, canary deploy/rollback as Spec DO refs, review
  fixes, Spec DO internal auth, shadow-router ref cache, and the ledger compare-and-swap with the
  tournament state machine (schema m8).
- Production: all ten workers have a code deployment from 2026-10-16 21:58 UTC (the zod build fix unblocked
  `beehive-promotion-worker`, `-canary-worker` and `-shadow-router`); the Spec DO is on m8 after the empty legacy
  `service_accounts` table was dropped (`docs/OPEN-QUESTIONS.md` 2026-10-16); `bailey-coding` is the only
  maintainer; `scripts/prod-health.sh` passes.
- M8 is on `main` but **not deployed** (2026-10-17): the Spec DO issue changes (atomic numbering, comment
  rules, close/reopen, actor validation), the repo issue pages UI, and the CLI default actor
  (`BEEHIVE_ACTOR` / `defaultActor` / `--actor`, an admin stopgap until M12). Plan and reviews: `docs/M8-*.md`.
- M9 (site navigation) is implemented on `agent/m9-nav` (2026-10-17), **not merged or deployed**; the independent
  code review (L9, `docs/M9-NAV-CODE-REVIEW.md`) approved with changes and its should-fixes are done. Plan and plan review:
  `docs/M9-NAV-PLAN.md`, `docs/M9-NAV-PLAN-REVIEW.md`.
- Known, unchanged from `main` (code review N1): a cross-origin non-write request to an issue route (e.g. POST to
  `.../issues/:id`) reads organizations and repositories before answering 405, because the origin check covers only the
  write routes and `resolveRepoRef` runs first. Harmless (nothing is written); fix by checking the origin on every POST.
- Local checks on `agent/m9-nav` (2026-10-17): 836 unit tests pass, typecheck clean; local e2e 70 passed / 5 skipped /
  0 failed (run with `E2E_UI=1`, see `docs/SETUP.md`). On `main`: 743 unit tests, e2e 63 passed / 5 skipped / 0 failed.

## Next session, first (needs the maintainer)

1. Rotate the Artifacts access token embedded in the `meta-notes` repo's git remote URL (it appeared in
   command output); switch that remote to a credential helper.
2. Fill the remaining `TODO(maintainer)` in `docs/OPS.md`: where `CLOUDFLARE_API_TOKEN`,
   `CLOUDFLARE_ACCOUNT_ID` and `WORKERS_SUBDOMAIN` live for deploys.
3. Heads-up (promotion-routes-fix, deployed 2026-10-16 22:08 UTC, all ten workers verified): tournament mode now
   records the winner on a real candidate and fails the tournament when that is rejected, so a request naming a
   candidate the Spec DO does not know ends `failed`. That is intended. Not yet exercised in production: run
   `BEEHIVE_API_TOKEN=... MAINTAINER_ACTOR_ID=... CONFIRM_PROD_WRITE=yes ./scripts/prod-verify-promotion.sh` once (it
   writes a `test-org-e2e-prodcheck-*` tree, restores the promotion mode and tombstones the org; purge by prefix later).

## Deploy M8 (needs the maintainer)

1. **Push M8 to `cf`** (`git pull origin main && git push cf main`). The issue pages UI and the Spec DO change ship in the one `beehive`
   worker, so there is no new-UI-on-old-DO window within the push. Then check: `scripts/prod-health.sh`, `wrangler deployments list`
   shows a code deployment newer than the push for all ten workers, and a new issue through `/app/repos/<org>/<repo>/issues/new` gets
   number 1 (production has no issues today).
2. **Set `BEEHIVE_ACTOR` (or `defaultActor`) for CLI admin use** to a real maintainer actor id, or `issue create` and the other
   ledger writes answer 403 (`docs/OPS.md` "CLI actor attribution").
3. Defect 11 (a Spec DO catch-all 404 reads as "not found") stays open on purpose, pinned by a test.
   Details: `docs/OPEN-QUESTIONS.md` 2026-10-17 (review of `39a2669`, with corrections).

## Deploy M9 (needs the maintainer, after the L9 review and merge)

One `beehive` worker change, UI only: `git pull origin main && git push cf main` (together with M8 if that is still undeployed).
Then check `scripts/prod-health.sh` and click through `/app` (navbar on each page type, org switcher, one flash after
creating an org, sign-out). Rollback is a normal revert push. The manual visual checklist (360/640/960px wrap, focus ring,
`details` open, skip link on focus, `#search` kept by the GET form) is in `docs/M9-NAV-PLAN.md` section 5.

## Cleanup

- Merged `agent/*` branches (16 on 2026-10-17; `git branch --merged main --list 'agent/*'`), the unmerged M8 plan/review
  branches (their docs are now on `main`) and the `scratch/m8-*` refs, with their `origin` copies, can be deleted once
  nothing needs them.
- `scripts/demo-multi-agent.sh` prints hard-coded ArtifactFS numbers (ArtifactFS is not built).
- The 5 skipped local e2e tests are m3 health checks for workers with no local port.

## Open work

- **The clean per-worker install CI step may not catch the zod failure.** `ci-enhanced.yml` runs a per-worker
  `npm install` and `wrangler deploy --dry-run`, but only after `npm install` at the repo root, so zod still resolves
  from the root `node_modules`, which is how the failure reached production. To make it a real check, build from a
  `git archive` copy with no root `node_modules` and install only in each worker folder. Unverified until tried.
- **Tournament creation race:** two requests creating a tournament for the same spec at the same moment make
  two rows (ids are random); readers take the newest. The CAS covers replacing a record, not creating one.
- **Migration tests only see this repo's own SQL.** A ledger carrying a table of another design passed every
  test and broke the live deploy; consider a test that seeds legacy shapes from the production schema dump.
- **Self-hosting gaps** (details in `docs/SETUP.md` section 2):
  - No workflow creates queues; the queues are created by hand (see `docs/SETUP.md`).
  - Account ID, `ALLOWED_GITHUB_USERS` and the `bz23711` subdomain are hardcoded across
    `wrangler.toml`, `cli/`, `shadow-router/config.ts`, `tests/e2e/config.ts`, `scripts/`.
  - First deploy to an empty account is unverified (`beehive` <-> `beehive-gate-workflow`
    binding cycle may need two passes).
- **README drift:** `tests/e2e/README.md` still says local e2e uses mocks (it makes real HTTP calls) and
  `docs/SETUP.md` is the accurate reference; update `tests/e2e/README.md`.
- **M3 gaps** (`docs/MILESTONES.md`): no DO facets, capability minting or ArtifactFS; canary
  `SLOMonitor.monitorAndTriggerRollback` is never called and `getMetric` returns 0
  (`canary-worker/slo.ts:67-78`); no producer for `canary-rollback-triggers` or
  `promotion-events`; no speculative projection forks; "Statsig" is a local traffic-split
  config, not an SDK integration. Production canary deploys answer 501 until a real Workers Versions
  client exists (OPEN-QUESTIONS 2026-10-16).
- **M1 ledger lifecycle** is deployed with m8; the production purge is untested against real data. Use
  tombstone then purge (`docs/OPS.md` "Ledger cleanup"), never delete the worker.
- **Spike: run all ten workers as one `wrangler dev` process** (`-c wrangler.toml -c workers/<name>/wrangler.toml ...`)
  instead of six processes on fixed ports (`scripts/start-e2e-workers.sh`). Probed 2026-10-17 with wrangler 4.151:
  all ten configs load in one process and the Spec DO is reached in-process (the edge `/health` got a 503 from the
  DO, which is correct without its token). Unresolved: (1) `--var` appears to reach only the primary worker, so the other
  nine would need `SPEC_DO_INTERNAL_TOKEN` another way (per-config `.dev.vars` or a shared env file); (2) only the
  primary is on `--port`, so tests that call 8788-8792 directly must reach those workers through bindings or another
  route; (3) the binding table printed `[not connected]` for cross-worker bindings at startup, untested after it settled.
  Acceptance: the 56 local e2e tests pass. The six-process script is the working fallback and CI runs it today.

## Next demo (post-submission)

End-to-end live flow instead of click-and-scroll: create org -> repo -> issue, watch agents
propose a spec, then implement it, gate, shadow, promote. Depends on the open M4
agent-autonomy items (agent-created issues/specs, change-type classification).

## Queued milestones

**Recommended order (per Opus agent):**
1. M5a (idempotency + bootstrap schema + change-type classification + two-person rule)
2. M7 (session provenance)
3. Capability minting (M3 core + M6.2 merged)
4. M5b (trust registry calibration)
5. M6.5 (semantic navigation - push back)

See `docs/MILESTONES.md` for detailed breakdown.
