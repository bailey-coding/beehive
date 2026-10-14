/**
 * Repository Commands
 */
import { Command } from 'commander';
import { CliState, GlobalOptions } from '../index';
import { printOutput, formatSuccess, formatError } from '../utils/output';

export function registerRepoCommands(
  program: Command,
  createHandler: (action: (state: CliState, ...args: unknown[]) => Promise<void> | void) => (opts: GlobalOptions, ...args: unknown[]) => Promise<void>
): void {
  const repo = program.command('repo').description('Repository management');
  repo.command('create <name>').description('Create a new repository').action(createHandler(async (state, ..._args) => {
    const args = _args as [{ remoteUrl?: string; namespace?: string; organization?: string; type?: string }];
    if (!args[0]?.remoteUrl || !args[0]?.namespace) {
      console.error(formatError('Remote URL and namespace are required'));
      process.exit(1);
    }
    console.log(formatError('Repository creation not fully implemented'));
  }));

  repo.command('list').description('List repositories').action(createHandler(async (state) => {
    const response = await state.client.listRepositories(100, 0);
    if (state.outputFormat === 'json') {
      printOutput(response, { format: state.outputFormat, pretty: true });
    } else {
      console.log(formatSuccess(`Found ${response.data.length} repository(ies)`));
    }
  }));

  repo.command('get <id>').description('Get repository').action(createHandler(async (state, id) => {
    const repo = await state.client.getRepository(id as string);
    printOutput(repo, { format: state.outputFormat, pretty: true });
  }));
}
