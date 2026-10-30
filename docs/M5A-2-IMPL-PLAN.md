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

**Review:** independent agent review 2026-10-30 returned *approve with changes* (2 blockers, 9 should-fixes); every item is folded in below and marked R1-R16. Re-review the revised sections 2 and 3 before code.

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

Classification (every exit; `retry({ delaySeconds })` with exponential backoff, capped):

| Exit | Class | Action |
|---|---|---|
| Message fails Zod validation | permanent | error log, ack (typed `ValidationError`) |
| Repos or candidates lookup non-OK | 5xx/408/429 transient; other 4xx permanent | retry / error log, ack |
| No repository, no candidate | permanent | ack with an **error** log naming the push-before-row race and the `limit=100` truncation |
| `API_AUTH_TOKEN` unset | transient, long backoff | recoverable config; acking would lose the gate forever |
| Gate answers 5xx/408/429 or `fetch` throws | transient | retry |
| Gate answers other 4xx (bad data, missing spec) | permanent | error log, ack (needs section 3 codes) |
| History write 5xx | transient | retry |
| History write 400 | permanent | the key can be too long: hash `${queueName}:${event.id}` to a fixed length when it exceeds 200 characters |
| History write 409 | permanent | log "key reused with a different body", ack; replace the wrong comment |
| Replay (201 + `Idempotent-Replay`) | success | continue |

- Order stays gate then history (already the current order); both are keyed so a retry converges (R12). The gate request carries `Idempotency-Key: ${queueName}:${event.id}:gate`.
- Keep the per-message `try/catch`: a throw out of `queue()` would retry the whole batch including handled messages (R9). The catch block now splits `ValidationError` (ack) from everything else (retry).
- Cap: add `max_retries = 5` for the consumer in `wrangler.toml` (config only, no DLQ resource, additive) and give up at `message.attempts >= 5` with an error log; an exhausted message is dropped, which the doc states. A dead-letter queue stays a follow-up.
- Preview path (R7): `triggerPreviewDeployment` swallows its own failures and has no key, so redelivery would fire duplicate Workers Builds. Run it only when `message.attempts === 1`; document preview as best-effort.

### 3. `workers/gate-workflow/index.ts`, dedupe without poisoning (R1-R4, R12)

- With an `Idempotency-Key`, derive `verdictId = verdict-premerge-<first 32 hex of SHA-256(key)>`; without it, unchanged. `verdictId` is the workflow handle only, not the DO row id.
- **Fix the poisoning:** delete the `workflows` entry in the `catch`. Mark an entry `recorded` only after `recordGateVerdict` succeeds. A repeat start with the same key replays (200 + `Idempotent-Replay`) only for a `recorded` entry; a `running` entry answers 409 (in flight), not 200. The map is an optimization; the DO key is the real guard and a new isolate re-runs the gate once (cost stated).
- **`recordGateVerdict` checks `response.ok` and throws on non-2xx** (AGENTS.md `Response.ok` rule). A replay counts as ok; a 409 surfaces as an error. It forwards the `Idempotency-Key` on `POST /api/gate-verdicts`. The DO replays only for an identical body; `notes` and `score` are deterministic and no timestamps are sent, which a test pins.
- Error codes: Zod failure returns 400, missing spec 404, everything else 500, so the consumer can classify (section 2).
- Other callers: `spec-do/index.ts:4349` posts to `/gates/pre-merge` with no key and keeps the random id, intentionally unchanged; `promotion-worker/merge-train.ts:342` uses the gate binding, and the implementer confirms its path before merge.

### 4. Tests

- Edge: same key twice on a keyed route replays with `Idempotent-Replay`; same key on two different routes does not replay across them; an unkeyed route ignores the header; a 256-character key is 400 with no DO call.
- Queue consumer: add a `makeMessage()` helper with `retry`, `ack`, `attempts` and migrate the existing literals in `tests/queue.test.ts` (lines 124-706); then: transient 5xx retries, 4xx and validation ack, thrown fetch retries, attempt cap gives up, a redelivery sends the same gate key and history key, a 409 is logged and acked, preview runs only at `attempts === 1`, unset token retries.
- Gate: gate throws once then succeeds under one key and the second call runs; `recordGateVerdict` fails then succeeds; `recordGateVerdict` non-OK throws; same key yields one DO row via the DO key; no key yields a random id; Zod failure is 400 and missing spec is 404.
- Run `npm run typecheck`, the three workers' unit tests and `workers/spec-do/tests/idempotency.test.ts`.

### 5. Docs

`docs/OPS.md` (edge key, retry cap, `max_retries`), then on merge tick the two M5a-2 bullets in `docs/MILESTONES.md` and `docs/FOCUS.md`, and mark `docs/M5A-AUDIT.md` findings 1 and 2 fixed.

## Mixed-version window (one push deploys all ten workers)

- Edge new / DO old, edge old / DO new: unchanged from today.
- Queue consumer new / gate old: the gate ignores the header and mints a random id, so retries can re-run the gate. **Bounded duplicate gate runs, at most the retry cap**, until the gate deploys (not "no worse than today": today there is no retry) (R15).
- Queue consumer old / gate new: no key, random id, as today.
- `max_retries` in `wrangler.toml` is additive config. Rolling back to the old consumer stops retries, which is safe.
- No schema change, so no migration ordering.

## Risks

1. Retry storms: bounded by `max_retries = 5` and the attempts cap; exhausted messages are dropped and logged at error.
2. Behavior change on bad data: messages once silently acked now retry; the classification table is the control.
3. Gate dedupe is per event key, not per commit: two events for one commit run twice (acceptable).
4. A client may believe an unkeyed route is protected: the edge test pins the ignore behavior; the unkeyed-route plan resolves it.
5. Poisoned in-memory entry: fixed by deleting on failure and replaying only `recorded` entries (R1).

## Out of scope (own plans)

Keying the other ~16 mutation routes, the governance migration, change-type classification and the two-person rule; the `limit=100` lookups; a durable gate `workflows` map; a dead-letter queue.

## Review asks for the second pass

1. Does the revised gate worker (delete on failure, `recorded` only after a confirmed DO write, 409 for in-flight) converge for every failure combination?
2. Is the classification table complete against the final code?
3. Is `max_retries = 5` plus the `attempts >= 5` give-up consistent with the queue's delivery counting?
