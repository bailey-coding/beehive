# Feature parity: API vs CLI vs web UI

Audit date 2026-10-16, branch `agent/feature-parity-audit`. Static read of route tables and
command registrations only. Nothing was run, deployed or called (no e2e, no wrangler, no prod).

Surfaces counted:
- **API**: the `beehive` worker edge (`workers/api/index.ts`, `lifecycle.ts`, `service-accounts.ts`),
  which forwards to the Spec DO (`workers/spec-do/index.ts`). Bearer auth, `workers/api/principal.ts`.
- **CLI**: `cli/src/commands/*.ts`, HTTP via `cli/src/utils/api-client.ts`.
- **UI**: the server-rendered `/app/*` pages in the `beehive` worker (`workers/api/ui.ts`,
  `ui-pages.ts`). Own GitHub-OAuth session, not the bearer token (`ui.ts:80-130`). `ui/` (React) is
  not built or deployed (AGENTS.md) and is not counted.

Legend: **yes** = works end to end per the code; **partial** = some operations or broken in a
named way; **no** = absent. "Read-only" for UI means list/detail pages only.

## 1. Matrix

| Capability | API | CLI | UI |
|---|---|---|---|
| Organizations | **yes**: POST/GET `/api/organizations`, GET `:id` (`api/index.ts:123-131`) | **yes**: `org create/list/get` (`org.ts:107-124`) | **yes**: create form `ui.ts:346`, detail `orgPage` (`ui-pages.ts:188`) |
| Actors | **yes**: POST/GET, GET `:id`, PATCH `trust`, PATCH `promotion-authority` (`index.ts:137-150`) | **yes**: `actor create/list/get/trust/grant-promotion` (`actor.ts:160-190`) | **no**: only an existence check on the session actor (`ui.ts:108`); no actor page, no create |
| Repositories | **yes**: POST/GET, GET `:id` (`index.ts:157-165`) | **partial**: `repo list/get` work; `repo create` prints "not fully implemented" (`repo.ts:19`) | **yes**: create form `ui.ts:347`, page `repoPage` (`ui-pages.ts:333`), hierarchical URLs (`ui.ts:120`) |
| Issues | **yes**: POST/GET, GET `:id`, PATCH `stage`, PATCH `comment-policy` (`index.ts:264-279`) | **partial**: `issue list/get`; `issue create` stub (`issue.ts:21`); no stage or policy | **partial**: create (`ui.ts:351`) and detail (`issuePage`, `ui-pages.ts:1313`); no stage or policy change |
| Issue comments | **yes**: POST/GET `/api/issues/:id/comments` (`index.ts:284-292`) | **no**: no client method, no command | **partial, likely broken**: calls `/api/issue_comments` (`ui.ts:759`, `ui-pages.ts:1327`); the DO has no such route (see §3.1) |
| Issue links (spec/candidate) | **yes**: POST `/api/issue-spec-links`, `/api/issue-candidate-links` (`index.ts:295-300`); no GET | **no** | **no** |
| Specs | **yes**: POST/GET, GET `:id`, PATCH `stage`, POST `claim` (`index.ts:171-185`) | **partial**: `spec list/get/claim`; `spec create` stub (`spec.ts:20`); client has `updateSpecStage` but no command | **partial**: create (`ui.ts:348`) and detail (`specPage`, `ui-pages.ts:630`); no claim, no stage change |
| Candidates | **yes**: POST/GET, GET `:id`, PATCH `stage`, POST `execute` (`index.ts:191-203`, `328`) | **partial**: `candidate create/list/get/gate-verdicts`; `create` cannot receive its flags (see §3.2); `executeCandidate` in client has no command | **partial**: read-only `candidatePage` (`ui-pages.ts:826`) |
| Candidate preview PUT | **no** at the edge; only in the DO (`spec-do/index.ts:3301`) and `candidate-service` | **no** | **no** |
| Gate verdicts | **yes**: POST/GET `/api/gate-verdicts`, GET `:id`, GET `candidates/:id/gate-verdicts`, POST `candidates/:id/gate/pre-merge` (`index.ts:208-231`) | **partial**: `gate run` (pre-merge only), `gate list/get`, `candidate gate-verdicts`; no manual verdict create | **partial**: verdict table on the candidate page (`ui-pages.ts:843,959`); no run, no list page |
| Trials | **yes**: POST/GET, GET `:id`, POST `decide` (`index.ts:236-250`) | **partial**: `trial list/get`; `create` stub (`trial.ts:20`); `decide` sends the wrong body (see §3.2) | **partial**: read-only `trialPage` (`ui-pages.ts:999`) |
| Promotions | **yes**: POST/GET `/api/promotions` (`index.ts:253-258`); no GET `:id` at the edge | **partial**: `promotion create/list/get`; `get` calls `/api/promotions/:id`, which has no edge route; `create` sends the wrong body (see §3.2) | **partial**: promotions shown on candidate, trial, spec, repo pages; no create |
| Promotion ledger (promotion-states, tournament-status, merge-train-status) | **no** at the edge. DO routes `LEDGER_ROUTE` (`spec-do/index.ts:63,3007`) reached only by the promotion worker over its binding | **no** (`debug verify-train` composes specs/candidates/promotions, not the ledger: `debug.ts:265-267`) | **no** |
| Promotion actions (promote, retry, cancel, mode, tournament, merge train) | **no** at the beehive edge. Exist only on `promotion-worker` (`/promote*`, `/mode`, `/tournament*`, `/merge-train*`, `/merge/retry`: `promotion-worker/index.ts:67-224`) | **no** | **no** |
| Deploy refs / canary / rollback | **no** at the beehive edge. DO `DEPLOY_ROUTE` (`shared/deploy-refs.ts:119`) used by canary-worker and shadow-router. canary-worker: `/deploy-canary`, `/rollback`, `/slo-status`, `/canary-deployments*` (`canary-worker/index.ts:47-84`). preview-manager: `/api/preview/deploy`, `/api/preview/canary` (`preview-manager/index.ts:68,74`) | **no**. `workflow`, `deployment`, `environment` are registered from `ENTITIES` (`cli/src/index.ts:226-241`) but are dead (see §3.3) | **no** |
| Shadow router config (Statsig) | **no** at the edge; on shadow-router `/statsig/*` (`shadow-router/index.ts:509-593`) | **no** | **no** |
| Entity history | **yes**: GET `/api/entities/:type/:id/history` (`index.ts:319`) | **yes**: `history get <type> <id>` (`history.ts:63-72`) | **no** (changelog is built client-side from entity rows: `ui-pages.ts:234`, not from this route) |
| Service accounts and tokens | **yes**, master only: `/api/admin/service-accounts` POST/GET, `:id/revoke`, `:id/tokens`, `:id/tokens/:tid/revoke` (`service-accounts.ts:80-180`); `GET /api/whoami` (`service-accounts.ts:66`). `/api/service-accounts*` returns 410 (`index.ts:308`) | **no** (`auth login/status/test/logout/show-token` manage the local bearer only: `auth.ts:155-181`) | **no** |
| Ledger lifecycle: tombstone (DELETE org/repo/spec/candidate) | **yes**: `lifecycle.ts:68`, `TOMBSTONE_ROUTE` (`shared/ledger-lifecycle.ts:118`) | **no** | **no** |
| Ledger lifecycle: purge | **yes**: POST `/api/admin/purge` (`lifecycle.ts:69`) | **no** | **no** |
| Maintainer role | **yes**: `/api/admin/actors/:id/role` (`lifecycle.ts:28,70`) | **no** | **no** |
| `?include_deleted=1` reads | **yes** (`lifecycle.ts:71`, DO check `spec-do/index.ts:3023`) | **no** | **no** |
| Health | **partial**: `/health`, `/api/health` return a static OK without calling the DO (`index.ts:115,1357`) | **partial**: `health check/extended/version/workers` (`health.ts:105-125`); `extended` hits a wrong path (§3.3); `workers` only re-checks the API (`health.ts:73-87`) | **no** |
| Auth entry | bearer: master token or `bhs_`-prefixed service token (`principal.ts`) | local token store (`auth.ts`) | GitHub OAuth, cookie session (`ui.ts:92-130`) |

Per-worker health routes exist on all ten workers; none is reachable through the CLI or UI.

## 2. Gaps, ranked

### 2.1 Deliberately absent (keep that way)

1. **Purge, tombstone, maintainer role, `include_deleted` on CLI and UI.** Destructive; AGENTS.md
   and `docs/OPS.md` make ledger wipe a maintainer-only operation, and the last-resort path is
   human-only. Keep API-only. If a CLI surface is ever added it should be a separate
   `admin` group requiring the master token and a confirm flag, not part of the daily commands.
2. **Service-account and token minting on the UI.** The UI session is a GitHub login, not the master
   token; `authorize()` restricts `/api/admin/*` to master (`principal.ts:103`). A UI form would
   need a different trust model. API-only is correct.
3. **Deploy, rollback, promote on any surface other than the pipeline.** Promotion decisions are
   serialized in the spec DO and executed by the promotion/canary workers (oracle ladder in
   AGENTS.md). A CLI "promote" that bypasses the train would contradict the thesis. Rollback is the
   one exception worth a CLI wrapper (see 2.2 #6), calling the canary worker, not the DO.
4. **Edge exposure of the ledger and deploy-ref routes.** These are worker-to-worker over bindings by
   design; exposing them through the beehive edge widens the read surface for service tokens
   (`authorize()` allows any `GET /api/*` for the read scope).
5. **Production deploy and the `ui/` React app.** Human-only (AGENTS.md); not counted.

### 2.2 Missing and worth building (by impact)

1. **UI issue comments are probably broken, and the failure is silent.** The UI uses
   `/api/issue_comments`; the DO routes only `/api/issues/:id/comments` (`spec-do/index.ts:3514,3528`),
   and the edge route table has no `issue_comments`. List returns `[]` on any failure
   (`ui.ts:60-65`), so the page shows "no comments". Posting returns "Not found" via
   `back('error', ...)`. Highest value because it is a visible feature that fails quietly.
   Not run, so unconfirmed at runtime; the route absence is confirmed by grep.
2. **CLI create paths that cannot work.** `repo create`, `spec create`, `issue create`, `trial create`
   are stubs. `candidate create` reads flags that are never registered (§3.2), so it exits with a
   commander error. The only working CLI create commands are `org`, `actor`. The CLI cannot create
   anything in the spec to candidate chain, which is the core workflow.
3. **CLI promotion create and trial decide send wrong bodies** (§3.2). They will be rejected or
   mis-recorded. Small, mechanical fix.
4. **No CLI or UI for issue comments, links, stage changes and comment policy**, spec and candidate
   stage changes, and candidate execute. All have API routes and some have client methods
   (`api-client.ts:331,374,390`) with no command.
5. **No read access to ledger, canary and deploy-ref state outside workers.** The oracle ladder's
   Canary and Full rungs are invisible to humans: no CLI, no UI, no edge route. A read-only edge
   proxy (GET only, not POST) or a UI page reading deploy refs would give operators a view without
   adding write paths. Needs a design decision, since it widens the read scope (2.1 #4).
6. **Rollback has no operator command.** AGENTS.md rule 7 says rollback is a cheap ref operation;
   only `POST canary-worker /rollback` does it, with no CLI wrapper.
7. **Service-account admin has no CLI.** Operators mint tokens with raw curl. A `service-account`
   command group on the master token is low risk and matches how tokens are used.
8. **UI has no actor page, no health page, no history view.** Lower impact.
9. **Health is weak on every surface**: edge `/health` never calls the DO (`index.ts:1357`,
   `docs/OPS.md:60`); CLI `health workers` does not check other workers; `scripts/prod-health.sh`
   is the only real check.

## 3. Inconsistencies

### 3.1 UI calls a route that does not exist
- `ui.ts:759` and `ui-pages.ts:1327` use `/api/issue_comments`. Real route:
  `/api/issues/:id/comments` (`index.ts:284-292`, `spec-do/index.ts:3514`). Likely cause: the
  table name `issue_comments` (`spec-do/index.ts:88,4049`) was used as a path.

### 3.2 CLI request shapes disagree with the API
- `promotion create`: CLI sends `{candidateId, notes}` (`promotion.ts:19`; type `cli/src/types/api.ts:250`).
  API requires `fromRung` and `toRung` (`workers/api/types.ts:499-504`; DO uses them, `spec-do/index.ts:3424`).
- `trial decide`: CLI sends `{winner, notes}` (`trial.ts:41`; `cli/src/types/api.ts:241`). API expects
  `{winnerId, comparisonMetrics, decidedBy?}` (`workers/api/types.ts:446`; DO `index.ts:3408`).
- `promotion get <id>`: CLI calls `GET /api/promotions/:id` (`api-client.ts:518`); the edge has only
  list and create (`index.ts:253-258`), and the DO has the same two routes (`spec-do/index.ts:3420,3434`).
  Result is a 404.
- Flags never registered: `candidate create` reads `--spec --repository --commit --base-commit --agent`
  (`candidate.ts:15`), `gate run` reads `--gate`, `promotion create` reads `--notes`, `trial decide`
  reads `--notes`, `spec claim` reads `--actor`/`--dry-run`, `repo create` reads `--remote-url`,
  `--namespace`. None has a `.option(...)` call (grep of `cli/src/commands`: options exist only in
  `actor.ts`, `org.ts`, `auth.ts`, `debug.ts`, `health.ts`). Commander rejects unknown options by
  default and I found no `allowUnknownOption`. Not run, so confirm before relying on it.
- `gate run` ignores `gateType` after computing it (`gate.ts:20-21`): always pre-merge.
- Field casing: the CLI types use camelCase (`organizationId`); the DO stores snake_case and the UI
  uses a `pick(row, 'snake', 'camel')` helper (`ui-pages.ts:861`) to cope. I did not diff every
  response field; this is a pattern, not a verified list.

### 3.3 CLI calls retired or missing routes
- `health extended` calls `/api/health` through a base URL that already ends in `/api`
  (`api-client.ts:76-78,181`), so it requests `/api/api/health`: 404.
- `workflow`, `deployment`, `environment` command groups are generated from `ENTITIES`
  (`cli/src/index.ts:232-241`, `definitions.ts:424-480`). The generator invokes `client.listWorkflows`
  etc. (`command-factory.ts:68`), but `api-client.ts` defines no such methods, and the edge has no
  such routes. These groups would fail with "not a function".
- `debug state-dump`, `debug` queue and artifacts helpers use `/api/debug/*` (`api-client.ts:579-607`).
  The beehive edge has no `/api/debug` route (checked `index.ts`, `lifecycle.ts`,
  `service-accounts.ts`), so they 404. I did not trace whether each `debug` subcommand actually calls
  those client methods; the grep of `commands/*.ts` for those method names returned nothing, so they
  are probably unused.
- No CLI or UI reference to `/api/service-accounts` (retired, 410) was found: grep for
  `service-account` in `cli/src` and `workers/api/ui*.ts` came back empty. The stale-route risk is in
  docs and external scripts, which I did not search.

### 3.4 Auth handling
- API: bearer, fail-closed on every route including `/health` (`principal.ts`, `AGENTS.md`). Service
  tokens: read scope only, `GET /api/*` except `/api/admin/*` (`principal.ts:100-104`), and the edge
  rewrites `X-Actor-ID` for them (`index.ts:99-107`).
- UI: separate GitHub session; calls the DO directly with `session.actorId`, so UI writes bypass
  `authorize()` and the service-token rewrite. Intended, but note UI users get create rights that a
  service token never has.
- CLI: sends `X-Actor-ID` from `config.defaultActor` or `--actor`; with the master token the edge
  trusts it (`service-accounts.ts:15`). The UI cannot choose an actor.
- Edge `/health` is public-looking but 401s without the bearer (`index.ts:115` sits after the auth
  block at `:88`); the workers' own `/health` behaviour differs (`shared/auth.ts`, not read in full).

### 3.5 Error shapes
- Edge and lifecycle: `{success:false, error, timestamp}` (`index.ts:342`, `lifecycle.ts:38`). The CLI
  reads `data.error || data.message` (`api-client.ts:106`), which matches.
- UI: HTML pages with `back('error', msg)` flashes (`ui.ts:759`); `doReader` turns any non-success into
  `null` or `[]` (`ui.ts:48-65`), so a 404/500 and "no data" look the same. AGENTS.md
  ("check `Response.ok`... a 404 is an error, never empty") is violated here.
- Other workers use their own shapes; not compared.

## 4. Recommended order of work

Each bullet is one builder task. None touches the spine (spec schema, DO ledger, promotion train).

1. **Fix UI issue comments route.** Change `/api/issue_comments` to `/api/issues/:id/comments`
   (POST and list). Files: `workers/api/ui.ts:759`, `workers/api/ui-pages.ts:1327`; add a test in
   `workers/api/tests/`. Verify against the DO test harness, not prod.
2. **Make `doReader` surface errors.** Return an error flag so pages show "could not load" instead of
   empty. Files: `workers/api/ui.ts:46-68` and the call sites in `ui-pages.ts`.
3. **Fix CLI request bodies and path.** `promotion create` (add `--from-rung`/`--to-rung`),
   `trial decide` (`winnerId`, `comparisonMetrics`), drop or implement `promotion get`, fix
   `health extended` path. Files: `cli/src/commands/promotion.ts`, `trial.ts`, `health.ts`,
   `cli/src/utils/api-client.ts`, `cli/src/types/api.ts`.
4. **Register the missing CLI options and implement the create stubs.** `candidate create`,
   `repo create`, `spec create`, `issue create`, `trial create`, `gate run`, `spec claim`. Files:
   `cli/src/commands/{candidate,repo,spec,issue,trial,gate}.ts`. Add a CLI smoke test that parses each
   command with its flags.
5. **Remove or wire the dead CLI groups.** Delete `workflow`, `deployment`, `environment` from
   `ENTITIES`/`registerGeneratedCommands` and the `/api/debug/*` client methods, or add the routes.
   Recommend deleting. Files: `cli/src/index.ts:226-241`, `cli/src/types/definitions.ts:421-500`,
   `cli/src/utils/command-factory.ts`, `cli/src/utils/api-client.ts:575-607`.
6. **Add CLI commands for existing API routes.** `issue comment add/list`, `issue stage`,
   `issue comment-policy`, `spec stage`, `candidate stage`, `candidate execute`, `link spec/candidate`,
   `gate create`. Files: `cli/src/commands/*.ts`, `api-client.ts`.
7. **Add a `service-account` CLI group** (master token): create, list, revoke, mint-token,
   revoke-token, plus `whoami`. Files: new `cli/src/commands/service-account.ts`, `cli/src/index.ts`,
   `api-client.ts`. Calls only `/api/admin/service-accounts*` and `/api/whoami`.
8. **UI quality of life**: actor page, spec claim and stage buttons, health page. Files:
   `workers/api/ui.ts`, `ui-pages.ts`. Lowest priority.
9. **Needs a maintainer decision before building**: a read-only view of promotion ledger and
   canary/deploy-ref state (edge GET proxy or UI page), and a `rollback` CLI wrapper (2.2 #5 and #6).
   Do not start without sign-off because it widens the read scope or touches the canary worker.

## 5. What I could not verify

- Nothing was executed. Every "broken" claim (UI comments, CLI flags, `health extended`, dead
  groups) is from reading code, not from a run. The route absences were checked by grep over the edge
  and DO route tables.
- The DO's final fallthrough for an unknown path (`spec-do/index.ts:3745`) is a JSON 404; I did not read
  the surrounding code to confirm what `callDo` returns for it.
- Whether a deployed commander instance would reject the unregistered flags, since I did not run
  `cli/bin/beehive`.
- The CLI `history <type> <id>` shortcut (`history.ts:71`) registers a command named
  `<entity-type> <entity-id>`; I could not tell how commander treats it.
- Response field-level differences between CLI types and API payloads beyond the examples above.
- Per-worker auth behaviour on other workers (`shared/auth.ts`), shadow-router `/statsig/*` auth, and
  whether those workers are publicly routable (depends on deploy config, `docs/OPS.md`).
- Whether any docs or scripts outside `cli/` and `workers/api/ui*.ts` still reference the retired
  `/api/service-accounts`.
- `docs/MILESTONES.md` states the semantic UI is mocked (M6); I did not audit `ui-semantic.ts` content
  against any real data source.
