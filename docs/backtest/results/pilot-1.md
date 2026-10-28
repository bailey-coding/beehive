<!-- Summary of run pilot-1, published by `npm run backtest -- publish`. The full run directory (docs/backtest/runs/) is git-ignored because it holds candidate outputs. -->

# Backtest report: pilot-1

Client: claude-cli. K=3. Started 2026-10-27T08:08:30.179Z, finished 2026-10-27T08:29:24.645Z.
Plan: docs/SPEC-BACKTEST-PLAN.md. Corpus frozen 2026-10-27T03:25:31.320Z. Rows: A2, A11, A4, A5.

> Model-judged numbers below are labelled "same-family grader" (Sonnet 5.5 graded its own family's work; waived for the pilot only). A different-family grader is required for any confirmation run.

## Budget

Calls used 156 (expected 565, hard stop 850).

| role | calls | input tokens | output tokens | cost |
|---|---|---|---|---|
| smoke | 4 | 12471 | 84 | $0.01 |
| issue | 5 | 10749 | 1275 | $0.03 |
| spec | 30 | 593003 | 26240 | $0.80 |
| candidate | 68 | 1174552 | 29965 | $1.13 |
| leakage | 49 | 741900 | 28573 | n/a |

## Per-row table

| row | tier/obs | status | spec attempts | spec ok | ref acceptance | ref false-rejected | candidates (label, source) | leakage 1/2/3/4 |
|---|---|---|---|---|---|---|---|---|
| A2 `57d91c7` | A/E | error | 1 | yes | - | - | - | ok/ok/-/ok |
| A11 `de8817c` | A/N | complete | 1 | yes | 0/3 | YES | c1: spec violation; c2: spec violation; c3: spec violation | ok/ok/ok/ok |
| A4 `831d9db` | A/W | complete | 1 | yes | 0/5 | YES | c1: spec violation; c2: spec violation; c3: spec violation | ok/ok/ok/ok |
| A5 `e326b8c` | A/E | complete | 1 | yes | 0/3 | YES | c1: spec violation; c2: spec violation; c3: spec violation | ok/ok/ok/ok |

- A2: Cannot read properties of undefined (reading 'toUpperCase')

## Funnel (candidates clearing each rung)

| row | K run | pre-merge | + conformance | + shadow substitute | clear all | mean probe agreement | any fully agrees |
|---|---|---|---|---|---|---|---|
| A2 | 0 | 0 | 0 | 0 | 0 | n/a | no |
| A11 | 3 | 0 | 0 | 0 | 0 | n/a | no |
| A4 | 3 | 0 | 0 | 0 | 0 | n/a | no |
| A5 | 3 | 0 | 0 | 0 | 0 | n/a | no |

## Metrics (tier A, complete rows)

n = 3 complete (+0 spec-failed) of 4 tier-A rows (2 observable-E).

- Rescue rate R: 0 rows (0 confirmed by deterministic oracles).
- Spec-permitted spread S: 0 rows (0 confirmed deterministically).
- Specs passing validators within 1 retry: 3. Reference passes acceptance: 0.
- Spec edit distance (median): 0.00; human minutes (median): 0.7; spec share of per-change cost: 0.29.
- Ladder: catches 0 false positives 0, escapes on E rows 0, reference false-rejects 3. Conformance/shadow rungs ran: no (no probe records).
- Escapes found by held-out tests (candidate passed its own tests and the acceptance, fails a held-out test the reference passes; not counted as catches): 0.
- Spec-failed rows (count against A2 as evidence): 0.
- Cost per accepted change: n/a; same spec with K=1: n/a.
- Model-judged labels (same-family grader): 0. A human samples 20% of these.

## Decision rule (pre-registered thresholds, tier A only)

| A1 value of N | A2 specs reliable, cheap | A3 oracles replace review (shadow rung) |
|---|---|---|
| inconclusive | inconclusive | inconclusive |

Raw cells if the thresholds were applied to this pilot anyway (not a verdict): A1 invalidating, A2 invalidating, A3 inconclusive.

pilot: 3 attempted tier-A row(s) (3 complete, 0 spec-failed) of 11 required, so every cell is inconclusive by rule (plan section 6); the thresholds are the plan's absolute counts over 11 rows. Evidence that rests on the same-family grader alone cannot validate a cell.

A2 clause "spec defects explain most candidate failures" is deliberately NOT implemented: attributing a divergence to a missing or wrong spec clause needs a human trace, so A2 invalidating test here uses only the reference-acceptance and rewrite clauses. Spec-failed rows already count against A2 (they lower the passing counts).

Not run: train, canary, full rungs; fuzz replay (about 200 requests per route); human review of issue texts beyond the approval gate; human sample of graded cases.
