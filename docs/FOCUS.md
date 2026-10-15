---
category: planning
status: active
audience: human,agent
---


*This document is a living focus tracker. Update it at the start/end of each session.
Completed items are removed, not struck through; history lives in git.*

**Last updated:** 2026-10-15

## Completed this session (Opus agent review)

- ✅ Committed 46 docs (+22k lines) that were in working tree only
- ✅ Pushed to origin/main (deploys all 10 workers)
- ✅ Fixed canary worker: returns 404 for unknown routes (was 200 with HTML text)
- ✅ Widened vitest include: worker tests now run (12 files, 20+ hidden failures exposed)
- ✅ Added CI gates: typecheck + unit tests run before deploy in `deploy.yml`
- ✅ Updated cross-worker-flows tests: renamed routes to match workers, removed tests for non-existent routes
- ✅ Updated MILESTONES.md: split M5 into M5a/M5b, deferred M6.5, merged M6.2 with M3 capability work
- ✅ Removed fake handlers: deleted oracle-ladder.test.ts, cleaned m3-features.test.ts to use only real worker tests
- ✅ Fixed promotion mode bug: mode now persists in Spec DO storage (not worker memory), survives worker restarts
- ✅ Fixed typecheck errors: ui-semantic.ts root.children errors resolved
- ✅ Added spec-do.ts to promotion-worker for Spec DO access via fetch router

## Current state

**E2E tests:**
- `m3-features.test.ts`: 31 tests, all skipped (requires BEEHIVE_AUTH_TOKEN for production)
- `cross-worker-flows.test.ts`: 22 tests, 9 failures, 2 skipped, 11 passing (local dev; 2026-10-15). Remaining failures are spine/worker defects, see OPEN-QUESTIONS 2026-10-15
- Main issues: route mismatches between tests and workers, auth token issues, service binding connectivity

**Infrastructure:**
- All 10 workers deployed to Cloudflare
- CI now runs typecheck and unit tests before deploy
- Promotion mode persists across worker restarts via Spec DO

## Decide first

1. **Public `/roadmap` page overstates status** (`workers/api/index.ts:646-661`): marks M3
   complete incl. facets/capabilities/ArtifactFS and "M7 Observability Layer" complete.
   `scripts/demo-multi-agent.sh` also prints hard-coded ArtifactFS numbers.
2. **Update test routes:** Some cross-worker-flows tests still use incorrect routes or expect wrong status codes
3. **Service binding connectivity:** Local dev tests need all workers running with proper service bindings

## Open work

- **Typecheck:** All errors resolved. CI now runs typecheck (added to `deploy.yml`).
- **Self-hosting gaps** (details in `docs/SETUP.md` section 2):
  - Workflow creates only 2 of 7 queues; add the other 5 to `deploy.yml` or document as-is.
  - Account ID, `ALLOWED_GITHUB_USERS` and the `bz23711` subdomain are hardcoded across
    `wrangler.toml`, `cli/`, `shadow-router/config.ts`, `tests/e2e/config.ts`, `scripts/`.
  - First deploy to an empty account is unverified (`beehive` <-> `beehive-gate-workflow`
    binding cycle may need two passes).
- **README drift:** says local e2e uses mocks (it makes real HTTP calls) and points to
  `docs/SETUP.md` as complete; update `README.md` and `tests/e2e/README.md`.
- **M3 gaps** (`docs/MILESTONES.md`): no DO facets, capability minting or ArtifactFS; canary
  `SLOMonitor.monitorAndTriggerRollback` is never called and `getMetric` returns 0
  (`canary-worker/slo.ts:67-78`); no producer for `canary-rollback-triggers` or
  `promotion-events`; no speculative projection forks; "Statsig" is a local traffic-split
  config, not an SDK integration.
- **M1 ledger lifecycle** (tombstones, admin purge route) is not built; this is why a wipe
  means deleting the worker.
- **OPEN-QUESTIONS.md** has no ledger-lifecycle finding, though MILESTONES cites one.
- **Cross-worker e2e tests:** 9 failures remain: SpecDO RPC + relative-URL bug in promotion worker (spine) and missing preview-manager `/api/deploy`,`/api/rollback` routes. Human needed; see OPEN-QUESTIONS 2026-10-15.
- **`test:e2e:local` runs m3-features against production** when `BEEHIVE_API_TOKEN` is set; gate it.

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
