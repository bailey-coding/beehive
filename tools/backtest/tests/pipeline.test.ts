// End to end with the deterministic FakeClient on a tiny fixture repo (real git, real vitest subprocesses, no model).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BudgetTracker } from '../budget.ts';
import { FakeClient, buildClaudeArgs, childEnv, type FakeReply, type ModelRequest } from '../client.ts';
import { checkIndependence, freezeCorpus, loadCorpus, type Corpus } from '../corpus.ts';
import { exec } from '../exec.ts';
import { git } from '../git.ts';
import { docAtBaseTest, historyTest, reachabilityTest } from '../leakage.ts';
import { baseGreen } from '../basegreen.ts';
import { stableRun } from '../oracles.ts';
import type { OracleConfig } from '../oracles.ts';
import { runPilot } from '../run.ts';
import type { RowResult } from '../results.ts';

const harnessRoot = path.resolve(__dirname, '..', '..', '..');
const cfg: OracleConfig = {
  testCommand: ['node', 'node_modules/vitest/vitest.mjs', 'run'],
  tscCommand: null,
  testTimeoutMs: 120_000,
  tscTimeoutMs: 1,
  // fixture has no dependencies of its own: provide the harness's node_modules (stands in for `npm ci`)
  installDeps: async (dir: string) => fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(dir, 'node_modules'), 'dir'),
  baseAttempts: 2,
  evalAttempts: 2,
};

const APP_BASE = `export default {
  async fetch(req: Request): Promise<Response> {
    const p = new URL(req.url).pathname;
    if (p === '/' || p === '/about') return new Response('<html>ok</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  },
};
`;
const APP_FIXED = APP_BASE.replace("p === '/about')", "p === '/about' || p === '/roadmap')").replace("'<html>ok</html>'", "p === '/roadmap' ? '<html>Roadmap</html>' : '<html>ok</html>'");
const APP_PARTIAL = APP_BASE.replace("p === '/about')", "p === '/about' || p === '/roadmap')");
const TEST_BASE = `import { expect, it } from 'vitest';
import app from '../workers/api/index';
it('serves / publicly', async () => { expect((await app.fetch(new Request('https://x/'))).status).toBe(200); });
it('401 elsewhere', async () => { expect((await app.fetch(new Request('https://x/private'))).status).toBe(401); });
`;
const TEST_CHANGED = `${TEST_BASE}it('serves the roadmap page', async () => {
  const res = await app.fetch(new Request('https://x/roadmap'));
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('Roadmap');
});
`;

const ACCEPTANCE = `import { expect, it } from 'vitest';
import app from '../../workers/api/index';
import { record } from './probe';
it('roadmap is public', async () => {
  const about = new Request('https://x/about');
  await record('about', about, await app.fetch(about));
  const req = new Request('https://x/roadmap');
  const res = await record('roadmap', req, await app.fetch(req));
  expect(res.status).toBe(200);
});
`;

const SPEC = {
  name: 'public roadmap',
  description: 'GET /roadmap is a public page',
  contract: JSON.stringify({ endpoints: [{ method: 'GET', path: '/roadmap', isNew: true, responses: [{ status: 200 }] }] }),
  acceptance: [{ name: 'roadmap is public', file: 'roadmap.test.ts', code: ACCEPTANCE }],
  declaredDeltaSurface: [{ version: '1.0', routes: [{ method: 'GET', path: '/roadmap', statuses: [200], allowedBodyDiffs: ['$body'] }] }],
  out_of_scope: ['other routes keep their status'],
};
// first attempt is vacuous (its test passes on base) so the retry path is exercised
const VACUOUS = { ...SPEC, acceptance: [{ name: 'about', file: 'about.test.ts', code: "import { expect, it } from 'vitest';\nit('always true', () => { expect(1).toBe(1); });\n" }] };

let source: string;
let corpus: Corpus;
let changeSha: string;

beforeAll(async () => {
  source = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-src-'));
  const w = (f: string, c: string) => {
    fs.mkdirSync(path.dirname(path.join(source, f)), { recursive: true });
    fs.writeFileSync(path.join(source, f), c);
  };
  await git(source, ['init', '-q', '-b', 'main']);
  await git(source, ['config', 'user.email', 'f@x.invalid']);
  await git(source, ['config', 'user.name', 'F']);
  w('package.json', '{"type":"module"}\n');
  w('vitest.config.ts', "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['tests/**/*.test.ts'] } });\n");
  w('workers/api/index.ts', APP_BASE);
  w('tests/app.test.ts', TEST_BASE);
  w('docs/README.md', 'Fixture docs.\n');
  await git(source, ['add', '-A']);
  await git(source, ['commit', '-q', '-m', 'base']);
  w('workers/api/index.ts', APP_FIXED);
  w('tests/app.test.ts', TEST_CHANGED);
  await git(source, ['add', '-A']);
  await git(source, ['commit', '-q', '-m', 'fix: roadmap is public\n\nVisitors to the roadmap page got a 401 instead of the page.\n\n- added the path to the public list\nCo-Authored-By: X <x@x.invalid>']);
  changeSha = (await git(source, ['rev-parse', 'HEAD'])).trim();
  const out = path.join(os.tmpdir(), `fixture-corpus-${Date.now()}.json`);
  corpus = await freezeCorpus(source, [{ id: 'A1', sha: changeSha, tier: 'A', obs: 'E', component: 'api router', kind: 'body', note: 'body', keyTerms: ['roadmap'] }], out);
});

function client(opts: { vacuousFirst?: boolean } = {}) {
  let cand = 0;
  const fake: FakeClient = new FakeClient((req: ModelRequest): FakeReply => {
    switch (req.role) {
      case 'issue':
        return { text: 'Roadmap page returns 401\n\nOpening the roadmap page without credentials answers 401. It should show the page.' };
      case 'spec': {
        const nth = fake.requests.filter((r: ModelRequest) => r.role === 'spec').length;
        return { text: '```json\n' + JSON.stringify(opts.vacuousFirst && nth === 1 ? VACUOUS : SPEC) + '\n```' };
      }
      case 'candidate': {
        cand++;
        const f = path.join(req.cwd!, 'workers/api/index.ts');
        if (cand === 2) fs.writeFileSync(f, APP_FIXED);
        if (cand === 3) fs.writeFileSync(f, APP_PARTIAL);
        return { text: 'done', calls: 4, costUsd: 0.5, usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000 } };
      }
      case 'grade':
        return { text: '{"label":"spec-gap","rationale":"the spec never says what the page contains"}' };
      default:
        throw new Error(`unexpected role ${req.role}`);
    }
  });
  return fake;
}

const baseOpts = (name: string) => ({
  corpus, repo: source, harnessRoot, cfg,
  outDir: path.join(os.tmpdir(), `bt-out-${name}-${Date.now()}`),
  workRoot: path.join(os.tmpdir(), `bt-work-${name}-${Date.now()}`),
  runId: name, k: 3, issueApproval: 'auto' as const,
});

describe('corpus', () => {
  it('freezes rows with the base, issue source and file classes derived from git', () => {
    const r = corpus.rows[0];
    expect(r.base).toHaveLength(40);
    expect(r.issueSource).toMatchObject({ subject: 'fix: roadmap is public', body: 'Visitors to the roadmap page got a 401 instead of the page.', thin: false });
    expect(r.files).toEqual({ source: ['workers/api/index.ts'], tests: ['tests/app.test.ts'], docs: [] });
  });
  it('rejects a hand-edited base', async () => {
    const f = path.join(os.tmpdir(), `bad-corpus-${Date.now()}.json`);
    fs.writeFileSync(f, JSON.stringify({ ...corpus, rows: [{ ...corpus.rows[0], base: 'a'.repeat(40) }] }));
    await expect(loadCorpus(f, source)).rejects.toThrow(/does not match/);
  });
  it('independence filter flags a parent/child pair', async () => {
    const row = corpus.rows[0];
    const parent = { ...row, id: 'P', sha: row.base.slice(0, 7), base: 'f'.repeat(40) };
    expect((await checkIndependence(source, [parent, row])).join()).toMatch(/parent/);
  });
});

describe('leakage tests 3 and 4', () => {
  it('doc-at-base: a doc added by the change (absent at base) is rejected; key terms in docs are flagged', async () => {
    const row = corpus.rows[0];
    expect((await docAtBaseTest(source, { ...row, issueSource: { ...row.issueSource, docs: [{ path: 'docs/README.md' }] } })).passed).toBe(true);
    const late = await docAtBaseTest(source, { ...row, issueSource: { ...row.issueSource, docs: [{ path: 'docs/LATER.md' }] } });
    expect(late.passed).toBe(false);
    expect(late.detail[0]).toMatch(/does not exist at base/);
    const quote = await docAtBaseTest(source, { ...row, issueSource: { ...row.issueSource, docs: [{ path: 'docs/README.md', quote: 'not in the doc' }] } });
    expect(quote.detail[0]).toMatch(/not verbatim/);
    expect((await docAtBaseTest(source, { ...row, keyTerms: ['Fixture'] })).passed).toBe(false);
  });
  it('history: scratch checkouts are single-commit, remote-local, and exclude the change', async () => {
    const { createScratchRepo } = await import('../git.ts');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-'));
    const s = await createScratchRepo(source, corpus.rows[0].base, work);
    expect((await historyTest(s.repo, work, source, corpus.rows[0])).passed).toBe(true);
    // a checkout holding the real history must fail
    const leaky = await historyTest(source, work, source, corpus.rows[0]);
    expect(leaky.passed).toBe(false);
    expect(leaky.detail.join()).toMatch(/2 commits|knows the change/);
  });
});

let rows: RowResult[];
let fake: FakeClient;
let workRoot: string;

afterAll(() => {
  // the 'full' run keeps its agent roots for the isolation tests; remove them once the file is done
  for (const r of fake?.requests ?? []) if (r.cwd) fs.rmSync(path.dirname(r.cwd), { recursive: true, force: true });
});

describe('pilot run with the fake client', () => {
  let tracker: BudgetTracker;
  let outDir: string;
  let report: string;

  beforeAll(async () => {
    const o = baseOpts('full');
    tracker = new BudgetTracker();
    fake = client({ vacuousFirst: true });
    const res = await runPilot({ ...o, client: fake, tracker, keepWork: true });
    workRoot = o.workRoot;
    rows = res.rows;
    outDir = path.join(o.outDir, o.runId);
    report = fs.readFileSync(res.reportPath, 'utf8');
  }, 280_000);

  it('retries the vacuous spec once, then passes validators', () => {
    expect(rows[0].status).toBe('complete');
    expect(rows[0].spec).toMatchObject({ passedValidators: true, retries: 1 });
    expect(rows[0].spec!.attempts[0].errors.join()).toMatch(/vacuous/);
  });

  it('reference diff is accepted by every rung (no false reject) and held-out tests pass', () => {
    const ref = rows[0].reference!;
    expect(ref.acceptancePassed).toBe(true);
    expect(ref.falseRejected).toBe(false);
    expect(Object.values(ref.report.heldOut.outcomes).every((s) => s === 'passed')).toBe(true);
    expect(ref.report.rungs).toEqual({ preMerge: true, conformance: true, shadow: true });
  });

  it('labels candidates: no change violates the spec, the fix is equivalent, the partial fix goes to the grader', () => {
    const [c1, c2, c3] = rows[0].candidates;
    expect(c1.label).toBe('spec violation');
    expect(c1.clearsAllRungs).toBe(false);
    expect(c2.label).toBe('equivalent');
    expect(c2.labelSource).toBe('deterministic');
    expect(c2.clearsAllRungs).toBe(true);
    expect(c2.testAgreement.agree).toBe(c2.testAgreement.total);
    expect(c3.clearsAllRungs).toBe(true); // acceptance and rungs pass
    expect(c3.deterministicRegression).toBe(true); // but the held-out test fails
    expect(c3.label).toBe('spec-gap');
    expect(c3.labelSource).toBe('same-family grader');
    expect(rows[0].graderCalls).toBe(1);
  });

  it('every candidate was pushed to its scratch origin and ran in an isolated checkout', () => {
    for (const c of rows[0].candidates) expect(c.commit).toMatch(/^[0-9a-f]{40}$/);
    const cands = fake.requests.filter((r) => r.role === 'candidate');
    expect(new Set(cands.map((r) => r.cwd)).size).toBe(3);
    for (const r of cands) {
      expect(r.tools).toBe('agent');
      expect(r.maxCalls).toBe(40);
      expect(r.cwd!.startsWith(os.tmpdir())).toBe(true);
      expect(r.prompt).not.toContain('Roadmap</html>'); // no reference content in the prompt
    }
  });

  it('metrics: rescue counted once (candidate 1 fails, a later one clears), budget tracked per role', () => {
    const run = JSON.parse(fs.readFileSync(path.join(outDir, 'run.json'), 'utf8'));
    expect(run.meta.aborted).toBeNull();
    expect(run.meta.budget.byRole.candidate.calls).toBe(12);
    expect(run.meta.budget.used).toBe(1 + 2 + 12 + 1);
    expect(report).toMatch(/Rescue rate R: 1 rows \(1 confirmed by deterministic oracles\)/);
    expect(report).toContain('same-family grader');
    expect(report).toMatch(/inconclusive by rule/);
    expect(rows[0].spec).toMatchObject({ editDistance: 0 });
    expect(typeof rows[0].spec!.humanMinutes).toBe('number');
  });

  it('writes per-run JSON for every candidate and one markdown report', () => {
    for (const f of ['issue.json', 'spec.json', 'spec.generated.json', 'reference.json', 'result.json', 'candidates/c1.json', 'candidates/c3.json', 'candidates/c2.patch']) {
      expect(fs.existsSync(path.join(outDir, 'rows', 'A1', f)), f).toBe(true);
    }
    expect(report.startsWith('# Backtest report: full')).toBe(true);
  });

  it('leakage results are recorded (tests 2-4 here; test 1 needs two rows)', () => {
    expect(rows[0].leakage).toMatchObject({ docAtBase: { passed: true }, history: { passed: true } });
    expect(rows[0].leakage!.wrongIssue).toBeNull();
  });
});

describe('isolation of agent checkouts (no model involved)', () => {
  // These run against the directories the fake candidates were actually given (keepWork).
  const runDir = () => fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('bt-agent-'));
  it('candidate roots hold only the single-commit scratch repo: no node_modules, no reference artefacts, no escaping symlinks', () => {
    expect(runDir().length).toBeGreaterThan(0);
    const cands = fake.requests.filter((r) => r.role === 'candidate');
    expect(cands).toHaveLength(3);
    for (const r of cands) {
      const root = path.dirname(r.cwd!);
      expect(path.dirname(root)).toBe(os.tmpdir()); // private top-level root: no shared ancestor below the temp dir
      expect(root.startsWith(workRoot)).toBe(false);
      const names: string[] = [];
      const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          names.push(e.name);
          if (e.isSymbolicLink()) throw new Error(`symlink ${path.join(d, e.name)}`);
          if (e.isDirectory() && e.name !== 'objects') walk(path.join(d, e.name));
        }
      };
      walk(root);
      expect(names).not.toContain('node_modules');
      expect(names).not.toContain('reference.patch');
      expect(names.filter((n) => n.startsWith('eval-') || n === 'deps' || n === 'reference')).toEqual([]);
      const marker = (rows[0].reference as unknown as { report: unknown }) && changeSha;
      expect(reachabilityTest({ agentRoot: root, cwd: r.cwd!, forbiddenRoots: [workRoot, source, harnessRoot], markers: [marker, changeSha.slice(0, 7), 'reference.patch'] }).passed).toBe(true);
    }
  });
  it('the reachability test catches reference content, escaping symlinks and harness paths inside the agent root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-agent-neg-'));
    const cwd = path.join(root, 'wt');
    fs.mkdirSync(cwd);
    const forbidden = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-ref-neg-'));
    fs.writeFileSync(path.join(forbidden, 'reference.patch'), 'x');
    const base = { agentRoot: root, cwd, forbiddenRoots: [forbidden], markers: ['REFERENCE-MARKER-123'] };
    expect(reachabilityTest(base).passed).toBe(true);
    fs.symlinkSync(forbidden, path.join(cwd, 'node_modules'), 'dir');
    expect(reachabilityTest(base).detail.join()).toMatch(/escapes the agent root/);
    fs.rmSync(path.join(cwd, 'node_modules'));
    fs.writeFileSync(path.join(root, 'notes.txt'), 'see REFERENCE-MARKER-123');
    expect(reachabilityTest(base).detail.join()).toMatch(/reference marker found in notes.txt/);
    fs.rmSync(path.join(root, 'notes.txt'));
    expect(reachabilityTest({ ...base, forbiddenRoots: [os.tmpdir()] }).detail.join()).toMatch(/ancestor of the agent root/);
    expect(reachabilityTest({ ...base, forbiddenRoots: [cwd] }).detail.join()).toMatch(/lies inside the agent root/);
    fs.mkdirSync(path.join(cwd, '.git', 'objects', 'info'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.git', 'objects', 'info', 'alternates'), '/real/repo/.git/objects');
    // objects/ is skipped for content, so alternates lives under info/ beside it
    fs.mkdirSync(path.join(cwd, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.git', 'info', 'alternates'), '/real/repo/.git/objects');
    expect(reachabilityTest(base).detail.join()).toMatch(/alternates/);
  });
  it('the exact child env and argument list of the real client expose no Bash tool and no secrets', () => {
    const args = buildClaudeArgs({ tools: 'agent' });
    expect(args[args.indexOf('--tools') + 1].split(',')).not.toContain('Bash');
    expect(args.join(' ').split('--allowedTools')[1].split('--disallowedTools')[0]).not.toContain('Bash');
    const env = childEnv({ ...process.env, ANTHROPIC_API_KEY: 'sk-test', CLOUDFLARE_API_TOKEN: 't', GITHUB_TOKEN: 'g' } as NodeJS.ProcessEnv);
    expect(Object.keys(env).filter((k) => /KEY|TOKEN|SECRET|PASSWORD/i.test(k))).toEqual([]);
  });
});

describe('human issue approval gate', () => {
  it('stops after the issue stage, then resumes without regenerating the issue', async () => {
    const o = baseOpts('gate');
    const tracker1 = new BudgetTracker();
    const fake1 = client();
    const r1 = await runPilot({ ...o, issueApproval: 'required', client: fake1, tracker: tracker1 });
    expect(r1.rows[0].status).toBe('awaiting-issue-approval');
    expect(tracker1.used).toBe(1);
    expect(fake1.requests.map((r) => r.role)).toEqual(['issue']);
    const f = path.join(o.outDir, 'gate', 'rows', 'A1', 'issue.json');
    const issue = JSON.parse(fs.readFileSync(f, 'utf8'));
    fs.writeFileSync(f, JSON.stringify({ ...issue, approved: true }));
    const fake2 = client();
    const r2 = await runPilot({ ...o, issueApproval: 'required', client: fake2, tracker: new BudgetTracker(), k: 1 });
    expect(r2.rows[0].status).toBe('complete');
    expect(fake2.requests.some((r) => r.role === 'issue')).toBe(false);
    // one ledger across both invocations: the issue-pass call is still counted in the second tracker and on disk
    const t2 = r2.meta.budget;
    const disk = JSON.parse(fs.readFileSync(path.join(o.outDir, 'gate', 'ledger.json'), 'utf8'));
    expect(disk.ledger.filter((e: { role: string }) => e.role === 'issue')).toHaveLength(1);
    expect(disk.used).toBe(t2.used);
    expect(t2.byRole.issue.calls).toBe(1);
  }, 200_000);
});

describe('budget abort', () => {
  it('stops at the hard limit, still writes partial results and pushes the scratch state', async () => {
    const o = baseOpts('abort');
    const tracker = new BudgetTracker(3, 3);
    const logs: string[] = [];
    const res = await runPilot({ ...o, client: client({ vacuousFirst: true }), tracker, log: (s) => logs.push(s) });
    expect(res.meta.aborted).toMatch(/hard stop/);
    expect(res.rows[0].status).toBe('aborted');
    expect(tracker.used).toBe(3);
    const out = path.join(o.outDir, 'abort');
    expect(fs.existsSync(path.join(out, 'report.md'))).toBe(true);
    expect(fs.readFileSync(path.join(out, 'report.md'), 'utf8')).toMatch(/ABORTED \(partial results\)/);
    expect(JSON.parse(fs.readFileSync(path.join(out, 'run.json'), 'utf8')).meta.budget.used).toBe(3);
  }, 200_000);
});

describe('abort and stop-rule statuses', () => {
  it('keeps spec-failed rows spec-failed when the two-spec-fail stop rule aborts the run', async () => {
    const o = baseOpts('stoprule');
    const three: Corpus = { ...corpus, rows: ['A1', 'A2', 'A3'].map((id) => ({ ...corpus.rows[0], id })) };
    const fake = new FakeClient((req) => (req.role === 'issue' ? { text: 'Roadmap page returns 401\n\nIt should show the page.' } : { text: 'no json here' }));
    const res = await runPilot({ ...o, corpus: three, client: fake, tracker: new BudgetTracker() });
    expect(res.meta.aborted).toMatch(/two specs in a row/);
    expect(res.rows.map((r) => r.status)).toEqual(['spec-failed', 'spec-failed', 'aborted']);
    expect(res.rows[0].note).toMatch(/no JSON/);
    const saved = JSON.parse(fs.readFileSync(path.join(o.outDir, 'stoprule', 'rows', 'A2', 'result.json'), 'utf8'));
    expect(saved.status).toBe('spec-failed');
    expect(fs.readFileSync(res.reportPath, 'utf8')).toMatch(/spec-failed/);
  }, 120_000);
});

describe('flaky tests and base-green', () => {
  const mkRepo = async (withRed: boolean) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'flaky-src-'));
    const w = (f: string, c: string) => {
      fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
      fs.writeFileSync(path.join(d, f), c);
    };
    await git(d, ['init', '-q', '-b', 'main']);
    await git(d, ['config', 'user.email', 'f@x.invalid']);
    await git(d, ['config', 'user.name', 'F']);
    w('package.json', '{"type":"module"}\n');
    w('vitest.config.ts', "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['tests/**/*.test.ts'] } });\n");
    w('tests/t.test.ts', `import fs from 'node:fs';
import { expect, it } from 'vitest';
it('flaky once', () => { const f = '.flaky-marker'; if (!fs.existsSync(f)) { fs.writeFileSync(f, '1'); throw new Error('first run'); } });
it('green', () => {});
${withRed ? "it('red always', () => { expect(1).toBe(2); });" : ''}
`);
    await git(d, ['add', '-A']);
    await git(d, ['commit', '-q', '-m', 'base']);
    return { dir: d, sha: (await git(d, ['rev-parse', 'HEAD'])).trim() };
  };

  it('a test that fails once and then passes is flaky (kept, not red); one that always fails is red', async () => {
    const { dir } = await mkRepo(true);
    fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    const r = await stableRun(dir, cfg, 3);
    expect(r.flaky).toEqual(['tests/t.test.ts::flaky once']);
    expect(r.outcomes.filter((o) => o.status === 'failed').map((o) => o.name)).toEqual(['red always']);
    expect(r.outcomes.find((o) => o.name === 'flaky once')!.status).toBe('skipped');
  });

  it('baseGreen drops a row with a real red test and keeps a flaky-only row', async () => {
    const red = await mkRepo(true);
    const flakyOnly = await mkRepo(false);
    const row = (sha: string) => ({ base: sha, scrubDocs: [] }) as never;
    const g1 = await baseGreen(red.dir, row(red.sha), cfg);
    expect(g1.verdict).toBe('drop');
    expect(g1.red).toEqual(['tests/t.test.ts::red always']);
    const g2 = await baseGreen(flakyOnly.dir, row(flakyOnly.sha), cfg);
    expect(g2).toMatchObject({ verdict: 'keep', red: [], flaky: ['tests/t.test.ts::flaky once'] });
  });
});

describe('CLI refuses to spend without release', () => {
  it('pilot needs --release-pilot', async () => {
    const r = await exec('node', ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', 'tools/backtest/cli.ts', 'pilot'], { cwd: harnessRoot, env: { PATH: process.env.PATH } });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--release-pilot/);
  });
  it('smoke needs --release-pilot too, and the removed --auto-approve-issues flag is rejected', async () => {
    const run = (args: string[]) => exec('node', ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', 'tools/backtest/cli.ts', ...args], { cwd: harnessRoot, env: { PATH: process.env.PATH } });
    const s = await run(['smoke']);
    expect(s.code).toBe(1);
    expect(s.stderr).toMatch(/--release-pilot/);
    const a = await run(['pilot', '--release-pilot', '--auto-approve-issues']);
    expect(a.code).toBe(1);
    expect(a.stderr).toMatch(/unknown flag --auto-approve-issues/);
  });
});
