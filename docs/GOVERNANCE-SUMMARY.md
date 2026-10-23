---
category: governance
status: active
audience: human,agent
tags:
  - governance
  - version-control
  - adr
  - rfc
  - rfo
---

# Beehive Documentation Version Control System - Summary

**Created:** 2026-10-16  
**Status:** Active  
**Related:** ADR-0005 (Organizational Memory)

---

## 🎯 Problem Statement

As noted in ADR-0005 (Organizational Memory), Beehive wasn't fully practicing what it preached regarding version control for documentation artifacts. While the repo had ADRs (Architecture Decision Records) and specs, there was no formalized process for:
- Proposing new features (RFCs)
- Documenting post-mortems and learnings (RFOs)
- Consistent templating for documentation artifacts
- Easy discovery and navigation of governance documents

---

## ✅ Solution Implemented

### 1. Formalized ADR Process (`docs/decisions/README.md`)

**Purpose:** Standardize how architectural decisions are recorded and maintained.

**Features:**
- Clear lifecycle: Proposed → Accepted → Deprecated → Superseded
- Decision criteria: When to create an ADR
- Complete template with context, alternatives, consequences
- Index of existing ADRs with status tracking
- Integration with RFC and RFO processes

**Existing ADRs (5):**
- ADR-0001: VCS Client Model
- ADR-0002: Coordination State Storage
- ADR-0003: Language Strategy
- ADR-0004: CI and Builds
- ADR-0005: Organizational Memory

---

### 2. RFC Process (`docs/rfcs/README.md`)

**Purpose:** Provide a structured way to propose new features and major changes.

**Features:**
- Lifecycle: Draft → Proposed → Active Review → Accepted/Rejected → Implemented
- Comprehensive template covering:
  - Motivation and goals
  - Detailed design and components
  - Impact analysis (breaking changes, performance, security)
  - Implementation plan and rollout strategy
  - Alternatives considered
- Clear criteria for when an RFC is needed
- Status tracking and search capabilities

---

### 3. RFO Process (`docs/rfos/README.md`)

**Purpose:** Document learnings from incidents, outages, near-misses, and production observations.

**Features:**
- Severity levels: SEV-1, SEV-2, SEV-3, Near-Miss, Observation
- Blameless post-mortem approach
- Timeline tracking with actionable items
- Template for root cause analysis
- Metrics tracking (MTTD, MTTR, recurrence rate)
- Special handling for near-misses in the oracle ladder

---

### 4. Reusable Templates (`docs/templates/`)

**Purpose:** Make it easy to create new governance documents with consistent structure.

**Templates provided:**
- `adr-template.md` - Architecture Decision Records
- `rfc-template.md` - Requests for Comments
- `rfo-template.md` - Requests for Observation

**Features:**
- Pre-filled metadata sections
- Clear section structure with examples
- Guidance on what to include in each section
- Links to related processes and documents

---

### 5. Documentation Integration

**Updated:**
- `docs/README.md` - Added Governance category with links to all new processes
- `docs/ARCHITECTURE.md` - Updated Design Decisions section with links to ADR process

**New navigation:**
- Quick Navigation table includes Governance
- Category Deep Dive has dedicated Governance & Version Control section
- Search tips updated for ADR, RFC, RFO document types
- Pro Tip for Agents references governance docs

---

## 🔄 The Beehive Documentation Workflow

All documentation artifacts now follow a consistent workflow:

```
┌─────────────────────────────────────────────────────────────────┐
│                    BEHIVE VERSION CONTROL SYSTEM                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                      │
│  RFC                ADR                Spec              Candidate │
│  ├── Propose ─────►├── Record ──────►├── Define ────────►┤ Impl    │
│  │   Feature      │   Decision       │   Contract       │         │
│  │                 │                  │                  │         │
│  └────────────────┴─────────────────┴──────────────────┴──────►│
│                                                                  Promotion│
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  ▼                                                                  ││
│  SLO Outcome ◄─────────────────────────── RFO                    ││
│  (Metrics, Alerts)                        (Post-mortem, Learning)││
│                                                                  ││
└─────────────────────────────────────────────────────────────────┘
     │                          │                          │
     ▼                          ▼                          ▼
  Proposal                 Decision               Retrospective
  (Future)                (Present)              (Past)
```

### Step-by-Step Flow:

1. **RFC (Request for Comments)**
   - Propose a new feature or major change
   - Gather feedback and iterate
   - Get acceptance from maintainers

2. **ADR (Architecture Decision Record)**
   - Record architectural decisions made
   - Document alternatives considered
   - Capture consequences and trade-offs

3. **Spec (Specification)**
   - Define machine-readable contract
   - Specify endpoints, models, workflows
   - Set declared delta surface

4. **Candidate (Implementation)**
   - Implement the spec
   - Multiple candidates can compete
   - Agents write leaf functions and tests

5. **Promotion**
   - Progress through oracle ladder:
     - Pre-merge gate
     - Shadow gate
     - Train gate
     - Canary gate
     - Full gate

6. **SLO Outcome**
   - Monitor performance and correctness
   - Track metrics and SLOs
   - Detect drift or issues

7. **RFO (Request for Observation)**
   - Document incidents and near-misses
   - Perform root cause analysis
   - Identify action items and improvements
   - Feed learnings back into the system

---

## 📋 Key Benefits

### 1. Organizational Memory
As stated in ADR-0005, this system ensures:
- Decisions are not lost or forgotten
- Losing candidates are not discarded - they're persisted as near-miss artifacts
- The lineage chain is first-class and queryable
- Trust scores can be calibrated by measured outcomes

### 2. Better Decision Making
- RFCs ensure features are well-thought-out before implementation
- ADRs capture the reasoning behind architectural choices
- RFOs prevent repeating the same mistakes

### 3. Improved Discoverability
- Central index in `docs/README.md`
- Consistent file naming and structure
- Search-optimized with category and type metadata
- Cross-references between related documents

### 4. Agent-Friendly
- Templates make it easy for agents to create new documents
- Clear workflows and processes to follow
- Metadata for better LLM retrieval
- Integrated with existing documentation patterns

### 5. Maintainability
- All documents have clear ownership
- Status tracking for each artifact
- Versioned and never deleted (only deprecated/superseded)
- Regular maintenance process documented

---

## 🎯 Getting Started

### For Contributors

1. **Propose a new feature:**
   ```bash
   cp docs/templates/rfc-template.md docs/rfcs/NNNN-your-feature.md
   # Fill in the template, then create a PR
   ```

2. **Record an architectural decision:**
   ```bash
   cp docs/templates/adr-template.md docs/decisions/NNNN-decision.md
   # Fill in the template, then create a PR
   ```

3. **Document an incident:**
   ```bash
   cp docs/templates/rfo-template.md docs/rfos/YYYY-MM-DD-incident.md
   # Fill in the template, then create a PR
   ```

### For Agents

1. Always check existing ADRs before making architectural changes
2. Reference relevant RFCs and ADRs in your work
3. Use the templates when creating new governance documents
4. Update the appropriate READMEs when adding new documents

### For Maintainers

1. Review new RFCs and provide feedback
2. Accept or reject RFCs based on alignment with project goals
3. Ensure ADRs are created for significant architectural decisions
4. Verify RFOs are created for all significant incidents

---

## 📚 Documentation Structure

```
docs/
├── README.md                    # Main documentation index
├── ARCHITECTURE.md              # Technical architecture
├── decisions/
│   ├── README.md                # ADR process and index
│   ├── 0001-vcs-client-model.md
│   ├── 0002-coordination-state.md
│   ├── 0003-language.md
│   ├── 0004-ci.md
│   └── 0005-org-memory.md
├── rfcs/
│   └── README.md                # RFC process and index
├── rfos/
│   └── README.md                # RFO process and index
└── templates/
    ├── README.md                # Templates index
    ├── adr-template.md
    ├── rfc-template.md
    └── rfo-template.md
```

---

## 🔗 Related Documents

- [ADR-0005: Organizational Memory](decisions/0005-org-memory.md) - The foundational ADR that inspired this system
- [ADR Process](decisions/README.md) - Detailed ADR workflow
- [RFC Process](rfcs/README.md) - Detailed RFC workflow
- [RFO Process](rfos/README.md) - Detailed RFO workflow
- [Documentation Index](README.md) - Main documentation entry point
- [Architecture](ARCHITECTURE.md) - Technical architecture with ADR references

---

## 🛠️ Future Enhancements

Potential improvements to consider:

- [ ] Automated validation of ADR/RFC/RFO format
- [ ] Script to generate new artifact numbers automatically
- [ ] Integration with GitHub Issues for tracking artifact status
- [ ] Metrics dashboard for RFC/ADR/RFO statistics
- [ ] Automated reminders for action items in RFOs
- [ ] LLM-optimized search index for governance documents

---

## ✅ Verification

The implementation has been:
- ✅ Committed to main branch
- ✅ Pushed to remote repository
- ✅ All templates tested and validated
- ✅ READMEs updated with new references
- ✅ Cross-linked with existing documentation

---

*This document provides an overview of the Beehive Documentation Version Control System. For detailed information on each process, refer to the respective README files in the `docs/decisions/`, `docs/rfcs/`, and `docs/rfos/` directories.*
