---
category: audit
status: active
audience: human,agent
---

# Whole-repo review: synthesis (2026-11-17)

This is step 3 of the whole-repo review. The orchestrator wrote it from the architecture map (`2026-11-15-architecture-map.md`) and the slice reports
`2026-11-16-review-{a,b1,b2,c,d,e}-*.md`. The docs-vs-code slice (f) is folded in at the end. The slice reports keep the full evidence (file:line, probes,
mutation results); this page removes duplicates, names the themes that cut across slices, and proposes an order of work.

**Nothing here is fixed.** Each item goes through the repo's process:
- a plan;
- an independent review of the plan;
- the implementation, with mutation checks (break the new guard, a test must fail);
- an independent code review;
- a merge to `main` only when the maintainer says so;
- for spine items (AGENTS.md rule 2), the heavy tier.

## Verdicts

| Slice | Verdict | Must-fix |
|---|---|---|
| a Spec DO ledger + migrations | approve with changes | 0 |
| b1 Promotion decision | request changes | 2 |
| b2 Build and gate plumbing | request changes | 1 |
| c Shadow and canary evidence | request changes | 2 |
| d Edge, auth, UI | request changes | 1 |
| e Tooling, CLI, CI, tests | request changes | 3 |

**What held up everywhere:**
- the transactional core: migrations, compare-and-swap writes, idempotency keys, purge, token handling;
- fail-closed auth;
- the sandbox isolation (no token in the container, no internet, no hooks, no bindings on candidate Workers);
- HTML escaping;
- rollback as a pure ref operation.

Across slices a, b1, b2, c and d, the reviewers broke 163 guards one at a time, and tests caught 141 of the breaks (87%). Most of the 22 that got
through are listed as "guards with no test" in the slice reports.

## Must-fix, after removing duplicates (7 distinct problems)

| # | Problem | Slices | Probed? |
|---|---|---|---|
| 1 | **The system actors `queue-consumer` and `promotion-worker` exist only in local dev seed data.** Every gate verdict written by the push path or the merge train fails on a foreign key in production. Push events are dropped after 5 runs, and every merge-train car fails. | b1-M2, b2-M1 | yes, against the real Spec DO; e-M3 reproduced it end to end |
| 2 | **The comparator acks and drops every comparison for a real candidate.** It reads `declaredDeltaSurface`, the Spec DO returns `declared_delta_surface`, and the stored shape (an array) would not parse anyway. No shadow score can exist in production. | c-M1 | yes |
| 3 | **The enforced canary rung is a 15-minute timer, and the SLO "healthy" verdict is not evidence.** It measures only mirrored platform GETs and almost never reaches its minimum sample count. It is recorded only in logs, and anyone with the bearer token can switch auto-rollback off. | b1-M1, c-M2 | yes (promoted with failed pre-merge and shadow verdicts) |
| 4 | **A user token can write as another actor** through `agentId` in the body on `claim` and `POST /api/repositories`. | d-M1 | yes (repositories); claim inferred |
| 5 | **CLI `--dry-run` performs the real write**, and the global `-n` is ignored by every write. | e-M1 | yes |
| 6 | **The CLI ignores `apiUrl` from its config** and sends the saved token to production. | e-M2 | yes |
| 7 | **Tests cannot fail on a broken contract between workers.** Five workers are absent from local e2e, one e2e test accepts the merge-train bug's symptom, and no test wires two real handlers together. | e-M3 | yes (15-line proof of concept) |

## Themes that cut across slices

1. **Mocked peers hide every serious contract bug.** Problems 1 and 2, b2-S1 (repository match key), e-S4 (CLI list shape), and the case mismatch known since
   2026-10-26 all passed because a test faked the other side. The five contract tests proposed in e-M3 (real Spec DO on node:sqlite, real peer handlers,
   no `vi.fn()` for bindings) would have caught each one. Write them first; they turn several of the fixes below into test-driven changes.
2. **Authorship and privilege are looser than the docs say.**
   - The body `agentId` (d-M1).
   - User-token routes the DO does not guard: spec and issue stage, links, repositories (d-S3, a-S2, a-S6).
   - Caller-chosen repository namespaces that the build path trusts (a-S6, confirmed from the build side in b2).
   - A simulated gate `pass` that any `read_write` token can request, and that counts as enforced evidence (b2-S4).
   - Every tier-1 worker can do everything in the promotion spine (a-S8).
   - The comment at `workers/api/principal.ts:258` ("the DO applies its own rules on every route") is false for six routes.
3. **The oracle ladder is enforced at two rungs, and both can be satisfied without the evidence the ladder describes.**

   | Rung | What gates it today |
   |---|---|
   | Pre-merge | a simulated verdict (b2-S4) |
   | Shadow | not earnable: problem 2, and only canaries are mirrored |
   | Train | a stub |
   | Canary | a timer (problem 3) |
   | Full | a stage write |

   Bypasses: the stage PATCH sets any stage (b1-S1, a-S2), `deployCanary` takes any id or spec (a-S4), and a hand-posted verdict counts (b1). Slice f
   checks whether AGENTS.md, README and ARCHITECTURE describe the ladder as built.
4. **Writes that report the wrong outcome.**
   - Stage PATCH: 200 for an unknown row, 404 after a committed write (a-S2).
   - Preview deploy invents a URL and answers success (b2-S5).
   - "Not found" for a 5xx (b2-S7).
   - `/merge/rollback` always answers 200 (b1-S3).
   - `prod-verify-promotion.sh` prints PASS after a failed cleanup (e-S2).
   - A thrown ledger call leaves a promotion stuck "in progress" (b1-S2).
5. **Field naming between workers is snake_case vs camelCase,** inconsistent between POST and GET (a-N6). It caused problem 2 and the queue consumer's
   `c.repositoryId || c.repository_id` workaround. One convention plus a shared zod schema per contract (c-S7) removes the class.
6. **Unbounded reads on the single serialization point.** List `limit` is not clamped at the DO or the edge (a-S1, d-S5), and the UI depends on `limit=500`.
   Choose the cap together with the UI's page size.
7. **Dead and simulated code that looks live.** About 15 unreachable modules, routes and bindings (map section 5), legacy simulated sandbox routes, build
   stubs, two queues with no producer, Analytics Engine payloads that are malformed and never read (c-S4), and old production-writing scripts (e-S3).

## Proposed order of work

**Wave 0: stop the bleeding.** These are small, edge-only or tool-only changes, safe while old and new versions run side by side. Each still gets a plan and a review.
1. d-M1: override `agentId` with the caller's actor for non-master callers on claim and repositories, and add a test.
2. e-M1 and e-M2: CLI dry-run (refuse anything but GET in one place) and the `--url` default, with harness tests.
3. e-S3: delete the old production-writing scripts. A deletion, so it needs the maintainer's go-ahead.
4. d-S3 and b2-S4 (edge side): remove the spec and issue stage PATCH, the link routes and the gate route from `USER_WRITE_ROUTES` until the DO has ownership
   rules; retire or fix the broken gate route (d-S1); correct the `principal.ts:258` comment.
5. d-S4: a top-level catch in `handleFetch`. d-S2: tests for the cookie signature, expiry, OAuth state and cookie attributes.
6. Maintainer action, no code: set `MIRROR_SAMPLE_PERCENT` back down. It is still 33, and with problem 2 nothing it produces can be scored.

**Wave 1: contract tests, then the three broken pipelines.**
1. e-M3: the `wire()` helper and contract tests 1-3, which fail today, plus test 5. Make e2e `m3-features.test.ts:544` require a merged car, and turn the
   early returns into skips.
2. Problem 1: reserved system actors created lazily in the Spec DO, as for `scientist-comparator`. Contract tests 1 and 2 go green.
3. Problem 2: the comparator falls back to the default surface, and one stored delta-surface shape is agreed. Contract test 3 goes green.
4. b2-S1, b2-S3: match a push on namespace + name through an opt-in filtered lookup.
5. b2-S2: record the assumed push message shape in OPEN-QUESTIONS and verify it against a throwaway repo before building on it.

**Wave 2: ladder integrity (spine; plan + independent review; heavy tier).**
1. Stage PATCH: refuse upward ladder moves and unknown or tombstoned rows; keep `failed`/`rolled_back` open (b1-S1, a-S2).
2. `deployCanary`: require a live candidate under the named spec, and decide whether to require `passed_train` (a-S4, map).
3. Canary evidence (problem 3): one plan covering what is measured, a reachable minimum volume, a verdict computed inside the Spec DO and recorded, the
   auto-rollback switch with its actor, and the alarm re-arm (c-S1). Only then make `advance(full)` require it.
4. Simulated gate: label simulated verdicts in the row, validate the candidate/spec pair and the sha (b2-S4); evidence per commit (b1-S8); a writer for
   `commit_sha` (b2-S8).
5. Tournament: a minimum sample count (b1-S5), one tournament per spec (b1-S6), the winner written before `advance` (b1-S4), and the stuck promotion state (b1-S2).
6. Tier-1 split: a second token for `advance`, the stage PATCH and deploy-ref writes (a-S8).

**Wave 3: hygiene.**
- Clamp `limit`, with the UI moving to filtered reads (a-S1, d-S5).
- Coded 404s (a-S7, d-S8).
- Security headers (d-S6). Numeric GitHub ids (d-S7).
- Analytics Engine payloads and header redaction (c-S3, c-S4). Header-allowlist tests (c-S2).
- Remove dead code and bindings (map section 5, b2 nits).
- CI: lint as a step, the postinstall checker gaps (e-S5), the e2e state leak (e-S6), the production e2e token file (e-S1).

## Known items whose status changed

| OPEN-QUESTIONS entry | Recorded as | Now |
|---|---|---|
| 2026-10-19 seed actor for `queue-consumer` | resolved | fixed only in local dev (b2-M1) |
| 2026-11-10 gate `actorId` not an actor | suspected | confirmed, and wider (b1-M2, b2-M1) |
| 2026-10-26 delta-surface casing | code read | confirmed, and since PR A a total loss (c-M1) |
| 2026-10-16 canary-worker Analytics Engine payload | canary worker only | also the comparator and the router (c-S4) |
| 2026-11-10 tournament decides on the second arrival | open | wider: a spec can never pass shadow -> train again (b1) |
| 2026-11-01 merge-train car matched by candidate only | open | fixed (`isCar`) |
| 2026-11-01 rollback ping-pong (D2) | open | fixed and tested |
| 2026-10-15 #5 m3-features reaches production | open | fixed (`E2E_ALLOW_PRODUCTION`) |

Updating these entries in `docs/OPEN-QUESTIONS.md` is part of Wave 0's docs work.

## Docs vs code (slice f)

Pending; filled in when the slice f report arrives.
