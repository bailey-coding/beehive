/**
 * Header Comparison
 * 
 * Compares HTTP headers between baseline and candidate responses
 * according to the declared delta surface rules.
 */

import type {
  HeaderComparisonResult,
  HeaderDiff,
  DeltaSurface,
  PathDeltaSurface,
} from '../types';
import { matchPath, matchesHeaderPattern } from '../delta-surface';
import { normalizeHeaders } from './normalizers';

// ============================================================================
// Header Comparison
// ============================================================================

/**
 * Compare headers between baseline and candidate responses
 * 
 * @param baselineHeaders - Headers from baseline response
 * @param candidateHeaders - Headers from candidate response
 * @param deltaSurface - The declared delta surface
 * @param path - The request path (for path-specific rules)
 * @returns Header comparison result
 */
export function compareHeaders(
  baselineHeaders: Record<string, string> | Headers | Map<string, string>,
  candidateHeaders: Record<string, string> | Headers | Map<string, string>,
  deltaSurface: DeltaSurface,
  path: string
): HeaderComparisonResult {
  // Get the path-specific configuration
  const pathConfig = matchPath(deltaSurface, path);

  // Get header configuration (path-specific or default)
  const headerConfig = pathConfig.response?.headers || deltaSurface.defaults.response?.headers;

  // Normalize both header sets
  const normalizedBaseline = normalizeHeaders(baselineHeaders);
  const normalizedCandidate = normalizeHeaders(candidateHeaders);

  // Get all header names from both responses
  const allHeaderNames = new Set([
    ...Object.keys(normalizedBaseline),
    ...Object.keys(normalizedCandidate),
  ]);

  const diffs: HeaderDiff[] = [];

  for (const headerName of allHeaderNames) {
    const baselineValue = normalizedBaseline[headerName];
    const candidateValue = normalizedCandidate[headerName];

    // Skip if both are undefined (shouldn't happen with Set)
    if (baselineValue === undefined && candidateValue === undefined) {
      continue;
    }

    // New header in candidate
    if (baselineValue === undefined) {
      const isAllowed = isHeaderAllowedToDiffer(headerName, headerConfig?.allowedDiffs);
      const isForbidden = isHeaderForbiddenToDiffer(headerName, headerConfig?.forbiddenDiffs);

      if (isForbidden) {
        diffs.push({
          header: headerName,
          baselineValue: undefined,
          candidateValue,
          type: 'new_in_candidate',
          severity: 'error',
        });
      } else if (!isAllowed) {
        // Not explicitly allowed or forbidden - check default policy
        // By default, new headers in candidate are warnings
        diffs.push({
          header: headerName,
          baselineValue: undefined,
          candidateValue,
          type: 'new_in_candidate',
          severity: 'warning',
        });
      }
      // If explicitly allowed, no diff
      continue;
    }

    // Missing header in candidate
    if (candidateValue === undefined) {
      const isAllowed = isHeaderAllowedToDiffer(headerName, headerConfig?.allowedDiffs);
      const isForbidden = isHeaderForbiddenToDiffer(headerName, headerConfig?.forbiddenDiffs);

      if (isForbidden) {
        diffs.push({
          header: headerName,
          baselineValue,
          candidateValue: undefined,
          type: 'missing_in_candidate',
          severity: 'error',
        });
      } else if (!isAllowed) {
        // By default, missing headers in candidate are errors
        diffs.push({
          header: headerName,
          baselineValue,
          candidateValue: undefined,
          type: 'missing_in_candidate',
          severity: 'error',
        });
      }
      // If explicitly allowed, no diff
      continue;
    }

    // Both have the header, check if values differ
    if (baselineValue !== candidateValue) {
      const isAllowed = isHeaderAllowedToDiffer(headerName, headerConfig?.allowedDiffs);
      const isForbidden = isHeaderForbiddenToDiffer(headerName, headerConfig?.forbiddenDiffs);

      if (isForbidden) {
        diffs.push({
          header: headerName,
          baselineValue,
          candidateValue,
          type: 'forbidden_diff',
          severity: 'error',
        });
      } else if (!isAllowed) {
        // Not explicitly allowed - this is an unexpected diff
        diffs.push({
          header: headerName,
          baselineValue,
          candidateValue,
          type: 'unexpected_diff',
          severity: 'warning',
        });
      }
      // If explicitly allowed, no diff
    }
  }

  return {
    match: diffs.length === 0,
    diffs,
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if a header is allowed to differ
 */
function isHeaderAllowedToDiffer(
  headerName: string,
  allowedDiffs?: string[]
): boolean {
  if (!allowedDiffs || allowedDiffs.length === 0) {
    return false;
  }

  return allowedDiffs.some(pattern => 
    matchesHeaderPattern(headerName, pattern)
  );
}

/**
 * Check if a header is forbidden to differ
 */
function isHeaderForbiddenToDiffer(
  headerName: string,
  forbiddenDiffs?: string[]
): boolean {
  if (!forbiddenDiffs || forbiddenDiffs.length === 0) {
    return false;
  }

  return forbiddenDiffs.some(pattern => 
    matchesHeaderPattern(headerName, pattern)
  );
}

// ============================================================================
// Header Classification
// ============================================================================

/**
 * Common header categories
 */
export type HeaderCategory =
  | 'content'
  | 'authentication'
  | 'cache'
  | 'cors'
  | 'rate_limit'
  | 'security'
  | 'custom'
  | 'unknown';

/**
 * Classify a header by category
 */
export function classifyHeader(headerName: string): HeaderCategory {
  const normalized = headerName.toLowerCase();

  // Authentication
  if (normalized.startsWith('authorization') ||
      normalized.startsWith('cookie') ||
      normalized.startsWith('set-cookie') ||
      normalized.startsWith('proxy-authorization')) {
    return 'authentication';
  }

  // Content
  if (normalized.startsWith('content-') ||
      normalized === 'content-type' ||
      normalized === 'content-length') {
    return 'content';
  }

  // Cache
  if (normalized.startsWith('cache-') ||
      normalized === 'etag' ||
      normalized === 'last-modified' ||
      normalized === 'expires' ||
      normalized === 'age') {
    return 'cache';
  }

  // CORS
  if (normalized.startsWith('access-control-') ||
      normalized === 'origin' ||
      normalized === 'vary') {
    return 'cors';
  }

  // Rate limiting
  if (normalized.startsWith('x-ratelimit-') ||
      normalized.startsWith('x-rate-limit-') ||
      normalized === 'retry-after') {
    return 'rate_limit';
  }

  // Security
  if (normalized.startsWith('x-') ||
      normalized.startsWith('strict-transport-security') ||
      normalized.startsWith('content-security-policy') ||
      normalized.startsWith('x-content-type-options') ||
      normalized.startsWith('x-frame-options') ||
      normalized.startsWith('x-xss-protection')) {
    return 'security';
  }

  // Custom headers (typically start with X-)
  if (normalized.startsWith('x-')) {
    return 'custom';
  }

  return 'unknown';
}

/**
 * Headers that should typically be identical between baseline and candidate
 */
export const CRITICAL_HEADERS: string[] = [
  'content-type',
  'content-length',
  'location',
  'set-cookie',
  'authorization',
];

/**
 * Headers that are typically allowed to differ
 */
export const ALLOWED_DIFF_HEADERS: string[] = [
  'x-*',
  'cache-control',
  'etag',
  'last-modified',
  'expires',
  'date',
  'server',
  'x-powered-by',
  'x-request-id',
  'x-correlation-id',
];

// ============================================================================
// Exports
// ============================================================================

export type { HeaderComparisonResult, HeaderDiff, DeltaSurface, PathDeltaSurface };
export { normalizeHeaders };
