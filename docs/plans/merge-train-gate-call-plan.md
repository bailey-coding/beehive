# Plan: the merge train's gate call (`/run` does not exist)

Task: `merge-train-gate-call` | Spec: `docs/OPEN-QUESTIONS.md` "2026-10-30: promotion worker calls a gate route that does not
exist" | Tier: default plan with heavy review (AGENTS.md rule 2 spine: promotion train + DO ledger; rule "check `Response.ok`").
Status: **rev 2 — review 1 (agent `plan-review-gate-call`) returned approve with changes; dispositions applied below.**
Nothing implemented.

## 1. Facts (line numbers at `c948b29`; `git diff 8e495e2..HEAD -- workers/` is empty)

`MergeTrainManager.executeMerge` (`workers/promotion-worker/merge-train.ts:370-399`) is the only thing a car does between
its claim (`waiting -> merging`) and its outcome (`merged` or `failed`). It has four defects, not one:

1. **Relative URL.** `GATE_WORKFLOW.fetch('/run', ...)` (`merge-train.ts:373-374`) passes a path, not a URL. A Service
   binding needs an absolute URL (`queue-consumer/index.ts:329` uses `http://beehive-gate-workflow/gates/pre-merge`); a
   relative one throws.
2. **Wrong route.** The gate worker handles `/health`, `/gates/health`, and `/gates/pre-merge...` only
   (`workers/gate-workflow/index.ts:128-168`); everything else is a 404.
3. **No auth.** The gate worker is fail-closed on every route (`authGate` called at `index.ts:120`; 503 when
   `API_AUTH_TOKEN` is unset, 401 on mismatch, `shared/auth.ts:31-52`); the call sends no `Authorization`.
4. **Wrong success test.** `/gates/pre-merge` answers **201 `{success: true, verdictId, result}` even when the verdict is
   `fail`** (`index.ts:349-357`; `result.status` is `pass | fail | pending`, `:53`). `executeMerge` checks only
   `result.success`, so a failing gate would merge the car.

5. **The verdict write collides (found in review 1).** `gate_verdicts` has `UNIQUE(candidate_id, gate)`
   (`workers/spec-do/schema-inline.ts:148`), and the legacy write behind `POST /api/gate-verdicts` is a plain
   `INSERT` (`createGateVerdict`, `workers/spec-do/index.ts:1841-1852`) — a second pre-merge verdict for the same
   candidate throws, the outer catch answers **500** (`index.ts:4849-4856`), and the gate's `recordGateVerdict` throws
   on any non-ok (`workers/gate-workflow/index.ts:932-972`), so the whole gate call fails. The queue consumer already
   writes a pre-merge verdict for every pushed candidate (`queue-consumer/index.ts:329-345`), so the train's call
   collides in the normal case. A fresh `Idempotency-Key` does not help (the UNIQUE is on `(candidate_id, gate)`, not
   the key). The design intent is latest-summary: "gate_verdicts stays the latest-summary table"
   (`schema-inline.ts:720`), and the new gate-runs path already upserts
   (`ON CONFLICT(candidate_id, gate) DO UPDATE`, `index.ts:5113-5120`). The legacy route is the outlier.

So today every car in merge-train mode fails (and the unit tests hide it: `promotion.test.ts:657` mocks `/run` to succeed).
The default mode is `tournament` (`workers/promotion-worker/wrangler.toml:10`); the persisted mode is the Spec DO's
`GET /promotion-mode` route (answered from KV before `init()`, `workers/spec-do/index.ts:4062-4079`; read-only via the
edge/DO probe) — unknown for production.

The pre-merge gate needs `{candidateId, specId, commitSha, baseCommitSha, actorId}` with UUID ids
(`GateWorkflowRequestSchema`, `workers/shared/schemas.ts:558`). A car carries only `candidateId` and `specId`
(`MergeTrainCandidateSchema`, `shared/promotion-ledger.ts:120`). `getCandidate` (`promotion-worker/spec-do.ts:86-95`,
throws on non-2xx) returns `body.data` of `GET /api/candidates/:id`, whose serializer is **camelCase**
(`candidateRowToResponse`, `workers/spec-do/index.ts:2296-2310`): `commitSha` / `baseCommitSha`. The snake_case
`commit_sha` / `base_commit_sha` are the SQL columns and the internal row only (`schema-inline.ts:110-111`,
`rowToCandidate` at `:2270-2292`).

The gate itself is still simulated (`runUnitTests` returns hard-coded passes, conformance is `Math.random() < 0.1`, pass is
`score >= 80`; `docs/REAL-GATE-IMPL-PLAN.md` section 0). The real gate lands in that plan's slice 7a. **A merge-train pass
is exactly as real as the gate is.**

`retryFailedMerge` resets the same car (same position) to `waiting` (`merge-train.ts:431`). The claim has no lease or
attempt id (open entry "a merge-train car stuck in `merging`").

## 2. Design (recommended: repoint, authenticate, read the verdict, upsert the summary)

Two parts: (0) make the Spec DO's legacy verdict write an upsert so the train's gate call can record its verdict;
(1) repoint `executeMerge`, authenticate, and read the verdict.

0. **Spec DO: `createGateVerdict` becomes an upsert** (`workers/spec-do/index.ts:1834`). Mirror the gate-runs write
   (`index.ts:5113-5120`): look up the existing row id for `(candidate_id, gate)`, then
   `INSERT ... ON CONFLICT(candidate_id, gate) DO UPDATE SET status = excluded.status, score = excluded.score, complexity_delta = excluded.complexity_delta, notes = excluded.notes, created_at = excluded.created_at, decided_by = excluded.decided_by`
   (the id is kept). `recordHistory` still appends one `gate_verdict` history row per write, so nothing is lost.
   No schema migration: the `UNIQUE(candidate_id, gate)` index already exists; only the write semantics change, matching
   the documented latest-summary design (`schema-inline.ts:720`) and the gate-runs precedent. `POST /api/gate-verdicts`
   then answers 201 for a repeat of the same `(candidate, gate)` instead of 500. Readers (`GET /api/gate-verdicts`,
   `GET /api/candidates/:id/gate-verdicts`) are unchanged.
1. **Inputs.** `getCandidate(env, car.candidateId)`; require non-empty string `commitSha` / `baseCommitSha` (the camelCase
   fields the API actually returns; accept the snake_case spelling as a fallback, as the queue consumer does).
   Missing or empty -> throw `Candidate <id> has no commitSha/baseCommitSha` (the car fails with that reason; no
   guessing, no placeholder sha).
2. **Request.** `POST ${GATE_WORKFLOW_ORIGIN}${GATE_PRE_MERGE_PATH}` — new constants exported from
   `workers/shared/schemas.ts` beside `GateWorkflowRequestSchema` (`GATE_WORKFLOW_ORIGIN = 'http://beehive-gate-workflow'`,
   `GATE_PRE_MERGE_PATH = '/gates/pre-merge'`) — headers `Content-Type: application/json`,
   `Authorization: Bearer ${env.API_AUTH_TOKEN}`, `X-Actor-ID: promotion-worker`; body
   `{candidateId, specId, commitSha, baseCommitSha, actorId: 'promotion-worker'}`. No `API_AUTH_TOKEN` -> throw
   `API_AUTH_TOKEN not configured` before the call (fail closed, same as the queue consumer). The `type: 'merge-promotion'`
   and `timestamp` fields are dropped (the schema ignores them; they only suggested a route that never existed).
   The gate worker's own route check (`workers/gate-workflow/index.ts:135`) uses `GATE_PRE_MERGE_PATH` too, so a rename
   breaks the contract test.
3. **No `Idempotency-Key`** in this change. A key must be stable across a redelivery of one claim but different across a
   `retryFailedMerge` of the same car, and the car has no attempt or lease id. The stuck-`merging` fix will add the lease;
   the key (`train id : position : lease`) belongs there. Until then a crash between claim and outcome already strands the car.
   (Review 1: dropping the key is still correct — with the upsert in part 0 it no longer causes the collision.)
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

Three workers change: promotion worker, gate worker (route check uses the shared constant — same route, no behavior
change), Spec DO (the verdict upsert). Old promotion worker + new DO: cars still fail on the 404 as today; the upsert only
changes repeat verdict writes from 500 to 201 (a strict improvement for the queue-consumer path too). New promotion
worker + old DO: the train's keyless verdict write hits the plain INSERT and 500s again — the car fails, same as today,
so no new failure mode. New gate worker + old promotion worker: unchanged. No ordering dependency beyond the usual
one-push-deploys-all-ten. Rollback: redeploying the old workers brings the 404 and the 500 back; nothing is stored.

## 5. Behavior change to accept

Cars that today always fail can now merge or fail on the (simulated) verdict: a gate `pass` is roughly "score >= 80 with a
random conformance warning". Only relevant if merge-train mode is persisted. Before the next deploy the maintainer can check
`GET /promotion-mode` (read-only); if it says `merge-train` and the simulated pass is unwanted, choose B.

## 6. Tests

Promotion worker (`workers/promotion-worker/tests/promotion.test.ts`, real `MergeTrainManager` against the real Spec DO
test double `makeSpecDo`; all ids from `createActor`/`createOrganization`/`createRepository`/`createSpec`/`createCandidate`
are `crypto.randomUUID()` via `generateId()`, `spec-do/index.ts:623-625`, so cars in these tests use a **real candidate id
and the real spec id** — `SPEC = 'spec-mt'` is not a UUID and would fail the schema parse):

1. The request: the URL equals `${GATE_WORKFLOW_ORIGIN}${GATE_PRE_MERGE_PATH}` (absolute); method POST; `Authorization:
   Bearer <token>`; `X-Actor-ID: promotion-worker`; the captured body parses with `GateWorkflowRequestSchema` and carries
   the candidate's `commitSha`/`baseCommitSha` read from `GET /api/candidates/:id` (camelCase primary; a snake_case-only
   row is also accepted — pin both). The old `/run` assertion cannot pass.
2. Verdict `pass` (201 body) -> car `merged`.
3. Verdict `fail` with `success: true` (201) -> car `failed`, reason contains the status and verdict id (kills "check only
   `success`").
4. Verdict `pending`, non-JSON body, missing `result` -> `failed`.
5. Non-ok answers: 404 (the old route's answer), 401, 500 -> `failed`, reason includes the status. (409 `inFlight` and the
   200 replay need an `Idempotency-Key`, which the train does not send — keyless they are unreachable on the real route;
   keep them only as mock-driven robustness cases and do not describe them as real gate answers.)
6. Candidate lookup 404, candidate without `commitSha`/`baseCommitSha`, no `API_AUTH_TOKEN` -> `failed` with that reason,
   and **no gate call made** (`mockGateWorkflow.fetch` call count 0, as the existing tests at `:909`/`:928` already assert).
7. The gate failure does not mark a car failed whose outcome write fails (existing behavior, kept green).
8. Existing merge-train tests keep their shape: the `gate()` helper and the `:657` mock change from `{success: true}` /
   `{success: false}` to the 201 verdict body `{success: true, verdictId, result: {status: 'pass'|…}}`, and tests that
   reach the gate call use a real candidate row (the `realCandidate` helper, made idempotent or parameterized by name).

Spec DO (`workers/spec-do/tests/gate-runs.test.ts`, beside the legacy-route test at `:560-567`):

9. A second `POST /api/gate-verdicts` for the same `(candidateId, gate)` answers **201**, updates the row in place (same
   `id`, new `status`/`score`/`notes`/`decided_by`/`created_at`), and appends one `gate_verdict` history row
   (`entity_history` count 2). A different `gate` still inserts a new row. This is the collision fix of section 2 part 0.

Contract test beside the gate worker (`workers/gate-workflow/tests/gate.test.ts`, which already drives `handler.fetch`
with `mockEnv` plus `mockValidSpec()`/`mockVerdictRecording()` helpers):

10. `POST ${GATE_WORKFLOW_ORIGIN}${GATE_PRE_MERGE_PATH}` through the gate's default `fetch` routes to
    `handleStartPreMergeGate` (201, not 404). Because both `executeMerge` and the gate's route check
    (`gate-workflow/index.ts:135`) use `GATE_PRE_MERGE_PATH` from `workers/shared/schemas.ts`, a rename breaks this test.

## 7. Docs

`docs/OPEN-QUESTIONS.md`: close "2026-10-30 ... gate route" (Fixed; task `merge-train-gate-call`; the call was at
`merge-train.ts:373-374`) and add one new entry: `tournament.ts:388` has the same defect class
(`SHADOW_ROUTER.fetch('/compare')`: relative URL, no bearer, and the shadow router has no `/compare` route), masked by
`fallbackCompareCandidates` (every tournament comparison silently uses the fallback). Not changed here.
`docs/OPS.md` "Idempotency and queue retries" gate-worker bullet (`docs/OPS.md:580`): add that the merge train also calls
`POST /gates/pre-merge` (bearer, `X-Actor-ID: promotion-worker`, no idempotency key) per claimed car, reads
`result.status`, and that a repeat `POST /api/gate-verdicts` for the same `(candidate, gate)` now upserts (201, latest
wins) instead of 500 — plus what a pass means today (the gate is still simulated). `docs/FOCUS.md` open-questions line.

## 8. Files touched

`workers/promotion-worker/merge-train.ts`, `workers/shared/schemas.ts` (origin + path constants),
`workers/gate-workflow/index.ts` (route check uses the constant), `workers/spec-do/index.ts` (`createGateVerdict` upsert),
`workers/promotion-worker/tests/promotion.test.ts`, `workers/gate-workflow/tests/gate.test.ts` (one contract test),
`workers/spec-do/tests/gate-runs.test.ts` (upsert test), `docs/OPEN-QUESTIONS.md`, `docs/OPS.md`, `docs/FOCUS.md`,
this plan (rev 2 dispositions).

## 9. Risks

1. A simulated gate decides merges (section 5). Mitigated by B being available and the mode being non-default.
2. Candidate row field spelling: the API returns camelCase (`commitSha`/`baseCommitSha`); snake_case is accepted as a
   fallback. Test 1 pins both and the failure when absent.
3. A slow gate holds the claimed car in `merging` longer; same exposure as today's open stuck-car entry. No timeout on
   `GATE_WORKFLOW.fetch` (same as the queue consumer) — optional hardening, not in this change.
4. The train's verdict **replaces** the push-path pre-merge verdict for the candidate (latest-summary upsert). Accepted:
   that is the documented design (`schema-inline.ts:720`) and the gate-runs precedent; history keeps both writes.

## 10. Review asks and dispositions

Review 1 (agent `plan-review-gate-call`, approve with changes) answered the original asks; dispositions:

- Every defect in section 1 real; **a fifth one found**: the verdict-write collision, now defect 5, fixed by design part 0
  (blocker; was risk 4, factually wrong — the table is not append-only, the legacy write 500s on a repeat).
- Dropping the idempotency key stays right (no wrong dedupe; with part 0 it no longer collides).
- Nothing else reads the old contract: repo-wide grep hits only `merge-train.ts:374/381` in code; the other `GATE_WORKFLOW`
  caller (`spec-do/index.ts:4796-4815`) already uses the absolute-URL + bearer + `/gates/pre-merge` pattern.
- Contract test feasible; the gate's own route check now also uses the shared constant (finding 3). Constant home:
  `workers/shared/schemas.ts` beside `GateWorkflowRequestSchema`.
- A remains the right default over B/C, with part 0 in place.
- Field spelling corrected: the candidate API response is camelCase (`commitSha`/`baseCommitSha`); snake_case accepted as
  fallback (finding 2).
- Tests need UUID candidate **and spec** ids via real DO rows (finding 4); 409-inFlight / 200-replay are keyless-unreachable,
  kept as mock robustness only (finding 5).
- Line-number drift corrected to `c948b29` (finding 6); `GET /promotion-mode` is the Spec DO's route (finding 8).

## 11. Open decisions for the maintainer

- **M1:** A (recommended, now with the upsert), B or C.
- **M2:** whether production's persisted promotion mode is `merge-train` (read-only: the Spec DO's `GET /promotion-mode`,
  `spec-do/index.ts:4062-4079`, via the edge/DO probe).
- **M3:** the upsert of `gate_verdicts` (latest wins, history kept) — recommended, matches the gate-runs path; the
  alternative is keeping the plain INSERT and having the train read the existing verdict instead of re-gating.
