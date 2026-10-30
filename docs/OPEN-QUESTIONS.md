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
- **Workers Versions API: verified 2026-10-24 (spike on a throwaway worker, since deleted).**
  Docs (cloudflare MCP) plus real calls against `beehive-versions-spike` only.
  - **(a) Version from built code: yes.** `POST /accounts/{acct}/workers/scripts/{name}/versions`
    (multipart: `metadata` JSON part with `main_module`, `compatibility_date`, `bindings`,
    `annotations`; one part per module, `application/javascript+module`) uploads WITHOUT deploying.
    It needs the built modules, not a commit: nothing here builds a candidate, so a bundle source is
    still unwired (below). `annotations`: `workers/tag` (<=100 B), `workers/commit_sha` (<=64 B),
    `workers/message`. Response `result`: `{id (uuid), number, metadata{has_preview,...}, annotations, resources}`.
    **The first upload of a Worker cannot be a version upload**: 404, code 10007 "This Worker does
    not exist". Use `PUT .../scripts/{name}` (creates v1 AND a 100% deployment; `result.deployment_id`
    is v1's id as undashed 32-hex). New Workers have no version URL until
    `POST .../scripts/{name}/subdomain {"enabled":true,"previews_enabled":true}` (set explicitly).
  - **(b) Switch / split: yes.** `POST .../scripts/{name}/deployments`
    `{"strategy":"percentage","versions":[{"version_id","percentage"}]}` (percentage 0.01-100, must total
    100 within 1e-6, else 400 code 10210; 0% is rejected, so a 0% "dark" entry is not expressible
    this way). Returns `{id}`. Only the last 100 uploaded versions are deployable. Observed: 50/50 gave
    9 v1 / 7 v2 in 16 requests; a switch to 100% v2 was visible on the next request, but **one request
    after the switch still hit v1**: fast (seconds), not atomic. Rollback = another deployment (~1.1 s per call).
  - **(c) Auth/limits.** Token: "Workers Scripts Write" (upload, deployments, subdomain); read needs
    "Workers Scripts Read". Wrangler OAuth `workers (write)` sufficed. Rate limit: global 1200 requests
    / 5 min per token, 429 beyond, then blocked 5 min (docs, fundamentals/api/reference/limits); no
    Workers-specific limit documented. Calls took 0.9-1.2 s each. Not exercised: 429 behavior, quotas on
    number of Workers per account.
  - **(d) Version URLs.** `https://<first 8 hex of version id>-<worker>.<subdomain>.workers.dev`
    (confirmed: `1496f34f-...` served v2 with 200 while the deployment was elsewhere). Label
    `<8>-<worker>` must be <=63 chars. Public unless Cloudflare Access is added; not generated for
    Workers with Durable Objects, Containers/Sandbox, or Workers for Platforms user Workers (candidate
    services are stateless, so fine); no logs for version URLs. The header
    `Cloudflare-Workers-Version-Overrides: <worker>="<version-id>"` (confirmed) also pins a version on
    the normal URL. A version URL works for a non-deployed version, so canary needs no deployment
    switch: the ref names the version and the router targets its URL.
  - **Mapping.** `ApiWorkerVersionsClient` (`workers/preview-manager/versions.ts`, mode
    `WORKER_VERSIONS_MODE=api`) implements `createVersion` as: POST versions; on 10007 PUT script then
    enable subdomain; URL from the id prefix. `setDeployment` wraps the deployments call (not part of the
    interface; unused by the ref-driven path). Mocked-fetch tests in `tests/versions.test.ts`; the
    real-API shapes above came from the spike, but the client code itself was never run live.
  - **Unverified.** 429 behavior; behavior of `bindings` other than none (a candidate needing KV/DO
    bindings; `inherit` bindings only resolve against the latest uploaded version); propagation bound of
    a switch (saw one stale request); whether `previews_enabled` is needed on top of workers.dev being
    on (set explicitly, not tested without); wrangler-free multi-module / wasm uploads; where the built
    bundle comes from.
  - **Human wiring needed (not done; spine/promotion path).** (1) a `CandidateBundleSource`
    passed as 2nd arg of `workerVersionsClientFor(env, bundle)` in `workers/preview-manager/index.ts`
    (fetch built output of the candidate commit, e.g. from the Workers Builds artifact or Artifacts
    repo); (2) set `WORKER_VERSIONS_MODE=api`, `CLOUDFLARE_API_TOKEN` (Workers Scripts Write) and
    `WORKERS_SUBDOMAIN` on preview-manager (`CLOUDFLARE_ACCOUNT_ID` is already typed); (3) the route's
    `versionsClient` field now may be `'api'`; (4) cleanup of `beehive-candidate-*` Workers on purge
    (nothing deletes them). Default unchanged: unset mode answers 501.
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

**Status**: Resolved - implemented in agent/m5a-idempotency-fix

The three blocking issues identified by agent 621993c have been addressed:

1. **scientist-comparator route fix**: Changed POST from `/api/gate-verdicts/shadow` to `/api/gate-verdicts` with `gate: 'shadow'` in the body (matches existing Spec DO route).

2. **Entity history POST route**: Added POST support for `/api/entities/:entity_type/:entity_id/history` in Spec DO, with the route pattern added to `IDEMPOTENT_ROUTES`.

3. **queue-consumer actor**: Added 'queue-consumer' actor of type 'agent' to the seed data in `workers/spec-do/seed.ts`, allowing FK references to `changed_by` in entity_history.

The queue-consumer now sends `Idempotency-Key: ${queueName}:${event.id}` header for history writes and properly handles response status (treats 409 as already-processed, not an error).

M5a now closes the at-least-once double-write for all nine POST routes in `IDEMPOTENT_ROUTES`.

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

## 2026-10-30: promotion worker calls a gate route that does not exist

`workers/promotion-worker/merge-train.ts:342` calls `GATE_WORKFLOW.fetch('/run', ...)` with a relative URL, and the gate worker has no `/run` route (only `/gates/pre-merge`, status and result routes), so the call answers 404. Found while reviewing `docs/M5A-2-IMPL-PLAN.md`; not changed there. Same class as the three nonexistent DO routes of 2026-10-16: check `Response.ok` and decide whether the merge train should call `/gates/pre-merge`.

**Status**: Open.

## Sandbox build spike: containers deploy and build work (2026-10-24)

Phase 0 of `docs/SANDBOX-BUILD-PLAN.md`, run by the maintainer-approved `wrangler deploy` of a throwaway worker
`beehive-sandbox-spike` (SDK 0.x `@cloudflare/sandbox@0.12.14`, image `docker.io/cloudflare/sandbox:0.12.14`, `lite`,
`max_instances = 1`). The worker and its container application were deleted afterwards; the ten production workers were not touched.

- **Containers are entitled on the account.** The first `wrangler deploy` created the container application directly.
- **No local Docker is needed for a registry image.** This host has no `docker`; a `docker.io/...` image reference deployed
  fine. A `./Dockerfile` image does need Docker (or Workers Builds). **Still unanswered (U1):** whether the Artifacts push
  deploy flow builds a Dockerfile image; the registry-image route avoids the question for the 0.x SDK.
- **The container has node v22, git 2.34.1 and npm 10.9.** `npx esbuild@0.25.0 src/index.js --bundle --format=esm` produced a
  112-byte ESM bundle that `sandbox.readFile` returned.
- **Timing:** first request (cold container, includes provisioning) ~57 s; `npx esbuild` with a fresh npm fetch ~28 s; a warm
  `exec` ~5 s over the default HTTP transport. Preinstall esbuild in the image and keep builds off request paths with a timeout.
- Not tried: SDK 1.0 (needs a `Dockerfile` copying `sandbox-shim`, so Docker or Workers Builds), cloning from an Artifacts
  repo (U3), outbound-handler credential injection, snapshots, cost at volume.

### Sandbox build spike, part 2: U1 and U3 (2026-10-24)

- **U3 verified: a sandbox can clone an Artifacts repo at an exact commit.** Throwaway repo `beehive-sandbox-spike` in namespace
  `default` (one commit pushed with a short-lived write token), a 30-minute **read** token passed to the sandbox as
  an `exec` `env` value, and `git -c http.extraHeader="Authorization: Bearer $ART_TOKEN" clone https://<account>.artifacts.cloudflare.net/git/default/<repo>.git`
  followed by `git checkout <40-hex sha>` returned the right commit and file in ~35 s cold. The token was not found in `.git/` afterwards.
  Design consequence: pass the token only to the clone `exec`, and run the build in a separate `exec` without it. The repo, the
  token (expired anyway), the worker and its container application were deleted; the ten production workers were not touched.
  Not tried: the SDK 1.0 outbound handler that injects credentials per hostname.
- **U1 VERIFIED later the same day (see "U1 result" below); the paragraph that follows is the earlier docs-only reasoning.**
  **U1 was not verified empirically at this point; the docs said yes.** Production deploys are Workers Builds per worker (`docs/OPS.md`
  "Workers Builds watch paths"). Cloudflare documents that `wrangler deploy` in Workers Builds builds and publishes container
  images (only `wrangler versions upload`, the non-production default, does not). So a Dockerfile image should build on the
  push. The only real test is to deploy a Dockerfile-based worker through that flow, which deploys all ten; do it with the first
  real Phase 1 change and watch that worker's Builds log. A registry image (`docker.io/cloudflare/sandbox:0.12.14`) needs no
  Docker at all and was verified.
- **Constraint found in the docs:** Workers that implement Durable Objects (including Containers) get no version URLs
  and non-production Workers Builds runs create a version but do not roll out a new image, so the sandbox-runner must be
  deployed via the production branch's `wrangler deploy`, as today.

### U1 result: the push deploy builds a Dockerfile image (2026-10-24)

Pushing `35e8eec` to `cf` (which added `workers/sandbox-runner/Dockerfile`, a `[[containers]]` block with `image = "./Dockerfile"`,
a `SANDBOX` Durable Object binding and migration `v1`) made Workers Builds run `wrangler deploy` for `beehive-sandbox-runner`:
the worker redeployed at 18:56:28Z and container application `beehive-sandbox-runner-sandbox` appeared (`ready`, 0 instances) at
18:56:46Z. `GET /sandbox/probe` (authenticated) then returned `{"success":true,"stdout":"v22.23.4\n0.25.0"}`: esbuild 0.25.0 is
installed only by the Dockerfile's `RUN npm install -g esbuild@0.25.0`, so the image built in Workers Builds is the one running.
No local Docker was involved. Sandbox SDK 1.0 (which needs a Dockerfile) is therefore deployable too.
Two gotchas found on the way:
- CI `npm run typecheck` resolves imports from the **root** `node_modules`: `@cloudflare/sandbox` had to be added to the root
  `package.json` (a per-worker dependency alone fails with TS2307). vitest cannot load the SDK (`cloudflare:workers`), so tests
  `vi.mock('@cloudflare/sandbox')`.
- **Deleting `[triggers]` does not remove an existing cron.** After `35e8eec` the canary worker's `* * * * *` schedule kept firing
  and every invocation threw "Handler does not export a scheduled() function" until `crons = []` is deployed (`3908e42`).

### Sandbox build on the container DO API works in production (2026-10-25)

`beehive-sandbox-runner` now runs `BuildSandbox` (Durable Object driving `ctx.container`, the Sandbox SDK 1.0 model, no
`@cloudflare/sandbox` package) with `ArtifactsGateway` as the outbound intercept. Deployed by the push to `cf` (`7733d4b`).
- **Verified live:** `GET /sandbox/probe` returns node v24.22.1, esbuild 0.25.0, git 2.47.3 (the Dockerfile image).
  `POST /sandbox/build {repo, commitSha}` against a throwaway Artifacts repo with `src/index.ts` + `src/helper.ts` cloned the exact
  commit through the intercept (the container has no Internet and never holds a token), bundled it with esbuild and returned the
  ESM module. Error paths: malformed commit 400 `BAD_REQUEST`; missing repo 502 `CLONE_FAILED` ("Empty reply from server");
  unknown commit 502 `CLONE_FAILED`. The throwaway repo was deleted. The `.env` `CLOUDFLARE_API_TOKEN` (set as a secret on the
  worker) has Artifacts scope.
- **Not tried:** a `dist/index.js` prebuilt path in production, the 60 s build timeout, the 1 MiB cap, concurrent builds, cold-start
  timing of `/sandbox/build` (it completed within one 200 s request), cost at volume, a candidate that imports npm packages (there is
  no `npm install`, so it fails at the bundle step by design).
- **Gotcha 1: a `deleted` tombstone fails while the live worker binds the class** (build log, code 10086: "Cannot delete the Durable
  Object namespace ... still referenced by the binding"). Re-pointing the binding and deleting the class in one deploy is not
  allowed. Fix used: `state = "renamed"`, `renamed_to = "BuildSandbox"` (namespace and binding carry over; the old class held no data).
- **Gotcha 2: the old 0.x container application is not removed by the deploy.** Delete it by hand
  (`wrangler containers delete <id>`, id from `wrangler containers list`) before the deploy that moves the class to a new container config.
- **Gotcha 3: `crons = []` clears the schedule, but the scheduler lags.** `GET .../schedules` returned `[]` immediately, yet the
  minute cron kept firing (and throwing) for ~10 minutes after the deploy; it stopped without further action.
- **Gotcha 4: Workers Builds termination was transient.** The ten builds for `34c1864` were terminated after ~5.5 minutes with no log;
  the next push (`22149a3`) built nine workers in about a minute each. The sandbox-runner build (with the Docker image) takes ~2 minutes.

### Sandbox build review fixes verified live (2026-10-25)

A Sonnet review (10 should-fix items, no blockers) led to `bb1ec51` (deployed by the push to `cf`): symlinks disabled at checkout, builds
serialized per Durable Object instance, an alarm backstop and a 150 s deadline, a hardened `ArtifactsGateway` (one read token minted per build
and passed in props, redirects refused, header allowlist, exact query, props validated), scrubbed error text, `--tsconfig-raw={}`, a
digest-pinned non-root image. Live checks against throwaway repos (deleted afterwards):
- **Non-root image works:** probe returns node v24.22.1, esbuild 0.25.0, git 2.47.3; a clone through the intercept and an esbuild bundle of
  `src/index.ts` succeeded in ~1.6 s warm (the container could read the CA file and write `/workspace` as `node`).
- **The error code survives the RPC hop:** a repo with only a README returned HTTP 422 `{"code":"NO_ENTRY"}` (the message prefix is preserved,
  so `parseBuildError` works; the reviewer's main uncovered risk).
- **Symlinks are neutralized:** a commit with `dist/index.js -> /usr/local/bin/node` was checked out as a plain 19-byte file holding the path
  text, so no read of the real file happened. It is returned as a `prebuilt` bundle, which the version upload will reject as invalid JavaScript.
- **Concurrency:** three parallel builds of one commit all returned 200, ~1.5 s, ~3.5 s and ~4.5 s: they ran one after another.
- **Not tried live:** the 150 s deadline and the alarm backstop (unit-tested with fakes only), a DO restart mid-build, the 60 s esbuild and
  30 s checkout timeouts, a bundle over 1 MiB, commits reachable only from `scratch/*` refs (checkout fails with "the commit was not found;
  only commits reachable from the repository branches or tags can be built"), cost at volume.
- **Known limits, by design:** an `import` of an absolute path in candidate source makes esbuild bundle that container file (the container holds
  no secrets); a committed `dist/index.js` silently takes precedence over `src/` (the bundle reports `source: prebuilt`).

### Sandbox Phase 2: preview-manager builds through the sandbox runner (2026-10-25)

`workers/preview-manager` now builds a candidate commit through the service binding `SANDBOX_RUNNER` -> `beehive-sandbox-runner`
(`bundle-source.ts`, zod-checked, `Response.ok`-checked) and uploads it with the api Versions client. Production still answers 501 until
`WORKER_VERSIONS_MODE=api`. A Sonnet review (no blockers) led to these rules, all unit-tested:
- **Safety:** a candidate id must be a UUID in api mode, and `RESERVED_WORKER_NAMES` (the ten platform workers) are refused by the shared name check.
  Without them a candidate id `service` would have uploaded a version to, or deleted, the production `beehive-candidate-service` worker.
- **Ledger:** api mode needs the candidate and its repository in the ledger; the repo name comes from `GET /api/repositories/:id`. The repo's
  recorded `namespace` must equal `ARTIFACTS_NAMESPACE` (default `default`, the namespace the runner reads), else 422. (Superseded 2026-10-25: the namespace is sent per request, see SF-8.)
- **Errors:** candidate-attributable runner codes (`BAD_REQUEST`, `NO_ENTRY`, `BUILD_FAILED`, `TOO_LARGE`) keep their 4xx; a runner 401/403/404/429/500
  becomes 502, 503/504 stay, so an infrastructure fault never looks like a missing candidate.
- **Timeouts and retries:** the build call aborts after 320 s (two runner deadlines). The runner coalesces repeat builds of the same `repo@commit`, so a
  retry after a caller's timeout joins the running build instead of queueing another.
- **Built file check:** the main module must start an `export` statement, which catches a checked-out symlink (a text file holding a path).
- **DELETE `/api/preview/canary/:candidateId`** deletes `beehive-candidate-<uuid>` (api mode only); it refuses while the candidate has a `deployed`
  canary (409) and when that check fails (502). **It is not called by anything yet** (no purge hook; purge is a spine path in `beehive`), so it is
  dead code until the maintainer decides how purge triggers it.
- **Known gap, unverified:** if two uploads for one candidate worker race (for example two different callers), both can take the first-upload path and
  create two versions/deployments; coalescing makes this unlikely for retries but not impossible. Not tested against the real API.

### Preview-manager deploy failure: `Could not resolve "zod"` from workers/shared (2026-10-25)

The first Phase 2 push failed only for `beehive-preview-manager` (build `120736d4`, 22 s): the worker started importing `workers/shared/deploy-refs.ts`
(the live-canary guard of the DELETE route), which imports `zod`, and Node/esbuild resolve a shared file's imports from `workers/shared` upward, never from
the importing worker's `node_modules`. Fix: the worker's `postinstall` installs `workers/shared`'s dependencies (`npm install --prefix ../shared ...`),
as `canary-worker` and `sandbox-runner` already did (`21bea5a`). Reproduced in a clean worktree: `wrangler deploy --dry-run` fails without the
postinstall and bundles with it. Neither unit tests, `tsc` nor CI Enhanced catch this (local `shared/node_modules` hides it; CI Enhanced only checks
that installs succeed). A `wrangler deploy --dry-run` per worker in a clean install in CI Enhanced would (sandbox-runner needs Docker for its container build).

### First real canary through the sandbox build (2026-10-25, `e6f6948`)

`WORKER_VERSIONS_MODE = "api"` is set in `workers/preview-manager/wrangler.toml` (maintainer-approved Phase 3; remove the line and push to turn it off:
the canary route then answers 501 again). A throwaway candidate was run end to end against production:
1. Artifacts repo with `src/index.ts` + `src/helper.ts` (TypeScript, one import), ledger actor/org (`test-org-e2e-sbx-...`)/repository (`candidate`,
   namespace `default`)/spec/candidate with the full 40-hex commit.
2. `POST /deploy-canary` on the canary worker: **200 in 6.9 s**. The preview-manager read the candidate and its repository from the ledger, the sandbox
   runner cloned and bundled the commit, the api client created Worker `beehive-candidate-<uuid>` and its version (first-upload path, `PUT` + subdomain enable),
   the canary worker moved the canary deploy ref and recorded the deployment (`status: deployed`).
3. The version URL `https://<8 hex>-beehive-candidate-<uuid>.bz23711.workers.dev` answered 200 `hello from beehive sandbox e2e`: the bundled TypeScript.
   The token on the preview-manager has Workers Scripts:Edit.
4. `DELETE /api/preview/canary/<id>` while the canary was live: **409** (guard works). `POST /rollback` (manual): deployment `rolled_back` (a ref move, no
   redeploy). The DELETE then returned `deleted: true`, and the version URL answered 404.
5. Cleanup: org tombstoned (cascade: 1 org, 1 repo, 1 spec, 1 candidate), Artifacts repo deleted. **Left behind:** the tombstoned org (purge needs
   `PURGE_MIN_AGE_HOURS` = 24 h and a maintainer) and one actor `e2e-sbx-probe-actor` (`acaf5d73-b21e-48b2-8e7d-4a47556262b7`), created by a probe call.
Not exercised: the alarm-driven SLO tick with a live canary (the canary was rolled back within minutes; `canary-slo-ticks` consumption was not observed),
shadow traffic reaching the canary URL, a second upload to an existing candidate Worker (the plain `POST /versions` path against the real API), and
concurrent callers.

### The shadow router never reached candidates: workers.dev error 1042 (2026-10-25)

Found while running a longer canary against production (alarm ticks, shadow traffic, SLO loop). **What worked:** the Spec DO alarm armed 60 s after
the canary deploy; `canary-slo-ticks` messages were consumed every ~61 s (`canary_slo_cycle`, `checked: 1`); after a rollback the next alarm found no
live canary and the chain stopped (no ticks for 2+ minutes); `slo-status` showed `healthy` with real numbers (105 requests, p95 50 ms, 0 errors).
**What did not:** a candidate that answers HTTP 500 to everything was still recorded as `healthy` with 98 then 206 requests and **0 errors**.
- **Cause:** the shadow router mirrors with `fetch('https://<ver>-beehive-candidate-<uuid>.bz23711.workers.dev/...')`. A Worker's global `fetch()` to
  another Worker on the same account's `workers.dev` is blocked by default and answered `404` with body `error code: 1042`. Verified with a probe
  Worker: it received `{"status":404,"body":"error code: 1042"}` for the very URL that answers `500 simulated failure` when called directly. A 404 is
  not a 5xx, so the recorder counted every mirrored request as a success. The same holds for the baseline target `beehive-main`.
  So mirroring, Scientist comparison and the SLO verdict all saw 404s in production; none of it ever ran against candidate code.
- **Fix:** compatibility flag `global_fetch_strictly_public` on `beehive-shadow-router` (the documented remedy; the probe Worker then received the
  candidate's real 500). **Companion fix, required before the flag ships:** the router forwarded every incoming header to candidate URLs, including the
  caller's `Authorization` (the platform bearer token), cookies and `X-Actor-ID`; once mirroring really reaches candidates that would hand credentials to
  agent-written code. `candidate-headers.ts` now sends candidates only `accept`, `accept-language`, `content-type`, `user-agent`, `x-request-id`; the
  trusted baseline (`beehive-main`) keeps the original headers. Tests: `tests/candidate-headers.test.ts` (unit + through the handler).
- **Related, by design but worth knowing:** the recorder counts only `status >= 500` as an error, so a candidate that answers 4xx to everything (for
  example one that requires auth) is `healthy`. Unflushed tail: the recorder flushes only when another sample is added (20 samples or 10 s since the
  first), so a short burst leaves its last <20 samples unsent until the next canary request; with the default 1% top-level canary split a few hundred
  requests produce too few samples to verdict. Candidate URLs are chosen by a hash of the request URL, so a test can pick URLs that land in the split.
- **Throwaway resources:** two test candidates and their Workers (`beehive-candidate-<uuid>`), org `test-org-e2e-sbx-1792918848` (tombstoned, purge after
  24 h), Artifacts repo (deleted), probe Worker `beehive-fetch-probe-tmp` (deleted). Left: actor `e2e-sbx-probe-actor`.

### Shadow router fix verified: a failing canary is rolled back by the loop (2026-10-25, `4bfba1e`)

Deployed by the push to `cf` (compat flag `global_fetch_strictly_public` on `beehive-shadow-router` confirmed in the worker settings, header allowlist for
candidates). Re-ran the failing-canary test against production with a candidate whose second commit answers HTTP 500 to everything:
- Canary deployed at 10:28:32 with `autoRollback: true`; 119 URLs from the 0.5% hash range sent through the shadow router (after the version URL had
  ~25 s to propagate). `slo-status`: **`violation`, errorRate 1, 101 requests, `error_rate`**. (Before the fix the same candidate read `healthy`, 0 errors.)
- The queue tick at **10:30:39** logged `canary_slo_cycle ... rolledBack: [<deployment id>]` (the earlier tick at 10:29:39 saw too few flushed samples:
  `rolledBack: []`). The deployment record: `status: rolled_back`, `rollbackReason: error_rate`, `updatedAt` 10:30:40, about two minutes after deploy,
  with no human call. No tick followed (chain stopped); the live-canary list was empty.
- Cleanup: Worker deleted through the DELETE route, org tombstoned (cascade 1 org/repo/spec/candidate), Artifacts repo deleted, health green.
- **Not verified live:** that the candidate no longer receives `Authorization`/cookies (covered by `tests/candidate-headers.test.ts`; the candidate's
  response is discarded by the router, so there is no cheap live probe). The sandbox-runner redeploy of this push was still building its image when the
  test ran; its previous deployment served (identical code).
- First-minute caveat seen again: a Worker's version URL can take tens of seconds after its first upload before it serves; requests in that window are
  recorded with whatever the edge answered (with the old behavior always a 404). Give a new canary ~25 s before sending traffic.

### Canary metrics recorder: the tail of a burst is now flushed (2026-10-25)

`CanaryMetricsRecorder.shouldFlush()` was only asked when another sample was added, so the last <20 samples of a burst stayed in the isolate
(and were lost if it recycled): a live run of 119 canary-range requests recorded 98. Fix: `scheduleTailFlush()` hands `ctx.waitUntil` a one-shot
promise that waits `FLUSH_AFTER_MS` (10 s, inside the ~30 s the platform gives `waitUntil` work after the response) and then flushes whatever is
still pending; at most one is outstanding per isolate, it is a no-op if the count/age path already flushed, a failing or missing Spec DO is
swallowed, and the pending set is still taken before sending so nothing is sent twice. Tests: `canary-recorder.test.ts` (fake timers) and
`canary-wiring.test.ts` (through the handler; the tail test fails if the call in `recordCanaryMetrics` is removed). **Not verified live** (needs a deploy).
Note: a competing change (`scratch/mistral-recorder-flush`, a `setTimeout` that only cleared a field and still relied on the next sample) was not used:
it did not flush anything by itself.

### Review of the post-review changes and what it led to (2026-10-25)

A Sonnet review of `bb1ec51`, `b768300`..`3a8bdc1`, `e6f6948`/`4bfba1e` and the recorder tail flush found no blockers and eight should-fix items.
Fixed in the commit after `c0cfa86` (unit-tested; **not deployed**; the zombie-build and tail-flush tests were checked by mutation):
- **SF-1 request bodies reached only the first mirror target.** The router handed the same body stream to every target, so it locked after the first (the
  production baseline `beehive-main`, first in the map) and every canary after it was silently never called, with no sample recorded: a candidate that 500s
  every POST would have stayed `healthy`. The body is now read once (cap 1 MiB, larger bodies are not mirrored) and each target gets its own copy; a failure
  to build the request is now a recorded synthetic 5xx instead of a dropped promise.
- **SF-2 mirrored writes reached production with the caller's credentials.** With `global_fetch_strictly_public` the baseline mirror is real, and it
  carries the original headers. Non-`GET`/`HEAD` requests are no longer replayed against the baseline (candidates still get them). Nothing in the repo sends
  writes to the router; if something outside does, this is the safe default.
- **SF-3 a live canary ref could replace the baseline target.** The Spec DO accepts any `candidateId` and `url`, and the router trusted the id string
  `beehive-main` for full headers. `applyCanaryRefs` now ignores a ref whose id is a static target and one whose url is not `https://*.workers.dev`
  (no credentials in the url). **Closed 2026-10-25:** the Spec DO route now validates both (`CanaryDeployRequestSchema`: id is a plain token not starting with `beehive-`; url is https `*.workers.dev` without credentials; the shared `isAcceptableCanaryUrl`); the router keeps its own check for rows written before. Pinned to the account subdomain (`WORKERS_SUBDOMAIN`, a plain var on `beehive` and the shadow router; with the var unset any `*.workers.dev` still passes, so a worker deployed before its var exists keeps working). Not yet deployed at the time of writing.
- **SF-4 no timeout on the candidate fetch.** 10 s abort (a plain `setTimeout`, cleared in `finally`), recorded as a synthetic 5xx; `redirect: 'manual'`.
- **SF-5 an abandoned (deadline) build could act on the next build's container.** Each build now owns an identity token; every container step and the
  intercept registration check it, so leftover work throws instead.
- **SF-6 a hung `destroy()`/`setAlarm()`/`deleteAlarm()` blocked the serialized queue.** Each is abandoned after 10 s.
- **SF-7 samples added during an in-flight tail flush were stranded.** The "scheduled" flag is cleared when the timer fires, before the flush.
- Also: the Scientist queue message no longer persists `Authorization`/cookies; the gateway read-token TTL is 240 s (was 600).
**Left open on purpose:**
- **SF-8 namespace (resolved in code 2026-10-25, not yet deployed: `docs/SF-8-NAMESPACE-PLAN.md`; the runner takes the namespace per request and echoes it, `preview-manager` refuses a runner that does not echo it).** Was: fork-created candidate repos get `repositories.namespace = org.name` in the ledger (`spec-do/index.ts:1504`), while the runner and the
  preview-manager read `ARTIFACTS_NAMESPACE` (`default`). Such a candidate is refused with 422 on every canary deploy (fails closed). Decide whether the runner
  takes the namespace per request (widens which namespaces it can mint read tokens for) or the ledger records the real Artifacts namespace.
- **Local dev:** `global_fetch_strictly_public` blocks loopback/private targets, so mirroring to `http://localhost:8787` under `wrangler dev` probably stops;
  check at the next local e2e run. `BUILD_FAILED` is used for platform conditions (the 150 s deadline) as well as candidate faults and maps to 422; the
  `Dockerfile` digest should be confirmed as the multi-arch index digest; an `export` after a leading block comment on one line is missed by the heuristic.

### Review fixes deployed and verified: POST bodies reach canaries, the loop rolls back on them (2026-10-25, `ebb5c75`)

Pushed to `cf` (all ten builds succeeded; the sandbox-runner Worker code was live at 12:45Z, its container rollout step unchanged). Live test against
production with a candidate that answers HTTP 500 **only** to a POST whose body is exactly `fail-me` (and `ok` to GETs):
- Canary deployed 12:46:10 (`autoRollback: true`); 119 POSTs with body `fail-me` to URLs in the 0.5% hash range of `POST:<url>` sent through the shadow router.
- The first queue tick at **12:47:12** logged `canary_slo_cycle ... rolledBack: [<deployment id>]`; the record: `status: rolled_back`, `rollbackReason: error_rate`.
  Because the candidate only fails when the body arrives intact, this shows the SF-1 fix works in production: the body reaches the canary target and the SLO
  loop sees body-carrying traffic (before the fix the canary request was silently never made for any POST).
- Cleanup: Worker deleted through the DELETE route, org tombstoned (cascade 1 org/repo/spec/candidate), Artifacts repo deleted, health green.
- **Not verified live:** that the production baseline is no longer replayed for POSTs (unit-tested; nothing observable from outside), the 10 s candidate timeout,
  the abandoned-build guard and the bounded cleanup (unit tests with fakes only), SF-8 (still open). A first attempt at this test failed in setup, not in the
  product: `wrangler artifacts repos create` returned no repo once (transient), and the shell chain went on to register a candidate with an empty commit;
  the half-made org was tombstoned. Use `set -e` style checks in fixture scripts.

## 2026-10-26: Legacy-shape migration matrix findings (`workers/spec-do/tests/migration-matrix.test.ts`)

Found by running `SpecDO.init()` over the schema.sql of all 11 historical commits (plus synthetic m1/m2). No migration or schema code was changed (spine); both cases are pinned with `it.fails` so a fix flips them to red until the marker is removed.

1. **A fresh ledger lacks `candidates.preview_url`, `preview_worker_name`, `preview_created_at`; every migrated ledger has them.** The columns are added only by the m1 -> m2 step (`index.ts:1041`). `initSchema` (fresh path) runs `SCHEMA_SQL`, which has no such columns, then writes `schema_version = latest`, so the m2 step never runs. Confirmed: on a fresh ledger `updateCandidatePreview()` (`index.ts:1463`, route `PUT /api/candidates/:id/preview`) throws `no such column: preview_url`. Production is a migrated ledger, so it is not hit today; a new self-hosted or wiped ledger is (OPS.md "ledger wipe" recreates a fresh one). Fix is spine: add the columns to the fresh path (or to `schema.sql`/`schema-inline.ts` plus a migration-safe guard). Test: `it.fails('a fresh ledger has the candidates preview columns ...')`; A4 excludes those three columns so it still checks the rest.
2. **Ledgers from `d34db95` and `469389b` (m9 = `idempotency_keys`, no `user_tokens`) never get `user_tokens`.** On that line the code's `m9` created `idempotency_keys` and neither `schema.sql` nor the code had `user_tokens`; `98d43df` made `m9` = `user_tokens` and `m10` = `idempotency_keys`. A ledger stamped `m9` or `m10` by those commits skips the current `m9` step, so `user_tokens` is never created and every user-token route would fail `no such table`. Whether any deploy ever ran those commits is unknown to agents; the maintainer can answer with the T2 read-only query (`SELECT name FROM sqlite_master WHERE name = 'user_tokens'`, `docs/MIGRATION-LEGACY-TEST-PLAN.md` section 3) or from deploy history. Test: the A3/A4 cases for `m9-d34db95` and `m10-469389b` are `it.fails`.

Everything else passed for every start version (m1 with and without a `schema_version` row through m11): init reaches the latest version, no object or original column value is lost, a second init and a re-run of every step from every earlier version change nothing, and tables, columns and indexes equal a fresh ledger's (apart from finding 1).

## 2026-10-26: Artifacts fork and merge semantics for the MR flow (`docs/MR-FLOW-PLAN.md` §2, §8)

**Status:** Open. These are planning findings from the docs; nothing has been probed and no code depends on them yet.

- **The native fork API exists, and our client does not use it.** REST `POST /artifacts/namespaces/:ns/repos/:name/fork` and
  binding `repo.fork(name, {description, readOnly, defaultBranchOnly})` (developers.cloudflare.com/artifacts/api/rest-api,
  `/workers-binding`). `createFork` creates an empty repo, and its comment saying there is no "fork from"
  (`workers/shared/artifacts.ts:125`) is stale. `docs/ARTIFACTS-SETUP.md` has no fork section.
- **Forks stay in the source namespace.** The fork route takes only a name, no target namespace, so a fork lives in the org of its
  upstream.
- **A forking repo is not usable yet.** Listed repos carry `status` `ready | importing | forking`, and `get()` throws while the
  repo "is not ready yet". Callers must poll for `ready` (or retry `get()`) before handing out the remote or a token.
- **Doc mismatch:** the docs page marks the fork body's `name` as required, but the OpenAPI request body does not list it. Probe
  before relying on either.
- **No documented server-side merge, compare or ref-update API.** Refs change only over git, so a merge is a sandbox
  clone/merge/push.
- **Undocumented, to probe before MR slice 2:**
  - Is a non-fast-forward push accepted, and is `--force-with-lease` honoured?
  - Does any branch protection exist?
  - Are objects shared between a fork and its upstream, and what does a cross-repo fetch cost?
  - Can a fork be forked again?
  - Does a push to a fork emit the event shape the queue consumer parses?
- **Related:** the pre-merge gate is simulated (`workers/gate-workflow/index.ts:615-622`, `:725`, `:789`;
  `workers/sandbox-runner/index.ts:371-374`), and its verdict POST ignores `Response.ok` (`:865-875`). Every `gate_verdicts`
  row so far is synthetic, and a second run for a candidate violates UNIQUE(candidate_id, gate) unseen (`schema-inline.ts:144`).

## 2026-10-26: The shadow rung's declared-delta-surface check cannot work for any stored spec (found while planning `docs/SPEC-BACKTEST-PLAN.md`; code read, not run; nothing changed)

Three mismatches stack on the path Spec DO -> Scientist comparator:
1. **Stored shape.** `CreateSpecRequestSchema` takes `declaredDeltaSurface: string[]` (`workers/shared/schemas.ts:138`) and the Spec DO stores `JSON.stringify(array)` (`workers/spec-do/index.ts:1336`). The comparator's `parseDeltaSurface` wants one object with a `version` field (`delta-surface/parser.ts:57-59`, `:66`), so an array fails with "missing required version" even if it reached the parser unwrapped.
2. **Envelope and casing.** `GET /api/specs/:id` answers `{ success, data: { ..., declared_delta_surface } }` (`index.ts:3890`; snake_case from the row mapper at `:1941`). `SpecDOClient.getSpec` returns that whole envelope unchanged (`scientist-comparator/storage/spec-do.ts:49-50`), so `spec.declaredDeltaSurface` at `scientist-comparator/index.ts:208` is `undefined` and `parseDeltaSurface(undefined)` throws "must be an object" (`parser.ts:57-59`). The default surface is used only when the spec is not found.
3. **Blast radius.** The throw is inside the `Promise.all` over a message's candidates, so one existing spec fails that whole comparison. The queue handler catches and logs it (`index.ts:129`; its comment says "will trigger retry", but as read the handler returns normally and never calls `retry()`), so no verdict is recorded for the message. `workers/scientist-comparator/tests/scientist.test.ts` has no case with a spec-backed delta surface, so nothing covers this. The gate workflow reads `declaredDeltaSurface` from the same snake_case response (`gate-workflow/index.ts:720`) and always gets `[]`; it only feeds a simulated complexity number.

Not yet tried: a live comparison with a spec that has a surface (production has not been touched). **Consequence for the backtest:** the shadow rung's delta check cannot be used as is, and not even as a fixed reference to compare against. The backtest harness computes its own delta check (spec JSON object in, response diff out, optionally reusing `delta-surface/matcher.ts` once unit-checked in isolation). Fixing the path (spine-adjacent: one agreed shape for `declaredDeltaSurface`, unwrap `data`, map the field name, a comparator test with a real surface) is a separate human-approved item.

## 2026-10-27: m12 unique index on `actors.github_user_id` (`agent/m12-actors-unique`; tests run, production not touched)

- **`''` in the plan vs the index.** `docs/MIGRATION-LEGACY-TEST-PLAN.md` section 6 (2026-10-26) said two `''` values collide; the approved design is a partial index excluding both NULL and
  `''`, matching `mintUserToken` / `verifyUserTokenHash`. `createActor` already stores `''` as NULL, so `''` can only exist from a hand-edit or an old import. The plan is updated; the preflight ignores `''`.
- **The old pre-check-free `createActor` surfaced as an uncaught 500 only after the index existed.** Added a check in `createActor` (one synchronous step with the insert) that answers 409 `an actor with github_user_id "<id>" already exists (<actor id>)`.
  The UI login (`workers/api/ui.ts` `ensureActor`) does lookup then POST, so two first logins of one user can race: the loser now gets 409 and re-reads, instead of "Could not create your actor record".
  Old edge against the new DO: the same race ends in a failed login (fail closed); new edge against an old DO: unchanged behaviour (no 409 is ever returned).
- **Rolled-back floor code** has no duplicate check, so a duplicate insert by it is a 500 from the unique index, not a 409. Only the UI login can trigger it, and it fails closed (`docs/OPS.md` rollback floor).
- **Test-suite coupling found:** four existing tests built duplicate GitHub ids with `createActor` to exercise "newest wins" (`actors.test.ts`, `ui-actor.test.ts`). They now drop the index and insert raw rows,
  which models a pre-m12 ledger; those tests still pin the old-DO behaviour of the edge.
- **Not verified:** the `node:sqlite` harness, not Durable Object SQLite, ran the partial `CREATE UNIQUE INDEX ... WHERE`. Partial indexes exist since SQLite 3.8.0, but the DO's SQLite version was not checked here; the first real run is the deploy
  itself (the plan's open question 3). The step uses no other new construct.

## 2026-10-28: Real-gate container spike, results S3, S4, S5 (S1, S2 pending a secret) (`docs/REAL-GATE-IMPL-PLAN.md`, `spikes/gate-spike/`)

Throwaway worker `beehive-gate-spike` (container class `SpikeSandbox`, `durable_object` policy, queue `beehive-gate-spike-q`) deployed 2026-10-28 with the maintainer's wrangler OAuth login (the `.env` `CLOUDFLARE_API_TOKEN` cannot manage containers or read Workers Builds).

- **Config finding.** Wrangler 4.151.1 rejects a `docker.io/...` image: `containers.images.<name>.image` must be a digest-pinned image in the managed registry (`registry.cloudflare.com/<account>/<repo>@sha256:...`). The 2026-10-24 note that a registry image needs no Docker predates this validation. This host has no Docker, so the spike reuses the sandbox runner's build image, `beehive-sandbox-runner-buildsandbox-build`, tag `wrangler-mvrnwhxo`, digest resolved with `crane` (v0.22.1, checksum-verified) using a short-lived `wrangler containers registries credentials` pull credential in a private `DOCKER_CONFIG`, deleted afterwards. Wrangler lists tags but no digests (`containers images list`).
- **Image and size.** node v24.22.1, npm 11.19.1, git 2.47.3. `standard-2` gives 1 vCPU and 11445 MB disk; `lite` gives 1908 MB. `/sys/fs/cgroup/memory.max` does not exist and `free` is not installed, so peak memory must be measured from `/proc` (meminfo, `/proc/<pid>/status` VmHWM) during a run.
- **S4, egress: pass.** With only the registry intercept installed (`enableInternet: false`) the registry control returned 200 and every other path failed (HTTP and HTTPS to example.com timed out, HTTPS to an IP `ECONNRESET`, DNS `EAI_AGAIN`). Replacing the intercept handler on the running container with a deny handler turned the registry answer into a 403 without a restart. A raw TCP connect to `1.1.1.1:443` reports connected, but no byte ever came back: an HTTP request to `1.1.1.1:80` and a probe to `8.8.8.8:53` timed out with 0 bytes, and `1.1.1.1:443` reset after 0 bytes. Read as the intercept layer accepting the handshake on 443, not egress; do not treat a bare TCP connect as proof of network access in tests.
- **S3, concurrency: no automatic cap.** 25 `lite` containers started concurrently in 34 s, all OK (first step 0.5 to 2.2 s). `max_instances` is not available under `durable_object` scheduling, so the cap must be ours (queue `max_concurrency` plus a counter in the Spec DO), as the plan says.
- **S5, 590 s hold: pass.** One 590 s `exec` over an HTTP request to the worker returned 200 in 591.7 s; the same hold inside a queue consumer completed with exit 0 in 590.0 s. Neither hit a wall-clock limit.
- **Not yet measured:** S1 (clone a real commit via the Artifacts gateway and run `npm ci --ignore-scripts` through the second intercepted host) and S2 (`standard-1` vs `standard-2` peak memory, disk, time). Both need `CLOUDFLARE_API_TOKEN` as a secret on the spike worker; the permission layer blocked agents from writing that secret, so the maintainer must set it. The spike worker, its container application and the queue stay deployed until S1/S2 are done, then must be deleted (`spikes/gate-spike/README.md`).

## 2026-10-28: Real-gate container spike, results S1 and S2 (`docs/REAL-GATE-IMPL-PLAN.md`)

Input: `default/beehive` at `589b280` on Artifacts, cloned inside the container through the credential-injecting gateway (`ArtifactsGateway`), then `npm ci --ignore-scripts` with only the registry intercept allowed, then `npm test` with every intercept replaced by deny. One run per size; image node v24.22.1, npm 11.19.1.

- **S1, clone and install: works.** `git clone` + checkout of the commit took 3.6 to 4.0 s on both sizes; the `.env` `CLOUDFLARE_API_TOKEN` is accepted by the gateway (it has Artifacts permission). `npm ci` completed from the lockfile (199 packages, 342 MB on disk). The first attempt failed only because the spike set `NPM_CONFIG_USERCONFIG` and `NPM_CONFIG_GLOBALCONFIG` to the same path (`/dev/null`): npm refuses to load one file as both ("double-loading config"). Use two distinct empty files; the gate must do the same.
- **S2, size: CPU is the constraint, not memory or disk.** Peak memory used (MemTotal minus the minimum MemAvailable sampled every 0.3 s from `/proc/meminfo`, since there are no cgroup memory files and no `free`): 506 MB during `npm ci` and 438 MB during `npm test` on `standard-1`, 560 MB during `npm ci` on `standard-2`. Disk 342 MB. Wall time:

  | | `standard-1` | `standard-2` |
  |---|---|---|
  | `npm ci` | 70.4 s | 10.8 s |
  | `npm test` | 191.6 s (vitest 188.5 s) | 37.4 s |

  `nproc` reports 1 on both; the allocation differs (1/2 vs 1 vCPU), and `standard-2` was about 6.5 times faster for install and about 5 times faster for tests. One run each, so treat the ratio as indicative. Both fit the plan's 120 s install and 300 s test limits for this repo, but `standard-1` leaves little headroom for a heavier repo; `standard-2` is the recommended size.
- **Tests with no network pass.** 1380 passed, 30 skipped, 2 files failed (`tests/cli-behavior.test.ts` and `tests/cli-token.test.ts`) because only the root `npm ci` ran and the `cli/` package's dependencies (configstore) were not installed. The gate's install step must install every workspace package's dependencies the repo's own CI installs (`.github/workflows/ci.yml` runs `npm install` in `cli/` and in each `workers/*/`), or a monorepo-aware equivalent.
- **Teardown.** The spike worker (with its secrets, including the copied `CLOUDFLARE_API_TOKEN`), its container application and the queue `beehive-gate-spike-q` were deleted after these runs.

## 2026-10-28: m13 on workerd, and gate-run routes not yet on the edge (`agent/real-gate-slice5`, not merged or deployed)

- **The preview-columns finding of 2026-10-26 is fixed in code.** The three `candidates.preview_*` columns are now in the base `candidates` table (`schema.sql` and `schema-inline.ts`, kept equal by `schema-sync.test.ts`) and the m13 step runs `addColumnsIfMissing` for them, which repairs ledgers that were created fresh at m11 or m12 and stamped without running m2. The `it.fails` pin is now an `it`. A4 no longer excludes them.
- **Run on workerd's real SQLite (local only).** A ledger created by `main` (`087b876`, m12) through `scripts/start-e2e-workers.sh` had `schema_version = m12` and **no preview columns** (the finding, observed on workerd, not only on `node:sqlite`). The same persisted state under this branch's code went to `m13`: `gate_runs` with its three indexes and foreign keys to `candidates` and `actors`, the three preview columns added, the candidate and organization rows kept. Start, dedupe (running), 409 `busy` (repository), strict 400, finish, list and the `gate_verdicts` summary upsert answered as designed through the local probe worker. Idempotent redelivery was exercised on `node:sqlite` only (the probe forwards no `Idempotency-Key`).
- **The edge does not route `/api/gate-runs`** (a `GET` through `beehive` answers 404 "Not found"): by plan it is slice 8, so only the tier-1 Spec DO stub (the gate worker, slice 7a) can reach the new routes.
- **Quota answer.** A start over the 50/24 h organization limit answers **200 `{ quota: true, runId }`** and writes a `not_run`/`quota` row (plan §3), not a 429, so the gate's `Response.ok` check acks it. Caps answer 409 with `code: 'busy'` and `reason: 'repository' | 'global'`.
- **Review notes (2026-10-28, independent review of `agent/real-gate-slice5`).**
  1. **The `gate_verdicts` summary is not tied to a sha.** It is one row per (candidate, gate): the latest-started run's outcome, whichever sha that was (`notes` names the sha only as text). Merge and policy checks must read `gate_runs` at the head sha (plan §3), never `gate_verdicts`.
  2. **`decidedBy` is trusted from the body**, like the existing `POST /api/gate-verdicts`: the DO checks only that the actor exists, not that it is the caller. The routes are tier-1 only (no edge route until slice 8), so the trust boundary is the gate worker; if an edge route is ever added it must set `decidedBy` from the principal.
  3. **Stale running rows count twice toward the quota.** A `running` row past 15 minutes is reported `abandoned` and frees its repository and global slot, but it still counts as a started run in the organization's 50/24 h (it did start a container), and the re-run that follows counts again. Deliberate for now (the cap is a cost bound, not a fairness rule); revisit if abandoned rows prove common.
  4. **Terminal rows and the quota.** `terminal` rows other than `busy_timeout`/`quota` count toward the quota; the per-sha attempt cap (10) bounds one sha, but a tier-1 caller can still use many shas.
  5. **`gate_runs.candidate_id` foreign key: decided A on 2026-10-28 (dropped).** `docs/OPS.md` (rollback floor) allows a new table to reference only `actors`, so that an m12-floor build over an m13 ledger can still purge. The table keeps `decided_by -> actors`; `candidate_id` is a logical reference (route 404s unknown/tombstoned candidates), the m13 purge deletes a candidate's runs first and sweeps orphans left by a floor-build purge. Tests: `migration-gate-runs.test.ts` (rollback floor), `purge-local.test.ts` (orphan sweep).
- **Idempotency-Key on workerd (2026-10-28, local).** With the e2e probe relaying an allow-listed `Idempotency-Key`: start 200; same key and body replayed with `Idempotent-Replay: true` and the same `runId`; same key with another sha 409 `Idempotency key conflict`; a 409 `busy` under a key left no key row, and the same key after the first run finished started the run (200, new `runId`, later replayed). Nested `transactionSync` (route inside `idempotent()`) behaved as on `node:sqlite`.

## 2026-10-28: Real-gate slice 4, TestSandbox and `/sandbox/test` (`agent/real-gate-slice4`, not merged or deployed)

Code only; no `wrangler.toml`, Dockerfile or Spec DO change. Unit-tested with a fake container; nothing here ran on the platform.

- **Shape.** `sandbox-base.ts` (`ContainerSandbox` base: serialize, deadline + alarm, abandoned-call check, destroy; `ArtifactsGateway`; `cloneCommit`), `test-sandbox.ts` (`TestSandbox`, `NpmRegistryGateway` with `deny` prop as the replacement handler, `validateTestRequest`, `parseCounts`), `POST /sandbox/test` in `index.ts`. Config is read through methods, not fields, because the base constructor runs before subclass field initializers. `build-sandbox.ts` re-exports the moved names; its 33 tests pass unchanged.
- **Contract.** Request `{ repo, commitSha, namespace?, installDirs? (default ['.']), testCommand? (argv, default npm test) }`. Every verdict (pass, fail, error) is 200 `{ success: true, result }`; non-2xx is infrastructure (400 BAD_REQUEST, 422 BAD_NAMESPACE, 503 NOT_CONFIGURED / SANDBOX_UNAVAILABLE, 502 unknown). `clone_failed` and `timeout_overall` come back as `error` verdicts, not HTTP errors. `/sandbox/test` answers 503 NOT_CONFIGURED while `env.TEST_SANDBOX` is unbound (until slice 6).
- **Unverified on the platform (first thing slice 7a's production run must check).**
  1. `container.images.test` is the assumed image key (`[containers.images.test]`) and `imageDigest` is parsed from that string only if it contains `@sha256:...`; otherwise it is `null`.
  2. (Superseded by the review fix below: the wrapper is `bash -c`, because dash, the `sh` of the node image family, rejects `ulimit -u`; seen on this host. bash exists in the node:trixie-slim base but the image was not inspected.) The phase wrapper was `sh -c 'ulimit -u/-t/-f ...; exec "$@" >>log 2>&1'` with argv positional. Whether the image's `sh` accepts `ulimit -u`, and the unit of `-f` (512-byte blocks in POSIX sh, 1 KiB in bash), is not checked; a failing `ulimit` exits 125, which the gate would report as `install_failed`/`tests_failed`.
  3. Whether `exec({ env })` replaces or merges the container's environment is unknown; the code sets `PATH`, `HOME`, `CI` and the npm config explicitly either way.
  4. Whether an active long `exec` resets `setInactivityTimeout`; the test sandbox sets 15 minutes so the 600 s deadline always wins.
  5. The registry intercept relies on npm sending only `GET` over https to `registry.npmjs.org`; the gateway forwards only `FORWARDED_HEADERS`, so a header npm needs but that is not on the list would show as an install failure.
  6. The install budget (120 s) is shared by all `installDirs`; the multi-package time is still unmeasured (plan section 1).
- **Exports without a wrangler declaration.** `index.ts` exports `TestSandbox` and `NpmRegistryGateway` now. `wrangler deploy --dry-run` cannot run on this host (Docker needed for the `[[containers]]` image), so a copy of the config without `[[containers]]` was dry-run: the bundle builds. Whether the server accepts an exported Durable Object class with no `[exports.TestSandbox]` entry on the real deploy is not verified; if it does not, move the `export { TestSandbox ... }` line into slice 6.
- **Review fixes (same day).** `TestSandbox` is no longer exported from `index.ts` (slice 6 adds it; plan item 6); the dry-run bundle with `[[containers]]` removed still builds with only `NpmRegistryGateway` exported. The phase wrapper now applies `ulimit` inside `{ ...; } >>"$log" 2>&1` and exits 125 on failure, which `TestSandbox` throws as `SANDBOX_UNAVAILABLE` (a child that exits 125 is remapped to 1). Only the wrapper's own 124 (or 137 after the KILL with the limit elapsed) is a timeout; any other 137 is the new failure class **`killed`** (an outside SIGKILL, e.g. the OOM killer), which the gate's zod schema and class table (plan section 4) must learn in slice 7a. `.npmrc` removal is `find <clone> -name .npmrc -not -path '*/node_modules/*' -delete`; `testCommand[0]` may not start with `-`.
- **Not done (optional in the plan):** `peakMemMb` sampling. The verdict omits the field.


## 2026-10-28: Real-gate slice 6, TestSandbox container config (`agent/real-gate-slice6`, not merged or deployed)

Config, image and export only; nothing here ran on the platform (no Docker on this host, no deploy).
- **Files.** `workers/sandbox-runner/wrangler.toml`: second `[[containers]]` (`class_name`, `scheduling_policy = "durable_object"`, `[containers.images.test] dockerfile = "./Dockerfile.test"`), binding `TEST_SANDBOX`, `[exports.TestSandbox]` (new class, sqlite). `index.ts` exports `TestSandbox`. `Dockerfile.test`: same digest-pinned `node:24-trixie-slim` as the build image, plus bash, ca-certificates, findutils, git (clone, the bash phase wrapper, `find`/`test`); no esbuild.
- **Unverified until the maintainer's push (checks in the slice 6 report).**
  1. Whether two `[[containers]]` blocks with different `dockerfile` paths in one directory each build with their own context; the build image's `Dockerfile` copies nothing, so a shared context is harmless either way.
  2. That the key `images.test` is what `ctx.container.images.test` (`test-sandbox.ts:197`) reads; a wrong key makes `start` fail with `SANDBOX_UNAVAILABLE`, not a verdict.
  3. Whether a new exported Durable Object class plus its container application deploys in the same version as the existing renamed `Sandbox` entry without a lifecycle error (10086 applied only to deleting a bound class).
  4. `imageDigest` is expected to be `null`: wrangler 4.151.1 tags Dockerfile-built images (`<script>-<class>-<image>:wrangler-<time>`, no digest), as for the build image. The base-image digest pin in `Dockerfile.test` is the reproducibility anchor.
- **Local checks run:** TOML parse, typecheck, sandbox-runner tests (97 pass), all clean. Independent review: `wrangler deploy --dry-run` on the real config passes validation and stops at the Docker check; with containers stripped the bundle builds. CI's dry-run (Docker available) builds `Dockerfile.test` first.
