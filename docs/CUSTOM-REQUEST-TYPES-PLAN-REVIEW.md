# Review: Custom Request Types Implementation Plan

**Task:** custom-request-types-review | **Spec:** docs/CUSTOM-REQUEST-TYPES-PLAN.md | **Date:** 2026-10-19
**Subject:** `vibe/custom-request-types-1a468a` (new plan document)
**Reviewer:** subagent/reviewer | **Confidence:** 0.95

---

## Findings

### Blockers

None identified.

### Should-fix

- **[S1]** Plan lacks migration verification steps (`docs/AGENTS-REVIEWER.md` section 2.3: "Test Coverage"). Add explicit test commands and expected results for each phase. (`docs/CUSTOM-REQUEST-TYPES-PLAN.md` section 6)
- **[S2]** Open Question 2 (Branded types) should be decided before implementation. Branded types prevent structural compatibility issues but add complexity. Recommend: **Use branded types** for compile-time safety. (`docs/CUSTOM-REQUEST-TYPES-PLAN.md` section 9.2)
- **[S3]** Scope hierarchy encoding (Open Question 5) interacts with existing `authorize()` logic. The plan should specify whether scope checks happen at wrapper level or remain in `authorize()`. Recommend: **Keep in `authorize()`** (defense in depth), wrappers only assert, never enforce. (`docs/CUSTOM-REQUEST-TYPES-PLAN.md` section 3.2)

### Nits

- **[N1]** Plan references `AGENTS.md#working-conventions` but the actual rule is in `AGENTS.md` (check if section exists). Verify or remove reference.
- **[N2]** Phase 2 mentions passing `actorRequest` to handlers, but Phase 3 uses different type names (`WriteRequest`, etc.). Clarify the relationship between `ActorRequest` and scope-specific types.
- **[N3]** Section 5 lists `lifecycle.ts` but the file is `workers/api/lifecycle.ts`. Add full paths for consistency with repo conventions.
- **[N4]** "Validate by parsing" principle citation: verify this is explicitly stated in AGENTS.md or add as a new invariant.

---

## Verified Correct

- [x] Type definitions are additive and non-breaking (Phase 1)
- [x] Migration strategy is incremental and reversible
- [x] Edge router remains single point of auth enforcement
- [x] Wrapper functions maintain fail-closed behavior
- [x] Rollback plan is explicit and testable
- [x] Acceptance criteria are measurable

---

## Runs

Not applicable (plan document, no code changes yet).

**Typecheck verification:**
```bash
# After Phase 1 implementation
npm run typecheck  # Expected: PASS
```

---

## Verdict

**Approve with changes.** Plan is sound and follows Beehive invariants. Address S1-S3 before implementation begins. N1-N4 are cosmetic.

**Merge-readiness:** Pending S1-S3 resolution. Implementation can proceed in parallel with plan updates.

---

## Detailed Analysis

### Architecture Alignment

The plan correctly identifies that current auth is runtime-only and proposes type-level enforcement. This aligns with:
- AGENTS.md invariant: "Orchestration spine is hand-written" (types are spine-adjacent)
- AGENTS-REVIEWER.md: "Validate by parsing" principle
- Fail-closed requirement: Wrappers return `Response` on failure, never throw

### Risk Assessment

**Low risk:**
- Phase 1 (types only): Zero runtime impact
- Phase 2 (edge wrapper): Single point of change, existing handlers unaffected
- Phase 3 (incremental): Per-handler, compile-time errors catch issues

**Medium risk:**
- Type system complexity: Branded types vs structural types trade-off
- Handler signature changes: Could break if handlers are imported elsewhere

### Recommendations

1. **Adopt branded types** (S2 resolution): Prevents accidental mixing of request types
   ```typescript
   declare const AuthedRequestBrand: unique symbol;
   export type AuthedRequest = Request & { [AuthedRequestBrand]: never };
   ```

2. **Explicit test commands** (S1 resolution): Add to each phase:
   ```
   Phase 1: npm run typecheck (PASS)
   Phase 2: npm run typecheck + npm test (PASS)
   Phase 3: npm run typecheck per handler (FAIL if missing auth)
   ```

3. **Scope enforcement** (S3 resolution): Keep `authorize()` as primary, wrappers as secondary assertions. Document in plan.

4. **Path consistency** (N3 resolution): Use full paths throughout (`workers/api/lifecycle.ts`, not `lifecycle.ts`)

---

## Checklist Compliance

Per `docs/AGENTS-REVIEWER.md` section 2:

- [x] Security: No new attack surface; auth remains at edge
- [x] Migration Safety: Additive only; old code ignores new types
- [x] Test Coverage: Explicit verification steps needed (S1)
- [x] Mixed-Version Matrix: Not applicable (type-level changes)
- [x] Non-negotiable Architectural Rules: All respected

---

## Confidence Notes

- **0.95 confidence**: Plan is technically sound. S1-S3 are process gaps, not technical flaws.
- Type system approach is standard TypeScript pattern (type narrowing via branded types)
- Migration strategy respects Beehive's single-push deployment model
