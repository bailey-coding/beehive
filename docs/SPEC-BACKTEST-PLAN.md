# Spec backtest plan (2026-10-26, rev 2 after maintainer review)

PLAN ONLY. Nothing here has been run; no model spend. Read-only git analysis of `main` at `c8902e5` (317 non-merge
commits, 29 merges, all agent-written). Maintainer direction: validate the idea. Riskiest assumptions: **A1** teams
want N implementations of one change, **A2** specs can be written reliably and cheaply (contract, acceptance
tests, declared delta surface), **A3** traffic/oracle evidence can stand in for review for observable stateless changes.

Maintainer decisions (2026-10-26): pilot approved in principle. **Sonnet 5.5 at medium thinking** does spec
generation, candidates and grading in the pilot. The same-family-grader rule is waived for the pilot only: grade
mostly with deterministic oracles and behavioural comparison, and label every model-judged number "same-family
grader" in the report; any confirmation run needs a different-family grader. The backtest-only `acceptance` field
stays out of the Spec DO schema. A second corpus is deferred.

Backtest in one line: per historical change, generate a spec from issue text alone, run K agents on the base
commit, run the oracles, compare with what was merged.

## 0. What exists today (verified in code)

- Spec = `CreateSpecRequestSchema` (`workers/shared/schemas.ts:134`): `name`, `description?`, `contract: string`,
  `declaredDeltaSurface: string[]`. **No acceptance-test field.** The gate parses `contract` as JSON
  `{endpoints?, models?, workflow?}` (`workers/gate-workflow/index.ts:77,244`).
- **The shadow rung's delta check cannot work for any stored spec** (array stored, snake_case envelope returned,
  comparator reads an undefined field and throws; recorded in `docs/OPEN-QUESTIONS.md`, 2026-10-26). So the delta
  check is not usable even as a reference. **The backtest harness computes its own delta check** from the spec's
  v1.0 object (format: `docs/SCIENTIST-COMPARATOR-PLAN.md:120`), optionally reusing `delta-surface/matcher.ts`
  after an isolated unit check. Nothing in the repo is fixed by this plan.
- **The pre-merge gate is mostly simulated:** `validateSpecConformance` draws a 10% random warning, complexity is a
  hash of the candidate id (`gate-workflow/index.ts:700-775,783`), the sandbox runner's execute/push paths are stubs
  (`sandbox-runner/index.ts:440-530`; the container build path is real, `docs/SANDBOX-BUILD-PLAN.md`). The platform's
  own gate is therefore not an oracle here; the harness (section 6) is.

## 1. Corpus selection method

Source: `git log main --no-merges` (merges are noise). Fixed filters, applied in order:

1. At least 1 non-test source file under `workers/`, `cli/src/` or `ui/src/` AND at least 1 test file changed;
   at most 12 files; 30-700 added+deleted lines (leaves 73 of 317).
2. Exclude pure docs/FOCUS churn and spine work (Spec DO schema/migrations, promotion train, Workflow sequencing).
3. **Single behaviour:** the subject names one runtime behaviour change. Doc, flash-wording, test-only or
   refactor riders are tolerated; two runtime behaviours in one subject (e.g. "403 and also url-encoding") are not.
4. **Base independence:** no selected commit is the parent of another selected commit, and two selected commits
   never touch the same non-test source file within 25 commits of each other (computed with `git rev-list`).
5. **Issue-source rule:** the issue text may use the subject, the body, and a `spec:` doc **as it stood at the
   base commit** (`git cat-file -e <base>:<path>`), never a doc added later. A row whose only usable source is the
   subject is allowed but flagged (thin text); a base doc that states the solution rather than the problem is
   quoted for the problem clause only, or the row moves to tier B.
6. Classify observability: **E** = visible as an HTTP status/body at a worker edge; **W** = worker-to-worker, timing or
   config only (weak for A3); **N** = not HTTP-visible (control).
7. Freeze list, base sha and issue-source note in `docs/backtest/corpus.json` before any model run. No swaps.

Applying filters 2-5 by hand to the 73 (the rest are refactors, UI rewrites, new modules or spine work) leaves
**11 strict rows (tier A)**. The first draft's 28 included rows that failed 3-5; they are kept
as **tier B** (18 rows) so the full run reaches 29, but tier B is reported separately and **never enters the
decision rule**. Reaching 20+ strict rows needs the deferred second corpus; n=11 supports only coarse calls.

Columns: files = incl. docs; code/test = source and test files touched.

**Tier A (strict)**

| # | sha | date | files / lines | code/test | obs | component | change | issue source |
|---|---|---|---|---|---|---|---|---|
| A1 | `b024272` | 10-15 | 2 / +44 −1 | 1/1 | E | api router | `/roadmap` added to public endpoints | body (bug report) |
| A2 | `57d91c7` | 10-25 | 5 / +56 −16 | 2/2 | E | spec-do, shadow-router | Spec DO validates canary candidate ids/urls | base finding SF-3 (problem clause) |
| A3 | `c2d4906` | 10-23 | 4 / +46 −7 | 3/1 | E | auth/principal | master without X-Actor-ID reaches `/health` | body. **DROPPED 2026-10-27: base red (see Pilot)** |
| A4 | `831d9db` | 10-24 | 2 / +52 −2 | 1/1 | W | canary-worker | SLO thresholds never NaN | body |
| A5 | `e326b8c` | 10-16 | 9 / +42 −18 | 3/2 | E | preview-manager | Workers Versions stub is local-only (prod answers 501) | subject+body, base OPS/SETUP |
| A6 | `6d1771a` | 10-26 | 3 / +30 −3 | 1/1 | E | issue UI | cross-origin non-GET issue request refused (403) | subject only; ignore `spec: code-review N1` |
| A7 | `bcca5bc` | 10-17 | 5 / +130 −1 | 3/2 | E | issue API | PATCH issue status closes/reopens (new route) | subject only; M8 plan is post-change |
| A8 | `3790070` | 10-16 | 3 / +305 −106 | 2/1 | E | issue UI | comment form posts to the route the DO serves | base `FEATURE-PARITY.md` (names the route: flag) |
| A9 | `746c42c` | 10-16 | 8 / +420 −24 | 4/2 | W | shadow-router | TTL cache of live deploy refs | subject (mechanism-heavy: flag) |
| A10 | `c0cfa86` | 10-25 | 7 / +160 −36 | 2/2 | W | shadow-router | canary recorder flushes burst tail | base finding in OPEN-QUESTIONS (problem) |
| A11 | `de8817c` | 10-23 | 4 / +31 −6 | 1/1 | N | CLI | CLI rejects actor ids the edge would 400 | subject only; `spec: review S4` unresolvable |

**Tier B (relaxed). Reasons: B bundled, C chained/adjacent, P post-change or plan-leaking doc, S spine.**

| sha, change | obs | why | sha, change | obs | why |
|---|---|---|---|---|---|
| `877e8bd` 405 on issue pages | E | B, P | `0cb219f` zod master X-Actor-ID | E | B |
| `3d198da` org name = namespace | E | B, P (plan names `NAMESPACE_RE`) | `995bd22` actor lookup w/o 500 limit | E | B, C |
| `46c9667` reserved org 403 | E | C (parent of A5) | `55886a4` migration step fails loudly | N | B, S, C |
| `65ab327` issue bad JSON → 400 | E | C (4 from A7), P | `adb86bd` newer schema tolerated | N | S, C |
| `37e16fd` comment-policy rules | E | B, C, P | `2586c80` CLI `--actor` flags | N | B |
| `94860d4` atomic issue numbers | W | B, C, P | `4f38f78` CLI config/token/login | N | B |
| `b88422a` issue writes need actor | E | B, C (child of A7), P | `03c9c31` purge fail-closed | E | B, C, P |
| `97f04cc` purge, older Spec DO | E | B, C, P | `bf256d0` purge 501 abort | E | B, P |
| `3bdddd9` canary client 400 | E | B, C (child of A2) | `fd889c3` canary subdomain pin | W | P (cleanup plan states fix) |

Before freezing, per row: base builds and `npm test` is green (red drops the row); `docs/` at the base is grepped
for the change's key terms. Known base leaks: `docs/AGENTS-REVIEWER.md:68` ("Origin check before every DO read")
for A6; `docs/FEATURE-PARITY.md` for A8.

## 2. Spec to generate, and leakage control

**Generator input (only this):** an *issue text* plus read access to the base-commit tree. **Never** the diff, merge,
later commits, tests added by the change, or history past the base.

**Issue text:** built from the sources permitted by filter 5, rewritten by one model call told to "state the problem and
the observable behaviour wanted; do not name files, functions, flags or the mechanism". A human reads each (2 min/row)
and deletes residual solution words. The rewrite is stored in the corpus file and is what every arm sees. Rows whose
text cannot be made mechanism-free move to tier B.

**Spec output**, one JSON file per change, mapped to the existing API with no spine edits:

```
name, description          -> CreateSpecRequestSchema
contract (JSON string)     -> endpoints[{method,path,request,responses[{status,body shape}]}], models, rules[]
acceptance[]               -> backtest-only, never sent to the Spec DO: executable vitest cases written against the
                              base commit's test helpers; must FAIL on base
declaredDeltaSurface       -> v1.0 object (the array's one element): routes allowed to change, status/body fields
                              allowed to differ, newFieldsAllowed; everything unlisted frozen
out_of_scope[]             -> behaviours that must not change
```

**Spec validators (mechanical, before any candidate):** schema + `parseDeltaSurface` parse; every `acceptance` case
fails on base (else vacuous); every route in `contract` exists or is declared new.

**Leakage tests (pilot, once):**
1. *Wrong-issue test:* feed the generator a different row's issue text; the spec must differ from the true one.
2. *Overlap test:* flag identifiers in the spec that appear in the held-out diff but not in the issue text or base tree.
3. *History test:* agents run in a single-commit checkout; the merged diff lives outside any mountable path.
4. *Doc-at-base test:* for every doc the issue text cites, assert it exists at the base commit (`git cat-file -e`) and
   reject docs added later; also grep docs at the base for the key terms of the change. A base-tree grep alone misses
   a doc that reached main after the commit (e.g. `M8-UI-ISSUES-PLAN.md` in `01c660a`, after both commits citing it).
5. Scrub `docs/` lines added after the issue (e.g. `FOCUS.md` "done" entries).

## 3. Experiment, per change

1. **Spec arm.** Generate spec S (1 call, one retry on validator failure). Log tokens and wall time. A human may fix
   S; keep both versions and the edit distance (A2).
2. **Candidate arm.** K = 3 independent Sonnet 5.5 (medium thinking) agents, each in its own checkout of the base,
   given S, the issue text and `AGENTS.md`; each ends with a push to `scratch/*`; 40-turn cap. K = 5 on the 8
   rows with most room for divergence in the full run.
3. **Oracles, ladder order** (what runs where: section 6):
   - Pre-merge: existing tests + the spec's `acceptance` + `tsc`.
   - Conformance: replay `contract` requests under Miniflare; check status and shape.
   - Shadow substitute: replay a fixed corpus (the change's test requests + about 200 fuzz requests per route)
     against base and candidate and apply the **harness's own delta check** (section 0). Synthetic traffic.
   - Train/canary/full: not run.
4. **Reference arm.** The merged diff goes through the same oracles; an oracle that rejects it is miscalibrated.
5. **Behavioural comparison** of each candidate with the reference and with each other: response diff on the replay
   corpus by (route, status, body shape). Textual diff is recorded, not used.
6. **Grading, deterministic first.** Labels {equivalent, spec-permitted variation, spec violation, regression,
   better-than-reference, spec-gap} are assigned by the oracles and replay diff wherever they decide the case; a
   model judges only the residue. Every model-judged number carries the label **"same-family grader"**; a human
   samples 20% of model-judged cases.

## 4. Metrics

Per change, then median and the full per-row table.

- **Spec authoring cost:** tokens, calls, wall time, retries to pass validators; **human edit distance** (normalised
  token Levenshtein, generated vs fixed) and minutes; **spec defects** (a divergence traced to a missing/wrong clause);
  baseline: maintainer hand-writes 3 specs.
- **Candidate pass rate per rung:** funnel counts of K clearing pre-merge, conformance, shadow substitute; `acceptance`
  pass rate on the reference diff.
- **Behavioural agreement with the merged change:** share of replay requests where candidate and reference agree on
  status+body modulo the delta surface; plus the fraction of changes where at least one of K agrees fully.
- **Rescue rate R (does N>1 help):** share of rows where candidate 1 fails at least one rung but some candidate of the K
  clears all of them. **Spec-permitted spread S:** share of rows where at least two candidates clear all rungs yet
  differ on behaviour the spec permits or leaves open, and the deterministic oracles or grader rank them unequally.
  Differences *outside* the delta surface are spec violations and feed pass rate, not R or S.
- **Cost per accepted change:** (spec + K candidates + oracle compute) / changes with at least one candidate clearing
  all run rungs; compare with K=1 on the same spec and with a human-review cost proxy.
- **Ladder catches / escapes / false rejects:** *catch* = passes repo tests and `acceptance` but fails conformance or
  shadow substitute, confirmed a real regression by a deterministic check; *false positive* = the same failure with
  no real regression; *escape* = clears every run rung but graded a regression; *false reject* = the reference diff
  rejected by a rung.

## 5. Decision rule

Pre-register in `docs/backtest/PREREGISTRATION.md` before reading pilot results. Evaluated on **tier A only**
(n=11; E rows n=7); tier B is supplementary. Order: invalidating test first, then validating; anything else is
inconclusive. Model-judged evidence cannot alone validate a cell in the pilot (same-family grader).

| Assumption | Validating (all) | Invalidating (any) | Otherwise |
|---|---|---|---|
| **A1** value of N | R ≥ 3 of 11 rows AND ≥ 3 of those rescues or preferences confirmed by deterministic oracles | R ≤ 1 of 11 rows AND no S preference confirmed deterministically | **inconclusive** (includes R ≥ 3 without 3 confirmations, or S only model-judged) |
| **A2** specs reliable, cheap | ≥ 8 of 11 specs pass validators within 1 retry; reference passes `acceptance` on ≥ 8; median edit distance < 20% and < 10 min; spec cost < 25% of per-change cost | reference passes `acceptance` on < 5 of 11, or a human rewrites > 50% of clauses, or spec defects explain most candidate failures | inconclusive |
| **A3** oracles replace review (to shadow rung only) | ≥ 1 confirmed catch AND ≤ 1 escape on E rows AND reference false-rejected on ≤ 1 of 11 | the extra rungs never fire (zero catches and zero false positives over tier A), OR ≥ 3 escapes on E rows, OR reference false-rejected on ≥ 3 of 11 | inconclusive (includes rungs firing only as false positives, catches only on injected faults, 2 escapes) |

A1 tests the value of N only; whether teams *want* it needs interviews. Because all candidates come from one model,
diversity is understated; a low R is weak evidence against A1. A3 is tested to the shadow rung only; canary, SLO and
holdout evidence is out of scope.

## 6. What runs without production access, and budget

**Local, no approval:** base-sha checkouts; vitest and Miniflare for the workers (`docs/SETUP.md`); a new harness
`scripts/backtest/` (not built here) that per candidate makes a worktree, runs the agent as a subprocess (not a
Paseo-spawned Worker), starts the affected worker under Miniflare, and replays the corpus against base, candidate and
reference with its own delta check. Specs stay in files; the Spec DO is not written.
**Needs maintainer approval (out of scope):** anything against production or a deployed `beehive` worker; Artifacts
forks or Workers Builds for candidate deploys; the real sandbox runner (`SANDBOX-BUILD-PLAN.md` Phase 1+); Statsig and
Analytics Engine canary traffic. `wrangler deploy` and pushes to the deploy remote are forbidden to agents.

**Budget** (call = one API request; an agent session is about 35 calls, mostly cached context; one model for all):

| Item | Per change | Pilot (5) | Full run, rest (24) |
|---|---|---|---|
| Issue-text rewrite | 1 | 5 | 24 |
| Spec generation (1 + retry) | 2 | 10 | 48 |
| Candidates, K=3 × 35 | 105 | 525 | 2,520 |
| Model-judged residue (grading) | 3 | 15 | 72 |
| Leakage test 1 (wrong-issue spec, +retry) | 2 | 10 | 0 |
| **Expected total** | | **≈ 565** | **≈ 2,665** |

K=5 on 8 rows adds about 560 to the full run. The earlier second-model pass (+525 calls, about 790 with slack) is
**dropped** because one model now does everything; if it is re-added for diversity, add 525 expected to the pilot.
Leakage tests 2-5 are deterministic (no calls). Tokens: about 15 candidate sessions at roughly 0.5-1M cached input
and 30-50k output each; convert at the maintainer's rates (not assumed here). **Stop rule (slack applied once):**
hard stop at 850 pilot calls (1.5 × 565), or if two specs in a row fail validators twice.

**Pilot (5 changes, five components, none an issue or lifecycle route), revised 2026-10-27: A1, A2, A4, A5, A11.**
A1 `b024272` (api router; thin bug-report text; its base vitest include covers only `tests/**`, so the full-run oracle is
nearly empty), A2 `57d91c7` (spec-do + shadow-router; ambiguous rules; base has a known fake-timer flake in
`shadow-router/tests/mirror-safety.test.ts`, retried), A4 `831d9db` (canary-worker), A5 `e326b8c` (preview-manager),
A11 `de8817c` (CLI; obs N control; thin subject-only text). Checked pairwise: no parent link, no shared source file.
**Swap:** the original A3 `c2d4906` is dropped because its base is genuinely red (49 failing tests answer 503 until
`c2d4906` is applied; 77 when the CLI dependencies are also missing): a red base makes the full-run oracle meaningless, and
the plan drops red-base rows. A11, a tier-A row that is green at its base, replaces it; the corpus (`docs/backtest/corpus.json`)
records the base-green result per row.
**What this pilot can and cannot say:** with A3 dropped there are only **10 usable strict rows** (A1-A11 minus A3), so the
decision rule in section 5, which is written for 11, is **inconclusive by construction**. The 5-row pilot yields cost,
feasibility and qualitative signal (does the harness work end to end, are specs valid, how much does a run cost, what do
candidates look like), **not a verdict** on A1-A3. Go/no-go for the other rows follows.

**Harness isolation (2026-10-27):** pilot candidates and the spec generator run with file tools only (no Bash; no OS
sandbox on this host), so they cannot run tests; this handicaps them and understates pass rates and divergence. Details:
`tools/backtest/README.md`. Pilot row A3 (`c2d4906`) was dropped (base red) and replaced by A11 (`de8817c`).

**Corpus status (2026-10-28):** `docs/backtest/corpus.json` now freezes ten rows: A1, A2, A4, A5, A11 (pilot) and A6-A10, each
green at its base (`check --base-green`: 0 red, 0 flaky), independent, doc-at-base clean. A3 stays dropped. **There is no
eleventh strict row**: no commit since the first freeze passes the filters (the only new code commit, `4bda598`, is a
migration), and every other commit that passes filter 1 is bundled, chained to a selected row, spine work, or a refactor. The
decision rule therefore stays inconclusive by construction (section 5 needs 11). Options for the maintainer: promote a tier-B row
after a deliberate relaxation, run A3 as a fail-to-pass row (its base is red until `c2d4906`), or accept 10 and say so.
Rows with scrubbed base docs (the doc states the fix): A4, A6 (four docs), A8; recorded in the corpus.

**Step order:** (1) base-green and key-term grep for all rows, no model cost; (2) freeze corpus and pre-registration;
(3) build the harness; (4) pilot; (5) maintainer review; (6) full run; (7) confirmation run with a different-family
grader before any claim.

## 7. Threats to validity

- **Agent-written, single-author corpus.** "Ground truth" is an agent's choice reviewed by same-family agents:
  agreement may measure shared habits. Grade by behaviour; human-sample the reference.
- **Small and single-codebase.** Strict tier n=11 (E rows 7), strong `AGENTS.md` conventions; per-row tables and
  intervals, no population claims. Tier B adds rows but fails the independence or single-behaviour filters.
- **Weak traffic evidence (biggest threat, to A3).** Beehive is not a high-traffic service. The shadow substitute
  replays the change's own test requests plus fuzz, so it mostly re-exercises what tests cover; "ladder catches what
  tests missed" will be rare by construction. Canary/SLO evidence is untested.
- **Same-family grader and candidates (waived for the pilot).** Shared blind spots can inflate pass rates and make
  candidates look alike (low divergence). Mitigation: deterministic grading first, labelled model-judged numbers, a
  different-family grader for any confirmation run.
- **Leakage.** Commit messages state mechanisms; base docs may pre-announce a change; post-change docs may sit behind
  a cited path; the model may have seen the repo. Mitigated by filter 5 and leakage tests 1-5, not eliminated.
- **Selection.** Filters favour small, tested, HTTP-visible changes; no inference to spine work or refactors.
- **Simulated oracles** (section 0): the harness is measured, not the platform's own ladder. Human time is excluded
  from cost except where logged.

**Second corpus: deferred** by the maintainer. When revisited it should be a human-written codebase with real
issues, issue text used verbatim, and some real traffic; the harness and pre-registration carry over.

## 8. Decisions still needed

1. Release of the pilot spend: about 565 expected calls, hard stop 850 (approved in principle; needs a go).
2. Confirm the 5-row pilot list (A1, A2, A4, A5, A11; A3 swapped out, see Pilot); it freezes after this.
3. Whether to add a second model to the pilot for candidate diversity (+525 calls); default is no.
4. Which different-family grader runs the confirmation run, and when.
