---
category: deprecated
status: deprecated
audience: human
tags:
  - review-needed
---

# Plan: Remove All `any` Types from Beehive Codebase

## Overview

The codebase currently has **71 `any` type usages** across the Workers. This document outlines a systematic plan to replace all `any` types with proper TypeScript types, improving type safety and maintainability.

**Current Status:**
- ✅ Typecheck passes
- ✅ Lint passes  
- ✅ Tests pass (29 tests)
- ❌ 71 `any` types remain (mostly in `spec-do/index.ts`)

## Lessons Learned

**Discovery:** The proper way to update files is using `search_replace` tool, not sed or Python scripts.

**Why:**
- `search_replace` is deterministic and atomic
- Changes are explicit and reviewable in conversation history
- No edge cases with escaping, line endings, or partial matches
- Self-documenting - each change shows exactly what was replaced

**Anti-patterns to avoid:**
- ❌ `sed` one-liners for complex replacements
- ❌ Python scripts with regex for file modifications
- ❌ Chained `sed -i` commands
- ❌ Manual line-by-line edits via line numbers

**Correct pattern:**
- ✅ Use `search_replace` with explicit old_str/new_str blocks
- ✅ Make small, focused changes
- ✅ Verify each change with typecheck/lint/tests

---

## Inventory of `any` Usages

### By File

| File | Count | Categories |
|------|-------|------------|
| `workers/spec-do/index.ts` | 62 | Request bodies, return types, row arrays, params, entityType cast |
| `workers/api/index.ts` | 3 | Request bodies |
| `workers/gate-workflow/index.ts` | 3 | Bindings, models, workflow |
| `workers/queue-consumer/index.ts` | 2 | JSON parsing |
| `workers/sandbox-runner/index.ts` | 3 | Catch blocks (already fixed in previous commit) |

### By Category

#### Category 1: Request Bodies (25+ instances)
```typescript
const body: any = await request.json();
body?: any
```
**Files:** `spec-do/index.ts` (22), `api/index.ts` (3)

**Solution:** Use `unknown` with type guards, or define proper request body interfaces.

#### Category 2: Return Types (20 instances)
```typescript
getOrganization(id: string): any
getRepository(id: string): any
getIssue(id: string): any
getEntityHistory(entityType: string, entityId: string): any[]
createIssueSpecLink(...): any
createIssueCandidateLink(...): any
createIssueComment(...): any
createRepository(...): any
listOrganizations(...): any[]
listActors(...): any[]
listRepositories(...): any[]
listSpecs(...): any[]
listCandidates(...): any[]
listGateVerdicts(...): any[]
listTrials(...): any[]
listPromotions(...): any[]
listIssues(...): any[]
listIssueComments(...): any[]
```
**Solution:** Return proper Row interfaces (`OrganizationRow | null`, `OrganizationRow[]`, etc.)

#### Category 3: Row Arrays (10 instances)
```typescript
const rows: any[] = []
```
**Files:** `spec-do/index.ts` (in list methods)

**Solution:** Use proper Row array types (`OrganizationRow[]`, `ActorRow[]`, etc.)

#### Category 4: Parameters (5 instances)
```typescript
const params: any[] = [limit, offset]
```
**Files:** `spec-do/index.ts` (in list methods with conditional queries)

**Solution:** Use `(string | number | null)[]`

#### Category 5: Type Casts (2 instances)
```typescript
const entityType = pathParts[pathParts.length - 3] as any
```
**Files:** `spec-do/index.ts`

**Solution:** Use proper `EntityType` union type

#### Category 6: Field Types (1 instance)
```typescript
comparisonMetrics: Record<string, any>
```
**Files:** `spec-do/index.ts` (line 617)

**Solution:** Use `ComparisonMetrics` interface from `api/types.ts`

#### Category 7: Bindings (3 instances)
```typescript
ARTIFACTS: any
models?: Record<string, any>
workflow?: any
```
**Files:** `gate-workflow/index.ts`

**Solution:** Use `unknown` for bindings that can't be typed yet

#### Category 8: JSON Parsing (2 instances)
```typescript
const candidatesData = await candidatesResp.json() as { data?: any[] }
const candidate = candidates.find((c: any) => ...
```
**Files:** `queue-consumer/index.ts`

**Solution:** Define proper interface for candidate data

---

## Implementation Plan

### Phase 1: Add Missing Row Interfaces

**File:** `workers/spec-do/index.ts`

Add these interfaces after the existing `IssueRow` interface (around line 100):

```typescript
interface OrganizationRow {
  id: string;
  name: string;
  type: 'github' | 'gitlab' | 'artifacts';
  external_id?: string;
  created_at: number;
}

interface RepositoryRow {
  id: string;
  name: string;
  organization_id: string;
  repo_type: 'baseline' | 'candidate';
  spec_id?: string;
  agent_id?: string;
  external_id?: string;
  remote_url: string;
  namespace: string;
  default_branch: string;
  created_at: number;
}

interface PromotionRow {
  id: string;
  candidate_id: string;
  promoted_to: string;
  promoted_at: number;
  promoted_by: string;
  notes?: string;
}

interface IssueCommentRow {
  id: string;
  issue_id: string;
  body: string;
  created_by: string;
  created_at: number;
}

interface IssueSpecLinkRow {
  id: string;
  issue_id: string;
  spec_id: string;
  relationship: string;
  created_at: number;
}

interface IssueCandidateLinkRow {
  id: string;
  issue_id: string;
  candidate_id: string;
  relationship: string;
  created_at: number;
}
```

### Phase 2: Add Row Conversion Methods

**File:** `workers/spec-do/index.ts`

Add these private methods to the `SpecDO` class (after the existing `rowToObject` method):

```typescript
private rowToOrganization(stmt: { getRow(): Record<string, unknown> | null }): OrganizationRow | null {
  const row = stmt.getRow();
  if (!row) return null;
  return {
    id: row.id as string,
    name: row.name as string,
    type: row.type as 'github' | 'gitlab' | 'artifacts',
    external_id: row.external_id as string | undefined,
    created_at: row.created_at as number,
  };
}

private rowToRepository(stmt: { getRow(): Record<string, unknown> | null }): RepositoryRow | null {
  const row = stmt.getRow();
  if (!row) return null;
  return {
    id: row.id as string,
    name: row.name as string,
    organization_id: row.organization_id as string,
    repo_type: row.repo_type as 'baseline' | 'candidate',
    spec_id: row.spec_id as string | undefined,
    agent_id: row.agent_id as string | undefined,
    external_id: row.external_id as string | undefined,
    remote_url: row.remote_url as string,
    namespace: row.namespace as string,
    default_branch: row.default_branch as string,
    created_at: row.created_at as number,
  };
}

private rowToActor(stmt: { getRow(): Record<string, unknown> | null }): ActorRow | null {
  const row = stmt.getRow();
  if (!row) return null;
  return {
    id: row.id as string,
    type: row.type as 'human' | 'agent',
    name: row.name as string,
    github_user_id: row.github_user_id as string | undefined,
    trust_score: row.trust_score as number,
    promotion_authority: Boolean(row.promotion_authority),
    created_at: row.created_at as number,
  };
}

private rowToSpec(stmt: { getRow(): Record<string, unknown> | null }): SpecRow | null {
  const row = stmt.getRow();
  if (!row) return null;
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string | undefined,
    contract: row.contract as string,
    declared_delta_surface: row.declared_delta_surface as string,
    organization_id: row.organization_id as string,
    created_by: row.created_by as string,
    created_at: row.created_at as number,
    stage: row.stage as 'draft' | 'proposed' | 'active' | 'deprecated' | 'archived',
  };
}

private rowToCandidate(stmt: { getRow(): Record<string, unknown> | null }): CandidateRow | null {
  const row = stmt.getRow();
  if (!row) return null;
  return {
    id: row.id as string,
    spec_id: row.spec_id as string,
    repository_id: row.repository_id as string,
    commit_sha: row.commit_sha as string,
    base_commit_sha: row.base_commit_sha as string,
    agent_id: row.agent_id as string,
    created_at: row.created_at as number,
    stage: row.stage as 'pending' | 'passed_premerge' | 'passed_shadow' | 'passed_train' | 'passed_canary' | 'promoted' | 'failed' | 'rolled_back',
  };
}

private rowToGateVerdict(stmt: { getRow(): Record<string, unknown> | null }): GateVerdictRow | null {
  const row = stmt.getRow();
  if (!row) return null;
  return {
    id: row.id as string,
    candidate_id: row.candidate_id as string,
    gate: row.gate as 'pre-merge' | 'shadow' | 'train' | 'canary' | 'full',
    status: row.status as 'pass' | 'fail' | 'pending',
    score: row.score as number,
    complexity_delta: row.complexity_delta as number,
    notes: row.notes as string | undefined,
    created_at: row.created_at as number,
    decided_by: row.decided_by as string,
    stage: row.stage as 'pending' | 'passed' | 'failed',
  };
}

private rowToTrial(stmt: { getRow(): Record<string, unknown> | null }): TrialRow | null {
  const row = stmt.getRow();
  if (!row) return null;
  return {
    id: row.id as string,
    spec_id: row.spec_id as string,
    candidate_a_id: row.candidate_a_id as string,
    candidate_b_id: row.candidate_b_id as string,
    winner_id: row.winner_id as string | undefined,
    comparison_metrics: row.comparison_metrics as string,
    decided_at: row.decided_at as number,
    decided_by: row.decided_by as string,
    stage: row.stage as 'pending' | 'comparing' | 'decided',
  };
}

private rowToPromotion(stmt: { getRow(): Record<string, unknown> | null }): PromotionRow | null {
  const row = stmt.getRow();
  if (!row) return null;
  return {
    id: row.id as string,
    candidate_id: row.candidate_id as string,
    promoted_to: row.promoted_to as string,
    promoted_at: row.promoted_at as number,
    promoted_by: row.promoted_by as string,
    notes: row.notes as string | undefined,
  };
}

private rowToIssue(stmt: { getRow(): Record<string, unknown> | null }): IssueRow | null {
  const row = stmt.getRow();
  if (!row) return null;
  return {
    id: row.id as string,
    number: row.number as number,
    repository_id: row.repository_id as string,
    title: row.title as string,
    body: row.body as string | undefined,
    status: row.status as 'open' | 'closed',
    labels: row.labels as string | undefined,
    created_at: row.created_at as number,
    created_by: row.created_by as string,
    closed_at: row.closed_at as number | undefined,
    closed_by: row.closed_by as string | undefined,
    comment_policy: row.comment_policy as 'open' | 'maintainers_only' | 'locked',
    visibility: row.visibility as 'public' | 'internal' | 'private',
    stage: row.stage as 'reported' | 'spec_needed' | 'spec_defining' | 'spec_defined' | 'implementing' | 'validating' | 'merged' | 'closed',
  };
}

private rowToIssueComment(stmt: { getRow(): Record<string, unknown> | null }): IssueCommentRow | null {
  const row = stmt.getRow();
  if (!row) return null;
  return {
    id: row.id as string,
    issue_id: row.issue_id as string,
    body: row.body as string,
    created_by: row.created_by as string,
    created_at: row.created_at as number,
  };
}

private rowToIssueSpecLink(stmt: { getRow(): Record<string, unknown> | null }): IssueSpecLinkRow | null {
  const row = stmt.getRow();
  if (!row) return null;
  return {
    id: row.id as string,
    issue_id: row.issue_id as string,
    spec_id: row.spec_id as string,
    relationship: row.relationship as string,
    created_at: row.created_at as number,
  };
}

private rowToIssueCandidateLink(stmt: { getRow(): Record<string, unknown> | null }): IssueCandidateLinkRow | null {
  const row = stmt.getRow();
  if (!row) return null;
  return {
    id: row.id as string,
    issue_id: row.issue_id as string,
    candidate_id: row.candidate_id as string,
    relationship: row.relationship as string,
    created_at: row.created_at as number,
  };
}

private rowToEntityHistory(stmt: { getRow(): Record<string, unknown> | null }): EntityHistoryRow | null {
  const row = stmt.getRow();
  if (!row) return null;
  return {
    id: row.id as string,
    entity_type: row.entity_type as EntityType,
    entity_id: row.entity_id as string,
    stage: row.stage as EntityStage,
    changed_by: row.changed_by as string,
    changed_at: row.changed_at as number,
    notes: row.notes as string | undefined,
    metadata: row.metadata as string | undefined,
  };
}
```

### Phase 3: Update Method Signatures and Implementations

**File:** `workers/spec-do/index.ts`

Update all method signatures and implementations:

#### Get Methods (Single Row)
```typescript
// Before
getOrganization(id: string): any { ... this.rowToObject(stmt) ... }
getRepository(id: string): any { ... this.rowToObject(stmt) ... }
getIssue(id: string): any { ... this.rowToObject(stmt) ... }

// After
getOrganization(id: string): OrganizationRow | null { ... this.rowToOrganization(stmt) ... }
getRepository(id: string): RepositoryRow | null { ... this.rowToRepository(stmt) ... }
getIssue(id: string): IssueRow | null { ... this.rowToIssue(stmt) ... }
```

#### List Methods (Multiple Rows)
```typescript
// Before
listOrganizations(limit: number, offset: number): any[] {
  const rows: any[] = [];
  while (stmt.step()) { rows.push(this.rowToObject(stmt)); }
  return rows;
}

// After
listOrganizations(limit: number, offset: number): OrganizationRow[] {
  const rows: OrganizationRow[] = [];
  while (stmt.step()) { rows.push(this.rowToOrganization(stmt)); }
  return rows;
}
```

#### Create Methods
```typescript
// Before
createIssueSpecLink(issueId: string, specId: string, relationship: string): any {
  return { id, issueId, specId, relationship, createdAt: now() };
}

// After
createIssueSpecLink(issueId: string, specId: string, relationship: string): IssueSpecLinkRow {
  return { id, issue_id: issueId, spec_id: specId, relationship, created_at: now() };
}
```

Note: Property names must match the interface (snake_case vs camelCase).

#### Request Body Handling
```typescript
// Before
const body: any = await request.json();

// After
const body: unknown = await request.json();
// OR define proper interface
interface CreateCandidateRequest {
  specId: string;
  repositoryId: string;
  commitSha: string;
  baseCommitSha: string;
}
const body = await request.json<CreateCandidateRequest>();
```

#### Params Arrays
```typescript
// Before
const params: any[] = [limit, offset];

// After
const params: (string | number | null)[] = [limit, offset];
```

#### Entity Type Cast
```typescript
// Before
const entityType = pathParts[pathParts.length - 3] as any;

// After
const entityType = pathParts[pathParts.length - 3] as EntityType;
```

### Phase 4: Update Other Files

#### workers/api/index.ts
```typescript
// Line 335: body?: any -> body?: unknown
// Line 868: const body: any = await request.json(); -> const body: unknown = await request.json();
// Line 890: const body: any = await request.json(); -> const body: unknown = await request.json();
```

#### workers/gate-workflow/index.ts
```typescript
// Line 58: endpoints?: any[] -> endpoints?: unknown[]
// Line 59: models?: Record<string, any> -> models?: Record<string, unknown>
// Line 60: workflow?: any -> workflow?: unknown
```

#### workers/queue-consumer/index.ts
```typescript
// Define interface for candidate data
interface ArtifactsCandidate {
  id: string;
  // ... other fields as needed
}

// Line 88: const candidatesData = await candidatesResp.json() as { data?: any[] };
// -> const candidatesData = await candidatesResp.json() as { data?: ArtifactsCandidate[] };

// Line 92: const candidate = candidates.find((c: any) => ...
// -> const candidate = candidates.find((c: ArtifactsCandidate) => ...
```

#### workers/sandbox-runner/index.ts
```typescript
// Line 544: } catch (e: any) { -> } catch (e: unknown) {
// (Already fixed in previous commit, but verify)
```

### Phase 5: Validation

After all changes:

1. **Typecheck:** `npm run typecheck` - should pass with 0 errors
2. **Lint:** `npm run lint` - should pass with 0 errors
3. **Tests:** `npm run test` - all 29 tests should still pass
4. **Count:** `grep -c "any" workers/**/*.ts` - should be 0 (or only in comments)

---

## Expected Outcome

- **Type Safety:** All database rows have proper types
- **Better IDE Support:** Autocomplete and type checking work correctly
- **Maintainability:** Code is self-documenting through types
- **Zero Runtime Overhead:** TypeScript types are compile-time only

---

## Risk Assessment

**Low Risk:**
- All changes are type-only (no logic changes)
- Existing tests cover the functionality
- TypeScript will catch any type mismatches

**Medium Risk:**
- Some property name mismatches (camelCase vs snake_case) may need adjustment
- The `rowTo*` methods use type assertions (`as`) which are safe but could be validated with runtime checks

**Mitigation:**
- Run typecheck and tests after each phase
- Use `satisfies` operator where possible for additional safety
- Consider adding runtime validation with Zod for critical paths

---

## Files to Modify

1. `workers/spec-do/index.ts` - ~60 changes
2. `workers/api/index.ts` - 3 changes
3. `workers/gate-workflow/index.ts` - 3 changes
4. `workers/queue-consumer/index.ts` - 2 changes

---

## Success Criteria

- [ ] All `any` types replaced with proper types
- [ ] Typecheck passes (`npm run typecheck`)
- [ ] Lint passes (`npm run lint`)
- [ ] Tests pass (`npm run test`)
- [ ] No regressions in functionality
- [ ] Code is more maintainable and type-safe
