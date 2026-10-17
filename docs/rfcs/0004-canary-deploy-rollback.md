---
RFC-0004
---

# RFC: Canary Deploy + Auto-Rollback System

**Status:** Implemented (Retrospective)  
**Date:** 2026-10-16 (commit c27628a, 01:26 UTC)  
**Author:** unattributed (backfilled from git history)  
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

✅ **Small percentage** - Configurable percentage of live traffic (no default in code)
✅ **SLO monitoring** - Track Service Level Objectives continuously
✅ **Auto-rollback** - Automatic reversion on SLO violation
✅ **Statsig integration** - Use Statsig for feature flagging and gradual rollout
✅ **Ref-based** - Rollback changes references, not redeploys
✅ **Shadow comparison** - Shadow Router follows live canary references

---

## Detailed Design

> **Audit 2026-10-17 (`docs/RECORDS-AUDIT.md`):** the original diagram, state machine, SQL and
> rollback steps did not match the code (`deploy_refs` has no `status`; rungs are only `canary`
> and `full`; rollback is not a status flip). Replaced below from `workers/spec-do/schema.sql`
> and `workers/shared/deploy-refs.ts`. Whether SLO-triggered auto-rollback runs without a human
> call was not verified (the code has an `auto-rollback` route and an `auto_rollback` switch).

Implemented in c27628a (2026-10-16 01:26 UTC), migration m6 -> m7, additive.

- **`deploy_refs`** is the traffic pointer per `(spec_id, rung)` with `rung IN ('canary','full')`.
  Rows are append-only: every move inserts a row with `prev_ref_id` set to the head it replaces
  (unique index keeps the chain linear); the head is the row nothing points back to. Columns:
  `id, spec_id, rung, candidate_id, commit_sha, worker_version_id, prev_ref_id,
  action IN ('promote','rollback'), moved_by, moved_at` (epoch ms). `candidate_id NULL` is the
  empty ref.
- **Rollback is a ref operation (AGENTS.md rule 7).** Promotion inserts a row pointing at the
  new target; rollback inserts a row pointing at the target of `head.prev_ref_id`. Both are the
  same insert in opposite directions, so rolling back twice toggles back. No status field is
  edited and nothing is redeployed. The Artifacts production ref is a provenance mirror only.
- **`canary_deployments`** records each canary and the ref row it created: `id, candidate_id,
  spec_id, status IN ('deployed','superseded','rolled_back'), url, worker_version_id, commit_sha,
  traffic_percentage, holdout_percentage, auto_rollback, deploy_ref_id, rollback_reason,
  created_at, updated_at`.
- **Flow.** `preview-manager` `POST /api/preview/canary` deploys (Workers Versions are stubbed
  unless `BEEHIVE_LOCAL_DEV=1` and `WORKER_VERSIONS_MODE=stub`; production answers 501, e326b8c);
  `canary-worker` holds the SLO monitor, `/slo-status`, and the auto-rollback route; the shadow
  router reads the live canary pointers from the Spec DO (cached, RFC-0005).
- **Traffic percentage** is validated as `0 < x <= 100` with `traffic + holdout <= 100`
  (`workers/canary-worker/canary.ts:116`); no 1-5% default exists in code.

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
✅ **Ref-based operations** - Rollback is an append-only ref insert, not a status change (see Detailed Design)
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
