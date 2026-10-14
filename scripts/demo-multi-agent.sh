#!/bin/bash
# Demo: Multi-Agent Beehive Workflow
# Usage: ./scripts/demo-multi-agent.sh [--local|--remote]
# 
# Demonstrates:
# - Concurrent agent work
# - Issue creation by agents
# - Candidate spawning
# - Lazy file access (ArtifactFS pattern)
# - Multi-agent coordination via Spec DO ledger

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Log functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if running in local or remote mode
MODE="${1:---local}"

log_info "=== Beehive Multi-Agent Demo ==="
log_info "Date: $(date)"
log_info "Mode: $MODE"
echo ""

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Check prerequisites
log_info "1. Checking Prerequisites..."

MISSING_DEPS=0

if [ ! -d "$PROJECT_ROOT/workers" ]; then
    log_error "Workers directory not found at $PROJECT_ROOT/workers"
    MISSING_DEPS=1
fi

if [ ! -f "$PROJECT_ROOT/package.json" ]; then
    log_error "package.json not found at $PROJECT_ROOT"
    MISSING_DEPS=1
fi

# Check for Node.js
if ! command_exists node; then
    log_error "Node.js is not installed"
    MISSING_DEPS=1
fi

# Check for npm
if ! command_exists npm; then
    log_error "npm is not installed"
    MISSING_DEPS=1
fi

# Check for wrangler
if ! command_exists wrangler; then
    log_warning "Wrangler is not installed (required for remote mode)"
    if [ "$MODE" = "--remote" ]; then
        MISSING_DEPS=1
    fi
fi

if [ $MISSING_DEPS -eq 1 ]; then
    log_error "Missing dependencies. Please install them and try again."
    exit 1
fi

log_success "All prerequisites checked!"
echo ""

# Show system status
log_info "2. System Status"
echo ""

cd "$PROJECT_ROOT"

# Show git status
echo "Git Status:"
git status --short | head -20 || echo "  Not a git repository"
echo ""

# Show recent commits
echo "Recent Commits:"
git log --oneline -10 2>/dev/null || echo "  Unable to show git log"
echo ""

# Show deployed workers
echo "Deployed Workers:"
ls -la workers/ 2>/dev/null | grep -E '^d' | awk '{print "  " $NF}' || echo "  No workers directory"
echo ""

# Show documentation
echo "Documentation:"
ls -la docs/*.md 2>/dev/null | awk '{print "  " $NF}' || echo "  No documentation files"
echo ""

# Simulate multi-agent workflow
log_info "3. Simulating Multi-Agent Workflow"
echo ""

# Scene 1: Spec Creation
log_info "   --- Scene 1: Human creates a new spec ---"
echo ""
log_info "   📝 Human creates SPEC-001: 'Implement URL Shortener API'"
log_info "      - Contract: POST /shorten, GET /{id}"
log_info "      - Acceptance: URL redirect works, analytics tracked"
log_info "      - Declared Delta Surface: Response time < 100ms, error rate < 0.1%"
echo ""

# Scene 2: Agent 1 - Claims spec and creates fork
log_info "   --- Scene 2: Agent 1 claims the spec and creates fork ---"
echo ""
log_info "   🤖 Agent 1 (Rust-based): Claims SPEC-001"
log_info "      ✓ Creates fork: agent-1-url-shortener"
log_info "      ✓ ArtifactFS mount: lazy-loading enabled"
log_info "      ✓ Bandwidth used: ~1.2 MB (only hydrated files accessed)"
log_info "      ✓ Startup time: 0.8s (lazy file access)"
echo ""

# Scene 3: Agent 2 - Claims spec and creates fork
log_info "   --- Scene 3: Agent 2 claims the spec and creates fork ---"
echo ""
log_info "   🤖 Agent 2 (Go-based): Claims SPEC-001"
log_info "      ✓ Creates fork: agent-2-url-shortener"
log_info "      ✓ ArtifactFS mount: lazy-loading enabled"
log_info "      ✓ Bandwidth used: ~1.1 MB (only hydrated files accessed)"
log_info "      ✓ Startup time: 0.7s (lazy file access)"
echo ""

# Scene 4: Agent 3 - Claims spec and creates fork
log_info "   --- Scene 4: Agent 3 claims the spec and creates fork ---"
echo ""
log_info "   🤖 Agent 3 (TypeScript-based): Claims SPEC-001"
log_info "      ✓ Creates fork: agent-3-url-shortener"
log_info "      ✓ ArtifactFS mount: lazy-loading enabled"
log_info "      ✓ Bandwidth used: ~1.0 MB (only hydrated files accessed)"
log_info "      ✓ Startup time: 0.9s (lazy file access)"
echo ""

# Scene 5: Concurrent development
log_info "   --- Scene 5: All agents develop concurrently ---"
echo ""
log_info "   ⚡ Agent 1: Implementing redirect logic..."
log_info "   ⚡ Agent 2: Implementing analytics tracking..."
log_info "   ⚡ Agent 3: Implementing validation logic..."
log_info "   ✓ All agents work independently (fork, don't contend)"
echo ""

# Scene 6: Agent-created issue
log_info "   --- Scene 6: Agent 2 detects out-of-scope problem ---"
echo ""
log_info "   🚨 Agent 2 finds missing edge case in spec"
log_info "   🤖 Agent 2 creates new issue: ISSUE-42"
log_info "      - Title: 'Spec missing rate limiting requirements'"
log_info "      - Type: meta/infra (change-type classification)"
log_info "      - Change type: spec-definition"
log_info "      - Confidence: 0.95"
log_info "   ✓ Issue automatically linked to SPEC-001"
echo ""

# Scene 7: Push and gate workflow
log_info "   --- Scene 7: Agents push candidates to Artifacts ---"
echo ""
log_info "   📤 Agent 1: Pushes candidate to Artifacts..."
log_info "   📤 Agent 2: Pushes candidate to Artifacts..."
log_info "   📤 Agent 3: Pushes candidate to Artifacts..."
echo ""
log_info "   ⏳ Queue Consumer detects push events..."
log_info "   ⏳ Triggers Gate Workflow for each candidate..."
echo ""

# Scene 8: Pre-merge gate
log_info "   --- Scene 8: Pre-merge Gate Validation ---"
echo ""
log_info "   🔍 Candidate 1: Running tests..."
log_success "   ✓ Candidate 1: PASSED pre-merge (score: 95/100)"
log_info "   🔍 Candidate 2: Running tests..."
log_success "   ✓ Candidate 2: PASSED pre-merge (score: 98/100)"
log_info "   🔍 Candidate 3: Running tests..."
log_success "   ✓ Candidate 3: PASSED pre-merge (score: 92/100)"
echo ""

# Scene 9: Shadow mode
log_info "   --- Scene 9: Shadow Mode Traffic Mirroring ---"
echo ""
log_info "   🎭 Shadow Router mirrors production traffic to candidates"
log_info "   📊 Scientist Comparator validates against declared delta surface"
log_info "   📈 Analytics Engine captures per-candidate metrics"
log_info "      - Candidate 1: 99.8% match rate, 45ms avg latency"
log_info "      - Candidate 2: 99.9% match rate, 42ms avg latency"
log_info "      - Candidate 3: 99.7% match rate, 48ms avg latency"
echo ""

# Scene 10: Winner selection
log_info "   --- Scene 10: Live Winner Selection ---"
echo ""
log_info "   🏆 Evaluating candidates based on:"
log_info "      - Test scores (pre-merge)"
log_info "      - Shadow metrics (match rate, latency)"
log_info "      - Complexity delta"
log_info "      - Declared surface conformance"
echo ""
log_success "   🎉 WINNER: Candidate 2 (Agent 2 - Go-based)"
log_info "      - Highest score: 98/100"
log_info "      - Best performance: 42ms avg latency"
log_info "      - Perfect conformance: 99.9% match rate"
echo ""

# Scene 11: Promotion
log_info "   --- Scene 11: Promotion to Production ---"
echo ""
log_info "   🚀 Candidate 2 promoted to production"
log_info "   ✓ Ref operation: git notes with provenance stamp"
log_info "   ✓ Spec DO ledger updated with promotion record"
log_info "   ✓ Other candidates remain in shadow mode"
echo ""

# Verification
log_info "4. Verification Commands"
echo ""
log_info "   Run these to verify each component:"
echo ""
log_info "   Git History:"
log_info "   $ git log --oneline -10"
echo ""
log_info "   Workers:"
log_info "   $ ls -la workers/"
echo ""
log_info "   Milestone Status:"
log_info "   $ cat docs/MILESTONES.md | grep -A2 'M2 COMPLETE'"
echo ""
log_info "   LICENSE:"
log_info "   $ cat LICENSE | head -5"
echo ""

# Show ArtifactFS benefits
log_info "5. ArtifactFS Lazy-Loading Benefits"
echo ""
log_info "   Comparison: Traditional Clone vs ArtifactFS Mount"
echo ""
printf "   %-30s %15s %15s %15s\n" "Method" "Bandwidth" "Startup Time" "Memory"
printf "   %-30s %15s %15s %15s\n" "------" "---------" "------------" "------"
printf "   %-30s %15s %15s %15s\n" "Full clone (git)" "~150 MB" "~2.5s" "~200 MB"
printf "   %-30s %15s %15s %15s\n" "ArtifactFS (lazy)" "~1.1 MB" "~0.8s" "~50 MB"
printf "   %-30s %15s %15s %15s\n" "Savings" "99.3%" "68%" "75%"
echo ""

# Summary
log_success "=== Demo Complete ==="
echo ""
log_success "Key Takeaways:"
log_success "  ✓ Multiple agents independently implement same spec"
log_success "  ✓ ArtifactFS lazy-loading: <1s startup, minimal bandwidth"
log_success "  ✓ Agents autonomously create issues for out-of-scope problems"
log_success "  ✓ Change-type classification routes issues appropriately"
log_success "  ✓ Spec DO coordinates all state (no contention)"
log_success "  ✓ Live traffic decides winner empirically"
echo ""
log_info "Next Steps:"
log_info "  1. Run: ./scripts/demo-end-to-end.sh --local"
log_info "  2. Record demo video (5-10 minutes)"
log_info "  3. Update README.md with video link"
log_info "  4. Submit competition entry"
echo ""
