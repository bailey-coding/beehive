# M9 plan (v2): site navigation for the `/app` UI

Task `m9-plan` | spec: `docs/MILESTONES.md` M9 | v1 planned 2026-10-17 against `origin/main` 8f8f82c; v2 answers
`docs/M9-NAV-PLAN-REVIEW.md` ("approve with changes", branch `origin/agent/m9-review`; see section 10). Plan only: no
implementation code. Line numbers are on 8f8f82c. UI only: `workers/api/` (the `beehive` worker). Not touched: Spec DO, schema, CLI, `ui/`.

## 1. Inventory: how each page renders today

Shell: `page()` `workers/api/ui-html.ts:256` emits one inline `<style>` (`:260-369`) and `<main><h1>Beehive</h1>${body}</main>`
(`:370`). That h1 is the same on every page, so no page has a real h1; titles are `<h2>` in `subHeader()` (`ui-pages.ts:78`). No header
landmark, skip link, brand link or nav. No CSP or other security header exists in `workers/` (grep); only `Content-Type` and
`Cache-Control: no-store` (`ui-html.ts:371`). No JS is shipped. `.navbar` in `workers/api/index.ts:586` belongs to the public
`/about` and `/roadmap` pages (separate document); new CSS uses a `site-` prefix.

| Page | Route (`ui.ts`) | Header | Flash/error | Back link | Other nav |
|---|---|---|---|---|---|
| Dashboard | `/app` `:134`, fn `:358` | own `<header class="bar">`, "Signed in as", `POST /logout` form `:416-419` | reads `ok`/`error` itself `:366-367`, renders `:420-421` (not `flash()`) | none | none; sections have no `id`s `:423,434,451` |
| Org | `:179`; fn `ui-pages.ts:158` | `subHeader(...,'All organizations')` `:223` | none | in `subHeader` | none |
| Repo (UUID, 2-part, 3-part) | `:146-175`, `:179`; fn `:303` | `subHeader` `:364` | none | in `subHeader` | `tabs()` `ui-html.ts:234`, used `ui-pages.ts:380` |
| Spec / Candidate / Trial | `:179`; fns `:600` / `:796` / `:969` | `subHeader` `:721` / `:906` / `:1029` | none | `/app` | none |
| Issue list / new / detail | `:138-142,566-573`; fns `:1168` / `:1224` / `:1271` | `subHeader` `:1192` / `:1228` / `:1334` (legacy no-repo detail: bare `<h1>`) | `flash(url)` `:1194` / `:1230` / `:1336` | bottom links `:1215,1254,1382` | none |
| 404 / 405 / 502 (session) | `ui.ts:149,157,161,167,173,185,191,209,213,229,470`; consts `:524-529`; `:572,580,595`; `ui-pages.ts:165,179,311,325,607,621,803,817,976,987,1280,1289,1293` | none; ad hoc `<p>… <a href="/app">Back to dashboard</a></p>` | none | inline | none |
| 403 cross-origin (session) | `ui.ts:219`, `FORBIDDEN_ORIGIN` `:528` | none | none | none | none |
| Pre-session (503 not configured, `/logout` cross-origin 403, login failed, access denied) | `ui.ts:104,114,256,281,298,306,313` | none | none | `/login` retry | none |

Status codes today: detail routes answer **404** with "Method not allowed" text for non-GET (`ui.ts:149,185`); issue routes answer **405**
(`:529,561`). **M9 keeps every status code and message as is** (no 404->405 change; separate follow-up), so the status tests stay untouched.
Flashes arrive by `back()` `:876` and `flashRedirect()` `:608`. `legacyIssue()` `:694` is a 302. No tournament pages exist in `ui*.ts`.
Search: org/repo/spec/candidate/trial each have an unlabelled `GET ?q=` form over the mock `semanticSearch()` (`ui-pages.ts:244-251,384-391,
771-778,944-951,1058-1065`); `renderSearch` (`ui-semantic.ts:530`) already prints `mockedLabel()` `:563`. Palette: bg `#0d1117`, text `#e6edf3`,
link `#58a6ff`, muted `#8b949e`, panel `#161b22`, border `#30363d`.

## 2. Design

### 2.1 Modules and signatures (new `workers/api/ui-layout.ts`; pure except `loadChrome`)

```
type NavSection = 'repos' | 'specs' | 'issues' | null                      // org pages use null (nothing in the bar is "the org")
interface Crumb { label: string; href?: string }                            // no href = current page (last crumb only)
type NavOrgs = { ok: true; orgs: {id,name}[]; total: number } | { ok: false } | { skipped: true }
interface Chrome { login: string; url: URL; orgs: NavOrgs }                 // an interface: M10 adds user menu / notification count
type ChromeSource = () => Promise<Chrome>                                    // memoised promise, built once per request in handleUi
loadChrome(reader, session, url): Promise<Chrome>                            // never throws; the ONLY place that reads /api/organizations
lightChrome(session, url): Chrome                                            // { skipped: true }, no DO read
interface LayoutOpts { title; heading?; crumbs: Crumb[]; section: NavSection; orgId?; repoUrl?; searchAction?; query?; status?; flash? (default true) }
appPage(chrome: ChromeSource, opts: LayoutOpts, body: string): Promise<Response>
statusPage(chrome: ChromeSource, status: number, heading: string, message: string): Promise<Response>   // 403/404/405/502
renderAccount(chrome): SafeHtml                                              // login + sign-out in one place for M10
```
Trail builders (pure): `dashboardCrumb()`, `orgCrumb(org)`, `repoCrumbs(ref, org?)`, `issuesCrumbs(ref, org?, tail?)`, `specCrumbs`,
`candidateCrumbs`, `trialCrumbs`. `ui-html.ts` changes: export the CSS as `PAGE_CSS`; `flash()` keeps `class="flash ok|err"` and adds
`role="status"`/`role="alert"`; `tabs()` adds `aria-label="Repository sections"` and `aria-current="page"` on the active tab.

**Lazy chrome (review B1).** `handleUi` never calls `loadChrome` eagerly. After the actor check it builds
`chrome: ChromeSource = once(...)` and passes it as a trailing argument to every page function. A page awaits it only inside `appPage`/`statusPage`,
i.e. when it is about to render. The source is **method-aware**: for GET/HEAD it is `once(() => loadChrome(memoReader, session, url))`; for any other
method (POST, PUT, ...) it is `once(async () => lightChrome(...))`. Consequences: the origin check stays before any DO read (`ui.ts:219,550`); create/comment/
status POSTs, the legacy 302 and redirects add no read; a status page for a refused or failed write (including every 403 cross-origin page) renders the
header with a plain "Organizations" link and no read. Page functions that are sync today (`newIssuePage`) and the `NO_REPO_PAGE`-style constants become
async/take the source. Pre-session pages never get a chrome (no session).

What each page passes (`title`->`<title>` and `<h1>`; `orgId`->switcher; `searchAction`->scope): dashboard (`Dashboard`, `[]`, `null`, none, none);
org (name, `[org]`, `null`, org id, org URL); repo (`repos`, org id, `repoUrl`); issue list/new/detail (`issues`, `repoUrl`, search -> repo URL);
spec/candidate/trial (`specs`, spec's org, own URL); `statusPage` (`null`, `[Dashboard, <label>]`). Bodies no longer contain the title,
the back link, `subHeader()` or `flash()`: the layout renders each once.

### 2.2 Markup (document order = focus order)

```
<body><a class="site-skip" href="#main">Skip to content</a>
<header class="site-header"><a class="site-brand" href="/app">Beehive</a>
  <nav aria-label="Primary"><ul> Dashboard | Repositories | Specs | Issues (only when repoUrl) </ul></nav>
  <details class="site-orgs"><summary>Organizations | Org: <name></summary><ul>…links…</ul></details>
  <form role="search" method="GET" action="…"><label class="site-sr" for="site-q">Search (mocked)</label>
    <input id="site-q" type="search" name="q" value="…q…"> <span class="badge mock">Mocked</span></form>
  renderAccount: <span>Signed in as <strong>login</strong></span> <form method="POST" action="/logout"><button class="link">Sign out</button></form></header>
<nav aria-label="Breadcrumb"><ol><li><a>…</a></li>…<li aria-current="page">…</li></ol></nav>
<main id="main" tabindex="-1"><h1>…</h1><div class="site-flash">flash</div>${body}</main></body>
```
- **No JS.** The switcher is `<details>/<summary>` with plain links. No inline handlers and no inline `style=""` in layout markup (a future CSP
  would already need `style-src 'unsafe-inline'` for the existing attributes at `ui-pages.ts:258,531,584,765,895,915-916`; M9 adds none).
- **CSS fixes in L1 (review S1, S2).** (a) `ui-html.ts:330-334` styles every `details`/`summary` for the file tree (`margin-left`, `list-style:none`,
  hidden marker, a folder emoji `::before`). Scope those rules to `details:not(.site-orgs)` and fix `summary[open]::before` (`open` is on `details`:
  use `details[open] > summary::before`), so the switcher keeps a normal disclosure marker and no emoji. (b) `input:focus {outline:none}` (`:278`, specificity 0,1,1)
  beats a global `:focus-visible` (0,1,0): delete `outline: none` there (keep the border colour) and add `:focus-visible { outline: 2px solid #58a6ff; outline-offset: 2px }`.
  Unit test: `PAGE_CSS` contains no `outline: none` and no unscoped `summary::before`.
- **Links.** No global repo/spec/issue index pages exist. "Repositories" -> `/app#repositories`, "Specs" -> `/app#specs` (add `id`s to the dashboard
  sections, plus `scroll-margin-top`). "Issues" appears only inside a repo (`${repoUrl}/issues`); outside a repo it is omitted, not dead.
- **Current page (fixed server-side rule; review S4).** The fragment never reaches the server, so: `aria-current="page"` goes only to "Dashboard" when the path
  is exactly `/app`; anchor items ("Repositories", "Specs") never get `page`; `aria-current="true"` goes to the item matching `opts.section` (a spec page
  marks "Specs", a repo or issue page marks "Repositories"/"Issues"). Org pages pass `section: null`. In the switcher the current org gets `page` on its own
  org page and `true` on other pages inside that org. Style `[aria-current]` with the `#58a6ff` bottom border of `.tabs .active` (`ui-html.ts:291`) plus bold.
- **Org switcher data.** `loadChrome` calls `reader.list('/api/organizations', 500)` (unfiltered, `limit`+`offset=0`; R1/R3). `createDoReader` throws on any DO
  failure including a 404 (`ui.ts:72-78`), so the failure path is explicit: catch, `console.error`, `{ok:false}` -> summary "Organizations unavailable" linking
  to `/app` (never "no organizations"). `{skipped:true}` and no current org -> summary "Organizations". `ok` with 0 orgs -> "No organizations" + "Create one"
  (`/app#organizations`). Many orgs: sort by name (case-insensitive), first 20 (current org first), then "All organizations (N)" -> `/app#organizations`;
  the list scrolls (`max-height`); a `total` of 500 reads "500+" (the DO does not clamp `limit`, `spec-do/index.ts:3130`). Known limitation, pinned by a test:
  `reader.list` maps a success reply with non-array `data` to `[]` (`ui.ts:79`), which shows "No organizations". The switcher navigates only (`/app/orgs/:id`).
  A nav failure never fails the page: its own reads decide 200 vs 502.
- **Cost.** One extra DO read per rendered GET page. `ui.ts` wraps the reader in a request-scoped memoiser that caches the in-flight **promise** (rejections
  too) by path+limit, GET only, so the nav read and a page's own `Promise.all` do not duplicate. Pages that list organizations and benefit: dashboard
  (`ui.ts:360`), `resolveRepoRef` (`ui-repo-ref.ts:136`) and repo, spec, candidate. Org uses `get` and trial lists no orgs: no sharing there.
- **Search: one box per page (review S5).** The navbar input is the only search control. When a page migrates, its in-page "Search" form is deleted and the
  results section stays (`id="search"`, rendered from `?q=` by the existing `semanticSearch`, already labelled Mocked). The navbar input is prefilled with the
  escaped `q`. `searchAction` = the entity URL + `#search` (issue pages: the repo URL), a real `GET ?q=`. Dashboard and status pages (no search results): the input
  is `disabled` with the hint "Open an organization or repository to search". The label "Search (mocked)" is real text, not a placeholder. No backend.
- **Flash.** One area: `flash(url)` first in `<main>`; `ok` -> `role="status"`, `error` -> `role="alert"`. The dashboard's copy and the three `flash(url)` calls
  go in the same commit that migrates their page; tests assert exactly one `class="flash` per response.
- **Landmarks / focus.** `header`, three `nav`s with distinct labels, `main#main`, `role="search"`. The skip link is first and off-screen until `:focus`. The
  layout h1 is the page title; sections stay `h2`; the `<h3>Details</h3>` that follows the title (`ui-pages.ts:226,367,724,909,1032`) becomes `h2` in the step that
  migrates its page (no skipped level).
- **Contrast** (WCAG 2.x, computed; verified by a unit test in L1). Pass: link `#58a6ff`/`#0d1117` 7.49, muted `#8b949e`/`#0d1117` 6.15, `#8b949e`/`#161b22` 5.62.
  Fail today: `#238636` on `#12261a` 3.44 and `#da3633` on `#2d1417` 3.72, used by flash text (`.ok`/`.err`, `ui-html.ts:321-322`) **and** by the status badges
  (`.badge.passed/active/full/promoted/public` and `.failed/train/deprecated/rolled back/private`, `:295-316`; the visibility badge is on every issue page). L1 sets
  flash text to `#e6edf3` (13.5/14.5; border keeps the hue; bold "Error:"/"Done:" lead-in) and changes **two badge text colours**: `#238636`->`#3fb950` (6.27) and
  `#da3633`->`#f85149` (5.12). Borders and backgrounds unchanged.
- **Responsive.** `flex-wrap` header; below 640px the search takes its own row. Not sticky.

### 2.3 Breadcrumb trails (labels are names, wrapped in `<bdi>`; the last crumb has no `href`)

| Page | Trail |
|---|---|
| Dashboard | none (the brand is home) |
| Org | Dashboard › `{org}` |
| Repo | Dashboard › `{org}` › `{repo}` (href from `buildRepoUrl`) |
| Issue list / new | … › `{repo}` › Issues / … › Issues › New |
| Issue detail | … › `{repo}` › Issues › `#12`; legacy render without a repo: Dashboard › `Issue #12` |
| Spec | Dashboard › `{org}` › `{spec}` |
| Candidate | Dashboard › `{org}` › `{spec}` › `Candidate abcd1234` |
| Trial | Dashboard › `{org}` › `{spec}` (from candidate A, else B) › `Trial abcd1234` |
| Status | Dashboard › `Not found` / `Forbidden` / `Error` |
| Tournament | no UI page exists; add a trail with the page |

A missing or tombstoned org/repo/spec row drops its crumb (tombstones leave lists, `spec-do/index.ts:468`); never an invented label or guessed URL. The issue crumb is
the number only (private issues 404 before any crumb: `ui-pages.ts:1288`, `ui.ts:583`).

### 2.4 Escaping rules

1. Text (names, login, issue numbers, flash): truncate to 40 code points (`Array.from`; splitting a ZWJ emoji is accepted), `esc()`, full text in `title`,
   wrapped in `<bdi>` so a U+202E in a name cannot reorder neighbouring text.
2. `href`: fixed path, or `/app/<kind>/${encodeURIComponent(id)}` guarded by `isValidId`, then `esc()`. **`buildRepoUrl()` output is already escaped
   (`ui-repo-ref.ts:30,41`): use it as is, never `esc()` it again.** `Crumb.href` is accepted only if `href === '/app' || /^\/app[/?#]/.test(href)`; anything else
   (`/appx`, `//evil`, `javascript:`) renders as text.
3. `searchAction` follows rule 2; the query is never in the action. `q` goes through `esc()` in the input's `value`.
4. `statusPage` heading/message are code constants; any dynamic piece goes through `esc()` first.
5. Flash text comes from the URL, is escaped (`ui-html.ts:151`), capped at 300 chars; it can still spoof wording (text only, no links).
6. `SafeHtml` is produced only inside `ui-layout.ts`; page bodies stay `string`.

## 3. Migration plan (no big-bang diff)

Add `appPage` beside `page()`; move one page group at a time; delete the legacy path last. **L1 is not "touches no page":** it changes `flash()`/`tabs()` markup,
the shared CSS and two badge colours, so the issue pages (`ui-pages.ts:1194,1230,1336`) and the repo page (`:380`) change output at L1; all existing tests must stay
green **unchanged**, and `page()` itself changes only by importing `PAGE_CSS` until L7. Order: **(1)** L1 layout module + CSS fixes + tests. **(2)** L2 lazy
`ChromeSource`, memoising reader, `loadChrome`/`lightChrome`, passed as a trailing argument but used by no page. **(3)** L3 dashboard and the `handleUi` status
pages (`ui.ts:149-229,470`, 403 pages on light chrome). **(4)** L4 issue pages. **(5)** L5 org and repo. **(6)** L6 spec, candidate, trial. **(7)** L7 cleanup. Until then
unmigrated pages keep the old header. One branch `agent/m9-nav`, serial commits, each pushed; L3-L6 edit `ui.ts`/`ui-pages.ts`, so no parallel agents.

## 4. Mixed-version / deploy notes

UI only, one worker (`beehive`). No Spec DO change, no schema, no new route: the nav reads `GET /api/organizations` (present since M1) through the existing
reader. Cookie, session format, `/logout`, `/app/*` URLs and POST routes are unchanged, so sessions and open forms survive a deploy; rollback needs no cleanup.
The other nine workers are unaffected, so the "one push deploys all ten" window has nothing to tolerate. Agents never deploy (`docs/OPS.md`). Deploy once, after L8.

## 5. Test plan

Vitest only; no DOM library, so string/regex assertions (no new dev dependency).
- **L1, `ui-layout.test.ts`:** skip link first, one `<h1>`, one `<main id="main">`, three labelled navs, `role="search"`, Mocked label, sign-out form, login
  `<script>` escaped; `aria-current` per the section 2.2 rule (`/app`: only Dashboard has `page`; anchor items never); "Issues" only with `repoUrl`; switcher: many
  (20 + "All organizations (N)", current first), none, `{ok:false}` ("unavailable", not "No organizations"), `{skipped:true}`, `"><img onerror>` and U+202E names, long names;
  every trail builder (text, href, last crumb `aria-current`, missing row drops the crumb, invalid id renders text); `Crumb.href` guard (`/appx`, `//evil`, `javascript:`);
  `buildRepoUrl` output not double-escaped; flash roles and cap; `PAGE_CSS` has no `outline: none`, no unscoped `summary::before`; contrast helper >= 4.5 for the new pairs.
- **L2 proofs:** (a) the existing `ui-issues.test.ts:354-362` ("origin is checked before any DO read") passes **unchanged**: a cross-origin comment POST reads only `/api/actors`;
  (b) a new test: a successful `POST /app/organizations` (and a create-issue POST) makes no `GET /api/organizations` and no list read beyond its own write; (c) a GET page makes exactly
  one `/api/organizations` read even when the page also lists organizations (memoised promise); (d) a throwing reader, a DO 404 and a non-array `data` reply: `loadChrome` does not throw,
  the first two give `{ok:false}`, the last is pinned as the known "No organizations" limitation.
- **Per page type (`ui.test.ts`, `ui-issues.test.ts`, stub that blocks filtered lists):** dashboard, org, repo (UUID/2-part/3-part), spec, candidate, trial, issue list/new/detail/legacy,
  and 403/404/405/502: navbar, trail text and hrefs, exactly one flash for `?ok=`/`?error=` (dashboard included), no `subHeader` markup, forms and tabs intact, one search control, h2 not h3
  after the title, status codes unchanged (404 vs 405 as in section 1). Missing org row -> 200 with a shorter trail. Private issue still 404 without leaking its title.
- **Local e2e (local only), new `tests/e2e/ui-nav.test.ts`:** copy the real gate verbatim, `const enabled = await uiConfigured(); describe.skipIf(!isLocal || !enabled)(...)` (production has real GitHub vars, so a
  503 probe alone does not skip; see `tests/e2e/ui-issues.test.ts:30-42`). Forged-cookie pattern as `ui-issues`; own prefix; tombstone + purge cleanup. Follow only fixed links, breadcrumbs, and switcher
  links whose org name carries **this suite's prefix** (other suites' orgs vanish mid-run); for the cap, create 25 prefixed orgs and assert `<= 20` switcher items plus the "All organizations (N)" link,
  never specific names (other orgs exist in the local DB). Also: flash once after a create redirect, sign-out clears the cookie, create org/repo/spec/issue still work.
- **Visual:** no browser tooling in the repo (`package.json`): manual checklist only (360/640/960px wrap, focus ring on links and inputs, `details` open, skip link on focus, `#search` kept by the GET
  form), listed in the PR. Gates: `npm run typecheck`, `npm test`, `npm run test:e2e:local`.

## 6. Risks

1. Extra DO read per rendered GET page: capped list, memoised promise, light chrome for writes, nav failure isolated from the page.
2. Double or lost flash during migration: one-flash assertion; remove the page's own call in the same commit.
3. Heading change (h1 "Beehive" -> page title): no test pins the old strings (grep of `ui*.test.ts`).
4. Dead nav links (no index pages): anchors, contextual Issues, e2e follows own-suite links.
5. The switcher shows all orgs to any allow-listed user: existing behaviour (`ui-pages.ts:259`); crumbs use names the page already shows.
6. Colour changes (flash text, two badge colours) are visible but contrast-only.
7. Native `<details>` does not close on outside click or Esc: acceptable without JS.
8. `ui-pages.ts` (1386 lines) is edited by every page step: serial steps on one branch.
9. `#search` kept on GET submit is spec'd but unverified here: manual check.
10. A future CSP needs `style-src 'unsafe-inline'` (inline `<style>` and existing `style=""` attributes); M9 adds no new inline style.
11. RFC-0008's `/app/settings/tokens` (`origin/agent/m12-rfc`) must render through `appPage`; `Chrome`/`renderAccount` leave room for M10.

## 7. Task list (branch `agent/m9-nav`, serial; tiers per `docs/AGENT-ROUTING.md`)

| # | Task | Files | Tier | Depends | Proof | Human review |
|---|---|---|---|---|---|---|
| L1 | Layout module (`appPage`, `statusPage`, builders, renderers, nav CSS, `PAGE_CSS`, `flash`/`tabs` markup), CSS fixes (S1 details scope, S2 outline, flash text, two badge colours) | `ui-layout.ts` (new), `ui-html.ts`, `tests/ui-layout.test.ts` | Default | none | `ui-layout.test.ts` green; existing suites green unchanged | Yes: shared contract |
| L2 | Lazy method-aware `ChromeSource`, memoising reader, `loadChrome`/`lightChrome`, wired but unused | `ui-layout.ts`, `ui.ts`, tests | Default | L1 | the four L2 proofs in section 5; `ui-issues.test.ts:354-362` unchanged and green | Yes: security-sensitive (origin-before-read) |
| L3 | Dashboard + `handleUi` status pages (incl. `:219` 403 and `:470` 502 on the right chrome), section `id`s, remove its own flash/`header.bar` | `ui.ts`, `tests/ui.test.ts` | Default | L2 | one flash, navbar, anchors; status codes unchanged; POST reads nothing extra | No |
| L4 | Issue list/new/detail + their status pages; drop `flash()` and bottom back links | `ui-pages.ts`, `ui.ts`, `tests/ui-issues.test.ts` | Default | L3 | trail `… › Issues › #12`; one flash; private issue 404 | No |
| L5 | Org and repo pages; delete their in-page search form (results kept), `h3`->`h2`, `tabs` aria | `ui-pages.ts`, `tests/ui.test.ts` | Default | L4 | trails for UUID/2-part/3-part; one search control; missing org -> shorter trail | No |
| L6 | Spec, candidate, trial: same (search form, `h3`->`h2`) | `ui-pages.ts`, `tests/ui.test.ts` | Default | L5 | trails incl. missing spec/org; XSS in names | No |
| L7 | Cleanup: delete `subHeader`; `page()` becomes the pre-session shell (skip link, brand link to `/about`, `<main id=main>`, no navbar, no switcher, no `<h1>Beehive</h1>`); tick M9 ("Issues" is contextual), `FOCUS.md`, `OPS.md` | `ui-html.ts`, `ui-pages.ts`, docs | Light | L6 | grep: no `subHeader`; pre-session pages link brand to `/about`; `npm test` | No |
| L8 | Local e2e `ui-nav.test.ts` (isLocal guard, own-prefix link following, 25-org cap by count) | `tests/e2e/ui-nav.test.ts` | Default | L6 | `npm run test:e2e:local` with `E2E_UI=1` | No |
| L9 | Independent review of the whole diff (a11y, escaping, Response.ok, flash count, read counts) + manual visual checklist | `docs/M9-NAV-CODE-REVIEW.md` | Heavy (review only) | L7, L8 | review doc, findings closed | Yes: merge decision |

None touches the spine. Review items map to tasks: B1 -> L2; S1, S2, S8, N5 -> L1; S3, S4 -> L3; S5 -> L5/L6; S6 -> L7; S7 -> L8.

## 8. Open questions (as asked in v1; answers in section 9)

1 "Issues" in the navbar. 2 Repositories/Specs links. 3 Search box behaviour. 4 Org switcher state and cap. 5 Contrast changes. 6 Sticky header. 7 Pre-session pages. 8 Visual regression tooling. 9 Deploy timing.

## 9. Answers (2026-10-17): defaults chosen by the orchestrating agent, not yet seen by the maintainer; revised after review

The maintainer asked for the plan -> review -> implement -> review pipeline without stopping, so each question takes the cheapest option inside M9's scope. The maintainer can override any before L1 starts.

| Q | Answer |
|---|---|
| 1 | "Issues" is contextual (inside a repo only). No cross-repo index page in M9. |
| 2 | Dashboard anchors; no new `/app/repos` or `/app/specs` index pages. |
| 3 | **One** search box per page: the navbar one, a real `GET ?q=` to the entity's existing mock search, labelled Search (mocked). The in-page search forms are removed; results stay. Disabled labelled placeholder where a page has no results section (dashboard, status pages). |
| 4 | Navigation only, no cookie. Show 20 orgs, then "All organizations (N)" to the dashboard. |
| 5 | Yes, now, in L1: flash text contrast **and** the status-badge text colours (`#238636`->`#3fb950`, `#da3633`->`#f85149`). Nothing left for FOCUS. |
| 6 | No sticky header. |
| 7 | Yes, a minimal pre-session shell in L7: skip link, brand link to `/about` (not `/app`: `/app` redirects a denied user to `/login` and a 503 back to itself), no navbar, no switcher. |
| 8 | Manual visual checklist only. No Playwright (new tooling and CI cost need a maintainer decision). |
| 9 | One PR for L1-L8, deployed once after merge by the maintainer's `cf` push; no intermediate deploys. |

## 10. Review responses (`docs/M9-NAV-PLAN-REVIEW.md`; each finding re-checked against the code first)

| Finding | Verdict | Where / how |
|---|---|---|
| B1 eager `loadChrome` breaks origin-before-read and taxes POSTs | Accepted (verified: check at `ui.ts:219,550`, test `ui-issues.test.ts:354-362`). Refined: the source is also method-aware, so every non-GET render uses light chrome | 2.1, L2, 5 |
| S1 global `details`/`summary` CSS hijacks the switcher | Accepted (`ui-html.ts:330-334`; `summary[open]` never matches) | 2.2, L1 |
| S2 `input:focus {outline:none}` beats `:focus-visible` | Accepted (`:278`, 0,1,1 vs 0,1,0) | 2.2, L1 |
| S3 missing 403 / dashboard-502 pages; 404 vs 405 | Accepted (`ui.ts:219,470,528,149,185`). Refined: cross-origin 403 pages use light chrome (no read); status codes unchanged | 1, 2.1, L3 |
| S4 fragment never reaches the server | Accepted | 2.2 fixed rule, L3 |
| S5 two search forms | Accepted (`ui-pages.ts:244-251` etc., unlabelled) | 2.2, Q3, L5/L6 |
| S6 brand to `/app` loops pre-session | Accepted (`ui.ts:118,104,306`) | Q7, L7 |
| S7 e2e guard and cross-suite links | Accepted (`ui-issues.test.ts:30-42`) | 5, L8 |
| S8 "L1 touches no page" false | Accepted; claim restated | 3, L1 |
| N1 memoise the promise; reuse list | Accepted | 2.2 Cost |
| N2 `buildRepoUrl` double escape | Accepted (verified `ui-repo-ref.ts:30,41`) | 2.4.2 |
| N3 `/appx` guard | Accepted | 2.4.2 |
| N4 bidi `<bdi>` | Accepted; ZWJ split accepted as is | 2.4.1 |
| N5 badge contrast | Accepted (recomputed 3.44 / 3.72 / 6.27 / 5.12) | Q5, L1 |
| N6 inline `style=""` and CSP | Accepted (verified) | 2.2, risk 10 |
| N7 h3 after h1 | Accepted | 2.2, L5/L6 |
| N8 M10/M12 slots | Accepted in part: `renderAccount` and an extensible `Chrome` only; no M10 fields now | 2.1, risk 11 |
| N9 summary text | Accepted ("Organizations") | 2.2 |
| N10 non-array `data` | Accepted; pinned as a known limitation, not fixed (reader contract unchanged) | 2.2, 5 |
| N11 estimates off | Accepted; numbers replaced | 2.2 |

No finding was rejected.
