#!/bin/bash
# Start all Beehive workers for local e2e testing
# Usage: ./scripts/start-e2e-workers.sh
#
# This script starts the 4 workers needed for local e2e tests:
# - API worker (beehive) on port 8787 - MUST START FIRST (Spec DO host)
# - Shadow router on port 8788
# - Canary worker on port 8789
# - Promotion worker on port 8790
#
# The API worker must start first because the Spec DO is bound to it,
# and the promotion worker needs to access the Spec DO via service binding.

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "========================================"
echo "Starting Beehive workers for e2e tests"
echo "========================================"
echo ""

# Start API worker (beehive) on port 8787 - MUST BE FIRST
# This hosts the Spec DO which other workers need
echo "[1/4] Starting API worker (beehive) on port 8787..."
npx wrangler dev --config wrangler.toml --port 8787 &
API_PID=$!
echo "      API worker PID: $API_PID"
echo "      Waiting for Spec DO to initialize..."
sleep 12

# Verify API worker is healthy
if curl -s -H "Authorization: Bearer test-auth-token-12345" http://localhost:8787/health > /dev/null 2>&1; then
    echo "      ✓ API worker healthy"
else
    echo "      ✗ API worker not responding, check /tmp/wrangler-api.log"
    exit 1
fi

# Start Shadow Router on port 8788
echo "[2/4] Starting Shadow Router on port 8788..."
npx wrangler dev --config workers/shadow-router/wrangler.toml --port 8788 &
SHADOW_PID=$!
echo "      Shadow worker PID: $SHADOW_PID"
sleep 10

# Verify Shadow Router is healthy
if curl -s -H "Authorization: Bearer test-auth-token-12345" http://localhost:8788/health > /dev/null 2>&1; then
    echo "      ✓ Shadow router healthy"
else
    echo "      ✗ Shadow router not responding, check /tmp/wrangler-shadow.log"
    exit 1
fi

# Start Canary Worker on port 8789
echo "[3/4] Starting Canary worker on port 8789..."
npx wrangler dev --config workers/canary-worker/wrangler.toml --port 8789 &
CANARY_PID=$!
echo "      Canary worker PID: $CANARY_PID"
sleep 10

# Verify Canary worker is healthy
if curl -s -H "Authorization: Bearer test-auth-token-12345" http://localhost:8789/health > /dev/null 2>&1; then
    echo "      ✓ Canary worker healthy"
else
    echo "      ✗ Canary worker not responding, check /tmp/wrangler-canary.log"
    exit 1
fi

# Start Promotion Worker on port 8790
echo "[4/4] Starting Promotion worker on port 8790..."
npx wrangler dev --config workers/promotion-worker/wrangler.toml --port 8790 &
PROMO_PID=$!
echo "      Promotion worker PID: $PROMO_PID"
sleep 12

# Verify Promotion worker is healthy
if curl -s -H "Authorization: Bearer test-auth-token-12345" http://localhost:8790/promotion/health > /dev/null 2>&1; then
    echo "      ✓ Promotion worker healthy"
else
    echo "      ✗ Promotion worker not responding, check /tmp/wrangler-promotion.log"
    echo "      Note: Promotion worker needs Spec DO from API worker on 8787"
    exit 1
fi

echo ""
echo "========================================"
echo "All workers started successfully!"
echo "========================================"
echo ""
echo "Worker URLs:"
echo "  API:        http://localhost:8787"
echo "  Shadow:     http://localhost:8788"
echo "  Canary:     http://localhost:8789"
echo "  Promotion:  http://localhost:8790"
echo ""
echo "Worker PIDs: $API_PID $SHADOW_PID $CANARY_PID $PROMO_PID"
echo ""
echo "Run e2e tests with:"
echo "  npm run test:e2e"
echo ""
echo "Stop all workers with:"
echo "  pkill -f wrangler"
echo ""

# Wait for all workers to complete (they run in background)
# This keeps the script running so Ctrl+C will stop all workers
wait
