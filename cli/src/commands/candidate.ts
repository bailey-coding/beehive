/**
 * Candidate Commands
 */
import { Command } from 'commander';
import { CliState, GlobalOptions } from '../index';
import { printOutput, formatSuccess, formatError } from '../utils/output';

export function registerCandidateCommands(
  program: Command,
  createHandler: (action: (state: CliState, ...args: unknown[]) => Promise<void> | void) => (opts: GlobalOptions, ...args: unknown[]) => Promise<void>
): void {
  const candidate = program.command('candidate').description('Candidate management');

  candidate.command('create').description('Create candidate').action(createHandler(async (state, ..._args) => {
    const args = _args[0] as { spec?: string; repository?: string; commit?: string; baseCommit?: string; agent?: string };
    if (!args.spec || !args.repository || !args.commit || !args.baseCommit) {
      console.error(formatError('Spec, repository, commit, and base-commit are required'));
      process.exit(1);
    }
    const result = await state.client.createCandidate({
      specId: args.spec,
      repositoryId: args.repository,
      commitSha: args.commit,
      baseCommitSha: args.baseCommit,
      agentId: args.agent,
    });
    printOutput(result, { format: state.outputFormat, pretty: true });
  }));

  candidate.command('list').description('List candidates').action(createHandler(async (state) => {
    const response = await state.client.listCandidates(100, 0);
    if (state.outputFormat === 'json') {
      printOutput(response, { format: state.outputFormat, pretty: true });
    } else {
      console.log(formatSuccess(`Found ${response.data.length} candidate(s)`));
    }
  }));

  candidate.command('get <id>').description('Get candidate').action(createHandler(async (state, id) => {
    const c = await state.client.getCandidate(id as string);
    printOutput(c, { format: state.outputFormat, pretty: true });
  }));

  candidate.command('gate-verdicts <id>').description('Get gate verdicts').action(createHandler(async (state, id) => {
    const verdicts = await state.client.getGateVerdictsForCandidate(id as string);
    printOutput(verdicts, { format: state.outputFormat, pretty: true });
  }));
}
