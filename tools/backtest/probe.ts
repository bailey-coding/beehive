// Probe helper written into every checkout. Acceptance tests (and nothing else the agents control) call
// record() so the same requests can be replayed against base, candidate and reference and diffed.
import fs from 'node:fs';
import path from 'node:path';
import type { ResponseRecord } from './delta.ts';
import { ACCEPTANCE_DIR } from './spec.ts';

export const PROBE_FILE = `${ACCEPTANCE_DIR}/probe.ts`;
export const PROBE_ENV = 'BACKTEST_PROBE_OUT';

export const PROBE_SOURCE = `// Written by the backtest harness. record() appends one response record to $${PROBE_ENV} (JSONL). It never throws and
// never changes the response. Misuse (an argument that is not a request/response) is logged to $${PROBE_ENV}.malformed
// so the spec validators can reject the spec before any candidate is run.
import fs from 'node:fs';

export type ProbeRequest = Request | { method: string; path: string };
export type ProbeResponse<T> = T;

export async function record<R extends Response | { status: number; body?: unknown; contentType?: string }>(label: string, request: ProbeRequest, response: R): Promise<R> {
  const out = process.env.${PROBE_ENV};
  if (!out) return response;
  const bad = (reason: string) => fs.appendFileSync(out + '.malformed', JSON.stringify({ label, reason }) + '\\n');
  try {
    const req = request as { method?: unknown; url?: unknown; path?: unknown };
    let method: string | null = typeof req?.method === 'string' ? req.method : null;
    let path: string | null = null;
    if (typeof req?.url === 'string' && typeof (request as Request).headers?.get === 'function') path = new URL(req.url).pathname;
    else if (typeof req?.path === 'string') path = req.path;
    if (!method || !path) return (bad('request must be a Request or { method, path }'), response);
    const res = response as { status?: unknown; clone?: unknown; headers?: { get?: (n: string) => string | null }; body?: unknown; contentType?: unknown };
    if (typeof res?.status !== 'number') return (bad('response must be a Response or { status, body? }'), response);
    let body: unknown;
    let contentType: string | undefined;
    if (typeof res.clone === 'function') {
      const text = await (response as Response).clone().text();
      contentType = res.headers?.get?.('Content-Type') ?? undefined;
      body = text.slice(0, 20000);
      if (contentType?.includes('json')) {
        try { body = JSON.parse(text); } catch { /* keep text */ }
      }
    } else {
      body = res.body;
      contentType = typeof res.contentType === 'string' ? res.contentType : undefined;
    }
    fs.appendFileSync(out, JSON.stringify({ label, method, path, status: res.status, contentType, body }) + '\\n');
  } catch (e) {
    bad('record() failed: ' + String(e));
  }
  return response;
}
`;

export function installProbe(dir: string): void {
  const p = path.join(dir, PROBE_FILE);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, PROBE_SOURCE);
}

const valid = (r: Partial<ResponseRecord>): r is ResponseRecord => typeof r.label === 'string' && typeof r.method === 'string' && typeof r.path === 'string' && typeof r.status === 'number';

export function readProbe(file: string): ResponseRecord[] {
  if (!fs.existsSync(file)) return [];
  const byLabel = new Map<string, ResponseRecord>();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Partial<ResponseRecord>;
      if (valid(r)) byLabel.set(r.label, r);
    } catch {
      /* skip torn line */
    }
  }
  return [...byLabel.values()];
}

/** record() misuse logged by the probe helper: "label: reason" lines. */
export function readMalformed(file: string): string[] {
  const f = `${file}.malformed`;
  if (!fs.existsSync(f)) return [];
  const out = new Set<string>();
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line) as { label?: string; reason?: string };
      out.add(`${j.label}: ${j.reason}`);
    } catch {
      /* skip */
    }
  }
  return [...out];
}
