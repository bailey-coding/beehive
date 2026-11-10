# Plan: promotion gaps, shadow evidence reaches the ledger and `/promote` checks it

Task: `promotion-gaps` | Spec: `docs/OPEN-QUESTIONS.md` "2026-11-07: tournament winners are decided by arrival order (no
writer for `shadow_score`)" | Tier: heavy (AGENTS.md rule 2 spine: Spec DO schema, promotion train).
Status: **rev 3: Review 2 (verification, 2026-11-09, approve with changes) applied in section 12; Review 1 in section 11; PR A code review in section 13. Sections 13, 12 then 11
supersede conflicting text above. PR A may start; PR B and C wait on V1-V4 (section 12). Maintainer decisions in section 9. No code written.**

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

## 9. Maintainer decisions (2026-11-09: all five accepted as proposed; do not re-litigate)

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

## 11. Review 1 dispositions (independent agent, 2026-11-09: approve with changes, 5 blockers; supersede conflicting text above)

Each blocker was re-checked against the code before accepting.

- **B1 (accepted): shadow evidence is `log`, not `enforce`.** The shadow router mirrors only static targets
  (`workers/shadow-router/config.ts:123,149`) and live canary-ref candidates (`:237-252`), so a `passed_premerge`
  candidate gets no samples; the baseline is a placeholder (`status: 200`, `workers/shadow-router/index.ts:446-452`) and
  candidate bodies are `undefined` (`:463`). Enforcing shadow would block every candidate. Shadow joins train under
  decision 5's reasoning: the `advance` table marks it `log` (a `governance_events` `evidence_missing` row, no refusal)
  until (a) the router mirrors shadow-rung candidates and (b) the baseline is a real production response. Both are a new
  OPEN-QUESTIONS entry, owner: the next shadow-router plan. Samples, the verdict and the tournament's use of scores are
  still built (3.1-3.3): e2e and the demo seed them, and they are ready when the router is. Section 8's body-mode risk
  is replaced by this. Enforced from day one: pre-merge (gate verdict), canary (live head, soaked), rung order, fromRung.
- **B2 (accepted): comparator ack and retry.** `queue()` swallows every error (`scientist-comparator/index.ts:113-137`),
  so 3.3's "throws so the queue retries" was false. Per message: skip candidate ids that are not ledger ids (the static
  `beehive-main` targets); ack on a 404 for an unknown candidate; `message.retry()` only on 5xx or a network error;
  `message.ack()` otherwise; no `ackAll()`. `max_retries` is unset (`wrangler.toml:29-36`), so the platform default
  applies; the PR sets it explicitly to 3, matching the queue consumer's bounded retries.
- **B3 (accepted): purge fit.** `shadow_scores` gets `id TEXT PRIMARY KEY` and `candidate_id TEXT NOT NULL UNIQUE`, no FK
  (rollback floor). Added to `ORG_PURGE_ORDER` before `candidates`, with the orphan sweep `gate_runs`/`near_misses`
  have (`spec-do/index.ts:2789-2795`), since an older build purges candidates without knowing the table. **Not** on the
  tombstone list (no `deleted_at`); the candidate's tombstone plus the route's 404 is enough. Tests: `schema-sync`, the
  fresh-ledger `initSchema` exec, purge with a row and with an orphan.
- **B4 (accepted): verdict actor.** `gate_verdicts.decided_by` references `actors(id)` with foreign keys on; the
  fallback actor is `'unknown'` (`index.ts:4124`). m15 inserts a reserved service actor `scientist-comparator` with
  `INSERT OR IGNORE` (the `resolveMinter` pattern, `:838-846`), and `shadow-samples` uses it for the verdict regardless
  of the header. Test with `foreign_keys` ON. The same latent bug for merge-train's `actorId: 'promotion-worker'` into
  the gate workflow (`merge-train.ts:406`) goes to OPEN-QUESTIONS, not this plan.
- **B5 (accepted): `advance` 404s are told apart.** An unknown or tombstoned candidate answers 404 with
  `code: 'candidate_not_found'`; the worker maps only a code-less `Not found` (an old DO's router) to 503
  `ledger_too_old` (the `USER_TOKEN_NOT_FOUND` pattern, `shared/spec-do-auth.ts:33`).
- **N1:** `shadowMatch = matched_count = sample_count`, coerced to a boolean; `shadowMetrics` stays a JSON string in
  today's `ShadowMetrics` shape (`shared/schemas.ts:205-207`). Test: the response passes the zod schema.
- **N2:** soak is measured from `deploy_refs.moved_at` of the canary head pointing at this candidate, not a
  `deployed_at` (no such column), so a restored deployment counts only its current live time. Decision 3 stays 15
  minutes; a DO var `CANARY_MIN_SOAK_MINUTES` read only when `DEV = 'local'` lets e2e and the demo use 0.
- **N3:** samples reach the DO from e2e and the demo through a new maintainer-tier edge route
  `POST /api/candidates/:id/shadow-samples` (refused for user and viewer tiers). Like `canary-metrics`, a tier-1 holder
  can forge samples (M5A-2 C2); recorded in the PR.
- **N4:** registered as `/^POST \/api\/candidates\/[^\/]+\/shadow-samples$/`; a keyed body must hold exactly one sample
  (400 otherwise). Storage: one idempotency row per mirrored request per candidate on the `main` DO; the comparator
  caps samples at `SHADOW_MAX_SAMPLES = 1000` per candidate (further samples are acked and dropped, logged once), and
  OPS notes the growth.
- **N5:** `advance` stays the decision point (the dry run is advisory; the write re-checks in one transaction).
  Specified: a 409 from the winner's `advance` records the tournament failed (retryable) and the winner's promotion
  state failed with the code; a 409 on a merged car's `advance` leaves its promotion state failed, not completed;
  `retryPromotion` omits `fromRung`; the **losing** tournament entrant gets `outcome: 'eliminated'` and a promotion state
  completed at its starting rung, like the waiting one.
- **N6:** `advance` is added to the M5A-2 B2 inventory of `promoted` writers and is named as the
  `assertPromotionApprovals` site; refusing entry into `passed_shadow` for ineligible real data (M5A-2 rev 5) belongs in
  it later. `SHADOW_MIN_SAMPLES` is the default of the whitelisted policy key `governance.min_shadow_samples`, not a
  second constant.
- **N7:** no change (stage reading confirmed).
- **N8:** section 4 gains two rows: new comparator with an old DO (404 code-less: ack and log
  `shadow_samples_unsupported`, no retry storm), and the old tournament reading real scores through `|| 80` (harmless).
- **Fact corrections:** F3's envelope is at `index.ts:4390`; the router also sends `specId: ''`
  (`shadow-router/index.ts:458`), so the comparator takes `specId` from the DO candidate. F5 fails three ways
  (unvalidated cast at `:4441`, `complexityDelta` undefined, `decided_by = 'unknown'`); `classifyScore` is at
  `:304-310`. The CLI `promote` action is a stub that calls nothing (`cli/src/utils/command-factory.ts:438-442`).

**Tests added to section 5:** `foreign_keys` ON for the verdict upsert; purge with a row and an orphan; non-ledger ids
in a comparator batch; per-message retry vs ack; the losing entrant's state; `retryPromotion` without `fromRung`; the
two `advance` 404s; the response-shape zod parse; the local soak override.

## 12. Review 2 dispositions (verification pass, 2026-11-09: approve with changes; sections 12, then 11, supersede earlier text)

**PR A is unblocked by V5-V7, V9, V10, V13 (its rows) and the flip-readiness list below. V1-V4 gate PR B/C.**

- **V1 (accepted, needs the maintainer before PR C): the tournament's scope.** Default mode is `tournament`
  (`workers/promotion-worker/spec-do.ts:69`); every `/promote` at every rung goes through one tournament per spec
  (`promotion.ts:88-90`, `tournament.ts:38,187`) and a completed one refuses later promotes (`tournament.ts:44-55`). The demo
  climbs only because F8 marks a waiting entrant as moved. Proposed: the tournament decides only `shadow -> train` (the
  competitive rung); every other transition calls `advance` directly in both modes; the tournament is keyed by
  (spec, fromRung). Decision 6 below.
- **V2 (accepted, needs the maintainer before PR C): tournament depends on shadow evidence.** Under B1 no pre-canary
  candidate gets production samples, so a tournament is null vs null. Specified: null-vs-null and null-vs-score fail with
  code `no_shadow_evidence` (distinct from `tie`); an explicit shadow `fail` verdict under `log` mode is `evidence_failed`,
  logged for `advance`, but a failed candidate does not enter a tournament. Consequence, stated plainly: **in production,
  competitive promotion past `shadow` stays blocked until the shadow-router follow-up (option 2)**; the demo and e2e seed
  samples. Decision 6 below.
- **V3 (accepted): the soak override.** `DEV` is set nowhere (`scripts/start-e2e-workers.sh:92` passes no such var) and
  would trigger `seedDatabase` (`index.ts:678-680`). Use a dedicated var `CANARY_MIN_SOAK_MINUTES`, passed like
  `PURGE_MIN_AGE_HOURS:0` in the e2e start script (the Spec DO runs in the `beehive` worker); production guard: the
  value is honored only when `<` the default and the wrangler config for the deployed worker never sets it (OPS check).
- **V4 (confirmed): the tournament's trial write.** `trials.decided_by` references `actors(id)` and the trial route
  uses `body.decidedBy || X-Actor-ID`. The tournament sends the `/promote` caller's `actorId` (an existing actor, as the
  demo does); if absent, no trial is written and the tournament records `trial: skipped`. Test with foreign keys ON.
- **V5 (accepted): stale text, rewritten here.** DDL: `shadow_scores(id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL UNIQUE,
  sample_count, score_sum, matched_count, diffs_json, last_request_id, updated_at, baseline TEXT NOT NULL)`, no FK. It goes in
  `ORG_PURGE_ORDER` (`index.ts:165-184`) before `candidates`, with the orphan sweep; it is not tombstoned. 3.1/3.3
  "throws, so the queue retries" and "any non-OK is an error" are void: a 404 is a distinct not-found result, 5xx/network
  retry (B2). 3.2's header actor is void (B4). 3.4: the `passed_premerge` row's shadow evidence is `log`; canary soak is
  the head ref's `moved_at` (N2), not `status`. Section 4 row 2 follows N8; section 8 risks 2-3 follow B1/N2.
- **V6 (accepted): the service actor.** Inserted lazily inside the route's transaction (`INSERT OR IGNORE`, `type = 'agent'`
  because `actors.type` allows only `human|agent`, `schema-inline.ts:71`), the `resolveMinter` pattern (`index.ts:838-846`),
  not in the m15 step, so a fresh ledger (`initSchema`) is covered. Same for the trial-write fallback.
- **V7 (accepted): the policy key.** No `governance.min_shadow_samples` key exists in code (only `governance.m14_epoch`,
  `index.ts:1265`) and the M5A-2 plan's default is 100 vs this plan's 20. One exported constant `SHADOW_MIN_SAMPLES = 20`
  in `workers/shared/shadow-verdict.ts` behind a `shadowMinSamples()` helper; `docs/M5A-2-GOVERNANCE-PLAN.md:56` gets a
  dated note pointing at it.
- **V8 (accepted): coded 404.** The router's 404s are code-less (`index.ts:4401,4853`), so the new routes build the 404 body
  explicitly from a shared constant `CANDIDATE_NOT_FOUND = 'candidate_not_found'` in `workers/shared/` (the
  `USER_TOKEN_NOT_FOUND` pattern, `spec-do-auth.ts:34`, discriminating on the `error` string). The worker treats any 404
  without that code as `ledger_too_old` (503).
- **V9 (accepted): idempotency and the cap.** "Exactly one sample when keyed" is a handler check on `idem !== null`,
  thrown before the key insert; unkeyed calls open their own `transactionSync` (`idempotent()` opens none without a key).
  `SHADOW_MAX_SAMPLES = 1000` lives in the DO (the edge route bypasses the comparator); over the cap the route answers 200
  with `capped: true` and records nothing.
- **V10 (accepted): comparator queue handling.** Per-message `ack()`/`retry()` are supported by the global
  `MessageBatch` type (`queue-consumer/index.ts:442` already uses `retry`); delete the local shim
  (`scientist-comparator/types.ts:516-531`), remove `allSettled` + `ackAll` (`index.ts:136-142`), and set `max_retries = 4` on
  both consumers (`queue-consumer/wrangler.toml:40` uses 4, not 3).
- **V11:** soak source confirmed (`deploy_refs.moved_at`, read the head row directly).
- **V12 (accepted): `advance` step order.** Same-stage replay (step 5) is checked before `not_next_rung` (step 3), so a
  redelivery is a 200 no-op. The `mode?` body field is removed: log versus enforce is the DO's constant table only.
- **V13 (accepted): mixed-version rows added.** Old promotion worker with new DO: it writes off-by-one stages
  (`promotion-worker/spec-do.ts:73-79`) that the new DO reads one rung ahead; accepted for the window (the stage PATCH is
  unchanged and still logged by PR-S), recorded in OPS. New edge with old DO on `shadow-samples`: 503 `ledger_too_old`.
  The edge route list is explicit (`api/index.ts:223-255`): `advance` is not exposed; a test keeps it so.
- **V14:** router line numbers corrected (`shadow-router/index.ts:447-453,458,464`).

**Flip-readiness (log -> enforce is one constant in the DO).** Table shape: `evidence[]` entries `{ rung, status, mode }`;
workers branch on `evidence_missing`, never on the rung; tests run the shadow row under both modes from PR B. e2e and the demo seed a
real shadow pass (20 samples, average >= 80). **Placeholder-baseline guard:** each sample carries `baseline`
(`'placeholder' | 'production'`, the comparator sends `'placeholder'` until the router follow-up); the verdict counts only
`'production'` samples toward `SHADOW_MIN_SAMPLES` in enforce mode, and in log mode reports both counts, so scores taken
against today's fake `200` can never become enforced evidence and the 1000-sample cap cannot freeze them. Candidates that
passed shadow during the log period are grandfathered: the flip PR changes the constant and nothing else.

**Decision 6 (maintainer, ACCEPTED 2026-11-10 as option 1; do not re-litigate):** (a) tournament scope as in V1; (b) accept that competitive promotion past `shadow`
is blocked in production (null-vs-null fails `no_shadow_evidence`) until option 2 lands, with the demo and e2e seeding
samples. Alternative to (b) if unwanted: a tournament may decide on `pre-merge` verdict score alone while shadow is `log`.

**Follow-up plan (option 2), scope from Review 2:** mirror `passed_premerge` candidates (DO read route, cached like
`live-refs-cache.ts`); per-candidate preview deployment via the preview manager (`isAcceptableCanaryUrl`); capture the real
production response as the baseline (`shadow-router/index.ts:447-453`); capped and redacted bodies (M5A-2 rev 5 path h) and
`MIRROR_BODY_MODE` for POST routes; fill `specId` (`:458`); `baseline: 'production'` marker; then the flip PR. Risks:
mirrored load and cost, untrusted candidate output in queues and Analytics Engine, mirrored write side effects, sample
rate against the 20-sample minimum. Mixed-version: old comparator with new message fields, old router with new DO.

## 13. PR A code review dispositions (independent agent, 2026-11-10: approve with changes, no blockers; fixes in 5b06d0c)

- **S1 (accepted): the cap is per baseline.** A total-count cap froze placeholder evidence and would have forced a reset at the flip.
  `recordShadowSamples` now caps placeholder and production samples separately at 1000 each; a candidate can reach 2000 rows' worth of
  samples in the aggregate. Tests: 1000 placeholder then a production sample is recorded; production has its own cap.
- **S2 (accepted): the edge maps an older Spec DO to 503.** Any 404 from `shadow-samples` whose `error` is not `candidate_not_found` (a
  code-less or non-JSON 404) is a 503, never "unknown candidate" (V13). Tests in `workers/api/tests/shadow-samples-edge.test.ts`.
- **S3 (accepted): list responses use one query.** `shadowFieldsForMany` fetches the page's rows with one `IN (...)` query (chunked at the
  bound-parameter limit); single-candidate reads keep the point query. (The plan said LEFT JOIN; a second query is equivalent here and avoids
  changing `listCandidates`.)
- **S4 (accepted): comparator reads are memoized per client.** One client serves one batch; candidate and spec reads are cached as promises,
  a failure is evicted, a 404 (null) is cached. A 100-message batch no longer fans out one read per message.
- **S5 (accepted): `diffs[].type` is the comparator's four kinds** (`status|header|body|performance`), so `byType` cannot grow without bound.
- **S6 (accepted): tests.** Added: fail to pass; keyed rollback leaves no key, actor or sample; a contract test that runs the comparator's real
  request (keyed, header actor not yet an actor row) against the real Spec DO and parses it with the zod schema; a key over 255 characters is
  hashed and a redelivery still replays; a replay of the m14 to m15 step over an existing row; a corrupt `diffs_json` (`{"byType":null}`, `not
  json`) reads as empty diffs and the next sample repairs it (it was a permanent 500); two-decimal rounding; memo eviction.
- **N1 (accepted):** the DDL has no `baseline` column; the split is `production_count` / `production_score_sum` (the rest of `sample_count` is
  placeholder). V5's DDL line is amended accordingly and the schema comment (both byte-synced files) now says so.
- **N2:** a malformed percent-escape in the id is a 400. **N3:** keyed and unkeyed answers both carry `timestamp`; the stored verdict score is
  floored so a failing 79.6 is not recorded as 80 (the verdict's score and notes are written at a status change, so they are the figures at the
  flip, not live; `shadow_scores` is the live source). **N4:** `message.retry` backs off by `30 s x attempts` (at most 300). **N5:** the dead
  `shadow_*` mapping in `rowToCandidate` is gone. **N6:** OPS.md says plainly that the edge accepts `baseline: 'production'` from any tier-1
  holder, so `production_count` is trustworthy only while that route stays maintainer-only and unused for forged data.

**Verification pass (2026-11-10, independent agent: approve with changes, no blockers).** It confirmed S1-S5, the hashed key, `message.attempts`,
prototype-key safety and the edge 503 (including a JSON body with no `error`). Four non-blocking items, all closed: F1 a test for a batch that
mixes baselines across the placeholder cap (`continue` to `break` now fails a test); F2 `parseShadowDiffs` keeps only finite numbers, so a
hand-corrupted value is dropped and the next sample repairs the aggregate instead of concatenating a string; F3 a test listing 105+ candidates
with a shadow row on the last, with the test SQL shim now enforcing the Workers limit of 100 bound parameters (any unchunked query fails in
tests as it would in production); F4 the retry-delay ceiling and the no-attempt-count fallback are tested. Each was mutation-checked; two
survivors (F3 and the F4 fallback) were test defects, fixed and re-checked.

## 14. PR B implementation notes (2026-11-10)

- Shape: `workers/shared/promotion-advance.ts` (schemas, the evidence-mode table, the pure `decideAdvance`), the route and `advanceCandidate` / `evaluateEvidence` in `workers/spec-do/index.ts`, tests in `workers/spec-do/tests/advance.test.ts`. No schema change. The edge does not route it (`workers/api/tests/advance-not-exposed.test.ts`); the promotion worker is the caller (PR C).
- Decisions the plan left open: (1) a stage already at the target is a 200 no-op checked first (V12), so a stage of `promoted` plus `toRung: full` replays even when the caller's `fromRung` is stale; (2) from `passed_canary`, `toRung: full` still requires the canary evidence and writes only `promoted` (the stage between the two writes of a normal move, left by an interrupted promotion or a future PR-D refusal); (3) log-mode events use the `governance_events` table with `event = 'evidence_missing'` and the PR-S window and cap, deduplicated per (candidate, `<rung>:<status>`); (4) a `failed` shadow or train item is still only logged, because those rungs are log-only as a whole.
- Not in PR B: the promotion worker calling it, the tournament changes, e2e and the demo (PR C); `assertPromotionApprovals` (PR-D) and the real-data eligibility refusal (N6) are marked in the code and the M5A-2 plan note, not built.
- Mutation checks run (each broke a guard and failed a test): both evidence modes, replay-before-stale ordering, the stale check, the two-write `full`, dry run writing events, the soak, the live-canary identity, event dedupe, the coded 404, the override ceiling, one-transaction atomicity. Three survived at first (identity masked by the soak, override masked by the soak, atomicity across two writes) and were closed with tests.

### PR B code review dispositions (independent agent, 2026-11-10: approve with changes, no blockers)

Confirmed: the check order, the 8-stage by 4-rung table (5 go, 4 no-op, 23 `not_next_rung`, matching table (c)), atomicity (nested `transactionSync` is legal on Durable Object SQLite and an inner throw rolls the outer back), the evidence reads, the flood-control query shape and actor columns, and the security reading: `advance` is internal and tier 1 only, and any tier-1 holder could already PATCH `stage` to `promoted` unchecked, so it is strictly narrower and no regression in who can set `promoted`.

- **F1 (accepted):** `passed_canary` plus `toRung: full` plus `fromRung: 'canary'` was a `stale_from_rung`, but that is what a caller promoting a canary says, and every in-flight canary at PR C time is at `passed_canary` (the old worker's off-by-one write). `decideAdvance` accepts `canary` there (only there); tests for the leniency and its limits.
- **F2:** shadow and train rows are tested under `enforce` too (the constant is flipped inside the test and restored): missing and failed refuse with nothing written, a pass moves.
- **F3:** a failing governance log never breaks the write (table dropped, move still lands). **F4:** the hourly cap, the window bound, a `capReached` marker and a warn line on every miss, each tested; OPS says the rows count candidate-hours. **F5:** `AdvanceResultSchema` is not strict (a field a newer Spec DO adds must not make an older reader reject a successful advance). **F6:** the soak boundary is inclusive and tested at 14:59 and 15:00, plus the default note, the event's actor columns, and a dry run on a tombstoned candidate. **F7:** OPS and the governance table corrected. **F8:** a warn line whenever the soak override is in effect.
- **For PR C (carried forward):** in-flight candidates carry the old worker's off-by-one stages (`passed_shadow` or `passed_train` plus `advance(train | canary)` is a no-op; `passed_canary` plus `advance(full)` finishes the move); the worker sends `fromRung` as the rung it believes the candidate is on and treats `stale_from_rung` as a conflict to surface, not retry; a code-less 404 on `advance` is `ledger_too_old` (503), the coded `candidate_not_found` is a 404.

## 15. PR C implementation notes (2026-11-10)

**Decision 6, accepted as proposed (option 1):** the tournament decides only `shadow -> train`; every other move calls `advance`; in production competitive promotion past `shadow` is refused with `no_shadow_evidence` until the shadow-router follow-up; the demo and e2e seed samples.

- **Shape.** `workers/promotion-worker/promotion.ts` asks `advance` (dry run) before it creates any promotion state, then runs: the tournament (tournament mode, `toRung = train`), the merge train (merge-train mode, `toRung = canary`: the train is what leaves the train rung, and a merged car is the train evidence `advance` looks for), or a direct `advance`. `fromRung` is optional and derived. A refusal keeps the Spec DO's reason as `code` and maps to a status: 404 `candidate_not_found`, 409 `stale_from_rung` / `not_next_rung` / `evidence_missing` / `no_shadow_evidence` / `tie` / `tournament_completed` / `gate_failed`, 503 `ledger_too_old` (a code-less 404 from an older Spec DO), 502 `ledger_error`, 500 otherwise.
- **Outcomes** (`PromotionResult.outcome`): `moved` (200), `noop` (200, no promotion state created), `waiting` (202, a lone tournament entrant), `queued` (202, a merge-train car not merged in this call), `eliminated` (200, lost the tournament). Only `moved` and `noop` complete the requester's promotion state at the target rung; the others complete it at the rung it started from. `moves` lists every candidate whose stage this call advanced; a mover who is not the requester (a tournament winner, the first car on the train) gets its own promotion state (`pending -> in_progress -> completed`), so the ledger shows who moved, when and why.
- **Tournament.** Scores are read from the ledger when it decides (a score that landed after a candidate joined counts; 0 is a score). Any entrant without a score is `no_shadow_evidence`, a tie for first is `tie` (never arrival order); either fails the tournament retryably (the recorded reason leads with the code). The decision is a decided trial (winner against runner-up, idempotency key `tournament:<id>:<winner>`) when the request carries an `actorId`, else skipped and said so in `details.trial`. The winner is advanced by the Spec DO; if it refuses (the stage changed, a verdict flipped) the tournament fails with that code and no winner is recorded. `/compare` is no longer called. A third candidate for a completed tournament is `tournament_completed` (409): that the decision still fires on the second arrival is unchanged (OPEN-QUESTIONS).
- **Merge train.** The run claims the first waiting car, which is not always the requester's. A merged car is advanced (`train -> canary`) after the outcome write, so `advance` finds its evidence; the requester's result is `moved` (its own car merged and advanced), `queued` (another car was first, or it waits), or a failure: `gate_failed` (409) or the Spec DO's code when the merged car could not advance (the car is left merged, not undone). A failed car used to answer `success: true`; it now answers 409 `gate_failed`.
- **Retry fixed (found while testing).** `retryPromotion` reset the failed state to `pending` and then called `promoteCandidate`, whose in-progress check refuses a `pending` state: a retry could never run against a real ledger and no test covered it. A retry is now a new attempt (the failed state stays as history) and omits `fromRung`.
- **Carried forward from PR B, handled.** `stale_from_rung` is relayed as a 409, not retried; in-flight candidates carrying the old worker's off-by-one stages are covered by `advance`'s `passed_canary` leniency and its no-ops; a code-less 404 is `ledger_too_old`.
- **Tests.** `workers/promotion-worker/tests/advance-flow.test.ts` (48 tests against a real Spec DO), the rewritten ledger-wiring tests, `tests/unit/promotion-candidate-routes.test.ts`; local e2e (`m3-features`, `cross-worker-flows`, `demo`) now seed real candidates through `tests/e2e/promotion-fixtures.ts` and ran green against the real local workers (62 tests). 19 mutations of the new guards each failed a test.
- **Not done / left as it was.** The `SHADOW_ROUTER` service binding stays configured but unused (removing a binding is a separate, harmless config change). Flipping shadow or train evidence to enforce is still one constant, and must also make the worker's dry-run pre-check tolerate the evidence its own step produces (the train rung in merge-train mode). The third-arrival and decide-on-second-arrival timing of the tournament is unchanged.

### PR C code review dispositions (independent agent, 2026-11-10: approve with changes, 2 blockers)

Confirmed: flow order, the scope of the tournament (`toRung = train`) and the train (`toRung = canary`, whose `advance` looks for a merged car), states (the requester's ends at the target only for moved/noop), the status mapping, `Response.ok` on every path, mixed-version behavior, second-`/promote`-while-waiting (no duplicate entrant), `retryPromotion`, and that no caller other than `scripts/prod-verify-promotion.sh` was broken. Probes P1-P9 reproduced the findings against the real Spec DO.

- **B1 (accepted, fixed): a failing shadow verdict could win the tournament.** Under log mode the dry run lets a `failed` shadow verdict through, and the tournament ranked by score alone (V2 said a failed candidate does not enter). `promoteCandidate` now refuses entry with 409 `evidence_failed`, and entrants are re-checked at decision time (S1), so one whose verdict failed after joining is disqualified.
- **B2 (accepted, fixed): a spec's tournament was dead after three refusals, answering 500.** Evidence refusals (`no_shadow_evidence`, `tie`) were recorded as tournament failures and the ledger allows three. The decision (re-check, scores, tie) now happens before the tournament moves to `in_progress`, so a refusal reads only and spends no attempt; the tournament starts only when a winner exists. A tournament that does exhaust its attempts through real failures answers `409 tournament_exhausted` (was an unexplained 500). Nothing resets an exhausted tournament: OPEN-QUESTIONS.
- **S1 (fixed):** entrants are dry-run through `advance` at decision time; one that cannot move (failed, tombstoned, stage changed) or whose shadow verdict failed is marked `disqualified` (so it cannot poison the next attempt), fewer than two eligible is `409 not_enough_entrants`, and the trial and the loser's near-miss are written only after the winner has moved.
- **S2 (fixed):** the trial is best-effort after the move: an `actorId` that is no actor row (a foreign-key failure) is reported in `details.trial` and the move stands. The trial key now includes the runner-up (`tournament:<id>:<winner>:<runnerUp>`), so a changed runner-up cannot collide with the earlier body.
- **S3 (fixed):** the request's `specId` is checked against the candidate's own spec: `409 spec_mismatch`. **S4 (fixed):** the merge train's "own run" is any car of the requester (a re-added candidate), and an `advance` that was a no-op is not a move (outcome `noop`, no spurious state). **S5 (fixed):** `/merge/retry` returns what the run did (moved 200, `gate_failed` 409, the Spec DO's code when the merged car was refused, `car_not_failed` 409, `candidate_not_found` 404), not "Retrying". **S6 (fixed):** train capacity is `409 train_full`; `tournament_error` and `merge_train_error` remain 500 and are documented as unexpected errors only. **S7 (fixed):** `scripts/prod-verify-promotion.sh` rewritten for the new contract (it seeds shadow scores and expects the higher score to win).
- **S8 (recorded, not changed):** `processQueueMessage` acks every message because `promoteCandidate` never throws, so a 502 or a deploy-window 503 is dropped. It predates PR C and no producer of `promotion-events` exists; to be changed when one does (OPEN-QUESTIONS). **N2 (recorded):** two overlapping decisions can each advance a different winner (the read, decide, advance sequence is not one compare-and-swap, and `recordWinner` writes the candidate list from a copy); predates PR C, recorded beside the second-arrival entry.
- **S9, N1:** tests added for every fix; OPS corrected (two near-misses, the status list, "tournament winners used to skip rungs"). Deviations from the plan text, stated: the tournament is keyed by spec (V1 said (spec, fromRung)), so a tournament completed by an old worker keeps refusing that spec's `shadow -> train`; the trial id is in the result `details`, not in the winner's promotion state (that state has no notes field).
