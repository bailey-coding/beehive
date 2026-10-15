---
category: planning
status: completed
milestone: m2
audience: human,agent
tags:
  - phase-report
---

# Phase 2 Execution Plan

## Overview
- **Phase:** 2 of 4 (Core Workers)
- **Agent:** test-phase-2-core
- **Start:** 2026-10-13T16:07:00Z
- **Target completion:** 2026-10-23T16:07:00Z (10 days)
- **Prerequisite:** Phase 1 complete ✅ (verified: docs/PHASE-1-MERGE-REPORT.md exists)
- **Milestone:** Phase 2: Core Workers
- **Task:** test-phase-2
- **Spec:** Testing
- **Confidence:** 1.0

---

## Tasks Breakdown

### Task 2.1: Create beehive (api) tests
- **File:** `workers/api/tests/api.test.ts`
- **Target:** Main API worker at `workers/api/index.ts`
- **Test cases:** 28 (API: 12, Spec DO interaction: 10, Shared: 6)
- **Estimated lines:** ~500
- **Estimated effort:** 8 hours
- **Worker:** beehive edge router (SPEC_DO orchestration)
- **Note:** Tests API handlers, auth middleware, error handling, and Spec DO integration

### Task 2.2: Create queue-consumer tests
- **File:** `workers/queue-consumer/tests/queue.test.ts`
- **Target:** Queue consumer worker at `workers/queue-consumer/index.ts`
- **Test cases:** 16 (Message: 10, Bindings: 6)
- **Estimated lines:** ~300
- **Estimated effort:** 4 hours
- **Worker:** Processes Artifacts push events, triggers gate workflow and preview manager

### Task 2.3: Create integration tests for bindings
- **File:** `tests/integration/bindings.test.ts`
- **Target:** All Cloudflare bindings across workers
- **Test cases:** 20+ (Service: 7, Queue: 6, DO: 4, Analytics: 3)
- **Estimated lines:** ~400
- **Estimated effort:** 6 hours
- **Note:** Integration tests that validate all binding types; may require real resources or detailed mocks

---

## Dependencies
- ✅ **Phase 1 completion** (Blocker - VERIFIED)
- ✅ `docs/PHASE-1-MERGE-REPORT.md` exists
- ✅ M3 workers have tests (canary-worker, promotion-worker)
- ✅ Existing tests for gate-workflow and sandbox-runner are complete
- ❌ No other dependencies

## Success Criteria
- [ ] All 3 test files created
- [ ] All tests pass (`npm test`)
- [ ] TypeScript compiles without errors (`npm run typecheck`)
- [ ] Lint passes without errors (`npm run lint`)
- [ ] Integration tests validate all binding types
- [ ] Core workers (api, queue-consumer) have 70-80% unit test coverage
- [ ] All changes committed and pushed to main

## Risks

### Risk 1: Service Bindings Mocking Complexity
- **Impact:** Difficulty in mocking Service bindings for unit tests
- **Likelihood:** Medium
- **Severity:** Medium
- **Mitigation:** Use vitest mocks for Service bindings; focus on unit testing handler logic, not binding connectivity
- **Contingency:** If mocking proves too complex, create partial mocks and document limitations

### Risk 2: Queue Bindings Real Resource Requirement
- **Impact:** Integration tests for queues may require real Cloudflare resources
- **Likelihood:** High
- **Severity:** Medium
- **Mitigation:** Use mocks for unit tests; create integration tests that can be skipped if resources unavailable
- **Contingency:** Mark integration tests with `.skip` if real queues not available; document requirement

### Risk 3: Spec DO Complex State
- **Impact:** Spec DO has complex SQLite state that's hard to mock
- **Likelihood:** Medium
- **Severity:** Medium
- **Mitigation:** Test handler logic with mocked DO stubs; create separate tests for DO logic in spec-do directory
- **Contingency:** Focus on API layer testing, defer DO internal testing to Phase 4

### Risk 4: Test File Location Ambiguity
- **Impact:** Uncertainty about where beehive tests should live (workers/api/ vs workers/beehive/)
- **Likelihood:** Low (resolved: api worker is at workers/api/)
- **Severity:** Low
- **Mitigation:** Use existing structure: tests for workers/api/ go in workers/api/tests/
- **Contingency:** N/A - resolved

## Mitigation Summary
- Use **mocks** for all external dependencies in unit tests
- Use **real resources** only for integration tests (and make them skippable)
- Focus on **unit tests first**, integration tests second
- Keep tests **fast** (< 500ms each)
- Keep tests **isolated** (no shared state)

---

## Test Architecture Decisions

### Mocking Strategy

**Service Bindings:**
```typescript
const mockServiceBinding = {
  fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({}))),
};
```

**Durable Object Bindings:**
```typescript
const mockDOBinding = {
  idFromName: vi.fn().mockReturnValue('do-id-123'),
  get: vi.fn().mockReturnValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({}))),
  }),
};
```

**Queue Bindings:**
```typescript
// For producers
const mockQueueBinding = {
  send: vi.fn().mockResolvedValue({ id: 'msg-123' }),
  sendBatch: vi.fn().mockResolvedValue({ success: true }),
};

// For consumers - messages come via fetch on the binding itself
```

### Test Organization

```
workers/
  api/
    tests/
      api.test.ts          # Unit tests for API handlers
  
  queue-consumer/
    tests/
      queue.test.ts        # Unit tests for queue message processing

tests/
  integration/
    bindings.test.ts      # Integration tests for all Cloudflare bindings
```

---

## Timeline

| Day | Date | Task | Effort | Status |
|-----|------|------|--------|--------|
| 1 | 2026-10-13 | DOCUMENT: Create this plan | 1 hour | ✅ In Progress |
| 2-3 | 2026-10-14 to 15 | CREATE: beehive tests | 8 hours | ⏳ Pending |
| 4 | 2026-10-16 | CREATE: queue-consumer tests | 4 hours | ⏳ Pending |
| 5-6 | 2026-10-17 to 18 | CREATE: bindings integration tests | 6 hours | ⏳ Pending |
| 7 | 2026-10-19 | REVIEW: Validate all tests | 1 hour | ⏳ Pending |
| 8 | 2026-10-20 | MERGE: Commit, push, document | 1 hour | ⏳ Pending |

**Total estimated effort:** 18 hours + 3 hours documentation = 21 hours
**Buffer:** 9 days remaining in 10-day window

---

## Prerequisites Verification

### Verified ✅
- [x] Git is clean (no uncommitted changes to tracked files)
- [x] `docs/PHASE-1-MERGE-REPORT.md` EXISTS
- [x] `docs/TEST-IMPLEMENTATION-PLAN.md` read
- [x] `docs/TEST-AUDIT-REPORT.md` read
- [x] Phase 1 deliverables verified:
  - [x] `workers/canary-worker/tests/canary.test.ts` EXISTS
  - [x] `workers/promotion-worker/tests/promotion.test.ts` EXISTS
  - [x] `workers/gate-workflow/tests/gate.test.ts` EXISTS (completed)
  - [x] `workers/sandbox-runner/tests/sandbox.test.ts` EXISTS (completed)

### Target Files Verified
- [x] `workers/api/index.ts` EXISTS (main beehive worker - 42KB)
- [x] `workers/queue-consumer/index.ts` EXISTS (12KB)
- [x] `tests/integration/bindings.test.ts` EXISTS (61KB - will be modified/expanded)

---

## Expected Deliverables

### New Files (3)
1. `docs/PHASE-2-PLAN.md` - This document ✅
2. `workers/api/tests/api.test.ts` - Unit tests for API worker (~500 lines, 28 tests)
3. `workers/queue-consumer/tests/queue.test.ts` - Unit tests for queue consumer (~300 lines, 16 tests)

### Modified Files (1)
1. `tests/integration/bindings.test.ts` - Expanded with additional binding tests (20+ tests)

### Documentation Files (3)
1. `docs/PHASE-2-REVIEW.md` - Validation report
2. `docs/PHASE-2-MERGE-REPORT.md` - Merge report

---

## Test Case Distribution

### workers/api/tests/api.test.ts (28 tests)
- **API Handlers:** 12 tests
  - POST /api/organizations
  - GET /api/organizations
  - GET /api/organizations/:id
  - POST /api/repositories
  - GET /api/repositories
  - GET /api/repositories/:id
  - POST /api/specs
  - GET /api/specs
  - GET /api/specs/:id
  - POST /api/specs/:id/claim
  - POST /api/candidates
  - GET /api/candidates/:id/gate-verdicts

- **Spec DO Operations:** 10 tests
  - Spec CRUD via DO stub
  - Candidate management
  - Gate verdict storage
  - Promotion state tracking
  - Transaction handling

- **Shared Utilities:** 6 tests
  - Auth middleware (401, 503 scenarios)
  - Error handling
  - Schema validation

### workers/queue-consumer/tests/queue.test.ts (16 tests)
- **Message Processing:** 10 tests
  - Artifacts push event parsing
  - Repository info extraction
  - Commit info extraction
  - Event type routing
  - Gate workflow triggering
  - Preview deployment triggering
  - Malformed event handling
  - Message batching
  - Error handling

- **Queue Bindings:** 6 tests
  - Queue message consumption
  - Batch message handling
  - ACK successful processing
  - NACK failed processing
  - Service binding calls (SPEC_DO, PREVIEW_MANAGER, GATE_WORKFLOW)

### tests/integration/bindings.test.ts (20+ tests)
- **Service Bindings:** 7 tests
  - SPEC_DO service binding
  - PREVIEW_MANAGER service binding
  - GATE_WORKFLOW service binding
  - SHADOW_ROUTER service binding
  - CANDIDATE_SERVICE service binding
  - SANDBOX_RUNNER service binding
  - QUEUE_CONSUMER service binding

- **Queue Bindings:** 6 tests
  - beehive-artifacts-push queue (producer and consumer)
  - canary-rollback-triggers queue
  - promotion-events queue

- **Durable Object Bindings:** 4 tests
  - SpecDO class accessibility
  - Data persistence
  - Concurrent requests
  - Transaction handling

- **Analytics Engine:** 3 tests
  - Data writing
  - Metrics handling
  - Error handling

---

## Quality Standards

### Test Requirements
- ✅ All tests must pass (`npm test`)
- ✅ TypeScript must compile (`npm run typecheck`)
- ✅ Lint must pass (`npm run lint`)
- ✅ No `console.log` or `console.error` in test files
- ✅ All test cases must be isolated
- ✅ All external dependencies must be mocked
- ✅ Test execution time < 500ms each (where possible)

### Code Style
- Follow existing code style in the repository
- Use `vi.fn()` for mocks (vitest)
- Use `describe()` and `it()` for test structure
- Use `beforeEach()` for test setup
- Use `vi.clearAllMocks()` in beforeEach

### Commit Message Format
```
test: <description> | task: test-phase-2 | spec: Testing | confidence: 1.0
```

---

## Sign-off
- **Agent:** test-phase-2-core
- **Status:** ✅ PLAN CREATED
- **Timestamp:** 2026-10-13T16:07:00Z
- **Confidence:** 1.0

**Phase 2 is READY TO START.**
