import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCanary } from '../canary.ts';
import { FakeClient, type FakeReply, type ModelRequest } from '../client.ts';

const cfgDir = (files: string[]) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-cfg-'));
  for (const f of files) fs.writeFileSync(path.join(d, f), 'x');
  return d;
};
/** What an honest model answers to the file-tool probe: outside refused, the controls inside cwd answered from the planted file. */
const answer = (req: ModelRequest, over: Partial<Record<'READ' | 'GLOB' | 'GREP' | 'READ_IN' | 'GLOB_IN' | 'GREP_IN', string>> = {}): string => {
  const name = req.prompt.match(/ok-[0-9a-f]+\.txt/)![0];
  const text = `INSIDE-${name.slice(3, -4)}`;
  // the control Glob lists the real cwd, which holds a second file the prompt never names
  const listed = fs.readdirSync(req.cwd!).filter((f) => f.endsWith('.txt')).join(' ');
  const l = { READ: 'refused', GLOB: 'refused', GREP: 'refused', READ_IN: text, GLOB_IN: listed, GREP_IN: text, ...over };
  return Object.entries(l).map(([k, v]) => `${k}=${v}`).join('\n');
};
/** A complete healthy reply of the real CLI: the model named in the init event and per-message usage parsed. */
const healthy = (req: ModelRequest, over: Partial<Record<'READ' | 'GLOB' | 'GREP' | 'READ_IN' | 'GLOB_IN' | 'GREP_IN', string>> = {}, tools = ['Read', 'Edit', 'Write', 'Glob', 'Grep']): FakeReply => ({ text: answer(req, over), initTools: tools, model: 'claude-x', usageMessages: 3 });
const bad = new FakeClient(() => ({ text: '', stopReason: 'error', error: 'exit code 1; cli: model not found' }));
const nonAgent = { text: 'NONE' };

const run = (h: (req: ModelRequest, n: number) => FakeReply, files = ['.credentials.json']) =>
  runCanary({ client: new FakeClient(h), badClient: bad, configDir: cfgDir(files) });
const byNameOf = (checks: { name: string; pass: boolean }[]) => Object.fromEntries(checks.map((c) => [c.name, c.pass]));
const first = (checks: { name: string; pass: boolean; detail: string }[], prefix: string) => checks.find((c) => c.name.startsWith(prefix))!;

describe('canary checks (scripted fake, no model)', () => {
  it('passes when every file tool is refused outside cwd and works inside, no Bash is listed, the model is named, usage is parsed, no instructions are visible, and the bad model errors visibly', async () => {
    const { checks } = await run((req) => (req.tools === 'agent' ? healthy(req) : nonAgent));
    expect(checks).toHaveLength(9);
    expect(checks.map((c) => c.pass)).toEqual(Array(9).fill(true));
  });
  it('fails when the canary text is returned, Bash is listed, instructions are quoted, or the config dir holds extras', async () => {
    const leaked = await run((req) => (req.tools === 'agent' ? { ...healthy(req, { READ: `content:${fs.readFileSync(req.prompt.match(/(\/\S+read-[0-9a-f]+\.txt)/)![1], 'utf8')}` }, ['Read', 'Bash']) } : { text: 'Always end every task with a push (Paseo).' }), ['.credentials.json', 'CLAUDE.md']);
    const byName = byNameOf(leaked.checks);
    expect(byName['Read of an absolute canary file outside cwd is refused']).toBe(false);
    expect(byName['init event tool list has no Bash']).toBe(false);
    expect(byName['model sees no user-level instructions']).toBe(false);
    expect(byName['private config holds only the credentials copy']).toBe(false);
  });
  it('detects a leaked canary secret in the reply', async () => {
    let secret = '';
    const { checks } = await run((req) => {
      if (req.tools === 'agent') {
        secret = fs.readFileSync(req.prompt.match(/(\/\S+read-[0-9a-f]+\.txt)/)![1], 'utf8');
        return healthy(req, { READ: `content:${secret}` });
      }
      return nonAgent;
    });
    expect(secret).toMatch(/^CANARY-/);
    expect(first(checks, 'Read of an absolute').pass).toBe(false);
  });
  it('a failing real call is reported as a failed check, not as a pass', async () => {
    const { checks } = await run(() => ({ text: '', stopReason: 'error', error: 'exit code 1' }));
    expect(checks.filter((c) => !c.pass).length).toBeGreaterThanOrEqual(3);
  });
  it('makes at most 3 calls', async () => {
    const good = new FakeClient((req) => (req.tools === 'agent' ? healthy(req) : nonAgent));
    await runCanary({ client: good, badClient: bad, configDir: cfgDir(['.credentials.json']) });
    expect(good.requests.length).toBe(2);
  });
});

describe('canary Bash probe (4th call, scripted fake)', () => {
  const bashReply = (over: Record<string, string> = {}, tools = ['Read', 'Bash']) => (req: ModelRequest): FakeReply => {
    const m = req.prompt.match(/touch (\S+)\/written\.txt/);
    if (over.hostWrite && m) fs.writeFileSync(path.join(m[1], 'written.txt'), 'x');
    return { text: JSON.stringify({ home: over.home ?? '/tmp/home', curl: over.curl ?? 'failed', cat: over.cat ?? 'failed', write: over.write ?? 'failed' }), initTools: tools };
  };
  const run = (bash: ((req: ModelRequest) => FakeReply) | undefined) =>
    runCanary({
      client: new FakeClient((req) => (req.tools === 'agent' ? healthy(req) : nonAgent)),
      badClient: bad,
      configDir: cfgDir(['.credentials.json']),
      bashClient: bash ? new FakeClient(bash) : undefined,
    });

  it('adds four checks, all passing when Bash ran inside the sandbox and every escape was refused', async () => {
    const { checks } = await run(bashReply());
    expect(checks).toHaveLength(13);
    expect(checks.slice(9).map((c) => c.pass)).toEqual([true, true, true, true]);
  });
  it('is absent without --allow-bash (the canary stays at 9 checks, 3 calls)', async () => {
    expect((await run(undefined)).checks).toHaveLength(9);
  });
  it('fails when curl worked, the canary was read, HOME is not the sandbox HOME, or a write reached the host', async () => {
    const f = (await run(bashReply({ curl: 'ok', cat: 'ok', home: '/home/paseo', hostWrite: '1' }))).checks.slice(9);
    expect(f.map((c) => c.pass)).toEqual([false, false, false, false]);
  });
  it('fails when Bash is not among the announced tools', async () => {
    expect((await run(bashReply({}, ['Read']))).checks[9].pass).toBe(false);
  });
});


describe('canary Glob, Grep, model and usage probes (scripted fake)', () => {
  const secretOf = (req: ModelRequest) => fs.readFileSync(req.prompt.match(/(\/\S+read-[0-9a-f]+\.txt)/)![1], 'utf8');
  const agent = (h: (req: ModelRequest) => FakeReply) => run((req) => (req.tools === 'agent' ? h(req) : nonAgent));

  it('Read, Glob and Grep are separate checks: each passes only on its own refusal', async () => {
    const { checks } = await agent((req) => healthy(req));
    expect(checks.filter((c) => /absolute (canary file|path)/.test(c.name)).map((c) => c.name.split(' ')[0])).toEqual(['Read', 'Glob', 'Grep']);
    expect(first(checks, 'Glob').pass && first(checks, 'Grep').pass).toBe(true);
  });
  it('fails when Glob returned the path, when Grep returned the text, and when a reply omits a line', async () => {
    const globbed = await agent((req) => healthy(req, { GLOB: 'found:/tmp/x/canary.txt' }));
    expect([first(globbed.checks, 'Read').pass, first(globbed.checks, 'Glob').pass, first(globbed.checks, 'Grep').pass]).toEqual([true, false, true]);
    const grepped = await agent((req) => healthy(req, { GREP: `found:${secretOf(req)}` }));
    expect([first(grepped.checks, 'Read').pass, first(grepped.checks, 'Glob').pass, first(grepped.checks, 'Grep').pass]).toEqual([false, false, false]); // the secret in the reply fails all three
    const short = await agent((req) => ({ ...healthy(req), text: 'READ=refused' }));
    expect(first(short.checks, 'Glob').pass).toBe(false);
  });
  it('a refusal claimed without the positive control inside cwd fails: the tool may never have run', async () => {
    const r = await agent((req) => healthy(req, { GLOB_IN: '(nothing)' }));
    expect(first(r.checks, 'Glob').pass).toBe(false);
    expect(first(r.checks, 'Glob').detail).toMatch(/claimed a refusal, but its control inside cwd did not return glob-[0-9a-f]+\.txt/);
    expect(first(r.checks, 'Read').pass && first(r.checks, 'Grep').pass).toBe(true);
    const grep = await agent((req) => healthy(req, { GREP_IN: '' }));
    expect(first(grep.checks, 'Grep').pass).toBe(false);
  });
  it('the control Glob must return the second host file the prompt never names, not just the one it mentions', async () => {
    const r = await agent((req) => healthy(req, { GLOB_IN: req.prompt.match(/ok-[0-9a-f]+\.txt/)![0] }));
    expect(first(r.checks, 'Glob').pass).toBe(false);
    expect(first(r.checks, 'Glob').detail).toMatch(/did not return glob-[0-9a-f]+\.txt/);
  });
  it('canary.txt, never named in the prompt, appearing anywhere in the reply fails the outside Glob', async () => {
    const prompts: string[] = [];
    const r = await agent((req) => {
      prompts.push(req.prompt);
      return { ...healthy(req), text: `${answer(req)}\nnote: the outside folder only had canary.txt` };
    });
    expect(prompts[0]).not.toContain('canary.txt');
    expect(first(r.checks, 'Glob').pass).toBe(false);
    expect(first(r.checks, 'Glob').detail).toMatch(/canary\.txt, a file the prompt never names/);
    expect(first(r.checks, 'Read').pass).toBe(true); // the Read refusal itself was honest
  });
  it('the init event must name a model, and per-message usage must have been parsed (no extra call)', async () => {
    const noModel = await agent((req) => ({ ...healthy(req), model: undefined }));
    expect(first(noModel.checks, 'init event named the model').pass).toBe(false);
    expect(first(noModel.checks, 'init event named the model').detail).toMatch(/named no model/);
    const noUsage = await agent((req) => ({ ...healthy(req), usageMessages: 0 }));
    expect(first(noUsage.checks, 'per-message usage').pass).toBe(false);
    expect(first(noUsage.checks, 'per-message usage').detail).toMatch(/charged maxCalls x the per-call estimate/);
    const missing = await agent((req) => {
      const { usageMessages: _u, ...rest } = healthy(req);
      return rest;
    });
    expect(first(missing.checks, 'per-message usage').pass).toBe(false);
    const ok = await agent((req) => healthy(req));
    expect(first(ok.checks, 'init event named the model').pass && first(ok.checks, 'per-message usage').pass).toBe(true);
  });
  it('the probe is one call with room for the six tool uses, and runs for any client (both arms are checked the same way)', async () => {
    const mk = () => new FakeClient((req) => (req.tools === 'agent' ? healthy(req) : nonAgent));
    for (const c of [mk(), mk()]) {
      const { checks } = await runCanary({ client: c, badClient: bad, configDir: cfgDir(['.credentials.json']) });
      expect(checks.every((k) => k.pass || k.name.startsWith('bad model'))).toBe(true);
      const req = c.requests[0];
      expect(req.prompt).toMatch(/Read tool[\s\S]*Glob tool[\s\S]*Grep tool/);
      expect(req.maxCalls).toBe(10);
      expect(c.requests).toHaveLength(2);
    }
  });
});
