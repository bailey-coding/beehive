/**
 * Body Comparison
 * 
 * Compares response bodies between baseline and candidate responses
 * according to the declared delta surface rules.
 */

import type {
  BodyComparisonResult,
  BodyDiff,
  DeltaSurface,
  PathDeltaSurface,
  JsonPath,
  JsonPathSegment,
} from '../types';
import { matchPath, matchesFieldPattern } from '../delta-surface';
import { normalizeBody, deepEqual, isPlainObject } from './normalizers';

// ============================================================================
// JSON Path Utilities
// ============================================================================

/**
 * Get all paths in a JSON object
 */
export function getAllPaths(obj: unknown, prefix: string = ''): string[] {
  const paths: string[] = [];

  if (obj === null || obj === undefined) {
    return paths;
  }

  if (typeof obj !== 'object') {
    return paths;
  }

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const childPaths = getAllPaths(obj[i], `${prefix}[${i}]`);
      paths.push(...childPaths);
    }
    return paths;
  }

  for (const key of Object.keys(obj)) {
    const childPaths = getAllPaths((obj as Record<string, unknown>)[key], 
      prefix ? `${prefix}.${key}` : key);
    paths.push(prefix ? `${prefix}.${key}` : key);
    paths.push(...childPaths);
  }

  return paths;
}

/**
 * Get value at a JSON path
 */
export function getPathValue(obj: unknown, path: string): unknown {
  if (!path) {
    return obj;
  }

  // Parse the path
  const segments = parsePath(path);
  let current: unknown = obj;

  for (const segment of segments) {
    if (current === null || current === undefined) {
      return undefined;
    }

    if (typeof segment === 'number') {
      if (Array.isArray(current) && segment < current.length) {
        current = current[segment];
      } else {
        return undefined;
      }
    } else {
      if (isPlainObject(current) && segment in current) {
        current = (current as Record<string, unknown>)[segment];
      } else {
        return undefined;
      }
    }
  }

  return current;
}

/**
 * Set value at a JSON path (for testing)
 */
export function setPathValue(obj: unknown, path: string, value: unknown): unknown {
  if (!path) {
    return value;
  }

  // Make a deep copy
  const result = deepClone(obj);
  const segments = parsePath(path);
  let current: unknown = result;

  // Navigate to the parent
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];

    if (current === null || current === undefined) {
      // Create the path
      current = {};
      // This is a simplified version - full implementation would track parent
    }

    if (typeof segment === 'number') {
      if (!Array.isArray(current)) {
        return result; // Can't set array index on non-array
      }
      while (current.length <= segment) {
        current.push(undefined);
      }
      current = current[segment];
    } else {
      if (!isPlainObject(current)) {
        return result; // Can't set object key on non-object
      }
      if (!(segment in (current as Record<string, unknown>))) {
        (current as Record<string, unknown>)[segment] = undefined;
      }
      current = (current as Record<string, unknown>)[segment];
    }
  }

  // Set the final value
  const lastSegment = segments[segments.length - 1];
  if (typeof lastSegment === 'number') {
    if (Array.isArray(current)) {
      while (current.length <= lastSegment) {
        current.push(undefined);
      }
      current[lastSegment] = value;
    }
  } else {
    if (isPlainObject(current)) {
      (current as Record<string, unknown>)[lastSegment] = value;
    }
  }

  return result;
}

/**
 * Parse a JSON path string into segments
 */
export function parsePath(path: string): JsonPath {
  const segments: JsonPath = [];
  let current = '';
  let inBracket = false;
  let bracketContent = '';

  for (let i = 0; i < path.length; i++) {
    const char = path[i];

    if (inBracket) {
      if (char === ']') {
        // Parse bracket content
        if (bracketContent.startsWith('"') && bracketContent.endsWith('"')) {
          segments.push(bracketContent.slice(1, -1));
        } else if (/^\d+$/.test(bracketContent)) {
          segments.push(parseInt(bracketContent, 10));
        } else {
          segments.push(bracketContent);
        }
        inBracket = false;
        bracketContent = '';
      } else {
        bracketContent += char;
      }
    } else {
      if (char === '[') {
        if (current) {
          segments.push(current);
          current = '';
        }
        inBracket = true;
      } else if (char === '.') {
        if (current) {
          segments.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }
  }

  if (current) {
    segments.push(current);
  }

  return segments;
}

/**
 * Deep clone a value
 */
export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

// ============================================================================
// Body Comparison
// ============================================================================

/**
 * Compare bodies between baseline and candidate responses
 * 
 * @param baselineBody - Body from baseline response
 * @param candidateBody - Body from candidate response
 * @param deltaSurface - The declared delta surface
 * @param requestPath - The request path (for path-specific rules)
 * @param contentType - Content-Type header from baseline (for parsing)
 * @returns Body comparison result
 */
export function compareBodies(
  baselineBody: string | undefined,
  candidateBody: string | undefined,
  deltaSurface: DeltaSurface,
  requestPath: string,
  contentType?: string
): BodyComparisonResult {
  // Get the path-specific configuration
  const pathConfig = matchPath(deltaSurface, requestPath);

  // Get body configuration (path-specific or default)
  const bodyConfig = pathConfig.response?.body || deltaSurface.defaults.response?.body;

  // Normalize both bodies
  const normalizedBaseline = normalizeBody(baselineBody, contentType);
  const normalizedCandidate = normalizeBody(candidateBody, contentType);

  // If both bodies are null/undefined, they match
  if (normalizedBaseline === null && normalizedCandidate === null) {
    return { match: true, diffs: [] };
  }

  // If one is null and the other isn't, that's a diff
  if (normalizedBaseline === null || normalizedCandidate === null) {
    return {
      match: false,
      diffs: [{
        path: '',
        baselineValue: normalizedBaseline,
        candidateValue: normalizedCandidate,
        type: normalizedBaseline === null ? 'missing_field' : 'new_field',
        severity: 'error',
      }],
    };
  }

  // If both are strings (not parsed JSON), do simple string comparison
  if (typeof normalizedBaseline === 'string' && typeof normalizedCandidate === 'string') {
    if (normalizedBaseline === normalizedCandidate) {
      return { match: true, diffs: [] };
    }

    return {
      match: false,
      diffs: [{
        path: '',
        baselineValue: normalizedBaseline,
        candidateValue: normalizedCandidate,
        type: 'forbidden_diff',
        severity: 'error',
      }],
    };
  }

  // Both are objects/arrays - do deep comparison
  const diffs: BodyDiff[] = [];

  // Get all paths from both bodies
  const baselinePaths = new Set(getAllPaths(normalizedBaseline as object, ''));
  const candidatePaths = new Set(getAllPaths(normalizedCandidate as object, ''));
  const allPaths = new Set([...baselinePaths, ...candidatePaths]);

  for (const path of allPaths) {
    const baselineValue = getPathValue(normalizedBaseline, path);
    const candidateValue = getPathValue(normalizedCandidate, path);

    // New field in candidate
    if (baselineValue === undefined && candidateValue !== undefined) {
      const isAllowed = isFieldAllowedToDiffer(path, bodyConfig?.allowedDiffs);
      const isForbidden = isFieldForbiddenToDiffer(path, bodyConfig?.forbiddenDiffs);

      if (isForbidden) {
        diffs.push({
          path,
          baselineValue: undefined,
          candidateValue,
          type: 'new_field',
          severity: 'error',
        });
      } else if (!isAllowed && !bodyConfig?.newFieldsAllowed) {
        // New fields not allowed by default
        diffs.push({
          path,
          baselineValue: undefined,
          candidateValue,
          type: 'new_field',
          severity: 'error',
        });
      }
      // If allowed, no diff
      continue;
    }

    // Missing field in candidate
    if (baselineValue !== undefined && candidateValue === undefined) {
      const isAllowed = isFieldAllowedToDiffer(path, bodyConfig?.allowedDiffs);
      const isForbidden = isFieldForbiddenToDiffer(path, bodyConfig?.forbiddenDiffs);

      if (isForbidden || !bodyConfig?.missingFieldsAllowed) {
        diffs.push({
          path,
          baselineValue,
          candidateValue: undefined,
          type: 'missing_field',
          severity: 'error',
        });
      }
      // If explicitly allowed or missing fields allowed, no diff
      continue;
    }

    // Both have values, check if they're equal
    if (!deepEqual(baselineValue, candidateValue)) {
      const isAllowed = isFieldAllowedToDiffer(path, bodyConfig?.allowedDiffs);
      const isForbidden = isFieldForbiddenToDiffer(path, bodyConfig?.forbiddenDiffs);

      // Check for type mismatch
      if (typeof baselineValue !== typeof candidateValue) {
        if (isForbidden) {
          diffs.push({
            path,
            baselineValue,
            candidateValue,
            type: 'type_mismatch',
            severity: 'error',
          });
        } else if (!isAllowed) {
          diffs.push({
            path,
            baselineValue,
            candidateValue,
            type: 'type_mismatch',
            severity: 'error',
          });
        }
        continue;
      }

      // Values differ
      if (isForbidden) {
        diffs.push({
          path,
          baselineValue,
          candidateValue,
          type: 'forbidden_diff',
          severity: 'error',
        });
      } else if (!isAllowed) {
        diffs.push({
          path,
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
 * Check if a field path is allowed to differ
 */
function isFieldAllowedToDiffer(path: string, allowedDiffs?: string[]): boolean {
  if (!allowedDiffs || allowedDiffs.length === 0) {
    return false;
  }

  return allowedDiffs.some(pattern => matchesFieldPattern(path, pattern));
}

/**
 * Check if a field path is forbidden to differ
 */
function isFieldForbiddenToDiffer(path: string, forbiddenDiffs?: string[]): boolean {
  if (!forbiddenDiffs || forbiddenDiffs.length === 0) {
    return false;
  }

  return forbiddenDiffs.some(pattern => matchesFieldPattern(path, pattern));
}

// ============================================================================
// Exports
// ============================================================================

export type { BodyComparisonResult, BodyDiff, DeltaSurface, PathDeltaSurface };
