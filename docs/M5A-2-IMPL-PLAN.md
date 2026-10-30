---
category: planning
status: draft
milestone: m5a-2
audience: human,agent
tags:
  - spine-work
  - plan
---

# M5a-2 plan, part 1: close the idempotency gaps (edge key, queue consumer)

**Date:** 2026-10-30 | **Tier:** heavy | **Spine:** yes (AGENTS.md rule 2): this plan needs an independent agent review before any code, and the implementation needs another before merge. | **Source:** `docs/M5A-AUDIT.md` findings 1 and 2, `docs/MILESTONES.md` M5a-2.

Scope is only the first two M5a-2 bullets plus the 409 handling. The unkeyed-route wiring and the governance migration are separate plans (see Out of scope).

## Facts this plan rests on (checked 2026-10-30)

- `sendToSpecDo` (`workers/api/index.ts:460-476`) builds headers from scratch: `Content-Type` and `X-Actor-ID`. It has 44 call sites and no access to the incoming request.
- The Spec DO keys 9 routes (`workers/spec-do/index.ts:38-42`). The header is ignored on every other route, so forwarding it everywhere is safe.
- The queue consumer (`workers/queue-consumer/index.ts`) runs, per message: lookup of repos and candidates (`limit=100`), then a `POST /gates/pre-merge` to the gate workflow, then a keyed history write. Every failure path `continue`s inside a per-message `try/catch`, so the batch returns normally and every message is acked. `message.retry()` is never called.
- `handleStartPreMergeGate` (`workers/gate-workflow/index.ts:196`) mints a fresh random `verdict-premerge-${generateId()}` per request, so a redelivery starts a second gate run.
- The Spec DO's keyed replay returns the stored status (201) with `Idempotent-Replay: true`; a 409 means the same key with a different body.
- `wrangler.toml` for the queue consumer sets no `max_retries` or `dead_letter_queue`.

## Changes, file by file

### 1. `workers/api/index.ts` — forward the key

- Add an optional `idempotencyKey?: string` as a fifth parameter of `sendToSpecDo`; when set, add `Idempotency-Key`. Existing 44 call sites stay valid.
- At the 9 POST handlers whose DO route is keyed (organizations, actors, repositories, specs, candidates, gate-verdicts, trials, promotions, entity history) read `request.headers.get('Idempotency-Key')` and pass it through. Handlers already receive the typed request, so no signature change.
- Reject keys over 255 characters at the edge with 400 (same limit as the DO), so the client sees the error before a DO round trip.
- The Spec DO scopes the key by actor, method and path, so an edge client cannot replay across actors. No change to the DO.

### 2. `workers/queue-consumer/index.ts` — retry, dedupe, 409

- Classify each early exit as **permanent** (no repository, no candidate, `API_AUTH_TOKEN` unset, malformed message: log and ack, as today) or **transient** (a Spec DO lookup answers non-OK, gate workflow answers non-OK, history write fails with anything but a replay): call `message.retry({ delaySeconds })` with capped exponential backoff on `message.attempts`.
- Send `Idempotency-Key: ${queueName}:${event.id}:gate` on the gate request. The existing history key stays as is.
- Order: gate trigger first (keyed, see section 3), history write second (keyed). Both are safe to repeat, so a retry after a failure at either step converges: a redelivery re-sends the gate request, which the gate worker dedupes, then re-sends the history write, which the Spec DO replays.
- On a 409 from the history write, log `[QueueConsumer] idempotency key reused with a different body` with the event id and ack (retrying cannot fix it). Replace the "409 means already processed" comment.
- Do not restructure the lookups (the `limit=100` weakness is noted in Out of scope).

### 3. `workers/gate-workflow/index.ts` — dedupe the gate start

- In `handleStartPreMergeGate`, if an `Idempotency-Key` header is present, derive `verdictId = verdict-premerge-<first 24 hex of SHA-256(key)>` instead of a random id; otherwise unchanged. Add the same header to the downstream `POST /api/gate-verdicts` so the Spec DO's keyed route also dedupes.
- If a workflow with that id is already in the in-memory `workflows` map, return its stored response with 200 and `Idempotent-Replay: true`. Note: that map is per isolate, so after an isolate restart the DO-level key is the real guard. Do not widen the PR to make the map durable.

### 4. Tests

- `workers/api/tests/`: a POST to a keyed route with `Idempotency-Key` twice returns the same body and the second carries `Idempotent-Replay`; an unkeyed route ignores the header; a 256-character key is 400 with no DO call.
- `workers/queue-consumer/tests/queue.test.ts`: transient DO failure calls `retry`; permanent skip acks; a redelivered event leaves one gate request body keyed identically and one history row; a 409 is logged and acked.
- `workers/gate-workflow/tests/`: same key twice yields the same verdict id and one DO gate-verdict row; no key still yields a random id.
- Run: `npm run typecheck`, the three workers' unit tests, `workers/spec-do/tests/idempotency.test.ts`.

### 5. Docs

- `docs/OPS.md`: one line on `Idempotency-Key` at the edge and the queue retry behavior.
- `docs/MILESTONES.md` / `docs/FOCUS.md`: tick the first two M5a-2 bullets when merged.
- Update `docs/M5A-AUDIT.md` findings 1 and 2 to "fixed in <commit>".

## Mixed-version window (one push deploys all ten workers)

- Edge new, DO old: the DO already keys these routes and ignores the header elsewhere; an old DO simply behaves as today.
- Edge old, DO new: no header arrives; unchanged.
- Queue consumer new, gate workflow old: the gate ignores the extra header and mints a random id, so dedupe is lost until the gate deploys; correctness is no worse than today. The consumer's retry behavior is independent.
- Queue consumer old, gate workflow new: no key, random id, as today.
- No schema change, so no migration ordering.

## Risks

1. **Retry storms.** A poisoned message that fails transiently forever would retry until the queue gives up. Mitigation: cap by `message.attempts` (give up and ack after 5, log loudly) and set `max_retries = 5` plus a `dead_letter_queue` in `wrangler.toml` (the DLQ name needs the maintainer to create it; if it does not exist the deploy fails, so create it before the push or leave `dead_letter_queue` out and rely on the attempts cap). This plan uses the attempts cap only and lists the DLQ as a follow-up.
2. **Behavior change on bad data.** Messages that used to be silently acked will now retry up to the cap. The permanent/transient split above is the control; the review should challenge each classification.
3. **Gate dedupe by key, not by commit.** Two different events for the same commit run twice. Acceptable: dedupe here is for redelivery, not for equal-content pushes.
4. **Edge key reaches the DO on keyed routes only.** A client sending a key to an unkeyed route believes it is protected. The edge test pins the ignore behavior; the unkeyed-route plan resolves it.

## Out of scope (own plans)

- Keying the other ~16 mutation routes, the governance migration, change-type classification, the two-person rule.
- The `limit=100` repository and candidate lookups in the queue consumer (a push for the 101st repo or candidate is skipped silently).
- A durable `workflows` map in the gate worker; a dead-letter queue.

## Review asks

1. Is the gate-first, history-second order correct for every failure combination?
2. Is each early exit in the queue consumer classified right (permanent versus transient)?
3. Does deriving the verdict id from the key break any reader that assumes the random format?
4. Anything in the mixed-version table that is wrong?
