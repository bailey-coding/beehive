---
category: planning
status: draft
audience: human,agent
---

# Wave 0: stop the bleeding (plan, rev 1, 2026-11-17)

This plan comes from `docs/reviews/2026-11-17-synthesis.md`, "Proposed order of work", Wave 0. The maintainer approved starting it on 2026-11-17, including the
AGENTS.md labels and deleting the old scripts.

Every item here is an edge-only, CLI-only, test-only or docs-only change. None touches the Spec DO, a migration or the promotion train. Each is safe in the
mixed-version window: an edge that narrows what it forwards works against an old or a new Spec DO.

**Process:**
1. An independent review of this plan.
2. One commit per part below.
3. Mutation checks on every new guard, after committing.
4. An independent code review.
5. A merge to `main` only when the maintainer says so in chat.

## Part 1: the edge sets `agentId` from the caller (review d M1)

`workers/api/index.ts` `handleClaimSpec` (`:1728`) and `handleCreateRepository` (`:1642`) forward the body unchanged. The DO prefers `body.agentId` over
`X-Actor-ID` (`spec-do/index.ts:4360`, `:4397`), so a user token can write as another actor.

- **Change:** both handlers send `{ ...body, agentId: actorId }`, as `handleCreateCandidate` already does (`:1758`), for every principal.
  - For master, `actorId` is the asserted `X-Actor-ID`.
  - No caller in the repo puts `agentId` in either body: the CLI, e2e, the demo and the scripts send the actor as the header.
- **Out of scope:** the DO-side rule ("ignore `body.agentId` unless the caller is master"). It is a spine change, so it goes in Wave 2.
- **Tests:** in `workers/api/tests`, for each route, a user token sending another actor's id in `agentId` must reach the DO with its own actor id. Removing the
  override must fail the test.

## Part 2: close user-token writes that the DO does not guard (review d S3, b2 S4, d S1)

Remove these from `USER_WRITE_ROUTES` (`workers/api/principal.ts:261-276`):
- `PATCH /api/specs/:id/stage`
- `PATCH /api/issues/:id/stage`
- `POST /api/issue-spec-links`
- `POST /api/issue-candidate-links`
- `POST /api/candidates/:id/gate/pre-merge`

Why each one goes:
- **Stage and links:** the probes show any `read_write` token restaging or linking another user's spec or issue.
- **The gate route:** it is broken (d S1). Once fixed, it would let any user token mint a simulated `pass` (b2 S4).

**Kept:** issue `status` (close and reopen), comments, create routes and claim. Their DO rules are author or creator checks. Claim is made safe by part 1.

**Fix the comment at `:258`** to: "The DO applies author or creator rules only on create, claim, issue status and comments; a route here without one is a hole."

**Who is affected:**
- **The UI does not use these routes.** Its pages read and write through member sessions, which are a different path (checked: no hit in `workers/api/ui*.ts`).
- **CLI users holding a user token** get a 403 on `spec stage`, `gate run` and the link commands. They can use the master token, or wait for the Wave 2 DO rules.

**Mixed-version:** edge-only, so deny-by-default just gets narrower.

**Tests:** update the allow-list tests so each removed route is a 403 for a `read_write` and a `maintainer` user token. Restoring any one entry must fail a test.

**Not in Wave 0:** fixing the broken gate route's id extraction (d S1). It ties into the simulated gate's evidence (b2 S4), so it goes in Wave 2.

## Part 3: malformed input is a 400, not an exception (review d S4)

- **Change:** wrap the router body in `handleFetch` in one `try/catch`:
  - `SyntaxError` (body JSON) and `URIError` (path decoding) give 400 `{success:false,error:'Malformed request'}`;
  - anything else gives a generic 500 and a `console.error` with the error name only.
  - In `workers/api/lifecycle.ts:99, 162`, use the existing `decodeSegment`.
- **Leave alone:** handlers that already catch.
- **Tests:**
  - `{bad` to `POST /api/organizations` gives 400;
  - `%E0%A4%A` in a lifecycle path gives 400;
  - a thrown non-syntax error gives 500 with no message text.

## Part 4: session cookie and OAuth tests (review d S2)

Tests only. A cookie signed with another secret, a tampered payload, an expired `exp`, a callback whose `state` differs from the cookie's, and the
`Set-Cookie` attributes (`__Host-`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`).
- Each of the four mutations that survived in d S2 must fail a test.

## Part 5: CLI dry-run and URL (review e M1, M2)

1. **Dry-run:**
   - Delete the local `--dry-run` options on `spec claim` (`cli/src/commands/spec.ts:60`) and in `debug.ts:216`. The global `-n, --dry-run` is the one flag.
   - In the shared client (`cli/src/utils/api-client.ts` `request`), when `state.dryRun` is set, any method other than GET prints the method and path, sends
     nothing, and returns a dry-run marker.
   - Commands must not then treat the marker as data. Each write command prints "dry run: <METHOD> <path>" and exits 0.
2. **URL:** remove `.default(...)` from the `--url` option (`cli/src/index.ts:101`). `DEFAULT_CONFIG` already holds the default, and `loadConfig` applies
   env, then config, then defaults.
3. **Tests in the CLI harness:**
   - `spec claim x --dry-run`, `-n org create ...` and `--dry-run promotion create ...` record zero requests;
   - with `BEEHIVE_API_URL` unset and a config `apiUrl`, requests go to the config URL;
   - `--url` still wins over both.
4. **Docs:** fix `cli/README.md:107, 393`.

## Part 6: delete old scripts that write to production or leak tokens (review e S3, f D4, D5)

**Delete** (all still present): `scripts/test-queue-gate-wiring.sh`, `trigger-preview-test.sh`, `verify-m2.sh`, `e2e-test.ts`, `start-main.sh`,
`start-all.sh`, `test-ci-fix.sh`, `start-gate.sh`, `start-queue.sh`, `start-sandbox.sh`, `demo-end-to-end.sh`.

**Remove or replace the live references:**
- `docs/SETUP.md` (`e2e-test.ts`);
- `docs/TROUBLESHOOTING.md` and `.github/workflows/README.md` (`start-all.sh`);
- `scripts/health-check.sh` (its `start-all.sh` hint);
- `README.md`, `SUBMISSION.md` and `scripts/DEMO-QUICK-START.md` (`demo-end-to-end.sh`, replaced by `npm run demo`);
- the UI copy in `workers/api/index.ts` that names `demo-end-to-end.sh`.

**Leave the archived plans and reviews as they are,** because they are history: `docs/QUEUE-GATE-WIRING-PLAN.md`, `docs/plans/service-accounts-plan-review.md`,
`docs/plans/demo-tournament-plan.md`, `docs/VERIFICATION.md`.

**Kept:** `create-agent-forks.sh` and `scripts/demo-multi-agent.sh` (they need a separate look), `test-workers-builds.ts`, `health-check.sh` (its port map is
part 7's work).

**Check:** the docs-links test passes, and `rg` finds no live reference to a deleted script.

## Part 7: docs (review f, synthesis "Known items whose status changed")

1. **Dangerous instructions** (f D1-D7):
   - SETUP: add the three queues and the sandbox-runner `CLOUDFLARE_API_TOKEN`.
   - `--name` instead of `-n` in every `wrangler secret put`.
   - Delete SUBMISSION's "For Production Use" section.
   - TROUBLESHOOTING: fix the port table, and make `:637` print `set` instead of a token prefix.
   - ARCHITECTURE: delete the three wrong binding claims.
2. **OPEN-QUESTIONS status lines:** the eight rows in the synthesis table, plus f S1 and S6. Each entry gets a dated "Status (2026-11-17)" line. The entry
   text is not rewritten.
3. **AGENTS.md labels** (f W1, W2, A1-A3; approved 2026-11-17). Labels only, no rule changes:
   - rule 4/5: D1, git notes and `scratch/*` are a design target that is not implemented;
   - rule 6: Workflows are a target, and today's gate is simulated;
   - the oracle ladder: one line linking the map's section 4 "as built";
   - the canary row: "SLOs over Spec DO `canary_metrics` from mirrored requests";
   - auth: name the public and UI exceptions and the `--var` mechanism.
   - Keep the file under 200 lines.
4. **SUBMISSION.md:** a "Historical: as submitted 2026-10-12" banner (f A5).

**Not in Wave 0:** the rest of slice f (the ARCHITECTURE rewrite, MILESTONES, plan front matter) is Wave 3.

## Order and verification

1. Parts 6 and 7 first. They are docs and deletions, and part 6 removes scripts that part 7's docs would otherwise still name.
2. Then 1, 2, 3, 4 (edge) and 5 (CLI).
3. After each part:
   - the relevant test files;
   - before the code review: `npm test`, `npm run typecheck`, `npx vitest run tests/docs-links.test.ts`, the CLI typecheck and `tests/cli-behavior.test.ts`.
4. Local e2e once, at the end. Parts 1-3 change edge behavior that e2e exercises; `user-tokens.test.ts` may use a removed route.
