# do-bind-order notes (2026-10-14)

## Fixed
`workers/spec-do/index.ts`: `listSpecs`, `listCandidates`, `listGateVerdicts`, `listTrials`,
`listPromotions`, `listIssues` now build params as filters, then `limit, offset`, matching
placeholder order. Grep of `workers/` found no other `[limit, offset]`-first sites
(`listOrganizations/Actors/Repositories` bind `limit, offset` only, unfiltered, and were correct).

## Tests
`tests/unit/spec-do-list-bind-order.test.ts`: 6 tests, one per method, each covering
single filter, multi-filter, unfiltered, with real SQL via `node:sqlite` through the real
`createSqlStorage` adapter and real `SpecDO`. All 6 fail without the fix and pass with it.
No SQLite harness existed in the repo; this fake `DurableObjectState` is local to the test.
Requires Node >= 22.13 (unflagged `node:sqlite`).

## Results
- `tsc --noEmit`: clean.
- `vitest run`: 358 passed, 28 failed. The same 28 fail on main (before this change):
  `tests/integration/bindings.test.ts` (binding/config assertions), plus one other test file
  that fails to load. Nothing introduced by this change.

## Behavior changes for callers
Filtered `GET` list endpoints (specs by `organizationId`/`stage`, candidates, verdicts,
trials, promotions, issues) previously returned `[]` for a single filter at offset 0, and HTTP 500
(SQLite `datatype mismatch`) for two or more filters or any offset above 0. They now return
matching rows.
REST/CLI callers or scripts that treated an empty filtered result as "none exist" (e.g.
idempotent create-if-missing checks) will now see existing rows and may skip creates they
previously performed, or surface duplicates that were hidden.

## Found, not fixed
`createTrial()` binds `NULL` for `decided_at` (schema: `NOT NULL`), so it throws on real SQLite.
