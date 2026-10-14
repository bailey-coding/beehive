# Beehive Sandbox Runner

The execution layer for agents. Runs in Cloudflare Workers Sandbox SDK.

## Purpose

The Sandbox Runner:
1. **Clones** candidate repos from Cloudflare Artifacts
2. **Installs** dependencies
3. **Executes** agent code
4. **Commits** changes
5. **Pushes** to candidate repos

This is the **agent execution environment** - where agents actually build candidates.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Sandbox Runner Worker                      │
├─────────────────────────────────────────────────────────────┤
│  /sandbox/tasks          - Task management endpoints         │
│  /sandbox/repos/clone    - Clone repo from Artifacts          │
│  /sandbox/repos/commit   - Commit changes in sandbox          │
│  /sandbox/repos/push     - Push to Artifacts                   │
│  /sandbox/execute        - Execute agent code                 │
│  /sandbox/execute/direct - Direct execution (dev only)         │
└─────────────────────────────────────────────────────────────┘
                           │
                           ↓
┌─────────────────────────────────────────────────────────────┐
│                    Cloudflare Sandbox SDK                       │
│  - Isolated execution environment                              │
│  - No network access (configurable)                           │
│  - Memory and CPU limits                                       │
│  - Timeout enforcement                                        │
└─────────────────────────────────────────────────────────────┘
                           │
                           ↓
┌─────────────────────────────────────────────────────────────┐
│                    Cloudflare Artifacts                         │
│  - Candidate repos                                             │
│  - Fork per agent                                              │
│  - Push/pull via bindings                                      │
└─────────────────────────────────────────────────────────────┘
```

## Endpoints

### Task Management

| Method | Endpoint | Description |
|---|---|---|
| POST | `/sandbox/tasks` | Create a new sandbox task |
| GET | `/sandbox/tasks/:taskId` | Get task status and result |
| GET | `/sandbox/tasks/:taskId/result` | Get task result only |

### Repo Operations

| Method | Endpoint | Description |
|---|---|---|
| POST | `/sandbox/repos/clone` | Clone a repo into the sandbox |
| POST | `/sandbox/repos/:repoName/commit` | Commit changes |
| POST | `/sandbox/repos/:repoName/push` | Push to Artifacts |

### Agent Execution

| Method | Endpoint | Description |
|---|---|---|
| POST | `/sandbox/execute` | Execute agent code in sandbox |
| POST | `/sandbox/execute/direct` | Direct execution (dev only) |

## Usage

### 1. Create a Task

```bash
curl -X POST https://beehive.example.com/sandbox/tasks \
  -H "Content-Type: application/json" \
  -H "X-Actor-ID: agent-001" \
  -d '{
    "taskId": "task-001",
    "candidateId": "candidate-001",
    "specId": "spec-001",
    "repoName": "beehive-url-shortener-agent-a",
    "namespace": "default",
    "commitMessage": "Implement URL shortener spec",
    "agentId": "agent-001",
    "maxDurationMs": 30000
  }'
```

### 2. Execute Agent Code

```bash
curl -X POST https://beehive.example.com/sandbox/execute \
  -H "Content-Type: application/json" \
  -H "X-Actor-ID: agent-001" \
  -d '{
    "taskId": "task-001",
    "candidateId": "candidate-001",
    "specId": "spec-001",
    "agentCode": "console.log(\"Hello from agent\")",
    "timeoutMs": 10000
  }'
```

### 3. Check Task Status

```bash
curl https://beehive.example.com/sandbox/tasks/task-001 \
  -H "X-Actor-ID: agent-001"
```

## Development

### Local Testing

```bash
# Run the sandbox runner locally
npm install
npx wrangler dev --local
```

Note: Local mode has limitations:
- No actual Artifacts binding
- No real sandbox isolation
- Use simulated operations

### Production Deployment

```bash
# Deploy to Cloudflare
npx wrangler deploy
```

Requires:
- Cloudflare Workers paid plan (for Artifacts access)
- ARTIFACTS binding configured
- SANDBOX binding configured (when available)

## Configuration

### wrangler.toml

```toml
name = "beehive-sandbox-runner"
main = "workers/sandbox-runner/index.ts"
compatibility_date = "2026-10-09"

[durable_objects]
# If using DO for task tracking

[bindings]
# ARTIFACTS = { type = "artifacts", namespace = "default" }
# SANDBOX = { type = "sandbox" }
```

## Sandbox Constraints

| Resource | Limit | Notes |
|---|---|---|
| CPU | 1 vCPU | Standard Worker limit |
| Memory | 128MB - 1024MB | Configurable |
| Timeout | 30s - 600s | Configurable |
| Network | Disabled | For security |
| Storage | Ephemeral | Cleared between runs |

## Security Considerations

1. **No eval in production**: The direct execution endpoint uses eval for development. Production MUST use Sandbox SDK.
2. **Network isolation**: Sandbox has no network access by default.
3. **Timeout enforcement**: All operations have strict timeouts.
4. **Resource limits**: CPU, memory, and execution time are capped.
5. **Input validation**: All inputs are validated before execution.

## Integration with Spec DO

The Sandbox Runner works with the Spec DO:

1. **Spec DO** creates a task and calls Sandbox Runner
2. **Sandbox Runner** executes the agent code
3. **Sandbox Runner** returns results to Spec DO
4. **Spec DO** records the candidate and updates state

```
Spec DO → Sandbox Runner → Artifacts
     ↑           ↓
     ←───────────┘
```

## Future Enhancements

- [ ] Actual Sandbox SDK integration (when available)
- [ ] Artifacts binding for real repo operations
- [ ] Queue-based task distribution
- [ ] Result caching with R2
- [ ] Execution metrics to Analytics Engine
- [ ] Retry logic with exponential backoff
- [ ] Circuit breakers for failing agents
