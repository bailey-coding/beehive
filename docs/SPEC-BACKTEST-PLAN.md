# Spec backtest plan (2026-10-26)

PLAN ONLY. Nothing here has been run; no model spend. Read-only git analysis of `main` at `c8902e5`
(317 non-merge commits, 29 merges, all agent-written). Maintainer direction 2026-10-26: validate the
idea; riskiest assumptions are **A1** teams want N implementations of one change, **A2** specs can be
written reliably and cheaply (contract, acceptance tests, declared delta surface), **A3** traffic/oracle
evidence can stand in for review for observable stateless changes.

Backtest in one line: for each historical change, generate a spec from the issue text alone, have K agents
implement it on the base commit, run the oracles, and compare with what was actually merged.

## 0. What exists today (verified in code, 2026-10-26)

- Spec = `CreateSpecRequestSchema` (`workers/shared/schemas.ts:134`): `name`, `description?`, `contract: string`,
  `declaredDeltaSurface: string[]`. **There is no acceptance-test field.** The gate parses `contract` as JSON
  `{endpoints?, models?, workflow?}` (`workers/gate-workflow/index.ts:77,244`).
- Delta surface format: JSON `version "1.0"` with `paths.<route>.{statusCodes, response.body.{allowedDiffs,
  forbiddenDiffs,newFieldsAllowed}, performance}` and `defaults` (`docs/SCIENTIST-COMPARATOR-PLAN.md:120`,
  `workers/scientist-comparator/delta-surface/parser.ts`). The Spec DO stores the array as JSON text
  (`workers/spec-do/index.ts:1336`) while the comparator's `parseDeltaSurface` wants one object: the two
  shapes may disagree. Verify in step 1 of section 6; if they do, write a finding in `docs/OPEN-QUESTIONS.md`.
- **The pre-merge gate is mostly simulated.** `validateSpecConformance` draws a 10% random warning,
  complexity is a hash of the candidate id (`gate-workflow/index.ts:700-775,783`), and the sandbox runner's
  execute/push paths are stubs (`sandbox-runner/index.ts:440-530`; the container build path is real, see
  `docs/SANDBOX-BUILD-PLAN.md`). Consequence: **the backtest cannot use the platform's own pre-merge gate as
  its oracle.** It needs a standalone harness (section 6) and reports separately what the real gate would add.

## 1. Corpus selection method

Source: `git log main --no-merges` (merge commits are noise; the work is in the `step:` commits). Filters, in order:

1. Touches at least 1 non-test source file under `workers/`, `cli/src/` or `ui/src/` AND at least 1 test file.
2. At most 12 files, 30 to 700 added+deleted lines (leaves 73 of 317).
3. Exclude pure docs/FOCUS churn, spine-heavy work (Spec DO schema/migration design, promotion train, Workflow
   sequencing; rule 2 of `AGENTS.md`), and "review fixes" whose meaning needs the commit they fix.
4. Keep only changes whose intent is recoverable from the one-line commit message plus the linked `spec:` doc.
5. Classify observability: **E** = visible as an HTTP status/body/header at a worker edge (usable for
   conformance and delta-surface diff); **W** = visible only worker-to-worker, via timing, or via config (weak
   for A3); **N** = not HTTP-observable (CLI, migrations): control group, tests-only oracle.
6. Freeze the list (sha + base sha) in `docs/backtest/corpus.json` before any model runs. No swaps afterwards.

Columns: files = files touched incl. docs, +/− lines, code/test = source and test files touched. All rows changed
tests.

| # | sha | date | files / lines | code/test | obs | change |
|---|---|---|---|---|---|---|
| 1 | `6d1771a` | 10-26 | 3 / +30 −3 | 1/1 | E | issue POST origin check → 403 |
| 2 | `877e8bd` | 10-17 | 4 / +52 −7 | 1/1 | E | issue pages 405 on PUT/DELETE/PATCH |
| 3 | `3d198da` | 10-25 | 6 / +70 −19 | 2/2 | E | org name must be an Artifacts namespace → 400 |
| 4 | `46c9667` | 10-16 | 5 / +84 −4 | 3/2 | E | tombstone/purge of `beehive-system` → 403 |
| 5 | `bcca5bc` | 10-17 | 5 / +130 −1 | 3/2 | E | PATCH issue status close/reopen (new route) |
| 6 | `b88422a` | 10-17 | 4 / +115 −0 | 1/2 | E | issue writes need an existing non-service actor |
| 7 | `65ab327` | 10-17 | 3 / +81 −18 | 1/2 | E | issue routes: bad JSON, null, missing fields → 400 |
| 8 | `37e16fd` | 10-17 | 2 / +185 −25 | 1/1 | E | comment-policy PATCH maintainer-only; comment rules |
| 9 | `b024272` | 10-15 | 2 / +44 −1 | 1/1 | E | `/roadmap` added to public endpoints |
| 10 | `57d91c7` | 10-25 | 5 / +56 −16 | 2/2 | E | Spec DO validates canary candidate ids/urls |
| 11 | `3bdddd9` | 10-25 | 5 / +33 −6 | 2/2 | E | canary client returns 400 instead of throwing |
| 12 | `03c9c31` | 10-26 | 6 / +66 −13 | 3/1 | E | purge fails closed without PREVIEW_MANAGER |
| 13 | `bf256d0` | 10-26 | 5 / +80 −23 | 1/2 | E | 501 from preview manager aborts purge |
| 14 | `97f04cc` | 10-26 | 5 / +50 −20 | 2/1 | E | purge fails closed on an older Spec DO |
| 15 | `995bd22` | 10-18 | 8 / +310 −27 | 2/6 | E | actor lookup without the 500-row limit |
| 16 | `0cb219f` | 10-23 | 4 / +159 −30 | 2/2 | E | zod-validate master X-Actor-ID → 400 |
| 17 | `c2d4906` | 10-23 | 4 / +46 −7 | 3/1 | E | master without X-Actor-ID reaches `/health` |
| 18 | `3790070` | 10-16 | 3 / +305 −106 | 2/1 | E | UI comment form posts to the right route |
| 19 | `fd889c3` | 10-25 | 9 / +54 −6 | 5/2 | W | canary urls pinned to the account workers.dev subdomain |
| 20 | `94860d4` | 10-17 | 5 / +216 −47 | 3/2 | W | issue numbers assigned atomically (concurrency) |
| 21 | `831d9db` | 10-24 | 2 / +52 −2 | 1/1 | W | SLO thresholds never NaN |
| 22 | `746c42c` | 10-16 | 8 / +420 −24 | 4/2 | W | shadow-router TTL cache of live deploy refs |
| 23 | `c0cfa86` | 10-25 | 7 / +160 −36 | 2/2 | W | canary recorder flushes burst tail via waitUntil |
| 24 | `55886a4` | 10-16 | 3 / +217 −140 | 1/2 | N | failed Spec DO migration step fails loudly |
| 25 | `adb86bd` | 10-18 | 3 / +133 −1 | 1/1 | N | Spec DO tolerates a newer stored schema version |
| 26 | `2586c80` | 10-17 | 6 / +56 −13 | 4/1 | N | CLI `--actor` on more commands |
| 27 | `de8817c` | 10-23 | 4 / +31 −6 | 1/1 | N | CLI rejects actor ids the edge would 400 |
| 28 | `4f38f78` | 10-26 | 3 / +40 −7 | 2/1 | N | CLI config save follows a symlink |

Composition: 18 E, 5 W, 5 N. Rows 1-18 carry A3; 19-23 probe weak-observability changes; 24-28 are the control
group with no edge oracle. Base sha is `<sha>^`; record it and confirm it is the true pre-change state. Before the
freeze, per row: base builds and `npm test` is green (red drops the row), and `docs/` at the base is grepped for
the change's key terms (leak check). Known leak: row 1's base already has "Origin check before every DO read"
(`docs/AGENTS-REVIEWER.md:68`); scrub or drop such rows.

## 2. Spec to generate, and leakage control

**Input to the spec generator (only this):** (a) an *issue text* and (b) read access to the base-commit tree
(it must see existing code to write a contract, as a real spec author would). **Never** the diff, the merge,
later commits, tests added by the change, or `git log` past the base.

**Issue text** is built from the one-line commit subject, the body, and the `spec:` doc clause it cites, then
rewritten by a model call told to "state the problem and the observable behaviour wanted; do not name files,
functions, or the mechanism". A second reader (human, 2 min/row) deletes any remaining solution words. The
rewrite is saved in the corpus file and is what every arm sees. Rows whose issue text cannot be made
mechanism-free are dropped, not softened.

**Spec output**, one JSON file per change, mapped onto the existing API with no spine edits:

```
name, description                     -> CreateSpecRequestSchema
contract (JSON string)                -> endpoints[{method,path,request,responses[{status,body shape}]}], models, rules[]
acceptance[]                          -> NEW, backtest-only: executable vitest cases (request in, assertion out),
                                         authored against the base commit's existing test helpers; must FAIL on base
declaredDeltaSurface (v1.0 JSON)      -> paths touched, statusCodes allowed/forbidden, body diffs allowed,
                                         newFieldsAllowed, plus everything else frozen (defaults)
out_of_scope[]                        -> behaviours that must not change
```

The delta surface names which routes may change and which status/body fields may differ; unlisted means frozen.

**Validators on the spec itself, before any candidate runs (cheap, mechanical):**
1. JSON parses and passes `CreateSpecRequestSchema` plus `parseDeltaSurface`.
2. Every `acceptance` case runs against the base commit and FAILS (it tests something new); a spec whose cases
   pass on base is vacuous.
3. Every route in `contract` exists or is declared new.

**Leakage tests (pilot):** (i) feed the generator a *wrong* issue text and require a different spec; (ii) flag
identifiers in the spec that appear in the held-out diff but not in the issue text or base tree; (iii) run agents
in a single-commit checkout (no history) with the merged diff kept outside any mountable path; scrub `docs/`
lines added after the issue (e.g. `FOCUS.md` "done" entries).

## 3. Experiment, per change

1. **Spec arm.** Generate spec S (1 call, plus 1 retry on validator failure). Log tokens and wall time.
   Optionally a human fixes S; keep both versions and the edit distance (A2).
2. **Candidate arm.** K = 3 independent agents (K = 5 for the 8 most interesting rows), same model for
   a first pass, a second model for diversity on the pilot. Each gets: base checkout, S (contract,
   acceptance, out_of_scope), the issue text, the repo's `AGENTS.md`. Each works in its own checkout and ends with
   a push to `scratch/*` (always-pushed invariant), 40-turn cap.
3. **Oracles, in ladder order** (what is run is listed in section 6):
   - Pre-merge: repo's existing tests + the spec's `acceptance` + `tsc`; fail = candidate does not board.
   - Conformance: replay `contract` requests against the candidate under Miniflare, check status/shape.
   - Shadow substitute: replay a fixed request corpus (the change's tests' requests + a generated fuzz set of
     about 200 requests per route) against base and candidate; run the Scientist comparator logic with S's
     delta surface. This stands in for mirrored traffic; it is synthetic, see section 7.
   - Train/canary/full: **not run** in the backtest (needs production, section 6).
4. **Reference arm.** The real merged diff runs through the same oracles and corpus: ground-truth behaviour, and a
   calibration check (an oracle that rejects the real change is miscalibrated).
5. **Behavioural comparison** of each candidate with the reference and with each other: response diff on the
   replay corpus by (route, status, body shape). Textual diff is recorded, not used.
6. **Ladder-catch check:** full pre-existing suite plus replay diff on out-of-scope routes.
7. **Blind grading** (a different model plus a 20% human sample) labels each divergence {equivalent,
   spec-allowed, regression, better-than-reference, spec-gap}.

## 4. Metrics

Per change, then aggregated with the median and the full per-row table (n is small, no averages alone).

- **Spec authoring cost:** input+output tokens, model calls, wall time, retries to pass validators; **human edit
  distance** = normalised token Levenshtein between generated and human-fixed spec, plus minutes spent; **spec
  defect count** found later (a defect = a candidate or reference divergence traced to a missing/wrong spec
  clause). Reference: cost to write the same spec by hand (maintainer times 3 rows).
- **Candidate pass rate per rung:** fraction of K that clear pre-merge, conformance, shadow-substitute; reported
  as rung funnel counts. Also `acceptance` pass rate on the reference diff (spec validity check).
- **Agreement with merged change (behavioural):** share of replay requests where candidate and reference
  agree on status+body (modulo the delta surface); report per candidate and as the fraction of changes where at
  least one of K agrees fully.
- **Candidate divergence (does N>1 help):** pairwise behavioural disagreement among the K candidates;
  *meaningful* = differs on a replay request outside the delta surface, or graded regression/better. Report
  `P(best-of-K > first candidate)` on the oracle score and on blind grade, and `Δ = pass(K) − pass(1)`.
- **Cost per accepted change:** (spec cost + sum of K candidate costs + oracle compute) / changes with at least one
  candidate cleared by all run rungs. Compare with the single-agent baseline (K=1, same spec, same oracles) and
  with a human-review cost proxy (reviewer time or the review-agent cost where logged).
- **Ladder catches / escapes / false rejects:** catches = pass repo tests but fail conformance or shadow-substitute,
  confirmed by blind grade (true regression vs oracle false positive); escapes = pass every run rung but graded
  regression; false reject = the reference diff rejected by a rung.

## 5. Decision rule

Pre-register in `docs/backtest/PREREGISTRATION.md` before reading pilot results. n=28 on one codebase supports only coarse calls.

| Assumption | Validating | Inconclusive | Invalidating |
|---|---|---|---|
| **A1** N implementations wanted | On ≥ 30% of E rows the K candidates differ meaningfully AND `P(best-of-K > first)` ≥ 0.25 AND the blind grader prefers a non-first candidate on ≥ 3 rows | 10-30% meaningful divergence, gains only on W/N rows, or grader splits | < 10% meaningful divergence, or best-of-K never beats K=1: a good spec with one agent suffices. Tests the value of N only; whether teams *want* it needs interviews |
| **A2** specs reliable and cheap | ≥ 70% of specs pass validators with ≤ 1 retry, reference diff passes `acceptance` on ≥ 70% of rows, median human edit distance < 20% and < 10 min/spec, spec cost < 25% of total per-change cost | 40-70% on those, or cost 25-50% | < 40% valid on reference, or a human rewrites > 50% of clauses, or spec defects explain most candidate failures |
| **A3** oracle evidence replaces review | On E rows the ladder catches ≥ 1 regression tests missed, ≤ 1 escape in the E set, and false-reject of the reference ≤ 10% | Catches only synthetic regressions, or escapes 2-3, or the shadow substitute is the only informative rung | ≥ 4 escapes among E rows, or false-reject of the reference > 25%, or no catches over the pilot and full set (the extra rungs add nothing over repo tests) |

A3 is tested only to the shadow rung; canary, SLO and holdout evidence are out of scope (section 7).

## 6. What can run without production access, and cost

**Runs locally, no approval:** checkout of base shas; vitest and Miniflare for the workers (`docs/SETUP.md`);
a new standalone harness `scripts/backtest/` (not built here) that per candidate makes a worktree at the base sha,
runs the agent, starts the affected worker under Miniflare and replays the request corpus against base, candidate
and reference; and a local comparator wrapper importing `workers/scientist-comparator/delta-surface` and
`comparison` directly. Agents run as subprocesses in worktrees, not Paseo-spawned Workers. Specs stay in files;
the Spec DO is not written. Model spend needs the pilot approval below.

**Needs maintainer approval (out of scope here):** anything against production or a deployed `beehive` worker;
Artifacts forks or Workers Builds for candidate deploys; the real sandbox runner (`SANDBOX-BUILD-PLAN.md` Phase 1+);
Statsig/Analytics Engine canary traffic. `wrangler deploy` and pushes to the deploy remote are forbidden to agents.

**Budget (model calls = one API request; an agent session is about 30-40 requests, mostly cached context):**

| Phase | Changes | Calls per change | Total calls |
|---|---|---|---|
| Pilot | 5 (rows 1-5) | spec 2 + issue rewrite 1 + 3 candidates × 35 + grade 4 ≈ 112 | ≈ 560, with 1.5× retry slack ≈ 850 |
| Full, K=3 | 28 | ≈ 112 | ≈ 3,150 (≈ 4,700 with slack) |
| K=5 on 8 rows | +8 | +70 | ≈ +560 |
| Second model on pilot | 5 | candidates only ≈ 105 | ≈ +525 |

Token estimate: about 15 candidate sessions in the pilot at roughly 0.5-1M cached input and 30-50k output each;
convert to money with the maintainer's current rates (not assumed here). Stop rule: halt the pilot if spend passes
1.5× this estimate or two specs in a row fail validators twice.

**Pilot (rows 1-5, varied and cheap to oracle):** `6d1771a` (one status code), `877e8bd` (several small behaviours
on one surface), `3d198da` (validation rule, existing helper to find), `46c9667` (edge plus DO, security flavour),
`bcca5bc` (new route with authorization rules: most room for divergence). Goals: harness works end to end,
leakage tests pass, spec validity and cost readable. It does not decide A1-A3; go/no-go for the other 23 follows.

**Step order:** (1) verify the delta-surface shape mismatch and base-green for all 28 rows (no model cost);
(2) freeze corpus and preregistration; (3) build the harness; (4) pilot; (5) maintainer review; (6) full run.

## 7. Threats to validity

- **Agent-written, single-author corpus.** The "ground truth" is an agent's choice reviewed by same-family
  agents: agreement may measure shared habits, disagreement may mean the original was wrong. Grade by behaviour;
  have a human sample the reference too.
- **Small, single codebase.** n=28, strong `AGENTS.md` conventions; no power for modest effects. Report per-row
  tables and intervals, no population claims.
- **Weak traffic evidence (biggest threat, to A3).** Beehive is not a high-traffic service. The shadow
  substitute is a synthetic replay of the change's own test requests plus fuzz, so it mostly re-exercises what
  tests already cover; "ladder catches what tests missed" will be rare by construction. Canary/SLO evidence is
  untested. A3 can be at best partially validated.
- **Shared blind spots.** Spec acceptance cases and candidates come from one model family; use a different
  model as grader.
- **Leakage.** Commit messages often state the mechanism; base docs may pre-announce a change; the model may
  have seen the repo. Mitigated in section 2, not eliminated.
- **Selection.** Filters favour small, tested, HTTP-visible changes, where the thesis is most likely to work.
  No inference to spine work or refactors.
- **Simulated oracles** (section 0): the harness is measured, not the platform's own ladder. Human time is
  excluded from cost except where logged.

**Second corpus (before any external claim):** a different, preferably human-written codebase with real history
and issue tracker: small stateless HTTP services with good tests (a mid-size Hono/Express or Workers example
repo), 30+ merged PRs linked to issues, issue text used verbatim as spec input (a stronger A2 test). Include some
changes where real traffic exists (access logs or a declared load model). Reuse the harness; re-pre-register.

## 8. Decisions needed from the maintainer

1. Approve the pilot spend (about 850 calls, 5 rows) and the stop rule.
2. Accept the pilot list, or swap rows (list is frozen after this).
3. Confirm the backtest-only `acceptance` field stays out of the Spec DO schema (spine; needs a human).
4. Which models run candidates vs. spec vs. grader (the grader must differ from the candidate family).
5. Whether a second, external corpus is in scope, and who owns finding it.

