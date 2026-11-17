---
category: audit
status: active
audience: human,agent
---

# Review, slice f: docs vs code (2026-11-17)

Step 2 of the whole-repo review (context: `docs/reviews/2026-11-15-architecture-map.md`). An independent Opus agent did a read-only pass at `1d82d17`.

The orchestrator confirmed two findings:
- **D1:** the queue block in `docs/SETUP.md` has no `canary-slo-ticks`.
- **D3:** `wrangler secret put --help` (4.151.0) lists `--name` with no `-n` alias, and `README.md:137-139` uses `-n`.

No finding is fixed yet. Several fixes belong in AGENTS.md, which needs the maintainer's agreement.

**Verdict: request changes.**
- AGENTS.md is mostly accurate on process. Its architecture claims, though, describe the target design as if it were built: Statsig, D1, git notes, `scratch/*` refs, Workflows and Workers Builds.
- The costliest problems are operational:
  - self-host and deploy instructions that would fail;
  - wrangler examples that AGENTS.md sends agents to copy;
  - status claims that are stale in both directions.

## 1. Dangerous instructions (costliest first)

| # | Doc | Problem (code evidence) | Correction |
|---|---|---|---|
| D1 | `docs/SETUP.md:128-137` | The queue list leaves out `canary-slo-ticks`. The root `wrangler.toml:49-51` produces to it and `canary-worker/wrangler.toml:46-47` consumes it. `docs/OPS.md:491-492` says that without it the deploy of `beehive` fails. `canary-rollback-triggers` and `promotion-events` are only mentioned in prose. | Add all three to the code block. |
| D2 | `SUBMISSION.md:236-252` | Tells readers to run `npm run deploy` and seven `deploy:*` scripts. They cover 8 of the 10 workers, in a fixed order. This contradicts "No agent deploys", `CONTRIBUTING.md:97` and `docs/OPS.md:9-21`. | Delete the section. Point to `docs/OPS.md` for upstream deploys and to `docs/SETUP.md` section 2 for self-hosting. |
| D3 | `README.md:137-151`, `docs/ARCHITECTURE.md:492-497`, `SUBMISSION.md:250`, `docs/STATSIG-INTEGRATION.md:902-903`, `docs/OAUTH-INTEGRATION.md`, `docs/OAUTH-QUICK-START.md` | They use `wrangler secret put X -n <worker>`. Wrangler accepts only `--name`. README and ARCHITECTURE also leave out `SPEC_DO_INTERNAL_TOKEN` and `SPEC_DO_ADMIN_TOKEN`, without which every Spec DO call fails closed. | Use `--name` everywhere. In README and ARCHITECTURE, link `docs/SETUP.md` section 2d instead. |
| D4 | `README.md:164-191`, `SUBMISSION.md:139-163, 221-229` | They recommend `scripts/demo-end-to-end.sh`, whose own header says it is superseded and broken. It runs `pkill -f "wrangler dev"` (every wrangler process on the machine), and in `--remote` mode calls production with the reader's token at a host that does not exist (`:389`). | Replace both sections with `npm run demo`. Delete "Full Demo (Production)". |
| D5 | `docs/TROUBLESHOOTING.md:606-622, 653-683, 637` | **Ports:** wrong (8788-8790 are shadow-router, canary-worker and promotion-worker, `scripts/start-e2e-workers.sh:6-11`), and `scripts/health-check.sh:18-21` uses a third mapping. **Quick start:** runs `scripts/start-all.sh`, which cannot work (review e S3). **`:637`:** prints the first 10 characters of `CLOUDFLARE_API_TOKEN`. | Point to `start-e2e-workers.sh` and the SETUP port table. Make `:637` print only `set`. |
| D6 | `docs/ARCHITECTURE.md:562-570, 590-592, 601` | **Promotion-worker:** shown as a `[[services]]` `SPEC_DO` binding, but it has used a DO binding since `6629c2e`. **Shadow-router:** "has no SPEC_DO binding" is false. **SANDBOX_RUNNER:** "No worker has a SANDBOX_RUNNER binding" is false (preview-manager, since `a7a6b35`). AGENTS.md's config rules lead agents to copy these examples. | Delete the "Exception" paragraph, the service example and the "Note". |
| D7 | `docs/SETUP.md:157-159` | `CLOUDFLARE_API_TOKEN` is listed for `beehive` and preview-manager only. Sandbox-runner reads it too (`build-sandbox.ts:139`, `test-sandbox.ts:243`). | Add `wrangler secret put CLOUDFLARE_API_TOKEN --name beehive-sandbox-runner` (Artifacts read scope). |

## 2. Wrong about current behavior

| # | Doc | Evidence | Correction |
|---|---|---|---|
| W1 | **Canary SLO source.** `AGENTS.md:49`, `docs/AGENTS-REVIEWER.md:26` and `SUBMISSION.md:43` say "SLOs via Statsig + Analytics Engine"; `README.md:50` and `docs/ARCHITECTURE.md:285` say Analytics Engine. | `canary-worker/slo.ts:44,128` reads Spec DO `canary_metrics`. Nothing depends on Statsig. | "SLOs over Spec DO `canary_metrics`, recorded from mirrored requests (no live traffic split, no Statsig)". |
| W2 | **Auth.** `AGENTS.md:164-168`; `docs/ARCHITECTURE.md:460-484` ("No exceptions, no bypasses", plus a code sample) | Public pages and the UI are served before auth (`workers/api/index.ts:117-128`). `X-API-Token`, service tokens and user tokens are also accepted. The sample is neither async nor constant-time. Local e2e passes the token as `--var`, not through `.dev.vars`. | AGENTS.md: name the exceptions (public pages and the session-authenticated UI) and describe the `--var` mechanism. ARCHITECTURE: delete the sample and link `shared/auth.ts`. |
| W3 | `docs/ARCHITECTURE.md` sections 1-11, the binding lists | Map items 5, 7 and 8. Also missing: preview-manager's `SANDBOX_RUNNER`, canary-worker's `canary-slo-ticks` consumer, and sandbox-runner's `TEST_SANDBOX`. | Link the map's section 1, or generate the table from the wrangler files. |
| W4 | `docs/ARCHITECTURE.md:110`, `:90-104` | Says "Append-only ledger (no delete routes)", but purge exists. The table list stops at m1. | "Tombstones plus a guarded purge (ADR-0008)". List m2-m15, or link OPS. |
| W5 | `docs/ARCHITECTURE.md:361-365`, `:73` | The gate writes only a verdict; `advance` writes stages. Execute is retired. | Redraw the diagram (gate -> verdict; promotion-worker -> `advance` -> stage) and delete "sandbox execution". |
| W6 | `docs/TROUBLESHOOTING.md:170-187`, `:25`, `:27` | No mock Artifacts mode has existed since `bbccf9e`. The code fails closed (`shared/artifacts.ts:33-45`). | Delete. Say that a missing credential is an error, never a mock repo. |
| W7 | `SUBMISSION.md:71-72, 112, 188-189, 281` | **Git notes:** no code uses them. **Analytics Engine:** "(Planned)" here, "in use" in README. **Bodies:** said to be compared, but never are. **Previews:** simulated. **Link:** `docs/M2-PLAN.md` is in the archive. | Label the file (A5) and fix these lines. |
| W8 | `README.md:399`, `docs/MILESTONES.md:39`, and the headers of `workers/api/index.ts:7`, `spec-do/index.ts:4`, `schema.sql:2`, `queue-consumer/index.ts:7` and `gate-workflow/index.ts:7` ("hand-written") | Contradicts AGENTS.md rule 2. | "Spine work is agent-written under plan and independent review (AGENTS.md rule 2)." |
| W9 | `docs/GOVERNANCE-STATE-MACHINES.md:13, 22, 19-20` | **`:13`:** "Nothing here is implemented yet", but tables (c) and (d) are live in log-only mode. **`:22`:** says the stage PATCH is the only stage writer, which its own `:104` contradicts. **`:19-20`:** line numbers out of date (the tournament check is now `:3276`). | Say (c) and (d) are implemented log-only. Say `advance` writes forward stages and the PATCH is the master-token break-glass. Update the line numbers. |
| W10 | `cli/README.md:254-255, 293-294` | `gate run` calls an edge route that always fails (review d S1). `promotion create` writes only the legacy table. | Label `gate run` as broken and `promotion create` as "records a request only". |
| W11 | `docs/SETUP.md:185-186`, `:114` | "No worker binds `SANDBOX`" is false. The line reference should be `shadow-router/config.ts:150`, not `:145`. | Fix both. |

## 3. Stale status

| # | Doc | Evidence | Correction |
|---|---|---|---|
| S1 | `docs/OPEN-QUESTIONS.md:651-665` (2026-10-19, "Resolved") | The seed actor exists only when `DEV === 'local'`. | "Partly resolved: local dev only; the production foreign-key failure is open (review b2 M1)". |
| S2 | `docs/MILESTONES.md:41-48`, `:17` ("M2 COMPLETE ... mirrors production traffic") | Previews are simulated, only live canaries are mirrored, bodies are not compared, the comparator drops everything (review c M1), and the gate is simulated. | "M2: components deployed; preview build simulated; shadow evidence partial (map section 4)". |
| S3 | `docs/MILESTONES.md:10` ("Current phase: post-submission (2026-10-15)"), `:15` ("M5a COMPLETE") | AGENTS.md says to work only on the current phase, and none has been set since 2026-10-15. `:15` contradicts `:87` (PARTIAL). | Set a current phase, and mark M5a PARTIAL. |
| S4 | `docs/MILESTONES.md:27-30, 94, 195, 245-250` | **`:27-30`:** "live Spec DO on m3", but production is on m15. **`:195`:** M9 "not merged", but it is. **`:245-250`:** M12 PR-B and PR-C "on branch", but both are merged. **`:94`:** the governance migration is listed as to-do, but m14 exists. | Mark each one done, with its commit. |
| S5 | `docs/OPS.md:493-494`, `:625` | **`:493-494`:** says production canary deploys answer 501 and the SLO loop does not run. A real production canary was rolled back by the loop on 2026-10-25. **`:625`:** "Nothing sends real traffic to the router", contradicted by `:685-689`. | "The loop runs whenever a canary ref is live"; "the edge mirrors a sample when `MIRROR_SAMPLE_PERCENT` is set". |
| S6 | `docs/OPEN-QUESTIONS.md:1207, 1253, 1022, 1036, 1054, 151, 917` | These still say "not merged" or "not deployed", but the postinstall fix, m13, `TestSandbox` and the 2026-11-12 deploy all landed. | Update each status line. |
| S7 | **Plan front matter:** shadow-router-followup, M3-CANARY-SLO, d2-canary-ping-pong, SF-8, CLEANUP-PLAN, merge-train-gate-call, REAL-GATE, STATSIG-INTEGRATION, QUEUE-GATE-WIRING | They claim "no code", "not deployed" or "on a branch" for work that is implemented and merged. STATSIG has `status: active` but nothing in it is built. About 15 plans use status values outside `draft\|active\|completed\|deprecated` (`docs/README.md`). | Use `completed` for implemented plans and `deprecated` for STATSIG. |
| S8 | `README.md:298-317`, `SUBMISSION.md:175-196` | "Analytics Engine capturing per-candidate metrics", but nothing reads it and the payloads are probably malformed (review c S4). | "Written, not yet read or validated". |
| S9 | `docs/FOCUS.md:11`, `:156` | "Last updated 2026-11-12" is wrong. `docs/backtest/runs/pilot-2/human-sample.md` does not exist. | Fix the date, and fix or delete the reference. |

## 4. Aspirational without a label

| # | Doc | Evidence | Correction |
|---|---|---|---|
| A1 | `AGENTS.md:32-35, 107, 132-133, 184`; `docs/AGENTS-REVIEWER.md:16-17` (D1, git notes, `scratch/*` refs) | No D1 binding exists, and no worker writes git notes or `scratch/` refs. This file is loaded into every agent turn. | Add: "Design target, not implemented as of 2026-11-17: no D1 binding, no git-notes or `scratch/*` code. Do not query or assume them." Keep the always-pushed rule for agent branches. |
| A2 | `AGENTS.md:36-37` (rule 6), `README.md:374` | There is no `[[workflows]]` binding, and the gate is simulated. Canary builds use sandbox-runner plus the Versions API; the Workers Builds path is simulated. | Add "(target)" and say what runs today. |
| A3 | Oracle ladder: `AGENTS.md:43-53`, `README.md:45-53`, `SUBMISSION.md:38-44`, `docs/ARCHITECTURE.md:381-384` | Map section 4: pre-merge is simulated, shadow is partial, train is a stub, canary has no live split, and full is a stage write only. | Add a "Built today" column, or one line under each table linking map section 4. |
| A4 | `README.md:14, 66, 68`; `CONTRIBUTING.md:25`; `docs/ARCHITECTURE.md:208-221` | Mirroring and the comparator are listed as "real and running". In production, no sample is scored (review c M1). | Move them to the partial column and say why. |
| A5 | `SUBMISSION.md` (whole file) | A 2026-10-12 snapshot that claims "Production-Ready" (`:318-321`). | Add a "Historical: as submitted 2026-10-12" banner, or move it to `docs/archive/`. |

## The docs-links test

It passes (2 of 2), but it checks markdown links only. It misses:
- paths in backticks (for example `SUBMISSION.md:281`, `docs/FOCUS.md:156`);
- paths inside fenced code;
- anchors;
- `file:line` references that have drifted;
- the names of scripts, npm scripts, routes and workers;
- external links.

Cheap extension: check paths in backticks, and require that each `path:N` reference stays within the file's line count.

## Map discrepancies re-checked

All 12 are confirmed. Three need detail:
- **#1 (Statsig): partly.** ARCHITECTURE section 10 already says "no Statsig", but it still credits Analytics Engine with the SLOs.
- **#8: wider than listed.** Three more missing bindings (W3).
- **#11: wider than listed.** Five code headers, `README.md:399` and `MILESTONES.md:39` all say "hand-written".

## What was run

- The listed docs, read against grep of all 10 wrangler files, the package scripts, the Spec DO seed and auth paths, and the scripts the docs name.
- `npx vitest run tests/docs-links.test.ts`: 2 passed.
- `npx wrangler secret put --help` (4.151.0), plus a read of the option definition.
- `git log -S` to date when each doc and the code diverged.
- **Inferred, not verified:**
  - that the `-n` commands fail at runtime;
  - that a copied `SPEC_DO` service binding breaks;
  - that canary builds fail without the sandbox-runner token.
