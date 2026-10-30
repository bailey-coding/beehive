---
category: audit
status: active
milestone: m5a
audience: human,agent
tags:
  - audit
---

# M5a and ADR 0005 implementation audit

**Date:** 2026-10-30 | **Branch:** `claude/pr1-review-lmgqik` | **Method:** read `docs/MILESTONES.md` (M5a, M5b), `docs/decisions/0005-org-memory.md` and `docs/M5-PLAN.md`; grepped `workers/` and `workers/spec-do/schema.sql` for each claim; ran `idempotency`, `migration-legacy` and `schema-sync` tests (34 passed). Not verified: production state, e2e, the vibe-branch typing work beyond the greps below.

## Verdict

M5a is marked "COMPLETE 2026-10-19" but only the idempotency work is built, and that only for part of the surface. Three of its five bullets and three of its four exit criteria are not met. Set M5a to **PARTIAL** and move the unbuilt bullets into a named milestone. ADR 0005 stays Proposed.

## M5a bullet by bullet

| M5a claim | Evidence | Status |
|---|---|---|
| Idempotency keys on "all Spec DO mutations" | `workers/spec-do/index.ts:38-42`: 9 routes wired (organizations, actors, repositories, specs, candidates, gate-verdicts, trials, promotions, entity history). The main `/api` block has 25 mutation routes (`index.ts:3664-4273`) and more sit in the promotion, tournament, merge-train, canary, deploy-ref and purge handlers (`index.ts:2634-3122`). Issues, issue comments, links, stage changes, claim, decide, execute and gate/pre-merge are unwired. Enforced and tested: 17 tests, scoped by actor and route, atomic with the mutation, 24h TTL | **Partial** |
| Queue-consumer double-write prevention | `workers/queue-consumer/index.ts:350-372`: history write keyed `${queue}:${event.id}`. See finding 2 for what is still not protected | **Partial** |
| Bootstrap fields: change type, approval records, self-approval markers, cost attribution | No such columns or tables in `schema.sql` or `schema-inline.ts`. `git grep` for `approval`, `self_approv`, `cost_attrib`, `cost_usd` in `workers/` returns nothing | **Not built** |
| Change-type classification with confidence | `change_type` / `changeType` appears only in `workers/api/ui-pages.ts` and `ui-semantic.ts`, where the semantic UI falls back to a random category (`ui-semantic.ts:636`). No classifier, no schema column, no gate-policy link | **Not built** (mock only) |
| Two-person merge rule at promotion step | No code in `workers/promotion-worker/` or the Spec DO. `actors.promotion_authority` (`schema.sql:74`) is a boolean and is not a two-approver check | **Not built** |
| Legacy-shape migration tests | `migration-legacy.test.ts`, 13 tests, pass; asserts schema m10 | **Done** |
| Compile-time auth safety (branded request types) | `workers/shared/principal.ts` and `principal.test-d.ts` exist; `workers/api/index.ts:116-117` wires `withAuth`/`withActor` and handlers take `ActorRequest`. The "all 43 handlers" count was not verified. The bullet sits after M5a's exit criteria and cites a `vibe/` branch that no longer exists, so it is not part of M5a's scope | **Done, scope mismatch** |

**Exit criteria:** (1) idempotency prevents double-writes: met for the 9 wired routes only. (2) bootstrap fields added: not met. (3) change-type classification operational: not met. (4) two-person rule logic in place: not met.

## ADR 0005 against the schema

| ADR requirement | In schema? | Where planned |
|---|---|---|
| Outcome-linking | No | M7 |
| Complexity delta as a candidate axis | Partly: `gate_verdicts.complexity_delta` (`schema.sql:136`), not on `candidates`. The seed and types use it; nothing computes it | M1 (stated done), M5b intake |
| Actor identity: initiator / executor / reviewer | No. `actors` has `trust_score` and `promotion_authority` only | M5b |
| Trust-gated promotion authority | Partly: `promotion_authority` is a flag; `trust_score` is stored and never read by a gate (grep in `promotion-worker/` finds none) | M5b |
| Near-miss record type | No. No table, no route; losing candidates keep only their `candidates` row | No milestone item delivers it |
| Lineage chain RFD → ADR → Spec → … | No lineage links in the ledger; the chain exists as document conventions only | Not planned |

The ADR says these are "cheap now, expensive to retrofit". Two further additive migrations have since shipped (m11 canary metrics, m12 user tokens) without them. Each is still additive, so the retrofit cost has not risen, but the "from day one" promise is already broken.

## Findings

1. **The public API drops the `Idempotency-Key` header.** The edge helper that calls the Spec DO builds its own headers (`workers/api/index.ts:467-474`: `Content-Type` and `X-Actor-ID` only). Keys therefore work only for callers that talk to the DO directly, which today is just the queue consumer. Any client or workflow retrying through `/api/*` gets no protection, whatever the DO tests show. Fix: forward the header in that helper and add an edge-level test.
2. **The queue consumer is only half idempotent.** In `queue-consumer/index.ts` the gate workflow is triggered before the keyed history write (about line 335 versus 350). A redelivered message runs the gate workflow a second time and only the history write is deduplicated. The handler never calls `message.retry()` or `ack()` (grep finds neither) and catches every error per message, so the batch returns normally and the queue treats every message as delivered: a failed gate trigger or history write is dropped, not retried. The comment "409 means already processed" is wrong: a replay of the same body returns the stored 201 with `Idempotent-Replay: true`; a 409 means the same key arrived with a different body, which should be logged, not ignored.
3. **Documentation drift.** `docs/MILESTONES.md` cites commit `dfaa8ee`, which does not exist in this repo. `docs/FOCUS.md` says M5a idempotency is merged, which is true and is the only part of M5a that is. ADR 0005's audit note (2026-10-17) says M5a/M5b were "not started"; M5a has since started and the note should be updated to match the table above.
4. **Plan conflict to decide.** `docs/M5-PLAN.md:32,60` says maintainer approval is human-only and cannot be delegated to agents. The 2026-10-30 spine policy lets agents write the code. These do not contradict: one is who authors the two-person rule, the other is who may hold approval on a promotion. Say so in M5-PLAN so a spine task is not read as permission for agent approvals.

## Recommended changes

1. `docs/MILESTONES.md`: change M5a to **PARTIAL (idempotency, migration tests done)**. Create **M5a-2** holding the bootstrap fields, change-type classification and the two-person rule, each with the exit criteria above. Remove the `dfaa8ee` citation.
2. Add a near-miss record type to M5a-2 (table, write on trial/promotion loss, read route). Nothing else in the plan produces it, and M5b's trust calibration lists near-miss rate as an input.
3. Schema for M5a-2 should ship in one additive migration (m13 or later; m12 is user tokens and the index migration is m12 or later per FOCUS), covering ADR 0005's initiator/executor/reviewer, outcome link and near-miss table so the retrofit happens once.
4. Fix findings 1 and 2 first; they are small and change real behavior. Both touch spine code, so they need the plan and independent review gates.
5. Wire the remaining mutation routes, or reword the claim to name the nine.
