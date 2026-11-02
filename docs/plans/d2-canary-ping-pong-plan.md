# Plan: D2, rollback must never re-promote a rolled-back ref

Task: `d2-canary-ping-pong` | Spec: `docs/OPEN-QUESTIONS.md` "2026-11-01: rolling back the restored canary re-promotes the
rolled-back one (D2)" | Tier: heavy (AGENTS.md rule 2 spine: DO ledger; rule 7: rollback is a ref operation).
Status: **draft, awaiting independent review (nothing implemented).**

## 1. Facts (line numbers at `2fe3c3b`)

- `rollbackHead` (`workers/spec-do/index.ts:3803-3846`) moves the head to the target of `head.prevRefId` only. Both
  rollback routes end here: `POST /deploy-refs/rollback` (`:3520-3528`) and `rollbackCanary` (`:3648-3660`, guarded: 409
  unless that deployment is the live head). `moveDeployRef` (`:3770`) always sets `prev_ref_id = old head`, so after a
  rollback the new head's `prev` is the ref that was just rolled back.
- `syncCanaryStatuses` (`:3849`) sets the head's newest canary deployment `deployed`, even when it was `rolled_back`
  (`live.status !== 'deployed'`), and supersedes the other `deployed` ones.
- The SLO loop (Spec DO alarm, 60 s, `CANARY_TICK_INTERVAL_MS`) evaluates every live canary head over a 15 minute window
  and rolls back violations (`workers/canary-worker/slo.ts:~155-180`, `rollback.ts:36`); 404/409 count as handled.
- `deploy_refs` is append-only, `action IN ('promote','rollback')`, unique `prev_ref_id`, head = the row nobody
  points at (`index.ts:144`, `schema-inline.ts:560-575`). Chains are per (spec, rung); `rung` is `canary` or `full`.
- Merged: Idempotency-Key and `X-Expected-Head` on `/deploy-refs/rollback` (`docs/plans/rollback-idempotency-plan.md`).
  They make a *redelivery* safe; each flip below is a new decision, so they do not help.
- Tests that pin today's behavior: `workers/spec-do/tests/deploy-refs.test.ts:168-179` ("two distinct rollbacks toggle
  back: known hazard pending D2"); also check `near-misses.test.ts:~200`, `canary-alarm.test.ts:~130`,
  `canary-metrics.test.ts:~125`, `tests/e2e/cross-worker-flows.test.ts:114-124, 420` for chains that roll back twice.
  Docs: `docs/OPS.md:416-432` states the toggle.

### The loop

Deploy A (r1), deploy B (r2, prev r1). B violates: rollback -> r3 = copy of A, prev r2; A marked `deployed`. A violates
(its window holds its own bad samples): rollback guard passes (A is the live head), `head.prev` = r2 = B, so r4 = copy
of B, prev r3; B marked `deployed` again. B still violates over its 15 minute window: rollback again. Each flip is a new
decision, writes an `slo_rollback` near-miss, and repeats about every 60 s until someone intervenes. Two failing canaries
alternate indefinitely.

## 2. Design

One change, in `rollbackHead` only: choose the target by walking the chain instead of taking `head.prevRefId`.

1. Read the chain for (spec, rung) into a map (as `listDeployRefs` does, `:3553`).
2. `withdrawn` = `{ X.prevRefId : X in the chain from head to root, X.action = 'rollback' }`. A rollback ref's `prev` is
   by construction the ref that was rolled back, so this is exactly "refs that were rolled back", derived from
   immutable rows. No new column, no dependence on near-misses (best-effort, per-candidate) or on
   `canary_deployments.status` (mutable, canary-only; `full` rung would be uncovered).
3. Walk `ref = head.prevRefId`, following `prevRefId`. The **target** is the first ref that is not in `withdrawn` and
   whose `(candidateId, workerVersionId)` differs from the head's (a ref equal to the head's identity is the thing
   being rolled back, e.g. the original deploy of A when the head is the rollback copy of A). If the walk reaches the
   root, the target is the empty ref (null candidate/commit/version), as today. A visited-set bounds the walk against a
   corrupt chain (treat a cycle or a dangling `prev` as end of chain, i.e. empty ref).
4. Everything else is unchanged: exactly one ref is appended (`action 'rollback'`, `prev` = old head), the head's
   candidate gets its `slo_rollback` near-miss and active promotion update, the head's deployment is marked
   `rolled_back`, and `syncCanaryStatuses` runs. The response shape is unchanged.

Result on the trace: roll back B -> A (r3). Roll back A: `withdrawn = {r2}`; skip r2 (withdrawn), skip r1 (same identity
as the head, A) -> empty ref. No live canary, `liveRefs` is empty, the alarm chain stops. The loop ends after one
extra flip, not never.

Consequences to accept:

- **Rolling back twice no longer toggles.** The second rollback goes further back or to empty. This inverts the
  existing test and the OPS sentence; it is the intended fix. Manual and automatic rollbacks behave the same.
- Rolling back an empty head stays empty (previously it re-promoted the last candidate).
- A candidate that is deliberately redeployed gets a *new* `promote` ref (new id), so it is eligible again; only the
  specific rolled-back ref is withdrawn. Whether a deliberate redeploy of a rolled-back worker version should be
  allowed at all is a deploy-side question, out of scope.
- `syncCanaryStatuses` keeps its resurrection of `rolled_back` heads. After this change a rollback can no longer put a
  `rolled_back` deployment back at the head, so that branch is only reachable by a deploy of the same worker version
  (newest deployment row, so not the old one). Left as is; a test pins it.

### Alternatives rejected

- **Near-miss lookup** (the OPEN-QUESTIONS idea): per-candidate, written best-effort, deduped on `(candidate, reason,
  source_ref)`, and a redeployed candidate would stay blocked forever. The chain says it with exact refs.
- **`canary_deployments.status = 'rolled_back'`**: mutable (sync flips it back), canary-only.
- **Cooldown / hysteresis in the SLO loop**: papers over the pointer semantics, adds state and time dependence, and
  leaves the manual route toggling.
- **Reject a rollback when the target is withdrawn** (409): leaves a failing canary live.

## 3. Mixed-version window (one push deploys all ten workers)

Spec DO only; no route, request, response or schema change; callers are untouched. Old DO + new callers: identical
traffic, old behavior (loop persists, no new harm). New DO + old callers: same. Rollback floor: no schema, nothing to
tolerate. Existing already-toggled chains need no repair: the walk reads refs as they are.

## 4. Tests to add (real SQL through the real router, `deploy-refs.test.ts` style)

1. The D2 trace (A, B, roll back B, roll back A): head is the empty ref, `liveRefs` empty, both deployments
   `rolled_back`, exactly 2 near-misses (B, A), 4 refs.
2. Three canaries (A, B, C): roll back C -> B, roll back B -> A, roll back A -> empty (chain walk never revisits).
3. Old test inverted: A, B, two `/deploy-refs/rollback` calls (no key) end at the empty ref, not B.
4. Single rollback is unchanged: restores A, A `deployed` (existing test, kept).
5. Redeploy after rollback: A, B, roll back B, deploy B again (new ref), roll back B -> A (not empty: the restore copy
   of A is not withdrawn and has a different identity than the new head).
6. `full` rung: same chain behavior via `/deploy-refs/rollback` (ref moves are written by seeding `deploy_refs` or a
   test helper, since only `deployCanary` moves refs today).
7. Empty head rolls back to empty (no re-promotion); the appended ref's `action` is `rollback`.
8. Corrupt chain (dangling `prev_ref_id`, seeded with FKs off): ends at the empty ref, no throw, no infinite loop.
9. Transaction count unchanged (`store.transactions.count` delta 1), `X-Expected-Head` and Idempotency-Key tests from the
   previous plan still pass.
10. SLO loop level (canary-worker or `canary-alarm.test.ts` style): two violating canaries, run the cycle until quiet;
    assert the cycle count to quiet is bounded (<= 3) and the second cycle answers 404/409 as `alreadyHandled`, not a
    new rollback. If a harness for this does not exist, record that and rely on test 1.

## 5. Docs to update

- `docs/OPS.md:416-432`: rollback goes to the nearest earlier ref that was not itself rolled back and is not the
  head's own candidate, else the empty ref; two rollbacks no longer toggle; the manual way to bring a rolled-back
  version back is a new deploy.
- `docs/OPEN-QUESTIONS.md`: D2 status -> Fixed (task id, commit), keep the alternatives paragraph.
- `docs/FOCUS.md`: remove D2 from "Next"; `docs/ARCHITECTURE.md` only if it states the toggle (grep first).
- Test names/comments that say "known hazard pending D2" (`deploy-refs.test.ts:167`, `docs/plans/rollback-idempotency-plan.md`
  is history, leave).

## 6. Files touched

`workers/spec-do/index.ts` (`rollbackHead` plus one private helper), `workers/spec-do/tests/deploy-refs.test.ts` (+ any
other test found by section 1), `docs/OPS.md`, `docs/OPEN-QUESTIONS.md`, `docs/FOCUS.md`. Four files, one function.

## 7. Risks

1. **Behavior change on manual rollback** (no toggle). Intended; stated in OPS and release notes of the handoff.
2. **Wrong `withdrawn` set** if a rollback ref's `prev` were ever not the rolled-back ref: `moveDeployRef` is the only
   writer and always sets `prev = head.id`; test 1/2 pin it. Hand-seeded rows (seed.ts, tests) are the exposure.
3. **Chain size.** The map load is O(refs per spec and rung), same as `listDeployRefs`, only on rollback.
4. **Stale metrics for a restored canary.** A restored A is judged on a 15 minute window that includes its earlier life.
   Not changed here; with this fix it can cost at most one further rollback to empty, not a loop.
5. **Empty ref as terminal state.** Traffic falls back to no canary; same as rolling back the first canary today.

## 8. Review asks

- Is `withdrawn = prev of rollback refs` sound for every writer of `deploy_refs` (grep all `INSERT INTO deploy_refs`,
  `moveDeployRef` call sites, seed, tests, migrations)?
- Does the identity skip (`candidateId`, `workerVersionId`) mis-skip a legitimate target (same candidate deployed with a
  different version; null candidate ids on `full`)? Is `workerVersionId` alone or `candidateId` alone better?
- Any other path that can re-promote a withdrawn ref (`deployCanary` re-using a worker version, `syncCanaryStatuses`,
  tournament or promotion-worker rollback in `promotion-worker`, `liveRefs` consumers)?
- Is a second loop possible with a third party (A, B, C all failing) or with `autoRollback = false` on the restored one?
- Is the test list enough to kill a mutant that removes the withdrawn set, or the identity skip, or the cycle guard?

## 9. Open decisions for the maintainer

- **D2a:** manual rollback also stops toggling (recommended: one rule, one meaning of "rollback"). The alternative, only
  automatic rollbacks skip withdrawn refs, keeps a manual "undo" but needs the caller to say which, and the canary
  route cannot (it takes only `{reason}`).
