# Beehive CLI - e2e Debugging Guide

This guide covers CLI commands specifically useful for end-to-end debugging of the Beehive platform.

## Quick Start

### Using the CLI

```bash
# Navigate to CLI directory
cd path/to/beehive/cli

# Run with tsx (development)
npx tsx dist/index.js <command>

# Or use the wrapper script
/tmp/beehive-cli <command>

# Build first if you haven't
npm run build
```

### Configuration

Set up your API token and URL:

```bash
# Set via environment variables
export BEEHIVE_API_TOKEN="your-token-here"
export BEEHIVE_API_URL="https://beehive.bz23711.workers.dev"

# Or use command-line options
npx tsx dist/index.js --token your-token --url https://beehive.bz23711.workers.dev debug check-api
```

---

## Debug Commands

### `beehive debug check-api`

Checks connectivity to all API endpoints.

```bash
# Basic check
beehive debug check-api

# With verbose output
beehive debug check-api -v
```

**Output:** Shows latency and status for each API endpoint. Useful for identifying connectivity issues.

---

### `beehive debug validate-config`

Validates your CLI configuration.

```bash
beehive debug validate-config
```

**Output:** Shows API URL, token status, authentication status, and CLI version.

---

### `beehive debug list-specs`

Lists all specs with their current stages.

```bash
# Basic overview
beehive debug list-specs

# Show all details
beehive debug list-specs --all

# Limit to N specs
beehive debug list-specs --limit 50
```

**Output:** Groups specs by stage (draft, proposed, open, closed, rejected, done) with counts.

---

### `beehive debug gate-status`

Checks gate workflow status for candidates.

```bash
# Check all recent candidates
beehive debug gate-status

# Filter by spec ID
beehive debug gate-status --spec <spec-id>

# Filter by candidate ID
beehive debug gate-status --candidate <candidate-id>
```

**Output:** Shows each gate (pre-merge, shadow, train, canary, full) with status and score for each candidate.

---

### `beehive debug state-dump`

Dumps full Spec DO state to JSON.

```bash
# Dump to console
beehive debug state-dump

# Dump to file
beehive debug state-dump --output state.json

# Dump specific entities
beehive debug state-dump --entities spec,candidate

# Dump all entities
beehive debug state-dump --all
```

**Output:** JSON dump of all entities. Use `--output` to save to file for analysis.

---

### `beehive debug verify-queues`

Verifies queue configuration.

```bash
beehive debug verify-queues
```

**Output:** Checks queue connectivity and configuration.

---

### `beehive debug verify-artifacts`

Verifies Cloudflare Artifacts integration.

```bash
# Basic check
beehive debug verify-artifacts

# List all repositories
beehive debug verify-artifacts --list-repos
```

**Output:** Verifies Artifacts integration and optionally lists repositories.

---

### `beehive debug test-claim`

Tests the claim workflow for a spec.

```bash
# Dry run (no actual claim)
beehive debug test-claim <spec-id> --dry-run

# Actual claim
beehive debug test-claim <spec-id>

# With specific actor
beehive debug test-claim <spec-id> --actor <actor-id>
```

**Output:** Tests the claim workflow and shows candidate creation details.

---

### `beehive debug verify-train`

Verifies promotion train integrity for a spec.

```bash
beehive debug verify-train <spec-id>
```

**Output:** Shows spec details, candidate count, promotion count, and candidates grouped by stage.

---

### `beehive debug dump`

Dumps entities of a specific type.

```bash
# Dump all candidates
beehive debug dump candidate

# Dump specs
beehive debug dump spec

# With limit
beehive debug dump candidate --limit 50

# To file
beehive debug dump candidate --output candidates.json
```

**Output:** JSON dump of the specified entity type.

---

### `beehive debug compare`

Compares two candidates side-by-side.

```bash
beehive debug compare <candidate-a-id> <candidate-b-id>
```

**Output:** Shows gate verdicts comparison for both candidates across all rungs (pre-merge, shadow, train, canary, full).

---

## Health Commands

### `beehive health check`

Basic health check of the Beehive API.

```bash
# Basic check
beehive health check

# Extended check
beehive health check --extended
```

**Output:** System status, version, timestamp, and component check statuses.

---

### `beehive health version`

Shows the API version.

```bash
beehive health version
```

---

## Common Debugging Workflows

### 1. Verify System Health

```bash
# Check API connectivity
beehive debug check-api

# Validate configuration
beehive debug validate-config

# Check system health
beehive health check --extended
```

### 2. Inspect Pipeline State

```bash
# See all specs and their stages
beehive debug list-specs --all

# Dump full state
beehive debug state-dump --output state.json
```

### 3. Debug Promotion Train

```bash
# Verify train for a specific spec
beehive debug verify-train <spec-id>

# Check gate status for candidates
beehive debug gate-status --spec <spec-id>
```

### 4. Debug Claim Workflow

```bash
# Test claim in dry-run mode first
beehive debug test-claim <spec-id> --dry-run

# Then execute actual claim
beehive debug test-claim <spec-id>
```

### 5. Compare Candidates

```bash
# Get candidate IDs from state dump
beehive debug state-dump --entities candidate

# Compare two candidates
beehive debug compare <candidate-a> <candidate-b>
```

---

## Output Format Options

All commands support different output formats:

```bash
# JSON (default)
beehive debug state-dump -f json

# Table
beehive debug state-dump -f table

# YAML
beehive debug state-dump -f yaml

# Compact
beehive debug state-dump -f compact
```

---

## Verbose Mode

Use `-v` or `--verbose` for detailed output:

```bash
beehive debug check-api -v
beehive debug state-dump -v
```

---

## Tips

1. **Always start with `validate-config`** to ensure your API token and URL are set correctly.

2. **Use `--output`** to save JSON dumps for later analysis or sharing.

3. **Combine with `jq`** for filtering JSON output:
   ```bash
   beehive debug state-dump -f json | jq '.candidates | length'
   ```

4. **Use dry-run mode** before executing destructive operations:
   ```bash
   beehive debug test-claim <spec-id> --dry-run
   ```

5. **Check API connectivity first** if commands are failing - this will tell you if the issue is network-related.

6. **Save state dumps** at different points in time to track changes:
   ```bash
   beehive debug state-dump --output state-before.json
   # ... perform operations ...
   beehive debug state-dump --output state-after.json
   ```

---

## Common Issues

### "API connection failed"

Run `beehive debug validate-config` to check if your token is set.

### "401 Unauthorized"

Your API token might be expired or invalid. Verify with:
```bash
beehive debug check-api
```

### "No API token configured"

Set the token via:
```bash
export BEEHIVE_API_TOKEN="your-token"
# or
beehive --token your-token <command>
```

### Commands hang or timeout

Check connectivity with `beehive debug check-api`. If all endpoints fail, there might be a network issue.

---

## Command Summary Table

| Command | Description | Key Options |
|---------|-------------|-------------|
| `check-api` | Check API connectivity | -v (verbose) |
| `validate-config` | Validate CLI configuration | - |
| `list-specs` | List specs by stage | --all, --limit |
| `gate-status` | Check gate workflow status | --spec, --candidate |
| `state-dump` | Dump full state | --output, --entities, --all |
| `verify-queues` | Verify queue config | --create-test-message |
| `verify-artifacts` | Verify Artifacts | --list-repos |
| `test-claim` | Test claim workflow | --dry-run, --actor |
| `verify-train` | Verify train integrity | - |
| `dump` | Dump entities | --limit, --output |
| `compare` | Compare candidates | --deep |
| `health check` | Health check | --extended |
| `health version` | Show version | - |
