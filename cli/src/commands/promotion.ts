/**
 * Promotion Commands
 */
import { Command } from 'commander';
import { CliState, GlobalOptions } from '../index';
import { printOutput, formatSuccess } from '../utils/output';

export function registerPromotionCommands(
  program: Command,
  createHandler: (action: (state: CliState, ...args: unknown[]) => Promise<void> | void) => (opts: GlobalOptions, ...args: unknown[]) => Promise<void>
): void {
  const promotion = program.command('promotion').description('Promotion operations');

  promotion.command('create <candidate-id>').description('Create promotion').action(createHandler(async (state, ..._args) => {
    const candidateId = _args[0] as string;
    const opts = _args[1] as { notes?: string } || {};
    const notes = opts.notes;
    
    const result = await state.client.createPromotion({ candidateId, notes });
    printOutput(result, { format: state.outputFormat, pretty: true });
  }));

  promotion.command('list').description('List promotions').action(createHandler(async (state) => {
    const response = await state.client.listPromotions(100, 0);
    if (state.outputFormat === 'json') {
      printOutput(response, { format: state.outputFormat, pretty: true });
    } else {
      console.log(formatSuccess(`Found ${response.data.length} promotion(s)`));
    }
  }));

  promotion.command('get <id>').description('Get promotion').action(createHandler(async (state, id) => {
    const p = await state.client.getPromotion(id as string);
    printOutput(p, { format: state.outputFormat, pretty: true });
  }));
}
