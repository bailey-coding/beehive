# M8 PR 2 review: `agent/m8-issues-ui` (U1-U5)

Reviewer: independent agent, 2026-10-17. Subject `git diff origin/main...origin/agent/m8-issues-ui` (head `0626449`, base `60e7292`).
Spec: `docs/M8-UI-ISSUES-PLAN.md` on `origin/agent/ui-issues-plan-v2`, sections 2, 3, 5-8, 10, 15. Line numbers are on `0626449`.
Method: read every changed line; throwaway probe (deleted) through the real `handleUi` + real Spec DO; 17 mutations; typecheck,
unit tests, local e2e. Implementer claims re-checked, not trusted.

## Findings

### Blockers

None.

### Should-fix

- **S1 Wrong method on list/new/detail is 200, not 405.** `ui.ts:561` compares `isPostKind` with `method === 'POST'`, so PUT/DELETE/
  PATCH on `.../issues` or `.../issues/<id>` render the page (probe). Plan section 2: "wrong method -> 405". No write is reachable, so
  not a blocker. Fix: `const allowed = isPostKind ? method === 'POST' : method === 'GET' || method === 'HEAD'; if (!allowed) return
  METHOD_NOT_ALLOWED();` and add PUT/DELETE to the 405 test (`ui-issues.test.ts:174`).
- **S2 Docs overclaim.** `docs/MILESTONES.md:161` says "the 14 defects ... are fixed" and "done", but defect 11 is deliberately left
  open (pinned by `ui-issues.test.ts:305`; the PR's own `OPEN-QUESTIONS.md` entry says so), and the PR is not merged. AGENTS.md: docs
  have drifted from code before. Fix: "13 of 14 fixed; defect 11 pinned for the Q4 follow-up"; "done on merge of PR 2".

### Nits

- N1 `Created issue #${number}` (`ui.ts:639`) reads "Created issue #" if the DO omits `number`; drop the `#` when empty.
- N2 `writeFailure` (`ui.ts:678`) shows DO 403 "X-Actor-ID must name an existing actor" (only if the actor is deleted mid-session).
  That is internal wording; map it to "Your session is out of date; log in again."
- N3 Semantic search still labels issues `getName(i)` (`ui-pages.ts:344`, empty). This is defect 12 in excluded scope; file a follow-up.
- N4 `specPage` would build `/app/repos//issues/<id>` for an issue without `repository_id` (`ui-pages.ts:714`); unreachable today.
- N5 Aliases (`acme/acme/widgets`, UUID form) answer 200 instead of 302 to the canonical URL. Optional.
- N6 `?ok=`/`?error=` show any escaped text, so a crafted link can spoof messages (pre-existing `/app?ok=`); M9 could use message keys.
- N7 Maintainers on a `locked` issue see the form but no "Locked" badge (`ui-pages.ts:1320`); section 15 requires it only for others.
- N8 `docs/FOCUS.md:43` warns of new UI vs old DO, but both ship in the one `beehive` script (`wrangler.toml:15-29`); reword.
- N9 The unit origin loop (`ui-issues.test.ts:327`) covers cross-origin and missing only. Add `null`, subdomain and scheme (probe: all 403).

## Check 1: routing (verified through the real code)

Paths below are under `/app/repos/` unless shown in full. Order in `handleUi`: session + actor (`ui.ts:118-126`) -> `parseRepoIssuesPath` (`ui.ts:138`) -> `repoHierarchicalMatch` (`:146`) ->
`detailMatch` (`:179`) -> POST create forms + `/app/issue_comments` shim (`:217-227`). Ref not resolved -> `handleRepoIssues` returns
null (`ui.ts:559`) and the old routes run. Probe results (GET unless noted):

| URL | Result |
|---|---|
| `acme/widgets/issues` (2-part), `acme/ns/shop/issues` (3-part), `<uuid>/issues/<id>`; `.../issues/%6E%65%77` (= `new`) | 200 |
| `/app/repos/acme/ns/issues` (no repo `ns`, repo `issues` in ns `ns`) | 200 repo page (falls through) |
| `acme/new`, `acme/new/issues`, `acme/new/issues/new`, `acme/ns/issues/issues/<id>` | 200 |
| `/app/repos/acme/issues` (ref `acme` = 1 segment -> repo-id lookup -> DO `Not found` -> fall through; no such repo) | 404 |
| trailing slash on list, `new/`, `<id>/`; `issues//comments`; `<id>/comments/x`; `issuesX`; 4+ segments | 404 (parser null) |
| `acme%2Fwidgets/issues` (encoded slash), `%E0%A4%A` (bad escape), `acme/../issues` | 404 |
| `acme/./widgets/issues`, `acme/%2e/widgets/issues` (URL parser collapses dot segments); `acme/acme/widgets/issues` (alias, N5) | 200 |
| `/app/issues/<id>` (legacy) | 302 to `/app/repos/acme/widgets/issues/<id>` |
| POST on list/new/detail with GET-only kind; GET on `/comments`, `/status` | 405 (`ui.ts:561`) |
| PUT/DELETE/PATCH on `/issues` and `/issues/<id>` | **200, page rendered** (S1); on `/comments`, `/status`: 405 |

Shadowing: `REPO_ISSUES`/`ISSUE_ACTION` need `/issues` after 1-3 segments, so `/app/repos/<id>` and 2-3 part repo pages are unchanged;
the only overlap (repo literally named `issues`/`new`) falls through, tested in `ui-issues.test.ts:143`. The plan's documented
precedence holds: if `acme/ns` and `acme/ns/issues` both resolve, the issue list wins. No overlap with `/app`, `/app/orgs|specs|...`.

## Check 2: security

- **Origin.** `sameOrigin` (`ui.ts:856`) is exact-match on `Origin`, no Referer fallback (fail-closed). New POSTs: one check before any
  repo/issue DO read (`ui.ts:550`); the shim is behind the generic POST check (`ui.ts:219`). Probe: `http://localhost.evil.com`,
  `null`, `http://sub.localhost`, `https://localhost`, `http://LOCALHOST`, missing -> all 403 on create. Only the session's
  `/api/actors` read precedes it (pinned, `ui-issues.test.ts:339`). Non-POST kinds are not origin-checked but cannot write (405).
- **Session / actor.** No session -> `/login` redirect (e2e `ui-issues.test.ts:110`). Writes send `X-Actor-ID: session.actorId`
  (`ui.ts:763-770`). Probe: create with forged `createdBy`, `number`, `repositoryId` form fields -> DO body was exactly
  `{"repositoryId":<URL repo>,"title":"x"}`, header = session actor. Comment body is `{ body }` only (`ui-actor.test.ts`).
- **Escaping.** `flash()` (`ui-html.ts:151`), titles via `subHeader`/`page`, labels, body, comments, `created_by` all go through
  `esc`. Probe: title `a\r\nSet-Cookie: x=1 "<script>` -> Location `...?ok=Created%20issue%20%233` (no header injection), detail page
  has `&lt;script&gt;`, no raw tag. `buildRepoUrl` output is escaped but its components are `[A-Za-z0-9_.-]` or `isValidId`/DO UUIDs,
  so `esc` is a no-op and the value is safe in `Location` and in `subHeader`'s `esc(backHref)`: no double escape reachable.
- **Open redirect.** Every `Location` is built from `ref.repoUrl` + `encodeURIComponent(id)` or the fixed `/app`; `ok`/`error` are
  only rendered as escaped text. None found. (Content spoofing through a crafted `?error=` link is pre-existing; nit N6.)
- **Private issues.** 404 on detail (`ui-pages.ts:1288`), comment/status POST before any write (`ui.ts:582`), legacy GET before any
  redirect, no `Location` (`ui.ts:688`), shim (`ui.ts:704`); hidden in lists. Tested (`ui-issues.test.ts:496`); unit only, since no
  API can set `visibility` (recorded in `OPEN-QUESTIONS.md`).
- **Repo scoping / cross-repo.** Detail 404 when `issue.repository_id !== ref.repo.id` (`ui-pages.ts:1292`); comment/status same
  check before writing (`ui.ts:582`). Cross-org reads are allowed as before (R9: allowlisted users see all orgs); not a regression.
- **GET is read-only.** No DO write is reachable from GET/HEAD/PUT/DELETE/PATCH on the new routes (probe + `writes()` assertions).

## Check 3: Response.ok, mixed version, error text

- Writes: one `doWrite` (`ui.ts:763`), success only on `res.ok && success === true` (`:773`); network error -> status 0. Reads:
  `createDoReader` lists throw on `!success` (`ui.ts:74`); a GET maps only the exact text `Not found` to null (defect 11, pinned).
  Page/POST handlers catch -> 502 with fixed text, DO text to `console.error` (`ui.ts:591-594`).
- Old DO: create on an old DO -> fixed "Could not create issue" (`ui-issues.test.ts:273`); status PATCH catch-all 404 (`Not found`) ->
  "Closing and reopening is not available yet" (`ui.ts:668`), distinct from the new DO's `issue not found`. A 404 on
  `/api/repositories` -> 502, not "Repository not found" (`ui-issues.test.ts:286`). Comment/status DO 400/403/409 text is shown
  (plan section 7); other statuses are generic (`ui.ts:678`, tested `:425`). Create never shows DO text (N1 of the plan review).

## Check 4: spec conformance and scope

Present as specified: `ui-repo-ref.ts` parse/resolve/`validComponent` rejecting `.`/`..`, used by `buildRepoUrl` and the old
hierarchical block (one resolver); issue routes before repo routes; create omits `number` and redirects to
`${repoUrl}/issues/${encodeURIComponent(id)}?ok=...`, failure to `/issues/new?error=`; scoped `issuePage`; private 404 everywhere;
legacy GET 302 / render-in-place read-only; shim derives the repo and redirects to the canonical URL; `flash()` in `ui-html.ts:151`;
links `#<n>: <title>` with `Issue <8 chars>` fallback (`ui-pages.ts:1131`) in `renderIssueRow`, `renderRepoIssues`, `specPage`; comment
form: `open` or maintainer -> form, `locked` -> "Locked", `maintainers_only` -> notice (`ui-pages.ts:1320`); Close/Reopen for creator
or maintainer (`:1307`), closed issues keep the form; defect 10 fixed (`subHeader` escapes once). No navbar/breadcrumb/search, no
DO/schema/CLI/`api/index.ts` change. Unplanned but acceptable (small, on touched lines, tested or trivially safe): `</dd>` typo,
`created_by` in "Created by", the dashboard's sixth repo-URL copy replaced by `buildRepoUrl` (same rule as section 3's S6), extra
`OPEN-QUESTIONS`/`OPS`/`FOCUS` text (accurate apart from S2 and N8).

## Check 5: tests (mutations run in this worktree, each reverted; `git status` clean afterwards)

Tests run against the real Spec DO behind a recording stub that keeps the R1 block; overrides only simulate DO failures. All 17
mutations were caught (failing tests in brackets): remove origin check `:550` [2]; shim origin `:219` [4]; POST private `:582` [1];
POST repo-scope `:582` [2]; page private `ui-pages:1288` [1]; page scope `:1292` [1]; legacy private `:688` [1]; shim private
`:704` [1]; Location encoding `:607` [6]; `success === true` -> `!== false` [1]; fall-through -> 404 [1]; issue routes moved after
the repo routes [18]; `.`/`..` allowed [4]; send `number` [3]; Close/Reopen ungated [1]; locked form ungated [2]; DO text for all
statuses [1]. Not tested: S1 (PUT/DELETE), N9 variants. The `ui.test.ts`/`ui-actor.test.ts` edits update expectations to the new
canonical redirect and `{ body }` payload; none was weakened.

## Check 6: runs (this worktree, 2026-10-17)

`npm install` (root, `cli/`); `npm run typecheck` clean; `npm test` **34 files, 737 passed, 0 failed**. `E2E_UI=1
scripts/start-e2e-workers.sh` (`.dev.vars` copied, gitignored) + `npm run test:e2e:local`: **63 passed, 5 skipped, 0 failed**
(`ui-issues` 7/7); workers stopped, ports 8787-8792 free. Local only. Matches the implementer's numbers.

## Verified correct

Everything in checks 1-5 not listed as S1/S2/N1-N9: routing and fall-through, CSRF, session actor, escaping, redirects, private and
cross-repo 404s, `success === true`, 502 on read errors, old-DO flash, DO numbering (parallel creates distinct), non-empty links.

## Verdict

**Approve with changes.** No blockers. S1 (one line plus a test) and S2 (doc wording) should land before merge; nits can follow.
Merge-readiness: ready to merge after S1 and S2 (the DO PR is already on `main`). The maintainer deploys after merge; nothing
here deploys.
