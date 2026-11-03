# Plan: comparing agent models on the spec backtest (Sonnet vs Opus; then Mistral Medium and Large)

Task: `model-comparison` | Spec: `docs/SPEC-BACKTEST-PLAN.md` (harness `tools/backtest/`) | Tier: default plan, independent review
before code (the harness holds a sandbox and a spend ledger; no production code changes). Status: **draft, awaiting review.**

Two options, built in order. **Option 1 (cheap)** compares Sonnet 5.5 medium and Opus 5.5 medium through the existing
`claude -p` path. **Option 2 (full)** adds Mistral Medium 3.5 and Mistral Large 4 as candidate arms and a different-family grader.
Option 2 reuses Option 1's arm mechanism, so Option 1 is a strict prefix.

## 1. Facts (checked in `tools/backtest/` at `29f05fc`+)

- **One client does every role.** `RunDeps.client` (`run.ts:34`) serves issue rewrite (`run.ts:105`), spec generation
  (`generate.ts:114`), candidates (`run.ts:326`) and grading (`run.ts:364`). The only real client is `ClaudeCliClient`
  (`client.ts:238`); model and effort are constants (`MODEL = 'claude-sonnet-5-5'`, `EFFORT = 'medium'`, `client.ts:95-96`),
  and the class already takes `opts.model` (`:226, 251`). Effort is not an option today (`--effort` is hard-wired, `:143`).
- **The seam is `ModelClient`** (`client.ts:50`): `name` and `run(req) -> ModelResponse` (text, calls, usage, costUsd,
  stopReason, exitCode, error). `BudgetedClient` (`budget.ts:82`) wraps any client with a per-role call tracker and a global
  ledger (`tools/backtest/.ledger.json`, 288 of 850 calls used).
- **Candidates are the only role where the model is the experiment.** A candidate runs in a throwaway git worktree with file
  tools (`tools: 'agent'`), optionally a bwrap Bash (`--allow-bash`, proven first). Corpus: `docs/backtest/corpus.json`, 10
  strict rows; the plan's decision rule needs 11, so results are inconclusive by construction (FOCUS handoff).
- **Pilot-2 cost for one arm**: 125 candidate calls, $2.12 (`docs/backtest/results/pilot-2.md:19`), on 4 completed rows; the
  plan's estimate is about 105 candidate calls per row at K=3. The labels are "same-family grader" (Sonnet judging Sonnet).
- **Paseo exposes the other models** (`list_models`): `claude`: Opus 5.5 and Sonnet 5.5 with a medium thinking option;
  `mistral-vibe`: `mistral-medium-3.5` (default) and `mistral-large-4-0-3`, no thinking options. Paseo reports no cost per run.
- **Fairness issue in the current shape:** a run regenerates issue text and spec per run, so two runs would differ in spec, not
  just in candidate model.

## 2. Design

### 2.1 Arms (both options)

An **arm** is `{id, candidateClient}`. A comparison run has one **shared front half** and N **candidate arms**:

1. Issue text and spec are generated **once** (Sonnet 5.5 medium, as in the pilot), approved once, and frozen under the run
   directory. Every arm gets identical issue text, spec, acceptance files, base commit and K.
2. Each arm runs the candidate stage only, with its own client, into its own subdirectory (`runs/<run>/arms/<arm>/`), its own
   worktrees and scratch branches (`scratch/<run>/<arm>/<row>-c<k>`), and a per-arm sub-budget in the shared ledger.
3. Oracles are model-free and identical for all arms. Model-judged residue is graded by **one fixed grader** for all arms
   (2.3), with the candidate's arm hidden from the grader prompt.
4. The report adds a per-arm table: accepted changes, per-oracle pass rates, escapes, regressions, calls, tokens, cost per
   accepted change, wall time, and the pairwise differences on the same rows (paired, since rows match).

CLI: `backtest compare --run <id> --arms sonnet-medium,opus-medium[,mistral-medium,mistral-large] --rows ... --k 3` (new
subcommand; `run` keeps its behavior). Arm definitions live in one table (`arms.ts`).

### 2.2 Option 1 (cheap): Sonnet medium vs Opus medium

- `ClaudeCliClient` gains `effort` (default `'medium'`, current behavior) next to `model`. Arms: `sonnet-medium`
  (`claude-sonnet-5-5`), `opus-medium` (`claude-opus-5-5`). No new client, no new dependency, no new sandbox surface: the same
  private config and bwrap rules apply.
- Grader: Sonnet 5.5 as today, **labelled "same-family grader"** for the Sonnet arm and, for the Opus arm, "same-vendor
  grader"; with 10 rows and mostly deterministic oracles the model-judged share is small, and the report states how much of each
  arm's result depends on it.
- Cost: about 125 calls and about $2 per arm for a pilot-sized subset (Sonnet); Opus is more per call (not assumed; the ledger
  records `costUsd` from the CLI and the plan reads it from the first Opus smoke call). Full 10 rows at K=3: about 1,050
  candidate calls per arm. The 850-call ledger cannot hold two full arms; the ledger limit becomes per-run (`--hard-stop`
  exists) and is raised by the maintainer for this run.

### 2.3 Option 2 (full): add Mistral Medium 3.5 and Mistral Large 4, different-family grader

- **New client** `MistralVibeClient implements ModelClient`, shelling out to the Vibe CLI (`vibe`, non-interactive prompt
  mode) in the same private-config style: a private HOME with only the Mistral login/key, a scrubbed environment, the same
  tool allowlist concept (file tools in the worktree, no network tools), the same stop reasons (`done`, `call-limit`,
  `timeout`, `error`) and the same token redaction. **Open (spike S1):** does Vibe have a headless mode with JSON/stream
  output giving usage, a call count and a stop condition, a way to restrict tools to the worktree and deny network, and a
  call/turn limit? The harness's guarantees (leakage control, no user instructions, bounded calls) depend on the answers; if
  Vibe cannot give them, run Mistral arms through Paseo agents instead (2.4) and record the weaker guarantees.
- **Different-family grader** for the model-judged residue: a Claude arm is graded by Mistral Large 4 and a Mistral arm by
  Sonnet 5.5 (cross-grading), or one fixed third-party grader for everyone if one is accepted; the report labels each number
  with grader family vs candidate family. Candidate arm stays hidden from the grader.
- **Effort/thinking:** Mistral has no medium-thinking option; the arm is recorded as "default". The comparison is therefore
  "model at its default agent settings", not equal reasoning budgets; the report says so.
- **Sandbox:** Bash for Mistral arms stays off unless the bwrap proof passes with the Vibe process too; default is file tools
  only, as in both pilots. Arms must use the same tool set to be comparable (all file-tools-only unless all pass the proof).
- Cost: Mistral arms need the maintainer's per-token rates (not assumed); Large 4 and Medium 3.5 token prices differ from
  Claude's. The ledger tracks calls; the report converts tokens at stated rates.

### 2.4 Fallback (either option): Paseo agents as the runner

If a CLI client is not feasible for an arm (Vibe), a `PaseoClient` creates a Paseo agent per candidate in a worktree
(`provider/model` per arm, `modeId: auto`), sends the same prompt, waits for the final message, then the harness reads the
worktree diff. Weaker: no per-call usage, no call limit (timeout only), Paseo's own permission model instead of the harness
allowlist, agent instructions from `CLAUDE.md`/`AGENTS.md` unless the worktree is stripped. Not recommended for the leakage
and instruction-contamination controls; listed so the choice is explicit.

## 3. Threats to validity (stated in the report)

Small N (10 rows, K=3); same corpus as the pilot, whose rows the models may have seen in training or via repo docs
(leakage tests apply per arm); different default reasoning settings across vendors; grader family effects (2.3); candidates
that pass acceptance but differ in quality (human sample, as in the pilot); one fixed spec author (Sonnet) favors Sonnet
arms' reading of the spec; wall-time depends on provider load.

## 4. Order of work and gates

1. This plan + independent review.
2. Option 1: `effort` option, `arms.ts`, shared-front-half freeze, `compare` subcommand, per-arm report, fake-client tests
   (no model, no network; the harness's existing `test:backtest`). Independent code review. Then the maintainer approves a
   run: arms, rows, K, ledger limit, expected cost from a 2-call Opus smoke.
3. Option 2 gate: spike S1 on the Vibe CLI (read-only: `vibe --help`, one smoke call on a throwaway prompt) -> findings in
   `docs/OPEN-QUESTIONS.md` -> client plan amendment -> review -> implement -> run.

## 5. Tests (no model, no network)

Arm table validation; the frozen front half is byte-identical across arms (hash check); per-arm directories and branches do not
collide; the grader prompt never contains the arm id; per-arm ledger accounting and `BudgetExceeded` aborts one arm without
corrupting another's output; fake-client run with two arms yields the paired table; `effort` flag lands in `buildClaudeArgs`;
`MistralVibeClient` (Option 2) arg building, env scrubbing, redaction, stop-reason mapping against recorded fixtures.

## 6. Files touched (Option 1)

`tools/backtest/client.ts` (effort), `arms.ts` (new), `run.ts`/`cli.ts` (compare), `report.ts`/`metrics.ts` (per-arm tables),
`tools/backtest/tests/`, `tools/backtest/README.md`, `docs/backtest/results/README.md`. Option 2 adds `mistralclient.ts`
and its tests.

## 7. Review asks

- Is the shared-front-half design sound (what else differs between arms: seeds, cache, worktree base, time)?
- Does the harness's leakage/instruction isolation survive arms (per-arm private HOME, env)?
- Is the grader policy defensible; is cross-grading better than one fixed grader?
- Anything in `run.ts` that assumes one client (ledger keys, run.json, resume logic)?
- Is Option 2's spike S1 the right first step; is the Paseo fallback worth keeping?

## 8. Decisions for the maintainer

- **M1:** Option 1 first (recommended), then Option 2 after spike S1.
- **M2:** ledger limit and a dollar cap for the comparison run (a new run-level cap beyond the 850-call pilot ledger).
- **M3:** grader policy: cross-grade (recommended) or one fixed grader.
- **M4:** rows: all 10 strict rows, or the 5 pilot rows first.
