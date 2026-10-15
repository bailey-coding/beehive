---
category: feature
status: active
audience: human,agent
tags:
  - issue-flow
  - summary
---

# Issue Creation Flow - Summary

**Status:** Design Complete  
**Owner:** @bailey  
**Created:** 2026-10-14  
**Documents:**
- [ISSUE-CREATION-UX-DESIGN.md](ISSUE-CREATION-UX-DESIGN.md) - User experience design
- [ISSUE-CREATION-TECHNICAL-SPEC.md](ISSUE-CREATION-TECHNICAL-SPEC.md) - Technical implementation

---

## Problem Statement

The current Beehive UI expects humans to write spec JSON in free-form text fields. This is **unreasonable** because:

1. Humans must hand-write valid JSON
2. No validation or assistance provided
3. No connection between issues and specs
4. No duplicate detection
5. Steep learning curve

---

## Solution Overview

A **spec-aware, agent-assisted issue creation flow** that:

1. **Detects duplicates** using semantic similarity matching
2. **Suggests relevant specs** when confident (>80% match)
3. **Assists with partial spec definitions** through structured input
4. **Creates proper spec links** automatically

---

## User Flow

### Simple Case: Bug Report with Existing Spec

```
1. User types: "Fix login endpoint returning 500 on invalid input"
   ↓
2. System analyzes intent (2s)
   → Detects: bug_report, entities: [POST, /api/login, 500, 400]
   ↓
3. System checks for duplicates (2s)
   → Finds: Issue #42 (92% similar)
   ↓
4. User reviews #42, confirms not duplicate
   ↓
5. System suggests specs (3s)
   → Finds: auth-service-v2 (95% confidence)
   ↓
6. User selects "Link to auth-service-v2 as reports-bug"
   ↓
7. System creates Issue #65 linked to spec
   ↓
8. Done! Issue #65 created, stage = implementing
```

**Time: ~15 seconds total**

### Complex Case: New Feature Requiring New Spec

```
1. User types: "Add pagination to /api/users endpoint"
   ↓
2. System analyzes intent (2s)
   → Detects: feature_request, entities: [GET, /api/users, pagination]
   ↓
3. System checks for duplicates (2s)
   → None found
   ↓
4. System suggests specs (3s)
   → Finds: users-service (70% confidence)
   ↓
5. User selects "This needs a NEW spec"
   ↓
6. Structured editor opens with pre-filled info
   ↓
7. User defines:
   - Contract: GET /api/users with limit/offset params
   - Delta Surface: response structure, pagination headers
   ↓
8. System validates (1s)
   → All good!
   ↓
9. User reviews and submits
   ↓
10. System creates:
    - Issue #66
    - Spec "users-pagination"
    - Link between them
    ↓
11. Done! Issue #66 created, stage = spec_defining
```

**Time: ~2-3 minutes total**

---

## Key Features

### 1. Intent Detection
- Real-time analysis of title + description
- Extracts HTTP methods, paths, status codes, domain terms
- Classifies intent: bug_report, feature_request, contract_violation
- Determines if spec is needed

### 2. Duplicate Detection
- Uses cosine similarity on TF-IDF vectors
- Returns similarity scores (0-100%)
- Shows top 5 similar issues
- Warns at ≥75% similarity
- Blocks at ≥90% similarity (with override)

### 3. Spec Suggestions
- Matches against contract endpoints
- Matches against delta surface keywords
- Considers spec name and description
- Boosts active specs
- Shows confidence scores
- Suggests relationship type

### 4. Structured Contract Editor
- **No more free-form JSON!**
- Form-based interface for endpoints
- Structured schema editing
- Real-time validation
- Syntax highlighting in preview

### 5. Delta Surface Editor
- Predefined categories (HTTP status codes, response body, etc.)
- Free-text with suggestions
- Extracted from issue text
- Validated on submit

### 6. Partial Spec Extraction
- Automatically extracts from issue description
- Identifies HTTP methods and paths
- Extracts query parameters
- Identifies status codes
- Offers one-click to use in spec

---

## Technical Architecture

### Backend Services (5 new endpoints)

```
┌─────────────────────────────────────────────────────────────────┐
│ API ENDPOINTS                                                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                     │
│  1. GET /api/issues/similar                                      │
│     → Find similar issues for duplicate detection                 │
│                                                                     │
│  2. GET /api/specs/suggest                                       │
│     → Find relevant specs for issue                               │
│                                                                     │
│  3. POST /api/specs/extract                                       │
│     → Extract partial spec from issue text                        │
│                                                                     │
│  4. POST /api/specs/validate                                     │
│     → Validate spec before creation                               │
│                                                                     │
│  5. POST /api/issues (enhanced)                                  │
│     → Create issue with spec links and new spec creation         │
│                                                                     │
└─────────────────────────────────────────────────────────────────┘
```

### Algorithms (3 new modules)

```
┌─────────────────────────────────────────────────────────────────┐
│ ALGORITHMS                                                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                     │
│  1. IssueSimilarityCalculator                                    │
│     - Cosine similarity on TF-IDF vectors                       │
│     - Token-based matching                                     │
│     - Repository filtering                                      │
│                                                                     │
│  2. SpecMatcher                                                  │
│     - Contract endpoint matching                                │
│     - Delta surface keyword matching                            │
│     - Spec metadata matching                                    │
│     - Confidence scoring                                         │
│                                                                     │
│  3. SpecExtractor                                                │
│     - Regex pattern extraction                                   │
│     - HTTP method/path extraction                                │
│     - Parameter extraction                                        │
│     - Status code extraction                                      │
│                                                                     │
└─────────────────────────────────────────────────────────────────┘
```

### Database Changes (1 new table, 3 new columns)

```
┌─────────────────────────────────────────────────────────────────┐
│ DATABASE CHANGES                                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                     │
│  NEW TABLE: issue_creation_suggestions                            │
│  - Tracks all suggestions made during issue creation              │
│  - Enables learning from user overrides                          │
│  - Supports analytics                                            │
│                                                                     │
│  MODIFIED: issues table                                          │
│  - Added: created_from_spec_id                                   │
│  - Added: spec_link_confidence                                   │
│  - Added: duplicate_of                                            │
│                                                                     │
│  NEW INDEXES:                                                     │
│  - idx_issue_creation_suggestions_issue                           │
│  - idx_issue_creation_suggestions_type                            │
│  - idx_issues_created_from_spec                                   │
│  - idx_issues_duplicate_of                                        │
│                                                                     │
└─────────────────────────────────────────────────────────────────┘
```

### Frontend Components (8 new components)

```
┌─────────────────────────────────────────────────────────────────┐
│ UI COMPONENTS                                                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                     │
│  1. IssueCreationFlow (container)                                 │
│  2. IntentDetector                                               │
│  3. SimilarityChecker                                            │
│  4. SpecSuggester                                                │
│  5. StructuredContractEditor                                    │
│  6. DeltaSurfaceEditor                                           │
│  7. PartialSpecExtractor                                         │
│  8. FlowProgress                                                  │
│  9. PreviewPanel                                                 │
│                                                                     │
└─────────────────────────────────────────────────────────────────┘
```

---

## Implementation Plan


### Phase 0: Architecture & Design (NEW) - 1 day
- [ ] Define API contracts (addresses critical gap: no API contract definition)
- [ ] Design data model (addresses critical gap: no data model)
- [ ] Identify spine vs. leaf work for Phase 1
- [ ] Route Spec DO schema changes to human review (MANDATORY per AGENTS.md)
- [ ] Define change-type classification model (M5 governance feature)
- [ ] Define cost attribution model (M5 governance feature)
- [ ] Define trust registry integration points
- [ ] Freeze contracts for Phase 2 parallel start

### Phase 1: Backend Services - 3-4 days (ADJUSTED from 2-3)
> **Rationale:** Integration complexity with existing Beehive infrastructure underestimated. Spec DO schema changes require human review.

- [ ] Implement similarity check endpoint
- [ ] Implement spec suggestions endpoint
- [ ] Implement partial spec extraction endpoint
- [ ] Implement spec validation endpoint
- [ ] Extend issue creation endpoint
- [ ] Add database table and indexes
- [ ] **NEW:** Implement change-type classification
- [ ] **NEW:** Implement cost attribution
- [ ] **NEW:** Implement trust registry integration
- [ ] Add unit tests for algorithms (80%+ coverage)
- [ ] Add queue definitions for issue events
- [ ] Auth extensions for issue-specific RBAC

### Phase 2: Frontend (M4+1) - 3-5 days (UNCHANGED)
> **Rationale:** Can start when Phase 1A (Design) completes. Uses existing server-rendered approach.

- [ ] Create issue creation page
- [ ] Implement all UI components
- [ ] Add state management
- [ ] Add keyboard navigation
- [ ] Add client-side validation

### Phase 3: Agent Support - 2-3 days (ADJUSTED from 1-2)
> **Rationale:** Capability-based access and security requirements need more time. Must implement OCAP from day one.

- [ ] Add CLI support for new fields
- [ ] Add skip flags for programmatic use
- [ ] **NEW:** Implement capability-based access (OCAP principle)
- [ ] **NEW:** Agents start with NO issue creation capability; grant explicitly
- [ ] Document agent flow
- [ ] Add bulk creation support
- [ ] Integrate with existing agent framework

### Phase 4: Polish (M4+2) - 2-3 days (UNCHANGED)
- [ ] Add learning from overrides
- [ ] Add autocomplete
- [ ] Add templates
- [ ] Add accessibility
- [ ] **NEW:** Define explicit polish criteria: testing targets (70-80% coverage), performance benchmarks, accessibility standards

---

## Timeline Reality Check

> **Critical Path Minimum: 14 days** (not 8-13 as originally estimated)

| Phase | Proposed | Adjusted | Rationale |
|-------|----------|----------|-----------|
| Phase 0 | N/A | **1 day** | Architecture & design foundation |
| Phase 1 | 2-3 days | **3-4 days** | Integration + spine work review |
| Phase 2 | 3-5 days | **3-5 days** | Unchanged, can parallelize with Phase 1A |
| Phase 3 | 1-2 days | **2-3 days** | Capability system + security |
| Phase 4 | 2-3 days | **2-3 days** | Unchanged |
| **Total** | **8-13 days** | **10-15 days** | **+2-3 days buffer** |

---


| Gap | Impact | Status | Recommendation |
|-----|--------|--------|----------------|
| No API contract definition | High | ✅ Phase 0 | Define before Phase 1 starts |
| No data model | High | ✅ Phase 0 | Design in Phase 0 or 1A |
| Missing change-type classification | High | ✅ Phase 1 | M5 governance feature |
| Missing cost attribution | High | ✅ Phase 1 | M5 governance feature |
| Missing trust registry integration | High | ✅ Phase 1 | Include reporter trust |
| Spec DO schema changes | **🔴 SPILLWORK** | ⚠️ Human Review Required | Route to human per AGENTS.md |

---

## Success Metrics

| Metric | Target | Current | Improvement |
|--------|--------|---------|-------------|
| Issue creation time (with spec) | < 2 min | ~10-15 min | 85% faster |
| Issue creation time (simple) | < 1 min | ~3-5 min | 80% faster |
| JSON error rate | < 5% | ~30% | 83% reduction |
| Duplicate rate | < 10% | ~20% | 50% reduction |
| Spec link rate | > 60% | ~10% | 500% increase |
| User satisfaction | > 4.0/5 | Unknown | New |
| Agent adoption | > 80% | 0% | New |

---

## Benefits

### For Humans
✅ **No more JSON writing** - Structured editor handles it all  
✅ **Intelligent assistance** - System guides you to the right spec  
✅ **Faster workflow** - Create issues in seconds, not minutes  
✅ **Fewer mistakes** - Validation catches errors early  
✅ **Better spec coverage** - Issues automatically linked to relevant specs  

### For Agents
✅ **Programmatic creation** - Full API support for all features  
✅ **Skip suggestions** - Flags to bypass human-oriented features  
✅ **Auto-linking** - System can automatically link to best spec  
✅ **Deterministic** - Consistent behavior for testing  

### For Maintainers
✅ **Fewer duplicates** - Proactive duplicate detection  
✅ **Better organized** - Issues properly linked to specs  
✅ **Easier triage** - Clear intent and spec relationships  
✅ **Actionable data** - Learning from user behavior  

---

## Comparison: Before vs After

### Before
```
User wants to report a bug:
1. Goes to /app
2. Clicks "Create Issue"
3. Sees form with free-form fields
4. Types title: "Login broken"
5. Types description: "POST /api/login returns 500..."
6. Clicks submit
7. Issue created with NO spec link
8. Maintainer must manually find/review spec
9. Back and forth to clarify requirements

Result: Issue without spec, slow resolution
```

### After
```
User wants to report a bug:
1. Goes to /app/issues/new
2. Types title: "Login broken"
3. Types description: "POST /api/login returns 500..."
4. System suggests: auth-service-v2 (95% confidence)
5. User clicks "Link to this spec as reports-bug"
6. System creates Issue #65 linked to spec
7. Issue stage automatically set to "implementing"
8. Agents can immediately claim and work on it

Result: Issue with spec link, fast resolution
```

---

## Files to Modify

### Backend (8 files)
1. `workers/api/index.ts` - Add new routes
2. `workers/spec-do/index.ts` - Add new methods
3. `workers/spec-do/schema.sql` - Add new table
4. `workers/shared/schemas.ts` - Add new schemas
5. `workers/shared/similarity.ts` - New file
6. `workers/shared/spec-matcher.ts` - New file
7. `workers/shared/spec-extractor.ts` - New file
8. `workers/shared/spec-validator.ts` - New file

### Frontend (3 files)
1. `workers/api/ui.ts` - Add new route
2. `workers/api/ui-pages.ts` - Add issue creation page
3. `workers/api/ui-issue-creation.ts` - New file

### CLI (1 file)
1. `cli/src/commands/issue.ts` - Update create command

---

## FAQ

### Q: Do users still need to understand specs?
A: Yes, but the system guides them. The structured editor makes it easy to create valid specs without JSON knowledge.

### Q: What if the user doesn't want to link to a spec?
A: They can skip the spec linking step. The issue will be created as a regular issue without spec links.

### Q: How accurate is the duplicate detection?
A: We're targeting >80% accuracy. The system learns from user overrides, so it improves over time.

### Q: Can agents use this flow?
A: Yes! There are flags like `skipSimilarityCheck` and `autoLinkToSpec` for programmatic use.

### Q: What about existing issues?
A: Existing issues remain unchanged. The new flow is additive. We may add a migration to retroactively suggest spec links.

### Q: How do we prevent abuse?
A: All endpoints require authentication. We'll add rate limiting and validate all inputs.

---

## Next Steps

1. **Review this design** - Share with team for feedback
2. **Prioritize** - Confirm Phase 1 features for M4 submission
3. **Implement Phase 1** - Backend services first
4. **Test** - Validate algorithms with real data
5. **Iterate** - Refine based on feedback
6. **Implement Phase 2** - Frontend UI
7. **Deploy** - Roll out to users
8. **Monitor** - Track metrics and improve

---

## References

- [ISSUE-CREATION-UX-DESIGN.md](ISSUE-CREATION-UX-DESIGN.md) - Full UX design
- [ISSUE-CREATION-TECHNICAL-SPEC.md](ISSUE-CREATION-TECHNICAL-SPEC.md) - Technical details
- [ARCHITECTURE.md](ARCHITECTURE.md) - System architecture
- [UI-DASHBOARD-PLAN.md](UI-DASHBOARD-PLAN.md) - Dashboard design
- [schemas.ts](../workers/shared/schemas.ts) - Current schemas

---

*This design solves the core problem: making spec-aware issue creation accessible to humans while supporting agent workflows.*
