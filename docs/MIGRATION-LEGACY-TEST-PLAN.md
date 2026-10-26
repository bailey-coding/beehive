# Plan: Spec DO migrations over legacy table shapes

Status: **plan only, nothing implemented.** Item: `docs/FOCUS.md` "Migration tests only see this repo's own SQL".
Sources: `docs/rfos/2026-10-14-migration-failures.md`, `docs/OPEN-QUESTIONS.md` "Live ledger had a `service_accounts` table of
another design (2026-10-16)", `workers/spec-do/index.ts:1035` (`runMigrations`), `:1125` (`applyServiceTokens`).

## 1. Goal

A test that builds ledgers in shapes this repo's current SQL would never produce, runs the real `SpecDO.init()` over them, and
proves: it does not throw (or throws the named, intended error), every step is additive and idempotent, and no row is lost. The
2026-10-16 outage was a table of another design that `CREATE TABLE IF NOT EXISTS` left alone; no test could see it.

## 2. What is covered today, and what is not

Covered (`workers/spec-do/tests/migration-legacy.test.ts`, e55ce32, M5a; `migrations.test.ts`):
- `service_accounts` of the 2026-10-16 shape, and a variant lacking only `is_active`: init throws `unexpected shape ... missing: ...`,
  stays at `m5`, the table is kept; dropping the empty table lets it finish (also `migrations.test.ts:113`, a duplicate).
- `actors` without `role`, `organizations` without tombstone columns, `tournaments` without version/failure columns: init reaches
  the latest version and the column exists (column presence only).
- A populated "m3" ledger migrates to latest with rows kept and a rerun is a no-op (`migrations.test.ts:169`); m8 to m9; the
  newer-than-code floor; a failing step leaves `db` unset and a retry succeeds.

NOT covered:
1. **No dump and no fixtures.** Every shape is hand-typed from the OPEN-QUESTIONS prose. `populatedM3()` is today's schema minus
   later objects, not a real m3, so it is still this repo's SQL. The file header says "production dump simulation"; there is no dump.
2. **Tables beyond the five.** Nothing for `repositories`, `specs`, `candidates`, `issues`, `issue_*`, `gate_verdicts`, `trials`,
   `promotions`, `entity_history`, `metadata`, `deploy_refs`, `canary_*`, `user_tokens`, `idempotency_keys`, `canary_metrics`,
   although every `CREATE TABLE IF NOT EXISTS` step has the same blind spot.
3. **Stray objects.** Unknown tables, views, triggers, and same-named indexes created without `IF NOT EXISTS` (the live
   `service_accounts` carried `idx_service_accounts_org`) are never seeded.
4. **Data preservation.** The legacy cases check columns, not rows. No before/after row comparison on legacy shapes.
5. **Per-step idempotency and start versions.** Only a whole-run rerun exists. No "init from every start version m1..m10", no
   "apply each step twice", no ledger without a `schema_version` row (treated as m1, `index.ts:1102`).
6. **A legacy table with rows** (the code throws and says "migrate its rows first"; nothing tests that rows survive the refusal).
7. **The `schema_init` path.** `initSchema` runs the whole `SCHEMA_SQL` when the `schema_init` key is absent, before
   `runMigrations`. A legacy table plus no flag takes that path, which may fail with the cryptic error the friendly check was added
   to avoid. Unverified; pin it with one case.
8. **The M12 unique index** on `actors.github_user_id` (section 6): `schema-sync.test.ts:32` only pins that no such index exists.
9. **Maintenance:** about ten assertions hardcode `'m11'`; every new migration edits them.
10. **Fidelity:** the harness is `node:sqlite`, not the Durable Object SQLite (section 4).

## 3. Where the fixtures come from (no production access by agents)

| Tier | Source | Prod access | Gives |
|---|---|---|---|
| T1 | `git show <sha>:workers/spec-do/schema.sql` for each of the 11 commits that touched it (bbccf9e, d8e09bb, 48a5f54, aeec713, ...), mapped to the `LATEST_SCHEMA_VERSION` of that commit | none | true historical shapes for every table, m1 to m10 |
| T2 | Maintainer-run, read-only: `SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name` and `SELECT value FROM metadata WHERE key='schema_version'`, saved as `fixtures/legacy/prod-schema-<date>.json` | **maintainer only** | the live object list: stray tables and indexes, shapes of the live ledger |
| T3 | Pinned text of known incidents: the 2026-10-16 `service_accounts` (already in OPEN-QUESTIONS), plus synthetic mutations | none | known-bad shapes |

- T1 is generated once by `scripts/snapshot-schema-fixtures.sh` (git only, output committed); tests never call git.
- T2 is the query `docs/OPS.md` step 1 already sanctions ("list `sqlite_master`"). **Proposed, not run.** It needs the maintainer's
  approval and their own access path, which OPS.md names only as "the maintainer's usual access". Schema only, no rows. The
  maintainer reviews the DDL for secrets before it is committed. Optional second query, `SELECT COUNT(*)` per table, tells whether
  legacy tables hold rows; ask separately.
- **A dump taken now will not contain the legacy `service_accounts`** (dropped by hand, rebuilt by m6). Its value is the baseline
  of the live ledger and any other stray object; the known bad shape stays in T3.
- T1 cannot prove the live ledger matches git history, which is how the incident happened. Only T2 can; that is why T2 exists.

## 4. Harness

Reuse `tests/sqlite-state.ts` (`makeSqliteState(raw, kv)` restarts a DO over the same storage; foreign keys on; `transactionSync`
rolls back on throw). Add `tests/legacy-ledger.ts`: `loadLegacyLedger({ddl, seed, version, schemaInit: true})` runs DDL with
`PRAGMA foreign_keys = OFF`, inserts synthetic rows, writes the `schema_version` metadata row and the `schema_init` key.
Not miniflare: `@cloudflare/vitest-pool-workers` is not a dependency and all 20 spec-do test files use `node:sqlite`. Risk: SQLite
version and pragma differences from DO SQLite. Mitigation: the steps use only `PRAGMA table_info`, `ALTER TABLE ADD COLUMN`, and
`CREATE ... IF NOT EXISTS`; add no other construct to a migration without a fidelity check on a deployed or `wrangler dev` DO.
Determine the latest version from a fresh ledger (`version(fresh)`), not from an export, so no change to `index.ts` is needed.

## 5. Cases and assertions

Fixture manifest (`fixtures/legacy/index.ts`): `{ name, ddl[], seed[], startVersion, expect: 'migrates' | { throws: RegExp } }`.
For every `migrates` case:
- **A1** `init()` resolves; `schema_version` equals the fresh ledger's.
- **A2 additive:** every object in the pre-migration `sqlite_master` still exists; changed `sql` only by appended `ADD COLUMN`;
  per pre-existing table, the original columns' rows are identical before and after (sorted dump compare).
- **A3 idempotent:** a second `init()` leaves `sqlite_master` and all rows byte-identical; for each step, reset the version to
  the one before it and re-run: same result.
- **A4 convergence:** columns (`PRAGMA table_info`) and index names per table equal a fresh ledger's, for every historical start version.
For every `throws` case: the message names the table and the way out, version stays put, `db` is unset, nothing was dropped, rows
are intact, and a retry after the documented human fix reaches latest (the existing service_accounts pattern, generalised).
Seed cases: legacy `service_accounts` with rows (refusal keeps rows); stray table/view/trigger; same-named index without
`IF NOT EXISTS`; no `schema_version` row; legacy table with `schema_init` absent (item 7).

## 6. M12 unique index on `actors.github_user_id` (`docs/FOCUS.md` "M11 handoff": `m12` or later)

Lands **with the m12 PR, not before**; a test cannot pin a migration that does not exist. Fixture `actors-dup-github-id`: two
humans with one `github_user_id`, several NULLs (SQLite UNIQUE allows many NULLs), and two `''` values (these collide).
- Clean ledger incl. many NULLs: m12 creates the index, rows kept, rerun is a no-op.
- Duplicates present: the pinned behaviour is a **preflight inside the step** (`GROUP BY github_user_id HAVING COUNT(*) > 1`) that
  throws a named error listing values and actor ids, never deletes or merges; version stays `m11`; rows intact; after a human
  resolves the duplicate, a retry reaches m12. Without it, `CREATE UNIQUE INDEX` throws a bare constraint error and, because
  `init()` rethrows, every request fails.
- The test proves the code path, not production: the maintainer re-runs the duplicate check immediately before the push (the
  2026-10-17 result, 1 actor and 0 duplicates, predates UI logins that create actors).

## 7. CI cost

In-memory SQLite, no I/O: about 3 ms per case; roughly 25 to 40 cases (11 historical starts, about 12 shape cases, M12 cases)
add under 2 s to `npm test`. No new dependency, no new job. The `migration-tests` job (`ci.yml`, `--testNamePattern="migration|schema"`)
matches by test name, so name the new `describe` blocks with "migration". Fixtures: tens of KB of SQL. `npm install` per worker
dominates that job, not the tests.

## 8. Files

| File | Change |
|---|---|
| `docs/MIGRATION-LEGACY-TEST-PLAN.md` | this plan |
| `scripts/snapshot-schema-fixtures.sh` | new; `git show` per schema.sql commit into the fixtures dir; no network, no wrangler |
| `workers/spec-do/tests/fixtures/legacy/*.sql`, `index.ts` | new; T1 snapshots, T3 pinned shapes, manifest |
| `workers/spec-do/tests/fixtures/legacy/prod-schema-<date>.json` | new, **after maintainer approval**; T2 |
| `workers/spec-do/tests/legacy-ledger.ts` | new helper (section 4) |
| `workers/spec-do/tests/migration-matrix.test.ts` | new; A1 to A4 over the manifest |
| `workers/spec-do/tests/migration-legacy.test.ts` | edit: hand-typed DDL moves to fixtures; `'m11'` literals replaced by the fresh version; row-preservation asserts added; drop the duplicate of `migrations.test.ts:113` |
| `workers/spec-do/tests/migration-actors-unique.test.ts` | new, with the m12 PR |
| `docs/OPS.md` (step 1), `docs/FOCUS.md`, `docs/OPEN-QUESTIONS.md` | step 1 points at the fixture dir; FOCUS status; findings the tests expose |

## 9. Human gates (spine)

- **Any edit to `workers/spec-do/index.ts` migrations or `schema*.sql`/`schema-inline.ts`** is spine. This plan adds none. If a
  case fails, write the finding to `docs/OPEN-QUESTIONS.md` and mark the case `it.fails` or `it.todo`; do not patch the migration.
- The m12 preflight and its fail-loud versus skip-and-warn choice (availability against a clear refusal) is the maintainer's.
- T2 and any other production read need the maintainer's approval; agents do not run them, and never deploy.

## 10. Recommended first slice (one PR, default tier, no production access)

`scripts/snapshot-schema-fixtures.sh` + T1 fixtures + `legacy-ledger.ts` + `migration-matrix.test.ts` (A1 to A4 for every
historical start version) + replace the `'m11'` literals. It tests real historical shapes instead of today's SQL, and may find a
real convergence bug; report it, do not fix it in the same PR. T2 and the m12 cases follow.

## Open questions

1. Maintainer: approve the T2 read-only query (and optional row counts)? Which access path should OPS.md record?
2. M12: refuse with a named error, or skip the index with a warning?
3. Is a one-off workerd fidelity check wanted, or is `node:sqlite` enough?
