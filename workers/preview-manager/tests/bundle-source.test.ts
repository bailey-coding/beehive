import { describe, it, expect, vi } from 'vitest';
import { SandboxBuildError, sandboxBundleSource } from '../bundle-source';

const SHA = 'a'.repeat(40);
const input = { workerName: 'beehive-candidate-c1', candidateId: 'c1', commitSha: SHA, repoName: 'repo-1', repoNamespace: 'default' };
const okBundle = { mainModule: 'index.js', modules: [{ name: 'index.js', content: 'export default {}' }], compatibilityDate: '2026-10-01', source: 'esbuild' };
const runner = (res: Response | Error) => ({ fetch: vi.fn(async () => { if (res instanceof Error) throw res; return res; }) });
const j = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const asFetcher = (r: ReturnType<typeof runner>) => r as unknown as Fetcher;

describe('sandboxBundleSource', () => {
  it('posts repo and full commit with the bearer token and returns the bundle', async () => {
    const r = runner(j({ success: true, bundle: okBundle, namespace: 'default' }));
    const out = await sandboxBundleSource(asFetcher(r), 'tok')(input);
    expect(out).toEqual({ mainModule: 'index.js', modules: [{ name: 'index.js', content: 'export default {}' }], compatibilityDate: '2026-10-01' });
    const [url, init] = r.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://sandbox-runner.internal/sandbox/build');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body as string)).toEqual({ repo: 'repo-1', commitSha: SHA, namespace: 'default' });
  });

  it('sends a fork namespace and requires the runner to echo exactly that namespace', async () => {
    const fork = { ...input, repoNamespace: 'my-org' };
    const ok = runner(j({ success: true, bundle: okBundle, namespace: 'my-org' }));
    await sandboxBundleSource(asFetcher(ok), 'tok')(fork);
    expect(JSON.parse((ok.fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ namespace: 'my-org' });
    // an older runner ignores the field and answers without an echo (it built default/<repo>): refused, also for 'default'
    for (const [i, echo] of [[fork, undefined], [input, undefined], [fork, 'default'], [input, 'other']] as const) {
      const r = runner(j({ success: true, bundle: okBundle, ...(echo ? { namespace: echo } : {}) }));
      await expect(sandboxBundleSource(asFetcher(r), 'tok')(i)).rejects.toMatchObject({ code: 'UNAVAILABLE', status: 502, message: expect.stringContaining('namespace') });
    }
  });

  it('refuses a missing or invalid namespace before calling the build service (422, not the candidate\'s fault)', async () => {
    const r = runner(j({ success: true, bundle: okBundle, namespace: 'default' }));
    for (const repoNamespace of [undefined, '', 'my.org', '_x', 'a b', 'x'.repeat(65), 'a/b']) {
      await expect(sandboxBundleSource(asFetcher(r), 'tok')({ ...input, repoNamespace })).rejects.toMatchObject({ code: 'BAD_NAMESPACE', status: 422 });
    }
    expect(r.fetch).not.toHaveBeenCalled();
  });

  it('refuses to call the build service without a repo, a full commit or a token', async () => {
    const r = runner(j({ success: true, bundle: okBundle, namespace: 'default' }));
    const src = sandboxBundleSource(asFetcher(r), 'tok');
    await expect(src({ ...input, repoName: undefined })).rejects.toMatchObject({ code: 'BAD_REQUEST', status: 422 });
    await expect(src({ ...input, commitSha: 'abc' })).rejects.toMatchObject({ code: 'BAD_REQUEST', status: 422 });
    await expect(src({ ...input, commitSha: null })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(sandboxBundleSource(asFetcher(r), undefined)(input)).rejects.toMatchObject({ code: 'NOT_CONFIGURED', status: 503 });
    expect(r.fetch).not.toHaveBeenCalled();
  });

  it('passes the sandbox error code and status through', async () => {
    const r = runner(j({ success: false, code: 'NO_ENTRY', error: 'the commit has neither dist/index.js nor src/index.ts' }, 422));
    await expect(sandboxBundleSource(asFetcher(r), 'tok')(input)).rejects.toMatchObject({ code: 'NO_ENTRY', status: 422, message: expect.stringContaining('neither') });
  });

  it('checks Response.ok even when the body is not JSON (a 404 is an error, never an empty bundle) and does not blame the candidate for it', async () => {
    const r = runner(new Response('Not found', { status: 404 }));
    await expect(sandboxBundleSource(asFetcher(r), 'tok')(input)).rejects.toMatchObject({ code: 'UNAVAILABLE', status: 502 });
  });

  it('maps a build-service fault (401, 403, 404, 429, 500) to 502 and keeps 503/504, so it never looks like a candidate problem', async () => {
    for (const [status, expected] of [[401, 502], [403, 502], [404, 502], [429, 502], [500, 502], [503, 503], [504, 504]] as const) {
      const r = runner(j({ success: false, error: 'x' }, status));
      await expect(sandboxBundleSource(asFetcher(r), 'tok')(input)).rejects.toMatchObject({ status: expected });
    }
    // A candidate-attributable code only keeps its 4xx status when the status is a 4xx
    const odd = runner(j({ success: false, code: 'NO_ENTRY', error: 'x' }, 500));
    await expect(sandboxBundleSource(asFetcher(odd), 'tok')(input)).rejects.toMatchObject({ code: 'NO_ENTRY', status: 502 });
    for (const code of ['BAD_REQUEST', 'BUILD_FAILED', 'TOO_LARGE']) {
      const r = runner(j({ success: false, code, error: 'x' }, 422));
      await expect(sandboxBundleSource(asFetcher(r), 'tok')(input)).rejects.toMatchObject({ code, status: 422 });
    }
  });

  it('rejects a 200 whose body is not a valid bundle', async () => {
    for (const body of [{ success: true }, { success: true, bundle: { ...okBundle, modules: [] } }, { success: true, bundle: { ...okBundle, modules: [{ name: '../x', content: 'x' }] } }, { success: true, bundle: { ...okBundle, compatibilityDate: 'soon' } }, null]) {
      await expect(sandboxBundleSource(asFetcher(runner(j(body))), 'tok')(input)).rejects.toMatchObject({ code: 'UNAVAILABLE', status: 502 });
    }
  });

  it('rejects a built file that is not an ES module (e.g. a checked-out symlink holding a path) and a missing main module', async () => {
    const text = { ...okBundle, modules: [{ name: 'index.js', content: '/usr/local/bin/node' }] };
    await expect(sandboxBundleSource(asFetcher(runner(j({ success: true, bundle: text, namespace: 'default' }))), 'tok')(input)).rejects.toMatchObject({ code: 'BUILD_FAILED', status: 422 });
    const other = { ...okBundle, mainModule: 'main.js' };
    await expect(sandboxBundleSource(asFetcher(runner(j({ success: true, bundle: other, namespace: 'default' }))), 'tok')(input)).rejects.toMatchObject({ code: 'BUILD_FAILED' });
  });

  it('reports an unreachable service as UNAVAILABLE with status 504', async () => {
    const r = runner(new Error('connection refused'));
    const err = await sandboxBundleSource(asFetcher(r), 'tok')(input).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxBuildError);
    expect(err).toMatchObject({ code: 'UNAVAILABLE', status: 504 });
  });

  it('aborts a build service that never answers after the timeout', async () => {
    vi.useFakeTimers();
    try {
      const r = { fetch: vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))))) };
      const p = sandboxBundleSource(r as unknown as Fetcher, 'tok')(input).then(() => null, (e: unknown) => e);
      await vi.advanceTimersByTimeAsync(320_001);
      expect(await p).toMatchObject({ code: 'UNAVAILABLE', status: 504, message: expect.stringContaining('did not answer in time') });
    } finally {
      vi.useRealTimers();
    }
  });

  it('only accepts text that really starts an export statement as an ES module', async () => {
    const withContent = (content: string) => runner(j({ success: true, bundle: { ...okBundle, modules: [{ name: 'index.js', content }] }, namespace: 'default' }));
    for (const ok of ['export default {};', '// x\nvar a=1;export{a as default};', 'var a = 1;\nexport const b = 2;', 'export*from"./x";', 'export async function f() {}']) {
      await expect(sandboxBundleSource(asFetcher(withContent(ok)), 'tok')(input)).resolves.toMatchObject({ mainModule: 'index.js' });
    }
    // a symlink's checked-out text, a path that contains the word, and a comment that mentions it
    for (const bad of ['/usr/local/bin/node', '../export/index.js', '/opt/export/main', '// this will export later\nvar a = 1;', 'addEventListener("fetch", () => {});']) {
      await expect(sandboxBundleSource(asFetcher(withContent(bad)), 'tok')(input)).rejects.toMatchObject({ code: 'BUILD_FAILED', status: 422 });
    }
  });
});
