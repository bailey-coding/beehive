# R2 Cache Pruning Implementation Plan

**Milestone**: M9 - CI Cache Management  
**Status**: Planned  
**Priority**: Medium  
**Owner**: Beehive Maintainer  

## Overview

This document outlines the implementation plan for R2 cache pruning in Beehive CI. Currently, CI caches are written but never cleaned up, leading to unbounded storage growth. This plan addresses cache invalidation, expiration, and size management.

**Related**:
- [CI-BEEHIVE.md](./CI-BEEHIVE.md) - Overall Beehive CI architecture
- [ci-enhanced.yml](../.github/workflows/ci-enhanced.yml) - Current CI workflow
- Issue: No CI clean-install build (addressed by ci-enhanced.yml)

## Problem Statement

The enhanced CI workflow (`ci-enhanced.yml`) performs per-worker clean installs and caches:
- `node_modules/` tarballs in R2
- Build artifacts from `wrangler deploy --dry-run`
- Test results and logs

Without pruning, R2 storage will grow indefinitely. The zod issue (f847f75) demonstrated that dependency resolution failures can be subtle and require clean installs to catch.

## Goals

1. **Prevent unbounded growth**: Ensure cache size stays within Cloudflare R2 limits
2. **Maintain cache validity**: Invalidate stale cache when dependencies change
3. **Minimize redundant work**: Reuse valid cache to speed up CI
4. **Zero maintenance**: Automated pruning with minimal human intervention

## Non-Goals

- Deploying Beehive CI on Beehive itself (see [CI-BEEHIVE.md](./CI-BEEHIVE.md))
- Replacing GitHub Actions CI (complementary, not replacement)
- Caching non-CI artifacts (focus on CI-only for now)

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    R2 Cache Pruning System                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐    │
│  │  CI Worker    │────▶│    R2        │◀────┤ Cache Janitor│    │
│  │  (Push/PR)    │     │  Bucket      │     │  (Scheduled)  │    │
│  └──────────────┘     └──────────────┘     └──────────────┘    │
│         │                    │                     │              │
│         │ Write              │ Read/Write          │ Read/Delete  │
│         ▼                    ▼                     ▼              │
│  ┌─────────────────────┐  ┌─────────────┐  ┌─────────────┐  │
│  │ Cache Key:           │  │ Cache Data:  │  │ Registry:    │  │
│  │ worker+hash(deps)   │  │ node_modules│  │ KVNamespace  │  │
│  │                     │  │ tarball      │  │ (metadata)   │  │
│  └─────────────────────┘  └─────────────┘  └─────────────┘  │
│                                                                  │
│  Pruning Triggers:                                               │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ • Time-based (TTL): Every 6 hours                        │    │
│  │ • Size-based (LRU): When >50GB                             │    │
│  │ • Event-based: On push/PR (dependency change)             │    │
│  │ • Manual: POST /cache/prune (protected)                   │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Implementation Phases

### Phase 1: TTL-Based Pruning (Week 1)

**Goal**: Basic time-based cache expiration using R2 lifecycle rules.

**Tasks**:
- [ ] Create R2 bucket `beehive-ci-cache`
- [ ] Configure R2 lifecycle rules:
  - `cache/node-modules/*` → 7 days TTL
  - `cache/build/*` → 1 day TTL
  - `cache/test-results/*` → 1 hour TTL
- [ ] Update `ci-enhanced.yml` to use consistent cache key prefixes
- [ ] Add monitoring for cache hit/miss rates

**Success Criteria**:
- Cache objects automatically deleted after TTL
- No manual intervention required
- CI workflows continue to function

**Effort**: 1 day  
**Risk**: Low

---

### Phase 2: Cache Registry and LRU Eviction (Week 2)

**Goal**: Track cache usage and evict least recently used when size limits are exceeded.

**Tasks**:
- [ ] Create KV namespace `beehive-ci-cache-registry`
- [ ] Implement `CacheRegistry` class (`workers/shared/cache-registry.ts`):
  - Record cache writes with metadata (size, worker, type, timestamp)
  - Track last accessed time
  - Support listing all entries
- [ ] Create Cache Janitor worker (`workers/cache-janitor/index.ts`):
  - Scheduled trigger every 6 hours
  - Delete expired entries (TTL check)
  - Delete LRU entries when total size > 50GB
  - Log pruning statistics
- [ ] Update CI workflows to record cache access
- [ ] Deploy cache-janitor worker

**Success Criteria**:
- Cache size stays below 50GB
- LRU eviction works correctly
- Registry stays in sync with R2 contents

**Effort**: 2-3 days  
**Risk**: Medium

---

### Phase 3: Dependency-Change Invalidation (Week 3)

**Goal**: Invalidate cache when dependencies change (no stale cache).

**Tasks**:
- [ ] Implement cache key generation with dependency hashing:
  ```typescript
  cacheKey = hash(workerName + package.json + lockfile + tsconfig.json)
  ```
- [ ] Create GitHub webhook handler:
  - Trigger on `push` and `pull_request` events
  - Identify changed workers (via git diff)
  - Invalidate cache for affected workers
- [ ] Add manual invalidation API:
  - Protected endpoint for maintainers
  - Support invalidating by worker, type, or all
- [ ] Update CI workflows to use dependency-aware cache keys

**Success Criteria**:
- Stale cache automatically invalidated on dependency changes
- Manual invalidation works for debugging
- No 404 errors from stale cache

**Effort**: 3-5 days  
**Risk**: Medium

---

### Phase 4: Monitoring and Optimization (Week 4)

**Goal**: Observe, optimize, and alert on cache performance.

**Tasks**:
- [ ] Add Prometheus metrics for cache:
  - Hit rate by worker
  - Cache size over time
  - Pruning frequency and volume
- [ ] Create Grafana dashboard for cache monitoring
- [ ] Add alerts:
  - Cache usage > 90% of limit
  - Cache hit rate < 50%
  - Pruning failures
- [ ] Optimize based on observations:
  - Adjust TTLs
  - Tune LRU thresholds
  - Improve cache key granularity

**Success Criteria**:
- Visibility into cache performance
- Proactive alerts for issues
- Optimized configuration

**Effort**: 2 days  
**Risk**: Low

## Cache Key Strategy

### Key Format
```
cache/{worker}/{cacheType}/{hash}
```

### Examples
- `cache/promotion-worker/nodeModules/a1b2c3d4e5`
- `cache/api/build/abc123`
- `cache/shared/nodeModules/xyz789`

### Hash Inputs by Cache Type

| Cache Type | Hash Inputs |
|------------|-------------|
| nodeModules | worker + package.json + lockfile |
| build | worker + source files + wrangler.toml |
| testResults | worker + test files + test config |
| wranglerOutput | worker + wrangler.toml + all source |

## Configuration

### R2 Bucket Configuration
```toml
# wrangler.toml for workers that use cache
[[r2_buckets]]
binding = "CI_CACHE"
bucket_name = "beehive-ci-cache"
```

### KV Namespace Configuration
```toml
# wrangler.toml for cache-janitor
[[kv_namespaces]]
binding = "CACHE_REGISTRY"
id = "<kv-id-for-registry>"
```

### TTL Settings

| Cache Type | TTL | Rationale |
|------------|-----|-----------|
| nodeModules | 7 days | Dependencies change infrequently |
| build | 24 hours | Source changes daily |
| testResults | 1 hour | Quick feedback loop |
| wranglerOutput | 24 hours | Config changes occasionally |

### Size Limits

| Setting | Value | Rationale |
|---------|-------|-----------|
| Max total cache | 50 GB | Cloudflare R2 free tier is generous |
| Max per object | 100 MB | node_modules can be large |
| Pruning interval | 6 hours | Balance between overhead and freshness |

## File Structure

```
workers/
├── shared/
│   ├── cache-config.ts          # Configuration constants
│   ├── cache-registry.ts        # KV-based cache registry
│   └── cache-client.ts          # Cache client with pruning hooks
│
└── cache-janitor/
    ├── index.ts                  # Cache janitor worker
    ├── wrangler.toml             # Deployment config
    └── package.json

docs/
├── CI-BEEHIVE.md               # Overall CI on Beehive doc
├── R2-CACHE-PRUNING-PLAN.md     # This document
└── OPS.md                      # (update with cache config)

.github/workflows/
├── ci.yml                      # Basic CI
└── ci-enhanced.yml             # Enhanced CI with caching
```

## Dependencies

### Phase 1
- Cloudflare R2 bucket creation
- R2 lifecycle rule configuration

### Phase 2
- KV namespace creation
- Cache registry implementation
- Cache janitor worker

### Phase 3
- GitHub webhook setup
- Cache key generation logic

### Phase 4
- Monitoring infrastructure (Prometheus, Grafana)
- Alerting configuration

## Rollback Plan

| Phase | Rollback Strategy |
|-------|-------------------|
| Phase 1 | Delete lifecycle rules, revert to no pruning |
| Phase 2 | Disable cache-janitor worker, registry remains |
| Phase 3 | Disable webhook handler, use TTL only |
| Phase 4 | Remove monitoring, keep existing functionality |

## Testing Strategy

### Unit Tests
- Cache key generation
- Registry CRUD operations
- TTL calculation
- LRU selection logic

### Integration Tests
- Cache write + TTL expiration
- Cache write + LRU eviction
- Dependency change invalidation
- Manual invalidation

### End-to-End Tests
- Full CI workflow with caching
- Verify cache hits/misses
- Verify pruning happens on schedule

## Open Questions

1. **Should we use R2 lifecycle rules or custom pruning?**
   - Recommendation: Custom pruning (more control, supports LRU)
   - R2 lifecycle rules as fallback

2. **What's the optimal cache size limit?**
   - 50GB is a reasonable starting point
   - Adjust based on actual usage

3. **Should we compress cache objects?**
   - `node_modules` are already compressed (npm packages)
   - Additional compression adds CPU overhead
   - Recommendation: No additional compression initially

4. **How to handle cache during CI failures?**
   - Failed builds should still cache (for retry efficiency)
   - But mark as potentially stale
   - Recommendation: Don't cache failed builds

5. **Should different branches have separate caches?**
   - Main branch: long TTL
   - PR branches: short TTL or no cache
   - Recommendation: Include branch in cache key

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Cache hit rate | >70% | Percentage of CI runs using cache |
| Cache size | <50GB | Total R2 storage used |
| CI duration | <10min | Average CI run time with cache |
| Pruning overhead | <5% | Time spent pruning vs total |

## Acceptance Criteria

- [ ] Cache automatically cleaned up without manual intervention
- [ ] Cache size stays within configured limits
- [ ] Stale cache invalidated on dependency changes
- [ ] CI performance improved or maintained
- [ ] Monitoring and alerts in place
- [ ] Documentation updated

## Timeline

| Phase | Duration | Start Date | End Date |
|-------|----------|------------|----------|
| Phase 1: TTL | 1 day | TBD | TBD |
| Phase 2: Registry + LRU | 2-3 days | After Phase 1 | TBD |
| Phase 3: Invalidation | 3-5 days | After Phase 2 | TBD |
| Phase 4: Monitoring | 2 days | After Phase 3 | TBD |
| **Total** | **2-3 weeks** | | |

## Resources

### Documentation
- [Cloudflare R2 Lifecycle Rules](https://developers.cloudflare.com/r2/api/lifecycle/)
- [Workers KV](https://developers.cloudflare.com/kv/)
- [Workers Scheduled Triggers](https://developers.cloudflare.com/workers/platform/triggers/cron/)

### Related Code
- [ci-enhanced.yml](../.github/workflows/ci-enhanced.yml)
- [CI-BEEHIVE.md](./CI-BEEHIVE.md)

## Appendix A: Sample Code

See [CI-BEEHIVE.md](./CI-BEEHIVE.md) for sample implementations of:
- Cache client
- Cache registry
- Cache janitor worker
- Cache key generation

## Appendix B: Cost Analysis

### Cloudflare R2 Pricing
- $0.015 per GB/month storage
- $0.0000055 per 10,000 read operations
- $0.0000165 per 10,000 write/delete operations

### Estimated Usage (50GB, 100 CI runs/day)
- Storage: $0.75/month
- Operations: ~$0.08/month
- **Total: ~$0.83/month**

### Comparison with GitHub Actions Cache
- GitHub Actions cache: Free for public repos
- Beehive self-hosted: More control, but cost

**Note**: These are estimates. Actual costs depend on usage patterns.

---

**Document Status**: Draft  
**Last Updated**: 2026-10-16  
**Next Review**: After Phase 2 implementation
