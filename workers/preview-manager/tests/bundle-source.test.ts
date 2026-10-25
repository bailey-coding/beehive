import { describe, it, expect, vi } from 'vitest';
import { SandboxBuildError, sandboxBundleSource } from '../bundle-source';

const SHA = 'a'.repeat(40);
const input = { workerName: 'beehive-candidate-c1', candidateId: 'c1', commitSha: SHA, repoName: 'repo-1' };
const okBundle = { mainModule: 'index.js', modules: [{ name: 'index.js', content: 'export default {}' }], compatibilityDate: '2026-10-01', source: 'esbuild' };
const runner = (res: Response | Error) => ({ fetch: vi.fn(async () => { if (res instanceof Error) throw res; return res; }) });
const j = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const asFetcher = (r: ReturnType<typeof runner>) => r as unknown as Fetcher;

describe('sandboxBundleSource', () => {
  it('posts repo and full commit with the bearer token and returns the bundle', async () => {
    const r = runner(j({ success: true, bundle: okBundle }));
    const out = await sandboxBundleSource(asFetcher(r), 'tok')(input);
    expect(out).toEqual({ mainModule: 'index.js', modules: [{ name: 'index.js', content: 'export default {}' }], compatibilityDate: '2026-10-01' });
    const [url, init] = r.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://sandbox-runner.internal/sandbox/build');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body as string)).toEqual({ repo: 'repo-1', commitSha: SHA });
  });

  it('refuses to call the build service without a repo, a full commit or a token', async () => {
    const r = runner(j({ success: true, bundle: okBundle }));
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

  it('checks Response.ok even when the body is not JSON (a 404 is an error, never an empty bundle)', async () => {
    const r = runner(new Response('Not found', { status: 404 }));
    await expect(sandboxBundleSource(asFetcher(r), 'tok')(input)).rejects.toMatchObject({ code: 'UNAVAILABLE', status: 404 });
  });

  it('rejects a 200 whose body is not a valid bundle', async () => {
    for (const body of [{ success: true }, { success: true, bundle: { ...okBundle, modules: [] } }, { success: true, bundle: { ...okBundle, modules: [{ name: '../x', content: 'x' }] } }, { success: true, bundle: { ...okBundle, compatibilityDate: 'soon' } }, null]) {
      await expect(sandboxBundleSource(asFetcher(runner(j(body))), 'tok')(input)).rejects.toMatchObject({ code: 'UNAVAILABLE', status: 502 });
    }
  });

  it('rejects a built file that is not an ES module (e.g. a checked-out symlink holding a path) and a missing main module', async () => {
    const text = { ...okBundle, modules: [{ name: 'index.js', content: '/usr/local/bin/node' }] };
    await expect(sandboxBundleSource(asFetcher(runner(j({ success: true, bundle: text }))), 'tok')(input)).rejects.toMatchObject({ code: 'BUILD_FAILED', status: 422 });
    const other = { ...okBundle, mainModule: 'main.js' };
    await expect(sandboxBundleSource(asFetcher(runner(j({ success: true, bundle: other }))), 'tok')(input)).rejects.toMatchObject({ code: 'BUILD_FAILED' });
  });

  it('reports an unreachable service as 504 or UNAVAILABLE without hanging', async () => {
    const r = runner(new Error('connection refused'));
    const err = await sandboxBundleSource(asFetcher(r), 'tok')(input).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxBuildError);
    expect(err).toMatchObject({ code: 'UNAVAILABLE' });
  });
});
