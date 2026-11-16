---
category: audit
status: active
audience: human,agent
---

# Review, slice b1: promotion decision (2026-11-16)

This is step 2 of the whole-repo review. The slices and context are in `docs/reviews/2026-11-15-architecture-map.md`.

An independent Fable agent did a read-only pass at `f4008e2`. Its probes ran against the real Spec DO on node:sqlite in a scratch worktree. The orchestrator checked both must-fix findings against the code:
- M1: `workers/spec-do/index.ts:5011-5017` checks only the canary head and the soak time.
- M2: `merge-train.ts` sends `actorId: 'promotion-worker'`, and `gate_verdicts.decided_by` references `actors(id)` (`schema-inline.ts:146`).

No finding is fixed yet. Each fix follows the usual plan, review and implement steps.

**Verdict: request changes.** `advance` itself is sound: one transaction, correct ordering, safe while old and new versions run side by side, and well tested. But the last enforced rung passes on a timer, merge-train mode cannot merge against a real ledger, and the stage PATCH still reaches `promoted` without going through `advance`.

## Must-fix

**M1. The enforced canary rung is a 15-minute timer; it consults no SLO result.** `workers/spec-do/index.ts:5011-5017`
- `advance(full)` checks only that the candidate is the canary head and that `now - movedAt >= 15 min`. The only negative signal is a rollback by the SLO loop.
- That loop rolls back only on `violation` with auto-rollback on (`workers/canary-worker/slo.ts:163-169`). `insufficient_data` (fewer than 50 requests) is "the normal state for a quiet canary" (`docs/OPS.md:478-480`).
- Scenarios that end in `promoted`:
  - a quiet canary with zero requests;
  - auto-rollback switched off (`autoRollback: false`, or `POST /canary/:id/auto-rollback`) while in violation;
  - a canary rolled back for SLO, then redeployed (a rollback leaves `candidates.stage` at `passed_train`), then 15 quiet minutes;
  - the tick queue down (`max_retries = 0`).
- Probe: pre-merge verdict flipped to `fail`, shadow verdict `fail`, no merged car, canary aged 16 minutes. `advance(full)` answered 200 and the stage became `promoted`.
- History: plan section 3.4 / N2 chose "live head, soaked" on purpose, so this is a design gap, not a regression.
- Fix: inside the transaction, require a `healthy` verdict computed from `canary_metrics` over the soak window (a minimum request count, thresholds met). Treat `insufficient_data` and `unavailable` as `evidence_missing`.

**M2. Merge-train mode cannot merge a car in a deployed stack (foreign key).** `workers/promotion-worker/merge-train.ts:463-470`
- The gate call sends `actorId: 'promotion-worker'`, and the gate writes it as `decidedBy` (`workers/gate-workflow/index.ts:342, 950`).
- `gate_verdicts.decided_by` references `actors(id)`, and no such actor is ever created.
- Probe: `POST /api/gate-verdicts` with that `decidedBy` answered 500 `FOREIGN KEY constraint failed`.
- Inferred for the remaining hop: the gate answers 500, `executeMerge` throws, and every car ends `failed` / `409 gate_failed`.
- Tests miss it because `advance-flow.test.ts:46` mocks the gate.
- Known: OPEN-QUESTIONS 2026-11-10 ("not verified at runtime"). It is now verified at the Spec DO.
- Fix: create a reserved actor lazily (as for `scientist-comparator`) or pass the `/promote` caller's actor. Add one test that wires the real gate handler to the real Spec DO.

## Should-fix

**S1. The stage PATCH bypasses `advance` completely.** `workers/spec-do/index.ts:4431-4434`, `:1656-1663`
- Probe: `PATCH /stage {stage:'promoted'}` on a `pending` candidate answered 200 and set `promoted`. The only trace is an `invalid_transition` log row.
- Who can call it: the master token through the edge (`workers/api/index.ts:1793`), and every worker that holds the internal token.
- The log-only check was a documented PR-S decision.
- Fix: refuse upward ladder moves on this route, and keep `failed` / `rolled_back` open (rule 7).

Every write path to candidate stage or promotion state:

| Path | Bypasses `advance`? |
|---|---|
| `advance` (`:4983`) | It is the path. |
| Stage PATCH | **Yes**, to any stage. |
| `POST /api/gate-verdicts` (master or internal) | Indirectly: a hand-posted `pass` satisfies the enforced pre-merge evidence. |
| `POST /canary-deployments` | No. It accepts a `pending` candidate, but `advance(full)` then answers `409 not_next_rung`. One stage PATCH to `passed_train` plus a canary gave `promoted` (probe). |
| Legacy `POST /api/promotions` | No. It inserts a `pending` row and leaves the stage alone (dead ledger). |
| `/promote/:id/retry`, `/merge/retry` | No. Both end in `advance`. |
| `/merge/rollback` | Writes `rolled_back` through the stage PATCH. |
| Direct writes to `/merge-train-status` | Can fabricate a merged car. Train evidence is log-only anyway. |
| `rollbackHead` update of `promotions WHERE stage='active'` (`:3867`) | Never matches, because nothing writes `active`. |

**S2. A thrown ledger call leaves a promotion state that blocks the candidate.** `promotion.ts:124-157`, `state.ts:132-139`
- If `transitionToInProgress`, `markAsCompleted` or `markAsFailed` throws (one Spec DO 5xx), `/promote` answers 500 and the state stays `pending` or `in_progress`.
- From then on, every `/promote` gets `409 Promotion already in progress` until someone calls `/cancel`.
- If the throw is in `markAsCompleted`, the stage has already moved, yet the caller sees 500.
- `PROMOTION_TIMEOUT` is declared and never read.
- Fix: treat a state older than the timeout as abandoned, and make the bookkeeping after the move best effort, as `recordMove` already is.

**S3. `/merge/rollback` has three defects.** `index.ts:274-277`, `merge-train.ts:567-630`
- It always answers HTTP 200, even with `success: false`.
- It marks the car `rolled_back` first. If the stage PATCH then fails, a retry is refused ("not in a merged state", `:583`), so the stage write can never complete.
- It moves no deploy ref. A candidate that is the live canary head becomes `rolled_back` while its canary stays deployed and mirrored (rule 7).

**S4. A failure after the winner's advance corrupts the tournament (inferred).** `tournament.ts:184-192, 240`
- If `recordWinner` throws after `advance` succeeded:
  - the tournament is recorded `failed` and one attempt is spent;
  - the caller gets 500;
  - the requester's promotion state is `failed`, although the winner is at `passed_shadow`.
- On retry the winner is past the rung, so the loser gets `not_enough_entrants`. A later third entrant then produces a second winner.
- Fix: write the winner with a version-checked write before `advance`, or reconcile "winner already past the rung" into `completed`.

**S5. The default tournament score has no minimum sample count.** `tournament.ts:438`, `spec-do/index.ts:5144`
- One sample at 100 beats 500 samples averaging 99.
- Only production mode requires a minimum.
- Fix: require the same minimum, or a shadow verdict that is not pending.

**S6. Nothing stops two tournaments for one spec.**
- Probe: two `POST /tournament-status` calls for the same spec both answered 201, giving two rows. When the first two candidates arrive together, each creates a tournament, and one entrant is left alone in the older row.
- Same class as the merge-train race (known 2026-11-01).

**S7. `POST /mode` turns off the worker-side shadow refusals.** `promotion.ts:111, 137-145`
- With mode `merge-train`, `/promote toRung=train` is a direct `advance`.
- Probe: `advance(train)` with a `fail` shadow verdict answered 200.
- This matches the documented log mode, but the mode is global and anyone with the bearer token can set it.

**S8. Evidence is stored per candidate, not per commit (partly inferred).**
- `gate_verdicts` is one row per (candidate, gate) (`spec-do/index.ts:1889`), and pre-merge is checked only when leaving `pending`.
- The merge-train gate call overwrites that row.
- The canary check does not compare the head's `commitSha` with the candidate's.

**S9. Guards with no test.** Each of these mutations left every promotion-worker test passing:
- the `canPromote` refusal (`promotion.ts:85`);
- retry requiring a `failed` state (`:327`);
- the cancel state guard (`:393`);
- rollback requiring a `merged` car (`merge-train.ts:583`);
- the capacity re-check inside the CAS write (`:109`);
- the 409-code allowlist (`spec-do.ts:158`).

## Nits

- The coded 404 travels in `error`, not `code` (`promotion-worker/spec-do.ts:154`). Both sides agree, so it works.
- A bad `fromRung` turns a Spec DO 400 into `502 ledger_error`.
- A JSON `null` body on `/promote` gives a 500.
- `/health` and `GET /mode` throw uncaught when the Spec DO is down.
- An unset `MAX_CONCURRENT_CANDIDATES` parses to NaN, which means no capacity limit (`merge-train.ts:87`).
- The 100 ms sleep at `merge-train.ts:497` does nothing useful.
- `/cancel` only relabels the state; a car already in the queue still merges.
- The refusal for `failed` / `rolled_back` says "pass the rungs again with a new commit", but nothing updates `commit_sha` and the execute reset is retired.
- Dead code: `queues.ts`, the `promotion-events` consumer, the `PREVIEW_MANAGER` and `SHADOW_ROUTER` bindings, `PROMOTION_TIMEOUT`.

## Contracts verified correct

- **`advance` with old and new versions live together.** An old Spec DO's 404 without a code becomes `503 ledger_too_old`, writes nothing and disqualifies no one. A 404 with a code becomes `candidate_not_found`. Mutating that split fails 2 tests.
- **Ordering and atomicity.** The no-op check comes before the stale check, a dry run writes nothing, and the two-write `full` is atomic.
- **Evidence modes.** Applied as documented. Log mode never refuses inside the Spec DO; the only place it blocks is the tournament branch, which is documented.
- **Gate answer.** A car merges only on `success === true && result.status === 'pass'`. Mutating that fails 6 tests.
- **`Response.ok`.** Checked on every promotion-worker fetch.
- **CAS.** The merge-train claim and outcome writes are version-checked. So are the tournament add and disqualify writes; `recordWinner` is not (see the known items).

## Known items re-checked

| Item | Still true? |
|---|---|
| 2026-11-10: the gate `actorId` is not an actor | Yes, now verified (M2). |
| 2026-11-10: shadow and train evidence are log-only | Yes. |
| 2026-11-10: the tournament decides on the second arrival | Yes, and wider than recorded. A completed tournament is terminal and each spec has one, so in the default mode no later candidate of that spec can ever pass shadow -> train. |
| 2026-11-10: `SHADOW_ROUTER` binding unused | Yes. |
| 2026-11-10: an exhausted tournament has no reset | Mostly. One accidental reset exists: with fewer than two competing entrants the worker writes `pending`, which zeroes the attempts (`tournament.ts:117`). |
| 2026-11-10: the queue acks failed promotions | Yes. The queue still has no producer. |
| 2026-11-10: decisions can overlap | Yes. `recordWinner` is a versionless PATCH from a stale copy (`tournament.ts:494`), and the comment at `:485` is wrong. |
| 2026-11-10: a merged car that `advance` refused stays `merged` | Yes. |
| 2026-11-01: a car stuck in `merging`; a waiting car with no driver | Yes, both. |
| 2026-11-01: cars matched by candidate only | Fixed (`isCar`). |

## What was run

- `npx vitest run workers/promotion-worker workers/shared workers/spec-do/tests/advance.test.ts`: 220 of 220 passed.
- `npm run typecheck`: clean.
- In a scratch worktree, since removed:
  - a 6-case probe against the real Spec DO;
  - 23 single-line mutations of promotion-worker guards. 16 were caught by a test, 6 were not (S9), and 1 changed no behavior.
- Not run: e2e, any worker, any network call, or the gate worker end to end (M2's last hop is inferred).
