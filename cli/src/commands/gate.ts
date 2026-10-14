/**
 * Gate Commands
 */
import { Command } from 'commander';
import { CliState, GlobalOptions } from '../index';
import { printOutput, formatSuccess, formatError } from '../utils/output';

export function registerGateCommands(
  program: Command,
  createHandler: (action: (state: CliState, ...args: unknown[]) => Promise<void> | void) => (opts: GlobalOptions, ...args: unknown[]) => Promise<void>
): void {
  const gate = program.command('gate').description('Gate workflow operations');

  gate.command('run <candidate-id>').description('Run gate for candidate').action(createHandler(async (state, ..._args) => {
    const candidateId = _args[0] as string;
    const opts = _args[1] as { gate?: string } || {};
    const gateType = opts.gate || 'pre-merge';
    
    const result = await state.client.runPreMergeGate(candidateId);
    printOutput(result, { format: state.outputFormat, pretty: true });
  }));

  gate.command('list').description('List gate verdicts').action(createHandler(async (state) => {
    const response = await state.client.listGateVerdicts(100, 0);
    if (state.outputFormat === 'json') {
      printOutput(response, { format: state.outputFormat, pretty: true });
    } else {
      console.log(formatSuccess(`Found ${response.data.length} gate verdict(s)`));
    }
  }));

  gate.command('get <id>').description('Get gate verdict').action(createHandler(async (state, id) => {
    const v = await state.client.getGateVerdict(id as string);
    printOutput(v, { format: state.outputFormat, pretty: true });
  }));
}
