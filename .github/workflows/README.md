# GitHub Actions Workflows

## `ci.yml` (CI only)

The only workflow. Runs on every `pull_request` and on every push to any branch, except changes that touch only
`docs/**` or `*.md` files (`paths-ignore`). It needs no secrets and deploys nothing. Jobs:

1. **Clean install and build verification:** per-worker install from a tree with no root `node_modules`, then
   `wrangler deploy --dry-run` for each `workers/*` config and for the root worker `beehive` (catches dependency
   resolution failures like the zod one).
2. **Typecheck**, **Unit tests**, **Migration and schema tests**, **E2E tests (local mode)**.

No check is required on `main` today (no branch protection or ruleset). If one becomes required, a docs-only PR
would leave it Pending: add a companion workflow with same-named no-op jobs on the inverse paths.

History: until 2026-10-25 there were `ci.yml` (typecheck + unit tests, which this workflow also runs), `ci-enhanced.yml`
(this file's content) and `ci-skip.yml` (a no-op companion for a required check that never existed).

## Deploys do not happen here

GitHub `main` is a source repo. Pushing to it (or merging a PR) does **not** deploy. Production
deploys come from the Cloudflare Artifacts repo, which the maintainer updates by hand after a
change lands on GitHub. See `docs/OPS.md`. The `npm run deploy:*` scripts in `package.json`
remain for manual use by the maintainer only.

## Local development

```bash
./scripts/start-all.sh
```

Starts all workers locally on ports 8787-8794. See `docs/SETUP.md`.
