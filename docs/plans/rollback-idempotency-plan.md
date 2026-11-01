# Plan: deploy-ref rollback idempotency

Task: `rollback-idempotency` | Spec: `docs/OPEN-QUESTIONS.md` "2026-11-01: deploy-ref rollback toggles, and a repeated
rollback now records a false near-miss" | Tier: heavy (AGENTS.md rule 2 spine: DO ledger; rule 7: rollback is a ref
operation). Status: **plan, awaiting independent review. No code yet.**

Maintainer decision: make rollback idempotent per request. This plan does that with the existing Idempotency-Key
machinery and proposes one optional, complementary compare-and-set header (open decision D1).

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

Two parts, both DO-only, both opt-in by header. Part A is the maintainer's choice; Part B is D1.

### Part A: Idempotency-Key on both DO rollback routes

1. `IDEMPOTENT_ROUTES` (`index.ts:42-47`) gains `'POST /deploy-refs/rollback'` and
   `/^POST \/canary-deployments\/[^\/]+\/rollback$/`. No other deploy route (canary deploy, metrics, PATCH) is keyed;
   `recordCanaryMetrics` stays documented as not idempotent (`index.ts:3536-3538`).
2. In `handleDeployRefs`, for the two rollback routes only (`method === 'POST'` and either
   `collection === 'canary-deployments' && sub === 'rollback'` or `collection === 'deploy-refs' && id === 'rollback'`), call
   `this.resolveIdempotency(request, method, url.pathname, actorId)` **before** `request.json()`; a `Response` (400)
   is returned as is. Other routes skip the call, so they pay no hashing cost.
3. `/deploy-refs/rollback`: run the mutation through a small local helper used by both rollback routes:
   `idem ? this.idempotent(idem, 200, () => envelope(mutate())) : json(this.state.storage.transactionSync(mutate))`.
   The unkeyed branch keeps its explicit `transactionSync` because `idempotent(null, ...)` calls `mutate()` outside
   any transaction (`index.ts:3846`); the keyed branch runs inside `idempotent`'s own transaction. The envelope is
   `{ success: true, data, timestamp }`, the same as `json()` builds, so a replay is byte-identical to the original.
4. `/canary-deployments/:id/rollback`: split `rollbackCanary` into a private `rollbackCanaryTx` (the body, no
   transaction) and the public `rollbackCanary` wrapper (`transactionSync(rollbackCanaryTx)`, unchanged signature for
   any direct caller). The keyed path runs `rollbackCanaryTx` inside `idempotent`; no nested transactions.
5. Errors: `NotFoundError`/`ConflictError` thrown inside `idempotent` abort its transaction (no key written) and reach
   the existing catch (`index.ts:3393-3398`) as 404/409. A retry with the same key re-evaluates.
6. Replay answer: the stored 200 envelope (same ref id: `data.id` on `/deploy-refs/rollback`, `data.ref.id` on the canary route; original `timestamp`) plus `Idempotent-Replay: true`.
   Same key, different body (e.g. another `reason`): 409 `Idempotency key conflict`, nothing moves. Key over 255
   chars: 400. Scope is actor + method + path + key, so the same key from another actor or on the other route is a new
   request (by design, `resolveIdempotency`).

Key derivation per caller (what each one sends):

| Caller | Sends | Why |
|---|---|---|
| canary-worker (manual, SLO cycle, queue) | **nothing new** | it uses the canary route, whose liveness check already refuses a repeat (409) and its own pre-check 404s first; the SLO cycle already counts both as handled. Changing it adds files and a mixed-version surface for no behavior gain. |
| e2e / operators calling `/deploy-refs/rollback` via the probe | `Idempotency-Key: <uuid per decision>` (+ `X-Expected-Head` if D1) | one key per human decision; a retry reuses it |
| DO tests | keys as listed in section 5 | |

### Part B (D1, recommended): `X-Expected-Head` compare-and-set on `/deploy-refs/rollback`

- New header constant `EXPECTED_HEAD_HEADER = 'X-Expected-Head'` in `workers/shared/deploy-refs.ts`, value a deploy
  ref id. A header, not a body field: `RefRollbackRequestSchema` is `.strict()`, so a body field would be a 400 from
  an old DO (AGENTS.md strict-zod rule); an old DO ignores an unknown header.
- `rollbackHead` gains an optional `expectedHeadId`; when set and `head.id !== expectedHeadId`, throw
  `ConflictError` -> 409 with code `version_conflict` (`VERSION_CONFLICT`, `workers/shared/ledger-state-machine.ts:26`;
  `fail` already takes a code, but the catch at `index.ts:3395` passes none, so the CAS throws a `ConflictError`
  subclass carrying the code and the catch forwards it). Checked inside the transaction before any write: no move, no near-miss, no key.
- Absent header: today's behavior. `rollbackCanary` does not take it (its liveness check is the canary-route CAS).
- Order with a key: the key lookup runs first, so a redelivery with key + header replays 200; a fresh key with a stale
  head is 409. The header is not part of `requestHash` (body only), so the same key with a different header replays
  the first answer; documented, acceptable.

Why complementary rather than instead: the key protects only a caller that keeps its key across a retry. The CAS
protects any caller that read the head it decided on, including two different actors racing, and a curl run twice
with fresh keys. It is the same shape as `rollbackCanary`'s guard and as `X-Expected-Version` on the ledger routes.
It does not replace the key: without a key a lost 200 followed by a retry answers 409, and the caller must read the
head to tell "my rollback landed" from "someone else moved it"; with the key it gets its own 200 back.

### Semantics kept

Two distinct rollback decisions still toggle (rule 7: promotion and demotion are the same move). The existing toggle
test stays, retitled "two distinct rollbacks (no key) still toggle"; `docs/OPS.md` says so.

## 3. Mixed-version table (one push, ten workers, any order)

| Combination | Behavior |
|---|---|
| New DO, old canary-worker / shadow-router / preview-manager | unchanged: they send no `Idempotency-Key` or `X-Expected-Head`; null ctx and no CAS is today's code path |
| New DO, old tests/operator without headers | unchanged, toggles as today |
| Old DO, new caller sending the headers | headers ignored (not in old `IDEMPOTENT_ROUTES`, DO path dispatched before `idem`); the rollback runs unkeyed. Fail-open to **today's** behavior, never worse. No production caller sends them, so the window has no exposure. |
| DO rolled back to old code after keyed rollbacks | `idempotency_keys` rows for `/deploy-refs/rollback` and `/canary-deployments/:id/rollback` are ignored by old code and expire through the old sweep (`index.ts:3780`); no FK, no new column |
| Old DO answering an unknown header | n/a: no new route, no new body field, so no 404/400 retry path is needed |

## 4. Rollback-floor safety

No schema change, no migration, no new table or column, no `schema_version` bump. `idempotency_keys` already exists
on every ledger at or above the current floor (applied on fresh init, `index.ts:682-683`, and by its migration). If
review finds a change needed, it must be additive and may reference only `actors`; none is expected.

## 5. Tests to add (real SQL through the real router)

`workers/spec-do/tests/deploy-refs.test.ts`:
1. **Redelivered `/deploy-refs/rollback` with the same key does not toggle:** deploy a, b; rollback twice with key
   `k1`; both 200, second has `Idempotent-Replay: true` and the same `data.id`; head is `cand-a`; `deploy_refs` count 3.
2. Same key, different `reason`: 409, head and count unchanged.
3. Failed keyed rollback stores no key: key `k2` on a spec with no ref -> 404; deploy, same `k2` -> 200 and moves.
4. Key over 255 chars on `/deploy-refs/rollback` -> 400, nothing moves.
5. Keyed canary-route rollback replays: rollback b's deployment with `k3` twice -> 200 then replay 200, deployment
   `rolled_back`, head `cand-a`; unkeyed repeat stays 409 (existing `:201-208` style).
6. One transaction per keyed rollback (`store.transactions.count` delta 1), as `:186-189` checks for the unkeyed one.
7. Same key from a different `X-Actor-ID` is a new request (toggles), pinning the documented scope.
8. Other deploy routes ignore the key: `POST /canary-deployments` twice with one key creates two deployments.
9. Retitle `:166` to "two distinct rollbacks (no key) still toggle"; assertions unchanged.
10. (D1) `X-Expected-Head` = head id -> 200; stale id -> 409 `code: version_conflict`, head, count and near-misses
    unchanged; key + header redelivery -> replay 200.

`workers/spec-do/tests/near-misses.test.ts`:
11. **A redelivered rollback writes one near-miss:** extend the `:195-205` block: same key twice -> one `slo_rollback`
    row for `cand-b`, none for `cand-a`. A companion test pins today's unkeyed toggle writing two (the known
    distinct-decision case), so a later change to that semantics is deliberate.
12. (D1) stale `X-Expected-Head` writes no near-miss.

Runs: `npm run typecheck`, spec-do and canary-worker unit suites, full `npm test`. No e2e against production.

## 6. Docs to update

- `docs/OPS.md:421-425`: replace "Rolling back twice toggles back" with: two distinct rollbacks toggle; send
  `Idempotency-Key` to make a retry replay; (D1) send `X-Expected-Head: <head id>` to refuse a stale decision (409).
- `docs/OPS.md:556-567` (Idempotency section): add the two internal DO rollback routes.
- `docs/OPEN-QUESTIONS.md` 2026-11-01 entry: **Status: Resolved** with the commit, the chosen mechanism, and the
  note that the canary route was already guarded.
- `workers/shared/deploy-refs.ts`: comment on `DEPLOY_PATHS.deployRefRollback` naming the headers.

## 7. Files touched

`workers/spec-do/index.ts`, `workers/shared/deploy-refs.ts` (D1 constant + comment),
`workers/spec-do/tests/deploy-refs.test.ts`, `workers/spec-do/tests/near-misses.test.ts`, `docs/OPS.md`,
`docs/OPEN-QUESTIONS.md`. No canary-worker, edge, or wrangler change.

## 8. Risks

- **Body read order:** resolving after `request.json()` makes `request.clone()` throw (500). Test 1 catches it.
- **Transaction shape:** the unkeyed path must keep its `transactionSync`; `idempotent(null, ...)` runs outside one.
  Test 6 plus the existing `:186-189` count catch a regression.
- **Stale replay:** a key reused after the head moved by someone else replays the old 200 for up to 24 h
  (`IDEMPOTENCY_KEY_TTL_MS`). Inherent to keys; callers use one key per decision. D1 covers callers that cannot.
- **Actor fallback** `'system'` in `handleDeployRefs` scopes unauthenticated-actor keys together; harmless (the DO is
  internal, behind `specDoAuthGate`), noted.
- **Not fixed here (finding, open decision D2):** rolling back the *restored* canary re-promotes the one that was
  rolled back. After b is rolled back, a is live and its head's `prev` is b's ref; an SLO rollback of a (`slo.ts:171`,
  canary route, a is live so the guard passes) moves the head to b, and `syncCanaryStatuses` (`index.ts:3706-3719`)
  sets b back to `deployed`. That is a distinct decision, not a redelivery, so per-request idempotency does not touch
  it, but it can put a known-bad candidate back on canary traffic. Fix would be the OPEN-QUESTIONS alternative
  ("move to the last ref whose candidate was not rolled back"), a semantics change to rule 7 that needs its own plan.

## 9. Review asks

1. Is idempotency on the canary route worth it given its liveness guard, or should Part A cover only
   `/deploy-refs/rollback` (smaller diff)? The plan includes it for one uniform helper.
2. Confirm leaving the canary-worker unchanged (no key sent) is correct, given `slo.ts:173` already treats 404/409 as
   handled and `DeployRefsClient.send` never retries.
3. D1: header name `X-Expected-Head` and reusing `version_conflict` as the 409 code.
4. Check the split of `rollbackCanary` keeps every existing direct caller (tests call it through the router only).
5. Confirm D2 is out of scope for this change and should be filed as a new dated OPEN-QUESTIONS entry.

## 10. Open decisions for the maintainer

- **D1:** include the `X-Expected-Head` CAS (recommended; about 10 lines, header-only, mixed-version safe) or ship the
  key alone as decided.
- **D2:** the restored-canary re-promotion hazard (section 8): file it as a separate item, or widen this task.
