/**
 * Candidate build sandbox (docs/SANDBOX-BUILD-PLAN.md). One container per build, driven through the Durable Object
 * container API (`ctx.container`), the Sandbox SDK 1.0 model: no `@cloudflare/sandbox` package is needed because
 * we use neither Files, backups nor S3 mounts.
 *
 * Flow: start a no-Internet container, intercept HTTPS to the account's Artifacts host with `ArtifactsGateway`
 * (which adds a read token the container never sees, and allows only git-upload-pack on the one repo), clone and
 * check out the exact commit, then build with esbuild (no `npm install`, so no install scripts run) under a timeout
 * and size cap. A committed `dist/index.js` is used as is, with no build step. The container is destroyed afterwards.
 */

import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { createRepoToken } from '../shared/artifacts';

export interface BuildEnv {
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  /** Artifacts namespace of candidate repos. */
  ARTIFACTS_NAMESPACE?: string;
}

export interface BuildRequest {
  /** Artifacts repository name. */
  repo: string;
  /** Full 40-hex commit to build. */
  commitSha: string;
}

export interface BuildModule {
  name: string;
  content: string;
}

/** Matches `CandidateBundle` in workers/preview-manager/versions.ts (string modules only). */
export interface BuildResult {
  mainModule: string;
  modules: BuildModule[];
  compatibilityDate: string;
  /** `prebuilt` = the commit's `dist/index.js`, `esbuild` = bundled from `src/index.ts`. */
  source: 'prebuilt' | 'esbuild';
}

export const BUILD_ERROR_CODES = ['BAD_REQUEST', 'NOT_CONFIGURED', 'CLONE_FAILED', 'NO_ENTRY', 'BUILD_FAILED', 'TOO_LARGE'] as const;
export type BuildErrorCode = (typeof BUILD_ERROR_CODES)[number];

/**
 * The code is also the message prefix: an error thrown inside the Durable Object reaches the Worker over RPC as a
 * plain Error, so `parseBuildError` recovers the code from the text.
 */
export class BuildError extends Error {
  constructor(readonly code: BuildErrorCode, message: string) {
    super(`${code}: ${message}`);
  }
}

export function parseBuildError(error: unknown): { code: BuildErrorCode; message: string } | null {
  const text = error instanceof Error ? error.message : String(error);
  const code = BUILD_ERROR_CODES.find((c) => text.startsWith(`${c}: `));
  return code ? { code, message: text.slice(code.length + 2) } : null;
}

export const MAX_BUNDLE_BYTES = 1024 * 1024;
const BUILD_TIMEOUT_S = 60;
const CLONE_TIMEOUT_S = 90;
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
const COMPATIBILITY_DATE = '2026-10-01';
const CA_CERT = '/etc/cloudflare/certs/cloudflare-containers-ca.crt';
const WORKDIR = '/workspace/cand';

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const NAMESPACE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function validateBuildRequest(body: unknown): BuildRequest {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.repo !== 'string' || !REPO_RE.test(b.repo) || b.repo.includes('..')) {
    throw new BuildError('BAD_REQUEST', 'repo must be an Artifacts repository name');
  }
  if (typeof b.commitSha !== 'string' || !SHA_RE.test(b.commitSha)) {
    throw new BuildError('BAD_REQUEST', 'commitSha must be a full 40-character lowercase hex commit');
  }
  return { repo: b.repo, commitSha: b.commitSha };
}

export function artifactsHost(accountId: string): string {
  return `${accountId}.artifacts.cloudflare.net`;
}

/** Request path/query the gateway lets through: a read-only clone of exactly one repository. */
export function isAllowedGitRequest(method: string, url: URL, namespace: string, repo: string): boolean {
  const base = `/git/${namespace}/${repo}.git`;
  if (method === 'GET' && url.pathname === `${base}/info/refs`) return url.searchParams.get('service') === 'git-upload-pack';
  if (method === 'POST' && url.pathname === `${base}/git-upload-pack`) return true;
  return false;
}

/**
 * Receives every HTTPS request the build container makes to the Artifacts host. Props pick the one repository
 * this build may read. The read token is minted here, per request batch, and never enters the container.
 */
export class ArtifactsGateway extends WorkerEntrypoint<BuildEnv, { repo: string; namespace: string }> {
  async fetch(request: Request): Promise<Response> {
    const { repo, namespace } = this.ctx.props;
    if (!isAllowedGitRequest(request.method, new URL(request.url), namespace, repo)) {
      return new Response('Only a read-only clone of the build repository is allowed', { status: 403 });
    }
    const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken } = this.env;
    if (!accountId || !apiToken) return new Response('Artifacts credentials are not configured', { status: 503 });
    const { token } = await createRepoToken({ accountId, apiToken, namespace }, repo, 'read', 300);
    const headers = new Headers(request.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return fetch(new Request(request, { headers }));
  }
}

function decode(bytes: ArrayBuffer | Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export class BuildSandbox extends DurableObject<BuildEnv> {
  constructor(ctx: DurableObjectState, env: BuildEnv) {
    super(ctx, env);
    // The inactivity timeout does not survive a restart of this Durable Object.
    const container = ctx.container;
    if (container?.running) void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS));
  }

  private get container(): Container {
    const container = this.ctx.container;
    if (!container) throw new Error('No container is configured');
    return container;
  }

  private async run(cmd: string[], env?: Record<string, string>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = await this.container.exec(cmd, { cwd: '/workspace', ...(env ? { env } : {}) });
    const out = await proc.output();
    return { exitCode: out.exitCode, stdout: decode(out.stdout), stderr: decode(out.stderr) };
  }

  /** Tool versions of the running image; proves a deploy shipped the image this code expects. */
  async probe(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    try {
      await this.start();
      return await this.run(['sh', '-c', 'node --version; esbuild --version; git --version']);
    } finally {
      await this.stop();
    }
  }

  async build(input: BuildRequest): Promise<BuildResult> {
    const req = validateBuildRequest(input);
    const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken, ARTIFACTS_NAMESPACE: ns } = this.env;
    const namespace = ns ?? 'default';
    if (!accountId || !apiToken) throw new BuildError('NOT_CONFIGURED', 'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required');
    if (!NAMESPACE_RE.test(namespace)) throw new BuildError('NOT_CONFIGURED', 'ARTIFACTS_NAMESPACE is not a valid namespace name');
    try {
      await this.start();
      // Registering again replaces an earlier intercept, so this is safe on every build.
      await this.container.interceptOutboundHttps(
        artifactsHost(accountId),
        (this.ctx.exports as unknown as { ArtifactsGateway: (o: { props: { repo: string; namespace: string } }) => Fetcher }).ArtifactsGateway({
          props: { repo: req.repo, namespace },
        })
      );
      const url = `https://${artifactsHost(accountId)}/git/${namespace}/${req.repo}.git`;
      const clone = await this.run(
        ['timeout', '--kill-after=5', String(CLONE_TIMEOUT_S), 'git', 'clone', '--quiet', '--no-checkout', url, WORKDIR],
        { GIT_SSL_CAINFO: CA_CERT, GIT_TERMINAL_PROMPT: '0' }
      );
      if (clone.exitCode !== 0) throw new BuildError('CLONE_FAILED', `git clone failed (${clone.exitCode}): ${clone.stderr.slice(0, 500)}`);
      const checkout = await this.run(['git', '-C', WORKDIR, 'checkout', '--quiet', req.commitSha]);
      if (checkout.exitCode !== 0) throw new BuildError('CLONE_FAILED', `git checkout ${req.commitSha} failed: ${checkout.stderr.slice(0, 300)}`);

      const hasPrebuilt = (await this.run(['test', '-f', `${WORKDIR}/dist/index.js`])).exitCode === 0;
      let outFile = `${WORKDIR}/dist/index.js`;
      let source: BuildResult['source'] = 'prebuilt';
      if (!hasPrebuilt) {
        const entry = (await this.run(['sh', '-c', `for f in src/index.ts src/index.js; do [ -f ${WORKDIR}/$f ] && echo $f && break; done`])).stdout.trim();
        if (!entry) throw new BuildError('NO_ENTRY', 'the commit has neither dist/index.js nor src/index.ts (or src/index.js)');
        outFile = '/workspace/out/index.js';
        source = 'esbuild';
        const bundle = await this.run([
          'timeout', '--kill-after=5', String(BUILD_TIMEOUT_S),
          'esbuild', `${WORKDIR}/${entry}`, '--bundle', '--format=esm', '--target=es2022', '--platform=neutral',
          `--outfile=${outFile}`, '--log-level=warning',
        ]);
        if (bundle.exitCode !== 0) {
          const timedOut = bundle.exitCode === 124 || bundle.exitCode === 137;
          throw new BuildError('BUILD_FAILED', timedOut ? `build exceeded ${BUILD_TIMEOUT_S}s` : `esbuild failed (${bundle.exitCode}): ${bundle.stderr.slice(0, 800)}`);
        }
      }
      const size = Number((await this.run(['stat', '-c', '%s', outFile])).stdout.trim());
      if (!Number.isFinite(size) || size <= 0) throw new BuildError('BUILD_FAILED', 'the build produced no output');
      if (size > MAX_BUNDLE_BYTES) throw new BuildError('TOO_LARGE', `bundle is ${size} bytes, the limit is ${MAX_BUNDLE_BYTES}`);
      const content = await this.run(['cat', outFile]);
      if (content.exitCode !== 0) throw new BuildError('BUILD_FAILED', 'could not read the build output');
      return { mainModule: 'index.js', modules: [{ name: 'index.js', content: content.stdout }], compatibilityDate: COMPATIBILITY_DATE, source };
    } finally {
      await this.stop();
    }
  }

  private async start(): Promise<void> {
    if (this.container.running) return;
    this.container.start({
      image: this.container.images.build,
      instance: 'lite',
      // Reaches only the hostnames intercepted above.
      enableInternet: false,
    });
    await this.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
  }

  /** One container per build: always stop it, even after a failure. */
  private async stop(): Promise<void> {
    try {
      if (this.ctx.container?.running) await this.ctx.container.destroy('build finished');
    } catch (error) {
      console.error('[BuildSandbox] destroy failed:', error instanceof Error ? error.message : String(error));
    }
  }
}
