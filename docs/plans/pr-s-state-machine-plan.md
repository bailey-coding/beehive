# PR-S plan: shared governance state machine, log-only candidate-stage and promotion-state validation

**Date:** 2026-11-01 | **Status:** draft, awaiting independent plan review (AGENTS.md rule 2, heavy tier) | **Task:** pr-s-plan
**Spec:** `docs/M5A-2-GOVERNANCE-PLAN.md` "PR slicing" (rev 3 and rev 5: "PR-S shared pure `governance-state-machine.ts` with tests, plus log-only candidate-stage validation (`invalid_transition` rows)"), Rev 3 S3, S9; normative tables (c) and (d) in `docs/GOVERNANCE-STATE-MACHINES.md`.
**Scope:** pure module + log-only checks in the Spec DO. No refusal, no schema change, no change to any worker other than `spec-do`, no response-shape change. Enforcement is a later PR (see "Switching to enforce").

Line numbers are for the tree at `4cbb0e3`. Several in `docs/GOVERNANCE-STATE-MACHINES.md` have drifted (it cites `transitionCandidate` at `:1559`, it is now `:1594`); PR-S updates them.

---

## 1. Facts (investigated, file:line)

### 1.1 Writers of `candidates.stage`

| # | Writer | Where | Stage written | In `transactionSync`? | Notes |
|---|---|---|---|---|---|
| W1 | `createCandidate` | `workers/spec-do/index.ts:1540-1572` (INSERT `:1551`, history `:1557`) | `'pending'` (hard-coded) | **No** (bare, but fully synchronous; called inside `this.idempotent(...)` from `POST /api/candidates`, `:4182-4193`) | Initial stage is a constant; nothing to check. |
| W2 | `claimSpec` | `index.ts:1627-1715` (INSERT `:1690-1704`, history `:1706`) | `'pending'` (hard-coded) | **No**; `await createFork(...)` (`:1662`) precedes the sync writes | Initial stage is a constant; nothing to check. |
| W3 | `transitionCandidate` | `index.ts:1594-1605` (UPDATE `:1598`) | any value from the request body | **No**: bare UPDATE + `recordHistory` | Only caller: `PATCH /api/candidates/:id/stage`, `index.ts:4222-4236`. The handler `await request.json()` first, writes, **then** reads the row and answers 404 for an unknown id, so an unknown id leaves an orphan `entity_history` row (Rev 3 S3 (ii)). Body is not validated (`UpdateCandidateStageRequest`, a cast): an unknown stage fails the schema CHECK and surfaces as a 500 with no history row. |
| W4 | `executeCandidateInSandbox` success | `index.ts:5557-5640` (UPDATE `commit_sha, stage` `:5610-5615`, history `:5618`) | `'passed_premerge'` | **No**; runs after `await fetch` + `await pollForResult` | Route `POST /api/candidates/:id/execute`, `index.ts:4558-4600`. Writes from **any** current stage, including `promoted`. Also sets `commit_sha`. |
| W5 | `executeCandidateInSandbox` failure (catch) | `index.ts:5625-5634` (UPDATE `:5629`) | `'failed'` | **No** | Any current stage, including `promoted`. |
| W6 | `seedDatabase` | `workers/spec-do/seed.ts:419-438` (`INSERT OR IGNORE`, fixture stages `seed.ts:225,234` = `passed_premerge`) | fixture value | n/a (insert) | Only when `env.DEV === 'local'` and not seeded (`index.ts:656-659`). An insert, not a transition: out of scope. |
| W7 | Promotion worker, over W3 | `workers/promotion-worker/spec-do.ts:99-117` (`setCandidateStage`, throws on `!ok`) | `CANDIDATE_STAGE_FOR_RUNG[toRung]` (`spec-do.ts:73-79`: `pre-merge->passed_premerge ... full->promoted`) | via W3 | Callers: tournament winner `tournament.ts:499` (any current stage -> stage of `toRung`) and merge-train rollback `merge-train.ts:470` (`rolled_back`). |
| W8 | Edge, over W3 | `workers/api/index.ts:227`, `:1751-1760` (`handleUpdateCandidateStage`) | request body | via W3 | Master/service tier only; user tokens are refused (`workers/api/principal.ts:255-260`, "candidate stage (no transition guard...)"), e2e asserts 403 (`tests/e2e/user-tokens.test.ts:103`). |

`grep "candidates SET"` finds only `:1598`, `:1616` (preview columns, not stage), `:5611`, `:5629`. Not a stage writer: `POST /api/entities/:type/:id/history` (`index.ts:4536-4551`) writes arbitrary `entity_history.stage` text but never `candidates.stage`; it stays out of scope (noted as a risk: history can disagree with the row).

### 1.2 Writers of `promotion_states.status`

| # | Writer | Where | In `transactionSync`? | Notes |
|---|---|---|---|---|
| P1 | `createPromotionState` | `index.ts:2979-2996`; route `POST /promotion-states` `:2879-2884` | **Yes** (`:2980`) | Zod-parsed (`PromotionStateSchema`). The promotion worker always creates `pending` (`workers/promotion-worker/state.ts:38`); unit tests create `failed` directly (`workers/spec-do/tests/promotion-ledger.test.ts:126,157`). |
| P2 | `patchPromotionState` | `index.ts:2999-3023`; route `PATCH /promotion-states/:id` `:2885-2890` | **Yes** (`:3003`) | Merges any patch; `current` and `next` are both in hand inside the transaction. No `X-Actor-ID` is sent on PATCH (`workers/shared/promotion-ledger.ts:236-242`); create sends it (`:231`). `handlePromotionLedger` (`index.ts:2844`, called `:3941`) takes no actor today. |

There is no `status` CHECK on `promotion_states` (`schema.sql`, `status TEXT NOT NULL`); the zod enum is the only constraint.

### 1.3 Enums vs the tables

- Candidate stage: schema CHECK (`workers/spec-do/schema.sql:113-116`, mirrored `schema-inline.ts:115-116`), `CandidateRow['stage']` (`index.ts:497`) and `CandidateStageSchema` (`workers/shared/schemas.ts:164-173`) all list exactly `pending, passed_premerge, passed_shadow, passed_train, passed_canary, promoted, failed, rolled_back`, the same eight states as table (c). No enum change is needed.
- Promotion-state status: **`cancelled` already exists** in the zod enum (`workers/shared/promotion-ledger.ts:32`: `pending, in_progress, completed, failed, rolled_back, cancelled`) and is written by `cancelPromotion` (`workers/promotion-worker/promotion.ts:315-319`). The parenthetical in table (d) ("does not exist in the zod enum today") is stale; PR-S corrects the doc. No enum change is needed.

### 1.4 What real flows do today (for the log-only measurement)

Promotion mode defaults to `tournament` (`workers/promotion-worker/spec-do.ts:69`). Rung validation allows any forward-or-equal jump (`promotion.ts:361-366`: `toIndex >= fromIndex`).

| Flow | Stage writes (from -> to) | Table (c) verdict |
|---|---|---|
| Tournament winner, e2e `tests/e2e/m3-features.test.ts:437-520` and `workers/promotion-worker/tests/promotion.test.ts:619-640`: fresh candidates (`pending`) promoted `shadow -> train` | `pending -> passed_train` | **violation (skip ahead)** on every tournament run |
| e2e `m3-features.test.ts:628-640`, `canary -> full` in tournament mode | `<current> -> promoted`; a fresh e2e candidate is `pending` | **violation (promote not from `passed_canary`)**, the load-bearing edge |
| e2e `cross-worker-flows.test.ts:450-480`, `shadow -> train` then `train -> canary` | tournament: `pending -> passed_train -> passed_canary`; merge-train: none | first write is a skip-ahead violation |
| Merge-train success (`merge-train.ts`) | **none**: merge-train mode never writes `candidates.stage` on success (only `:470` on rollback) | n/a; the stage stays where it was (usually `pending` or `passed_premerge`) |
| Merge-train rollback of a merged car (`merge-train.ts:440-470`) | `<current, usually pending/passed_premerge> -> rolled_back` | **violation (rollback before train)** because merge-train never advanced the stage |
| Sandbox execute (W4/W5) | `<any> -> passed_premerge` / `<any> -> failed` | `pending -> *` valid; re-execute from `passed_shadow..passed_canary` is **backward** (not in the table); from `promoted` it is the explicit **refuse** edge; `promoted -> failed` is a violation |
| Promotion state (P1/P2) via the worker: `pending -> in_progress -> completed|failed`; retry `failed -> pending` (`promotion.ts:244-249`); cancel `pending|in_progress -> cancelled` (`:315`) | all valid under table (d) |
| `markAsRolledBack` (`state.ts:114-121`) | would be `completed -> rolled_back` | violation under (d), but **no caller exists** (grep) |

Conclusion: the log-only rollout will produce `invalid_transition` rows from **today's normal tournament and merge-train flows**, not only from bugs. That is the reason for log-only first and the main input to the enforce decision (section 9). The promotion worker, not the DO, is what must change before enforcing (advance stages rung by rung, write `passed_train` in merge-train mode, stop skip-ahead `toRung`), and that is out of scope here.

---

## 2. Decisions on scope

1. **Tables (c) and (d) only.** Approvals (a), policy mode (b) and intent (e) are **deferred** to the PRs that add their writers (PR-D, PR-F, PR-G). Reasons: (i) AGENTS.md "every module must be reachable": a helper only imported by tests is unreachable code; (ii) their inputs (eligible set E from `user_tokens.created_via`, the signed principal envelope, the approval rows) do not exist in code yet, and the plan forbids PR-D/PR-F starting before B1-B3 designs, so encoding them now would freeze an API before its design review. The module header lists the deferred tables so the next PR adds them in place.
2. **Where (d) lives.** Table (d) says "enforce in the same module as the tournament machine" (`ledger-state-machine.ts`), while the target says one governance module. Plan: `checkPromotionStateTransition` goes in `workers/shared/ledger-state-machine.ts` beside `checkTournamentTransition` (it is a promotion-ledger record, its client already imports that file via `promotion-ledger.ts:12`), and `governance-state-machine.ts` holds the candidate machine and the shared violation/event vocabulary. **Review ask R1:** accept, or put both in the governance module.
3. **Reachability.** Both new functions are called by Spec DO writers reachable from the edge router and the promotion worker's SPEC_DO binding. No client imports them in PR-S (optional follow-up: the promotion worker could pre-check `cancel`/`retry` with the same function).

---

## 3. Module API

### 3.1 `workers/shared/governance-state-machine.ts` (new, pure, no I/O, no `Date`)

```ts
export const CANDIDATE_STAGES = ['pending','passed_premerge','passed_shadow','passed_train','passed_canary','promoted','failed','rolled_back'] as const;
export type CandidateStage = typeof CANDIDATE_STAGES[number];
/** The ladder order used for skip/backward detection. */
export const CANDIDATE_LADDER: readonly CandidateStage[] = ['pending','passed_premerge','passed_shadow','passed_train','passed_canary','promoted'];

/** What caused the write. A PATCH carries no rung or commit, so it is 'stage_patch'. */
export type CandidateWriteSource = 'stage_patch' | 'execute_pass' | 'execute_error';
export interface CandidateTransitionContext { source: CandidateWriteSource; }

export type CandidateRule =
  | 'skip_ahead'              // forward by more than one ladder step
  | 'backward'                // lower ladder stage that is not a listed reset
  | 'promote_not_from_canary' // into promoted from anything but passed_canary
  | 'promoted_exit'           // out of promoted to anything but rolled_back (re-execute included)
  | 'rollback_before_train'   // into rolled_back from pending/passed_premerge/passed_shadow/failed
  | 'reset_needs_execute'     // failed/rolled_back -> passed_premerge not via sandbox execute
  | 'unknown_stage';          // from or to outside CANDIDATE_STAGES (the CHECK will refuse the write anyway)

export interface GovernanceViolation {
  code: typeof INVALID_TRANSITION;   // re-exported from ledger-state-machine.ts, one vocabulary for the 409 body later
  machine: 'candidate_stage' | 'promotion_state';
  rule: string;                      // CandidateRule | PromotionStateRule
  from: string | null;
  to: string;
  message: string;
}

/** Null when `to` may be written over `from`. Same-state is always null. Never throws (unknown input -> 'unknown_stage'). */
export function checkCandidateTransition(from: string, to: string, ctx: CandidateTransitionContext): GovernanceViolation | null;

/** True for the only edge the PR-D hook will gate (entering promoted). Exported now so PR-D shares it. */
export function entersPromoted(from: string, to: string): boolean;
```

Allowed edges (rows = from; same-state always allowed):

| from | allowed `to` |
|---|---|
| pending | passed_premerge, failed |
| passed_premerge | passed_shadow, failed |
| passed_shadow | passed_train, failed |
| passed_train | passed_canary, failed, rolled_back |
| passed_canary | promoted, failed, rolled_back |
| promoted | rolled_back |
| failed | passed_premerge (only `source = execute_pass`) |
| rolled_back | passed_premerge (only `source = execute_pass`), failed (see R2) |

Rule precedence when an edge is not allowed: `unknown_stage` > `promoted_exit` > `promote_not_from_canary` > `rollback_before_train` > `reset_needs_execute` > `skip_ahead` > `backward`. Encoded as data (`ALLOWED: Record<CandidateStage, readonly CandidateStage[]>` plus `EXECUTE_ONLY` pairs) like `ALLOWED` in `ledger-state-machine.ts:33-38`, so the table-driven test iterates the 8x8 matrix.

Interpretations to confirm (**review ask R2**):
- Table (c) "skip ahead ... only if the request's toRung is the immediate next rung or the recorded policy allows the skip": the DO sees no `toRung` on a stage PATCH and no skip policy is recorded anywhere, so any forward jump of more than one step is `skip_ahead`. `pending -> passed_shadow` and beyond count as skip-ahead too.
- `rolled_back -> failed` (a failed re-execute of a rolled-back candidate) is allowed, by analogy with `pending -> failed`; table (c) lists only "any non-terminal -> failed" and does not say whether `rolled_back` is terminal.
- Re-execute from `passed_shadow..passed_canary` (`-> passed_premerge`) is `backward`; the table lists re-execute only from `failed`/`rolled_back`.
- "re-execute with a new commit" is not checked for a changed sha in PR-S (the sandbox may return the same sha); the detail records `commitChanged` for measurement. PR-D's approval staleness keys on the sha anyway.

### 3.2 `workers/shared/ledger-state-machine.ts` (addition)

```ts
type PromotionStatus = PromotionState['status'];
const PROMOTION_ALLOWED: Record<PromotionStatus, readonly PromotionStatus[]> = {
  pending: ['pending','in_progress','cancelled'],
  in_progress: ['in_progress','completed','failed','rolled_back','cancelled'],
  failed: ['failed','in_progress','pending'],
  completed: ['completed'], rolled_back: ['rolled_back'], cancelled: ['cancelled'],
};
export type PromotionStateRule = 'initial_not_pending' | 'terminal' | 'not_allowed';
/** prev null = create. Null when allowed. Never throws. */
export function checkPromotionStateTransition(prev: PromotionStatus | null, next: string): GovernanceViolation | null;
```

`GovernanceViolation` is defined in `ledger-state-machine.ts` (which has no imports from the governance module) and re-exported by `governance-state-machine.ts`, so there is no import cycle.

---

## 4. Writer sites (Spec DO, `workers/spec-do/index.ts`)

A new private method does the check and the log, and **never throws**:

```ts
/** Log-only (PR-S). Call inside the write's transaction, after reading `from` and before or after the UPDATE. */
private logTransitionViolation(v: GovernanceViolation | null, subject: string, assertedActorId: string | null, extra: Record<string, unknown>): void
```

| Site | Change | Transaction |
|---|---|---|
| W3 `transitionCandidate` (`:1594`) | Gains an optional `ctx` (default `{source:'stage_patch'}`). Body becomes one `transactionSync`: `SELECT stage, spec_id FROM candidates WHERE id = ?` (live or tombstoned, same as the UPDATE's `WHERE id = ?`), UPDATE, `recordHistory`, then if the row existed `logTransitionViolation(checkCandidateTransition(prev, newStage, ctx), ...)`. | **New** `transactionSync`. Unknown id keeps today's behavior exactly (no-op UPDATE, history row, handler 404): no new throw, so the main-catch `NotFoundError` mapping of Rev 3 S3 (ii) is not needed yet and stays with PR-D. An unknown stage still fails the CHECK inside the transaction, now rolling back cleanly (no history row, as today) and still a 500. |
| W4 execute success (`:5610-5618`) | Wrap UPDATE + history in `transactionSync`; read `stage, commit_sha` first; check with `{source:'execute_pass'}`; detail gets `commitChanged`. | **New** `transactionSync` (synchronous block after the awaits; no await inside). |
| W5 execute failure (`:5625-5634`) | Same, `{source:'execute_error'}`. | **New** `transactionSync`. |
| W1, W2, W6 | No check: constant initial `pending` (W1, W2) or dev seed insert (W6). The module exports nothing for "initial candidate stage" because no writer chooses one. | unchanged |
| P1 `createPromotionState` (`:2979`) | Inside the existing transaction, after the INSERT: `logTransitionViolation(checkPromotionStateTransition(null, state.status), 'promotion_state:'+id, ...)`. | existing |
| P2 `patchPromotionState` (`:2999`) | Inside the existing transaction, after computing `next`: `checkPromotionStateTransition(current.status, next.status)`. | existing |

Actor: `transitionCandidate` already receives `changedBy` (the `X-Actor-ID` value, `index.ts:3951`). `handlePromotionLedger` gains `request.headers.get('X-Actor-ID')` read locally (create sends it; patch does not, so `null`). Both go to `asserted_actor_id`; `actor_id` stays `NULL` in PR-S because no verified principal exists in the DO yet (the signed envelope is PR-D0/PR-G). **Review ask R3:** confirm `actor_id = NULL` rather than copying the asserted id.

### 4.1 Log-only semantics

- The writer's result, status code, response body and `entity_history` row are byte-for-byte what they are today. The check never refuses.
- `logTransitionViolation` wraps the check result handling, the dedupe read and the INSERT in `try { ... } catch (e) { console.error('[SpecDO] invalid_transition log failed', ...) }`. The INSERT is a single statement, so a failing INSERT is rolled back at statement level by SQLite and the enclosing `transactionSync` continues and commits the stage write. PR-S does **not** rely on nested `transactionSync` (savepoint) semantics, which `docs/` does not document for DO SQLite; if the implementer finds nesting is needed, that is a finding for `docs/OPEN-QUESTIONS.md`.
- The pure functions are also called inside the `try`, so a bug in them cannot break a write.
- Every detected violation also emits one `console.warn('[SpecDO] invalid_transition', {machine, rule, from, to, subject})`, including suppressed ones, so Workers logs show the true rate even when the table is capped.

---

## 5. Event row and flood control

Row (`governance_events`, m14, `schema.sql:720-732`):

| column | value |
|---|---|
| `id` | `generateId()` |
| `event` | `'invalid_transition'` (S9 frozen name) |
| `actor_id` | `NULL` (R3) |
| `asserted_actor_id` | `X-Actor-ID` / `changedBy`, or `NULL` |
| `subject` | `candidate:<id>` or `promotion_state:<id>` |
| `reason` | `<machine>:<from>-><to>` e.g. `candidate_stage:pending->passed_train` (the dedupe key, human-readable) |
| `detail` | JSON `{v:1, machine, rule, from, to, source, specId, candidateId, commitChanged?, suppressedSince?}`; **never** the request `notes` or any client text. Capped at `MAX_GOVERNANCE_DETAIL_BYTES = 2048` (UTF-8), replaced by `{"v":1,"truncated":true,"bytes":N}` when over, as `recordNearMiss` does (`index.ts:1868-1870`). |
| `created_at` | `now()` |

Flood control (the table is never purged, `schema.sql:646-647`):
1. **Dedupe per key and window.** Before inserting: `SELECT 1 FROM governance_events WHERE event = 'invalid_transition' AND created_at >= ? AND subject = ? AND reason = ? LIMIT 1` with `? = now() - INVALID_TRANSITION_WINDOW_MS` (1 hour). A hit skips the insert. The scan uses `idx_governance_events_event (event, created_at)` and is bounded by step 2.
2. **Global cap.** `SELECT COUNT(*) ... WHERE event = 'invalid_transition' AND created_at >= ?` (same window); at `INVALID_TRANSITION_CAP_PER_WINDOW = 100` the insert is skipped. The first row after a capped window carries `detail.suppressedSince` (count derived from Workers logs, not stored). Worst case: 100 rows/hour, 2,400/day; one subject repeating the same edge adds at most 24/day.
3. No new index, no schema change. Constants exported from `governance-state-machine.ts` so tests and docs use the same numbers. **Review ask R4:** window and cap values; whether `invalid_transition` rows should be exempt from "never purged" (e2e runs on production create them for test-org candidates that are later purged).

---

## 6. Mixed-version table (one push deploys all ten workers, no order)

| Combination | Behavior | Safe? |
|---|---|---|
| New DO + old promotion worker / old edge / old CLI | Requests unchanged; same responses; violations logged | yes |
| Old DO (pre-PR-S, m14) + any client | No logging; nothing reads the rows | yes |
| New DO rolled back to old DO | `governance_events` rows stay, ignored (rollback floor, `docs/OPS.md` m14 section) | yes |
| Old DO on m13 | impossible for this build: PR-S needs m14 tables, and this build already carries the m14 migration (PR-A); a missing table would only make the INSERT throw, which is caught (section 4.1) | yes (fails open by design: log-only) |
| Strict zod clients | No new response field, no new request field | yes |

Fail-closed note (AGENTS-REVIEWER section 2): the rule here is intentionally fail-open because it is log-only bookkeeping; Rev 5 B1 already says stage-write refusals are not a protection. The protection points (`candidateExposure`, PR-G; the approval hook, PR-D) are separate.

## 7. Rollback floor

No schema change, no migration step, no new table or column, no `schema_version` bump. Reverting PR-S is a plain code revert; rows already written stay valid m14 data. Rollback stays a ref operation (rule 7): `rolled_back` writes are never refused, in log-only or later.

---

## 8. Tests

New `workers/spec-do/tests/governance-state-machine.test.ts` (pure, `vitest.config.ts` includes `workers/**/tests/**`):
- Table-driven over all 8x8 candidate pairs x 3 sources: expected `null` or the exact `rule`, from one expected-matrix literal written from table (c) (independent of `ALLOWED`, so a typo in either is caught).
- Same-state is `null` for every stage and source; unknown strings give `unknown_stage` and do not throw; `entersPromoted` true only for `x -> promoted`, `x != promoted`.
- Promotion status: 6x6 matrix plus `null -> each`; `cancelled` terminal; `failed -> pending` and `failed -> in_progress` allowed.
- Constants test: `CANDIDATE_STAGES` equals `CandidateStageSchema.options` (`shared/schemas.ts:164`) and the CHECK list parsed from `schema.sql`, so the enum cannot drift.

New `workers/spec-do/tests/governance-transitions.test.ts` (real SQL through the real router, `sqlite-state.ts` like `near-misses.test.ts`):
- `PATCH /api/candidates/:id/stage` `pending -> passed_train`: 200, row updated, one history row, **exactly one** `governance_events` row with the shape of section 5 (`actor_id` NULL, `asserted_actor_id` = header, detail without `notes`, detail under the cap).
- Valid ladder `pending -> passed_premerge -> passed_shadow -> passed_train -> passed_canary -> promoted -> rolled_back`, then re-execute `rolled_back -> passed_premerge` via W4 with a mocked sandbox: **zero** events.
- Same-state writes (`passed_shadow` twice): zero events.
- Dedupe: the same invalid edge twice within the window -> one row; after advancing the clock past the window -> two rows (fake timers on `Date.now` only, no async waits needed). Cap: 101 distinct subjects -> 100 rows, 101 `console.warn` calls.
- Failure isolation: drop `governance_events` in the test DB (or make the INSERT throw); the PATCH still answers 200, the stage and history are written, `console.error` is called once.
- Unknown id: response 404 and history row exactly as before PR-S, no event. Unknown stage value: still 500, no history row, no event.
- Execute: success from `promoted` writes `passed_premerge` and one `promoted_exit` event; error from `promoted` writes `failed` and one event (characterization of today's behavior, which enforce will change).
- Promotion states: worker flow `pending -> in_progress -> completed`, retry `failed -> pending`, cancel: zero events; `POST` with `status: 'failed'`: one `initial_not_pending` event and 201; `completed -> in_progress` patch: one `terminal` event and 200.
- Transaction: a stage write and its event commit together (`transactions.count` increments once per write).

Real-flow characterization (the measurement baseline), in `workers/promotion-worker/tests/promotion.test.ts` (real ledger harness, `:619-640`): the tournament winner write produces exactly one `skip_ahead` event (`pending -> passed_train`); merge-train rollback of a `pending` candidate produces one `rollback_before_train` event. These assert today's known violations so the enforce PR has to change them deliberately.

Existing suites must stay green unchanged (`promotion-ledger.test.ts`, `ledger-cas.test.ts`, `near-misses.test.ts`, `tests/unit/promotion-candidate-routes.test.ts`). Mutation checks for the reviewer: flip one `ALLOWED` entry, drop the dedupe `SELECT`, move the event INSERT outside the `try`: each must fail a test.

---

## 9. Measurement plan for switching to enforce (switching is out of scope)

- Query (dashboard SQL editor, documented in OPS): `SELECT reason, json_extract(detail,'$.rule') AS rule, json_extract(detail,'$.source') AS source, COUNT(*) FROM governance_events WHERE event='invalid_transition' AND created_at >= ? GROUP BY 1,2,3 ORDER BY 4 DESC;` plus the `console.warn` count from Workers logs for the uncapped rate. No read route in PR-S (**review ask R5**: add an admin-scope `GET /api/governance-events?event=` now, or with PR-D).
- Exclude e2e: rows whose `subject` candidate no longer exists (purged `test-org-e2e-*` data) or whose `asserted_actor_id` is an e2e actor.
- Expected non-zero baseline from today's flows (section 1.4): `skip_ahead` (tournament), `promote_not_from_canary` (tournament to `full` from a lower stage), `rollback_before_train` (merge train). Before enforce: the promotion worker must advance one stage per rung (or the DO must accept a recorded skip policy), merge-train success must write `passed_train`, and execute must refuse before running the sandbox when the candidate is `promoted`.
- Enforce criteria (proposal): 14 consecutive days with zero non-e2e rows for the edges to be enforced; enforce `promote_not_from_canary` and `promoted_exit` first (they are what the PR-D hook relies on), the rest later or never. Enforce returns 409 `{code:'invalid_transition', rule}`; the promotion worker already throws on `!ok` (`promotion-worker/spec-do.ts:110-112`) and records the tournament failed, so enforce is mixed-version safe in that direction.

## 10. Docs to update in the PR

- `docs/GOVERNANCE-STATE-MACHINES.md`: "What is enforced today" rows for candidate stage and promotion-state status ("log-only since PR-S"), fresh line numbers, drop the stale `cancelled` parenthetical in (d), record the R2 interpretations under (c).
- `docs/M5A-2-GOVERNANCE-PLAN.md`: PR-S status line; note that (a), (b), (e) helpers land with PR-D/PR-F/PR-G.
- `docs/OPS.md` m14/governance section: what an `invalid_transition` row means, the section 9 query, window and cap, "rows are expected from tournament and merge-train flows today".
- `docs/OPEN-QUESTIONS.md`: only if the implementation finds undocumented DO SQLite behavior (statement-level rollback inside `transactionSync`, nesting).
- `workers/api/principal.ts:255-260` comment: unchanged in PR-S (the guard is still log-only, so candidate stage stays off user routes).

## 11. Risks

1. **Noise hides signal.** Normal flows violate (section 1.4); the cap could be reached by e2e runs and drop a real violation from the table. Mitigation: `console.warn` on every violation; dedupe by key; R4.
2. **Wrapping W3/W4/W5 in `transactionSync`** is a behavior change in failure cases only: a throw in `recordHistory` now rolls back the stage UPDATE (today the stage would stay updated with no history). This is the intended direction (Rev 3 "Transaction scope", risk 3) but needs a test.
3. **Read-before-write on W3** adds one indexed SELECT per stage PATCH; negligible.
4. **Unbounded `governance_events` growth** if the cap is raised later; the table is never purged by design.
5. **`entity_history` can disagree with `candidates.stage`** via `POST /api/entities/:type/:id/history`; unchanged, out of scope.
6. **Table (c) ambiguities** (R2) could make the measurement count edges the maintainer considers legal; the rules are data and cheap to change while log-only.

## 12. Review asks

- R1: (d) in `ledger-state-machine.ts` vs the governance module.
- R2: the four table (c) interpretations in section 3.1.
- R3: `actor_id` NULL, asserted id in `asserted_actor_id`.
- R4: window 1 h, cap 100 per window; exempt `invalid_transition` from "never purged"?
- R5: read route now or with PR-D.
- R6: deferring (a), (b), (e) entirely (no pure helpers) under the reachability rule.
- General: verify section 1.1 is the complete writer inventory (`grep -rn "candidates SET\|INTO candidates\|promotion_states SET\|INTO promotion_states" workers`).

---

## Review 1 dispositions (2026-11-01; approve with changes, no blockers; supersede conflicting text above)

Maintainer-default decisions:
- **R1 accepted:** (d) lives in `ledger-state-machine.ts` beside the tournament machine.
- **R2 accepted:** all four readings, with S2 and N1 below.
- **R3 accepted:** `actor_id` NULL, the asserted id in `asserted_actor_id`.
- **R4:** 1 h window and 100-row cap kept (with S3); `invalid_transition` rows are **not** exempt from "never purged".
- **R5:** read route deferred to PR-D.
- **R6 accepted:** (a), (b), (e) deferred entirely.

Findings applied:
- **S1, the check runs inside the try.** Signature `logTransitionViolation(check: () => GovernanceViolation | null, subject, assertedActorId, extra)`. The prior-stage `SELECT` is done inside the same try; if it fails, prev is null and nothing is logged. Test: an injected throwing check leaves the PATCH at 200 with stage and history written.
- **S2, `enforceable` per rule.** Each rule in the module's data carries `enforceable: boolean`; false for every edge into `rolled_back` or `failed` (rule 7: rollback and failure are never refused) and for same-state writes (which are never violations). `rollback_before_train` is therefore permanently log-only, and so is `promoted -> failed` (rule `promoted_exit` with `to = failed`): `enforceable` is computed per (rule, to), see `isEnforceable`. The fix for an execute on a `promoted` candidate is an **execute pre-check** (refuse before calling the sandbox) in a later PR, not a stage refusal. Stated in `docs/GOVERNANCE-STATE-MACHINES.md` (c).
- **S3, e2e exclusion and the cap marker.** `detail.orgName` carries the validated organization name (namespace) of the candidate's spec; measurement excludes `orgName LIKE 'test-org-e2e-%'` (`asserted_actor_id` is `promotion-worker` for ledger writes, and "candidate no longer exists" also matches purged real candidates). `suppressedSince` is dropped; the row that reaches the cap carries `detail.capReached: true`. The enforce criterion requires no window with a `capReached` row in the 14 days, and a cross-check of row counts against the `console.warn` count.
- **S4, statement-level rollback is qualified.** It holds for constraint and schema errors (including `RAISE(ABORT)`); `SQLITE_FULL`, `SQLITE_NOMEM` and `SQLITE_IOERR` may roll back the whole transaction, and then the write fails exactly as any storage failure does today. Test: `CREATE TRIGGER ... BEFORE INSERT ON governance_events BEGIN SELECT RAISE(ABORT,'x'); END` -> 200, stage and history committed, one `console.error`.
- **S5:** `docs/MILESTONES.md` (M5a-2) names the promotion-worker prerequisites as blocking for the enforce PR and for PR-D's "`promoted` only from `passed_canary`" assumption: one stage per rung (tournament), merge-train success writes `passed_train`, execute refuses on `promoted`.
- **S6 tests added:** a throw in `recordHistory` rolls back the stage UPDATE; a tombstoned candidate writes no event (log only for a live row); `failed -> passed_premerge` via PATCH gives `reset_needs_execute`, via execute zero events; promotion-state PATCH changing only non-status fields, PATCH on an unknown id (404) and duplicate create (409) write no event; time is faked with `vi.useFakeTimers({ toFake: ['Date'] })` / `vi.setSystemTime` only.
- **N1:** catch-all rule `not_allowed`, so every cell of the 8x8 matrix has a defined value.
- **N2:** `entersPromoted` dropped (unused in PR-S; PR-D adds what it needs).
- **N3:** `unknown_stage` is for the enforce PR, which must check before the UPDATE; in PR-S an unknown `to` fails the CHECK and nothing is logged.
- **N4:** `GovernanceViolation` is a superset of `TransitionViolation` (`{code, message}` plus `machine, rule, from, to, enforceable`). For promotion-state PATCH the asserted actor is `current.actorId` (the PATCH carries no header).
- **N5 applied:** dedupe and cap in one query (`SELECT COUNT(*), SUM(subject = ? AND reason = ?)` over the window).
