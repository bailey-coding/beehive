---
RFD-0008
---

# RFD: Verified identity and user tokens (M12)

**Status:** Accepted (2026-10-17; decisions in section 9)
**Date:** 2026-10-17
**Author:** the agent (Claude Opus 5.5, task m12-rfc); spine work, so the decisions in section 8 are the maintainer's
**Related:** RFD-0003 (service tokens), RFD-0007 (Spec DO tier tokens), ADR-0007 (fail-closed edge auth), `docs/MILESTONES.md` M12, M3, M6.2
**Supersedes:** None

## Summary

Capability minting (M3 + M6.2) has to grant capabilities to an actor, and today nothing proves who an actor is. This RFD lays out
three options for a verified `kind: 'user'` principal, plus one minor variant. It recommends option A: opaque per-user tokens,
stored hashed in the Spec DO like `service_tokens`, minted from the UI session. It also covers the two-push schema migration,
the future of the master token, and the decisions the maintainer must make. It decides nothing.

## 1. Problem: what each principal can assert today

| Principal | How it authenticates | Actor | What it can assert |
|---|---|---|---|
| **master** | `API_AUTH_TOKEN` as bearer or `X-API-Token` (`workers/api/principal.ts:38-41`) | client-sent `X-Actor-ID`, else `'unknown'` (`:44`) | Everything: `authorize()` returns early for master (`:99`); only master reaches admin and lifecycle routes (`workers/api/service-accounts.ts:78`, `workers/api/lifecycle.ts:76`). Can name **any** actor, including a maintainer, so it gets every `isMaintainer` check (`workers/spec-do/index.ts:1946-1953`): purge (`:2179`), role changes (`:2248`), comment policy and closing other people's issues (`:4193`, `:4215`). Can self-grant maintainer while none exists (`:2246-2247`). |
| **service** | `bh_svc_` bearer, hash verified by the DO (`principal.ts:52-88`, `index.ts:593-622`) | the account's actor; the edge overwrites `X-Actor-ID` (`workers/api/index.ts:100-105`) | Reads only: scopes forced to `['read']` (`principal.ts:81`), `GET` on non-admin `/api/*` (`:100-104`). Never a maintainer (`index.ts:1950`), cannot write issues (`:1516`). |
| **UI session** | GitHub OAuth, login allowlist `ALLOWED_GITHUB_USERS` (`workers/api/ui.ts:301-309`); this is not a `Principal` because `handleUi` runs before `authenticate()` (`index.ts:85-91`) | `ensureActor` maps the GitHub id to an `actors` row (`ui.ts:311`, `:323-332`) | Writes as `session.actorId` straight to the DO (`ui.ts:628`), with maintainer status from `actors.role` (`:128`). **The cookie is HMAC-signed with `API_AUTH_TOKEN`** (`:316-318`, `:834`), so any master-token holder can forge a session for any actor. |
| **internal worker** | tier-1 `SPEC_DO_INTERNAL_TOKEN` straight to the DO (`workers/shared/spec-do-auth.ts:82-100`) | fixed strings, such as `'queue-consumer'` (`workers/queue-consumer/index.ts:134`) or the gate's `actorId` (`workers/gate-workflow/index.ts:870`) | Any `X-Actor-ID`. The DO trusts the header from all nine tier-1 holders. |

`kind: 'session'` is already reserved in the union (`workers/shared/principal.ts:4-6`, `:12`), and `promotionAuthority` is not
enforced (`:17`). In short, the only principal whose actor is verified is a service token, and it is read-only. A capability
granted to actor X can be used by anyone holding the master token, and that includes the CLI user: the CLI sends the master
token (`cli/src/utils/api-client.ts:91-92`) together with whatever actor `--actor`, `BEEHIVE_ACTOR` or `defaultActor` names
(`:139-145`, `docs/OPS.md` "CLI actor attribution").

## 2. Requirements and non-goals

**Requirements (M12 exit):**
- R1. A write made with a user credential cannot name another actor: the edge overwrites `X-Actor-ID` (the M12 minimum, `docs/MILESTONES.md` M12).
- R2. A user credential maps to exactly one `actors` row, which must not be a service actor. It expires, can be revoked
  without a deploy, and is stored only as a hash.
- R3. Fail closed (ADR-0007). A missing secret answers 503, a bad token 401, and a backend error 503. A user token never
  falls back to anonymous or to master.
- R4. Mixed-version safe: the change works with an old or a new peer on either side and the schema change is additive
  (AGENTS.md working conventions). Rollback stays a ref operation (rule 7).
- R5. The CLI can act as its user without holding the master token.
- R6. The UI session and API tokens agree on identity, and the master token can no longer forge a session.

**Non-goals (M3 / M6.2):** capability tokens of any kind (time-bound trial or merge grants, service or path scopes,
capability-scoped mounting); delegation; making agent actors write-capable; changing the internal tier-1 trust (row 4 above:
M12 protects the public edge, not the internal mesh); enforcing `promotionAuthority`; organisation-confined scopes
(`organizationId` stays `null`, `shared/principal.ts:19-20`).

## 3. Options

### A. Opaque per-user tokens in a Spec DO table (extends RFD-0003)

- **Format:** `bh_usr_` + base64url of 32 random bytes. `generateServiceToken`, `hashToken` and `looksLikeServiceToken`
  (`workers/shared/service-tokens.ts:17-35`) generalise to take the prefix as a parameter. The distinct prefix lets
  `authenticate()` route the token without a lookup and lets secret scanners recognise it.
- **Storage:** new table `user_tokens(id PK, actor_id NOT NULL FK actors, name TEXT, token_hash NOT NULL UNIQUE, token_prefix,
  scopes TEXT NOT NULL, created_by NOT NULL FK actors, created_via TEXT ('session'|'admin'), created_at, expires_at NOT NULL,
  revoked_at, revoked_by, last_used_at)`. It follows `service_tokens` (`workers/spec-do/schema.sql:412-428`) but keys to
  `actors.id` directly; there is no account row. A `scopes` CHECK can only be widened by rebuilding the table
  (`docs/M8-UI-ISSUES-PLAN.md` §13), so the allowed values must be chosen up front (decision 3). Expiry is at most 90 days,
  `last_used_at` is written at most once a minute (as in `index.ts:123-124`), and revocation is one row update.
- **Verify:** add a tier-1 DO route, `POST /internal/user-tokens/verify {tokenHash}`. It answers **200 `{found:false}`** for
  an unknown, revoked or expired token, never 404. The DO router answers 404 for a route it lacks (`index.ts:1932`), so an
  old DO then shows up as 503 and is never mistaken for a bad token (the 2026-10-16 "404 is not empty" rule). The SQL repeats
  the service-token join: not revoked, not expired, actor exists, actor is not a service actor.
- **authenticate():** add a `bh_usr_` branch after the service branch (`principal.ts:52`) that returns
  `{kind:'user', actorId, scopes, promotionAuthority:false, organizationId:null, userTokenId}`. `authorize()` gets a user
  rule: `read` behaves like service; `write` adds non-GET on `/api/*`, but never on `/api/admin/*`, the lifecycle routes, or
  `PATCH .../promotion-authority`. The edge rewrite at `index.ts:100` becomes `principal.kind !== 'master'`, which covers
  service and user. `/api/whoami` reports `userTokenId`.
- **Minting:** (i) a **UI settings page** `/app/settings/tokens` where the session's own actor mints a token for itself only,
  never for an actor named in a form field. The plaintext is shown once with `Cache-Control: no-store`, the page lists tokens
  by prefix, and each can be revoked. (ii) **Maintainer-minted**: a master-only `/api/admin/user-tokens {actorId}` for
  bootstrap and break-glass. (iii) **CLI device-code login**, deferred. It needs a polling route that runs before the bearer
  gate, which is an exception to ADR-0007 (the UI routes are the only precedent, `index.ts:85-91`).
- **CLI:** `beehive auth login --token bh_usr_...` already works unchanged (`cli/src/commands/auth.ts:12-55`). Add
  `auth whoami`. `--actor`/`BEEHIVE_ACTOR` become warnings and are ignored when the token is a user token. Write the config
  file with mode 0600, since `saveConfig` uses the default mode (`cli/src/utils/config.ts:120`).
- **Cost and risk:** a DO round trip per request, the same as service tokens today. Revocation takes effect on the next
  request. It is the smallest new idea: a copy of a path that is already reviewed and tested
  (`workers/spec-do/tests/service-tokens.test.ts`). It needs a schema bump (section 4).

### B. Signed (JWT-style) tokens verified at the edge

- **Format:** `bh_ujt_` + `base64url(payload).base64url(HMAC-SHA256)`, payload `{sub: actorId, scp, iat, exp, jti, kid}`. It
  is signed with a new secret `USER_TOKEN_SIGNING_KEY`, never `API_AUTH_TOKEN`. If the key is unset, the edge answers 503.
- **Verify:** no DO call; `authenticate()` checks the signature and `exp`. **Revocation** then needs one of: (a) short
  lifetimes (about 1h) plus a refresh token, which is stateful and so is option A again; (b) a `jti` deny-list in the DO,
  which brings the round trip back; or (c) rotating the signing key, which revokes every token at once. **Key rotation**:
  the edge accepts `kid ∈ {current, previous}`, set by two secrets, and rotating needs a secret change on `beehive`.
  **Fail-closed tension**: without a DO lookup the edge cannot tell that the actor was deleted or demoted, or that the user
  left `ALLOWED_GITHUB_USERS`, until the token expires. A token for a service actor has to be blocked at mint time only.
- **Storage:** none needed. Optionally a `user_token_issuance` row per `jti` for audit, which is a schema change anyway.
- **Minting / UI / CLI:** same as A.
- **Cost and risk:** it saves one DO request per call. But most `/api/*` handlers call the DO anyway (`index.ts:398-410`),
  and the per-request DO lookup has caused no problems for service tokens (`principal.ts:52-88`). It adds key management and
  a weaker revocation story. Hand-rolled JWT parsing is a classic bug surface (alg confusion, `exp` units).

### C. Minimal step: master token for break-glass plus a signed actor assertion

- **Format:** the CLI keeps the master token and adds `X-Actor-Assertion: base64url({actorId, exp}).HMAC(ACTOR_ASSERTION_KEY)`.
  The UI session issues it from a settings page with a lifetime of 30 days or less. The edge verifies it and overwrites
  `X-Actor-ID`. A master request with no assertion keeps `'unknown'`, or the reserved `master` actor
  (`workers/shared/ledger-lifecycle.ts:19`).
- **Storage:** none. No schema change and no migration, and it can ship in one push.
- **Weakness:** it proves **attribution, not authority**. The bearer still needs the master token, which can do everything,
  so a CLI user with the master token can simply omit the assertion. Unless the edge also refuses master requests that name
  an actor without an assertion, nothing is gained. Even then, every user still holds the master token. Revocation is by
  expiry or by rotating the key. This option does not meet R5.
- **Cost:** about a day. It suits a stopgap if M12 is postponed. Its signing helper and its UI page would carry over into A.

### Rejected variant: reuse `service_accounts` for humans

This would give each user a service account (type `human`). But `isServiceActor` (`index.ts:583`) is defined as "has a
`service_accounts` row" and it blocks maintainer status (`:1950`), issue writes (`:1516`) and roles (`:2243`). Overloading
it would quietly change all of those checks.

### Also considered: GitHub token as bearer or exchange

The edge would accept a GitHub OAuth token (for example `gh auth token`) and check it against `api.github.com/user` on every
request, or once in an exchange for a `bh_usr_` token. Used per request, it puts an external call on the auth path, so a
GitHub outage would block authentication (rules 4 and R3). As an exchange it is a reasonable **minting flow for A**, but it
needs a pre-bearer route, like device code. Deferred.

## 4. Migration (options A and B-with-audit)

`runMigrations` throws on an unknown version (`workers/spec-do/index.ts:842`), and it also throws when the final version is
not `LATEST_SCHEMA_VERSION` (`:853-857`). `init()` rethrows either error (`:500-506`), so rolling back across a version bump
is an outage (`docs/OPEN-QUESTIONS.md` 2026-10-17 "A schema version bump..."). m4-m8 shipped in one push with a read-only
`schema_version` check before and after (`docs/OPS.md` "Deploy checklist"), and none of m3-m8 was rollback-safe. Use the
two-push method (`docs/M8-UI-ISSUES-PLAN.md` §13):

1. **Push A (no bump).** `runMigrations` accepts a stored `m<N>` with N above the newest version this code knows: it logs a
   warning and returns without running steps or the final assertion. Tests: an `m99` ledger initialises and serves; an
   unknown non-`m<N>` value still throws. Add an OPS checklist line. Push A becomes the rollback floor.
2. **Push B (only after A is live and a read shows `schema_version` unchanged).** Add step `m10`
   (decision 6): `CREATE TABLE IF NOT EXISTS user_tokens` plus its unique hash index and an index on `actor_id`. The same
   section goes in `initSchema` (`:515-531`), in `schema.sql` and `schema-inline.ts` together (`schema-sync.test.ts`), and
   bumps `LATEST_SCHEMA_VERSION` (`:27`). `migrations.test.ts` gets "fresh ledger starts at m<N>". The same push carries the
   verify, mint, list and revoke routes, the `authenticate()` branch, and the settings page. Actors are never purged
   (`ORG_PURGE_ORDER`, `:92-107`, has no `actors`), so purge order is unchanged.
3. **Push C (CLI and docs).** This needs no worker change and can merge with B.

**Mixed versions.** The DO class lives in the `beehive` script (`workers/api/index.ts:72`), and only `beehive` changes, so the
nine other workers are unaffected. Within one deploy the edge and the DO can still briefly differ:
- new edge, old DO: the verify route is missing, so the DO answers 404, which the edge maps to 503 (see A), and a user-token
  request fails closed;
- old edge, new DO: a `bh_usr_` bearer is neither master nor `bh_svc_`, so the edge answers 401 (`principal.ts:91`);
- rollback from B to A: A tolerates the higher version, never reads `user_tokens`, and user tokens answer 401.

Option C needs no migration; it needs only `ACTOR_ASSERTION_KEY` set before the push (as in OPS deploy step 0).

## 5. Master-token future

Today the master token asserts any actor (section 1). Proposed in stages:
- **Stage 1 (with push B):** no change in behaviour. Every master request that names an actor logs a structured line with the
  method, path and actor, but never the token. Optionally an Analytics Engine data point records `via=master` for audit
  volume. Durable audit stays in the DO's existing rows (`created_by`, `purge_log`).
- **Stage 2 (once the CLI and scripts use user tokens):** the master principal **cannot assert a human actor**. If
  `X-Actor-ID` names a `human` actor, the edge answers 403 "use a user token". Agent and reserved ids still pass, so e2e and
  scripts keep working. As a result, master can no longer gain maintainer power by naming a maintainer.
- **Break-glass:** with stage 2, lifecycle actions (purge `index.ts:2179`, roles `:2248`) need a maintainer actor that master
  can no longer name. Choose one of: (a) the reserved `master` actor counts as a maintainer only on edge lifecycle routes,
  which are already master-only (`lifecycle.ts:76`), and its use is logged to `purge_log`; or (b) lifecycle moves to
  maintainer user tokens and master keeps only the `/api/admin/*` routes, such as minting the first token (decision 4).
- **Session signing:** move the UI cookie off `API_AUTH_TOKEN` to `SESSION_SIGNING_KEY` (`ui.ts:318`, `:834`). For one
  release, accept cookies signed with either key. After that, master can no longer forge sessions (R6).

## 6. Security analysis

- **Theft:** a token has 256 bits of entropy and only its hash is stored. The token is a bearer secret: if stolen, the thief
  has the actor's write access until revocation or expiry (90 days at most). Mitigations: the settings page shows
  `last_used_at` and allows one-click revocation; the maintainer has an admin "revoke all for actor" route; the CLI config is
  written with mode 0600; the plaintext is shown once with `no-store`. Under B, theft cannot be undone per token.
- **Scope escalation:** `read` tokens are read-only at the edge, as service tokens are. No user token can reach
  `/api/admin/*`, lifecycle or promotion-authority routes. A user token **cannot mint tokens**: minting needs a UI session
  (or master), so a stolen token cannot make itself permanent. Option: require a session younger than 10 minutes to mint
  (decision 5).
- **Who mints for whom:** a session can mint only for its own `actorId`. Master can mint for any actor that is `human`, is
  not a service actor, and has a `github_user_id` (decision 2). **Agent actors do not hold user tokens.** Agents read through
  service accounts (RFD-0003) and get write access later through M3 capabilities. That keeps a single kind of grant for
  agents.
- **Maintainer via tokens:** `isMaintainer` reads `actors.role` (`index.ts:1946`), so a maintainer's write token can do
  everything the maintainer can on DO routes. That is the same power the UI session has today (`ui.ts:128`). Alternatively,
  require a `maintainer` token scope before maintainer checks apply (decision 3).
- **Allowlist drift:** removing a login from `ALLOWED_GITHUB_USERS` blocks UI login but does not touch tokens already issued.
  Removal must also revoke that actor's tokens (OPS step). Re-checking the allowlist at verify time is fragile, because the
  allowlist holds logins and those can change.
- **Rate limiting:** none exists today. Every well-formed `bh_usr_` token costs one DO request, so a flood of fake tokens is
  load on the DO, not a brute-force risk. Proposal: a per-IP limit on failed verifications, using the Workers rate-limiting
  binding (wrangler config to be verified first, `docs/OPEN-QUESTIONS.md` if it surprises).
- **Logging:** never log the plaintext or the hash. Log the token `id` or display prefix only. Error bodies stay generic
  (`Unauthorized`), as `principal.ts` does.
- **Rotation:** mint the new token, switch the client, revoke the old one, as for service tokens (`docs/OPS.md`). Under B,
  `kid` key rotation is extra work. Also, `authGate` on the other nine workers compares the master token with `===`
  (`workers/shared/auth.ts:37`, `:42`), not in constant time. That is out of scope here; noted for a follow-up.

## 7. Test plan and staged rollout

**Unit tests (vitest, no network):** `principal.test` cases: a `bh_usr_` token that is valid, unknown, revoked, expired, or
belongs to a deleted or service actor, and a DO that answers 404, 500 or throws (503). `authorize` table for user `read` and
`write` against admin, lifecycle and promotion-authority routes. The edge overwrites a client `X-Actor-ID` for user tokens.
DO `user-tokens.test` covers mint (self only via session, master for a human actor only, refusal for agent or service
actors), verify, `last_used_at` throttling, and revocation. `migrations.test` covers push A tolerance and the fresh ledger
at the new version. `schema-sync.test`. `ui.test` covers the settings page: actor from the session, plaintext once,
`no-store`, and cookies under both signing keys during the transition. CLI: config file mode 0600, and `--actor` ignored
with a user token.

**Local e2e (`npm run test:e2e:local`):** mint via the master admin route, then create an issue with the user token while
sending a different `X-Actor-ID`. The issue must be attributed to the token's actor (the M12 exit criterion). Then revoke
the token and expect 401 on the next request. **No production e2e without human approval.**

**Rollout:**
1. Push A, the rollback floor. Ships alone; revert by ref.
2. Push B: table, routes, edge branch, settings page. User tokens are opt-in, and the master token, sessions and service
   tokens behave as before, so reverting to A is a ref operation (rule 7) that only turns user tokens into 401s.
3. CLI release and an OPS section "User tokens: mint, rotate, revoke".
4. Session signing key: put the secret first (OPS step 0), then accept both keys, then drop the old one.
5. Master stage 2, a separate decision: only after the stage-1 logs show no human-actor master traffic.

## 8. Recommendation

**Option A**, minted from the UI settings page, with the master admin route for bootstrap. Device-code login is deferred.
Reasons:
- It reuses a design that already ships, is reviewed and has tests (RFD-0003): same hashing, prefix check and verify route
  pattern.
- Revocation takes effect on the next request and needs no key management, which satisfies R2 and R3 without the gaps of
  option B.
- The DO round trip costs no more than service tokens already do.
- It meets R5, which option C cannot.
- Its only real cost is the schema bump, and the two-push method makes that rollback-safe and can be shared with other milestones.

Option C is worth doing only as a stopgap if A is postponed. Option B should be revisited only if profiling shows the verify
request matters (rule 1: measure first).

### Decisions for the maintainer

1. Option A, B or C, or C now and A later.
2. Who may hold a user token: human actors with `github_user_id` only? Do agent actors stay excluded until M3 capabilities?
3. Token scopes and the CHECK values: `read`/`read_write` only, or also a `maintainer` scope that maintainer checks require?
   This is hard to change later, because widening the CHECK needs a table rebuild.
4. Master-token future: stage 2 (master cannot assert human actors) yes or no, and break-glass via (a) the reserved
   `master` actor treated as maintainer on lifecycle routes, or (b) lifecycle moves to maintainer user tokens.
5. Minting rules: maximum lifetime (90 days proposed), whether minting needs a fresh session (10 minutes), and whether
   device-code or GitHub-token exchange login (an exception to ADR-0007) is ever allowed.
6. Ordering with M12: M12 takes `m9` (user_tokens); idempotency (m5a) takes `m10`; M11 will take the next available version.
7. Move the UI session to `SESSION_SIGNING_KEY` in M12 (recommended; it closes a forgery path the master token opens today)
   or as its own task.
8. Rate limiting on failed verifications: in M12, or deferred.
9. Should `ensureActor`'s 500-actor lookup limit (`ui.ts:122`, `:324`) be fixed first? The settings page and the session
   check both depend on it.

## 9. Decisions (2026-10-17)

Decided by the maintainer (asked directly):

| # | Decision |
|---|---|
| 1 | **Option A**: per-user tokens in a Spec DO `user_tokens` table, minted from a UI settings page, with the master admin route for bootstrap. |
| 3 | Scopes `read`, `read_write` and `maintainer`. Maintainer-only routes (comment-policy PATCH, lifecycle/purge, role changes) require the `maintainer` scope, so a leaked everyday token cannot act as a maintainer. |
| 4 | Master token: **log first, stop later.** Stage 1 logs every master request that names a human actor. Stage 2 (master can no longer act as a human; the reserved `master` actor is the break-glass on lifecycle routes) is a separate decision after the logs show no such traffic. |
| 7 | **Own `SESSION_SIGNING_KEY` in M12**: put the secret first (OPS step 0), accept both keys, then drop the old one. |

Defaults chosen by the orchestrating agent, because the maintainer asked for the plan, review, implement, review pipeline to continue; the maintainer can override any of them before the task that depends on it starts:

| # | Default |
|---|---|
| 2 | Human actors with a `github_user_id` only. Agent actors stay excluded until the M3/M6.2 capability work. |
| 5 | Maximum lifetime 90 days; minting needs a session under 10 minutes old; no device-code or GitHub-token exchange login in M12 (it needs an exception to ADR-0007). |
| 6 | Share push A (tolerate a newer `schema_version`) with M12. M12 takes schema `m9` (user_tokens); idempotency (m5a) takes `m10`; M11 will take the next available version. |
| 8 | Rate limiting on failed verifications is deferred; record it in `docs/FOCUS.md`. |
| 9 | Yes: fix the 500-actor lookup limit first, as the first task, because the settings page and the session check depend on it. |

Status becomes **Accepted** with these decisions. Implementation order, per section 7: the lookup-limit fix, push A, then push B, then the CLI release and OPS section, then the session key, with master stage 2 left as its own later decision.
