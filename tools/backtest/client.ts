// The ONE model-call interface. FakeClient (all tests) and ClaudeCliClient (real, shells out to `claude -p`).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec } from './exec.ts';

export type Role = 'issue' | 'spec' | 'candidate' | 'grade' | 'leakage' | 'smoke';

export interface ModelRequest {
  role: Role;
  rowId?: string;
  prompt: string;
  /** none = text only; read = Read/Grep/Glob in cwd; agent = read + edit + a small Bash allowlist, in cwd. */
  tools: 'none' | 'read' | 'agent';
  cwd?: string;
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
  costUsd?: number;
  stopReason?: ModelResponse['stopReason'];
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
      costUsd: r.costUsd ?? 0,
      durationMs: 1,
      stopReason: r.stopReason ?? 'done',
    };
  }
}

// ---------------------------------------------------------------- real

export const MODEL = 'claude-sonnet-5-5';
export const EFFORT = 'medium';

/**
 * Env the CLI child may see: an explicit allow-list. HOME is needed for the CLI's own login; CLAUDE_CONFIG_DIR is a
 * config path (not a secret) and only passes if the user set it. No API key or token variable is passed through: the
 * CLI authenticates from its login under HOME. If a host can only authenticate through an env token, the real client
 * fails at the first call and that must be fixed deliberately, not by widening this list.
 */
const ENV_ALLOW = ['PATH', 'HOME', 'LANG', 'TERM', 'CLAUDE_CONFIG_DIR'];

export function childEnv(src: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { CI: '1', NO_COLOR: '1' };
  for (const k of ENV_ALLOW) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

const FILE_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep'];

// Only reachable with --allow-bash AND an OS sandbox (bubblewrap): local test/typecheck/inspection commands.
const BASH_ALLOW = ['npx vitest:*', 'npx tsc:*', 'git status:*', 'git diff:*', 'git log:*', 'git show:*', 'ls:*', 'grep:*', 'head:*', 'tail:*', 'wc:*'];
const DENY = ['WebFetch', 'WebSearch', 'Bash(curl:*)', 'Bash(wget:*)', 'Bash(git push:*)', 'Bash(git remote:*)', 'Bash(git fetch:*)', 'Bash(git pull:*)', 'Bash(git clone:*)', 'Bash(ssh:*)', 'Bash(npm:*)', 'Bash(node:*)', 'Bash(wrangler:*)', 'Bash(npx wrangler:*)'];

export interface ArgOptions {
  allowBash?: boolean;
}

export function buildClaudeArgs(req: Pick<ModelRequest, 'tools'>, opts: ArgOptions = {}): string[] {
  const args = [
    '-p',
    '--model', MODEL,
    '--effort', EFFORT,
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
  if (bash) args.push('--settings', JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true } }));
  args.push('--tools', tools.join(','));
  return args;
}

/** First directory on PATH holding an executable `name`, else null. */
export function findOnPath(name: string, pathVar = process.env.PATH ?? ''): string | null {
  for (const d of pathVar.split(path.delimiter).filter(Boolean)) {
    const p = path.join(d, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return null;
}

export interface StreamState {
  assistantIds: Set<string>;
  lastText: string;
  /** The latest assistant message asked for a tool, so another API call will follow unless the run is stopped. */
  pendingTool?: boolean;
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
  } else if (ev?.type === 'result') {
    st.result = ev;
  }
}

export function responseFromStream(st: StreamState, durationMs: number, stopReason: ModelResponse['stopReason']): ModelResponse {
  const r = st.result;
  const u = r?.usage ?? {};
  const turns = typeof r?.num_turns === 'number' ? r.num_turns : 0;
  const calls = st.assistantIds.size || turns;
  const isErr = r ? r.is_error === true : false;
  return {
    text: typeof r?.result === 'string' && r.result ? r.result : st.lastText,
    calls,
    usage: {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
    },
    costUsd: typeof r?.total_cost_usd === 'number' ? r.total_cost_usd : null,
    durationMs,
    stopReason: stopReason !== 'done' ? stopReason : isErr || !r ? 'error' : 'done',
  };
}

export interface ClaudeCliOptions {
  bin?: string;
  /** Keep the Bash tool for candidates. Refuses to construct unless an OS sandbox (bubblewrap) is on PATH. */
  allowBash?: boolean;
  which?: (name: string) => string | null;
  log?: (s: string) => void;
}

/** True once the limit is reached and the agent has asked for another turn: stop before that call is made. */
export function shouldStop(st: StreamState, maxCalls: number): boolean {
  return !st.result && st.assistantIds.size >= maxCalls && st.pendingTool === true;
}

export class ClaudeCliClient implements ModelClient {
  readonly name = 'claude-cli';
  readonly sandbox: string | null;
  private readonly bin: string;
  private readonly allowBash: boolean;

  constructor(opts: ClaudeCliOptions = {}) {
    this.bin = opts.bin ?? 'claude';
    this.allowBash = opts.allowBash === true;
    this.sandbox = null;
    if (this.allowBash) {
      const bwrap = (opts.which ?? ((n: string) => findOnPath(n)))('bwrap');
      if (!bwrap) throw new Error('--allow-bash refused: no OS sandbox found (bubblewrap `bwrap` is not on PATH). Candidates stay file-tools-only.');
      this.sandbox = `bubblewrap (${bwrap}) via Claude Code sandbox settings`;
      (opts.log ?? (() => {}))(`Bash enabled for candidates; active sandbox: ${this.sandbox}`);
    }
  }

  async run(req: ModelRequest): Promise<ModelResponse> {
    const ownTmp = req.cwd ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'backtest-text-'));
    const cwd = req.cwd ?? ownTmp!;
    const st: StreamState = { assistantIds: new Set(), lastText: '', result: null };
    let limited = false;
    const t0 = Date.now();
    const r = await exec(this.bin, buildClaudeArgs(req, { allowBash: this.allowBash }), {
      cwd,
      env: childEnv(),
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
    return responseFromStream(st, Date.now() - t0, r.timedOut ? 'timeout' : limited ? 'call-limit' : 'done');
  }
}
