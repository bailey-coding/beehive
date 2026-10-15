---
category: setup
status: active
audience: human,agent
tags:
  - integration
  - artifacts
---

# Artifacts Integration Plan

**Status:** Ready for implementation  
**Priority:** P0 (Blocker for self-development)  
**Owner:** Agent 1  
**Estimate:** 2-3 hours  
**Worktree:** `artifacts-integration`

---

## Objective

Replace mock fork creation in `claimSpec()` with real Cloudflare Artifacts API calls so agents get actual, usable repositories.

---

## Current State

### What exists
- `workers/spec-do/index.ts:claimSpec()` creates DB records but returns mock URLs/tokens
- `scripts/spike-validation.sh` proves the Artifacts API pattern works (creates forks, pushes, validates)
- Cloudflare Artifacts CLI (`cf artifacts`) is verified working
- Auth pattern: bearer token via `http.extraHeader=Authorization: Bearer <token>`

### What's missing
- Real `cf artifacts namespaces repos create` call in `claimSpec()`
- Real token creation via `cf artifacts namespaces tokens create`
- Repository metadata persistence (namespace, remote_url, etc.)

---

## Implementation Tasks

### Task 1: Add Artifacts Client Utility (30 min)

**File:** `workers/shared/artifacts.ts` (new)

```typescript
/**
 * Cloudflare Artifacts client for fork creation and token management
 */

interface ArtifactsConfig {
  accountId: string;
  apiToken: string;
  namespace: string;
}

interface RepoInfo {
  id: string;
  name: string;
  remote: string;
  namespace: string;
}

interface ForkResult {
  repositoryId: string;
  repositoryName: string;
  remoteUrl: string;
  namespace: string;
  token: string;
  tokenExpiresAt: number;
}

export async function createFork(
  config: ArtifactsConfig,
  baselineRepo: string,
  forkName: string,
  agentId: string
): Promise<ForkResult> {
  // Implementation using cf CLI or REST API
  // Returns real fork with token
}

export async function createRepoToken(
  config: ArtifactsConfig,
  repoName: string,
  scope: 'read' | 'write' = 'write',
  ttl: number = 3600
): Promise<{ token: string; expiresAt: number }> {
  // Implementation using cf CLI or REST API
}
```

**Acceptance Criteria:**
- [ ] `createFork()` creates a real Artifacts repo
- [ ] `createRepoToken()` returns a valid write token
- [ ] Both functions handle errors gracefully

---

### Task 2: Update Spec DO claimSpec() (60 min)

**File:** `workers/spec-do/index.ts`

**Changes to `claimSpec()`:**

```typescript
claimSpec(specId: string, agentId: string): ClaimSpecResponse {
  // 1. Get spec from DB
  const spec = this.getSpec(specId);
  if (!spec) throw new Error(`Spec not found: ${specId}`);

  // 2. Generate fork name
  const namespace = 'default';
  const repoName = `candidate-${specId.slice(0, 8)}-${agentId.slice(0, 8)}`;

  // 3. Get Artifacts config from env
  const artifactsConfig = {
    accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: this.env.CLOUDFLARE_API_TOKEN,
    namespace,
  };

  // 4. Create real fork via Artifacts API
  const fork = await createFork(artifactsConfig, spec.name, repoName, agentId);

  // 5. Create token for the fork
  const { token, expiresAt } = await createRepoToken(
    artifactsConfig,
    repoName,
    'write'
  );

  // 6. Store repository record in DB
  const repositoryId = generateId();
  const repoStmt = this.db.prepare(`
    INSERT INTO repositories (id, name, organization_id, repo_type, spec_id, 
                              agent_id, remote_url, namespace, default_branch, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  repoStmt.bind(
    repositoryId,
    repoName,
    spec.organization_id,
    'candidate',
    specId,
    agentId,
    fork.remoteUrl,
    namespace,
    'main',
    now()
  );
  repoStmt.step();
  repoStmt.free();

  // 7. Create candidate record
  const candidateId = generateId();
  // ... existing candidate creation

  // 8. Return REAL data
  return {
    candidateId,
    repositoryId,
    repositoryName: repoName,
    repositoryUrl: fork.remoteUrl,
    namespace,
    token,
    tokenExpiresAt: expiresAt,
    spec,
  };
}
```

**Acceptance Criteria:**
- [ ] `claimSpec()` returns real Artifacts repo URL
- [ ] Returns valid write token
- [ ] Repository record stored in DB with correct metadata
- [ ] Candidate record created and linked

---

### Task 3: Update API Router claimSpec Handler (30 min)

**File:** `workers/api/index.ts`

**Changes to `handleClaimSpec()`:**

Remove the mock token generation and just pass through the real data from Spec DO:

```typescript
async function handleClaimSpec(
  request: Request,
  stub: DurableObjectStub
): Promise<Response> {
  const specId = extractParentId(request.url);
  const body = await request.json() as { agentId?: string };
  const actorId = request.headers.get('X-Actor-ID') || 'unknown';

  // Call Spec DO - it now returns real data
  const doResponse = await sendToSpecDo(stub, `/api/specs/${specId}/claim`, 'POST', 
    { agentId: body.agentId || actorId }, actorId);

  if (!doResponse.ok) return doResponse;

  // Pass through the real data from DO
  const doEnvelope = await doResponse.json();
  return makeApiResponse(doEnvelope.data);
}
```

**Acceptance Criteria:**
- [ ] API returns real repository URL from Spec DO
- [ ] API returns real token from Spec DO
- [ ] No mock data in the response

---

### Task 4: Add Environment Configuration (30 min)

**Files:**
- `workers/spec-do/index.ts` - Add env interface
- `wrangler.toml` (root + each worker) - Add Cloudflare secrets

**Changes:**

```toml
# In each worker's wrangler.toml or root
[vars]
CLOUDFLARE_ACCOUNT_ID = "@cf-account-id"

# Secrets (set via: wrangler secret put CLOUDFLARE_API_TOKEN)
# CLOUDFLARE_API_TOKEN is a Worker secret
```

**Type changes:**

```typescript
interface Env {
  SPEC_DO: DurableObjectNamespace;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
}
```

**Acceptance Criteria:**
- [ ] Secrets documented in README
- [ ] Local dev `.dev.vars` example provided

---

## Testing Strategy

### Unit Test
- [ ] Test `createFork()` with mock config
- [ ] Test `createRepoToken()` with mock config

### Integration Test
- [ ] Call `/api/specs/:id/claim` with real credentials
- [ ] Verify repo exists in Cloudflare console
- [ ] Verify token works for clone/push

### Manual Test Script

```bash
#!/bin/bash
# test-claim-integration.sh

# Create a test spec
SPEC_ID=$(curl -s -X POST http://localhost:8787/api/specs \
  -H "Authorization: Bearer $BEEHIVE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"test-spec","description":"Test","contract":"{}","declaredDeltaSurface":[],"organizationId":"org-1"}' \
  | jq -r '.data.id')

# Claim the spec
curl -s -X POST "http://localhost:8787/api/specs/$SPEC_ID/claim" \
  -H "Authorization: Bearer $BEEHIVE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Actor-ID: test-agent-1" \
  -d '{"agentId":"test-agent-1"}' | jq

# Verify repo exists
# cf artifacts namespaces repos list default | grep candidate
```

---

## Dependencies

- Cloudflare API token with `Artifacts:Edit` permissions
- `cf` CLI installed and authenticated
- Node.js 22+ (for `child_process` execution if needed)

---

## Rollback Plan

If Artifacts API is unavailable or too slow:
1. Keep mock implementation as fallback
2. Add feature flag: `USE_MOCK_ARTIFACTS=true`
3. Document in code comments

---

## Success Criteria

✅ Agents can claim specs and get real, usable Artifacts repositories  
✅ Tokens work for git clone/push operations  
✅ Repository metadata persists correctly in Spec DO  
✅ All changes committed with proper message format  

---

## Files Modified

| File | Change Type | Risk |
|------|-------------|------|
| `workers/shared/artifacts.ts` | New | Low |
| `workers/spec-do/index.ts` | Modified | Medium |
| `workers/api/index.ts` | Modified | Low |
| `wrangler.toml` | Modified | Low |
| `docs/ARTIFACTS-SETUP.md` | Updated | Low |

---

## Commit Message Template

```
step: implement Artifacts integration for spec claim | task: artifacts-integration | spec: n/a | confidence: 0.95

- Add artifacts.ts client with createFork() and createRepoToken()
- Update claimSpec() to create real Artifacts repos
- Update API router to pass through real repo data
- Add CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN env vars
- Include integration test script
```
