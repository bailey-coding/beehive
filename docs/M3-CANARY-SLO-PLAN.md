---
category: planning
status: proposed
audience: human,agent
---

# M3 canary SLO loop (plan, 2026-10-24)

Closes the M3 gaps in `docs/FOCUS.md`: `SLOMonitor.getMetric` always returns 0 (`workers/canary-worker/slo.ts:67`),
`monitorAndTriggerRollback` has no caller, `sendRollbackTrigger` only logs (`workers/canary-worker/queues.ts`).
Spine-adjacent (promotion train, Spec DO schema): **a human approves this plan before any code lands.**

## Decisions (accepted 2026-10-24)

1. **Metric source: the Spec DO** (design b), not the Analytics Engine SQL API. A Worker binding can only write AE;
   reading it needs an account token and has ingestion lag. Designs (a) AE SQL and (c) both are a later investigation.
2. **Input today is shadow data.** Production canary traffic does not exist yet (canary deploys answer 501 until a Workers
   Versions client exists; the shadow router mirrors and discards responses). The only per-candidate request outcomes are
   the shadow router's mirrored status and latency (`workers/shadow-router/index.ts` ~271). They are recorded and labelled
   `source = 'shadow'`; the SLO loop must not call them canary SLOs in logs or verdicts until `source = 'canary'` rows exist.
3. **Schema slot: after M11.** M11 takes `m11` (`actors.github_user_id` UNIQUE index). This work takes the next free
   version (`m12` if M11 lands first). Do not start the migration until that is settled.
4. **Trigger: a `scheduled` cron on the canary worker** calls the monitor. No queue producer on the hot path.

## Rules this must keep (AGENTS.md)

- Coordination state lives in the Spec DO (SQLite), transactional; AE keeps raw telemetry only.
- Rollback is a ref operation and stays idempotent: a repeated trigger for an already rolled-back canary is a no-op 409/200, never a second move.
- One push deploys all ten workers in no order: additive migration only; a new DO route answers 404 on an old DO and every caller treats that as "unavailable", never "empty" or "healthy".
- Check `Response.ok` on every DO call; an unreadable metric is **unhealthy-unknown**, never 0 and never auto-rollback (fail closed on data, fail safe on action).

## File-by-file

| File | Change |
|---|---|
| `workers/spec-do/schema.sql`, `schema-inline.ts`, `index.ts` (`LATEST_SCHEMA_VERSION`, migration step) | New table `canary_metrics(deployment_id, minute_bucket, source, requests, errors, latency_sum_ms, latency_max_ms, latency_buckets)`: one row per deployment per minute per source, `UNIQUE(deployment_id, minute_bucket, source)`, upserted. Latency kept as fixed histogram buckets (JSON) so p95 can be derived without raw samples. Additive, no change to existing tables. |
| `workers/spec-do/index.ts` | `POST /internal/canary-metrics` (idempotent upsert add), `GET /internal/canary-metrics?deploymentId=&sinceMinutes=&source=` (aggregate: requests, errors, p95). Retention: prune rows older than 24h inside the same transaction. |
| `workers/shared/deploy-refs.ts` | `recordCanaryMetrics()` / `canaryMetrics()` on `DeployRefsClient` with zod-parsed responses; 404 maps to an `unavailable` result. |
| `workers/shadow-router/index.ts` | After each mirrored candidate result, add `{deploymentId, source:'shadow', ok, latencyMs}` to an in-request batch and `ctx.waitUntil` one flush per request. Failure to record never affects the response. |
| `workers/canary-worker/slo.ts` | `getMetric` replaced by `loadMetrics(deploymentId)` reading the aggregate; per-deployment `checkSLOs` (today it uses `candidateId: 'all'`); minimum sample size before any verdict (default 50 requests, env `CANARY_SLO_MIN_REQUESTS`); thresholds stay `CANARY_SLO_*`. |
| `workers/canary-worker/index.ts`, `wrangler.toml` | `scheduled()` handler + `[triggers] crons = ["* * * * *"]`; for each live canary with `auto_rollback = 1`, run the monitor, call `triggerRollback` on violation. Reuse `RollbackManager.triggerRollback` (already respects the auto-rollback switch and is a ref move). |
| `workers/canary-worker/queues.ts` | Leave the consumer; replace the log-only `sendRollbackTrigger` with a real producer only if a second source of triggers appears. Until then delete the dead function. |
| `docs/OPS.md`, `docs/FOCUS.md`, `docs/MILESTONES.md` | Cron, retention, the "shadow, not canary" label, rollback runbook. |

## Tests (all local, no e2e against production)

- Spec DO: upsert adds, p95 from buckets, retention prune, 404-on-old-DO shape, migration on a ledger carrying legacy shapes.
- SLO monitor: healthy, latency violation, error-rate violation, below minimum sample (no verdict), DO unavailable (no rollback, logged), per-deployment isolation.
- Cron: rolls back only deployments with auto-rollback on; repeat run is a no-op; one failing deployment does not stop the others.
- Shadow router: recording failure does not change the response; batch is flushed once.

## Out of scope

AE SQL reads (a/c), real canary traffic serving, Statsig, `promotion-events` producers.

## Needs the maintainer

Approve this plan; confirm M11's migration lands first (or release the slot); deploy with the usual single push.
