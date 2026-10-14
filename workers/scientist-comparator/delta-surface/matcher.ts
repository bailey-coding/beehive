/**
 * Delta Surface Path Matcher
 * 
 * Matches request paths against delta surface path patterns.
 * Supports exact match, parameterized paths, and wildcards.
 */

import type { DeltaSurface, PathDeltaSurface } from '../types';

// ============================================================================
// Path Pattern Types
// ============================================================================

/**
 * Path pattern types
 */
export type PathPatternType = 'exact' | 'parameterized' | 'wildcard' | 'glob';

/**
 * Parsed path pattern
 */
interface ParsedPathPattern {
  type: PathPatternType;
  pattern: string;
  regex?: RegExp;
  params?: string[];
}

// ============================================================================
// Path Pattern Parsing
// ============================================================================

/**
 * Parse a path pattern into a structured format
 */
function parsePathPattern(pattern: string): ParsedPathPattern {
  // Check for exact match (no special characters)
  if (!pattern.includes('*') && !pattern.includes('{') && !pattern.includes('}')) {
    return { type: 'exact', pattern };
  }

  // Check for parameterized path: /api/users/{id}
  if (pattern.includes('{') && pattern.includes('}')) {
    const regexPattern = pattern
      .replace(/\{/g, '(?<')
      .replace(/\}/g, '>[^/]+)')
      .replace(/\/\*/g, '/.*')
      .replace(/\*/g, '[^/]*');
    
    try {
      const regex = new RegExp(`^${regexPattern}$`);
      return { type: 'parameterized', pattern, regex };
    } catch {
      // If regex compilation fails, treat as wildcard
      return { type: 'wildcard', pattern };
    }
  }

  // Check for wildcard: /api/* or /api/users/*
  if (pattern.includes('*')) {
    const regexPattern = pattern
      .replace(/\./g, '\\.')
      .replace(/\{/g, '\\{')
      .replace(/\}/g, '\\}')
      .replace(/\*/g, '.*');
    
    try {
      const regex = new RegExp(`^${regexPattern}$`);
      return { type: 'wildcard', pattern, regex };
    } catch {
      return { type: 'wildcard', pattern };
    }
  }

  return { type: 'exact', pattern };
}

// ============================================================================
// Path Matching
// ============================================================================

/**
 * Match a request path against a delta surface to find the best matching configuration
 * 
 * @param deltaSurface - The delta surface to match against
 * @param path - The request path to match
 * @param method - Optional HTTP method (not currently used in path matching)
 * @returns The best matching path configuration, or the defaults if no match
 */
export function matchPath(
  deltaSurface: DeltaSurface,
  path: string,
  method?: string
): PathDeltaSurface {
  // Normalize the path (remove query string, trailing slashes)
  const normalizedPath = normalizePath(path);

  // Find the best matching pattern
  const bestMatch = findBestMatch(deltaSurface.paths, normalizedPath);

  if (bestMatch) {
    return bestMatch;
  }

  // No specific match, return defaults
  return deltaSurface.defaults;
}

/**
 * Normalize a path for matching
 */
function normalizePath(path: string): string {
  // Remove query string
  const queryIndex = path.indexOf('?');
  if (queryIndex !== -1) {
    path = path.substring(0, queryIndex);
  }

  // Remove trailing slash (but keep root "/")
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }

  // Remove leading slash for matching (we'll add it back in patterns)
  // Actually, keep it - patterns include leading slash
  return path;
}

/**
 * Find the best matching path pattern for a given path
 */
function findBestMatch(
  paths: Record<string, PathDeltaSurface>,
  path: string
): PathDeltaSurface | null {
  let bestMatch: { pattern: string; config: PathDeltaSurface; specificity: number } | null = null;

  for (const [pattern, config] of Object.entries(paths)) {
    const parsedPattern = parsePathPattern(pattern);
    const specificity = calculateSpecificity(parsedPattern);
    
    if (matchesPattern(parsedPattern, path)) {
      if (!bestMatch || specificity > bestMatch.specificity) {
        bestMatch = { pattern, config, specificity };
      }
    }
  }

  return bestMatch?.config || null;
}

/**
 * Calculate specificity score for a pattern
 * More specific patterns have higher scores
 */
function calculateSpecificity(pattern: ParsedPathPattern): number {
  switch (pattern.type) {
    case 'exact':
      // Exact matches are most specific
      // Longer paths are more specific
      return 1000 + pattern.pattern.split('/').filter(Boolean).length * 10;
    
    case 'parameterized': {
      // Parameterized paths are less specific than exact
      const paramCount = (pattern.pattern.match(/\{[^}]+\}/g) || []).length;
      const segmentCount = pattern.pattern.split('/').filter(Boolean).length;
      return 500 + segmentCount * 10 - paramCount * 5;
    }
    
    case 'wildcard': {
      // Wildcards are least specific
      const wildcardSegmentCount = pattern.pattern.split('/').filter(Boolean).length;
      return 100 + wildcardSegmentCount * 10;
    }
    
    default:
      return 0;
  }
}

/**
 * Check if a path matches a pattern
 */
function matchesPattern(pattern: ParsedPathPattern, path: string): boolean {
  switch (pattern.type) {
    case 'exact':
      return path === pattern.pattern;

    case 'parameterized':
    case 'wildcard':
      if (pattern.regex) {
        return pattern.regex.test(path);
      }
      // Fallback for patterns without regex
      return path === pattern.pattern;

    default:
      return false;
  }
}

// ============================================================================
// Wildcard Matching for Field Paths
// ============================================================================

/**
 * Check if a field path matches a wildcard pattern
 * 
 * Patterns:
 * - "data.name" - exact match
 * - "data.*" - matches any direct child of data
 * - "*.name" - matches name field in any object
 * - "data.items[*]" - matches any array element
 * - "**" - matches any path (recursive wildcard)
 */
export function matchesFieldPattern(path: string, pattern: string): boolean {
  // Escape special regex characters except * and .
  // First, escape all regex special characters
  let regexPattern = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  
  // Then convert ** to match any characters including dots
  regexPattern = regexPattern.replace(/\*\*/g, '.*');
  // Convert * to match any characters except dots
  regexPattern = regexPattern.replace(/\*/g, '[^.]*');

  try {
    // ^ and $ for full match
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(path);
  } catch {
    // If regex fails, do simple string matching
    return path === pattern || pattern === '**';
  }
}

/**
 * Check if a header name matches a wildcard pattern
 * Header matching is case-insensitive
 */
export function matchesHeaderPattern(header: string, pattern: string): boolean {
  const normalizedHeader = header.toLowerCase();
  const normalizedPattern = pattern.toLowerCase();
  return matchesFieldPattern(normalizedHeader, normalizedPattern);
}

// ============================================================================
// Path Manipulation
// ============================================================================

/**
 * Extract path segments from a path string
 */
export function getPathSegments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

/**
 * Join path segments into a path string
 */
export function joinPathSegments(segments: string[]): string {
  return '/' + segments.filter(Boolean).join('/');
}

/**
 * Check if a path is a prefix of another path
 */
export function isPathPrefix(prefix: string, path: string): boolean {
  const prefixSegments = getPathSegments(prefix);
  const pathSegments = getPathSegments(path);
  
  if (prefixSegments.length > pathSegments.length) {
    return false;
  }
  
  for (let i = 0; i < prefixSegments.length; i++) {
    if (prefixSegments[i] !== pathSegments[i]) {
      return false;
    }
  }
  
  return true;
}

// ============================================================================
// Testing Exports
// ============================================================================

/**
 * Test if the matcher is working correctly
 */
export function testMatcher(): void {
  const deltaSurface: DeltaSurface = {
    version: '1.0',
    paths: {
      '/api/users': {
        statusCodes: { allowed: [200, 201] },
      },
      '/api/users/{id}': {
        statusCodes: { allowed: [200, 404] },
      },
      '/api/*': {
        statusCodes: { allowed: [200] },
      },
    },
    defaults: {
      statusCodes: { allowed: [200, 400, 401, 403, 404, 500] },
    },
  };

  // Test exact match
  const exact = matchPath(deltaSurface, '/api/users');
  console.assert(exact.statusCodes?.allowed?.includes(200), 'Exact match failed');

  // Test parameterized match
  const param = matchPath(deltaSurface, '/api/users/123');
  console.assert(param.statusCodes?.allowed?.includes(200), 'Parameterized match failed');

  // Test wildcard match
  const wildcard = matchPath(deltaSurface, '/api/products');
  console.assert(wildcard.statusCodes?.allowed?.includes(200), 'Wildcard match failed');

  // Test default
  const defaultConfig = matchPath(deltaSurface, '/health');
  console.assert(
    defaultConfig.statusCodes?.allowed?.includes(200),
    'Default match failed'
  );
}

// ============================================================================
// Exports
// ============================================================================

export {
  normalizePath,
  parsePathPattern,
  findBestMatch,
  calculateSpecificity,
};
