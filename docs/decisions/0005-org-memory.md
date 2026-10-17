---
ADR-0005
---

# ADR: Organizational Memory

**Status:** Proposed (was Accepted; the schema it requires is not built, see the audit note) · **Date:** 2026-10-09

> **Audit 2026-10-17 (`docs/RECORDS-AUDIT.md`):** Status is Accepted but little of this is built. In `workers/spec-do/schema.sql` there is `gate_verdicts.complexity_delta` (schema.sql:136, not a candidates column) and `actors.promotion_authority`, but no near-miss record type, no outcome-linking table and no initiator/executor/reviewer fields; `docs/MILESTONES.md` places the trust and governance schema in M5a/M5b (not started) and provenance in M7. "RFD" in the lineage is not defined anywhere in the repo (the process uses RFCs). `docs/ARCHITECTURE.md` indexes this ADR as "Org Memory (Maintainer-only)", which does not match the text.

Adopted from a convergent design review. Losing candidates are **not discarded** — they
are persisted as near-miss artifacts with their evidence attached, queryable for future
spec work. The lineage chain is first-class:
`RFD → ADR → Spec → Candidate → Promotion → SLO Outcome → RFO/NearMiss`.
The DO ledger schema must include, from day one: outcome-linking, complexity-delta score
as a candidate axis, actor identity (initiator / executor / reviewer) with trust-gated
promotion authority, and the near-miss record type. These are cheap now, expensive to
retrofit.
