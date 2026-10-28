/**
 * Shared container plumbing for the runner's Durable Object sandboxes (`BuildSandbox`, `TestSandbox`): one container per call,
 * driven through `ctx.container`, calls on one instance serialized, a wall-clock deadline with an alarm backstop, and the container
 * destroyed on every path. Also the Artifacts gateway (read-only clone of one repository) both use. Extracted from
 * `build-sandbox.ts` with no behavior change (docs/REAL-GATE-IMPL-PLAN.md section 2).
 */

import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { createRepoToken } from '../shared/artifacts';
import { isValidNamespace } from '../shared/namespace';

export interface SandboxEnv {
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  /** Fallback Artifacts namespace when a request names none (docs/SF-8-NAMESPACE-PLAN.md). */
  ARTIFACTS_NAMESPACE?: string;
}

/** destroy()/setAlarm()/deleteAlarm() must never hold the serialized queue: a hung call is abandoned after this long. */
export const CLEANUP_TIMEOUT_MS = 10_000;
export const CA_CERT = '/etc/cloudflare/certs/cloudflare-containers-ca.crt';
/** The only request headers the container may pass on to Artifacts (and to the npm registry). */
export const FORWARDED_HEADERS = ['content-type', 'accept', 'git-protocol', 'content-encoding', 'user-agent'];

export const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const SHA_RE = /^[0-9a-f]{40}$/;

const CLONE_TIMEOUT_S = 60;
const CHECKOUT_TIMEOUT_S = 30;

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
  return !!p && typeof p.repo === 'string' && REPO_RE.test(p.repo) && isValidNamespace(p.namespace)
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

export function decode(bytes: ArrayBuffer | Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Short, single-purpose excerpt of tool output: ANSI and control characters removed, account-host URLs masked. */
export function scrub(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
    .replace(/https?:\/\/[^\s'"]*artifacts\.cloudflare\.net[^\s'"]*/g, '<artifacts-url>').trim().slice(0, max);
}

export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

export type RunResult = { exitCode: number; stdout: string; stderr: string };
export type RunFn = (cmd: string[], env?: Record<string, string>, cwd?: string) => Promise<RunResult>;

export interface CloneRequest {
  accountId: string;
  namespace: string;
  repo: string;
  commitSha: string;
  /** Read token for the gateway props. */
  token: string;
  /** Paths removed before the clone (the clone target first). */
  clean: string[];
  workdir: string;
}

export type CloneOutcome = { ok: true } | { ok: false; stage: 'clone' | 'checkout'; exitCode: number; stderr: string };

/**
 * A Durable Object that owns one container. Subclasses supply the deadline, the failure error type, the image and the size;
 * everything here (serialization, alarm, deadline, abandoned-work check, destroy) is the code BuildSandbox always had.
 */
export abstract class ContainerSandbox<E extends SandboxEnv = SandboxEnv> extends DurableObject<E> {
  /** Tail of the call chain: calls on one instance run one at a time. */
  private chain: Promise<unknown> = Promise.resolve();
  /**
   * Identity of the call that owns the container right now. When the deadline abandons a call its work keeps running in the
   * background; every container action checks this first, so that leftover work throws instead of acting on the container of the
   * call that was started after it.
   */
  protected active: symbol | null = null;

  // Config is read through methods, not fields: the base constructor runs before a subclass's field initializers.
  protected abstract deadlineMs(): number;
  protected abstract inactivityMs(): number;
  protected abstract logName(): string;
  /** The error the deadline and an abandoned call throw. */
  protected abstract failure(kind: 'deadline' | 'abandoned'): Error;
  protected abstract startOptions(): ContainerStartupOptionsLike;

  constructor(ctx: DurableObjectState, env: E) {
    super(ctx, env);
    // The inactivity timeout does not survive a restart of this Durable Object.
    const container = ctx.container;
    if (container?.running) void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(this.inactivityMs()));
  }

  protected get container(): Container {
    const container = this.ctx.container;
    if (!container) throw new Error('No container is configured');
    return container;
  }

  protected serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn, fn);
    this.chain = result.catch(() => undefined);
    return result;
  }

  /** The alarm only has to outlive the deadline; it destroys a container a restarted Durable Object forgot. */
  private alarmAfterMs(): number {
    return this.deadlineMs() + 60_000;
  }

  /** Runs `fn` with a wall-clock deadline and an alarm backstop, and always stops the container afterwards. */
  protected async guarded<T>(fn: (token: symbol) => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const token = Symbol('build');
    this.active = token;
    try {
      await withTimeout(this.ctx.storage.setAlarm(Date.now() + this.alarmAfterMs()), CLEANUP_TIMEOUT_MS, 'setAlarm');
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(this.failure('deadline')), this.deadlineMs());
      });
      return await Promise.race([fn(token), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
      this.active = null; // abandoned work stops acting on the container before it is destroyed and reused
      await this.stop();
      try { await withTimeout(this.ctx.storage.deleteAlarm(), CLEANUP_TIMEOUT_MS, 'deleteAlarm'); } catch { /* the alarm is only a backstop */ }
    }
  }

  /** Backstop for a container left running by a restart mid-call; also harmless when nothing is running. */
  async alarm(): Promise<void> {
    await this.stop();
  }

  protected assertActive(token: symbol): void {
    if (this.active !== token) throw this.failure('abandoned');
  }

  protected async run(cmd: string[], env?: Record<string, string>, cwd = '/workspace'): Promise<RunResult> {
    const proc = await this.container.exec(cmd, { cwd, ...(env ? { env } : {}) });
    const out = await proc.output();
    return { exitCode: out.exitCode, stdout: decode(out.stdout), stderr: decode(out.stderr) };
  }

  protected async start(): Promise<void> {
    if (this.container.running) return;
    this.container.start(this.startOptions());
    await this.container.setInactivityTimeout(this.inactivityMs());
  }

  /** One container per call: always stop it, even after a failure. */
  protected async stop(): Promise<void> {
    try {
      if (this.ctx.container?.running) await withTimeout(this.ctx.container.destroy('build finished'), CLEANUP_TIMEOUT_MS, 'destroy');
    } catch (error) {
      console.error(`[${this.logName()}] destroy failed:`, error instanceof Error ? error.message : String(error));
    }
  }

  /** The Artifacts intercept for one repository, as a fetcher for `interceptOutboundHttps`. */
  protected artifactsGateway(props: GatewayProps): Fetcher {
    return (this.ctx.exports as unknown as { ArtifactsGateway: (o: { props: GatewayProps }) => Fetcher }).ArtifactsGateway({ props });
  }

  /** Mints the read token (one per call). Throws if the platform refuses; the caller maps that to its own error. */
  protected async mintReadToken(accountId: string, apiToken: string, namespace: string, repo: string, ttlS: number): Promise<string> {
    return (await createRepoToken({ accountId, apiToken, namespace }, repo, 'read', ttlS)).token;
  }

  /**
   * Intercepts the Artifacts host and clones + checks out the exact commit: no global/system git config, no hooks, no symlinks.
   * Registering the intercept again replaces an earlier one, so this is safe on every call. The container must be started.
   */
  protected async cloneCommit(run: RunFn, req: CloneRequest): Promise<CloneOutcome> {
    await this.container.interceptOutboundHttps(artifactsHost(req.accountId), this.artifactsGateway({ repo: req.repo, namespace: req.namespace, token: req.token }));
    const url = `https://${artifactsHost(req.accountId)}/git/${req.namespace}/${req.repo}.git`;
    const gitEnv = { GIT_SSL_CAINFO: CA_CERT, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const git = ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.symlinks=false'];
    await run(['rm', '-rf', ...req.clean]);
    const clone = await run(['timeout', '--kill-after=5', String(CLONE_TIMEOUT_S), ...git, 'clone', '--quiet', '--no-checkout', url, req.workdir], gitEnv);
    if (clone.exitCode !== 0) return { ok: false, stage: 'clone', exitCode: clone.exitCode, stderr: clone.stderr };
    const checkout = await run(['timeout', '--kill-after=5', String(CHECKOUT_TIMEOUT_S), ...git, '-C', req.workdir, 'checkout', '--quiet', req.commitSha], gitEnv);
    if (checkout.exitCode !== 0) return { ok: false, stage: 'checkout', exitCode: checkout.exitCode, stderr: checkout.stderr };
    return { ok: true };
  }
}

/** What `container.start()` takes, as far as the runner uses it. */
export type ContainerStartupOptionsLike = Parameters<Container['start']>[0];
