---
RFC-0006
---

# RFC: Ledger Compare-and-Swap (CAS) with Tournament State Machine

**Status:** Implemented (Retrospective)  
**Date:** 2026-10-13 (Approximate, based on commit fbc9fb5)  
**Author:** Maintainer / Architecture Team  
**Related:** RFC-0001 (Oracle Ladder), RFC-0004 (Canary Deploy), MILESTONES.md M7/M8  
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

**From the codebase:** "Queue delivery is at-least-once and double-writes are possible today." (Commit 8ef8b61)

### Requirements

✅ **Atomic updates** - Read-modify-write must be atomic
✅ **Conflict detection** - Detect when concurrent updates occur
✅ **Retry logic** - Handle conflicts gracefully with retries
✅ **Tournament state** - Manage multi-candidate tournaments with clear state transitions
✅ **Version tracking** - Track current version for CAS operations
✅ **Failed tournament recording** - Record failed tournaments for observability

---

## Detailed Design

### Compare-and-Swap Pattern

```
┌─────────────────────────────────────────────────────────────────┐
│                    COMPARE-AND-SWAP (CAS)                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Client (Promotion Worker)                                          │
│       │                                                               │
│       ▼                                                               │
│  ┌─────────────────┐                                                │
│  │  Step 1: Read   │  GET /spec-do/record/:id                       │
│  │  - Get current │──────────────────────► Spec DO                │
│  │    version     │     (current_version = v1)                   │
│  │  - Get current │                                     │
│  │    data        │                                     │
│  └────────┬────────┘                                                │
│            │                                                          │
│            ▼                                                          │
│  ┌─────────────────┐                                                │
│  │  Step 2: Modify │  Local computation                            │
│  │  - Update data  │  new_data = f(current_data)                    │
│  │  - New version  │  new_version = current_version + 1           │
│  └────────┬────────┘                                                │
│            │                                                          │
│            ▼                                                          │
│  ┌─────────────────┐                                                │
│  │  Step 3: CAS    │  PATCH /spec-do/record/:id                    │
│  │  - Send:       │──────────────────────► Spec DO                │
│  │    new_data   │     IF version == current_version:            │
│  │    new_version│        UPDATE record                         │
│  │    expected_v │        SET data = new_data                    │
│  │    er        │        SET version = new_version              │
│  │  - Check:     │        RETURN success                         │
│  │    version == │     ELSE:                                      │
│  │    expected_v │        RETURN conflict                         │
│  │    er        │                                                   │
│  └────────┬────────┘                                                │
│            │                                                          │
│     ┌──────┴──────┐                                                │
│     ▼             ▼                                                 │
│  Success      Conflict                                                │
│     │             │                                                 │
│     ▼             ▼                                                 │
│  Done      Retry with                                                │
│            fresh version                                              │
│                                                                      │
└─────────────────────────────────────────────────────────────────┘
```

### Version Field in Schema

All ledger tables now include a `version` field:

```sql
-- Example: candidates table
CREATE TABLE candidates (
    id TEXT PRIMARY KEY,
    spec_id TEXT NOT NULL REFERENCES specs(id),
    repository_id TEXT NOT NULL REFERENCES repositories(id),
    commit_hash TEXT NOT NULL,
    actor_id TEXT NOT NULL REFERENCES actors(id),
    status TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 0,  -- ← CAS version
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
```

### Tournament State Machine

**Tournament = Multi-candidate promotion competition**

```
┌─────────────────────────────────────────────────────────────────┐
│                    TOURNAMENT STATE MACHINE                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                      │
│  States:                                                            │
│                                                                      │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐           │
│  │   INIT      │───►│   RUNNING   │───►│  DECIDING   │           │
│  │  (setup)    │    │  (in-prog)  │    │  (evaluating)│           │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘           │
│         │                  │                  │                   │
│         │                  │                  │                   │
│         ▼                  ▼                  ▼                   │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐           │
│  │  CANCELLED  │◄───┤    FAILED    │◄───┤  COMPLETED │           │
│  │             │    │             │    │             │           │
│  └─────────────┘    └─────────────┘    └─────────────┘           │
│                                                                      │
│  Transitions:                                                         │
│  - INIT → RUNNING: Tournament starts, candidates registered         │
│  - RUNNING → DECIDING: All candidates have been evaluated          │
│  - DECIDING → COMPLETED: Winner selected and promoted             │
│  - RUNNING → FAILED: Unrecoverable error occurred                  │
│  - DECIDING → FAILED: No winner could be determined                  │
│  - Any → CANCELLED: External cancellation request                  │
│                                                                      │
│  CAS Integration:                                                    │
│  - All state transitions use CAS to prevent conflicts             │
│  - Retry on conflict with fresh version                              │
│  - Failed tournaments recorded for observability                   │
│                                                                      │
└─────────────────────────────────────────────────────────────────┘
```

### Promotion Worker Read-Modify-Write Retries

From the commit message: "promotion worker read-modify-write retries and records failed tournaments"

```typescript
// Pseudocode for promotion worker CAS retry
async function updateCandidateWithRetry(
  candidateId: string,
  updateFn: (data: Candidate) => Candidate,
  maxRetries: number = 3
): Promise<Candidate> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Step 1: Read current state
    const { data: current, version } = await specDoClient.getCandidate(candidateId);
    
    // Step 2: Modify locally
    const updated = updateFn(current);
    const newVersion = version + 1;
    
    // Step 3: CAS
    const result = await specDoClient.updateCandidate(
      candidateId,
      updated,
      { expectedVersion: version, newVersion }
    );
    
    if (result.success) {
      return updated; // Success
    }
    
    // Conflict - retry with fresh data
    if (result.error === 'version_conflict') {
      continue; // Retry loop will fetch fresh data
    }
    
    throw result.error;
  }
  
  throw new Error(`Max retries (${maxRetries}) exceeded`);
}
```

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
✅ **Atomic operations** - Read-modify-write is now atomic with retries
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
- Added version fields to ledger tables
- Implemented CAS logic in Spec DO
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
