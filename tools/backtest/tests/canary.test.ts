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
const bad = new FakeClient(() => ({ text: '', stopReason: 'error', error: 'exit code 1; cli: model not found' }));

const run = (h: (req: ModelRequest, n: number) => FakeReply, files = ['.credentials.json']) =>
  runCanary({ client: new FakeClient(h), badClient: bad, configDir: cfgDir(files) });

describe('canary checks (scripted fake, no model)', () => {
  it('passes when the read is refused, no Bash is listed, no instructions are visible, and the bad model errors visibly', async () => {
    const { checks } = await run((req) => (req.tools === 'agent' ? { text: 'READ=refused', initTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'] } : { text: 'NONE' }));
    expect(checks.map((c) => c.pass)).toEqual([true, true, true, true, true]);
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
    const good = new FakeClient((req) => (req.tools === 'agent' ? { text: 'READ=refused', initTools: ['Read'] } : { text: 'NONE' }));
    await runCanary({ client: good, badClient: bad, configDir: cfgDir(['.credentials.json']) });
    expect(good.requests.length + bad.requests.length).toBeLessThanOrEqual(3 + bad.requests.length - 1);
    expect(good.requests.length).toBe(2);
  });
});
