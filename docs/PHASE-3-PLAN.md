---
category: planning
status: completed
milestone: m3
audience: human,agent
tags:
  - phase-report
---

# Phase 3 Execution Plan

## Overview
- **Phase:** 3 of 4 (Remaining Workers)
- **Agent:** test-phase-3-remaining (Mistral Vibe)
- **Start:** 2026-10-13T15:54:00Z
- **Target completion:** 2026-10-14T00:00:00Z (competition deadline)
- **Timeline:** Accelerated (compressed to ~8 hours due to deadline)
- **Prerequisite:** Phase 2 complete

## Prerequisite Status

**BLOCKER IDENTIFIED:** Phase 2 is NOT complete.

- ✅ `docs/TEST-IMPLEMENTATION-PLAN.md` EXISTS
- ❌ `docs/PHASE-2-MERGE-REPORT.md` DOES NOT EXIST
- ❌ `workers/beehive/tests/beehive.test.ts` DOES NOT EXIST
- ❌ `workers/queue-consumer/tests/queue.test.ts` DOES NOT EXIST  
- ❌ `tests/integration/bindings.test.ts` DOES NOT EXIST

**Decision:** Proceeding with Phase 3 anyway per user's explicit instruction. Phase 3 test files are independent of Phase 2 workers and can be created in parallel. Phase 2 completion will be addressed separately.

---

## Tasks Breakdown

### Task 3.1: Create shadow-router tests
- **File:** `workers/shadow-router/tests/shadow.test.ts`
- **Test cases:** 14 (Routing: 8, Bindings: 4, Health: 2)
- **Estimated lines:** ~250
- **Estimated effort:** 2 hours (compressed from 4)
- **Status:** Pending

### Task 3.2: Create scientist-comparator tests
- **File:** `workers/scientist-comparator/tests/scientist.test.ts`
- **Test cases:** 12 (Comparison: 6, Bindings: 4, Health: 2)
- **Estimated lines:** ~200
- **Estimated effort:** 2 hours (compressed from 4)
- **Status:** Pending

### Task 3.3: Create preview-manager tests
- **File:** `workers/preview-manager/tests/preview.test.ts`
- **Test cases:** 12 (Deployment: 8, Bindings: 4)
- **Estimated lines:** ~200
- **Estimated effort:** 2 hours (compressed from 4)
- **Status:** Pending

### Task 3.4: Create candidate-service tests
- **File:** `workers/candidate-service/tests/candidate.test.ts`
- **Test cases:** 10 (Management: 6, Bindings: 4)
- **Estimated lines:** ~150
- **Estimated effort:** 2 hours (compressed from 4)
- **Status:** Pending

## Dependencies
- **Process dependency:** Phase 2 (NOT BLOCKING - proceeding per user instruction)
- **Technical dependency:** None - all 4 workers exist and can be tested independently

## Success Criteria
- [ ] All 4 test files created
- [ ] All tests pass (`npm test`)
- [ ] All tests type-check (`npm run typecheck`)
- [ ] All tests pass lint (`npm run lint`)
- [ ] All 4 remaining workers have 70%+ unit test coverage
- [ ] docs/PHASE-3-REVIEW.md created
- [ ] docs/PHASE-3-MERGE-REPORT.md created
- [ ] All changes committed and pushed to main
- [ ] **100% worker unit test coverage achieved** (all 10 workers tested)

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Preview-manager may require Workers Builds API access | Use mocks for external service calls; focus on unit tests for pure functions |
| Scientist-comparator may need Statsig mocking | Mock Statsig feature flag evaluations; use default values |
| Artifacts API mocking complexity | Use simple mocks; skip integration-heavy tests |
| Time pressure (8 hours vs 16 hours planned) | Focus on core test cases; use templates from Phase 3 prompt |

## File Structure Templates

### Mock Environment (Standard for all workers)
```typescript
const mockEnv = {
  SPEC_DO: {
    idFromName: vi.fn(),
    get: vi.fn(),
  },
  ANALYTICS: {
    writeDataPoint: vi.fn(),
  },
  ARTIFACTS: {},
  API_AUTH_TOKEN: 'test-auth-token',
};

const mockCtx = {};

function createRequest(
  path: string,
  method: string = 'GET',
  body?: unknown,
  headers?: Record<string, string>
): Request {
  const url = new URL(`http://localhost${path}`);
  return new Request(url.toString(), {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
}
```

### Health Check Tests (Standard for all workers - 2 tests each)
```typescript
describe('Health Checks', () => {
  it('should return healthy status', async () => {
    const request = createRequest('/health', 'GET', undefined, {
      Authorization: 'Bearer test-auth-token',
    });
    const response = await handler.fetch(request, mockEnv, mockCtx);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.status).toBe('healthy');
  });

  it('should return 503 for missing API_AUTH_TOKEN', async () => {
    const request = createRequest('/health', 'GET', undefined, {
      Authorization: 'Bearer test-auth-token',
    });
    const response = await handler.fetch(request, {
      ...mockEnv,
      API_AUTH_TOKEN: undefined,
    }, mockCtx);
    expect(response.status).toBe(503);
  });
});
```

## Execution Order

Due to time constraints, tests will be created in parallel where possible:
1. Create all 4 test files with stubs
2. Fill in test cases for each worker
3. Run validation on all files
4. Fix any issues iteratively

---

## Notes

- Using Vitest as test framework (already configured in package.json)
- All test files will use TypeScript
- Mocking strategy: mock all external bindings (SPEC_DO, ANALYTICS, ARTIFACTS, etc.)
- Focus on unit tests (pure functions, mock bindings)
- Integration tests that require deployed resources will be marked with `.skip`
- Follow existing patterns from gate-workflow and sandbox-runner tests

## Next Steps

Proceed to Step 2: CREATE - Implement all 4 test files with 52 total test cases.
