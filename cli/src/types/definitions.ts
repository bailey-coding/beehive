/**
 * Central Entity Definitions
 * 
 * This is the single source of truth for all entity types, operations, and CLI mappings.
 * Adding a new entity here automatically generates:
 * - TypeScript types
 * - API client methods
 * - CRUD CLI commands
 * 
 * For phase 2 and phase 3, simply add new entities to this file.
 */

// No import needed - OutputFormat is not used here

// ============================================================================
// OPERATION TYPES
// ============================================================================

/** Basic CRUD operations */
export type CrudOperation = 'list' | 'get' | 'create' | 'update' | 'delete';

/** Extended operations for Beehive entities */
export type ExtendedOperation = 
  | 'claim' 
  | 'promote' 
  | 'demote' 
  | 'trigger' 
  | 'cancel'
  | 'decide'
  | 'link'
  | 'unlink'
  | 'rollback';

/** All possible operations */
export type EntityOperation = CrudOperation | ExtendedOperation;

// ============================================================================
// COMMAND CATEGORIES
// ============================================================================

/** Command category types */
export type CommandCategory = 
  | 'crud'      // Standard CRUD operations
  | 'debug'     // Debugging utilities
  | 'health'    // Health checks
  | 'auth'      // Authentication
  | 'history'   // History and audit
  | 'custom';   // Custom commands that don't fit other categories

// ============================================================================
// ENTITY FIELD TYPES
// ============================================================================

/** Field type definitions for entity properties */
export type FieldType = 'string' | 'number' | 'boolean' | 'enum' | 'date' | 'id' | 'array';

/** Field definition for entity properties */
export interface EntityField {
  name: string;
  type: FieldType;
  required: boolean;
  description: string;
  enumValues?: string[]; // For enum types
  default?: unknown;     // Default value
}

/** Operation-specific configuration */
export interface OperationConfig {
  /** Whether this operation requires an ID argument */
  requiresId?: boolean;
  /** Whether this operation requires additional data */
  requiresData?: boolean;
  /** Custom action function name (if not auto-generated) */
  customAction?: string;
  /** Additional options for this operation */
  options?: CommandOption[];
}

// ============================================================================
// COMMAND OPTIONS
// ============================================================================

/** CLI command option definition */
export interface CommandOption {
  name: string;
  short?: string;
  type: 'string' | 'number' | 'boolean' | 'enum';
  description: string;
  default?: unknown;
  required?: boolean;
  env?: string; // Environment variable name
}

// ============================================================================
// ENTITY CONFIGURATION
// ============================================================================

/** Complete entity configuration */
export interface EntityConfig {
  /** Singular name of the entity (e.g., 'organization') */
  singular: string;
  /** Plural name of the entity (e.g., 'organizations') */
  plural: string;
  
  /** CLI command name (e.g., 'org') */
  cliName: string;
  /** CLI description */
  description: string;
  
  /** Enabled operations for this entity */
  operations: EntityOperation[];
  
  /** Operation-specific overrides - partial record to avoid requiring all operations */
  operationConfig?: Partial<Record<EntityOperation, OperationConfig>>;
  
  /** Fields that can be used for creation */
  createFields: EntityField[];
  
  /** Fields that can be used for updates */
  updateFields: EntityField[];
  
  /** Fields to display in list output (default: id, name) */
  listDisplayFields?: string[];
  
  /** Fields to display in detail output */
  detailDisplayFields?: string[];
  
  /** Custom commands specific to this entity */
  customCommands?: Record<string, {
    description: string;
    action: string;
    options?: CommandOption[];
    arguments?: { name: string; required: boolean; description: string }[];
  }>;
}

// ============================================================================
// CUSTOM COMMAND DEFINITION
// ============================================================================

/** Custom command definition (non-CRUD) */
export interface CustomCommandConfig {
  /** Command name (e.g., 'validate-config') */
  name: string;
  
  /** Category for grouping */
  category: CommandCategory;
  
  /** Short alias if applicable */
  alias?: string;
  
  /** Description */
  description: string;
  
  /** Action function name */
  action: string;
  
  /** Command options */
  options?: CommandOption[];
  
  /** Positional arguments */
  arguments?: { name: string; required: boolean; description: string }[];
  
  /** Whether this command is hidden from help */
  hidden?: boolean;
  
  /** Entity this custom command operates on (for filtering) */
  entity?: string;
}

// ============================================================================
// CUSTOM COMMAND GROUPS
// ============================================================================

/** Definition for a group of custom commands */
export interface CustomCommandGroup {
  /** Group name (e.g., 'debug') */
  name: string;
  
  /** Description */
  description: string;
  
  /** Commands in this group */
  commands: CustomCommandConfig[];
}

// ============================================================================
// ENTITY DEFINITIONS
// ============================================================================

/** All entity definitions - ADD NEW ENTITIES HERE FOR NEW PHASES */
export const ENTITIES: Record<string, EntityConfig> = {
  // Phase 1: Core Entities
  organization: {
    singular: 'organization',
    plural: 'organizations',
    cliName: 'org',
    description: 'Organization management',
    operations: ['list', 'get', 'create'],
    createFields: [
      { name: 'name', type: 'string', required: true, description: 'Organization name' },
      { name: 'type', type: 'enum', required: true, description: 'Organization type', enumValues: ['github', 'gitlab', 'artifacts'] },
      { name: 'externalId', type: 'string', required: false, description: 'External organization ID' },
    ],
    updateFields: [
      { name: 'name', type: 'string', required: false, description: 'Organization name' },
    ],
    listDisplayFields: ['id', 'name', 'type', 'createdAt'],
  },

  actor: {
    singular: 'actor',
    plural: 'actors',
    cliName: 'actor',
    description: 'Actor management',
    operations: ['list', 'get', 'create', 'update'],
    operationConfig: {
      update: {
        options: [
          { name: 'trust-score', type: 'number', description: 'Update trust score' },
        ],
      },
    },
    createFields: [
      { name: 'type', type: 'enum', required: true, description: 'Actor type', enumValues: ['human', 'agent'] },
      { name: 'name', type: 'string', required: true, description: 'Actor name' },
      { name: 'githubUserId', type: 'string', required: false, description: 'GitHub user ID' },
    ],
    updateFields: [
      { name: 'name', type: 'string', required: false, description: 'Actor name' },
      { name: 'trustScore', type: 'number', required: false, description: 'Trust score (0-100)' },
      { name: 'promotionAuthority', type: 'boolean', required: false, description: 'Has promotion authority' },
    ],
    listDisplayFields: ['id', 'name', 'type', 'trustScore', 'createdAt'],
  },

  repository: {
    singular: 'repository',
    plural: 'repositories',
    cliName: 'repo',
    description: 'Repository management',
    operations: ['list', 'get', 'create'],
    createFields: [
      { name: 'name', type: 'string', required: true, description: 'Repository name' },
      { name: 'organizationId', type: 'id', required: true, description: 'Organization ID' },
      { name: 'repoType', type: 'enum', required: true, description: 'Repository type', enumValues: ['baseline', 'candidate'] },
      { name: 'remoteUrl', type: 'string', required: true, description: 'Remote repository URL' },
      { name: 'namespace', type: 'string', required: true, description: 'Repository namespace' },
      { name: 'defaultBranch', type: 'string', required: false, description: 'Default branch' },
    ],
    updateFields: [],
    listDisplayFields: ['id', 'name', 'organizationId', 'repoType', 'remoteUrl'],
  },

  spec: {
    singular: 'spec',
    plural: 'specs',
    cliName: 'spec',
    description: 'Spec management',
    operations: ['list', 'get', 'create', 'update'],
    operationConfig: {
      update: {
        options: [
          { name: 'stage', type: 'string', description: 'Update spec stage' },
        ],
      },
    },
    createFields: [
      { name: 'name', type: 'string', required: true, description: 'Spec name' },
      { name: 'description', type: 'string', required: false, description: 'Spec description' },
      { name: 'organizationId', type: 'id', required: true, description: 'Organization ID' },
      { name: 'specTemplate', type: 'string', required: false, description: 'Spec template' },
    ],
    updateFields: [
      { name: 'description', type: 'string', required: false, description: 'Spec description' },
      { name: 'stage', type: 'enum', required: false, description: 'Spec stage', enumValues: ['draft', 'proposed', 'open', 'closed', 'rejected', 'done'] },
    ],
    listDisplayFields: ['id', 'name', 'organizationId', 'stage', 'createdAt'],
    customCommands: {
      claim: {
        description: 'Claim a spec for implementation',
        action: 'actionClaimSpec',
        arguments: [
          { name: 'specId', required: true, description: 'Spec ID to claim' },
        ],
        options: [
          { name: 'actor', short: 'a', type: 'string', description: 'Actor ID' },
          { name: 'dry-run', short: 'n', type: 'boolean', description: 'Dry run mode' },
        ],
      },
    },
  },

  candidate: {
    singular: 'candidate',
    plural: 'candidates',
    cliName: 'candidate',
    description: 'Candidate management',
    operations: ['list', 'get', 'update'],
    operationConfig: {
      update: {
        options: [
          { name: 'stage', type: 'string', description: 'Update candidate stage' },
        ],
      },
    },
    createFields: [], // Candidates are created via spec claim
    updateFields: [
      { name: 'stage', type: 'enum', required: false, description: 'Candidate stage', enumValues: ['draft', 'claiming', 'building', 'testing', 'promoting', 'failed', 'done'] },
    ],
    listDisplayFields: ['id', 'specId', 'repositoryId', 'actorId', 'stage', 'createdAt'],
  },

  gateVerdict: {
    singular: 'gate-verdict',
    plural: 'gate-verdicts',
    cliName: 'gate',
    description: 'Gate workflow operations',
    operations: ['list', 'get', 'create'],
    createFields: [
      { name: 'candidateId', type: 'id', required: true, description: 'Candidate ID' },
      { name: 'gate', type: 'enum', required: true, description: 'Gate name', enumValues: ['pre-merge', 'shadow', 'train', 'canary', 'full'] },
      { name: 'status', type: 'enum', required: true, description: 'Verdict status', enumValues: ['pass', 'fail', 'pending'] },
      { name: 'score', type: 'number', required: false, description: 'Verdict score' },
      { name: 'notes', type: 'string', required: false, description: 'Verdict notes' },
    ],
    updateFields: [
      { name: 'status', type: 'enum', required: false, description: 'Verdict status', enumValues: ['pass', 'fail', 'pending'] },
      { name: 'score', type: 'number', required: false, description: 'Verdict score' },
    ],
    listDisplayFields: ['id', 'candidateId', 'gate', 'status', 'score', 'createdAt'],
  },

  trial: {
    singular: 'trial',
    plural: 'trials',
    cliName: 'trial',
    description: 'Trial operations',
    operations: ['list', 'get', 'create'],
    createFields: [
      { name: 'specId', type: 'id', required: true, description: 'Spec ID' },
      { name: 'candidateId', type: 'id', required: true, description: 'Candidate ID' },
      { name: 'gate', type: 'enum', required: true, description: 'Gate name', enumValues: ['pre-merge', 'shadow', 'train', 'canary', 'full'] },
      { name: 'input', type: 'string', required: false, description: 'Trial input' },
    ],
    updateFields: [],
    listDisplayFields: ['id', 'specId', 'candidateId', 'gate', 'status', 'createdAt'],
    customCommands: {
      decide: {
        description: 'Record trial decision',
        action: 'actionDecideTrial',
        arguments: [
          { name: 'trialId', required: true, description: 'Trial ID' },
        ],
        options: [
          { name: 'verdict', type: 'string', required: true, description: 'Decision verdict (pass|fail)' },
          { name: 'score', type: 'number', required: false, description: 'Decision score' },
          { name: 'notes', type: 'string', required: false, description: 'Decision notes' },
        ],
      },
    },
  },

  promotion: {
    singular: 'promotion',
    plural: 'promotions',
    cliName: 'promotion',
    description: 'Promotion operations',
    operations: ['list', 'get'],
    createFields: [],
    updateFields: [],
    listDisplayFields: ['id', 'candidateId', 'fromStage', 'toStage', 'status', 'createdAt'],
  },

  issue: {
    singular: 'issue',
    plural: 'issues',
    cliName: 'issue',
    description: 'Issue management',
    operations: ['list', 'get', 'create'],
    createFields: [
      { name: 'title', type: 'string', required: true, description: 'Issue title' },
      { name: 'description', type: 'string', required: false, description: 'Issue description' },
      { name: 'specId', type: 'id', required: false, description: 'Related spec ID' },
      { name: 'candidateId', type: 'id', required: false, description: 'Related candidate ID' },
      { name: 'priority', type: 'enum', required: false, description: 'Issue priority', enumValues: ['low', 'medium', 'high', 'critical'] },
    ],
    updateFields: [
      { name: 'title', type: 'string', required: false, description: 'Issue title' },
      { name: 'description', type: 'string', required: false, description: 'Issue description' },
      { name: 'status', type: 'enum', required: false, description: 'Issue status', enumValues: ['open', 'in-progress', 'resolved', 'closed'] },
    ],
    listDisplayFields: ['id', 'title', 'status', 'priority', 'createdAt'],
  },

  history: {
    singular: 'history',
    plural: 'history',
    cliName: 'history',
    description: 'Entity history',
    operations: ['list', 'get'],
    createFields: [],
    updateFields: [],
    listDisplayFields: ['id', 'entityType', 'entityId', 'action', 'timestamp'],
    customCommands: {
      'for-entity': {
        description: 'Get history for a specific entity',
        action: 'actionGetEntityHistory',
        arguments: [
          { name: 'entityType', required: true, description: 'Entity type' },
          { name: 'entityId', required: true, description: 'Entity ID' },
        ],
        options: [
          { name: 'limit', short: 'l', type: 'number', description: 'Limit number of entries' },
        ],
      },
    },
  },

  // ==========================================================================
  // PHASE 2: Add new entities here when starting phase 2
  // ==========================================================================
  
  workflow: {
    singular: 'workflow',
    plural: 'workflows',
    cliName: 'workflow',
    description: 'Workflow management',
    operations: ['list', 'get', 'trigger', 'cancel'],
    createFields: [
      { name: 'specId', type: 'id', required: true, description: 'Spec ID' },
      { name: 'workflowType', type: 'enum', required: true, description: 'Workflow type', enumValues: ['gate', 'build', 'test', 'deploy'] },
    ],
    updateFields: [
      { name: 'status', type: 'enum', required: false, description: 'Workflow status', enumValues: ['pending', 'running', 'completed', 'failed', 'cancelled'] },
    ],
    listDisplayFields: ['id', 'specId', 'workflowType', 'status', 'createdAt'],
    operationConfig: {
      trigger: {
        requiresId: true,
        options: [
          { name: 'input', type: 'string', description: 'Workflow input' },
        ],
      },
      cancel: {
        requiresId: true,
      },
    },
  },

  // ==========================================================================
  // PHASE 3: Add new entities here when starting phase 3
  // ==========================================================================
  
  deployment: {
    singular: 'deployment',
    plural: 'deployments',
    cliName: 'deploy',
    description: 'Deployment management',
    operations: ['list', 'get', 'create', 'rollback'],
    createFields: [
      { name: 'candidateId', type: 'id', required: true, description: 'Candidate ID' },
      { name: 'environment', type: 'string', required: true, description: 'Deployment environment' },
      { name: 'version', type: 'string', required: false, description: 'Version tag' },
    ],
    updateFields: [
      { name: 'status', type: 'enum', required: false, description: 'Deployment status', enumValues: ['pending', 'deploying', 'active', 'failed', 'rolled-back'] },
    ],
    listDisplayFields: ['id', 'candidateId', 'environment', 'status', 'createdAt'],
    operationConfig: {
      rollback: {
        requiresId: true,
        options: [
          { name: 'to-version', type: 'string', description: 'Rollback to version' },
        ],
      },
    },
  },

  environment: {
    singular: 'environment',
    plural: 'environments',
    cliName: 'env',
    description: 'Environment management',
    operations: ['list', 'get', 'create', 'update', 'delete'],
    createFields: [
      { name: 'name', type: 'string', required: true, description: 'Environment name' },
      { name: 'type', type: 'enum', required: true, description: 'Environment type', enumValues: ['dev', 'staging', 'production', 'shadow'] },
      { name: 'config', type: 'string', required: false, description: 'Environment configuration' },
    ],
    updateFields: [
      { name: 'name', type: 'string', required: false, description: 'Environment name' },
      { name: 'config', type: 'string', required: false, description: 'Environment configuration' },
    ],
    listDisplayFields: ['id', 'name', 'type', 'status', 'createdAt'],
  },
} as const;

// ============================================================================
// CUSTOM COMMAND GROUPS
// ============================================================================

/** Custom command groups that don't fit the CRUD pattern */
export const CUSTOM_COMMAND_GROUPS: CustomCommandGroup[] = [
  {
    name: 'auth',
    description: 'Authentication management',
    commands: [
      {
        name: 'login',
        category: 'auth',
        description: 'Authenticate with the API',
        action: 'actionLogin',
        options: [
          { name: 'token', type: 'string', description: 'API token' },
        ],
      },
      {
        name: 'logout',
        category: 'auth',
        description: 'Clear authentication',
        action: 'actionLogout',
      },
      {
        name: 'status',
        category: 'auth',
        description: 'Show authentication status',
        action: 'actionAuthStatus',
      },
    ],
  },
  {
    name: 'debug',
    description: 'Debugging utilities for e2e testing',
    commands: [
      {
        name: 'check-api',
        category: 'debug',
        description: 'Check API connectivity',
        action: 'actionCheckApi',
      },
      {
        name: 'list-specs',
        category: 'debug',
        description: 'List all specs with their stages',
        action: 'actionListSpecsStages',
        options: [
          { name: 'all', short: 'a', type: 'boolean', description: 'Show all details' },
          { name: 'limit', short: 'l', type: 'number', description: 'Limit number of specs' },
        ],
      },
      {
        name: 'gate-status',
        category: 'debug',
        description: 'Check gate workflow status',
        action: 'actionGateWorkflowStatus',
        options: [
          { name: 'spec', short: 's', type: 'string', description: 'Filter by spec ID' },
          { name: 'candidate', short: 'c', type: 'string', description: 'Filter by candidate ID' },
        ],
      },
      {
        name: 'validate-config',
        category: 'debug',
        description: 'Validate CLI configuration',
        action: 'actionValidateConfig',
      },
      {
        name: 'state-dump',
        category: 'debug',
        description: 'Dump full Spec DO state',
        action: 'actionStateDump',
        options: [
          { name: 'output', short: 'o', type: 'string', description: 'Output file path' },
          { name: 'entities', short: 'e', type: 'string', description: 'Comma-separated list of entity types' },
          { name: 'all', short: 'a', type: 'boolean', description: 'Include all entity types' },
        ],
      },
      {
        name: 'verify-queues',
        category: 'debug',
        description: 'Verify queue configuration',
        action: 'actionVerifyQueues',
        options: [
          { name: 'create-test-message', type: 'boolean', description: 'Create a test message' },
          { name: 'queue-name', short: 'q', type: 'string', description: 'Specific queue name' },
        ],
      },
      {
        name: 'verify-artifacts',
        category: 'debug',
        description: 'Verify Artifacts integration',
        action: 'actionVerifyArtifacts',
        options: [
          { name: 'list-repos', short: 'l', type: 'boolean', description: 'List all repositories' },
          { name: 'create-test-fork', type: 'boolean', description: 'Create a test fork' },
          { name: 'fork-from', type: 'string', description: 'Repository to fork from' },
        ],
      },
      {
        name: 'test-claim',
        category: 'debug',
        description: 'Test the claim workflow',
        action: 'actionTestClaim',
        arguments: [
          { name: 'spec-id', required: true, description: 'Spec ID to claim' },
        ],
        options: [
          { name: 'actor', short: 'a', type: 'string', description: 'Actor ID' },
          { name: 'dry-run', short: 'n', type: 'boolean', description: 'Dry run mode' },
        ],
      },
      {
        name: 'verify-train',
        category: 'debug',
        description: 'Verify promotion train integrity',
        action: 'actionVerifyTrain',
        arguments: [
          { name: 'spec-id', required: true, description: 'Spec ID to verify' },
        ],
      },
      {
        name: 'dump',
        category: 'debug',
        description: 'Dump entities of a specific type',
        action: 'actionDump',
        arguments: [
          { name: 'entity-type', required: true, description: 'Entity type' },
        ],
        options: [
          { name: 'limit', short: 'l', type: 'number', description: 'Limit' },
          { name: 'output', short: 'o', type: 'string', description: 'Output file' },
        ],
      },
      {
        name: 'compare',
        category: 'debug',
        description: 'Compare two candidates',
        action: 'actionCompare',
        arguments: [
          { name: 'candidate-a-id', required: true, description: 'First candidate ID' },
          { name: 'candidate-b-id', required: true, description: 'Second candidate ID' },
        ],
        options: [
          { name: 'deep', short: 'd', type: 'boolean', description: 'Deep comparison' },
        ],
      },
      {
        name: 'tail',
        category: 'debug',
        description: 'Tail worker logs',
        action: 'actionTail',
        options: [
          { name: 'worker', short: 'w', type: 'string', description: 'Worker to tail' },
          { name: 'lines', short: 'n', type: 'number', description: 'Number of lines' },
          { name: 'follow', short: 'f', type: 'boolean', description: 'Follow the log output' },
          { name: 'filter', type: 'string', description: 'Filter pattern' },
        ],
      },
    ],
  },
  {
    name: 'health',
    description: 'Health check and diagnostics',
    commands: [
      {
        name: 'check',
        category: 'health',
        description: 'Check system health',
        action: 'actionHealth',
        options: [
          { name: 'extended', short: 'e', type: 'boolean', description: 'Extended health check' },
        ],
      },
      {
        name: 'version',
        category: 'health',
        description: 'Show system version',
        action: 'actionVersion',
      },
      {
        name: 'workers',
        category: 'health',
        description: 'Check specific worker health',
        action: 'actionCheckWorker',
        options: [
          { name: 'workers', short: 'w', type: 'string', description: 'Comma-separated list of workers' },
        ],
      },
    ],
  },
];

// ============================================================================
// TYPE EXPORTS
// ============================================================================

/** All entity names */
export type EntityName = keyof typeof ENTITIES;

/** All operation names */
export type OperationName = EntityOperation;

/** Get entity config by name */
export type EntityConfigForName<T extends EntityName> = typeof ENTITIES[T];

/** All custom command group names */
export type CustomCommandGroupName = typeof CUSTOM_COMMAND_GROUPS[number]['name'];
