# CLI Parity Fixes - Implementation Report

**Branch:** `agent/parity-cli-fixes`
**Date:** 2026-10-16
**Tasks:** 3, 4, 5 from docs/FEATURE-PARITY.md
**Commits:** b313d42 (Task 3), 4dd279a (Task 4), 94c960e (Task 5), 1615483 (docs)

See docs/OPEN-QUESTIONS.md section "CLI Parity Fixes - Implementation Findings" for detailed findings.

---

## Tasks Completed

### Task 3: Fix CLI request bodies/paths (b313d42)
- promotion create: added --from-rung/--to-rung required options
- trial decide: changed to winnerId/comparisonMetrics; added --comparison-metrics, --decided-by
- promotion get: removed (no /api/promotions/:id route exists)
- health extended: fixed path from /api/health to /health in api-client.ts:181

### Task 4: Register missing CLI options and implement create stubs (4dd279a)
- candidate, repo, spec, issue, trial, gate: added all required options using requiredOption()
- spec create: supports contract file reading via @ prefix
- Added tests/cli-smoke.test.ts

### Task 5: Remove dead CLI groups and debug client methods (94c960e)
- Removed workflow, deployment, environment from ENTITIES and registration
- Removed /api/debug/* client methods from api-client.ts

---

## Confirmation

All claims verified by grep against workers/api/index.ts and workers/spec-do/index.ts:
- No GET /api/promotions/:id route exists
- No /api/debug/* routes exist
- No workflow/deployment/environment routes exist
- CreatePromotionRequest requires fromRung, toRung
- DecideTrialRequest requires winnerId, comparisonMetrics

---

## Files Changed

**Task 3:** cli/src/commands/{promotion,trial}.ts, cli/src/types/api.ts, cli/src/utils/api-client.ts
**Task 4:** cli/src/commands/{candidate,repo,spec,issue,trial,gate}.ts, cli/src/types/api.ts, tests/cli-smoke.test.ts
**Task 5:** cli/src/index.ts, cli/src/types/definitions.ts, cli/src/utils/api-client.ts
**Docs:** docs/OPEN-QUESTIONS.md, docs/PARITY-CLI-FIXES-REPORT.md

---

## Commands Run and Results

```bash
# In cli/ directory
$ npm install
added 259 packages in 11s

$ npm run typecheck
> beehive-cli@0.1.0 typecheck
> tsc --noEmit
[No output = SUCCESS]

# In root directory  
$ npm install
added packages in 12s

$ npx tsc --noEmit
[No output = SUCCESS]

$ npx vitest run tests/cli-smoke.test.ts
 Test Files  1 passed (1)
      Tests  3 passed (3)

$ npx vitest run tests/unit
 Test Files  2 passed (2)
      Tests  15 passed (15)
```

All typechecks and relevant tests pass.
