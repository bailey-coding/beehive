import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { authGate } from '../../workers/shared/auth';

const env = { API_AUTH_TOKEN: 'master-token' };
const req = (h: Record<string, string>) => new Request('https://x/', { headers: h });

describe('authGate', () => {
  it('fails closed with 503 when API_AUTH_TOKEN is unset', async () => {
    expect((await authGate(req({}), {}))!.status).toBe(503);
  });
  it('accepts the master token via Authorization or X-API-Token', async () => {
    expect(await authGate(req({ Authorization: 'Bearer master-token' }), env)).toBeNull();
    expect(await authGate(req({ 'X-API-Token': 'master-token' }), env)).toBeNull();
  });
  it.each([
    ['no credentials', {}],
    ['wrong bearer', { Authorization: 'Bearer nope' }],
    ['bearer prefix only', { Authorization: 'Bearer ' }],
    ['raw token without Bearer', { Authorization: 'master-token' }],
    ['wrong X-API-Token', { 'X-API-Token': 'nope' }],
    ['token with a suffix', { 'X-API-Token': 'master-token-x' }],
  ])('%s -> 401', async (_n, h) => {
    expect((await authGate(req(h), env))!.status).toBe(401);
  });
});

// authGate is async: a call without `await` yields a Promise that is always truthy, so the gate
// would silently deny (or, in `return denied`, resolve to null) instead of failing loudly.
describe('every authGate call is awaited', () => {
  const roots = ['workers', 'tests/e2e'];
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      if (n === 'node_modules') continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) files.push(p);
    }
  };
  roots.forEach(walk);
  it('finds the call sites and none is un-awaited', () => {
    const calls = files.flatMap((f) =>
      readFileSync(f, 'utf8').split('\n').map((l, i) => ({ f, i: i + 1, l })).filter(({ l }) => /\bauthGate\(/.test(l) && !/export (async )?function authGate/.test(l))
    );
    expect(calls.length).toBeGreaterThanOrEqual(9);
    expect(calls.filter(({ l }) => !/await authGate\(/.test(l))).toEqual([]);
  });
});
