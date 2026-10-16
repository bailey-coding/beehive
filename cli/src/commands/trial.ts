/**
 * Trial Commands
 */
import { Command } from 'commander';
import { CliState, GlobalOptions } from '../index';
import { printOutput, formatSuccess, formatError } from '../utils/output';

export function registerTrialCommands(
  program: Command,
  createHandler: (action: (state: CliState, ...args: unknown[]) => Promise<void> | void) => (opts: GlobalOptions, ...args: unknown[]) => Promise<void>
): void {
  const trial = program.command('trial').description('Trial operations');

  trial.command('create').description('Create a trial').action(createHandler(async (state, ..._args) => {
    const args = _args as [{ candidateA?: string; candidateB?: string; spec?: string }];
    if (!args[0]?.candidateA || !args[0]?.candidateB || !args[0]?.spec) {
      console.error(formatError('candidateA, candidateB, and spec are required'));
      process.exit(1);
    }
    console.log(formatError('Trial creation not fully implemented'));
  }));

  trial.command('list').description('List trials').action(createHandler(async (state) => {
    const response = await state.client.listTrials(100, 0);
    if (state.outputFormat === 'json') {
      printOutput(response, { format: state.outputFormat, pretty: true });
    } else {
      console.log(formatSuccess(`Found ${response.data.length} trial(s)`));
    }
  }));

  trial.command('get <id>').description('Get trial').action(createHandler(async (state, id) => {
    const t = await state.client.getTrial(id as string);
    printOutput(t, { format: state.outputFormat, pretty: true });
  }));

  trial.command('decide <trial-id> <winner-id>').description('Decide trial').option('--comparison-metrics <json>', 'Comparison metrics as JSON string').option('--decided-by <id>', 'Actor ID who decided').option('--notes <notes>', 'Trial notes').action(createHandler(async (state, ..._args) => {
    const trialId = _args[0] as string;
    const winnerId = _args[1] as string;
    const opts = _args[2] as { comparisonMetrics?: string; decidedBy?: string; notes?: string } || {};
    
    let comparisonMetrics = undefined;
    if (opts.comparisonMetrics) {
      try {
        comparisonMetrics = JSON.parse(opts.comparisonMetrics);
      } catch (e) {
        console.error(formatError('Invalid JSON for comparisonMetrics'));
        process.exit(1);
      }
    }
    
    const result = await state.client.decideTrial(trialId, {
      winnerId,
      comparisonMetrics,
      decidedBy: opts.decidedBy
    });
    printOutput(result, { format: state.outputFormat, pretty: true });
  }));
}
