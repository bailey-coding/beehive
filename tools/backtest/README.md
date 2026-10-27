# Backtest harness (docs/SPEC-BACKTEST-PLAN.md)

Standalone; outside every worker's wrangler config, build and tsconfig. Not in the root vitest include, so `npm test`
and CI do not run its tests (CI does not run `test:backtest`; add a step if wanted).

- `npm run test:backtest` / `npm run typecheck:backtest`: fake client only, no model, no network.
- `npm run backtest -- check [--base-green [--write]]`: independence, leakage test 4, and the base test run (npm ci/install of the base's own deps in root and cli/, up to 3 runs, red drops the row, flaky is noted). No model cost.
- `npm run backtest -- freeze --force`: rewrite `docs/backtest/corpus.json` from `pilot-rows.ts` (only before any model run).
- `npm run backtest -- smoke --release-pilot`: one real `claude -p` call in a temp dir, ledgered.
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
