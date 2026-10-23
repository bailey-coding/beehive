# M8 PR 1 re-review: fixes on `agent/m8-issues-do`

Task `m8-pr1-recheck` | independent re-reviewer, 2026-10-17 | subject `git diff b88422a..origin/agent/m8-issues-do` (6babb2c B1, 65ab327 S1,
3add3dd S2, a3848d2 transaction test, 0526df5 empty commit) | prior review: `docs/M8-PR1-REVIEW.md` on `agent/m8-do-review`. Line numbers are on head 0526df5.

Ran it myself: `npm install` in `cli/` and the root, then `npm run typecheck` is clean and `npm test` gives **32 files, 666 passed, 0 failed**
(was 645; +21 new cases). The diff touches 5 files: `spec-do/index.ts`, three test files, `OPEN-QUESTIONS.md`. Nothing in `workers/shared`, `api/index.ts` or `cli/`.

## Blockers
None.

## Should-fix
None.

## Nits
- **N1. The caller table (S3) exists only in the body of empty commit 0526df5**, not in a file. It must be pasted into the PR description when the PR is opened.
- **N2.** `OPEN-QUESTIONS.md` addendum cites `ui.ts:119`; the `/api/actors?limit=500` read is at `ui.ts:121` (119 is the comment). `ui.ts:498` is right.
- **N3.** The cap bounds only explicit numbers. Auto numbering still continues past it (`MAX+1` after 2^31-1 gives 2^31; the new test at `issue-numbers.test.ts:72` asserts
  this on purpose). That is safe: values stay below 2^53 and distinct. Any row stored before the cap with a float-sized number is not repaired, and auto numbering in that
  repository still repeats. No migration was asked for; check prod only if an earlier test pushed one.
- **N4.** Out of scope, still unguarded: `PATCH /api/issues/:id/stage` (`index.ts:3558`) does `await request.json()` and gets a 500 on bad JSON; so does the edge
  (`api/index.ts:1746-1751`, `1780-1788`). Already noted for the follow-up list, along with the missing actor check on the stage route.

## Verified correct (path:line)
1. **B1 cap.** The only code that reads an explicit number is `createIssue` (`index.ts:1541`). Its callers: the DO route (`:3544`) only; the edge `handleCreateIssue`
   (`api/index.ts:1746`) and the UI (`ui.ts:761-770`) both reach it through that route, so one check covers the UI, API and CLI paths. The CLI (`cli/src/commands/issue.ts:14-16`) still
   accepts any positive int and the DO now answers 400 above 2^31-1. I sent each value through the route (`number` field raw JSON): `true`, `false`, `[1]`, `{}`, `"1"`, `0`, `-0`,
   `1e10`, `1e300`, 2^31 all give **400**; 2^31-1 gives **201**; `null` is treated as omitted (201, auto number, unchanged behaviour). Called directly: NaN, ±Infinity, `true`,
   `[1]` all throw `BadRequestError` (`Number.isSafeInteger` is false for non-numbers). JSON cannot carry NaN/Infinity (they become `null`). The UI sends `max+1` (`ui.ts:763-770`),
   far below the cap. No fixture used a larger number: the whole suite passes.
2. **S1.** All four routes (`:3535`, `:3586`, `:3594`, `:3606`) go through `issueRoute(request, ...)` with `return await`, so a rejection from the async mapper is caught by the global
   catch. Order is actor 403, then JSON (400), then handler. Messages are fixed strings (`:1493-1496`, `:3537-3541`), never SQLite text. The global catch (`:3830-3836`)
   and the whole file outside `:61-65`, `:1471-1499`, `:1541`, `:3535-3610` are untouched (`git diff` shows no hunk there). No other route changed. Test: the unknown-actor case still gets 403
   before the body is read (`issue-numbers.test.ts:166`).
3. **Mapper.** Still Bad 400, Forbidden 403, NotFound 404, Conflict 409, everything else rethrown (`:1495-1498`). The four classes are thrown inside `fn` only for validation, ownership,
   missing issue/repo and duplicate number (`:1542-1558`, `:4193-4247`); the other throw sites (e.g. `:1885-1891`) sit on other routes. A real fault (FK, SQLite, history write) is still
   a 500: the transaction test relies on it. I found no path that turns a bug into a 4xx.
4. **Mutations (all run in my worktree, then reverted; `git status` clean).**
   - Cap removed (`isInteger`, `<1` only): 3 fail (`1e300`, 2^53, 2^31). Only the upper bound removed: 1 fails (2^31).
   - `BadRequestError ? 400` removed: 12+ fail (all 400 cases). Body-shape guard removed: 4 fail (null body and the three malformed-body routes). Title check removed: 3 fail.
   - `transactionSync` removed from `createIssue`: 2 fail (the old rollback test and new `a3848d2`, which checks no orphan row and no gap with every third history write failing).
   - `return await` changed to `return`: 2 fail (the same two, since the 500 escapes the global catch).
   - `ensureActor` never creating the row / never reusing it: the first-login test fails in both cases.
   The retitled parallel test (`:58`) now says it does not prove the transaction, which is true; nothing false is claimed.
5. **Scope/schema.** `LATEST_SCHEMA_VERSION` is still `'m8'` (`index.ts:27`); no schema or migration change; no new files except edits above. The extra body/labels type checks in create are within S1.
6. **S2 test.** Runs the real callback against the real Spec DO with a stubbed GitHub; asserts the new `human` actor has no role, `/app` accepts the session, an issue write is 201, a lock is 403, and a
   second login reuses the row. The 500-actor limit is recorded in OPEN-QUESTIONS.

## Verdict
**Approve.** B1, S1, S2 and the N2 test fix are done and each is pinned by a test that fails without it; S3 only needs pasting into the PR text.

Merge-readiness: ready to open the PR; paste the 0526df5 caller table into the description. Merging is not deploying: the maintainer's push to the Artifacts repo is a separate human step.
