/**
 * Response Normalizers
 * 
 * Normalizes responses for consistent comparison.
 * Handles JSON parsing, header normalization, timestamp normalization, etc.
 */

import type { ResponseData } from '../types';

// ============================================================================
// Header Normalization
// ============================================================================

/**
 * Normalize headers for comparison
 * - Converts all header names to lowercase
 * - Sorts headers alphabetically for consistent comparison
 * - Optionally ignores specified headers
 */
export function normalizeHeaders(
  headers: Record<string, string> | Headers | Map<string, string>,
  ignoreHeaders?: string[]
): Record<string, string> {
  // Convert to plain object
  let headersObj: Record<string, string>;
  
  if (headers instanceof Headers) {
    headersObj = Object.fromEntries(headers.entries());
  } else if (headers instanceof Map) {
    headersObj = Object.fromEntries(headers);
  } else {
    headersObj = { ...headers };
  }

  // Normalize: lowercase names, trim values
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headersObj)) {
    const normalizedName = name.toLowerCase();
    const normalizedValue = String(value || '').trim();
    
    // Skip ignored headers
    if (ignoreHeaders && ignoreHeaders.some(
      pattern => matchesHeaderPattern(normalizedName, pattern)
    )) {
      continue;
    }
    
    normalized[normalizedName] = normalizedValue;
  }

  return normalized;
}

/**
 * Simple header pattern matching (used internally)
 */
function matchesHeaderPattern(header: string, pattern: string): boolean {
  const normalizedHeader = header.toLowerCase();
  const normalizedPattern = pattern.toLowerCase();
  
  if (normalizedPattern === '*') {
    return true;
  }
  
  if (normalizedPattern.endsWith('-*')) {
    const prefix = normalizedPattern.slice(0, -1);
    return normalizedHeader.startsWith(prefix);
  }
  
  return normalizedHeader === normalizedPattern;
}

// ============================================================================
// Body Normalization
// ============================================================================

/**
 * Parse and normalize a response body
 * - Parses JSON if content-type indicates JSON
 * - Returns parsed object or original string
 */
export function normalizeBody(
  body: string | undefined,
  contentType?: string
): unknown {
  // Empty body
  if (body === undefined || body === '' || body === null) {
    return null;
  }

  // Check if it's JSON
  const isJson = isJsonContentType(contentType);
  
  if (isJson) {
    try {
      const parsed = JSON.parse(body);
      return deepNormalizeBody(parsed);
    } catch {
      // Not valid JSON, return as string
      return body;
    }
  }

  // Try to parse as JSON anyway (some APIs don't set content-type correctly)
  try {
    const parsed = JSON.parse(body);
    return deepNormalizeBody(parsed);
  } catch {
    // Not JSON, return as string
    return body;
  }
}

/**
 * Check if content type indicates JSON
 */
function isJsonContentType(contentType?: string): boolean {
  if (!contentType) {
    return false;
  }
  
  const normalized = contentType.toLowerCase();
  return (
    normalized.includes('application/json') ||
    normalized.includes('application/ld+json') ||
    normalized.includes('application/hal+json') ||
    normalized.includes('application/vnd.api+json') ||
    normalized === 'json'
  );
}

/**
 * Deeply normalize a parsed body object
 * - Sorts array elements for consistent comparison
 * - Normalizes dates to ISO strings
 * - Normalizes numbers (avoid floating point precision issues)
 * - Removes functions and symbols
 */
function deepNormalizeBody(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return null;
  }

  if (typeof obj === 'string') {
    return obj;
  }

  if (typeof obj === 'number') {
    // Normalize numbers to avoid floating point precision issues
    return Math.round(obj * 1000000) / 1000000;
  }

  if (typeof obj === 'boolean') {
    return obj;
  }

  if (obj instanceof Date) {
    return obj.toISOString();
  }

  if (Array.isArray(obj)) {
    // Sort arrays for consistent comparison
    // Note: This assumes all array elements are comparable
    // For objects in arrays, we'll sort by JSON stringification
    const normalizedArray = obj.map(deepNormalizeBody);
    
    try {
      return normalizedArray.sort((a, b) => {
        const strA = JSON.stringify(a);
        const strB = JSON.stringify(b);
        return strA.localeCompare(strB);
      });
    } catch {
      // If sorting fails, return unsorted
      return normalizedArray;
    }
  }

  if (typeof obj === 'object') {
    const normalizedObj: Record<string, unknown> = {};
    
    // Sort object keys for consistent comparison
    const sortedKeys = Object.keys(obj).sort();
    
    for (const key of sortedKeys) {
      const value = (obj as Record<string, unknown>)[key];
      
      // Skip functions and symbols
      if (typeof value === 'function' || typeof value === 'symbol') {
        continue;
      }
      
      normalizedObj[key] = deepNormalizeBody(value);
    }
    
    return normalizedObj;
  }

  // For any other type, return as-is
  return obj;
}

// ============================================================================
// Full Response Normalization
// ============================================================================

/**
 * Normalize a complete response for comparison
 */
export function normalizeResponse(
  response: ResponseData,
  ignoreHeaders?: string[]
): NormalizedResponse {
  return {
    status: response.status,
    headers: normalizeHeaders(response.headers, ignoreHeaders),
    body: normalizeBody(response.body, response.headers['content-type']),
    latencyMs: response.latencyMs,
  };
}

/**
 * Normalized response structure
 */
export interface NormalizedResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  latencyMs: number;
}

// ============================================================================
// Equality Comparison
// ============================================================================

/**
 * Deep equality check for normalized values
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  // Strict equality for primitives
  if (a === b) {
    return true;
  }

  // Null/undefined checks
  if (a === null || a === undefined || b === null || b === undefined) {
    return a === b;
  }

  // Type mismatch
  if (typeof a !== typeof b) {
    return false;
  }

  // Number comparison with tolerance for floating point
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) < 0.000001;
  }

  // Array comparison
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }

  // Object comparison
  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    
    if (aKeys.length !== bKeys.length) {
      return false;
    }
    
    for (const key of aKeys) {
      if (!(key in (b as Record<string, unknown>))) {
        return false;
      }
      if (!deepEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key]
      )) {
        return false;
      }
    }
    return true;
  }

  // Fallback
  return false;
}

// ============================================================================
// Type Checking
// ============================================================================

/**
 * Check if a value is a plain object (not array, not null, not date, etc.)
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

/**
 * Check if a value is JSON-serializable
 */
export function isJsonSerializable(value: unknown): boolean {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Exports
// ============================================================================

export {
  isJsonContentType,
  deepNormalizeBody,
};
