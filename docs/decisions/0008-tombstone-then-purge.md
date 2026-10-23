---
ADR-0008
---

# ADR: Ledger data is removed by tombstone first, then a guarded maintainer purge

**Status:** Accepted · **Date:** 2026-10-15
**Author:** unattributed (written 2026-10-17 from repo evidence, not by the decision-maker)
**Related:** `docs/MILESTONES.md` (M1 ledger lifecycle), `docs/OPS.md` "Ledger cleanup", RFO-2026-10-13, RFO-2026-10-14 (reserved org)

> **Provenance:** this records a decision that is already practice. Every statement below cites its source;
> no alternatives or motivations are recorded in the repo, so none are invented here.

## Context

The Spec DO was append-only with no delete routes; the only wipe was `wrangler delete --name beehive
--force` plus a redeploy, which destroys all ledger data and secrets (`docs/OPEN-QUESTIONS.md`
2026-10-13, `docs/MILESTONES.md` M1). The lifecycle was implemented in `48a5f54` (2026-10-15) as the
m4 -> m5 migration.

## Decision

- **Tombstone first.** `DELETE /api/{organizations|repositories|specs|candidates}/<id>` soft-deletes
  with a cascade in one transaction. Ledger records are marked, not destroyed; tombstoned rows
  disappear from lists unless a maintainer passes `?include_deleted=1`. Refused (409) while an active
  promotion is in scope.
- **Then purge, maintainer-only.** `POST /api/admin/purge` is a dry run by default, needs
  `confirm` equal to the dry-run total, honours `PURGE_MIN_AGE_HOURS` (default 24), skips orgs with
  live descendants or service accounts, works in batches of at most 500 rows, and never purges
  `entity_history` or `purge_log`.
- **Roles.** A `maintainer` role gates purge; the first maintainer may grant it to itself only while
  none exists. Service tokens get 403 on every lifecycle route.
- **Reserved.** The `beehive-system` org and the `master` actor cannot be tombstoned or purged
  (`workers/shared/ledger-lifecycle.ts:18`, RFO-2026-10-14 reserved-org).

## Consequences

- Test data can be cleaned without deleting the worker; deleting the `beehive` worker stays the human-only
  last resort (AGENTS.md, `docs/OPS.md`).
- Purge can complete partially across batches; the audit trail is `purge_log`.
- Gaps and untested production behaviour: `docs/OPEN-QUESTIONS.md` "Ledger lifecycle".
