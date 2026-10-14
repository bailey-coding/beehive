#!/bin/bash
# Stop all Beehive workers
# Usage: ./scripts/stop-all.sh

echo "Stopping Beehive workers..."

# Kill tmux session if exists
tmux kill-session -t beehive 2>/dev/null || true

# Kill by PID files if they exist
for pidfile in /tmp/beehive-*.pid; do
  if [ -f "$pidfile" ]; then
    pid=$(cat "$pidfile")
    if ps -p "$pid" > /dev/null 2>&1; then
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
  fi
done

# Kill all wrangler dev processes
pkill -f "wrangler dev" 2>/dev/null || true

# Kill all node processes related to wrangler
pkill -f "workers/" 2>/dev/null || true

echo "✅ All workers stopped"
