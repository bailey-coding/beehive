---
category: operations
status: active
audience: human,agent
---

# Deployment topology and ops (verified 2026-10-13)

## Deploy flow (decided 2026-10-15)

- GitHub `main` is a **source repo**. `.github/workflows/ci.yml` runs clean installs and dry-run builds, typecheck and tests on
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
  `WORKERS_SUBDOMAIN` now live for deploys (the GitHub Actions secrets are no longer used; the push
  to `cf` needs no `npm run deploy:*` script, above). Not confirmed by the maintainer, so not stated here.
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
   **1a. m12 duplicate check (required, run immediately before the push).** m12 adds a partial UNIQUE index on
   `actors.github_user_id` (rows where it is neither NULL nor `''`). If two actors share a `github_user_id`, the m12 step
   **refuses** with `DuplicateGithubIdentityError` (it names the duplicated values and actor ids; it never skips,
   deletes or merges), `init()` rethrows, the ledger stays at `m11`, and **every request to the Spec DO fails until a
   human resolves the duplicate: a full outage, not a warning.** So the result of this check must be empty right before
   you push, not an hour earlier: a login can create an actor in the gap (the 2026-10-17 result predates UI logins).
   Read-only, through the maintainer's usual access to the ledger (the exact query used 2026-10-26, which found 0
   duplicates among 3 actors):

   ```sql
   SELECT github_user_id, COUNT(*) AS n, GROUP_CONCAT(id) AS actor_ids FROM actors WHERE github_user_id IS NOT NULL AND github_user_id != '' GROUP BY github_user_id HAVING n > 1;
   ```

   The API way (what 2026-10-26 used): page `GET /api/actors?limit=500&offset=<n>` with the master token until a page
   comes back short, and group the rows by `github_user_id` client-side, ignoring NULL and `''`.
   `scripts/check-actor-duplicates.sh` does exactly that (read-only, prints only duplicate groups, exits 1 if there are any).
   Empty result: push. Any row: do not push; decide per group which actor keeps the identity, and clear
   `github_user_id` on the others (maintainer decision, by hand; check `user_tokens`, `service_accounts.actor_id`, `role`
   and `promotion_authority` on each first). If the push already happened and the DO answers 5xx with
   `DuplicateGithubIdentityError` in the `beehive` logs, resolve the named actors the same way; the next request retries
   the migration and succeeds (nothing was half-applied). Or push the previous commit to `cf` (the ledger is still at `m11`, which the
   rollback floor tolerates, see below).
2. Confirm these queues exist, because nothing creates them any more (the old GitHub
   workflow did): `canary-rollback-triggers`, `promotion-events`,
   `preview-scientist-comparisons`, `beehive-scientist-comparisons`. Create any missing one
   by hand (`wrangler queues create <name>`).
3. Confirm `API_AUTH_TOKEN` is identical on every worker. `workers/preview-manager/wrangler.toml` sets
   `WORKER_VERSIONS_MODE = "api"` (enabled 2026-10-25); keep `BEEHIVE_LOCAL_DEV` and any `stub` mode unset in production.
4. Push: `git pull origin main && git push cf main` deploys all ten workers at once. The Spec DO
   migrates on its first init after `beehive` deploys, not at deploy time, so make one authenticated
   request that reaches the DO: `BEEHIVE_API_TOKEN=... ./scripts/prod-health.sh` (its last check is
   `GET /api/organizations?limit=1`). The edge `/health` also calls the DO and answers 503 `unhealthy` while
   the ledger cannot initialise, but only from the deploy that includes that change; the 2026-10-16 m3 -> m8
   deploy still had a static `/health` that passed with the ledger stuck, so keep the script's DO request. Then check the
   `beehive` logs for `Migration to m[0-9]+ failed` (m12: also `DuplicateGithubIdentityError`, step 1a); any hit, or a 500 from the script, means the ledger
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
   **Rolling back when all ten deploy at once:** there is no partial deploy; push the earlier commit to `cf` and every worker
   returns to it together. Never push a commit older than the rollback floor below.
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
     First example of the rule followed (m13, 2026-10-28): `gate_runs.candidate_id` is a **logical** reference with no foreign key
     (only `decided_by` references `actors`). The floor's purge does not know the table, so it deletes the candidates and leaves
     their runs as orphans; the next purge by an m13+ build sweeps every `gate_runs` row whose candidate no longer exists (only when
     that purge selects at least one organization), so the orphans do not stay forever. The routes still refuse an unknown or
     tombstoned candidate; only the database constraint is absent.
     Second example (m14, 2026-11-01, `docs/M5A-2-GOVERNANCE-PLAN.md` PR-A): `change_classifications`, `near_misses`, `intent_provenance`
     (`origin_actor_id`, nullable, references `actors`), `approvals` (`approver_actor_id` references `actors`) and `governance_events`
     hold candidate, spec, issue and trial ids as logical references. The tables have no writers until PR-B and later, so they are empty
     after the m14 deploy; the orphan sweep for them arrives with the PR that first writes rows (PR-B).
   - New columns on old tables are nullable or have a default, so the floor's inserts still succeed.
   - No new CHECK, UNIQUE or trigger on an old table may reject a write the floor makes. The one exception is the
     m12 partial unique index on `actors.github_user_id` (decided 2026-10-27): the floor's `createActor` has no duplicate
     check, so a duplicate insert by the floor hits the index and answers 500 (a raw `UNIQUE constraint failed`, not the
     409 of the current code). The only caller that does that is the UI login (`ensureActor`, lookup then create), and
     it fails closed: the login page says it could not create the actor record, no session is issued, nothing is
     corrupted. A rolled-back floor therefore cannot create a second actor for one GitHub identity; accepted.
6. After deploy: `./scripts/prod-health.sh` passes (`GET /health` answers 200 on each worker with the
   bearer token, and the Spec DO check answers 200);
   `GET /api/service-accounts` answers 410; mint a service token
   (`POST /api/admin/service-accounts`) and confirm a write with it answers 403; then grant the
   first maintainer deliberately with `POST /api/admin/actors/<id>/role {"role":"maintainer"}`
   (while none exists an actor may grant itself, so do this before anyone else can).
7. Read-only verification (changes nothing; an agent may run these with a read-only API token, and
   narrow the output, e.g. `| head -30` or `--json`, since results stay in its context):
   - `wrangler secret list --name <worker>`: the nine tier-1 workers hold `SPEC_DO_INTERNAL_TOKEN`,
     `beehive` also `SPEC_DO_ADMIN_TOKEN`, `beehive-sandbox-runner` neither but holds `CLOUDFLARE_API_TOKEN` (Artifacts read-token minting for builds; names only, no values).
   - `wrangler deployments list --name <worker>` (or `wrangler versions list`): each worker runs the
     commit you meant to deploy; `beehive-promotion-worker` must be the one deployed after `beehive`.
   - `wrangler queues list`: the four queues of step 2 exist.
   - `wrangler tail <worker> --format json` right after the first `beehive` request, to read
     `Migration to m[0-9]+ failed` (m12: also `DuplicateGithubIdentityError`, step 1a) or `service_accounts has an unexpected shape` directly.
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
fails the page. UI only: no schema or route change, so a rollback needs no cleanup. Members are `ALLOWED_GITHUB_USERS` (var in root
`wrangler.toml`); with `OPEN_VIEWER_SIGNIN = "true"` (same file, off while unset) any other GitHub user signs in read-only:
no actor row, GET/HEAD only, no token pages, no `internal` issues, 60 requests per minute per login via the
`VIEWER_RATE_LIMITER` binding (429 over it; viewers get a 503 if the binding is missing) (`docs/plans/viewer-signin-plan.md`); secrets `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are set on `beehive`.
Sessions are HMAC-signed with `API_AUTH_TOKEN` and carry their sign-in time (`iat`, M12; older cookies
lack it and must sign in again before minting an API token at `/app/settings/tokens`). The React app in `ui/` is **not built or
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
mint/rotate/revoke); every `/internal/user-tokens*` route except verify (M12: mint, list, revoke,
revoke-all); `PATCH /api/actors/:id/promotion-authority`. Not privileged:
`/internal/service-tokens/verify` and `/internal/user-tokens/verify` (the edge's per-request token
checks), `/promotion-mode` (the promotion worker writes it), and the rest.

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
   **Actor ids are UUIDs.** `X-Actor-ID` takes the id, not the name: `bailey-coding` is a name, so using it as the header answers 403. Read ids from
   `GET /api/actors`. A dedicated `beehive-system` actor (type `agent`, role `maintainer`, created 2026-10-26 by the maintainer) exists for ledger operations such
   as purges, so they need not run under a person's identity; it works only on the master-token path, since user tokens are for human actors with a GitHub identity.
   Actors cannot be tombstoned or purged.
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
   **Candidate Workers:** a real run (not the dry run) first plans with a dry run, then deletes the Worker `beehive-candidate-<uuid>` of every
   candidate in the plan through the `PREVIEW_MANAGER` service binding (`DELETE /api/preview/canary/:id`, `workers/api/purge-cleanup.ts`), and
   only then purges. A failed delete (a live canary: 409, or any error: 502) aborts the call with nothing purged; repeat it after fixing the cause
   (roll the canary back first). More than 40 candidate Workers in one purge is refused (409): narrow the selector. The response carries
   `workerCleanup` (`done` with `deleted`/`absent`) and `workersNotDeleted` for candidates tombstoned between the plan and the purge whose Worker
   could not be deleted. Deploy note: the `PREVIEW_MANAGER` binding needs `beehive-preview-manager` to exist (it does in production); a preview
   manager older than the DELETE route answers 404, which aborts a real purge with 502 until it is deployed. `confirm` is checked against the
   plan before any Worker is deleted; a candidate that gains an active promotion between the plan and the purge can still lose its Worker (small window).
   **No bypass:** a purge that has candidates is refused (503 without the `PREVIEW_MANAGER` or `API_AUTH_TOKEN` binding; 502 when the preview
   manager answers 501 because the Versions client is unavailable, or answers anything but `{success:true,deleted:boolean}` with a 2xx) and
   nothing is purged; fix the cause and repeat. A purge with no candidates needs neither. An older Spec DO that rejects `withCandidateIds`
   (reachable only in the mixed-version deploy window) is refused too, with 503: repeat after the deploy has settled.

### CLI actor attribution

**User token (supported path).** Mint a `bh_usr_` token at `/app/settings/tokens` (see "User tokens" below) and give it
to the CLI with `printf %s "$TOKEN" | beehive auth login --token-stdin`. `login` calls `GET /api/whoami` with that token
**before** writing anything: a 401 or an unreachable edge exits 1 and leaves the config file (and any previously saved
good token) untouched; only a verified token is saved. `--token <t>` still works but puts the token in argv (visible to
other local users and shell history), so the CLI says so on stderr. `beehive auth whoami` shows kind, actor, scope
(`read`, `read_write`, `maintainer`), the 12-character token prefix at most, the API URL and where the token came from
(flag, env or config). With a user token the edge overwrites `X-Actor-ID` with the token's actor, so the CLI sends none;
`--actor`, `BEEHIVE_ACTOR` and `defaultActor` are ignored with one stderr warning per run (not an error, so scripts that
export `BEEHIVE_ACTOR` for master use keep working). Routes that are master-only for user tokens answer 403, and the CLI
adds a hint; a 401 hint covers a revoked or expired token or an edge that predates user tokens; a 503 means the auth
backend is unavailable (mid-deploy); the CLI does not retry.

**Master token (admin/bootstrap).** The master token's actor is whatever `X-Actor-ID` the client sends. Set
`defaultActor` in the CLI config file or `BEEHIVE_ACTOR` in the environment to a real actor id in the ledger (usually a
maintainer); it is sent on every request, and `--actor <id>` on a create command overrides it (precedence: flag, then
env, then config; nothing is sent if none is set). This is attribution for admin use, not authentication: any
master-token holder can name any actor. With no actor set the edge records `'unknown'`, and Spec DO issue writes by an
unknown actor get 403 once the issue changes deploy; set one before using `issue create`. `--actor` is on `gate run`, `org create` and
`actor create/trust/grant-promotion` too. Stopping the master token from acting as a human is M12 stage 2, a separate
decision.

**Token precedence:** `--token` > `BEEHIVE_API_TOKEN` > config `apiToken`. A stale `BEEHIVE_API_TOKEN` therefore beats the
saved token; `auth whoami` names the source, and `login`/`logout` say when the variable is set.

**Secret handling.** The config file is written 0600 from creation (temp file in the same directory, then rename, so an
older 0644 file is replaced, never chmodded after the fact) in a directory created 0700 (an existing directory keeps its
mode). `login` and `logout` change only `apiToken` in the file; values from `BEEHIVE_*` or flags are never persisted and
unknown keys are kept. The CLI never prints a token: `show-token` and `whoami` show at most the first 12 characters,
and errors, verbose output and config-parse warnings never include a token or file contents. Windows ignores POSIX
modes; no protection is claimed there. `BEEHIVE_API_TOKEN` in a shell profile is the weakest place for a token; prefer
`--token-stdin` plus the config file, or a secret manager. Tests: `tests/cli-token.test.ts`.

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

### User tokens: mint, rotate, revoke (M12, RFD-0008)

Live once push B (schema `m9`, table `user_tokens`) reaches the deploy flow. A user token
(`bh_usr_...`, `Authorization: Bearer` only) acts as **one human actor** that has a GitHub id; the edge
overwrites any `X-Actor-ID` the client sends. Agent and service actors never hold one. Scopes, one per
token: `read` (like a service token), `read_write` (the write allow-list in `workers/api/principal.ts`:
orgs, repos, specs, spec stage and claim, candidates, pre-merge gate start, issues, issue stage and
status, comments, links), `maintainer` (adds the comment-policy PATCH). Every scope gets 403 on actor
admin, gate verdicts, trials, promotions, candidate `stage` and `execute`, lifecycle routes and
`/api/admin/*` (those stay master-only in M12). Without the `maintainer` scope the edge sends
`X-Beehive-Maintainer-Cap: 1` on every DO request, so a maintainer's `read_write` token cannot close
other people's issues or comment on locked ones. The DO reads the role live: demoting a maintainer
takes the power away from their `maintainer` tokens at once. At most 90 days, at most 10 live tokens
per actor (409 beyond), plaintext shown once, only the SHA-256 hash stored.

1. **Mint (user).** `/app/settings/tokens` (the "API tokens" link in the header). The token is always
   for the signed-in actor. Minting needs a sign-in from the last 10 minutes, otherwise the page asks
   to sign in again. That bounds a stolen Beehive cookie only: GitHub re-authorises silently when the
   OAuth app is already approved. The page shows the plaintext once (`no-store`, `no-referrer`);
   reloading it resubmits the form and mints a second token (the browser asks first), which is
   listed and can be revoked.
2. **Mint (maintainer, bootstrap or break-glass).** `POST /api/admin/user-tokens` with the master token,
   `X-Actor-ID: <your actor id>` and `{"actorId":"<target>","name":"laptop","scope":"read_write",
   "expiresInDays":30}` (`scope` defaults to `read`, `expiresInDays` 1-90, default 30). The plaintext is
   in `data.token.plaintext`, once. `GET /api/whoami` with the token shows `kind: "user"`.
3. **List.** `GET /api/admin/user-tokens[?actorId=<id>]` (master): prefix, scope, created, expires,
   revoked, last used (at most once a minute). Never plaintext or hashes.
4. **Rotate.** Mint a new token, switch the client, revoke the old one.
5. **Revoke.** One: the settings page, or `POST /api/admin/user-tokens/<tokenId>/revoke` (idempotent;
   the first revocation is kept). All of an actor's: `POST /api/admin/user-tokens/revoke-all
   {"actorId":"<id>"}`. 401 from the next request (no edge cache).
   **Removing a login from `ALLOWED_GITHUB_USERS` ends its UI session on the next request (it signs in again,
   read-only if `OPEN_VIEWER_SIGNIN` is on) but does not touch API tokens: also run `revoke-all` for that actor.** A mistyped or service-actor `X-Actor-ID` on either revoke route is a 400/403 with the reason, and
   nothing is revoked; 503 means the Spec DO could not answer.
6. **Roll back push B** (a ref operation through the `cf` flow): redeploy the rollback floor `8de5485` or any later
   commit, **never anything earlier** (that is `Unknown schema_version 'm9'`, a full outage). Clients then see every
   `bh_usr_` request answer 401, `/app/settings/tokens` not found, and the `/api/admin/user-tokens*` routes 404; stage-1
   logging stops. Master, service tokens and sessions are unchanged, and `user_tokens` stays at m9, ignored.
7. **After a rollback of push B and a re-deploy of it**, tokens that were valid before work again unless
   expired, and nothing could be revoked in between: re-check the list and revoke as needed.

Failure answers: an unknown, revoked or expired token, or one of a deleted, non-human, GitHub-less or
service actor, is the same `401 Unauthorized`. A Spec DO that cannot answer (including an older DO
without `/internal/user-tokens/verify`, which answers 404) is **503**, never anonymous or master;
the admin routes and the settings page answer 503 ("Token service unavailable") the same way. Note
the difference from service tokens, whose verify 404 means "unknown token" (401).

**Push B deploy checks** (no new secret): before, `schema_version` is `m8` and push A (the rollback
floor) is live; after the push and `prod-health.sh`, `schema_version` is `m9` and
`SELECT name FROM sqlite_master WHERE name = 'user_tokens'` returns one row. Then mint the first token
as in step 2. No production e2e without the maintainer's approval.

**Master token, stage 1 (log, change nothing).** Every master request that sends an `X-Actor-ID` other
than `unknown` writes one Workers Logs line
`{"event":"master_actor_assertion","method","path","actorId","ray"}` (pathname only; the id is at most 128
printable ASCII characters with no spaces: a longer or malformed id is a 400 and writes a
`master_actor_rejected` log line instead, with no AE point; never the query, headers, body or token) and one Analytics Engine point in the
`beehive-metrics` dataset (index `master_actor_assertion`, blobs: actor, method, path class with ids
replaced by `:id`). Workers Logs keep 7 days; use AE for the stage-2 evidence:

```sql
-- Analytics Engine SQL API (account-scoped token with Account Analytics: Read)
SELECT blob1 AS actor, blob2 AS method, blob3 AS path, SUM(_sample_interval) AS requests
FROM "beehive-metrics"
WHERE index1 = 'master_actor_assertion' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY actor, method, path ORDER BY requests DESC
```

In Workers Logs (dashboard, `beehive`, Observability): filter on `event = master_actor_assertion`.
Human versus agent is resolved afterwards against `actors.type`. Stage 2 (master can no longer act as a
human actor) is a separate decision, and it first needs lifecycle routes open to `maintainer` tokens
(`docs/FOCUS.md`).

**Assumption A4 (unverified, 2026-10-18):** Cloudflare invocation logs and the Honeycomb traces of
`beehive` drop `Authorization`, `Cookie`, `X-API-Token` and the edge-to-DO `X-Beehive-Internal` /
`X-Beehive-Admin` values. If a check shows otherwise: set `invocation_logs = false` and turn header
capture off for traces on `beehive`, then rotate the exposed secrets (`docs/FOCUS.md`,
`docs/OPEN-QUESTIONS.md` 2026-10-18).

### Canary deploy and rollback (deploy refs)

Live once the m6 -> m7 migration reaches the deploy flow (the Spec DO migrates on its next
init; additive: `deploy_refs`, `canary_deployments`). Contract: `workers/shared/deploy-refs.ts`.

- **The pointer is the Spec DO `deploy_refs` chain per (spec, rung).** Deploying a canary
  appends a row whose `prev_ref_id` is the old head; rolling back appends a row pointing at the
  nearest earlier target that was not rolled back since (identity: worker version, else candidate; the
  empty ref if there is none). Rollbacks never toggle: rolling back repeatedly walks down the chain and
  stops at the empty ref, so two failing canaries cannot ping-pong (D2, `docs/plans/d2-canary-ping-pong-plan.md`).
  A rolled-back version returns only by a new deploy. A rollback does not check whether the target candidate was tombstoned since (OPEN-QUESTIONS 2026-11-02; PR-G). A chain that already toggled before this fix may
  roll back to the empty ref where it used to restore an earlier canary. The shadow router reads the live canary heads on every
  mirrored request, so a rollback takes effect on the next request with no redeploy. History is
  never rewritten.
- **Ref rollback (internal DO route `POST /deploy-refs/rollback {specId, rung, reason}`):** send
  `Idempotency-Key: <one per decision>` on every retry, so a retry replays instead of rolling back one more ref, and
  `X-Expected-Head: <head ref id you read>` so a stale decision is a 409 `version_conflict` that moves nothing
  (an empty header is a 400). The canary route `/canary-deployments/:id/rollback` takes neither: it refuses
  (409) a deployment that is not live.
- **Manual rollback:** `POST https://beehive-canary-worker.../rollback` with
  `{"candidateId","specId","reason":"manual","timestamp","metrics":{}}`. Automatic triggers
  (`latency`, `error_rate`, `slo_violation`) are refused (409) for a canary whose switch is off:
  `POST /canary/<candidateId>/auto-rollback {"enabled":false}`.
- **Canary deploys and candidate-Worker deletes answer 501** when the preview manager has no Versions client.
  The repo's `workers/preview-manager/wrangler.toml` sets `WORKER_VERSIONS_MODE = "api"` (deleting that line and pushing turns it off).
  What is live in production cannot be determined from the repo (deploys are human-only); check the deployed vars. `api` mode still
  answers 501 if `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `WORKERS_SUBDOMAIN` or the bundle source is missing, so a 501 does not
  prove no Worker exists: a purge with candidates aborts on a 501. `stub` is local dev only (it also needs `BEEHIVE_LOCAL_DEV=1`, which
  only `scripts/start-e2e-workers.sh` sets), so a stray `stub` in production also answers 501.
- **Deploy dependency:** `beehive-shadow-router` now binds `SpecDO` from `beehive` (`script_name`),
  like canary-worker and preview-manager. All ten deploy at once, so until `beehive` has deployed its
  DO reads fail and the router uses its static config.
- A candidate a live ref points at cannot be tombstoned or purged (409), like an active promotion.
- **Shadow-router caches the live pointers** (in-isolate, `LIVE_REFS_CACHE_TTL_MS`, default
  5000 ms, `0` disables, max 60000). A rollback (or promotion) reaches the router within one TTL;
  if the Spec DO read fails the last value is served for at most one more TTL (worst case 2 x TTL =
  10s by default), then the router falls back to the static config. Errors are never cached and
  concurrent requests share one read. Details: `docs/OPEN-QUESTIONS.md` "Shadow-router live-ref cache".

### Canary SLO loop (m11, M3)

`beehive-canary-worker` evaluates every live canary on each tick from the Spec DO alarm (queue `canary-slo-ticks`, see
"Event-driven tick" below) and rolls back the ones in violation. There is no cron (removed 2026-10-24). Plan and reasoning:
`docs/M3-CANARY-SLO-PLAN.md`.

- **Data:** the shadow router aggregates each mirrored candidate result per (deployment, minute) and posts batches to
  the Spec DO (`POST /canary-metrics`, table `canary_metrics`, migration `m10 -> m11`, additive). A batch is posted at 20 samples or 10 s
  after the first, and the tail of a burst is posted 10 s later through `ctx.waitUntil` (`scheduleTailFlush`). Rows older than 24 h are
  pruned on every write and read; the table has no org column and no foreign keys, so a purge does not touch it.
- **It is shadow data, not canary data.** The router mirrors and discards, so every row is `source = 'shadow'`. The loop
  reads `CANARY_SLO_SOURCE` (default `shadow`); set it to `canary` only when real canary traffic records rows with that
  source. Until then a "violation" means the mirrored candidate was slow or erroring, not production users.
- **Settings** (canary worker vars): `CANARY_SLO_LATENCY_P95` (ms, 1000), `CANARY_SLO_ERROR_RATE` (0.01),
  `CANARY_SLO_MIN_REQUESTS` (50), `CANARY_SLO_WINDOW_MINUTES` (15), `CANARY_SLO_SOURCE` (`shadow`). Unset or blank takes
  the default; a value that is set but unusable (`low`, `0`, `2`) makes the cycle log an error and do nothing.
- **Latency is bucketed** (bounds 10, 25, 50, 100, 250, 500, 1000, 2500, 5000 ms; p95 reads the bucket's upper bound), so
  set `CANARY_SLO_LATENCY_P95` to one of those bounds; a value between two bounds (800) acts like the next bound up
  for the "over" test and rolls back whenever the true p95 is anywhere in that whole bucket.
- **Verdicts** (`GET /slo-status` shows them without acting): `healthy`, `violation`, `insufficient_data` (fewer than the
  minimum requests in the window: no verdict) and `unavailable` (metrics unreadable, e.g. an older Spec DO answers 404:
  no verdict). Only `violation` rolls back, and only when that canary's auto-rollback switch is on. Shadow traffic is
  thinned twice (the top-level split, then each deployment's percentage) and chosen by URL hash, so `insufficient_data`
  is the normal state for a quiet canary.
- **Logs:** one `canary_slo_cycle` JSON line per tick (`checked`, `rolledBack`, `alreadyHandled`, `skipped`, `errors`).
  A rollback answering 404/409 means it already happened and is not an error.
- **Mixed versions / rollback of the deploy:** a new router with an older Spec DO logs `canary metrics not recorded ... 404`
  and carries on; an older router records nothing, so the loop sees `insufficient_data`; a new canary worker with an older DO sees
  `unavailable` and never rolls back. Redeploying the previous commit leaves `canary_metrics` idle (the rollback floor
  skips the newer schema version).
- **Event-driven tick:** the Spec DO (in the `beehive` worker) arms an alarm 60 s after a canary deploy; each firing,
  while a canary head is live, sends one message to queue `canary-slo-ticks` and re-arms (no live canary: no re-arm, the
  chain stops; the first request after a restart re-arms if one is live). `beehive-canary-worker` consumes the queue and
  runs one SLO cycle per batch. It is the only trigger: the minute cron was removed 2026-10-24. **Create the queue before the deploy push**
  (`wrangler queues create canary-slo-ticks`, human step): both the producer binding in the root `wrangler.toml` and the
  consumer need it to exist. **If it does not, the deploy of the root `beehive` worker (ledger and API) fails, not just this
  feature.** Because Production canary deploys answer 501 (above), no canary ref is written in prod, so
  **the alarm will not fire there until a Versions client exists, so the SLO loop does not run in prod until then**
  (no canary exists to evaluate or roll back). Mixed versions: an old DO sends no ticks, so nothing evaluates until
  the new DO is live; an old canary worker never reads the queue (messages expire). A
  failed send is logged and the alarm re-arms anyway; if the alarm itself fails before a live canary is confirmed it does not
  re-arm. Rolling back to a commit without `alarm()` leaves any pending alarm firing into a class with no handler; the runtime
  retries then drops it (harmless, noisy). Log line to look for: `canary_slo_cycle` from the queue path.
- **Turn it off:** remove the `canary-slo-ticks` consumer (canary worker) and producer (root `wrangler.toml`) and redeploy, or set a canary's switch with
  `POST /canary/<candidateId>/auto-rollback {"enabled":false}`.

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
- GitHub CI has the same filter: `ci.yml` skips pushes and PRs that touch only `docs/**`
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

## Idempotency and queue retries (M5a-2, 2026-10-30)

- **Edge:** `POST` to the eight keyed routes (organizations, actors, repositories, specs, candidates, gate-verdicts,
  trials, promotions) forwards the client's `Idempotency-Key` to the Spec DO; a key over 255 characters is a 400 at the
  edge. Other routes ignore the header. Replays answer with the stored status and `Idempotent-Replay: true`; the same key
  with another body is a 409.
- **Spec DO internal route:** `POST /deploy-refs/rollback` (no edge route; reached over the `SPEC_DO` binding or the
  local e2e probe) honors `Idempotency-Key` the same way. The key is scoped by `X-Actor-ID`; a caller without one
  is actor `system`, so headerless callers share one key scope. `X-Expected-Head` is not part of the key's request
  hash (only the body is): the same key and body with a different header replays the first answer.
- **Queue consumer:** a message is retried with `message.retry()` (30 s doubling to 900 s) on 5xx, 408, 429, 401, 403,
  a missing repository or candidate, a thrown fetch, or an in-flight gate run; it is dropped with an error log on other
  4xx, validation failures and a history-key 409. After attempt 5 it gives up with an error log; `max_retries = 4` in
  `workers/queue-consumer/wrangler.toml` is the backstop. There is no dead-letter queue, so a given-up message is gone;
  search Workers Logs for `Giving up on message` and `Dropping message`.
- **Gate worker:** `POST /gates/pre-merge` with an `Idempotency-Key` derives its verdict id from the key and replays a
  run only after the Spec DO confirmed the verdict; the in-memory run map is per isolate, so after a restart the Spec DO
  key is the guard and the gate re-runs once. Errors: 400 invalid body, 404 unknown spec, 409 `{inFlight:true}` while a
  run is still going, 500 otherwise (including a failed verdict write). The route answers **201 `{success:true, result}`
  even for a `fail` verdict** — callers must read `result.status === 'pass'`, not just `success`. The merge train does
  exactly this: `executeMerge` posts the same route per claimed car (bearer `API_AUTH_TOKEN`, `X-Actor-ID:
  promotion-worker`, no idempotency key — the car has no lease id yet) with the candidate's `commitSha`/`baseCommitSha`
  from `GET /api/candidates/:id`, and merges only on a pass (`docs/plans/merge-train-gate-call-plan.md`). A repeat
  `POST /api/gate-verdicts` for the same `(candidate, gate)` upserts the summary row (201, latest wins, one history row
  per write) instead of 500 — same semantics as the gate-runs path. What a train pass means today: the gate is still
  simulated (section 0 of `docs/REAL-GATE-IMPL-PLAN.md`), so a pass is "score >= 80 with a random conformance warning".
- Preview deploys run on the first delivery only and are best effort.
- A master token can pre-plant the Spec DO key `<queue>:<event id>:gate` as actor `queue-consumer` with another body; the gate then treats its verdict write as already recorded. Master is trusted, so this is accepted.
- Known load: a push for a repository with no candidate is retried 5 times (about 7.5 minutes). A dead-letter queue or a negative cache is the follow-up.

### Sandbox build container (beehive-sandbox-runner, 2026-10-25)

`POST /sandbox/build {repo, commitSha}` (bearer auth) builds a candidate commit in a container-backed Durable Object (`BuildSandbox`) and
returns a Worker bundle; `GET /sandbox/probe` returns the image's tool versions (deploy check: node, esbuild, git). Design and limits:
`docs/SANDBOX-BUILD-PLAN.md`; verification and gotchas: `docs/OPEN-QUESTIONS.md` "Sandbox build on the container DO API works in production".
- **Secret:** `CLOUDFLARE_API_TOKEN` on `beehive-sandbox-runner` (Artifacts scope) mints 5-minute read tokens inside `ArtifactsGateway`; it never
  reaches the container. `CLOUDFLARE_ACCOUNT_ID` and `ARTIFACTS_NAMESPACE` are plain vars in its `wrangler.toml`; `ARTIFACTS_NAMESPACE` is only the fallback, `preview-manager` sends the ledger repository's namespace on every build and requires the runner to echo it.
- **Deploys:** the image is built by Workers Builds' `wrangler deploy` (~2 min). A change to the container class or its binding is a Durable Object
  lifecycle change: rename rather than delete a class that the live worker binds (error 10086), and delete a superseded container application by hand
  (`wrangler containers list`, then `wrangler containers delete <id>`).
- **Cost:** no instance runs until a build or probe starts one (`lite`), and every build destroys its container.
- **Local e2e / CI:** the worker is not started by `scripts/start-e2e-workers.sh`; `SANDBOX_MODE=stub` with `BEEHIVE_LOCAL_DEV=1` returns a fixed bundle.

### Gate test container (`TestSandbox`, beehive-sandbox-runner, slice 6 of `docs/REAL-GATE-IMPL-PLAN.md`)

`POST /sandbox/test` runs a candidate commit's install and tests in a second container-backed Durable Object (`TestSandbox`, binding `TEST_SANDBOX`, image `workers/sandbox-runner/Dockerfile.test`). Until the binding exists the route answers 503 `NOT_CONFIGURED`.
- **Deploys:** like the build container, the maintainer's push to the Artifacts repo; Workers Builds builds `Dockerfile.test` as a second container application (the build now makes two images; time it against the 5.5 min Workers Builds kill in OPEN-QUESTIONS Gotcha 4, do not assume 2 min). Do not run `wrangler deploy` by hand. `[exports.TestSandbox]` is a new class (additive); the existing `BuildSandbox` application and namespace are untouched.
- **No platform cap:** under the `durable_object` policy `instance_type` and `max_instances` cannot be set in wrangler. The size (`standard-2`) is chosen in code; concurrency is bounded by the gate's queue consumer and the Spec DO counter (plan section 2), not by the platform.
- **Cost:** no instance runs until a gate run starts one; every run destroys its container. No secret is added (`CLOUDFLARE_API_TOKEN` is the one the build container already uses).
- **Rollback:** container applications are account-level, not part of a worker version, and rolling a worker back across Durable Object lifecycle entries may be refused: treat this worker as forward-fix only. Deleting the `TestSandbox` application is by hand (`wrangler containers list`, `wrangler containers delete <id>`) and only after the worker no longer binds it.

## Mirror body mode (PR-H, 2026-11-01)

The shadow router decides what a mirrored request carries to a candidate (`workers/shadow-router/mirror-mode.ts`), because candidates run unreviewed agent-written code, are publicly reachable on `workers.dev` and have open outbound network access. Everything in a mirrored request except the HTTP method and a route template counts as customer data (body, query string, path segments, `x-request-id`, `user-agent`, `accept-language`).

- `MIRROR_BODY_MODE` (var in `workers/shadow-router/wrangler.toml`): `none` (default) sends the method, a route template (ids become `:id`) and `Accept` only; `redacted` also sends the content type and a JSON body whose string and number leaves are replaced; `full` sends the original request minus credentials and needs `GOVERNANCE_EGRESS_CONTROLLED = "true"`, a var only a human sets, otherwise the router falls back to `none` and logs a warning. Anything unknown is `none`.
- The trusted baseline (`beehive-main`) always gets the original request.
- The Scientist queue message no longer carries the request body, request headers are an allowlist (`accept`, `content-type`), candidate response headers are a bounded allowlist, the whole-message log is gone, and candidate URLs are not logged with their query. `redact_query_string = true` on the router.
- **Deploy effect:** after this deploy candidates receive less than before. Comparison fidelity drops until a candidate is eligible for `full` (PR-G). Nothing in the repo sends real traffic to the router yet, so no live behavior changes today. To restore the old behavior deliberately, set both vars; do not do that for untrusted-origin work.
- **Route template (allowlist).** A mirrored path, the Scientist queue message `path` and the Analytics Engine `path` use `routeTemplate`: only known route words survive (a small fixed list plus `MIRROR_ROUTE_WORDS` in the router's `wrangler.toml`); every other segment becomes `:id`, and the template is bounded (8 segments, 128 characters). List the mirrored service's own route names there; never list usernames, slugs or ids. A delta-surface path rule in the comparator (`matchPath`) matches the **template**, so a spec's route words must be in `MIRROR_ROUTE_WORDS` for its rule to apply.
- **`redacted` still leaks structure** (array and object shape, booleans, null; key names are replaced by `k0`, `k1`, ...; bodies over 2000 nodes or not UTF-8 JSON are dropped; the content type is the constant `application/json`). Never use `redacted` for untrusted-origin candidates; it is for maintainer-origin work only.
- **Setting `GOVERNANCE_EGRESS_CONTROLLED`:** edit the router's `wrangler.toml` `[vars]` in the Cloudflare Artifacts repo and deploy it yourself. Do not set it in the dashboard (the next push overwrites dashboard vars unless `keep_vars` is set) and no agent may set it. Leave it unset until candidate egress is actually restricted.
- **Fidelity:** candidate response headers outside `content-type`, `content-length`, `cache-control`, `etag` are no longer sent to the comparator, so delta-surface header rules on other headers are unverifiable. The baseline response is still a stub, so little changes today.
- **Not verified (open):** the baseline fetch to `beehive-main` still carries the full URL, query and credentials (by design), and `[observability.traces]` persists spans to Honeycomb at 100% sampling; whether `redact_query_string` applies to trace span URLs is unconfirmed. Check one trace before opening real traffic.
- **Deploy checklist:** add the mirrored service's own route names to `MIRROR_ROUTE_WORDS` in the router's `wrangler.toml`; if forgotten, candidates receive `/:id/:id` (the safe failure). Delta-surface path rules in specs must be written as `{param}` or wildcard patterns, never with real ids, or the comparator can no longer match them.
- Candidate fetch failures now log only the error name (an `Invalid URL` message would print the URL with its query).

## Governance schema m14 (PR-A, 2026-11-01)

- The Spec DO migrates `m13 -> m14` on its first request after the deploy: five new tables (`change_classifications`, `approvals`, `near_misses`, `intent_provenance`, `governance_events`) and one metadata row, `governance.m14_epoch` (the ledger time of the migration, written once, never moved). No writer exists yet, so the tables stay empty, and nothing in the routes changes.
- Deploy check: `schema_version` is `m14`, the five tables exist and are empty, `governance.m14_epoch` exists (dashboard SQL editor: `SELECT key, value FROM metadata WHERE key IN ('schema_version','governance.m14_epoch')`). A failed migration rethrows and is a full outage, like any step; every statement is `IF NOT EXISTS` and replays safely.
- **Window before PR-G:** the epoch is stamped at this deploy and never moves, and nothing writes `intent_provenance` until PR-G. Every issue or spec created between the m14 deploy and the PR-G deploy therefore has no provenance row and `created_at >= epoch`, which the intent gate will read as `unknown` (external) and ask a human to approve. Either deploy m14 and PR-G close together, or PR-G backfills those rows (origin `maintainer`, basis `backfill`) in its own migration step before its gates go live. The backfill is valid only while untrusted creation is closed (otherwise an external-origin issue created in the window would be stamped `maintainer`); it must run before untrusted creation opens.
- Rollback: a build older than m14 over an m14 ledger serves normally and ignores the tables (rollback floor). The epoch is what lets a later build tell legacy entities from ones created while rolled back.

## Shadow samples, schema m15 (promotion-gaps PR A, 2026-11-10)

- The Spec DO migrates `m14 -> m15` on its first request after the deploy: one new table, `shadow_scores` (one aggregate row per candidate: sample count, score sum, matched count, diff totals, and a production-versus-placeholder split). Additive; no existing table changes.
- New route `POST /api/candidates/:id/shadow-samples` (Spec DO, and at the edge for the master/service tier only; user tokens get 403). The scientist comparator posts one sample per ledger candidate and mirrored request with `Idempotency-Key: <requestId>:<candidateId>`; the Spec DO sums them and derives the shadow gate verdict in the same transaction (`pending` below 20 samples, then `pass` at an average of 80 or more, else `fail`; `workers/shared/shadow-verdict.ts`). Shadow evidence is **log-only** for promotion until the shadow-router follow-up (docs/plans/promotion-gaps-plan.md section 11 B1): the comparator scores every sample against the router's placeholder baseline and sends it as `placeholder`, which never counts as production evidence. The edge route (master/service tier) accepts `baseline: 'production'` from any caller holding that tier, as `canary-metrics` does, so `production_count` is only as trustworthy as that tier.
- Deploy check: `schema_version` is `m15`, `shadow_scores` exists; after mirrored traffic reaches a canary candidate its row appears (`SELECT candidate_id, sample_count, production_count FROM shadow_scores`), `production_count` stays 0 (unless someone posted production samples through the edge), and `gate_verdicts` gets a `shadow` row decided by `scientist-comparator` once 20 samples land. The `scientist-comparator` actor (type `agent`, no promotion authority) is created by the first sample.
- Growth: a keyed request stores one `idempotency_keys` row (response body included, 24 h TTL) per mirrored request per candidate, on the single `main` Spec DO, and the expired-key sweep runs on one keyed call in 50. The DO stops recording at 1000 placeholder and 1000 production samples per candidate (`capped: true`), which bounds `shadow_scores` but not the key rows of a hot candidate's last day; watch `idempotency_keys` row count after the first real mirrored traffic.
- Queue behavior: the comparator acks a message unless the Spec DO answers 5xx or the call fails, in which case it retries (`max_retries = 4` on both consumers; past that the platform drops the message and one sample is lost). A code-less 404 from the samples route (an older Spec DO in the mixed-version window) is acked and logged once per batch as `shadow_samples_unsupported`.
- Mixed-version window (one push deploys all ten workers, in no order): an old comparator's PATCH `/api/candidates/:id/shadow` never existed, so it records nothing, as before; a new comparator against an old Spec DO drops samples for the window; the candidate response gains `shadowScore`, `shadowMatch` and `shadowMetrics` only once a sample exists (the fields were always declared, never filled).
- Purge: a purged organization's `shadow_scores` rows go with it, and rows whose candidate is already gone (left by a build older than m15) are swept by the next purge that selects an organization.
- Rollback: a build older than m15 over an m15 ledger serves normally and ignores the table (rollback floor); the table has no foreign key on purpose.

## Advance: the promotion decision point (promotion-gaps PR B, 2026-11-10)

- New Spec DO route `POST /api/candidates/:id/advance` `{ toRung: shadow|train|canary|full, fromRung?, dryRun?, notes? }`. **Internal only**: the edge does not route it (a test keeps it so) and nothing calls it until PR C moves the promotion worker onto it, so this deploy changes no behavior. No schema change.
- Reading: `candidates.stage = passed_X` means "passed rung X". `advance(toRung)` checks the evidence of the rung being **left** and writes the stage of the rung just passed (`full` writes `passed_canary` then `promoted`, so `promoted` is reached only from `passed_canary`; from `passed_canary` it writes `promoted` alone and the canary evidence is checked again, so an interrupted promotion can be finished, with `fromRung` either `canary` or `full`). In one transaction: 404 `candidate_not_found` (coded, so an older Spec DO's plain 404 is told apart), replay (already at the target stage: 200 no-op, before every other check), 409 `stale_from_rung`, 409 `not_next_rung` (skip ahead, backwards, `failed`, `rolled_back`), then evidence.
- Evidence per rung left: `pre-merge` a `pass` gate verdict (**enforced**); `shadow` a `pass` verdict (**log-only**: the shadow router cannot yet score shadow-rung candidates, OPEN-QUESTIONS 2026-11-10); `train` a merged merge-train car of the candidate (**log-only** until tournament mode writes train evidence); `canary` the candidate is the live canary head of its spec and has been for 15 minutes (**enforced**; measured from the head ref's `moved_at`, so a restored canary counts only its current live time). Log-only means a missing or failed item writes one `governance_events` row (`event = 'evidence_missing'`, subject `candidate:<id>`, reason `<rung>:<missing|failed>`, deduplicated per (candidate, rung, status) for an hour, so `shadow:missing` and `shadow:failed` can both land; at most 100 rows an hour, the row that reaches the cap carries `capReached`, and every miss also leaves a `[SpecDO] evidence_missing` warn line in Workers Logs even when no row is written) and the move still lands. Flipping a rung to enforce is one constant, `EVIDENCE_MODE` in `workers/shared/promotion-advance.ts`.
- A dry run does everything except write: no stage, no history, no governance event.
- Measurement once PR C is deployed, excluding e2e data: `SELECT reason, COUNT(*) FROM governance_events WHERE event = 'evidence_missing' GROUP BY reason` (how often each log-only rung is missing evidence: the input to flipping it). The rows count candidate-hours and saturate at 100 an hour; the warn lines count non-dry-run moves that reached the write with log-mode evidence unmet (about one per candidate per rung: a replay is a no-op before evidence and a dry run never logs).
- `CANARY_MIN_SOAK_MINUTES` (Spec DO var, the `beehive` worker): shortens the canary soak, honored only for an integer from 0 up to 14. **No deployed `wrangler.toml` may set it** (`tests/unit/soak-override-not-deployed.test.ts`); `scripts/start-e2e-workers.sh` passes `0` for local e2e and the demo.
- `CANARY_MIN_SOAK_MINUTES` set as a dashboard variable or secret is not covered by the wrangler test: whenever the override is in effect the Spec DO logs `[SpecDO] CANARY_MIN_SOAK_MINUTES override in effect` (search Workers Logs for it; the line appears on each canary-to-full `advance` attempt for a live canary, so nothing shows until PR C calls `advance`).
- Mixed-version window: an old promotion worker keeps writing stages through the stage PATCH (unchanged; PR-S still logs its off-by-one writes), and stages it already wrote stay off by one for in-flight candidates: a candidate at `passed_shadow` or `passed_train` plus `advance(train | canary)` is a 200 no-op, and one at `passed_canary` while on the canary rung is finished by `advance(full)`. No enforced evidence is bypassed (pre-merge and canary are still checked), but PR C must handle these candidates; a new promotion worker (PR C) against an old Spec DO gets a code-less 404 on `advance` and must answer 503 `ledger_too_old`, never "unknown candidate".
- Rollback: a build older than this one has no route and ignores nothing (no schema change). Rollback and `failed` stage writes are never gated (rule 7); `advance` only moves up.

## Promotion worker on advance (promotion-gaps PR C, 2026-11-10)

- **Behavior change at this deploy.** `POST /promote` now asks the Spec DO whether a move is legal before it creates any state, and the stage is written by the Spec DO's `advance`, one rung at a time. A request that skips a rung, names a candidate the ledger does not know, lacks the enforced evidence (a passing pre-merge verdict; for `full`, a live canary soaked 15 minutes) or names a stale `fromRung` is refused with a status and a `code` instead of recorded (table below). `fromRung` is optional; `toRung` must be `shadow`, `train`, `canary` or `full`.
- **In production, competitive promotion past `shadow` is refused (`409 no_shadow_evidence`)** until the shadow-router follow-up: the tournament ranks by the ledger's shadow scores and production candidates have none (the router mirrors only canary candidates, OPEN-QUESTIONS 2026-11-10). Every other move works. This is the intended, maintainer-accepted consequence (plan decision 6). e2e and `npm run demo` seed scores through `POST /api/candidates/:id/shadow-samples`.
- Statuses: `200` moved / noop / eliminated; `202` waiting (a lone tournament entrant) or queued (a merge-train car not yet merged); `400` invalid request; `404 candidate_not_found`; `409` `stale_from_rung`, `not_next_rung`, `evidence_missing`, `evidence_failed` (a failing shadow verdict cannot enter the tournament), `no_shadow_evidence`, `tie`, `not_enough_entrants` (fewer than two eligible entrants at decision time), `tournament_completed`, `tournament_exhausted`, `spec_mismatch` (the request's `specId` is not the candidate's), `train_full`, `car_not_failed`, `gate_failed`; `502 ledger_error`; `503 ledger_too_old`; `500` only for an unexpected error (`tournament_error`, `merge_train_error`). A refusal at the pre-check creates no promotion state. A refusal's `fromRung` is the request's, or `pre-merge` when the request omitted it: read `code` and `message`, not `fromRung`.
- Tournament mode decides only `shadow -> train`; merge-train mode runs the train only for `train -> canary`. A winner or a merged car that is not the requester gets its own completed promotion state. **Entrants are re-checked at decision time**: one that can no longer make the move (failed, tombstoned, changed stage) or whose shadow verdict failed is marked `disqualified` (and gets a `tournament_loss` near-miss at once, even though nobody won) and does not compete; one already past the rung is left out without a loss; a ledger error or an older Spec DO while re-checking stops the attempt (502/503) and disqualifies nobody. Evidence refusals (`no_shadow_evidence`, `tie`, `not_enough_entrants`) only read: they never move the tournament to `in_progress`, so they spend none of its attempts; the ledger allows a tournament three real failures (an `advance` refusal or a ledger error after a winner was chosen), after which it answers `409 tournament_exhausted` for that spec and nothing in the worker resets it (OPEN-QUESTIONS 2026-11-10). The decision is recorded as a decided trial **after** the winner moved (winner against runner-up; needs `actorId` to be an existing actor, else the result says `details.trial: "not recorded: ..."` and the move stands); the loser gets a `tournament_loss` near-miss, and a `trial_loss` only when the trial was written. Moves made through `POST /merge/retry` (a retried car that merges and advances) get no promotion state: only `POST /promote` records them.
- A failed merge-train car now answers `409 gate_failed` (it used to answer success). `POST /promote/:id/retry` now works (it never could against a real ledger): it is a new attempt, the failed state stays as history.
- Deploy check (after PR A, B and C are all deployed): promote a test candidate `pending -> shadow` with a pre-merge verdict, then watch `GET /promote/:id` (`completed`, `currentRung: shadow`) and the candidate's stage (`passed_premerge`); a candidate promoted without a verdict answers `409 evidence_missing`. Workers Logs: `[Tournament]` lines carry the code of a refusal; `governance_events` `evidence_missing` rows count log-only gaps.
- e2e: the local e2e files must run one at a time (`npm run test:e2e:local` does, via `--no-file-parallelism`): they share one stack and one global promotion mode, and the tournament and demo outcomes depend on the mode.
- Mixed-version window (one push, ten workers, any order): a new promotion worker against an old Spec DO gets a code-less 404 on `advance` and answers `503 ledger_too_old` (promotions pause for the window; nothing is recorded); an old promotion worker against a new Spec DO is unchanged (it never calls `advance`; its stage PATCH is still allowed and still logged by PR-S). Deploy the Spec DO's worker and the promotion worker together, which one push does.
- Rollback: a build older than PR C runs the old flow against the new Spec DO (no schema dependency); `advance` simply goes unused.

## Mirror source and the production baseline (shadow-router follow-up M + D1, 2026-11-11)

Plan: `docs/plans/shadow-router-followup-plan.md` (rev 4). **Nothing here changes promotion**: the tournament, `advance` and the shadow verdict
are untouched (shadow evidence stays log-only; the tournament keeps its all-sample average). Not deployed.

- **Mirror source (`workers/api/mirror.ts`).** After the response exists, the `beehive` worker copies a sample of its own **GET/HEAD** requests to the
  shadow router (`POST /mirror`, service binding `SHADOW_ROUTER` in the root `wrangler.toml`), reduced to `{ v: 1, method, path }` where `path` is a route
  template (known route words kept, every other segment `:id`). No raw request, header, credential, query string or body leaves the edge. It never delays
  or alters a response; failures are swallowed and counted (`mirrorCounters`).
- **Switch: `MIRROR_SAMPLE_PERCENT`** (integer 0-100; absent, `0` or anything else = off, no parsing and no I/O). **Set it in `[vars]` of the Artifacts
  deploy repo** (a dashboard var is overwritten by the next push, `keep_vars` is not set); it is never set in this repo (`tests/unit/mirror-vars-not-enabled.test.ts`).
  Rollback = deploy it back to `0` (or remove it).
- **Caps.** Per isolate: a token bucket (20 burst, 10/s) and at most 10 mirrors in flight; 2 s timeout, no retry.
- **Loop guard.** The router sends `X-Beehive-Mirror: 1` on every candidate and baseline fetch; the edge never mirrors a request carrying it
  (the baseline `beehive-main` is this same worker). A candidate that fetches `beehive` public pages itself is mirrored like any anonymous client; the
  token bucket bounds that.
- **Router `POST /mirror`** (bearer-gated like every route; strict body, a path that is not template-shaped is a 400; answers 202 and works in
  `waitUntil`). Descriptors bypass both URL-hash gates (a hash of a few dozen templates would put each permanently in or out): the per-candidate split is a
  random draw. The raw-request path of the router still exists for any external source and keeps its hash gates.
- **Like-for-like baseline.** The router no longer replays the caller's original request (with its credentials) against `beehive-main`. After the
  candidates answer, it fetches the baseline **once**, with the same sanitized request the candidates got (no credentials, no body, no query, templated
  path), and sends it in the queue message with `baseline.kind = 'production'`. No baseline (write method, fetch failure) = **no message queued**. A 401 is
  a real answer. The baseline is no longer one of the `candidates` of the message.
- **Comparator.** `baseline.kind = 'production'` -> samples are stored with `baseline: 'production'`; an absent kind (an old router) -> `placeholder`.
  For production samples, a pair where baseline and candidate both answered 3xx, both 4xx or both 5xx is **dropped** (it agrees on a refusal and says
  nothing); a disagreement is scored. Scored/dropped counts are logged per message.
- **Spec DO.** The candidate response gains `shadowProductionScore` and `shadowProductionCount` once a production sample exists (additive). `shadowScore`
  and the verdict still average every sample.
- **Removed.** `triggerShadowComparisons` in the preview manager (it sent a message nothing consumed).
- **What this does not do (yet).** Shadow targets (a `passed_premerge` candidate receiving mirrored traffic) are **not built**: candidate previews at that
  rung are simulated (`workers/preview-manager/builds.ts:276-285`), so a target route needs a real pre-shadow deploy first (plan slice P, a governance
  decision). Today only canary-ref candidates and `beehive-main` are targets. The signal is thin: only the public pages (`/`, `/app*`) give an informative
  baseline answer; status, four headers and latency are compared, never bodies.
- **Before deploy (human):** P0, confirm in Cloudflare that nothing outside this repo already mirrors into the router. The first deploy to an empty account
  needs two passes (the new `SHADOW_ROUTER` binding names a worker that must exist).
- **Mixed versions.** Old edge: never calls `/mirror`. New edge, old router: `/mirror` 404 is counted as failed, nothing breaks (the gate is off by
  default). New router, old comparator: extra `kind` field ignored, samples stay `placeholder`. Old router, new comparator: no `kind` -> `placeholder`. New
  router with an old Spec DO: nothing new is required of it.

## Invalid transitions (PR-S, 2026-11-02)

- The Spec DO checks every candidate stage write (the stage PATCH; sandbox execute was retired 2026-11-02) against table (c) and every promotion-state write against table (d) of `docs/GOVERNANCE-STATE-MACHINES.md`, in the write's transaction. **Log-only:** a violation never refuses; it writes one `governance_events` row (`event = 'invalid_transition'`, `subject = candidate:<id>` or `promotion_state:<id>`, `reason = <machine>:<from>-><to>`, `actor_id` NULL, `asserted_actor_id` = the asserted `X-Actor-ID` or the promotion-state row's actor, `detail` JSON with `rule`, `enforceable`, `source`, `specId`, `candidateId`, `orgName`) and a `console.warn('[SpecDO] invalid_transition', ...)` log line. A failure to log is a `console.error` and the write still lands.
- **Rows are expected from normal flows today:** tournament winners used to skip rungs (`skip_ahead`, `promote_not_from_canary`; since promotion-gaps PR C they no longer do, so those rows stop appearing from normal flows) and merge-train rollbacks start below `passed_train` (`rollback_before_train`). They are bookkeeping, not an incident.
- Subjects are cut to 256 characters before the dedupe, so two very long subjects (only client-chosen promotion-state ids can be that long) that share a prefix dedupe as one; their `console.warn` lines still both fire.
- Flood control, over a **trailing hour** (sliding, not clock hours): one row per (subject, reason), and at most 100 rows overall; the row that reaches the cap has `detail.capReached = true` (later violations while the trailing hour is full are only in the logs). Because the window slides, `capReached` can repeat as soon as the oldest row leaves it. `subject` is truncated to 256 characters. Rows are never purged.
- Measurement (dashboard SQL editor), excluding e2e data: `SELECT reason, json_extract(detail,'$.rule') AS rule, json_extract(detail,'$.source') AS source, COUNT(*) FROM governance_events WHERE event = 'invalid_transition' AND created_at >= ? AND COALESCE(json_extract(detail,'$.orgName'),'') NOT LIKE 'test-org-e2e-%' GROUP BY 1,2,3 ORDER BY 4 DESC;` Cross-check the total against the `invalid_transition` warn count in Workers logs; any `capReached` row means the table undercounts that hour.
- Rollback: no schema change; an older build ignores the rows.

## Near-misses (PR-B, 2026-11-01)

- The Spec DO writes a `near_misses` row in the same transaction as each loss: the loser of a decided trial (`trial_loss`), a candidate that newly becomes `eliminated` or `disqualified` in a tournament (`tournament_loss`), a merge-train car that fails or is rolled back, or is removed while still waiting or merging (`train_drop`, one fact per car: `<train>#<position>`, so a re-added car that fails again is a second fact; a car or candidate created already lost counts too; a car's position is treated as immutable, and a direct PATCH that renumbers a waiting or merging car records a false `removed` fact), the candidate that was live when a deploy ref is rolled back (`slo_rollback`; the evidence carries the actual reason, a manual rollback included), and every failed gate run (`gate_fail`). A redelivered write cannot add a second row (`UNIQUE(candidate_id, reason, source_ref)`, `INSERT OR IGNORE`). The allowed reasons live in `workers/shared/near-miss.ts`.
- Near-misses are filed under the candidate's own spec when the candidate row exists (ledger records carry free-string spec ids). Evidence over 8192 UTF-8 bytes is replaced by `{truncated: true, bytes}`.
- Read: `GET /api/near-misses?specId=&candidateId=&reason=&limit=&offset=` (read scope). An older Spec DO answers 404 for it; the edge reports 503.
- **Behavior change:** `POST /api/trials/:id/decide` now refuses an already-decided trial (409), a winner that is not one of the trial's two candidates (400) and an unknown trial (404). Re-deciding used to rewrite the winner silently. Nothing in the repo re-decides: the CLI `decide` (and `tests/cli-behavior.test.ts`) calls it once, and the e2e suite never calls it. While a Spec DO build older than PR-B is deployed (rollback), a re-decide is accepted again: it rewrites the winner and leaves the first `trial_loss` row, which then contradicts the trial.
- Purge: `near_misses` rows of a purged organization go with it, and rows whose candidate is already gone (left by a build older than m14) are swept by the next purge that selects an organization. They appear in the plan as `counts.near_misses`.

## Retired: candidate execute (2026-11-02)

`POST /api/candidates/:id/execute` answers **410** `{success:false, error, code:'route_retired'}` at the edge (without calling the Spec DO, whatever the body) and at the Spec DO (before reading the body or the candidate). User tokens still get 403 first. The sandbox path was broken end to end (`docs/plans/retire-execute-plan.md`). Use the gate-runs flow (`POST /api/candidates/:id/gate/pre-merge`, `/api/gate-runs`) for test execution. Note that gate runs write a gate verdict, not a candidate stage or `commit_sha`; who writes `passed_premerge` and `commit_sha` is an open M5a-2 item. A rollback to an older build restores the old broken route.

