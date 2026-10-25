/**
 * Candidate build sandbox (docs/SANDBOX-BUILD-PLAN.md). One container per build, driven through the Durable Object
 * container API (`ctx.container`), the Sandbox SDK 1.0 model: no `@cloudflare/sandbox` package is needed because
 * we use neither Files, backups nor S3 mounts.
 *
 * Flow: mint one short-lived Artifacts read token, start a no-Internet container, intercept HTTPS to the account's
 * Artifacts host with `ArtifactsGateway` (the token travels in the entrypoint props, never into the container; the
 * gateway allows only git-upload-pack on the one repo), clone and check out the exact commit with symlinks disabled,
 * then build with esbuild (no `npm install`, so no install scripts; tsconfig ignored) under timeouts and a size cap. A
 * committed `dist/index.js` is used as is. The container is destroyed afterwards on every path, a deadline bounds the whole
 * build, and an alarm destroys a container that a Durable Object restart left behind.
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
 * plain Error, so `parseBuildError` recovers the code from the text. Messages are written for callers (agents):
 * no URLs, account ids or raw tool output beyond a short, scrubbed compiler excerpt; detail goes to the logs.
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
export const BUILD_DEADLINE_MS = 150_000;
const BUILD_TIMEOUT_S = 60;
const CLONE_TIMEOUT_S = 60;
const CHECKOUT_TIMEOUT_S = 30;
const TOKEN_TTL_S = 600;
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
/** The alarm only has to outlive the deadline; it destroys a container a restarted Durable Object forgot. */
const ALARM_AFTER_MS = BUILD_DEADLINE_MS + 60_000;
const COMPATIBILITY_DATE = '2026-10-01';
const CA_CERT = '/etc/cloudflare/certs/cloudflare-containers-ca.crt';
const WORKDIR = '/workspace/cand';
const OUTDIR = '/workspace/out';
/** The only request headers the container may pass on to Artifacts. */
const FORWARDED_HEADERS = ['content-type', 'accept', 'git-protocol', 'content-encoding', 'user-agent'];

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

/** Request the gateway lets through: a read-only clone of exactly one repository, and nothing else. */
export function isAllowedGitRequest(method: string, url: URL, namespace: string, repo: string): boolean {
  const base = `/git/${namespace}/${repo}.git`;
  if (method === 'GET' && url.pathname === `${base}/info/refs`) return url.search === '?service=git-upload-pack';
  if (method === 'POST' && url.pathname === `${base}/git-upload-pack`) return url.search === '';
  return false;
}

export interface GatewayProps {
  repo: string;
  namespace: string;
  /** Short-lived read token minted by the Durable Object; it never enters the container. */
  token: string;
}

function validGatewayProps(p: Partial<GatewayProps> | undefined): p is GatewayProps {
  return !!p && typeof p.repo === 'string' && REPO_RE.test(p.repo) && typeof p.namespace === 'string' && NAMESPACE_RE.test(p.namespace)
    && typeof p.token === 'string' && p.token.length > 0;
}

/**
 * Receives every HTTPS request the build container makes to the Artifacts host. Props pick the one repository this
 * build may read and carry its read token. Anything else gets 403; redirects are refused; the container's own headers
 * are dropped except a short allowlist.
 */
export class ArtifactsGateway extends WorkerEntrypoint<unknown, GatewayProps> {
  async fetch(request: Request): Promise<Response> {
    const props = this.ctx.props as Partial<GatewayProps> | undefined;
    if (!validGatewayProps(props)) return new Response('Gateway is not configured for a build', { status: 403 });
    if (!isAllowedGitRequest(request.method, new URL(request.url), props.namespace, props.repo)) {
      return new Response('Only a read-only clone of the build repository is allowed', { status: 403 });
    }
    const headers = new Headers();
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    headers.set('Authorization', `Bearer ${props.token}`);
    const res = await fetch(new Request(request, { headers, redirect: 'manual' }));
    if (res.status >= 300 && res.status < 400) return new Response('Unexpected redirect from Artifacts', { status: 502 });
    return res;
  }
}

function decode(bytes: ArrayBuffer | Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Short, single-purpose excerpt of tool output: ANSI and control characters removed, account-host URLs masked. */
export function scrub(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
    .replace(/https?:\/\/[^\s'"]*artifacts\.cloudflare\.net[^\s'"]*/g, '<artifacts-url>').trim().slice(0, max);
}

export class BuildSandbox extends DurableObject<BuildEnv> {
  /** Tail of the call chain: build() and probe() on one instance run one at a time. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Builds in progress by `repo@sha`: a repeat call for the same commit (a retry after a caller's timeout) shares the running build. */
  private inflight = new Map<string, Promise<BuildResult>>();

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

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn, fn);
    this.chain = result.catch(() => undefined);
    return result;
  }

  /** Runs `fn` with a wall-clock deadline and an alarm backstop, and always stops the container afterwards. */
  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_AFTER_MS);
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BuildError('BUILD_FAILED', `the build exceeded ${BUILD_DEADLINE_MS / 1000}s`)), BUILD_DEADLINE_MS);
      });
      return await Promise.race([fn(), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
      await this.stop();
      try { await this.ctx.storage.deleteAlarm(); } catch { /* the alarm is only a backstop */ }
    }
  }

  /** Backstop for a container left running by a restart mid-build; also harmless when nothing is running. */
  async alarm(): Promise<void> {
    await this.stop();
  }

  private async run(cmd: string[], env?: Record<string, string>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = await this.container.exec(cmd, { cwd: '/workspace', ...(env ? { env } : {}) });
    const out = await proc.output();
    return { exitCode: out.exitCode, stdout: decode(out.stdout), stderr: decode(out.stderr) };
  }

  /** Tool versions of the running image; proves a deploy shipped the image this code expects. */
  probe(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return this.serialize(() => this.guarded(async () => {
      await this.start();
      return this.run(['sh', '-c', 'node --version; esbuild --version; git --version']);
    }));
  }

  build(input: BuildRequest): Promise<BuildResult> {
    const req = validateBuildRequest(input);
    const key = `${req.repo}@${req.commitSha}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const result = this.serialize(() => this.guarded(() => this.buildInner(req))).finally(() => { this.inflight.delete(key); });
    result.catch(() => undefined); // a caller that gave up must not leave an unhandled rejection behind
    this.inflight.set(key, result);
    return result;
  }

  private async buildInner(req: BuildRequest): Promise<BuildResult> {
    const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken, ARTIFACTS_NAMESPACE: ns } = this.env;
    const namespace = ns ?? 'default';
    if (!accountId || !apiToken) throw new BuildError('NOT_CONFIGURED', 'the build service is not configured');
    if (!NAMESPACE_RE.test(namespace)) throw new BuildError('NOT_CONFIGURED', 'the build service is not configured');

    // One token per build, held by the gateway props. If this fails nothing has started yet.
    let token: string;
    try {
      token = (await createRepoToken({ accountId, apiToken, namespace }, req.repo, 'read', TOKEN_TTL_S)).token;
    } catch (error) {
      console.error('[BuildSandbox] read token mint failed:', error instanceof Error ? error.message : String(error));
      throw new BuildError('CLONE_FAILED', 'could not obtain read access to the repository');
    }

    await this.start();
    // Registering again replaces an earlier intercept, so this is safe on every build.
    await this.container.interceptOutboundHttps(
      artifactsHost(accountId),
      (this.ctx.exports as unknown as { ArtifactsGateway: (o: { props: GatewayProps }) => Fetcher }).ArtifactsGateway({
        props: { repo: req.repo, namespace, token },
      })
    );
    const url = `https://${artifactsHost(accountId)}/git/${namespace}/${req.repo}.git`;
    // No config file or hook of the candidate repo may influence git: nothing global/system, no hooks, no symlinks.
    const gitEnv = { GIT_SSL_CAINFO: CA_CERT, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const git = ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.symlinks=false'];

    await this.run(['rm', '-rf', WORKDIR, OUTDIR]);
    const clone = await this.run(['timeout', '--kill-after=5', String(CLONE_TIMEOUT_S), ...git, 'clone', '--quiet', '--no-checkout', url, WORKDIR], gitEnv);
    if (clone.exitCode !== 0) {
      console.error(`[BuildSandbox] clone of ${req.repo} failed (${clone.exitCode}):`, scrub(clone.stderr, 500));
      throw new BuildError('CLONE_FAILED', `git clone failed (exit ${clone.exitCode}); the repository may not exist or may not be readable`);
    }
    const checkout = await this.run(['timeout', '--kill-after=5', String(CHECKOUT_TIMEOUT_S), ...git, '-C', WORKDIR, 'checkout', '--quiet', req.commitSha], gitEnv);
    if (checkout.exitCode !== 0) {
      console.error(`[BuildSandbox] checkout ${req.commitSha} failed (${checkout.exitCode}):`, scrub(checkout.stderr, 500));
      throw new BuildError('CLONE_FAILED', 'the commit was not found; only commits reachable from the repository branches or tags can be built');
    }

    const hasPrebuilt = (await this.run(['test', '-f', `${WORKDIR}/dist/index.js`])).exitCode === 0;
    let outFile = `${WORKDIR}/dist/index.js`;
    let source: BuildResult['source'] = 'prebuilt';
    if (!hasPrebuilt) {
      const entry = (await this.run(['sh', '-c', `for f in src/index.ts src/index.js; do [ -f ${WORKDIR}/$f ] && echo $f && break; done`])).stdout.trim();
      if (!entry) throw new BuildError('NO_ENTRY', 'the commit has neither dist/index.js nor src/index.ts (or src/index.js)');
      outFile = `${OUTDIR}/index.js`;
      source = 'esbuild';
      const bundle = await this.run([
        'timeout', '--kill-after=5', String(BUILD_TIMEOUT_S),
        'esbuild', `${WORKDIR}/${entry}`, '--bundle', '--format=esm', '--target=es2022', '--platform=neutral',
        '--tsconfig-raw={}', `--outfile=${outFile}`, '--log-level=warning', '--color=false',
      ]);
      if (bundle.exitCode !== 0) {
        console.error(`[BuildSandbox] esbuild failed for ${req.repo} (${bundle.exitCode}):`, scrub(bundle.stderr, 800));
        throw new BuildError('BUILD_FAILED', bundle.exitCode === 124 || bundle.exitCode === 137
          ? `the build was stopped after ${BUILD_TIMEOUT_S}s or killed (exit ${bundle.exitCode})`
          : `esbuild failed (exit ${bundle.exitCode}): ${scrub(bundle.stderr, 400)}`);
      }
    }
    // Bytes of the real file (a symlink was checked out as a plain file anyway), measured before it is read.
    const size = Number((await this.run(['sh', '-c', `wc -c < ${outFile}`])).stdout.trim());
    if (!Number.isFinite(size) || size <= 0) throw new BuildError('BUILD_FAILED', 'the build produced no output');
    if (size > MAX_BUNDLE_BYTES) throw new BuildError('TOO_LARGE', `the bundle is ${size} bytes, the limit is ${MAX_BUNDLE_BYTES}`);
    const content = await this.run(['cat', outFile]);
    if (content.exitCode !== 0) throw new BuildError('BUILD_FAILED', 'could not read the build output');
    return { mainModule: 'index.js', modules: [{ name: 'index.js', content: content.stdout }], compatibilityDate: COMPATIBILITY_DATE, source };
  }

  private async start(): Promise<void> {
    if (this.container.running) return;
    this.container.start({
      image: this.container.images.build,
      instance: 'lite',
      // Reaches only the hostnames intercepted in build().
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
