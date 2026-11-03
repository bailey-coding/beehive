// The ONE model-call interface. FakeClient (all tests) and ClaudeCliClient (real, shells out to `claude -p`).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PrivateConfig } from './claudeconfig.ts';
import type { BashBox, BashSandboxProof } from './bashsandbox.ts';
import { writePrefixScript } from './bashsandbox.ts';
import { exec, findOnPath } from './exec.ts';

export { findOnPath };

export type Role = 'issue' | 'spec' | 'candidate' | 'grade' | 'leakage' | 'smoke';

export interface ModelRequest {
  role: Role;
  rowId?: string;
  prompt: string;
  /** none = text only; read = Read/Grep/Glob in cwd; agent = read + edit + a small Bash allowlist, in cwd. */
  tools: 'none' | 'read' | 'agent';
  cwd?: string;
  /** Required for tools 'agent' when the client runs with Bash: the agent's private root, worktree and tmp. */
  bashBox?: Pick<BashBox, 'agentRoot' | 'cwd' | 'tmpDir'>;
  /** Call limit: assistant API requests. The client stops the run when exceeded. */
  maxCalls: number;
  timeoutMs: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface ModelResponse {
  text: string;
  calls: number;
  usage: Usage;
  costUsd: number | null;
  durationMs: number;
  stopReason: 'done' | 'call-limit' | 'timeout' | 'error';
  /** CLI exit code (null: killed or never started). Fakes report 0. */
  exitCode: number | null;
  /** Set when stopReason is 'error': exit code, the CLI's own error text and trimmed stderr, token patterns redacted. */
  error?: string;
  /** Tools announced by the CLI's init event (used by the canary to prove Bash is absent). */
  initTools?: string[];
  /** Model the CLI reported in its init event (the one that actually answered; may differ from the one requested). */
  model?: string;
  /** Usage was summed from per-message events because no result event arrived (a killed run): tokens are a lower bound. */
  usageLowerBound?: boolean;
  /** Set by BudgetedClient when costUsd is null: the upper bound charged toward the dollar cap, not a measurement. */
  estimatedUsd?: number;
}

export interface ModelClient {
  readonly name: string;
  run(req: ModelRequest): Promise<ModelResponse>;
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

// ---------------------------------------------------------------- fake

export interface FakeReply {
  text: string;
  calls?: number;
  usage?: Partial<Usage>;
  /** null: the CLI reported no cost (a killed run). Default 0. */
  costUsd?: number | null;
  stopReason?: ModelResponse['stopReason'];
  initTools?: string[];
  error?: string;
  /** The model the fake "CLI" reports in its init event. */
  model?: string;
  usageLowerBound?: boolean;
}

/** Deterministic client: a handler maps a request to a reply. It may write files into req.cwd to act as an agent. */
export class FakeClient implements ModelClient {
  readonly name = 'fake';
  readonly requests: ModelRequest[] = [];
  constructor(private readonly handler: (req: ModelRequest, n: number) => FakeReply | Promise<FakeReply>) {}

  async run(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(req);
    const r = await this.handler(req, this.requests.length);
    const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0, ...r.usage };
    return {
      text: r.text,
      calls: r.calls ?? 1,
      usage,
      costUsd: r.costUsd === undefined ? 0 : r.costUsd,
      durationMs: 1,
      stopReason: r.stopReason ?? 'done',
      exitCode: r.stopReason === 'error' ? 1 : 0,
      error: r.error,
      initTools: r.initTools,
      ...(r.model ? { model: r.model } : {}),
      ...(r.usageLowerBound ? { usageLowerBound: true } : {}),
    };
  }
}

// ---------------------------------------------------------------- real

export const MODEL = 'claude-sonnet-5-5';
export const EFFORT = 'medium';
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

/**
 * Env the CLI child may see: PATH, LANG, TERM, and a private HOME and CLAUDE_CONFIG_DIR (see claudeconfig.ts) that hold
 * only a copy of the login. No API key or token variable is passed through, and nothing of the user's own Claude config
 * (CLAUDE.md, settings, memory, plugins) is reachable, so no user-level instruction can reach any arm.
 */
export function childEnv(priv: Pick<PrivateConfig, 'dir' | 'home'>, src: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { CI: '1', NO_COLOR: '1', HOME: priv.home, CLAUDE_CONFIG_DIR: priv.dir, ...extra };
  for (const k of ['PATH', 'LANG', 'TERM']) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

const TOKEN_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]+/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  /((?:token|key|secret|password|authorization)["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b[A-Fa-f0-9]{40,}\b/g,
];

/** Redact anything token-shaped and trim to the tail. */
export function redact(text: string, max = 500): string {
  let t = text;
  for (const p of TOKEN_PATTERNS) t = t.replace(p, (_m, pre) => `${typeof pre === 'string' ? pre : ''}[redacted]`);
  t = t.trim();
  return t.length > max ? `...${t.slice(-max)}` : t;
}

const FILE_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep'];

// Only reachable with --allow-bash, where every Bash command runs inside bwrap (no network, no HOME, private root and /tmp).
// Defence in depth on top of the sandbox: local build/test/inspection commands only.
const BASH_ALLOW = ['npx vitest:*', 'npx tsc:*', 'node:*', 'git status:*', 'git diff:*', 'git log:*', 'git show:*', 'git add:*', 'git commit:*', 'ls:*', 'cat:*', 'grep:*', 'head:*', 'tail:*', 'wc:*', 'mkdir:*', 'sed:*', 'echo:*', 'pwd'];
const DENY = ['WebFetch', 'WebSearch', 'Bash(curl:*)', 'Bash(wget:*)', 'Bash(git push:*)', 'Bash(git remote:*)', 'Bash(git fetch:*)', 'Bash(git pull:*)', 'Bash(git clone:*)', 'Bash(ssh:*)', 'Bash(npm:*)', 'Bash(wrangler:*)', 'Bash(npx wrangler:*)'];

export interface ArgOptions {
  allowBash?: boolean;
  model?: string;
  /** Default 'medium' (the harness's one setting before arms existed). */
  effort?: Effort;
}

export function buildClaudeArgs(req: Pick<ModelRequest, 'tools'>, opts: ArgOptions = {}): string[] {
  const args = [
    '-p',
    '--model', opts.model ?? MODEL,
    '--effort', opts.effort ?? EFFORT,
    '--output-format', 'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--restricted',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none',
  ];
  // Default: file tools only, never Bash (no OS sandbox on the default host; --restricted confines only the file tools).
  const bash = req.tools === 'agent' && opts.allowBash === true;
  const tools = req.tools === 'none' ? [] : req.tools === 'read' ? ['Read', 'Glob', 'Grep'] : [...FILE_TOOLS, ...(bash ? ['Bash'] : [])];
  if (tools.length) args.push('--allowedTools', ...tools, ...(bash ? BASH_ALLOW.map((b) => `Bash(${b})`) : []));
  args.push('--disallowedTools', ...DENY);
  args.push('--tools', tools.join(','));
  return args;
}

export interface StreamState {
  assistantIds: Set<string>;
  lastText: string;
  /** The latest assistant message asked for a tool, so another API call will follow unless the run is stopped. */
  pendingTool?: boolean;
  initTools?: string[];
  /** Model named by the init event. */
  model?: string;
  /** Latest usage per assistant message id (a message streams as several events that repeat its usage). */
  usageById?: Map<string, Usage>;
  result: Record<string, any> | null;
}

export function parseStreamLine(line: string, st: StreamState): void {
  let ev: any;
  try {
    ev = JSON.parse(line);
  } catch {
    return;
  }
  if (ev?.type === 'assistant' && ev.message) {
    const id = String(ev.message.id ?? `anon-${st.assistantIds.size}`);
    st.assistantIds.add(id);
    const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
    const t = blocks.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('');
    if (t) st.lastText = t;
    st.pendingTool = blocks.some((b: any) => b?.type === 'tool_use');
    const mu = ev.message.usage;
    if (mu && typeof mu === 'object') {
      (st.usageById ??= new Map()).set(id, {
        inputTokens: Number(mu.input_tokens) || 0,
        outputTokens: Number(mu.output_tokens) || 0,
        cacheReadTokens: Number(mu.cache_read_input_tokens) || 0,
        cacheCreationTokens: Number(mu.cache_creation_input_tokens) || 0,
      });
    }
  } else if (ev?.type === 'system' && ev.subtype === 'init') {
    if (Array.isArray(ev.tools)) st.initTools = ev.tools.map((t: unknown) => (typeof t === 'string' ? t : String((t as { name?: unknown })?.name ?? '')));
    if (typeof ev.model === 'string' && ev.model) st.model = ev.model;
  } else if (ev?.type === 'result') {
    st.result = ev;
  }
}

export function sumUsage(us: Usage[]): Usage {
  const z: Usage = { ...ZERO_USAGE };
  for (const u of us) {
    z.inputTokens += u.inputTokens;
    z.outputTokens += u.outputTokens;
    z.cacheReadTokens += u.cacheReadTokens;
    z.cacheCreationTokens += u.cacheCreationTokens;
  }
  return z;
}

export function responseFromStream(st: StreamState, durationMs: number, stopReason: ModelResponse['stopReason'], exit: { code: number | null; stderr: string } = { code: 0, stderr: '' }): ModelResponse {
  const r = st.result;
  const u = r?.usage ?? {};
  const turns = typeof r?.num_turns === 'number' ? r.num_turns : 0;
  const calls = st.assistantIds.size || turns;
  const isErr = r ? r.is_error === true : false;
  // A killed run has no result event: fall back to the per-message usage seen so far (a lower bound, never zeros).
  const seen = sumUsage([...(st.usageById?.values() ?? [])]);
  const useSeen = !r?.usage && st.usageById !== undefined && st.usageById.size > 0;
  const failed = stopReason === 'done' && (isErr || !r || (exit.code !== 0 && exit.code !== null));
  const finalReason = stopReason !== 'done' ? stopReason : failed ? 'error' : 'done';
  // An error result's text is the CLI's error message, not model output: never return it as the reply.
  const text = isErr ? '' : typeof r?.result === 'string' && r.result ? r.result : st.lastText;
  const parts = failed ? [`exit code ${exit.code}`, isErr && typeof r?.result === 'string' ? `cli: ${r.result}` : '', exit.stderr ? `stderr: ${exit.stderr}` : '', !r ? 'no result event' : ''].filter(Boolean) : [];
  return {
    text,
    calls,
    usage: useSeen ? seen : {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
    },
    ...(useSeen ? { usageLowerBound: true } : {}),
    ...(st.model ? { model: st.model } : {}),
    costUsd: typeof r?.total_cost_usd === 'number' ? r.total_cost_usd : null,
    durationMs,
    stopReason: finalReason,
    exitCode: exit.code,
    error: failed ? redact(parts.join('; ')) : undefined,
    initTools: st.initTools,
  };
}

export interface ClaudeCliOptions {
  bin?: string;
  /** Private config (credentials copy only). Required: the client never runs against the user's own config. */
  config: PrivateConfig;
  /** Model override (the canary uses a deliberately bad id). */
  model?: string;
  /** Reasoning effort passed as --effort (default 'medium'). */
  effort?: Effort;
  /** Keep the Bash tool for candidates, run inside bwrap. Needs `bash`, a passing proveBashSandbox() result. */
  allowBash?: boolean;
  bash?: BashSandboxProof;
  log?: (s: string) => void;
}

/** True once the limit is reached and the agent has asked for another turn: stop before that call is made. */
export function shouldStop(st: StreamState, maxCalls: number): boolean {
  return !st.result && st.assistantIds.size >= maxCalls && st.pendingTool === true;
}

export class ClaudeCliClient implements ModelClient {
  readonly name = 'claude-cli';
  /** Which sandbox runs the Bash tool (null: Bash is off). */
  readonly sandbox: string | null;
  private readonly bin: string;
  private readonly allowBash: boolean;
  private readonly config: PrivateConfig;
  private readonly model: string;
  private readonly effort: Effort;
  private readonly bwrap: string | null;
  private scriptDir: string | null = null;

  constructor(opts: ClaudeCliOptions) {
    this.config = opts.config;
    this.model = opts.model ?? MODEL;
    this.effort = opts.effort ?? EFFORT;
    if (!EFFORTS.includes(this.effort)) throw new Error(`effort ${JSON.stringify(opts.effort)} is not one of ${EFFORTS.join(', ')}`);
    this.bin = opts.bin ?? 'claude';
    this.allowBash = opts.allowBash === true;
    this.sandbox = null;
    this.bwrap = null;
    if (this.allowBash) {
      if (!opts.bash || !opts.bash.ok || !opts.bash.bwrap) throw new Error(`--allow-bash refused: ${opts.bash?.detail ?? 'the bwrap sandbox probe was not run'}. Candidates stay file-tools-only.`);
      this.bwrap = opts.bash.bwrap;
      this.sandbox = opts.bash.detail;
      (opts.log ?? (() => {}))(`Bash enabled for candidates; active sandbox: ${this.sandbox}`);
    }
  }

  async run(req: ModelRequest): Promise<ModelResponse> {
    const ownTmp = req.cwd ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'backtest-text-'));
    const cwd = req.cwd ?? ownTmp!;
    const st: StreamState = { assistantIds: new Set(), lastText: '', result: null };
    let limited = false;
    const extra: Record<string, string> = {};
    const withBash = this.allowBash && req.tools === 'agent';
    if (withBash) {
      if (!req.bashBox) throw new Error('agent run with Bash needs request.bashBox (private root, worktree, tmp)');
      // The CLI writes shell snapshots here and the sandboxed shell sources them: read-only, and ONLY this dir (the
      // config dir itself holds the credentials copy and is never mounted).
      const snapshotDir = path.join(this.config.dir, 'shell-snapshots');
      fs.mkdirSync(snapshotDir, { recursive: true });
      fs.mkdirSync(req.bashBox.tmpDir, { recursive: true });
      this.scriptDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'bt-bashwrap-'));
      extra.CLAUDE_CODE_SHELL_PREFIX = writePrefixScript(this.scriptDir, this.bwrap!, { ...req.bashBox, extraRo: [snapshotDir] });
      extra.TMPDIR = req.bashBox.tmpDir;
    }
    const t0 = Date.now();
    const r = await exec(this.bin, buildClaudeArgs(req, { allowBash: this.allowBash, model: this.model, effort: this.effort }), {
      cwd,
      env: childEnv(this.config, process.env, extra),
      timeoutMs: req.timeoutMs,
      input: req.prompt,
      onStdoutLine: (line) => {
        parseStreamLine(line, st);
        if (shouldStop(st, req.maxCalls)) {
          limited = true;
          return true;
        }
      },
    });
    if (ownTmp) fs.rmSync(ownTmp, { recursive: true, force: true });
    return responseFromStream(st, Date.now() - t0, r.timedOut ? 'timeout' : limited ? 'call-limit' : 'done', { code: r.code, stderr: redact(r.stderr) });
  }

  dispose(): void {
    if (this.scriptDir) fs.rmSync(this.scriptDir, { recursive: true, force: true });
  }
}
