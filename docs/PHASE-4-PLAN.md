---
category: planning
status: completed
milestone: m4
audience: human,agent
tags:
  - phase-report
---

# Phase 4: Integration & E2E Testing Plan

**Milestone:** Phase 4: Integration & E2E  
**Task:** test-phase-4  
**Spec:** Testing  
**Confidence:** 1.0  
**Timeline:** Weeks 5-6  
**Effort:** 26 hours  
**Status:** IN PROGRESS

---

## Overview

Phase 4 is the final phase of the Beehive Test Implementation Plan. This phase focuses on:
1. Completing integration tests from Phase 2
2. Adding comprehensive E2E tests for the oracle ladder
3. Adding E2E tests for M3 features (canary, promotion, shadow)
4. Enhancing synthetic monitoring capabilities

---

## Prerequisites

- [x] Phase 3 complete - docs/PHASE-3-MERGE-REPORT.md exists
- [x] All M3 feature branches merged (canary, promotion, statsig)
- [x] All workers deployed and functional

---

## Workflow

Following the **DOCUMENT→CREATE→REVIEW→MERGE** pattern:

1. **DOCUMENT** (✅ Current): Create this plan document
2. **CREATE**: Implement all tests and enhancements
3. **REVIEW**: Validate all tests pass, create review document
4. **MERGE**: Commit, push to main, create merge report

---

## Deliverables

### Test Files (58+ new passing tests)

| # | File | Description | Expected Tests |
|---|------|-------------|---------------|
| 1 | `tests/integration/bindings.test.ts` | Integration tests for worker bindings | 20 tests |
| 2 | `tests/e2e/oracle-ladder.test.ts` | E2E tests for all oracle ladder rungs | 20 tests |
| 3 | `tests/e2e/m3-features.test.ts` | E2E tests for M3 features | 20 tests |

### Enhanced Monitoring

| File | Description |
|------|-------------|
| `scripts/synthetic-monitoring-enhanced.sh` | Enhanced version with M3 feature checks |

### Documentation

- [ ] docs/PHASE-4-PLAN.md (✅ This document)
- [ ] docs/PHASE-4-REVIEW.md
- [ ] docs/PHASE-4-MERGE-REPORT.md

---

## Coverage Goals

- **Total Test Coverage:** 75-80%
- **New Tests:** 58+
- **Integration Tests:** 20+
- **E2E Tests:** 40+

---

## Task Breakdown

### 1. Integration Tests - Bindings (tests/integration/bindings.test.ts)

**Purpose:** Test cross-worker communication and binding integration

**Test Categories:**
- [ ] Service bindings between workers
- [ ] Queue bindings (beehive-artifacts-push)
- [ ] Durable Object bindings (SPEC_DO)
- [ ] KV namespace bindings
- [ ] R2 bucket bindings
- [ ] D1 database bindings
- [ ] Analytics Engine bindings
- [ ] Binding error handling
- [ ] Binding timeout scenarios
- [ ] Binding retry logic

**Dependencies:**
- workers/api/index.ts
- workers/gate-workflow/index.ts
- workers/sandbox-runner/index.ts
- workers/queue-consumer/index.ts
- workers/shadow-router/index.ts
- workers/canary-worker/
- workers/promotion-worker/

---

### 2. E2E Tests - Oracle Ladder (tests/e2e/oracle-ladder.test.ts)

**Purpose:** Test the complete oracle ladder workflow from pre-merge to full deployment

**Oracle Ladder Rungs:**

```
Pre-merge → Shadow → Train → Canary → Full
   ↓          ↓       ↓       ↓      ↓
Gate        Scientist Promotion Canary  (Future)
Workflow    Comparator Worker  Worker  Worker
```

**Test Categories:**

#### Rung 1: Pre-merge (Gate Workflow)
- [ ] Candidate submission validation
- [ ] Spec retrieval from Spec DO
- [ ] Test execution in sandbox
- [ ] Conformance checking
- [ ] Complexity delta calculation
- [ ] Gate verdict recording
- [ ] Pass/fail threshold enforcement

#### Rung 2: Shadow (Shadow Router + Scientist)
- [ ] Traffic mirroring setup
- [ ] Request duplication to candidate
- [ ] Response comparison
- [ ] Delta surface validation
- [ ] Shadow mode activation/deactivation
- [ ] Statsig integration for traffic splitting

#### Rung 3: Train (Promotion Worker)
- [ ] Tournament mode selection
- [ ] Merge-train mode selection
- [ ] Candidate queuing
- [ ] Promotion criteria evaluation
- [ ] Car drop/rejection logic
- [ ] Train state persistence
- [ ] Projection slice management

#### Rung 4: Canary (Canary Worker)
- [ ] Canary deployment creation
- [ ] SLO monitoring setup
- [ ] Auto-rollback triggering
- [ ] Traffic percentage allocation
- [ ] Canary health checks
- [ ] Rollback verification

#### Cross-Rung Tests
- [ ] Promotion from pre-merge to shadow
- [ ] Promotion from shadow to train
- [ ] Promotion from train to canary
- [ ] Rollback from canary to train
- [ ] Full workflow execution

**Dependencies:**
- All workers must be running
- Spec DO must be initialized
- Test repositories in Artifacts

---

### 3. E2E Tests - M3 Features (tests/e2e/m3-features.test.ts)

**Purpose:** Test M3-specific features (Statsig, Canary, Promotion)

**Test Categories:**

#### Statsig Integration
- [ ] Statsig SDK initialization
- [ ] Feature flag evaluation
- [ ] Traffic splitting configuration
- [ ] Dynamic configuration updates
- [ ] Error handling for Statsig failures

#### Canary Worker
- [ ] Canary worker health check
- [ ] Canary deployment creation
- [ ] SLO metric collection
- [ ] Auto-rollback on SLO violation
- [ ] Manual rollback triggering
- [ ] Canary traffic percentage management
- [ ] Canary cleanup on completion

#### Promotion Worker
- [ ] Tournament mode initialization
- [ ] Tournament participant registration
- [ ] Tournament winner selection
- [ ] Merge-train initialization
- [ ] Merge-train car management
- [ ] Train projection calculation
- [ ] Car promotion logic
- [ ] Car drop logic

**Dependencies:**
- workers/canary-worker/canary.ts
- workers/promotion-worker/
- workers/shadow-router/index.ts
- Statsig SDK configured

---

### 4. Synthetic Monitoring Enhancement

**Current:** scripts/synthetic-monitoring.sh

**Enhancements for scripts/synthetic-monitoring-enhanced.sh:**

#### Additional Checks
- [ ] Oracle ladder workflow verification
- [ ] M3 worker health checks
- [ ] Canary deployment monitoring
- [ ] Promotion train status
- [ ] Shadow router traffic splitting verification
- [ ] Spec DO ledger integrity checks

#### Enhanced Features
- [ ] Historical performance tracking
- [ ] Anomaly detection
- [ ] Alert thresholds per check
- [ ] Configurable check intervals
- [ ] Parallel check execution
- [ ] Detailed reporting with metrics

#### Improved Error Handling
- [ ] Automatic retry with exponential backoff
- [ ] Circuit breaker pattern
- [ ] Check result caching
- [ ] Graceful degradation

#### New Commands
```bash
# Run enhanced monitoring
./synthetic-monitoring-enhanced.sh [namespace] [repo] [interval]

# Run specific check
./synthetic-monitoring-enhanced.sh --check oracle-ladder

# Run with custom config
./synthetic-monitoring-enhanced.sh --config custom-config.json

# Generate report
./synthetic-monitoring-enhanced.sh --report --output report.json
```

---

## Test Execution Strategy

### Test Environment Setup

1. Start all workers in development mode
2. Initialize Spec DO with test data
3. Create test repositories in Artifacts
4. Configure test agents
5. Set up monitoring dashboards

### Test Execution Order

1. **Unit Tests** (existing)
   - workers/gate-workflow/tests/gate.test.ts
   - workers/sandbox-runner/tests/sandbox.test.ts

2. **Integration Tests** (new)
   - tests/integration/bindings.test.ts

3. **E2E Tests** (new)
   - tests/e2e/oracle-ladder.test.ts
   - tests/e2e/m3-features.test.ts

### Test Configuration

```typescript
// vitest.config.ts
{
  test: {
    environment: 'cloudflare-workers',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: [
      'workers/**/tests/*.test.ts',
      'tests/**/*.test.ts'
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: './coverage',
    }
  }
}
```

---

## Validation Criteria

### Test Quality
- [ ] All tests follow AAA pattern (Arrange-Act-Assert)
- [ ] All tests have descriptive names
- [ ] All tests include error handling
- [ ] All tests clean up after themselves
- [ ] All tests are deterministic (no flaky tests)

### Coverage
- [ ] 75-80% total code coverage
- [ ] 100% coverage of critical paths
- [ ] All public APIs tested
- [ ] All error conditions tested

### Performance
- [ ] Tests complete within 5 minutes
- [ ] No memory leaks in long-running tests
- [ ] Parallel test execution where possible

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Worker binding issues | Medium | High | Test with mock bindings first |
| Oracle ladder complexity | High | High | Break into smaller test suites |
| M3 feature instability | Medium | Medium | Test each feature independently |
| Test flakiness | Medium | Medium | Use retries and timeouts |
| Performance issues | Low | Medium | Optimize test execution |

---

## Timeline

| Day | Task | Effort |
|-----|------|--------|
| 1 | Create Phase 4 Plan | 2 hours |
| 2 | Implement bindings.test.ts | 6 hours |
| 3 | Implement oracle-ladder.test.ts | 8 hours |
| 4 | Implement m3-features.test.ts | 6 hours |
| 5 | Enhance synthetic monitoring | 4 hours |
| 6 | Review, fix, validate | 6 hours |
| 7 | Merge to main | 2 hours |

---

## Success Criteria

- [ ] 58+ new passing tests
- [ ] 75-80% total test coverage
- [ ] Enhanced synthetic monitoring script
- [ ] All documentation complete
- [ ] All changes committed to main
- [ ] Merge report created

---

## Next Steps

1. Begin implementation of `tests/integration/bindings.test.ts`
2. Set up test infrastructure if needed
3. Execute tests incrementally
4. Fix issues as they arise
5. Document findings in review report

---

*Document created: 2026-10-13*  
*Agent: Phase 4 Test Implementation Agent*  
*Confidence: 1.0*
