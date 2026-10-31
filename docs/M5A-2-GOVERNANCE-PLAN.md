---
category: planning
status: revised-after-review-1
milestone: m5a-2
audience: human,agent
tags:
  - spine-work
  - plan
---

# M5a-2 plan, part 2: governance schema, near-misses, change types, two-person rule

**Date:** 2026-10-31 (rev 2) | **Tier:** heavy | **Spine:** yes (Spec DO schema, promotion step): this plan needs an independent re-review of the changed sections before code, and each PR needs an independent implementation review before merge (AGENTS.md rule 2). | **Sources:** `docs/MILESTONES.md` M5a-2, `docs/M5A-AUDIT.md`, `docs/decisions/0005-org-memory.md`, `docs/M5-PLAN.md` sections A, C, D.

**Review history.** Rev 1 was reviewed by an independent agent on 2026-10-31: approve with changes, 4 blockers (B1-B4), 6 should-fixes (S1-S6), 3 nits (N1-N3). Every item is folded in below and tagged. Two resolutions change what the maintainer accepted in rev 1 and are marked **[decision needed]**.

Part 1 (`docs/M5A-2-IMPL-PLAN.md`) is merged. This part ships **additive** (new tables, no `ALTER` on existing ones) behind a policy row that starts in **bootstrap mode**, so tightening governance later is a policy change, not a migration (M5-PLAN section D).

## Facts this plan rests on (checked against code by the reviewer, 2026-10-31)

- Latest schema is `m13` (`workers/spec-do/index.ts:33`, `gate_runs`); the next step is `m14`. `runMigrations()` is at `:1100-1170`; an older build tolerates a newer stored `m<N>` (rollback floor, `:1148`, `docs/OPS.md` "Rollback floor"). Rollback-floor rule: new tables may reference **only `actors`**, never candidates/specs/issues/organizations/repositories (logical references otherwise) (S4).
- **How a new schema section is wired (correction):** a fresh ledger execs each section separately in `initSchema` (`:663-679`, e.g. `GATE_RUNS_SQL`), and `workers/spec-do/tests/schema-sync.test.ts:35` asserts `schema.sql === SCHEMA_SQL + ... + GATE_RUNS_SQL`. So m14 needs: (a) `GOVERNANCE_SQL` appended to that concatenation in `schema.sql` and `schema-inline.ts`, (b) a `this.db.exec(GOVERNANCE_SQL)` line in the fresh branch, (c) the `['m14', ...]` step, (d) a structural test like the m13 one (`schema-sync.test.ts:55`: no DROP/ALTER, `REFERENCES` only `actors`), (e) a migration test in the style of `migration-gate-runs.test.ts` (there is no m12/m13 legacy fixture; the latest is m11), and (f) updates to `migration-matrix.test.ts`, `migrations.test.ts:19` (strip list), `service-tokens.test.ts:403` (section-order comment) and the OPS m14 deploy check (S4).
- `actors` has `type`, `trust_score` (default 50), `promotion_authority`, `role` (`maintainer`|NULL). `isMaintainer` checks only `actors.role` for the asserted id (`index.ts:2368`). **Master has scopes `read`,`write` only, no `maintainer` scope** (`workers/api/principal.ts:157-163`), may assert any `X-Actor-ID` (stage 1 only logs it, OPS 385-406), and the master token is held by all ten workers (OPS 77). `POST /api/actors` is master-only and takes any name (`index.ts:1360`); `setActorRole` (`:2662`) does not check `type`; `PATCH /api/actors/:id/trust` is master-only and unvalidated (`:3902`). **So today anyone with the master token can create a "human", make them a maintainer and approve as them** (B1).
- **Every path that writes `promoted`/`full` (B2 inventory):**

| # | Path | Location | Hook |
|---|---|---|---|
| 1 | `transitionCandidate`, the only writer of arbitrary candidate stage. Edge `PATCH /api/candidates/:id/stage` is master-only (`api/index.ts:227, 1755`); the DO route is `index.ts:4082-4085` with an unvalidated body stage; no transaction today | `index.ts:1559-1568` | inside the function |
| 2 | Tournament winner: `setCandidateStage(.., CANDIDATE_STAGE_FOR_RUNG[toRung])` ('promoted' only for 'full') | `promotion-worker/tournament.ts:499-503`, `spec-do.ts:73-112` | via path 1 |
| 3 | Promotion-state completion at 'full' (`markAsCompleted`) | `promotion.ts:97`, `state.ts:92` | not via path 1 |
| 4 | Generic ledger routes (no actor, before `X-Actor-ID` extraction): `POST /promotion-states`, `PATCH /promotion-states/:id` | `index.ts:2772-2787, 2875-2915` | hook `createPromotionState` and `patchPromotionState` (already in `transactionSync`) |
| 5 | Merge-train mode never sets 'promoted' (only 'rolled_back', `merge-train.ts:470`) | | only 3/4 gate it |
| 6 | Deploy-ref 'full' rung (`DeployRungSchema = ['canary','full']`, `deploy-refs.ts:25`); only `deployCanary` moves a ref today (`index.ts:3308`) | `index.ts:3498+` | in the allowlist; any future full-rung move must call the hook |
| 7 | `POST /api/promotions` inserts a `pending` row only; `promotions.stage='active'` is never set | `index.ts:4219, 1958` | no gate needed |
| 8 | `executeCandidateInSandbox` sets only `passed_premerge`/`failed` | `index.ts:5440, 5458` | n/a |
| 9 | `seed.ts` (local dev) | | allowlisted |

- **The hook gates the ledger record and the `full` deploy-ref move, not external side effects.** In both promotion modes the canary and preview deploys happen before the ledger records `full`; a refused write fails the tournament cleanly (recorded failed, retryable) but does not undo a deploy. State this wherever the rule is described (B2).
- The promotion worker's stage PATCH uses the literal actor `'promotion-worker'` (not an `actors` row, `spec-do.ts:81,107`), ledger routes carry no actor, and `/promote` takes `actorId` from the unverified request body (`promotion-worker/index.ts:67-69`). **There is no trustworthy "promoting actor"** (B2).
- Existing writers `transitionCandidate` (`:1559`) and `decideTrial` (`:1781`) run bare statements plus `recordHistory` without `transactionSync`; their handlers `await request.json()` before the sync block. `rollbackHead` (`:3530-3552`) and `upsertGateVerdictSummary` (`:4793`) run inside their caller's transaction. `decideTrial` does not check that `winnerId` is a trial participant or that the trial is undecided (S3).
- `entity_history.entity_type` has a CHECK (`issue, candidate, spec, trial, promotion, gate_verdict, service_account`, `schema.sql:11`); widening it needs a table rebuild, which the rollback floor forbids. System events therefore cannot go in `entity_history` (S2).
- The gate worker receives commit shas only: no diff or file list. User tokens live at most 90 days (`MAX_USER_TOKEN_LIFETIME_MS`, `index.ts:~1004`; error text says 90, constant not re-read). The `beehive-system` ops actor is an agent with the maintainer role (`docs/OPS.md:237`).

## Design

### Migration `m14` (`GOVERNANCE_SQL`, one section, new tables only, `REFERENCES actors` at most)

- `change_classifications(id, entity_type CHECK IN ('issue','spec','candidate'), entity_id, change_type CHECK IN (typo-fix, refactor, behavior-change, security-sensitive, dependency-change, infra, unclassified), confidence REAL CHECK 0..1, classifier, inputs_hash, created_at)`; index `(entity_type, entity_id, created_at)`. Append-only; the newest row wins, ties broken by `created_at` then `rowid` (S6).
- `approvals(id, candidate_id, rung, commit_sha, approver_actor_id REFERENCES actors, decision CHECK IN ('approve','reject'), self_approval INTEGER, reason, created_at)`, `UNIQUE(candidate_id, rung, commit_sha, approver_actor_id, decision)`. `commit_sha` is the candidate head at approval time; the check requires it to equal `candidates.commit_sha` now, so an approval does not survive a new commit (B2). `rung` is `'full'` in this plan; earlier rungs are not approvable (S6). A reject or approval is superseded only by a new append-only row.
- `near_misses(id, spec_id, candidate_id, reason CHECK IN ('trial_loss','gate_fail','train_drop','slo_rollback','tournament_loss'), rung, lost_to_candidate_id, trial_id, source_ref, evidence TEXT /*JSON*/, complexity_delta REAL, created_at)`, `UNIQUE(candidate_id, reason, source_ref)` with `INSERT OR IGNORE`, where `source_ref` is the trial id, verdict run id, tournament/train id or deployment id. A re-delivered write therefore cannot duplicate a row (S3). Indexes on `(spec_id, created_at)` and `(candidate_id)`.
- `governance_events(id, event TEXT /*policy_change, role_change, governance_degraded, break_glass, approval_missing*/, actor_id, asserted_actor_id, subject TEXT, reason TEXT, detail TEXT /*JSON*/, created_at)`, no foreign keys, never purged (like `purge_log`). All system events go here; `entity_history` keeps only per-candidate facts (`approval_missing` on a candidate, type 'candidate') (S2).
- **Dropped from rev 1:** `cost_attributions` and `outcome_links`. Nothing in this plan writes them, so they would violate "every module must be reachable"; adding them later is cheap and additive. The ADR 0005 initiator/executor/reviewer and cost fields move to a later plan (with M5b) (S6).
- Policy lives in the `metadata` table under a **key whitelist** the policy route enforces (so it can never overwrite `schema_version` or the promotion mode): `governance.two_person_mode` (`bootstrap` default | `enforced`), `governance.critical_types` (default `["security-sensitive","dependency-change","infra"]`), `governance.approval_window_days` (default 365) (S4).

### Near-miss hooks (each inside a `transactionSync` with the write that records the loss) (S3)

- `decideTrial`: wrap check, trial write, history and near-miss in `transactionSync`; **validate** that `winnerId` is a participant and the trial is not already decided (409 otherwise); the loser gets a `trial_loss` row.
- Tournament losers ("eliminated") are written by `applyTournamentWrite` (`tournament.ts:508+`), not `decideTrial`: hook there by diffing old vs new `candidates[].status` (`tournament_loss`). `applyMergeTrainWrite` likewise for `train_drop` (diff of the candidate list).
- `rollbackHead` (`:3530-3552`, already in the caller's transaction) writes `slo_rollback` for `head.candidateId`.
- Gate `fail`: `upsertGateVerdictSummary` (in the caller's transaction) writes `gate_fail`, deduped on `(candidate_id, 'gate_fail', run id)`. Near-misses are facts at a point in time: a later pass on a re-run does not delete one.
- `GET /api/near-misses?specId=&candidateId=` is a **read-scope** route (N1).

### Change-type classifier

- `workers/shared/change-type.ts`: pure `classifyChange({ paths?, text? }) -> { changeType, confidence, signals }`, rule-based: lockfiles/`package.json` => dependency-change; `wrangler.toml`, `.github/`, `Dockerfile*` => infra; `auth`/`secret`/`token`/`principal` paths => security-sensitive; docs/comments only => typo-fix; tests only => refactor; default behavior-change at low confidence. With no `paths` confidence caps at 0.5 and any security keyword hit selects security-sensitive (fail stricter). Table-driven test per rule.
- `POST /api/classifications` (keyed) stores a result; `GET /api/classifications?entityType=&entityId=` returns the newest. The DO validates shape (strict zod) and never classifies itself.
- **Which classification the rule reads for a candidate promotion (S6):** the candidate's own newest row, else its spec's, else the linked issue's, else `unclassified`. Callers in this plan: issue creation (text only) and the gate worker after a pre-merge verdict (best effort: a 404/5xx from an old DO is logged and the gate continues). A changed-file source for the gate is step 0 item 2.
- `unclassified` is critical in `enforced`, non-critical in `bootstrap`; the check reads at promotion time, so flipping the mode changes how old candidates are treated (N2).

### Two-person rule

**Who may approve (B1).** All of the following, checked by the DO:
- `actors.type = 'human'`, `role = 'maintainer'`, a **non-empty `github_user_id`**, not a service actor, and the principal not in `capped` (non-maintainer-scope) mode;
- the approver id comes from the **user-token-derived `X-Actor-ID`**, never from the request body;
- `POST /api/approvals`, the policy route and the role-change route are **DO tier-2 admin routes** (added to `ADMIN_PATTERNS`, `workers/shared/spec-do-auth.ts:~95`; without this any worker holding the tier-1 token could call them) and the **edge refuses `principal.kind === 'master'` on them**, allowing only `kind = 'user'` with the maintainer scope. "Edge scope maintainer" therefore means a user token, not master.
- **`enforced` mode must not be enabled until OPS "master stage 2"** (master can no longer act as a human) **and PR-F** (below) have landed; the policy route rejects `enforced` until both are recorded as done. Otherwise `enforced` is theatre: a master-token holder can mint two sock-puppet humans with GitHub ids.

**How many (B3) [decision needed].** Rev 1 required two distinct humans, neither the initiator nor the promoter, which makes a three-person rule (with exactly 3 maintainers, one absent maintainer blocks any critical change) and contradicts M5-PLAN (:60, :156, :170-171: two distinct maintainers, no initiator exclusion; a founder may provide both in bootstrap). Rev 2: **two approvals from two distinct humans; the initiator may be one of them.** In `bootstrap` with one maintainer the founder provides the approval and the row is `self_approval = 1`; the unique constraint allows one row per (candidate, rung, commit, approver), so "both approvals by the founder" is recorded as one self-approved row plus a `governance_events`/history marker `two_person: bootstrap, self-approved`, not two rows. `self_approval = 1` means: approver equals the candidate's creating/promoting human, or only one eligible human maintainer exists. A stricter separation of duties (approver may not be the initiator) is a later policy flag, only sensible with five or more maintainers.

**Reject is a veto for critical types (S1).** A standing `reject` (not superseded by the rejecting maintainer's own later row) blocks promotion of a critical change in `enforced` mode; only that maintainer or break-glass can clear it. In `bootstrap` it is recorded and does not block.

**When approval is needed.** The latest classification is in `governance.critical_types`, or `unclassified` in `enforced`. The rev 1 "low trust (< 90) needs two approvals" trigger is **dropped until M5b** (B2, N3): there is no trustworthy promoting actor (see Facts), every actor sits at trust 50, and trust is master-writable and unvalidated, so the trigger is vacuous or exploitable today. Decision 3 from rev 1 therefore resolves as "not applicable until trust is calibrated".

**The hook (B2, S3, S5).** One DO method `assertPromotionApprovals(candidateId, rung)` called inside the `transactionSync` of every path in the inventory table (hook sites 1, 3/4 via `createPromotionState`/`patchPromotionState`, and the deploy-ref `full` move; 2 and 5 reach it through 1 and 3/4). Check, write, history and near-miss share the transaction, so a throw leaves no partial write.
- **Bootstrap: the hook cannot throw.** It wraps its own reads and writes in try/catch that logs, never fails on a missing actor row (`'promotion-worker'` and ledger calls have none), and never blocks. A missing approval proceeds and writes `approval_missing` (candidate history).
- **Enforced:** a missing approval, or a stale one (`commit_sha` differs), rejects with 409 `{code: 'approval_required', need, have}` via a new `ApprovalRequiredError` mapped in the main catch (`index.ts:4557-4567`, which today maps only `ConflictError` to a bare message) and in the ledger-route handlers (each maps errors itself, `:2728` style).
- The allowlist test (Risk 1) lists paths 1-9; a new writer of `promoted`/`full` fails the test until it is added and hooked.

### Idempotency and edge

`POST /api/classifications` and `POST /api/approvals` join `IDEMPOTENT_ROUTES` (an exact set, `index.ts:41-46`); the edge adds `idemKey` to the two new handlers (it is per-handler, not a list). Policy and role-change routes are not keyed (they are idempotent by value). A new edge call to `/api/approvals` or `/api/classifications` that gets the old DO's generic 404 must map it to 503 "feature unavailable" (the user-token precedent, `spec-do-auth.ts:~42-50`), never to an empty list.

## Governance continuity: a departing or malicious maintainer [decision needed]

Rev 1's automatic fallback to `bootstrap` below three active maintainers **fails open** and was a bypass (B4): one maintainer going inactive (or letting a 90-day user token lapse, or being deactivated by a master-token holder) dropped the DO to self-approval with nothing detectable. Rev 2 replaces it:

- **No automatic fallback.** If the number of active approvers drops, `enforced` stays on. Non-critical changes keep flowing (they need no approval). **Critical changes need a new eligible maintainer or a break-glass call**; they never fall back to self-approval.
- **`enforced` precondition, verifiable from stored data.** At least **two other** eligible maintainers (human, github-linked, role present) besides the setter, each with an `approvals` row inside `governance.approval_window_days`. "Active" is evaluated inside the same transaction as the check, from stored data only: role present and a recent approval row. Token liveness and "commits" are not used (commits are not in the ledger; token lifetime is 90 days, so a passive lapse would silently deactivate a maintainer).
- **Departure.** Removing a maintainer is a `role_change` that, once `enforced`, needs the same two-approver quorum; so one maintainer cannot demote the others, and one maintainer cannot relax the policy alone (policy changes need the quorum too). Until PR-F ships these are single-maintainer actions, which is why `enforced` is blocked before PR-F (S1).
- **Break-glass.** The master token can set `bootstrap`, grant a maintainer role, or finish a stuck promotion. Each call needs a **mandatory reason** (400 without one) and writes a `break_glass` row to `governance_events` with the master caller's asserted `X-Actor-ID`, the request id and the reason, plus an alert (a log line a Workers Logs alert watches), not just a log. Honest limit: the plan cannot enforce "human-only" on the master token, because every worker holds it; the control is OPS master stage 2 and the reason that the Cloudflare account owner is the root of trust anyway. Residual risks: the account owner can always override; two colluding maintainers can approve; stolen maintainer tokens (mitigation: revocable user tokens and an audit trail). A cooling-off delay on critical approvals is a follow-up.
- **Why this addresses the maintainer's concern.** A departure never silently weakens the rule and never freezes non-critical delivery; a stuck critical change has one explicit, logged recovery path through the account owner; and a single malicious maintainer cannot promote a critical change alone (needs a second human), cannot remove or demote others alone, and cannot relax policy alone, once PR-F lands.

## PR slicing (each gets a plan-conformance review plus an independent code review)

1. **PR-A, schema only.** `GOVERNANCE_SQL`, wiring (a)-(f) from Facts, empty-list `GET` routes, no writers. Exit: `m13 -> m14` idempotent, rollback-floor test, byte-for-byte sync, structural test (new tables reference `actors` at most).
2. **PR-B, near-misses.** Hooks above, `decideTrial` guards, read routes, orphan sweep for the new tables in the next purge pass (the `gate_runs` / `purge-local.test.ts:146` pattern), `ORG_PURGE_ORDER` only if the sweep is not enough. Exit: a re-delivered `decide` writes one near-miss; a mid-transaction throw leaves no near-miss and no stage change.
3. **PR-C, classifier.** Pure function and tests, the two routes (old-DO 404 to 503 at the edge), issue-creation and gate callers (best effort).
4. **PR-D, approvals and the rule in bootstrap mode.** Policy route (whitelisted keys, rejects `enforced`), `approvals` route with the B1 route tiers, the hook at every inventory site, `self_approval` marking, the allowlist test. Exit: see test list.
5. **PR-F, maintainer continuity (hard prerequisite of `enforced`).** Quorum on role and policy changes, the `enforced` precondition check, `break_glass` logging with mandatory reason and alert, reject veto. The policy route keeps rejecting `enforced` until PR-F and OPS master stage 2 are marked done.
6. **PR-E (separate plan, optional).** Keying the remaining ~16 mutation routes.

## Tests the plan commits to (beyond each PR's own)

An agent approver is rejected; a sock-puppet human without a `github_user_id` is rejected; a capped (non-maintainer-scope) user token is rejected; the master principal is rejected at the edge; a stale approval (`commit_sha` mismatch) is rejected in `enforced`; bootstrap with an agent actor performing paths 1, 2 and 3 succeeds and writes the record; a standing reject vetoes a critical change in `enforced`; a redelivered `decide` writes one near-miss; a mid-transaction throw leaves nothing behind; old-DO 404 becomes 503 at the edge; `m14` replay is idempotent; the mixed-version matrix of `docs/AGENTS-REVIEWER.md` section 2 (new DO with old promotion-worker in `enforced`: 409 on the stage PATCH surfaces as a 500 from `/promote`, which fails closed and is documented as retryable).

## Mixed-version window (one push deploys all ten workers)

- DO new, callers old: the tables are unused by old callers; bootstrap never blocks, so old promotion-worker calls keep working.
- Callers new, DO old: new routes answer a generic 404; classification and near-miss readers treat it as "not available yet" (logged), approvals map it to 503; nothing treats it as empty data (AGENTS.md `Response.ok` rule).
- No existing request or response shape gains a field (strict zod); all new data uses new routes and tables.
- Rollback to a pre-m14 DO leaves the tables and ignores them (rollback floor), because they reference `actors` only.

## Risks

1. **Missed promotion path.** Mitigated by the inventory and the allowlist test; the reviewer verifies the list again.
2. **Classifier errors weaken the rule.** Rules fail stricter; `unclassified` is critical in `enforced`; the classifier is advisory, never the authority.
3. **Transaction scope.** Hooks wrap formerly bare writers (`transitionCandidate`, `decideTrial`) in `transactionSync`: a behavior change covered by rollback tests.
4. **Agent-authored governance.** This code governs agents; the code review must test that no agent actor can approve, change policy or change a role.
5. **Master-token gap.** Until OPS master stage 2, `enforced` is not safe; the plan blocks it rather than documenting around it.

## Out of scope

Trust calibration and the full capability model (M5b / M6.2), cost attribution and outcome links (later plan), ML classification, web-search capability (M5 section F), keying the other mutation routes (PR-E), a cooling-off delay on critical approvals.

## Open items for the maintainer

1. **Two approvals, initiator may count (B3).** Confirm, or ask for initiator exclusion once there are five or more maintainers.
2. **No automatic fallback; critical changes need a new maintainer or break-glass (B4).** This trades "never blocks" for "never silently weakens". Confirm, or name a different recovery path.
3. **Reject is a veto for critical types in `enforced`.** Confirm.
4. **`enforced` stays disabled until PR-F and OPS master stage 2.** Confirm.

## Review asks for the second pass

1. Do the B1 route tiers close the sock-puppet hole (DO admin pattern, edge refusing master, github-linked human, id from the token)? Anything still reachable by a tier-1 holder?
2. Is the hook inventory now complete, and is every site's transaction wrapping safe (no behavior regression in `transitionCandidate`/`decideTrial`)?
3. Does the two-approval semantics match M5-PLAN and the bootstrap marker rule unambiguously (one row vs two)?
4. Attack the replacement continuity design: can critical delivery still be frozen or bypassed by one maintainer, including by manipulating "active" or the approval window?
5. Mixed-version and rollback-floor: anything else m14 or the new routes must update?
