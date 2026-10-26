/**
 * Shared harness for CLI behaviour tests: runs the real CLI (tsx, cli/src/index.ts) against a
 * recording HTTP server on 127.0.0.1. Only 127.0.0.1 is contacted.
 */

import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** What the fake edge answers; the default is 200 `{success:true,data:{}}`. */
export type Responder = (req: Recorded) => { status: number; body: unknown };

export interface CliHarness {
  readonly port: number;
  /** Scratch HOME for the spawned CLI; also a place for per-test config files. */
  readonly home: string;
  /** Same array for the harness's lifetime: `reset()` empties it in place. */
  readonly recorded: Recorded[];
  reset(): void;
  respondWith(responder: Responder | null): void;
  runCli(args: string[], extraEnv?: Record<string, string>, opts?: { stdin?: string }): Promise<CliResult>;
  close(): Promise<void>;
}

const ROOT = join(__dirname, '..', '..');
const TSX = join(ROOT, 'cli/node_modules/.bin/tsx');
const ENTRY = join(ROOT, 'cli/src/index.ts');

export async function startCliHarness(): Promise<CliHarness> {
  if (!existsSync(TSX)) throw new Error(`${TSX} is missing: run \`(cd cli && npm install)\` (docs/SETUP.md)`);

  const recorded: Recorded[] = [];
  let responder: Responder | null = null;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      const entry: Recorded = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      };
      recorded.push(entry);
      const answer = responder ? responder(entry) : { status: 200, body: { success: true, data: {} } };
      res.statusCode = answer.status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const home = mkdtempSync(join(tmpdir(), 'beehive-cli-test-'));

  return {
    port,
    home,
    recorded,
    reset() {
      recorded.length = 0;
    },
    respondWith(r) {
      responder = r;
    },
    runCli(args, extraEnv = {}, opts = {}) {
      return new Promise((resolve) => {
        const child = spawn(TSX, [ENTRY, ...args], {
          cwd: ROOT,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            XDG_CONFIG_HOME: join(home, '.config'),
            BEEHIVE_API_URL: `http://127.0.0.1:${port}`,
            BEEHIVE_API_TOKEN: 'test',
            ...extraEnv,
          },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('close', (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(opts.stdin ?? '');
      });
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    },
  };
}
