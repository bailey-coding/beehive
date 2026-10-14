#!/bin/bash
# End-to-End Verification Test for Beehive
# Tests: Spec -> Claim -> Fork -> Commit -> Push -> Queue -> Gate -> Verdict

set -e

# Load test environment
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/.env.test" 2>/dev/null || true

echo "=========================================="
echo "Beehive End-to-End Verification"
echo "=========================================="

# Configuration
BASE_URL=${BASE_URL:-http://localhost:8787}
API_TOKEN=${BEEHIVE_API_TOKEN:?Error: BEEHIVE_API_TOKEN not set}

# Cleanup temp files
cleanup() {
  rm -rf /tmp/test-candidate-repo
}
trap cleanup EXIT

# Step 1: Create a test spec
echo ""
echo "[1/6] Creating test spec..."
SPEC_RESPONSE=$(curl -s -X POST "$BASE_URL/api/specs" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "e2e-test-shortener",
    "description": "End-to-end verification spec",
    "contract": "{\"endpoints\":[{\"path\":\"/shorten\",\"method\":\"POST\"}]}",
    "declaredDeltaSurface": ["shorten", "redirect"],
    "organizationId": "org-1"
  }')

# Check if success is true using grep
if ! echo "$SPEC_RESPONSE" | grep -q '"success":true'; then
  echo "❌ FAILED: Could not create spec"
  echo "$SPEC_RESPONSE"
  exit 1
fi

# Extract SPEC_ID using grep and sed
SPEC_ID=$(echo "$SPEC_RESPONSE" | grep -o '"id":"[^"]*"' | sed -E 's/.*"id":"([^"]*)".*/\1/')
echo "✅ Spec created: $SPEC_ID"

# Step 2: Claim spec (creates real Artifacts fork)
echo ""
echo "[2/6] Claiming spec..."
CLAIM_RESPONSE=$(curl -s -X POST "$BASE_URL/api/specs/$SPEC_ID/claim" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Actor-ID: e2e-test-agent" \
  -d '{"agentId": "e2e-test-agent"}')

if ! echo "$CLAIM_RESPONSE" | jq -e '.success' > /dev/null; then
  echo "❌ FAILED: Could not claim spec"
  echo "$CLAIM_RESPONSE"
  exit 1
fi

CANDIDATE_ID=$(echo "$CLAIM_RESPONSE" | jq -r '.data.candidateId')
REPO_URL=$(echo "$CLAIM_RESPONSE" | jq -r '.data.repositoryUrl')
TOKEN=$(echo "$CLAIM_RESPONSE" | jq -r '.data.token')
NAMESPACE=$(echo "$CLAIM_RESPONSE" | jq -r '.data.namespace')

echo "✅ Spec claimed: candidate=$CANDIDATE_ID, repo=$REPO_URL"

# Step 3: Clone, commit, push
echo ""
echo "[3/6] Developing in fork..."
cd /tmp
rm -rf test-candidate-repo
git clone -c "http.extraHeader=Authorization: Bearer $TOKEN" "$REPO_URL" test-candidate-repo 2>&1 | grep -v "Cloning into" || true
cd test-candidate-repo

# Create minimal implementation
echo 'module.exports = { shorten: () => "abc123" }' > index.js
cat > package.json << 'EOF'
{"name":"test-candidate","version":"1.0.0","scripts":{"test":"node index.js"}}
EOF

git add .
git config user.email "test@beehive.dev"
git config user.name "E2E Test Agent"
git commit -m "feat: implement spec | task: e2e | spec: n/a | confidence: 1.0" 2>&1 | grep -v "^\s*$" || true
git push origin main 2>&1 | grep -v "^\s*$" || true

echo "✅ Code pushed to fork"

# Step 4: Wait for queue processing
echo ""
echo "[4/6] Waiting for queue consumer (10 seconds)..."
sleep 10

# Step 5: Check queue consumer logs
# (If running locally, check Terminal 3 for queue consumer output)
echo "✅ Queue consumer should have processed push event"

# Step 6: Verify gate verdict recorded
echo ""
echo "[5/6] Checking gate verdict..."
sleep 5

VERDICT_RESPONSE=$(curl -s "$BASE_URL/api/candidates/$CANDIDATE_ID/gate-verdicts" \
  -H "Authorization: Bearer $API_TOKEN")

VERDICT_COUNT=$(echo "$VERDICT_RESPONSE" | jq '.data | length' 2>/dev/null || echo "0")

if [ "$VERDICT_COUNT" -gt 0 ]; then
  echo "✅ SUCCESS: Gate workflow executed, verdict recorded"
  echo "$VERDICT_RESPONSE" | jq '.data[] | {gate, status, score}'
  exit 0
else
  echo "❌ FAILED: No gate verdict found after 15 seconds"
  echo "Response: $VERDICT_RESPONSE"
  exit 1
fi
