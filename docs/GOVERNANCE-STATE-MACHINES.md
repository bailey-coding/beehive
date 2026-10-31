---
category: design
status: draft
milestone: m5a-2
audience: human,agent
tags:
  - spine-work
  - state-machine
---

# Governance and promotion state machines

**Date:** 2026-10-31 | Companion to `docs/M5A-2-GOVERNANCE-PLAN.md` (rev 3). Source: independent review 2 of that plan, checked against code. The target is one pure module, `workers/shared/governance-state-machine.ts`, in the style of `workers/shared/ledger-state-machine.ts` (pure functions, shared by the Spec DO and its clients, enforced in the same transaction as the write). Same-state writes are always allowed (idempotent). Nothing here is implemented yet.

## What is enforced today (checked 2026-10-31)

| Object | Transition table enforced? | Evidence |
|---|---|---|
| Tournament `status` | **Yes**, with an attempts cap and version CAS | `workers/shared/ledger-state-machine.ts` (`ALLOWED`, `checkTournamentTransition`), applied in the DO write transaction (`index.ts:3002`) |
| Merge train `status`, car statuses | No: zod enum only, version CAS | `applyMergeTrainWrite`, `index.ts:3083` |
| `promotion_states.status` | No: zod enum only | `PromotionStateSchema` (`promotion-ledger.ts:32`); `patchPromotionState` merges any patch |
| Candidate `stage` | No: CHECK enum only | `transitionCandidate`, `index.ts:1559`; also written by sandbox execute (`:5440-5460`) and the promotion worker |
| Spec `stage`, issue `stage`, trial `stage` | No: CHECK enum only; `decideTrial` checks neither participant nor undecided | `index.ts:1486, 1941, 1781` |
| Issue `status` | two values, idempotent | `setIssueStatus`, `:5287` |
| `canary_deployments.status` | derived from the deploy-ref head inside the move transaction | `syncCanaryStatuses`, `:3562` |
| `deploy_refs` | append-only chain, unique `prev_ref_id` | `schema.sql:~451-460` |

Only tournaments have a table. The governance hook makes candidate `stage` load-bearing, so table (c) below is new enforcement.

## (a) Approvals, per (subject, rung, commit sha)

`E` is the set of **eligible approvers** at check time (computed, not stored): `type = 'human'`, `role = 'maintainer'`, non-empty `github_user_id`, not a service actor, **and** a `user_tokens` row with `created_via = 'session'` (GitHub OAuth login) for that actor; the request's token must be one of those. Master-minted (`created_via = 'admin'`) tokens never count. An approver's **effective decision** on a sha is their latest row by rowid; redelivery is deduplicated by the Idempotency-Key, not by a unique key on `decision`.

Per-approver lane:

| State | Event | Guard | Next |
|---|---|---|---|
| none | approve | approver in E; sha non-empty and equals the candidate head | approved |
| none | reject | approver in E; sha equals head | rejected |
| approved | reject | same approver | rejected |
| rejected | approve | same approver (clears their own veto) | approved |
| approved / rejected | same decision again | repeat of an idempotency key | unchanged (no new row) |
| any | candidate head sha changes | new commit | approve rows go stale (do not count); standing rejects persist (see veto rules) |
| any | approver leaves E | role removed, deactivated, session token revoked | row ignored, never deleted |

Aggregate verdict for (candidate, `full`, head sha):

| State | Event | Guard | Next |
|---|---|---|---|
| UNAPPROVED | approve | | PARTIAL (1 distinct approver) |
| PARTIAL | approve | a different approver | SATISFIED (>= 2) |
| PARTIAL / SATISFIED | standing reject | critical type, `enforced`, rejecter still in E, within `governance.veto_ttl_days` (default 14) | VETOED |
| VETOED | rejecter approves or withdraws; or TTL lapses (becomes recorded dissent); or break-glass | | recomputed from counts |
| SATISFIED | head sha changes | | UNAPPROVED (rejects follow the candidate across shas until withdrawn or lapsed) |
| any | promotion check | `enforced`, critical (or unclassified), verdict is not SATISFIED | refuse: 409 `approval_required` `{need, have}` |
| any | promotion check | `bootstrap` | allow; write `approval_missing` iff effective approvals < min(2, \|E\|) |

`self_approval = 1` iff exactly one eligible human maintainer exists at insert time (computed in the transaction); it is bootstrap-only, and the prose marker is `two_person: bootstrap_single_maintainer`. Approvals are accepted for non-critical candidates in `bootstrap` (the `enforced` precondition needs the history), but only if the candidate exists and the sha equals its head.

**Role and policy changes** use the same lanes with `subject_type` in {`role_change`, `policy_change`} and `subject_id` = sha256 of the canonical request body. SATISFIED means at least 2 distinct eligible approvers hold a row for that hash created within 7 days; no proposal table is needed.

## (b) Governance policy mode

| State | Event | Guard | Next |
|---|---|---|---|
| bootstrap | enable_enforced | actor in E; deploy var `GOVERNANCE_MASTER_STAGE2` set (human deploy only, not a runtime setting); PR-F build present; a changed-file source for classification exists; at least 2 **other** members of E, each with an `approval_recorded` event inside `governance.approval_window_days`; **2 distinct approvals on the enable proposal** (the setter counts as one) | enforced |
| bootstrap | enable_enforced | any guard fails | bootstrap; 409 naming the failed guard |
| enforced | relax (to bootstrap) | quorum of 2 distinct members of E, or break-glass with a mandatory reason | bootstrap |
| enforced | break_glass | master principal, non-empty reason | `governance_events` row and alert; mode unchanged unless the call is a relax |
| enforced | active maintainers drop | none (no automatic fallback) | enforced; critical changes blocked until a new eligible maintainer or break-glass |
| enforced | shrink `critical_types`, raise `approval_window_days`, lower `veto_ttl_days` | quorum (loosening) | enforced |
| enforced | grow `critical_types` | one maintainer (tightening) | enforced |
| bootstrap | change non-mode keys | one maintainer; key whitelist only | bootstrap |
| any | DO started with `schema_version >= m14` but a hook version below PR-D | rollback below the hook build | write a `governance_events` row (`hook_rollback`); documented in OPS as a governance event |

Every transition writes one `governance_events` row; same-state writes are no-ops. "Active" means the actor is in E and has an `approval_recorded` event in `governance_events` (never purged) inside the window; token liveness and commits are not used.

## (c) Candidate stage (becomes load-bearing at `promoted`)

Roll out in two steps: first **log-only** (`invalid_transition` rows in `governance_events`, no refusal), because old workers share the deploy window and e2e and seed tests write arbitrary stages; then enforce. Target table:

| From | Event | Guard | To |
|---|---|---|---|
| pending | pre-merge pass (sandbox execute or gate) | | passed_premerge |
| pending | execute error | | failed |
| passed_premerge | shadow pass | | passed_shadow |
| passed_shadow | train pass | | passed_train |
| passed_train | canary pass | | passed_canary |
| passed_premerge .. passed_canary | skip ahead | only if the request's toRung is the immediate next rung or the recorded policy allows the skip; else 409 | (forward only) |
| passed_canary | promote | `assertPromotionApprovals` (the hook) | promoted |
| any non-terminal | rung failure | | failed |
| passed_train, passed_canary, promoted | rollback (SLO, train drop) | never gated (rule 7) | rolled_back |
| failed, rolled_back | re-execute with a new commit | resets sha; approvals go stale by sha mismatch | passed_premerge |
| promoted | re-execute | refuse 409, or demote via rollback first | |
| promoted | anything else | | rejected |
| rolled_back, failed | promote directly | | rejected (must re-pass the rungs) |

`promoted` is reachable only from `passed_canary`, and the only exits from `promoted` are `rolled_back` and same-state. That is the part the hook needs; the other edges ship log-only first. The hook is gated only on **entering** `promoted` (or completing at `full`); rollback, `failed`, `rolled_back` and same-state writes are never gated.

## (d) Promotion-state status (hook sites 3 and 4)

`pending -> in_progress | cancelled`; `in_progress -> completed | failed | rolled_back | cancelled`; `failed -> in_progress | pending`; `completed`, `rolled_back` and `cancelled` are terminal. Enforce in the same module as the tournament machine. The hook fires only on the transition **into** `completed` with `currentRung = 'full'` and a differing prior row, so a PATCH re-sending `completed` is not re-checked. (The `cancelled` status does not exist in the zod enum today; confirm against `promotion-ledger.ts:32` before adding it.)

## (e) Intent approval and real-data eligibility (untrusted origin; rev 5)

Origin comes from `intent_provenance` (`maintainer`, `known_agent`, `external`, `unknown`; `unknown` and `known_agent` need intent approval like `external`; a row-less entity older than `governance.m14_epoch` is `legacy` = `maintainer`, a row-less newer one is `unknown`). The derived state is named **`intent_status`** (`needs_approval` | `approved`); it is **not** `specs.stage`, which is unvalidated and user-writable, and nothing gates on `specs.stage`. Approver eligibility E is as in (a) (non-revoked, unexpired session-created token or a UI session through the signed envelope). The approved hash is computed by the DO from `name`, `description`, `contract` and `declared_delta_surface`.

| intent_status | Event | Guard | Next |
|---|---|---|---|
| needs_approval (origin not `maintainer`) | approve spec | approver in E; `approver_eligible` snapshotted at insert; hash = current DO-computed hash | approved |
| needs_approval | create candidate or claim | | refuse 409 `spec_not_approved` (no contract or token in the body) |
| approved | spec content changes (no such route today; any future one must reset) | hash differs from the approved hash | needs_approval; existing candidates become ineligible |
| approved | withdraw or reject | any current member of E | needs_approval |
| (origin `maintainer`) | create candidate | | allowed; candidate eligible |

Candidate real-data eligibility (computed in `candidateExposure(candidateId, specIdFromRequest, commitSha)`, not stored): `eligible = candidate row exists AND request spec id == candidate.spec_id AND (spec.origin == maintainer OR intent_status == approved) AND a pre-merge pass exists at the deployed sha AND (approval for the required rung exists per the requirements table, when the type needs it)`. Enforced, in `bootstrap` and `enforced` alike, at: `deployCanary` (refuse 409), `rollbackHead` (an ineligible `prev` is replaced by the empty ref), `liveRefs` (ineligible entries are omitted unless `includeIneligible=1`). An ineligible candidate may run only in the build and test sandboxes and in preview with no real traffic. Consumers of `GET /api/candidates/:id/exposure` treat any non-2xx as ineligible.

Requirements by origin and type (rung = `canary` is the first real-data rung, because the router's only targets are live canary refs):

| Origin / type | Spec intent approval | Candidate approval at `canary` | Candidate approval at `full` |
|---|---|---|---|
| `maintainer`, non-critical | none | none | none |
| `maintainer`, critical (security-sensitive, dependency-change, infra, schema-migration) | none | none | required (2 in `enforced`) |
| `maintainer`, `oracle-change` | none | required | required |
| non-`maintainer`, non-critical | required | none | none |
| non-`maintainer`, critical or `oracle-change` | required | required | required |

## Not covered here (follow-ups)

Merge train, trial, spec and issue stage machines have no table and are out of M5a-2; `decideTrial` gets only the participant and already-decided guards. Add them to this module when they become load-bearing.
