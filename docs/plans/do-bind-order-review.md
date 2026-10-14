# do-bind-order: oracle review (2026-10-14)

Reviewed: `git diff main...HEAD` on `fix-do-list-bind-order` (dcb1b3f).

## Verdict: APPROVE WITH CHANGES

The code fix is correct and complete, and it's safe to deploy today. The one required
change is a docs-only correction (see R1). It needs no re-test and no re-review.

---

## 1. Bind order: all list sites

The adapter appends values on every `bind()` call (`workers/spec-do/sql-storage.ts:50-53`)
and passes them positionally to `sql.exec(query, ...boundValues)` (`:44`). Binding is
therefore by call order, and params must follow placeholder order.

| Method | params init | `push(limit, offset)` | Filter order matches SQL |
|---|---|---|---|
| `listSpecs` | `index.ts:1941` | `:1956` | org, stage ✔ |
| `listCandidates` | `:1972` | `:1992` | spec, agent, stage ✔ |
| `listGateVerdicts` | `:2008` | `:2028` | candidate, gate, status ✔ |
| `listTrials` | `:2057` | `:2072` | spec, stage ✔ |
| `listPromotions` | `:2088` | `:2095` | candidate ✔ |
| `listIssues` | `:2111` | `:2131` | repo, stage, status ✔ |

- **Optional filters:** each filter is guarded by a truthiness check, and the same check
  gates both the SQL fragment and `params.push`. `undefined`, `null` (never produced) and
  `''` (from `?specId=`) are therefore skipped consistently. The placeholder count always
  equals the param count.
- **Other sites:** `listOrganizations/Actors/Repositories` (`:1883-1926`) are unfiltered and
  bind `(limit, offset)`, which is correct. There are no `COUNT(` queries or pagination
  helpers anywhere in `workers/`. No other file prepares SQL with `LIMIT`/`OFFSET`.
  Every other `bind()` in `index.ts`/`seed.ts` passes all values in one call, in column
  order.
- **Route handlers** (`index.ts:1151`, `1187`, `1251`, `1294`, `1367`, `1451`, `1489`, `1542`,
  `1572`) parse `limit`/`offset` with bare `parseInt` and no validation. This is
  pre-existing and out of scope; see O2.

**Other bind defect found (pre-existing, not a blocker):** `init()` (`index.ts:237-245`)
reuses `initMetadata` as bind → step → bind → step without calling `reset()`. Under append
semantics, the second `step()` reuses the finished cursor, so `initialized_at` is never
written. A probe on a fresh DO showed `metadata` contains only `schema_version`. Nothing
reads `initialized_at`. See O3.

## 2. SQL injection

**None.** Every appended fragment in the touched methods is a string literal. Column names
are hard-coded, and every value goes through `?`. `prepare`/`exec` in `workers/spec-do/`
never interpolate template values into SQL. The test's `UPDATE ${table}` uses hard-coded
test constants and is test-only.

## 3. Tests

- **They run real code.** The tests use the real `SpecDO`, the real `init()` → `createSqlStorage`
  adapter, the real `SCHEMA_SQL` and real SQLite (`node:sqlite`). Only the
  `state.storage.sql.exec` shim is fake, and it mirrors native positional binding.
- **They fail without the fix.** I built a scratch copy (`git archive HEAD` plus `main`'s
  `workers/spec-do/index.ts`, nothing committed) and ran the file: **6/6 fail**, each with
  `expected [] to deeply equal [...]` on the first filtered assertion. With the fix,
  6/6 pass.
- **Node:** `node:sqlite` is unflagged from Node 22.13. Locally I ran v22.23.3. `package.json`
  `engines` says `>=22.0.0`, and on 22.0–22.12 this file fails to load; vitest reports a
  failure, not a skip. See O1.
- **CI:** `.github/workflows/deploy.yml` has **no test step** (install → `wrangler deploy`).
  CI therefore neither breaks on these tests nor runs them. Its `node-version: '22'` resolves
  to the latest 22.x, which is compatible if a test step is added later.
- **Typecheck:** `tsc --noEmit` is clean, but `tsconfig.json` only includes `workers/**/*`, so
  the test file is not covered. I checked it separately and it has no type errors.
- **Fidelity caveat:** the harness disables foreign keys (`test.ts:18`). That's fine for
  bind order, but it doesn't model production FK behaviour.

## 4. Behavior change for callers

**Correction to the author's notes.** Under the old code, only *one filter with offset 0*
returned `[]`. Two or more filters, or any `offset > 0`, put a string on `LIMIT`/`OFFSET`, so
SQLite raised `datatype mismatch` and the route returned **HTTP 500**. I reproduced this
with `node:sqlite` against the exact old bind order:
`[50,0,org]` → `[]`; `[50,0,org,stage]` → throws; `[50,10,org]` → throws. The change is
therefore `[]` → rows for single-filter calls and 500 → rows for multi-filter or
paginated calls.

Callers audit (workers, cli, scripts, ui, tests):

| Caller | Filtered? | Impact |
|---|---|---|
| `workers/queue-consumer/index.ts:153`, `:289` | no (`?limit=100`, filters client-side) | none |
| `workers/preview-manager/index.ts:287` | no | none |
| Web UI `workers/api/ui.ts:178`, `:194-196` | no (filters by org client-side) | none |
| Edge router `workers/api/index.ts:1036-1279` `handleList*` | pass-through | now correct |
| CLI `cli/src/commands/debug.ts:266`, `:562` (`listCandidates(…, specId)`) | yes | read-only display; previously showed 0 candidates, now correct |
| Other CLI `list` commands, `debug.ts` overviews | no | none |
| `ui/src/services/api.ts:33-35`, `:61-63` (React app) | yes | not built or deployed |
| `scripts/*.sh`, `scripts/*.ts` | no (only `?limit=` or POSTs) | none |
| `tests/e2e/*`, `tests/integration/*` | mocks cover POST routes only | no test asserts an empty filtered list |

**No create-if-missing or idempotency logic depends on a filtered list.** `claimSpec`
(`index.ts:605`) inserts unconditionally. The web UI's actor lookup (`ui.ts:178`) uses an
unfiltered list. No caller turns a 500 or an empty result into a create. So there's no
risk of duplicate creation or "already exists" conflicts.

## 5. Pre-existing failures

| | Failed | Passed | Total |
|---|---|---|---|
| `main` (scratch copy) | 28 | 352 | 380 |
| branch | 28 | 358 | 386 (+6 new) |

The set of failing test names is **identical** (`diff` is empty). Breakdown:

- 26 failures are in `tests/integration/bindings.test.ts`.
- 2 failures are in `workers/api/tests/api.test.ts`: `expected 401 to be 200` and
  `"[object Request]" is not valid JSON`. These are mock and request-shape mismatches.

None of them touch SQL or the list methods. The notes say the second file "fails to load".
That's inaccurate: it loads and fails 2 assertions (R2).

## 6. `createTrial()` NOT NULL `decided_at`

**Confirmed.**

- `index.ts:770` binds `null` for `decided_at`. `schema.sql:160` (and the inline
  `SCHEMA_SQL`) declare `decided_at INTEGER NOT NULL`.
- Probe: `NOT NULL constraint failed: trials.decided_at`. `POST /api/trials` through
  `SpecDO.fetch` returns **500**, with no trial row and no history row (it throws before
  `recordHistory`).
- The bug has been present since the initial spine commit (4f787d8), so it is not a
  regression.

**Live impact.** No worker, Workflow, queue consumer, web UI or CLI command calls
`POST /api/trials`. `cli/src/utils/api-client.ts:453` defines `createTrial`, but no command
uses it. Trials therefore can't be created in production at all; only manual REST calls
reach this path, and they get a 500. It breaks no flow that runs today. It does matter if
the submission demo shows the trial rung.

**Same branch or separate?** Fix it in a **separate branch**. It's a different (write) path
in the hand-written spine, and keeping this diff a pure read-path fix makes it trivially
revertible. Two fix options:

- **(a) Bind `0` for `decided_at` at creation.** This is a one-line change that matches the
  `decided_at: 0` already returned by `createTrial` and needs no migration. It is the
  low-risk option for today.
- **(b) Make the column nullable.** This needs an SQLite table-rebuild migration for existing
  DOs, because `CREATE TABLE IF NOT EXISTS` won't alter the live table. Don't do this on
  submission day.

Whichever fix is chosen, test it with this harness **with FKs enabled**. `trials` has FKs
to `specs`, `candidates` and `actors`. I have not verified whether DO SQLite enforces them;
if it does, a valid `decidedBy` actor and valid candidate IDs are required.

## 7. Safe to merge and auto-deploy today?

**Yes.**

- The runtime diff is 12 lines in six read-only methods of one class.
- There is no schema change, no migration and no write-path change.
- `tsc` is clean and the set of failing tests is unchanged.
- Pushing to `main` redeploys all 10 workers, but only the `beehive` bundle changes. The DO
  restart is the same as on any `beehive` deploy.
- Rollback is a revert and a push.

Hold only if a live demo or recording is mid-run, or another push to `main` is in flight.
In those cases, sequence the deploys.

Post-deploy smoke test (watch the run for the new SHA with `gh run watch <id>`):

```sh
curl -s -H "Authorization: Bearer $BEEHIVE_API_TOKEN" \
  "https://beehive.bz23711.workers.dev/api/specs?organizationId=<org-id>"            # that org's specs
curl -s -H "Authorization: Bearer $BEEHIVE_API_TOKEN" \
  "https://beehive.bz23711.workers.dev/api/specs?organizationId=<org-id>&stage=draft" # 200, not 500
```

---

## Required changes

- **R1 (docs only).** Correct the failure-mode description:
  - Old text: `docs/OPEN-QUESTIONS.md:229-232` ("empty results whenever any filter was
    supplied") and `docs/plans/do-bind-order-notes.md:22-24`.
  - New text: `[]` only for exactly one filter with offset 0; two or more filters or
    offset > 0 raised `datatype mismatch` → HTTP 500.
  - Why: OPEN-QUESTIONS is the durable record other agents read, and right now it
    misstates the failure mode.

## Optional suggestions

- **R2 / notes accuracy.** `do-bind-order-notes.md:18-20`: the second failing file is
  `workers/api/tests/api.test.ts` (2 assertion failures), not a load failure. Also,
  `tsc --noEmit` does not cover `tests/`.
- **O1.** Bump `engines.node` to `>=22.13`, or guard the suite with
  `describe.skipIf(!hasNodeSqlite)`.
- **O2.** Validate `limit`/`offset` in the DO route handlers. Clamp to a non-negative
  integer with a max, and default on `NaN`. Today `?limit=abc` → 500 `datatype mismatch`
  (probed), and `?limit=-1` → unbounded scan. Pre-existing.
- **O3.** `init()` (`index.ts:237-245`): call `initMetadata.reset()` between the two
  bind/step pairs, as `seed.ts` does, so that `initialized_at` gets written. Pre-existing
  and cosmetic.
- **O4.** Add one HTTP-level test through `spec.fetch()` for a multi-filter route plus
  `offset > 0` (the case that used to return 500). Extract `makeDO()` into a shared test
  helper when the next DO test arrives.
- **O5.** Add an `npm test` gate to CI once the 28 pre-existing failures are fixed. Adding
  it today would block every deploy.
- **O6.** Fix `createTrial` on a separate branch (§6, option a).
