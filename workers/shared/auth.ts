/**
 * Shared bearer-token auth gate for all Beehive workers with fetch entry points.
 *
 * Fail-closed by design:
 *   - API_AUTH_TOKEN unset -> 503 (auth not configured), never open
 *   - token mismatch       -> 401
 *
 * Set API_AUTH_TOKEN as a Worker secret in production
 * (`wrangler secret put API_AUTH_TOKEN`) and in `.dev.vars` for local dev.
 */

import { getSpecDoStub, type SpecDoCallerEnv } from './spec-do-auth';

export interface AuthEnv {
  API_AUTH_TOKEN?: string;
}

export function jsonError(error: string, status: number): Response {
  return new Response(
    JSON.stringify({ success: false, error, timestamp: Date.now() }),
    { status, headers: { 'Content-Type': 'application/json' } }
  );
}

/**
 * Returns a Response to send when the request is not authorized,
 * or null when the request may proceed.
 */
export function authGate(request: Request, env: AuthEnv): Response | null {
  const expected = env.API_AUTH_TOKEN;

  if (!expected) {
    return jsonError('API_AUTH_TOKEN not configured', 503);
  }

  const authorization = request.headers.get('Authorization');
  if (authorization === `Bearer ${expected}`) {
    return null;
  }

  const apiToken = request.headers.get('X-API-Token');
  if (apiToken === expected) {
    return null;
  }

  return jsonError('Unauthorized', 401);
}

// ============================================================================
// SERVICE ACCOUNT TOKEN HASHING
// ============================================================================

/**
 * Generate a cryptographically secure random salt
 */
export function generateSalt(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Hash a token with SHA-256 and salt
 * Uses PBKDF2 for key derivation
 */
export async function hashToken(token: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = encoder.encode(token + salt);
  
  const key = await crypto.subtle.importKey(
    'raw',
    keyMaterial,
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: encoder.encode(salt),
      iterations: 100000,
      hash: 'SHA-256',
    },
    key,
    256
  );
  
  const hashArray = Array.from(new Uint8Array(derivedBits));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify a token against a stored hash
 */
export async function verifyToken(token: string, hash: string, salt: string): Promise<boolean> {
  const computedHash = await hashToken(token, salt);
  return computedHash === hash;
}

/**
 * Generate a secure random token
 */
export function generateToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '')
    .replace(/\//g, '')
    .replace(/=+$/, '');
}

/**
 * Complete token generation - returns token, hash, and salt
 */
export async function generateTokenSet(): Promise<{ token: string; hash: string; salt: string }> {
  const salt = generateSalt();
  const token = generateToken();
  const hash = await hashToken(token, salt);
  return { token, hash, salt };
}

// ============================================================================
// SERVICE ACCOUNT AUTH MIDDLEWARE
// ============================================================================

export type ServiceAccountScope = 'read' | 'write' | 'read_write';

export interface ServiceAccountAuthEnv extends SpecDoCallerEnv {
  API_AUTH_TOKEN?: string;
}

/**
 * Result of service account authentication
 */
export interface ServiceAccountAuthResult {
  serviceAccountId?: string;
  scopes?: ServiceAccountScope[];
  isValid: boolean;
  error?: string;
}

/**
 * Authenticate a service account token and check scopes
 * Returns auth result with service account info or error
 */
export async function serviceAccountAuth(
  request: Request,
  env: ServiceAccountAuthEnv
): Promise<ServiceAccountAuthResult> {
  // Check for service account token in headers
  const authHeader = request.headers.get('Authorization');
  const apiToken = request.headers.get('X-API-Token');
  
  let token: string | null = null;
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (apiToken) {
    token = apiToken;
  }
  
  if (!token) {
    return { isValid: false, error: 'No service account token provided' };
  }
  
  // Token format: service_account_id:token
  const parts = token.split(':');
  if (parts.length !== 2) {
    return { isValid: false, error: 'Invalid token format' };
  }
  
  const [serviceAccountId, serviceToken] = parts;
  
  try {
    // Get Spec DO to verify the token
    const specDoStub = getSpecDoStub(env);
    
    const verifyUrl = `/api/service-accounts/${serviceAccountId}/verify`;
    const verifyResponse = await specDoStub.fetch(
      new Request(verifyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: serviceToken }),
      })
    );
    
    if (!verifyResponse.ok) {
      const error = await verifyResponse.text();
      return { isValid: false, error: `Token verification failed: ${error}` };
    }
    
    const result = await verifyResponse.json() as {
      success?: boolean;
      isValid?: boolean;
      scopes?: ServiceAccountScope;
      error?: string;
    };
    
    if (!result.isValid && !result.success) {
      return { isValid: false, error: result.error || 'Invalid token' };
    }
    
    // Convert scopes string to array
    const scopes = result.scopes ? [result.scopes] : [];
    
    return {
      isValid: true,
      serviceAccountId,
      scopes,
    };
  } catch (error) {
    return { isValid: false, error: `Authentication failed: ${error}` };
  }
}

/**
 * Check if service account has required scopes
 */
export function hasScope(
  authResult: ServiceAccountAuthResult,
  requiredScope: ServiceAccountScope | ServiceAccountScope[]
): boolean {
  if (!authResult.isValid) {
    return false;
  }
  
  const requiredScopes = Array.isArray(requiredScope) ? requiredScope : [requiredScope];
  const accountScopes = authResult.scopes || [];
  
  // read_write has all permissions
  if (accountScopes.includes('read_write')) {
    return true;
  }
  
  // Check if account has at least one of the required scopes
  for (const required of requiredScopes) {
    if (accountScopes.includes(required)) {
      return true;
    }
  }
  
  return false;
}

/**
 * Middleware to check service account authentication and scopes
 * Returns a Response if auth fails, or null if authorized
 */
export async function serviceAccountAuthGate(
  request: Request,
  env: ServiceAccountAuthEnv,
  requiredScope?: ServiceAccountScope | ServiceAccountScope[]
): Promise<Response | null> {
  const authResult = await serviceAccountAuth(request, env);
  
  if (!authResult.isValid) {
    return new Response(
      JSON.stringify({ success: false, error: authResult.error || 'Unauthorized', timestamp: Date.now() }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }
  
  if (requiredScope && !hasScope(authResult, requiredScope)) {
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: 'Insufficient permissions', 
        timestamp: Date.now() 
      }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }
  
  return null;
}
