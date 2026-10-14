/**
 * Spec Commands
 */
import { Command } from 'commander';
import { CliState, GlobalOptions } from '../index';
import { printOutput, formatSuccess, formatError } from '../utils/output';

export function registerSpecCommands(
  program: Command,
  createHandler: (action: (state: CliState, ...args: unknown[]) => Promise<void> | void) => (opts: GlobalOptions, ...args: unknown[]) => Promise<void>
): void {
  const spec = program.command('spec').description('Spec management');

  spec.command('create <name>').description('Create a new spec').action(createHandler(async (state, ..._args) => {
    const args = _args as [{ organization?: string; contract?: string; declaredDeltaSurface?: string }];
    if (!args[0]?.organization || !args[0]?.declaredDeltaSurface) {
      console.error(formatError('Organization and declared-delta-surface are required'));
      process.exit(1);
    }
    console.log(formatError('Spec creation not fully implemented'));
  }));

  spec.command('list').description('List specs').action(createHandler(async (state) => {
    const response = await state.client.listSpecs(100, 0);
    if (state.outputFormat === 'json') {
      printOutput(response, { format: state.outputFormat, pretty: true });
    } else {
      console.log(formatSuccess(`Found ${response.data.length} spec(s)`));
    }
  }));

  spec.command('get <id>').description('Get spec').action(createHandler(async (state, id) => {
    const s = await state.client.getSpec(id as string);
    printOutput(s, { format: state.outputFormat, pretty: true });
  }));

  spec.command('claim <spec-id>').description('Claim a spec').action(createHandler(async (state, ..._args) => {
    const specId = _args[0] as string;
    const opts = _args[1] as { actor?: string; dryRun?: boolean } || {};
    
    if (opts.dryRun) {
      console.log(formatSuccess('Dry run - would claim spec'));
      return;
    }
    
    const result = await state.client.claimSpec(specId, { specId }, { actorId: opts.actor });
    printOutput(result, { format: state.outputFormat, pretty: true });
  }));
}
