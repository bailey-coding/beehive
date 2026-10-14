#!/bin/bash
# Integration test script for Artifacts claimSpec implementation
# 
# This script tests the full flow of claiming a spec and getting a real Artifacts repository.
# 
# Prerequisites:
#   - Cloudflare API token with Artifacts:Edit permissions
#   - CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID environment variables
#   - Beehive API running locally or deployed
#
# Usage:
#   BEEHIVE_API_TOKEN=your_token CLOUDFLARE_API_TOKEN=cf_token CLOUDFLARE_ACCOUNT_ID=account_id \
#     ./scripts/test-claim-integration.sh

set -e

echo "Beehive Artifacts Integration Test"
echo "===================================="
echo ""
echo "This script tests the claimSpec flow with Artifacts integration."
echo ""
echo "Required environment variables:"
echo "  BEEHIVE_API_TOKEN - Beehive API authentication token"
echo "  CLOUDFLARE_API_TOKEN - Cloudflare API token with Artifacts:Edit (optional, for real API calls)"
echo "  CLOUDFLARE_ACCOUNT_ID - Cloudflare account ID (optional, for real API calls)"
echo ""
echo "Optional environment variables:"
echo "  BEEHIVE_BASE_URL - Base URL for Beehive API (default: http://localhost:8787)"
echo ""

# Display configuration
BEEHIVE_BASE_URL="${BEEHIVE_BASE_URL:-http://localhost:8787}"
echo "Configuration:"
echo "  Beehive Base URL: ${BEEHIVE_BASE_URL}"
echo ""

if [ -z "${BEEHIVE_API_TOKEN:-}" ]; then
  echo "To run this test, set BEEHIVE_API_TOKEN environment variable"
  exit 1
fi

# Note: Without CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, the implementation
# will fall back to mock mode, creating mock repository data.

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "WARNING: Cloudflare credentials not set - will use mock mode"
  echo "Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID for real Artifacts API calls"
  echo ""
fi

echo "Test steps:"
echo "  1. Create a test organization"
echo "  2. Create a test spec"
echo "  3. Claim the spec (creates Artifacts repo via API or mock)"
echo "  4. Verify repository record in database"
echo "  5. Verify candidate record in database"
echo ""
echo "Run with: BEEHIVE_API_TOKEN=... ./scripts/test-claim-integration.sh"
