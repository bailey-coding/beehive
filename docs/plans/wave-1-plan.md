---
category: planning
status: draft
audience: human,agent
---

# Wave 1: contract tests, then the three broken pipelines (plan, rev 1, 2026-11-18)

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
| push -> queue-consumer -> gate -> Spec DO verdict | The verdict's `decided_by = 'queue-consumer'` is not an actor (a foreign key). That actor exists only in the local dev seed (`spec-do/index.ts:707-711`). | b2 M1 |
| promote (merge-train) -> gate -> Spec DO verdict | The same foreign key, with `decided_by = 'promotion-worker'` (`promotion-worker/merge-train.ts:463-470`) | b1 M2 |
| comparator -> Spec DO shadow sample | The comparator reads `spec.declaredDeltaSurface`. The Spec DO returns `declared_delta_surface` (`spec-do/index.ts:2306`), and the stored value is a JSON array of strings (`shared/schemas.ts:138`), which `parseDeltaSurface` rejects. The throw is acked and the comparison dropped (`scientist-comparator/index.ts:207-224`, `:138-139`). | c M1 |

Two more problems stop the push path even with the actor fixed:
- **The repository match key.** The consumer matches `remote_url === full_name`, but `remote_url` is a full git URL (`queue-consumer/index.ts:150, 301`; `shared/artifacts.ts:154`). This is b2 S1.
- **The 100-row lookups.** b2 S3.

## Part A: the contract-test harness (review e M3)

**The harness.** A new directory, `tests/contract/`, picked up by the root vitest include `tests/**/*.test.ts`.

`tests/contract/wire.ts` provides one real Spec DO (`makeSpecDo(makeSqliteState(), false)`: no dev seed, foreign keys on, as in production) and
`wire()`. `wire()` returns env objects whose bindings are the **real** handlers:
- `SPEC_DO`: an authed stub of the real Spec DO (the `authedDo` helper used by `promotion-worker/tests/advance-flow.test.ts`);
- `GATE_WORKFLOW`: the real `gate-workflow` default `fetch`, with its own env wired back to the same Spec DO;
- `PREVIEW_MANAGER`: a recording stub. Out of scope: preview builds are simulated (b2 S5).

**The rule for these files:** no `vi.fn()` and no hand-written fake for `SPEC_DO` or a peer binding. Only the network outside the platform
(GitHub, Artifacts, candidate Workers) may be stubbed.

**The tests.** Each one is written first and must fail against the current code. The commit message records the failure.

| # | Path | Arrange | Assert | Fails today because |
|---|---|---|---|---|
| 1 | promotion-worker -> gate -> Spec DO | A candidate at `passed_train`, merge-train mode, a real `/promote` | The car ends `merged`, there is one `gate_verdicts` row decided by `promotion-worker`, and `/promote` answers success with the stage `advance` wrote (asserted from the ledger, not hard-coded) | b1 M2 (foreign key) |
| 2 | queue-consumer -> gate -> Spec DO | A repository and candidate created the way `claimSpec` creates them (real `remote_url` shape), then one push message in the shape the consumer validates | The message is acked, there is one verdict decided by `queue-consumer`, and one `push_received` history row | b2 M1 (foreign key), b2 S1 (match key) |
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
  - This is the pattern `recordShadowSamples` already uses for `scientist-comparator` (`:5178-5182`), which then calls the shared helper.
  - It runs inside the caller's transaction (the route already uses `idempotent`, which is transactional).
- **Why lazy, not at init.** It writes only when needed, a ledger that never sees one of these callers gets no row, and it matches the
  existing pattern. Seeding at `init()` would write on every cold start of the busy `main` instance.
- **Not the fix:** creating the actors through `POST /api/actors`. `createActor` generates UUID ids (`:1465`), and the callers send the fixed string.
- **Security.**
  - The ids are fixed strings that `createActor` can never produce, so no human or agent actor can collide with them.
  - The rows have no promotion authority and no role.
  - A tier-1 caller could already set `decidedBy` to any existing actor, so this adds no new privilege.
  - The verdict route stays master-only at the edge (user tokens get 403, review d).
- **Mixed-version.** This is a Spec DO change only, and callers are unchanged. Until the new Spec DO is live, verdicts fail exactly as they do today.
- **Also fixed by part B:** the `history` POST from queue-consumer. `entity_history.changed_by` has no foreign key (`schema.sql:9-20`), so it never
  failed, which corrects b2 M1's inference.
- **Tests:**
  - contract tests 1 and 2 go green;
  - a unit test in `workers/spec-do/tests`: a verdict decided by `queue-consumer` on a fresh ledger gives 201 and one actor row, and a
    second verdict adds no second row;
  - a verdict decided by an unknown string still fails, so the existing foreign key keeps refusing non-system ids.

## Part C: the comparator reads the stored delta surface, or falls back (c M1)

1. **`storage/spec-do.ts` `getSpec`.** Return `{ id, declaredDeltaSurface }`, read from `declared_delta_surface ?? declaredDeltaSurface`. Either
   Spec DO casing works, so this is mixed-version safe.
2. **`index.ts:224`.** Replace the bare `parseDeltaSurface` call with `deltaSurfaceFor(spec)`, which returns the parsed surface when the stored
   value is a supported delta-surface object, and `getDefaultDeltaSurface()` otherwise. That covers missing, unparseable JSON, the array-of-strings
   shape `[]` or `["/price"]`, and an unsupported version.
   - On fallback it logs once per spec id per isolate: `[Scientist] spec <id>: stored delta surface is not a v1 object; using the default surface`.
   - A malformed spec never drops a comparison. It is scored with the default surface, the same as before PR A (`b10b851`).
3. **Not in Wave 1:** agreeing one stored shape. Specs store the edge's `string[]` today, while the comparator expects a versioned object. Choosing
   between converting at write time and widening the parser changes the spec contract, so it goes to Wave 2 with its own plan.
   - An OPEN-QUESTIONS line records the decision as pending.
   - Until then the declared delta surface has no effect on scoring. The review already found that true for every stored spec.
4. **Tests:**
   - contract test 3;
   - unit tests for `deltaSurfaceFor` with an object, `[]`, `["/price"]`, `undefined`, invalid JSON and a wrong version;
   - the fallback log is emitted at most once per spec.
   - Mutation checks: restoring the bare parse must fail contract test 3.

## Part D: the queue consumer finds the repository (b2 S1, S3)

1. **Matching.** Parse `event.repository.full_name` as `<namespace>/<name>` (the shape the consumer's own zod schema and both scripts assume).
   - Match a repository whose `namespace` and `name` are equal to those two parts.
   - Keep `remote_url === full_name` as a second match, so ledgers or tests that stored the short form still match.
   - A `full_name` without exactly one `/` is permanent: acked with an error log, the same class as a validation failure.
2. **Spec DO filters, opt-in and additive:**
   - `GET /api/repositories?namespace=<ns>&name=<name>` filters with `WHERE namespace = ? AND name = ?` (live rows; `include_deleted` as today);
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

1. **Order:** A first. The four tests are written against today's code: 1-3 fail, 4 fails until 3 passes. Then B, C and D, each turning its tests
   green, then E.
2. **One commit per part,** plus the test commits. Mutation checks on every new guard, after committing.
3. **Before the code review:**
   - `npm test`, `npm run typecheck`, the docs-links test;
   - local e2e once (it does not run gate-workflow, the queue consumer or the comparator, so it checks only that nothing regressed);
   - a dry-run build of the four changed workers (`npx wrangler deploy --dry-run` in `workers/spec-do` via the root config, `scientist-comparator`,
     `queue-consumer`, and `promotion-worker` for the shared import).
4. **Deploy notes for `docs/OPS.md`:**
   - After deploy, the first push or merge-train gate run creates the `queue-consumer` or `promotion-worker` actor row.
   - The first comparison for a ledger spec logs the fallback line and writes a `shadow_scores` row.
   - Check `SELECT id FROM actors WHERE id IN ('queue-consumer','promotion-worker','scientist-comparator')` and one `shadow_scores` row.

## Not in Wave 1

- The stored delta-surface shape (part C.3, Wave 2).
- e2e `m3-features.test.ts:542-545`, which accepts `gate_failed`. The local e2e stack does not run gate-workflow, so a merged car cannot be required
  there until the stack runs it (review e M3, Wave 3). Contract test 1 covers the path instead.
- The gate's simulated verdicts and the `gate/pre-merge` edge route (Wave 2).
