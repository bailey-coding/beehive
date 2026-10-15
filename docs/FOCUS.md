---
category: planning
status: active
audience: human,agent
---


*This document is a living focus tracker. Update it at the start/end of each session.
Completed items are removed, not struck through; history lives in git.*

**Last updated:** 2026-10-15

## Decide first

1. **22 failing e2e tests** (`tests/e2e/cross-worker-flows.test.ts`) call routes the workers
   don't implement (`/canary/slo/config`, `/shadow/config`, `/promotion/mode`, ...). Change
   the tests to the real routes (`/slo-status`, `/statsig/config`, `/promote/:id`), or
   implement the routes. Route table in `docs/SETUP.md`.
2. **Push** the 3 local commits on `main` (milestones, SETUP.md, e2e auth fix). A push
   deploys all ten workers via `.github/workflows/deploy.yml`.

## Open work

- **Typecheck:** 2 errors in `workers/api/ui-semantic.ts:1130,1135` (`root.children`
  possibly undefined). CI doesn't run typecheck, so deploys are unaffected.
- **Self-hosting gaps** (details in `docs/SETUP.md` section 2):
  - Workflow creates only 2 of 7 queues; add the other 5 to `deploy.yml` or document as-is.
  - Account ID, `ALLOWED_GITHUB_USERS` and the `bz23711` subdomain are hardcoded across
    `wrangler.toml`, `cli/`, `shadow-router/config.ts`, `tests/e2e/config.ts`, `scripts/`.
  - First deploy to an empty account is unverified (`beehive` <-> `beehive-gate-workflow`
    binding cycle may need two passes).
- **README drift:** says local e2e uses mocks (it makes real HTTP calls) and points to
  `docs/SETUP.md` as complete; update `README.md` and `tests/e2e/README.md`.
- **M3 spine items with no implementation:** DO facets, capability minting, ArtifactFS
  (`docs/MILESTONES.md`).

## Next demo (post-submission)

End-to-end live flow instead of click-and-scroll: create org -> repo -> issue, watch agents
propose a spec, then implement it, gate, shadow, promote. Depends on the open M4
agent-autonomy items (agent-created issues/specs, change-type classification).

## Queued milestones

M5 trust and governance, M6 semantic UI (mocked, in API worker), M6.2 OCAP CI, M6.5 semantic
navigation, M7 session provenance and intent index. See `docs/MILESTONES.md`.
