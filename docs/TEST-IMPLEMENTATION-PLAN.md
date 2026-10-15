---
category: feature
status: active
audience: human,agent
tags:
  - testing
  - implementation
---

# Beehive Test Implementation Plan

**Date:** 2026-10-13  
**Owner:** Test Implementation Team  
**Status:** PLANNING COMPLETE

---

## Executive Summary

This plan orchestrates **4 sequential phases** of test implementation using specialized agents, following the Beehive project's workflow pattern (document → fix/create → review → merge). Each phase has a dedicated agent responsible for executing all steps of that phase.

**Total Phases:** 4  
**Total Agents:** 4 (one per phase)  
**Total Estimated Effort:** ~80 hours  
**Total Timeline:** 6 weeks  

---

## Agent Architecture

Each phase uses a **single agent** that performs all 4 steps:

```
┌─────────────────────────────────────────────────────────────┐
│                     PHASE AGENT                                 │
├─────────────────────────────────────────────────────────────┤
│  1. DOCUMENT: Create detailed spec and plan                    │
│  2. FIX/CREATE: Implement tests                                  │
│  3. REVIEW: Validate and verify                                 │
│  4. MERGE: Commit, push, and create merge report                │
└─────────────────────────────────────────────────────────────┘
```

### Agent Workflow (Repeatable Pattern)

1. **DOCUMENT** → Creates `docs/PHASE-X-PLAN.md`
2. **FIX/CREATE** → Creates/modifies test files
3. **REVIEW** → Validates tests pass, creates `docs/PHASE-X-REVIEW.md`
4. **MERGE** → Commits to feature branch, pushes, creates PR, merges to main

---

## Phase-by-Phase Breakdown

---

## Phase 1: Critical Fixes (Week 1)

**Agent:** `test-phase-1-critical`  
**Timeline:** Week 1 (5 days)  
**Effort:** 20 hours  
**Priority:** CRITICAL ⚠️

### Scope
- Create unit tests for `beehive-canary-worker` (CRITICAL - 0% coverage)
- Create unit tests for `beehive-promotion-worker` (CRITICAL - 0% coverage)
- Complete `workers/gate-workflow/tests/gate.test.ts` (incomplete)
- Complete `workers/sandbox-runner/tests/sandbox.test.ts` (incomplete)

### Deliverables
| # | File | Lines | Coverage | Status |
|---|------|-------|----------|--------|
| 1 | `workers/canary-worker/tests/canary.test.ts` | ~400 | 80% | ✅ NEW |
| 2 | `workers/promotion-worker/tests/promotion.test.ts` | ~400 | 80% | ✅ NEW |
| 3 | `workers/gate-workflow/tests/gate.test.ts` | ~200 | 70% | ✅ FIXED |
| 4 | `workers/sandbox-runner/tests/sandbox.test.ts` | ~200 | 70% | ✅ FIXED |
| 5 | `docs/PHASE-1-PLAN.md` | ~100 | N/A | ✅ NEW |
| 6 | `docs/PHASE-1-REVIEW.md` | ~150 | N/A | ✅ NEW |
| 7 | `docs/PHASE-1-MERGE-REPORT.md` | ~100 | N/A | ✅ NEW |

### Test Cases for canary-worker
```typescript
// SLO Monitoring (10 tests)
- P95 latency calculation
- Error rate calculation  
- SLO threshold evaluation
- Rolling window aggregation
- Metrics data structures

// Rollback Logic (8 tests)
- SLO violation detection
- Rollback trigger conditions
- Rollback execution
- Queue message creation
- State cleanup

// Canary Management (6 tests)
- Percentage calculation
- Traffic splitting
- Gradual rollout
- Emergency stop
- Health checks
- Dependency checks
```

### Test Cases for promotion-worker
```typescript
// Tournament Mode (8 tests)
- Candidate scoring algorithm
- Winner selection
- Tournament bracket management
- Multiple candidates handling
- Tie-breaking logic

// Merge-Train Mode (8 tests)
- Train formation
- Car ordering
- Projection calculation
- Combined candidate conformance
- Train promotion logic
- Car dropping conditions

// Common Logic (6 tests)
- Promotion timing
- Concurrent limits
- State management
- Dependency checks
- Cleanup on failure
```

### Success Criteria
- [ ] All 4 test files pass `npm test`
- [ ] Coverage for M3 workers > 70%
- [ ] Existing tests are complete and passing
- [ ] All commits pushed to main
- [ ] Merge report documents all changes

---

## Phase 2: Core Workers (Weeks 2-3)

**Agent:** `test-phase-2-core`  
**Timeline:** Weeks 2-3 (10 days)  
**Effort:** 18 hours  
**Priority:** HIGH

### Scope
- Create unit tests for `beehive` (main API + Spec DO)
- Create unit tests for `beehive-queue-consumer`
- Integration tests for bindings

### Deliverables
| # | File | Lines | Coverage | Status |
|---|------|-------|----------|--------|
| 1 | `workers/beehive/tests/beehive.test.ts` | ~500 | 80% | ✅ NEW |
| 2 | `workers/queue-consumer/tests/queue.test.ts` | ~300 | 75% | ✅ NEW |
| 3 | `tests/integration/bindings.test.ts` | ~200 | N/A | ✅ NEW |
| 4 | `docs/PHASE-2-PLAN.md` | ~100 | N/A | ✅ NEW |
| 5 | `docs/PHASE-2-REVIEW.md` | ~150 | N/A | ✅ NEW |
| 6 | `docs/PHASE-2-MERGE-REPORT.md` | ~100 | N/A | ✅ NEW |

### Test Cases for beehive (main)
```typescript
// API Handlers (12 tests)
- POST /api/specs
- GET /api/specs
- GET /api/specs/:id
- POST /api/specs/:id/claim
- POST /api/candidates
- GET /api/candidates/:id/gate-verdicts

// Spec DO (10 tests)
- Spec CRUD operations
- Candidate management
- Gate verdict storage
- Promotion state tracking
- Transaction handling

// Shared (6 tests)
- Auth middleware
- Error handling
- Schema validation
```

### Test Cases for queue-consumer
```typescript
// Message Processing (10 tests)
- Artifacts push event parsing
- Event type routing
- Gate workflow triggering
- Preview deployment triggering
- Error handling
- Message batching

// Bindings (6 tests)
- beehive-artifacts-push queue consumer
- SPEC_DO service binding
- PREVIEW_MANAGER service binding
- GATE_WORKFLOW service binding
```

### Success Criteria
- [ ] All test files pass
- [ ] Core workers have 70-80% coverage
- [ ] Integration tests validate bindings
- [ ] All commits pushed to main

---

## Phase 3: Remaining Workers (Week 4)

**Agent:** `test-phase-3-remaining`  
**Timeline:** Week 4 (5 days)  
**Effort:** 16 hours  
**Priority:** HIGH

### Scope
- Create unit tests for `beehive-shadow-router`
- Create unit tests for `beehive-scientist-comparator`
- Create unit tests for `beehive-preview-manager`
- Create unit tests for `beehive-candidate-service`

### Deliverables
| # | File | Lines | Coverage | Status |
|---|------|-------|----------|--------|
| 1 | `workers/shadow-router/tests/shadow.test.ts` | ~250 | 75% | ✅ NEW |
| 2 | `workers/scientist-comparator/tests/scientist.test.ts` | ~200 | 70% | ✅ NEW |
| 3 | `workers/preview-manager/tests/preview.test.ts` | ~200 | 70% | ✅ NEW |
| 4 | `workers/candidate-service/tests/candidate.test.ts` | ~150 | 70% | ✅ NEW |
| 5 | `docs/PHASE-3-PLAN.md` | ~80 | N/A | ✅ NEW |
| 6 | `docs/PHASE-3-REVIEW.md` | ~120 | N/A | ✅ NEW |
| 7 | `docs/PHASE-3-MERGE-REPORT.md` | ~80 | N/A | ✅ NEW |

### Test Cases for shadow-router
```typescript
// Routing Logic (8 tests)
- Traffic splitting calculation
- Statsig feature flag evaluation
- Routing decision algorithms
- Weighted distribution
- Header passthrough
- URL rewriting

// Bindings (4 tests)
- SPEC_DO service binding
- Analytics Engine binding
```

### Test Cases for scientist-comparator
```typescript
// Comparison Logic (6 tests)
- Response comparison algorithm
- Delta surface calculation
- Result aggregation
- Statistical analysis
- Anomaly detection

// Bindings (2 tests)
- SPEC_DO service binding
- Analytics Engine binding
```

### Test Cases for preview-manager
```typescript
// Deployment (6 tests)
- Preview environment creation
- Worker deployment
- Environment cleanup
- State management
- Error recovery

// Bindings (2 tests)
- Service bindings
- Queue bindings
```

### Test Cases for candidate-service
```typescript
// Management (6 tests)
- CRUD operations
- Spec linkage
- Repository association
- Metadata management
- State transitions
```

### Success Criteria
- [ ] All 4 workers have test coverage
- [ ] All test files pass
- [ ] 100% worker unit test coverage achieved
- [ ] All commits pushed to main

---

## Phase 4: Integration & E2E (Weeks 5-6)

**Agent:** `test-phase-4-integration`  
**Timeline:** Weeks 5-6 (10 days)  
**Effort:** 26 hours  
**Priority:** MEDIUM

### Scope
- Integration tests for all Cloudflare bindings
- E2E tests for oracle ladder
- E2E tests for M3 features (canary, promotion)
- Enhanced synthetic monitoring

### Deliverables
| # | File | Lines | Coverage | Status |
|---|------|-------|----------|--------|
| 1 | `tests/integration/bindings.test.ts` | ~400 | N/A | ✅ NEW |
| 2 | `tests/e2e/oracle-ladder.test.ts` | ~300 | N/A | ✅ NEW |
| 3 | `tests/e2e/m3-features.test.ts` | ~300 | N/A | ✅ NEW |
| 4 | `scripts/synthetic-monitoring-enhanced.sh` | ~500 | N/A | ✅ MODIFIED |
| 5 | `docs/PHASE-4-PLAN.md` | ~120 | N/A | ✅ NEW |
| 6 | `docs/PHASE-4-REVIEW.md` | ~180 | N/A | ✅ NEW |
| 7 | `docs/PHASE-4-MERGE-REPORT.md` | ~120 | N/A | ✅ NEW |

### Integration Tests
```typescript
// Service Bindings (10 tests)
- SPEC_DO binding verification
- PREVIEW_MANAGER binding
- GATE_WORKFLOW binding
- SHADOW_ROUTER binding
- QUEUE bindings (all queues)
- Analytics Engine binding
- Authentication token passing

// Cross-Worker (8 tests)
- Worker-to-worker communication
- Queue message flow
- DO state consistency
- Transaction isolation
```

### E2E Tests for Oracle Ladder
```typescript
// Full Workflow (5 tests)
- Pre-merge gate flow
- Shadow traffic routing
- Train promotion
- Canary deployment with rollback
- Full production promotion
```

### E2E Tests for M3 Features
```typescript
// Canary (5 tests)
- Canary deployment
- SLO monitoring during canary
- Auto-rollback on SLO violation
- Successful promotion after canary
- Emergency rollback

// Promotion (5 tests)
- Tournament flow
- Merge-train flow
- Multi-candidate handling
- Winner selection
- Train completion
```

### Synthetic Monitoring Enhancements
```bash
# New Checks
- Worker health endpoints (all 10 workers)
- Queue depth monitoring (all queues)
- DO persistence verification
- SLO compliance tracking
- Geographic latency checks
- Dependency connectivity

# Infrastructure
- Alerting (email/Slack)
- Escalation (PagerDuty)
- Dashboard (Analytics Engine)
- State tracking (JSON file)
- Frequency: Every 60 seconds
```

### Success Criteria
- [ ] All integration tests pass
- [ ] All E2E tests pass
- [ ] Synthetic monitoring enhanced
- [ ] Test infrastructure improved
- [ ] All commits pushed to main

---

## Agent Coordination

### Agent Spawn Order
```
Phase 1 → Phase 2 → Phase 3 → Phase 4
```

Each agent **waits for the previous phase to complete** before starting.

### Agent Communication
- Agents work independently within their phase
- Each phase produces artifacts (test files, docs) that next phase depends on
- No cross-agent communication needed (sequential design)

### Error Handling
- If an agent fails, it creates a `docs/PHASE-X-FAILURE-REPORT.md`
- Next phase agent checks for failure report before proceeding
- Manual intervention required if failure occurs

### Resource Management
- Each agent runs in isolated workspace
- Shared resources: repository, Cloudflare account
- No resource contention (sequential execution)

---

## Workflow Automation

### Option A: Manual Agent Spawning
```bash
# Phase 1

# Wait for Phase 1 completion, then Phase 2

# Continue for Phases 3 and 4
```

### Option B: Automated Sequencing
Create a master agent that:
1. Spawns Phase 1 agent
2. Waits for Phase 1 completion
3. Validates Phase 1 deliverables
4. Spawns Phase 2 agent
5. Repeats for Phases 3 and 4

### Option C: GitHub Actions Workflow
```yaml
name: Test Implementation

on:
  workflow_dispatch:
    inputs:
      phase:
        description: 'Phase to execute'
        required: true
        default: '1'

jobs:
  phase-1:
    if: inputs.phase == '1' || inputs.phase == 'all'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
  
  phase-2:
    needs: phase-1
    if: inputs.phase == '2' || inputs.phase == 'all'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
  
  # Continue for phases 3 and 4
```

---

## Monitoring & Tracking

### Progress Dashboard
| Phase | Agent | Status | Start | End | Notes |
|-------|-------|--------|-------|-----|-------|
| 1 | test-phase-1-critical | ⏳ Pending | TBD | TBD | |
| 2 | test-phase-2-core | ⏳ Waiting | TBD | TBD | |
| 3 | test-phase-3-remaining | ⏳ Waiting | TBD | TBD | |
| 4 | test-phase-4-integration | ⏳ Waiting | TBD | TBD | |

### Success Metrics Tracking
| Metric | Current | After P1 | After P2 | After P3 | After P4 |
|--------|---------|----------|----------|----------|----------|
| Workers with tests | 2/10 | 4/10 | 6/10 | 8/10 | 10/10 |
| Unit test coverage | ~5% | ~30% | ~50% | ~70% | ~80% |
| Integration coverage | ~20% | ~25% | ~30% | ~45% | ~60% |
| E2E coverage | ~40% | ~40% | ~40% | ~60% | ~60% |
| Synthetic monitoring | ~5% | ~5% | ~5% | ~15% | ~30% |
| **Total coverage** | **~15%** | **~30%** | **~45%** | **~60%** | **~75%** |

---

## Agent Prompts

Each phase agent will be spawned with a prompt that includes:

### Phase 1 Prompt Structure
```
# Phase 1: Critical Fixes - Test Implementation Agent

## MISSION
Create unit tests for M3 workers (canary-worker, promotion-worker) and 
complete existing incomplete tests (gate.test.ts, sandbox.test.ts).

## WORKFLOW
1. DOCUMENT: Create docs/PHASE-1-PLAN.md
2. CREATE: Implement all test files
3. REVIEW: Run tests, validate, create docs/PHASE-1-REVIEW.md
4. MERGE: Commit, push, create docs/PHASE-1-MERGE-REPORT.md

## SPECIFIC TASKS
[Detailed list from above]

## SUCCESS CRITERIA
- All 4 test files pass
- Coverage > 70% for M3 workers
- All commits pushed to main
```

### Phase 2 Prompt Structure
```
# Phase 2: Core Workers - Test Implementation Agent

## MISSION
Create unit tests for core platform workers (beehive, queue-consumer) 
and integration tests for bindings.

## PREREQUISITES
- Phase 1 must be complete
- Check for docs/PHASE-1-MERGE-REPORT.md

## WORKFLOW
1. DOCUMENT: Create docs/PHASE-2-PLAN.md
2. CREATE: Implement all test files
3. REVIEW: Run tests, validate, create docs/PHASE-2-REVIEW.md
4. MERGE: Commit, push, create docs/PHASE-2-MERGE-REPORT.md
```

### Phase 3 Prompt Structure
```
# Phase 3: Remaining Workers - Test Implementation Agent

## MISSION
Create unit tests for remaining workers (shadow-router, scientist-comparator, 
preview-manager, candidate-service).

## PREREQUISITES
- Phase 2 must be complete
- Check for docs/PHASE-2-MERGE-REPORT.md

## WORKFLOW
1. DOCUMENT: Create docs/PHASE-3-PLAN.md
2. CREATE: Implement all test files
3. REVIEW: Run tests, validate, create docs/PHASE-3-REVIEW.md
4. MERGE: Commit, push, create docs/PHASE-3-MERGE-REPORT.md
```

### Phase 4 Prompt Structure
```
# Phase 4: Integration & E2E - Test Implementation Agent

## MISSION
Create integration tests for bindings, E2E tests for oracle ladder and M3 features,
and enhance synthetic monitoring.

## PREREQUISITES
- Phase 3 must be complete
- Check for docs/PHASE-3-MERGE-REPORT.md

## WORKFLOW
1. DOCUMENT: Create docs/PHASE-4-PLAN.md
2. CREATE: Implement all test files
3. REVIEW: Run tests, validate, create docs/PHASE-4-REVIEW.md
4. MERGE: Commit, push, create docs/PHASE-4-MERGE-REPORT.md
```

---

## Execution Strategy

### Recommended Approach: Sequential Agent Execution

**Week 1:**
```bash
# Start Phase 1
# Monitor completion
# Review docs/PHASE-1-MERGE-REPORT.md
```

**Week 2-3:**
```bash
# Start Phase 2 (after Phase 1 complete)
# Monitor completion
# Review docs/PHASE-2-MERGE-REPORT.md
```

**Week 4:**
```bash
# Start Phase 3 (after Phase 2 complete)
# Monitor completion
# Review docs/PHASE-3-MERGE-REPORT.md
```

**Week 5-6:**
```bash
# Start Phase 4 (after Phase 3 complete)
# Monitor completion
# Review docs/PHASE-4-MERGE-REPORT.md
```

### Agent Lifecycle

Each phase agent:
1. **Spawns** with full phase context
2. **Executes** all 4 steps sequentially
3. **Produces** documentation and test files
4. **Commits** changes to main (or feature branch)
5. **Terminates** after merge report is created

### Quality Gates

Each phase must pass these gates before next phase starts:
- ✅ All tests pass (`npm test`)
- ✅ TypeScript compiles (`npm run typecheck`)
- ✅ Lint passes (`npm run lint`)
- ✅ Merge report created and reviewed
- ✅ All files committed and pushed

---

## Risk Mitigation

### Risk 1: Phase 1 Delays
- **Impact:** All subsequent phases blocked
- **Mitigation:** Start with Phase 1 as highest priority
- **Contingency:** Split Phase 1 into sub-tasks if too large

### Risk 2: Test Flakiness
- **Impact:** CI/CD failures, blocked merges
- **Mitigation:** Add retry logic, investigate flaky tests
- **Contingency:** Mark flaky tests, fix in follow-up

### Risk 3: Dependency Issues
- **Impact:** Tests can't run without Cloudflare resources
- **Mitigation:** Use mocks for unit tests, real resources for integration
- **Contingency:** Skip integration tests if resources unavailable

### Risk 4: Coverage Disputes
- **Impact:** Debate over what constitutes "good enough" coverage
- **Mitigation:** Define clear success criteria upfront
- **Contingency:** Accept minimum viable coverage, improve later

---

## Success Definition

This plan is **successful** when:

1. **All 4 phases complete** within 6 weeks
2. **All 10 workers** have unit test coverage
3. **Integration and E2E** tests cover critical workflows
4. **Test infrastructure** is production-ready
5. **Coverage reaches** ~75% overall
6. **All tests pass** in CI/CD
7. **Documentation** is complete for each phase

---

## Next Steps

1. **Create agent prompts** for each phase (4 files)
2. **Spawn Phase 1 agent** to begin execution
3. **Monitor Phase 1 progress** and assist if needed
4. **Review Phase 1 deliverables** before starting Phase 2
5. **Repeat** for Phases 2, 3, and 4

---

*Plan created: 2026-10-13*  
*Owner: Test Implementation Team*  
*Confidence: 1.0*
