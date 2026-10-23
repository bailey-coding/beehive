# M8 PR 1 review: Spec DO issue changes (`agent/m8-issues-do`)

Task `m8-pr1-review` | reviewer: independent agent, 2026-10-17 | subject `git diff origin/main...origin/agent/m8-issues-do`
(94860d4 D1, 37e16fd D2, bcca5bc D3, b88422a actor validation) | spec: `docs/M8-UI-ISSUES-PLAN.md` on `agent/ui-issues-plan-v2`
(sections 4, 8, 9, 10; section 15 wins) and `docs/M8-UI-ISSUES-PLAN-REVIEW.md`. Line numbers are on the PR head (b88422a).

Ran it myself: `npm run typecheck` is clean; `npm test` (after `npm install` in `cli/`) gives **32 files, 645 passed, 0 failed**. The implementer's claim holds.

## Blocker

**B1. A large explicit `number` breaks uniqueness for the repository for good.** `index.ts:1524` accepts any `Number.isInteger` value. `1e300`
passes, gets stored, and from then on `COALESCE(MAX(number),0)+1` (`:1538`) comes back as the same float, so **every later auto-numbered issue
gets the same number**. I reproduced it in a throwaway test: an explicit `1e300` create, then an auto create, both returned `number: 1e+300`.
Any value from about 2^53 up does the same, because node and DO SQLite hand back JS numbers. There is no single-issue tombstone
(`tombstoneScope`, `:1946-1969`), so the only way out is to tombstone the whole repository. Reachable by any master-token caller and by the CLI
(`cli/src/commands/issue.ts:14` accepts any positive `parseInt`). This breaks D1's core invariant ("a number is never reused", distinct numbers).
*Fix:* `if (!Number.isSafeInteger(number) || number < 1 || number > 2_147_483_647) throw new BadRequestError(...)`, and add `1e300` and
`2**53` to the `it.each` at `issue-numbers.test.ts:84`.

## Should-fix

**S1. Bad request bodies on the issue routes still reach the global catch as a 500 that leaks SQLite text.** A create with no `title` gives
`500 "Provided value cannot be bound to SQLite parameter 4."`, and with no `repositoryId` it gives `... parameter 1`. Both come from
`issueRoute` rethrowing unmapped errors (`:1485`) into the global catch (`:3817-3822`, unchanged). A non-string `title` (`5`) is stored as-is
(201). Invalid JSON, or a JSON `null` body, also gives a 500: `await request.json()` (`:3518`, and the same at the status, policy and comment
routes) sits outside `issueRoute`, and `body.createdBy` on `null` throws a TypeError inside it. The plan only asks for 4xx on its listed checks,
so this is not a conformance failure. But the stated goal of section 8 is "every error asserts the exact status (not 500)", and the UI PR will
show these messages. *Fix:* inside `issueRoute`, parse JSON (bad JSON is a 400), require an object body, and require `title`/`repositoryId` to
be non-empty strings (400). Add three test cases.

**S2. A section 15 test is missing: first-time login.** Section 15 asks the PR to "verify ... what happens for a first-time login with no row
and write a test". `ui-actor.test.ts` covers a stale session (redirect to `/login`) and a forged `createdBy` form field, but nothing exercises
`ensureActor` (`ui.ts:497-506`) creating the row. `OPEN-QUESTIONS.md` asserts "a first login creates the row" without a test behind it.
*Fix:* add a test that runs the OAuth callback against a stubbed GitHub user and asserts `POST /api/actors` followed by a session carrying
the new id. While doing that, note in OPEN-QUESTIONS that both `ensureActor` and the session existence check (`ui.ts:121-123`) read
`/api/actors?limit=500`. Beyond 500 actors, a real user's row is not found: every request then bounces to `/login`, and login creates a
duplicate actor. This predates the PR, but issue writes now depend on it.

**S3. The caller inventory section 15 requires is not written down.** Section 15 says to "list each [existing worker caller] in the PR
description". No PR exists and the commit bodies are empty. I re-derived the list: only the `beehive` worker calls issue routes
(`api/index.ts:264-283, 1746-1834`, and `ui.ts:761, 775, 805`). `queue-consumer` and `sandbox-runner` never call them. `tests/e2e` has no
issue calls. The CLI's `issue create` sends no actor (`cli/src/utils/api-client.ts:520-525`, no `options`). *Fix:* put this list in the PR
description when the PR is opened.

## Nits

- **N1. Scope creep:** `workers/shared/schemas.ts:349` (and the zod schema at `api/types.ts:592`) make `number` optional. Neither schema is
  imported anywhere (grep for `CreateIssueRequestSchema`), and the plan lists only `api/types.ts`. The change is harmless; keep it or drop it,
  but mention it. Nothing else beyond the plan: `ui-actor.test.ts`, the OPEN-QUESTIONS proposal and the edge passthrough plus its test are all
  required by section 15 or D3.
- **N2. The "20 parallel creates" test (`issue-numbers.test.ts:58`) does not prove the transaction.** Removing `transactionSync` from
  `createIssue` still passes it, because the handler is synchronous after `request.json()`. Only the rollback test (`:96`) fails, as it
  should. The comment `transactionSync` (`:4228`) can be removed with no test failing (mutation M9 below). That is acceptable, since there is
  one write and nothing to roll back. Retitle the parallel test so it doesn't claim more than it proves.
- **N3.** `requireIssueActor`/`requireSameAuthor` and the comment body checks run outside `transactionSync`, though in the same synchronous
  turn, so they behave the same as the "all checks in one transactionSync" wording of D2d. Fine; say so in the doc comment.
- **N4.** `PATCH /api/issues/:id/stage` (`:3552`, `transitionIssue` `:1574`) still has no actor check, and it can set stage `closed`. It does
  not touch `status`, so it is no way around D3, and it is outside the plan. Note it for the follow-up list.
- **N5.** The 10,000 limit counts UTF-16 code units (`body.length`, `:4227`): 5,001 emoji are refused. That's fine, and the UI should use the
  same `.length` (HTML `maxlength` also counts code units).
- **N6.** A `comment_policy` of NULL (the column allows it) is treated as restricted (`:4230`). This fails closed; no current write path
  produces NULL.

## Verified correct

- **Conformance.** D1: `number` is optional (`api/types.ts:544`). Unknown repo gives 404, tombstoned repo gives 409. Explicit 0/-1/1.5/"3"
  give 400. A duplicate gives 409, tombstones included. Auto numbering is MAX+1 with tombstones counted. The author is the header actor; a
  differing `body.createdBy` gives 403. D2a: maintainer check (403), then the value (400), then a live issue (404); a service actor is
  refused because `isMaintainer` (`:1929-1937`) excludes service actors. D2b, following section 15: `locked` and `maintainers_only` accept
  maintainer comments only (403 otherwise); `closed` accepts comments; a tombstoned issue gives 404; an empty, whitespace or non-string body
  gives 400; 10,000 is accepted and 10,001 refused. D3: creator or maintainer, otherwise 403; a repeat is a 200 no-op with no history row;
  reopen clears `closed_at`/`closed_by`; history carries the current stage; edge passthrough at `api/index.ts:276-278`. Actor: unknown ids,
  `'unknown'`, an empty header and a service actor all get 403 on all four writes (`:1495-1500`). Ids are case-sensitive (an uppercased
  UUID gets 403).
- **Atomicity in production.** `createIssue` does the repo check, number, INSERT and `recordHistory` in one `transactionSync` (`:1531-1571`)
  with no `await` inside. `sql-storage.ts:43-46` runs `sql.exec` synchronously, so DO SQLite rollback applies. No nested `transactionSync`:
  the route is the only caller of `createIssue`, `createIssueComment` and `updateIssueCommentPolicy`.
- **Unchanged.** No `LATEST_SCHEMA_VERSION` change, no schema or migration change, global catch unchanged (`:3817-3822`). Mapped errors
  return the existing `{success, error|data, timestamp}` shape with fixed messages.
- **Authorization routes.** The DO has no generic entity PATCH/PUT. Tombstone and purge are maintainer-only. Service tokens are read-only at
  the edge (`principal.ts:83-93`, `authorize`). The API worker overwrites `createdBy` with the header actor (`api/index.ts:1752, 1824`), so a
  mismatch can only arrive straight at the DO. The master-token actor is still client-asserted (`principal.ts:44`), which matches the
  documented limit.
- **Mixed version.**
  - Old UI with new DO: the UI sends `number` and a matching `createdBy`, which works. A collision gives 409, which the UI shows as an error
    rather than a silent duplicate. Locked issues give 403, shown as an error.
  - New edge with old DO: `/status` hits the old DO's 404 catch-all, which is passed through. No current caller omits `number`.
  - Old edge with new DO: there is no status route at the edge; creates and comments work for real actors; a non-maintainer policy PATCH now
    gets 403, as intended.
  - CLI: before, a create without an actor wrote `created_by='unknown'`, which DO SQLite rejects as a foreign-key violation (FKs enforced,
    `OPEN-QUESTIONS.md:124`), giving a 500. Now it gets 403. The CLI never worked here, so nothing that used to work now fails.
- **`tests/unit/spec-do-list-bind-order.test.ts` change is legitimate.** All three bind-order assertions are unchanged. It now uses real
  repository ids because `createIssue` requires a live repo, and a pass-through `transactionSync` shim (`:24`) is enough for that harness.
- **Tests fail without the change.** I made 11 mutations in my worktree, reverted each one, and re-ran the two new test files. Ten fail
  at least one test: no transaction in create; no maintainer check on policy; `locked` blocking maintainers; tombstoned issues treated as
  live; author check off; service exclusion off; MAX ignoring tombstones; status creator check off; reopen keeping `closed_at`; tombstoned
  repo allowed. One survives: no transaction in comment (see N2).
- **Security.** Every id reaches SQL as a bound parameter, and path segments match `[^\/]+`. Nothing new leaks; S1 is the existing
  global-catch leak.

## Verdict

**Approve with changes.** The spine logic, atomicity, authorization and mixed-version behaviour are sound and match section 15.
**Merge readiness:** not ready until B1 is fixed and tested (one line plus two test cases). S1-S3 should land in this PR, or the maintainer
should defer them explicitly. The UI PR (`agent/m8-issues-ui`) stays blocked on this PR being on `main`.
