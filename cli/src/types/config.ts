/**
 * CLI Configuration Types
 */

import { EntityType } from './api';

// ============================================================================
// CONFIGURATION
// ============================================================================

export interface BeehiveConfig {
  apiUrl?: string;
  apiToken?: string;
  defaultOrganization?: string;
  defaultActor?: string;
  outputFormat?: 'json' | 'table' | 'yaml';
  verbose?: boolean;
  timeout?: number;
}

export interface ConfigStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  all: Record<string, unknown>;
}

// Default configuration
const DEFAULT_CONFIG_PATH = process.env.BEEHIVE_CONFIG || 
  (process.platform === 'win32' 
    ? process.env.LOCALAPPDATA + '\\beehive\\config.json'
    : process.env.HOME + '/.beehive/config.json');

export interface ConfigOptions {
  configPath?: string;
  apiUrl?: string;
  apiToken?: string;
}

export { DEFAULT_CONFIG_PATH };

// ============================================================================
// COMMAND OPTIONS
// ============================================================================

export interface GlobalOptions {
  config?: string;
  token?: string;
  url?: string;
  json?: boolean;
  pretty?: boolean;
  verbose?: boolean;
  help?: boolean;
  version?: boolean;
}

export interface ListOptions {
  limit?: number;
  offset?: number;
  specId?: string;
  agentId?: string;
  organizationId?: string;
  stage?: string;
  type?: string;
  status?: string;
}

export interface GetOptions {
  id: string;
}

export interface CreateOptions {
  name: string;
  type?: string;
  description?: string;
  organizationId?: string;
  externalId?: string;
  // For specs
  contract?: string | object;
  declaredDeltaSurface?: string[];
  // For repos
  remoteUrl?: string;
  namespace?: string;
  repoType?: 'baseline' | 'candidate';
  defaultBranch?: string;
  // For candidates
  specId?: string;
  repositoryId?: string;
  commitSha?: string;
  baseCommitSha?: string;
  agentId?: string;
}

export interface UpdateOptions {
  id: string;
  stage?: string;
  notes?: string;
  trustScore?: number;
}

// ============================================================================
// DEBUG COMMAND OPTIONS
// ============================================================================

export interface DebugStateDumpOptions {
  output?: string;
  entities?: EntityType[];
  all?: boolean;
}

export interface DebugTailOptions {
  worker?: 'api' | 'gate' | 'sandbox' | 'queue' | 'all';
  lines?: number;
  follow?: boolean;
  filter?: string;
}

export interface DebugVerifyQueuesOptions {
  createTestMessage?: boolean;
  queueName?: string;
}

export interface DebugVerifyArtifactsOptions {
  listRepos?: boolean;
  createTestFork?: boolean;
  forkFrom?: string;
}

export interface DebugTestClaimOptions {
  specId: string;
  actorId?: string;
  dryRun?: boolean;
}

export interface DebugVerifyTrainOptions {
  specId: string;
  verbose?: boolean;
}

export interface DebugDumpOptions {
  entityType: EntityType;
  limit?: number;
  output?: string;
}

export interface DebugCompareOptions {
  candidateAId: string;
  candidateBId: string;
  deep?: boolean;
}

// ============================================================================
// CLI STATE
// ============================================================================

export interface CliState {
  config: BeehiveConfig;
  apiClient?: unknown; // Will be typed to BeehiveClient once defined
  verbose: boolean;
  outputFormat: 'json' | 'table' | 'yaml';
}
