# Plan: comparing agent models on the spec backtest (Sonnet vs Opus; then Mistral Medium and Large)

Task: `model-comparison` | Spec: `docs/SPEC-BACKTEST-PLAN.md` (harness `tools/backtest/`) | Tier: default plan, independent review
before code (the harness holds a sandbox and a spend ledger; no production code changes).
Status: **rev 2 after Review 1 (approve with changes: B1-B3, S1-S9); dispositions in section 9. Option 2 stays unapproved
until its narrowed spike and a client plan amendment are reviewed. M1-M5 answered (section 8); awaiting the reviewer's verification pass on rev 2. Nothing implemented.**

Two options, built in order. **Option 1 (cheap)**: Sonnet 5.5 medium vs Opus 5.5 medium through the existing `claude -p` path,
on the three rows pilot-2 completed. **Option 2 (full)**: adds Mistral Medium 3.5 and Mistral Large 4 as candidate arms and a
non-Claude grader. Option 2 reuses Option 1's arm mechanism.

## 1. Facts (checked in `tools/backtest/`; no harness file changed since `29f05fc`)

- **One client does every role.** `RunOptions.client` (`run.ts:24,34`) serves issue rewrite (`run.ts:105`), spec generation
  (`generate.ts:114`), the wrong-issue leakage spec (`run.ts:272`, role `leakage`), candidates (`run.ts:326`) and grading
  (`run.ts:364`). The only real client is `ClaudeCliClient` (`client.ts:238`); `MODEL = 'claude-sonnet-5-5'`, `EFFORT = 'medium'`
  (`client.ts:95-96`), `--effort` is hard-wired (`:143`), `opts.model` exists (`:226, 251`). Its `name` is the constant
  `'claude-cli'` (`:239`), so no result records which model produced it (`RunMeta.client`, `run.ts:163`, `results.ts:82`;
  `LedgerEntry` has no arm/model/effort, `budget.ts:15-23`).
- **The seam is `ModelClient`** (`client.ts:50`). `BudgetedClient` (`budget.ts:82`) adds one tracker (sums by role, no per-role
  limit) over a **global ledger** (`tools/backtest/.ledger.json`: 288 of 850 used: smoke 4, issue 5, spec 78, candidate 125,
  leakage 68, grade 8). The cap is deliberate: `--hard-stop` can only lower it (`budget.ts:35-37`, `cli.ts:59`), "a new run name
  cannot reset the 850-call cap" (`README.md:44-45`, `SPEC-BACKTEST-PLAN.md:210`). The resume guard checks only `bashMode`
  (`run.ts:76-79`).
- **Pilot-2 (one arm, Sonnet)**: 125 candidate calls, $2.12 (`pilot-2.md:19`) on **3 complete rows** (A4, A5, A11; A2's spec
  failed): 9 candidate sessions of about 14 calls (about 240k input tokens each), about 42 candidate calls per row, not the
  plan's 105 (`SPEC-BACKTEST-PLAN.md:201`). Front half (issue + spec + leakage-1) about 38 calls per row. 7 of 9 candidates
  cleared every rung; held-out tests are what separated them (6 escapes). Grading: 8 calls, $0.31, labels "same-family grader".
- **Local artifacts**: pilot-2's `issue.json` / `spec.json` for A4, A5, A11 exist under `docs/backtest/runs/pilot-2/rows/`
  (git-ignored). The post-pilot commit `329b715` changed only the spec prompt in `generate.ts`; confirm `94e20af` left
  `candidatePrompt` unchanged before reusing them (section 2.2).
- **Paseo models** (`list_models`): `claude`: Opus 5.5, Sonnet 5.5 with a medium thinking option; `mistral-vibe`:
  `mistral-medium-3.5` (resolves to the moving alias `mistral-vibe-cli-latest`), `mistral-large-4-0-3`, and GLM-5.3 (a
  different family, Mistral-hosted). No cost per run from Paseo.
- **`vibe --help`** (read by the reviewer): `-p` headless, `--output json|streaming`, `--max-turns`, `--max-price`,
  `--max-tokens`, `--enabled-tools` (headless disables all others), `--workdir`, `VIBE_HOME`. **No `--model` flag** (the model
  is set in config), no visible worktree confinement flag, and the binary calls itself a "Rust TUI for Vibe (PoC)".
- **Single-client assumptions elsewhere**: the grader label is a literal string in `results.ts:10,46`, `metrics.ts:58,113,185,211`,
  `report.ts:105` ("Sonnet 5.5 graded its own family's work"), `sample.ts:64,70,135,144,217,231`; `costPerAcceptedChange` and the
  K=1 cost include the front half (`metrics.ts:74-85,117,186`); the report's budget table is the lifetime global ledger
  (`run.ts:168`); residue is graded only for candidates run in the current invocation (`run.ts:297-301, 356`); `eval-${k}`
  (`run.ts:343`) and the leak-blocked `return` (`run.ts:319-323`) assume one arm per row; candidates push to a local scratch
  origin in a temp dir deleted after the row (`git.ts:93-97`, `run.ts:303-308, 378`), so there are no `scratch/<run>/...` refs.

## 2. Design

### 2.1 Arms, inside `runRow`

An **arm** is `{id, model, effort, client}` (table in `arms.ts`, validated: effort in `low|medium|high|xhigh|max`).

1. **Per row, once:** issue text and spec (frozen, approved once; for Option 1 reused from pilot-2, 2.2), deps install, baseline
   report and reference evaluation (the reference is recomputed on every invocation today, `run.ts:285`; A2's base has a known
   flaky test, so computing it once also removes oracle noise between arms).
2. **Per k, every arm, in a seeded order** (so provider load, time of day and prompt-cache warmth are spread across arms): the
   candidate in its own worktree and scratch origin, work dir `…/<arm>/c<k>` (fixes the `eval-${k}` collision). A leak-blocked
   candidate marks that arm/k, not the row.
3. **Paired set** = rows where every arm finished all K candidates; between-arm differences use only the paired set, and
   unpaired rows are reported separately.
4. **Record who produced what.** `run.json`, every ledger entry and every `CandidateResult` carry `{arm, model, effort, cliVersion,
   cliAlias}`. The resume guard refuses a changed arm table, model, effort or CLI version, as it refuses a `bashMode` change.
5. **Grading is a separate pass** over the residue of **all** arms after candidates finish (also fixes the resume gap: residue
   is rebuilt from stored results, not from this invocation's fresh candidates), with the arm hidden from the grader prompt.
6. **Cost per arm = candidate-only** (calls, tokens, cost, wall time, timeouts), built from `CandidateResult.cost`; the front
   half and grading are reported separately, once. The lifetime ledger table is not used for per-arm numbers.

Subcommand: `backtest arms --run <id> --arms sonnet-medium,opus-medium --rows A4,A5,A11 --k 3` (named `arms`, because `compare.ts`
is the oracle labeler). `run` keeps its behavior.

### 2.2 Option 1 (cheap): Sonnet medium vs Opus medium, three rows

- Scope: **A4, A5, A11**, K=3, file-tools-only (no Bash), both arms run fresh and interleaved (2.1.2); the pilot-2 Sonnet
  candidates are not reused (different invocation, uncontrolled order). Front half reused from pilot-2's frozen files
  (zero front-half calls); copy them into the new run directory with their hashes recorded.
- Cost: about 42 calls per row per arm, so about 250 candidate calls for 2 arms x 3 rows x K=3, plus at most 18 grader calls
  (3 rows x 3 candidates x 2 arms, fully crossed 2.3 doubles this to 36 if every item is graded by both): **about 270-290 calls
  against 562 remaining**, so no cap change. Opus dollar cost is not assumed: it is read from **one Opus candidate on one row**
  (about 14 calls) before the rest runs. The run has a dollar cap that **fails closed when `costUsd` is null** (spec and leakage
  costs were "n/a" in pilot-2). M2.
- Isolation: a fresh private config per client (under `--allow-bash`, `shell-snapshots/` appears in the config dir,
  `client.ts:275`, and would fail canary check 1); the **canary runs for the Opus client too** (3 calls; check 2 tests model
  behaviour).
- Endpoints are pre-registered, **deterministic and primary**: clear-all rate, held-out tests passed, deterministic
  regressions, escapes, candidate calls/tokens/cost, wall time, timeouts. Model-judged labels are secondary. With 3 rows the
  report is **descriptive: no superiority claim**.
- `effort` becomes an option on `ClaudeCliClient` (default `'medium'` = today's behavior).

### 2.3 Grader policy (replaces cross-grading, Review 1 B3)

Cross-grading (Claude arms graded by Mistral, Mistral arms by Sonnet) confounds arm with grader. Instead:

- **Fully crossed**: every residue item is graded by each grader family available (Option 1: Sonnet 5.5 and Opus 5.5; Option 2:
  a Claude grader and a Mistral grader). Both labels are reported with their agreement; between-arm comparisons use only items
  where graders agree, or report each grader's table side by side. Grader labels never appear in an arm comparison as a single
  number. Grading is cheap (8 calls, $0.31 in pilot-2).
- Labels: the `GraderTag` literal is replaced by a structured `{grader, family, sameFamilyAsCandidate}` carried through
  `results.ts`, `metrics.ts`, `report.ts`, `sample.ts` (all listed in 1), so the new tags do not silently drop out of
  `escapesModelJudged`, the `graderLabelled` counts or the human sample.
- The pilot's "same-family grader" waiver covers the pilot only (`SPEC-BACKTEST-PLAN.md:9-11`). **M5 below extends or replaces
  it for this experiment.**
- The human sample hides the arm and is stratified per arm (`sample.ts:64,144` now read only
  `runs/<run>/rows/<id>/candidates`; the per-arm layout needs the `sample` and `publish` paths updated).

### 2.4 Option 2 (full): Mistral Medium 3.5 and Mistral Large 4 (not approved)

Gate: a **narrowed spike S1** and a client plan amendment, each reviewed, before any code.

- **S1 (small; `--help` already answered most of it):** one Vibe smoke call to capture the JSON shape (usage, turns, stop
  reason, how the model is selected from a private `VIBE_HOME` config) and a port of canary check 1 (can a file tool read outside
  the worktree or `.env`?). Findings go to `docs/OPEN-QUESTIONS.md`.
- **Client** `MistralVibeClient implements ModelClient`: private `HOME` and `VIBE_HOME` are mandatory (the user's
  `~/.vibe/AGENTS.md` is a symlink to their global agent instructions and would contaminate the arm); the model set in the
  private config; the credential a **file inside the private `VIBE_HOME`** (the harness passes no key variables,
  `client.ts:98-107`); `TOKEN_PATTERNS` (`client.ts:109-117`) extended for the Mistral key shape; `-p --output json --max-turns
  --enabled-tools <read/edit allowlist> --workdir`; CLI version pinned and recorded; the moving alias `mistral-vibe-cli-latest`
  recorded with the resolved model id when the CLI reports it.
- No thinking option: those arms run at defaults and the report says so (not equal reasoning budgets).
- Arms must use the same tool set to be comparable: file-tools-only unless every arm passes the bwrap proof.
- **No Paseo-agent fallback for results** (Review 1 S6): `SPEC-BACKTEST-PLAN.md:188` requires a subprocess, and Paseo agents
  load the user's global `AGENTS.md` ("every task ends with a push"), which breaks instruction isolation. If a Paseo-run arm is
  ever wanted, label it non-comparable.
- Cost: Mistral token rates are the maintainer's input; the dollar cap applies.

## 3. Threats to validity (stated in the report)

Three rows x K=3 (descriptive only); the rows are this repo's history, which the models may have seen (leakage test 3 runs per
candidate; tests 1, 2 and 4 are in the shared front half); Sonnet wrote the spec for everyone and may favor its own reading;
CLI/alias drift (recorded); timeouts hit slower models harder (same cap, reported per arm); no sampling seed control (K is the
only variance handle); ceiling effect (7 of 9 pilot candidates cleared every rung), so held-out tests are the discriminator.

## 4. Order of work and gates

1. This plan, revised, re-verified by the reviewer after the maintainer answers M1-M5.
2. Option 1: `effort` option, `arms.ts`, the `runRow` arm loop, run metadata and resume guard, candidate-only metrics, fully
   crossed grading pass, structured grader tags, per-arm report, `sample`/`publish` layout, tests (no model, no network;
   `npm run test:backtest`). Independent code review.
3. Run gate (maintainer): arms, rows, K, dollar cap from one Opus candidate, canary on both clients.
4. Option 2: S1 -> findings -> client plan amendment -> review -> implement -> review -> run.

## 5. Tests (no model, no network)

Arm table validation (effort set, unique ids); front half byte-identical across arms (hash); seeded interleaving order and
work-dir/branch separation; leak-blocked in one arm leaves the other; paired-set filtering; resume refuses a changed arm table /
model / effort / CLI version; `run.json`, ledger entries and `CandidateResult` carry arm, model, effort, CLI version; per-arm cost
excludes the front half and grading; grading pass after a resume covers all arms' residue; the grader prompt never contains the
arm id; new grader tags flow through `metrics`, `report` and `sample`; `sample`/`publish` work with the per-arm layout and the
human sample hides the arm; the dollar cap fails closed on null `costUsd`; `effort` lands in `buildClaudeArgs`; existing
`pipeline.test.ts:281,303` assertions updated. Option 2 adds: `MistralVibeClient` arg building, env scrubbing, redaction and
stop-reason mapping against recorded fixtures.

## 6. Files touched (Option 1)

`tools/backtest/client.ts`, `arms.ts` (new), `run.ts`, `cli.ts`, `results.ts`, `budget.ts` (entries), `metrics.ts`, `report.ts`,
`sample.ts`, `publish.ts` (layout), `tools/backtest/tests/` (incl. `pipeline.test.ts`), `tools/backtest/README.md`,
`docs/backtest/results/README.md`. Option 2 adds `mistralclient.ts` and tests.

## 7. Review asks (rev 2)

- Is the in-`runRow` arm loop with a separate grading pass free of the single-client assumptions in section 1; anything missed?
- Is fully crossed grading with structured tags enough, and is "report both graders" too heavy for 3 rows?
- Is reusing pilot-2's frozen front half safe (prompt unchanged since `94e20af`; hashes)?
- Is the call estimate (about 270-290) right, and does the dollar cap work with `costUsd` null for some roles?

## 8. Decisions for the maintainer (answered 2026-11-03: "your recommendations")

- **M1: Option 1 first, then Option 2 after the narrowed S1.** Accepted.
- **M2: dollar caps that fail closed on unknown cost.** Accepted 2026-11-03 as the proposed figures below; **re-stated at the
  run gate** after the one-Opus-candidate probe and a check of the vendors' own price pages (the inputs are aggregator listings).
  - Option 1 (Sonnet + Opus, crossed grading by both): typical about $8, **hard cap $15**.
  - Option 2 (all four arms, one run): typical about $16, worst about $28, **hard cap $40 combined**; sub-caps Sonnet $5,
    Opus $15, Mistral Medium 3.5 $8, Mistral Large 4 $8, grading $4. An arm that hits its sub-cap aborts alone.
  - Basis (per 9 candidate sessions, 3 rows x K=3): Sonnet measured $2.12 (pilot-2); Opus 5.5 at $4/$20/$0.20 per M
    (input/output/cache read) assumed about $0.47 per session; Mistral Large 4 $1.36/$4.18/$0.14 and Medium 3.5 $1.50/$7.50/$0.15
    per M at pilot-2's token volume with a 1.5x margin; grader about $0.04 per call. Where the CLI reports no `costUsd` (Mistral),
    cost = tokens x a rates table in `arms.ts`; with tokens missing too the arm aborts.
- **M3: fully crossed grading.** Accepted (one fixed non-Claude grader stays an Option 2 alternative).
- **M4: rows A4, A5, A11.** Accepted (all 10 would need a ledger-cap plan amendment and issue-text approvals).
- **M5: the pilot's same-family-grader waiver is not extended;** Option 1 uses the crossed design.

## 9. Review 1 dispositions (independent agent, approve with changes)

| # | Finding | Disposition |
|---|---|---|
| B1 | Budget mechanism does not exist; front half uncounted | Accepted: Option 1 fits the existing 562 remaining calls with no cap change (2.2); a run-level dollar cap is a new decision (M2); a larger run needs a plan amendment to the 850 cap, not a flag |
| B2 | Nothing records the producing model; resume can mix models | Accepted: 2.1.4 |
| B3 | Cross-grading confounded | Accepted: replaced by fully crossed grading (2.3), M3 |
| S1 | Front half placement, oracle noise, collisions, branch wording | Accepted: 2.1 (arm loop in `runRow`, shared baseline/reference, seeded order, paired set); branch claim removed |
| S2 | Metrics assume one arm; ceiling effect | Accepted: candidate-only costs, pre-registered deterministic endpoints (2.1.6, 2.2) |
| S3 | Grader label literal across files; sample layout | Accepted: 2.3, section 6 |
| S4 | Residue graded only for fresh candidates | Accepted: separate grading pass (2.1.5) |
| S5 | Isolation per client; Vibe needs private HOME/VIBE_HOME, credential file, redaction, canary port | Accepted: 2.2 (canary for Opus), 2.4 |
| S6 | Drop the Paseo fallback | Accepted: 2.4 |
| S7 | Pilot waiver does not cover this | Accepted: M5 |
| S8 | Option 1 is cheap only on the pilot rows | Accepted: 2.2 scope A4/A5/A11, reused front half, one-candidate Opus cost probe |
| S9 | Missing tests | Accepted: section 5 |
| Nits | `RunOptions` name, leakage role, "3 complete + 1 failed", `compare` clash, effort validation, leakage tests per arm | Accepted: applied above |
