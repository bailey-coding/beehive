---
category: setup
status: active
audience: human,agent
tags:
  - cloudflare
  - artifacts
---

# Cloudflare Artifacts Setup Guide

> **Beehive Project Internal Documentation**  
> Last updated: 2026-10-11  
> Status: Verified with paid Workers plan
>
> **Troubleshooting**: See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for integration issues

This guide documents the practical learnings from setting up Cloudflare Artifacts for the Beehive project. Use this as a reference for future repository creation and management.

---

## Prerequisites

### 1. Node.js Version

**Requirement:** Node.js >= 22.0.0

- cf CLI v1.0.0-beta.13 requires Node.js 22+
- Wrangler v4 requires Node.js 22+
- **Action:** Use a version manager (nvm, Volta) or upgrade system Node.js

---

## Authentication

Cloudflare supports multiple authentication methods. Each tool has specific requirements.

### OAuth Token (cf CLI)

Stored in `~/.config/cloudflare/config/default.json` after running `cf auth login`.

- ✅ Works with `cf` CLI for all operations
- ✅ Persists across sessions
- ❌ Does NOT work with `wrangler dev` in non-interactive mode
- ❌ Does NOT work with REST API directly

**Usage:**
```bash
cf auth login
cf artifacts namespaces list
```

### API Token (Environment Variable)

Set `CLOUDFLARE_API_TOKEN` for programmatic access.

- ✅ Works with `wrangler` for remote bindings
- ✅ Works with REST API
- ❌ Must be set in environment for each session
- ❌ **Keep out of source control**

**Usage:**
```bash
export CLOUDFLARE_API_TOKEN="art_v2_..."
wrangler dev
```

### Git Authentication

Use `http.extraHeader` to pass tokens without storing in `.git/config`:

```bash
git -c http.extraHeader="Authorization: Bearer $TOKEN" push origin main
git -c http.extraHeader="Authorization: Bearer $TOKEN" clone <remote> <dir>
```

**Why this method:**
- Token not stored in repository metadata
- Works with short-lived tokens
- Can be scripted without git config changes

---

## cf CLI Commands for Artifacts

### Namespace Management

| Command | Description |
|---|---|
| `cf artifacts namespaces list` | List all namespaces |
| `cf artifacts namespaces create --namespace <name>` | Create namespace |
| `cf artifacts namespaces get <namespace>` | Get namespace details |

### Repository Management

| Command | Description |
|---|---|
| `cf artifacts namespaces repos list --namespace <ns>` | List repos in namespace |
| `cf artifacts namespaces repos create <ns> --name <repo>` | Create repository |
| `cf artifacts namespaces repos get <repo> --namespace <ns>` | Get repo details |

### Token Management

| Command | Description |
|---|---|
| `cf artifacts namespaces tokens create <ns> --repo <repo> --scope <read/write> --ttl <seconds>` | Create Git token |
| `cf artifacts namespaces tokens list <ns>` | List tokens |

### Practical Examples

```bash
# Create namespace (one-time per account)
cf artifacts namespaces create --namespace default

# Create repository
cf artifacts namespaces repos create default --name beehive-url-shortener

# Create 24-hour write token for CI
cf artifacts namespaces tokens create default \
  --repo beehive-url-shortener \
  --scope write \
  --ttl 86400

# List all repos
cf artifacts namespaces repos list --namespace default
```

---

## Wrangler + Artifacts Binding

### Configuration

**cloudflare.config.ts:**
```typescript
import { defineConfig } from "cloudflare";

export default defineConfig({
  name: "your-worker",
  main: "src/index.ts",
  compatibilityDate: "2026-10-09",
  artifacts: [
    {
      binding: "ARTIFACTS",
      namespace: "default",
      remote: true  // Required - always connects to Cloudflare
    }
  ]
});
```

**Important Notes:**
- The ARTIFACTS binding **cannot** be simulated locally
- Setting `remote: true` is required (default behavior anyway)
- `wrangler dev` needs `CLOUDFLARE_API_TOKEN` in non-interactive mode
- For production, deploy normally — binding works without additional config

### Worker Code Example

```typescript
// src/index.ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    
    if (request.method === "POST" && url.pathname === "/repos") {
      const { name } = await request.json();
      const repo = await env.ARTIFACTS.create(name);
      
      return Response.json({
        name: repo.name,
        remote: repo.remote,
        token: repo.token
      });
    }
    
    return new Response("POST /repos to create repo", { status: 405 });
  }
};
```

---

## Git Operations with Artifacts

### Standard Push

```bash
# Set token
export ARTIFACTS_TOKEN="art_v2_x_...?expires=..."

# Push with header (recommended)
git -c http.extraHeader="Authorization: Bearer $ARTIFACTS_TOKEN" push origin main
```

### Clone

```bash
git -c http.extraHeader="Authorization: Bearer $ARTIFACTS_TOKEN" \
  clone https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/<namespace>/<repo>.git
```

### Self-Contained Remote URL

For short-lived commands (token embedded in URL):

```bash
TOKEN_SECRET="${ARTIFACTS_TOKEN%%\?expires=*}"
AUTH_REMOTE="https://x:${TOKEN_SECRET}@${ARTIFACTS_REMOTE#https://}"
git push "$AUTH_REMOTE" main
```

---

## Performance

| Operation | Time | Notes |
|---|---|---|
| Create namespace | ~2-3s | One-time |
| Create repo | ~2-3s | Per repo |
| First push | ~1-2s | Empty repo |
| Clone (small) | ~1s | <100MB |
| Push (subsequent) | <1s | Cached connection |

---

## Pricing

### Current (as of 2026-10-09)

| Resource | Free Tier | Overages |
|---|---|---|
| Operations | First 10,000/month | $0.15 per additional 1,000 |
| Storage | First 1 GB/month | $0.50 per additional GB-mo |

### Beehive PoC Estimates

| Usage | Operations | Storage | Cost |
|---|---|---|---|
| 2 repos, 100 commits each | ~200 | ~10MB | **$0.00** |
| 5 repos, 500 commits each | ~1,000 | ~50MB | **$0.00** |
| 20 repos, 2000 commits each | ~4,000 | ~200MB | **$0.00** |

**Billing starts:** October 14, 2026

**Recommendation:** PoC usage stays well within free allowances. Monitor via Cloudflare dashboard.

---

## Beehive Project Recommendations

### Naming Conventions

**Namespaces:**
- `default` — development/testing
- `beehive-prod` — production (future)

**Repository naming:**
```
beehive-{spec-name}-{agent-id}

# Examples:
beehive-url-shortener-agent-a
beehive-url-shortener-agent-b
beehive-url-shortener-agent-c
beehive-price-calculator-agent-1
```

### Token Strategy

| Use Case | Scope | TTL |
|---|---|---|
| Local development | write | 86400 (24h) |
| CI/CD pipeline | write | 3600 (1h) |
| Read-only clone | read | 1800 (30m) |
| Production deploy | write | 86400 (24h) |

### Git Configuration

**Never store tokens in:**
- `.git/config` (use `http.extraHeader`)
- `.git/credentials`
- Repository files

**Do store in:**
- `.env` files (add to `.gitignore`)
- CI/CD secrets manager
- Temporary environment variables

---

## Troubleshooting

### 403 Forbidden on Artifacts API

**Cause:** Free Workers plan does not include Artifacts access.

**Solution:** Upgrade to any paid Workers plan at:
https://dash.cloudflare.com/<account-id>/workers/plans

### "Binding ARTIFACTS needs to be run remotely"

**Cause:** Using `wrangler dev --local` with ARTIFACTS binding.

**Solution:** Either:
1. Remove `--local` flag: `wrangler dev`
2. Set `CLOUDFLARE_API_TOKEN` environment variable

### Authentication Error with cf CLI

**Cause:** Expired OAuth token.

**Solution:**
```bash
cf auth login
```

### Token Expired

**Solution:** Generate new token:
```bash
cf artifacts namespaces tokens create default \
  --repo <repo-name> \
  --scope write \
  --ttl 86400
```

---

## Quick Reference

```bash
# Full setup flow
export ACCOUNT_ID="bb21fa3c93c3cc02ac97b091b2d57811"

# Create namespace
cf artifacts namespaces create --namespace beehive-dev

# Create repo
cf artifacts namespaces repos create beehive-dev --name my-spec-agent-a

# Get repo info
REPO_INFO=$(cf artifacts namespaces repos get my-spec-agent-a --namespace beehive-dev)
REMOTE=$(echo "$REPO_INFO" | jq -r '.remote')

# Create token
TOKEN=$(cf artifacts namespaces tokens create beehive-dev \
  --repo my-spec-agent-a --scope write --ttl 86400 | jq -r '.plaintext')

# Push code
git -c http.extraHeader="Authorization: Bearer $TOKEN" push "$REMOTE" main
```

---

## Beehive Integration Implementation

The Artifacts integration has been implemented in the Beehive codebase with the following components:

### Implementation Files

| File | Purpose |
|---|---|
| `workers/shared/artifacts.ts` | Cloudflare Artifacts REST API client |
| `workers/spec-do/index.ts` | Updated `claimSpec()` to create real Artifacts repos |
| `workers/api/index.ts` | Updated API handler to pass through real repo data |

### Environment Configuration

All workers require the following environment variables:

```toml
# In each worker's wrangler.toml
[vars]
CLOUDFLARE_ACCOUNT_ID = "@cf-account-id"
```

Set the API token as a Worker secret:
```bash
# For each worker
wrangler secret put CLOUDFLARE_API_TOKEN
```

For local development, create a `.dev.vars` file (add to `.gitignore`):
```
CLOUDFLARE_ACCOUNT_ID=your_account_id
CLOUDFLARE_API_TOKEN=your_api_token
BEEHIVE_API_TOKEN=your_beehive_token
```

### Integration Flow

1. **Agent calls `/api/specs/{id}/claim`** with agent ID
2. **API router forwards to Spec DO** with actor ID
3. **Spec DO's `claimSpec()` method:**
   - Gets Artifacts config from environment
   - Calls `createFork()` in `artifacts.ts`
   - `createFork()` makes REST API call to Cloudflare
   - Creates repository in specified namespace
   - Generates write token via `createRepoToken()`
   - Returns repository metadata and token
4. **Spec DO persists** repository and candidate records to SQLite
5. **API returns** full response including real repository URL and token

### REST API Implementation Details

The `artifacts.ts` client uses Cloudflare's REST API v4:

- **Create Repository:** `POST /accounts/:account_id/artifacts/namespaces/:namespace/repos`
- **Create Token:** `POST /accounts/:account_id/artifacts/namespaces/:namespace/tokens`

Both endpoints require:
- `Authorization: Bearer <API_TOKEN>` header
- `Content-Type: application/json`

### Fallback Mode

When Cloudflare credentials are not available (e.g., local development without secrets):
- The implementation falls back to generating mock data
- Mock repositories use the `https://artifacts.dev/{namespace}/{repoName}` URL format
- Mock tokens are generated using `crypto.randomUUID()`
- All database records are still created with the mock data

This ensures development can continue without Cloudflare connectivity.

### Testing

Run the integration test script:
```bash
# Set required tokens
export BEEHIVE_API_TOKEN=your_beehive_token
export CLOUDFLARE_API_TOKEN=your_cf_token
export CLOUDFLARE_ACCOUNT_ID=your_account_id

# Run the test
./scripts/test-claim-integration.sh
```

The test will:
1. Create a test organization
2. Create a test spec
3. Claim the spec (triggers Artifacts integration)
4. Verify repository and candidate records in database
5. Optionally verify repository exists in Cloudflare (if credentials provided)

---

## Worker Deployment Configuration

Each worker's `wrangler.toml` includes the Artifacts configuration:

```toml
[vars]
CLOUDFLARE_ACCOUNT_ID = "@cf-account-id"
```

After deployment, set the secret:
```bash
wrangler secret put CLOUDFLARE_API_TOKEN
```

The secret is per-worker and does not propagate automatically.

