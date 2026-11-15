---
category: audit
status: active
audience: human,agent
---

# Beehive architecture map (2026-11-15)

Step 1 of the whole-repo review. An independent Fable agent produced this map in a read-only pass at `7d2e075`. The orchestrator
checked four claims against the code: `promotion-worker/queues.ts` has no importer, approvals are only a comment (`spec-do/index.ts:4930`),
and `deployCanary` checks tombstones but not stage. All three are confirmed. The fourth, about `trafficPercentage`, is corrected in section 4.
Items marked **(inferred)** were not verified end to end. Line numbers are as of `7d2e075`.

Next step: one area review per slice in section 6, followed by a synthesis.

## 1. Worker inventory (10 deployed)

| Worker (wrangler `name`) | Job | Handlers | Main routes |
|---|---|---|---|
| `beehive` (`wrangler.toml`, main `workers/api/index.ts`) | Edge router, auth, server-rendered UI and mirror source. It hosts the `SpecDO` class (`index.ts:92`). | `fetch` `index.ts:95`; SpecDO `fetch` `spec-do/index.ts:4098`, `alarm` `:3669` | Public: `/`, `/about`, `/roadmap`. UI: `/login`, `/auth/callback`, `/logout`, `/app/*` (`ui.ts:107-277`). `/api/*` CRUD for organizations, actors, repositories, specs, candidates, gate-verdicts, trials, promotions, near-misses, issues and history (`index.ts:176-400`). Admin: `/api/admin/{purge,user-tokens,service-accounts}`, `/api/whoami`. |
| `beehive-gate-workflow` | Pre-merge gate. **Simulated.** It is a plain Worker with an in-memory run map, not a Cloudflare Workflow. | `fetch` `gate-workflow/index.ts:120` | `POST /gates/pre-merge` (`:142`), status/result GETs, sub-routes `/tests`, `/complexity`, `/conformance` (`:147-178`) |
| `beehive-queue-consumer` | Artifacts push event -> find the candidate -> gate -> history row. Deploys a preview on the first delivery. | `fetch` `:392` (health only), `queue` `:414` | Queues `beehive-artifacts-push`, `preview-artifacts-push`, `preview-artifacts-events` |
| `beehive-sandbox-runner` | Container DOs: `BuildSandbox` bundles a commit, `TestSandbox` runs a commit's tests. | `fetch` `sandbox-runner/index.ts:88`; DO `alarm` `sandbox-base.ts:179` | `/sandbox/probe`, `/sandbox/build`, `/sandbox/test`; legacy simulated routes `/sandbox/tasks`, `/repos/*`, `/execute*` (`:195-242`) |
| `beehive-preview-manager` | Builds and uploads candidate Workers (Workers Builds preview; Workers Versions API for canary) and deletes them on purge. | `fetch` `index.ts:51`, `queue` `:95` | `POST /api/preview/deploy`, `POST /api/preview/canary`, `DELETE /api/preview/canary/:id` |
| `beehive-shadow-router` | Sends a sanitized copy of each request to live-canary candidate Workers. Fetches the `beehive-main` baseline, queues comparisons and records canary metrics. | `fetch` `index.ts:668` | `POST /mirror`, catch-all mirror path, `/statsig/*`, `/health` |
| `beehive-scientist-comparator` | Scores a candidate against the baseline (status, allowlisted headers, latency) over the spec's delta surface, then posts shadow samples. | `fetch` `:39` (health; `/api/metrics` answers 501), `queue` `:94` | Queues `beehive-scientist-comparisons`, `preview-scientist-comparisons` |
| `beehive-promotion-worker` | `/promote` runs a dry-run `advance`, then one of: tournament (shadow->train), merge train (train->canary), or direct `advance`. | `fetch` + `queue` `index.ts:361` | `/promote*`, `/mode`, `/tournament*`, `/merge-train*`, `/merge/{retry,rollback}`, `/stats` |
| `beehive-canary-worker` | Deploys a canary (version via preview-manager, ref move in the Spec DO), runs the SLO cycle, rolls back. | `fetch` `:37`, `queue` `:132` | `/deploy-canary`, `/rollback`, `/slo-status`, `/canary-deployments[/:id]`, `/canary/:id/auto-rollback` |
| `beehive-candidate-service` | Thin proxy for candidate preview metadata held in the Spec DO. | `fetch` `:52` | `/api/candidates/:id`, `/:id/preview`, `/:id/health` |

None of the workers has a `scheduled` handler (`canary-worker` sets `crons = []`), and no wrangler file binds D1, KV, R2 or `[[workflows]]`.

## 2. Call graph

**Auth legend:**
- **B:** `Authorization: Bearer API_AUTH_TOKEN`, checked by `authGate` (`shared/auth.ts`).
- **I:** `X-Beehive-Internal` = `SPEC_DO_INTERNAL_TOKEN`, plus `X-Beehive-Admin` on admin routes, checked by `specDoAuthGate`. Only `beehive` holds the admin token.

| From -> To | Mechanism | Auth | Evidence |
|---|---|---|---|
| client/CLI -> `beehive` | public fetch | master bearer, service token, user token or UI session; `authorize` allow-list | `api/index.ts:134-137`, `api/principal.ts:254-289` |
| `beehive` -> SpecDO | same-script DO binding, instance `main` | I (+admin); `X-Actor-ID` rewritten for non-master callers | `api/index.ts:140-154` |
| SpecDO -> gate-workflow | service binding, `POST /gates/pre-merge` | B | `spec-do/index.ts:4864-4877` |
| SpecDO -> `canary-slo-ticks` | queue producer, called from `alarm` | n/a | `spec-do/index.ts:3676` |
| SpecDO -> Artifacts REST (`createFork`, repo tokens) | public fetch | `CLOUDFLARE_API_TOKEN` | `spec-do/index.ts:1802-1809`, `shared/artifacts.ts:31` |
| `beehive` -> shadow-router | service binding, `POST /mirror` sent in `waitUntil` for a sampled share of GET/HEAD requests | B | `api/mirror.ts:78-99` |
| `beehive` -> preview-manager | service binding; deletes canary Workers on purge | B | `api/purge-cleanup.ts` |
| `beehive` UI -> Artifacts REST | public fetch (repo browsing) | `CLOUDFLARE_API_TOKEN` | `api/ui-semantic.ts:111-117` |
| Artifacts -> 3 push queues **(inferred: subscription set up outside the repo)** | queue | n/a | `queue-consumer/wrangler.toml` |
| queue-consumer -> SpecDO / gate-workflow / preview-manager | DO binding; service bindings (gate request carries an `Idempotency-Key`) | I / B / B | `queue-consumer/index.ts:416, 182` |
| gate-workflow -> SpecDO | DO binding; reads spec and candidate, writes a verdict | I | `gate-workflow/index.ts:303, 953` |
| preview-manager -> sandbox-runner | service binding, `/sandbox/build` | B | `bundle-source.ts:60` |
| preview-manager -> Cloudflare API, SpecDO | public fetch; DO binding | token / I | `builds.ts:106`, `versions.ts:94`, `index.ts:359, 389, 549` |
| sandbox-runner -> Artifacts git | `ArtifactsGateway`, short-lived read tokens | `CLOUDFLARE_API_TOKEN` | `sandbox-base.ts:60` |
| shadow-router -> SpecDO | DO binding: live canary refs, `POST /canary-metrics` | I | `canary-recorder.ts:92` |
| shadow-router -> candidate Workers | public fetch to `*.workers.dev`, marked `X-Beehive-Mirror: 1` | none; 5-header allowlist | `candidate-headers.ts`, `config.ts:242-249` |
| shadow-router -> baseline `beehive-main` | public fetch (GET/HEAD) | none, so only public pages can answer below 401 **(inferred)** | `config.ts:150`, `fetchBaseline` |
| shadow-router -> scientist queues | queue producers | n/a | `shadow-router/index.ts:548` |
| scientist-comparator -> SpecDO | DO binding: candidate GET; `POST .../shadow-samples` keyed `<requestId>:<candidateId>` | I | `storage/spec-do.ts:112, 175` |
| client -> promotion-worker, canary-worker, candidate-service | public fetch only; no worker binds them | B | |
| promotion-worker -> SpecDO / gate-workflow | DO binding (mode, states, tournament/merge-train status, `advance`, trials); service binding, no idempotency key | I / B | `promotion-worker/spec-do.ts:42-181`, `merge-train.ts:456` |
| canary-worker -> preview-manager / SpecDO | service binding `/api/preview/canary`; DO binding (deployments, deploy refs, canary metrics) | B / I | `shared/deploy-refs.ts:230-288` |
| `canary-slo-ticks` -> canary-worker | queue consumer, `max_retries = 0` | n/a | `canary-worker/index.ts:132` |

## 3. State

| Store | Contents | Notes |
|---|---|---|
| Spec DO SQLite: one instance named `main`, `LATEST_SCHEMA_VERSION = 'm15'` (`spec-do/index.ts:35`) | m1 core tables; m2 preview columns; m3 `service_accounts`; m4 `promotion_states`, `tournaments`, `merge_trains`; m5 tombstones and `purge_log`; m6 `service_tokens`; m7 `deploy_refs`, `canary_deployments`; m8 CAS versions; m9 `user_tokens`; m10 `idempotency_keys`; m11 `canary_metrics`; m12 unique GitHub id; m13 `gate_runs`; m14 governance tables; m15 `shadow_scores` | Only SpecDO code touches it. |
| Spec DO key-value storage | `promotion_mode`, alarm | Written by promotion-worker `/mode`. |
| Analytics Engine `beehive-metrics` (bound on all 10 workers) | actor assertions; shadow, split and queue metrics; comparisons; promotion and canary events | **No reader in the repo.** |
| Queues | `canary-slo-ticks`, two scientist queues, 3 Artifacts push queues, plus `promotion-events` and `canary-rollback-triggers` | The last two have consumers but no producer. |
| Artifacts repos | candidate forks (namespace = organization name), baseline repos, deploy repo `default/beehive` | Forks are created on claim. |
| Deploy refs | `deploy_refs`, rungs `canary` and `full`, an append-only chain | Only `canary` is ever moved. |
| D1, KV, R2, git notes, `scratch/*` refs | **None in code.** | Mentioned only in UI copy (`api/index.ts:957, 1300`). |

## 4. Oracle ladder as implemented

The single decision point is `POST /api/candidates/:id/advance` in the Spec DO (`spec-do/index.ts:4481, 4935-4986`). It runs in one transaction and moves one rung at a time. Evidence modes per rung (`shared/promotion-advance.ts:62-67`): pre-merge **enforce**, shadow **log**, train **log**, canary **enforce**. The edge does not route `advance`; only promotion-worker calls it.

| Rung | What the code does | Real vs simulated |
|---|---|---|
| Pre-merge | `advance(shadow)` needs a `pass` row in `gate_verdicts` (`:4993-4998`). gate-workflow writes that verdict. | **Simulated.** Tests are hard-coded to pass, complexity is derived from a hash, and conformance warns 10% of the time at random (`gate-workflow/index.ts:702-876`). The real pipeline (`gate_runs`, `/sandbox/test`) is built but has no caller. |
| Shadow | The comparator posts samples. The Spec DO derives a verdict: pending below 20 samples, pass at an average of 80 or more. `advance(train)` only logs missing evidence. The tournament ranks by ledger shadow score. | **Partly real.** The router mirrors only live canary refs, never shadow-rung candidates, so a candidate in production has no score before it reaches canary. The traffic is `beehive`'s own GET/HEAD requests, not customer traffic. Response bodies are never compared. The production-only switches default to off. |
| Train | A merge-train car "merges" when the gate answers `pass` (`merge-train.ts:433-480`). `advance(canary)` only logs whether a merged car exists. | **Stub.** No projection fork, no combined build, no git merge. In the default tournament mode there is no train evidence at all. |
| Canary | `POST /deploy-canary` -> version upload -> ref move (`spec-do/index.ts:3616-3640`). `advance(full)` needs the candidate to have been the live canary head for 15 minutes. The SLO loop reads `canary_metrics` (source `shadow` by default) and rolls back by moving the ref. | The ref mechanics are real. **There is no live traffic split:** metrics come from mirrored requests. `deployCanary` checks tombstones but not stage, so a candidate that never passed earlier rungs can become a canary (orchestrator-verified). *Correction to the agent's inference:* `trafficPercentage` is used, as that candidate's mirror sampling percentage (`shadow-router/config.ts:255`), but no live traffic is routed by it. |
| Full | `advance(full)` writes `passed_canary`, then `promoted`. | **Only a stage write.** No `full` ref moves, nothing rolls out to 100%, and there is no drift, holdout or bisect code. Approvals are only a comment (`:4930`). The governance tables have no writers. |

There are other paths that write promotion state:
- The stage PATCH is routed at the edge, limited to master and service tokens, and its transition checks only log.
- The legacy `POST /api/promotions` inserts a `pending` row and changes nothing else. That is the route `cli promotion create` calls (`cli/src/commands/promotion.ts:14-21`), so the CLI cannot drive the real promotion path.

### Doc vs code discrepancies

1. AGENTS.md says canary SLOs come "via Statsig + Analytics Engine". The code has no Statsig SDK (it uses a local hash split) and reads SLOs from Spec DO `canary_metrics`, not from AE. ARCHITECTURE section 10 has the same error.
2. AGENTS.md rule 6 says "Validation = Sandboxes via Workflows", but there is no Workflow binding and the gate is simulated. ARCHITECTURE section 3 lists gate-workflow bindings that its wrangler file does not declare (`Env.SANDBOX_RUNNER` is never bound).
3. AGENTS.md rules 4 and 5 rely on D1 for cross-spec indexes, `scratch/*` refs and git-notes provenance. None of them exist in the code.
4. The ladder's train projection, canary "% live" and full rung (drift, holdouts, bisect) are not implemented. MILESTONES says so; AGENTS.md and ARCHITECTURE do not.
5. ARCHITECTURE section 1 lists only `SPEC_DO` for `beehive`, which also binds `ANALYTICS`, `CANARY_SLO_TICKS`, `GATE_WORKFLOW`, `PREVIEW_MANAGER`, `SHADOW_ROUTER` and a rate limiter.
6. ARCHITECTURE section 2 describes an "append-only ledger (no delete routes)", but purge exists. Its table list stops at m1.
7. ARCHITECTURE section 4 describes the simulated legacy sandbox routes; the real jobs are build and test containers.
8. ARCHITECTURE sections 6, 8, 9 and 11 misstate bindings and callers: the router's `SPEC_DO` is missing; preview-manager never sends to the comparison queues; candidate-service is a proxy, not CRUD; promotion-worker reaches the DO through a DO binding, not `[[services]]`.
9. The ARCHITECTURE lifecycle diagram shows the gate writing stages. The gate writes only a verdict; `advance` writes stages.
10. MILESTONES marks M2 "COMPLETE ... mirrors production traffic", which overstates what the shadow rung does.
11. The `api/index.ts:7` header says "hand-written, not agent-generated", contradicting AGENTS.md rule 2.
12. OPS says "Nothing in the repo sends real traffic to the router yet", while its later mirror-source section says `MIRROR_SAMPLE_PERCENT` is deployed.

## 5. Dead or unreachable code and unused bindings

| Item | Evidence |
|---|---|
| `promotion-worker/queues.ts` (whole module) | no importer (orchestrator-verified) |
| promotion-worker `queue` handler / `promotion-events`; canary-worker `handleRollbackQueue` / `canary-rollback-triggers` | no producer (`docs/OPEN-QUESTIONS.md:1272`) |
| preview-manager `queue` handler | no `[[queues.consumers]]` in its wrangler file |
| Unused bindings: preview-manager `PREVIEW_SCIENTIST_QUEUE` and `ANALYTICS`; promotion-worker `PREVIEW_MANAGER` and `SHADOW_ROUTER`; sandbox-runner `SPEC_DO` and `ANALYTICS`; `ANALYTICS` on gate-workflow, queue-consumer and candidate-service | the binding appears only in `types.ts`, or no `writeDataPoint` call was found (grep-level check) |
| Legacy sandbox-runner routes; gate-workflow sub-routes; `/statsig/*` (`POST /statsig/config` stores nothing); comparator `/api/metrics` (501) | no caller |
| `/sandbox/test` + `TestSandbox`; Spec DO `/api/gate-runs*` | built and tested, but no production caller |
| candidate-service (whole worker) | only e2e and health scripts reach it |
| The `promotions` table path; governance tables without writers; `ui/` | section 4; AGENTS.md |
| `npm run lint` | defined, but not run in CI |

The committed `.env.test.*` files hold a local test token and placeholders; the agent saw no real secret.

## 6. Review slices for step 2

The draft split changed in four ways:
1. **Canary SLO goes with shadow.** The canary SLO path joins the shadow path, because `canary-recorder.ts` writes the SLO input that `canary-worker/slo.ts` reads.
2. **The promotion slice is split** into (b1), the decision, and (b2), the build and gate plumbing.
3. **`workers/shared` is shared out.** Each module goes to the slice that owns its contract; (d) keeps the auth modules.
4. **candidate-service moves to (b2).**

| Slice | Scope | Contracts to check against the other side |
|---|---|---|
| (a) Spec DO ledger + migrations | `workers/spec-do/*`, m1-m15, idempotency, purge, tokens, deploy refs | Every route in section 2 against its client. The `isAdminRoute` list against the edge's `authorize`. Migration replay and the rollback floor while old and new versions run side by side. |
| (b1) Promotion decision | promotion-worker; `shared/promotion-advance.ts`, `promotion-ledger.ts`, `ledger-state-machine.ts`, `governance-state-machine.ts`; Spec DO `advance` | The `advance` contract, including a 404 with a `code` versus one without (`ledger_too_old`). CAS on tournament and merge-train status. The gate's "201 + `result.status`" answer. `deployCanary` has no stage precondition, while `advance(full)` trusts the canary head. |
| (b2) Build and gate plumbing | gate-workflow, queue-consumer, preview-manager, sandbox-runner, candidate-service | `GateWorkflowRequestSchema` and `Idempotency-Key`. The `/sandbox/build` schema and its namespace echo. The `/api/preview/canary` response. `PUT /api/candidates/:id/preview`. queue-consumer's 100-row lookups against Spec DO paging. |
| (c) Shadow + canary evidence | shadow-router, scientist-comparator, canary-worker; `shared/{mirror-descriptor,route-template,shadow-verdict,deploy-refs}.ts`; `api/mirror.ts` | The mirror descriptor, edge to router. `MIRROR_ROUTE_WORDS` kept the same in all three places. The two separate `ScientistQueueMessage` types. `ShadowSampleSchema` and `baseline.kind`. The `/canary-metrics` and `/deploy-refs` schemas. The workers.dev URL check in both the router and the Spec DO. |
| (d) Edge, auth, UI | `workers/api/*`; `shared/{auth,spec-do-auth,principal,service-tokens,namespace}.ts` | The edge route table against the Spec DO route table. The user-token allow-list against the DO's maintainer re-check. Trust in `X-Actor-ID` from the nine binding callers. |
| (e) Tooling | cli, tools/backtest, scripts, CI, tests/e2e | CLI endpoints against the live routes. `builds-watch-paths.json` and `check-shared-postinstall.mjs` against the ten worker names. e2e ports and tokens. Lint and `test:backtest`, which CI does not run. |
| (f) Docs vs code | AGENTS.md, ARCHITECTURE, MILESTONES, OPS, GOVERNANCE-STATE-MACHINES | Start from the 12 discrepancies above. ARCHITECTURE is the most out of date. |

This pass did not cover: `tools/backtest` internals, the CLI beyond its endpoints, the UI page logic, test quality, or history.
