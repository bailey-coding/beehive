---
category: planning
status: A, B, C implemented on fix/recorder-flush (not pushed or deployed); item 4 done (fbd3820)
audience: human,agent
---

# Plan: purge cleanup of candidate Workers, subdomain pin, CI cleanup, dry-run for the root worker

Items from the maintainer's list (2026-10-25). The flaky shadow-router test (item 4) is done: `fbd3820` (cause: a fake-timer advance count that
missed the abort timer created late under load; 5/24 failed before, 0/32 after).

## A. CI dry-run for the root worker (item 2) and old-YAML cleanup

Finding: `ci-enhanced.yml` already runs `wrangler deploy --dry-run` for the nine `workers/*/wrangler.toml`; FOCUS.md's open item is stale. The gap is
the root `beehive` worker (`wrangler.toml`, `main = workers/api/index.ts`; the largest one, it hosts the Spec DO), which is never dry-run. A local
`npx wrangler deploy --dry-run` at the root works.

1. `ci-enhanced.yml` job `clean-install-build`: after the per-worker loop, install root dependencies and run the dry-run at the root
   (`--outdir /tmp/wrangler-output-beehive`). FAILED flag as for the others.
2. Cleanup (no branch protection or ruleset exists on `main`, checked with `gh api`, so no check name is required anywhere):
   - `ci.yml` runs typecheck + `npm test`, which CI Enhanced's `typecheck` and `unit-tests` jobs repeat, so every push runs the unit tests twice.
   - **Recommended:** delete `ci.yml` and `ci-skip.yml` (the no-op companion exists only for a required `CI` check that does not exist); rename
     `ci-enhanced.yml` to `ci.yml` with `name: CI`; update `.github/workflows/README.md`, `AGENTS.md` ("`.github/workflows/ci.yml`"), `docs/OPS.md`,
     `docs/SETUP.md` references. Result: one workflow, one run per push.
   - Alternative: keep both and only fix docs. Rejected: double cost, double flakes.
   - Note: if you later turn on required checks, add the skip companion back for the job names then.

## B. Pin the canary URL to the account subdomain (item 5)

`isAcceptableCanaryUrl(url)` accepts any `*.workers.dev`. Add an optional second argument `subdomain`: when given, the host must be
`<label>.<subdomain>.workers.dev` (exactly one more label level is not required: `<anything>.<subdomain>.workers.dev`).

- Source of the value: `WORKERS_SUBDOMAIN` (already a var on preview-manager, canary-worker config: `bz23711`). Add the same plain var to the root
  `wrangler.toml` (Spec DO route) and to `workers/shadow-router/wrangler.toml` (router).
- Spec DO `POST /canary-deployments` and `applyCanaryRefs` pass it. **Unset var = today's behaviour** (any `*.workers.dev`), so a worker
  deployed before its var exists, or a self-hoster without it, still works; production gets it with this change.
- The zod schema stays subdomain-agnostic (the canary worker's client cannot see the var); the DO route checks again after parsing.
- Mixed version: each side checks independently; old = looser, new = stricter, no ordering dependency. A preview-manager URL built from
  `WORKERS_SUBDOMAIN` always matches, because it is the same value.
- Tests: pinned accepts `x.bz23711.workers.dev`, rejects `x.evil.workers.dev`, `bz23711.workers.dev.evil.example`, other accounts; unset accepts any;
  DO route 400; router ignores the ref.

## C. Wire the Worker DELETE into purge (item 1) - spine path in `beehive`

Today `DELETE /api/preview/canary/:id` on preview-manager deletes `beehive-candidate-<uuid>` (refused while a canary is live) and nothing calls it,
so purging a candidate leaves its Worker uploaded.

Design (cleanup before the irreversible delete, so a failure can be retried):
1. `PurgeResultSchema` gains optional `candidateIds: string[]` (the plan's candidate ids, already computed at `spec-do/index.ts:2460`). Additive.
2. `workers/api/lifecycle.ts` purge branch, for a real run (`dryRun:false`) only: take the candidate ids from a dry-run of the same request (the
   request is already two-step: dry run, then `confirm`), keep UUID ids, call `PREVIEW_MANAGER` `DELETE /api/preview/canary/<id>` for each
   (new service binding `PREVIEW_MANAGER` on the `beehive` worker), then call the real purge.
   - 404 / "did not exist" = fine. 409 (a live canary) or any other non-OK: **stop before purging** and answer 502/409 with the failing ids; nothing
     was purged, the call can be repeated.
   - Bounded: more than 40 candidate Workers in one purge (subrequest limit) answers 409 asking for a narrower prefix; deletes run in small
     parallel groups.
   - Old Spec DO (no `candidateIds` field): purge proceeds as today and the response says cleanup was skipped (fail-open only for this additive
     step; the purge itself is unchanged).
3. Service binding cycle check: `beehive` -> `beehive-preview-manager` (service), while preview-manager and the others bind the Spec DO via
   `script_name = "beehive"`. DO bindings are not service-binding edges; I will confirm with a `wrangler deploy --dry-run` and note it in
   `docs/OPEN-QUESTIONS.md` (first deploy to an empty account stays unverified, as documented).
4. Tests: fakes for the binding; order (deletes before purge), 404 tolerated, 409 aborts without purging, dry run never deletes, >40 refused, old DO
   without `candidateIds`. Docs: `docs/OPS.md` "Ledger cleanup", FOCUS.

Alternative considered: a script (`scripts/purge.sh`) doing the deletes outside the API. No spine change, but a purge through the API alone would
still orphan Workers. Not recommended.

## Order and review

A (small, CI), then B, then C (spine); one commit each; an independent agent review of B and C before any push. No push or deploy without a
separate go-ahead; the CI change only takes effect on GitHub.
