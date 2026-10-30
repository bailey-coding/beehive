// Backtest spec file: maps to CreateSpecRequestSchema (workers/shared/schemas.ts:134) plus the backtest-only
// `acceptance` and `out_of_scope` fields, which live in the file, never in the Spec DO.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { parseDeltaSurface, type DeltaSurface } from './delta.ts';

export const ACCEPTANCE_DIR = 'tests/backtest-acceptance';

const EndpointSchema = z.object({
  method: z.string().min(1),
  path: z.string().startsWith('/'),
  /** True when the route does not exist at the base commit. */
  isNew: z.boolean().default(false),
  request: z.unknown().optional(),
  responses: z.array(z.object({ status: z.number().int(), body: z.unknown().optional() })).min(1),
});

export const ContractSchema = z.object({
  endpoints: z.array(EndpointSchema).default([]),
  models: z.record(z.string(), z.unknown()).default({}),
  rules: z.array(z.string()).default([]),
});

const AcceptanceSchema = z.object({
  name: z.string().min(1),
  /** File name only; written to tests/backtest-acceptance/<file>. */
  file: z.string().regex(/^[\w.-]+\.test\.ts$/),
  code: z.string().min(1),
});

export const SpecFileSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  /** JSON string, like the Spec DO's `contract`. */
  contract: z.string(),
  acceptance: z.array(AcceptanceSchema).default([]),
  /** One element: the v1.0 object (or its JSON string). */
  declaredDeltaSurface: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).length(1),
  out_of_scope: z.array(z.string()).default([]),
});

export type SpecFile = z.infer<typeof SpecFileSchema>;
export type Contract = z.infer<typeof ContractSchema>;

export interface ParsedSpec {
  spec: SpecFile;
  contract: Contract;
  surface: DeltaSurface;
}

export function parseSpec(raw: unknown): ParsedSpec {
  const spec = SpecFileSchema.parse(raw);
  let contractJson: unknown;
  try {
    contractJson = JSON.parse(spec.contract);
  } catch (e) {
    throw new Error(`contract is not valid JSON: ${e}`);
  }
  const contract = ContractSchema.parse(contractJson);
  const surface = parseDeltaSurface(spec.declaredDeltaSurface[0]);
  return { spec, contract, surface };
}

/** The request the Spec DO would accept (strings only). Not sent anywhere by the harness. */
export function toCreateSpecRequest(spec: SpecFile): { name: string; description?: string; contract: string; declaredDeltaSurface: string[] } {
  return {
    name: spec.name,
    description: spec.description,
    contract: spec.contract,
    declaredDeltaSurface: spec.declaredDeltaSurface.map((d) => (typeof d === 'string' ? d : JSON.stringify(d))),
  };
}

export function writeAcceptance(dir: string, spec: SpecFile): string[] {
  const out: string[] = [];
  const root = path.join(dir, ACCEPTANCE_DIR);
  fs.mkdirSync(root, { recursive: true });
  for (const a of spec.acceptance) {
    const p = path.join(root, a.file);
    fs.writeFileSync(p, a.code);
    out.push(path.posix.join(ACCEPTANCE_DIR, a.file));
  }
  return out;
}

export function removeAcceptance(dir: string): void {
  fs.rmSync(path.join(dir, ACCEPTANCE_DIR), { recursive: true, force: true });
}

/** Static prefix of a route (up to the first parameter). */
export function routePrefix(p: string): string {
  const cut = p.split('/').findIndex((s) => /^\{.+\}$|^:|^\*/.test(s));
  const segs = cut < 0 ? p.split('/') : p.split('/').slice(0, cut);
  return segs.join('/') || '/';
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'tests', '__tests__']);

export function routeExistsInTree(dir: string, route: string): boolean {
  const needle = routePrefix(route);
  const stack = ['workers', 'cli/src', 'ui/src'].map((d) => path.join(dir, d));
  while (stack.length) {
    const d = stack.pop()!;
    if (!fs.existsSync(d)) continue;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(p);
      } else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\./.test(e.name) && fs.readFileSync(p, 'utf8').includes(needle)) return true;
    }
  }
  return false;
}

export interface TestOutcome {
  file: string;
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  /** First failure message (ANSI stripped, trimmed). For humans and artifacts; never fed back to a model. */
  message?: string;
}

export interface SpecValidation {
  ok: boolean;
  errors: string[];
  /** Acceptance cases that already pass on base (vacuous). */
  vacuous: string[];
}

/**
 * Mechanical spec validators, before any candidate: schema + delta parse, every route exists or is declared new,
 * every acceptance case fails on base. `runOnBase` runs the given acceptance files in the base checkout.
 */
export async function validateSpec(
  raw: unknown,
  baseDir: string,
  runOnBase: (files: string[]) => Promise<{ outcomes: TestOutcome[]; loadErrors: string[]; malformed?: string[] }>,
): Promise<{ parsed?: ParsedSpec; result: SpecValidation }> {
  const errors: string[] = [];
  let parsed: ParsedSpec;
  try {
    parsed = parseSpec(raw);
  } catch (e) {
    return { result: { ok: false, errors: [String(e instanceof Error ? e.message : e)], vacuous: [] } };
  }
  for (const ep of parsed.contract.endpoints) {
    if (!ep.isNew && !routeExistsInTree(baseDir, ep.path)) errors.push(`route ${ep.method} ${ep.path} not found at base and not declared isNew`);
  }
  if (parsed.spec.acceptance.length === 0) errors.push('no acceptance cases');
  const vacuous: string[] = [];
  if (parsed.spec.acceptance.length > 0) {
    const files = writeAcceptance(baseDir, parsed.spec);
    try {
      const { outcomes, loadErrors, malformed = [] } = await runOnBase(files);
      for (const m of malformed) errors.push(`probe record() misused (${m}); pass a Request or { method, path } and a Response or { status, body }`);
      for (const e of loadErrors) errors.push(`acceptance file failed to load on base: ${e}`);
      for (const o of outcomes) if (o.status === 'passed') vacuous.push(`${o.file}: ${o.name}`);
      if (outcomes.length === 0 && loadErrors.length === 0) errors.push('acceptance ran no tests');
    } finally {
      removeAcceptance(baseDir);
    }
    if (vacuous.length) errors.push(`${vacuous.length} acceptance case(s) pass on base (vacuous)`);
  }
  return { parsed, result: { ok: errors.length === 0, errors, vacuous } };
}
