---
RFC-0007
---

# RFC: Two-Tier Internal Token Authentication for Spec DO

**Status:** Implemented (Retrospective)  
**Date:** 2026-10-13 (Approximate, based on commit 36c0716)  
**Author:** Maintainer / Architecture Team  
**Related:** RFC-0003 (Service Tokens), ADR-0002 (Coordination State Storage)  
**Supersedes:** None

---

## Summary

This retrospective RFC documents the **two-tier internal token authentication system** implemented for Spec Durable Object routes. The system provides different levels of access control for different types of operations, with a fail-closed approach to authentication.

---

## Motivation

### The Problem

The Spec DO needed an authentication mechanism that:
1. **Authenticates all callers** - Every caller to Spec DO routes must be authenticated
2. **Differentiates access levels** - Not all callers need the same level of access
3. **Fail-closed** - Missing or invalid tokens must result in denied access, not errors
4. **Workers-native** - Must work within Cloudflare Workers constraints
5. **Internal only** - These are internal worker-to-worker tokens, not user-facing auth

### Requirements

✅ **All callers authenticated** - No anonymous access to Spec DO
✅ **Two tiers of access** - Different tokens for different operation types
✅ **Fail-closed** - Invalid/missing tokens return appropriate errors (not 404)
✅ **Shared authed stub** - Common authentication logic for all callers
✅ **Worker-to-worker** - Internal service authentication, not user auth

---

## Detailed Design

### Two-Tier Token System

```
┌─────────────────────────────────────────────────────────────────┐
│                    TWO-TIER TOKEN AUTH                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    Tier 1: INTERNAL                            │   │
│  │  Token: SPEC_DO_INTERNAL_TOKEN                              │   │
│  │                                                             │   │
│  │  Required for:                                                 │   │
│  │  - All read operations on Spec DO                           │   │
│  │  - Standard write operations (non-destructive)              │   │
│  │  - Accessed by: beehive, beehive-gate-workflow,             │   │
│  │                beehive-shadow-router, beehive-preview-manager│   │
│  │                                                             │   │
│  │  Operations allowed:                                          │   │
│  │  - GET /api/specs/:id                                        │   │
│  │  - GET /api/candidates/:id                                    │   │
│  │  - POST /api/candidates (create)                              │   │
│  │  - POST /api/gate_verdicts (record)                          │   │
│  │  - POST /api/trials (create)                                 │   │
│  │  - Most CRUD operations                                      │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    Tier 2: ADMIN                               │   │
│  │  Token: SPEC_DO_ADMIN_TOKEN                                  │   │
│  │                                                             │   │
│  │  Required for:                                                 │   │
│  │  - Destructive operations only                               │   │
│  │  - Accessed by: beehive (edge router) only                   │   │
│  │                                                             │   │
│  │  Operations allowed:                                          │   │
│  │  - DELETE /api/organizations/:id (tombstone)                 │   │
│  │  - DELETE /api/repositories/:id (tombstone)                   │   │
│  │  - POST /api/ledger/purge (batched purge)                     │   │
│  │  - POST /api/service-accounts (legacy, retired)               │   │
│  │  - POST /api/service-tokens (service-scoped)                │   │
│  │  - Any operation that modifies role/service-accounts          │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                      │
│  Authentication Flow:                                               │
│                                                                      │
│  Request ━━━━━━━━► [ Authed Stub ] ━━━━━━━► Spec DO Route Handler      │
│                      │                                          │
│                      ├── Check Bearer Token                     │
│                      ├── Verify token exists                    │
│                      ├── Check token tier                        │
│                      ├── Verify operation allowed for tier       │
│                      │                                          │
│                      ├── 401 if wrong bearer                     │
│                      ├── 403 if operation not allowed for tier   │
│                      └── 503 if token missing (fail-closed)      │
│                                                                      │
└─────────────────────────────────────────────────────────────────┘
```

### Token Configuration

```bash
# Environment variables for Spec DO
SPEC_DO_INTERNAL_TOKEN=...  # Tier 1 token
SPEC_DO_ADMIN_TOKEN=...      # Tier 2 token (more privileged)
```

**Security Notes:**
- Tokens are configured via Workers secrets or `.dev.vars`
- Tokens are never committed to the repository
- Each worker that calls Spec DO must have the appropriate token

### Shared Authed Stub

All callers use a shared authenticated client stub:

```typescript
// workers/shared/specDoClient.ts (pseudocode)

class AuthedSpecDoClient {
  constructor(private token: string) {}
  
  async fetchSpec(id: string): Promise<Spec> {
    const response = await fetch(`${SPEC_DO_URL}/api/specs/${id}`, {
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    });
    
    // Fail-closed: always check Response.ok
    if (!response.ok) {
      throw new Error(`Spec DO returned ${response.status}: ${await response.text()}`);
    }
    
    return response.json();
  }
  
  async purgeLedger(): Promise<void> {
    // Requires admin token
    const response = await fetch(`${SPEC_DO_URL}/api/ledger/purge`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Spec DO returned ${response.status}`);
    }
  }
}

// Each worker gets a client with appropriate token
export const specDoClient = new AuthedSpecDoClient(process.env.SPEC_DO_INTERNAL_TOKEN);
export const specDoAdminClient = new AuthedSpecDoClient(process.env.SPEC_DO_ADMIN_TOKEN);
```

### Fail-Closed Behavior

From AGENTS.md: "Auth is fail-closed on every fetch entry point (`workers/shared/auth.ts`): missing `API_AUTH_TOKEN` → 503, wrong bearer → 401, including `/health` and local dev."

The two-tier system extends this:
- **Missing token** → 503 (Service Unavailable)
- **Wrong token (invalid)** → 401 (Unauthorized)
- **Right token, wrong tier** → 403 (Forbidden)
- **All internal routes** require authentication (no exceptions)

---

## Alternatives Considered

### Alternative 1: Single Token (No Tiers)

**Pros:**
- Simpler implementation
- Less configuration

**Cons:**
- ❌ No differentiation between operation types
- ❌ All callers have same permissions (too permissive)
- ❌ No protection against accidental destructive operations

**Why Rejected:** Doesn't provide needed access control granularity

### Alternative 2: Per-Worker Tokens

**Pros:**
- Fine-grained control per worker
- Can revoke individual workers

**Cons:**
- ❌ Token management complexity
- ❌ More configuration to maintain
- ❌ Doesn't group logically related operations

**Why Rejected:** Too complex for the access patterns needed

### Alternative 3: JWT with Claims

**Pros:**
- Standard approach
- Can encode claims in token

**Cons:**
- ❌ More complex implementation
- ❌ Token size considerations
- ❌ Key management overhead

**Why Rejected:** Unnecessary complexity; simple token tiers suffice

### Alternative 4: External Auth Service

**Pros:**
- Centralized authentication
- More features (rate limiting, etc.)

**Cons:**
- ❌ External dependency
- ❌ Violates Workers-native rule
- ❌ Higher latency

**Why Rejected:** Violates non-negotiable architectural rule #4

---

## Consequences

### Positive

✅ **Defense in depth** - Two tiers provide layered security
✅ **Fail-closed** - Missing/invalid tokens don't cause crashes
✅ **Clear separation** - Destructive operations require elevated privileges
✅ **Shared client** - Consistent authentication across all callers
✅ **Simple configuration** - Only two tokens to manage

### Negative

⚠️ **Token management** - Need to keep tokens secure and rotate periodically
⚠️ **Two-tier complexity** - Slightly more complex than single token
⚠️ **Worker configuration** - Each worker needs appropriate token

### Neutral

ℹ️ **Token scope** - Tokens apply to all routes at a tier, not route-specific

---

## Implementation History

From the git history:

- **Commit 36c0716:** "two-tier internal token check on Spec DO routes (SPEC_DO_INTERNAL_TOKEN on all callers, SPEC_DO_ADMIN_TOKEN on beehive only for purge/tombstone/role/service-accounts); shared authed stub for every caller; start script, probe worker, tests, docs"
- Part of authentication hardening
- Implemented in workers/shared/auth.ts
- Added to start scripts and probe worker
- Documentation updated

---

## Lessons Learned (Retrospective)

### What Went Well

✅ **Simple model** - Two tiers is easy to understand and manage
✅ **Fail-closed** - Proper error handling prevents crashes
✅ **Shared stub** - Consistent authentication across all workers
✅ **Clear separation** - Destructive vs non-destructive operations clearly divided

### Challenges Faced

⚠️ **Token distribution** - Getting tokens to all workers correctly
⚠️ **Local dev** - Needed to handle local development token configuration
⚠️ **Testing** - Needed to test authentication failure scenarios

### Design Decisions That Held Up

✅ **Two tiers** - Right balance between simplicity and security
✅ **Fail-closed** - Prevents authentication failures from causing cascading issues
✅ **Shared authed stub** - Consistent authentication pattern across all workers
✅ **Environment variables** - Secure token configuration

---

## Open Questions

- Should we add a third tier for read-only operations?
- Should tokens be time-limited (expiring)?
- Should we support token rotation without downtime?
- Should we add rate limiting per token?

---

## Future Enhancements

- **Token rotation** - Support rotating tokens without worker redeploy
- **Rate limiting** - Limit request rate per token
- **Audit logging** - Log authentication attempts for security monitoring
- **Token metadata** - Track token usage and origins

---

## References

- [RFC-0003: Service Tokens & OCAP](../rfcs/0003-service-tokens-ocap.md) - User-facing token system
- [ADR-0002: Coordination State Storage](../decisions/0002-coordination-state.md) - Spec DO as authoritative store
- [AGENTS.md](../../AGENTS.md#non-negotiable-architectural-rules) - Fail-closed auth requirement
- [Commit 36c0716](https://github.com/bailey-coding/beehive/commit/36c0716) - Implementation commit
- [OPS.md](../OPS.md) - Operational documentation

---

*This is a retrospective RFC documenting the two-tier internal token authentication system for Spec DO routes. This system provides fail-closed authentication with differentiated access levels for internal worker-to-worker communication.*
