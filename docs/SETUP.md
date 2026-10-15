---
category: setup
status: active
audience: human,agent
tags:
  - self-hosting
  - guide
---

# Setup

Verified 2026-10-15 on Node 22.23 / wrangler 4.x. Items marked **UNVERIFIED** could not be
checked without a fresh Cloudflare account.

## 1. Local development

```bash
npm ci
npm run typecheck        # 2 known errors in workers/api/ui-semantic.ts (see Known issues)
npm test                 # unit tests; e2e files need local workers (below)
```

Every worker fails closed without `API_AUTH_TOKEN` (`workers/shared/auth.ts`), including
locally. Create a `.dev.vars` (gitignored) next to each wrangler config you run:

```bash
printf 'API_AUTH_TOKEN=test-auth-token-12345\n' > .dev.vars
printf 'API_AUTH_TOKEN=test-auth-token-12345\n' > workers/shadow-router/.dev.vars
printf 'API_AUTH_TOKEN=test-auth-token-12345\n' > workers/canary-worker/.dev.vars
printf 'API_AUTH_TOKEN=test-auth-token-12345\n' > workers/promotion-worker/.dev.vars
```

The token must match `tests/e2e/config.ts` (`local.apiToken`).

### Ports the local e2e tests expect

| Worker | Port | Command |
|---|---|---|
| beehive (API + Spec DO) | 8787 | `npx wrangler dev --port 8787 --inspector-port 9229` |
| shadow-router | 8788 | `npx wrangler dev --config workers/shadow-router/wrangler.toml --port 8788 --inspector-port 9230` |
| canary-worker | 8789 | `npx wrangler dev --config workers/canary-worker/wrangler.toml --port 8789 --inspector-port 9231` |
| promotion-worker | 8790 | `npx wrangler dev --config workers/promotion-worker/wrangler.toml --port 8790 --inspector-port 9232` |

Give each its own `--inspector-port`, otherwise concurrent `wrangler dev` runs collide.
Then `npm run test:e2e:local`. Despite older docs, local e2e makes real HTTP calls and does
not use mocks; with no workers running you get `ECONNREFUSED`.

### Local e2e status

All four workers start and answer `/health`. `tests/e2e/helpers.ts` previously omitted the
`Authorization` header for local runs (every call 401); fixed 2026-10-15.

After that fix, `cross-worker-flows.test.ts` still has **22 failing tests**. They call routes
the workers do not implement:

| Test calls | Worker actually routes |
|---|---|
| `/canary/slo/config`, `/canary/slo/metrics` | `/slo-status` |
| `/canary/deployments/:id[/rollback]` | `/deploy-canary`, `/rollback`, `/canary-deployments/:id` |
| `/shadow/config` | `/statsig/config`, `/statsig/presets`, `/statsig/classify` |
| `/promotion/mode`, `/promotion/health`, `/promotion/candidates/:id/status`, `/promotion/merge-train/:id` | `/promote/:id`, `/promote/:id/retry`, `/promote/:id/cancel` |

Either the tests or the workers need to change; this is test/implementation drift, not an
environment problem. `m3-features.test.ts` and `oracle-ladder.test.ts` pass or skip.

## 2. Deploying your own copy

Deploys run from `.github/workflows/deploy.yml` on every push to `main` (never run
`wrangler deploy` by hand on the upstream account). To self-host in another account:

### a. Things hardcoded to the original account (change these)

| Where | Value |
|---|---|
| `wrangler.toml` `[vars]` | `CLOUDFLARE_ACCOUNT_ID`, `ALLOWED_GITHUB_USERS` (the `deploy` scripts override the account ID via `--var`) |
| `cli/src/index.ts`, `cli/src/utils/config.ts`, `cli/src/utils/api-client.ts`, `cli/src/commands/auth.ts` | default API URL `https://beehive.bz23711.workers.dev` |
| `workers/shadow-router/config.ts:145` | `beehive-main` preview URL |
| `tests/e2e/config.ts` | `production` URLs |
| `scripts/*.sh`, `scripts/test-workers-builds.ts` | `bz23711` subdomain |

### b. GitHub Actions secrets

`CLOUDFLARE_ACCOUNT_ID`, `WORKERS_SUBDOMAIN`, `CLOUDFLARE_API_TOKEN`
(scopes: Workers Scripts:Edit, Workers Queues:Edit; new scopes take minutes to propagate).

### c. Queues (create before first deploy)

The workflow creates only `canary-rollback-triggers` and `promotion-events`. The configs also
reference these five, which a fresh account must create by hand:

```bash
npx wrangler queues create beehive-artifacts-push
npx wrangler queues create preview-artifacts-push
npx wrangler queues create preview-artifacts-events
npx wrangler queues create beehive-scientist-comparisons
npx wrangler queues create preview-scientist-comparisons
```

### d. Worker secrets (after the first deploy)

```bash
for w in beehive beehive-gate-workflow beehive-sandbox-runner beehive-queue-consumer \
         beehive-shadow-router beehive-scientist-comparator beehive-preview-manager \
         beehive-candidate-service beehive-canary-worker beehive-promotion-worker; do
  wrangler secret put API_AUTH_TOKEN -n $w
done
# beehive only:
wrangler secret put CLOUDFLARE_API_TOKEN -n beehive
wrangler secret put GITHUB_CLIENT_ID -n beehive       # web UI login
wrangler secret put GITHUB_CLIENT_SECRET -n beehive
```

The web UI is served by the `beehive` worker (`/login` -> GitHub OAuth -> `/app`); only users
in `ALLOWED_GITHUB_USERS` can sign in. Create a GitHub OAuth app whose callback is on your
worker's URL.

### e. Validated and unvalidated

- Validated: all ten workers bundle with `wrangler deploy --dry-run`.
- **UNVERIFIED**: a first deploy to an empty account. `beehive` has a service binding to
  `beehive-gate-workflow`, while the gate workflow binds the `SpecDO` class from `beehive`
  via `script_name`; the cross-reference may need a two-pass first deploy.
- **UNVERIFIED**: Artifacts access and Workers Builds API use need an account with those
  products enabled (`docs/ARTIFACTS-SETUP.md`).
- Wiping the ledger: see `docs/OPS.md`.

## Known issues

- `npm run typecheck`: `workers/api/ui-semantic.ts:1130,1135` `'root.children' is possibly
  'undefined'`. CI does not run typecheck, so deploys are unaffected.
- `workers/sandbox-runner` still has commented-out `env.ARTIFACTS` / `env.SANDBOX` calls; no
  worker config binds either.
