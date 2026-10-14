# Service Accounts Plan: Oracle Review

> **Reviewed:** `docs/plans/service-accounts-plan.md` at `6674530` (branch `service-accounts`).
> **Date:** 2026-10-14 (submission day; demo video not recorded yet). **Reviewer role:** oracle, review only.
> **Checked against:** `workers/shared/auth.ts`, `workers/api/index.ts`, `workers/api/ui.ts`,
> `workers/spec-do/{index.ts,schema.sql,schema-inline.ts,sql-storage.ts}`, every worker's `wrangler.toml`
> and DO call sites, `scripts/{health-check.sh,synthetic-monitoring-enhanced.sh,e2e-test.ts}`,
> `test-end-to-end.sh`, and `origin/m6-semantic-dashboard` and `origin/repo-cleanup` (plans only so far).

## Verdict: APPROVE WITH CHANGES (ship a read-only slice today; defer write scope)

The design holds up. It uses additive tables instead of an `actors` rebuild, generates and hashes
tokens at the edge, verifies against the DO on every request with no cache, keeps master-token
semantics, and denies service tokens by default. Most of the plan's factual claims check out.

Two things need to change before implementation:

1. **Scope.** Write tokens can't be minted on prod until org confinement lands (plan §5, §6.7),
   so today they only work locally, where E2E can already use the local master. Everything that
   exists only to make write tokens safe can be cut today with no loss on prod: the
   `X-Beehive-Principal` header, the DO `who()` changes, promotion-authority enforcement, confinement,
   the `ALLOW_WRITE_SERVICE_TOKENS` gate and `e2e-bootstrap.sh`. That is about 40% of the work and
   all of the changes to how the DO interprets identity.
2. **Correctness gaps** that the plan or the downstream fork-token agent would hit (R2–R9 below). The
   most important: `repositories.agent_id` is forgeable, so the fork-ownership rule in §4 is unsafe as
   written; the edge reads resource IDs from the query string; and `--quick` does not exist.

Confidence: 0.85. I didn't run tests, `wrangler dev` or anything against prod. I did reproduce the SQL
adapter behavior in R7 with `node:sqlite`.

---

## 1. Security (question 1)

| Property | Status | Evidence |
|---|---|---|
| Missing secret → 503, wrong bearer → 401 | ✅ Preserved by design (§3.2 checks `API_AUTH_TOKEN` first, even for `bh_svc_`) | `auth.ts:30-44` is the current behavior. R8: reuse its JSON error shape so `api.test.ts` passes unchanged |
| `bh_svc_` + 32 random bytes, SHA-256 hex, unique index lookup | ✅ Sound for 256-bit tokens. No pepper is the right call (no coupling to master rotation, cf. `OPEN-QUESTIONS.md:152-154`) | — |
| Constant-time compare | ⚠️ Plan says "optionally". Service tokens are fine (the DB looks up a hash the attacker can't choose). The master compare is still `===` (`auth.ts:35,40`) | R8 |
| Plaintext shown once, never stored or logged | ✅ Generated at the edge, DO gets only `tokenHash`/`tokenPrefix`, `201` + `no-store`. No `console.*` in `workers/api/index.ts`; no observability block in `wrangler.toml` | — |
| Create/list/revoke are master-only | ✅ `/api/admin/*` is master-only in the policy table; DO `/internal/*` can't be reached from the edge (below) | — |
| Revocation is immediate | ✅ No cache; one DO instance (`idFromName('main')`, `index.ts:97`) | — |
| `X-Actor-ID` spoofing | ✅ for service tokens: the edge rewrites it. ⚠️ Incoming `Request` headers are immutable, so build `new Request(request, {headers})` | R9 |
| Body identity fields | ⚠️ The plan's list is incomplete and partly redundant (next row) | R2 |
| Routes missing from the policy table | ✅ Default deny. The read rule must match `url.pathname`, never `request.url` | R4 |
| DO reachable via other bindings | ✅ No escalation path. 7 workers bind the DO namespace (gate, sandbox, queue, preview, scientist, canary, candidate-service). All are `authGate` master-only on `fetch` or queue-triggered, and none pass a client `Request` or its headers to a stub (grep: no `stub.fetch(request)`). `shadow-router` forwards client headers (`shadow-router/index.ts:307,421`) but has no `SPEC_DO` binding (`shadow-router/wrangler.toml:14`). `promotion-worker`'s `SPEC_DO` is a **service binding to the `beehive` edge** (`promotion-worker/wrangler.toml:22-24`), so it goes through `authenticate` | — |
| DO `/internal/*` reachable from outside | ✅ No. Edge handlers build fixed `/api/...` DO paths, and even the query-string ID injection (R4) controls at most two segments with a fixed suffix (`/api/entities/../../history` → `/history`), which can't reach `/internal/...` | Reproduced, see R4 |

**Body identity fields (correction to plan §0 and §3).** The edge already overwrites the body
identity field with the header actor on 7 of the 9 routes: candidates `agentId` (`index.ts:1102`),
gate-verdicts `decidedBy` (`:1151`), trials (`:1189`), decide (`:1223`), promotions `promotedBy`
(`:1237`), issues `createdBy` (`:1264`) and comments (`:1325`). Once the edge rewrites `X-Actor-ID`,
those 7 are safe with no DO change. The body passes through untouched on only two routes:

- claim, `body.agentId` (`index.ts:1083` → `spec-do/index.ts:1322`). The plan lists this one.
- **`POST /api/repositories`, `body.agentId`** (`index.ts:998` → `spec-do/index.ts:1239`).
  **The plan misses this one, and it is the fork-ownership column (R3).**

The plan also says "the body is only parsed in the DO" (§3). That's wrong: every edge handler parses it,
for example `handleUpdateCandidateStage` at `index.ts:1135`. So the promotion-stage check can sit at the
edge.

## 2. `X-Beehive-Principal` trust model (question 2)

- **External callers can't inject it.** `sendToSpecDo` builds fresh headers (`index.ts:363-364`), so
  does `ui.ts` `callDo` (`ui.ts:340-341`), and no worker forwards client headers to the DO (above).
- **Other workers can set it.** Any of the 7 DO-bound workers can. That isn't an escalation: no header
  already means full legacy trust, so forging one can only *reduce* privilege.
- **Who strips it at the edge?** Nobody needs to, because the edge never forwards client headers. The
  plan's "always overwrite" wrapper is belt and braces.
- **Weakness: it fails open.** A missing header means trusted. Its safety depends on every present
  and future edge handler using the wrapped stub. The fork-token agent will add edge routes. One
  `env.SPEC_DO.get(...)` without `withPrincipal` silently gives service-token traffic the legacy
  body-field trust. The edge `X-Actor-ID` rewrite and default-deny policy limit the damage, but
  nothing would catch the mistake.
- **Recommendation.** Today, drop the header (R1): read-only tokens never write. For the write
  follow-up, enforce identity and promotion authority **at the edge** (R2 shows that's enough), and
  introduce the header only with org confinement. When it is introduced: (a) after `authenticate`,
  pass handlers only the wrapped stub, never `env`; (b) add a test that runs every write route with a
  service principal and asserts the header reaches the DO.

## 3. Schema (question 3)

| Claim | Verdict | Evidence |
|---|---|---|
| 8 tables FK `actors(id)` | ✅ 8 tables, 10 references | `schema.sql:57,95,119,142,167,187,215,216,270,271` |
| Rename-old/create-new leaves children on `actors_old` (SQLite ≥ 3.26) | ✅ Accurate | — |
| "Rebuilding is unsafe" | ⚠️ Overstated, but the conclusion stands. The documented order (create `actors_new` → copy → drop `actors` → rename) works under `PRAGMA defer_foreign_keys=ON` inside `transactionSync`. DO SQL rejects `BEGIN`/`COMMIT`. Not worth doing on the live ledger today | — |
| FKs can't be disabled in DO SQLite | Consistent with Cloudflare's D1/DO docs. Not re-verified at runtime | — |
| `CREATE TABLE IF NOT EXISTS` is safe on the live ledger | ✅ Additive; the FK targets (`actors`, `organizations`) exist. Caveat: `init()` runs **outside** `fetch`'s `try` (`spec-do/index.ts:1121-1122` vs `:1129`), so a throwing DDL turns the first request after deploy into an uncaught error. `this.db` is already set by then, so later requests skip `init()` and the master path survives | R7 |
| Drift: `schema-inline.ts` has 6 columns `schema.sql` lacks | ✅ Exactly `preview_url`, `preview_worker_name`, `preview_created_at`, `shadow_match`, `shadow_score`, `shadow_metrics` (diff of the decoded constant vs `schema.sql:116`) | — |
| Hand-editing `schema-inline.ts` is right | ✅ The repo has no generator (grep), despite the "Generated from schema.sql" header. Cleaner: put `SERVICE_ACCOUNTS_SQL` in its own module | O1 |
| Fresh DOs skip `runMigrations()`; the m1 branch can leave the version stale | ✅ `spec-do/index.ts:231-249` and `:277-294` (errors swallowed, version not bumped) | — |
| `transactionSync` is usable | ✅ `DurableObjectStorage.transactionSync` (`@cloudflare/workers-types` 5.20261014.1, `experimental/index.d.ts:795`) on a SQLite class (`wrangler.toml:41-43`). Use `this.state.storage.transactionSync`; the adapter doesn't wrap it. The closure must be synchronous, and every `step()` must run **inside** it, because the adapter executes lazily on the first `step()` (`sql-storage.ts:42-47`) | R7 |

## 4. Promotion-authority enforcement (question 4)

- **No existing flow breaks.** No worker calls `PATCH /api/candidates/:id/stage` (grep outside
  `api/` and `spec-do/`). The promotion worker never reaches the ledger at all: it calls relative paths
  (`/promotion-states`, `/tournament-status`, `/candidates/:id`) over a service binding to the
  `beehive` edge with no bearer (`promotion-worker/state.ts:42-50`, `tournament.ts:208,226,242,263,523`).
  Those calls get a 401, or a relative-URL error, today. Canary calls `/api/canary-deployments`
  (`canary-worker/canary.ts:62,94`, `rollback.ts:32,61`), which the DO doesn't route, so it gets a 404. Both
  gaps predate this plan. Record them in OPEN-QUESTIONS; don't fix them here.
- **The no-header trusted path** is the fail-open concern in §2. It's moot today if write scope is
  deferred.
- **Separate hole in the planned `write` scope.** It's an oracle-ladder issue, not an identity one. A
  write token can forge rung results without promotion authority:
  - `PATCH .../stage` to `passed_premerge` … `passed_canary` (allowed in §5).
  - `POST /api/gate-verdicts` with `status: pass`.
  - `POST /api/candidates/:id/execute` with an attacker-chosen `sandboxRunnerUrl`. The DO fetches it
    (`spec-do/index.ts:2295`), then writes the returned `commitSha` and sets `passed_premerge`
    (`:2311-2329`). The edge's default, `https://beehive.example.com` (`index.ts:1390`), is bogus anyway.

  Confinement limits this to the test org, but the follow-up should keep these routes out of
  `write`. See O5.

## 5. E2E confinement (question 5)

The direction is right, but the guard isn't sufficient as written:

- **Use an allowlist, not a denylist.** Allow `localhost`, `127.0.0.1` and `[::1]` only. That also covers
  custom domains or routes added later. `e2e-bootstrap.sh` in the plan already allowlists; `e2e-test.ts`
  only denylists `*.workers.dev`.
- **`e2e-test.ts` touches prod even with a local `API_BASE`.** It posts a message to the **production**
  `preview-artifacts-push` queue through the Cloudflare REST API (`e2e-test.ts:417-464`), which the prod
  `preview-manager` consumes against the prod ledger. Today that's a read and a skip, but it's still a
  prod side effect. Skip that leg when the host is local.
- **`e2e-test.ts:45`:** `CF_TOKEN = CLOUDFLARE_API_TOKEN || BEEHIVE_TOKEN` sends the Beehive token (a
  service token after this change) to `api.cloudflare.com`, along with `X-Actor-ID` (`getHeaders`,
  `:99-105`). Remove the fallback.
- **Other scripts write to prod by default** and aren't covered:
  - `scripts/verify-m2.sh:39` (POST specs, claim, preview, advance at `:105,138,167,307`).
  - `scripts/test-queue-gate-wiring.sh:18` (POST specs, claim, gate at `:22,38,58`).

  A prod claim also creates a **real Artifacts fork** (`spec-do/index.ts:626-636`). Give both scripts
  the same guard, or at least flip their default to localhost. Don't guard
  `scripts/demo-end-to-end.sh`: the demo writes to prod on purpose.
- Local claims also create real Artifacts forks, because `wrangler dev` uses the real
  `CLOUDFLARE_API_TOKEN`. Note it in OPEN-QUESTIONS; it's out of scope here.
- **Is deferring org confinement acceptable?** Yes. Prod can't mint write tokens until it lands, so
  deferring it carries no prod risk. That's also why write scope buys nothing today (R1).

## 6. Scripts (question 6)

Monitoring stays meaningful, and arguably improves: `beehive` `/health` never touches the DO
(`index.ts:92-94`), so the plan's `GET /api/whoami` + `GET /api/organizations` with a read token is the
first check that actually exercises the Spec DO through auth. The 401 probe on the other 9 workers still
proves "deployed and fail-closed configured". The demo-critical signals (10 workers up, edge + DO healthy)
are kept. Problems the plan has to handle because it edits these files:

- **`--quick` doesn't exist.** The script prints `Unknown option: --quick` and exits 1
  (`synthetic-monitoring-enhanced.sh:172-176`). It's referenced in plan §7 (`:329`) and
  `FOCUS.md:47`. Use `--once --check workers:beehive` (or add a `--quick` alias). Without `--once`
  (or `--report`) the script loops forever (`RUN_ONCE=false`, set true only at `:124,140`).
- **Infinite recursion when a token is set.** `check_service_bindings` calls itself
  (`:884`), and `check_all_bindings` reaches it too (`:973`). Re-pointing its token variable
  to the admin token keeps the bug. Replace the self-call with the config check and `return 0`.
- **Wrong hostnames.** Worker URLs are built from `CLOUDFLARE_ACCOUNT` (`:367`), which is
  auto-filled with the **account ID**, not the `bz23711` workers.dev subdomain. Unless the user exports
  `CLOUDFLARE_ACCOUNT=bz23711`, every worker check hits a nonexistent host. Add
  `BEEHIVE_WORKERS_SUBDOMAIN` (default `bz23711`).
- **401 probe:** treat `503` as a failure ("secret missing on that worker"), not as "up".
- **The "deep" M3/oracle checks are POSTs against prod** (`:469,549,591,635,677,719,761`). Gating them
  on `BEEHIVE_ADMIN_TOKEN` and reporting skip is right, but label them "writes to prod" in the help text
  and the skip message, consistent with "don't run E2E against prod".
- **`health-check.sh`** probes the other workers only on `localhost` ports (`:46-74`), so with a remote
  `BASE_URL` they always show DOWN. This predates the plan. Optional: derive the remote URLs when
  `BASE_URL` isn't local (O6).
- Keep the master path working during the transition (an explicitly set `BEEHIVE_API_TOKEN` keeps
  today's behavior), so the demo-day verification flow doesn't break before Bailey mints a monitor token.

## 7. Interface for the fork-token agent (question 7)

Mostly sufficient. These points must be fixed in §4 before item 6 builds on it:

- **Ownership is forgeable.** `repositories.agent_id` comes straight from the request body
  (`spec-do/index.ts:1239`), and `(namespace, name)` isn't unique (`schema.sql:44-60`). Any write-capable
  caller can create a row with `agentId = self` that names another agent's Artifacts repo. The rule
  "`repositories.agent_id === p.actorId` means owner" would then mint a **write** token for someone else's
  fork. Ownership must come from rows that only `claimSpec` creates: the repo is `repo_type='candidate'`
  and has a `candidates` row with `repository_id = repo.id AND agent_id = p.actorId`
  (`spec-do/index.ts:640-680`). Mint by ledger repository **id**, and refuse if more than one repository
  row shares that `(namespace, name)`.
- **Master `actorId` can be `'unknown'`.** The mint ledger FKs `actors(id)`, so master mints without
  `X-Actor-ID` fail on the FK. Say so: either require `X-Actor-ID` for master on that route, or make
  the column nullable with `minted_by_master`.
- **`withPrincipal` semantics for `session`** (and the no-op for master) are unspecified, and so is
  what the DO does with `kind:'session'`. Spell both out, or drop the header (R1).
- **Where the session principal is built.** M6 keeps `ui.ts` session code byte-for-byte
  (`m6-ui-plan.md:20`). Pick one option: after M6 merges, add `export` to `readSession`
  (`ui.ts:401`), and build `principalFromSession()` in a new `workers/api/session.ts`.
- **`authorize(p, method, path)`:** `path` is `new URL(request.url).pathname` (R4).
- **`authenticate` returns `Principal | Response`.** Document the `instanceof Response` check.
- **Land `workers/shared/principal.ts` first, as its own pushed commit,** so item 6 can import the frozen
  types while the rest is in progress.

## 8. Scope versus the 2026-10-14 deadline (question 8)

**Ordering is a hard rule:** don't merge anything that touches auth to `main` until the demo video is
recorded **and** the submission is uploaded. Every merge redeploys all 10 workers (`deploy.yml`). The
edge auth swap sits on the request path of every API call the demo makes. The submission doesn't
require service accounts.

**Minimum safe slice (DO-backed, read-only):**

| Ship today | Defer (follow-up PR) |
|---|---|
| `shared/principal.ts`, `shared/service-tokens.ts` (pushed first, §7) | `write` scope, `ALLOW_WRITE_SERVICE_TOKENS` |
| `SERVICE_ACCOUNTS_SQL` (own module), exec'd in `init()` in try/catch (R7) | `X-Beehive-Principal`, `withPrincipal`, DO `who()` |
| DO `/internal/` create (`transactionSync`), list, revoke, verify | promotion-authority enforcement (edge-side, R2) |
| Edge: `authenticate`, `authorize` (service = GET allowlist + `/health` + `whoami`), admin routes, `whoami`, `X-Actor-ID` rewrite, constant-time master compare | org confinement (§6.7), `e2e-bootstrap.sh` |
| `create` rejects any scope but `read` with 400 | rotation route, `last_used_at` (a write on the read path) |
| Unit tests (§7 minus write rows) + one local `wrangler dev` lifecycle and migration run | E2E service tokens (E2E keeps the local `.dev.vars` master) |
| Scripts: R6 fixes, monitor token, E2E allowlist, CF fallback removed | `health-check.sh` remote URLs (O6) |
| OPEN-QUESTIONS findings (R10), AGENTS auth paragraph, FOCUS ticks | — |

This satisfies 7 of the 8 FOCUS item-5 boxes. "write for E2E" is met through FOCUS's own "or run against
`wrangler dev`" clause. Estimate: roughly 400–500 lines including tests, 2–3 hours.

**Versus the JSON-secret fallback (§9):**

| | DO-backed read-only | JSON hash-keyed secret |
|---|---|---|
| DO / schema change | 2 additive tables, 4 internal routes | none |
| Edge change (the riskier part) | same `authenticate`/`authorize` | same |
| FOCUS "create/list/revoke routes" | ✅ | ❌ (re-put the secret) |
| Revocation | immediate, one API call | immediate after `wrangler secret put` (new version) |
| Later migration | none | insert the hashes into `service_tokens`, delete the secret |
| Effort | ~2–3 h | ~1 h |

The edge change carries most of the risk and is identical in both. The DO addition is additive and
fails closed, because a missing table gives service tokens a 503 and leaves master working. **Ship the
DO-backed read-only slice if at least 3 h remain after upload, before final verification. With less
time, ship the JSON fallback, read-only, with the same `Principal` interface. If neither fits, ship
nothing.** Master-token tooling keeps working, and item 6 can still code against the frozen
`principal.ts`. The plan's hash-keyed JSON is better than FOCUS's plaintext version; keep that.

## 9. Conflict risk (question 9)

- **`m6-semantic-dashboard`** (only plan and review are pushed so far):
  - `index.ts`: M6 edits one `/about` paragraph (~L730–746, `m6-ui-plan.md:71`). This plan edits
    L19–98 and adds routes before the 404. The hunks are separate, so risk is low.
  - `ui.ts`: this plan leaves it alone ✅.
  - `FOCUS.md` and `OPEN-QUESTIONS.md`: both append, so expect trivial textual conflicts. Rebase and
    keep both.
  - M6 review R1 (filtered DO list routes return `[]`) also applies here: service-account list and
    verify must not reuse the broken filtered-list pattern (R7).
- **`repo-cleanup`:**
  - **Direct conflict** on `scripts/health-check.sh:14`. The cleanup plan (L71) changes the token
    default; this plan rewrites the script. This branch should own the file, and cleanup should drop
    that edit (its plan already allows for that).
  - `workers/api/tests/api.test.ts`: cleanup fixes the 2 known failures (cleanup plan L51–52). Keep
    new tests in `service-accounts.test.ts` as planned, and don't touch `api.test.ts`.
  - `docs/ARCHITECTURE.md`: different sections (components vs. Security Model). Low risk.
- **Merge order:** cleanup → M6 → service-accounts (riskiest last), each after the demo is recorded.
  Re-run `npm test` after each rebase.

---

## Required changes

**For today's slice**

- **R1. Cut to the read-only slice in §8.** Update plan §5–§7 to match: drop the write rows from the
  policy table and tests for now, and move them to a "follow-up" section.
- **R2. Correct the body-identity analysis (§0, §3).** Seven routes are already overridden at the edge.
  The two passthroughs are claim and **`POST /api/repositories` `body.agentId`**. For the follow-up:
  strip or override both at the edge for service principals, and put the promotion-stage check in
  `handleUpdateCandidateStage`. The edge parses the body (`index.ts:1135`).
- **R4. Read resource IDs from `url.pathname`, not `request.url`.** `extractId` and `extractParentId`
  (`index.ts:324-332`) run on `request.url`, so the query string can override the ID: `PATCH
  /api/candidates/VICTIM/stage?x=/OTHER/stage` acts on `OTHER`, and `GET /api/specs/abc?x=/..` sends the DO
  `/api/`. Reproduced with Node's URL parser. That's harmless with today's master-only callers, but it
  breaks any edge-side, per-resource check keyed on the path. This plan's `authorize` and the item-6
  ownership check are both such checks. It's a two-line fix. Add a test.
- **R5. E2E guard (§5):**
  - Use a localhost allowlist in `e2e-test.ts` and `test-end-to-end.sh`.
  - Remove the `CF_TOKEN` fallback (`e2e-test.ts:45`).
  - Skip the prod queue leg when the host is local.
  - Give the guard (or a localhost default) to `verify-m2.sh` and `test-queue-gate-wiring.sh`.
- **R6. Script fixes (§6):**
  - Replace the nonexistent `--quick` in the plan and in `FOCUS.md:47`.
  - Use `--once`.
  - Fix the `check_service_bindings` recursion.
  - Fix the workers.dev subdomain.
  - Treat 503 as fail in the 401 probe.
  - Label the deep checks as prod writes.
  - Keep explicit-master behavior working.
- **R7. Migration and adapter hygiene:**
  - (a) The adapter appends bindings and doesn't re-execute after the first `step()`, so the
    `bind → step → bind → step` reuse pattern **silently drops the second write**. Reproduced:
    `SpecDO.init()`'s `initialized_at` row (`spec-do/index.ts:241-245`) is never written. Use a fresh
    `prepare()` per statement and bind in placeholder order.
  - (b) Wrap the `SERVICE_ACCOUNTS_SQL` exec in try/catch with a log, so a DDL error can't fail the
    first request (`init()` sits outside `fetch`'s `try`).
  - (c) If the tables are missing, verify returns an error, and the edge maps it to 503.
  - (d) Write `schema_version='m3'` only when the current version is `m2`. Don't mask a stuck `m1`.
- **R8. Constant-time master compare** in `authenticate`: `crypto.subtle.timingSafeEqual` over the
  SHA-256 digests of both values. It throws on unequal lengths, so compare digests, not raw strings.
  Reuse `auth.ts`'s error body shape (export `jsonError`) so existing auth tests pass unchanged.
- **R9. Edge mechanics:**
  - Incoming headers are immutable, so rewrite `X-Actor-ID` with `new Request(request, { headers })`
    before any body read.
  - Pin down the verify contract: DO `200 {success:true,data}` → principal; `404` → **401**; any other
    status or a throw → **503**.
- **R10. OPEN-QUESTIONS findings** (dated) in addition to the plan's §6.9 list:
  - the adapter re-bind behavior;
  - the promotion worker and canary never reach the ledger (§4);
  - prod-default write scripts;
  - query-string ID extraction;
  - E2E's prod queue leg;
  - wrong demo-script hostnames (below).

**Before write scope or the fork-token endpoint (follow-up)**

- **R3. Fix the §4 fork-token guidance (§7):**
  - Ownership comes from a `candidates` join on claim-created repos, never from `repositories.agent_id`.
  - Mint by repository id.
  - Specify FK handling when master's actor is `'unknown'`.
  - Specify session-principal semantics and pick one location for `principalFromSession`.
- If the principal header comes back: wrapped stub only, plus a route-coverage test (§2).

## Optional suggestions

- **O1.** Put `SERVICE_ACCOUNTS_SQL` in `workers/spec-do/schema-service-accounts.ts` instead of the
  file headed "Generated from schema.sql". Folding the 6 drifted columns into `schema.sql` is still
  worth doing.
- **O2.** Default `expiresInDays` for new tokens (e.g. 90). Today a leaked monitor token lives forever.
- **O3.** An edge format pre-check before the DO round-trip: exact length 50, base64url charset. It's
  cheap and stops garbage `bh_svc_` floods from hitting the serialization point.
- **O4.** There is no route to revoke promotion authority (only grant: `spec-do/index.ts:436`). For
  service accounts, document "revoke the account" as the way to remove it.
- **O5.** Follow-up `write` scope: exclude rung-result routes (`stage → passed_*`, `POST /api/gate-verdicts`,
  `execute` with a caller-supplied `sandboxRunnerUrl`) unless the account is the gate itself (§4).
- **O6.** `health-check.sh`: with a remote `BASE_URL`, probe `https://<worker>.bz23711.workers.dev`
  instead of localhost ports.

## Outside this plan's scope, but relevant before recording the demo

`scripts/demo-end-to-end.sh:387,395` probe `beehive-shadow.bz23711.workers.dev` and
`beehive-scientist.bz23711.workers.dev`. The real names are `beehive-shadow-router` and
`beehive-scientist-comparator` (`workers/*/wrangler.toml:5`). Because the calls use `curl -s` without
`-f`, a wildcard workers.dev 404 still prints "running", so the demo would show a false pass. Fix that,
or don't show that step on camera.
