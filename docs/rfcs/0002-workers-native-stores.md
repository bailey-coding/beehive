---
RFC-0002
---

# RFC: Workers-Native Stores Architecture

**Status:** Implemented (Retrospective)  
**Date:** 2026-10-09 (Approximate, based on ADR-0002 timestamp)  
**Author:** unattributed (backfilled from git history)  
**Related:** ADR-0002 (Coordination State Storage), ADR-0005 (Organizational Memory)  
**Supersedes:** None

---

## Summary

This retrospective RFC documents the foundational architectural decision to use **Cloudflare Workers-native stores** (Durable Objects, D1, Analytics Engine, R2) for all coordination state, rather than relying on Git notes or external databases. This aligns with the non-negotiable architectural rule: "Coordination state lives in Workers-native stores, never in the repo."

---

## Motivation

### The Problem

The Beehive platform requires a storage strategy that supports:
1. **Multi-writer, hot access patterns** - Multiple agents and workers need to read and write simultaneously
2. **Strong consistency** - Promotion decisions must be atomic and consistent
3. **Low latency** - Gate verdicts and promotion checks need to be fast
4. **Transaction support** - Related operations (e.g., promotion + rollback) must be atomic
5. **Cloudflare-native** - Must work seamlessly with the Cloudflare platform

### Why Not Git Notes?

Git notes were considered but rejected because:
- Note updates require ref pushes, creating contention through receive-pack
- Concurrent push ordering in Cloudflare Artifacts is undocumented
- Not suitable for hot, multi-writer access patterns
- Cannot provide transactional semantics
- Performance would be poor for coordination state

---

## Detailed Design

### Storage Layer Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    BEHIVE STORAGE ARCHITECTURE                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    Spec DO (Durable Object)                   │   │
│  │                  SQLite-backed, single source                  │   │
│  │  ✓ Transactional, read-your-writes semantics                 │   │
│  │  ✓ Authoritative for coordination state                       │   │
│  │  ✓ Tables: organizations, repositories, specs, candidates,    │   │
│  │            actors, gate_verdicts, trials, promotions          │   │
│  │  ✓ Hand-written spine (load-bearing wall)                     │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                       │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                D1 (Cloudflare SQL Database)                   │   │
│  │  ✓ Cross-spec indexes and queries                           │   │
│  │  ✓ Relational queries spanning multiple specs                │   │
│  │  ✓ Used for: spec indexes, candidate metadata, analytics     │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                       │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │           Analytics Engine (Honeycomb optional)              │   │
│  │  ✓ Metric streams: match rates, latency per candidate        │   │
│  │  ✓ Time-series data with high cardinality                    │   │
│  │  ✓ SLO monitoring and alerting                               │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                       │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                      R2 (Object Storage)                      │   │
│  │  ✓ Session records and transcripts                           │   │
│  │  ✓ Large binary artifacts                                     │   │
│  │  ✓ Cached snapshots for faster sandbox starts                │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                       │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                   Git Notes (Provenance Only)                │   │
│  │  ✓ Commit-attached provenance stamps                         │   │
│  │  ✓ Agent annotations                                         │   │
│  │  ✓ Final verdict stamps                                       │   │
│  │  ⚠️  NEVER queried as live state - append-only certificates     │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────┘
```

### Data Classification

| Data Type | Storage Location | Rationale |
|-----------|-----------------|-----------|
| **Coordination State** | Spec DO (SQLite) | Authoritative, transactional, hot access |
| - Organizations | Spec DO | Core entities |
| - Repositories | Spec DO | Git repo metadata |
| - Specs | Spec DO | Machine-readable contracts |
| - Candidates | Spec DO | Agent implementations |
| - Actors | Spec DO | Humans and agents |
| - Gate Verdicts | Spec DO | Gate evaluation results |
| - Trials | Spec DO | Head-to-head comparisons |
| - Promotions | Spec DO | Promotion decisions |
| - Issues | Spec DO | GitHub-style issues |
| **Cross-Spec Indexes** | D1 | Relational queries across specs (planned: no D1 binding exists in any `wrangler.toml` or in code) |
| - Spec indexes | D1 | Search and discovery |
| - Candidate metadata | D1 | Aggregated across specs |
| **Metric Streams** | Analytics Engine | Time-series, high-cardinality |
| - Match rates | Analytics Engine | Per-candidate validation |
| - Latency | Analytics Engine | Performance monitoring |
| - SLO metrics | Analytics Engine | Service level objectives |
| **Session Records** | R2 | Large artifacts (planned: no R2 binding exists in any `wrangler.toml`; session provenance is M7) |
| - Transcripts | R2 | Agent session history |
| - Snapshots | R2 | Cached states |
| **Provenance** | Git Notes | Append-only, portable |
| - Commit annotations | Git Notes | Portable history |
| - Verdict stamps | Git Notes | Final outcomes |

### Durable Object Design

**Class:** `SpecDO` (implemented in `workers/spec-do/`)

**Storage:** SQLite via Cloudflare's native DO storage (`state.storage.sql`)

**Key Characteristics:**
- Single instance per namespace (or per candidate for facet pattern)
- Transactional: All writes are atomic
- Read-your-writes: Consistent reads after writes
- Durable: State persists across worker restarts
- Isolated: Each DO instance is independent

**Schema Location:** `workers/spec-do/schema.sql` is the reference; `workers/spec-do/schema-inline.ts` is a hand-maintained inline copy (no generator exists) that `workers/spec-do/tests/schema-sync.test.ts` requires to match byte for byte (0fa4abb)

---

## Alternatives Considered

### Alternative 1: External Database (PostgreSQL, MySQL)

**Pros:**
- Familiar to developers
- Rich ecosystem and tooling
- Well-understood operational characteristics

**Cons:**
- ❌ Not Cloudflare-native (external dependency)
- ❌ Higher latency (not co-located with Workers)
- ❌ Additional operational complexity
- ❌ Doesn't integrate with Workers platform features
- ❌ Cost considerations for external hosting

**Why Rejected:** Violates non-negotiable rule #4: "Coordination state lives in Workers-native stores"

### Alternative 2: Git Notes for All State

**Pros:**
- Git-native, portable
- Versioned with the repo

**Cons:**
- ❌ Cannot handle multi-writer hot access
- ❌ No transactional semantics
- ❌ Push contention through receive-pack
- ❌ Performance issues for coordination state
- ❌ Concurrent push ordering undocumented in Artifacts

**Why Rejected:** As documented in ADR-0002, this doesn't work for coordination state

### Alternative 3: KV Storage

**Pros:**
- Cloudflare-native
- Simple key-value interface
- Low latency

**Cons:**
- ❌ No relational queries
- ❌ No transactions
- ❌ Limited data types (only strings)
- ❌ No SQL interface

**Why Rejected:** Too limited for complex coordination state

### Alternative 4: Hybrid (DO + External)

**Pros:**
- Best of both worlds
- Flexibility

**Cons:**
- ❌ Complexity of managing multiple systems
- ❌ Inconsistent latency characteristics
- ❌ Transactional boundaries unclear
- ❌ Operational complexity

**Why Rejected:** Unnecessary complexity; Workers-native stores are sufficient

---

## Consequences

### Positive

✅ **Simplicity** - All coordination in one place (Spec DO)
✅ **Performance** - Co-located with Workers, low latency
✅ **Consistency** - Transactional semantics for atomic operations
✅ **Cloudflare-native** - Full integration with platform features
✅ **Scalability** - Durable Objects scale automatically
✅ **Cost-effective** - Included with Cloudflare Workers

### Negative

⚠️ **Vendor lock-in** - Tightly coupled to Cloudflare platform
⚠️ **Learning curve** - SQLite in Durable Objects is a specific pattern
⚠️ **Migration complexity** - Schema changes require migrations

### Neutral

ℹ️ **Multi-writer patterns** - Requires careful design to avoid conflicts
ℹ️ **Cross-region considerations** - Durable Objects are region-specific

---

## Implementation History

This architecture was implemented from the project's inception:

- **Spike Phase:** Initial Spec DO implementation with basic schema
- **M1 Phase:** Ledger lifecycle added (tombstones, maintainer role, batched purge)
- Schema versions m1..m8 (`LATEST_SCHEMA_VERSION = 'm8'`, `workers/spec-do/index.ts:27`): m2 candidate columns, m3 service_accounts, m4 promotion ledger, m5 lifecycle (tombstones), m6 service tokens, m7 deploy refs and canary deployments, m8 ledger CAS and tournament failures

### Key Implementation Commits

From the git history:
- Schema sync between `schema.sql` and `schema-inline.ts` (commit 0fa4abb)
- Ledger lifecycle implementation (commit 48a5f54)
- Compare-and-swap for concurrent writes (commit fbc9fb5)
- Spec DO routes and authentication (commit 36c0716)

---

## Lessons Learned (Retrospective)

### What Went Well

✅ **Right choice for coordination** - Spec DO handles all coordination state effectively
✅ **SQLite works well** - Reliable, well-understood, good performance
⚠️ **Inline schema copy** - `schema-inline.ts` is copied by hand, not generated; the sync test is the guard
✅ **Migration system** - Versioned migrations work for schema evolution

### Challenges Faced

⚠️ **Schema drift** - Need to keep `schema.sql` and `schema-inline.ts` in sync (caught by unit test 0fa4abb)
⚠️ **Concurrent writes** - Required compare-and-swap implementation (fbc9fb5)
⚠️ **Mixed-version windows** - Must tolerate old and new peers simultaneously (per AGENTS.md)

### Design Decisions That Held Up

✅ **Single Spec DO** - Having one DO as source of truth simplifies architecture
✅ **SQLite storage** - Good choice for structured coordination data
✅ **Git notes for provenance** - Right split between hot state and portable history

---

## Open Questions

- Should we consider Durable Object facets for per-candidate isolation?
- How do we handle cross-region deployments with region-specific DOs?
- Should we use D1 more aggressively for query-heavy operations?
- What's the right balance between Spec DO and D1 for different query patterns?

---

## Future Enhancements

- **Facet pattern** - Per-candidate DO instances for better isolation
- **Query optimization** - Materialized views or indexes for common queries
- **Multi-region support** - Cross-region coordination patterns
- **Backup strategy** - Automated backups of critical DO state

---

## References

- [ADR-0002: Coordination State Storage](../decisions/0002-coordination-state.md) - The canonical ADR for this decision
- [ADR-0005: Organizational Memory](../decisions/0005-org-memory.md) - Recording state and outcomes
- [AGENTS.md](../../AGENTS.md#non-negotiable-architectural-rules) - Rule #4: Coordination state lives in Workers-native stores
- [ARCHITECTURE.md](../ARCHITECTURE.md) - Technical architecture overview
- [MILESTONES.md](../MILESTONES.md) - Project milestones and implementation phases
- [Spec DO Implementation](../../workers/spec-do/) - The actual Durable Object code

---

*This is a retrospective RFC documenting decisions already made and implemented. For the actual implementation, see the Spec DO worker code and related components.*
