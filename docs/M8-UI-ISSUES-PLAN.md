# M8 plan: make the repo issue pages reachable and correct

Task `ui-issues-plan` | spec: `docs/MILESTONES.md` M8 | planned 2026-10-17 against `origin/main` 11d0816.
Plan only: no implementation code. Review being answered: `docs/OPEN-QUESTIONS.md` "Review of 39a2669".

## 1. Defects re-verified against current code

Method: read the code, then ran the real `handleUi` against a fake Spec DO stub (scratch vitest, not
committed; the review's harness redirected to `/login`, mine forges a session with `signSession` and answers
`/api/actors`). Typecheck is clean on main. Baseline `npm test` in a fresh worktree: 583 passed, 15 failed, all in
`tests/cli-behavior.test.ts`, which spawns `cli/node_modules/.bin/tsx` (`:22`); that directory only exists after
`npm install` in `cli/` (not run here), so I read these as an environment gap, not a regression. Install `cli/` deps before judging T1-T5.

| # | Review claim | Verdict on main | Evidence |
|---|---|---|---|
| 1 | Issue routes unreachable | **True for GET, overstated overall.** All three GET pages 404. But two paths do work: `POST /app/repos/{org}/{ns}/{repo}/issues` (4 segments, skips the 3-segment regex) reaches `createIssue`, and `GET /app/issues/:id` renders any issue via the global `detailMatch` (`ui.ts:345`). 2-part POST answers 404 "Method not allowed" | `/app/repos/acme/ns/shop/issues` and `/issues/new`, `/issues/i1`: 404 "This page does not exist". `/app/repos/acme/widgets/issues`: 404 "Repository not found" (repo read as `issues`). `/app/repos/r1/issues` (UUID form): 404 "Organization not found". POST 3-part: 302 |
| 2 | Comments post to missing `/api/issue_comments` | **Fixed in 3790070.** `createIssueComment` (`ui.ts:789`) posts to `/api/issues/:id/comments`, which the DO serves (`spec-do/index.ts:3514`). Still wrong: success does `back('ok')` which lands on the dashboard `/app`, not the issue; the form action `/app/issue_comments` has no repo in the URL; issue existence, status and `comment_policy` are never checked (the DO checks none of them either); `result.success === false` treats a missing `success` as OK | `ui.ts:797-810`, `ui-pages.ts:1396` |
| 3 | Numbers max+1, not atomic, filtered call, "every issue numbered 1" | **Partly wrong.** Non-atomic: true. The bind-order bug is fixed in the DO source and tested (`tests/unit/spec-do-list-bind-order.test.ts:134` covers `listIssues` with `repositoryId`), so numbers are not all 1 *if that fix is deployed* (unverifiable here; Q3). The 500-row cap only bites past 500 issues in one repo. Real extra problems: the filtered call is hard-blocked by `ui.test.ts`'s stub (throws `BLOCKED ... (R1)`), so the function cannot even be unit-tested as written; `createIssue` calls `callDo` directly and does `(orgs.data as Row[]).find`, so a DO error is a TypeError (no try/catch on POST routes); `issues.number` is `NOT NULL` with no unique index; the CLI also supplies numbers (`tests/cli-behavior.test.ts:129`, `--number 7`), so duplicates may already exist | `ui.ts:760-767`; `schema.sql:196` |
| 4 | Redirect unencoded | **True.** Probe: `Location: .../issues?ok=Created issue #2`. The target page 404s today anyway, and `repoIssuesPage` renders `ok` but no page renders `error` | `ui.ts:783` |
| 5 | `issuePage` ignores repo | **True.** `issuePage(issueId, ...)` takes no repo; `/app/issues/i2` renders issue of repo r2 and the repo-URL block resolves a repo then discards it | `ui.ts:327`, `ui-pages.ts:1313` |
| 6 | Resolution copied four times | **Five.** The original `repoHierarchicalMatch` block (`ui.ts:135-176`), three issue routes (`189-222`, `239-272`, `289-325`) and `createIssue` (`713-756`). `createIssue` re-fetches orgs/repos unchecked | |

Additional defects found:
- (7) `renderIssueRow` (`ui-pages.ts:1167`) links `/app/repos/<repo UUID>/issues/<id>`; `renderRepoIssues` and `specPage` link `/app/issues/<id>`. Two URL shapes for one issue.
- (8) Every POST error/success goes through `back()` to `/app` (dashboard), losing the user's form.
- (9) Issue id validated with `validComponent` (allows dots) in `ui.ts:302` but `isValidId` in `issuePage`.
- (10) `subHeader(\`Issues for ${esc(name)}\`)` escapes twice (`esc` is not idempotent): names with `&` render as `&amp;amp;`. Verify, then fix with the helper work.
- (11) `doReader.get` maps `error === 'Not found'` to `null`, but the DO's catch-all unknown-route 404 returns the identical `{error:'Not found'}` (`spec-do/index.ts:3743`). A missing DO route therefore looks like a missing entity: the AGENTS.md hazard. Not changed here (Q4); the e2e step pins the routes instead.

## 2. Routing: order, regexes, examples

All matching happens in `handleUi` after the session and actor checks, **before** `repoHierarchicalMatch`, GET and POST in one table.
Parsing lives in a new pure module `workers/api/ui-repo-ref.ts` (section 3) so it is unit-testable.

```
REPO_ISSUES  = /^\/app\/repos\/([^/]+(?:\/[^/]+){0,2})\/issues(?:\/([^/]+))?$/
ISSUE_COMMENT= /^\/app\/repos\/([^/]+(?:\/[^/]+){0,2})\/issues\/([^/]+)\/comments$/
```
Capture 1 is the repo ref (1-3 segments, split on `/`, each `decodeURIComponent`ed in try/catch, then validated);
capture 2 is `undefined` (list), `new` (form) or an issue id. Evaluation order in `handleUi`:
1. `ISSUE_COMMENT` (POST only) 2. `REPO_ISSUES` (GET list/new/detail; POST create only when capture 2 is undefined)
3. existing `repoHierarchicalMatch` block 4. existing `detailMatch` 5. existing POST create forms (the old `issueCreateMatch` and
`/app/issue_comments` branches go away or become the compat shim in section 7).

| URL | ref (segments) | tail | meaning |
|---|---|---|---|
| `/app/repos/acme/ns/shop/issues` | `acme/ns/shop` (3) | none | issue list (3-part) |
| `/app/repos/acme/ns/shop/issues/new` | `acme/ns/shop` | `new` | new-issue form |
| `/app/repos/acme/ns/shop/issues/9f2c1d` | `acme/ns/shop` | id | issue detail |
| `/app/repos/acme/widgets/issues` | `acme/widgets` (2, namespace == org) | none | list (2-part) |
| `/app/repos/acme/widgets/issues/9f2c1d/comments` | `acme/widgets` | id + comments | POST comment |
| `/app/repos/<repo uuid>/issues` | `<uuid>` (1) | none | list (UUID fallback, used when `buildRepoUrl` falls back) |
| `/app/repos/<uuid>/issues/new`, `.../issues/<id>` | `<uuid>` | `new` / id | form / detail |

The greedy `{0,2}` backtracks: `/app/repos/acme/widgets/issues` gives ref `acme/widgets`, not `acme/widgets/issues`.

**Fall-through rule (important):** if `REPO_ISSUES` matches but the ref does not resolve to a repo, do **not** 404; continue to the
old blocks. That keeps repos that are literally named `issues` or `new` working: `/app/repos/acme/ns/issues` parses first as
"issues of repo `ns` in org acme"; if no such repo exists it falls to `repoHierarchicalMatch`, which resolves repo `issues` in
namespace `ns`. Residual ambiguity (documented, tested): where *both* readings resolve, the issue-list reading wins.
Only after the ref resolved do we 404 (invalid issue id, issue not in repo, unsupported method -> 405 text with 404 status like today).

## 3. One shared repo-resolution helper

New `workers/api/ui-repo-ref.ts` (imported by `ui.ts`; reachable from the edge router):
- `parseRepoIssuesPath(path, method)` -> `{ kind: 'list'|'new'|'detail'|'comment'|'create', refSegments, issueId? } | null`. Pure.
- `resolveRepoRef(reader: DoReader, segments): Promise<{ repo, org, repoUrl } | null>`: 1 segment = repo id (must pass `isValidId`,
  looked up with `reader.get('/api/repositories/:id')`, then its org via the list); 2 = org/repo with `namespace === org`;
  3 = org/ns/repo. Matching copies the existing predicate (`namespace || 'default'`, `organization_id`/`organizationId`).
  Uses unfiltered `reader.list('/api/organizations')` and `/api/repositories` (R1) and **throws** on any DO error (the caller maps to 502).
- `repoUrl` comes from the existing `buildRepoUrl` (exported from `ui-pages.ts:151`), so links stay canonical.
- The old `repoHierarchicalMatch` block is rewritten to call the same helper (delete four of the five copies; keep the `validComponent` regex in one place).
- POST handlers switch from raw `callDo` reads to the same `createDoReader`, so they inherit its error handling.

## 4. Issue numbers: atomic, Spec DO side, no migration

**Change (Spec DO, `spec-do/index.ts:1450` `createIssue` and the POST at `:3448`):** make `number` optional.
- Absent: inside `createIssue`, `SELECT COALESCE(MAX(number), 0) + 1 FROM issues WHERE repository_id = ?` then the `INSERT`, with no `await`
  between them. DO code runs one event at a time and the sql adapter is synchronous, so two concurrent creates cannot interleave: this is atomic.
  Count tombstoned rows too (no `liveFilter`) so a deleted issue's number is never reused.
- Present (CLI, old UI): accept it if `(repository_id, number)` is unused, else throw `ConflictError` (the existing catch maps it to **409**,
  `index.ts:3751`). Non-positive or non-integer -> `BadRequestError`... which the catch maps to 500 today, so use `ConflictError`-style 409/400 handling
  explicitly or validate in the route and return 400 (decide in T1; add a test either way).
- **No schema change, no `LATEST_SCHEMA_VERSION` bump** (`index.ts:27`). This is deliberate: a bump to m9 would make an *old* DO throw
  `Unknown schema_version 'm9'` (`index.ts:836`) on a rolled-back or lagging instance, which breaks every worker. A unique index on
  `(repository_id, number)` would also fail to create if duplicates already exist (CLI-supplied numbers). Deferred: Q2.
- `workers/api/types.ts:542` `CreateIssueRequest.number` becomes optional; `IssueResponse` unchanged.

**Mixed-version matrix** (one push deploys all ten workers in no order; the UI and DO ship in the same `beehive` script, but a DO instance
can briefly run old code behind a new worker, and the CLI is released separately):

| UI | DO | Behaviour |
|---|---|---|
| old (sends `number` = max+1) | old | Today. Dup numbers possible. |
| old | new | `number` honoured if free; on a race the DO answers 409 and the UI shows "Failed to create issue" (was: silent duplicate). Old UI create form is unreachable anyway. |
| new (omits `number`) | old | Old DO inserts `NULL` -> `NOT NULL` failure -> DO returns 500 JSON; `callDo` gives `success:false`; UI redirects to the form with an encoded error. No row written, no corruption; retry works once the DO is new. Accepted for a minutes-long window (Q1 offers a hint-number alternative). |
| new | new | DO assigns; atomic. |
| old CLI (`--number`) | new DO | Works (honoured or 409). |
| new CLI (optional `--number`) | old DO | Fails like the UI row above. Therefore the CLI change ships in a later push than T1. |

## 5. Response.ok on every DO fetch

- Reads: only through `createDoReader` (`ui.ts:48`). Lists throw on any `!success`; page handlers keep the existing try/catch -> 502
  "could not load this page". Never `?? []` on a failed call.
- Writes: one local helper `doWrite(stub, path, method, body, actorId)` that returns `{ ok: true, data } | { ok: false, error }` and treats
  anything but `success === true` as failure (replaces the `=== false` checks at `ui.ts:776, 806`). It relies on `callDo`'s existing
  `!res.ok` handling (`ui.ts:845`).
- POST routes get their own try/catch -> redirect to the originating form with `error=` (today an exception becomes a Workers 1101).
- Test: a stub that answers 404/500 for `/api/repositories` must give 502, never an empty list or "Repository not found" 404.

## 6. Redirect encoding, scoping, flashes

- Create success: `redirect(\`${repoUrl}/issues/${issue.id}?ok=${encodeURIComponent(\`Created issue #${issue.number}\`)}\`)`; use the number
  the DO **returned**, never a locally computed one. Failure: redirect to `${repoUrl}/issues/new?error=${encodeURIComponent(msg)}`.
  Title kept? No: keep it simple, no echo (Q5).
- Add `flash(url)` in `ui-pages.ts` (renders escaped `ok`/`error`) and call it from the list, new, and detail pages (today only the list renders `ok`).
- Scoping: `issuePage(issueId, repoId | null, ...)`. With a repo URL, `issue.repository_id !== repo.id` -> 404 "Issue not found in this repository". The pages
  take the resolved repo to avoid refetching it. `GET /app/issues/:id` stays (legacy links from the repo tab and spec page), unscoped, and
  links back to the canonical repo URL. Switch `renderIssueRow`, `renderRepoIssues`, `specPage` links to the canonical `repoUrl/issues/:id`.
- Issue ids validated with `isValidId` only (defect 9).
- Private issues: list hides them; detail currently shows them. Not changed here (Q6).

## 7. Comment flow

`POST {repoUrl}/issues/{id}/comments` (new form action in `issuePage`): `sameOrigin` -> resolve repo -> `reader.get` the issue -> scoped check -> require
`status === 'open'` and `comment_policy === 'open'` (UI-side only; DO enforcement is a spine change, Q7) -> trimmed non-empty body with a length cap
-> `doWrite POST /api/issues/:id/comments` with `{ body, createdBy: session.actorId }` -> redirect to `${issueUrl}?ok=Comment%20added#comments`.
Errors redirect to the issue page with `error=`. Keep `POST /app/issue_comments` one release as a shim for forms already rendered in open tabs:
read `issueId`, fetch the issue, derive its repo, run the same function, redirect to the canonical issue URL; then delete it.

## 8. Test plan

Unit (existing layout: `workers/api/tests/*.test.ts`, `workers/spec-do/tests/*.test.ts`, `tests/unit/*.test.ts`; `npm test` = CI):
- `workers/api/tests/ui-repo-ref.test.ts`: every table row in section 2 plus `acme/ns/issues`, repo named `new`, encoded `%2e`, bad escapes (`%E0%A4%A`), 4+ segments, `..`.
- `workers/api/tests/ui-issues.test.ts` (new; own small stub that records calls and keeps the R1 "no filtered params" block, since the stub in `ui.test.ts` is not exported):
  GET list/new/detail in 2-part, 3-part, UUID forms -> 200; detail of an issue from another repo -> 404; fall-through for a repo named `issues`;
  POST create -> one `POST /api/issues` with no `number`, no filtered list call, `Location` decodes to the message and a `#` in title survives; DO 500 on create -> redirect with
  encoded error; DO 404 on `/api/repositories` -> 502; POST comment -> hits `/api/issues/:id/comments`, redirect to issue page; closed/locked issue -> refused; cross-origin POST -> 403.
- `workers/spec-do/tests/issue-numbers.test.ts` (harness like `tests/unit/spec-do-list-bind-order.test.ts:1`, real SQL): 1,2,3 per repo, separate counters per repo,
  numbering continues past a tombstoned issue, `Promise.all` of 20 `fetch` creates gives 20 distinct numbers, explicit free number honoured, explicit duplicate -> 409, invalid -> 4xx.
- Update `tests/cli-behavior.test.ts` only if the CLI body changes (it does not in this plan).

Local e2e (never production; `docs/SETUP.md` section 1): `npm run typecheck && npm test`, then `scripts/start-e2e-workers.sh`. The UI answers 503 without
`GITHUB_CLIENT_ID/SECRET`, which the script does not pass (T5 adds an opt-in dummy pair for the `beehive` worker only; OAuth is never exercised).
New `tests/e2e/ui-issues.test.ts`: create actor/org/repo through the bearer API, forge the session cookie (HMAC of `API_AUTH_TOKEN`, same as `signSession`),
send `Origin` on POSTs; then walk list -> new -> create (follow redirect, assert `#1`) -> create again (`#2`) -> two parallel creates (distinct numbers) -> comment ->
detail under another repo's URL is 404 -> 2-part and 3-part and UUID URLs all 200. Cleanup with the tombstone + purge route (`docs/OPS.md`); use unique names per run.
`scripts/stop-e2e-workers.sh` afterwards. Record the pass count in `docs/SETUP.md` "Local e2e status".

## 9. Risks

1. **Spine:** the DO change is in the ledger (AGENTS.md rule 2): a human reviews T1. It is small and additive.
2. **Route shadowing:** the issue-first order changes what `/app/repos/a/b/issues` means; mitigated by fall-through and tests, but a 2-part repo called `issues` in a namespace equal to an existing 2-part repo name resolves to the issue list.
3. **Schema bump trap:** never bump `LATEST_SCHEMA_VERSION` for this; see section 4.
4. **Mixed window:** the "new UI, old DO" create error is user-visible for minutes. Acceptable; the alternative sends a number hint (Q1).
5. **`buildRepoUrl` returns HTML-escaped strings** that we now put in a `Location` header. Safe only because components are limited to `[A-Za-z0-9_.-]`; keep the validation in one place.
6. **Duplicates already in the ledger:** unknown; do not add the unique index before an audit (Q2). Display must tolerate two issues with the same number.
7. **`ui.ts` conflicts:** M8 CLI branches do not touch it, but the navbar task will. Land T3 before navbar work.
8. **`doReader.get` null-on-"Not found"** can mask a missing DO route (defect 11); the e2e step is the guard.
9. **Double escaping** (defect 10) may be wider than the issue pages; fix only the lines we touch, note the rest.

## 10. Tasks (tiers per `docs/AGENT-ROUTING.md`)

Each task: own branch from `main`/previous merge (`--new-branch`), commit message `step: ... | task: <id> | spec: ... | confidence: ..`, push at the end.

| Id | Task | Files | Tier |
|---|---|---|---|
| T1 | DO: optional `number`, atomic assignment, 409 on duplicate, types, `issue-numbers.test.ts`. **Human review (spine).** Deployable alone | `spec-do/index.ts`, `api/types.ts`, `spec-do/tests/issue-numbers.test.ts` | default |
| T2 | `ui-repo-ref.ts`: parse + resolve + `ui-repo-ref.test.ts` (parallel with T1) | new files | default |
| T3 | `ui.ts` routing table, delete the copied blocks, `doWrite`, rewrite `createIssue`/`createIssueComment` + comment route + compat shim, redirect encoding. Depends on T2 (T1 not required to merge, but to see numbers assigned) | `ui.ts` | default |
| T4 | `ui-pages.ts`: scoped `issuePage`, `flash`, canonical links, comment form action; `ui-issues.test.ts` (write alongside T3, same branch is fine) | `ui-pages.ts`, tests | default |
| T5 | Opt-in dummy GitHub vars in `start-e2e-workers.sh`; `tests/e2e/ui-issues.test.ts`; local run, record result | `scripts/`, `tests/e2e/` | default |
| T6 | Docs: correct the 39a2669 review in `OPEN-QUESTIONS.md` (reachable POST/legacy GET, comments fixed, numbers not all 1, five copies, defects 7-11), tick M8, `SETUP.md` e2e count, `FEATURE-PARITY.md` | docs | light |
| T7 | Final read-through of the merged diff against sections 2, 4, 5 (heavy only if T1 review turns up concerns) | n/a | default |

Order: T1 and T2 in parallel (separate worktrees) -> T3+T4 -> T5 -> T6 -> T7. Maintainer pushes to the Artifacts repo only after T1-T4 are on `main`; nothing here deploys.
New CLI behaviour (optional `--number`) is a later M8 CLI task, after T1 is live.

## 11. Shared touchpoints for the later navbar task (not part of this work)

- `page()` in `ui-html.ts:244` (CSS and document shell; the navbar goes here or wraps `body`).
- `subHeader()` in `ui-pages.ts:77` and the dashboard `<header class="bar">` in `ui.ts` (both currently draw their own top bars).
- The new `flash()` helper (T4): the navbar should reuse it rather than add a second `ok`/`error` renderer.
- `resolveRepoRef` gives the navbar the current org/repo for breadcrumbs without another lookup.
- Run navbar edits after T3/T4 land to avoid conflicts in `ui.ts` and `ui-pages.ts`.

## 12. Open questions for the maintainer

1. Accept a brief "new UI, old DO" create failure, or send a best-effort `number` hint (max+1 from the unfiltered list) that the new DO ignores? (Plan assumes the failure.)
2. Is the unique index on `(repository_id, number)` wanted? It needs a duplicate audit of the production ledger first, and a schema bump has the old-DO trap in risk 3.
3. Is the `listIssues` bind-order fix (`do-bind-order`) deployed to production? Only matters for judging whether existing numbers are all 1.
4. Should the DO give entity 404s a distinct error (e.g. `Issue not found`) so a missing route is not mistaken for a missing entity (defect 11)? Touches every entity GET and `doReader`.
5. After a failed create, should the new-issue form keep the title/body? (Needs a short-lived echo; skipped in the plan.)
6. Should issue detail enforce `visibility` like the list does (private issues)?
7. Should the DO itself reject comments on closed issues or when `comment_policy` is `locked`/`maintainers_only`? (Spine; the plan only enforces it in the UI.)
8. Keep `GET /app/issues/:id` as a permanent route, or redirect it to the canonical repo URL?
9. Should URLs use the issue number (`/issues/12`, GitHub style, scoped for free) instead of the id? Plan keeps ids because existing links use them.

## 13. Maintainer decisions (2026-10-17)

Production read (GETs only): `/api/issues` answers 200 with an empty list, so there are no live issues, no duplicate
numbers and nothing for the mixed-version window to break. Tombstoned rows were not checked.

| Q | Decision |
|---|---|
| 1 | Accept the brief "new UI, old DO" create failure; no number hint. |
| 2 | Defer the unique index (own change; re-run the duplicate check then). Never bump `LATEST_SCHEMA_VERSION` in T1. |
| 3 | Moot for existing data (no issues). Whether the fix is deployed is still unchecked. |
| 4 | Yes, as a separate follow-up (distinct entity-404 error); not part of this work. e2e guards it meanwhile. |
| 5 | Skip. |
| 6 | Yes: issue detail enforces `visibility` like the list. |
| 7 | `locked` and `maintainers_only` are enforced in the DO (explicit 4xx, not 500). `closed` still accepts comments; the UI offers Reopen. Whether closed issues accept comments becomes a per-repo setting. Spine: human review. |
| 8 | Redirect `GET /app/issues/:id` to the canonical repo URL; keep the old URL working. |
| 9 | Later, after the duplicate-number question is settled. |

**New scope from these answers (not in T1-T7; each needs a plan and human sign-off):**
- **Issue-to-issue links.** No such table exists (`schema.sql` has `issue_spec_links`, `issue_candidate_links`, `issue_comments` only). Needs a new
  `issue_issue_links` table plus routes and UI ("follow-up of", "see also").
- **Closed-issue comment setting.** `comment_policy` is CHECK-constrained to `open | maintainers_only | locked`, so a closed-issue setting needs
  a new column (or a new policy value), i.e. a schema change.
- Both are schema changes, so they hit the old-DO trap in risk 3 (a schema bump makes an old DO throw `Unknown schema_version`).
  Do them together in one additive migration, in their own push, after T1-T7 have shipped, and check how earlier migrations (m3 to m8)
  handled the mixed-version window before writing it. They are not part of the "make the pages reachable" work.
