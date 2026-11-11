# Plan: shadow-router follow-up, shadow evidence a candidate can actually earn (then enforce it)

Task: `shadow-router-followup` | Spec: `docs/OPEN-QUESTIONS.md` "2026-11-10: the shadow rung cannot be enforced yet (mirror targets and baseline)" |
Tier: heavy (AGENTS.md rule 2: promotion train inputs; touches the Spec DO's evidence rules and the router that feeds them).
Status: **rev 2 (2026-11-11): Review 1 (independent agent, approve with changes for D1 only, 5 blockers, D2 not approved) applied in section 11, which
supersedes conflicting text above. Needs a re-review before any code. Blocked on P0, P1 and decision 9.1 (section 11).** No code written. Follows `docs/plans/promotion-gaps-plan.md` (merged 2026-11-10,
`aaef5e4`, not deployed), whose shadow evidence is log-only exactly because of the gaps below.

The goal is one sentence: **a candidate on the shadow rung receives mirrored traffic, is scored against a real production answer to the
same request, and the score reaches the ledger marked `production`, so that the shadow rung can be switched from log-only to enforced by
changing one constant.** This plan builds the evidence path (PR D1) and the switch (PR D2), with a measurement window between them.

## 1. Facts (line numbers at `aaef5e4`)

**Targets.**
- F1. The router mirrors to two kinds of target only: the static map (`getProductionShadowConfig` has the single entry
  `beehive-main`, `workers/shadow-router/config.ts:147-150`; local dev adds three ports, `:121-130`) and live **canary** refs overlaid by
  `applyCanaryRefs` (`config.ts:196-250`, cached by `live-refs-cache.ts`, 5 s TTL). A candidate at `passed_premerge` has neither, so it is
  never mirrored and gets no samples.
- F2. `beehive-main` is production itself (the platform's own API worker). It is also a fan-out target: GET and HEAD are replayed against it
  (`BASELINE_REPLAY_METHODS`, `index.ts:191`; writes are skipped, `:268-272`), so its real response is in `candidateResponses`.

**The baseline is not used.**
- F3. `triggerScientist` ignores that response and enqueues a placeholder baseline: `status: 200`, fixed headers, `latencyMs: 50`
  (`index.ts:447-453`). Every score is "did the candidate answer like a fake 200".
- F4. The baseline target receives the **original** request (real path, query, body, credentials); a candidate receives a **sanitized** one
  (`mirror-mode.ts`: method, route template, `Accept`, no body, no query, no path ids; `candidate-headers.ts`). So even a real baseline answer
  would not be the answer to the same request: on `/links/abc123` production sees that path and the candidate sees `/links/:id`.
- F5. Candidate bodies are not read (`index.ts:464`, TODO; M5A-2 plan path (h): cap and redact before it is filled); `specId` is `''`
  (`:458`, also `:147`, `:297`). The comparator therefore compares status codes, a header allowlist and latency; body diffs are trivially empty.

**The comparator and the ledger.**
- F6. `workers/scientist-comparator/storage/spec-do.ts:33` hard-codes `SAMPLE_BASELINE = 'placeholder'`; the Spec DO already splits
  `shadow_scores` into placeholder and production columns (`production_count`, `production_score_sum`) and the sample route accepts
  `baseline: 'production'` (PR A). Nothing sends it.
- F7. The shadow verdict (`workers/shared/shadow-verdict.ts`) and `shadowScore` use **all** samples, placeholder included; `advance` treats
  the shadow rung as log-only (`workers/shared/promotion-advance.ts` `EVIDENCE_MODE`). Enforcing today would let placeholder scores pass.
- F8. `preview-manager` sends a non-comparison "preview-deployed" message to the comparator's preview queue on every preview deploy
  (`workers/preview-manager/index.ts:684-715`, comment: "for now, we just send a deployment notification"). The comparator parses it as a
  comparison, fails, and (since PR A) acks it. It does nothing useful.

**Candidates and previews.**
- F9. A candidate gets `preview_url` / `preview_worker_name` from `PUT /api/candidates/:id/preview`, written by the preview manager after a
  push build (`preview-manager/index.ts:~559, ~634`); the URL is `https://<worker>.<subdomain>.workers.dev`. `isAcceptableCanaryUrl`
  (`workers/shared/deploy-refs.ts:67`) is the existing check for "a Worker on workers.dev, https, no credentials".

**Governance (do not weaken).**
- F10. Candidates are agent-written, public and have open outbound `fetch`; mirrored customer data is a leak path
  (`mirror-mode.ts` header; M5A-2 plan B4). Default `MIRROR_BODY_MODE = none` (`shadow-router/wrangler.toml:20`). Real-data eligibility
  (`candidateExposure()`, M5A-2 line 177) is **not built** (PR-G). Maintainer decision 8: untrusted creation stays closed (allowlist only)
  until PR-G, so every candidate today is maintainer-origin.

## 2. What this plan decides, and what it leaves

In: mirror shadow-rung candidates in `none` mode; compare them to a real production answer to the **same sanitized request**; mark the sample
`production`; stop scoring against a fake; make the verdict and the tournament score production-only at the flip; remove the dead
`triggerShadowComparisons` message.

Out (each recorded in section 9): reading response bodies (path (h): cap, redact, own plan); `redacted`/`full` mirror modes for candidates;
per-spec baselines (one platform baseline, `beehive-main`, as today); `candidateExposure()` (PR-G; this plan adds a deploy flag instead);
synthetic contract probes (section 8, option B); the tournament's decide-on-second-arrival rule.

## 3. Design

### 3.1 Targets: a Spec DO read route, a flag, a cap (PR D1)

New internal Spec DO route `GET /shadow-targets` -> `[{ candidateId, specId, previewUrl }]`, newest first, capped at `SHADOW_MAX_TARGETS`
(default 5, hard max 20): candidates with `stage = 'passed_premerge'`, not tombstoned, with a `preview_url` that passes
`isAcceptableCanaryUrl(url, WORKERS_SUBDOMAIN)` (validated in the DO, so a bad value never reaches the router, and again in the router). A
dedicated slim route, not `GET /api/candidates?stage=`: the list route returns full rows (shadow metrics JSON included), is paginated by
`limit` with no spec filter, and has no flag.

Fail-closed flag: the route answers `[]` unless the Spec DO var `SHADOW_RUNG_MIRRORING = "true"` (human-set deploy var, default absent, same
pattern as `GOVERNANCE_EGRESS_CONTROLLED`). Until PR-G builds `candidateExposure()`, this flag is the whole exposure control; with
maintainer-only creation it is sufficient, and the plan says so rather than pretending otherwise. Mixed-version: an older Spec DO answers a
code-less 404, which the router treats as "no shadow targets" (logged once), never as an error that drops the canary targets.

Router: `applyShadowTargets(config, specDo, cache, subdomain)` beside `applyCanaryRefs`, with its own `LiveRefsCache` instance (same TTL).
Each target is added to `candidatePreviews` with a split of `canaryPercentage = SHADOW_SAMPLE_PERCENT` (default 10, so a shadow-rung
candidate sees a tenth of the mirrored requests), `holdoutPercentage 0`; a static target id or a canary ref id wins over a shadow target
(same rule as `applyCanaryRefs`); `config.shadowTargets: Map<candidateId, specId>` records which entries are shadow-rung. Subrequest budget:
one request fans out to at most `SHADOW_MAX_TARGETS + canary + baseline` fetches; the cap keeps it far below the Workers limit and the
existing 10 s per-candidate timeout bounds latency (the response to the caller never waits for mirroring: `ctx.waitUntil`).

### 3.2 Like-for-like baseline (PR D1)

For each mirrored GET/HEAD the router makes **one extra baseline fetch with the same sanitized request the candidates get** (the
`mirrorRequestFor` output for the mode, credential-free) against `beehive-main`, in parallel with the candidate fetches, and uses *that*
answer as the baseline in the queue message. The existing original-request replay to `beehive-main` stays as it is for its other
purposes. Non-GET/HEAD requests have no baseline (a sanitized write replayed against production would be junk writes): the message says so
(`baseline.kind = 'unavailable'`) and the comparator posts **no sample** for it (section 3.4). This replaces the placeholder at
`index.ts:447-453`; the placeholder survives nowhere.

Honest limit, stated in the plan and in OPS: in `none` mode what is compared is the answer to **anonymous, id-less requests**. For this
platform's own API (auth fail-closed) most of those are `401` on both sides; for a public service they are the list/health/landing routes.
The signal is thinner than "real traffic", which is why section 3.5 measures before enforcing.

### 3.3 The queue message (PR D1, additive)

`baseline` gains `kind: 'production' | 'unavailable'` (absent = `'placeholder'`, the old router) and keeps `status`, allowlisted headers,
`latencyMs` of the real answer. Each candidate entry gets its real `specId` (from `config.shadowTargets` or the canary deployment) and
`rung: 'shadow' | 'canary'`. Nothing is removed. Bodies stay unread (F5). Old comparator + new message: ignores the new fields, and posts
`placeholder` samples exactly as now (safe: placeholder never counts, section 3.5). New comparator + old message: no `kind` means
placeholder, same as now.

### 3.4 Comparator (PR D1)

`SAMPLE_BASELINE` becomes per message: `baseline.kind === 'production'` -> sample `baseline: 'production'`; absent -> `'placeholder'`;
`'unavailable'` -> no sample. A production-baselined sample whose baseline answered **4xx/5xx** is dropped, counted in Analytics Engine
(`uninformative`) and logged once per batch: both sides rejecting a request tells nothing about the candidate (a baseline `401` vs a candidate
`401` is a 100). A baseline 2xx/3xx with a candidate 5xx is the most informative sample there is and is kept. The comparator takes `specId`
from the message when present, else from the ledger as now.

### 3.5 The flip (PR D2), after a measurement window

PR D1 changes nothing about promotion (shadow stays log-only). The window answers: how many **informative production samples** do shadow-rung
candidates actually accumulate per day, and what do they score? Measurement query in OPS (`shadow_scores.production_count`, `uninformative`
counter). Flip criteria (maintainer decision, proposed): at least 3 candidates have reached `SHADOW_MIN_SAMPLES` production samples within 7
days of mirroring being enabled. If not, the signal is too thin and option B (section 8) is needed first.

PR D2 then: (1) `EVIDENCE_MODE.shadow = 'enforce'` (one line, `promotion-advance.ts`); (2) the shadow verdict is computed from the
**production** columns only (`production_count >= SHADOW_MIN_SAMPLES`, `production_score_sum / production_count >= SHADOW_PASS_SCORE`), so
placeholder samples (log period, old routers) can never pass a candidate; (3) `shadowScore` for the tournament is the production average, and
a candidate with no production samples has none (the tournament already treats a missing score as `no_shadow_evidence`); new response fields
`shadowProductionScore` and `shadowProductionCount` are additive (the candidate response schema is not strict); (4) a one-time sweep when the
flip deploys: `gate_verdicts(shadow)` rows whose notes say "(0 against production)" are set to `pending` (they were derived from placeholder
samples), recorded in `governance_events`; candidates that passed shadow during the log period are grandfathered at their current stage
(`advance` never moves a candidate backwards); (5) e2e and the demo seed `baseline: 'production'` samples through the existing maintainer-only
edge route; (6) the worker's dry-run pre-check must tolerate the evidence its own step produces (already true for shadow: the tournament reads
the verdict, it does not produce it).

### 3.6 Hygiene (PR D1)

Delete `triggerShadowComparisons` and its call sites in `preview-manager` (F8): it is dead weight that pollutes the comparator queue. The
preview queue keeps its comparator consumer (the router still enqueues there for `preview-`-named candidates).

## 4. Mixed-version window (one push, ten workers, any order)

| Old peer | New peer | Behavior |
|---|---|---|
| router (no shadow targets) | Spec DO (new route) | route unused |
| router (new) | Spec DO (old) | `GET /shadow-targets` code-less 404: no shadow targets, canary targets unaffected, one log line per isolate |
| comparator (old) | router (new message) | extra fields ignored; samples are `placeholder` as today |
| comparator (new) | router (old message) | no `baseline.kind`: `placeholder`, as today |
| promotion worker / `advance` | any | unchanged until PR D2; at D2 an old Spec DO still has log-only shadow, a new one enforces production-only |

No route or field is removed; no schema change in D1 (the `shadow_scores` split exists). D2 changes behavior of the Spec DO only.

## 5. Tests

- Spec DO: `GET /shadow-targets` returns only `passed_premerge`, live, valid-URL candidates; `[]` without the flag; cap and order; a bad URL,
  a tombstoned candidate and a candidate with no URL are excluded; the response contains no other fields.
- Router: shadow targets overlay (static and canary ids win; bad URL ignored; sample percent; cache reuse; old-DO 404 keeps canary targets);
  the like-for-like baseline request equals the candidate request byte for byte in every mirror mode and carries no credentials; no baseline
  for POST; the queue message carries `baseline.kind` and `specId`; a failed baseline fetch is `unavailable`, not a fake 200; the placeholder
  is gone.
- Comparator: `kind` -> sample baseline mapping; `unavailable` posts nothing; baseline 4xx/5xx drops and counts; candidate 5xx against baseline
  2xx is kept and scores low; the old-message path.
- D2: the verdict from production columns only (placeholder-only candidate is `pending`); the tournament ranks by the production score; the
  sweep; `EVIDENCE_MODE` flip makes the `advance` shadow rows refuse (the PR B enforce-mode tests already exist).
- e2e/demo: seeded production samples; the local stack has no real candidate preview, so the router tests use a stub target.
- Mutation checks for every guard.

## 6. Docs to update

`docs/OPS.md` (flag, caps, sample percent, measurement queries, the thin-signal statement, deploy order is irrelevant but the flag stays off
until chosen), `docs/OPEN-QUESTIONS.md` (close the 2026-11-10 entry in two steps: D1, D2), `docs/GOVERNANCE-STATE-MACHINES.md` (shadow row),
`docs/plans/promotion-gaps-plan.md` (flip-readiness paragraph points here), `docs/FOCUS.md`.

## 7. Risks

- **Thin signal in `none` mode** (section 3.2): the measurement window exists to catch it before anything is enforced. Without it, enforcement
  could block every promotion past `shadow`.
- **Load and cost.** Mirroring adds up to `SHADOW_MAX_TARGETS` fetches and one baseline fetch per sampled request, plus one Spec DO write per
  candidate per sample (idempotency row each). Bounded by the 10% sample, the target cap, the 1000-sample cap per candidate and baseline, and
  the queue's batch size; OPS says what to watch (`idempotency_keys` growth, router subrequests).
- **Exposure.** Shadow-rung candidates are unreviewed code receiving mirrored traffic (method, template, `Accept`). Same exposure class as the
  canary path today, widened to more candidates, behind a default-off human flag. A candidate can still measure which routes are hit and
  when (timing channel); no customer data crosses in `none` mode. `candidateExposure()` replaces the flag when PR-G exists.
- **One baseline.** `beehive-main` is the only baseline; candidates of a different service compare against the wrong thing. Section 9.
- **Baseline load.** The extra baseline fetch hits production with an anonymous GET/HEAD per sampled request: cheap, but it is real traffic to
  production, and the 401/404 answers are noise in production dashboards.
- **Placeholder ghosts.** Candidates scored under the log period keep placeholder-derived verdict rows until the D2 sweep; the sweep is part
  of the flip and tested.

## 8. Alternatives considered

- **A. Live mirror in `none` mode with a like-for-like baseline (this plan).** Zero customer data, real production answer, thin signal.
- **B. Synthetic contract probes.** A probe issues requests derived from the spec's contract (method, path, example body) to baseline and
  candidate, and posts `source: 'synthetic'` samples. Safe and available at zero traffic, and not blocked by auth or ids, but it needs concrete
  examples in the spec contract (today's contracts name endpoints and shapes, not example values, `docs/specs`) and is a different oracle from
  "live traffic decides". Proposed as the fallback if the measurement window shows A is too thin, not as a replacement.
- **C. `redacted` mode.** More signal (body shape), but it leaks structure and is "never for untrusted-origin candidates" (`mirror-mode.ts`);
  needs path (h) first.
- **D. Compare against the real caller-facing production response.** The router only sees a mirrored copy of the request, not production's
  answer; getting it means a change at the edge. Larger and cross-cutting.

## 9. Open decisions for the maintainer

1. **Baseline model:** keep the single platform baseline `beehive-main` (proposed) or add a per-spec baseline URL (a column, a route, a
   migration) before mirroring other services.
2. **Mode:** `none` only (proposed), accepting the thin signal, with the measurement window deciding between A and B.
3. **Exposure flag** `SHADOW_RUNG_MIRRORING`, default off, human-set (proposed), until `candidateExposure()` exists.
4. **Defaults:** `SHADOW_SAMPLE_PERCENT = 10`, `SHADOW_MAX_TARGETS = 5`.
5. **Uninformative rule:** drop samples whose baseline answered 4xx/5xx (proposed).
6. **Flip criteria:** >= 3 candidates reaching `SHADOW_MIN_SAMPLES` production samples within 7 days (proposed), else option B first.
7. **Slicing:** D1 (evidence path, no behavior change to promotion) deployed and measured before D2 (the flip). Proposed.

## 10. Review asks

- Is the like-for-like baseline (one extra sanitized fetch against production, GET/HEAD only) safe and sufficient, or does it create a
  production-side risk the router's existing `BASELINE_REPLAY_METHODS` rule did not?
- Is a Spec DO read route plus a default-off flag a sufficient exposure control until PR-G, given maintainer-only creation?
- Is dropping baseline 4xx/5xx samples right, or does it hide a candidate that wrongly accepts what production rejects?
- D2's production-only verdict, the sweep and the grandfathering: any path where a placeholder score can still pass a candidate, or a
  legitimately passed candidate is regressed?
- Mixed-version rows; anything in the router's subrequest/limits budget I missed.

## 11. Review 1 dispositions (independent agent, 2026-11-11: approve with changes for D1 only; D2 not approved; sections 11 supersedes the text above)

I re-checked B1, B2 and B4 in the code before accepting them. The plan as written would have shipped a pipeline that measures nothing.

**Blockers.**
- **B1 (accepted, verified): nothing sends traffic to the shadow router.** No worker, edge route or workflow calls it (`workers/` and
  `.github/workflows` contain only the unused `SHADOW_ROUTER` binding of the promotion worker and CI's build list; the edge, `workers/api`, does not
  mirror). Either mirrored traffic comes from configuration outside the repo, or there is none. **Precondition P0 (human, before D1):** confirm in
  Cloudflare where the router receives production traffic from and its volume; record it in `docs/OPEN-QUESTIONS.md`. If there is no source, building
  one (an edge hook that copies requests) is its own plan and this plan waits for it. Without it the section 3.5 measurement window yields zero samples.
- **B2 (accepted, verified): `preview_url` may not be a live Worker.** `createSimulatedPreview` writes a URL without deploying anything
  (`workers/preview-manager/index.ts:616-634`), the Workers Builds path is a placeholder (`builds.ts:201-212`), and the DO stores whatever it is
  given. A dead URL becomes a synthetic 500 in `fetchCandidate` and every such candidate scores low. **Precondition P1 (human):** verify in production
  how candidate previews are really produced. **Design change:** `/shadow-targets` returns only candidates whose preview was produced by a real
  deploy. Recommended: a `preview_kind` marker (`built` | `simulated`) written by the preview manager through the existing preview PUT route
  (additive column, additive optional request field, an older writer leaves it unset = not eligible); the alternative is a router health probe
  before first use. A simulated or unmarked preview is never a target.
- **B3 (accepted): `beehive-main` is not an oracle for candidates.** A sanitized request carries no credentials, so every `/api/*` answer from the
  baseline is `401` (auth is fail-closed) and, under the 4xx rule, dropped; the only informative answers are the public pages (`/`, `/about`,
  `/roadmap`, the UI, `workers/api/index.ts:92-103`), and candidates implement other services. A single platform baseline would score "does the
  candidate look like Beehive's landing page". **Consequences:** D2 is removed from this plan's approval; section 3.5 gains a *validity*
  criterion (informative production samples on the candidate's **own spec routes**, not just a count); and **decision 9.1 is no longer optional**:
  a per-spec baseline (a baseline URL on the spec or repository, set by the maintainer, additive migration) or option B (synthetic contract probes,
  which also need example values in the spec contract) must be chosen before the evidence path is worth building. Recommended: per-spec baseline for
  the live oracle, synthetic probes later as a second source.
- **B4 (accepted, verified): the sampling and latency claims in 3.1 were wrong.** The top gate classifies every request with the default split
  (1% in production, `config.ts:158`, `index.ts:715`) using a hash of `method:url` (`index.ts:102-109`), and the per-candidate check reuses the same
  value (`:268`): `SHADOW_SAMPLE_PERCENT = 10` was a no-op, a shadow target would see only the 1% that passes the gate, and the same URLs would always
  (or never) be mirrored. The fan-out is **awaited** before the response (`:728`); only `triggerScientist` is in `waitUntil`, so latency is up to 10 s
  per target. **Revised:** shadow targets are sampled per target and per request with a random draw (`SHADOW_SAMPLE_PERCENT`, default 10) evaluated
  after the top gate and independent of the URL hash (so the same URL is not always or never mirrored); the top gate's own 1% default is stated in
  OPS as the ceiling on volume unless changed; the fan-out moves into `ctx.waitUntil` so mirroring never delays the response (the canary metrics
  recording moves with it).
- **B5 (accepted, verified): D1 changes promotion.** The tournament ranks by `shadowScore`, an average of all samples (`workers/spec-do/index.ts:5113`).
  With the flag on, tournaments would decide on a mix of placeholder and thin production samples before the measurement window ends. **Moved into
  D1:** the candidate response gains `shadowProductionScore` / `shadowProductionCount` (additive), and the tournament uses the production score
  only (a candidate with fewer than `SHADOW_MIN_SAMPLES` production samples has none, so the tournament says `no_shadow_evidence`, as it does in
  production today). The shadow *verdict* stays all-sample and log-only until D2.

**Non-blocking, all accepted.**
- **N1:** replace the original-request replay of `beehive-main` with the sanitized baseline fetch instead of adding a second fetch. The replay feeds
  only Analytics Engine rows (`index.ts:295-309`), which nothing reads, re-sends caller credentials over the public Internet, and leaves the
  baseline in `candidates` scored against the new baseline. The baseline is excluded from `candidates` in the queue message. **N2:** build the
  baseline request with a non-baseline id (`headersForTarget(BASELINE_TARGET_ID, ...)` returns the caller's headers).
- **N3:** drop a sample only when baseline and candidate agree on the status class (both 4xx or both 5xx); a disagreement (baseline 4xx, candidate
  2xx: it accepts what production rejects) is scored. Per-candidate counts of dropped and scored samples are logged, not Analytics Engine alone.
- **N4:** D2's sweep recomputes every shadow verdict from the `shadow_scores` columns; it does not match the notes text (the row is rewritten only on a
  status change, and a candidate at the cap writes nothing, so a text match goes stale).
- **N5:** samples accumulate across pushes to the same candidate id and freeze at 1000 per baseline. D1 must establish whether a new commit is a new
  candidate id (`candidates.commit_sha` is fixed at creation) and state the reset rule; if one id spans commits, the production columns reset when the
  head sha changes. **N6:** the comparator's batch of 100 times one post per candidate leaves a hard `SHADOW_MAX_TARGETS` of 20 at ~2000
  subrequests against the ~900 already noted (`scientist-comparator/storage/spec-do.ts:53-55`): the hard max is 8, default 5.
- **N7:** a message whose baseline is unavailable is **not enqueued** (an old comparator would score it against a placeholder). The mixed-version
  table gains that row. **N8:** targets are ordered by fewest production samples and skip candidates at the cap, not newest first (which starves
  older candidates). **N9:** `/shadow-targets` also requires the candidate worker-name prefix (`CANDIDATE_WORKER_PREFIX`), because
  `isAcceptableCanaryUrl` accepts any Worker on the account, `beehive` itself included.
- **N10:** F10 is corrected: candidates are created by **allowlisted members** (user tokens with write scope can create and claim, viewers are
  read-only, minting is master or session only), not only the maintainer; creation is closed to strangers. `SHADOW_RUNG_MIRRORING` must be a
  **dashboard-set variable, never in a `wrangler.toml`** (an agent's pull request can edit one), with a unit test that no wrangler config sets it, like
  `CANARY_MIN_SOAK_MINUTES`.
- **N11, rollback:** turning the flag off removes shadow targets within two cache TTLs (~10 s); the samples and verdict rows stay and still count
  after D2; idempotency rows expire in 24 h. **N12, docs and tests:** also `docs/ARCHITECTURE.md:564` (says the router has no `SPEC_DO` binding) and the
  public page text (`workers/api/index.ts:749,1248`); tests for the classification of shadow targets, the baseline excluded from `candidates`,
  and any non-OK `/shadow-targets` answer (not only 404) keeping the canary targets. The Spec DO's fall-through 404 body for an unknown route is
  unverified: check it before relying on "code-less 404".

**Facts corrected.** F2: writes are skipped at `index.ts:280-284`, and in production the baseline is replayed for ~1% of URLs only. F4: `none` mode
also sends `x-request-id` (the router's own UUID, so no leak). F9: the preview URL may be simulated (B2). F10: member origin (N10). `applyCanaryRefs`
is `config.ts:216-260`. The tournament already consumes `shadowScore` (B5).

**What this means for the plan.** D1 as written is not startable. The order is now: P0 (where does mirrored traffic come from) and P1 (are previews
real) are human checks; decision 9.1 (per-spec baseline vs synthetic probes) shapes everything; then a re-reviewed rev 3; then D1; then the
measurement window with the validity criterion; D2 only after that and a separate approval.
