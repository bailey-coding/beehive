---
category: planning
status: active
audience: human,agent
---

# Wave 2a: ladder guards (plan, rev 1, 2026-11-18)

From `docs/reviews/2026-11-17-synthesis.md`, "Proposed order of work", Wave 2. The maintainer agreed on 2026-11-18 to split Wave 2 in two:
- **2a (this plan):** the guards: small, self-contained checks in the Spec DO, the gate and the promotion worker;
- **2b (a later plan):** canary evidence (synthesis Wave 2 item 3, problem 3), which is a design problem and waits on two decisions (the delta-surface
  shape, OPEN-QUESTIONS 2026-11-18, and the repository-create namespace hole, OPEN-QUESTIONS 2026-11-17).

**Spine.** Every part changes the Spec DO or the promotion train, so the heavy tier applies (AGENTS.md rule 2):
- this plan gets an independent review before any code;
- the implementation gets mutation checks and an independent code review;
- the merge to `main` happens only when the maintainer says so in chat.

**Mixed-version safety.** One push deploys all ten workers in no set order. Each part says how it copes with an old or a new peer.

**Test-first.** As in Wave 1, each guard gets a test committed first as `it.fails` (a Spec DO unit test, or a `tests/contract/` test where two
workers are involved). The fix commit flips it, so the history shows red before green.

## Summary

| Part | Finding | Change | Where |
|---|---|---|---|
| A | b1-S1, a-S2 | The candidate stage PATCH accepts only `failed` and `rolled_back`; every PATCH answers 404 before any write for an unknown or tombstoned row, and 400 for an unknown stage | Spec DO |
| B | a-S4, b1-S8 (canary) | `deployCanary` requires a live candidate under the named spec; canary evidence compares commits | Spec DO |
| C | b2-S4, b1-S8 | Gate verdicts are labelled simulated and carry the commit; the gate refuses a spec/candidate mismatch and a non-sha; pre-merge evidence compares commits | gate-workflow, Spec DO (m16) |
| D | b1-S5, b1-S6, b1-S4 | Tournament: minimum sample count, one open tournament per spec, a failure after the winner's advance no longer corrupts it | promotion-worker, Spec DO |
| E | b1-S2 | A promotion state stuck in `pending`/`in_progress` past `PROMOTION_TIMEOUT` stops blocking the candidate | promotion-worker |
| F | a-S8 | A third Spec DO token for the promotion writes, log-only in this wave | shared, Spec DO, three workers |

Out of scope: canary evidence and `advance(full)` (2b); a writer for `candidates.commit_sha` (b2-S8), because the only producer is the push path and
the push message shape is unverified (OPEN-QUESTIONS 2026-11-18). Part C is written so that it tightens by itself once a writer exists.

## Decisions for the maintainer

- **M1. Does `deployCanary` require `passed_train`?** Recommendation: **not yet; log it.** Today the canary SLO tests, the e2e canary flows and the
  2026-10-25 production canary deploy `pending` candidates. Requiring `passed_train` makes the only canary path depend on the tournament and merge
  train, which are not proven in production. Part B writes a `governance_events` row (`canary_stage_precondition`, same flood control as
  `invalid_transition`) and 2b makes it enforceable together with the canary evidence.
- **M2. Part F needs a new secret** (`SPEC_DO_PROMOTION_TOKEN`) set by the maintainer on four workers. This wave only logs; enforcement is a later
  one-line change after the logs show no misses.
- **M3. The e2e fixture and `scripts/prod-verify-promotion.sh` change** (part A): they place candidates with an upward stage PATCH. They move to
  "post a passing pre-merge verdict, then `advance`". The script is the maintainer's production check, so its new shape needs a nod.

## Part A: stage PATCH integrity (b1-S1, a-S2)

**Today.**
- `PATCH /api/candidates/:id/stage` (`spec-do/index.ts:4468`) writes any stage: `pending -> promoted` answers 200, with only an `invalid_transition`
  log row. It also writes to a tombstoned candidate and then answers 404 after the write has committed.
- The spec and issue PATCHes (`:4410`, `:4721`; `transitionSpec :1593`, `transitionIssue :2214`) write an orphan history row for an unknown id
  (200 `data:null`), restage tombstoned rows, run outside a transaction, and answer 500 for an invalid stage (the CHECK constraint).

**Change.**
1. The candidate PATCH route checks before writing, inside one `transactionSync`:
   - unknown or tombstoned id: 404 `candidate_not_found` (the existing coded string), nothing written;
   - `stage` not in `CANDIDATE_STAGES`: 400;
   - same stage: 200, as today (idempotent);
   - target `failed` or `rolled_back`: allowed from any stage, as today (rule 7: rollback is never gated). The table (c) log still runs, so a
     `rollback_before_train` row is still written for a low-stage rollback;
   - any other target: **409 `use_advance`**, with the message "stage PATCH only writes failed or rolled_back; use POST /api/candidates/:id/advance".
     This covers upward moves, skip-ahead and backward moves. No production code path writes a non-`failed`/`rolled_back` stage through the PATCH
     (the only worker caller is `merge-train.ts:604`, which writes `rolled_back`).
   - The check lives in the route, not in `transitionCandidate`, because `advanceCandidate` (`:5025`) writes its ladder steps through
     `transitionCandidate` and must keep doing so.
2. The spec and issue PATCH routes: one `transactionSync`; `WHERE id = ? AND deleted_at IS NULL`; 404 before any write; 400 for a stage outside the
   column's CHECK set (read from the same constants the schema uses, or a local list pinned by a test against the schema). No ladder rule: spec and
   issue stages are not a promotion ladder, and user tokens lost these routes in Wave 0.
3. The edge comment at `workers/api/principal.ts:258` was corrected in Wave 0; nothing to do there.

**Callers that change.**
- `tests/e2e/promotion-fixtures.ts:45` `setStage` and `scripts/prod-verify-promotion.sh:71` place candidates on a rung with an upward PATCH. Both move
  to: post a `pass` pre-merge verdict (master or internal, as the e2e fixture already does for evidence), then `advance`. A fixture that needs
  `passed_train` or higher advances step by step with the evidence each rung enforces (only pre-merge is enforced today; the others are log-only).
- `workers/spec-do/tests/governance-transitions.test.ts` asserts the log-only behavior of upward PATCHes; it is rewritten to assert the 409 and to
  keep the log-row assertions for `failed`/`rolled_back`.
- `workers/api/tests/{service-accounts,user-tokens}.test.ts` and `tests/unit/promotion-candidate-routes.test.ts`: checked; most assert the edge's
  403 for user tokens, which is unchanged.

**Mixed version.** The edge and the promotion worker forward the DO's status. An old promotion worker writes only `rolled_back` through the PATCH.
The CLI's `candidate stage` command gets a 409 with a message naming `advance`. No caller depends on the old 200.

**Tests (written first).** Spec DO: upward PATCH 409 and stage unchanged; tombstoned candidate 404 and stage unchanged (today the write commits);
unknown spec/issue 404 and no `entity_history` row; invalid stage 400; `failed`/`rolled_back` still 200 from every ladder stage.

## Part B: `deployCanary` integrity (a-S4, b1-S8 canary half)

**Today.** `deployCanary` (`spec-do/index.ts:3635`) accepts a candidate id with no ledger row ("Ids need no ledger row") and a candidate filed under
another spec; both become a live canary head that the shadow router mirrors to and the alarm chain keeps ticking for.

**Change.**
1. Inside the existing transaction, before `moveDeployRef`: the candidate must exist, be live, and have `spec_id = request.specId`; the spec must
   exist and be live. Otherwise 404 `candidate_not_found` / `spec_not_found`, or 409 `spec_mismatch`.
2. If `request.commitSha` is given and the candidate's `commit_sha` is non-empty and different: 409 `commit_mismatch`. An empty candidate sha is
   accepted (claimed candidates have `''`, b2-S8) and logged.
3. M1 (recommended): a candidate below `passed_train` is accepted and logged as `canary_stage_precondition`.
4. Canary evidence in `evaluateEvidence` (`:5052`): when the head's `commitSha` and the candidate's `commit_sha` are both non-empty and differ, the
   evidence is `missing` ("canary runs commit X, candidate is at Y").

**Callers.** The production path already sends a real candidate: canary-worker -> preview-manager reads the ledger candidate before it builds.
Tests that post canaries for ids with no row (`deploy-refs.test.ts` uses `cand-a`, `spec-a`; `slo-loop-real-do.test.ts`, `near-misses.test.ts`,
`advance.test.ts`, `tests/e2e/cross-worker-flows.test.ts`) get a small seeding helper that creates the org, repo, spec and candidate first. That is
a test change, not a behavior change; the count is about 40 call sites.

**Mixed version.** Only canary-worker posts canaries and it already uses ledger candidates. An old canary-worker that gets a new 404/409 surfaces
it as a failed deploy, as for any refusal today.

**Tests.** Ghost candidate 404 and no deploy ref; candidate under another spec 409 and no ref; tombstoned spec 404; commit mismatch 409; canary
evidence `missing` on a sha mismatch.

## Part C: labelled gate verdicts, evidence per commit (b2-S4, b1-S8)

**Today.**
- The simulated gate (`gate-workflow/index.ts:702-930`) writes notes like "Test score: 100.0/100"; nothing in the row says it was simulated.
- It accepts a `specId` that is not the candidate's and any non-empty `commitSha` (`GateWorkflowRequestSchema`, `shared/schemas.ts:561`).
- `gate_verdicts` has one row per (candidate, gate) and no commit (`schema-inline.ts:134`), so a verdict for commit A is evidence for commit B.
- The edge part of b2-S4 (user tokens could start the gate) was closed in Wave 0.

**Change.**
1. **Schema m16 (additive):** `ALTER TABLE gate_verdicts ADD COLUMN commit_sha TEXT` and `ADD COLUMN simulated INTEGER` (both nullable; NULL means
   "written before m16 or by a caller that does not send it"). `LATEST_SCHEMA_VERSION = 'm16'`. Each `ADD COLUMN` is guarded by a `PRAGMA
   table_info` check so a re-run is a no-op, like earlier column migrations. The migration-matrix test gets an m15 -> m16 case.
   `UNIQUE(candidate_id, gate)` stays: changing it needs a table rebuild, which is not additive.
2. `POST /api/gate-verdicts` stores `commitSha` and `simulated` when given; the response carries `commitSha` and `simulated` only when the
   caller sends `?withCommit=1`, so strict readers of the old shape are unaffected (AGENTS.md: new response fields are opt-in).
3. gate-workflow:
   - the notes start with `[simulated] `; the verdict body carries `simulated: true` and `commitSha`;
   - it reads the candidate (it already does in `calculateComplexityDelta`, `:791`) **before** running anything and refuses 400
     `spec_mismatch` when `specId` is not the candidate's, and 404 when the candidate is unknown;
   - `commitSha` must be 40 lowercase hex (a new `GitShaSchema` in `shared/schemas.ts`). `baseCommitSha` stays `min(1)` because the queue consumer
     sends `event.commit.sha` or a stored value there (`queue-consumer/index.ts:366`), and the push shape is unverified.
4. Pre-merge evidence in `evaluateEvidence`: when the verdict's `commit_sha` and the candidate's `commit_sha` are both non-empty and differ, the
   evidence is `missing` ("pre-merge verdict is for commit X, candidate is at Y"). A NULL or empty sha on either side is accepted as today and
   logged once as `evidence_unbound` (flood-controlled), so the log shows how often the check could not bind. Once a `commit_sha` writer exists
   (b2-S8, after the push shape is verified), a follow-up makes an unbound verdict `missing`.
5. The merge-train gate call overwrites the pre-merge row (b1-S8). With the commit now on the row, the overwrite is visible; it is not changed here.

**Callers.** Tests and e2e send short fake shas (about four literal sites outside unit tests, plus fixtures); they move to 40-hex values. The
queue consumer sends the push's sha (assumed 40-hex; if the real push shape is not, the gate answers 400 and the queue consumer logs it, which is
the right failure while the shape is unverified). The merge train sends the candidate's stored sha, which is a real sha when set and otherwise
refused earlier (`merge-train.ts:452`).

**Mixed version.**
- New gate, old DO: the DO ignores the two extra body fields (the route casts, it does not parse strictly). Verified in the test by posting the
  new body to a DO with the m15 code path.
- Old gate, new DO: the fields are absent, the columns stay NULL, the evidence check accepts as today.
- The m16 migration is two `ADD COLUMN`s; an old DO never reads them.

**Tests.** Gate: spec mismatch 400 with no verdict row; bad sha 400; notes start with `[simulated]`. DO: m16 migration on an m15 ledger; verdict
stores the sha; pre-merge evidence `missing` on a mismatch and `met` on a match; NULL sha still `met` and one `evidence_unbound` row.
A contract test: queue-consumer -> gate -> DO writes a verdict row with `simulated = 1` and the push sha.

## Part D: tournament (b1-S5, b1-S6, b1-S4)

**D1. Minimum sample count (b1-S5).** `readShadowScore` (`tournament.ts:431`) returns `shadowScore` with no count in the default (non-production)
source, so one sample at 100 beats 500 averaging 99. Change: the default source also needs `shadowMetrics.totalRequests >= shadowMinSamples()`
(the all-sample count, already in the candidate response, `spec-do/index.ts:5168`), otherwise "no score". A missing or unparsable count is
"no score" (fail closed, like the production source). Test: one-sample entrant gets no score; `decideTournament` then refuses or picks the other.

**D2. One open tournament per spec (b1-S6).** In `applyTournamentWrite` (`spec-do/index.ts:3282`), creating a new tournament (`!current`) for a
spec that already has one in `pending` or `in_progress` answers 409 `tournament_exists` with the existing id. The Spec DO is single-threaded and the
check runs in the write's transaction, so two concurrent creates cannot both pass. No unique index: production may already hold duplicates, and a
failing index migration is a full outage (as m12 showed). `failed` and `completed` tournaments do not block a new one.
- The promotion worker's create path, on `tournament_exists`, re-reads the spec's tournament and joins it (the same path as finding it on the
  first read).
- Mixed version: an old promotion worker that gets the 409 fails that promotion with `tournament_error`; the caller retries and the retry finds
  the existing tournament on its first read. Acceptable for one window.
- Test: two creates for one spec, the second 409 with the first id; a contract test where two entrants arrive "together" (sequenced creates)
  end in one tournament with both.

**D3. A failure after the winner's advance (b1-S4).** Today, if `recordWinner` throws after `advance` succeeded, the catch records the tournament
`failed`, spends an attempt and answers 500; a retry then sees the winner past the rung and finds too few entrants.
Change (reconcile, not reorder):
- In `executeTournament`, once `advanced.ok`, a throw from `recordWinner` is caught locally: the result is success (`moved`/`eliminated` as now) with
  `details.recordWinner = 'not recorded: ...'`, and the tournament is not marked failed.
- On the next run for that spec, an `in_progress` tournament with no winner whose contested entrant is already at or past `passed_train` is
  completed with that entrant as winner (one `updateTournament` write, version-checked) before eligibility is computed. The entrant's ledger history
  row `Tournament <id> winner` (the `advance` notes) is the proof; an entrant that moved by another path is not taken as the winner, and the
  tournament stays as it is (logged).
- Writing the winner before `advance` was considered and rejected: a refused `advance` would then leave a "completed" tournament whose winner never
  moved, which is the worse state.
- Test: `recordWinner` throws once (a fault-injecting ledger stub in the unit test; a contract test cannot inject it): the result is success, the
  tournament is not `failed`, and the next call completes it with the right winner.

## Part E: stuck promotion state (b1-S2)

**Today.** A throw from `transitionToInProgress`, `markAsCompleted` or `markAsFailed` (`promotion.ts:124-157`) leaves the state `pending` or
`in_progress`; `canPromote` (`state.ts:133`) then answers false for ever and every `/promote` is `409 Promotion already in progress` until
`/cancel`. `PROMOTION_TIMEOUT` (3600, `wrangler.toml:12`) is declared and never read.

**Change.**
1. `canPromote` also answers true for a `pending`/`in_progress` state whose `startedAt` is older than `PROMOTION_TIMEOUT` seconds (parsed once;
   missing or invalid means 3600). Before the new attempt, the worker marks the old state `failed` with reason `abandoned: older than <n>s`
   (best effort: the Spec DO's table (d) must allow `pending|in_progress -> failed`, which it does; if the write fails the new attempt still runs and
   the failure is logged).
2. The bookkeeping after the move is best effort, as `recordMove` already is: a throw from `markAsCompleted` or `markAsFailed` is logged and the
   caller gets the move's real result, not a 500. `transitionToInProgress` stays fatal (nothing has moved yet).

**Mixed version.** Promotion-worker only; the Spec DO routes are unchanged.

**Tests.** A state 2 hours old does not block; a 10-minute-old one still does; `markAsCompleted` throwing yields the move's result and a log line.

## Part F: a promotion token (a-S8), log-only

**Today.** Any of the nine tier-1 (`SPEC_DO_INTERNAL_TOKEN`) holders can call `advance`, set any stage, post canaries and move deploy refs.

**Change, phase 1 (this wave).**
1. `workers/shared/spec-do-auth.ts`: a third header `X-Beehive-Promotion` and secret `SPEC_DO_PROMOTION_TOKEN`; `isPromotionRoute(method, path)`
   lists `POST /api/candidates/:id/advance`, `PATCH /api/candidates/:id/stage`, `POST /canary-deployments`, and the deploy-ref writes
   (`POST /deploy-refs/rollback` and any other write under `/deploy-refs`). One source for the DO and the clients, like `isAdminRoute`.
2. `getSpecDoStub` adds the header on those routes when the worker's env has the secret.
3. The Spec DO, on a promotion route: if the DO's secret is set and the header is missing or wrong, it logs `promotion_token_missing` (Workers Logs
   plus a flood-controlled `governance_events` row naming the route and the asserted actor) and **proceeds**. If the DO's secret is unset, nothing
   is logged. It never refuses in this wave.
4. Holders (the maintainer sets the secret on them): `beehive-promotion-worker`, `beehive-canary-worker`, the Spec DO's host `beehive`, and
   `beehive` again as the edge for the master stage PATCH. Which other worker, if any, calls these routes is listed from the code during
   implementation and checked by a test that greps the workers for the route strings.
5. Drop unused `SPEC_DO` bindings and tokens where the review found them (sandbox-runner never uses its binding): a separate commit, after a
   check that nothing references it.

**Phase 2 (not this wave).** After the maintainer sets the secret everywhere and a week of logs shows no `promotion_token_missing`, a one-line
change refuses with 403. That change gets its own review.

**Mixed version.** Phase 1 never refuses. A worker without the secret sends no header and is only logged.

**Tests.** The header is added only on promotion routes and only when the secret is set; a promotion route without the header proceeds and logs
when the DO's secret is set, and does not log when it is unset; `isPromotionRoute` matches exactly the listed routes (table test).

## Order of commits

1. Failing tests for A to E (`it.fails`), one commit per part.
2. A, then B, then C (m16), then D, then E: each flips its tests, with mutation checks per guard.
3. F as two commits (header plumbing and DO logging; unused bindings).
4. Docs: `docs/OPS.md` (m16 deploy check; the promotion secret and its log line; the 409 `use_advance` and `tournament_exists`),
   `docs/OPEN-QUESTIONS.md` status lines for b1-S5/S6, `docs/FOCUS.md`.

Full unit suite and local e2e (fresh `.wrangler/state`) before the code review; both counts go in the review request.

## Deploy checks (for OPS.md, after the maintainer's push)

- `schema_version = m16`; `gate_verdicts` has `commit_sha` and `simulated`.
- New gate verdicts have notes starting `[simulated]` and a `commit_sha`.
- `evidence_unbound` rows: how often pre-merge evidence could not be bound to a commit.
- `promotion_token_missing`: absent once the secret is set on all holders.
- A stage PATCH to anything but `failed`/`rolled_back` answers 409 `use_advance`.
