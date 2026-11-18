---
category: planning
status: active
audience: human,agent
---

# Wave 1: contract tests, then the three broken pipelines (plan, rev 2, 2026-11-18)

From `docs/reviews/2026-11-17-synthesis.md`, "Proposed order of work", Wave 1. The maintainer approved starting it on 2026-11-18.

**Spine.** Parts B and D change the Spec DO (the gate-verdict write path, and the repository and candidate list routes), so the heavy
tier applies (AGENTS.md rule 2):
- this plan gets an independent review before any code;
- the implementation gets mutation checks and an independent code review;
- the merge to `main` happens only when the maintainer says so in chat.

**Mixed-version safety.** Every change tolerates old and new peers in any deploy order. Each part's section says how.

## The three broken pipelines

| Pipeline | Breaks at | Finding |
|---|---|---|
| push -> queue-consumer -> gate -> Spec DO verdict | The verdict's `decided_by = 'queue-consumer'` is not an actor (a foreign key). That actor exists only in the local dev seed (`spec-do/seed.ts:125`, guarded by `DEV` at `spec-do/index.ts:709`). | b2 M1 |
| promote (merge-train) -> gate -> Spec DO verdict | The same foreign key, with `decided_by = 'promotion-worker'` (`promotion-worker/merge-train.ts:463-470`) | b1 M2 |
| comparator -> Spec DO shadow sample | The comparator reads `spec.declaredDeltaSurface`. The Spec DO returns `declared_delta_surface` (`spec-do/index.ts:2306`), and the stored value is a JSON array of strings (`shared/schemas.ts:138`), which `parseDeltaSurface` rejects. The throw is acked and the comparison dropped (`scientist-comparator/index.ts:207-224`, `:138-139`). | c M1 |

Two more problems stop the push path even with the actor fixed:
- **The repository match key.** The consumer matches `remote_url === full_name`, but `remote_url` is a full git URL (`queue-consumer/index.ts:150, 301`; `shared/artifacts.ts:154`). This is b2 S1.
- **The 100-row lookups.** b2 S3.

## Part A: the contract-test harness (review e M3)

**The harness.** A new directory, `tests/contract/`, picked up by the root vitest include `tests/**/*.test.ts`.

`tests/contract/wire.ts` provides one real Spec DO and `wire()`. The Spec DO comes from `makeSpecDo(makeSqliteState(), false)`:
- the `false` is the `authed` flag, so the DO is raw and checks tokens like production (`spec-do/tests/sqlite-state.ts:76-78`);
- there is no dev seed, because the env has no `DEV`;
- foreign keys are on.

`wire()` returns env objects whose bindings are the **real** handlers, following the rule in `spec-do/tests/do-tokens.ts:1-5`: workers get the raw DO
and carry their own tokens.
- **`SPEC_DO`** is `{ idFromName, get: () => ({ fetch: (r) => spec.fetch(r) }) }`. Every worker env carries `TEST_INTERNAL_ONLY`, so a worker that calls an
  admin route fails in the test as it would in production.
- **`API_AUTH_TOKEN`** is shared by every worker env. It is also the gate's `authGate` token.
- **`GATE_WORKFLOW`** is the real `gate-workflow` default `fetch`, with its own env wired back to the same Spec DO.
- **`PREVIEW_MANAGER`** is a recording stub. Out of scope: preview builds are simulated (b2 S5).
- **`authedDo`** (both tokens) is used only for the test's own arrange calls, never as a worker binding.

**Determinism.**
- Every test uses its own queue event ids. gate-workflow keeps a module-level run map keyed by the hash of the idempotency key
  (`gate-workflow/index.ts:246-275`), so a reused id replays an earlier result.
- Tests 1 and 2 pin `vi.spyOn(Math, 'random').mockReturnValue(0.5)`. The simulated gate's 10% conformance warning is random (`:876`).
- Test 4 drains the router's nested `ctx.waitUntil` work and calls `resetLiveRefsCache()` between tests (`shadow-router/live-refs-cache.ts:95`).

**The rule for these files:** no `vi.fn()` and no hand-written fake for `SPEC_DO` or a peer binding. Only the network outside the platform
(GitHub, Artifacts, candidate Workers) may be stubbed.

**The tests.** Each one is written first and must fail against the current code. The commit message records the failure.

| # | Path | Arrange | Assert | Fails today because |
|---|---|---|---|---|
| 1 | promotion-worker -> gate -> Spec DO | A candidate at `passed_shadow`, merge-train mode, a real `/promote` with `fromRung: 'train'`, `toRung: 'canary'` (a `passed_train` candidate is a no-op that never calls the gate, plan review M1) | `/promote` answers 200 `moved`, the car ends `merged`, the stage is `passed_train`, and there is one `gate_verdicts` row decided by `promotion-worker` (the pattern of `advance-flow.test.ts:591-600`) | b1 M2 (foreign key): today 409 `gate_failed`, with the gate answering 500 (probe) |
| 2 | queue-consumer -> gate -> Spec DO | A repository and candidate created the way `claimSpec` creates them (real `remote_url` shape), then one push message in the shape the consumer validates | The message is acked, there is one verdict decided by `queue-consumer`, and one `push_received` history row | b2 S1 (match key: no repository found, so it is retried) and, behind it, b2 M1 (foreign key). It goes green only after both B and D. |
| 3 | comparator -> Spec DO | A spec created through `POST /api/specs` (stored delta surface `[]`, and one with `["/price"]`), a live candidate, one queue message with a `production` baseline | A `shadow_scores` row exists, and the message is acked, not dropped | c M1 |
| 4 | shadow-router -> comparator | The real router `/mirror` handler with a live canary ref and a stubbed candidate fetch. Its captured queue message is fed into the comparator's `queue()` | The comparator accepts the router's real message shape and records a sample | c S7 (two hand-written interfaces); it passes once 3 passes, which pins the contract |

The CLI -> edge -> Spec DO test (e M3 #5) is out of Wave 1. It belongs with the CLI list fix (e S4) in Wave 3.

## Part B: the reserved system actors (b1 M2, b2 M1)

- **New module.** `workers/shared/system-actors.ts` exports `SYSTEM_ACTORS`, a frozen map from id to display name:
  - `queue-consumer`;
  - `promotion-worker`;
  - `scientist-comparator`, which moves here from `shared/shadow-verdict.ts` and is re-exported there for compatibility.
- **Spec DO.** `createGateVerdict` (`spec-do/index.ts:1871`) runs `INSERT OR IGNORE INTO actors (id, type, name, promotion_authority, created_at)`
  with type `agent` and authority 0, before the verdict insert, when `decidedBy` is a `SYSTEM_ACTORS` key.
  - This is the pattern `recordShadowSamples` already uses for `scientist-comparator` (`:5178-5182`), which then calls the shared helper. That actor
    keeps its display name, 'scientist comparator (service)'.
  - **Transactions.** `idempotent()` opens no transaction without a key, and the merge-train gate call sends none. So the `POST /api/gate-verdicts`
    route becomes `idem ? this.idempotent(idem, 201, m) : respond(201, transactionSync(m))`, as `handleShadowSamples` does (`:5169-5172`). The
    actor row and the verdict then commit together or not at all.
- **Guard.** `setActorRole` and `grantPromotionAuthority` refuse a `SYSTEM_ACTORS` id with 403, as `setActorRole` already refuses a service actor
  (`:2924`). Today `setActorRole` lets an actor bootstrap itself to maintainer while no maintainer exists (`:2919-2934`), and
  `grantPromotionAuthority` has no guard at all (`:1512-1519`).
- **Why lazy, not at init.** It writes only when needed, a ledger that never sees one of these callers gets no row, and it matches the
  existing pattern. Seeding at `init()` would write on every cold start of the busy `main` instance.
- **Not the fix:** creating the actors through `POST /api/actors`. `createActor` generates UUID ids (`:1465`), and the callers send the fixed string.
- **Security.**
  - The ids are fixed strings that `createActor` can never produce, so no human or agent actor can collide with them.
  - The rows have no promotion authority and no role.
  - A tier-1 caller could already set `decidedBy` to any existing actor, so this adds no new privilege.
  - The verdict route stays master-only at the edge (user tokens get 403, review d).
- **Mixed-version.** This is a Spec DO change only, and callers are unchanged. Until the new Spec DO is live, verdicts fail exactly as they do today.
- **Not broken:** the `history` POST from queue-consumer. `entity_history.changed_by` has no foreign key (`schema.sql:9-20`), so it never failed,
  which corrects b2 M1's inference. The plan review's sweep confirmed that the gate verdict is the only foreign-key write any worker reaches with
  a fixed system id. The others have no foreign key, or take the caller's actor:
  - `promotion_states`, `deploy_refs`, `idempotency_keys` and `governance_events` have none;
  - trials take the caller's actor.
- **Tests:**
  - contract tests 1 and 2 go green;
  - a unit test in `workers/spec-do/tests`: a verdict decided by `queue-consumer` on a fresh ledger gives 201 and one actor row, and a
    second verdict adds no second row;
  - a verdict decided by an unknown string still gets a non-2xx answer and writes no row;
  - the role and authority guards answer 403 for each system id.
- **Which contract tests go green:** test 1 goes green with B alone. Test 2 still stops at the repository match until D.

## Part C: the comparator reads the stored delta surface, or falls back (c M1)

1. **`storage/spec-do.ts` `getSpec`.** Return `{ id, declaredDeltaSurface }`, read from `declared_delta_surface ?? declaredDeltaSurface`. Either
   Spec DO casing works, so this is mixed-version safe.
2. **`index.ts:224`.** Replace the bare `parseDeltaSurface` call with `deltaSurfaceFor(spec)`, which returns the parsed surface when the stored
   value is a supported delta-surface object, and `getDefaultDeltaSurface()` otherwise. That covers missing, unparseable JSON, the array-of-strings
   shape `[]` or `["/price"]`, and an unsupported version.
   - On fallback it logs once per spec id per isolate: `[Scientist] spec <id>: stored delta surface is not a v1 object; using the default surface`.
     The set of logged ids is cleared at 1,000 entries.
   - A malformed spec never drops a comparison. It is scored with the default surface, the same as before PR A (`b10b851`).
3. **Not in Wave 1:** agreeing one stored shape. Specs store the edge's `string[]` today, while the comparator expects a versioned object. Choosing
   between converting at write time and widening the parser changes the spec contract, so it goes to Wave 2 with its own plan.
   - An OPEN-QUESTIONS line records the decision as pending.
   - **No current score changes.** No stored spec parses today: the camelCase read is `undefined`, and the parser throws.
   - **After the casing fix:** a v1 object stored by a tier-1 caller (the DO's `POST /api/specs` does not validate the field) would be honored.
   - **Same bug elsewhere:** `gate-workflow/index.ts:797-798` has the same casing bug. Its value is unused; it goes to Wave 2 with this decision.
4. **Tests:**
   - contract test 3;
   - unit tests for `deltaSurfaceFor` with an object, `[]`, `["/price"]`, `undefined`, invalid JSON and a wrong version;
   - the fallback log is emitted at most once per spec.
   - Mutation checks: restoring the bare parse must fail contract test 3.

## Part D: the queue consumer finds the repository (b2 S1, S3)

1. **Matching.** Match on `event.repository.namespace` and `event.repository.name`. The consumer's schema already requires both
   (`queue-consumer/index.ts:34-38`), so this adds no new assumption about `full_name`.
   - The match keys, in order:
     1. `namespace` and `name` equal;
     2. `remote_url === full_name` (today's key, kept for ledgers or tests that stored the short form);
     3. `remote_url` ending in `/<namespace>/<name>.git`. `claimSpec` stores its local name in `repositories.name`, while `remote_url` uses the name
        the Artifacts API returned (`spec-do/index.ts:1799, 1815-1826`; `shared/artifacts.ts:151-154`), and the two can differ.
   - No match stays **transient**, as today (`:302-303`). Until the real message shape is verified (part E), a permanent ack could silently drop
     every push.
2. **Spec DO filters, opt-in and additive:**
   - `GET /api/repositories?namespace=<ns>&name=<name>` filters with `WHERE namespace = ? AND name = ?` (live rows; `include_deleted` as today).
     The filter applies only when both parameters are given; one alone is ignored, so the route behaves as today. Results stay newest first
     (`ORDER BY created_at DESC`), and the consumer takes the first match.
   - `GET /api/candidates?repositoryId=<id>` adds `repository_id = ?` to the existing filters.
   - **Mixed-version:** an old Spec DO ignores unknown query parameters and returns its usual first page. The consumer still matches on the client
     side, so an old Spec DO behaves as today (100-row limit), and a new one finds any row.
3. **Consumer.** Both lookups (`triggerPreviewDeployment` `:131-160` and `processMessage` `:280-305`) send the filters and keep `limit=100`. The
   comment "Lookups cover the first 100 rows only" becomes "...only against a Spec DO older than the filters".
4. **Tests:**
   - contract test 2 (a real `claimSpec`-shaped `remote_url`);
   - Spec DO unit tests for both filters (with 101 repositories, the oldest is found by namespace and name);
   - a consumer unit test that an old-DO answer (filters ignored) still matches on the client side.
   - Mutation checks: dropping the namespace/name match, dropping each DO filter.

## Part E: the push message shape (b2 S2)

No code change.
- Add an OPEN-QUESTIONS entry: the consumer's message shape (`queue-consumer/index.ts:32-57`) is an assumption with no producer in the repo and no
  Artifacts documentation. It stays unverified until a real push event is captured.
- **Maintainer action**, because it needs production Artifacts:
  1. push to a throwaway repository with the queue subscription set up;
  2. capture one message with `wrangler queues` or a tail;
  3. record its shape.
- If it differs from the consumer's schema, a follow-up adapts the schema. Contract test 2 then switches to the captured shape.

## Order and verification

1. **Order:** A first. The four tests are written against today's code: 1-3 fail, and 4 fails until 3 passes. Then B (test 1 green), C (tests 3
   and 4 green) and D (test 2 green), then E.
2. **One commit per part,** plus the test commits. Mutation checks on every new guard, after committing.
3. **Before the code review:**
   - `npm test`, `npm run typecheck`, the docs-links test;
   - local e2e once (it does not run gate-workflow, the queue consumer or the comparator, so it checks only that nothing regressed);
   - a dry-run build of the four changed workers (`npx wrangler deploy --dry-run` in `workers/spec-do` via the root config, `scientist-comparator`,
     `queue-consumer`, `promotion-worker`, and `workers/api`, which also imports `shared/shadow-verdict.ts`).
4. **Deploy notes for `docs/OPS.md`:**
   - After deploy, the first push or merge-train gate run creates the `queue-consumer` or `promotion-worker` actor row.
   - The first comparison for a ledger spec logs the fallback line and writes a `shadow_scores` row.
   - Check `SELECT id FROM actors WHERE id IN ('queue-consumer','promotion-worker','scientist-comparator')` and one `shadow_scores` row.

## Not in Wave 1

- The stored delta-surface shape (part C.3, Wave 2).
- e2e `m3-features.test.ts:542-545`, which accepts `gate_failed`. The local e2e stack does not run gate-workflow, so a merged car cannot be required
  there until the stack runs it (review e M3, Wave 3). Contract test 1 covers the path instead.
- The gate's simulated verdicts and the `gate/pre-merge` edge route (Wave 2).
- preview-manager `findCandidateByRepo` (`preview-manager/index.ts:436-455`, review b2 N3). Its queue handler has no consumer config, so the code is
  dead; it goes to the Wave 3 dead-code removal.
- **A deviation from the synthesis.** Its Wave 1 item 1 also listed the CLI contract test (#5) and the e2e `m3-features` fix
  (`2026-11-17-synthesis.md:105-106`). Both move to Wave 3, for the reasons above.

## Plan review dispositions (rev 1, 2026-11-18, Opus; approve with changes)

Fable was unavailable (no usage credits), so an Opus agent did this review. The maintainer approved that, with **a Fable double-check of the plan
pending** for when Fable is available again.

| Finding | Disposition |
|---|---|
| M1: test 1 with a `passed_train` candidate is a no-op that never calls the gate, so it passes today | Fixed. It now starts at `passed_shadow` with train->canary; the probe confirmed it fails today and passes with the fix. |
| M2: the harness contradicted itself on auth, and `authedDo` would hide tier errors | Fixed. Raw DO per worker, `TEST_INTERNAL_ONLY` in every worker env, `authedDo` only for arrange calls; the seed wording is corrected. |
| S1: `idempotent()` has no transaction without a key, which is the merge-train path | Fixed. The route uses `transactionSync` when there is no key. |
| S2: test 2 needs both B and D | Fixed, in the table and in Order. |
| S3: match on the schema's `namespace` and `name` fields, and do not drop pushes as permanent | Fixed. Three match keys; a miss stays transient. |
| S4: filter semantics undefined | Fixed. Both parameters or neither; newest first; take the first. |
| S5: refuse role and authority grants for system actors | Fixed. 403 guards and tests. |
| S6: harness determinism | Fixed. Unique event ids, `Math.random` pinned, router drain and cache reset. |
| S7: `workers/api` missing from the dry-runs | Fixed. |
| N1-N6 | All taken: the cap; the scoring wording; gate-workflow casing to Wave 2; the not-in-Wave-1 list; the unknown-id assertion; the seed reference and display name. |

## Code review dispositions (2026-11-18, Opus; approve)

| Finding | Disposition |
|---|---|
| S1: the canary recorder singleton leaks a pending tail flush and samples across contract tests | Fixed: a `resetCanaryMetricsRecorder()` test hook, called in `afterEach`. |
| S2: the contract tests do not pin the snake_case read, because the fallback scores either way | Kept as is. The unit test `delta-surface-for.test.ts` "snake_case" is the guard for the wire casing; a contract case asserting a v1 surface's effect on the score waits for the Wave 2 shape decision. |
| N3: `SCIENTIST_COMPARATOR_ACTOR` was a second literal, so it could drift from `SYSTEM_ACTORS` | Fixed: defined once in `system-actors.ts`, re-exported by `shadow-verdict.ts`. |
| N4: `getDeclaredDeltaSurface` returned `'null'` | Fixed: it returns `null` again. |
| N5: a push that never matches costs two repository lookups per attempt | Accepted (at most 10 Spec DO reads over 5 attempts); noted here. |
| N6: a ledger name that differs from the Artifacts name, beyond the newest 100 rows, is still missed | Accepted: `claimSpec` derives both names itself, so this is unlikely today. Recorded here; the remote_url key works only on the unfiltered first page. |

**Fable double-check of this plan and code: pending**, for when Fable is available again (maintainer, 2026-11-18).
