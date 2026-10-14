/**
 * Organization Commands
 * Manages organizations
 */

import { Command } from 'commander';
import { CliState, GlobalOptions } from '../index';
import { printOutput, formatSuccess, formatError } from '../utils/output';
import { OrganizationResponse, CreateOrganizationRequest } from '../types/api';

// ============================================================================
// COMMAND ACTIONS
// ============================================================================

/**
 * Create organization
 */
async function actionCreate(state: CliState, ...args: unknown[]): Promise<void> {
  try {
    const name = args[0] as string;
    const opts = args[1] as { type?: string; externalId?: string };
    
    const request: CreateOrganizationRequest = {
      name,
      type: (opts.type as 'github' | 'gitlab' | 'artifacts') || 'github',
      externalId: opts.externalId,
    };

    const organization = await state.client.createOrganization(request, { actorId: state.config.defaultActor });

    if (state.outputFormat === 'json') {
      printOutput(organization, { format: state.outputFormat, pretty: true });
    } else {
      console.log(formatSuccess(`Organization created: ${organization.id}`));
      console.log('');
      printOutput(organization, { format: 'json', pretty: true });
    }
  } catch (error) {
    console.error(formatError('Failed to create organization'));
    if (error instanceof Error) {
      console.log(`  ${error.message}`);
    }
    process.exit(1);
  }
}

/**
 * List organizations
 */
async function actionList(state: CliState, ...args: unknown[]): Promise<void> {
  try {
    const opts = args[0] as { limit?: number; offset?: number };
    const response = await state.client.listOrganizations(opts.limit, opts.offset);
    
    if (state.outputFormat === 'json') {
      printOutput(response, { format: state.outputFormat, pretty: true });
    } else {
      console.log(formatSuccess(`Found ${response.data.length} organization(s)`));
      console.log('');
      for (const org of response.data) {
        console.log(`  ${org.id} - ${org.name} (${org.type})`);
      }
    }
  } catch (error) {
    console.error(formatError('Failed to list organizations'));
    if (error instanceof Error) {
      console.log(`  ${error.message}`);
    }
    process.exit(1);
  }
}

/**
 * Get organization
 */
async function actionGet(state: CliState, ...args: unknown[]): Promise<void> {
  try {
    const id = args[0] as string;
    const organization = await state.client.getOrganization(id);
    printOutput(organization, { format: state.outputFormat, pretty: true });
  } catch (error) {
    console.error(formatError(`Failed to get organization: ${args[0]}`));
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
 * Register organization commands with the CLI
 */
export function registerOrgCommands(
  program: Command,
  createHandler: (
    action: (state: CliState, ...args: unknown[]) => Promise<void> | void
  ) => (opts: GlobalOptions, ...args: unknown[]) => Promise<void>
): void {
  const org = program.command('org').description('Organization management');

  // Create
  org
    .command('create <name>')
    .description('Create a new organization')
    .option('--type <type>', 'Organization type: github, gitlab, or artifacts')
    .option('--external-id <id>', 'External organization ID')
    .action(createHandler(actionCreate));

  // List
  org
    .command('list')
    .description('List organizations')
    .option('-l, --limit <n>', 'Limit number of results', (val) => val ? parseInt(val) : undefined)
    .option('--offset <n>', 'Offset for pagination', (val) => val ? parseInt(val) : undefined)
    .action(createHandler(actionList));

  // Get
  org
    .command('get <id>')
    .description('Get organization details')
    .action(createHandler(actionGet));
}
