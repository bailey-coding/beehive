---
category: documentation
status: active
audience: human,agent
tags:
  - templates
  - documentation
---

# Documentation Templates

**Purpose:** Reusable templates for Beehive documentation artifacts.

**Location:** `docs/templates/`

---

## 📋 Available Templates

| Template | Purpose | Output Location |
|----------|---------|-----------------|
| [adr-template.md](./adr-template.md) | Architecture Decision Records | `docs/decisions/NNNN-name.md` |
| [rfd-template.md](./rfd-template.md) | Requests for Discussion | `docs/rfds/NNNN-name.md` |
| [rfo-template.md](./rfo-template.md) | Requests for Observation (Post-mortems) | `docs/rfos/YYYY-MM-DD-name.md` |

---

## 📝 How to Use a Template

### For ADRs (Architecture Decision Records)

1. Copy the template:
   ```bash
   cp docs/templates/adr-template.md docs/decisions/NNNN-short-title.md
   ```

2. Fill in the details:
   - Replace `NNNN` with the next ADR number
   - Update the title and metadata
   - Write the context, decision, and alternatives

3. Create a PR for review

4. See the [ADR Process](../decisions/README.md) for full workflow

### For RFDs (Requests for Discussion)

1. Copy the template:
   ```bash
   cp docs/templates/rfd-template.md docs/rfds/NNNN-short-title.md
   ```

2. Fill in the details:
   - Replace `NNNN` with the next RFD number
   - Start with **Draft** status
   - Complete all sections

3. Create a PR for the RFD document

4. See the [RFD Process](../rfds/README.md) for full workflow

### For RFOs (Requests for Observation)

1. Copy the template:
   ```bash
   cp docs/templates/rfo-template.md docs/rfos/YYYY-MM-DD-short-title.md
   ```

2. Fill in the details:
   - Use the date in the filename
   - Document the timeline, impact, and root cause
   - Identify action items

3. Create a PR for review

4. See the [RFO Process](../rfos/README.md) for full workflow

---

## 🎯 Template Guidelines

### Naming Conventions

- **ADRs:** `NNNN-short-description.md` (4-digit sequential number)
- **RFDs:** `NNNN-short-description.md` (4-digit sequential number)
- **RFOs:** `YYYY-MM-DD-short-description.md` (date-based)

### Required Sections

All templates include these essential sections:

- **Metadata** (Status, Date, Author, Related artifacts)
- **Summary/Context** (What and why)
- **Detailed Content** (The main body)
- **References** (Links to related documents)

### Optional Sections

Templates may include optional sections like:

- Alternatives Considered (ADR, RFD)
- Impact Analysis (RFD)
- Timeline (RFO)
- Action Items (RFO)

---

## 🔗 Relationship to Other Documentation

These templates support the Beehive documentation workflow:

```
RFD → ADR → Spec → Candidate → Promotion → SLO Outcome → RFO
```

- **RFD Template** → Create proposals for new features
- **ADR Template** → Record architectural decisions
- **RFO Template** → Document learnings from incidents

All three artifact types work together to provide a complete picture of:
- **What we're building** (RFDs)
- **How we decided to build it** (ADRs)
- **What we learned** (RFOs)

---

## 📚 Additional Resources

- [ADR Process and Index](../decisions/README.md)
- [RFD Process and Index](../rfds/README.md)
- [RFO Process and Index](../rfos/README.md)
- [Documentation Index](../README.md)
- [Architecture Document](../ARCHITECTURE.md)

---

## 🛠️ Creating New Templates

If you need a new template for a different type of documentation:

1. Review existing templates for consistent structure
2. Create the new template in this directory
3. Follow the same markdown format
4. Include clear instructions and examples
5. Update this README to reference it
6. Submit a PR for review

---

*For questions about templates or the documentation process, refer to the relevant process documents or contact maintainers.*
