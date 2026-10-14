# Beehive Specs

Machine-readable contracts that define the behavior of Beehive components.

## Spec Format

Each spec is a JSON document with the following structure:

```json
{
  "id": "unique-identifier",
  "name": "Human-readable name",
  "description": "What this spec defines",
  "contract": {
    "endpoints": [...],
    "models": {...},
    "workflow": {...}
  },
  "declaredDeltaSurface": [...],
  "organizationId": "...",
  "createdBy": "...",
  "stage": "draft | proposed | active | deprecated | archived",
  "createdAt": "..."
}
```

## Current Specs

| ID | Name | Stage | Description |
|---|---|---|---|
| spec-001 | URL Shortener v1 | active | Demo spec for basic URL shortening |
| spec-002 | Pre-merge Gate v1 | draft | First rung of the oracle ladder |

## Spec Lifecycle

```
draft -> proposed -> active -> deprecated -> archived
```

- **draft**: Work in progress, not ready for implementation
- **proposed**: Ready for review, not yet active
- **active**: Agents can implement candidates against this spec
- **deprecated**: Superseded by newer version, no new candidates
- **archived**: Historical record only

## Oracle Ladder Specs

The oracle ladder consists of multiple specs:

1. **Pre-merge Gate** (spec-002) - Automated tests, property checks, spec conformance
2. **Shadow Gate** (TBD) - Mirrored traffic, Scientist diff
3. **Train Gate** (TBD) - Projection slice, combined-candidate conformance
4. **Canary Gate** (TBD) - Small % live traffic, SLO monitoring
5. **Full Gate** (TBD) - 100% traffic, drift detection

## Adding a New Spec

1. Create a new JSON file in `docs/specs/` with a unique ID
2. Define the contract (endpoints, models, workflow)
3. Set `stage: "draft"` initially
4. Submit for review via PR
5. Once approved, update `stage: "active"`

## Spec Review Checklist

- [ ] Contract is machine-readable and unambiguous
- [ ] Declared delta surface is complete
- [ ] All endpoints have clear request/response schemas
- [ ] Workflow steps are well-defined
- [ ] Sandbox requirements are specified
- [ ] Retry policy is reasonable
- [ ] Passing score threshold is appropriate
