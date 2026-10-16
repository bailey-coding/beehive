---
RFO-2026-10-13
---

# RFO: Ledger Lifecycle Finding - Spec DO is Append-Only with No Delete Routes

**Date:** 2026-10-13  
**Author:** Maintainer / Agent Team  
**Status:** Actioned  
**Severity:** Near-Miss (Architectural gap discovered, no user impact)  
**Related:** ADR-0002 (Coordination State Storage), ADR-0005 (Organizational Memory), 48a5f54, e57e6b1, f7dd837

---

## Summary

During M1 implementation, it was discovered that **the Spec Durable Object was append-only with no delete routes**. This meant that once data was written to the ledger (organizations, repos, specs, candidates, etc.), it could never be deleted or modified, only overwritten. This was an architectural gap that could have caused problems for:
- Test data cleanup
- Candidate rollback and removal
- Data lifecycle management

---

## Timeline

| Time (UTC) | Event | Actor | Notes |
|------------|-------|-------|-------|
| ~2026-10-12 | Spec DO initial implementation | Agent Team | Basic CRUD operations implemented |
| ~2026-10-13 | Finding: No delete routes exist | Maintainer | "The only wipe is wrangler delete beehive --force + redeploy" |
| 2026-10-13 | Finding documented in OPEN-QUESTIONS.md | Agent Team | Added as open question |
| 2026-10-13 | RFC for ledger lifecycle created | Agent Team | Proposed tombstones + maintainer purge |
| 2026-10-14 | Ledger lifecycle implemented (commit 48a5f54) | Agent Team | M1 ledger lifecycle: tombstones, maintainer role, batched purge |
| 2026-10-14 | Docs updated (commit e57e6b1) | Agent Team | README M3/M4 status drift fixed, finding logged |
| 2026-10-14 | Merge to main (commit f7dd837) | Maintainer | agent/docs-drift merged |

### Key Moments

- **Detected:** During M1 implementation review
- **Finding Documented:** Added to OPEN-QUESTIONS.md as a finding
- **Solution Proposed:** Tombstones + maintainer-only purge
- **Implemented:** Full ledger lifecycle added to Spec DO
- **Verified:** All tests passing, migration system in place

---

## Impact

### Affected Components

- `workers/spec-do` - Spec Durable Object (primary)
- All workers that write to Spec DO
- Test data cleanup processes
- Production data lifecycle

### User Impact

- **Affected Users:** None (discovered before affecting users)
- **Impact Type:** None (near-miss, caught during implementation)
- **Severity:** Near-Miss (architectural gap discovered, no production impact)

### Technical Impact

If not addressed:
- ⚠️ Test data would accumulate with no cleanup mechanism
- ⚠️ Candidates could not be properly rolled back (state would persist)
- ⚠️ Deleted organizations/repos/specs would leave orphaned data
- ⚠️ No way to correct erroneous data

---

## Root Cause Analysis

### Direct Cause

The initial Spec DO implementation focused on **create and read** operations but didn't implement **delete or soft-delete** functionality. The schema had no tombstone fields, no delete routes, and no purge mechanisms.

### Contributing Factors

1. **Append-only assumption** - Initial design assumed append-only was sufficient
2. **No lifecycle consideration** - Data lifecycle wasn't fully thought through
3. **Test data accumulation** - No plan for cleaning up test data during development
4. **Production implications** - Didn't consider how to handle production data corrections

### Root Cause

**Fundamental Issue:** Incomplete architectural design. The Spec DO was designed as an append-only ledger without considering the full data lifecycle, including:
- Soft deletion (tombstones)
- Data correction
- Test data cleanup
- Maintenance operations

This is a case where ADR-0002 (Coordination State Storage) correctly identified the Spec DO as authoritative, but the full implications of that decision weren't worked out.

---

## Detection

### Detection Method

**Code Review / Implementation Discovery** - Maintainer noticed during M1 work that there was no way to delete or clean up data from the Spec DO.

### Detection Delay

**~1 day** - Discovered shortly after initial Spec DO implementation during M1 work.

### Detection Improvements

To catch similar issues earlier:
- ✅ **Architecture review** - Full data lifecycle should be part of initial design
- ✅ **Schema review** - Database schemas should include lifecycle fields from day one
- ✅ **Test data planning** - Every feature should include test data cleanup strategy

---

## Response

### Initial Response

1. **Finding Logged** - Added to OPEN-QUESTIONS.md
2. **Solution Designed** - Proposed tombstone pattern with maintainer-only purge

### Mitigation

**Commit 48a5f54:** "step: add M1 ledger lifecycle (tombstones, maintainer role, batched purge; m4->m5 additive)"

Changes:
- Added tombstone fields to all ledger tables
- Added soft-delete operations (mark as tombstone, not delete)
- Added maintainer-only purge routes (for test data cleanup)
- Implemented batched purge for efficiency
- Added migration system (m4 -> m5)

### Resolution

- Full ledger lifecycle implemented
- Migration from m4 to m5 schema
- All workers updated to use new lifecycle operations
- Tests updated to verify lifecycle behavior

### Verification

- Unit tests passing
- Migration tests added
- Documentation updated
- M1 milestone marked as having ledger lifecycle

---

## Lessons Learned

### What Went Well

✅ **Early discovery** - Found during implementation, not in production
✅ **Rapid design** - Solution (tombstones + purge) was designed quickly
✅ **Complete implementation** - Full lifecycle implemented, not just minimal fix
✅ **Additive migration** - Migration designed to be additive (m4->m5)
✅ **Documented** - Finding and solution both documented

### What Could Be Improved

⚠️ **Upfront design** - Data lifecycle should have been part of initial Spec DO design
⚠️ **Schema completeness** - Schema should have included lifecycle fields from the start
⚠️ **Test planning** - Test data cleanup should have been considered earlier

### Design Decisions That Held Up

✅ **Tombstone pattern** - Soft deletion with tombstones is the right approach
✅ **Maintainer-only purge** - Restricting purge to maintainers prevents accidental data loss
✅ **Additive migrations** - Migration approach allows for gradual rollout
✅ **Batch operations** - Batched purge improves efficiency

---

## Follow-up

### Related Findings

This RFO is related to:
- OPEN-QUESTIONS.md entry: "Ledger lifecycle" finding
- ADR-0005: Organizational Memory (persisting near-miss artifacts)
- AGENTS.md working convention: "The DO gives transactional, read-your-writes semantics for promotion decisions"

### Pattern Recognition

This is an example of **incomplete architecture** where a foundational component (Spec DO) was implemented without considering all lifecycle requirements. Similar gaps could exist in:
- Other Durable Objects
- Worker-to-worker communication
- Data migration strategies
- Cleanup and maintenance operations

### Preventive Measures Implemented

Based on this RFO, the following preventive measures were implemented:

1. **Lifecycle in schema** - All new schemas include lifecycle fields from the start
2. **Migration system** - Formal migration system for schema changes
3. **Additive migrations** - All migrations are designed to be additive
4. **Documentation** - OPEN-QUESTIONS.md now captures architectural findings

---

## Evidence

### Commit References

- **Finding:** [e57e6b1](https://github.com/bailey-coding/beehive/commit/e57e6b1) - README drift fix, finding logged
- **Implementation:** [48a5f54](https://github.com/bailey-coding/beehive/commit/48a5f54) - Ledger lifecycle added
- **Merge:** [f7dd837](https://github.com/bailey-coding/beehive/commit/f7dd837) - agent/docs-drift merged

### Code References

- `workers/spec-do/schema.sql` - Schema with tombstone fields
- `workers/spec-do/schema-inline.ts` - Generated schema with lifecycle
- `workers/spec-do/index.ts` - Ledger lifecycle operations
- `workers/spec-do/migrations/` - Migration scripts (m4->m5)
- `docs/OPEN-QUESTIONS.md` - Original finding documentation

---

## References

- [ADR-0002: Coordination State Storage](../decisions/0002-coordination-state.md) - Spec DO as authoritative store
- [ADR-0005: Organizational Memory](../decisions/0005-org-memory.md) - Recording near-miss artifacts
- [OPEN-QUESTIONS.md](../OPEN-QUESTIONS.md) - Original finding and related questions
- [MILESTONES.md](../MILESTONES.md) - M1 ledger lifecycle implementation
- [OPS.md](../OPS.md) - Ledger cleanup documentation

---

*This RFO documents a near-miss architectural finding where the Spec DO was discovered to be append-only with no delete routes. The solution implemented tombstones, maintainer role, and batched purge operations, which are now a core part of the Spec DO lifecycle.*
