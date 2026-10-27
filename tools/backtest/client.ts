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

/** Env names the CLI child may see. Credentials are passed through by name without being read or logged. */
const ENV_ALLOW = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'SHELL', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

export function childEnv(src: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { CI: '1', NO_COLOR: '1' };
  for (const k of ENV_ALLOW) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

// Bash is limited to local test/typecheck/inspection commands: no network clients, no git push/remote/fetch.
const AGENT_BASH_ALLOW = ['npx vitest:*', 'npx tsc:*', 'node:*', 'git status:*', 'git diff:*', 'git log:*', 'git add:*', 'git commit:*', 'git show:*', 'ls:*', 'cat:*', 'grep:*', 'head:*', 'tail:*', 'wc:*', 'mkdir:*', 'sed:*'];
const DENY = ['WebFetch', 'WebSearch', 'Bash(curl:*)', 'Bash(wget:*)', 'Bash(git push:*)', 'Bash(git remote:*)', 'Bash(git fetch:*)', 'Bash(git pull:*)', 'Bash(git clone:*)', 'Bash(ssh:*)', 'Bash(npm:*)', 'Bash(wrangler:*)', 'Bash(npx wrangler:*)'];

export function buildClaudeArgs(req: Pick<ModelRequest, 'tools'>): string[] {
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
  if (req.tools === 'agent') {
    args.push('--allowedTools', ...['Read', 'Edit', 'Write', 'Glob', 'Grep', ...AGENT_BASH_ALLOW.map((b) => `Bash(${b})`)]);
  } else if (req.tools === 'read') {
    args.push('--allowedTools', 'Read', 'Glob', 'Grep');
  }
  args.push('--disallowedTools', ...DENY);
  args.push('--tools', req.tools === 'none' ? '' : req.tools === 'read' ? 'Read,Glob,Grep' : 'Read,Edit,Write,Glob,Grep,Bash');
  return args;
}

interface StreamState {
  assistantIds: Set<string>;
  lastText: string;
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

export class ClaudeCliClient implements ModelClient {
  readonly name = 'claude-cli';
  constructor(private readonly bin = 'claude') {}

  async run(req: ModelRequest): Promise<ModelResponse> {
    const ownTmp = req.cwd ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'backtest-text-'));
    const cwd = req.cwd ?? ownTmp!;
    const st: StreamState = { assistantIds: new Set(), lastText: '', result: null };
    let limited = false;
    const t0 = Date.now();
    const r = await exec(this.bin, buildClaudeArgs(req), {
      cwd,
      env: childEnv(),
      timeoutMs: req.timeoutMs,
      input: req.prompt,
      onStdoutLine: (line) => {
        parseStreamLine(line, st);
        if (st.assistantIds.size > req.maxCalls && !st.result) {
          limited = true;
          return true;
        }
      },
    });
    if (ownTmp) fs.rmSync(ownTmp, { recursive: true, force: true });
    return responseFromStream(st, Date.now() - t0, r.timedOut ? 'timeout' : limited ? 'call-limit' : 'done');
  }
}
