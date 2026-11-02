# Plan: the merge train's gate call (`/run` does not exist)

Task: `merge-train-gate-call` | Spec: `docs/OPEN-QUESTIONS.md` "2026-10-30: promotion worker calls a gate route that does not
exist" | Tier: default plan with heavy review (AGENTS.md rule 2 spine: promotion train; rule "check `Response.ok`").
Status: **draft, awaiting independent review.** Nothing implemented.

## 1. Facts (line numbers at `8e495e2`)

`MergeTrainManager.executeMerge` (`workers/promotion-worker/merge-train.ts:369-399`) is the only thing a car does between
its claim (`waiting -> merging`) and its outcome (`merged` or `failed`). It has four defects, not one:

1. **Relative URL.** `GATE_WORKFLOW.fetch('/run', ...)` passes a path, not a URL. A Service binding needs an absolute URL
   (`queue-consumer/index.ts:329` uses `http://beehive-gate-workflow/gates/pre-merge`); a relative one throws.
2. **Wrong route.** The gate worker handles `/health`, `/gates/health`, and `/gates/pre-merge...` only
   (`workers/gate-workflow/index.ts:125-185`); everything else is a 404.
3. **No auth.** The gate worker is fail-closed on every route (`authGate`, `index.ts:114`); the call sends no `Authorization`.
4. **Wrong success test.** `/gates/pre-merge` answers **201 `{success: true, verdictId, result}` even when the verdict is
   `fail`** (`index.ts:332-346`; `result.status` is `pass | fail | pending`, `:53, :919`). `executeMerge` checks only
   `result.success`, so a failing gate would merge the car.

So today every car in merge-train mode fails (and the unit tests hide it: `promotion.test.ts:657` mocks `/run` to succeed).
The default mode is `tournament` (`wrangler.toml:10`); the persisted mode (`GET /promotion-mode`) is unknown for production.

The pre-merge gate needs `{candidateId, specId, commitSha, baseCommitSha, actorId}` with UUID ids
(`GateWorkflowRequestSchema`, `workers/shared/schemas.ts:558`). A car carries only `candidateId` and `specId`
(`MergeTrainCandidateSchema`, `shared/promotion-ledger.ts:120`). Candidate rows hold `commit_sha` and `base_commit_sha`
(`schema-inline.ts:110-111`), read by `getCandidate` (`promotion-worker/spec-do.ts:86`, throws on non-2xx).

The gate itself is still simulated (`runUnitTests` returns hard-coded passes, conformance is `Math.random() < 0.1`, pass is
`score >= 80`; `docs/REAL-GATE-IMPL-PLAN.md` section 0). The real gate lands in that plan's slice 7a. **A merge-train pass
is exactly as real as the gate is.**

`retryFailedMerge` resets the same car (same position) to `waiting` (`merge-train.ts:431`). The claim has no lease or
attempt id (open entry "a merge-train car stuck in `merging`").

## 2. Design (recommended: repoint, authenticate, read the verdict)

Change `executeMerge` only, plus a small pure helper for the request and verdict parsing.

1. **Inputs.** `getCandidate(env, car.candidateId)`; require string `commit_sha` and `base_commit_sha` (accept the camelCase
   spelling too, as the queue consumer does). Missing or empty -> throw `Candidate <id> has no commit_sha/base_commit_sha`
   (the car fails with that reason; no guessing, no placeholder sha).
2. **Request.** `POST http://beehive-gate-workflow/gates/pre-merge`, headers `Content-Type: application/json`,
   `Authorization: Bearer ${env.API_AUTH_TOKEN}`, `X-Actor-ID: promotion-worker`; body
   `{candidateId, specId, commitSha, baseCommitSha, actorId: 'promotion-worker'}`. No `API_AUTH_TOKEN` -> throw
   `API_AUTH_TOKEN not configured` before the call (fail closed, same as the queue consumer). The `type: 'merge-promotion'`
   and `timestamp` fields are dropped (the schema ignores them; they only suggested a route that never existed).
3. **No `Idempotency-Key`** in this change. A key must be stable across a redelivery of one claim but different across a
   `retryFailedMerge` of the same car, and the car has no attempt or lease id. The stuck-`merging` fix will add the lease;
   the key (`train id : position : lease`) belongs there. Until then a crash between claim and outcome already strands the car.
4. **Verdict.** Success only when `response.ok` and `body.success === true` and `body.result?.status === 'pass'`. Otherwise
   throw with the reason: a non-ok answer -> `Gate answered <status>: <body text, first 200 chars>`; `fail` or `pending` ->
   `Pre-merge gate <status> (verdict <verdictId>): <result.notes>`. A body that is not JSON, or lacks `result.status`, is a failure
   (never "empty is pass").
5. **Kept as is:** the 100 ms pause after success, the claim and outcome CAS writes, `retryFailedMerge`, the stage writes
   (merge-train still never writes `passed_train`; that is the PR-S prerequisite list in `docs/MILESTONES.md`).

## 3. Alternatives

- **B. Remove the gate call** (a merge-train pass is bookkeeping only until the real gate): honest, but the train rung then
  verifies nothing, and re-adding the call later is the same work. Rejected as the default; viable if the maintainer prefers
  no simulated verdict in the train.
- **C. Wait for slice 7a** (`POST /gates/runs`, real sandbox gate) and wire the train to it: right end state, but 7a needs the
  maintainer to create a queue and approve a production run. This change is a prerequisite shape for it (the train reads a
  verdict, fail closed), so doing A first costs nothing.
- **D. Add a `/run` route to the gate worker:** keeps a second entry point with unclear semantics (what is "merge-promotion"?).
  Rejected.

## 4. Mixed-version window (one push deploys all ten workers)

Promotion worker only. The gate worker, Spec DO, routes and schemas are untouched. Old promotion worker + new gate: still
fails every car (as today). New promotion worker + old gate: the same `/gates/pre-merge` route exists in both. No ordering
dependency. Rollback: redeploying the old worker brings the 404 back; nothing is stored.

## 5. Behavior change to accept

Cars that today always fail can now merge or fail on the (simulated) verdict: a gate `pass` is roughly "score >= 80 with a
random conformance warning". Only relevant if merge-train mode is persisted. Before the next deploy the maintainer can check
`GET /promotion-mode` (read-only); if it says `merge-train` and the simulated pass is unwanted, choose B.

## 6. Tests (promotion worker, real `MergeTrainManager` against the ledger test double)

1. The request: URL is absolute and ends `/gates/pre-merge`; method POST; `Authorization: Bearer <token>`; `X-Actor-ID`;
   the body parses with `GateWorkflowRequestSchema` and carries the candidate's two shas (the old `/run` assertion cannot pass).
2. Verdict `pass` (201 and a 200 replay) -> car `merged`.
3. Verdict `fail` with `success: true` -> car `failed`, reason contains the status and verdict id (kills "check only `success`").
4. Verdict `pending`, non-JSON body, missing `result` -> `failed`.
5. Non-ok answers: 404 (the old route's answer), 401, 409 inFlight, 500 -> `failed`, reason includes the status.
6. Candidate lookup 404, candidate without `commit_sha` or `base_commit_sha`, no `API_AUTH_TOKEN` -> `failed` with that reason,
   and **no gate call made**.
7. The gate failure does not mark a car failed whose outcome write fails (existing behavior, kept green).
8. Existing merge-train tests keep their shape: only the mocked gate response changes from `{success: true}` to the 201 body.
9. Contract test beside the gate worker (`workers/gate-workflow/tests`): the path the promotion worker uses routes to
   `handleStartPreMergeGate` (not 404) when fed through the gate's default `fetch` with a stubbed Spec DO. Export the path
   as a constant from `workers/shared` used by `executeMerge` and the test, so a rename breaks the test.

## 7. Docs

`docs/OPEN-QUESTIONS.md`: close "2026-10-30 ... gate route" (Fixed; task id) and add one new entry: `tournament.ts:388` has the
same defect class (`SHADOW_ROUTER.fetch('/compare')`: relative URL, no bearer, and the shadow router has no `/compare` route),
masked by `fallbackCompareCandidates` (every tournament comparison silently uses the fallback). Not changed here.
`docs/OPS.md` merge-train paragraph (the gate call and what a pass means today). `docs/FOCUS.md` open-questions line.

## 8. Files touched

`workers/promotion-worker/merge-train.ts`, `workers/shared` (path constant), `workers/promotion-worker/tests/promotion.test.ts`,
`workers/gate-workflow/tests/` (one contract test), `docs/OPEN-QUESTIONS.md`, `docs/OPS.md`, `docs/FOCUS.md`.

## 9. Risks

1. A simulated gate decides merges (section 5). Mitigated by B being available and the mode being non-default.
2. Candidate row field spelling (`commit_sha` vs `commitSha`): test 6 pins both and the failure when absent.
3. A slow gate holds the claimed car in `merging` longer; same exposure as today's open stuck-car entry.
4. The gate records a `gate_verdicts` row per car (stage `pre-merge`); duplicates of the push-path verdict are possible.
   Accepted: they are separate runs; the verdict table is append-only.

## 10. Review asks

- Is every defect in section 1 real (re-read the gate worker routes, `authGate`, the 201-on-fail behavior, binding URL rules)?
  Any fifth one?
- Is dropping the idempotency key right, or is there a safe key without a lease?
- Does anything else read `executeMerge`'s old contract (`type: 'merge-promotion'`)? Other callers of `GATE_WORKFLOW` or of
  `/run` (docs, scripts, CLI, UI)?
- Is the contract test (9) feasible without heavy stubs; is the path constant the right seam?
- Is A the right default versus B/C?

## 11. Open decisions for the maintainer

- **M1:** A (recommended), B or C.
- **M2:** whether production's persisted promotion mode is `merge-train` (read-only `GET /promotion-mode`).
