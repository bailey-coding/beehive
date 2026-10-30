# Backtest harness (docs/SPEC-BACKTEST-PLAN.md)

Standalone; outside every worker's wrangler config, build and tsconfig. Not in the root vitest include, so `npm test`
and CI do not run its tests (CI does not run `test:backtest`; add a step if wanted).

- `npm run test:backtest` / `npm run typecheck:backtest`: fake client only, no model, no network.
- `npm run backtest -- check [--base-green [--write]]`: independence, leakage test 4, and the base test run (npm ci/install of the base's own deps in root and cli/, up to 3 runs, red drops the row, flaky is noted). No model cost.
- `npm run backtest -- freeze --force`: rewrite `docs/backtest/corpus.json` from `pilot-rows.ts` (only before any model run).
- `npm run backtest -- smoke --release-pilot`: one real `claude -p` call in a temp dir, ledgered.
- `npm run backtest -- canary --release-pilot`: at most 3 trivial real calls, ledgered (expected cost roughly $0.02-0.05:
  two ordinary calls like the smoke call, which cost about $0.01, plus one bad-model call that costs nothing). It verifies
  on the real CLI: (1) a Read of an absolute canary file under /tmp, outside the cwd, is refused; (2) the init event's tool
  list has no Bash; (3) the model, asked to quote any CLAUDE.md / memory / user-level instructions, answers NONE;
  (4) a deliberately bad model id surfaces stopReason `error`, a non-zero exit code and the (redacted) CLI error text instead
  of empty output; plus a no-call check that the private config dir holds only the credentials copy. Exit code 1 if any check fails.
- Pilot (spends): `npm run backtest -- pilot --release-pilot --run pilot-1` (optional `--hard-stop N`, max 850), read and approve each
  `docs/backtest/runs/pilot-1/rows/*/issue.json` (`"approved": true`), then rerun the same command. Resumable by artifact.
  Optional human spec fix: `spec.fixed.json` (+ `spec.fixed.meta.json` `{"minutes":n}`) in the row directory before the rerun.

## Isolation and its cost

No OS sandbox exists on the default host (no bwrap/docker/podman), and `--restricted` confines only the file tools.
So candidates and the spec generator get **file tools only (Read/Edit/Write/Glob/Grep), never Bash**, and a scrubbed
child env (PATH, HOME, LANG, TERM, CLAUDE_CONFIG_DIR if set; no API key or token variable). Each agent works in its own
private temp root holding only a single-commit scratch repo, its worktree and a scratch origin: no node_modules, no
reference artefacts, no symlinks out (leakage test 3 scans the whole root). The harness runs all oracles afterwards in
its own roots, with dependencies installed from the base's lockfile.

**Consequence:** candidates cannot run tests or the type checker, so they reason from reading code. This handicaps them and
understates pass rates and divergence (R and S); read every pilot number with that in mind.
`--allow-bash` keeps Bash for candidates but refuses to start unless `bwrap` is on PATH; it relies on Claude Code's
sandbox settings and has not been exercised on this host.

## Private Claude config, sandboxed oracles, one ledger

- Every real call runs with a private `CLAUDE_CONFIG_DIR` and `HOME` (own temp root, 0700) that hold only a copy of
  `~/.claude/.credentials.json` (0600, never read or printed, deleted when the process ends). No CLAUDE.md, settings, memory,
  plugins, skills or history reach any arm, so the user's global instructions cannot contaminate it. Checked without a model
  call: `env -i ... claude auth status` succeeds with this config. The `canary` command verifies it on the real model.
- Agent-written code (candidate tests and config, the spec's acceptance tests) runs only inside an `unshare` sandbox: user, mount,
  pid and net namespaces and a chroot onto a minimal root (no network, no view of the real filesystem, private tmpfs HOME and
  TMPDIR, scrubbed env). The probe runs before any spend; if it fails the harness refuses to run agent code (no fallback).
  Only the base commit's own tests in `check --base-green` run unsandboxed.
- One global ledger, `tools/backtest/.ledger.json` (gitignored, no flag to move it), shared by every `--run` name, `smoke`
  and `canary`: a new run name cannot reset the 850-call cap.
- Failed model calls (auth, bad model, crash) abort the run with the exit code and redacted error text; they never become empty text.

## Spec validators (before any candidate call is spent)

1. Schema, delta-surface parse, every route exists or is `isNew`.
2. Every acceptance case fails on the base, with the probe switched on: `record()` misuse (arguments that are not a
   Request or `{ method, path }` and a Response or `{ status, body }`) is a spec error, not a silent skip.
3. **Against the reference (the real merged change):** every acceptance case must pass, and the reference's recorded responses
   must satisfy the spec's own contract and declared delta surface (compared with base). A failing reference is a spec failure,
   with one retry (shared with the retries above: at most 2 spec generations). The retry prompt names the failing case or probe
   and the kind of problem but never the reference's actual values or assertion messages; those are kept only in
   `spec.meta.json` (`details`) for humans. The oracle is not weakened.

Pilot-1 lessons now covered by tests: the probe helper crashed on plain-object arguments (every acceptance run on a probed row
failed), the sandbox's loopback was down (tests that start a local server, like the CLI row's, failed), and random UUIDs in test
titles made a base test look "missing".

## Bash mode (`--allow-bash`, opt-in per run)

Default: candidates have file tools only. With `--allow-bash` they also get Claude Code's Bash tool, but every Bash command runs
inside `bwrap` through a prefix script (`CLAUDE_CODE_SHELL_PREFIX`), because the claude process itself needs the network and so
cannot be unshared. The invocation (`bashsandbox.ts: bwrapArgs`): all namespaces unshared (no network), read-only `/usr` and the
node toolchain, write access only to the agent's private root (worktree + scratch repo) and a private `/tmp`, empty env with a
private HOME, no home directory, no `~/.claude`, no `.env`, no main checkout, no harness dirs. The agent's `node_modules` is a plain
copy of the harness's own `npm ci` tree, inside its root. `--allow-bash` refuses to start unless `bwrap` is on PATH **and** the
model-independent probe passes (a shell inside cannot read a canary or `.env` outside the root, see HOME, write outside, reach a
host listener or the internet; it can use its own loopback, the root and `/tmp`). The active sandbox is logged and recorded in
`run.json` and the report header (`Candidate tools: ...`); a run id started in one mode refuses to continue in the other.
Unverified until the canary runs: that Claude Code honours `CLAUDE_CODE_SHELL_PREFIX` in the form `prefix <shell> -c <cmd>` assumed here.

## Other commands

- `canary --release-pilot [--allow-bash]`: now up to 4 real calls (the 4th, with `--allow-bash`, asks the model to run `curl`, `cat` of an
  absolute canary file and a write outside the worktree via Bash and report HOME; expected: HOME is the sandbox HOME and all three refused,
  checked host-side where possible). Expected cost: about $0.02-0.05 without Bash, about $0.03-0.08 with it (estimates).
- `sample --run NAME [--n 2] [--seed S] [--template-out FILE]` writes `human-sample.md` (seeded, default seed 20261028: one case per label in the
  order spec violation, spec-gap, regression, ...). The human fills in `A1/A2/A3`, then `sample --run NAME --ingest` writes
  `human-answers.json`, which `metrics.ts` reads (agreement of human and model labels, shown in the report) and regenerates `report.md`.
- `publish --run NAME [--name N]` writes a sanitised summary (no code blocks, tokens or home paths) to `docs/backtest/results/`.
- `docs/backtest/runs/` is git-ignored; `docs/backtest/results/` holds the committed summaries.
- `check --base-green [--write] [--rows A6,A7]`: base test run per row (root and cli/ installed from the base's lockfile).
