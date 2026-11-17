---
category: planning
status: active
audience: human,agent
---

# Wave 0: stop the bleeding (plan, rev 2, 2026-11-17)

This plan comes from Wave 0 in `docs/reviews/2026-11-17-synthesis.md` ("Proposed order of work"). The maintainer approved starting it on 2026-11-17,
including the AGENTS.md labels and deleting the old scripts.

- **Rev 1** was reviewed by an independent agent the same day: approve with changes. The dispositions are in the last section.
- **Rev 2** folds them in.

**Scope.** Every part is an edge-only, CLI-only, test-only or docs-only change: no Spec DO change, no migration, nothing in the promotion train. Each part is safe
in the mixed-version window, because an edge that narrows what it forwards works against an old or a new Spec DO.

**Process:**
1. One commit per part.
2. Mutation checks on every new guard, after committing.
3. An independent code review.
4. A merge to `main` only when the maintainer says so in chat.

**Order of work:** parts 6 and 7 (docs, deletions), then 3, 1, 2, 4 (edge), then 5 (CLI). Part 3's body helper is used by part 1.

## Part 1: a user or service token cannot write as another actor (review d M1)

**Who is affected:** only non-master callers (`request.principal.kind !== 'master'`). Master keeps asserting any actor (OPEN-QUESTIONS 2026-10-17). The CLI's
`repo create --agent <id>` (`cli/src/commands/repo.ts:21`) and `scripts/spike-local.sh` rely on that.

**What each route does today:**
- **Claim** (`workers/api/index.ts:1728`): the DO calls `claimSpec(id, body.agentId || actorId)` (`spec-do/index.ts:4360`).
- **Repositories** (`workers/api/index.ts:1642`): the DO stores `body.agentId` with no fallback (`spec-do/index.ts:4280`, `:6076`). Baseline repositories
  leave it null.

**The change:** for a non-master caller, if `body.agentId` is present and differs from `actorId`, answer 403 `{success:false,error:'agentId must be the caller'}`.
Otherwise forward the body **unchanged**. Two reasons:
- Baseline repositories keep `agent_id = NULL`.
- The DO idempotency hash is computed from the body text (`spec-do/index.ts:4033`). An unchanged body keeps a keyed retry valid even when it reaches an old edge
  and then a new one.

**Claim:** the same rule. A body without `agentId` is safe, because the DO falls back to the edge-set `X-Actor-ID`.

**Tests** (`workers/api/tests`):
- a user token with a foreign `agentId` gets 403 on both routes, and the DO is not called;
- a user token with its own `agentId`, or with none, reaches the DO with the body unchanged;
- master with `agentId: X` still stores X;
- the `X-Actor-ID` rewrite for non-master callers (`index.ts:140-143`) is pinned, because this guard depends on it (review d N2).

## Part 2: close user-token writes that the DO does not guard (review d S1, d S3, b2 S4)

Remove these from `USER_WRITE_ROUTES` (`workers/api/principal.ts:261-276`):
- `PATCH /api/specs/:id/stage`
- `PATCH /api/issues/:id/stage`
- `POST /api/issue-spec-links`
- `POST /api/issue-candidate-links`
- `POST /api/candidates/:id/gate/pre-merge`

Why each goes:
- **Stage and links:** probes showed any `read_write` token restaging or linking another user's spec or issue.
- **Gate route:** it is broken today (d S1). Once fixed, it would let a user token mint a simulated `pass` (b2 S4).

**Kept**, and what the DO checks on each:
- Issue create, issue status and comments: the DO checks the author (`requireSameAuthor` at `spec-do/index.ts:4648, 4712`; `setIssueStatus` at `:4692`).
- Organization, repository, spec and candidate create, and claim: the DO checks no author.
  - Attribution now comes from the edge (part 1 and the existing overrides at `index.ts:1838-2047`).
  - Repository create still accepts any `organizationId` and `namespace` (review a S6). It is a known hole, Wave 2.

**Replacement comment** for `:258`: "The DO checks the author only on issue create, issue status and comments. Org, repository, spec and candidate create and claim
rely on the edge-set actor; repository create accepts any organization and namespace (known hole, OPEN-QUESTIONS 2026-11-17)."

**OPEN-QUESTIONS:** add a dated entry for the repository hole.

**Who is affected:**
- **The UI:** nothing. It writes orgs, repos, specs, comments and status directly to the DO through member sessions (`ui.ts:599, 614, 634, 774, 788`), not
  through these routes.
- **The CLI with a user token:** `spec stage` (`api-client.ts:386`) and `gate run` (`:483`) now get 403. The CLI has no link commands.
- **e2e:** `tests/e2e/user-tokens.test.ts` does not use the removed routes.

**Tests:** in the matrix in `workers/api/tests/user-tokens.test.ts` (`:447, 453, 458, 462, 463`), flip the five rows from `'write'` to `'denied'`. Restoring any one
entry must fail a test.

**Docs:**
- `docs/OPS.md:344-346` (the `read_write` list) and `cli/README.md:63-69`.
- A one-line note in `docs/MR-FLOW-PLAN.md:89`, which assumes these routes are open to users.

**Not in Wave 0:** fixing the gate route's id extraction (d S1). It belongs to Wave 2, together with the simulated gate's evidence (b2 S4).

## Part 3: a malformed request is a 400, an upstream fault stays a 500 (review d S4)

- **A new helper:** `readJsonBody(request)` in `workers/api/index.ts` throws a tagged `MalformedRequestError` when the JSON fails to parse. Replace the 22
  `await request.json()` calls in `index.ts` with it.
- **One `try/catch`** in `handleFetch`, placed after `withActor` (`:149`) and wrapping the route dispatch from `handleServiceAccountRoutes` to the end.
  - `MalformedRequestError` and `URIError` give 400 `{success:false,error:'Malformed request'}`.
  - Anything else gives a generic 500 `{success:false,error:'Internal error'}`, plus a `console.error` with the error name only.
  - Not covered: the public pages and `handleUi`, which stay outside the `try`, so the UI never gets a JSON 500. Auth and authorize already return their
    Responses before this point.
  - A `SyntaxError` from parsing a **DO** response (claim `:1743`, `service-accounts.ts`, `user-tokens.ts`) therefore stays a 500.
- **Lifecycle:** use `decodeSegment` at `workers/api/lifecycle.ts:103` and `:164`. It returns `null`, and `null` gives 400.
- **Tests:**
  - `{bad` to `POST /api/organizations` gives 400.
  - A DO stub that answers non-JSON on claim gives 500, not 400.
  - `%E0%A4%A` in a lifecycle DELETE path with the master token gives 400 (a user token gets 403 first).
  - A handler that throws a generic error gives 500 with no message text.

## Part 4: session cookie and OAuth tests (review d S2)

Tests only. Build cookies with `signSession(session, secret)` (`ui.ts:942`). Cases:
- a cookie signed with another secret;
- a payload re-encoded under the old signature;
- an `exp` in the past;
- `/auth/callback` with a `state` different from the cookie's, using the harness at `ui-actor.test.ts:90`, with global `fetch` stubbed and asserted not called;
- the attributes on the session cookie set by `/auth/callback` (`__Host-`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`).

Each of the four mutations that survived in review d S2 must fail a test.

## Part 5: CLI dry-run and URL (review e M1, M2)

**Dry-run:**
1. Pass `{ dryRun }` into `createClient` (`cli/src/index.ts:142`). Today it receives only `config`, while `dryRun` lives on `CliState` (`:152`).
2. In `request()` (`cli/src/utils/api-client.ts:202`, the one network path; `rawRequest` delegates to it), a non-GET method in dry-run throws
   `DryRunStop{method,path}`. It throws before the actor-header validation.
3. `createActionHandler` (`index.ts:184`) catches it, prints `dry run: <METHOD> <path>` and exits 0.
   - No command consumes a marker.
   - A command with several steps stops at its first write.
4. Delete the local `--dry-run` options:
   - on `spec claim` (`cli/src/commands/spec.ts:60`);
   - on `debug test-claim` (`debug.ts:712`, read at `:216`). That command is already broken, because it reads `args[0].specId` from a positional argument
     (`:197-200`). Fix it to read the positional, or delete the command; the implementer decides and says which.
5. Dry-run covers API writes only. `auth login` and `logout` still write the config file. Say so in `cli/README.md:107, 393`.

**URL:**
- Remove `.default(...)` from `--url` (`cli/src/index.ts:101`).
- Precedence afterwards:
  - the commander `.env('BEEHIVE_API_URL')` still fills `opts.url` when set;
  - unset, `loadConfig` applies defaults, then the file, then env, then options (`cli/src/utils/config.ts:38-71`).
  - So `--url` beats env, env beats the config file, and the config file beats the default.

**Tests** (CLI harness):
- `spec claim x --dry-run`, `-n org create ...` and `--dry-run promotion create ...` record zero requests and exit 0.
- With `BEEHIVE_API_URL` unset and a config `apiUrl`, requests go to the config URL.
- `BEEHIVE_API_URL` beats the config, and `--url` beats both.

## Part 6: delete the old scripts (review e S3, f D4, D5)

**Delete:** `scripts/test-queue-gate-wiring.sh`, `trigger-preview-test.sh`, `verify-m2.sh`, `e2e-test.ts`, `start-main.sh`, `start-all.sh`, `test-ci-fix.sh`,
`start-gate.sh`, `start-queue.sh`, `start-sandbox.sh`, `demo-end-to-end.sh`, `demo-multi-agent.sh`. The last one is superseded and has no network or token
use; it prints made-up numbers and points to `demo-end-to-end.sh`.

**Kept:** `create-agent-forks.sh` (writes only under `/tmp`, no token), `test-workers-builds.ts`, `health-check.sh`.

**Live references to update:**
- `docs/SETUP.md` (`e2e-test.ts`);
- `docs/TROUBLESHOOTING.md` and `.github/workflows/README.md` (`start-all.sh`);
- the `start-all.sh` hint in `scripts/health-check.sh`;
- `README.md`, `scripts/DEMO-QUICK-START.md` and the UI copy in `workers/api/index.ts` that names `demo-end-to-end.sh` (replace with `npm run demo`).

**SUBMISSION.md is not rewritten.** It gets one banner (part 7). History stays history: the plans and reviews that name these scripts are not edited.

**Check:** `rg` finds no reference to a deleted script outside SUBMISSION.md, `docs/archive/`, `docs/reviews/` and those historical plans. The docs-links
test passes.

## Part 7: docs (review f, synthesis "Known items whose status changed")

1. **Dangerous instructions** (f D1-D7):
   - SETUP: add `canary-slo-ticks`, `canary-rollback-triggers` and `promotion-events` to the queue block, and add the sandbox-runner `CLOUDFLARE_API_TOKEN`.
   - Replace `-n` with `--name` in every `wrangler secret put` in README, ARCHITECTURE, STATSIG-INTEGRATION and the OAUTH docs.
     README and ARCHITECTURE link SETUP section 2d for the full list.
   - TROUBLESHOOTING: fix the port table, and change `:636` so it prints only `set`.
   - ARCHITECTURE: delete the three wrong binding claims (`:562-570`, `:590-592`, `:601`).
2. **OPEN-QUESTIONS:** a dated "Status (2026-11-17)" line on nine entries (the synthesis table plus f S6; f S1 is the synthesis's first row). The entry
   text stays as it is.
3. **Labels** (f W1, W2, A1-A3; approved 2026-11-17). The labels change no rules. AGENTS.md is 191 lines, so every label is an edit in place.
   - In both AGENTS.md and `docs/AGENTS-REVIEWER.md:16-17, 26`:
     - D1, git notes and `scratch/*` are a design target that is not implemented;
     - Workflows are a target, and the gate is simulated today;
     - the canary SLOs come from Spec DO `canary_metrics` over mirrored requests;
     - the oracle ladder links `docs/reviews/2026-11-15-architecture-map.md` section 4 for what is built.
   - In AGENTS.md only: the auth paragraph names the public-page and UI exceptions and the `--var` mechanism.
4. **SUBMISSION.md:** a banner. "Historical: as submitted 2026-10-12. Current status: CONTRIBUTING 'What is real today'. Scripts named below were removed
   2026-11-17; use `npm run demo`. Do not run `npm run deploy` (deploys are human-only, `docs/OPS.md`)."

**Not in Wave 0:** the rest of slice f (ARCHITECTURE rewrite, MILESTONES, plan front matter) goes to Wave 3.

## Verification

1. After each part: that part's test files.
2. Before the code review:
   - `npm test`, `npm run typecheck`, `npx vitest run tests/docs-links.test.ts`;
   - the CLI typecheck and `tests/cli-behavior.test.ts`;
   - local e2e once.

## Review dispositions (rev 1 review, 2026-11-17, approve with changes)

| Finding | Disposition |
|---|---|
| M1: part 1's override is too broad (master, baseline repositories, idempotency hash); the claim that no caller sends `agentId` was false; the `:4397` cite was wrong | Fixed. Non-master only; reject a foreign id instead of rewriting the body; the claim and cite are corrected; tests added for master. |
| M2: part 3 maps every `SyntaxError` to 400, including DO-response parsing | Fixed. A tagged request-body helper, the catch placed after `withActor`, `decodeSegment` returning null, a 500 test for a non-JSON DO answer. |
| S1: the replacement comment was inaccurate; org, repository and spec create have no author rule | Fixed. New comment; the repository hole goes to an OPEN-QUESTIONS entry and to Wave 2. |
| S2: OPS and the CLI README not in the edit list; the CLI has no link commands | Fixed. |
| S3: `dryRun` does not reach the client; the per-command approach was wrong; the precedence wording was reversed; `debug test-claim` is broken | Fixed. `DryRunStop` thrown from `request()` and caught in the action handler; precedence corrected; `test-claim` gets a fix or a deletion. |
| S4: a live reference in `demo-multi-agent.sh`; SUBMISSION was edited twice | Fixed. `demo-multi-agent.sh` added to the deletion list; SUBMISSION gets only the banner. |
| S5: pin the `X-Actor-ID` rewrite | Fixed (part 1 tests). |
| Nits: Part 4 harness, `AGENTS-REVIEWER.md` labels, map path, TROUBLESHOOTING `:636`, 191 lines, nine entries, MR-FLOW note, part order | All taken. |
