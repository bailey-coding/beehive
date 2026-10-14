#!/bin/bash
# Health check for all Beehive workers
# Usage: ./scripts/health-check.sh

BASE_URL=${BASE_URL:-http://localhost:8787}

# Load API token from .dev.vars if not set in environment
if [ -z "$API_AUTH_TOKEN" ]; then
  if [ -f ".dev.vars" ]; then
    API_AUTH_TOKEN=$(grep -o 'API_AUTH_TOKEN=[^ ]*' .dev.vars | cut -d= -f2)
  fi
fi

API_TOKEN=${API_AUTH_TOKEN:?API_AUTH_TOKEN is not set (export it or put it in .dev.vars)}

# Ports used by start-all.sh
MAIN_PORT=${MAIN_PORT:-8787}
GATE_PORT=${GATE_PORT:-8788}
QUEUE_PORT=${QUEUE_PORT:-8789}
SANDBOX_PORT=${SANDBOX_PORT:-8790}
SHADOW_PORT=${SHADOW_PORT:-8791}

echo "=========================================="
echo "Beehive Health Check"
echo "=========================================="
echo ""

# Main API
echo -n "Main API: "
if curl -s -f -H "Authorization: Bearer $API_TOKEN" "$BASE_URL/health" > /dev/null 2>&1; then
  echo "✅ HEALTHY"
else
  echo "❌ DOWN"
fi

# Spec DO (via API)
echo -n "Spec DO: "
if curl -s -f -H "Authorization: Bearer $API_TOKEN" "$BASE_URL/api/organizations" > /dev/null 2>&1; then
  echo "✅ HEALTHY"
else
  echo "❌ DOWN"
fi

# Gate Workflow
echo -n "Gate Workflow: "
if curl -s -f -H "Authorization: Bearer $API_TOKEN" "http://localhost:$GATE_PORT/health" > /dev/null 2>&1; then
  echo "✅ HEALTHY (port $GATE_PORT)"
else
  echo "❌ DOWN (expected port $GATE_PORT)"
fi

# Queue Consumer
echo -n "Queue Consumer: "
if curl -s -f -H "Authorization: Bearer $API_TOKEN" "http://localhost:$QUEUE_PORT/queue/health" > /dev/null 2>&1; then
  echo "✅ HEALTHY (port $QUEUE_PORT)"
else
  echo "❌ DOWN (expected port $QUEUE_PORT)"
fi

# Sandbox Runner
echo -n "Sandbox Runner: "
if curl -s -f -H "Authorization: Bearer $API_TOKEN" "http://localhost:$SANDBOX_PORT/health" > /dev/null 2>&1; then
  echo "✅ HEALTHY (port $SANDBOX_PORT)"
else
  echo "❌ DOWN (expected port $SANDBOX_PORT)"
fi

# Shadow Router
echo -n "Shadow Router: "
if curl -s -f "http://localhost:$SHADOW_PORT/health" > /dev/null 2>&1; then
  echo "✅ HEALTHY (port $SHADOW_PORT)"
else
  echo "❌ DOWN (expected port $SHADOW_PORT)"
fi

echo ""
echo "=========================================="
