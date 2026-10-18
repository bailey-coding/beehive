---
category: planning
status: active
audience: human,agent
tags:
  - rfc
  - rfcs
  - proposals
  - governance
---

# Requests for Comments (RFCs)

**Purpose:** Propose and discuss new features, significant changes, and major enhancements to Beehive.

**Location:** `docs/rfcs/`

---

## 📋 What is an RFC?

A Request for Comments (RFC) is a formal proposal document that describes a new feature, enhancement, or significant change to Beehive. RFCs are:

- **Proactive** - Written before implementation begins
- **Collaborative** - Open for community feedback and iteration
- **Comprehensive** - Cover the what, why, and how of the proposal
- **Versioned** - Can be accepted, modified, or rejected

---

## 📁 Current RFCs

| Number | Title | Status | Date | Author |
|--------|-------|--------|------|--------|
| [RFC-0001](./0001-oracle-ladder-architecture.md) | Oracle Ladder Architecture | Implemented (Retrospective) | 2026-10-09 | unattributed |
| [RFC-0002](./0002-workers-native-stores.md) | Workers-Native Stores Architecture | Implemented (Retrospective) | 2026-10-09 | unattributed |
| [RFC-0003](./0003-service-tokens-ocap.md) | Service Tokens (capability model not built) | Implemented (Retrospective) | 2026-10-16 | unattributed |
| [RFC-0004](./0004-canary-deploy-rollback.md) | Canary Deploy + Auto-Rollback System | Implemented (Retrospective) | 2026-10-16 | unattributed |
| [RFC-0005](./0005-shadow-router-cache.md) | Shadow Router In-Isolate Caching | Implemented (Retrospective) | 2026-10-16 | unattributed |
| [RFC-0006](./0006-ledger-compare-and-swap.md) | Ledger Compare-and-Swap with Tournament State | Implemented (Retrospective) | 2026-10-16 | unattributed |
| [RFC-0007](./0007-two-tier-token-authentication.md) | Two-Tier Internal Token Authentication | Implemented (Retrospective) | 2026-10-16 | unattributed |
| [RFC-0008](./0008-verified-identity-user-tokens.md) | Verified identity and user tokens (M12) | Accepted | 2026-10-17 | agent (m12-rfc) |

---

## 📝 RFC Lifecycle

```
Draft → Proposed → Active Review → Accepted/Rejected → Implemented/Archived
```

### Status Definitions

- **Draft** - Work in progress, not yet ready for review
- **Proposed** - Ready for community feedback
- **Active Review** - Under active discussion and iteration
- **Accepted** - Approved for implementation
- **Rejected** - Declined, with rationale documented
- **Implemented** - Feature is complete and merged
- **Archived** - No longer relevant or superseded

---

## 🎯 When to Create an RFC

Create an RFC when proposing:

✅ New user-facing features or capabilities
✅ Major changes to existing features
✅ New API endpoints or significant API changes
✅ New worker services or major worker refactoring
✅ Changes to the core architecture or data model
✅ New integration with external services
✅ Significant changes to the oracle ladder or promotion flow
✅ New types of specs or candidates
✅ Changes to authentication, authorization, or security models

❌ **Do NOT** create an RFC for:
- Simple bug fixes
- Minor improvements to existing features
- Documentation-only changes
- Internal refactoring that doesn't affect the public interface
- Changes that are purely implementation details

---

## 📄 RFC Template

Use this template when creating a new RFC. Save as `docs/rfcs/NNNN-short-title.md` where NNNN is the next available number.

```markdown
---
RFC-NNNN
---

# RFC: [Short Title]

**Status:** Draft  # Draft, Proposed, Active Review, Accepted, Rejected, Implemented, Archived
**Date:** YYYY-MM-DD
**Author:** [Your name/handle]
**Related:** [RFC-XXXX, ADR-XXXX, Spec-XXXX if applicable]
**Supersedes:** [RFC-XXXX if applicable]

## Summary

[One paragraph explanation of the proposal.]

## Motivation

[Why is this change needed? What problem does it solve? What opportunity does it enable?]

## Detailed Design

### Overview
[High-level description of the proposal.]

### Components
[Break down the proposal into its main components.]

### Data Model Changes
[If applicable, describe changes to the data model, database schema, or API contracts.]

### Worker Changes
[Which workers are affected? What new workers are needed?]

### Specification Changes
[What specs need to be created or modified?]

### Configuration Changes
[Any new environment variables, configuration files, or deployment requirements.]

## Drawbacks

[What are the downsides or trade-offs of this proposal?]

## Alternatives Considered

### [Alternative 1]
[Description, pros, cons, and why it wasn't chosen.]

### [Alternative 2]
[Description, pros, cons, and why it wasn't chosen.]

## Impact Analysis

### Affected Components
- [List components that will need changes.]

### Breaking Changes
- [List any breaking changes for users or other components.]

### Performance Considerations
- [Any performance implications, positive or negative.]

### Security Considerations
- [Any security implications.]

## Implementation Plan

### Phase 1: [Phase Name]
[What will be implemented in this phase?]

### Phase 2: [Phase Name]
[What will be implemented in this phase?]

### Rollout Strategy
[How will this be deployed? Canary, flag-gated, etc.]

## Open Questions

- [Question 1]
- [Question 2]

## References

- [Link to related documents, discussions, or external resources]
```

---

## 🔢 Numbering Scheme

RFCs are numbered sequentially using 4-digit zero-padded numbers (0001, 0002, ...). The number is assigned when the RFC is first proposed (moved from Draft to Proposed status).

---

## 📊 RFC Workflow

### 1. Draft
- Copy the template to `docs/rfcs/NNNN-short-title.md`
- Fill in the initial details with **Draft** status
- Work locally, gather early feedback from collaborators

### 2. Propose
- Move status to **Proposed**
- Create a PR for the RFC document itself
- Announce the RFC for community review

### 3. Active Review
- Gather feedback from maintainers and contributors
- Iterate on the proposal based on feedback
- Address concerns and answer questions
- Update the RFC document with revisions

### 4. Decision
- Maintainers discuss and make a final decision
- Update status to **Accepted** or **Rejected**
- If rejected, document the rationale clearly
- If accepted, move to implementation

### 5. Implementation
- Implement the accepted RFC
- Update status to **Implemented** once complete
- Reference the RFC in PRs and commit messages

### 6. Archive
- Update status to **Archived** if the RFC becomes irrelevant
- Keep for historical reference

---

## 🎭 Relationship to Other Artifacts

RFCs fit into the broader Beehive documentation workflow:

```
RFC → ADR → Spec → Candidate → Promotion → SLO Outcome → RFO
```

- **RFC**: Proposes a new feature or major change (this document)
- **ADR**: Records architectural decisions made during RFC review or implementation
- **Spec**: Machine-readable contract for the implemented feature
- **Candidate**: Implementation of the spec
- **Promotion**: Deployment through the oracle ladder
- **SLO Outcome**: Measured results in production
- **RFO**: Post-implementation analysis and learnings

See also:
- [ADR Process](../decisions/README.md)
- [RFO Process](../rfos/README.md)
- [Specs](../specs/README.md)

---

## 🔍 Finding RFCs

To find relevant RFCs:

```bash
# List all RFCs
grep -l "^RFC-" docs/rfcs/*.md

# Search RFC content
grep -r "search term" docs/rfcs/

# Find RFCs by status
grep "Status:" docs/rfcs/*.md
```

---

## 📝 Maintenance

- **Adding an RFC:** Update this README with a new entry in the Current RFCs table
- **Updating an RFC:** Edit the file directly, update status as needed
- **Accepting/Rejecting:** Update status, add decision rationale as a comment or in the document
- **Superseding:** Create a new RFC and reference the old one in the Supersedes field

---

*For questions about the RFC process, contact maintainers or open a discussion.*
