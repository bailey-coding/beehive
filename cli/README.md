# Beehive CLI

**Version:** 0.1.0  
**Status:** Development  
**Part of:** Beehive Platform

---

## Overview

The Beehive CLI provides a command-line interface for interacting with the Beehive platform. It wraps the REST API to provide a developer-friendly way to manage entities, trigger workflows, and debug the system.

## Installation

### Prerequisites

- Node.js >= 22.0.0
- npm >= 10.0.0
- Beehive API running and accessible

### Install from source

```bash
# Navigate to the CLI directory
cd cli

# Install dependencies
npm install

# Build the CLI
npm run build

# Link globally (optional)
npm link
```

### Using npm link

```bash
# From the project root
npm link cli

# Then you can run beehive from anywhere
beehive --version
```

## Quick Start

### Authentication

Set your API token via environment variable:

```bash
export BEEHIVE_API_TOKEN=your-api-token-here

# Or use the auth command
beehive auth login --token your-api-token-here
```

### Basic Commands

```bash
# Check system health
beehive health

# List organizations
beehive org list

# List specs
beehive spec list

# List candidates
beehive candidate list

# Get help
beehive --help
beehive spec --help
```

## Command Reference

### Global Options

```
beehive [options] <command> [command-options] [args]

Options:
  --version, -v       Show version
  --help, -h          Show help
  --config <path>     Path to config file (default: ~/.beehive/config)
  --token <token>     API authentication token
  --url <url>         API base URL (default: https://beehive.bz23711.workers.dev)
  -f, --format <fmt>  Output format: json, table, yaml, compact (default: json)
  --pretty            Pretty-print JSON output
  -v, --verbose       Verbose output
  -n, --dry-run       Dry run (no changes)
```

### Commands

| Command | Description |
|---------|-------------|
| `auth` | Authentication management |
| `org` | Organization management |
| `actor` | Actor (human/agent) management |
| `repo` | Repository management |
| `spec` | Spec management |
| `candidate` | Candidate management |
| `gate` | Gate workflow operations |
| `trial` | Trial operations |
| `promotion` | Promotion operations |
| `issue` | Issue management |
| `history` | Entity history |
| `health` | Health check and diagnostics |
| `debug` | Debugging utilities |

### Examples

#### Authentication

```bash
# Login with token
beehive auth login --token $API_TOKEN

# Interactive login
beehive auth login --interactive

# Check status
beehive auth status

# Test connection
beehive auth test

# Logout
beehive auth logout
```

#### Organizations

```bash
# Create organization
beehive org create "My Org" --type github

# List organizations
beehive org list

# Get organization details
beehive org get org-abc123
```

#### Actors

```bash
# Create human actor
beehive actor create "John Doe" --type human --github-user-id 12345

# Create agent
beehive actor create "Agent Smith" --type agent

# List actors
beehive actor list

# Update trust score
beehive actor trust actor-xyz 85

# Grant promotion authority
beehive actor grant-promotion actor-xyz
```

#### Repositories

```bash
# Create candidate repository
beehive repo create my-candidate \
  --remote-url https://github.com/org/repo.git \
  --namespace my-namespace \
  --type candidate

# List repositories
beehive repo list

# Get repository
beehive repo get repo-abc123
```

#### Specs

```bash
# Create spec
beehive spec create "My API" \
  --organization org-abc123 \
  --contract '{"type":"object","properties":{"name":{"type":"string"}}}' \
  --declared-delta-surface POST:/api/users,GET:/api/users

# Or load contract from file
beehive spec create "My API" \
  --organization org-abc123 \
  --contract-file ./contract.json \
  --declared-delta-surface POST:/api/users,GET:/api/users

# List specs
beehive spec list

# Get spec
beehive spec get spec-abc123

# Update spec stage
beehive spec stage spec-abc123 proposed

# Claim spec (creates candidate)
beehive spec claim spec-abc123 --actor agent-xyz
```

#### Candidates

```bash
# Create candidate
beehive candidate create \
  --spec spec-abc123 \
  --repository repo-xyz \
  --commit abc123 \
  --base-commit def456

# List candidates
beehive candidate list --spec spec-abc123

# Get candidate
beehive candidate get candidate-abc123

# Update stage
beehive candidate stage candidate-abc123 passed_premerge

# Execute in sandbox
beehive candidate execute candidate-abc123

# Get gate verdicts
beehive candidate gate-verdicts candidate-abc123
```

#### Gates

```bash
# Run pre-merge gate
beehive gate run candidate-abc123 --gate pre-merge

# List gate verdicts
beehive gate list --candidate candidate-abc123

# Get verdict
beehive gate get verdict-abc123

# Create manual verdict
beehive gate create candidate-abc123 \
  --gate pre-merge \
  --status pass \
  --score 95 \
  --complexity-delta 0.5
```

#### Trials

```bash
# Create trial
beehive trial create \
  --candidate-a candidate-abc123 \
  --candidate-b candidate-def456 \
  --spec spec-abc123

# List trials
beehive trial list --spec spec-abc123

# Get trial
beehive trial get trial-abc123

# Decide trial
beehive trial decide trial-abc123 candidate-abc123 --notes "Candidate A performed better"
```

#### Promotions

```bash
# Create promotion
beehive promotion create candidate-abc123 --notes "Ready for production"

# List promotions
beehive promotion list

# Get promotion
beehive promotion get promotion-abc123
```

#### Issues

```bash
# Create issue
beehive issue create "Fix bug in user creation" \
  --repository repo-abc123 \
  --description "Users cannot be created with special characters" \
  --change-type behavior-change \
  --complexity-estimate 50

# List issues
beehive issue list --repository repo-abc123

# Get issue
beehive issue get issue-abc123
```

#### History

```bash
# Get entity history
beehive history get spec spec-abc123

# Shortcut
beehive history spec spec-abc123
```

#### Health Checks

```bash
# Basic health check
beehive health

# Extended health check
beehive health --extended

# Check specific workers
beehive health workers --workers api,gate,sandbox

# Show version
beehive health version
```

## Debug Commands

These commands are specifically useful for e2e debugging:

### State Dump

```bash
# Dump full Spec DO state
beehive debug state-dump

# Save to file
beehive debug state-dump --output state.json

# Dump specific entity types only
beehive debug state-dump --entities spec,candidate,gate_verdict

# Dump all with summary
beehive debug state-dump --all
```

### Queue Verification

```bash
# Verify queue configuration
beehive debug verify-queues

# Create test message
beehive debug verify-queues --create-test-message

# Check specific queue
beehive debug verify-queues --queue-name beehive-artifacts-push
```

### Artifacts Verification

```bash
# Verify Artifacts integration
beehive debug verify-artifacts

# List repositories
beehive debug verify-artifacts --list-repos
```

### Claim Workflow Test

```bash
# Test claim workflow
beehive debug test-claim spec-abc123

# Dry run (no actual claim)
beehive debug test-claim spec-abc123 --dry-run

# With specific actor
beehive debug test-claim spec-abc123 --actor agent-xyz
```

### Train Verification

```bash
# Verify promotion train
beehive debug verify-train spec-abc123

# Verbose output
beehive debug verify-train spec-abc123 --verbose
```

### Dump Entities

```bash
# Dump all specs
beehive debug dump spec

# With limit
beehive debug dump candidate --limit 100

# Save to file
beehive debug dump spec --output specs.json
```

### Compare Candidates

```bash
# Compare two candidates
beehive debug compare candidate-abc123 candidate-def456

# Deep comparison
beehive debug compare candidate-abc123 candidate-def456 --deep
```

### Tail Logs

```bash
# Tail API worker logs
beehive debug tail --worker api --lines 50

# Follow logs
beehive debug tail --worker gate --follow

# Filter logs
beehive debug tail --worker all --filter "error"
```

## Configuration

### Config File

The CLI uses a configuration file at `~/.beehive/config.json`:

```json
{
  "apiUrl": "https://beehive.bz23711.workers.dev",
  "apiToken": "your-api-token",
  "defaultOrganization": "org-abc123",
  "defaultActor": "actor-xyz",
  "outputFormat": "json",
  "verbose": false,
  "timeout": 30000
}
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `BEEHIVE_API_TOKEN` | API authentication token | - |
| `BEEHIVE_API_URL` | API base URL | `https://beehive.bz23711.workers.dev` |
| `BEEHIVE_CONFIG` | Path to config file | `~/.beehive/config.json` |
| `BEEHIVE_VERBOSE` | Enable verbose output | `false` |

### Command-line Overrides

Command-line options override environment variables, which override config file settings.

## Output Formatting

### JSON (default)

```bash
beehive spec list
# Outputs JSON array of specs
```

### Table

```bash
beehive spec list --format table
# Outputs formatted table
```

### Compact

```bash
beehive spec list --format compact
# Outputs minified JSON
```

### Pretty JSON

```bash
beehive spec list --pretty
# Outputs pretty-printed JSON
```

## Development

### Project Structure

```
cli/
├── src/
│   ├── commands/         # Command implementations
│   │   ├── auth.ts
│   │   ├── org.ts
│   │   ├── actor.ts
│   │   ├── repo.ts
│   │   ├── spec.ts
│   │   ├── candidate.ts
│   │   ├── gate.ts
│   │   ├── trial.ts
│   │   ├── promotion.ts
│   │   ├── issue.ts
│   │   ├── history.ts
│   │   ├── health.ts
│   │   └── debug.ts
│   ├── utils/            # Utility functions
│   │   ├── api-client.ts # API client
│   │   ├── config.ts     # Configuration
│   │   └── output.ts     # Output formatting
│   ├── types/            # TypeScript types
│   │   ├── api.ts        # API types
│   │   └── config.ts     # CLI types
│   └── index.ts          # CLI entry point
├── bin/
│   └── beehive           # Executable
├── package.json
├── tsconfig.json
└── README.md
```

### Scripts

```bash
# Build
npm run build

# Run in development mode (with hot reload)
npm run dev

# Type checking
npm run typecheck

# Linting
npm run lint

# Test
npm run test
```

### Adding New Commands

1. Create a new file in `src/commands/` (e.g., `my-command.ts`)
2. Implement command actions
3. Export a `registerMyCommandCommands` function
4. Import and register in `src/index.ts`

Example:

```typescript
// src/commands/my-command.ts
import { Command } from 'commander';
import { CliState, GlobalOptions } from '../index';
import { printOutput } from '../utils/output';

async function actionDoSomething(state: CliState, opts: MyOptions): Promise<void> {
  // Implementation
}

export function registerMyCommandCommands(
  program: Command,
  createHandler: (action) => (opts, ...args) => Promise<void>
): void {
  const myCommand = program.command('my-command').description('My command');
  
  myCommand
    .command('do-something')
    .option('-o, --option <value>')
    .action(createHandler(actionDoSomething));
}
```

## Troubleshooting

### Authentication Failed

```
✗ Authentication test failed
  Error: Unauthorized
```

Check that your API token is correct and has not expired.

### Connection Refused

```
✗ Failed to connect to API
  Error: Connection refused
```

Verify that the Beehive API is running and accessible at the configured URL.

### Command Not Found

```
✗ Unknown command: xyz
```

Check the command spelling or run `beehive --help` for available commands.

### Missing Required Options

```
✗ Missing required option: --spec
```

Check the command help for required options.

## License

MIT License - see LICENSE file in the project root.

## Contributing

See CONTRIBUTING.md in the project root for contribution guidelines.

---

*Generated: 2026-10-12*  
*CLI Version: 0.1.0*
