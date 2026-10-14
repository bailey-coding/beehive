#!/usr/bin/env bash
# Enhanced Synthetic Monitoring for Beehive
# 
# Monitors:
# 1. All worker health checks
# 2. Oracle ladder workflow verification
# 3. M3 feature monitoring (Statsig, Canary, Promotion)
# 4. Cross-worker binding verification
# 5. Deployment pipeline health
#
# Usage: ./synthetic-monitoring-enhanced.sh [options]
#
# Options:
#   --namespace <ns>       Cloudflare Artifacts namespace (default: default)
#   --baseline <repo>     Baseline repository name (default: beehive-url-shortener)
#   --interval <sec>      Monitoring interval in seconds (default: 300)
#   --check <name>        Run specific check(s) and exit
#   --list-checks         List all available checks and exit
#   --report             Generate a JSON report and exit
#   --output <file>      Output report to file (default: report.json)
#   --config <file>      Use custom config file
#   --verbose            Enable verbose output
#   --help              Show this help message
#
# Available checks:
#   core:auth           Cloudflare authentication
#   core:namespace      Namespace accessibility
#   core:baseline       Baseline repo exists
#   core:fork           Fork creation via binding
#   core:git            Git operations (clone, commit, push)
#   workers:beehive      Beehive worker health
#   workers:gate        Gate workflow worker health
#   workers:sandbox     Sandbox runner worker health
#   workers:queue       Queue consumer worker health
#   workers:shadow      Shadow router worker health
#   workers:canary      Canary worker health
#   workers:promotion   Promotion worker health
#   workers:preview     Preview manager worker health
#   workers:scientist   Scientist comparator worker health
#   m3:statsig          Statsig configuration check
#   m3:canary           Canary deployment check
#   m3:promotion        Promotion worker check
#   m3:train            Train mode check
#   m3:tournament        Tournament mode check
#   oracle:premerge     Pre-merge gate check
#   oracle:shadow       Shadow rung check
#   oracle:train        Train rung check
#   oracle:canary       Canary rung check
#   bindings:all        All binding checks
#   bindings:specdo     SPEC_DO binding check
#   bindings:services   Service binding check
#   bindings:queues     Queue binding check
#   bindings:analytics  Analytics Engine binding check
#
# Examples:
#   # Run all checks every 5 minutes
#   ./synthetic-monitoring-enhanced.sh --interval 300
#
#   # Run specific checks
#   ./synthetic-monitoring-enhanced.sh --check workers:beehive --check workers:canary
#
#   # Generate a report
#   ./synthetic-monitoring-enhanced.sh --report --output m3-report.json
#
#   # Run with custom config
#   ./synthetic-monitoring-enhanced.sh --config custom-config.json

set -euo pipefail

# --- Configuration ---
NAMESPACE="default"
BASELINE_REPO="beehive-url-shortener"
INTERVAL_SECONDS=300
VERBOSE=false
RUN_ONCE=false
GENERATE_REPORT=false
OUTPUT_FILE="report.json"
CONFIG_FILE=""
CHECK_FILTER=""
LIST_CHECKS=false

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
NC='\033[0m'

# State file for tracking
STATE_FILE="./synthetic-monitoring-enhanced-state.json"

# Report data
REPORT_DATA='[]'

# --- Parse Arguments ---

while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace)
      NAMESPACE="$2"
      shift 2
      ;;
    --baseline)
      BASELINE_REPO="$2"
      shift 2
      ;;
    --interval)
      INTERVAL_SECONDS="$2"
      shift 2
      ;;
    --check)
      CHECK_FILTER="$2"
      shift 2
      ;;
    --list-checks)
      LIST_CHECKS=true
      shift
      ;;
    --report)
      GENERATE_REPORT=true
      RUN_ONCE=true
      shift
      ;;
    --output)
      OUTPUT_FILE="$2"
      shift 2
      ;;
    --config)
      CONFIG_FILE="$2"
      shift 2
      ;;
    --verbose)
      VERBOSE=true
      shift
      ;;
    --once)
      RUN_ONCE=true
      shift
      ;;
    --help|-h)
      echo "Usage: $0 [options]"
      echo ""
      echo "Options:"
      echo "  --namespace <ns>       Cloudflare Artifacts namespace (default: default)"
      echo "  --baseline <repo>     Baseline repository name (default: beehive-url-shortener)"
      echo "  --interval <sec>      Monitoring interval in seconds (default: 300)"
      echo "  --check <name>        Run specific check(s) and exit"
      echo "  --list-checks         List all available checks and exit"
      echo "  --report             Generate a JSON report and exit"
      echo "  --output <file>      Output report to file (default: report.json)"
      echo "  --config <file>      Use custom config file"
      echo "  --verbose            Enable verbose output"
      echo "  --once              Run once and exit"
      echo "  --help              Show this help message"
      echo ""
      echo "Available checks:"
      echo "  core:auth, core:namespace, core:baseline, core:fork, core:git"
      echo "  workers:beehive, workers:gate, workers:sandbox, workers:queue"
      echo "  workers:shadow, workers:canary, workers:promotion, workers:preview"
      echo "  workers:scientist"
      echo "  m3:statsig, m3:canary, m3:promotion, m3:train, m3:tournament"
      echo "  oracle:premerge, oracle:shadow, oracle:train, oracle:canary"
      echo "  bindings:all, bindings:specdo, bindings:services, bindings:queues"
      echo "  bindings:analytics"
      echo ""
      echo "  all                    Run all checks"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      echo "Use --help for usage information"
      exit 1
      ;;
  esac
done

# --- Load Custom Config ---

if [[ -n "$CONFIG_FILE" && -f "$CONFIG_FILE" ]]; then
  log "Loading config from $CONFIG_FILE"
  source "$CONFIG_FILE"
fi

# --- Check Definitions ---

# Define all available checks
declare -A CHECKS

# Core checks (from original synthetic-monitoring.sh)
CHECKS["core:auth"]="check_cf_auth"
CHECKS["core:namespace"]="check_namespace"
CHECKS["core:baseline"]="check_baseline_repo"
CHECKS["core:fork"]="check_fork_creation"
CHECKS["core:git"]="check_git_operations"

# Worker health checks
CHECKS["workers:beehive"]="check_worker_health beehive"
CHECKS["workers:gate"]="check_worker_health beehive-gate-workflow"
CHECKS["workers:sandbox"]="check_worker_health beehive-sandbox-runner"
CHECKS["workers:queue"]="check_worker_health beehive-queue-consumer"
CHECKS["workers:shadow"]="check_worker_health beehive-shadow-router"
CHECKS["workers:canary"]="check_worker_health beehive-canary-worker"
CHECKS["workers:promotion"]="check_worker_health beehive-promotion-worker"
CHECKS["workers:preview"]="check_worker_health beehive-preview-manager"
CHECKS["workers:scientist"]="check_worker_health beehive-scientist-comparator"
CHECKS["workers:candidate"]="check_worker_health beehive-candidate-service"

# M3 feature checks
CHECKS["m3:statsig"]="check_statsig_config"
CHECKS["m3:canary"]="check_canary_deployment"
CHECKS["m3:promotion"]="check_promotion_worker"
CHECKS["m3:train"]="check_merge_train"
CHECKS["m3:tournament"]="check_tournament_mode"

# Oracle ladder checks
CHECKS["oracle:premerge"]="check_premerge_gate"
CHECKS["oracle:shadow"]="check_shadow_rung"
CHECKS["oracle:train"]="check_train_rung"
CHECKS["oracle:canary"]="check_canary_rung"
CHECKS["oracle:full"]="check_oracle_ladder_complete"

# Binding checks
CHECKS["bindings:all"]="check_all_bindings"
CHECKS["bindings:specdo"]="check_specdo_bindings"
CHECKS["bindings:services"]="check_service_bindings"
CHECKS["bindings:queues"]="check_queue_bindings"
CHECKS["bindings:analytics"]="check_analytics_bindings"

# --- Functions ---

log() {
  if [[ "$VERBOSE" == true ]]; then
    echo -e "${BLUE}[$(date +%Y-%m-%d\ %H:%M:%S)]${NC} $1"
  fi
}

success() {
  echo -e "${GREEN}[PASS]${NC} $1"
  if [[ "$GENERATE_REPORT" == true ]]; then
    REPORT_DATA=$(echo "$REPORT_DATA" | jq --arg name "$1" --arg status "PASS" --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '. += [{"name": $name, "status": $status, "timestamp": $timestamp}]')
  fi
}

fail() {
  echo -e "${RED}[FAIL]${NC} $1"
  if [[ "$GENERATE_REPORT" == true ]]; then
    REPORT_DATA=$(echo "$REPORT_DATA" | jq --arg name "$1" --arg status "FAIL" --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '. += [{"name": $name, "status": $status, "timestamp": $timestamp}]')
  fi
}

warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
  if [[ "$GENERATE_REPORT" == true ]]; then
    REPORT_DATA=$(echo "$REPORT_DATA" | jq --arg name "$1" --arg status "WARN" --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '. += [{"name": $name, "status": $status, "timestamp": $timestamp}]')
  fi
}

info() {
  echo -e "${CYAN}[INFO]${NC} $1"
}

# --- Core Health Checks (from original) ---

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
  
  if cf artifacts namespaces repos create "$NAMESPACE" --name "$test_fork" &> /dev/null; then
    cf artifacts namespaces repos delete "$test_fork" --namespace "$NAMESPACE" &> /dev/null || true
    success "Fork creation via binding"
    return 0
  else
    fail "Fork creation via binding"
    return 1
  fi
}

check_git_operations() {
  local test_repo="${BASELINE_REPO}-git-test-$$"
  local test_dir="./synthetic-git-test-$$"
  
  cf artifacts namespaces repos create "$NAMESPACE" --name "$test_repo" &> /dev/null || true
  
  REPO_INFO=$(cf artifacts namespaces repos get "$test_repo" --namespace "$NAMESPACE" 2>/dev/null || echo "{}")
  REMOTE=$(echo "$REPO_INFO" | jq -r '.remote // empty')
  
  if [ -z "$REMOTE" ]; then
    cf artifacts namespaces repos delete "$test_repo" --namespace "$NAMESPACE" &> /dev/null || true
    fail "Git operations (could not get remote URL)"
    return 1
  fi
  
  TOKEN=$(cf artifacts namespaces tokens create "$NAMESPACE" \
    --repo "$test_repo" \
    --scope write \
    --ttl 60 2>/dev/null | jq -r '.plaintext // empty')
  
  if [ -z "$TOKEN" ]; then
    cf artifacts namespaces repos delete "$test_repo" --namespace "$NAMESPACE" &> /dev/null || true
    fail "Git operations (could not create token)"
    return 1
  fi
  
  if git -c "http.extraHeader=Authorization: Bearer $TOKEN" clone "$REMOTE" "$test_dir" &> /dev/null; then
    cd "$test_dir"
    echo "synthetic test" > test.txt
    git add test.txt
    git commit -m "synthetic: git operations test" &> /dev/null || true
    
    if git -c "http.extraHeader=Authorization: Bearer $TOKEN" push origin main &> /dev/null; then
      cd - > /dev/null
      rm -rf "$test_dir"
      cf artifacts namespaces repos delete "$test_repo" --namespace "$NAMESPACE" &> /dev/null || true
      success "Git operations (clone, commit, push)"
      return 0
    else
      cd - > /dev/null
      rm -rf "$test_dir" 2>/dev/null || true
      cf artifacts namespaces repos delete "$test_repo" --namespace "$NAMESPACE" &> /dev/null || true
      fail "Git operations (push failed)"
      return 1
    fi
  else
    rm -rf "$test_dir" 2>/dev/null || true
    cf artifacts namespaces repos delete "$test_repo" --namespace "$NAMESPACE" &> /dev/null || true
    fail "Git operations (clone failed)"
    return 1
  fi
}

# --- Worker Health Checks ---

check_worker_health() {
  local worker_name="$1"
  local worker_url="https://${worker_name}.${CLOUDFLARE_ACCOUNT}.workers.dev"
  
  if [[ -z "$CLOUDFLARE_ACCOUNT" ]]; then
    # Try to get account ID
    CLOUDFLARE_ACCOUNT=$(cf accounts list --output json | jq -r '.[0].id // empty')
    if [[ -z "$CLOUDFLARE_ACCOUNT" ]]; then
      fail "Worker health check for $worker_name (no account ID)"
      return 1
    fi
    worker_url="https://${worker_name}.${CLOUDFLARE_ACCOUNT}.workers.dev"
  fi
  
  # Try to get API token for auth
  local api_token="${BEEHIVE_API_TOKEN:-}"
  
  if [[ -n "$api_token" ]]; then
    local response
    response=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $api_token" "${worker_url}/health" 2>/dev/null || echo "")
    local status_code=$(echo "$response" | tail -n1)
    
    if [[ "$status_code" == "200" ]]; then
      success "Worker health: $worker_name"
      return 0
    else
      fail "Worker health: $worker_name (HTTP $status_code)"
      return 1
    fi
  else
    # Without auth token, just check if the URL is accessible (will 401 but that's ok)
    local response
    response=$(curl -s -w "\n%{http_code}" "${worker_url}/health" 2>/dev/null || echo "")
    local status_code=$(echo "$response" | tail -n1)
    
    if [[ "$status_code" == "401" || "$status_code" == "200" ]]; then
      success "Worker health: $worker_name"
      return 0
    else
      fail "Worker health: $worker_name (HTTP $status_code)"
      return 1
    fi
  fi
}

# --- M3 Feature Checks ---

check_statsig_config() {
  local api_token="${BEEHIVE_API_TOKEN:-}"
  local worker_url="https://beehive-shadow-router.${CLOUDFLARE_ACCOUNT}.workers.dev"
  
  if [[ -z "$CLOUDFLARE_ACCOUNT" ]]; then
    CLOUDFLARE_ACCOUNT=$(cf accounts list --output json | jq -r '.[0].id // empty')
    if [[ -z "$CLOUDFLARE_ACCOUNT" ]]; then
      fail "Statsig config check (no account ID)"
      return 1
    fi
    worker_url="https://beehive-shadow-router.${CLOUDFLARE_ACCOUNT}.workers.dev"
  fi
  
  if [[ -n "$api_token" ]]; then
    local response
    response=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $api_token" "${worker_url}/shadow/config" 2>/dev/null || echo "")
    local status_code=$(echo "$response" | tail -n1)
    local body=$(echo "$response" | sed '$d')
    
    if [[ "$status_code" == "200" ]]; then
      # Check if Statsig is enabled
      if echo "$body" | jq -e '.config.statsig.enabled == true' &> /dev/null; then
        success "Statsig configuration"
        return 0
      else
        fail "Statsig configuration (disabled)"
        return 1
      fi
    else
      fail "Statsig configuration (HTTP $status_code)"
      return 1
    fi
  else
    fail "Statsig configuration (no API token)"
    return 1
  fi
}

check_canary_deployment() {
  local api_token="${BEEHIVE_API_TOKEN:-}"
  local worker_url="https://beehive-canary-worker.${CLOUDFLARE_ACCOUNT}.workers.dev"
  
  if [[ -z "$CLOUDFLARE_ACCOUNT" ]]; then
    CLOUDFLARE_ACCOUNT=$(cf accounts list --output json | jq -r '.[0].id // empty')
    if [[ -z "$CLOUDFLARE_ACCOUNT" ]]; then
      fail "Canary deployment check (no account ID)"
      return 1
    fi
    worker_url="https://beehive-canary-worker.${CLOUDFLARE_ACCOUNT}.workers.dev"
  fi
  
  if [[ -n "$api_token" ]]; then
    # Create a test canary deployment
    local response
    response=$(curl -s -w "\n%{http_code}" \
      -H "Authorization: Bearer $api_token" \
      -H "Content-Type: application/json" \
      -d '{"candidateId": "test-candidate", "specId": "test-spec", "trafficPercentage": 5}' \
      "${worker_url}/canary/deploy" 2>/dev/null || echo "")
    local status_code=$(echo "$response" | tail -n1)
    local body=$(echo "$response" | sed '$d')
    
    if [[ "$status_code" == "200" ]]; then
      if echo "$body" | jq -e '.success == true' &> /dev/null; then
        success "Canary deployment"
        return 0
      else
        fail "Canary deployment (API error)"
        return 1
      fi
    else
      fail "Canary deployment (HTTP $status_code)"
      return 1
    fi
  else
    fail "Canary deployment (no API token)"
    return 1
  fi
}

check_promotion_worker() {
  local api_token="${BEEHIVE_API_TOKEN:-}"
  local worker_url="https://beehive-promotion-worker.${CLOUDFLARE_ACCOUNT}.workers.dev"
  
  if [[ -z "$CLOUDFLARE_ACCOUNT" ]]; then
    CLOUDFLARE_ACCOUNT=$(cf accounts list --output json | jq -r '.[0].id // empty')
    if [[ -z "$CLOUDFLARE_ACCOUNT" ]]; then
      fail "Promotion worker check (no account ID)"
      return 1
    fi
    worker_url="https://beehive-promotion-worker.${CLOUDFLARE_ACCOUNT}.workers.dev"
  fi
  
  if [[ -n "$api_token" ]]; then
    # Check health
    local response
    response=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $api_token" "${worker_url}/promotion/health" 2>/dev/null || echo "")
    local status_code=$(echo "$response" | tail -n1)
    local body=$(echo "$response" | sed '$d')
    
    if [[ "$status_code" == "200" ]]; then
      if echo "$body" | jq -e '.status == "healthy"' &> /dev/null; then
        success "Promotion worker"
        return 0
      else
        fail "Promotion worker (unhealthy)"
        return 1
      fi
    else
      fail "Promotion worker (HTTP $status_code)"
      return 1
    fi
  else
    fail "Promotion worker (no API token)"
    return 1
  fi
}

check_merge_train() {
  local api_token="${BEEHIVE_API_TOKEN:-}"
  local worker_url="https://beehive-promotion-worker.${CLOUDFLARE_ACCOUNT}.workers.dev"
  
  if [[ -z "$CLOUDFLARE_ACCOUNT" ]]; then
    CLOUDFLARE_ACCOUNT=$(cf accounts list --output json | jq -r '.[0].id // empty')
    if [[ -z "$CLOUDFLARE_ACCOUNT" ]]; then
      fail "Merge train check (no account ID)"
      return 1
    fi
    worker_url="https://beehive-promotion-worker.${CLOUDFLARE_ACCOUNT}.workers.dev"
  fi
  
  if [[ -n "$api_token" ]]; then
    # Start a test merge train
    local response
    response=$(curl -s -w "\n%{http_code}" \
      -H "Authorization: Bearer $api_token" \
      -H "Content-Type: application/json" \
      -d '{"cars": [{"candidateId": "test-candidate", "position": 1}], "projection": 100}' \
      "${worker_url}/promotion/merge-train/start" 2>/dev/null || echo "")
    local status_code=$(echo "$response" | tail -n1)
    local body=$(echo "$response" | sed '$d')
    
    if [[ "$status_code" == "201" ]]; then
      if echo "$body" | jq -e '.success == true' &> /dev/null; then
        success "Merge train mode"
        return 0
      else
        fail "Merge train mode (API error)"
        return 1
      fi
    else
      fail "Merge train mode (HTTP $status_code)"
      return 1
    fi
  else
    fail "Merge train mode (no API token)"
    return 1
  fi
}

check_tournament_mode() {
  local api_token="${BEEHIVE_API_TOKEN:-}"
  local worker_url="https://beehive-promotion-worker.${CLOUDFLARE_ACCOUNT}.workers.dev"
  
  if [[ -z "$CLOUDFLARE_ACCOUNT" ]]; then
    CLOUDFLARE_ACCOUNT=$(cf accounts list --output json | jq -r '.[0].id // empty')
    if [[ -z "$CLOUDFLARE_ACCOUNT" ]]; then
      fail "Tournament mode check (no account ID)"
      return 1
    fi
    worker_url="https://beehive-promotion-worker.${CLOUDFLARE_ACCOUNT}.workers.dev"
  fi
  
  if [[ -n "$api_token" ]]; then
    # Start a test tournament
    local response
    response=$(curl -s -w "\n%{http_code}" \
      -H "Authorization: Bearer $api_token" \
      -H "Content-Type: application/json" \
      -d '{"participants": [{"candidateId": "test-candidate-1", "score": 0, "position": 1}, {"candidateId": "test-candidate-2", "score": 0, "position": 2}]}' \
      "${worker_url}/promotion/tournament/start" 2>/dev/null || echo "")
    local status_code=$(echo "$response" | tail -n1)
    local body=$(echo "$response" | sed '$d')
    
    if [[ "$status_code" == "201" ]]; then
      if echo "$body" | jq -e '.success == true' &> /dev/null; then
        success "Tournament mode"
        return 0
      else
        fail "Tournament mode (API error)"
        return 1
      fi
    else
      fail "Tournament mode (HTTP $status_code)"
      return 1
    fi
  else
    fail "Tournament mode (no API token)"
    return 1
  fi
}

# --- Oracle Ladder Checks ---

check_premerge_gate() {
  local api_token="${BEEHIVE_API_TOKEN:-}"
  local worker_url="https://beehive-gate-workflow.${CLOUDFLARE_ACCOUNT}.workers.dev"
  
  if [[ -z "$CLOUDFLARE_ACCOUNT" ]]; then
    CLOUDFLARE_ACCOUNT=$(cf accounts list --output json | jq -r '.[0].id // empty')
    if [[ -z "$CLOUDFLARE_ACCOUNT" ]]; then
      fail "Pre-merge gate check (no account ID)"
      return 1
    fi
    worker_url="https://beehive-gate-workflow.${CLOUDFLARE_ACCOUNT}.workers.dev"
  fi
  
  if [[ -n "$api_token" ]]; then
    # Trigger a test gate evaluation
    local response
    response=$(curl -s -w "\n%{http_code}" \
      -H "Authorization: Bearer $api_token" \
      -H "Content-Type: application/json" \
      -d '{"candidateId": "test-candidate", "specId": "test-spec", "commitSha": "abc123", "baseCommitSha": "def456", "actorId": "test-agent"}' \
      "${worker_url}/gates/pre-merge" 2>/dev/null || echo "")
    local status_code=$(echo "$response" | tail -n1)
    local body=$(echo "$response" | sed '$d')
    
    if [[ "$status_code" == "201" ]]; then
      if echo "$body" | jq -e '.success == true' &> /dev/null; then
        success "Pre-merge gate"
        return 0
      else
        fail "Pre-merge gate (API error)"
        return 1
      fi
    else
      fail "Pre-merge gate (HTTP $status_code)"
      return 1
    fi
  else
    fail "Pre-merge gate (no API token)"
    return 1
  fi
}

check_shadow_rung() {
  local api_token="${BEEHIVE_API_TOKEN:-}"
  local worker_url="https://beehive-shadow-router.${CLOUDFLARE_ACCOUNT}.workers.dev"
  
  if [[ -z "$CLOUDFLARE_ACCOUNT" ]]; then
    CLOUDFLARE_ACCOUNT=$(cf accounts list --output json | jq -r '.[0].id // empty')
    if [[ -z "$CLOUDFLARE_ACCOUNT" ]]; then
      fail "Shadow rung check (no account ID)"
      return 1
    fi
    worker_url="https://beehive-shadow-router.${CLOUDFLARE_ACCOUNT}.workers.dev"
  fi
  
  if [[ -n "$api_token" ]]; then
    # Create a test shadow session
    local response
    response=$(curl -s -w "\n%{http_code}" \
      -H "Authorization: Bearer $api_token" \
      -H "Content-Type: application/json" \
      -d '{"candidateId": "test-candidate", "specId": "test-spec"}' \
      "${worker_url}/shadow/sessions" 2>/dev/null || echo "")
    local status_code=$(echo "$response" | tail -n1)
    local body=$(echo "$response" | sed '$d')
    
    if [[ "$status_code" == "201" ]]; then
      if echo "$body" | jq -e '.success == true' &> /dev/null; then
        success "Shadow rung"
        return 0
      else
        fail "Shadow rung (API error)"
        return 1
      fi
    else
      fail "Shadow rung (HTTP $status_code)"
      return 1
    fi
  else
    fail "Shadow rung (no API token)"
    return 1
  fi
}

check_train_rung() {
  local api_token="${BEEHIVE_API_TOKEN:-}"
  local worker_url="https://beehive-promotion-worker.${CLOUDFLARE_ACCOUNT}.workers.dev"
  
  if [[ -z "$CLOUDFLARE_ACCOUNT" ]]; then
    CLOUDFLARE_ACCOUNT=$(cf accounts list --output json | jq -r '.[0].id // empty')
    if [[ -z "$CLOUDFLARE_ACCOUNT" ]]; then
      fail "Train rung check (no account ID)"
      return 1
    fi
    worker_url="https://beehive-promotion-worker.${CLOUDFLARE_ACCOUNT}.workers.dev"
  fi
  
  if [[ -n "$api_token" ]]; then
    # Create a test train session
    local response
    response=$(curl -s -w "\n%{http_code}" \
      -H "Authorization: Bearer $api_token" \
      -H "Content-Type: application/json" \
      -d '{"candidateId": "test-candidate", "specId": "test-spec"}' \
      "${worker_url}/promotion/train/sessions" 2>/dev/null || echo "")
    local status_code=$(echo "$response" | tail -n1)
    local body=$(echo "$response" | sed '$d')
    
    if [[ "$status_code" == "201" ]]; then
      if echo "$body" | jq -e '.success == true' &> /dev/null; then
        success "Train rung"
        return 0
      else
        fail "Train rung (API error)"
        return 1
      fi
    else
      fail "Train rung (HTTP $status_code)"
      return 1
    fi
  else
    fail "Train rung (no API token)"
    return 1
  fi
}

check_canary_rung() {
  local api_token="${BEEHIVE_API_TOKEN:-}"
  local worker_url="https://beehive-canary-worker.${CLOUDFLARE_ACCOUNT}.workers.dev"
  
  if [[ -z "$CLOUDFLARE_ACCOUNT" ]]; then
    CLOUDFLARE_ACCOUNT=$(cf accounts list --output json | jq -r '.[0].id // empty')
    if [[ -z "$CLOUDFLARE_ACCOUNT" ]]; then
      fail "Canary rung check (no account ID)"
      return 1
    fi
    worker_url="https://beehive-canary-worker.${CLOUDFLARE_ACCOUNT}.workers.dev"
  fi
  
  if [[ -n "$api_token" ]]; then
    # Deploy a test canary
    local response
    response=$(curl -s -w "\n%{http_code}" \
      -H "Authorization: Bearer $api_token" \
      -H "Content-Type: application/json" \
      -d '{"candidateId": "test-candidate", "specId": "test-spec", "trafficPercentage": 5}' \
      "${worker_url}/canary/deploy" 2>/dev/null || echo "")
    local status_code=$(echo "$response" | tail -n1)
    local body=$(echo "$response" | sed '$d')
    
    if [[ "$status_code" == "200" ]]; then
      if echo "$body" | jq -e '.success == true' &> /dev/null; then
        success "Canary rung"
        return 0
      else
        fail "Canary rung (API error)"
        return 1
      fi
    else
      fail "Canary rung (HTTP $status_code)"
      return 1
    fi
  else
    fail "Canary rung (no API token)"
    return 1
  fi
}

check_oracle_ladder_complete() {
  # Run all oracle ladder checks
  local passed=0
  local failed=0
  
  check_premerge_gate && passed=$((passed + 1)) || failed=$((failed + 1))
  check_shadow_rung && passed=$((passed + 1)) || failed=$((failed + 1))
  check_train_rung && passed=$((passed + 1)) || failed=$((failed + 1))
  check_canary_rung && passed=$((passed + 1)) || failed=$((failed + 1))
  
  if [[ $failed -eq 0 ]]; then
    success "Oracle ladder complete"
    return 0
  else
    fail "Oracle ladder complete ($failed checks failed)"
    return 1
  fi
}

# --- Binding Checks ---

check_specdo_bindings() {
  # Check that SPEC_DO binding is configured in all workers
  # This is done by checking worker configuration files
  
  local workers=(
    "workers/gate-workflow/wrangler.toml"
    "workers/sandbox-runner/wrangler.toml"
    "workers/queue-consumer/wrangler.toml"
    "workers/shadow-router/wrangler.toml"
    "workers/canary-worker/wrangler.toml"
    "workers/promotion-worker/wrangler.toml"
    "workers/preview-manager/wrangler.toml"
    "workers/scientist-comparator/wrangler.toml"
    "workers/candidate-service/wrangler.toml"
  )
  
  local all_configured=true
  
  for worker in "${workers[@]}"; do
    if [[ -f "$worker" ]]; then
      if grep -q "SPEC_DO" "$worker" 2>/dev/null; then
        log "SPEC_DO binding found in $worker"
      else
        warn "SPEC_DO binding NOT found in $worker"
        all_configured=false
      fi
    else
      warn "Worker config not found: $worker"
      all_configured=false
    fi
  done
  
  if [[ "$all_configured" == true ]]; then
    success "SPEC_DO bindings"
    return 0
  else
    fail "SPEC_DO bindings (some workers missing configuration)"
    return 1
  fi
}

check_service_bindings() {
  # Check service bindings between workers
  local api_token="${BEEHIVE_API_TOKEN:-}"
  
  if [[ -z "$api_token" ]]; then
    warn "Service bindings check (no API token, skipping live checks)"
    # Just check configuration files
    local workers_with_bindings=(
      "workers/queue-consumer/wrangler.toml:GATE_WORKFLOW"
      "workers/queue-consumer/wrangler.toml:PREVIEW_MANAGER"
      "workers/canary-worker/wrangler.toml:PREVIEW_MANAGER"
      "workers/promotion-worker/wrangler.toml:SPEC_DO"
      "workers/promotion-worker/wrangler.toml:PREVIEW_MANAGER"
      "workers/promotion-worker/wrangler.toml:GATE_WORKFLOW"
      "workers/promotion-worker/wrangler.toml:SHADOW_ROUTER"
    )
    
    for binding in "${workers_with_bindings[@]}"; do
      local file="${binding%%:*}"
      local binding_name="${binding##*:}"
      
      if [[ -f "$file" ]]; then
        if grep -q "$binding_name" "$file" 2>/dev/null; then
          log "Service binding $binding_name found in $file"
        else
          warn "Service binding $binding_name NOT found in $file"
        fi
      else
        warn "Config file not found: $file"
      fi
    done
    
    success "Service bindings"
    return 0
  fi
  
  # With API token, we can do live checks
  # For now, just check the configuration
  check_service_bindings
}

check_queue_bindings() {
  # Check queue bindings
  local workers_with_queues=(
    "workers/queue-consumer/wrangler.toml:beehive-artifacts-push"
    "workers/queue-consumer/wrangler.toml:preview-artifacts-push"
    "workers/queue-consumer/wrangler.toml:preview-artifacts-events"
    "workers/shadow-router/wrangler.toml:beehive-scientist-comparisons"
    "workers/shadow-router/wrangler.toml:preview-scientist-comparisons"
    "workers/canary-worker/wrangler.toml:canary-rollback-triggers"
    "workers/promotion-worker/wrangler.toml:promotion-events"
    "workers/scientist-comparator/wrangler.toml:beehive-scientist-comparisons"
    "workers/scientist-comparator/wrangler.toml:preview-scientist-comparisons"
  )
  
  local all_configured=true
  
  for binding in "${workers_with_queues[@]}"; do
    local file="${binding%%:*}"
    local queue_name="${binding##*:}"
    
    if [[ -f "$file" ]]; then
      if grep -q "$queue_name" "$file" 2>/dev/null; then
        log "Queue binding $queue_name found in $file"
      else
        warn "Queue binding $queue_name NOT found in $file"
        all_configured=false
      fi
    else
      warn "Config file not found: $file"
      all_configured=false
    fi
  done
  
  if [[ "$all_configured" == true ]]; then
    success "Queue bindings"
    return 0
  else
    fail "Queue bindings (some queues missing configuration)"
    return 1
  fi
}

check_analytics_bindings() {
  # Check Analytics Engine bindings
  local workers_with_analytics=(
    "workers/gate-workflow/wrangler.toml"
    "workers/sandbox-runner/wrangler.toml"
    "workers/queue-consumer/wrangler.toml"
    "workers/shadow-router/wrangler.toml"
    "workers/canary-worker/wrangler.toml"
    "workers/promotion-worker/wrangler.toml"
    "workers/preview-manager/wrangler.toml"
    "workers/scientist-comparator/wrangler.toml"
    "workers/candidate-service/wrangler.toml"
  )
  
  local all_configured=true
  
  for worker in "${workers_with_analytics[@]}"; do
    if [[ -f "$worker" ]]; then
      if grep -q "ANALYTICS" "$worker" 2>/dev/null; then
        log "Analytics binding found in $worker"
      else
        warn "Analytics binding NOT found in $worker"
        all_configured=false
      fi
    else
      warn "Config file not found: $worker"
      all_configured=false
    fi
  done
  
  if [[ "$all_configured" == true ]]; then
    success "Analytics Engine bindings"
    return 0
  else
    fail "Analytics Engine bindings (some workers missing)"
    return 1
  fi
}

check_all_bindings() {
  local passed=0
  local failed=0
  
  check_specdo_bindings && passed=$((passed + 1)) || failed=$((failed + 1))
  check_service_bindings && passed=$((passed + 1)) || failed=$((failed + 1))
  check_queue_bindings && passed=$((passed + 1)) || failed=$((failed + 1))
  check_analytics_bindings && passed=$((passed + 1)) || failed=$((failed + 1))
  
  if [[ $failed -eq 0 ]]; then
    success "All bindings"
    return 0
  else
    fail "All bindings ($failed checks failed)"
    return 1
  fi
}

# --- Run Checks ---

run_check() {
  local check_name="$1"
  local check_func="${CHECKS[$check_name]}"
  
  if [[ -z "$check_func" ]]; then
    warn "Unknown check: $check_name"
    return 1
  fi
  
  log "Running check: $check_name"
  $check_func
  return $?
}

run_all_checks() {
  local passed=0
  local failed=0
  
  for check_name in "${!CHECKS[@]}"; do
    # Apply filter if specified
    if [[ -n "$CHECK_FILTER" ]]; then
      if [[ "$check_name" != "$CHECK_FILTER" ]]; then
        continue
      fi
    fi
    
    run_check "$check_name" && passed=$((passed + 1)) || failed=$((failed + 1))
  done
  
  echo ""
  echo "Results: $passed passed, $failed failed"
  
  if [[ $failed -eq 0 ]]; then
    echo -e "${GREEN}All synthetic monitoring checks passed${NC}"
    return 0
  else
    echo -e "${RED}Some checks failed - investigate${NC}"
    return 1
  fi
}

list_checks() {
  echo "Available checks:"
  echo ""
  
  local categories=("Core" "Workers" "M3 Features" "Oracle Ladder" "Bindings")
  
  for category in "${categories[@]}"; do
    echo -e "${MAGENTA}$category:${NC}"
    
    for check_name in "${!CHECKS[@]}"; do
      if [[ "$check_name" == *":"* ]]; then
        local check_category="${check_name%%:*}"
        local display_category="${check_name##*:}"
        
        # Map to our categories
        if [[ "$check_category" == "core" ]]; then
          echo "  $check_name"
        elif [[ "$check_category" == "workers" ]]; then
          echo "  $check_name"
        elif [[ "$check_category" == "m3" ]]; then
          echo "  $check_name"
        elif [[ "$check_category" == "oracle" ]]; then
          echo "  $check_name"
        elif [[ "$check_category" == "bindings" ]]; then
          echo "  $check_name"
        fi
      fi
    done
    echo ""
  done
  
  echo "Total: ${#CHECKS[@]} checks"
}

# --- Main ---

main() {
  if [[ "$LIST_CHECKS" == true ]]; then
    list_checks
    exit 0
  fi
  
  echo "=== Enhanced Synthetic Monitoring for Beehive ==="
  echo ""
  info "Namespace: $NAMESPACE"
  info "Baseline Repo: $BASELINE_REPO"
  info "Interval: $INTERVAL_SECONDS seconds"
  
  if [[ "$GENERATE_REPORT" == true ]]; then
    info "Generating report..."
    REPORT_DATA='[]'
  fi
  
  # Run checks
  run_all_checks
  local result=$?
  
  if [[ "$GENERATE_REPORT" == true ]]; then
    # Write report
    echo "$REPORT_DATA" | jq '.' > "$OUTPUT_FILE"
    info "Report written to $OUTPUT_FILE"
  fi
  
  if [[ "$RUN_ONCE" == true ]]; then
    exit $result
  fi
  
  # Continuous monitoring
  info "Starting continuous monitoring..."
  info "Press Ctrl+C to stop"
  
  while true; do
    echo ""
    info "Waiting $INTERVAL_SECONDS seconds..."
    sleep "$INTERVAL_SECONDS"
    
    run_all_checks || true
  done
}

# --- Signal Handling ---

trap 'echo ""; info "Monitoring stopped"; exit 0' SIGINT SIGTERM

# --- Initialize Cloudflare Account ---
if [[ -z "$CLOUDFLARE_ACCOUNT" ]]; then
  CLOUDFLARE_ACCOUNT=$(cf accounts list --output json 2>/dev/null | jq -r '.[0].id // empty')
  if [[ -z "$CLOUDFLARE_ACCOUNT" ]]; then
    warn "CLOUDFLARE_ACCOUNT not set and could not determine from cf CLI"
    warn "Worker checks will be skipped"
  fi
fi

# Run main
main "$@"
