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
- The maintainer pushed to the Artifacts repo; the live Spec DO reached m8 after the empty legacy
  `service_accounts` table was dropped (`docs/OPEN-QUESTIONS.md` 2026-10-16).
- Local checks on `main`: 552 unit tests pass, typecheck clean, local e2e 56 passed / 5 skipped / 0 failed.

## Next session, first (needs the maintainer)

1. **Three workers did not redeploy on the 2026-10-16 push** (`wrangler deployments list`): `beehive-promotion-worker`,
   `beehive-canary-worker` and `beehive-shadow-router` still run 2026-10-15 code; their newest deployment is a
   20:29 UTC secret change. The other seven deployed at 21:32 and 21:37. `wrangler deploy --dry-run` builds all
   three, so look at their Workers Builds in the dashboard (is the Artifacts repo connected, branch, build log).
   Meanwhile the old promotion worker sends no `X-Beehive-Internal` header, so its Spec DO calls answer 401.
   `prod-health.sh` cannot see this (it only checks reachability). Details: `docs/OPEN-QUESTIONS.md` 2026-10-16.
2. Rotate the Artifacts access token embedded in the `meta-notes` repo's git remote URL (it appeared in
   command output); switch that remote to a credential helper.
3. Fill the two remaining `TODO(maintainer)` items in `docs/OPS.md`: where `CLOUDFLARE_API_TOKEN`,
   `CLOUDFLARE_ACCOUNT_ID` and `WORKERS_SUBDOMAIN` live for deploys, and how to roll back when all ten
   workers deploy at once.

## Decide first

1. **Promotion worker calls Spec DO routes that do not exist** (`GET`/`PATCH /candidates/:id`,
   `POST /candidates/:id/rollback`; the DO serves `/api/candidates/...`). Tournament metrics always fall
   back to defaults, and winners and rollbacks are never recorded on the candidate. Spine decision: which
   route and fields carry a rung change (`/api/candidates/:id/stage` exists), what a rollback writes, and
   whether the DO owns `current_rung` (`docs/OPEN-QUESTIONS.md` 2026-10-16).
2. **Edge `/health` on `beehive` answers `durableObject: ok` without calling the DO.** Make it call the DO
   and return 503 on failure, so monitors see a stuck ledger (`docs/OPEN-QUESTIONS.md` 2026-10-16).
3. **Commit `39a2669` (repo-level issue pages) shipped unreviewed** with the stack. Review it.

## Cleanup

- `agent/ocap-answers` (two docs commits recording the OCAP-CI decisions) is on `origin` but not in `main`:
  cherry-pick, then archive its workspace.
- Ten merged local `agent/*` branches (and their `origin` copies) can be deleted once nothing needs them.
- `scripts/demo-multi-agent.sh` prints hard-coded ArtifactFS numbers (ArtifactFS is not built).
- The 5 skipped local e2e tests are m3 health checks for workers with no local port.

## Open work

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
