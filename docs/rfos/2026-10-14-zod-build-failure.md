---
RFO-2026-10-14
---

# RFO: Zod Dependency Resolution Failure in Worker Builds

**Date:** 2026-10-14  
**Author:** Maintainer / Agent Team  
**Status:** Actioned  
**Severity:** SEV-2 (Build failures blocking deployment)  
**Related:** AGENTS.md#deployment-topology-ops, f847f75, RFC-0002 (Workers-Native Stores)

---

## Summary

The promotion, canary, and shadow-router worker builds failed due to **zod being unresolvable from workers/shared**. The issue was that worker-specific dependencies (like zod) in `workers/shared` could not be resolved during per-worker `npm install` because each worker was not properly configured with its own `package.json` or the shared package wasn't being installed.

---

## Timeline

| Time (UTC) | Event | Actor | Notes |
|------------|-------|-------|-------|
| ~2026-10-13 | Worker builds start failing with zod resolution errors | CI System | Builds for promotion, canary, shadow-router workers failing |
| ~2026-10-14 | Root cause identified: workers/shared dependencies not installed | Agent Team | Zod in shared wasn't available to worker builds |
| 2026-10-14 | Fix implemented (commit f847f75) | Agent Team | Added shared package.json + per-worker postinstall |
| 2026-10-14 | Verification complete | Agent Team | All worker builds passing |

### Key Moments

- **Detected:** CI build failures in promotion, canary, and shadow-router workers
- **Root Cause Identified:** Zod dependency in `workers/shared` was not resolvable during worker builds
- **Mitigated:** Added `workers/shared/package.json` and per-worker postinstall scripts
- **Resolved:** All worker builds successful

---

## Impact

### Affected Components

- `workers/beehive-promotion` - Promotion Worker
- `workers/beehive-canary` - Canary Worker
- `workers/beehive-shadow-router` - Shadow Router Worker
- `workers/shared` - Shared code with zod dependency

### User Impact

- **Affected Users:** All deployments blocked (no new promotions, canary deployments, or shadow traffic)
- **Impact Type:** Deployment pipeline broken, no new candidate progress
- **Duration:** Approximately 1 day
- **Severity:** SEV-2 (Significant degradation - deployment pipeline broken)

### Technical Impact

- Worker builds failed with module resolution errors
- Could not deploy updated versions of critical workers
- Existing deployed versions continued to work (no rollback needed)
- Blocked all new candidate promotions through the oracle ladder

---

## Root Cause Analysis

### Direct Cause

The workers (promotion, canary, shadow-router) import from `workers/shared`, which has a dependency on `zod`. During `npm install` in each worker directory, the `node_modules` tree didn't include zod because:
1. Each worker's `package.json` didn't list `workers/shared` as a dependency
2. `workers/shared` didn't have its own `package.json`
3. Zod was a transitive dependency that wasn't being hoisted properly

### Contributing Factors

1. **Missing package.json** - `workers/shared` directory lacked a `package.json` file
2. **No per-worker postinstall** - Workers didn't have postinstall scripts to ensure shared dependencies
3. **Build system assumption** - Assumed npm would hoist all dependencies automatically
4. **No build validation** - CI didn't catch this because it wasn't running clean installs per worker

### Root Cause

**Fundamental Issue:** The project's build system assumed that running `npm install` at the root would make all dependencies available to all workers, but per-worker builds (as done by Workers Builds) require each worker to have its dependencies explicitly available.

This is a deployment topology issue that falls under AGENTS.md rule #6: "Validation = Sandboxes via Workflows (Cloudflare CI SDK pattern). Deploys = Workers Builds."

---

## Detection

### Detection Method

**CI Build Failure** - Workers Builds failed during the build phase for promotion, canary, and shadow-router workers.

### Detection Delay

**Unknown, but caught during deployment attempt** - The issue was discovered when trying to deploy updated versions of the workers.

### Detection Improvements

To catch similar issues earlier:
- ✅ **Per-worker clean install** - CI now runs clean `npm install` in each worker directory
- ✅ **Postinstall scripts** - Added per-worker postinstall to ensure shared dependencies
- ✅ **Enhanced CI workflow** - Created `ci-enhanced.yml` to catch build/schema issues

---

## Response

### Initial Response

1. **Build Failure Alert** - CI system reported build failures
2. **Investigation** - Agent team traced the error to zod resolution from workers/shared

### Mitigation

**Commit f847f75:** "step: fix the promotion, canary and shadow-router builds (zod unresolvable from workers/shared): shared package.json + per-worker postinstall; record cause"

Changes:
- Added `workers/shared/package.json` with zod dependency
- Added per-worker `postinstall` scripts to copy or link shared dependencies
- Recorded the cause in commit message for future reference

### Resolution

- All three affected workers (promotion, canary, shadow-router) built successfully
- Deployments resumed
- No data loss or corruption (existing deployments were fine)

### Verification

- CI builds passing for all workers
- Manual deployment verification completed
- Added to AGENTS.md as a known pattern

---

## Lessons Learned

### What Went Well

✅ **Quick diagnosis** - Error message clearly pointed to zod resolution issue
✅ **Rapid fix** - Solution was implemented within hours
✅ **Complete fix** - Addressed root cause, not just symptoms
✅ **Documented cause** - Commit message records the root cause for future reference

### What Could Be Improved

⚠️ **Build system validation** - CI should have caught this earlier with per-worker clean installs
⚠️ **Dependency management** - Need better strategy for shared module dependencies
⚠️ **Documentation** - Build requirements should have been documented
⚠️ **Testing** - Unit tests didn't catch the missing dependencies

### Action Items

| ID | Description | Owner | Priority | Status | Due Date |
|----|-------------|-------|----------|--------|----------|
| RFO-2026-10-14-ZOD-AI-1 | Add per-worker package.json files | Agent Team | High | Done | 2026-10-14 |
| RFO-2026-10-14-ZOD-AI-2 | Add postinstall scripts to all workers | Agent Team | High | Done | 2026-10-14 |
| RFO-2026-10-14-ZOD-AI-3 | Add shared package.json | Agent Team | High | Done | 2026-10-14 |
| RFO-2026-10-14-ZOD-AI-4 | Enhance CI with per-worker clean install | Agent Team | High | Done | 2026-10-16 |
| RFO-2026-10-14-ZOD-AI-5 | Document build requirements | Maintainer | Medium | Not Started | TBD |

**Note:** Action items AI-1 through AI-4 were completed as part of the fix and follow-up work.

---

## Follow-up

### Related Findings

This RFO is related to:
- AGENTS.md rule #6: "Validation = Sandboxes via Workflows (Cloudflare CI SDK pattern). Deploys = Workers Builds."
- The creation of `ci-enhanced.yml` workflow to catch similar issues
- Multiple commits in the history referencing build and dependency issues

### Pattern Recognition

This is an example of **dependency resolution gaps** in distributed module structures. Similar issues could occur with:
- Other shared modules (not just workers/shared)
- Transitive dependencies in complex import chains
- Version mismatches between workers

### Preventive Measures Implemented

Based on this RFO, the following preventive measures were implemented:

1. **Per-worker package.json** - Each worker now has explicit dependency management
2. **Postinstall scripts** - Workers run postinstall to ensure shared dependencies are available
3. **Enhanced CI** - `ci-enhanced.yml` workflow performs clean per-worker installs
4. **AGENTS.md Documentation** - Added to deployment topology ops section

---

## Evidence

### Commit References

- **Fix:** [f847f75](https://github.com/bailey-coding/beehive/commit/f847f75) - Zod build fix
- **Enhanced CI:** [69c62aa](https://github.com/bailey-coding/beehive/commit/69c62aa) - Added enhanced CI workflow

### Code References

- `workers/shared/package.json` - Added shared package.json
- `workers/*/package.json` - Per-worker package files
- `workers/*/postinstall` scripts - Ensure shared dependencies
- `.github/workflows/ci-enhanced.yml` - Enhanced CI workflow

---

## References

- [RFC-0002: Workers-Native Stores Architecture](../rfcs/0002-workers-native-stores.md) - Storage architecture
- [AGENTS.md](../../AGENTS.md#deployment-topology-ops) - Deployment and build conventions
- [OPEN-QUESTIONS.md](../OPEN-QUESTIONS.md) - Build and deployment learnings
- [SETUP.md](../SETUP.md) - Local development setup

---

*This RFO documents a build failure caused by zod resolution issues in worker builds. The fix involved adding proper package.json files and postinstall scripts. This was a deployment topology issue that has since been addressed with enhanced CI validation.*
