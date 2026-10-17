# GitHub Actions Workflows

## `ci.yml` (CI only)

Runs on every `pull_request` and on every push to any branch, except changes that touch only
`docs/**` or `*.md` files (`paths-ignore`):

1. checkout, Node 22
2. `npm install` in the repo root and in the worker directories that have their own `package.json`
3. `npm run typecheck`
4. `npm test`

It needs no secrets and deploys nothing.

## `ci-enhanced.yml` (CI only)

Same triggers and the same `paths-ignore` as `ci.yml`. Clean per-worker install and `wrangler deploy
--dry-run` for each worker (catches dependency resolution failures like the zod one), then typecheck,
unit tests, migration/schema tests and local e2e tests. It needs no secrets and deploys nothing.

## `ci-skip.yml` (no-op)

Companion to `ci.yml`: on pull requests that touch only `docs/**` or `*.md` it reports a passing
`CI` / `Typecheck and unit tests` check, so that check can be made required without blocking docs-only
PRs. Keep its paths in sync with the `paths-ignore` lists in `ci.yml` and `ci-enhanced.yml`.
`ci-enhanced.yml` has no companion yet: if any of its jobs becomes a required check, add same-named
no-op jobs on the inverse paths.

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
