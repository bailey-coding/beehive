---
category: planning
status: draft
milestone: m5a-2
audience: human,agent
tags:
  - spine-work
  - plan
---

# M5a-2 plan, part 2: governance schema, near-misses, change types, two-person rule

**Date:** 2026-10-31 | **Tier:** heavy | **Spine:** yes (Spec DO schema, promotion step): this plan needs an independent agent review before any code, and each PR needs an independent implementation review before merge (AGENTS.md rule 2). | **Sources:** `docs/MILESTONES.md` M5a-2, `docs/M5A-AUDIT.md`, `docs/decisions/0005-org-memory.md`, `docs/M5-PLAN.md` sections A, C, D.

Part 1 (`docs/M5A-2-IMPL-PLAN.md`: edge key, queue retry, gate dedupe) is merged. This part builds the rest of M5a-2. Everything ships **additive** (new tables, no `ALTER` on hot tables), behind a policy row that starts in **bootstrap mode**, so tightening governance later is a policy change, not a migration (M5-PLAN section D).

## Facts this plan rests on (checked 2026-10-31) and facts still to verify

Checked:
- Latest schema is `m13` (`workers/spec-do/index.ts:33`, `gate_runs`); the next step is `m14`. Migrations are listed in `runMigrations()` (`:1100-1137`); each new SQL section needs an entry in `schema.sql`, `schema-inline.ts` (byte-for-byte, `tests/schema-sync.test.ts`) and a legacy fixture under `tests/fixtures/legacy/`. A newer stored `m<N>` is tolerated by older code (rollback floor, `docs/OPS.md`), so additive tables are safe to roll back over.
- `actors` has `type` (`human`|`agent`), `trust_score` (default 50), `promotion_authority` (boolean) and `role` (`maintainer`|NULL, m5). `promotionAuthority` on the principal is "not enforced yet" (`workers/shared/principal.ts:36`). Trust scores are never calibrated, so every actor sits at the default.
- Candidate stage reaches `promoted` through `PATCH /api/candidates/:id/stage`, which the promotion worker calls with `promoted` when a rung is `full` (`workers/promotion-worker/spec-do.ts:72-96`; DO writes at `workers/spec-do/index.ts:1563` and `:5458`). `POST /api/promotions` only inserts a `pending` row (`:1958`); it does not gate anything.
- Trials are decided by `decideTrial` (`:1781`, route `POST /api/trials/:id/decide`, `:4205`). Promotion rollback rewrites `promotions.stage` and `canary_deployments` (`:3543-3552`). Gate verdicts are unique per `(candidate_id, gate)`.
- The gate worker receives commit shas only; it has **no diff or file list** (`grep` of `workers/gate-workflow/index.ts`).
- The ledger ops actor `beehive-system` is an **agent** with the maintainer role (`docs/FOCUS.md` handoff), so it can hold the role but must not count as an approver.

To verify in step 0 (before code; each result goes in the PR description):
1. Every code path that can set `candidates.stage = 'promoted'` or complete a `promotion_states` row with `target_rung = 'full'` (the DO PATCH, the ledger routes, the merge train, the UI). The enforcement hook must cover all of them.
2. Whether the sandbox runner or Artifacts can supply a changed-file list for a commit (the classifier's strongest input).
3. How the trial loser and a `train` drop are represented today, to place near-miss writes in the same DO transaction.

## Design

### Migration `m14` (one section, `GOVERNANCE_SQL`)

All new tables; no changes to existing ones. Ids are TEXT as elsewhere; timestamps are epoch ms.

- `change_classifications(id, entity_type CHECK IN ('issue','spec','candidate'), entity_id, change_type CHECK IN ('typo-fix','refactor','behavior-change','security-sensitive','dependency-change','infra','unclassified'), confidence REAL CHECK 0..1, classifier TEXT, inputs_hash TEXT, created_at)`; index on `(entity_type, entity_id, created_at)`. Append-only: the newest row wins; history is kept.
- `approvals(id, subject_type CHECK IN ('candidate_promotion'), subject_id, rung TEXT, approver_actor_id, decision CHECK IN ('approve','reject'), self_approval INTEGER, reason TEXT, created_at)`; `UNIQUE(subject_type, subject_id, rung, approver_actor_id, decision)`. One approver can record at most one approval per subject and rung; "two approvals" can therefore never be one actor twice. `self_approval = 1` marks the bootstrap case (see below).
- `cost_attributions(id, entity_type, entity_id, payer CHECK IN ('project','reporter','waiver'), units REAL, unit TEXT, actor_id, created_at)`. Bootstrap writes `payer = 'project'`, `units = NULL`.
- `near_misses(id, spec_id, candidate_id, reason CHECK IN ('trial_loss','gate_fail','train_drop','slo_rollback','tournament_loss'), rung, lost_to_candidate_id, trial_id, evidence TEXT /*JSON: verdict ids, metrics*/, complexity_delta REAL, created_at)`; index on `(spec_id, created_at)` and `(candidate_id)`. Written inside the same DO transaction as the loss, so a near-miss exists iff the loss was committed.
- `outcome_links(id, candidate_id, kind CHECK IN ('promotion','slo_outcome','near_miss','rfo'), ref_type, ref_id, initiator_actor_id, executor_actor_id, reviewer_actor_id, created_at)`. This carries ADR 0005's outcome linking and initiator/executor/reviewer in one place instead of widening `promotions`.
- Policy lives in the existing `metadata` key/value table, not a new table: `governance.two_person_mode` = `bootstrap` (default) | `enforced`, `governance.critical_types` = JSON array (default `["security-sensitive","dependency-change","infra"]`), `governance.low_trust_threshold` = `90`. Changing a policy key is a maintainer-only DO route; it needs no migration.

Fresh ledgers get the tables from the base schema section; migrated ledgers get them from the `m14` step (`CREATE TABLE IF NOT EXISTS`, idempotent). `LATEST_SCHEMA_VERSION = 'm14'`.

### Near-misses (ADR 0005)

Hooks, all inside the existing transaction of the write that records the loss:
- `decideTrial`: the non-winning candidate gets a `trial_loss` row with the comparison metrics and the winner id.
- Gate verdict `fail`, train drop and SLO rollback (`:3543`): a `gate_fail` / `train_drop` / `slo_rollback` row with the verdict or deployment id.
- `GET /api/near-misses?specId=&candidateId=` (read, tier-2) and an `outcome_links` row of kind `near_miss`.
A candidate can accumulate several near-misses over its life; they are facts, not state, so nothing reads them as live state (AGENTS.md rule 4).

### Change-type classifier

- `workers/shared/change-type.ts`: a **pure** rule-based function `classifyChange({ paths?: string[], text?: string }) -> { changeType, confidence, signals }`. Path rules first (lockfiles and `package.json` => dependency-change; `wrangler.toml`, `.github/`, `Dockerfile*` => infra; `auth`, `secret`, `token`, `principal` paths => security-sensitive; only `docs/`/comments => typo-fix; test-only => refactor), then keyword rules on `text`, then `behavior-change` as the default with low confidence. With no `paths` the confidence is capped at 0.5 and security-sensitive is chosen on any keyword hit (fail toward the stricter class).
- `POST /api/classifications` (keyed, tier-2) stores a result; `GET /api/classifications?entityType=&entityId=` returns the newest. The DO never classifies itself: callers send the result, the DO validates the shape (zod, strict) and the author.
- Callers in this plan: issue creation (text only) and the gate worker after a pre-merge verdict (text from the spec title; `paths` once step 0 item 2 finds a source). The gate call is **best effort**: a 404 or 5xx from an older DO is logged and the gate continues (mixed-version rule).
- `unclassified` is stored when nothing runs. Policy treats it as critical in `enforced` mode (fail closed) and as non-critical in `bootstrap`.

### Two-person rule

- **Enforcement point:** one DO method `assertPromotionApprovals(candidateId, rung)` called from every path step 0 item 1 finds, at minimum the candidate stage write to `promoted` and the ledger completion at `full`. It runs in the same transaction as the write, so a concurrent approval change cannot slip between check and write (the Spec DO is the serialization point).
- **Who counts:** an approver must be `actors.type = 'human'` AND `actors.role = 'maintainer'`. Agents, including `beehive-system`, never count (M5-PLAN OCAP principle). Two approvals must come from two different actor ids.
- **When two are needed:** latest classification type is in `governance.critical_types`, or the promoting actor's `trust_score` is below `governance.low_trust_threshold`, or the classification is `unclassified` in `enforced` mode. Otherwise one approval, or none for non-critical changes in `bootstrap`.
- **Bootstrap mode:** the rule is computed and the result is recorded, but a missing second approval does not block. When one human maintainer provides every approval, the rows are written with `self_approval = 1` and the promotion proceeds; the history row says `two_person: bootstrap, self-approved`. A missing approval entirely in bootstrap mode also proceeds but is logged and recorded as `approval_missing` in `entity_history`. This keeps the single-maintainer workflow working while recording exactly what enforced mode would have required.
- **Enforced mode:** a missing approval rejects the write with 409 `{code: 'approval_required', need: 2, have: n}`. Switching mode is the maintainer-only policy route, never an agent.
- `POST /api/approvals` (keyed, maintainer-only) records an approval or rejection; `GET /api/approvals?subjectId=` lists them.
- Trust-based 2-approval will fire for **every** promotion today, because all actors sit at trust 50. In bootstrap mode that only produces records; before switching to `enforced`, the trust registry (M5b) or an explicit threshold change must exist. Called out as a decision below.

### Idempotency and edge

The new POST routes (`classifications`, `approvals`) join `IDEMPOTENT_ROUTES` in the Spec DO and the edge `idemKey` list. Edge routes proxy them with the same typed-request wrappers as the other POSTs; the edge scope is `maintainer` for approvals and policy, `write` for classifications.

## PR slicing (each gets plan-conformance review plus an independent code review)

1. **PR-A, schema only.** `GOVERNANCE_SQL`, `m14`, schema-sync, legacy fixture and migration test, `GET` routes returning empty lists, no writers. Exit: migrates `m13 -> m14` idempotently, rollback-floor test, byte-for-byte sync.
2. **PR-B, near-misses.** Hooks in `decideTrial`, gate-fail, train drop and SLO rollback, plus read routes and `outcome_links`. Exit: a lost trial writes exactly one row in the same transaction; a failed write leaves none.
3. **PR-C, classifier.** Pure function with a table-driven test per rule and the fail-stricter cases, the two routes, issue-creation and gate callers (best effort), edge routes. Exit: classification stored for a new issue and a gate run; an old DO (404) does not fail the gate.
4. **PR-D, approvals and the rule in bootstrap mode.** Policy keys, `assertPromotionApprovals` on every path from step 0, approvals routes, `self_approval` marking. Exit: the promotion worker's flow is unchanged in bootstrap mode but records approvals; an agent approver is rejected; two distinct humans satisfy the rule.
5. **PR-E (separate plan, optional).** Keying the remaining ~16 mutation routes.

## Mixed-version window (one push deploys all ten workers)

- DO new, callers old: tables unused by old callers; the old gate/edge never send classifications; the rule in bootstrap mode does not block, so old promotion-worker calls keep working.
- Callers new, DO old: new routes answer 404; classification and near-miss readers must treat 404 as "feature not available yet" and carry on (the AGENTS.md `Response.ok` rule applies: log, do not treat as empty data). Approvals do not matter while `bootstrap` (an old DO has no rule).
- Strict zod schemas reject unknown fields: no existing request or response shape gains a field in this plan. All new data flows through new routes and tables.
- Rollback to a pre-m14 DO leaves the tables in place and ignores them (rollback floor).

## Decisions needed from the maintainer

1. **Subject of an approval.** This plan approves `(candidate, rung)`. Alternative: approve the `promotion_states` row. The candidate form survives retries and a restarted promotion; the row form is closer to the train.
2. **Self-approval in bootstrap.** Plan proceeds and marks it. Say if a single maintainer should instead be blocked from approving their own agent's work even in bootstrap.
3. **Low-trust threshold.** Every actor is at 50, so `< 90` makes every promotion "two-person". Plan keeps it in the policy row and does not flip `enforced` until trust is calibrated (M5b). Say if you want it disabled until then.
4. **Who may flip the policy.** Plan: maintainer user token only, never an agent token or the master token.

## Risks

1. **Missed promotion path.** A route that sets `promoted` without the check would bypass the rule. Mitigation: step 0 inventory, a test that greps the DO for stage writes to `promoted` against an allowlist, and the reviewer verifies the list.
2. **Classifier errors weaken the rule.** A wrong `typo-fix` skips dual approval. Mitigation: rules fail toward the stricter class, low confidence caps, and `enforced` mode treats unclassified as critical. Classifier is advisory input, never the authority.
3. **Transaction scope.** Writing near-misses and approvals inside existing handlers touches load-bearing functions; each hook is a few lines in the same transaction, covered by rollback tests.
4. **Schema growth in a hot DO.** New tables are append-only and indexed; no existing query changes.
5. **Agent-authored governance.** This code governs agents, so the independent review must specifically test that no agent actor can approve or flip policy.

## Out of scope

Trust score calibration and the full capability model (M5b / M6.2), cost billing, ML classification, web-search capability (M5 section F), keying the other mutation routes (PR-E).

## Review asks

1. Is the hook list complete (step 0 will extend it)? Is any candidate-stage write path outside `assertPromotionApprovals`?
2. Is the transactional placement of near-miss writes and the approval check correct for each hook (no await between check and write)?
3. Does bootstrap mode truly never block, including a promotion by the `beehive-system` agent actor?
4. Do any of the new tables or checks break the mixed-version, rollback-floor or strict-zod rules?
5. Is the approver rule (`type = human` and `role = maintainer`, two distinct ids, unique constraint) sufficient against self-approval by an agent that holds a maintainer-role actor?
