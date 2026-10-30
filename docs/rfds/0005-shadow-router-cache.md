---
RFD-0005
---

# RFD: Shadow Router In-Isolate Caching

**Status:** Implemented (Retrospective)  
**Date:** 2026-10-16 (commit 746c42c, 07:12 UTC)  
**Author:** unattributed (backfilled from git history)  
**Related:** RFD-0001 (Oracle Ladder), MILESTONES.md M2/M3  
**Supersedes:** None

---

## Summary

This retrospective RFD documents the implementation of **in-isolate caching in the Shadow Router** for live canary deploy reference pointers. This caching mechanism enables the shadow router to efficiently track and route to live canary deployments while maintaining data consistency and minimizing redundant operations.

---

## Motivation

### The Problem

The Shadow Router needs to:
1. Mirror production traffic to candidate deployments
2. Discard candidate responses (never return to users)
3. Trigger Scientist comparison against declared delta surface
4. Track live canary deployments for comparison

Without caching, the Shadow Router would need to:
- Query the Spec DO on every request to find current canary deployments
- Handle stale data if deployments change during request processing
- Manage concurrent requests efficiently

This creates latency and performance issues.

### Requirements

✅ **Low latency** - Cached references for fast routing decisions
✅ **Consistency** - No stale routing, bounded staleness
✅ **Concurrency safe** - Handle many simultaneous requests
✅ **Error tolerant** - Graceful degradation on cache failures
✅ **Configurable** - TTL and behavior should be tunable

---

## Detailed Design

### Cache Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    SHADOW ROUTER CACHE                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    In-Isolate Cache                           │   │
│  │  ┌─────────────────────────────────────────────────┐    │   │
│  │  │  Cache Entry: live_canary_refs                            │    │   │
│  │  │                                                             │    │   │
│  │  │  One entry per isolate (the whole LiveRef[] list)         │    │   │
│  │  │  Value: {                                                   │    │   │
│  │  │    deploy_ref_id: "...",                                    │    │   │
│  │  │    worker_url: "...",                                      │    │   │
│  │  │    created_at: 1234567890,                                 │    │   │
│  │  │    expires_at: 1234567900                                  │    │   │
│  │  │  }                                                         │    │   │
│  │  │                                                             │    │   │
│  │  └─────────────────────────────────────────────────┘    │   │
│  │                                                              │   │
│  │  TTL: LIVE_REFS_CACHE_TTL_MS (default: 5000ms / 5 seconds)    │   │
│  │                                                              │   │
│  │  Behavior:                                                   │   │
│  │  - stale-on-error: bounded to one extra TTL                 │   │
│  │  - errors never cached                                       │   │
│  │  - in-flight dedupe: prevent duplicate fetch operations      │   │
│  │                                                              │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    Cache Operations                          │   │
│  │                                                             │   │
│  │  On Request:                                                 │   │
│  │  1. Check cache for spec_id + candidate_id                  │   │
│  │  2. If hit: use cached deploy_ref                           │   │
│  │  3. If miss: fetch from Spec DO                             │   │
│  │  4. Update cache with fresh data                            │   │
│  │                                                             │   │
│  │  On Cache Miss:                                              │   │
│  │  - Fetch from Spec DO /api/canary_deployments               │   │
│  │  - Update cache with TTL                                    │   │
│  │  - Dedupe in-flight fetches (same key)                       │   │
│  │                                                             │   │
│  │  On Error:                                                   │   │
│  │  - Return stale data if available (bounded to one extra TTL)│   │
│  │  - Never cache errors                                       │   │
│  │  - Log error for observability                              │   │
│  │                                                             │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                      │
└─────────────────────────────────────────────────────────────────┘
```

### Cache Configuration

The cache is `LiveRefsCache` in `workers/shadow-router/live-refs-cache.ts`; the loader is the Spec
DO read in `applyCanaryRefs` (`workers/shadow-router/config.ts`). There is one entry per isolate
holding the full list of live canary pointers, not one entry per spec/candidate.

- `LIVE_REFS_CACHE_TTL_MS` (wrangler var / secret, string): unset or invalid -> 5000 ms;
  `0` disables the cache; values above `MAX_LIVE_REFS_TTL_MS` (60000) are clamped.
- There is no `LIVE_REFS_CACHE_ENABLED` flag; the earlier text invented it (`grep` finds it only
  in this RFD). On a failed read with no servable value, the caller falls back to the static config.

### Cache Behavior Details

1. **Normal Operation:**
   - Cache hit: Return cached deploy reference immediately
   - Cache miss: Fetch from Spec DO, update cache
   - TTL expiration: Automatically evict and refresh

2. **Stale-on-Error:**
   - If Spec DO fetch fails, return stale cached data
   - Stale data is bounded to one extra TTL period
   - Example: If TTL=5s and Spec DO is down, stale data valid for max 10s

3. **Errors Never Cached:**
   - Failed fetches never cached
   - Prevents caching of error states

4. **In-Flight Deduplication:**
   - Concurrent requests that find the entry expired
   - Only first request fetches from Spec DO
   - Others wait for first request to complete
   - Prevents thundering herd problem

### Integration with Rollback

The cache integrates with the rollback e2e polling:
- **Rollback e2e polls within the TTL** - Rollback operations complete within cache TTL
- This ensures that after rollback, the cache naturally expires stale references
- No manual cache invalidation needed

---

## Alternatives Considered

### Alternative 1: No Caching

**Pros:**
- Simpler implementation
- Always consistent

**Cons:**
- ❌ High latency (Spec DO fetch on every request)
- ❌ Performance bottleneck
- ❌ Doesn't scale with traffic volume

**Why Rejected:** Performance requirements make this infeasible

### Alternative 2: External Cache (Redis, etc.)

**Pros:**
- More cache features (eviction policies, persistence)
- Shared across workers

**Cons:**
- ❌ External dependency
- ❌ Higher latency (not co-located)
- ❌ Violates Workers-native rule
- ❌ Additional operational complexity

**Why Rejected:** Violates non-negotiable architectural rule #4

### Alternative 3: Longer TTL with Manual Invalidation

**Pros:**
- Fewer Spec DO fetches
- Simpler logic

**Cons:**
- ❌ Stale data for longer periods
- ❌ Manual invalidation is error-prone
- ❌ Doesn't handle rollback scenarios well

**Why Rejected:** Doesn't meet consistency requirements

---

## Consequences

### Positive

✅ **Low latency** - Cached references provide fast routing decisions
✅ **Scalable** - Handles high request volumes efficiently
✅ **Consistent** - Bounded staleness with stale-on-error fallback
✅ **Resilient** - Graceful degradation on Spec DO failures
✅ **Configurable** - TTL and behavior can be tuned per deployment

### Negative

⚠️ **Stale data** - Cache may serve slightly stale references
⚠️ **Memory usage** - Cache consumes memory in the isolate
⚠️ **Complexity** - Additional logic for cache management

### Neutral

ℹ️ **TTL tuning** - Default 5s may need adjustment based on deployment patterns

---

## Implementation History

From the git history:

- **Commit 746c42c:** "shadow-router in-isolate cache of live canary deploy-ref pointers (LIVE_REFS_CACHE_TTL_MS, default 5s, 0 disables; stale-on-error bounded to one extra TTL, errors never cached, in-flight dedupe); rollback e2e polls within the TTL; docs"
- Implemented as part of M2 or M3 work
- Added to Shadow Router worker
- Configuration options documented
- Rollback integration verified

---

## Lessons Learned (Retrospective)

### What Went Well

✅ **Performance improvement** - Reduced Spec DO fetches significantly
✅ **Resilient design** - Stale-on-error prevents cascading failures
✅ **In-flight dedupe** - Prevents thundering herd on cache misses
✅ **Rollback integration** - Natural cache expiration handles rollback scenarios
✅ **Configurable** - Can tune TTL based on needs

### Challenges Faced

⚠️ **TTL tuning** - Finding the right TTL required experimentation
⚠️ **Memory management** - Cache size considerations for long-running isolates
⚠️ **Testing** - Verifying cache behavior in different scenarios

### Design Decisions That Held Up

✅ **In-isolate cache** - Using the Worker isolate's memory is efficient
✅ **Stale-on-error** - Bounded staleness prevents serving bad data indefinitely
✅ **Errors never cached** - Prevents caching of failure states
✅ **In-flight dedupe** - Efficient handling of concurrent requests
✅ **5s default TTL** - Good balance between freshness and performance

---

## Open Questions

- Should TTL be spec-specific or candidate-specific?
- Should we support cache warm-up on deployment?
- Should we add cache statistics for observability?
- Should we implement LRU eviction for memory management?

---

## Future Enhancements

- **Dynamic TTL** - Adjust TTL based on request patterns
- **Cache statistics** - Track hit rate, latency savings, etc.
- **Selective caching** - Cache only certain types of references
- **Pre-warming** - Warm cache on deployment events

---

## References

- [RFD-0001: Oracle Ladder Architecture](../rfds/0001-oracle-ladder-architecture.md) - The ladder this supports
- [RFD-0004: Canary Deploy + Rollback](../rfds/0004-canary-deploy-rollback.md) - Canary deployment system
- [MILESTONES.md](../MILESTONES.md) - M2 and M3 milestone details
- [Commit 746c42c](https://github.com/bailey-coding/beehive/commit/746c42c) - Implementation commit
- [AGENTS.md](../../AGENTS.md#the-oracle-ladder) - Oracle ladder context

---

*This is a retrospective RFD documenting the in-isolate caching mechanism implemented in the Shadow Router. This caching enables efficient tracking of live canary deployments while maintaining consistency and performance.*
