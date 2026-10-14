#!/bin/bash
# Start main Beehive worker (API + Spec DO)
# Usage: ./scripts/start-main.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

source "$REPO_ROOT/.env" 2>/dev/null || true

# Get account ID from .cloudflare cache
if [ -z "$CLOUDFLARE_ACCOUNT_ID" ]; then
  ACCOUNT_FILE="$REPO_ROOT/.cloudflare/cache/cloudflare-account.json"
  if [ -f "$ACCOUNT_FILE" ]; then
    CLOUDFLARE_ACCOUNT_ID=$(grep -o '"id": *"[^"]*"' "$ACCOUNT_FILE" | sed -E 's/.*"id": *"([^"]*)".*/\1/')
  fi
fi

# Load CLOUDFLARE_API_TOKEN
if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
  CF_CONFIG="$HOME/.config/cloudflare/config/default.json"
  if [ -f "$CF_CONFIG" ]; then
    CLOUDFLARE_API_TOKEN=$(grep -o '"api_token": *"[^"]*"' "$CF_CONFIG" | sed -E 's/.*"api_token": *"([^"]*)".*/\1/' || true)
  fi
fi

cd "$REPO_ROOT"

echo "Starting main worker on port 8787..."
echo "CLOUDFLARE_ACCOUNT_ID: ${CLOUDFLARE_ACCOUNT_ID:0:12}..."
echo "CLOUDFLARE_API_TOKEN: ${CLOUDFLARE_API_TOKEN:0:12}..."

npx wrangler dev --local --var CLOUDFLARE_ACCOUNT_ID:$CLOUDFLARE_ACCOUNT_ID --var CLOUDFLARE_API_TOKEN:$CLOUDFLARE_API_TOKEN
