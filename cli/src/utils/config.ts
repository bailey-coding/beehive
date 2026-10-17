/**
 * Configuration Management
 * Loads and manages CLI configuration from multiple sources
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
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
  if (process.env[ENV_ACTOR]) {
    config.defaultActor = process.env[ENV_ACTOR];
  }
  if (process.env[ENV_VERBOSE] === 'true') {
    config.verbose = true;
  }

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
    console.error(`Warning: Could not load config from ${configPath}: ${error}`);
    return null;
  }
}

/**
 * Save configuration to a file
 */
export function saveConfig(config: BeehiveConfig, configPath?: string): void {
  const path = configPath || DEFAULT_CONFIG_PATH;
  
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    
    // Don't save undefined values
    const cleanConfig: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) {
      if (value !== undefined) {
        cleanConfig[key] = value;
      }
    }
    
    writeFileSync(path, JSON.stringify(cleanConfig, null, 2), 'utf-8');
  } catch (error) {
    throw new Error(`Failed to save config to ${path}: ${error}`);
  }
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
    saveConfig(config);
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
