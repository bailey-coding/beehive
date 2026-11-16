---
category: audit
status: active
audience: human,agent
---

# Review, slice c: shadow and canary evidence (2026-11-16)

Step 2 of the whole-repo review (context: `docs/reviews/2026-11-15-architecture-map.md`).

- An independent Fable agent made a read-only pass at `a45bb04`. Its probe ran the comparator against the real Spec DO on node:sqlite in a scratch worktree.
- The orchestrator confirmed M1: `scientist-comparator/index.ts:224` reads `spec.declaredDeltaSurface`, but `storage/spec-do.ts:125` returns the raw Spec DO
  object, whose field is `declared_delta_surface` (`spec-do/index.ts:2306`). The candidate's `specId` is camelCase (`:2340`), so the spec lookup does happen.
- This review complements b1-M1 (the canary rung reads no SLO result). No finding is fixed yet.

**Verdict: request changes.** The safety side is sound: the sanitized descriptor, the header allowlists, the loop guard, URL pinning, per-message ack and retry,
idempotent samples, and a pure ref rollback. The evidence side is not:
- Against a real ledger, the comparator records no sample at all (M1, probed).
- A `healthy` SLO verdict says almost nothing about the candidate (M2). So wiring it into `advance(full)`, as b1-M1 proposes, would not make the canary rung real.

## Must-fix

**M1. The comparator drops every comparison for a candidate whose spec is in the ledger.** (`workers/scientist-comparator/index.ts:207-224`)
- The comparator fills `specId` from the ledger candidate, reads the spec, then calls `parseDeltaSurface(spec.declaredDeltaSurface)`.
- That field is `undefined`, the parser throws, and the throw is not a `SpecDoTransientError`. So the message is acked and never retried (`:138-139`).
- Probe (real org, spec and candidate; one message): the log showed `failed and will not be retried: Error: Delta surface must be an object, got undefined`. Ack 1, retry 0, no `shadow_scores` row, no Analytics Engine write.
- **Consequence:** no canary candidate can get a shadow sample or verdict in production, so the tournament score and the production-only switches have no data.
- **Why the tests miss it:** the fake in `tests/queue-samples.test.ts:43` answers 404 for every spec, which picks the default surface.
- **History:** known since OPEN-QUESTIONS 2026-10-26 ("code read, not run"). PR A (`b10b851`, 2026-11-10) added the ledger `specId` lookup. That turned a hidden mismatch into a total loss: before it, `specId` stayed `''` and the default surface was used.
- **Even with the field name fixed,** the stored value is a JSON array of strings (`workers/shared/schemas.ts:138`), which the parser also rejects.
- **Relation to the 2026-11-12 check:** this is a second reason "no sample was scored". Inferred: that check never got this far, because there was no live canary.
- **Fix:**
  - On a missing or unparseable surface, fall back to `getDefaultDeltaSurface()` and log once per spec.
  - Agree one stored shape.
  - Add a comparator test against the real Spec DO.

**M2. The SLO side of b1-M1: `healthy` is not evidence, and nothing records a verdict.** (`workers/canary-worker/slo.ts:117-152`, `shadow-router/canary-recorder.ts:50`, `shadow-router/index.ts:278-293`)
- **What is measured:** only mirrored GET/HEAD requests to the platform's own routes, sent with templated paths. Only a 5xx counts as an error. A candidate
  whose real route returns 500 on every call answers 404 to all mirrored paths, and gets 0% errors and `healthy`.
- **Volume:**
  - Samples are thinned first by `MIRROR_SAMPLE_PERCENT`, then by a random draw against `trafficPercentage`.
  - At 5%, a canary needs about 1,000 mirrored requests within 15 minutes to reach `CANARY_SLO_MIN_REQUESTS` = 50.
  - So `insufficient_data` is the normal, permanent state. If `advance(full)` required `healthy`, nothing could promote; today everything promotes on the timer.
- **No durable verdict:** the thresholds live in canary-worker vars, and verdicts exist only in a `console.log` (`slo.ts:179`). The Spec DO stores the
  metrics but cannot judge them. A `violation` with auto-rollback off leaves no ledger trace.
- **The switch:** anyone with the shared bearer can turn auto-rollback off, either with `autoRollback: false` at deploy or with `POST /canary/:id/auto-rollback`.
  `setCanaryAutoRollback` (`spec-do/index.ts:3804`) records no actor and no history.
- **One error trips a rollback:** at the 50-request minimum with a 1% SLO, a single 5xx rolls the canary back. A router-side fetch failure or timeout counts as a candidate 500.
- **Fix,** planned together with b1-M1:
  - Move the thresholds and the verdict function to `workers/shared/deploy-refs.ts`, so the Spec DO computes the verdict inside the `advance` transaction.
  - Count every mirrored request for the live canary, regardless of `trafficPercentage`, or state a minimum the traffic can actually reach.
  - Decide what a 404 on a spec-declared path means.
  - Record auto-rollback changes with the actor.

## Should-fix

**S1. The SLO tick chain can stop while a canary is live.** (`spec-do/index.ts:3669-3686, 3655, 4126`)
- **How it stops:** if `init()` or `liveRefs('canary')` throws once in `alarm()`, nothing re-arms the alarm. A test pins this on purpose, to avoid an
  endless chain while idle. The cause can be permanent: one bad row fails zod on every read.
- **What restarts it:** only a canary deploy or a cold `init`, and the busy `main` instance is rarely cold.
- **Then:** no ticks, no rollback, and `advance(full)` passes after 15 minutes. Separately, a missing `CANARY_SLO_TICKS` binding is a silent no-op.
- **Fix:** re-arm with a longer backoff on a read failure, arm the alarm from the router's frequent `/deploy-refs/live` read, and log a missing binding.

**S2. The response-header allowlists have no test.** (`shadow-router/index.ts:503, 422`)
- Replacing `scientistSafeResponseHeaders(...)` with `Object.fromEntries(headers)` at either site left all 328 tests passing.
- A reverted allowlist would persist a candidate's `set-cookie` or arbitrary headers into the queue and then into Analytics Engine.
- **Fix:** have the candidate and the baseline answer with `set-cookie` and a 5,000-character `etag`, and assert the queued message.

**S3. Header values chosen by the candidate reach Analytics Engine.** (`scientist-comparator/index.ts:396-407`, `storage/analytics.ts:168-170`)
- Header diffs carry `baseline="…" candidate="…"`, and an `etag` is free text written by untrusted code. Each value is bounded to 200 characters.
- The ledger sample correctly keeps only `{type, severity}`.
- **Fix:** write the same reduced diffs to Analytics Engine.

**S4. Analytics Engine payloads are malformed in the comparator, the canary worker and the router's `logTrafficSplit` (inferred).** (`storage/analytics.ts:190-194`, `canary-worker/canary.ts:127-133`, `rollback.ts:74-80`, `shadow-router/index.ts:174-182`)
- They pass arrays of objects where the API takes strings and numbers.
- Known only for the canary worker (2026-10-16). Nothing reads Analytics Engine, so the record of comparisons and rollbacks is unusable.
- **Fix:** together with S3.

**S5. `fetchCandidate` never cancels the candidate's response body.** (`shadow-router/index.ts:372-391`)
- The timeout is cleared once headers arrive, so a candidate that streams forever holds a connection for each mirrored request.
- **Fix:** `void response.body?.cancel()` after reading the status and headers.

**S6. `rollbackThreshold` in `POST /deploy-canary` is accepted and ignored.** (`canary-worker/types.ts:23-26`, `canary.ts:69-80`)
- **Fix:** reject the field or implement it.

**S7. The `ScientistQueueMessage` contract is two hand-written interfaces with no runtime check.** (`shadow-router/index.ts:434-463`, `scientist-comparator/types.ts:17-36`)
- **Drift today** is harmless, and both old and new peers degrade safely: an absent `kind` is treated as a placeholder.
- **The existing `ScientistQueueMessageSchema`** is unused, and would reject every real message.
- **A malformed message** becomes a `TypeError` and is acked.
- **Fix:** one shared zod schema that the consumer parses; delete the dead one.

## Nits

- `/slo-status` answers `healthy: true` when there are no canaries, or when every canary is `insufficient_data` or `unavailable`. It should report `no_verdict`.
- Neither the fan-out to every live canary nor the per-canary SLO reads has a cap.
- On the non-`/mirror` path, a chunked body is read in full before the size cap applies, even in mode `none`. Removing the cap after the read left all tests passing.
- `isAcceptableCanaryUrl` accepts a path, query or fragment, which the router then appends the template to.
- `runCycle` looks the live canary up again by candidate before rolling back (`rollback.ts:26`). A redeploy in between would roll back the new deployment. Use `rollbackCanary(d.deploymentId)`.
- The preview queue is picked by a `preview-` substring of the candidate id (`index.ts:526`). Ledger UUIDs never match, so this routing is dead.
- `/statsig/*` does nothing and has an unanchored regex (`index.ts:727`).
- A JSON `null` body to `/deploy-canary` gives a 500.
- `getShadowConfig` detects local versus production from `process.env` (`index.ts:56-57`); that should be a var.

## Contracts verified correct

- **Mirror descriptor:**
  - The edge sends only `{v, method, path}`. The router re-templates with its own word list.
  - A test keeps the edge and router word lists in sync.
  - The comparator holds no word list.
- **Loop guard:** the marker header is set on both the candidate and the baseline fetch, and the edge skips marked requests.
- **Samples:** keyed `<requestId>:<candidateId>`, one per key. A 404 with a code is told apart from one without. 4xx is acked, 5xx retried with backoff.
- **`/canary-metrics`, `/deploy-refs`:** one shared schema. A non-OK answer is `unavailable`, never healthy. The workers.dev check runs in both the Spec DO and the router.
- **`/api/preview/canary`:** `url`, `versionId` and `Response.ok` are all checked.
- **Rule 7:** a rollback is one transaction with no redeploy, and the router follows it within 5-10 seconds.
- **`Response.ok`:** checked on every fetch in the slice.
- **Fake timers:** advances alternate with macrotask turns, as the AGENTS.md rule requires.

## Known items re-checked

| Item | Still true? |
|---|---|
| 2026-10-26: the delta-surface check cannot work for a stored spec | Yes, and now worse (M1). Its point 3 is out of date: the handler now acks explicitly. |
| 2026-10-16: the canary worker's Analytics Engine payload | Yes, and wider than recorded (S4). |
| 2026-11-10: the shadow rung cannot be enforced | Yes. `passed_premerge` candidates are still not mirrored. |
| 2026-11-02: a rollback can walk to a tombstoned candidate | Yes. |
| 2026-11-01: rollback ping-pong (D2) | Fixed; a test against the real DO passes. |
| 2026-10-25: tail flush of a burst | Fixed and tested. |
| Map: `canary-rollback-triggers` has no producer | Yes. Its handler would also fail on object bodies. |
| FOCUS 2026-11-12: router -> queue -> comparator never exercised end to end | Yes. M1 means it would have failed anyway. |

## What was run

- `npx vitest run workers/shadow-router workers/scientist-comparator workers/canary-worker`: 233 of 233 passed.
- `npm run typecheck`: clean.
- One probe of the comparator against the real Spec DO.
- 30 test-breaking edits (328 tests): 27 caught by a test, 3 not (S2 twice, plus the body-cap nit).
- Not run: e2e, any worker, the network, workerd. S4 and the `process.env` note come from reading the code.
