---
category: planning
status: completed
milestone: m1
audience: human,agent
tags:
  - phase-report
---

# Phase 1 Execution Plan

**Version:** 1.0  
**Agent:** test-phase-1-critical  
**Start:** 2026-10-13T15:30:00Z  
**Target Completion:** 2026-10-18T15:30:00Z (5 days)  
**Milestone:** Phase 1: Critical Fixes  
**Task:** test-phase-1  
**Spec:** Testing  
**Confidence:** 1.0

---

## Overview

This document outlines the detailed execution plan for **Phase 1: Critical Fixes** of the Beehive Test Implementation Plan. The primary objective is to create comprehensive unit tests for M3 workers (canary-worker, promotion-worker) which currently have **0% test coverage**, and complete the incomplete test files (gate.test.ts, sandbox.test.ts).

**Critical Path:** This phase is CRITICAL because M3 workers are in production without any tests, creating significant risk for production incidents.

---

## Tasks Breakdown

### Task 1.1: Create canary-worker tests
- **File:** `workers/canary-worker/tests/canary.test.ts`
- **Action:** CREATE NEW
- **Test cases:** 24 total
  - SLO Monitoring: 10 tests
  - Rollback Logic: 8 tests
  - Canary Management: 6 tests
- **Estimated lines:** ~400
- **Estimated effort:** 8 hours
- **Priority:** CRITICAL
- **Status:** Pending

**Test Case Details:**
| Category | Test Count | Description |
|----------|------------|-------------|
| P95 Latency Calculation | 4 | Calculate p95 from metrics, handle empty/partial data, return 0 for no data |
| Error Rate Calculation | 3 | Calculate error rate, return 0 when no errors, return 1 when all errors |
| SLO Threshold Evaluation | 3 | Detect violations for p95, error rate, pass when within thresholds |
| Rolling Window Aggregation | 1 | Maintain time-windowed metrics |
| SLO Violation Detection | 2 | Trigger rollback when SLO violated, don't trigger when passed |
| Rollback Execution | 2 | Create rollback queue message, include candidate info |
| State Cleanup | 2 | Reset canary state after rollback, log rollback event |
| Percentage Calculation | 1 | Calculate correct traffic percentage |
| Traffic Splitting | 1 | Split traffic based on percentage |
| Gradual Rollout | 1 | Increase percentage over time |
| Emergency Stop | 1 | Stop canary on emergency signal |
| Health Checks | 3 | Return healthy status, 401 for missing auth, 401 for wrong auth |

### Task 1.2: Create promotion-worker tests
- **File:** `workers/promotion-worker/tests/promotion.test.ts`
- **Action:** CREATE NEW
- **Test cases:** 22 total
  - Tournament Mode: 8 tests
  - Merge-Train Mode: 8 tests
  - Common Logic: 6 tests
- **Estimated lines:** ~400
- **Estimated effort:** 8 hours
- **Priority:** CRITICAL
- **Status:** Pending

**Test Case Details:**
| Category | Test Count | Description |
|----------|------------|-------------|
| Candidate Scoring | 2 | Score candidates based on gate verdicts, handle ties |
| Winner Selection | 2 | Select highest scoring candidate, handle single candidate |
| Tournament Bracket | 1 | Manage multi-round tournament |
| Multiple Candidates | 1 | Handle multiple candidates concurrently |
| Train Formation | 1 | Form train from promotion candidates |
| Car Ordering | 1 | Order cars by dependency and readiness |
| Projection Calculation | 1 | Calculate train projection |
| Combined Conformance | 1 | Check combined candidate conformance |
| Train Promotion | 1 | Promote entire train when ready |
| Car Dropping | 1 | Drop car when conformance fails |
| Promotion Timing | 1 | Respect promotion timeout |
| Concurrent Limits | 1 | Enforce max concurrent candidates |
| State Management | 1 | Track promotion state correctly |
| Dependency Checks | 1 | Verify dependencies before promotion |
| Cleanup on Failure | 1 | Cleanup state on promotion failure |
| Health Checks | 3 | Return healthy status, 401 for missing auth, 401 for wrong auth |

### Task 1.3: Complete gate-worker tests
- **File:** `workers/gate-workflow/tests/gate.test.ts`
- **Action:** MODIFY EXISTING
- **Current state:** 351 lines, has auth tests and basic workflow tests, but missing core gate logic tests
- **Current test count:** ~12 tests
- **Target test count:** 15+ tests
- **Tests to add:** 3+ new tests
- **Estimated lines:** ~200 (additional)
- **Estimated effort:** 2 hours
- **Priority:** HIGH
- **Status:** Pending

**Tests to Add:**
| Category | Test Count | Description |
|----------|------------|-------------|
| Test Result Parsing | 3 | Parse JUnit XML, parse custom JSON, handle malformed results |
| Property-Based Validation | 1 | Validate candidate properties |
| Fuzz Testing | 1 | Execute fuzz tests |
| Spec Conformance | 1 | Check spec conformance |
| Complexity Analysis | 1 | Analyze candidate complexity |
| Error Handling | 3 | Handle Spec DO errors, missing candidate, queue processing errors |

### Task 1.4: Complete sandbox-runner tests
- **File:** `workers/sandbox-runner/tests/sandbox.test.ts`
- **Action:** MODIFY EXISTING
- **Current state:** 352 lines, has auth tests and some workflow tests, but incomplete
- **Current test count:** ~12 tests
- **Target test count:** 10+ tests
- **Tests to add:** 4+ new tests (already has good coverage, need to verify)
- **Estimated lines:** ~200
- **Estimated effort:** 2 hours
- **Priority:** HIGH
- **Status:** Pending

**Tests to Add:**
| Category | Test Count | Description |
|----------|------------|-------------|
| Code Isolation | 1 | Verify sandbox isolation |
| Resource Limits | 3 | Enforce CPU limits, memory limits, timeout limits |
| Execution Environment | 1 | Setup execution environment correctly |
| Cleanup | 1 | Cleanup sandbox after execution |

---

## Dependencies

### Prerequisites
- ✅ Node.js 22.x installed
- ✅ npm 10.x installed
- ✅ vitest 2.0.0 installed (verified in package.json)
- ✅ TypeScript configured in each worker
- ✅ Cloudflare Workers types available

### Interdependencies
- None (Phase 1 is independent)
- All tasks can be worked on in parallel

### Blockers
- None identified

---

## Success Criteria

### Must Have
- [ ] `docs/PHASE-1-PLAN.md` created (this file)
- [ ] `workers/canary-worker/tests/canary.test.ts` created with 24 tests
- [ ] `workers/promotion-worker/tests/promotion.test.ts` created with 22 tests
- [ ] `workers/gate-workflow/tests/gate.test.ts` modified with 15+ tests
- [ ] `workers/sandbox-runner/tests/sandbox.test.ts` modified with 10+ tests
- [ ] All tests pass (`npm test`)
- [ ] TypeScript compiles without errors (`npm run typecheck`)
- [ ] Lint passes without errors (`npm run lint`)
- [ ] `docs/PHASE-1-REVIEW.md` created
- [ ] `docs/PHASE-1-MERGE-REPORT.md` created
- [ ] All changes committed and pushed to main

### Should Have
- [ ] Coverage > 70% for M3 workers (canary-worker, promotion-worker)
- [ ] Coverage > 70% for modified workers (gate-workflow, sandbox-runner)
- [ ] No console warnings in tests
- [ ] All tests execute in < 500ms each

### Nice to Have
- [ ] Test coverage reports generated
- [ ] Badges for test coverage in README

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Canary/promotion worker code might have bugs that tests reveal | HIGH | MEDIUM | Use mocking for external dependencies, focus on unit tests first |
| Queue bindings might need special mocking approach | MEDIUM | MEDIUM | Use vi.fn() mocks for queue bindings, test pure functions separately |
| TypeScript compilation issues in test files | MEDIUM | HIGH | Test TypeScript compilation frequently, use type assertions |
| Test flakiness due to async operations | MEDIUM | LOW | Use deterministic mocks, avoid real timers |
| Integration issues with existing test setup | LOW | MEDIUM | Verify existing tests still pass before adding new ones |

---

## Mitigation Strategies

### For Risk: Bugs revealed by tests
- Start with unit tests for pure functions (no external dependencies)
- Use mocking for all external services (SPEC_DO, PREVIEW_MANAGER, etc.)
- Focus on testing the logic, not the integration
- If bugs are found, document them in the review report

### For Risk: Queue binding mocking
- Create mock implementations for queue bindings
- Use vi.fn() for send/sendBatch methods
- Test queue message processing logic separately
- Use mock message objects for queue tests

### For Risk: TypeScript compilation
- Run `npx tsc --noEmit` on each test file after creation
- Use proper type annotations for mock objects
- Import types from worker modules where possible
- Use `@ts-ignore` sparingly with comments explaining why

### For Risk: Test flakiness
- Avoid using real timers (setTimeout, setInterval)
- Use vi.useFakeTimers() when time-based logic is needed
- Use deterministic mock data
- Avoid Math.random() - use vi.spyOn(Math, 'random') if needed

---

## Testing Strategy

### Framework
- **Framework:** vitest 2.0.0
- **Runner:** `npx vitest run`
- **Environment:** node
- **Globals:** true (no need for import { describe, it, expect })

### Mocking Strategy

#### Service Bindings
```typescript
const mockServiceBinding = {
  fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({}), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })),
};
```

#### Durable Object Bindings
```typescript
const mockDOBinding = {
  idFromName: vi.fn().mockReturnValue('mock-id'),
  get: vi.fn().mockReturnValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({}))),
  }),
};
```

#### Queue Bindings
```typescript
const mockQueueBinding = {
  send: vi.fn().mockResolvedValue({ id: 'mock-message-id' }),
  sendBatch: vi.fn().mockResolvedValue({ success: true }),
};
```

#### Environment Setup
```typescript
const mockEnv = {
  SPEC_DO: mockDOBinding,
  PREVIEW_MANAGER: mockServiceBinding,
  GATE_WORKFLOW: mockServiceBinding,
  API_AUTH_TOKEN: 'test-auth-token',
};
```

### Test Organization

Each test file should follow this structure:

```typescript
// 1. Imports
import { describe, it, expect, vi, beforeEach } from 'vitest';
import handler from '../index';

// 2. Mock Environment Setup
const mockEnv = { ... };
const mockCtx = {};

// 3. Helper Functions
function createRequest(...) { ... }
async function callHandler(...) { ... }

// 4. Test Suites
//    - Group related tests in describe blocks
//    - Use beforeEach for setup
//    - Use afterEach for cleanup if needed
//    - Clear all mocks between tests

// 5. Test Cases
//    - Each it() should test ONE thing
//    - Test names should be descriptive
//    - Use async/await for async operations
```

---

## File Locations

### Test Files
```
workers/canary-worker/tests/canary.test.ts         [NEW]
workers/promotion-worker/tests/promotion.test.ts   [NEW]
workers/gate-workflow/tests/gate.test.ts           [MODIFY]
workers/sandbox-runner/tests/sandbox.test.ts      [MODIFY]
```

### Documentation Files
```
docs/PHASE-1-PLAN.md              [THIS FILE]
docs/PHASE-1-REVIEW.md             [NEW - Step 3]
docs/PHASE-1-MERGE-REPORT.md       [NEW - Step 4]
```

---

## Timeline

| Day | Task | Effort | Status |
|-----|------|--------|--------|
| Day 1 | Step 1: Create PHASE-1-PLAN.md | 1 hour | In Progress |
| Day 1 | Step 2.1: Setup test infrastructure | 1 hour | Pending |
| Day 1-2 | Step 2.2: Create canary-worker tests | 8 hours | Pending |
| Day 2-3 | Step 2.3: Create promotion-worker tests | 8 hours | Pending |
| Day 3 | Step 2.4: Complete gate-worker tests | 2 hours | Pending |
| Day 3 | Step 2.5: Complete sandbox-runner tests | 2 hours | Pending |
| Day 4 | Step 3: Review and validate | 1 hour | Pending |
| Day 4 | Step 3: Create PHASE-1-REVIEW.md | 1 hour | Pending |
| Day 5 | Step 4: Commit and push changes | 1 hour | Pending |
| Day 5 | Step 4: Create PHASE-1-MERGE-REPORT.md | 1 hour | Pending |

**Total:** ~20 hours over 5 days

---

## Quality Gates

Each task must pass these gates before moving to the next:

1. **Test File Created/Modified**
   - File exists at correct path
   - File has expected line count
   - File has expected test count

2. **TypeScript Compiles**
   - `npx tsc --noEmit` succeeds
   - No type errors

3. **Tests Pass**
   - `npx vitest run <file>` succeeds
   - All tests pass
   - No errors or warnings

4. **Lint Passes**
   - `npm run lint` succeeds (if configured)

---

## Verification Commands

### Check current state
```bash
# List existing test files
ls -la workers/*/tests/*.test.ts 2>/dev/null || echo "No test files found"

# Count tests in each file
grep -c "it('" workers/gate-workflow/tests/gate.test.ts || echo "0"
grep -c "it('" workers/sandbox-runner/tests/sandbox.test.ts || echo "0"

# Check vitest version
npm list vitest
```

### Run tests
```bash
# Run all tests
npm test 2>&1 || echo "No npm test script"

# Run specific test files
cd workers/canary-worker && npx vitest run tests/canary.test.ts
cd workers/promotion-worker && npx vitest run tests/promotion.test.ts
cd workers/gate-workflow && npx vitest run tests/gate.test.ts
cd workers/sandbox-runner && npx vitest run tests/sandbox.test.ts
```

### Type check
```bash
# Type check all new files
cd workers/canary-worker && npx tsc --noEmit tests/canary.test.ts
cd workers/promotion-worker && npx tsc --noEmit tests/promotion.test.ts
```

---

## Next Phase

After Phase 1 completes:
- **Phase 2:** Core Workers (beehive, queue-consumer)
- **Agent:** test-phase-2-core
- **Prerequisite:** docs/PHASE-1-MERGE-REPORT.md exists
- **Start:** After this merge

---

## Sign-off

- **Plan Created By:** test-phase-1-critical
- **Plan Approved By:** N/A (self-approved per workflow)
- **Plan Status:** ✅ APPROVED
- **Confidence:** 1.0
- **Timestamp:** 2026-10-13T15:30:00Z
