#!/bin/bash
# Start all Beehive workers for local development
# Usage: ./scripts/start-all.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

echo "=========================================="
echo "Starting Beehive Workers"
echo "=========================================="

# Load environment
if [ -f "$REPO_ROOT/.env" ]; then
  echo "Loading environment from .env"
  source "$REPO_ROOT/.env"
fi

# Export account ID from .cloudflare cache if not set
if [ -z "$CLOUDFLARE_ACCOUNT_ID" ]; then
  ACCOUNT_FILE="$REPO_ROOT/.cloudflare/cache/cloudflare-account.json"
  if [ -f "$ACCOUNT_FILE" ]; then
    CLOUDFLARE_ACCOUNT_ID=$(grep -o '"id": *"[^"]*"' "$ACCOUNT_FILE" | sed -E 's/.*"id": *"([^"]*)".*/\1/')
    export CLOUDFLARE_ACCOUNT_ID
    echo "Loaded CLOUDFLARE_ACCOUNT_ID from .cloudflare cache"
  fi
fi

# Try to load CLOUDFLARE_API_TOKEN from various sources
if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
  # Try .cloudflare config
  CF_CONFIG="$HOME/.config/cloudflare/config/default.json"
  if [ -f "$CF_CONFIG" ]; then
    CLOUDFLARE_API_TOKEN=$(grep -o '"api_token": *"[^"]*"' "$CF_CONFIG" | sed -E 's/.*"api_token": *"([^"]*)".*/\1/' || true)
  fi
fi

if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
  # Try .env file
  if [ -f "$REPO_ROOT/.env" ]; then
    CLOUDFLARE_API_TOKEN=$(grep -o 'CLOUDFLARE_API_TOKEN=[^ ]*' "$REPO_ROOT/.env" | cut -d= -f2 || true)
  fi
fi

echo ""
echo "Environment:"
echo "  CLOUDFLARE_ACCOUNT_ID: ${CLOUDFLARE_ACCOUNT_ID:0:12}..."
echo "  CLOUDFLARE_API_TOKEN: ${CLOUDFLARE_API_TOKEN:0:12}..."
echo "  BEEHIVE_API_TOKEN: ${BEEHIVE_API_TOKEN:0:12}..."
echo ""

# Kill existing workers
"$SCRIPT_DIR/stop-all.sh" 2>/dev/null || true

sleep 1

# Start all workers as background processes
echo "Starting workers as background processes..."

# Load API_AUTH_TOKEN from .dev.vars
if [ -z "$API_AUTH_TOKEN" ]; then
  if [ -f "$REPO_ROOT/.dev.vars" ]; then
    API_AUTH_TOKEN=$(grep -o 'API_AUTH_TOKEN=[^ ]*' "$REPO_ROOT/.dev.vars" | cut -d= -f2)
  fi
fi

# Use npx to run locally installed wrangler
# Main worker (API + Spec DO) - port 8787
cd "$REPO_ROOT"
npx wrangler dev --local --port 8787 \
  --var CLOUDFLARE_ACCOUNT_ID:$CLOUDFLARE_ACCOUNT_ID \
  --var API_AUTH_TOKEN:$API_AUTH_TOKEN \
  --var CLOUDFLARE_API_TOKEN:$CLOUDFLARE_API_TOKEN > /tmp/beehive-main.log 2>&1 &
MAIN_PID=$!
echo "  Main worker started (PID: $MAIN_PID) - port 8787"

# Wait for main to fully initialize
sleep 5

# Gate Workflow - port 8788
cd "$REPO_ROOT/workers/gate-workflow"
npx wrangler dev --local --port 8788 \
  --var CLOUDFLARE_ACCOUNT_ID:$CLOUDFLARE_ACCOUNT_ID \
  --var API_AUTH_TOKEN:$API_AUTH_TOKEN \
  --var CLOUDFLARE_API_TOKEN:$CLOUDFLARE_API_TOKEN > /tmp/beehive-gate.log 2>&1 &
GATE_PID=$!
echo "  Gate workflow started (PID: $GATE_PID) - port 8788"

# Wait for gate to initialize
sleep 3

# Queue Consumer - port 8789
cd "$REPO_ROOT/workers/queue-consumer"
npx wrangler dev --local --port 8789 \
  --var CLOUDFLARE_ACCOUNT_ID:$CLOUDFLARE_ACCOUNT_ID \
  --var API_AUTH_TOKEN:$API_AUTH_TOKEN \
  --var CLOUDFLARE_API_TOKEN:$CLOUDFLARE_API_TOKEN > /tmp/beehive-queue.log 2>&1 &
QUEUE_PID=$!
echo "  Queue consumer started (PID: $QUEUE_PID) - port 8789"

# Wait for queue to initialize
sleep 3

# Sandbox Runner - port 8790
cd "$REPO_ROOT/workers/sandbox-runner"
npx wrangler dev --local --port 8790 \
  --var CLOUDFLARE_ACCOUNT_ID:$CLOUDFLARE_ACCOUNT_ID \
  --var API_AUTH_TOKEN:$API_AUTH_TOKEN \
  --var CLOUDFLARE_API_TOKEN:$CLOUDFLARE_API_TOKEN > /tmp/beehive-sandbox.log 2>&1 &
SANDBOX_PID=$!
echo "  Sandbox runner started (PID: $SANDBOX_PID) - port 8790"

# Wait for sandbox to initialize
sleep 3

# Shadow Router - port 8791
cd "$REPO_ROOT/workers/shadow-router"
npx wrangler dev --local --port 8791 \
  --var CLOUDFLARE_ACCOUNT_ID:$CLOUDFLARE_ACCOUNT_ID \
  --var API_AUTH_TOKEN:$API_AUTH_TOKEN \
  --var CLOUDFLARE_API_TOKEN:$CLOUDFLARE_API_TOKEN > /tmp/beehive-shadow.log 2>&1 &
SHADOW_PID=$!
echo "  Shadow router started (PID: $SHADOW_PID) - port 8791"

# Wait for shadow to initialize
sleep 3

# Scientist Comparator - port 8792
cd "$REPO_ROOT/workers/scientist-comparator"
npx wrangler dev --local --port 8792 \
  --var CLOUDFLARE_ACCOUNT_ID:$CLOUDFLARE_ACCOUNT_ID \
  --var API_AUTH_TOKEN:$API_AUTH_TOKEN \
  --var CLOUDFLARE_API_TOKEN:$CLOUDFLARE_API_TOKEN > /tmp/beehive-scientist.log 2>&1 &
SCIENTIST_PID=$!
echo "  Scientist comparator started (PID: $SCIENTIST_PID) - port 8792"

# Wait for scientist to initialize
sleep 3

# Preview Manager - port 8793
cd "$REPO_ROOT/workers/preview-manager"
npx wrangler dev --local --port 8793 \
  --var CLOUDFLARE_ACCOUNT_ID:$CLOUDFLARE_ACCOUNT_ID \
  --var API_AUTH_TOKEN:$API_AUTH_TOKEN \
  --var CLOUDFLARE_API_TOKEN:$CLOUDFLARE_API_TOKEN > /tmp/beehive-preview-manager.log 2>&1 &
PREVIEW_MANAGER_PID=$!
echo "  Preview manager started (PID: $PREVIEW_MANAGER_PID) - port 8793"

# Wait for preview manager to initialize
sleep 3

# Candidate Service - port 8794
cd "$REPO_ROOT/workers/candidate-service"
npx wrangler dev --local --port 8794 \
  --var CLOUDFLARE_ACCOUNT_ID:$CLOUDFLARE_ACCOUNT_ID \
  --var API_AUTH_TOKEN:$API_AUTH_TOKEN \
  --var CLOUDFLARE_API_TOKEN:$CLOUDFLARE_API_TOKEN > /tmp/beehive-candidate-service.log 2>&1 &
CANDIDATE_SERVICE_PID=$!
echo "  Candidate service started (PID: $CANDIDATE_SERVICE_PID) - port 8794"

# Save PIDs to file for stop-all.sh
cd "$REPO_ROOT"
echo "$MAIN_PID" > /tmp/beehive-main.pid
echo "$GATE_PID" > /tmp/beehive-gate.pid
echo "$QUEUE_PID" > /tmp/beehive-queue.pid
echo "$SANDBOX_PID" > /tmp/beehive-sandbox.pid
echo "$SHADOW_PID" > /tmp/beehive-shadow.pid
echo "$SCIENTIST_PID" > /tmp/beehive-scientist.pid
echo "$PREVIEW_MANAGER_PID" > /tmp/beehive-preview-manager.pid
echo "$CANDIDATE_SERVICE_PID" > /tmp/beehive-candidate-service.pid

echo ""
echo "=========================================="
echo "✅ All workers starting as background processes"
echo "=========================================="
echo ""
echo "Logs:"
echo "  Main:              tail -f /tmp/beehive-main.log"
echo "  Gate:              tail -f /tmp/beehive-gate.log"
echo "  Queue:             tail -f /tmp/beehive-queue.log"
echo "  Sandbox:           tail -f /tmp/beehive-sandbox.log"
echo "  Shadow:            tail -f /tmp/beehive-shadow.log"
echo "  Scientist:         tail -f /tmp/beehive-scientist.log"
echo "  Preview Manager:   tail -f /tmp/beehive-preview-manager.log"
echo "  Candidate Service:  tail -f /tmp/beehive-candidate-service.log"
echo "To stop:   ./scripts/stop-all.sh"
echo ""
echo "Wait ~10 seconds for all workers to initialize, then:"
echo "  ./scripts/health-check.sh"
echo ""
