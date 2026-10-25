# Running Beehive CI on Beehive Itself

This document explores the idea of using Beehive to run its own CI workflows, including the challenges and requirements.

## Current State

Beehive currently uses GitHub Actions for CI (`ci.yml`; until 2026-10-25 also `ci-enhanced.yml` and `ci-skip.yml`, merged into it). These workflows:
- Run on GitHub-hosted runners (Ubuntu)
- Perform clean per-worker installs
- Run typecheck, unit tests, and migration tests
- Do NOT deploy (deploys come from Cloudflare Artifacts repo)

## Goal: Run CI on Beehive

The vision is to have Beehive agents execute the CI workflows, enabling:
- Self-hosted CI execution
- Agent-native CI workflows
- Better integration with Beehive's own features (specs, tournaments, etc.)

## Challenges

### 1. Build Caching

**Problem**: Workers Builds (Cloudflare's build system) caches dependencies per worker. When running CI on Beehive, we need a way to cache:
- Node.js modules (`node_modules`)
- Wrangler build artifacts
- TypeScript compilation outputs

**Current approach**: GitHub Actions has built-in caching. Beehive would need to implement its own caching mechanism.

**Potential solutions**:
- Use Cloudflare R2 or Workers KV for cache storage
- Implement a cache key system based on `package.json` and lockfile hashes
- Cache at the worker level (each worker caches its own dependencies)
- Cache at the spec level (CI for a spec shares cache)

**Recommendation**: Start with per-worker caching using R2:
```
Cache Key: hash(worker-name + package.json + package-lock.json)
Cache Value: node_modules/ directory tarball
```

### 2. Execution Environment

**Problem**: Beehive workers run on Cloudflare Workers, which:
- Have limited execution time (10ms CPU for free tier, longer for paid)
- Cannot run arbitrary shell commands
- Don't have a filesystem (in the traditional sense)

**Solution**: Run CI in a separate execution environment:
- **Option A**: Use Cloudflare Pages Functions + Builds
  - Pages can run build commands
  - Can cache dependencies
  - Limited to build-time execution

- **Option B**: Use a separate CI runner service
  - Self-hosted runners (like GitHub Actions self-hosted)
  - Beehive agents coordinate but execute on traditional VMs
  - Agents submit CI jobs, runners execute them

- **Option C**: Use Durable Objects for coordination
  - DO can coordinate CI workflows
  - Actual execution still needs to happen elsewhere
  - DO tracks state, progress, results

**Recommendation**: Start with Option B (self-hosted runners) coordinated by Beehive agents. This is the most practical approach given Cloudflare Workers' limitations.

### 3. Dependency Installation

**Problem**: Running `npm install` requires:
- Node.js runtime
- npm/yarn/pnpm
- Network access to npm registry
- Write access to filesystem

**Solution**: 
- Use a containerized environment (Docker) for CI execution
- Beehive agents orchestrate the container execution
- Containers have Node.js pre-installed
- Cache layer mounted as volume

**Implementation sketch**:
```
1. Beehive agent receives CI request for a spec/candidate
2. Agent identifies the worker to test
3. Agent creates a Docker container with:
   - Node.js 22
   - Git repo checked out
   - Cache volume mounted at /cache
4. Container runs:
   - Restore cache if valid
   - npm install
   - npm run typecheck
   - npm test
   - Save cache
5. Results reported back to Beehive
```

### 4. Test Isolation

**Problem**: Tests need to run against:
- In-memory SQLite (current approach)
- Real Cloudflare services (for integration tests)
- Isolated environments (no cross-test pollution)

**Solution**:
- Unit tests: Continue with in-memory SQLite (fast, isolated)
- Integration tests: Use ephemeral Cloudflare resources
  - Create temporary Workers for test duration
  - Use test-specific Durable Object namespaces
  - Clean up after test completion

### 5. Build Artifacts

**Problem**: Wrangler build produces:
- Compiled TypeScript
- WASM modules
- Configuration files

These need to be:
- Cached between runs
- Deployed for testing
- Cleaned up after

**Solution**:
- Cache build artifacts in R2
- Deploy test workers to a staging environment
- Use unique worker names per CI run
- Automatic cleanup via TTL or explicit teardown

### 6. Secrets Management

**Problem**: CI needs access to:
- NPM tokens (for private packages)
- Cloudflare API tokens (for deployment tests)
- GitHub tokens (for repo operations)

**Solution**:
- Use Cloudflare Workers Secrets
- Inject secrets into CI containers at runtime
- Never store secrets in git or cache
- Rotate secrets regularly

## Proposed Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Beehive CI System                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │ CI Request    │───▶│ CI Agent      │───▶│ Docker Runner     │  │
│  │ (PR merge)    │    │ (Beehive)     │    │ (Self-hosted)     │  │
│  └──────────────┘    └──────────────┘    └──────────────────┘  │
│                    │                                         │          │
│                    │                                         ▼          │
│                    │              ┌──────────────────────────────┐  │
│                    │              │ Cache Storage (R2)            │  │
│                    │              └──────────────────────────────┘  │
│                    │                                         ▲          │
│                    │                                         │          │
│                    ▼                                         │          │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ Results Storage (Durable Object / SQLite)                     │  │
│  │ - Test results                                               │  │
│  │ - Build logs                                                 │  │
│  │ - Timing metrics                                             │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Components:

1. **CI Agent (Beehive Worker)**:
   - Receives CI requests (from PR events, pushes, manual triggers)
   - Manages CI queue
   - Coordinates with Docker runners
   - Stores results in DO

2. **Docker Runner (Self-hosted)**:
   - Pulls git repo
   - Restores cache from R2
   - Runs CI commands (install, typecheck, test, build)
   - Saves cache to R2
   - Reports results to CI Agent

3. **Cache Storage (R2)**:
   - Stores node_modules tarballs
   - Stores build artifacts
   - Keyed by hash of dependencies

4. **Results Storage (DO/SQLite)**:
   - Test results
   - Build logs
   - Historical data

## Implementation Roadmap

### Phase 1: Basic Self-Hosted CI (1-2 weeks)
- [ ] Set up self-hosted GitHub Actions runners
- [ ] Configure runners to use Beehive for coordination
- [ ] Implement basic CI agent (queue management)
- [ ] Test with simple workflows

### Phase 2: Cache Layer (1 week)
- [ ] Implement R2-based cache storage
- [ ] Create cache key generation
- [ ] Test cache hit/miss scenarios
- [ ] Benchmark cache performance

### Phase 3: Full Beehive Integration (2-3 weeks)
- [ ] Move CI agent into Beehive worker
- [ ] Implement DO-based result storage
- [ ] Add CI status tracking to Beehive UI
- [ ] Support tournament-based CI (multiple agents run CI)

### Phase 4: Advanced Features (Ongoing)
- [ ] Parallel test execution
- [ ] Test flakiness detection
- [ ] Auto-rollback on CI failure
- [ ] CI-driven promotions

## Comparison: GitHub Actions vs Beehive CI

| Feature | GitHub Actions | Beehive CI |
|---------|---------------|------------|
| Hosting | GitHub | Self-hosted |
| Cost | Free for public, paid for private | Cloudflare costs |
| Speed | GitHub runners | Your hardware |
| Integration | Native | Beehive-native |
| Caching | Built-in | Custom (R2) |
| Parallelism | Built-in | Custom |
| Secrets | GitHub secrets | Cloudflare secrets |
| Visibility | GitHub UI | Beehive UI |

## Recommendations

1. **Start with hybrid approach**: Keep GitHub Actions for now, add Beehive coordination layer
2. **Implement caching first**: R2-based caching works regardless of CI platform
3. **Gradual migration**: Move one workflow at a time to Beehive CI
4. **Monitor costs**: Cloudflare Workers/R2 costs vs GitHub Actions costs
5. **Test thoroughly**: CI testing the CI system is critical

## Open Questions

1. How to handle long-running CI jobs (>30s CPU time)?
   - Answer: Use Durable Objects or external runners

2. How to provide build caching for Workers Builds?
   - Answer: Cloudflare doesn't expose this; we'd need our own caching layer

3. Should we run E2E tests on Beehive CI?
   - Answer: Not initially; start with unit tests and typecheck

4. How to handle failures in Beehive CI itself?
   - Answer: Fall back to GitHub Actions, alert maintainers

## Related Issues

- Issue #10: No CI clean-install build
  - Status: Addressed by `ci-enhanced.yml`
  - Beehive CI would make this inherent

- Migration tests gap
  - Status: Addressed by `migration-schema-validation.test.ts`
  - Beehive CI could run these automatically

## Conclusion

Running Beehive CI on Beehive itself is feasible but requires:
1. Self-hosted execution environment (Docker containers)
2. Custom caching layer (R2)
3. Gradual migration from GitHub Actions

The biggest wins would be:
- Better integration with Beehive's agent-native workflows
- Ability to use Beehive features (tournaments, gates) for CI
- Self-hosted flexibility

The biggest challenges are:
- Cloudflare Workers limitations for build execution
- Need to maintain two CI systems during transition
- Complexity of self-hosted infrastructure

**Recommendation**: Start with the hybrid approach, implement caching, and gradually increase Beehive CI responsibility as stability improves.
