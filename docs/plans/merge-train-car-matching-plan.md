# Plan: merge-train cars matched by (position, candidateId)

Status: plan, awaiting independent review (AGENTS.md spine rule 2: promotion-train logic, heavy tier).
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

## 2. Design

**Identify a car by its key `(position, candidateId)`**, the same key the DO uses (`carKey`). No new field, no schema
change, no DO change. A stable car id is not needed: positions are never renumbered and the worker never removes
cars; the key with candidateId also tolerates a non-worker writer that repeats a position for a different candidate.

All changes are in `workers/promotion-worker/merge-train.ts`:

1. Helpers (module-private):
   - `carKey(c)` = `` `${c.position}:${c.candidateId}` ``; `sameCar(a, b)`.
   - `updateCar(cars, key, fn)`: applies `fn` to the **first** car whose key matches, leaves all others untouched
     (exact-key duplicates can only exist from a non-worker write; the DO's Map collapses them too).
   - `latestCar(cars, candidateId)`: the candidate's car with the highest position (ties: last in array).
2. Position for a new car: `Math.max(cars.length, ...cars.map(c => c.position)) + 1` (in the existing CAS mutate,
   `:64`). Same value as today for every worker-written train; stays unique if a car was ever removed or positions
   repeat. (Reviewer may cut this; it is hardening, not the fix.)
3. `processMergeTrain(train)` becomes three CAS writes through `modifyMergeTrain(train.specId, mutate)`:
   - **Claim**: pick the first `waiting` car of the *current* record; set only that key to `merging`. If the
     current record's `id !== train.id`, or there is no waiting car, return `null` (no write) and do not run the gate.
     The claimed key is taken from the saved result (the car at that key is `merging` and was `waiting` before);
     implementation: `mutate` records the chosen key in a closure variable each attempt, the last attempt is the saved one.
   - **Success**: `updateCar(key, merged + mergedAt)` only if that car is still `merging`; `currentPosition = key.position`;
     `nextMerge` and `idle/completedAt` computed from the current record. If the car is no longer `merging`
     (retried/rolled back concurrently), write nothing and log.
   - **Failure**: same guard, `failed + failedAt + failureReason`, `status: 'idle'`.
   Each status change is one CAS write; a concurrent add is re-read, not overwritten.
   `updateMergeTrain` (the blind PATCH wrapper, `:241-246`) is then unused in this file and is deleted from the
   manager (the client method stays; other callers/tests may use it).
4. `executeMergeTrain` response (`:83-85`): find the car by key `(updatedTrain.currentPosition, request.candidateId)`,
   which is the car this call added. Status in the message is still the pre-processing snapshot (pre-existing; see
   "Out of scope").
5. `retryFailedMerge` / `rollbackMergedCandidate`: target `latestCar(train.candidates, candidateId)`; require
   `failed` / `merged` respectively (same error messages); update only that key. Retry with an older failed car and a
   newer car in any other state refuses ("not in a failed state (current: …)") instead of re-running a superseded car.
   No `position` field is added to `/merge/retry` or `/merge/rollback` (see open decision D1).

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
| Old and new worker instances during the push window | An old instance's blind PATCH can still overwrite a new instance's CAS write (as today between two old instances). A new instance's CAS write after an old PATCH just sees a newer version and re-reads. No new failure mode; window ends when old instances drain. |
| Rollback to old worker | Old matching returns; records written by the new worker are valid for the old one (same schema). |

No new request or response field, so the "retry without the field on 400" rule does not apply.

## 4. Tests to add (`workers/promotion-worker/tests/promotion.test.ts`, "Spec DO ledger wiring", real SpecDO)

Gate outcome per call via `mockGateWorkflow.fetch.mockResolvedValueOnce(...)`. Near-misses read with
`spec.listNearMisses({ candidateId, reason: 'train_drop', limit: 50, offset: 0 })`.

1. Re-added after a failure, then merges: car 1 stays `failed` with its original `failedAt` and `failureReason`, car 2
   `merged`; exactly one `train_drop` (`<train>#1`).
2. Re-added after a failure, fails again: car 1's `failedAt`/`failureReason` unchanged, car 2 `failed` with the new
   reason; exactly two near-misses `#1`, `#2`.
3. Promoted twice, both merge (shadow->train, then train->canary): car 1's `mergedAt` unchanged; both `merged`; zero
   near-misses; response `details.position === 2`.
4. Retry: cars `failed`(1) and `failed`(2): `/merge/retry` resets only car 2. Cars `failed`(1), `merged`(2): retry refuses.
5. Rollback: cars `failed`(1), `merged`(2): rollback succeeds (fails today), only car 2 `rolled_back`, near-misses
   `#1` failed and `#2` rolled_back.
6. Lost update: the gate mock, before answering, adds a waiting car for another candidate through the DO
   (`modifyMergeTrain`); after processing that car is still in the record and there is no `removed` near-miss.
7. Claim guard: a train whose only waiting car is changed to `merging` before the claim write (CAS conflict on the
   first save, via a one-shot wrapped fetch) does not call the gate a second time.

Kill checks (state in the PR): reverting the claim/success/failure match to candidateId-only fails 1-3; reverting
`latestCar` fails 4-5; reverting to the blind PATCH fails 6.

## 5. Docs to update
- `docs/OPEN-QUESTIONS.md` 2026-11-01 entry: status -> "Fixed in <sha> (worker-only, matches the DO's car key);
  historic records not repaired", and note the broader cause (every merge-train promotion of a candidate adds a car)
  and the lost-update PATCH found here.
- No ARCHITECTURE/OPS change (no route, schema or deploy change).

## 6. Risks
- Behavior change for `/merge/retry`: an older failed car is no longer retried when the candidate has a newer car.
  No in-repo caller; external callers unknown.
- `rollbackMergedCandidate` now rolls back one car, not all merged cars of the candidate; the candidate stage write
  (`merge-train.ts:470`) is unchanged, so the candidate is still `rolled_back`. Fewer `train_drop` rows per rollback
  (one, not one per merged car). See D2.
- Three CAS writes instead of three blind PATCHes: under contention up to `MAX_CAS_ATTEMPTS` re-reads each, and a
  `VersionConflictError` after the limit now surfaces as an error. On the success/failure write that leaves the car
  `merging` (today the same happens when a PATCH fails). Pre-existing: there is no sweeper for stuck `merging` cars.
- Closure-captured claimed key: must be the value from the attempt that saved; test 7 covers it.

## 7. Out of scope (pre-existing, noted for the OPEN-QUESTIONS entry)
- No check against adding a car for a candidate that already has a `waiting`/`merging` car (`:59-78`); `canPromote` is
  a non-atomic read.
- `getOrCreateMergeTrain` (`:181-202`) can create two trains for one spec under a race (create without version).
- The add response reports the pre-processing status (`waiting`) even when the car merged in the same call.

## 8. Review asks
1. Is `(position, candidateId)` enough, or should a stable car id be added (rejected here: needs an optional schema
   field on a `.strict()` schema read by every peer, for no case the worker can produce)?
2. D1 (maintainer): should `/merge/retry` and `/merge/rollback` accept an optional `position`? Not proposed: the route
   bodies are cast, not parsed strictly, so an old worker would silently ignore the field and act on a different car;
   it would need a capability check, not a 400 retry.
3. D2 (maintainer): rollback of a candidate with several merged cars: latest car only (proposed) or every merged car?
4. Keep or cut the `max(...)+1` position hardening.
5. Is guarding success/failure on "still `merging`" right, or should the result always be written?
