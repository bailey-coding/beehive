# Plan: promotion gaps, shadow evidence reaches the ledger and `/promote` checks it

Task: `promotion-gaps` | Spec: `docs/OPEN-QUESTIONS.md` "2026-11-07: tournament winners are decided by arrival order (no
writer for `shadow_score`)" | Tier: heavy (AGENTS.md rule 2 spine: Spec DO schema, promotion train).
Status: **rev 1, draft, awaiting independent review. No code written.**

The oracle ladder says a candidate is promotable only when it clears every rung, and the Spec DO is the single
serialization point for that decision (AGENTS.md). Today no rung's result is checked on promotion, and the one oracle
that should rank candidates (shadow) never writes anything. This plan fixes both, in the DO.

## 1. Facts (line numbers at `f6399e5`)

**Shadow evidence never lands.**
- F1. `candidates` has **no** `shadow_score`, `shadow_match` or `shadow_metrics` column (`workers/spec-do/schema-inline.ts:106-124`).
  `CandidateRow` declares them (`workers/spec-do/index.ts:521-523`) and `candidateRowToResponse` returns them
  (`:2316-2318`), but they always read `undefined`. The 2026-11-07 entry says "no writer"; it is worse: no column.
- F2. The comparator's `updateCandidateShadowMetrics` PATCHes `/api/candidates/:id/shadow`
  (`workers/scientist-comparator/storage/spec-do.ts:111`), a route the DO does not have; the 404 becomes `false` (`:117`).
- F3. The comparator's `getCandidate` and `getSpec` return `response.json()` unwrapped (`:50`, `:77`), but the DO answers
  `{ success, data }` (`index.ts:4392`). So `candidate.shadowScore` and `spec.declaredDeltaSurface` are always undefined:
  every comparison uses the default delta surface, and the rolling average always restarts from zero.
- F4. The rolling average is read-modify-write across two fetches (`recordComparisonResult`, `:158-215`), run
  concurrently per message in a batch (`workers/scientist-comparator/index.ts:113`): lost updates even once F1-F3 are fixed.
- F5. `recordShadowVerdict` POSTs `/api/gate-verdicts` without `complexityDelta` (`:137-147`); the column is `NOT NULL`
  (`schema-inline.ts:140`), so it fails too (unverified at runtime; read from the code). It also writes `pass` for any
  score >= 40 ("poor") after one sample (`classifyScore`, `:302-308`).

**The tournament ranks nothing.**
- F6. `getCandidateMetrics` reads the score once, when a candidate joins (`workers/promotion-worker/tournament.ts:276`),
  and uses `shadowScore || 80` (`:329`): a real score of 0 becomes 80, and later samples are never seen.
- F7. `compareCandidates` calls `SHADOW_ROUTER.fetch('/compare')` (`:389`), a route that does not exist, with no auth
  (OPEN-QUESTIONS 2026-11-02; starter issue #6 on `beehive/beehive`). Every comparison falls back to
  `scoreDiff >= 0 ? A : B` (`:430`): equal scores, first candidate wins.
- F8. A lone candidate is told "Added to tournament. Waiting for more candidates." with `success: true`
  (`:63-77`), so `promoteCandidate` marks its promotion state `completed` at `targetRung` (`promotion.ts:97`) though
  nothing was promoted.

**`/promote` checks nothing.**
- F9. `validateRungTransition` allows any forward-or-equal jump (`promotion.ts:361-366`) and `fromRung` comes from the
  caller; neither is checked against the ledger. No gate verdict, trial, train car or canary deployment is read.
- F10. Stages: a tournament winner jumps to `CANDIDATE_STAGE_FOR_RUNG[toRung]` from any stage (`tournament.ts:491-503`;
  `pending -> passed_train` is a logged `skip_ahead` on every run, PR-S section 1.4); merge-train success writes no stage
  (`merge-train.ts:341`); only its rollback does (`:540`). These are the MILESTONES "PR-S enforce prerequisites" (a), (b).
- F11. `CANDIDATE_STAGE_FOR_RUNG[toRung]` is off by one against table (c) (`docs/GOVERNANCE-STATE-MACHINES.md`):
  promoting `shadow -> train` writes `passed_train` before the train has run. Table (c) reads `passed_X` as "passed rung X".
- F12. Evidence writers that exist: `pre-merge` (gate workflow, `workers/gate-workflow/index.ts:287,421`, via gate runs
  upserting `gate_verdicts`, `index.ts:5087-5130`); `shadow` (comparator, broken, F2-F5); canary state (`canary_deployments.status`,
  derived from the deploy-ref head, `syncCanaryStatuses`); train (merge-train cars `merged`, merge-train mode only). No
  writer for a `train`, `canary` or `full` gate verdict.
- F13. Promotion to `full` writes a promotion record and moves no deploy ref. No worker reads the `full` ref; the shadow
  router routes canary only.

**Who calls `/promote`.** `scripts/demo/tournament.ts:176,227`, e2e (`tests/e2e/m3-features.test.ts`,
`cross-worker-flows.test.ts`), the CLI `promote` action, and the `promotion-events` queue (no producer, MILESTONES:56).
The edge does not route `/promote`; callers reach the promotion worker directly with the bearer token.

## 2. Scope

In: F1-F12. Out, each recorded where it lives:
- F13 (`full` moves traffic): "real traffic for `full`" in `docs/FOCUS.md`. This plan only requires canary evidence to
  enter `full`; it adds no `full` ref.
- Building `/compare` (issue #6): this plan stops calling it (section 3.3); the issue is reworded, not closed (section 9).
- Approvals at `promoted` (PR-D hook), change-type classes (PR-C), tombstoned rollback targets (PR-G).
- PR-S **enforce** of table (c): this plan removes the violations normal flows produce today, which is that step's
  prerequisite; switching to enforce stays a separate change.
- The tournament's "decide on the second arrival" timing (a third candidate never competes). Recorded as a new open
  question in the implementation PR.

## 3. Design

### 3.1 Shadow samples table and route (Spec DO, schema m15)

m15 is additive: one new table, nothing altered.

```sql
CREATE TABLE IF NOT EXISTS shadow_scores (
  candidate_id TEXT PRIMARY KEY,
  sample_count INTEGER NOT NULL,
  score_sum REAL NOT NULL,          -- average = score_sum / sample_count; no float drift from re-averaging
  matched_count INTEGER NOT NULL,
  diffs_json TEXT NOT NULL,         -- aggregateDiffs (by type, by severity), the shape of today's ShadowMetrics
  last_request_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

A table, not columns on `candidates`, so the purge list (`index.ts:169`) gains one entry and the candidate row stays
narrow. Added to the purge and tombstone child lists.

New internal route `POST /api/candidates/:id/shadow-samples`, body (zod, strict):
`{ samples: [{ requestId, score (0-100), matched, diffs: [{ type, severity }] }] }` (1-100 samples). One
`transactionSync`: 404 for an unknown or tombstoned candidate; otherwise add each sample, then recompute the shadow
verdict (3.2) and upsert `gate_verdicts(candidate, 'shadow')` when its status changes. Answers
`{ success, data: { sampleCount, averageScore, verdict } }`. Under `idempotent()` (`IDEMPOTENT_ROUTES`, `index.ts:42`):
the comparator sends `Idempotency-Key: <requestId>:<candidateId>`, so a queue redelivery does not double-count.

The read path: `candidateRowToResponse` fills `shadowScore`, `shadowMatch`, `shadowMetrics` from a LEFT JOIN on
`shadow_scores`, keeping today's response fields (the zod `CandidateResponse` already lists them as optional,
`workers/shared/schemas.ts:206-207`). No new response field, so no opt-in is needed.

### 3.2 The shadow verdict (one place, in the DO)

`workers/shared/shadow-verdict.ts` (pure): `shadowVerdict(sampleCount, averageScore)` returns `pending` below
`SHADOW_MIN_SAMPLES`, else `pass` when `averageScore >= SHADOW_PASS_SCORE`, else `fail`. Proposed values:
`SHADOW_MIN_SAMPLES = 20`, `SHADOW_PASS_SCORE = 80` (today's "good"; today's 40 lets "poor" pass). Both are maintainer
decisions (section 9). The comparator's `recordShadowVerdict` and `classifyScore` are deleted (F5 goes with them).

`decided_by` on the verdict is the request's actor (the comparator sends `X-Actor-ID: scientist-comparator`, like
`promotion-worker` does for stage writes).

### 3.3 Comparator and tournament (workers)

Comparator (`storage/spec-do.ts`):
- `getCandidate`/`getSpec` unwrap `data` (accepting a bare body too) and treat any non-OK as an error, not `null`.
- `recordRequestComparison` sends one `shadow-samples` POST per candidate with that request's sample. A non-OK answer
  throws, so the queue retries (max retries per `wrangler.toml`); the idempotency key keeps retries exact.
- `updateCandidateShadowMetrics`, `recordComparisonResult`'s read-modify-write and `recordShadowVerdict` are deleted.

Tournament (`tournament.ts`):
- Scores are read **at decision time** for every competing candidate, not at join time; a missing score is "no
  evidence", never 80 (`??`, not `||`).
- The `/compare` call is removed (F7). Comparison is by the ledger score.
- A candidate joins only if the DO's readiness check (3.4) passes for it, so every competitor has a shadow `pass`.
- A tie on score is never resolved by arrival order. Proposed: a tie fails the tournament with `tie` (retryable once
  more samples land, under the existing `MAX_TOURNAMENT_ATTEMPTS`). Alternative for review: tie-break on lower `aggregateDiffs.bySeverity.error`.
- The decision is recorded as a trial (`POST /api/trials` then `/decide`, existing routes, idempotency key
  `tournament:<id>:<winner>`), so the winner's evidence is in the ledger the same way the demo records it today.

### 3.4 Promotion readiness and advance (Spec DO; the decision point)

Derived current rung, from the candidate's stage (table (c) reading: `passed_X` = passed rung X):

| Stage | Current rung (being run) | Next legal `toRung` | Evidence needed to leave it |
|---|---|---|---|
| `pending` | pre-merge | shadow | `gate_verdicts(pre-merge) = pass` |
| `passed_premerge` | shadow | train | `gate_verdicts(shadow) = pass` (3.2) |
| `passed_shadow` | train | canary | merge-train mode: a car of this candidate `merged`; tournament mode: none exists (log only, below) |
| `passed_train` | canary | full | the candidate's canary deployment is the live canary head (`status = 'deployed'`) for at least `CANARY_MIN_SOAK_MINUTES` (proposed = the SLO window, 15) |
| `passed_canary`, `promoted` | full | none | |
| `failed`, `rolled_back` | none | none (re-run needs a new commit; open M5a-2 item) | |

New internal route `POST /api/candidates/:id/advance`, body (zod, strict)
`{ toRung, fromRung?, dryRun?, notes?, mode? }`. One `transactionSync`:
1. 404 unknown or tombstoned candidate.
2. 409 `stale_from_rung` if `fromRung` is given and differs from the derived rung (a caller acting on stale state).
3. 409 `not_next_rung` if `toRung` is not the next legal rung (no skips, no backwards; table (c) "skip ahead" without a
   recorded policy).
4. Evidence for the rung being left, per the table. Missing evidence: 409 `evidence_missing` with
   `{ rung, need }`, except where the rung's mode is `log` (train in tournament mode only): then a `governance_events`
   row `evidence_missing` (the PR-S flood control applies) and continue.
5. Unless `dryRun`: write the stage for the rung just passed (`passed_premerge`, `passed_shadow`, `passed_train`,
   `passed_canary`) and, for `toRung = full`, then `promoted`, each through `transitionCandidate` so history rows and the
   PR-S log are unchanged. Same stage already written: 200, no write (re-delivery safe without a key).
Answers `{ success, data: { fromRung, toRung, stage, evidence: [...] } }`.

The `log` mode is a constant table in the DO, not a variable: train evidence becomes `enforce` in the PR that adds a
tournament-mode train writer. The master-tier stage PATCH (W8) stays as the documented break-glass, unchanged.

### 3.5 Promotion worker

- `promoteCandidate`: replace `validateRungTransition` with `advance` `dryRun: true` before creating the promotion
  state; relay its 404/409 with the reason code (today a refused move is a 400 or a 500). `fromRung` in the request
  becomes optional; when absent, the DO's derived rung is used and echoed.
- On success (tournament winner or merged train car): `advance` without `dryRun` replaces `setCandidateStage(...
  CANDIDATE_STAGE_FOR_RUNG[toRung])`. `CANDIDATE_STAGE_FOR_RUNG` is deleted. Merge-train success now advances the stage
  (F10 (b)).
- A waiting tournament entrant (F8): answer **202** `{ success: true, outcome: 'waiting' }`, and complete its promotion
  state with `currentRung` = the rung it started from (an attempt that finished without moving). When the tournament
  later decides, the winner gets its own promotion state (`pending -> in_progress -> completed`) so the ledger shows who
  moved, when, and why (trial id in `notes`).
- A non-success result answers 409 for a ledger refusal and 502 for a peer failure, not a blanket 500
  (`promotion.ts:112`).

## 4. Mixed-version window (one push, ten workers, any order)

| Old peer | New peer | Behavior |
|---|---|---|
| comparator (PATCH `/shadow`) | DO | 404, silent `false`: today's behavior, no samples for the window |
| comparator (POST `shadow-samples`) | old DO | 404 -> throw -> queue retries, then drops after max retries; samples lost for the window only. The comparator logs `shadow_samples_unsupported` once per batch |
| promotion worker (no `advance`) | DO | old flow, unchecked, for the window. m15 does not change any route it calls |
| promotion worker (calls `advance`) | old DO | 404 on `advance` -> **fail closed**: 503 `ledger_too_old`, no promotion state created. Promotions pause for the window (minutes; AGENTS.md: a 404 is never "empty") |
| readers of `shadowScore` (tournament, UI) | DO | field present once samples exist; absent before, as today |

No route is removed from the DO. The comparator's old PATCH target never existed.

## 5. Tests (real SQL through the real router, the `deploy-refs.test.ts` style)

- DO `shadow-samples`: accumulates across calls; idempotent replay with the same key does not double-count, a different
  body under the same key is 409; 404 unknown and tombstoned; verdict `pending` until the minimum, then `pass`/`fail`,
  flips both ways with history rows; purge removes the `shadow_scores` row.
- DO `advance`: every row of the 3.4 table, each refusal code, `dryRun` writes nothing (row count before/after),
  `canary -> full` writes `passed_canary` then `promoted` (two history rows, no `invalid_transition`), same-stage replay
  is a no-op, canary soak boundary (one minute under, at), a rolled-back canary is `evidence_missing`.
- Migration: m14 -> m15 on the migration matrix (`workers/spec-do/tests/migration-matrix.test.ts`).
- Comparator: envelope unwrap; a non-OK `shadow-samples` throws; idempotency key format.
- Tournament: a score of 0 loses to 50 (the `||` bug); a score landing after join is used; a tie fails with `tie`;
  `/compare` is never fetched (assert on the `SHADOW_ROUTER` mock); trial written for the winner.
- Promotion worker: 202 for a waiting entrant with `currentRung` unchanged; 409 codes relayed; 503 on an `advance` 404.
- e2e: `m3-features` and `cross-worker-flows` promote fresh `pending` candidates through skipped rungs; they must now
  seed evidence (pre-merge verdict, shadow samples) and step one rung at a time. `npm run demo` likewise: its shadow
  step posts samples instead of a hand-made trial, and its "Known gaps" loses the arrival-order line.
- Mutation checks: each guard in 3.4 broken in turn must fail a test.

## 6. Docs to update in the PR

`docs/GOVERNANCE-STATE-MACHINES.md` (table (c): who writes each stage now; skip-ahead is refused at `advance`),
`docs/OPEN-QUESTIONS.md` (2026-11-07 entries: status; new entry for the tournament's second-arrival timing),
`docs/MILESTONES.md` (PR-S prerequisites (a), (b) done), `docs/OPS.md` (m15 deploy check: `shadow_scores` exists, a
canary-to-full promotion of a non-soaked candidate is 409), `docs/FOCUS.md`, `CONTRIBUTING.md` and issue #6 wording.

## 7. Files touched (estimate)

`workers/spec-do/index.ts`, `schema-inline.ts`, `schema.sql`; `workers/shared/shadow-verdict.ts` (new),
`workers/shared/schemas.ts`; `workers/scientist-comparator/storage/spec-do.ts`, `index.ts`;
`workers/promotion-worker/promotion.ts`, `tournament.ts`, `merge-train.ts`, `spec-do.ts`; tests beside each; the two e2e
files and `scripts/demo/tournament.ts`. Suggested split into three PRs, each green alone: (A) m15 + `shadow-samples` +
comparator; (B) `advance` route + DO tests; (C) promotion worker on `advance`, tournament fixes, e2e and demo.

## 8. Risks

- **Promotions get harder.** Every caller that skipped rungs or promoted without evidence now gets 409. That is the
  point, but e2e and the demo break until updated (part of PR C). Production has no real promotions yet (FOCUS).
- **Shadow samples need traffic.** With `MIRROR_BODY_MODE = "none"` candidates see no request bodies, so POST-heavy
  routes may diverge on everything; `SHADOW_MIN_SAMPLES` may take long to reach. A shadow `fail` from body-less mirroring
  would block honest candidates. The review should check which mirrored routes the comparator scores.
- **Canary soak reads the clock.** `now() - deployed_at`; tests pin time.
- **Off-by-one stage semantics change** (F11). Existing rows written under the old mapping (e.g. a `passed_train`
  candidate that never ran the train) are not repaired; production has only test candidates.

## 9. Open decisions for the maintainer

1. `SHADOW_MIN_SAMPLES` (proposed 20) and `SHADOW_PASS_SCORE` (proposed 80).
2. Tournament tie: fail with `tie` (proposed) or tie-break on error-severity diffs.
3. `CANARY_MIN_SOAK_MINUTES` (proposed 15, the SLO window).
4. Issue #6 (`/compare`): reword to "pairwise comparison beyond the ledger score" (proposed) or close.
5. Train evidence in tournament mode stays `log` until a writer exists (proposed), or tournament mode refuses
   `train -> canary` outright.

## 10. Review asks

- Is the stage reading in 3.4 (stage = last rung passed) the right fix for F11, against table (c) and PR-D's
  "`promoted` only from `passed_canary`"?
- Is `advance` the right single decision point, with the worker's pre-check as `dryRun`, or should the check sit on the
  promotion-state write?
- Mixed-version: is failing closed (503) on an old DO acceptable for the deploy window?
- Anything in the comparator path (F3-F5) I read wrong; F5 is unverified at runtime.
