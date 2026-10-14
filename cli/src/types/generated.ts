/**
 * Generated Types
 * 
 * This file contains types automatically derived from definitions.ts.
 * Do not edit directly - these types are generated from the entity definitions.
 * 
 * To regenerate, run: npm run generate:types
 */

import type { 
  EntityName, 
  EntityOperation, 
  EntityConfig,
  EntityField,
  CommandOption,
  CustomCommandConfig,
  CustomCommandGroup,
} from './definitions';
import { ENTITIES, CUSTOM_COMMAND_GROUPS } from './definitions';

// ============================================================================
// ENTITY TYPES
// ============================================================================

/** Map entity name to its config */
export type EntityConfigMap = typeof ENTITIES;

/** Get entity config by name */
export type GetEntityConfig<T extends EntityName> = EntityConfigMap[T];

/** Entity plural names */
export type EntityPlural<T extends EntityName> = GetEntityConfig<T>['plural'];

/** Entity singular names */
export type EntitySingular<T extends EntityName> = GetEntityConfig<T>['singular'];

/** CLI names for entities */
export type EntityCliName<T extends EntityName> = GetEntityConfig<T>['cliName'];

// ============================================================================
// FIELD TYPES
// ============================================================================

/** Extract field names from an entity */
export type EntityFieldNames<T extends EntityName, FieldType extends 'create' | 'update'> = 
  GetEntityConfig<T>[`${FieldType}Fields`][number]['name'];

/** Create request type for an entity */
export type CreateRequest<T extends EntityName> = {
  [K in EntityFieldNames<T, 'create'>]?: string | number | boolean;
};

/** Update request type for an entity */
export type UpdateRequest<T extends EntityName> = {
  [K in EntityFieldNames<T, 'update'>]?: string | number | boolean;
};

/** Field type mapping */
export type FieldTypeMap = {
  string: string;
  number: number;
  boolean: boolean;
  enum: string;
  date: string;
  id: string;
  array: unknown[];
};

/** Get field type for an entity - simplified for now */
export type FieldTypeForEntity<T extends EntityName, FieldName extends string> = string | number | boolean;

// ============================================================================
// API RESPONSE TYPES
// ============================================================================

/** Base API response wrapper */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: number;
}

/** Paginated response wrapper */
export interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  timestamp: number;
}

/** Single entity response */
export type SingleEntityResponse<T extends EntityName> = ApiResponse<T>;

/** List entity response */
export type ListEntityResponse<T extends EntityName> = PaginatedResponse<T>;

// ============================================================================
// OPERATION TYPES
// ============================================================================

/** Check if an entity has a specific operation */
export type HasOperation<T extends EntityName, Op extends EntityOperation> = 
  Op extends GetEntityConfig<T>['operations'][number] ? true : false;

/** Get operations for an entity */
export type EntityOperations<T extends EntityName> = GetEntityConfig<T>['operations'][number];

/** Filter entities by operation */
export type EntitiesWithOperation<Op extends EntityOperation> = {
  [K in EntityName]: HasOperation<K, Op> extends true ? K : never;
}[EntityName];

// ============================================================================
// COMMAND TYPES
// ============================================================================

/** CLI command categories */
export type CommandCategoryName = CustomCommandGroup['name'];

/** All custom command names */
export type CustomCommandName = typeof CUSTOM_COMMAND_GROUPS[number]['commands'][number]['name'];

/** Get custom commands by category */
export type CustomCommandsInCategory<Cat extends CommandCategoryName> = Extract<
  typeof CUSTOM_COMMAND_GROUPS[number]['commands'][number],
  { category: Cat }
>['name'];

/** CRUD command names for an entity */
export type CrudCommandName = 'list' | 'get' | 'create' | 'update' | 'delete';

/** All command names for an entity */
export type EntityCommandName<T extends EntityName> = 
  | CrudCommandName
  | keyof GetEntityConfig<T>['customCommands'];

// ============================================================================
// REQUEST/RESPONSE TYPES FOR EACH ENTITY
// ============================================================================

// Define response types for each entity
export interface OrganizationResponse {
  id: string;
  name: string;
  type: 'github' | 'gitlab' | 'artifacts';
  externalId?: string;
  createdAt: number;
}

export interface ActorResponse {
  id: string;
  type: 'human' | 'agent';
  name: string;
  githubUserId?: string;
  trustScore: number;
  promotionAuthority: boolean;
  createdAt: number;
}

export interface RepositoryResponse {
  id: string;
  name: string;
  organizationId: string;
  repoType: 'baseline' | 'candidate';
  specId?: string;
  agentId?: string;
  remoteUrl: string;
  namespace: string;
  defaultBranch?: string;
  createdAt: number;
}

export interface SpecResponse {
  id: string;
  name: string;
  description?: string;
  organizationId: string;
  specTemplate?: string;
  stage: 'draft' | 'proposed' | 'open' | 'closed' | 'rejected' | 'done';
  createdAt: number;
}

export interface CandidateResponse {
  id: string;
  specId: string;
  repositoryId: string;
  actorId: string;
  stage: 'draft' | 'claiming' | 'building' | 'testing' | 'promoting' | 'failed' | 'done';
  createdAt: number;
}

export interface GateVerdictResponse {
  id: string;
  candidateId: string;
  gate: 'pre-merge' | 'shadow' | 'train' | 'canary' | 'full';
  status: 'pass' | 'fail' | 'pending';
  score: number;
  notes?: string;
  createdAt: number;
}

export interface TrialResponse {
  id: string;
  specId: string;
  candidateId: string;
  gate: 'pre-merge' | 'shadow' | 'train' | 'canary' | 'full';
  input?: string;
  status: string;
  result?: unknown;
  createdAt: number;
}

export interface PromotionResponse {
  id: string;
  candidateId: string;
  fromStage: string;
  toStage: string;
  status: string;
  createdAt: number;
}

export interface IssueResponse {
  id: string;
  title: string;
  description?: string;
  specId?: string;
  candidateId?: string;
  status: 'open' | 'in-progress' | 'resolved' | 'closed';
  priority: 'low' | 'medium' | 'high' | 'critical';
  createdAt: number;
}

export interface HistoryResponse {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  timestamp: number;
  data?: unknown;
}

export interface WorkflowResponse {
  id: string;
  specId: string;
  workflowType: 'gate' | 'build' | 'test' | 'deploy';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  input?: string;
  output?: unknown;
  createdAt: number;
}

export interface DeploymentResponse {
  id: string;
  candidateId: string;
  environment: string;
  version?: string;
  status: 'pending' | 'deploying' | 'active' | 'failed' | 'rolled-back';
  createdAt: number;
}

export interface EnvironmentResponse {
  id: string;
  name: string;
  type: 'dev' | 'staging' | 'production' | 'shadow';
  config?: string;
  status: string;
  createdAt: number;
}

// ============================================================================
// PHASE-SPECIFIC TYPES
// ============================================================================

// Phase 1 types (already defined above)

// Phase 2 types
export type Phase2Entities = 'workflow';

// Phase 3 types
export type Phase3Entities = 'deployment' | 'environment';

// All entities across all phases
export type AllEntityNames = EntityName | Phase2Entities | Phase3Entities;

// ============================================================================
// UTILITY TYPES
// ============================================================================

/** Make all properties optional except for specified keys */
export type PartialExcept<T, K extends keyof T> = Partial<Omit<T, K>> & Pick<T, K>;

/** Create a type with only the specified keys */
export type PickOnly<T, K extends keyof T> = Pick<T, K>;

/** Omit specified keys from a type */
export type OmitKeys<T, K extends keyof T> = Omit<T, K>;

/** Make all properties readonly */
export type ReadonlyDeep<T> = {
  readonly [K in keyof T]: ReadonlyDeep<T[K]>;
};

/** Nullable type */
export type Nullable<T> = T | null;

/** Optional type */
export type Optional<T> = T | undefined;

/** Value of an object */
export type ValueOf<T> = T[keyof T];

// ============================================================================
// CLI STATE EXTENSIONS
// ============================================================================

/** Extended CLI state with type-safe entity access */
export interface TypedCliState<T extends EntityName = EntityName> {
  entity: T;
  // Type-safe client methods
  client: {
    list: (limit: number, offset: number) => Promise<ListEntityResponse<T>>;
    get: (id: string) => Promise<SingleEntityResponse<T>>;
    create: (data: CreateRequest<T>) => Promise<SingleEntityResponse<T>>;
    update: (id: string, data: UpdateRequest<T>) => Promise<SingleEntityResponse<T>>;
    delete: (id: string) => Promise<ApiResponse<void>>;
  };
}
