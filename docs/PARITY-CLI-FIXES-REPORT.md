# CLI Parity Fixes - Implementation Report

**Branch:** `agent/parity-cli-fixes`  
**Date:** 2026-10-16  
**Tasks:** 3, 4, 5 from docs/FEATURE-PARITY.md  
**Commits:** b313d42 (Task 3), 4dd279a (Task 4), 94c960e (Task 5)

See docs/OPEN-QUESTIONS.md "CLI Parity Fixes - Implementation Findings" for detailed findings.

---

## Tasks Completed

### Task 3: Fix CLI request bodies/paths (b313d42)
- promotion create: added --from-rung/--to-rung required options
- trial decide: changed to winnerId/comparisonMetrics; added --comparison-metrics, --decided-by
- promotion get: removed (no /api/promotions/:id route)
- health extended: fixed path from /api/health to /health in api-client.ts line 181

### Task 4: Register missing CLI options and implement create stubs (4dd279a)
- candidate, repo, spec, issue, trial, gate: added all required --* options
- spec create: supports contract file reading via @ prefix
- Added cli/src/tests/cli-smoke.test.ts

### Task 5: Remove dead CLI groups and debug client methods (94c960e)
- Removed workflow, deployment, environment from ENTITIES and registration
- Removed /api/debug/* client methods from api-client.ts

---

## Confirmation

All claims verified by grep against workers/api/index.ts and workers/spec-do/index.ts:
- No /api/promotions/:id route exists
- No /api/debug/* routes exist  
- No workflow/deployment/environment routes exist
- CreatePromotionRequest requires fromRung, toRung
- DecideTrialRequest requires winnerId, comparisonMetrics

---

## Test Results

See detailed results below in Final Commands Run section.

---

## Files Changed

**Task 3:** cli/src/commands/{promotion,trial}.ts, cli/src/types/api.ts, cli/src/utils/api-client.ts
**Task 4:** cli/src/commands/{candidate,repo,spec,issue,trial,gate}.ts, cli/src/types/api.ts, cli/src/tests/cli-smoke.test.ts  
**Task 5:** cli/src/index.ts, cli/src/types/definitions.ts, cli/src/utils/api-client.ts
**Docs:** docs/OPEN-QUESTIONS.md, docs/PARITY-CLI-FIXES-REPORT.md

---

## Final Commands Run

[To be populated after running tests]
