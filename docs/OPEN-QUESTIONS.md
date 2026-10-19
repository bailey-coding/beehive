---
category: findings
status: active
audience: human,agent
tags:
  - spike-results
  - lessons-learned
---


*Recorded for future reference and team onboarding.*

---

## Hierarchical Repository URLs - Duplicate Name Issue

**Status**: Open - Requires Schema Decision

**Date**: 2026-10-14

**Issue**: The hierarchical URL feature (`/app/repos/{org}/{namespace}/{repo}`) has a silent failure mode when multiple repositories share the same `(organization.name, namespace, name)` tuple.

**Current Behavior**: 
- `.find()` returns the first matching repository
- Second+ repos with the same path become unreachable via hierarchical URL
- Their links open the wrong repository

**Impact**: Data integrity issue - users cannot reliably access repositories with duplicate names via the friendly URL format.

**Root Cause**: No uniqueness constraint in the Spec DO schema for:
- `organizations.name`
- `(organization_id, namespace, name)` in `repositories`

**Constraints**: 
- AGENTS.md rule: "Spec DO is the orchestration spine - hand-written, not agent-generated"
- Schema changes to Spec DO must be hand-written and carefully reviewed

**Recommended Solutions** (in priority order):

1. **Add UNIQUE indexes** (Preferred but requires schema change):
   ```sql
   CREATE UNIQUE INDEX idx_organizations_name ON organizations(name);
   CREATE UNIQUE INDEX idx_repositories_path ON repositories(organization_id, namespace, name);
   ```
   - Prevents duplicates at database level
   - Requires hand-written migration

2. **Application-level validation** (Quick fix):
   - Validate uniqueness before creating orgs/repos
   - Return error if duplicate detected
   - No schema change required

3. **Fallback with warning** (Temporary):
   - If duplicate detected during lookup, log warning
   - Fall back to UUID URL for duplicates
   - User still gets to their repo, but via less-friendly URL

**Decision Needed**: Should we enforce uniqueness at the schema level (breaking change for existing duplicates) or at the application level (prevents new duplicates only)?

**Related**: Hierarchical URL implementation in commit `8df4792`

---

## Pre-existing Test Gaps

**Status**: Open

**Date**: 2026-10-14

**Issue**: Test files in `workers/api/tests/ui.test.ts` are not included in the Vitest configuration (`vitest.config.ts` only includes `tests/**/*.test.ts`).

**Impact**: 
- 15+ pre-existing test failures in `workers/api/tests/` go unnoticed
- New failures from hierarchical URL changes (2 tests) also not caught by CI
- No CI coverage for UI route handlers

**Current State**:
- Unit tests in `tests/unit/` pass
- E2E tests in `tests/e2e/` run but many fail (require running workers)
- UI tests in `workers/api/tests/ui.test.ts` are never executed

**Recommended Fix**:
1. Update `vitest.config.ts` to include `workers/api/tests/**/*.test.ts`
2. Investigate and fix the 15 pre-existing failures
3. Add tests for hierarchical URL routes

**Blocker for**: Full test confidence in UI routing changes

---

## Artifacts REST API: repo content routes (2026-10-15)

**Status**: Resolved (README + tree working in the UI); response shapes still undocumented

**Finding**: There is no `/artifacts/repositories/:ns/:repo/contents` route. Real routes (relative to `/accounts/:id`) are under `/artifacts/namespaces/:ns/repos/:name/`: `log?ref=&limit=`, `commit/:hash`, `tree/:hash`, `blob/:hash`, `file?ref=&path=` (raw bytes), `raw/:ref/:path`. `tree/:hash` takes a SHA, not a branch, so reading a branch root is log -> commit -> tree.

**Undocumented**: JSON `result` shapes for `log`, `commit`, `tree`. `fetchArtifactsContents` (`workers/api/ui-semantic.ts`) parses defensively and logs the raw snippet when a field is missing. Replace with typed parsing once confirmed.

**Deploy gotcha**: `CLOUDFLARE_API_TOKEN` on `beehive` was present in `wrangler secret list` but empty at runtime, so the UI silently fell back to mock data. Re-putting it via `wrangler secret put` fixed it. The skip log now says which of token/accountId is missing.

---

## Spec DO ledger has no delete routes (2026-10-13)

**Status**: Resolved in code (`agent/spine-item3-ledger-lifecycle`, merged to `main` 2026-10-16).
Production cleanup is still only possible by deleting the Durable Object data out-of-band until
the maintainer deploys `beehive` and the live ledger migrates past m3. See "2026-10-15: Ledger lifecycle" below and `docs/OPS.md`.

**Finding**: Neither the API worker (`workers/api`) nor the Spec DO (`workers/spec-do`) implements any delete route (no `DELETE` handlers, no `DELETE FROM`). E2E runs against production left 27 `test-org-e2e-*` organizations in the ledger with no way to remove them through the platform.

**What was done**: The maintainer removed them by hand in the Cloudflare dashboard on 2026-10-13 (the `wrangler delete --name beehive --force` + redeploy route is documented in `docs/OPS.md` and also removes everything, including worker secrets). Both paths destroy all ledger data, not just the test orgs, so neither is acceptable once real trials exist.

**Want**: an authenticated admin purge route restricted to maintainer actor IDs, plus soft-delete/tombstones for specs and candidates (the M1 "Ledger lifecycle" item in `docs/MILESTONES.md`, not built as of 2026-10-15). A purge by org-name prefix would have cleared this incident with one API call.

**Interim rule**: do not run e2e against production without human approval (`AGENTS.md`).

## 2026-10-15: Promotion ledger DO routes (spine item 1, option A) - follow-ups

Branch `agent/spine-item1-do-routes` adds `/promotion-states*`, `/tournament-status*`,
`/merge-train-status*` to SpecDO (tables `promotion_states`, `tournaments`, `merge_trains`,
migration m3 -> m4, additive). Contract: `workers/shared/promotion-ledger.ts`. The live DO only
migrates once this reaches `main` (human approval). Open points:

- **No foreign keys on the new tables (deviation from the plan; human call).** DO SQLite enforces
  FKs, and the promotion worker (and the e2e suite) promote ids that have no `candidates`/`specs`
  row. FKs would reject every such promotion. Adding or removing FKs later needs a table rebuild.
- **`currentRung` never advances.** `state.ts` stores `currentRung = fromRung`; completion does not
  move it to `targetRung`. e2e "promote through valid rung transitions" expects `canary` after
  train -> canary. That is promotion-state semantics; not changed.
- **e2e/worker response-shape drift (not spine):** `GET /promote/:id` returns `{ state: {...} }`
  but e2e reads top-level `currentRung`; `POST /mode` returns `mode` but e2e reads `newMode`.
- **Still unserved by SpecDO:** `GET/PATCH /candidates/:id` and `POST /candidates/:id/rollback`
  (tournament.ts metrics + winner promotion, merge-train.ts rollback). Metrics fall back to defaults
  and the PATCH/rollback responses are ignored, so these fail silently. `/api/canary-deployments*`
  is item 2.
- Ledger writes are not in `entity_history`: its `entity_type` CHECK has no promotion types and
  widening it needs a CHECK rebuild. Still open; item 3 hit the same wall for organizations and
  repositories and used a separate `purge_log` table (see "Ledger lifecycle" below).
- `/promotion-mode` still answers before `init()` (KV only, no SQL); not renamed to `/internal/`.

## 2026-10-15: Cross-worker e2e failures (local) - root causes

Local run of `tests/e2e/cross-worker-flows.test.ts` after route fixes: 11 pass, 9 fail, 2 skip
(was 14 failing). Remaining failures are real worker defects, not test drift:

1. **Promotion worker cannot talk to the Spec DO (spine; needs a human).** Two defects in
   `workers/promotion-worker/spec-do.ts` / `workers/spec-do/index.ts`:
   - `getSpecDo(env).getPromotionMode()` is an RPC call, but `SpecDO` (`workers/spec-do/index.ts:233`)
     does not `extends DurableObject`, so workerd throws "The receiving Durable Object does not
     support RPC" and `/mode`, `/promotion/health` return an HTML 500. Fix: `class SpecDO extends
     DurableObject` (import from `cloudflare:workers`, call `super(state, env)`).
   - `tournament.ts` / `merge-train.ts` call `getSpecDo(env).fetch('/promotion-states?...')` with a
     relative URL; `DurableObjectStub.fetch` needs an absolute URL ("Invalid URL: /promotion-states").
     Fix: prefix `https://spec-do.internal`, as every other caller does.
   Not changed: SpecDO and promotion-train logic are spine. Affects 7 tests (mode, health,
   promote x3, valid/invalid transitions, consistency).
2. **Canary -> preview-manager routes do not exist.** (Resolved on `agent/canary-rollback`:
   `POST /api/preview/canary`; rollback is a Spec DO deploy-ref move. See "2026-10-16: Canary
   deploy and rollback".) `canary-worker/canary.ts` calls
   `POST /api/deploy` and `rollback.ts` calls `POST /api/rollback`; `preview-manager` only serves
   `/api/preview/deploy`. Canary deploy/rollback cannot work until a route is designed (it needs a
   real Workers Builds deployment, not just wiring). Affects 2 tests + consistency test.
3. **Canary -> preview-manager calls sent no bearer token** (fixed: `canary.ts`, `rollback.ts` now
   send `Authorization: Bearer ${API_AUTH_TOKEN}`; queue-consumer already did). The 401 was
   masked in local runs by (4).
4. **Local service bindings only connect to running `wrangler dev` sessions.** (Resolved on
   `agent/canary-rollback`: the script starts preview-manager on 8791.) wrangler reports
   `[not connected]` and the call fails with `Worker "beehive-preview-manager" not found` unless that
   worker is also running (e.g. `--config workers/preview-manager/wrangler.toml --port 8791
   --inspector-port 9234`, with its own `.dev.vars`). `scripts/start-e2e-workers.sh` does not start it.
5. `npm run test:e2e:local` runs `tests/e2e/m3-features.test.ts` too, which hard-codes production
   URLs and, when `BEEHIVE_API_TOKEN` is set in the environment, **sends real requests to
   production**. Run `npx vitest run tests/e2e/cross-worker-flows.test.ts` with
   `E2E_ENVIRONMENT=local` instead until that file is gated.

The two former `start` tests (`/promotion/merge-train/start`, `/promotion/tournament/start`) have
no equivalent route by design (trains are joined via `POST /promote`); they were already removed.

## 2026-10-15: Ledger lifecycle (spine item 3) - tombstones + purge

Branch `agent/spine-item3-ledger-lifecycle` (on top of item 1). Migration m4 -> m5, additive only:
`deleted_at`/`deleted_by`/`delete_reason` on organizations, repositories, specs, candidates, issues;
`actors.role`; new `purge_log`. The columns are added behind a `PRAGMA table_info` check, because
`ALTER TABLE ADD COLUMN` is not idempotent (the m1 -> m2 comment claiming it is is wrong). The live
DO migrates only once this reaches `main`. Usage: `docs/OPS.md` "Ledger cleanup". Open points:

- **entity_history gap (accepted, not fixed).** The `entity_type` CHECK has no `organization` or
  `repository`, and no table rebuild was allowed. Tombstone/purge of specs, candidates and issues
  writes `entity_history` rows (stage `tombstoned` / `purged`); orgs and repos are audited only in
  `purge_log` (one row per tombstone, purge, role change, including refusals and dry runs).
- **Service principals vs. maintainer.** (Resolved on `agent/service-accounts`, m6: accounts
  have `actor_id`, and the DO refuses service actors on tombstone, purge and role routes.)
  `service_accounts` has no `actor_id` column, so the DO
  cannot tell a service account's actor from a human one. "Service principals never purge" is
  enforced at the edge (`principal.kind !== 'master'` -> 403 on every lifecycle route, including
  `?include_deleted=1` reads). Related pre-existing defect: `verifyServiceTokenHash`
  (`workers/spec-do/index.ts`) selects `sa.actor_id`, which does not exist in either schema, so
  service-token verification cannot succeed. Not fixed (service-account semantics, not item 3).
- **Maintainer bootstrap (inference, human call).** The first maintainer self-grants via
  `POST /api/admin/actors/:id/role` while no maintainer exists; afterwards only maintainers grant.
  Anyone holding the master token can pick any `X-Actor-ID`, so the role guards against
  accidents, not against a master-token holder.
- **Tombstone needs only the master token + an `X-Actor-ID`** (no maintainer role); purge and
  `include_deleted` need the role. There is no undelete route (restore = manual SQL).
- **Active promotion** = a `promotions` row with `stage='active'` or a `promotion_states` row with
  `status` `pending`/`in_progress`, or (since m7, `agent/canary-rollback`) a candidate that a live
  `deploy_refs` head points at. It blocks both tombstone and purge.
- **Purge scope.** Purge works on organizations (prefix or ids) and takes their whole tombstoned
  tree plus dependent rows (issue comments/links, gate verdicts, trials, promotions), which are
  not tombstoned themselves. An org is skipped if any descendant is live or tombstoned too
  recently, if a repository of another org points at its specs, or if it owns service accounts.
  Promotion ledger rows (`promotion_states`, `tournaments`, `merge_trains`) are kept: no FKs.
- **Not filtered by tombstones:** trials, gate verdicts, promotions, issue comments and the
  promotion ledger routes still return rows that reference tombstoned entities. Mutations
  (`PATCH .../stage`) on a tombstoned row are not refused; claim of a tombstoned spec is (404).
- **Pre-existing bug found by the tests:** `createTrial` binds `decided_at = null` into a
  `NOT NULL` column, so `POST /api/trials` always fails. Not fixed (trial semantics).
- **Local e2e environment:** (Resolved on `agent/canary-rollback`: health checks use `curl -f`.)
  `scripts/start-e2e-workers.sh` health checks use `curl -s` without
  `-f`, so a worker answering 503 (missing `workers/<name>/.dev.vars`) is reported healthy. Each
  of shadow-router, canary-worker and promotion-worker needs its own `.dev.vars`.

---

## Spec DO ledger lifecycle: tombstones and purge not built (2026-10-15)

**Status**: Resolved in code; **superseded by "2026-10-15: Ledger lifecycle" above** (tombstones and purge, merged to `main` 2026-10-16). Not live until `beehive` is deployed. The text below is the original finding, as verified against `main` on 2026-10-15: no tombstone, soft-delete, purge, or ledger `DELETE` code in `workers/` (the only `DELETE` calls are preview-manager's Cloudflare Builds API calls in `workers/preview-manager/builds.ts`).

**Finding**: The ledger cannot be cleaned up through the platform. The root cause is in [Spec DO ledger has no delete routes (2026-10-13)](#spec-do-ledger-has-no-delete-routes-2026-10-13). This entry tracks the missing lifecycle work that would fix it. The M1 "Ledger lifecycle" item in `docs/MILESTONES.md` (tombstones for specs and candidates, plus an authenticated admin purge route) was unbuilt when this was written; it is built now.

**Only cleanup today**: `wrangler delete --name beehive --force`, then redeploy `beehive` via the maintainer's deploy flow (`docs/OPS.md`) and re-put the `beehive` secrets (`docs/OPS.md`, "Destructive and irreversible"). That destroys all ledger data and secrets on `beehive`, not only the test data. The one targeted cleanup so far, the 27 test orgs on 2026-10-13, was a manual out-of-band removal in the Cloudflare dashboard (see the linked entry), not a platform route.

**Want**: tombstones (mark, never destroy) and a purge route scoped to test data, per the M1 item. Until then, any wipe is a `beehive` worker deletion and needs human approval.

---

## 2026-10-15: CI test triage (branch `agent/ci-docs-tests`)

Baseline at the base commit: `npm test` = 20 failing unit tests (workers/api/tests: api 2,
service-accounts 7, ui 11) plus 43 e2e failures when no workers run. After this branch:
0 failing, 7 skipped (below).

- **`npm test` no longer runs `tests/e2e/`.** Those tests make real HTTP calls to running
  workers, so they cannot pass in CI. Use `npm run test:e2e:local` (start workers first,
  `docs/SETUP.md`). The `test:e2e*` scripts are unchanged.
- **Stale test expectations fixed** (code was right): api.test.ts read the DO request as JSON
  (it is a `Request`) and expected `timestamp` on a pass-through DO error; ui.test.ts cross-origin
  tests had no session cookie (auth redirect precedes the origin check), the form POST tests
  set a manual `multipart/form-data` header (drops the boundary) and had no DO POST handlers, the
  repo XSS test mocked `/api/repos/:id` (real route `/api/repositories/:id`), the "invalid tab"
  test expected a capitalised `Overview` (tabs render lowercase), the DoReader test expected a
  synchronous throw from an async `fetch`, and the XSS test asserted the absence of the literal
  `onerror=` that appears inside correctly escaped text.
- **Real bug fixed (small, non-security):** `visibilityBadge()` passed `visibility public` to
  `badge()`, which only knows `public`/`internal`/`private`, so every visibility badge rendered
  with the bare `badge` class. Now passes the bare value.
- **Real bug fixed:** `SpecDO.createTrial` bound `decided_at = null` into a `NOT NULL` column, so
  `POST /api/trials` always failed. Now binds `0` (the value the returned row already reported);
  `decideTrial` sets the real time. Test: `workers/spec-do/tests/trials.test.ts`.
- **Minor, not changed:** an empty repo search (`?q=` with no hits) renders "No results found"
  with no `Mocked` label, although the search is mocked. Only the with-hits path labels it.

### Service accounts: API handler and Spec DO disagree (2026-10-15)

**Status**: **Resolved on branch `agent/service-accounts`** (2026-10-16): the maintainer chose
the `service_tokens` + actor-per-account design; see "2026-10-16: Service tokens (m5 -> m6)"
below. The 7 tests are un-skipped there. Text below is the finding as it stood.

Was: open, needing a maintainer decision. 7 tests
in `workers/api/tests/service-accounts.test.ts` are `it.skip` (create/list, scope and name
validation, read-token authorization, spoofed `X-Actor-ID`, revocation, expiry, DO failure -> 503).

**Finding**: two incompatible designs are present.
- `workers/api/service-accounts.ts` and the tests expect the DO's `POST /internal/service-accounts`
  to return `{ data: { account, token } }` and to store tokens in a `service_tokens` table
  (the tests query and `DROP` that table; no such table exists in `workers/spec-do/schema-inline.ts`).
- The DO stores one row per account in `service_accounts` (token hash on the account row) and
  returns the bare row (`createServiceAccount`), so the API's `res.json().data.account` is
  undefined and mint fails with 502 ("Failed to create service account").
- `SpecDO.verifyServiceTokenHash` (`workers/spec-do/index.ts`, ~L455) selects `sa.actor_id` and
  joins `actors ac ON ac.id = sa.actor_id`; `service_accounts` has no `actor_id` column
  (`schema-inline.ts`), so verification would throw for any presented service token.
  `service_accounts` also requires an existing `created_by` actor FK and an existing
  `organization_id`, which the handler fills from `principal.organizationId`/`actorId`.

**Want**: pick one design (a `service_tokens` table plus an actor per service account, as the
tests assume, or the account-row design), then align schema, DO routes, `verifyServiceTokenHash`
and the handler, and un-skip the tests. Until then, service tokens cannot authenticate.

---

## 2026-10-16: Service tokens (m5 -> m6) (branch `agent/service-accounts`)

Resolves "Service accounts: API handler and Spec DO disagree" above. Usage: `docs/OPS.md`
"Service tokens". Reaches the live DO only through the maintainer's deploy flow.

- **Migration m5 -> m6, additive:** `service_accounts.actor_id` (PRAGMA-guarded `ALTER TABLE ADD
  COLUMN`), new `service_tokens` (unique index on `token_hash`), indexes. No rebuild. Verified
  locally on a real workerd m3 ledger (m3 -> m6 in one restart) and in node:sqlite from m5.
- **Pre-m6 accounts fail closed:** no actor, no token rows, so they never authenticate; they list
  with `actorId: null` and can be revoked, not given new tokens. Their legacy `token_hash`/
  `token_salt` columns are never read; new rows write `''` there (NOT NULL, no rebuild).
- **Service actor type is `agent`:** the `actors.type` CHECK has no `service` and widening it
  needs a rebuild. A service actor is identified by `service_accounts.actor_id`, not by type.
- **Reserved rows (inference, human call):** master mints without `X-Actor-ID` are attributed to
  a reserved actor `master` (type `human`); accounts belong to a reserved org `beehive-system`
  (both FK targets; created on first mint). An unknown `X-Actor-ID` on mint is 400. The org shows
  in org lists and is never purged while it holds accounts (purge skips such orgs).
- **Retired `/api/service-accounts*` (410):** a third, older token scheme. Its `GET` was open to
  any read principal and listed `token_hash`/`token_salt`. The DO routes behind it are removed.
- **Defence in depth in the DO:** lifecycle routes (tombstone, purge, role) refuse a service
  actor as caller (403); a role cannot be granted to a service actor; `isMaintainer` is false for
  service actors even with `role` set out of band. Tokens of a tombstoned org stop verifying.
- **Not changed:** `PATCH /api/actors/:id/promotion-authority` can still set the flag on a service
  actor (master only); the edge always gives service principals `promotionAuthority: false`.
- **Open:** if the m6 step fails, `isServiceActor` throws, so lifecycle routes answer 500 for
  the master token too (fail closed) until the migration succeeds.

---

## 2026-10-15: e2e test-side route drift, and what is left (branch `agent/ci-docs-tests`)

`npm run test:e2e:local` before: 28 failed, 22 passed, 6 skipped. After: 6 failed, 43 passed,
7 skipped. Route table: `docs/SETUP.md` "Local e2e status".

- **Test-side fixes:** `m3-features.test.ts` used `/canary/*`, `/shadow/*`, `/promotion/*` routes
  and response shapes that never existed (`/health` wrapping, `statsig`/`config` wrappers,
  `newMode`, `201` for promote, `promotionId`). `cross-worker-flows.test.ts` read
  `currentRung` at the top level (the worker nests it under `state`) and `newMode` (the
  worker answers `mode`). Tournament and merge-train "start" tests now join via `POST /promote`.
  Specs now use a unique `specId` per run (a completed tournament refuses more candidates with 500).
- **Deleted, not skipped:** `should get traffic split metrics` (`/shadow/splits`): the shadow
  router has no traffic-split metrics route, so the test was removed on `agent/canary-rollback`
  (see "2026-10-16: Canary deploy and rollback"); it is not an `it.skip`.
- **Source change (own commit, revertable):** promotion-worker `markAsCompleted` now sets
  `currentRung = targetRung`. Before, a completed promotion kept `currentRung` at the rung it
  started from, so `GET /promote/:id` could not report where a candidate is.
- **Still failing, out of scope (spine item 2: canary deploy/rollback):** (All three resolved on
  `agent/canary-rollback`; see "2026-10-16: Canary deploy and rollback".)
  - `POST /deploy-canary` returns 500 locally: `beehive-preview-manager` is not running
    ("Make sure it is running locally"). `scripts/start-e2e-workers.sh` does not start it.
  - `GET /canary-deployments/:candidateId` throws `DataCloneError: Could not serialize object of
    type "RpcPromise"` (`workers/canary-worker/canary.ts:97`): an RPC stub result is returned
    through another RPC/serialization boundary without awaiting.
  - no auto-rollback config route (`/canary/:id/auto-rollback`) exists; only `POST /rollback`.

---

## 2026-10-16: Canary deploy and rollback (m6 -> m7) (branch `agent/canary-rollback`)

Spine item 2, design as approved: preview-manager `POST /api/preview/canary` builds a version
(`{url, versionId}`); rollback is a Spec DO ref move; `deploy_refs` is the authority. Contract:
`workers/shared/deploy-refs.ts`. Usage: `docs/OPS.md` "Canary deploy and rollback". Reaches the
live DO only through the maintainer's deploy flow. Local e2e: 6 failed -> 0 failed.

- **Migration m6 -> m7, additive:** `CREATE TABLE/INDEX IF NOT EXISTS` for `deploy_refs` and
  `canary_deployments`, no ALTER, no rebuild. Verified in node:sqlite from m6 and on a real
  workerd ledger (the local DO from the pre-change baseline run reached m7 on restart).
- **"Pointer move" is an append (inference, human call).** The head of a (spec, rung) is the row
  no other row names as `prev_ref_id` (a unique index on `prev_ref_id` keeps the chain linear).
  Promotion appends a row with the new target; rollback appends a row with the target of
  `head.prev_ref_id`. So rows are never updated, history is a reflog, promotion and demotion are
  the same insert, and rolling back twice toggles back (the plan's unit test). Rolling back the
  first canary moves to the empty ref (`candidate_id` NULL: no canary). Going back more than one
  step needs a new promotion; there is no "rollback to ref X" route.
- **Schema beyond the approved column list:** `deploy_refs.action` (`promote`|`rollback`, audit),
  `rung` CHECK limited to `canary`/`full` (the rungs with traffic), nullable target columns (the
  empty ref). `canary_deployments` columns are mine (url, version, split, `auto_rollback`,
  `deploy_ref_id`, status `deployed`/`superseded`/`rolled_back`). No foreign keys, like the
  promotion ledger: e2e (and the promotion worker) use candidate/spec ids with no ledger row.
  A tombstoned candidate or spec is refused (404).
- **Workers Versions API: unverified, stubbed, not called.** Open: can a version be created from
  a candidate commit, and can a deployment be switched to it instantly? Nothing here depends on
  it. `workers/preview-manager/versions.ts` has only `StubWorkerVersionsClient` (`stub-<uuid>`,
  URL `<prefix>-<worker>.<subdomain>.workers.dev`), selected by `WORKER_VERSIONS_MODE=stub`
  plus `BEEHIVE_LOCAL_DEV=1` (both set by `scripts/start-e2e-workers.sh`). Unset (production) the route answers **501**, so
  production canary deploys fail closed until a real client is written and verified. Rollback
  calls no Cloudflare API at all: traffic follows the ref.
- **Where traffic follows the ref.** shadow-router now binds `SpecDO` and, per mirrored request,
  reads `GET /deploy-refs/live?rung=canary`: each live canary becomes a mirror target at its
  version URL with its split. If the read fails, no canary target is added. No cache (a cache
  would delay a rollback); one DO read per request. (Superseded the same day: a short in-isolate
  cache was added, see "2026-10-16: Shadow-router live-ref cache".) **Not built anywhere:** serving real user
  traffic from the canary. The shadow router still discards candidate responses, so "canary %
  live" is today "canary % mirrored". `/statsig/classify` is unchanged (unknown candidates get
  the default split).
- **Not written (needs promotion-worker changes, out of scope):** nothing writes a `full`-rung
  ref (the promotion worker's canary -> full completion would), so the Artifacts
  `refs/heads/production` provenance mirror is not written either. The rollback's
  `promotions.stage='rolled_back'` update matches only `promotions` rows (`to_rung` = the rung,
  `stage='active'`); the promotion worker does not write that table, so it usually matches
  nothing. A toggle-back does not restore `stage='active'`.
- **Lifecycle:** a candidate that a live head points at counts as active: tombstone and purge are
  refused (409), like an active promotion. Non-head `deploy_refs` / `canary_deployments` rows of
  a purged candidate are kept (no FKs), like the promotion ledger.
- **`DataCloneError` on `GET /canary-deployments/:id` (fixed):** `canary-worker/index.ts` replaced
  `env.SPEC_DO` (the namespace) with a DO stub. On a stub every property is an RPC method, so
  `idFromName()` returned an `RpcPromise` and `get(RpcPromise)` could not clone it. The worker now
  passes `env` unchanged (fetch and queue). Regression test in `canary-worker/tests/canary.test.ts`.
  The route now takes a deployment id (as the e2e test always did); `?candidateId=` lists.
- **Auto-rollback route: the test was wrong, the route was missing.** Added
  `GET/POST /canary/:candidateId/auto-rollback` (`{enabled}`) on the candidate's live canary. The
  test configured a candidate that had no canary, which has nothing to switch (404); it now
  deploys first. Semantics (inference): a manual `POST /rollback` always runs; `latency`,
  `error_rate`, `slo_violation` triggers get 409 when the switch is off. `SLOMonitor.getMetric`
  still returns 0, so no automatic rollback fires yet.
- **Response shapes aligned to the e2e tests:** `POST /deploy-canary` answers
  `{success, deployment, deployRef}` with `status: 'deployed'` (was a bare record with `active`);
  `rolling_back` is gone (the DO move is atomic).
- **`/shadow/splits` e2e test deleted:** it asked for split metrics over a time window. Those live
  in Analytics Engine, which the router only writes; serving them would mean new read semantics.
- **Not fixed:** the canary worker's `ANALYTICS.writeDataPoint` payload puts objects in `blobs`
  (pre-existing). It is now wrapped so a metrics failure cannot fail a deploy after the ref moved.

---

## 2026-10-16: Spec DO internal auth, two tiers (branch `agent/do-auth-and-cache`)

Resolves the review follow-up "no auth on Spec DO routes": any worker with the cross-script
`SPEC_DO` binding (now including shadow-router and preview-manager) had full control, including
purge, role grant and tombstone. Usage and secrets: `docs/OPS.md` "Spec DO internal tokens".

- **Changes the deploy requirements:** two new secrets. `SPEC_DO_INTERNAL_TOKEN` on `beehive` and
  the eight DO-calling workers, `SPEC_DO_ADMIN_TOKEN` on `beehive` only. They must be put before the
  first deploy that has the check (deploy checklist step 0); the DO fails closed (503) without its own.
- **Where:** one gate at the top of `SpecDO.fetch` (`workers/shared/spec-do-auth.ts`), before the
  `/promotion-mode` shortcut and before the schema is touched. Callers get their stub from
  `getSpecDoStub(env)`; a guard test fails if any worker builds one from `env.SPEC_DO` by hand.
- **Privileged set (my call, human review):** tombstone, purge, role grant, every service-account
  route (including the list), and `PATCH .../promotion-authority`. The last two were not in the
  brief's list; both are master-only at the edge and have no non-API caller. `/promotion-mode` stays
  tier 1 because the promotion worker writes it (a tier-1 holder can still change the mode; moving it
  to admin would need the promotion worker to hold the admin token).
- **Residual risk, unchanged:** a tier-1 holder can still read and write all ordinary ledger rows and
  can set any `X-Actor-ID`, so `?include_deleted=1` (maintainer check by actor id) is only as strong as
  the tier-1 token. The tokens bound the blast radius of a compromised non-API worker; they are not
  per-worker identities (one shared tier-1 value). `sandbox-runner` declares the binding but never
  calls the DO, so it gets no token.
- **Constant-time:** `timingSafeEqual` loops over the longer input; only length can leak.
- **Rollout window:** all ten workers deploy at once (no order control), so a caller still on old
  code answers 401 on DO calls until its own deploy lands (`docs/OPS.md` checklist step 5).
- **Public edge unchanged:** `API_AUTH_TOKEN` handling in `workers/api` is as before; the API worker
  now adds the tokens on its own DO calls.
- **Local e2e:** `scripts/start-e2e-workers.sh` generates both tokens per run and starts
  `tests/e2e/probe` (port 8792, local-only, 404 unless `BEEHIVE_LOCAL_DEV=1`, never deployed): a
  worker with only the tier-1 token, used by `tests/e2e/spec-do-auth.test.ts`. The script now checks
  port 8792 as well.

---

## 2026-10-16: Shadow-router live-ref cache (branch `agent/do-auth-and-cache`)

Resolves the review follow-up on the one-DO-read-per-mirrored-request cost. Code:
`workers/shadow-router/live-refs-cache.ts`, used by `applyCanaryRefs` (`config.ts`).

- **Bound on rollback visibility: `LIVE_REFS_CACHE_TTL_MS` (default 5000).** A ref move in the Spec DO
  shows up in an isolate within one TTL of the move; each isolate caches on its own, so the bound holds
  across the fleet. Promotion has the same delay (a new canary starts being mirrored up to one TTL late).
- **DO read failure:** the last good value is served while its age (from when that read started) is
  under 2 x TTL, then `applyCanaryRefs` returns the static config (no canary targets), as before the
  cache. So the worst-case staleness of an old pointer is **2 x TTL = 10s by default**, only during a DO
  outage. A rolled-back candidate can therefore keep receiving mirrored traffic for up to that long.
- **Never cache an error:** a failed read stores nothing and the next request retries (no negative cache,
  so an outage costs one in-flight read at a time, not one per request).
- **Concurrent requests share one in-flight read** (also when it fails).
- **`LIVE_REFS_CACHE_TTL_MS=0` disables** everything (no cache, no dedupe, no stale value): the old
  behaviour. Unset, empty, negative or non-numeric -> 5000; values above 60000 are clamped to 60000.
  Not set in `wrangler.toml`; add it as a worker var to change it.
- **Mirror-only:** the router still discards candidate responses, so this delay affects which
  candidates get mirrored traffic, not what users see.
- **e2e:** the rollback e2e (`cross-worker-flows.test.ts`) now polls for up to 8s instead of reading the
  router once; it passes in about 10s.

---

## Live ledger had a `service_accounts` table of another design (2026-10-16)

**Status**: Worked around on the live ledger; origin unknown. The m3 -> m8 deploy stopped at m5
with `Migration to m6 failed: no such column: is_active at offset 75`, and every Spec DO request failed
until the table was dropped by hand.

**Finding**: `service_accounts` existed on the live Spec DO with a shape no commit in this repo
creates: `actor_id TEXT NOT NULL UNIQUE`, `revoked_at`, `scopes TEXT NOT NULL`, no `token_hash`,
`token_salt` or `is_active`, and only an `idx_service_accounts_org` index (created without
`IF NOT EXISTS`). It held 0 rows. `CREATE TABLE IF NOT EXISTS` left it alone, so the m6 step's
`CREATE INDEX ... ON service_accounts(is_active)` failed. Every migration test builds the table
from this repo's own SQL, so none could see it. The fail-loud migration did its job: m4 and m5 are
additive and had committed, m6 did not advance, nothing was half-migrated.

**Fix on the ledger**: `DROP TABLE service_accounts` (empty, and nothing referenced it yet, since
`service_tokens` is created by m6). The next request ran m6 -> m8.

**In the code**: `applyServiceTokens` now checks the existing table's columns first and throws
`service_accounts has an unexpected shape (columns: ...; missing: ...)` with the way out, instead of
the index error. It never drops anything itself: a table with rows needs a human to migrate them.
Regression test: `workers/spec-do/tests/migrations.test.ts`.

**Open**: how the table got there. The deploy goes through the Cloudflare Artifacts repo, which
may have carried an earlier design, or the table was created by hand. Unverified. Other tables on a
ledger that predates this repo's history may differ the same way; `docs/OPS.md` step 1 now asks to
list `sqlite_master` before deploying.

---

## Promotion worker calls Spec DO routes that do not exist (2026-10-16)

**Status**: Resolved 2026-10-16 (promotion-routes-fix) with the existing DO routes; the plan is at the end of this entry. Found by the local e2e rerun after the ledger CAS change.

**Finding**: `workers/promotion-worker` calls `GET /candidates/:id` (tournament metrics,
`tournament.ts`), `PATCH /candidates/:id` (promote the winner: `current_rung`, `status: promoted`,
`promoted_at`) and `POST /candidates/:id/rollback` (`merge-train.ts`). The Spec DO serves none of
them: its candidate routes are `/api/candidates`, `/api/candidates/:id`, `.../stage`, `.../preview`,
`.../gate-verdicts`, `.../execute`. Every call answers 404. Consequences: tournament metrics always
fall back to defaults, a tournament winner and a rolled-back merge-train car are never recorded on the
candidate, and none of it failed visibly because the responses were not checked.

**Original note (now resolved)**: making the winner PATCH fatal (tried, reverted) fails every tournament at the last
step. The fix is a decision for the maintainer: which DO route and fields carry a rung change
(`/api/candidates/:id/stage` exists), what a rollback writes, and whether the DO should own the
`current_rung` bookkeeping the ledger already has in `promotion_states`. Until then the winner PATCH
only logs a warning.

**Plan (promotion-routes-fix, existing routes only, no DO change)**:
- `GET /candidates/:id` -> `GET /api/candidates/:id`. The body is `{success, data}` with `shadowScore` and
  `shadowMetrics` (a JSON string); there are no `metrics`/`score` fields, so those two feed the existing defaults.
  A !ok answer still falls back to defaults (the comparison tolerates missing metrics), but is now a real read.
- Winner `PATCH /candidates/:id` -> `PATCH /api/candidates/:id/stage {stage, notes}` with `X-Actor-ID:
  promotion-worker`. The DO writes `candidates.stage` and an `entity_history` row. Rung -> stage:
  pre-merge `passed_premerge`, shadow `passed_shadow`, train `passed_train`, canary `passed_canary`, full
  `promoted`. `promoted_at` has no column; the history row's `changed_at` is that timestamp. The call is
  fatal again (throws on !ok), so the tournament is recorded `failed` and can be retried.
- Rollback `POST /candidates/:id/rollback` -> the same stage route with `stage: 'rolled_back'`, `notes:
  <reason>`. It writes the candidate stage and a history row, nothing else. Fatal for the call (returns
  `success: false`); the ledger car is already `rolled_back` by then and the stage write is idempotent.
- Rejected: a new `PATCH /api/candidates/:id` or `/rollback` route (spine work, and the stage route already
  carries a stage plus history); having the DO own `current_rung` (the ledger's `promotion_states` already
  does); calling the deploy-ref `rollbackHead` (that is the canary/ref rollback for deployed rungs, not a
  merge-train car); adding a `promoted_at`/`current_rung` column (schema change).
- Mixed versions: every route used exists in the DO today, so a new worker works against an old DO, and
  an old worker against a new DO behaves as before (its 404s). No ordering dependency.
- Result: the winner write is fatal again; tournament e2e now seeds real candidates, since a fabricated id is correctly rejected.
- Known gap: the stage route does not validate the transition (any stage is accepted, an unknown one hits
  the table CHECK and answers 500). Not changed here.

---

## Edge `/health` on `beehive` reports the Spec DO as ok without calling it (2026-10-16)

**Status**: Resolved 2026-10-17 in code (takes effect when deployed). `8480fde` made `handleHealth` call the DO's
`/health`; it still answered HTTP 200 `degraded` when the DO was down, so a status-code check passed with a stuck
ledger. It now answers 503 `unhealthy` (`success: false`, both checks `error`), with unit tests for the healthy,
non-OK and throwing cases (`workers/api/tests/api.test.ts`).

**Finding** (as first logged): `handleHealth` (`workers/api/index.ts`) returned a fixed body with `database: 'ok'` and
`durableObject: 'ok'` and never touches the Spec DO. During the m3 -> m8 deploy the ledger was stuck at
m5 and every DO request failed, yet `GET /health` on `beehive` still answered 200 `healthy`. It also does
not trigger the DO's lazy init, so it does not run the migrations either (an earlier version of the
deploy checklist said it did). `docs/OPS.md` step 4 now points at `scripts/prod-health.sh`, whose last
check is `GET /api/organizations?limit=1`.

**Wanted, now done**: `handleHealth` makes a cheap DO call (the DO's own `/health` answers `OK` after `init()`)
and reports `error` with a 503 when it fails, so monitors see a stuck ledger. It also triggers the DO's lazy init.

---

## CLI Parity Fixes - Implementation Findings (2026-10-16)

**Status**: Resolved in `agent/parity-cli-fixes` branch

- Promotion get: No GET /api/promotions/:id route exists (confirmed in workers/api/index.ts and workers/spec-do/index.ts) - removed command
- Health extended: Base URL appends /api, so /api/health became /api/api/health (404) - fixed to /health in api-client.ts:181
- Trial decide: API expects winnerId/comparisonMetrics, not winner/notes (workers/api/types.ts:446-448) - updated CLI
- Promotion create: API requires fromRung/toRung (workers/api/types.ts:522-523) - added required options
- Dead groups: No routes for workflow/deployment/environment (confirmed absent) - removed from ENTITIES
- Debug methods: No /api/debug/* routes (confirmed absent) - removed from api-client.ts
- Type mismatches: Aligned cli/src/types/api.ts with workers/api/types.ts

---

## Three workers did not redeploy on the Artifacts push (2026-10-16)

**Status**: Cause found (builds failed with `Could not resolve "zod"`), fix committed 2026-10-16 and verified in
clean copies; takes effect when pushed and deployed. Seen with `wrangler deployments list --name <worker>`.

**Finding**: seven workers (`beehive`, `-gate-workflow`, `-queue-consumer`, `-scientist-comparator`,
`-preview-manager`, `-candidate-service`, `-sandbox-runner`) each have two new deployments at 21:32 and 21:37 UTC.
`beehive-shadow-router`, `beehive-canary-worker` and `beehive-promotion-worker` have none: their newest
deployment is the 20:29 UTC secret change, and the code deployment before it is from 2026-10-15. `wrangler deploy
--dry-run` builds all three, so the config is not the cause. Workers Builds status is not visible through wrangler.

**Impact**: the old promotion worker sends no `X-Beehive-Internal`, so every call to the new Spec DO answers 401
(ledger, promotion mode); the old canary worker lacks deploy-ref canary logic; the old shadow-router does not follow
live canary refs. `scripts/prod-health.sh` passes anyway, because `/health` on each worker answers 200.

**Cause**: Workers Builds installs per worker (`npm install` in `workers/<name>/`). `promotion-worker` and
`canary-worker` import `workers/shared/promotion-ledger.ts` and `deploy-refs.ts`, and `shadow-router` imports
`deploy-refs.ts`; those shared files `import 'zod'`. Node resolves a bare import from the importing file's own
directory upward (`workers/shared/`, `workers/`, repo root), never from the importing worker's `node_modules`, so a
per-worker `zod` cannot satisfy it. The seven workers that built import only zod-free shared files (`auth`,
`spec-do-auth`) and import zod from their own folder. `beehive` builds from the repo root, where `zod` is installed.
Every local check missed it: the repo-root `node_modules` supplies zod to everything.

**Fix**: `workers/shared/package.json` declares `zod`; `promotion-worker`, `canary-worker` and `shadow-router` (which
had no `package.json`) run `npm install --prefix ../shared` in a `postinstall`, so a per-worker install also installs
zod where the shared files resolve it. Verified: `git archive` into a clean directory, `npm install` in the worker
folder only, `wrangler deploy --dry-run` builds all three. Rejected: a wrangler `[alias]` to `./node_modules/zod` (builds
in a checkout without per-worker installs, i.e. local `wrangler dev` and the e2e start script, fail with `Cannot find
module`), and `file:../shared` (npm puts zod in the worker, not in `workers/shared`). Assumes Workers Builds runs
lifecycle scripts (the default). Alternative if it does not: set those three builds' root directory to the repo root.

**Next**: after the push, check `wrangler deployments list` shows a code deployment newer than the push for all ten.
**Want**: a CI step that builds each worker from a clean per-worker install, since nothing else catches this.

---

## Review of 39a2669 (repo-level issue pages + promotion-mode persistence) (2026-10-17)

**Status**: Reviewed after it shipped unreviewed with the agent stack. Persistence half is fine; the UI half is
unreachable code with six defects. Evidence is from reading the code and evaluating the route regexes; the handler
was not run end to end (a scratch harness kept redirecting to `/login`, cause not found).

**Correction and resolution (2026-10-17, M8 PR 2, `agent/m8-issues-ui`)**: this review undercounted and is now superseded.
`docs/M8-UI-ISSUES-PLAN.md` section 1 lists 14 defects, not six. Corrections to the list below:
- Defect 2 (comments route) had already been fixed in `3790070`; what remained was the success redirect to `/app`, a form
  action without the repo, and a missing `success` read as OK.
- Defect 3: the filtered `/api/issues?repositoryId=` call was never reached in the UI tests (the stub throws `BLOCKED` on it);
  whether production returned empty for it was not checked. The number is now assigned by the Spec DO (M8 PR 1), so the UI
  sends none.
- Defect 6 counted four copies of the repo lookup; there were five (plus a sixth URL builder in the dashboard).
- Missed: link text was `getName(issue)` (issues have `title`), so the repo-tab and spec-page links rendered empty; private
  issues showed on the detail page; `issues.status` was never written, so nothing could close or reopen an issue.
- "Dead code with no production exposure" held only until the next deploy of the pre-fix code; it is now reachable code, on `main`
  once PR 2 merges and live only after the maintainer's push to the Artifacts repo.
- "Not run end to end": it is now. `workers/api/tests/ui-issues.test.ts` runs `handleUi` against the real Spec DO, and
  `tests/e2e/ui-issues.test.ts` runs it against the local workers (`docs/SETUP.md` "Local e2e status").
Routes are now matched before the repo routes by `workers/api/ui-repo-ref.ts`; the lookup is one helper; `GET /app/issues/:id`
302s to the canonical repo URL. Known gap left on purpose: `doReader.get` maps a DO catch-all 404 to "not found" (404 page, not 502),
pinned by a test so the follow-up (a distinct entity-404 error) has a target.

**Promotion-mode persistence (fine)**: `/promotion-mode` GET/POST on the Spec DO, `setPromotionMode` validates the
value server-side, tier-1 auth guards it, 122 lines of tests (`workers/promotion-worker/tests/mode-persistence.test.ts`).

**UI repo-issue pages (`workers/api/ui.ts`)**:
1. **Unreachable.** The three issue routes (`/issues`, `/issues/new`, `/issues/:id`) sit inside the existing
   `if (repoHierarchicalMatch)` block, whose regex `^/app/repos/([^/]+)/([^/]+)(?:/([^/]+))?$` allows at most three
   segments. `/app/repos/acme/acme/widgets/issues` (and `/issues/new`, `/issues/:id`) do not match it, so the inner
   code never runs; the 2-part form `/app/repos/acme/widgets/issues` matches as repo `issues` and answers
   "Repository not found". They need their own top-level matches before the repo route.
2. **Comments cannot work.** `createIssueComment` posts to `/api/issue_comments`; the DO serves only
   `/api/issues/:id/comments` (also in `docs/FEATURE-PARITY.md`).
3. **Issue numbers.** `createIssue` takes `max(number) + 1` from a 500-row list and sends it as `number`: not atomic
   (two creates get the same number) and wrong past 500. It also makes a filtered call (`/api/issues?repositoryId=`),
   which the UI's own rule R1/R3 forbids because filtered routes returned empty in production (bind-order bug); if that
   holds for issues, every issue is numbered 1. Unverified for issues.
4. **Broken redirect.** `redirect(`${repoUrl}/issues?ok=Created issue #${n}`)` is unencoded: `#` starts a fragment and
   the message is cut off. `back()` encodes; this one does not.
5. **Not scoped.** `issuePage(issueId, ...)` resolves the repo from the URL and then ignores it, so any issue id renders
   under any repo's URL.
6. **Duplication.** The org/namespace/repo resolution is copied four times (three routes plus `createIssue`).
No tests cover any of it.

**Not fixed here**: `agent/parity-ui` is editing `ui.ts` (M8: comments route, `doReader` swallowing errors), so these go
to that work to avoid a conflict. Until then the pages are dead code with no production exposure.


## Issue writes trust a client-asserted actor until a user-bound token exists (2026-10-17)

**Status**: Open - proposal only, needs a human (spine; overlaps M3/M6.2 capability minting).

**Done (M8 PR 1, `agent/m8-issues-do`)**: the Spec DO resolves the `X-Actor-ID` header against the `actors` table for issue create, comment, status and comment-policy. An unknown id, `unknown` (no header) and any service-account actor get 403 (`requireIssueActor`, `workers/spec-do/index.ts`). Maintainer status stays ledger-global `actors.role` (`isMaintainer`), service actors excluded. UI requests derive the actor from the signed session, never from a form field (`workers/api/tests/ui-actor.test.ts`); a session whose actor row is gone is sent to `/login`, and a first login creates the row (`ensureActor`).

**Remaining limit**: `authenticate()` (`workers/api/principal.ts:36-109`) knows only the master token, whose actor is the client-sent `X-Actor-ID` (line 44), and read-only service tokens. A master-token holder can therefore still act as any existing actor id (including a maintainer) on these routes. The CLI sends no actor on `issue create`, so it now gets an explicit 403 (it used to fail on the `created_by` foreign key with a 500).

**Proposal (not built)**: a user-bound API token (`kind: 'user'`). Minted by an authenticated UI session (settings page) or by a maintainer for a named actor; stored hashed like `service_tokens` (`workers/shared/service-tokens.ts`), with a `user_tokens` table keyed to `actors.id`, scopes `read`/`write`, expiry and revoke. `authenticate()` would look the hash up in the Spec DO and return `{ kind: 'user', actorId, scopes }`, with the edge rewriting `X-Actor-ID` from it exactly as it does for service tokens (`workers/api/index.ts:100-105`), so the header is no longer client-asserted for these callers; the CLI would send the token and drop `--actor`. Open points: which routes `write` scope covers; whether a user token may ever carry `maintainer` (`isMaintainer` reads the actor, so it would); overlap with capability tokens in M3/M6.2; a new table is a schema migration, so it needs the two-push method in `docs/M8-UI-ISSUES-PLAN.md` (plan branch `agent/ui-issues-plan-v2`) section 13.

**Addendum (2026-10-17, PR 1 review)**: first login is tested end to end (`workers/api/tests/ui-actor.test.ts`): the callback creates a plain `human` actor (no role, so not a maintainer), the session is accepted, and a second login reuses the row. Pre-existing limit: `ensureActor` (`workers/api/ui.ts:498`) and the per-request existence check (`ui.ts:119`) both read `/api/actors?limit=500&offset=0`. Beyond 500 actors a real user's row is not found, so every request bounces to `/login` and login creates a duplicate actor. Issue writes now depend on that lookup. Fix later with a by-id / by-github-id lookup route. Also noted: `PATCH /api/issues/:id/stage` still has no actor check (outside the plan).


## A schema version bump turns a rollback into an outage (2026-10-17)

**Status**: Open - hazard recorded; the safe method is in `docs/M8-UI-ISSUES-PLAN.md` section 13 (plan branch `agent/ui-issues-plan-v2`).

`runMigrations` throws `Unknown schema_version '<v>'` when the stored version is not in the code's own step list
(`workers/spec-do/index.ts:842`), and `init()` rethrows (`:499-506`), so every request fails. Therefore any change that bumps
`LATEST_SCHEMA_VERSION` (`:27`, `'m8'` today) makes rolling the Spec DO back to the previous code (AGENTS.md rule 7) an outage, not
a degraded mode. `docs/OPS.md` said only that this combination "is untested"; it is known to fail. m4-m8 shipped in one push, each step
additive and idempotent, with a read-only `schema_version` check before and after (`docs/OPS.md`); nothing in m3-m8 made them
rollback-safe. Safe method for the next bump (M11): push A first, with no bump, so `runMigrations` accepts an `m<N>` above the latest
it knows (log and continue, with a test); push B, only after A is live, adds the step. Not built.

**Also (M8 PR 2)**: no API sets an issue's `visibility`, so private issues cannot be made through the API, UI or CLI; the UI hides them
(404 on detail, comment, status and legacy routes) and that is covered by unit tests only, not the local e2e.

## Queue-consumer double-write prevention is unfinished (2026-10-19)

**Status**: Open - needs its own task; M5a closes the at-least-once double-write only for the eight `POST` routes in `IDEMPOTENT_ROUTES` (`workers/spec-do/index.ts`).

There is no real route for the queue consumer to protect. `workers/queue-consumer/index.ts` POSTs `/api/entities/candidate/:id/history`, but the Spec DO serves that path for GET only, so the call 404s and the consumer ignores the response (no `Response.ok` check). `workers/scientist-comparator/storage/spec-do.ts` likewise POSTs `/api/gate-verdicts/shadow`, which does not exist. Neither sends an `Idempotency-Key`. The fix is to add the real write routes (or repoint the callers), put them in `IDEMPOTENT_ROUTES`, send a key derived from the queue event id, and check `Response.ok`.

---

## Cloudflare Flagship for Beehive platform features (2026-10-18)

**Status**: Open - deferred, no immediate need

**Question**: Should Beehive adopt Cloudflare Flagship for gating platform-level features (new gate types, UI changes, promotion algorithms)?

**Context**: Flagship is Cloudflare's native feature flag service (built on KV + Durable Objects, OpenFeature-compatible) that enables sub-millisecond flag evaluation at the edge. It provides the workflow we want: default off, enable, ramp up, remove once full on.

**Assessment**: 
- **Not for the Oracle Ladder** - the ladder is Beehive's coordination spine; Flagship is a feature toggle utility, not a promotion system. Our existing Spec DO + dedicated workers handle candidate progression better.
- **Good fit for platform features** - useful when we have users and want to ship risky changes behind kill switches, A/B test new algorithms, or gradually roll out UI changes.
- **Zero integration overhead** - Beehive is Workers-native; Flagship integrates via a binding + OpenFeature SDK.

**Decision**: Deferred. With no users yet, the urgency is low. Hardcoded booleans or Spec DO config suffice for now. Revisit when broken deploys become costly.
