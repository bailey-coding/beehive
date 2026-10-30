---
RFD-0001
---

# RFD: Oracle Ladder Architecture

**Status:** Implemented (Retrospective)  
**Date:** 2026-10-09 (approximate; ADR-0001 is the VCS client model and does not define the ladder, whose first written form is `AGENTS.md`)  
**Author:** unattributed (backfilled 2026-10-16 from git history; no commit names a decision-maker)  
**Related:** ADR-0002 (Coordination State Storage), MILESTONES.md  
**Supersedes:** None

---

## Summary

This retrospective RFD documents the foundational architectural decision to implement a 5-rung "oracle ladder" for progressively validating candidate implementations through increasingly rigorous gates, with live production traffic as the final arbiter.

---

## Motivation

The core thesis of Beehive requires a mechanism to answer: **"Which implementation of a spec should be promoted?"** Traditional code review is social, subjective, and doesn't scale with multiple agent implementations. We needed an empirical, automated system where production traffic decides.

### Key Requirements

1. **Empirical validation** - Decisions based on real traffic, not social consensus
2. **Progressive confidence** - Build trust gradually, not all at once
3. **Fail-safe** - Mistakes should be caught early with minimal blast radius
4. **Agent-native** - Multiple agents can independently implement the same spec
5. **Non-blocking** - Review doesn't become a bottleneck with many candidates

---

## Detailed Design

### The Oracle Ladder

The oracle ladder consists of five rungs, each with increasing traffic exposure and stricter validation:

```
┌─────────────────────────────────────────────────────────────┐
│                      ORACLE LADDER                              │
├─────────────┬─────────────────┬────────────────┬──────────────┤
│ Rung         │ Traffic         │ Oracle          │ Failure       │
│              │ Exposure        │ Mechanism      │ Action        │
├─────────────┼─────────────────┼────────────────┼──────────────┤
│ Pre-merge   │ none            │ Tests, property │ Never board   │
│              │                 │ checks, spec    │ the train     │
│              │                 │ conformance     │              │
├─────────────┼─────────────────┼────────────────┼──────────────┤
│ Shadow       │ mirrored,       │ Scientist diff │ Hold, iterate │
│              │ discarded       │ vs spec's       │              │
│              │                 │ declared delta   │              │
│              │                 │ surface         │              │
├─────────────┼─────────────────┼────────────────┼──────────────┤
│ Train        │ projection slice│ Combined-       │ Drop car,      │
│              │                 │ candidate       │ re-project    │
│              │                 │ conformance     │              │
├─────────────┼─────────────────┼────────────────┼──────────────┤
│ Canary       │ small % live    │ SLOs via        │ Auto-rollback  │
│              │                 │ Statsig +       │ (ref op)       │
│              │                 │ Analytics Engine│              │
├─────────────┼─────────────────┼────────────────┼──────────────┤
│ Full         │ 100%            │ Drift, holdouts │ Alarm, bisect │
│              │                 │                 │ by diff       │
└─────────────┴─────────────────┴────────────────┴──────────────┘
```

### Rung Details

#### 1. Pre-merge Gate

**Purpose:** Ensure basic correctness before any production exposure

**Mechanism:**
- Automated tests (unit, integration)
- Property-based checks
- Spec conformance validation

**Traffic:** None (runs in isolated environment)

**Pass Criteria:** All tests pass, spec contract satisfied

**Components:** Gate Workflow Worker

#### 2. Shadow Gate

**Purpose:** Validate behavior matches spec with real production traffic patterns

**Mechanism:**
- Mirror production traffic to candidate
- Discard candidate responses (never returned to users)
- Scientist pattern: compare candidate output vs baseline
- Validate against spec's declared delta surface

**Traffic:** Mirrored production traffic (discarded)

**Pass Criteria:** Diffs within declared delta surface tolerance

**Components:** Shadow Router Worker, Scientist Comparator Worker

#### 3. Train Gate

**Purpose:** Validate candidate in realistic but isolated conditions

**Mechanism:**
- Projection: route a slice of traffic to candidate
- Combined-candidate conformance check
- Multi-candidate tournament comparison

**Traffic:** Projection slice (small percentage, isolated)

**Pass Criteria:** All candidates in train car pass conformance

**Components:** Promotion Worker (tournament mode)

#### 4. Canary Gate

**Purpose:** Validate candidate with small percentage of live traffic

**Mechanism:**
- Route small % of live traffic to candidate
- Monitor SLOs (Service Level Objectives)
- Statsig feature flags for gradual rollout
- Analytics Engine for metrics collection

**Traffic:** Small percentage of live traffic (e.g., 1-5%)

**Pass Criteria:** SLOs maintained, no degradation

**Components:** Canary Worker, Statsig Integration, Analytics Engine

#### 5. Full Gate

**Purpose:** Full production deployment with monitoring

**Mechanism:**
- 100% traffic to candidate
- Drift detection (behavior divergence from spec)
- Holdouts (control group for comparison)

**Traffic:** 100% live traffic

**Pass Criteria:** No drift detected, SLOs maintained

**Components:** Promotion Worker (full mode)

### Promotion Flow

```
Candidate Implementation
    ↓
┌─────────────────┐
│ Pre-merge Gate   │──── No ────► Stop, fix issues
└────────┬────────┘
         Yes
    ↓
┌─────────────────┐
│ Shadow Gate      │──── No ────► Hold, iterate
└────────┬────────┘
         Yes
    ↓
┌─────────────────┐
│ Train Gate       │──── No ────► Drop from train
└────────┬────────┘
         Yes
    ↓
┌─────────────────┐
│ Canary Gate      │──── No ────► Auto-rollback
└────────┬────────┘
         Yes
    ↓
┌─────────────────┐
│ Full Gate        │──── No ────► Alarm, bisect
└────────┬────────┘
         Yes
    ↓
   PROMOTED
```

### Key Concepts

**Declared Delta Surface:** Each spec defines what changes are expected (status codes, headers, body structure, response time). The Scientist comparator validates candidate behavior against this declared surface.

**Tournament Model:** Multiple candidates can compete. The system runs them head-to-head and promotes the winner based on empirical performance.

**Ref-based Rollback:** Promotion and demotion are equally cheap. Rollback is a reference operation, not a redeploy.

---

## Impact Analysis

### Affected Components

All major Beehive components implement parts of the oracle ladder:
- `workers/api` (deployed as `beehive`) - Edge router, entry point
- `workers/gate-workflow` - Pre-merge gate execution
- `workers/shadow-router` - Shadow traffic mirroring
- `workers/scientist-comparator` - Comparison against declared delta surface
- `workers/preview-manager` - Preview deployments
- `workers/promotion-worker` - Train and full promotion
- `workers/canary-worker` - Canary deployment and rollback
- `workers/spec-do` - Spec Durable Object (state management)

### Breaking Changes

None - This was a foundational design decision made at project inception.

### Performance Considerations

- **Pre-merge:** No traffic impact, runs in isolation
- **Shadow:** Minimal impact (mirrored traffic, responses discarded)
- **Train:** Isolated projection, no user impact
- **Canary:** Small percentage of live traffic at risk
- **Full:** 100% traffic, requires high confidence

### Security Considerations

- Each gate must validate authentication and authorization
- Canary and Full gates expose candidates to real traffic - must ensure candidates cannot compromise security
- Rollback mechanisms must be secure and not introducible new vulnerabilities

---

## Implementation History

This RFD documents decisions that were **already implemented** in the initial project structure:

- **M2 (completed 2026-10-12 per `docs/MILESTONES.md`):** Shadow Router, Scientist Comparator, Preview Manager implemented
- **M3 (partial per `docs/MILESTONES.md`):** `promotion-worker` (tournament and merge-train modes) and `canary-worker`; the Full rung and the drift/holdout checks are not verified here
- **M4:** submitted; reported by the maintainer, not verified here

### Related Commits

The oracle ladder implementation spans multiple commits and milestones. Key implementation points:
- Shadow Router: Mirror traffic and discard responses
- Scientist Comparator: Validate against declared delta surface
- Preview Manager: Create isolated preview deployments
- Promotion Worker: Tournament and train modes
- Canary Worker: Small percentage live traffic with auto-rollback

---

## Lessons Learned (Retrospective)

### What Went Well

✅ **Clear progression path** - The 5-rung structure provides a logical path from zero to full production
✅ **Fail-safe design** - Each rung catches issues before the next, limiting blast radius
✅ **Empirical validation** - Production traffic makes the final decision, not social consensus
✅ **Agent-friendly** - Multiple agents can compete fairly on the same spec

### Challenges Faced

⚠️ **Complexity** - Managing 10+ workers with complex interactions is challenging
⚠️ **State coordination** - Ensuring consistent state across all rungs requires careful design (addressed by ADR-0002)
⚠️ **Testing** - Validating the full ladder requires comprehensive e2e tests

### Design Decisions That Held Up

✅ **Ref-based rollback** - Making rollback a cheap reference operation was critical
✅ **Declared delta surface** - Allowing specs to declare expected changes enables precise validation
✅ **Tournament model** - Multiple candidates competing works well for agent-native workflow

---

## Open Questions

- Should there be a "Dry Run" rung before Pre-merge for local validation?
- How do we handle candidates that pass Pre-merge but fail Shadow due to environment differences?
- Should the percentage for Canary be configurable per spec?
- How do we prevent "thrashing" where candidates repeatedly pass and fail the same rung?

---

## Future Enhancements

- **Dynamic rung configuration** - Allow specs to define custom gates or skip certain rungs
- **Automated rollback triggers** - More sophisticated auto-rollback based on SLO violations
- **Parallel promotion tracks** - Multiple independent promotion tracks for different spec versions
- **Rung-specific metrics** - Detailed metrics collection at each rung for better diagnostics

---

## References

- [ADR-0001: VCS Client Model](../decisions/0001-vcs-client-model.md) - Related VCS decisions
- [ADR-0002: Coordination State Storage](../decisions/0002-coordination-state.md) - State management for the ladder
- [ADR-0005: Organizational Memory](../decisions/0005-org-memory.md) - Recording outcomes and near-misses
- [MILESTONES.md](../MILESTONES.md) - Project timeline and milestones
- [ARCHITECTURE.md](../ARCHITECTURE.md) - Technical architecture overview
- [The Oracle Ladder (AGENTS.md)](../../AGENTS.md#the-oracle-ladder-memorize) - Original definition

---

*This is a retrospective RFD documenting decisions already made and implemented. For the actual implementation details, see the referenced components and milestones.*
