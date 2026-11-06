# Review: CLI default actor (7e7a355, branch agent/cli-default-actor)

Brief: `docs/MILESTONES.md` M12 stopgap bullet. Diff: 11 files, +80/-26; no UI/DO/schema changes.

**Verdict: approve with changes.** No blockers. The behaviour is correct and the tests bite; two
small gaps against "every write command that creates ledger rows".

## Blockers
None.

## Should-fix
1. `gate run` has no `--actor` but writes a gate verdict row (`cli/src/commands/gate.ts:14-21`;
   `runPreMergeGate(candidateId)` passes no options). It now inherits env/config actor, but the flag
   override the brief asks for is missing.
2. `org create`, `actor create`, `actor trust`, `actor grant-promotion` also lack `--actor`
   (`org.ts:29`, `actor.ts:29,103,126`). They pass `state.config.defaultActor` explicitly, so env/config
   now reach them, but a per-call override is impossible. `actor create` is the bootstrap case
   (no actor row exists yet), so this may be intended. Either add the flag or state the exclusion in
   the OPS paragraph, which says only "a create command".

## Nits
- Whitespace-only `BEEHIVE_ACTOR`/`defaultActor` is truthy (`api-client.ts:140`), sends a blank header;
  the edge then records `'unknown'` (`workers/api/principal.ts:44`). Trim in `loadConfig`.
- OPS paragraph does not say that no actor means the ledger records `unknown` (`principal.ts:44`).
- `auth login`/`saveConfig` (`auth.ts:40,50,95`) will persist an env-derived `defaultActor` into the
  config file, as it already does for env token/url. Pre-existing pattern, now one more field.
- Tests do not cover empty-string `BEEHIVE_ACTOR` or a config `defaultActor: null`; both work by
  inspection (falsy checks at `config.ts:54`, `api-client.ts:140`).
- Redundant: `debug.ts:230` and spec claim keep their own `||` fallback; harmless.

## Verified correct
1. Precedence: single choke point. `request()` (`api-client.ts:139-147`) is the only place that sets the
   header; every client method goes through it (grep: no other `fetch`/`axios` use in `cli/src`;
   health calls use `request()`; no retry layer exists). `options?.actorId || config.defaultActor`
   gives flag > (env, folded into `defaultActor` after the file load at `config.ts:54`) > file > none.
   Empty env falls through to the file value; `null`/empty file value sends nothing.
   Header injection: CR/LF values are rejected before sending (undici probe: invalid header value;
   Node's http client validates the same way, not exercised through axios). Non-ASCII >255 is rejected,
   Latin-1 is passed through. No injection path.
2. Call sites that pass `actorId`: `actor.ts`, `org.ts`, `debug.ts:230` already passed
   `defaultActor`, so their behaviour is unchanged. `spec claim` already had `--actor`.
   Reads now carry the header too, which is the brief's intent. Edge only reads it at
   `principal.ts:44` and ignores it for service tokens; no endpoint rejects it.
3. `--actor` added to `repo/spec/candidate/trial create`, `trial decide`, `issue create`,
   `promotion create`. Dead groups (`debug`, `health`, `history`, `auth`) untouched.
4. Mutations (worktree only, reverted; `git status` clean):
   - reversed precedence in `request()`: 1 fails (`--actor beats env and config`);
   - header renamed: 5 fail (incl. `spec claim`);
   - env ignored: 2 fail; env placed below config: 1 fails (`BEEHIVE_ACTOR beats config`).
   Tests spawn the real CLI against a recording server and assert the header value.
5. `docs/OPS.md:197-204` states attribution not authentication, any master-token holder can name any
   actor, replaced by M12. Matches the code. `docs/FEATURE-PARITY.md:147` accurate.
6. `cd cli && npm install`: ok. `npm run typecheck` in `cli/`: clean. `cli/` has no `test` script;
   root `npm test` (excludes e2e): 29 files, 603 tests pass; `tests/cli-behavior.test.ts` 20/20
   (5 new).
