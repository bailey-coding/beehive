---
RFC-0004
---

# RFC: Canary Deploy + Auto-Rollback System

**Status:** Implemented (Retrospective)  
**Date:** 2026-10-13 (Approximate, based on commit c27628a)  
**Author:** Maintainer / Architecture Team  
**Related:** RFC-0001 (Oracle Ladder), MILESTONES.md M3/M6.5  
**Supersedes:** None

---

## Summary

This retrospective RFC documents the **canary deployment and auto-rollback system** implemented as part of the oracle ladder (RFC-0001, rung 4). The system enables safe deployment of candidates to a small percentage of live traffic with automatic rollback if SLO violations are detected.

---

## Motivation

### The Problem

Deploying candidates directly to full production is risky. Even with the pre-merge, shadow, and train gates (RFC-0001), we need a final validation step with real live traffic before full deployment. This requires:

1. **Controlled exposure** - Limit blast radius during initial live deployment
2. **Automated monitoring** - Continuously check SLOs during canary
3. **Automatic rollback** - Revert without human intervention if issues detected
4. **Ref-based operations** - Rollback must be a cheap reference operation (per ADR rules)

### Canary Requirements

✅ **Small percentage** - Configurable percentage of live traffic (default: 1-5%)
✅ **SLO monitoring** - Track Service Level Objectives continuously
✅ **Auto-rollback** - Automatic reversion on SLO violation
✅ **Statsig integration** - Use Statsig for feature flagging and gradual rollout
✅ **Ref-based** - Rollback changes references, not redeploys
✅ **Shadow comparison** - Shadow Router follows live canary references

---

## Detailed Design

### Canary Deployment Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    CANARY DEPLOYMENT FLOW                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐    │
│  │ Preview       │     │ Preview       │     │ Canary       │    │
│  │ Manager       │────►│ Deploy Ref    │────►│ Deploy Ref   │    │
│  │               │     │ (stored)      │     │ (active)     │    │
│  └──────────────┘     └──────────────┘     └──────┬───────┘    │
│                                                        │            │
│                                                        ▼            │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    Spec DO (Durable Object)                   │   │
│  │  ┌─────────────────────────────────────────────────┐    │   │
│  │  │  deploy_refs table                                   │    │   │
│  │  │  - id: deploy reference ID                          │    │   │
│  │  │  - candidate_id: the candidate being deployed         │    │   │
│  │  │  - rung: canary (or shadow, train, full)               │    │   │
│  │  │  - status: staging, active, rolling_back, failed     │    │   │
│  │  │  - created_at: timestamp                               │    │   │
│  │  │  - canary_deployments: JSON array of canary deploys │    │   │
│  │  └─────────────────────────────────────────────────┘    │   │
│  │                                                              │   │
│  │  ┌─────────────────────────────────────────────────┐    │   │
│  │  │  canary_deployments table                             │    │   │
│  │  │  - deploy_ref_id: FK to deploy_refs                     │    │   │
│  │  │  - worker_name: name of the worker                      │    │   │
│  │  │  - worker_version: version deployed                     │    │   │
│  │  │  - percentage: traffic percentage (0-100)             │    │   │
│  │  │  - status: created, deployed, monitoring, rolling_back  │    │   │
│  │  └─────────────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    Workers Builds                           │   │
│  │  - Creates isolated preview deployments                     │   │
│  │  - Canary deploys are preview deployments with traffic    │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                       │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    Shadow Router                           │   │
│  │  - Follows live canary deploy references                   │   │
│  │  - Routes small % of traffic to canary                    │   │
│  │  - Statsig integration for traffic splitting                 │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                       │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    Monitoring & Rollback                    │   │
│  │  - Analytics Engine tracks SLO metrics                    │   │
│  │  - Auto-rollback on SLO violation                          │   │
│  │  - Ref-based: update deploy_refs status, not redeploy       │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                      │
└─────────────────────────────────────────────────────────────────┘
```

### Canary Deployment States

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  STAGING    │───►│  ACTIVE     │───►│ MONITORING  │───►│ ROLLED_BACK  │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
     │                  │                  │                  │
     │                  │                  │                  │
     ▼                  ▼                  ▼                  ▼
  Deploy       Traffic        SLO Check       Revert refs
  to Workers  Split          Failed           to previous
  (preview)   (Statsig)                            deploy
```

### Schema Changes (M6→M7 Additive)

**New Tables:**

```sql
-- Deploy references (existing, enhanced)
CREATE TABLE deploy_refs (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES candidates(id),
    rung TEXT NOT NULL CHECK(rung IN ('shadow', 'train', 'canary', 'full')),
    status TEXT NOT NULL CHECK(status IN ('staging', 'active', 'rolling_back', 'failed', 'completed')),
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    completed_at INTEGER,
    canary_deployments_json TEXT  -- JSON array of canary deployment IDs
);

-- Canary deployments (NEW for canary support)
CREATE TABLE canary_deployments (
    id TEXT PRIMARY KEY,
    deploy_ref_id TEXT NOT NULL REFERENCES deploy_refs(id),
    worker_name TEXT NOT NULL,           -- e.g., 'beehive-canary'
    worker_version TEXT NOT NULL,        -- version being deployed
    percentage INTEGER NOT NULL CHECK(percentage >= 0 AND percentage <= 100),
    status TEXT NOT NULL CHECK(status IN ('created', 'deployed', 'monitoring', 'rolling_back', 'failed')),
    statsig_feature_flag TEXT,           -- Statsig flag for traffic splitting
    slo_violations_json TEXT,             -- JSON array of SLO violations
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
```

### Rollback Mechanism

**Ref-Based Rollback (per ADR rules):**

1. Update `deploy_refs.status` from 'active' to 'rolling_back'
2. Update `canary_deployments.status` to 'rolling_back'
3. Update `deploy_refs.status` to 'failed' or 'completed' (depending on outcome)
4. Shadow Router stops routing traffic to the rolled-back deployment
5. **No redeploy needed** - Just reference changes

**Auto-Rollback Triggers:**
- SLO violation (e.g., error rate > threshold)
- Latency spike (e.g., p99 > 2x baseline)
- Manual trigger (via API or maintainer action)

---

## Alternatives Considered

### Alternative 1: No Canary (Direct to Full)

**Pros:**
- Simpler architecture
- Fewer components

**Cons:**
- ❌ High risk - no gradual rollout
- ❌ No early detection of issues
- ❌ Large blast radius on failure
- ❌ Violates fail-safe principle

**Why Rejected:** Too risky for production deployments

### Alternative 2: Blue-Green Deployment

**Pros:**
- Full isolation
- Easy rollback

**Cons:**
- ❌ Resource-intensive (double capacity needed)
- ❌ Not gradual (100% or 0%)
- ❌ Doesn't integrate with oracle ladder progression
- ❌ More complex than needed

**Why Rejected:** Overkill for Beehive's use case

### Alternative 3: Feature Flags Only (No Canary Worker)

**Pros:**
- Statsig already integrated
- Simpler

**Cons:**
- ❌ No deployment isolation
- ❌ Harder to monitor
- ❌ Doesn't integrate with promotion flow

**Why Rejected:** Doesn't provide deployment-level isolation

---

## Consequences

### Positive

✅ **Safe deployments** - Limited blast radius during initial live rollout
✅ **Automated** - No human intervention needed for rollback
✅ **Ref-based** - Fast, cheap rollback operations
✅ **Monitored** - Continuous SLO tracking
✅ **Gradual** - Configurable percentage for controlled exposure

### Negative

⚠️ **Complexity** - Additional worker and state to manage
⚠️ **Statsig dependency** - Requires Statsig integration for traffic splitting
⚠️ **Monitoring overhead** - Need to maintain SLO definitions and thresholds

### Neutral

ℹ️ **Statsig stubbing** - Local development uses stubbed Statsig
ℹ️ **Worker Versions** - Canary uses Workers Versions API (stubbed in local dev)

---

## Implementation History

From the git history:

- **Commit c27628a:** "canary deploy + rollback as Spec DO deploy refs (deploy_refs/canary_deployments, m6->m7 additive), preview-manager POST /api/preview/canary (Workers Versions stubbed), shadow-router follows the live canary ref, fix canary DataCloneError, auto-rollback route, e2e worker script"
- This was part of M6→M7 additive migration
- Canary deployments table added
- Preview manager enhanced with canary support
- Shadow router updated to follow canary refs
- Workers Versions stubbing for local dev

---

## Lessons Learned (Retrospective)

### What Went Well

✅ **Additive migration** - M6→M7 migration was smooth and backward compatible
✅ **Local dev support** - Workers Versions stubbing works for local testing
✅ **Ref-based rollback** - Changing references is fast and reliable
✅ **Shadow integration** - Shadow router following canary refs enables comparison

### Challenges Faced

⚠️ **DataCloneError** - Initial implementation had cloning issues (fixed in same commit)
⚠️ **Statsig stubbing** - Local development required careful stubbing
⚠️ **E2E testing** - Testing canary flow end-to-end was complex

### Design Decisions That Held Up

✅ **Deploy refs pattern** - Central tracking of deployments works well
✅ **Ref-based operations** - Rollback is just a status change, very fast
✅ **Percentage config** - Configurable canary percentage provides flexibility
✅ **Auto-rollback** - Automated monitoring prevents prolonged issues

---

## Open Questions

- Should canary percentage be spec-specific or global?
- How do we handle cascading rollbacks (canary → train → shadow)?
- Should we support A/B testing patterns (multiple canaries)?
- How do we integrate with external monitoring systems?

---

## Future Enhancements

- **Dynamic percentage** - Auto-adjust canary percentage based on SLOs
- **Multi-region canary** - Canary in one region before others
- **User segment canary** - Canary for specific user segments
- ** progressive canary** - Automatically increase percentage over time

---

## References

- [RFC-0001: Oracle Ladder Architecture](../rfcs/0001-oracle-ladder-architecture.md) - The 5-rung ladder this implements
- [MILESTONES.md](../MILESTONES.md) - M3 and M6.5 milestone details
- [Commit c27628a](https://github.com/bailey-coding/beehive/commit/c27628a) - Implementation commit
- [AGENTS.md](../../AGENTS.md#the-oracle-ladder-memorize) - Oracle ladder definition
- [STATSIG-INTEGRATION.md](../STATSIG-INTEGRATION.md) - Statsig integration details

---

*This is a retrospective RFC documenting the canary deployment and auto-rollback system implemented as part of the oracle ladder. This system enables safe, gradual deployment of candidates to live traffic with automatic rollback on SLO violations.*
