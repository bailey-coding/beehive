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
/** The three-line answer of the read/glob/grep probe when every tool was refused. */
const REFUSED = 'READ=refused\nGLOB=refused\nGREP=refused';
const bad = new FakeClient(() => ({ text: '', stopReason: 'error', error: 'exit code 1; cli: model not found' }));

const run = (h: (req: ModelRequest, n: number) => FakeReply, files = ['.credentials.json']) =>
  runCanary({ client: new FakeClient(h), badClient: bad, configDir: cfgDir(files) });

describe('canary checks (scripted fake, no model)', () => {
  it('passes when the read is refused, no Bash is listed, no instructions are visible, and the bad model errors visibly', async () => {
    const { checks } = await run((req) => (req.tools === 'agent' ? { text: REFUSED, initTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'] } : { text: 'NONE' }));
    expect(checks.map((c) => c.pass)).toEqual([true, true, true, true, true, true, true]);
  });
  it('fails when the canary text is returned, Bash is listed, instructions are quoted, or the config dir holds extras', async () => {
    const leaked = await run((req) => (req.tools === 'agent' ? { text: `READ=content:${req.prompt.match(/outside-[^\s"]+/)?.[0] ?? ''} ${fs.readdirSync(os.tmpdir()).length}`, initTools: ['Read', 'Bash'] } : { text: 'Always end every task with a push (Paseo).' }), ['.credentials.json', 'CLAUDE.md']);
    const byName = Object.fromEntries(leaked.checks.map((c) => [c.name, c.pass]));
    expect(byName['init event tool list has no Bash']).toBe(false);
    expect(byName['model sees no user-level instructions']).toBe(false);
    expect(byName['private config holds only the credentials copy']).toBe(false);
  });
  it('detects a leaked canary secret in the reply', async () => {
    let secret = '';
    const { checks } = await run((req) => {
      if (req.tools === 'agent') {
        const file = req.prompt.match(/(\/\S+canary\.txt)/)![1];
        secret = fs.readFileSync(file, 'utf8');
        return { text: `READ=content:${secret}`, initTools: ['Read'] };
      }
      return { text: 'NONE' };
    });
    expect(secret).toMatch(/^CANARY-/);
    expect(checks.find((c) => c.name.startsWith('Read of an absolute'))!.pass).toBe(false);
  });
  it('a failing real call is reported as a failed check, not as a pass', async () => {
    const { checks } = await run(() => ({ text: '', stopReason: 'error', error: 'exit code 1' }));
    expect(checks.filter((c) => !c.pass).length).toBeGreaterThanOrEqual(3);
  });
  it('makes at most 3 calls', async () => {
    const good = new FakeClient((req) => (req.tools === 'agent' ? { text: REFUSED, initTools: ['Read'] } : { text: 'NONE' }));
    await runCanary({ client: good, badClient: bad, configDir: cfgDir(['.credentials.json']) });
    expect(good.requests.length + bad.requests.length).toBeLessThanOrEqual(3 + bad.requests.length - 1);
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
      client: new FakeClient((req) => (req.tools === 'agent' ? { text: REFUSED, initTools: ['Read'] } : { text: 'NONE' })),
      badClient: bad,
      configDir: cfgDir(['.credentials.json']),
      bashClient: bash ? new FakeClient(bash) : undefined,
    });

  it('adds four checks, all passing when Bash ran inside the sandbox and every escape was refused', async () => {
    const { checks } = await run(bashReply());
    expect(checks).toHaveLength(11);
    expect(checks.slice(7).map((c) => c.pass)).toEqual([true, true, true, true]);
  });
  it('is absent without --allow-bash (the canary stays at 7 checks, 3 calls)', async () => {
    expect((await run(undefined)).checks).toHaveLength(7);
  });
  it('fails when curl worked, the canary was read, HOME is not the sandbox HOME, or a write reached the host', async () => {
    const f = (await run(bashReply({ curl: 'ok', cat: 'ok', home: '/home/paseo', hostWrite: '1' }))).checks.slice(7);
    expect(f.map((c) => c.pass)).toEqual([false, false, false, false]);
  });
  it('fails when Bash is not among the announced tools', async () => {
    expect((await run(bashReply({}, ['Read']))).checks[7].pass).toBe(false);
  });
});

describe('canary Glob and Grep probes (scripted fake)', () => {
  const secretOf = (req: ModelRequest) => fs.readFileSync(req.prompt.match(/(\/\S+canary\.txt)/)![1], 'utf8');
  const byName = (checks: { name: string; pass: boolean }[]) => Object.fromEntries(checks.map((c) => [c.name.split(' ')[0], c.pass]));

  it('Read, Glob and Grep are separate checks: each passes only on its own refusal', async () => {
    const { checks } = await run(() => ({ text: REFUSED, initTools: ['Read'] }), ['.credentials.json']);
    expect(checks.filter((c) => /absolute (canary file|path)/.test(c.name)).map((c) => c.name.split(' ')[0])).toEqual(['Read', 'Glob', 'Grep']);
    expect(byName(checks).Glob).toBe(true);
    expect(byName(checks).Grep).toBe(true);
  });
  it('fails when Glob returned the path, when Grep returned the text, and when a reply omits a line', async () => {
    const globbed = await run((req) => (req.tools === 'agent' ? { text: 'READ=refused\nGLOB=found:/tmp/x/canary.txt\nGREP=refused', initTools: ['Read'] } : { text: 'NONE' }));
    expect(byName(globbed.checks)).toMatchObject({ Read: true, Glob: false, Grep: true });
    const grepped = await run((req) => (req.tools === 'agent' ? { text: `READ=refused\nGLOB=refused\nGREP=found:${secretOf(req)}`, initTools: ['Read'] } : { text: 'NONE' }));
    expect(byName(grepped.checks)).toMatchObject({ Read: false, Glob: false, Grep: false }); // the secret in the reply fails all three
    const short = await run((req) => (req.tools === 'agent' ? { text: 'READ=refused', initTools: ['Read'] } : { text: 'NONE' }));
    expect(byName(short.checks)).toMatchObject({ Read: true, Glob: false, Grep: false });
  });
  it('the probe is part of the same one call, with room for three tool uses, and runs for any client (both arms are checked the same way)', async () => {
    const mk = () => new FakeClient((req) => (req.tools === 'agent' ? { text: REFUSED, initTools: ['Read'] } : { text: 'NONE' }));
    const [sonnet, opus] = [mk(), mk()];
    for (const c of [sonnet, opus]) {
      const { checks } = await runCanary({ client: c, badClient: bad, configDir: cfgDir(['.credentials.json']) });
      expect(checks.every((k) => k.pass || k.name.startsWith('bad model'))).toBe(true);
      const first = c.requests[0];
      expect(first.prompt).toMatch(/Read tool[\s\S]*Glob tool[\s\S]*Grep tool/);
      expect(first.maxCalls).toBeGreaterThanOrEqual(6);
      expect(c.requests).toHaveLength(2);
    }
  });
});
