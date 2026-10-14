/**
 * Debug Commands
 * Debugging utilities for e2e testing and troubleshooting
 */

import { Command } from 'commander';
import { CliState, GlobalOptions } from '../index';
import { printOutput, formatSuccess, formatError, formatInfo, ProgressSpinner, writeError, formatWarning } from '../utils/output';
import { EntityType, OrganizationResponse, ActorResponse, RepositoryResponse, SpecResponse, CandidateResponse, GateVerdictResponse, TrialResponse, PromotionResponse, IssueResponse } from '../types/api';
import { writeFileSync } from 'node:fs';

// ============================================================================
// COMMAND ACTIONS
// ============================================================================

/**
 * State dump - get full Spec DO state
 */
async function actionStateDump(state: CliState, ..._args: unknown[]): Promise<void> {
  try {
    const args = _args as [{ output?: string; entities?: string; all?: boolean }];
    const opts = args[0] || {};
    
    const spinner = ProgressSpinner.create(!!state.verbose);
    if (!state.verbose) {
      spinner.start('Dumping state from Spec DO');
    }

    // Try to get state dump via API first
    try {
      // Note: This endpoint needs to be added to the API worker
      // For now, we'll fetch entities individually
    } catch {
      // Fall through to individual fetching
    }

    // Individual entity fetching
    if (!state.verbose) {
      spinner.update('Fetching organizations');
    }
    
    const [organizations, actors, repositories, specs, candidates, gateVerdicts, trials, promotions, issues] = await Promise.allSettled([
      state.client.listOrganizations(1000, 0).then(r => r.data).catch(() => []),
      state.client.listActors(1000, 0).then(r => r.data).catch(() => []),
      state.client.listRepositories(1000, 0).then(r => r.data).catch(() => []),
      state.client.listSpecs(1000, 0).then(r => r.data).catch(() => []),
      state.client.listCandidates(1000, 0).then(r => r.data).catch(() => []),
      state.client.listGateVerdicts(1000, 0).then(r => r.data).catch(() => []),
      state.client.listTrials(1000, 0).then(r => r.data).catch(() => []),
      state.client.listPromotions(1000, 0).then(r => r.data).catch(() => []),
      state.client.listIssues(1000, 0).then(r => r.data).catch(() => []),
    ]);

    if (!state.verbose) {
      spinner.stop();
    }

    const dump: Record<string, unknown> = {
      timestamp: Date.now(),
    };

    const entityMap: Record<string, string> = {
      organization: 'organizations',
      actor: 'actors',
      repository: 'repositories',
      spec: 'specs',
      candidate: 'candidates',
      gate_verdict: 'gateVerdicts',
      trial: 'trials',
      promotion: 'promotions',
      issue: 'issues',
    };

    // Filter by entities if specified
    const requestedEntities = opts.entities ? opts.entities.split(',') : null;

    for (const [key, prop] of Object.entries(entityMap)) {
      if (requestedEntities && !requestedEntities.includes(key) && !opts.all) {
        continue;
      }
      const data = (eval(prop) as PromiseSettledResult<unknown[]>);
      if (data.status === 'fulfilled') {
        dump[prop] = data.value as unknown[];
      } else {
        dump[prop] = [];
        if (state.verbose) {
          writeError(`Failed to fetch ${prop}: ${data.reason}`);
        }
      }
    }

    if (opts.output) {
      writeFileSync(opts.output, JSON.stringify(dump, null, 2));
      console.log(formatSuccess(`State dumped to: ${opts.output}`));
    } else {
      printOutput(dump, { format: state.outputFormat, pretty: true });
    }

    // Print summary
    if (state.outputFormat === 'json') {
      console.log('');
    }
    console.log(formatInfo(`
Summary:
  Organizations:  ${(dump.organizations as unknown[] | undefined)?.length || 0}
  Actors:        ${(dump.actors as unknown[] | undefined)?.length || 0}
  Repositories:  ${(dump.repositories as unknown[] | undefined)?.length || 0}
  Specs:         ${(dump.specs as unknown[] | undefined)?.length || 0}
  Candidates:    ${(dump.candidates as unknown[] | undefined)?.length || 0}
  Gate Verdicts: ${(dump.gateVerdicts as unknown[] | undefined)?.length || 0}
  Trials:        ${(dump.trials as unknown[] | undefined)?.length || 0}
  Promotions:    ${(dump.promotions as unknown[] | undefined)?.length || 0}
  Issues:        ${(dump.issues as unknown[] | undefined)?.length || 0}`));
  } catch (error) {
    console.error(formatError('Failed to dump state'));
    process.exit(1);
  }
}

/**
 * Verify queues
 */
async function actionVerifyQueues(state: CliState, ..._args: unknown[]): Promise<void> {
  try {
    console.log(formatInfo('Verifying queue configuration...'));
    console.log('');

    // Try to list repositories as a proxy for queue check
    try {
      const repos = await state.client.listRepositories(100, 0);
      console.log(formatSuccess(`Found ${repos.data.length} repository(ies)`));
      
      // Check for candidate repos
      const candidateRepos = repos.data.filter(r => r.repoType === 'candidate');
      console.log(`  Candidate repos: ${candidateRepos.length}`);
    } catch (error) {
      console.log(formatWarning('Could not list repositories'));
    }

    console.log('');
    console.log(formatInfo('Note: Full queue verification requires API support'));
  } catch (error) {
    console.error(formatError('Failed to verify queues'));
    process.exit(1);
  }
}

/**
 * Verify Artifacts integration
 */
async function actionVerifyArtifacts(state: CliState, ..._args: unknown[]): Promise<void> {
  try {
    const args = _args as [{ listRepos?: boolean }];
    const opts = args[0] || {};
    
    const spinner = ProgressSpinner.create(!!state.verbose);
    if (!state.verbose) {
      spinner.start('Verifying Artifacts integration');
    }

    try {
      const repos = await state.client.listRepositories(1000, 0);
      
      if (!state.verbose) {
        spinner.stop();
      }
      
      console.log(formatSuccess(`Found ${repos.data.length} repository(ies)`));
      
      if (opts.listRepos) {
        console.log('');
        console.log('Repositories:');
        for (const repo of repos.data) {
          console.log(`  - ${repo.name} (${repo.id})`);
          console.log(`    Type: ${repo.repoType}`);
          console.log(`    URL: ${repo.remoteUrl}`);
        }
      }
    } catch {
      if (!state.verbose) {
        spinner.stop();
      }
      console.log(formatWarning('Could not verify Artifacts integration'));
      console.log('  This may be expected if Artifacts is not configured');
    }
  } catch (error) {
    console.error(formatError('Artifacts verification failed'));
    process.exit(1);
  }
}

/**
 * Test claim workflow
 */
async function actionTestClaim(state: CliState, ..._args: unknown[]): Promise<void> {
  try {
    const args = _args as [{ specId?: string; actorId?: string; dryRun?: boolean }];
    const opts = args[0] || {};
    
    if (!opts.specId) {
      console.error(formatError('Spec ID is required'));
      process.exit(1);
    }

    const spinner = ProgressSpinner.create(!!state.verbose);
    if (!state.verbose) {
      spinner.start('Testing claim workflow');
    }

    const spec = await state.client.getSpec(opts.specId);
    
    if (!state.verbose) {
      spinner.update(`Testing claim for spec: ${spec.name}`);
    }

    if (opts.dryRun) {
      if (!state.verbose) {
        spinner.stop();
      }
      console.log(formatSuccess('Dry run - claim workflow would execute'));
      console.log(`  Spec: ${spec.name} (${opts.specId})`);
      console.log(`  Organization: ${spec.organizationId}`);
      console.log(`  Stage: ${spec.stage}`);
      console.log('');
      console.log(formatInfo('No actual claim was made (dry run mode)'));
      return;
    }

    // Use regular claim flow
    const claim = await state.client.claimSpec(opts.specId, { specId: opts.specId }, { actorId: opts.actorId || state.config.defaultActor });
    
    if (!state.verbose) {
      spinner.stop();
    }

    console.log(formatSuccess('Claim workflow test completed'));
    console.log('');
    console.log(`  Candidate ID: ${claim.candidateId}`);
    console.log(`  Repository: ${claim.repositoryName || claim.repositoryId}`);
    console.log(`  URL: ${claim.repositoryUrl}`);
  } catch (error) {
    console.error(formatError('Claim workflow test failed'));
    process.exit(1);
  }
}

/**
 * Verify promotion train integrity
 */
async function actionVerifyTrain(state: CliState, ..._args: unknown[]): Promise<void> {
  try {
    const args = _args as [{ specId?: string }];
    const opts = args[0] || {};
    
    if (!opts.specId) {
      console.error(formatError('Spec ID is required'));
      process.exit(1);
    }

    const spinner = ProgressSpinner.create(!!state.verbose);
    if (!state.verbose) {
      spinner.start('Verifying promotion train');
    }

    const spec = await state.client.getSpec(opts.specId);
    const candidates = await state.client.listCandidates(1000, 0, opts.specId);
    const promotions = await state.client.listPromotions(1000, 0);
    
    if (!state.verbose) {
      spinner.stop();
    }

    console.log(formatSuccess(`Promotion Train Verification for Spec: ${spec.name}`));
    console.log('');
    console.log(`  Spec ID: ${opts.specId}`);
    console.log(`  Spec Stage: ${spec.stage}`);
    console.log(`  Candidates: ${candidates.data.length}`);
    console.log(`  Promotions: ${promotions.data.length}`);
    console.log('');

    // Group candidates by stage
    const stages: Record<string, typeof candidates.data> = {};
    for (const candidate of candidates.data) {
      if (!stages[candidate.stage]) {
        stages[candidate.stage] = [];
      }
      stages[candidate.stage].push(candidate);
    }

    console.log('  Candidates by Stage:');
    for (const [stage, stageCandidates] of Object.entries(stages)) {
      console.log(`    ${stage}: ${stageCandidates.length}`);
    }
  } catch (error) {
    console.error(formatError('Failed to verify promotion train'));
    process.exit(1);
  }
}

/**
 * Dump entities of a specific type
 */
async function actionDump(state: CliState, ..._args: unknown[]): Promise<void> {
  try {
    const args = _args as [{ entityType?: string; limit?: number; output?: string }];
    const opts = args[0] || {};
    
    const entityType = opts.entityType as EntityType || 'candidate';
    const limit = opts.limit || 1000;
    const output = opts.output;
    
    const spinner = ProgressSpinner.create(!!state.verbose);
    if (!state.verbose) {
      spinner.start(`Fetching ${entityType}s`);
    }

    let data: unknown[];
    
    const fetchers: Record<string, () => Promise<{ data: unknown[] }>> = {
      organization: () => state.client.listOrganizations(limit, 0),
      actor: () => state.client.listActors(limit, 0),
      repository: () => state.client.listRepositories(limit, 0),
      spec: () => state.client.listSpecs(limit, 0),
      candidate: () => state.client.listCandidates(limit, 0),
      gate_verdict: () => state.client.listGateVerdicts(limit, 0),
      trial: () => state.client.listTrials(limit, 0),
      promotion: () => state.client.listPromotions(limit, 0),
      issue: () => state.client.listIssues(limit, 0),
    };

    const fetcher = fetchers[entityType];
    if (!fetcher) {
      console.error(formatError(`Unknown entity type: ${entityType}`));
      process.exit(1);
    }

    const response = await fetcher();
    data = response.data;

    if (!state.verbose) {
      spinner.stop();
    }

    if (output) {
      writeFileSync(output, JSON.stringify(data, null, 2));
      console.log(formatSuccess(`Dumped ${data.length} ${entityType}(s) to: ${output}`));
    } else {
      printOutput(data, { format: state.outputFormat, pretty: true });
    }
  } catch (error) {
    const opts = _args[0] as { entityType?: string } || {};
    console.error(formatError(`Failed to dump ${opts.entityType || 'entities'}`));
    process.exit(1);
  }
}

/**
 * Compare two candidates
 */
async function actionCompare(state: CliState, ..._args: unknown[]): Promise<void> {
  try {
    const args = _args as [{ candidateAId?: string; candidateBId?: string; deep?: boolean }];
    const opts = args[0] || {};
    
    if (!opts.candidateAId || !opts.candidateBId) {
      console.error(formatError('Both candidate A and B IDs are required'));
      process.exit(1);
    }

    const spinner = ProgressSpinner.create(!!state.verbose);
    if (!state.verbose) {
      spinner.start('Fetching candidates');
    }

    const [candidateA, candidateB] = await Promise.all([
      state.client.getCandidate(opts.candidateAId),
      state.client.getCandidate(opts.candidateBId),
    ]);

    const [verdictsA, verdictsB] = await Promise.all([
      state.client.getGateVerdictsForCandidate(opts.candidateAId),
      state.client.getGateVerdictsForCandidate(opts.candidateBId),
    ]);

    if (!state.verbose) {
      spinner.stop();
    }

    console.log(formatSuccess(`Comparing Candidates: ${opts.candidateAId} vs ${opts.candidateBId}`));
    console.log('');
    console.log(`  A - Spec: ${candidateA.specId}, Stage: ${candidateA.stage}`);
    console.log(`  B - Spec: ${candidateB.specId}, Stage: ${candidateB.stage}`);
    console.log('');

    const gates = ['pre-merge', 'shadow', 'train', 'canary', 'full'] as const;
    
    for (const gate of gates) {
      const verdictA = verdictsA.find(v => v.gate === gate);
      const verdictB = verdictsB.find(v => v.gate === gate);
      
      const statusA = verdictA ? `${verdictA.status} (${verdictA.score})` : 'N/A';
      const statusB = verdictB ? `${verdictB.status} (${verdictB.score})` : 'N/A';
      
      const match = statusA === statusB;
      console.log(`  ${gate}: ${statusA} vs ${statusB} ${match ? '✓' : '✗'}`);
    }
  } catch (error) {
    console.error(formatError('Failed to compare candidates'));
    process.exit(1);
  }
}

/**
 * Tail worker logs
 */
async function actionTail(state: CliState, ..._args: unknown[]): Promise<void> {
  console.log(formatWarning('Tail command requires wrangler. Use: wrangler tail'));
  console.log('');
  console.log('To install wrangler: npm install -g wrangler');
}

/**
 * Check API connectivity
 */
async function actionCheckApi(state: CliState, ..._args: unknown[]): Promise<void> {
  try {
    const spinner = ProgressSpinner.create(!!state.verbose);
    if (!state.verbose) {
      spinner.start('Checking API connectivity');
    }

    const checks = {
      health: async () => state.client.getHealth(),
      organizations: async () => state.client.listOrganizations(1, 0),
      actors: async () => state.client.listActors(1, 0),
      specs: async () => state.client.listSpecs(1, 0),
      candidates: async () => state.client.listCandidates(1, 0),
      repositories: async () => state.client.listRepositories(1, 0),
    };

    const results: Record<string, { status: string; latency: number; error?: string }> = {};

    for (const [name, check] of Object.entries(checks)) {
      const start = Date.now();
      try {
        await check();
        results[name] = { status: 'ok', latency: Date.now() - start };
      } catch (error) {
        results[name] = { status: 'error', latency: Date.now() - start, error: String(error) };
      }
    }

    if (!state.verbose) {
      spinner.stop();
    }

    console.log(formatSuccess('API Connectivity Check'));
    console.log('');
    
    let allOk = true;
    for (const [name, result] of Object.entries(results)) {
      const icon = result.status === 'ok' ? '✓' : '✗';
      console.log(`  ${icon} ${name.padEnd(15)} ${result.latency}ms`);
      if (result.status === 'error' && state.verbose) {
        console.log(`     Error: ${result.error}`);
      }
      if (result.status !== 'ok') allOk = false;
    }

    console.log('');
    if (allOk) {
      console.log(formatSuccess('All API endpoints are reachable'));
    } else {
      console.log(formatWarning('Some API endpoints failed'));
    }
  } catch (error) {
    console.error(formatError('API connectivity check failed'));
    process.exit(1);
  }
}

/**
 * List all specs with their stages - useful for seeing the pipeline
 */
async function actionListSpecsStages(state: CliState, ..._args: unknown[]): Promise<void> {
  try {
    const args = _args as [{ all?: boolean; limit?: number }];
    const opts = args[0] || {};
    
    const spinner = ProgressSpinner.create(!!state.verbose);
    if (!state.verbose) {
      spinner.start('Fetching specs');
    }

    const limit = opts.all ? 10000 : (opts.limit || 100);
    const specs = await state.client.listSpecs(limit, 0);

    if (!state.verbose) {
      spinner.stop();
    }

    console.log(formatSuccess(`Specs Pipeline Overview (${specs.data.length} total)`));
    console.log('');

    // Group by stage
    const stages: Record<string, { specs: { name: string; id: string; stage: string }[]; count: number }> = {};
    
    for (const spec of specs.data) {
      if (!stages[spec.stage]) {
        stages[spec.stage] = { specs: [], count: 0 };
      }
      stages[spec.stage].specs.push({ name: spec.name, id: spec.id, stage: spec.stage });
      stages[spec.stage].count++;
    }

    // Sort stages by order
    const stageOrder = ['draft', 'proposed', 'open', 'closed', 'rejected', 'done'];
    const sortedStages = Object.entries(stages).sort(([a], [b]) => {
      const aIndex = stageOrder.indexOf(a);
      const bIndex = stageOrder.indexOf(b);
      if (aIndex === -1 && bIndex === -1) return a.localeCompare(b);
      if (aIndex === -1) return 1;
      if (bIndex === -1) return -1;
      return aIndex - bIndex;
    });

    for (const [stage, { specs, count }] of sortedStages) {
      console.log(`  ${stage.padEnd(15)} ${count.toString().padStart(3)} specs`);
      if (state.verbose || opts.all) {
        for (const spec of specs) {
          console.log(`    - ${spec.name} (${spec.id})`);
        }
      }
    }

    console.log('');
    console.log(formatInfo('Use --verbose or --all to see all spec details'));
  } catch (error) {
    console.error(formatError('Failed to list specs by stage'));
    process.exit(1);
  }
}

/**
 * Check gate workflow status
 */
async function actionGateWorkflowStatus(state: CliState, ..._args: unknown[]): Promise<void> {
  try {
    const args = _args as [{ specId?: string; candidateId?: string }];
    const opts = args[0] || {};
    
    const spinner = ProgressSpinner.create(!!state.verbose);
    if (!state.verbose) {
      spinner.start('Fetching gate workflow status');
    }

    let candidates: CandidateResponse[];
    if (opts.candidateId) {
      const candidate = await state.client.getCandidate(opts.candidateId);
      candidates = [candidate];
    } else if (opts.specId) {
      const result = await state.client.listCandidates(1000, 0, opts.specId);
      candidates = result.data;
    } else {
      const result = await state.client.listCandidates(100, 0);
      candidates = result.data;
    }

    if (!state.verbose) {
      spinner.stop();
    }

    console.log(formatSuccess('Gate Workflow Status'));
    console.log('');

    const gates = ['pre-merge', 'shadow', 'train', 'canary', 'full'] as const;
    
    for (const candidate of candidates) {
      console.log(`Candidate: ${candidate.id} (Spec: ${candidate.specId}, Stage: ${candidate.stage})`);
      
      const verdicts = await state.client.getGateVerdictsForCandidate(candidate.id);
      const verdictMap = Object.fromEntries(verdicts.map(v => [v.gate, v])) as Record<typeof gates[number], GateVerdictResponse | undefined>;

      for (const gate of gates) {
        const verdict = verdictMap[gate];
        const status = verdict ? `${verdict.status} (${verdict.score})` : 'not evaluated';
        const icon = !verdict ? '○' : verdict.status === 'pass' ? '✓' : verdict.status === 'fail' ? '✗' : '~';
        console.log(`  ${icon} ${gate.padEnd(12)} ${status}`);
      }
      console.log('');
    }
  } catch (error) {
    console.error(formatError('Failed to check gate workflow status'));
    process.exit(1);
  }
}

/**
 * Validate configuration
 */
async function actionValidateConfig(state: CliState, ..._args: unknown[]): Promise<void> {
  try {
    console.log(formatSuccess('Configuration Validation'));
    console.log('');

    console.log('  API Configuration:');
    console.log(`    URL: ${state.config.apiUrl}`);
    console.log(`    Token: ${state.config.apiToken ? '*** (set)' : 'NOT SET'}`);
    console.log(`    Timeout: ${state.config.timeout}ms`);
    console.log('');

    console.log('  Client Status:');
    console.log(`    Authenticated: ${state.client.isAuthenticated ? 'Yes' : 'No'}`);
    console.log('');

    if (state.config.apiToken) {
      try {
        await state.client.getHealth();
        console.log(formatSuccess('  ✓ API is reachable'));
      } catch (error) {
        console.log(formatError(`  ✗ API connection failed: ${error}`));
      }
    } else {
      console.log(formatWarning('  ⚠ No API token configured - most commands will fail'));
    }

    console.log('');
    console.log('  CLI Version: ' + '0.1.0');
    console.log('  Node Version: ' + process.version);
  } catch (error) {
    console.error(formatError('Failed to validate configuration'));
    process.exit(1);
  }
}

// ============================================================================
// COMMAND REGISTRATION
// ============================================================================

/**
 * Register debug commands with the CLI
 */
export function registerDebugCommands(
  program: Command,
  createHandler: (
    action: (state: CliState, ...args: unknown[]) => Promise<void> | void
  ) => (opts: GlobalOptions, ...args: unknown[]) => Promise<void>
): void {
  const debug = program.command('debug').description('Debugging utilities for e2e testing');

  debug
    .command('state-dump')
    .description('Dump full Spec DO state')
    .option('-o, --output <file>', 'Output file path')
    .option('-e, --entities <types>', 'Comma-separated list of entity types')
    .option('-a, --all', 'Include all entity types')
    .action(createHandler(actionStateDump));

  debug
    .command('check-api')
    .description('Check API connectivity')
    .action(createHandler(actionCheckApi));

  debug
    .command('list-specs')
    .description('List all specs with their stages')
    .option('-a, --all', 'Show all details')
    .option('-l, --limit <n>', 'Limit number of specs')
    .action(createHandler(actionListSpecsStages));

  debug
    .command('gate-status')
    .description('Check gate workflow status')
    .option('-s, --spec <spec-id>', 'Filter by spec ID')
    .option('-c, --candidate <candidate-id>', 'Filter by candidate ID')
    .action(createHandler(actionGateWorkflowStatus));

  debug
    .command('validate-config')
    .description('Validate CLI configuration')
    .action(createHandler(actionValidateConfig));

  debug
    .command('tail')
    .description('Tail worker logs')
    .option('-w, --worker <worker>', 'Worker to tail')
    .option('-n, --lines <n>', 'Number of lines')
    .option('-f, --follow', 'Follow the log output')
    .option('--filter <pattern>', 'Filter pattern')
    .action(createHandler(actionTail));

  debug
    .command('verify-queues')
    .description('Verify queue configuration')
    .option('--create-test-message', 'Create a test message')
    .option('-q, --queue-name <name>', 'Specific queue name')
    .action(createHandler(actionVerifyQueues));

  debug
    .command('verify-artifacts')
    .description('Verify Artifacts integration')
    .option('-l, --list-repos', 'List all repositories')
    .option('--create-test-fork', 'Create a test fork')
    .option('--fork-from <repo>', 'Repository to fork from')
    .action(createHandler(actionVerifyArtifacts));

  debug
    .command('test-claim')
    .description('Test the claim workflow')
    .argument('<spec-id>', 'Spec ID to claim')
    .option('-a, --actor <actor-id>', 'Actor ID')
    .option('-n, --dry-run', 'Dry run')
    .action(createHandler(actionTestClaim));

  debug
    .command('verify-train')
    .description('Verify promotion train integrity')
    .argument('<spec-id>', 'Spec ID to verify')
    .action(createHandler(actionVerifyTrain));

  debug
    .command('dump')
    .description('Dump entities of a specific type')
    .argument('<entity-type>', 'Entity type')
    .option('-l, --limit <n>', 'Limit')
    .option('-o, --output <file>', 'Output file')
    .action(createHandler(actionDump));

  debug
    .command('compare')
    .description('Compare two candidates')
    .argument('<candidate-a-id>', 'First candidate ID')
    .argument('<candidate-b-id>', 'Second candidate ID')
    .option('-d, --deep', 'Deep comparison')
    .action(createHandler(actionCompare));
}
