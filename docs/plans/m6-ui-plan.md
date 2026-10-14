# M6 Semantic Dashboard UI — Implementation Plan

**Status:** Plan only (not implemented). **Branch:** `m6-semantic-dashboard`. **Created:** 2026-10-14.
**Spec:** `docs/MILESTONES.md#M6`, `docs/FOCUS.md` (M6 checklist), `docs/UI-DASHBOARD-PLAN.md` Phase 0.5.

## Goal and exit criteria

Make the logged-in `/app` UI show the semantic vision: semantic search, a semantic
changelog, repo detail pages (linked spec, commits with builds, file tree, issue/spec tabs),
and cross-links spec → candidates → trials → promotions. Semantic data may be mocked.

Exit criteria (from MILESTONES.md):
1. The semantic UI concepts are visible and navigable.
2. All existing `/app` functions still work (create org/repo/spec).
3. Every mocked section has a visible **Mocked** label.

## Constraints

- Server-rendered HTML in the `beehive` worker. `ui/` (React) stays unbuilt, so don't touch it.
- OAuth, session, cookie and CSRF code in `workers/api/ui.ts` stays byte-for-byte unchanged
  (`startLogin`, `finishLogin`, `ensureActor`, `signSession`, `readSession`, cookie helpers,
  `sameOrigin`).
- All new routes go under `/app/*`. `handleUi` already claims that prefix, so
  `workers/api/index.ts` routing needs **no** change.
- New pages only read data. No new Spec DO routes and no schema changes, so the
  orchestration spine (rule 2) is untouched.
- Don't run `wrangler deploy` and don't push to `main`.

## Design decisions

- **Use IDs in URLs, not `/:org/:repo` names.** Names aren't unique in the ledger, and
  root-level slugs would collide with `/api/*`, `/health` and `/about` in `index.ts`.
  This drops the slug scheme from `UI-DASHBOARD-PLAN.md`.
- **Use real ledger data for every link, and mock only the semantic layer.** Orgs,
  repos, specs, candidates, trials, promotions and issues come from existing Spec DO GET
  routes. Search hits, changelog summaries, commits/builds and the file tree are mocked.
- **Make mocks deterministic.** They are seeded from a hash of the entity ID, so a page
  shows the same data on every reload and tests can assert on it.
- **Render tabs and search without JS:** `?tab=` and `?q=` query params, `<details>` for the
  file tree, GET forms for search. No client script, so there's nothing new to sanitize.

## Routes

| Route | Content | Real data (Spec DO) | Mocked |
|---|---|---|---|
| `GET /app` (existing) | Names become links; add global search box + changelog | lists (existing) | search, changelog |
| `GET /app/orgs/:id` | Org header, repos, specs, search, changelog | `GET /api/organizations/:id`, `/api/specs?organizationId=`, `/api/repositories` (filtered by `organization_id` in the UI) | search, changelog |
| `GET /app/repos/:id?tab=overview\|issues\|specs\|commits\|files` | Repo header, linked spec, tabs | `GET /api/repositories/:id`, `/api/specs/:spec_id`, `/api/issues?repositoryId=`, `/api/candidates?specId=` (filtered by `repository_id`) | commits+builds, file tree, search, changelog |
| `GET /app/specs/:id` | Contract, delta surface, linked repos, candidates, trials, linked issues | `/api/specs/:id`, `/api/candidates?specId=`, `/api/trials?specId=`, repos filtered by `spec_id` | semantic summary blurb |
| `GET /app/candidates/:id` | Spec link, repo link, gate verdicts, trials it's in, promotion records (oracle-ladder rungs) | `/api/candidates/:id`, `/api/candidates/:id/gate-verdicts`, `/api/promotions?candidateId=`, `/api/trials?specId=` (filtered by `candidate_a_id`/`candidate_b_id`) | — |
| `GET /app/trials/:id` | Spec link, candidate A/B links, winner, metrics, decision | `/api/trials/:id` | — |

Promotions have no `GET /api/promotions/:id` route, so promotion records render inline on
the candidate page with `id="promotion-<id>"` anchors. Links target `/app/candidates/<cid>#promotion-<id>`.

The search form submits `GET <current page>?q=...`, and results render inline on that
page, scoped to the org or repo. No separate search route.

Unknown or invalid IDs (DO returns `success:false`) render the existing 404 page. An invalid
`tab` value falls back to `overview`.

## Files to touch

| File | Change | Shared? |
|---|---|---|
| `workers/api/ui.ts` | (a) In `handleUi`, add a GET dispatch block after the existing `/app` line that matches `/app/(orgs\|repos\|specs\|candidates\|trials)/:id` and calls `ui-pages.ts`. (b) Make dashboard names link to detail pages and add the search box + changelog. (c) Move `esc`, `str`, `table`, `page` (bottom of file) into `ui-html.ts` and import them. (d) Add `specId` as an optional "Linked spec" select on the repo create form (the DO already accepts `specId`), so the "linked spec" view can show real data. | UI module. The auth agent may edit `handleUi`, so keep (a) to one small hunk. |
| `workers/api/ui-html.ts` (new) | Pure render helpers: `esc`, `str`, `page` (+ new CSS for tabs, badges, `.mocked` label, tree), `table` (escaped cells, unchanged), `tableHtml` (cells already HTML, for links), `link(href, text)`, `badge(kind, text)`, `tabs(base, active, list)`, `mockedLabel()`, `pick(row, 'snake', 'camel')` (replaces the inline `a ?? b` pattern). | New, UI only |
| `workers/api/ui-pages.ts` (new) | `orgPage`, `repoPage`, `specPage`, `candidatePage`, `trialPage`. Each takes `(id, url, session, do: DoReader)` and returns a `Response`. `DoReader = { get(path): Promise<Row\|null>; list(path): Promise<Row[]> }` is built in `ui.ts` from the existing `callDo`/`listRows`, so this module doesn't import `ui.ts` (no import cycle). | New, UI only |
| `workers/api/ui-semantic.ts` (new) | Deterministic mock generators + renderers: `semanticSearch`, `semanticChangelog`, `mockCommits`, `mockFileTree`, `renderSearch`, `renderChangelog`, `renderCommits`, `renderFileTree`. Pure functions, no I/O. | New, UI only |
| `workers/api/tests/ui.test.ts` (new) | See test plan. | New |
| `workers/api/index.ts` | **One paragraph only**: the `/about` "Vision: Semantic Dashboard" section (~L730–746) already exists. Replace its last paragraph ("These features are being added progressively…") with one saying the views are live in `/app` with **mocked** semantic data, and that the real layer will be embeddings over Artifacts repos. | **Shared.** The auth agent is editing this file. Do this last, as a separate commit, after rebasing on `main`. |
| `docs/FOCUS.md`, `docs/UI-DASHBOARD-PLAN.md` | Tick the M6 checklist and Phase 0.5 boxes; record the ID-based routing decision. | Docs |

Not touched: `workers/shared/auth.ts`, `workers/spec-do/*`, `wrangler.toml`, `ui/`, every other worker.

## Mock data shape (`ui-semantic.ts`)

```ts
type EntityKind = 'org' | 'repo' | 'spec' | 'candidate' | 'issue' | 'file';

interface SemanticHit {
  kind: EntityKind;
  title: string;          // "src/pricing/discount.ts" or a real spec name
  href?: string;          // real /app/... link when the hit is a ledger entity
  snippet: string;        // "applyDiscount() clamps percentage to [0, 100]…"
  score: number;          // 0..1 cosine-style relevance, 2 decimals
  mocked: boolean;        // false for ledger-name matches, true for sample code hits
}

type ChangeCategory = 'feature' | 'fix' | 'refactor' | 'security' | 'deps' | 'infra';

interface ChangelogEntry {
  at: number;             // epoch ms; real created_at/decided_at/promoted_at when ledger-derived
  category: ChangeCategory;   // matches the M4 change-type classification vocabulary
  significance: 'high' | 'medium' | 'low';
  summary: string;        // "Candidate b3f… won trial vs 9a2… on p95 latency (−18%)"
  refs: { label: string; href: string }[];  // cross-links into /app
  mocked: boolean;
}

interface MockCommit {
  sha: string;            // 40 hex chars from hash(repoId + i)
  message: string;        // conventional-commit style, from a fixed pool
  author: string;         // "agent:claude-a", "agent:vibe-b", or session.login
  at: number;
  build: {
    status: 'passed' | 'failed' | 'running' | 'skipped';
    rung: 'pre-merge' | 'shadow' | 'train' | 'canary' | 'full';  // oracle ladder
    durationSec: number;
  };
}

interface FileNode {
  name: string;
  type: 'dir' | 'file';
  bytes?: number;
  summary?: string;       // one-line semantic summary ("Computes cart totals; pure")
  children?: FileNode[];
}
```

Generation rules:
- `seed = fnv1a(entityId)`, then a small PRNG (mulberry32) picks from fixed pools: about 12 commit
  messages, 1 file-tree template per repo type (price-calculator / URL-shortener shape,
  matching "candidate services stay small"), and about 10 code snippets.
- Search corpus = real names/descriptions of specs, repos and issues in scope (substring/token
  match, `mocked:false`, real `href`) + sample code hits (`mocked:true`). Top 8, sorted by
  score. An empty `q` renders the box with example queries ("where is rounding handled?").
- Changelog = real ledger rows in scope from the last 7 days (specs, candidates,
  trials, promotions), each mapped to a templated summary. Categories come from a
  keyword heuristic. If fewer than 3 real rows exist, pad with sample entries flagged `mocked:true`.
  The whole section still carries the **Mocked semantic summary** label, because the
  wording is template-generated, not model-generated.
- Commits: 8 per repo. The newest builds track the linked candidate's stage when one exists.

## Step-by-step

1. **Extract helpers (no behavior change).** Create `ui-html.ts`, move `esc/str/table/page`
   into it, and import them in `ui.ts`. Run `npm run typecheck && npm test`. Commit.
2. **Semantic mock module.** Write `ui-semantic.ts` with the generators and renderers, plus unit tests
   for determinism and escaping. Commit.
3. **Detail pages.** Write `ui-pages.ts` (org, repo with tabs, spec, candidate, trial). Add the
   single GET dispatch hunk + `DoReader` adapter in `handleUi`. Commit.
4. **Cross-links on the dashboard.** Use `tableHtml` + `link` for the org/repo/spec name columns,
   add the global search + changelog sections, and add the "Linked spec" select on the repo form. Commit.
5. **UI tests.** Write `tests/ui.test.ts` (below). Commit.
6. **Styling pass.** Tabs, badges (build status, rung, stage) and the `.mocked` pill. Reuse the
   existing dark palette and keep CSS inside `page()`. Commit.
7. **Docs.** Tick FOCUS.md and UI-DASHBOARD-PLAN.md. Commit.
8. **`/about` paragraph (shared file).** Run `git fetch && git rebase origin/main`, then make the
   one-paragraph edit in `index.ts`. Commit separately so it's easy to drop or re-apply if
   it conflicts with the auth agent.
9. **Verify and push the branch** (`git push origin m6-semantic-dashboard`). Open a PR to `main` for
   the human to merge. Merging auto-deploys.

Each commit uses `step: <desc> | task: m6-ui | spec: MILESTONES.md#M6 | confidence: <0-1>`.

## Test plan

Automated (`npm run typecheck && npm run lint && npm test`):

- **`ui-semantic.ts` unit tests:** the same ID gives identical commits/tree/changelog, and
  different IDs give different ones. Search ranks real-name matches and caps at 8. HTML in
  `q`, entity names and snippets comes out escaped. Every rendered mocked section contains the
  `Mocked` label.
- **`ui.test.ts` (calls `handleUi` directly with a fake `DurableObjectStub` whose `fetch` routes
  by path to fixture JSON):**
  - The session cookie is built in the test with the same HMAC scheme (key
    `beehive-ui-session:<secret>`), so `ui.ts` auth code needs no new exports.
  - No cookie → `GET /app/repos/x` returns 302 to `/login` (auth applies to new routes).
  - Each new route → 200 and contains the expected cross-link hrefs (e.g. the spec page has
    `/app/candidates/<cid>` and `/app/trials/<tid>`; the candidate page has `/app/specs/<sid>` and
    `#promotion-<pid>`; the repo page has `/app/specs/<spec_id>`).
  - Each `?tab=` renders its panel. A bogus tab falls back to overview.
  - DO `success:false` → 404 page.
  - XSS: a spec named `<script>alert(1)</script>` and `?q=<img onerror>` are escaped.
  - Regression: `POST /app/organizations`, `/app/repositories` (with and without `specId`) and
    `/app/specs` with a same-origin `Origin` → 302 `/app?ok=…`. Cross-origin → 403.
  - `GET /login` still redirects to GitHub with a state cookie (OAuth unchanged).
- The existing `workers/api/tests/api.test.ts` passes unchanged.

Manual (after the human merges and the deploy lands; production data, read-only clicks):
log in, then go `/app` → org → repo → each tab → linked spec → candidate → trial →
promotion anchor → back to repo. Search on org and repo pages. Create one org/repo/spec to
confirm the forms work. Check `/about` shows the updated paragraph. Local `wrangler dev`
can't complete GitHub OAuth (the callback URL is the production host), so pre-merge
confidence comes from the handler-level tests above. Don't run E2E suites against
production (they pollute the ledger).

## Risks

| Risk | Mitigation |
|---|---|
| Merge conflict with the concurrent service-accounts agent in `ui.ts` (`handleUi`) or `index.ts` | One small dispatch hunk in `handleUi`. The helper move touches only the file's tail. The `index.ts` edit is a separate final commit made after rebasing. Before pushing, check `git log origin/main -- workers/api/` and re-run tests. |
| Mocked data mistaken for real (demo/judging) | `Mocked` pill on every mocked section and per-hit `mocked` flag. The `/about` text says so explicitly. |
| `table()` escapes cells, so links can't go in it | New `tableHtml` for pre-escaped cells. Every value inserted into it goes through `esc`, and hrefs through `encodeURIComponent`. |
| snake_case vs camelCase DO rows | Use the `pick()` helper everywhere. Test fixtures use snake_case (the DO's actual shape). |
| List routes cap at `limit=100`, and repos have no org/spec filter | Filter in the UI and accept truncation for M6. Note it as a known gap in the PR rather than adding DO routes (spine). |
| Ledger is sparse/empty, so pages look bare | Empty states say "None yet". Changelog pads with labeled samples, and repo commits/tree are always mocked. |
| Extra DO round-trips per page (up to ~5) | Fetch in parallel with `Promise.all` (same as `dashboard`). It's a single DO and reads only, so this is acceptable. |
| Scope creep into real embeddings/Vectorize | Out of scope for M6. Mention it only as future work on `/about`. |

## Estimate

About **1 day** (MILESTONES.md budgets 1–2):
- Steps 1–2 (helpers + mock module + unit tests): 2–3 h
- Step 3 (five pages + dispatch): 3–4 h
- Steps 4–6 (dashboard links, UI tests, styling): 2–3 h
- Steps 7–9 (docs, `/about`, rebase, PR): about 1 h

Confidence the exit criteria are met within the estimate: 0.8. The main uncertainty is
rebase churn from the concurrent auth work.
