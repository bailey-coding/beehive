---
category: operations
status: active
audience: human,agent
---

# Deployment topology and ops (verified 2026-10-13)

Moved out of `AGENTS.md` (2026-10-15). The config rules and the fail-closed auth rule stay
in `AGENTS.md`; this file adds operational detail only.

Ten Workers on `*.bz23711.workers.dev`, deployed by `.github/workflows/deploy.yml` on every push to
`main` (it runs the `package.json` `deploy:*` scripts; each worker has its own wrangler config):

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

### Last resort: wipe the whole ledger

**Destructive and irreversible; human approval required.** Prefer tombstone + purge above.
This deletes every ledger row and the `beehive` worker secrets. To wipe it (done 2026-10-13 to clear 27 `test-org-e2e-*` orgs left by E2E runs against
production; the maintainer cleared them in the Cloudflare dashboard, which also works): `wrangler delete --name beehive --force`, push to `main` to redeploy, then re-put
the secrets that live on `beehive`: `API_AUTH_TOKEN`, `CLOUDFLARE_API_TOKEN`,
`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`. Other workers keep their own secrets. A `1042`
response means the worker is not deployed yet. When scripting the wait, watch the run for the
new SHA (`gh run watch <id>`); `gh run list --limit 1` can still return the previous run.
The `KV namespaces ... Authentication error` printed by `wrangler delete` is harmless.

Symptom lookup for deploy and auth failures: `docs/TROUBLESHOOTING.md`. First-time setup and
self-hosting: `docs/SETUP.md`. See `docs/OPEN-QUESTIONS.md` for dated findings (Artifacts behavior, wrangler config
gotchas, deploy learnings).
