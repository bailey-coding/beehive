---
category: guide
status: draft
milestone: m6
audience: user
tags:
  - getting-started
  - security
  - ci
  - ocap
---

# OCAP CI Security — Quick Start

**10-minute guide to setting up service-scoped CI security in Beehive.**

---

## Prerequisites

- Beehive account and repository
- Cloudflare API token with Workers permissions
- Basic understanding of CI/CD concepts

---

## Choose Your Pattern

Beehive supports two patterns. Pick one:

| Pattern | Best For | Complexity |
|---------|----------|------------|
| **Polyrepo** | Independent services | Simple |
| **Monorepo** | Shared code, cross-cutting changes | Medium |

---

## Option A: Polyrepo (Recommended)

Each service lives in its own repository.

### Step 1: Create Service Repositories

```bash
# Create separate repos for each service
beehive repo create payment-service
beehive repo create auth-service
beehive repo create notification-service
```

### Step 2: Register Services

Each repo auto-registers as a service. Verify:

```bash
beehive service list --repo payment-service
# Output: payment-service (repo: payment-service, path: "")
```

### Step 3: Define Capabilities

```bash
# Grant payment-service access to its worker and queue
beehive service capability add payment-service \
  --resource worker:payment-worker \
  --action deploy

beehive service capability add payment-service \
  --resource queue:payment-events \
  --action write
```

### Step 4: Generate CI Tokens

```bash
# Generate a token for payment-service CI
beehive service token generate payment-service --ttl 1h > .github/tokens/payment-service.token

# Generate a token for auth-service CI
beehive service token generate auth-service --ttl 1h > .github/tokens/auth-service.token
```

### Step 5: Configure GitHub Actions

**.github/workflows/deploy-payment.yml**
```yaml
name: Deploy Payment Service

on:
  push:
    branches: [main]
    paths: ['**']  # All files in this repo

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Deploy
        env:
          BEEHIVE_TOKEN: ${{ secrets.PAYMENT_SERVICE_TOKEN }}
        run: |
          beehive deploy --token $BEEHIVE_TOKEN
```

**GitHub Secrets Setup:**
- Add `PAYMENT_SERVICE_TOKEN` secret with content from `.github/tokens/payment-service.token`

---

## Option B: Monorepo

Multiple services in a single repository.

### Step 1: Create Monorepo

```bash
beehive repo create acme-services
cd acme-services
```

### Step 2: Define Services in beehive.yml

**beehive.yml**
```yaml
services:
  payment:
    path: services/payment
    deploy_target: payment-worker
    capabilities:
      - worker:payment-worker:deploy
      - queue:payment-events:write
      
  auth:
    path: services/auth
    deploy_target: auth-worker
    capabilities:
      - worker:auth-worker:deploy
      - queue:auth-events:write
      
  shared:
    path: lib/shared
    deploy_target: null  # Library, no deployment
    capabilities:
      - worker:*:read  # Read access to all workers
```

### Step 3: Register Services

```bash
# Beehive auto-detects from beehive.yml on push
# Or manually:
beehive service register --repo acme-services --path services/payment --target payment-worker
beehive service register --repo acme-services --path services/auth --target auth-worker
```

### Step 4: Generate CI Tokens

```bash
# Token for payment service (scoped to its path)
beehive service token generate payment --ttl 1h > .github/tokens/payment.token

# Token for auth service
beehive service token generate auth --ttl 1h > .github/tokens/auth.token

# Token for shared library (read-only)
beehive service token generate shared --ttl 1h > .github/tokens/shared.token
```

### Step 5: Configure GitHub Actions

**.github/workflows/deploy-payment.yml**
```yaml
name: Deploy Payment Service

on:
  push:
    branches: [main]
    paths: ['services/payment/**']

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Deploy
        env:
          BEEHIVE_TOKEN: ${{ secrets.PAYMENT_SERVICE_TOKEN }}
        run: |
          cd services/payment
          beehive deploy --token $BEEHIVE_TOKEN
```

**.github/workflows/deploy-auth.yml**
```yaml
name: Deploy Auth Service

on:
  push:
    branches: [main]
    paths: ['services/auth/**']

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Deploy
        env:
          BEEHIVE_TOKEN: ${{ secrets.AUTH_SERVICE_TOKEN }}
        run: |
          cd services/auth
          beehive deploy --token $BEEHIVE_TOKEN
```

**GitHub Secrets Setup:**
- Add `PAYMENT_SERVICE_TOKEN` secret
- Add `AUTH_SERVICE_TOKEN` secret

---

## Verify It Works

### Test Service Isolation

```bash
# Try to deploy payment-service with auth token (should fail)
beehive deploy --token $AUTH_SERVICE_TOKEN --target payment-worker
# Error: Token not valid for service: payment-service

# Try to deploy auth-service with correct token (should succeed)
beehive deploy --token $AUTH_SERVICE_TOKEN --target auth-worker
# Success: Deployed auth-worker
```

### Test PR Validation

1. Create a PR that modifies `services/payment/main.ts`
2. Beehive checks: Does the PR author have `payment-service` capability?
3. If no: PR is blocked with message "Missing capability for service: payment-service"
4. If yes: PR proceeds through normal gates

---

## Common Issues

### "Token not valid for this service"

**Cause:** Using a token for the wrong service.

**Fix:** Ensure each workflow uses the token generated for its specific service.

### "Missing capability for service"

**Cause:** Actor doesn't have capability for a service they're trying to modify.

**Fix:** Grant capability or use a different actor:
```bash
beehive actor capability grant --actor user123 --service payment-service
```

### "Path not mapped to any service"

**Cause:** Modified file doesn't match any service's `path_prefix`.

**Fix:** Register the service or adjust the path:
```bash
beehive service register --repo my-repo --path services/new-service
```

---

## Next Steps

- [Read the full plan](./OCAP-CI-PLAN.md) for advanced configurations
- [Set up cross-service dependencies](#) (coming soon)
- [Configure human approval gates](#) for sensitive services
