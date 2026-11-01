# Plan: merge-train cars matched by (position, candidateId)

Status: reviewed once (approve with changes, dispositions in section 9); implemented in `1079234`, awaiting the
implementation review (AGENTS.md spine rule 2, heavy tier). Tests are in `workers/promotion-worker/tests/promotion.test.ts`
("Merge train: a car is (position, candidateId)"); 7b (claim exhausts CAS) and a removed-car position test were added.
Finding: `docs/OPEN-QUESTIONS.md` "2026-11-01: merge train matches cars by candidate only, so a re-added
candidate's old car is updated too". Line numbers are against `4cbb0e3`.

## 1. Facts

### How cars are created and positioned
- `executeMergeTrain` adds a car inside one CAS write (`modifyMergeTrain`): `position = current.candidates.length + 1`
  (`workers/promotion-worker/merge-train.ts:59-78`), sets `currentPosition = position`, `nextMerge = candidateId`.
  Positions are 1-based, never renumbered, and the worker never removes a car, so in worker-written trains a
  position is unique. Nothing checks whether the candidate already has a car.
- A candidate gets a second car not only after a failure: `canPromote` allows a new promotion once the previous
  state is `completed`/`failed`/`rolled_back`/`cancelled` (`workers/promotion-worker/state.ts:133-140`), and every
  merge-train-mode `POST /promote` adds a car (`workers/promotion-worker/promotion.ts:91-94`). A candidate promoted
  shadow->train->canary->full in merge-train mode gets three cars, all `merged`. So duplicates are the normal case.
- Schema: `MergeTrainCandidateSchema` (`workers/shared/promotion-ledger.ts:120-130`) is `.strict()`; `position` is
  `z.number().int()` with no uniqueness rule. The DO stores `candidates` as a JSON column (`workers/spec-do/index.ts:3234-3256`)
  and accepts any array on POST/PATCH (`:2939-2962`), so a non-worker writer could repeat positions (the DO tests use
  0-based positions, `workers/spec-do/tests/near-misses.test.ts:150-190`).
- `currentPosition`: after an add, the new car's position (`merge-train.ts:74`); after a merge, the merged car's
  position (`:297`). `nextMerge`: a candidateId (first waiting car, `:374-377`), so it is ambiguous by design but only
  informational; no code reads it back to find a car.

### Every place that finds or updates cars by candidateId (promotion worker)
| Site | Code | Effect with two cars for one candidate |
|---|---|---|
| `merge-train.ts:83-85` | `updatedTrain.candidates.find(c => c.candidateId === …)` | Response reports the **old** car's position/status/mergedAt |
| `merge-train.ts:261-265` | claim: `map(c => c.candidateId === next.candidateId ? merging : c)` | Old car (failed or merged) set to `merging` |
| `merge-train.ts:283-291` | success: same map, `merged`, new `mergedAt` | Old failed car becomes `merged`; old merged car gets a new `mergedAt` |
| `merge-train.ts:316-325` | failure: same map, `failed` | Old car's `failedAt`/`failureReason` overwritten |
| `merge-train.ts:385, 397-401` | `retryFailedMerge`: `find` first car, `map` all | Checks the **first** car only; resets every car of the candidate to `waiting` (a merged car included) |
| `merge-train.ts:443, 455-464` | `rollbackMergedCandidate`: `find` first car, `map` all | Old failed + new merged: throws "not in a merged state" (rollback impossible). All merged: every car `rolled_back` |

Not affected: `tournament.ts:271, 290` refuse a second entry for a candidate, so `tournament.ts:507` is unambiguous.
`index.ts:223-289` (`/merge/retry`, `/merge/rollback`) take `{candidateId, specId}` only; no other worker, the UI
(`workers/api`), the CLI or e2e calls them (grep). `tests/e2e/m3-features.test.ts:526-560` only adds two distinct
candidates and lists trains; `tests/e2e/cross-worker-flows.test.ts:49` has an unused `MergeTrainCar` type.

### Write path to the Spec DO
- `PromotionLedgerClient.modifyMergeTrain(specId, mutate)` (`workers/shared/promotion-ledger.ts:320-329`) is a CAS loop:
  `GET ?specId=` (newest train for the spec), `mutate`, `POST` with `X-Expected-Version` (`casHeaders`, `:361-363`),
  re-read and re-apply on `VersionConflictError` up to `MAX_CAS_ATTEMPTS` (`:365-381`). `mutate` must be pure;
  returning `null` means no write.
- `processMergeTrain` does **not** use it: its three writes are `updateMergeTrain(train.id, patch)` with no expected
  version (`merge-train.ts:241-246, 273, 306, 327`), and the patch carries a whole `candidates` array computed from the
  snapshot passed in. A car added by a concurrent `POST /promote` between the snapshot and the PATCH is dropped from the
  record, and the DO then records a false `removed` `train_drop` near-miss for it (`spec-do/index.ts:3227-3228`).
  Two concurrent `processMergeTrain` runs can also both claim the same waiting car and run the gate twice.
- DO side (`applyMergeTrainWrite`, `spec-do/index.ts:3197-3231`): one `transactionSync`; version check; near-miss
  diff keyed by `carKey = position:candidateId` (`:3214`), `sourceRef = <trainId>#<position>`, deduped by
  `UNIQUE(candidate_id, reason, source_ref)` + `INSERT OR IGNORE` (`schema-inline.ts:777`).

### Near-miss impact of the bug today
Car keys are distinct, so the DO counts correctly: re-add after failure then fail again gives `m#1` (deduped on the
spurious `merging -> failed`) and `m#2`. The damage is the train record (statuses, timestamps, `failureReason`) and
the two bugs above that are not about near-misses: rollback refusing, and the lost-update false `removed` near-miss.

### Existing tests and what they assume
- `workers/promotion-worker/tests/promotion.test.ts:645-660`: one car, `position: 1`, `merged`, train `idle`,
  `nextMerge: null`. Still holds.
- `promotion.test.ts:249-340`: pure array checks on hand-built `MergeTrainCandidate`s; no manager calls.
- `workers/spec-do/tests/near-misses.test.ts:149-192`: already asserts the (position, candidate) model, including
  "a re-added car that fails again is a second fact". No DO change, so these stay as they are.
- `workers/spec-do/tests/promotion-ledger.test.ts:262-315`: route CRUD; unaffected.
- `tests/unit/promotion-candidate-routes.test.ts:99-127`: rollback with a hand-built car that has **no `position`**
  and a spied `modifyMergeTrain`; `latestCar` must cope with an undefined position (keep the first match).
- In production every merge-train car fails today: the gate worker has no `/run` route (`docs/OPEN-QUESTIONS.md`
  2026-10-30, ~:770). So real trains hold failed+failed cars; tests seed the other shapes directly through the DO.


## 2. Design

**Identify a car by its key `(position, candidateId)`**, the same key the DO uses (`carKey`). No new field, no schema
change, no DO change. A stable car id is not needed: positions are never renumbered and the worker never removes
cars; the key with candidateId also tolerates a non-worker writer that repeats a position for a different candidate.

All changes are in `workers/promotion-worker/merge-train.ts`:

1. Helpers (module-private):
   - `isCar(c, key)`: same position and candidateId.
   - `updateCar(cars, key, fn)`: applies `fn` to the **first** car whose key matches, leaves all others untouched
     (exact-key duplicates can only exist from a non-worker write; the DO's Map collapses them too).
   - `latestCar(cars, candidateId)`: the candidate's car with the highest position (ties: last in array). A car with
     an undefined position (hand-built test fixtures) never replaces an earlier match, so with no positions the first
     match is kept.
   - `nextPosition(cars)`: `Math.max(cars.length, ...integer positions) + 1` (kept, per decision). Same value as today
     for every worker-written train; stays unique if a car was ever removed or positions repeat.
2. **No I/O inside any `mutate`.** Timestamps are taken before the CAS call; `mutate` only reads its argument and
   writes the outer `claim` holder.
3. `processMergeTrain(train)` (FIFO; one gate call per run):
   - **Claim** (one CAS write via `modifyMergeTrain(train.specId, ...)`): every `mutate` call starts with
     `claim = null`. If the current record's `id !== train.id`, or it has no `waiting` car, return `null` (no write).
     Otherwise set `claim` to the first waiting car and return the record with only that key set to `merging`. The
     gate runs only if `claim !== null` after the call. The returned record is never used to infer the claim:
     `casLoop` returns the current record when `mutate` returns `null` (`workers/shared/promotion-ledger.ts:369`).
     The claim does not require that no car is `merging` (a stuck car must not block the train), so different cars
     may run their gates concurrently, as today (maintainer default: unchanged; see review ask 4).
   - **Claim write fails** (e.g. `VersionConflictError` after `MAX_CAS_ATTEMPTS`): logged, no gate call,
     `processMergeTrain` returns normally. `executeMergeTrain` still returns success (the car was added and stays
     `waiting` for the next run), so the promotion is not marked failed and a re-promote does not create a second
     live car.
   - **Gate**: `try` wraps only `executeMerge(claim)`. The outcome is `merged` or `failed` with the error message.
   - **Finish** (one CAS write, after the `try`): `updateCar(key, merged + mergedAt | failed + failedAt +
     failureReason)` only if that car is still `merging` in the current record; success sets `currentPosition =
     key.position`, `nextMerge` and `idle/completedAt` from the current record (as today); failure sets `status:
     'idle'` (as today). If the car is no longer `merging`, write nothing and log: no worker path moves a car out of
     `merging`, so this guard is defensive against non-worker and old-worker writes. A finish write error is logged
     and rethrown and leaves the car `merging`; a car whose gate passed is never marked failed. The rethrow reaches
     the caller (`executeMergeTrain` / `retryFailedMerge` report `success: false` with the message).
   - The blind-PATCH wrapper `updateMergeTrain` (`:241-246`) is deleted from the manager (the client method stays).
4. `executeMergeTrain` add (`:59-78`): `position = nextPosition(current.candidates)`. Response (`:83-85`): the car
   with key `(updatedTrain.currentPosition, request.candidateId)`, which is the car this call added. The status in the
   message is still the pre-processing snapshot (pre-existing; out of scope).
5. `retryFailedMerge`: target `latestCar(candidateId)`; require `failed` (same error messages); reset only that key.
   An older failed car with a newer car in another state refuses ("not in a failed state (current: ...)").
6. `rollbackMergedCandidate` (decision D2): `latestCar(candidateId)` must be `merged` (same error message); then mark
   **every** `merged` car of the candidate `rolled_back` (today's candidate-level behavior, restricted to merged cars;
   one `train_drop` near-miss per car). Failed/waiting cars of the candidate are untouched. The candidate stage write
   (`:470`) is unchanged.

### Known limitation (not fixed here)
A car stuck in `merging` (worker crash/eviction between the claim and the finish write, or a finish write that
exhausted CAS) has no recovery and counts against `MAX_CONCURRENT_CANDIDATES`. A lease (claim time + expiry) needs a
schema field; follow-up recorded as a dated `docs/OPEN-QUESTIONS.md` entry. Test 9 pins that a stuck car does not stop
the next car from being processed.

### Trains that already hold duplicate-candidate cars
No migration, no repair. Past wrong statuses cannot be told apart from real ones (an old car showing `merged` may have
been failed). Going forward the fix only touches the targeted car, so existing records stay as they are and new writes
are correct. Exact-key duplicates (same position and candidate, only from a non-worker write) are handled by "first
match only". Near-miss rows are unaffected (already per car).

## 3. Mixed-version table

The DO, the shared schema and the wire format do not change; only the promotion worker's choice of which car to
change and the write method (CAS POST instead of blind PATCH; CAS POST is already used by this worker for adds,
`merge-train.ts:59`, and served by every deployed DO since m8, `spec-do/index.ts:1141, 1291`).

| Combination | Behavior |
|---|---|
| New worker / old DO | Old DO = current DO (no DO change in this plan). Works. |
| Old worker / new DO | Same as today; new DO is identical. |
| Old and new worker instances during the push window | An old instance's blind PATCH can still overwrite a new instance's CAS write (as today between two old instances). A new instance's CAS write after an old PATCH sees a newer version and re-reads; if the old PATCH moved the claimed car out of `merging`, the finish guard skips the write. No new failure mode. |
| Rollback to old worker | Old matching returns; records written by the new worker are valid for the old one (same schema). |

No new request or response field, so the "retry without the field on 400" rule does not apply.

## 4. Tests to add (`workers/promotion-worker/tests/promotion.test.ts`, real SpecDO)

Gate outcome per call via `mockGateWorkflow.fetch.mockImplementation(...)` (set in each test). Near-misses read with
`spec.listNearMisses({ candidateId, reason: 'train_drop', limit: 50, offset: 0 })`. Trains in the old-code shapes
(failed+failed, failed+merged, merged+merged) are seeded directly through the DO (`POST /merge-train-status`), since in
production every car fails (no gate `/run` route, `docs/OPEN-QUESTIONS.md` 2026-10-30).

1. Re-added after a failure, then merges: car 1 stays `failed` with its original `failedAt` and `failureReason`, car 2
   `merged`; exactly one `train_drop` (`<train>#1`).
2. Re-added after a failure, fails again: car 1's `failedAt`/`failureReason` unchanged, car 2 `failed` with the new
   reason; exactly two near-misses `#1`, `#2`.
3. Promoted twice, both merge: car 1's `mergedAt` unchanged; both `merged`; zero near-misses; response
   `details.position === 2`.
4. Retry (seeded): `failed`(1)+`failed`(2): only car 2 is reset and re-run. `failed`(1)+`merged`(2): refuses.
5. Rollback (seeded): `failed`(1)+`merged`(2): succeeds (fails today), car 1 stays `failed`, car 2 `rolled_back`.
   `merged`(1)+`merged`(2): both `rolled_back`, near-misses `#1` and `#2`.
6. Lost update: the gate mock, before answering, adds a waiting car for another candidate through the DO; after
   processing that car is still in the record and there is no `removed` near-miss.
7. Claim race: a DO wrapper performs a real DO write between the claim's GET and POST that sets the only waiting car
   to `merging` (another claimer). Asserts: gate called 0 times; the car is left exactly as the other claimer wrote it;
   `executeMergeTrain` still returns success. (Old code ignores the version and runs the gate.)
8. Finish write exhausts CAS: gate passes; every finish POST answers a version conflict (`MAX_CAS_ATTEMPTS` times).
   Asserts: the car is `merging`, not `failed`; no near-miss.
9. Stuck car: a seeded train with a car stuck `merging`; a new add is claimed and merged; the stuck car is unchanged.

Kill checks (temporarily revert, confirm the named test fails, restore): candidateId-only matching fails 1-3;
`latestCar` -> first match fails 4-5; blind PATCH finish fails 6; blind PATCH claim fails 7; `try` covering the
finish write fails 8.

## 5. Docs to update
- `docs/OPEN-QUESTIONS.md` 2026-11-01 car-matching entry: status -> fixed with the commit (worker-only, matches the
  DO's car key; historic records not repaired); note the broader cause (every merge-train promotion of a candidate adds
  a car) and the lost-update PATCH found here.
- New dated `docs/OPEN-QUESTIONS.md` entry: stuck `merging` car, no recovery, blocks capacity; a lease needs a schema
  field.
- No ARCHITECTURE/OPS change (no route, schema or deploy change).

## 6. Risks
- Behavior change for `/merge/retry`: an older failed car is no longer retried when the candidate has a newer car.
  No in-repo caller; external callers unknown.
- Three CAS writes instead of blind PATCHes: under contention up to `MAX_CAS_ATTEMPTS` re-reads each. A failed claim
  leaves the car `waiting`; a failed finish leaves it `merging` (known limitation above).
- Closure-held claim: reset at the start of every `mutate` call; test 7 covers the "mutate returned null" path.

## 7. Out of scope (pre-existing, noted for the OPEN-QUESTIONS entry)
- No check against adding a car for a candidate that already has a `waiting`/`merging` car (`:59-78`); `canPromote` is
  a non-atomic read.
- `getOrCreateMergeTrain` (`:181-202`) can create two trains for one spec under a race (create without version).
- The add response reports the pre-processing status (`waiting`) even when the car merged in the same call.

## 8. Decisions (maintainer defaults; the maintainer may still change them)
- D1: no optional `position` on `/merge/retry` or `/merge/rollback` (route bodies are cast, not strictly parsed, so an
  old worker would silently ignore it and act on a different car).
- D2: rollback checks the latest car's state, then marks every merged car of the candidate `rolled_back`.
- `nextPosition` hardening (`max(...)+1`) kept.
- Concurrency unchanged: different cars may run their gates concurrently.

## 9. Review 1 dispositions (approve with changes, no blockers)
1. Claim detection via the returned record is unsafe (`casLoop` returns current on `null`): adopted, section 2.3.
2. `try` wraps only the gate; finish write errors logged + rethrown, car stays `merging`: adopted; test 8.
3. Claim exhausting CAS: logged, add still succeeds, car stays `waiting`: adopted; test 7 asserts success.
4. No "no car merging" claim precondition; concurrent gates for different cars as today: adopted; review ask 4.
5. Stuck merging car: guard documented as defensive; known limitation + OPEN-QUESTIONS follow-up; test 9: adopted.
6. Test 7 must fail on old code (0 gate calls, real DO write between GET and POST); kill checks extended: adopted.
7. Seed old-shape trains through the DO for tests 4-5; cite the no-`/run` finding: adopted.
8. `tests/unit/promotion-candidate-routes.test.ts` fixtures lack `position`: `latestCar` keeps the first match.

## 10. Review asks (for the implementation review)
1. Is `(position, candidateId)` enough, or should a stable car id be added (rejected here: needs an optional schema
   field on a `.strict()` schema read by every peer, for no case the worker can produce)?
2. Is the finish guard ("still `merging`") right, or should the outcome always be written?
3. Is rethrowing a finish write error (promotion reported failed while the car stays `merging`) the right surface?
4. Alternative to keep in mind: strictly sequential trains (claim only when no car is `merging`), which needs the
   stuck-car lease first.
