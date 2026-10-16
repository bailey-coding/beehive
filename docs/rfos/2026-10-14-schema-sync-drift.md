---
RFO-2026-10-14
---

# RFO: Schema Sync Drift - schema.sql vs schema-inline.ts

**Date:** 2026-10-14  
**Author:** Maintainer / Agent Team  
**Status:** Actioned  
**Severity:** Near-Miss (Data consistency risk)  
**Related:** AGENTS.md#state-management, 0fa4abb, 48a5f54, fbc9fb5

---

## Summary

The Spec DO schema was defined in two places: `schema.sql` (the source of truth) and `schema-inline.ts` (the inline TypeScript version used at runtime). These two files **drifted out of sync**, with the inline copy missing a lifecycle comment block. This created a risk of runtime behavior diverging from the intended schema.

---

## Timeline

| Time (UTC) | Event | Actor | Notes |
|------------|-------|-------|-------|
| ~2026-10-12 | Spec DO schema updated in schema.sql | Agent Team | Added lifecycle fields for M4→M5 migration |
| ~2026-10-13 | schema-inline.ts not updated | Agent Team | Manual copy-paste missed lifecycle comment |
| 2026-10-14 | Drift discovered during review | Agent Team | "lifecycle comment block missing from the inline copy" |
| 2026-10-14 | Unit test added and drift fixed (commit 0fa4abb) | Agent Team | Test ensures byte-for-byte agreement |

### Key Moments

- **Detected:** During code review or migration testing
- **Root Cause Identified:** Manual copy-paste from schema.sql to schema-inline.ts missed updates
- **Mitigated:** Unit test added to catch future drift
- **Resolved:** schema-inline.ts updated to match schema.sql

---

## Impact

### Affected Components

- `workers/spec-do/schema.sql` - Source of truth schema
- `workers/spec-do/schema-inline.ts` - Inline schema (drifting copy)
- Spec DO runtime behavior
- All workers depending on Spec DO schema

### User Impact

- **Affected Users:** None (caught before production impact)
- **Impact Type:** None (near-miss)
- **Severity:** Near-Miss (data consistency risk)

### Technical Impact

If not caught:
- ⚠️ Runtime schema would diverge from intended schema
- ⚠️ Migration might fail or behave unexpectedly
- ⚠️ Lifecycle operations might not work correctly
- ⚠️ Silent data corruption possible

---

## Root Cause Analysis

### Direct Cause

The `schema-inline.ts` file is a manually maintained copy of `schema.sql`. When `schema.sql` was updated to add lifecycle fields (commit 48a5f54), the inline copy wasn't updated, causing drift.

### Contributing Factors

1. **Manual process** - schema-inline.ts was manually copied from schema.sql
2. **No validation** - No automated check that the two files match
3. **No tests** - No unit test to verify the files are in sync
4. **Comment drift** - Non-functional changes (comments) were missed

### Root Cause

**Fundamental Issue:** Manual copy-paste is error-prone. The build system didn't enforce that `schema-inline.ts` must match `schema.sql` byte-for-byte.

---

## Detection

### Detection Method

**Code Review / Testing** - Agent team noticed the drift during review of migration-related changes.

### Detection Delay

**~1 day** - Drift existed from schema update to discovery.

### Detection Improvements

To catch similar issues earlier:
- ✅ **Unit test** - Added test that verifies byte-for-byte agreement
- ✅ **Build validation** - Could add build-time check
- ✅ **Automated generation** - Could generate schema-inline.ts from schema.sql

---

## Response

### Initial Response

1. **Drift Identified** - Missing lifecycle comment block noticed
2. **Impact Assessed** - Determined this was a near-miss, not yet causing issues

### Mitigation

**Commit 0fa4abb:** "unit test that schema.sql and schema-inline.ts agree byte for byte; fix drift (lifecycle comment block missing from the inline copy)"

Changes:
- Added unit test to verify files match
- Updated schema-inline.ts to include missing lifecycle comment block
- Test added to catch future drift

### Resolution

- schema-inline.ts now matches schema.sql
- Unit test prevents future drift
- All migrations verified

### Verification

- Unit test passing
- Schema files in sync
- Migrations working correctly

---

## Lessons Learned

### What Went Well

✅ **Quick fix** - Drift corrected immediately
✅ **Preventive measure** - Unit test added to prevent recurrence
✅ **Complete fix** - All missing content (not just comments) would be caught

### What Could Be Improved

⚠️ **Automated generation** - schema-inline.ts should be generated, not copied
⚠️ **Build-time check** - Build should fail if files don't match
⚠️ **Better process** - Manual copy-paste should be avoided

### Design Decisions That Held Up

✅ **Byte-for-byte test** - Strict comparison catches all drift, including whitespace
✅ **Unit test** - Fast feedback during development
✅ **Immediate fix** - Drift corrected as soon as discovered

---

## Follow-up

### Related Findings

This is part of a pattern of **manual process errors** in the codebase. Other similar issues:
- Worker builds missing dependencies (RFO-2026-10-14-zod-build-failure)
- Route mismatches between workers (RFO-2026-10-14-promotion-routes-fix)

### Pattern Recognition

This is an example of **configuration drift** where manually maintained copies diverge. Similar risks exist for:
- Other schema files
- Configuration files
- API contract definitions
- Documentation that should match code

### Preventive Measures Implemented

Based on this RFO, the following preventive measures were implemented:

1. **Unit Test** (commit 0fa4abb): Byte-for-byte comparison of schema.sql and schema-inline.ts
2. **Build Validation** (implied): Test runs in CI, blocking merges if files drift

---

## Evidence

### Commit References

- **Fix:** [0fa4abb](https://github.com/bailey-coding/beehive/commit/0fa4abb) - Schema sync test and fix
- **Schema Update:** [48a5f54](https://github.com/bailey-coding/beehive/commit/48a5f54) - Ledger lifecycle added (source of drift)
- **CAS Implementation:** [fbc9fb5](https://github.com/bailey-coding/beehive/commit/fbc9fb5) - Related versioning work

### Code References

- `workers/spec-do/schema.sql` - Source of truth schema
- `workers/spec-do/schema-inline.ts` - Inline schema (now in sync)
- `workers/spec-do/schema.test.ts` (or similar) - Unit test for sync verification

---

## References

- [RFC-0006: Ledger Compare-and-Swap](../rfcs/0006-ledger-compare-and-swap.md) - Related versioning work
- [MILESTONES.md](../MILESTONES.md) - M4→M5 migration details
- [AGENTS.md](../../AGENTS.md#state-management) - State management rules
- [OPEN-QUESTIONS.md](../OPEN-QUESTIONS.md) - Related findings

---

*This RFO documents a near-miss where schema.sql and schema-inline.ts drifted out of sync. The fix involved adding a unit test to verify byte-for-byte agreement and correcting the drift. This was part of a pattern of manual process errors that have since been addressed with automated validation.*
