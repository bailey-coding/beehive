#!/bin/bash
# Start Gate Workflow worker
# Usage: ./scripts/start-gate.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

source "$REPO_ROOT/.env" 2>/dev/null || true

cd "$REPO_ROOT/workers/gate-workflow"

echo "Starting gate workflow worker..."
wrangler dev --local
