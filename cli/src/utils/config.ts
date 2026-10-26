/**
 * Configuration Management
 * Loads and manages CLI configuration from multiple sources
 */

import { existsSync, readFileSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import Configstore from 'configstore';
import { BeehiveConfig, ConfigOptions, DEFAULT_CONFIG_PATH } from '../types/config';

// Environment variable names
const ENV_API_TOKEN = 'BEEHIVE_API_TOKEN';
const ENV_API_URL = 'BEEHIVE_API_URL';
const ENV_VERBOSE = 'BEEHIVE_VERBOSE';
const ENV_ACTOR = 'BEEHIVE_ACTOR';

// Default configuration
export const DEFAULT_CONFIG: BeehiveConfig = {
  apiUrl: 'https://beehive.bz23711.workers.dev',
  apiToken: undefined,
  defaultOrganization: undefined,
  defaultActor: undefined,
  outputFormat: 'json',
  verbose: false,
  timeout: 30000, // 30 seconds
};

/**
 * Load configuration from multiple sources with priority:
 * 1. Explicit options from command line
 * 2. Environment variables
 * 3. Config file
 * 4. Defaults
 */
export function loadConfig(options?: ConfigOptions): BeehiveConfig {
  // Start with defaults
  const config: BeehiveConfig = { ...DEFAULT_CONFIG };

  // Load from config file
  const configPath = options?.configPath || DEFAULT_CONFIG_PATH;
  const fileConfig = loadConfigFile(configPath);
  if (fileConfig) {
    Object.assign(config, fileConfig);
  }

  // Override with environment variables
  if (process.env[ENV_API_TOKEN]) {
    config.apiToken = process.env[ENV_API_TOKEN];
  }
  if (process.env[ENV_API_URL]) {
    config.apiUrl = process.env[ENV_API_URL];
  }
  const envActor = process.env[ENV_ACTOR]?.trim();
  if (envActor) {
    config.defaultActor = envActor;
  }
  if (process.env[ENV_VERBOSE] === 'true') {
    config.verbose = true;
  }

  // A blank actor must never become a blank header
  config.defaultActor = typeof config.defaultActor === 'string' ? config.defaultActor.trim() || undefined : undefined;

  // Override with explicit options
  if (options?.apiUrl) {
    config.apiUrl = options.apiUrl;
  }
  if (options?.apiToken) {
    config.apiToken = options.apiToken;
  }

  // Ensure URL ends with /api for consistency
  if (config.apiUrl && !config.apiUrl.endsWith('/api')) {
    // Don't add /api if it already has a path
    if (!config.apiUrl.includes('/api') && !config.apiUrl.endsWith('/')) {
      config.apiUrl += '/api';
    }
  }

  return config;
}

/**
 * Load configuration from a file
 */
function loadConfigFile(configPath: string): Partial<BeehiveConfig> | null {
  try {
    if (!existsSync(configPath)) {
      return null;
    }
    const content = readFileSync(configPath, 'utf-8');
    return JSON.parse(content) as Partial<BeehiveConfig>;
  } catch (error) {
    // Never echo the parser message: a JSON SyntaxError quotes a snippet of the file (which may hold a token).
    const reason = error instanceof SyntaxError ? 'invalid JSON' : (error as NodeJS.ErrnoException).code || 'unreadable';
    console.error(`Warning: Could not load config from ${configPath}: ${reason}`);
    return null;
  }
}

/**
 * Mirror of USER_TOKEN_PREFIX / SERVICE_TOKEN_PREFIX in workers/shared/service-tokens.ts
 * (the CLI is a separate package with no shared build; tests/cli-token.test.ts pins them).
 */
export const USER_TOKEN_PREFIX = 'bh_usr_';
export const SERVICE_TOKEN_PREFIX = 'bh_svc_';

export type TokenKind = 'user' | 'service' | 'master-or-other';

/**
 * Leading characters that are safe to show: 12 for user and service tokens (the length of their public listing prefix), 8 for
 * anything else (a master token has no public prefix), and never more than half of a short token.
 */
export function tokenPrefix(token: string): string {
  const shown = tokenKind(token) === 'master-or-other' ? 8 : 12;
  return token.slice(0, Math.min(shown, Math.floor(token.length / 2)));
}

/** Classify a token by prefix only; the edge decides whether it is valid. */
export function tokenKind(token: string | undefined): TokenKind {
  if (token?.startsWith(USER_TOKEN_PREFIX)) return 'user';
  if (token?.startsWith(SERVICE_TOKEN_PREFIX)) return 'service';
  return 'master-or-other';
}

/**
 * Save configuration to a file.
 * The directory is created 0700 and the file is written 0600 from creation (temp file in
 * the same directory, then rename), so it is never visible with wider permissions, also
 * when it replaces an older 0644 file. Errors never echo the file contents.
 */
export function saveConfig(config: BeehiveConfig, configPath?: string): void {
  const requested = configPath || DEFAULT_CONFIG_PATH;
  // A config path that is a symlink (dotfiles or secrets store): replace the file it points to, not the link itself
  let path = requested;
  try {
    path = realpathSync(requested);
  } catch {
    /* does not exist yet: write at the requested path */
  }
  const dir = dirname(path);
  const tmp = join(dir, `.config.json.${process.pid}.tmp`);

  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    // Don't save undefined values
    const cleanConfig: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) {
      if (value !== undefined) {
        cleanConfig[key] = value;
      }
    }

    try {
      unlinkSync(tmp); // a leftover from a crashed run with the same pid
    } catch {
      /* none */
    }
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, JSON.stringify(cleanConfig, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    const reason = error instanceof Error ? (error as NodeJS.ErrnoException).code || error.message : 'unknown error';
    throw new Error(`Failed to save config to ${path}: ${reason}`);
  }
}

/**
 * Change keys in the config FILE only. Reads the raw file (no env/flag merge, so values
 * from BEEHIVE_* or --url never get persisted), keeps unknown keys, and applies `patch`
 * (an `undefined` value deletes the key).
 */
export function updateConfigFile(configPath: string | undefined, patch: Partial<BeehiveConfig>): void {
  const path = configPath || DEFAULT_CONFIG_PATH;
  const raw: Record<string, unknown> = { ...(readRawConfigFile(path) ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete raw[key];
    else raw[key] = value;
  }
  saveConfig(raw as BeehiveConfig, path);
}

function readRawConfigFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    const reason = error instanceof SyntaxError ? 'invalid JSON' : (error as NodeJS.ErrnoException).code || 'unreadable';
    throw new Error(`Config file ${path} could not be read (${reason}); refusing to overwrite it`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Config file ${path} is not a JSON object; refusing to overwrite it`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Get the configuration file path
 */
export function getConfigPath(): string {
  return DEFAULT_CONFIG_PATH;
}

/**
 * Initialize configuration with an API token
 */
export function initConfig(apiToken?: string): BeehiveConfig {
  const config = loadConfig();
  
  if (apiToken) {
    config.apiToken = apiToken;
    updateConfigFile(undefined, { apiToken });
  }
  
  return config;
}

/**
 * Create a Configstore instance for the CLI
 * This is used for non-sensitive configuration
 */
export function createConfigStore() {
  return new Configstore('beehive-cli', DEFAULT_CONFIG as Record<string, unknown>);
}

/**
 * Get the default configuration directory
 */
export function getConfigDir(): string {
  return process.env.BEEHIVE_CONFIG_DIR || 
    (process.platform === 'win32' 
      ? process.env.LOCALAPPDATA + '\\beehive'
      : `${homedir()}/.beehive`);
}
