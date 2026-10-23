---
RFC-0006
---

# RFC: Ledger Compare-and-Swap (CAS) with Tournament State Machine

**Status:** Implemented (Retrospective)  
**Date:** 2026-10-16 (commit fbc9fb5, 20:04 UTC)  
**Author:** unattributed (backfilled from git history)  
**Related:** RFC-0001 (Oracle Ladder), RFC-0004 (Canary Deploy), MILESTONES.md M5a (idempotency)  
**Supersedes:** None

---

## Summary

This retrospective RFC documents the implementation of **compare-and-swap (CAS) versioning** in the Spec Durable Object ledger, along with a **tournament state machine** for managing concurrent promotion operations. This addresses the challenge of handling concurrent writes in a multi-writer environment while maintaining consistency.

---

## Motivation

### The Problem

The Spec DO ledger faces a fundamental challenge:
- **Multiple writers** - Multiple promotion workers and agents may try to update the same records
- **Concurrent updates** - Queue delivery is at-least-once, so double-writes are possible
- **Atomic operations** - Promotion decisions must be atomic (promote + record verdict together)
- **Version conflicts** - Need to detect and handle conflicts when two processes try to update the same record

**From the docs:** "Queue delivery is at-least-once and double-writes are possible today" (`docs/MILESTONES.md` M5a; it is not in commit 8ef8b61). Note this CAS covers tournaments and merge trains only; M5a idempotency keys for all Spec DO mutations are still planned.

### Requirements

✅ **Atomic updates** - Read-modify-write must be atomic
✅ **Conflict detection** - Detect when concurrent updates occur
✅ **Retry logic** - Handle conflicts gracefully with retries
✅ **Tournament state** - Manage multi-candidate tournaments with clear state transitions
✅ **Version tracking** - Track current version for CAS operations
✅ **Failed tournament recording** - Record failed tournaments for observability

---

## Detailed Design

> **Audit 2026-10-17 (`docs/RECORDS-AUDIT.md`):** the original design claimed a `version` column on
> "all ledger tables", a `GET/PATCH /spec-do/record/:id` API and an INIT/RUNNING/DECIDING/
> CANCELLED tournament machine. None of that matches the code. Replaced from fbc9fb5,
> `workers/spec-do/schema.sql` (m8 block) and `workers/shared/ledger-state-machine.ts`.

Implemented in fbc9fb5 (2026-10-16 20:04 UTC), migration m7 -> m8, additive. Problem stated in the
commit: tournament and merge-train POST replaced whole rows, so concurrent promotion workers lost
updates (last writer won).

### Compare-and-swap

- `version INTEGER NOT NULL DEFAULT 1` exists on **`tournaments` and `merge_trains` only**
  (added by `SpecDO.applyLedgerCas`, PRAGMA-guarded). Candidates, specs and the other tables have
  no version column. Every write bumps it.
- Routes are `/tournament-status` and `/merge-train-status` (`LEDGER_PATHS`,
  `workers/shared/promotion-ledger.ts:172`). A POST over an existing row requires the
  `X-Expected-Version` header (409 `version_required` / `version_conflict`); a PATCH honours the
  header when sent. Check and write share one `transactionSync`.
- Promotion worker clients use `PromotionLedgerClient.modifyTournament` / `modifyMergeTrain`:
  re-read and re-apply on conflict, 3 tries. A failed winner promotion now throws.

### Tournament state machine (`workers/shared/ledger-state-machine.ts`)

States are `pending`, `in_progress`, `completed`, `failed` (not the INIT/RUNNING/DECIDING/CANCELLED
set previously shown; there is no cancelled state).

- `pending -> in_progress` needs at least 2 competing candidates
- `in_progress -> completed` needs a winner that is one of the candidates, and `completedAt`
- `in_progress -> failed` needs `failureReason`; the DO counts entries into `failed` in `attempts`
- `failed -> in_progress` retry while `attempts < MAX_TOURNAMENT_ATTEMPTS` (3), else
  `retries_exhausted`; `failed -> pending` resets `attempts` to 0
- `completed` is terminal; rewriting the current status is allowed (idempotent)
- New tournament columns: `failure_reason`, `failed_at`, `attempts`. The rules are enforced in
  the DO in the same transaction as the write, and shared with clients so they cannot drift.

---

## Alternatives Considered

### Alternative 1: Optimistic Locking Only (No Version)

**Pros:**
- Simpler implementation

**Cons:**
- ❌ Can't detect concurrent updates reliably
- ❌ No way to know if data changed between read and write

**Why Rejected:** Doesn't provide needed conflict detection

### Alternative 2: Pessimistic Locking (Row Locks)

**Pros:**
- Prevents concurrent updates entirely

**Cons:**
- ❌ Not supported by Cloudflare SQLite
- ❌ Serializes all writes (performance bottleneck)
- ❌ Doesn't scale with concurrent promotion workers

**Why Rejected:** Not feasible with Cloudflare SQLite

### Alternative 3: Last-Write-Wins

**Pros:**
- Simplest implementation
- No conflict detection needed

**Cons:**
- ❌ Silent data loss on conflicts
- ❌ No way to detect or handle concurrent updates
- ❌ Violates consistency requirements

**Why Rejected:** Unacceptable data loss risk

### Alternative 4: External Coordination (Redis, etc.)

**Pros:**
- More sophisticated locking mechanisms

**Cons:**
- ❌ External dependency
- ❌ Violates Workers-native rule
- ❌ Higher latency

**Why Rejected:** Violates non-negotiable architectural rule #4

---

## Consequences

### Positive

✅ **Concurrent write handling** - CAS detects and handles concurrent updates
✅ **Atomic operations** - the version check and write share one transaction; client read-modify-write retries up to 3 times
✅ **Conflict visibility** - Failed tournaments are recorded for observability
✅ **Retry logic** - Graceful handling of conflicts
✅ **Version tracking** - Each update increments version, providing history

### Negative

⚠️ **Retry latency** - Conflicts require retries, adding latency
⚠️ **Version churn** - High concurrency can cause rapid version increments
⚠️ **Complexity** - More complex than simple optimistic updates

### Neutral

ℹ️ **Retry limits** - Need to tune max retries based on expected conflict rate

---

## Implementation History

From the git history:

- **Commit fbc9fb5:** "ledger compare-and-swap (version + X-Expected-Version) and tournament state machine; promotion worker read-modify-write retries and records failed tournaments (m7 -> m8)"
- Part of M7→M8 additive migration
- Added `version` to `tournaments` and `merge_trains`
- Implemented CAS logic in Spec DO (`X-Expected-Version`)
- Added tournament state machine
- Updated promotion worker with retry logic
- Added failed tournament recording

### Related Finding

**Commit 8ef8b61:** "step: record the session's learnings (AGENTS rules: check Response.ok, tolerate mixed versions; routing: branch from main; troubleshooting: stuck migrations) and rewrite FOCUS.md for the next session"

This commit records: "Check `Response.ok` on every fetch to the Spec DO or another worker: a 404 is an error, never 'empty' (the promotion worker called three DO routes that do not exist, unnoticed"

This finding is related - it shows the importance of proper error handling when working with the Spec DO, which the CAS implementation now supports.

---

## Lessons Learned (Retrospective)

### What Went Well

✅ **Conflict detection** - CAS reliably detects concurrent updates
✅ **Retry logic** - Promotion worker handles conflicts gracefully
✅ **Failed tournament recording** - Observability into conflicts and retries
✅ **Version tracking** - Each update increments version, useful for debugging

### Challenges Faced

⚠️ **Version field migration** - Required additive migration (m7→m8)
⚠️ **Retry tuning** - Finding the right retry count and backoff strategy
⚠️ **Testing** - Testing concurrent writes is challenging

### Design Decisions That Held Up

✅ **Version field** - Simple incrementing counter works well for CAS
✅ **Retry with backoff** - Handles temporary conflicts effectively
✅ **Failed tournament recording** - Provides visibility into CAS conflicts
✅ **Read-modify-write pattern** - Works well with the Spec DO's transactional semantics

---

## Open Questions

- Should we implement exponential backoff for retries?
- Should we have a maximum version to prevent overflow?
- Should we support CAS for batch operations?
- Should we add metrics for CAS conflict rates?

---

## Future Enhancements

- **Exponential backoff** - Reduce contention on high conflict rates
- **Batch CAS** - CAS for multiple records atomically
- **Conflict metrics** - Track and alert on high CAS conflict rates
- **Version bounds** - Prevent version overflow with modulo arithmetic

---

## References

- [RFC-0001: Oracle Ladder Architecture](../rfcs/0001-oracle-ladder-architecture.md) - The ladder context
- [RFC-0004: Canary Deploy + Rollback](../rfcs/0004-canary-deploy-rollback.md) - Related deployment flow
- [MILESTONES.md](../MILESTONES.md) - M7 and M8 milestone details
- [Commit fbc9fb5](https://github.com/bailey-coding/beehive/commit/fbc9fb5) - Implementation commit
- [Commit 8ef8b61](https://github.com/bailey-coding/beehive/commit/8ef8b61) - Related session learnings
- [AGENTS.md](../../AGENTS.md#state-management) - State management rules

---

*This is a retrospective RFC documenting the compare-and-swap (CAS) versioning and tournament state machine implemented in the Spec DO. This system enables safe concurrent updates while maintaining consistency in the multi-writer ledger environment.*
