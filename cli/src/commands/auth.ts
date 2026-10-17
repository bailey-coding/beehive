/**
 * Auth Commands
 * Handles authentication and configuration
 */

import { Command } from 'commander';
import { CliState, GlobalOptions } from '../index';
import { loadConfig, saveConfig, getConfigPath, initConfig } from '../utils/config';
import { printOutput, formatSuccess, formatError, formatInfo } from '../utils/output';

// ============================================================================
// COMMAND ACTIONS
// ============================================================================

/**
 * Login command - authenticate with Beehive API
 */
async function actionLogin(state: CliState, ..._args: unknown[]): Promise<void> {
  try {
    const args = _args as [{ token?: string; interactive?: boolean }];
    const opts = args[0] || {};
    let token = opts.token;

    if (!token && opts.interactive) {
      console.log(formatError('Interactive mode not yet implemented'));
      process.exit(1);
    }

    if (!token) {
      console.error(formatError('No token provided. Use --token or -i/--interactive'));
      process.exit(1);
    }

    if (typeof token !== 'string' || token.trim().length === 0) {
      console.error(formatError('Invalid token'));
      process.exit(1);
    }

    const config = { ...state.config, apiToken: token };
    saveConfig(config);
    state.client.updateToken(token);

    try {
      await state.client.getHealth();
      console.log(formatSuccess('Authenticated successfully'));
      console.log(formatInfo(`Token saved to: ${getConfigPath()}`));
    } catch (error) {
      console.error(formatError('Authentication failed. Please check your token.'));
      const cleanConfig = { ...config, apiToken: undefined };
      saveConfig(cleanConfig);
      process.exit(1);
    }
  } catch (error) {
    console.error(formatError('Login failed'));
    process.exit(1);
  }
}

/**
 * Status command - show current authentication status
 */
async function actionStatus(state: CliState, ..._args: unknown[]): Promise<void> {
  try {
    const config = loadConfig();

    console.log('Authentication Status:');
    console.log('');
    console.log(`  API URL:     ${config.apiUrl || 'https://beehive.bz23711.workers.dev'}`);
    console.log(`  Token set:   ${config.apiToken ? 'Yes' : 'No'}`);
    console.log(`  Config file: ${getConfigPath()}`);
    console.log('');

    try {
      await state.client.getHealth();
      console.log('Connection test: Success');
    } catch (error) {
      console.log('Connection test: Failed');
      if (error instanceof Error) {
        console.log(`  Error: ${error.message}`);
      }
    }
  } catch (error) {
    console.error(formatError('Failed to check status'));
    process.exit(1);
  }
}

/**
 * Logout command - clear authentication token
 */
async function actionLogout(state: CliState, ..._args: unknown[]): Promise<void> {
  try {
    const config = loadConfig();
    config.apiToken = undefined;
    saveConfig(config);
    state.client.updateToken('');

    console.log(formatSuccess('Logged out successfully'));
    console.log(formatInfo(`Token removed from: ${getConfigPath()}`));
  } catch (error) {
    console.error(formatError('Logout failed'));
    process.exit(1);
  }
}

/**
 * Test command - verify authentication
 */
async function actionTest(state: CliState, ..._args: unknown[]): Promise<void> {
  try {
    const health = await state.client.getHealth();
    console.log(formatSuccess('Authentication test passed'));
    console.log('');
    printOutput(health, { format: state.outputFormat, pretty: true });
  } catch (error) {
    console.error(formatError('Authentication test failed'));
    process.exit(1);
  }
}

/**
 * Show token command - display the current token (masked)
 */
async function actionShowToken(state: CliState, ..._args: unknown[]): Promise<void> {
  try {
    const config = loadConfig();

    if (!config.apiToken) {
      console.error(formatError('No token is set'));
      process.exit(1);
    }

    const maskedToken = config.apiToken.slice(0, 8) + '*'.repeat(Math.max(0, config.apiToken.length - 8));
    console.log(`Token: ${maskedToken}`);
    console.log(`Length: ${config.apiToken.length} characters`);
  } catch (error) {
    console.error(formatError('Failed to show token'));
    process.exit(1);
  }
}

// ============================================================================
// COMMAND REGISTRATION
// ============================================================================

/**
 * Register auth commands with the CLI
 */
export function registerAuthCommands(
  program: Command,
  createHandler: (
    action: (state: CliState, ...args: unknown[]) => Promise<void> | void
  ) => (...commanderArgs: unknown[]) => Promise<void>
): void {
  const auth = program.command('auth').description('Authentication management');

  auth
    .command('login')
    .description('Authenticate with Beehive API')
    .option('-t, --token <token>', 'API token')
    .option('-i, --interactive', 'Prompt for token interactively')
    .action(createHandler(actionLogin));

  auth
    .command('status')
    .description('Show current authentication status')
    .action(createHandler(actionStatus));

  auth
    .command('test')
    .description('Test authentication')
    .action(createHandler(actionTest));

  auth
    .command('logout')
    .description('Clear authentication token')
    .action(createHandler(actionLogout));

  auth
    .command('show-token')
    .description('Display the current API token (masked)')
    .action(createHandler(actionShowToken));
}
