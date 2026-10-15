---
category: planning
status: active
audience: human,agent
---


*This document is a living focus tracker. Update it at the start/end of each session.
Completed items are removed, not struck through; history lives in git.*

**Last updated:** 2026-10-15

## Decide first

1. **22 failing e2e tests** (`tests/e2e/cross-worker-flows.test.ts`) call routes the workers
   don't implement. Most map to real routes (table in `docs/SETUP.md`); the merge-train and
   tournament `start` tests have no equivalent and need new routes or deletion.
2. **Docs bodies are uncommitted.** `docs/*.md` (ARCHITECTURE, TROUBLESHOOTING,
   ARTIFACTS-SETUP, ...) are header-only stubs in HEAD since the public release (`bbccf9e`);
   full bodies exist only in the working tree. Commit them or decide they stay private.
3. **Public `/roadmap` page overstates status** (`workers/api/index.ts:646-661`): marks M3
   complete incl. facets/capabilities/ArtifactFS and "M7 Observability Layer" complete.
   `scripts/demo-multi-agent.sh` also prints hard-coded ArtifactFS numbers.

## Open work

- **Typecheck:** 2 errors in `workers/api/ui-semantic.ts:1130,1135` (`root.children`
  possibly undefined). CI doesn't run typecheck, so deploys are unaffected.
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

## Next demo (post-submission)

End-to-end live flow instead of click-and-scroll: create org -> repo -> issue, watch agents
propose a spec, then implement it, gate, shadow, promote. Depends on the open M4
agent-autonomy items (agent-created issues/specs, change-type classification).

## Queued milestones

M5 trust and governance, M6 semantic UI (mocked, in API worker), M6.2 OCAP CI, M6.5 semantic
navigation, M7 session provenance and intent index. See `docs/MILESTONES.md`.
