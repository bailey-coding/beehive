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
npm install        # package-lock.json is gitignored, so `npm ci` has nothing to use
npm run typecheck        # 2 known errors in workers/api/ui-semantic.ts (see Known issues)
npm test                 # tests/**, including tests/e2e: fails with ECONNREFUSED unless local workers run (below)
npx vitest run workers   # per-worker unit tests are not covered by `npm test`
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
Then `npm run test:e2e:local`. Production is unreachable from tests unless `E2E_ENVIRONMENT=production` and `E2E_ALLOW_PRODUCTION=1` are both set (human approval required, AGENTS.md). Despite older docs, local e2e makes real HTTP calls and does
not use mocks; with no workers running you get `ECONNREFUSED`.

### Local e2e status

All four workers start and answer `/health`. `tests/e2e/helpers.ts` previously omitted the
`Authorization` header for local runs (every call 401); fixed 2026-10-15.

After that fix, `cross-worker-flows.test.ts` still has **22 failing tests**. They call routes
the workers do not implement:

| Test calls | Worker actually routes |
|---|---|
| `/canary/slo/config`, `/canary/slo/metrics` | `/slo-status` |
| `/canary/deploy` | `/deploy-canary` |
| `/canary/deployments/:id` | `/canary-deployments/:id` (keyed by **candidate** ID, tests pass a deployment ID) |
| `/canary/deployments/:id/rollback` | `/rollback` |
| `/shadow/config` | `/statsig/config`, `/statsig/presets` |
| `/shadow/classify` | `/statsig/classify` |
| `/promotion/health` | exists (`workers/promotion-worker/index.ts:49`); its body assertion failed in one local run and passed in another, so re-check |
| `/promotion/mode` | `GET/POST /mode` |
| `/promotion/candidates/promote` | `POST /promote`, `GET /promote/:id` |
| `/promotion/merge-train/:id` | `/merge-train?specId=`, `/merge-train/status`, `/merge-train/list` |
| `/promotion/merge-train/start`, `/promotion/tournament/start` | **no equivalent** |

Other real promotion routes: `/tournament[/status|/list]`, `/merge/retry`, `/merge/rollback`,
`/stats`, `/promote/:id/retry`, `/promote/:id/cancel`. Most failures are test-side drift, but
the two `start` tests need new routes or deletion. `m3-features.test.ts` and
`oracle-ladder.test.ts` pass or skip.

## 2. Deploying your own copy

GitHub `main` runs CI only (`.github/workflows/ci.yml`) and does not deploy. Upstream deploys
come from the maintainer's push to the Cloudflare Artifacts repo (`docs/OPS.md`); never run
`wrangler deploy` by hand on the upstream account. To self-host in another account, deploy with
the `npm run deploy:*` scripts:

### a. Things hardcoded to the original account (change these)

| Where | Value |
|---|---|
| `wrangler.toml` `[vars]` | `CLOUDFLARE_ACCOUNT_ID`, `ALLOWED_GITHUB_USERS` (the `deploy` scripts override the account ID via `--var`) |
| `cli/src/index.ts`, `cli/src/utils/config.ts`, `cli/src/utils/api-client.ts`, `cli/src/commands/auth.ts` | default API URL `https://beehive.bz23711.workers.dev` |
| `workers/shadow-router/config.ts:145` | `beehive-main` preview URL |
| `tests/e2e/config.ts`, `tests/e2e/m3-features.test.ts:33-53` | `production` URLs (m3-features has its own map) |
| `.env.test.production:16-19`, `scripts/e2e-test.ts:40` | production URLs |
| `workers/shadow-router/tests/shadow.test.ts:216` | asserts the `bz23711` URL, so it breaks when `config.ts:145` changes |
| `scripts/*.sh`, `scripts/test-workers-builds.ts` | `bz23711` subdomain |

### b. Deploy credentials

The CI workflow needs none. For manual deploys set
`CLOUDFLARE_ACCOUNT_ID`, `WORKERS_SUBDOMAIN`, `CLOUDFLARE_API_TOKEN`
(scopes: Workers Scripts:Edit, Workers Queues:Edit; new scopes take minutes to propagate).

### c. Queues (create before first deploy)

No workflow creates queues any more (the old deploy workflow created only `canary-rollback-triggers` and `promotion-events`; create them by hand with `wrangler queues create`). The configs also
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
  wrangler secret put API_AUTH_TOKEN --name $w
done
# Artifacts token: beehive AND beehive-preview-manager (previews are simulated without it)
wrangler secret put CLOUDFLARE_API_TOKEN --name beehive
wrangler secret put CLOUDFLARE_API_TOKEN --name beehive-preview-manager
# beehive only:
wrangler secret put GITHUB_CLIENT_ID --name beehive       # web UI login
wrangler secret put GITHUB_CLIENT_SECRET --name beehive
```

The web UI is served by the `beehive` worker (`/login` -> GitHub OAuth -> `/app`); only users
in `ALLOWED_GITHUB_USERS` can sign in. Create a GitHub OAuth app whose callback is on your
worker's URL, path `/auth/callback`.

### e. Validated and unvalidated

- Validated: all ten workers bundle with `wrangler deploy --dry-run`.
- **UNVERIFIED**: a first deploy to an empty account. `beehive` has a service binding to
  `beehive-gate-workflow`, while the gate workflow binds the `SpecDO` class from `beehive`
  via `script_name`. The old `deploy.yml` order (and the `deploy:*` scripts) deploys queue-consumer, canary-worker and
  promotion-worker before preview-manager, though all three service-bind it. If Cloudflare
  rejects bindings to Workers that do not exist yet, re-running the deploy cannot break the
  cycle; a binding would have to be removed temporarily.
- **UNVERIFIED**: Artifacts access and Workers Builds API use need an account with those
  products enabled (`docs/ARTIFACTS-SETUP.md`).
- Wiping the ledger: see `docs/OPS.md`.

## Known issues

- `npm run typecheck`: `workers/api/ui-semantic.ts:1130,1135` `'root.children' is possibly
  'undefined'`. CI does not run typecheck, so deploys are unaffected.
- `workers/sandbox-runner` still has commented-out `env.ARTIFACTS` / `env.SANDBOX` calls; no
  worker config binds either.
