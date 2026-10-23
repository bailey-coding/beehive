/**
 * Trial Commands
 */
import { Command } from 'commander';
import { CliState, GlobalOptions } from '../index';
import { printOutput, formatSuccess, formatError } from '../utils/output';

export function registerTrialCommands(
  program: Command,
  createHandler: (action: (state: CliState, ...args: unknown[]) => Promise<void> | void) => (...commanderArgs: unknown[]) => Promise<void>
): void {
  const trial = program.command('trial').description('Trial operations');

  trial.command('create').description('Create a trial').requiredOption('--candidate-a <id>', 'Candidate A ID').requiredOption('--candidate-b <id>', 'Candidate B ID').requiredOption('--spec <id>', 'Spec ID').option('--decided-by <id>', 'Decided by actor ID').option('--actor <id>', 'Actor ID to act as (default: BEEHIVE_ACTOR, then config defaultActor)').action(createHandler(async (state, ..._args) => {
    const opts = _args[0] as { candidateA: string; candidateB: string; spec: string; decidedBy?: string; actor?: string };
    const result = await state.client.createTrial({
      candidateAId: opts.candidateA,
      candidateBId: opts.candidateB,
      specId: opts.spec,
      decidedBy: opts.decidedBy,
    }, { actorId: opts.actor });
    printOutput(result, { format: state.outputFormat, pretty: true });
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

  trial.command('decide <trial-id> <winner-id>').description('Decide trial').option('--comparison-metrics <json>', 'Comparison metrics as JSON string (default: {})').option('--decided-by <id>', 'Actor ID who decided').option('--actor <id>', 'Actor ID to act as (default: BEEHIVE_ACTOR, then config defaultActor)').action(createHandler(async (state, ..._args) => {
    const trialId = _args[0] as string;
    const winnerId = _args[1] as string;
    const opts = _args[2] as { comparisonMetrics?: string; decidedBy?: string; actor?: string } || {};
    
    let comparisonMetrics: Record<string, unknown> = {};
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
    }, { actorId: opts.actor });
    printOutput(result, { format: state.outputFormat, pretty: true });
  }));
}
