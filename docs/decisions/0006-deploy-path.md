---
ADR-0006
---

# ADR: Deploy path: GitHub is CI-only, one Artifacts push deploys all ten workers

**Status:** Accepted · **Date:** 2026-10-15
**Author:** unattributed (written 2026-10-17 from repo evidence, not by the decision-maker)
**Related:** ADR-0004 (CI and Builds), AGENTS.md rule 6, `docs/OPS.md` "Deploy flow"

> **Provenance:** this records a decision that is already practice. Every statement below cites its source;
> no alternatives or motivations are recorded in the repo, so none are invented here.

## Context

Production is ten Workers, each with its own wrangler config. `docs/OPS.md` ("Deploy flow (decided
2026-10-15)") is the source for everything below.

## Decision

- GitHub `main` is a source repo. `.github/workflows/ci.yml` (typecheck, unit tests) and
  `ci-enhanced.yml` (clean installs, migration tests, local e2e) run there. Nothing deploys from
  GitHub, and CI holds no Cloudflare secrets.
- Production deploys from the Cloudflare Artifacts repo `default/beehive` (remote `cf`). The
  maintainer runs `git pull origin main && git push cf main` (stated 2026-10-16). Workers' native
  Artifacts integration deploys on that push; no `npm run deploy:*` script is run by hand.
- **One push deploys all ten workers at once, with no ordering control** (stated 2026-10-16).
  One cannot deploy `beehive` alone and check its migration first.
- Agents never push to `cf` and never run `wrangler deploy` (`--dry-run` is fine).

## Consequences

- Every change must tolerate a mixed-version window: additive migrations, callers that cope with
  an old or new peer, no "deploy X first" dependency (AGENTS.md, working conventions).
- Secrets must exist before the push; the checklist in `docs/OPS.md` is written for a single push
  followed by verification (`scripts/prod-health.sh`).
- Rolling a worker back does not undo Spec DO migrations, which are additive and lazy.
- Open: where the Cloudflare credentials live for deploys, and how to roll back when all ten
  deploy together (`docs/OPS.md` TODO).
