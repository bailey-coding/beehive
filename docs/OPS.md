---
category: operations
status: active
audience: human,agent
---

# Deployment topology and ops (verified 2026-10-13)

Moved out of `AGENTS.md` (2026-10-15). The two config rules and the fail-closed auth rule
remain in `AGENTS.md`.

Ten Workers on `*.bz23711.workers.dev`, deployed by `.github/workflows/deploy.yml` on every push to
`main` (it runs the `package.json` `deploy:*` scripts; each worker has its own wrangler config):

- `beehive` — edge router/API; hosts the `SpecDO` class (root `wrangler.toml`).
- `beehive-gate-workflow`, `beehive-sandbox-runner`, `beehive-queue-consumer` — configs
  at `workers/<name>/wrangler.toml`; the Spec DO is bound cross-script via
  `script_name = "beehive"`.
- M2/M3 workers: `beehive-shadow-router`, `beehive-scientist-comparator`,
  `beehive-preview-manager`, `beehive-candidate-service`, `beehive-canary-worker`,
  `beehive-promotion-worker`. Note the worker `name` in each `wrangler.toml` is the
  source of truth for URLs (older docs used shortened names).

**Web UI** (verified 2026-10-13): served by the `beehive` worker itself, not a separate
app. `/about` is public; `/login` -> GitHub OAuth -> `/app` (create orgs, repos, specs).
Code: `workers/api/ui.ts`. Access is limited to `ALLOWED_GITHUB_USERS` (var in root
`wrangler.toml`); secrets `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are set on `beehive`.
Sessions are HMAC-signed with `API_AUTH_TOKEN`. The React app in `ui/` is **not built or
deployed** (no build config); don't assume it is live.

Config rules that bit this repo twice:
- Service bindings take `binding = "..."`, never `name = "..."`.
- Queue consumers attach via `[[queues.consumers]]`; `[[queues]]` is the producer form.

Auth is fail-closed on every fetch entry point (`workers/shared/auth.ts`): missing
`API_AUTH_TOKEN` → 503, wrong bearer → 401, including `/health`. Set the secret on each
worker with `wrangler secret put API_AUTH_TOKEN`; local dev uses `.dev.vars` (gitignored);
tooling reads `BEEHIVE_API_TOKEN` from `.env` (gitignored).

Deploy token scopes: Workers Scripts:Edit + Workers Queues:Edit. Permission edits take
minutes to propagate — a fresh 403 right after granting scopes is expected; wait and
retry before debugging.

The Spec DO ledger has no delete routes. To wipe it (done 2026-10-13 to clear 27 `test-org-e2e-*`
orgs left by E2E runs against production): `wrangler delete --name beehive --force`, push to
`main` to redeploy, then re-put the secrets that live on `beehive` only: `API_AUTH_TOKEN`,
`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`. Other workers keep their own secrets. A `1042`
response means the worker is not deployed yet. When scripting the wait, watch the run for the
new SHA (`gh run watch <id>`); `gh run list --limit 1` can still return the previous run.
The `KV namespaces ... Authentication error` printed by `wrangler delete` is harmless.

Symptom lookup for deploy and auth failures: `docs/TROUBLESHOOTING.md`. First-time setup and
self-hosting: `docs/SETUP.md`. See `docs/OPEN-QUESTIONS.md` for dated findings (Artifacts behavior, wrangler config
gotchas, deploy learnings).
