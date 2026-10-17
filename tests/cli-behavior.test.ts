/**
 * CLI behavior tests: run the real CLI against a local recording HTTP server
 * and assert the method, path and body each command sends.
 * Only 127.0.0.1 is contacted.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

const ROOT = join(__dirname, '..');
const TSX = join(ROOT, 'cli/node_modules/.bin/tsx');
const ENTRY = join(ROOT, 'cli/src/index.ts');

let server: Server;
let port: number;
let home: string;
let recorded: Recorded[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      recorded.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, data: {} }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  home = mkdtempSync(join(tmpdir(), 'beehive-cli-test-'));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  recorded = [];
});

function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(TSX, [ENTRY, ...args], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        BEEHIVE_API_URL: `http://127.0.0.1:${port}`,
        BEEHIVE_API_TOKEN: 'test',
        ...extraEnv,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function expectRequest(args: string[], method: string, path: string, body?: unknown) {
  const { code, stderr } = await runCli(args);
  expect(stderr, `stderr for: ${args.join(' ')}`).toBe('');
  expect(code).toBe(0);
  expect(recorded).toHaveLength(1);
  const r = recorded[0];
  expect(r.method).toBe(method);
  expect(r.url).toBe(path);
  expect(r.headers.authorization).toBe('Bearer test');
  if (body !== undefined) expect(r.body).toEqual(body);
}

describe('X-Actor-ID attribution', () => {
  const issueArgs = ['issue', 'create', 'T', '--repository', 'r1', '--number', '1'];
  const cfgFile = () => {
    const f = join(home, 'actor-config.json');
    writeFileSync(f, JSON.stringify({ defaultActor: 'from-config' }));
    return ['--config', f];
  };
  const actorHeader = async (args: string[], env: Record<string, string> = {}) => {
    const { code, stderr } = await runCli(args, env);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(recorded).toHaveLength(1);
    return recorded[0].headers['x-actor-id'];
  };

  it('sends no header when nothing is set', async () => {
    expect(await actorHeader(issueArgs)).toBeUndefined();
  });

  it('config defaultActor applies to commands without --actor', async () => {
    expect(await actorHeader([...cfgFile(), ...issueArgs])).toBe('from-config');
  });

  it('BEEHIVE_ACTOR beats config', async () => {
    expect(await actorHeader([...cfgFile(), ...issueArgs], { BEEHIVE_ACTOR: 'from-env' })).toBe('from-env');
  });

  it('--actor beats env and config', async () => {
    expect(
      await actorHeader([...cfgFile(), ...issueArgs, '--actor', 'from-flag'], { BEEHIVE_ACTOR: 'from-env' })
    ).toBe('from-flag');
  });

  it('applies to reads too', async () => {
    expect(await actorHeader(['issue', 'list'], { BEEHIVE_ACTOR: 'from-env' })).toBe('from-env');
  });
});

describe('CLI requests', () => {
  it('trial create', async () => {
    await expectRequest(
      ['trial', 'create', '--candidate-a', 'ca', '--candidate-b', 'cb', '--spec', 's1', '--decided-by', 'a1'],
      'POST',
      '/api/trials',
      { candidateAId: 'ca', candidateBId: 'cb', specId: 's1', decidedBy: 'a1' }
    );
  });

  it('trial decide with --comparison-metrics', async () => {
    await expectRequest(
      ['trial', 'decide', 't1', 'w1', '--comparison-metrics', '{"score":1}'],
      'POST',
      '/api/trials/t1/decide',
      { winnerId: 'w1', comparisonMetrics: { score: 1 } }
    );
  });

  it('trial decide without --comparison-metrics defaults to {}', async () => {
    await expectRequest(['trial', 'decide', 't1', 'w1'], 'POST', '/api/trials/t1/decide', {
      winnerId: 'w1',
      comparisonMetrics: {},
    });
  });

  it('candidate create', async () => {
    await expectRequest(
      ['candidate', 'create', '--spec', 's1', '--repository', 'r1', '--commit', 'abc', '--base-commit', 'def', '--agent', 'ag1'],
      'POST',
      '/api/candidates',
      { specId: 's1', repositoryId: 'r1', commitSha: 'abc', baseCommitSha: 'def', agentId: 'ag1' }
    );
  });

  it('issue create sends an integer number', async () => {
    await expectRequest(
      ['issue', 'create', 'My title', '--repository', 'r1', '--number', '7', '--labels', 'a, b', '--body', 'text'],
      'POST',
      '/api/issues',
      { number: 7, repositoryId: 'r1', title: 'My title', body: 'text', labels: ['a', 'b'] }
    );
  });

  it('promotion create', async () => {
    await expectRequest(
      ['promotion', 'create', 'c1', '--from-rung', 'shadow', '--to-rung', 'train'],
      'POST',
      '/api/promotions',
      { candidateId: 'c1', fromRung: 'shadow', toRung: 'train' }
    );
  });

  it('repo create', async () => {
    await expectRequest(
      ['repo', 'create', 'myrepo', '--organization', 'o1', '--remote-url', 'http://x/y.git', '--namespace', 'ns', '--type', 'baseline'],
      'POST',
      '/api/repositories',
      { name: 'myrepo', organizationId: 'o1', repoType: 'baseline', remoteUrl: 'http://x/y.git', namespace: 'ns' }
    );
  });

  it('spec create', async () => {
    await expectRequest(
      ['spec', 'create', 'myspec', '--organization', 'o1', '--contract', '{"a":1}', '--declared-delta-surface', 'x, y'],
      'POST',
      '/api/specs',
      { name: 'myspec', organizationId: 'o1', contract: '{"a":1}', declaredDeltaSurface: ['x', 'y'] }
    );
  });

  it('spec get', async () => {
    await expectRequest(['spec', 'get', 's1'], 'GET', '/api/specs/s1');
  });

  it('spec claim', async () => {
    const { code, stderr } = await runCli(['spec', 'claim', 's1', '--actor', 'a1']);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].method).toBe('POST');
    expect(recorded[0].url).toBe('/api/specs/s1/claim');
    expect(recorded[0].headers['x-actor-id']).toBe('a1');
  });

  it('gate run', async () => {
    await expectRequest(['gate', 'run', 'c1', '--gate', 'pre-merge'], 'POST', '/api/candidates/c1/gate/pre-merge', {});
  });

  it('gate run defaults to pre-merge', async () => {
    await expectRequest(['gate', 'run', 'c1'], 'POST', '/api/candidates/c1/gate/pre-merge', {});
  });

  it('health extended', async () => {
    await expectRequest(['health', 'extended'], 'GET', '/api/health');
  });

  it('spec create rejects a non-JSON contract without sending a request', async () => {
    const { code, stderr } = await runCli(['spec', 'create', 'n', '--organization', 'o1', '--contract', 'not json', '--declared-delta-surface', 'x']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/valid JSON/);
    expect(recorded).toHaveLength(0);
  });

  it('issue create rejects a non-integer --number', async () => {
    const { code } = await runCli(['issue', 'create', 't', '--repository', 'r1', '--number', 'abc']);
    expect(code).not.toBe(0);
    expect(recorded).toHaveLength(0);
  });
});
