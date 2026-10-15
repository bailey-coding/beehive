---
category: deprecated
status: deprecated
audience: human
tags:
  - review-needed
---

# Type Cleanup Plan: Remove `any` Types

## Overview

This plan outlines the steps to remove all `any` type annotations from the codebase and replace them with proper, explicit types. This improves type safety, IDE support, and code maintainability.

## Current State

As of the latest scan, there are **75+ occurrences** of `any` across the following files:

- `workers/spec-do/index.ts`: ~50+ occurrences (majority)
- `workers/api/index.ts`: 3 occurrences
- `workers/sandbox-runner/index.ts`: 3 occurrences
- `workers/queue-consumer/index.ts`: 2 occurrences
- `workers/gate-workflow/index.ts`: 3 occurrences
- Test files: ~10+ occurrences (lower priority)

## Phase 1: High-Priority - Core Files

### 1. `workers/spec-do/index.ts` (50+ occurrences)

The main Durable Object contains the most `any` usages. Fix in this order:

#### A. Return Types (Lines: 227, 1411, 1425, 1439, 1453, 1463, 1492, 1526, 1560, 1572, 1593, 1601, 1622, 1656, 1666, 1678, 1694, 1706, 1731, 1752)

**Action**: Replace `(): any` with proper interface return types.

| Method | Current | Replace With |
|--------|---------|--------------|
| `getOrganization` | `any` | `OrganizationRow \| null` |
| `listOrganizations` | `any[]` | `OrganizationRow[]` |
| `listActors` | `any[]` | `ActorRow[]` |
| `getRepository` | `any` | `RepositoryRow \| null` |
| `listRepositories` | `any[]` | `RepositoryRow[]` |
| `listSpecs` | `any[]` | `SpecRow[]` |
| `listCandidates` | `any[]` | `CandidateRow[]` |
| `listGateVerdicts` | `any[]` | `GateVerdictRow[]` |
| `getGateVerdictsForCandidate` | `any[]` | `GateVerdictRow[]` |
| `listTrials` | `any[]` | `TrialRow[]` |
| `listPromotions` | `any[]` | `PromotionRow[]` |
| `listIssues` | `any[]` | `IssueRow[]` |
| `getIssue` | `any` | `IssueRow \| null` |
| `listIssueComments` | `any[]` | `IssueCommentRow[]` |
| `getEntityHistory` | `any[]` | `EntityHistoryRow[]` |
| `createIssueSpecLink` | `any` | `IssueSpecLinkRow` |
| `createIssueCandidateLink` | `any` | `IssueCandidateLinkRow` |
| `createIssueComment` | `any` | `IssueCommentRow` |

#### B. Request Body Types (Lines: 771, 807, 840, 862, 907, 968, 981, 1023, 1036, 1077, 1117, 1130, 1158, 1201, 1211, 1225, 1250, 1263, 1295, 1344)

**Action**: Replace `const body: any = await request.json()` with proper types from `../api/types.ts`.

Import and use:
- `CreateOrganizationRequest`
- `CreateActorRequest`
- `CreateRepositoryRequest`
- `CreateSpecRequest`
- `UpdateSpecStageRequest`
- `CreateCandidateRequest`
- `UpdateCandidateStageRequest`
- `CreateGateVerdictRequest`
- `CreateTrialRequest`
- `DecideTrialRequest`
- `CreatePromotionRequest`
- `CreateIssueRequest`
- `UpdateIssueStageRequest`
- `UpdateIssueCommentPolicyRequest`
- `CreateIssueCommentRequest`
- `CreateIssueSpecLinkRequest`
- `CreateIssueCandidateLinkRequest`

#### C. Record Types (Lines: 617, 744)

**Action**: Replace `Record<string, any>` with specific types.

| Line | Current | Replace With |
|------|---------|--------------|
| 617 | `comparisonMetrics: Record<string, any>` | `comparisonMetrics: ComparisonMetrics` (from types) |
| 744 | `rowToObject(): Record<string, any>` | `rowToObject(): Record<string, unknown>` |

#### D. Array Parameter Types (Lines: 1466, 1495, 1529, 1575, 1604, 1625)

**Action**: Replace `params: any[]` with `params: (string \| number)[]`

#### E. Entity Type Casting (Line: 1281)

**Action**: Replace `entityType = pathParts[pathParts.length - 3] as any` with proper union type:
```typescript
entityType = pathParts[pathParts.length - 3] as 'issue' | 'candidate' | 'spec' | 'trial' | 'promotion' | 'gate_verdict'
```

#### F. Error Handling (Lines: 1385, 1852)

**Action**: Replace `catch (error: any)` with `catch (error: unknown)` or `catch (error: Error)`

#### G. Row Arrays (Lines: 1417, 1431, 1445, 1466, 1484, 1495, 1518, 1529, 1552, 1564, 1575, 1593, 1604, 1614, 1625, 1648, 1670, 1682)

**Action**: Replace `const rows: any[] = []` with proper typed arrays:
- `const rows: OrganizationRow[] = []`
- `const rows: ActorRow[] = []`
- `const rows: RepositoryRow[] = []`
- etc.

---

### 2. `workers/api/index.ts` (3 occurrences)

| Line | Current | Fix |
|------|---------|-----|
| 335 | `body?: any` | Replace with `body?: unknown` or specific type from `./types.ts` |
| 868 | `const body: any = await request.json()` | Use proper request type from `./types.ts` |
| 890 | `const body: any = await request.json()` | Use proper request type from `./types.ts` |

**Approach**: These are in the `sendToSpecDo` helper and handler functions. Replace with types from `./types.ts`.

---

### 3. `workers/sandbox-runner/index.ts` (3 occurrences)

| Line | Current | Fix |
|------|---------|-----|
| 17 | `ARTIFACTS: any` | Replace with `ARTIFACTS: unknown` |
| 18 | `SANDBOX: any` | Replace with `SANDBOX: unknown` |
| 544 | `catch (e: any)` | Replace with `catch (e: unknown)` or `catch (e: Error)` |

**Approach**: For Cloudflare bindings, use `unknown` since these are external types we don't control. For error handling, use `unknown` or `Error`.

---

### 4. `workers/queue-consumer/index.ts` (2 occurrences)

| Line | Current | Fix |
|------|---------|-----|
| 88 | `as { data?: any[] }` | Replace with `as { data?: CandidateResponse[] }` from `../api/types` |
| 92 | `(c: any) =>` | Replace with `(c: CandidateResponse) =>` |

**Approach**: Import `CandidateResponse` from `../api/types` and use proper typing.

---

### 5. `workers/gate-workflow/index.ts` (3 occurrences)

| Line | Current | Fix |
|------|---------|-----|
| 58 | `endpoints?: any[]` | Define `Endpoint` interface and use `Endpoint[]` |
| 60 | `models?: Record<string, any>` | Replace with `Record<string, unknown>` |
| 59 | `workflow?: any` | Replace with `unknown` |

**Approach**: Define proper types for the SpecContract interface.

---

## Phase 2: Low-Priority - Test Files

### `workers/gate-workflow/tests/gate.test.ts`

| Line | Current | Fix |
|------|---------|-----|
| 12 | `type JsonResponse = Record<string, any>` | Replace with `Record<string, unknown>` |
| 21, 48 | `body?: any` | Replace with `body?: unknown` |
| 57 | `response: any` | Replace with `response: unknown` |
| 58 | `response: any` | Replace with `response: unknown` |

### `workers/sandbox-runner/tests/sandbox.test.ts`

| Line | Current | Fix |
|------|---------|-----|
| 13 | `type JsonResponse = Record<string, any>` | Replace with `Record<string, unknown>` |
| 22, 49 | `body?: any` | Replace with `body?: unknown` |

**Approach**: Test files are lower priority. Replace `any` with `unknown` for mock responses.

---

## Implementation Order

1. **`workers/api/types.ts`** - Already well-typed, ensure all needed types exist
2. **`workers/spec-do/index.ts`** - The biggest file, break into the chunks listed above
3. **`workers/api/index.ts`** - Use types from `./types.ts`
4. **`workers/queue-consumer/index.ts`** - Import and use proper types
5. **`workers/sandbox-runner/index.ts`** - Use `unknown` for bindings
6. **`workers/gate-workflow/index.ts`** - Define proper types
7. **Test files** - Last priority

---

## Type Definitions Needed

The following interfaces already exist in `workers/api/types.ts` and can be reused:

- `OrganizationResponse` / `OrganizationRow`
- `ActorResponse` / `ActorRow`
- `RepositoryResponse` / `RepositoryRow`
- `SpecResponse` / `SpecRow`
- `CandidateResponse` / `CandidateRow`
- `GateVerdictResponse` / `GateVerdictRow`
- `TrialResponse` / `TrialRow`
- `PromotionResponse` / `PromotionRow`
- `IssueResponse` / `IssueRow`
- `IssueCommentResponse` / `IssueCommentRow`
- `EntityHistoryResponse` / `EntityHistoryRow`
- `IssueSpecLinkResponse` / `IssueSpecLinkRow`
- `IssueCandidateLinkResponse` / `IssueCandidateLinkRow`

Additional types that may need to be added:

- `ComparisonMetrics` (for trial comparison)
- `Endpoint` (for spec contract endpoints)

---

## Estimated Effort

| File | Occurrences | Estimated Time |
|------|-------------|----------------|
| `workers/spec-do/index.ts` | 50+ | 4-6 hours |
| `workers/api/index.ts` | 3 | 30-60 minutes |
| `workers/sandbox-runner/index.ts` | 3 | 15-30 minutes |
| `workers/queue-consumer/index.ts` | 2 | 15-30 minutes |
| `workers/gate-workflow/index.ts` | 3 | 30-60 minutes |
| Test files | 10+ | 30-60 minutes |
| **Total** | **75+** | **6-9 hours** |

---

## Verification

After implementation, run:

```bash
# Check for remaining any types
grep -r ": any" workers/ --include="*.ts" --exclude="*.test.ts"
grep -r "as any" workers/ --include="*.ts" --exclude="*.test.ts"

# Type check
npm run typecheck  # or wrangler types
```

---

## Notes

- Use `unknown` instead of `any` when the type is truly unknown/dynamic
- Prefer explicit interfaces over `Record<string, any>`
- For Cloudflare bindings (ARTIFACTS, SANDBOX), `unknown` is acceptable
- Test files can use `unknown` for mock data
- All external-facing types should be properly defined
