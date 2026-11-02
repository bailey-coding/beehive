# Plan: deploy-ref rollback idempotency

Task: `rollback-idempotency` | Spec: `docs/OPEN-QUESTIONS.md` "2026-11-01: deploy-ref rollback toggles, and a repeated
rollback now records a false near-miss" | Tier: heavy (AGENTS.md rule 2 spine: DO ledger; rule 7: rollback is a ref
operation). Status: **reviewed (Review 1: approve with changes, no blockers); revised per section 11.**

Maintainer decision: make rollback idempotent per request. This plan does that with the existing Idempotency-Key
machinery on `/deploy-refs/rollback` plus a complementary compare-and-set header (D1, maintainer default: include).

## 1. Facts (line numbers at `4cbb0e3`)

### The bug

- `rollbackHead` (`workers/spec-do/index.ts:3663-3704`) reads the head, moves to the target of `head.prevRefId`
  (`:3666-3674`), records an `slo_rollback` near-miss for `head.candidateId` with `sourceRef: head.id` (`:3675-3681`),
  marks the active promotion rolled back (`:3682-3687`) and, for canary, the deployment (`:3689-3701`).
- After one rollback the new head's `prev_ref_id` is the head just rolled back (`moveDeployRef` inserts with
  `prev_ref_id = head.id`, `:3632-3655`), so a second call moves back to it. The test
  `workers/spec-do/tests/deploy-refs.test.ts:166-178` pins this ("rolling back twice toggles the pointer back") and
  `docs/OPS.md:423` documents it.
- The second call's near-miss has a different `source_ref` (the rollback ref), so the `UNIQUE(candidate_id, reason,
  source_ref)` dedupe (`workers/spec-do/schema-inline.ts:777, 824`) does not catch it: a false near-miss.

### The two rollback routes differ

| Route | Handler | Guard today | Redelivery today |
|---|---|---|---|
| `POST /deploy-refs/rollback` `{specId, rung, reason}` (`RefRollbackRequestSchema`, `workers/shared/deploy-refs.ts:112-114`) | `index.ts:3385-3390` -> `transactionSync(rollbackHead)` | none | **toggles back + false near-miss** |
| `POST /canary-deployments/:id/rollback` `{reason}` (`RollbackRequestSchema`, `deploy-refs.ts:110`) | `index.ts:3346-3351` -> `rollbackCanary` (`:3509-3520`) | 409 unless the deployment is `deployed` and the head's `workerVersionId` is its (`:3513-3516`), checked inside the same transaction | 409, no move, no near-miss |

`rollbackCanary`'s liveness check is already a compare-and-set on "this deployment is the live head". The toggle is
reachable only through `/deploy-refs/rollback`.

### Idempotency-Key machinery

- `IDEMPOTENT_ROUTES` (`index.ts:42-47`): nine `/api` POSTs plus the entity-history regex. The header is ignored
  elsewhere.
- `resolveIdempotency` (`index.ts:3787-3829`): `null` without a header or on an unlisted route; 400 over 255 chars;
  else `{scopeHash = sha(actorId, method, path, key), requestHash = sha(body via request.clone().text())}`. It must run
  **before** the body is consumed (clone after consumption throws).
- `idempotent(ctx, status, mutate)` (`index.ts:3840-3887`): one `transactionSync` holding lookup, mutation and key
  insert. Same key + same body: stored status/body with `Idempotent-Replay: true`. Same key + different body: 409. A
  throwing mutation stores no key. With `ctx = null` it just runs `mutate`.
- `idempotency_keys` (`schema-inline.ts:663-677`): `method` CHECK allows POST, `endpoint` is free text. No schema
  change needed.
- **The deploy-ref routes are dispatched before `idem` is resolved.** `fetch` matches `DEPLOY_ROUTE` and returns
  `handleDeployRefs` at `index.ts:3944-3948`; `resolveIdempotency` runs at `:3962-3964`, after. `handleDeployRefs`
  reads the body first thing (`:3305-3312`) and takes the actor from `X-Actor-ID` with fallback `'system'` (`:3302`;
  the main router falls back to `'unknown'`, `:3951`). So wiring needs a resolve call inside `handleDeployRefs`,
  before `request.json()`.
- `rollbackCanary` opens its own `transactionSync` (`:3510`). The test adapter uses a fixed `SAVEPOINT tx`
  (`workers/spec-do/tests/sqlite-state.ts:36-47`); nested real-DO `transactionSync` is not something this repo has
  verified. The plan avoids nesting.

### Callers (all of them)

| Caller | file:line | Route reached | Notes |
|---|---|---|---|
| canary-worker manual `POST /rollback` | `workers/canary-worker/index.ts:68-72` -> `rollback.ts:18-50` | `/canary-deployments/:id/rollback` via `DeployRefsClient.rollbackCanary` (`deploy-refs.ts:267-269`, `rollback.ts:36`) | resolves the candidate's `deployed` deployment first (`canary.ts:106-110`); none -> 404 before the DO |
| canary-worker SLO cycle (tick queue) | `workers/canary-worker/slo.ts:160-180` (`:171-174`) | same, through `triggerRollback` | 404/409 counted as `alreadyHandled` (`:173`) |
| canary-worker rollback-trigger queue | `workers/canary-worker/queues.ts:9-22`, `rollback.ts:63-70`; consumer `wrangler.toml:41` | same | no producer in the repo |
| e2e | `tests/e2e/cross-worker-flows.test.ts:114-124, 420` | canary-worker `/rollback` | expects 200 |
| e2e probe (local, tier-1 token) | `tests/e2e/spec-do-auth.test.ts:20-24` | can forward any DO path | not used for rollback today |
| DO unit tests | `workers/spec-do/tests/deploy-refs.test.ts:49-50, 157-212`; `near-misses.test.ts:200`; `canary-alarm.test.ts:130`; `canary-metrics.test.ts:125` | both | |
| promotion-worker `/merge/rollback` | `workers/promotion-worker/index.ts:258-274`, `merge-train.ts:436-470` | stage route (`PATCH /api/candidates/:id/stage`), **not** a deploy ref | out of scope |
| preview-manager | `workers/preview-manager/index.ts:398` | `listCanaryDeployments` only (read) | no rollback |
| beehive edge (`workers/api`) | none: no deploy-ref route at the edge (`docs/FEATURE-PARITY.md:35`) | | |
| scripts, cli | none | | |

**No production worker calls `POST /deploy-refs/rollback`.** `DEPLOY_PATHS.deployRefRollback` (`deploy-refs.ts:220`)
has no client method. The toggle is reachable today only from tests and an operator forwarding a DO request.

## 2. Design

Both parts touch only `POST /deploy-refs/rollback`, only the Spec DO, and both are opt-in by header. The canary
route (`/canary-deployments/:id/rollback`) is **not changed**: it has no sender that would set a key, the
canary-worker stays as is, and its liveness check already refuses a repeat. `rollbackCanary` is not split.

### Part A: Idempotency-Key on `/deploy-refs/rollback`

1. `IDEMPOTENT_ROUTES` (`index.ts:42-47`) gains `'POST /deploy-refs/rollback'`. No other deploy route is keyed;
   `recordCanaryMetrics` stays documented as not idempotent (`index.ts:3536-3538`).
2. In `handleDeployRefs`, for `collection === 'deploy-refs' && id === 'rollback' && method === 'POST'` only, call
   `this.resolveIdempotency(request, method, url.pathname, actorId)` **before** `request.json()`; a `Response` (400)
   is returned as is. Other routes skip the call.
3. The handler runs `idem ? this.idempotent(idem, 200, () => envelope(rollbackHead(...))) :
   json(this.state.storage.transactionSync(() => rollbackHead(...)))`. The unkeyed branch keeps its explicit
   `transactionSync` because `idempotent(null, ...)` calls `mutate()` outside any transaction (`index.ts:3846`). The
   envelope is `{ success: true, data, timestamp }`, as `json()` builds.
4. Errors: `NotFoundError`/`ConflictError` thrown inside `idempotent` abort its transaction (no key written) and reach
   the existing catch (`index.ts:3393-3398`) as 404/409. A retry with the same key re-evaluates.
5. Replay: the stored 200 envelope (same `data.id`, original `timestamp`) plus `Idempotent-Replay: true`. Same key,
   different body: 409 `Idempotency key conflict`, nothing moves. Key over 255 chars: 400. Scope is actor + method +
   path + key; headerless callers share the `'system'` actor (`index.ts:3302`).

A key is not a compare-and-set: two different fresh keys still toggle (see D2).

| Caller | Sends | Why |
|---|---|---|
| canary-worker (manual, SLO cycle, queue) | nothing new | uses the canary route, unchanged; its liveness check refuses a repeat (409) and its pre-check 404s first; `slo.ts:173` counts both as handled |
| operators / e2e via the probe on `/deploy-refs/rollback` | `Idempotency-Key: <uuid per decision>` and `X-Expected-Head: <head id read first>` | one key per decision; the head id refuses a stale decision |

### Part B (D1, included): `X-Expected-Head` compare-and-set on `/deploy-refs/rollback`

- `EXPECTED_HEAD_HEADER = 'X-Expected-Head'` in `workers/shared/deploy-refs.ts`; value a deploy ref id. A header, not
  a body field: `RefRollbackRequestSchema` is `.strict()`, so an old DO would 400 a body field; it ignores a header.
- Present but empty: 400 `Invalid X-Expected-Head` (mirrors `index.ts:2907`), never fail open.
- `rollbackHead` gains an optional `expectedHeadId`; when set and `head.id !== expectedHeadId`, it throws a
  `ConflictError` with code `VERSION_CONFLICT` (`workers/shared/ledger-state-machine.ts:26`) and the message
  "deploy ref head is <actual>, not <expected>; re-read and retry" (mirrors `index.ts:84`). Checked before any
  write: no move, no near-miss, no key row.
- `ConflictError` (`index.ts:57`) gets an optional `code` constructor arg; the deploy-ref catch (`:3394`) becomes
  `fail(e.message, 409, e.code)`. Every existing `ConflictError` has no code, so existing 409s stay code-less.
- Order with a key: the key lookup runs first, so key + header redelivery replays 200; a fresh key with a stale head
  is 409. The header is not in `requestHash` (body only): same key, different header replays the first answer.
- The canary route does not read the header; its liveness check is its CAS. A test pins that it is ignored.

Why both: the key protects a caller that keeps its key across a retry (it gets its own 200 back); the CAS protects
any caller that read the head it decided on (two actors racing, a curl run twice with fresh keys).

## 3. Mixed-version table (one push, ten workers, any order)

| Combination | Behavior |
|---|---|
| New DO, old canary-worker / shadow-router / preview-manager | unchanged: none sends the headers, and the canary route is untouched |
| New DO, caller without headers | unchanged, toggles as today (D2) |
| Old DO, caller sending the headers | headers ignored: the DO path is dispatched (`index.ts:3944`) before `idem` is resolved (`:3962`) and the old handler reads neither header. Rollback runs unkeyed, i.e. today's behavior, never worse. Argued from dispatch order, not unit-tested (no old-DO fixture). No production caller sends them. |
| DO rolled back to old code after keyed rollbacks | `idempotency_keys` rows for `/deploy-refs/rollback` are ignored and expire through the old sweep (`index.ts:3780`) |

## 4. Rollback-floor safety

No schema change, migration, table, column or `schema_version` bump. `idempotency_keys` exists on every ledger at the
current floor (`index.ts:682-683`); its `method` CHECK allows POST.

## 5. Tests to add (real SQL through the real router)

`workers/spec-do/tests/deploy-refs.test.ts`:
1. Redelivered `/deploy-refs/rollback` with key `k1` does not toggle: both 200, second has `Idempotent-Replay: true`
   and the same `data.id`; head `cand-a`; `deploy_refs` count 3.
2. Same key, different `reason`: 409, nothing moves.
3. Failed keyed rollback stores no key: `k2` on a spec with no ref -> 404; deploy, `k2` -> 200 and moves; a third `k2`
   call replays and does not move.
4. Key over 255 chars -> 400, nothing moves.
5. (a) Replay after the head moved: rollback with `k1`, deploy C, `k1` again -> 200 replay with the original `data.id`;
   head still C; `deploy_refs` and near-miss counts unchanged.
6. (b) Two different fresh keys still toggle (a key is not a CAS; pins the D2 hazard).
7. One transaction per keyed rollback (`store.transactions.count` delta 1).
8. Same key from another `X-Actor-ID` is a new request (scope pin).
9. Other deploy routes ignore the key: `POST /canary-deployments` twice with one key -> two deployments.
10. (d) Canary route repeat, keyed then unkeyed -> 409 and no `idempotency_keys` row stored.
11. (e) `X-Expected-Head` on the canary route is ignored (stale value, live deployment -> 200).
12. `X-Expected-Head` = head id -> 200; stale -> 409 `code: version_conflict`, message names the actual head; head,
    count, near-misses unchanged; key + header redelivery -> replay 200.
13. (f) Empty `X-Expected-Head` -> 400 `Invalid X-Expected-Head`, nothing moves.
14. (g) The existing not-live 409 (`deploy-refs.test.ts:201-208`) has no `code`.
15. Retitle `:166` "two distinct rollbacks (no key) toggle back: known hazard pending D2".

`workers/spec-do/tests/near-misses.test.ts`:
16. A redelivered keyed rollback writes one `slo_rollback` near-miss (for `cand-b`, none for `cand-a`).
17. Companion: two unkeyed rollbacks write two (known hazard pending D2). A stale `X-Expected-Head` writes none.

Runs: `npm run typecheck`, `npx vitest run --exclude 'tests/e2e/**'`. Kill checks: revert each fix, the named test fails.

## 6. Docs to update

- `docs/OPS.md:423`: "Two distinct rollbacks currently toggle back; known hazard, see `docs/OPEN-QUESTIONS.md`
  2026-11-01 (D2)." Plus the headers for `/deploy-refs/rollback`.
- `docs/OPS.md` Idempotency section (`:556`): name `POST /deploy-refs/rollback` (internal DO route) and that
  headerless callers share the `'system'` actor scope.
- `docs/OPEN-QUESTIONS.md`: the 2026-11-01 toggle entry -> **Partly resolved** (redelivered rollbacks fixed; distinct
  rollbacks still toggle, see the D2 entry); a **new dated D2 entry** with the trace and minimal fix idea (section 8).
- `workers/shared/deploy-refs.ts`: comment on `DEPLOY_PATHS.deployRefRollback` naming the headers.

## 7. Files touched

`workers/spec-do/index.ts`, `workers/shared/deploy-refs.ts`, `workers/spec-do/tests/deploy-refs.test.ts`,
`workers/spec-do/tests/near-misses.test.ts`, `docs/OPS.md`, `docs/OPEN-QUESTIONS.md`. No canary-worker, edge or
wrangler change.

## 8. Risks

- **Body read order:** resolving after `request.json()` makes `request.clone()` throw. Test 1 catches it.
- **Transaction shape:** the unkeyed path must keep its `transactionSync`. Test 7 and `:186-189` catch a regression.
- **Stale replay:** a key reused after the head moved replays the old 200 for up to 24 h (test 5). Inherent to keys;
  the CAS covers callers that cannot hold one key per decision.
- **D2 (out of this PR, new OPEN-QUESTIONS entry): rolling back the restored canary re-promotes the rolled-back one,
  and the SLO loop can ping-pong.** Deploy A, deploy B, roll back B: the head moves to A and `syncCanaryStatuses`
  (`index.ts:3706-3719`, `:3716`) marks A `deployed`. Roll back A: the liveness guard passes, the head's `prev` is B's
  ref, so the ref moves back to B and B is marked `deployed` again. The SLO loop runs from the DO alarm every 60 s
  (`CANARY_TICK_INTERVAL_MS`, `index.ts:456`; via the `canary-slo-ticks` queue; canary-worker `crons = []`) over a
  15-minute window (`deploy-refs.ts:149-151`), so two violating canaries can flip about once a minute, each flip a new
  `slo_rollback` near-miss. The OPEN-QUESTIONS alternative "the last ref whose candidate is not the current head's"
  does **not** fix this (rolling back A, B is not A's candidate, so it is chosen). Reviewer's minimal fix idea:
  `rollbackHead` walks the prev chain from `head.prev`, skipping refs whose candidate already has an `slo_rollback`
  near-miss on this rung (or whose `canaryForRef` is `rolled_back`), falling back to the empty ref; it still appends
  exactly one ref. Needs its own plan (rule 7 territory).

## 9. Review asks

Answered by Review 1; see section 11.

## 10. Open decisions for the maintainer

- **D1:** include the CAS. Maintainer default: include. Done in this PR.
- **D2:** filed separately as a new OPEN-QUESTIONS entry; not in this PR.

## 11. Review 1 dispositions

| # | Finding | Disposition |
|---|---|---|
| 1 | D2 is real and loops (trace in section 8); the OPEN-QUESTIONS alternative does not fix it; do not bless the toggle | Accepted: section 8 corrected; new dated OPEN-QUESTIONS entry; OPS wording "known hazard"; tests 6, 15, 17 pin the hazard; "Semantics kept ... rule 7" dropped (rule 7 is a cheap ref move, not a toggle) |
| 2 | Include Part B; `ConflictError` optional `code`, catch forwards it, existing 409s stay code-less; `VERSION_CONFLICT`; actual head id in message; empty header 400; canary route ignores the header | Accepted: section 2 Part B; tests 11-14 |
| 3 | Test 3 must exercise new code; add (a), (b), (d), (e), (f), (g); old-DO header ignore is argued from dispatch order | Accepted: tests 3, 5, 6, 10, 11, 13, 14; mixed-version table note |
| 4 | Drop keying the canary route; do not split `rollbackCanary`; drop test (c) | Accepted: Part A covers `/deploy-refs/rollback` only |
| 5 | OPS Idempotency section names the route and the shared `'system'` scope | Accepted: section 6 |
