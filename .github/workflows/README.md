# GitHub Actions Workflows

## `ci.yml` (CI only)

Runs on every `pull_request` and on every push to any branch:

1. checkout, Node 22
2. `npm install` in the repo root and in the 7 worker directories that have their own `package.json`
3. `npm run typecheck`
4. `npm test`

It needs no secrets and deploys nothing.

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
