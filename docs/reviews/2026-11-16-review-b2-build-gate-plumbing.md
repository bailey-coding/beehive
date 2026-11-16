---
category: audit
status: active
audience: human,agent
---

# Review, slice b2: build and gate plumbing (2026-11-16)

This is step 2 of the whole-repo review (context: `docs/reviews/2026-11-15-architecture-map.md`).
- An independent Fable agent made a read-only pass at `a4233c0`. Its probes wired the real queue consumer, the real gate handler and the real Spec DO together on node:sqlite, in a scratch worktree.
- The orchestrator confirmed two findings against the code:
  - **M1:** `actorId: 'queue-consumer'` (`workers/queue-consumer/index.ts:344`) refers to an actor that is seeded only when `DEV === 'local'` (`workers/spec-do/index.ts:709`).
  - **S1:** the consumer matches `r.remote_url === event.repository.full_name` (`:150`, `:301`), but `remote_url` is stored as a full git URL (`workers/shared/artifacts.ts:154`).
- No finding is fixed yet.

**Verdict: request changes.** The container isolation and the canary build path are sound and well tested: 47 of the 52 test-breaking edits were caught. The push-to-gate trigger path is not. Against a production-shaped ledger it cannot record a verdict. And the one enforced pre-merge rung is a simulated pass that any `read_write` user token can request.

## Must-fix

**M1. The queue-triggered gate cannot write a verdict outside local dev, because of a foreign key.** This is the gate side of b1 M2.
- `queue-consumer` sends `actorId: 'queue-consumer'`, and the gate writes that value as `decidedBy` (`gate-workflow/index.ts:950`).
- Probe (no dev seed): the gate answered 500 `Failed to record verdict`, the consumer retried, and `gate_verdicts` had 0 rows.
- Cause: the `queue-consumer` actor exists only in `spec-do/seed.ts:125`, which runs only in local dev. `createActor` generates its own ids, so the API cannot create an actor with that id.
- Effect in production: every push event runs the gate 5 times, then is dropped with a log line. The history write (`X-Actor-ID: queue-consumer`) would hit the same foreign key (inferred).
- History: OPEN-QUESTIONS 2026-10-19 "resolved" this by adding the seed row, which fixed local dev only.
- Tests miss it because `queue.test.ts` mocks both the gate and the Spec DO.
- Fix, together with b1 M2:
  - Have the Spec DO create the reserved actors (`queue-consumer`, `promotion-worker`) lazily, as it already does for `scientist-comparator`.
  - Add one test that wires the consumer, the gate and the Spec DO with no mocks.

## Should-fix

**S1. The repository match key only works in tests.**
- The consumer compares `remote_url` with `full_name`, but the ledger stores `remote_url` as `https://<account>.artifacts.cloudflare.net/git/<ns>/<name>.git`.
- Probe: the result was "no repository found", then a retry, and no gate call.
- Every test mocks `remote_url: 'test-ns/test-repo'`.
- Fix: match on `namespace` + `name` through a filtered Spec DO lookup. This also fixes S3.

**S2. The push message shape is an undocumented assumption with no producer.** (`queue-consumer/index.ts:32-57`)
- Nothing documents that Artifacts publishes `{event:{id,type:'push',repository,commit,ref,created_at}, received_at}`. The only senders are two scripts that build the message by hand.
- Any other envelope fails validation and is dropped on the first delivery. There is no dead-letter queue.
- Inferred: no real push has ever reached the gate this way, since M1 and S1 would both have shown up.
- Fix: record this in OPEN-QUESTIONS, then check the real event against a throwaway repo.

**S3. The 100-row lookups lose the oldest repositories.** (`queue-consumer/index.ts:136, 157, 280, 295`; `preview-manager/index.ts:434`)
- Both lists are newest first, and the consumer never pages past the first 100 rows.
- From the 101st repository on, a push to the oldest one retries for about 7.5 minutes and is then dropped.
- Fix: opt-in filters (`?namespace=&name=`, `?repositoryId=`), so old and new versions keep working during a deploy.

**S4. A simulated pass looks like a real one in the ledger, and any user can request one.** (`gate-workflow/index.ts:702-930`; `workers/api/principal.ts:269-270`)
- Probe: `POST /gates/pre-merge` with another spec's id and `commitSha: 'not-a-sha'` answered 201 `pass`, score 89. The notes say "Test score: 100.0/100" and `decided_by` is a real actor. `advance(shadow)` then accepted it as enforced pre-merge evidence.
- The gate checks neither that the candidate belongs to the spec nor that the sha is a commit.
- The edge route is in `USER_WRITE_ROUTES`, commented "Starts the real gate workflow". So any `read_write` user token can mint the enforced evidence.
- Fix, until the real gate lands:
  - prefix the notes with `[simulated]`;
  - reject a `specId` that is not the candidate's;
  - require a 40-hex sha;
  - correct the comment.

**S5. `/api/preview/deploy` writes a made-up preview to the ledger and reports success.** (`preview-manager/builds.ts:230, 268-285`; `index.ts:548-566`)
- The build stub builds nothing. The URL uses the account id instead of the workers.dev subdomain, so it cannot resolve.
- The Spec DO stores it, and the caller gets `success: true`.
- candidate-service `POST /api/candidates/:id/preview` also makes up a URL.
- Fix: answer 501 until a build exists, and delete the dead stubs (`builds.ts`, `artifacts.ts`, `createWorkersBuildsPreview`).

**S6. `PUT /api/candidates/:id/preview` ignores what its callers send.** (`spec-do/index.ts:4447-4455, 1753`)
- It stores only the URL, the worker name and the time. The `commitSha`, `baseCommitSha` and `buildId` it receives are dropped (probed).
- It writes before checking that the candidate exists, so a tombstoned candidate is written and then answered 404.
- No route validates `previewUrl`.
- Fix: a zod body and an existence check first, then either store the commit or stop sending it.

**S7. Failures reported as "not found" or as success.**
- candidate-service (`index.ts:524-536`) and preview-manager (`index.ts:411-413`) turn a Spec DO 5xx into "not found".
- In the gate's complexity check, a failed fetch returns delta 1.0, which scores 100/100. So a failure raises the score (`gate-workflow/index.ts:796-803`, no `Response.ok`).
- The edge gate route answers 200 whatever `result.status` is (documented). The CLI must read `result.status`.

**S8. Nothing writes `candidates.commit_sha`, so a claimed candidate cannot be canary-built.**
- `claimSpec` inserts `''`. preview-manager's `?? caller sha` doesn't fall back on `''`, so the bundle source answers 422 (inferred).
- The 2026-10-25 real canary used a candidate created with an explicit sha.
- Partly known: FOCUS asks "who writes `commit_sha`". The canary consequence is not recorded.
- The "ledger wins" precedence has no test (mutation survived).

**S9. Guards with no test** (each mutation left the suite passing):
- `versions.ts:186` `bindings: bundle.bindings ?? []`. This is what stops a candidate Worker from binding anything.
- The module-name regex in `bundle-source.ts:22`, which guards against path traversal in multipart part names.
- `score >= 80` in `gate-workflow/index.ts:916`. No test produces a `fail`.
- candidate-service's check for an existing preview. Its 16 tests assert on mocks.

## Nits

- **N1:** the legacy sandbox-runner routes return fake shas, and "push" fails at random 30% of the time. Nothing calls them; delete them.
- **N2:** the gate's sub-routes read a per-isolate map. `SANDBOX_RUNNER` and `ARTIFACTS` are declared but never bound. The file header claims a Cloudflare Workflow.
- **N3:** preview-manager's `queue` handler has no consumer config, and `findCandidateByRepo` reads a field the list never returns.
- **N4:** all three push queues trigger the gate, and the idempotency key includes the queue name, so one push published to two queues runs the gate twice. The planned `isProductionPush` guard is not in the code.
- **N5:** `baseCommitSha` is set equal to the head commit (`queue-consumer/index.ts:337`).
- **N6:** candidate-service `/health?previewUrl=` fetches any URL. Only the master token reaches it, but it is still SSRF; use the ledger value instead.
- **N7:** the sandbox instance name uses 8 hex characters of the sha, so two commits with the same prefix serialize. Correct, only slower.
- **N8:** `shared/artifacts.ts` defaults the token scope to `write`. Make `scope` required.
- **N9:** OPS says the runner mints 5-minute read tokens. In the code, the Durable Object mints them, with a lifetime of 240 s for builds and 300 s for tests.

## Security assessment: verified correct

- **Credential:** the platform token stays in the Durable Object, and the container gets no token. A read-scoped, single-repo token lives only in the gateway.
- **Network:** `enableInternet: false`. The gateway allows only git upload-pack on the one repo, keeps a 5-header allowlist and refuses redirects.
- **Clone:** no hooks, no symlinks, no global git config.
- **Build:**
  - esbuild only, with no `npm install`;
  - a 60 s timeout, a 150 s deadline with an alarm backstop, and a 1 MiB cap;
  - the container is destroyed on every path.
- **Test sandbox:** `--ignore-scripts`, `.npmrc` removed, deny-all networking. It still has no production caller.
- **Upload:**
  - The Worker name must be `beehive-candidate-<uuid>`, and platform names are reserved.
  - No bindings or flags are uploaded. That is why S9's first item matters.
- **Namespace echo:** preview-manager always sends the ledger namespace and refuses an answer that doesn't echo it. The runner builds whatever namespace it is told. So slice a S6 holds as written: a user-registered repository row naming another organization's namespace gets built. The fix belongs in the Spec DO.
- **`/api/preview/canary`:** canary-worker checks `Response.ok`, `url` and `versionId`.
- **Idempotency:**
  - The key is `<queue>:<event id>:gate`.
  - A duplicate replays only after the Spec DO confirmed the verdict, and answers 409 while the first run is in flight.
  - On a new isolate the gate re-runs, but the Spec DO key keeps the first verdict.
- **Retries:** the classification matches OPS, and `max_retries = 4` matches `MAX_ATTEMPTS = 5`.

## Known items re-checked

- **OPEN-QUESTIONS 2026-11-10** (the gate `actorId` is not an actor): still true, and wider. `queue-consumer` has the same defect (M1).
- **OPEN-QUESTIONS 2026-10-19** (resolved by the seed actor): not resolved outside local dev.
- **OPS "Idempotency and queue retries":** still true. The gate is simulated, there is no dead-letter queue, and an unknown repo retries for 7.5 minutes.
- **REAL-GATE-IMPL-PLAN section 0:**
  - Fixed: the swallowed consumer errors, the unchecked verdict write, the missing edge DO route.
  - Still true: the serial batch, the all-queues trigger, and `baseCommitSha` set to the head commit.
- **FOCUS** (no writer for `commit_sha` or `passed_premerge`): still true (S8).
- **Architecture map section 5** (dead routes and bindings in this slice): confirmed.

## What was run

- `npx vitest run` on the five workers: 265 of 265 passed.
- `npm run typecheck`: clean.
- A 4-case probe wiring the real consumer, gate and Spec DO.
- 52 test-breaking edits: 47 caught by a test, 5 not (S8, S9).
- Not run: e2e, any worker, any container, the network. S2, S8's 422 and the history foreign key in M1 are inferred from the code.
