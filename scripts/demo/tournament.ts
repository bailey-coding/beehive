/**
 * `npm run demo`: watch Beehive's core idea run on your machine, no Cloudflare account needed.
 *
 * An issue becomes a spec, three agents' candidates compete, the oracle ladder picks one, a regression is rolled
 * back with a ref move, and the winner ships. Every step writes real records to the local ledger (the Spec Durable
 * Object). Each step says which part is REAL (Beehive's own code decides or records it) and which is SCRIPTED (the
 * demo supplies what agents, the test gate or live traffic would supply in production).
 *
 * Plan: docs/plans/demo-tournament-plan.md. Runs under plain Node 22 (`--experimental-strip-types`): no imports from
 * the workers, type annotations only. `runDemo` is exported for tests/e2e/demo.test.ts.
 */

export interface DemoUrls {
  api: string;
  shadow: string;
  canary: string;
  promotion: string;
}

export interface DemoOptions {
  urls: DemoUrls;
  token: string;
  log: (line: string) => void;
  /** Distinguishes runs, so a second run never collides with the first (org names must be unique). */
  suffix?: string;
}

export interface DemoResult {
  specId: string;
  candidates: { a: string; b: string; c: string; a2: string };
  trialId: string;
  winnerRung: string;
  liveCanaries: string[];
  canaryStatus: { a: string; a2: string };
}

export const LOCAL_URLS: DemoUrls = {
  api: 'http://localhost:8787',
  shadow: 'http://localhost:8788',
  canary: 'http://localhost:8789',
  promotion: 'http://localhost:8790',
};

/** The local-only token `scripts/start-e2e-workers.sh` gives every worker (also in tests/e2e/config.ts). */
export const LOCAL_TOKEN = 'test-auth-token-12345';

type Json = Record<string, unknown>;

class DemoError extends Error {}

export async function runDemo(opts: DemoOptions): Promise<DemoResult> {
  const { urls, token, log } = opts;
  const suffix = opts.suffix ?? Date.now().toString(36);

  /** One call; anything but a 2xx with a JSON body is an error (a 404 is never "empty", AGENTS.md). */
  async function call(base: string, path: string, body?: unknown, actorId?: string): Promise<Json> {
    const res = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(actorId ? { 'X-Actor-ID': actorId } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: Json;
    try {
      json = JSON.parse(text) as Json;
    } catch {
      throw new DemoError(`${base}${path} answered ${res.status} with a non-JSON body: ${text.slice(0, 200)}`);
    }
    if (!res.ok || json.success === false) {
      throw new DemoError(`${base}${path} answered ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    }
    return json;
  }
  const data = (j: Json) => j.data as Json;
  const id = (j: Json) => String(data(j).id);
  const short = (s: string) => s.slice(0, 8);

  let n = 0;
  function step(title: string, label: string, story: string) {
    n += 1;
    log('');
    log(`── ${n}. ${title}  [${label}]`);
    for (const line of story.split('\n')) log(`   ${line}`);
  }
  const done = (line: string) => log(`   ✓ ${line}`);

  // 1. People and agents
  step('Who is here', 'REAL', 'A maintainer and three agents get ledger identities. Every later record names one of them.');
  const maintainer = id(await call(urls.api, '/api/actors', { type: 'human', name: `demo-maintainer-${suffix}` }));
  const agents: Record<'a' | 'b' | 'c', string> = { a: '', b: '', c: '' };
  for (const k of ['a', 'b', 'c'] as const) {
    agents[k] = id(await call(urls.api, '/api/actors', { type: 'agent', name: `agent-${k}-${suffix}` }));
  }
  done(`maintainer ${short(maintainer)}, agents a/b/c ${short(agents.a)} ${short(agents.b)} ${short(agents.c)}`);

  // 2. Org, repo, issue
  step('Someone asks for a change', 'REAL', 'An organization and a repository for a URL shortener, and an issue: "Short links should expire."');
  const org = data(await call(urls.api, '/api/organizations', { name: `demo-${suffix}`, type: 'artifacts' }, maintainer));
  const orgId = String(org.id);
  const repoId = id(await call(urls.api, '/api/repositories', {
    name: 'shortener', organizationId: orgId, repoType: 'baseline',
    remoteUrl: 'https://example.invalid/shortener.git', namespace: String(org.name),
  }, maintainer));
  const issue = data(await call(urls.api, '/api/issues', {
    repositoryId: repoId, title: 'Short links should expire',
    body: 'A link created with a TTL should answer 410 Gone after it expires.',
  }, maintainer));
  done(`issue #${issue.number} on ${org.name}/shortener`);

  // 3. Spec
  step('The issue becomes a spec', 'REAL record, SCRIPTED input',
    'A machine-readable contract every implementation is held to, plus the "declared delta surface":\n' +
    'the only response fields a candidate may change compared with today. Anything else that differs is a regression.');
  const contract = {
    endpoints: [
      { method: 'POST', path: '/links', body: { url: 'string', ttlSeconds: 'number?' }, returns: { code: 'string' } },
      { method: 'GET', path: '/:code', returns: '302 to url, or 410 once expired' },
    ],
  };
  const specId = id(await call(urls.api, '/api/specs', {
    name: `short-link-expiry-${suffix}`,
    description: 'Short links can carry a TTL and answer 410 Gone after it.',
    contract: JSON.stringify(contract),
    declaredDeltaSurface: ['status:410 on expired codes', 'header:expires'],
    organizationId: orgId,
  }, maintainer));
  await call(urls.api, '/api/issue-spec-links', { issueId: String(issue.id), specId, relationship: 'requests-change' }, maintainer);
  done(`spec ${short(specId)} linked to issue #${issue.number}`);

  // 4. Candidates
  step('Three agents implement it independently', 'REAL record, SCRIPTED input',
    'Each agent works in its own fork and submits a candidate. (No agent writes code in this demo: the commits are\n' +
    'placeholders. In production each candidate is a real commit in a Cloudflare Artifacts fork.)');
  const candidate = async (agent: string, sha: string) => id(await call(urls.api, '/api/candidates', {
    specId, repositoryId: repoId, commitSha: sha.repeat(40), baseCommitSha: '0'.repeat(40), agentId: agent,
  }, agent));
  const a = await candidate(agents.a, 'a');
  const b = await candidate(agents.b, 'b');
  const c = await candidate(agents.c, 'c');
  done(`candidates A ${short(a)} (agent-a), B ${short(b)} (agent-b), C ${short(c)} (agent-c)`);

  // 5. Pre-merge gate
  step('Rung 1, pre-merge: tests and spec conformance', 'REAL record, SCRIPTED input',
    'The gate records a verdict per candidate. C never checks the TTL, so the conformance test for 410 fails.\n' +
    '(Today the gate\'s test results are simulated: docs/REAL-GATE-IMPL-PLAN.md.) The demo stops C here; Beehive does\n' +
    'not enforce that yet: the promotion worker does not read gate verdicts (see "Known gaps" at the end).');
  const verdict = (candidateId: string, status: 'pass' | 'fail', score: number, notes: string) =>
    call(urls.api, '/api/gate-verdicts', { candidateId, gate: 'pre-merge', status, score, complexityDelta: 0, notes }, maintainer);
  await verdict(a, 'pass', 96, 'all contract tests pass');
  await verdict(b, 'pass', 91, 'all contract tests pass');
  await verdict(c, 'fail', 40, 'GET /:code returns 302 for an expired code (expected 410)');
  done('A pass (96), B pass (91), C fail (40): the demo takes C no further');

  // 6. Shadow trial
  step('Rung 2, shadow: mirrored traffic, responses compared', 'REAL record, SCRIPTED input',
    'The design: the shadow router copies real requests to A and B, throws their answers away, and the Scientist\n' +
    'comparator diffs them against the declared delta surface. (Today those results do not reach the ledger; here the\n' +
    'demo supplies the comparison.) A changes only what the spec declared; B also adds a "Cache-Control" header\n' +
    'nobody asked for, an undeclared change. The ledger records the trial and its winner.');
  const trialId = id(await call(urls.api, '/api/trials', { specId, candidateAId: a, candidateBId: b }, maintainer));
  await call(urls.api, `/api/trials/${trialId}/decide`, {
    winnerId: a,
    comparisonMetrics: { conformance_score: { a: 100, b: 83 }, performance: { a: 42, b: 39 }, complexity_delta: { a: 12, b: 15 } },
  }, maintainer);
  done(`trial ${short(trialId)}: A wins (declared-surface conformance 100 vs 83). The trial stays on record; B goes no further.`);

  // 7. Climb
  step('A climbs the ladder', 'REAL record',
    'The promotion worker records each move and refuses any move back down the ladder. It takes the starting rung\n' +
    'from the caller and does not check gate verdicts or trials, so the order of moves here is the demo\'s choice.');
  for (const [from, to] of [['pre-merge', 'shadow'], ['shadow', 'train'], ['train', 'canary']]) {
    await call(urls.promotion, '/promote', { candidateId: a, specId, fromRung: from, toRung: to, actorId: maintainer });
    done(`${from} -> ${to}`);
  }

  // 8. Canary
  step('Rung 4, canary: a small slice of live traffic', 'REAL ref move, STUB build',
    'A is deployed as a canary taking 10% of traffic. The spec\'s canary ref now points at A; the shadow router reads\n' +
    'that ref to split traffic. (Locally the build is a stub version from the preview manager: nothing is built and\n' +
    'nothing calls the Cloudflare API.)');
  const deployA = (await call(urls.canary, '/deploy-canary', { candidateId: a, specId, trafficPercentage: 10, holdoutPercentage: 5 })).deployment as Json;
  done(`canary deployment ${short(String(deployA.id))} for A at 10%`);

  // 9. Regression and rollback
  step('A follow-up regresses, and rollback is a ref move', 'REAL ref move, SCRIPTED breach',
    'agent-a ships a follow-up, A2, and it takes the canary. Its error rate jumps to 7% against a 1% SLO.\n' +
    '(The breach is supplied by the demo: the rollback request carries the numbers, but nothing evaluates them here;\n' +
    'Beehive\'s SLO loop reads mirrored traffic and there is none locally.) Rolling back does not rebuild or redeploy\n' +
    'anything: the canary ref moves back to A. Promotion and rollback cost the same.');
  const a2 = await candidate(agents.a, 'e');
  const deployA2 = (await call(urls.canary, '/deploy-canary', { candidateId: a2, specId, trafficPercentage: 10, holdoutPercentage: 5 })).deployment as Json;
  done(`A2 ${short(a2)} took the canary (deployment ${short(String(deployA2.id))}); A's deployment is superseded`);
  await call(urls.canary, '/rollback', {
    candidateId: a2, specId, reason: 'slo_breach', timestamp: new Date().toISOString(),
    metrics: { errorRate: 0.07, sloErrorRate: 0.01 },
  });
  const statusOf = async (deploymentId: string) =>
    String(((await call(urls.canary, `/canary-deployments/${deploymentId}`)).deployment as Json).status);
  const canaryStatus = { a: await statusOf(String(deployA.id)), a2: await statusOf(String(deployA2.id)) };
  done(`rolled back: A2 is ${canaryStatus.a2}, A is ${canaryStatus.a} again`);

  // The shadow router caches deploy refs (5 s TTL, at worst 2 x TTL stale: workers/shadow-router/live-refs-cache.ts),
  // so wait for it to follow the ref move rather than read a stale split once.
  const ours = async () => {
    const splits = (await call(urls.shadow, '/statsig/config')).splits as Record<string, unknown> | undefined;
    return Object.keys(splits ?? {}).filter((k) => k === a || k === a2);
  };
  const started = Date.now();
  let liveCanaries = await ours();
  while (!(liveCanaries.includes(a) && !liveCanaries.includes(a2)) && Date.now() - started < 15_000) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    liveCanaries = await ours();
  }
  const waited = ((Date.now() - started) / 1000).toFixed(1);
  done(liveCanaries.includes(a) && !liveCanaries.includes(a2)
    ? `the shadow router now sends canary traffic to A (it caches refs for up to 5 s; this took ${waited} s)`
    : `the shadow router still shows ${liveCanaries.length ? liveCanaries.map((k) => (k === a ? 'A' : 'A2')).join(', ') : 'no canary'} after ${waited} s`);

  // 10. Full
  step('Rung 5, full: A is recorded as shipped', 'REAL record',
    'The promotion worker records A at "full". Nothing moves traffic yet: there is no full deploy ref, so A\'s 10%\n' +
    'canary is still the live split. Moving 100% of traffic is not built.');
  await call(urls.promotion, '/promote', { candidateId: a, specId, fromRung: 'canary', toRung: 'full', actorId: maintainer });
  const state = (await call(urls.promotion, `/promote/${a}`)).state as Json;
  done(`A is at "${state.currentRung}" (${state.status})`);

  // 11. Summary
  log('');
  log('── What happened, from the ledger');
  log(`   issue #${issue.number} -> spec ${short(specId)} -> 3 candidates`);
  log(`   C: failed pre-merge.  B: lost the shadow trial.  A: won, canaried, recorded at full.  A2: rolled back by a ref move.`);
  log(`   live canary splits for this spec: ${liveCanaries.map((k) => (k === a ? 'A' : 'A2')).join(', ') || 'none'}`);
  log('');
  log('── What was simulated');
  log('   Agents writing code (placeholder commits), the test gate\'s results, the shadow comparison, the canary build');
  log('   (a stub), live traffic and the SLO breach. Real Beehive code: the ledger records, the promotion records, the');
  log('   canary deploy refs, the rollback ref move and the shadow router following it.');
  log('');
  log('── Known gaps (docs/OPEN-QUESTIONS.md, 2026-11-07)');
  log('   - Promotion does not check gate verdicts or trial winners, and trusts the caller\'s starting rung.');
  log('   - Shadow results never reach the ledger, so the promotion worker\'s own tournament picks by arrival order.');
  log('   - "full" is a record only: there is no full deploy ref; a candidate\'s ledger stage is not updated either.');
  log('');
  log('── Look around');
  log(`   curl -s -H "Authorization: Bearer ${token}" ${urls.api}/api/candidates/${a} | jq .`);
  log(`   curl -s -H "Authorization: Bearer ${token}" ${urls.api}/api/trials/${trialId} | jq .`);
  log(`   curl -s -H "Authorization: Bearer ${token}" ${urls.promotion}/promote/${a} | jq .`);

  return { specId, candidates: { a, b, c, a2 }, trialId, winnerRung: String(state.currentRung), liveCanaries, canaryStatus };
}

// ---------------------------------------------------------------------------------------------------------------
// CLI entry: start the local workers unless they are up (or --no-start), run, and leave them running to look around.
// ---------------------------------------------------------------------------------------------------------------

async function healthy(url: string, token: string): Promise<boolean> {
  try {
    return (await fetch(`${url}/health`, { headers: { Authorization: `Bearer ${token}` } })).ok;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const { spawn } = await import('node:child_process');
  const { openSync, readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  // Resolve everything from the repo root, so running the file from another directory works too.
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: npm run demo [-- --no-start]\n  --no-start  use workers already running on 8787-8791 (scripts/start-e2e-workers.sh)');
    return;
  }
  // The canary worker builds through the preview manager (8791), so it must be up too, not only the four we call.
  const needed = [...Object.values(LOCAL_URLS), 'http://localhost:8791'];
  const allUp = async () => (await Promise.all(needed.map((u) => healthy(u, LOCAL_TOKEN)))).every(Boolean);

  if (!(await allUp())) {
    if (args.includes('--no-start')) {
      console.error('The local workers are not all running (8787-8791). Start them with scripts/start-e2e-workers.sh, or drop --no-start.');
      process.exit(1);
    }
    // The start script ends with `wait` (it lives as long as the workers), so run it detached with its output in a
    // log and poll health, the way CI does (.github/workflows/ci.yml "Start local workers").
    const logPath = `${root}demo-workers.log`;
    console.log(`Starting the local Beehive workers (about a minute the first time; log: ${logPath})...`);
    const out = openSync(logPath, 'w');
    spawn('bash', [`${root}scripts/start-e2e-workers.sh`], { cwd: root, detached: true, stdio: ['ignore', out, out] }).unref();
    const deadline = Date.now() + 180_000;
    for (;;) {
      const log = readFileSync(logPath, 'utf8');
      if (log.includes('All workers started successfully') && (await allUp())) break;
      if (/not healthy|already in use|No such file/.test(log) || Date.now() > deadline) {
        console.error(`Could not start the workers. Last lines of ${logPath}:\n${log.trim().split('\n').slice(-15).join('\n')}`);
        console.error('See docs/TROUBLESHOOTING.md; stop anything left with scripts/stop-e2e-workers.sh.');
        process.exit(1);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  console.log('\nBeehive demo: one spec, three agents, the oracle ladder decides.');
  try {
    await runDemo({ urls: LOCAL_URLS, token: LOCAL_TOKEN, log: (l) => console.log(l) });
    console.log('\nThe workers are still running so you can look around. Stop them with: scripts/stop-e2e-workers.sh');
  } catch (error) {
    console.error(`\nThe demo stopped: ${error instanceof Error ? error.message : String(error)}`);
    console.error('Stop the workers with scripts/stop-e2e-workers.sh; docs/TROUBLESHOOTING.md lists common causes.');
    process.exitCode = 1;
  }
}

// Run main() only when executed directly (not when imported by the e2e test). Compare real paths as URLs, so spaces,
// symlinks (macOS /tmp) and Windows paths still match.
const { pathToFileURL } = await import('node:url');
const { realpathSync } = await import('node:fs');
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  void main();
}
