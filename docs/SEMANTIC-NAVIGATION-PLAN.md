---
category: feature
status: active
milestone: m6.5
audience: human,agent
tags:
  - semantic-navigation
  - spine-work
---

# Semantic Navigation Plan

**Status:** Draft  
**Owner:** @bailey  
**Created:** 2026-10-14  
**Parent:** UI-DASHBOARD-PLAN.md, M6 Semantic Dashboard UI  
**Related:** M4 (semantic search integration), Phase 4 Semantic Intelligence Layer

---

## Overview

This document consolidates the **semantic navigation of the codebase and recent changes** feature across the Beehive platform. It unifies the currently distributed planning from M4, M6, and UI Dashboard Phase 4 into a single coherent roadmap.

**Core Value Proposition:** Enable users and agents to navigate the codebase intelligently through semantic understanding rather than manual file browsing, with recent changes surfaced contextually.

---

## Architecture Summary

### Semantic Navigation Layers

| Layer | Purpose | Status | Owner |
|-------|---------|--------|-------|
| **M4: Metadata Indexing** | Index repo metadata (not contents) for agent file discovery | Planned | Workers |
| **M6: UI Mockups** | Semantic search & changelog in UI (mocked) | Complete | API Worker |
| **M7+: Full Semantic** | Actual semantic processing of code/changes | Future | Spec DO + Workers |

### Key Components

1. **Semantic Index** - Indexes codebase entities (functions, classes, endpoints, types) with vector embeddings
2. **Change Tracker** - Tracks commits, diffs, and builds with semantic categorization
3. **Navigation Graph** - Builds relationships between entities (calls, imports, inheritance)
4. **UI Integration** - Surfaces semantic navigation in org/repo/spec views
5. **Agent Integration** - Enables agents to use semantic navigation for file discovery

---

## Phase Structure

### Phase 1: Foundation - Metadata Indexing
**Duration:** 1-2 days  
**Priority:** HIGH  
**Status:** Not Started  

**Goal:** Enable agents to find relevant files through metadata indexing (no content parsing yet).

**Tasks:**
- Index repo metadata (name, description, language, file structure)
- ArtifactFS lazy-loading integration
- Match files by metadata (language, path patterns)
- Return matched file list for agent hydration
- API endpoint: GET /api/repos/:id/metadata-index

**Deliverables:**
- workers/semantic-indexer/ - Metadata indexing service
- ArtifactFS integration with metadata filtering
- Unit tests for index consistency

**Success Criteria:**
- Agents can request relevant files by metadata
- ArtifactFS hydrates only matched files (<10% of full repo)
- Metadata index covers all repos in org

---

### Phase 2: Semantic Search Core
**Duration:** 2-3 days  
**Priority:** HIGH  
**Status:** Not Started  

**Goal:** Implement actual semantic search over codebase content.

**Tasks:**
- Choose embedding model (Cloudflare AI, local, or hybrid)
- Index codebase entities with vector embeddings
- Implement similarity search (cosine similarity on TF-IDF + embeddings)
- Add entity type classification (function, class, endpoint, type, test)
- API endpoint: POST /api/semantic/search
- Rate limiting and caching

**Deliverables:**
- workers/semantic-search/ - Semantic search service
- Vector index storage (D1 or KV)
- Embedding generation pipeline
- Similarity calculation utilities

**Success Criteria:**
- Sub-500ms search latency
- >80% recall on relevant code entities
- Supports filtering by entity type, language, repo

---

### Phase 3: Change Semantics
**Duration:** 2-3 days  
**Priority:** HIGH  
**Status:** Not Started  

**Goal:** Semantically categorize and track recent changes.

**Tasks:**
- Parse commit diffs into semantic change units
- Classify changes: bug-fix, feature, refactor, config, dependency, test
- Extract affected entities from diffs
- Build change dependency graph
- API endpoint: GET /api/repos/:id/recent-changes
- API endpoint: GET /api/specs/:id/related-changes

**Deliverables:**
- workers/change-tracker/ - Change parsing and categorization
- Change classification model
- Change graph storage (D1)
- Integration with existing commit/build data

**Success Criteria:**
- >90% accurate change classification
- Changes linked to affected specs/candidates
- Real-time updates on new commits

---

### Phase 4: Navigation Graph
**Duration:** 2-3 days  
**Priority:** MEDIUM  
**Status:** Not Started  

**Goal:** Build relationship graph for intelligent navigation.

**Tasks:**
- Extract call relationships (function -> function)
- Extract import relationships (file -> file)
- Extract type relationships (class -> parent, interface -> implementation)
- Build cross-repo dependency graph
- Implement graph traversal queries
- API endpoint: GET /api/semantic/graph

**Deliverables:**
- workers/navigation-graph/ - Graph building and query service
- Graph storage (D1 or Durable Object)
- Relationship extraction utilities

**Success Criteria:**
- Graph covers >95% of codebase entities
- Average path length <3 hops between related entities
- Sub-100ms graph query latency

---

### Phase 5: UI Integration
**Duration:** 3-5 days  
**Priority:** MEDIUM  
**Status:** Not Started  

**Goal:** Surface semantic navigation in the dashboard UI.

**Tasks:**
- Replace mocked semantic search with real implementation
- Replace mocked changelog with real semantic changes
- Add semantic navigation sidebar to repo pages
- Add Related Files section based on semantic similarity
- Add Impact Analysis for changes
- Add keyboard shortcuts for semantic navigation

**Deliverables:**
- Updated workers/api/ui.ts with real semantic data
- Updated UI pages in workers/api/ui-pages.ts
- Remove mockedLabel() from semantic sections

**Success Criteria:**
- All M6 semantic UI features use real data
- User can navigate codebase through semantic links
- Change history shows semantic categorization

---

### Phase 6: Agent Integration
**Duration:** 1-2 days  
**Priority:** MEDIUM  
**Status:** Not Started  

**Goal:** Enable agents to use semantic navigation for code exploration.

**Tasks:**
- Add semantic search capability to agent toolkit
- Add change tracking to agent context
- Add navigation graph queries to agent tools
- Update agent prompts with semantic navigation examples
- Capability-based access to semantic features

**Deliverables:**
- Agent tool: tools.semantic.search()
- Agent tool: tools.semantic.getChanges()
- Agent tool: tools.semantic.getGraph()
- Updated agent documentation

**Success Criteria:**
- Agents can find relevant files in <3 queries
- Agents can trace change impact automatically
- Semantic navigation reduces agent token usage by >20%

---

## API Endpoints

| Method | Endpoint | Description | Phase |
|--------|----------|-------------|-------|
| GET | /api/repos/:id/metadata-index | Metadata-based file index | Phase 1 |
| POST | /api/semantic/search | Semantic search over codebase | Phase 2 |
| GET | /api/repos/:id/recent-changes | Semantically categorized recent changes | Phase 3 |
| GET | /api/specs/:id/related-changes | Changes related to a spec | Phase 3 |
| GET | /api/semantic/graph | Query navigation graph | Phase 4 |
| GET | /api/dashboard/recent-changes | Dashboard recent changes (M6 upgrade) | Phase 5 |

---

## Data Model

### Semantic Index Entity

Fields: id, repoId, orgId, type (function/class/endpoint/type/file/test), name, path, signature, description, vector (embedding), metadata (language, visibility, lastModified, linesOfCode), relationships (type, targetId, strength), createdAt, updatedAt

### Change Entity

Fields: id, commitHash, repoId, orgId, timestamp, author, message, classification (bug-fix/feature/refactor/config/dependency/test/unknown), confidence, affectedEntities, diffSummary (filesChanged, linesAdded, linesRemoved), specLinks, candidateLinks, buildStatus, gateVerdicts

---

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Search accuracy | >80% recall | Relevant entities in top 10 results |
| Search latency | <500ms | P95 response time |
| Change classification | >90% accuracy | Correct classification vs manual review |
| Agent efficiency | >20% reduction | Token usage with vs without semantic nav |
| Code coverage | >80% | Entities with semantic index |
| User adoption | >60% | Users using semantic navigation weekly |

---

## Dependencies

### External
- Cloudflare AI (optional, for embeddings)
- Analytics Engine (for usage tracking)
- D1 (for index storage)
- Durable Objects (for graph queries)
- **Workers Memory** (for M4 submission package) - Useful for caching embeddings, semantic indices, and agent state to reduce computation costs and improve latency

### Internal
- ArtifactFS (Phase 1)
- Spec DO (all phases)
- Workers Builds (Phase 3)
- Queue system (Phase 3)
- Existing UI infrastructure (Phase 5)

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Embedding model costs | Medium | High | Start with local/open-source models |
| Index size growth | High | Medium | Implement sharding, TTL, lazy-loading |
| Latency with large codebases | Medium | High | Optimize vector index, add caching |
| Classification accuracy | Medium | Medium | Start with rule-based, add ML later |
| Agent abuse | Low | Medium | Capability-based rate limiting |

---

## Exit Criteria

**Phase 1 (Foundation):** Metadata index operational, ArtifactFS integration working, Agents can find files by metadata

**Phase 2 (Semantic Search):** Semantic search API operational, >80% recall on test queries, Sub-500ms latency

**Phase 3 (Change Semantics):** Change tracking operational, >90% classification accuracy, Changes linked to specs/candidates

**Phase 4 (Navigation Graph):** Graph covers >95% of entities, Sub-100ms query latency, Path finding works

**Phase 5 (UI Integration):** All M6 semantic features use real data, User testing complete, Performance acceptable

**Phase 6 (Agent Integration):** Agents using semantic navigation, Token usage reduced, Integration tests passing

---

## Related Documents

- [MILESTONES.md](../MILESTONES.md) - Overall project milestones
- [UI-DASHBOARD-PLAN.md](../UI-DASHBOARD-PLAN.md) - Dashboard-specific semantic features
- [M4-PLAN.md](../M4-PLAN.md) - Submission package with semantic search integration
- [ARCHITECTURE.md](../ARCHITECTURE.md) - Overall system architecture
