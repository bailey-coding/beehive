---
category: planning
status: active
audience: human,agent
---


*This document is a living focus tracker. Update it at the start/end of each session.
Completed items are removed, not struck through; history lives in git.*

**Last updated:** 2026-10-16

## Where we are

- The agent stack is merged and on `origin/main`: spine items 1 and 3 (promotion ledger routes,
  ledger lifecycle), CI-only workflow, service tokens, canary deploy/rollback as Spec DO refs, review
  fixes, Spec DO internal auth, shadow-router ref cache, and the ledger compare-and-swap with the
  tournament state machine (schema m8).
- Production: all ten workers have a code deployment from 2026-10-16 21:58 UTC (the zod build fix unblocked
  `beehive-promotion-worker`, `-canary-worker` and `-shadow-router`); the Spec DO is on m8 after the empty legacy
  `service_accounts` table was dropped (`docs/OPEN-QUESTIONS.md` 2026-10-16); `bailey-coding` is the only
  maintainer; `scripts/prod-health.sh` passes.
- Local checks on `main` (with promotion-routes-fix merged): 559 unit tests pass, typecheck clean; local e2e
  56 passed / 5 skipped / 0 failed (run on the routes branch).

## Next session, first (needs the maintainer)

1. Rotate the Artifacts access token embedded in the `meta-notes` repo's git remote URL (it appeared in
   command output); switch that remote to a credential helper.
2. Fill the two remaining `TODO(maintainer)` items in `docs/OPS.md`: where `CLOUDFLARE_API_TOKEN`,
   `CLOUDFLARE_ACCOUNT_ID` and `WORKERS_SUBDOMAIN` live for deploys, and how to roll back when all ten
   workers deploy at once.
3. Heads-up (promotion-routes-fix, deployed 2026-10-16 22:08 UTC, all ten workers verified): tournament mode now
   records the winner on a real candidate and fails the tournament when that is rejected, so a request naming a
   candidate the Spec DO does not know ends `failed`. That is intended. Not yet exercised in production: run
   `BEEHIVE_API_TOKEN=... MAINTAINER_ACTOR_ID=... CONFIRM_PROD_WRITE=yes ./scripts/prod-verify-promotion.sh` once (it
   writes a `test-org-e2e-prodcheck-*` tree, restores the promotion mode and tombstones the org; purge by prefix later).

## Decide first

1. **Repo-level issue pages (`39a2669`) are unreachable dead code with six defects** (routes nested inside a regex
   that cannot match them, comments post to a missing route, racy and probably wrong issue numbers, an unencoded
   redirect, issue not scoped to repo, four copies of the repo lookup). The persistence half of that commit is fine.
   Fix them in the M8 UI work (`agent/parity-ui` is editing `ui.ts`) or delete the pages until then.
   Details: `docs/OPEN-QUESTIONS.md` 2026-10-17.

## Cleanup

- Ten merged local `agent/*` branches (and their `origin` copies) can be deleted once nothing needs them.
- `scripts/demo-multi-agent.sh` prints hard-coded ArtifactFS numbers (ArtifactFS is not built).
- The 5 skipped local e2e tests are m3 health checks for workers with no local port.

## Open work

- **No CI step builds a worker from a clean per-worker install,** which is how the zod failure reached production
  (every local check resolves zod from the repo root). Add one: copy the repo without `node_modules`, `npm install` in
  each worker folder, `wrangler deploy --dry-run`.
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
