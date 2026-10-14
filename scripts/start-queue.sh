#!/bin/bash
# Start Queue Consumer worker
# Usage: ./scripts/start-queue.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

source "$REPO_ROOT/.env" 2>/dev/null || true

cd "$REPO_ROOT/workers/queue-consumer"

echo "Starting queue consumer worker..."
wrangler dev --local
