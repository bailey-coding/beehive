---
RFD-0007
---

# RFD: Two-Tier Internal Token Authentication for Spec DO

**Status:** Implemented (Retrospective)  
**Date:** 2026-10-16 (commit 36c0716, 07:10 UTC)  
**Author:** unattributed (backfilled from git history)  
**Related:** RFD-0003 (Service Tokens; its service tokens are end-user bearer tokens checked at the edge, a separate layer), ADR-0002 (Coordination State Storage)  
**Supersedes:** None

---

## Summary

This retrospective RFD documents the **two-tier internal token authentication system** implemented for Spec Durable Object routes. The system provides different levels of access control for different types of operations, with a fail-closed approach to authentication.

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

> **Audit 2026-10-17 (`docs/RECORDS-AUDIT.md`):** the original design listed routes that do not
> exist (`DELETE /api/organizations/:id`, `POST /api/ledger/purge`, `POST /api/service-tokens`),
> sent tokens as `Authorization: Bearer`, and showed a `workers/shared/specDoClient.ts`
> pseudocode class. Replaced from `workers/shared/spec-do-auth.ts` (commit 36c0716).

Any worker with the cross-script `SPEC_DO` binding can call the Spec DO directly, so the DO checks
tokens of its own, independent of the edge's `API_AUTH_TOKEN` (`workers/shared/auth.ts`).

- **Tier 1, `SPEC_DO_INTERNAL_TOKEN`**, header `X-Beehive-Internal`: required on every DO route.
  Every worker that calls the DO holds it (api, gate-workflow, queue-consumer, preview-manager,
  candidate-service, shadow-router, scientist-comparator, canary-worker, promotion-worker).
- **Tier 2, `SPEC_DO_ADMIN_TOKEN`**, header `X-Beehive-Admin`, additionally on admin routes
  (`isAdminRoute`): `POST /internal/tombstone`, `POST /internal/purge`,
  `POST /internal/actors/:id/role`, everything under `/internal/service-accounts*`, and
  `PATCH /api/actors/:id/promotion-authority`. Only the `beehive` API worker is given the admin
  token. `/internal/service-tokens/verify` (the edge's per-request check) is tier 1.
- **Fail-closed order** (`specDoAuthGate`, runs before routing): the DO's own
  `SPEC_DO_INTERNAL_TOKEN` unset -> 503; admin route and `SPEC_DO_ADMIN_TOKEN` unset -> 503;
  missing or wrong tier-1 header -> 401; admin route with missing or wrong admin header -> 403.
  Comparison is constant-time (`timingSafeEqual`). Token values are never logged.
- **Shared stub.** Callers use `getSpecDoStub(env)`, which attaches that worker's tokens (the
  admin header only on admin routes); nobody sets the headers by hand.
- Tokens are Workers secrets or `.dev.vars`/start-script vars; deploy impact is in `docs/OPS.md`
  ("Spec DO internal tokens", deploy checklist step 0).

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
- Implemented in `workers/shared/spec-do-auth.ts` (new file; `workers/shared/auth.ts` is the edge `API_AUTH_TOKEN` check)
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

- [RFD-0003: Service Tokens & OCAP](../rfds/0003-service-tokens-ocap.md) - User-facing token system
- [ADR-0002: Coordination State Storage](../decisions/0002-coordination-state.md) - Spec DO as authoritative store
- [AGENTS.md](../../AGENTS.md#non-negotiable-architectural-rules) - Fail-closed auth requirement
- [Commit 36c0716](https://github.com/bailey-coding/beehive/commit/36c0716) - Implementation commit
- [OPS.md](../OPS.md) - Operational documentation

---

*This is a retrospective RFD documenting the two-tier internal token authentication system for Spec DO routes. This system provides fail-closed authentication with differentiated access levels for internal worker-to-worker communication.*
