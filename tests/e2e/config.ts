/**
 * E2E Test Configuration
 * Manages base URLs and authentication for different environments
 * 
 * Phase: 4
 * Task: test-phase-4-config
 * Spec: Testing
 * Confidence: 1.0
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
  retries: number;
}

// Configuration for different environments
// For production, URLs use the beehive.bz23711.workers.dev domain
const configs: Record<TestEnvironment, Omit<TestConfig, 'environment'>> = {
  local: {
    baseUrl: 'http://localhost:8787',
    shadowRouterUrl: 'http://localhost:8788',
    canaryWorkerUrl: 'http://localhost:8789',
    promotionWorkerUrl: 'http://localhost:8790',
    apiToken: 'test-auth-token-12345',
    timeout: 5000,
    retries: 0, // No retries for local (fast feedback)
  },
  staging: {
    baseUrl: 'https://beehive-staging.workers.dev',
    shadowRouterUrl: 'https://beehive-shadow-router-staging.workers.dev',
    canaryWorkerUrl: 'https://beehive-canary-worker-staging.workers.dev',
    promotionWorkerUrl: 'https://beehive-promotion-worker-staging.workers.dev',
    apiToken: process.env.STAGING_API_TOKEN || '',
    timeout: 10000,
    retries: 2,
  },
  production: {
    baseUrl: 'https://beehive.bz23711.workers.dev',
    shadowRouterUrl: 'https://beehive-shadow-router.bz23711.workers.dev',
    canaryWorkerUrl: 'https://beehive-canary-worker.bz23711.workers.dev',
    promotionWorkerUrl: 'https://beehive-promotion-worker.bz23711.workers.dev',
    apiToken: process.env.BEEHIVE_API_TOKEN || '',
    timeout: 15000,
    retries: 3,
  },
};

/**
 * Get configuration based on environment
 */
function getConfig(environment?: TestEnvironment): TestConfig {
  const env = environment || getEnvironmentFromEnv();
  return {
    environment: env,
    ...configs[env],
  };
}

/**
 * Determine environment from environment variables
 */
function getEnvironmentFromEnv(): TestEnvironment {
  const env = (process.env.E2E_ENVIRONMENT || '').toLowerCase() as TestEnvironment;
  
  if (env === 'local' || env === 'staging' || env === 'production') {
    return env;
  }
  
  // Default to local for development
  return 'local';
}

/**
 * Validate production environment requirements
 */
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

/**
 * Validate staging environment requirements
 */
function validateStagingConfig(config: TestConfig): void {
  if (config.environment !== 'staging') return;
  
  if (!config.apiToken) {
    throw new Error(
      'STAGING_API_TOKEN environment variable is required for staging tests'
    );
  }
}

/**
 * Get environment-specific timeout
 */
function getTimeout(environment?: TestEnvironment): number {
  const config = getConfig(environment);
  return config.timeout;
}

/**
 * Get environment-specific retry count
 */
function getRetries(environment?: TestEnvironment): number {
  const config = getConfig(environment);
  return config.retries;
}

export {
  getConfig,
  validateProductionConfig,
  validateStagingConfig,
  getTimeout,
  getRetries,
  configs,
};
