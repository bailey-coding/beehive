# Agent Reviewer Guidelines

**Purpose**: Standardize code review quality across Mistral and Claude agents while improving token efficiency.

**Audience**: agent
**Category**: verification
**Status**: active

---

## 0. Quick Reference (Load This First)

### Beehive Architecture Invariants
- 10 Workers, one push deploys all, no order control
- Spec DO (SQLite) = coordination state source of truth
- Analytics Engine = metrics, D1 = cross-spec queries, Git notes = provenance only
- Always-pushed: no local-only work, intermediate → scratch/*
- Fail-closed: missing auth → 503, wrong bearer → 401

### Oracle Ladder
| Rung | Traffic | Oracle | Failure |
|------|---------|--------|---------|
| Pre-merge | none | tests, spec conformance | never board train |
| Shadow | mirrored, discarded | Scientist diff | hold, iterate |
| Train | projection slice | combined-candidate conformance | drop car |
| Canary | small % live | SLOs (Statsig + AE) | auto-rollback |
| Full | 100% | drift, holdouts | alarm, bisect |

---

## 1. Review Structure Template

```markdown
# Review: [Title]

**Task**: [id] | **Spec**: [path] §[section] | **Date**: YYYY-MM-DD
**Subject**: `origin/branch...origin/branch` ([short commit range])
**Reviewer**: [agent/model] | **Confidence**: [0-1]

## Findings

### Blockers
- **[B1]** [One-sentence description] ([file:line])

### Should-fix
- **[S1]** [Description] ([file:line])

### Nits
- **[N1]** [Description]

## Verified Correct
- [ ] [Claim with evidence]

## Runs
- `npm run typecheck`: [result]
- `npm test`: [result]
- Local e2e: [result]

## Verdict
**Approve with changes.** [Rationale]. Merge-readiness: [status].
```

---

## 2. Review Checklists

### Security
- [ ] Origin check before every DO read
- [ ] Session validation before data access
- [ ] Authorization boundaries correct (master vs. user vs. service)
- [ ] No sensitive data in logs or responses
- [ ] CSP headers present and correct
- [ ] Cross-origin POST reads only `/api/actors` (verify with probe test)

### Migration Safety
- [ ] Additive only: no DELETE/DROP/ALTER on tables old code uses
- [ ] New columns: nullable or have defaults
- [ ] Unknown schema_version: handled gracefully (throw or ignore)
- [ ] Old code compatibility: unknown routes → 404, not 500
- [ ] Rollback path: verified with scratch test
- [ ] ORG_PURGE_ORDER never hard-deletes actors

### Test Coverage
- [ ] Every write route has authorization test
- [ ] Cross-origin behavior tested
- [ ] Error paths: 400, 401, 403, 404, 500 all covered
- [ ] Mutation testing: critical paths have kill tests
- [ ] Mixed-version: old/new combinations verified
- [ ] Test gap identification: explicitly name missing coverage

### Mixed-Version Matrix
Check every combination:
- [ ] New UI + old DO
- [ ] Old UI + new DO
- [ ] New edge + old DO
- [ ] Old edge + new DO
- [ ] Rollback scenarios (B→A, A→B)

Each must fail-closed, not fail-open.

---

## 3. Beehive-Specific Knowledge

### Worker Structure
- `workers/api/`: Edge routes (ui.ts, index.ts)
- `workers/spec-do/`: Durable Object (SQLite coordination)
- `workers/promotion-worker/`: Train automation
- `ui/`: React components (NOT built/deployed)
- `tests/`: Unit and e2e tests

### Critical Paths
- `/api/actors`: Session check, origin verification
- `/api/actors/:id`: By-id lookup (same projection as list)
- `ensureActor`: Filter by `github_user_id`, create if missing
- `init()`: Schema version check, migrations
- `authorize()`: Token verification, scope checking

### Test Commands
```bash
npm run typecheck           # TypeScript check
npm test                    # Unit tests (38 files, 870+ tests)
npm run test:e2e:local     # Local e2e (start workers first)
```

### Common Gotchas
- Service bindings: `binding = "..."`, **never** `name = "..."`
- Queue consumers: `[[queues.consumers]]`, not `[[queues]]`
- `init()` must rethrow on migration failure (full outage acceptable)
- Line numbers in `spec-do/index.ts` drift; update references
- `ORG_PURGE_ORDER` never hard-deletes actors
- One push deploys all ten workers at once, in no controllable order
- Mutation testing: "Mutation: [change X]. All N tests still pass"

### Non-negotiable Architectural Rules (from AGENTS.md)
1. TypeScript everywhere (Zig→WASM only for profiled CPU-bound kernels)
2. Orchestration spine is hand-written
3. Fork, don't contend
4. Coordination state lives in Workers-native stores, never in the repo
5. The always-pushed invariant
6. No external CI
7. Rollback is a ref operation

---

## 4. Token Efficiency Guidelines

### DO:
- Reference `path:line` instead of pasting code
- Use structured template (load from file, don't regenerate)
- State facts with minimal prose
- Batch related findings
- Use checklists for verification
- Quantify everything: "3 of 7 tests failed" not "some tests failed"
- Trace the flow: "POST /api/actors → GET /api/actors → .find → newest wins"

### DON'T:
- Restate the spec (link to it)
- Explain basic concepts (assume reviewer knowledge)
- Write narrative prose (facts only)
- Repeat the same analysis in multiple places
- Paste full stack traces or file contents

---

## 5. Quality Bar

**Blocker**: Security violation, data corruption risk, broken invariant, fail-open behavior
**Should-fix**: Missing test coverage, performance regression, tech debt, incomplete implementation
**Nit**: Style, cosmetic, minor improvement, documentation typo

**Merge-readiness**: All blockers fixed, should-fix addressed or acknowledged, tests pass

---

## 6. Examples from Archived Reviews

### Pattern: Mutation Testing (from M9-NAV-CODE-REVIEW.md)
```
Mutation: change `isAppHref(c.href) ?` to `c.href ?` in renderBreadcrumbs.
All 320 workers/api tests still pass.
The test "accepts only /app hrefs" exercises `isAppHref` alone.
Fix: render appPage with crumbs {label:'x', href:'javascript:alert(1)'} and assert.
```

### Pattern: Invariant Verification (from M12-PRA-REVIEW.md)
```
Verified: T0 session check → GET /api/actors → .find returns newest.
Old DO ignores filter but still returns newest (fallback matches).
No fail-open path exists.
```

### Pattern: Mixed-Version Analysis (from M12-IMPL-PLAN-REVIEW.md)
```
New UI + old DO: by-id route exists, filter ignored, .find sees 500 newest.
Old UI + new DO: no filter sent, unchanged.
Rollback B→A: bh_usr_ gives 401, user_tokens sits idle, A ignores it.
```

---

*This document extracts patterns from archived Claude reviewer agents (f4831168-4c7d-4b67-8f1c-18bac651310c, a4a7d0fb-9dc7-434e-9c38-9e723a5be85c) and review documents (M12-PRA-REVIEW.md, M12-IMPL-PLAN-REVIEW.md, M9-NAV-CODE-REVIEW.md).*
