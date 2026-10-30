// Subprocess helper: no shell, process-group kill on timeout, capped output.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
  /** Called per stdout line; return true to kill the process (used for call limits). */
  onStdoutLine?: (line: string) => boolean | void;
}

const MAX_OUT = 32 * 1024 * 1024;

export function exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let lineBuf = '';
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killGroup();
        }, opts.timeoutMs)
      : null;
    child.stdout.on('data', (d: Buffer) => {
      const s = d.toString('utf8');
      if (stdout.length < MAX_OUT) stdout += s;
      if (opts.onStdoutLine) {
        lineBuf += s;
        let i;
        while ((i = lineBuf.indexOf('\n')) >= 0) {
          const line = lineBuf.slice(0, i);
          lineBuf = lineBuf.slice(i + 1);
          if (opts.onStdoutLine(line) === true) killGroup();
        }
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < MAX_OUT) stderr += d.toString('utf8');
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + String(e), timedOut });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (opts.onStdoutLine && lineBuf) opts.onStdoutLine(lineBuf);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input ?? '');
  });
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
