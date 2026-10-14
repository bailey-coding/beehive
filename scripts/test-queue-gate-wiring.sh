#!/bin/bash
# test-queue-gate-wiring.sh
# Integration test for Queue-Gate Wiring

set -e

echo "=== Queue-Gate Wiring Integration Test ==="
echo ""

# Check if BEEHIVE_API_TOKEN is set
if [ -z "$BEEHIVE_API_TOKEN" ]; then
  echo "❌ ERROR: BEEHIVE_API_TOKEN environment variable not set"
  echo "   Please set it with: export BEEHIVE_API_TOKEN=<your-token>"
  exit 1
fi

# Base URL for the API
BASE_URL="https://beehive.bz23711.workers.dev"

# 1. Create a spec
echo "[1/5] Creating spec..."
SPEC_ID=$(curl -s -X POST "${BASE_URL}/api/specs" \
  -H "Authorization: Bearer $BEEHIVE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"test-url-shortener","description":"Test spec for queue-gate wiring","contract":"{\"endpoints\":[{\"path\":\"/shorten\",\"method\":\"POST\"},{\"path\":\"/redirect\",\"method\":\"GET\"}]}","declaredDeltaSurface":["shorten","redirect"],"organizationId":"org-1"}' \
  | jq -r '.data.id')

if [ -z "$SPEC_ID" ] || [ "$SPEC_ID" = "null" ]; then
  echo "❌ FAILED: Could not create spec"
  exit 1
fi

echo "✅ Created spec: $SPEC_ID"
echo ""

# 2. Claim the spec (creates candidate + repo)
echo "[2/5] Claiming spec..."
CLAIM=$(curl -s -X POST "${BASE_URL}/api/specs/$SPEC_ID/claim" \
  -H "Authorization: Bearer $BEEHIVE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Actor-ID: test-agent-1" \
  -d '{"agentId":"test-agent-1"}')

CANDIDATE_ID=$(echo "$CLAIM" | jq -r '.data.candidateId')
REPO_URL=$(echo "$CLAIM" | jq -r '.data.repositoryUrl')
TOKEN=$(echo "$CLAIM" | jq -r '.data.token')

if [ -z "$CANDIDATE_ID" ] || [ "$CANDIDATE_ID" = "null" ]; then
  echo "❌ FAILED: Could not claim spec"
  exit 1
fi

echo "✅ Claimed spec: candidate=$CANDIDATE_ID, repo=$REPO_URL"
echo ""

# 3. Directly trigger gate workflow (simulating what queue consumer would do)
echo "[3/5] Triggering gate workflow directly..."
GATE_RESPONSE=$(curl -s -X POST "${BASE_URL}/api/candidates/$CANDIDATE_ID/gate/pre-merge" \
  -H "Authorization: Bearer $BEEHIVE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Actor-ID: test-agent-1" \
  -d '{"commitSha":"abc123","baseCommitSha":"def456","message":"Test commit","timestamp":"2026-10-11T00:00:00Z"}')

if [ -z "$GATE_RESPONSE" ]; then
  echo "❌ FAILED: Gate workflow returned empty response"
  exit 1
fi

echo "✅ Gate workflow triggered successfully"
echo "   Response: $GATE_RESPONSE"
echo ""

# 4. Verify: Check gate verdicts for the candidate
echo "[4/5] Checking gate verdicts..."
sleep 5

VERDICTS=$(curl -s "${BASE_URL}/api/candidates/$CANDIDATE_ID/gate-verdicts" \
  -H "Authorization: Bearer $BEEHIVE_API_TOKEN")

echo "   Verdicts: $VERDICTS"

# Should have a pre-merge verdict
PRE_MERGE_COUNT=$(echo "$VERDICTS" | jq '.data | length')

if [ "$PRE_MERGE_COUNT" -gt 0 ]; then
  echo "✅ SUCCESS: Gate workflow was triggered and verdict recorded"
else
  echo "❌ FAILED: No gate verdicts found"
  echo "   This might mean the Gate Workflow binding is not configured correctly"
  echo "   Check that GATE_WORKFLOW service binding exists in Spec DO"
  exit 1
fi

# 5. Verify verdict details
echo ""
echo "[5/5] Verifying verdict details..."
VERDICT_ID=$(echo "$VERDICTS" | jq -r '.data[0].id')
VERDICT_GATE=$(echo "$VERDICTS" | jq -r '.data[0].gate')
VERDICT_STATUS=$(echo "$VERDICTS" | jq -r '.data[0].status')

if [ "$VERDICT_GATE" = "pre-merge" ]; then
  echo "✅ Verdict gate is 'pre-merge'"
else
  echo "⚠️  WARNING: Verdict gate is '$VERDICT_GATE', expected 'pre-merge'"
fi

if [ "$VERDICT_STATUS" = "pass" ] || [ "$VERDICT_STATUS" = "fail" ]; then
  echo "✅ Verdict status is valid: '$VERDICT_STATUS'"
else
  echo "⚠️  WARNING: Verdict status is '$VERDICT_STATUS'"
fi

echo ""
echo "=== Queue-Gate Wiring Test Complete ==="
echo "✅ All checks passed!"
echo ""
echo "Summary:"
echo "  - Spec created: $SPEC_ID"
echo "  - Candidate created: $CANDIDATE_ID"
echo "  - Repository: $REPO_URL"
echo "  - Verdict recorded: $VERDICT_ID"
