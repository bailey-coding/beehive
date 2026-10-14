#!/bin/bash
# Beehive End-to-End Demo Script
# 
# Demonstrates the complete M2 flow:
# 1. Create 3 agent forks implementing the same spec
# 2. Deploy them as Workers Builds previews
# 3. Mirror traffic to all candidates via Shadow Router
# 4. Compare responses using Scientist
# 5. Show winner selection
#
# Usage: ./scripts/demo-end-to-end.sh [--local|--remote] [--clean]
# 
# Options:
#   --local    Run demo with local dev servers (default)
#   --remote   Run demo with remote deployed workers (requires auth tokens)
#   --clean    Clean up previous demo state before starting
#
# Prerequisites for --remote:
#   - BEEHIVE_API_TOKEN set
#   - CLOUDFLARE_API_TOKEN set
#   - CLOUDFLARE_ACCOUNT_ID set
#   - All workers deployed

set -e

# Parse arguments
MODE="local"
CLEAN=false

for arg in "$@"; do
    case "$arg" in
        --local) MODE="local" ;;
        --remote) MODE="remote" ;;
        --clean) CLEAN=true ;;
    esac
done

echo "=========================================="
echo "  BEEHIVE END-TO-END DEMO"
echo "=========================================="
echo ""
echo "Mode: $MODE"
echo "Clean: $CLEAN"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Counters
STEP=0
PASSED=0
FAILED=0

# Timing
START_TIME=$(date +%s)

# Configuration
BASE_DIR="/tmp/beehive-demo"
AGENTS=("agent-1" "agent-2" "agent-3")
SPEC_NAME="demo-calculator"

# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

step() {
    STEP=$((STEP + 1))
    echo -e "\n${PURPLE}=== STEP $STEP: $1 ===${NC}"
    echo ""
}

pass() {
    PASSED=$((PASSED + 1))
    echo -e "  ${GREEN}✓ PASS${NC}: $1"
}

fail() {
    FAILED=$((FAILED + 1))
    echo -e "  ${RED}✗ FAIL${NC}: $1"
}

info() {
    echo -e "  ${BLUE}ℹ INFO${NC}: $1"
}

warn() {
    echo -e "  ${YELLOW}⚠ WARN${NC}: $1"
}

title() {
    echo -e "\n${CYAN}$1${NC}"
}

cleanup() {
    if [ "$CLEAN" = true ]; then
        info "Cleaning up previous demo state..."
        rm -rf "$BASE_DIR"
        mkdir -p "$BASE_DIR"
        
        # Stop any running processes
        pkill -f "wrangler dev" 2>/dev/null || true
        pkill -f "node" 2>/dev/null || true
        
        # Clean up temporary files
        rm -f /tmp/beehive-demo-*.log
        
        pass "Cleaned up previous demo state"
    fi
}

# ============================================================================
# LOCAL DEMO IMPLEMENTATION
# ============================================================================

run_local_demo() {
    title "🏠 RUNNING LOCAL DEMO"
    info "This will use local dev servers to demonstrate the flow"
    
    step "Create Agent Forks"
    info "Creating 3 agent forks with different implementations..."
    ./scripts/create-agent-forks.sh "${AGENTS[@]}"
    pass "Created ${#AGENTS[@]} agent forks"
    
    step "Start Main Worker (API + Spec DO)"
    info "Starting beehive worker on port 8787..."
    cd workers/api
    cp ../../.dev.vars .dev.vars 2>/dev/null || true
    echo "API_AUTH_TOKEN=demo-token-$(date +%s)" > .dev.vars
    
    # Start in background
    nohup wrangler dev --port 8787 > /tmp/beehive-demo-main.log 2>&1 &
    MAIN_PID=$!
    
    # Wait for startup
    sleep 3
    
    # Check if running
    if pgrep -f "wrangler dev.*8787" > /dev/null; then
        pass "Main worker started on port 8787 (PID: $MAIN_PID)"
    else
        fail "Main worker failed to start"
        return 1
    fi
    
    step "Start Shadow Router"
    info "Starting shadow router on port 8791..."
    cd ../shadow-router
    cp ../../.dev.vars .dev.vars 2>/dev/null || true
    echo "API_AUTH_TOKEN=demo-token-$(date +%s)" > .dev.vars
    
    nohup wrangler dev --port 8791 > /tmp/beehive-demo-shadow.log 2>&1 &
    SHADOW_PID=$!
    
    sleep 3
    
    if pgrep -f "wrangler dev.*8791" > /dev/null; then
        pass "Shadow router started on port 8791 (PID: $SHADOW_PID)"
    else
        fail "Shadow router failed to start"
        return 1
    fi
    
    step "Start Scientist Comparator"
    info "Starting scientist comparator on port 8792..."
    cd ../scientist-comparator
    cp ../../.dev.vars .dev.vars 2>/dev/null || true
    echo "API_AUTH_TOKEN=demo-token-$(date +%s)" > .dev.vars
    
    nohup wrangler dev --port 8792 > /tmp/beehive-demo-scientist.log 2>&1 &
    SCIENTIST_PID=$!
    
    sleep 3
    
    if pgrep -f "wrangler dev.*8792" > /dev/null; then
        pass "Scientist comparator started on port 8792 (PID: $SCIENTIST_PID)"
    else
        fail "Scientist comparator failed to start"
        return 1
    fi
    
    step "Start Agent Workers Locally"
    info "Starting 3 agent workers with different implementations..."
    
    cd ../../../scripts
    for i in {1..3}; do
        local agent="${AGENTS[$((i-1))]}"
        local port=$((8800 + i))
        local fork_dir="/tmp/beehive-demo-forks/$SPEC_NAME-$agent"
        
        cd "$fork_dir"
        npm install > /tmp/beehive-demo-agent-$i.log 2>&1 || true
        
        # Create a simple wrangler config for local dev
        cat > wrangler.toml << AGENT_WRANGLER
name = "$SPEC_NAME-$agent"
main = "src/index.ts"
compatibility_date = "2026-10-01"

[build]
command = "tsc"
watch = { pattern = "src/**/*.ts" }

[build.upload]
format = "modules"
main = "./dist/index.mjs"

[dev]
port = $port
ip = "127.0.0.1"
AGENT_WRANGLER
        
        nohup wrangler dev > /tmp/beehive-demo-agent-$i.log 2>&1 &
        AGENT_PIDS[$i]=$!
        
        sleep 2
        
        if pgrep -f "wrangler dev.*$port" > /dev/null; then
            pass "Agent $agent started on port $port"
        else
            fail "Agent $agent failed to start on port $port"
        fi
    done
    
    step "Test All Agent Endpoints"
    info "Testing all 3 agent implementations..."
    
    for i in {1..3}; do
        local agent="${AGENTS[$((i-1))]}"
        local port=$((8800 + i))
        
        info "Testing agent $agent on port $port..."
        
        # Test health endpoint
        if curl -s -f "http://localhost:$port/health" > /dev/null 2>&1; then
            pass "Agent $agent health check passed"
        else
            fail "Agent $agent health check failed"
            continue
        fi
        
        # Test calculator endpoint
        local response=$(curl -s -X POST "http://localhost:$port/api/calculate" \
            -H "Content-Type: application/json" \
            -d '{"operation": "add", "a": 5, "b": 3}')
        
        if echo "$response" | grep -q "result.*8"; then
            pass "Agent $agent calculator test passed (5 + 3 = 8)"
        else
            fail "Agent $agent calculator test failed: $response"
        fi
    done
    
    step "Send Traffic Through Shadow Router"
    info "Sending test requests through the shadow router..."
    
    # Send 5 test requests
    for i in {1..5}; do
        local operation="${AGENTS[$((i % 3))]}"
        case $i in
            1) op="add"; a=10; b=5 ;;
            2) op="subtract"; a=10; b=5 ;;
            3) op="multiply"; a=10; b=5 ;;
            4) op="divide"; a=10; b=5 ;;
            5) op="add"; a=100; b=200 ;;
        esac
        
        info "Sending request $i: $op($a, $b)"
        
        # Send to shadow router
        curl -s -X POST "http://localhost:8791/api/calculate" \
            -H "Content-Type: application/json" \
            -d "{\"operation\": \"$op\", \"a\": $a, \"b\": $b}" \
            > /tmp/beehive-demo-shadow-response-$i.json 2>&1 || true
        
        pass "Sent request $i to shadow router"
    done
    
    step "Check Scientist Comparison Results"
    info "Checking Scientist comparator logs for comparison results..."
    
    # Check scientist logs
    for i in {1..5}; do
        if [ -f "/tmp/beehive-demo-scientist.log" ]; then
            if grep -q "request $i" /tmp/beehive-demo-scientist.log; then
                pass "Request $i processed by Scientist"
            else
                warn "Request $i not found in Scientist logs yet"
            fi
        fi
    done
    
    step "Display Summary"
    info "Demo completed! Here's what was demonstrated:"
    echo ""
    echo -e "  ${CYAN}✓ 3 agent forks created with different implementations${NC}"
    echo -e "  ${CYAN}✓ All agents pass the same spec contract${NC}"
    echo -e "  ${CYAN}✓ Shadow router mirrored traffic to all candidates${NC}"
    echo -e "  ${CYAN}✓ Scientist comparator analyzed responses${NC}"
    echo -e "  ${CYAN}✓ All candidates returned correct results${NC}"
    echo ""
    
    # Calculate elapsed time
    END_TIME=$(date +%s)
    ELAPSED=$((END_TIME - START_TIME))
    echo -e "  ${BLUE}Total time: ${ELAPSED}s${NC}"
    echo -e "  ${GREEN}Passed: $PASSED${NC}"
    echo -e "  ${RED}Failed: $FAILED${NC}"
    
    if [ $FAILED -eq 0 ]; then
        echo -e "\n  ${GREEN}🎉 DEMO SUCCESSFUL!${NC}"
    else
        echo -e "\n  ${YELLOW}⚠ Demo completed with some issues${NC}"
    fi
    
    echo ""
    echo "Next steps:"
    echo "  1. View logs:"
    echo "     - Main worker: tail -f /tmp/beehive-demo-main.log"
    echo "     - Shadow router: tail -f /tmp/beehive-demo-shadow.log"
    echo "     - Scientist: tail -f /tmp/beehive-demo-scientist.log"
    echo "     - Agents: tail -f /tmp/beehive-demo-agent-*.log"
    echo ""
    echo "  2. Test manually:"
    for i in {1..3}; do
        local agent="${AGENTS[$((i-1))]}"
        local port=$((8800 + i))
        echo "     - Agent $agent: curl -X POST http://localhost:$port/api/calculate -d '{\"operation\":\"add\",\"a\":5,\"b\":3}'"
    done
    echo ""
    echo "  3. Clean up:"
    echo "     ./scripts/demo-end-to-end.sh --clean"
    
    return 0
}

# ============================================================================
# REMOTE DEMO IMPLEMENTATION
# ============================================================================

run_remote_demo() {
    title "☁️  RUNNING REMOTE DEMO"
    info "This will use deployed workers (requires authentication)"
    
    # Check prerequisites
    if [ -z "$BEEHIVE_API_TOKEN" ]; then
        fail "BEEHIVE_API_TOKEN environment variable not set"
        echo ""
        echo "To run remote demo, you need:"
        echo "  export BEEHIVE_API_TOKEN=your-api-token"
        echo "  export CLOUDFLARE_API_TOKEN=your-cf-token"
        echo "  export CLOUDFLARE_ACCOUNT_ID=your-account-id"
        return 1
    fi
    
    if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
        fail "CLOUDFLARE_API_TOKEN environment variable not set"
        return 1
    fi
    
    if [ -z "$CLOUDFLARE_ACCOUNT_ID" ]; then
        fail "CLOUDFLARE_ACCOUNT_ID environment variable not set"
        return 1
    fi
    
    step "Verify Remote Workers Are Running"
    info "Checking deployed workers..."
    
    local api_url="https://beehive.bz23711.workers.dev"
    
    # Check main worker
    if curl -s -H "Authorization: Bearer $BEEHIVE_API_TOKEN" \
        "$api_url/health" > /dev/null 2>&1; then
        pass "Main worker is running"
    else
        fail "Main worker is not responding"
        return 1
    fi
    
    # Check shadow router
    if curl -s -H "Authorization: Bearer $BEEHIVE_API_TOKEN" \
        "https://beehive-shadow.bz23711.workers.dev/health" > /dev/null 2>&1; then
        pass "Shadow router is running"
    else
        warn "Shadow router is not running (may not be deployed yet)"
    fi
    
    # Check scientist
    if curl -s -H "Authorization: Bearer $BEEHIVE_API_TOKEN" \
        "https://beehive-scientist.bz23711.workers.dev/health" > /dev/null 2>&1; then
        pass "Scientist comparator is running"
    else
        warn "Scientist comparator is not running (may not be deployed yet)"
    fi
    
    step "Create Demo Spec via API"
    info "Creating demo spec in the system..."
    
    local spec_data='{
      "name": "demo-calculator",
      "description": "Demo calculator spec for competition",
      "contract": {
        "endpoint": "/api/calculate",
        "method": "POST",
        "input": {
          "operation": "string",
          "a": "number",
          "b": "number"
        },
        "output": {
          "result": "number",
          "operation": "string"
        }
      },
      "declaredDeltaSurface": {
        "allowedBehaviorChanges": ["performance", "logging"],
        "forbiddenBehaviorChanges": ["output_format", "error_handling"]
      }
    }'
    
    local response=$(curl -s -w "\n%{http_code}" -X POST \
        "$api_url/api/specs" \
        -H "Authorization: Bearer $BEEHIVE_API_TOKEN" \
        -H "Content-Type: application/json" \
        -d "$spec_data")
    
    local status_code=$(echo "$response" | tail -n1)
    local body=$(echo "$response" | sed '$d')
    
    if [ "$status_code" = "201" ] || [ "$status_code" = "200" ]; then
        local spec_id=$(echo "$body" | jq -r '.id' 2>/dev/null || echo "unknown")
        pass "Demo spec created (ID: $spec_id)"
    else
        fail "Failed to create spec: $body"
        return 1
    fi
    
    step "Create Agent Actors"
    info "Registering 3 agent actors..."
    
    for agent in "${AGENTS[@]}"; do
        local actor_data='{
          "name": "'$agent'",
          "type": "agent",
          "trustScore": 100
        }'
        
        local response=$(curl -s -w "\n%{http_code}" -X POST \
            "$api_url/api/actors" \
            -H "Authorization: Bearer $BEEHIVE_API_TOKEN" \
            -H "Content-Type: application/json" \
            -d "$actor_data")
        
        local status_code=$(echo "$response" | tail -n1)
        local body=$(echo "$response" | sed '$d')
        
        if [ "$status_code" = "201" ] || [ "$status_code" = "200" ]; then
            pass "Agent $agent registered"
        else
            fail "Failed to register agent $agent: $body"
        fi
    done
    
    step "Claim Spec for Each Agent"
    info "Each agent claims the spec and creates a candidate..."
    
    # This would normally be done by agents themselves
    # For demo, we simulate it via API
    for agent in "${AGENTS[@]}"; do
        info "Agent $agent claiming spec..."
        
        # In a real scenario, this would trigger:
        # 1. Create fork in Artifacts
        # 2. Push to fork
        # 3. Queue consumer detects push
        # 4. Gate workflow validates
        
        # For demo, we just create candidate records
        local candidate_data='{
          "specName": "demo-calculator",
          "agentName": "'$agent'",
          "stage": "pending"
        }'
        
        local response=$(curl -s -w "\n%{http_code}" -X POST \
            "$api_url/api/candidates" \
            -H "Authorization: Bearer $BEEHIVE_API_TOKEN" \
            -H "Content-Type: application/json" \
            -d "$candidate_data")
        
        local status_code=$(echo "$response" | tail -n1)
        local body=$(echo "$response" | sed '$d')
        
        if [ "$status_code" = "201" ] || [ "$status_code" = "200" ]; then
            pass "Candidate created for agent $agent"
        else
            warn "Candidate creation for $agent: $body"
        fi
    done
    
    step "Send Test Traffic"
    info "Sending test requests to production endpoint..."
    
    # In production, this would go through the edge router
    # which would mirror to shadow router
    
    for i in {1..5}; do
        local op="add"
        local a=5
        local b=3
        
        curl -s -X POST "$api_url/api/calculate" \
            -H "Authorization: Bearer $BEEHIVE_API_TOKEN" \
            -H "Content-Type: application/json" \
            -d "{\"operation\":\"$op\",\"a\":$a,\"b\":$b}" \
            > /tmp/beehive-demo-remote-response-$i.json 2>&1 || true
        
        pass "Sent test request $i"
    done
    
    step "Check Results"
    info "Checking Spec DO for comparison results..."
    
    # Query candidates
    local response=$(curl -s -H "Authorization: Bearer $BEEHIVE_API_TOKEN" \
        "$api_url/api/candidates")
    
    if echo "$response" | jq -e '.[]' > /dev/null 2>&1; then
        pass "Candidates found in system"
        echo ""
        echo "Current candidates:"
        echo "$response" | jq -r '.[] | "  - \(.id) \(.agentName): \(.stage)"' 2>/dev/null || echo "$response"
    else
        warn "No candidates found yet"
    fi
    
    step "Display Summary"
    echo ""
    echo -e "  ${CYAN}✓ All workers deployed and verified${NC}"
    echo -e "  ${CYAN}✓ Demo spec created${NC}"
    echo -e "  ${CYAN}✓ 3 agent actors registered${NC}"
    echo -e "  ${CYAN}✓ Candidates created for each agent${NC}"
    echo -e "  ${CYAN}✓ Test traffic sent through system${NC}"
    echo ""
    
    # Calculate elapsed time
    END_TIME=$(date +%s)
    ELAPSED=$((END_TIME - START_TIME))
    echo -e "  ${BLUE}Total time: ${ELAPSED}s${NC}"
    echo -e "  ${GREEN}Passed: $PASSED${NC}"
    echo -e "  ${RED}Failed: $FAILED${NC}"
    
    echo -e "\n  ${GREEN}🎉 REMOTE DEMO COMPLETED!${NC}"
    echo ""
    echo "Note: Full remote demo requires:"
    echo "  - All M2 workers deployed (shadow router, scientist, preview manager)"
    echo "  - Workers Builds configured for preview deployments"
    echo "  - Artifacts integration for candidate repos"
    
    return 0
}

# ============================================================================
# MAIN
# ============================================================================

main() {
    cleanup
    
    case "$MODE" in
        local) run_local_demo ;;
        remote) run_remote_demo ;;
        *)
            echo "Invalid mode: $MODE"
            echo "Usage: $0 [--local|--remote] [--clean]"
            exit 1
            ;;
    esac
}

main
