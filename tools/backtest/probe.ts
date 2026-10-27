// Probe helper written into every checkout. Acceptance tests (and nothing else the agents control) call
// record() so the same requests can be replayed against base, candidate and reference and diffed.
import fs from 'node:fs';
import path from 'node:path';
import type { ResponseRecord } from './delta.ts';
import { ACCEPTANCE_DIR } from './spec.ts';

export const PROBE_FILE = `${ACCEPTANCE_DIR}/probe.ts`;
export const PROBE_ENV = 'BACKTEST_PROBE_OUT';

export const PROBE_SOURCE = `// Written by the backtest harness. record() appends one response record to $${PROBE_ENV} (JSONL).
import fs from 'node:fs';

export async function record(label: string, request: Request, response: Response): Promise<Response> {
  const out = process.env.${PROBE_ENV};
  if (out) {
    const text = await response.clone().text();
    const contentType = response.headers.get('Content-Type') ?? undefined;
    let body: unknown = text.slice(0, 20000);
    if (contentType?.includes('json')) {
      try { body = JSON.parse(text); } catch { /* keep text */ }
    }
    const url = new URL(request.url);
    fs.appendFileSync(out, JSON.stringify({ label, method: request.method, path: url.pathname, status: response.status, contentType, body }) + '\\n');
  }
  return response;
}
`;

export function installProbe(dir: string): void {
  const p = path.join(dir, PROBE_FILE);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, PROBE_SOURCE);
}

export function readProbe(file: string): ResponseRecord[] {
  if (!fs.existsSync(file)) return [];
  const byLabel = new Map<string, ResponseRecord>();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as ResponseRecord;
      byLabel.set(r.label, r);
    } catch {
      /* skip torn line */
    }
  }
  return [...byLabel.values()];
}
