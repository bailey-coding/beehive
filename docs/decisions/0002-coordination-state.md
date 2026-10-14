---
ADR-0002
---

# ADR: Coordination State Storage

**Status:** Accepted · **Date:** 2026-10-09

### Context

The platform needs a storage strategy for coordination state that supports multi-writer,
hot access patterns.

### Decision

Workers-native stores, not git notes:

| Data | Home |
|---|---|
| Scores, gate verdicts, train state, promotion decisions | Spec DO (SQLite) — authoritative |
| Metric streams (match rates, latency per candidate) | Analytics Engine (Honeycomb optional) |
| Cross-spec indexes | D1 |
| Commit-attached provenance, agent annotations, final verdict stamps | Git notes |

**Rationale:** coordination is multi-writer and hot; a note update is a ref push
contending through receive-pack, and concurrent push ordering in Artifacts is
undocumented. The DO gives transactional, read-your-writes semantics for promotion
decisions. Notes are the append-only certificate layer — decided facts get notarized
onto the artifacts they concern, and nothing more.
