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

import { isValidNamespace } from '../shared/namespace';
import { ContainerSandbox, REPO_RE, SHA_RE, scrub, type SandboxEnv } from './sandbox-base';

// Shared plumbing lives in sandbox-base.ts; re-exported so existing importers keep working.
export { ArtifactsGateway, artifactsHost, isAllowedGitRequest, scrub, type GatewayProps } from './sandbox-base';

export type BuildEnv = SandboxEnv;

export interface BuildRequest {
  /** Artifacts repository name. */
  repo: string;
  /** Full 40-hex commit to build. */
  commitSha: string;
  /** Artifacts namespace of the repository; absent = the `ARTIFACTS_NAMESPACE` fallback. */
  namespace?: string;
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
  /** Namespace the commit was built from; the route echoes it beside (not inside) the bundle. */
  namespace: string;
}

export const BUILD_ERROR_CODES = ['BAD_REQUEST', 'BAD_NAMESPACE', 'NOT_CONFIGURED', 'CLONE_FAILED', 'NO_ENTRY', 'BUILD_FAILED', 'TOO_LARGE'] as const;
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
const TOKEN_TTL_S = 240; // a build is bounded by BUILD_DEADLINE_MS (150 s) plus clone/checkout, so the read token need not outlive it by much
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
const COMPATIBILITY_DATE = '2026-10-01';
const WORKDIR = '/workspace/cand';
const OUTDIR = '/workspace/out';
export function validateBuildRequest(body: unknown): BuildRequest {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.repo !== 'string' || !REPO_RE.test(b.repo) || b.repo.includes('..')) {
    throw new BuildError('BAD_REQUEST', 'repo must be an Artifacts repository name');
  }
  if (typeof b.commitSha !== 'string' || !SHA_RE.test(b.commitSha)) {
    throw new BuildError('BAD_REQUEST', 'commitSha must be a full 40-character lowercase hex commit');
  }
  // Present but not a valid namespace is an error, never a silent fallback to another namespace's repository.
  if (b.namespace !== undefined && !isValidNamespace(b.namespace)) {
    throw new BuildError('BAD_NAMESPACE', 'namespace must be an Artifacts namespace name');
  }
  return b.namespace === undefined ? { repo: b.repo, commitSha: b.commitSha } : { repo: b.repo, commitSha: b.commitSha, namespace: b.namespace };
}

export class BuildSandbox extends ContainerSandbox<BuildEnv> {
  /** Builds in progress by `namespace/repo@sha`: a repeat call for the same commit (a retry after a caller's timeout) shares the running build. */
  private inflight = new Map<string, Promise<BuildResult>>();

  protected deadlineMs() { return BUILD_DEADLINE_MS; }
  protected inactivityMs() { return INACTIVITY_TIMEOUT_MS; }
  protected logName() { return 'BuildSandbox'; }
  protected failure(kind: 'deadline' | 'abandoned') {
    return new BuildError('BUILD_FAILED', kind === 'deadline' ? `the build exceeded ${BUILD_DEADLINE_MS / 1000}s` : 'the build was abandoned');
  }
  protected startOptions() {
    return {
      image: this.container.images.build,
      instance: 'lite' as const,
      // Reaches only the hostnames intercepted in build().
      enableInternet: false,
    };
  }

  /** Tool versions of the running image; proves a deploy shipped the image this code expects. */
  probe(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return this.serialize(() => this.guarded(async (token) => {
      this.assertActive(token);
      await this.start();
      this.assertActive(token);
      return this.run(['sh', '-c', 'node --version; esbuild --version; git --version']);
    }));
  }

  /** The request's namespace, else the environment's fallback. */
  private namespaceFor(req: BuildRequest): string {
    return req.namespace ?? this.env.ARTIFACTS_NAMESPACE ?? 'default';
  }

  build(input: BuildRequest): Promise<BuildResult> {
    const req = validateBuildRequest(input);
    // The namespace is part of the key: the same repo name and commit in two namespaces are two different builds.
    const key = `${this.namespaceFor(req)}/${req.repo}@${req.commitSha}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const result = this.serialize(() => this.guarded((token) => this.buildInner(req, token))).finally(() => { this.inflight.delete(key); });
    result.catch(() => undefined); // a caller that gave up must not leave an unhandled rejection behind
    this.inflight.set(key, result);
    return result;
  }

  private async buildInner(req: BuildRequest, token: symbol): Promise<BuildResult> {
    // Every container action goes through here: an abandoned build (deadline) throws on its next step instead of acting
    const run = (cmd: string[], env?: Record<string, string>) => { this.assertActive(token); return this.run(cmd, env); };
    const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken } = this.env;
    const namespace = this.namespaceFor(req);
    if (!accountId || !apiToken) throw new BuildError('NOT_CONFIGURED', 'the build service is not configured');
    if (!isValidNamespace(namespace)) throw new BuildError('NOT_CONFIGURED', 'the build service is not configured');

    // One token per build, held by the gateway props. If this fails nothing has started yet.
    let readToken: string;
    try {
      readToken = await this.mintReadToken(accountId, apiToken, namespace, req.repo, TOKEN_TTL_S);
    } catch (error) {
      console.error('[BuildSandbox] read token mint failed:', error instanceof Error ? error.message : String(error));
      throw new BuildError('CLONE_FAILED', 'could not obtain read access to the repository');
    }

    this.assertActive(token);
    await this.start();
    this.assertActive(token);
    const cloned = await this.cloneCommit(run, { accountId, namespace, repo: req.repo, commitSha: req.commitSha, token: readToken, clean: [WORKDIR, OUTDIR], workdir: WORKDIR });
    if (!cloned.ok && cloned.stage === 'clone') {
      console.error(`[BuildSandbox] clone of ${req.repo} failed (${cloned.exitCode}):`, scrub(cloned.stderr, 500));
      throw new BuildError('CLONE_FAILED', `git clone failed (exit ${cloned.exitCode}); the repository may not exist or may not be readable`);
    }
    if (!cloned.ok) {
      console.error(`[BuildSandbox] checkout ${req.commitSha} failed (${cloned.exitCode}):`, scrub(cloned.stderr, 500));
      throw new BuildError('CLONE_FAILED', 'the commit was not found; only commits reachable from the repository branches or tags can be built');
    }

    const hasPrebuilt = (await run(['test', '-f', `${WORKDIR}/dist/index.js`])).exitCode === 0;
    let outFile = `${WORKDIR}/dist/index.js`;
    let source: BuildResult['source'] = 'prebuilt';
    if (!hasPrebuilt) {
      const entry = (await run(['sh', '-c', `for f in src/index.ts src/index.js; do [ -f ${WORKDIR}/$f ] && echo $f && break; done`])).stdout.trim();
      if (!entry) throw new BuildError('NO_ENTRY', 'the commit has neither dist/index.js nor src/index.ts (or src/index.js)');
      outFile = `${OUTDIR}/index.js`;
      source = 'esbuild';
      const bundle = await run([
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
    const size = Number((await run(['sh', '-c', `wc -c < ${outFile}`])).stdout.trim());
    if (!Number.isFinite(size) || size <= 0) throw new BuildError('BUILD_FAILED', 'the build produced no output');
    if (size > MAX_BUNDLE_BYTES) throw new BuildError('TOO_LARGE', `the bundle is ${size} bytes, the limit is ${MAX_BUNDLE_BYTES}`);
    const content = await run(['cat', outFile]);
    if (content.exitCode !== 0) throw new BuildError('BUILD_FAILED', 'could not read the build output');
    return { mainModule: 'index.js', modules: [{ name: 'index.js', content: content.stdout }], compatibilityDate: COMPATIBILITY_DATE, source, namespace };
  }
}
