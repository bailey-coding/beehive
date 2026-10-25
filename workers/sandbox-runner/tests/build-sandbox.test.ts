/**
 * BuildSandbox / ArtifactsGateway: the container is faked (a scripted `exec`), so these assert the commands, the build
 * decisions, the lifecycle (serialization, alarm, deadline) and the gateway rules, not the platform. Real behavior is
 * checked after deploy against /sandbox/probe and /sandbox/build (docs/OPEN-QUESTIONS.md).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} },
  WorkerEntrypoint: class { constructor(public ctx: unknown, public env: unknown) {} },
}));
const createRepoToken = vi.fn(async (..._a: unknown[]) => ({ token: 'secret-read-token', expiresAt: 1 }));
vi.mock('../../shared/artifacts', () => ({ createRepoToken: (...a: unknown[]) => createRepoToken(...a) }));

import {
  ArtifactsGateway, BUILD_DEADLINE_MS, BuildError, BuildSandbox, MAX_BUNDLE_BYTES, artifactsHost, isAllowedGitRequest, parseBuildError, scrub,
  validateBuildRequest,
} from '../build-sandbox';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const enc = (s: string) => new TextEncoder().encode(s);

type Script = (cmd: string[]) => { exitCode: number; stdout?: string; stderr?: string } | undefined;

function makeSandbox(script: Script, env: Record<string, string | undefined> = { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'tok' }) {
  const calls: string[][] = [];
  const execOpts: Array<{ env?: Record<string, string> } | undefined> = [];
  const container = {
    running: false,
    images: { build: 'img' },
    start: vi.fn(() => { container.running = true; }),
    setInactivityTimeout: vi.fn(async () => {}),
    interceptOutboundHttps: vi.fn(async () => {}),
    destroy: vi.fn(async () => { container.running = false; }),
    exec: vi.fn(async (cmd: string[], opts?: { env?: Record<string, string> }) => {
      calls.push(cmd);
      execOpts.push(opts);
      const r = script(cmd) ?? { exitCode: 0 };
      return { output: async () => ({ exitCode: r.exitCode, stdout: enc(r.stdout ?? ''), stderr: enc(r.stderr ?? '') }) };
    }),
  };
  const gateway = vi.fn((o: unknown) => ({ gateway: o }));
  const storage = { setAlarm: vi.fn(async () => {}), deleteAlarm: vi.fn(async () => {}) };
  const ctx = { container, storage, exports: { ArtifactsGateway: gateway }, blockConcurrencyWhile: vi.fn() };
  return { sb: new BuildSandbox(ctx as never, env as never), container, calls, execOpts, gateway, storage };
}

const happy: Script = (cmd) => {
  const line = cmd.join(' ');
  if (line.startsWith('test -f')) return { exitCode: 1 }; // no dist/index.js
  if (line.includes('for f in')) return { exitCode: 0, stdout: 'src/index.ts\n' };
  if (line.includes('wc -c')) return { exitCode: 0, stdout: '120\n' };
  if (cmd[0] === 'cat') return { exitCode: 0, stdout: 'export default {}' };
  return { exitCode: 0 };
};

describe('validation helpers', () => {
  it('accepts a repo name and a full commit only', () => {
    expect(validateBuildRequest({ repo: 'cand-1.x_y', commitSha: SHA })).toEqual({ repo: 'cand-1.x_y', commitSha: SHA });
    for (const bad of [{ repo: '../etc', commitSha: SHA }, { repo: 'a/b', commitSha: SHA }, { repo: 'a..b', commitSha: SHA }, { repo: 'ok', commitSha: SHA.toUpperCase() }, { repo: 'ok', commitSha: 'main' }, null]) {
      expect(() => validateBuildRequest(bad)).toThrow(/BAD_REQUEST/);
    }
  });

  it('allows only a read-only clone of exactly one repository, with no extra query', () => {
    const u = (p: string, q = '') => new URL(`https://h${p}${q}`);
    const base = '/git/default/cand-1.git';
    expect(isAllowedGitRequest('GET', u(`${base}/info/refs`, '?service=git-upload-pack'), 'default', 'cand-1')).toBe(true);
    expect(isAllowedGitRequest('POST', u(`${base}/git-upload-pack`), 'default', 'cand-1')).toBe(true);
    expect(isAllowedGitRequest('GET', u(`${base}/info/refs`, '?service=git-upload-pack&x=1'), 'default', 'cand-1')).toBe(false);
    expect(isAllowedGitRequest('POST', u(`${base}/git-upload-pack`, '?x=1'), 'default', 'cand-1')).toBe(false);
    expect(isAllowedGitRequest('GET', u(`${base}/info/refs`, '?service=git-receive-pack'), 'default', 'cand-1')).toBe(false);
    expect(isAllowedGitRequest('POST', u(`${base}/git-receive-pack`), 'default', 'cand-1')).toBe(false);
    expect(isAllowedGitRequest('GET', u('/git/default/other.git/info/refs', '?service=git-upload-pack'), 'default', 'cand-1')).toBe(false);
    expect(isAllowedGitRequest('GET', u('/git/prod/cand-1.git/info/refs', '?service=git-upload-pack'), 'default', 'cand-1')).toBe(false);
  });

  it('round-trips the error code through the message', () => {
    expect(parseBuildError(new BuildError('TOO_LARGE', 'big'))).toEqual({ code: 'TOO_LARGE', message: 'big' });
    expect(parseBuildError(new Error('plain'))).toBeNull();
    expect(artifactsHost('acct')).toBe('acct.artifacts.cloudflare.net');
  });

  it('scrubs tool output: ANSI, control characters and Artifacts URLs', () => {
    const raw = '\u001b[31merror\u001b[0m: could not reach https://acct.artifacts.cloudflare.net/git/default/r.git/info/refs\u0007 now';
    const out = scrub(raw, 200);
    expect(out).not.toMatch(/acct|\u001b|\u0007/);
    expect(out).toContain('<artifacts-url>');
    expect(scrub('x'.repeat(500), 10)).toHaveLength(10);
  });
});

describe('ArtifactsGateway', () => {
  const props = { repo: 'cand-1', namespace: 'default', token: 'secret-read-token' };
  const gw = (p: unknown = props) => new ArtifactsGateway({ props: p } as never, {} as never);
  const allowed = () => new Request('https://h/git/default/cand-1.git/info/refs?service=git-upload-pack', {
    headers: { Accept: '*/*', 'X-Evil': '1', Authorization: 'Bearer container-supplied', Cookie: 'a=b', 'Git-Protocol': 'version=2' },
  });

  beforeEach(() => { createRepoToken.mockClear(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('refuses anything but the one-repo read-only clone', async () => {
    const res = await gw().fetch(new Request('https://h/git/default/cand-1.git/git-receive-pack', { method: 'POST' }));
    expect(res.status).toBe(403);
  });

  it('forwards only allowlisted headers, replaces Authorization with the props token, and never mints a token itself', async () => {
    const seen: Request[] = [];
    vi.stubGlobal('fetch', vi.fn(async (r: Request) => { seen.push(r); return new Response('ok'); }));
    const res = await gw().fetch(allowed());
    expect(res.status).toBe(200);
    expect(createRepoToken).not.toHaveBeenCalled();
    expect(seen[0].headers.get('Authorization')).toBe('Bearer secret-read-token');
    expect(seen[0].headers.get('X-Evil')).toBeNull();
    expect(seen[0].headers.get('Cookie')).toBeNull();
    expect(seen[0].headers.get('Git-Protocol')).toBe('version=2');
    expect(seen[0].redirect).toBe('manual');
  });

  it('refuses to hand a redirect back to the container', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example/' } })));
    const res = await gw().fetch(allowed());
    expect(res.status).toBe(502);
    expect(res.headers.get('Location')).toBeNull();
  });

  it('answers 403 when props are missing or invalid (e.g. bound by another worker)', async () => {
    for (const bad of [null, {}, { ...props, repo: '../x' }, { ...props, namespace: 'a/b' }, { ...props, token: '' }]) {
      expect((await gw(bad).fetch(allowed())).status).toBe(403);
    }
  });
});

describe('BuildSandbox.build', () => {
  it('mints one read token, clones the exact commit through the intercept with symlinks and hooks disabled, bundles src/index.ts, and destroys the container', async () => {
    const { sb, container, calls, gateway, execOpts } = makeSandbox(happy);
    const out = await sb.build({ repo: 'cand-1', commitSha: SHA });
    expect(out).toMatchObject({ mainModule: 'index.js', source: 'esbuild', modules: [{ name: 'index.js', content: 'export default {}' }] });
    expect(createRepoToken).toHaveBeenCalledTimes(1);
    expect(createRepoToken).toHaveBeenCalledWith({ accountId: 'acct', apiToken: 'tok', namespace: 'default' }, 'cand-1', 'read', 600);
    expect(container.start).toHaveBeenCalledWith(expect.objectContaining({ image: 'img', enableInternet: false }));
    expect(container.interceptOutboundHttps).toHaveBeenCalledWith('acct.artifacts.cloudflare.net', expect.anything());
    expect(gateway).toHaveBeenCalledWith({ props: { repo: 'cand-1', namespace: 'default', token: 'secret-read-token' } });
    const clone = calls.find((c) => c.includes('clone'))!;
    expect(clone).toContain('https://acct.artifacts.cloudflare.net/git/default/cand-1.git');
    expect(clone).toEqual(expect.arrayContaining(['core.symlinks=false', 'core.hooksPath=/dev/null', 'timeout']));
    const checkout = calls.find((c) => c.includes('checkout'))!;
    expect(checkout).toEqual(expect.arrayContaining(['timeout', 'core.symlinks=false', SHA]));
    const bundle = calls.find((c) => c.includes('esbuild'))!;
    expect(bundle).toEqual(expect.arrayContaining(['timeout', '--bundle', '--format=esm', '--tsconfig-raw={}']));
    expect(calls.some((c) => c[0] === 'npm')).toBe(false); // no install, so no install scripts run
    const gitEnv = execOpts.find((o) => o?.env?.GIT_SSL_CAINFO)!.env!;
    expect(gitEnv).toMatchObject({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_SSL_CAINFO: '/etc/cloudflare/certs/cloudflare-containers-ca.crt' });
    expect(container.destroy).toHaveBeenCalled();
  });

  it('never puts the read token into any command or environment of the container', async () => {
    const { sb, calls, execOpts } = makeSandbox(happy);
    await sb.build({ repo: 'cand-1', commitSha: SHA });
    expect(JSON.stringify([calls, execOpts])).not.toMatch(/secret-read-token|Bearer/);
  });

  it('removes a stale workdir before cloning (a restarted instance may have left one)', async () => {
    const { sb, calls } = makeSandbox(happy);
    await sb.build({ repo: 'cand-1', commitSha: SHA });
    const rm = calls.findIndex((c) => c[0] === 'rm');
    expect(rm).toBeGreaterThanOrEqual(0);
    expect(rm).toBeLessThan(calls.findIndex((c) => c.includes('clone')));
  });

  it('uses a committed dist/index.js without running esbuild', async () => {
    const { sb, calls } = makeSandbox((cmd) => (cmd.join(' ').startsWith('test -f') ? { exitCode: 0 } : happy(cmd)));
    expect((await sb.build({ repo: 'cand-1', commitSha: SHA })).source).toBe('prebuilt');
    expect(calls.some((c) => c.includes('esbuild'))).toBe(false);
  });

  it.each([
    ['clone fails', (c: string[]) => (c.includes('clone') ? { exitCode: 128, stderr: 'fatal: https://acct.artifacts.cloudflare.net/x nope' } : undefined), /CLONE_FAILED: git clone failed \(exit 128\)/],
    ['commit not found', (c: string[]) => (c.includes('checkout') ? { exitCode: 128, stderr: 'fatal: unable to read tree' } : undefined), /CLONE_FAILED: the commit was not found/],
    ['no entry file', (c: string[]) => (c.join(' ').startsWith('test -f') ? { exitCode: 1 } : c.join(' ').includes('for f in') ? { exitCode: 0, stdout: '' } : undefined), /NO_ENTRY/],
    ['esbuild fails', (c: string[]) => (c.includes('esbuild') ? { exitCode: 1, stderr: 'error: bad' } : c.join(' ').startsWith('test -f') ? { exitCode: 1 } : c.join(' ').includes('for f in') ? { exitCode: 0, stdout: 'src/index.ts' } : undefined), /BUILD_FAILED: esbuild failed \(exit 1\): error: bad/],
    ['build times out', (c: string[]) => (c.includes('esbuild') ? { exitCode: 124 } : c.join(' ').startsWith('test -f') ? { exitCode: 1 } : c.join(' ').includes('for f in') ? { exitCode: 0, stdout: 'src/index.ts' } : undefined), /stopped after 60s or killed \(exit 124\)/],
    ['output too large', (c: string[]) => (c.join(' ').includes('wc -c') ? { exitCode: 0, stdout: `${MAX_BUNDLE_BYTES + 1}\n` } : happy(c)), /TOO_LARGE/],
    ['empty output', (c: string[]) => (c.join(' ').includes('wc -c') ? { exitCode: 0, stdout: '0\n' } : happy(c)), /no output/],
  ])('fails with a coded error when %s, without leaking tool output or URLs, and still destroys the container', async (_n, script, re) => {
    const { sb, container } = makeSandbox(script as Script);
    const err = await sb.build({ repo: 'cand-1', commitSha: SHA }).then(() => null, (e: Error) => e);
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(re as RegExp);
    expect(err!.message).not.toMatch(/artifacts\.cloudflare\.net|acct/);
    expect(container.destroy).toHaveBeenCalled();
  });

  it('refuses to run without Artifacts credentials, before starting a container', async () => {
    const { sb, container } = makeSandbox(happy, {});
    await expect(sb.build({ repo: 'cand-1', commitSha: SHA })).rejects.toThrow(/NOT_CONFIGURED/);
    expect(container.start).not.toHaveBeenCalled();
  });

  it('fails with CLONE_FAILED, and starts nothing, when the read token cannot be minted', async () => {
    createRepoToken.mockRejectedValueOnce(new Error('403 forbidden'));
    const { sb, container } = makeSandbox(happy);
    await expect(sb.build({ repo: 'cand-1', commitSha: SHA })).rejects.toThrow(/CLONE_FAILED: could not obtain read access/);
    expect(container.start).not.toHaveBeenCalled();
  });

  it('rejects a malformed request even when called directly', () => {
    const { sb, container } = makeSandbox(happy);
    expect(() => sb.build({ repo: '../x', commitSha: SHA })).toThrow(/BAD_REQUEST/);
    expect(container.start).not.toHaveBeenCalled();
  });
});

describe('BuildSandbox lifecycle', () => {
  beforeEach(() => { createRepoToken.mockClear(); });

  it('runs builds of different commits one at a time on one instance, and each destroys only its own container', async () => {
    let active = 0;
    let maxActive = 0;
    const { sb, container } = makeSandbox((cmd) => {
      if (cmd.includes('clone')) { active++; maxActive = Math.max(maxActive, active); }
      if (cmd.join(' ').includes('wc -c')) active--;
      return happy(cmd);
    });
    const results = await Promise.all(['1', '2', '3'].map((c) => sb.build({ repo: 'cand-1', commitSha: c.repeat(40) })));
    expect(results).toHaveLength(3);
    expect(maxActive).toBe(1);
    expect(container.destroy).toHaveBeenCalledTimes(3);
    expect(container.start).toHaveBeenCalledTimes(3);
  });

  it('shares one running build between repeat calls for the same commit (a retry after a caller timeout) and builds a new commit separately', async () => {
    const { sb, container } = makeSandbox(happy);
    const [a, b] = await Promise.all([sb.build({ repo: 'cand-1', commitSha: SHA }), sb.build({ repo: 'cand-1', commitSha: SHA })]);
    expect(b).toBe(a);
    expect(container.start).toHaveBeenCalledTimes(1);
    expect(createRepoToken).toHaveBeenCalledTimes(1);
    const other = await sb.build({ repo: 'cand-1', commitSha: 'f'.repeat(40) });
    expect(other).not.toBe(a);
    expect(container.start).toHaveBeenCalledTimes(2);
    // once finished, the same commit builds again (nothing is cached)
    await sb.build({ repo: 'cand-1', commitSha: SHA });
    expect(container.start).toHaveBeenCalledTimes(3);
  });

  it('keeps serving after a failed build (the queue is not poisoned)', async () => {
    let first = true;
    const { sb } = makeSandbox((cmd) => (cmd.includes('clone') && first ? ((first = false), { exitCode: 128 }) : happy(cmd)));
    const a = sb.build({ repo: 'cand-1', commitSha: SHA });
    const b = sb.build({ repo: 'cand-1', commitSha: 'e'.repeat(40) });
    await expect(a).rejects.toThrow(/CLONE_FAILED/);
    await expect(b).resolves.toMatchObject({ source: 'esbuild' });
  });

  it('sets an alarm backstop for the build and clears it afterwards; the alarm destroys a leftover container', async () => {
    const { sb, container, storage } = makeSandbox(happy);
    await sb.build({ repo: 'cand-1', commitSha: SHA });
    expect(storage.setAlarm).toHaveBeenCalledTimes(1);
    expect(storage.setAlarm.mock.calls[0]![0]).toBeGreaterThan(Date.now() + BUILD_DEADLINE_MS);
    expect(storage.deleteAlarm).toHaveBeenCalled();
    container.running = true; // a container left behind by a restart
    await sb.alarm();
    expect(container.destroy).toHaveBeenCalledTimes(2);
  });

  it('stops a build that hangs: the deadline rejects, the container is destroyed', async () => {
    vi.useFakeTimers();
    try {
      const { sb, container } = makeSandbox((cmd) => (cmd.includes('clone') ? undefined : happy(cmd)));
      container.exec.mockImplementationOnce(async () => ({ output: async () => ({ exitCode: 0, stdout: enc(''), stderr: enc('') }) })); // rm -rf
      container.exec.mockImplementationOnce(() => new Promise(() => {})); // clone never returns
      const p = sb.build({ repo: 'cand-1', commitSha: SHA });
      const assertion = expect(p).rejects.toThrow(/BUILD_FAILED: the build exceeded 150s/);
      await vi.advanceTimersByTimeAsync(BUILD_DEADLINE_MS + 1);
      await assertion;
      expect(container.destroy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('BuildSandbox.probe', () => {
  it('runs the tool versions and always stops the container', async () => {
    const { sb, container } = makeSandbox(() => ({ exitCode: 0, stdout: 'v24\n0.25.0\n' }));
    expect(await sb.probe()).toMatchObject({ exitCode: 0, stdout: 'v24\n0.25.0\n' });
    expect(container.destroy).toHaveBeenCalled();
  });
});
