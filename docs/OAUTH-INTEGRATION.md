---
category: integration
status: active
audience: human,agent
tags:
  - github
  - oauth
---

# OAuth Integration Guide - GitHub & Cloudflare

> **Beehive Platform Documentation**  
> Last updated: 2026-10-13  
> Status: Ready for implementation  
> Priority: M4 Submission Package

This document provides comprehensive guidance on integrating OAuth 2.0 authentication with **GitHub** and **Cloudflare** for the Beehive platform. It covers authentication flows, required scopes/permissions, and step-by-step setup instructions for client IDs and secrets.

---

## Overview

Both **GitHub** and **Cloudflare** support OAuth 2.0 authentication. However, the recommended approach differs:

| Platform | Recommended Auth Method | Primary Use Case |
|----------|------------------------|-----------------|
| **GitHub** | OAuth 2.0 (Authorization Code flow) | User authentication, issues integration |
| **Cloudflare** | API Tokens | Worker-to-Cloudflare API communication |

For Beehive's architecture, **Cloudflare API Tokens** are preferred over OAuth for programmatic access, while **GitHub OAuth** is used for human user authentication and GitHub-specific operations.

---

## Table of Contents

1. [GitHub OAuth 2.0](#1-github-oauth-20)
2. [Cloudflare Authentication](#2-cloudflare-authentication)
3. [Beehive Integration Architecture](#3-beehive-integration-architecture)
4. [Setup Instructions](#4-setup-instructions)
5. [Environment Variables](#5-environment-variables)
6. [Security Considerations](#6-security-considerations)
7. [Testing](#7-testing)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. GitHub OAuth 2.0

### Support Confirmation

✅ **GitHub fully supports OAuth 2.0** with Authorization Code, Device Authorization, and PKCE flows.

**Official Documentation:** https://docs.github.com/en/apps/oauth-apps/building-oauth-apps

### Required Scopes for Beehive

#### Minimal Scopes (Recommended)
For basic Beehive user authentication (login and actor mapping):

```
read:user, user:email
```

#### Extended Scopes (Full Integration)
For comprehensive GitHub integration including repository and issue operations. GitHub OAuth Apps have no separate issue or pull-request scopes; `repo` (or `public_repo`) covers them:

```
repo, read:org, read:user, user:email
```

#### Scope Reference Table

| Scope | Description | Required For | Notes |
|-------|-------------|--------------|-------|
| `read:user` | Read user profile data | User identification | Basic user info |
| `user:email` | Read user email addresses | Actor mapping | Essential for linking accounts |
| `public_repo` | Read/write access to public repositories, including issues and PRs | Issues on public repos | Narrower alternative to `repo` |
| `repo` | Full access to public and private repositories, including issues and PRs | Repository and issue operations | Broad; request only for full integration |
| `read:org` | Read organization data | Finding repos, checking permissions | Read-only |

**Note:** Since Beehive uses Cloudflare Artifacts for repository hosting, GitHub OAuth is primarily needed for **user authentication** and **issues integration** with the main Beehive repository.

### OAuth 2.0 Flow

#### Authorization Code Flow (Recommended)

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   User       │    │   Beehive    │    │   GitHub     │
│              │    │   (Client)    │    │   (Server)   │
└──────┬──────┘    └──────┬──────┘    └──────┬──────┘
       │                  │                  │
       │   1. User clicks  │                  │
       │   "Login with    │                  │
       │   GitHub"        │                  │
       │─────────────────►│                  │
       │                  │   2. Redirect to │
       │                  │   GitHub auth    │
       │                  │─────────────────►│
       │                  │                  │
       │                  │◄─────────────────│
       │                  │   3. GitHub       │
       │                  │   redirects back  │
       │                  │   with code      │
       │   4. Exchange    │                  │
       │   code for       │                  │
       │   access token   │─────────────────►│
       │                  │   POST /login/oauth/access_token
       │                  │                  │
       │◄─────────────────│                  │
       │   5. Access      │◄─────────────────│
       │   token          │   access_token    │
```

#### Token Endpoint

```http
POST https://github.com/login/oauth/access_token

Headers:
  Content-Type: application/json
  Accept: application/json

Request Body:
  {
    "client_id": "YOUR_GITHUB_CLIENT_ID",
    "client_secret": "YOUR_GITHUB_CLIENT_SECRET",
    "code": "AUTHORIZATION_CODE_FROM_REDIRECT",
    "redirect_uri": "YOUR_REGISTERED_REDIRECT_URI"
  }

Response (Success):
  {
    "access_token": "gho_16C7e42F292c6912E7710c838347Ae178B4a",
    "token_type": "bearer",
    "scope": "read:user,user:email"
  }
```

#### Get User Information

```http
GET https://api.github.com/user

Headers:
  Authorization: Bearer ACCESS_TOKEN
  Accept: application/vnd.github+json

Response:
  {
    "login": "username",
    "id": 123456,
    "node_id": "MDQ6VXNlcjEyMzQ1Ng==",
    "avatar_url": "https://avatars.githubusercontent.com/u/123456?v=4",
    "email": "user@example.com",
    "name": "User Name"
  }
```

### GitHub OAuth App Setup

#### Step 1: Create OAuth App

1. Navigate to: https://github.com/settings/applications/new
2. **Application Name:** `Beehive Platform`
3. **Homepage URL:** `https://your-beehive-domain.com` (or `http://localhost:8787` for development)
4. **Authorization Callback URL:** `https://your-beehive-domain.com/auth/github/callback`

#### Step 2: Configure Application Settings

- **Application Description:** "Agent-native version control and collaboration platform"
- **Enable Device Flow:** No (not needed for web applications)
- **Enable GitHub App:** No (use OAuth App instead for this use case)

#### Step 3: Generate Client Credentials

After creation, GitHub provides:
- **Client ID:** Public identifier (e.g., `Iv23li...`)
  - Can be shared publicly
  - Used in authorization requests
- **Client Secret:** Private key
  - **Keep this secret!**
  - Used in token exchange
  - Can generate new ones if compromised

#### Step 4: Configure in Beehive

Set the credentials as Worker secrets:

```bash
# For the main beehive worker (API router)
wrangler secret put GITHUB_OAUTH_CLIENT_ID -n beehive
wrangler secret put GITHUB_OAUTH_CLIENT_SECRET -n beehive
```

For local development, add to `.dev.vars`:

```
# .dev.vars (add to .gitignore)
GITHUB_OAUTH_CLIENT_ID=your_github_client_id
GITHUB_OAUTH_CLIENT_SECRET=your_github_client_secret
GITHUB_OAUTH_REDIRECT_URI=http://localhost:8787/auth/github/callback
```

---

## 2. Cloudflare Authentication

### OAuth vs API Tokens

Cloudflare supports both OAuth 2.0 and API Tokens. For Beehive's use case (**Workers accessing Cloudflare API**), **API Tokens are the recommended approach**.

| Feature | OAuth 2.0 | API Tokens |
|---------|-----------|-------------|
| User Auth | ✅ Yes | ❌ No |
| Server-to-Server | ⚠️ Possible | ✅ Best |
| Token Expiry | Configurable | No expiry |
| Permission Model | Scopes | Granular permissions |
| Beehive Use Case | Optional | **Recommended** |

**Official Documentation:**
- OAuth: https://developers.cloudflare.com/api/authentication/oauth/
- API Tokens: https://developers.cloudflare.com/fundamentals/api/get-started/create-token/

### Required Permissions for Beehive

For Beehive Workers to interact with Cloudflare services:

| Permission | Description | Required | Notes |
|------------|-------------|----------|-------|
| `Workers Scripts:Edit` | Read, write, delete Workers | ✅ Yes | Essential for worker deployment |
| `Workers Queues:Edit` | Read, write, delete Queues | ✅ Yes | For queue management |
| `Artifacts:Edit` | Read, write, delete Artifacts | ✅ Yes | **Critical** for repository operations |
| `Accounts:Read` | Read account information | ✅ Yes | For account access |
| `Analytics:Read` | Read Analytics Engine | ⚠️ Optional | For metrics access |
| `D1:Edit` | Read, write D1 databases | ⚠️ Optional | For future cross-spec queries |

### Cloudflare API Token Setup

#### Step 1: Create API Token

1. Navigate to: https://dash.cloudflare.com/profile/api-tokens
2. Click **"Create Token"**
3. Select **"Create Custom Token"**

#### Step 2: Configure Token Settings

**Token Name:** `Beehive Platform Token`

**Permissions:**
```
☑ Workers:Edit (All Accounts)
☑ Workers Queues:Edit (All Accounts)
☑ Artifacts:Edit (All Accounts)
☑ Accounts:Read (All Accounts)
☑ Analytics:Read (All Accounts) - Optional
☑ D1:Edit (All Accounts) - Optional for future use
```

**Account:** All accounts (or select specific account)
**Zone:** All zones (or select specific zones)

#### Step 3: Get Token Value

After creation:
- Cloudflare displays the **API Token** value **once**
- **Format:** `cfat_...` (account-owned token) or `cfut_...` (user token); legacy tokens are 40 characters with no prefix. `art_v2_...` is the Artifacts git token returned by `repos create` / `tokens create`, not a Cloudflare API token
- **Copy immediately** - this is your only chance to see it

#### Step 4: Configure in Beehive

Set as Worker secrets on **ALL workers**:

```bash
# For each worker
wrangler secret put CLOUDFLARE_API_TOKEN -n beehive
wrangler secret put CLOUDFLARE_API_TOKEN -n beehive-gate-workflow
wrangler secret put CLOUDFLARE_API_TOKEN -n beehive-sandbox-runner
wrangler secret put CLOUDFLARE_API_TOKEN -n beehive-queue-consumer
```

Also set the Cloudflare Account ID as a variable:

```bash
wrangler secret put CLOUDFLARE_ACCOUNT_ID -n beehive
```

For local development, add to `.dev.vars`:

```
# .dev.vars
CLOUDFLARE_API_TOKEN=cfat_...
CLOUDFLARE_ACCOUNT_ID=your_account_id
```

### Cloudflare REST API Usage

#### Authentication Header

All Cloudflare API requests use Bearer token authentication:

```http
GET https://api.cloudflare.com/client/v4/accounts/{account_id}/artifacts/namespaces

Headers:
  Authorization: Bearer {CLOUDFLARE_API_TOKEN}
  Content-Type: application/json
```

#### Common Endpoints for Beehive

| Operation | Endpoint | Method | Description |
|-----------|----------|--------|-------------|
| List Namespaces | `/accounts/{id}/artifacts/namespaces` | GET | List Artifacts namespaces |
| Create Repo | `/accounts/{id}/artifacts/namespaces/{ns}/repos` | POST | Create repository |
| Create Token | `/accounts/{id}/artifacts/namespaces/{ns}/tokens` | POST | Create repo token |
| Get Account | `/accounts/{id}` | GET | Get account info |
| List Workers | `/accounts/{id}/workers/scripts` | GET | List worker scripts |
| Create Queue | `/accounts/{id}/queues` | POST | Create queue |

---

## 3. Beehive Integration Architecture

### Recommended Hybrid Approach

```
┌─────────────────────────────────────────────────────────────────┐
│                    Beehive Authentication Architecture                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐     │
│  │   Human      │    │    Agent     │    │    Worker    │     │
│  │   User       │    │   (Autonomous)│    │   (Service)  │     │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘     │
│         │                   │                    │                │
│         │   GitHub OAuth    │                    │                │
│         │   (Authorization │                    │                │
│         │   Code Flow)     │                    │                │
│         ▼                   ▼                    ▼                │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                    Beehive API Router (beehive)                  │  │
│  │  - Validates GitHub OAuth tokens                                 │  │
│  │  - Maps GitHub users to Beehive actors                           │  │
│  │  - Issues Beehive JWT tokens (API_AUTH_TOKEN)                   │  │
│  └──────────────────────────────┬───────────────────────────────┘  │
│                                      │                               │
│                      ┌───────────────────────────┼───────────────┤
│                      │                           │               │
│               ┌──────▼──────┐            ┌──────────▼─────────┐     │
│               │  Spec DO    │            │  Other Workers       │     │
│               │  (Durable   │            │  (gate-workflow,     │     │
│               │   Object)   │            │   sandbox-runner,    │     │
│               │              │            │   queue-consumer)    │     │
│               │ - Actor     │            │                       │     │
│               │   records   │            │ - Use CLOUDFLARE_    │     │
│               │ - Auth      │            │   API_TOKEN for       │     │
│               │   validation│            │   Cloudflare API     │     │
│               │ - Token     │            │   operations          │     │
│               └──────┬──────┘            └──────────┬─────────┘     │
│                      │                           │                   │
│                      └───────────────────────────┼───────────────┘
│                                                  │
│                                  ┌───────────────▼───────────────┐
│                                  │   Cloudflare API Services       │
│                                  │   - Artifacts (repos & tokens)  │
│                                  │   - Workers (scripts, queues)   │
│                                  │   - Analytics Engine            │
│                                  │   - D1 Databases                │
│                                  └───────────────────────────────┘
│                                                                     │
└─────────────────────────────────────────────────────────────────┘
```

### Authentication Flows by Scenario

#### Scenario 1: Human User Authentication
```
1. User visits Beehive UI
2. Clicks "Login with GitHub"
3. Browser redirects to GitHub OAuth
4. User authorizes Beehive
5. GitHub redirects back with authorization code
6. Beehive exchanges code for access token
7. Beehive validates GitHub token
8. Beehive gets user info from GitHub API
9. Beehive creates/updates Actor record in Spec DO
10. Beehive issues JWT (BEEHIVE_API_TOKEN)
11. UI stores JWT and uses for all API requests
```

#### Scenario 2: Agent Operations
```
1. Agent claims spec via API
2. Beehive (via Spec DO) creates Artifacts repository
3. Beehive generates Artifacts token (via Cloudflare API)
4. Beehive returns to agent:
   - repository_url
   - artifacts_token (write token)
   - BEEHIVE_API_TOKEN (for Beehive API)
5. Agent uses tokens directly for operations
```

#### Scenario 3: Worker-to-Cloudflare API
```
1. Worker needs to call Cloudflare API (e.g., create repo)
2. Worker reads CLOUDFLARE_API_TOKEN from environment
3. Worker sends request with header:
   Authorization: Bearer <CLOUDFLARE_API_TOKEN>
4. Cloudflare validates and executes request
5. Worker processes response
```

#### Scenario 4: Worker-to-Worker Communication
```
1. Worker A needs to call Worker B
2. Worker A sends request with header:
   Authorization: Bearer <API_AUTH_TOKEN>
3. Worker B validates using authGate() from shared/auth.ts
4. If valid, request proceeds; else returns 401/503
```

---

## 4. Setup Instructions

### Phase 1: GitHub OAuth Setup (Optional for M4)

**Priority:** Low (Can be deferred; current auth uses API_AUTH_TOKEN)

1. **Create GitHub OAuth App**
   - Go to: https://github.com/settings/applications/new
   - Fill in application details
   - Set callback URL
   - Note Client ID and Client Secret

2. **Configure Beehive**
   ```bash
   # Set as Worker secrets
   wrangler secret put GITHUB_OAUTH_CLIENT_ID -n beehive
   wrangler secret put GITHUB_OAUTH_CLIENT_SECRET -n beehive
   ```

3. **Implement OAuth Flow** (Future)
   - Add `/auth/github` route to API router
   - Implement token exchange
   - Add actor mapping logic
   - Issue Beehive JWT tokens

### Phase 2: Cloudflare API Token Setup (Critical for M4)

**Priority:** High (Required for Artifacts integration)

1. **Create API Token**
   - Go to: https://dash.cloudflare.com/profile/api-tokens
   - Create custom token
   - Add all required permissions
   - Copy token value

2. **Configure All Workers**
   ```bash
   # For each worker (beehive, gate-workflow, sandbox-runner, queue-consumer)
   wrangler secret put CLOUDFLARE_API_TOKEN -n <worker-name>
   wrangler secret put CLOUDFLARE_ACCOUNT_ID -n <worker-name>
   ```

3. **Verify Configuration**
   ```bash
   # Test Artifacts API
   curl -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
     https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/artifacts/namespaces
   ```

### Phase 3: Internal Authentication (Already Implemented)

The existing `API_AUTH_TOKEN` system is already in place:

```bash
# Set on all workers (already done in current setup)
wrangler secret put API_AUTH_TOKEN -n beehive
wrangler secret put API_AUTH_TOKEN -n beehive-gate-workflow
wrangler secret put API_AUTH_TOKEN -n beehive-sandbox-runner
wrangler secret put API_AUTH_TOKEN -n beehive-queue-consumer
```

For local development:
```
# .dev.vars
API_AUTH_TOKEN=your-dev-token
BEEHIVE_API_TOKEN=your-dev-token
```

---

## 5. Environment Variables

### GitHub OAuth

```bash
# Required for GitHub OAuth flow
GITHUB_OAUTH_CLIENT_ID=your_github_client_id
GITHUB_OAUTH_CLIENT_SECRET=your_github_client_secret
GITHUB_OAUTH_REDIRECT_URI=https://your-beehive-domain.com/auth/github/callback

# Optional (for security)
GITHUB_OAUTH_STATE_SECRET=random_string_for_csrf_protection
```

### Cloudflare

```bash
# Required for Cloudflare API access
CLOUDFLARE_API_TOKEN=cfat_...
CLOUDFLARE_ACCOUNT_ID=your_account_id

# Optional (for OAuth flow, if used)
CLOUDFLARE_OAUTH_CLIENT_ID=your_cloudflare_client_id
CLOUDFLARE_OAUTH_CLIENT_SECRET=your_cloudflare_client_secret
```

### Beehive Internal

```bash
# Internal API authentication
API_AUTH_TOKEN=your_internal_token  # For worker-to-worker auth
BEEHIVE_API_TOKEN=your_internal_token  # For external clients

# JWT Configuration (if implementing JWT)
JWT_SECRET=your_jwt_signing_secret
JWT_EXPIRY=24h
```

### Complete Local Development Setup

Create `.dev.vars` file:

```
# .dev.vars - Add to .gitignore

# Beehive Internal Auth
API_AUTH_TOKEN=dev-api-token-12345
BEEHIVE_API_TOKEN=dev-api-token-12345

# Cloudflare (Required)
CLOUDFLARE_API_TOKEN=cfat_...
CLOUDFLARE_ACCOUNT_ID=bb21fa3c93c3cc02ac97b091b2d57811

# GitHub OAuth (Optional)
GITHUB_OAUTH_CLIENT_ID=Iv23li...
GITHUB_OAUTH_CLIENT_SECRET=your_github_client_secret
GITHUB_OAUTH_REDIRECT_URI=http://localhost:8787/auth/github/callback
```

---

## 6. Security Considerations

### Token Security Best Practices

1. **Never commit tokens to source control**
   - Add to `.gitignore`
   - Use environment variables or Worker secrets
   - Use `.dev.vars` for local development (already gitignored)

2. **Use minimal permissions**
   - Grant only necessary scopes/permissions
   - Avoid admin-level access when possible
   - Regularly audit token permissions

3. **Token rotation**
   - GitHub tokens: Auto-renew before 6-month expiry
   - Cloudflare API tokens: Manual rotation (no auto-expiry)
   - Beehive internal tokens: Regular rotation

4. **Audit logging**
   - Log authentication attempts (without token values)
   - Monitor token usage patterns
   - Alert on suspicious activity

### OAuth Security

1. **Always use HTTPS** for OAuth callbacks
2. **Validate state parameter** to prevent CSRF attacks
3. **Use PKCE** for public clients (if applicable)
4. **Store refresh tokens securely**
5. **Implement token revocation** on logout
6. **Rate limit** authentication endpoints

### Existing Implementation Notes

The current Beehive implementation already follows security best practices:
- ✅ Fail-closed authentication (`auth.ts`)
- ✅ No token → 503 (Service Unavailable)
- ✅ Wrong token → 401 (Unauthorized)
- ✅ Auth applies to every route including `/health`
- ✅ Worker secrets for production tokens

---

## 7. Testing

### GitHub OAuth Test

```bash
# Test token exchange
curl -X POST https://github.com/login/oauth/access_token \
  -H "Accept: application/json" \
  -d "client_id=$GITHUB_OAUTH_CLIENT_ID" \
  -d "client_secret=$GITHUB_OAUTH_CLIENT_SECRET" \
  -d "code=AUTH_CODE_FROM_REDIRECT"

# Test user info
curl -H "Authorization: Bearer GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/user
```

### Cloudflare API Test

```bash
# Test account access
curl -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID

# Test Artifacts API
curl -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/artifacts/namespaces

# Test repository creation
curl -X POST \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"test-repo"}' \
  https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/artifacts/namespaces/default/repos
```

### Beehive Integration Test

```bash
# Test with current setup
curl -H "Authorization: Bearer $BEEHIVE_API_TOKEN" \
  http://localhost:8787/api/specs

# Test worker-to-worker auth
curl -H "Authorization: Bearer $API_AUTH_TOKEN" \
  http://localhost:8787/health
```

---

## 8. Troubleshooting

### GitHub OAuth Issues

| Error | Cause | Solution |
|-------|-------|----------|
| `redirect_uri_mismatch` | Callback URL doesn't match GitHub settings | Update OAuth App settings in GitHub |
| `invalid_client` | Wrong client ID or secret | Verify GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET |
| `invalid_scope` | Requested scope not authorized | Update OAuth App scopes in GitHub |
| `bad_verification_code` | Code expired or invalid | Generate new authorization code |
| Token expires | 6 months passed | Refresh token or re-authenticate |

### Cloudflare API Issues

| Error | Code | Cause | Solution |
|-------|------|-------|----------|
| `403 Forbidden` | 403 | Missing permissions | Update API Token permissions |
| `401 Unauthorized` | 401 | Invalid or missing token | Verify CLOUDFLARE_API_TOKEN |
| `9103 Unknown X-Auth-Key` | 9103 | Using email/key auth instead of token | Use `Authorization: Bearer <token>` |
| Account not found | 404 | Wrong account ID | Verify CLOUDFLARE_ACCOUNT_ID |
| `"messages":[{"code":9103}]` | 403 | Token doesn't have required permission | Update token permissions |

### Common Setup Issues

**Issue:** `wrangler secret put` fails with 403
- **Cause:** Missing Worker permissions
- **Solution:** Grant `Workers Scripts:Edit` permission to your Cloudflare API token

**Issue:** Artifacts API returns 403
- **Cause:** Free Workers plan doesn't include Artifacts
- **Solution:** Upgrade to paid Workers plan at https://dash.cloudflare.com/<account-id>/workers/plans

**Issue:** Token propagation delay
- **Cause:** Cloudflare permissions take time to propagate
- **Solution:** Wait 2-3 minutes and retry

---

## References

### GitHub
- OAuth Apps Documentation: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps
- Scopes Reference: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps
- Authorization Code Flow: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
- GitHub REST API: https://docs.github.com/en/rest

### Cloudflare
- OAuth Documentation: https://developers.cloudflare.com/api/authentication/oauth/
- API Tokens: https://developers.cloudflare.com/fundamentals/api/get-started/create-token/
- REST API Reference: https://api.cloudflare.com/
- Artifacts API: https://developers.cloudflare.com/api/operations/artifacts-repositories-list
- Workers API: https://developers.cloudflare.com/api/operations/workers-scripts-list

### Cloudflare REST API Examples

```http
# List Artifacts namespaces
GET /accounts/{account_id}/artifacts/namespaces

# Create repository
POST /accounts/{account_id}/artifacts/namespaces/{namespace}/repos
Body: {"name": "repo-name"}

# Create repository token
POST /accounts/{account_id}/artifacts/namespaces/{namespace}/tokens
Body: {"scope": "write", "ttl": 3600, "repo": "repo-name"}

# Get account information
GET /accounts/{account_id}

# List Workers
GET /accounts/{account_id}/workers/scripts
```

---

## M4 Submission Checklist

For the competition submission, ensure the following OAuth/Authentication items are complete:

- [x] **Cloudflare API Token** configured on all workers
- [x] **CLOUDFLARE_ACCOUNT_ID** set on all workers
- [x] **API_AUTH_TOKEN** configured for worker-to-worker auth
- [x] **Artifacts integration** working with real Cloudflare API
- [ ] GitHub OAuth App created (Optional for M4)
- [ ] GitHub OAuth flow implemented (Optional for M4)

**Note:** GitHub OAuth is optional for M4. The current `API_AUTH_TOKEN` system provides sufficient authentication for the submission. GitHub OAuth can be added post-competition for enhanced user authentication.

---

## Next Steps

1. **Verify Cloudflare API Token** is set on all workers
2. **Test Artifacts integration** with real repositories
3. **Optional:** Set up GitHub OAuth for user authentication
4. **Document** any additional findings in `docs/OPEN-QUESTIONS.md`

---

*Document generated: 2026-10-13*  
*Status: Ready for implementation*  
*Owner: Beehive Development Team*
