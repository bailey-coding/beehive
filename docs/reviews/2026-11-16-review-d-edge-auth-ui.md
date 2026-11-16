---
category: audit
status: active
audience: human,agent
---

# Review, slice d: edge, auth and UI (2026-11-16)

This is step 2 of the whole-repo review (context: `docs/reviews/2026-11-15-architecture-map.md`). An independent Fable agent did a read-only pass at
`30cd284`. Its probes went through the real edge and the real Spec DO on node:sqlite in a scratch worktree. The orchestrator confirmed two findings:
- **M1:** the Spec DO prefers `body.agentId` (`workers/spec-do/index.ts:4360`, `:4397`), and only candidate creation overrides it at the edge (`workers/api/index.ts:1758`).
- **S1:** `extractParentId` returns the second-to-last path segment (`workers/api/index.ts:435-438`).

No finding is fixed yet.

**Verdict: request changes.** There is one must-fix: a user token can act as another actor through a body field. The rest of the edge auth is sound and well
tested, apart from the session-cookie checks, which have no test.

## Must-fix

**M1. A user token can write as another actor through `agentId` in the body.** (`workers/api/index.ts:1728-1747` `handleClaimSpec`, `:1642-1652` `handleCreateRepository`)
- The edge rewrites `X-Actor-ID` for user tokens, but these two handlers forward the body unchanged, and the DO prefers `body.agentId` over the header.
- `handleCreateCandidate` does override it. Claim and repositories were missed, and both are in `USER_WRITE_ROUTES`.
- Probe (alice's `read_write` token): `POST /api/repositories` with a maintainer's `agentId` and a foreign `namespace` answered 201, and the row carries the maintainer's id.
- For `claim`, the DO received the body unchanged. The end state (fork, repository, candidate and history all attributed to the victim) is inferred from `claimSpec`.
- Impact: trust scores and promotion evidence attach to candidate authorship, and the fork is created with the platform token.
- History: `docs/M12-IMPL-PLAN.md:193` lists `claim` as a user write without mentioning `agentId`.
- Fix:
  - At the edge, set `agentId: actorId` for every non-master principal on both routes. This is edge-only and safe while old and new versions run side by side.
  - In the DO, ignore `body.agentId` unless the caller is the master actor.
  - Add a test that fails when the override is removed.

## Should-fix

**S1. `POST /api/candidates/:id/gate/pre-merge` can never work.** (`workers/api/index.ts:2107`, `workers/spec-do/index.ts:4804`)
- Both sides take the id with `extractParentId`, which returns `gate`.
- Probe: the DO answered 404 `Candidate not found: gate`.
- Who depends on it: the CLI's `gate run` calls it, and the 410 text for `/execute` tells callers to use it.
- `docs/REAL-GATE-IMPL-PLAN.md:26` says the DO route "does not exist"; in fact it exists and is broken.
- Fix: take the id from a capture group on both sides, or retire the route with a 410.
- Warning: once it works, any `read_write` user token can produce a simulated `pass` (b2 S4).

**S2. Nothing tests the session cookie's signature and expiry checks or the OAuth state check.** (`workers/api/ui.ts:931, 933, 296, 954`)
- Each of these four mutations left all 545 `workers/api` tests passing:
  - removing the signature check;
  - removing the `exp` comparison;
  - removing the OAuth state comparison;
  - dropping `HttpOnly; SameSite=Lax`.
- Fix: add tests for a cookie signed with another secret, a tampered payload, an expired cookie, a mismatched state, and the `Set-Cookie` attributes.

**S3. The allow-list lets through writes that the DO does not guard.** This is the edge side of slice a S2 and S6. (`workers/api/principal.ts:248-278`)
- Probes with alice's token:
  - archiving bob's spec answered 200;
  - linking to bob's issue answered 201;
  - the issue stage PATCH reached the write;
  - repositories accepted any namespace.
- The comment at `:258` ("The DO still applies its own rules ... on every route") is false for spec stage, issue stage, both link routes, organizations and repositories.
- Fix: until the DO has author-or-maintainer rules, remove the two stage PATCH routes and the link routes from `USER_WRITE_ROUTES`, and correct the comment. This is edge-only and safe while old and new versions run side by side.

**S4. Malformed input throws out of the worker.** (`workers/api/index.ts:1549-2110`, `lifecycle.ts:99, 162`)
- About 20 handlers call `request.json()` with no catch, and `handleFetch` has no top-level catch.
- Probes:
  - a body of `{bad` threw a `SyntaxError` out of `worker.fetch`;
  - a path of `%E0%A4%A` threw a `URIError`.
- Any authenticated token gets Cloudflare's exception page instead of the JSON envelope.
- Fix: one `try/catch` in `handleFetch` (400 for `SyntaxError` and `URIError`, a generic 500 otherwise), and `decodeSegment` in `lifecycle.ts`.

**S5. The edge does not clamp `limit`, and the UI depends on lists having no limit.** (`workers/api/index.ts:1566, 1694`; `ui.ts:73`; `ui-layout.ts:74`)
- `limit=abc` becomes `NaN` and a 500, while `-1` and `100000` pass through.
- Every UI page asks for `limit=500` on up to seven lists and filters in memory.
- If the DO clamps to 100, as slice a S1 suggests, pages will silently show only the first 100 rows, and `resolveRepoRef` will miss repositories past that.
- Fix: clamp at the edge too, and pick the DO maximum together with the UI page size, or move the UI to filtered reads first.

**S6. No Content-Security-Policy or other security header on any HTML response.** (`ui-html.ts:411`, `ui-layout.ts:308`, `index.ts:981`)
- No unescaped value was found, so this is defence in depth.
- The pages use no JavaScript, so a strict policy costs nothing.
- Fix:
  - `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;
  - `X-Content-Type-Options: nosniff`;
  - `Referrer-Policy: same-origin`.

**S7. Membership is keyed on the GitHub login, which can change hands (inferred).** (`ui.ts:352-358`, `ALLOWED_GITHUB_USERS`)
- If a member renames their account, whoever registers the old login passes `isMember` and gets a new actor with member write access.
- That new actor does not inherit the maintainer role.
- Fix: allow-list numeric GitHub ids, or pin each login to its id on first sign-in.

**S8. The edge reads a route-missing 404 as "no such record".**
- `createDoReader.get` treats any `'Not found'` as null (`ui.ts:60-64`), so against an older DO a page shows "not found" instead of 502.
- The service-token branch maps any verify 404 to 401 (`principal.ts:179`), and it has no failed-attempt limiter. Every fake `bh_svc_` token therefore costs one unthrottled DO request.
- Fix:
  - coded 404s, as slice a S7 proposes;
  - share the failure limiter between both token branches.

## Nits

- N1: for members, `findSessionActor` reads the DO before the origin check on issue and create-form POSTs (`ui.ts:157, 680, 262`). It has no side effect, but it contradicts the comment at `:175`.
- N2: removing the `X-Actor-ID` rewrite (`index.ts:140`) left every test passing, because handlers read `principal.actorId`. Pin it with a test or document it.
- N3: `redact_query_string = false` (`8e2a5aa`, for the Honeycomb export) puts OAuth codes and flash text in logs. The codes are single-use, so the risk is low.
- N4: the flash message shows members the DO's raw error text, including SQL constraint messages (`ui.ts:827`).
- N5: the changelog escapes names twice (`ui-semantic.ts:648`, `:757`).
- N6: sessions cannot be revoked on the server. Killing a stolen cookie means rotating `API_AUTH_TOKEN` or removing the login.
- N7: the header comment at `index.ts:7` says "hand-written", contradicting AGENTS.md rule 2.
- N8: `service-accounts.ts:137, 185` map any DO 404 to "Not found".

## Contracts verified correct

- **Route tables:**
  - Every edge `/api` route has a matching DO route.
  - None of the DO-only routes is reachable from the edge: `advance`, gate-runs, preview PUT, history POST, the promotion ledger, deploy refs, canary metrics and the promotion mode.
  - Shadow samples, gate verdicts, trials, promotions, candidate stage and actor admin are master-only at the edge.
- **authorize:**
  - Denies by default.
  - Admin and lifecycle routes are master-only, and `include_deleted` gives a non-master caller a 403.
  - Each guard fails a test when removed.
- **Authentication:**
  - Fails closed (503, 401, 403).
  - Comparisons run in constant time, and tokens are stored as hashes.
  - No secret value appears in the logs.
- **Session and CSRF:**
  - Cookies are `__Host-`, HttpOnly, Secure, SameSite=Lax, with a 12-hour expiry.
  - Membership is re-checked on every request.
  - Every non-GET route has an origin check, a request with no `Origin` is refused, and each check fails a test when removed.
- **OAuth:**
  - A user outside the allow-list gets 403 with viewer sign-in off. With it on, they get a viewer cookie, with no actor row and no DO call.
  - `redirect_uri` is fixed to the request origin.
- **Viewers:**
  - GET/HEAD only, and no token pages.
  - Internal and private issues are filtered everywhere.
  - No Artifacts call is made.
  - The rate limiter fails closed.
- **Escaping:** every rendered ledger value goes through `esc()` or is a constrained enum or a generated id, and hrefs are validated.
- **Purge cleanup:** UUID-only ids, a cap of 40, and any failure aborts before the ledger is touched.

## Known items re-checked

- **2026-10-17 (master can assert any actor):** still true.
- **2026-10-17 (issue visibility cannot be set):** still true, so the private-issue filter is exercised only by tests.
- **2026-10-17 addendum (the issue stage PATCH has no actor check):** still true, and now reachable with user tokens (S3).
- **2026-11-07 (invalid bodies give 500s):** still true. S4 adds bodies that do not parse.
- **2026-10-28 (gate-run routes not on the edge):** still true.
- **2026-11-06 (rate limiting on workers.dev is unverified):** still open. `/auth/callback` has no limit.

## What was run

- `npx vitest run workers/api workers/shared`: 545 of 545 passed.
- `npm run typecheck`: clean.
- A four-case probe through the real edge and the real Spec DO.
- 32 test-breaking edits: 26 caught by a test, 5 not (S2 four times, N2).
- Not run: e2e, `wrangler dev`, the network. S7 and M1's claim end state come from reading the code.
