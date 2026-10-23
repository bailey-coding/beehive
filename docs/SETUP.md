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
(cd cli && npm install)  # tests/cli-behavior.test.ts runs the CLI via cli/node_modules/.bin/tsx; without this, `npm test` fails its 28 tests
npm run typecheck        # clean as of 2026-10-15; CI runs it
npm test                 # unit tests (excludes tests/e2e, which need running workers); this is what CI runs
npm run test:e2e:local   # e2e against local workers (start them first, below)
```

Every worker fails closed without `API_AUTH_TOKEN` (`workers/shared/auth.ts`), including
locally. For plain `wrangler dev`, create a `.dev.vars` (gitignored) next to each wrangler config you run.
`scripts/start-e2e-workers.sh` does not need them: it passes `API_AUTH_TOKEN` to every worker as a `--var`:

```bash
printf 'API_AUTH_TOKEN=test-auth-token-12345\n' > .dev.vars
printf 'API_AUTH_TOKEN=test-auth-token-12345\n' > workers/shadow-router/.dev.vars
printf 'API_AUTH_TOKEN=test-auth-token-12345\n' > workers/canary-worker/.dev.vars
printf 'API_AUTH_TOKEN=test-auth-token-12345\n' > workers/promotion-worker/.dev.vars
printf 'API_AUTH_TOKEN=test-auth-token-12345\n' > workers/preview-manager/.dev.vars
```

The token must match `tests/e2e/config.ts` (`local.apiToken`).

The Spec DO also checks its own two-tier internal tokens (`workers/shared/spec-do-auth.ts`;
secrets and per-worker distribution: `docs/OPS.md` "Spec DO internal tokens"). `scripts/start-e2e-workers.sh`
generates fresh random values on every start and passes them with `--var`, so nothing goes in
`.dev.vars` and nothing is committed: the `beehive` worker gets `SPEC_DO_INTERNAL_TOKEN` and
`SPEC_DO_ADMIN_TOKEN`, every other worker only `SPEC_DO_INTERNAL_TOKEN`. Starting workers by hand
(the commands below) needs the same, e.g. `--var SPEC_DO_INTERNAL_TOKEN:local-internal
--var SPEC_DO_ADMIN_TOKEN:local-admin` on beehive and `--var SPEC_DO_INTERNAL_TOKEN:local-internal`
on the others (same value); without them every Spec DO call answers 503/401. Export either variable
before running the script to pin a value.

### Ports the local e2e tests expect

| Worker | Port | Command |
|---|---|---|
| beehive (API + Spec DO) | 8787 | `npx wrangler dev --port 8787 --inspector-port 9229` |
| shadow-router | 8788 | `npx wrangler dev --config workers/shadow-router/wrangler.toml --port 8788 --inspector-port 9230` |
| canary-worker | 8789 | `npx wrangler dev --config workers/canary-worker/wrangler.toml --port 8789 --inspector-port 9231` |
| promotion-worker | 8790 | `npx wrangler dev --config workers/promotion-worker/wrangler.toml --port 8790 --inspector-port 9232` |
| preview-manager | 8791 | `npx wrangler dev --config workers/preview-manager/wrangler.toml --port 8791 --inspector-port 9234 --var WORKER_VERSIONS_MODE:stub --var BEEHIVE_LOCAL_DEV:1` |
| e2e probe (local only, never deployed) | 8792 | started by the script from `tests/e2e/probe/wrangler.toml`: a worker holding only the tier-1 token, used by `tests/e2e/spec-do-auth.test.ts` |

Give each its own `--inspector-port`, otherwise concurrent `wrangler dev` runs collide.
`scripts/start-e2e-workers.sh` starts all five (and the probe) in order (beehive first: it hosts the Spec DO,
and local bindings only connect to running `wrangler dev` sessions). It refuses to start if
any of 8787-8792 is taken, and a worker counts as healthy only on a 2xx (`curl -f`; a missing
token answers 503). PIDs go to `.e2e-workers.pids`; `scripts/stop-e2e-workers.sh` stops
only those processes and their children. `WORKER_VERSIONS_MODE=stub` together with
`BEEHIVE_LOCAL_DEV=1` (the local-only signal, set only by the start script) makes preview-manager's
canary route mint a local stub version (`stub-<uuid>`) instead of answering 501; nothing calls
the Cloudflare API. `stub` alone is not enough: a deployed worker answers 501 either way.
Then `npm run test:e2e:local`. Production is unreachable from tests unless `E2E_ENVIRONMENT=production` and `E2E_ALLOW_PRODUCTION=1` are both set (human approval required, AGENTS.md). Despite older docs, local e2e makes real HTTP calls and does
not use mocks; with no workers running you get `ECONNREFUSED`.

### Local e2e status

Verified 2026-10-16 (`main` after the ledger CAS change, schema m8) with `scripts/start-e2e-workers.sh`
and `npm run test:e2e:local`: **56 passed, 5 skipped, 0 failed**. (No `.dev.vars` files are needed: the
script passes `API_AUTH_TOKEN` as a `--var`, which is also how CI runs it.) The 5 skips are the m3 health
checks for workers with no local port (gate-workflow, sandbox-runner, queue-consumer,
candidate-service, scientist-comparator). Before canary deploy/rollback
(spine item 2) it was 44 passed, 7 skipped, 6 failed.

UI issue pages (2026-10-17, branch `agent/m8-issues-ui`): start the workers with `E2E_UI=1 scripts/start-e2e-workers.sh`,
which gives the `beehive` worker (only) dummy `GITHUB_CLIENT_ID/SECRET` and `ALLOWED_GITHUB_USERS`, so `/app` answers
instead of 503. OAuth is never exercised; `tests/e2e/ui-issues.test.ts` forges the session cookie with `signSession`
and the local `API_AUTH_TOKEN`. Without `E2E_UI=1` that file skips itself. With it: **63 passed, 5 skipped, 0 failed**
(the same 5 skips; 7 of the passes are `ui-issues`). Local only, never production.

Worker routes the tests use (the old `/canary/*`, `/shadow/*`, `/promotion/*` prefixes do not exist):

| Worker | Routes |
|---|---|
| api (8787) | `/health` and `/api/health` answer `{ success, data: { status, version, timestamp, checks } }` |
| shadow-router (8788) | `/health`, `/statsig/config` (`splits` includes each live canary, read from the Spec DO deploy refs), `/statsig/presets`, `/statsig/preset/:name`, `POST /statsig/classify` |
| canary-worker (8789) | `/health`, `/slo-status`, `POST /deploy-canary` (answers `{ success, deployment, deployRef }`), `POST /rollback` (a deploy-ref move), `GET /canary-deployments/:deploymentId`, `GET /canary-deployments?candidateId=`, `GET/POST /canary/:candidateId/auto-rollback` |
| preview-manager (8791) | `/health`, `POST /api/preview/deploy`, `POST /api/preview/canary` (answers `{ url, versionId }`; 501 unless `WORKER_VERSIONS_MODE=stub` and `BEEHIVE_LOCAL_DEV=1`) |
| promotion-worker (8790) | `/health` (and `/promotion/health`), `GET/POST /mode` (answers `{ success, mode }`), `POST /promote`, `GET /promote/:candidateId` (ledger row under `state`), `/tournament[/status\|/list]`, `/merge-train[/status\|/list]`, `/merge/retry`, `/merge/rollback`, `/stats`, `/promote/:id/retry`, `/promote/:id/cancel` |

There is no `/tournament/start` or `/merge-train/start`: tournaments and trains are joined
implicitly by `POST /promote` in the matching mode. A spec's tournament completes once it has
two candidates and refuses more (500), so e2e tests use a unique `specId` per run.

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
# Spec DO internal tokens (docs/OPS.md "Spec DO internal tokens"): a HARD prerequisite, put them
# BEFORE the first deploy that contains the check, or every Spec DO call fails closed.
# Tier 1 (same value everywhere): the DO host and every worker that calls the DO.
for w in beehive beehive-gate-workflow beehive-queue-consumer beehive-shadow-router \
         beehive-scientist-comparator beehive-preview-manager beehive-candidate-service \
         beehive-canary-worker beehive-promotion-worker; do
  wrangler secret put SPEC_DO_INTERNAL_TOKEN --name $w
done
# Tier 2: beehive ONLY
wrangler secret put SPEC_DO_ADMIN_TOKEN --name beehive
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

- `workers/sandbox-runner` still has commented-out `env.ARTIFACTS` / `env.SANDBOX` calls; no
  worker config binds either.
