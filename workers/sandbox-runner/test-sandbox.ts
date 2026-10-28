/**
 * Gate test sandbox (docs/REAL-GATE-IMPL-PLAN.md sections 1, 2, 4): clone one commit through `ArtifactsGateway`, install the
 * lockfile dependencies of each install directory through `NpmRegistryGateway` (the only other egress), replace both intercepts
 * with a deny handler, then run the repo's own test command with no network. One container per run, destroyed on every path.
 *
 * The verdict comes only from exit codes. The test command is repo-controlled, so a pass proves "the repo's own test command
 * exited 0 in a clean container with no network", nothing more; `counts` parsed from summary lines are advisory.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { isValidNamespace } from '../shared/namespace';
import { CA_CERT, ContainerSandbox, artifactsHost, FORWARDED_HEADERS, REPO_RE, SHA_RE, scrub, type SandboxEnv } from './sandbox-base';

export type TestEnv = SandboxEnv;

export const TEST_ERROR_CODES = ['BAD_REQUEST', 'BAD_NAMESPACE', 'NOT_CONFIGURED', 'SANDBOX_UNAVAILABLE'] as const;
export type TestErrorCode = (typeof TEST_ERROR_CODES)[number];

/** Same transport as `BuildError`: the code is the message prefix because a Durable Object error reaches the Worker as a plain Error. */
export class TestError extends Error {
  constructor(readonly code: TestErrorCode, message: string) {
    super(`${code}: ${message}`);
  }
}

/** What the deadline throws: `test()` turns it into a `timeout_overall` verdict instead of an error. */
class DeadlineError extends TestError {
  constructor() { super('SANDBOX_UNAVAILABLE', `the run exceeded ${TEST_DEADLINE_MS / 1000}s`); }
}

export function parseTestError(error: unknown): { code: TestErrorCode; message: string } | null {
  const text = error instanceof Error ? error.message : String(error);
  const code = TEST_ERROR_CODES.find((c) => text.startsWith(`${c}: `));
  return code ? { code, message: text.slice(code.length + 2) } : null;
}

export const FAILURE_CLASSES = [
  'tests_failed', 'no_tests', 'install_failed', 'killed', 'no_lockfile', 'timeout_install', 'timeout_test', 'timeout_overall', 'clone_failed',
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export const TEST_DEADLINE_MS = 600_000;
export const INSTALL_TIMEOUT_S = 120;
export const TEST_TIMEOUT_S = 300;
export const LOG_TAIL_BYTES = 32_768;
export const TEST_INSTANCE = 'standard-2';
export const NPM_REGISTRY_HOST = 'registry.npmjs.org';
export const DEFAULT_TEST_COMMAND = ['npm', 'test'];
/** The read token is used only by the clone, seconds after it is minted. */
const TOKEN_TTL_S = 300;
/** A hold of 590 s was measured (S5); the alarm backstop destroys a container this Durable Object forgot, so the inactivity timeout is generous. */
const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;
const WORKDIR = '/workspace/cand';
const LOG_DIR = '/workspace/log';
const NPMRC_USER = '/workspace/npmrc-user';
const NPMRC_GLOBAL = '/workspace/npmrc-global';
const PATH_ENV = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const MAX_INSTALL_DIRS = 32;
const INSTALL_DIR_RE = /^(\.|[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*)$/;
/** Constant wrapper: limits, then the argv (positional, never interpolated) with output to a file, not a pipe. */
/**
 * Exit codes of the wrapper: 125 = it could not set the limits (infrastructure; a child that exits 125 is remapped to 1), 124 = the time limit
 * expired (the `timeout` status 124, or 137 after the kill-after KILL with the limit elapsed), 137 otherwise = the process was killed from
 * outside (an out-of-memory kill), anything else = the command's own status. Positional: log, cpu seconds, limit seconds, then the argv.
 */
export const PHASE_SCRIPT = 'log=$1; cpu=$2; lim=$3; shift 3; '
  + '{ ulimit -u 512 && ulimit -t "$cpu" && ulimit -f 4194304; } >>"$log" 2>&1 || exit 125; '
  + 't0=$(date +%s); timeout --kill-after=5 "$lim" "$@" >>"$log" 2>&1; rc=$?; t1=$(date +%s); '
  + '[ "$rc" -eq 125 ] && exit 1; [ "$rc" -eq 137 ] && [ $((t1 - t0)) -ge "$lim" ] && exit 124; exit "$rc"';

export interface TestRequest {
  repo: string;
  commitSha: string;
  namespace?: string;
  /** Directories (relative to the repo root) where `npm ci` runs; each needs a `package-lock.json`. */
  installDirs: string[];
  /** argv of the test command; absent = `npm test`. */
  testCommand?: string[];
}

export interface PhaseResult { ms: number; exit: number | null; timedOut: boolean }

export interface TestResult {
  status: 'pass' | 'fail' | 'error';
  failureClass: FailureClass | null;
  exitCode: number | null;
  phases: { install: PhaseResult | null; test: PhaseResult | null };
  logTail: string;
  logSha256: string | null;
  truncated: boolean;
  imageDigest: string | null;
  instance: string;
  counts: { passed: number; failed: number; skipped: number } | null;
  peakMemMb?: number;
}

export function validateTestRequest(body: unknown): TestRequest {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.repo !== 'string' || !REPO_RE.test(b.repo) || b.repo.includes('..')) {
    throw new TestError('BAD_REQUEST', 'repo must be an Artifacts repository name');
  }
  if (typeof b.commitSha !== 'string' || !SHA_RE.test(b.commitSha)) {
    throw new TestError('BAD_REQUEST', 'commitSha must be a full 40-character lowercase hex commit');
  }
  if (b.namespace !== undefined && !isValidNamespace(b.namespace)) {
    throw new TestError('BAD_NAMESPACE', 'namespace must be an Artifacts namespace name');
  }
  let installDirs = ['.'];
  if (b.installDirs !== undefined) {
    const dirs = b.installDirs;
    if (!Array.isArray(dirs) || dirs.length === 0 || dirs.length > MAX_INSTALL_DIRS
      || !dirs.every((d) => typeof d === 'string' && INSTALL_DIR_RE.test(d))) {
      throw new TestError('BAD_REQUEST', `installDirs must be 1-${MAX_INSTALL_DIRS} relative directories (no "..", no absolute paths)`);
    }
    installDirs = [...new Set(dirs as string[])];
  }
  let testCommand: string[] | undefined;
  if (b.testCommand !== undefined) {
    const c = b.testCommand;
    // eslint-disable-next-line no-control-regex
    if (!Array.isArray(c) || c.length === 0 || c.length > 16 || !c.every((a) => typeof a === 'string' && a.length > 0 && a.length <= 256 && !/[\u0000-\u001f]/.test(a))) {
      throw new TestError('BAD_REQUEST', 'testCommand must be an argv array of 1-16 non-empty strings');
    }
    if ((c as string[])[0].startsWith('-')) throw new TestError('BAD_REQUEST', 'testCommand[0] must be a program, not an option');
    testCommand = c as string[];
  }
  return {
    repo: b.repo, commitSha: b.commitSha, installDirs,
    ...(b.namespace === undefined ? {} : { namespace: b.namespace as string }),
    ...(testCommand ? { testCommand } : {}),
  };
}

/** `Tests  1380 passed | 30 skipped (1410)` (vitest) or `Tests:       1 failed, 5 passed, 6 total` (jest); the last such line wins. Advisory only. */
export function parseCounts(log: string): TestResult['counts'] {
  // eslint-disable-next-line no-control-regex
  const clean = log.replace(/\u001b\[[0-9;]*m/g, '');
  let found: TestResult['counts'] = null;
  for (const line of clean.split('\n')) {
    const m = /^\s*Tests:?\s+(.*)$/.exec(line);
    if (!m) continue;
    const num = (word: string) => {
      const hit = new RegExp(`(\\d+)\\s+${word}\\b`).exec(m[1]);
      return hit ? Number(hit[1]) : 0;
    };
    const counts = { passed: num('passed'), failed: num('failed'), skipped: num('skipped') + num('todo') };
    if (counts.passed + counts.failed + counts.skipped > 0 || /\b0 (passed|total)\b/.test(m[1])) found = counts;
  }
  return found;
}

/**
 * The only egress of the install phase: GET on the npm registry host, nothing else. Props `deny` turn it into the "deny"
 * replacement handler (intercepts can be replaced, not removed; docs/OPEN-QUESTIONS.md 2026-10-28, S4): every request gets 403.
 */
export class NpmRegistryGateway extends WorkerEntrypoint<unknown, { deny?: boolean }> {
  async fetch(request: Request): Promise<Response> {
    const props = this.ctx.props as { deny?: boolean } | undefined;
    if (props?.deny) return new Response('Network access is off', { status: 403 });
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.protocol !== 'https:' || url.hostname !== NPM_REGISTRY_HOST) {
      return new Response('Only GET on the npm registry is allowed', { status: 403 });
    }
    // No Authorization and no cookies: the registry is read anonymously.
    const headers = new Headers();
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const res = await fetch(new Request(request, { headers, redirect: 'manual' }));
    if (res.status >= 300 && res.status < 400) return new Response('Unexpected redirect from the npm registry', { status: 502 });
    return res;
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const timedOut = (exit: number) => exit === 124;
/** SIGKILL from outside the limit (the kernel's out-of-memory killer): its own class, not a timeout. */
const killed = (exit: number | null) => exit === 137;

export class TestSandbox extends ContainerSandbox<TestEnv> {
  /** Runs in progress by request: a repeat call (a queue retry after a caller timeout) shares the running one. */
  private inflight = new Map<string, Promise<TestResult>>();

  protected deadlineMs() { return TEST_DEADLINE_MS; }
  protected inactivityMs() { return INACTIVITY_TIMEOUT_MS; }
  protected logName() { return 'TestSandbox'; }
  protected failure(kind: 'deadline' | 'abandoned') {
    return kind === 'deadline' ? new DeadlineError() : new TestError('SANDBOX_UNAVAILABLE', 'the run was abandoned');
  }
  protected startOptions() {
    return {
      image: this.container.images.test,
      // Size by measurement (S2). `instance_type` cannot be set in wrangler under the durable_object policy, so this is the only place.
      instance: TEST_INSTANCE as 'standard-2',
      // Reaches only the hostnames intercepted per run.
      enableInternet: false,
    };
  }

  private namespaceFor(req: TestRequest): string {
    return req.namespace ?? this.env.ARTIFACTS_NAMESPACE ?? 'default';
  }

  test(input: TestRequest): Promise<TestResult> {
    const req = validateTestRequest(input);
    const key = `${this.namespaceFor(req)}/${req.repo}@${req.commitSha}:${req.installDirs.join(',')}:${(req.testCommand ?? DEFAULT_TEST_COMMAND).join(' ')}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const result = this.serialize(() => this.guarded((token) => this.testInner(req, token))).catch(async (error): Promise<TestResult> => {
      // The deadline is a verdict-shaped error (timeout_overall, retried by the gate); everything else reaches the route as a thrown error.
      if (error instanceof DeadlineError) return this.result({ status: 'error', failureClass: 'timeout_overall' });
      throw error;
    }).finally(() => { this.inflight.delete(key); });
    result.catch(() => undefined);
    this.inflight.set(key, result);
    return result;
  }

  private result(partial: Partial<TestResult> & Pick<TestResult, 'status' | 'failureClass'>): TestResult {
    const images = this.ctx.container?.images as Record<string, string> | undefined;
    return {
      exitCode: null, phases: { install: null, test: null }, logTail: '', logSha256: null, truncated: false,
      imageDigest: /@(sha256:[0-9a-f]{64})/.exec(images?.test ?? '')?.[1] ?? null, instance: TEST_INSTANCE, counts: null,
      ...partial,
    };
  }

  /** Last bytes of a phase log, scrubbed, with the hash of the whole (size-capped) file. */
  private async readLog(run: RunFnLike, file: string): Promise<Pick<TestResult, 'logTail' | 'logSha256' | 'truncated'>> {
    const tail = await run(['tail', '-c', String(LOG_TAIL_BYTES), file]);
    const size = Number((await run(['wc', '-c', file])).stdout.trim().split(/\s+/)[0]);
    const sum = /^[0-9a-f]{64}/.exec((await run(['sha256sum', file])).stdout);
    return { logTail: scrub(tail.stdout, LOG_TAIL_BYTES), logSha256: sum ? sum[0] : null, truncated: Number.isFinite(size) && size > LOG_TAIL_BYTES };
  }

  private async testInner(req: TestRequest, token: symbol): Promise<TestResult> {
    const run: RunFnLike = (cmd, env, cwd) => { this.assertActive(token); return this.run(cmd, env, cwd); };
    const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken } = this.env;
    const namespace = this.namespaceFor(req);
    if (!accountId || !apiToken || !isValidNamespace(namespace)) throw new TestError('NOT_CONFIGURED', 'the test service is not configured');

    let readToken: string;
    try {
      readToken = await this.mintReadToken(accountId, apiToken, namespace, req.repo, TOKEN_TTL_S);
    } catch (error) {
      console.error('[TestSandbox] read token mint failed:', error instanceof Error ? error.message : String(error));
      throw new TestError('SANDBOX_UNAVAILABLE', 'could not obtain read access to the repository');
    }

    this.assertActive(token);
    try {
      await this.start();
    } catch (error) {
      console.error('[TestSandbox] start failed:', error instanceof Error ? error.message : String(error));
      throw new TestError('SANDBOX_UNAVAILABLE', 'the test container could not be started');
    }
    this.assertActive(token);

    const exports = this.ctx.exports as unknown as { NpmRegistryGateway: (o: { props: { deny?: boolean } }) => Fetcher };
    const denyAll = async () => {
      const deny = exports.NpmRegistryGateway({ props: { deny: true } });
      await Promise.all([NPM_REGISTRY_HOST, artifactsHost(accountId)].map((host) => this.container.interceptOutboundHttps(host, deny)));
    };
    await this.container.interceptOutboundHttps(NPM_REGISTRY_HOST, exports.NpmRegistryGateway({ props: {} }));

    const cloned = await this.cloneCommit(run, { accountId, namespace, repo: req.repo, commitSha: req.commitSha, token: readToken, clean: [WORKDIR, LOG_DIR, NPMRC_USER, NPMRC_GLOBAL], workdir: WORKDIR });
    if (!cloned.ok) {
      console.error(`[TestSandbox] ${cloned.stage} of ${req.repo}@${req.commitSha} failed (${cloned.exitCode}):`, scrub(cloned.stderr, 500));
      return this.result({ status: 'error', failureClass: 'clone_failed', exitCode: cloned.exitCode });
    }

    // Every install directory needs a lockfile, checked before anything is installed. Two distinct empty npm config files (S1: one
    // file as both user and global config fails), and the repo's own .npmrc is deleted so it cannot redirect the registry.
    for (const dir of req.installDirs) {
      if ((await run(['test', '-f', `${WORKDIR}/${dir}/package-lock.json`])).exitCode !== 0) {
        return this.result({ status: 'fail', failureClass: 'no_lockfile' });
      }
    }
    await run(['mkdir', '-p', LOG_DIR]);
    await run(['touch', NPMRC_USER, NPMRC_GLOBAL]);
    // Every .npmrc of the clone (a nested one could still be read by a tool), none of node_modules' own.
    await run(['find', WORKDIR, '-name', '.npmrc', '-not', '-path', '*/node_modules/*', '-delete']);
    const npmEnv = { PATH: PATH_ENV, HOME: '/workspace', CI: '1', NPM_CONFIG_USERCONFIG: NPMRC_USER, NPM_CONFIG_GLOBALCONFIG: NPMRC_GLOBAL, NPM_CONFIG_CACHE: '/workspace/npm-cache' };
    const phase = async (name: string, dir: string, argv: string[], env: Record<string, string>, limitS: number): Promise<PhaseResult> => {
      const started = Date.now();
      const out = await run(['sh', '-c', PHASE_SCRIPT, 'sh', `${LOG_DIR}/${name}.log`, String(limitS * 2), String(limitS), ...argv], env, dir === '.' ? WORKDIR : `${WORKDIR}/${dir}`);
      // The limits could not be set: the run says nothing about the repo, so it is an infrastructure error (non-2xx, retried by the gate).
      if (out.exitCode === 125) throw new TestError('SANDBOX_UNAVAILABLE', 'the sandbox could not apply its resource limits');
      return { ms: Date.now() - started, exit: out.exitCode, timedOut: timedOut(out.exitCode) };
    };

    // Install: one `npm ci` per directory, sharing one budget.
    const installStart = Date.now();
    let install: PhaseResult = { ms: 0, exit: 0, timedOut: false };
    for (const dir of req.installDirs) {
      const remaining = Math.ceil(INSTALL_TIMEOUT_S - (Date.now() - installStart) / 1000);
      if (remaining <= 0) { install = { ms: Date.now() - installStart, exit: 124, timedOut: true }; break; }
      const step = await phase('install', dir, ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--registry', `https://${NPM_REGISTRY_HOST}/`], { ...npmEnv, NODE_EXTRA_CA_CERTS: CA_CERT }, remaining);
      install = { ms: Date.now() - installStart, exit: step.exit, timedOut: step.timedOut };
      if (step.exit !== 0) break;
    }
    if (install.exit !== 0) {
      return this.result({
        status: 'fail', failureClass: install.timedOut ? 'timeout_install' : killed(install.exit) ? 'killed' : 'install_failed', exitCode: install.exit,
        phases: { install, test: null }, ...(await this.readLog(run, `${LOG_DIR}/install.log`)),
      });
    }

    // Network off. A failed swap must not fall through to running the tests with the registry reachable.
    try {
      await denyAll();
    } catch (error) {
      console.error('[TestSandbox] could not close the network:', error instanceof Error ? error.message : String(error));
      throw new TestError('SANDBOX_UNAVAILABLE', 'the network could not be closed');
    }

    const testEnv = { PATH: PATH_ENV, HOME: '/workspace', CI: '1', NPM_CONFIG_USERCONFIG: NPMRC_USER, NPM_CONFIG_GLOBALCONFIG: NPMRC_GLOBAL, NPM_CONFIG_CACHE: '/workspace/npm-cache' };
    const test = await phase('test', '.', req.testCommand ?? DEFAULT_TEST_COMMAND, testEnv, TEST_TIMEOUT_S);
    const log = await this.readLog(run, `${LOG_DIR}/test.log`);
    const phases = { install, test };
    const counts = parseCounts(log.logTail);
    if (test.exit !== 0) {
      return this.result({ status: 'fail', failureClass: test.timedOut ? 'timeout_test' : killed(test.exit) ? 'killed' : 'tests_failed', exitCode: test.exit, phases, counts, ...log });
    }
    if (counts && counts.passed === 0) return this.result({ status: 'fail', failureClass: 'no_tests', exitCode: 0, phases, counts, ...log });
    return this.result({ status: 'pass', failureClass: null, exitCode: 0, phases, counts, ...log });
  }
}

type RunFnLike = (cmd: string[], env?: Record<string, string>, cwd?: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
