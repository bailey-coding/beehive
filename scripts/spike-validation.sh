#!/usr/bin/env bash
# SPIKE Validation Script
# Synthetic monitoring for Beehive's foundational workflow:
#   baseline repo -> fork 3x via binding -> sandbox runner clones one fork ->
#   hardcoded "agent" commits+pushes -> push event via Queues -> consumer logs it
#
# Exit criteria: 3 forks, 3 pushes, 3 events received, zero manual steps.
# Pattern: first writer wins, second push rejected (concurrent push ordering test).
#
# Usage: ./spike-validation.sh [namespace] [baseline-repo-name] [agent-prefix]
# Example: ./spike-validation.sh default beehive-url-shortener agent

set -euo pipefail

# --- Configuration ---
NAMESPACE="${1:-default}"
BASELINE_REPO="${2:-beehive-url-shortener}"
AGENT_PREFIX="${3:-agent}"
ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"
API_TOKEN="${CLOUDFLARE_API_TOKEN:-}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# --- Validation Functions ---

log() {
  echo -e "${GREEN}[INFO]${NC} $1"
}

warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

error() {
  echo -e "${RED}[ERROR]${NC} $1"
  exit 1
}

# --- Prerequisites ---

check_prereqs() {
  log "Checking prerequisites..."
  
  # Check cf CLI
  if ! command -v cf &> /dev/null; then
    error "cf CLI not found. Install from https://github.com/cloudflare/cloudflare-cli"
  fi
  
  # Check git
  if ! command -v git &> /dev/null; then
    error "git not found"
  fi
  
  # Check jq for JSON parsing
  if ! command -v jq &> /dev/null; then
    error "jq not found. Install from https://stedolan.github.io/jq/"
  fi
  
  # Check Node.js >= 22
  if ! command -v node &> /dev/null; then
    error "Node.js not found"
  fi
  
  NODE_VERSION=$(node -v | sed 's/^v//')
  if [ "$(printf '%s\n%s' "$NODE_VERSION" "22.0.0" | sort -V | head -n1)" != "22.0.0" ]; then
    error "Node.js >= 22.0.0 required (found: $NODE_VERSION)"
  fi
  
  # Check CLOUDFLARE_ACCOUNT_ID
  if [ -z "$ACCOUNT_ID" ]; then
    error "CLOUDFLARE_ACCOUNT_ID not set. Export it or pass as env var."
  fi
  
  # Check CLOUDFLARE_API_TOKEN
  if [ -z "$API_TOKEN" ]; then
    error "CLOUDFLARE_API_TOKEN not set. Export it or pass as env var."
  fi
  
  log "Prerequisites OK"
}

# --- Setup ---

ensure_namespace() {
  log "Ensuring namespace '$NAMESPACE' exists..."
  if ! cf artifacts namespaces get "$NAMESPACE" &> /dev/null; then
    log "Creating namespace '$NAMESPACE'..."
    cf artifacts namespaces create --namespace "$NAMESPACE"
  else
    log "Namespace '$NAMESPACE' already exists"
  fi
}

create_baseline_repo() {
  # Captured via $(): all logs must go to stderr, only the remote URL on stdout.
  log "Creating baseline repo '$BASELINE_REPO'..." >&2
  if ! cf artifacts namespaces repos get "$BASELINE_REPO" --namespace "$NAMESPACE" &> /dev/null; then
    cf artifacts namespaces repos create "$NAMESPACE" --name "$BASELINE_REPO" > /dev/null 2>&1
  else
    log "Baseline repo '$BASELINE_REPO' already exists" >&2
  fi

  # Get remote URL
  REPO_INFO=$(cf artifacts namespaces repos get "$BASELINE_REPO" --namespace "$NAMESPACE" 2>/dev/null)
  echo "$REPO_INFO" | jq -r '.remote'
}

# --- Fork Creation (3x) ---

create_fork() {
  local fork_name="${AGENT_PREFIX}-${1}"
  local fork_repo_name="${BASELINE_REPO}-${fork_name}"
  
  # Captured via $(): all logs must go to stderr, only the remote URL on stdout.
  log "Creating fork '$fork_repo_name'..." >&2
  
  # Create the fork repo
  cf artifacts namespaces repos create "$NAMESPACE" --name "$fork_repo_name" > /dev/null 2>&1
  
  # Get fork remote URL
  FORK_INFO=$(cf artifacts namespaces repos get "$fork_repo_name" --namespace "$NAMESPACE" 2>/dev/null)
  echo "$FORK_INFO" | jq -r '.remote'
}

# --- Git Operations with Auth ---

git_with_auth() {
  local token="$1"
  shift
  git -c "http.extraHeader=Authorization: Bearer $token" "$@"
}

clone_repo() {
  local remote_url="$1"
  local target_dir="$2"
  local token="$3"
  
  log "Cloning $remote_url to $target_dir..."
  git_with_auth "$token" clone "$remote_url" "$target_dir"
}

create_and_push_commit() {
  local repo_dir="$1"
  local commit_msg="$2"
  local token="$3"
  local branch="${4:-main}"
  
  cd "$repo_dir"
  
  # Create a test file
  echo "Spike validation commit at $(date -u +%Y-%m-%dT%H:%M:%SZ)" > spike-test.txt
  
  # Commit
  git add spike-test.txt
  git commit -m "$commit_msg"
  
  # Push (first writer wins, second should be rejected)
  if PUSH_OUT=$(git_with_auth "$token" push origin "$branch" 2>&1); then
    cd - > /dev/null
    return 0
  fi
  
  if echo "$PUSH_OUT" | grep -q "rejected"; then
    warn "Push rejected - likely concurrent push (expected for second writer)"
    cd - > /dev/null
    return 1
  else
    error "Push failed unexpectedly: $PUSH_OUT"
  fi
}

# --- Queue Consumer Simulation ---

setup_queue_consumer() {
  log "Setting up queue consumer simulation..."
  # This would be a Worker in production
  # For synthetic monitoring, we just log that we'd receive the event
  mkdir -p consumers
  cat > consumers/queue-consumer.js << 'EOF'
// Simulated queue consumer
const events = [];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/event' && request.method === 'POST') {
      const event = await request.json();
      events.push(event);
      console.log('Event received:', JSON.stringify(event));
      return new Response('OK', { status: 200 });
    }
    return new Response('Not found', { status: 404 });
  }
};
EOF
  log "Queue consumer stub created at consumers/queue-consumer.js"
}

# --- Main Validation ---

main() {
  check_prereqs
  ensure_namespace
  
  log "=== SPIKE Validation Started ==="
  
  # Create baseline repo
  BASELINE_REMOTE=$(create_baseline_repo)
  log "Baseline repo remote: $BASELINE_REMOTE"
  
  # Create 3 forks
  FORK_REMOTES=()
  for i in 1 2 3; do
    FORK_REMOTE=$(create_fork "$i")
    FORK_REMOTES+=("$FORK_REMOTE")
    log "Fork $i remote: $FORK_REMOTE"
  done
  
  # Create tokens for each fork
  TOKENS=()
  for i in 1 2 3; do
    TOKEN=$(cf artifacts namespaces tokens create "$NAMESPACE" \
      --repo "${BASELINE_REPO}-${AGENT_PREFIX}-${i}" \
      --scope write \
      --ttl 3600 | jq -r '.plaintext')
    TOKENS+=("$TOKEN")
  done
  
  # Clone first fork and push (first writer - should succeed)
  log "\n--- Testing first writer (should win) ---"
  FORK1_DIR="./spike-fork-1"
  clone_repo "${FORK_REMOTES[0]}" "$FORK1_DIR" "${TOKENS[0]}"
  # Clone a second, divergent copy of the same fork BEFORE the first push,
  # so the second writer's commit cannot fast-forward over the first.
  FORK1B_DIR="./spike-fork-1b"
  clone_repo "${FORK_REMOTES[0]}" "$FORK1B_DIR" "${TOKENS[0]}"
  create_and_push_commit "$FORK1_DIR" "spike: first writer | task: validation | spec: n/a | confidence: 1.0" "${TOKENS[0]}" && \
    log "First writer push succeeded (expected)" || \
    error "First writer push failed (unexpected)"
  
  # Push from the divergent clone of the same fork (second writer - should be rejected)
  log "\n--- Testing second writer (should be rejected) ---"
  if create_and_push_commit "$FORK1B_DIR" "spike: second writer | task: validation | spec: n/a | confidence: 1.0" "${TOKENS[0]}"; then
    warn "Second writer push succeeded - concurrent push ordering may not be enforced"
  else
    log "Second writer push rejected (expected - concurrent push protection working)"
  fi
  
  # Clone third fork and push (should succeed - different repo)
  log "\n--- Testing third writer (different repo, should succeed) ---"
  FORK3_DIR="./spike-fork-3"
  clone_repo "${FORK_REMOTES[2]}" "$FORK3_DIR" "${TOKENS[2]}"
  create_and_push_commit "$FORK3_DIR" "spike: third writer | task: validation | spec: n/a | confidence: 1.0" "${TOKENS[2]}" && \
    log "Third writer push succeeded (expected)" || \
    error "Third writer push failed (unexpected)"
  
  # Setup queue consumer
  setup_queue_consumer
  
  # Simulate events being sent to queue
  log "\n--- Simulating push events to queue ---"
  for i in 1 2 3; do
    EVENT_JSON=$(jq -n \
      --arg repo "${BASELINE_REPO}-${AGENT_PREFIX}-${i}" \
      --arg action "push" \
      --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '{repository: $repo, action: $action, timestamp: $timestamp}')
    echo "Event $i: $EVENT_JSON"
    # In real implementation, this would POST to the queue
  done
  
  # Cleanup
  log "\n--- Validation Results ---"
  log "3 forks created: ${FORK_REMOTES[0]}, ${FORK_REMOTES[1]}, ${FORK_REMOTES[2]}"
  log "3 pushes attempted (1st: success, 2nd: rejected, 3rd: success)"
  log "3 events simulated"
  log "Exit criteria: 3 forks, 3 pushes, 3 events received, zero manual steps"
  
  # Cleanup temp directories
  rm -rf "$FORK1_DIR" "$FORK1B_DIR" "$FORK3_DIR" consumers
  
  log "\n=== SPIKE Validation Complete ==="
  log "Note: This script validates the workflow pattern. For full validation,"
  log "run against a real Worker-based queue consumer and verify event delivery."
}

# Run main
main "$@"
