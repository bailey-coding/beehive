# Review: `docs/M9-NAV-PLAN.md` (M9 site navigation)

Task `m9-plan-review` | spec: `docs/MILESTONES.md` M9 | reviewed 2026-10-17 on `origin/agent/m9-plan` a1cb5b3 (code = `main` 8f8f82c;
the branch changes only the plan). Independent reviewer; nothing implemented. Line numbers are on that commit. Contrast ratios
computed with the WCAG 2.x relative-luminance formula (script outside the repo).

## Findings

### Blockers

- **B1 L2 wiring breaks the M8 "origin before any DO read" invariant and taxes every POST.** Plan 2.1/3 step (2): `loadChrome`
  is "wired in `handleUi` after the actor check" (`ui.ts:126-131`). It does a DO read (`/api/organizations`), so wired eagerly it runs
  before `handleRepoIssues`' origin check (`ui.ts:551`) and before the POST block's check (`ui.ts:219`). The existing test
  `workers/api/tests/ui-issues.test.ts:354-362` asserts that a cross-origin comment POST reads only `/api/actors`: L2 goes red, so
  "each step green" is false, and the fix-by-loosening-the-test path would weaken a reviewed security property. It also adds a read
  to every create/comment/status POST, the legacy 302 (`ui.ts:694-701`) and `/logout`-less fall-throughs, none of which render.
  **Change:** make chrome lazy: `handleUi` builds `getChrome = once(() => loadChrome(reader, session, url))` (memoised *promise*) and
  passes it down; only `appPage`/`statusPage` callers await it. Add to L2's proof: cross-origin POST still reads only `/api/actors`
  (existing test unchanged) and a successful `POST /app/organizations` makes no `/api/organizations` read.

### Should-fix

- **S1 Global file-tree CSS hijacks the org switcher.** `ui-html.ts:313-318` styles *every* `details`/`summary`: `margin-left:16px`,
  `list-style:none`, hidden WebKit marker, and `summary::before { content:'📁 ' }`. The planned `<details class="site-orgs"><summary>`
  would render with a folder emoji (announced by screen readers as "file folder"), no disclosure triangle, and an indent. **Change:**
  in L1 scope those rules to the file tree (`.file-tree details`, or `details:not(.site-orgs)`), and add a unit assertion that the
  switcher's summary has no `::before` content rule applying (string check on `PAGE_CSS`). Also the existing `summary[open]::before`
  never matches (`open` is on `details`); fix in passing.
- **S2 The focus ring claim does not hold for inputs.** Plan 2.2 adds global `:focus-visible { outline: 2px solid #58a6ff }` because
  `input:focus, select:focus, textarea:focus { outline: none }` (`ui-html.ts:278`). `input:focus` (specificity 0,1,1) beats
  `:focus-visible` (0,1,0), so form controls, including the new navbar search, keep `outline:none`. **Change:** delete `outline:none`
  from `:278` (keep the border colour) or write `input:focus-visible, select:focus-visible, textarea:focus-visible`; L1 test asserts
  `PAGE_CSS` has no `outline: none` left.
- **S3 Inventory misses session-scoped status pages.** Not in the table: `ui.ts:219` (403 cross-origin POST, *with* a session, so it
  is not "pre-session"), `ui.ts:470` (dashboard 502), `ui.ts:528` 403 `FORBIDDEN_ORIGIN` (in the constants range but not in the
  `statusPage` "404/405/502" list). Also `ui.ts:149,185` answer **404** with "Method not allowed" text while issue routes answer 405
  (`ui.ts:529,561`). **Change:** `statusPage` covers 403 too; list `:219` and `:470` under L3; state that M9 keeps every status code
  as is (no 404->405 change on detail routes; a separate follow-up), so the status tests stay untouched.
- **S4 `aria-current="page"` "href equals the current path (+ anchor)" is not computable.** The server never sees the fragment:
  on `/app`, "Dashboard" (`/app`), "Repositories" (`/app#repositories`) and "Specs" (`/app#specs`) all match the path. **Change:**
  fixed rule: only "Dashboard" gets `page` on `/app`; anchor items never get `page`; `aria-current="true"` per `section`. Org pages:
  `section: null` (not `dashboard`: nothing in the bar is the org page); the current org in the switcher gets `page` on its own
  org page, `true` elsewhere.
- **S5 Two search forms per page (answer 9 / Q3).** Org/repo/spec/candidate/trial already have a "Search" section with its own
  unlabelled `GET ?q=` input (`ui-pages.ts:244-251,384-391,771-778,944-951,1058-1065`; placeholder only, no `<label>`). Adding the
  navbar box submitting to the same URL gives two `name="q"` controls doing one thing, one of them unlabelled. **Change:** when a
  page migrates, drop the in-page form and keep the results section (`id="search"`) rendered from `?q=`; the navbar input is
  prefilled with the escaped `q` on that page. Pages without results keep the disabled placeholder.
- **S6 Pre-session shell brand link (answer Q7).** "Brand link" on pre-session pages pointing to `/app` loops: `/app` -> `/login`
  -> GitHub for a denied user (`ui.ts:306`), and back to the 503 when not configured (`ui.ts:104`). **Change:** pre-session shell
  brand -> `/about` (public, `index.ts:81`); no navbar, no switcher (no session to read with).
- **S7 Local e2e guard and flakes.** The plan says "skipped unless `E2E_UI=1`", but the real gate is `isLocal && uiConfigured()`
  (`tests/e2e/ui-issues.test.ts:30-42`); production has real GitHub vars, so a 503 probe alone would *not* skip there. Following
  "every navbar href" also follows switcher links to orgs owned by other suites (`ui-issues` creates/purges its own prefix,
  `:98-103`), which vanish mid-run: flaky 404s. **Change:** copy `describe.skipIf(!isLocal || !enabled)` verbatim; follow only fixed
  links, crumbs and switcher links whose org name has this suite's prefix; for the cap assert `<= 20` items and the
  "All organizations (N)" link, not specific names (other orgs exist in the local DO).
- **S8 "L1 touches no page" is not true.** L1 edits `flash()` (roles), `tabs()` (aria), the flash colours and extracts `PAGE_CSS` from
  `page()`; issue pages (`ui-pages.ts:1194,1230,1336`) and the repo page (`:380`) change output at L1, and plan section 3 says `page()`
  is untouched until L7. Harmless but the claim is what reviewers will check. **Change:** reword to "L1 changes only `flash`/`tabs`
  markup and shared CSS; existing tests must stay green unchanged"; keep the contrast helper in the test file, not shipped code.
