# Review: M12 PR-B (user tokens, T2-T6d)

**Task:** m12-prb-review | **Spec:** `docs/M12-IMPL-PLAN.md` (§1, §3, §4, §7, §8), `docs/rfcs/0008-verified-identity-user-tokens.md` §9 |
**Date:** 2026-10-18 | **Reviewed:** `origin/agent/m12-pr-b` at c623045 (diff `origin/main...origin/agent/m12-pr-b`,
commits 0a8785f T2, af1165f T3, fbe9cc4 T4, cafea14 T5, 6805377 T6, c623045 T6d). Line numbers are on c623045. Every claim
was checked against the code. None was taken from the implementer's report.

Status: in progress. Sections are filled in and pushed one at a time.

## 1. Findings

### Blocker
_pending_

### Should-fix
_pending_

### Nits
_pending_

## 2. Checks

### 2.1 Token security

| Item | Evidence | Result |
|---|---|---|
| Format | `generateToken(prefix)` = prefix + base64url of 32 bytes from `crypto.getRandomValues` (`workers/shared/service-tokens.ts:22-27`); `looksLikeToken` checks the exact prefix and `/^[A-Za-z0-9_-]{43}$/` (`:14`, `:46-48`). `bh_svc_` keeps the same check through the thin wrapper (`:50-52`) | ok |
| Hash-only storage | The edge generates the token and sends only `tokenHash` + `tokenPrefix` (`workers/api/user-tokens.ts:110-121`). The DO validates both (`workers/spec-do/index.ts:861-866`; prefix shape `bh_usr_` + 5 chars, `:178`). Every read goes through `USER_TOKEN_COLUMNS`, which leaves out `token_hash` (`:184-185`), and `userTokenView` (`:187-200`) | ok |
| Constant-time compare | The master compare still runs first with `constantTimeEqual` (`workers/api/principal.ts:52-55`). User tokens are looked up by SHA-256 through a unique index (`index.ts:961-978`), as service tokens are, and accepted in plan S2. With a 256-bit input, timing on the hash leaks nothing useful | ok |
| Show-once | Admin mint answers `{token: {..., plaintext}}` with `Cache-Control: no-store` (`user-tokens.ts:230`). List and revoke never carry plaintext or hash. UI: §2.5 | ok |
| 90-day max | Edge: `expiresInDays` is an integer 1-90, default 30 (`user-tokens.ts:60-63`). DO: `expiresAt` is an integer, in the future, and `<= now + 90 d + 60 s` (`index.ts:179`, `:867-870`). Table CHECK `expires_at > created_at` (`schema.sql`). All in epoch ms (`index.ts:491-493`) | ok |
| 10-token cap | `COUNT(*)` of live tokens (unrevoked, unexpired), then 409, inside the one `transactionSync` with no `await` (`index.ts:871`, `:887-894`) | ok |
| Human with `github_user_id` only | At mint: `type='human'`, `github_user_id` non-null and non-empty, `!isServiceActor` (`index.ts:872-876`). Re-checked at verify in the SQL join (`:964-971`), so an actor that later becomes a service actor or loses its GitHub id stops verifying | ok |
| Scope validation | Edge allow-list (`user-tokens.ts:56-59`); DO list (`index.ts:177`, `:860-862`); table CHECK; `maintainer` needs the target's live role and an uncapped request (`:884-886`). At use the edge maps the stored scope through `Object.hasOwn` (`principal.ts:134`), so `__proto__`/`constructor` cannot slip through, and an unknown scope gives 503 | ok |
| Revoke / revoke-all | Revoke is `UPDATE ... WHERE revoked_at IS NULL`, so it is idempotent and keeps the first `revoked_at`/`revoked_by` (`index.ts:931-940`). With the owner given (UI), another actor's token is the same `null` (404) as an unknown id (`:934`). Revoke-all covers that actor's unrevoked tokens only, and an unknown actor gives 404 (`:943-952`). `revoked_by` goes through `resolveMinter`, which refuses a service actor (`:686-701`) | ok, see S2 |
| Expiry check | Only in the DO, per request: `ut.expires_at > ?` (`index.ts:968`); no edge cache (`principal.ts:107-108`) | ok |
| Unknown vs revoked vs expired | One query for all three, and all three give `null` → `{found:false}` (`index.ts:2156-2157`) → the identical `401 {"error":"Unauthorized"}` the malformed case gives (`principal.ts:110`, `:133`). The one difference is the `last_used_at` write, which happens only for a *valid* token (`:975-977`), so it reveals nothing about an invalid one. Malformed tokens skip the DO round trip, a difference based on shape only, never on a secret | ok |

Findings from this section: **S2** (admin revoke and revoke-all turn a client error into 503). I checked the revoke-all
count and it is accurate: the `COUNT` and the `UPDATE` use the same `WHERE` inside one transaction (`index.ts:948-949`).

### 2.2 Edge

**`authenticate()` paths** (`workers/api/principal.ts`):
- `API_AUTH_TOKEN` unset → 503 before any branch (`:48`). Master (Bearer or `X-API-Token`) uses `constantTimeEqual` and
  is checked first (`:52-55`). The service branch is unchanged.
- User branch, `Authorization: Bearer` only (`:109`). A `bh_usr_` value in `X-API-Token` is not master, `bearer` is null,
  so it falls through to 401 (`:158`; tested at `workers/api/tests/user-tokens.test.ts:366`).
  - Bad shape → 401 with no DO call (`:110`).
  - `stub.fetch` throws → 503 (`:121-123`).
  - Any status other than 200, including an old DO's 404 → 503 (`:126`).
  - JSON parse throws → 503 (`:150-152`).
  - `success !== true` → `d` undefined → 503 (`:131`, `:135-143`).
  - `found === false` → 401 (`:133`).
  - `found !== true`, or a missing or empty `actorId`/`userTokenId`, or an unknown scope → 503 (`:134-143`).
  - Otherwise a `user` principal with `promotionAuthority:false` and `organizationId:null` (`:144-151`).
  - No path gives anonymous or master.

**`authorize()`** (`principal.ts:199-212`):
- Master returns early. Reads (GET/HEAD with `read`) behave as for service.
- A non-read request is allowed only when the principal is `kind === 'user'` and the route matches `USER_WRITE_ROUTES`
  with `write`, or `USER_MAINTAINER_ROUTES` with `maintainer` (`:206-210`). Everything else is 403.
- The allow-list regexes (`:169-190`) are character-for-character the dispatch regexes in `workers/api/index.ts:137-343`.
  A route that matches an allowed regex reaches the handler that regex names and no other.
- Candidate `stage` (`index.ts:217`) and `execute` (`:343`) appear in neither list, so they are 403 for all three scopes.
  The worker-level test proves it with zero handler DO calls and a hostile `sandboxRunnerUrl` in the body
  (`tests/user-tokens.test.ts:518-540`).
- Lifecycle `DELETE`s and every `/api/admin/*` route are not in either list, so they are 403. The handlers repeat
  `kind !== 'master'` (`lifecycle.ts:76`, `service-accounts.ts:80`, `user-tokens.ts:219`).
- Path traversal: ids go into DO URLs un-decoded inside one segment (`sendToSpecDo`, `index.ts:453-470`;
  `extractParentId`, `:384-388`). The edge's URL parser has already resolved `..`/`%2e%2e`, so an allowed spec-stage path
  cannot be steered to the candidate-stage DO route.

**Default deny, adding a write route mentally.** The enumeration test (`tests/user-tokens.test.ts:460-470`) scans
`index.ts` for `if (path === '...' && method === 'POST|PATCH|PUT|DELETE')` and `path.match(/^...$/) && method === ...`.
A new route written in that style that is missing from `WRITE_ROUTES` fails the test (confirmed by mutation, §2.6).
A route written another way (`method === 'POST' && path === ...`, `startsWith`, or in a new module) escapes the scan.
It is still 403 for users, because `authorize()` is an allow-list, so the gap is in the test's coverage, not in
enforcement (**N2**).

**`X-Actor-ID` rewrite** (`index.ts:104-111`): the condition is now `principal.kind === 'master'` → log, **else**
rewrite. Service, user and the reserved `session` kind are all rewritten before any handler runs. Handlers read only
the rewritten header (`request.headers.get('X-Actor-ID')`, for example `index.ts:1607`, `:1878`), and the edge also puts
it into the body fields it sets (`createdBy`, `:1879`; test `:543-556`).

**Maintainer cap, and whether it can be forged:**
- The edge wraps the stub once, after `authorize()`, for `kind==='user'` without `maintainer` (`index.ts:115-116`). The
  unwrapped `authStub` is not referenced again (`grep` shows only `:99`, `:100`, `:116`). No handler calls
  `getSpecDoStub` or `env.SPEC_DO` itself.
- The wrapper sets the header on whatever input it gets (`spec-do-auth.ts:149-157`), and `toDoRequest` handles the
  string input `/health` (`:126-130`).
- A client cannot remove the header: it is set on the outgoing request after the handler built it. A client-sent cap
  header never reaches the DO, because every handler builds fresh headers (`sendToSpecDo` `index.ts:460-469`; `toDo`
  `user-tokens.ts:69-77`). The only `new Request(request, ...)` is the rewrite (`index.ts:110`).
- Who can send the header: anything that passes `specDoAuthGate` (tier-1 `SPEC_DO_INTERNAL_TOKEN`, `spec-do-auth.ts`),
  meaning the edge and the nine internal workers. Presence only *removes* power (`isMaintainer` returns false,
  `spec-do/index.ts:2188-2189`), so an internal worker that sends it harms only itself.
- The tier-2 user-token routes need `SPEC_DO_ADMIN_TOKEN`, which only `beehive` holds (`wrangler.toml:21`;
  `scripts/start-e2e-workers.sh:91`). The admin regex leaves out exactly `/internal/user-tokens/verify`
  (`spec-do-auth.ts:63`).

**Master-only admin routes**: `/api/admin/user-tokens*` is refused by `authorize()` for users and service principals
(`principal.ts:204`), and by `handleUserTokenRoutes` (`user-tokens.ts:219`). Tests: `tests/user-tokens.test.ts:231`, `:518`.

**Stage-1 log** (`index.ts:411-429`): it fires only for master with an `X-Actor-ID` other than `unknown`. The line is
`JSON.stringify({event, method, path: url.pathname, actorId (128 chars), ray})`, with no query string, no headers other
than `cf-ray`, no body, no `Authorization` and no `Cookie`. `JSON.stringify` keeps a hostile `actorId` from breaking the
line. The AE point has blobs `[actorId, method, pathClass]` on the existing `ANALYTICS` binding (`wrangler.toml:32-34`),
and a write failure is caught (`:424-428`). `pathClass` keeps any all-lowercase segment, so an id like `alice` in
`/api/actors/alice` is kept, not replaced by `:id` (**N3**, cosmetic: the actor is already a blob).

Findings from this section: N2 and N3. No blocker.

### 2.3 Spec DO

**m9 migration** (`workers/spec-do/index.ts:1011-1012`, `LATEST_SCHEMA_VERSION = 'm9'` `:28`):
- The step is a single `exec(USER_TOKENS_SQL)`: `CREATE TABLE IF NOT EXISTS` plus two `CREATE [UNIQUE] INDEX IF NOT
  EXISTS`, so a half-applied step re-runs cleanly.
- The fresh branch runs the same SQL (`:562-563`) and starts at `m9` (`:577`).
- The text in `schema.sql` and `schema-inline.ts` is byte-identical (`schema-sync.test.ts` concatenation check).
- The step guard is unchanged: the steps must end at `LATEST` (`:1014-1016`), and push A's newer-version tolerance is
  unchanged (`:1022-1028`).
- Tests (`migrations.test.ts`):
  - a populated m8 ledger gains `user_tokens` with exactly its two indexes and keeps every row;
  - the `actors` DDL is unchanged;
  - a second init leaves `sqlite_master` byte-identical (idempotent);
  - a migrated ledger and a fresh one produce the same `user_tokens` DDL;
  - m3→m9 keeps rows;
  - the push-A tolerance list moves to `m10`+.
  
  All of these follow from the bump. None of them loosens a check.

**The unique index on `user_tokens.token_hash`.** "m9 adds no unique index" in the brief meant `actors`, and the code
matches it: `schema-sync.test.ts` asserts that the only `ON` targets are `user_tokens` and that the SQL has no
`DROP|ALTER|DELETE|UPDATE|INSERT`. The `token_hash` index is safe under the floor rule (`docs/OPS.md` rollback floor:
every step above the floor is additive and harmless to code that ignores it):
- The table is new and empty when the index is built, so `CREATE UNIQUE INDEX` cannot fail on existing data, unlike an
  `actors.github_user_id` index on a ledger with duplicates.
- Push A's code never reads or writes `user_tokens`.
- Nothing in A or B deletes actors or drops tables. `git grep` on both trees finds only a message string mentioning
  `DROP TABLE service_accounts` (`index.ts:1084`). `ORG_PURGE_ORDER` (`:93`) has no `actors`, so the FKs from
  `user_tokens` can never block a purge.
- A B→A→B redeploy skips m9, because the version is already `m9`.

**References actors only:** three FKs, all to `actors(id)`. Test: `schema-sync.test.ts` new case.

**Routes** (`index.ts:2124-2160`, inside `handleInternal`, after `handleLifecycle`, whose regexes match none of these
paths, `:2509-2513`):
- Mint takes `createdBy` from `X-Actor-ID`, never from the body (`:2128`).
- Revoke takes an optional `{actorId}` owner filter (`:2139-2148`).
- Revoke-all and list.
- Verify answers **200 `{found:false}`** for every well-formed hash that does not verify (`:2151-2158`). Only a
  malformed hash is 400, and the edge always sends a valid one. The edge treats any non-200 as 503, so 400 never
  becomes 401 either.
- Tier: `ADMIN_PATTERNS` puts every `/internal/user-tokens*` path except exactly `/verify` at tier 2
  (`spec-do-auth.ts:63`). The `internal-auth.test.ts` additions cover `verify/`, `verifyx`, `verify/revoke` and
  `x/verify` as tier 2.

**The distinct 404s** (`spec-do-auth.ts:34-35`): `'user token not found'` and `'actor not found'`, against an old DO's
`'Not found'` (`index.ts:2171`). The edge maps a 404 to "no such token / actor" only on an exact match of those strings
(`user-tokens.ts:171`, `:247`), and every other 404 to 503 (`:172`, `:248`). Nothing else in these routes throws
`NotFoundError` (mint uses `BadRequestError` for an unknown actor, `:873`), so a real "not found" always carries the
marker. On an old DO, `/internal/user-tokens*` passes the old gate as tier 1 and reaches the old router's final `'Not
found'`. Tested with an old-DO stub (`api/tests/user-tokens.test.ts:373-382`).

**All 7 `isMaintainer` call sites take the cap** (the signature requires it, `index.ts:2188`):

| # | Site | Line | How `capped` arrives |
|---|---|---|---|
| 1 | mint `maintainer` scope | `:884` | `handleInternal` → `mintUserToken(…, capped)` `:2128` |
| 2 | purge | `:2422` | `handleLifecycle` `:2539` |
| 3 | role change | `:2492` | `:2543`. The self-grant bootstrap is also refused when capped (`:2491`), which the plan did not ask for and is correct |
| 4 | `include_deleted` | `:3355` | read in `fetch` `:3326` |
| 5 | comment policy | `:4446` | `:3841` |
| 6 | close another's issue | `:4468` | `:3833` |
| 7 | comment on a restricted issue | `:4499` | `:3854` |

`capped` is computed per request from the header (`:3326`) and is never stored on the instance. The only other
`role = 'maintainer'` SQL is the bootstrap's maintainer count (`:2489`), which is not an authority decision.

Findings from this section: none.

### 2.4 Mixed versions and rollback

The edge, the UI and the Spec DO class are all in the `beehive` script. The other nine workers compile only the
changed `shared/*` files:
- `principal.ts` types;
- the `authedSpecDoStub` refactor into `toDoRequest`, which behaves the same;
- one more `ADMIN_PATTERNS` row.

The nine workers do not hold `SPEC_DO_ADMIN_TOKEN` and call no user-token route, so they are unaffected in every cell.
A = push A on `main` (floor `8de5485`, `docs/OPS.md:78-81`). B = this PR. Each cell was re-derived from the code of
both trees.

| | **old DO (A)** | **new DO (B)** |
|---|---|---|
| **old edge/UI (A)** | today | `bh_usr_` is neither master nor `bh_svc_` (`main:workers/api/principal.ts:52`), so it falls through to **401** (`:91`). An old edge never sends the cap; with no header the DO uses today's power. `/api/admin/user-tokens*` passes the old `authorize` for master, no handler matches it, and it gets the router's 404. The old UI has no settings route, and the new DO's routes go unused |
| **new edge/UI (B)** | **user token**: verify reaches the old router's `'Not found'` 404, so the edge answers **503** (`principal.ts:126`), never 401, anonymous or master. **Admin routes**: mint 404 → 503 (`user-tokens.ts:128`), list → 503 (`:146`), revoke and revoke-all: the 404 lacks the marker → 503 (`:171-172`, `:247-248`). **UI**: list/mint/revoke → "Token service unavailable" 503 page (`ui-tokens.ts:129`, `:173`, `:201`). Master, service and session paths are unchanged. **Cap**: never reaches an old DO in the normal flow, because a user principal needs a successful verify first | the PR |

Cookies: a new UI reads an old cookie with no `iat` as "not fresh", so mint asks the user to sign in again
(`ui-tokens.ts:54-58`). An old UI ignores the extra `iat` field (`main` `readSession` just `JSON.parse`s it).

**Race (accepted N7 in the plan, R3).** Within one request, a new edge's verify can hit a B instance while the
handler's call hits an A instance (a DO restart between calls). That one write ignores the cap. It needs a deploy or
rollback in the same milliseconds, and the next request fails closed (503 or 401). I agree it is acceptable.

**Rollback B → A with an m9 ledger:**
- A's `runMigrations` matches `m9` with `/^m([1-9]\d{0,5})$/`, warns and returns before any step or assertion
  (`main:workers/spec-do/index.ts:845-849`). A's own test covers `m9` explicitly
  (`main:workers/spec-do/tests/migrations.test.ts:180`).
- A has no code that enumerates `sqlite_master`, drops a table or deletes actors, so `user_tokens` sits idle.
- Clients: every `bh_usr_` request → 401; `/app/settings/tokens` → A's not-found; admin user-token routes → 404; the
  stage-1 log stops; master, service and sessions are unchanged.
- Revocations cannot be made while on A. Redeploying B skips m9, and tokens that were valid become valid again. The OPS
  runbook covers this (§2.7).
- Rolling back below A is a full outage (`Unknown schema_version`). The plan and OPS both say never to do it.

**Verdict for check 4:** every cell fails closed. No combination gives anonymous or master-like access to a `bh_usr_`
bearer. Tests: an old-DO stub where every user-token route answers 404 (`api/tests/user-tokens.test.ts:373-382`), and
the S15 outcome table (`:305-372`).

Findings from this section: none.

### 2.5 UI `/app/settings/tokens` and the T5 mutations

**Code** (`workers/api/ui.ts`, `workers/api/ui-tokens.ts`):

*Request ordering.* After `readSession` (no DO call) and the `!session` redirect, `parseTokenRoute` and `tokenPrecheck`
run **before** `findSessionActor`, the first DO read (`ui.ts:124-128` vs `:133`). The navigation chrome is lazy
(`:148-149`), so nothing reads the DO before the origin check.

*Same origin.* Every POST needs `Origin` equal to the request origin, and a missing `Origin` is refused
(`ui-tokens.ts:66`; `sameOrigin` `ui.ts:905-909`). The cookie is `SameSite=Lax; HttpOnly; Secure` (`ui.ts:897-899`).
Revoke is CSRF-checked by the same line.

*Freshness.*
- Server-side: `isFresh` needs `0 <= now - iat <= 600` (`ui-tokens.ts:54-59`). A missing, non-numeric or future `iat`
  is not fresh.
- `iat` comes from the HMAC-signed session payload: `signSession` signs the whole JSON (`ui.ts:861-865`) and `iat` is
  set at sign-in (`:338-340`). A client cannot change it without the key.
- Revoke deliberately needs no freshness (plan S14).

*Actor.*
- Mint passes `session.actorId` as both minter and target, `createdVia:'session'` (`ui-tokens.ts:171`). The form is
  read only for `name`, `scope` and `expiresInDays` (`:164-165`).
- The DO adds defence in depth: a session mint needs `X-Actor-ID === actorId` (`spec-do/index.ts:878-880`).
- List: the DO filters by `actorId` and the page filters again (`ui-tokens.ts:127`, `:133`).
- Revoke is owner-scoped through `{actorId: session.actorId}` (`:200`).

*Escaping.* Every DO-sourced value goes through `esc` (`:140`, `:185-186`, `:179`). This includes the token name,
which master can set through the admin route, so another principal can control it. The revoke action URL uses
`encodeURIComponent(t.id)` inside a double-quoted attribute (`:139`).

*Show once.* The mint answer is a 200 page with `Cache-Control: no-store` (also set by `appPage`,
`ui-layout.ts:306`) and `Referrer-Policy: no-referrer` (`ui-tokens.ts:190-191`). The list shows the prefix only.

*Old DO.* List, mint or revoke against an old DO all give the 503 "Token service unavailable" page, never "no tokens"
(`:129`, `:173`, `:201`).

**Mutation results.** I ran each mutation alone in this worktree against `workers/api/tests/ui-tokens.test.ts` (19
tests, all green before) and reverted it after the run. After the last revert the tree was clean.

| # | Mutation | Result |
|---|---|---|
| T5-1 | freshness check removed from `tokenPrecheck` | **killed**: "a stale, missing or future iat…" |
| T5-1b | future `iat` accepted (`age >= 0` removed) | **killed**: 2 tests |
| T5-2a | mint target read from a form field `actorId` | **killed**: "ignores any actor named in the form (S5)" |
| T5-2b | minter **and** target from the form (defeats the DO's `created_by = actor_id` check) | **killed**: same test |
| T5-3a | the explicit `Cache-Control: no-store` on the mint page removed | **survived**: `appPage` sends it too. The guard is redundant, not untested |
| T5-3b | no-store removed from both the mint page and `appPage` | **killed**: 2 tests, including the S13 header test |
| T5-4 | origin check removed | **killed**: mint and revoke cross-origin tests |
| T5-5 | a DO read (`findSessionActor`) moved before the precheck | **killed**: 3 "zero DO calls" tests |
| T5-6a/b/c | `esc` removed from the token name (list), the plaintext (mint page), or the DO refusal text | **all survived**: no test puts markup in a token name or an error (**S1**) |
| T5-7 | `Referrer-Policy` removed | **killed** |
| T5-8 | revoke not owner-scoped | **killed** |
| T5-9 | list not filtered by actor | **killed** |
| T5-10 | sign-in stops writing `iat` | **killed** |

Findings from this section: **S1** (no escaping test).

### 2.6 Tests and mutations

**Runs (this worktree, c623045, local only):**
- `npm run typecheck`: clean.
- `npm test`: **988 passed, 0 failed** (42 files). The first run had 28 failures, all in `tests/cli-behavior.test.ts`,
  because a fresh worktree has no `cli/node_modules`. After `npm ci` in `cli/`, that file passes 28/28. This is
  environmental, not the PR.
- Local e2e (`E2E_UI=1 scripts/start-e2e-workers.sh`, then `npm run test:e2e:local`):
  - **First run on a fresh ledger: 1 suite failed.** `tests/e2e/user-tokens.test.ts` `beforeAll` got 403 at `:52`
    (the maintainer bootstrap self-grant).
  - The cause is a pre-existing pattern: `ledger-lifecycle.test.ts:35-44`, `ui-nav.test.ts:83-89` and `ui-issues.test.ts`
    each bootstrap a maintainer with the same "find one, otherwise self-grant" code. vitest runs files in parallel
    (`threads: true`). On an empty ledger another file wins the bootstrap between this file's list and its grant, and the
    DO refuses a second bootstrap.
  - The file run alone: 4/4. Full suite again: **74 passed, 5 skipped, 0 failed**, including all 4 user-token e2e tests.
    Workers stopped afterwards. Nothing touched production; no deploy, no push to `cf` or `main`.
  - Finding **N4**.
- Loosened assertions: none. Every change to an existing test is either the `m8`→`m9` version bump or the new required
  `isMaintainer(…, false)` argument (`ledger-lifecycle`, `service-tokens`, `issue-comments` seed call). The push-A
  tolerance list moves from `m9…` to `m10…` (m9 is now known), and the `internal-auth` admin loop strips `?actorId=`
  before `isAdminRoute`, which takes a pathname. Additions only otherwise.

**My mutations on T3/T4 guards** (each applied alone, run against the five user-token, issue-comments, internal-auth and
ledger-lifecycle files, 159 tests, then reverted; the tree was clean after every one). All of these go beyond the
implementer's list:

| # | Guard mutated | Result (a test that failed) |
|---|---|---|
| E1 | old DO 404 on verify → 401 instead of 503 | killed: "an old DO without the route (404) -> 503" |
| E2 | `found === true` no longer required | killed: "found missing / found \"true\" -> 503" |
| E3 | any write for a `write` token (allow-list removed) | killed: 5 S9 tests |
| E4 / E4b | candidate `stage` / `execute` added to the allow-list | killed: S9 matrix and through-the-worker tests |
| E5 | rewrite only for `service` (the old condition) | killed: M12 exit attribution and 2 more |
| E6 / E6b | `/health` / issue-status handler given the unwrapped stub | killed: the cap loop (and the real-DO close test for E6b) |
| E7 | `read` tokens not capped | killed: "read token of a maintainer actor … carries the cap" |
| E8 | comment-policy route open to the `write` scope | killed: S9 tests |
| E9 / E10 / E11 | stage-1 log gets the query string / `Authorization` / an untruncated actor | killed each |
| E12 | unknown stored scope mapped to read_write | killed: "an unknown scope / inherited scope name -> 503" |
| D1 / D2 / D3 | verify ignores revocation / expiry / service actor | killed: DO and edge S4 tests |
| D4 | mint for any actor type | killed: S5 tests (DO and edge) |
| D5 | live cap `>=` → `>` | killed: the cap test and the 12-parallel-mints test |
| D6 | `maintainer` scope minted without the role | killed: S6 |
| D7 | `isMaintainer` ignores the cap | killed: 8 tests |
| D8 / D8b / D8c | one call site passes `false` (status, comment, `include_deleted`) | killed each, by its own test |
| D9 | capped self-grant bootstrap allowed | killed |
| D10 | user-token routes made tier 1 | killed: 2 `internal-auth` tests |
| D11 | DO revoke ignores the owner | killed |
| D12 | verify not-found → 404 | killed: 7 tests |
| D13 | session mint for another actor | killed (N1 defence in depth) |
| D14 | 90-day ceiling removed in the DO | killed: 2 tests |
| D15 | `token_hash` added to `USER_TOKEN_COLUMNS` only | **survived**: it is harmless, because `userTokenView` copies named fields only |
| D15b | `token_hash` added to the columns **and** the view | killed: 3 "never a hash" tests |
| N2a | a new write route in the dispatch style, missing from the table | killed: the enumeration test |
| N2b | a new write route in another style (`method === 'POST' && path.startsWith(...)`) | **survived**: the scan misses it, but `authorize()` still answers 403 (N2) |

**Confirmed by a scratch test** (deleted afterwards). With master and `X-Actor-ID: typo-actor`:
- admin mint → `400 "createdBy (X-Actor-ID) must be an existing actor"`;
- admin revoke → `503 "Token service unavailable"`;
- admin revoke-all → `503 "Token service unavailable"`.

This is finding **S2**.

Findings from this section: S2 (confirmed), N2 (confirmed), N4.

### 2.7 Docs

**`docs/OPS.md` "User tokens: mint, rotate, revoke"** (`:260-331`). I checked each statement against the code:
- Scopes and the allow-list match `principal.ts:169-190`.
- The deny list matches S9/A2. The cap behaviour matches `index.ts:115-116`.
- The live role read matches `spec-do/index.ts:2188-2195`. The 90-day, 10-token and show-once rules match.
- Mint steps:
  - (1) session: freshness, plus the note that GitHub re-auth is silent (plan N3);
  - (2) admin: the body fields and the `scope`/`expiresInDays` defaults match `user-tokens.ts:52-64`.
- (3) list, (4) rotate, (5) revoke, revoke-all, and the allowlist-removal line in bold.
- (6) re-check after a B rollback and re-deploy.
- Failure answers, including the deliberate service 404→401 vs user 404→503 difference.

The steps are in the right order.

**Deploy steps** (`:302-306`): before the push, `schema_version = m8` and A is live. After it, `prod-health.sh`,
then `m9`, then the `user_tokens` row in `sqlite_master`, then the first mint. No new secret, and no production e2e
without approval. This matches plan §3 push B.

**Rollback:** the floor block on `main` (`:78-92`) is unchanged and still correct for m9:
- m9 is a new table that references only `actors`;
- the floor never hard-deletes from `actors`;
- no new constraint is added on an old table.

The user-token section covers only the re-deploy after a rollback (step 6). It does not say how to roll back B
(redeploy `8de5485` or later, never earlier) or what clients then see. **N1**.

**Stage-1 log**: the log line, the AE point and the query are documented (`:307-325`). I did not run the AE SQL. The
implementer says the same in OPEN-QUESTIONS (`:711-714`).

**A4 line**: present in OPS (`:327-331`), headed "**Assumption A4 (unverified, 2026-10-18)**". It is also in FOCUS (a
verification task with the steps) and OPEN-QUESTIONS (`:699-709`, "Status: Open … unverified"). All three name traces
and the internal headers, as review F6 asked.

**`docs/OPEN-QUESTIONS.md` after the heredoc append:**
- The diff is +22/−0.
- The status update on the 2026-10-17 entry (`:669-672`) and the new entry (`:699-714`) both keep their backtick code
  spans. An unquoted heredoc would have run them as command substitutions, and it did not.
- The file ends with a single `\n`, with no stray `EOF` line, no truncation, and no change above the insertion points.
- One cosmetic blemish: two blank lines before the new heading (`:697-698`, **N5**).

**FOCUS / MILESTONES**: the M12 section lists everything T6d asked for:
- the A4 task;
- rate limiting deferred;
- the `authGate ===` follow-up;
- the verify-404 difference;
- the M11 handoff (m10 only after a clean duplicate check);
- the stage-2 prerequisite.

MILESTONES says PR-B is not reviewed or deployed and lists exit criteria (1)-(6). Accurate.

### 2.8 Scope

`git diff --name-only origin/main...origin/agent/m12-pr-b` touches no `cli/`, no wrangler config and no script.
`SESSION_SIGNING_KEY` appears only in FOCUS/MILESTONES as future work (PR-D1/D2). There is no M11 work: no `m10` and no
`actors` index, and `schema-sync.test.ts` asserts the latter. The sessions are still signed with `API_AUTH_TOKEN`
(`ui.ts:338-341`), as planned for PR-B.

Small additions beyond the plan's letter, all in scope:
- the capped-bootstrap refusal (`spec-do/index.ts:2490-2491`): a correct tightening;
- the `toDoRequest` extraction (`spec-do-auth.ts:126-130`), required by F1(b);
- a FOCUS note about snake_case vs camelCase in `IssueResponse`.

Nothing to remove.

## 3. Verified correct
_pending_

## 4. Verdict
_pending_
