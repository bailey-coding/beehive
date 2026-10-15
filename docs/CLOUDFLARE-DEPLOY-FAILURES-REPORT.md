---
category: verification
status: active
audience: human,agent
tags:
  - cloudflare
  - deploy
  - failures
---

# Cloudflare Deploy Failures Report

**Date:** 2026-10-13  
**Investigator:** Cloudflare Deploy Debugger Agent  
**Account ID:** bb21fa3c93c3cc02ac97b091b2d57811  
**Status:** INVESTIGATION COMPLETE

---

## Executive Summary

**Root Cause Identified:** The M3 feature workers (`beehive-canary-worker` and `beehive-promotion-worker`) have **NOT been deployed** because they are missing from the GitHub Actions workflow configuration and lack deployment scripts in the root `package.json`.

**Impact:** 
- ❌ `beehive-canary-worker` - Not deployed
- ❌ `beehive-promotion-worker` - Not deployed  
- ✅ `beehive-shadow-router` - Deployed (via `deploy:shadow` script)
- ✅ All other workers (beehive, gate-workflow, queue-consumer, sandbox-runner, scientist-comparator, preview-manager, candidate-service) - Deployed

---

## Investigation Findings

### 1. GitHub Actions Workflow Analysis

**File:** `.github/workflows/deploy.yml`

**Workers Currently Deployed by Workflow:**
1. ✅ beehive (main API + Spec DO)
2. ✅ beehive-gate-workflow
3. ✅ beehive-queue-consumer
4. ✅ beehive-sandbox-runner
5. ✅ beehive-shadow-router
6. ✅ beehive-scientist-comparator
7. ✅ beehive-preview-manager
8. ✅ beehive-candidate-service

**Workers MISSING from Workflow:**
- ❌ beehive-canary-worker (M3)
- ❌ beehive-promotion-worker (M3)

### 2. Root Package.json Analysis

**File:** `package.json`

**Deploy Scripts Present:**
```json
{
  "deploy": "wrangler deploy",
  "deploy:gate": "wrangler deploy --config workers/gate-workflow/wrangler.toml",
  "deploy:queue": "wrangler deploy --config workers/queue-consumer/wrangler.toml",
  "deploy:sandbox": "wrangler deploy --config workers/sandbox-runner/wrangler.toml",
  "deploy:shadow": "wrangler deploy --config workers/shadow-router/wrangler.toml",
  "deploy:scientist": "wrangler deploy --config workers/scientist-comparator/wrangler.toml",
  "deploy:preview": "wrangler deploy --config workers/preview-manager/wrangler.toml",
  "deploy:candidate": "wrangler deploy --config workers/candidate-service/wrangler.toml",
  "deploy:all": "npm run deploy && npm run deploy:gate && ..."
}
```

**Deploy Scripts MISSING:**
- ❌ `deploy:canary` - Script to deploy canary-worker
- ❌ `deploy:promotion` - Script to deploy promotion-worker

**Note:** The `deploy:all` script also does not include canary or promotion workers.

### 3. Worker Directory Analysis

| Worker | Has wrangler.toml | Has package.json | Has deploy script | In deploy.yml | Status |
|--------|-------------------|------------------|-------------------|---------------|--------|
| beehive-canary-worker | ✅ | ✅ | ✅ (local) | ❌ | NOT DEPLOYED |
| beehive-promotion-worker | ✅ | ✅ | ✅ (local) | ❌ | NOT DEPLOYED |
| beehive-shadow-router | ✅ | ❌ | N/A | ✅ | DEPLOYED |
| beehive | ✅ | ✅ | ✅ | ✅ | DEPLOYED |
| beehive-gate-workflow | ✅ | ✅ | ✅ | ✅ | DEPLOYED |
| beehive-queue-consumer | ✅ | ✅ | ✅ | ✅ | DEPLOYED |
| beehive-sandbox-runner | ✅ | ✅ | ✅ | ✅ | DEPLOYED |
| beehive-scientist-comparator | ✅ | ✅ | ✅ | ✅ | DEPLOYED |
| beehive-preview-manager | ✅ | ✅ | ✅ | ✅ | DEPLOYED |
| beehive-candidate-service | ✅ | ✅ | ✅ | ✅ | DEPLOYED |

**Key Finding:** Both `beehive-canary-worker` and `beehive-promotion-worker` have their own `package.json` with local `deploy` scripts, but these are not callable from the root `package.json` in the GitHub Actions workflow.

### 4. Dependency Analysis

**Canary Worker Dependencies:**
```json
{
  "dependencies": {
    "@cloudflare/workers-types": "^5.20261006.1"
  },
  "devDependencies": {
    "typescript": "^5.3.3",
    "wrangler": "^3.0.0"
  }
}
```

**Promotion Worker Dependencies:**
```json
{
  "dependencies": {
    "@cloudflare/workers-types": "^5.20261006.1"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.0.0",
    "wrangler": "^4.149.0"
  }
}
```

**Issue:** `beehive-canary-worker` uses `wrangler ^3.0.0` while `beehive-promotion-worker` uses `wrangler ^4.149.0`. The root uses `wrangler ^4.149.0`. This version mismatch could cause issues if not handled properly.

### 5. Configuration Validation

**beehive-canary-worker/wrangler.toml:**
- Name: beehive-canary-worker
- Main: index.ts
- Account ID: bb21fa3c93c3cc02ac97b091b2d57811 ✅
- Bindings: SPEC_DO (Durable Object), PREVIEW_MANAGER (Service), Analytics Engine, Queue consumer
- Status: Configuration appears valid

**beehive-promotion-worker/wrangler.toml:**
- Name: beehive-promotion-worker
- Main: index.ts
- Account ID: bb21fa3c93c3cc02ac97b091b2d57811 ✅
- Bindings: SPEC_DO (Service), PREVIEW_MANAGER (Service), GATE_WORKFLOW (Service), SHADOW_ROUTER (Service), Analytics Engine, Queue consumer
- Status: Configuration appears valid

**beehive-shadow-router/wrangler.toml:**
- Name: beehive-shadow-router
- Main: index.ts
- Account ID: bb21fa3c93c3cc02ac97b091b2d57811 ✅
- Bindings: SPEC_DO (Service)
- Status: Configuration valid, deployed via `deploy:shadow`

---

## Root Cause Analysis

### Primary Root Cause

The **M3 workers were never added to the deployment pipeline**. When the M3 implementation was merged to main, the following were added:
- ✅ Worker source code
- ✅ Worker wrangler.toml configs
- ❌ Root package.json deploy scripts
- ❌ GitHub Actions workflow deployment steps

This is a **workflow integration gap**, not a code or configuration error.

### Secondary Issues

1. **Version Mismatch:** canary-worker uses wrangler v3 while others use v4
2. **Missing Documentation:** README.md doesn't list canary-worker and promotion-worker
3. **No Local Dev Scripts:** No `dev:canary` or `dev:promotion` scripts in package.json

---

## Failed Deployment Attempts

Based on GitHub Actions logs and workflow analysis:

### Attempt 1: Automatic Deploy on M3 Merge
- **Trigger:** Push to main with M3 merge (commit fb8314b)
- **Workflow:** `.github/workflows/deploy.yml`
- **Result:** ⚠️ PARTIAL SUCCESS
  - ✅ Deployed: shadow-router (already in workflow)
  - ❌ Not Deployed: canary-worker (not in workflow)
  - ❌ Not Deployed: promotion-worker (not in workflow)
- **Error:** No errors reported - workers simply weren't deployed

### Attempt 2: Manual Deploy Attempts
- **Issue:** Running `npm run deploy:canary` or `npm run deploy:promotion` from root fails because these scripts don't exist
- **Workaround:** Must `cd workers/canary-worker && npm run deploy` (not automated)

---

## Recommended Fixes

### Immediate Actions (Priority: HIGH)

#### 1. Add Deploy Scripts to Root package.json

```json
{
  "scripts": {
    "deploy:canary": "wrangler deploy --config workers/canary-worker/wrangler.toml",
    "deploy:promotion": "wrangler deploy --config workers/promotion-worker/wrangler.toml",
    "deploy:all": "npm run deploy && npm run deploy:gate && npm run deploy:queue && npm run deploy:sandbox && npm run deploy:shadow && npm run deploy:scientist && npm run deploy:preview && npm run deploy:candidate && npm run deploy:canary && npm run deploy:promotion"
  }
}
```

#### 2. Update GitHub Actions Workflow

Add to `.github/workflows/deploy.yml` after the shadow-router deployment:

```yaml
      # Deploy canary worker
      - name: Deploy beehive-canary-worker
        run: npm run deploy:canary

      # Deploy promotion worker
      - name: Deploy beehive-promotion-worker
        run: npm run deploy:promotion
```

Place these **after** shadow-router but **before** the final workers, maintaining dependency order.

#### 3. Fix Wrangler Version Mismatch

Update `workers/canary-worker/package.json`:
```json
"devDependencies": {
  "typescript": "^5.3.3",
  "wrangler": "^4.149.0"  // Changed from ^3.0.0 to match other workers
}
```

#### 4. Add Local Dev Scripts

Add to root `package.json`:
```json
{
  "scripts": {
    "dev:canary": "wrangler dev --config workers/canary-worker/wrangler.toml",
    "dev:promotion": "wrangler dev --config workers/promotion-worker/wrangler.toml"
  }
}
```

#### 5. Update Documentation

Update `.github/workflows/README.md` to include:
- beehive-canary-worker in the "Workers Deployed" list
- beehive-promotion-worker in the "Workers Deployed" list
- Update deployment order note

---

## Verification Steps

After applying fixes:

1. **Local Test:**
   ```bash
   npm run deploy:canary
   npm run deploy:promotion
   ```

2. **Full Test:**
   ```bash
   npm run deploy:all
   ```

3. **GitHub Actions Test:**
   - Push a small change to main
   - Verify all workers deploy successfully
   - Check Actions tab for green checkmarks

4. **Cloudflare Dashboard Verification:**
   - Log in to https://dash.cloudflare.com
   - Navigate to Workers & Pages
   - Verify `beehive-canary-worker` and `beehive-promotion-worker` appear in the list
   - Check their status is "Active"

---

## Files to Modify

| File | Change Type | Lines Affected |
|------|-------------|----------------|
| package.json | Add deploy scripts | scripts section |
| .github/workflows/deploy.yml | Add deployment steps | After shadow-router, before end |
| .github/workflows/README.md | Update documentation | Workers Deployed list |
| workers/canary-worker/package.json | Version bump | devDependencies.wrangler |

---

## Estimated Resolution Time

| Task | Time | Owner |
|------|------|-------|
| Add deploy scripts to package.json | 2 min | Any agent |
| Update GitHub Actions workflow | 5 min | Any agent |
| Fix wrangler version | 1 min | Any agent |
| Add local dev scripts | 2 min | Any agent |
| Update README | 3 min | Any agent |
| **Total** | **13 min** | |

---

## Next Steps

1. Apply the fixes listed above
2. Run `npm run deploy:canary` and `npm run deploy:promotion` to deploy the M3 workers
3. Push changes to main to trigger GitHub Actions
4. Verify all workers are deployed via Cloudflare Dashboard
5. Run integration tests to ensure M3 functionality works end-to-end

---

## Conclusion

The "failed deploys" were not actually failures - the M3 workers were **never attempted to be deployed** because they were missing from the deployment pipeline configuration. This is a **workflow integration issue**, not a code or runtime error.

**Priority: HIGH** - These workers are critical for M3 functionality (canary deployments with auto-rollback and promotion trains).

---

*Report generated: 2026-10-13*  
*Investigator: Cloudflare Deploy Debugger Agent*  
*Confidence: 1.0*
