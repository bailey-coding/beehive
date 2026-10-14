#!/bin/bash
# Start Sandbox Runner worker
# Usage: ./scripts/start-sandbox.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

source "$REPO_ROOT/.env" 2>/dev/null || true

cd "$REPO_ROOT/workers/sandbox-runner"

echo "Starting sandbox runner worker..."
wrangler dev --local
