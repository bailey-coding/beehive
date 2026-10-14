/**
 * Helper Utilities
 * 
 * General utility functions used throughout the Scientist Comparator.
 */

// ============================================================================
// Error Handling
// ============================================================================

/**
 * Custom error class for Scientist Comparator errors
 */
export class ScientistError extends Error {
  constructor(
    message: string,
    public readonly type: ScientistErrorType,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ScientistError';
  }
}

/**
 * Error types
 */
export type ScientistErrorType =
  | 'comparison_error'
  | 'delta_surface_error'
  | 'storage_error'
  | 'queue_error'
  | 'validation_error'
  | 'unknown_error';

/**
 * Wrap a promise with error handling
 */
export async function withErrorHandling<T>(
  promise: Promise<T>,
  context: string
): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof ScientistError) {
      throw error;
    }
    throw new ScientistError(
      `${context}: ${error}`,
      'unknown_error',
      error instanceof Error ? { message: error.message, stack: error.stack } : undefined
    );
  }
}

/**
 * Retry a function with exponential backoff
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    backoffFactor?: number;
  } = {}
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 100,
    maxDelayMs = 5000,
    backoffFactor = 2,
  } = options;

  let lastError: unknown;
  let retryCount = 0;

  while (retryCount <= maxRetries) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      retryCount++;

      if (retryCount > maxRetries) {
        break;
      }

      // Calculate delay with exponential backoff
      const delayMs = Math.min(
        baseDelayMs * Math.pow(backoffFactor, retryCount - 1),
        maxDelayMs
      );

      // Add jitter
      const jitter = delayMs * 0.1 * Math.random();
      const totalDelay = delayMs + jitter;

      await new Promise(resolve => setTimeout(resolve, totalDelay));
    }
  }

  throw lastError;
}

// ============================================================================
// String Utilities
// ============================================================================

/**
 * Generate a unique ID for comparison results
 */
export function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Generate a comparison ID from request details
 * Uses a simple hash for determinism without crypto
 */
export function generateComparisonId(requestId: string, candidateId: string): string {
  // Simple hash combining both IDs
  let hash = 0;
  const combined = `${requestId}:${candidateId}`;
  for (let i = 0; i < combined.length; i++) {
    const char = combined.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  // Return as hex string
  return Math.abs(hash).toString(16).substring(0, 16);
}

/**
 * Truncate a string to a maximum length
 */
export function truncateString(str: string, maxLength: number): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.substring(0, maxLength) + '...';
}

// ============================================================================
// Object Utilities
// ============================================================================

/**
 * Deep merge two objects
 */
export function deepMerge<T extends Record<string, unknown>, U extends Record<string, unknown>>(
  target: T,
  source: U
): T & U {
  const result = { ...target } as Record<string, unknown>;

  for (const key of Object.keys(source)) {
    const sourceValue = (source as Record<string, unknown>)[key];
    const targetValue = result[key];

    if (isPlainObject(sourceValue) && isPlainObject(targetValue)) {
      result[key] = deepMerge(
        targetValue as Record<string, unknown>,
        sourceValue as Record<string, unknown>
      );
    } else if (Array.isArray(sourceValue) && Array.isArray(targetValue)) {
      result[key] = [...(targetValue as unknown[]), ...(sourceValue as unknown[])];
    } else {
      result[key] = sourceValue;
    }
  }

  return result as T & U;
}

/**
 * Check if a value is a plain object
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Pick specific properties from an object
 */
export function pick<T extends Record<string, unknown>, K extends keyof T>(
  obj: T,
  keys: K[]
): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const key of keys) {
    if (key in obj) {
      result[key] = obj[key];
    }
  }
  return result;
}

/**
 * Omit specific properties from an object
 */
export function omit<T extends Record<string, unknown>, K extends keyof T>(
  obj: T,
  keys: K[]
): Omit<T, K> {
  const result = { ...obj };
  for (const key of keys) {
    delete result[key];
  }
  return result;
}

// ============================================================================
// Array Utilities
// ============================================================================

/**
 * Chunk an array into smaller arrays
 */
export function chunk<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Group array items by a key function
 */
export function groupBy<T, K extends string | number | symbol>(
  array: T[],
  keyFn: (item: T) => K
): Record<K, T[]> {
  const groups: Record<K, T[]> = {} as Record<K, T[]>;
  for (const item of array) {
    const key = keyFn(item);
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(item);
  }
  return groups;
}

/**
 * Get unique values from an array
 */
export function unique<T>(array: T[]): T[] {
  return Array.from(new Set(array));
}

// ============================================================================
// Timing Utilities
// ============================================================================

/**
 * Measure the execution time of a function
 */
export async function measureTime<T>(
  fn: () => Promise<T> | T
): Promise<{ result: T; durationMs: number }> {
  const start = performance.now();
  const result = await fn();
  const durationMs = performance.now() - start;
  return { result, durationMs };
}

/**
 * Create a timeout promise
 */
export function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Timeout after ${ms}ms`));
    }, ms);
  });
}

/**
 * Race a promise against a timeout
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number
): Promise<T> {
  return Promise.race([promise, timeout(ms)]);
}

// ============================================================================
// Logging Utilities
// ============================================================================

/**
 * Log levels
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

/**
 * Logger configuration
 */
export interface LoggerConfig {
  level: LogLevel;
  prefix?: string;
}

/**
 * Simple logger
 */
export class Logger {
  private readonly config: LoggerConfig;

  constructor(config: LoggerConfig = { level: 'info' }) {
    this.config = config;
  }

  debug(message: string, data?: unknown): void {
    if (this.shouldLog('debug')) {
      this.log('DEBUG', message, data);
    }
  }

  info(message: string, data?: unknown): void {
    if (this.shouldLog('info')) {
      this.log('INFO', message, data);
    }
  }

  warn(message: string, data?: unknown): void {
    if (this.shouldLog('warn')) {
      this.log('WARN', message, data);
    }
  }

  error(message: string, data?: unknown): void {
    if (this.shouldLog('error')) {
      this.log('ERROR', message, data);
    }
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    const levelIndex = levels.indexOf(this.config.level);
    const messageIndex = levels.indexOf(level);
    return messageIndex >= levelIndex;
  }

  private log(level: string, message: string, data?: unknown): void {
    const prefix = this.config.prefix ? `[${this.config.prefix}] ` : '';
    const timestamp = new Date().toISOString();
    const logMessage = `${timestamp} ${level} ${prefix}${message}`;

    if (data !== undefined) {
      console.log(logMessage, data);
    } else {
      console.log(logMessage);
    }
  }
}

/**
 * Create a logger with default configuration
 */
export function createLogger(config?: Partial<LoggerConfig>): Logger {
  return new Logger({ level: 'info', ...config });
}

// ============================================================================
// Validation Utilities
// ============================================================================

/**
 * Validate that a value is not null or undefined
 */
export function assertDefined<T>(
  value: T | null | undefined,
  message: string
): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}

/**
 * Validate that a string is not empty
 */
export function assertNonEmpty(
  value: string | null | undefined,
  message: string
): string {
  if (!value || value.trim() === '') {
    throw new Error(message);
  }
  return value;
}

/**
 * Validate that an array is not empty
 */
export function assertNonEmptyArray<T>(
  value: T[] | null | undefined,
  message: string
): T[] {
  if (!value || value.length === 0) {
    throw new Error(message);
  }
  return value;
}

// ============================================================================
// Exports
// ============================================================================

