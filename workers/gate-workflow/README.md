# Beehive Pre-merge Gate Workflow

First rung of the oracle ladder. Runs automated tests, property checks, and spec conformance validation against a candidate without live traffic.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                 Pre-merge Gate Workflow                         │
├─────────────────────────────────────────────────────────────┤
│  POST /gates/pre-merge                    - Start evaluation   │
│  GET /gates/pre-merge/status/{verdictId} - Check status       │
│  GET /gates/pre-merge/{verdictId}        - Get full result     │
│  POST /gates/pre-merge/{verdictId}/tests - Re-run tests        │
│  POST /gates/pre-merge/{verdictId}/complexity - Recalculate    │
│  POST /gates/pre-merge/{verdictId}/conformance - Revalidate    │
└─────────────────────────────────────────────────────────────┘
                           │
                           ↓
┌─────────────────────────────────────────────────────────────┐
│                      Execution Steps                           │
├─────────────────────────────────────────────────────────────┤
│  1. Clone candidate repo from Artifacts                         │
│  2. Install dependencies                                        │
│  3. Run unit tests                                              │
│  4. Run property-based tests                                    │
│  5. Calculate complexity delta vs baseline                      │
│  6. Validate spec conformance                                   │
│  7. Aggregate results into final score and verdict             │
│  8. Record verdict in Spec DO                                   │
└─────────────────────────────────────────────────────────────┘
                           │
                           ↓
┌─────────────────────────────────────────────────────────────┐
│                    Spec DO Ledger                               │
│  - Stores gate_verdicts                                         │
│  - Updates candidate.stage                                       │
│  - Records entity history                                        │
└─────────────────────────────────────────────────────────────┘
```

## Scoring Algorithm

The pre-merge gate uses a weighted scoring system:

```
Overall Score = 
  (Conformance Score × 0.5) +
  (Test Score × 0.25) +
  (Complexity Score × 0.25)
```

### Conformance Score (0-100)
- **100**: Perfect match with spec contract
- **-20 per error**: Each spec conformance error
- **-5 per warning**: Each spec conformance warning

### Test Score (0-100)
- Percentage of tests that pass
- All tests must pass to achieve score ≥ 80

### Complexity Score (0-100)
- Based on complexity delta vs baseline
- **1.0**: "Normal" complexity (score = 100)
- **Deviation penalty**: |delta - 1.0| × 50
- Lower complexity = higher score

### Passing Threshold
- **≥ 80**: Candidate passes pre-merge gate
- **< 80**: Candidate fails pre-merge gate

## Endpoints

### Start Pre-merge Gate Evaluation

```bash
curl -X POST https://beehive.example.com/gates/pre-merge \
  -H "Content-Type: application/json" \
  -H "X-Actor-ID: agent-001" \
  -d '{
    "candidateId": "candidate-001",
    "specId": "spec-001",
    "commitSha": "abc123...",
    "baseCommitSha": "def456..."
  }'
```

**Response:**
```json
{
  "success": true,
  "verdictId": "verdict-premerge-xyz",
  "result": {
    "verdictId": "verdict-premerge-xyz",
    "candidateId": "candidate-001",
    "gate": "pre-merge",
    "status": "pass",
    "score": 95,
    "complexityDelta": 0.8,
    "testResults": [...],
    "conformanceErrors": [],
    "notes": "Test score: 100.0/100; Conformance score: 100.0/100; Complexity score: 80.0/100; Overall score: 95.0/100",
    "startedAt": 1234567890,
    "completedAt": 1234567895
  }
}
```

### Check Workflow Status

```bash
curl https://beehive.example.com/gates/pre-merge/status/verdict-premerge-xyz
```

**Response:**
```json
{
  "success": true,
  "status": "complete",
  "startedAt": 1234567890,
  "completedAt": 1234567895
}
```

### Get Full Workflow Result

```bash
curl https://beehive.example.com/gates/pre-merge/verdict-premerge-xyz
```

## Configuration

### wrangler.toml

```toml
name = "beehive-gate-workflow"
main = "workers/gate-workflow/index.ts"
compatibility_date = "2026-10-09"

[durable_objects]

[durable_objects.bindings]
SPEC_DO = { name = "SPEC_DO", class_name = "SpecDO" }

[services]
SANDBOX_RUNNER = "beehive-sandbox-runner"

[bindings]
# ARTIFACTS = { type = "artifacts", namespace = "default" }
```

## Cloudflare Workflows Integration

In production, this would be implemented as a Cloudflare Workflow with multiple steps:

```yaml
# workflow.yaml (conceptual)
name: pre-merge-gate
steps:
  1:
    name: clone_repo
    service: beehive-sandbox-runner
    action: clone
    
  2:
    name: install_deps
    service: beehive-sandbox-runner
    action: install
    depends_on: [1]
    
  3:
    name: run_tests
    service: beehive-gate-workflow
    action: run_tests
    depends_on: [2]
    
  4:
    name: calculate_complexity
    service: beehive-gate-workflow
    action: calculate_complexity
    depends_on: [2]
    
  5:
    name: validate_conformance
    service: beehive-gate-workflow
    action: validate_conformance
    depends_on: [2]
    
  6:
    name: aggregate_results
    service: beehive-gate-workflow
    action: aggregate
    depends_on: [3, 4, 5]
    
  7:
    name: record_verdict
    service: beehive-spec-do
    action: record_verdict
    depends_on: [6]
```

## Development

### Local Testing

```bash
npm install
npx wrangler dev
```

### Production Deployment

```bash
npx wrangler deploy
```

## Testing

See `workers/gate-workflow/tests/` for unit tests.

## Integration with Spec DO

The Pre-merge Gate Workflow:
1. Receives a candidate to evaluate
2. Executes all validation steps
3. Records the verdict in the Spec DO
4. Updates the candidate's stage

```
Client → Gate Workflow → Spec DO
         ↑
    Sandbox Runner
```

## Future Enhancements

- [ ] Actual Cloudflare Workflows integration
- [ ] Real test execution (not simulated)
- [ ] Actual complexity analysis
- [ ] Real spec conformance validation
- [ ] Caching of test results
- [ ] Parallel test execution
- [ ] Test flakiness detection
- [ ] Custom test timeouts per spec
