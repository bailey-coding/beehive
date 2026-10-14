/**
 * Health Commands
 * System health checks and diagnostics
 */

import { Command } from 'commander';
import { CliState, GlobalOptions } from '../index';
import { printOutput, formatSuccess, formatError } from '../utils/output';
import { HealthResponse } from '../types/api';

// ============================================================================
// COMMAND ACTIONS
// ============================================================================

/**
 * Basic health check
 */
async function actionHealth(state: CliState, ..._args: unknown[]): Promise<void> {
  try {
    const args = _args as [{ extended?: boolean }];
    const opts = args[0] || {};
    
    let health: HealthResponse;
    if (opts.extended) {
      health = await state.client.getHealthExtended();
    } else {
      health = await state.client.getHealth();
    }

    if (state.outputFormat === 'json') {
      printOutput(health, { format: state.outputFormat, pretty: true });
      return;
    }

    console.log(formatSuccess('System is healthy'));
    console.log('');
    console.log(`  Version:    ${health.version}`);
    console.log(`  Timestamp:  ${new Date(health.timestamp).toISOString()}`);
    console.log(`  Status:     ${health.status}`);
    console.log('');
    console.log('  Component Checks:');
    
    for (const [component, status] of Object.entries(health.checks)) {
      const icon = status === 'ok' ? '✓' : '✗';
      console.log(`    ${icon} ${component}: ${status}`);
    }
  } catch (error) {
    console.error(formatError('Health check failed'));
    process.exit(1);
  }
}

/**
 * Version command
 */
async function actionVersion(state: CliState, ..._args: unknown[]): Promise<void> {
  try {
    const health = await state.client.getHealth();
    console.log(health.version);
  } catch (error) {
    console.error(formatError('Failed to get version'));
    process.exit(1);
  }
}

/**
 * Check specific worker health
 */
async function actionCheckWorker(state: CliState, ..._args: unknown[]): Promise<void> {
  try {
    const args = _args as [{ workers?: string }];
    const opts = args[0] || {};
    const workers = (opts.workers || 'api').split(',').map(w => w.trim());
    
    console.log('Worker Health Checks:');
    console.log('');

    for (const worker of workers) {
      try {
        const health = await state.client.getHealth();
        console.log(`  ${worker}: ${health.status}`);
      } catch {
        console.log(`  ${worker}: error`);
      }
    }
  } catch (error) {
    console.error(formatError('Failed to check workers'));
    process.exit(1);
  }
}

// ============================================================================
// COMMAND REGISTRATION
// ============================================================================

/**
 * Register health commands with the CLI
 */
export function registerHealthCommands(
  program: Command,
  createHandler: (
    action: (state: CliState, ...args: unknown[]) => Promise<void> | void
  ) => (opts: GlobalOptions, ...args: unknown[]) => Promise<void>
): void {
  const health = program.command('health').description('Health check and diagnostics');

  health
    .command('check')
    .description('Check system health')
    .option('-e, --extended', 'Extended health check')
    .action(createHandler(actionHealth));

  health
    .command('extended')
    .description('Extended health check')
    .action(createHandler(actionHealth));

  health
    .command('version')
    .description('Show system version')
    .action(createHandler(actionVersion));

  health
    .command('workers')
    .description('Check specific worker health')
    .option('-w, --workers <workers>', 'Comma-separated list of workers')
    .action(createHandler(actionCheckWorker));

  health.action(createHandler(actionHealth));
}
