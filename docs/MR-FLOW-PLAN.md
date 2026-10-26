---
category: planning
status: proposed
audience: human,agent
---

# Plan: issue → fork → merge request → review → merge (spec trials optional per repo)

**Status:** plan only, 2026-10-26, branch `agent/mr-flow-plan`. Nothing here is implemented. Items marked **[SPINE]** (spec
schema, DO ledger, promotion train, Workflow sequencing; AGENTS.md rule 2) need the maintainer's design sign-off.

## 1. Decision

Maintainer direction (2026-10-26): the normal issue + MR flow is the baseline. Spec trials with competing candidates are an
optional alternative per repository, and every contributor works from a fork. The working recommendation was: "an MR is a
candidate with an optional spec; one promotion path, one ledger; the ladder is per-repo policy; reviews are Spec DO rows; merging
is a ref operation."

**Confirmed: the idea of one ledger and one promotion path.** An MR is a `candidates` row with a 1:1 `merge_requests` row next to it.
Gate verdicts, trials, promotions, deploy refs, issue links, purge and history keep working unchanged for MRs.

**Rejected: making `candidates.spec_id` nullable.** Replaced by an *implicit per-repository spec*. Reasons:
1. SQLite cannot drop `NOT NULL` in place (`workers/spec-do/schema-inline.ts:108`). Doing it means rebuilding the table
   (create, copy, drop, rename). Five tables have foreign keys to `candidates(id)`, legacy ledgers carry different column sets
   (`preview_*`, tombstone columns; `docs/OPEN-QUESTIONS.md` 2026-10-26), and `docs/MIGRATION-LEGACY-TEST-PLAN.md` §4 allows only
   `PRAGMA table_info`, `ADD COLUMN` and `CREATE … IF NOT EXISTS`. A rebuild is not additive.
2. During the mixed-version window, live peers parse `specId` with strict zod as a required uuid:
   `workers/gate-workflow/index.ts:38`, `workers/scientist-comparator/types.ts:60`, `workers/preview-manager/types.ts:235`,
   `workers/shared/promotion-ledger.ts:25`. A NULL fails every one of them. An implicit spec id is an ordinary uuid that old code
   already accepts.
3. Everything keyed by spec already works for an implicit spec: `trials.spec_id`, `deploy_refs (spec_id, rung)`
   (`schema-inline.ts:557`), tournaments and merge trains. The implicit spec is "the repository's mainline". MRs in a repo that has
   the ladder enabled use the canary refs exactly like spec candidates do.

Users still see the spec as optional: the API returns `specId: null, implicit: true` (opt-in, §8); the UI hides implicit specs.
**[SPINE]** A real NULL would need a separate guarded rebuild migration plus a DO SQLite fidelity check (question 1).

**Prerequisite (new fact, 2026-10-26): the pre-merge gate is simulated.** Tests are a comment that runs nothing
(`workers/gate-workflow/index.ts:615-622`). The complexity score is a hash of the candidate id (`:723`). The conformance warning is
`Math.random() < 0.1` (`:789`). The gate's clone in the sandbox runner only logs (`workers/sandbox-runner/index.ts:371-374`). The
only real sandbox work today is the canary build (esbuild in a `BuildSandbox` container). The default MR policy needs "tests
pass", so a real test-running gate is slice 1 (§10), before any merge button exists. Existing `gate_verdicts` rows are synthetic,
and the public pages say otherwise (§11).

## 2. Flow and forks

Flow: issue → contributor forks the target repo (Artifacts native fork) → pushes a branch to the fork → opens an MR (target repo
+ branch, source fork + branch) → the gate runs on every new head sha → reviewers (humans, and agent profiles if the policy says
so) review a specific sha → the policy is met → a maintainer merges. The merge is a recorded ref move, and the Artifacts branch
mirrors it.

- **Fork per contributor, humans included.** Rule 3 stays as it is. Forks are cheap: `POST …/repos/:name/fork` and
  `repo.fork()` exist (developers.cloudflare.com/artifacts/api/rest-api). Today `createFork` creates an empty repo and its comment
  says no fork-from exists (`workers/shared/artifacts.ts:125`). That comment is stale; the About page already says "native fork is
  next". Forks stay in the org's namespace (the fork route takes only a name).
- **Same-repo branches: recommend not allowed as an MR source, maintainers included.** Maintainers may push `scratch/*` to the
  upstream repo, because the always-pushed invariant needs somewhere to put intermediate state. With this rule there is one code
  path for MR sources and no write tokens on upstream for contributors. GitHub same-repo PRs are listed as "skip" in §9
  (question 3).
- Lineage: new `repositories.forked_from_repository_id`; forks keep `repo_type 'candidate'` (a `'fork'` value in the CHECK at
  `schema-inline.ts:49` = rebuild).

## 3. Data model and migrations [SPINE]

**Version.** The code is at `m11` (`workers/spec-do/index.ts:31`, steps `:1040-1062`). `m12` is reserved for the unique index
on `actors.github_user_id`, which REFUSES on duplicates (`workers/spec-do/tests/migration-actors-unique.test.ts`). The MR schema is
**m13**, shipped in its own push after m12 is live. Reason: if the m12 preflight refuses, `init()` rethrows and every request fails,
so MR work must not ride in the same push. A stored version newer than the code is already tolerated (`index.ts:1075`), so rolling
back after m13 degrades instead of failing.

**m13 contents.** Every change is `ADD COLUMN` behind `addColumnsIfMissing` (`index.ts:1112`) or `CREATE … IF NOT EXISTS`. The
same DDL also goes into the fresh-ledger path, so the `preview_*` gap does not repeat (OPEN-QUESTIONS 2026-10-26 #1).

| Object | Shape (summary) |
|---|---|
| `specs` + cols | `kind TEXT` (NULL = explicit, `'implicit'`), `repository_id TEXT`. Implicit specs are created lazily by the first MR, in that MR's transaction. Uniqueness: one implicit spec per repo, checked in code inside the transaction. A partial unique index would be a construct outside the allowed list (question 9). |
| `repositories` + cols | `forked_from_repository_id TEXT`, `policy_version INTEGER` (head of `repo_policies`) |
| `gate_verdicts` + col | `commit_sha TEXT`. Approvals and verdicts are pinned to a sha. NULL = legacy/simulated row. |
| `merge_requests` | `id`, `candidate_id` UNIQUE, `number` (per target repo, MAX+1 like issues `index.ts:1796`), `target_repository_id`, `target_branch`, `source_repository_id`, `source_branch`, `title`, `body`, `status` CHECK(open, closed, merged), `is_draft`, `author_id`, `head_sha`, `base_sha`, `merge_method`, `merged_ref_id`, `merged_by`, `merged_at`, `closed_by`, `closed_at`, `version` (CAS like `tournaments`), `created_at`, `updated_at`, tombstone cols |
| `mr_reviews` | append-only: `id`, `merge_request_id`, `reviewer_id` (actor), `profile_id`/`profile_version` NULL for humans, `verdict` CHECK(approve, request_changes, comment), `commit_sha`, `rationale`, `session_url`, `self_review INTEGER`, `created_at`. The latest row per reviewer counts. A review is stale when `commit_sha != head_sha`. |
| `mr_comments` | (slice 3) `id`, `merge_request_id`, `review_id` NULL, `path`, `line`, `commit_sha`, `body`, `created_by`, `created_at` |
| `review_profiles` | immutable versions: `id`, `repository_id`, `name`, `version`, `actor_id` (an `agent` actor per profile), `model`, `personality`, `prompt_sha256` + `prompt_r2_key`, `max_cost_usd`, `created_by`, `created_at`, `retired_at`. UNIQUE(repository_id, name, version). |
| `repo_policies` | immutable versions: `id`, `repository_id`, `version`, `flow` CHECK(mr, spec, both), `required_approvals`, `required_human_approvals`, `agent_profiles` JSON (pinned id+version), `dismiss_stale`, `allow_self_approval` (M5a bootstrap marker), `gate` JSON (test command, limits), `ladder` JSON (rungs required), `merge_methods` JSON, `set_by`, `set_at`. UNIQUE(repository_id, version). |
| `branch_refs` | the source of truth for merges, modelled on `deploy_refs`: `id`, `repository_id`, `branch`, `commit_sha`, `prev_ref_id` UNIQUE (linear chain), `action` CHECK(init, merge, revert, sync), `merge_request_id`, `moved_by`, `moved_at`. The Artifacts branch is a mirror and is never read as state. |

Purge (`docs/OPS.md` "Ledger cleanup") must cover the new tables. `entity_history.entity_type` (`schema-inline.ts:12`) has no
`merge_request`, so MR history uses `'candidate'` (a new type = rebuild). Tests: `migration-matrix.test.ts` to m13 (A1-A4),
m13 legacy-shape cases, `schema-sync.test.ts`.

## 4. Repo policy and reviewer profiles [SPINE: the check at merge time]

A pure evaluator `workers/shared/mr-policy.ts` (a leaf function, agent-writable) maps (policy, reviews, verdicts, head) to
`{mergeable, missing[]}`. The DO runs it **inside the merge transaction** against the policy version recorded on the MR. The UI
shows the same `missing[]`.

| Policy shape | Settings |
|---|---|
| Human review only (default) | `flow=mr`, `required_human_approvals=1`, `agent_profiles=[]`, gate `pre-merge` required |
| Agent reviewers | `agent_profiles=[security-strict@v2, perf-skeptic@v1]`, `required_approvals=2` (agents count) and/or `required_human_approvals=1` |
| Required approvals | non-stale approvals from distinct actors, author excluded. In bootstrap mode (one maintainer) self-approval is allowed only with `allow_self_approval` and is stored as `self_review=1` (M5a two-person rule) |
| Full oracle ladder | `ladder=[pre-merge, shadow, train, canary]`. Merge needs a passed verdict at `head_sha` for each rung. `flow=spec` keeps today's trial flow for explicit specs. |
| Mixed | Any combination. `request_changes` from a required reviewer blocks until a newer approval from that reviewer. |

**Profiles** are repo-scoped and immutable. Editing one creates `version+1`. Each review stores `profile_id` and
`profile_version`, so a verdict can always be traced to the exact model, personality and prompt hash. The prompt body lives in R2,
the hash in the row. The "personality" is a short style/focus brief (security, performance, API stability), not free code.

## 5. Reviewer-agent execution

Triggers: the MR is opened, or its head changes (a queue-consumer push event on the source fork). The API does **not** run
reviews. After the DO commit, the edge or the queue consumer enqueues `{mrId, headSha, profileId, version}` on a new queue,
`beehive-review-requests`. Its consumer is the **gate-workflow worker** (no new worker, so the deployment stays at ten). The consumer
calls the sandbox runner, which starts a no-Internet container, clones the source fork at `headSha` through `ArtifactsGateway`
(`workers/sandbox-runner/build-sandbox.ts:135`), runs the model, and returns structured JSON. The consumer then writes the review
through an internal DO route as the profile's agent actor, keyed by `(mrId, headSha, profileId, version)` in `idempotency_keys`.

- LLM egress: no Internet, only a gateway entrypoint that injects the API key for one host (Artifacts-gateway pattern); the key
  never enters the container (question 6). Transcripts are redacted before R2 (M7).
- Never in a request path, never Paseo spawning from Workers. "Workflow" = the gate-workflow worker (no `[[workflows]]`
  binding exists); real Cloudflare Workflows would be a topology change (question 7).
- Profile actors are type `agent`, cannot hold user tokens (`SpecDO.mintUserToken` accepts only humans with a `github_user_id`),
  and write only through the internal tier. The same holds for `beehive-system`.

## 6. Real test-running gate (prerequisite, slice 1) [SPINE: sequencing]

What it needs, building on the canary build path (`docs/SANDBOX-BUILD-PLAN.md`):
- **Clone:** reuse `ArtifactsGateway`. The token stays in entrypoint props; only `git-upload-pack` on one repo is allowed; symlinks
  are disabled; checkout is the exact 40-hex sha. Slice 1 tests the MR head in the source fork. Testing the merge result (as
  GitHub does) needs the gateway to allow two repos, both read-only, and comes with merge (slice 2).
- **Install policy:** the build path skips `npm install` (no install scripts). Tests need dependencies. Recommendation: a
  lockfile is required; run `npm ci --ignore-scripts` with egress only to `registry.npmjs.org`, through a second intercepting
  gateway entrypoint (GET only). Integrity comes from the lockfile hashes. The install phase is the only phase with any network;
  the test phase has none. Later: an R2 dependency cache keyed by the lockfile hash. Alternative: a fixed toolchain image and
  vendored deps only (question 5).
- **Command:** from `repo_policies.gate` (default `npm test`); no secrets in env, non-root, the repo never selects the image.
- **Limits:** today the build path uses clone 60 s, checkout 30 s, build 60 s, a 150 s deadline and a 1 MiB bundle cap
  (`build-sandbox.ts:70-74`). Proposed for tests: install 120 s, test 300 s, a 600 s whole-run deadline with the existing
  destroy-on-every-path and alarm, the log tail capped at 64 KiB in R2 with a hash in `gate_verdicts.notes`, and the instance type
  set per repo policy within an account cap (question 5).
- **Verdict:** the gate worker writes `gate_verdicts` with `commit_sha`, `status` from the exit code, the real test counts,
  `decided_by` = the gate's agent actor, and `notes` = `{runner, image digest, durations, log key}`. The score is derived from
  real data only. The hash-based complexity score and the random conformance warning are deleted, not kept as fallbacks. If the
  spec has no conformance check, the verdict says "not run" instead of passing.
- **Wiring:** push event → queue consumer → gate → sandbox runner `POST /test` (new, next to `/build`) → DO. The gate only reads.

## 7. Merge semantics in Artifacts [SPINE: ledger + sequencing]

Artifacts has no documented server-side merge, compare or ref-update API. Refs change only through the git protocol (control
plane = binding/REST, data plane = git). So a merge is a sandbox job:
1. The DO reserves: `POST /api/merge-requests/:id/merge {method, expectedHead}` checks the permission and the policy at
   `head_sha`, then sets `merging` with a CAS on `version` and records the expected target head from `branch_refs`.
2. The gate worker → sandbox: clone the target at the ledger head and fetch the fork at `head_sha` (read gateway). Merge the
   chosen way: ff-only, merge commit, or squash; the default comes from policy. Push with a short-lived **write** token held by
   the gateway, using `--force-with-lease=<branch>:<expected head>`.
3. The DO commits: insert a `branch_refs` row (CAS on `prev_ref_id`), set MR `merged`, set candidate stage `promoted`, and close
   linked issues. All in one `transactionSync`.

The push happens before the ledger records anything (always pushed). If the push succeeds and step 3 fails, a reconcile step on
the next merge compares Artifacts `log(ref)` with the ledger head. On mismatch it refuses and alarms. It never adopts the
Artifacts state silently. **Revert** inserts a `revert` row pointing at `prev.commit_sha`. The mirror gets a revert commit by
default, so no history is rewritten. That keeps rollback a ref operation (rule 7).

**Findings for `docs/OPEN-QUESTIONS.md` (recorded in this commit):** whether a non-fast-forward push is accepted; whether
force-with-lease is honoured; whether branch protection exists; whether objects are shared between fork and upstream, and what a
cross-repo fetch costs; forking a fork; readiness while `status: forking`; and the push event shape for forks.

## 8. Permissions and the mixed-version window

| Action | Who |
|---|---|
| Fork, push to own fork | Any human with a user token (`read_write`) or UI session; agents via service flows |
| Open/edit/close an MR | The author, or a maintainer (the DO re-checks; `principal.ts` `USER_WRITE_ROUTES`) |
| Review | Any actor except the author; profile actors via the internal tier only |
| Approval counts | Per policy: distinct actors, non-stale, author excluded (bootstrap marker excepted) |
| Merge / revert | `role='maintainer'` (live re-check, `index.ts:2261`) with the `maintainer` user-token scope or a UI session; `beehive-system` only executes a merge a maintainer queued (auto-merge), never decides. Master token = break-glass. |

`principal.ts:256` keeps promotions away from user tokens. A merge is a promotion decided by a human, so allowing
`POST …/merge` under `USER_MAINTAINER_ROUTES` is an explicit exception (question 4). Maintainer is global today. Per-repo roles
(`repo_members`) are a later slice (question 8).

**Mixed-version rules** (one push deploys all ten workers in no order):
- Additive, idempotent m13. A new DO route 404s on an old DO: the edge returns 503 "merge requests unavailable", never an
  empty list. New response fields are opt-in (`?include=mr`, `implicit`); new request fields (`commitSha` on a verdict) are
  retried without the field on a 400, as `withCandidateIds` does. A 404 from the sandbox `/test` route records `pending` and
  retries; it never passes.

## 9. API, UI, CLI and parity

- **API** (edge → DO): `POST/GET /api/merge-requests`, `GET/PATCH /api/merge-requests/:id`, `POST …/:id/{reviews,comments,
  merge,revert,close,reopen}`, `GET …/:id/status`; `GET/PUT /api/repositories/:id/{policy,review-profiles}`; `POST …/:id/forks`.
- **UI** (`/app`, server-rendered like the issue pages): `/app/:org/:repo/merge-requests` (list, new, detail with diff, review
  form, status checks, merge button showing `missing[]`), and `…/settings/policy`.
- **CLI:** `beehive mr create|list|view|review|merge|revert|close`, `beehive repo fork`, `beehive policy get|set`,
  `beehive profile create|list`.

| GitHub/GitLab feature | State |
|---|---|
| Issues, comments, close/reopen, labels | have (labels: missing) |
| Fork | partial: empty repo, native fork missing |
| PR/MR open, draft, close, reopen | missing |
| Diff view, per-line comments, suggestions | missing / missing / skip |
| Approve / request changes / required approvals | missing |
| Status checks (real CI) | missing: the gate is simulated (§6) |
| Merge: ff, merge commit, squash; rebase | missing; rebase: skip at first |
| Revert button; "Closes #n" auto-close | missing (§7; §10) |
| Branch protection / CODEOWNERS | missing (repo policy) / later |
| Same-repo PR branches; webhooks | skip (§2); skip |
| Notifications | missing (M10) |

## 10. Issue ↔ MR links and slices

**Links.** Reuse `issue_candidate_links` (`schema-inline.ts:245`). Its CHECK allows `reports-bug`, `requests-fix` and `linked`
only (`:249`), so `requests-fix` means "closes on merge" (no rebuild needed). `Closes #n` in the MR body creates that link at
open/edit time. Merge closes the issue with `closed_by` = the merger, in the merge transaction.

**Slice 1 (real gate, no new tables, nothing that writes to Artifacts):** the sandbox `/test` route, the npm-registry gateway, the
gate worker calling it, real verdicts, the simulated scoring deleted, and the §11 corrections. Tests: unit tests for the gateway
allow/deny (registry GET, any other host denied, POST denied, other Artifacts repo denied); a test-runner unit with a fake
container (pass, fail, timeout, log cap, missing lockfile → fail with a reason); a gate unit asserting no `Math.random` or hash
scoring is left; one local e2e with a fixture repo whose tests pass, then fail. A production canary run only with approval.

**Slice 2 (thin vertical MR):** m13 (merge_requests, mr_reviews, repo_policies, branch_refs, implicit spec, `gate_verdicts.commit_sha`),
native fork, MR open/list/view, human approve, policy "1 human approval + gate", ff-only merge via the sandbox, revert, the
`requests-fix` auto-close, the UI list/detail/merge, and CLI `mr create|review|merge`. Tests: migration matrix to m13; DO unit
tests for CAS on merge, stale approval after a new head, self-approval refused outside bootstrap, merge refused on any missing
item, the DO rejecting a forged `expectedHead`, revert restoring the head; mixed-version tests (old DO 404 → 503; new edge with an
old sandbox → `pending`); one local e2e covering fork → push → MR → gate → approve → merge → revert.

**Slice 3:** agent reviewer profiles (§5), line comments, squash/merge-commit, per-repo roles.

**Files** (S = spine, needs a human): `workers/spec-do/schema.sql`, `schema-inline.ts`, `index.ts` (m13 step, fresh path, MR,
review, policy, branch-ref routes, merge transaction) **S**; `workers/shared/mr-policy.ts` (evaluator) + tests;
`workers/shared/artifacts.ts` (`forkRepo` via the native API, the stale comment fixed); `workers/sandbox-runner/build-sandbox.ts`
(`/test`, registry gateway, merge-push job with a write-token gateway) **S** for the merge job; `workers/gate-workflow/index.ts`
(real verdicts, the review queue consumer) **S** for sequencing; `workers/queue-consumer/index.ts` (head moves → MR head + gate);
`workers/api/index.ts`, `principal.ts`, `ui-mr.ts` (new); `cli/src/commands/mr.ts`, `policy.ts`; wrangler: the queue for the
review queue (producer + `[[queues.consumers]]`); `docs/OPS.md`, `docs/ARCHITECTURE.md`, `README.md`, `docs/FOCUS.md`,
`docs/MILESTONES.md` (new milestone), `docs/OPEN-QUESTIONS.md`.

## 11. Public statements to correct (slice 1, before anything else ships)

- About page status table: "Quality gates … clone, test, check conformance, score complexity … **Live**"
  (`workers/api/index.ts:1180-1184`) → "Simulated" until slice 1 lands.
- About page narrative: "Each candidate runs in a sandbox: tests, property/fuzz checks, spec conformance, and a complexity-delta
  score" (`:1128-1130`) and the fast-lane text "It still has to clear the pre-merge gate (tests, lint, spec conformance)"
  (`:1100-1101`).
- `README.md:42` and `:251-252` ("Gate Workflow runs tests, records verdict"); `docs/ARCHITECTURE.md` §3 ("Run test suites",
  weighted scoring; "Workflows" although no `[[workflows]]` binding exists).
- Oracle-ladder "Pre-merge: tests, property/fuzz, spec conformance" rows (`index.ts:816-818`, `:1235-1237`): label as design.

## 12. Decisions needed from the maintainer

1. **Spec optional how?** Recommend the implicit per-repo spec (§1). Reject the table rebuild for a NULL `spec_id`.
2. **Gate first?** Recommend slice 1 = the real test gate plus the public corrections, before any MR table.
3. **Same-repo MR branches for maintainers?** Recommend no. Forks for everyone; `scratch/*` on upstream for maintainers only.
4. **Can a maintainer-scoped user token merge?** Recommend yes, as an explicit `USER_MAINTAINER_ROUTES` exception. Verdicts,
   trials and stage stay forbidden.
5. **Gate install policy and limits:** recommend a lockfile, `npm ci --ignore-scripts`, registry-only egress during install,
   and 120 s / 300 s / 600 s limits. Also: which instance type, and the account-wide concurrency cap?
6. **LLM key for reviewer agents:** recommend a key-injecting gateway with one allowed host. Which provider or AI Gateway, and
   what per-review cost cap?
7. **Real Cloudflare Workflows binding** for gate, merge and review jobs? Recommend later. Keep the gate-workflow worker plus a
   queue now (the deployment stays at ten).
8. **Maintainer scope:** keep the global role for slices 1-2 and add `repo_members` in slice 3? Recommend yes.
9. **Implicit-spec uniqueness:** recommend a check in code inside the transaction, not a partial unique index (unvetted
   construct, MIGRATION-LEGACY §4).
10. **Default merge method:** recommend ff-only in slice 2, and a revert commit (not a force reset) as the mirror of a ledger
    revert.
11. **m12 before m13 in separate pushes:** confirm, and re-run the `github_user_id` duplicate check before the m12 push.
