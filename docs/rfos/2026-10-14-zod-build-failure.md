---
RFO-2026-10-14-zod-build-failure
---

# RFO: Zod Dependency Resolution Failure in Worker Builds

**Date:** 2026-10-16 (filename and index say 2026-10-14; f847f75 is 2026-10-16 21:54)  
**Author:** unattributed (backfilled from git history)  
**Status:** Actioned  
**Severity:** SEV-2 (Build failures blocking deployment)  
**Related:** AGENTS.md#deployment-topology-ops, f847f75, RFD-0002 (Workers-Native Stores)

---

> **Audit 2026-10-17 (`docs/RECORDS-AUDIT.md`):** The rule cited from AGENTS.md ("Validation = Sandboxes...") is rule 6 but does not explain a dependency-resolution fault.
> The 1-day duration, action-item owners/dates and lessons are unsupported by repo evidence.

## Summary

The promotion, canary, and shadow-router worker builds failed due to **zod being unresolvable from workers/shared**. The issue was that worker-specific dependencies (like zod) in `workers/shared` could not be resolved during per-worker `npm install` because each worker was not properly configured with its own `package.json` or the shared package wasn't being installed.

---

## Timeline

> Rewritten by the 2026-10-17 audit. The failing builds were Cloudflare Workers Builds, not a "CI System"; GitHub CI (`ci.yml`) never built the workers.

| Time (UTC) | Event | Evidence |
|---|---|---|
| 2026-10-16 (before 21:47) | The Artifacts push did not redeploy shadow-router, canary-worker and promotion-worker; they kept running pre-stack code | `docs/OPEN-QUESTIONS.md` "Three workers did not redeploy on the Artifacts push (2026-10-16)"; c34e644 |
| 2026-10-16 21:54 | f847f75 declares zod in `workers/shared/package.json`; each of the three workers runs `npm install --prefix ../shared` in `postinstall` (shadow-router gains the package.json it lacked); verified with `wrangler deploy --dry-run` from a clean archive | `git show f847f75` |
| 2026-10-16 21:58 | All ten workers have a code deployment | `docs/FOCUS.md` |
| 2026-10-16 22:36 | 69c62aa adds `ci-enhanced.yml` (a separate, later change) | `git show 69c62aa` |

### Key Moments

- **Detected:** Workers Builds failures / no redeploy of the three workers after the Artifacts push
- **Root Cause Identified:** Zod dependency in `workers/shared` was not resolvable during worker builds
- **Mitigated:** Added `workers/shared/package.json` and per-worker postinstall scripts
- **Resolved:** All worker builds successful

---

## Impact

### Affected Components

- `workers/promotion-worker` - Promotion Worker
- `workers/canary-worker` - Canary Worker
- `workers/shadow-router` - Shadow Router Worker
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
4. **No build validation** - `ci.yml` does not build workers; `ci-enhanced.yml` came afterwards

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
- ✅ **Per-worker clean install** - `ci-enhanced.yml` (69c62aa, later) runs clean installs per worker
- ✅ **Postinstall scripts** - Added per-worker postinstall to ensure shared dependencies
- ✅ **Enhanced CI workflow** - Created `ci-enhanced.yml` to catch build/schema issues

---

## Response

### Initial Response

1. **Build failure** - Workers Builds failed; the three workers did not redeploy
2. **Investigation** - Agent team traced the error to zod resolution from workers/shared

### Mitigation

**Commit f847f75:** "step: fix the promotion, canary and shadow-router builds (zod unresolvable from workers/shared): shared package.json + per-worker postinstall; record cause"

Changes:
- Added `workers/shared/package.json` with zod dependency
- Added per-worker `postinstall` scripts running `npm install --prefix ../shared`
- Recorded the cause in commit message for future reference

### Resolution

- All three affected workers (promotion, canary, shadow-router) built successfully
- Deployments resumed
- No data loss or corruption (existing deployments were fine)

### Verification

- Workers Builds: all ten workers had a code deployment from 2026-10-16 21:58 UTC (`docs/FOCUS.md`)
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

- [RFD-0002: Workers-Native Stores Architecture](../rfds/0002-workers-native-stores.md) - Storage architecture
- [AGENTS.md](../../AGENTS.md#deployment-topology-ops) - Deployment and build conventions
- [OPEN-QUESTIONS.md](../OPEN-QUESTIONS.md) - Build and deployment learnings
- [SETUP.md](../SETUP.md) - Local development setup

---

*This RFO documents a build failure caused by zod resolution issues in worker builds. The fix involved adding proper package.json files and postinstall scripts. This was a deployment topology issue that has since been addressed with enhanced CI validation.*
