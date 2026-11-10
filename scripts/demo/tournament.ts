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
  /** What the promotion worker answered when asked to move C (it failed pre-merge) */
  refusedC: { status: number; code: string };
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

async function runDemoSteps(opts: DemoOptions): Promise<DemoResult> {
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
  /** A call whose refusal is the point: returns the status and body instead of throwing on a non-2xx. */
  async function attempt(base: string, path: string, body: unknown): Promise<{ status: number; json: Json }> {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Json };
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
    '(Today the gate\'s test results are simulated: docs/REAL-GATE-IMPL-PLAN.md.) Then each agent asks the promotion worker\n' +
    'to move its candidate to the shadow rung. Beehive decides: it moves A and B, and refuses C because there is no passing verdict.');
  const verdict = (candidateId: string, status: 'pass' | 'fail', score: number, notes: string) =>
    call(urls.api, '/api/gate-verdicts', { candidateId, gate: 'pre-merge', status, score, complexityDelta: 0, notes }, maintainer);
  await verdict(a, 'pass', 96, 'all contract tests pass');
  await verdict(b, 'pass', 91, 'all contract tests pass');
  await verdict(c, 'fail', 40, 'GET /:code returns 302 for an expired code (expected 410)');
  const toShadow = (candidateId: string) => attempt(urls.promotion, '/promote', { candidateId, specId, toRung: 'shadow', actorId: maintainer });
  const movedA = await toShadow(a);
  const movedB = await toShadow(b);
  const refused = await toShadow(c);
  if (movedA.status !== 200 || movedB.status !== 200) {
    throw new DemoError(`A or B could not move to shadow: ${JSON.stringify([movedA, movedB]).slice(0, 300)}`);
  }
  if (refused.status !== 409) throw new DemoError(`C should have been refused (409) but the promotion worker answered ${refused.status}`);
  const refusedC = { status: refused.status, code: String(refused.json.code) };
  done(`A and B moved to shadow; C was refused: ${refused.status} ${refusedC.code} ("${String(refused.json.message ?? refused.json.error).slice(0, 80)}")`);

  // 6. Shadow tournament
  step('Rung 2, shadow: mirrored traffic, responses compared, one winner', 'REAL record, SCRIPTED input',
    'The design: the shadow router copies real requests to A and B, throws their answers away, and the Scientist comparator\n' +
    'scores each against the declared delta surface. The Spec DO sums those scores per candidate. (Today the router does not\n' +
    'mirror candidates that have not reached a canary, so the demo posts the samples itself, through a maintainer-only route.)\n' +
    'A changes only what the spec declared; B also adds a "Cache-Control" header nobody asked for. Both ask to move to train:\n' +
    'the promotion worker runs a tournament, reads both scores from the ledger, records the decision as a trial, and advances the winner.');
  const samples = (score: number) => ({
    samples: Array.from({ length: 20 }, (_, i) => ({ requestId: `demo-${suffix}-${score}-${i}`, score, matched: score >= 100, diffs: [] })),
  });
  await call(urls.api, `/api/candidates/${a}/shadow-samples`, samples(98), maintainer);
  await call(urls.api, `/api/candidates/${b}/shadow-samples`, samples(83), maintainer);
  const joinA = await call(urls.promotion, '/promote', { candidateId: a, specId, toRung: 'train', actorId: maintainer });
  const decided = await call(urls.promotion, '/promote', { candidateId: b, specId, toRung: 'train', actorId: maintainer });
  const details = decided.details as Json;
  const trialId = String(details.trialId);
  const scores = details.scores as Record<string, number>;
  done(`A joined and waited (${String(joinA.outcome)}); B asked, the tournament decided, and B was ${String(decided.outcome)}. Shadow scores: A ${scores[a]}, B ${scores[b]}`);
  done(`trial ${short(trialId)}: A wins the shadow score (98 vs 83). B goes no further; the trial stays on record.`);

  // 7. Climb
  step('A leaves the train rung', 'REAL record',
    'A is on the train rung. The promotion worker asks the Spec DO to advance it to the canary rung. The Spec DO\n' +
    'checks the move is the next one and looks for a merged merge-train car; in tournament mode there is none, and that\n' +
    'evidence is only logged for now (docs/OPS.md "Advance"), so the move lands.');
  await call(urls.promotion, '/promote', { candidateId: a, specId, fromRung: 'train', toRung: 'canary', actorId: maintainer });
  done('train -> canary');

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
    'The Spec DO moves A to "promoted" only if A is the live canary and has been for the soak time (15 minutes; the local\n' +
    'workers shorten it to zero). A is, because the rollback put the ref back on A. Nothing moves traffic yet: there is no\n' +
    'full deploy ref, so A\'s 10% canary is still the live split. Moving 100% of traffic is not built.');
  await call(urls.promotion, '/promote', { candidateId: a, specId, fromRung: 'canary', toRung: 'full', actorId: maintainer });
  const state = (await call(urls.promotion, `/promote/${a}`)).state as Json;
  done(`A is at "${state.currentRung}" (${state.status}), stage "${String(data(await call(urls.api, `/api/candidates/${a}`)).stage)}"`);

  // 11. Summary
  log('');
  log('── What happened, from the ledger');
  log(`   issue #${issue.number} -> spec ${short(specId)} -> 3 candidates`);
  log(`   C: refused at pre-merge.  B: lost the shadow tournament.  A: won, canaried, promoted.  A2: rolled back by a ref move.`);
  log(`   live canary splits for this spec: ${liveCanaries.map((k) => (k === a ? 'A' : 'A2')).join(', ') || 'none'}`);
  log('');
  log('── What was simulated');
  log('   Agents writing code (placeholder commits), the test gate\'s results, the shadow samples, the canary build');
  log('   (a stub), live traffic and the SLO breach. Real Beehive code: the ledger records, the promotion records, the');
  log('   canary deploy refs, the rollback ref move and the shadow router following it.');
  log('');
  log('── Known gaps (docs/OPEN-QUESTIONS.md, 2026-11-10)');
  log('   - Shadow and train evidence are log-only: a missing shadow verdict or merged car is recorded as a governance event, not refused.');
  log('   - In production the tournament has no shadow scores to read (the router does not mirror candidates before canary), so it');
  log('     refuses with no_shadow_evidence; the demo supplies the samples. The shadow-router follow-up changes that.');
  log('   - "full" is a record and a stage only: there is no full deploy ref and no traffic moves.');
  log('');
  log('── Look around');
  log(`   curl -s -H "Authorization: Bearer ${token}" ${urls.api}/api/candidates/${a} | jq .`);
  log(`   curl -s -H "Authorization: Bearer ${token}" ${urls.api}/api/trials/${trialId} | jq .`);
  log(`   curl -s -H "Authorization: Bearer ${token}" ${urls.promotion}/promote/${a} | jq .`);

  return { specId, candidates: { a, b, c, a2 }, trialId, refusedC, winnerRung: String(state.currentRung), liveCanaries, canaryStatus };
}

/**
 * The story is the tournament's (shadow -> train is decided by shadow score), so the promotion worker must be in tournament mode while it runs.
 * The mode is global ledger state: set it for the run and put the original back, so a worker left in merge-train mode (or another test flipping
 * it) cannot turn the narration into something that did not happen.
 */
export async function runDemo(opts: DemoOptions): Promise<DemoResult> {
  const { urls, token } = opts;
  const mode = async (body?: unknown): Promise<string> => {
    const res = await fetch(`${urls.promotion}/mode`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new DemoError(`${urls.promotion}/mode answered ${res.status}`);
    return String(((await res.json()) as Json).mode);
  };
  const original = await mode();
  if (original !== 'tournament') await mode({ mode: 'tournament' });
  try {
    return await runDemoSteps(opts);
  } finally {
    if (original !== 'tournament') {
      await mode({ mode: original }).catch((error) =>
        opts.log(`   ! could not put the promotion mode back to "${original}": ${error instanceof Error ? error.message : String(error)}`)
      );
    }
  }
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
