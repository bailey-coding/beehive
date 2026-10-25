---
category: planning
status: implemented on fix/recorder-flush, not deployed (two commits)
audience: human,agent
---

# SF-8: sandbox runner takes the Artifacts namespace per request

Problem: fork-created candidate repos are recorded with `repositories.namespace = org.name` (`workers/spec-do/index.ts:1504`, and
`createFork` really creates them there). The runner reads `ARTIFACTS_NAMESPACE` (default `default`) and `preview-manager` refuses any other
namespace with 422 (`workers/preview-manager/index.ts:319-323`). So fork candidates can never get a canary build. The ledger is right; the
runner's fixed namespace is what does not fit. Background: `docs/OPEN-QUESTIONS.md` "Review of the post-review changes" (SF-8).

Decision (maintainer, 2026-10-25): the runner takes the namespace from the request. The ledger is not changed.

## Changes

1. `workers/sandbox-runner/build-sandbox.ts`
   - `BuildRequest` gains `namespace?: string`. `validateBuildRequest` accepts it only if it matches `NAMESPACE_RE` (line 85), else `BAD_REQUEST`.
   - `buildInner` uses `req.namespace ?? env.ARTIFACTS_NAMESPACE ?? 'default'` (line 253). The existing `NAMESPACE_RE` check stays.
   - **Coalescing key** (line 240) becomes `${namespace}/${repo}@${sha}`. Today two namespaces with the same repo name and commit would share one
     in-flight build and one result: a cross-namespace bundle leak. The effective namespace is resolved once, before the key.
   - `BuildResult` gains `namespace` (the namespace actually built from).
2. `workers/sandbox-runner/index.ts` (`/sandbox/build`, line ~110-135): the Durable Object name `build-${repo}-${sha8}` includes the namespace
   (a short hash or the slug); the response carries `namespace`. Stub mode returns the requested namespace.
3. `workers/preview-manager/bundle-source.ts`: the input gets `namespace`; the request body sends it. If the requested namespace is not
   `default`... see mixed-version below: the response `namespace` must equal the one sent, else a 502 `UNAVAILABLE` ("build service did not
   confirm the namespace"). `BuildResponseSchema` gets `namespace: z.string().optional()`.
4. `workers/preview-manager/index.ts` (lines 318-323): drop the 422 namespace refusal; pass `repo.namespace` through
   `createVersion({ ..., repoNamespace })` to the bundle source. `versions.ts` input type gets the field. `ARTIFACTS_NAMESPACE` on
   preview-manager and its `DEFAULT_ARTIFACTS_NAMESPACE` go away once nothing reads them (keep the runner's variable as the fallback).
5. Tests (unit, fakes only; no network):
   - runner: namespace validation (bad slug, `..`, `/`, empty, 65 chars), fallback to env then `default`, token minted and clone URL use the
     request namespace, gateway allow-list rejects another namespace's path, two namespaces with equal repo and sha do not coalesce.
   - preview-manager: request body carries the namespace, a missing or different echo is a 502, an echo that matches succeeds, a fork-style
     namespace (`my-org`) reaches the runner instead of a 422.
6. Docs: `docs/OPEN-QUESTIONS.md` (SF-8 resolved, with the decision), `docs/OPS.md` "Sandbox build container" (namespace per request,
   `ARTIFACTS_NAMESPACE` is only a fallback), `docs/FOCUS.md` (remove SF-8).

## Review findings folded in (reviewer ab04af8, 2026-10-25)

- **Org names vs `NAMESPACE_RE`.** The ledger accepts `my.org`, `_x`, `a b`, >64 chars; these fail `NAMESPACE_RE`, so such fork candidates would still
  be refused. Without a spine change: `preview-manager` checks `repo.namespace` against the same pattern and answers an explicit 422 naming the
  org (not the candidate). **Decision for the maintainer:** also validate org names at creation (Spine, Spec DO; breaks no existing row but rejects
  new odd names), and check what Artifacts itself accepts (`shared/artifacts.ts:120` interpolates the name into a URL unescaped). Not in this change.
- **Org-name validation is in scope (maintainer, 2026-10-25), spine item, done by hand or reviewed by a human.** `createOrganization`
  (`spec-do/index.ts:1200`) throws the existing `BadRequestError` (line 83) unless the name matches the shared namespace pattern (move
  `NAMESPACE_RE` to `workers/shared` so the runner, `preview-manager` and the Spec DO use one definition). Only new names are checked; existing
  rows are untouched, so there is no migration and no outage risk. Mixed version: an old Spec DO accepts odd names, the new `preview-manager`
  check (explicit 422) still covers them. Tests: `my.org`, `_x`, `a b`, 65 chars, empty are 400; `my-org`, `Org_1` pass; existing e2e/unit
  org names (`test-org-e2e-*`) still pass; the CLI/UI surface the 400 message. Before merging: grep existing prod org names via the API
  (read-only) to confirm none the UI creates flow would now break, and confirm what Artifacts accepts for a namespace (`shared/artifacts.ts:120`
  interpolates it unescaped; also `encodeURIComponent` it there).
- **Always send, never default silently.** `preview-manager` sends `namespace` on every request, `default` included. The runner rejects a present
  but non-string `namespace` (`null`, number) instead of falling back. A bad namespace maps to 422 with a code outside `CANDIDATE_FAULT_CODES`
  (`NOT_CONFIGURED`-style, "the repository's organization name cannot be built"), so it does not blame the candidate.
- **Echo location:** top level of the runner response, `{ success, bundle, namespace }` (not inside `bundle`). `BuildResponseSchema` marks it
  optional only so an old runner parses; `bundle-source.ts` then requires an exact match with the namespace sent, `default` included, else 502.
- **DO name:** `build-${ns}/${repo}-${sha8}` style with a delimiter that cannot occur in a namespace or repo (`/`); today's `build-${repo}-${sha8}`
  is already ambiguous.
- **Stub mode** runs `validateBuildRequest` with the namespace and echoes it.
- **Other edits:** `preview-manager/types.ts:53-54`, `index.ts:37`, `versions.ts` `CanaryVersionInput` gets `repoNamespace` (the mock client
  ignores it), `tests/preview.test.ts:381,427` (assert the old 422; rewrite), `tests/bundle-source.test.ts` (echo cases), `OPEN-QUESTIONS.md:870,982`.
- **Extra tests:** `my.org` org gets a clear 422; echo missing for a `default` repo; coalescing test runs two namespaces concurrently on one DO
  instance; non-string namespace.
- Old preview-manager + new runner: a fork repo is still refused by the old 422, so it is safe (documented in the table).

## Mixed-version window (all ten workers deploy at once, no order)

| preview-manager | runner | Result |
|---|---|---|
| old | new | old sends no namespace, runner falls back to env/`default`: today's behaviour |
| new | old | old runner ignores the extra field and would build `default/<repo>`: a **different repo** if the name exists there. Prevented by the echo check: old runner returns no `namespace`, so preview-manager fails 502. Fails closed. |
| new | new | intended |

The echo check is what makes "new preview-manager, old runner" safe; it must not be relaxed for `default`-namespace repos either (the echo is
required whenever the request carried a namespace).

## Security notes

- The runner can now mint read tokens for any namespace that matches `NAMESPACE_RE`, not just one. Bounded by: only `preview-manager` reaches
  `/sandbox/build` (service binding plus bearer token), the namespace comes from the ledger (not from a user request), tokens are read-only for
  one repo with a 240 s TTL, and the gateway is scoped by `props.namespace`/`props.repo`.
- A namespace that does not exist or a repo the token cannot read fails at token mint or clone (`CLONE_FAILED`, 422).
- Org names are **not** validated at creation (`spec-do/index.ts:1200` checks only duplicates; `api/index.ts:144` passes the body through), so
  the runner re-validates with `NAMESPACE_RE` (and `validGatewayProps`, line 110, re-checks it as defense in depth).

## Out of scope

SF-8 only. Validating canary ids/urls in the Spec DO, the purge route and the CI dry-run are separate items.
