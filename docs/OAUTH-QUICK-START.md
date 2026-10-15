---
category: integration
status: active
audience: human,agent
tags:
  - quick-start
  - oauth
---

# OAuth Integration Quick Start

> **Beehive Platform - Authentication Setup Guide**  
> Version: 1.0 | Last Updated: 2026-10-13

This quick start guide helps you set up OAuth and API authentication for GitHub and Cloudflare integration with the Beehive platform.

---

## TL;DR - What You Need to Do

### For M4 Submission (Required)
1. ✅ **Cloudflare API Token** - Set on ALL workers
2. ✅ **Cloudflare Account ID** - Set on ALL workers
3. ✅ **API_AUTH_TOKEN** - Already configured for worker-to-worker auth

### For Full Integration (Optional)
4. ✅ **GitHub OAuth App** - Web UI login (done; see section 3)

---

## Quick Setup Commands

### 1. Cloudflare API Token (CRITICAL)

```bash
# Create token at: https://dash.cloudflare.com/profile/api-tokens
# With permissions: Workers:Edit, Workers Queues:Edit, Artifacts:Edit, Accounts:Read

# Set on all workers
wrangler secret put CLOUDFLARE_API_TOKEN -n beehive
wrangler secret put CLOUDFLARE_API_TOKEN -n beehive-gate-workflow
wrangler secret put CLOUDFLARE_API_TOKEN -n beehive-sandbox-runner
wrangler secret put CLOUDFLARE_API_TOKEN -n beehive-queue-consumer

# Set account ID on all workers
wrangler secret put CLOUDFLARE_ACCOUNT_ID -n beehive
wrangler secret put CLOUDFLARE_ACCOUNT_ID -n beehive-gate-workflow
wrangler secret put CLOUDFLARE_ACCOUNT_ID -n beehive-sandbox-runner
wrangler secret put CLOUDFLARE_ACCOUNT_ID -n beehive-queue-consumer
```

### 2. Local Development (Required)

Create or update `.dev.vars`:

```
# .dev.vars - MUST be in .gitignore

# Beehive internal auth (use same token for all)
API_AUTH_TOKEN=your-dev-token-here
BEEHIVE_API_TOKEN=your-dev-token-here

# Cloudflare (REQUIRED for Artifacts)
CLOUDFLARE_API_TOKEN=cfat_your_token_here
CLOUDFLARE_ACCOUNT_ID=your_account_id_here
```

### 3. GitHub OAuth (implemented — web UI login)

The `beehive` worker serves the browser UI (`/login`, `/app`) with GitHub OAuth.
Only GitHub logins listed in `ALLOWED_GITHUB_USERS` can sign in.

```bash
# Create OAuth App at: https://github.com/settings/applications/new
# Homepage URL:  https://beehive.bz23711.workers.dev
# Callback URL:  https://beehive.bz23711.workers.dev/auth/callback   (must match exactly)

# Set on the beehive worker only. Put the values in .env first and pipe them in
# so they never appear in a terminal or chat:
#   printf '%s' "$GITHUB_CLIENT_ID" | wrangler secret put GITHUB_CLIENT_ID --name beehive
wrangler secret put GITHUB_CLIENT_ID --name beehive
wrangler secret put GITHUB_CLIENT_SECRET --name beehive
```

Allowlist (non-secret) lives in root `wrangler.toml`:

```toml
[vars]
ALLOWED_GITHUB_USERS = "bailey-coding"   # comma-separated GitHub logins
```

Add to `.dev.vars` for local `wrangler dev`. A GitHub OAuth App has one callback URL, so a full
local login needs a separate dev OAuth App with callback `http://localhost:8787/auth/callback`;
without it the routes still work up to the GitHub redirect:

```
GITHUB_CLIENT_ID=your_client_id
GITHUB_CLIENT_SECRET=your_client_secret
API_AUTH_TOKEN=any-local-value
```

Session cookies are signed with `API_AUTH_TOKEN`, so rotating that token signs everyone out.
---

## Required Scopes & Permissions

### GitHub OAuth Scopes

| Use Case | Required Scopes |
|----------|-----------------|
| User authentication only | `read:user, user:email` |
| Issues integration (public repos) | `read:user, user:email, public_repo` |
| Full repository and issue access | `repo, read:user, user:email` |

### Cloudflare API Token Permissions

| Permission | Required | Purpose |
|------------|----------|---------|
| `Workers Scripts:Edit` | ✅ Yes | Deploy workers |
| `Workers Queues:Edit` | ✅ Yes | Manage queues |
| `Artifacts:Edit` | ✅ Yes | **Critical** - Repository operations |
| `Accounts:Read` | ✅ Yes | Account access |
| `Analytics:Read` | ⚠️ No | Metrics (optional) |
| `D1:Edit` | ⚠️ No | Future use |

---

## Verification Checklist

### Cloudflare API Token
- [ ] Token created with all required permissions
- [ ] Token value copied and stored securely
- [ ] Token set as Worker secret on all 4 workers
- [ ] Account ID set as Worker secret on all 4 workers

### Local Development
- [ ] `.dev.vars` file created
- [ ] All required variables present
- [ ] `.dev.vars` added to `.gitignore`

### Connectivity Tests
```bash
# Test Cloudflare API
curl -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID

# Test Artifacts
curl -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/artifacts/namespaces

# Test Beehive API
curl -H "Authorization: Bearer $BEEHIVE_API_TOKEN" \
  http://localhost:8787/api/specs
```

---

## OAuth Flow Summary

### GitHub OAuth Flow
```
User → Beehive UI → GitHub OAuth → GitHub Callback → Beehive API → JWT Token
```

### Cloudflare API Token Flow
```
Worker → Cloudflare API → Artifacts/Workers/Queues Operations
```

### Beehive Internal Auth Flow
```
Client → Beehive API → Worker → authGate() → Allow/Deny
```

---

## Common Issues & Fixes

### Issue: "403 Forbidden" on Artifacts API
**Cause:** Free Workers plan doesn't include Artifacts  
**Fix:** Upgrade to paid plan at https://dash.cloudflare.com/<account-id>/workers/plans

### Issue: "API_AUTH_TOKEN not configured" (503 error)
**Cause:** Missing API_AUTH_TOKEN secret  
**Fix:** Set secret on all workers: `wrangler secret put API_AUTH_TOKEN -n <worker>`

### Issue: "wrangler secret put" fails with 403
**Cause:** API token lacks Workers Scripts:Edit permission  
**Fix:** Update Cloudflare API token permissions

### Issue: Token propagation delay
**Cause:** Cloudflare permissions take time to propagate  
**Fix:** Wait 2-3 minutes and retry

---

## Security Checklist

- [ ] No tokens committed to git
- [ ] All production tokens stored as Worker secrets
- [ ] Local tokens in `.dev.vars` (gitignored)
- [ ] Minimal permissions granted
- [ ] Tokens rotated periodically

---

## Need More Details?

For comprehensive documentation, see:
- [OAUTH-INTEGRATION.md](./OAUTH-INTEGRATION.md) - Full integration guide
- [ARCHITECTURE.md](./ARCHITECTURE.md) - System architecture
- [ARTIFACTS-SETUP.md](./ARTIFACTS-SETUP.md) - Cloudflare Artifacts setup

---

## M4 Submission Requirements

For the competition submission deadline (2026-10-14), ensure:

**✅ Required:**
- Cloudflare API Token configured on all workers
- Cloudflare Account ID configured on all workers
- API_AUTH_TOKEN configured for worker-to-worker auth
- Artifacts integration functional

**⚠️ Optional:**
- GitHub OAuth App created and secrets set (done 2026-10-13)
- GitHub OAuth login implemented in `workers/api/ui.ts`

**Note:** `API_AUTH_TOKEN` still secures the REST API and worker-to-worker calls; the browser UI uses its own signed session.
