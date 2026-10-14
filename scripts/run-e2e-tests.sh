#!/usr/bin/env bash
# Run E2E Tests Script
# 
# Usage: ./scripts/run-e2e-tests.sh [options]
# 
# Options:
#   --env <environment>   Test environment: local, staging, production (default: local)
#   --test <test-file>    Run specific test file
#   --watch               Run in watch mode
#   --coverage            Generate coverage report
#   --verbose             Verbose output
#   --help                Show this help

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Default values
ENVIRONMENT="local"
TEST_FILE=""
WATCH_MODE=false
COVERAGE=false
VERBOSE=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      ENVIRONMENT="$2"
      shift 2
      ;;
    --test)
      TEST_FILE="$2"
      shift 2
      ;;
    --watch)
      WATCH_MODE=true
      shift
      ;;
    --coverage)
      COVERAGE=true
      shift
      ;;
    --verbose)
      VERBOSE=true
      shift
      ;;
    --help|-h)
      echo "Usage: $0 [options]"
      echo ""
      echo "Options:"
      echo "  --env <environment>   Test environment: local, staging, production (default: local)"
      echo "  --test <test-file>    Run specific test file (e.g., cross-worker-flows.test.ts)"
      echo "  --watch               Run in watch mode"
      echo "  --coverage            Generate coverage report"
      echo "  --verbose             Verbose output"
      echo "  --help                Show this help"
      echo ""
      echo "Examples:"
      echo "  # Run local E2E tests"
      echo "  $0"
      echo ""
      echo "  # Run production E2E tests"
      echo "  $0 --env production"
      echo ""
      echo "  # Run specific test file"
      echo "  $0 --env production --test cross-worker-flows.test.ts"
      echo ""
      echo "  # Run with coverage"
      echo "  $0 --env staging --coverage"
      echo ""
      echo "  # Run in watch mode"
      echo "  $0 --env local --watch"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      echo "Use --help for usage information"
      exit 1
      ;;
  esac
done

# Validate environment
if [[ ! "$ENVIRONMENT" =~ ^(local|staging|production)$ ]]; then
  echo "${RED}Error: Invalid environment '$ENVIRONMENT'${NC}"
  echo "Valid environments: local, staging, production"
  exit 1
fi

# Check for required tokens
if [[ "$ENVIRONMENT" == "production" && -z "${BEEHIVE_API_TOKEN:-}" ]]; then
  echo "${RED}Error: BEEHIVE_API_TOKEN is required for production tests${NC}"
  echo "Set BEEHIVE_API_TOKEN environment variable or create .env.test.production"
  exit 1
fi

if [[ "$ENVIRONMENT" == "staging" && -z "${STAGING_API_TOKEN:-}" ]]; then
  echo "${YELLOW}Warning: STAGING_API_TOKEN not set, using BEEHIVE_API_TOKEN${NC}"
  STAGING_API_TOKEN="${BEEHIVE_API_TOKEN:-}"
fi

# Build command
CMD="npx vitest run"

# Add environment
if [[ "$WATCH_MODE" == true ]]; then
  CMD="npx vitest watch"
fi

# Add test file if specified
if [[ -n "$TEST_FILE" ]]; then
  if [[ "$TEST_FILE" != */* ]]; then
    TEST_FILE="tests/e2e/$TEST_FILE"
  fi
  CMD="$CMD $TEST_FILE"
else
  CMD="$CMD tests/e2e"
fi

# Add coverage if requested
if [[ "$COVERAGE" == true ]]; then
  CMD="$CMD --coverage"
fi

# Add verbose if requested
if [[ "$VERBOSE" == true ]]; then
  CMD="$CMD --verbose"
fi

# Export environment
export E2E_ENVIRONMENT="$ENVIRONMENT"
export BEEHIVE_API_TOKEN="${BEEHIVE_API_TOKEN:-}"
export STAGING_API_TOKEN="${STAGING_API_TOKEN:-}"

# Print configuration
echo -e "${BLUE}=== E2E Test Configuration ===${NC}"
echo "Environment: $ENVIRONMENT"
echo "Test File: ${TEST_FILE:-all e2e tests}"
echo "Watch Mode: $WATCH_MODE"
echo "Coverage: $COVERAGE"
echo "Verbose: $VERBOSE"
if [[ "$ENVIRONMENT" == "production" ]]; then
  echo "Base URL: https://beehive.bz23711.workers.dev"
fi
echo ""

# Run tests
echo -e "${GREEN}Running tests...${NC}"
echo ""

eval "$CMD"

RESULT=$?

echo ""
if [[ $RESULT -eq 0 ]]; then
  echo -e "${GREEN}All tests passed!${NC}"
else
  echo -e "${RED}Some tests failed${NC}"
fi

exit $RESULT
