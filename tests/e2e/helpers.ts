/**
 * Test Helper Functions for E2E Tests
 * 
 * Phase: 4
 * Task: test-phase-4-helpers
 * Spec: Testing
 * Confidence: 1.0
 */

import { getConfig, getRetries, getTimeout } from './config';
import { getAuthHeaders, getWorkerUrl, WorkerType } from './auth';

interface JsonResponse {
  [key: string]: unknown;
  success?: boolean;
  error?: string;
  data?: unknown;
}

/**
 * Parse JSON response from Response object
 */
export async function readJson(res: Response): Promise<JsonResponse> {
  return (await res.json()) as JsonResponse;
}

/**
 * Create a request with proper authentication and worker routing
 */
export function createRequest(
  path: string,
  method: string = 'GET',
  body?: unknown,
  headers?: Record<string, string>,
  workerType: WorkerType = 'base'
): Request {
  const config = getConfig();
  const baseUrl = getWorkerUrl(workerType);
  const url = new URL(path, baseUrl);
  
  const defaultHeaders = config.environment === 'local' 
    ? { 'Content-Type': 'application/json' }
    : getAuthHeaders();
  
  return new Request(url.toString(), {
    method,
    headers: { ...defaultHeaders, ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/**
 * Helper to call handlers with authentication
 * Used for both mock and real handlers
 */
export async function callHandler(
  handler: { fetch: (req: Request) => Promise<Response> } | undefined,
  path: string,
  method: string = 'GET',
  body?: unknown,
  workerType: WorkerType = 'base'
): Promise<Response> {
  const request = createRequest(path, method, body, {}, workerType);
  
  // If handler is provided (for mocks), use it
  if (handler) {
    return handler.fetch(request);
  }
  
  // Otherwise, make real fetch call
  return fetch(request);
}

/**
 * Fetch with automatic retry logic
 */
export async function fetchWithRetry(
  path: string,
  method: string = 'GET',
  body?: unknown,
  workerType: WorkerType = 'base',
  customHeaders?: Record<string, string>
): Promise<Response> {
  const config = getConfig();
  const maxRetries = getRetries();
  const baseDelay = 1000; // Start with 1 second delay
  
  let lastError: Error | undefined;
  let lastResponse: Response | undefined;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const request = createRequest(path, method, body, customHeaders, workerType);
      const response = await fetch(request);
      
      // Check for rate limiting (429)
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : baseDelay * (attempt + 1);
        
        if (attempt < maxRetries) {
          console.warn(
            `Rate limited on ${path}. Status: ${response.status}. ` +
            `Retrying in ${waitTime}ms (attempt ${attempt + 1}/${maxRetries + 1})`
          );
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue;
        }
        
        return response;
      }
      
      // Check for server errors (5xx) - retry
      if (response.status >= 500 && attempt < maxRetries) {
        const waitTime = baseDelay * (attempt + 1);
        console.warn(
          `Server error on ${path}. Status: ${response.status}. ` +
          `Retrying in ${waitTime}ms (attempt ${attempt + 1}/${maxRetries + 1})`
        );
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }
      
      // Success or non-retryable error
      return response;
      
    } catch (error) {
      lastError = error as Error;
      
      // Network errors - retry
      if (attempt < maxRetries) {
        const waitTime = baseDelay * (attempt + 1);
        console.warn(
          `Network error on ${path}: ${error}. ` +
          `Retrying in ${waitTime}ms (attempt ${attempt + 1}/${maxRetries + 1})`
        );
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }
      
      throw error;
    }
  }
  
  // This should not be reached, but just in case
  if (lastError) {
    throw lastError;
  }
  
  throw new Error('Unexpected state in fetchWithRetry');
}

/**
 * Generate unique test IDs
 */
export function generateTestId(prefix: string = 'e2e'): string {
  const timestamp = Date.now();
  const randomSuffix = Math.random().toString(36).substring(2, 8);
  return `${prefix}-${randomSuffix}-${timestamp}`;
}

/**
 * Generate a unique candidate ID for testing
 */
export function generateCandidateId(): string {
  return generateTestId('candidate');
}

/**
 * Generate a unique spec ID for testing
 */
export function generateSpecId(): string {
  return generateTestId('spec');
}

/**
 * Generate a unique deployment ID for testing
 */
export function generateDeploymentId(): string {
  return generateTestId('deploy');
}

/**
 * Generate a unique promotion ID for testing
 */
export function generatePromotionId(): string {
  return generateTestId('promo');
}

/**
 * Sleep for a specified duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if response is successful (2xx status)
 */
export function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Check if response is a client error (4xx status)
 */
export function isClientError(status: number): boolean {
  return status >= 400 && status < 500;
}

/**
 * Check if response is a server error (5xx status)
 */
export function isServerError(status: number): boolean {
  return status >= 500 && status < 600;
}

/**
 * Assert that response is successful
 */
export function assertSuccess(response: Response, context?: string): void {
  if (!isSuccessStatus(response.status)) {
    throw new Error(
      `Expected successful response, got ${response.status}` +
      (context ? ` for ${context}` : '')
    );
  }
}

/**
 * Extract error message from response
 */
export async function getErrorMessage(response: Response): Promise<string> {
  try {
    const data = await readJson(response);
    return data.error || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

/**
 * Create a test context with unique IDs
 */
export interface TestContext {
  candidateId: string;
  specId: string;
  deploymentId?: string;
  promotionId?: string;
  timestamp: number;
}

export function createTestContext(): TestContext {
  const timestamp = Date.now();
  return {
    candidateId: generateCandidateId(),
    specId: generateSpecId(),
    timestamp,
  };
}
