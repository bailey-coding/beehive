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

**Status**: Resolved on branch `agent/spine-item3-ledger-lifecycle` (2026-10-15), pending human
review and merge. Until it reaches `main`, production cleanup is still only possible by deleting
the Durable Object data out-of-band. See "2026-10-15: Ledger lifecycle" below and `docs/OPS.md`.

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

**Status**: Open on `main`; **superseded on branch `agent/spine-item3-ledger-lifecycle`**, which builds tombstones and purge (see "2026-10-15: Ledger lifecycle" above). The text below describes `main` as verified 2026-10-15: no tombstone, soft-delete, purge, or ledger `DELETE` code in `workers/` (the only `DELETE` calls are preview-manager's Cloudflare Builds API calls in `workers/preview-manager/builds.ts`).

**Finding**: The ledger cannot be cleaned up through the platform. The root cause is in [Spec DO ledger has no delete routes (2026-10-13)](#spec-do-ledger-has-no-delete-routes-2026-10-13). This entry tracks the missing lifecycle work that would fix it. The M1 "Ledger lifecycle" item in `docs/MILESTONES.md` (tombstones for specs and candidates, plus an authenticated admin purge route) is still unbuilt. `docs/FOCUS.md` lists it as open.

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
- **Skipped (`it.skip`):** `should get traffic split metrics` (`/shadow/splits`): the shadow
  router has no traffic-split metrics route. Needs a route or deletion. (Deleted on
  `agent/canary-rollback`; see "2026-10-16: Canary deploy and rollback".)
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
  would delay a rollback); one DO read per request. **Not built anywhere:** serving real user
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
