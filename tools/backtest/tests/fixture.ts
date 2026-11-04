// Shared fixture for the arms tests: a tiny real git repo (base + one fixing commit), the frozen corpus, a spec and candidate sources.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freezeCorpus, type Corpus } from '../corpus.ts';
import { git } from '../git.ts';
import type { OracleConfig } from '../oracles.ts';

export const harnessRoot = path.resolve(__dirname, '..', '..', '..');
export const cfg: OracleConfig = {
  testCommand: ['node', 'node_modules/vitest/vitest.mjs', 'run'],
  tscCommand: null,
  testTimeoutMs: 120_000,
  tscTimeoutMs: 1,
  // fixture has no dependencies of its own: provide the harness's node_modules (stands in for `npm ci`)
  installDeps: async (dir: string) => fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(dir, 'node_modules'), 'dir'),
  baseAttempts: 2,
  evalAttempts: 2,
  sandbox: 'unshare', // agent-written code (acceptance, candidates) runs in the real OS sandbox even in tests
};

export const APP_BASE = `export default {
  async fetch(req: Request): Promise<Response> {
    const p = new URL(req.url).pathname;
    if (p === '/' || p === '/about') return new Response('<html>ok</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  },
};
`;
export const APP_FIXED = APP_BASE.replace("p === '/about')", "p === '/about' || p === '/roadmap')").replace("'<html>ok</html>'", "p === '/roadmap' ? '<html>Roadmap</html>' : '<html>ok</html>'");
export const APP_PARTIAL = APP_BASE.replace("p === '/about')", "p === '/about' || p === '/roadmap')");
const TEST_BASE = `import { expect, it } from 'vitest';
import app from '../workers/api/index';
it('serves / publicly', async () => { expect((await app.fetch(new Request('https://x/'))).status).toBe(200); });
it('401 elsewhere', async () => { expect((await app.fetch(new Request('https://x/private'))).status).toBe(401); });
`;
const TEST_CHANGED = `${TEST_BASE}it('serves the roadmap page', async () => {
  const res = await app.fetch(new Request('https://x/roadmap'));
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('Roadmap');
});
`;

const ACCEPTANCE = `import { expect, it } from 'vitest';
import app from '../../workers/api/index';
import { record } from './probe';
it('roadmap is public', async () => {
  const about = new Request('https://x/about');
  const aboutRes = await app.fetch(about);
  // the plain-object form that real generated specs used: must be accepted, not crash
  await record('about', { method: 'GET', path: '/about' }, { status: aboutRes.status, body: await aboutRes.clone().text() });
  const req = new Request('https://x/roadmap');
  const res = await record('roadmap', req, await app.fetch(req));
  expect(res.status).toBe(200);
});
`;

export const SPEC = {
  name: 'public roadmap',
  description: 'GET /roadmap is a public page',
  contract: JSON.stringify({ endpoints: [{ method: 'GET', path: '/roadmap', isNew: true, responses: [{ status: 200 }] }] }),
  acceptance: [{ name: 'roadmap is public', file: 'roadmap.test.ts', code: ACCEPTANCE }],
  declaredDeltaSurface: [{ version: '1.0', routes: [{ method: 'GET', path: '/roadmap', statuses: [200], allowedBodyDiffs: ['$body'] }] }],
  out_of_scope: ['other routes keep their status'],
};

export interface Fixture {
  source: string;
  corpus: Corpus;
  changeSha: string;
}

export async function makeFixture(): Promise<Fixture> {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-src-'));
  const w = (f: string, c: string) => {
    fs.mkdirSync(path.dirname(path.join(source, f)), { recursive: true });
    fs.writeFileSync(path.join(source, f), c);
  };
  await git(source, ['init', '-q', '-b', 'main']);
  await git(source, ['config', 'user.email', 'f@x.invalid']);
  await git(source, ['config', 'user.name', 'F']);
  w('package.json', '{"type":"module"}\n');
  w('vitest.config.ts', "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['tests/**/*.test.ts'] } });\n");
  w('workers/api/index.ts', APP_BASE);
  w('tests/app.test.ts', TEST_BASE);
  w('docs/README.md', 'Fixture docs.\n');
  await git(source, ['add', '-A']);
  await git(source, ['commit', '-q', '-m', 'base']);
  w('workers/api/index.ts', APP_FIXED);
  w('tests/app.test.ts', TEST_CHANGED);
  await git(source, ['add', '-A']);
  await git(source, ['commit', '-q', '-m', 'fix: roadmap is public\n\nVisitors to the roadmap page got a 401 instead of the page.\n\n- added the path to the public list\nCo-Authored-By: X <x@x.invalid>']);
  const changeSha = (await git(source, ['rev-parse', 'HEAD'])).trim();
  const out = path.join(os.tmpdir(), `fixture-corpus-${Date.now()}.json`);
  const corpus = await freezeCorpus(source, [{ id: 'A1', sha: changeSha, tier: 'A', obs: 'E', component: 'api router', kind: 'body', note: 'body', keyTerms: ['roadmap'] }], out);
  return { source, corpus, changeSha };
}
