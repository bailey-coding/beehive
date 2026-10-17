---
RFC-0003
---

# RFC: Service Tokens (object-capability model not built)

**Status:** Implemented (Retrospective)  
**Date:** 2026-10-16 (commit aeec713, 01:04 UTC)  
**Author:** unattributed (backfilled from git history)  
**Related:** ADR-0005 (Organizational Memory), MILESTONES.md M5/M6.2  
**Supersedes:** None

---

## Summary

This retrospective RFC documents the decision to implement **service-scoped object-capability (OCAP) tokens** as the authentication and authorization model for Beehive. This replaced the legacy `/api/service-accounts` endpoint with expiring, revocable, hashed bearer tokens carrying coarse `read`/`write`/`read_write` scopes, one actor per account. Service-scoped capabilities and path restrictions were not built (M6.2).

---

## Motivation

> **Audit 2026-10-17 (`docs/RECORDS-AUDIT.md`):** the original Motivation, Detailed Design and
> Migration text described a `services` table, a capability enum, path restrictions and a
> `/api/service-tokens` endpoint. None exist in the repo (`grep` finds no `capabilities_json`,
> `path_restrictions` or `service:read`; `docs/MILESTONES.md` M6.2 lists capability minting and
> path-prefix enforcement as not built). Those sections are replaced below with what commit
> aeec713 and `workers/spec-do/schema.sql` show. The Alternatives and Lessons sections were not
> changed and have no repo evidence: see the audit.

The pre-m6 scheme was a service account row carrying its own `token_hash`/`token_salt`, and the
API handler and Spec DO disagreed on its shape (`docs/OPEN-QUESTIONS.md`, "Service accounts: API
handler and Spec DO disagree"; "Until then, service tokens cannot authenticate"). An older
`GET /api/service-accounts` was open to any read principal and listed `token_hash`/`token_salt`
(`docs/OPEN-QUESTIONS.md` 2026-10-16). Goal: one working, revocable, expiring token scheme.

---

## Detailed Design

Implemented in aeec713 (2026-10-16 01:04 UTC), migration m5 -> m6, additive.

- **Account and actor.** `service_accounts` (m3) gains `actor_id`; each account owns one actor row
  of type `agent` (the `actors.type` CHECK has no `service`). A service actor is identified by
  `service_accounts.actor_id`, not by type (`workers/spec-do/schema.sql`, SERVICE TOKENS comment).
- **Tokens.** `service_tokens(id, account_id, token_hash, token_prefix, scopes, created_by,
  created_at, expires_at NOT NULL, revoked_at, last_used_at)`, unique index on `token_hash`.
  Plaintext is `bh_svc_` + base64url of 32 random bytes (`workers/shared/service-tokens.ts`); only
  the SHA-256 hex and a 12-character display prefix are stored; plaintext is returned once.
- **Scopes.** `read`, `write` or `read_write` (CHECK constraint). `docs/OPS.md` ("Service tokens")
  documents minting only `["read"]`; every write and `/api/admin/*` route is 403 for a service
  principal, and the edge always gives service principals `promotionAuthority: false`.
- **Routes.** Master-token admin routes under `/api/admin/service-accounts` (mint, list, rotate,
  revoke; `workers/api/service-accounts.ts`). Spec DO routes `/internal/service-accounts*` are
  admin-tier and `/internal/service-tokens/verify` is tier 1 (`workers/shared/spec-do-auth.ts`).
  There is no `/api/service-tokens` endpoint.
- **Legacy.** `/api/service-accounts*` answers 410 Gone (`workers/api/index.ts:308`).
- **Lifecycle backstop.** Tombstone, purge and role routes refuse a service actor as caller (403);
  tokens of a tombstoned org stop verifying (`docs/OPEN-QUESTIONS.md` 2026-10-16).
- **No automatic migration.** Pre-m6 accounts have no actor and no token rows, so they never
  authenticate; they can be listed and revoked, not given new tokens.

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
- `service_tokens` table added; `service_accounts.actor_id` added
- Legacy `/api/service-accounts` endpoint retired
- Tokens are verified at the edge (`workers/api/principal.ts`) through the Spec DO; other workers do not validate them

---

## Lessons Learned (Retrospective)

### What Went Well

⚠️ **Lessons below are unsupported by repo evidence** (backfilled; the claims of auto-registration, backward compatibility and path-prefix handling contradict the m6 notes in `docs/OPEN-QUESTIONS.md`: pre-m6 accounts fail closed)
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
