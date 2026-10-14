/**
 * Status Code Comparison
 * 
 * Compares HTTP status codes between baseline and candidate responses
 * according to the declared delta surface rules.
 */

import type {
  StatusResult,
  DeltaSurface,
  PathDeltaSurface,
} from '../types';
import { matchPath } from '../delta-surface';

// ============================================================================
// Status Code Comparison
// ============================================================================

/**
 * Compare status codes between baseline and candidate
 * 
 * @param baselineStatus - Status code from baseline response
 * @param candidateStatus - Status code from candidate response
 * @param deltaSurface - The declared delta surface
 * @param path - The request path (for path-specific rules)
 * @returns Status comparison result
 */
export function compareStatusCodes(
  baselineStatus: number,
  candidateStatus: number,
  deltaSurface: DeltaSurface,
  path: string
): StatusResult {
  // Get the path-specific configuration
  const pathConfig = matchPath(deltaSurface, path);

  // Get status code configuration (path-specific or default)
  const statusConfig = pathConfig.statusCodes || deltaSurface.defaults.statusCodes || {};

  // If both status codes are in the allowed list, they match
  const allowed = statusConfig.allowed || [];
  const forbidden = statusConfig.forbidden || [];

  const baselineAllowed = allowed.includes(baselineStatus);
  const candidateAllowed = allowed.includes(candidateStatus);

  // Check if candidate status is forbidden
  if (forbidden.includes(candidateStatus)) {
    return {
      match: false,
      type: 'status_forbidden',
      baselineStatus,
      candidateStatus,
      severity: 'error',
    };
  }

  // Check if baseline status is forbidden (shouldn't happen, but handle it)
  if (forbidden.includes(baselineStatus)) {
    // If both are forbidden, that's weird but we'll consider it a match
    if (forbidden.includes(candidateStatus)) {
      return {
        match: true,
        type: 'status_match',
        baselineStatus,
        candidateStatus,
      };
    }
    // Only baseline is forbidden - this is an error case
    return {
      match: false,
      type: 'status_mismatch',
      baselineStatus,
      candidateStatus,
      severity: 'error',
    };
  }

  // Both status codes are allowed
  if (baselineAllowed && candidateAllowed) {
    // If they're the same, perfect match
    if (baselineStatus === candidateStatus) {
      return {
        match: true,
        type: 'status_match',
        baselineStatus,
        candidateStatus,
      };
    }

    // Different but both allowed - this is a warning
    return {
      match: false,
      type: 'status_mismatch',
      baselineStatus,
      candidateStatus,
      severity: 'warning',
    };
  }

  // Baseline is allowed but candidate is not in allowed list
  if (baselineAllowed && !candidateAllowed) {
    return {
      match: false,
      type: 'status_mismatch',
      baselineStatus,
      candidateStatus,
      severity: 'error',
    };
  }

  // Candidate is allowed but baseline is not in allowed list
  if (!baselineAllowed && candidateAllowed) {
    return {
      match: false,
      type: 'status_mismatch',
      baselineStatus,
      candidateStatus,
      severity: 'warning',
    };
  }

  // Neither is in the allowed list
  return {
    match: false,
    type: 'status_mismatch',
    baselineStatus,
    candidateStatus,
    severity: 'warning',
  };
}

// ============================================================================
// Status Code Classification
// ============================================================================

/**
 * Classify a status code into a category
 */
export function classifyStatusCode(status: number): StatusCodeCategory {
  if (status >= 200 && status < 300) {
    return 'success';
  }
  if (status >= 300 && status < 400) {
    return 'redirect';
  }
  if (status >= 400 && status < 500) {
    return 'client_error';
  }
  if (status >= 500 && status < 600) {
    return 'server_error';
  }
  return 'unknown';
}

/**
 * Status code category
 */
export type StatusCodeCategory =
  | 'success'
  | 'redirect'
  | 'client_error'
  | 'server_error'
  | 'unknown';

/**
 * Check if two status codes are in the same category
 */
export function sameStatusCategory(a: number, b: number): boolean {
  return classifyStatusCode(a) === classifyStatusCode(b);
}

/**
 * Check if a status code is considered "successful"
 * (2xx and 3xx are typically considered successful in API contexts)
 */
export function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 400;
}

/**
 * Check if a status code is an error
 */
export function isErrorStatus(status: number): boolean {
  return status >= 400;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get the HTTP status text for a status code
 */
export function getStatusText(status: number): string {
  const statusTexts: Record<number, string> = {
    100: 'Continue',
    101: 'Switching Protocols',
    102: 'Processing',
    200: 'OK',
    201: 'Created',
    202: 'Accepted',
    203: 'Non-Authoritative Information',
    204: 'No Content',
    205: 'Reset Content',
    206: 'Partial Content',
    207: 'Multi-Status',
    208: 'Already Reported',
    226: 'IM Used',
    300: 'Multiple Choices',
    301: 'Moved Permanently',
    302: 'Found',
    303: 'See Other',
    304: 'Not Modified',
    305: 'Use Proxy',
    307: 'Temporary Redirect',
    308: 'Permanent Redirect',
    400: 'Bad Request',
    401: 'Unauthorized',
    402: 'Payment Required',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    406: 'Not Acceptable',
    407: 'Proxy Authentication Required',
    408: 'Request Timeout',
    409: 'Conflict',
    410: 'Gone',
    411: 'Length Required',
    412: 'Precondition Failed',
    413: 'Payload Too Large',
    414: 'URI Too Long',
    415: 'Unsupported Media Type',
    416: 'Range Not Satisfiable',
    417: 'Expectation Failed',
    418: "I'm a teapot",
    421: 'Misdirected Request',
    422: 'Unprocessable Entity',
    423: 'Locked',
    424: 'Failed Dependency',
    425: 'Too Early',
    426: 'Upgrade Required',
    428: 'Precondition Required',
    429: 'Too Many Requests',
    431: 'Request Header Fields Too Large',
    451: 'Unavailable For Legal Reasons',
    500: 'Internal Server Error',
    501: 'Not Implemented',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
    505: 'HTTP Version Not Supported',
    506: 'Variant Also Negotiates',
    507: 'Insufficient Storage',
    508: 'Loop Detected',
    510: 'Not Extended',
    511: 'Network Authentication Required',
  };

  return statusTexts[status] || `Unknown Status ${status}`;
}

// ============================================================================
// Exports
// ============================================================================

export type { StatusResult, DeltaSurface, PathDeltaSurface };
