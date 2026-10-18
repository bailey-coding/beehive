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
| Unknown vs revoked vs expired | One query for all three, and all three give `null` → `{found:false}` (`index.ts:2156-2157`) → the identical `401 {"error":"Unauthorized"}` the malformed case gives (`principal.ts:111`, `:133`). The one difference is the `last_used_at` write, which happens only for a *valid* token (`:975-977`), so it reveals nothing about an invalid one. Malformed tokens skip the DO round trip, a difference based on shape only, never on a secret | ok |

Findings from this section: **S2** (admin revoke and revoke-all turn a client error into 503) and **N1** (the revoke-all
count). Both are in §1.

### 2.2 Edge
_pending_

### 2.3 Spec DO
_pending_

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
