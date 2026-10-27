---
category: planning
status: active
audience: human,agent
---


*This document is a living focus tracker. Update it at the start/end of each session.
Completed items are removed, not struck through; history lives in git.*

**Last updated:** 2026-10-27

## Where we are

- **Newest (2026-10-27):** production runs `main` at `88e40e1` (deployed 16:53-16:54Z by the maintainer's go-ahead; nine workers redeployed, `beehive-sandbox-runner` unchanged;
  `scripts/prod-health.sh` green; CI green). It carries **m12**: a partial UNIQUE index on `actors.github_user_id` (NULL and `''` excluded) whose migration step refuses
  with `DuplicateGithubIdentityError` on duplicates before any DDL. Verified before the push: production duplicate check clean (`scripts/check-actor-duplicates.sh`,
  4 actors) and the migration run on workerd's SQLite (a local 26-actor ledger went m11 to m12); the first Spec DO call after the deploy returned 200. Not exercised in
  production: the 409 for a duplicate actor insert. The last two `test-org-e2e-sbx-*` orgs were purged 2026-10-27 (all five test orgs are gone); the `beehive-system` agent
  actor (id in `docs/OPS.md`) runs ledger operations. Next: MR flow slice 1 (real test gate, `docs/REAL-GATE-IMPL-PLAN.md`; the container spikes need the maintainer to deploy
  `spikes/gate-spike/`), the backtest pilot re-run for A2, A4, A5, A11 (`tools/backtest`, harness fixes merged; about 250-300 calls), and the About/Roadmap page corrections.
- Earlier (2026-10-26, later): production runs `main` at `1d79ec8` (nine workers redeployed 09:32Z, `beehive-sandbox-runner` unchanged; `scripts/prod-health.sh` green;
  CI green). New since `f21024d`: N1 origin check on every non-GET/HEAD issue request; the purge fails closed (a 501, 404, 5xx, a missing `PREVIEW_MANAGER` binding, an
  older Spec DO or an odd 2xx body aborts a purge that has candidates, nothing deleted; `docs/OPS.md` "Ledger cleanup"); M12 PR-C (CLI user tokens, `docs/M12-PRC-PLAN.md`);
  the legacy-ledger migration matrix (`workers/spec-do/tests/migration-matrix.test.ts`, plan `docs/MIGRATION-LEGACY-TEST-PLAN.md`). The first real purge ran
  2026-10-26 ~09:34Z as the `beehive-system` actor: 3 orgs, 4 candidates, 13 rows; the 4 candidate Workers were all `absent`; `test-org-e2e-sbx-1792932243` and
  `-1792932315` were still under the 24 h age rule and remain to purge (same prefix, `confirm` = the dry-run total). Actors cannot be tombstoned or purged by any route,
  so `e2e-sbx-probe-actor` and `prodcheck-1792366949` stay. Open: two migration gaps (`docs/OPEN-QUESTIONS.md` 2026-10-26: a fresh ledger lacks the
  `candidates.preview_*` columns; ledgers stamped m9/m10 on the `d34db95`/`469389b` line never get `user_tokens`; production is probably unaffected, unconfirmed) and the
  unique index on `actors.github_user_id` (m12, implemented on `agent/m12-actors-unique`, not merged or deployed; see "M12 unique index" below).
- Earlier (2026-10-26): production ran `main` at `f21024d` (all ten workers except the unchanged `beehive-sandbox-runner` redeployed 2026-10-25 20:55Z,
  `scripts/prod-health.sh` green; GitHub CI green). Since `ebb5c75` that added: namespace per request for sandbox builds (SF-8; fork-created candidates can be
  built) with a 400 on new org names that are not valid Artifacts namespaces; the Spec DO validating canary candidate ids and urls (`beehive-` ids refused,
  https `*.bz23711.workers.dev` only, `WORKERS_SUBDOMAIN` pin; unset = any `*.workers.dev`); a real ledger purge deleting candidate Workers first
  (`PREVIEW_MANAGER` binding on `beehive`); one CI workflow (`ci.yml`, formerly CI Enhanced; `ci-skip.yml` removed) incl. a root-worker dry-run; the flaky
  shadow-router timer test fixed. Plans: `docs/SF-8-NAMESPACE-PLAN.md`, `docs/CLEANUP-PLAN-2026-10-25.md`.
- **Not exercised in production yet (verify next):** a purge that actually deletes a candidate Worker (the first real run found all four `absent`), the 400 for a bad org name
  and for a bad canary id/url/subdomain, a canary build of a fork-created candidate (needs approval: AGENTS.md forbids e2e against production without it).
- Earlier (2026-10-25): the canary pipeline is live in production, including real candidate builds in a sandbox container and automatic rollback by the SLO loop (see "Canary pipeline" under Open work).
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

1. The Artifacts access token was rotated by the maintainer (2026-10-26). The `cf` remote URL (and the `meta-notes` one) still embeds a token, so it can
   appear in command output again (`git remote -v`, `git push` errors): redact it, or switch those remotes to a credential helper.
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
- PR-C (T7, CLI token support, `--token-stdin`, verify-before-save login, 0600 atomic config, "CLI actor attribution" rewrite)
  is implemented on `agent/m12-prc-impl` (plan `docs/M12-PRC-PLAN.md`; CLI/tests/docs only, no worker change); needs review and merge.
  Next: PR-D1/PR-D2 (T8/T9, `SESSION_SIGNING_KEY`).
- Deferred from PR-C (edge = spine, maintainer decision 2026-10-26): token expiry in `/api/whoami` and a machine-readable
  reason on 403 for user tokens; no GET retry on 503 in the CLI.
- **Verify assumption A4** (task): open one `beehive` invocation log for an authenticated `/api/*` request and one
  `/app` visit, and the same request's Honeycomb trace including the edge-to-DO subrequest span. Check that
  `Authorization`, `Cookie`, `X-API-Token`, `X-Beehive-Internal` and `X-Beehive-Admin` are redacted; never copy a value
  seen. If any is not: `invocation_logs = false` and trace header capture off on `beehive`, then rotate the exposed
  secrets, and record the result in `docs/OPEN-QUESTIONS.md` (2026-10-18 entry).
- **M12 PR-B T2 is merged** (2026-10-19): `bh_usr_` user token helpers added to `service-tokens.ts` (commit
  `50728bc`, PR `e786f60`); independent review approved by `cc90f6a`. The full PR-B has since merged (above).
- **Verify 404 differs by token type, on purpose:** a service-token verify 404 is "unknown token" (401); the user-token
  verify route always answers 200 for a well-formed hash, so its 404 means an older DO (503).
- **M12 unique index on `actors.github_user_id` (decided 2026-10-26 and approved 2026-10-27; implemented on `agent/m12-actors-unique`, awaiting review, merge and the human push):**
  migration `m12` (after m10 `idempotency_keys` and m11 `canary_metrics`) is a partial UNIQUE index
  (`WHERE github_user_id IS NOT NULL AND github_user_id != ''`, the same predicate the user-token code uses). On a ledger with duplicates the step
  **refuses** with `DuplicateGithubIdentityError` (names the values and actor ids; never skips, deletes or merges), `init()` rethrows, and that is a
  **full outage** until a human resolves the duplicate. So `scripts/check-actor-duplicates.sh` (or the SQL in `docs/OPS.md` step 1a) must come back empty
  immediately before the push; the 2026-10-26 production check found 0 duplicates among 3 actors, and anything older than the push can be stale (a login creates actors).
  Application side: `createActor` answers 409 for an existing identity (the UI login retries the lookup on a 409 and resolves to the winner). `m13`/`m14` in `docs/MR-FLOW-PLAN.md` follow it.
- **Prerequisite of master stage 2:** open the lifecycle routes (tombstone, purge, roles, `include_deleted`) to
  `maintainer` user tokens first; in M12 they stay master-only (plan A1). Stage 2 itself waits for the stage-1 evidence
  (`docs/OPS.md`, the AE query).


## Cleanup

- 2026-10-26: every sibling worktree is removed (none had uncommitted work except `beehive-recorder-flush`, an unshipped early draft of the recorder tail
  flush, dropped on purpose), and the local plan/review branches with them. Their final content is on `main`; what they held were earlier drafts of
  `docs/M12-IMPL-PLAN.md` / `docs/M9-NAV-PLAN.md`, review copies already on `main`, and two stale `test-nits-m11-pointer` commits that point the M11 index at
  `m11` (taken by `canary_metrics`; the index is `m12`). Recovery within the reflog window: `git branch <name> <tip>` with tips `agent/m12-plan` f1135ae,
  `m12-pra-review` 0545425, `m12-prb-review` d1a0146, `m12-review` ccb7e57, `m9-codereview` 4bbd33e, `m9-plan` c973334, `m9-review` eb6b8dc,
  `test-nits-m11-pointer` fb6fa0a. Nine older plan/review branches were deleted the same way (all content on `main`; `feature-parity-audit`, `ui-issues-plan`
  and `ui-issues-review` held superseded earlier drafts): `agent/cli-actor-review` 3fbcb1a, `feature-parity-audit` 95c5f25, `m8-do-recheck` fa58fb9,
  `m8-do-review` e850246, `m8-ui-review` 9b95582, `ocap-answers` 6d1ab8f, `ui-issues-plan` cc1ef7e, `ui-issues-plan-v2` cfcc296, `ui-issues-review` 6b88cbe.
  Local branches now: `main` and `fix/recorder-flush`. The maintainer deleted the last three remote branches (`origin/agent/m3-event-driven`,
  `agent/versions-spike`, `claude/pr1-review-lmgqik`) on 2026-10-26; the auto-mode classifier blocks agents from `git push origin --delete`.
- Merged `agent/*` branches: **15 merged agent/* remote branches deleted earlier** (2026-10-19, `2dc02e`, `a78017c`),
  plus `scratch/m8-*` remote refs deleted (2026-10-19, `507ebca`). As of 2026-10-23 another 15 `agent/*`/`merge/*` branches are 0 commits ahead of `main` (e.g. `m8-issues-do`, `m8-issues-ui`,
  `m9-nav`, `m12-pr-a`, `m12-pr-b`, `merge/m12-prb`) and can be deleted; the review/plan branches that are still ahead
  (their docs are on `main`) go once nothing needs them.
- `scripts/demo-multi-agent.sh` prints hard-coded ArtifactFS numbers (ArtifactFS is not built).
- The 5 skipped local e2e tests are m3 health checks for workers with no local port.

## Open work

- **Release the CLI (open, out of scope for PR-C).** There is no publish pipeline: `bin/beehive` runs `dist` or falls back to
  `src` via tsx, `cli/package.json` is 0.1.0. Decide what a release means (version bump and tag, or nothing) before PR-C ships to users.
- **The clean per-worker install CI step may not catch the zod failure — FIXED.** `ci.yml` (formerly ci-enhanced.yml) now builds
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
- **Canary pipeline (M3 loop + sandbox build): LIVE in production, verified end to end 2026-10-25.** Details and dated evidence: `docs/OPEN-QUESTIONS.md`
  (entries from 2026-10-24 on); runbook: `docs/OPS.md` "Canary SLO loop" and "Sandbox build container"; plans: `docs/M3-CANARY-SLO-PLAN.md`,
  `docs/SANDBOX-BUILD-PLAN.md`. How it works now:
  - `WORKER_VERSIONS_MODE=api` on `beehive-preview-manager` (a line in its `wrangler.toml`; delete it and push to get 501 again). A canary request
    (`POST /deploy-canary` on the canary worker) makes preview-manager read the ledger candidate + repository (UUID candidate id, repo namespace must
    equal the runner's), call `beehive-sandbox-runner` `POST /sandbox/build`, and upload the bundle as Worker `beehive-candidate-<uuid>`.
  - The sandbox runner builds the exact commit in a no-Internet container (`BuildSandbox`, container DO API, git clone through a credential-injecting
    gateway, esbuild with no install scripts, 60 s / 150 s / 1 MiB limits, builds of one commit coalesced).
  - The Spec DO arms a 60 s alarm on a canary deploy and sends ticks to queue `canary-slo-ticks`; the canary worker evaluates each live canary
    (`canary_slo_cycle`) and rolls back violators; the chain stops when no canary is live. There is no cron (cleared 2026-10-25).
  - The shadow router mirrors to live canaries (`global_fetch_strictly_public`; candidates get no `Authorization`/cookies) and posts per-minute
    samples; a failing candidate (error rate 1.0) was rolled back by the loop in about two minutes. `DELETE /api/preview/canary/:id` deletes a
    candidate Worker (refused while a canary is live).
  - **Known limits:** SLO data is `source = shadow`, not live canary traffic; only 5xx counts as an error; the default 1% top-level canary split
    yields few samples; the recorder tail flush is deployed (`ebb5c75`) but its effect on sample counts was not measured separately.
  - **Pending decisions / work:** (1) DONE and deployed (`f21024d`, untested against real data): the ledger purge deletes candidate Workers first (`docs/CLEANUP-PLAN-2026-10-25.md` C, `docs/OPS.md` "Ledger cleanup"); (2) purge the tombstoned test orgs `test-org-e2e-sbx-*` (three in the doc, four per the maintainer: dry-run first) from 2026-10-26 ~11:00 UTC (24 h age rule; needs the maintainer actor, `docs/OPS.md` "Ledger cleanup")
    and decide whether to delete actor `e2e-sbx-probe-actor`; (3) DONE: `wrangler deploy --dry-run` runs per worker and for the root worker in `ci.yml` (the former CI Enhanced); (4) the review of the post-review changes ran (no blockers, 8 should-fix); 7 are fixed and **deployed** (`ebb5c75`, 2026-10-25: shadow router: bodies to every target,
    no baseline replay of writes, canary ref/url validation, 10 s timeout; runner: abandoned-build guard, bounded cleanup; recorder tail flush, ordering fixed) and
    verified live for the POST-body path (`OPEN-QUESTIONS` "Review fixes deployed and verified"); SF-8 (namespace per request, plus 400 for new org names that are not valid namespaces) is **deployed** (`3bdddd9`/`f21024d`, `docs/SF-8-NAMESPACE-PLAN.md`); (5) DONE 2026-10-26: local `main` reset to `origin/main`; `0dd6edf` (another agent's recorder "fix": the timer never flushes anything) was dropped and its scratch branch deleted.
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
