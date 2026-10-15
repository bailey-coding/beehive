---
category: planning
status: active
milestone: m5
audience: human,agent
tags:
  - phase-report
---

# M5 Implementation Plan — Trust & Governance Layer

**Status:** PLANNED (Post-submission hardening phase)  
**Created:** 2026-10-13  
**Period:** Post-2026-10-14 (Post-submission)  
**Lead:** [TBD]  
**Owner:** M5 Documentation Agent  
**Milestone:** Trust & governance layer — Issue intake and merge governance as first-class platform mechanics

---

## Executive Summary

**M5 introduces a comprehensive trust and governance layer** that treats issue intake and merge governance as first-class platform mechanics. This directly addresses supply-chain security lessons from recent industry incidents (xz-style lone-maintainer attacks, hijacked dependencies, social engineering of maintainers) by implementing defense-in-depth for code changes and promotions.

M5 consists of **four interconnected components:**

1. **Enriched Issue Intake** — Every issue carries metadata from creation: complexity estimates (reusing M1 scoring), change-type classification with confidence, reporter trust levels, and cost attribution
2. **Actor Trust Registry** — Extends M1 actor identity with calibrated trust scores, driving gate policies and approval authority
3. **Two-Person Merge Rule** — Supply-chain defense requiring two distinct human maintainer approvals for critical changes (security-sensitive, dependency, auth/secrets/build pipeline, or low-trust actor promotions)
4. **Bootstrap Posture** — Day-one readiness with founder as sole maintainer, but with full schema, classification, and approval fields in place

**Core principle:** The **OCAP principle** (Objects-Capabilities) — Objects (data) can have capabilities. Agents can hold capabilities. **Humans hold approval authority** — maintainer approval is human-only, cannot be delegated to agents.

**Feasibility:** YES — M5 builds directly on M1's actor identity model and complexity-delta scoring, requiring primarily schema extensions and policy logic rather than new infrastructure.

**Dependencies:** M1 Complete (actor identity model, Spec DO ledger, complexity-delta scoring)

---

## M5 Scope (From MILESTONES.md)

**Architecture of distrust principle:** "The agent cannot be trusted, so build so that its mistakes cannot matter." — Every agent starts with zero capabilities; authority flows only through explicit capability grants.

### A. Enriched Issue Intake
- Complexity estimate (predictive, reusing M1 complexity-delta scoring)
- Change-type classification with confidence (typo-fix / refactor / behavior-change / security-sensitive / dependency-change / infra)
- Reporter trust level
- Cost attribution model (reporter / project budget / trusted-reporter waiver)
- **Change type drives gate policy** (which oracles are mandatory, which can be skipped)

### B. Actor Trust Registry
- Extends M1 actor identity model
- Trust scores per reporter/initiator (0-100)
- Calibrated by measured outcomes (promoted candidates, SLO outcomes, near-miss rate)
- Trust gates: agent-budget authorization, oracle-skipping privileges, promotion authority

### C. Two-Person Merge Rule (Supply-Chain Defense)
- Designated change types requiring dual approval: security-sensitive, dependency changes, auth/secrets/build pipeline changes, promotions by low-trust actors
- Two distinct maintainers required (different actor IDs)
- Agents cannot hold maintainer approval authority (OCAP principle enforcement)
- Ledger records both approvals on promotion record

### D. Bootstrap Posture
- Founder as sole author+maintainer initially
- Ledger schema ships from day one with all approval fields
- Change-type classification implemented from day one
- Approval fields populated (with self-approvals marked as such)
- Governance retrofittable by policy change, not schema migration

### E. Varda-Inspired Enhancements (NEW)
- **Full object-capability model** — Cap'n Proto or similar for Spec DO ↔ grain communication, enforcing "only connectivity begets connectivity"
- **Grain-level versioning and rollback** — Each candidate facet maintains state snapshots; rollback restores grain to previous version without affecting others
- **Agent authorization for issue/spec creation** — Trust registry tracks which agents are authorized to create issues and specs (prevents runaway agent generation)
- **Gatekeeper granular controls** — Repository scoping, field masking, rate limiting, human approval gates for side-effecting writes
- **V8 isolate performance** — Leverage Workers/Durable Objects (V8 isolates) for 10x-100x faster cold starts vs containers, enabling per-agent isolation at scale
- **Idempotent operations** — All Spec DO mutations include idempotency keys; handle at-least-once Queue delivery without ordering guarantees

### F. Web Search as a Granted Capability (EXPLORE)
Cloudflare shipped a `web_search` tool for the Agents SDK on 2026-10-12 ([changelog](https://developers.cloudflare.com/changelog/post/2026-10-12-web-search/)): v0.27.0+, Web Search API backed by Exa, Linkup or ceramic.ai, pairs with `web_fetch`, runs in a Durable Object via the `AI` binding, and has a model-free mode (`createAIWebSearch()`) for scheduled jobs. Beehive does not use the Agents SDK today, so adopting it is new infrastructure.

Treat web access as a capability in the trust registry, granted per role and **off by default**:
- **Spec authors and issue triage (first target):** research upstream RFCs, docs and prior art while drafting a spec. Specs get human review anyway, so a bad source is caught before anything is built on it.
- **Dependency/security oracle:** when a candidate adds or bumps a dependency, look up advisories and CVEs and flag likely typosquats. Feeds the `dependency-change` change type and the two-person rule.
- **Model-free watchers:** a scheduled job that watches Cloudflare changelogs (Artifacts, Sandbox, Workers) and drafts `docs/OPEN-QUESTIONS.md` entries.
- **Candidate implementers (last, if at all):** prompt injection, supply-chain and reproducibility risk. Allow only with an allowlist of docs domains, and record every query and fetched URL in the candidate's provenance (git notes) so gates and reviewers can see what influenced it.

**Unknowns to resolve first:** pricing, rate limits, beta/GA status, whether results can be restricted by domain, and per-provider differences.

---

## Key Concepts

### 1. Enriched Issue Intake Flow

Every issue carries comprehensive metadata enabling intelligent routing and cost attribution:

```
Reporter Submits Issue
       │
       ▼
┌─────────────────────────────┐
│ ISSUE CREATION               │
│  - Complexity Estimate (A1)  │  ← Reuse M1 components
│  - Change-Type Classify (A2) │  ← 6 categories + confidence
│  - Reporter Trust Lookup (B1)│  ← From Actor Trust Registry
│  - Cost Attribution (A4)     │  ← Who pays for agent runs
│  - Gate Policy Determination │  ← Which oracles run
└──────────────────┬──────────┘
                   │
             Issue Created with Full Metadata
```

**Gate Policy Matrix:** Change type + complexity + trust level → which oracles are mandatory/skipped.

**Cost Attribution:** Based on reporter trust, change type, and complexity. High-trust reporters and low-risk changes use project budget; others may require reporter to pay.

### 2. Actor Trust Registry

Calibrated trust scoring system:

```
trust_score = f(
  promoted_candidates * 0.4,
  slo_compliance_rate * 0.3,
  near_miss_count * -0.1,
  rollback_rate * -0.2,
  inactivity_decay * -0.01/day (max -50)
)
```

**Trust Gates:**
- agent_budget_authorization: min trust 60
- oracle_skipping: min trust 80
- promotion_authority: min trust 90 (maintainer level)

**OCAP enforcement:** Agents can NEVER hold promotion authority.

### 3. Two-Person Merge Rule

Supply-chain defense for critical changes:

```
Critical Change Types (always require dual approval):
  ✓ security-sensitive
  ✓ dependency-change
  ✓ auth changes
  ✓ secrets changes
  ✓ build pipeline changes
  ✓ promotions by actors with trust < 90

Flow:
  Request Approval 1 → Maintainer 1 Approves
                        → Request Approval 2
                        → Maintainer 2 Approves (different from M1)
                        → Promotion Proceeds
                        
  Both approvals recorded in ledger with actor IDs.
```

**OCAP Principle:** Only humans can hold maintainer approval authority. Agents cannot satisfy the two-person rule.

### 4. Bootstrap Posture

Day-one readiness for single-maintainer projects:

```
Phase 1 (Single Maintainer):
  - Founder is sole maintainer (trust=100, level=maintainer)
  - All governance schema present from day one
  - Self-approvals allowed and marked explicitly
  - Dual approval satisfied by founder providing both (marked as self-approvals)

Phase 2 (Multi-Maintainer):
  - Second maintainer onboarded
  - True dual approval now possible (2 distinct humans)
  - Self-approvals can be disabled by policy

Phase 3 (Policy Evolution):
  - All governance features retrofittable by policy change
  - NO schema migrations required
```

---

## Detailed Component Breakdown

### A. Enriched Issue Intake

#### A1. Complexity Estimate
- [ ] Reuse M1 complexity-delta scoring components
- [ ] Apply predictively to proposed change (before development)
- [ ] Return score 0-100
- [ ] Used to determine gate policy

#### A2. Change-Type Classification
- [ ] Categories: typo-fix, refactor, behavior-change, security-sensitive, dependency-change, infra
- [ ] Classification with confidence score (0-1)
- [ ] Rule-based initially (upgradable to ML)
- [ ] Drives gate policy (mandatory vs skippable oracles)

#### A3. Reporter Trust Level
- [ ] Lookup from Actor Trust Registry
- [ ] Trust score 0-100 per reporter
- [ ] Used for cost attribution and gate policy

#### A4. Cost Attribution
- [ ] Determine who pays: reporter, project_budget, waiver
- [ ] Based on: reporter trust, change type, complexity
- [ ] Budget tracking per actor
- [ ] Cost limits and alerts

### B. Actor Trust Registry

#### B1. Trust Scores
- [ ] Per-actor trust score (0-100)
- [ ] Stored in extended actors table
- [ ] Calibrated by: promoted candidates, SLO outcomes, near-miss rate
- [ ] Automatic recalibration on events and periodically

#### B2. Trust Gates
- [ ] agent_budget_authorization gate (min trust: 60)
- [ ] oracle_skipping gate (min trust: 80)
- [ ] promotion_authority gate (min trust: 90, maintainer level)
- [ ] Configurable thresholds per project

### C. Two-Person Merge Rule (Supply-Chain Defense)

#### C1. Designated Change Types
- [ ] security-sensitive: always requires dual approval
- [ ] dependency-change: always requires dual approval
- [ ] auth/secrets/build pipeline: always requires dual approval
- [ ] Any promotion by actor with trust < 90: requires dual approval

#### C2. Approval Mechanism
- [ ] Two distinct maintainers required (different actor IDs)
- [ ] Cannot be the same person
- [ ] Agents cannot hold maintainer approval authority (OCAP)
- [ ] Ledger records both approvals on promotion record
- [ ] Approvals must come from human actors

#### C3. OCAP Principle
- [ ] Objects (data) can have capabilities
- [ ] Agents can hold capabilities
- [ ] Humans hold approval authority (NOT delegatable to agents)
- [ ] Enforced in all approval workflows

### D. Bootstrap Posture

#### D1. Founder as Sole Maintainer
- [ ] Founder automatically set up on project creation
- [ ] trust_score = 100, trust_level = maintainer
- [ ] All capabilities enabled

#### D2. Day-One Readiness
- [ ] Ledger schema includes all approval fields from day one
- [ ] Change-type classification implemented from day one
- [ ] Approval fields populated (with self-approvals)
- [ ] No schema migration needed when second maintainer joins

#### D3. Self-Approvals
- [ ] Self-approvals allowed initially
- [ ] Marked explicitly as self-approvals in ledger
- [ ] Can be filtered/reported separately
- [ ] Founder can provide both approvals (marked as self-approvals)

---

## Must Have

### Core Implementation
- [ ] Enriched issue intake implemented (A1-A4)
- [ ] Complexity estimation working (reusing M1)
- [ ] Change-type classification functional (6 categories)
- [ ] Actor trust registry implemented (B1-B2)
- [ ] Trust score calculation working
- [ ] Trust gates configured and enforced
- [ ] Two-person merge rule for critical changes (C1-C3)
- [ ] OCAP principle enforced in all approvals
- [ ] Bootstrap posture configured (D1-D3)

### Integration
- [ ] Issue intake integrated with spec/candidate flow
- [ ] Trust gates integrated with existing workflows
- [ ] Dual approval integrated with promotion workflow
- [ ] Bootstrap posture tracking working
- [ ] All metadata flowing through end-to-end

### Schema
- [ ] Issues table with enrichment fields
- [ ] Actors table extended with trust fields
- [ ] Promotions table extended with dual approval fields
- [ ] All M5 tables created (trust_calibration_history, trust_gates, etc.)
- [ ] All schema extensions additive (no breaking changes)

---

## Should Have

- [ ] Trust score visualization dashboard
- [ ] Automated trust calibration (background job)
- [ ] Cost attribution reporting
- [ ] Budget tracking per actor with limits
- [ ] Trust decay mechanism (inactivity penalty)
- [ ] Multi-maintainer support tested
- [ ] Self-approval reporting and filtering
- [ ] Advanced change-type classification (ML model)
- [ ] Trust score history and audit trail
- [ ] Customizable gate policies per project
- [ ] API endpoints for all M5 features

---

## Go No-Go

Before starting M5 implementation:
- [ ] Human approves M5-PLAN.md
- [ ] M1 actor identity model verified complete
- [ ] M1 Spec DO schema verified stable
- [ ] M1 complexity-delta scoring verified reusable
- [ ] Development environment ready
- [ ] All M2/M3/M4 tests passing
- [ ] Submission complete (2026-10-14)

Before declaring M5 complete:
- [ ] All Must Have items implemented
- [ ] End-to-end flow verified
- [ ] Integration tests passing
- [ ] Documentation complete
- [ ] No blocking issues

---

## Dependencies

**M1 (Complete):**
- Actor identity model (extended by M5)
- Spec DO ledger (extended with M5 tables)
- Complexity-delta scoring (reused for predictive estimation)
- Gate workflow (extended with trust gates)

**No new Cloudflare services required** — M5 extends existing infrastructure.

---

## Exit Criteria

M5 is **COMPLETE** when:
- [ ] Enriched issue intake fully functional
- [ ] Actor trust registry operational
- [ ] Two-person merge rule working
- [ ] Bootstrap posture configured
- [ ] All components integrated and tested
- [ ] Documentation complete
- [ ] Ready for production use

---

## File Changes Summary

### New Files
```
workers/shared/
├── complexity-estimator.ts
├── change-classifier.ts
├── trust-lookup.ts
├── cost-attribution.ts
├── trust-calibration.ts
├── trust-gates.ts
├── dual-approval.ts
├── ocap.ts
├── critical-change-detector.ts
└── bootstrap.ts

scripts/
├── verify-m5.sh
└── demo-m5.sh

docs/
├── M5-PLAN.md (this document)
└── M5-IMPLEMENTATION.md
```

### Modified Files
```
workers/spec-do/
├── index.ts (issues, trust registry, approvals, bootstrap)
└── schema-inline.ts (all M5 schema extensions)

workers/api/
└── index.ts (M5 API endpoints)

workers/gate-workflow/
└── index.ts (trust gate checks, dual approval)
```

---

## Implementation Timeline

M5 is **post-submission hardening phase** (post-2026-10-14):

| Phase | Duration | Focus |
|-------|----------|-------|
| Phase 0 | Day 1 | Preparation, schema design |
| Phase 1 | Days 2-3 | Enriched Issue Intake (A1-A4) |
| Phase 2 | Days 4-5 | Actor Trust Registry (B1-B2) |
| Phase 3 | Days 6-7 | Two-Person Merge Rule (C1-C3) |
| Phase 4 | Days 8-9 | Bootstrap Posture (D1-D3) |
| Phase 5 | Days 10-11 | Integration & Wiring |
| Phase 6 | Days 12-13 | Verification & Documentation |

**Total estimate:** ~40-50 hours of focused work across 2 weeks.

---

## Risk Assessment

| Risk | Severity | Mitigation | Probability |
|------|----------|------------|-------------|
| Schema conflicts | Low | Additive changes only | Very Low |
| Trust calibration performance | Low | Background processing, indexing | Low |
| Dual approval blocks legitimate changes | Medium | Allow emergency override | Low |
| OCAP bypass | High | Audit logging, code reviews | Low |
| Breaking existing flows | High | All changes additive | Very Low |

---

## OCAP Principle Reference

The **OCAP Principle** is fundamental to M5 security:

- **Objects** (data/resources) can have **capabilities** (permissions)
- **Agents** can hold capabilities
- **Humans** hold approval authority
- **Critical:** Approval authority CANNOT be delegated to agents

**In M5:**
- ✅ Agents can create candidates, trigger gates, report metrics
- ❌ Agents CANNOT approve promotions
- ❌ Agents CANNOT be maintainers
- ❌ Agents CANNOT satisfy two-person rule

---

## Appendix: Database Schema Extensions

All M5 changes are **additive** to M1 schema:

### New Tables
```sql
-- Issues with enrichment
CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY, spec_id TEXT NOT NULL, title TEXT NOT NULL,
  reporter_id TEXT NOT NULL, complexity_estimate INTEGER,
  change_type TEXT, change_type_confidence REAL,
  reporter_trust_level INTEGER, cost_attribution TEXT,
  gate_policy TEXT, status TEXT, created_at INTEGER, updated_at INTEGER
);

-- Trust registry extensions
CREATE TABLE IF NOT EXISTS trust_calibration_history (...);
CREATE TABLE IF NOT EXISTS trust_gates (...);

-- Dual approval tracking
CREATE TABLE IF NOT EXISTS promotion_approvals (...);
CREATE TABLE IF NOT EXISTS critical_change_types (...);

-- Bootstrap tracking
CREATE TABLE IF NOT EXISTS project_settings (...);
CREATE TABLE IF NOT EXISTS self_approvals (...);
```

### Table Extensions
```sql
-- Actors (extend M1)
ALTER TABLE actors ADD COLUMN trust_score INTEGER DEFAULT 50;
ALTER TABLE actors ADD COLUMN trust_level TEXT DEFAULT 'new';
ALTER TABLE actors ADD COLUMN promoted_candidates INTEGER DEFAULT 0;
ALTER TABLE actors ADD COLUMN is_maintainer BOOLEAN DEFAULT FALSE;

-- Promotions
ALTER TABLE promotions ADD COLUMN requires_dual_approval BOOLEAN DEFAULT FALSE;
ALTER TABLE promotions ADD COLUMN satisfied_dual_approval BOOLEAN DEFAULT FALSE;
ALTER TABLE promotions ADD COLUMN approval_1_actor_id TEXT;
ALTER TABLE promotions ADD COLUMN approval_2_actor_id TEXT;
ALTER TABLE promotions ADD COLUMN self_approval_count INTEGER DEFAULT 0;
```

---

## Confidence Scores

| Component | Confidence | Notes |
|-----------|------------|-------|
| A1 Complexity Estimate | 0.95 | Reuses proven M1 |
| A2 Change-Type Classification | 0.90 | Rule-based well-defined |
| A3 Reporter Trust | 0.95 | Simple lookup |
| A4 Cost Attribution | 0.90 | Clear rules |
| B1 Trust Scores | 0.95 | Straightforward |
| B2 Trust Gates | 0.98 | Simple checks |
| C1-C3 Two-Person Rule | 0.95 | Clear workflow |
| D1-D3 Bootstrap | 0.98 | Schema ready |

**Overall M5 Confidence: 0.95**

---

## Next Steps

1. Review and approve M5-PLAN.md
2. Begin implementation post-2026-10-14 submission
3. Focus on Must Have items first
4. Iterate based on usage and feedback

---

## Commit Message Template

```
step: <component> | task: m5-<feature> | spec: <clause> | confidence: <0-1>

- Description of changes
- Files modified
- Test coverage
```

---

*Document created: 2026-10-13*
*Document status: PLANNED (Post-submission)*
*Owner: M5 Documentation Agent*
*Based on: MILESTONES.md M5 section*
