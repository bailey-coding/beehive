// The harness's own delta check (docs/SPEC-BACKTEST-PLAN.md section 0). Deliberately NOT the scientist-comparator
// parseDeltaSurface path, which cannot work for any stored spec (docs/OPEN-QUESTIONS.md, 2026-10-26).
// Surface format v1.0 (backtest-owned): routes allowed to change; everything unlisted is frozen.
import { z } from 'zod';

const RouteSchema = z.object({
  method: z.string().default('*'),
  path: z.string().min(1),
  /** Statuses a candidate may answer instead of the base status. Omitted: status frozen. */
  statuses: z.array(z.number().int()).optional(),
  /** Body field paths (dot form, `*` = one segment) allowed to differ; `$body` = the whole body may differ. */
  allowedBodyDiffs: z.array(z.string()).default([]),
  newFieldsAllowed: z.boolean().default(false),
});

export const DeltaSurfaceSchema = z.object({
  version: z.literal('1.0'),
  routes: z.array(RouteSchema),
  /** Volatile field patterns (timestamps, generated ids) ignored everywhere. */
  ignore: z.array(z.string()).default([]),
});

export type DeltaSurface = z.infer<typeof DeltaSurfaceSchema>;
export type DeltaRoute = z.infer<typeof RouteSchema>;

/** Accepts the object, or a JSON string of it (the Spec DO stores array elements as strings). */
export function parseDeltaSurface(input: unknown): DeltaSurface {
  let v = input;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch (e) {
      throw new Error(`delta surface is not valid JSON: ${e}`);
    }
  }
  const r = DeltaSurfaceSchema.safeParse(v);
  if (!r.success) throw new Error(`delta surface invalid: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return r.data;
}

export interface ResponseRecord {
  label: string;
  method: string;
  path: string;
  status: number;
  contentType?: string;
  /** Parsed JSON when the response was JSON, else the text. */
  body: unknown;
}

export function pathMatches(pattern: string, actual: string): boolean {
  const p = pattern.split('/').filter(Boolean);
  const a = actual.split('?')[0].split('/').filter(Boolean);
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '**') return true;
    if (i >= a.length) return false;
    if (p[i] === '*' || /^\{.+\}$/.test(p[i]) || p[i].startsWith(':')) continue;
    if (p[i] !== a[i]) return false;
  }
  return p.length === a.length;
}

export function fieldMatches(pattern: string, field: string): boolean {
  if (pattern === '**') return true;
  const p = pattern.split('.');
  const f = field.split('.');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '**') return true;
    if (i >= f.length) return false;
    if (p[i] !== '*' && p[i] !== f[i]) return false;
  }
  return p.length === f.length;
}

function leaves(v: unknown, prefix = '', out: Map<string, unknown> = new Map()): Map<string, unknown> {
  if (v !== null && typeof v === 'object') {
    const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) out.set(prefix || '$body', Array.isArray(v) ? '[]' : '{}');
    for (const [k, x] of entries) leaves(x, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out.set(prefix || '$body', v);
  }
  return out;
}

export interface BodyDiff {
  changed: string[];
  added: string[];
  removed: string[];
}

export function diffBodies(a: unknown, b: unknown, ignore: string[] = []): BodyDiff {
  const la = leaves(a);
  const lb = leaves(b);
  const keep = (k: string) => !ignore.some((p) => fieldMatches(p, k));
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const [k, v] of la) {
    if (!keep(k)) continue;
    if (!lb.has(k)) removed.push(k);
    else if (JSON.stringify(lb.get(k)) !== JSON.stringify(v)) changed.push(k);
  }
  for (const k of lb.keys()) if (keep(k) && !la.has(k)) added.push(k);
  return { changed, added, removed };
}

/** Type-structure signature: the "body shape" used for behavioural agreement. Text bodies reduce to 'text'. */
export function shapeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `[${[...new Set(v.map(shapeOf))].sort().join('|')}]`;
  if (typeof v === 'object') {
    return `{${Object.keys(v as object).sort().map((k) => `${k}:${shapeOf((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return typeof v === 'string' ? 'text' : typeof v;
}

export interface DeltaViolation {
  label: string;
  kind: 'missing' | 'status' | 'body-changed' | 'body-removed' | 'body-new-field';
  detail: string;
}

export interface DeltaResult {
  ok: boolean;
  checked: number;
  violations: DeltaViolation[];
}

function routeFor(surface: DeltaSurface, r: ResponseRecord): DeltaRoute | undefined {
  return surface.routes.find((x) => (x.method === '*' || x.method.toUpperCase() === r.method.toUpperCase()) && pathMatches(x.path, r.path));
}

/** Compare `after` (candidate or reference) with `before` (base) under the declared surface. */
export function checkDelta(before: ResponseRecord[], after: ResponseRecord[], surface: DeltaSurface): DeltaResult {
  const violations: DeltaViolation[] = [];
  const idx = new Map(after.map((r) => [r.label, r]));
  for (const b of before) {
    const a = idx.get(b.label);
    if (!a) {
      violations.push({ label: b.label, kind: 'missing', detail: 'no response recorded after the change' });
      continue;
    }
    const route = routeFor(surface, b);
    const statusOk = a.status === b.status || (route?.statuses?.includes(a.status) ?? false);
    if (!statusOk) violations.push({ label: b.label, kind: 'status', detail: `${b.status} -> ${a.status}` });
    const d = diffBodies(b.body, a.body, surface.ignore);
    const allowed = (f: string) => route?.allowedBodyDiffs.some((p) => p === '$body' || fieldMatches(p, f)) ?? false;
    for (const f of d.changed) if (!allowed(f)) violations.push({ label: b.label, kind: 'body-changed', detail: f });
    for (const f of d.removed) if (!allowed(f)) violations.push({ label: b.label, kind: 'body-removed', detail: f });
    for (const f of d.added) if (!(route?.newFieldsAllowed || allowed(f))) violations.push({ label: b.label, kind: 'body-new-field', detail: f });
  }
  return { ok: violations.length === 0, checked: before.length, violations };
}

export interface Agreement {
  total: number;
  exact: number;
  permitted: number;
  differ: string[];
}

/** Candidate vs reference by (route, status, body shape); a difference the surface allows counts as permitted. */
export function compareRecords(cand: ResponseRecord[], ref: ResponseRecord[], surface: DeltaSurface): Agreement {
  const idx = new Map(cand.map((r) => [r.label, r]));
  const out: Agreement = { total: ref.length, exact: 0, permitted: 0, differ: [] };
  for (const r of ref) {
    const c = idx.get(r.label);
    if (!c) {
      out.differ.push(r.label);
      continue;
    }
    if (c.status === r.status && shapeOf(c.body) === shapeOf(r.body)) {
      out.exact++;
      continue;
    }
    const route = routeFor(surface, r);
    const statusOk = c.status === r.status || (!!route?.statuses && route.statuses.includes(c.status) && route.statuses.includes(r.status));
    const d = diffBodies(r.body, c.body, surface.ignore);
    const allowed = (f: string) => route?.allowedBodyDiffs.some((p) => p === '$body' || fieldMatches(p, f)) ?? false;
    const bodyOk = [...d.changed, ...d.removed].every(allowed) && d.added.every((f) => route?.newFieldsAllowed || allowed(f));
    if (statusOk && bodyOk) out.permitted++;
    else out.differ.push(r.label);
  }
  return out;
}

/** Conformance rung: every recorded response on a contract endpoint answers one of its declared statuses. */
export function checkContract(
  endpoints: { method: string; path: string; responses: { status: number }[] }[],
  records: ResponseRecord[],
): { checked: number; violations: string[] } {
  let checked = 0;
  const violations: string[] = [];
  for (const r of records) {
    const ep = endpoints.find((e) => e.method.toUpperCase() === r.method.toUpperCase() && pathMatches(e.path, r.path));
    if (!ep) continue;
    checked++;
    if (!ep.responses.some((x) => x.status === r.status)) violations.push(`${r.label}: ${r.method} ${r.path} answered ${r.status}, contract allows ${ep.responses.map((x) => x.status).join('/')}`);
  }
  return { checked, violations };
}
