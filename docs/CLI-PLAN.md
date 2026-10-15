---
category: planning
status: active
audience: human,agent
---

# Beehive CLI Plan

**Status:** Planning Phase  
**Owner:** Beehive Team  
**Target:** M2 Delivery (stretch) / M3 (full)  
**Related:** AGENTS.md, ARCHITECTURE.md, MILESTONES.md

---

## Overview

A CLI for the Beehive platform that wraps the REST API, providing a developer-friendly interface for:
- Managing entities (organizations, repos, specs, candidates, actors)
- Triggering workflows (gates, trials, promotions)
- Monitoring system state
- Debugging and e2e testing

**Design Philosophy:**
- **Composability:** Commands chain via pipes (JSON output by default)
- **Idempotency:** Safe to retry; uses existing entity IDs where possible
- **Fail-closed:** Clear errors, never silent failures
- **Zero-config:** Reads `BEEHIVE_API_TOKEN` from env, `.env`, or `~/.beehive/config`
- **Agent-friendly:** Machine-readable output; exit codes for scripting

---

## Command Taxonomy

### 1. Core Commands (`beehive`)

```
beehive [global-options] <command> [command-options] [args]

Global Options:
  --version, -v    Show version
  --help, -h      Show help
  --config, -c    Config file path (default: ~/.beehive/config)
  --token, -t     API token (overrides BEEHIVE_API_TOKEN env)
  --url, -u       API base URL (default: https://beehive.bz23711.workers.dev)
  --json, -j      Force JSON output (default)
  --pretty        Pretty-print JSON output
  --verbose, -V   Verbose logging

Commands:
  auth        Authentication management
  org         Organization management
  repo        Repository management  
  actor       Actor (human/agent) management
  spec        Spec management
  candidate   Candidate management
  gate        Gate workflow operations
  trial       Trial operations
  promotion   Promotion operations
  issue       Issue management
  history     Entity history
  health      Health check and diagnostics
  debug       Debugging utilities (e2e focus)
```

---

## 2. Command Reference

### 2.1 Authentication (`beehive auth`)

Manages API authentication tokens and configuration.

```bash
# Configure API token (stores in ~/.beehive/config)
beehive auth login
beehive auth login --token <API_AUTH_TOKEN>

# Show current configuration
beehive auth status

# Test authentication
beehive auth test

# Clear token
beehive auth logout
```

**Environment Variables:**
- `BEEHIVE_API_TOKEN` - Primary token source
- Falls back to `~/.beehive/config` if not in env

---

### 2.2 Organizations (`beehive org`)

```bash
# Create organization
beehive org create <name> [--type github|gitlab|artifacts] [--external-id <id>]

# List organizations
beehive org list [--limit <n>] [--offset <n>]

# Get organization details
beehive org get <org-id>

# Delete organization (soft-delete via tombstone)
beehive org delete <org-id>
```

---

### 2.3 Actors (`beehive actor`)

```bash
# Create actor (human or agent)
beehive actor create <name> --type human|agent [--github-user-id <id>]

# List actors
beehive actor list [--limit <n>] [--offset <n>] [--type human|agent]

# Get actor details
beehive actor get <actor-id>

# Update trust score
beehive actor trust <actor-id> --score <0-100>

# Grant promotion authority
beehive actor grant-promotion <actor-id>
```

---

### 2.4 Repositories (`beehive repo`)

```bash
# Create repository
beehive repo create <name> \
  --organization <org-id> \
  --type baseline|candidate \
  --remote-url <url> \
  --namespace <namespace> \
  [--spec-id <spec-id>] \
  [--agent-id <agent-id>] \
  [--default-branch <branch>]

# List repositories
beehive repo list [--organization <org-id>] [--type baseline|candidate] [--limit <n>]

# Get repository details
beehive repo get <repo-id>
```

---

### 2.5 Specs (`beehive spec`)

```bash
# Create spec
beehive spec create <name> \
  --organization <org-id> \
  --contract <json-string-or-file> \
  --declared-delta-surface <comma-separated-endpoints> \
  [--description <desc>]

# List specs
beehive spec list [--organization <org-id>] [--stage draft|proposed|active|deprecated|archived] [--limit <n>]

# Get spec details
beehive spec get <spec-id>

# Update spec stage
beehive spec stage <spec-id> --stage <stage> [--notes <notes>]

# Claim spec (agent workflow - creates candidate fork)
beehive spec claim <spec-id> [--actor <actor-id>]
```

**Notes:**
- `--contract` accepts JSON string directly or `@<file>` syntax for file path
- Claim command triggers Artifacts fork creation and returns candidate details

---

### 2.6 Candidates (`beehive candidate`)

```bash
# Create candidate
beehive candidate create <spec-id> \
  --repository <repo-id> \
  --commit <sha> \
  --base-commit <sha> \
  [--agent <agent-id>]

# List candidates
beehive candidate list [--spec <spec-id>] [--agent <agent-id>] [--stage <stage>] [--limit <n>]

# Get candidate details
beehive candidate get <candidate-id>

# Update candidate stage
beehive candidate stage <candidate-id> \
  --stage pending|passed_premerge|passed_shadow|passed_train|passed_canary|promoted|failed|rolled_back \
  [--notes <notes>]

# Execute candidate in sandbox
beehive candidate execute <candidate-id> [--sandbox-url <url>]

# Get gate verdicts for candidate
beehive candidate gate-verdicts <candidate-id>
```

---

### 2.7 Gate Verdicts (`beehive gate`)

```bash
# Run pre-merge gate for candidate
beehive gate run <candidate-id> --gate pre-merge [--actor <actor-id>]

# List gate verdicts
beehive gate list [--candidate <candidate-id>] [--gate <gate>] [--status pass|fail|pending] [--limit <n>]

# Get gate verdict details
beehive gate get <verdict-id>

# Create gate verdict (manual override)
beehive gate create <candidate-id> \
  --gate pre-merge|shadow|train|canary|full \
  --status pass|fail|pending \
  --score <0-100> \
  --complexity-delta <number> \
  [--notes <notes>]
```

---

### 2.8 Trials (`beehive trial`)

```bash
# Create trial (compare two candidates)
beehive trial create \
  --candidate-a <candidate-id> \
  --candidate-b <candidate-id> \
  --spec <spec-id> \
  [--actor <actor-id>]

# List trials
beehive trial list [--spec <spec-id>] [--stage <stage>] [--limit <n>]

# Get trial details
beehive trial get <trial-id>

# Decide trial (select winner)
beehive trial decide <trial-id> --winner <candidate-id> [--notes <notes>]
```

---

### 2.9 Promotions (`beehive promotion`)

```bash
# Create promotion
beehive promotion create <candidate-id> \
  [--actor <actor-id>] \
  [--notes <notes>]

# List promotions
beehive promotion list [--candidate <candidate-id>] [--limit <n>]

# Get promotion details
beehive promotion get <promotion-id>
```

**Note:** Promotion authority is required (see `beehive actor grant-promotion`)

---

### 2.10 Issues (`beehive issue`)

```bash
# Create issue
beehive issue create <title> \
  --repository <repo-id> \
  [--description <desc>] \
  [--change-type typo-fix|refactor|behavior-change|security-sensitive|dependency-change|infra] \
  [--complexity-estimate <score>] \
  [--reporter-trust <level>]

# List issues
beehive issue list [--repository <repo-id>] [--stage <stage>] [--status <status>] [--limit <n>]

# Get issue details
beehive issue get <issue-id>

# Update issue stage
beehive issue stage <issue-id> --stage <stage>

# Update comment policy
beehive issue comment-policy <issue-id> --policy <policy>

# Add comment to issue
beehive issue comment <issue-id> <comment-text> [--visibility <visibility>]

# Link issue to spec
beehive issue link-spec <issue-id> --spec <spec-id>

# Link issue to candidate
beehive issue link-candidate <issue-id> --candidate <candidate-id>
```

---

### 2.11 Entity History (`beehive history`)

```bash
# Get history for any entity
beehive history <entity-type> <entity-id>

# Examples:
beehive history spec <spec-id>
beehive history candidate <candidate-id>
beehive history actor <actor-id>
beehive history organization <org-id>
beehive history repository <repo-id>
```

---

### 2.12 Health & Diagnostics (`beehive health`)

```bash
# Basic health check
beehive health

# Extended health check with component status
beehive health --extended

# Check specific worker health
beehive health --worker api|gate|sandbox|queue

# Get system version
beehive health --version

# Get system status/metrics summary
beehive health --metrics
```

---

### 2.13 Debug Commands (`beehive debug`)

**Specifically for e2e debugging support:**

```bash
# Dump full Spec DO state (for debugging)
beehive debug state-dump [--output <file>]

# Tail worker logs
beehive debug tail [--worker api|gate|sandbox|queue] [--lines <n>]

# Trigger synthetic monitoring test
beehive debug synthetic-test [--worker <worker>] [--endpoint <endpoint>]

# Verify queue wiring
beehive debug verify-queues [--create-test-message]

# Verify Artifacts integration
beehive debug verify-artifacts [--list-repos] [--create-test-fork]

# Test claim workflow end-to-end
beehive debug test-claim <spec-id> [--dry-run]

# Verify promotion train integrity
beehive debug verify-train <spec-id>

# Dump all entities of a type
beehive debug dump <entity-type> [--limit <n>] [--output <file>]

# Compare two candidates (manual trial trigger)
beehive debug compare <candidate-a-id> <candidate-b-id> [--deep]
```

---

## 3. Architecture

### 3.1 Directory Structure

```
cli/
├── src/
│   ├── commands/
│   │   ├── auth.ts
│   │   ├── org.ts
│   │   ├── repo.ts
│   │   ├── actor.ts
│   │   ├── spec.ts
│   │   ├── candidate.ts
│   │   ├── gate.ts
│   │   ├── trial.ts
│   │   ├── promotion.ts
│   │   ├── issue.ts
│   │   ├── history.ts
│   │   ├── health.ts
│   │   └── debug.ts
│   ├── types/
│   │   ├── commands.ts        # Command definitions
│   │   ├── api.ts             # API request/response types (shared with workers)
│   │   └── config.ts          # CLI config types
│   ├── utils/
│   │   ├── api-client.ts     # HTTP client wrapper
│   │   ├── output.ts          # Formatting and output utilities
│   │   ├── auth.ts            # Token management
│   │   └── validation.ts      # Input validation
│   ├── config.ts              # Config loading
│   └── index.ts               # CLI entry point
├── bin/
│   └── beehive                # Executable (generated or wrapper)
├── package.json
├── tsconfig.json
└── README.md
```

### 3.2 Dependencies

**Runtime:**
- Node.js >= 22.0.0 (matches project requirement)
- TypeScript for development

**Production Dependencies:**
```json
{
  "dependencies": {
    "commander": "^12.0.0",
    "axios": "^1.6.0",
    "chalk": "^5.0.0",
    "ora": "^8.0.0",
    "configstore": "^6.0.0"
  }
}
```

**Optional (for enhanced features):**
- `inquirer` - Interactive prompts
- `table` - Table formatting
- `strip-ansi` - Clean output for pipes

### 3.3 Configuration

**Config File (`~/.beehive/config`):**
```json
{
  "apiUrl": "https://beehive.bz23711.workers.dev",
  "apiToken": "...",
  "defaultOrganization": "org-id",
  "defaultActor": "actor-id",
  "outputFormat": "json",
  "verbose": false
}
```

**Priority:**
1. Command-line flags
2. Environment variables
3. Config file
4. Defaults

---

## 4. Implementation Phases

### Phase 1: Core Infrastructure (M1 Complete - Can start now)
- [ ] CLI entry point and command parser
- [ ] Configuration management
- [ ] API client with auth
- [ ] Basic output formatting (JSON by default)
- [ ] Health check command

### Phase 2: Entity Management (M1/M2 Boundary)
- [ ] Organizations CRUD
- [ ] Actors CRUD
- [ ] Repositories CRUD
- [ ] Specs CRUD
- [ ] Candidates CRUD

### Phase 3: Workflow Commands (M2)
- [ ] Gate operations
- [ ] Trial operations
- [ ] Promotion operations

### Phase 4: Advanced Features (M2/M3)
- [ ] Issue management
- [ ] Entity history
- [ ] Debug utilities

### Phase 5: Polish (M3)
- [ ] Interactive prompts
- [ ] Table output format
- [ ] Shell completions
- [ ] Documentation

---

## 5. API Client Design

```typescript
// cli/src/utils/api-client.ts

interface BeehiveConfig {
  apiUrl: string;
  apiToken?: string;
  timeout?: number;
}

class BeehiveClient {
  constructor(private config: BeehiveConfig) {}

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    data?: unknown,
    actorId?: string
  ): Promise<T> {
    const url = `${this.config.apiUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.apiToken}`,
    };
    if (actorId) headers['X-Actor-ID'] = actorId;

    const response = await axios({ method, url, headers, data, timeout: this.config.timeout });
    
    if (!response.data.success) {
      throw new BeehiveError(response.data.error || 'Unknown error', response.status);
    }
    
    return response.data.data as T;
  }

  // Entity methods
  async getOrganization(id: string): Promise<OrganizationResponse> {
    return this.request('GET', `/api/organizations/${id}`);
  }
  
  async listOrganizations(params?: { limit?: number; offset?: number }): Promise<OrganizationResponse[]> {
    return this.request('GET', '/api/organizations', undefined, undefined, params);
  }
  
  // ... all other endpoints
}

class BeehiveError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
  }
}
```

---

## 6. Output Formatting

### JSON Output (Default)
```json
{
  "success": true,
  "data": { ... },
  "timestamp": 1700000000000
}
```

### Table Output (Optional)
```
ID                                    NAME          TYPE       CREATED
─────────────────────────────────────────────────────────────────
org_abc123                            My Org       github     2026-10-12
org_def456                            Test Org     artifacts  2026-10-11
```

### Verbose Output
Adds timing, request details, and debug info.

---

## 7. Error Handling

### Exit Codes
| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Authentication error |
| 3 | Validation error |
| 4 | Not found |
| 5 | Conflict |

### Error Messages
- Human-readable by default
- `--json` flag returns structured error
- `--verbose` includes stack traces (dev only)

---

## 8. Debug-Focused Features (For e2e Support)

Given your current e2e debugging challenges, prioritize:

1. **`beehive debug state-dump`** - Full Spec DO state export
2. **`beehive debug tail`** - Worker log tailing
3. **`beehive debug verify-queues`** - Queue wiring verification
4. **`beehive debug verify-artifacts`** - Artifacts integration test
5. **`beehive debug test-claim`** - Full claim workflow test

These commands should:
- Output machine-readable JSON for scripting
- Support `--dry-run` for safety
- Include timing metrics
- Validate preconditions before execution

---

## 9. Example Workflows

### Agent claiming a spec and submitting candidate:
```bash
# Authenticate
beehive auth login --token $API_TOKEN

# Find available specs
beehive spec list --stage proposed

# Claim a spec (creates fork and candidate)
beehive spec claim spec_abc123 --actor agent_xyz

# Get candidate details
CANDIDATE=$(beehive candidate list --spec spec_abc123 --agent agent_xyz -j | jq -r '.data[0].id')

# Run pre-merge gate
beehive gate run $CANDIDATE --gate pre-merge

# Check gate verdict
beehive gate list --candidate $CANDIDATE
```

### Debugging e2e test failures:
```bash
# Dump full state
beehive debug state-dump > state.json

# Check queue events
beehive debug verify-queues

# Test Artifacts connectivity
beehive debug verify-artifacts --list-repos

# Test claim workflow
beehive debug test-claim spec_abc123 --dry-run
```

---

## 10. Testing Strategy

### Unit Tests
- Command parsing
- Input validation
- Output formatting
- Error handling

### Integration Tests
- API client connectivity
- Authentication flow
- Command chaining

### E2E Tests
- Full workflows (claim → gate → promotion)
- Debug commands
- Error scenarios

---

## 11. Documentation

Each command should have:
- `--help` output with examples
- Man page (auto-generated from help)
- Online documentation (part of docs site)

---

## 12. Open Questions

1. **Naming:** Should it be `beehive`, `bhv`, or something else?
2. **Package manager:** npm package, standalone binary, or both?
3. **Plugin system:** Should we support custom commands via plugins?
4. **Interactive mode:** REPL-style interface for exploration?
5. **CI integration:** GitHub Action for CLI-based workflows?

---

## Next Steps

1. **Review this plan** - Validate against current project needs
2. **Prioritize** - Which phases to implement first?
3. **Implement Phase 1** - Core infrastructure (can start immediately)
4. **Iterate** - Build incrementally with feedback

Given your e2e debugging needs, I recommend starting with:
- Phase 1 (Core infrastructure)
- Debug commands (from Phase 4)

This gives you immediate value for debugging while building the foundation for full CLI functionality.

---

*Generated: 2026-10-12*  
*Status: Ready for review*
