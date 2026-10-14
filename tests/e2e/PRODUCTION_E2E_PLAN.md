# Production E2E Test Plan for beehive.bz23711.workers.dev

## Overview

This document outlines the plan for creating end-to-end (E2E) tests against the production Beehive deployment at `beehive.bz23711.workers.dev`. The tests will validate M3 features (Statsig traffic splitting, Canary deployments, Promotion worker) with proper authentication and cross-worker flow validation.

## Current State Analysis

### Existing Test Files
1. **`tests/e2e/m3-features.test.ts`** (2011 lines)
   - Uses mock handlers (`mockShadowRouterHandler`, `mockCanaryWorkerHandler`, `mockPromotionWorkerHandler`)
   - Tests against `http://localhost` URLs
   - Comprehensive coverage of M3 features:
     - Statsig traffic splitting (12 tests)
     - Canary worker (13 tests)
     - Promotion worker (15+ tests)
     - Integration tests
   - Uses `TEST_AUTH_TOKEN = 'test-auth-token-12345'`

2. **`scripts/synthetic-monitoring-enhanced.sh`** (1123 lines)
   - Production-ready monitoring script
   - Checks worker health at URLs like `https://beehive-*.${CLOUDFLARE_ACCOUNT}.workers.dev`
   - Validates M3 features:
     - Statsig configuration (`check_statsig_config`)
     - Canary deployment (`check_canary_deployment`)
     - Promotion worker (`check_promotion_worker`)
     - Merge-train mode (`check_merge_train`)
     - Tournament mode (`check_tournament_mode`)
   - Uses `BEEHIVE_API_TOKEN` environment variable

### Target Production URL
- **Base URL**: `https://beehive.bz23711.workers.dev`
- **Worker Endpoints**: 
  - Shadow Router: `/shadow/*`
  - Canary Worker: `/canary/*`
  - Promotion Worker: `/promotion/*`

---

## Production Base URL Configuration

### Strategy

Create a modular configuration system that allows tests to run against:
1. Local development (`http://localhost:8787`)
2. Staging environment
3. Production (`https://beehive.bz23711.workers.dev`)

### Implementation Plan

#### 1. Create Environment Configuration File

**File**: `tests/e2e/config.ts`

```typescript
/**
 * E2E Test Configuration
 * Manages base URLs and authentication for different environments
 */

export type TestEnvironment = 'local' | 'staging' | 'production';

export interface TestConfig {
  environment: TestEnvironment;
  baseUrl: string;
  shadowRouterUrl: string;
  canaryWorkerUrl: string;
  promotionWorkerUrl: string;
  apiToken: string;
  timeout: number;
}

// Configuration for different environments
const configs: Record<TestEnvironment, Omit<TestConfig, 'environment'>> = {
  local: {
    baseUrl: 'http://localhost:8787',
    shadowRouterUrl: 'http://localhost:8788', // Shadow router dev port
    canaryWorkerUrl: 'http://localhost:8789',  // Canary worker dev port
    promotionWorkerUrl: 'http://localhost:8790', // Promotion worker dev port
    apiToken: 'test-auth-token-12345',
    timeout: 5000,
  },
  staging: {
    baseUrl: 'https://beehive-staging.workers.dev',
    shadowRouterUrl: 'https://beehive-shadow-router-staging.workers.dev',
    canaryWorkerUrl: 'https://beehive-canary-worker-staging.workers.dev',
    promotionWorkerUrl: 'https://beehive-promotion-worker-staging.workers.dev',
    apiToken: process.env.STAGING_API_TOKEN || '',
    timeout: 10000,
  },
  production: {
    baseUrl: 'https://beehive.bz23711.workers.dev',
    shadowRouterUrl: 'https://beehive-shadow-router.bz23711.workers.dev',
    canaryWorkerUrl: 'https://beehive-canary-worker.bz23711.workers.dev',
    promotionWorkerUrl: 'https://beehive-promotion-worker.bz23711.workers.dev',
    apiToken: process.env.BEEHIVE_API_TOKEN || '',
    timeout: 15000,
  },
};

// Get configuration based on environment
function getConfig(environment?: TestEnvironment): TestConfig {
  const env = environment || getEnvironmentFromEnv();
  return {
    environment: env,
    ...configs[env],
  };
}

// Determine environment from environment variables
function getEnvironmentFromEnv(): TestEnvironment {
  const env = process.env.E2E_ENVIRONMENT?.toLowerCase();
  
  if (env === 'local' || env === 'staging' || env === 'production') {
    return env;
  }
  
  // Default to local for development
  // In CI/CD, should be explicitly set
  return 'local';
}

// Validate production environment requirements
function validateProductionConfig(config: TestConfig): void {
  if (config.environment !== 'production') return;
  
  if (!config.apiToken) {
    throw new Error(
      'BEEHIVE_API_TOKEN environment variable is required for production tests'
    );
  }
  
  if (config.apiToken === 'test-auth-token-12345') {
    console.warn(
      'Warning: Using default test token for production. ' +
      'Set BEEHIVE_API_TOKEN to a real production token.'
    );
  }
}

export { getConfig, validateProductionConfig, configs };
```

#### 2. Update Package.json Scripts

```json
{
  "scripts": {
    "test:e2e": "vitest run tests/e2e",
    "test:e2e:local": "E2E_ENVIRONMENT=local vitest run tests/e2e",
    "test:e2e:staging": "E2E_ENVIRONMENT=staging vitest run tests/e2e",
    "test:e2e:production": "E2E_ENVIRONMENT=production vitest run tests/e2e",
    "test:e2e:watch": "E2E_ENVIRONMENT=local vitest watch tests/e2e"
  }
}
```

#### 3. Create Environment Files

**File**: `.env.test.production`
```
E2E_ENVIRONMENT=production
BEEHIVE_API_TOKEN=your_production_api_token_here
```

**File**: `.env.test.staging`
```
E2E_ENVIRONMENT=staging
STAGING_API_TOKEN=your_staging_api_token_here
```

**File**: `.env.test.local`
```
E2E_ENVIRONMENT=local
```

#### 4. Update `.gitignore`

Add:
```
.env.test.production
.env.test.staging
.env.test.local
```

---

## Authentication Handling

### Strategy

The production environment requires Bearer token authentication. The current mock tests use a hardcoded token. For production:

1. **Token Source**: Read from environment variable `BEEHIVE_API_TOKEN`
2. **Token Validation**: Ensure token is present for production tests
3. **Token Rotation**: Support for token refresh (future enhancement)

### Implementation

#### 1. Auth Utility Module

**File**: `tests/e2e/auth.ts`

```typescript
/**
 * Authentication utilities for E2E tests
 */

import { getConfig, validateProductionConfig } from './config';

export interface AuthHeaders {
  'Authorization': string;
  'Content-Type': string;
}

export interface AuthRequestOptions {
  headers?: AuthHeaders;
  token?: string;
}

/**
 * Get authorization headers for the current environment
 */
export function getAuthHeaders(token?: string): AuthHeaders {
  const config = getConfig();
  const apiToken = token || config.apiToken;
  
  if (!apiToken) {
    throw new Error('No API token available. Set BEEHIVE_API_TOKEN environment variable.');
  }
  
  return {
    'Authorization': `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Create an authenticated request
 */
export function createAuthRequest(
  url: string | URL,
  method: string = 'GET',
  body?: unknown,
  customHeaders?: Record<string, string>
): Request {
  const config = getConfig();
  validateProductionConfig(config);
  
  const urlObj = typeof url === 'string' ? new URL(url) : url;
  const headers = {
    ...getAuthHeaders(),
    ...customHeaders,
  };
  
  return new Request(urlObj.toString(), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

/**
 * Validate API token format (basic checks)
 */
export function isValidToken(token: string): boolean {
  // Basic validation - adjust based on your token format
  if (!token || token.length < 20) {
    return false;
  }
  
  // Check for common patterns
  const patterns = [
    /^[A-Za-z0-9_-]{20,}$/, // Simple alphanumeric
    /^eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*$/, // JWT pattern
  ];
  
  return patterns.some(pattern => pattern.test(token));
}

/**
 * Get token from environment or configuration
 */
export function getApiToken(): string {
  const config = getConfig();
  
  if (!config.apiToken) {
    throw new Error(
      `No API token configured for ${config.environment} environment. ` +
      'Set BEEHIVE_API_TOKEN (production) or STAGING_API_TOKEN (staging) environment variable.'
    );
  }
  
  return config.apiToken;
}
```

#### 2. Update Test Helper Functions

In the test files, replace hardcoded URL construction with config-based URLs:

```typescript
// OLD (current)
function createRequest(
  path: string,
  method: string = 'GET',
  body?: unknown,
  headers?: Record<string, string>
): Request {
  const url = new URL(`http://localhost${path}`);
  return new Request(url.toString(), {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// NEW (config-based)
import { getConfig, getAuthHeaders } from './config';

function createRequest(
  path: string,
  method: string = 'GET',
  body?: unknown,
  headers?: Record<string, string>,
  workerType?: 'shadow' | 'canary' | 'promotion' | 'base'
): Request {
  const config = getConfig();
  
  // Determine base URL based on worker type
  let baseUrl = config.baseUrl;
  if (workerType === 'shadow') {
    baseUrl = config.shadowRouterUrl;
  } else if (workerType === 'canary') {
    baseUrl = config.canaryWorkerUrl;
  } else if (workerType === 'promotion') {
    baseUrl = config.promotionWorkerUrl;
  }
  
  const url = new URL(path, baseUrl);
  
  // Always include auth headers for non-local environments
  const defaultHeaders = config.environment === 'local' 
    ? { 'Content-Type': 'application/json' }
    : getAuthHeaders();
  
  return new Request(url.toString(), {
    method,
    headers: { ...defaultHeaders, ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
}
```

---

## Cross-Worker Flow Tests

### Strategy

Test the complete workflow across all workers:
1. Shadow Router → Canary Worker → Promotion Worker
2. Oracle Ladder (Pre-merge → Shadow → Train → Canary → Full)
3. Data consistency across workers

### Implementation

#### 1. Cross-Worker Test Suite

**File**: `tests/e2e/cross-worker-flows.test.ts`

```typescript
/**
 * Cross-Worker Flow E2E Tests
 * 
 * Tests the complete workflow across all M3 workers:
 * Shadow Router -> Canary Worker -> Promotion Worker
 * 
 * Phase: 4
 * Task: test-phase-4-cross-worker
 * Spec: Testing
 * Confidence: 1.0
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getConfig, validateProductionConfig } from './config';
import { createAuthRequest, getAuthHeaders, getApiToken } from './auth';

interface JsonResponse {
  [key: string]: unknown;
  success?: boolean;
  error?: string;
  data?: unknown;
}

async function readJson(res: Response): Promise<JsonResponse> {
  return (await res.json()) as JsonResponse;
}

// Helper to make authenticated requests
async function fetchWithAuth(
  path: string,
  method: string = 'GET',
  body?: unknown,
  workerType?: 'shadow' | 'canary' | 'promotion'
): Promise<Response> {
  const config = getConfig();
  const request = createAuthRequest(path, method, body, {}, workerType);
  return fetch(request);
}

describe('Cross-Worker Flow Tests', () => {
  let candidateId: string;
  let specId: string;
  let deploymentId: string;
  let promotionId: string;

  beforeAll(() => {
    const config = getConfig();
    validateProductionConfig(config);
    
    // Generate unique IDs for this test run
    const timestamp = Date.now();
    candidateId = `e2e-candidate-${timestamp}`;
    specId = `e2e-spec-${timestamp}`;
  });

  describe('Oracle Ladder Complete Flow', () => {
    it('should complete the full oracle ladder: pre-merge -> shadow -> train -> canary', async () => {
      const config = getConfig();
      
      // Step 1: Verify shadow router configuration
      const shadowConfigResponse = await fetchWithAuth(
        '/shadow/config',
        'GET',
        undefined,
        'shadow'
      );
      
      expect(shadowConfigResponse.status).toBe(200);
      const shadowConfig = await readJson(shadowConfigResponse);
      expect(shadowConfig.success).toBe(true);
      expect((shadowConfig.config as any)?.statsig?.enabled).toBe(true);
      
      // Step 2: Classify a request through shadow router
      const classifyResponse = await fetchWithAuth(
        '/shadow/classify',
        'POST',
        {
          requestId: `e2e-request-${Date.now()}`,
          candidateId,
          specId,
          path: '/test',
          method: 'GET',
        },
        'shadow'
      );
      
      expect(classifyResponse.status).toBe(200);
      const classifyData = await readJson(classifyResponse);
      expect(classifyData.success).toBe(true);
      expect(classifyData.classification).toBeDefined();
      
      // Step 3: Deploy canary
      const canaryDeployResponse = await fetchWithAuth(
        '/canary/deploy',
        'POST',
        {
          candidateId,
          specId,
          trafficPercentage: 5,
          holdoutPercentage: 5,
        },
        'canary'
      );
      
      expect(canaryDeployResponse.status).toBe(200);
      const canaryData = await readJson(canaryDeployResponse);
      expect(canaryData.success).toBe(true);
      expect(canaryData.deployment).toBeDefined();
      deploymentId = (canaryData.deployment as any).id;
      
      // Step 4: Get deployment status
      const deploymentStatusResponse = await fetchWithAuth(
        `/canary/deployments/${deploymentId}`,
        'GET',
        undefined,
        'canary'
      );
      
      expect(deploymentStatusResponse.status).toBe(200);
      const deploymentStatus = await readJson(deploymentStatusResponse);
      expect(deploymentStatus.success).toBe(true);
      expect((deploymentStatus.deployment as any)?.status).toBe('deployed');
      
      // Step 5: Check SLO metrics
      const sloMetricsResponse = await fetchWithAuth(
        '/canary/slo/metrics',
        'GET',
        undefined,
        'canary'
      );
      
      expect(sloMetricsResponse.status).toBe(200);
      const sloMetrics = await readJson(sloMetricsResponse);
      expect(sloMetrics.success).toBe(true);
      expect((sloMetrics.metrics as any)?.compliance).toBe(true);
      
      // Step 6: Check promotion worker health
      const promotionHealthResponse = await fetchWithAuth(
        '/promotion/health',
        'GET',
        undefined,
        'promotion'
      );
      
      expect(promotionHealthResponse.status).toBe(200);
      const promotionHealth = await readJson(promotionHealthResponse);
      expect(promotionHealth.status).toBe('healthy');
      
      // Step 7: Promote candidate (shadow -> train)
      const promoteToTrainResponse = await fetchWithAuth(
        '/promotion/candidates/promote',
        'POST',
        {
          candidateId,
          specId,
          fromRung: 'shadow',
          toRung: 'train',
          actorId: 'e2e-test-agent',
        },
        'promotion'
      );
      
      expect(promoteToTrainResponse.status).toBe(201);
      const promoteToTrainData = await readJson(promoteToTrainResponse);
      expect(promoteToTrainData.success).toBe(true);
      promotionId = promoteToTrainData.promotionId as string;
      
      // Step 8: Promote candidate (train -> canary)
      const promoteToCanaryResponse = await fetchWithAuth(
        '/promotion/candidates/promote',
        'POST',
        {
          candidateId,
          specId,
          fromRung: 'train',
          toRung: 'canary',
          actorId: 'e2e-test-agent',
        },
        'promotion'
      );
      
      expect(promoteToCanaryResponse.status).toBe(201);
      const promoteToCanaryData = await readJson(promoteToCanaryResponse);
      expect(promoteToCanaryData.success).toBe(true);
      
      // Step 9: Verify candidate status
      const statusResponse = await fetchWithAuth(
        `/promotion/candidates/${candidateId}/status`,
        'GET',
        undefined,
        'promotion'
      );
      
      expect(statusResponse.status).toBe(200);
      const statusData = await readJson(statusResponse);
      expect(statusData.success).toBe(true);
      expect(statusData.currentRung).toBe('canary');
    });
  });

  describe('Statsig Integration Flow', () => {
    it('should verify Statsig traffic splitting with real canary deployment', async () => {
      const config = getConfig();
      
      // Get Statsig configuration
      const statsigConfigResponse = await fetchWithAuth(
        '/shadow/config',
        'GET',
        undefined,
        'shadow'
      );
      
      expect(statsigConfigResponse.status).toBe(200);
      const statsigConfig = await readJson(statsigConfigResponse);
      const configData = statsigConfig.config as any;
      
      expect(configData.statsig.enabled).toBe(true);
      const defaultSplit = configData.statsig.defaultSplit;
      
      // Verify percentages sum to 100
      const total = defaultSplit.canaryPercentage + 
                    defaultSplit.holdoutPercentage + 
                    defaultSplit.baselinePercentage;
      expect(total).toBe(100);
      
      // Create a canary with specific traffic percentages
      const canaryDeployResponse = await fetchWithAuth(
        '/canary/deploy',
        'POST',
        {
          candidateId: `statsig-test-${Date.now()}`,
          specId: `statsig-spec-${Date.now()}`,
          trafficPercentage: 10,
          holdoutPercentage: 5,
        },
        'canary'
      );
      
      expect(canaryDeployResponse.status).toBe(200);
      const canaryData = await readJson(canaryDeployResponse);
      expect(canaryData.success).toBe(true);
      
      // Verify the canary is deployed
      expect(canaryData.deployment?.status).toBe('deployed');
      expect(canaryData.deployment?.trafficPercentage).toBe(10);
    });
  });

  describe('Merge-Train Flow', () => {
    it('should start and manage a merge-train', async () => {
      const config = getConfig();
      
      // Start merge-train
      const startResponse = await fetchWithAuth(
        '/promotion/merge-train/start',
        'POST',
        {
          cars: [
            { candidateId: `mt-candidate-1-${Date.now()}`, position: 1 },
            { candidateId: `mt-candidate-2-${Date.now()}`, position: 2 },
            { candidateId: `mt-candidate-3-${Date.now()}`, position: 3 },
          ],
          projection: 100,
        },
        'promotion'
      );
      
      expect(startResponse.status).toBe(201);
      const startData = await readJson(startResponse);
      expect(startData.success).toBe(true);
      expect(startData.trainId).toBeDefined();
      expect(startData.cars.length).toBe(3);
      const trainId = startData.trainId as string;
      
      // Get merge-train status
      const statusResponse = await fetchWithAuth(
        `/promotion/merge-train/${trainId}`,
        'GET',
        undefined,
        'promotion'
      );
      
      expect(statusResponse.status).toBe(200);
      const statusData = await readJson(statusResponse);
      expect(statusData.success).toBe(true);
      expect(statusData.trainId).toBe(trainId);
      expect(statusData.status).toBe('active');
      
      // Promote first car
      const promoteResponse = await fetchWithAuth(
        `/promotion/merge-train/${trainId}/cars/${startData.cars[0].candidateId}/promote`,
        'POST',
        undefined,
        'promotion'
      );
      
      expect(promoteResponse.status).toBe(200);
      const promoteData = await readJson(promoteResponse);
      expect(promoteData.success).toBe(true);
      expect(promoteData.status).toBe('promoted');
    });
  });

  describe('Tournament Mode Flow', () => {
    it('should start and complete a tournament', async () => {
      const config = getConfig();
      
      // Start tournament
      const startResponse = await fetchWithAuth(
        '/promotion/tournament/start',
        'POST',
        {
          participants: [
            { candidateId: `tour-candidate-1-${Date.now()}`, score: 0, position: 1 },
            { candidateId: `tour-candidate-2-${Date.now()}`, score: 0, position: 2 },
            { candidateId: `tour-candidate-3-${Date.now()}`, score: 0, position: 3 },
          ],
        },
        'promotion'
      );
      
      expect(startResponse.status).toBe(201);
      const startData = await readJson(startResponse);
      expect(startData.success).toBe(true);
      expect(startData.tournamentId).toBeDefined();
      const tournamentId = startData.tournamentId as string;
      
      // Check tournament status (mock will return pre-defined winner)
      const winnerResponse = await fetchWithAuth(
        `/promotion/tournament/${tournamentId}/winner`,
        'GET',
        undefined,
        'promotion'
      );
      
      expect(winnerResponse.status).toBe(200);
      const winnerData = await readJson(winnerResponse);
      expect(winnerData.success).toBe(true);
      expect(winnerData.winner).toBeDefined();
    });
  });

  describe('Data Consistency Tests', () => {
    it('should verify candidate data consistency across workers', async () => {
      const config = getConfig();
      const testCandidateId = `consistency-test-${Date.now()}`;
      const testSpecId = `consistency-spec-${Date.now()}`;
      
      // Deploy canary
      const canaryResponse = await fetchWithAuth(
        '/canary/deploy',
        'POST',
        {
          candidateId: testCandidateId,
          specId: testSpecId,
          trafficPercentage: 10,
        },
        'canary'
      );
      
      expect(canaryResponse.status).toBe(200);
      const canaryData = await readJson(canaryResponse);
      const deployment = canaryData.deployment as any;
      
      // Verify deployment exists
      expect(deployment.candidateId).toBe(testCandidateId);
      expect(deployment.specId).toBe(testSpecId);
      
      // Check candidate status in promotion worker
      const statusResponse = await fetchWithAuth(
        `/promotion/candidates/${testCandidateId}/status`,
        'GET',
        undefined,
        'promotion'
      );
      
      expect(statusResponse.status).toBe(200);
      const statusData = await readJson(statusResponse);
      expect(statusData.candidateId).toBe(testCandidateId);
      
      // Note: The status might differ based on actual promotion state
      // but the candidate ID should be consistent
    });
  });

  describe('Error Handling Tests', () => {
    it('should handle authentication errors gracefully', async () => {
      // Try to make a request without proper auth (if we can simulate this)
      // In production, the workers should return 401 for missing/invalid tokens
      
      const config = getConfig();
      
      // Skip this test for local environment (no auth required)
      if (config.environment === 'local') {
        console.log('Skipping auth error test for local environment');
        return;
      }
      
      // Create a request with invalid token
      const url = new URL('/shadow/health', config.shadowRouterUrl);
      const invalidRequest = new Request(url.toString(), {
        method: 'GET',
        headers: {
          'Authorization': 'Bearer invalid-token-12345',
          'Content-Type': 'application/json',
        },
      });
      
      const response = await fetch(invalidRequest);
      
      // Should return 401 Unauthorized
      expect(response.status).toBe(401);
      const data = await readJson(response);
      expect(data.success).toBe(false);
      expect(data.error).toBeDefined();
    });

    it('should handle invalid request data', async () => {
      // Test with invalid canary deployment data
      const response = await fetchWithAuth(
        '/canary/deploy',
        'POST',
        {
          candidateId: '', // Invalid: empty
          specId: 'test',
        },
        'canary'
      );
      
      expect(response.status).toBe(400);
      const data = await readJson(response);
      expect(data.success).toBe(false);
      expect(data.error).toBeDefined();
    });

    it('should handle invalid rung transitions', async () => {
      const response = await fetchWithAuth(
        '/promotion/candidates/promote',
        'POST',
        {
          candidateId: 'test-candidate',
          specId: 'test-spec',
          fromRung: 'canary',
          toRung: 'shadow', // Invalid: can't go backwards
        },
        'promotion'
      );
      
      expect(response.status).toBe(400);
      const data = await readJson(response);
      expect(data.success).toBe(false);
      expect(data.error).toContain('Invalid rung transition');
    });
  });

  describe('Health Check Tests', () => {
    it('should verify all worker health checks', async () => {
      const config = getConfig();
      
      // Check shadow router health
      const shadowHealth = await fetchWithAuth('/shadow/health', 'GET', undefined, 'shadow');
      expect(shadowHealth.status).toBe(200);
      const shadowData = await readJson(shadowHealth);
      expect(shadowData.status).toBe('healthy');
      
      // Check canary worker health
      const canaryHealth = await fetchWithAuth('/canary/health', 'GET', undefined, 'canary');
      expect(canaryHealth.status).toBe(200);
      const canaryData = await readJson(canaryHealth);
      expect(canaryData.status).toBe('healthy');
      
      // Check promotion worker health
      const promotionHealth = await fetchWithAuth('/promotion/health', 'GET', undefined, 'promotion');
      expect(promotionHealth.status).toBe(200);
      const promotionData = await readJson(promotionHealth);
      expect(promotionData.status).toBe('healthy');
    });
  });
});
```

---

## Test Configuration for Production

### Environment Variables

Create a `.env.test.production` file:

```
# Environment
E2E_ENVIRONMENT=production

# Production API Token (required)
BEEHIVE_API_TOKEN=your_production_token_here

# Optional: Override base URLs if different
BEEHIVE_BASE_URL=https://beehive.bz23711.workers.dev
SHADOW_ROUTER_URL=https://beehive-shadow-router.bz23711.workers.dev
CANARY_WORKER_URL=https://beehive-canary-worker.bz23711.workers.dev
PROMOTION_WORKER_URL=https://beehive-promotion-worker.bz23711.workers.dev

# Test timeouts (in milliseconds)
E2E_TIMEOUT=15000
```

### CI/CD Integration

#### GitHub Actions Example

**File**: `.github/workflows/e2e-production.yml`

```yaml
name: Production E2E Tests

on:
  push:
    branches: [main, production]
  pull_request:
    branches: [main]
  workflow_dispatch:
    inputs:
      environment:
        description: 'Test environment'
        required: true
        default: 'production'
        type: choice
        options:
          - local
          - staging
          - production

env:
  NODE_VERSION: '22'

jobs:
  e2e-tests:
    name: E2E Tests (${{ inputs.environment || 'production' }})
    runs-on: ubuntu-latest
    
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Run E2E Tests
        env:
          E2E_ENVIRONMENT: ${{ inputs.environment || 'production' }}
          BEEHIVE_API_TOKEN: ${{ secrets.BEEHIVE_API_TOKEN }}
        run: |
          if [ "$E2E_ENVIRONMENT" = "production" ]; then
            npm run test:e2e:production
          elif [ "$E2E_ENVIRONMENT" = "staging" ]; then
            npm run test:e2e:staging
          else
            npm run test:e2e:local
          fi
```

---

## Test Execution Strategy

### Test Suites

1. **Unit Tests (Existing)**
   - Run with: `npm test`
   - Use mock handlers
   - Fast execution
   - No external dependencies

2. **Integration Tests (New)**
   - Run with: `npm run test:e2e`
   - Use real worker endpoints
   - Require authentication
   - Test cross-worker flows

3. **Production E2E Tests (New)**
   - Run with: `npm run test:e2e:production`
   - Target production URLs
   - Require production API token
   - Full end-to-end validation

### Test Selection

```bash
# Run all tests
npm test

# Run E2E tests for local development
npm run test:e2e:local

# Run E2E tests for staging
E2E_ENVIRONMENT=staging BEEHIVE_API_TOKEN=xxx npm run test:e2e

# Run E2E tests for production
E2E_ENVIRONMENT=production BEEHIVE_API_TOKEN=xxx npm run test:e2e

# Run specific test file
npx vitest run tests/e2e/cross-worker-flows.test.ts

# Run with coverage
npm run test:coverage
```

---

## Test Data Management

### Strategy

1. **Unique IDs**: Generate unique candidate/spec IDs for each test run
2. **Cleanup**: Implement cleanup hooks to remove test data
3. **Isolation**: Ensure tests don't interfere with each other

### Implementation

```typescript
// In test files
let testCandidateId: string;
let testSpecId: string;

beforeAll(() => {
  // Generate unique IDs
  const timestamp = Date.now();
  const randomSuffix = Math.random().toString(36).substring(2, 8);
  testCandidateId = `e2e-${randomSuffix}-${timestamp}`;
  testSpecId = `e2e-spec-${randomSuffix}-${timestamp}`;
});

afterAll(async () => {
  // Cleanup: Rollback deployments, delete test candidates
  try {
    // This depends on your API - implement cleanup logic
    await cleanupTestDeployments(testCandidateId);
  } catch (error) {
    console.warn('Cleanup failed:', error);
  }
});
```

---

## Monitoring and Reporting

### Test Results

1. **JUnit XML Report**: For CI/CD integration
2. **JSON Report**: For monitoring dashboards
3. **HTML Report**: For manual inspection

### Vitest Configuration

**File**: `vitest.config.ts`

```typescript
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    // Test directories
    include: ['tests/**/*.test.ts', 'tests/**/*.spec.ts'],
    exclude: ['node_modules', 'dist'],
    
    // Environment
    environment: 'node',
    
    // Coverage
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: './coverage',
      include: ['workers/**/*.ts'],
    },
    
    // Output
    outputFile: {
      junit: './test-results/junit.xml',
      json: './test-results/results.json',
    },
    
    // Setup files
    setupFiles: ['./tests/setup.ts'],
    globalSetup: ['./tests/global-setup.ts'],
    
    // Timeout
    testTimeout: 30000,
    hookTimeout: 10000,
    
    // Parallel execution
    threads: true,
    maxThreads: 4,
    minThreads: 2,
    
    // Retries
    retries: process.env.CI ? 2 : 0,
    
    // Watch mode
    watch: false,
    
    // Pass on environment variables
    passOnEnv: [
      'E2E_ENVIRONMENT',
      'BEEHIVE_API_TOKEN',
      'STAGING_API_TOKEN',
    ],
  },
  
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      '@workers': path.resolve(__dirname, 'workers'),
      '@tests': path.resolve(__dirname, 'tests'),
    },
  },
});
```

---

## Error Handling and Retries

### Strategy

1. **Network Errors**: Retry transient network errors
2. **Rate Limiting**: Implement backoff for rate-limited requests
3. **Authentication Errors**: Fail fast with clear messages
4. **Test Timeouts**: Configurable timeouts per environment

### Implementation

```typescript
// In config.ts
const environmentTimeouts: Record<TestEnvironment, number> = {
  local: 5000,
  staging: 10000,
  production: 15000,
};

// In test helpers
async function fetchWithRetry(
  url: string | URL,
  options: RequestInit,
  retries: number = 3,
  delay: number = 1000
): Promise<Response> {
  let lastError: Error;
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, options);
      
      // Retry on rate limiting (429)
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : delay * attempt;
        console.warn(`Rate limited. Retrying in ${waitTime}ms...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }
      
      // Retry on server errors (5xx)
      if (response.status >= 500 && attempt < retries) {
        console.warn(`Server error (${response.status}). Retrying in ${delay * attempt}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay * attempt));
        continue;
      }
      
      return response;
    } catch (error) {
      lastError = error as Error;
      
      // Retry on network errors
      if (attempt < retries) {
        console.warn(`Network error: ${error}. Retrying in ${delay * attempt}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay * attempt));
        continue;
      }
      
      throw error;
    }
  }
  
  throw lastError;
}
```

---

## Security Considerations

### API Token Management

1. **Never commit tokens to repository**
2. **Use GitHub Actions secrets** for CI/CD
3. **Rotate tokens regularly**
4. **Use least privilege tokens** for testing

### Token Scopes

The production API token should have:
- Read access to configuration
- Write access to test candidates only
- Limited to specific worker endpoints

### Audit Logging

1. **Track test runs**: Log when tests are executed
2. **Monitor test data**: Clean up test candidates
3. **Alert on failures**: Notify when production tests fail

---

## Success Criteria

### Phase 1: Infrastructure (Week 1)
- [ ] Environment configuration system implemented
- [ ] Authentication handling implemented
- [ ] Base URL configuration working
- [ ] Local tests passing

### Phase 2: Basic Tests (Week 2)
- [ ] Health check tests for all workers
- [ ] Basic Statsig configuration tests
- [ ] Basic canary deployment tests
- [ ] Basic promotion worker tests

### Phase 3: Integration Tests (Week 3)
- [ ] Cross-worker flow tests implemented
- [ ] Oracle ladder flow tests
- [ ] Merge-train flow tests
- [ ] Tournament flow tests

### Phase 4: Production Readiness (Week 4)
- [ ] All production E2E tests passing
- [ ] CI/CD pipeline configured
- [ ] Monitoring and alerting in place
- [ ] Documentation complete

---

## File Structure

```
tests/
├── e2e/
│   ├── config.ts                    # Environment configuration
│   ├── auth.ts                      # Authentication utilities
│   ├── helpers.ts                   # Test helper functions
│   ├── m3-features.test.ts          # Existing M3 tests (updated)
│   ├── oracle-ladder.test.ts        # Existing oracle tests (updated)
│   ├── cross-worker-flows.test.ts   # NEW: Cross-worker integration tests
│   ├── PRODUCTION_E2E_PLAN.md        # This document
│   └── README.md                    # Test documentation
├── setup.ts                         # Test setup
├── global-setup.ts                  # Global test setup
└── fixtures/                        # Test fixtures
    └── test-data.ts                 # Test data generators

scripts/
├── synthetic-monitoring-enhanced.sh  # Existing monitoring script
├── run-e2e-tests.sh                 # NEW: Script to run E2E tests
└── cleanup-test-data.sh             # NEW: Cleanup test data

.github/
└── workflows/
    ├── e2e-local.yml                # Local E2E tests
    ├── e2e-staging.yml               # Staging E2E tests
    └── e2e-production.yml             # Production E2E tests

.env.example                          # Environment variable examples
.env.test.production                 # Production test environment
.env.test.staging                     # Staging test environment
.env.test.local                       # Local test environment
```

---

## Next Steps

1. **Immediate (Today)**
   - [ ] Review and approve this plan
   - [ ] Create `tests/e2e/config.ts`
   - [ ] Create `tests/e2e/auth.ts`
   - [ ] Update package.json scripts

2. **Short-term (This Week)**
   - [ ] Create environment files
   - [ ] Update existing test files to use config
   - [ ] Create cross-worker flow tests
   - [ ] Setup vitest configuration

3. **Medium-term (Next Week)**
   - [ ] Implement CI/CD workflows
   - [ ] Test with staging environment
   - [ ] Validate production URLs
   - [ ] Obtain production API token

4. **Long-term (Ongoing)**
   - [ ] Monitor test results
   - [ ] Add more test scenarios
   - [ ] Improve error handling
   - [ ] Add performance tests

---

## Dependencies

### New Packages Required

```bash
npm install --save-dev dotenv
```

### Existing Packages (Already in package.json)
- vitest (^2.0.0)
- typescript (^5.0.0)

---

## Risks and Mitigations

### Risk 1: Production Token Exposure
**Mitigation**: 
- Use GitHub Actions secrets
- Never commit tokens to repository
- Use `.gitignore` for environment files
- Implement token validation in tests

### Risk 2: Test Data Pollution
**Mitigation**:
- Use unique IDs for all test entities
- Implement cleanup hooks
- Use separate test namespaces if available
- Monitor production data

### Risk 3: Flaky Tests
**Mitigation**:
- Implement retry logic
- Add proper timeouts
- Use async/await properly
- Monitor test stability

### Risk 4: Rate Limiting
**Mitigation**:
- Implement backoff and retry
- Limit concurrent requests
- Use test-specific tokens with higher limits
- Monitor rate limit headers

### Risk 5: Environment Differences
**Mitigation**:
- Modular configuration system
- Environment-specific settings
- Feature detection
- Graceful fallbacks

---

## Contacts

- **Test Author**: [Your Name]
- **Reviewers**: [Reviewers List]
- **Stakeholders**: [Stakeholders List]

## References

1. [Existing M3 Features Test](tests/e2e/m3-features.test.ts)
2. [Synthetic Monitoring Script](scripts/synthetic-monitoring-enhanced.sh)
3. [Vitest Documentation](https://vitest.dev/)
4. [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
