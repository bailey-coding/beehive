# Sandbox build plan: candidate bundles built in `beehive-sandbox-runner`

Status: **PLAN; Phase 0 partly done** (2026-10-24; findings in `docs/OPEN-QUESTIONS.md` "Sandbox build spike"). Containers work on the account, a registry-image deploy needs no local Docker, and node/git/esbuild bundling works in a 0.x sandbox; U3 (Artifacts clone with a read token at an exact sha) is verified; U1 (Dockerfile image built by the push deploy) is verified: sandbox-runner now ships a container (Phase 1a, `/sandbox/probe`). Not accepted for Phase 1. Spine-adjacent (agent code executes here); needs maintainer sign-off before
Phase 1. Goal: give `ApiWorkerVersionsClient` (`workers/preview-manager/versions.ts`) a real `CandidateBundleSource`, so a
candidate's commit can become a Worker version (canary deploys stop answering 501). Maintainer chose "build in
sandbox-runner" (2026-10-24).

## Where things stand (verified in the repo, 2026-10-24)

- `workers/sandbox-runner/index.ts` is a stub: `SANDBOX: unknown // future`, `env.SANDBOX.create()` and both
  `env.ARTIFACTS.get(...)` calls commented out, tasks in an in-memory `Map`, no `containers`/DO class in its `wrangler.toml`.
- `CandidateBundleSource = (input: CanaryVersionInput) => Promise<CandidateBundle>` is the seam (`versions.ts:65`);
  `workerVersionsClientFor(env, bundle?)` returns null (501) without it.
- Candidates must stay stateless (no DO/Container/Sandbox bindings, or Cloudflare issues no version URL).

## Platform facts (Cloudflare docs, fetched 2026-10-24)

- Sandbox SDK has **0.x** (`getSandbox`, `exec`, `readFile`; image `cloudflare/sandbox:0.12.x`) and **1.0** (own
  Durable Object class on `ctx.container`, `Files`, snapshots, per-hostname outbound handlers; Dockerfile copies
  `sandbox-shim` from `cloudflare/sandbox:1.0.x`, tag must match the npm package). Docs call 1.0 the path for new apps.
- Needs `containers` + a DO binding + a `new_sqlite_classes` migration in the worker's wrangler config, and
  `nodejs_compat`. The image is built at deploy. `wrangler dev` needs Docker.
- Billing is Containers usage + Workers + DO. Subrequest limits apply (RPC transport avoids them).
- 1.0 lets Worker code handle outbound requests per hostname, so tokens stay out of the container.

## Design

1. **sandbox-runner** (SDK 1.0): a `BuildSandbox` DO class with a container image (node + git + esbuild preinstalled).
   New route `POST /build {candidateId, specId, commitSha}` (existing `authGate`): start a sandbox keyed by
   `build-<candidateId>-<sha8>`, `git clone` the candidate repo from Artifacts at `commitSha` (Artifacts token supplied by
   the Worker's outbound handler, never in the container env), run the build, read the output with `Files`, stop the
   sandbox, return `CandidateBundle` JSON (`{mainModule, modules[], compatibilityDate, compatibilityFlags?}`).
2. **Build recipe** (decision needed): (a) repo contains a prebuilt `dist/index.js` and the sandbox only reads it (no
   code runs); or (b) `esbuild --bundle` an entry (`src/index.ts`) with **no `npm install` scripts** (`--ignore-scripts`),
   no network after clone, hard timeout, size cap (e.g. 1 MiB output). Recommended: ship (b) with (a) as fallback when
   `dist/index.js` exists.
3. **preview-manager**: add a service binding to `beehive-sandbox-runner`; a `CandidateBundleSource` that calls
   `POST /build`, validates the response with zod, checks `Response.ok`, and is passed to `workerVersionsClientFor`.
   Mode stays `WORKER_VERSIONS_MODE` unset until the maintainer flips it.
4. **Remaining wiring** (from `docs/FOCUS.md`): handle `versionsClient: 'api'` in the route response; delete
   `beehive-candidate-*` Workers on candidate purge; document env/token in `docs/OPS.md`.
5. **Local/CI**: containers need Docker. `scripts/start-e2e-workers.sh` and CI Enhanced must keep working without it:
   a `SANDBOX_MODE=stub` (like `WORKER_VERSIONS_MODE=stub`, needs `BEEHIVE_LOCAL_DEV=1`) returns a fixed tiny bundle.
6. **Mixed-version window**: additive only. New DO class migration is additive; new routes are called only by the new
   preview-manager; an old preview-manager never calls them.

## Risks / unknowns (each is a Phase 0 question)

- **U1 (go/no-go): does the maintainer's deploy path build and push the container image?** The deploy is the push to the
  Artifacts repo (native integration). Containers normally need `wrangler deploy` (Docker build + registry push). If the
  integration cannot build images, the whole option fails and (a)/prebuilt (no container) is the fallback.
- U2: Containers plan/entitlement on the account; instance type and `max_instances` cost ceiling.
- U3: how a sandbox authenticates to an Artifacts repo (git over HTTPS token vs the `ARTIFACTS` binding) and whether the
  outbound handler can inject it.
- U4: SDK 1.0 maturity/API drift (docs mark 0.x as legacy; 1.0 dated 2026-09-30).
- U5: untrusted code: build runs candidate-authored code. Isolation = one container per build, no secrets inside,
  no outbound beyond Artifacts.

## Phases

- **Phase 0 (spike, human-gated):** a throwaway worker `beehive-sandbox-spike` with a minimal container, deployed once with
  `wrangler deploy` (the only way to answer U1). Needs maintainer approval to run `wrangler deploy` for that worker
  (AGENTS.md forbids agent deploys otherwise), then deleted. Answers U1-U3; findings to `docs/OPEN-QUESTIONS.md`.
- **Phase 1:** sandbox-runner `/build` + stub mode + unit tests (mocked SDK) + docs. Local e2e and CI Enhanced green.
- **Phase 2:** preview-manager `CandidateBundleSource`, route response, purge cleanup, OPS docs. Still 501 in prod.
- **Phase 3 (human):** create/verify token scope, set `WORKER_VERSIONS_MODE=api`, first real canary on a test candidate.

## Decisions needed before Phase 0

1. Approve running `wrangler deploy` for the throwaway `beehive-sandbox-spike` (or run it yourself).
2. Build recipe: (b) esbuild with `--ignore-scripts` plus (a) fallback, or (a) only.
3. Cost ceiling for `max_instances`/instance type.
