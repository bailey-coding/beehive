/**
 * BuildSandbox / ArtifactsGateway: the container is faked (a scripted `exec`), so these assert the commands and
 * the build decisions, not the platform. Real behavior is checked after deploy with GET /sandbox/probe.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} },
  WorkerEntrypoint: class { constructor(public ctx: unknown, public env: unknown) {} },
}));
const createRepoToken = vi.fn(async () => ({ token: 'rt', expiresAt: 1 }));
vi.mock('../../shared/artifacts', () => ({ createRepoToken: (...a: unknown[]) => createRepoToken(...(a as [])) }));

import {
  ArtifactsGateway, BuildError, BuildSandbox, MAX_BUNDLE_BYTES, artifactsHost, isAllowedGitRequest, parseBuildError, validateBuildRequest,
} from '../build-sandbox';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const enc = (s: string) => new TextEncoder().encode(s);

type Script = (cmd: string[]) => { exitCode: number; stdout?: string; stderr?: string } | undefined;

function makeSandbox(script: Script, env: Record<string, string | undefined> = { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'tok' }) {
  const calls: string[][] = [];
  const container = {
    running: false,
    images: { build: 'img' },
    start: vi.fn(function (this: any) { container.running = true; }),
    setInactivityTimeout: vi.fn(async () => {}),
    interceptOutboundHttps: vi.fn(async () => {}),
    destroy: vi.fn(async () => { container.running = false; }),
    exec: vi.fn(async (cmd: string[]) => {
      calls.push(cmd);
      const r = script(cmd) ?? { exitCode: 0 };
      return { output: async () => ({ exitCode: r.exitCode, stdout: enc(r.stdout ?? ''), stderr: enc(r.stderr ?? '') }) };
    }),
  };
  const gateway = vi.fn((o: unknown) => ({ gateway: o }));
  const ctx = { container, exports: { ArtifactsGateway: gateway }, blockConcurrencyWhile: vi.fn() };
  return { sb: new BuildSandbox(ctx as never, env as never), container, calls, gateway };
}

const happy: Script = (cmd) => {
  const line = cmd.join(' ');
  if (line.startsWith('test -f')) return { exitCode: 1 }; // no dist/index.js
  if (line.includes('for f in')) return { exitCode: 0, stdout: 'src/index.ts\n' };
  if (cmd[0] === 'stat') return { exitCode: 0, stdout: '120\n' };
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

  it('allows only a read-only clone of exactly one repository', () => {
    const u = (p: string, q = '') => new URL(`https://h${p}${q}`);
    const base = '/git/default/cand-1.git';
    expect(isAllowedGitRequest('GET', u(`${base}/info/refs`, '?service=git-upload-pack'), 'default', 'cand-1')).toBe(true);
    expect(isAllowedGitRequest('POST', u(`${base}/git-upload-pack`), 'default', 'cand-1')).toBe(true);
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
});

describe('ArtifactsGateway', () => {
  const gw = (props = { repo: 'cand-1', namespace: 'default' }, env: Record<string, string | undefined> = { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'tok' }) =>
    new ArtifactsGateway({ props } as never, env as never);

  beforeEach(() => { createRepoToken.mockClear(); vi.unstubAllGlobals(); });

  it('refuses anything but the one-repo read-only clone, without minting a token', async () => {
    const res = await gw().fetch(new Request('https://h/git/default/cand-1.git/git-receive-pack', { method: 'POST' }));
    expect(res.status).toBe(403);
    expect(createRepoToken).not.toHaveBeenCalled();
  });

  it('adds a short-lived read token to an allowed request and forwards it', async () => {
    const seen: Request[] = [];
    vi.stubGlobal('fetch', vi.fn(async (r: Request) => { seen.push(r); return new Response('ok'); }));
    const res = await gw().fetch(new Request('https://h/git/default/cand-1.git/info/refs?service=git-upload-pack'));
    expect(res.status).toBe(200);
    expect(createRepoToken).toHaveBeenCalledWith({ accountId: 'acct', apiToken: 'tok', namespace: 'default' }, 'cand-1', 'read', 300);
    expect(seen[0].headers.get('Authorization')).toBe('Bearer rt');
  });

  it('answers 503 when credentials are missing', async () => {
    const res = await gw(undefined, {}).fetch(new Request('https://h/git/default/cand-1.git/info/refs?service=git-upload-pack'));
    expect(res.status).toBe(503);
  });
});

describe('BuildSandbox.build', () => {
  it('clones the exact commit through the intercept, bundles src/index.ts, returns it, and destroys the container', async () => {
    const { sb, container, calls, gateway } = makeSandbox(happy);
    const out = await sb.build({ repo: 'cand-1', commitSha: SHA });
    expect(out).toMatchObject({ mainModule: 'index.js', source: 'esbuild', modules: [{ name: 'index.js', content: 'export default {}' }] });
    expect(container.start).toHaveBeenCalledWith(expect.objectContaining({ image: 'img', enableInternet: false }));
    expect(container.interceptOutboundHttps).toHaveBeenCalledWith('acct.artifacts.cloudflare.net', expect.anything());
    expect(gateway).toHaveBeenCalledWith({ props: { repo: 'cand-1', namespace: 'default' } });
    const clone = calls.find((c) => c.includes('clone'))!;
    expect(clone).toContain('https://acct.artifacts.cloudflare.net/git/default/cand-1.git');
    expect(calls.some((c) => c.join(' ').includes(`checkout --quiet ${SHA}`))).toBe(true);
    const bundle = calls.find((c) => c.includes('esbuild'))!;
    expect(bundle).toEqual(expect.arrayContaining(['timeout', '--bundle', '--format=esm']));
    expect(calls.some((c) => c[0] === 'npm')).toBe(false); // no install, so no install scripts run
    expect(container.destroy).toHaveBeenCalled();
  });

  it('uses a committed dist/index.js without running esbuild', async () => {
    const { sb, calls } = makeSandbox((cmd) => (cmd.join(' ').startsWith('test -f') ? { exitCode: 0 } : happy(cmd)));
    expect((await sb.build({ repo: 'cand-1', commitSha: SHA })).source).toBe('prebuilt');
    expect(calls.some((c) => c.includes('esbuild'))).toBe(false);
  });

  it('keeps the git credentials out of the container (no token env, only the CA path)', async () => {
    const { sb, container } = makeSandbox(happy);
    await sb.build({ repo: 'cand-1', commitSha: SHA });
    const opts = container.exec.mock.calls.map((c) => c[1] as { env?: Record<string, string> });
    expect(JSON.stringify(opts)).not.toMatch(/tok|Bearer/);
    expect(opts.some((o) => o.env?.GIT_SSL_CAINFO === '/etc/cloudflare/certs/cloudflare-containers-ca.crt')).toBe(true);
  });

  it.each([
    ['clone fails', (c: string[]) => (c.includes('clone') ? { exitCode: 128, stderr: 'fatal: nope' } : undefined), /CLONE_FAILED/],
    ['no entry file', (c: string[]) => (c.join(' ').startsWith('test -f') ? { exitCode: 1 } : c.join(' ').includes('for f in') ? { exitCode: 0, stdout: '' } : undefined), /NO_ENTRY/],
    ['esbuild fails', (c: string[]) => (c.includes('esbuild') ? { exitCode: 1, stderr: 'error: bad' } : c.join(' ').startsWith('test -f') ? { exitCode: 1 } : c.join(' ').includes('for f in') ? { exitCode: 0, stdout: 'src/index.ts' } : undefined), /BUILD_FAILED.*esbuild failed/],
    ['build times out', (c: string[]) => (c.includes('esbuild') ? { exitCode: 124 } : c.join(' ').startsWith('test -f') ? { exitCode: 1 } : c.join(' ').includes('for f in') ? { exitCode: 0, stdout: 'src/index.ts' } : undefined), /exceeded 60s/],
    ['output too large', (c: string[]) => (c[0] === 'stat' ? { exitCode: 0, stdout: `${MAX_BUNDLE_BYTES + 1}\n` } : happy(c)), /TOO_LARGE/],
    ['empty output', (c: string[]) => (c[0] === 'stat' ? { exitCode: 0, stdout: '0\n' } : happy(c)), /no output/],
  ])('fails with a coded error when %s, and still destroys the container', async (_n, script, re) => {
    const { sb, container } = makeSandbox(script as Script);
    await expect(sb.build({ repo: 'cand-1', commitSha: SHA })).rejects.toThrow(re as RegExp);
    expect(container.destroy).toHaveBeenCalled();
  });

  it('refuses to run without Artifacts credentials, before starting a container', async () => {
    const { sb, container } = makeSandbox(happy, {});
    await expect(sb.build({ repo: 'cand-1', commitSha: SHA })).rejects.toThrow(/NOT_CONFIGURED/);
    expect(container.start).not.toHaveBeenCalled();
  });

  it('rejects a malformed request even when called directly', async () => {
    const { sb, container } = makeSandbox(happy);
    await expect(sb.build({ repo: '../x', commitSha: SHA })).rejects.toThrow(/BAD_REQUEST/);
    expect(container.start).not.toHaveBeenCalled();
  });
});

describe('BuildSandbox.probe', () => {
  it('runs the tool versions and always stops the container', async () => {
    const { sb, container } = makeSandbox(() => ({ exitCode: 0, stdout: 'v24\n0.25.0\n' }));
    expect(await sb.probe()).toMatchObject({ exitCode: 0, stdout: 'v24\n0.25.0\n' });
    expect(container.destroy).toHaveBeenCalled();
  });
});
