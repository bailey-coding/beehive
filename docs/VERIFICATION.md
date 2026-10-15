---
category: verification
status: active
audience: human,agent
tags:
  - verification
  - testing
---

# End-to-End Verification Guide

> **Status**: Ready for verification  
> **Last updated**: 2026-10-11  
> **Target**: Prove complete pre-merge oracle pipeline works
>
> **Troubleshooting**: See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for common issues and fixes

---

## 🎯 Pipeline to Verify

```
Spec Created → Agent Claims → Real Artifacts Fork Created → 
Agent Commits → Push → Queue Consumer → Gate Workflow → Verdict Recorded
```

---

## ✅ What's Implemented

| Component | Location | Status |
|-----------|----------|--------|
| Spec Creation API | `workers/api/index.ts` | ✅ Working |
| Spec Claim (Artifacts Integration) | `workers/spec-do/index.ts:claimSpec()` | ✅ Uses `createFork()` |
| Artifacts Client | `workers/shared/artifacts.ts` | ✅ Real API calls |
| Queue Consumer | `workers/queue-consumer/index.ts` | ✅ Processes push events |
| Queue → Gate Wiring | `workers/queue-consumer/index.ts:110` | ✅ Calls Spec DO |
| Gate Workflow | `workers/gate-workflow/index.ts` | ✅ Executes gates |
| Spec DO → Gate Wiring | `workers/spec-do/index.ts:1676` | ✅ Service binding |

---

## 🧪 Manual Verification Steps

### Setup Environment

```bash
# In repo root
export CLOUDFLARE_API_TOKEN=<redacted-cloudflare-api-token>
export BEEHIVE_API_TOKEN=<your-beehive-api-token>
export CLOUDFLARE_ACCOUNT_ID=bb21fa3c93c3cc02ac97b091b2d57811
```

### Terminal 1: Start Main Worker + Spec DO

```bash
# In repo root
wrangler dev --local --var CLOUDFLARE_ACCOUNT_ID:bb21fa3c93c3cc02ac97b091b2d57811
# Runs on :8787
```

### Terminal 2: Start Gate Workflow

```bash
# In workers/gate-workflow
wrangler dev --local
# Runs on :8788 (check wrangler.toml for port)
```

### Terminal 3: Start Queue Consumer

```bash
# In workers/queue-consumer  
wrangler dev --local
# Runs on :8789 (check wrangler.toml for port)
```

### Terminal 4: Create Queue (if not exists)

```bash
# In repo root
npm run queue:create
```

---

### Step 1: Create a Spec

```bash
curl -X POST http://localhost:8787/api/specs \
  -H "Authorization: Bearer $BEEHIVE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "e2e-test-shortener",
    "description": "End-to-end verification spec",
    "contract": "{\"endpoints\":[{\"path\":\"/shorten\",\"method\":\"POST\"}]}",
    "declaredDeltaSurface": ["shorten", "redirect"],
    "organizationId": "org-1"
  }'
```

**Extract spec ID:**
```bash
SPEC_ID=$(curl ... | jq -r '.data.id')
echo "Spec: $SPEC_ID"
```

---

### Step 2: Claim Spec (Creates Real Fork)

```bash
CLAIM=$(curl -X POST "http://localhost:8787/api/specs/$SPEC_ID/claim" \
  -H "Authorization: Bearer $BEEHIVE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Actor-ID: e2e-test-agent" \
  -d '{"agentId": "e2e-test-agent"}')

CANDIDATE_ID=$(echo "$CLAIM" | jq -r '.data.candidateId')
REPO_URL=$(echo "$CLAIM" | jq -r '.data.repositoryUrl')
TOKEN=$(echo "$CLAIM" | jq -r '.data.token')
NAMESPACE=$(echo "$CLAIM" | jq -r '.data.namespace')

echo "Candidate: $CANDIDATE_ID"
echo "Repo URL: $REPO_URL"
echo "Namespace: $NAMESPACE"
```

**Verify fork exists:**
```bash
cf artifacts namespaces repos list $NAMESPACE | grep $CANDIDATE_ID
```

---

### Step 3: Develop and Push Code

```bash
cd /tmp
rm -rf test-candidate-repo
git clone -c "http.extraHeader=Authorization: Bearer $TOKEN" "$REPO_URL" test-candidate-repo
cd test-candidate-repo

# Add minimal implementation
echo 'module.exports = { shorten: () => "abc123" }' > index.js

cat > package.json << 'EOF'
{"name":"test-candidate","version":"1.0.0","scripts":{"test":"node index.js"}}
EOF

git add .
git config user.email "test@beehive.dev"
git config user.name "E2E Test Agent"
git commit -m "feat: implement spec | task: e2e | spec: n/a | confidence: 1.0"
git push origin main
```

---

### Step 4: Monitor Queue Consumer

**In Terminal 3, should see:**
```
[QueueConsumer] Received push event: <event-id> for <repo>@<sha>
[QueueConsumer] Found candidate <candidate-id> for push event
[QueueConsumer] Gate workflow triggered: {"success": true, ...}
```

---

### Step 5: Monitor Gate Workflow

**In Terminal 2, should see:**
```
[Gate] Cloning candidate <candidate-id> for pre-merge gate
[Gate] Running unit tests for <candidate-id>
[Gate] Running property tests for <candidate-id>
[Gate] Calculating complexity delta for <candidate-id>
[Gate] Validating spec conformance for <candidate-id>
[Gate] Aggregating results for <candidate-id>
```

---

### Step 6: Verify Verdict Recorded

```bash
# Wait 10-15 seconds for processing
sleep 15

# Check gate verdicts
curl "http://localhost:8787/api/candidates/$CANDIDATE_ID/gate-verdicts" \
  -H "Authorization: Bearer $BEEHIVE_API_TOKEN" | jq
```

**Expected output:**
```json
{
  "success": true,
  "data": [{
    "id": "...",
    "candidateId": "$CANDIDATE_ID",
    "gate": "pre-merge",
    "status": "pass",
    "score": 85,
    "metrics": {...},
    "createdAt": 1234567890
  }]
}
```

---

## ✅ Success Criteria

| Step | Condition | Status |
|------|-----------|--------|
| 1 | Spec created with valid ID | ⬜ |
| 2 | Real Artifacts repo created, valid token returned | ⬜ |
| 3 | Push succeeds without errors | ⬜ |
| 4 | Queue consumer logs show event received | ⬜ |
| 5 | Gate workflow logs show execution | ⬜ |
| 6 | Gate verdict recorded in Spec DO | ⬜ |

**If all 6 are ✅, the pre-merge oracle is working.**

---

## 🐛 Known Issues / Workarounds

### Mocked Tests
The gate workflow currently runs **mocked tests** (returns hardcoded pass/fail). Real test execution requires:
- Cloning candidate repo from Artifacts
- Running `npm test` / `pytest` in a sandbox
- Parsing test results

**Workaround for verification:** Mocks are sufficient to prove the pipeline works. Real execution is M2 work.

### CLOUDFLARE_ACCOUNT_ID Required
The main wrangler.toml uses `@cf-account-id` placeholder. For local dev:
- Set via `--var CLOUDFLARE_ACCOUNT_ID:<id>` in wrangler dev
- Or set in `.dev.vars`
- Or set as environment variable

Account ID: `bb21fa3c93c3cc02ac97b091b2d57811`

### Service Bindings
For multi-worker local dev, service bindings resolve through wrangler's dev registry by worker name. Ensure:
- Each worker's wrangler.toml has correct `name`
- Bindings reference the correct worker name
- All workers run simultaneously

---

## 📋 Test Script

An automated test script is available at `test-end-to-end.sh`:

```bash
# Make executable
chmod +x test-end-to-end.sh

# Run (requires all workers running)
./test-end-to-end.sh
```

---

## 🎉 Expected Outcome

After successful verification:
- ✅ Agents can create specs
- ✅ Agents can claim specs (getting real Artifacts repos)
- ✅ Agents can develop in their forks
- ✅ Push events trigger the gate workflow
- ✅ Gate verdicts are recorded
- ✅ **Beehive is self-developing ready**

---

## 📞 Troubleshooting

### No push events received
1. Verify queue consumer is running: `curl http://localhost:8789/health`
2. Verify queue exists: `npm run queue:create`
3. Check Artifacts webhook configuration

### Gate workflow not triggered
1. Verify service binding in Spec DO: `GATE_WORKFLOW: Service`
2. Check queue consumer logs for errors
3. Verify gate workflow is running: `curl http://localhost:8788/health`

### Artifacts fork not created
1. Verify `CLOUDFLARE_API_TOKEN` has correct permissions
2. Verify `CLOUDFLARE_ACCOUNT_ID` is set
3. Check `workers/shared/artifacts.ts` for API call errors

### Permission errors
1. Set `API_AUTH_TOKEN` for all workers: `wrangler secret put API_AUTH_TOKEN`
2. For local dev: set `API_AUTH_TOKEN=dev-local-spike-token` in `.dev.vars`
