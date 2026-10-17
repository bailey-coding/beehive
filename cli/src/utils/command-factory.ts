/**
 * Command Factory
 * 
 * Generates consistent CRUD CLI commands from entity definitions.
 * This eliminates repetitive command registration code.
 */

import { Command, Option } from 'commander';
import chalk from 'chalk';
import { CliState, GlobalOptions, createActionHandler as createActionHandlerType } from '../index';
import { 
  ENTITIES, 
  EntityName, 
  EntityConfig,
  EntityOperation,
  CrudOperation,
  ExtendedOperation,
  EntityField,
} from '../types/definitions';
import { 
  printOutput, 
  formatSuccess, 
  formatError, 
  formatInfo,
  formatWarning,
  ProgressSpinner,
} from './output';

// ============================================================================
// COMMAND GENERATOR FUNCTIONS
// ============================================================================

/** Capitalize the first letter of a string */
function capitalize<T extends string>(str: T): Capitalize<T> {
  return str.charAt(0).toUpperCase() + str.slice(1) as Capitalize<T>;
}

/** Convert entity name to CLI command name */
function getCommandName(entityConfig: EntityConfig): string {
  return entityConfig.cliName;
}

/** Get entity description */
function getDescription(entityConfig: EntityConfig): string {
  return entityConfig.description;
}

// ============================================================================
// COMMAND ACTION FACTORIES
// ============================================================================

/** Factory for list commands */
function createListAction<T extends EntityName>(
  entityName: T,
  entityConfig: EntityConfig
): (state: CliState, ...args: unknown[]) => Promise<void> {
  return async (state: CliState, ..._args: unknown[]): Promise<void> => {
    try {
      const args = _args[0] as { limit?: number; all?: boolean; offset?: number };
      const limit = args.limit || (args.all ? 10000 : 100);
      const offset = args.offset || 0;
      
      const spinner = ProgressSpinner.create(!!state.verbose);
      if (!state.verbose) {
        spinner.start(`Fetching ${entityConfig.plural}`);
      }

      const listMethod = `list${capitalize(entityConfig.plural)}` as const;
      const data = await (state.client as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[listMethod](limit, offset);

      if (!state.verbose) {
        spinner.stop();
      }

      if (state.outputFormat === 'json') {
        printOutput(data, { format: state.outputFormat, pretty: true });
        return;
      }

      // Table format for list
      const items = (data as { data: unknown[] }).data || [];
      console.log(formatSuccess(`${capitalize(entityConfig.plural)} (${items.length})`));
      console.log('');

      if (items.length === 0) {
        console.log(formatInfo(`No ${entityConfig.plural} found`));
        return;
      }

      // Display using listDisplayFields or default to id
      const displayFields = entityConfig.listDisplayFields || ['id', 'name'];
      
      for (const item of items as Record<string, unknown>[]) {
        const displayValues = displayFields
          .map(field => item[field] !== undefined ? String(item[field]) : 'N/A')
          .join('  ');
        console.log(`  ${displayValues}`);
      }
    } catch (error) {
      console.error(formatError(`Failed to list ${entityConfig.plural}`));
      if (error instanceof Error) {
        console.error(formatError(error.message));
      }
      process.exit(1);
    }
  };
}

/** Factory for get commands */
function createGetAction<T extends EntityName>(
  entityName: T,
  entityConfig: EntityConfig
): (state: CliState, ...args: unknown[]) => Promise<void> {
  return async (state: CliState, ..._args: unknown[]): Promise<void> => {
    try {
      const id = _args[0] as string;
      
      if (!id) {
        console.error(formatError(`${capitalize(entityConfig.singular)} ID is required`));
        process.exit(1);
      }

      const spinner = ProgressSpinner.create(!!state.verbose);
      if (!state.verbose) {
        spinner.start(`Fetching ${entityConfig.singular}`);
      }

      const getMethod = `get${capitalize(entityConfig.singular)}` as const;
      const data = await (state.client as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[getMethod](id);

      if (!state.verbose) {
        spinner.stop();
      }

      printOutput(data, { format: state.outputFormat, pretty: true });
    } catch (error) {
      console.error(formatError(`Failed to get ${entityConfig.singular}`));
      if (error instanceof Error) {
        console.error(formatError(error.message));
      }
      process.exit(1);
    }
  };
}

/** Factory for create commands */
function createCreateAction<T extends EntityName>(
  entityName: T,
  entityConfig: EntityConfig
): (state: CliState, ...args: unknown[]) => Promise<void> {
  return async (state: CliState, ..._args: unknown[]): Promise<void> => {
    try {
      const opts = _args[0] as Record<string, unknown>;
      
      // Build data object from options
      const data: Record<string, unknown> = {};
      for (const field of entityConfig.createFields) {
        if (opts[field.name] !== undefined) {
          data[field.name] = opts[field.name];
        } else if (field.required) {
          console.error(formatError(`Missing required field: ${field.name}`));
          process.exit(1);
        }
      }

      const spinner = ProgressSpinner.create(!!state.verbose);
      if (!state.verbose) {
        spinner.start(`Creating ${entityConfig.singular}`);
      }

      const createMethod = `create${capitalize(entityConfig.singular)}` as const;
      const result = await (state.client as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[createMethod](data);

      if (!state.verbose) {
        spinner.stop();
      }

      console.log(formatSuccess(`${capitalize(entityConfig.singular)} created`));
      printOutput(result, { format: state.outputFormat, pretty: true });
    } catch (error) {
      console.error(formatError(`Failed to create ${entityConfig.singular}`));
      if (error instanceof Error) {
        console.error(formatError(error.message));
      }
      process.exit(1);
    }
  };
}

/** Factory for update commands */
function createUpdateAction<T extends EntityName>(
  entityName: T,
  entityConfig: EntityConfig
): (state: CliState, ...args: unknown[]) => Promise<void> {
  return async (state: CliState, ..._args: unknown[]): Promise<void> => {
    try {
      const id = _args[0] as string;
      const opts = _args[1] as Record<string, unknown>;
      
      if (!id) {
        console.error(formatError(`${capitalize(entityConfig.singular)} ID is required`));
        process.exit(1);
      }

      // Build data object from options
      const data: Record<string, unknown> = {};
      for (const field of entityConfig.updateFields) {
        if (opts[field.name] !== undefined) {
          data[field.name] = opts[field.name];
        }
      }

      if (Object.keys(data).length === 0) {
        console.error(formatError(`No fields to update`));
        process.exit(1);
      }

      const spinner = ProgressSpinner.create(!!state.verbose);
      if (!state.verbose) {
        spinner.start(`Updating ${entityConfig.singular}`);
      }

      const updateMethod = `update${capitalize(entityConfig.singular)}` as const;
      const result = await (state.client as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[updateMethod](id, data);

      if (!state.verbose) {
        spinner.stop();
      }

      console.log(formatSuccess(`${capitalize(entityConfig.singular)} updated`));
      printOutput(result, { format: state.outputFormat, pretty: true });
    } catch (error) {
      console.error(formatError(`Failed to update ${entityConfig.singular}`));
      if (error instanceof Error) {
        console.error(formatError(error.message));
      }
      process.exit(1);
    }
  };
}

/** Factory for delete commands */
function createDeleteAction<T extends EntityName>(
  entityName: T,
  entityConfig: EntityConfig
): (state: CliState, ...args: unknown[]) => Promise<void> {
  return async (state: CliState, ..._args: unknown[]): Promise<void> => {
    try {
      const id = _args[0] as string;
      const opts = _args[1] as { force?: boolean };
      
      if (!id) {
        console.error(formatError(`${capitalize(entityConfig.singular)} ID is required`));
        process.exit(1);
      }

      if (!opts.force) {
        console.log(formatInfo(`This will delete ${entityConfig.singular} ${id}`));
        console.log(formatInfo('Add --force to confirm'));
        process.exit(0);
      }

      const spinner = ProgressSpinner.create(!!state.verbose);
      if (!state.verbose) {
        spinner.start(`Deleting ${entityConfig.singular}`);
      }

      const deleteMethod = `delete${capitalize(entityConfig.singular)}` as const;
      await (state.client as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[deleteMethod](id);

      if (!state.verbose) {
        spinner.stop();
      }

      console.log(formatSuccess(`${capitalize(entityConfig.singular)} deleted`));
    } catch (error) {
      console.error(formatError(`Failed to delete ${entityConfig.singular}`));
      if (error instanceof Error) {
        console.error(formatError(error.message));
      }
      process.exit(1);
    }
  };
}

// ============================================================================
// OPERATION ACTION MAP
// ============================================================================

/** Map of operation types to their action factories */
const OPERATION_ACTION_FACTORIES: Record<CrudOperation, <T extends EntityName>(entityName: T, config: EntityConfig) => (state: CliState, ...args: unknown[]) => Promise<void>> = {
  list: createListAction,
  get: createGetAction,
  create: createCreateAction,
  update: createUpdateAction,
  delete: createDeleteAction,
} as const;

/** Map of extended operation types to their action factories */
const EXTENDED_OPERATION_FACTORIES: Partial<Record<ExtendedOperation, <T extends EntityName>(entityName: T, config: EntityConfig) => (state: CliState, ...args: unknown[]) => Promise<void>>> = {
  claim: createClaimAction,
  promote: createPromoteAction,
  demote: createDemoteAction,
  trigger: createTriggerAction,
  cancel: createCancelAction,
  decide: createDecideAction,
  link: createLinkAction,
  unlink: createUnlinkAction,
  rollback: createRollbackAction,
} as const;

// ============================================================================
// EXTENDED OPERATION ACTIONS
// ============================================================================

/** Factory for trigger commands */
function createTriggerAction<T extends EntityName>(
  entityName: T,
  entityConfig: EntityConfig
): (state: CliState, ...args: unknown[]) => Promise<void> {
  return async (state: CliState, ..._args: unknown[]): Promise<void> => {
    try {
      const id = _args[0] as string;
      const opts = _args[1] as Record<string, unknown>;
      
      if (!id) {
        console.error(formatError(`${capitalize(entityConfig.singular)} ID is required`));
        process.exit(1);
      }

      const spinner = ProgressSpinner.create(!!state.verbose);
      if (!state.verbose) {
        spinner.start(`Triggering ${entityConfig.singular}`);
      }

      const triggerMethod = `trigger${capitalize(entityConfig.singular)}` as const;
      const result = await (state.client as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[triggerMethod](id, opts);

      if (!state.verbose) {
        spinner.stop();
      }

      console.log(formatSuccess(`${capitalize(entityConfig.singular)} triggered`));
      printOutput(result, { format: state.outputFormat, pretty: true });
    } catch (error) {
      console.error(formatError(`Failed to trigger ${entityConfig.singular}`));
      if (error instanceof Error) {
        console.error(formatError(error.message));
      }
      process.exit(1);
    }
  };
}

/** Factory for cancel commands */
function createCancelAction<T extends EntityName>(
  entityName: T,
  entityConfig: EntityConfig
): (state: CliState, ...args: unknown[]) => Promise<void> {
  return async (state: CliState, ..._args: unknown[]): Promise<void> => {
    try {
      const id = _args[0] as string;
      
      if (!id) {
        console.error(formatError(`${capitalize(entityConfig.singular)} ID is required`));
        process.exit(1);
      }

      const spinner = ProgressSpinner.create(!!state.verbose);
      if (!state.verbose) {
        spinner.start(`Cancelling ${entityConfig.singular}`);
      }

      const cancelMethod = `cancel${capitalize(entityConfig.singular)}` as const;
      await (state.client as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[cancelMethod](id);

      if (!state.verbose) {
        spinner.stop();
      }

      console.log(formatSuccess(`${capitalize(entityConfig.singular)} cancelled`));
    } catch (error) {
      console.error(formatError(`Failed to cancel ${entityConfig.singular}`));
      if (error instanceof Error) {
        console.error(formatError(error.message));
      }
      process.exit(1);
    }
  };
}

/** Factory for rollback commands */
function createRollbackAction<T extends EntityName>(
  entityName: T,
  entityConfig: EntityConfig
): (state: CliState, ...args: unknown[]) => Promise<void> {
  return async (state: CliState, ..._args: unknown[]): Promise<void> => {
    try {
      const id = _args[0] as string;
      const opts = _args[1] as { toVersion?: string };
      
      if (!id) {
        console.error(formatError(`${capitalize(entityConfig.singular)} ID is required`));
        process.exit(1);
      }

      const spinner = ProgressSpinner.create(!!state.verbose);
      if (!state.verbose) {
        spinner.start(`Rolling back ${entityConfig.singular}`);
      }

      const rollbackMethod = `rollback${capitalize(entityConfig.singular)}` as const;
      const result = await (state.client as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[rollbackMethod](id, opts);

      if (!state.verbose) {
        spinner.stop();
      }

      console.log(formatSuccess(`${capitalize(entityConfig.singular)} rolled back`));
      printOutput(result, { format: state.outputFormat, pretty: true });
    } catch (error) {
      console.error(formatError(`Failed to rollback ${entityConfig.singular}`));
      if (error instanceof Error) {
        console.error(formatError(error.message));
      }
      process.exit(1);
    }
  };
}

// Stub factories for other extended operations (to be implemented as needed)
function createClaimAction<T extends EntityName>(): (state: CliState, ...args: unknown[]) => Promise<void> {
  return async (state: CliState) => {
    console.log(formatInfo('Claim action: implement for your entity'));
  };
}

function createPromoteAction<T extends EntityName>(): (state: CliState, ...args: unknown[]) => Promise<void> {
  return async (state: CliState) => {
    console.log(formatInfo('Promote action: implement for your entity'));
  };
}

function createDemoteAction<T extends EntityName>(): (state: CliState, ...args: unknown[]) => Promise<void> {
  return async (state: CliState) => {
    console.log(formatInfo('Demote action: implement for your entity'));
  };
}

function createDecideAction<T extends EntityName>(): (state: CliState, ...args: unknown[]) => Promise<void> {
  return async (state: CliState) => {
    console.log(formatInfo('Decide action: implement for your entity'));
  };
}

function createLinkAction<T extends EntityName>(): (state: CliState, ...args: unknown[]) => Promise<void> {
  return async (state: CliState) => {
    console.log(formatInfo('Link action: implement for your entity'));
  };
}

function createUnlinkAction<T extends EntityName>(): (state: CliState, ...args: unknown[]) => Promise<void> {
  return async (state: CliState) => {
    console.log(formatInfo('Unlink action: implement for your entity'));
  };
}

// ============================================================================
// COMMAND REGISTRATION
// ============================================================================

/** Register CRUD commands for a single entity */
export function registerEntityCommands(
  program: Command,
  entityName: EntityName,
  entityConfig: EntityConfig,
  createHandler: <T extends unknown[]>(
    action: (state: CliState, ...args: T) => Promise<void> | void
  ) => (...commanderArgs: unknown[]) => Promise<void>
): void {
  const commandName = getCommandName(entityConfig);
  const entityGroup = program.command(commandName).description(getDescription(entityConfig));

  // Register each operation
  for (const operation of entityConfig.operations) {
    // Check if it's a CRUD operation
    if (operation in OPERATION_ACTION_FACTORIES) {
      const factory = OPERATION_ACTION_FACTORIES[operation as CrudOperation];
      const action = factory(entityName, entityConfig);
      
      // Create the command
      const operationCommand = entityGroup.command(operation);
      
      // Add description
      const operationDescription = getOperationDescription(operation, entityConfig);
      operationCommand.description(operationDescription);
      
      // Add ID argument for get, update, delete
      if (operation === 'get' || operation === 'update' || operation === 'delete') {
        operationCommand.argument('<id>', `${capitalize(entityConfig.singular)} ID`);
      }
      
      // Add fields as options for create and update
      if (operation === 'create') {
        for (const field of entityConfig.createFields) {
          operationCommand.option(
            `--${field.name} <${getOptionType(field.type)}>`,
            field.description
          );
        }
      }
      
      if (operation === 'update') {
        for (const field of entityConfig.updateFields) {
          operationCommand.option(
            `--${field.name} <${getOptionType(field.type)}>`,
            field.description
          );
        }
      }
      
      // Add standard options
      if (operation === 'list') {
        operationCommand
          .option('-l, --limit <n>', 'Limit number of results')
          .option('--all', 'Fetch all results')
          .option('--offset <n>', 'Offset for pagination');
      }
      
      if (operation === 'delete') {
        operationCommand.option('-f, --force', 'Force deletion without confirmation');
      }
      
      // Register the action
      operationCommand.action(createHandler(action));
    }
    // Check if it's an extended operation
    else if (operation in EXTENDED_OPERATION_FACTORIES) {
      const factory = EXTENDED_OPERATION_FACTORIES[operation as ExtendedOperation]!;
      const action = factory(entityName, entityConfig);
      
      // Create the command
      const operationCommand = entityGroup.command(operation);
      
      // Add description
      const operationDescription = getOperationDescription(operation, entityConfig);
      operationCommand.description(operationDescription);
      
      // Add ID argument for operations that need it
      if (operation === 'trigger' || operation === 'cancel' || operation === 'rollback') {
        operationCommand.argument('<id>', `${capitalize(entityConfig.singular)} ID`);
      }
      
      // Add operation-specific options from config
      if (entityConfig.operationConfig?.[operation]) {
        const opConfig = entityConfig.operationConfig[operation];
        if (opConfig.options) {
          for (const option of opConfig.options) {
            let flags = `--${option.name}`;
            if (option.type !== 'boolean') {
              flags += ` <${option.type}>`;
            }
            operationCommand.option(flags, option.description);
          }
        }
      }
      
      // Register the action
      operationCommand.action(createHandler(action));
    }
    // Unknown operation - log warning but don't fail
    else {
      console.log(formatWarning(`Unknown operation: ${operation} for entity ${entityName}`));
    }
  }
  
  // Register custom commands for this entity
  if (entityConfig.customCommands) {
    for (const [commandName, customConfig] of Object.entries(entityConfig.customCommands)) {
      const cmd = entityGroup.command(commandName);
      cmd.description(customConfig.description);
      
      // Add arguments
      if (customConfig.arguments) {
        for (const arg of customConfig.arguments) {
          cmd.argument(`<${arg.name}>`, arg.description);
        }
      }
      
      // Add options
      if (customConfig.options) {
        for (const option of customConfig.options) {
          let flags = `--${option.name}${option.type === 'boolean' ? '' : ' <value>'}`;
          if (option.short) {
            flags = `--${option.name}${option.type === 'boolean' ? '' : ' <value>'}, -${option.short}`;
          }
          const opt = new Option(flags, option.description);
          cmd.addOption(opt);
        }
      }
      
      // Register action
      cmd.action(createHandler(async (state: CliState) => {
        console.log(formatInfo(`Custom command: ${commandName}`));
        console.log(formatInfo('Action: ' + customConfig.action));
      }));
    }
  }
}

/** Register all entity commands from the central definitions */
export function registerAllEntityCommands(
  program: Command,
  createHandler: <T extends unknown[]>(
    action: (state: CliState, ...args: T) => Promise<void> | void
  ) => (...commanderArgs: unknown[]) => Promise<void>
): void {
  for (const [entityName, entityConfig] of Object.entries(ENTITIES)) {
    registerEntityCommands(program, entityName as EntityName, entityConfig, createHandler);
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/** Get operation description */
function getOperationDescription(operation: EntityOperation, entityConfig: EntityConfig): string {
  const operationDescriptions: Partial<Record<EntityOperation, (config: EntityConfig) => string>> = {
    list: (config) => `List ${config.plural}`,
    get: (config) => `Get a ${config.singular}`,
    create: (config) => `Create a ${config.singular}`,
    update: (config) => `Update a ${config.singular}`,
    delete: (config) => `Delete a ${config.singular}`,
    claim: (config) => `Claim a ${config.singular}`,
    promote: (config) => `Promote a ${config.singular}`,
    demote: (config) => `Demote a ${config.singular}`,
    trigger: (config) => `Trigger a ${config.singular}`,
    cancel: (config) => `Cancel a ${config.singular}`,
    decide: (config) => `Record a decision for a ${config.singular}`,
    link: (config) => `Link a ${config.singular}`,
    unlink: (config) => `Unlink a ${config.singular}`,
    rollback: (config) => `Rollback a ${config.singular}`,
  };
  
  return operationDescriptions[operation]?.(entityConfig) || operation;
}

/** Get option type string for commander */
function getOptionType(fieldType: EntityField['type']): string {
  const typeMap: Record<EntityField['type'], string> = {
    string: 'string',
    number: 'number',
    boolean: 'boolean',
    enum: 'string',
    date: 'string',
    id: 'string',
    array: 'string',
  };
  return typeMap[fieldType] || 'string';
}

// ============================================================================
// CUSTOM COMMAND REGISTRATION
// ============================================================================

/** Register custom command groups */
export function registerCustomCommandGroups(
  program: Command,
  createHandler: <T extends unknown[]>(
    action: (state: CliState, ...args: T) => Promise<void> | void
  ) => (...commanderArgs: unknown[]) => Promise<void>
): void {
  // This would be implemented to register custom commands
  // For now, custom commands are still registered manually in their respective files
}
