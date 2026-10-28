<!-- Summary of run pilot-2, published by `npm run backtest -- publish`. The full run directory (docs/backtest/runs/) is git-ignored because it holds candidate outputs. -->

# Backtest report: pilot-2

Client: claude-cli. K=3. Started 2026-10-27T21:03:27.083Z, finished 2026-10-27T21:21:25.114Z.
Plan: docs/SPEC-BACKTEST-PLAN.md. Corpus frozen 2026-10-27T03:25:31.320Z. Rows: A2, A11, A4, A5.

> Model-judged numbers below are labelled "same-family grader" (Sonnet 5.5 graded its own family's work; waived for the pilot only). A different-family grader is required for any confirmation run.

## Budget

Calls used 288 (expected 565, hard stop 850).

| role | calls | input tokens | output tokens | cost |
|---|---|---|---|---|
| smoke | 4 | 12471 | 84 | $0.01 |
| issue | 5 | 10749 | 1275 | $0.03 |
| spec | 78 | 1199596 | 53452 | n/a |
| candidate | 125 | 2184732 | 56591 | $2.12 |
| leakage | 68 | 1031451 | 42582 | n/a |
| grade | 8 | 85706 | 1134 | $0.31 |

## Per-row table

| row | tier/obs | status | spec attempts | spec ok | ref acceptance | ref false-rejected | candidates (label, source) | leakage 1/2/3/4 |
|---|---|---|---|---|---|---|---|---|
| A2 `57d91c7` | A/E | spec-failed | 2 | no | - | - | - | -/ok/-/ok |
| A11 `de8817c` | A/N | complete | 2 | yes | 5/5 | no | c1: spec violation (same-family grader); c2: equivalent; c3: spec violation (same-family grader) | ok/ok/ok/ok |
| A4 `831d9db` | A/W | complete | 1 | yes | 2/2 | no | c1: spec-gap (same-family grader); c2: spec-permitted variation (same-family grader); c3: spec-gap (same-family grader) | ok/ok/ok/ok |
| A5 `e326b8c` | A/E | complete | 1 | yes | 2/2 | no | c1: spec-permitted variation (same-family grader); c2: spec-gap (same-family grader); c3: spec-permitted variation (same-family grader) | ok/ok/ok/ok |

- A2: acceptance case "tests/backtest-acceptance/canary-registration-direct.test.ts::canary registration validation on direct calls throws for an unacceptable url and writes nothing" does not pass on a correct implementation of the issue (checked against the real change, whose behaviour is not shown): it asserts something the issue does not require, or uses the wrong entrypoint or layer. Rewrite it to assert only what the issue states, through its public entrypoint.; acceptance case "tests/backtest-acceptance/canary-registration-direct.test.ts::canary registration validation on direct calls throws for an illegitimate candidate id and writes nothing" does not pass on a correct implementation of the issue (checked against the real change, whose behaviour is not shown): it asserts something the issue does not require, or uses the wrong entrypoint or layer. Rewrite it to assert only what the issue states, through its public entrypoint.; acceptance case "tests/backtest-acceptance/canary-registration-direct.test.ts::canary registration validation on direct calls still accepts a valid registration" does not pass on a correct implementation of the issue (checked against the real change, whose behaviour is not shown): it asserts something the issue does not require, or uses the wrong entrypoint or layer. Rewrite it to assert only what the issue states, through its public entrypoint.

## Funnel (candidates clearing each rung)

| row | K run | pre-merge | + conformance | + shadow substitute | clear all | mean probe agreement | any fully agrees |
|---|---|---|---|---|---|---|---|
| A2 | 0 | 0 | 0 | 0 | 0 | n/a | no |
| A11 | 3 | 3 | 3 | 3 | 3 | n/a | yes |
| A4 | 3 | 3 | 3 | 3 | 3 | 1.00 | no |
| A5 | 3 | 1 | 1 | 1 | 1 | 1.00 | no |

## Metrics (tier A, complete rows)

n = 3 complete (+1 spec-failed) of 4 tier-A rows (2 observable-E).

- Rescue rate R: 1 rows (0 confirmed by deterministic oracles).
- Spec-permitted spread S: 2 rows (0 confirmed deterministically).
- Specs passing validators within 1 retry: 3. Reference passes acceptance: 3.
- Spec edit distance (median): 0.00; human minutes (median): 0.7; spec share of per-change cost: 0.30.
- Ladder: catches 0 false positives 0, escapes on E rows 1, reference false-rejects 0. Conformance/shadow rungs ran: yes.
- Escapes found by held-out tests (candidate passed its own tests and the acceptance, fails a held-out test the reference passes; not counted as catches): 6.
- Spec-failed rows (count against A2 as evidence): 1.
- Cost per accepted change: $0.48; same spec with K=1: $0.40.
- Model-judged labels (same-family grader): 8 (spec violation: 2, spec-gap: 3, spec-permitted variation: 3). A human samples 20% of these.

## Decision rule (pre-registered thresholds, tier A only)

| A1 value of N | A2 specs reliable, cheap | A3 oracles replace review (shadow rung) |
|---|---|---|
| inconclusive | inconclusive | inconclusive |

Raw cells if the thresholds were applied to this pilot anyway (not a verdict): A1 invalidating, A2 invalidating, A3 invalidating.

pilot: 4 attempted tier-A row(s) (3 complete, 1 spec-failed) of 11 required, so every cell is inconclusive by rule (plan section 6); the thresholds are the plan's absolute counts over 11 rows. Evidence that rests on the same-family grader alone cannot validate a cell.

A2 clause "spec defects explain most candidate failures" is deliberately NOT implemented: attributing a divergence to a missing or wrong spec clause needs a human trace, so A2 invalidating test here uses only the reference-acceptance and rewrite clauses. Spec-failed rows already count against A2 (they lower the passing counts).

Not run: train, canary, full rungs; fuzz replay (about 200 requests per route); human review of issue texts beyond the approval gate; human sample of graded cases.
