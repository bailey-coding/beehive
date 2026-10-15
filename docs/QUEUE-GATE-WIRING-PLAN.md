---
category: feature
status: active
audience: human,agent
tags:
  - queue
  - gates
---

# Queue-Gate Wiring Plan

**Status:** Ready for implementation  
**Priority:** P0 (Blocker for self-development)  
**Owner:** Agent 2  
**Estimate:** 2-3 hours  
**Worktree:** `queue-gate-wiring`

---

## Objective

Wire the queue consumer to properly trigger the gate workflow when push events are received, creating a complete event-driven pipeline:

```
Artifacts Push → Queue → Queue Consumer → Gate Workflow → Verdict Recorded
```

---

## Current State

### What exists
- **Queue Consumer** (`workers/queue-consumer/index.ts`):
  - Has `queue()` handler that processes push events
  - Finds matching candidate by repository URL
  - Calls `/api/candidates/:id/gate/pre-merge` on Spec DO
  - Records event in history
  
- **Gate Workflow** (`workers/gate-workflow/index.ts`):
  - Has full `executePreMergeGate()` logic
  - Runs unit tests, property tests, complexity delta, spec conformance
  - Aggregates results and records verdict in Spec DO
  - All test execution is currently mocked/simulated

- **API Router** (`workers/api/index.ts`):
  - Has `handleRunPreMergeGate()` that forwards to Spec DO
  - Spec DO has `handleRunPreMergeGate()` that... returns the request body unchanged (stub)

### The Gap

The queue consumer calls `/api/candidates/:id/gate/pre-merge` on the **Spec DO**, but:
1. Spec DO doesn't actually trigger the Gate Workflow Worker
2. Gate Workflow Worker isn't being called at all from the event flow
3. Tests are mocked (but that's acceptable for Day 1)

---

## Implementation Tasks

### Task 1: Wire Spec DO to Call Gate Workflow (60 min)

**File:** `workers/spec-do/index.ts`

**Changes to `fetch()` method:**

Add handling for the pre-merge gate trigger:

```typescript
// In the fetch() method, add:

// ============================================================================
// GATE WORKFLOW TRIGGER
// ============================================================================

if (path.match(/^\/api\/candidates\/[^\/]+\/gate\/pre-merge$/) && method === 'POST') {
  const candidateId = extractParentId(path);
  const body = await request.json() as {
    commitSha?: string;
    baseCommitSha?: string;
    message?: string;
    timestamp?: string;
  };
  const actorId = request.headers.get('X-Actor-ID') || 'queue-consumer';

  // Get candidate to find spec_id and repository
  const candidate = this.getCandidate(candidateId);
  if (!candidate) {
    return new Response(JSON.stringify({
      success: false,
      error: `Candidate not found: ${candidateId}`,
      timestamp: now(),
    }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Get spec for contract
  const spec = this.getSpec(candidate.spec_id);
  if (!spec) {
    return new Response(JSON.stringify({
      success: false,
      error: `Spec not found: ${candidate.spec_id}`,
      timestamp: now(),
    }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Get repository for namespace/remote info
  const repo = this.getRepository(candidate.repository_id);
  if (!repo) {
    return new Response(JSON.stringify({
      success: false,
      error: `Repository not found: ${candidate.repository_id}`,
      timestamp: now(),
    }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Build gate workflow request
  const gateRequest = {
    candidateId,
    specId: spec.id,
    commitSha: body.commitSha || candidate.commit_sha,
    baseCommitSha: body.baseCommitSha || candidate.base_commit_sha,
    actorId,
    namespace: repo.namespace,
    repoName: repo.name,
  };

  // Get Gate Workflow service binding
  // This requires a service binding from Spec DO to Gate Workflow
  const gateWorkflowStub = this.env.GATE_WORKFLOW;
  
  if (!gateWorkflowStub) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Gate workflow binding not configured',
      timestamp: now(),
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Call Gate Workflow
  const gateResponse = await gateWorkflowStub.fetch(
    new Request('https://gate-workflow/gates/pre-merge', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.env.API_AUTH_TOKEN}`,
        'X-Actor-ID': actorId,
      },
      body: JSON.stringify(gateRequest),
    })
  );

  if (!gateResponse.ok) {
    const error = await gateResponse.text();
    console.error(`[SpecDO] Gate workflow failed: ${error}`);
    return new Response(JSON.stringify({
      success: false,
      error: `Gate workflow failed: ${error}`,
      timestamp: now(),
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const gateResult = await gateResponse.json();
  return new Response(JSON.stringify(gateResult), {
    headers: { 'Content-Type': 'application/json' },
  });
}
```

**Acceptance Criteria:**
- [ ] Spec DO properly forwards gate requests to Gate Workflow
- [ ] All required data (candidateId, specId, commitSha, etc.) is passed through
- [ ] Errors are handled gracefully
- [ ] Auth is passed through correctly

---

### Task 2: Add Service Binding from Spec DO to Gate Workflow (30 min)

**Files:**
- `wrangler.toml` (root) - Add service binding
- `workers/spec-do/index.ts` - Update Env interface

**Changes to `wrangler.toml`:**

```toml
# Add to root wrangler.toml (beehive worker)
[[services]]
binding = "GATE_WORKFLOW"
service = "beehive-gate-workflow"
```

**Changes to `workers/spec-do/index.ts`:**

```typescript
interface Env {
  SPEC_DO: DurableObjectNamespace;
  GATE_WORKFLOW: Service;  // Add this
  API_AUTH_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
}

// Update class constructor to accept GATE_WORKFLOW
export class SpecDO {
  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    // GATE_WORKFLOW is now available as this.env.GATE_WORKFLOW
  }
}
```

**Acceptance Criteria:**
- [ ] Service binding configured correctly
- [ ] Type definitions updated
- [ ] Binding works in local dev (Miniflare)

---

### Task 3: Fix Gate Workflow to Use Real Repository Data (60 min)

**File:** `workers/gate-workflow/index.ts`

The gate workflow currently simulates cloning. For Day 1, we can:
- Accept the simulation **OR**
- Use the repository data passed from Spec DO to attempt real operations

**Option A: Keep simulation (Day 1 acceptable)**
- The mocked tests already work
- Complexity delta calculation already queries Spec DO
- Conformance validation already works
- This is good enough for self-development

**Option B: Add real git operations (stretch)**
```typescript
// In executePreMergeGate():
async function cloneAndTest(candidateId: string, repoUrl: string): Promise<TestResult[]> {
  // Use ARTIFACTS binding to clone
  // But: Workers don't have filesystem, so this needs external service
  // For Day 1: Keep mocks
  return mockTestResults;
}
```

**Recommendation:** Keep mocks for Day 1. Real execution requires:
- Workers Sandbox SDK (not yet available)
- Or external execution service
- This is M2 work

**Acceptance Criteria:**
- [ ] Gate workflow executes successfully with passed data
- [ ] Verdict is recorded in Spec DO
- [ ] Scores and metrics are calculated

---

### Task 4: Fix Queue Consumer Service Binding (30 min)

**File:** `workers/queue-consumer/wrangler.toml`

**Changes:**

```toml
# Ensure proper bindings exist
[[services]]
binding = "SPEC_DO"
service = "beehive"

[[services]]
binding = "GATE_WORKFLOW"
service = "beehive-gate-workflow"
```

**File:** `workers/queue-consumer/index.ts`

Update the Env interface and ensure it uses the service binding:

```typescript
interface Env {
  SPEC_DO: DurableObjectNamespace;
  GATE_WORKFLOW: Service;  // Add this
  API_AUTH_TOKEN?: string;
}

// In queue(), change the gate trigger to use service binding directly:
const gateResponse = await env.GATE_WORKFLOW.fetch(
  new Request(`http://beehive-gate-workflow/gates/pre-merge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.API_AUTH_TOKEN}`,
    },
    body: JSON.stringify({
      candidateId: candidate.id,
      specId: candidate.spec_id,
      commitSha: event.commit.sha,
      baseCommitSha: event.base_ref ? event.commit.sha : candidate.base_commit_sha,
      actorId: 'queue-consumer',
    }),
  })
);
```

**Note:** The current implementation routes through Spec DO first (`/api/candidates/:id/gate/pre-merge`), which is fine. But for directness, we could call Gate Workflow directly. The Spec DO routing is actually better for consistency.

**Acceptance Criteria:**
- [ ] Queue consumer can reach Gate Workflow (directly or via Spec DO)
- [ ] All required bindings exist

---

## Testing Strategy

### End-to-End Test Script

```bash
#!/bin/bash
# test-queue-gate-wiring.sh

# Prerequisites
# - All 4 workers deployed
# - Queue created and configured
# - API_AUTH_TOKEN set on all workers

# 1. Create a spec
SPEC_ID=$(curl -s -X POST https://beehive.bz23711.workers.dev/api/specs \
  -H "Authorization: Bearer $BEEHIVE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"test-url-shortener","description":"Test","contract":"{"endpoints":[{"path":"/shorten","method":"POST"}]}","declaredDeltaSurface":["shorten","redirect"],"organizationId":"org-1"}' \
  | jq -r '.data.id')

echo "Created spec: $SPEC_ID"

# 2. Claim the spec (creates candidate + repo)
CLAIM=$(curl -s -X POST "https://beehive.bz23711.workers.dev/api/specs/$SPEC_ID/claim" \
  -H "Authorization: Bearer $BEEHIVE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Actor-ID: test-agent-1" \
  -d '{"agentId":"test-agent-1"}')

CANDIDATE_ID=$(echo "$CLAIM" | jq -r '.data.candidateId')
REPO_URL=$(echo "$CLAIM" | jq -r '.data.repositoryUrl')
TOKEN=$(echo "$CLAIM" | jq -r '.data.token')

echo "Claimed spec: candidate=$CANDIDATE_ID, repo=$REPO_URL"

# 3. Clone the repo
cd /tmp
rm -rf test-candidate
git clone -c "http.extraHeader=Authorization: Bearer $TOKEN" $REPO_URL test-candidate
cd test-candidate

# 4. Add a test file and commit
echo 'module.exports = { test: () => {} }' > test.js
echo '{"scripts": {"test": "node test.js"}}' > package.json
git add .
git commit -m "Add tests"
git push origin main

# 5. Verify: Queue should have received event, consumer processed it, gate ran
# Check gate verdicts for the candidate
sleep 10

VERDICTS=$(curl -s "https://beehive.bz23711.workers.dev/api/candidates/$CANDIDATE_ID/gate-verdicts" \
  -H "Authorization: Bearer $BEEHIVE_API_TOKEN")

echo "Gate verdicts: $VERDICTS"

# Should have a pre-merge verdict
PRE_MERGE_COUNT=$(echo "$VERDICTS" | jq '.data | length')
if [ "$PRE_MERGE_COUNT" -gt 0 ]; then
  echo "✅ SUCCESS: Gate workflow was triggered"
else
  echo "❌ FAILED: No gate verdicts found"
  exit 1
fi

# Cleanup
cd /tmp
rm -rf test-candidate
```

---

## Testing Without Full Deployment

For local development with Miniflare:

```bash
# Terminal 1: Start main beehive worker
cd /path/to/beehive
wrangler dev

# Terminal 2: Start gate-workflow worker
wrangler dev --config workers/gate-workflow/wrangler.toml

# Terminal 3: Start queue-consumer worker
wrangler dev --config workers/queue-consumer/wrangler.toml

# Terminal 4: Run the integration test
./scripts/test-queue-gate-wiring.sh
```

**Note:** Miniflare may need additional configuration for service bindings between workers.

---

## Dependencies

- All 4 workers deployed or running in dev mode
- Queue created: `wrangler queues create beehive-artifacts-push`
- API_AUTH_TOKEN configured on all workers
- Artifacts integration complete (so repos are real)

---

## Rollback Plan

If wiring fails:
1. Keep queue consumer logging events without triggering gates
2. Add manual gate trigger endpoint for debugging
3. Document known limitations

---

## Success Criteria

✅ Push events to candidate repos trigger gate workflow automatically  
✅ Gate workflow executes and records verdict in Spec DO  
✅ End-to-end flow works: claim → push → gate → verdict  
✅ All service bindings configured correctly  

---

## Files Modified

| File | Change Type | Risk |
|------|-------------|------|
| `workers/spec-do/index.ts` | Modified | Medium |
| `workers/queue-consumer/index.ts` | Modified | Low |
| `workers/gate-workflow/index.ts` | Modified (minor) | Low |
| `wrangler.toml` | Modified | Low |
| `workers/queue-consumer/wrangler.toml` | Modified | Low |

---

## Commit Message Template

```
step: wire queue consumer to gate workflow | task: queue-gate-wiring | spec: n/a | confidence: 0.95

- Add service binding from Spec DO to Gate Workflow
- Wire Spec DO /api/candidates/:id/gate/pre-merge to call Gate Workflow
- Ensure queue consumer passes all required data through the chain
- Include end-to-end integration test script
```

---

## Parallel Work Notes

This task is **independent of Artifacts Integration** and can be worked on in parallel:

- Artifacts Integration creates real repos with real push events
- Queue-Gate Wiring processes those events and triggers gates
- Both need to complete, but neither blocks the other's implementation
- Final integration test requires both to be complete

**Recommendation:** Start with Queue-Gate Wiring first, as it can be tested with existing mock repos, then verify with real repos once Artifacts Integration is complete.
