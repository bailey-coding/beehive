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

## Verified correct (with evidence)

1. **Origin, method and session checks come before every DO read.** The session check and `/api/actors` run before any chrome
   exists (`ui.ts:111-127`). `makeChromeSource` (`ui-layout.ts:109-112`) gives every non-GET/HEAD request the light chrome,
   which has no read. A throwaway probe test recorded the DO call sequences: cross-origin POST to create-issue, `/app/issue_comments`,
   `/app/orgs/:id` and `/app/organizations` -> `GET /api/actors` only. Same-origin `POST /app/organizations` -> actors + the
   `POST` itself. PUT/DELETE/PATCH on detail routes -> actors only (404 kept). `/logout` and the OAuth routes run before the session
   and use `page()` (no chrome). `ui-issues.test.ts:354-362` is unchanged (no pre-existing test file is modified) and passes.
2. **Nothing leaks across requests.** `ui-layout.ts` has only constant module state (`SWITCHER_LIMIT`, `ORG_READ_LIMIT`,
   `MAX_LABEL_CHARS`). `once()` and `memoizeReader()` are closures created inside each `handleUi` call (`ui.ts:134-138`), around
   a reader that is itself built per request with that request's `actorId`. One user's list can never reach another request.
   The memoiser applies to GET/HEAD only.
3. **Memoised reads share one call.** Repo page trace: one `GET /api/organizations` across `resolveRepoRef`, the page, and the nav. Org page:
   the nav read comes last (lazy). Dashboard and trial: one read each (tests `ui-nav.test.ts:87,405`; killing the memoiser fails both).
4. **Data exposure.** The switcher lists the same unfiltered organization list the dashboard already shows to any allow-listed
   user (risk 5 in the plan). Crumbs use names the page already renders. Org, repo and spec crumbs come from list rows, so a
   tombstoned parent drops its crumb (`orgCrumb` returns null; tests `ui-nav.test.ts:322,410`). A private issue still returns 404 before any
   crumb is built (`ui-pages.ts:1301`, test `:232`). A failed nav read shows "Organizations unavailable" linking to `/app`, never "No organizations" (`ui-layout.ts:242`).
5. **Escaping.** `labelHtml` escapes, truncates to 40 code points (full text in `title`) and wraps in `<bdi>`. It covers the login, the
   switcher names and every crumb. h1 and `<title>` go through `esc`, and the search echo uses `esc(opts.query)`. Switcher hrefs use
   `isValidId` + `encodeURIComponent` + `esc`. `buildRepoUrl` output is used as is (no double escape: `R&D` test `ui-nav.test.ts:264`).
   The search form is `method="GET"` and its action is never the query. Sign-out is a POST to `/logout` with the existing
   same-origin check (`ui.ts:115`). There is no `<script>`, no inline handler and no new `style=""`. No new header or CSP (matches the plan).
6. **Mutation results** (in this worktree only; each one reverted, `git status` clean afterwards). Each mutation listed was caught:
   method-unaware source (7 tests fail); unescaped last crumb (4); unescaped middle crumb (3); broken org, repo and Issues crumb hrefs (10/3/3);
   issue-route origin check dropped (3); create-form origin check dropped (6); failure as `ok:true, []` (3); "unavailable" relabelled
   (3); memoiser off (2); unescaped search echo (2); unescaped switcher names (3); unescaped login (2); HEAD as light (1). The
   survivors are S2, N2 and N6.
7. **Spec conformance.** There is one search box per page (in-page forms removed, `#search` results kept, disabled with a hint on the
   dashboard and status pages). The pre-session `page()` links the brand to `/about` and has no navbar (`ui-html.ts:398-411`). The skip
   link target `main#main` exists in both shells. There is exactly one `<h1>` (no `<h1` left in bodies; Details h3 -> h2). `aria-current`
   follows the 2.2 rule (tests `ui-layout.test.ts:70-97`). Landmarks: header, labelled Primary / Breadcrumb / Repository-sections
   navs, `role="search"`, main. "Issues" appears only with `repoUrl`. `Chrome` and `renderAccount` hold no M10 fields. No route, schema or DO change.
8. **Status codes and messages are unchanged.** 404 "Method not allowed" on detail routes, 405 on issue routes, 403 cross-origin,
   502 "could not load this page" (now one `<p>`). The probe and e2e agree: `/app/specs/x` 404, POST issue detail 405, cross-origin 403.
9. **WCAG contrast, recomputed:** flash text `#e6edf3` on `#12261a` 13.49 and on `#2d1417` 14.52; badges `#3fb950`/`#12261a` 6.27,
   `#f85149`/`#2d1417` 5.12 (were 3.44 / 3.72). New pairs: breadcrumb muted `#8b949e`/`#0d1117` 6.15; switcher summary
   `#58a6ff`/`#161b22` 6.85; header current `#fff`/`#161b22` 17.3. The focus ring `#58a6ff` on `#0d1117` is 7.49 (non-text needs 3:1).
10. **CSS fixes and leftovers from the Python edits.** The file-tree rules are scoped to `details:not(.site-orgs)` and the open
    marker is fixed. `outline: none` is gone and `:focus-visible` was added. There are no duplicated blocks, no lost comments and no
    mangled rules. The only other changes are trailing whitespace on blank CSS lines and the N5 escape. The removed `.bar`, `.subbar`
    and `.ok`/`.err` colour rules were really unused: grep finds no `class="bar"` or `subbar` left, and `ok`/`err` appear only as
    `.flash ok|err`.
11. **No regressions in existing pages.** No pre-existing test file was touched, and all of them pass. The dashboard create forms, repo
    tabs, file tree, semantic search results and the M8 issue pages (list, new, detail, comment, close/reopen, legacy redirect) are
    covered by the unchanged suites plus the e2e create-flow test.
12. **E2E safety.** `uiConfigured()` returns false unless `isLocal`, and the suite uses `describe.skipIf(!isLocal || !enabled)` (the same gate as
    `ui-issues`). It follows only crumb links, primary-nav links and switcher links whose label starts with this run's prefix. It checks
    the cap by count (`<= 20`, total `>= 25`). Cleanup is tombstone + purge by `e2e-ui-nav-`. It runs against `localhost:8787` only.

## Gates run here

`npm install` in the root and in `cli/`: OK. `npm run typecheck`: clean. `npm test`: **832 passed** (37 files). Local e2e with
`E2E_UI=1 scripts/start-e2e-workers.sh`, then `npm run test:e2e:local`: **70 passed / 5 skipped / 0 failed**, including
`ui-nav.test.ts` (7) and `ui-issues.test.ts` (7). Workers were stopped with `scripts/stop-e2e-workers.sh`. Production was not touched.

**Manual visual checklist.** No browser was available. I rendered the dashboard, org, repo, 403 and 404 pages through `handleUi`
and read the HTML. Order matches plan 2.2 (skip link, header, crumbs, main); the switcher "Org: acme" lists the current org first
with `aria-current="true"`; the disabled search shows its hint. **Not checked:** the 360/640/960 px wrap, focus-ring visibility,
the `<details>` open/close look, the skip link appearing on focus, and whether the `#search` fragment survives the GET submit.
The HTML form-submission algorithm keeps the action's fragment, but I did not confirm it in a real browser. The maintainer should
click through these after deploy (`docs/FOCUS.md` "Deploy M9").

## Verdict

**Approve with changes.** No blockers. The key property holds: no write path and no refused write reads the DO beyond
`/api/actors`, and no state is shared between requests. S1 (flash lead-in) is a small spec and a11y gap. S2 is one test. S3 is a
docs fix. The nits can wait.

**Merge readiness:** ready to merge once S1-S3 are fixed on `agent/m9-nav` (about 20 lines plus tests). Then the maintainer does one
`beehive` deploy and runs the manual browser checklist above.
