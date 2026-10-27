# Backtest harness (docs/SPEC-BACKTEST-PLAN.md)

Standalone; outside every worker's wrangler config, build and tsconfig. Not in the root vitest include, so `npm test`
and CI do not run its tests (CI does not run `test:backtest`; add a step if wanted).

- `npm run test:backtest` / `npm run typecheck:backtest`: fake client only, no model, no network.
- `npm run backtest -- check [--base-green]`: independence, leakage test 4, optional base test run. No model cost.
- `npm run backtest -- freeze --force`: rewrite `docs/backtest/corpus.json` from `pilot-rows.ts` (only before any model run).
- `npm run backtest -- smoke`: one real `claude -p` call in a temp dir.
- Pilot (spends): `npm run backtest -- pilot --release-pilot --run pilot-1`, read and approve each
  `docs/backtest/runs/pilot-1/rows/*/issue.json` (`"approved": true`), then rerun the same command. Resumable by artifact.
  Optional human spec fix: `spec.fixed.json` (+ `spec.fixed.meta.json` `{"minutes":n}`) in the row directory before the rerun.
