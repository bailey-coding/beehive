---
ADR-0007
---

# ADR: Edge authentication is fail-closed on every fetch entry point

**Status:** Accepted · **Date:** 2026-10-14
**Author:** unattributed (written 2026-10-17 from repo evidence, not by the decision-maker)
**Related:** RFC-0007 (Spec DO tier tokens), RFC-0003 (service tokens), AGENTS.md "Deployment Topology & Ops"

> **Provenance:** this records a decision that is already practice. Every statement below cites its source;
> no alternatives or motivations are recorded in the repo, so none are invented here.

## Context

Every Beehive worker with a fetch handler is reachable on a public `workers.dev` URL. The rule is
stated in AGENTS.md and implemented in `workers/shared/auth.ts`, which first appears in the initial
public release (`bbccf9e`, 2026-10-14); no earlier record of the decision exists in the repo.

## Decision

- Each worker requires `Authorization: Bearer <API_AUTH_TOKEN>` on every route, including `/health`
  and local dev.
- `API_AUTH_TOKEN` unset -> 503 (auth not configured), never open. Wrong or missing token -> 401.
- Clients read the token from `BEEHIVE_API_TOKEN` (`.env`); local e2e uses `local.apiToken` in
  `tests/e2e/config.ts`, which must match `.dev.vars`.

## Consequences

- An unconfigured worker is unreachable instead of open; a missing secret shows up as 503.
- Plain `/health` is not a public liveness probe: monitors need the token (`scripts/prod-health.sh`).
- This is the edge layer only. Service tokens (`bh_svc_`, RFC-0003) and the Spec DO's own two tiers
  (RFC-0007) are separate layers on top.
