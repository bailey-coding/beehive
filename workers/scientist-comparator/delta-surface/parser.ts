/**
 * Delta Surface Parser
 * 
 * Parses and validates the declared delta surface JSON from specs.
 * Handles version checking, schema validation, and defaults.
 */

import type { DeltaSurface, PathDeltaSurface } from '../types';

// ============================================================================
// Constants
// ============================================================================

const SUPPORTED_VERSION = '1.0';

const DEFAULT_DELTA_SURFACE: PathDeltaSurface = {
  statusCodes: {
    allowed: [200, 201, 204, 301, 302, 400, 401, 403, 404],
    forbidden: [500, 502, 503, 504],
  },
  response: {
    body: {
      allowedDiffs: [],
      forbiddenDiffs: ['id', 'type', 'createdAt', 'updatedAt'],
      newFieldsAllowed: false,
      missingFieldsAllowed: false,
    },
    headers: {
      allowedDiffs: ['X-*', 'Cache-Control', 'ETag', 'Last-Modified'],
      forbiddenDiffs: ['Content-Type', 'Authorization', 'Set-Cookie'],
    },
  },
  performance: {
    maxLatencyDeltaMs: 100,
    maxLatencyRatio: 2.0,
  },
};

// ============================================================================
// Parser
// ============================================================================

/**
 * Parse a delta surface from a JSON string or object
 */
export function parseDeltaSurface(input: string | unknown): DeltaSurface {
  // If it's a string, parse it
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      return parseDeltaSurface(parsed);
    } catch (error) {
      throw new Error(`Invalid JSON in delta surface: ${error}`);
    }
  }

  // Validate that it's an object
  if (typeof input !== 'object' || input === null) {
    throw new Error(`Delta surface must be an object, got ${typeof input}`);
  }

  const deltaSurface = input as Record<string, unknown>;

  // Check version
  const version = deltaSurface.version as string;
  if (!version) {
    throw new Error('Delta surface missing required "version" field');
  }

  if (version !== SUPPORTED_VERSION) {
    throw new Error(
      `Unsupported delta surface version: ${version}. ` +
      `Supported version: ${SUPPORTED_VERSION}`
    );
  }

  // Validate paths
  const paths = deltaSurface.paths as Record<string, unknown>;
  if (!paths || typeof paths !== 'object') {
    throw new Error('Delta surface missing or invalid "paths" field');
  }

  // Validate defaults
  const defaults = deltaSurface.defaults as Record<string, unknown>;
  if (!defaults || typeof defaults !== 'object') {
    throw new Error('Delta surface missing or invalid "defaults" field');
  }

  // Parse and validate each path
  const parsedPaths: Record<string, PathDeltaSurface> = {};
  for (const [pathPattern, pathConfig] of Object.entries(paths)) {
    parsedPaths[pathPattern] = parsePathDeltaSurface(pathConfig);
  }

  // Parse defaults
  const parsedDefaults = parsePathDeltaSurface(defaults);

  return {
    version,
    paths: parsedPaths,
    defaults: parsedDefaults,
  };
}

/**
 * Parse a path-level delta surface configuration
 */
function parsePathDeltaSurface(config: unknown): PathDeltaSurface {
  if (typeof config !== 'object' || config === null) {
    return { ...DEFAULT_DELTA_SURFACE };
  }

  const obj = config as Record<string, unknown>;
  const result: PathDeltaSurface = {};

  // Parse statusCodes
  if (obj.statusCodes !== undefined) {
    result.statusCodes = parseStatusCodes(obj.statusCodes);
  }

  // Parse response
  if (obj.response !== undefined) {
    result.response = parseResponseConfig(obj.response);
  }

  // Parse performance
  if (obj.performance !== undefined) {
    result.performance = parsePerformanceConfig(obj.performance);
  }

  return result;
}

/**
 * Parse status code configuration
 */
function parseStatusCodes(config: unknown): { allowed?: number[]; forbidden?: number[] } {
  if (typeof config !== 'object' || config === null) {
    return {};
  }

  const obj = config as Record<string, unknown>;
  const result: { allowed?: number[]; forbidden?: number[] } = {};

  if (obj.allowed !== undefined) {
    if (!Array.isArray(obj.allowed)) {
      throw new Error('statusCodes.allowed must be an array');
    }
    result.allowed = obj.allowed.filter((v): v is number => typeof v === 'number');
  }

  if (obj.forbidden !== undefined) {
    if (!Array.isArray(obj.forbidden)) {
      throw new Error('statusCodes.forbidden must be an array');
    }
    result.forbidden = obj.forbidden.filter((v): v is number => typeof v === 'number');
  }

  return result;
}

/**
 * Parse response configuration
 */
function parseResponseConfig(config: unknown): {
  body?: {
    allowedDiffs?: string[];
    forbiddenDiffs?: string[];
    newFieldsAllowed?: boolean;
    missingFieldsAllowed?: boolean;
  };
  headers?: { allowedDiffs?: string[]; forbiddenDiffs?: string[] };
} {
  if (typeof config !== 'object' || config === null) {
    return {};
  }

  const obj = config as Record<string, unknown>;
  const result: ReturnType<typeof parseResponseConfig> = {};

  if (obj.body !== undefined) {
    result.body = parseBodyConfig(obj.body);
  }

  if (obj.headers !== undefined) {
    result.headers = parseHeadersConfig(obj.headers);
  }

  return result;
}

/**
 * Parse body configuration
 */
function parseBodyConfig(config: unknown): {
  allowedDiffs?: string[];
  forbiddenDiffs?: string[];
  newFieldsAllowed?: boolean;
  missingFieldsAllowed?: boolean;
} {
  if (typeof config !== 'object' || config === null) {
    return {};
  }

  const obj = config as Record<string, unknown>;
  const result: ReturnType<typeof parseBodyConfig> = {};

  if (obj.allowedDiffs !== undefined) {
    if (!Array.isArray(obj.allowedDiffs)) {
      throw new Error('body.allowedDiffs must be an array');
    }
    result.allowedDiffs = obj.allowedDiffs.filter((v): v is string => typeof v === 'string');
  }

  if (obj.forbiddenDiffs !== undefined) {
    if (!Array.isArray(obj.forbiddenDiffs)) {
      throw new Error('body.forbiddenDiffs must be an array');
    }
    result.forbiddenDiffs = obj.forbiddenDiffs.filter((v): v is string => typeof v === 'string');
  }

  if (obj.newFieldsAllowed !== undefined) {
    if (typeof obj.newFieldsAllowed !== 'boolean') {
      throw new Error('body.newFieldsAllowed must be a boolean');
    }
    result.newFieldsAllowed = obj.newFieldsAllowed;
  }

  if (obj.missingFieldsAllowed !== undefined) {
    if (typeof obj.missingFieldsAllowed !== 'boolean') {
      throw new Error('body.missingFieldsAllowed must be a boolean');
    }
    result.missingFieldsAllowed = obj.missingFieldsAllowed;
  }

  return result;
}

/**
 * Parse headers configuration
 */
function parseHeadersConfig(config: unknown): { allowedDiffs?: string[]; forbiddenDiffs?: string[] } {
  if (typeof config !== 'object' || config === null) {
    return {};
  }

  const obj = config as Record<string, unknown>;
  const result: { allowedDiffs?: string[]; forbiddenDiffs?: string[] } = {};

  if (obj.allowedDiffs !== undefined) {
    if (!Array.isArray(obj.allowedDiffs)) {
      throw new Error('headers.allowedDiffs must be an array');
    }
    result.allowedDiffs = obj.allowedDiffs.filter((v): v is string => typeof v === 'string');
  }

  if (obj.forbiddenDiffs !== undefined) {
    if (!Array.isArray(obj.forbiddenDiffs)) {
      throw new Error('headers.forbiddenDiffs must be an array');
    }
    result.forbiddenDiffs = obj.forbiddenDiffs.filter((v): v is string => typeof v === 'string');
  }

  return result;
}

/**
 * Parse performance configuration
 */
function parsePerformanceConfig(config: unknown): {
  maxLatencyDeltaMs?: number;
  maxLatencyRatio?: number;
} {
  if (typeof config !== 'object' || config === null) {
    return {};
  }

  const obj = config as Record<string, unknown>;
  const result: ReturnType<typeof parsePerformanceConfig> = {};

  if (obj.maxLatencyDeltaMs !== undefined) {
    if (typeof obj.maxLatencyDeltaMs !== 'number' || obj.maxLatencyDeltaMs < 0) {
      throw new Error('performance.maxLatencyDeltaMs must be a non-negative number');
    }
    result.maxLatencyDeltaMs = obj.maxLatencyDeltaMs;
  }

  if (obj.maxLatencyRatio !== undefined) {
    if (typeof obj.maxLatencyRatio !== 'number' || obj.maxLatencyRatio <= 0) {
      throw new Error('performance.maxLatencyRatio must be a positive number');
    }
    result.maxLatencyRatio = obj.maxLatencyRatio;
  }

  return result;
}

// ============================================================================
// Validator
// ============================================================================

/**
 * Validate that a delta surface is complete and well-formed
 */
export function validateDeltaSurface(deltaSurface: DeltaSurface): string[] {
  const errors: string[] = [];

  // Check version
  if (deltaSurface.version !== SUPPORTED_VERSION) {
    errors.push(`Unsupported version: ${deltaSurface.version}`);
  }

  // Check paths
  if (!deltaSurface.paths || typeof deltaSurface.paths !== 'object') {
    errors.push('Missing or invalid paths');
  } else {
    for (const [pathPattern, config] of Object.entries(deltaSurface.paths)) {
      const pathErrors = validatePathDeltaSurface(config);
      if (pathErrors.length > 0) {
        errors.push(`Path "${pathPattern}": ${pathErrors.join(', ')}`);
      }
    }
  }

  // Check defaults
  if (!deltaSurface.defaults || typeof deltaSurface.defaults !== 'object') {
    errors.push('Missing or invalid defaults');
  } else {
    const defaultErrors = validatePathDeltaSurface(deltaSurface.defaults);
    if (defaultErrors.length > 0) {
      errors.push(`Defaults: ${defaultErrors.join(', ')}`);
    }
  }

  return errors;
}

/**
 * Validate a path-level delta surface configuration
 */
function validatePathDeltaSurface(config: unknown): string[] {
  const errors: string[] = [];

  if (typeof config !== 'object' || config === null) {
    return ['Must be an object'];
  }

  const obj = config as Record<string, unknown>;

  if (obj.statusCodes !== undefined) {
    if (typeof obj.statusCodes !== 'object' || obj.statusCodes === null) {
      errors.push('statusCodes must be an object');
    }
  }

  if (obj.response !== undefined) {
    if (typeof obj.response !== 'object' || obj.response === null) {
      errors.push('response must be an object');
    }
  }

  if (obj.performance !== undefined) {
    if (typeof obj.performance !== 'object' || obj.performance === null) {
      errors.push('performance must be an object');
    }
  }

  return errors;
}

// ============================================================================
// Defaults
// ============================================================================

/**
 * Get the default delta surface configuration
 * Used when spec doesn't define one or as fallback
 */
export function getDefaultDeltaSurface(): DeltaSurface {
  return {
    version: SUPPORTED_VERSION,
    paths: {},
    defaults: DEFAULT_DELTA_SURFACE,
  };
}

/**
 * Get the default path configuration
 */
export function getDefaultPathConfig(): PathDeltaSurface {
  return { ...DEFAULT_DELTA_SURFACE };
}

// ============================================================================
// Exports
// ============================================================================

export { SUPPORTED_VERSION };
