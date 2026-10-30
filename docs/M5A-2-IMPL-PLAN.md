---
category: planning
status: reviewed-revised
milestone: m5a-2
audience: human,agent
tags:
  - spine-work
  - plan
---

# M5a-2 plan, part 1: close the idempotency gaps (edge key, queue consumer)

**Date:** 2026-10-30 | **Tier:** heavy | **Spine:** yes (AGENTS.md rule 2): this plan needs an independent agent review before any code, and the implementation needs another before merge. | **Source:** `docs/M5A-AUDIT.md` findings 1 and 2, `docs/MILESTONES.md` M5a-2.

**Review:** two independent agent reviews on 2026-10-30. Pass 1: approve with changes (2 blockers, 9 should-fixes, folded in as R1-R16). Pass 2: approve with changes (no blockers, 8 should-fixes, folded in as S1-S10); the reviewer said no third round is needed if these edits land. Implementation may start.

Scope is only the first two M5a-2 bullets plus the 409 handling. The unkeyed-route wiring and the governance migration are separate plans (see Out of scope).

## Facts this plan rests on (checked 2026-10-30, corrected by review)

- `sendToSpecDo` (`workers/api/index.ts:460-476`) builds headers from scratch (`Content-Type`, `X-Actor-ID`). It has 43 call sites plus the definition (R-nit).
- The Spec DO keys 9 routes (`workers/spec-do/index.ts:38-42`); the header is ignored elsewhere. **The edge exposes only 8 of them as POST** (organizations, actors, repositories, specs, candidates, gate-verdicts, trials, promotions). Entity history is GET-only at the edge (`index.ts:343`, `:1934`), so it is reached only by direct DO callers (R1).
- The Spec DO scopes a key by `[actorId, method, path, key]` (`spec-do/index.ts:3517`); a replay returns the stored status plus `Idempotent-Replay: true`; the same key with a different body is 409.
- Queue consumer: per-message `try/catch`, every failure `continue`s, no `retry()`/`ack()`; `queue-consumer/wrangler.toml` sets no `max_retries` or dead-letter queue. Cloudflare's default `max_retries` is 3, after which an un-DLQ'd message is dropped; `message.attempts` starts at 1 (R8).
- Gate worker `handleStartPreMergeGate` (`gate-workflow/index.ts:196`): random `verdictId` (`:205`); sets its in-memory `workflows` entry to `running` (`:209`) and to `complete` (`:260`) **before** `recordGateVerdict` (`:266`); `recordGateVerdict` (`:850-874`) ignores the DO response; every error is a 500 (`:277`) (R2, R3).
- The DO's `createGateVerdict` generates its own row id; `verdictId` is only the gate worker's workflow handle (status/result lookups). Its readers are the gate's own handlers and tests, all treating it as opaque (R12).

## Changes, file by file

### 1. `workers/api/index.ts`, forward the key (R1, R10)

- Add optional `idempotencyKey?: string` as a fifth parameter of `sendToSpecDo`; when set, send `Idempotency-Key`. The other call sites are unchanged. The authed stub wrappers rebuild requests but keep headers (`shared/spec-do-auth.ts:149-155`).
- One helper `idemKey(request): string | Response | undefined` reads the header and returns a 400 (same body shape as the DO's) over 255 characters, then the **8** keyed POST handlers pass the result through. History is not wired at the edge.
- Collision analysis: the consumer's history key lives at `POST /api/entities/candidate/<id>/history`, which the edge does not expose, and the scope includes the path, so no edge client can hit the consumer's key space even with a master token asserting `X-Actor-ID: queue-consumer`. Service and user tokens have the actor overwritten (`index.ts:106-112`). An edge client reusing a key with a different body gets the DO's 409.

### 2. `workers/queue-consumer/index.ts`, retry, classify, bound (R4-R9, R11)

Classification (every exit; `retry({ delaySeconds })` with `min(30 * 2^(attempts-1), 900)` seconds; `const attempts = message.attempts ?? 1` so the existing mocks, which have only `retryCount`, still run) (S3-S6):

| Exit | Class | Action |
|---|---|---|
| Message fails Zod validation | permanent | `validateQueueMessage` throws a typed `ValidationError` (today a plain `Error`, `queue-consumer/index.ts:96`); error log, ack |
| Repos/candidates lookup or gate answers 5xx, 408, 429, **401, 403** | transient | retry (401/403 are bearer or token misconfig, recoverable) |
| Same, answers 400, 404, 409 (not in-flight), 413, 422 | permanent | error log, ack |
| No repository, no candidate | **transient to the cap**, then ack with an error log | the push can arrive before the DO row exists; an unrelated repo costs about 5 cheap retries. The `limit=100` truncation is the one case a retry cannot fix: follow-up, logged |
| `API_AUTH_TOKEN` unset | transient, delay at most 12 h | recoverable config |
| Gate answers 409 with `{inFlight:true}` | transient, short delay | the first run is still going; do not ack a duplicate while history is unwritten |
| `reposResp.json()` / `gateResponse.json()` throws, `fetch` throws, any non-`ValidationError` in the catch (including a bug TypeError) | transient | retry, bounded by the cap; safe because a gate replay returns the recorded result. This is a behavior change from today |
| `triggerPreviewDeployment` throws out of its unguarded `specDoStub.fetch` calls (`:132`, `:155`) | best effort | wrap so a preview failure never reaches `retry()`; log |
| History write 5xx | transient | retry |
| History write 400 | permanent | keep keys short: hash `${queueName}:${event.id}` only when over 200 characters, as `h1:<sha256 hex>`, then append `:gate` for the gate key; both stay at most 255 |
| History write 409 | permanent | log "key reused with a different body", ack; replace the wrong comment |
| Replay (201 + `Idempotent-Replay`, or gate 200 replay) | success | continue; `.ok` covers both |

- Order stays gate then history (already the current order); both are keyed so a retry converges (R12). The gate request carries `Idempotency-Key: ${queueName}:${event.id}:gate`.
- Keep the per-message `try/catch`: a throw out of `queue()` would retry the whole batch including handled messages (R9). The catch block now splits `ValidationError` (ack) from everything else (retry).
- Cap (S6): set `max_retries = 4` and `retry_delay` on **all three** `[[queues.consumers]]` blocks of `wrangler.toml` (`beehive-artifacts-push`, `preview-artifacts-push`, `preview-artifacts-events`); a message gets 1 + 4 deliveries. The in-code give-up at `attempts >= 5` (error log, ack) and the config agree. The config is the backstop for whole-invocation failures. With no DLQ an exhausted message is deleted; a dead-letter queue stays a follow-up. Additive config.
- Preview path (R7): `triggerPreviewDeployment` swallows its own failures and has no key, so redelivery would fire duplicate Workers Builds. Run it only when `message.attempts === 1`; document preview as best-effort.

### 3. `workers/gate-workflow/index.ts`, dedupe without poisoning (R1-R4, R12)

- With an `Idempotency-Key`, derive `verdictId = verdict-premerge-<first 32 hex of SHA-256(key)>`; without it, unchanged. `verdictId` is the workflow handle only, not the DO row id.
- **Fix the poisoning:** delete the `workflows` entry in the `catch`. Mark an entry `recorded` only after `recordGateVerdict` succeeds. A repeat start with the same key replays (200 + `Idempotent-Replay`) only for a `recorded` entry whose request-body hash matches (S2: a different candidate under the same key must not replay another result); a `running` entry answers 409 with `{inFlight:true}`, not 200, and a `running` entry older than 120 s is treated as absent (a hung run never reaches the `catch`). The map is an optimization; the DO key is the real guard and a new isolate re-runs the gate once (cost stated).
- **`recordGateVerdict` checks `response.ok` and throws on non-2xx** (AGENTS.md `Response.ok` rule). A replay counts as ok; a 409 surfaces as an error. It forwards the `Idempotency-Key` on `POST /api/gate-verdicts`. **The determinism claim was false (S1):** `validateSpecConformance` adds a warning with `Math.random() < 0.1` (`gate-workflow/index.ts:789`), so a re-run can produce a different body and the DO answers 409. Resolution: on a DO 409 for `/api/gate-verdicts`, `recordGateVerdict` treats the verdict as already recorded (the first write is authoritative for the key), marks the entry `recorded`, and logs the body difference; it does not throw. Seeding the simulated warning from `candidateId + commitSha` is optional and out of scope. No determinism-pinning test.
- Error codes (S8): Zod failure returns 400; a missing spec returns 404 by propagating `specResponse.status` (today a generic `Error`, `:239-241`); everything else 500. A fresh run answers 201, a map replay 200 + `Idempotent-Replay`.
- Other callers: `spec-do/index.ts:4349` posts to `/gates/pre-merge` with no key and keeps the random id, intentionally unchanged; `promotion-worker/merge-train.ts:342` calls `GATE_WORKFLOW.fetch('/run')` with a relative URL; the gate has no `/run` route, so that call already 404s and is unaffected. Log it in `docs/OPEN-QUESTIONS.md`, do not fix it here (S9).

### 4. Tests

- Edge: same key twice on a keyed route replays with `Idempotent-Replay`; same key on two different routes does not replay across them; an unkeyed route ignores the header; a 256-character key is 400 with no DO call.
- Queue consumer (S7): add a `makeMessage()` helper (`attempts`, `retry`, `ack` as `vi.fn()`) and migrate the ~15 literals in `workers/queue-consumer/tests/queue.test.ts` (754 lines; they are `{id, body, timestamp, retryCount: 0}`); the invalid-message test at `:253-257` becomes "acks". Then: transient 5xx retries, 4xx and validation ack, thrown fetch retries, attempt cap gives up, a redelivery sends the same gate key and history key, a 409 is logged and acked, an `inFlight` 409 and a 401 retry, no-repo retries to the cap then acks, preview runs only at `attempts === 1` and its throw never retries, unset token retries, and no message gets both `retry` and `ack` called.
- Gate: gate throws once then succeeds under one key and the second call runs; `recordGateVerdict` fails then succeeds; `recordGateVerdict` non-OK throws; a DO 409 marks the entry `recorded` without throwing; same key yields one DO row via the DO key; a stale `running` entry is ignored; a different body under the same key does not replay; no key yields a random id; Zod failure is 400 and missing spec is 404.
- Run `npm run typecheck`, the three workers' unit tests and `workers/spec-do/tests/idempotency.test.ts`.

### 5. Docs

`docs/OPS.md` (edge key, retry cap, `max_retries`), then on merge tick the two M5a-2 bullets in `docs/MILESTONES.md` and `docs/FOCUS.md`, and mark `docs/M5A-AUDIT.md` findings 1 and 2 fixed.

## Mixed-version window (one push deploys all ten workers)

- Edge new / DO old, edge old / DO new: unchanged from today.
- Queue consumer new / gate old: the gate ignores the header and mints a random id, so retries can re-run the gate. **Bounded duplicate gate runs, at most the retry cap**, until the gate deploys (not "no worse than today": today there is no retry) (R15).
- Queue consumer old / gate new: no key, random id, as today.
- `max_retries` in `wrangler.toml` is additive config. Rolling back to the old consumer stops retries, which is safe.
- New gate / old DO: unaffected, `/api/gate-verdicts` has been keyed since m10 (`spec-do/index.ts:40`).
- No schema change, so no migration ordering.

## Risks

1. Retry storms: bounded by `max_retries = 5` and the attempts cap; exhausted messages are dropped and logged at error.
2. Behavior change on bad data: messages once silently acked now retry; the classification table is the control.
3. Gate dedupe is per event key, not per commit: two events for one commit run twice (acceptable).
4. A client may believe an unkeyed route is protected: the edge test pins the ignore behavior; the unkeyed-route plan resolves it.
5. The gate now answers 500 where it answered 201 when the DO verdict write fails; the other caller, `spec-do/index.ts:4349`, checks `gateResponse.ok` and will see the failure. Intended (S8).
6. Poisoned in-memory entry: fixed by deleting on failure and replaying only `recorded` entries (R1).

## Out of scope (own plans)

Keying the other ~16 mutation routes, the governance migration, change-type classification and the two-person rule; the `limit=100` lookups; a durable gate `workflows` map; a dead-letter queue.

## Review asks for the second pass

1. Does the revised gate worker (delete on failure, `recorded` only after a confirmed DO write, 409 for in-flight) converge for every failure combination?
2. Is the classification table complete against the final code?
3. Is `max_retries = 5` plus the `attempts >= 5` give-up consistent with the queue's delivery counting?
