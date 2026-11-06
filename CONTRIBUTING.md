# Contributing to Beehive

Thanks for looking. This page is for **people**. If you are an AI agent, read [`AGENTS.md`](AGENTS.md) instead:
it has the rules agents must follow, and they are stricter than the ones here.

---

## What Beehive is, in one minute

Beehive is an experiment in version control for a world where agents write most of the code. Several agents
implement the same machine-readable **spec** independently; each implementation (a **candidate**) climbs an
**oracle ladder** (tests, then mirrored shadow traffic, then a small live canary) and the one that clears every
rung is promoted. Rollback is a ref move, as cheap as promotion. It runs on Cloudflare Workers, Durable Objects
and Artifacts. The [README](README.md) tells the story; [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) has the design.

### What is real today, and what is not

Honest status, so you know what you are walking into (details in [`docs/MILESTONES.md`](docs/MILESTONES.md)):

| Real and running | Simulated or not built yet |
|---|---|
| Spec Durable Object ledger: orgs, repos, specs, candidates, trials, issues, audit history | The pre-merge gate: test results are placeholders ([`docs/REAL-GATE-IMPL-PLAN.md`](docs/REAL-GATE-IMPL-PLAN.md)) |
| Web UI with GitHub sign-in, issue pages, API tokens; read-only sign-in for non-members (off by default) | Canary SLOs read mirrored shadow traffic, not real canary traffic |
| CLI (`cli/`) with user tokens | The "semantic" search, changelog and commit views are mocked |
| Shadow traffic mirroring and the Scientist comparator | The merge-request flow ([`docs/MR-FLOW-PLAN.md`](docs/MR-FLOW-PLAN.md)) |
| Canary deploy and automatic rollback as ref operations; candidate builds in a sandbox container | Governance: approvals and the two-person rule ([`docs/M5A-2-GOVERNANCE-PLAN.md`](docs/M5A-2-GOVERNANCE-PLAN.md)) |

---

## Get it running (no Cloudflare account needed)

You need **Node.js 22+** and git. Everything below runs locally against Miniflare; nothing touches Cloudflare.

```bash
git clone https://github.com/bailey-coding/beehive.git
cd beehive
npm install                # what CI uses
(cd cli && npm install)    # the CLI tests run the CLI through its own tsx

npm run typecheck
npm test                   # ~2,000 unit tests, about a minute; this is what CI runs
```

To run the end-to-end suite against real local workers (real HTTP, no mocks):

```bash
scripts/start-e2e-workers.sh   # starts six local workers on ports 8787-8792; no .dev.vars needed
npm run test:e2e:local
scripts/stop-e2e-workers.sh
```

More detail, ports and troubleshooting: [`docs/SETUP.md`](docs/SETUP.md) and [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).
Deploying your own copy needs a Cloudflare account with Artifacts access: [`docs/SETUP.md`](docs/SETUP.md) section 2.

---

## Ways to help

- **Pick up a starter task.** Beehive tracks its own work in Beehive: the starter issues (labelled
  `good first issue`, each saying how to check you are done) are on
  [`beehive/beehive`](https://beehive.bz23711.workers.dev/app/repos/beehive/beehive/issues). Signing in there is
  limited to contributors for now (read-only sign-in for everyone is built but not switched on yet); until it is,
  open a GitHub issue saying what you would like to work on and we will add you or point you at one.
- **Report what confused you.** If setup failed or a doc was wrong, that is a bug: open an issue with the
  "Bug report" template. Fresh eyes are the only way we find these.
- **Propose a spec.** Beehive is about specs that several implementations compete on. Got a small, stateless
  service in mind (a URL shortener, a price calculator)? Use the "Spec proposal" template.
- **Improve the docs.** [`docs/README.md`](docs/README.md) is the index; finished records are in
  [`docs/archive/`](docs/archive/README.md) and do not need editing.
- **Look at open findings.** [`docs/OPEN-QUESTIONS.md`](docs/OPEN-QUESTIONS.md) lists known problems, each with a status.

---

## Making a change

1. **Fork and branch.** Never push to someone else's branch. (Beehive's rule is "fork, don't contend".)
2. **Keep it small.** One change per pull request. If it touches several workers or the Spec DO schema,
   open an issue first and describe the plan; the ledger, promotion train and workflow sequencing are
   the "spine" and get a written plan and an extra review before code.
3. **Run the checks** before you push: `npm run typecheck` and `npm test`. `npm run lint` currently reports
   6 known errors on `main` and CI does not run it yet (fixing both is a good first task); just add no new ones.
4. **Open a pull request** and say what you changed and how you checked it. For code changes CI runs the
   same checks plus the local e2e suite; a docs-only pull request runs just the Markdown link check.

**Things that bite** (each happened at least twice):
- Check `response.ok` on every fetch to the Spec DO or another worker. A 404 is an error, never "empty".
- One push deploys all ten workers in no fixed order, so every change must work while old and new
  versions run side by side: additive schema changes, callers that cope with an old or new peer.
- In `wrangler.toml`, service bindings use `binding = "..."`, never `name = "..."`; queue consumers
  use `[[queues.consumers]]`.

**Never** run `wrangler deploy` (a `--dry-run` is fine) or run e2e against production. Deploying is
the maintainer's job ([`docs/OPS.md`](docs/OPS.md)).

### Commit messages

Write a clear message in your own words; that is enough for people. Agents must use the structured format
below, and you are welcome to use it too:

```
step: <what changed> | task: <id or area> | spec: <doc or clause, or n/a> | confidence: <0-1>
```

---

## Getting help

- **Questions and ideas:** open an issue. Search first: the answer may be in `docs/` (try `docs/README.md`).
- **Security problems:** please do not open a public issue. Contact the maintainer,
  [bailey-coding](https://github.com/bailey-coding), privately first.
- **Conduct:** everyone here follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
