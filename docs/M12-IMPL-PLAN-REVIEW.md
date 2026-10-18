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
and harmless to code that ignores it. (c) The M11 handoff: a UNIQUE index on `actors.github_user_id` in `m10` throws
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
(either way); a FOCUS entry for the F4(c) M11 handoff; the OPS rotation step if Q4 finds unredacted headers. Add these
to T6 (light).
