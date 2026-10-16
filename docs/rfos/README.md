---
category: findings
status: active
audience: human,agent
tags:
  - rfo
  - postmortem
  - retrospective
  - lessons
---

# Requests for Observation (RFOs)

**Purpose:** Document and share learnings from incidents, outages, near-misses, and production observations.

**Location:** `docs/rfos/`

---

## 📋 What is an RFO?

A Request for Observation (RFO) is a retrospective document that captures learnings from production incidents, outages, near-misses, or significant operational events. RFOs are:

- **Fact-based** - Focus on what actually happened, not speculation
- **Blameless** - Focus on process and system improvements, not individuals
- **Actionable** - Include concrete follow-up items and improvements
- **Shareable** - Help the entire team learn and prevent recurrence

> **Note:** The term "RFO" is used in Beehive to align with the organizational memory workflow:
> `RFD → ADR → Spec → Candidate → Promotion → SLO Outcome → RFO/NearMiss`
> 
> RFOs are similar to traditional post-mortems, incident reports, or retrospectives.

---

## 📁 Current RFOs

| Number | Title | Status | Date | Severity |
|--------|-------|--------|------|----------|
| [RFO-2026-10-13-ledger-lifecycle-finding](./2026-10-13-ledger-lifecycle-finding.md) | Ledger Lifecycle Finding - Spec DO Append-Only Gap | Actioned | 2026-10-13 | Near-Miss |
| [RFO-2026-10-14-promotion-routes-fix](./2026-10-14-promotion-routes-fix.md) | Promotion Routes Fix - Missing Spec DO Route Calls | Actioned | 2026-10-14 | SEV-2 |
| [RFO-2026-10-14-zod-build-failure](./2026-10-14-zod-build-failure.md) | Zod Dependency Resolution Failure in Worker Builds | Actioned | 2026-10-14 | SEV-2 |

---

## 📝 RFO Lifecycle

```
Draft → In Review → Published → Actioned → Archived
```

### Status Definitions

- **Draft** - Initial write-up, not yet reviewed
- **In Review** - Under review by maintainers and contributors
- **Published** - Approved and shared with the team
- **Actioned** - All follow-up items are complete
- **Archived** - Historical record, no longer active

### Severity Levels

- **SEV-1** - Major outage or incident affecting production
- **SEV-2** - Significant degradation or partial outage
- **SEV-3** - Minor issue with limited impact
- **Near-Miss** - No user impact, but could have been serious
- **Observation** - General learning or interesting finding

---

## 🎯 When to Create an RFO

Create an RFO when:

✅ A production incident or outage occurs
✅ A near-miss is detected (caught before affecting users)
✅ SLOs (Service Level Objectives) are violated
✅ A candidate promotion causes unexpected issues
✅ A rollback or emergency intervention is required
✅ An interesting or unexpected behavior is observed in production
✅ A pattern of issues suggests a systemic problem
✅ A successful experiment yields valuable learnings

❌ **Do NOT** create an RFO for:
- Individual bug fixes (use commit messages and PR descriptions)
- Routine maintenance or deployments
- Minor monitoring alerts with no real impact
- Issues that are immediately understood and resolved with no broader implications

---

## 📄 RFO Template

Use this template when creating a new RFO. Save as `docs/rfos/YYYY-MM-DD-short-title.md` or `docs/rfos/RFO-NNNN-short-title.md`.

### Option 1: Date-based numbering (recommended for frequent RFOs)
```markdown
---
RFO-YYYY-MM-DD
---

# RFO: [Short Title]

**Date:** YYYY-MM-DD
**Author:** [Your name/handle]
**Status:** Draft  # Draft, In Review, Published, Actioned, Archived
**Severity:** SEV-1/SEV-2/SEV-3/Near-Miss/Observation
**Related:** [RFC-XXXX, ADR-XXXX, Spec-XXXX, Candidate-XXXX if applicable]

## Summary

[One paragraph summary of what happened.]

## Timeline

| Time (UTC) | Event | Actor |
|------------|-------|-------|
| HH:MM | [Event description] | [Who/what triggered it] |
| HH:MM | [Event description] | [Who/what triggered it] |

## Impact

### Affected Components
- [List affected workers, services, or systems]

### User Impact
- [What was the impact on users? How many users affected?]

### Duration
- **Started:** HH:MM UTC
- **Detected:** HH:MM UTC
- **Mitigated:** HH:MM UTC
- **Resolved:** HH:MM UTC
- **Total Downtime:** X minutes/hours

## Root Cause

[Detailed analysis of what caused the issue. Be specific and technical.]

## Detection

[How was the issue detected? Monitoring, user reports, automated alerts?]

## Response

[What actions were taken to mitigate and resolve the issue?]

## Lessons Learned

### What Went Well
- [Things that worked well during the incident]

### What Could Be Improved
- [Areas for improvement]

### Action Items

| ID | Description | Owner | Priority | Status | Due Date |
|----|-------------|-------|----------|--------|----------|
| AI-1 | [Action item description] | [Owner] | High/Medium/Low | Not Started/In Progress/Done | YYYY-MM-DD |

## Follow-up

[Any additional context, related discussions, or references.]

## References

- [Link to relevant documents, metrics, logs, or external resources]
```

### Option 2: Sequential numbering
```markdown
---
RFO-NNNN
---

# RFO: [Short Title]

**Date:** YYYY-MM-DD
**Author:** [Your name/handle]
**Status:** Draft
**Severity:** SEV-1/SEV-2/SEV-3/Near-Miss/Observation
**Related:** [RFC-XXXX, ADR-XXXX, Spec-XXXX, Candidate-XXXX if applicable]

[Rest of the template is the same as Option 1]
```

---

## 🔍 Near-Miss RFOs

Near-misses are especially valuable for Beehive because they represent candidates that almost made it through the oracle ladder but were caught. These should document:

- What the candidate was trying to do
- Which gate caught the issue (Pre-merge, Shadow, Train, Canary, Full)
- What the actual vs. expected behavior was
- Why it wasn't caught earlier
- What improvements were made to prevent similar near-misses

---

## 📊 RFO Workflow

### 1. Initial Response
- Focus on mitigation and resolution first
- Take notes during the incident (timeline, actions, observations)
- Preserve relevant logs, metrics, and artifacts

### 2. Draft
- Write the initial RFO within 24-48 hours of resolution
- Include all known facts from the incident
- Identify root cause(s) and contributing factors
- Propose action items to prevent recurrence

### 3. Review
- Share with maintainers and relevant contributors
- Gather feedback and additional context
- Iterate on the document based on feedback

### 4. Publish
- Finalize the RFO
- Update status to **Published**
- Share with the broader team or community

### 5. Action
- Track progress on action items
- Update status to **Actioned** when all items are complete
- Verify that improvements are implemented and effective

### 6. Archive
- Update status to **Archived** for historical reference
- Keep available for future learning

---

## 🎭 Relationship to Other Artifacts

RFOs fit into the broader Beehive documentation workflow:

```
RFD/RFC → ADR → Spec → Candidate → Promotion → SLO Outcome → RFO
```

- **RFC/ADR**: Upstream decisions that led to the implemented system
- **Spec**: The contract that the candidate was implementing
- **Candidate**: The implementation that was promoted (or failed to promote)
- **Promotion**: The process of deploying through the oracle ladder
- **SLO Outcome**: The measured results that triggered the RFO
- **RFO**: This document - the learnings and improvements

See also:
- [RFC Process](../rfcs/README.md)
- [ADR Process](../decisions/README.md)
- [Specs](../specs/README.md)
- [OPEN-QUESTIONS](../OPEN-QUESTIONS.md) - For ongoing questions and findings

---

## 🔍 Finding RFOs

To find relevant RFOs:

```bash
# List all RFOs
grep -l "^RFO" docs/rfos/*.md

# Search RFO content
grep -r "search term" docs/rfos/

# Find RFOs by severity
grep "Severity:" docs/rfos/*.md

# Find RFOs by date
grep "Date:" docs/rfos/*.md
```

---

## 📝 Maintenance

- **Adding an RFO:** Update this README with a new entry in the Current RFOs table
- **Updating an RFO:** Edit the file to add new information or correct errors
- **Completing action items:** Update the status in the action items table
- **Archiving:** Update status to Archived when no longer active

---

## 📊 Metrics and Tracking

Track these metrics across RFOs:

- **MTTD (Mean Time to Detect)** - Average time from incident start to detection
- **MTTR (Mean Time to Resolve)** - Average time from detection to resolution
- **Recurrence Rate** - How often similar incidents occur
- **Action Item Completion Rate** - Percentage of action items completed
- **Action Item Lead Time** - Time from identification to completion

---

*For questions about the RFO process, contact maintainers or refer to [OPEN-QUESTIONS](../OPEN-QUESTIONS.md).*
