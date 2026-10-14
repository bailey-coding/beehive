#!/bin/bash
# Simple Beehive Health Test
# Tests basic API connectivity without jq

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load test environment
source "$SCRIPT_DIR/.env.test" 2>/dev/null || true

echo "=========================================="
echo "Beehive Simple Connectivity Test"
echo "=========================================="

BASE_URL=${BASE_URL:-http://localhost:8787}
API_TOKEN=${BEEHIVE_API_TOKEN:?BEEHIVE_API_TOKEN is not set}

echo ""
echo "[1/3] Testing health endpoint..."
HEALTH=$(curl -s -f -H "Authorization: Bearer $API_TOKEN" "$BASE_URL/health" 2>&1)
if echo "$HEALTH" | grep -q '"status":"healthy"'; then
  echo "✅ Health check passed"
else
  echo "❌ FAILED: Health check failed"
  echo "$HEALTH"
  exit 1
fi

echo ""
echo "[2/3] Testing organizations endpoint..."
ORGS=$(curl -s -f -H "Authorization: Bearer $API_TOKEN" "$BASE_URL/api/organizations" 2>&1)
if echo "$ORGS" | grep -q '"success":true'; then
  echo "✅ Organizations endpoint works"
else
  echo "❌ FAILED: Organizations endpoint failed"
  echo "$ORGS"
  exit 1
fi

echo ""
echo "[3/3] Testing specs endpoint..."
SPECS=$(curl -s -f -H "Authorization: Bearer $API_TOKEN" "$BASE_URL/api/specs" 2>&1)
if echo "$SPECS" | grep -q '"success":true'; then
  echo "✅ Specs endpoint works"
else
  echo "❌ FAILED: Specs endpoint failed"
  echo "$SPECS"
  exit 1
fi

echo ""
echo "=========================================="
echo "✅ All connectivity tests passed!"
echo "=========================================="
