/**
 * Issue Commands
 */
import { Command } from 'commander';
import { CliState, GlobalOptions } from '../index';
import { printOutput, formatSuccess, formatError } from '../utils/output';

export function registerIssueCommands(
  program: Command,
  createHandler: (action: (state: CliState, ...args: unknown[]) => Promise<void> | void) => (opts: GlobalOptions, ...args: unknown[]) => Promise<void>
): void {
  const issue = program.command('issue').description('Issue management');

  issue.command('create <title>').description('Create issue').action(createHandler(async (state, ..._args) => {
    const title = _args[0] as string;
    const args = _args[1] as { repository?: string };
    if (!args.repository) {
      console.error(formatError('Repository ID is required'));
      process.exit(1);
    }
    console.log(formatError('Issue creation not fully implemented'));
  }));

  issue.command('list').description('List issues').action(createHandler(async (state) => {
    const response = await state.client.listIssues(100, 0);
    if (state.outputFormat === 'json') {
      printOutput(response, { format: state.outputFormat, pretty: true });
    } else {
      console.log(formatSuccess(`Found ${response.data.length} issue(s)`));
    }
  }));

  issue.command('get <id>').description('Get issue').action(createHandler(async (state, id) => {
    const i = await state.client.getIssue(id as string);
    printOutput(i, { format: state.outputFormat, pretty: true });
  }));
}
