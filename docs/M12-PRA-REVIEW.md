# M12 PR-A review (T0 actor lookup, T1 newer-schema tolerance)

Reviewer: independent agent, 2026-10-18. Subject: `origin/main...origin/agent/m12-pr-a` (551675e docs, 995bd22 T0,
adb86bd T1). Spec: `docs/M12-IMPL-PLAN.md` (T0, T1, section 3 matrix, section 5 floor, sections 7-8), RFC-0008.
Line numbers are on the subject branch.

## Findings

**Blockers: none.**

**Should-fix**

- **S1 Test gap: the client-side `.find` in `ensureActor` is untested** (`workers/api/ui.ts:362`). Mutant
  `const existing = rows[0]` passes all 572 api + spec-do tests. Against an old DO, which ignores `github_user_id`, that
  `.find` is the only thing stopping a login from being bound to the **newest actor of any user** (an authorization
  failure across users). The old-DO test (`ui-actor.test.ts`, "two rows ... ignores the filter") does not catch it
  because the matching row (`created_at` 300) is also the newest overall. Fix: make the unrelated actor newest (`other`
  at 400), and add an old-DO case where no row matches: exactly one `POST /api/actors`, and the session actor is the new row.
- **S2 The OPS floor invariant allows a table that breaks the floor's purge** (`docs/OPS.md:83`, "a new table only
  references old ones"). Checked with a scratch test (deleted afterwards): over an `m99` ledger, a table with an FK to
  `organizations` and one row stops this build's `/internal/purge` with 409 `FOREIGN KEY constraint failed`. That
  batch rolls back, so nothing is corrupted, but purge cannot be used while rolled back. The m9 shape (FKs to `actors`
  only) purges fine (200), because the floor never hard-deletes actors (`ORG_PURGE_ORDER`, `spec-do/index.ts:92-106`). Fix the
  wording: a new table may reference only tables the floor never hard-deletes from (today `actors`; never an
  `ORG_PURGE_ORDER` table). New columns on old tables must be nullable or have a default. No new CHECK, UNIQUE or
  trigger on an old table may reject a write the floor makes. Also note that M11's m10 unique index on
  `actors.github_user_id` would turn a floor-side duplicate insert into a failed login (fail closed, acceptable).

**Nits**

- N1 `docs/OPS.md:77` still cites `workers/spec-do/index.ts:842` for `Unknown schema_version`; it is now `:853`.
- N2 `listActors` orders by `created_at DESC` only (`spec-do/index.ts:3891-3892`). Two rows in the same millisecond
  (a login race) come back in an unspecified order, so "newest wins" (F3) is not deterministic. Add `, rowid DESC` to
  both statements, as the promotion tables already do.
- N3 The tolerance regex accepts leading zeros and any length (`m09`, `m` + 400 digits → `Infinity > 8`), and the
  warning prints the whole stored value. No real deploy writes such a value. To tighten: `/^m([1-9]\d{0,5})$/`, and
  `stored.slice(0, 32)` in the log line.

## Verified correct

- **T1 init path.** `init` → `initSchema` (`:515-555`): the fresh branch runs only without the `schema_init` KV flag, and
  its `INSERT OR IGNORE` cannot overwrite a stored `m9`. `runMigrations` (`:843-848`) checks for a newer version
  before the step loop, so on `m<N>` above 8 no `apply()`, `addColumnsIfMissing` or `writeSchemaVersion` runs. The only
  writers of `schema_version` are `writeSchemaVersion` (the loop) and the fresh-branch insert, so nothing downgrades
  to `m8`. Seeding only runs with `DEV=local`. No code enumerates `sqlite_master`. `SELECT *` sites map through
  `rowTo*` with explicit fields (spot-checked actors, promotion_states, tournaments), so extra columns are not
  returned. Tombstones are UPDATEs. With the m9 shape, the floor's purge succeeds (scratch test above).
- **Regex.** JS `$` without the `m` flag does not match before `\n`, and `\d` is ASCII only. Checked: `m٩`, `m９`,
  ` m9`, `m9 `, `m9\r`, zero-width prefix all fall through to the throw. `m8` is a no-op and `m0`-`m7` still migrate.
  `m08`, `mx`, `M9` and `''` throw. The warning is logged once per `init()`; `this.db` is then set, so once per DO
  instance. It contains only the stored version string.
- **T0 session check** (`ui.ts:124-129`, `:337-354`): 200 with `success` and a matching `id` → proceed. 404 → `/login`
  and the cookie is cleared. 5xx, a throw, bad JSON, `success:false`, or a row with a different id → 503 with a fixed
  message; no `Location`, no `Set-Cookie`, no internal details. The stub is `getSpecDoStub` (`api/index.ts:86-90`), so the
  internal token is attached; a token mismatch (401/503 from the DO gate) → 503, not a login loop. The by-id read uses
  the same `rowToActor` projection as the list (`:1688-1700`) and returns one row instead of up to 500: less data than before.
- **T0 `ensureActor`** (`:356-367`): any lookup that is not `success` with an array (a 5xx, a throw, non-JSON) →
  `null` → "Login failed", with no POST and no session cookie. An empty filtered list → exactly one POST (tested). The
  match is strict string equality in SQL (BINARY, TEXT column) and in `.find`; `String(user.id)` against a TEXT column
  has no case, whitespace or number-vs-string path to another user's row. An empty id is impossible (`user.id`
  truthy, `:308`), and the DO returns `[]` for `github_user_id=` anyway.
- **DO filter** (`spec-do/index.ts:3176-3183`, `:3887-3895`): bound parameter, `DESC` kept, and the unfiltered SQL is
  byte-identical. Same route, so the same auth tier. The edge rebuilds the URL with `limit`/`offset` only
  (`api/index.ts:1442`), and the CLI does not call it, so no external caller sees a change.
- **The four changed stubs** (`ui-chrome`, `ui-issues`, `ui-nav`, `ui.test`) are legitimate and stricter.
  `paths.every(p => p === '/api/actors')` became an exact `toEqual([...one path])`. No assertion was deleted.
- **Mutations** (worktree only, each reverted). 11 of 12 killed: create on a failed lookup; tolerance removed;
  tolerance for any `m…`; unanchored regex; regex without `$`; session 5xx or throw treated as missing; DO ignores the
  filter; UI omits the filter; session row id unchecked; filtered order `ASC`. The survivor is S1.
- **Mixed versions** (edge, UI and DO share `beehive`, so the window is in-flight DO instances plus rollbacks).
  New UI + old DO: the by-id route exists on main, and the filter is ignored, so `.find` sees the 500 newest, as today.
  With more than 500 actors, a returning user can still get a duplicate in that seconds-long window. That is accepted:
  plan section 3 says ≤500, and A3 found 1 actor in production. Old UI + new DO: no filter is sent, so unchanged.
  Rollback from B (m9) to this build: the DO tolerates m9, `user_tokens` sits idle, `bh_usr_` → 401, sessions keep
  working. Rollback from this build to pre-A: safe only while the version is `m8` (plan section 5).
- **Scope.** Only T0, T1, the OPS floor text with its placeholder, and the two plan docs, which are byte-identical to
  `agent/m12-plan` and `agent/m12-review`.

## Runs

- `npm run typecheck`: clean. `npm test`: 38 files, **870 passed**. `cli/`: `npm install` and typecheck are clean; `npm test`
  finds no test files (pre-existing; PR-A does not touch the CLI).
- Local e2e (`E2E_UI=1 scripts/start-e2e-workers.sh`, `npm run test:e2e:local`): **70 passed, 5 skipped**. Workers
  stopped afterwards. Production was not touched.

## Verdict

**Approve with changes.** T0 and T1 are correct and safe to deploy as push A. S1 (one test) and S2 (OPS wording)
are small and should land on this branch before merge. N1-N3 are optional.
Merge-readiness: ready once S1 and S2 are fixed. No re-review needed beyond checking that the new test fails with `rows[0]`.
