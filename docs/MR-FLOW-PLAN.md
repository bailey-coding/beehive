---
category: planning
status: accepted-with-changes
audience: human,agent
---

# Plan: issue → fork → merge request → review → merge (spec trials optional per repo)

**Status:** plan only, branch `agent/mr-flow-plan`. Rev 2, 2026-10-26: review "approve with changes" folded in (B1-B3 and
the factual fixes), and the 11 decisions in §13 were accepted by the maintainer. Nothing is implemented. Items marked
**[SPINE]** (spec schema, DO ledger, promotion train, Workflow sequencing; AGENTS.md rule 2) need the maintainer.

## 1. Decision

The direction: the normal issue + MR flow is the baseline, competing spec candidates are an optional per-repo alternative, and
everyone forks. **Confirmed:** one ledger and one promotion path. An MR is a `candidates` row with a 1:1 `merge_requests` row,
so verdicts, trials, promotions, deploy refs, issue links and purge keep working. **Rejected:** a nullable
`candidates.spec_id`. Instead each repository gets an *implicit spec*. Reasons:
1. SQLite cannot drop `NOT NULL` in place (`workers/spec-do/schema-inline.ts:108`); a rebuild touches the four tables that
   reference `candidates` (`gate_verdicts` `:142`, `trials` ×3 `:165-167`, `promotions` `:187`, `issue_candidate_links`
   `:252`) and legacy column sets, and `docs/MIGRATION-LEGACY-TEST-PLAN.md` §4 allows only `table_info`/`ADD COLUMN`/`CREATE
   IF NOT EXISTS`.
2. Peers require `specId` as a string, so a NULL fails them in the mixed-version window: a uuid at
   `workers/gate-workflow/index.ts:38`, `scientist-comparator/types.ts:60`, `preview-manager/types.ts:235`;
   `z.string().min(1)` at `workers/shared/promotion-ledger.ts:25`.
3. Everything keyed by spec (trials, `deploy_refs (spec_id, rung)` `schema-inline.ts:557`, tournaments, trains) works
   unchanged for "the repository's mainline" spec.

Users still see the spec as optional: the API returns `specId: null, implicit: true` (opt-in, §9), and implicit specs are hidden
everywhere (§3).

**Prerequisite: the pre-merge gate is simulated.** Tests are a comment (`workers/gate-workflow/index.ts:615-622`), the
complexity score is a hash of the candidate id (`:725`), the conformance warning is `Math.random() < 0.1` (`:789`), the sandbox
clone only logs (`workers/sandbox-runner/index.ts:371-374`), and the verdict POST ignores `Response.ok` (`:865-875`). The only
real sandbox work is the canary build. A real test gate is slice 1 (§7); every existing `gate_verdicts` row is synthetic.

## 2. Flow and forks

Issue → contributor forks the target (Artifacts native fork) → pushes a branch to the fork → opens an MR → the gate runs on every
new head sha → humans (and agent profiles, per policy) review a specific sha → a maintainer merges once the policy is met. The
merge is a ledger ref move, and the Artifacts branch mirrors it.
- **Fork per contributor, maintainers included.** Rule 3 is unchanged. MR sources are forks only. Maintainers may push
  `scratch/*` to upstream, for the always-pushed invariant. GitHub same-repo PRs are listed as "skip".
- Native fork: `POST …/repos/:name/fork` and `repo.fork()`. Forks stay in the source namespace, so MR source and target are in
  the same org. Today `createFork` creates an empty repo, and its comment (`workers/shared/artifacts.ts:125`) is stale
  (`docs/OPEN-QUESTIONS.md` 2026-10-26).
- Lineage: new `repositories.forked_from_repository_id`. Forks keep `repo_type 'candidate'`: a `'fork'` value in the CHECK
  (`schema-inline.ts:49`) would need a rebuild.

## 3. Data model and migrations [SPINE]

**Numbering.** The code is at `m12` once `agent/m12-actors-unique` merges (`workers/spec-do/index.ts`, `LATEST_SCHEMA_VERSION`); before that it is `m11`.
m12 is the unique index on `actors.github_user_id`, which refuses on duplicates (`workers/spec-do/tests/migration-actors-unique.test.ts`; `docs/OPS.md` step 1a).
Plan: m12 goes first, in its own push. The 2026-10-26 production check found no duplicates among 3 actors; re-run it just before
that push (`scripts/check-actor-duplicates.sh`). Then **m13** = slice 1 (gate runs, preview fix) and **m14** = slice 2 (MR tables), one push each. If m12 slips, m13
and m14 renumber down. They do not depend on its content, only on order. A stored version newer than the code skips migrations
(the rollback floor in `runMigrations`), so rolling back degrades instead of failing.

**Rules.** Every change is `ADD COLUMN` through `addColumnsIfMissing` (idempotent via `PRAGMA table_info`, `index.ts:1112-1117`)
or `CREATE … IF NOT EXISTS`, and the same DDL goes into `SCHEMA_SQL`. The **preview gap** is not fixed by the fresh path:
fresh ledgers already stamped m11 never re-run `initSchema`. So the m13 step also runs `addColumnsIfMissing('candidates',
[preview_url, preview_worker_name, preview_created_at])`, and the `it.fails` pin
(`workers/spec-do/tests/migration-matrix.test.ts:53`) flips to `it`.

| Version / object | Shape (summary) |
|---|---|
| m13 `gate_runs` | `id`, `candidate_id` FK, `gate`, `commit_sha` NOT NULL, `attempt`, `status` CHECK(running, pass, fail, error, not_run), `runner`, `image_digest`, `tests_passed`, `tests_failed`, `duration_ms`, `log_key`, `log_sha256`, `decided_by`, `started_at`, `finished_at`. UNIQUE(candidate_id, gate, commit_sha, attempt). |
| m14 `specs.kind` | NULL = explicit, `'implicit'` |
| m14 `repositories` + cols | `implicit_spec_id`, `forked_from_repository_id`, `policy_version` |
| m14 `merge_requests` | `id`, `candidate_id` UNIQUE FK, `number` (per target repo, MAX+1 like issues `index.ts:1796`), `target_repository_id`/`source_repository_id` FK, `target_branch`, `source_branch`, `title`, `body`, `status` CHECK(open, closed, merging, merged), `is_draft`, `author_id`, `head_sha`, `base_sha`, `merge_method`, `merged_ref_id`, `merged_by/at`, `closed_by/at`, `version` (CAS), timestamps, tombstone cols |
| m14 `mr_reviews` | append-only: `merge_request_id` FK, `reviewer_id`, `profile_id`/`profile_version` (NULL = human), `verdict` CHECK(approve, request_changes, comment), `commit_sha`, `rationale`, `session_url`, `self_review`, `created_at`. The latest row per reviewer counts; a review is stale when its sha ≠ `head_sha`. |
| m14 `repo_policies`, `review_profiles` | immutable versions, UNIQUE(repository_id, version) and UNIQUE(repository_id, name, version). Policy: `flow` CHECK(mr, spec, both), `required_approvals`, `required_human_approvals` (≥1, enforced by the DO), `agent_profiles` (pinned id@version), `dismiss_stale`, `allow_self_approval`, `gate` JSON, `ladder` JSON, `merge_methods`. Profile: `actor_id` (agent), `model`, `personality`, `prompt_sha256` + R2 key, `max_cost_usd`, `retired_at`. |
| m14 `branch_refs` | modelled on `deploy_refs`: `repository_id`, `branch`, `commit_sha`, `prev_ref_id` UNIQUE, `action` CHECK(init, merge, revert, sync), `merge_request_id`, `moved_by/at`. No FKs. The Artifacts branch is a mirror. |
| slice 3 `mr_comments` | `merge_request_id` FK, `review_id`, `path`, `line`, `commit_sha`, `body`, `created_by/at` |

**Re-runs (B1).** `gate_verdicts` has UNIQUE(candidate_id, gate) (`schema-inline.ts:144`), and `createGateVerdict` is a plain
INSERT (`index.ts:1594`). A second run throws today, and the gate drops the error unseen. From m13:
- every run inserts a `gate_runs` row: a new head sha starts at attempt 1, a re-run of the same sha is attempt+1;
- in the same transaction, `gate_verdicts` becomes the latest-summary row, written with `ON CONFLICT(candidate_id, gate) DO
  UPDATE` (a code change, not a schema change), so existing readers keep working;
- merge checks read only the latest finished `gate_runs` row for (`candidate_id`, gate, `head_sha`).

Old `gate_verdicts` rows have no run and never satisfy a merge.

**Implicit spec (B2).** It is created lazily by the first MR. `UPDATE repositories SET implicit_spec_id = ? WHERE id = ? AND
implicit_spec_id IS NULL` is a compare-and-set, the same pattern as `repositories.spec_id` (`:50`). If no row changes, the
transaction rolls back the new spec row and uses the existing one. No partial unique index.
- The DO refuses `kind='implicit'` on the generic routes that `USER_WRITE_ROUTES` opens to users
  (`workers/api/principal.ts:261-276`): `PATCH /api/specs/:id/stage`, `POST /api/specs/:id/claim`, `POST /api/candidates`,
  `POST /api/issue-spec-links`, and `POST /api/issue-candidate-links` when the candidate's spec is implicit. MR routes create
  those rows themselves.
- Hidden by default (`?includeImplicit=1` shows them): `listSpecs` (`index.ts:4534`), the UI
  (`workers/api/ui-pages.ts:166,314,810,986,1189,1316`, `ui.ts:411,491`) and CLI `spec list`.

**Purge order (B2).** `ORG_PURGE_ORDER` (`index.ts:116`) deletes children first. Insert after `trials` and before `issues`:
`mr_comments` → `mr_reviews` → `merge_requests` → `gate_runs` → `branch_refs` → `review_profiles` → `repo_policies`, each scoped
through `ORG_REPOS`/`ORG_CANDIDATES`. Repositories go before specs, which is safe for `implicit_spec_id`. MR history uses
`entity_type 'candidate'`, because `merge_request` is not in the CHECK (`schema-inline.ts:12`). Tests: the migration matrix
to m14 (A1-A4), m13/m14 legacy-shape cases, `schema-sync.test.ts`, and a purge over an org with MRs, reviews, runs and refs.

## 4. Repo policy and reviewer profiles [SPINE: the check at merge time]

A pure evaluator, `workers/shared/mr-policy.ts` (a leaf, agent-writable), maps (policy, reviews, runs, head) to
`{mergeable, missing[]}`. The DO runs it **inside the merge transaction** against the MR's recorded policy version, and the UI
shows the same `missing[]`.

| Shape | Settings |
|---|---|
| Human only (default) | `required_human_approvals=1`, no profiles, `pre-merge` run must pass at `head_sha` |
| Agent reviewers | `agent_profiles=[security-strict@v2, perf-skeptic@v1]`. An agent `request_changes` blocks. Agent approvals may count toward `required_approvals`, but `required_human_approvals ≥ 1` always applies (B3). |
| Approvals | distinct, non-stale, author excluded; self-approval only with `allow_self_approval` (bootstrap, M5a), stored as `self_review=1` |
| Full ladder | `ladder=[pre-merge, shadow, train, canary]`, each passed at `head_sha`. `flow=spec` keeps today's trials for explicit specs. |

Profiles are repo-scoped and immutable: an edit creates `version+1`. Each review pins id@version (model, personality, prompt
hash). The personality is a short focus brief, never code.

## 5. Reviewer-agent execution (slice 3)

1. An MR opens or its head moves (a queue-consumer push event on the fork).
2. After the DO commit, `{mrId, headSha, profileId, version}` goes onto the new queue `beehive-review-requests`. Its consumer is
   the gate-workflow worker, so we stay at ten workers.
3. The sandbox runner starts a container with no Internet. It clones the fork at `headSha` (read gateway,
   `workers/sandbox-runner/build-sandbox.ts:135`) and calls the model through a gateway entrypoint that injects the key for one
   host. The key never enters the container.
4. The consumer writes the review through a narrow DO route (§6), keyed by `(mrId, headSha, profileId, version)` in
   `idempotency_keys`.

Constraints:
- Never in a request path, never Paseo spawning from Workers, no `[[workflows]]` binding (decision 7).
- Profile actors are `agent` and cannot hold user tokens (`SpecDO.mintUserToken`, humans only). The same holds for
  `beehive-system`.
- The queue must exist (a maintainer creates it) before the push that adds its producer and `[[queues.consumers]]` binding.

## 6. Reviewer-agent threat model (B3; must be written and accepted before slice 3)

| Threat | Control |
|---|---|
| Prompt injection from MR content (diff, title, body, comments) | Agents can never approve on their own (`required_human_approvals ≥ 1`, which the DO refuses to set to 0); their worst outcome is a block. MR text is passed as data with delimiters, and the instructions come only from the pinned profile prompt. |
| Hostile model output | Strict zod schema (verdict enum, rationale ≤ 8 KiB, no URLs outside `session_url` allow-list). The DO rejects anything else. Rationale is stored as text and HTML-escaped on every render (UI, CLI, API). |
| Runaway cost | `max_cost_usd` enforced in the key-injecting gateway by counting tokens per request and per review; the gateway cuts the stream at the cap. The model's own limits are never trusted. Hard cap from day one. |
| Code execution | The reviewer container never runs MR code: read-only clone, no install, no hooks, no build. Only the gate container (§7) runs code, and it has no secrets. |
| Hooks in the merge job | `core.hooksPath=/dev/null`, `-c protocol.file.allow=never`, no submodule recursion, symlinks disabled (as in the build path). |
| Forged reviews | Not the tier-1 internal token (`workers/shared/spec-do-auth.ts:6`, which reaches every DO route). A dedicated route `POST /internal/mr-reviews` accepts only a row whose `reviewer_id` is the profile's actor, whose profile is in the MR's pinned policy, and whose `headSha` is the MR's current or previous head; it refuses everything else (decision 14). |
| Provider choice | the maintainer's call (decision 6); transcripts redacted before R2 (M7) |

## 7. Real test-running gate (slice 1) [SPINE: sequencing]

The gate builds on the canary build path (`docs/SANDBOX-BUILD-PLAN.md`). Starting limits were accepted in decision 5.
- **Clone:** `ArtifactsGateway` as it is: the token stays in props, only `git-upload-pack` on one repo, exact 40-hex checkout,
  symlinks off. Slice 1 tests the head in the fork. Testing the merge result needs two read-only repos and comes in slice 2.
- **Install:** a lockfile is required. `npm ci --ignore-scripts` runs with egress only to `registry.npmjs.org` (GET), through a
  second intercepting gateway entrypoint. npm must trust the Cloudflare CA at `build-sandbox.ts:82` (`NODE_EXTRA_CA_CERTS`).
  The test phase has no network. An R2 dependency cache keyed by lockfile hash comes later.
- **Command:** taken from `repo_policies.gate` (in slice 1, a constant per repo held in the gate's config, default
  `npm test`). No secrets in env, non-root, and the repo never picks the image.
- **Limits:** install 120 s, test 300 s, whole run 600 s, with the existing destroy-on-every-path and alarm. The log tail is
  capped at 64 KiB in R2, its hash recorded in `gate_runs`. The instance is **`standard-1` or larger**: `lite`
  (`build-sandbox.ts:340`, 1/16 vCPU, 256 MiB) cannot run `npm ci` plus tests. Set a **`max_instances`** cap in
  `workers/sandbox-runner/wrangler.toml` (none today) plus a per-repo concurrency limit in the gate.
- **Verdict:** a `gate_runs` row, plus the summary upsert (§3). The status comes from the exit code, with real counts and
  `notes` = {runner, image digest, durations, log key}. The hash score (`:725`) and the random warning (`:789`) are deleted, not
  kept as fallbacks. With no conformance check the result is `not_run`, never pass. `generateId` (`:183`, `Math.random`) becomes
  `crypto.randomUUID()`, so the "no random scoring" test can assert that the scoring functions are gone without tripping on ids.
- **Wiring:** push → queue consumer → gate → sandbox runner `POST /test` (new) → DO `POST /api/gate-runs` (new, checks
  `Response.ok`). The gate only reads from Artifacts.

## 8. Merge semantics in Artifacts [SPINE: ledger + sequencing]

Artifacts has no documented server-side merge, compare or ref-update API; refs move over git only. So:
1. **The DO reserves.** `POST /api/merge-requests/:id/merge {method, expectedHead}` checks the permission and runs the policy
   evaluator at `head_sha`. It sets `merging` (CAS on `version`) and records the expected target head from `branch_refs`.
2. **The sandbox merges.** It clones the target at the ledger head and fetches the fork at `head_sha`, then merges ff-only
   (decision 10), hooks disabled (§6). It pushes with a short-lived write token held by the gateway, using
   `--force-with-lease=<branch>:<expected>`.
3. **The DO commits,** in one `transactionSync`: a `branch_refs` row (CAS on `prev_ref_id`), MR `merged`, candidate
   `promoted`, and linked issues closed.

The push happens before the ledger records anything (always pushed). If step 3 fails after a successful push, a reconcile step
compares Artifacts `log(ref)` with the ledger head before the next merge. On mismatch it refuses and alarms; it never adopts the
Artifacts state. A revert inserts a `revert` row, and the mirror gets a revert commit, never a force reset (rule 7). Unknowns go
to OPEN-QUESTIONS 2026-10-26: non-ff push, lease, protection, object sharing, fork events.

## 9. Permissions and the mixed-version window

| Action | Who |
|---|---|
| Fork, push to own fork, open/edit an MR | any human with a `read_write` user token or a UI session; edits by the author or a maintainer (DO re-check) |
| Review | any actor except the author; profile actors only via `/internal/mr-reviews` |
| Merge / revert | `role='maintainer'` (live check `index.ts:2261`) with the maintainer user-token scope (decision 4: `USER_MAINTAINER_ROUTES` exception; verdicts, trials and stage stay forbidden) or a UI session. `beehive-system` only executes a merge a maintainer queued. Master token = break-glass. |

**Mixed pairs.** Edge, DO and UI are one worker (`workers/api/wrangler.toml:16,31`, `index.ts:80`), so "new edge with an old
DO" cannot happen. The real pairs are among `beehive`, `gate-workflow`, `sandbox-runner` and `queue-consumer`:
- **New gate, old `beehive`:** `POST /api/gate-runs` 404s. The gate records nothing, logs it and retries via the queue; it
  never passes. Do not send `commitSha` to the old verdict route expecting it to be stored: that route is not zod-validated
  (`index.ts:4010`) and drops extra fields silently.
- **Old gate, new `beehive`:** the old gate's simulated verdicts land in `gate_verdicts` only, so they never satisfy a merge.
- **New gate, old sandbox:** `/test` 404s → `running` times out → `error`, then retry. Never pass.
- **Opt-in response fields** (`?include=mr`, `implicit`), because strict zod rejects unknown fields.

## 10. API, UI, CLI and parity

- **API:** `POST/GET /api/merge-requests`, `GET/PATCH …/:id`, `POST …/:id/{reviews,comments,merge,revert,close,reopen}`,
  `GET …/:id/status`, `GET/PUT /api/repositories/:id/{policy,review-profiles}`, `POST …/:id/forks`, `POST /api/gate-runs`.
  Route lists live in `workers/api/principal.ts`.
- **UI:** `/app/:org/:repo/merge-requests` (list, new, detail with diff, review form, checks, merge button showing
  `missing[]`), and `…/settings/policy`.
- **CLI:** `mr create|list|view|review|merge|revert|close`, `repo fork`, `policy get|set`, `profile create|list`.

| GitHub/GitLab feature | State |
|---|---|
| Issues, comments, close/reopen / labels | have / missing |
| Fork | partial (empty repo; native fork missing) |
| PR open, draft, close, reopen; diff; line comments | missing (line comments slice 3); suggestions: skip |
| Approve / request changes / required approvals | missing |
| Status checks (real CI) | missing: the gate is simulated (§7) |
| ff / merge commit / squash / rebase | missing (ff slice 2, others slice 3) / skip at first |
| Revert; "Closes #n" | missing (§8; §11) |
| Branch protection / CODEOWNERS | missing (repo policy) / later |
| Same-repo PRs; webhooks; notifications | skip (§2); skip; missing (M10) |

## 11. Issue links, slices and files

**Links:** `issue_candidate_links` with `requests-fix` meaning "closes on merge" (the CHECK at `schema-inline.ts:249` allows
nothing better without a rebuild). `Closes #n` in the MR body creates the link, and the merge closes the issue in the same
transaction.

**Slice 0:** m12 (actors index), already decided and stubbed.

**Slice 1 (m13, real gate, no Artifacts writes):** `gate_runs`, the preview columns, sandbox `/test`, the registry gateway, the
real gate, the §12 corrections. Tests: gateway allows registry GET and denies other hosts, POST and other repos; runner with a
fake container (pass, fail, timeout, log cap, missing lockfile, `standard-1` requested); DO re-run of the same sha → attempt 2
with the summary updated, new sha → new row, old route intact; no hash or random scoring left; a DO non-2xx surfaces as an error;
matrix to m13; local e2e with a fixture repo whose tests pass, then fail. A production run needs approval.

**Slice 2 (m14, thin MR):** native fork, MR open/list/view, human approve, the default policy, ff merge via the sandbox, revert,
auto-close, the implicit-spec guards and hiding, purge order, UI, and CLI `mr create|review|merge`. Tests: DO CAS on merge,
stale approval after a new head, self-approval refused outside bootstrap, merge refused per missing item, forged `expectedHead`
refused, revert, implicit spec refused on stage/claim/candidates/links, one implicit spec under concurrent first MRs, purge of
an org with MRs; the mixed pairs (§9); local e2e fork → push → MR → gate → approve → merge → revert.

**Slice 3:** threat model accepted (§6), the review queue created, reviewer profiles, line comments, squash/merge commit,
per-repo roles.

**Files** (S = spine): `workers/spec-do/schema.sql`, `schema-inline.ts`, `index.ts` (m13/m14, `gate_runs`, MR, review and ref
routes, merge transaction, purge order, implicit guards) **S**; `workers/shared/mr-policy.ts` + tests;
`workers/shared/artifacts.ts` (native fork); `workers/sandbox-runner/build-sandbox.ts`, `wrangler.toml` (`/test`, registry
gateway, instance type, `max_instances`, merge job **S**); `workers/gate-workflow/index.ts` (real runs, review consumer **S**);
`workers/queue-consumer/index.ts`; `workers/api/index.ts`, `principal.ts`, `ui-pages.ts`, `ui.ts`, `ui-mr.ts` (new);
`cli/src/commands/{mr,policy,spec}.ts`; docs: `OPS.md`, `ARCHITECTURE.md`, `ARTIFACTS-SETUP.md` (fork section), `README.md`,
`FOCUS.md`, `MILESTONES.md`, `OPEN-QUESTIONS.md`.

## 12. Public statements to correct (slice 1, first)

- About page status table, "Quality gates … clone, test, check conformance, score complexity … **Live**"
  (`workers/api/index.ts:1180-1184`) → "Simulated". The narrative at `:1128-1130` and the fast-lane text at `:1100-1101` change
  to match.
- `README.md:42` and `:251-252`; `docs/ARCHITECTURE.md` §3 ("Run test suites", weighted scoring, "Workflows" although no
  `[[workflows]]` binding exists).
- The oracle-ladder "Pre-merge: tests, property/fuzz, spec conformance" rows (`index.ts:816-818`, `:1235-1237`): label as
  design.

## 13. Decisions

**Accepted 2026-10-26** (as recommended): (1) implicit per-repo spec, no rebuild; (2) real gate first; (3) no same-repo MR
branches; (4) a maintainer-scoped user token may merge; (5) gate install policy and limits as a starting point, instance
`standard-1`+ with a `max_instances` cap (numbers to confirm); (6) reviewer key gateway, provider = the maintainer's call, hard
per-review cost cap from day one; (7) no Workflows binding yet; (8) global maintainer role until slice 3; (9) uniqueness by
compare-and-set; (10) ff-only merges, revert commits; (11) m12 before m13, separate pushes.

**Still needed:**
12. Numbering as in §3 (m12 actors index, m13 gate, m14 MR)? Recommend yes; renumber down only if m12 is dropped.
13. Agent approvals: count toward `required_approvals` with a human floor of 1 (recommended), or block-only?
14. Accept the narrow `/internal/mr-reviews` route checked against the profile actor (recommended) over a new token tier?
