---
ADR-0005
---

# ADR: Organizational Memory

**Status:** Accepted · **Date:** 2026-10-09

Adopted from a convergent design review. Losing candidates are **not discarded** — they
are persisted as near-miss artifacts with their evidence attached, queryable for future
spec work. The lineage chain is first-class:
`RFD → ADR → Spec → Candidate → Promotion → SLO Outcome → RFO/NearMiss`.
The DO ledger schema must include, from day one: outcome-linking, complexity-delta score
as a candidate axis, actor identity (initiator / executor / reviewer) with trust-gated
promotion authority, and the near-miss record type. These are cheap now, expensive to
retrofit.
