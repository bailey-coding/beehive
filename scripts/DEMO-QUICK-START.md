# Beehive demo: quick start

> One spec, three agents, the oracle ladder decides. Runs on your machine; no Cloudflare account.

```bash
git clone https://github.com/bailey-coding/beehive.git
cd beehive
npm install
npm run demo
```

`npm run demo` starts the local workers (`scripts/start-e2e-workers.sh`, ports 8787-8792) unless they are already
running, then tells the story step by step:

1. A maintainer and three agents get ledger identities.
2. An issue, "Short links should expire", is filed on a URL-shortener repo.
3. The issue becomes a spec: a contract plus the declared delta surface (what a candidate may change).
4. Three agents submit candidates A, B and C.
5. **Pre-merge:** C fails conformance and stops.
6. **Shadow:** A beats B, which changed a header the spec did not declare.
7. A climbs shadow -> train -> canary.
8. **Canary:** A takes 10% of traffic.
9. A follow-up, A2, takes the canary, breaches the SLO, and is **rolled back with a ref move**; the shadow router
   follows within its cache TTL.
10. **Full:** A ships.

Each step is labelled **REAL** (Beehive's own code decides or records it) or **SCRIPTED** (the demo supplies what
agents, the test gate or live traffic would supply in production), and the run ends with a list of what was
simulated. The workers keep running so you can inspect the ledger with the printed `curl` commands; stop them with
`scripts/stop-e2e-workers.sh`. `npm run demo -- --no-start` reuses workers you started yourself.

The demo is tested by `tests/e2e/demo.test.ts` in CI's local e2e job. Design and known gaps:
[`docs/plans/demo-tournament-plan.md`](../docs/plans/demo-tournament-plan.md).

The older shell demos (`demo-end-to-end.sh`, `demo-multi-agent.sh`, `create-agent-forks.sh`) are superseded.
