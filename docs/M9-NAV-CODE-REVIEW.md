# M9 code review (L9): site navigation

Task `m9-code-review` | spec: `docs/M9-NAV-PLAN.md` v2 (sections 9, 10) and `docs/M9-NAV-PLAN-REVIEW.md` | subject:
`origin/main...origin/agent/m9-nav` (1e4eef6, 8 commits L1-L8) | reviewed 2026-10-17 in worktree `agent/m9-codereview`.
Nothing on the subject branch was changed. Line numbers are on 1e4eef6.

## Findings

### Blockers

None.

### Should-fix

**S1. The flash "Done:" / "Error:" lead-in from plan 2.2 is missing, so ok and error now differ by colour only.**
`flash()` (`workers/api/ui-html.ts:151-160`) wraps the text in `role="status"` / `role="alert"` but adds no lead-in.
L1 also set both texts to `#e6edf3` (`ui-html.ts:339-341`), so the only visible difference left is the border and background
hue. Before M9 the text colour differed as well. That fails WCAG 1.4.1 (use of colour) for sighted colour-blind users, and plan 2.2
explicitly requires a bold lead-in. Fix: emit `<strong>Done:</strong> ` and `<strong>Error:</strong> ` inside the `<p>`,
and add a test in `ui-layout.test.ts` ("flash, tabs, account").

**S2. No test covers the breadcrumb href guard at render time.** Mutation: change `isAppHref(c.href) ?` to `c.href ?` in
`renderBreadcrumbs` (`ui-layout.ts:280`). All 320 `workers/api` tests still pass. The test "accepts only /app hrefs"
(`ui-layout.test.ts:221`) exercises `isAppHref` alone. Today every builder produces `/app` paths, so nothing is exploitable, but
plan 2.4.2 calls this guard the defence for a future caller. Fix: render `appPage` with crumbs `{label:'x', href:'javascript:alert(1)'}`,
`//evil`, `/appx` (not last) and assert that no such `href=` appears and the label is still rendered as text.

**S3. The docs name a review file that does not exist.** `docs/FOCUS.md:27` and `docs/M9-NAV-PLAN.md:212` point to
`docs/M9-REVIEW.md`, but this review is `docs/M9-NAV-CODE-REVIEW.md`. Fix at merge: change both references. When this review is
closed, FOCUS should also drop "review still to do".

### Nits

- **N1 (existing on main, not a regression).** A cross-origin POST to an issue route that is not a write (`.../issues/:id`,
  `.../issues/new`, or PUT/DELETE on `.../issues`) reads `/api/organizations` and `/api/repositories` before it returns 405. The
  origin check at `ui.ts:552` only covers `isPostKind`, and `resolveRepoRef` runs before `allowed` at `:564`. Probe trace:
  `405 :: GET /api/actors, GET /api/organizations, GET /api/repositories`. The same line exists on main (`ui.ts:550`). The reads
  are harmless and nothing is written. Fix if wanted: check `method === 'POST' && !sameOrigin(request)` for every issue route.
  So "a cross-origin POST reads only /api/actors" holds for every write route and for the create forms, but not for these routes.
- **N2. Laziness is not pinned at the `handleUi` level.** Mutation: add `await chrome()` right after `makeChromeSource`
  (`ui.ts:138`). All tests pass. The behaviour is unobservable today: every non-GET request gets the light source (method
  awareness is well covered, 7 tests fail when it is removed), and every session GET either renders or shares the org read
  through the memoiser. Only the unit test `ui-chrome.test.ts:56` covers laziness. Leave a note, or add a test once a GET
  redirect route without an org read exists.
- **N3. Invented fallback labels.** `repoCrumbs` and `specCrumbs` use `'Repository'` / `'Spec'` when the name is empty
  (`ui-layout.ts:189,198`), which plan 2.3 rules out ("never an invented label"). Names are required on create, so this is theoretical.
  Fix: drop the crumb, or keep the fallback and note it in the plan.
- **N4. The "500+" cap counts after filtering.** `total: orgs.length` is counted after the `isValidId` filter
  (`ui-layout.ts:94-97`), so a 500-row read containing one bad id shows "499". Fix: compare `rows.length` with `ORG_READ_LIMIT`.
- **N5. A selector that can never match.** `.badge.rolled\\ back` (`ui-html.ts:330`) now outputs a valid selector for a class
  containing a space, which no element can have. The old output, `.badge.rolled back`, was a descendant selector and never matched
  either. Delete it (`.badge.rolled-back` stays).
- **N6. No test covers the memoiser key.** Mutation: key on the path only, dropping the limit (`ui-layout.ts:130`). All tests
  pass. A `list(p, 100)` would then get a cached 500-row list. Add one assertion to `memoizeReader`'s test (`ui-chrome.test.ts:82`).
- **N7. Possible e2e flake.** "current org listed first" (`tests/e2e/ui-nav.test.ts:204`) assumes this run's org is among
  the 500 rows read. A local ledger with more than 500 leftover orgs would fail it. Acceptable for a local-only suite, since
  cleanup by purge keeps the ledger small.
- **N8. Two `aria-current="page"` marks on repo pages.** Repo pages carry two marks, the active tab and the last crumb.
  Both are allowed because they sit in different sets, but the tab's href (`?tab=overview`) is not the current URL. Optional.
