/**
 * Authentication utilities for E2E tests
 * 
 * Phase: 4
 * Task: test-phase-4-auth
 * Spec: Testing
 * Confidence: 1.0
 */

import { getConfig, validateProductionConfig, validateStagingConfig } from './config';

export interface AuthHeaders {
  'Authorization': string;
  'Content-Type': string;
}

export type WorkerType = 'base' | 'shadow' | 'canary' | 'promotion';

/**
 * Get authorization headers for the current environment
 */
export function getAuthHeaders(token?: string): AuthHeaders {
  const config = getConfig();
  
  // For local environment, we still provide the header but it may not be checked
  if (config.environment === 'local') {
    return {
      'Authorization': `Bearer ${token || config.apiToken}`,
      'Content-Type': 'application/json',
    };
  }
  
  const apiToken = token || config.apiToken;
  
  if (!apiToken) {
    throw new Error(
      `No API token available for ${config.environment} environment. ` +
      'Set BEEHIVE_API_TOKEN (production) or STAGING_API_TOKEN (staging) environment variable.'
    );
  }
  
  return {
    'Authorization': `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Get the base URL for a specific worker type
 */
export function getWorkerUrl(workerType: WorkerType): string {
  const config = getConfig();
  
  switch (workerType) {
    case 'shadow':
      return config.shadowRouterUrl;
    case 'canary':
      return config.canaryWorkerUrl;
    case 'promotion':
      return config.promotionWorkerUrl;
    case 'base':
    default:
      return config.baseUrl;
  }
}

/**
 * Create an authenticated request
 */
export function createAuthRequest(
  path: string,
  method: string = 'GET',
  body?: unknown,
  customHeaders?: Record<string, string>,
  workerType: WorkerType = 'base'
): Request {
  const config = getConfig();
  
  // Validate environment-specific requirements
  if (config.environment === 'production') {
    validateProductionConfig(config);
  } else if (config.environment === 'staging') {
    validateStagingConfig(config);
  }
  
  const baseUrl = getWorkerUrl(workerType);
  const url = new URL(path, baseUrl);
  const headers = {
    ...getAuthHeaders(),
    ...customHeaders,
  };
  
  return new Request(url.toString(), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

/**
 * Validate API token format (basic checks)
 */
export function isValidToken(token: string): boolean {
  if (!token || token.length < 20) {
    return false;
  }
  
  // Basic patterns for API tokens
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

/**
 * Check if we're in production environment
 */
export function isProduction(): boolean {
  const config = getConfig();
  return config.environment === 'production';
}

/**
 * Check if we're in staging environment
 */
export function isStaging(): boolean {
  const config = getConfig();
  return config.environment === 'staging';
}

/**
 * Check if we're in local environment
 */
export function isLocal(): boolean {
  const config = getConfig();
  return config.environment === 'local';
}
