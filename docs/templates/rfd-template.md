---
RFD-NNNN
---

# RFD: [Short Title]

**Status:** Draft  # Draft, Proposed, Active Review, Accepted, Rejected, Implemented, Archived
**Date:** YYYY-MM-DD
**Author:** [Your name/handle]
**Related:** [RFD-XXXX, ADR-XXXX, Spec-XXXX if applicable]
**Supersedes:** [RFD-XXXX if applicable]

## Summary

[One paragraph explanation of the proposal. What is being proposed and why?]

## Motivation

[Why is this change needed? What problem does it solve? What opportunity does it enable?]

### User Impact
[How will this affect end users?]

### Business Impact
[What are the business or strategic benefits?]

## Detailed Design

### Overview
[High-level description of the proposal.]

### Goals
- [Goal 1]
- [Goal 2]
- [Goal 3]

### Non-Goals
- [What is explicitly NOT part of this proposal.]

### Components

#### Component 1: [Name]
[Description of the component.]

#### Component 2: [Name]
[Description of the component.]

### Data Model Changes

[If applicable, describe changes to the data model, database schema, or API contracts.]

```typescript
// Example schema changes
interface NewType {
  field1: string;
  field2: number;
}
```

### API Changes

[Describe any new or modified API endpoints.]

**New Endpoints:**
- `POST /api/v1/endpoint` - [Description]
- `GET /api/v1/endpoint/:id` - [Description]

**Modified Endpoints:**
- `GET /api/v1/existing` - [What changed and why]

### Worker Changes

[Which workers are affected? What new workers are needed?]

**New Workers:**
- `beehive-new-worker` - [Purpose]

**Modified Workers:**
- `beehive-existing` - [What changes and why]

### Specification Changes

[What specs need to be created or modified?]

- **New Specs:** [List]
- **Modified Specs:** [List]

### Configuration Changes

[Any new environment variables, configuration files, or deployment requirements.]

**New Environment Variables:**
- `NEW_VARIABLE` - [Description and default value]

**Modified Configuration:**
- [What configuration files need updating.]

## Drawbacks

[What are the downsides or trade-offs of this proposal?]

- [Drawback 1 and its impact]
- [Drawback 2 and its impact]

## Alternatives Considered

### [Alternative 1: Name]
[Description of the alternative.]

**Pros:**
- [Advantage 1]
- [Advantage 2]

**Cons:**
- [Disadvantage 1]
- [Disadvantage 2]

**Why not chosen:** [Reason for rejection.]

### [Alternative 2: Name]
[Description of the alternative.]

**Pros:**
- [Advantage 1]

**Cons:**
- [Disadvantage 1]

**Why not chosen:** [Reason for rejection.]

## Impact Analysis

### Affected Components
- [List all components that will need changes.]

### Breaking Changes
- [List any breaking changes for users or other components.]
- [Migration strategy if applicable.]

### Performance Considerations
- [Any performance implications, positive or negative.]
- [Expected latency changes.]
- [Expected throughput changes.]

### Security Considerations
- [Any security implications.]
- [New attack surfaces.]
- [Required security reviews.]

### Cost Considerations
- [Any cost implications (compute, storage, bandwidth).]

### Testing Considerations
- [What testing is needed?]
- [Any gaps in current testing approach.]

## Implementation Plan

### Phase 1: [Phase Name]
[What will be implemented in this phase?]

**Deliverables:**
- [Deliverable 1]
- [Deliverable 2]

**Timeline:** [Estimated duration]

### Phase 2: [Phase Name]
[What will be implemented in this phase?]

**Deliverables:**
- [Deliverable 1]

**Timeline:** [Estimated duration]

### Rollout Strategy
[How will this be deployed?]

- **Canary:** [Description]
- **Flag-gated:** [Description]
- **Full deployment:** [Description]

### Rollback Plan
[How can this be rolled back if issues arise?]

## Open Questions

- [Question 1 that needs to be resolved before implementation.]
- [Question 2 that needs clarification.]

## Future Work

[What related work could follow this proposal?]

- [Future enhancement 1]
- [Future enhancement 2]

## References

- [Link to related documents, discussions, or external resources]
- [RFD-XXXX: Related RFD]
- [ADR-XXXX: Related ADR]
- [Spec-XXXX: Related Spec]
