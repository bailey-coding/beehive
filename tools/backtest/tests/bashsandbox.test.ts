// Model-independent tests of the bwrap Bash sandbox: the invocation builder, the probe (real bwrap on this host, plus a
// negative control), the refusal path, and the whole chain with a fake `claude` that behaves like Claude Code's Bash tool.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { INNER_HOME, bwrapArgs, copyDepsInto, nodeRoBinds, prefixScript, proveBashSandbox } from '../bashsandbox.ts';
import { ClaudeCliClient } from '../client.ts';
import { createPrivateConfig } from '../claudeconfig.ts';
import { reachabilityTest } from '../leakage.ts';

const fakeCreds = () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'creds-')), 'cred.json');
  fs.writeFileSync(f, '{}');
  return f;
};

const box = { agentRoot: '/tmp/agent-x', cwd: '/tmp/agent-x/wt', tmpDir: '/tmp/agent-x/tmp' };

describe('bwrap invocation builder', () => {
  const args = bwrapArgs(box, { exists: () => true });
  const joined = args.join(' ');

  it('unshares everything, dies with the parent, clears the env, and binds only the root, a private tmp and system dirs', () => {
    expect(args).toContain('--unshare-all');
    expect(args).toContain('--die-with-parent');
    expect(args).toContain('--new-session');
    expect(args).toContain('--clearenv');
    const binds: string[] = [];
    for (let i = 0; i < args.length; i++) if (args[i] === '--bind' || args[i] === '--ro-bind') binds.push(`${args[i]} ${args[i + 1]}`);
    expect(binds).toContain('--ro-bind /usr');
    expect(binds).toContain('--bind /tmp/agent-x');
    expect(binds).toContain('--bind /tmp/agent-x/tmp');
    // nothing like a home, a config dir, the root fs, or the whole /tmp or /etc
    expect(binds.join('|')).not.toMatch(/--(ro-)?bind \/(home|root|etc|var|tmp|mnt|opt)?(\||$)/);
    expect(joined).not.toMatch(/\.claude|\.ssh|\.env|\/home\//);
    expect(args[args.indexOf('--chdir') + 1]).toBe(box.cwd);
  });

  it('the shell env is an explicit set with a private HOME and no secrets', () => {
    const env: Record<string, string> = {};
    for (let i = 0; i < args.length; i++) if (args[i] === '--setenv') env[args[i + 1]] = args[i + 2];
    expect(Object.keys(env).sort()).toEqual(['CI', 'HOME', 'LANG', 'NO_COLOR', 'PATH', 'TERM', 'TMPDIR']);
    expect(env.HOME).toBe(INNER_HOME);
    expect(env.TMPDIR).toBe('/tmp');
  });

  it('a node install outside /usr is bound read-only by install dir only (never its parent HOME)', () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nodehome-'));
    const bin = path.join(fakeHome, '.nvm', 'versions', 'node', 'v22', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'node'), '');
    expect(nodeRoBinds(path.join(bin, 'node'))).toEqual([path.join(fakeHome, '.nvm', 'versions', 'node', 'v22')]);
    expect(nodeRoBinds('/usr/local/bin/node')).toEqual([]);
  });

  it('the prefix script handles both invocation forms and quotes its arguments', () => {
    const s = prefixScript("/usr/bin/bwrap", { ...box, agentRoot: "/tmp/it's" });
    expect(s).toContain('if [ "$#" -eq 1 ]');
    expect(s).toContain("-- /bin/sh -c \"$1\"");
    expect(s).toContain('-- "$@"');
    expect(s).toContain("'/tmp/it'\\''s'");
  });
});

describe('sandbox probe (real bwrap)', () => {
  it('passes on this host and reports which sandbox is active', async () => {
    const p = await proveBashSandbox();
    expect(p.ok, p.detail).toBe(true);
    expect(p.bwrap).toMatch(/bwrap$/);
    expect(p.detail).toMatch(/bubblewrap .*no network/);
  }, 60_000);

  it('refuses when bwrap is not found', async () => {
    const p = await proveBashSandbox({ which: () => null });
    expect(p).toMatchObject({ ok: false, bwrap: null });
    expect(p.detail).toMatch(/not found/);
  });

  it('negative control: a "bwrap" that does not isolate is detected by the probe', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-bwrap-'));
    const fake = path.join(dir, 'bwrap');
    fs.writeFileSync(fake, '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o755 });
    const p = await proveBashSandbox({ which: () => fake });
    expect(p.ok).toBe(false);
    expect(p.detail).toMatch(/canary file outside the root is readable/);
    expect(p.detail).toMatch(/\.env outside the root is readable/);
    expect(p.detail).toMatch(/HOME canary is readable/);
  }, 60_000);
});

// A stand-in for the claude CLI: it behaves like Claude Code's Bash tool, running each command through
// $CLAUDE_CODE_SHELL_PREFIX (as `prefix bash -c cmd`), and records what it saw to a results file.
function fakeClaude(dir: string, commands: string[], resultsFile: string): string {
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/bin/bash
cat > /dev/null
echo '{"type":"system","subtype":"init","tools":["Read","Edit","Write","Glob","Grep","Bash"]}'
: > "${resultsFile}"
echo "ENV TMPDIR=$TMPDIR PREFIX=$CLAUDE_CODE_SHELL_PREFIX CFG=$CLAUDE_CONFIG_DIR HOME=$HOME" >> "${resultsFile}"
env | grep -c -i -E 'TOKEN|API_KEY|SECRET' >> "${resultsFile}"
i=0
${commands.map((c) => `i=$((i+1)); echo "== CMD $i" >> "${resultsFile}"; $CLAUDE_CODE_SHELL_PREFIX /bin/bash -c ${"'" + c.replace(/'/g, "'\\''") + "'"} >> "${resultsFile}" 2>&1; echo "exit=$?" >> "${resultsFile}"`).join('\n')}
i=$((i+1)); echo "== CMD $i (single string form)" >> "${resultsFile}"; $CLAUDE_CODE_SHELL_PREFIX 'echo single-ok-$HOME' >> "${resultsFile}" 2>&1
echo '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"done"}]}}'
echo '{"type":"result","is_error":false,"result":"done","num_turns":1,"total_cost_usd":0,"usage":{}}'
`, { mode: 0o755 });
  return bin;
}

describe('whole chain: client + prefix script + bwrap, driven by a fake claude (no model)', () => {
  it('Bash commands cannot read the canary, HOME, the config dir, write outside, or reach the network; the worktree and /tmp work', async () => {
    const proof = await proveBashSandbox();
    expect(proof.ok, proof.detail).toBe(true);
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-chain-'));
    const outside = path.join(base, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'canary.txt'), 'TOP-SECRET');
    const agentRoot = path.join(base, 'agent');
    const wt = path.join(agentRoot, 'wt');
    const tmpDir = path.join(agentRoot, 'tmp');
    fs.mkdirSync(wt, { recursive: true });
    const server = net.createServer((s) => s.destroy());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    const config = createPrivateConfig(fakeCreds());
    let client: ClaudeCliClient | undefined;
    try {
      const results = path.join(base, 'results.txt'); // outside the sandbox: written by the fake claude itself
      const commands = [
        'echo HOME=$HOME',
        `cat ${path.join(outside, 'canary.txt')}`,
        `touch ${outside}/written.txt`,
        `ls ${config.dir}`,
        `ls ${os.homedir()}`,
        `node -e "fetch('http://127.0.0.1:${port}',{signal:AbortSignal.timeout(2000)}).then(()=>console.log('NET-LEAK')).catch(()=>console.log('net-blocked'))"`,
        `node -e "require('net').connect({host:'1.1.1.1',port:443,timeout:2000}).on('connect',()=>{console.log('INTERNET-LEAK');process.exit()}).on('error',()=>{console.log('internet-blocked');process.exit()}).on('timeout',()=>{console.log('internet-blocked');process.exit()})"`,
        'echo ok > file.txt && echo wrote-worktree',
        'echo ok > /tmp/t.txt && echo wrote-tmp',
        'pwd',
      ];
      const bin = fakeClaude(base, commands, results);
      client = new ClaudeCliClient({ bin, config, allowBash: true, bash: proof });
      const res = await client.run({ role: 'candidate', prompt: 'x', tools: 'agent', cwd: wt, bashBox: { agentRoot, cwd: wt, tmpDir }, maxCalls: 5, timeoutMs: 120_000 });
      expect(res.stopReason).toBe('done');
      const out = fs.readFileSync(results, 'utf8');
      expect(out).toContain(`TMPDIR=${tmpDir}`);
      expect(out).toMatch(/PREFIX=\/.*bash-prefix-agent\.sh/);
      expect(out).toContain(`CFG=${config.dir}`);
      expect(out.split('\n')[1]).toBe('0'); // no secret-looking variable reached the CLI process
      expect(out).toContain(`HOME=${INNER_HOME}`);
      expect(out).not.toContain('TOP-SECRET');
      expect(out).toMatch(/cat: .*canary\.txt: No such file or directory/);
      expect(fs.existsSync(path.join(outside, 'written.txt'))).toBe(false);
      // only the read-only shell-snapshots dir is visible under the config path; the credentials copy next to it is not
      expect(out).toMatch(/== CMD 4\nshell-snapshots\nexit=0/);
      expect(out).toContain('net-blocked');
      expect(out).toContain('internet-blocked');
      expect(out).not.toMatch(/NET-LEAK|INTERNET-LEAK/);
      expect(out).toContain('wrote-worktree');
      expect(out).toContain('wrote-tmp');
      expect(fs.readFileSync(path.join(wt, 'file.txt'), 'utf8').trim()).toBe('ok');
      expect(fs.existsSync(path.join(tmpDir, 't.txt'))).toBe(true); // /tmp inside is the private tmp outside
      expect(out).toContain(wt); // pwd
      expect(out).toContain(`single-ok-${INNER_HOME}`);
      // a repeated config listing must not show credentials: the config dir is never mounted
      expect(out).not.toMatch(/\.credentials\.json/);
    } finally {
      server.close();
      client?.dispose();
      config.dispose();
    }
  }, 180_000);

  it('a Bash-enabled agent run without a bashBox is refused, and Bash-off runs never get a prefix script', async () => {
    const config = createPrivateConfig(fakeCreds());
    try {
      const proof = await proveBashSandbox();
      const withBash = new ClaudeCliClient({ bin: '/bin/true', config, allowBash: true, bash: proof });
      await expect(withBash.run({ role: 'candidate', prompt: '', tools: 'agent', cwd: os.tmpdir(), maxCalls: 1, timeoutMs: 1000 })).rejects.toThrow(/bashBox/);
      const noBash = new ClaudeCliClient({ bin: '/bin/true', config });
      const r = await noBash.run({ role: 'candidate', prompt: '', tools: 'agent', cwd: os.tmpdir(), maxCalls: 1, timeoutMs: 1000 });
      expect(r.stopReason).toBe('error'); // /bin/true prints no result event: surfaced, not silent
    } finally {
      config.dispose();
    }
  }, 60_000);
});

describe('dependency copy for Bash mode', () => {
  it('copies as plain files, keeps relative symlinks relative, and the reachability test passes; an absolute escaping link is flagged', () => {
    const deps = fs.mkdtempSync(path.join(os.tmpdir(), 'deps-'));
    fs.mkdirSync(path.join(deps, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(deps, 'node_modules', '.bin'));
    fs.writeFileSync(path.join(deps, 'node_modules', 'pkg', 'cli.js'), 'x');
    fs.symlinkSync('../pkg/cli.js', path.join(deps, 'node_modules', '.bin', 'pkg'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-agent-deps-'));
    const wt = path.join(root, 'wt');
    fs.mkdirSync(wt);
    copyDepsInto(deps, wt);
    const link = path.join(wt, 'node_modules', '.bin', 'pkg');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe('../pkg/cli.js');
    expect(fs.lstatSync(path.join(wt, 'node_modules')).isSymbolicLink()).toBe(false);
    expect(fs.statSync(path.join(wt, 'node_modules', 'pkg', 'cli.js')).ino).not.toBe(fs.statSync(path.join(deps, 'node_modules', 'pkg', 'cli.js')).ino);
    expect(reachabilityTest({ agentRoot: root, cwd: wt, forbiddenRoots: [deps], markers: [] }).passed).toBe(true);
    fs.symlinkSync(path.join(deps, 'node_modules', 'pkg', 'cli.js'), path.join(wt, 'node_modules', '.bin', 'escape'));
    expect(reachabilityTest({ agentRoot: root, cwd: wt, forbiddenRoots: [], markers: [] }).detail.join()).toMatch(/node_modules\/\.bin\/escape escapes the agent root/);
  });

  it('a top-level node_modules symlink in the provider still yields a plain copy', () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'realnm-'));
    fs.writeFileSync(path.join(real, 'a.js'), 'x');
    const deps = fs.mkdtempSync(path.join(os.tmpdir(), 'deps2-'));
    fs.symlinkSync(real, path.join(deps, 'node_modules'), 'dir');
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'wt2-'));
    copyDepsInto(deps, wt);
    expect(fs.lstatSync(path.join(wt, 'node_modules')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(wt, 'node_modules', 'a.js'), 'utf8')).toBe('x');
  });
});
