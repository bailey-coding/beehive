# M12 implementation plan: verified identity and user tokens

**Task:** m12-plan | **Spec:** `docs/rfcs/0008-verified-identity-user-tokens.md` (Accepted; section 9 decisions are not
re-opened here) | **Date:** 2026-10-18 | Spine work (AGENTS.md rule 2): every PR is reviewed by the maintainer plus an
independent review agent. Line numbers are on `main` at e06cf48. No code here; master stage 2 is out of scope.

## 1. File-by-file plan

**T0, actor lookup (PR-0)**
- `workers/spec-do/index.ts`: `GET /api/actors` gains an optional `github_user_id` filter (`listActors`, `:3875`,
  route `:3165`), ordered `created_at ASC` so the oldest row wins if duplicates exist. No schema change, no index.
- `workers/api/ui.ts`: the session check (`:123`) becomes `GET /api/actors/<session.actorId>`: 200 means proceed, 404
  means re-login (today's behaviour), anything else is a 503 page rather than a login loop. `ensureActor` (`:332-341`) sends
  `?github_user_id=<id>&limit=500&offset=0` and **keeps** its client-side `.find` on `github_user_id`, so an old DO that
  ignores the filter behaves exactly as today.

**Push A (PR-A)**
- `workers/spec-do/index.ts` `runMigrations` (`:808-859`): if the stored version matches `/^m(\d+)$/` with N above the
  newest step, `console.warn` once and return before the steps and the final assertion. Any other unknown value still
  throws (`:842`). `initSchema`'s fresh-ledger branch is unchanged.
- `docs/OPS.md` deploy checklist: a "rollback floor" line naming push A's commit.

**Push B (PR-B), one push, five reviewable commits T2-T6**
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
- `workers/spec-do/index.ts`: `LATEST_SCHEMA_VERSION = 'm9'` (`:27`); step `['m9', () => this.db!.exec(USER_TOKENS_SQL)]`;
  the same exec in `initSchema` (`:515-531`). Actors are never purged (`ORG_PURGE_ORDER` `:92-107` has no actors), so
  purge order is unchanged. New methods and routes, next to the service-token ones (`:583-625`, `:1880-1932`):
  `mintUserToken`, `listUserTokens`, `revokeUserToken`, `revokeAllUserTokens`, `verifyUserTokenHash`. Routes:
  `POST /internal/user-tokens` (mint), `GET /internal/user-tokens?actorId=` (list),
  `POST /internal/user-tokens/:id/revoke`, `POST /internal/user-tokens/revoke-all {actorId}`, and
  `POST /internal/user-tokens/verify {tokenHash}`, which **always answers 200** with `{found:true,...}` or `{found:false}`.
  The maintainer cap: when a request carries `X-Beehive-Maintainer-Cap: 1`, every `isMaintainer` decision for that request
  is false: comment policy (`:4193`), closing others' issues (`:4215`), comments on restricted issues (`:4246`) and
  `include_deleted` (`:3109`). The router reads the header and passes a boolean down. Nothing per-request is stored on the
  DO instance, because input gates interleave requests at every `await`. The header can only remove power, so a spoofed
  copy is harmless.
- `workers/api/principal.ts`: a `bh_usr_` branch after the service branch (`:52`): shape check, then 401; DO verify:
  `found:true` gives a `kind:'user'` principal, `found:false` gives 401, **404 gives 503** (an old DO without the route),
  any other status, a throw or a malformed body gives 503. Scopes map as `read` to `['read']`, `read_write` to
  `['read','write']` and `maintainer` to `['read','write','maintainer']`. `authorize()` gets an explicit user write
  allow-list (section 4, S9); everything else stays 403.
- `workers/api/index.ts`: the rewrite at `:100` becomes `principal.kind !== 'master'` (service and user). For a user
  principal without `maintainer`, `specDoStub` is wrapped once so every DO call carries `X-Beehive-Maintainer-Cap: 1`.
  This happens in a single place, because handlers build fresh headers (`sendToSpecDo`, `:399-415`). The master stage-1
  log line goes here (section 4, S12). Dispatch to the new `handleUserTokenRoutes` after `handleServiceAccountRoutes`.
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
- Docs: `docs/OPS.md` "User tokens: mint, rotate, revoke", plus checklist entries; `docs/FOCUS.md` (rate limiting
  deferred, `authGate` `===` follow-up); `docs/OPEN-QUESTIONS.md` for anything surprising.

**PR-C (CLI)**: `cli/src/utils/config.ts` (`writeFileSync` with mode `0o600` plus `chmodSync` for an existing file, `:120`);
`cli/src/commands/auth.ts` (`auth whoami`; `login` verifies with `/api/whoami`, not `/health`, and prints kind and actor);
`cli/src/utils/api-client.ts` (`:139-145`: with a `bh_usr_` token, warn once and send no `X-Actor-ID`); `cli/README` and
`docs/OPS.md` "CLI actor attribution" (`:201-210`) rewritten; new `cli/tests/*.test.ts`.

**PR-D1 / PR-D2 (session key)**: `workers/api/ui.ts` (`UiEnv`, the gate at `:104`, `signSession` `:822`, `readSession`
`:828-847`); `scripts/start-e2e-workers.sh` (generate and pass `SESSION_SIGNING_KEY`); `tests/e2e/ui-issues.test.ts` and
`ui-nav.test.ts` (forge with the session key); `tests/e2e/config.ts`; `docs/SETUP.md` (`.dev.vars`); `docs/OPS.md`.

## 2. Ordered tasks

Tiers per `docs/AGENT-ROUTING.md`. Every task ends with a push of its own `agent/m12-*` branch, branched from `main`.

| Task | What | Tier | Depends on | Proving test | Maintainer action | PR |
|---|---|---|---|---|---|---|
| T0 | Actor lookup without the 500 limit | default | none | `ui-actor.test`: 501 actors, the newest-login user is found by id and by GitHub id, and no duplicate is created; first login creates the row (M8-PR1 S2); DO 500 gives a 503 page, not a redirect; old-DO stub (filter ignored) behaves as today. DO test for the filter | review | PR-0 |
| T1 | Push A: tolerate `m<N>` above the newest version | default | none | `migrations.test`: an `m99` ledger inits and serves a read, with no steps run; `mx` still throws; m8 is a no-op | review; deploy push A (PR-0 may ride along); record the floor | PR-A |
| T2 | Token helpers and `Principal` types | light | T1 deployed | helper tests: shape, prefix length, `bh_svc_` unchanged | review | PR-B |
| T3 | m9 table, DO routes, verify, maintainer cap | heavy | T2 | `user-tokens.test` (S1-S16 rows), `migrations.test` "fresh ledger starts at m9" and "m8→m9 keeps rows", `schema-sync`, `internal-auth` (new routes are tier 2, verify is tier 1), capped maintainer in issue tests | review | PR-B |
| T4 | Edge: `authenticate` branch, `authorize` table, rewrite, cap wrapper, admin routes, whoami, stage-1 log | heavy | T3 | `api/tests/user-tokens.test`: every verify outcome to its status; the full route-class matrix; a spoofed `X-Actor-ID` is rewritten; the cap header is present only for non-maintainer user tokens; the log line has no token, hash or `Authorization` | review | PR-B |
| T5 | UI settings page, `iat`, nav link | default | T4 | `ui-tokens.test` (S5, S13, S14 rows), `ui-layout.test` link | review | PR-B |
| T6 | Local e2e + OPS/FOCUS docs | default (docs light) | T5 | `tests/e2e/user-tokens.test.ts` (local only): admin mint; issue created with a spoofed `X-Actor-ID` is attributed to the token's actor; revoke, then 401 | review; deploy push B after A is live (section 3) | PR-B |
| T7 | CLI token support and docs | default | T4 merged | `cli/tests`: config mode 0600 (new and existing file); `--actor`/`BEEHIVE_ACTOR` ignored with a warning for `bh_usr_`; `auth whoami` output; login fails on 401 | review; release the CLI | PR-C |
| T8 | Session key, phase 1: sign with new, accept both | default | T5 merged | `ui.test`: a new-key cookie is accepted; an old-key cookie is accepted; the key unset gives 503; `iat` survives | put `SESSION_SIGNING_KEY` **before** the push | PR-D1 |
| T9 | Session key, phase 2: drop the old key | light | T8 live ≥ 12 h | `ui.test`: an `API_AUTH_TOKEN`-signed cookie is refused (re-login) | push after the wait | PR-D2 |

PR-B is reviewed as one stack (`docs/AGENT-ROUTING.md` "Branches and review"): T2-T6 are commits on one branch, never
separate branches stacked on each other. M11 rebases onto PR-B and takes `m10`.
