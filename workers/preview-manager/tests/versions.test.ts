import { describe, it, expect, vi } from 'vitest';
import { ApiWorkerVersionsClient, workerVersionsClientFor, type CandidateBundleSource } from '../versions';

const bundle: CandidateBundleSource = async () => ({
  mainModule: 'index.js',
  compatibilityDate: '2026-10-01',
  modules: [{ name: 'index.js', content: 'export default {}' }],
});
const ok = (result: unknown) => new Response(JSON.stringify({ success: true, result, errors: [] }), { status: 200 });
const fail = (status: number, code: number, message: string, headers?: HeadersInit) =>
  new Response(JSON.stringify({ success: false, errors: [{ code, message }] }), { status, headers });
const V = '1496f34f-7587-4bfb-b75d-97dab053a92b';
const input = { workerName: 'beehive-candidate-c1', candidateId: 'c1', commitSha: 'abc123' };
const client = (fetchFn: any) => new ApiWorkerVersionsClient({ accountId: 'acct1', apiToken: 'tok', subdomain: 'sub', bundle }, fetchFn);

describe('ApiWorkerVersionsClient', () => {
  it('uploads a version to the candidate Worker and builds the version URL from the id prefix', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(ok({ id: V, number: 2 })).mockResolvedValueOnce(ok({ enabled: true }));
    const v = await client(fetchFn).createVersion(input);
    expect(v).toEqual({ versionId: V, url: 'https://1496f34f-beehive-candidate-c1.sub.workers.dev' });
    expect(fetchFn).toHaveBeenCalledTimes(2); // version upload, then the idempotent subdomain enable
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct1/workers/scripts/beehive-candidate-c1/versions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok');
    const meta = JSON.parse(await (init.body as FormData).get('metadata')!.text());
    expect(meta).toMatchObject({ main_module: 'index.js', annotations: { 'workers/tag': 'c1', 'workers/commit_sha': 'abc123' } });
  });

  it('first upload (10007) falls back to script upload, converts the hex id, enables the subdomain', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(fail(404, 10007, 'This Worker does not exist on your account'))
      .mockResolvedValueOnce(ok({ id: 'beehive-candidate-c1', deployment_id: V.replaceAll('-', '') }))
      .mockResolvedValueOnce(ok({ enabled: true, previews_enabled: true }));
    const v = await client(fetchFn).createVersion(input);
    expect(v.versionId).toBe(V);
    expect(fetchFn.mock.calls.map((c) => [c[1].method, c[0].split('/scripts/')[1]])).toEqual([
      ['POST', 'beehive-candidate-c1/versions'],
      ['PUT', 'beehive-candidate-c1'],
      ['POST', 'beehive-candidate-c1/subdomain'],
    ]);
    expect(JSON.parse(fetchFn.mock.calls[2][1].body)).toEqual({ enabled: true, previews_enabled: true });
  });

  it('surfaces other API errors, including rate limits, and never retries blindly', async () => {
    const limited = vi.fn().mockResolvedValue(fail(429, 971, 'Too many requests', { 'Retry-After': '30' }));
    await expect(client(limited).createVersion(input)).rejects.toThrow(/HTTP 429.*retry-after 30s/);
    expect(limited).toHaveBeenCalledTimes(1);
    const denied = vi.fn().mockResolvedValue(fail(403, 10000, 'Authentication error'));
    await expect(client(denied).createVersion(input)).rejects.toThrow(/HTTP 403.*10000/);
    const emptyOk = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    await expect(client(emptyOk).createVersion(input)).rejects.toThrow(/Cloudflare API/);
  });

  it('rejects a Worker name that is not a safe path segment or overflows the DNS label', async () => {
    const fetchFn = vi.fn();
    await expect(client(fetchFn).createVersion({ ...input, workerName: '../beehive' })).rejects.toThrow(/Invalid Worker name/);
    await expect(client(fetchFn).createVersion({ ...input, workerName: 'a'.repeat(60) })).rejects.toThrow(/too long/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('setDeployment posts a percentage strategy', async () => {
    const fetchFn = vi.fn().mockResolvedValue(ok({ id: 'dep1' }));
    expect(await client(fetchFn).setDeployment('beehive-candidate-c1', [{ versionId: V, percentage: 100 }])).toBe('dep1');
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toMatch(/\/scripts\/beehive-candidate-c1\/deployments$/);
    expect(JSON.parse(init.body)).toEqual({ strategy: 'percentage', versions: [{ version_id: V, percentage: 100 }] });
  });
});

describe('workerVersionsClientFor', () => {
  const full = { WORKER_VERSIONS_MODE: 'api', CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't', WORKERS_SUBDOMAIN: 's' };
  it('defaults to null (production keeps answering 501)', () => {
    expect(workerVersionsClientFor({}, bundle)).toBeNull();
    expect(workerVersionsClientFor({ CLOUDFLARE_API_TOKEN: 't' }, bundle)).toBeNull();
  });
  it('api mode needs credentials, subdomain and a bundle source', () => {
    expect(workerVersionsClientFor(full, bundle)?.kind).toBe('api');
    expect(workerVersionsClientFor(full)).toBeNull();
    expect(workerVersionsClientFor({ ...full, CLOUDFLARE_API_TOKEN: undefined }, bundle)).toBeNull();
    expect(workerVersionsClientFor({ ...full, WORKERS_SUBDOMAIN: undefined }, bundle)).toBeNull();
  });
  it('stub still needs BEEHIVE_LOCAL_DEV=1', () => {
    expect(workerVersionsClientFor({ WORKER_VERSIONS_MODE: 'stub' })).toBeNull();
    expect(workerVersionsClientFor({ WORKER_VERSIONS_MODE: 'stub', BEEHIVE_LOCAL_DEV: '1' })?.kind).toBe('stub');
  });

  it('retries the subdomain enable on the next call when it failed after the first upload', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(fail(404, 10007, 'no worker'))
      .mockResolvedValueOnce(ok({ deployment_id: V.replaceAll('-', '') }))
      .mockResolvedValueOnce(fail(500, 1000, 'boom')) // subdomain step fails: Worker now exists
      .mockResolvedValueOnce(ok({ id: V }))
      .mockResolvedValueOnce(ok({ enabled: true }));
    await expect(client(fetchFn).createVersion(input)).rejects.toThrow(/HTTP 500/);
    await client(fetchFn).createVersion(input);
    expect(fetchFn.mock.calls[4][0]).toMatch(/\/subdomain$/);
  });

  it('rejects a malformed version id from either path', async () => {
    await expect(client(vi.fn().mockResolvedValue(ok({ number: 2 }))).createVersion(input)).rejects.toThrow(/Unexpected version id/);
    await expect(client(vi.fn().mockResolvedValue(ok({ id: 'not-a-uuid' }))).createVersion(input)).rejects.toThrow(/Unexpected version id/);
  });

  it('setDeployment validates locally: name, per-version range, total of 100', async () => {
    const fetchFn = vi.fn().mockResolvedValue(ok({ id: 'dep1' }));
    const c = client(fetchFn);
    await expect(c.setDeployment('../x', [{ versionId: V, percentage: 100 }])).rejects.toThrow(/Invalid Worker name/);
    await expect(c.setDeployment('beehive-candidate-c1', [{ versionId: V, percentage: 100 }, { versionId: V, percentage: 0 }])).rejects.toThrow(/0.01/);
    await expect(c.setDeployment('beehive-candidate-c1', [{ versionId: V, percentage: 60 }, { versionId: V, percentage: 30 }])).rejects.toThrow(/total 100/);
    expect(fetchFn).not.toHaveBeenCalled();
    await expect(c.setDeployment('beehive-candidate-c1', [{ versionId: V, percentage: 99.5 }, { versionId: V, percentage: 0.5 }])).resolves.toBe('dep1');
  });
});
