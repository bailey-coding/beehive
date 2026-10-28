// Model-facing stages: issue-text rewrite, spec generation (+validators, one retry), candidate prompt, grading.
// The generator sees the issue text and the base-commit tree only. Never the diff, later commits or held-out tests.
import type { ModelClient, ModelResponse, Role } from './client.ts';
import type { CorpusRow } from './corpus.ts';
import { extractJson } from './text.ts';
import { parseSpec, validateSpec, type ParsedSpec, type SpecValidation, type TestOutcome } from './spec.ts';
import { ACCEPTANCE_DIR } from './spec.ts';
import { LABELS, type CallCost, type Label, type SpecAttempt } from './results.ts';

export const cost = (r: ModelResponse): CallCost => ({ calls: r.calls, usage: r.usage, costUsd: r.costUsd, durationMs: r.durationMs });

export function sumCost(cs: CallCost[]): CallCost {
  const z: CallCost = { calls: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, costUsd: 0, durationMs: 0 };
  for (const c of cs) {
    z.calls += c.calls;
    z.durationMs += c.durationMs;
    z.usage.inputTokens += c.usage.inputTokens;
    z.usage.outputTokens += c.usage.outputTokens;
    z.usage.cacheReadTokens += c.usage.cacheReadTokens;
    z.usage.cacheCreationTokens += c.usage.cacheCreationTokens;
    z.costUsd = z.costUsd === null || c.costUsd === null ? null : z.costUsd + c.costUsd;
  }
  return z;
}

/** What the issue rewriter sees of a cited doc: the curated quote, else the first 80 lines. */
export function docExcerpt(content: string, quote?: string): string {
  return quote ?? content.split('\n').slice(0, 80).join('\n');
}

export function issuePrompt(row: CorpusRow, docs: { path: string; excerpt: string }[]): string {
  return [
    'Rewrite the material below as an issue report for a software project.',
    'State the problem and the observable behaviour wanted. Do not name files, functions, flags, environment variables or the mechanism of a fix.',
    'Describe what a user or caller sees (for example an HTTP status or response) and what they expect instead.',
    'Output only the issue text: a short title line, a blank line, then at most 150 words.',
    '',
    '--- commit subject ---',
    row.issueSource.subject,
    row.issueSource.body ? `--- commit body ---\n${row.issueSource.body}` : '',
    ...docs.map((d) => `--- ${d.path} (problem statement only; ignore any proposed solution) ---\n${d.excerpt}`),
  ].filter(Boolean).join('\n');
}

const SPEC_SHAPE = `{
  "name": string,
  "description": string,
  "contract": string,          // a JSON STRING of {"endpoints":[{"method","path","isNew":bool,"request":{},"responses":[{"status":int,"body":{}}]}],"models":{},"rules":[string]}
  "acceptance": [{"name": string, "file": "<name>.test.ts", "code": string}],
  "declaredDeltaSurface": [ {"version":"1.0","routes":[{"method":"GET|POST|*","path":"/x/{id}","statuses":[int],"allowedBodyDiffs":["a.b","*.c","$body"],"newFieldsAllowed":false}],"ignore":["*.createdAt"]} ],
  "out_of_scope": [string]
}`;

export function specPrompt(issueText: string, retry?: { previous: string; errors: string[] }): string {
  return [
    'You are writing a machine-readable spec for the change described in the issue below. The current repository is your working directory (read-only: Read, Glob, Grep).',
    'Read AGENTS.md first, then only the code needed. Do not guess routes: confirm them in the source.',
    '',
    'Output ONE JSON object in a ```json fence, with exactly this shape:',
    SPEC_SHAPE,
    '',
    'Rules:',
    '- contract: only behaviour stated in or implied by the issue. Mark routes that do not exist yet with isNew:true.',
    `- acceptance: executable vitest cases, each in a file named in "file" (it will be written to ${ACCEPTANCE_DIR}/<file>). Model them on the existing tests under workers/*/tests/ (same mocks and helpers).`,
    `  Import the probe helper as \`import { record } from './probe';\` and call \`await record(label, request, response)\` on every response BEFORE asserting, with a stable unique label.`,
    '  record(label, request, response) takes a Request (or { method: string, path: string }) and a Response (or { status: number, body?: unknown }). Anything else (for example a request body object) is rejected as misuse. Record only real HTTP responses at real routes: never a pseudo-route or an internal/direct call. If the change is not visible over HTTP (a CLI, config, timing, internal logic), do not call record() at all and use "endpoints": [] with an empty delta surface routes list.',
    '  PUBLIC ENTRY POINT ONLY. Every acceptance case must exercise the behaviour where an outside client observes it, and assert only on what that client sees:',
    '    - worker or Durable Object rows: build a `Request` and call the entry point\'s `fetch(request, ...)` (the same way the existing tests under workers/*/tests do), then assert on the response status and body, and on state a client could read through another public route;',
    '    - CLI rows: run the CLI itself as a subprocess with arguments and environment, then assert on its exit code, its output, and the requests a local test server received.',
    '    Never import and call an internal function, class method, schema or helper directly to test the behaviour, not even as an extra case: a correct implementation may place its checks in a different layer (a route handler, a request schema, middleware, the CLI argument parser), so a case that reaches into one layer fails on correct code and is rejected. Calling a public lifecycle method such as `init()` to set a test instance up is fine.',
    '  Assert only what the issue states; every acceptance case must also PASS on a correct implementation of the issue, and this is checked before any candidate runs.',
    '  You have a limited number of tool calls (about 10): read the few files you need (AGENTS.md, one or two existing tests as a model, the code at the entry point), then write the JSON object as your final message.',
    '  Every acceptance case MUST FAIL on the current code (they test the wanted behaviour), and must pass once the issue is fixed. A case that passes today is rejected as vacuous.',
    '- declaredDeltaSurface: the routes whose responses may change because of this issue, with the allowed statuses and body fields. Every route not listed must stay byte-for-byte identical.',
    '- out_of_scope: behaviours that must not change.',
    '',
    '--- issue ---',
    issueText,
    ...(retry ? ['', '--- your previous output was rejected ---', retry.previous.slice(0, 6000), 'Validator errors:', ...retry.errors.map((e) => `- ${e}`), 'Fix these and output the complete corrected JSON object.'] : []),
  ].join('\n');
}

export interface SpecGenResult {
  attempts: SpecAttempt[];
  raw: unknown | null;
  parsed: ParsedSpec | null;
  validation: SpecValidation | null;
  cost: CallCost;
}

/** One generation call plus one retry on validator failure. `runOnBase` is only used when validate is true. */
export async function generateSpec(opts: {
  client: ModelClient;
  row: CorpusRow;
  issueText: string;
  /** Checkout used for validators (has dependencies). */
  baseDir: string;
  /** Checkout the read-only agent runs in; no dependencies, nothing but the single-commit tree. Defaults to baseDir. */
  agentCwd?: string;
  validate: boolean;
  runOnBase: (files: string[]) => Promise<{ outcomes: TestOutcome[]; loadErrors: string[] }>;
  maxCalls?: number;
  timeoutMs?: number;
  role?: Role;
  /** Runs after the base validators pass (for example: every acceptance case must pass on the reference). */
  extraValidate?: (p: ParsedSpec) => Promise<{ errors: string[]; details?: string[] }>;
}): Promise<SpecGenResult> {
  const attempts: SpecAttempt[] = [];
  let raw: unknown | null = null;
  let parsed: ParsedSpec | null = null;
  let validation: SpecValidation | null = null;
  let retry: { previous: string; errors: string[] } | undefined;
  for (let a = 0; a < 2; a++) {
    const res = await opts.client.run({ role: opts.role ?? 'spec', rowId: opts.row.id, prompt: specPrompt(opts.issueText, retry), tools: 'read', cwd: opts.agentCwd ?? opts.baseDir, maxCalls: opts.maxCalls ?? 12, timeoutMs: opts.timeoutMs ?? 15 * 60_000 });
    let errors: string[] = [];
    let details: string[] | undefined;
    try {
      raw = extractJson(res.text);
      if (opts.validate) {
        const v = await validateSpec(raw, opts.baseDir, opts.runOnBase);
        validation = v.result;
        parsed = v.parsed ?? null;
        errors = v.result.errors;
        if (errors.length === 0 && parsed && opts.extraValidate) {
          const x = await opts.extraValidate(parsed);
          errors = x.errors;
          details = x.details;
          validation = { ...v.result, ok: errors.length === 0, errors };
        }
      } else {
        parsed = parseSpec(raw);
        validation = { ok: true, errors: [], vacuous: [] };
      }
    } catch (e) {
      errors = [res.stopReason === 'call-limit' ? 'you used all your tool calls before writing the JSON object: read less (AGENTS.md, one or two existing tests, the entry point) and answer with the JSON object' : e instanceof Error ? e.message : String(e)];
      parsed = null;
      validation = { ok: false, errors, vacuous: [] };
    }
    attempts.push({ ...cost(res), ok: errors.length === 0, errors, ...(details ? { details } : {}) });
    if (errors.length === 0) break;
    retry = { previous: res.text, errors };
  }
  return { attempts, raw, parsed, validation, cost: sumCost(attempts) };
}

export function candidatePrompt(issueText: string, specJson: string, acceptanceFiles: string[], opts: { bash?: boolean } = {}): string {
  return [
    'Implement the change described below in this repository (your working directory). Read AGENTS.md first and follow its conventions.',
    `The spec's acceptance tests are already in the tree (${acceptanceFiles.join(', ')}) and currently fail. Make them pass without editing them or tests/backtest-acceptance/probe.ts.`,
    'Keep every route outside the spec\'s declaredDeltaSurface identical, and keep the existing tests green. Add or adjust unit tests as the repo conventions require.',
    opts.bash
      ? 'You have file tools and a sandboxed Bash tool: run tests with `npx vitest run <files>` and type-check with `npx tsc --noEmit`. The sandbox has no network, no home directory and only this worktree and a private /tmp; node_modules is already installed. Do not leave the working directory. You do not need to commit.'
      : 'You have file tools only (Read, Edit, Write, Glob, Grep): you cannot run tests or commands, so reason carefully about the existing tests and the acceptance tests. The harness runs everything after you stop. Do not leave the working directory. You do not need to commit.',
    'Stop when the change is complete and say briefly what you changed.',
    '',
    '--- issue ---',
    issueText,
    '',
    '--- spec ---',
    specJson,
  ].join('\n');
}

export function gradePrompt(input: { issueText: string; specJson: string; candidateDiff: string; referenceDiff: string; facts: string[] }): string {
  const clip = (s: string) => (s.length > 24000 ? `${s.slice(0, 24000)}\n...[truncated]` : s);
  return [
    'You grade one candidate implementation against the real merged change (the reference). Deterministic oracles already ran; you judge only the residue.',
    `Choose exactly one label: ${LABELS.map((l) => `"${l}"`).join(', ')}.`,
    '- spec violation: the candidate does something the spec/issue forbids or misses something it requires.',
    '- spec-gap: the candidate and reference differ only because the spec left the behaviour open or is missing a clause.',
    '- better-than-reference: the candidate is correct and the reference is weaker on a point the issue cares about.',
    '- regression: the candidate breaks behaviour that must not change.',
    'Reply with one JSON object: {"label": string, "rationale": string (<= 60 words)}.',
    '',
    '--- issue ---', input.issueText,
    '--- spec ---', clip(input.specJson),
    '--- oracle facts ---', ...input.facts.map((f) => `- ${f}`),
    '--- candidate diff ---', clip(input.candidateDiff),
    '--- reference diff ---', clip(input.referenceDiff),
  ].join('\n');
}

export function parseGrade(text: string): { label: Label; rationale: string } {
  const j = extractJson(text) as { label?: string; rationale?: string };
  const label = LABELS.find((l) => l === j.label);
  if (!label) throw new Error(`grader returned unknown label ${JSON.stringify(j.label)}`);
  return { label, rationale: String(j.rationale ?? '') };
}
