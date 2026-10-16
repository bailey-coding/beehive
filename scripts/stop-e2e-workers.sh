#!/bin/bash
# Stop the Beehive workers started by scripts/start-e2e-workers.sh
# Usage: ./scripts/stop-e2e-workers.sh
#
# Stops only the PIDs recorded in .e2e-workers.pids and their descendants
# (npx -> sh -> wrangler -> workerd), never other wrangler/workerd processes.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$REPO_ROOT/.e2e-workers.pids"

if [ ! -s "$PID_FILE" ]; then
    echo "- No .e2e-workers.pids file; nothing started by start-e2e-workers.sh to stop"
    exit 0
fi

# Children first, so no workerd is left orphaned
kill_tree() {
    local pid="$1" child
    for child in $(ps -o pid= --ppid "$pid" 2>/dev/null); do
        kill_tree "$child"
    done
    kill "$pid" 2>/dev/null || true
}

echo "Stopping Beehive e2e workers..."
while read -r pid; do
    [ -n "$pid" ] || continue
    if kill -0 "$pid" 2>/dev/null; then
        kill_tree "$pid"
        echo "  ✓ Stopped PID $pid and its children"
    else
        echo "  - PID $pid already gone"
    fi
done < "$PID_FILE"

rm -f "$PID_FILE"
