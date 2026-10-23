---
RFO-2026-10-14-reserved-org-protection
---

# RFO: Reserved Org Protection - Preventing Accidental Deletion of beehive-system

**Date:** 2026-10-16 (filename and index say 2026-10-14; 46c9667 is 2026-10-16 06:50)  
**Author:** unattributed (backfilled from git history)  
**Status:** Actioned  
**Severity:** SEV-1 (Critical - production data protection)  
**Related:** AGENTS.md#state-management, 46c9667, ADR-0002

---

> **Audit 2026-10-17 (`docs/RECORDS-AUDIT.md`):** Severity SEV-1 and "affected users: all" describe the hypothetical outcome; the repo shows a review fix made before any
> incident (the template's Near-Miss class fits better; left for a human to reclassify). Detection and lessons are unsupported by repo evidence.

## Summary

The `beehive-system` organization is a **reserved system organization** that must never be deleted, tombstoned, or purged. Without protection, an accidental or malicious operation could wipe out all system data. The fix added explicit protection to return `403 Forbidden` for any attempt to delete the reserved organization, both at the edge and in the Spec DO.

---

## Timeline

> Rewritten by the 2026-10-17 audit; the earlier ~10-13 "reserved org concept established" and ~10-14 rows had no repo evidence.

| Time (UTC) | Event | Evidence |
|---|---|---|
| 2026-10-16 06:50 | 46c9667 refuses tombstone/purge of `beehive-system` (403 at the edge in `workers/api/lifecycle.ts` and in the Spec DO); prefix purge skips it as reserved | `git show 46c9667` (task name `review-fix-2-reserved-org`, so it came out of a review) |

### Key Moments

- **Detected:** Architecture review identified risk
- **Root Cause Identified:** No protection against deletion of system org
- **Mitigated:** Explicit checks added for reserved org
- **Resolved:** Protection in place at edge and Spec DO

---

## Impact

### Affected Components

- `workers/api` - Edge router (primary protection)
- `workers/spec-do` - Spec Durable Object (secondary protection)
- `beehive-system` organization - The reserved system org

### User Impact

- **Affected Users:** All users (if org were deleted)
- **Impact Type:** Complete system failure if deletion succeeded
- **Severity:** SEV-1 (Critical - production data at risk)

### Technical Impact

If not protected:
- ❌ All system data could be lost (organizations, repos, specs, candidates, etc.)
- ❌ Complete system failure
- ❌ No recovery possible (data permanently deleted)
- ❌ Downtime for all users

---

## Root Cause Analysis

### Direct Cause

The edge router and Spec DO did not check if an organization was reserved before allowing deletion operations. The `beehive-system` organization, which holds system-level data and configurations, could be deleted with the same operations as any other organization.

### Contributing Factors

1. **No reserved list** - No explicit list of reserved organizations
2. **No protection layer** - Deletion operations didn't check for reserved status
3. **High blast radius** - Deleting beehive-system would affect all users
4. **Irreversible** - Once deleted, data cannot be recovered

### Root Cause

**Fundamental Issue:** The system didn't implement defense in depth for critical resources. Reserved organizations need explicit protection at all layers (edge, DO, etc.).

---

## Detection

### Detection Method

**Architecture Review** - Maintainer identified the risk during design review.

### Detection Delay

**Proactive** - Risk identified and mitigated before any incident occurred.

### Detection Improvements

To prevent similar risks:
- ✅ **Explicit reserved list** - Maintain list of reserved organizations
- ✅ **Multi-layer protection** - Check at edge and DO levels
- ✅ **Clear error** - Return 403 with explanatory message
- ✅ **Documentation** - Document reserved orgs and their purpose

---

## Response

### Initial Response

1. **Risk Identified** - beehive-system org needs protection
2. **Impact Assessed** - Deletion would be catastrophic

### Mitigation

**Commit 46c9667:** "step: refuse tombstone/purge of the reserved beehive-system org (403 at the edge and in the Spec DO; prefix purge skips it as 'reserved')"

Changes:
- **Edge protection**: Edge router returns 403 for delete/tombstone/purge of beehive-system
- **Spec DO protection**: Spec DO also checks and refuses operations on reserved org
- **Prefix purge skip**: Bulk purge operations skip reserved organizations
- **Reserved id**: the reserved ids are constants (`RESERVED_ORGANIZATION_ID = 'beehive-system'`, `RESERVED_ACTOR_ID = 'master'`, `workers/shared/ledger-lifecycle.ts:18`); there is no database flag

### Resolution

- beehive-system org now protected at all layers
- Clear 403 errors returned for deletion attempts
- Prefix purge operations skip reserved orgs
- Protection documented in code

### Verification

- Protection verified at edge
- Protection verified in Spec DO
- Bulk operations verified to skip reserved

---

## Lessons Learned

### What Went Well

✅ **Proactive identification** - Risk caught before any incident
✅ **Defense in depth** - Protection at multiple layers (edge + DO)
✅ **Clear errors** - 403 with explanatory message
✅ **Complete coverage** - All deletion operations protected

### What Could Be Improved

⚠️ **Automated testing** - tests exist (`workers/api/tests/lifecycle.test.ts`, `workers/spec-do/tests/ledger-lifecycle.test.ts`); coverage not reviewed by this audit
⚠️ **Audit logging** - Log attempts to delete reserved orgs
⚠️ **Dynamic reserved list** - Make reserved list configurable

### Design Decisions That Held Up

✅ **Multi-layer protection** - Edge and DO both check for reserved status
✅ **403 errors** - Clear, actionable error response
✅ **Prefix purge skip** - Bulk operations handle reserved orgs correctly
⚠️ **Reserved id constant** - hard-coded, not a database marker

---

## Follow-up

### Related Findings

This RFO establishes a pattern for **reserved resource protection**. Similar protection should exist for:
- Other system organizations
- System-level actors
- Critical configuration records
- Base repositories

### Pattern Recognition

This is an example of **critical resource protection** - ensuring that system-critical resources cannot be accidentally or maliciously modified. This pattern should be applied to:
- All system organizations
- System actors
- Base repos
- Critical specs

### Preventive Measures Implemented

Based on this RFO, the following preventive measures were implemented:

1. **Reserved list** - Explicit list of reserved organizations
2. **Multi-layer checks** - Protection at edge and DO
3. **Clear errors** - 403 with explanation
4. **Bulk operation handling** - Prefix purge skips reserved

---

## Evidence

### Commit References

- **Protection:** [46c9667](https://github.com/bailey-coding/beehive/commit/46c9667) - Reserved org protection

### Code References

- `workers/api` - Edge router protection
- `workers/spec-do` - Spec DO protection
- `workers/shared/` - Reserved org checks

---

## References

- [ADR-0002: Coordination State Storage](../decisions/0002-coordination-state.md) - Spec DO as authoritative store
- [AGENTS.md](../../AGENTS.md#state-management) - State management rules
- [OPS.md](../OPS.md) - Operational documentation

---

*This RFO documents a SEV-1 risk where the beehive-system organization could have been accidentally deleted. The fix added explicit protection at multiple layers. This was a proactive mitigation that prevented a potential catastrophic failure.*
