---
category: planning
status: active
audience: human,agent
---


*This document is a living focus tracker. Update it at the start/end of each session.
Completed items are removed, not struck through; history lives in git.*

**Last updated:** 2026-10-23

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
- M8 is on `main` and **deployed** (maintainer deploy of `main` at `831d9db`, 2026-10-24, not yet verified by an agent): the Spec DO issue changes (atomic numbering, comment
  rules, close/reopen, actor validation), the repo issue pages UI, and the CLI default actor
  (`BEEHIVE_ACTOR` / `defaultActor` / `--actor`, an admin stopgap until M12). Plan and reviews: `docs/M8-*.md`.
- **M5a idempotency is merged and on `main`** (2026-10-19): queue-consumer idempotency fix implemented, idempotency
  keys moved from schema m9 to m10, legacy-shape migration tests added (production dump simulation for
  `service_accounts`, `actors`, `entity`, `promotion` tables), and the `agent/m5a-idempotency-fix` branch
  merged. See `docs/rfos/2026-10-14-migration-failures.md` for context.
- M9 (site navigation) is **merged to `main`** (`agent/m9-nav` is 0 commits ahead, checked 2026-10-23); **deployed** with the 2026-10-24
  maintainer deploy of `main` at `831d9db` (not yet verified by an agent). The independent code review (L9, `docs/M9-NAV-CODE-REVIEW.md`) approved with changes and its should-fixes are done. Plan and plan review:
  `docs/M9-NAV-PLAN.md`, `docs/M9-NAV-PLAN-REVIEW.md`. **Note:** schema m9 is now used by M5a idempotency
  (the idempotency keys table), so M12 references have been updated from m9 to m10.
- Known, unchanged from `main` (code review N1): a cross-origin non-write request to an issue route (e.g. POST to
  `.../issues/:id`) reads organizations and repositories before answering 405, because the origin check covers only the
  write routes and `resolveRepoRef` runs first. Harmless (nothing is written); fix by checking the origin on every POST.
- Local checks on `main` (2026-10-23): typecheck clean, unit tests pass (excluding e2e); `tests/cli-behavior.test.ts` needs
  `npm ci` in `cli/` first. Last e2e run: 70 passed / 5 skipped / 0 failed on `agent/m9-nav` (2026-10-17, `E2E_UI=1`, `docs/SETUP.md`).
- **Custom request types are merged** (PR #1, 2026-10-23, **deployed** 2026-10-24): branded request types in `workers/shared/principal.ts`
  (`AuthedRequest`, `ActorRequest`, `ReadRequest`, `WriteRequest`, `MaintainerRequest`), all 43 API handlers migrated,
  type-level tests in `principal.test-d.ts` (negative checks use `@ts-expect-error`). The brands are compile-time only and the scope
  wrappers re-check `principal.scopes`; `authorize()` stays the real enforcement. A master token without `X-Actor-ID` carries
  `'unknown'` and must still reach `/health` and bootstrap routes (fixed in `c2d4906`).
- **Runtime validation in `authenticate()`** (2026-10-23, **deployed** 2026-10-24): a master token's asserted `X-Actor-ID` must match
  `ActorIdSchema` (1-128 printable ASCII, no spaces) or the request is a 400, logged as `master_actor_rejected` (no AE point,
  `docs/OPS.md`). The service and user verify-route bodies are parsed with zod (mismatch = 503, `found:false` = 401). The CLI rejects
  such an actor before sending. Cleanups landed the same day: `authGate` is now constant-time (async; a test requires every call to be
  awaited), `authorize()` and the typed scope wrappers share `hasScope`/`requireScope`, issue responses carry camelCase beside the
  legacy snake_case (drop snake_case once no reader needs it), the e2e `ensureMaintainer` helper removes the first-maintainer race, and
  failed `bh_usr_` verifications are limited to 20 per 60s per IP, **best effort per isolate** (a global Workers rate-limiting
  binding is the follow-up). Local checks: typecheck clean, 438 `workers/api` tests, 30 CLI behavior tests.

## Next session, first (needs the maintainer)

1. Rotate the Artifacts access token embedded in the `meta-notes` repo's git remote URL (it appeared in
   command output); switch that remote to a credential helper.
2. Fill the remaining `TODO(maintainer)` in `docs/OPS.md`: where `CLOUDFLARE_API_TOKEN`,
   `CLOUDFLARE_ACCOUNT_ID` and `WORKERS_SUBDOMAIN` live for deploys.
3. Heads-up (promotion-routes-fix, deployed 2026-10-16 22:08 UTC, all ten workers verified): tournament mode now
   records the winner on a real candidate and fails the tournament when that is rejected, so a request naming a
   candidate the Spec DO does not know ends `failed`. That is intended. Verified in production 2026-10-18 with `scripts/prod-verify-promotion.sh`: a two-candidate tournament completed, the winner's stage is `passed_train`, the promotion mode was restored. It left a tombstoned `test-org-e2e-prodcheck-*` org (purge by prefix after `PURGE_MIN_AGE_HOURS`, `docs/OPS.md`).

## Post-deploy checks (maintainer deployed `main` at `831d9db` on 2026-10-24; none confirmed yet)

One push deployed all ten workers at once, covering M8, M9, M12 PR-B, custom request types, the auth hardening and the
cleanups. Confirm, in this order:

1. `scripts/prod-health.sh` passes, and `wrangler deployments list` shows a code deployment newer than the push for all ten
   workers. The Spec DO migrates to schema `m10` on its first request (`init()`); a failed migration rethrows and is a full outage.
2. A new issue through `/app/repos/<org>/<repo>/issues/new` gets number 1 (production had no issues). Click through `/app`:
   navbar on each page type, org switcher, one flash after creating an org, sign-out (manual checklist: `docs/M9-NAV-PLAN.md`
   section 5). Rollback is a normal revert push.
3. Set `BEEHIVE_ACTOR` (or `defaultActor`) for CLI admin use to a real maintainer actor id, or `issue create` and the other
   ledger writes answer 403 (`docs/OPS.md` "CLI actor attribution"). The CLI now rejects an actor with spaces or over 128
   characters before sending, and the edge answers such a master `X-Actor-ID` with 400.
4. Master requests without `X-Actor-ID` (`/health`, bootstrap) still work, and `master_actor_rejected` lines appear in Workers
   Logs only for malformed ids.
5. Defect 11 (a Spec DO catch-all 404 reads as "not found") stays open on purpose, pinned by a test.
   Details: `docs/OPEN-QUESTIONS.md` 2026-10-17 (review of `39a2669`, with corrections).

## M12 verified identity (plan: `docs/M12-IMPL-PLAN.md`)

- PR-0 and push A are live (rollback floor `8de5485`, `docs/OPS.md`). PR-B (T2-T6d: user tokens, the
  settings page, the master stage-1 log) is **merged to `main`** (`99fc4e2`; `agent/m12-pr-b` is 0 commits ahead, checked 2026-10-23) and deployed
  2026-10-24 (above). Its user-token table landed as schema `m9` (the idempotency keys moved to `m10`, see above). Deploy steps: `docs/OPS.md` "User tokens" (push B deploy checks) and the plan, section 3.
- Next: PR-C (T7, CLI token support and the "CLI actor attribution" rewrite), then PR-D1/PR-D2 (T8/T9,
  `SESSION_SIGNING_KEY`).
- **Verify assumption A4** (task): open one `beehive` invocation log for an authenticated `/api/*` request and one
  `/app` visit, and the same request's Honeycomb trace including the edge-to-DO subrequest span. Check that
  `Authorization`, `Cookie`, `X-API-Token`, `X-Beehive-Internal` and `X-Beehive-Admin` are redacted; never copy a value
  seen. If any is not: `invocation_logs = false` and trace header capture off on `beehive`, then rotate the exposed
  secrets, and record the result in `docs/OPEN-QUESTIONS.md` (2026-10-18 entry).
- **M12 PR-B T2 is merged** (2026-10-19): `bh_usr_` user token helpers added to `service-tokens.ts` (commit
  `50728bc`, PR `e786f60`); independent review approved by `cc90f6a`. The full PR-B has since merged (above).
- **Verify 404 differs by token type, on purpose:** a service-token verify 404 is "unknown token" (401); the user-token
  verify route always answers 200 for a well-formed hash, so its 404 means an older DO (503).
- **M11 handoff:** the M3 canary metrics table took `m11` (2026-10-24), so M11 takes `m12` or later. A UNIQUE index on `actors.github_user_id` goes in its own migration only
  after the duplicate check is re-run and comes back clean: on a ledger with duplicates it throws, `init()` rethrows,
  and that is a full outage.
  Update (2026-10-24): m10 is `idempotency_keys` (M5a) and m11 is `canary_metrics` (M3), so the index migration is m12 or later; older docs that say m10 or m11 are historical.
- **Prerequisite of master stage 2:** open the lifecycle routes (tombstone, purge, roles, `include_deleted`) to
  `maintainer` user tokens first; in M12 they stay master-only (plan A1). Stage 2 itself waits for the stage-1 evidence
  (`docs/OPS.md`, the AE query).


## Cleanup

- Merged `agent/*` branches: **15 merged agent/* remote branches deleted earlier** (2026-10-19, `2dc02e`, `a78017c`),
  plus `scratch/m8-*` remote refs deleted (2026-10-19, `507ebca`). As of 2026-10-23 another 15 `agent/*`/`merge/*` branches are 0 commits ahead of `main` (e.g. `m8-issues-do`, `m8-issues-ui`,
  `m9-nav`, `m12-pr-a`, `m12-pr-b`, `merge/m12-prb`) and can be deleted; the review/plan branches that are still ahead
  (their docs are on `main`) go once nothing needs them.
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
- **M3 canary SLO loop deployed** (2026-10-24, schema `m11`; plan `docs/M3-CANARY-SLO-PLAN.md`, runbook
  `docs/OPS.md` "Canary SLO loop"): the shadow router posts per-deployment, per-minute samples to the Spec DO; the canary worker evaluates each live
  canary on a Spec DO alarm tick and rolls back violators (the minute cron was removed 2026-10-24). **The input is shadow data** (`source = 'shadow'`), not canary
  traffic. Deployed with `fe495d3`: `prod-health.sh` passed (all ten workers and the Spec DO, so the `m10 -> m11` migration ran), canary and shadow-router deployments 07:21-07:22Z. Cron confirmed firing (`canary_slo_cycle`, `source: shadow`, `checked: 0`, outcome ok, tailed 2026-10-24).
- **Event-driven tick deployed** (2026-10-24, `7e17125`): the Spec DO arms a 60 s alarm on a canary deploy and sends one tick per
  firing to queue `canary-slo-ticks` while a canary is live; the canary worker consumes it and runs one SLO cycle per batch. The cron was removed
  2026-10-24, so the tick is the only trigger. Queue created by hand before the push (1 producer, 1 consumer). **Consequence:**
  canary deploys answer 501 in prod, so no alarm arms and the SLO loop does not run there until the Versions client is wired in.
- **Sandbox build deployed** (2026-10-25, `7733d4b`, `docs/SANDBOX-BUILD-PLAN.md` Phase 1): `beehive-sandbox-runner` builds a candidate
  commit in a no-Internet container (`POST /sandbox/build {repo, commitSha}`, git clone through a credential-injecting intercept, esbuild
  with no install scripts, 60 s / 1 MiB limits) and returns the bundle the Versions client needs. Verified live with a throwaway repo.
  `CLOUDFLARE_API_TOKEN` is set as a secret on the worker. A review's 10 should-fix items were fixed and verified live the same day (`bb1ec51`, `OPEN-QUESTIONS`). Remaining (Phase 2, then 3): `preview-manager` calls `/sandbox/build` through a
  service binding as its `CandidateBundleSource`; handle `versionsClient: 'api'`; purge cleanup of `beehive-candidate-*`; then you set
  `WORKER_VERSIONS_MODE=api`. **Phase 2 is deployed (2026-10-25, `21bea5a`), reviewed, behind the 501 default** (`OPEN-QUESTIONS` "Sandbox Phase 2"): `SANDBOX_RUNNER` binding live, health green, both new routes answer 501. **Phase 3 DONE 2026-10-25: `WORKER_VERSIONS_MODE=api` is live and a first real canary worked end to end (`OPEN-QUESTIONS` "First real canary"); production canary deploys no longer answer 501.** Original Phase 3 notes: set `WORKER_VERSIONS_MODE=api` on `beehive-preview-manager` (the account id and workers.dev subdomain are plain vars in its `wrangler.toml` now; its `CLOUDFLARE_API_TOKEN` secret must have Workers Scripts:Edit, which the first call will confirm or refuse with a 403), then run a first canary for a ledger candidate whose repo has a buildable commit. The cleanup route `DELETE /api/preview/canary/:id` exists but nothing calls it: wiring it to the ledger purge is yours to decide. The canary cron is gone (cleared 2026-10-25 after a scheduler lag, `OPEN-QUESTIONS`).
- **Shadow router fix deployed and verified (2026-10-25, `4bfba1e`):** workers.dev error 1042 had turned every mirrored request into a 404, so a failing canary
  looked healthy. With `global_fetch_strictly_public` and a credential-free header allowlist for candidates, the same failing candidate read `violation`
  (error rate 1.0, 101 requests) and the queue-driven loop rolled it back by itself in about two minutes (`OPEN-QUESTIONS` "Shadow router fix verified").
  The M3 canary SLO loop is now exercised end to end on shadow data. Still open: SLO data is `source = shadow` (not live canary traffic), the recorder
  flushes only on the next sample, and only 5xx counts as an error.
- **Workers Versions API verified; client built, not wired** (2026-10-24, `140e629`, `docs/OPEN-QUESTIONS.md`):
  `ApiWorkerVersionsClient` behind `WORKER_VERSIONS_MODE=api`, only mocked-fetch tested. To wire (human): pass a
  `CandidateBundleSource` to `workerVersionsClientFor` (`workers/preview-manager/index.ts`), set `WORKER_VERSIONS_MODE=api`,
  `CLOUDFLARE_API_TOKEN`, `WORKERS_SUBDOMAIN`; handle `versionsClient: 'api'` in the response; clean up `beehive-candidate-*`
  Workers on purge. Candidates must be stateless (no version URLs for DO/Container/Sandbox Workers). Unverified: 429 behavior,
  bindings, switch propagation bound, the source of the built bundle.
- **M3 gaps** (`docs/MILESTONES.md`): no DO facets, capability minting or ArtifactFS; the canary SLO loop runs from the alarm tick
  (shadow data only, see above); no producer for `canary-rollback-triggers` (the consumer stays) or
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
1. **M5a (idempotency partially complete on `agent/m5a-idempotency-fix`)** — Idempotency keys schema m10
   and queue-consumer fix are done (closes at-least-once double-write for all nine POST routes); remaining:
   bootstrap schema fields, change-type classification, two-person merge rule.
2. M7 (session provenance)
3. Capability minting (M3 core + M6.2 merged)
4. M5b (trust registry calibration)
5. M6.5 (semantic navigation - push back)

See `docs/MILESTONES.md` for detailed breakdown.
