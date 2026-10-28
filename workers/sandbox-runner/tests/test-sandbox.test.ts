/**
 * TestSandbox / NpmRegistryGateway: the container is faked (a scripted `exec`), so these assert the commands, the verdict
 * decisions, the network phases and the lifecycle, not the platform. The real container path was measured by the spike
 * (docs/OPEN-QUESTIONS.md 2026-10-28) and is re-verified only by the production run.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} },
  WorkerEntrypoint: class { constructor(public ctx: unknown, public env: unknown) {} },
}));
const createRepoToken = vi.fn(async (..._a: unknown[]) => ({ token: 'secret-read-token', expiresAt: 1 }));
vi.mock('../../shared/artifacts', () => ({ createRepoToken: (...a: unknown[]) => createRepoToken(...a) }));

import { spawnSync } from 'node:child_process';
import {
  NpmRegistryGateway, PHASE_SCRIPT, TestSandbox, TEST_DEADLINE_MS, parseCounts, parseTestError, validateTestRequest,
} from '../test-sandbox';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const enc = (s: string) => new TextEncoder().encode(s);
const HASH = 'ab'.repeat(32);

type Script = (cmd: string[], opts?: { env?: Record<string, string>; cwd?: string }) => { exitCode: number; stdout?: string; stderr?: string } | undefined;
/** Phase wrapper: sh -c SCRIPT sh <log> <cpu> <limit> ...argv (argv from index 7); the script folds the limit and the timeout in, see PHASE_SCRIPT */
const phaseArgv = (cmd: string[]) => (cmd[0] === 'sh' && cmd[1] === '-c' ? cmd.slice(7) : null);

function makeSandbox(script: Script, env: Record<string, string | undefined> = { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'tok' }) {
  const calls: string[][] = [];
  const execOpts: Array<{ env?: Record<string, string>; cwd?: string } | undefined> = [];
  const events: string[] = [];
  const container = {
    running: false,
    images: { test: 'registry.cloudflare.com/acct/repo@sha256:' + 'c'.repeat(64) },
    start: vi.fn((_o: unknown) => { container.running = true; events.push('start'); }),
    setInactivityTimeout: vi.fn(async () => {}),
    interceptOutboundHttps: vi.fn(async (host: string, _f: unknown) => { events.push(`intercept ${host}`); }),
    destroy: vi.fn(async () => { container.running = false; events.push('destroy'); }),
    exec: vi.fn(async (cmd: string[], opts?: { env?: Record<string, string>; cwd?: string }) => {
      calls.push(cmd);
      execOpts.push(opts);
      const argv = phaseArgv(cmd);
      if (argv) events.push(`phase ${cmd[4].split('/').pop()} ${argv.join(' ')}`);
      const r = script(cmd, opts) ?? { exitCode: 0 };
      return { output: async () => ({ exitCode: r.exitCode, stdout: enc(r.stdout ?? ''), stderr: enc(r.stderr ?? '') }) };
    }),
  };
  const gateway = vi.fn((o: unknown) => ({ npm: o }));
  const artifacts = vi.fn((o: unknown) => ({ artifacts: o }));
  const storage = { setAlarm: vi.fn(async () => {}), deleteAlarm: vi.fn(async () => {}) };
  const ctx = { container, storage, exports: { NpmRegistryGateway: gateway, ArtifactsGateway: artifacts }, blockConcurrencyWhile: vi.fn() };
  return { sb: new TestSandbox(ctx as never, env as never), container, calls, execOpts, events, gateway, artifacts, storage };
}

const logs = (testLog = 'Tests  3 passed (3)\n'): Script => (cmd) => {
  if (cmd[0] === 'tail') return { exitCode: 0, stdout: cmd[3].endsWith('test.log') ? testLog : 'added 199 packages\n' };
  if (cmd[0] === 'wc') return { exitCode: 0, stdout: `100 ${cmd[2]}\n` };
  if (cmd[0] === 'sha256sum') return { exitCode: 0, stdout: `${HASH}  ${cmd[1]}\n` };
  return undefined;
};
const happy = (over: Script = () => undefined, testLog?: string): Script => (cmd, o) => over(cmd, o) ?? logs(testLog)(cmd, o);
const isInstall = (cmd: string[]) => phaseArgv(cmd)?.[0] === 'npm' && phaseArgv(cmd)?.[1] === 'ci';
const isTest = (cmd: string[]) => phaseArgv(cmd)?.[0] === 'npm' && phaseArgv(cmd)?.[1] === 'test';
const req = { repo: 'cand-1', commitSha: SHA };

beforeEach(() => { createRepoToken.mockClear(); });

describe('validateTestRequest', () => {
  it('defaults installDirs to the root and dedupes', () => {
    expect(validateTestRequest(req)).toEqual({ ...req, installDirs: ['.'] });
    expect(validateTestRequest({ ...req, installDirs: ['.', 'cli', 'cli', 'workers/api'] }).installDirs).toEqual(['.', 'cli', 'workers/api']);
  });
  it('rejects directories that escape the repo, and malformed commands', () => {
    for (const d of ['..', '../x', '/etc', 'a/../b', 'a//b', 'a b', './x', '', 5, 'a\nb']) {
      expect(() => validateTestRequest({ ...req, installDirs: [d] }), String(d)).toThrow(/BAD_REQUEST/);
    }
    expect(() => validateTestRequest({ ...req, installDirs: [] })).toThrow(/BAD_REQUEST/);
    for (const c of [['--help'], ['-e', 'x'], [], [''], ['npm', 5], 'npm test', ['a\0b']]) expect(() => validateTestRequest({ ...req, testCommand: c })).toThrow(/BAD_REQUEST/);
    expect(validateTestRequest({ ...req, testCommand: ['npx', 'vitest', 'run'] }).testCommand).toEqual(['npx', 'vitest', 'run']);
  });
  it('transports its error code through a plain Error', () => {
    expect(parseTestError(new Error('BAD_NAMESPACE: x'))).toEqual({ code: 'BAD_NAMESPACE', message: 'x' });
    expect(parseTestError(new Error('boom'))).toBeNull();
  });
});

describe('parseCounts', () => {
  it('reads vitest and jest summaries, the last one wins, ANSI ignored', () => {
    expect(parseCounts(' Test Files  2 passed (2)\n      Tests  1380 passed | 30 skipped (1410)\n')).toEqual({ passed: 1380, failed: 0, skipped: 30 });
    expect(parseCounts('Tests:       1 failed, 5 passed, 6 total')).toEqual({ passed: 5, failed: 1, skipped: 0 });
    expect(parseCounts('\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[32m7 passed\u001b[39m\u001b[22m (7)')).toEqual({ passed: 7, failed: 0, skipped: 0 });
    expect(parseCounts('Tests  1 passed\nTests  2 failed | 4 passed')).toEqual({ passed: 4, failed: 2, skipped: 0 });
  });
  it('is null without a summary line, and reports zero tests', () => {
    expect(parseCounts('all good\n')).toBeNull();
    expect(parseCounts('Tests  no tests')).toBeNull();
    expect(parseCounts('Tests:       0 total')).toEqual({ passed: 0, failed: 0, skipped: 0 });
  });
});

describe('TestSandbox verdicts', () => {
  it('passes: standard-2 via start only, install then deny then test, order and shapes', async () => {
    const { sb, container, events, calls, execOpts } = makeSandbox(happy());
    const r = await sb.test({ ...req, installDirs: ['.', 'cli'] });
    expect(r).toMatchObject({
      status: 'pass', failureClass: null, exitCode: 0, truncated: false, instance: 'standard-2', logSha256: HASH,
      counts: { passed: 3, failed: 0, skipped: 0 }, imageDigest: `sha256:${'c'.repeat(64)}`,
      phases: { install: { exit: 0, timedOut: false }, test: { exit: 0, timedOut: false } },
    });
    expect(container.start).toHaveBeenCalledTimes(1);
    expect(container.start.mock.calls[0][0]).toMatchObject({ instance: 'standard-2', enableInternet: false, image: container.images.test });
    const order = events.filter((e) => e.startsWith('phase') || e.startsWith('intercept') || e === 'start' || e === 'destroy').map((e) => e.replace(/^phase (\S+) .*$/, 'phase $1'));
    expect(order).toEqual([
      'start', 'intercept registry.npmjs.org', 'intercept acct.artifacts.cloudflare.net', 'phase install.log', 'phase install.log',
      'intercept registry.npmjs.org', 'intercept acct.artifacts.cloudflare.net', 'phase test.log', 'destroy',
    ]);
    // one npm ci per directory, run in that directory
    const installs = calls.map((c, i) => ({ c, o: execOpts[i] })).filter(({ c }) => isInstall(c));
    expect(installs.map(({ o }) => o?.cwd)).toEqual(['/workspace/cand', '/workspace/cand/cli']);
    expect(installs[0].c).toEqual(expect.arrayContaining(['--ignore-scripts', '--no-audit', '--no-fund', '--registry', 'https://registry.npmjs.org/']));
  });

  it('wraps every phase in the constant limit script, with the argv positional and under timeout --kill-after', async () => {
    const { sb, calls } = makeSandbox(happy());
    await sb.test(req);
    const phases = calls.filter((c) => phaseArgv(c));
    expect(phases).toHaveLength(2);
    for (const p of phases) {
      expect(p[2]).toMatch(/ulimit -u 512.*ulimit -t.*ulimit -f/);
      expect(p[2]).toContain('timeout --kill-after=5 "$lim" "$@"');
      expect(p[2]).not.toMatch(/npm|cand/); // no repo-derived text in the script
      // the ulimit lines run in a group whose output goes to the log, and a failure there is exit 125
      expect(p[2]).toMatch(/\{ ulimit -u 512 && .*; \} >>"\$log" 2>&1 \|\| exit 125/);
      expect(p.slice(5, 6)).toEqual([expect.stringMatching(/^\d+$/)]);
    }
    expect(phases[0][6]).toBe('120'); // install budget
    expect(phases[1].slice(6)).toEqual(['300', 'npm', 'test']);
  });

  it('runs a custom test command as given', async () => {
    const { sb, calls } = makeSandbox(happy());
    await sb.test({ ...req, testCommand: ['npx', 'vitest', 'run'] });
    expect(phaseArgv(calls.filter((c) => phaseArgv(c)).at(-1)!)).toEqual(['npx', 'vitest', 'run']);
  });

  it('uses two distinct empty npm config files, deletes the repo .npmrc, and keeps the token out of every command and env', async () => {
    const { sb, calls, execOpts } = makeSandbox(happy());
    await sb.test({ ...req, installDirs: ['.', 'cli'] });
    const installEnv = execOpts[calls.findIndex(isInstall)]!.env!;
    expect(installEnv.NPM_CONFIG_USERCONFIG).not.toBe(installEnv.NPM_CONFIG_GLOBALCONFIG);
    expect(installEnv.NODE_EXTRA_CA_CERTS).toMatch(/cloudflare-containers-ca\.crt$/);
    const touch = calls.find((c) => c[0] === 'touch')!;
    expect(touch.slice(1)).toEqual([installEnv.NPM_CONFIG_USERCONFIG, installEnv.NPM_CONFIG_GLOBALCONFIG]);
    expect(calls).toContainEqual(['find', '/workspace/cand', '-name', '.npmrc', '-not', '-path', '*/node_modules/*', '-delete']);
    expect(calls.findIndex((c) => c[0] === 'find')).toBeLessThan(calls.findIndex(isInstall));
    expect(JSON.stringify([calls, execOpts])).not.toContain('secret-read-token');
    expect(JSON.stringify([calls, execOpts])).not.toContain('tok"');
    // the test phase env is cleared down to a short list (no CA bundle, no secrets)
    const testEnv = execOpts[calls.findIndex(isTest)]!.env!;
    expect(Object.keys(testEnv).sort()).toEqual(['CI', 'HOME', 'NPM_CONFIG_CACHE', 'NPM_CONFIG_GLOBALCONFIG', 'NPM_CONFIG_USERCONFIG', 'PATH']);
  });

  it('fails with tests_failed on a non-zero test exit and keeps the log', async () => {
    const { sb } = makeSandbox(happy((c) => (isTest(c) ? { exitCode: 1 } : undefined), 'Tests  2 failed | 1 passed\n'));
    expect(await sb.test(req)).toMatchObject({ status: 'fail', failureClass: 'tests_failed', exitCode: 1, counts: { failed: 2 }, logTail: expect.stringContaining('2 failed') });
  });

  it('fails with install_failed and never runs tests', async () => {
    const { sb, calls, container } = makeSandbox(happy((c) => (isInstall(c) ? { exitCode: 1 } : undefined)));
    const r = await sb.test(req);
    expect(r).toMatchObject({ status: 'fail', failureClass: 'install_failed', exitCode: 1, phases: { test: null }, logTail: expect.stringContaining('199 packages') });
    expect(calls.some(isTest)).toBe(false);
    expect(container.destroy).toHaveBeenCalled();
  });

  it('stops at the first failing install directory', async () => {
    const { sb, calls } = makeSandbox(happy((c, o) => (isInstall(c) && o?.cwd?.endsWith('/cli') ? { exitCode: 1 } : undefined)));
    await sb.test({ ...req, installDirs: ['.', 'cli', 'workers/api'] });
    expect(calls.filter(isInstall)).toHaveLength(2);
  });

  it('answers no_lockfile for a missing lockfile in ANY directory, before installing anything', async () => {
    const { sb, calls } = makeSandbox(happy((c) => (c[0] === 'test' && c[2].endsWith('/cli/package-lock.json') ? { exitCode: 1 } : undefined)));
    expect(await sb.test({ ...req, installDirs: ['.', 'cli'] })).toMatchObject({ status: 'fail', failureClass: 'no_lockfile' });
    expect(calls.some(isInstall)).toBe(false);
  });

  it('classifies a timed-out install and a timed-out test (exit 124 from the wrapper)', async () => {
    expect(await makeSandbox(happy((c) => (isInstall(c) ? { exitCode: 124 } : undefined))).sb.test(req))
      .toMatchObject({ status: 'fail', failureClass: 'timeout_install', phases: { install: { timedOut: true } } });
    expect(await makeSandbox(happy((c) => (isTest(c) ? { exitCode: 124 } : undefined))).sb.test(req))
      .toMatchObject({ status: 'fail', failureClass: 'timeout_test', phases: { test: { timedOut: true } } });
  });

  it('treats exit 125 from the wrapper (limits not applied) as SANDBOX_UNAVAILABLE, not a verdict', async () => {
    const i = makeSandbox(happy((c) => (isInstall(c) ? { exitCode: 125 } : undefined)));
    await expect(i.sb.test(req)).rejects.toThrow(/^SANDBOX_UNAVAILABLE/);
    expect(i.container.destroy).toHaveBeenCalled();
    const t = makeSandbox(happy((c) => (isTest(c) ? { exitCode: 125 } : undefined)));
    await expect(t.sb.test(req)).rejects.toThrow(/^SANDBOX_UNAVAILABLE/);
  });

  it('classifies an outside SIGKILL (exit 137, no timeout) as killed, never as a timeout', async () => {
    expect(await makeSandbox(happy((c) => (isTest(c) ? { exitCode: 137 } : undefined))).sb.test(req))
      .toMatchObject({ status: 'fail', failureClass: 'killed', exitCode: 137, phases: { test: { timedOut: false } } });
    expect(await makeSandbox(happy((c) => (isInstall(c) ? { exitCode: 137 } : undefined))).sb.test(req))
      .toMatchObject({ status: 'fail', failureClass: 'killed', phases: { install: { timedOut: false } } });
  });

  it('the wrapper script maps statuses: 124 for a timeout (also 137 after the limit), 1 for a child 125, 137 passthrough when early', () => {
    const run = (lim: string, ...argv: string[]) => spawnSync('sh', ['-c', PHASE_SCRIPT, 'sh', '/dev/null', '60', lim, ...argv]).status;
    if (run('5', 'true') !== 0) return; // this host cannot apply the limits (e.g. already past 512 processes): nothing to assert
    expect(run('1', 'sleep', '5')).toBe(124);
    expect(run('1', 'sh', '-c', 'trap "" TERM; sleep 20')).toBe(124); // needs the KILL: timeout itself says 137, the elapsed limit makes it 124
    expect(run('5', 'sh', '-c', 'exit 125')).toBe(1);
    expect(run('5', 'sh', '-c', 'exit 3')).toBe(3);
    expect(run('5', 'sh', '-c', 'kill -9 $$')).toBe(137);
  });

  it('gives each install directory only what is left of the 120 s install budget', async () => {
    vi.useFakeTimers();
    try {
      const { sb, calls } = makeSandbox(happy((c) => { if (isInstall(c)) vi.setSystemTime(Date.now() + 50_000); return undefined; }));
      const p = sb.test({ ...req, installDirs: ['.', 'cli', 'workers/api'] });
      await vi.advanceTimersByTimeAsync(0);
      const r = await p;
      const limits = calls.filter(isInstall).map((c) => Number(c[6]));
      expect(limits).toEqual([120, 70, 20]);
      expect(r.status).toBe('pass');
    } finally { vi.useRealTimers(); }
  });

  it('reports no_tests when the summary says zero passed, and pass with counts null when there is no summary', async () => {
    expect(await makeSandbox(happy(undefined, 'Tests:       0 total\n')).sb.test(req)).toMatchObject({ status: 'fail', failureClass: 'no_tests', exitCode: 0 });
    expect(await makeSandbox(happy(undefined, 'ok\n')).sb.test(req)).toMatchObject({ status: 'pass', counts: null });
  });

  it('caps and scrubs the log: tail -c 32768, truncated flag, ANSI and artifact URLs removed', async () => {
    const { sb, calls } = makeSandbox(happy((c) => {
      if (c[0] === 'wc') return { exitCode: 0, stdout: '99999 f\n' };
      return undefined;
    }, '\u001b[31mred\u001b[0m see https://acct.artifacts.cloudflare.net/git/x.git now\nTests  1 passed\n'));
    const r = await sb.test(req);
    expect(calls).toContainEqual(['tail', '-c', '32768', '/workspace/log/test.log']);
    expect(r.truncated).toBe(true);
    expect(r.logTail).toContain('red see <artifacts-url> now');
    expect(r.logTail).not.toContain('\u001b');
  });

  it('answers clone_failed as an error verdict and never installs', async () => {
    const { sb, calls } = makeSandbox(happy((c) => (c.includes('clone') ? { exitCode: 128, stderr: 'fatal' } : undefined)));
    expect(await sb.test(req)).toMatchObject({ status: 'error', failureClass: 'clone_failed', exitCode: 128 });
    expect(calls.some(isInstall)).toBe(false);
  });
});

describe('TestSandbox failures and lifecycle', () => {
  it('throws NOT_CONFIGURED without credentials or with a bad namespace fallback, before starting a container', async () => {
    const a = makeSandbox(happy(), {});
    await expect(a.sb.test(req)).rejects.toThrow(/^NOT_CONFIGURED/);
    expect(a.container.start).not.toHaveBeenCalled();
    const b = makeSandbox(happy(), { CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't', ARTIFACTS_NAMESPACE: 'bad.ns' });
    await expect(b.sb.test(req)).rejects.toThrow(/^NOT_CONFIGURED/);
  });

  it('throws SANDBOX_UNAVAILABLE when the token cannot be minted or the container cannot start, and still destroys', async () => {
    createRepoToken.mockRejectedValueOnce(new Error('403'));
    await expect(makeSandbox(happy()).sb.test(req)).rejects.toThrow(/^SANDBOX_UNAVAILABLE/);
    const s = makeSandbox(happy());
    s.container.start.mockImplementationOnce(() => { throw new Error('no capacity'); });
    await expect(s.sb.test(req)).rejects.toThrow(/^SANDBOX_UNAVAILABLE/);
    expect(s.storage.deleteAlarm).toHaveBeenCalled();
  });

  it('never runs the tests when the network could not be closed', async () => {
    const s = makeSandbox(happy());
    let swaps = 0;
    s.container.interceptOutboundHttps.mockImplementation(async (host: string) => { if (host === 'registry.npmjs.org' && ++swaps === 2) throw new Error('swap failed'); });
    await expect(s.sb.test(req)).rejects.toThrow(/^SANDBOX_UNAVAILABLE/);
    expect(s.calls.some(isTest)).toBe(false);
    expect(s.container.destroy).toHaveBeenCalled();
  });

  it('installs the registry gateway first and a deny handler for both hosts afterwards', async () => {
    const { sb, gateway, artifacts } = makeSandbox(happy());
    await sb.test(req);
    expect(gateway.mock.calls.map((c) => c[0])).toEqual([{ props: {} }, { props: { deny: true } }]);
    expect(artifacts).toHaveBeenCalledWith({ props: { repo: 'cand-1', namespace: 'default', token: 'secret-read-token' } });
  });

  it('answers timeout_overall as an error verdict at the 600 s deadline and destroys the container', async () => {
    vi.useFakeTimers();
    try {
      const { sb, container } = makeSandbox(happy((c) => (isTest(c) ? { exitCode: 0 } : undefined)));
      container.exec.mockImplementation(async (cmd: string[]) => {
        if (isTest(cmd)) return new Promise(() => {}) as never; // hangs forever
        return { output: async () => ({ exitCode: 0, stdout: enc(''), stderr: enc('') }) } as never;
      });
      const p = sb.test(req);
      let r: unknown;
      void p.then((v) => { r = v; });
      for (let i = 0; i < 400 && r === undefined; i++) await vi.advanceTimersByTimeAsync(TEST_DEADLINE_MS / 100);
      expect(r).toMatchObject({ status: 'error', failureClass: 'timeout_overall' });
      expect(container.destroy).toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('serializes calls on one instance, and shares an identical in-flight run', async () => {
    const { sb, container } = makeSandbox(happy());
    const [a, b] = await Promise.all([sb.test(req), sb.test(req)]);
    expect(a).toBe(b);
    expect(container.start).toHaveBeenCalledTimes(1);
    await sb.test({ ...req, commitSha: 'f'.repeat(40) });
    expect(container.start).toHaveBeenCalledTimes(2);
  });

  it('sets the alarm backstop beyond the deadline and clears it', async () => {
    const { sb, storage } = makeSandbox(happy());
    const before = Date.now();
    await sb.test(req);
    expect((storage.setAlarm.mock.calls[0] as unknown as [number])[0]).toBeGreaterThanOrEqual(before + TEST_DEADLINE_MS + 60_000);
    expect(storage.deleteAlarm).toHaveBeenCalled();
  });
});

describe('NpmRegistryGateway', () => {
  const upstream = vi.fn<(r: Request) => Promise<Response>>();
  beforeEach(() => { upstream.mockReset(); upstream.mockResolvedValue(new Response('{}', { status: 200 })); vi.stubGlobal('fetch', upstream); });
  afterEach(() => { vi.unstubAllGlobals(); });
  const gw = (props: unknown) => new NpmRegistryGateway({ props } as never, {} as never);
  const call = (props: unknown, url: string, init?: RequestInit) => gw(props).fetch(new Request(url, init));

  it('passes a GET on the registry host, without credentials or cookies, and refuses redirects', async () => {
    const res = await call({}, 'https://registry.npmjs.org/left-pad', { headers: { accept: 'application/json', authorization: 'Bearer x', cookie: 'a=b', 'user-agent': 'npm' } });
    expect(res.status).toBe(200);
    const sent = upstream.mock.calls[0][0];
    expect(sent.redirect).toBe('manual');
    expect(sent.headers.get('authorization')).toBeNull();
    expect(sent.headers.get('cookie')).toBeNull();
    expect(sent.headers.get('accept')).toBe('application/json');
    upstream.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }));
    expect((await call({}, 'https://registry.npmjs.org/x')).status).toBe(502);
  });

  it('denies other hosts, other methods and plain http without calling upstream', async () => {
    for (const [url, init] of [
      ['https://evil.example/x', undefined], ['https://registry.npmjs.org.evil.example/x', undefined], ['https://registry.yarnpkg.com/x', undefined],
      ['https://registry.npmjs.org/x', { method: 'POST', body: 'x' }], ['https://registry.npmjs.org/x', { method: 'PUT', body: 'x' }],
      ['https://registry.npmjs.org/x', { method: 'HEAD' }], ['http://registry.npmjs.org/x', undefined],
    ] as Array<[string, RequestInit | undefined]>) {
      expect((await call({}, url, init)).status, `${init?.method ?? 'GET'} ${url}`).toBe(403);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it('is a total deny handler with the deny prop, even for the registry', async () => {
    expect((await call({ deny: true }, 'https://registry.npmjs.org/left-pad')).status).toBe(403);
    expect((await call({ deny: true }, 'https://acct.artifacts.cloudflare.net/git/x')).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });
});
