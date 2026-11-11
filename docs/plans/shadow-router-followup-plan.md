# Plan: shadow evidence a candidate can earn, from a mirror source to the flip

Task: `shadow-router-followup` | Spec: `docs/OPEN-QUESTIONS.md` "2026-11-10: the shadow rung cannot be enforced yet (mirror targets and baseline)" |
Tier: heavy (AGENTS.md rule 2: promotion train inputs; the edge worker, the router, the comparator and the Spec DO's evidence rules).
Status: **rev 4 (2026-11-11): rev 3 re-reviewed (section 15), 4 blockers folded as plan changes; awaiting maintainer decisions (section 13, amended). No code written.** Rev 1 was reviewed (approve with changes for D1 only, 5 blockers, D2 not
approved); rev 3 is a rewrite that applies every finding (section 12 maps them) and adds the piece the review exposed: **nothing in this repo sends
production traffic to the shadow router**, so the first deliverable is a mirror source. Follows `docs/plans/promotion-gaps-plan.md` (merged,
`aaef5e4`, not deployed), whose shadow evidence is log-only exactly because of these gaps.

The goal in one sentence: **a candidate on the shadow rung receives mirrored traffic, is scored against a real answer from the service it
would replace to the same request, and that score reaches the ledger marked `production`, so the shadow rung can be switched from log-only to
enforced by one constant.** Built in three slices that each leave promotion as it was until the last: **M** (a mirror source), **D1** (the
evidence path), **D2** (the flip, a separate approval after a measurement window).

## 1. Facts (line numbers at `aaef5e4`; every one was checked against the code)

**There is no mirror source.**
- F1. No worker, edge route, workflow or CI job calls the shadow router: the only reference is the promotion worker's unused `SHADOW_ROUTER`
  binding (`workers/promotion-worker/types.ts:95`; `OPEN-QUESTIONS` 2026-11-10). The edge (`workers/api/index.ts:88`, `fetch`) never mirrors;
  the root `wrangler.toml` has no router binding (its services are the gate workflow and the preview manager, `:54-63`). `docs/ARCHITECTURE.md:208-220`
  describes the router as "mirror production traffic to candidates" and says nothing about where traffic comes from. Whether something outside the
  repo (a Cloudflare route, another account's Worker) mirrors into the router is unknown; the plan treats it as absent and requires a human check
  (P0) so a double source is not created.
- F2. `docs/MILESTONES.md:55` and the governance plan ("no real traffic flows yet") already say the SLO loop's input is mirrored shadow traffic
  that does not exist outside tests. The canary loop therefore also runs on almost no live data.

**Targets and baseline.**
- F3. The router mirrors to two kinds of target: the static map (`getProductionShadowConfig`: only `beehive-main`, `workers/shadow-router/config.ts:147-151`)
  and live **canary** refs (`applyCanaryRefs`, `config.ts:216-260`, cached by `live-refs-cache.ts`, 5 s TTL). A candidate at `passed_premerge`
  has neither, so it is never mirrored.
- F4. `beehive-main` is the platform's own API worker. As a fan-out target it is replayed with the **original** request for GET/HEAD only
  (`BASELINE_REPLAY_METHODS`, `index.ts:191`; writes skipped, `:280-284`); that replay feeds only Analytics Engine rows (`index.ts:295-309`), which
  nothing reads, and leaves `beehive-main` in `candidates`. `triggerScientist` ignores it and enqueues a placeholder baseline (`status: 200`,
  `latencyMs: 50`, `index.ts:447-453`).
- F5. Candidates get a sanitized request (`mirror-mode.ts`: method, route template, `Accept`, the router's own `x-request-id`; no body, query or
  path ids) while the baseline gets the original, so even a real baseline answer would not be the answer to the same request. `none` mode is the default
  (`wrangler.toml:20`).
- F6. A sanitized request carries no credentials, so every `/api/*` answer from `beehive-main` is `401` (auth is fail-closed); the informative
  answers are the public pages (`workers/api/index.ts:92-103`). Candidates implement other services. A single platform baseline therefore cannot
  judge them.

**Sampling and latency.**
- F7. The top gate classifies every request with the default split (1% in production, `config.ts:158`; `index.ts:715`) using a deterministic hash of
  `method:url` (`index.ts:102-109`), and the per-candidate check reuses the same value (`:268`): a per-target percentage is a no-op and the same URLs
  are always (or never) mirrored. The fan-out is **awaited** before the response (`:728`); only `triggerScientist` runs in `waitUntil` (`:735`).

**Previews.**
- F8. `candidates.preview_url` is written by `PUT /api/candidates/:id/preview`. The preview manager can write a **simulated** URL with no deploy
  (`createSimulatedPreview`, `preview-manager/index.ts:616-634`), the Workers Builds path is a self-described placeholder (`builds.ts:201-212`), and
  the DO stores whatever it is given. `isAcceptableCanaryUrl` (`workers/shared/deploy-refs.ts:67-78`) accepts any Worker on the account, `beehive`
  included. `preview-manager` also sends a dead "preview-deployed" message to the comparator's preview queue (`index.ts:684-715`).

**Ledger and promotion.**
- F9. `shadow_scores` has the placeholder/production split and the sample route accepts `baseline: 'production'` (PR A), but the comparator
  hard-codes `placeholder` (`scientist-comparator/storage/spec-do.ts:33`). The shadow verdict and `shadowScore` average **all** samples
  (`workers/spec-do/index.ts:5113`); the tournament ranks by `shadowScore` (`promotion-worker/tournament.ts:425-427`); `EVIDENCE_MODE.shadow` is
  `log` (`workers/shared/promotion-advance.ts`).

**Governance (do not weaken).**
- F10. Candidates are agent-written, public, with open outbound `fetch`; mirrored customer data is a leak path (`mirror-mode.ts` header; M5A-2 plan
  B4). Real-data eligibility (`candidateExposure()`) is not built (PR-G). Candidates are created by **allowlisted members** (user tokens with write
  scope; viewers are read-only; minting is master or session only), not by strangers.

## 2. Scope and slicing

| Slice | What | Changes promotion? |
|---|---|---|
| **M** | A mirror source: the `beehive` worker copies a sample of its own GET/HEAD requests, reduced at the source to `{method, route template}`, to the router | No |
| **D1** | The evidence path: shadow targets, a like-for-like production baseline, `production`-marked samples, production-only tournament score | Yes, one way: the tournament stops ranking on placeholder samples (section 5) |
| **D2** | The flip: shadow evidence enforced | Yes. **Not approved by this plan**; needs a measurement window and a separate approval |

Out: reading response bodies (path (h) of the M5A-2 plan: cap, redact, own plan); `redacted`/`full` mirror modes for candidates; a customer-side
ingest SDK (section 9); `candidateExposure()` (PR-G; flags and preconditions stand in for it); the tournament's decide-on-second-arrival rule.

**Preconditions (human, before slice M ships):** **P0** confirm in Cloudflare that nothing already mirrors into the router (a double source would
double the load and the samples). **P1** verify how candidate previews are really produced in production (F8): are `preview_url` values live
Workers, or simulated? Recorded in `docs/OPEN-QUESTIONS.md`.

## 3. Slice M: a mirror source (the edge hook)

**Sanitize at the source.** The edge computes the descriptor and sends only that: no raw request, headers, credentials, query or body ever leave
the `beehive` worker toward the router, let alone toward candidates.

- **Hook.** `workers/api/index.ts` `fetch` is wrapped: the existing handler becomes `handleFetch`, and the wrapper, after the response exists,
  schedules `ctx.waitUntil(mirror(request, env))`. The response is never delayed or altered; every error is swallowed and counted.
- **Gate.** `MIRROR_SAMPLE_PERCENT` (integer 0-100, **default absent = 0 = off**), a **dashboard-set variable, never in a `wrangler.toml`** (an agent's
  pull request can edit one; a unit test like `soak-override-not-deployed.test.ts` asserts no config sets it). It is read first: when it is 0 or
  invalid the hook does nothing at all (no parsing, no I/O). Mirrors only `GET` and `HEAD` (a baseline cannot be replayed for writes), skips the router's
  own paths and `/health`.
- **Descriptor.** `{ v: 1, method: 'GET'|'HEAD', path: <route template> }`, the template from the same `routeTemplate`/`routeWords` the router uses
  (moved to `workers/shared/` so both share it): every segment that is not a configured route word becomes `:id`, at most 8 segments and 128 chars.
  Nothing else. Mirroring is per request with a random draw (not a URL hash).
- **No amplification.** The router's baseline fetch hits this same worker (`beehive-main` is the `beehive` worker), which would mirror it again. Every
  router-originated request carries a marker header (`X-Beehive-Mirror: 1`), the hook skips any request that has it, and the router's candidate
  and baseline fetches always set it. A test makes the loop impossible to reintroduce. A per-isolate cap on in-flight mirrors (10) bounds the rest.
- **Transport.** A new `[[services]] binding = "SHADOW_ROUTER", service = "beehive-shadow-router"` in the root `wrangler.toml` (the router exists in
  production; a missing target fails the deploy, `OPEN-QUESTIONS` first-deploy note) and `POST /mirror` on the router with the bearer token the
  workers already share. 2 s timeout, no retry.
- **Router `POST /mirror`.** A strict zod body (the descriptor; a path that is not template-shaped is a 400), then the existing fan-out with a
  request the router builds itself from the descriptor. The raw-request `fetch` path stays for any external source, documented as unused in this repo.
- **What this delivers, honestly.** For the platform's own service the descriptor stream is real production traffic shape (which public routes are
  hit, how often), so the canary SLO loop gets real input and slice D1 gets a source. It does not carry customer data, and for the dogfood service
  the *informative* comparisons are the public pages only (F6). Mirroring other services needs the ingest design in section 9.

## 4. Slice D1: the evidence path

1. **Targets: `GET /shadow-targets`** (Spec DO, internal, tier 1 like `/deploy-refs/live`): candidates at `passed_premerge`, not tombstoned, whose
   preview was produced by a **real deploy** (a `preview_kind` marker, `built` | `simulated`, written by the preview manager through the existing
   preview PUT route as an additive optional field and an additive column; unset = not eligible), with a URL that passes `isAcceptableCanaryUrl` **and**
   the candidate worker-name prefix. Ordered by fewest production samples, candidates at the sample cap skipped, capped at `SHADOW_MAX_TARGETS`
   (default 5, hard max 8: the comparator posts one request per candidate per message and a batch is 100). Fail-closed flag: `[]` unless the Spec DO
   variable `SHADOW_RUNG_MIRRORING = "true"` (dashboard-set, never in a `wrangler.toml`, tested). The router treats any non-OK answer as "no shadow targets"
   (canary targets are unaffected, one log line per isolate); a second `LiveRefsCache` singleton, same TTL.
2. **Router.** `applyShadowTargets` overlays them (static and canary ids win); each is sampled per request with a random draw at
   `SHADOW_SAMPLE_PERCENT` (default 10), evaluated after the descriptor arrives; the fan-out runs in `ctx.waitUntil`.
3. **Like-for-like baseline.** The original-request replay of `beehive-main` is **replaced** (it feeds nothing and re-sends caller credentials) by one
   fetch of the **same sanitized request the candidates get**, built with a non-baseline id (`headersForTarget` would hand a baseline the caller's headers),
   against the baseline for the spec: the platform baseline `beehive-main`, or a per-spec baseline URL (decision 9.1). The baseline is excluded from
   `candidates` in the queue message. Its answer (status, allowlisted headers, latency) is the message's `baseline` with `kind: 'production'`; if it
   cannot be fetched the message is **not enqueued** (an old comparator would score it against a placeholder). The placeholder disappears.
4. **Queue message** (additive): `baseline.kind`, each candidate's real `specId` and `rung`.
5. **Comparator.** `kind: 'production'` -> sample `baseline: 'production'`; absent -> `placeholder` (old router). A sample is dropped when baseline and
   candidate **both** answered 4xx or both 5xx (a baseline `401` against a candidate `401` is a 100 and says nothing); a disagreement (baseline 4xx,
   candidate 2xx: it accepts what production rejects; baseline 2xx, candidate 5xx) is scored. Per-candidate scored/dropped counts are logged and counted.
6. **Spec DO.** The candidate response gains `shadowProductionScore` and `shadowProductionCount` (additive; the response schema is not strict). A
   production sample's reset rule is stated and tested (a candidate id's samples are not carried across a new head commit if one id spans commits;
   implementer verifies how commits map to candidate ids).
7. **Hygiene.** Delete `triggerShadowComparisons` and its calls in `preview-manager`.

## 5. Why D1 still touches promotion, and how

The tournament ranks by `shadowScore`, an average of all samples. With mirroring on, it would rank on a mix of placeholder and thin production samples.
D1 therefore moves the **tournament to the production score only** (a candidate with fewer than `SHADOW_MIN_SAMPLES` production samples has none, so
the tournament answers `no_shadow_evidence`, exactly as it does in production today). The shadow *verdict* and `advance`'s evidence stay all-sample and
log-only until D2. Net effect of D1 on promotion: none in production until production samples exist, then production-only ranking.

## 6. Slice D2: the flip (outline only, not approved)

`EVIDENCE_MODE.shadow = 'enforce'`; the verdict computed from the production columns only; **every shadow verdict recomputed from `shadow_scores`**
(not matched on notes text: the row is rewritten only on a status change and a candidate at the cap writes nothing); candidates that passed during
the log period are grandfathered (`advance` checks only the rung being left); e2e and demo seed `production` samples. Prerequisite: the
measurement window below passes a **validity** criterion, not only a count.

**Measurement window (after D1 is deployed and the flag is on):** at least 7 days; per candidate the informative production samples **on the
candidate's own spec routes**, the scored/dropped split, the score distribution. Proposed bar for D2: at least 3 candidates reach
`SHADOW_MIN_SAMPLES` production samples with at least half of them on routes the spec declares. If the dogfood stream cannot meet it, the oracle is
wrong for the job and option B or the ingest source (sections 8-9) comes first.

## 7. Mixed-version window (one push, ten workers, any order)

| Old peer | New peer | Behavior |
|---|---|---|
| edge without the hook | router with `/mirror` | route unused |
| edge with the hook | router without `/mirror` | 404 swallowed and counted; nothing breaks (the gate is off by default) |
| edge with the hook, binding to the router | router missing in an empty account | the deploy of the edge fails (documented two-pass first deploy) |
| router (new) | Spec DO (old, no `/shadow-targets`) | any non-OK -> no shadow targets, canary targets unaffected |
| comparator (old) | router (new message with `kind`) | extra fields ignored; samples `placeholder`, which never count after D1's production-only score |
| comparator (new) | router (old message, no `kind`) | `placeholder`, as today |
| comparator (old) | router (new, baseline unavailable) | the message is not enqueued |
| tournament (new) | Spec DO (old, no production fields) | no production score -> `no_shadow_evidence`; fail closed |

No route or field is removed; D1's one schema change (`preview_kind`) is additive and optional.

## 8. Alternatives

- **A. Live mirror in `none` mode with a like-for-like baseline (this plan).** Zero customer data, a real production answer, thin signal.
- **B. Synthetic contract probes.** Requests derived from the spec's contract run against baseline and candidate; samples carry `source: 'synthetic'`.
  Safe, works at zero traffic, not blocked by auth or ids, but needs concrete example values in the contract (today `docs/specs` has none) and is a
  different oracle from "live traffic decides". Likely the primary oracle for non-dogfood specs; proposed as a second source.
- **C. `redacted` mode.** More signal (body shape) but leaks structure and is never for untrusted-origin candidates; needs path (h) first.
- **D. Compare to the real caller-facing production response.** The edge has it, but the candidate only sees a sanitized request, so the two are not
  comparable beyond the template.

## 9. The harder question: whose traffic?

The platform's own requests are the only traffic Beehive can see. A customer's service (the thing a spec describes, a URL shortener) runs on the
customer's Workers, so the mirror source for it has to live **there**: a small wrapper or Tail Worker the customer installs that posts the same
`{method, template}` descriptor (plus the spec id) to an authenticated Beehive ingest route with a per-spec ingest token, and a per-spec baseline URL so
the router can fetch a like-for-like answer. That is a product surface (token minting, rate limits, abuse handling, a published SDK snippet), not a
patch, and this plan only reserves its shape: the descriptor is already the ingest payload, and decision 9.1 (per-spec baseline) is its prerequisite.
Recommended: build slice M and D1 on the dogfood service to prove the pipeline, then plan the ingest source as its own heavy-tier plan.

## 10. Tests

- Edge: gate off = no I/O; GET/HEAD only; the descriptor is template-only (query, body, headers, ids never present); the marker header stops the loop;
  errors and a missing binding never touch the response; the in-flight cap; no `wrangler.toml` sets `MIRROR_SAMPLE_PERCENT` or `SHADOW_RUNG_MIRRORING`.
- Router: `/mirror` strict body; the sanitized request equals the candidate's byte for byte; the baseline is built with a non-baseline id and is absent
  from `candidates`; shadow targets overlay and classification; random per-target sampling (a fixed seed in tests); fan-out in `waitUntil`; unavailable
  baseline = no message; any non-OK `/shadow-targets` keeps canary targets.
- Comparator: `kind` mapping; both-4xx/both-5xx dropped, disagreements scored; counts logged; old-message path.
- Spec DO: `/shadow-targets` eligibility (state, tombstone, `preview_kind`, prefix, flag, cap, order); production fields; reset rule.
- Promotion worker/tournament: production-only score; placeholder-only candidates get `no_shadow_evidence`.
- Mutation checks for every guard; local e2e with a stub target.

## 11. Docs, rollback, risks

Docs: `docs/OPS.md` (variables and where they are set, caps, sampling, measurement queries, the loop guard, the thin-signal statement),
`docs/ARCHITECTURE.md:564` (says the router has no `SPEC_DO` binding) and its router/edge sections, the public page text
(`workers/api/index.ts:749,1248`), `docs/OPEN-QUESTIONS.md` (close the 2026-11-10 entry in steps), `docs/GOVERNANCE-STATE-MACHINES.md`,
`docs/plans/promotion-gaps-plan.md` (flip-readiness points here), `docs/FOCUS.md`.

Rollback: `MIRROR_SAMPLE_PERCENT` to 0 stops the source at once (no I/O); `SHADOW_RUNG_MIRRORING` off removes shadow targets within two cache TTLs
(~10 s). Samples and verdict rows stay and, after D2, still count; idempotency rows expire in 24 h.

Risks: **thin signal** (F6; the measurement window and its validity criterion exist for it). **Edge load:** a sampled `waitUntil` per request, off the
response path, capped and defaulted off. **Amplification:** the loop guard above. **Exposure:** shadow-rung candidates are unreviewed code receiving
`{method, template}`-shaped requests only; same class as the canary path, widened, behind two default-off human-set variables; a timing channel
remains. **Production noise:** the baseline fetches hit production with anonymous GET/HEAD (401/404 noise in dashboards). **Cost:** one baseline fetch
and up to 8 candidate fetches per sampled request plus a Spec DO write per candidate per sample (bounded by the sampling, the target cap, the 1000
samples per candidate and baseline, and the queue batch size).

## 12. Review 1 dispositions (independent agent, 2026-11-11; applied above)

B1 no traffic source -> slice M and P0. B2 simulated previews -> `preview_kind` and P1. B3 single baseline cannot judge candidates -> F6, decision 9.1,
the validity criterion, D2 withdrawn from approval. B4 sampling/latency wrong -> F7 corrected, random per-target draw, fan-out in `waitUntil`. B5 D1
changes promotion -> section 5, production-only tournament score in D1. N1 replace the replay and exclude the baseline from `candidates` -> D1.3. N2
baseline built with a non-baseline id -> D1.3. N3 drop only when both sides agree on the status class -> D1.5. N4 recompute every verdict from columns ->
section 6. N5 reset rule -> D1.6. N6 hard max 8 -> D1.1. N7 do not enqueue unavailable messages -> D1.3. N8 order by fewest production samples -> D1.1.
N9 worker-name prefix -> D1.1. N10 member origin, flags dashboard-set and tested -> F10, sections 3 and 4. N11 rollback -> section 11. N12 docs and
tests -> sections 10-11. Facts corrected: F2/F4 line numbers and the ~1% replay, `x-request-id` in `none` mode, `applyCanaryRefs` at `config.ts:216-260`.
The Spec DO's fall-through body for an unknown route is unverified; the router therefore treats any non-OK as "no shadow targets".

## 13. Decisions for the maintainer

1. **Baseline model (9.1):** keep the platform baseline `beehive-main` for the dogfood pipeline (proposed) and plan per-spec baselines with the ingest
   source, or add a per-spec baseline URL (column, route, migration) first.
8. **Slice P (new, B2):** add a pre-shadow real preview deploy (default-off flag, `built` marker), or ship D1's additive parts only and park shadow targets until PR-G. Proposed: park shadow targets; ship M and D1-additive.
2. **Mirror source:** slice M on the `beehive` worker, GET/HEAD only, template-only (proposed); `MIRROR_SAMPLE_PERCENT` default 0, dashboard-set.
3. **Exposure variables** `MIRROR_SAMPLE_PERCENT` and `SHADOW_RUNG_MIRRORING`: both default off, dashboard-set, never in a `wrangler.toml` (proposed).
4. **Defaults:** `SHADOW_SAMPLE_PERCENT = 10`, `SHADOW_MAX_TARGETS = 5` (hard max 8), in-flight mirror cap 10.
5. **Drop rule:** drop only when both sides agree on the status class (proposed).
6. **D2 bar:** >= 3 candidates reach `SHADOW_MIN_SAMPLES` production samples, at least half on declared spec routes, within 7 days (proposed).
7. **Order:** P0, P1, then M, then D1, then the window, then D2 with its own approval (proposed); the ingest source for customer services as its own plan.

## 14. Review asks (rev 3 re-review; answered in section 15)

- Slice M: is sanitizing at the source and sending only `{method, template}` safe and sufficient? The loop guard (`X-Beehive-Mirror`): any path where
  a router-originated request can reach the edge without it (service-binding calls, redirects, the baseline URL)? Does wrapping `fetch` risk the response
  path, CPU or the DO-binding behavior of the `beehive` worker? Is a new top-level service binding from the root worker to the router safe for the
  ten-workers-at-once deploy (empty account, binding cycles: the router does not bind back to `beehive`)?
- D1 sections 4-5: production-only tournament score; both-4xx drop; `preview_kind` as the real-deploy test (or a probe); the target ordering.
- Is `GET /shadow-targets` plus two default-off dashboard variables enough exposure control until PR-G, given allowlisted-member creation?
- D2 outline and the measurement bar; the ingest-source reservation in section 9.

## 15. Review 2 dispositions (independent agent, 2026-11-11, on rev 3; all verified against the code at `aaef5e4`)

Verdict was "not approvable as written" (4 blockers). Slice M's shape (sanitize at source, wrapper, loop header) stands. Plan changes, which supersede earlier text:

- **B1 (router hash gate) - right.** `/mirror` bypasses the top gate (`classifyRequest`, `shadow-router/index.ts:715`) and the per-candidate hash (`:268`): a descriptor URL is one of a few dozen templates, so a hash would put each permanently in or out. The edge's `MIRROR_SAMPLE_PERCENT` is the only sampling for canary and baseline-less paths; shadow targets use the random draw of D1.2. Tested: a `/mirror` descriptor reaches canary targets at the edge's rate, not 1%.
- **B2 (no honest `preview_kind` writer) - right.** The only preview at `passed_premerge` is simulated (`preview-manager/builds.ts:276-285`, URL fails `isAcceptableCanaryUrl`); the one real deploy is the canary upload, after shadow. P1 is therefore answered by the code. **D1 as specced delivers nothing on its own.** Shadow targets need a slice that really deploys a `passed_premerge` candidate (unreviewed code deployed one rung earlier: a governance decision). New slice **P** (pre-shadow real preview deploy, behind its own default-off flag) is a prerequisite of D1's `/shadow-targets`; `preview_kind='built'` is written only by that path. Without P, D1 ships only the additive parts (baseline kind, comparator marking, response fields). Decision 13.8.
- **B3 (dashboard vars) - right** (`docs/OPS.md:628`: dashboard vars are overwritten by the next push; no config sets `keep_vars`). `MIRROR_SAMPLE_PERCENT` and `SHADOW_RUNG_MIRRORING` are set by the maintainer in `[vars]` in the Artifacts deploy repo (the documented pattern, like `GOVERNANCE_EGRESS_CONTROLLED`); the "no toml sets it" test asserts the **repo's GitHub copy** never enables them (value absent or `0`/`false`). Rollback is a deploy, not an instant dashboard flip. Decision 13.3 amended.
- **B4 (D1 changes promotion) - right.** Every seeder posts `placeholder` samples (`e2e/promotion-fixtures.ts:55-57`, `scripts/demo/tournament.ts:188-189`, `scripts/prod-verify-promotion.sh:73-76`), and the tournament has no minimum-sample rule today. Chosen: **D1 ships additive fields only; the production-only tournament score and `SHADOW_MIN_SAMPLES` move to D2** with the seeders. Section 5 is replaced by: D1 changes no promotion behavior; the tournament keeps its all-sample average until D2. Mixed-version row added: old tournament against new Spec DO (all-sample average now includes production samples; accepted, log-only region).
- **S1** route words: the edge shares `MIRROR_ROUTE_WORDS` (moved to a shared constant, router and edge read the same default) and `about`/`roadmap` are added. F6 corrected: informative baselines are `/` and `/app*` only.
- **S2** amplification: add a per-isolate token bucket (rate, not just in-flight cap); state that a candidate can fetch public pages and be re-mirrored; the gate default stays 0.
- **S3** claim fixed: the router has a Spec DO binding with `script_name = "beehive"` (`shadow-router/wrangler.toml:27-30`); the new root-to-router binding is a mutual dependency like the gate workflow and preview manager (safe on the existing account, two-pass on an empty one). Section 7 table amended.
- **S4** the prefix `beehive-candidate-` also matches the platform's `beehive-candidate-service`: `/shadow-targets` reuses the reserved-name exclusion; constant moves to `workers/shared/`.
- **S5** `preview_kind` resets on any preview PUT that omits it; mixed-version rows added (new preview manager against old Spec DO: field ignored, fine).
- **S6** drop rule extends to both-3xx; the plan states scores are status, four headers and latency (bodies never compared, `index.ts:464`); `X-Beehive-Mirror` is sent only where the target can be `beehive` (baseline, canary refs), not to shadow candidates.
- **S7** the `production` marker is forgeable by master/service principals (`api/index.ts:236-239`); acceptable in D1, D2 must not treat it as proof.
- **Nits** fixed in section 1: `fetch` at `api/index.ts:89`; public pages `:94-97`; `createSimulatedPreview` `:616-675`; `wrangler.toml:20` is the router's; F7 a per-target percent is a no-op only at or above the top split. Edge wrapper captures method and path before `request` is reassigned (`:121`); `/mirror` is matched before the generic path (`:695-708`).

### Code review 1 dispositions (2026-11-11, on the M + D1-additive implementation; no blockers)

Fixed: a baseline answering 5xx or 429 is not a usable production answer, so no message is queued (401/404 stay real answers); the exposure-var test now
parses assignments (inline tables, quoted keys, `"0"` allowed, `tests/e2e/probe` scanned); `headersForTarget` no longer special-cases the baseline (dead,
and it would have handed over the caller's headers); stale comments and the debug hook removed. Corrected: an **old router** has no `/mirror` route and
its generic path answers 200 without fanning out (the edge counts that as sent; harmless, and the gate is off by default); section 7's "404" row means this.
**Deviation recorded (decision for the maintainer at D2):** a descriptor reaches a canary target at `MIRROR_SAMPLE_PERCENT x the canary's own trafficPercentage`
(section 15 B1 said "at the edge's rate"); it keeps each deployment's configured split, but a 5% canary at a 10% edge rate sees 0.5%, which lengthens the
measurement window. Known and accepted: every enqueued sample is now `production`, including canaries of specs whose service is not the platform API (F6, S7);
D2 must not read `production_count` as proof. Left: the marker header goes to all candidates (fine while shadow targets are not built), the template
truncation at 128 characters can leave a partial segment (the router answers 400, no privacy impact), the unused `PREVIEW_SCIENTIST_QUEUE` binding stays
(mixed-version safe).
