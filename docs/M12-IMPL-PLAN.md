# M12 implementation plan: verified identity and user tokens

**Task:** m12-plan | **Spec:** `docs/rfds/0008-verified-identity-user-tokens.md` (Accepted; section 9 decisions are not
re-opened here) | **Date:** 2026-10-18 | Spine work (AGENTS.md rule 2): every PR is reviewed by the maintainer plus an
independent review agent. Line numbers are on `main` at e06cf48. No code here; master stage 2 is out of scope.

> **Note (2026-10-19):** `m10` is now `idempotency_keys` (M5a). Where this plan says M11's unique index on
> `actors.github_user_id` goes in `m10`, read `m11`. The text below is left as written.

## 1. File-by-file plan

**T0, actor lookup (PR-0)**
- `workers/spec-do/index.ts`: `GET /api/actors` gains an optional `github_user_id` filter (`listActors`, `:3875`,
  route `:3165`), keeping today's `created_at DESC` (`:3878`) so the newest row wins, as `.find` on the unfiltered list
  does today and as an old DO that ignores the filter still does. No schema change, no index.
- `workers/api/ui.ts`: the session check (`:123`) becomes `GET /api/actors/<session.actorId>`: 200 means proceed, 404
  means re-login (today's behaviour), anything else is a 503 page rather than a login loop. `ensureActor` (`:332-341`) sends
  `?github_user_id=<id>&limit=500&offset=0` and **keeps** its client-side `.find` on `github_user_id`, so an old DO that
  ignores the filter behaves exactly as today. A lookup that is not `success` returns `null` (the existing "Login failed"
  page, `:321-323`) and **never creates an actor**. Today a failed list leaves `rows = []` and POSTs a duplicate (review F2).

**Push A (PR-A)**
- `workers/spec-do/index.ts` `runMigrations` (`:808-859`): if the stored version matches `/^m(\d+)$/` with N above the
  newest step, `console.warn` once and return before the steps and the final assertion. Any other unknown value still
  throws (`:842`). `initSchema`'s fresh-ledger branch is unchanged.
- `docs/OPS.md` deploy checklist: a "rollback floor" line naming push A's commit, with its invariant: every step above
  the floor must be additive and harmless to code that ignores it. It never rebuilds, drops or deletes from a table the
  floor's code uses. m9 qualifies: `idempotency_keys` only references existing tables, and no m8 code drops, alters or deletes from
  `actors`.

**Push B (PR-B), one push, six reviewable commits T2-T6d**
- `workers/shared/service-tokens.ts`: generalise generation and shape checks to a prefix (`USER_TOKEN_PREFIX = 'bh_usr_'`,
  `generateUserToken`, `looksLikeUserToken` `/^bh_usr_[A-Za-z0-9_-]{43}$/`). The existing exports stay as thin wrappers so
  that no caller changes. `hashToken`, `tokenPrefix` (12 chars) and `constantTimeEqual` are reused as they are.
- `workers/shared/principal.ts`: `kind` adds `'user'`; `Scope` adds `'maintainer'`; optional `userTokenId`. Types only.
- `workers/shared/spec-do-auth.ts` `ADMIN_PATTERNS` (`:37-47`): every `/internal/user-tokens*` route except
  `POST /internal/user-tokens/verify` is tier 2. The other nine workers never call these routes and do not hold the admin
  token, so their copy of the list changes nothing they do.
- `workers/spec-do/schema.sql` + `schema-inline.ts` (`USER_TOKENS_SQL`, the same text in both, `schema-sync.test.ts`):
  ```
  user_tokens(id TEXT PK, actor_id TEXT NOT NULL FK actors, name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 64),
    token_hash TEXT NOT NULL, token_prefix TEXT NOT NULL,
    scope TEXT NOT NULL CHECK(scope IN ('read','read_write','maintainer')),
    created_by TEXT NOT NULL FK actors, created_via TEXT NOT NULL CHECK(created_via IN ('session','admin')),
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
    revoked_at INTEGER, revoked_by TEXT FK actors, last_used_at INTEGER)
  UNIQUE INDEX idx_user_tokens_hash(token_hash); INDEX idx_user_tokens_actor(actor_id)
  ```
  The scope is a single hierarchical value (`maintainer` ⊃ `read_write` ⊃ `read`), so the CHECK never needs widening for
  a combination. The 90-day ceiling is enforced in code, not in the CHECK, so it can change without a table rebuild.
  m9 (idempotency keys) adds no index on `actors`; the UNIQUE `github_user_id` index belongs to M12's `m10`, after a clean duplicate check
  (on a ledger with duplicates it throws, `init()` rethrows, and that is a full outage).
- `workers/spec-do/index.ts`: `LATEST_SCHEMA_VERSION = 'm10'` (`:27`); step `['m10', () => this.db!.exec(USER_TOKENS_SQL)]`;
  the same exec in `initSchema` (`:515-531`). Actors are never purged (`ORG_PURGE_ORDER` `:92-107` has no actors), so
  purge order is unchanged. New methods and routes, next to the service-token ones (`:583-625`, `:1880-1932`):
  `mintUserToken`, `listUserTokens`, `revokeUserToken`, `revokeAllUserTokens`, `verifyUserTokenHash`. Routes:
  `POST /internal/user-tokens` (mint), `GET /internal/user-tokens?actorId=` (list),
  `POST /internal/user-tokens/:id/revoke`, `POST /internal/user-tokens/revoke-all {actorId}`, and
  `POST /internal/user-tokens/verify {tokenHash}`, which **always answers 200** with `{found:true,...}` or `{found:false}`.
  The maintainer cap: when a request carries `X-Beehive-Maintainer-Cap: 1`, every `isMaintainer` decision for that request
  is false. `isMaintainer(actorId, capped: boolean)` (`:1946`) takes `capped` as a **required** parameter, so an unthreaded
  call site fails typecheck. All six sites are threaded: purge (`:2179`), role (`:2248`), `include_deleted` (`:3109`),
  comment policy (`:4193`), closing others' issues (`:4215`) and comments on restricted issues (`:4246`). The router reads
  the header and passes a boolean down. Nothing per-request is stored on the DO instance, because input gates interleave
  requests at every `await`. An absent header means full power. That is needed for the old edge, the nine workers and the
  UI session, and it is why the edge side below must be impossible to miss. A spoofed header can only remove power.
- `workers/api/principal.ts`: a `bh_usr_` branch after the service branch (`:52`): shape check, then 401; DO verify:
  `found:true` gives a `kind:'user'` principal, `found:false` gives 401, **404 gives 503** (an old DO without the route),
  any other status, a throw or a malformed body gives 503. Scopes map as `read` to `['read']`, `read_write` to
  `['read','write']` and `maintainer` to `['read','write','maintainer']`. `authorize()` gets an explicit user write
  allow-list (section 4, S9); everything else stays 403.
- `workers/api/index.ts`: the rewrite at `:100` becomes `principal.kind !== 'master'` (service and user). For a user
  principal without `maintainer`, `specDoStub` is wrapped **once, right after `authorize()`**, and only the wrapped stub
  is passed on (the unwrapped binding is not referenced again in `fetch`), so every DO call carries
  `X-Beehive-Maintainer-Cap: 1`. Handlers build fresh headers (`sendToSpecDo`, `:399-415`), so the stub is the only
  reliable place. The wrapper normalises string and URL input as `authedSpecDoStub` does (`spec-do-auth.ts:109-113`),
  because `handleHealth` calls `fetch('/health')` (`index.ts:1365`). The master stage-1 log line and its Analytics Engine
  data point go here (S12). Dispatch to the new `handleUserTokenRoutes` after `handleServiceAccountRoutes`.
- `workers/api/user-tokens.ts` (new, modelled on `service-accounts.ts`), master-only: `POST /api/admin/user-tokens
  {actorId,name,scope,expiresInDays}` (plaintext once, `no-store`), `GET /api/admin/user-tokens[?actorId=]`,
  `POST /api/admin/user-tokens/:id/revoke`, `POST /api/admin/user-tokens/revoke-all {actorId}`. `X-Actor-ID` is the
  minting actor, or the reserved `master` actor without it (as `service-accounts.ts:28-38`).
- `workers/api/service-accounts.ts` `/api/whoami` (`:66-73`): add `userTokenId` and the scope; existing fields unchanged.
- `workers/api/ui.ts`, `ui-pages.ts` (`Session` `:29-33` gains `iat`), new `ui-tokens.ts`: `/app/settings/tokens`
  GET (list and mint form), POST (mint, a 200 page showing the plaintext once), `POST /app/settings/tokens/:id/revoke`.
  `ui-layout.ts` (`:219`): an "API tokens" link in the account area.
- Tests: `workers/spec-do/tests/user-tokens.test.ts`, `workers/api/tests/user-tokens.test.ts`, `ui-tokens.test.ts`,
  `tests/e2e/user-tokens.test.ts`, and additions to `migrations`, `schema-sync`, `internal-auth`, `issue-comments` and
  `ui-layout` tests.
- Docs (T6, listed in section 2): `docs/OPS.md`, `docs/FOCUS.md`, `docs/OPEN-QUESTIONS.md`, `docs/MILESTONES.md`.

**PR-C (CLI)**: `cli/src/utils/config.ts` (`saveConfig`, `:103-124` on `main` at 9d5dca9: write a temp file in the config directory, opened with mode `0o600`,
then `renameSync` over the config. A `chmodSync` after the write would leave a 0644 window);
`cli/src/commands/auth.ts` (`auth whoami`; `login` verifies with `/api/whoami`, not `/health`, and prints kind and actor);
`cli/src/utils/api-client.ts` (`:139-152` on `main` at 9d5dca9: with a `bh_usr_` token, warn once and send no `X-Actor-ID`); `cli/README` and
`docs/OPS.md` "CLI actor attribution" (`:230-239` on `main` at 9d5dca9) rewritten; new `tests/cli-token.test.ts` (the CLI tests live in root `tests/`, not `cli/tests/`; see `docs/M12-PRC-PLAN.md`).

**PR-D1 / PR-D2 (session key)**: `workers/api/ui.ts` (`UiEnv`, the gate at `:104`, `signSession` `:822`, `readSession`
`:828-847`); `scripts/start-e2e-workers.sh` (generate and pass `SESSION_SIGNING_KEY`); `tests/e2e/ui-issues.test.ts` and
`ui-nav.test.ts` (forge with the session key); `tests/e2e/config.ts`; `docs/SETUP.md` (`.dev.vars`); `docs/OPS.md`.

## 2. Ordered tasks

Tiers per `docs/AGENT-ROUTING.md`. Every task ends with a push of its own `agent/m12-*` branch, branched from `main`.

| Task | What | Tier | Depends on | Proving test | Maintainer action | PR |
|---|---|---|---|---|---|---|
| T0 | Actor lookup without the 500 limit; no create on a failed lookup | default | none | `ui-actor.test`: 501 actors, the newest-login user is found by id and by GitHub id, and no duplicate is created; first login creates the row (M8-PR1 S2); DO 500 on the session check gives a 503 page, not a redirect; **DO 500 on the `ensureActor` lookup gives zero `POST /api/actors`** (F2); two rows with one GitHub id resolve to the newest, both with the filter and with an old-DO stub that ignores it (F3). DO test for the filter | review | PR-0 |
| T1 | Push A: tolerate `m<N>` above the newest version | default | none | `migrations.test`: an `m100` ledger with an extra table that has an FK to `actors` and a row inits with no steps run, serves reads, and serves **writes** (create an actor, an issue, a comment); `mx` still throws; m9 is a no-op (F4) | review; deploy push A (PR-0 may ride along); record the floor | PR-A |
| T2 | Token helpers and `Principal` types | light | T1 deployed | helper tests: shape, prefix length, `bh_svc_` unchanged | review | PR-B |
| T3 | m10 table, DO routes, verify, maintainer cap | heavy | T2 | `user-tokens.test` (S1-S16 rows), `migrations.test` "fresh ledger starts at m10" and "m9→m10 keeps rows", `schema-sync`, `internal-auth` (new routes are tier 2, verify is tier 1), capped maintainer in issue tests | review | PR-B |
| T4 | Edge: `authenticate` branch, `authorize` table, rewrite, cap wrapper, admin routes, whoami, stage-1 log | heavy | T3 | `api/tests/user-tokens.test`: every verify outcome to its status; the full route-class matrix, with 403 for candidate `stage` and `execute` under all three scopes (B1); the default-deny enumeration test (S9); a spoofed `X-Actor-ID` is rewritten; **cap loop** (F1): for every allowed write route in S9 and for `/health`, a `read_write` token of a maintainer actor puts `X-Beehive-Maintainer-Cap: 1` on **every** DO request the handler makes, and a `maintainer` token on none; the log line has no token, hash or `Authorization` | review | PR-B |
| T5 | UI settings page, `iat`, nav link | default | T4 | `ui-tokens.test` (S5, S13, S14 rows), `ui-layout.test` link | review | PR-B |
| T6 | Local e2e | default | T5 | `tests/e2e/user-tokens.test.ts` (local only): admin mint; issue created with a spoofed `X-Actor-ID` is attributed to the token's actor; a `read_write` maintainer token cannot close another actor's issue; revoke, then 401 | review | PR-B |
| T6d | Docs (F8): OPS "User tokens: mint, rotate, revoke" (allowlist removal = `revoke-all`; re-check after a B re-deploy; freshness bounds a stolen Beehive cookie only, since GitHub re-auth is often silent), the rollback floor and its invariant, the stage-1 query (Workers Logs and AE), the A4 assumption line; FOCUS: rate limiting deferred, `authGate` `===` follow-up, service 404→401 vs user 404→503, the unique index on `actors.github_user_id` in `m10` only after a clean check, lifecycle-to-`maintainer`-tokens as a prerequisite of master stage 2, the A4 verification task; OPEN-QUESTIONS: the A4 assumption (unverified); MILESTONES: M12 status and exit criteria | light | T6 | review only (doc links resolve; no code) | review; deploy push B after A is live (section 3) | PR-B |
| T7 | CLI token support and docs | default | T4 merged | `tests/cli-token.test.ts` (shared harness `tests/helpers/cli-harness.ts`): config mode 0600 from creation (temp file + rename; never 0644 on disk), also over an existing 0644 file; `--actor`/`BEEHIVE_ACTOR` ignored with a warning for `bh_usr_`; `auth whoami` output; login fails on 401 | review (releasing the CLI is out of scope, `docs/FOCUS.md` Open work) | PR-C |
| T8 | Session key, phase 1: sign with new, accept both | default | T5 merged | `ui.test`: a new-key cookie is accepted; an old-key cookie is accepted; the key unset gives 503; `iat` survives | put `SESSION_SIGNING_KEY` **before** the push | PR-D1 |
| T9 | Session key, phase 2: drop the old key | light | 12 h + margin after pre-D1 code last served (F7) | `ui.test`: an `API_AUTH_TOKEN`-signed cookie is refused (re-login) | push after the wait | PR-D2 |

PR-B is reviewed as one stack (`docs/AGENT-ROUTING.md` "Branches and review"): T2-T6d are commits on one branch, never
separate branches stacked on each other. M12 takes `m10`.

## 3. Mixed versions and the maintainer's deploy steps

One push to `cf` deploys all ten workers in no order (`docs/OPS.md` "Deploy flow"). The edge, the UI and the Spec DO class
all live in the `beehive` script (`workers/api/index.ts:72`), so a single deploy carries old and new together. The window
that remains is a request that meets a DO instance still running the previous class, plus a rollback. The other nine
workers compile `shared/*` but call no new route, so their behaviour is unchanged in every combination.

| Change | New edge/UI, old DO | Old edge/UI, new DO | Old UI vs new UI (cookies, pages) |
|---|---|---|---|
| T0 lookup | `?github_user_id` is ignored and the old DO returns ≤500 rows; the kept `.find` gives today's result. `GET /api/actors/:id` already exists | unchanged: the old UI never sends the filter | none |
| T1 tolerance | n/a (DO-only) | n/a | none |
| T3/T4 user tokens | verify 404 → **503** for `bh_usr_` (fail closed, never 401 or anonymous); admin mint/list/revoke → DO 404 → edge 503; master, service and session unchanged | `bh_usr_` is neither master nor `bh_svc_` → **401** (`principal.ts:91`); the new DO routes go unused; the m10 table sits idle | none |
| Maintainer cap | never sent with a user principal (verify already failed) | an old edge never sends it; the DO's absent-header path is today's behaviour | n/a |
| T5 settings page | list/mint → DO 404 → "Token service unavailable" page, never "no tokens" (Response.ok rule) | the old UI has no page; `/app/settings/tokens` falls through to the old UI's not-found | a new UI reads an old cookie without `iat` as "not fresh": the user must sign in again before minting. The old UI ignores `iat` |
| Stage-1 log | the log line is edge-only | no log | n/a |
| T7 CLI | an old CLI with a user token works: the edge overwrites its `X-Actor-ID` | n/a | n/a |
| T8 session key | n/a | n/a | the new code accepts old-key and new-key cookies; on rollback, the old code refuses new-key cookies → re-login |
| T9 drop old key | n/a | n/a | an old-key cookie (at most 12 h old, given the F7 wait) → re-login |

**Push A (PR-0 + PR-A).** No new secret.
1. Read-only: `SELECT value FROM metadata WHERE key='schema_version'` gives `m8`.
2. `git pull origin main && git push cf main`.
3. `BEEHIVE_API_TOKEN=... ./scripts/prod-health.sh` (the last check reaches the DO); log in to `/app` once (T0 path).
4. Re-read `schema_version`: still `m8`. Record push A's commit in `docs/OPS.md` as the **rollback floor**: from push B
   on, never deploy anything older than it.

**Push B (PR-B), only after A is live.**
0. No new secret (`API_AUTH_TOKEN`, `SPEC_DO_INTERNAL_TOKEN`, `SPEC_DO_ADMIN_TOKEN` are already on `beehive`). Read-only
   checks: `wrangler deployments list --name beehive` shows push A's version live, and `schema_version` is `m8`. There is
   no actor precondition (A3) and no log-redaction gate (A4).
1. Push. 2. `prod-health.sh`. 3. Read `schema_version` = `m10` and confirm `user_tokens` is in `sqlite_master`.
4. Bootstrap: `POST /api/admin/user-tokens` with the master token, `X-Actor-ID: <maintainer actor>`, `{actorId: <own
   actor>, name, scope:"read_write", expiresInDays: 30}`. `GET /api/whoami` with the token shows `kind:"user"`. Then
   revoke that token or keep it. No production e2e without the maintainer's explicit approval.

**PR-C (CLI).** No worker change. If it rides in a push, CI is the only check. Releasing the CLI is out of scope (no publish pipeline; `docs/FOCUS.md` Open work).

**PR-D1.** 0. `openssl rand -hex 32 | wrangler secret put SESSION_SIGNING_KEY --name beehive` **before** pushing (the
key is used by `beehive` alone). If forgotten, `/app` answers 503 "not configured" until it is put; the API is unaffected.
1. Push. 2. An existing session still works; a new login works.
**PR-D2.** Push no sooner than `SESSION_TTL_SECONDS` (12 h, `ui.ts:30`) plus a 1 h margin after the **last moment pre-D1
code served**. A rollback of D1, or any redeploy of older code, signs old-key cookies again and restarts the clock (F7). Sessions still signed with the old
key go back to `/login`. Optional afterwards: rotate `API_AUTH_TOKEN`, since a leaked copy can no longer forge sessions.

## 4. Security checklist (each row has a test; file in brackets)

| # | Item | Design | Test |
|---|---|---|---|
| S1 | Format and entropy | `bh_usr_` + base64url of 32 bytes from `crypto.getRandomValues` (256 bits). Generated at the edge; the DO never sees plaintext | 43-char body, charset, two mints differ [helpers] |
| S2 | Hashing and compare | SHA-256 hex stored, looked up through a unique index. With 256-bit input no salt or slow hash is needed, and an index lookup on the hash leaks nothing useful. The master compare stays `constantTimeEqual` and runs first (`principal.ts:38-41`) | the DO stores `token_hash` = hash(plaintext) and never plaintext; the list view has no `token_hash` [DO] |
| S3 | Never log tokens | No log line, error body or DO row carries the plaintext or the hash: only `id` and the 12-char prefix. Tokens never go in a URL (`redact_query_string = false`, `wrangler.toml:50`). Header capture in invocation logs and traces is covered by assumption A4 | spy on `console.*` during mint, verify and revoke, with a bad token, asserting neither plaintext nor hash appears [edge, DO, UI] |
| S4 | No existence leak | Unknown, revoked, expired, deleted-actor, service-actor and malformed tokens all give the identical `401 {"error":"Unauthorized"}`. UI revoke of another actor's token or an unknown id is 404 for both | byte-equal bodies across the six cases [edge]; another actor's token id gives 404 [DO, UI] |
| S5 | Who mints for whom | The real guards are at the edge: `ui-tokens.ts` takes `actorId` from `session.actorId` only (no form field is read), and `user-tokens.ts` is master-only. Both reach the same tier-2 DO route, so the DO cannot tell them apart; its `created_via='session'` ⇒ `created_by = actor_id` check is defence in depth (N1). In both cases the DO requires the target to be `type='human'`, `github_user_id IS NOT NULL` and not a service actor. A user token cannot mint: `/app/*` takes cookies only, and `/api/admin/*` is master-only | a form field naming another actor is ignored [UI]; agent, service and no-GitHub targets give 400/403 [DO]; a user token on `/api/admin/user-tokens` gives 403 [edge] |
| S6 | Maintainer scope | Mintable only while `actors.role='maintainer'` (DO check in the mint transaction). At use time `isMaintainer` still reads the role live, so a demoted maintainer's token loses the power at once. The UI offers the option only to maintainers | non-maintainer mint of `maintainer` gives 403; demote, then comment-policy PATCH gives 403 [DO] |
| S7 | Expiry | The DO decides (`expires_at > now` in the verify SQL); the edge never caches. Mint: `expiresInDays` an integer 1-90 (default 30); the DO rejects `expires_at > now + 90 d + 1 min` | an expired token gives 401 with no edge change; 91 days gives 400 at the edge and at the DO directly [DO, edge] |
| S8 | Revoke | One `UPDATE ... SET revoked_at, revoked_by WHERE revoked_at IS NULL`; idempotent (200; the first revocation is kept). Session revokes only its own; admin revokes any, plus `revoke-all` per actor. OPS: removing a login from `ALLOWED_GITHUB_USERS` must be paired with `revoke-all` | revoke twice keeps `revoked_at`; `revoke-all` covers every live token of that actor only [DO] |
| S9 | Scope per route class | See the matrix below. `authorize()` is an allow-list for user writes; anything unlisted is 403 | the full matrix for read, read_write and maintainer; **default-deny test**: a table lists every non-GET route the edge dispatches (`index.ts:123-331`, `lifecycle.ts`, `service-accounts.ts`, `user-tokens.ts`), each with its class. The test fails if a dispatched write route is missing from the table, and checks that each one denied to users gives 403 for all three scopes [edge] |
| S10 | Replay of a revoked token | No edge cache, and every request verifies in the DO, so the next request after revoke is 401 | revoke, then the same bearer gives 401 [DO, edge, e2e] |
| S11 | Concurrent mint | Mint is synchronous inside one `transactionSync` (no `await`): a cap of 10 live tokens per actor (409 beyond it) and the hash insert cannot interleave. A hash collision gives a unique violation, then 409 | 12 parallel mints give exactly 10 created and 2 conflicts [DO] |
| S12 | Master stage-1 log | When `kind==='master'` and the client sent `X-Actor-ID` other than `unknown`, log one JSON line `{event:"master_actor_assertion", method, path: url.pathname, actorId, ray: cf-ray}` and write one Analytics Engine point to the existing `ANALYTICS` binding (`wrangler.toml:32-34`; index `master_actor_assertion`, blobs `actorId`, `method`, path class). Workers Logs keep 7 days, too short for the stage-2 evidence (F5). `actorId` is client-controlled, so it is capped at 128 chars (N5); since 2026-10-23 `authenticate()` rejects a longer or malformed master `X-Actor-ID` with 400 and logs `master_actor_rejected` instead (no AE point). No query string, headers, body or token. Logged for any actor (no extra DO read on the master path); human vs agent is resolved afterwards against `actors` | the line and the AE point have exactly those fields; a 300-char actor is truncated; no line or point without the header [edge] |
| S13 | Show once | The mint answer is a 200 page (not a redirect or flash) with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`; the list shows the prefix only. A browser refresh of that page resubmits the POST and mints a second token. This is documented, not prevented: the browser asks before resubmitting, the token cap bounds it, and the extra token is listed for revocation (N2) | headers; the plaintext is absent from the next list page [UI] |
| S14 | CSRF and freshness | POSTs check `sameOrigin` before any DO call (as `ui.ts:226`, `:552`); `SameSite=Lax` cookie. Mint requires `0 ≤ now - session.iat ≤ 600 s` (an `iat` in the future is not fresh, N3), otherwise a "sign in again" page and no DO call | cross-origin POST gives 403 with zero DO calls; a stale, missing or future `iat` gives no mint [UI] |
| S15 | Fail closed | `API_AUTH_TOKEN` unset gives 503 before any branch; DO 404, 5xx, throw or a bad body gives 503; never anonymous, never master | stub each outcome [edge] |
| S16 | Session forgery | After D2 the cookie HMAC uses `SESSION_SIGNING_KEY` only (same `beehive-ui-session:` label), so the master token cannot forge a session | a cookie signed with `API_AUTH_TOKEN` gives a redirect to `/login` [UI] |

**S9 route-class matrix** (master unchanged: everything). `cap` = the DO sees `X-Beehive-Maintainer-Cap: 1`.

| Route class | read | read_write | maintainer |
|---|---|---|---|
| `GET /health`, `/api/health`, `/api/whoami`, non-admin `GET /api/*` | yes | yes | yes |
| Writes: `POST` organizations, repositories, specs, candidates; `PATCH /api/specs/:id/stage` (spec lifecycle, not a rung), `claim`; issues create, `stage`, `status`, comments; issue-spec/candidate links; `gate/pre-merge` (it only starts the real gate workflow, `spec-do/index.ts:3794`) | 403 | yes, cap | yes |
| `PATCH /api/issues/:id/comment-policy` | 403 | 403 at the edge | yes (the DO re-checks the role) |
| `POST /api/actors`, `PATCH .../trust`, `PATCH .../promotion-authority`, `POST /api/gate-verdicts`, `POST /api/trials`, `.../decide`, `POST /api/promotions`, **`PATCH /api/candidates/:id/stage`**, **`POST /api/candidates/:id/execute`** | 403 | 403 | 403 (A2) |
| Lifecycle (`DELETE` tombstones, `?include_deleted=1`), `/api/admin/*` incl. purge, roles, user-token admin | 403 | 403 | 403 (A1) |

## 5. Rollback per push (rule 7: a ref operation; the maintainer redeploys the good ref through the `cf` flow, `docs/OPS.md`)

| Push | Revert to | What changes for clients |
|---|---|---|
| A (+ PR-0) | the commit before A, **only while** `schema_version` is still `m8` | nothing becomes 401; the UI lookup is limited to 500 again |
| B | push A (the floor) | **every `bh_usr_` request becomes 401**; `/app/settings/tokens` becomes not-found; the admin user-token routes give 404; stage-1 logging stops. Master, service tokens and sessions are unchanged. `user_tokens` stays at m10 and A ignores it. **Never revert below A**: that is `Unknown schema_version`, a full outage |
| B, re-deploy | B again | tokens that were valid before work again unless expired. Tokens could not be revoked during the rollback: the maintainer re-checks the list and revokes as needed (OPS line) |
| C | the previous CLI release | nothing becomes 401; user tokens still work through `BEEHIVE_API_TOKEN` or `auth login` |
| D1 | B | new-key cookies are refused, so users re-login (302, not 401); the API is unaffected |
| D2 | D1 | nothing breaks; D1 accepts both keys |

## 6. Risks

**Risks**
- R1 Spine authorship: agent-written auth and DO code. Mitigation: heavy tier with a plan per task, maintainer plus
  independent review, mutation-style checks as in `docs/M8-PR1-REVIEW.md` (each S-row test must fail with its guard
  removed).
- R2 The master token is still all-powerful until stage 2 (a separate decision). M12 makes user writes verified, not master
  writes, and the internal tier-1 trust is unchanged (RFD non-goal).
- R3 Revocations are lost during a B rollback (section 5). Also a rollback race (N7): a write that a new edge verified can land
  on a DO that was just rolled back and ignores the cap. The window is milliseconds, and the old edge then answers 401.
  Accepted.
- R7 Deviations from the RFD, named (N6): a single `scope` column instead of `scopes`; the 10-live-token cap per actor
  (new); lifecycle stays master-only, a strict subset of decision 3 (A1).
- R4 Rate limiting is deferred (decision 8): a flood of well-formed fake `bh_usr_` tokens is DO load. Recorded in FOCUS.
- R5 `ui.ts` is touched by T0, T5 and T8: land them in that order.
- R6 The verify contract differs from the service branch (`principal.ts:67` maps 404 to 401). This is deliberate for user
  tokens (RFD section 3.A). The service branch is left alone, and the difference is noted in FOCUS.

## 7. Maintainer answers (2026-10-18; these replace the earlier open questions Q1-Q4)

- **A1 (Q1): yes.** Lifecycle (tombstones, `include_deleted`), `/api/admin/*`, purge and role routes stay **master-only in
  M12** (`lifecycle.ts:76` unchanged). This is a strict subset of decision 3. **Note for later:** master stage 2 (the
  master token can no longer act as a human) requires opening these routes to `maintainer` tokens first. T6d records
  that prerequisite in FOCUS.
- **A2 (Q2): confirmed**, with the two routes from review B1 added. User tokens of every scope are denied gate-verdict,
  trial, promotion and actor-admin writes, `PATCH /api/candidates/:id/stage` (no transition guard:
  `transitionCandidate`, `spec-do/index.ts:1209-1219`, writes any CHECK value including `passed_canary`/`promoted`, and
  the promotion worker records rung outcomes through it) and `POST /api/candidates/:id/execute` (client-supplied
  `sandboxRunnerUrl`, `api/index.ts:1885-1889`, fetched by the DO at `:4337`/`:4411`, which then sets `passed_premerge`,
  `:4366`: an oracle bypass and an SSRF). Widening later is edge-only.
- **A3 (Q3): no actor precondition for push B.** The maintainer ran the read-only duplicate check on production on
  2026-10-17: 1 actor, a human with a GitHub id, 0 duplicates. T0 still ships F2 (no create on a failed lookup) and F3
  (newest wins). There is still **no unique index in m9**; it goes in `m10`, after the check is re-run.
- **A4 (Q4): assume, unverified.** Per the maintainer's instruction, the plan **assumes** that Cloudflare invocation logs
  and Honeycomb traces drop `Authorization`, `Cookie` and PII headers (including `X-API-Token` and the edge→DO
  `X-Beehive-Internal`/`X-Beehive-Admin`). It is recorded as an unverified assumption in one line each in `docs/OPS.md` and
  `docs/FOCUS.md` (a verification task), plus `docs/OPEN-QUESTIONS.md` (T6d). **Push B does not wait on it.** If it
  later proves false: `invocation_logs = false` and trace header capture off on `beehive`, then rotate the exposed
  secrets (FOCUS task text).

## 8. Review responses (`docs/M12-IMPL-PLAN-REVIEW.md` on `agent/m12-review`; each finding re-checked against the code)

| Finding | Response | Where |
|---|---|---|
| B1 candidate `stage` PATCH and `execute` open to `read_write` | **Accepted.** Confirmed: no transition guard (`spec-do/index.ts:1209-1219`); client `sandboxRunnerUrl` fetched by the DO (`:4337`, `:4411`) | S9 matrix, S9 default-deny test, T4, A2 |
| F1 fail-open cap, a missed call site | **Accepted.** Six `isMaintainer` sites confirmed; required `capped` argument; wrap once after `authorize()`; string-input normalisation (`index.ts:1365`); cap test on every allowed write route | §1 DO and edge bullets, T4 |
| F2 `ensureActor` creates on a failed lookup | **Accepted.** Confirmed (`ui.ts:333-335`) | §1 T0, T0 test |
| F3 ordering `ASC` vs today's `DESC` | **Accepted: keep `DESC`** (newest wins, as today and as an old DO). A3 shows no duplicates exist, so there is no reason to change it | §1 T0, T0 test |
| F4 push-A test and invariant | **Accepted.** Write test on an `m99` ledger with an FK table; floor invariant in OPS; unique-index handoff to `m10` | §1 push A, T1, m9 note, T6d |
| F5 log retention | **Accepted** with the AE data point (not the "document only" alternative) | S12 |
| F6 traces and subrequest headers | **Accepted as scope; verification not done** (A4: the maintainer said to assume redaction). The assumption names traces and the internal headers | A4, T6d |
| F7 D2 wait | **Accepted.** 12 h + 1 h from the last moment pre-D1 code served | §3 PR-D2, T9 |
| F8 docs tasks | **Accepted** as a separate task T6d | §2 |
| N1 S5 guard labelling | **Accepted** | S5 |
| N2 refresh mints twice | **Accepted in part: documented, no nonce.** A nonce adds server state to the UI; the browser warns before resubmitting, the cap bounds it, and the extra token is visible and revocable | S13 |
| N3 future `iat`, return path, freshness scope | **Accepted in part.** A future `iat` is not fresh, and the OPS note explains what freshness bounds. **Rejected: the return path to the settings page.** It changes the OAuth state flow (`startLogin`/`finishLogin`, `ui.ts:245-330`), which M12 does not need; the "sign in again" page links there afterwards | S14, T6d |
| N4 temp file + rename | **Accepted** | §1 PR-C, T7 |
| N5 truncate `actorId` | **Accepted** (128 chars; now enforced as a 400 by `ActorIdSchema`) | S12 |
| N6 name the RFD deviations | **Accepted** | R7 |
| N7 rollback race | **Accepted** as a known risk | R3 |
