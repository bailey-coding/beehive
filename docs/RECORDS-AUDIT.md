---
category: governance
status: active
audience: human,agent
---

# Decision Records Audit (2026-10-17)

Scope: ADR 0001-0005, RFC 0001-0007, 7 RFOs. Branch `agent/rfc-adr-review`. Method: every claim
checked against code (`path:line`), `git show <sha>`, and `docs/MILESTONES.md` / `OPEN-QUESTIONS.md` /
`FOCUS.md`. Current ledger schema is m8 (`workers/spec-do/index.ts:27`). Edits are in the records
themselves (blockquotes headed "Audit 2026-10-17"); one commit per record.

## Verdicts

| Record | Verdict | Key issues |
|---|---|---|
| ADR-0001 VCS client | needs human | Sapling appears nowhere but this ADR and the ARCHITECTURE index; stack-to-branch translation not built. Note added. |
| ADR-0002 Coordination state | minor fixes made | Spec DO + Analytics Engine real; **D1 not bound anywhere**; git notes never read/written by code. Note added. |
| ADR-0003 Language | accurate | See "ADR-0003 check" below. Untouched. |
| ADR-0004 CI | minor fixes made | No R2 snapshot cache (plan only, `docs/R2-CACHE-PRUNING-PLAN.md`); Sandbox SDK binding is "future" in `workers/sandbox-runner/index.ts:20`; GitHub `ci.yml`/`ci-enhanced.yml` unmentioned. |
| ADR-0005 Org memory | needs human | "Accepted" but near-miss type, outcome-linking, initiator/executor/reviewer absent from schema (only `gate_verdicts.complexity_delta`, `actors.promotion_authority`); "RFD" undefined. Planned in M5a/M5b/M7. |
| RFC-0001 Oracle ladder | minor fixes made | Worker paths `workers/beehive-*` did not exist; ladder is in AGENTS.md, not ADR-0001 as the date note implied; M3/M4 status overstated. |
| RFC-0002 Native stores | minor fixes made | `schema-inline.ts` called "generated" (hand-synced, guarded by `schema-sync.test.ts`); D1/R2 shown as in use (not bound); phase list replaced with m1-m8. |
| RFC-0003 Service tokens | needs human | Design fabricated: `services` table, capability enum, path restrictions, `/api/service-tokens` do not exist. Replaced with the m6 `service_tokens` design (aeec713). Date was 10-12, commit is 10-16. Lessons/alternatives unsupported. |
| RFC-0004 Canary | needs human | Fabricated `deploy_refs` (status column, 4 rungs) and status-flip rollback; real: append-only ref chain, rungs canary/full. Replaced. SLO-triggered auto-rollback not verified. |
| RFC-0005 Shadow cache | minor fixes made | Invented `LIVE_REFS_CACHE_ENABLED` and per-key cache; real: one entry per isolate, TTL 0 disables, clamp 60 s. |
| RFC-0006 Ledger CAS | needs human | Claimed `version` on all tables, `/spec-do/record/:id`, INIT/RUNNING/DECIDING/CANCELLED states; real: `tournaments` + `merge_trains` only, pending/in_progress/completed/failed. Replaced. At-least-once quote was from MILESTONES.md, not 8ef8b61. |
| RFC-0007 Two-tier auth | minor fixes made | Invented routes, `Authorization: Bearer` transport and `specDoClient.ts`; real: `X-Beehive-Internal` / `X-Beehive-Admin` in `workers/shared/spec-do-auth.ts`. |
| RFO ledger-lifecycle | minor fixes made | Timeline rewritten (finding 10-13 manual cleanup of 27 orgs, fix 10-15); nonexistent `migrations/` dir; tombstones on 5 tables, not "all". |
| RFO e2e-test-drift | minor fixes made | "CI failures" false (e2e ran locally); 28 failed to 6, later to 0. Date 10-15. |
| RFO migration-failures | minor fixes made | Code change verified (55886a4); `migrations/` dir does not exist; date 10-16. |
| RFO promotion-routes-fix | minor fixes made | Three routes were invented ("or similar"); real ones in OPEN-QUESTIONS 2026-10-16; found by e2e rerun, not maintainer review; wrong commit for AGENTS rule (8ef8b61, not 8480fde). |
| RFO reserved-org | needs human | "DB reserved marker" invented (hard-coded constants); SEV-1 describes a hypothetical, fix was a review item. |
| RFO schema-sync-drift | minor fixes made | Date, timeline; "manual copy-paste" cause is inference. |
| RFO zod-build-failure | minor fixes made | Workers Builds, not "CI"; postinstall is `npm install --prefix ../shared`, not copy/link. |

## Conflicts

- **RFC-0003 vs RFC-0007 (tokens):** originally 0007 listed admin route `POST /api/service-tokens` that 0003 also invented; neither exists. Now consistent: service tokens (`bh_svc_`, edge-verified) and Spec DO internal tokens are separate layers.
- **RFC-0006 vs ledger code:** original text contradicted `workers/shared/ledger-state-machine.ts` (states, scope of `version`). Fixed to match.
- **RFC-0004 vs AGENTS.md rule 7:** "rollback is a status change" vs the append-only ref chain in `workers/shared/deploy-refs.ts`. Both are ref operations; text fixed.
- **ADR-0002 vs RFC-0002:** compatible, but both present D1 (and RFC-0002 R2) as in use; neither is.
- **ARCHITECTURE.md index vs ADRs:** labels ADR-0004 "CI (Workers-only)" and ADR-0005 "Org Memory (Maintainer-only)"; ADR texts do not say that. Not edited (outside scope).
- **ADR-0004 vs AGENTS.md rule 6:** ADR says Workflows+Sandbox SDK validate; AGENTS.md also states GitHub runs CI only. Both true today, ADR is silent on GitHub CI.

## Unsupported by repo evidence (flagged, not rewritten)

- All "Author: Maintainer / Architecture Team" lines: no commit names a decision-maker; replaced with "unattributed".
- Every "Alternatives Considered / Why Rejected" block in RFC-0002..0007, all "Lessons Learned", "Open Questions", "Future Enhancements", and RFO "Detection", "Detection Delay", "Duration", "Affected Users", action-item owners and dates. Backfilled; no commit or doc records them.
- RFO severities (SEV-1/SEV-2) and ADR-0001 Mercurial rejection reasons.
- RFC-0001 rung "Pass Criteria" and canary "1-5%" example: no code default.
- RFO frontmatter ids duplicated (`RFO-2026-10-14` x5); aligned to the README index ids.
- Record dates 10-12/10-13/10-14 were mostly wrong (all cited commits are 10-15 to 10-16). RFO filenames still carry the old dates; renaming would break links, left for a human.

## Missing records (not written)

1. Deploy-all-ten-at-once with no ordering control, mixed-version window (`docs/OPS.md`, 7f2b7cc).
2. GitHub CI-only; deploys via Workers' Artifacts integration on maintainer push (e448705, 5ec98ef).
3. Fail-closed edge auth (`workers/shared/auth.ts`, `API_AUTH_TOKEN`); only the Spec DO layer has an RFC.
4. Tombstone-then-purge ledger lifecycle (48a5f54): only an RFO exists, no ADR/RFC.
5. Tournament state machine and retry cap of 3 (covered inside RFC-0006 only).
6. Append-only deploy-ref chain as the rollback mechanism (inside RFC-0004 only).
7. Reserved `beehive-system` org and `master` actor (RFO only).

## ADR-0003 check

Left untouched. Checked: no `*.zig` files in the repo (consistent with "Zig only after measurement"); all workers are TypeScript (`workers/*/index.ts`); Python not present in repo, with the Sandbox SDK binding still "future" (`workers/sandbox-runner/index.ts:20`), so "Python lives only inside Sandboxes" is untestable today but not contradicted. Not verifiable: training-data and Rust/Go rationale.

## Could not verify

- Production state, deploy timings and whether SLO-driven auto-rollback runs unattended.
- Test claims in RFOs ("migration tests passing", "routes tested end-to-end"); tests were not run.
- Whether 48a5f54 introduced the schema drift fixed in 0fa4abb.
- Statsig behavior and Workers Builds claims (no network used).
- RFC links to `github.com/bailey-coding/beehive/commit/<sha>` (all shas exist locally; URLs not fetched). All relative links in scope resolve.

## Hygiene

Templates: ADRs 0003-0005 omit Context/Alternatives/Consequences and Author; RFCs/RFOs follow the template headings. Indexes list every record; RFC/RFO README dates were not updated to the corrected dates (see record headers).
