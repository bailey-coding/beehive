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
- TODO(maintainer): document the Artifacts deploy repo name/URL, the exact pull/push commands,
  and what in the Artifacts repo triggers the deploy (a Workers Build per worker, or the
  `npm run deploy:*` scripts run by hand).
- TODO(maintainer): document where `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and
  `WORKERS_SUBDOMAIN` now live for deploys (the GitHub Actions secrets are no longer used), and
  whether the `canary-rollback-triggers` / `promotion-events` queues are still created at deploy
  time (the old workflow ran `wrangler queues create` for them).

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
Code: `workers/api/ui.ts`. Access is limited to `ALLOWED_GITHUB_USERS` (var in root
`wrangler.toml`); secrets `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are set on `beehive`.
Sessions are HMAC-signed with `API_AUTH_TOKEN`. The React app in `ui/` is **not built or
deployed** (no build config); don't assume it is live.

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
- **Deploy order:** `beehive-shadow-router` now binds `SpecDO` from `beehive` (`script_name`),
  like canary-worker and preview-manager, so deploy `beehive` first.
- A candidate a live ref points at cannot be tombstoned or purged (409), like an active promotion.

### Last resort: wipe the whole ledger

**Destructive and irreversible; human approval required.** Prefer tombstone + purge above.
This deletes every ledger row and the `beehive` worker secrets. To wipe it (done 2026-10-13 to clear 27 `test-org-e2e-*` orgs left by E2E runs against
production; the maintainer cleared them in the Cloudflare dashboard, which also works): `wrangler delete --name beehive --force`, then redeploy `beehive` through the maintainer's normal deploy flow (see "Deploy flow"), then re-put
the secrets that live on `beehive`: `API_AUTH_TOKEN`, `CLOUDFLARE_API_TOKEN`,
`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`. Other workers keep their own secrets. A `1042`
response means the worker is not deployed yet.
The `KV namespaces ... Authentication error` printed by `wrangler delete` is harmless.

Symptom lookup for deploy and auth failures: `docs/TROUBLESHOOTING.md`. First-time setup and
self-hosting: `docs/SETUP.md`. See `docs/OPEN-QUESTIONS.md` for dated findings (Artifacts behavior, wrangler config
gotchas, deploy learnings).
