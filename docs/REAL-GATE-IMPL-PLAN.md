---
category: planning
status: draft
audience: human,agent
---

# Plan: real test gate, implementation (MR-FLOW-PLAN slice 1)

**Status:** plan only, branch `agent/real-gate-plan`, 2026-10-26. No code. Implements `docs/MR-FLOW-PLAN.md` §7 and §11 slice 1 on top of
`docs/SANDBOX-BUILD-PLAN.md` and the OPS "Sandbox build container" section. **[SPINE]** = needs the maintainer (AGENTS.md rule 2).
Cites are `path:line` on `main` at `bd06419`. Riskiest assumption: §2 (a larger instance, the no-network test phase, and a 600 s hold all work on the DO path).

## 0. What the grep found (differs from the docs)

- The gate is **synchronous in the HTTP request**: `handleStartPreMergeGate` (`workers/gate-workflow/index.ts:196-287`) runs everything, keeps
  state in an in-memory `workflows` Map (`:209`), and the queue consumer awaits it (`workers/queue-consumer/index.ts:321-345`). No Workflows
  binding, no queue. 600 s inside that await is not viable (the consumer handles up to 100 messages per batch, `wrangler.toml:37`).
- `runUnitTests` is not just a comment: it **returns three hard-coded passing tests** (`:617-646`), `runPropertyTests` two more (`:648-670`).
  Complexity is `hashCode(candidateId)` (`:725`), conformance `Math.random() < 0.1` (`:789`), pass is `score >= 80` (`:834`). `generateId`
  `:179-186` uses `Math.random`. The verdict POST ignores `Response.ok` (`:865-875`). The `…/tests`, `…/complexity`, `…/conformance` routes
  (`:422`, `:493`, `:547`) expose the same simulations.
- `gate-workflow/wrangler.toml` has **no `[[services]]` for `SANDBOX_RUNNER`**, though `Env` declares it (`index.ts:20`): any call would throw.
- The edge route `POST /api/candidates/:id/gate/pre-merge` (`workers/api/index.ts:1970-1979`) forwards to a DO route that does not exist
  (no match in `workers/spec-do/index.ts`): another instance of the 404 bug in AGENTS.md. The queue consumer sends `baseCommitSha =
  commit.sha` when `base_ref` is set (`queue-consumer/index.ts:331`), so a diff-based metric would be wrong. Both stay out of scope (§4).
- `candidates.stage` is never advanced by the gate, and no R2 bucket is bound anywhere (`r2_buckets`: no match), so logs go in the DO (D4). Both unchanged here.

## 1. What the gate runs and returns

Pipeline in one container, one run per (candidate, head sha):
1. **Clone:** the existing `ArtifactsGateway` flow, unchanged: one read token, `git-upload-pack` on one repo, exact 40-hex checkout, hooks
   and symlinks off (`build-sandbox.ts:290-305`). Repo and namespace come from the ledger (the start route, §3), never from the request body.
2. **Install** (≤120 s): require `package-lock.json`, else class `no_lockfile`. `npm ci --ignore-scripts --no-audit --no-fund` with
   `NODE_EXTRA_CA_CERTS=/etc/cloudflare/certs/cloudflare-containers-ca.crt` (`:82`), `NPM_CONFIG_USERCONFIG=/dev/null`,
   `NPM_CONFIG_GLOBALCONFIG=/dev/null`, `--registry https://registry.npmjs.org/`; the repo's `.npmrc` is deleted first. The only egress is a
   **second gateway entrypoint** (`NpmRegistryGateway`) bound to host `registry.npmjs.org`: GET only, path allowlist, `redirect: 'manual'`,
   no `Authorization`, forwarded headers as `build-sandbox.ts:86`. A lockfile entry pointing at any other host gets 403 and fails the install.
3. **Network off:** when install ends, re-register both intercepts (registering again replaces, `:283`) to a deny gateway (403 everything).
   With `enableInternet: false` (`:342`) nothing else is reachable; spike S4 proves it.
4. **Tests** (≤300 s): the command is a constant in the gate's config, default `['npm','test']`, argv only (never `sh -c` with repo text), env
   cleared to `PATH`, `HOME=/workspace`, `CI=1`. Non-root (`node`, Dockerfile). Overall budget 600 s (alarm/deadline pattern of `:203-219`).
5. **Output:** each phase writes to `/workspace/log/<phase>.log` inside the container (`> file 2>&1`), never through `exec().output()`
   buffers; `ulimit -f` bounds the file. The runner reads `tail -c 32768` per phase, scrubs it (`scrub`, `:159`), and returns it with a
   SHA-256 of the **full** capped file. Stored in `gate_runs` (§3), HTML-escaped on every render.

**Verdict.** The runner returns `{ status: 'pass'|'fail'|'error', failureClass, exitCode, phases:{install,test}:{ms,exit,timedOut}, logTail,
logSha256, truncated, imageDigest, instance, counts|null }` (zod-validated by the gate, strict). `status` comes only from exit codes.
- **conformance: dropped** from the pre-merge gate. `checks.conformance = 'not_run'` is recorded, never a pass; specs have no machine-checkable
  conformance at this rung (Shadow's comparator is that oracle, AGENTS.md ladder).
- **complexity: dropped.** `checks.complexity = 'not_run'`. The legacy summary row still has `complexity_delta REAL NOT NULL`
  (`schema-inline.ts:122`): written as `0` with `notes` starting `complexity not measured`, and the UI shows `checks`, not the number.
- **score** (legacy `INTEGER NOT NULL`): `100` on pass, `0` on fail, derived from the exit code. `counts` are best-effort from vitest/jest summary
  lines and `null` otherwise (never guessed). The weighted aggregate (`:806-845`) is deleted.
- Legacy summary `status`: `pass` → `pass`, `fail` → `fail`, `error` → `pending` (the CHECK allows only pass/fail/pending, `:118`); the true
  value is in `gate_runs`.

## 2. The container

**Reuse or add a class?** Add a second class, `TestSandbox`, sharing helper code with `BuildSandbox` (extract `guarded`/`stop`/`run` into
`workers/sandbox-runner/sandbox-base.ts`, no behavior change to `BuildSandbox`). Reasons: `max_instances` and `instance_type` are per container
application, so a gate flood cannot starve canary builds and each has its own cost ceiling; the gate has a different image need (writable
cache, npm) and different limits (`BUILD_DEADLINE_MS` 150 s, `:71`, vs 600 s). Cost: one more `[[containers]]` block, one `[exports.TestSandbox]`
DO entry (additive), a second image build at deploy (~2 min), and an OPS paragraph. Same Dockerfile (esbuild stays; harmless), pinned as today.

**Instance size (maintainer's data, developers.cloudflare.com/containers/platform/limits, 2026-10-21):** lite 1/16 vCPU 256 MiB 2 GB; basic 1/4,
1 GiB, 4 GB; standard-1 1/2, 4 GiB, 8 GB; standard-2 1, 6 GiB, 12 GB; standard-3 2, 8 GiB, 16 GB; standard-4 4, 12 GiB, 20 GB. **Start with
`standard-2`** and measure `standard-1` vs `standard-2` in spike S2 on this repo (peak RSS, disk, wall time). Billing: memory and disk on
provisioned amounts while running, CPU on active use, so a destroyed-after-every-run container bounds cost.

**Point 1: is `basic` accepted at runtime?** Verified in this repo, not in production:
- `@cloudflare/workers-types` 5.20261018.1 (`workers/sandbox-runner/node_modules`, `index.d.ts:4027-4040`) types `ContainerStartupOptions.instance`
  as `"lite" | "basic" | "standard-1".."standard-4" | { vcpu, memoryMib, diskMb }`. Aliases `dev` and `standard` are **not** in it.
- The embedded typings of the local **workerd 1.20261012.1** binary list `"lite" | "standard-1".."standard-4" | ContainerStartResources`: **no
  `basic`** (two copies, one also has `hardTimeout`). So the earlier review is right for that runtime and the docs/newer types are right for
  theirs: the production runtime version decides, and only `lite` has ever been started there (`build-sandbox.ts:340`).
- Wrangler 4.151.1 accepts `basic` in config (`ALLOWED_INSTANCE_TYPES`, `wrangler-dist/cli.js:28923`) and renames `dev`/`standard` with a warning.
- **Decision: never use `basic`, `dev` or `standard` at runtime.** Use `standard-2` (present in every list). The size is passed per start:
  `ctx.container.start({ image, instance: 'standard-2', enableInternet: false })` (the `start()` signature, `index.d.ts:3986`), the same place
  as `:338-343`. The object form uses **camelCase** at runtime (`memoryMib`, `diskMb`), but **snake_case** in wrangler (`memory_mib`, `disk_mb`).

**Point 2: custom instance type on the `durable_object` scheduling path.** Verified: wrangler's deploy normalisation
(`cli.js:204341-204367`, 4.151.1) turns `instance_type` (string or `{vcpu, memory_mib, disk_mb}`) into the application config for **every**
container, with no branch on `scheduling_policy`; unset means `lite`. Config validation (`:28127-28172`) accepts the object form
(numbers only, those three keys). **Not verified:** that the platform honours a runtime `instance` that differs from the application's
`instance_type` for a DO-scheduled container (production has only ever run `lite` against a `lite` application), and that a custom object
works at runtime. Plan: set **both** to the same value (`instance_type = "standard-2"` in the new `[[containers]]` block and `instance: 'standard-2'`
in code) so the design does not depend on override semantics, and let spike S2 test the override as an extra row. Custom types
(≥1 vCPU, ≥3 GiB per vCPU, ≤ standard-4 maxima, e.g. `{ vcpu: 1, memory_mib: 4096, disk_mb: 8000 }`) only if S2 shows `standard-2` over-provisioned (S2b), never a slice-1 dependency.

**Cap design.** `max_instances = 3` on the `TestSandbox` application (defaults to 20, enforced **only in production**, so local tests cannot
see it). Real limiter, in order: (a) gate queue consumer `max_concurrency = 2` (leaves one slot for a retry); (b) DO per-repository rule: the
start route (§3) refuses with 409 `busy` while a non-stale `running` run exists for the repository, and the gate calls `message.retry({
delaySeconds: 60 })`; (c) `max_instances` as the backstop. Instance name `gate-<ns>/<repo>-<sha8>` (as `index.ts:134`). What happens at the cap
(start error vs queueing) is spike S3.

**Spikes before building** (findings go to `docs/OPEN-QUESTIONS.md`; local first, anything on the account needs maintainer approval):

| # | Question | How, safely |
|---|---|---|
| S1 | Does `npm ci` of this repo's own lockfile (v3, esbuild/workerd optional binaries, `--ignore-scripts`) trust the CA via `NODE_EXTRA_CA_CERTS`, and does `interceptOutboundHttps('registry.npmjs.org', gw)` take a bare host and carry npm's tarball GETs? | **Local first:** `wrangler dev` with Docker is not available on this host (OPEN-QUESTIONS 2026-10-24), so a unit test with a fake container proves only the commands. The real answer needs the account: a throwaway worker `beehive-gate-spike` (maintainer deploys it, as Phase 0 did; then deletes it and its container app). Never the ten workers. |
| S2 | Peak memory/disk/time of `npm ci` + `npm test` for this repo on `standard-1` vs `standard-2`; does a runtime `instance` that differs from the app's `instance_type` apply; does a custom object work | Same spike worker, one container class per size, `max_instances = 1`, the repo's own commit as input. S2b (custom object) only if needed. |
| S3 | What `max_instances` does when exceeded on the DO path (error vs wait) | Spike worker with `max_instances = 1`, start two sandboxes. |
| S4 | After the deny re-registration, no egress from the test phase (HTTPS to registry, plain HTTP, raw IP `1.1.1.1`, DNS) | A probe script run as the "test command" inside the spike container. Must pass before any untrusted code runs on the real account. |
| S5 | Does a 600 s call hold over a service binding, DO RPC and a queue consumer invocation; do `exec` calls survive that long | Spike worker with a `sleep 590` run, called from a queue consumer. Fallback if it fails: start returns at once and the gate polls `GET /sandbox/test/:id` (short calls). |

## 3. Spec DO changes [SPINE, needs human]

**Numbering.** m12 (`actors.github_user_id` unique index) is unbuilt and independent: nothing in m13 reads it. Steps apply in order and a ledger stamped
m13 skips any lower step (`index.ts:1084`), so shipping m13 first would burn m12 for good and the actors index would need a
later number; a placeholder `m12` no-op would falsely stamp it done. So: m12 first, own push (D1); if it slips, this step takes m12 and MR-FLOW's m13/m14
shift down, as MR-FLOW §3 already says. Never leave a gap.

**m13 step** (`runMigrations`, one entry, then `LATEST_SCHEMA_VERSION = 'm13'` at `:31`): `CREATE TABLE IF NOT EXISTS gate_runs` + indexes
(also in `schema.sql` and `schema-inline.ts`), and `addColumnsIfMissing('candidates', ['preview_url TEXT','preview_worker_name TEXT','preview_created_at INTEGER'])`
(`:1112`). `gate_runs` = MR-FLOW §3 row, with these changes: `log_tail TEXT`, `log_sha256`, `log_truncated` replace `log_key` (no R2 in slice 1,
decision D4); plus `failure_class TEXT`, `exit_code`, `checks TEXT` (JSON), `timings TEXT` (JSON), `instance`. `status` CHECK(running, pass, fail,
error, not_run). UNIQUE(candidate_id, gate, commit_sha, attempt). `commit_sha` is NOT NULL; legacy verdicts get no `gate_runs` row.

**Routes** (new, zod-validated with `.strict()`, in a new `workers/shared/gate-run-schema.ts` used by DO and gate; the pattern of
`parse()` at `index.ts:2650`; reached only through the tier-1 DO stub, not the edge):
- `POST /api/gate-runs` (start) `{ candidateId, gate:'pre-merge', commitSha, decidedBy }`. The DO checks the candidate exists, `commitSha` is 40-hex,
  resolves repository name and namespace (must pass `isValidNamespace`, `workers/shared/namespace.ts:8`), applies the per-repo `busy` rule, assigns `attempt`
  (new sha → 1, same sha → MAX+1), inserts `running`. Returns `{ runId, attempt, repo, namespace }`. **Idempotent:** add `'POST /api/gate-runs'` to
  `IDEMPOTENT_ROUTES` (`:39-43`; the header is ignored on routes not listed) with `Idempotency-Key: gate-run:<eventId|queueMessageId>`, so a queue
  retry replays the same run instead of making attempt+1. TTL is 24 h (`:35`).
- `POST /api/gate-runs/:id/result` (finish) `{ status, failureClass?, exitCode?, checks, timings, counts?, logTail?, logSha256?, instance, imageDigest? }`.
  One `transactionSync`: (1) `UPDATE gate_runs … WHERE id = ? AND status = 'running'` (CAS; a second identical body replays 200, a different body is 409);
  (2) `INSERT INTO gate_verdicts … ON CONFLICT(candidate_id, gate) DO UPDATE` as the latest summary (a code change to `createGateVerdict`, `:1594`, no
  schema change), **only if** no run of that candidate/gate has a later `started_at` (a late older sha must not overwrite a newer summary); (3) `recordHistory`.
- `GET /api/gate-runs?candidateId=` and `GET /api/candidates/:id/gate-runs` for the edge/UI/CLI. A `running` run older than 15 min is *reported* as
  `error`/`abandoned` on read (no write, no alarm); merge checks (slice 2) count only terminal `pass`.
- `ORG_PURGE_ORDER` (`:116`): add `gate_runs` before `gate_verdicts` (`:120`), scoped by `ORG_CANDIDATES`. This is slice 1's share of the purge order in MR-FLOW §3.
- `POST /api/gate-verdicts` (`:4009-4023`) stays unchanged for old callers and the other gates. The busy check runs before the idempotency wrapper
  (a 409 must never be stored as the key's response).

**Migration tests:** see §7. **Contract:** the `it.fails` pin (`migration-matrix.test.ts:53`) flips to `it`; the floor (`:61`) rises to 13; fixtures need no new
shape (m13 is additive over m11) but each legacy shape gets a `gate_runs`/preview-column assertion; `legacy-ledger.ts:43` derives `LATEST_VERSION` itself.

## 4. gate-workflow changes

- Delete: `runUnitTests`, `runPropertyTests`, `calculateComplexityDelta`, `hashCode`, `calculateRawComplexity`, `validateSpecConformance`,
  `aggregateResults`, the in-memory `workflows` Map and the `…/tests`, `…/complexity`, `…/conformance`, status/result GET routes that serve them.
  Replace `generateId` with `crypto.randomUUID()`.
- **Shape:** `POST /gates/pre-merge` keeps its path and request schema (extra optional `eventId`; non-strict `z.object` strips unknown keys),
  validates, and **enqueues** `{ candidateId, commitSha, eventId?, actorId }` on a new queue `beehive-gate-runs`, answering `202 { success, queued }`.
  The worker adds `[[queues.producers]]` and `[[queues.consumers]]` (`max_batch_size = 1`, `max_concurrency = 2`, `max_retries = 3`, a DLQ
  `beehive-gate-runs-dlq`) plus `[[services]] binding = "SANDBOX_RUNNER"`. The queue consumer worker is **unchanged** (it already treats any 2xx as success, `:341`).
  Queues and DLQ are created by the maintainer first (as `queue-consumer/wrangler.toml:6-7` already documents for its queue).
- **`queue()` handler per message:** start (`POST /api/gate-runs`, `Response.ok` checked, 409 busy → `retry({delaySeconds:60})`) → `SANDBOX_RUNNER`
  `POST /sandbox/test { repo, namespace, commitSha, command }` (checked, zod-parsed, 600 s `AbortSignal`) → finish (`POST …/result`, checked). **Every fetch
  checks `Response.ok`**, including the verdict write the old code dropped; a non-2xx throws to the queue retry. No `Math.random`, no Paseo spawning.
- **Error classes** (`failureClass`) and handling:

| Class | Result | Retry |
|---|---|---|
| `tests_failed`, `install_failed`, `no_lockfile`, `timeout_install`, `timeout_test` | `fail` | none; a re-push or a manual re-run (attempt+1) retries |
| `timeout_overall`, `sandbox_unavailable` (start failed, runner 502/503/404, capacity), `clone_failed` | `error` | `message.retry` with backoff, max 3, then DLQ and a final `error` row |
| `ledger_unavailable` (DO non-2xx or fetch throws) | none written | queue retry; DLQ after 3 |
| `bad_request` (zod fails) | none | ack and log, never retried |

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
| gate → `beehive` (DO) | `POST /api/gate-runs` 404 → `ledger_unavailable`, queue retry (3×, DLQ); nothing recorded, never a pass. The old `/api/gate-verdicts` is **not** a fallback. | Old gate (simulated) still posts to `/api/gate-verdicts`: lands in the summary table, no `gate_runs` row, never satisfies a merge. |
| gate → `sandbox-runner` | `/sandbox/test` 404 → `sandbox_unavailable` → retry, then `error`. | The runner's new class/route are unused by an old gate. |
| `queue-consumer` → gate | Unchanged code. New gate answers 202 instead of 201 + result; the old consumer only checks `ok` and logs the body. | A new consumer (later) adding `eventId`: the old gate's non-strict schema strips it. |
| edge ↔ DO | One worker (`beehive`), no skew. New GET routes only. | n/a |

Also: the queue and DLQ must exist before the push (human); the new container class is an additive `[exports]` entry (never rename/delete a live class, OPS error 10086); a stored `m13` read by rolled-back code is tolerated (`index.ts:1075`).

## 7. Tests

- **Unit, fakes:** `workers/gate-workflow/tests/gate.test.ts` is rewritten (it imports the simulated handler): fake DO stub and fake runner assert start → test → finish order,
  every non-2xx surfaces (retry, nothing recorded as pass), 409 busy retries with a delay, each failure class maps as §4, `checks` carry `not_run`, no `Math.random`
  call and no `hashCode`/`aggregateResults` export remain (grep-style assertion on the module source). `workers/sandbox-runner/tests`: a `TestSandbox` fake container
  (pattern `build-sandbox.test.ts:28-60`) for pass, test fail, install fail, missing lockfile, per-phase timeout, log cap/truncation and scrub, `standard-2` passed to `start`,
  re-registration to deny after install, token never in any command or env, destroy on every path. `NpmRegistryGateway`: GET on the host only, other hosts/methods/redirects denied.
  Fake-timer tests alternate advances with a real macrotask turn (AGENTS.md).
- **DO / migration:** matrix to m13 (A1-A4 over all shapes, incl. a shape that already has the preview columns), flipped preview pin, floor 13, `schema-sync.test.ts`, a replayed
  step, and: re-run of the same sha → attempt 2 and summary updated; new sha → new row; a late older-sha result does not overwrite; finish CAS and replay/409; start idempotency replay;
  purge over an org with runs; the old verdict route intact; a `running` run past 15 min read as `error`. The `ledger-lifecycle`/`deploy-refs` version assertions use `LATEST_VERSION`.
- **Local integration:** `npm run test:e2e:local` with the stub runner (`SANDBOX_MODE=stub`, `BEEHIVE_LOCAL_DEV=1`) covers push → queue → gate → DO → verdict. This host has no Docker, so
  the **real** container path (install, tests, network phases) is verified only by the spike and the production run; a Docker script for machines that have it is optional.
- **Production only** (needs maintainer approval per step, AGENTS.md; never e2e against production unprompted): (1) the spike S1-S6 results; (2) a fixture repo in a dedicated
  org `gate-trial` (namespace-valid) with one passing and one failing commit; push each, observe `gate_runs` pass, then fail; (3) a commit with a `postinstall` script (must not run) and
  a test that tries `fetch('https://example.com')` (must fail); (4) one forced `sandbox_unavailable` is **not** induced in production. **Cleanup:** tombstone then purge the `gate-trial` org
  and its repo as `beehive-system` (`docs/OPS.md:206`), then confirm `gate_runs` rows are gone; destroy leaves no container running (check `wrangler containers` list, 0 instances).

## 8. Slice breakdown (PR-sized commits, in order)

1. docs: correct About/README/ARCHITECTURE to "Simulated" (MR-FLOW §12), separate and first. Not spine.
2. m12 actors unique index (slice 0), own push [SPINE].
3. spike worker and findings S1-S6 (maintainer deploys; not merged code). Gates 6-9.
4. `sandbox-base.ts` extraction + `TestSandbox` + `NpmRegistryGateway` + `/sandbox/test` + stub mode + tests (no wrangler changes yet; unreachable until step 5).
5. sandbox-runner `wrangler.toml`: `[[containers]]` for `TestSandbox` (`instance_type`, `max_instances = 3`), binding, `[exports.TestSandbox]`; OPS paragraph. Human push, own deploy.
6. `workers/shared/gate-run-schema.ts` + DO m13 (`gate_runs`, preview columns, routes, summary upsert, purge order) + migration tests [SPINE]. Own push.
7. gate-workflow rewrite (queue, real run, `Response.ok`, error classes), wrangler queue + service bindings, test rewrite; then the dead edge route and CLI removal.
8. Edge GET routes, UI table, CLI `candidate gate-runs`.
9. Production run (§7), then the public-claims commit (§5), `FOCUS.md`/`MILESTONES.md`.

## 9. Decisions for the maintainer (recommendation first)

- **D1 numbering:** build m12 first as its own push, then this as m13. *Recommend yes.* If m12 slips, renumber this to m12; never stamp a placeholder.
- **D2 second container class `TestSandbox`** (own cap, size, cost) rather than growing `BuildSandbox`. *Recommend yes.*
- **D3 instance and cap:** `standard-2`, `max_instances = 3`, queue `max_concurrency = 2`, app-level and runtime instance equal; never `basic`/`dev`/`standard`. *Recommend yes, revisit after S2.*
- **D4 log storage:** 32 KiB tail in `gate_runs` (no R2 in slice 1) instead of R2 `log_key`. *Recommend the DO column; R2 when logs matter.*
- **D5 conformance and complexity dropped** with `not_run`, no placeholders; the weighted score disappears. *Recommend yes.* Alternative (a real `git diff --numstat` LOC delta) is a later kernel.
- **D6 public wording:** fix to "Simulated" now; change to "real test gate" only after the first approved production run. *Recommend yes.*
- **D7 execution model:** the gate gets its own queue and is its consumer (no Workflows binding, decision 7). *Recommend yes; S5 may force a polling variant.*
- **D8 counts:** best-effort vitest/jest summary parse else `null`. *Recommend yes.*
- **D9 retries:** install and test failures are `fail` with no auto-retry; only infrastructure classes retry. *Recommend yes.*
- **D10 spike worker and its deploy** (S1-S6) approved by the maintainer, deleted afterwards. *Required before steps 4-9 are trusted.*
