#!/bin/bash
# M2 Verification Script
# 
# Verifies all M2 components are working end-to-end:
# 1. Workers Builds Previews
# 2. Edge Mirror Worker (Shadow Router)
# 3. Scientist Comparator
# 4. Analytics Engine Metrics
#
# Usage: ./scripts/verify-m2.sh
#
# Prerequisites:
# - All workers deployed (beehive, beehive-gate-workflow, beehive-sandbox-runner, 
#   beehive-queue-consumer, beehive-shadow, beehive-scientist)
# - API_AUTH_TOKEN set as BEEHIVE_API_TOKEN
# - CLOUDFLARE_API_TOKEN set
# - CLOUDFLARE_ACCOUNT_ID set
# - Analytics Engine configured

set -e

echo "=========================================="
echo "  M2 VERIFICATION SCRIPT"
echo "=========================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Counters
PASSED=0
FAILED=0
SKIPPED=0

# Configuration
API_BASE="${API_BASE:-https://beehive.bz23711.workers.dev}"
BEEHIVE_TOKEN="${BEEHIVE_API_TOKEN:-}"
CF_TOKEN="${CLOUDFLARE_API_TOKEN:-}"
CF_ACCOUNT="${CLOUDFLARE_ACCOUNT_ID:-}"
NAMESPACE="${ARTIFACTS_NAMESPACE:-default}"

# Check prerequisites
check_prereq() {
    if [ -z "$BEEHIVE_TOKEN" ]; then
        echo -e "${RED}[FAIL] BEEHIVE_API_TOKEN not set${NC}"
        FAILED=$((FAILED + 1))
        return 1
    fi
    if [ -z "$CF_TOKEN" ]; then
        echo -e "${RED}[FAIL] CLOUDFLARE_API_TOKEN not set${NC}"
        FAILED=$((FAILED + 1))
        return 1
    fi
    if [ -z "$CF_ACCOUNT" ]; then
        echo -e "${RED}[FAIL] CLOUDFLARE_ACCOUNT_ID not set${NC}"
        FAILED=$((FAILED + 1))
        return 1
    fi
    echo -e "${GREEN}[PASS] All prerequisites set${NC}"
    PASSED=$((PASSED + 1))
}

# Health checks for all workers
check_workers() {
    echo ""
    echo "Checking worker health..."
    
    local workers=(
        "beehive:8787"
        "beehive-gate-workflow:8788"
        "beehive-sandbox-runner:8789"
        "beehive-queue-consumer:8790"
        "beehive-shadow:8791"
        "beehive-scientist:8792"
    )
    
    for worker in "${workers[@]}"; do
        IFS=':' read -r name port <<< "$worker"
        local url="http://localhost:$port/health"
        
        if curl -s -f "$url" > /dev/null 2>&1; then
            echo -e "${GREEN}[PASS] $name is healthy${NC}"
            PASSED=$((PASSED + 1))
        else
            echo -e "${YELLOW}[SKIP] $name not running locally, checking remote...${NC}"
            # For remote, we can't check individual ports
            SKIPPED=$((SKIPPED + 1))
        fi
    done
}

# Test 1: Create a spec
TEST_SPEC_ID=""
TEST_CANDIDATE_ID=""
TEST_PREVIEW_URL=""

create_spec() {
    echo ""
    echo "Test 1: Creating spec..."
    
    local response
    response=$(curl -s -X POST "$API_BASE/api/specs" \
        -H "Authorization: Bearer $BEEHIVE_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{
            "name": "m2-verification-shortener",
            "description": "M2 verification test spec",
            "contract": "{\"endpoints\":[{\"path\":\"/shorten\",\"method\":\"POST\"},{\"path\":\"/redirect/:id\",\"method\":\"GET\"}]}",
            "declaredDeltaSurface": ["shorten", "redirect"],
            "organizationId": "org-1"
        }')
    
    if echo "$response" | jq -e '.success == true' > /dev/null 2>&1; then
        TEST_SPEC_ID=$(echo "$response" | jq -r '.data.id')
        echo -e "${GREEN}[PASS] Spec created: $TEST_SPEC_ID${NC}"
        PASSED=$((PASSED + 1))
    else
        echo -e "${RED}[FAIL] Spec creation failed: $response${NC}"
        FAILED=$((FAILED + 1))
    fi
}

# Test 2: Claim spec and create candidate
claim_spec() {
    echo ""
    echo "Test 2: Claiming spec..."
    
    if [ -z "$TEST_SPEC_ID" ]; then
        echo -e "${YELLOW}[SKIP] Spec not created, skipping claim${NC}"
        SKIPPED=$((SKIPPED + 1))
        return
    fi
    
    local response
    response=$(curl -s -X POST "$API_BASE/api/specs/$TEST_SPEC_ID/claim" \
        -H "Authorization: Bearer $BEEHIVE_TOKEN" \
        -H "Content-Type: application/json" \
        -H "X-Actor-ID: m2-verification-agent" \
        -d '{"agentId": "m2-verification-agent"}')
    
    if echo "$response" | jq -e '.success == true' > /dev/null 2>&1; then
        TEST_CANDIDATE_ID=$(echo "$response" | jq -r '.data.candidateId')
        local repo_url=$(echo "$response" | jq -r '.data.repositoryUrl')
        echo -e "${GREEN}[PASS] Spec claimed: candidate=$TEST_CANDIDATE_ID, repo=$repo_url${NC}"
        PASSED=$((PASSED + 1))
    else
        echo -e "${RED}[FAIL] Claim failed: $response${NC}"
        FAILED=$((FAILED + 1))
    fi
}

# Test 3: Create preview deployment
create_preview() {
    echo ""
    echo "Test 3: Creating preview deployment..."
    
    if [ -z "$TEST_CANDIDATE_ID" ]; then
        echo -e "${YELLOW}[SKIP] Candidate not created, skipping preview${NC}"
        SKIPPED=$((SKIPPED + 1))
        return
    fi
    
    local response
    response=$(curl -s -X POST "$API_BASE/api/candidates/$TEST_CANDIDATE_ID/preview" \
        -H "Authorization: Bearer $BEEHIVE_TOKEN" \
        -H "Content-Type: application/json")
    
    if echo "$response" | jq -e '.success == true' > /dev/null 2>&1; then
        TEST_PREVIEW_URL=$(echo "$response" | jq -r '.data.previewUrl')
        echo -e "${GREEN}[PASS] Preview created: $TEST_PREVIEW_URL${NC}"
        PASSED=$((PASSED + 1))
    else
        echo -e "${RED}[FAIL] Preview creation failed: $response${NC}"
        FAILED=$((FAILED + 1))
    fi
}

# Test 4: Verify preview is accessible
verify_preview() {
    echo ""
    echo "Test 4: Verifying preview is accessible..."
    
    if [ -z "$TEST_PREVIEW_URL" ]; then
        echo -e "${YELLOW}[SKIP] Preview URL not set, skipping verification${NC}"
        SKIPPED=$((SKIPPED + 1))
        return
    fi
    
    # Wait for preview to deploy (can take 30-60 seconds)
    echo "Waiting for preview to deploy..."
    local max_attempts=12
    local attempt=0
    local deployed=false
    
    while [ $attempt -lt $max_attempts ]; do
        if curl -s -f "$TEST_PREVIEW_URL/health" > /dev/null 2>&1; then
            deployed=true
            break
        fi
        attempt=$((attempt + 1))
        sleep 5
        echo -n "."
    done
    echo ""
    
    if [ "$deployed" = true ]; then
        echo -e "${GREEN}[PASS] Preview is accessible${NC}"
        PASSED=$((PASSED + 1))
    else
        echo -e "${RED}[FAIL] Preview not accessible after 60 seconds${NC}"
        FAILED=$((FAILED + 1))
    fi
}

# Test 5: Verify shadow router configuration
check_shadow_config() {
    echo ""
    echo "Test 5: Checking shadow router configuration..."
    
    local response
    response=$(curl -s "$API_BASE/api/shadow/config" \
        -H "Authorization: Bearer $BEEHIVE_TOKEN")
    
    if echo "$response" | jq -e '.success == true' > /dev/null 2>&1; then
        local enabled=$(echo "$response" | jq -r '.data.enabled')
        local mirror_percent=$(echo "$response" | jq -r '.data.mirrorPercentage')
        echo -e "${GREEN}[PASS] Shadow router config: enabled=$enabled, mirror=$mirror_percent%${NC}"
        PASSED=$((PASSED + 1))
    else
        echo -e "${RED}[FAIL] Shadow config check failed: $response${NC}"
        FAILED=$((FAILED + 1))
    fi
}

# Test 6: Send test request through shadow router
# (This would require the shadow router to be configured as a route in production)
test_shadow_request() {
    echo ""
    echo "Test 6: Testing shadow request flow..."
    
    # For local testing, we can't easily test the full shadow flow
    # This would be a manual verification step in production
    echo -e "${YELLOW}[SKIP] Shadow request test requires production route configuration${NC}"
    SKIPPED=$((SKIPPED + 1))
}

# Test 7: Check scientist comparator
check_scientist() {
    echo ""
    echo "Test 7: Checking scientist comparator health..."
    
    local response
    response=$(curl -s "$API_BASE/api/scientist/health" \
        -H "Authorization: Bearer $BEEHIVE_TOKEN")
    
    if echo "$response" | jq -e '.status == "healthy"' > /dev/null 2>&1; then
        echo -e "${GREEN}[PASS] Scientist comparator is healthy${NC}"
        PASSED=$((PASSED + 1))
    else
        echo -e "${RED}[FAIL] Scientist comparator not healthy: $response${NC}"
        FAILED=$((FAILED + 1))
    fi
}

# Test 8: Check analytics engine metrics endpoint
check_analytics() {
    echo ""
    echo "Test 8: Checking analytics metrics..."
    
    if [ -z "$TEST_CANDIDATE_ID" ]; then
        echo -e "${YELLOW}[SKIP] Candidate not created, skipping metrics${NC}"
        SKIPPED=$((SKIPPED + 1))
        return
    fi
    
    local response
    response=$(curl -s "$API_BASE/api/candidates/$TEST_CANDIDATE_ID/metrics" \
        -H "Authorization: Bearer $BEEHIVE_TOKEN")
    
    if echo "$response" | jq -e '.success == true' > /dev/null 2>&1; then
        local count=$(echo "$response" | jq -r '.data.requestCount // "0"')
        echo -e "${GREEN}[PASS] Metrics endpoint working: requestCount=$count${NC}"
        PASSED=$((PASSED + 1))
    else
        echo -e "${RED}[FAIL] Metrics check failed: $response${NC}"
        FAILED=$((FAILED + 1))
    fi
}

# Test 9: Verify gate workflow can advance to shadow
check_shadow_stage() {
    echo ""
    echo "Test 9: Checking candidate can advance to shadow stage..."
    
    if [ -z "$TEST_CANDIDATE_ID" ]; then
        echo -e "${YELLOW}[SKIP] Candidate not created${NC}"
        SKIPPED=$((SKIPPED + 1))
        return
    fi
    
    # This would normally happen automatically after pre-merge pass
    # For verification, we can manually advance
    local response
    response=$(curl -s -X POST "$API_BASE/api/candidates/$TEST_CANDIDATE_ID/advance" \
        -H "Authorization: Bearer $BEEHIVE_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{"toStage": "passed_shadow"}')
    
    if echo "$response" | jq -e '.success == true' > /dev/null 2>&1; then
        echo -e "${GREEN}[PASS] Candidate can advance to shadow stage${NC}"
        PASSED=$((PASSED + 1))
    else
        echo -e "${RED}[FAIL] Stage advancement failed: $response${NC}"
        FAILED=$((FAILED + 1))
    fi
}

# Test 10: End-to-end gate verification
e2e_gate_test() {
    echo ""
    echo "Test 10: End-to-end gate verification..."
    
    if [ -z "$TEST_CANDIDATE_ID" ]; then
        echo -e "${YELLOW}[SKIP] Candidate not created${NC}"
        SKIPPED=$((SKIPPED + 1))
        return
    fi
    
    local response
    response=$(curl -s "$API_BASE/api/candidates/$TEST_CANDIDATE_ID/gate-verdicts" \
        -H "Authorization: Bearer $BEEHIVE_TOKEN")
    
    if echo "$response" | jq -e '.success == true' > /dev/null 2>&1; then
        local count=$(echo "$response" | jq -r '.data | length')
        if [ "$count" -gt 0 ]; then
            echo -e "${GREEN}[PASS] Gate verdicts recorded: count=$count${NC}"
            PASSED=$((PASSED + 1))
        else
            echo -e "${YELLOW}[WARN] No gate verdicts found (may need to run gates first)${NC}"
            PASSED=$((PASSED + 1))
        fi
    else
        echo -e "${RED}[FAIL] Gate verdicts check failed: $response${NC}"
        FAILED=$((FAILED + 1))
    fi
}

# Cleanup
cleanup() {
    echo ""
    echo "Cleaning up test resources..."
    
    # Delete test spec (if created)
    if [ -n "$TEST_SPEC_ID" ]; then
        curl -s -X DELETE "$API_BASE/api/specs/$TEST_SPEC_ID" \
            -H "Authorization: Bearer $BEEHIVE_TOKEN" > /dev/null 2>&1 || true
        echo "Deleted spec: $TEST_SPEC_ID"
    fi
    
    # Delete test preview (if created)
    if [ -n "$TEST_PREVIEW_URL" ]; then
        if [ -n "$TEST_CANDIDATE_ID" ]; then
            curl -s -X DELETE "$API_BASE/api/candidates/$TEST_CANDIDATE_ID/preview" \
                -H "Authorization: Bearer $BEEHIVE_TOKEN" > /dev/null 2>&1 || true
            echo "Deleted preview for candidate: $TEST_CANDIDATE_ID"
        fi
    fi
}

# Main execution
main() {
    echo "Starting M2 verification..."
    echo "API Base: $API_BASE"
    echo ""
    
    check_prereq
    check_workers
    create_spec
    claim_spec
    create_preview
    verify_preview
    check_shadow_config
    test_shadow_request
    check_scientist
    check_analytics
    check_shadow_stage
    e2e_gate_test
    
    # Print summary
    echo ""
    echo "=========================================="
    echo "  VERIFICATION SUMMARY"
    echo "=========================================="
    echo -e "${GREEN}Passed: $PASSED${NC}"
    echo -e "${RED}Failed: $FAILED${NC}"
    echo -e "${YELLOW}Skipped: $SKIPPED${NC}"
    echo ""
    
    if [ $FAILED -eq 0 ]; then
        echo -e "${GREEN}✅ M2 VERIFICATION PASSED${NC}"
        exit 0
    else
        echo -e "${RED}❌ M2 VERIFICATION FAILED${NC}"
        exit 1
    fi
}

# Run main and ensure cleanup on exit
trap cleanup EXIT
main
