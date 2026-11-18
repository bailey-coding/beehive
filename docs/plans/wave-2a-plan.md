---
category: planning
status: active
audience: human,agent
---

# Wave 2a: ladder guards (plan, rev 3, 2026-11-18)

From `docs/reviews/2026-11-17-synthesis.md`, "Proposed order of work", Wave 2. The maintainer agreed on 2026-11-18 to split Wave 2 in two:
- **2a (this plan):** the guards: small, self-contained checks in the Spec DO, the gate and the promotion worker;
- **2b (a later plan):** canary evidence (synthesis Wave 2 item 3, problem 3), which is a design problem and waits on two decisions (the delta-surface
  shape, OPEN-QUESTIONS 2026-11-18, and the repository-create namespace hole, OPEN-QUESTIONS 2026-11-17).

Rev 2 folds in the independent plan review (Opus, 2026-11-18: request changes, 2 must-fix, 11 should-fix, 8 nits). Rev 3 folds in its re-check of
rev 2 (approve with changes: 2 must-fix in D3, 2 should-fix, 2 nits). Dispositions are in the last section.

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
| A | b1-S1, a-S2 | The candidate stage PATCH accepts only `failed` and `rolled_back`; every stage PATCH answers 404 before any write for an unknown or tombstoned row, and 400 for an unknown stage; a master-only edge `advance` route replaces the upward PATCH for fixtures | Spec DO, edge |
| B | a-S4, b1-S8 (canary) | `deployCanary` requires a live candidate under the named spec and a matching commit | Spec DO |
| C | b2-S4, b1-S8 | Gate verdicts are labelled simulated and carry the commit (m16); the gate refuses a spec/candidate mismatch and a non-sha; a commit mismatch in evidence is logged | gate-workflow, Spec DO |
| D | b1-S5, b1-S6, b1-S4 | Tournament: minimum sample count; one open tournament per spec; the winner is written before `advance` | promotion-worker, Spec DO |
| E | b1-S2 | A promotion state stuck past `PROMOTION_TIMEOUT` is cancelled and stops blocking; bookkeeping after the move is best effort | promotion-worker |
| F | a-S8 | A third Spec DO token for `advance` and the canary writes, log-only in this wave | shared, Spec DO, three workers |

**Deviations from the synthesis, on purpose** (2b or later picks them up):
- **No `candidates.commit_sha` writer (b2-S8).** The only producer would be the push path, and the push message shape is unverified
  (OPEN-QUESTIONS 2026-11-18). So the commit checks in evidence (parts B4, C4) are **log-only** in 2a; they become enforced together with the writer.
- **Dropping unused `SPEC_DO` bindings** (a-S8 "drop unused bindings") is Wave 3 ("Remove dead code and bindings"), not here.
- **`/canary-metrics` under the promotion token** belongs with canary evidence (2b).

## Decisions for the maintainer

- **M1. Does `deployCanary` require `passed_train`?** Recommendation: **not yet; log it.** Today the canary SLO tests, the e2e canary flows and the
  2026-10-25 production canary deploy `pending` candidates. Requiring `passed_train` makes the only canary path depend on the tournament and merge
  train, which are not proven in production. Part B writes a `governance_events` row (`canary_stage_precondition`, same flood control as
  `invalid_transition`) and 2b makes it enforceable together with the canary evidence.
- **M2. Part F needs a new secret** (`SPEC_DO_PROMOTION_TOKEN`) set by the maintainer on `beehive`, `beehive-promotion-worker` and
  `beehive-canary-worker`. This wave only logs; enforcement is a later, separately reviewed change after the logs show no misses.
- **M3. The e2e fixtures and `scripts/prod-verify-promotion.sh` change** (part A): they place candidates with an upward stage PATCH. They move to a
  new master-only edge route, `POST /api/candidates/:id/advance` (A4). The script is the maintainer's production check, so its new shape needs a nod.

## Part A: stage PATCH integrity (b1-S1, a-S2)

**Today.**
- `PATCH /api/candidates/:id/stage` (`spec-do/index.ts:4468`) writes any stage: `pending -> promoted` answers 200, with only an `invalid_transition`
  log row. It also writes to a tombstoned candidate and then answers 404 after the write has committed (`:1671-1678`, `:4468-4476`).
- The spec and issue PATCHes (`:4410`, `:4721`; `transitionSpec :1593`, `transitionIssue :2214`) write an orphan history row for an unknown id
  (200 `data:null`), restage tombstoned rows, run outside a transaction, and answer 500 for an invalid stage (the CHECK constraint).
- The only worker caller of the candidate PATCH is `merge-train.ts:604` (`rolled_back`). The UI does not call it, the CLI has no command for it
  (`api-client.ts:439` `updateCandidateStage` is unused), and only the master principal reaches it at the edge (`principal.ts:264-273`).

**Change.**
1. The candidate PATCH route checks before writing, inside one `transactionSync`:
   - unknown or tombstoned id: 404 `candidate_not_found` (the existing coded string), nothing written;
   - `stage` not in `CANDIDATE_STAGES`: 400;
   - same stage: 200, as today (idempotent);
   - target `failed` or `rolled_back`: allowed from any stage, as today (rule 7: rollback is never gated). The table (c) log still runs, so a
     `rollback_before_train` row is still written for a low-stage rollback;
   - any other target: **409 `use_advance`**, with the message "stage PATCH only writes failed or rolled_back; use advance". This covers upward
     moves, skip-ahead and backward moves.
   - The check lives in the route, not in `transitionCandidate`, because `advanceCandidate` (`:5025`) writes its ladder steps through
     `transitionCandidate` and must keep doing so. `transitionCandidate` is the only writer of `candidates.stage` (`:1675`).
2. The spec and issue PATCH routes: one `transactionSync`; `WHERE id = ? AND deleted_at IS NULL`; 404 before any write; 400 for a stage outside the
   column's CHECK set (a local list pinned by a test against the schema DDL). No ladder rule: spec and issue stages are not a promotion ladder, and
   user tokens lost these routes in Wave 0.
3. `workers/api/principal.ts:257` ("candidate stage (no transition guard…)") is updated to say the DO now refuses everything but `failed`/`rolled_back`.
4. **A master-only edge route `POST /api/candidates/:id/advance`** forwards the body (`AdvanceRequestSchema`) to the Spec DO and returns its status
   and body unchanged. It is not in `USER_WRITE_ROUTES`, so service and user tokens get 403 (`authorize`'s default). It is the replacement for the
   upward PATCH: it moves one rung at a time and enforces the evidence each rung enforces today (pre-merge only; the others are log-only).
   Mixed version: a new edge with an old DO gets the old DO's `advance`, which exists since PR B (`aaef5e4`, deployed).
5. The CLI's dead `updateCandidateStage` and the factory enum that lists nonexistent stages (`cli/src/.../definitions.ts:309`) are left alone (Wave 3
   dead code), noted there.

**Callers that change.**
- `tests/e2e/promotion-fixtures.ts:45` `setStage` becomes `advanceTo(w, id, rung)`: post a `pass` pre-merge verdict, then call the edge `advance`
  rung by rung. Sites that reach `passed_shadow`/`passed_train`: `cross-worker-flows.test.ts:468,485,570,629`, `m3-features.test.ts:443,526,594`.
  Their shas move to 40-hex (part C).
- `scripts/prod-verify-promotion.sh:71` needs only `passed_premerge`; it uses the edge `advance` with `toRung: shadow` after posting the verdict.
- `workers/spec-do/tests/governance-transitions.test.ts` asserts the log-only behavior of upward PATCHes; it is rewritten to assert the 409 and to
  keep the log-row assertions for `failed`/`rolled_back`.
- `workers/api/tests/{service-accounts,user-tokens}.test.ts` and `tests/unit/promotion-candidate-routes.test.ts`: checked during implementation; most
  assert the edge's 403 for user tokens, which is unchanged.

**Mixed version.** The edge and the promotion worker forward the DO's status. An old promotion worker writes only `rolled_back` through the PATCH.

**Tests (written first).** Spec DO: upward PATCH 409 and stage unchanged; tombstoned candidate 404 and stage unchanged (today the write commits);
unknown spec/issue 404 and no `entity_history` row; invalid stage 400; `failed`/`rolled_back` still 200 from every ladder stage. Edge: `advance` is
forwarded for the master, 403 for a `read_write` user token and a service token.

## Part B: `deployCanary` integrity (a-S4, b1-S8 canary half)

**Today.** `deployCanary` (`spec-do/index.ts:3635-3641`) accepts a candidate id with no ledger row ("Ids need no ledger row") and a candidate filed
under another spec; both become a live canary head that the shadow router mirrors to and the alarm chain keeps ticking for.

**Change.**
1. Inside the existing transaction, before `moveDeployRef`: the candidate must exist, be live, and have `spec_id = request.specId`; the spec must
   exist and be live. Otherwise a **coded** 404 (`candidate_not_found` / `spec_not_found`: a `NotFoundError` subclass or a `code` field, since plain
   `NotFoundError` maps to `RECORD_NOT_FOUND` at `:3593`), or 409 `spec_mismatch`.
2. If `request.commitSha` is given and the candidate's `commit_sha` is non-empty and different: 409 `commit_mismatch` at deploy time. An empty
   candidate sha is accepted (claimed candidates have `''`, b2-S8).
3. M1 (recommended): a candidate below `passed_train` is accepted and logged as `canary_stage_precondition`.
4. Canary evidence in `evaluateEvidence` (`:5031`): when the head's `commitSha` and the candidate's `commit_sha` are both non-empty and differ,
   a `commit_mismatch` governance row is written (non-dry-run only, like `logEvidenceMissing` at `:5016`); the evidence result is unchanged in 2a.

**Callers.** The production path already sends a real candidate: canary-worker -> preview-manager reads the ledger candidate before it builds.
Tests that post canaries for ids with no row (`deploy-refs.test.ts` uses `cand-a`, `spec-a`; `slo-loop-real-do.test.ts`, `near-misses.test.ts`,
`advance.test.ts`, `tests/e2e/cross-worker-flows.test.ts`) get a seeding helper that creates the org, repo, spec and candidate first. That is a test
change, not a behavior change; about 40 call sites.

**Mixed version.** Only canary-worker posts canaries and it already uses ledger candidates. An old canary-worker that gets a new 404/409 surfaces
it as a failed deploy, as for any refusal today.

**Tests.** Ghost candidate 404 and no deploy ref; candidate under another spec 409 and no ref; tombstoned spec 404; commit mismatch 409; a sha
mismatch on the head writes one `commit_mismatch` row on a real advance and none on a dry run.

## Part C: labelled gate verdicts, the commit on the verdict (b2-S4, b1-S8)

**Today.**
- The simulated gate (`gate-workflow/index.ts:702-930`) writes notes like "Test score: 100.0/100"; nothing in the row says it was simulated.
- It accepts a `specId` that is not the candidate's and any non-empty `commitSha`. It parses its **own local** `GateWorkflowRequestSchema`
  (`gate-workflow/index.ts:38-46`), not the shared one at `shared/schemas.ts:561`.
- `gate_verdicts` has one row per (candidate, gate) and no commit (`schema-inline.ts:134-149`); the upsert lists its columns explicitly
  (`spec-do/index.ts:1903-1910`). So a verdict for commit A is evidence for commit B.
- The edge part of b2-S4 (user tokens could start the gate) was closed in Wave 0.

**Change.**
1. **Schema m16 (additive), in this repo's migration pattern:**
   - add `commit_sha TEXT` and `simulated INTEGER` (both nullable; NULL = written before m16 or by a caller that does not send them) to the base
     `gate_verdicts` DDL in `schema-inline.ts` **and** `schema.sql` (kept in sync by `migration-schema-validation.test.ts:180-207`), so a fresh ledger
     stamped LATEST (`spec-do/index.ts:725-766`) has them;
   - the m16 step uses `addColumnsIfMissing` (`:1312`); `LATEST_SCHEMA_VERSION = 'm16'`;
   - the migration matrix gets an m15 legacy fixture with a seeded `gate_verdicts` row, compared against a fresh ledger like A1-A4;
   - `UNIQUE(candidate_id, gate)` stays: changing it needs a table rebuild, which is not additive.
2. `POST /api/gate-verdicts` stores `commitSha` and `simulated`, and the upsert sets `commit_sha = excluded.commit_sha, simulated = excluded.simulated`,
   so a later verdict without a sha clears the old one instead of keeping it. Gate-verdict responses are mapped explicitly (`:2374`) and no reader
   parses them strictly, so the response gains `commitSha` and `simulated` directly.
3. gate-workflow:
   - the notes start with `[simulated] `; the verdict body carries `simulated: true` and `commitSha`;
   - it reads the candidate **before** `setOwned` and the spec fetch (`gate-workflow/index.ts:283-306`) and refuses 400 `spec_mismatch` when `specId`
     is not the candidate's, and 404 when the candidate is unknown or tombstoned (this also closes a-S3 for the gate path);
   - `commitSha` must be 40 lowercase hex, **or equal the candidate's stored `commit_sha`** (so an existing candidate with a non-hex sha still gets
     its merge-train gate run; `POST /api/candidates` never validated the sha, `spec-do/index.ts:4424-4433`). A new `GitShaSchema` lives in
     `shared/schemas.ts`; the gate's local schema and the shared one both use it, pinned by a test;
   - `baseCommitSha` stays `min(1)` (the queue consumer sends a stored value there, `queue-consumer/index.ts:366`).
4. Pre-merge evidence in `evaluateEvidence`: when the verdict's `commit_sha` and the candidate's `commit_sha` are both non-empty and differ, a
   `commit_mismatch` governance row is written; when either is NULL or empty, an `evidence_unbound` row. Both are flood-controlled and written only
   from `advanceCandidate`'s non-dry-run branch (the dry-run contract writes nothing, `promotion-advance.ts:26-27`; the tournament dry-runs every
   entrant). The evidence result is unchanged in 2a: with no `commit_sha` writer, enforcing a match would block a candidate whose repo received a
   push (`queue-consumer/index.ts:364` gates the push sha, which differs from the create-time sha). Enforcement lands with the writer.
5. The merge-train gate call overwrites the pre-merge row (b1-S8). With the commit now on the row, the overwrite is visible; it is not changed here.

**Callers.** Tests and fixtures with short fake shas (`'abc'`, `'sha1'`, about four literal sites outside unit tests plus fixtures) move to 40-hex.
The queue consumer sends the push's sha (assumed 40-hex; if the real push shape is not, the gate answers 400 and the queue consumer logs it, which is
the right failure while the shape is unverified). The merge train sends the candidate's stored sha, accepted by the equality rule.

**Mixed version.**
- New gate, old DO: the DO's route casts the body (`spec-do/index.ts:4538`) and ignores the two extra fields.
- Old gate, new DO: the fields are absent, the columns become NULL, the evidence check logs `evidence_unbound`.
- The m16 migration is two `ADD COLUMN`s; an old DO never reads them.

**Tests.** Gate: spec mismatch 400 with no verdict row and no run-map entry; unknown candidate 404; bad sha 400; a non-hex sha equal to the stored
one accepted; notes start with `[simulated]`. DO: m16 on the m15 fixture; a fresh ledger has the columns; verdict stores the sha; a later verdict
without a sha clears it; mismatch and unbound rows on a real advance, none on a dry run, evidence still `met`. Contract: queue-consumer -> gate ->
DO writes a verdict row with `simulated = 1` and the push sha.

## Part D: tournament (b1-S5, b1-S6, b1-S4)

**D1. Minimum sample count (b1-S5).** `readShadowScore` (`tournament.ts:431`) returns `shadowScore` with no count in the default source, so one
sample at 100 beats 500 averaging 99. Change: the default source also parses `shadowMetrics` (a JSON string, `spec-do/index.ts:5188`) and needs
`totalRequests >= shadowMinSamples()`, otherwise "no score". A missing or unparsable count is "no score" (fail closed, like the production source).
Note: `decideTournament` refuses the whole tournament when any entrant is unscored (`tournament.ts:47-50`), so an under-sampled entrant blocks the
decision (`no_shadow_evidence`) rather than losing; that is today's rule for a missing score, kept. Promotion-worker test seeders that post fewer
than `SHADOW_MIN_SAMPLES` samples are raised (the demo already posts enough). Test: an entrant with one sample has no score and the tournament is
refused `no_shadow_evidence`.

**D2. One open tournament per spec (b1-S6).** In `applyTournamentWrite` (`spec-do/index.ts:3282`), a write that **moves a row into an open state
for its spec** answers 409 `tournament_exists` with the other row's id when the spec has another row (a different id) in `pending` or `in_progress`.
"Moves into" means: a create; a `failed -> pending/in_progress` reopen (`ledger-state-machine.ts:37`); a PATCH that changes `specId`
(`promotion-ledger.ts:118`). Same-status writes on an already open row (adding an entrant, the D3 winner write) are not checked, so a spec that
already holds duplicate open rows in production keeps working on its newest row (the one the worker reads, `listTournaments(specId)[0]`). The check runs in the write's transaction on the single-threaded DO, so two concurrent creates cannot both pass. No
unique index: production may already hold duplicates, and a failing index migration is a full outage (m12).
- The promotion worker's create path, on `tournament_exists`, reads the tournament **by the id in the 409** and joins it.
- Mixed version: an old promotion worker that gets the 409 fails that promotion with `tournament_error`; the retry finds the existing tournament on
  its first read. Acceptable for one window.
- Tests: two creates for one spec, the second 409 with the first id; a reopen of an older failed row while a newer one is open, 409; a PATCH
  moving a row onto a spec with an open tournament, 409; with two open rows already present, adding an entrant to the newest still succeeds; a
  contract test where two entrants arrive "together" end in one tournament with both.

**D3. The winner is written before `advance` (b1-S4).** Today, if `recordWinner` throws after `advance` succeeded, the catch records the tournament
`failed`, spends an attempt and answers 500; a retry sees the winner past the rung (`passed_shadow`, `TARGET_STAGE.train`,
`promotion-advance.ts:37-42`), the dry-run loop (`tournament.ts:135-150`) disqualifies it as `stale_from_rung` with a `tournament_loss` near-miss, and
too few entrants remain.
Change (the synthesis' option, as the review suggested):
1. **Claim the decision in one write.** After `decideTournament` picks a winner, one version-checked `modifyTournament` write moves the row to
   `in_progress` (from `pending`, `failed` or `in_progress`; this replaces today's separate `startTournament` write, `tournament.ts:177`) and sets
   `winner` and the contested set. The contested set is stored in the existing `comparisons` array (`CandidateComparisonSchema`,
   `promotion-ledger.ts:83-92`; nothing writes it today): one entry per contested loser, `{candidate1: winner, candidate2: loser, winner,
   comparisonScore, comparedAt}`. The contested set is the winner plus the `candidate2` values. No new field, no new column, no schema change: the
   strict `TournamentRecordSchema` (`promotion-ledger.ts:110-117`) of an old worker parses the row.
   - The write's `mutate` **refuses** when the row it re-reads already has a `winner`, or is `completed`. `modifyTournament` re-applies `mutate` after a
     version conflict (`casLoop`, `promotion-ledger.ts:281-290`), so of two racing runs only the first claims a winner; the second goes to step 4
     (resume) instead of advancing its own pick. Old workers treat a tournament as decided only when `winner && status === 'completed'`
     (`tournament.ts:103`), and one meeting an `in_progress` row with `winner` set refuses `not_enough_entrants` and writes nothing
     (`tournament.ts:166-169`).
2. **Then `advance`.** A refused `advance` writes the row `failed` and clears `winner` and `comparisons` with a **full-record** write
   (`modifyTournament` replacing the record; `writeTournament` stores `t.winner ?? null`). A PATCH cannot clear them: `TournamentPatchSchema` has
   `winner: z.string().optional()` and the DO merges `{...current, ...patch}` (`spec-do/index.ts:3092`), so today's `recordTournamentFailure` PATCH
   (`tournament.ts:345-351`) moves to a full-record write for this path.
3. **Then complete:** `recordWinner` becomes a `modifyTournament` write on the row as saved (not the stale `tournament.candidates`,
   `tournament.ts:483-497`), so an entrant that joined meanwhile is kept; losers are exactly the stored contested set minus the winner.
4. **Resume:** at the start of `executeTournament`, before the dry-run loop, a row that is `in_progress` with `winner` set is resumed instead of
   decided again: if the winner's stage is `passed_shadow` or later, the row is completed as in step 3; otherwise `advance` is retried for that winner
   (then step 2 or 3). No history-note parsing is needed (notes are tier-1 writable at `spec-do/index.ts:4811` and cannot be proof). A winner that
   was failed or tombstoned meanwhile gets a refused `advance`, so the row goes to `failed` (step 2).
5. A throw in step 3 is caught: the result is success (the winner moved) with `details.recordWinner = 'not recorded: ...'`, and the row is left
   `in_progress` with `winner` set for the next run to resume. It is not marked `failed` and spends no attempt.
- Mixed version: no record field changes, so both directions are safe. Transitions used: `pending|failed -> in_progress`,
  `in_progress -> in_progress`, `in_progress -> failed` (with `failureReason`), `in_progress -> completed`, all allowed by table (d) today.
- Tests: `recordWinner` throws once (fault-injecting ledger stub): success, row not `failed`, next call completes it with the right winner and the
  right losers; the winner already moved on to `passed_train` before the retry: still completed, no `tournament_loss` for the winner; a refused
  `advance` leaves the stored `winner` NULL and `comparisons` empty (read the row, not the response); two runs with interleaved reads (the second
  run's first write conflicts) end with one winner and exactly one `advance` call.

## Part E: stuck promotion state (b1-S2)

**Today.** A throw from `transitionToInProgress`, `markAsCompleted` or `markAsFailed` (`promotion.ts:124-157`) leaves the state `pending` or
`in_progress`; `canPromote` (`state.ts:133`) then answers false for ever and every `/promote` is `409 Promotion already in progress` until
`/cancel`. `PROMOTION_TIMEOUT` (`"3600"`, `wrangler.toml:12`) is declared and never read. Every promotion state is created and finished inside one
`/promote` request (the merge train returns `queued`, `merge-train.ts:209`), and `transitionToInProgress` resets `startedAt` (`state.ts:82`), so a
state older than the timeout is abandoned, not running.

**Change.**
1. `PROMOTION_TIMEOUT` is **seconds** (as in `wrangler.toml`); missing or invalid means 3600. The test envs that set `'300000'`
   (`advance-flow.test.ts:52`, `promotion.test.ts:99`) are corrected to seconds.
2. `canPromote` also answers true for a `pending`/`in_progress` state whose `startedAt` is older than the timeout. Before the new attempt the worker
   moves the old state to **`cancelled`** with `failureReason: 'abandoned: older than <n>s'` (table (d) allows `pending -> cancelled` and
   `in_progress -> cancelled`, as `/cancel` uses, `promotion.ts:400-404`; `pending -> failed` is not allowed). Best effort: if the write fails, the new
   attempt still runs and the failure is logged.
3. Bookkeeping after the move is best effort, as `recordMove` already is: a throw from `markAsCompleted` or `markAsFailed` is logged and the caller
   gets the move's real result, not a 500. `transitionToInProgress` stays fatal (nothing has moved yet).

**Mixed version.** Promotion-worker only; the Spec DO routes are unchanged.

**Tests.** A state two hours old does not block and ends `cancelled`, writing no `invalid_transition` row; a ten-minute-old one still blocks;
`markAsCompleted` throwing yields the move's result and a log line.

## Part F: a promotion token (a-S8), log-only

**Today.** Any of the nine tier-1 (`SPEC_DO_INTERNAL_TOKEN`) holders can call `advance`, set any stage, post canaries and move deploy refs.

**Route list.** After part A the stage PATCH only writes `failed`/`rolled_back`, and rollback must stay cheap (rule 7; `isEnforceable` already
refuses to gate those edges, `ledger-state-machine.ts:122-124`). So the stage PATCH, `/deploy-refs/rollback` and `/canary-deployments/:id/rollback`
are **not** promotion routes. The promotion routes are:
- `POST /api/candidates/:id/advance` (promotion-worker `spec-do.ts:137`; the edge route of A4);
- `POST /canary-deployments` (canary-worker `canary.ts:69`);
- `PATCH /canary-deployments/:id` (turns `autoRollback` off; canary-worker `index.ts:117`).

Holders: `beehive-promotion-worker`, `beehive-canary-worker`, and `beehive` (the edge and the Spec DO's host are the same worker).

**Change, phase 1 (this wave).**
1. `workers/shared/spec-do-auth.ts`: a header `X-Beehive-Promotion`, a secret `SPEC_DO_PROMOTION_TOKEN`, and `isPromotionRoute(method, path)`, one
   source for the DO and the clients like `isAdminRoute`.
2. `getSpecDoStub` adds the header on those routes when the worker's env has the secret.
3. The Spec DO, on a promotion route: if its secret is set and the header is missing or wrong, it logs `promotion_token_missing` to Workers Logs,
   and, except for an `advance` with `dryRun: true`, a flood-controlled `governance_events` row naming the route and the asserted actor; then it
   **proceeds**. The auth gate runs before the body is parsed (`specDoAuthGate`, `spec-do-auth.ts:103`), so the gate only marks the request; the
   governance row is written by the `advance` handler after it has parsed the body and knows `dryRun`. If the DO's secret is unset, nothing is logged. It never refuses in this wave.
4. A test greps `workers/` for the three route strings and asserts every caller is one of the three holders.

**Phase 2 (not this wave).** After the maintainer sets the secret on all three and a week of logs shows no `promotion_token_missing`, a small change
refuses with 403. It gets its own review.

**Mixed version.** Phase 1 never refuses. A worker without the secret sends no header and is only logged.

**Tests.** A table test of `isPromotionRoute` (the three routes match; the stage PATCH, both rollback routes and `/canary-metrics` do not); the header
is added only on promotion routes and only when the secret is set; a missing header proceeds and logs when the DO's secret is set, does not log when
unset, and writes no governance row on a dry-run `advance`.

## Order of commits

1. Failing tests for A to E (`it.fails`), one commit per part.
2. A, then B, then C (m16), then D, then E: each flips its tests, with mutation checks per guard.
3. F.
4. Docs: `docs/OPS.md` (m16 deploy check; the promotion secret and its log line; the 409 `use_advance` and `tournament_exists`; the edge
   `advance` route), `docs/OPEN-QUESTIONS.md` status lines for b1-S5/S6, `docs/FOCUS.md`.

Full unit suite and local e2e (fresh `.wrangler/state`) before the code review; both counts go in the review request.

## Deploy checks (for OPS.md, after the maintainer's push)

- **Before the push:** count live candidates whose `commit_sha` is neither empty nor 40-hex (the gate accepts them only via the equality rule;
  a nonzero count is fine but worth knowing).
- `schema_version = m16`; `gate_verdicts` has `commit_sha` and `simulated`.
- New gate verdicts have notes starting `[simulated]` and a `commit_sha`.
- `evidence_unbound` and `commit_mismatch` rows: how often evidence could not be bound to the candidate's commit (input for enforcing it).
- `promotion_token_missing`: absent once the secret is set on all three holders.
- A stage PATCH to anything but `failed`/`rolled_back` answers 409 `use_advance`.
- `scripts/prod-verify-promotion.sh` needs the new edge `advance` route: run it only after all ten builds have landed (an old edge answers 404,
  a clear failure).

## Review dispositions (independent plan review, 2026-11-18, Opus)

| Finding | Disposition |
|---|---|
| M1 D3 checks `passed_train`; reconcile after the dry-run loop | Fixed by adopting S8's alternative: winner written before `advance`, resume before the dry-run loop, stage `passed_shadow` or later (D3) |
| M2 no edge `advance` route for fixtures | Fixed: master-only edge route (A4); fixtures and prod-verify use it; shas to 40-hex |
| S1 commit match enforced before a writer exists | Fixed: log-only `commit_mismatch` in B4 and C4; enforcement with the writer |
| S2 upsert must overwrite the new columns | Fixed (C2) with a test |
| S3 m16 pattern | Fixed: base DDL, `schema.sql`, `addColumnsIfMissing`, m15 fixture (C1) |
| S4 the gate's local schema | Fixed: shared `GitShaSchema` used by both, pinned (C3) |
| S5 non-hex stored shas | Fixed: accept a sha equal to the stored one; pre-push count in deploy checks |
| S6 logging on dry runs | Fixed: rows only from the non-dry-run branch (C4, B4, F3) |
| S7 D2 bypasses | Fixed: check on every write ending `pending`/`in_progress`; join by the 409's id (D2) |
| S8 second writer, contested set, option choice | Fixed: `modifyTournament` for every write, `contested` stored, synthesis option adopted (D3) |
| S9 `pending -> failed` not allowed | Fixed: `cancelled` with an `abandoned` reason; units pinned to seconds (E) |
| S10 route list | Fixed: rollback paths and the stage PATCH out, canary PATCH in, three holders (F) |
| S11 dropping bindings is Wave 3 | Fixed: moved out (deviations) |
| N1 coded 404s | Fixed (B1) |
| N2 `shadowMetrics` is a string; refusal not "pick the other" | Fixed (D1) |
| N3 no m15 code path for the mixed-version test | Fixed: rely on the route's cast (C, mixed version) |
| N4 no CLI stage command | Fixed: text corrected; dead CLI code left for Wave 3 (A5) |
| N5 stale `principal.ts:257` comment | Fixed (A3) |
| N6 `evaluateEvidence` line | Fixed |
| N7 gate check order; a-S3 for the gate | Fixed (C3) |
| N8 deviations from the synthesis | Fixed: listed under "Deviations" |

### Re-check of rev 2 (same reviewer, 2026-11-18): approve with changes

| Finding | Disposition |
|---|---|
| M1 `contested` cannot be stored, and breaks old strict readers | Fixed: the contested set lives in the existing `comparisons` array; no new field (D3.1) |
| M2 two racing runs can advance two winners | Fixed: the winner claim refuses when a winner exists; start and claim are one write; race test (D3.1) |
| S1 a PATCH cannot clear `winner` | Fixed: the failure write is a full-record write; test reads the stored row (D3.2) |
| S2 D2 blocks same-status writes on duplicate rows | Fixed: only transitions into an open state are checked; test with two open rows (D2) |
| N1 the auth gate runs before the body | Fixed: the gate marks, the `advance` handler writes the row (F3) |
| N2 prod-verify in the mixed window | Fixed: deploy-check note |
