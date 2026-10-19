---
category: planning
status: active
audience: human,agent
---


*This document is a living focus tracker. Update it at the start/end of each session.
Completed items are removed, not struck through; history lives in git.*

**Last updated:** 2026-10-19

## Where we are

- The agent stack is merged and on `origin/main`: spine items 1 and 3 (promotion ledger routes,
  ledger lifecycle), CI-only workflow, service tokens, canary deploy/rollback as Spec DO refs, review
  fixes, Spec DO internal auth, shadow-router ref cache, the ledger compare-and-swap with the tournament
  state machine (schema m8), and **M5a idempotency** (queue-consumer double-write prevention, idempotency
  keys moved to schema m10).
- Production: all ten workers have a code deployment from 2026-10-16 21:58 UTC (the zod build fix unblocked
  `beehive-promotion-worker`, `-canary-worker` and `-shadow-router`); the Spec DO is on m8 after the empty legacy
  `service_accounts` table was dropped (`docs/OPEN-QUESTIONS.md` 2026-10-16); `bailey-coding` is the only
  maintainer; `scripts/prod-health.sh` passes.
- M8 is on `main` but **not deployed** (2026-10-17): the Spec DO issue changes (atomic numbering, comment
  rules, close/reopen, actor validation), the repo issue pages UI, and the CLI default actor
  (`BEEHIVE_ACTOR` / `defaultActor` / `--actor`, an admin stopgap until M12). Plan and reviews: `docs/M8-*.md`.
- **M5a idempotency is merged and on `main`** (2026-10-19): queue-consumer idempotency fix implemented, idempotency
  keys moved from schema m9 to m10, legacy-shape migration tests added (production dump simulation for
  `service_accounts`, `actors`, `entity`, `promotion` tables), and the `agent/m5a-idempotency-fix` branch
  merged. See `docs/rfos/2026-10-14-migration-failures.md` for context.
- M9 (site navigation) is implemented on `agent/m9-nav` (2026-10-17), **not merged or deployed**; the independent
  code review (L9, `docs/M9-NAV-CODE-REVIEW.md`) approved with changes and its should-fixes are done. Plan and plan review:
  `docs/M9-NAV-PLAN.md`, `docs/M9-NAV-PLAN-REVIEW.md`. **Note:** schema m9 is now used by M5a idempotency
  (the idempotency keys table), so M12 references have been updated from m9 to m10.
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
   candidate the Spec DO does not know ends `failed`. That is intended. Verified in production 2026-10-18 with `scripts/prod-verify-promotion.sh`: a two-candidate tournament completed, the winner's stage is `passed_train`, the promotion mode was restored. It left a tombstoned `test-org-e2e-prodcheck-*` org (purge by prefix after `PURGE_MIN_AGE_HOURS`, `docs/OPS.md`).

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

## M12 verified identity (plan: `docs/M12-IMPL-PLAN.md`)

- PR-0 and push A are live (rollback floor `8de5485`, `docs/OPS.md`). PR-B (T2-T6d: user tokens, schema `m9`, the
  settings page, the master stage-1 log) is on `agent/m12-pr-b`, **not merged or deployed**; it needs the maintainer's
  and an independent review. Deploy steps: `docs/OPS.md` "User tokens" (push B deploy checks) and the plan, section 3.
- Next: PR-C (T7, CLI token support and the "CLI actor attribution" rewrite), then PR-D1/PR-D2 (T8/T9,
  `SESSION_SIGNING_KEY`).
- **Verify assumption A4** (task): open one `beehive` invocation log for an authenticated `/api/*` request and one
  `/app` visit, and the same request's Honeycomb trace including the edge-to-DO subrequest span. Check that
  `Authorization`, `Cookie`, `X-API-Token`, `X-Beehive-Internal` and `X-Beehive-Admin` are redacted; never copy a value
  seen. If any is not: `invocation_logs = false` and trace header capture off on `beehive`, then rotate the exposed
  secrets, and record the result in `docs/OPEN-QUESTIONS.md` (2026-10-18 entry).
- **M12 PR-B T2 is merged** (2026-10-19): `bh_usr_` user token helpers added to `service-tokens.ts` (commit
  `50728bc`, PR `e786f60`); independent review approved by `cc90f6a`. The full PR-B remains on `agent/m12-pr-b`.
- **Rate limiting on failed user-token verifications is deferred** (RFC-0008 decision 8): every well-formed fake
  `bh_usr_` token costs one DO request. A per-IP limit via the Workers rate-limiting binding is the proposal.
- **`authGate` on the nine other workers compares the master token with `===`** (`workers/shared/auth.ts`), not in
  constant time. Follow-up, out of M12 scope.
- **Verify 404 differs by token type, on purpose:** a service-token verify 404 is "unknown token" (401); the user-token
  verify route always answers 200 for a well-formed hash, so its 404 means an older DO (503).
- **M11 handoff:** M11 rebases onto PR-B and takes `m10`. A UNIQUE index on `actors.github_user_id` goes in `m10` only
  after the duplicate check is re-run and comes back clean: on a ledger with duplicates it throws, `init()` rethrows,
  and that is a full outage.
- **Prerequisite of master stage 2:** open the lifecycle routes (tombstone, purge, roles, `include_deleted`) to
  `maintainer` user tokens first; in M12 they stay master-only (plan A1). Stage 2 itself waits for the stage-1 evidence
  (`docs/OPS.md`, the AE query).
- Small drift seen in T4: the Spec DO's `POST /api/issues` answers snake_case fields (`created_by`), while
  `workers/api/types.ts` `IssueResponse` says `createdBy`. Clients should read both until one is fixed.
- **e2e first-maintainer race** (review N4, `docs/M12-PRB-REVIEW.md`): on a fresh local ledger four e2e files race for the
  one-time maintainer self-grant, so `tests/e2e/user-tokens.test.ts` can fail its `beforeAll` with 403; on a non-200 grant,
  re-list and use the winner, or bootstrap once in a global setup. Fixed in `f1595c` (review nits N1 N5 and
  N4 follow-up).

## Cleanup

- Merged `agent/*` branches: **15 merged agent/* remote branches deleted** (2026-10-19, `2dc02e`, `a78017c`),
  plus `scratch/m8-*` remote refs deleted (2026-10-19, `507ebca`). The unmerged M8 plan/review branches (their
  docs are now on `main`) can be deleted once nothing needs them.
- `scripts/demo-multi-agent.sh` prints hard-coded ArtifactFS numbers (ArtifactFS is not built).
- The 5 skipped local e2e tests are m3 health checks for workers with no local port.

## Open work

- **The clean per-worker install CI step may not catch the zod failure — FIXED.** `ci-enhanced.yml` now builds
  from a `git archive` copy with no root `node_modules` and installs only in each worker folder (`d3b42ff`, 2026-10-19).
  This prevents the root-level dependency resolution that allowed the zod failure to reach production.
- **Tournament creation race:** two requests creating a tournament for the same spec at the same moment make
  two rows (ids are random); readers take the newest. The CAS covers replacing a record, not creating one.
  Documented in OPEN-QUESTIONS.md with investigation findings (`3365259`, 2026-10-19).
- **Migration tests only see this repo's own SQL.** A ledger carrying a table of another design passed every
  test and broke the live deploy; consider a test that seeds legacy shapes from the production schema dump.
- **Self-hosting gaps** (details in `docs/SETUP.md` section 2):
  - No workflow creates queues; the queues are created by hand (see `docs/SETUP.md`).
  - Account ID, `ALLOWED_GITHUB_USERS` and the `bz23711` subdomain are hardcoded across
    `wrangler.toml`, `cli/`, `shadow-router/config.ts`, `tests/e2e/config.ts`, `scripts/`.
  - First deploy to an empty account is unverified (`beehive` <-> `beehive-gate-workflow`
    binding cycle may need two passes).
- **README drift — FIXED:** `tests/e2e/README.md` updated to match `docs/SETUP.md` (local e2e makes real HTTP
  calls, no mocks) (`54808ae`, `30eb73`, `bc155e0`, 2026-10-19).
- **M3 gaps** (`docs/MILESTONES.md`): no DO facets, capability minting or ArtifactFS; canary
  `SLOMonitor.monitorAndTriggerRollback` is never called and `getMetric` returns 0
  (`canary-worker/slo.ts:67-78`); no producer for `canary-rollback-triggers` or
  `promotion-events`; no speculative projection forks; "Statsig" is a local traffic-split
  config, not an SDK integration. Production canary deploys answer 501 until a real Workers Versions
  client exists (OPEN-QUESTIONS 2026-10-16).
- **M1 ledger lifecycle** is deployed with m8; the production purge is untested against real data. Use
  tombstone then purge (`docs/OPS.md` "Ledger cleanup"), never delete the worker.
- **Cloudflare Flagship:** OPEN-QUESTIONS.md section restored (`c1039e5`, 2026-10-19) with adoption
  open question (`b748902`, 2026-10-19).
- **Spike: run all ten workers as one `wrangler dev` process** (`-c wrangler.toml -c workers/<name>/wrangler.toml ...`)
  instead of six processes on fixed ports (`scripts/start-e2e-workers.sh`). Probed 2026-10-17 with wrangler 4.151:
  all ten configs load in one process and the Spec DO is reached in-process (the edge `/health` got a 503 from the
  DO, which is correct without its token). Unresolved: (1) `--var` appears to reach only the primary worker, so the other
  nine would need `SPEC_DO_INTERNAL_TOKEN` another way (per-config `.dev.vars` or a shared env file); (2) only the
  primary is on `--port`, so tests that call 8788-8792 directly must reach those workers through bindings or another
  route; (3) the binding table printed `[not connected]` for cross-worker bindings at startup, untested after it settled.
  Acceptance: the 56 local e2e tests pass. The six-process script is the working fallback and CI runs it today.
- **New documentation:** Agent token optimization guide added (`e915e15`, 2026-10-19) per
  `AGENTS.md#working-conventions`.

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
