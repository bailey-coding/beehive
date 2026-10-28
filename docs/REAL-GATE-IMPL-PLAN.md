---
category: planning
status: draft
audience: human,agent
---

# Plan: real test gate, implementation (MR-FLOW-PLAN slice 1)

**Status:** plan, branch `agent/real-gate-plan`, rev 3 2026-10-28. D1-D9 accepted; **spikes S1-S5 are done** (`docs/OPEN-QUESTIONS.md`, two entries dated 2026-10-28; results below are
facts, not assumptions); m12 shipped. **Slices 4 (`agent/real-gate-slice4`) and 5 (`agent/real-gate-slice5`) are being implemented in parallel** from this plan. Implements
`docs/MR-FLOW-PLAN.md` §7 and §11 slice 1 on `docs/SANDBOX-BUILD-PLAN.md`. **[SPINE]** = needs the maintainer (AGENTS.md rule 2). Cites are `path:line` on `main` at `bd06419` (m12 moved
some `spec-do/index.ts` lines). Riskiest remaining assumptions: the multi-package install (only the root install was measured, §1) fits 120 s, and our own counter (§2) is the only cost cap.

## 0. What the grep found (differs from the docs)

- The real defects of the current trigger path: `workers/queue-consumer/index.ts:247-378` loops serially over up to 100 messages (`wrangler.toml:37`), awaits the gate in-band
  (`:321-345`), and **swallows every error with no ack or retry** (`:375-377`); the gate keeps state in an in-memory Map (`workers/gate-workflow/index.ts:84`, `:209`) and has no
  Workflows binding. One queue message holding 600 s fits the documented 15-minute consumer wall limit (CPU time excludes waiting; **S5 confirmed**, §2), so the new design works because of
  `max_batch_size = 1` and real queue retries, not because the wait moved.
- `runUnitTests` **returns three hard-coded passing tests** (`:617-646`), `runPropertyTests` two (`:648-670`); complexity is `hashCode(candidateId)` (`:725`), conformance
  `Math.random() < 0.1` (`:789`), pass is `score >= 80` (`:834`); `generateId` `:179-186` uses `Math.random`; the verdict POST ignores `Response.ok` (`:865-875`); the
  `…/tests`, `…/complexity`, `…/conformance` routes (`:422`, `:493`, `:547`) expose the simulations.
- `gate-workflow/wrangler.toml` has **no `[[services]]` for `SANDBOX_RUNNER`**, though `Env` declares it (`index.ts:20`).
- **The gate call is unguarded by queue:** `isPreviewPush` gates only the preview deploy (`queue-consumer/index.ts:257`); `isProductionPush` (`:245`) is defined and unused, so a push on
  any of the three queues triggers a gate (cost abuse, §3).
- The edge route `POST /api/candidates/:id/gate/pre-merge` (`workers/api/index.ts:1970-1979`) forwards to a DO route that does not exist (no match in `spec-do/index.ts`). The consumer
  sends `baseCommitSha = commit.sha` when `base_ref` is set (`:331`). `candidates.stage` is never advanced by the gate; no R2 bucket is bound anywhere. All unchanged here (§4, D4).

## 1. What the gate runs and returns

Pipeline in one container, one run per (candidate, head sha):
1. **Clone:** the existing `ArtifactsGateway` flow, unchanged: one read token, `git-upload-pack` on one repo, exact 40-hex checkout, hooks and symlinks off
   (`build-sandbox.ts:290-305`). **Measured (S1):** clone + checkout 3.6-4.0 s on both sizes. Repo and namespace come from the ledger (the start route, §3), never from the request body.
2. **Install** (≤120 s): require `package-lock.json` in each install directory, else class `no_lockfile`. Run `npm ci --ignore-scripts --no-audit --no-fund --registry https://registry.npmjs.org/`
   with `NODE_EXTRA_CA_CERTS=/etc/cloudflare/certs/cloudflare-containers-ca.crt` (`:82`) and **two distinct, empty config files** for `NPM_CONFIG_USERCONFIG` and `NPM_CONFIG_GLOBALCONFIG`
   (S1: pointing both at `/dev/null` fails with "double-loading config"); the repo's `.npmrc` is deleted first. **Install every package the repo's CI installs**, not only the root: the
   per-repo constant `installDirs` (D13) is, for this repo, `.`, `cli/` and each `workers/*/` that has a lockfile (`.github/workflows/ci.yml`). S2 proved why: with only the root install, 1380 tests
   passed but `tests/cli-behavior.test.ts` and `tests/cli-token.test.ts` failed (the `cli/` dependencies, e.g. configstore, were missing). **Measured (S1/S2): root only, 199 packages, 342 MB, 10.8 s
   on `standard-2`; the other directories are not measured** and are the first thing slice 7a's production run times (raise the 120 s if needed). The only egress is a **second gateway entrypoint**
   (`NpmRegistryGateway`) for `registry.npmjs.org`: GET only, `redirect: 'manual'`, no `Authorization`, forwarded headers as `build-sandbox.ts:86`; a lockfile entry on any other host gets 403 and fails the install.
3. **Network off:** one container, one `start()`. Intercepts can be **replaced, not removed** (limit 128 entries; the repo uses raw `ctx.container`, `build-sandbox.ts:284`), so "deny" is a
   replacement handler. **Measured (S4, `enableInternet: false`):** with only the registry intercept the registry answered 200 and everything else failed (HTTP/HTTPS to example.com timed out, HTTPS by
   IP `ECONNRESET`, DNS `EAI_AGAIN`); replacing the handler **on the running container** turned the registry answer into 403 with no restart. **A bare TCP connect to `1.1.1.1:443` reports
   connected but no byte ever came back (`:80` and `8.8.8.8:53` timed out with 0 bytes): it is the intercept layer accepting the handshake, not egress, so tests must assert on bytes received, never on a connect.**
4. **Tests** (≤300 s): the command is a constant in the gate's config, default `['npm','test']`, argv only (never `sh -c` with repo text), env cleared to `PATH`, `HOME=/workspace`, `CI=1`.
   Non-root (`node`). The 590 s hold needs no workaround (S5). Overall budget 600 s (alarm/deadline pattern of `:203-219`). Bounds beyond one file: `timeout --kill-after=5` on the process group, `ulimit -u 512`
   (processes), `ulimit -t` (CPU seconds), `ulimit -f` (one file), memory and total disk bounded by the instance (12 GB on `standard-2`); the container is destroyed on every path.
5. **Output:** each phase writes to `/workspace/log/<phase>.log` (`> file 2>&1`), never through `exec().output()` buffers. The runner reads `tail -c 32768`, scrubs it (`scrub`, `:159`),
   returns it with the SHA-256 of the capped file. Stored in `gate_runs` (§3), HTML-escaped on every render. The image has **no cgroup memory files and no `free`**: an optional
   `peakMemMb` is sampled from `/proc/meminfo` (MemTotal minus the minimum MemAvailable, every 0.3 s), as the spike did.

**Verdict.** The runner returns `{ status: 'pass'|'fail'|'error', failureClass, exitCode, phases:{install,test}:{ms,exit,timedOut}, logTail, logSha256, truncated, imageDigest, instance,
counts|null, peakMemMb? }` (zod-validated by the gate, strict). `status` comes only from exit codes, and **the test command is repo-controlled**: `"test":"true"` passes, and a repo can print any summary line.
So the gate proves only "the repo's own test command exited 0 in a clean, network-less container". Rules: `counts` parsed from vitest/jest summary lines are advisory;
`counts.passed == 0` → `fail` (`no_tests`); `counts == null` → still `pass` but `checks.tests = 'unverified'` and the summary `notes` start `pass indistinguishable from no tests`.
Slice 2's merge policy must decide whether `unverified` may merge (D11). Public wording says this.
- **conformance: dropped** (`checks.conformance = 'not_run'`, never a pass; Shadow's comparator is that oracle). **complexity: dropped** (`checks.complexity = 'not_run'`); the legacy
  `complexity_delta REAL NOT NULL` (`schema-inline.ts:122`) is written as `0` with `notes` starting `complexity not measured`, and the UI shows `checks`, not the number.
- **score** (legacy `INTEGER NOT NULL`): `100` on pass, `0` on fail, from the exit code; the weighted aggregate (`:806-845`) is deleted. Legacy summary `status`: `error`/`not_run` → `pending`
  (the CHECK allows only pass/fail/pending, `:118`); the true value is in `gate_runs`.

## 2. The container

**Reuse or add a class?** Add `TestSandbox`, sharing helpers with `BuildSandbox` (extract `guarded`/`stop`/`run` into `workers/sandbox-runner/sandbox-base.ts`, no behavior change).
Reasons: its own application (image build, observability, cost line), and a gate flood cannot occupy `BuildSandbox`'s DO instances; different limits (`BUILD_DEADLINE_MS` 150 s, `:71`, vs 600 s).
Cost: one `[[containers]]` block, one `[exports.TestSandbox]` entry (additive), a second image build (~2 min), an OPS paragraph.

**The policy decides what can be configured.** `workers/sandbox-runner/wrangler.toml:26` uses `scheduling_policy = "durable_object"`. For that policy wrangler allows only `name`, `class_name`,
`scheduling_policy`, `images`, `observability`, `ssh`, `authorized_keys`, `unsafe` and rejects every other key (`wrangler-dist/cli.js:27788-27805`, 4.151.1), so **`instance_type` and `max_instances`
cannot be set**; the size comes only from `ctx.container.start({ instance })` (`build-sandbox.ts:338-343`).

**Size: `standard-2`, chosen on measurement (S2).** One run each of `npm ci` + `npm test` of this repo (`default/beehive` at `589b280`), no network in the test phase; indicative, not statistical:

| | `standard-1` (1/2 vCPU, 4 GiB) | `standard-2` (1 vCPU, 6 GiB) |
|---|---|---|
| `npm ci` | 70.4 s | **10.8 s** |
| `npm test` | 191.6 s (vitest 188.5 s) | **37.4 s** |
| peak memory | 506 MB (`ci`), 438 MB (test) | ~560 MB (`ci`) |
| disk | 342 MB of 8 GB | 342 MB of 11.4 GB (`lite` gives 1.9 GB) |

CPU is the constraint, not memory or disk; `standard-1` leaves little headroom against the 120/300 s limits. Billing: provisioned memory and disk while running, CPU on use.
- **Rule: never `basic`, `dev` or `standard` at runtime; use `standard-2`.** Types disagree on `basic` (`@cloudflare/workers-types` 5.20261018.1 `index.d.ts:4027-4040` has it, the local workerd 1.20261012.1 typings omit it).

**Image and how slice 6 deploys.** Wrangler 4.151.1 **rejects a `docker.io/...` image**: `containers.images.<name>.image` must be a digest-pinned image in the managed registry
(`registry.cloudflare.com/<account>/<repo>@sha256:…`); the 2026-10-24 "no Docker needed for a registry image" note predates that validation. The spike therefore borrowed `BuildSandbox`'s built image.
The real `TestSandbox` image comes from a **Dockerfile built by Workers Builds on the push**, exactly as `BuildSandbox` does (`[containers.images.test] dockerfile = "./Dockerfile"`). So slice 6 is not a
hand-run `wrangler deploy`: it ships with the maintainer's push to the Artifacts repo (all ten workers deploy at once, ~2 min image build), and is the first time the image exists. Measured in the
equivalent `BuildSandbox` image: node v24.22.1, npm 11.19.1, git 2.47.3.

**Cap design: ours, because there is none (S3).** Under the `durable_object` policy, **25 concurrent `lite` container starts all succeeded** in 34 s (first step 0.5-2.2 s); `max_instances` is
unavailable, so nothing platform-side limits cost. Bounded by, in order: (a) the gate queue consumer: `max_batch_size = 1`, `max_concurrency = 2`; (b) a **DO-side counter**, the single
serialization point (AGENTS.md): the start route (§3) counts non-stale `running` rows and refuses with `busy` at 3 globally or 1 per repository; (c) the per-org daily cap and same-sha dedupe (§3);
(d) the alarm backstop and destroy-on-every-path from `BuildSandbox`. The counter counts ledger rows, not containers: a crashed run holds its slot until the 15-minute staleness. **Alternative,
unverified:** the default scheduling policy takes `instance_type` and `max_instances` in wrangler but needs a different start path (a `Container`-class binding, not `ctx.container`); consider it only if (a)-(c) prove insufficient.

**Spikes S1-S5: done 2026-10-28**, in the throwaway worker `spikes/gate-spike/` (maintainer-deployed with an OAuth login; worker, container application and queue deleted afterwards). Full data:
`docs/OPEN-QUESTIONS.md`, entries "Real-gate container spike, results S3, S4, S5" and "…results S1 and S2". The folder is kept as the record; its deploy instructions are obsolete.

| # | Result |
|---|---|
| S1 done | Clone through `ArtifactsGateway` works; `npm ci --ignore-scripts` works through the second intercepted host (199 packages); needs two distinct empty npm config files (§1). |
| S2 done | `standard-2` chosen (table above); install must cover every package CI installs (§1). |
| S3 done | No automatic cap: 25 concurrent starts all succeeded; the cap is ours (below). |
| S4 done | Registry 200, then 403 after replacing the handler on the running container; no data over raw TCP; a connect on 443 is not a signal (§1). |
| S5 done | A 590 s `exec` held over an HTTP request (591.7 s, 200) and inside a queue consumer (590.0 s, exit 0); no wall-clock limit hit. The polling fallback is not needed. |

Locally testable without the account: the zod schemas, the DO migration matrix, all fakes (§7).

## 3. Spec DO changes [SPINE, needs human]

**Numbering.** m12 (`actors.github_user_id` unique index) **shipped 2026-10-27 at `88e40e1`**, so this step is **m13** (D1 done). Steps apply in order and a ledger stamped m13 skips any lower
step (`index.ts:1084` at `bd06419`), so there must be no gap; MR-FLOW's slice 2 is then m14.

**m13 step** (one entry in `runMigrations`, `LATEST_SCHEMA_VERSION = 'm13'` at `:31`): `CREATE TABLE IF NOT EXISTS gate_runs` + indexes, and
`addColumnsIfMissing('candidates', ['preview_url TEXT','preview_worker_name TEXT','preview_created_at INTEGER'])` (`:1112`). `gate_runs` = MR-FLOW §3 row, with: `log_tail TEXT`,
`log_sha256`, `log_truncated` replacing `log_key` (no R2, D4); plus `failure_class`, `exit_code`, `checks` (JSON), `timings` (JSON), `instance`. `status` CHECK(running, pass, fail, error,
not_run). UNIQUE(candidate_id, gate, commit_sha, attempt). **Foreign keys (decided 2026-10-28): `decided_by -> actors` only. `candidate_id` has NO foreign key** (a logical reference; indexed), because `docs/OPS.md` (rollback floor) lets a new table reference only `actors`, so that an m12-floor build over an m13 ledger can still purge. Legacy verdicts get no `gate_runs` row.

**Exactly which files change for the preview columns.** m2 already adds them to migrated ledgers (`index.ts:1040`), and a *fresh* ledger starts at LATEST without running any step (`:623`),
while `workers/spec-do/schema.sql` and `schema-inline.ts` have no `preview_*` columns (no match). So: (1) add the three columns to the `candidates` table in **both** `schema.sql` and
`schema-inline.ts` (`schema-sync.test.ts` keeps them equal): this is what flips the `it.fails` pin (`migration-matrix.test.ts:53`) to `it`; (2) the m13 `addColumnsIfMissing` repairs
existing ledgers that were created fresh at ≤m11 and never ran m2 (a no-op elsewhere); (3) `legacy-ledger.ts:43` derives `LATEST_VERSION` itself; the floor at `:61` rises to 13.

**Routes** (new, zod `.strict()`, schemas in `workers/shared/gate-run-schema.ts` shared by DO and gate; parse pattern `index.ts:2650`; tier-1 DO stub only, not the edge):
- `POST /api/gate-runs` (start) `{ candidateId, gate:'pre-merge', commitSha, decidedBy, terminal?: { status:'error'|'not_run', failureClass } }`. Under `IDEMPOTENT_ROUTES` (`:39-43`) with
  `Idempotency-Key: gate-run:<queueMessageId>` (24 h, `:35`), so a retried message replays its own run. Decision order inside one mutation: (1) **dedupe**: a non-stale `running`, or terminal
  `pass`/`fail`, run for (candidate, gate, sha) → `{ deduped:true, runId }`, no new row (a redelivered push is not a new billed run); `error`/`not_run` rows may be re-run;
  (2) **quota**: runs started for the candidate's **organization** in the last 24 h ≥ 50 → write a `not_run`/`quota` row, return `{ quota:true }`; (3) **caps**: 3 non-stale `running` globally or 1
  in the repository → throw `busy`, mapped to 409 (a throwing mutation leaves no idempotency key, `idempotent()` doc comment); (4) insert `running`, `attempt` = MAX+1 for that sha. **Attempt cap (review 2026-10-28):** `MAX_GATE_RUN_ATTEMPTS_PER_SHA = 10` (`workers/shared/gate-run-schema.ts`), `terminal` rows included: after dedupe, an 11th start on one (candidate, gate, sha), terminal or not, throws and answers **409 `code: 'too_many_attempts'`**, writes nothing and leaves no idempotency key. It is permanent (unlike `busy`), so the gate acks it and does not re-send; it stops a tier-1 caller from growing the table or burning the organization's 50/day on one sha with `terminal` rows.
  A `terminal` body skips (2)-(3) and inserts the finished row (final `error` from the handler on the last attempt). Returns `{ runId, attempt, repo, namespace }`, resolved from the ledger
  (`isValidNamespace`, `workers/shared/namespace.ts:8`), never from the caller.
- `POST /api/gate-runs/:id/result` (finish) `{ status, failureClass?, exitCode?, checks, timings, counts?, logTail?, logSha256?, instance, imageDigest? }`. One `transactionSync`:
  (1) `UPDATE gate_runs … WHERE id = ? AND status = 'running'` (CAS; an identical replay is 200, a different body 409); (2) `INSERT INTO gate_verdicts … ON CONFLICT(candidate_id, gate) DO UPDATE`
  as the latest summary (code change to `createGateVerdict` `:1594`, no schema change), **only if** no later-started run exists for that candidate/gate; (3) `recordHistory`.
- `GET /api/gate-runs?candidateId=` and `GET /api/candidates/:id/gate-runs` for edge/UI/CLI. A `running` run older than 15 min is *reported* `error`/`abandoned` on read (no write); merge checks
  (slice 2) count only terminal `pass`.
- `ORG_PURGE_ORDER` (`:116`): `gate_runs` before `gate_verdicts` (`:120`), scoped by `ORG_CANDIDATES` (as built: after `trials`, before `issues`). Because nothing enforces that order (no candidate FK), the purge plan also adds every `gate_runs` row whose candidate no longer exists (orphans from a floor-build purge) whenever it selects at least one organization. `POST /api/gate-verdicts` (`:4009-4023`) is unchanged for old callers and other gates.

## 4. gate-workflow changes

- Delete: `runUnitTests`, `runPropertyTests`, `calculateComplexityDelta`, `hashCode`, `calculateRawComplexity`, `validateSpecConformance`,
  `aggregateResults`, the in-memory `workflows` Map and the `…/tests`, `…/complexity`, `…/conformance`, status/result GET routes that serve them.
  Replace `generateId` with `crypto.randomUUID()`.
- **Shape (two stages, §8):** the gate worker adds a queue `beehive-gate-runs` it also consumes: `[[queues.consumers]]` with `max_batch_size = 1`, `max_concurrency = 2`,
  `max_retries = 3`, **no DLQ** (nothing would consume it), plus `[[queues.producers]]` and `[[services]] binding = "SANDBOX_RUNNER"`. The maintainer creates the queue before the push
  (as `queue-consumer/wrangler.toml:6-7` documents for its own). Stage 7a adds the consumer and a new bearer-protected `POST /gates/runs` that enqueues, while `POST /gates/pre-merge` keeps
  its old simulated behavior; stage 7b makes `/gates/pre-merge` validate (extra optional `eventId`; the non-strict schema strips unknowns) and enqueue, answering `202`, and deletes the simulation.
  The queue-consumer worker only gains the `isProductionPush` guard (the gate trigger runs on the `beehive-artifacts-push` queue only); it needs no other change (any 2xx is success, `:341`).
- **`queue()` per message** (`message.attempts` is 1-based): `POST /api/gate-runs` (`Response.ok` checked) → `deduped`/`quota`: ack. 409 `busy`: **not a retry** (it would burn the 3
  retries in about three minutes behind a run that can hold the repository 600 s): re-send the same body with `waits+1` via `queue.send(…, { delaySeconds: 120 })` and ack the original; a
  separate wait budget of 20 (~40 min); when exhausted, start with `terminal: { status:'error', failureClass:'busy_timeout' }` and ack. Otherwise → `SANDBOX_RUNNER` `POST /sandbox/test`
  (checked, zod-parsed, 600 s `AbortSignal`) → finish (checked). **Every fetch checks `Response.ok`**, including the write the old code dropped. On an infrastructure failure: if
  `attempts < 4`, `retry({ delaySeconds: 30 × attempts })`; on the last attempt **the handler writes the final `error` row** (finish if a run exists, else `terminal`) and acks. If the
  ledger itself is unreachable then, the message is dropped by Queues; the `running` row (if any) is reported `abandoned` after 15 min. No `Math.random`, no Paseo spawning.
- **Error classes** (`failureClass`):

| Class | Run result | Handling |
|---|---|---|
| `tests_failed`, `no_tests`, `install_failed`, `no_lockfile`, `timeout_install`, `timeout_test` | `fail` | none; a re-push (new sha) or a later manual re-run retries |
| `timeout_overall`, `sandbox_unavailable` (start failed, runner 502/503/404), `clone_failed` | `error` | retry with backoff to 4 attempts, then the final `error` row |
| `busy_timeout`, `quota` | `error`, `not_run` | written by `terminal`; no retry |
| `ledger_unavailable` (DO non-2xx or throw) | none | queue retry; nothing recorded as pass |
| `bad_request` (zod fails) | none | ack and log |

- The dead edge route `POST /api/candidates/:id/gate/pre-merge` (`workers/api/index.ts:1970`; used by CLI `gate run`, `cli/src/utils/api-client.ts:496`, pinned in
  `tests/cli-behavior.test.ts:211` and `workers/api/tests/user-tokens.test.ts:452`) is **left alone** and logged in OPEN-QUESTIONS; `beehive` has no gate binding, so a
  manual re-run is a re-push in slice 1.
- sandbox-runner: `POST /sandbox/test` (`index.ts`, next to `:111`), `TestSandbox`, `NpmRegistryGateway`, a `TEST_ERROR_STATUS` map like `:23-25`,
  `SANDBOX_MODE=stub` returning a fixed `pass` for local e2e. The runner's `handleCloneRepo` simulation (`:358-396`) and the other stubs are untouched
  here (not reachable from the gate; removal is a separate cleanup).

## 5. Edge, API, UI, CLI (minimal) and public claims

- **API:** read-only `GET /api/candidates/:id/gate-runs` and `GET /api/gate-runs/:id` (list/detail incl. `logTail`) on the edge (`workers/api/index.ts`, next to `:241`),
  GET only, no new user-write route. New response fields are opt-in on existing routes (§6).
- **UI:** the candidate page's "Gate Verdicts" table (`ui-pages.ts:808-930`) gains a "Gate runs" table: sha, attempt, status, failure class, checks
  (`conformance: not run`, `complexity: not run`), duration, and the log tail in a `<pre>` (escaped). **CLI:** `candidate gate-runs <id>` beside `candidate gate-verdicts`
  (`cli/src/commands/candidate.ts:40`). Parity rule: API → CLI → UI in the same slice.
- **Public claims, two docs-only commits (D6).** First (step 1, true today): "Simulated". Second (step 9, only after the first approved production run passes): the "real test gate" wording. Targets: About page status row (`api/index.ts:1180-1184` "Live" →
  "Real test gate: installs and runs the repo's tests; conformance and complexity not run"), narrative `:1128-1130`, fast lane `:1100-1101`, ladder rows `:816-818`
  and `:1235-1237` (label conformance/fuzz as design); `README.md:42`, `:251-252`; `docs/ARCHITECTURE.md` §3 (`:120-156`: no property tests, no weighted score, no
  Workflows binding); `docs/OPS.md` (queues, new container class, runbook); `docs/FOCUS.md`, `docs/MILESTONES.md`.

## 6. Mixed-version windows (one push deploys all ten, in no order)

All changes are additive; no worker may require another's new version to *start*, only to *succeed*, and a failure must never record a pass.

| Pair | New caller, old callee | Old caller, new callee |
|---|---|---|
| gate → `beehive` (DO) | `POST /api/gate-runs` 404 → `ledger_unavailable`, queue retry to 4 attempts, then the message is dropped; nothing recorded, never a pass. The old `/api/gate-verdicts` is **not** a fallback. | Old gate (simulated) still posts to `/api/gate-verdicts`: lands in the summary table, no `gate_runs` row, never satisfies a merge. |
| gate → `sandbox-runner` | `/sandbox/test` 404 → `sandbox_unavailable` → retry, then `error`. | The runner's new class/route are unused by an old gate. |
| `queue-consumer` → gate | Stage 7a: no change, the old route still simulates. Stage 7b: 202 instead of 201 + result; the old consumer only checks `ok` and logs. | The `isProductionPush` guard only removes calls; an old gate ignores the difference. A later `eventId` is stripped by the old non-strict schema. |
| edge ↔ DO | One worker (`beehive`), no skew. New GET routes only. | n/a |

Also: the queue must exist before the push that adds the consumer (human); the new container class is an additive `[exports]` entry (never rename/delete a live class, OPS error 10086); a stored `m13` read by rolled-back code is tolerated (`index.ts:1075`).

## 7. Tests

- **Unit, fakes:** `workers/gate-workflow/tests/gate.test.ts` is rewritten (it imports the simulated handler): fake DO stub and fake runner assert start → test → finish order,
  every non-2xx surfaces (retry, nothing recorded as pass), `busy` re-sends with `waits+1` and does not consume `attempts`, the exhausted wait budget and the last infrastructure attempt each write a `terminal` `error` row, `deduped` and `quota` ack without running, each failure class maps as §4, `checks` carry `not_run`, no `Math.random`
  call and no `hashCode`/`aggregateResults` export remain (grep-style assertion on the module source). `workers/sandbox-runner/tests`: a `TestSandbox` fake container
  (pattern `build-sandbox.test.ts:28-60`) for pass, test fail, install fail, missing lockfile, per-phase timeout, log cap/truncation and scrub, `standard-2` passed to `start`, `ulimit`/`timeout` wrapping, two distinct empty npm config files, one `npm ci` per `installDirs` entry (missing lockfile in any → `no_lockfile`), `no_tests` and `unverified` verdicts,
  replacement of both intercepts with the deny handler after install, token never in any command or env, destroy on every path. `NpmRegistryGateway`: GET on the host only, other hosts/methods/redirects denied.
  Fake-timer tests alternate advances with a real macrotask turn (AGENTS.md).
- **DO / migration:** matrix to m13 (A1-A4 over all shapes, incl. a shape that already has the preview columns), flipped preview pin, floor 13, `schema-sync.test.ts`, a replayed
  step, and: same sha after `pass`/`fail` or while `running` → deduped, no row; after `error` → attempt 2 and summary updated; new sha → new row; the 51st org run in 24 h → `not_run`/`quota`; busy at 3 global / 1 per repo leaves no idempotency key; `terminal` inserts a finished row; a late older-sha result does not overwrite; finish CAS and replay/409; start idempotency replay;
  purge over an org with runs; the old verdict route intact; a `running` run past 15 min read as `error`. The `ledger-lifecycle`/`deploy-refs` version assertions use `LATEST_VERSION`.
- **Local integration:** `npm run test:e2e:local` with the stub runner (`SANDBOX_MODE=stub`, `BEEHIVE_LOCAL_DEV=1`) covers push → queue → gate → DO → verdict. This host has no Docker, so
  the **real** container path (install, tests, network phases) was verified by the spike (S1-S5) and is re-verified only by the production run; a Docker script for machines that have it is optional.
- **Production only** (needs maintainer approval per step, AGENTS.md; never e2e against production unprompted): (1) the first run of the real `TestSandbox` image (built by the push, §2) and the timing of the whole `installDirs` install; any egress assertion checks bytes received, never a TCP connect (§1); (2) a fixture repo in a dedicated
  org `gate-trial` (namespace-valid) with one passing and one failing commit; push each, observe `gate_runs` pass, then fail; (3) a commit with a `postinstall` script (must not run) and
  a test that tries `fetch('https://example.com')` (must fail); (4) one forced `sandbox_unavailable` is **not** induced in production. **Cleanup:** tombstone then purge the `gate-trial` org
  and its repo as `beehive-system` (`docs/OPS.md:206`), then confirm `gate_runs` rows are gone; destroy leaves no container running (check `wrangler containers` list, 0 instances).

## 8. Slice breakdown (PR-sized commits, in order)

1. **Done.** Public pages, README and ARCHITECTURE corrected to "Simulated" and merged (`589b280`).
2. **Done.** m12 actors unique index, shipped 2026-10-27 at `88e40e1`.
3. **Done 2026-10-28.** Spike S1-S5 run by the maintainer; results in OPEN-QUESTIONS; the spike worker is deleted.
4. **In progress (`agent/real-gate-slice4`).** Code only, unreachable: `sandbox-base.ts` extraction, `TestSandbox`, `NpmRegistryGateway` and the deny handler, `/sandbox/test` (`installDirs`, two config
   files, `standard-2`), `SANDBOX_MODE=stub`, tests.
5. **In progress (`agent/real-gate-slice5`).** `workers/shared/gate-run-schema.ts` + DO m13 (`gate_runs`, `candidates` columns in `schema.sql`/`schema-inline.ts`/m13, routes, dedupe/quota/caps, summary upsert,
   purge order) + migration tests [SPINE]. Own push; before 7a, so the gate's first call finds its routes.
6. sandbox-runner `wrangler.toml`: a second `[[containers]]` block with only `class_name`, `scheduling_policy`, `images.<name>.dockerfile` (no `instance_type`, no `max_instances`, no `docker.io` image),
   the binding, `[exports.TestSandbox]`, the Dockerfile; OPS paragraph. **Deployed by the maintainer's push (Workers Builds builds the image), not by hand** (§2).
7a. Gate consumer **behind the old path**: queue + `SANDBOX_RUNNER` binding + `queue()` handler + `POST /gates/runs`; `/gates/pre-merge` still simulates. Maintainer creates the queue first.
   Then the **approved production run** (§7) through `POST /gates/runs`.
7b. Switch: `/gates/pre-merge` enqueues; delete the simulation, the Map, the simulated routes, rewrite `gate.test.ts`; the `isProductionPush` guard in `queue-consumer`.
8. Edge GET routes, UI table, CLI `candidate gate-runs`.
9. Public-claims commit (§5, wording includes the "repo's own test command exited 0" limit), `FOCUS.md`/`MILESTONES.md`.

## 9. Decisions for the maintainer (recommendation first)

- **D1 numbering: done** (m12 shipped, this is m13). **D2** second class `TestSandbox`, **D4** DO log column, **D5** conformance/complexity `not_run`, **D6** public wording after the first production run,
  **D7** own queue and consumer, **D8** best-effort counts, **D9** retry classes: accepted as recommended.
- **D3 size and cap: confirmed by measurement.** `standard-2` via `start({ instance })` only; cap = queue `max_concurrency = 2` + DO counter (3 global, 1 per repo) + 50 runs/org/day + same-sha dedupe
  (S3: the platform adds none). Numbers can be tuned after the first production run.
- **D10 spike: done and deleted** (results in OPEN-QUESTIONS 2026-10-28).
- **D11 `unverified` passes** (exit 0, no parsable counts): display-only in slice 1; slice 2's policy decides whether a repo may require verified counts. *Recommend: allow, show it, let the policy tighten.*
- **D12 abuse limits:** 50 runs per organization per 24 h, 1 running per repository, 3 globally, gate trigger from the production push queue only. *Recommend these starting numbers.*
- **D13 `installDirs`:** a per-repo constant in the gate's config (this repo: root, `cli/`, each `workers/*/` with a lockfile), never read from the repo (repo-controlled). *Recommend yes; replaced by `repo_policies.gate` in slice 2.*
