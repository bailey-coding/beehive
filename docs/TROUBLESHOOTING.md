---
category: setup
status: active
audience: human,agent
tags:
  - debug
  - issues
---

# Beehive Troubleshooting Guide

> **Status:** Verified learnings from M1 + M2 verification  
> **Last updated:** 2026-10-12  
> **Target:** Quick diagnosis and resolution for common pipeline issues

This guide captures real learnings from end-to-end verification. Check here first when something isn't working.

---

## 🔍 Symptom Index

| Symptom | Likely Cause | Solution |
|---------|--------------|----------|
| Git clone prompts for username | Wrong auth syntax or mock token | [Git Authentication](#git-authentication) |
| Token is a UUID (not `art_v2_...`) | Missing `CLOUDFLARE_API_TOKEN` | [Missing API Token](#missing-cloudflare_api_token) |
| GitHub Actions: Dependencies lock file not found | `package-lock.json` in `.gitignore` with `cache: 'npm'` | [GitHub Actions Package Lock](#github-actions-package-lock) |
| URL is `artifacts.dev` (not `.artifacts.cloudflare.net`) | Mock mode active | [Mock vs Real](#mock-vs-real-artifacts) |
| Push succeeds but no verdict recorded | Webhook not configured or queue not processing | [Queue Not Processing](#queue-not-processing-push-events) |
| `repo required` error in logs | Wrong parameter name in token creation | [Token API Parameter](#cloudflare-token-api-parameter-name) |
| Foreign key constraint on spec creation | Missing `X-Actor-ID` header | [Actor Header Required](#actor-header-required) |
| 409 Conflict on fork creation | Repo already exists | [Delete Existing Repos](#repo-already-exists) |
| Service binding returns 401/403 | Missing service token or wrong binding | [Service Binding Authentication](#service-binding-authentication) |
| Workers Builds returns "Invalid queueID" | Using queue name instead of UUID | [Queue ID vs Queue Name](#queue-id-vs-queue-name) |
| Queues API returns "Required at body" | Missing body wrapper in message | [Queue Message Format](#queue-message-format) |
| Workers Builds needs more permissions | Token missing Workers:Edit scope | [Workers Builds Token Scopes](#workers-builds-token-scopes) |
| Foreign key constraint on spec creation | Missing actor in database | [Database Foreign Keys](#database-foreign-keys) |
| SQLite "no such column" error | Schema migration needed for existing DOs | [SQLite Schema Migration](#sqlite-schema-migration) |
| Worker returns `1042` | Worker not deployed yet (e.g. after `wrangler delete`) | [Deploy and ledger-wipe errors](#deploy-and-ledger-wipe-errors) |
| 403 right after granting token scopes | Permission propagation delay | [Deploy and ledger-wipe errors](#deploy-and-ledger-wipe-errors) |
| `KV namespaces ... Authentication error` from `wrangler delete` | Harmless | [Deploy and ledger-wipe errors](#deploy-and-ledger-wipe-errors) |
| `ECONNREFUSED` on 8787-8790 in local e2e | Local workers not running | [Local dev and e2e](#local-dev-and-e2e) |
| 401 from a local worker / every local e2e call | Missing or mismatched `.dev.vars` token, or client sends no bearer | [Local dev and e2e](#local-dev-and-e2e) |

---

## 🚨 Common Issues & Fixes

### Missing CLOUDFLARE_API_TOKEN

**Symptoms:**
- Tokens are UUIDs (`bd1a8afe-...`)
- Repository URLs are `https://artifacts.dev/...` instead of `https://{accountId}.artifacts.cloudflare.net/git/...`
- Artifacts integration silently falls back to mocks

**Root Cause:**
The `CLOUDFLARE_API_TOKEN` environment variable was not passed to the workers. The `createFork` and `createRepoToken` functions in `artifacts.ts` fall back to mock implementations when API calls fail.

**Solution:**
Pass `CLOUDFLARE_API_TOKEN` to all workers:
```bash
npx wrangler dev --local --port 8787 \
  --var CLOUDFLARE_ACCOUNT_ID:$CLOUDFLARE_ACCOUNT_ID \
  --var API_AUTH_TOKEN:$API_AUTH_TOKEN \
  --var CLOUDFLARE_API_TOKEN:$CLOUDFLARE_API_TOKEN
```

The token is automatically loaded from `~/.config/cloudflare/config/default.json` by the startup scripts.

**Verification:**
```bash
# Token should start with art_v2_ or cfat_
curl -s -H "Authorization: Bearer $BEEHIVE_API_TOKEN" \
  "http://localhost:8787/api/specs/$SPEC_ID/claim" | jq '.data.token'
# Should NOT be a UUID
```

---

### GitHub Actions Package Lock

**Symptoms:**
- GitHub Actions workflow fails at "Setup Node.js" step
- Error: `Dependencies lock file is not found. Supported file patterns: package-lock.json,npm-shrinkwrap.json,yarn.lock`
- `actions/setup-node@v4` with `cache: 'npm'` is in use

**Root Cause:**
The repository's `.gitignore` file explicitly ignores `package-lock.json` (following Cloudflare Workers recommendation). However, `actions/setup-node@v4` with `cache: 'npm'` requires a lock file to be present for caching to work.

**Solution:**
Remove the `cache` option from the `actions/setup-node` step:

```yaml
# ✅ CORRECT - No cache option
- name: Setup Node.js
  uses: actions/setup-node@v4
  with:
    node-version: '22'

# ❌ WRONG - Requires package-lock.json
- name: Setup Node.js
  uses: actions/setup-node@v4
  with:
    node-version: '22'
    cache: 'npm'  # Removed
```

**Alternative solutions:**
1. Remove `/package-lock.json` from `.gitignore` and commit the lock file
2. Use a different cache strategy (e.g., cache the `node_modules` directory manually)

**Note:** Cloudflare Workers recommends against `package-lock.json` because Wrangler uses esbuild for bundling, which doesn't rely on lock files. Using `npm install` without caching is the simplest approach.

---

### Cloudflare Token API Parameter Name

**Symptoms:**
- Claim returns real repository URL but UUID token
- Logs show: `Error creating repo token: Error: Failed to create token: 400 Bad Request - {"result":null,"success":false,"errors":[{"code":10100,"message":"repo required","pointer":"/repo"}]}`

**Root Cause:**
The `createRepoToken` function in `artifacts.ts` was sending `repository_name` but Cloudflare's API expects `repo`.

**Fix:**
```typescript
// workers/shared/artifacts.ts
const requestBody = {
  scope,
  ttl,
  repo: repoName,  // ✅ Changed from repository_name
};
```

**Commit:** `3b6d36f`

---

### Git Authentication

**Symptoms:**
- Git clone prompts for username/password
- `http.extraHeader` not being recognized

**Root Cause:**
Incorrect syntax for passing the Authorization header to git.

**Working Syntax:**
```bash
# ✅ CORRECT - Double quotes, -c flag BEFORE git verb
git -c http.extraHeader="Authorization: Bearer $TOKEN" clone <url>

# ✅ CORRECT - For push
git -c http.extraHeader="Authorization: Bearer $TOKEN" push origin main
```

**Not Working:**
```bash
# ❌ WRONG - Single quotes prevent proper parsing
git -c 'http.extraHeader=Authorization: Bearer $TOKEN' clone <url>

# ❌ WRONG - -c flag AFTER clone doesn't work
git clone -c "http.extraHeader=Authorization: Bearer $TOKEN" <url>
```

**Note:** Requires git **2.39+** (released Q4 2023). The `http.extraHeader` config option was added in this version.

---

### Mock vs Real Artifacts

**How to tell which mode you're in:**

| Aspect | Mock Mode | Real Mode |
|--------|-----------|-----------|
| Repository URL | `https://artifacts.dev/{namespace}/{repoName}` | `https://{accountId}.artifacts.cloudflare.net/git/{namespace}/{repoName}.git` |
| Token format | UUID (`bd1a8afe-683b-4994-b7d7-93d8b69f8efb`) | `art_v2_x_...` or `cfat_...` |
| Repo creation | Instant, no API call | Calls Cloudflare REST API |

**When Mock Mode Activates:**
- `CLOUDFLARE_API_TOKEN` not set in worker environment
- API call to `POST /accounts/:account_id/artifacts/namespaces/:namespace/repos` fails
- Falls back to `createMockFork` which generates UUID tokens

**For Development:** Mock mode is intentional and acceptable. For production verification, ensure real tokens are used.

---

### Queue Not Processing Push Events

**Symptoms:**
- Push succeeds but no gate verdict is recorded
- Queue consumer logs show no activity after push

**Root Causes & Solutions:**

1. **Webhook Not Configured (Production)**
   - Cloudflare Artifacts needs webhook configuration pointing to your queue
   - Solution: Set up webhook via Cloudflare dashboard or cf CLI

2. **Queue Doesn't Exist**
   - The `beehive-artifacts-push` queue must exist
   - Solution: `wrangler queues create beehive-artifacts-push`

3. **Local Dev - No Real Queue**
   - In local dev (`wrangler dev`), the queue consumer connects to the local dev registry
   - Cloudflare webhooks still fire to the real queue, not the local dev consumer
   - **Solution for testing:** Manually trigger gate workflow (see below)

**Manual Trigger for Local Dev:**
```bash
curl -s -X POST http://localhost:8788/gates/pre-merge \
  -H "Authorization: Bearer dev-local-spike-token" \
  -H "Content-Type: application/json" \
  -d '{
    "candidateId": "$CANDIDATE_ID",
    "specId": "$SPEC_ID",
    "commitSha": "$(git rev-parse HEAD)",
    "baseCommitSha": "$(git rev-parse HEAD~1)",
    "actorId": "$ACTOR_ID"
  }'
```

**Note:** In our verification, the real Cloudflare webhook DID fire and the queue consumer DID process it automatically in local dev. The pipeline worked end-to-end without manual triggering.

---

### Actor Header Required

**Symptoms:**
- Spec creation fails with: `FOREIGN KEY constraint failed: SQLITE_CONSTRAINT`
- Error mentions `created_by` foreign key

**Root Cause:**
The `created_by` field in the specs table references `actors(id)`. If the `X-Actor-ID` header is missing, `created_by` defaults to `'unknown'` which doesn't exist in the actors table.

**Solution:**
Always include the `X-Actor-ID` header:
```bash
curl -X POST http://localhost:8787/api/specs \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "X-Actor-ID: $ACTOR_ID" \  # ✅ Required
  -H "Content-Type: application/json" \
  -d '...'
```

**Existing Actors:**
```bash
# List actors to find a valid ID
curl -s -H "Authorization: Bearer dev-local-spike-token" \
  "http://localhost:8787/api/actors" | jq '.data[] | {id, name}'
```

---

### Repo Already Exists

**Symptoms:**
- Claim fails with: `409 Conflict - repo already exists: candidate-...`
- Fallback to mock data (UUID token, artifacts.dev URL)

**Root Cause:**
The `claimSpec` function tries to create a new repository with a name derived from the spec ID and actor ID. If that repo already exists from a previous claim, the API returns 409 Conflict, which triggers the mock fallback.

**Solutions:**

1. **Delete existing repo via cf CLI:**
   ```bash
   cf artifacts namespaces repos list default | grep candidate-
   cf artifacts namespaces repos delete <repo-name> --namespace default
   ```

2. **Create a new spec with unique name** (generates new repo name):
   ```bash
   curl -X POST http://localhost:8787/api/specs \
     -H "Authorization: Bearer $API_TOKEN" \
     -H "X-Actor-ID: $ACTOR_ID" \
     -d '{"name":"unique-name-'$(date +%s)",...}'
   ```

**Repo Naming Convention:**
```
candidate-{specId.slice(0,8)}-{agentId.slice(0,8)}
```

---

### Service Binding Authentication

**Symptoms:**
- Service-to-service calls return 401 Unauthorized
- Queue-consumer logs show: `Failed to call Preview Manager: Error: 401`
- Preview-manager health check works but API calls fail

**Root Cause:**
The `API_AUTH_TOKEN` secret is not set on the preview-manager worker, or the token doesn't have the required permissions. Service bindings between Workers use the same auth mechanism as external requests.

**Solution:**
Ensure `API_AUTH_TOKEN` is set as a secret on ALL workers that need to communicate:

```bash
# Set the same token on all workers
wrangler secret put API_AUTH_TOKEN --name beehive-queue-consumer
wrangler secret put API_AUTH_TOKEN --name beehive-preview-manager
wrangler secret put API_AUTH_TOKEN --name beehive-scientist-comparator
wrangler secret put API_AUTH_TOKEN --name beehive-candidate-service

# Verify with health checks
curl -H "Authorization: Bearer $API_AUTH_TOKEN" https://beehive-preview-manager.bz23711.workers.dev/health
```

**Note:** Service bindings use internal URLs (`https://preview-manager.internal`) but still require the same auth token.

---

---

### Database Foreign Keys

**Symptoms:**
- `FOREIGN KEY constraint failed: SQLITE_CONSTRAINT` when creating specs, repositories, or candidates
- `NOT NULL constraint failed` errors

**Root Cause:**
Production Spec DO is not seeded with test data. The seed only runs in local development (`DEV === 'local'`). Production database requires valid foreign key references:
- `specs.organization_id` must reference `organizations.id`
- `specs.created_by` must reference `actors.id`
- `repositories.organization_id` must reference `organizations.id`
- `repositories.spec_id` must reference `specs.id`
- `repositories.agent_id` must reference `actors.id`

**Solution:**
1. Create entities in the correct order: actor → organization → spec → repository → candidate
2. Use the `X-Actor-ID` header for all API requests (defaults to 'unknown' which doesn't exist)
3. For tests, create an actor first or use an existing one

**Example:**
```typescript
// Create actor first
const actor = await apiRequest('POST', '/actors', {
  type: 'agent',
  name: 'test-agent',
});

// Then use X-Actor-ID header
headers: {
  'Authorization': `Bearer ${token}`,
  'X-Actor-ID': actor.id,
}
```

---

### Workers Builds Token Scopes

**Symptoms:**
- Workers Builds API returns 401 or 403
- Logs show: `Workers Builds creation failed: Authentication error`
- Preview deployments fall back to simulated URLs

**Root Cause:**
The `CLOUDFLARE_API_TOKEN` needs **Workers:Edit** permission for Workers Builds API and **Queues:Edit** for queue message sending.

**Required Token Scopes:**
- `Workers:Edit` - For Workers Builds API
- `Queues:Edit` - For sending messages to queues via API
- `Account:Read` - For listing queues and account info

**Solution:**
1. **Check current token scopes:**
   ```bash
   npx wrangler whoami
   ```
   
2. **Create token with required scopes:**
   - Go to Cloudflare Dashboard → My Profile → API Tokens
   - Create token with template: **Workers:Edit**
   - Add **Queues:Edit** scope manually
   - Add **Account:Read** scope manually
   
3. **Set the token:**
   ```bash
   wrangler secret put CLOUDFLARE_API_TOKEN --name beehive-preview-manager --value "$TOKEN"
   ```

**Verification:**
```bash
# Test Workers Builds API access
curl -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts" | jq
# Should return list of workers, not auth error
```

---

### SQLite Schema Migration

**Symptoms:**
- Spec DO returns: `no such column: preview_url` (or any other column)
- Error code: `SQLITE_ERROR`
- Preview deployment fails with schema-related errors

**Root Cause:**
The Spec DO is a Durable Object that uses SQLite for storage. When the schema is updated (e.g., adding new columns to the `candidates` table), **existing DO instances do not automatically get the new columns**. The schema is only executed once when a new DO instance is created (tracked by the `schema_init` flag in the DO's storage).

**Why this happens:**
- Initial deploy: Spec DO schema created with columns A, B, C
- Later deploy: Schema updated to include columns D, E, F (preview_url, preview_worker_name, preview_created_at)
- Existing DOs: Still have the old schema with only A, B, C
- New DOs: Get the new schema with A, B, C, D, E, F

**Solution:**
A migration system was added to `workers/spec-do/index.ts` that:
1. Checks the current `schema_version` from the metadata table
2. Runs ALTER TABLE statements to add missing columns for existing databases
3. Updates the `schema_version` to mark the migration as complete

**The migration (from m1 to m2) adds:**
```sql
ALTER TABLE candidates ADD COLUMN preview_url TEXT;
ALTER TABLE candidates ADD COLUMN preview_worker_name TEXT;
ALTER TABLE candidates ADD COLUMN preview_created_at INTEGER;
```

**How to trigger the migration:**
1. **Automatic:** New requests to existing Spec DO instances will automatically run migrations on first access
2. **Manual trigger:** Send any request to the Spec DO (e.g., health check or list organizations)

**Note:** SQLite's `ALTER TABLE ADD COLUMN` is idempotent - running it on a table that already has the column will succeed silently (or with a benign error that we catch and ignore).

**Verifying the migration worked:**
```bash
# List candidates (triggers migration if needed)
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://beehive.bz23711.workers.dev/api/candidates" | jq '.data[0] | {id, preview_url}'

# Should show preview_url field (may be null for existing candidates)
```

**For production deployments:**
Once the maintainer deploys the updated code (push to the Artifacts repo; GitHub `main` runs CI only), this will happen:
1. Workers to redeploy with the new schema + migration logic
2. Existing Spec DO instances will run migrations on their next request
3. No data loss, no downtime

---

### Queue ID vs Queue Name

**Symptoms:**
- Cloudflare Queues API returns: `Invalid queueID` (error code 10107)
- List queues shows the queue exists but sending messages fails

**Root Cause:**
The Cloudflare Queues API requires the **queue UUID** (not the display name) for operations like sending messages. The display name (`preview-artifacts-push`) is different from the internal ID (`03ee3624015641b9a8204edd23716542`).

**Solution:**
Always resolve the queue name to its UUID before using it in API calls:

```javascript
// Get queue UUID from name
const queues = await cfApiRequest('GET', `/accounts/${ACCOUNT_ID}/queues`);
const queue = queues.find(q => q.queue_name === 'preview-artifacts-push');
const queueId = queue.queue_id; // Use this, not the name

// Then send message
const path = `/accounts/${ACCOUNT_ID}/queues/${queueId}/messages`;
await cfApiRequest('POST', path, { body: message });
```

**Queue UUID Format:** 32-character hexadecimal string (e.g., `03ee3624015641b9a8204edd23716542`)

---

### Queue Message Format

**Symptoms:**
- Cloudflare Queues API returns: `Required at "body"` (error code 10207)
- Message appears to be sent but queue consumer doesn't receive it

**Root Cause:**
The Cloudflare Queues API expects messages to be wrapped in a `body` field:

```json
{
  "body": { "your message content here" }
}
```

Not:
```json
{ "your message content here" }
```

**Solution:**
Wrap your message content in a `body` field:

```javascript
// ✅ CORRECT
const message = {
  body: {
    event: { ... },
    received_at: Date.now()
  }
};
await cfApiRequest('POST', queuePath, message);

// ❌ WRONG (direct message object)
await cfApiRequest('POST', queuePath, {
  event: { ... },
  received_at: Date.now()
});
```

**Verification:**
```bash
# Check queue message count (requires Queues:Read)
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/queues/03ee3624015641b9a8204edd23716542/messages" | jq '.result.messages'
```

---

---

### Worker Dependencies in GitHub Actions

**Symptoms:**
- GitHub Actions npm install fails with `ERESOLVE` errors
- Error: `Could not resolve dependency: peerOptional @cloudflare/workers-types@...`
- Worker deployment fails with `Could not resolve "zod"`

**Root Cause:**
When worker subdirectories have their own `package.json` files (e.g., `workers/scientist-comparator/package.json`), they list dependencies that may conflict with the root `package.json` or with each other. Running `npm install` only at the root does not install subdirectory dependencies.

**Solution:**
1. **Install dependencies in each worker directory:**
   ```yaml
   - name: Install worker dependencies (scientist-comparator)
     working-directory: workers/scientist-comparator
     run: npm install
   ```

2. **Align dependency versions:** Ensure `@cloudflare/workers-types` and other shared dependencies use compatible versions across all `package.json` files (root and worker-specific).

3. **For workers without their own package.json:** Dependencies from the root `package.json` will be found via parent directory resolution. Ensure `npm install` runs at the root.

**Verification:**
```bash
# Check installed versions in a worker directory
cd workers/scientist-comparator
npm ls @cloudflare/workers-types zod
```

### Local dev and e2e

**Symptoms:** `ECONNREFUSED 127.0.0.1:8787-8790`; every call returns 401; `wrangler dev` fails
with an inspector port already in use.

- Local e2e (`npm run test:e2e:local`) makes real HTTP calls; it does not use mocks. Start the
  four workers first on 8787 (api), 8788 (shadow-router), 8789 (canary), 8790 (promotion).
- Auth is fail-closed locally too. Put `API_AUTH_TOKEN=test-auth-token-12345` in `.dev.vars`
  next to each wrangler config; clients must send `Authorization: Bearer <token>`.
- Run concurrent `wrangler dev` processes with distinct `--inspector-port` values.
- Commands and ports: `docs/SETUP.md`.
- Spec DO answers 503 `SPEC_DO_INTERNAL_TOKEN not configured` (or `SPEC_DO_ADMIN_TOKEN ...` on a
  privileged route): the DO host (`beehive`) lacks the secret; locally, start through
  `scripts/start-e2e-workers.sh`. 401 from the DO: the calling worker has no `SPEC_DO_INTERNAL_TOKEN`
  or a different value. 403 on purge/tombstone/role/service-account routes: the caller holds only the
  tier-1 token (only `beehive` has the admin token). `docs/OPS.md` "Spec DO internal tokens".

### Deploy and ledger-wipe errors

- **`1042`**: the worker is not deployed yet. After `wrangler delete --name beehive --force`,
  ask the maintainer to redeploy `beehive` (deploy flow: `docs/OPS.md`). Agents never deploy.
- **Every Spec DO request fails right after a deploy** (`init failed`, 500s) while `beehive`'s
  `/health` still answers 200: the ledger stopped at the previous schema version because a migration
  step threw (by design: init fails loudly, the next request retries). The edge `/health` is static and
  never calls the DO, so use `./scripts/prod-health.sh` and read the `beehive` logs for
  `Migration to mN failed`. Seen: `service_accounts has an unexpected shape` (a table of another design
  was on the live ledger): if it is empty, `DROP TABLE service_accounts` and the next request
  recreates it, otherwise migrate its rows first (`docs/OPEN-QUESTIONS.md` 2026-10-16).
- **409 `version_required` / `version_conflict` from the Spec DO** on a tournament or merge train: an old
  promotion worker is still running, or a concurrent writer won; both clear on retry once every worker
  has deployed (`docs/OPS.md` "Promotion ledger concurrency").
- **403 right after granting scopes**: propagation takes minutes; wait and retry.
- **`KV namespaces ... Authentication error`** printed by `wrangler delete`: harmless.
- Secrets that live on `beehive` only must be re-put after a wipe (`API_AUTH_TOKEN`,
  `SPEC_DO_INTERNAL_TOKEN`, `SPEC_DO_ADMIN_TOKEN`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`). Procedure: `docs/OPS.md`.

---

## 📊 Health Check Commands

```bash
# Main API
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8787/health

# Spec DO (via API)
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8787/api/organizations

# Gate Workflow
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8788/health

# Queue Consumer
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8789/queue/health

# Sandbox Runner
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8790/health
```

Use `./scripts/health-check.sh` for the local dev workers. For the deployed ones use
`BEEHIVE_API_TOKEN=... ./scripts/prod-health.sh`: `/health` on `beehive` is static and passes even when the
Spec DO is broken, so the script also makes a request that reaches the DO.

---

## 🔧 Configuration Checklist

| Check | Command | Expected |
|-------|---------|----------|
| Git version | `git --version` | >= 2.39.0 |
| Node version | `node --version` | >= 22.0.0 |
| CLOUDFLARE_API_TOKEN set | `echo $CLOUDFLARE_API_TOKEN | head -c 10` | `art_v2_` or `cfat_` |
| CLOUDFLARE_ACCOUNT_ID set | `echo $CLOUDFLARE_ACCOUNT_ID | head -c 12` | Your account ID |
| Queue exists | `cf artifacts namespaces repos list default` | No errors |
| Workers running | `./scripts/health-check.sh` | All ✅ HEALTHY |

---

## 📞 Still Stuck?

1. **Check logs:** `tail -f /tmp/beehive-*.log`
2. **Verify credentials:** Ensure all tokens are set in worker environment
3. **Test with fresh spec:** Avoid repo name conflicts
4. **Review error messages:** Cloudflare API errors often include `pointer` fields showing exactly what's wrong

---

## 🎯 Quick Start for New Developers

```bash
# 1. Start all workers
./scripts/start-all.sh

# 2. Wait for initialization
sleep 15

# 3. Verify health
./scripts/health-check.sh

# 4. Create and claim a spec
SPEC_ID=$(curl -s -X POST http://localhost:8787/api/specs \
  -H "Authorization: Bearer dev-local-spike-token" \
  -H "X-Actor-ID: 1bfcea99-0308-4b05-a3ec-e91b8f4722b2" \
  -H "Content-Type: application/json" \
  -d '{"name":"test-$(date +%s)","description":"test","contract":"{}","declaredDeltaSurface":[],"organizationId":"4a6d4e70-9ed2-4a81-8358-730b37e2e236"}' | jq -r '.data.id')

CLAIM=$(curl -s -X POST "http://localhost:8787/api/specs/$SPEC_ID/claim" \
  -H "Authorization: Bearer dev-local-spike-token" \
  -H "X-Actor-ID: 1bfcea99-0308-4b05-a3ec-e91b8f4722b2" \
  -H "Content-Type: application/json" \
  -d '{"agentId":"1bfcea99-0308-4b05-a3ec-e91b8f4722b2"}')

# 5. Clone, commit, push (use token and URL from CLAIM response)
# 6. Check verdict
sleep 15
curl -s -H "Authorization: Bearer dev-local-spike-token" \
  "http://localhost:8787/api/candidates/$(echo $CLAIM | jq -r '.data.candidateId')/gate-verdicts" | jq

---

## 📚 References

### Official Cloudflare Documentation

- **[Wrangler Configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)** - Complete reference for `wrangler.toml` syntax
  - Analytics Engine: `[[analytics_engine_datasets]]` binding
  - Queues: `[[queues.producers]]` and `[[queues.consumers]]` bindings
  
- **[Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/)** - Query syntax, dataset management, and best practices

- **[Workers Queues](https://developers.cloudflare.com/workers/platform/queues/)** - Queue binding configuration and usage

- **[Cloudflare Artifacts](https://developers.cloudflare.com/workers/platform/artifacts/)** - Repository management, tokens, and API
- **[Workers Builds](https://developers.cloudflare.com/workers/platform/workers-builds/)** - Preview deployments and builds API
- **[Workers Queues](https://developers.cloudflare.com/workers/platform/queues/)** - Queue binding configuration and usage
```
