---
category: audit
status: active
audience: human,agent
---

# Review, slice a: Spec DO ledger and migrations (2026-11-16)

This is step 2 of the whole-repo review (context: `docs/reviews/2026-11-15-architecture-map.md`). An independent Fable agent did a read-only pass at `f4008e2`.
Its probes ran against the real Spec DO on node:sqlite in a scratch worktree. The orchestrator confirmed S1: nine list routes parse `limit` with a bare
`parseInt` (for example `workers/spec-do/index.ts:4404`), and only the gate-runs list clamps it (`:5330`). The `advance` logic is reviewed in slice b1. No finding is fixed yet.

**Verdict: approve with changes; no must-fix.** The spine parts are in good shape: migrations, tokens, CAS, idempotency, purge and the auth gate. The reviewer's
test-breaking edits were caught by a test 25 times out of 26. The weak part is the m1-era CRUD layer in the same file. Its list queries are unbounded, its stage
writes go through to unknown and tombstoned rows, and its canary and repository writes accept ids nobody checked.

## Should-fix

**S1. No list route clamps `limit`, at the DO or at the edge.** (`index.ts:4192-4654`; list methods `:5619-5830`; the edge, `workers/api/index.ts:1566-1985`, passes it through)
- Probe: with 121 candidates, `GET /api/candidates?limit=-1` returned all 121, and so did `limit=100000`. `limit=abc` returned 500 `datatype mismatch`.
- Impact: any service or user token with read scope can make the single DO serialise a whole table. That DO is the one serialization point for promotion decisions.
- Also unbounded:
  - `GET /promotion-states` without `candidateId` (`:3120`).
  - `/tournament-status/all` and `/merge-train-status/all`.
  - `GET /tournament-status?specId=`, which parses every tournament of the spec to return the first (`:3067`).
  - `getEntityHistory` (`:5910`), `listIssueComments`, `listUserTokens`.
- Fix: clamp as gate-runs does (1 to 100, with NaN falling back to the default), and use `LIMIT 1` for the by-spec lookups.

**S2. Stage PATCH writes to unknown and tombstoned rows and reports the wrong outcome.** (`transitionSpec :1578`, `transitionIssue :2197`, `transitionCandidate :1656`; routes `:4374, 4431, 4679`) All probed:
- `PATCH /api/specs/nope/stage` returns 200 `{success:true,data:null}` and writes an orphan `entity_history` row. The issues route does the same.
- A tombstoned spec gets restaged, with 200 `data:null`.
- A tombstoned candidate was set to `promoted` while the route answered 404. The write committed, so the caller (`promotion-worker/spec-do.ts:98`) reads a failure as "nothing happened".
- An invalid stage gives a 500 from the CHECK constraint.
- The spec and issue versions run outside `transactionSync` and have no actor or ownership rule. They are in `USER_WRITE_ROUTES`, so any `read_write` user token can restage any spec or issue. That makes the comment at `workers/api/principal.ts:258` ("The DO still applies its own rules ... on every route") false for these two.
- History: m1 code. Only the candidate path was wrapped later (PR-S).
- Fix: one transaction; `WHERE id = ? AND deleted_at IS NULL`; a 404 before any write; a 400 for an invalid stage; and either an author-or-maintainer rule or a corrected comment.

**S3. `POST /api/gate-verdicts` accepts a tombstoned candidate.** (`createGateVerdict :1871`; probed: 201)
- If a verdict is written between the purge plan and its batch, the purge's `DELETE FROM candidates` then fails on the foreign key.
- That fails closed, but it surfaces as a partial "stopped after N batches" purge.
- Fix: require a live candidate.

**S4. `deployCanary` accepts ids not in the ledger, and a candidate filed under another spec.** (`:3615-3622`; probed)
- Probe: candidate `ghost` with spec `ghost-spec` got 201 and became a live canary head. So did a real candidate under a different spec's id.
- Then `/deploy-refs/live` hands the shadow router a target that is not a candidate, and the 60-second alarm chain stays armed until someone rolls it back.
- This was deliberate ("Ids need no ledger row"). Only a tier-1 token can reach it, so it is an integrity risk, not a privilege one.
- Fix: require a live candidate whose `spec_id` matches `request.specId`.
- See also b1 M1 and the map's missing stage precondition.

**S5. `claimSpec` writes after an `await`, outside any transaction.** (`:1788-1853`)
- The flow: read the spec, await `createFork` (other requests can run in between), then insert repository, candidate and history as three separate statements.
- Inferred:
  - When `agentId` is not an actor, the fork is created, the repository insert fails on the foreign key, and a retry meets the existing fork.
  - A spec tombstoned during the fork still gets a live candidate.
- Fix: validate the actor before the fork, then re-read the spec and do the inserts in one `transactionSync`.

**S6. `POST /api/repositories` takes `organizationId`, `namespace` and `remoteUrl` from the body unchecked.** (`createRepository :6061`; open to user tokens)
- `startGateRun` says the repo and namespace "come from the ledger, never from the caller" (`:5352`), but the ledger value was supplied by a caller.
- Inferred: a user token can register a repository row naming any Artifacts namespace. preview-manager (`:360`) or the gate would then build it with the platform token.
- Inferred: a duplicate `remote_url` can shadow the real row in queue-consumer's newest-first `.find` (`:153`).
- Fix: for callers other than master, require the namespace to equal the organization's name, and reject a duplicate `remote_url`.

**S7. Entity-miss 404s on the m1 routes carry no `code`.**
- So they cannot be told apart from the router's fall-through 404 (`:4925`). Callers such as `scientist-comparator/storage/spec-do.ts:113` and `preview-manager/index.ts:362` cannot apply the "a 404 is never empty" rule.
- `/internal/service-tokens/verify` answers 404 for an unknown token (`:2597`), and the edge maps that to 401 (`workers/api/principal.ts:179`). The user-token route was built to avoid exactly this.
- Fix: add a code to the record-miss 404s, and make service verify answer 200 `{found:false}` when the caller opts in.

**S8. Tier 1 covers the whole promotion spine.**
- `isAdminRoute` protects lifecycle, tokens and `promotion-authority`, but `promotion_authority` is enforced nowhere (`workers/shared/principal.ts:36`).
- Any of the nine tier-1 holders can write a `pass` verdict, call `advance`, set any stage, move deploy refs, set the promotion mode and set any trust score. Probe: `PATCH /api/actors/:id/trust` accepted 1e9, and answered 200 `data:null` for an unknown actor.
- `X-Actor-ID` from a tier-1 holder is a free string. A maintainer's id gets only `include_deleted` reads and issue moderation; purge, roles and tokens need tier 2, which is correct.
- sandbox-runner and candidate-service bind `SPEC_DO`, and the runner never uses it.
- Fix: drop unused bindings and tokens. Consider putting `advance`, the stage PATCH and deploy-ref writes behind a second token that only the promotion and canary workers hold.

**S9. The purge's re-check between batches has no test.** (`deleteBatch :2837`)
- Removing it left all 1523 tests passing.
- Fix: add a test that writes a promotion state for a tombstoned candidate between two batches.

## Nits

- N1: a keyed shadow-sample request writes an `idempotency_keys` row (24-hour TTL) even when the sample is over the cap (`:5165-5170`).
- N2: a fresh init runs `GATE_RUNS_SQL`, not the idempotent `applyGateRuns()` (`:741`). It is correct today only because of the base table's columns.
- N3 (inferred): stored rows are re-parsed with strict zod on every read (`:3333`, `:3221`). One row with a new enum value, written by a newer build, would turn every list for that spec into a 500 after a rollback. The rollback-floor note in OPS covers tables, not JSON contents.
- N4: `transitionCandidate` with an unknown id still writes a history row (documented at `:1653`).
- N5: `approvals`, `change_classifications` and `intent_provenance` are not in `ORG_PURGE_ORDER`. Add them when they get writers.
- N6: POST returns camelCase while GET returns snake_case for repositories and specs. queue-consumer works around it with `c.repositoryId || c.repository_id`.

## Verified correct

- **Auth gate:** runs before routing and before the schema is touched; fails closed with 503/401/403; constant-time compare.
- **Migrations:**
  - Every step is idempotent. A failed step unsets `db` and rethrows, and an unknown version throws.
  - The rollback floor still serves an m99 ledger.
  - The m12 step refuses on duplicates without deleting anything.
  - `schema.sql` equals the inline copy byte for byte (a test checks this).
- **Idempotency:** the lookup, the mutation and the key insert share one transaction. The same key with a different body gets 409. Expiry is honoured. The scope is actor + method + path.
- **CAS:** the version and `X-Expected-Head` checks hold, and `advance` runs in one transaction.
- **Purge:**
  - The maintainer, confirm, age and reserved-org guards all hold.
  - The edge deletes candidate Workers first and aborts on any failure.
  - Tombstoning refuses a live deploy head.
- **Tokens:** revoked, expired, tombstoned-org, maintainer-cap, scope-needs-role and service-actor checks all hold.
- **SQL:** no user input is concatenated into SQL.

## Known items re-checked

- **2026-10-26 (delta surface):** still true for casing. The DO returns `declared_delta_surface` and the comparator reads `declaredDeltaSurface`. The envelope part is fixed.
- **2026-11-07 (invalid create bodies give 500s):** still true. S2 adds the stage routes to the same class.
- **2026-11-02 (a repeated rollback can reach a tombstoned or purged candidate):** still true. `rollbackTarget` (`:3896`) checks neither, and purge keeps `deploy_refs`.
- **2026-10-17 (master can assert any actor):** still true, and documented.
- **Map, `deployCanary` with no stage check:** confirmed. S4 extends it.

## What was run

- `npx vitest run workers/spec-do`: 978 of 978 passed.
- `npm run typecheck`: clean.
- A 5-case probe in a scratch worktree.
- 26 test-breaking edits across spec-do, shared and api (1523 tests): 25 caught by a test, 1 not (S9).
- Not run: e2e, `wrangler dev`, anything on the network. S5, S6 and N3 come from reading the code only.
