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
  repo.command('create <name>').description('Create a new repository').requiredOption('--organization <id>', 'Organization ID').requiredOption('--remote-url <url>', 'Remote URL').requiredOption('--namespace <ns>', 'Namespace').requiredOption('--type <type>', 'Repository type (baseline|candidate)').option('--spec <id>', 'Spec ID').option('--agent <id>', 'Agent ID').option('--default-branch <branch>', 'Default branch').action(createHandler(async (state, ..._args) => {
    const name = _args[0] as string;
    const opts = _args[1] as { organization: string; remoteUrl: string; namespace: string; type: 'baseline' | 'candidate'; spec?: string; agent?: string; defaultBranch?: string };
    const result = await state.client.createRepository({
      name,
      organizationId: opts.organization,
      repoType: opts.type,
      specId: opts.spec,
      agentId: opts.agent,
      remoteUrl: opts.remoteUrl,
      namespace: opts.namespace,
      defaultBranch: opts.defaultBranch,
    });
    printOutput(result, { format: state.outputFormat, pretty: true });
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
