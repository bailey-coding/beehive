# Repo Cleanup Implementation Notes

> **Task:** repo-cleanup · **Spec:** `docs/FOCUS.md#3`
> **Branch:** `repo-cleanup`
> **Date:** 2026-10-14
> **Implementer:** Vibe Code (IMPLEMENTER)

---

## Summary of Changes

This document records what was changed, the final verification numbers, and what was deferred.

---

## Changes Made

### 1. Lint Configuration Fix (R1)
- **File:** `package.json`
  - Pinned `@eslint/js` to `^9.39.5` (not latest/^10) to prevent ERESOLVE errors with eslint 9
  - Quoted the lint glob: `"lint": "eslint 'workers/**/*.ts'"`
- **File:** `eslint.config.js`
  - Added `'no-undef': 'off'` to rules (type-aware checking handled by TypeScript)
  - Removed `parserOptions.project` (was causing parse errors in test files)
- **File:** `workers/scientist-comparator/delta-surface/matcher.ts`
  - Wrapped `parameterized` case body in `{ }` (lines ~164-171)
  - Wrapped `wildcard` case body in `{ }` (lines ~169-173)
- **File:** `workers/scientist-comparator/utils/helpers.ts`
  - Removed duplicate `return result as T & U;` (line ~176)
- **File:** `.eslintrc.cjs`
  - Deleted (ESLint 9 uses flat config only, file was ignored)

**Verification:** `npm install` succeeds from clean node_modules, `npm run lint` exits 0.

### 2. Queue Consumer Fail-Closed (R3)
- **File:** `workers/queue-consumer/index.ts`
  - Removed `|| 'dev-local-spike-token'` fallback from Authorization header (line 318)
  - Added fail-closed check before gate trigger: if `!env.API_AUTH_TOKEN`, log error and `continue`
  - Kept line 182's `|| ''` pattern (accepted per review)

**Grep verification:** No `dev-local-spike-token` strings remain in `workers/` directory.

### 3. Documentation Updates

#### README.md
- Components table: Added all 10 workers (shadow-router, scientist-comparator, preview-manager, candidate-service, canary-worker, promotion-worker)
- Deployment section: Changed to "push to `main`; `.github/workflows/deploy.yml` deploys all 10 workers automatically"
- Added full list of `wrangler secret put API_AUTH_TOKEN` for all 10 workers
- Local Development: Changed `cp .dev.vars.example .dev.vars` to "create `.dev.vars`" (file doesn't exist)
- Current Status: Updated M3 to ✅ Complete (2026-10-13), M4 date to 2026-10-14
- Updated "All 4 workers" → "All 10 workers" in recent progress
- Storage Layers: Noted D1 as "planned, not yet bound"

#### docs/ARCHITECTURE.md
- Added Component Details for M2/M3 workers (sections 6-11):
  - Shadow Router
  - Scientist Comparator
  - Preview Manager
  - Candidate Service
  - Canary Worker
  - Promotion Worker
- Rewrote Service Interactions section (lines ~530-650) to match real wrangler configs:
  - Corrected Spec DO binding patterns (same-script vs cross-script)
  - Noted exception: shadow-router has no SPEC_DO, promotion-worker uses service binding
  - Removed incorrect SANDBOX_RUNNER service binding example
  - Fixed queue producer form to `[[queues.producers]]` (not `[[queues]]`)
  - Fixed queue consumer form (no binding parameter)
  - Added real examples from all worker configs
- Storage Layers: Noted D1 as "planned, not yet bound"

#### docs/FOCUS.md
- Tests row: Changed from "plus integration/E2E" to "10/10 workers with unit tests; `tests/e2e` are mock-based scenario tests"

#### docs/OPEN-QUESTIONS.md
- Added 2026-10-14 findings section: Worker-to-worker auth findings
  - Documented unauthenticated service-binding calls from canary and promotion workers
  - Documented relative URL issue in DO-stub fetches
  - Noted these calls fail today but don't affect the demo video

### 4. File Removals
- **File:** `create-repo.js` (tracked despite `.gitignore` entry)
- **File:** `.github/workflows/deploy.yml.backup` (stale copy, unreferenced)

**Verification:** Neither file is referenced by any Workflow, Queue consumer, edge router, `deploy.yml`, or `wrangler.toml`. Only doc references remain (in plan/review files).

### 5. Test File Cleanup
- **File:** `tests/integration/bindings.test.ts` (deleted per D1)
  - Rationale: Only tested in-file mocks, no real worker code
  - Real failures: `JSON.parse` on request stream (×23), auth-less mocks (×3)
  - No real coverage lost: every per-worker suite imports real code
  - Test count: 380 → 323 total

---

## Final Verification Numbers

| Check | Result | Notes |
|-------|--------|-------|
| `npm install` | ✅ Pass | Clean node_modules test passed |
| `npm run typecheck` | ✅ Pass | 0 errors |
| `npm run lint` | ✅ Pass | 0 errors |
| `npm test` | ⚠️ 2 failed / 321 passed (323 total) | 2 failures in `workers/api/tests/api.test.ts` (DEFFERED) |
| Hardcoded tokens in workers | ✅ None | `git grep` for `dev-local-spike-token` returns nothing |
| Tracked env files | ✅ None | Only `.env.example` tracked |
| Removed files unreferenced | ✅ Confirmed | No functional references to `create-repo.js` or `deploy.yml.backup` |

---

## Deferred Work

### API Test Bugs (Task 10)
**Status:** DEFERRED - Cannot fix until m6-semantic-dashboard and service-accounts branches merge to main

**Files:** `workers/api/tests/api.test.ts`

**Issues:**
1. Line 141: `JSON.parse(callArgs[0] as string)` where `callArgs[0]` is a `Request` object
   - Fix: Assert `(callArgs[0] as Request).method` and `.headers.get('Content-Type')`
2. Line 578: Mock omits `timestamp` field from DO error envelope
   - Fix: Add `timestamp: Date.now()` to mocked DO response (line 561-564)

**Impact:** These are pre-existing test bugs, not introduced by this cleanup. Will be addressed after rebase on main once other branches merge.

### Sandbox/Queue Randomness (D3, R5)
**Status:** DEFERRED per D3/R5 - Leave code unchanged until after video recording

**Files:**
- `workers/sandbox-runner/index.ts:396` (30% push rejection)
- `workers/gate-workflow/index.ts:789-790` (10% warning)

**Rationale:** Nothing reaches these paths in the demo flow. Changing deployed behavior on recording day provides no benefit and introduces risk.

### Health Check Script (R2)
**Status:** NOT TOUCHED per R2

**File:** `scripts/health-check.sh`

**Rationale:** service-accounts agent rewrites this script. Coordinate with that agent or drop edits to avoid conflicts.

---

## Commit History

This work was committed in multiple small steps following the always-pushed invariant:

1. Lint config + scientist-comparator fixes
2. Queue-consumer fail-closed
3. README.md updates
4. ARCHITECTURE.md updates  
5. File removals (create-repo.js, deploy.yml.backup)
6. FOCUS.md correction + OPEN-QUESTIONS.md addition
7. Test file cleanup (bindings.test.ts deletion)

Each commit follows format: `step: <desc> | task: repo-cleanup | spec: FOCUS.md#3 | confidence: <0-1>`

---

## Files Modified

- `package.json`
- `eslint.config.js`
- `workers/scientist-comparator/delta-surface/matcher.ts`
- `workers/scientist-comparator/utils/helpers.ts`
- `workers/queue-consumer/index.ts`
- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/FOCUS.md`
- `docs/OPEN-QUESTIONS.md`

## Files Deleted

- `.eslintrc.cjs`
- `create-repo.js`
- `.github/workflows/deploy.yml.backup`
- `tests/integration/bindings.test.ts`

---

## Notes

- D1 commit body explicitly states: file tests only in-file mocks; real failures were JSON parsing bug and requests sent without auth; no real coverage lost because every per-worker suite imports real worker code
- D2: Kept e2e tests; only corrected FOCUS.md Tests row
- D3/D4/D5: Not applicable per Bailey's decisions
- R1: Pinned @eslint/js to ^9.39.5 to prevent breaking deploy.yml's `npm install`
- R2: Did not edit scripts/health-check.sh (service-accounts owns it)
- R3: Queue-consumer now fails closed (log error, skip message, no retry)
- R4: ARCHITECTURE.md Service Interactions rewritten from actual wrangler.toml files
- R6: Corrected D1 rationale and D2 target
- R7: Documented worker-to-worker auth issue without fixing it
