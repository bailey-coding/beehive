---
category: operations
status: active
audience: human,agent
---

# Deployment topology and ops (verified 2026-10-13)

## Deploy flow (decided 2026-10-15)

- GitHub `main` is a **source repo**. `.github/workflows/ci.yml` runs typecheck and unit tests on
  pull requests and on pushes to any branch. Nothing deploys from GitHub and CI holds no
  Cloudflare secrets.
- Production deploys happen from the **Cloudflare Artifacts repo**: once a change is on GitHub,
  the maintainer pulls it and pushes it to the Artifacts repo. This step is human-only; agents
  never push to that repo and never run `wrangler deploy`.
- The commands, run on the maintainer's host (stated 2026-10-16): `git pull origin main && git push cf main`.
  `origin` is the GitHub repo; `cf` is the Artifacts repo `default/beehive` in the maintainer's
  Cloudflare account. Never add a `cf` push to an agent's workflow.
- The deploy trigger is Cloudflare Workers' native Artifacts integration (stated 2026-10-16): the
  push to `cf` deploys, with no `npm run deploy:*` script run by hand.
- **There is no deploy-order control** (stated 2026-10-16): one push deploys all ten workers at once.
  You cannot deploy `beehive` alone first and check its migration before the others go out. The checklist
  below is written for that: secrets first, one push, a short window of mixed versions, then verification.
- TODO(maintainer): document where `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and
  `WORKERS_SUBDOMAIN` now live for deploys (the GitHub Actions secrets are no longer used).
- Queues: nothing creates them at deploy time any more. The maintainer confirmed on 2026-10-16
  that the four queues of the checklist's step 2 exist (created by hand).

### Deploy checklist (m3 -> m8 ledger migration and everything after it)

0. **Hard prerequisite: put the Spec DO internal tokens before deploying anything** (section
   "Spec DO internal tokens" below). The new Spec DO check fails closed: deploy `beehive` without
   `SPEC_DO_INTERNAL_TOKEN` and every DO route answers 503; deploy a caller without it and its DO
   calls answer 401. All ten deploy at once (no order control), so a caller still on old code answers
   401 on its DO calls (old code sends no header) until its own deploy lands: a short window.
   `wrangler secret put` on a worker that is already deployed takes effect on its next request, so
   put them on all workers (nine tier-1, one admin) first, then push.

The live Spec DO is on schema m3; the first `beehive` deploy runs m3 -> m8 on its next init.
A failed migration step now throws out of `init()` (every request fails, the next request
retries), so a bad deploy is loud rather than half-migrated.

1. Before deploying: confirm `schema_version` is `m3` on the live DO (a read-only
   `SELECT value FROM metadata WHERE key = 'schema_version'` through the maintainer's usual
   access; do not guess).
   Also list what is there, `SELECT type, name FROM sqlite_master ORDER BY type, name`, and
   compare it with `workers/spec-do/schema.sql`: the live ledger once carried a `service_accounts`
   table of another design (`docs/OPEN-QUESTIONS.md` 2026-10-16) that stopped the m6 step.
2. Confirm these queues exist, because nothing creates them any more (the old GitHub
   workflow did): `canary-rollback-triggers`, `promotion-events`,
   `preview-scientist-comparisons`, `beehive-scientist-comparisons`. Create any missing one
   by hand (`wrangler queues create <name>`).
3. Confirm `API_AUTH_TOKEN` is identical on every worker. Keep `WORKER_VERSIONS_MODE` (and
   `BEEHIVE_LOCAL_DEV`) unset in production.
4. Push: `git pull origin main && git push cf main` deploys all ten workers at once. The Spec DO
   migrates on its first init after `beehive` deploys, not at deploy time, so make one authenticated
   request that reaches the DO: `BEEHIVE_API_TOKEN=... ./scripts/prod-health.sh` (its last check is
   `GET /api/organizations?limit=1`). The edge `/health` also calls the DO and answers 503 `unhealthy` while
   the ledger cannot initialise, but only from the deploy that includes that change; the 2026-10-16 m3 -> m8
   deploy still had a static `/health` that passed with the ledger stuck, so keep the script's DO request. Then check the
   `beehive` logs for `Migration to m[4-8] failed`; any hit, or a 500 from the script, means the ledger
   stopped at the previous version and requests are failing until it is fixed.
   `service_accounts has an unexpected shape`: that table is not this design's; if it is empty,
   `DROP TABLE service_accounts` (the next request recreates it), otherwise migrate its rows first.
5. Expect a short window of mixed versions while the ten builds finish, and re-run anything that
   failed in it:
   - old caller -> new `beehive`: 401 on DO calls (old code sends no header).
   - new caller -> old `beehive`: the extra headers are ignored, but routes added since m3 answer 404
     (promotion ledger, deploy refs, service tokens) until `beehive` is deployed and migrated.
   - old `beehive-promotion-worker` -> new `beehive`: 409 `version_required` when it replaces an
     existing tournament or merge train (see "Promotion ledger concurrency").
   - new `beehive-canary-worker` -> old `beehive-preview-manager`: the canary route answers 404.
   - `beehive-shadow-router` falls back to its static config while the DO read fails.
   Migrations are additive and not undone by rolling a worker back, so old code would then run against
   the newer schema. For the Spec DO that fails: old code throws `Unknown schema_version` and every request errors
   (`runMigrations` in `workers/spec-do/index.ts`; `docs/OPEN-QUESTIONS.md` 2026-10-17). Rolling back across a schema bump is an outage.
   **Rollback floor (M12 push A):** from the commit that adds the tolerance (`runMigrations` skips migrations and
   logs a warning when `schema_version` is `m<N>` (1 to 6 digits, no leading zero) with N above its own newest; any other unknown value still throws), a
   rollback to that commit or later survives a later `m9`+ ledger. Record the floor commit here when it is deployed:
   `rollback floor: 8de5485` (all ten workers deployed 2026-10-18 09:17 UTC; the tolerance itself is `adb86bd`, and `8de5485` is the
   first push where `beehive-sandbox-runner` also redeployed: it had no `package-lock.json`, so `npm ci` failed in Workers Builds).
   Never deploy anything older once a later push has migrated.
   Invariant for every step above the floor: it must be additive and harmless to code that ignores it.
   - It never rebuilds, drops or deletes from a table the floor's code uses.
   - A new table may reference only tables the floor never hard-deletes from: today `actors`, and never a table in
     `ORG_PURGE_ORDER` (`workers/spec-do/index.ts`). A table with a foreign key to `organizations`, `repositories`,
     `specs`, `candidates` or `issues` makes the floor's `/internal/purge` stop with a 409 `FOREIGN KEY constraint failed`
     while rolled back. The batch rolls back and nothing is corrupted, but purge is unusable until the newer build returns.
   - New columns on old tables are nullable or have a default, so the floor's inserts still succeed.
   - No new CHECK, UNIQUE or trigger on an old table may reject a write the floor makes. M11's planned unique index on
     `actors.github_user_id` would turn a duplicate insert by the floor into a failed login (fail closed, acceptable).
6. After deploy: `./scripts/prod-health.sh` passes (`GET /health` answers 200 on each worker with the
   bearer token, and the Spec DO check answers 200);
   `GET /api/service-accounts` answers 410; mint a service token
   (`POST /api/admin/service-accounts`) and confirm a write with it answers 403; then grant the
   first maintainer deliberately with `POST /api/admin/actors/<id>/role {"role":"maintainer"}`
   (while none exists an actor may grant itself, so do this before anyone else can).
7. Read-only verification (changes nothing; an agent may run these with a read-only API token, and
   narrow the output, e.g. `| head -30` or `--json`, since results stay in its context):
   - `wrangler secret list --name <worker>`: the nine tier-1 workers hold `SPEC_DO_INTERNAL_TOKEN`,
     `beehive` also `SPEC_DO_ADMIN_TOKEN`, `beehive-sandbox-runner` neither (names only, no values).
   - `wrangler deployments list --name <worker>` (or `wrangler versions list`): each worker runs the
     commit you meant to deploy; `beehive-promotion-worker` must be the one deployed after `beehive`.
   - `wrangler queues list`: the four queues of step 2 exist.
   - `wrangler tail <worker> --format json` right after the first `beehive` request, to read
     `Migration to m[4-8] failed` or `service_accounts has an unexpected shape` directly.
   Never `wrangler deploy` and never write to the Artifacts repo (AGENTS.md).

Moved out of `AGENTS.md` (2026-10-15). The config rules and the fail-closed auth rule stay
in `AGENTS.md`; this file adds operational detail only.

Ten Workers on `*.bz23711.workers.dev`, deployed from the Cloudflare Artifacts repo
(see "Deploy flow" below; each worker has its own wrangler config and a `package.json` `deploy:*` script):

- `beehive` — edge router/API; hosts the `SpecDO` class (root `wrangler.toml`).
- `beehive-gate-workflow`, `beehive-sandbox-runner`, `beehive-queue-consumer` — configs
  at `workers/<dir>/wrangler.toml` (directories drop the `beehive-` prefix); the Spec DO is bound cross-script via
  `script_name = "beehive"`.
- M2/M3 workers: `beehive-shadow-router`, `beehive-scientist-comparator`,
  `beehive-preview-manager`, `beehive-candidate-service`, `beehive-canary-worker`,
  `beehive-promotion-worker`. Note the worker `name` in each `wrangler.toml` is the
  source of truth for URLs (older docs used shortened names).

**Web UI** (verified 2026-10-13): served by the `beehive` worker itself, not a separate
app. `/`, `/about` and `/roadmap` are public; `/login` -> GitHub OAuth -> `/app` (create orgs, repos, specs).
Code: `workers/api/ui.ts`, layout in `workers/api/ui-layout.ts` (M9). Every rendered `/app` GET page makes one extra
Spec DO read (`GET /api/organizations`, for the org switcher; shared with the page's own read when it lists orgs);
writes, refused writes and the cross-origin 403 add none. A failed read shows "Organizations unavailable" and never
fails the page. UI only: no schema or route change, so a rollback needs no cleanup. Access is limited to `ALLOWED_GITHUB_USERS` (var in root
`wrangler.toml`); secrets `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are set on `beehive`.
Sessions are HMAC-signed with `API_AUTH_TOKEN`. The React app in `ui/` is **not built or
deployed** (no build config); don't assume it is live.

### Spec DO internal tokens (two-tier, 2026-10-16)

Any worker holding the cross-script `SPEC_DO` binding can call the Spec DO directly, so the DO
checks tokens of its own (`workers/shared/spec-do-auth.ts`), independent of `API_AUTH_TOKEN`:

| Secret | Header | Required on | Held by |
|---|---|---|---|
| `SPEC_DO_INTERNAL_TOKEN` (tier 1) | `X-Beehive-Internal` | every DO route, including `/health` | `beehive` (DO host and caller) + the eight callers below |
| `SPEC_DO_ADMIN_TOKEN` (tier 2) | `X-Beehive-Admin` | privileged routes, in addition to tier 1 | `beehive` **only** |

Privileged routes (`isAdminRoute`): `POST /internal/tombstone`, `/internal/purge`,
`/internal/actors/:id/role`; every `/internal/service-accounts*` route (list, mint, revoke, token
mint/rotate/revoke); `PATCH /api/actors/:id/promotion-authority`. Not privileged:
`/internal/service-tokens/verify` (the edge's per-request token check), `/promotion-mode` (the
promotion worker writes it), and the rest.

Answers: DO's own secret unset -> **503** (also for an admin route when only the admin secret is
unset); missing or wrong tier-1 token -> **401**; valid tier-1 token without the admin token on a
privileged route -> **403**. Comparison is constant-time (length is the only thing it can leak);
token values are never logged or put in a response.

Distribution (the same tier-1 value on every worker; secrets are per worker):

- `beehive`: `SPEC_DO_INTERNAL_TOKEN` + `SPEC_DO_ADMIN_TOKEN`.
- Tier 1 only: `beehive-gate-workflow`, `beehive-queue-consumer`, `beehive-shadow-router`,
  `beehive-scientist-comparator`, `beehive-preview-manager`, `beehive-candidate-service`,
  `beehive-canary-worker`, `beehive-promotion-worker`.
- None: `beehive-sandbox-runner` (declares the binding, never calls the DO). Do not give it one.

```bash
# value: e.g. `openssl rand -hex 32`; use a different value for each of the two secrets
for w in beehive beehive-gate-workflow beehive-queue-consumer beehive-shadow-router \
         beehive-scientist-comparator beehive-preview-manager beehive-candidate-service \
         beehive-canary-worker beehive-promotion-worker; do
  wrangler secret put SPEC_DO_INTERNAL_TOKEN --name $w
done
wrangler secret put SPEC_DO_ADMIN_TOKEN --name beehive
```

Callers never set the headers by hand: `getSpecDoStub(env)` (`workers/shared/spec-do-auth.ts`)
attaches whatever tokens that worker's env holds, the admin token only on privileged routes.
Rotation: put the new tier-1 value on all nine workers; calls in between answer 401 and retry on
the next request, so do it in one sitting. Locally: `scripts/start-e2e-workers.sh` generates both
per run (`docs/SETUP.md`).

Auth: set the secret on each worker with `wrangler secret put API_AUTH_TOKEN --name <worker>`.
`beehive` itself enforces it in `workers/api/principal.ts` (same 503/401 behaviour, plus
service tokens); the others use `workers/shared/auth.ts`. `scripts/start-*.sh` read
`BEEHIVE_API_TOKEN` from `.env`, but e2e loads the tracked `.env.test.<env>` files with
`override: true`, and `.env.test.production` holds a placeholder token.

Deploy token scopes: Workers Scripts:Edit + Workers Queues:Edit. Permission edits take
minutes to propagate — a fresh 403 right after granting scopes is expected; wait and
retry before debugging.

### Ledger cleanup: tombstone, then purge

Live once the m4 -> m5 migration reaches `main` (the Spec DO migrates on its next init).
All calls need the master token plus `X-Actor-ID`; service tokens get 403 on every one.
Contract: `workers/shared/ledger-lifecycle.ts`; audit trail: `purge_log` table (never purged).

1. **Maintainer.** Purge and `?include_deleted=1` need an actor with `role='maintainer'`.
   The first maintainer grants the role to itself (allowed only while none exists); after
   that, only a maintainer can grant or revoke:
   `POST /api/admin/actors/<actorId>/role {"role":"maintainer"}` (or `{"role":null}`).
2. **Tombstone** (soft delete, any actor, reversible only by hand in SQL):
   `DELETE /api/{organizations|repositories|specs|candidates}/<id>` with optional
   `{"reason":"..."}`. Cascades down in one transaction (org -> repos, specs, their
   candidates and issues; repo -> candidates, issues; spec -> candidates). Tombstoned rows
   disappear from every list/get; maintainers see them with `?include_deleted=1`. Refused
   (409) while a candidate in scope has an active promotion or an in-flight promotion state.
3. **Purge** (hard delete, irreversible): `POST /api/admin/purge` with `{"orgNamePrefix":
   "test-org-e2e-"}` or `{"orgIds":[...]}`. Dry run by default; it returns `total`, per-table
   `counts` and `skipped` orgs (`not_tombstoned`, `too_recent`, `live_descendants`,
   `service_accounts`). Then repeat with `"dryRun":false,"confirm":<total>`; a confirm that does
   not match the current total is 409. Only orgs tombstoned at least `PURGE_MIN_AGE_HOURS`
   (default 24; `scripts/start-e2e-workers.sh` sets 0 locally) ago are purged, together with
   their dependent rows (comments, links, verdicts, trials, promotions), in batches of at most
   500 rows, one transaction each. Refused (409) if a target candidate has an active
   promotion. `entity_history` and `purge_log` survive.

### CLI actor attribution (stopgap until M12)

The CLI authenticates with the master token, whose actor is whatever `X-Actor-ID` the client sends. Set
`defaultActor` in the CLI config file or `BEEHIVE_ACTOR` in the environment to a real actor id in the ledger
(usually a maintainer); it is sent on every request, and `--actor <id>` on a create command overrides it
(precedence: flag, then env, then config; nothing is sent if none is set). This is attribution for admin
use, not authentication: any master-token holder can name any actor. With no actor set the edge records `'unknown'`, and
Spec DO issue writes by an unknown actor get 403 once the issue changes deploy; set one before using
`issue create`. `--actor` is on `gate run`, `org create` and `actor create/trust/grant-promotion` too. M12
(verified identity and user tokens) replaces it.

### Service tokens: mint, rotate, revoke

Live once the m5 -> m6 migration reaches the deploy flow (the Spec DO migrates on its next
init). Read-only tokens (`bh_svc_...`) for monitors and scripts: `GET` on `/health`,
`/api/whoami` and non-admin `/api/*`; every write, `/api/admin/*` and lifecycle route is 403.
All admin calls need the master token; send `X-Actor-ID: <your actor id>` so the mint/revoke
is attributed (without it, it is recorded as the reserved actor `master`; an unknown id is 400).

1. **Mint.** `POST /api/admin/service-accounts {"name":"monitor","expiresInDays":90}`
   (`name` `[a-z0-9-]`, unique for good, also after revocation; `scopes` may only be
   `["read"]`; `expiresInDays` 1-365, default 90). The response carries
   `data.token.plaintext` **exactly once** (`Cache-Control: no-store`). Store it in your
   secret manager straight away; only its SHA-256 hash is kept and it cannot be shown
   again. Each account gets its own actor (`svc:<name>`, type `agent`) and belongs to the
   reserved organization `beehive-system` (never purged while it holds accounts).
2. **List.** `GET /api/admin/service-accounts`: accounts with their tokens' `prefix`
   (first 12 chars), `expiresAt`, `revokedAt` and `lastUsedAt` (updated at most once a
   minute). Never plaintext or hashes. Check with `GET /api/whoami` using the token.
3. **Rotate** (no downtime). `POST /api/admin/service-accounts/<accountId>/tokens
   {"expiresInDays":90}` mints a second token for the same account (plaintext shown once).
   Switch the client over, then revoke the old one:
   `POST /api/admin/service-accounts/<accountId>/tokens/<tokenId>/revoke`.
4. **Revoke.** `POST /api/admin/service-accounts/<accountId>/revoke` deactivates the
   account and revokes all its tokens at once (401 on the next request; idempotent). A
   revoked account cannot get new tokens: mint a new account under a new name.

Expired tokens are 401. If the Spec DO cannot verify a token, the edge answers 503 (never
anonymous, never master). Accounts from before m6 (if any) have no actor and no token rows,
so they cannot authenticate: revoke them and mint new ones. The old `/api/service-accounts*`
routes are retired (410).

### Canary deploy and rollback (deploy refs)

Live once the m6 -> m7 migration reaches the deploy flow (the Spec DO migrates on its next
init; additive: `deploy_refs`, `canary_deployments`). Contract: `workers/shared/deploy-refs.ts`.

- **The pointer is the Spec DO `deploy_refs` chain per (spec, rung).** Deploying a canary
  appends a row whose `prev_ref_id` is the old head; rolling back appends a row pointing at the
  previous target (the empty ref if there was none). Rolling back twice toggles back. The
  shadow router reads the live canary heads on every mirrored request, so a rollback takes
  effect on the next request with no redeploy. History is never rewritten.
- **Manual rollback:** `POST https://beehive-canary-worker.../rollback` with
  `{"candidateId","specId","reason":"manual","timestamp","metrics":{}}`. Automatic triggers
  (`latency`, `error_rate`, `slo_violation`) are refused (409) for a canary whose switch is off:
  `POST /canary/<candidateId>/auto-rollback {"enabled":false}`.
- **Production canary deploys answer 501** until a real Workers Versions client exists:
  `WORKER_VERSIONS_MODE` is unset on `beehive-preview-manager`, and the stub (`stub`) is for
  local dev only: it also needs `BEEHIVE_LOCAL_DEV=1`, which only `scripts/start-e2e-workers.sh` sets,
  so a stray `WORKER_VERSIONS_MODE=stub` in production still answers 501. Keep both unset.
- **Deploy dependency:** `beehive-shadow-router` now binds `SpecDO` from `beehive` (`script_name`),
  like canary-worker and preview-manager. All ten deploy at once, so until `beehive` has deployed its
  DO reads fail and the router uses its static config.
- A candidate a live ref points at cannot be tombstoned or purged (409), like an active promotion.
- **Shadow-router caches the live pointers** (in-isolate, `LIVE_REFS_CACHE_TTL_MS`, default
  5000 ms, `0` disables, max 60000). A rollback (or promotion) reaches the router within one TTL;
  if the Spec DO read fails the last value is served for at most one more TTL (worst case 2 x TTL =
  10s by default), then the router falls back to the static config. Errors are never cached and
  concurrent requests share one read. Details: `docs/OPEN-QUESTIONS.md` "Shadow-router live-ref cache".

### Promotion ledger concurrency (m7 -> m8)

Live once the m7 -> m8 migration reaches the deploy flow (additive: `version` on `tournaments`
and `merge_trains`; `failure_reason`, `failed_at`, `attempts` on `tournaments`). Contract:
`workers/shared/ledger-state-machine.ts`. These routes are reached only through the Spec DO
binding (the promotion worker); no edge route exposes them.

- **Compare-and-swap.** Every write bumps the row's `version`. A `POST` over an existing id
  needs `X-Expected-Version` (the version last read) and answers 409 `version_conflict` (stale) or
  409 `version_required` (header missing); `PATCH` merges server-side and checks the header only
  when sent. The check and the write share one transaction. The promotion worker re-reads and
  re-applies up to 3 times (`modifyTournament` / `modifyMergeTrain`), then surfaces the conflict.
- **Tournament status machine** (409 `invalid_transition`): `pending -> in_progress` (needs 2
  competing candidates), `in_progress -> completed` (needs a winner from the candidates and
  `completedAt`) or `failed` (needs `failureReason`), `failed -> in_progress` (retry),
  `failed -> pending` (reset); `completed` is terminal. A new tournament starts `pending`.
- **Failures and retries.** A tournament that errors while `in_progress` is written `failed`
  with the reason (no winner determined, winner promotion rejected, Spec DO errors). Each entry
  into `failed` counts in `attempts`; after 3 the next retry answers 409 `retries_exhausted`.
  `failed -> pending` resets `attempts` to 0, so a stuck tournament is recovered by a
  `PATCH /tournament-status/<id> {"status":"pending"}` through the DO binding, by a human.
  A tournament left `in_progress` by a crashed worker is resumed by the next request.
- **Deploy window.** An old promotion worker replacing an existing tournament or train answers
  409 `version_required` until its own deploy lands; all ten deploy at once, so that is a short window
  (the request can be retried).
- Not covered: two requests creating a tournament for the same spec at the same moment still
  make two rows (ids are random); readers take the newest.

### Workers Builds watch paths (drafted 2026-10-17, not yet applied)

Goal: a docs-only push to `cf` should not rebuild all ten workers. Watch paths are a Workers Builds
setting (dashboard: worker -> Settings -> Builds). They are not in `wrangler.toml`, and the Cloudflare
Terraform provider (5.28.0) has no Workers Builds resource, so `scripts/builds-watch-paths.sh` PATCHes the
Builds API from `scripts/builds-watch-paths.json` (maintainer's host only; it changes production config).

- Dry run, then apply: `CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... ./scripts/builds-watch-paths.sh [--apply]`.
  The token must be user-scoped with Workers Builds edit access.
- Settings: include `*`, exclude `docs/*` and `*.md`. Exclude-only on purpose: every worker imports
  `workers/shared/`, and the docs do not say whether files outside a worker's root directory exist during
  its build, so per-worker include lists could leave a worker silently stale.
- Rules (Cloudflare docs): `*` is the only wildcard; excludes are checked first; a push with 20+ commits or
  3000+ changed files always builds.
- Unverified: whether watch paths apply to the Artifacts trigger. Check on one worker first: apply, push a
  docs-only commit to `cf`, and see whether `wrangler deployments list` shows a new deployment. If one
  appears, record it in `docs/OPEN-QUESTIONS.md`; do not work around it.
- Mixed-version window: workers can now sit at different versions for longer, so changes must stay additive.
- Upstream: if the Terraform provider gains a Workers Builds resource, replace the script with it.
- GitHub CI has the same filter: `ci.yml` and `ci-enhanced.yml` skip pushes and PRs that touch only `docs/**`
  or `*.md` (`.github/workflows/README.md`). A docs-only push to `main` therefore shows no Actions run.

### Last resort: wipe the whole ledger

**Destructive and irreversible; human approval required.** Prefer tombstone + purge above.
This deletes every ledger row and the `beehive` worker secrets. To wipe it (done 2026-10-13 to clear 27 `test-org-e2e-*` orgs left by E2E runs against
production; the maintainer cleared them in the Cloudflare dashboard, which also works): `wrangler delete --name beehive --force`, then redeploy `beehive` through the maintainer's normal deploy flow (see "Deploy flow"), then re-put
the secrets that live on `beehive`: `API_AUTH_TOKEN`, `SPEC_DO_INTERNAL_TOKEN`, `SPEC_DO_ADMIN_TOKEN`, `CLOUDFLARE_API_TOKEN`,
`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`. Other workers keep their own secrets. A `1042`
response means the worker is not deployed yet.
The `KV namespaces ... Authentication error` printed by `wrangler delete` is harmless.

Symptom lookup for deploy and auth failures: `docs/TROUBLESHOOTING.md`. First-time setup and
self-hosting: `docs/SETUP.md`. See `docs/OPEN-QUESTIONS.md` for dated findings (Artifacts behavior, wrangler config
gotchas, deploy learnings).
