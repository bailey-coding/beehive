---
category: planning
status: implemented (not deployed)
audience: human,agent
---

# M3 canary SLO loop (plan, 2026-10-24, revised after code review)

Closes the M3 gaps in `docs/FOCUS.md`: `SLOMonitor.getMetric` always returns 0 (`workers/canary-worker/slo.ts:67`),
`monitorAndTriggerRollback` has no caller, `sendRollbackTrigger` only logs (`workers/canary-worker/queues.ts`).
Spine-adjacent (promotion train, Spec DO schema): **a human approves this plan before any code lands.**

## Decisions (accepted 2026-10-24)

1. **Metric source: the Spec DO** (design b), not the Analytics Engine SQL API. A Worker binding can only write AE; reading
   it needs an account token and has ingestion lag. AE already holds raw per-candidate status and latency
   (`MetricsCollector.writeShadowMetrics`, `workers/shared/analytics.ts:128`) with no deployment id, which is why it stays
   telemetry. Designs (a) AE SQL and (c) both are a later investigation.
2. **Input today is shadow data.** Production canary traffic does not exist yet (canary deploys answer 501 until a Workers
   Versions client exists; the shadow router returns `200` and discards every candidate response, `workers/shadow-router/index.ts:678`).
   Samples are recorded with `source = 'shadow'`; the loop must not call them canary SLOs until `source = 'canary'` rows exist.
3. **Schema slot: `m11`** (maintainer decision 2026-10-24, nothing of M11 had started: M3 goes first, M11 renumbers to `m12` or
   later). One table per version step: this migration is never combined with M11's, whose UNIQUE index can throw on duplicates
   and cause a full outage (FOCUS). The rollback floor (push A) is live, so an older Spec DO serves over an `m11` ledger.
4. **Trigger: a `scheduled` cron on the canary worker**, every minute, using `DeployRefsClient.liveRefs('canary')` to list
   live canaries (it already returns `{ref, deployment}` with `autoRollback`). No queue producer.

## Rules this must keep (AGENTS.md)

- Coordination state lives in the Spec DO, transactional; AE keeps raw telemetry only.
- Rollback is a ref operation. A repeat is **benign, not a no-op by design**: `RollbackManager.triggerRollback` looks up
  `getLiveCanary` (status `deployed` only), so a second trigger returns 404 "Canary deployment not found", and the DO's own
  `rollbackCanary` answers 409. The cron treats 404 and 409 from rollback as success. Two overlapping crons are serialized
  by the DO's `transactionSync`.
- One push deploys all ten workers in no order: additive migration only. Mixed-version matrix (each must fail closed on action):
  - new shadow router + old DO: record answers 404, logged and swallowed, no effect on the router response;
  - old shadow router + new DO: no rows, below minimum sample, no verdict;
  - new canary cron + old DO: GET 404, `unavailable`, no rollback;
  - rollback B to A: `canary_metrics` sits idle (the rollback floor warns and skips a higher stored version).
- Check `Response.ok` AND parse the body (zod) on every DO call. The client drops the DO's error `code`
  (`DeployRefsClient.send`), so a record-not-found 404 and an old-DO unknown-path 404 look the same: **any non-ok is
  `unavailable`**. GET for an unknown deployment answers 200 with `requests: 0`, never 404.
- An unreadable metric is **no verdict** (never 0, never healthy-by-default, never a rollback).
- Env parsing fails closed: `slo.ts:36-37` uses `parseInt`/`parseFloat` on `CANARY_SLO_*`; unset or garbage gives `NaN`
  and `x > NaN` is false, so today the monitor reports healthy. Require `Number.isFinite`, defaults 1000 ms and 0.01
  (the `wrangler.toml` values), invalid config logs and yields no verdict. Same for the new `CANARY_SLO_MIN_REQUESTS`
  (optional field on `Env`, `types.ts`).

## File-by-file

**Shadow router** (`workers/shadow-router/`)
- `config.ts` `applyCanaryRefs` (~213-245) drops `deployment.id`; keep a `canaryDeployments: Map<candidateId, deploymentId>`
  (new field on `ShadowConfig`, `types.ts`). Static candidates (`beehive-main`, local ports) have no deployment: skip them.
- `index.ts`: record in the fetch handler right after `const candidateResponses = await fanOutToCandidates(...)` (~652),
  where `ctx` is in scope for `ctx.waitUntil` (it is not inside `fanOutToCandidates` or `fetchCandidate`). Latency there is
  time-to-headers; a transport failure is already a synthetic 500 (~326-335), so errors are visible.
- Write rate: one Spec DO write per mirrored request would load the global serialization point. Aggregate per
  `(deploymentId, minute)` in the isolate and flush on a short interval or at N samples (isolates recycle; losing a few
  shadow samples is acceptable). The recorder builds its own client (`specDoFetcher(env)`, ~60-65); `getShadowConfig`
  does not return one. Check `.ok`, log, never throw, never touch the response.
- The `LiveRefsCache` (5 s TTL, stale up to 2x) can attribute samples to a just-rolled-back deployment for ~10 s: the DO
  ingest ignores non-`deployed` deployments.
- **Sample size:** fan-out is thinned twice (top-level `defaultSplit`, 1% in production, then the deployment's
  `trafficPercentage`), and the hash is deterministic on `method:url`, so samples come from a fixed URL subset. The default
  minimum of 50 may rarely be reached in a minute: evaluate over a longer window (`sinceMinutes`, default 15) and document it.

**Spec DO** (`workers/spec-do/`)
- `schema-inline.ts`: new `CANARY_METRICS_SQL` appended after `IDEMPOTENCY_KEYS_SQL`. `schema.sql`: the same text appended
  last, byte-exact (`tests/schema-sync.test.ts` asserts the concatenation; update it).
- `index.ts`: import list, `LATEST_SCHEMA_VERSION`, `initSchema` (a fresh ledger needs the new section too), the steps array
  (the assertion at ~1040 requires the last step to equal latest).
- Table: `canary_metrics(deployment_id, minute_bucket, source, requests, errors, latency_sum_ms, latency_max_ms,
  latency_buckets)`, `UNIQUE(deployment_id, minute_bucket, source)`, upsert-add; fixed histogram buckets for p95.
  No foreign keys (like `canary_deployments`). The POST validates the deployment exists and is `deployed`, and caps
  buckets per deployment, because tier-1 is held by nine workers.
- **Placement:** `/canary-metrics` added to `DEPLOY_PATHS` / `DEPLOY_ROUTE` in `workers/shared/deploy-refs.ts` (the single
  source of paths, matched in `index.ts` ~3514), like the other deploy routes. (If `/internal/...` is chosen instead, add it to
  `TIER1_ROUTES` in `tests/internal-auth.test.ts`.) POST and GET are tier-1 only.
- Retention: prune rows older than 24 h on POST **and** on GET (traffic stopping must not leave stale rows).
- **Purge:** `canary_metrics` is deliberately NOT in `ORG_PURGE_ORDER`, same as `deploy_refs` and `canary_deployments`
  (no org column, no FK); `ledger-lifecycle.test.ts` pins the exact counts. Add a test that a ledger holding metrics rows
  purges cleanly.

**Shared client** (`workers/shared/deploy-refs.ts`): `recordCanaryMetrics()` / `canaryMetrics()` using the existing
`send(path, method, body, actorId, schema)` with zod schemas; non-ok or malformed body is `unavailable`.

**Canary worker** (`workers/canary-worker/`)
- `slo.ts`: per-deployment `checkSLOs` carrying the real `candidateId`/`specId` (today `'all'`, special-cased in
  `rollback.ts:28`); minimum-sample rule; finite-config rule above. `monitorAndTriggerRollback` (unreachable today) is the
  function the cron calls; remove any dead overload.
- `index.ts`: add `scheduled()` and extend the local `ExportedHandler` type (~124) with it, or the `satisfies` check fails;
  catch per deployment; await or `ctx.waitUntil`. `authGate` is fetch-only: do not use it in `scheduled`.
- `wrangler.toml`: `[triggers] crons = ["* * * * *"]` (one DO round trip per tick is intended). No new binding or secret.
- `queues.ts`: delete the log-only `sendRollbackTrigger` (referenced nowhere; check `tests/canary.test.ts` imports first).
  The queue consumer stays.

**Existing tests that pin the schema version** (all need the new latest): `tests/migrations.test.ts` (several, including
the `it.each(['m11','m12','m99'])` "newer than this code" cases at ~231, which become invalid once those versions exist: move
them above the new latest, and the "m10 ledger" helper becomes "previous-latest ledger"), `migration-legacy.test.ts`,
`ledger-lifecycle.test.ts`, `promotion-ledger.test.ts`, `deploy-refs.test.ts`, `service-tokens.test.ts`; the `populatedM3`
strip lists in `migrations.test.ts` (~36) and `migration-legacy.test.ts` (~59) gain `canary_metrics`.

**Docs:** `docs/OPS.md` (rollback-floor text, cron, retention, the shadow-not-canary label, rollback runbook),
`docs/FOCUS.md`, `docs/MILESTONES.md`.

## New tests (all local, no e2e against production)

- Spec DO: upsert-add, p95 from buckets, retention on POST and GET, unknown deployment (GET 200 with 0, POST rejected),
  non-`deployed` deployment ignored, previous-to-latest migration and legacy-shape migration (drop table, set previous
  version, restart twice, rows kept), purge with metrics rows.
- SLO monitor: healthy, latency violation, error-rate violation, below minimum sample, DO unavailable (no rollback, logged),
  NaN/unset config (no verdict), per-deployment isolation.
- Cron: only `autoRollback = 1` deployments roll back; 404 and 409 from rollback are benign; one failing deployment does not
  stop the others.
- Shadow router: recording failure leaves the response unchanged; aggregation flushes once per bucket; static candidates skipped.

## Out of scope

AE SQL reads (a/c), real canary traffic serving, Statsig, `promotion-events` producers.

## Needs the maintainer

Approve this plan; settle which M11 ships first and its number; one deploy push afterwards.
