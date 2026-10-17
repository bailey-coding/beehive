# M9 plan: site navigation for the `/app` UI

Task `m9-plan` | spec: `docs/MILESTONES.md` M9 | planned 2026-10-17 against `origin/main` 8f8f82c. Plan only: no implementation
code. Line numbers are on that commit. UI only: `workers/api/` (the `beehive` worker). Not touched: Spec DO, schema, CLI, `ui/`.

## 1. Inventory: how each page renders today

Shell: `page()` `workers/api/ui-html.ts:256` emits one inline `<style>` (`:260-369`) and `<main><h1>Beehive</h1>${body}</main>`
(`:370`). The h1 is the same on every page, so no page has a real h1; titles are `<h2>` in `subHeader()` (`ui-pages.ts:78`). There is
no header landmark, skip link, brand link or nav. No CSP or other security header is set anywhere in `workers/` (grep), only
`Content-Type` and `Cache-Control: no-store` (`ui-html.ts:371`). No JS is shipped. `.navbar` in `workers/api/index.ts:586` belongs to
the public `/about` and `/roadmap` pages (separate document); new CSS uses a `site-` prefix to avoid the clash.

| Page | Route (`ui.ts`) | Header | Flash/error | Back link | Other nav |
|---|---|---|---|---|---|
| Dashboard | `/app` `:134`, fn `:358` | own `<header class="bar">` + "Signed in as" + `POST /logout` form `:416-419` | reads `ok`/`error` itself `:366-367`, renders `:420-421` (not `flash()`) | none | none; sections have no `id`s `:423,434,451` |
| Org | `/app/orgs/:id` `:179`; fn `ui-pages.ts:158` | `subHeader(name,'/app','All organizations')` `:223` | none (ignores `ok`/`error`) | in `subHeader` | none |
| Repo (UUID, 2-part, 3-part) | `ui.ts:146-175`, `:179`; fn `ui-pages.ts:303` | `subHeader(...,'All repositories')` `:364` | none | in `subHeader` | `tabs()` `ui-html.ts:234`, used `ui-pages.ts:380` (`nav.tabs`, no aria) |
| Spec | `ui.ts:179`; fn `ui-pages.ts:600` | `subHeader` `:721` | none | `'All specs'` -> `/app` | none |
| Candidate | `ui.ts:179`; fn `:796` | `subHeader` `:906` | none | `'All candidates'` -> `/app` | none |
| Trial | `ui.ts:179`; fn `:969` | `subHeader` `:1029` | none | `'All trials'` -> `/app` | none |
| Issue list | `.../issues` `ui.ts:138-142,566`; fn `:1168` | `subHeader` `:1192` | `flash(url)` `:1194` | in `subHeader` + bottom `:1215` | none |
| New issue | `.../issues/new` `:568`; fn `:1224` | `subHeader` `:1228` | `flash(url)` `:1230` | `:1254` bottom | none |
| Issue detail | `.../issues/:id` `:570`; fn `:1271` | `subHeader`, or bare `<h1>` for the legacy no-repo render `:1334` | `flash(url)` `:1336` | `:1382` bottom | none |
| Error/status | `ui.ts:149,157,161,167,173,185,191,209,213,229`, constants `:524-529`, `:572,580,595`; `ui-pages.ts:165,179,311,325,607,621,803,817,976,987,1280,1289,1293` | none; ad hoc `<p>… <a href="/app">Back to dashboard</a></p>` | none | inline link | none |
| Pre-session (not configured, login failed, access denied, forbidden) | `ui.ts:104,114,256,281,298,306,313` | none | none | `/login` retry link | none |

Redirect flows that carry a flash: `back()` `ui.ts:876` -> `/app?ok|error=`; `flashRedirect()` `:608` -> issue pages.
`legacyIssue()` `:694` is a 302 (no page). There are **no tournament pages** in the UI (grep `ui*.ts`): nothing to plan for them.
Search today: each of org/repo/spec/candidate/trial has a "Search" section with a working `GET ?q=` form over the mock
`semanticSearch()` (`ui-pages.ts:245,385,772,945,1059`; `renderSearch` `ui-semantic.ts:530` already prints `mockedLabel()` `:563`).
Colours in use: bg `#0d1117`, text `#e6edf3`, link `#58a6ff`, muted `#8b949e`, panel `#161b22`, border `#30363d`.

## 2. Design

### 2.1 Modules and signatures (new file `workers/api/ui-layout.ts`; pure, no I/O except `loadChrome`)

```
type NavSection = 'dashboard' | 'repos' | 'specs' | 'issues' | null
interface Crumb { label: string; href?: string }        // no href = current page (last crumb only)
type NavOrgs = { ok: true; orgs: {id,name}[]; total: number } | { ok: false }
interface Chrome { login: string; url: URL; orgs: NavOrgs }      // built once per request
loadChrome(reader: DoReader, session: Session, url: URL): Promise<Chrome>     // never throws
interface LayoutOpts { title: string; heading?: string; crumbs: Crumb[]; section: NavSection;
                       orgId?: string; repoUrl?: string; searchAction?: string;
                       status?: number; flash?: boolean /* default true */ }
appPage(chrome: Chrome, opts: LayoutOpts, body: string): Response
statusPage(chrome: Chrome, status: number, heading: string, message: string): Response   // 404/405/502
```

Plus pure trail builders so pages never hand-write crumbs: `dashboardCrumb()`, `orgCrumb(org)`, `repoCrumbs(ref, org?)`,
`issuesCrumbs(ref, org?, tail?)`, `specCrumbs(spec, org?)`, `candidateCrumbs(candidate, spec?, org?)`, `trialCrumbs(trial, spec?, org?)`.
`ui-html.ts` changes (additive): export the CSS as `PAGE_CSS`; `flash()` keeps `class="flash ok|err"` and gains `role="status"` /
`role="alert"`; `tabs()` gains `aria-label="Repository sections"` and `aria-current="page"` on the active tab. `page()` is left alone
until the last task (section 3), so unmigrated pages keep working.

What each page passes (`title` -> `<title>` and `<h1>`; `section` -> highlight; `orgId` -> switcher current org; `searchAction` -> scope):
dashboard (`Dashboard`, `[]`, `dashboard`, none, none); org (name, `[org]`, `dashboard`, org id, org URL); repo (name, `[org, repo]`,
`repos`, org id, `repoUrl`); issue list/new/detail (`section: 'issues'`, `repoUrl` set); spec (`specs`, spec's org, `/app/specs/:id`);
candidate (`specs`, spec's org); trial (`specs`, spec's org); `statusPage` (`null`, crumbs `[Dashboard, <status label>]`).
The page body no longer contains the title, the back link, `subHeader()` or a `flash()` call: the layout renders them once.

### 2.2 Markup (document order = focus order)

```
<body><a class="site-skip" href="#main">Skip to content</a>
<header class="site-header"><a class="site-brand" href="/app">Beehive</a>
  <nav aria-label="Primary"><ul> Dashboard | Repositories | Specs | Issues(only when repoUrl) </ul></nav>
  <details class="site-orgs"><summary>Org: <name></summary><ul>…links…</ul></details>
  <form role="search" method="GET" action="…"><label class="site-sr" for="site-q">Search (mocked)</label>
    <input id="site-q" type="search" name="q"> <span class="badge mock">Mocked</span></form>
  <span>Signed in as <strong>login</strong></span>
  <form method="POST" action="/logout"><button class="link">Sign out</button></form></header>
<nav aria-label="Breadcrumb"><ol><li><a>…</a></li>…<li aria-current="page">…</li></ol></nav>
<main id="main" tabindex="-1"><h1>…</h1><div class="site-flash">flash</div>${body}</main></body>
```

- **No JS at all.** The org switcher is `<details>/<summary>` with plain links; nothing to make CSP-safe. A future CSP only needs
  inline-`<style>` allowance, which the page already depends on. No inline handlers are added.
- **Links.** There are no global repo/spec/issue index pages. "Repositories" -> `/app#repositories`, "Specs" -> `/app#specs`
  (add `id`s to the three dashboard sections, and `scroll-margin-top`). "Issues" is contextual: shown only inside a repo
  (`${repoUrl}/issues`); outside a repo it is omitted, not dead. (Open question 1.)
- **Highlight.** `aria-current="page"` on the item whose href equals the current path (+ anchor); `aria-current="true"` on the
  section that contains the page (a spec page marks "Specs"). Style: `[aria-current]` gets the `#58a6ff` bottom border used by `.tabs .active`
  (`ui-html.ts:291`); never colour alone (also bold).
- **Org switcher data.** `loadChrome` calls `reader.list('/api/organizations', 500)` (unfiltered, `limit`+`offset=0` from the
  shared reader, R1/R3; no query filters). `createDoReader` already throws on any DO failure, including a 404 (`ui.ts:75-78`), so the
  error path is explicit: `loadChrome` catches, logs with `console.error`, returns `{ok:false}`. Rendering: `ok:false` ->
  summary "Organizations unavailable" with a link to `/app` (never "no organizations"); `ok` with 0 orgs -> "No organizations" +
  "Create one" -> `/app#organizations`; many orgs -> sort by name (case-insensitive), show the first 20, then "All organizations (N)" ->
  `/app#organizations`, list scrolls (`max-height`); if `total` hit the 500 limit the label reads "500+". Current org (by
  `opts.orgId`) is first, marked `aria-current="true"`. The switcher only navigates (`/app/orgs/:id`); it stores no state.
  A nav failure never fails the page: the page's own reads decide 200 vs 502.
- **Cost.** One extra DO read per page. A request-scoped memoising `DoReader` wrapper in `ui.ts` (cache by path+limit, GET only,
  dropped with the request) lets pages that already list organizations (repo, spec, candidate, trial) reuse the nav's read.
- **Search box.** No backend. Labelled `Search (mocked)` with `mockedLabel()` beside it. When `searchAction` is set (org, repo,
  spec, candidate, trial, issue pages -> the entity URL + `#search`; issue pages use the repo URL) it is a real `GET ?q=` to the
  existing per-page mock search, whose results already carry the Mocked label; the "Search" sections get `id="search"`. On the
  dashboard and status pages it renders `disabled` with a visible hint "Open an organization or repository to search". Placeholder
  text never replaces the label. (Open question 3.)
- **Flash.** One area: `flash(url)` inside `<div class="site-flash">`, first thing in `<main>`. `ok` -> `role="status"`, `error`
  -> `role="alert"`. The dashboard's hand-rolled copy and the three `flash(url)` calls are removed in the same commit that
  migrates the page; the test asserts exactly one `class="flash` per response.
- **Skip link / landmarks / focus.** `header` (banner), `nav` x3 distinct `aria-label`s, `main#main`, `role="search"`. Skip link
  is first in tab order, off-screen until `:focus`. Add a global `:focus-visible { outline: 2px solid #58a6ff; outline-offset: 2px }`
  (the existing `input:focus {outline:none}` at `ui-html.ts:278` leaves only a border change). Heading outline: layout h1 = page
  title; the sections stay `h2` (today h1 is "Beehive" and titles are h2).
- **Contrast** (WCAG 2.2 AA 4.5:1 text; my estimates, verified by a unit test in task L1): `#58a6ff`/`#0d1117` ~7.9 and `#8b949e`/`#0d1117`
  ~6.2 pass. The existing flash text `.ok #238636` on `#12261a` (~3.3) and `.err #da3633` on `#2d1417` (~3.7) **fail**; M9 sets flash text to `#e6edf3`
  and keeps the coloured border plus a bold "Error:"/"Done:" lead-in, so colour is never the only signal. Badges are untouched (out of scope).
- **Responsive.** `flex-wrap` header; below 640px the search drops to its own row. Not sticky (open question 6).

### 2.3 Breadcrumb trails (labels are names, not ids; the last crumb has no `href` and gets `aria-current="page"`)

| Page | Trail |
|---|---|
| Dashboard | none (brand is home) |
| Org | Dashboard › `{org}` |
| Repo | Dashboard › `{org}` › `{repo}` (href = `buildRepoUrl`) |
| Issue list | … › `{repo}` › Issues |
| New issue | … › `{repo}` › Issues › New |
| Issue detail | … › `{repo}` › Issues › `#12`; legacy render without a repo: Dashboard › `Issue #12` |
| Spec | Dashboard › `{org}` › `{spec}` |
| Candidate | Dashboard › `{org}` › `{spec}` › `Candidate abcd1234` (spec/org crumbs omitted when the row is missing) |
| Trial | Dashboard › `{org}` › `{spec}` (from candidate A, else B) › `Trial abcd1234` |
| Status (404/405/502) | Dashboard › `Not found` / `Error` |
| Tournament | no UI page exists; add a trail with the page |

A missing org/repo/spec row drops that crumb; it never invents a label, never links to a guessed URL, and the page still renders.
Org link: `/app/orgs/${encodeURIComponent(id)}` only if `isValidId`, else text. Issue crumb shows the number only, never the title
(private issues 404 before any crumb is built, `ui.ts:583`, `ui-pages.ts:1288`).

### 2.4 Escaping rules (every dynamic value)

1. Text (names, login, labels, issue numbers, flash): `esc()` after truncating to 40 code points (`Array.from`), full text in `title`.
2. `href`: fixed path, or `/app/<kind>/${encodeURIComponent(id)}` guarded by `isValidId`, or `buildRepoUrl()` (components pass
   `validComponent`), then `esc()`. `Crumb.href` must start with `/app` and not `//`; otherwise it renders as text.
3. `searchAction`: same rule as `href`; the query is never echoed into the action. `q` stays `esc()`d in the existing value attribute.
4. `status`/`heading`/`message` for `statusPage` are code constants; any dynamic piece goes through `esc()` first.
5. The flash text comes from the URL and is escaped (`ui-html.ts:151`); it can still spoof wording (text only, no links). Cap at 300 chars.
6. `SafeHtml` is produced only inside `ui-layout.ts` helpers; page bodies stay `string`.

## 3. Migration plan (no big-bang diff)

Principle: add `appPage` beside `page()`, move one page group at a time, delete the legacy path last. `page()` is not edited until
step 7. Order: **(1)** L1 layout module + CSS + unit tests, used by nothing. **(2)** L2 `loadChrome` + memoising reader, wired
in `handleUi` after the actor check but used by nothing yet. **(3)** dashboard + `handleUi` status pages (highest traffic; its flash and
header are the only ones outside `ui-pages.ts`). **(4)** issue pages (newest code, own flash and `subHeader`). **(5)** org and repo.
**(6)** spec, candidate, trial. **(7)** cleanup: delete `subHeader()`, make `page()` the pre-session shell (brand link, `<main id=main>`,
no `<h1>Beehive</h1>`), docs. Until step 7 the old header can stay on every page not yet moved, and on pre-session pages by design
(they have no session to show). Pages move whole: a page never has both `subHeader` and the layout. One branch `agent/m9-nav`,
serial commits, each pushed (always-pushed invariant); steps 3-6 edit `ui.ts`/`ui-pages.ts`, so no parallel agents there.

## 4. Mixed-version / deploy notes

UI only, one worker (`beehive`). No Spec DO change, no schema, no new route: the nav reads `GET /api/organizations`, present since M1,
through the existing reader. Cookie name, session format, `/logout`, `/app/*` URLs and all POST routes are unchanged, so sessions and
open forms survive a deploy, and a rollback to the previous version needs no cleanup. The other nine workers are unaffected, so the
"one push deploys all ten" window has nothing to tolerate for this change. Agents never deploy (`docs/OPS.md`); the maintainer pushes
to Artifacts after merge. Deploy only after step 6, otherwise users see a half-migrated site.

## 5. Test plan

Vitest only; there is no DOM library, so assertions are on strings/regexes (no new dev dependency).
- **Unit, `ui-layout.test.ts`:** `appPage` (skip link first, one `<h1>`, one `<main id="main">`, three labelled navs, `role="search"`,
  Mocked label, sign-out form, login escaped `<script>`); navbar `aria-current` per `NavSection`, "Issues" only with `repoUrl`;
  switcher: ok/many (20 + "All organizations (N)", current first)/none/`{ok:false}` (text says "unavailable", not "No organizations"),
  org name `"><img onerror>` escaped, long names truncated; each trail builder (text + href + last crumb `aria-current`, missing
  org/spec/repo drops the crumb, invalid id renders text); `Crumb.href` guard (`//evil`, `javascript:` -> text); flash roles and
  300-char cap; `loadChrome` with a throwing reader (also a reader returning DO 404) returns `{ok:false}` and does not throw;
  memoising reader makes one call per path; contrast helper asserts the new pairs >= 4.5.
- **Per page type (`ui.test.ts`, `ui-issues.test.ts`, existing stub that blocks filtered lists):** dashboard, org, repo (UUID, 2-part,
  3-part), spec, candidate, trial, issue list/new/detail/legacy, 404/405/502: each has the navbar, the right trail text and hrefs,
  exactly one flash block for `?ok=`/`?error=` (the dashboard included), no `subHeader` markup, and still has its forms and tabs
  (`tabs` aria). Missing org row on a repo/spec page -> 200 with a shorter trail. Private issue still 404 with no navbar leak of its title.
- **Local e2e (local only, never production), new `tests/e2e/ui-nav.test.ts`**, same forged-cookie pattern as `ui-issues.test.ts`,
  skipped unless `E2E_UI=1`: seed 1 org + repo + spec + issue (and 25 orgs once for the cap); GET every page type, assert the navbar
  and trail; **follow every breadcrumb and navbar href and require 200** (catches dead links); flash after a create redirect shows once;
  sign-out POST still clears the cookie; create org/repo/spec/issue still work. Cleanup by tombstone + purge by prefix.
- **Visual:** the repo has no browser tooling (`package.json` has no Playwright/Puppeteer). Feasible now: the contrast unit test and
  string checks. Anything visual (wrap at 360/640/960px, focus ring, `details` open state, skip link on focus, fragment kept on the
  search GET) is a manual check on `wrangler dev` listed in the PR description. Adding Playwright is a maintainer decision (Q8).
- Gates: `npm run typecheck`, `npm test`, `npm run test:e2e:local`.

## 6. Risks

1. **Extra DO read per page** and a coupling of every page to the org list. Mitigation: cap, memoised reader, nav failure isolated from the page.
2. **Double flash / lost flash** during migration. Mitigation: one-flash assertion per page; remove the page's own call in the same commit.
3. **Heading change** (h1 "Beehive" -> page title) alters accessible names; no test pins the old strings (grep of `ui*.test.ts` found none), but e2e should be re-read.
4. **Dead or misleading nav links**: no index pages exist, hence anchors and a contextual "Issues". Mitigation: e2e follows every link.
5. **Privacy:** the switcher lists all orgs to any allow-listed user (matches the org-page note `ui-pages.ts:259`, existing behaviour). Breadcrumbs use names the page already shows.
6. **Pre-existing contrast failures** on flash text are fixed here; badge colours are not and remain a known gap.
7. **Native `<details>`** does not close on outside click or Esc. Acceptable without JS; stated in the PR.
8. **Merge friction:** `ui-pages.ts` (1386 lines) is edited by every page step; serial steps on one branch.
9. **Search fragment** behaviour on GET forms is spec'd to keep `#search` but is unverified here: manual check.
10. A future CSP would break the inline `<style>`; unchanged by M9, noted in `docs/OPS.md` follow-up only if the maintainer wants it.

## 7. Task list (branch `agent/m9-nav`, serial; tiers per `docs/AGENT-ROUTING.md`)

| # | Task | Files | Tier | Depends | Proof | Human review |
|---|---|---|---|---|---|---|
| L1 | Layout module: `appPage`, `statusPage`, crumb builders, navbar/breadcrumb/switcher renderers, nav CSS, `PAGE_CSS` export, `flash` roles, `tabs` aria, contrast helper | `ui-layout.ts` (new), `ui-html.ts`, `tests/ui-layout.test.ts` | Default | none | `ui-layout.test.ts` green, `npm test` | Yes: the signature is shared by all pages |
| L2 | `loadChrome`, memoising reader, wire after the actor check | `ui-layout.ts`, `ui.ts`, `tests/ui-layout.test.ts` | Default | L1 | throwing/404 reader -> `{ok:false}`; one DO call per path | No |
| L3 | Dashboard + `handleUi` status pages onto the layout; section `id`s; drop its own flash/`header.bar` | `ui.ts`, `tests/ui.test.ts` | Default | L2 | dashboard test: one flash, navbar, anchors; 404/502 have navbar | No |
| L4 | Issue list/new/detail + their status pages | `ui-pages.ts`, `ui.ts`, `tests/ui-issues.test.ts` | Default | L3 | trails `…› Issues › #12`; one flash; private issue still 404 | No |
| L5 | Org and repo pages (`orgCrumb`, `repoCrumbs`, `tabs` aria, search `id`) | `ui-pages.ts`, `tests/ui.test.ts` | Default | L4 | trails for UUID/2-part/3-part; missing org -> shorter trail | No |
| L6 | Spec, candidate, trial pages | `ui-pages.ts`, `tests/ui.test.ts` | Default | L5 | trails incl. missing spec/org; XSS test in names | No |
| L7 | Cleanup: delete `subHeader`, slim `page()` (pre-session shell, no `<h1>Beehive</h1>`), tick M9 in `MILESTONES.md`, `FOCUS.md`, `OPS.md` line | `ui-html.ts`, `ui-pages.ts`, docs | Light | L6 | grep: no `subHeader`; `npm test` | No |
| L8 | Local e2e `ui-nav.test.ts` (link-following, 25-org cap, create flows) | `tests/e2e/ui-nav.test.ts` | Default | L6 | `npm run test:e2e:local` with `E2E_UI=1` | No |
| L9 | Independent review of the whole diff (a11y, escaping, Response.ok, flash count) and the manual visual checklist | `docs/M9-REVIEW.md` | Heavy (review only) | L7, L8 | review doc, findings closed | Yes: merge decision |

None touches the spine; L1 and L9 get a human look because every later page depends on the layout contract.

## 8. Open questions for the maintainer

1. **"Issues" in the navbar:** contextual (inside a repo only) as planned, or a new cross-repo `/app/issues` index page (UI only, same `/api/issues` read, adds scope)?
2. **Repositories/Specs links:** dashboard anchors now, or new index pages `/app/repos`, `/app/specs`?
3. **Search box:** submit to the current entity's existing mock search (planned), or a fully disabled placeholder everywhere until M6.5?
4. **Org switcher:** navigation only (planned) or a remembered "current org" cookie that filters the dashboard? Cap of 20 shown OK?
5. **Flash contrast:** OK to change flash text colour now (small visible change), and leave badge contrast for later?
6. **Sticky header?** Planned: no (simpler, no anchor offset); say if you want it.
7. **Pre-session pages** (login failed, access denied, 503): give them the minimal brand-only shell in L7, or leave as is?
8. **Visual regression:** accept manual checks, or approve adding Playwright (and a CI cost) for screenshots?
9. **Deploy timing:** one PR for L1-L8 and deploy after it, or are intermediate deploys acceptable (users would see mixed headers)?
