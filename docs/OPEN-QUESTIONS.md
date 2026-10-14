---
category: findings
status: active
audience: human,agent
tags:
  - spike-results
  - lessons-learned
---


*Recorded for future reference and team onboarding.*

---

## Hierarchical Repository URLs - Duplicate Name Issue

**Status**: Open - Requires Schema Decision

**Date**: 2026-10-14

**Issue**: The hierarchical URL feature (`/app/repos/{org}/{namespace}/{repo}`) has a silent failure mode when multiple repositories share the same `(organization.name, namespace, name)` tuple.

**Current Behavior**: 
- `.find()` returns the first matching repository
- Second+ repos with the same path become unreachable via hierarchical URL
- Their links open the wrong repository

**Impact**: Data integrity issue - users cannot reliably access repositories with duplicate names via the friendly URL format.

**Root Cause**: No uniqueness constraint in the Spec DO schema for:
- `organizations.name`
- `(organization_id, namespace, name)` in `repositories`

**Constraints**: 
- AGENTS.md rule: "Spec DO is the orchestration spine - hand-written, not agent-generated"
- Schema changes to Spec DO must be hand-written and carefully reviewed

**Recommended Solutions** (in priority order):

1. **Add UNIQUE indexes** (Preferred but requires schema change):
   ```sql
   CREATE UNIQUE INDEX idx_organizations_name ON organizations(name);
   CREATE UNIQUE INDEX idx_repositories_path ON repositories(organization_id, namespace, name);
   ```
   - Prevents duplicates at database level
   - Requires hand-written migration

2. **Application-level validation** (Quick fix):
   - Validate uniqueness before creating orgs/repos
   - Return error if duplicate detected
   - No schema change required

3. **Fallback with warning** (Temporary):
   - If duplicate detected during lookup, log warning
   - Fall back to UUID URL for duplicates
   - User still gets to their repo, but via less-friendly URL

**Decision Needed**: Should we enforce uniqueness at the schema level (breaking change for existing duplicates) or at the application level (prevents new duplicates only)?

**Related**: Hierarchical URL implementation in commit `8df4792`

---

## Pre-existing Test Gaps

**Status**: Open

**Date**: 2026-10-14

**Issue**: Test files in `workers/api/tests/ui.test.ts` are not included in the Vitest configuration (`vitest.config.ts` only includes `tests/**/*.test.ts`).

**Impact**: 
- 15+ pre-existing test failures in `workers/api/tests/` go unnoticed
- New failures from hierarchical URL changes (2 tests) also not caught by CI
- No CI coverage for UI route handlers

**Current State**:
- Unit tests in `tests/unit/` pass
- E2E tests in `tests/e2e/` run but many fail (require running workers)
- UI tests in `workers/api/tests/ui.test.ts` are never executed

**Recommended Fix**:
1. Update `vitest.config.ts` to include `workers/api/tests/**/*.test.ts`
2. Investigate and fix the 15 pre-existing failures
3. Add tests for hierarchical URL routes

**Blocker for**: Full test confidence in UI routing changes
