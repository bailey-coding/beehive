# M8 plan (v2): make the repo issue pages reachable and correct

Task `ui-issues-plan-v2` | spec: `docs/MILESTONES.md` M8 | v1 planned 2026-10-17 against `origin/main` 11d0816; v2 answers
`docs/M8-UI-ISSUES-PLAN-REVIEW.md` ("approve with changes") and the maintainer decisions in section 12.
Plan only: no implementation code. Line numbers are on this branch (`origin/main` + docs).

**Ownership (maintainer decision, 2026-10-17).** The Spec DO tasks are spine (AGENTS.md rule 2). An agent writes them; the
maintainer and an independent review agent both review them before merge. They are a separate branch and a PR-sized unit
(D1, D2, D3 in one PR, `agent/m8-issues-do`) and land **first**. The UI tasks are a second PR (`agent/m8-issues-ui`). Both branch from `main`, never from each other
(`docs/AGENT-ROUTING.md` "Branches and review"); the UI PR is merged only after the DO PR is on `main` (S1).

## 1. Defects re-verified against current code

Baseline: typecheck clean; `npm test` 583 passed, 15 failed, all in `tests/cli-behavior.test.ts` (needs `cli/node_modules/.bin/tsx`; run
`npm install` in `cli/` before judging). Both v1 and the review confirmed 1-11 below.

| # | Defect | Evidence |
|---|---|---|
| 1 | All three issue GET pages 404 (`repoHierarchicalMatch` matches 2-3 segments). A 3-part POST works (`ui.ts:392`); a 2-part POST says "Method not allowed" | `ui.ts:134-140` |
| 2 | Comments post to `/api/issues/:id/comments` (fixed in 3790070), but success lands on `/app`, the form action `/app/issue_comments` has no repo, `success` missing counts as OK | `ui.ts:789-810`, `ui-pages.ts:1396` |
| 3 | Number = filtered max+1 over a capped list, not atomic; the filtered call is blocked by the `ui.test.ts` stub; `createIssue` has no try/catch; no unique index; CLI supplies numbers (`--number`, `cli/src/commands/issue.ts:14`) | `ui.ts:760-767` |
| 4 | Redirect `Location` is not URL-encoded (`#` in a title breaks it) | `ui.ts:783` |
| 5 | `issuePage` ignores the repo in the URL; any repo's URL shows any issue | `ui.ts:327`, `ui-pages.ts:1313` |
| 6 | Repo resolution is copied five times (`ui.ts:135-176, 189-222, 239-272, 289-325, 713-756`) | |
| 7 | Two URL shapes for one issue (`renderIssueRow` uses a repo UUID, `ui-pages.ts:1167`; list/spec page use `/app/issues/:id`) | |
| 8 | Every POST result goes through `back()` to `/app` | |
| 9 | Issue id validated by `validComponent` in one place, `isValidId` in another (`ui.ts:302`) | |
| 10 | `subHeader(\`Issues for ${esc(name)}\`)` double-escapes (`ui-pages.ts:77-81`, `:1219`) | |
| 11 | `doReader.get` maps `{error:'Not found'}` to `null`, identical to the DO catch-all 404 (`ui.ts:54`, `spec-do/index.ts:3743`): a missing route looks like a missing entity | |
| 12 | `renderRepoIssues` and `specPage` use `getName(i)` as link text; issues have `title`, so links render empty (`ui-pages.ts:552, 744`) | review S7, verified |
| 13 | `issues.status` is never written: no SQL anywhere does `UPDATE issues SET status/closed_at`; the DO has no close/reopen route; the comment form renders only when `isOpen` (`ui-pages.ts:1397`) | verified by grep of `spec-do/index.ts` |
| 14 | Private issues are hidden in the list but shown on the detail page | decision 6 |

## 2. Routing

All issue routes are matched in `handleUi` after session and actor checks, **before** `repoHierarchicalMatch`, GET and POST together.
Parsing lives in the pure module `workers/api/ui-repo-ref.ts` (section 3).

```
REPO_ISSUES   = /^\/app\/repos\/([^/]+(?:\/[^/]+){0,2})\/issues(?:\/([^/]+))?$/
ISSUE_ACTION  = /^\/app\/repos\/([^/]+(?:\/[^/]+){0,2})\/issues\/([^/]+)\/(comments|status)$/
```
Capture 1 = repo ref (1-3 segments, each `decodeURIComponent`ed in try/catch, then validated); capture 2 = none (list), `new`, or an issue id.
Order: `ISSUE_ACTION` (POST) -> `REPO_ISSUES` (GET list/new/detail, POST create only with no capture 2) -> old `repoHierarchicalMatch` -> old `detailMatch`
(now a redirect, section 6) -> the old create/`issue_comments` branches (reduced to the compat shim, section 7).

| URL | ref | meaning |
|---|---|---|
| `/app/repos/acme/ns/shop/issues[/new\|/<id>]` | `acme/ns/shop` | list / form / detail (3-part) |
| `/app/repos/acme/widgets/issues[/new\|/<id>]` | `acme/widgets` (namespace == org) | same, 2-part |
| `/app/repos/<repo uuid>/issues[/new\|/<id>]` | `<uuid>` | same, UUID fallback |
| `POST .../issues/<id>/comments` and `.../status` | as above | add comment / close or reopen |

Greedy `{0,2}` backtracks (`/app/repos/acme/widgets/issues` -> ref `acme/widgets`).
**Fall-through:** if `REPO_ISSUES` matches but the ref does not resolve, continue to the old blocks, so repos literally named `issues` or `new` still work
(`/app/repos/acme/ns/issues` is issues-of-`ns` first, repo `issues` second; if both resolve the issue-list reading wins; documented and tested).
After the ref resolved: bad issue id / issue not in repo -> 404; wrong method -> 405 text.

## 3. One shared repo-resolution helper (`workers/api/ui-repo-ref.ts`)

- `parseRepoIssuesPath(path, method)` -> `{ kind: 'list'|'new'|'detail'|'comment'|'status'|'create', refSegments, issueId? } | null`. Pure.
- `resolveRepoRef(reader, segments)` -> `{ repo, org, repoUrl } | null`: 1 segment = repo id (`isValidId`, `reader.get('/api/repositories/:id')`, then its org),
  2 = org/repo (`namespace === org`), 3 = org/ns/repo; predicate copied from the existing code (`namespace || 'default'`, `organization_id`/`organizationId`).
  Unfiltered `reader.list` calls (R1 rule). **Throws** on any DO error (caller -> 502).
- **Single validator (S6).** One `validComponent` exported from here and used by `buildRepoUrl` (`ui-pages.ts:165`) and `ui.ts:150`: regex `[A-Za-z0-9_.-]{1,64}` **and** not `.` or `..`.
  A repo named `..` then gets the UUID URL (`createRepository` does not validate names, `spec-do/index.ts:4126`).
- `repoUrl` comes from `buildRepoUrl` (components are `[A-Za-z0-9_.-]`, so the HTML-escaped output equals the raw output and is safe in `Location`).
- The old `repoHierarchicalMatch` block calls the same helper (five copies become one). POST handlers use `createDoReader` too.

## 4. Spec DO changes (spine; PR `agent/m8-issues-do`, written by an agent, reviewed by maintainer + independent review agent)

**Rules for all three:** additive routes/behaviour only; **no `LATEST_SCHEMA_VERSION` bump** (`index.ts:27`; a bump makes an old DO throw
`Unknown schema_version`, `index.ts:836`), no new column, no new table. Errors are mapped to 4xx **only inside the issue handlers** by a small local helper
(`BadRequestError`->400, `ForbiddenError`->403, `NotFoundError`->404, `ConflictError`->409, mirroring `index.ts:1836`).
**Review finding rejected in part:** the review proposed remapping the main `catch` (`index.ts:3747-3752`). I could not prove that no main-fetch route throws
`NotFoundError`/`BadRequestError` today, and callers do branch on 404 (`candidate-service/index.ts:525`, `preview-manager/index.ts:295`), so a global remap could turn a
500 into a "not found" they treat as absent (the AGENTS.md hazard). The local helper gives the same explicit 4xx on the issue routes with no blast radius.

"Maintainer" = `isMaintainer(actorId)` (`index.ts:1860`): ledger-global `actors.role = 'maintainer'`, excluding service-account actors; not per-repo or per-org.
"Actor" = the `X-Actor-ID` header, which the edge sets for service tokens (`api/index.ts:103`) and for UI/`callDo`; for master-token callers it is client-asserted
(`principal.ts:44`), so this is only as strong as the existing edge. Not changed here.

**D1. Issue numbering** (`createIssue`, `index.ts:1465`; route `:3448`):
- `number` optional in `CreateIssueRequest` (`api/types.ts:542`). One `this.state.storage.transactionSync` covers: repository exists and is live (else 404/409), explicit-number check
  (integer >= 1, else 400; unused for `(repository_id, number)` counting tombstones, else 409) or `COALESCE(MAX(number),0)+1` (tombstones counted, so a number is never reused), the INSERT, and `recordHistory`.
- Atomic because the adapter is synchronous and the route's only `await` is `request.json()` (`sql-storage.ts:43-46`); the transaction also makes insert + history all-or-nothing.
- Author: `createdBy` is the header actor; a differing `body.createdBy` -> 403 (see D2c; the UI and API worker both send the same value today, `api/index.ts:1749`).

**D2. Comment rules and policy authorisation** (`updateIssueCommentPolicy` `:4105`, route `:3500`; `createIssueComment` `:4114`, route `:3514`):
- a. `PATCH comment-policy`: header actor must be a maintainer (403), value in `open|maintainers_only|locked` (400, today a CHECK failure = 500), issue exists and is live (404). Without this
  any actor can undo a lock.
- b. `POST comments`: issue must exist and be live (404; a tombstoned issue accepts comments today); body a non-empty string of at most 10,000 chars (400);
  `comment_policy` `locked` -> 403 for everyone (a maintainer unlocks via D2a first), `maintainers_only` -> 403 unless maintainer, `open` -> allowed. **`closed` issues still accept comments** (decision 7).
- c. Author = header actor; `body.createdBy` present and different -> 403. Master-token callers sending no header get `'unknown'` as today.
- d. All four checks and the INSERT run in one `transactionSync`.

**D3. Close / reopen route** (new `PATCH /api/issues/:id/status` `{ status: 'open'|'closed' }`; nothing sets `issues.status` today):
- Allowed for a maintainer or the issue's `created_by` (assumption, Q1 below). Sets `status`, `closed_at`/`closed_by` (cleared on reopen), writes `recordHistory('issue', id, <current stage>, actor, 'Issue closed|reopened')`
  (no `stage` change, no CHECK issue). Same status again = 200 no-op. 404 for tombstoned/unknown, 400 for a bad value.

**Mixed-version matrix** (one push deploys all workers in no order; only the `beehive` worker calls issue routes, verified by grep of `workers/` and `tests/e2e/`):

| Change | Old caller + new DO | New caller + old DO |
|---|---|---|
| D1 numbering | old UI/CLI send `number`: honoured if free, 409 on duplicate (the CLI used to silently duplicate; note in `FEATURE-PARITY.md`) | new UI omits `number`; old DO binds `undefined`/NULL, fails, answers 500 JSON, no row written (assert status + no row, not the message). Bounded by merging the UI PR only after the DO PR is on `main` and deployed (S1); otherwise the failure lasts until the next deploy |
| D2a policy | a non-maintainer `PATCH` that used to succeed now gets 403, including service tokens (`write` scope, `docs/plans/service-accounts-plan.md:774`); intended | n/a (UI never calls it) |
| D2b/c comments | UI/API worker already send matching `createdBy`; a locked issue now gets 403 where it used to accept; intended | UI pre-checks the same rules for friendly errors; old DO would accept a locked-issue comment (no corruption, just unenforced) |
| D3 status | n/a | old DO answers 404 catch-all; `doWrite` treats that as failure and the UI shows "Closing/reopening is not available yet", never a silent no-op |

Deferred (section 13): unique index on `(repository_id, number)`, any schema change.

## 5. Response.ok on every DO fetch

- Reads only through `createDoReader` (`ui.ts:48`); lists throw on `!success`; page handlers keep try/catch -> 502. Never `?? []` on a failed call.
- Writes through one `doWrite(stub, path, method, body, actorId)` returning `{ ok: true, data } | { ok: false, status, error }`; anything but `success === true` is a failure (replaces `=== false`, `ui.ts:776, 806`).
- POST routes get their own try/catch -> redirect to the originating form with a **fixed** message ("Could not create issue"), the DO text goes to `console.error` (N1).
- Test: a stub answering 404/500 for `/api/repositories` gives 502, never an empty list or "Repository not found".
- Known gap (defect 11, decision Q4: separate follow-up): the UUID-form ref resolves via `reader.get`, so a DO catch-all 404 reads as "not found" (404 page, not 502). Pinned by a test so the follow-up has a target.

## 6. UI behaviour (PR `agent/m8-issues-ui`)

- **CSRF (S4).** Call `sameOrigin` (`ui.ts:929`) once, before any DO read, for create, comment, status and the `/app/issue_comments` shim (the new routes are evaluated before the existing block at `ui.ts:385`).
- **Create:** `doWrite POST /api/issues` with no `number`; success -> `${repoUrl}/issues/${encodeURIComponent(issue.id)}?ok=${encodeURIComponent('Created issue #'+issue.number)}` using the number the DO returned; failure -> `${repoUrl}/issues/new?error=...`. No form echo (Q5: skip).
- **Scoping:** `issuePage(issueId, repo, ...)`; `issue.repository_id !== repo.id` -> 404 "Issue not found in this repository". Ids validated with `isValidId` only.
- **Private issues (decision 6):** `visibility === 'private'` -> 404 on detail, on the comment and status POSTs, and on the legacy route **before** any redirect, so a private issue's canonical URL is never disclosed.
- **Legacy `GET /app/issues/:id` (decision 8):** fetch issue, 404 if private/missing, resolve its repo, `302` to `${repoUrl}/issues/${id}`; if the repo cannot be resolved, render in place. Old links keep working.
- **Links (defects 7, 12):** `renderIssueRow`, `renderRepoIssues`, `specPage` link to the canonical `repoUrl/issues/:id`; link text is `#<number>: <title>` via `getIssueTitle`, with a non-empty fallback (`Issue <short id>`) so a link can never render empty.
- **Flash:** `flash(url)` (escaped `ok`/`error`) lives in `ui-html.ts`, not `ui-pages.ts` (S8), and is called from list, new and detail pages; M9 reuses it. Fix double `esc` (defect 10) on touched lines only.

## 7. Comment and status flow

- `POST {repoUrl}/issues/{id}/comments`: `sameOrigin` -> resolve repo -> `reader.get` issue -> scope + private check -> trimmed non-empty body, length cap (same as D2b) -> `doWrite POST /api/issues/:id/comments`
  with `{ body }` only (author comes from the actor header, D2c) -> redirect `${issueUrl}?ok=...#comments`. The DO is the authority for `locked`/`maintainers_only`; the UI hides the form when `locked`
  (and for non-maintainers on `maintainers_only`) and shows the DO's 403 as the flash if it is bypassed. A closed issue still shows the form (decision 7).
- `POST {issueUrl}/status` (`status=open|closed`): same checks, `doWrite PATCH /api/issues/:id/status`, redirect with flash. The detail page shows **Close** on open issues and **Reopen** on closed ones, to the
  creator/maintainer only (UI hides, DO decides).
- `POST /app/issue_comments` stays one release as a shim for forms in open tabs: read `issueId`, fetch the issue, derive its repo, run the same function, redirect to the canonical issue URL; then delete it.

## 8. Test plan

Layout: `workers/api/tests/*.test.ts`, `workers/spec-do/tests/*.test.ts`, `tests/unit/*.test.ts`; `npm test` is CI.
- `workers/spec-do/tests/issue-numbers.test.ts` and `issue-comments.test.ts`, built on `workers/spec-do/tests/sqlite-state.ts` (foreign keys on, `transactionSync` rolls back; the `tests/unit/spec-do-list-bind-order.test.ts` harness disables FKs, `:18`).
  Numbers: 1,2,3 per repo, per-repo counters, continues past a tombstoned issue, `Promise.all` of 20 creates -> 20 distinct, free explicit honoured, explicit duplicate 409, 0/-1/1.5 -> 400, tombstoned/unknown repo rejected,
  a failed history write rolls the insert back. Comments: locked 403 for maintainer and non-maintainer, `maintainers_only` split, closed accepts, tombstoned issue 404, empty/oversize 400,
  `createdBy` mismatch 403, policy PATCH 403 for non-maintainer and service actor, 400 bad value, 404 unknown issue. Status: creator/maintainer allowed, others 403, idempotent, reopen clears `closed_at`.
  Every error asserts the exact status (not 500).
- `workers/api/tests/ui-repo-ref.test.ts`: every section 2 row, `acme/ns/issues`, repo named `new`, `%2e`, `.` and `..` (rejected, UUID URL used), bad escapes (`%E0%A4%A`), 4+ segments, trailing slash.
- `workers/api/tests/ui-issues.test.ts` (own recording stub that keeps the R1 "no filtered params" block): GET list/new/detail in 2-part, 3-part, UUID -> 200; other repo's issue 404; private issue 404 on detail, comment, status and legacy route (no `Location` header);
  legacy route 302 to the canonical URL; fall-through for a repo named `issues`; create sends no `number`, `Location` decodes to the message and survives `#`; DO 500 on create -> fixed-text error redirect; DO 404 on `/api/repositories` -> 502;
  comment hits `/api/issues/:id/comments` with no `createdBy`; DO 403 for locked shown as flash; status 404 from an old DO shows the "not available yet" flash;
  **cross-origin and missing-`Origin` requests each -> 403 on create, comment, status and the shim**; link text non-empty for an issue with an empty title; UUID-form catch-all 404 pinned (Section 5).
- Local e2e (never production; `docs/SETUP.md`): `npm run typecheck && npm test`, `scripts/start-e2e-workers.sh` (opt-in dummy `GITHUB_CLIENT_ID/SECRET` for the `beehive` worker only; OAuth never exercised), then new
  `tests/e2e/ui-issues.test.ts`: bearer-API setup, forged session cookie (`signSession` HMAC of `API_AUTH_TOKEN`), `Origin` on POSTs; list -> new -> create (#1) -> create (#2) -> two parallel creates (distinct) -> comment -> lock via API as maintainer
  -> comment 403 -> unlock -> close -> reopen -> private issue 404 -> legacy URL 302 -> other repo's URL 404 -> 2-part/3-part/UUID all 200. Cleanup with tombstone + purge (`docs/OPS.md`), unique names per run, `scripts/stop-e2e-workers.sh`.
  Record the pass count in `docs/SETUP.md` "Local e2e status".

## 9. Risks

1. **Spine authorship:** agent-written ledger code; mitigated by the maintainer + independent-agent review and by additive-only, no-schema-bump rules. Policy PATCH now needs a maintainer: a behaviour change for service tokens.
2. **Route shadowing:** issue-first order changes what `/app/repos/a/b/issues` means; fall-through + tests cover it.
3. **Schema bump trap:** never bump `LATEST_SCHEMA_VERSION` here (section 13).
4. **Mixed window:** new UI on old DO fails on create; closed by merge order (UI PR after DO PR is on `main`; the maintainer deploys after both, so the window is one push).
5. **Actor trust:** master-token callers assert any actor; D2c is only as strong as that.
6. **`ui.ts` conflicts with the navbar task:** land the UI PR before navbar work (section 10).
7. **Defect 11** can mask a missing DO route; the e2e step is the guard until the Q4 follow-up.

## 10. Tasks, in order

Each task: own branch from `main` (`--new-branch`), commit `step: ... | task: <id> | spec: ... | confidence: ..` + the Co-Authored-By line, final push. **Nothing deploys**; the maintainer pushes to the Artifacts repo after both PRs are on `main`.
PR 1 = D1-D3 (`agent/m8-issues-do`); PR 2 = U1-U5 (`agent/m8-issues-ui`, starts only after PR 1 is merged). Tiers per `docs/AGENT-ROUTING.md`.

| Id | Task | Files | Tier | Depends on | Test that proves it | Human review |
|---|---|---|---|---|---|---|
| D1 | Optional `number`, transactional atomic assignment, tombstoned/unknown repo rejected, local error mapper, author = header actor | `spec-do/index.ts`, `api/types.ts`, `spec-do/tests/issue-numbers.test.ts` | heavy (plan, then implement; spine) | none | `issue-numbers.test.ts`, incl. 20 parallel creates and rollback | **Yes: maintainer + independent review agent** |
| D2 | Comment-policy authorisation + validation, comment rules (locked / maintainers_only / tombstoned / body / author), one transaction | `spec-do/index.ts`, `spec-do/tests/issue-comments.test.ts` | heavy (authz in the ledger) | D1 (mapper) | `issue-comments.test.ts`, every status asserted exactly | **Yes: maintainer + independent review agent** |
| D3 | `PATCH /api/issues/:id/status` + history row | `spec-do/index.ts`, `api/index.ts` (route passthrough, `:264-290` pattern), `api/types.ts`, tests | default | D1 | status cases in `issue-comments.test.ts`; API route reachable (edge router) | **Yes: maintainer + independent review agent** |
| U1 | `ui-repo-ref.ts`: parse, resolve, shared `validComponent` (rejects `.`/`..`), used by `buildRepoUrl` | new file, `ui-pages.ts:165` | default | none (may run beside D1-D3) | `ui-repo-ref.test.ts` | No |
| U2 | `ui.ts`: routing table, delete copied blocks, `doWrite`, create/comment/status routes, one `sameOrigin`, legacy GET redirect + private 404, `/app/issue_comments` shim, encoded redirects | `workers/api/ui.ts` | default | U1; **DO PR on `main`** (S1) | `ui-issues.test.ts` | No |
| U3 | `ui-pages.ts` + `ui-html.ts`: scoped `issuePage`, `flash()` in `ui-html.ts`, canonical links with non-empty text, comment form (hidden when locked), Close/Reopen buttons, defect 10 on touched lines | `ui-pages.ts`, `ui-html.ts` | default | U1 (same branch as U2) | `ui-issues.test.ts` link/flash/form cases | No |
| U4 | Opt-in dummy GitHub vars in `start-e2e-workers.sh`; `tests/e2e/ui-issues.test.ts`; local run, record result | `scripts/`, `tests/e2e/`, `docs/SETUP.md` | default | U2, U3, DO PR | the e2e run itself (never production) | No |
| U5 | Docs: correct the 39a2669 review in `OPEN-QUESTIONS.md`; record the rollback/`Unknown schema_version` hazard and fix the `docs/OPS.md:75-76` line (S5); tick M8; `FEATURE-PARITY.md` incl. CLI duplicate `--number` now 409 (N6); note the master-token actor limit | docs | light | U4 | doc grep against code (AGENTS.md "grep for the implementation") | Maintainer skim |
| R | Final read-through of both merged diffs against sections 2, 4, 5, 6 | n/a | default (heavy only if D-review raised concerns) | all | review report | Maintainer |

Order: D1 -> D2 -> D3 (one PR, reviewed as one unit, each layer's own commit) in parallel with U1 -> **DO PR merged** -> U2+U3 -> U4 -> U5 -> R.

## 11. Shared touchpoints for the later navbar task (not part of this work)

`page()` in `ui-html.ts:244` (shell; navbar goes here); `subHeader()` in `ui-pages.ts:77` and the dashboard `<header class="bar">` in `ui.ts`; the `flash()` helper in `ui-html.ts` (M9 "one flash/error area" reuses it);
`resolveRepoRef` for breadcrumbs. Run navbar edits after U2/U3 land.

## 12. Maintainer decisions (2026-10-17)

Production read (GETs only): `/api/issues` returned 200 with an empty list: no live issues, no duplicate numbers. Tombstoned rows not checked.

| Q | Decision | Where it lands |
|---|---|---|
| 1 | Accept the brief "new UI, old DO" create failure; no number hint | section 4 matrix |
| 2 | Defer the unique index; never bump `LATEST_SCHEMA_VERSION` in these tasks | section 13 |
| 3 | Moot (no issues); bind-order fix deployed? still unchecked | n/a |
| 4 | Distinct entity-404 error is a separate follow-up | section 5 |
| 5 | No form echo | section 6 |
| 6 | Detail enforces `visibility` | section 6 |
| 7 | `locked`/`maintainers_only` enforced in the DO with explicit 4xx; `closed` accepts comments; UI offers Reopen; closed-issue setting later | D2, D3, section 7 |
| 8 | Redirect `GET /app/issues/:id` to the canonical URL | section 6 |
| 9 | Number-based URLs later | n/a |
| (own.) | An agent writes the DO tasks; maintainer + independent review agent review them; separate PR, first | top, section 10 |

Remaining questions: (1) who may close/reopen: plan assumes creator or maintainer; (2) `locked` blocks maintainers too until unlocked (plan assumption, matches "enforced"); (3) is `maintainer` meaning ledger-global `actors.role` acceptable for D2a (no per-org roles exist).

## 13. Deferred: future milestone (proposed name **M11**, after M9; pending maintainer confirmation; `docs/MILESTONES.md` not edited)

Out of this plan: the **issue-to-issue links table** (`issue_issue_links`; none exists today) and the **closed-issue comment setting** (decision 7; `comment_policy` is CHECK-constrained, so use a new column, never a new policy value: widening a CHECK needs a table rebuild, `index.ts:69-71`). Its UI half edits the issue detail page that M9 re-lays out, hence after M9.
Hazard (review S5): a version bump turns a rollback (rule 7) into an outage, because old code throws `Unknown schema_version` (`index.ts:836`, `init()` rethrows `:495-499`); `docs/OPS.md:75-76` calls this "untested". m4-m8 shipped in one push (additive, idempotent, read-only `schema_version` check before/after, `OPS.md:30-62`), not rollback-safe.
Safe two-push method:
1. **Push A, no bump:** `runMigrations` accepts an `m<N>` above the latest it knows, logs it and continues (with a test). A becomes the rollback floor.
2. **Push B, only after A is live:** step `m9` = `CREATE TABLE IF NOT EXISTS` for the links table + `addColumnsIfMissing('repositories', ['<setting> TEXT NOT NULL DEFAULT ...'])`; same section in `initSchema` (`:514-529`); `schema.sql` + `schema-inline.ts` together (`schema-sync.test.ts`); `migrations.test.ts` "fresh ledger starts at m9";
   new table before `issues` in `ORG_PURGE_ORDER` (`:87-101`) or org purge fails on its FK; OPS checklist entry; links limited to issues in the same organisation (no cross-org title leak, purge stays per org). Old code never touches the new table and its INSERTs name columns, so defaults fill.
Also deferred: unique `(repository_id, number)` index (re-run the duplicate check first), distinct entity-404 error (Q4), number-based URLs (Q9).

## 14. Review responses

| Finding | Response |
|---|---|
| B1 sections 6/7/8/10 contradict section 13 | Accepted. Rewritten; tasks added for private 404 (U2/U3), DO comment rules (D2), legacy redirect (U2), status route + UI (D3, U3) |
| B2 policy PATCH unauthorised (`index.ts:4105`) | Accepted, verified; D2a |
| B2 catch maps only `ConflictError` (`:3747-3752`) | Accepted; **fix narrowed**: local mapper in issue handlers, not a global remap (callers branch on 404; cannot prove no route relies on 500). Review's "no caller branches on 5xx vs 4xx" is true for status class but not for 404 |
| B2 header actor, not `body.createdBy` | Accepted; D1/D2c. Limit: master-token header is client-asserted (`principal.ts:44`) |
| B2 tombstoned issue accepts comments | Accepted, verified; D2b |
| B2 define "maintainer" | Accepted; section 4 |
| S1 UI before DO | Accepted; separate PR, UI starts after DO PR is on `main` |
| S2 spine authorship, heavy tier | Accepted with the maintainer's decision (agent writes, maintainer + review agent review); D1/D2 heavy tier. Global-catch concern removed by the narrowed mapper |
| S3 transaction + FK-on harness | Accepted; D1, section 8 |
| S4 CSRF on new POSTs | Accepted; section 6, tested per route incl. missing `Origin` |
| S5 hazard, precedent, safe method | Accepted; section 13, OPS fix in U5 |
| S6 `.`/`..` | Accepted; section 3 |
| S7 empty link text | Accepted, verified (`ui-pages.ts:552, 744`); section 6 |
| S8 `flash()` in `ui-html.ts` | Accepted; U3 |
| N1 fixed error text | Accepted; section 5. N2 encode issue id: accepted, section 6. N3 400 for bad numbers: accepted, D1. N4 line drift: accepted, lines updated. N5 UUID 404 pin: accepted, section 5/8. N6 CLI `--number` 409: accepted, U5 |
| Not verified | Whether the `listIssues` bind-order fix is deployed; tombstoned issues in production; every `NotFoundError` throw site reachable from the main fetch catch |

## 15. Final maintainer answers (2026-10-17) - these override section 12's "remaining questions"

1. Close/reopen: the issue's creator or a maintainer (as planned in D3).
2. `locked`: only maintainers may comment (not "blocks everyone"). `maintainers_only` is the same rule for the comment form; `locked` additionally hides the form
   from non-maintainers and shows "Locked". Update D2b and the tests: a maintainer comment on a locked issue succeeds; any other actor gets the explicit 4xx.
3. M11 (issue-to-issue links + closed-issue comment setting) is confirmed as a milestone in `docs/MILESTONES.md`, after M9.
4. PR 1 (D1-D3) is implemented by a Sonnet 5.5 agent at medium thinking. Review by the maintainer plus an independent review agent stays.
5. **Actor validation (new scope for D1/D2/D3):** the actor must be a validated identity, with a user token as the focus. Facts to design from:
   `authenticate()` (`workers/api/principal.ts:36-109`) only knows the master token (actor = client-sent `X-Actor-ID`, line 44) and read-only service
   tokens (actor from the service account). There is no user-bound API token today; UI requests carry a GitHub session whose login becomes the actor.
   Required in PR 1, additive and mixed-version safe:
   - The DO resolves the header actor against the `actors` table. An unknown actor id cannot create issues, comment, change status or change the
     comment policy (403, explicit); `'unknown'` (no header) is rejected for these writes. Check how `'unknown'` and existing agent callers
     (`queue-consumer`, `sandbox-runner` send fixed ids) are handled so no existing worker caller breaks; list each in the PR description.
   - Service-account actors stay excluded from maintainer status (already in the plan) and from these writes.
   - For UI requests the actor is derived server-side from the session, never from form fields; verify the session login maps to an `actors` row (and
     what happens for a first-time login with no row) and write a test.
   - Do NOT build a new user-token type in PR 1. If a user-bound token is wanted for API/CLI callers, write it up as a proposal (where tokens are minted,
     how `authenticate()` would return `kind: 'user'`, scopes, and the spine/capability-minting overlap in M3/M6.2) in `docs/OPEN-QUESTIONS.md` and stop;
     it needs a human.
   - Document the remaining limit: a master-token holder can still assert any existing actor id until user tokens exist.
