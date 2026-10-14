# E2E Tests for Beehive M3 Features

## Overview

This directory contains end-to-end (E2E) tests for the Beehive M3 features, including:
- Statsig traffic splitting
- Canary deployments
- Promotion worker (tournament and merge-train modes)
- Cross-worker flow validation

## Test Structure

```
tests/e2e/
├── config.ts              # Environment configuration
├── auth.ts                # Authentication utilities
├── helpers.ts             # Test helper functions
├── m3-features.test.ts    # M3 feature tests (with mocks)
├── oracle-ladder.test.ts  # Oracle ladder tests
├── cross-worker-flows.test.ts  # Cross-worker integration tests
├── PRODUCTION_E2E_PLAN.md  # Detailed test plan
└── README.md              # This file
```

## Environment Configuration

The E2E tests support three environments:

| Environment | Base URL | Token Variable | Description |
|-------------|----------|----------------|-------------|
| local | `http://localhost:*` | `BEEHIVE_API_TOKEN` (mock) | Local development with mocks |
| staging | `*.staging.workers.dev` | `STAGING_API_TOKEN` | Staging environment |
| production | `beehive.bz23711.workers.dev` | `BEEHIVE_API_TOKEN` | Production environment |

## Quick Start

### Local Development (with mocks)

```bash
# Install dependencies
npm install

# Run E2E tests with local mocks
npm run test:e2e:local

# Or with watch mode
npm run test:e2e:watch
```

### Staging Environment

```bash
# Create .env.test.staging with your token
cp .env.test.staging.example .env.test.staging
# Edit .env.test.staging and add your STAGING_API_TOKEN

# Run staging tests
npm run test:e2e:staging
```

### Production Environment

```bash
# Create .env.test.production with your token
cp .env.test.production.example .env.test.production
# Edit .env.test.production and add your BEEHIVE_API_TOKEN

# Run production tests
npm run test:e2e:production
```

## Test Scripts

| Script | Description |
|--------|-------------|
| `npm test` | Run all tests (unit + E2E with mocks) |
| `npm run test:e2e` | Run E2E tests (environment from E2E_ENVIRONMENT) |
| `npm run test:e2e:local` | Run E2E tests with local mocks |
| `npm run test:e2e:staging` | Run E2E tests against staging |
| `npm run test:e2e:production` | Run E2E tests against production |
| `npm run test:e2e:watch` | Run E2E tests with watch mode (local) |
| `npm run test:coverage` | Run tests with coverage |

## Environment Files

Create the following environment files based on your needs:

### `.env.test.local` (for local development)
```
E2E_ENVIRONMENT=local
BEEHIVE_API_TOKEN=test-auth-token-12345
```

### `.env.test.staging` (for staging)
```
E2E_ENVIRONMENT=staging
STAGING_API_TOKEN=your_staging_api_token_here
```

### `.env.test.production` (for production)
```
E2E_ENVIRONMENT=production
BEEHIVE_API_TOKEN=your_production_api_token_here
```

## Configuration

### `config.ts`

Manages environment-specific configuration:
- Base URLs for each worker
- API tokens
- Timeouts and retry settings

### `auth.ts`

Handles authentication:
- Token management
- Request signing
- Environment validation

### `helpers.ts`

Provides test utilities:
- Request creation with auth
- Response parsing
- Error handling
- Retry logic
- Test ID generation

## Test Files

### `m3-features.test.ts`

Tests M3-specific features using mock handlers:
- Statsig traffic splitting configuration
- Request classification
- Canary deployment lifecycle
- SLO metrics and compliance
- Promotion worker modes
- Tournament and merge-train functionality

**Note**: This file uses mock handlers by default. To test against real endpoints, the tests need to be updated to use the config and auth utilities.

### `cross-worker-flows.test.ts`

Tests cross-worker integration:
- Health checks for all workers
- Statsig configuration flow
- Canary deployment flow
- Promotion worker flow
- Merge-train mode
- Tournament mode
- Oracle ladder complete flow
- Cross-worker data consistency
- Error handling
- Mode switching

### `oracle-ladder.test.ts`

Tests the Oracle ladder workflow:
- Pre-merge gate
- Shadow rung
- Train rung
- Canary rung
- Full promotion

## Production Test URLs

### Worker Endpoints

All production tests target the `beehive.bz23711.workers.dev` domain:

| Worker | URL | Endpoints |
|--------|-----|-----------|
| Shadow Router | `https://beehive-shadow-router.bz23711.workers.dev` | `/shadow/*` |
| Canary Worker | `https://beehive-canary-worker.bz23711.workers.dev` | `/canary/*` |
| Promotion Worker | `https://beehive-promotion-worker.bz23711.workers.dev` | `/promotion/*` |

### Example Requests

```bash
# Health check
curl -H "Authorization: Bearer $BEEHIVE_API_TOKEN" \
  https://beehive-shadow-router.bz23711.workers.dev/shadow/health

# Statsig config
curl -H "Authorization: Bearer $BEEHIVE_API_TOKEN" \
  https://beehive-shadow-router.bz23711.workers.dev/shadow/config

# Deploy canary
curl -X POST \
  -H "Authorization: Bearer $BEEHIVE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"candidateId": "test-1", "specId": "spec-1", "trafficPercentage": 5}' \
  https://beehive-canary-worker.bz23711.workers.dev/canary/deploy

# Promote candidate
curl -X POST \
  -H "Authorization: Bearer $BEEHIVE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"candidateId": "test-1", "specId": "spec-1", "fromRung": "shadow", "toRung": "train", "actorId": "test"}' \
  https://beehive-promotion-worker.bz23711.workers.dev/promotion/candidates/promote
```

## Authentication

### Token Requirements

Production API tokens must have access to:
1. **Shadow Router** - Read config, classify requests
2. **Canary Worker** - Deploy, manage, rollback canaries
3. **Promotion Worker** - Promote candidates, manage merge-trains and tournaments

### Token Generation

1. Go to Cloudflare Dashboard
2. Navigate to API Tokens
3. Create a new token with:
   - Zone: Workers & Pages
   - Account: Your account
   - Permissions: Read/Write for Workers
4. Copy the token and add to `.env.test.production`

## Running Specific Tests

### Run a specific test file
```bash
npx vitest run tests/e2e/cross-worker-flows.test.ts
```

### Run a specific test
```bash
npx vitest run tests/e2e/cross-worker-flows.test.ts -t "Oracle Ladder"
```

### Run with coverage
```bash
npx vitest run tests/e2e --coverage
```

## Test Execution in CI/CD

### GitHub Actions

Create `.github/workflows/e2e-production.yml`:

```yaml
name: Production E2E Tests

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npm ci
      - run: npm run test:e2e:production
        env:
          E2E_ENVIRONMENT: production
          BEEHIVE_API_TOKEN: ${{ secrets.BEEHIVE_API_TOKEN }}
```

### Manual Execution

```bash
# Set environment variables
export E2E_ENVIRONMENT=production
export BEEHIVE_API_TOKEN=your_token_here

# Run tests
npm run test:e2e:production
```

## Debugging Tests

### Verbose Output
```bash
# Run with verbose output
npx vitest run tests/e2e/cross-worker-flows.test.ts --verbose
```

### Inspect Network Requests

Add logging to see the actual requests being made:

```typescript
// In your test file
import { createRequest } from './helpers';

const request = createRequest('/shadow/config', 'GET', undefined, {}, 'shadow');
console.log('Request URL:', request.url);
console.log('Request Headers:', Object.fromEntries(request.headers.entries()));
```

### Test Isolation

Each test generates unique IDs to prevent interference:

```typescript
// Tests use unique IDs like:
// - e2e-candidate-abc123-1234567890
// - e2e-spec-def456-1234567890
```

## Test Data Management

### Cleanup

The tests generate unique IDs for each run. For production testing, consider:

1. **Automatic Cleanup**: Add afterEach hooks to rollback deployments
2. **Manual Cleanup**: Use the Cloudflare API to delete test resources
3. **Test Namespaces**: Use separate namespaces for test data

### Example Cleanup Hook

```typescript
afterEach(async () => {
  // Rollback any canary deployments created in the test
  if (deploymentId) {
    try {
      await rollbackDeployment(deploymentId);
    } catch (error) {
      console.warn('Failed to rollback deployment:', error);
    }
  }
});
```

## Common Issues

### 401 Unauthorized

**Cause**: Invalid or missing API token

**Solution**:
1. Verify `BEEHIVE_API_TOKEN` is set
2. Check token has correct permissions
3. Ensure token is for the correct account

### 404 Not Found

**Cause**: Incorrect URL or endpoint

**Solution**:
1. Verify worker URLs in config
2. Check endpoint paths
3. Ensure workers are deployed

### 500 Internal Server Error

**Cause**: Server-side error

**Solution**:
1. Check worker logs
2. Verify request payload
3. Test with curl to isolate issue

### Connection Refused

**Cause**: Local workers not running

**Solution**:
1. Start workers with `npm run dev:shadow`, `npm run dev:canary`, etc.
2. Or use mock handlers for local testing

## Performance Considerations

### Timeouts

| Environment | Timeout | Retries |
|-------------|---------|---------|
| Local | 5s | 0 |
| Staging | 10s | 2 |
| Production | 15s | 3 |

### Parallel Execution

- Local: Max 2 threads (to avoid overloading)
- Staging/Production: Max 4 threads

## Best Practices

1. **Always use unique IDs** for test entities
2. **Clean up after tests** to avoid data pollution
3. **Use appropriate timeouts** for each environment
4. **Mock external services** when possible
5. **Test error paths** as well as success paths
6. **Document test assumptions** in comments

## API Token Security

⚠️ **IMPORTANT**: Never commit API tokens to the repository!

- Use `.gitignore` to exclude `.env.test.*` files
- Use GitHub Actions secrets for CI/CD
- Rotate tokens regularly
- Use least-privilege tokens

## Contributing

1. Add new tests to appropriate files
2. Use the existing patterns from `cross-worker-flows.test.ts`
3. Update `PRODUCTION_E2E_PLAN.md` with new test scenarios
4. Run tests locally before committing

## References

- [Vitest Documentation](https://vitest.dev/)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Production E2E Plan](PRODUCTION_E2E_PLAN.md)
- [Synthetic Monitoring Script](../../scripts/synthetic-monitoring-enhanced.sh)

## Support

For issues with E2E tests:
1. Check this README
2. Review the test plan document
3. Check environment configuration
4. Verify API token permissions
5. Review worker logs
