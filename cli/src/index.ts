#!/usr/bin/env node

/**
 * Beehive CLI Entry Point (Refactored)
 * 
 * This uses the command factory for CRUD operations and manual registration
 * for custom commands. This significantly reduces code repetition for new phases.
 */

import { Command, Option } from 'commander';
import chalk from 'chalk';
import { loadConfig, saveConfig, getConfigPath, DEFAULT_CONFIG } from './utils/config';
import { BeehiveClient, createClient } from './utils/api-client';
import { OutputFormat, printOutput, formatError, formatSuccess, formatWarning } from './utils/output';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Import the command factory
import { registerAllEntityCommands, registerEntityCommands } from './utils/command-factory';
import { ENTITIES, CUSTOM_COMMAND_GROUPS } from './types/definitions';
import type { EntityName, CustomCommandConfig } from './types/definitions';

// Import manual command registrations for Phase 1 entities
import { registerAuthCommands } from './commands/auth';
import { registerOrgCommands } from './commands/org';
import { registerActorCommands } from './commands/actor';
import { registerRepoCommands } from './commands/repo';
import { registerSpecCommands } from './commands/spec';
import { registerCandidateCommands } from './commands/candidate';
import { registerGateCommands } from './commands/gate';
import { registerTrialCommands } from './commands/trial';
import { registerPromotionCommands } from './commands/promotion';
import { registerIssueCommands } from './commands/issue';
import { registerHistoryCommands } from './commands/history';
// Custom command groups
import { registerDebugCommands } from './commands/debug';
import { registerHealthCommands } from './commands/health';

// Version
const VERSION = '0.1.0';
const DESCRIPTION = 'CLI for Beehive - Agent-native version control and collaboration platform';

// CLI State
export interface CliState {
  client: BeehiveClient;
  config: typeof DEFAULT_CONFIG;
  verbose: boolean;
  outputFormat: OutputFormat;
  dryRun: boolean;
}

// Global CLI options
export interface GlobalOptions {
  config?: string;
  token?: string;
  url?: string;
  format?: OutputFormat;
  pretty?: boolean;
  verbose?: boolean;
  version?: boolean;
  help?: boolean;
  dryRun?: boolean;
}

/**
 * Create and configure the main CLI program
 */
function createCli(): Command {
  const program = new Command();

  // Set up global options
  program
    .name('beehive')
    .description(DESCRIPTION)
    .version(VERSION)
    .showHelpAfterError(false)
    .showSuggestionAfterError(false)
    .configureOutput({
      writeErr: (str) => process.stderr.write(str),
      writeOut: (str) => process.stdout.write(str),
    });

  // Global options
  program
    .addOption(
      new Option('--config <path>', 'Path to config file')
        .env('BEEHIVE_CONFIG')
        .default(getConfigPath())
    )
    .addOption(
      new Option('--token <token>', 'API authentication token')
        .env('BEEHIVE_API_TOKEN')
    )
    .addOption(
      new Option('--url <url>', 'API base URL')
        .env('BEEHIVE_API_URL')
        .default('https://beehive.bz23711.workers.dev')
    )
    .addOption(
      new Option('-f, --format <format>', 'Output format')
        .choices(['json', 'table', 'yaml', 'compact'] as OutputFormat[])
        .default('json' as OutputFormat)
    )
    .addOption(
      new Option('--pretty', 'Pretty-print JSON output')
        .default(true)
    )
    .addOption(
      new Option('-v, --verbose', 'Verbose output')
        .env('BEEHIVE_VERBOSE')
        .default(false)
    )
    .addOption(
      new Option('-n, --dry-run', 'Dry run (no changes)')
        .default(false)
    );

  return program;
}

/**
 * Parse global options and create CLI state
 */
async function createCliState(opts: GlobalOptions): Promise<CliState> {
  // Load configuration
  const config = loadConfig({
    configPath: opts.config,
    apiUrl: opts.url,
    apiToken: opts.token,
  });

  // Override with command-line options
  if (opts.verbose !== undefined) {
    config.verbose = opts.verbose;
  }

  // Create API client
  const client = createClient(config);

  // Determine output format
  const outputFormat: OutputFormat = (opts.format as OutputFormat) || 'json';

  return {
    client,
    config,
    verbose: config.verbose || opts.verbose || false,
    outputFormat,
    dryRun: opts.dryRun || false,
  };
}

/**
 * Main action handler factory
 * Creates a handler that sets up CLI state and calls the command action
 */
function createActionHandler<T extends unknown[]>(
  action: (state: CliState, ...args: T) => Promise<void> | void
): (...commanderArgs: unknown[]) => Promise<void> {
  // Commander calls actions as (...positionals, localOptions, command).
  return async (...commanderArgs: unknown[]) => {
    try {
      const command = commanderArgs[commanderArgs.length - 1] as Command;
      const args = commanderArgs.slice(0, -1) as T;
      const state = await createCliState(command.optsWithGlobals<GlobalOptions>());

      // Print verbose info if enabled
      if (state.verbose) {
        console.log(chalk.gray(`
CLI Version: ${VERSION}
API URL: ${state.client.apiUrl}
Authenticated: ${state.client.isAuthenticated}
`));
      }

      // Call the action
      const result = action(state, ...args);
      
      // Handle promise
      if (result && typeof result === 'object' && 'then' in result) {
        await result;
      }
    } catch (error) {
      // Handle errors
      if (error instanceof Error) {
        const message = formatError(error);
        console.error(message);
        process.exit(1);
      } else {
        console.error(formatError(String(error)));
        process.exit(1);
      }
    }
  };
}

/**
 * Register Phase 1 command groups manually
 * These are commands that have custom implementations or don't fit the standard CRUD pattern
 */
function registerPhase1Commands(
  program: Command,
  createHandler: <T extends unknown[]>(
    action: (state: CliState, ...args: T) => Promise<void> | void
  ) => (...commanderArgs: unknown[]) => Promise<void>
): void {
  // Phase 1: Core entities with custom command implementations
  registerAuthCommands(program, createHandler);
  registerOrgCommands(program, createHandler);
  registerActorCommands(program, createHandler);
  registerRepoCommands(program, createHandler);
  registerSpecCommands(program, createHandler);
  registerCandidateCommands(program, createHandler);
  registerGateCommands(program, createHandler);
  registerTrialCommands(program, createHandler);
  registerPromotionCommands(program, createHandler);
  registerIssueCommands(program, createHandler);
  registerHistoryCommands(program, createHandler);
  
  // Custom command groups
  registerDebugCommands(program, createHandler);
  registerHealthCommands(program, createHandler);
}

/**
 * Register Phase 2/3 entity commands using the factory
 * This automatically creates CRUD commands for new entities only
 * 
 * NOTE: workflow, deployment, and environment groups have been removed
 * as they reference routes that do not exist in the API
 */
function registerGeneratedCommands(
  program: Command,
  createHandler: <T extends unknown[]>(
    action: (state: CliState, ...args: T) => Promise<void> | void
  ) => (...commanderArgs: unknown[]) => Promise<void>
): void {
  // Phase 2 and Phase 3 entities - currently none are auto-registered
  // as workflow, deployment, and environment have been removed
  const phase2And3Entities: readonly [] = [];
  
  for (const entityName of phase2And3Entities) {
    const entityConfig = ENTITIES[entityName];
    if (entityConfig) {
      registerEntityCommands(program, entityName, entityConfig, createHandler);
    }
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const program = createCli();

  // Register Phase 1 commands manually
  registerPhase1Commands(program, createActionHandler);

  // Register Phase 2/3 commands automatically via factory
  registerGeneratedCommands(program, createActionHandler);

  // Parse arguments
  await program.parseAsync(process.argv);

  // If no command was provided, show help
  if (!process.argv.slice(2).length || program.args.length === 0) {
    program.outputHelp();
  }
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error(formatError(error instanceof Error ? error : new Error(String(error))));
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error(formatError(reason instanceof Error ? reason : new Error(String(reason))));
  process.exit(1);
});

// Run
main().catch((error) => {
  console.error(formatError(error instanceof Error ? error : new Error(String(error))));
  process.exit(1);
});

// Export for testing
export {
  createCli,
  createCliState,
  createActionHandler,
  VERSION,
  DESCRIPTION,
  registerPhase1Commands,
  registerGeneratedCommands,
};
