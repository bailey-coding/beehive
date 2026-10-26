# M12 PR-C plan: CLI user-token support (T7)

**Task:** plan-m12-prc | **Spec:** `docs/rfcs/0008-verified-identity-user-tokens.md`, `docs/M12-IMPL-PLAN.md` §1 PR-C, §2 T7,
§3 (T7 row) | **Date:** 2026-10-26 | **Status:** plan only, no code. Line numbers are on `main` at 9d5dca9.

**Spine check: none.** PR-C changes `cli/`, `tests/` and docs only. No spec schema, DO ledger, promotion train, Workflow
or worker code. Anything that would change `workers/api` (see Q3, Q4) is edge auth, i.e. spine, and needs the maintainer.
Plan size is 5 code files, 1 new test file, 3 doc files: over the 2-3 file threshold, so this plan needs acceptance first.

## 1. Drift found (grep before trusting the M12 plan)

- The plan's `cli/tests/*.test.ts` does not exist. CLI behaviour tests live in `tests/cli-behavior.test.ts` (root vitest,
  spawns `cli/node_modules/.bin/tsx cli/src/index.ts` against a recording 127.0.0.1 server; CI installs `cli/` first,
  `ci.yml:198`). T7's tests go there (new file, shared harness, §5).
- Anchors moved: config write is `cli/src/utils/config.ts:120`, actor header `cli/src/utils/api-client.ts:139-152`
  (not `:139-145`), OPS "CLI actor attribution" is `docs/OPS.md:230-239` (not `:201-210`).
- The user-token table is schema `m9` (not `m10`); `/api/whoami` (`workers/api/service-accounts.ts:66`) already returns
  `{kind, actorId, scopes, serviceAccountId, userTokenId}` inside the `{success,data}` envelope, so `request()` parses it as is.
  Master gets `actorId: "unknown"` without a header. `scopes` is the expanded array; the stored scope name is not returned.
- Today's `auth login` saves the token **before** verifying and, on failure, rewrites the config with the token removed:
  a bad login erases a previously saved good token, and the bad one sat on disk meanwhile.
- `saveConfig` callers pass `state.config`/`loadConfig()` output, which is already merged with env vars and flags. So
  `auth login` and `auth logout` persist env-derived values (`apiUrl` with `/api` appended, `defaultActor` from
  `BEEHIVE_ACTOR`, `verbose`) into the file. Not the env token (login overrides it, logout clears it), but it is a latent
  leak path for any future secret field.

## 2. Files to change

| File | Change |
|---|---|
| `cli/src/utils/config.ts` | (a) `saveConfig` (`:103-124`): `mkdirSync(dir, {recursive:true, mode:0o700})`; write JSON to `<dir>/.config.json.<pid>.tmp` opened with `openSync(…,'wx',0o600)`, `writeSync`, `fsyncSync`, `closeSync`, then `renameSync` over the target; on error `unlinkSync` the temp (best effort) and throw without echoing file contents. The file is never visible at 0644, also when replacing an existing 0644 file (rename swaps the inode). (b) New `updateConfigFile(path, patch)`: read the raw file JSON only (no env merge), apply `patch` (`undefined` deletes a key), `saveConfig` it. `login`/`logout` use it, so env/flag values are never persisted. (c) Export `tokenKind(token): 'user'\|'service'\|'master-or-other'` by prefix (`bh_usr_`, `bh_svc_`). The CLI cannot import `workers/shared/service-tokens.ts` (separate package, no shared build), so it mirrors the two constants and a test pins them to the worker's exports. |
| `cli/src/utils/api-client.ts` | `request()` (`:139-152`): if `tokenKind(this.config.apiToken)==='user'`, send **no** `X-Actor-ID` and, if `options.actorId` or `defaultActor` was set, emit one stderr warning per process (`warnActorIgnored`, names the source flag/env/config, not a secret). The `ActorIdSchema` mirror check (`:141-148`) runs only for the master path, so an ignored bad id does not abort. New `getWhoami()` → `GET /whoami`. Add a `hintFor(status, kind)` mapping in the interceptor message: 401 with a `bh_usr_` token → "token rejected: revoked, expired or not issued by this edge; mint a new one at /app/settings/tokens"; 403 with a user token → "this route is master-only for user tokens (docs/OPS.md User tokens)"; 503 → "auth backend unavailable (mid-deploy?); retry". Never include request headers in any error. |
| `cli/src/commands/auth.ts` | `login`: verify with a throwaway client (`createClient({...cfg, apiToken})`) calling `getWhoami()` **before** any write; on success `updateConfigFile(path,{apiToken})` and print `kind`, `actorId`, scope label; on 401 exit 1 and write nothing; on 503/network exit 1 with "could not verify, nothing saved" (do not call the token bad). Add `--token-stdin` (read one line, trim) so the token stays out of argv and shell history; keep `--token`, and for it print a one-line stderr note that argv is visible to other local users. `auth whoami` (new): prints kind, actorId, scope label (`read`/`read_write`/`maintainer` from `scopes`), `userTokenId`/`serviceAccountId` if present, token prefix (≤12 chars), API URL, and the token **source** (flag, env, config). `logout`: `updateConfigFile(path,{apiToken:undefined})`, and when `BEEHIVE_API_TOKEN` is set say it is still in the environment. `status`/`test`: also use whoami. `show-token`: mask to the 12-char prefix + length (today 8 chars of a `bh_usr_` token show 1 body char; 12 matches the public listing prefix). |
| `cli/src/index.ts` | No flag change. `.env('BEEHIVE_API_TOKEN')` (`:90`) already folds the env into `--token`; a user token travels in the same slot. Verbose banner (`:164`) keeps printing only `Authenticated: true/false`. |
| `cli/src/types/config.ts` | No new field (decision D1). |
| `tests/helpers/cli-harness.ts` (new), `tests/cli-behavior.test.ts` | Extract `runCli`/recording server from `cli-behavior.test.ts:60-80` into the helper (behaviour unchanged), then add `tests/cli-token.test.ts` (§5). |
| `cli/README.md` | Authentication (`:49-58`), Configuration/Env table (`:434-463`): user token section, `--token-stdin`, precedence, `auth whoami`, `defaultActor` ignored with a user token. |
| `docs/OPS.md:230-239` | Rewrite "CLI actor attribution": user token is the supported path (verified identity, edge overwrites `X-Actor-ID`); master-token `BEEHIVE_ACTOR`/`defaultActor`/`--actor` stays as the admin/bootstrap path with its existing precedence; the "stopgap until M12" title and "M12 replaces it" go. State that stage 2 (master can no longer act as a human) is separate. Add the secret-handling lines (§4) and what the CLI does on 401/503. |
| `docs/FOCUS.md`, `docs/MILESTONES.md`, `docs/FEATURE-PARITY.md:147` | Mark T7 done, remove "Next: PR-C", fix the CLI line in FEATURE-PARITY. `docs/OPEN-QUESTIONS.md` only if a real finding appears while implementing. |

## 3. Precedence (unchanged order, one new meaning)

- **Token:** `--token` > `BEEHIVE_API_TOKEN` (commander merges both into `opts.token`, `index.ts:90,127`) > config `apiToken` > none.
  A `bh_usr_` token is just a value in that slot (D1: no `BEEHIVE_USER_TOKEN`, two slots would need a tie-break and
  invite a master token sitting beside a user token). The kind is read from the prefix.
- **Actor, master/other token (unchanged, `loadConfig` + `request`):** `--actor` > `BEEHIVE_ACTOR` > config `defaultActor` > none.
- **Actor, user token:** all three are ignored, no header, one warning. The identity is the token's actor, set by the edge.
- Ignoring (not erroring) keeps scripts that export `BEEHIVE_ACTOR` for master use working when someone swaps in a user token.

## 4. Mixed-version deploy window (all ten workers deploy at once, no ordering)

PR-C adds **no request field and no new header**, and removes one (`X-Actor-ID` under a user token). So the "retry
without the new field on 400" rule has nothing to apply to; the only new call is `GET /api/whoami`, which exists since m6.

| Peer | Behaviour |
|---|---|
| New CLI, edge before push B | `bh_usr_` is neither master nor `bh_svc_` → 401. `login` exits 1, writes nothing, hint says the edge may predate user tokens. Master/service tokens: identical to today. |
| New CLI, new edge, **old DO** (404 on verify) | edge 503. `login`/commands exit 1 with "auth backend unavailable, retry"; never saved as a bad token. No automatic retry of writes (a 503 after a partial write is ambiguous; user retries). Optional bounded retry (2×, 1 s) for **GET** only (Q5). |
| New CLI, old edge, master token | unchanged. `auth whoami` works (old whoami lacks `userTokenId`/scope: the CLI treats every field except `kind`/`actorId`/`scopes` as optional and does not use strict parsing). |
| Old CLI, new edge, user token | works: old CLI sends `X-Actor-ID` from env/config, the edge overwrites it (§3 T7 row). With a master token and a malformed actor, the edge already 400s (deployed 2026-10-24). |
| Rollback of push B | every `bh_usr_` request is 401; the hint covers it. Rollback of PR-C = previous CLI; nothing becomes 401. |

Response side: new edge fields are opt-in by the caller and the CLI reads only named fields, so a newer edge adding
fields to `/api/whoami` cannot break it.

**Secret handling.** Tokens are never printed, logged or put in a URL or in an error message: only the 12-char prefix.
`--verbose` prints `Authenticated: true/false` only; add a test that scans stdout+stderr of every new command for the
full token and its SHA-256. Config dir 0700, file 0600 from creation (Windows ignores POSIX modes: document, no claim).
`BEEHIVE_API_TOKEN` in a shell profile is the weakest option; README recommends `--token-stdin` + config file or a secret
manager. **The `cf` Artifacts remote embeds an access token in its URL** (`docs/FOCUS.md` "Next session" item 1): this plan and
the implementer must not run `git remote -v`, `git config --get-regexp remote`, or unredacted `git push` output to the
terminal, and must not paste remote URLs into docs or commits. Fixture tokens in tests are synthetic
(`'bh_usr_' + 'A'.repeat(43)` shape), never a real token.

## 5. Tests (`tests/cli-token.test.ts`; run `(cd cli && npm ci)` first, then `npx vitest run tests/cli-token.test.ts tests/cli-behavior.test.ts`)

1. Config file mode: after `auth login` a fresh dir has the config at `0600` and the dir at `0700`; an existing `0644` file
   ends at `0600`; no temp file left behind. "Never 0644 on disk" is asserted by making the write fail after the temp is
   opened (read-only target dir) and checking the temp's mode, plus a code-level assertion that the open call carries `0o600`
   (stat after the fact cannot see the window).
2. `login`: whoami 200 → saved, output has kind/actor; whoami 401 → exit 1, config file unchanged (including a pre-existing
   good token); whoami 503 → exit 1, "nothing saved", file unchanged; only `apiToken` changes, env-derived `apiUrl`/`defaultActor` are not persisted.
3. Actor: with `bh_usr_` token, `--actor x`, `BEEHIVE_ACTOR`, config `defaultActor` each send **no** `X-Actor-ID` and print
   exactly one stderr warning; an invalid ignored actor does not abort. With a non-user token every existing case in
   `cli-behavior.test.ts:94-172` still passes unchanged (stderr stays empty).
4. `auth whoami` output for master (`unknown`), service, user (`read`, `read_write`, `maintainer`) and an old-edge response without `userTokenId`.
5. Hints for 401/403/503 with a user token; the error text contains no `Authorization` value.
6. Secret scan: full token and its hash never appear in stdout/stderr of `login`, `whoami`, `status`, `show-token`, `--verbose`.
7. Constant pin: the CLI's `bh_usr_`/`bh_svc_` constants equal `workers/shared/service-tokens.ts` exports.
8. `logout` with `BEEHIVE_API_TOKEN` set removes only the file key and says the env var remains.

## 6. Risks

- R1 Rename-over-config on WSL/NTFS-mounted homes may ignore modes: the test must run on ext4 `tmpdir`; document, don't claim.
- R2 `--token-stdin` plus commander's `.env()` merge: a stale `BEEHIVE_API_TOKEN` in the env silently beats the saved file
  token; `auth whoami` shows the source to make this visible.
- R3 Commands that user tokens can never run (actor create/trust, gate verdicts, trials, promotions, candidate stage/execute
  are 403 for all scopes, S9 matrix) still exist in the CLI; users hit 403. Mitigation is the hint, not hiding commands.
- R4 Body-level actor fields (`trial --decided-by`, `candidate --agent`, `repo --agent`) are not overwritten by the edge;
  the DO validates them. PR-C does not touch them.
- R5 Splitting the harness out of `cli-behavior.test.ts` must keep its 30 tests green (run before and after).
- R6 Config schema is unversioned JSON: `updateConfigFile` must preserve unknown keys.

## 7. Open questions for the maintainer

- Q1 `--token-stdin` and the argv note: in scope for PR-C, or only the 0600/whoami items in T7? (Recommended: in.)
- Q2 Warn-and-ignore (recommended) versus hard error when an actor is set with a user token?
- Q3 `/api/whoami` does not return the stored scope name or token expiry. Inferring scope from `scopes` is exact today,
  but expiry-in-whoami (for "expires in 3 days" in `auth whoami`) would be a `workers/api` change = edge spine, so deferred. OK?
- Q4 Should 403 on a user token carry a machine-readable reason from the edge (also spine/edge)? Until then the CLI's hint is generic.
- Q5 Bounded GET retry on 503 during deploys: wanted, or leave retries to the user?
- Q6 "Release the CLI": there is no publish pipeline (`bin/beehive` runs `dist` or falls back to `src` via tsx; `package.json` 0.1.0).
  What does a release mean here: version bump to 0.2.0 and a tag, or nothing?
- Q7 Should the plan's `cli/tests/` path be corrected in `docs/M12-IMPL-PLAN.md` (it is a plan of record) or left as written with this file as the override?
