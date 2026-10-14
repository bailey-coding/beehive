# M6 Semantic Dashboard UI: Oracle Review of the Plan

**Plan reviewed:** `docs/plans/m6-ui-plan.md` @ `467e841` (branch `m6-semantic-dashboard`).
**Reviewed:** 2026-10-14. **Scope:** plan only. No code was changed.
**Checked against:** `AGENTS.md`, `docs/MILESTONES.md` (M6), `docs/FOCUS.md` (M6 checklist),
`docs/UI-DASHBOARD-PLAN.md` (Phase 0.5), `workers/api/ui.ts`, `workers/api/index.ts`,
`workers/spec-do/index.ts`, `workers/spec-do/sql-storage.ts`, `workers/spec-do/schema.sql`.

## Verdict: APPROVE WITH CHANGES

The plan's structure is sound. It uses ID-based routes inside `handleUi`, only reads data,
makes no Spec DO or schema changes, keeps mocks in a pure module, and does the shared-file
edit last. However, it depends on Spec DO list filters that **return nothing in production**,
and its test design would hide that. With that fixed (R1–R3) and the honesty and security
items addressed (R4–R9), the plan can go ahead. Make the cuts in §7 first, because today is
the deadline.

---

## Required changes

### R1. Don't use filtered Spec DO list routes. They return empty results (blocker)

Every route in the plan that takes a filter, `/api/specs?organizationId=`,
`/api/issues?repositoryId=`, `/api/candidates?specId=`, `/api/trials?specId=` and
`/api/promotions?candidateId=`, always returns `[]` when a filter is present.

- Every filtered list method seeds `params = [limit, offset]` and then pushes the filter
  values: `workers/spec-do/index.ts:1941, 1971, 2006, 2054, 2084, 2106`. The SQL puts the
  filter placeholders *before* `LIMIT ? OFFSET ?`.
- The native adapter **appends** bindings in call order: `workers/spec-do/sql-storage.ts:50`.
  The resulting binding is `spec_id = <limit>`, `LIMIT <offset=0>`, `OFFSET <filter>`, so it
  returns zero rows.
- Reproduced with `node:sqlite` using that bind order. The filtered query returned `[]`. The
  same query with filter-first order returned the expected rows. Unfiltered `[limit, offset]`
  queries work.
- `docs/OPEN-QUESTIONS.md:44-46` says append semantics "match the
  `params.forEach(p => stmt.bind(p))` pattern used by the list methods". That holds only
  for unfiltered calls. No test exercises a filtered DO list.

Required for M6:
1. In the UI, call only **unfiltered** list routes (`/api/specs`, `/api/repositories`,
   `/api/candidates`, `/api/trials`, `/api/promotions`, `/api/issues`) and filter in the UI with
   `pick()`. Single-record GETs and `/api/candidates/:id/gate-verdicts` are unaffected
   (`spec-do/index.ts:1462-1468` binds one value).
2. **Don't fix the DO in this branch.** The fix belongs to the spine (MILESTONES.md
   "Sequencing rule"; AGENTS.md rule 2). Raise it with the human as a separate fix. It also
   breaks filtered REST/CLI calls (`index.ts:1106-1119`, `cli/src/commands/*`).
3. Per AGENTS.md ("Document surprises immediately"), the implementer adds a dated finding to
   `docs/OPEN-QUESTIONS.md` that corrects lines 44-46. I didn't edit it because this review
   is limited to the review file.

### R2. Fix the `DoReader.list` adapter. Reusing `listRows` corrupts query strings

`listRows` builds `${path}?limit=100&offset=0` (`ui.ts:359-362`). If a path that already has
a query string goes through it, you get `/api/candidates?specId=X?limit=100&offset=0`. The
filter value then becomes `X?limit=100`, and `limit` falls back to 50. Build `list()` with
`URLSearchParams` instead. Once R1 is applied, this only affects paging, but fix it anyway.

### R3. Make the test stub catch R1, and match real row shapes

- The planned fake `DurableObjectStub` "routes by path to fixture JSON" (plan L166-167). It
  would return fixtures for filtered URLs and pass tests while production shows empty
  tables. The stub must **fail the test on any list request carrying a filter param**
  (`organizationId|repositoryId|specId|candidateId|agentId|stage|status`) until the DO bind
  order is fixed.
- The plan says "Test fixtures use snake_case (the DO's actual shape)" (plan L197). That is
  **wrong for candidates**. `candidateRowToResponse` returns camelCase
  (`spec-do/index.ts:1006-1022`) on list, get, and create. The other entities are snake_case
  on GET (`spec-do/index.ts:934-1000`). Fixtures must match each entity's real shape.
- Fixture setup must also answer `GET /api/actors/:id` (`ui.ts:70-71`), or every
  authenticated request redirects to `/login`. The env must include `API_AUTH_TOKEN`,
  `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, or `handleUi` returns 503 (`ui.ts:52-54`).

### R4. Remove the "linked issues" claim from the spec page (no read path exists)

The spec page lists "linked issues" (plan L49), but the plan gives no data source, and there
isn't one. `issue_spec_links` has only a POST route in the DO (`spec-do/index.ts:1647-1658`)
and in the edge router (`index.ts:276-281`). Either drop the section, or show
"Issues in repos linked to this spec" (issues filtered by `repository_id` where
`repo.spec_id = spec.id`) under that heading. Don't present it as the link table.

### R5. Validate and encode IDs in URLs

`:id` comes from `url.pathname`, which stays percent-encoded. If the implementer decodes it
and interpolates it into a DO path, `..%2Factors` turns `/api/trials/<id>` into a request
that `new Request()` normalizes to `/api/actors`. That reaches other DO GET routes. The
impact is limited (GET only, and allowlisted users can already read everything), but the
fix costs two lines:
- Reject anything that doesn't match `^[A-Za-z0-9_-]{1,64}$` with the existing 404. That
  covers both `crypto.randomUUID()` IDs (`spec-do/index.ts:205-206`) and seed IDs like
  `org-001` (`spec-do/seed.ts:79`).
- Always build DO paths with `encodeURIComponent(id)`, as `ui.ts:70` already does.
- Build hrefs as `esc('/app/specs/' + encodeURIComponent(id))`. `encodeURIComponent` leaves
  `'` unescaped, so always pass the full href through `esc`.

### R6. Never put stored URLs into `href` unless the scheme is http(s)

`remote_url` is free text with no scheme check, in both the UI create path (`ui.ts:282-295`)
and the DO (`spec-do/index.ts:2227-2243`). Candidate `previewUrl` is set by a PUT that accepts
any string (`spec-do/index.ts:1408-1416`). If either is rendered as a link,
`javascript:alert(1)` becomes stored XSS. Render these as escaped text, or link them only when
`new URL(v).protocol` is `https:` or `http:`. Add this to the XSS test. Also render
`contract`, `declared_delta_surface` and `comparison_metrics` (stored as TEXT JSON,
`schema.sql:84-96, 159`) in an escaped `<pre>`, with `JSON.parse` inside try/catch. The API
and agents can store strings that aren't JSON.

### R7. Mocked data must not borrow real identity or invent real-looking numbers

- **Mock commit author.** The plan proposes `session.login` as an author (plan L104). That
  attributes made-up commits to the real signed-in human. Use only synthetic names (for
  example `agent:sample-a`).
- **Changelog entries built from ledger rows.** The plan's example summary includes
  "on p95 latency (−18%)" (plan L96). For rows with `mocked:false`, every number must come
  from the row itself (for example parsed `trials.comparison_metrics`). If a field is missing,
  say "no metrics recorded". Don't make up numbers next to real entity IDs.
- **Search.** Real ledger hits come from substring matching but get a "cosine-style" score
  (plan L86). Put the **Mocked** label on the whole search section whenever it renders,
  including when every hit is real. Either hide the score for ledger hits or label it as
  "keyword match". Tag each sample code hit as *sample*. Sample hits get no `href` into
  Artifacts.
- **Builds that "track the linked candidate's stage"** (plan L134). A made-up build row that
  shows a real stage blurs the line between mocked and real. Either mark those rows
  "stage from ledger" or keep builds fully mocked. A better option is under S2.

### R8. Make the mocks truly deterministic

The plan promises "same data on every reload" (plan L37-38), but the changelog uses "last
7 days" and the mocks have `at` timestamps, which depend on the current time. All generators
must take `now` (or an anchor time) as a parameter, and mock times must be anchored to the
entity's `created_at`, not `Date.now()`. Tests should pass a fixed `now`.

### R9. State the authorization model explicitly

There is no per-org access control. There is one DO (`index.ts:64, 83`), the schema has no
membership table, and access is gated only by `ALLOWED_GITHUB_USERS` plus a valid session
(`ui.ts:66-71`). The new pages don't open a new hole, since the existing dashboard already
lists every org, repo and spec (`ui.ts:192-197`). They do widen what a session can read
through the UI to include candidates, gate verdicts, trials, promotions and issues. The issue
rows include `visibility` (`public|internal|private`, `schema.sql:209`). The plan must:
- Say that any allowlisted user can see every org's records, and that per-org ACLs are
  M5 / out of scope.
- Put the dispatch hunk **after** the actor check at `ui.ts:70-71` (the plan's "after the
  existing `/app` line", L73, does this) and limit it to `GET`.
- Show a `visibility` badge on issues. Leave `private` issues out of the search corpus and
  the changelog.
- Secrets: none of the rows the plan reads hold secrets. The fork token from `claimSpec` is
  returned once and never stored (`spec-do/index.ts:687-689`), and `remote_url` contains no
  token (`workers/shared/artifacts.ts:154`). Keep it that way: no `env.*` and no cookie values
  in rendered output.

### R10. Correct the false claims in the plan

| Plan claim | Reality |
|---|---|
| "List routes cap at `limit=100`" (L198) | The cap comes from the UI (`ui.ts:360`). The DO doesn't clamp (`spec-do/index.ts:1151, 1251, 1294`), and `ensureActor` already uses `limit=500` (`ui.ts:178`). With R1, use a higher limit (for example 500) and keep the truncation note. |
| `ChangeCategory` "matches the M4 change-type classification vocabulary" (L94) | It doesn't. The real vocabulary is `typo-fix \| refactor \| behavior-change \| security-sensitive \| dependency-change \| infra` (`cli/src/types/api.ts:269`; MILESTONES.md:76-78). Use that vocabulary or drop the claim. |
| `/api/specs?organizationId=`, `/api/issues?repositoryId=`, … are usable read routes (L47-50) | The routes exist but return empty results when filtered. See R1. |

Claims I **verified as true**:
- `handleUi` claims `/app` and `/app/*` (`ui.ts:48-50`) and runs before `authGate`
  (`index.ts:79-89`), so no routing change is needed in `index.ts`.
- Unknown paths fall through to the existing 404 page (`ui.ts:83`).
- Every single-record GET the plan uses exists in the DO: orgs `1159`, repos `1259`,
  specs `1304`, candidates `1378`, gate-verdicts-by-candidate `1462`, trials `1499`.
- There's no `GET /api/promotions/:id` route (`spec-do/index.ts:1527-1549`,
  `index.ts:234-239`), so promotion anchors are the right workaround.
- `/about` already has a "Vision: Semantic Dashboard" section (`index.ts:729-748`). The
  paragraph to replace is at `index.ts:744-747`.
- The DO accepts `specId` on repo create (`spec-do/index.ts:1234-1243`).
- Repos have `spec_id` (`schema.sql:49`), so "repos → their specs" works.
- `esc` escapes `& < > " '` (`ui.ts:464-466`), and `table()` escapes every cell
  (`ui.ts:468-473`).

---

## 1. Coverage of M6 requirements

| M6 requirement (MILESTONES.md:56-69, FOCUS.md:142-149) | Plan | Status |
|---|---|---|
| Semantic search in org and repo views | Org and repo pages, `?q=` GET form | ✅ (honesty: R7) |
| Semantic changelog | Org and repo pages | ✅ (R7, R8) |
| Repo detail: linked spec | Repo overview via `spec_id` | ✅ |
| Repo detail: commits with builds | Mocked commits tab | ✅ (see S2 for real data) |
| Repo detail: file tree | Mocked `<details>` tree | ✅ |
| Issues and specs tabs | `?tab=issues\|specs` | ✅ (data source: R1) |
| Cross-links spec ↔ candidates ↔ trials ↔ promotion | Spec, candidate and trial pages, promotion anchors | ✅ structurally, but **empty in prod without R1** |
| Repos → specs, orgs → repos/specs | Org page and repo overview | ✅ (R1) |
| `/about` vision mention | Already present (`index.ts:729-748`). Plan edits one paragraph. | ✅ already satisfied. The edit is optional (see §7). |
| Mocked sections clearly labeled | `.mocked` pill plus a per-hit flag | ✅ (R7 tightens it) |
| Existing `/app` create flows still work | Regression tests (plan L177-178) | ✅ |

Gap against UI-DASHBOARD-PLAN Phase 0.5: "Build/trial history" on the repo page
(`UI-DASHBOARD-PLAN.md:51`) isn't listed in the repo tabs. Trials reach the repo only through
the spec. Either add the trials for the repo's candidates to the overview tab, or note the gap.

## 2. Existing-code claims
See R10.

## 3. Auth and security
Session enforcement on new routes is correct as long as the dispatch goes after
`ui.ts:70-71` (R9). Escaping is sound if you follow R5 and R6. The authorization model is
single-tenant, so state it (R9). I found no secrets in the rendered data (R9).

## 4. Architecture rules (AGENTS.md)
- No coordination state outside the Spec DO: ✅. Mocks are pure functions, with no KV, D1
  or storage writes.
- Every module reachable from the edge router: ✅ (`index.ts` → `handleUi` → `ui-pages.ts` /
  `ui-semantic.ts` / `ui-html.ts`).
- No Spec DO schema or route changes: ✅. Keep it that way. The R1 bug fix goes to the human.
- "Don't skip ahead": real embeddings and Vectorize are correctly out of scope (plan L201).

## 5. Honesty of mocked data
Labeling and seeding are good. The required tightening is in R7 and R8.

## 6. Conflict risk with concurrent agents

State at review time: worktrees `service-accounts` and `repo-cleanup` are both at `617e86e`
(same as `origin/main`) with **no uncommitted changes**, so there's nothing concrete to
conflict with yet. Expected overlap, from FOCUS.md:
- Service accounts (FOCUS.md:84-106) will edit `workers/shared/auth.ts`, add
  create/list/revoke routes in `index.ts`, and may change the Spec DO schema
  (FOCUS.md:102-103).
- The fork-token endpoint is "session- or bearer-authenticated" on `beehive`
  (FOCUS.md:114). That probably means exporting `readSession` from `ui.ts` or adding a branch
  in `handleUi`. Both collide with **plan step 1** (moving `esc/str/table/page` out of the
  tail of `ui.ts`) and with the dispatch hunk.
- Repo cleanup ("remove any test/commented code", FOCUS.md:70) can touch any file.

Putting `index.ts` last as a separate commit is safe (✅). Changes required to the ordering:
- `git fetch && git rebase origin/main` **before step 1 and again before step 3**, not only
  before step 8.
- Keep step 1 as a **pure move**: identical function bodies, nothing else in that commit.
  If `ui.ts` changes on `main` mid-flight, drop the move and keep the helpers in `ui.ts`.
  Pass `page`/`esc` to `ui-pages.ts` through the same dependency object as `DoReader` to
  avoid the import cycle.
- Before the dispatch hunk, tell the service-accounts agent that M6 owns
  `dashboard()`, the helper tail of `ui.ts` and the new `ui-*.ts` files, and that it owns
  `readSession`/OAuth. Don't add new `export`s to `ui.ts`.

## 7. Scope and time: what to cut first

Today (2026-10-14) is the submission deadline. FOCUS.md:15 gives M6 the *midday* slot,
before an afternoon submission. MILESTONES.md:56 calls M6 "post-submission". The plan's
~1 day (8–11 h) doesn't fit that slot. Cut in this order:

1. **The `/about` paragraph in `index.ts`** (step 8). M6 is already satisfied by
   `index.ts:729-748`. Cutting it removes the only shared-file edit.
2. **The "Linked spec" select on the repo create form** (step 4d). This is a write-path
   change and needs same-org validation. Candidate repos already get `spec_id` from
   `claimSpec` (`spec-do/index.ts:640-656`).
3. **Global search and changelog on `/app`.** M6 asks for them in the org and repo views
   only. Keep the name → detail links on the dashboard.
4. **The styling pass beyond the `.mocked` pill and tab styles** (step 6).
5. **Building the changelog from real ledger rows.** If time is short, use only
   labeled sample entries. This also makes R7's numbers rule moot.

Minimum viable M6 (about 4–5 h): `ui-semantic.ts` + `ui-pages.ts` (org, repo with tabs, spec,
candidate, trial) + the dispatch hunk + dashboard links + handler tests for auth, 404, XSS,
cross-link hrefs and "no filtered list calls". **Gate the merge on time.** Merging to `main`
auto-deploys the UI that judges will see. If tests aren't green with margin before the
submission window, leave it as an open PR and merge after submission, which matches
MILESTONES.md.

---

## Optional suggestions

- **S1. Add a CSP header in `page()`.** The pages ship no JavaScript, so a strict policy costs
  nothing: `default-src 'none'; style-src 'unsafe-inline'; form-action 'self';
  base-uri 'none'; frame-ancestors 'none'`. `page()` isn't on the plan's "byte-for-byte
  unchanged" list.
- **S2. Make "commits with builds" partly real.** Candidates have a real `commit_sha` and
  `base_commit_sha` (`schema.sql:109-110`), and gate verdicts are real pre-merge to full
  "builds" (`schema.sql:130-140`). Show the real candidate commits with their real verdicts
  first, then pad with labeled samples. That's more honest and makes a stronger demo.
- **S3. Type-enforce escaping.** Give `tableHtml` a branded `Html` type (or a `SafeHtml`
  class) that only `link()`, `badge()` and `esc()` can produce, so raw strings can't reach it.
- **S4. Cap `?q=` at about 200 characters** before echoing it back.
- **S5. Link the trial page to the winner's promotions** (one more unfiltered
  `/api/promotions` read filtered in the UI), so trial → promotion is one click, not two.
- **S6. Don't use real-looking 40-hex SHAs for mock commits** (plan L102). Use something like
  `sample·3f2a9c1`, so a screenshot taken without its section label can't be mistaken for
  real data.
- **S7. Add a second test file at the DO level** (for example with `node:sqlite`) that pins
  the filtered-list bug, so the eventual spine fix has a failing test ready. The fix itself
  stays with the human.

## Confidence

0.85 that R1–R10 are complete and correct. R1 was reproduced against SQLite with the DO's
exact bind order. The other findings rest on the cited lines. What's still uncertain: what
the service-accounts agent will actually change, since it hasn't committed anything yet.
