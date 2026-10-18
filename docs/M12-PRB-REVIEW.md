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

Findings from this section: **S2** (admin revoke and revoke-all turn a client error into 503) and **N1** (the revoke-all
count). Both are in §1.

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
`'Not found'` (`index.ts:2172`). The edge maps a 404 to "no such token / actor" only on an exact match of those strings
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
_pending_

### 2.5 UI `/app/settings/tokens` and the T5 mutations
_pending_

### 2.6 Tests and mutations
_pending_

### 2.7 Docs
_pending_

### 2.8 Scope
_pending_

## 3. Verified correct
_pending_

## 4. Verdict
_pending_
