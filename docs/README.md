# Beehive Documentation Index

This directory contains all Beehive project documentation, organized for **human discovery** and **LLM retrieval**.

---

## 🗺️ Quick Navigation

| Category | Purpose | Key Files |
|----------|---------|-----------|
| **📚 Governance** | ADRs, RFCs, RFOs - decision records and proposals | [decisions/](./decisions/README.md), [rfcs/](./rfcs/README.md), [rfos/](./rfos/README.md) |
| **🏗️ Architecture** | Core system design, non-negotiable rules, orchestration spine | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| **🎯 Milestones & Planning** | Roadmaps, phased implementation, timeline tracking | [MILESTONES.md](./MILESTONES.md), [FOCUS.md](./FOCUS.md) |
| **📜 Feature Specs** | Detailed designs for specific capabilities | [SEMANTIC-NAVIGATION-PLAN.md](./SEMANTIC-NAVIGATION-PLAN.md), [UI-DASHBOARD-PLAN.md](./UI-DASHBOARD-PLAN.md) |
| **📋 Issue UX Flow** | End-to-end issue creation with agent assistance | [ISSUE-CREATION-INDEX.md](./ISSUE-CREATION-INDEX.md), [ISSUE-FLOW-SUMMARY.md](./ISSUE-FLOW-SUMMARY.md) |
| **🔍 Findings & Lessons** | Spike results, open questions, empirical validation | [OPEN-QUESTIONS.md](./OPEN-QUESTIONS.md) |
| **🛠️ Setup & Deployment** | Environment, configuration, Cloudflare integration | [SETUP.md](./SETUP.md), [ARTIFACTS-SETUP.md](./ARTIFACTS-SETUP.md) |
| **🔐 Auth & Integration** | OAuth, Statsig, external service wiring | [OAUTH-INTEGRATION.md](./OAUTH-INTEGRATION.md), [STATSIG-INTEGRATION.md](./STATSIG-INTEGRATION.md) |
| **✅ Verification & Testing** | Test plans, audit reports, execution results | [VERIFICATION.md](./VERIFICATION.md), [TEST-AUDIT-REPORT.md](./TEST-AUDIT-REPORT.md) |
| **📊 Phase Reports** | M1-M7 phase plans, reviews, merge reports | [M1-PLAN.md](./M1-PLAN.md), [M2-PLAN.md](./M2-PLAN.md), [M3-PLAN.md](./M3-PLAN.md), [M4-PLAN.md](./M4-PLAN.md), [M5-PLAN.md](./M5-PLAN.md) |

---

## 📚 Category Deep Dive

### 📚 Governance & Version Control
**Decision records, proposals, and retrospectives** - The Beehive Version Control System for documentation.

All artifacts follow the workflow: **RFC → ADR → Spec → Candidate → Promotion → SLO Outcome → RFO**

- [decisions/README.md](./decisions/README.md) - *ADR (Architecture Decision Records) process and index*
  - [ADR-0001: VCS Client Model](./decisions/0001-vcs-client-model.md)
  - [ADR-0002: Coordination State Storage](./decisions/0002-coordination-state.md)
  - [ADR-0003: Language Strategy](./decisions/0003-language.md)
  - [ADR-0004: CI and Builds](./decisions/0004-ci.md)
  - [ADR-0005: Organizational Memory](./decisions/0005-org-memory.md)
- [rfcs/README.md](./rfcs/README.md) - *RFC (Request for Comments) process for proposing features*
- [rfos/README.md](./rfos/README.md) - *RFO (Request for Observation) process for post-mortems and learnings*
- [templates/README.md](./templates/README.md) - *Reusable templates for ADRs, RFCs, and RFOs*

### 🏗️ Architecture
Core system design and inviolable rules. Start here to understand **how Beehive works**.

- [ARCHITECTURE.md](./ARCHITECTURE.md) - *The foundational architecture document*

### 🎯 Milestones & Planning
Strategic roadmaps and milestone definitions. Use these to understand **where we are and what's next**.

- [MILESTONES.md](./MILESTONES.md) - *All milestones from Spike to M7, plus M6.5 Semantic Navigation*
- [FOCUS.md](./FOCUS.md) - *Current focus areas and priorities*
- [CLI-PLAN.md](./CLI-PLAN.md) - *Command-line interface design*

### 📜 Feature Specifications
Detailed technical specifications for major features. Reference these when **implementing**.

- [SEMANTIC-NAVIGATION-PLAN.md](./SEMANTIC-NAVIGATION-PLAN.md) - *6-phase semantic codebase navigation*
- [UI-DASHBOARD-PLAN.md](./UI-DASHBOARD-PLAN.md) - *Dashboard UI with semantic intelligence*
- [ISSUE-CREATION-TECHNICAL-SPEC.md](./ISSUE-CREATION-TECHNICAL-SPEC.md) - *Spec-aware issue creation*
- [ISSUE-CREATION-UX-DESIGN.md](./ISSUE-CREATION-UX-DESIGN.md) - *User experience flow design*
- [ISSUE-FLOW-DIAGRAM.md](./ISSUE-FLOW-DIAGRAM.md) - *Visual flow diagram*
- [QUEUE-GATE-WIRING-PLAN.md](./QUEUE-GATE-WIRING-PLAN.md) - *Queue and gate integration*
- [SCIENTIST-COMPARATOR-PLAN.md](./SCIENTIST-COMPARATOR-PLAN.md) - *Scientist pattern implementation*
- [TEST-IMPLEMENTATION-PLAN.md](./TEST-IMPLEMENTATION-PLAN.md) - *Testing strategy*

### 📋 Issue UX Flow
Complete documentation for the spec-aware issue creation feature.

- [ISSUE-CREATION-INDEX.md](./ISSUE-CREATION-INDEX.md) - *Master index for issue flow docs*
- [ISSUE-FLOW-SUMMARY.md](./ISSUE-FLOW-SUMMARY.md) - *Executive summary and implementation phases*

### 🔍 Findings & Lessons
Empirical results, open questions, and learned lessons. **Critical for avoiding repeat mistakes**.

- [OPEN-QUESTIONS.md](./OPEN-QUESTIONS.md) - *All spike findings, deployment learnings, Artifacts behavior, session learnings*

### 🛠️ Setup & Deployment
How to run, deploy, and configure Beehive.

- [SETUP.md](./SETUP.md) - *Self-hosting guide and quick start*
- [ARTIFACTS-SETUP.md](./ARTIFACTS-SETUP.md) - *Cloudflare Artifacts configuration*
- [ARTIFACTS-INTEGRATION-PLAN.md](./ARTIFACTS-INTEGRATION-PLAN.md) - *Artifacts integration strategy*
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) - *Common issues and fixes*

### 🔐 Authentication & Integration
Third-party service integrations.

- [OAUTH-INTEGRATION.md](./OAUTH-INTEGRATION.md) - *GitHub OAuth flow*
- [OAUTH-QUICK-START.md](./OAUTH-QUICK-START.md) - *Rapid OAuth setup*
- [STATSIG-INTEGRATION.md](./STATSIG-INTEGRATION.md) - *Feature flag and metrics integration*

### ✅ Verification & Testing
Quality assurance and validation documentation.

- [VERIFICATION.md](./VERIFICATION.md) - *Verification approach and results*
- [TEST-AUDIT-REPORT.md](./TEST-AUDIT-REPORT.md) - *Comprehensive test audit*
- [CLOUDFLARE-DEPLOY-FAILURES-REPORT.md](./CLOUDFLARE-DEPLOY-FAILURES-REPORT.md) - *Deploy failure analysis*
- [FINAL-SUBMISSION-REVIEW.md](./FINAL-SUBMISSION-REVIEW.md) - *Submission review checklist*

### 📊 Phase Reports (M1-M7)
Complete historical record of each milestone phase.

Each phase has: **PLAN.md**, **REVIEW.md**, **MERGE-REPORT.md**, **IMPLEMENTATION-RESULTS.md**

- **Phase 1:** [PLAN](./PHASE-1-PLAN.md) | [REVIEW](./PHASE-1-REVIEW.md) | [MERGE](./PHASE-1-MERGE-REPORT.md)
- **Phase 2:** [PLAN](./PHASE-2-PLAN.md) | [REVIEW](./PHASE-2-REVIEW.md) | [MERGE](./PHASE-2-MERGE-REPORT.md)
- **Phase 3:** [PLAN](./PHASE-3-PLAN.md) | [REVIEW](./PHASE-3-REVIEW.md) | [MERGE](./PHASE-3-MERGE-REPORT.md) | [IMPLEMENTATION](./M3-IMPLEMENTATION-REVIEW.md) | [FIX](./M3-FIX-REPORT.md)
- **Phase 4:** [PLAN](./PHASE-4-PLAN.md) | [REVIEW](./PHASE-4-REVIEW.md) | [MERGE](./PHASE-4-MERGE-REPORT.md) | [IMPLEMENTATION](./M4-IMPLEMENTATION-RESULTS.md)
- **M1:** [PLAN](./M1-PLAN.md)
- **M2:** [PLAN](./M2-PLAN.md) | [REVIEW](./M2-M4-REVIEW-REPORT.md) | [VERIFICATION](./M2-VERIFICATION-RESULTS.md)
- **M3:** [PLAN](./M3-PLAN.md) | [REVIEW](./M3-IMPLEMENTATION-REVIEW.md) | [MERGE](./M3-MERGE-REPORT.md) | [RE-REVIEW](./M3-RE-REVIEW-REPORT.md)
- **M4:** [PLAN](./M4-PLAN.md)
- **M5:** [PLAN](./M5-PLAN.md)

### 🗑️ Deprecated / To Review
Documents that may be outdated or need consolidation.

- [REMOVE-ANY-PLAN.md](./REMOVE-ANY-PLAN.md)
- [TYPES-CLEANUP-PLAN.md](./TYPES-CLEANUP-PLAN.md)
- [ZOD-MIGRATION.md](./ZOD-MIGRATION.md)

---

## 🔍 Search Tips for LLMs

### By Category (Exact Match)
```
category: governance
category: architecture
category: findings
category: setup
category: planning
category: feature
category: verification
```

### By Milestone
```
M1, M2, M3, M4, M5, M6, M6.5, M7
```

### By Document Type
```
ADR, RFC, RFO, PLAN, REVIEW, REPORT, SPEC, SUMMARY, GUIDE, SETUP, INTEGRATION, TEMPLATE
```

### Common Patterns
- `*-PLAN.md` - Design and planning documents
- `*-REVIEW.md` - Critical assessments and feedback
- `*-REPORT.md` - Results and outcomes
- `*-SETUP.md` - Configuration guides
- `*-INTEGRATION.md` - Third-party service wiring

### Pro Tip for Agents
When searching for implementation details:
1. Check **[ARCHITECTURE.md](./ARCHITECTURE.md)** first for core principles
2. Look in **PLAN.md** files for the relevant milestone
3. Review **[OPEN-QUESTIONS.md](./OPEN-QUESTIONS.md)** for known issues and findings
4. Consult **IMPLEMENTATION-RESULTS.md** for prior work
5. For governance questions, see **[decisions/](./decisions/README.md)**, **[rfcs/](./rfcs/README.md)**, **[rfos/](./rfos/README.md)**

---

## 📝 Document Metadata Convention

All new documents should include frontmatter for better categorization:

```markdown
---
category: architecture  # One of: architecture, planning, feature, findings, setup, verification, integration
title: Human-readable title
status: active        # One of: draft, active, completed, deprecated
milestone: m4         # Optional: associated milestone
owner: team          # Optional: responsible party
audience: human,agent # Who should read this
tags:
  - semantic-navigation
  - spine-work
---

# Document Title
```

---

## 🛠️ Maintenance

- **Add new docs:** Update this README.md with a link in the appropriate category
- **Deprecate docs:** Move to the "Deprecated / To Review" section with a note
- **Rename docs:** Update all references in this file and cross-links

---

*This README.md is the canonical entry point for Beehive documentation. GitHub displays it automatically when viewing the `/docs` directory.*
