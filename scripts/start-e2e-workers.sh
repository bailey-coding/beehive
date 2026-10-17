#!/bin/bash
# Start all Beehive workers for local e2e testing
# Usage: ./scripts/start-e2e-workers.sh
#
# This script starts the 5 workers needed for local e2e tests, plus a local-only probe:
# - API worker (beehive) on port 8787 - MUST START FIRST (Spec DO host)
# - Shadow router on port 8788
# - Canary worker on port 8789
# - Promotion worker on port 8790
# - Preview manager on port 8791 (canary versions; WORKER_VERSIONS_MODE=stub + BEEHIVE_LOCAL_DEV=1)
# - E2E probe on port 8792 (tests/e2e/probe, never deployed): a worker with only the tier-1 token
#
# Spec DO internal auth (workers/shared/spec-do-auth.ts): fresh random test values per run,
# passed as --var (never written to disk). The API worker (the DO host) gets both
# SPEC_DO_INTERNAL_TOKEN and SPEC_DO_ADMIN_TOKEN; every other worker, and the probe, gets only
# SPEC_DO_INTERNAL_TOKEN. Export either variable beforehand to pin a value.
#
# The API worker must start first because the Spec DO is bound to it, and the
# other workers reach it (and each other) only while their wrangler dev runs.
# Every worker gets API_AUTH_TOKEN (the fixed local test token below) as a --var from
# start_worker, so no .dev.vars file is needed here. A .dev.vars file is still read by plain
# `wrangler dev`; --var wins over it when both are present.
#
# PIDs go to .e2e-workers.pids; scripts/stop-e2e-workers.sh stops only those.

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

TOKEN="test-auth-token-12345"
rand_hex() { head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
DO_INTERNAL_TOKEN="${SPEC_DO_INTERNAL_TOKEN:-e2e-internal-$(rand_hex)}"
DO_ADMIN_TOKEN="${SPEC_DO_ADMIN_TOKEN:-e2e-admin-$(rand_hex)}"
PID_FILE="$REPO_ROOT/.e2e-workers.pids"
: > "$PID_FILE"

# Refuse to start over anything already listening: e2e would hit the wrong process
for port in 8787 8788 8789 8790 8791 8792; do
    if (exec 3<>/dev/tcp/127.0.0.1/$port) 2>/dev/null; then
        echo "✗ Port $port is already in use. Stop whatever is listening there first."
        exit 1
    fi
done

# Wait until URL answers 2xx (curl -f fails on 4xx/5xx, e.g. 503 when API_AUTH_TOKEN is missing)
wait_healthy() {
    local name="$1" url="$2" vars="$3" tries=60
    while [ $tries -gt 0 ]; do
        if curl -sf -o /dev/null -H "Authorization: Bearer $TOKEN" "$url"; then
            echo "      ✓ $name healthy"
            return 0
        fi
        tries=$((tries - 1))
        sleep 1
    done
    local status
    status=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$url" || true)
    echo "      ✗ $name not healthy at $url (last HTTP status: ${status:-none})"
    echo "        503 = API_AUTH_TOKEN missing from $vars; 401 = it does not match $TOKEN"
    # Do not leave the workers started so far running
    "$REPO_ROOT/scripts/stop-e2e-workers.sh"
    exit 1
}

start_worker() {
    local step="$1" name="$2" port="$3"; shift 3
    echo "[$step] Starting $name on port $port..."
    npx wrangler dev "$@" --var "API_AUTH_TOKEN:$TOKEN" --port "$port" &
    local pid=$!
    echo "$pid" >> "$PID_FILE"
    echo "      $name PID: $pid"
}

echo "========================================"
echo "Starting Beehive workers for e2e tests"
echo "========================================"
echo ""

# PURGE_MIN_AGE_HOURS=0: tests/e2e/ledger-lifecycle.test.ts purges tombstones it just created
start_worker "1/6" "API worker (beehive)" 8787 --config wrangler.toml --var PURGE_MIN_AGE_HOURS:0 --var "SPEC_DO_INTERNAL_TOKEN:$DO_INTERNAL_TOKEN" --var "SPEC_DO_ADMIN_TOKEN:$DO_ADMIN_TOKEN"
wait_healthy "API worker" http://localhost:8787/health .dev.vars

start_worker "2/6" "Shadow router" 8788 --config workers/shadow-router/wrangler.toml --var "SPEC_DO_INTERNAL_TOKEN:$DO_INTERNAL_TOKEN"
wait_healthy "Shadow router" http://localhost:8788/health workers/shadow-router/.dev.vars

start_worker "3/6" "Canary worker" 8789 --config workers/canary-worker/wrangler.toml --var "SPEC_DO_INTERNAL_TOKEN:$DO_INTERNAL_TOKEN"
wait_healthy "Canary worker" http://localhost:8789/health workers/canary-worker/.dev.vars

start_worker "4/6" "Promotion worker" 8790 --config workers/promotion-worker/wrangler.toml --var "SPEC_DO_INTERNAL_TOKEN:$DO_INTERNAL_TOKEN"
wait_healthy "Promotion worker" http://localhost:8790/promotion/health workers/promotion-worker/.dev.vars

# WORKER_VERSIONS_MODE=stub: canary versions come from the local stub, never the Cloudflare API.
# BEEHIVE_LOCAL_DEV=1 is the local-only signal the stub requires; only this script sets it,
# so a production worker with WORKER_VERSIONS_MODE=stub set by mistake still answers 501.
start_worker "5/6" "Preview manager" 8791 --config workers/preview-manager/wrangler.toml --inspector-port 9234 --var WORKER_VERSIONS_MODE:stub --var BEEHIVE_LOCAL_DEV:1 --var "SPEC_DO_INTERNAL_TOKEN:$DO_INTERNAL_TOKEN"
wait_healthy "Preview manager" http://localhost:8791/health workers/preview-manager/.dev.vars

# Local-only probe: holds the tier-1 token and nothing else (tests/e2e/spec-do-auth.test.ts)
start_worker "6/6" "E2E probe (tier-1 only)" 8792 --config tests/e2e/probe/wrangler.toml --inspector-port 9235 --var BEEHIVE_LOCAL_DEV:1 --var "SPEC_DO_INTERNAL_TOKEN:$DO_INTERNAL_TOKEN"
wait_healthy "E2E probe" http://localhost:8792/health tests/e2e/probe

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
echo "  Preview:    http://localhost:8791"
echo "  Probe:      http://localhost:8792 (local e2e only)"
echo ""
echo "Worker PIDs: $(tr '\n' ' ' < "$PID_FILE")(saved to .e2e-workers.pids)"
echo ""
echo "Run e2e tests with:"
echo "  npm run test:e2e:local"
echo ""
echo "Stop these workers with:"
echo "  ./scripts/stop-e2e-workers.sh"
echo ""

# Wait for all workers to complete (they run in background)
# This keeps the script running so Ctrl+C will stop all workers
wait
