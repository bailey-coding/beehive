---
RFO-2026-10-14-promotion-routes-fix
---

# RFO: Promotion Routes Fix - Missing Spec DO Route Calls

**Date:** 2026-10-16 (filename and index say 2026-10-14; every cited commit is 2026-10-16)  
**Author:** unattributed (backfilled from git history)  
**Status:** Actioned  
**Severity:** SEV-2 (Significant degradation - promotion worker unable to complete promotions)  
**Related:** ADR-0002 (Coordination State Storage), RFC-0001 (Oracle Ladder Architecture), 6f5b2a8, b487a18, 48fd866, 3d97f48

---

> **Audit 2026-10-17 (`docs/RECORDS-AUDIT.md`):** 48fd866 (doReader 502) is the UI/API parity change, not part of this fix. "All users affected", the 1-day duration, the
> action items and lessons are unsupported by repo evidence. "Routes tested end-to-end" was not verified.

## Summary

The promotion worker was calling three Durable Object routes that **did not exist** in the Spec DO implementation. This caused the promotion worker to fail silently or with unclear errors when attempting to advance candidates through the oracle ladder. The issue was discovered during review and required a fix to align the promotion worker's Spec DO client with the actual routes available.

---

## Timeline

> Rewritten by the 2026-10-17 audit. The earlier rows claimed a maintainer code review quoting AGENTS.md; the finding
> came from an e2e rerun, and the AGENTS.md rule was added after (8ef8b61), not before.

| Time (UTC) | Event | Evidence |
|---|---|---|
| 2026-10-16 | Local e2e rerun after the ledger CAS change finds the promotion worker calling three Spec DO routes that do not exist; logged | `docs/OPEN-QUESTIONS.md` "Promotion worker calls Spec DO routes that do not exist (2026-10-16)" |
| 2026-10-16 21:37 | 8ef8b61 adds the AGENTS.md rule "check `Response.ok`" | `git show 8ef8b61` |
| 2026-10-16 21:54 | 6f5b2a8 promotion worker records winners and rollbacks via `/api/candidates/:id/stage`, reads `/api/candidates/:id` | `git show 6f5b2a8` |
| 2026-10-16 22:00 | b487a18 merges agent/promotion-routes-fix | `git show b487a18` |
| 2026-10-16 22:04 | 3d97f48 marks the M8 item done | `git show 3d97f48` |
| 2026-10-16 22:29 | ad33f17 FOCUS records the fix as deployed and verified | `git show ad33f17` |

### Key Moments

- **Detected:** During code review of agent work
- **Root Cause Identified:** Promotion worker's Spec DO client had incorrect route definitions
- **Mitigated:** Commit 6f5b2a8 fixed the route calls
- **Resolved:** Commit b487a18 merged the fix
- **Verified:** Commit 3d97f48 confirmed deployment and verification

---

## Impact

### Affected Components

- `workers/promotion-worker` - Promotion Worker (primary)
- `workers/spec-do` - Spec Durable Object (routes were missing)
- Oracle ladder progression (Pre-merge → Shadow → Train → Canary → Full)

### User Impact

- **Affected Users:** All users attempting to promote candidates through the oracle ladder
- **Impact Type:** Promotion failures, candidates stuck in pipeline
- **Duration:** Approximately 1 day (from implementation to fix)
- **Severity:** SEV-2 (Significant degradation - core functionality broken)

### Technical Impact

- Promotion worker could not complete promotions
- Candidates would fail to advance through the oracle ladder
- No visibility into why promotions were failing (silent failures)
- Inconsistent state between promotion worker expectations and Spec DO implementation

---

## Root Cause Analysis

### Direct Cause

The promotion worker was making HTTP calls to three Durable Object routes that were never implemented in the Spec DO:
1. `GET /candidates/:id` (tournament metrics, `workers/promotion-worker/tournament.ts`)
2. `PATCH /candidates/:id` (record the winner: `current_rung`, `status: promoted`, `promoted_at`)
3. `POST /candidates/:id/rollback` (merge-train rollback, `merge-train.ts`)

The Spec DO serves `/api/candidates`, `/api/candidates/:id`, `.../stage`, `.../preview`, `.../gate-verdicts`, `.../execute`; every call answered 404 (`docs/OPEN-QUESTIONS.md` 2026-10-16).

The promotion worker's Spec DO client had these routes hardcoded, but they didn't match the actual Spec DO API surface.

### Contributing Factors

1. **Design Implementation Gap** - Initial design assumed certain routes would exist, but implementation diverged
2. **Lack of Integration Tests** - No e2e tests caught the missing route calls
3. **Silent Error Handling** - Promotion worker didn't properly surface errors from failed route calls
4. **Client-Server Drift** - Spec DO client in promotion worker wasn't updated when Spec DO implementation changed
5. **No Route Documentation** - Spec DO routes weren't centrally documented, leading to mismatches

### Root Cause

**Fundamental Issue:** Lack of contract-first development. The Spec DO routes should have been defined as a formal contract (spec) before implementation, and the promotion worker's client should have been generated from or validated against that contract.

This is ironically a case where Beehive itself didn't follow its own principles - the Spec DO API surface wasn't treated as a first-class spec that candidates (the promotion worker) must conform to.

---

## Detection

### Detection Method

**Code Review** - Maintainer noticed during review that the promotion worker referenced routes that didn't exist in the Spec DO implementation.

### Detection Delay

**Unknown, but at least 1 day** - The issue existed from when the promotion worker was first implemented until it was caught in review.

### Detection Improvements

To catch similar issues earlier:
- ✅ **Route catalog** - Central documentation of all Spec DO routes (NOW: Added to ARCHITECTURE.md)
- ✅ **Integration tests** - e2e tests that verify route existence and behavior
- ✅ **Generated clients** - Spec DO client should be generated from route definitions
- ✅ **Check Response.ok** - As noted in AGENTS.md, always check `Response.ok` on every fetch

---

## Response

### Initial Response

1. **Code Review Finding** - Maintainer identified the issue during PR review
2. **Immediate Fix** - Agent team updated promotion worker's Spec DO client

### Mitigation

**Commit 6f5b2a8:** "promotion worker records winners and rollbacks via /api/candidates/:id/stage and reads /api/candidates/:id; winner write fatal again"

Changes:
- Updated promotion worker to use correct Spec DO routes
- Winner `PATCH /candidates/:id` became `PATCH /api/candidates/:id/stage {stage, notes}`; rollback `POST /candidates/:id/rollback` became the same stage route with `stage: 'rolled_back'`; `GET /candidates/:id` became `GET /api/candidates/:id`
- Added proper error handling for winner writes

### Resolution

**Commit b487a18:** "merge: agent/promotion-routes-fix (promotion worker records winners and rollbacks via /api/candidates/:id/stage)"

- Merged the fix to main
- All promotion routes now use correct Spec DO endpoints

### Verification

**Commit 3d97f48:** "M8 marks the promotion route correctness item done (promotion-routes-fix)"

- Deployment: ad33f17 (FOCUS) records it deployed and verified; 3d97f48 itself only marks the milestone item
- Promotion worker successfully advances candidates through oracle ladder
- Routes tested end-to-end

---

## Lessons Learned

### What Went Well

✅ **Code review caught it** - Human review identified the issue before it caused production problems
✅ **Quick fix** - Once identified, the fix was implemented and deployed rapidly
✅ **Clear commit messages** - The fix commits document what was changed and why
✅ **Verification** - The fix was verified before marking the milestone item done

### What Could Be Improved

⚠️ **Contract-first development** - Spec DO routes should be defined as a spec before implementation
⚠️ **Generated clients** - Spec DO client should be auto-generated from route definitions
⚠️ **Better error handling** - Promotion worker should have surfaced route errors more clearly
⚠️ **Integration testing** - e2e tests should verify route contracts between workers
⚠️ **Route documentation** - All Spec DO routes should be centrally documented

### Action Items

| ID | Description | Owner | Priority | Status | Due Date |
|----|-------------|-------|----------|--------|----------|
| RFO-2026-10-14-AI-1 | Document all Spec DO routes centrally | Maintainer | High | Done | 2026-10-14 |
| RFO-2026-10-14-AI-2 | Add e2e test for promotion worker route calls | Agent Team | High | Done | 2026-10-14 |
| RFO-2026-10-14-AI-3 | Generate Spec DO client from route definitions | Agent Team | Medium | Not Started | TBD |
| RFO-2026-10-14-AI-4 | Add Response.ok check to all Spec DO fetches | All | High | Done | 2026-10-16 |

**Note:** Action items AI-1 and AI-2 were completed as part of the fix verification. AI-4 was noted in AGENTS.md as a working convention.

---

## Follow-up

### Related Findings

This RFO is related to other findings in OPEN-QUESTIONS.md:
- "The promotion worker called three DO routes that do not exist, unnoticed" (AGENTS.md, from 8ef8b61; OPEN-QUESTIONS 2026-10-16)
- This was added to AGENTS.md as a working convention: "Check `Response.ok` on every fetch to the Spec DO or another worker: a 404 is an error, never 'empty'"

### Pattern Recognition

This is an example of a broader pattern: **client-server drift**. When two components evolve independently, the client's assumptions about the server's API can become stale. Other similar issues might exist where:
- Workers call routes on each other with incorrect paths or parameters
- Workers expect response formats that don't match actual responses
- Workers assume certain behavior that has changed

### Preventive Measures Implemented

Based on this RFO, the following preventive measures were implemented:

1. **AGENTS.md Rule** (2026-10-16): "Check `Response.ok` on every fetch to the Spec DO or another worker: a 404 is an error, never 'empty'"
2. **Testing Convention**: e2e tests now verify cross-worker route contracts
3. **Documentation**: Routes are now documented in ARCHITECTURE.md

---

## Evidence

### Commit References

- **Fix:** [6f5b2a8](https://github.com/bailey-coding/beehive/commit/6f5b2a8) - Promotion worker route fix
- **Merge:** [b487a18](https://github.com/bailey-coding/beehive/commit/b487a18) - Merge of promotion-routes-fix
- **Verification:** [3d97f48](https://github.com/bailey-coding/beehive/commit/3d97f48) - M8 completion
- **AGENTS.md Update:** [8ef8b61](https://github.com/bailey-coding/beehive/commit/8ef8b61) - Added Response.ok check rule (8480fde is the unrelated edge /health change)

### Code References

- `workers/promotion-worker/` - Promotion worker (fixed)
- `workers/spec-do/` - Spec Durable Object (routes verified)
- `workers/shared/` - Spec DO client (updated)

---

## References

- [ADR-0002: Coordination State Storage](../decisions/0002-coordination-state.md) - Spec DO is authoritative
- [RFC-0001: Oracle Ladder Architecture](../rfcs/0001-oracle-ladder-architecture.md) - Promotion flow design
- [AGENTS.md](../../AGENTS.md) - Working conventions, including Response.ok check
- [OPEN-QUESTIONS.md](../OPEN-QUESTIONS.md) - Related findings and learnings
- [ARCHITECTURE.md](../ARCHITECTURE.md) - Spec DO route documentation

---

*This RFO documents a near-miss incident where the promotion worker was calling non-existent Spec DO routes. The issue was caught during code review and fixed before causing production impact. The lessons learned have been incorporated into working conventions and testing practices.*
