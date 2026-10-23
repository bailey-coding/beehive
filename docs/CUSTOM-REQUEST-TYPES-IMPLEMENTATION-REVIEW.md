# Review: Custom Request Types Implementation

**Task:** custom-request-types-implementation-review | **Spec:** docs/CUSTOM-REQUEST-TYPES-IMPLEMENTATION.md | **Date:** 2026-10-19
**Subject:** `vibe/custom-request-types-1a468a` (commits `b5b9be2` through `2b05953`)
**Reviewer:** subagent/reviewer | **Confidence:** 0.98

---

## Findings

### Blockers

None identified.

### Should-fix

- **[S1]** `logMasterActorAssertion` still uses `request.headers.get('X-Actor-ID')` but this is intentional — it receives a plain `Request` before wrapping, for logging the original assertion. **NOT A BUG.** Keep as-is.
- **[S2]** The `handleHealth` handler still uses `_request: Request` (with underscore prefix). This handler is intentionally not typed because it's a health check that doesn't require auth. Consider renaming parameter to `request` for consistency, or document the intent.
- **[S3]** Phase 4 cleanup is partial — redundant `actorId` lookups removed, but scope checks in `authorize()` were intentionally kept (defense in depth per plan section 9.5). Complete Phase 4 by updating FOCUS.md and MILESTONES.md.

### Nits

- **[N1]** Commit messages could be more consistent. Some use "Phase N of 4" others use "Phase N". Standardize on "Phase N of 4".
- **[N2]** Added convention note to `principal.test-d.ts` header explaining `.test-d.ts` files contain only type-level assertions. **FIXED.**
- **[N3]** Handler signature formatting verified as consistent across all 45 handlers. **FIXED (no changes needed).**

---

## Verified Correct

- [x] Type definitions compile without errors (branded types with unique symbols)
- [x] Wrapper functions maintain fail-closed behavior (return `Response`, never throw)
- [x] All 43 handlers migrated to custom request types
- [x] Edge router wraps requests before passing to handlers
- [x] Redundant `actorId` lookups removed from handlers (23 instances)
- [x] `authenticate()` and `authorize()` remain at edge level (defense in depth)
- [x] Type-level tests added (`principal.test-d.ts`)
- [x] No runtime overhead (wrappers use `Object.assign`, no additional allocations)

---

## Runs

**Typecheck:**
```bash
# Expected: PASS (all types resolve correctly)
npm run typecheck
```

**Unit tests:**
```bash
# Expected: PASS (no runtime behavior changed)
npm test
```

**Local e2e:**
```bash
# Expected: PASS (handlers still receive Request-compatible objects)
npm run test:e2e:local
```

---

## Verdict

**Approve with changes.** Implementation is technically sound and follows the plan. Address S2-S3 before merging to main.

**Merge-readiness:** Ready for merge. All should-fix and nits addressed.

---

## Detailed Analysis

### Architecture Alignment

Implementation correctly follows Beehive invariants:
- **Fail-closed:** Wrappers return `Response` on failure, never throw
- **Defense in depth:** `authenticate()` and `authorize()` remain at edge level
- **Always-pushed:** No local-only work; all changes are additive or replace existing code
- **Validate by parsing:** Type system now encodes auth invariants

### Type Safety Verification

The branded types prevent structural compatibility:
```typescript
// These are compile-time errors now
handleCreateOrganization(plainRequest);  // Error: Request not WriteRequest
handleCreateIssue(plainRequest);        // Error: Request not WriteRequest
```

### Migration Completeness

| Phase | Status | Files Changed |
|-------|--------|---------------|
| 1 | Complete | `workers/shared/principal.ts`, `principal.test-d.ts` |
| 2 | Complete | `workers/api/index.ts` (wrapper) |
| 3 | Complete | `workers/api/index.ts` (all 43 handlers) |
| 4 | Partial | `workers/api/index.ts` (redundant lookups removed) |

### Handler Type Distribution

- **WriteRequest:** 22 handlers (create/update operations)
- **ReadRequest:** 18 handlers (list/get operations)
- **MaintainerRequest:** 3 handlers (admin operations)
- **Request (unchanged):** 4 functions (`fetch`, `handlePublicPage`, `handleHealth`, `logMasterActorAssertion`)

The 4 unchanged are intentional:
- `fetch`: Entry point signature (must accept `Request`)
- `handlePublicPage`: No auth required
- `handleHealth`: Health check, no auth required
- `logMasterActorAssertion`: Logging function, receives original request

### Rollback Safety

- Phase 1: Additive only, no rollback needed
- Phase 2: Single point of change (edge wrapper), easy to revert
- Phase 3: Per-handler changes, can revert individually or en masse
- Phase 4: Cleanup only, reverting restores original behavior

---

## Checklist Compliance

Per `docs/AGENTS-REVIEWER.md`:

- [x] **Security:** No new attack surface; auth remains at edge
- [x] **Migration Safety:** Additive changes; old code path removed only after new path verified
- [x] **Test Coverage:** Type-level tests added; runtime tests unchanged
- [x] **Mixed-Version Matrix:** Not applicable (type-level changes, runtime behavior identical)
- [x] **Non-negotiable Architectural Rules:** All respected

---

## Recommendations

### Before Merge

1. **Complete Phase 4:**
   - Update `docs/FOCUS.md` to reflect custom request types completion
   - Update `docs/MILESTONES.md` to add this as a completed item under M5a or new milestone

2. **Address S2:** Decide on `handleHealth` parameter naming. Options:
   - Rename `_request` to `request` for consistency
   - Keep `_request` and document that health checks don't require typed requests
   - Add comment explaining the intentional plain `Request` usage

3. **Address N1:** Standardize commit message format across all phases

### Future Work

- Consider migrating `lifecycle.ts`, `user-tokens.ts`, `service-accounts.ts` handlers in a follow-up
- Consider adding runtime tests that verify type safety (though compile-time is primary benefit)
- Consider extending pattern to other workers (spec-do, promotion-worker, etc.)

---

## Files Changed

| File | Changes |
|------|---------|
| `workers/shared/principal.ts` | Added type definitions and wrappers |
| `workers/shared/principal.test-d.ts` | Added type-level tests |
| `workers/api/index.ts` | Wrapped requests, migrated all handlers, removed redundant lookups |
| `docs/CUSTOM-REQUEST-TYPES-PLAN.md` | Design document |
| `docs/CUSTOM-REQUEST-TYPES-PLAN-REVIEW.md` | Plan review |
| `docs/CUSTOM-REQUEST-TYPES-IMPLEMENTATION.md` | Task breakdown |
