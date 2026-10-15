---
category: feature
status: active
audience: human,agent
tags:
  - ux
  - issue-creation
---

# Issue Creation User Experience Design

**Status:** Draft  
**Owner:** @bailey  
**Created:** 2026-10-14  
**Related:** UI-DASHBOARD-PLAN.md, ARCHITECTURE.md

---

## Executive Summary

This document designs a **spec-aware, agent-assisted issue creation flow** for Beehive that replaces the current unreasonable requirement of manually writing spec JSON in free-form text fields. The flow intelligently:

1. **Detects duplicates** using semantic similarity matching
2. **Suggests relevant specs** when confident (>80% match)
3. **Assists with partial spec definitions** through guided, structured input
4. **Creates proper spec links** automatically based on issue intent

---

## Current Problems

### 1. Unreasonable Manual Spec Authoring
The current UI (`workers/api/ui.ts:285-290`) presents spec creation as:
```html
<textarea name="contract" rows="8" placeholder='Contract as JSON, e.g. {"endpoints":[{"method":"GET","path":"/health"}]}' required></textarea>
<textarea name="declaredDeltaSurface" rows="3" placeholder="Declared delta surface, one entry per line"></textarea>
```

**Issues:** Humans must write valid JSON by hand, no validation or assistance, error-prone and intimidating.

### 2. Issues and Specs Are Disconnected
- Creating an issue doesn't suggest or create spec links
- No guidance on whether an issue needs a new spec or references existing ones
- The `issue_spec_links` table exists but isn't leveraged in creation flow

### 3. No Duplicate Detection
- Users can file identical issues
- No similarity matching against existing issues or specs

---

## Design Goals

### Primary Goals
1. **Zero manual JSON** - Users never write raw JSON for specs
2. **Intelligent guidance** - System suggests relevant specs or helps create them
3. **Duplicate prevention** - Detect and warn about similar existing issues/specs
4. **Progressive disclosure** - Simple for basic issues, powerful for spec-defined work

### Secondary Goals
1. **Agent-first** - Same flow works for agent actors as human actors
2. **Provenance tracking** - All assistant suggestions and auto-links are recorded
3. **Learn from corrections** - When user overrides suggestions, improve future recommendations

---

## The Issue Creation Flow

### Phase 1: Intent Detection (0-2 seconds)
User types title and description. System performs real-time intent analysis:
- Extracts entities: HTTP methods, paths, status codes, domain terms
- Classifies intent: bug_report, feature_request, contract_violation
- Determines if spec is needed

### Phase 2: Duplicate Detection (2-3 seconds)
System queries for similar existing issues and displays them with similarity scores:
- ≥90%: Strong duplicate warning (red)
- ≥75%: Moderate duplicate warning (yellow)
- ≥60%: Suggested reading (gray)

**Similarity Calculation:**
```
Similarity Score = 
  0.4 * title_similarity(cosine) +
  0.3 * description_similarity(cosine) +
  0.2 * entity_overlap(jaccard) +
  0.1 * repository_match(boolean)
```

### Phase 3: Spec Suggestions (3-5 seconds)
System finds relevant specs with confidence scores:
- ≥80% confidence: "This is almost certainly the right spec"
- ≥60% confidence: "This spec is likely relevant"
- ≥30% confidence: "This spec might be related"

**Spec Matching Algorithm:**
- Path matching from contract endpoints (30%)
- Delta surface keyword matching (25%)
- Spec name/description similarity (25%)
- Stage bonus for active specs (20%)

### Phase 4: Spec Selection or Creation

**Option A: Link to Existing Spec**
User selects from suggested specs with relationship type (reports-bug, requests-new, requests-change)

**Option B: Create New Spec**
Opens structured contract editor with:
- Form-based endpoint definition (method, path, request/response schemas)
- Delta surface selector with predefined categories
- Partial spec extraction from issue text
- Real-time validation

### Phase 5: Spec Validation & Preview
- Shows formatted JSON preview
- Validates contract structure
- Checks required fields
- Flags potential issues

### Phase 6: Submission & Confirmation
- Creates issue with proper spec links
- Sets appropriate initial stage
- Auto-comments with context
- Shows next steps

---

## Flow Variations

### Quick Issue Flow (No Spec)
For simple issues (typos, docs):
- System detects no spec needed
- User creates regular issue
- Option to add spec later

### Agent Flow (Programmatic)
```
Agent POST /api/issues with full context
→ System auto-detects intent
→ System finds matching spec (if any)
→ System auto-links issue to spec
→ Creates issue with all metadata
```

### Partial Spec from Issue
When issue text contains spec-like information:
- System extracts partial contract (endpoints, params, status codes)
- Offers one-click to use in spec creation
- User can accept or ignore

---

## API Design

### New Endpoints

```
GET /api/issues/similar?repositoryId=:id&title=...&description=...
  → Returns SimilarIssue[] with similarity scores

GET /api/specs/suggest?repositoryId=:id&query=...
  → Returns SpecMatch[] with confidence scores

POST /api/specs/extract
  Body: { text, repositoryId }
  → Returns PartialContract extracted from text

POST /api/specs/validate
  Body: { contract, declaredDeltaSurface }
  → Returns ValidationResult

POST /api/issues (enhanced)
  Body: CreateIssueRequest + {
    issueSpecLinks?: IssueSpecLinkCreate[],
    createSpec?: CreateSpecRequest,
    skipSimilarityCheck?: boolean,
    autoLinkToSpec?: boolean
  }
  → Returns CreateIssueResponse
```

### Key Data Structures

```typescript
// For duplicate detection
interface SimilarIssue {
  id: string;
  number: number;
  title: string;
  similarityScore: number; // 0-100
  specId?: string;
  specName?: string;
}

// For spec suggestions
interface SpecMatch {
  spec: Spec;
  confidence: number; // 0-100
  matchReasons: string[];
  contractMatches: Array<{ path: string; method: string; relevance: number }>;
}

// For partial spec extraction
interface PartialContract {
  endpoints?: Array<{
    method: string;
    path: string;
    queryParams?: Record<string, { type: string }>;
  }>;
  expectedStatuses?: number[];
}

// Extended issue creation
interface CreateIssueWithSpecRequest extends CreateIssueRequest {
  issueSpecLinks?: Array<{
    specId: string;
    relationship: 'requests-new' | 'requests-change' | 'reports-bug';
  }>;
  createSpec?: CreateSpecRequest;
  skipSimilarityCheck?: boolean;
}
```

---

## Structured Contract Editor

Replaces free-form JSON textarea with form-based interface:

```
Contract Editor Fields:
├── Spec Name: [text input]
├── Description: [textarea]
├── Endpoints:
│   ├── Endpoint 1:
│   │   ├── Method: [GET ▼]
│   │   ├── Path: [/api/resource]
│   │   ├── Request Schema: [Structured editor]
│   │   └── Response Schema: [Structured editor]
│   └── [+ Add endpoint]
└── Declared Delta Surface:
    ├── [✓] HTTP status codes
    ├── [✓] Response body structure
    ├── [✗] Request validation logic
    └── [+ Add custom item]
```

**Validation Rules:**
- Contract must be valid JSON with endpoints array
- Each endpoint must have method and path
- Delta surface must have at least one item
- Spec name must be alphanumeric with hyphens/underscores

---

## UI Component Library

### New Components for Issue Creation

1. **IntentDetector** - Real-time analysis of title/description
2. **SimilarityChecker** - Duplicate detection with similarity scores
3. **SpecSuggester** - Spec matching with confidence scores
4. **StructuredContractEditor** - Form-based contract building
5. **DeltaSurfaceEditor** - Category-based delta surface selection
6. **PartialSpecExtractor** - Highlights and extracts spec-like text
7. **FlowProgress** - Shows current step in multi-step flow
8. **PreviewPanel** - Formatted JSON preview with syntax highlighting

### Component Hierarchy

```
IssueCreationFlow
├── FlowProgress
├── IntentDetector
├── SimilarityChecker
├── SpecSuggester
│   ├── SpecCard (for each match)
│   └── NewSpecButton
├── If new spec requested:
│   ├── StructuredContractEditor
│   ├── DeltaSurfaceEditor
│   └── PartialSpecExtractor
└── PreviewAndSubmit
    ├── IssuePreview
    ├── SpecPreview (if created)
    └── SubmitButton
```

---

## Data Model Changes

### New Table for Tracking

```sql
CREATE TABLE IF NOT EXISTS issue_creation_suggestions (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  suggestion_type TEXT NOT NULL CHECK(suggestion_type IN ('spec_match', 'duplicate', 'partial_spec')),
  suggested_id TEXT,
  suggested_data TEXT,
  confidence INTEGER,
  accepted BOOLEAN,
  overridden_by TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (issue_id) REFERENCES issues(id),
  FOREIGN KEY (suggested_id) REFERENCES specs(id),
  FOREIGN KEY (overridden_by) REFERENCES actors(id)
);
```

### Modified Behavior

When an issue is created via new flow:
1. **Issue Stage**: Automatically set based on spec linkage
2. **Auto-comments**: Added with context about spec links
3. **Entity History**: All auto-actions recorded

---

## Implementation Phases

### Phase 1: Backend Services (Priority: HIGH)
- [ ] Implement `/api/issues/similar` endpoint
- [ ] Implement `/api/specs/suggest` endpoint
- [ ] Implement `/api/specs/extract` endpoint
- [ ] Implement `/api/specs/validate` endpoint
- [ ] Extend `/api/issues` POST endpoint
- [ ] Add `issue_creation_suggestions` table to Spec DO

### Phase 2: UI Flow for Humans (Priority: HIGH)
- [ ] Create `IssueCreationPage` with multi-step flow
- [ ] Implement all UI components
- [ ] Add flow state management
- [ ] Add keyboard navigation

### Phase 3: Agent Support (Priority: MEDIUM)
- [ ] Add `skipSuggestions` flag for agents
- [ ] Add `autoLinkToSpec` for programmatic creation
- [ ] Document agent flow
- [ ] Add bulk issue creation

### Phase 4: Learning & Polish (Priority: LOW)
- [ ] Implement learning from overrides
- [ ] Add autocomplete to contract editor
- [ ] Add spec templates
- [ ] Add issue templates

---

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Issue creation time (with spec) | < 2 min | Time from page load to submit |
| Issue creation time (simple) | < 1 min | Time from page load to submit |
| JSON error rate | < 5% | Issues with invalid contract JSON |
| Duplicate rate | < 10% | Issues marked as duplicates within 24h |
| Spec link rate | > 60% | Issues linked to at least one spec |
| Agent adoption | > 80% | Agent-created issues using new flow |

---

## Open Questions

1. Should spec creation be mandatory for non-trivial issues?
   - **Decision:** Keep optional, but strongly encourage for contract-related issues

2. How to handle multiple specs with high confidence?
   - **Decision:** Show top 3, let user choose or create new

3. Should partial spec extraction be automatic or opt-in?
   - **Decision:** Opt-in with preview (user must approve)

4. How to handle spec versioning?
   - **Decision:** In SpecMatch, include suggestedUpgrade field for deprecated specs

5. Should we support issue templates?
   - **Decision:** Yes, in Phase 4

---

## Flow Diagram

```
START → ENTER TITLE/DESC → DETECT INTENT → CHECK DUPLICATES
                                              │
                    ┌─────────────────────┴─────────────────────┐
                    ▼                                       ▼
          DUPLICATES FOUND → USER CONFIRMS           NO DUPLICATES
                    │                       NOT DUPLICATE              │
                    └─────────────────────┬─────────────────────┘
                                              │
                                              ▼
                                   FIND SPEC MATCHES
                                              │
              ┌───────────────────────────────┬────────────────────┐
              ▼                               ▼                    ▼
     SPECS FOUND → USER SELECTS        NO SPECS → CREATE NEW? → YES
     (Show matches)  SPEC OR NEW SPEC             (Open editor)
              │                                   │
              │                                   ▼
              │                          USER DEFINES SPEC
              │                           (Structured editor)
              │                                   │
              ▼                                   ▼
LINK TO SPEC → PREVIEW → SUBMIT      VALIDATE → PREVIEW → SUBMIT
     (Create issue + spec link)         (Show errors if any)
```

---

## Example Sessions

### Example 1: Human reporting a bug
1. User types: "Fix login endpoint returning 500 on invalid input"
2. System detects: bug_report intent, entities: [POST, /api/login, 500, 400]
3. System finds: Issue #42 (92% similar) - user confirms not duplicate
4. System suggests: auth-service-v2 spec (95% confidence)
5. User links to spec as "reports-bug"
6. System creates Issue #65

### Example 2: Agent reporting contract violation
1. Agent POST /api/issues with title and description
2. System auto-detects intent and finds auth-service-v2 (95%)
3. System auto-links issue to spec as "reports-bug"
4. System creates Issue #67 with spec link
5. Agent receives response and continues workflow

---

## Related Files

**Backend:**
- `workers/api/index.ts` - Issue endpoints
- `workers/spec-do/index.ts` - Spec DO storage
- `workers/spec-do/schema.sql` - Database schema
- `workers/shared/schemas.ts` - Zod schemas

**Frontend:**
- `workers/api/ui.ts` - UI entry point
- `workers/api/ui-pages.ts` - Page handlers
- `workers/api/ui-html.ts` - HTML helpers

**CLI:**
- `cli/src/commands/issue.ts` - Issue commands

**Documentation:**
- [ARCHITECTURE.md](ARCHITECTURE.md) - System architecture
- [UI-DASHBOARD-PLAN.md](UI-DASHBOARD-PLAN.md) - Dashboard design

---

## Glossary

| Term | Definition |
|------|------------|
| Contract | Machine-readable API specification defining endpoints, schemas, and behaviors |
| Delta Surface | Explicit list of behaviors that are allowed to change in an implementation |
| Spec Link | Relationship between an issue and a spec (reports-bug, requests-new, requests-change) |
| Intent | Classified purpose of an issue (bug_report, feature_request, etc.) |
| Partial Spec | Incomplete spec information extracted from issue description |

---

## Changelog

| Date | Author | Changes |
|------|--------|---------|
| 2026-10-14 | @bailey | Initial design draft |
