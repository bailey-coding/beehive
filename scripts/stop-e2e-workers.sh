#!/bin/bash
# Stop all Beehive workers started for local e2e testing
# Usage: ./scripts/stop-e2e-workers.sh

set -e

echo "Stopping all Beehive workers..."

# Kill wrangler processes
if pkill -f wrangler 2>/dev/null; then
    echo "  ✓ Sent termination signal to wrangler processes"
else
    echo "  - No wrangler processes found"
fi

# Kill workerd processes (Cloudflare Workers runtime)
if pkill -f workerd 2>/dev/null; then
    echo "  ✓ Sent termination signal to workerd processes"
else
    echo "  - No workerd processes found"
fi

# Give processes time to terminate
sleep 3

# Verify all processes are stopped
WRANGLER_COUNT=$(ps aux | grep -v grep | grep wrangler | wc -l)
WORKERD_COUNT=$(ps aux | grep -v grep | grep workerd | wc -l)

if [ "$WRANGLER_COUNT" -eq 0 ] && [ "$WORKERD_COUNT" -eq 0 ]; then
    echo "✓ All workers stopped successfully"
else
    echo "✗ Some processes may still be running:"
    if [ "$WRANGLER_COUNT" -gt 0 ]; then
        echo "  - $WRANGLER_COUNT wrangler process(es)"
        ps aux | grep wrangler | grep -v grep
    fi
    if [ "$WORKERD_COUNT" -gt 0 ]; then
        echo "  - $WORKERD_COUNT workerd process(es)"
        ps aux | grep workerd | grep -v grep
    fi
    echo ""
    echo "Try killing with: pkill -9 -f wrangler; pkill -9 -f workerd"
    exit 1
fi
