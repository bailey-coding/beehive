#!/bin/bash
# Trigger a preview deployment test
# This sends a test message to trigger the full preview deployment flow

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# Load tokens
if [ -f "$REPO_ROOT/.env" ]; then
  source "$REPO_ROOT/.env"
fi

API_TOKEN=${BEEHIVE_API_TOKEN:-$API_AUTH_TOKEN}

if [ -z "$API_TOKEN" ]; then
  echo "Error: No API token found. Set BEEHIVE_API_TOKEN or API_AUTH_TOKEN."
  exit 1
fi

echo "Triggering preview deployment test..."
echo ""

# Test 1: Direct call to preview-manager (tests service binding from queue-consumer)
echo "Test 1: Direct API call to preview-manager"
curl -X POST \
  https://beehive-preview-manager.bz23711.workers.dev/api/preview/deploy \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "candidateId": "test-candidate-'"$RANDOM"'",
    "repository": {
      "name": "candidate-price-calculator",
      "namespace": "bailey-coding",
      "full_name": "bailey-coding/candidate-price-calculator"
    },
    "commit": {
      "sha": "'"$(date +%s%N | sha256sum | head -c 40)"'",
      "message": "Test commit for preview deployment",
      "author": {
        "name": "Test User",
        "email": "test@beehive.test"
      },
      "timestamp": "'"$(date -u +"%Y-%m-%dT%H:%M:%SZ")"'"
    },
    "commitSha": "'"$(date +%s%N | sha256sum | head -c 40)"'",
    "baseCommitSha": "abc123def456",
    "timestamp": '"$(date +%s)"'
  }'

echo ""
echo ""
echo "========================================"
echo "Test complete!"
echo ""
echo "To verify:"
echo "1. Check preview-manager logs for deployment attempts"
echo "2. Check queue-consumer logs for message processing"
echo "3. Look for preview URL in Spec DO for the candidate"
echo ""
echo "Note: If Workers Builds API is properly configured with Workers:Edit permissions,"
echo "you should see a real Workers Builds preview being created."
