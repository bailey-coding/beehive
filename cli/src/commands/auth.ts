/**
 * Auth Commands
 * Handles authentication and configuration
 */

import { existsSync, readFileSync } from 'node:fs';
import { Command } from 'commander';
import { CliState, GlobalOptions } from '../index';
import { updateConfigFile, tokenKind, tokenPrefix } from '../utils/config';
import { BeehiveApiError, WhoamiResponse, createClient } from '../utils/api-client';
import { printOutput, formatSuccess, formatError, formatInfo } from '../utils/output';

// ============================================================================
// HELPERS
// ============================================================================

/** read / read_write / maintainer from the expanded scope list; 'unknown' if the edge sent none. */
function scopeLabel(scopes: string[] | undefined): string {
  if (!scopes || scopes.length === 0) return 'unknown';
  if (scopes.includes('maintainer')) return 'maintainer';
  if (scopes.includes('write')) return 'read_write';
  return 'read';
}

function printIdentity(who: WhoamiResponse): void {
  console.log(`  Kind:        ${who.kind}`);
  console.log(`  Actor:       ${who.actorId}`);
  console.log(`  Scope:       ${scopeLabel(who.scopes)}`);
  if (who.userTokenId) console.log(`  User token:  ${who.userTokenId}`);
  if (who.serviceAccountId) console.log(`  Service acct: ${who.serviceAccountId}`);
}

/** Read one line from piped stdin (keeps the token out of argv and shell history). */
function readTokenFromStdin(): string {
  if (process.stdin.isTTY) {
    throw new Error('--token-stdin expects the token on a pipe, e.g. `printf %s "$TOKEN" | beehive auth login --token-stdin`');
  }
  return readFileSync(0, 'utf-8').split(/\r?\n/)[0].trim();
}

// ============================================================================
// COMMAND ACTIONS
// ============================================================================

/**
 * Login command - authenticate with Beehive API.
 * The token is verified against /api/whoami BEFORE anything is written, so a bad login
 * never touches (or wipes) a previously saved token.
 */
async function actionLogin(state: CliState, ..._args: unknown[]): Promise<void> {
  const args = _args as [{ token?: string; tokenStdin?: boolean; interactive?: boolean }];
  const opts = args[0] || {};
  // The program-level --token option consumes `login --token X` too, so read the flag from there as well.
  let token = opts.token ?? (state.tokenSource === 'flag' ? state.config.apiToken : undefined);

  if (opts.tokenStdin) {
    if (token) {
      console.error(formatError('Use either --token or --token-stdin, not both'));
      process.exit(1);
    }
    try {
      token = readTokenFromStdin();
    } catch (error) {
      console.error(formatError(error instanceof Error ? error.message : 'Could not read the token from stdin'));
      process.exit(1);
    }
  } else if (token) {
    console.error('Note: --token puts the token in argv, visible to other local users and shell history; prefer --token-stdin.');
  }

  if (!token && opts.interactive) {
    console.log(formatError('Interactive mode not yet implemented'));
    process.exit(1);
  }

  if (!token) {
    console.error(formatError('No token provided. Use --token-stdin (preferred) or --token'));
    process.exit(1);
  }

  if (typeof token !== 'string' || token.trim().length === 0) {
    console.error(formatError('Invalid token'));
    process.exit(1);
  }
  token = token.trim();

  // Throwaway client: state.client keeps the old token, and no actor is involved in verifying.
  const probe = createClient({ ...state.config, apiToken: token, defaultActor: undefined });
  let who: WhoamiResponse;
  try {
    who = await probe.getWhoami();
  } catch (error) {
    const status = error instanceof BeehiveApiError ? error.statusCode : 0;
    if (status === 401) {
      console.error(formatError('Authentication failed: the edge rejected this token. Nothing was saved.'));
      if (tokenKind(token) === 'user') {
        console.error('The token may be revoked or expired, or this edge may predate user tokens.');
      }
    } else if (status === 0 || status >= 500) {
      console.error(formatError('Could not verify the token (API unavailable or unreachable). Nothing was saved; retry.'));
    } else {
      console.error(formatError(`Could not verify the token: the edge answered ${status} to /api/whoami. Nothing was saved.`));
    }
    process.exit(1);
  }

  try {
    updateConfigFile(state.configPath, { apiToken: token });
  } catch (error) {
    console.error(formatError(error instanceof Error ? error.message : 'Failed to save config'));
    process.exit(1);
  }
  state.client.updateToken(token);

  console.log(formatSuccess('Authenticated successfully'));
  printIdentity(who);
  console.log(formatInfo(`Token saved to: ${state.configPath}`));
  if (process.env.BEEHIVE_API_TOKEN) {
    console.log(formatInfo('BEEHIVE_API_TOKEN is set in the environment and overrides the saved token.'));
  }
}

/**
 * Whoami command - show the identity the edge resolves for the current token
 */
async function actionWhoami(state: CliState, ..._args: unknown[]): Promise<void> {
  const who = await state.client.getWhoami();
  const token = state.config.apiToken;
  console.log('Identity:');
  console.log('');
  printIdentity(who);
  console.log(`  Token:       ${token ? `${tokenPrefix(token)}...` : '(none)'}`);
  console.log(`  Token source: ${state.tokenSource}`);
  console.log(`  API URL:     ${state.client.apiUrl}`);
}

/**
 * Status command - show current authentication status
 */
async function actionStatus(state: CliState, ..._args: unknown[]): Promise<void> {
  console.log('Authentication Status:');
  console.log('');
  console.log(`  API URL:      ${state.client.apiUrl}`);
  console.log(`  Token set:    ${state.config.apiToken ? 'Yes' : 'No'}`);
  console.log(`  Token source: ${state.tokenSource}`);
  console.log(`  Config file:  ${state.configPath}`);
  console.log('');

  try {
    const who = await state.client.getWhoami();
    console.log('Connection test: Success');
    printIdentity(who);
  } catch (error) {
    console.log('Connection test: Failed');
    if (error instanceof Error) {
      console.log(`  Error: ${error.message}`);
    }
  }
}

/**
 * Logout command - clear the saved token (config file only)
 */
async function actionLogout(state: CliState, ..._args: unknown[]): Promise<void> {
  try {
    if (existsSync(state.configPath)) {
      updateConfigFile(state.configPath, { apiToken: undefined });
      console.log(formatSuccess('Logged out successfully'));
      console.log(formatInfo(`Token removed from: ${state.configPath}`));
    } else {
      console.log(formatInfo(`No saved token: ${state.configPath} does not exist`));
    }
    state.client.updateToken('');
    if (process.env.BEEHIVE_API_TOKEN) {
      console.log(formatInfo('BEEHIVE_API_TOKEN is still set in the environment; unset it to stop using that token.'));
    }
  } catch (error) {
    console.error(formatError(error instanceof Error ? error.message : 'Logout failed'));
    process.exit(1);
  }
}

/**
 * Test command - verify authentication
 */
async function actionTest(state: CliState, ..._args: unknown[]): Promise<void> {
  try {
    const who = await state.client.getWhoami();
    console.log(formatSuccess('Authentication test passed'));
    console.log('');
    printOutput(who, { format: state.outputFormat, pretty: true });
  } catch (error) {
    console.error(formatError('Authentication test failed'));
    if (error instanceof Error) console.error(`  ${error.message}`);
    process.exit(1);
  }
}

/**
 * Show token command - display only the token's leading characters
 */
async function actionShowToken(state: CliState, ..._args: unknown[]): Promise<void> {
  const token = state.config.apiToken;

  if (!token) {
    console.error(formatError('No token is set'));
    process.exit(1);
  }

  console.log(`Token: ${tokenPrefix(token)}...`);
  console.log(`Length: ${token.length} characters`);
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
    .option('--token-stdin', 'Read the API token from one line of stdin (keeps it out of argv)')
    .option('-i, --interactive', 'Prompt for token interactively')
    .action(createHandler(actionLogin));

  auth
    .command('status')
    .description('Show current authentication status')
    .action(createHandler(actionStatus));

  auth
    .command('whoami')
    .description('Show the identity, scope and token source the edge resolves for the current token')
    .action(createHandler(actionWhoami));

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
