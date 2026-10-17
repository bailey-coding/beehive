---
category: architecture
status: active
audience: human,agent
tags:
  - adr
  - decisions
  - governance
---

# Architecture Decision Records (ADRs)

**Purpose:** Record and communicate architectural decisions for Beehive.

**Location:** `docs/decisions/`

---

## 📋 What is an ADR?

An Architecture Decision Record (ADR) is a short document that captures an important architectural decision made in the project, along with its context and consequences. ADRs are:

- **Lightweight** - A single markdown file, easy to create and maintain
- **Traceable** - Each has a unique number for reference
- **Discoverable** - Stored together in a dedicated directory
- **Versioned** - Can be superseded or deprecated but never deleted

---

## 📁 Current ADRs

| Number | Title | Status | Date |
|--------|-------|--------|------|
| [ADR-0001](./0001-vcs-client-model.md) | VCS Client Model | Accepted | 2026-10-09 |
| [ADR-0002](./0002-coordination-state.md) | Coordination State Storage | Accepted | 2026-10-09 |
| [ADR-0003](./0003-language.md) | Language Strategy | Accepted | 2026-10-09 |
| [ADR-0004](./0004-ci.md) | CI and Builds | Accepted | 2026-10-09 |
| [ADR-0005](./0005-org-memory.md) | Organizational Memory | Proposed | 2026-10-09 |
| [ADR-0006](./0006-deploy-path.md) | Deploy path: GitHub CI-only, one Artifacts push | Accepted | 2026-10-15 |
| [ADR-0007](./0007-fail-closed-edge-auth.md) | Fail-closed edge authentication | Accepted | 2026-10-14 |
| [ADR-0008](./0008-tombstone-then-purge.md) | Tombstone, then guarded purge | Accepted | 2026-10-15 |

---

## 📝 ADR Lifecycle

```
Proposed → Accepted → Deprecated → Superseded
         ↘    ↙
      Rejected
```

### Status Definitions

- **Proposed** - Decision under active consideration, open for feedback
- **Accepted** - Decision approved and implemented (or being implemented)
- **Deprecated** - Decision is no longer recommended but may still be in use
- **Superseded** - Replaced by a newer ADR
- **Rejected** - Decision was considered but not adopted

---

## 🎯 When to Create an ADR

Create an ADR when making a decision that:

✅ Has significant architectural impact (e.g., storage strategy, language choice)
✅ Will be difficult or expensive to change later
✅ Affects multiple components or workers
✅ Represents a cross-cutting concern
✅ Has multiple viable alternatives with different trade-offs
✅ Will need to be explained to future contributors

❌ **Do NOT** create an ADR for:
- Implementation details of a single module
- Simple bug fixes or minor improvements
- Decisions that can be easily reversed
- Matters of code style or formatting

---

## 📄 ADR Template

Use this template when creating a new ADR. Save as `docs/decisions/NNNN-description.md` where NNNN is the next available number.

```markdown
---
ADR-NNNN
---

# ADR: [Short Title]

**Status:** Proposed  # Proposed, Accepted, Deprecated, Superseded, Rejected
**Date:** YYYY-MM-DD
**Author:** [Your name/handle]
**Supersedes:** [ADR-XXXX if applicable]
**Related:** [ADR-XXXX, ADR-YYYY if applicable]

## Context

[Explain the problem or opportunity. What forces are at play? What are the constraints?]

## Decision

[State the chosen solution. Be concise and clear.]

## Alternatives Considered

### [Alternative 1]
[Description, pros, cons]

### [Alternative 2]
[Description, pros, cons]

## Consequences

[What becomes easier or harder to do? What are the trade-offs?]

## References

- [Link to relevant documents, discussions, or external resources]
```

---

## 🔢 Numbering Scheme

ADRs are numbered sequentially using 4-digit zero-padded numbers (0001, 0002, ...). The number is assigned when the ADR is created, not when it's accepted.

---

## 📊 ADR Workflow

### 1. Propose
- Copy the template to `docs/decisions/NNNN-short-title.md`
- Fill in the details with a **Proposed** status
- Create a PR for review

### 2. Discuss
- Gather feedback from maintainers and contributors
- Iterate on the proposal based on feedback
- Address concerns and questions

### 3. Accept/Reject
- Maintainers discuss and make a decision
- Update status to **Accepted** or **Rejected**
- If accepted, implement the decision

### 4. Maintain
- Keep ADRs up-to-date as the project evolves
- If a decision is reversed, create a new ADR that **Supersedes** the old one
- Mark old ADRs as **Deprecated** when they're no longer relevant

---

## 🔍 Finding ADRs

To find relevant ADRs:

```bash
# List all ADRs
grep -l "^ADR-" docs/decisions/*.md

# Search ADR content
grep -r "search term" docs/decisions/

# Find ADRs by status
grep "Status:" docs/decisions/*.md
```

---

## 🎭 Relationship to Other Artifacts

ADRs fit into the broader Beehive documentation workflow:

```
RFD/RFC → ADR → Spec → Candidate → Promotion → SLO Outcome → RFO
```

- **RFD/RFC** (Request for Discussion/Comments): Proposes new features or major changes
- **ADR**: Records architectural decisions that guide implementation
- **Spec**: Machine-readable contract defining expected behavior
- **Candidate**: Implementation of a spec
- **Promotion**: Successful deployment through the oracle ladder
- **SLO Outcome**: Measured results in production
- **RFO** (Request for Observation): Post-mortem or retrospective analysis

See also:
- [RFC Process](../rfcs/README.md)
- [RFO Process](../rfos/README.md)
- [Specs](../specs/README.md)

---

## 📝 Maintenance

- **Adding an ADR:** Update this README with a new entry in the Current ADRs table
- **Updating an ADR:** Edit the file directly, update status as needed
- **Superseding an ADR:** Create a new ADR and reference the old one in the Supersedes field
- **Deprecating an ADR:** Update its status to Deprecated, add a note explaining why

---

*For questions about the ADR process, refer to the [Architecture document](../ARCHITECTURE.md).*
