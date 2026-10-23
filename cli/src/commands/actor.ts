/**
 * Actor Commands
 * Manages actors (humans and agents)
 */

import { Command } from 'commander';
import { CliState, GlobalOptions } from '../index';
import { printOutput, formatSuccess, formatError } from '../utils/output';
import { ActorResponse, CreateActorRequest, UpdateActorTrustRequest } from '../types/api';

// ============================================================================
// COMMAND ACTIONS
// ============================================================================

/**
 * Create actor
 */
async function actionCreate(state: CliState, ...args: unknown[]): Promise<void> {
  try {
    const name = args[0] as string;
    const opts = args[1] as { type?: string; githubUserId?: string; actor?: string };
    
    const request: CreateActorRequest = {
      name,
      type: (opts.type as 'human' | 'agent') || 'human',
      githubUserId: opts.githubUserId,
    };

    const actor = await state.client.createActor(request, { actorId: opts.actor });

    if (state.outputFormat === 'json') {
      printOutput(actor, { format: state.outputFormat, pretty: true });
    } else {
      console.log(formatSuccess(`Actor created: ${actor.id}`));
      console.log('');
      printOutput(actor, { format: 'json', pretty: true });
    }
  } catch (error) {
    console.error(formatError('Failed to create actor'));
    if (error instanceof Error) {
      console.log(`  ${error.message}`);
    }
    process.exit(1);
  }
}

/**
 * List actors
 */
async function actionList(state: CliState, ...args: unknown[]): Promise<void> {
  try {
    const opts = args[0] as { limit?: number; offset?: number; type?: string };
    const response = await state.client.listActors(
      opts.limit,
      opts.offset,
      opts.type as 'human' | 'agent' | undefined
    );
    
    if (state.outputFormat === 'json') {
      printOutput(response, { format: state.outputFormat, pretty: true });
    } else {
      console.log(formatSuccess(`Found ${response.data.length} actor(s)`));
      console.log('');
      for (const actor of response.data) {
        const typeEmoji = actor.type === 'human' ? '👤' : '🤖';
        console.log(`  ${actor.id} - ${typeEmoji} ${actor.name} (trust: ${actor.trustScore}, promo: ${actor.promotionAuthority ? '✓' : '✗'})`);
      }
    }
  } catch (error) {
    console.error(formatError('Failed to list actors'));
    if (error instanceof Error) {
      console.log(`  ${error.message}`);
    }
    process.exit(1);
  }
}

/**
 * Get actor
 */
async function actionGet(state: CliState, ...args: unknown[]): Promise<void> {
  try {
    const id = args[0] as string;
    const actor = await state.client.getActor(id);
    printOutput(actor, { format: state.outputFormat, pretty: true });
  } catch (error) {
    console.error(formatError(`Failed to get actor: ${args[0]}`));
    if (error instanceof Error) {
      console.log(`  ${error.message}`);
    }
    process.exit(1);
  }
}

/**
 * Update trust score
 */
async function actionTrust(state: CliState, ...args: unknown[]): Promise<void> {
  try {
    const id = args[0] as string;
    const score = args[1] as number;
    const opts = (args[2] as { actor?: string }) || {};
    const request: UpdateActorTrustRequest = { trustScore: score };
    const actor = await state.client.updateActorTrust(id, request, { actorId: opts.actor });

    if (state.outputFormat === 'json') {
      printOutput(actor, { format: state.outputFormat, pretty: true });
    } else {
      console.log(formatSuccess(`Trust score updated for actor: ${id}`));
      console.log(`  New trust score: ${actor.trustScore}`);
    }
  } catch (error) {
    console.error(formatError(`Failed to update trust for actor: ${args[0]}`));
    if (error instanceof Error) {
      console.log(`  ${error.message}`);
    }
    process.exit(1);
  }
}

/**
 * Grant promotion authority
 */
async function actionGrantPromotion(state: CliState, ...args: unknown[]): Promise<void> {
  try {
    const id = args[0] as string;
    const opts = (args[1] as { actor?: string }) || {};
    const actor = await state.client.grantPromotionAuthority(id, { actorId: opts.actor });

    if (state.outputFormat === 'json') {
      printOutput(actor, { format: state.outputFormat, pretty: true });
    } else {
      console.log(formatSuccess(`Promotion authority granted to actor: ${id}`));
      console.log(`  Promotion authority: ${actor.promotionAuthority ? '✓' : '✗'}`);
    }
  } catch (error) {
    console.error(formatError(`Failed to grant promotion authority to actor: ${args[0]}`));
    if (error instanceof Error) {
      console.log(`  ${error.message}`);
    }
    process.exit(1);
  }
}

// ============================================================================
// COMMAND REGISTRATION
// ============================================================================

/**
 * Register actor commands with the CLI
 */
export function registerActorCommands(
  program: Command,
  createHandler: (
    action: (state: CliState, ...args: unknown[]) => Promise<void> | void
  ) => (...commanderArgs: unknown[]) => Promise<void>
): void {
  const actor = program.command('actor').description('Actor management');

  // Create
  actor
    .command('create <name>')
    .description('Create a new actor')
    .option('--type <type>', 'Actor type: human or agent')
    .option('--github-user-id <id>', 'GitHub user ID')
    .option('--actor <id>', 'Actor ID to act as (default: BEEHIVE_ACTOR, then config defaultActor)')
    .action(createHandler(actionCreate));

  // List
  actor
    .command('list')
    .description('List actors')
    .option('-l, --limit <n>', 'Limit number of results', (val) => val ? parseInt(val) : undefined)
    .option('--offset <n>', 'Offset for pagination', (val) => val ? parseInt(val) : undefined)
    .option('--type <type>', 'Filter by type: human or agent')
    .action(createHandler(actionList));

  // Get
  actor
    .command('get <id>')
    .description('Get actor details')
    .action(createHandler(actionGet));

  // Trust
  actor
    .command('trust <id> <score>')
    .description('Update actor trust score')
    .option('--actor <id>', 'Actor ID to act as (default: BEEHIVE_ACTOR, then config defaultActor)')
    .action(createHandler(actionTrust));

  // Grant promotion authority
  actor
    .command('grant-promotion <id>')
    .description('Grant promotion authority to an actor')
    .option('--actor <id>', 'Actor ID to act as (default: BEEHIVE_ACTOR, then config defaultActor)')
    .action(createHandler(actionGrantPromotion));
}
