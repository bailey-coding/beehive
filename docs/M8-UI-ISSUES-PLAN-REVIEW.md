# Review of `docs/M8-UI-ISSUES-PLAN.md` (cc1ef7e)

Task `ui-issues-plan-review` | spec: `docs/MILESTONES.md` M8 | reviewed 2026-10-17 on `origin/agent/ui-issues-plan`
(based on 11d0816; `git merge-tree --write-tree origin/main HEAD` is clean against 17ff87f, which adds the M9/M10 text).
Method: read the code on the branch, ran every URL from the plan's section 2 table, plus 13 more, through the planned and
the current regexes (node), `npm run typecheck` (clean) and `npm test` (583 passed, 15 failed; all 15 in
`tests/cli-behavior.test.ts`, the missing `cli/node_modules/.bin/tsx` the plan describes). Line numbers are on this branch.

## Blockers

**B1. Sections 6, 7 and 10 contradict the section 13 decisions, and decisions 6, 7 and 8 have no task.**
- §6 "Private issues ... Not changed here (Q6)" vs decision 6 "issue detail enforces `visibility`".
- §6 "`GET /app/issues/:id` stays ... unscoped" vs decision 8 "redirect to the canonical repo URL".
- §7 "require `status === 'open'`" and "DO enforcement is a spine change, Q7", and §8 "closed/locked issue -> refused", vs
  decision 7: `closed` accepts comments, `locked`/`maintainers_only` are enforced **in the DO**.
- Decision 7 says "the UI offers Reopen", but nothing can set `issues.status`: the DO has issue routes only for create,
  list, get, `stage`, `comment-policy` and comments (`spec-do/index.ts:3448-3530`), and no SQL anywhere writes
  `issues.status`/`closed_at`. The comment form also renders only when `isOpen` (`ui-pages.ts:1397`).
- §13 "New scope" lists only the links table and the closed-issue setting, so T1-T7 as written build the pre-decision design.

*Change:* rewrite §6/§7/§8 to match §13 and add tasks: **T1b** (DO comment enforcement, spine; see B2); in T4,
`visibility === 'private'` -> 404 on detail, on the comment POST and on the legacy route (404 *before* redirecting, so the
canonical URL of a private issue is not disclosed); in T3, the legacy `GET /app/issues/:id` becomes a 302 to
`{repoUrl}/issues/{id}` (render in place if the repo cannot be resolved); comment form shown unless `locked`. Either add a
close/reopen DO route + UI task (spine, new route, so old-DO callers get 404 and must show an error, not a silent no-op),
or strike "UI offers Reopen" until one exists.

**B2. DO enforcement of `locked`/`maintainers_only` (decision 7) is bypassable as the DO stands; T1b must cover all of:**
- `PATCH /api/issues/:id/comment-policy` has no authorisation: `updateIssueCommentPolicy` (`index.ts:4103-4110`, route
  `:3500`) lets any actor set `open` again, so a DO-side `locked` check alone is meaningless. Require `isMaintainer`
  (`:1859`) there. It also does not validate the value, so a bad value is a CHECK failure, which surfaces as a 500.
- The main `fetch` catch maps only `ConflictError` to 409; everything else is 500 (`index.ts:3747-3752`). A
  `ForbiddenError` thrown for a locked issue is a 500, not the "explicit 4xx" decided. Map Bad/Forbidden/NotFound
  like the internal handler already does (`index.ts:1836`). I checked the other DO callers: none branches on 5xx vs 4xx
  (queue-consumer only logs `status`, `queue-consumer/index.ts:139-342`), so the remap is mixed-version safe.
- Check against the **header** actor, not `body.createdBy || actorId` (`index.ts:3517-3521`); reject a mismatch.
- `createIssueComment` (`index.ts:4114`) never checks that the issue exists or is live: a tombstoned issue accepts comments.
- State what "maintainer" means: it is the ledger-global `actors.role` (`index.ts:1859-1866`), not per-repo or per-org.

## Should-fix

**S1. T3 may merge before T1 (§10 T3 "T1 not required to merge").** If the maintainer pushes `main` for any reason in
between, the new UI omits `number` against a DO that requires it, and create fails for as long as T1 is unmerged, not for
"minutes" as the §4 matrix row says. *Change:* T3 merges to `main` only after T1 is on `main`.

**S2. Spine authorship (AGENTS.md rule 2: the DO ledger is *hand-written*).** The plan only asks a human to review T1
(§9.1). *Change:* get explicit maintainer sign-off that an agent may write T1/T1b, or have the maintainer write them. The
catch-all status remap in T1b touches every DO route: plan first, heavy tier (`docs/AGENT-ROUTING.md` table).

**S3. Atomicity: the reasoning is right, but the write should be one transaction and the test harness should change.**
The adapter is synchronous (`sql-storage.ts:43-46`: `sql.exec` at first `step()`), and the route's only `await` is
`request.json()`, before `createIssue` (`index.ts:3449-3450`). So SELECT MAX+1 then INSERT cannot interleave. But
`createIssue` runs its INSERT and `recordHistory` outside `transactionSync` (`index.ts:1478-1487`), unlike every other
ledger write. *Change:* do the explicit-number conflict check, the MAX+1, the INSERT and the history row in one
`this.state.storage.transactionSync`, and reject a tombstoned repository with 409. Write `issue-numbers.test.ts` on
`workers/spec-do/tests/sqlite-state.ts` (foreign keys on, `transactionSync` rolls back), not on the
`tests/unit/spec-do-list-bind-order.test.ts` harness, which disables foreign keys (`:18`).

**S4. CSRF on the new POST routes.** `ISSUE_COMMENT` and `REPO_ISSUES` are evaluated before the existing POST block that
calls `sameOrigin` (`ui.ts:384-385`). §7 adds `sameOrigin` for comments only; §2/§6 say nothing for create. *Change:*
call `sameOrigin` once, before any DO read, for both routes (and the `/app/issue_comments` shim). Test a cross-origin
request and a missing `Origin` header on each route; §8 has one undifferentiated "cross-origin POST -> 403".

**S5. Section 13 schema work: right to separate it, wrong about the hazard, and the method is missing.**
- Hazard: OPS says that after a rollback, "old code would then run against the newer schema; that combination is
  untested" (`docs/OPS.md:75-76`). It does not run: `runMigrations` throws `Unknown schema_version` (`index.ts:836`),
  `init()` rethrows (`:495-499`), and every request fails. So any version bump turns a rollback (rule 7) into an outage.
  Record that in `OPEN-QUESTIONS.md`, and fix the OPS line (T6).
- Precedent: m4-m8 shipped in one push, each step additive and idempotent (`IF NOT EXISTS`, `addColumnsIfMissing`,
  `index.ts:808-824`), with a read-only `schema_version` check before and after (`OPS.md:30-62`). Nothing in m3-m8 made
  them rollback-safe.
- Safe method: **push A**, with no bump: `runMigrations` accepts an `m<N>` above the latest it knows, logs it and
  continues, with a test. A becomes the rollback floor. **Push B**, only after A is live: step `m9` =
  `CREATE TABLE IF NOT EXISTS` for the links table + `addColumnsIfMissing('repositories', ['<setting> TEXT NOT NULL
  DEFAULT ...'])`. Use a column, never a new `comment_policy` value: widening a CHECK needs a table rebuild
  (`index.ts:69-71`). Also: apply the same section in the fresh-init path (`initSchema`, `:514-529`); update `schema.sql` and
  `schema-inline.ts` together (`spec-do/tests/schema-sync.test.ts`) and `migrations.test.ts` ("fresh ledger starts at
  m9"); put the new table in `ORG_PURGE_ORDER` before `issues` (`:87-101`) or org purge fails on its FK; add an OPS
  checklist entry. Old code never touches the new table, and its INSERTs name their columns, so defaults fill.
  Restrict links to issues in the same organisation, so a link cannot reveal another org's issue titles and purge stays per org.
- Placement: not M8 (M8 is parity/route correctness; its exit criteria do not include new tables). Make it its own
  milestone after M9: its UI half edits the issue detail page that M9 re-lays out.

**S6. Dot segments.** `validComponent` (`ui.ts:150`, `ui-pages.ts:165`) accepts `.` and `..`, and `createRepository`
does not validate names (`index.ts:4126-4150`). A repo named `..` gets the canonical URL `/app/repos/acme/..`, which URL
parsers collapse (it ends up in `href`s and, after T3, in `Location`). *Change:* the single shared validator rejects
`.`/`..`, so `buildRepoUrl` falls back to the UUID URL. Add both to `ui-repo-ref.test.ts` (§8 lists only `..`).

**S7. Missed defect (12).** `renderRepoIssues` (`ui-pages.ts:552`) and `specPage` (`:744`) use `getName(i)` as the link
text; issues have `title`, not `name`, so the links render empty. T4 rewrites these hrefs anyway: use `getIssueTitle` + number.

**S8. M9 conflict: where `flash()` lives.** M9 wants "one flash/error area" in the shared layout (`ui-html.ts`, MILESTONES
M9). Put `flash()` in `ui-html.ts` now, not `ui-pages.ts` (§6), so M9 reuses it without moving it. Keep §11's order.

## Nits

- N1. §4 matrix "old DO inserts NULL -> NOT NULL failure": `JSON.stringify` drops `number`, and the old DO binds
  `undefined` into `sql.exec`; workerd may reject that binding before SQLite does. The outcome is the same (500 JSON, no
  row), but tests should assert the status and that no row was written, not the message. The raw DO error text reaches the
  flash; prefer a fixed "Could not create issue" plus a log line.
- N2. §6 Location: `encodeURIComponent(issue.id)`. `generateId` is safe today, but every other path segment is encoded.
- N3. §4 "BadRequestError -> 500, decide in T1": decided by B2 (map in the catch); test the 400 for non-positive and non-integer numbers.
- N4. Line drift: `createIssue` is at `index.ts:1465`, not `:1450`; `callDo`'s `!res.ok` check is `ui.ts:846`.
- N5. §8 add: the UUID-form ref resolves via `reader.get`, so a DO catch-all 404 reads as "not found" and falls through to
  a 404 page, not a 502 (defect 11). Pin that in a test so the Q4 follow-up has a target.
- N6. T1 changes CLI behaviour: a duplicate `--number` (required, `cli/src/commands/issue.ts:14`) goes from silently
  accepted to 409. Note it in T6 (`FEATURE-PARITY.md`, CLI docs).

## Verified correct

- Defects 1-6 and 7-11 as stated: the nested GET routes are unreachable (`ui.ts:134` matches only 2-3 segments, issue
  routes nested at `:183/:233/:283`); a 3-part POST reaches `createIssue` (`:392`) and a 2-part POST hits "Method not allowed"
  (`:140`); filtered max+1 (`:761-764`); unencoded `#` Location (`:783`); `issuePage` unscoped (`:327`, `ui-pages.ts:1313`);
  five resolver copies; double `esc` via `subHeader` (`ui-pages.ts:77-81` + `:1219`); null-on-"Not found" (`ui.ts:54`,
  DO catch-all `index.ts:3745`); the `ui.test.ts` stub throws `BLOCKED` on filtered lists (`:64`).
- Regexes: all section 2 rows parse as tabled; `acme/issues/issues` -> ref `acme/issues`; `acme/issues/new` -> ref `acme`
  + `new`, which falls through correctly when no repo has id `acme`; 4+ segments and trailing slash match nothing.
- Atomicity of MAX+1 + INSERT in one synchronous block; counting tombstoned rows is sufficient, because purge deletes
  issues only with their whole organisation (`ORG_PURGE_ORDER`), so a live repo never reuses a number.
- No `LATEST_SCHEMA_VERSION` bump in T1 (`index.ts:27`): correct and necessary.
- Mixed version: no worker other than `beehive` calls any issue route (grep over `workers/`, `tests/e2e/`), so
  promotion-worker, queue-consumer and gate-workflow add no rows to the matrix. The remaining rows hold, except S1.
- `buildRepoUrl`'s escaped output is byte-identical to its unescaped form for `[A-Za-z0-9_.-]`, and always starts
  `/app/repos/<non-empty>`, so there is no header injection and no open redirect (modulo S6).
- Cross-org: the UI is a single allowlist (`ALLOWED_GITHUB_USERS`, `ui.ts:4-6`) with no org membership, so every
  signed-in user can already see every org. The repo-scoped detail check is the right boundary; a per-org read model is out of scope.
- Local e2e cleanup works: `start-e2e-workers.sh:81` sets `PURGE_MIN_AGE_HOURS=0` (default 24).

## Verdict

**Approve with changes.** Routing, the shared resolver, and DO-side numbering without a schema bump are sound. B1 and B2
must be fixed in the plan before T1 or T3 starts; S1-S5 before T3 merges.
