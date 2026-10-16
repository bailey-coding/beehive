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

  issue.command('create <title>').description('Create issue').option('--repository <id>', 'Repository ID', { required: true }).option('--body <text>', 'Issue body').option('--labels <labels>', 'Comma-separated labels').option('--number <num>', 'Issue number', { required: true }).action(createHandler(async (state, ..._args) => {
    const title = _args[0] as string;
    const opts = _args[1] as { repository: string; body?: string; labels?: string; number: number };
    
    const labels = opts.labels ? opts.labels.split(',').map(l => l.trim()) : undefined;
    
    const result = await state.client.createIssue({
      number: opts.number,
      repositoryId: opts.repository,
      title,
      body: opts.body,
      labels,
    });
    printOutput(result, { format: state.outputFormat, pretty: true });
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
