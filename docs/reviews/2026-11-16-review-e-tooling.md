---
category: audit
status: active
audience: human,agent
---

# Review, slice e: tooling, CLI, CI and tests (2026-11-16)

This is step 2 of the whole-repo review (context: `docs/reviews/2026-11-15-architecture-map.md`).
- **Reviewer:** an independent Fable agent, read-only, at `42896d8`. Its probes ran the CLI against a fake edge on 127.0.0.1, in a scratch worktree.
- **Checked by the orchestrator:**
  - M2: `--url` has a commander default (`cli/src/index.ts:101`), so `options.apiUrl` is always set and overrides the config file (`cli/src/utils/config.ts:66`).
  - M1: the global `dryRun` is stored (`index.ts:152`), but nothing reads it before a write.
- **Status:** no finding is fixed yet.

**Verdict: request changes.**
- **CLI:** two defects send writes or a token where the user did not intend.
- **Tests:** they stay green while the promotion path's peer workers are broken.
- **Correct:** token storage (0600, atomic, verified before save, `--token-stdin`) and the CLI endpoint paths.

## Must-fix

**M1. `beehive spec claim <id> --dry-run` performs the real claim, and every write ignores the global `-n/--dry-run`.** (`cli/src/index.ts:118`, `cli/src/commands/spec.ts:62-64`, `cli/src/commands/debug.ts:216`)
- The program-level `-n, --dry-run` consumes the flag, so the subcommand's `opts.dryRun` is undefined. Nothing reads `state.dryRun`.
- Probes (each sent the write and exited 0):
  - `spec claim s1 --dry-run` sent `POST /api/specs/s1/claim`;
  - `--dry-run promotion create` sent its POST;
  - `-n org create` sent its POST.
- Against production, a claim creates an Artifacts fork, a candidate and a repo token. `cli/README.md:107, 393` documents both flags as safe.
- History: present since the first release (`bbccf9e`), and no test covers it.
- Fix:
  - Drop the local option.
  - Honor `state.dryRun` in one place: refuse anything but GET in `BeehiveClient.request`.
  - Add a harness test that asserts zero requests.

**M2. The CLI ignores `apiUrl` from the config file and sends the saved token to production.** (`cli/src/index.ts:99-102`, `cli/src/utils/config.ts:66-68`)
- Probe: config `{apiUrl: "http://127.0.0.1:…", apiToken}` and no `BEEHIVE_API_URL`. The CLI reported `API URL: https://beehive.bz23711.workers.dev/api`.
- Scenario: a self-hoster who follows `cli/README.md:449-453` sends their master token to the upstream production worker on every command.
- Tests miss it because the harness always sets `BEEHIVE_API_URL`.
- Fix: remove the commander default (`DEFAULT_CONFIG` already has it), and test with the variable unset.

**M3. Neither CI nor local e2e can fail on a broken peer contract, and one e2e test accepts the bug's symptom as normal.**
- **Five workers never run.** `scripts/start-e2e-workers.sh` starts 5 of the 10 workers plus a probe. gate-workflow, queue-consumer, sandbox-runner, scientist-comparator and candidate-service never run.
- **The real triggers are never exercised.** `tests/e2e` has no call to `/mirror`, `gate/pre-merge`, `/claim` or any queue path. Evidence is seeded through the edge instead (`promotion-fixtures.ts:44-58`: stage PATCH, a verdict with a real actor, samples posted directly).
- **One test accepts the bug's symptom.** `tests/e2e/m3-features.test.ts:542-545` accepts `409 gate_failed` for every merge-train car. That is exactly what b1-M2 produces.
- **Two tests report passes that never ran.** `cross-worker-flows.test.ts:258-261` and `:530-533` return early locally and count as passed, not skipped.
- **No unit test uses the real Spec DO with a real peer.**
  - The unit tests of gate-workflow, queue-consumer, scientist-comparator, shadow-router, preview-manager and candidate-service never use the real Spec DO harness (`spec-do/tests/sqlite-state.ts`).
  - No test wires two real handlers together.
- **The fix is cheap.** In a scratch worktree, 15 lines added to `promotion-worker/tests/advance-flow.test.ts` routed `GATE_WORKFLOW.fetch` to the real gate handler over the real Spec DO. The result was `500 Failed to record verdict` and `/promote` answered `409 gate_failed`, which reproduces b1-M2 end to end.
- Fix:
  - add the contract tests below;
  - make `:544` require a merged car;
  - turn the two early returns into `it.skipIf`.

## Should-fix

**S1. Production e2e can only run by writing the production token into a git-tracked file.** (`tests/global-setup.ts:20, 41`, `.gitignore` `!.env.test.production`, `tests/e2e/README.md:64-66`)
- `dotenv` runs with `override: true` on the tracked file, which holds a placeholder. Probe: a shell `BEEHIVE_API_TOKEN` was replaced by the placeholder.
- The README tells the reader to edit that file and to copy an `.example` file that does not exist. It never mentions `E2E_ALLOW_PRODUCTION`.
- Fix: `override: false`, untrack the file, rewrite the README section.

**S2. `prod-verify-promotion.sh` reports that it restored the mode and passed, even when cleanup failed.** (`scripts/prod-verify-promotion.sh:44-52`)
- It checks only curl's exit status (`-s` without `-f`), so a 401 or 500 still prints "restored".
- A failed tombstone leaves `RESULT` at 0. Production can stay in tournament mode with a live test org while the script exits 0.
- Fix: check `.mode` and `.success` in the response body and set `RESULT=1` on failure. The `prodcheck-<ts>` actor is also never removed.

**S3. Old scripts write to production without asking, pass tokens on the command line, or print token prefixes.** All date from 2026-10-15, and no current doc references them.
- `scripts/test-queue-gate-wiring.sh`: hard-coded production; creates a spec and claims it.
- `scripts/trigger-preview-test.sh`: POSTs to production preview-manager, which writes a made-up preview (b2-S5).
- `scripts/verify-m2.sh`: defaults to production, writes, and calls routes that do not exist.
- `scripts/e2e-test.ts`: hard-coded production. `CF_TOKEN` falls back to the Beehive token, so the master token goes to `api.cloudflare.com`.
- `scripts/start-main.sh:30`, `start-all.sh:49`: echo the first 12 characters of `CLOUDFLARE_API_TOKEN`. `start-all.sh` cannot work at all, yet `.github/workflows/README.md:29` still recommends it.
- Fix: delete them, together with `test-ci-fix.sh`, `start-{gate,queue,sandbox}.sh`, `test-simple.sh` and `test-end-to-end.sh`.

**S4. Every CLI `list` command crashes with `-f table|yaml|compact`.** (`actor.ts:62`, `candidate.ts:31`, `gate.ts:34`, `issue.ts:39`, `org.ts:58`, `promotion.ts:31`, `repo.ts:34`, `spec.ts:51`, `trial.ts:30`)
- `request()` already returns `data`, then the commands read `response.data.length`.
- Probe: all 9 exit 1 with `Cannot read properties of undefined`. The default JSON format works.
- Tests miss it because the harness's default answer is `{success:true,data:{}}` and there is no list test.
- `PaginatedResponse` (`cli/src/types/api.ts:17`) describes a shape no route returns.

**S5. `check-shared-postinstall.mjs` and the CI build loop miss the original failure shape.** (`scripts/check-shared-postinstall.mjs:9, 43`; `ci.yml:68, 76`)
- Two mutations still printed `ok`:
  - removing `workers/canary-worker/package.json` (the 2026-10-16 shape);
  - adding a dynamic `import('../shared/schemas')` to a worker that has no postinstall.
- The CI worker list is hard-coded twice, so an eleventh worker would be neither built nor checked.
- Fix:
  - derive the list from `workers/*/wrangler.toml`;
  - fail when a worker that needs zod has no `package.json`;
  - also match `import(`.
- `builds-watch-paths.json` does match the ten worker names.

**S6. e2e leaves live state behind, and its fixtures depend on bugs other slices want fixed.**
- **Leftovers:** the local DO kept between runs holds 13 deployed canaries, 7 of them for candidate ids not in the ledger, and 15 live `test-org-e2e-*` orgs. The start script reuses `.wrangler/state`.
- **Fixtures that rely on bugs:**
  - deploying canaries for made-up ids relies on slice-a S4;
  - `candidateAt` relies on the stage PATCH (b1-S1).
  - Fixing either breaks e2e.
- **Cleanup doesn't happen.** `promotion-fixtures.ts:4` says purge-by-prefix cleans up, but purge skips orgs that are not tombstoned, and nothing tombstones them.
- Fix:
  - `--persist-to "$(mktemp -d)"`;
  - tombstone and roll back in `afterAll`;
  - deploy canaries only for seeded candidates.

**S7. CI gaps.**
- `npm run lint` is not a CI step, and it reports 6 errors today.
- `test:backtest`, `typecheck:backtest` and the CLI typecheck are not steps. Both typechecks pass. `test:backtest` fails 21 of 175 on a host without `bwrap`.
- Every tsconfig excludes the test files. A strict check of them reports about 255 errors.
- `E2E_UI` is unset in CI, so the UI e2e tests always skip.
- The `migration-tests` job only repeats part of `unit-tests`.
- Workflow hygiene:
  - there is no `permissions:` block;
  - actions are pinned only by major version tag;
  - every PR runs CI twice (`push ['**']` plus `pull_request`).
- The docs-only skip is correct.

## Nits

- `vitest.config.ts:51`: vitest 2 has no `retries` key (it is `retry`), so CI gets no retries. Several other keys there do nothing.
- `global-setup.ts:22-31`: the catch block can never run. `config.ts` ignores the `*_URL` variables, and the staging URLs are made up.
- `fetchWithRetry` retries a POST on a 5xx (`helpers.ts:113`).
- Dead CLI code and silent failures:
  - `cli/src/utils/command-factory.ts` and `types/definitions.ts` have no importer;
  - `bin/beehive` swallows the import error;
  - `auth status` exits 0 when its connection test fails.
- `.github/workflows/README.md` says there is only one workflow; `docs-links.yml` also exists.
- Out-of-date numbers:
  - "Local e2e status" in `docs/SETUP.md` dates from 2026-10-16;
  - `AGENTS-REVIEWER.md` says "38 files, 870+ tests", while the suite is now 93 files and 2314 tests.
- `package.json` still has `deploy:*` scripts, which contradict "deploy only by push".
- `prod-health.sh` sends the master token to whatever host `WORKERS_SUBDOMAIN` names.

## Proposed contract tests

Use real handlers and the real Spec DO on node:sqlite, with foreign keys on and no dev seed. Add one `wire()` helper that maps `SPEC_DO`, `GATE_WORKFLOW` and `PREVIEW_MANAGER` to the real `fetch` handlers. In these files, never use `vi.fn()` for `SPEC_DO` or a peer binding.

| Test | Path | Assert | Catches |
|---|---|---|---|
| 1 | promotion-worker -> gate -> Spec DO | merge-train `/promote` ends with the car merged and one verdict row | b1-M2 (the proof of concept above) |
| 2 | queue-consumer -> gate -> Spec DO | a push for a repository created by `claimSpec` is acked, with one verdict and one history row | b2-M1, b2-S1 |
| 3 | comparator -> Spec DO | a spec created through `POST /api/specs` and one queue message give a `shadow_scores` row | c-M1 |
| 4 | router -> comparator | the message the real `/mirror` handler enqueues, fed into the comparator's `queue()` | c-S7 |
| 5 | CLI -> edge -> Spec DO | every command, in JSON and table format | S4 and future route drift |

Also try adding gate-workflow and scientist-comparator to the e2e stack. It is unverified whether `wrangler dev` delivers queues across processes.

## Known items re-checked

- **2026-11-12** (postinstall, third occurrence): the checker runs in CI and passes; S5's gaps remain.
- **2026-11-03** (CI pre-installs `shared`): still true, and only the checker guards against it.
- **2026-10-16** (`prod-health.sh` is green even when a worker did not redeploy): still true. `/health` reports a constant version.
- **2026-10-15 #5** (m3-features reaches production when a token is set): fixed by the `E2E_ALLOW_PRODUCTION` gate.
- **2026-10-15 #4** (local bindings need their peers running): still true for five workers.
- **2026-10-16** (CLI parity): the fixes hold; all 30 client paths exist at the edge.
- **2026-11-10** (the gate `actorId`): still true, and reproduced through the real gate handler.

## What was run

- `npm test`: 2314 of 2314 passed.
- Typechecks: `npm run typecheck`, `typecheck:backtest` and the CLI `tsc --noEmit` all pass.
- `npm run lint`: 6 errors.
- `npm run test:backtest`: 21 failed, 127 passed, 27 skipped. The failures come from the host's sandbox.
- `check-shared-postinstall.mjs`: ok, but two mutations survived (S5).
- CLI probes, the env-override probe, a strict typecheck of the test files and the gate contract proof of concept, all in a scratch worktree.
- A read-only query of the persisted local DO.
- Not run: e2e, anything that starts workers, the network.
