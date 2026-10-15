---
category: feature
status: active
milestone: m6
audience: human,agent
tags:
  - ui
  - dashboard
---

# UI Dashboard Plan

**Status:** Draft — Phase 0 shipped 2026-10-13: GitHub login + create/list pages for orgs, repos and specs, server-rendered in the API worker (`workers/api/ui.ts`). The React pages in `ui/src` remain unbuilt and undeployed (no `package.json`, bundler or hosting).
**Owner:** @bailey
**Created:** 2026-10-11

---

## Overview

This document outlines the dashboard architecture for the Beehive platform, designed to leverage our semantic understanding of repositories, specs, and change categorization. The goal is to provide users with actionable insights: what they can contribute to, what's blocked on them, and what recently changed.

The plan is structured in phases, starting with basic CRUD views and evolving into intelligent, context-aware dashboards.

---

## Architecture Summary

### Dashboard Hierarchy

| Level | Path | Purpose | Primary Data |
|-------|------|---------|--------------|
| Root | `/` | What can I work on across the platform? | My specs, my candidates, blocked items, recent changes |
| Organization | `/:org` | What's happening in this organization? | Org specs, org candidates, org activity, members |
| Repository | `/:org/:repo` | What's the status of this repository? | Linked spec, candidates from this repo, trials, gate verdicts |

### Core Sections (All Dashboards)

1. **What I Can Contribute To** — Actionable work items
2. **My In-Progress Work** — Current status of my contributions
3. **Blocked On Me** — Items awaiting my review/decision
4. **Recent Changes** — Semantically categorized activity
5. **Quick Access** — Navigation shortcuts

---

## Phase 0.5: Semantic Vision Mockup (M6 - COMPLETE) ✅

**Goal:** Bring the logged-in UI closer to the platform vision with semantic intelligence,
even if mocked with fake examples initially. This demonstrates the end-state UX before
the full semantic layer is implemented.

**Implementation Note:** All semantic features use deterministic mock data per Oracle review requirements.
ID-based routing used instead of /:org/:repo slugs for uniqueness.

### Tasks

- [x] **Semantic search in main views** — Add a search bar/context to org and repo pages that shows semantic search results (mocked)
- [x] **Semantic changelog** — Add a "Recent Changes" or "Activity" section to org and repo pages showing semantically categorized changes (mocked)
- [x] **Repository detail pages** — Create `/app/repos/:id` pages showing:
  - [x] Linked spec information
  - [x] Commit list with build status
  - [x] Explorable file tree (mocked from a sample structure)
  - [x] Build/trial history
- [x] **Tabs for issues and specs** — Add tabbed navigation on repo pages:
  - [x] Overview tab
  - [x] Issues tab
  - [x] Specs tab
  - [x] Commits/Builds tab
  - [x] Files tab
- [x] **Cross-link list/detail pages** — Ensure all entities link to each other:
  - [x] Specs link to their candidates
  - [x] Candidates link to their specs, trials, and promotion records
  - [x] Trials link to candidates and specs
  - [x] Repos link to their specs
  - [x] Orgs link to their repos and specs
- [x] **Update about page** — Already present in index.ts (Vision: Semantic Dashboard section)
- [x] **Clear mock labeling** — All semantic features marked with mockedLabel() pill

### Implementation Notes

This phase uses the existing server-rendered approach in `workers/api/ui.ts`. All semantic
data is deterministic mock for demonstration purposes (per Oracle review requirements R7, R8).
The goal is visual fidelity to the vision, not functional semantic processing.

**Key decisions:**
- Used ID-based routing (`/app/orgs/:id`, `/app/repos/:id`, etc.) instead of `/:org/:repo` slugs
  for uniqueness and to avoid collisions with `/api/*` and `/about` routes
- All mock data is deterministic (same ID + now = identical output)
- All filtering done in UI code, not via DO filtered list routes (per R1 - bind order bug)

### Files

```
workers/api/ui.ts
- Added DoReader interface and createDoReader() implementation
- Added dispatch hunk for detail page routes
- Added cross-links on dashboard

workers/api/ui-html.ts (NEW)
- Extracted esc, str, table, page helpers
- Added tabs, badges, link, appLink helpers
- Added mockedLabel() for clear labeling

workers/api/ui-pages.ts (NEW)
- orgPage, repoPage, specPage, candidatePage, trialPage handlers
- All pages use unfiltered DO list routes + UI filtering

workers/api/ui-semantic.ts (NEW)
- Deterministic mock generators (semanticSearch, semanticChangelog, mockCommits, mockFileTree)
- Renderers for all mock data
- Uses real ChangeType vocabulary from cli/src/types/api.ts:269

workers/api/tests/ui.test.ts (NEW)
- Comprehensive test suite for UI functionality
```

### Acceptance Criteria

- [x] `/app/orgs/:id` pages show semantic search and changelog sections (mocked)
- [x] `/app/repos/:id` pages exist with tabs for issues, specs, commits, files
- [x] File tree is navigable (mocked) using <details> elements
- [x] All pages cross-link appropriately with appLink() helper
- [x] About page mentions the semantic vision (already present)
- [x] All mocked features are clearly labeled with mockedLabel()

---

## Phase 0: Foundation (CRUD Views) ⬜

**Goal:** Basic list and detail views for all core entities.

### Tasks

- [ ] Create root `App.tsx` with `<BrowserRouter>` and layout shell
- [ ] Create `Layout.tsx` with header navigation (Specs, Candidates, Trials, Actors, Organizations)
- [ ] Set up routing for all dashboard levels
- [ ] Create basic `DataTable` component with sorting and pagination
- [ ] Extend `api.ts` with development mock mode (`VITE_USE_MOCKS=true`)
- [ ] Create Faker mock factories for: Spec, Candidate, Trial, Actor, GateVerdict

### Files

```
ui/src/
├── App.tsx
├── Layout.tsx
├── components/
│   └── DataTable.tsx
└── services/
    └── mockApi.ts (mock implementations)
```

### Acceptance Criteria

- [ ] All existing pages (SpecsPage, CandidatesPage, TrialsPage, TrialDetailPage) render without errors
- [ ] Mock data populates all list views
- [ ] Navigation between pages works
- [ ] Basic filtering by stage works on all list pages

---

## Phase 1: Root Homepage (My Work) ⬜

**Goal:** Personalized dashboard showing what the user can and should work on.

### Tasks

- [ ] Create `HomePage.tsx` for root `/`
- [ ] Implement "What I Can Contribute To" section
  - [ ] Query: specs needing implementations (active specs without candidate from current user)
  - [ ] Display: Spec name, description preview, deadline
- [ ] Implement "My In-Progress Work" section
  - [ ] Query: my candidates grouped by stage
  - [ ] Display: CandidateCard with spec, current gate, score
- [ ] Implement "Blocked On Me" section
  - [ ] Query: gate verdicts awaiting my review
  - [ ] Display: Candidate, spec, gate type, time waiting
- [ ] Implement "Recent Changes" section
  - [ ] Query: recent trials, promotions, spec updates
  - [ ] Display: Entity type, change description, timestamp

### API Endpoints Needed

```typescript
GET /api/dashboard/my-work
Response: {
  specsNeedingMe: Spec[];
  myCandidates: Candidate[];
  blockedOnMe: DashboardBlockedItem[];
  recentChanges: SemanticChange[];
}
```

### Files

```
ui/src/
├── pages/
│   └── HomePage.tsx
└── hooks/
    └── useDashboard.ts
```

### Acceptance Criteria

- [ ] Root homepage loads with all four sections populated
- [ ] Each section has "View all" link to relevant list page
- [ ] StageBadges and ScoreBadges render correctly
- [ ] Clicking items navigates to detail pages

---

## Phase 2: Organization Homepage ⬜

**Goal:** Organization-level overview of specs, candidates, and activity.

### Tasks

- [ ] Create `OrgPage.tsx` for `/:org`
- [ ] Implement Org Overview section
  - [ ] Specs count by stage
  - [ ] Candidates count by stage
  - [ ] Members list with trust scores
- [ ] Implement "What Needs Attention" section
  - [ ] Specs without candidates
  - [ ] Stalled candidates (stuck at gates > 24h)
  - [ ] Failing trials
- [ ] Implement Recent Activity section
- [ ] Implement Repository List section

### API Endpoints Needed

```typescript
GET /api/orgs/:org/dashboard
Response: {
  specCounts: Record<SpecStage, number>;
  candidateCounts: Record<CandidateStage, number>;
  members: Actor[];
  stalledItems: DashboardBlockedItem[];
  recentActivity: SemanticChange[];
  repositories: Repository[];
}
```

### Files

```
ui/src/
├── pages/
│   └── orgs/
│       ├── OrgPage.tsx
│       └── [id].tsx (dynamic org page)
```

### Acceptance Criteria

- [ ] Org homepage loads with all sections
- [ ] Links to spec detail, candidate detail work
- [ ] Repository list shows linked spec for each

---

## Phase 3: Repository Homepage ⬜

**Goal:** Repository-specific context with spec implementation status.

### Tasks

- [ ] Create `RepoPage.tsx` for `/:org/:repo`
- [ ] Implement Repository Status section
  - [ ] Linked spec (if any)
  - [ ] Spec stage
  - [ ] Repository type
  - [ ] Last commit
- [ ] Implement Spec Implementation Status section
  - [ ] If linked to spec: show contract, declared delta surface
  - [ ] Implementation candidates from this repo
  - [ ] Trial history
- [ ] Implement Blockers & Action Items section
  - [ ] Awaiting gate review
  - [ ] Failing gates
  - [ ] Promotion ready
- [ ] Implement Recent Changes section with semantic categorization

### API Endpoints Needed

```typescript
GET /api/repos/:org/:repo/dashboard
Response: {
  repository: Repository;
  spec?: Spec;
  candidates: Candidate[];
  trials: Trial[];
  blockers: DashboardBlockedItem[];
  recentChanges: SemanticChange[];
}
```

### Files

```
ui/src/
├── pages/
│   └── repos/
│       ├── RepoPage.tsx
│       └── [org]/
│           └── [repo].tsx
```

### Acceptance Criteria

- [ ] Repo homepage shows repository metadata
- [ ] If linked to spec, shows spec details
- [ ] Candidates from this repo are listed with status
- [ ] Semantic categorization of recent changes is visible

---

## Phase 4: Semantic Intelligence Layer ⬜

**Goal:** Leverage Beehive's semantic understanding for smarter dashboards.

### Tasks

- [ ] Add semantic categorization to recent changes
  - [ ] Classify changes by type: contract_update, delta_surface_change, spec_stage_change, candidate_submitted, gate_passed, gate_failed, trial_decided, promotion
  - [ ] Calculate significance scores (0-100) based on impact
- [ ] Add "Why this matters" explanations
  - [ ] For specs: show declared delta surface diffs
  - [ ] For candidates: show specific gate failures
  - [ ] For trials: show comparison metrics
- [ ] Implement "Predictive recommendations"
  - [ ] "You might want to review candidate X" (based on trust score, spec alignment)
  - [ ] "Spec Y is similar to ones you've implemented before"

### Data Model Extensions

```typescript
// Add to types.ts
interface DashboardBlockedItem {
  type: 'gate_review' | 'trial_decision' | 'spec_feedback';
  entityId: string;
  entityType: 'candidate' | 'trial' | 'spec';
  specId: string;
  reason: string;
  waitingSince: number;
  priority: 'high' | 'medium' | 'low';
}

interface SemanticChange {
  id: string;
  type: 'contract_update' | 'delta_surface_change' | 'spec_stage_change' | 
        'candidate_submitted' | 'gate_passed' | 'gate_failed' |
        'trial_decided' | 'promotion';
  entityType: string;
  entityId: string;
  oldValue?: any;
  newValue?: any;
  timestamp: number;
  actorId: string;
  significance: number; // 0-100
  summary?: string; // Human-readable description
}
```

### Acceptance Criteria

- [ ] Recent changes show categorized types with icons
- [ ] Significance scores affect ordering (high significance first)
- [ ] "Why this matters" tooltips/explanations are available

---

## Phase 5: Real-time & Polish ⬜

**Goal:** Make dashboards feel live and responsive.

### Tasks

- [ ] Add WebSocket/Server-Sent Events for real-time updates
  - [ ] Gate verdict changes
  - [ ] Trial decisions
  - [ ] Spec stage changes
  - [ ] Candidate submissions
- [ ] Add loading states and error handling
- [ ] Add empty states with helpful messages
- [ ] Add keyboard navigation
- [ ] Add accessibility (ARIA labels, screen reader support)
- [ ] Add responsive design for mobile
- [ ] Add dark mode support

### Acceptance Criteria

- [ ] Dashboard updates in real-time without page refresh
- [ ] All pages pass accessibility audit
- [ ] Mobile layout is usable
- [ ] Dark mode is functional

---

## Component Library

### New Components Needed

| Component | Purpose | Status |
|-----------|---------|--------|
| `EntityHeader` | Consistent header for detail pages | ⬜ |
| `MetricChart` | Simple bar/line chart for metrics | ⬜ |
| `Timeline` | Event timeline for history | ⬜ |
| `CodeViewer` | Syntax-highlighted contract display | ⬜ |
| `Modal` | Create/edit dialogs | ⬜ |
| `Toast` | Notifications | ⬜ |
| `EmptyState` | Empty state with illustrations | ⬜ |
| `LoadingSpinner` | Loading indicator | ⬜ |
| `Badge` | Generic badge (extends StageBadge, ScoreBadge) | ⬜ |

### Existing Components to Extend

- [ ] `StageBadge` — Add more entity types if needed
- [ ] `ScoreBadge` — Add tooltips with detailed breakdown
- [ ] `ProgressBar` — Add animated variants
- [ ] `CandidateCard` — Add hover states, quick actions
- [ ] `TrialCard` — Add winner/loser indicators

---

## API Contract

### Endpoints Summary

```
GET /api/dashboard/my-work              → User's personalized dashboard
GET /api/orgs/:org/dashboard            → Organization dashboard
GET /api/repos/:org/:repo/dashboard     → Repository dashboard
GET /api/dashboard/blocked             → Items blocked on current user
GET /api/dashboard/recent-changes      → Recent changes (with semantic categorization)
```

### Query Parameters

All dashboard endpoints support:
- `limit` — Number of items per section (default: 10)
- `since` — Only show items after this timestamp
- `filter` — Filter by entity type, stage, etc.

---

## File Structure Target

```
ui/src/
├── components/
│   ├── layout/
│   │   ├── Header.tsx
│   │   ├── Footer.tsx
│   │   └── Navigation.tsx
│   ├── common/
│   │   ├── DataTable.tsx
│   │   ├── Modal.tsx
│   │   ├── Toast.tsx
│   │   ├── EmptyState.tsx
│   │   └── LoadingSpinner.tsx
│   ├── display/
│   │   ├── EntityHeader.tsx
│   │   ├── MetricChart.tsx
│   │   ├── Timeline.tsx
│   │   ├── CodeViewer.tsx
│   │   ├── Badge.tsx
│   │   ├── StageBadge.tsx (existing)
│   │   ├── ScoreBadge.tsx (existing)
│   │   └── ProgressBar.tsx (existing)
│   └── forms/
│       └── ...
├── pages/
│   ├── HomePage.tsx
│   ├── specs/
│   │   ├── SpecsPage.tsx (existing)
│   │   └── SpecDetailPage.tsx
│   ├── candidates/
│   │   ├── CandidatesPage.tsx (existing)
│   │   └── CandidateDetailPage.tsx
│   ├── trials/
│   │   ├── TrialsPage.tsx (existing)
│   │   └── TrialDetailPage.tsx (existing)
│   ├── orgs/
│   │   ├── OrgsPage.tsx
│   │   └── OrgPage.tsx
│   ├── repos/
│   │   ├── ReposPage.tsx
│   │   └── RepoPage.tsx
│   └── actors/
│       ├── ActorsPage.tsx
│       └── ActorDetailPage.tsx
├── hooks/
│   ├── useDashboard.ts
│   ├── useApi.ts
│   ├── usePagination.ts
│   └── useFilters.ts
├── utils/
│   ├── formatters.ts
│   ├── mockFactories.ts
│   └── semanticUtils.ts
├── services/
│   ├── api.ts (existing)
│   └── mockApi.ts
├── types/
│   └── dashboard.ts (new dashboard-specific types)
├── App.tsx
└── main.tsx
```

---

## Testing Strategy

### Unit Tests

- [ ] All new components have snapshot tests
- [ ] All hooks have unit tests
- [ ] Utility functions have unit tests

### Integration Tests

- [ ] Dashboard pages render with mock data
- [ ] Navigation between pages works
- [ ] API integration works with real and mock data

### E2E Tests

- [ ] User can navigate from root to org to repo
- [ ] User can filter and sort on all list pages
- [ ] User can click through to detail pages

---

## Open Questions

1. Should we show "Specs I can implement" based on agent capabilities (trust score, past performance)?
2. Should blocked items be ordered by priority or by waiting time?
3. Should recent changes be grouped by day or by type?
4. Should we show estimated time to complete for stalled candidates?
5. How do we handle users with multiple organizations? Should we show a org selector?

---

## Related Documents

- [MILESTONES.md](../MILESTONES.md) — Overall project milestones
- [AGENTS.md](../AGENTS.md) — Agent working conventions
- [TYPES-CLEANUP-PLAN.md](../TYPES-CLEANUP-PLAN.md) — Type system cleanup

---

## Changelog

| Date | Author | Changes |
|------|--------|---------|
| 2026-10-11 | @bailey | Initial draft |
