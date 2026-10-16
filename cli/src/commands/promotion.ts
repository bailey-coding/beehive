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

  promotion.command('create <candidate-id>').description('Create promotion').requiredOption('--from-rung <rung>', 'From rung (pre-merge, shadow, train, canary, full)').requiredOption('--to-rung <rung>', 'To rung (pre-merge, shadow, train, canary, full)').option('--notes <notes>', 'Promotion notes').action(createHandler(async (state, ..._args) => {
    const candidateId = _args[0] as string;
    const opts = _args[1] as { fromRung: string; toRung: string; notes?: string };
    
    const result = await state.client.createPromotion({
      candidateId,
      fromRung: opts.fromRung as 'pre-merge' | 'shadow' | 'train' | 'canary' | 'full',
      toRung: opts.toRung as 'pre-merge' | 'shadow' | 'train' | 'canary' | 'full',
      notes: opts.notes
    });
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
}
