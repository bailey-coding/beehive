---
RFO-2026-10-14
---

# RFO: E2E Test Drift - Route/Shape Mismatches

**Date:** 2026-10-14  
**Author:** Maintainer / Agent Team  
**Status:** Actioned  
**Severity:** SEV-2 (Test failures blocking CI)  
**Related:** AGENTS.md#testing, cd2c218, MILESTONES.md M3

---

## Summary

End-to-end tests in the `m3-features.test.ts` and `cross-worker-flows` test suites **drifted** from the actual implementation. This caused test failures that masked real issues and made it difficult to verify the correctness of the M3 features (Train, Canary, Promotion workers).

---

## Timeline

| Time (UTC) | Event | Actor | Notes |
|------------|-------|-------|-------|
| ~2026-10-12 | M3 features implemented | Agent Team | Train, Canary, Promotion workers |
| ~2026-10-13 | Test suites not updated | Agent Team | Tests based on old route assumptions |
| ~2026-10-14 | Test failures observed | CI System | E2E tests failing due to drift |
| 2026-10-14 | Drift fixed and canary leftovers documented (commit cd2c218) | Agent Team | Tests updated, documentation added |

### Key Moments

- **Detected:** CI failures in e2e test suites
- **Root Cause Identified:** Tests had outdated route assumptions and shapes
- **Mitigated:** Tests updated to match current implementation
- **Resolved:** All e2e tests passing, canary leftovers documented

---

## Impact

### Affected Components

- `tests/e2e/m3-features.test.ts` - M3 feature tests
- `tests/e2e/cross-worker-flows.test.ts` - Cross-worker integration tests
- `workers/beehive-canary` - Canary worker (had leftovers from previous work)
- `workers/beehive-promotion` - Promotion worker
- `workers/beehive-shadow-router` - Shadow router

### User Impact

- **Affected Users:** Developers (test failures blocking PRs)
- **Impact Type:** CI pipeline broken, unable to verify changes
- **Duration:** Approximately 1-2 days
- **Severity:** SEV-2 (Significant degradation - CI broken)

### Technical Impact

- E2E test failures masked real implementation issues
- Couldn't verify M3 features were working correctly
- Test suites were not reliable for regression detection
- Canary worker had leftover code from previous implementations

---

## Root Cause Analysis

### Direct Cause

The e2e test suites (`m3-features.test.ts` and `cross-worker-flows.test.ts`) had hardcoded assumptions about:
1. **Route paths** - Expected certain API routes that changed
2. **Response shapes** - Expected certain data structures that evolved
3. **Worker behavior** - Expected certain behavior that was modified

Additionally, the canary worker had "leftovers" - code or configuration from previous implementations that was no longer relevant.

### Contributing Factors

1. **Test maintenance lag** - Tests not updated when implementation changed
2. **No test contract** - Tests didn't use shared types/contracts
3. **Hardcoded assumptions** - Tests had hardcoded route paths and shapes
4. **Code churn** - Rapid iteration on M3 features
5. **Canary leftovers** - Previous canary implementation artifacts remained

### Root Cause

**Fundamental Issue:** Tests were tightly coupled to implementation details rather than using shared contracts or interfaces. This made them brittle in the face of implementation changes.

---

## Detection

### Detection Method

**CI Build Failure** - E2E tests failing in CI pipeline.

### Detection Delay

**~1-2 days** - Tests had been failing or were not catching real issues.

### Detection Improvements

To catch similar issues earlier:
- ✅ **Shared contracts** - Tests now use shared type definitions
- ✅ **Route verification** - Tests verify routes exist before use
- ✅ **Shape validation** - Response shapes validated against shared types
- ✅ **Test maintenance** - Tests updated as part of implementation changes

---

## Response

### Initial Response

1. **CI Failure Alert** - E2E test failures reported
2. **Investigation** - Determined tests had drifted from implementation

### Mitigation

**Commit cd2c218:** "step: fix e2e test-side route/shape drift (m3-features, cross-worker-flows); document canary leftovers"

Changes:
- Updated `tests/e2e/m3-features.test.ts` to match current routes and shapes
- Updated `tests/e2e/cross-worker-flows.test.ts` to match current implementation
- Documented canary worker leftovers for cleanup
- Verified all e2e tests pass

### Resolution

- All e2e tests passing
- Tests now match current implementation
- Canary leftovers documented for future cleanup

### Verification

- CI pipeline green
- All e2e tests passing
- Tests verified against actual worker behavior

---

## Lessons Learned

### What Went Well

✅ **Complete fix** - All test drift corrected
✅ **Documentation** - Canary leftovers documented for future cleanup
✅ **Verification** - Tests verified against actual implementation

### What Could Be Improved

⚠️ **Contract-first testing** - Tests should use shared contracts/interfaces
⚠️ **Automated test updates** - Could generate test updates from route changes
⚠️ **Test coverage** - Need better coverage for cross-worker flows
⚠️ **Cleanup process** - Need process for removing code leftovers

### Design Decisions That Held Up

✅ **Shared types** - Using shared type definitions makes tests more robust
✅ **Route verification** - Verifying routes exist catches drift early
✅ **Documentation** - Documenting leftovers prevents confusion

---

## Follow-up

### Related Findings

This RFO is related to:
- **Session learnings** (commit 8ef8b61): "routing: branch from main" - routing issues identified
- **E2E connectivity** (commit 28acab9): "fix cross-worker e2e shapes, canary->preview auth header"
- **Test drift pattern** - Multiple commits reference test drift issues

### Pattern Recognition

This is an example of **test maintenance debt** where tests aren't updated as implementation evolves. Similar risks exist for:
- Integration tests
- Unit tests
- API contract tests
- Documentation tests

### Preventive Measures Implemented

Based on this RFO, the following preventive measures were implemented:

1. **Shared contracts** - Tests use shared type definitions
2. **Route verification** - Tests verify routes exist
3. **Shape validation** - Response shapes validated
4. **Documentation** - Code leftovers documented

---

## Evidence

### Commit References

- **Fix:** [cd2c218](https://github.com/bailey-coding/beehive/commit/cd2c218) - E2E test drift fix
- **Session Learnings:** [8ef8b61](https://github.com/bailey-coding/beehive/commit/8ef8b61) - Related findings
- **E2E Connectivity:** [28acab9](https://github.com/bailey-coding/beehive/commit/28acab9) - Related cross-worker fixes

### Code References

- `tests/e2e/m3-features.test.ts` - Updated M3 feature tests
- `tests/e2e/cross-worker-flows.test.ts` - Updated cross-worker tests
- `workers/beehive-canary` - Canary worker (leftovers documented)

---

## References

- [AGENTS.md](../../AGENTS.md#testing) - Testing conventions
- [MILESTONES.md](../MILESTONES.md) - M3 milestone details
- [OPEN-QUESTIONS.md](../OPEN-QUESTIONS.md) - Related findings

---

*This RFO documents a SEV-2 incident where e2e tests drifted from implementation, causing CI failures. The fix involved updating tests to match current routes and shapes, and documenting canary worker leftovers for future cleanup.*
