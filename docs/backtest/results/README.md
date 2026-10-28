# Backtest results (summaries)

Committed summaries of backtest runs. The full run directories (`docs/backtest/runs/<run>/`: issue texts, specs, candidate
patches and outputs, per-candidate JSON, ledgers) are git-ignored because they are bulky and hold candidate source.

| File | What it is |
|---|---|
| `pilot-1.md` | Report of the first pilot run. Harness bugs (probe helper crash, sandbox loopback, uuid test names) made the acceptance oracle reject the real reference on A4, A5 and A11, so its candidate labels are void: it is kept as the record of what failed, not as evidence. A2 errored. |
| `pilot-2.md` | Report of the second pilot run, after those fixes (A2 failed spec validation twice; A4, A5, A11 completed). Candidate labels are mostly "same-family grader" (Sonnet 5.5 judging Sonnet 5.5); only a human sample makes them evidence. |
| `human-sample-template.md` | The structure of the human review file written by `npm run backtest -- sample` (no candidate or reference source). The real file, with the diffs, stays in the run directory. |

Both reports were produced with the file-tools-only candidate mode (no Bash). They are stripped to summaries by
`npm run backtest -- publish`: code blocks removed, token-shaped text redacted, home paths shortened. Nothing here is a
verdict on the plan's A1-A3: the strict tier is not complete (`docs/SPEC-BACKTEST-PLAN.md`).
