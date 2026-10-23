# Custom Request Types Implementation Tasks

**Task:** custom-request-types-implementation | **Spec:** docs/CUSTOM-REQUEST-TYPES-PLAN.md | **Date:** 2026-10-19
**Branch:** `vibe/custom-request-types-1a468a` | **Status:** Ready for implementation
**Author:** subagent/implementer | **Reviewer:** subagent/reviewer (per AGENTS-REVIEWER.md)

---

## Task Breakdown by Phase

### Phase 1: Type Definitions (Non-breaking, additive only)
**Commit prefix:** `step: custom-req-types-phase1-`

- [ ] **T1.1** Add branded type definitions to `workers/shared/principal.ts`:
  - `AuthedRequestBrand`, `ActorRequestBrand`, `ReadRequestBrand`, `WriteRequestBrand`, `MaintainerRequestBrand` (unique symbols)
  - `AuthedRequest = Request & { [AuthedRequestBrand]: never }`
  - `ActorRequest = AuthedRequest & { actorId: string }`
  - `ReadRequest = ActorRequest & { scopes: Principal['scopes'] & ['read', ...Principal['scopes']] }`
  - `WriteRequest = ActorRequest & { scopes: Principal['scopes'] & ['write', ...Principal['scopes']] }`
  - `MaintainerRequest = ActorRequest & { scopes: Principal['scopes'] & ['maintainer', ...Principal['scopes']] }`
  - Export all types from `workers/shared/principal.ts`
  
- [ ] **T1.2** Add wrapper functions to `workers/shared/principal.ts`:
  - `withAuth(request: Request, principal: Principal): AuthedRequest`
  - `withActor(request: Request, principal: Principal): ActorRequest | Response` (returns 503 if no actorId)
  - `withReadScope(req: AuthedRequest): ReadRequest | Response`
  - `withWriteScope(req: AuthedRequest): WriteRequest | Response`
  - `withMaintainerScope(req: AuthedRequest): MaintainerRequest | Response`

- [ ] **T1.3** Add type tests file `workers/shared/principal.test-d.ts`:
  ```typescript
  // Verify type errors are caught at compile time
  import type { AuthedRequest, ActorRequest, WriteRequest } from './principal';
  
  declare const plainRequest: Request;
  declare const authed: AuthedRequest;
  
  // These should fail to type-check
  function handleWrite(req: WriteRequest): void {}
  handleWrite(plainRequest); // Error: Request is not WriteRequest
  handleWrite(authed);       // Error: AuthedRequest is not WriteRequest
  ```

**Verification:** `npm run typecheck` (Expected: PASS)

---

### Phase 2: Edge Router Wrapper (Single point of truth)
**Commit prefix:** `step: custom-req-types-phase2-`

- [ ] **T2.1** Update `workers/api/index.ts` imports:
  - Import `withAuth`, `withActor` from `../shared/principal`

- [ ] **T2.2** After `authenticate()` and `authorize()` pass (around line 100), wrap the request:
  ```typescript
  // After actor rewrite for non-master principals
  const authedRequest = withAuth(request, principal);
  const actorRequest = withActor(authedRequest, principal);
  ```

- [ ] **T2.3** Pass `actorRequest` to handler functions instead of `request`:
  - Update all handler calls: `handleCreateOrganization(actorRequest, specDoStub)` etc.
  - Handlers still receive objects that duck-type as `Request`, so no breaking changes

- [ ] **T2.4** Add integration test in `workers/api/tests/principal.test.ts`:
  - Verify `withAuth` and `withActor` produce correctly typed objects
  - Verify handlers receive wrapped requests

**Verification:** `npm run typecheck` + `npm test` (Expected: PASS)

---

### Phase 3: Incremental Handler Migration
**Commit prefix:** `step: custom-req-types-phase3-`
**Order:** Highest-risk handlers first (write handlers, then read, then admin)

#### Group A: Write Handlers (highest risk if auth bypassed)
- [ ] **T3.A.1** `handleCreateOrganization`: `Request → WriteRequest`
- [ ] **T3.A.2** `handleCreateRepository`: `Request → WriteRequest`
- [ ] **T3.A.3** `handleCreateActor`: `Request → WriteRequest`
- [ ] **T3.A.4** `handleUpdateActorTrust`: `Request → WriteRequest`
- [ ] **T3.A.5** `handleCreateSpec`: `Request → WriteRequest`
- [ ] **T3.A.6** `handleUpdateSpecStage`: `Request → WriteRequest`
- [ ] **T3.A.7** `handleClaimSpec`: `Request → WriteRequest`
- [ ] **T3.A.8** `handleCreateCandidate`: `Request → WriteRequest`
- [ ] **T3.A.9** `handleUpdateCandidateStage`: `Request → WriteRequest`
- [ ] **T3.A.10** `handleCreateGateVerdict`: `Request → WriteRequest`
- [ ] **T3.A.11** `handleCreateTrial`: `Request → WriteRequest`
- [ ] **T3.A.12** `handleDecideTrial`: `Request → WriteRequest`
- [ ] **T3.A.13** `handleCreatePromotion`: `Request → WriteRequest`
- [ ] **T3.A.14** `handleCreateIssue`: `Request → WriteRequest`
- [ ] **T3.A.15** `handleUpdateIssueStage`: `Request → WriteRequest`
- [ ] **T3.A.16** `handleUpdateIssueStatus`: `Request → WriteRequest`
- [ ] **T3.A.17** `handleUpdateIssueCommentPolicy`: `Request → MaintainerRequest`
- [ ] **T3.A.18** `handleCreateIssueComment`: `Request → WriteRequest`
- [ ] **T3.A.19** `handleCreateIssueSpecLink`: `Request → WriteRequest`
- [ ] **T3.A.20** `handleCreateIssueCandidateLink`: `Request → WriteRequest`

#### Group B: Read Handlers
- [ ] **T3.B.1** `handleGetOrganization`: `Request → ReadRequest`
- [ ] **T3.B.2** `handleListOrganizations`: `Request → ReadRequest`
- [ ] **T3.B.3** `handleGetRepository`: `Request → ReadRequest`
- [ ] **T3.B.4** `handleListRepositories`: `Request → ReadRequest`
- [ ] **T3.B.5** `handleGetSpec`: `Request → ReadRequest`
- [ ] **T3.B.6** `handleListSpecs`: `Request → ReadRequest`
- [ ] **T3.B.7** `handleGetCandidate`: `Request → ReadRequest`
- [ ] **T3.B.8** `handleListCandidates`: `Request → ReadRequest`
- [ ] **T3.B.9** `handleGetGateVerdict`: `Request → ReadRequest`
- [ ] **T3.B.10** `handleListGateVerdicts`: `Request → ReadRequest`
- [ ] **T3.B.11** `handleGetTrial`: `Request → ReadRequest`
- [ ] **T3.B.12** `handleListTrials`: `Request → ReadRequest`
- [ ] **T3.B.13** `handleGetPromotion`: `Request → ReadRequest`
- [ ] **T3.B.14** `handleListPromotions`: `Request → ReadRequest`
- [ ] **T3.B.15** `handleGetIssue`: `Request → ReadRequest`
- [ ] **T3.B.16** `handleListIssues`: `Request → ReadRequest`
- [ ] **T3.B.17** `handleGetIssueComment`: `Request → ReadRequest`
- [ ] **T3.B.18** `handleListIssueComments`: `Request → ReadRequest`
- [ ] **T3.B.19** `handleGetIssueSpecLink`: `Request → ReadRequest`
- [ ] **T3.B.20** `handleListIssueSpecLinks`: `Request → ReadRequest`
- [ ] **T3.B.21** `handleGetIssueCandidateLink`: `Request → ReadRequest`
- [ ] **T3.B.22** `handleListIssueCandidateLinks`: `Request → ReadRequest`

#### Group C: Admin/Lifecycle Handlers
- [ ] **T3.C.1** `handleServiceAccountRoutes`: `Request → MaintainerRequest` (for admin sub-routes)
- [ ] **T3.C.2** `handleUserTokenRoutes`: `Request → MaintainerRequest` (for admin sub-routes)
- [ ] **T3.C.3** `handleLifecycleRoutes`: Use appropriate types based on route
- [ ] **T3.C.4** `handleHealth`: `Request → ReadRequest`
- [ ] **T3.C.5** `handleWhoami`: `Request → ReadRequest`

**Verification per handler:** `npm run typecheck` (Expected: FAIL if handler signature doesn't match required type)

---

### Phase 4: Cleanup and Runtime Redundancy Removal
**Commit prefix:** `step: custom-req-types-phase4-`

- [ ] **T4.1** Remove redundant runtime actor checks from handlers (actor is now type-guaranteed)
- [ ] **T4.2** Remove redundant scope checks from handlers (scopes are now type-guaranteed)
- [ ] **T4.3** Keep `authenticate()` and `authorize()` at edge level (defense in depth)
- [ ] **T4.4** Update `docs/FOCUS.md` to reflect completion
- [ ] **T4.5** Update `docs/MILESTONES.md` to reflect M5a extension or new milestone

**Verification:** Full test suite: `npm run typecheck` + `npm test` + `npm run test:e2e:local` (Expected: PASS)

---

## Commit Order

1. Phase 1: Type definitions (T1.1-T1.3)
2. Phase 2: Edge wrapper (T2.1-T2.4)
3. Phase 3: Handler migration (T3.A.1-T3.A.20, then T3.B.1-T3.B.22, then T3.C.1-T3.C.5)
4. Phase 4: Cleanup (T4.1-T4.5)

Each phase gets its own commit. Phase 3 can be split into multiple commits (e.g., one per handler group).

---

## File-by-File Changes

| File | Phase | Changes |
|------|-------|---------|
| `workers/shared/principal.ts` | 1 | Add types, add wrappers |
| `workers/shared/principal.test-d.ts` | 1 | Add type tests |
| `workers/api/index.ts` | 2 | Import wrappers, wrap request, pass to handlers |
| `workers/api/principal.ts` | 2 | Export types if needed |
| `workers/api/index.ts` handlers | 3 | Update signatures to use custom types |
| `workers/api/lifecycle.ts` | 3 | Update signatures |
| `workers/api/user-tokens.ts` | 3 | Update signatures |
| `workers/api/service-accounts.ts` | 3 | Update signatures |
| `docs/FOCUS.md` | 4 | Update with completion status |
| `docs/MILESTONES.md` | 4 | Update milestone status |

---

## Rollback

- Phase 1: No rollback needed (additive only)
- Phase 2: Revert commit to restore original `request` passing
- Phase 3: Revert individual handler commits or full phase
- Phase 4: Revert cleanup commit
- Full: `git checkout origin/main`

---

## Acceptance Criteria Checklist

- [ ] Type definitions compile without errors
- [ ] Wrapper functions pass unit tests
- [ ] `npm run typecheck` passes on main branch
- [ ] All existing tests pass
- [ ] At least 50% of handlers migrated to custom request types
- [ ] No runtime overhead (verified by comparing before/after performance)
- [ ] Type-level auth bypass is a compile-time error (verified with test-d.ts)

---

## Related Documents

- `docs/CUSTOM-REQUEST-TYPES-PLAN.md` — Design and decisions
- `docs/CUSTOM-REQUEST-TYPES-PLAN-REVIEW.md` — Review of the plan
- `docs/AGENTS-REVIEWER.md` — Review guidelines
- `docs/AGENTS.md` — Working conventions ("validate by parsing")
- `workers/shared/principal.ts` — Current Principal types
- `workers/api/principal.ts` — Current authentication logic
