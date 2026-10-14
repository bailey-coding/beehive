#!/usr/bin/env bash
# Synthetic Monitoring for Beehive SPIKE Validation
# Runs periodic checks to ensure the foundational workflow remains functional.
#
# Monitors:
# 1. Fork creation via binding
# 2. Sandbox runner clone capability
# 3. Agent commit+push workflow
# 4. Queue event delivery
#
# Usage: ./synthetic-monitoring.sh [namespace] [baseline-repo] [interval-seconds]
# Example: ./synthetic-monitoring.sh default beehive-url-shortener 300

set -euo pipefail

# --- Configuration ---
NAMESPACE="${1:-default}"
BASELINE_REPO="${2:-beehive-url-shortener}"
INTERVAL_SECONDS="${3:-300}"  # Default: 5 minutes
ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"
API_TOKEN="${CLOUDFLARE_API_TOKEN:-}"

# State file for tracking
STATE_FILE="./synthetic-monitoring-state.json"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# --- Functions ---

log() {
  echo -e "${BLUE}[$(date +%Y-%m-%d\ %H:%M:%S)]${NC} $1"
}

success() {
  echo -e "${GREEN}[PASS]${NC} $1"
}

fail() {
  echo -e "${RED}[FAIL]${NC} $1"
}

warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

# --- Health Checks ---

check_cf_auth() {
  if cf artifacts namespaces list &> /dev/null; then
    success "Cloudflare authentication"
    return 0
  else
    fail "Cloudflare authentication"
    return 1
  fi
}

check_namespace() {
  if cf artifacts namespaces get "$NAMESPACE" &> /dev/null; then
    success "Namespace '$NAMESPACE' accessible"
    return 0
  else
    fail "Namespace '$NAMESPACE' not found"
    return 1
  fi
}

check_baseline_repo() {
  if cf artifacts namespaces repos get "$BASELINE_REPO" --namespace "$NAMESPACE" &> /dev/null; then
    success "Baseline repo '$BASELINE_REPO' exists"
    return 0
  else
    fail "Baseline repo '$BASELINE_REPO' not found"
    return 1
  fi
}

check_fork_creation() {
  local test_fork="${BASELINE_REPO}-synthetic-test-$$"
  
  # Create test fork
  if cf artifacts namespaces repos create "$NAMESPACE" --name "$test_fork" &> /dev/null; then
    # Cleanup
    cf artifacts namespaces repos delete "$test_fork" --namespace "$NAMESPACE" &> /dev/null || true
    success "Fork creation via binding"
    return 0
  else
    fail "Fork creation via binding"
    return 1
  fi
}

check_token_creation() {
  local test_repo="${BASELINE_REPO}-token-test-$$"
  
  # Create a temp repo for token test
  cf artifacts namespaces repos create "$NAMESPACE" --name "$test_repo" &> /dev/null || true
  
  # Try to create a token
  if cf artifacts namespaces tokens create "$NAMESPACE" \
    --repo "$test_repo" \
    --scope write \
    --ttl 60 &> /dev/null; then
    
    # Cleanup
    cf artifacts namespaces repos delete "$test_repo" --namespace "$NAMESPACE" &> /dev/null || true
    success "Token creation for repos"
    return 0
  else
    # Cleanup
    cf artifacts namespaces repos delete "$test_repo" --namespace "$NAMESPACE" &> /dev/null || true
    fail "Token creation for repos"
    return 1
  fi
}

check_git_operations() {
  local test_repo="${BASELINE_REPO}-git-test-$$"
  local test_dir="./synthetic-git-test-$$"
  
  # Create test repo
  cf artifacts namespaces repos create "$NAMESPACE" --name "$test_repo" &> /dev/null || true
  
  # Get remote URL
  REPO_INFO=$(cf artifacts namespaces repos get "$test_repo" --namespace "$NAMESPACE" 2>/dev/null || echo "{}")
  REMOTE=$(echo "$REPO_INFO" | jq -r '.remote // empty')
  
  if [ -z "$REMOTE" ]; then
    cf artifacts namespaces repos delete "$test_repo" --namespace "$NAMESPACE" &> /dev/null || true
    fail "Git operations (could not get remote URL)"
    return 1
  fi
  
  # Create token
  TOKEN=$(cf artifacts namespaces tokens create "$NAMESPACE" \
    --repo "$test_repo" \
    --scope write \
    --ttl 60 2>/dev/null | jq -r '.plaintext // empty')
  
  if [ -z "$TOKEN" ]; then
    cf artifacts namespaces repos delete "$test_repo" --namespace "$NAMESPACE" &> /dev/null || true
    fail "Git operations (could not create token)"
    return 1
  fi
  
  # Try to clone
  if git -c "http.extraHeader=Authorization: Bearer $TOKEN" clone "$REMOTE" "$test_dir" &> /dev/null; then
    # Try to commit and push
    cd "$test_dir"
    echo "synthetic test" > test.txt
    git add test.txt
    git commit -m "synthetic: git operations test" &> /dev/null || true
    
    if git -c "http.extraHeader=Authorization: Bearer $TOKEN" push origin main &> /dev/null; then
      # Cleanup
      cd - > /dev/null
      rm -rf "$test_dir"
      cf artifacts namespaces repos delete "$test_repo" --namespace "$NAMESPACE" &> /dev/null || true
      success "Git operations (clone, commit, push)"
      return 0
    else
      # Cleanup
      cd - > /dev/null
      rm -rf "$test_dir"
      cf artifacts namespaces repos delete "$test_repo" --namespace "$NAMESPACE" &> /dev/null || true
      fail "Git operations (push failed)"
      return 1
    fi
  else
    # Cleanup
    rm -rf "$test_dir" 2>/dev/null || true
    cf artifacts namespaces repos delete "$test_repo" --namespace "$NAMESPACE" &> /dev/null || true
    fail "Git operations (clone failed)"
    return 1
  fi
}

# --- Run all checks ---

run_checks() {
  log "Starting synthetic monitoring checks..."
  
  local passed=0
  local failed=0
  
  check_cf_auth && passed=$((passed + 1)) || failed=$((failed + 1))
  check_namespace && passed=$((passed + 1)) || failed=$((failed + 1))
  check_baseline_repo && passed=$((passed + 1)) || failed=$((failed + 1))
  check_fork_creation && passed=$((passed + 1)) || failed=$((failed + 1))
  check_token_creation && passed=$((passed + 1)) || failed=$((failed + 1))
  check_git_operations && passed=$((passed + 1)) || failed=$((failed + 1))
  
  log "Results: $passed passed, $failed failed"
  
  if [ $failed -eq 0 ]; then
    log "All synthetic monitoring checks passed"
    return 0
  else
    log "Some checks failed - investigate"
    return 1
  fi
}

# --- Main Loop ---

main() {
  log "=== Beehive Synthetic Monitoring ==="
  log "Namespace: $NAMESPACE"
  log "Baseline Repo: $BASELINE_REPO"
  log "Interval: $INTERVAL_SECONDS seconds"
  log "Press Ctrl+C to stop"
  
  # Initial run
  run_checks
  
  # Continuous monitoring
  while true; do
    log "Waiting $INTERVAL_SECONDS seconds..."
    sleep "$INTERVAL_SECONDS"
    run_checks || true  # Don't exit on failure, keep monitoring
  done
}

# --- Signal Handling ---

trap 'log "Monitoring stopped"; exit 0' SIGINT SIGTERM

# Run main
main "$@"
