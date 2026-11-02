---
category: planning
status: implemented
audience: human,agent
tags:
  - spine-work
  - plan
---

# Plan: retire `POST /api/candidates/:id/execute` (410 Gone)

**Date:** 2026-11-02 | **Tier:** heavy (Spec DO router, governance state-machine inputs) | **Spine:** touches the Spec DO router, so an independent plan review before code and a code review before merge (AGENTS.md rule 2). | **Decision:** maintainer chose option C (retire) on 2026-11-02 over fixing the Spec DO side (A) or both sides (B).

## Why

The route cannot succeed today, and every link is broken independently (`docs/MILESTONES.md` M5a-2 "Candidate execute ... is broken end to end"):
1. The Spec DO's POST to the sandbox runner sends no `Authorization`; the runner's fail-closed `authGate` (`workers/sandbox-runner/index.ts:90`) answers 401, so the candidate lands `failed`.
2. `POST /sandbox/tasks` only stores the task and answers 202 (`sandbox-runner/index.ts:279-311`); nothing runs it or stores a result.
3. The result route answers 404 `{success:false}` while not ready; `pollForResult` stops on any defined `success`, so the first poll is final.
4. A ready result nests `commitSha` under `result`; the Spec DO reads it at the top level.
5. Results live in a per-isolate in-memory `Map` (`sandbox-runner/index.ts:68-69`).
6. `pollForResult` never checks `Response.ok`, and returns a consumed Response that `executeCandidateInSandbox` reads again ("body used").
7. The route fetches a client-supplied `sandboxRunnerUrl` (master-only at the edge for that reason, `workers/api/principal.ts` USER_WRITE_ROUTES comment).

The gate-runs pipeline (`POST /api/candidates/:id/gate/pre-merge`, `/api/gate-runs`, the `TestSandbox` container; `docs/REAL-GATE-IMPL-PLAN.md`) replaces it. Fixing the old path would rebuild a simulated stub the real gate already supersedes.

## Facts (checked 2026-11-02)

- Edge: `workers/api/index.ts:360-362` routes the POST to `handleExecuteCandidate` (`:2040-2055`), which forwards to the Spec DO with a default `sandboxRunnerUrl`. User tokens are refused before it (`principal.ts`, not in `USER_WRITE_ROUTES`), so only master reaches it.
- Spec DO: the route at `workers/spec-do/index.ts:~4700-4740` calls `executeCandidateInSandbox` (`:5701`) and `pollForResult`. Both are used nowhere else.
- CLI: `cli/src/utils/api-client.ts:440-451` defines `executeCandidate`; no CLI command calls it.
- Tests: `workers/api/tests/user-tokens.test.ts:463` and `tests/e2e/user-tokens.test.ts:104` assert user tokens are denied (403) on the route; `workers/spec-do/tests/governance-transitions.test.ts:72` calls `executeCandidateInSandbox` directly (PR-S log-only checks for the two execute stage writes).
- `tests/e2e/m3-features.test.ts:589` is an unrelated "execute the workflow" test name.

## Design

1. **Spec DO:** the route answers **410** `{ success: false, error: 'POST /api/candidates/:id/execute is retired; use POST /api/candidates/:id/gate/pre-merge (gate runs)', code: 'route_retired', timestamp }` without reading the body or touching the candidate. Delete `executeCandidateInSandbox` and `pollForResult` (dead code after this; AGENTS.md reachability), and the PR-S log sites inside them with them.
2. **Edge:** `handleExecuteCandidate` answers the same 410 itself, without calling the Spec DO. The authorization order is unchanged: a user token still gets 403 first (the S9 matrix tests stay as they are); master gets 410.
3. **CLI:** delete the unused `executeCandidate` client method.
4. **Tests:** Spec DO route 410 with the code, candidate stage and history unchanged, no outbound fetch; edge 410 for master with no Spec DO call; user-token 403 unchanged; delete the `executeCandidateInSandbox` tests in `governance-transitions.test.ts` (their writer no longer exists) and keep the PR-S matrix tests (pure). Grep for any other test or fixture that posts to the route.
5. **Docs:** `docs/MILESTONES.md` (mark the broken-execute bullet resolved by retirement; the "execute refuses on promoted" prerequisite is void), `docs/OPS.md` (route retired, 410 body, the replacement), `docs/M5A-2-GOVERNANCE-PLAN.md` inventory row 8 and `docs/GOVERNANCE-STATE-MACHINES.md` (c) source `execute` (no longer a writer), `docs/FEATURE-PARITY.md` if it lists execute.

## Mixed-version window

- New edge, old DO: the edge answers 410 without calling the DO. Same outcome as new/new.
- Old edge, new DO: the old edge forwards; the DO answers 410; the edge passes it through.
- Old edge, old DO: today's broken behavior.
No schema change, so the rollback floor is untouched. A rollback to a pre-retirement build restores the broken route, which is no worse than today.

## Risks

1. An operator script or manual curl still calls the route: it now gets a clear 410 naming the replacement instead of a misleading `failed` candidate. Grep `scripts/` and docs before merging.
2. The sandbox runner's `/sandbox/tasks` routes become unused by the Spec DO. They are left as is (the runner has other routes; retiring them is a separate change).

## Review asks

1. Is 410 with `code: 'route_retired'` the right shape (consistent with other coded errors in the edge and DO)?
2. Is anything else reachable only through `executeCandidateInSandbox` that would become dead (helpers, types, constants)?
3. Any caller missed (scripts, UI, docs, e2e, the promotion worker)?

## Review 1 dispositions (independent plan review, 2026-11-02: approve with changes, no blockers)

1. Dead code after retirement (should-fix): fixed. The `commitSha` parameter of `logCandidateTransition` (only execute passed it) is removed. The `CandidateWriteSource` members `execute_pass` / `execute_error` and `EXECUTE_ONLY` are **kept** with a comment: no producer since retirement, kept so existing `governance_events` rows with those sources still parse, removed with the enforce PR. Their pure matrix tests stay.
2. Replacement overstated (should-fix): fixed. Gate runs replace the test execution, not the candidate stage or `commit_sha` write; after this change only a stage PATCH writes `passed_premerge`, and `failed`/`rolled_back -> passed_premerge` is always `reset_needs_execute`. Recorded in OPS, in `docs/GOVERNANCE-STATE-MACHINES.md` (c) and as a `docs/MILESTONES.md` follow-up to decide before the enforce step.
3. Tests (should-fix): fixed. In `governance-transitions.test.ts` the ladder test keeps the PATCH ladder through `rolled_back`, the reset test keeps the PATCH half, the `sandbox execute: log-only` block and the sandbox stub are deleted. New: `workers/spec-do/tests/execute-retired.test.ts` (410 with the code for a known and an unknown id, the same body, empty and non-JSON body, nothing changed, no fetch) and `workers/api/tests/execute-retired-edge.test.ts` (master 410 without a Spec DO call for no body, `{}` and invalid JSON). The S9 403 rows stay.
4. Error shape (should-fix): fixed. `workers/shared/retired-route.ts` exports `ROUTE_RETIRED` and `routeRetired()`, used by both the edge and the DO; the edge answers before reading the body. The service-accounts 410 is left as is (optional, later).
5. Authorization order (nit): confirmed; the stale comment in `workers/api/principal.ts` is reworded.
6. Mixed version (nit): an old edge still parses the body before forwarding, so an empty body is a 500 at an old edge as today; a rollback restores the old route and the old DO still writes `execute_*` rows, which the kept type accepts.
7. Docs (should-fix): fixed: OPS, FEATURE-PARITY, CLI-PLAN, MILESTONES, GOVERNANCE-STATE-MACHINES (c), the governance plan inventory row 8. Historical records (the PR-S plan, M12 plan and review, OPEN-QUESTIONS 2026-10-16, the promotion-routes RFO) are left unchanged on purpose.
8. Sandbox runner routes (nit): follow-up (b) in `docs/MILESTONES.md`.
9. Tier label (nit): fixed (heavy).
