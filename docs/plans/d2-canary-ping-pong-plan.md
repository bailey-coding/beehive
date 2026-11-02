# Plan: D2, rollback must never re-promote a rolled-back ref

Task: `d2-canary-ping-pong` | Spec: `docs/OPEN-QUESTIONS.md` "2026-11-01: rolling back the restored canary re-promotes the
rolled-back one (D2)" | Tier: heavy (AGENTS.md rule 2 spine: DO ledger; rule 7: rollback is a ref operation).
Status: **rev 2 after Review 1 (reject as written, approve once B1 fixed); section 2 awaits a verification pass (section 8). Nothing implemented.**

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

## 2. Design (rev 2; supersedes rev 1, whose ref-id `withdrawn` set looped for 3+ refs, Review 1 B1)

One change, in `rollbackHead` only: choose the target by walking the chain by **identity**, not `head.prevRefId`. Target
selection lives in one private helper (`rollbackTarget`) so the governance plan's "ineligible target -> empty ref" rule
(`docs/M5A-2-GOVERNANCE-PLAN.md:202, 255`, PR-G) can extend it later.

1. `chain = listDeployRefs(specId, rung)` (head -> root). `key(ref) = workerVersionId ?? candidateId ?? 'empty'`, namespaced
   by kind so a version id and a candidate id cannot collide. (Every canary operation already keys on the worker version,
   `index.ts:3653, 3836, 3868`; the candidate id is the fallback for `full` refs, which carry no version.)
2. `withdrawn = { key(head) }`. Walk `i = 0..`:
   - `chain[i].action === 'rollback'`: its successor `chain[i+1]` is what that rollback undid, so add `key(chain[i+1])` to
     `withdrawn`; continue. A rollback copy is **never** a target (the promote row it copies is below it).
   - a `promote` ref whose key is in `withdrawn`: skip.
   - the first other `promote` ref is the target. End of chain: the empty ref (null candidate, commit, version), as today.
3. A rollback only withdraws rows **older than itself**, so a deliberate redeploy (a newer `promote` row) stays eligible.
   Each rollback adds the head's identity to the withdrawn set until a new deploy, so N distinct identities take at most
   N rollbacks: the loop is bounded. A dangling `prev_ref_id` just ends the chain (the map lookup is `undefined`);
   no visited-set is needed (`idx_deploy_refs_prev` makes a cycle impossible, N1).
4. Everything else is unchanged: exactly one ref is appended (`action 'rollback'`, `prev` = old head, via `moveDeployRef`),
   the head's candidate gets its `slo_rollback` near-miss and active promotion update, the head's deployment is marked
   `rolled_back`, `syncCanaryStatuses` runs. Response shape unchanged.

Traces (rolling back repeatedly; `->e` = the empty ref, then quiet): A,B: b->a, a->e. A,B,C: c->b, b->a, a->e.
A,B,A(redeploy): a->b, b->e. Z,A,A (same version twice): a->z, z->e. A,B,roll back,B,C: c->b, b->a, a->e.
`full` rung A,B,C (null versions): b, a, e, e, e. A legacy toggled chain (A,B plus four rollback rows) ends at e.
All were run by the reviewer against a prototype of this algorithm (937 pass; the only failures were the toggle pins, S3).

Consequences to accept:

- **Rolling back twice no longer toggles**; rolling back repeatedly walks down the chain and stops at the empty ref. Manual
  and automatic rollbacks behave the same. An unkeyed retry of `/deploy-refs/rollback` now drops one more ref instead of
  toggling (S5); send `Idempotency-Key`. The canary route is unaffected (its liveness guard returns 409).
- Rolling back an empty head stays empty. Bringing a rolled-back version back is a new deploy.
- A restored target is always a non-withdrawn `promote` row, so `syncCanaryStatuses` never resurrects a `rolled_back`
  deployment through a rollback (S6). That branch (`index.ts:3859`) also serves the normal superseded->deployed restore
  (`deploy-refs.test.ts:163`); leave it unchanged.

### Alternatives rejected

- **Near-miss lookup** (the OPEN-QUESTIONS idea): per-candidate, best-effort, deduped on `(candidate, reason, source_ref)`;
  a redeployed candidate would stay blocked.
- **`canary_deployments.status = 'rolled_back'`**: mutable (sync flips it back), canary-only.
- **Ref-id withdrawn set (rev 1)**: loops from three refs on, because the original promote row of a withdrawn copy stays
  eligible (Review 1 B1).
- **Cooldown / hysteresis in the SLO loop**: papers over the pointer semantics and leaves the manual route toggling.
- **Reject (409) when the target is withdrawn**: leaves a failing canary live.

## 3. Mixed-version window (one push deploys all ten workers)

Spec DO only; no route, request, response or schema change (`DeployRefSchema` already allows null targets,
`deploy-refs.ts:34`). Old DO + new callers or new DO + old callers: identical traffic. Old rows written during the window
are valid chain rows for the walk. Rollback floor: nothing to tolerate. Reverting this deploy brings back the toggle,
including empty -> last candidate; nothing is stored, so redeploying fixes it. Chains already toggled need no repair.

## 4. Tests to add (real SQL through the real router, `deploy-refs.test.ts` style)

1. The traces in section 2: A,B; A,B,C; A,B,C,D; A,B,A; Z,A,A; A,B,roll back,B,C (roll back C -> B); a legacy toggled
   chain (A,B + four rollback rows -> e). Each asserts the head after every rollback, no further live canary at the end,
   one `slo_rollback` near-miss per rolled-back head, deployment statuses.
2. Empty head stays empty: A,B then five rollbacks ends `e,e,e` (kills "empty head re-promotes").
3. `full` rung with distinct candidates and null versions, five rollbacks (kills "identity = version only"); refs seeded
   by `INSERT` (only `deployCanary` moves refs today; no FKs on `deploy_refs`).
4. Same candidate, two versions (a,v1),(a,v2): rollback -> v1 (kills "identity = candidate only").
5. Shared version, two candidates: rollback goes to the empty ref, `liveRefs` agrees with the head (S1).
6. Redeploy eligibility: A,B,roll back,B,C: rollback C -> B (kills an order-blind identity set).
7. Dangling `prev_ref_id`: ends at the empty ref, no throw (no FKs-off needed).
8. Single rollback unchanged (restores A, A `deployed`, `deploy-refs.test.ts:151`); `store.transactions.count` delta 1;
   `X-Expected-Head` and Idempotency-Key tests still pass.
9. **Loop level (mandatory, S2):** point the `slo-loop.test.ts` env at a real SQLite `SpecDO`, seed violating metrics
   through `/canary-metrics` for A and B, run `runCycle` until quiet: assert `rolledBack` per cycle (cycle 1 B, cycle 2 A)
   and `checked: 0` at the end, bounded at 3 cycles. The mock at `slo-loop.test.ts:33-66` never moves refs and cannot catch D2.
10. Invert the pinned tests: `deploy-refs.test.ts:167` (two distinct rollbacks end at empty), `:362` (comment `:361`,
    "two different fresh keys still toggle"), `:381-388` (`:387` expects `cand-b` today); retitle `near-misses.test.ts:222-223`
    (passes; drop "known hazard pending D2").

## 5. Docs and comments to update

`docs/OPS.md:416-432` (nearest earlier non-withdrawn promote ref, else empty; no toggle; `Idempotency-Key` required for
unkeyed retries; a rolled-back version returns only by a new deploy); `docs/OPEN-QUESTIONS.md` D2 -> Fixed (task, commit),
plus a pointer under `:362-365`; `docs/FOCUS.md:33, 38, 263`; `docs/rfds/0004-canary-deploy-rollback.md:60-61`;
`workers/shared/deploy-refs.ts:9-11, 220-221`; `workers/spec-do/index.ts:46` and the `rollbackHead` docstring (`:3798`);
`schema.sql:441` and `schema-inline.ts:553` comments, edited together (`schema-sync.test.ts` compares them byte for byte; no
migration); test header comments `deploy-refs.test.ts:2-4, 153`. `docs/plans/rollback-idempotency-plan.md` is history: leave.

## 6. Files touched

`workers/spec-do/index.ts`, `workers/spec-do/tests/deploy-refs.test.ts`, `workers/spec-do/tests/near-misses.test.ts`
(title), `workers/canary-worker/tests/slo-loop.test.ts` (or a new loop test beside it), `workers/shared/deploy-refs.ts`
(comments), `schema.sql` + `workers/spec-do/schema-inline.ts` (comments), and the docs in section 5. One function changes.

## 7. Risks

1. **Behavior change on manual rollback** (no toggle; unkeyed retry drops one more ref). Intended; stated in OPS. No client
   method calls the route today (only the constant, `deploy-refs.ts:222`).
2. **Identity key.** `workerVersionId ?? candidateId`: tests 3-5 pin it. Hand-seeded rows are the only exposure.
3. **Chain size.** O(refs per spec and rung), as `listDeployRefs`, only on rollback.
4. **Stale metrics for a restored canary.** A restored A is judged on a window that includes its earlier life; with this
   fix that costs at most one more rollback to empty, not a loop.
5. **Empty ref as terminal state.** Same as rolling back the first canary today.
6. `autoRollback = false` on a failing canary stays live by design (`slo.ts:166`).

## 8. Review asks (rev 2, for the verification pass)

- Re-derive the section 2 algorithm on the traces; try to find a loop or a wrong target (interleaved deploys and rollbacks,
  two rollbacks in a row on a redeployed version, `full` rung).
- Is `key` right when a `promote` ref has a null version and a null candidate (empty promote)?
- Are the section 4 tests enough to kill each mutant in Review 1 S7?

## 9. Open decisions for the maintainer

- **D2a (accepted 2026-11-02):** manual rollback also stops toggling; one rule for both routes.

## 10. Review 1 dispositions (independent agent, 2026-11-02: reject as written; approve once B1 fixed)

| # | Finding | Disposition |
|---|---|---|
| B1 | Ref-id `withdrawn` loops from three refs on (A,B,C; A,B,A; Z,A,A; `full`) and contradicts test 2 and the "empty stays empty" claim | Accepted, reproduced by hand on A,B,C. Section 2 rewritten to the reviewer's identity walk; probes in section 2 and tests 1-6 |
| S1 | Identity should be `workerVersionId ?? candidateId`, not the pair | Accepted: section 2 step 1, tests 3-5 |
| S2 | Test 10 asserted something false; make it mandatory and real-DO | Accepted: test 9 |
| S3 | Pinned tests incomplete (`:362`, `:381-388`, `near-misses` retitle) | Accepted: test 10 |
| S4 | Docs/comments list incomplete; "four files" wrong; single target helper for PR-G | Accepted: sections 2, 5, 6 |
| S5 | Unkeyed retry now drops one more ref | Accepted and documented: sections 2, 5, 7 |
| S6 | `syncCanaryStatuses` paragraph wrong | Accepted: section 2 consequences reworded |
| S7 | Mutant coverage gaps | Accepted: tests 1-6 map to the table |
| N1 | Visited-set is dead code | Accepted: dropped; dangling-prev test kept (test 7) |
| N2 | Line numbers slightly off | Accepted: refreshed where cited (`:3518-3529`, `listDeployRefs :3548-3560`, `moveDeployRef :3771`) |
| N3 | `seed.ts` does not write `deploy_refs` | Accepted: risk dropped |
| Q6 | Add revert note to mixed-version section | Accepted: section 3 |
