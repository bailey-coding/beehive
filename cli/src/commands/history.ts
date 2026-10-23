/**
 * History Commands
 * Retrieves entity history
 */

import { Command } from 'commander';
import { CliState, GlobalOptions } from '../index';
import { printOutput, formatSuccess, formatError } from '../utils/output';
import { EntityType } from '../types/api';

// ============================================================================
// COMMAND ACTIONS
// ============================================================================

/**
 * Get entity history
 */
async function actionGet(state: CliState, ..._args: unknown[]): Promise<void> {
  try {
    const args = _args as [EntityType, string];
    const entityType = args[0];
    const entityId = args[1];
    
    if (!entityType || !entityId) {
      console.error(formatError('Entity type and ID are required'));
      process.exit(1);
    }
    
    const history = await state.client.getEntityHistory(entityType, entityId);
    
    if (state.outputFormat === 'json') {
      printOutput(history, { format: state.outputFormat, pretty: true });
    } else {
      console.log(formatSuccess(`History for ${entityType}:${entityId}`));
      console.log('');
      
      for (const entry of history.history) {
        console.log(`  ${entry.id} - ${entry.action}`);
        console.log(`    Actor: ${entry.actorId}`);
        console.log(`    Timestamp: ${new Date(entry.timestamp).toISOString()}`);
        console.log('');
      }
    }
  } catch (error) {
    console.error(formatError(`Failed to get history`));
    process.exit(1);
  }
}

// ============================================================================
// COMMAND REGISTRATION
// ============================================================================

/**
 * Register history commands with the CLI
 */
export function registerHistoryCommands(
  program: Command,
  createHandler: (
    action: (state: CliState, ...args: unknown[]) => Promise<void> | void
  ) => (...commanderArgs: unknown[]) => Promise<void>
): void {
  const history = program.command('history').description('Entity history');

  history
    .command('get <entity-type> <entity-id>')
    .description('Get history for an entity')
    .action(createHandler(actionGet));

  history
    .command('<entity-type> <entity-id>')
    .description('Get history for an entity (shortcut)')
    .action(createHandler(actionGet));
}
