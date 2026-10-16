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

  spec.command('create <name>').description('Create a new spec').option('--organization <id>', 'Organization ID', { required: true }).option('--contract <path>', 'Contract file path or JSON string', { required: true }).option('--declared-delta-surface <surface>', 'Declared delta surface (comma-separated)', { required: true }).option('--description <desc>', 'Spec description').action(createHandler(async (state, ..._args) => {
    const name = _args[0] as string;
    const opts = _args[1] as { organization: string; contract: string; declaredDeltaSurface: string; description?: string };
    
    let contract: string;
    if (opts.contract.startsWith('@')) {
      const fs = await import('fs');
      const path = opts.contract.substring(1);
      contract = await fs.promises.readFile(path, 'utf-8');
    } else {
      contract = opts.contract;
    }
    
    const declaredDeltaSurface = opts.declaredDeltaSurface.split(',').map(s => s.trim());
    
    const result = await state.client.createSpec({
      name,
      organizationId: opts.organization,
      contract,
      declaredDeltaSurface,
      description: opts.description,
    });
    printOutput(result, { format: state.outputFormat, pretty: true });
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

  spec.command('claim <spec-id>').description('Claim a spec').option('--actor <id>', 'Actor ID to claim as').option('--dry-run', 'Dry run without claiming').action(createHandler(async (state, ..._args) => {
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
