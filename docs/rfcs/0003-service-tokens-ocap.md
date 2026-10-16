---
RFC-0003
---

# RFC: Service Tokens & Object-Capability Model

**Status:** Implemented (Retrospective)  
**Date:** 2026-10-12 (Approximate, based on commit aeec713)  
**Author:** Maintainer / Architecture Team  
**Related:** ADR-0005 (Organizational Memory), MILESTONES.md M5/M6.2  
**Supersedes:** None

---

## Summary

This retrospective RFC documents the decision to implement **service-scoped object-capability (OCAP) tokens** as the authentication and authorization model for Beehive. This replaced the legacy `/api/service-accounts` endpoint with a more granular, capability-based system where actors (agents and humans) receive tokens limited to specific services and resources.

---

## Motivation

### The Problem

The initial implementation used a monolithic service account model with repo-wide tokens. This had several issues:

1. **Over-permissive** - Tokens granted access to entire repositories
2. **No scoping** - Couldn't limit agents to specific services or paths
3. **Legacy API** - Used `/api/service-accounts` endpoint which didn't align with capability model
4. **No lifecycle integration** - Service accounts weren't integrated with DO lifecycle

### Requirements

✅ **Service-level granularity** - Tokens scoped to specific services, not entire repos
✅ **Path restrictions** - Capabilities with path restrictions for fine-grained access
✅ **Time-bound** - Tokens with expiration and limited lifetime
✅ **Actor-based** - Tokens tied to specific actors (agents or humans)
✅ **Lifecycle-aware** - DO lifecycle refuses service actor operations
✅ **Backward compatible** - Migration path from legacy service accounts

---

## Detailed Design

### Object-Capability Model

```
┌─────────────────────────────────────────────────────────────────┐
│                    OBJECT-CAPABILITY MODEL                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Actor (Agent or Human)                                               │
│       │                                                               │
│       ▼                                                               │
│  ┌─────────────────┐    ┌─────────────────┐                      │
│  │ Service Token   │◄───│ Capability Mint │                      │
│  │                 │    │ (Spec DO)       │                      │
│  │ - Actor ID      │    │                 │                      │
│  │ - Service ID    │    │ - service_token │                      │
│  │ - Capabilities  │    │ - role          │                      │
│  │ - Expiration    │    │ - permissions   │                      │
│  │ - Path Restr.   │    └─────────────────┘                      │
│  └────────┬────────┘         │                                      │
│             │                  │                                      │
│             ▼                  ▼                                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    Service Table                              │   │
│  │  - id: unique identifier                                      │   │
│  │  - name: human-readable service name                        │   │
│  │  - org_id: owning organization                                │   │
│  │  - path_prefix: URL path prefix for monorepo support         │   │
│  │  - created_at: timestamp                                       │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                      │
└─────────────────────────────────────────────────────────────────┘
```

### Service Tokens Table Schema

```sql
CREATE TABLE service_tokens (
    id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL REFERENCES actors(id),
    service_id TEXT NOT NULL REFERENCES services(id),
    capabilities_json TEXT NOT NULL,  -- JSON array of capability strings
    path_restrictions_json TEXT,       -- JSON array of path patterns
    expires_at INTEGER NOT NULL,        -- Unix timestamp
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    is_active BOOLEAN NOT NULL DEFAULT 1,
    FOREIGN KEY (service_id) REFERENCES services(id)
);
```

### Capability System

**Capabilities are fine-grained permissions:**

```typescript
type Capability = 
  | 'service:read'        // Read service metadata
  | 'service:write'       // Modify service
  | 'service:delete'      // Delete service
  | 'repo:read'          // Read repository
  | 'repo:write'         // Push to repository
  | 'repo:admin'         // Admin operations
  | 'spec:read'          // Read spec
  | 'spec:claim'         // Claim spec for implementation
  | 'candidate:create'    // Create candidate
  | 'candidate:promote'   // Promote candidate
  | 'issue:create'        // Create issues
  | 'issue:comment'       // Comment on issues
  | 'trial:create'        // Create trials
  | 'gate:run'           // Run gates
  | 'metrics:read'       // Read metrics
  | 'admin:purge'        // Purge data (maintainer only)
  | 'admin:tombstone'    // Tombstone records (maintainer only)
;
```

### Migration from Legacy Service Accounts

**Old System (Legacy):**
- Endpoint: `/api/service-accounts`
- Scope: Entire repository
- Token type: Bearer token with repo-wide access

**New System (Service Tokens):**
- Endpoint: `/api/service-tokens`
- Scope: Specific service with path restrictions
- Token type: OCAP token with fine-grained capabilities

**Migration Path:**
1. Auto-register services from existing repos
2. Generate service tokens for existing service accounts
3. Phase out `/api/service-accounts` endpoint
4. Update all clients to use new token system
5. DO lifecycle refuses service actor operations (backstop)

---

## Alternatives Considered

### Alternative 1: Traditional RBAC

**Pros:**
- Familiar model for most developers
- Simple to understand

**Cons:**
- ❌ Not aligned with object-capability philosophy
- ❌ Role explosion with many services
- ❌ No natural scoping to services
- ❌ Doesn't integrate with capability minting (M6.2)

**Why Rejected:** Doesn't align with Beehive's capability-based architecture

### Alternative 2: Per-Repository Tokens Only

**Pros:**
- Simpler implementation
- Matches GitHub's model

**Cons:**
- ❌ No service-level granularity
- ❌ Can't limit agents to specific paths
- ❌ Less secure for multi-service repos (monorepos)

**Why Rejected:** Doesn't provide needed granularity

### Alternative 3: External Auth Service

**Pros:**
- Centralized authentication
- Could integrate with existing IAM

**Cons:**
- ❌ External dependency (violates Workers-native rule)
- ❌ Higher latency
- ❌ Additional operational complexity

**Why Rejected:** Violates non-negotiable rule #4

---

## Consequences

### Positive

✅ **Fine-grained access control** - Agents can be limited to specific services and paths
✅ **Better security** - Principle of least privilege enforced
✅ **Monorepo support** - Path prefixes enable monorepo patterns
✅ **Lifecycle integration** - DO lifecycle refuses service actor operations
✅ **Future-proof** - Aligns with M6.2 capability minting

### Negative

⚠️ **Migration complexity** - Required phased migration from legacy system
⚠️ **Token management** - More tokens to manage than repo-wide approach
⚠️ **Client updates** - All clients needed updates to use new token system

### Neutral

ℹ️ **Learning curve** - Object-capability model may be unfamiliar to some developers

---

## Implementation History

From the git history:

- **Commit aeec713:** "service tokens end to end (actor per account, service_tokens table, m5->m6 additive), retire legacy /api/service-accounts, DO lifecycle refuses service actors"
- This was part of M5→M6 additive migration
- Service tokens table added to schema
- Legacy `/api/service-accounts` endpoint retired
- All workers updated to validate service tokens

---

## Lessons Learned (Retrospective)

### What Went Well

✅ **Smooth migration** - Auto-registration of services worked well
✅ **Backward compatibility** - Legacy tokens continued to work during transition
✅ **Granular control** - Service-level scoping provides needed flexibility
✅ **Monorepo support** - Path prefix handling works for complex repos

### Challenges Faced

⚠️ **Token distribution** - Getting tokens to the right agents was initially complex
⚠️ **Client updates** - Required updates to many worker clients
⚠️ **Capability design** - Defining the right capability granularity took iteration

### Design Decisions That Held Up

✅ **Service table** - Having first-class services enables proper scoping
✅ **Path restrictions** - Allows fine-grained access within repos
✅ **Actor-based** - Tying tokens to actors prevents token sharing
✅ **Migration path** - Auto-registration made migration smooth

---

## Open Questions

- Should we support capability delegation (agents can grant sub-capabilities)?
- How do we handle capability revocation for compromised tokens?
- Should capabilities have time-based restrictions beyond expiration?
- How do we audit capability usage for security monitoring?

---

## Future Enhancements

- **Capability inheritance** - Services can inherit capabilities from parent orgs
- **Temporal capabilities** - Time-of-day or day-of-week restrictions
- **Conditional capabilities** - Capabilities based on SLO status or other conditions
- **Capability groups** - Predefined sets of capabilities for common roles

---

## References

- [ADR-0005: Organizational Memory](../decisions/0005-org-memory.md) - Recording trust and outcomes
- [MILESTONES.md](../MILESTONES.md) - M5 and M6.2 milestone details
- [OCAP-CI-PLAN.md](../OCAP-CI-PLAN.md) - Related OCAP planning document
- [OPS.md](../OPS.md) - Operational documentation
- [Commit aeec713](https://github.com/bailey-coding/beehive/commit/aeec713) - Implementation commit

---

*This is a retrospective RFC documenting the service tokens and object-capability model that was implemented as part of the M5→M6 migration. This system provides fine-grained access control aligned with Beehive's capability-based architecture.*
