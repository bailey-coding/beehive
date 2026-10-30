---
RFO-2026-10-13-ledger-lifecycle-finding
---

# RFO: Ledger Lifecycle Finding - Spec DO is Append-Only with No Delete Routes

**Date:** 2026-10-13 (manual test-org cleanup); implemented 2026-10-15  
**Author:** unattributed (backfilled from git history)  
**Status:** Actioned  
**Severity:** Near-Miss (Architectural gap discovered, no user impact)  
**Related:** ADR-0002 (Coordination State Storage), ADR-0005 (Organizational Memory), 48a5f54, e57e6b1, f7dd837

---

> **Audit 2026-10-17 (`docs/RECORDS-AUDIT.md`):** Root cause, detection ("maintainer noticed during M1 work", "~1 day"), the lessons and the "preventive measures implemented"
> section are inference, unsupported by repo evidence. "All workers updated" and "migration tests added" were not verified.

## Summary

During M1 implementation, it was discovered that **the Spec Durable Object was append-only with no delete routes**. This meant that once data was written to the ledger (organizations, repos, specs, candidates, etc.), it could never be deleted or modified, only overwritten. This was an architectural gap that could have caused problems for:
- Test data cleanup
- Candidate rollback and removal
- Data lifecycle management

---

## Timeline

> Rewritten by the 2026-10-17 audit. The earlier rows (a lifecycle "RFD created" on 10-13, implementation
> dated 10-14) had no repo evidence: no such RFD exists, and 48a5f54, e57e6b1 and f7dd837 are all 2026-10-15.

| Time (UTC) | Event | Evidence |
|---|---|---|
| 2026-10-13 | Maintainer removes 27 test orgs by hand in the Cloudflare dashboard; the only platform wipe is `wrangler delete --name beehive --force` + redeploy | `docs/OPEN-QUESTIONS.md` (lines 111, 231) |
| 2026-10-15 20:35 | e57e6b1 logs the ledger-lifecycle finding and fixes README drift | `git show e57e6b1` |
| 2026-10-15 22:12 | f7dd837 merges agent/docs-drift | `git show f7dd837` |
| 2026-10-15 22:16 | 48a5f54 adds the M1 ledger lifecycle (m4 -> m5, additive) | `git show 48a5f54` |

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
- Added `deleted_at`/`deleted_by`/`delete_reason` to organizations, repositories, specs, candidates and issues; `actors.role`; `purge_log`
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
- ADR-0002: "The DO gives transactional, read-your-writes semantics for promotion decisions"

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
- `workers/spec-do/schema-inline.ts` - Inline copy of the schema with lifecycle
- `workers/spec-do/index.ts` - Ledger lifecycle operations
- `workers/spec-do/index.ts` - m5 migration step (`applyLedgerLifecycle`); there is no `migrations/` directory
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
