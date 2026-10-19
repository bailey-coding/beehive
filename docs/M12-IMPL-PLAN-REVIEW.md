# Review: M12 implementation plan (`docs/M12-IMPL-PLAN.md`)

**Task:** m12-plan-review | **Spec:** `docs/rfcs/0008-verified-identity-user-tokens.md` §9 (not re-opened) |
**Date:** 2026-10-18 | **Reviewed:** `origin/agent/m12-plan` at e9e680d. Line numbers below are on that tree (code
is identical to `main` e06cf48). Every claim was checked against code; none was taken from the plan.

## 1. Findings

### Blocker

**B1. The S9 matrix lets `read_write` tokens write oracle outcomes, which bypasses the oracle ladder.**
- `PATCH /api/candidates/:id/stage` (allowed for `read_write` in S9, row 2) has no transition guard. The DO route
  (`workers/spec-do/index.ts:3371-3374`) calls `transitionCandidate` (`:1209-1219`), which writes any value the CHECK
  allows (`schema.sql:113-116`), including `passed_canary` and `promoted`. This is the route the promotion worker uses
  to record rung outcomes (`workers/promotion-worker/spec-do.ts:72-111`).
- `POST /api/candidates/:id/execute` (also allowed) takes `sandboxRunnerUrl` from the client body
  (`workers/api/index.ts:1886-1895`; DO `:3668-3699`). The DO `fetch`es that URL (`:4337`, `:4411`) and sets
  `stage='passed_premerge'` from the answer (`:4364`). Any allowed human, or anyone who steals their token, can point
  it at a server they control, and that is also an SSRF from the DO.
- Today only the master token reaches either route, so S9 widens it. The plan's own Q2 principle says "oracle and
  spine outcomes stay machine or master".
- **Change:** move `PATCH /api/candidates/:id/stage` and `POST /api/candidates/:id/execute` to the denied row next to
  gate-verdicts, trials and promotions, and name them in Q2. T4 adds matrix rows that expect 403 for all three scopes.
  `PATCH specs/:id/stage` (spec lifecycle, not a rung) and `gate/pre-merge` (it only triggers the real gate workflow,
  `:3794`) can stay allowed.

### Should-fix

**F1. The maintainer cap is fail-open by construction, so the plan must make a missed call site impossible.** An
absent header means full maintainer power. That is required for compatibility (old edge, the other nine workers, the UI
session), but it means one handler that receives the unwrapped stub gives a `read_write` token of a maintainer actor
the power to close other people's issues (`:4215`) and comment on restricted issues (`:4246`). **Change:**
(a) `isMaintainer(actorId, capped: boolean)` takes a *required* parameter, so a call site that is not threaded fails
typecheck. Today there are six call sites (`:2179`, `:2248`, `:3109`, `:4193`, `:4215`, `:4246`).
(b) Wrap the stub once, right after `authorize()`, and pass only the wrapped stub on. The wrapper normalises string
input the way `authedSpecDoStub` does (`spec-do-auth.ts:109-113`), because `handleHealth` calls `fetch('/health')`
(`index.ts:1365`).
(c) The T4 test loops over every allowed write route in S9 with a `read_write` token and asserts the cap on every DO
request. A single example is not enough. The plan's wording ("present only for non-maintainer user tokens") is too
loose to catch one missed handler.

**F2. `ensureActor` creates a duplicate actor on any DO error, and T0 keeps that behaviour.** `ui.ts:333-335`: a
failed list leaves `rows = []`, so it POSTs a new actor. This is a likely source of the duplicates Q3 worries about,
and the session check would then bind tokens to the wrong row. **Change (T0):** if the lookup is not `success`, return
`null` (the existing "Login failed" page, `:321-323`) and never create. Add a test: DO 500 on the lookup gives zero
POSTs.

**F3. T0's ordering contradicts today's behaviour and its own old-DO fallback.** Today the list is
`ORDER BY created_at DESC` (`:3878`) and `.find` returns the **newest** duplicate. An old DO that ignores the filter
still returns the newest, while the plan's new filter (`ASC`) returns the **oldest**. The same user can map to
different actors depending on which DO version answers, and existing duplicate users change actor at their next
login. **Change:** the filter keeps `DESC`, so the result matches the fallback and today, or the order is decided once
in Q3, and both paths use it.

**F4. The push-A tolerance is safe for m9, but its test and its invariant are too weak.** I verified that an m8 DO on
an m9 ledger is safe. It returns before the steps run. No m8 code deletes or rebuilds `actors` (no `DELETE FROM actors`
or `DROP`/`ALTER TABLE actors` under `workers/spec-do`). Nothing else reads `schema_version` (only `:27`, `:545`,
`:808-866`). `user_tokens` only *references* `actors`. **Change:** (a) the T1 test creates an `m99` ledger with an
extra table that has an FK to `actors` and a row, then does writes as well as reads (create an actor and an issue,
add a comment). (b) The OPS "rollback floor" line states the invariant: every step above the floor must be additive
and harmless to code that ignores it. (c) The unique index handoff: a UNIQUE index on `actors.github_user_id` (for M11) will be added in a future migration (m11+)
on a ledger with duplicates, `init()` rethrows (`:497-506`), and that is a full outage. Q3's check must come back clean
first.

**F5. The master stage-1 log may expire before the stage-2 decision.** Workers Logs keep data for days, while the
stage-2 decision needs weeks of evidence. `beehive` already has an Analytics Engine binding (`wrangler.toml:32-33`), and
rule 4 puts metric streams in Analytics Engine. **Change (T4):** also write one data point (blob: `actorId`, `method`,
path class) per assertion, or document the retention and the exact query in OPS.

**F6. The Q4 check covers too little.** `beehive` also exports traces to Honeycomb (`wrangler.toml:58-62`). The
edge→DO subrequests carry `X-Beehive-Internal`/`X-Beehive-Admin` (`spec-do-auth.ts:114-116`), and the verify body
carries the token hash. **Change:** extend Q4 to trace span attributes, including subrequest spans (see §4).

**F7. The D2 wait is measured from the wrong moment.** A rollback of D1, or any redeploy of pre-D1 code, signs new
cookies with `API_AUTH_TOKEN` again. **Change:** "D2 no sooner than 12 h (`ui.ts:30`) after the *last* moment pre-D1
code served", plus a margin.

**F8. Docs tasks are missing.** `docs/MILESTONES.md` M12 status; a `docs/OPEN-QUESTIONS.md` entry for the Q4 result
(either way); a FOCUS entry for the F4(c) unique index handoff; the OPS rotation step if Q4 finds unredacted headers. Add these
to T6 (light).

### Nits
- N1 S5: both mint paths reach the same tier-2 DO route, so the DO cannot tell a session caller from master. The
  real guards are `ui-tokens.ts` (actor taken from the session) and `user-tokens.ts` (master only). Label the DO's
  `created_by = actor_id` check as defence in depth, and put the "form field ignored" test on the UI only.
- N2 S13: the plaintext page answers a POST, so a browser refresh resubmits and mints a second token. Add a one-time
  form nonce, or document it (the 10-token cap bounds it).
- N3 S14: also treat an `iat` in the future as not fresh. `/login` lands on `/app`; a return path from an allow-list
  to the settings page saves a step. GitHub re-auth is often silent, so freshness bounds a stolen *Beehive cookie*
  only. Say so in the OPS section.
- N4 PR-C: write the config to a temp file with mode 0600 and rename it, because `chmodSync` after the write leaves a
  0644 window. N5 S12: truncate the client-controlled `actorId` (for example to 128 chars) before logging it.
- N6 Name the deviations from the RFC: a single `scope` instead of `scopes` (fine), Q1 narrowing decision 3, and the
  new 10-token cap. N7 Rollback race: a write that a new edge verified can land on a just-rolled-back DO that ignores
  the cap. The window is milliseconds and the old edge then answers 401. Accept it, and note it in R3.

## 2. Verified correct (path:line on e9e680d)
- `principal.ts`: master compare first and constant-time (`:38-41`); the service branch is Bearer only (`:52`);
  404→401 (`:67`); fallthrough 401 (`:91`); `authorize` denies by default and keeps `/api/admin*` from reads
  (`:98-106`). `constantTimeEqual`, `hashToken` and 12-char `tokenPrefix` are as stated (`service-tokens.ts:23-49`).
- The rewrite is `principal.kind === 'service'` (`index.ts:100-104`). Every other kind check is `!== 'master'`
  (`lifecycle.ts:76`, `service-accounts.ts:78`), so a new `'user'` kind cannot slip into admin or lifecycle routes.
- `sendToSpecDo` (`index.ts:399-415`), `callDo`/`doWrite` (`ui.ts:745-790`), `toDo` (`service-accounts.ts:29-37`) and
  lifecycle (`lifecycle.ts:82-94`) all build fresh headers. A client's `X-Beehive-Maintainer-Cap` or `X-Actor-ID`
  never reaches the DO except through the rewrite, so a spoofed cap only removes power. The UI path never
  forwards client headers, and it carries session power only (no cap: intended).
- Paths that skip `authenticate()`: the UI (session), public pages, and the nine workers and queue consumers that use
  the tier-1 internal token with their own `X-Actor-ID` (`spec-do-auth.ts:82-100`). That last one is an RFC non-goal
  (R2): "verified" covers the edge `/api` path only. Verify is tier 1. A tier-1 holder can already write as any actor,
  and the hash of a 256-bit token gives an enumerator nothing, so "always 200, found/not found" leaks nothing new.
  Timing differences among unknown, revoked and expired tokens need the plaintext to matter.
- Unsalted SHA-256 is fine for 256-bit random tokens, the same as service tokens. Expiry and revocation are checked
  in the DO with no edge cache, so the next request after revoke is 401. Mint inside one `transactionSync` with no
  `await` is serialised.
- Every non-GET edge route (`index.ts:123-331`) appears in the S9 matrix. `include_deleted` reads pass `authorize` but
  are master-only in `lifecycle.ts:71-76`. All four `isMaintainer` sites the plan names are right
  (`:3109`, `:4193`, `:4215`, `:4246`).
- Migrations: an unknown version throws (`:842`); a final-version assertion (`:853-857`); `init()` logs and rethrows
  (`:497-506`); `LATEST_SCHEMA_VERSION` (`:27`); the fresh branch (`:515-550`). `ORG_PURGE_ORDER` has no `actors`.
  An unknown `/internal/*` route on an old DO is a 404 (`:1932`), so new edge + old DO gives 503 (fail closed).
- UI: the gate (`ui.ts:104`), the 500-row session check (`:123`), `ensureActor` (`:332-341`), `signSession` (`:822`)
  and `readSession` (`:828-847`, exp enforced); `Session` (`ui-pages.ts:29-33`); the account area
  (`ui-layout.ts:219`); 12 h TTL (`:30`); `sameOrigin` (`:866-870`).
- CLI: `writeFileSync` with no mode (`config.ts:120`); actor header (`api-client.ts:139-145`); `login` checks
  `/health` (`auth.ts:111`). Ops: `redact_query_string=false` (`wrangler.toml:50`), `invocation_logs=true` (`:55`),
  and a secret put takes effect on the next request (`OPS.md:37`).

## 3. Mixed-version matrix (one push, ten workers, no order)
I checked every cell of plan §3 against code, and all of them hold. Additional cells I checked: **PR-0 + A in one
push**: an old DO returns DESC and ignores the filter, so fix F3 is needed for both versions to agree.
`GET /api/actors/:id` exists in every DO (`:3174`). **B, old UI with new DO**: unchanged. **B, new edge with old
DO**: the user branch gives 503, and master, service and session are unchanged. **B→A rollback**: `bh_usr_` gives 401
(`principal.ts:91`); admin user-token routes reach A's router and get 404; `user_tokens` stays and A ignores it (F4);
re-deploying B skips the m9 step because the version is already m9. **D1 without the secret**: `/app` 503, API
unaffected (fail closed, ADR-0007). **D1/D2 with old isolates**: a refused cookie redirects to login (no 401, no
open path). **C** has no worker effect. I found no combination that fails open once B1 is fixed.

## 4. Tasks and open questions
**Tasks.** The dependencies, tiers and PR split are sound: T3 and T4 are heavy, T0 goes first (decision 9), and
T5→T8 is ordered on `ui.ts`. Proving tests that need tightening: T1 (F4a); T4 (F1c, B1 rows); T0 (F2, and the
lookup order from F3). A mental mutation that the planned tests would *not* catch is passing the unwrapped stub to one
write handler. F1(a) and F1(c) catch it. No scope creep beyond the RFC apart from N6.

- **Q1: confirm master-only in M12.** It satisfies decision 3 ("require the maintainer scope") as a strict subset and
  keeps `lifecycle.ts:76` unchanged. Opening lifecycle to `maintainer` tokens is a prerequisite for master stage 2, so
  record it as such in FOCUS.
- **Q2: confirm the deny-list, and add candidate `stage` PATCH and `execute` (B1).**
- **Q3: no unique index in m9.** Ship F2 and F3 in T0, and let M11 add a partial unique index in a future migration only after a clean
  check. The human's read-only check, through the usual DO SQL access, before push B:
  `SELECT id, name, github_user_id, role, created_at FROM actors WHERE github_user_id IN (SELECT github_user_id FROM
  actors WHERE github_user_id IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1) ORDER BY github_user_id, created_at;`
  If it returns rows, count what each one owns (`SELECT created_by, COUNT(*) FROM issues WHERE created_by IN (...)
  GROUP BY 1`, the same for `issue_comments`) and pick the row to keep before any token is minted. Write nothing.
- **Q4: settle it before push B, because it already affects the master token.** The human's read-only check:
  dashboard → Workers & Pages → `beehive` → Observability → Logs. Open one invocation log for an authenticated
  `/api/*` request (the `prod-health.sh` run), expand the request headers, and check whether the values of
  `Authorization`, `X-API-Token` and `Cookie` (from one `/app` visit) are redacted. Then open the same request's trace
  in the Honeycomb trace destination and check the span attributes, including the edge→DO subrequest span
  (`X-Beehive-Internal`, `X-Beehive-Admin`). Never copy a value seen. If anything is unredacted: an OPEN-QUESTIONS
  entry, `invocation_logs = false` (and header capture off for traces) on `beehive`, then rotate the exposed secrets.

## 5. Verdict
**Approve with changes.** The design follows RFC §9, its claims about the code are accurate, and it fails closed in
every mixed-version cell I checked. B1 must be fixed in the plan before T4 starts. F1-F4 should be folded into
T0, T1, T3 and T4 before those tasks start. F5-F8 and the nits can land with T6.
