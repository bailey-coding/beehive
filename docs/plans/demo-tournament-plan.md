---
category: planning
status: implemented (rev 2, 2026-11-07)
audience: human,agent
---

# Plan: a watchable local tournament demo (`npm run demo`)

**Goal.** A newcomer with Node 22 and no Cloudflare account runs one command and watches Beehive's core idea happen:
an issue becomes a spec, three agents' candidates compete, the ladder picks a winner, a regression is rolled back
with a ref move, and the winner ships. Every step writes real records to the local ledger, and the terminal says
plainly which parts are real platform logic and which inputs the demo supplies.

**Why replace the old demo.** `scripts/demo-end-to-end.sh --local` is broken for a newcomer (verified 2026-11-07):
it starts `beehive` without `API_AUTH_TOKEN` (every call 503), starts the root worker again where it means the shadow
router and the comparator, calls a calculator `/api/calculate` that is not part of Beehive, and runs
`pkill -f "wrangler dev"` (kills every `wrangler dev` on the machine). It never touches the ledger or the ladder.

## The story

Labels: **REAL** = Beehive's own code decides or records it; **SCRIPTED** = the demo supplies the input that agents,
the test gate or live traffic would supply in production.

| # | Step | How | Label |
|---|---|---|---|
| 0 | Start the local workers | `scripts/start-e2e-workers.sh` (ports 8787-8792); `--no-start` reuses running ones | REAL |
| 1 | Actors: `demo-maintainer` (human), `agent-a`, `agent-b`, `agent-c` (agents) | `POST /api/actors` | REAL |
| 2 | Org `demo`, repo `shortener`, issue "Short links should expire" | `POST /api/organizations`, `/repositories`, `/issues` | REAL |
| 3 | The issue becomes a spec: contract + declared delta surface; linked to the issue | `POST /api/specs`, `/issue-spec-links` | REAL records, SCRIPTED contract |
| 4 | Three candidates, one per agent | `POST /api/candidates` (commit SHAs are placeholders: no agent writes code in the demo) | REAL records, SCRIPTED code |
| 5 | Pre-merge gate: A and B pass, C fails conformance (no expiry check) | `POST /api/gate-verdicts` | REAL records, SCRIPTED results (the gate is simulated today) |
| 6 | Shadow trial A vs B: A matches the declared delta surface, B diverges on an undeclared field | `POST /api/trials` | REAL record, SCRIPTED comparison |
| 7 | A climbs pre-merge -> shadow -> train -> canary | promotion worker `POST /promote` (only the trial winner; see rev 2) | REAL state machine |
| 8 | A goes to canary at 10% | canary worker `POST /deploy-canary` (preview-manager stub version, no Cloudflare API) | REAL deploy ref |
| 9 | Agent A ships a follow-up A2 to canary; its error rate breaches the SLO; rollback | `/deploy-canary` for A2, then `POST /rollback` | REAL ref move, SCRIPTED breach |
| 10 | A is promoted to full | `POST /promote` canary -> full | REAL |
| 11 | Summary: the ledger's view of what happened, and commands to inspect it | `GET` on candidates, verdicts, trials, promotions, deploy refs | REAL |

The demo prints one short paragraph per step: what happened, why it matters, and the label. It ends with "what was
simulated" in one list, pointing at `docs/REAL-GATE-IMPL-PLAN.md` and the canary-traffic note in `docs/MILESTONES.md`.

## Files

- `scripts/demo/tournament.ts`: the story as an exported `runDemo({ baseUrls, token, log })`, plus a CLI entry that
  starts the workers (unless `--no-start`), runs it and stops what it started. Uses `fetch`, checks `response.ok`
  on every call (AGENTS.md), sends `Authorization: Bearer` and `X-Actor-ID`. Unique names per run (suffix), so a
  second run never collides with the first (org names are Artifacts namespaces: `workers/shared/namespace.ts`).
- `package.json`: `"demo": "tsx scripts/demo/tournament.ts"` (tsx is already a dev dependency or added).
- `tests/e2e/demo.test.ts`: runs `runDemo` against the local workers and asserts the end state (A at `full`, the
  canary ref back on A after the rollback, C never past pre-merge). CI's local e2e job already starts the workers,
  so the demo cannot rot silently.
- Docs: `CONTRIBUTING.md` and `README.md` point at `npm run demo`; `scripts/DEMO-QUICK-START.md` rewritten for it.
- Old demo: `scripts/demo-end-to-end.sh`, `demo-multi-agent.sh`, `create-agent-forks.sh` get a header saying they are
  superseded and broken locally; deleting them is the maintainer's call.

## Rev 2 (implementation findings, 2026-11-07)

- **The tournament is not used to pick the winner.** Its scores come from `candidates.shadow_score`, which nothing
  writes, so it decides by arrival order (`docs/OPEN-QUESTIONS.md` 2026-11-07). Letting it "decide" would present
  arrival order as evidence. The shadow decision is the ledger trial (step 6); only A is promoted.
- **The shadow router caches deploy refs** (5 s TTL, worst case 2 x TTL). After the rollback the demo polls
  `/statsig/config` for up to 12 s and reports how long the router took to follow the ref move.
- **Workers are left running** after the demo, so the printed `curl` commands work; it prints how to stop them.
- **Runs under plain Node 22** (`--experimental-strip-types`), no new dependency. `npm run demo`.
- Two 500s for invalid create bodies found on the way (`docs/OPEN-QUESTIONS.md` 2026-11-07).

## To verify while implementing (all checked 2026-11-07)

- The exact request bodies for gate verdicts, trials and issue-spec links (zod schemas in `workers/shared/`).
- Whether `/promote` in tournament mode needs a second candidate in the same spec to complete, and what A's
  promotion record looks like afterwards (`docs/SETUP.md`: a tournament completes at two candidates).
- That `/deploy-canary` for A2 after A, then `/rollback`, moves the spec's canary ref back to A (the e2e test
  "should rollback a canary by moving the deploy ref" says yes).
- That the canary worker accepts candidate ids the demo creates (the Spec DO refuses `beehive-` ids and checks the
  canary URL; the stub mints it).

## Not in this version

- Watching it in the web UI: the local UI needs a GitHub sign-in. A local-only sign-in route is security-sensitive
  and gets its own plan. The demo prints the CLI commands to inspect the ledger instead.
- Real agents writing code, a real test gate, real traffic. The demo says so.
