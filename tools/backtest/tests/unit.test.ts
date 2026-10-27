import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BudgetExceeded, BudgetTracker, BudgetedClient, EXPECTED_CALLS, HARD_STOP_CALLS } from '../budget.ts';
import { validateFlags } from '../cli.ts';
import { ClaudeCliClient, FakeClient, buildClaudeArgs, childEnv, parseStreamLine, responseFromStream, shouldStop, type StreamState } from '../client.ts';
import { checkContract, checkDelta, compareRecords, parseDeltaSurface, pathMatches, shapeOf, type ResponseRecord } from '../delta.ts';
import { extractIssueSource, extractJson, normalizedTokenLevenshtein, overlapFlags } from '../text.ts';
import { toCreateSpecRequest, validateSpec } from '../spec.ts';
import { wrongIssueVerdict } from '../leakage.ts';
import { parseSpec } from '../spec.ts';

const rec = (label: string, path: string, status: number, body: unknown, method = 'GET'): ResponseRecord => ({ label, method, path, status, body });

describe('delta check (own implementation)', () => {
  const surface = parseDeltaSurface({ version: '1.0', routes: [{ method: 'GET', path: '/roadmap', statuses: [200], allowedBodyDiffs: ['$body'] }] });

  it('allows the declared route to change and freezes everything else', () => {
    const base = [rec('a', '/roadmap', 401, { error: 'x' }), rec('b', '/about', 200, 'about')];
    expect(checkDelta(base, [rec('a', '/roadmap', 200, 'page'), rec('b', '/about', 200, 'about')], surface).ok).toBe(true);
    const bad = checkDelta(base, [rec('a', '/roadmap', 200, 'page'), rec('b', '/about', 404, 'nope')], surface);
    expect(bad.ok).toBe(false);
    expect(bad.violations.map((v) => `${v.label}:${v.kind}`)).toContain('b:status');
  });

  it('rejects an undeclared status on a listed route and a missing response', () => {
    const r = checkDelta([rec('a', '/roadmap', 401, {})], [rec('a', '/roadmap', 500, {})], surface);
    expect(r.violations[0].kind).toBe('status');
    expect(checkDelta([rec('a', '/roadmap', 401, {})], [], surface).violations[0].kind).toBe('missing');
  });

  it('body diffs: allowed globs, new fields only when allowed, ignore list', () => {
    const s = parseDeltaSurface({ version: '1.0', routes: [{ path: '/u/{id}', allowedBodyDiffs: ['data.email'], newFieldsAllowed: false }], ignore: ['at'] });
    const before = [rec('x', '/u/1', 200, { data: { email: 'a', name: 'n' }, at: 1 })];
    expect(checkDelta(before, [rec('x', '/u/1', 200, { data: { email: 'b', name: 'n' }, at: 2 })], s).ok).toBe(true);
    expect(checkDelta(before, [rec('x', '/u/1', 200, { data: { email: 'b', name: 'm' }, at: 2 })], s).violations[0]).toMatchObject({ kind: 'body-changed', detail: 'data.name' });
    expect(checkDelta(before, [rec('x', '/u/1', 200, { data: { email: 'a', name: 'n', extra: 1 }, at: 1 })], s).violations[0].kind).toBe('body-new-field');
  });

  it('parseDeltaSurface accepts a JSON string and rejects other versions', () => {
    expect(parseDeltaSurface(JSON.stringify({ version: '1.0', routes: [] })).routes).toEqual([]);
    expect(() => parseDeltaSurface({ version: '2.0', routes: [] })).toThrow(/invalid/);
    expect(() => parseDeltaSurface('{nope')).toThrow(/JSON/);
  });

  it('path patterns, shapes, agreement and contract conformance', () => {
    expect(pathMatches('/api/specs/{id}', '/api/specs/abc?x=1')).toBe(true);
    expect(pathMatches('/api/specs/{id}', '/api/specs')).toBe(false);
    expect(shapeOf({ b: [1, 2], a: 'x' })).toBe('{a:text,b:[number]}');
    const a = compareRecords([rec('a', '/roadmap', 200, 'x'), rec('b', '/y', 500, 'x')], [rec('a', '/roadmap', 200, 'y'), rec('b', '/y', 200, 'x')], surface);
    expect(a).toMatchObject({ total: 2, exact: 1, differ: ['b'] });
    const c = checkContract([{ method: 'GET', path: '/roadmap', responses: [{ status: 200 }] }], [rec('a', '/roadmap', 401, ''), rec('b', '/other', 500, '')]);
    expect(c.checked).toBe(1);
    expect(c.violations).toHaveLength(1);
  });
});

describe('text helpers', () => {
  it('extractIssueSource drops step metadata, trailers and the solution bullet list', () => {
    const r = extractIssueSource('step: SLO thresholds never NaN | task: m3 | spec: x | confidence: 0.9', 'It read healthy.\n\n- fixed in slo.ts\nCo-Authored-By: X\nClaude-Session: https://x');
    expect(r).toEqual({ subject: 'SLO thresholds never NaN', body: 'It read healthy.' });
  });
  it('overlap flags only identifiers that came from the future change', () => {
    const flags = overlapFlags({ text: 'uses isLocalOnly and fetchHandler', issueText: 'handler issue', diffAdded: 'const isLocalOnly = 1; fetchHandler()', baseTokens: new Set(['fetchHandler']) });
    expect(flags).toEqual(['isLocalOnly']);
  });
  it('token edit distance is normalised', () => {
    expect(normalizedTokenLevenshtein('a b c d', 'a b c d')).toBe(0);
    expect(normalizedTokenLevenshtein('a b c d', 'a x c d')).toBe(0.25);
    expect(normalizedTokenLevenshtein('a', 'b')).toBe(1);
  });
  it('extractJson handles fences and braces inside strings', () => {
    expect(extractJson('hi\n```json\n{"a":"}{","b":[1]}\n```\nbye')).toEqual({ a: '}{', b: [1] });
    expect(() => extractJson('none')).toThrow();
  });
});

describe('budget', () => {
  it('uses the plan numbers by default', () => {
    expect([EXPECTED_CALLS, HARD_STOP_CALLS]).toEqual([565, 850]);
  });
  it('clamps calls to what remains and aborts at the hard stop', async () => {
    const t = new BudgetTracker(5, 5);
    const seen: number[] = [];
    const inner = new FakeClient((req, n) => {
      seen.push(req.maxCalls);
      return { text: 'x', calls: 3, stopReason: n === 1 ? 'done' : 'call-limit' };
    });
    const c = new BudgetedClient(inner, t);
    await c.run({ role: 'candidate', prompt: '', tools: 'agent', maxCalls: 40, timeoutMs: 1 });
    expect(seen[0]).toBe(5);
    expect(t.used).toBe(3);
    await expect(c.run({ role: 'candidate', prompt: '', tools: 'agent', maxCalls: 40, timeoutMs: 1 })).rejects.toBeInstanceOf(BudgetExceeded);
    expect(seen[1]).toBe(2); // clamped to what remained
    expect(t.used).toBe(6);
    await expect(c.run({ role: 'issue', prompt: '', tools: 'none', maxCalls: 1, timeoutMs: 1 })).rejects.toThrow(/hard stop/);
  });
  it('stop rule: two specs in a row failing validators twice', () => {
    const t = new BudgetTracker();
    t.recordSpecOutcome(false);
    t.recordSpecOutcome(true);
    t.recordSpecOutcome(false);
    expect(() => t.recordSpecOutcome(false)).toThrow(/two specs in a row/);
  });
  it('aggregates by role', () => {
    const t = new BudgetTracker();
    t.ledger.push({ role: 'spec', calls: 2, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: 0 }, costUsd: 0.5, durationMs: 1, stopReason: 'done' });
    expect(t.byRole().spec).toEqual({ calls: 2, costUsd: 0.5, inputTokens: 110, outputTokens: 5 });
  });
});

describe('real client plumbing (no process spawned)', () => {
  it('default candidate args: file tools only, no Bash anywhere, restricted, no network or push, medium effort, pinned model', () => {
    const args = buildClaudeArgs({ tools: 'agent' });
    const a = args.join(' ');
    expect(a).toContain('--model claude-sonnet-5-5');
    expect(a).toContain('--effort medium');
    expect(a).toContain('--restricted');
    expect(a).toContain('--permission-mode dontAsk');
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Edit,Write,Glob,Grep');
    const allowed = a.split('--allowedTools')[1].split('--disallowedTools')[0];
    expect(allowed.trim().split(/\s+/)).toEqual(['Read', 'Edit', 'Write', 'Glob', 'Grep']);
    expect(allowed).not.toContain('Bash');
    expect(a).not.toContain('--settings');
    for (const denied of ['WebFetch', 'WebSearch', 'Bash(node:*)', 'Bash(git push:*)', 'Bash(curl:*)']) expect(a).toContain(denied);
  });
  it('--allow-bash args add Bash only with the sandbox settings, and never node, npm, push or network commands', () => {
    const args = buildClaudeArgs({ tools: 'agent' }, { allowBash: true });
    const a = args.join(' ');
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Edit,Write,Glob,Grep,Bash');
    expect(a).toContain('"sandbox":{"enabled":true,"failIfUnavailable":true}');
    const allowed = a.split('--allowedTools')[1].split('--disallowedTools')[0];
    expect(allowed).not.toMatch(/Bash\((node|npm|curl|wget|git push|git remote|sed|cat|mkdir)/);
    // read-only spec generation never gets Bash, even with the flag
    expect(buildClaudeArgs({ tools: 'read' }, { allowBash: true }).join(' ').split('--allowedTools')[1].split('--disallowedTools')[0]).not.toContain('Bash');
  });
  it('--allow-bash refuses to construct without an OS sandbox and logs the sandbox when present', () => {
    expect(() => new ClaudeCliClient({ allowBash: true, which: () => null })).toThrow(/no OS sandbox/);
    const logs: string[] = [];
    const c = new ClaudeCliClient({ allowBash: true, which: () => '/usr/bin/bwrap', log: (s) => logs.push(s) });
    expect(c.sandbox).toMatch(/bubblewrap/);
    expect(logs[0]).toMatch(/active sandbox: bubblewrap/);
    expect(new ClaudeCliClient().sandbox).toBeNull();
  });
  it('text and read modes expose fewer tools', () => {
    const none = buildClaudeArgs({ tools: 'none' });
    expect(none[none.indexOf('--tools') + 1]).toBe('');
    expect(buildClaudeArgs({ tools: 'read' }).join(' ')).toContain('--tools Read,Glob,Grep');
  });
  it('child env is an explicit allow-list: no API key or token variable passes, whatever the host sets', () => {
    const host = { PATH: '/bin', HOME: '/h', LANG: 'C', TERM: 'xterm', CLAUDE_CONFIG_DIR: '/c', CLOUDFLARE_API_TOKEN: 'x', GITHUB_TOKEN: 'y', BEEHIVE_API_TOKEN: 'z', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't', WRANGLER_API_TOKEN: 'w', SSH_AUTH_SOCK: '/s' };
    const env = childEnv(host);
    expect(Object.keys(env).sort()).toEqual(['CI', 'CLAUDE_CONFIG_DIR', 'HOME', 'LANG', 'NO_COLOR', 'PATH', 'TERM']);
    expect(JSON.stringify(env)).not.toMatch(/"(x|y|z|k|t|w)"/);
  });
  it('clamped runs stop at the limit, not one call past it', () => {
    const mk = (): StreamState => ({ assistantIds: new Set<string>(), lastText: '', result: null });
    const st = mk();
    const tool = (id: string) => JSON.stringify({ type: 'assistant', message: { id, content: [{ type: 'tool_use' }] } });
    parseStreamLine(tool('m1'), st);
    expect(shouldStop(st, 2)).toBe(false);
    parseStreamLine(tool('m2'), st);
    expect(shouldStop(st, 2)).toBe(true); // the 3rd call has not been made
    expect(st.assistantIds.size).toBe(2);
    // a final text message at the limit is not cut: its result event still arrives
    const fin = mk();
    parseStreamLine(JSON.stringify({ type: 'assistant', message: { id: 'a', content: [{ type: 'tool_use' }] } }), fin);
    parseStreamLine(JSON.stringify({ type: 'assistant', message: { id: 'b', content: [{ type: 'text', text: 'done' }] } }), fin);
    expect(shouldStop(fin, 2)).toBe(false);
  });
  it('parses a stream: distinct assistant ids are calls, result gives cost and usage', () => {
    const st = { assistantIds: new Set<string>(), lastText: '', result: null as Record<string, any> | null };
    for (const l of [
      JSON.stringify({ type: 'system' }),
      JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'a' }] } }),
      JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use' }] } }),
      JSON.stringify({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'done' }] } }),
      'garbage',
      JSON.stringify({ type: 'result', is_error: false, result: 'done', total_cost_usd: 0.12, num_turns: 3, usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 9 } }),
    ]) parseStreamLine(l, st);
    expect(responseFromStream(st, 10, 'done')).toMatchObject({ text: 'done', calls: 2, costUsd: 0.12, stopReason: 'done', usage: { inputTokens: 5, outputTokens: 7, cacheReadTokens: 9 } });
    expect(responseFromStream({ ...st, result: null }, 1, 'done').stopReason).toBe('error');
  });
});

describe('spec validators', () => {
  const spec = (over: Record<string, unknown> = {}) => ({
    name: 's', contract: JSON.stringify({ endpoints: [{ method: 'GET', path: '/nowhere', isNew: true, responses: [{ status: 200 }] }] }),
    acceptance: [{ name: 'a', file: 'a.test.ts', code: 'x' }],
    declaredDeltaSurface: [{ version: '1.0', routes: [] }], out_of_scope: [], ...over,
  });
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-test-'));
  fs.mkdirSync(path.join(base, 'workers'));
  it('maps to the Spec DO request with string-only delta surface and no acceptance field', () => {
    const req = toCreateSpecRequest(parseSpec(spec()).spec);
    expect(Object.keys(req).sort()).toEqual(['contract', 'declaredDeltaSurface', 'description', 'name']);
    expect(typeof req.declaredDeltaSurface[0]).toBe('string');
  });
  it('rejects vacuous acceptance cases, unloadable files, a bad delta surface and undeclared routes', async () => {
    const pass = async () => ({ outcomes: [{ file: 'a', name: 'n', status: 'passed' as const }], loadErrors: [] });
    expect((await validateSpec(spec(), base, pass)).result.vacuous).toHaveLength(1);
    const failing = async () => ({ outcomes: [{ file: 'a', name: 'n', status: 'failed' as const }], loadErrors: [] });
    expect((await validateSpec(spec(), base, failing)).result.ok).toBe(true);
    const broken = async () => ({ outcomes: [], loadErrors: ['syntax'] });
    expect((await validateSpec(spec(), base, broken)).result.errors.join()).toMatch(/failed to load/);
    expect((await validateSpec(spec({ declaredDeltaSurface: [{ version: '9' }] }), base, failing)).result.errors[0]).toMatch(/delta surface/);
    const ghost = spec({ contract: JSON.stringify({ endpoints: [{ method: 'GET', path: '/ghost', responses: [{ status: 200 }] }] }) });
    expect((await validateSpec(ghost, base, failing)).result.errors.join()).toMatch(/not found at base/);
    expect((await validateSpec(spec({ acceptance: [] }), base, failing)).result.errors.join()).toMatch(/no acceptance/);
  });
  it('leakage test 1: a spec that ignores the issue (same as the true one) fails', () => {
    const a = parseSpec(spec({ name: 'roadmap public', description: 'GET /roadmap answers 200' }));
    const same = parseSpec(spec({ name: 'roadmap public', description: 'GET /roadmap answers 200' }));
    const other = parseSpec(spec({ name: 'slo defaults', description: 'thresholds default', contract: JSON.stringify({ endpoints: [{ method: 'POST', path: '/slo', isNew: true, responses: [{ status: 200 }] }] }) }));
    expect(wrongIssueVerdict(a, same).passed).toBe(false);
    expect(wrongIssueVerdict(a, other).passed).toBe(true);
  });
});

describe('budget persistence and flag gating', () => {
  it('the ledger persists, so a second invocation shares the first one\'s cap', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')), 'runs', 'ledger.json');
    const a = new BudgetTracker(10, 10);
    a.attach(f);
    a.ledger.push({ role: 'issue', calls: 4, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 }, costUsd: 0.1, durationMs: 1, stopReason: 'done' });
    a.recordSpecOutcome(false);
    a.persist();
    const b = new BudgetTracker(10, 10);
    b.attach(f);
    expect(b.used).toBe(4);
    expect(b.remaining).toBe(6);
    expect(() => b.recordSpecOutcome(false)).toThrow(/two specs in a row/); // stop-rule state survives too
  });
  it('the hard stop can never exceed the plan\'s 850', () => {
    expect(new BudgetTracker(565, 5000).hardStop).toBe(850);
    expect(new BudgetTracker(900, 850).expected).toBe(850);
  });
  it('flags: unknown and removed flags are rejected, hard-stop is capped, --allow-bash is known', () => {
    expect(() => validateFlags('pilot', { 'release-pilot': true, 'auto-approve-issues': true })).toThrow(/unknown flag --auto-approve-issues/);
    expect(() => validateFlags('pilot', { 'hard-stop': '900' })).toThrow(/850/);
    expect(() => validateFlags('pilot', { 'hard-stop': '850', 'allow-bash': true, 'release-pilot': true })).not.toThrow();
    expect(() => validateFlags('smoke', { 'release-pilot': true })).not.toThrow();
    expect(() => validateFlags('smoke', { k: '3' })).toThrow(/unknown flag/);
  });
});
