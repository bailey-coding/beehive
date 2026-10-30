# Review: `docs/M9-NAV-PLAN.md` (M9 site navigation)

Task `m9-plan-review` | spec: `docs/MILESTONES.md` M9 | reviewed 2026-10-17 on `origin/agent/m9-plan` a1cb5b3 (code = `main` 8f8f82c;
the branch changes only the plan). Independent reviewer; nothing implemented. Line numbers are on that commit. Contrast ratios
computed with the WCAG 2.x relative-luminance formula (script outside the repo).

## Findings

### Blockers

- **B1 L2 wiring breaks the M8 "origin before any DO read" invariant and taxes every POST.** Plan 2.1/3 step (2): `loadChrome`
  is "wired in `handleUi` after the actor check" (`ui.ts:126-131`). It does a DO read (`/api/organizations`), so wired eagerly it runs
  before `handleRepoIssues`' origin check (`ui.ts:550`) and before the POST block's check (`ui.ts:219`). The existing test
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

### Nits

- N1 Memoising reader: cache the in-flight *promise*, not the result; the dashboard's `Promise.all` (`ui.ts:360-364`) races the nav
  read. The reuse list is off: trial does not list orgs (`ui-pages.ts:980-984`), org uses `get` (`:169`); dashboard and the 2/3-part
  `resolveRepoRef` (`ui-repo-ref.ts:136`) do benefit.
- N2 `buildRepoUrl` already returns escaped output (`ui-repo-ref.ts:30,41`); rule 2.4.2 "then `esc()`" double-escapes the UUID
  fallback (its id is not `isValidId`-checked). Say "use as is".
- N3 Crumb guard `startsWith('/app')` accepts `/appx`; use `href === '/app' || /^\/app[/?#]/.test(href)`.
- N4 Bidi controls (U+202E) survive `esc()` and can reorder switcher/crumb text visually; wrap dynamic labels in `<bdi>`.
  Truncating by code points can split ZWJ emoji; acceptable.
- N5 Badge contrast (challenges answer 5): `.badge.passed/active/public/full/promoted` `#238636` on `#12261a` = **3.44**,
  `.failed/private/train` `#da3633` on `#2d1417` = **3.72**, both fail 4.5 (`ui-html.ts:296-321`). `#3fb950` -> 6.27, `#f85149` -> 5.12:
  two colour values in CSS L1 already edits, and the visibility badge is on every issue page. Cheaper than a FOCUS entry.
- N6 Risk 10 understates CSP: inline `style=""` attributes exist (`ui-pages.ts:258,531,584,765,895,915-916`), so a CSP needs
  `style-src 'unsafe-inline'` for attributes too. Layout markup should add none.
- N7 Once the layout owns `<h1>`, `<h3>Details</h3>` right after the title (`ui-pages.ts:226,367,724,909,1032`) skips h2; make it h2
  in the step that migrates the page.
- N8 Leave M10/M12 slots cheaply: render login + sign-out in one `renderAccount(chrome)` and keep `Chrome` an interface M10 can
  extend (user menu, notification count). RFD-0008 (`origin/agent/m12-rfc`) plans `/app/settings/tokens`: it must use `appPage`.
- N9 Switcher summary text when no org is current (dashboard, status pages) is unspecified; use "Organizations".
- N10 `reader.list` maps a success reply with non-array `data` to `[]` (`ui.ts:79`), which the switcher would show as "No
  organizations". Low risk; mention in the L2 test list.
- N11 Plan contrast estimates are slightly off (link 7.49 not ~7.9; ok-flash 3.44 not ~3.3); every pass/fail conclusion holds.

## Verified correct

- Inventory: spot-checked `ui.ts:104,114,134,138-142,146-175,179-215,229,358,366-367,416-423,434,451,524-529,566-572,580,595,608,
  694,876` and `ui-pages.ts:78,158,223,303,364,380,600,721,796,906,969,1029,1168,1192-1194,1224-1230,1271,1288,1334-1336,1382`: accurate
  apart from S3. Only body `<h1>` is the legacy issue render (`:1334`).
- "No CSP": true. grep of `workers/` finds no security headers outside the comparator's header normaliser; `index.ts:86-91` returns
  the `handleUi` response unwrapped; `page()` sets only `Content-Type`/`Cache-Control` (`ui-html.ts:371`). No `<script>` or inline
  handlers. No tournament pages in `ui*.ts`. Cookie `SameSite=Lax` (`ui.ts:857`) already blunts framing of the new sign-out button.
- Sign-out stays `POST /logout` with the same-origin check before the session read (`ui.ts:113-115`).
- R1/R3: rule at `ui.ts:66-70`, `docs/UI-DASHBOARD-PLAN.md:90`, enforced by the stub (`ui-issues.test.ts:27-35`); `loadChrome`'s
  unfiltered `list('/api/organizations', 500)` obeys it. The DO does not clamp `limit` (`spec-do/index.ts:3130`), so "500+" works.
  `list` throws on any DO error incl. 404 (`ui.ts:72-76`), so `{ok:false}` -> "unavailable" is reachable and correct.
- Authorisation: no per-user org scoping exists; every allow-listed login already sees all orgs (`ui.ts:360-364`, note
  `ui-pages.ts:258-260`), so the switcher adds no exposure. Only issues are private: detail 404s before render (`ui-pages.ts:1288`),
  comment/status (`ui.ts:583`), legacy (`:696`); number-only crumbs leak nothing. Tombstoned rows leave lists (`deleted_at IS NULL`,
  `spec-do/index.ts:468`): their crumb drops and `buildRepoUrl` falls back to the UUID URL (`ui-repo-ref.ts:32`).
- Escaping: `esc` covers `& < > " '` (`ui-html.ts:38-46`); the query never reaches `action`; flash text escaped (`:151-157`).
- `mockedLabel` is real text (`ui-html.ts:162-164`), so screen readers announce it; pill `#8b949e`/`#211c13` = 5.51 passes; new flash
  text `#e6edf3` on `#12261a`/`#2d1417` = 13.5/14.5.
- Tests: none pin the old header (`Beehive</h1>`, `subbar`, `Signed in as`: no hits in `ui*.test.ts`); all go through `handleUi`, so
  page-function signature changes stay internal. The E2E_UI dummy-OAuth harness exists (`scripts/start-e2e-workers.sh:24-29,87-89`).
- Conflicts: no `origin/*` branch ahead of `main` touches `workers/api/ui*` or `tests/e2e/ui*`; `agent/m12-rfc` touches only
  `docs/rfds/`. The plan leaves the Spec DO, schema, CLI, session cookie and signing (`ui.ts:318,834`, M12's target) alone.
  Mixed-version: one worker, no new route; tolerable.

## Section 9 answers

Q1, Q2, Q4, Q6, Q8, Q9: agree. Q1: when ticking M9, say "Issues" is contextual (MILESTONES lists an issues link). Q3: change per S5
(one search control per page). Q5: extend to the badge colours (N5). Q7: agree, with the brand linking to `/about` (S6).

## Verdict

**Approve with changes.** Fix B1 in the plan text before L2 starts (lazy chrome, plus the two proofs). S1-S8 fold into the
existing tasks without reordering: S1, S2, S8 and N5 into L1; S3, S4 into L3; S5 into L5/L6; S6 into L7; S7 into L8.
