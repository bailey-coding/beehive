# M8 PR 2 review: `agent/m8-issues-ui` (U1-U5)

Reviewer: independent agent, 2026-10-17. Subject `git diff origin/main...origin/agent/m8-issues-ui` (head `0626449`, base `60e7292`).
Spec: `docs/M8-UI-ISSUES-PLAN.md` on `origin/agent/ui-issues-plan-v2`, sections 2, 3, 5-8, 10, 15. Line numbers are on `0626449`.
Method: read every changed line; ran a throwaway probe (deleted, not committed) through the real `handleUi` + real Spec DO
(`workers/spec-do/tests/sqlite-state.ts`); 17 mutations; typecheck, unit tests, local e2e. Implementer claims re-checked, not trusted.

## Findings

### Blockers

None.

### Should-fix

_(checks 3-6 pending)_

### Nits

_(checks 3-6 pending)_

## Check 1: routing (verified through the real code)

Order in `handleUi`: session + actor (`ui.ts:118-126`) -> `parseRepoIssuesPath` (`ui.ts:138`) -> `repoHierarchicalMatch` (`:146`) ->
`detailMatch` (`:179`) -> POST create forms + `/app/issue_comments` shim (`:217-227`). Ref not resolved -> `handleRepoIssues` returns
null (`ui.ts:559`) and the old routes run. Probe results (GET unless noted):

| URL | Result |
|---|---|
| `/app/repos/acme/widgets/issues` (2-part), `/app/repos/acme/ns/shop/issues` (3-part), `/app/repos/<uuid>/issues/<id>` | 200 |
| `/app/repos/acme/widgets/issues/%6E%65%77` | 200, the new-issue form (decoded `new`) |
| `/app/repos/acme/ns/issues` (no repo `ns`, repo `issues` in ns `ns`) | 200 repo page (falls through) |
| `/app/repos/acme/new`, `/app/repos/acme/new/issues`, `/app/repos/acme/new/issues/new`, `.../ns/issues/issues/<id>` | 200 |
| `/app/repos/acme/issues` (ref `acme` = 1 segment -> repo-id lookup -> DO `Not found` -> fall through; no such repo) | 404 |
| trailing slash on list, `new/`, `<id>/`; `issues//comments`; `<id>/comments/x`; `issuesX`; 4+ segments | 404 (parser null) |
| `acme%2Fwidgets/issues` (encoded slash), `%E0%A4%A` (bad escape), `acme/../issues` | 404 |
| `/app/repos/acme/./widgets/issues`, `acme/%2e/widgets/issues` | 200: the URL parser collapses dot segments before routing; harmless |
| `/app/repos/acme/acme/widgets/issues` (3-part with ns == org) | 200, non-canonical alias (nit N5) |
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
