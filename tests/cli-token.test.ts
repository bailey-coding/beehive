/**
 * CLI user-token support (M12 PR-C, docs/M12-PRC-PLAN.md): login verifies before saving,
 * config file permissions, actor handling under a user token, whoami, hints, secret hygiene.
 * Runs the real CLI against the recording harness; only 127.0.0.1 is contacted.
 * Tokens here are synthetic fixtures.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, chmodSync, symlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { startCliHarness, type CliHarness, type Recorded } from './helpers/cli-harness';
import { saveConfig, tokenPrefix, USER_TOKEN_PREFIX as CLI_USER_PREFIX, SERVICE_TOKEN_PREFIX as CLI_SERVICE_PREFIX } from '../cli/src/utils/config';
import { USER_TOKEN_PREFIX, SERVICE_TOKEN_PREFIX } from '../workers/shared/service-tokens';

const USER_TOKEN = 'bh_usr_' + 'A'.repeat(43);
const OLD_TOKEN = 'bh_usr_' + 'B'.repeat(43);
const SERVICE_TOKEN = 'bh_svc_' + 'C'.repeat(43);
const NO_ENV_TOKEN = { BEEHIVE_API_TOKEN: '' };

let h: CliHarness;
let seq = 0;

type Who = Record<string, unknown>;
let whoStatus = 200;
let whoData: Who = {};
let errorStatus: number | null = null;

const user = (over: Who = {}): Who => ({ kind: 'user', actorId: 'alice', scopes: ['read'], serviceAccountId: null, userTokenId: 'ut_1', ...over });

beforeAll(async () => {
  h = await startCliHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  h.reset();
  whoStatus = 200;
  whoData = user();
  errorStatus = null;
  h.respondWith((req: Recorded) => {
    if (req.url === '/api/whoami') {
      return whoStatus === 200
        ? { status: 200, body: { success: true, data: whoData } }
        : { status: whoStatus, body: { success: false, error: whoStatus === 401 ? 'Unauthorized' : 'Service Unavailable' } };
    }
    if (errorStatus) return { status: errorStatus, body: { success: false, error: `status ${errorStatus}` } };
    return { status: 200, body: { success: true, data: {} } };
  });
});

/** A fresh config path (inside a not-yet-existing dir). */
function freshConfig(): string {
  return join(h.home, `c${++seq}`, '.beehive', 'config.json');
}
function writeConfig(path: string, content: Record<string, unknown>, mode = 0o644): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(content));
  chmodSync(path, mode);
}
const readConfig = (p: string) => JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
const mode = (p: string) => statSync(p).mode & 0o777;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

describe('config file permissions', () => {
  it('login creates the dir 0700 and the file 0600, leaving no temp file', async () => {
    const cfg = freshConfig();
    const r = await h.runCli(['--config', cfg, 'auth', 'login', '--token-stdin'], NO_ENV_TOKEN, { stdin: `${USER_TOKEN}\n` });
    expect(r.code, r.stderr).toBe(0);
    expect(mode(cfg)).toBe(0o600);
    expect(mode(join(cfg, '..'))).toBe(0o700);
    expect(readdirSync(join(cfg, '..'))).toEqual(['config.json']);
  });

  it('an existing 0644 file ends at 0600', async () => {
    const cfg = freshConfig();
    writeConfig(cfg, { apiToken: OLD_TOKEN }, 0o644);
    const r = await h.runCli(['--config', cfg, 'auth', 'login', '--token-stdin'], NO_ENV_TOKEN, { stdin: USER_TOKEN });
    expect(r.code, r.stderr).toBe(0);
    expect(mode(cfg)).toBe(0o600);
  });

  it('saveConfig is 0600 whatever the umask, and a failed save leaves the target and no temp', () => {
    const cfg = freshConfig();
    const old = process.umask(0o000);
    try {
      saveConfig({ apiToken: USER_TOKEN }, cfg);
    } finally {
      process.umask(old);
    }
    expect(mode(cfg)).toBe(0o600);

    // rename over a directory fails after the temp was written
    const dirTarget = freshConfig();
    mkdirSync(dirTarget, { recursive: true });
    expect(() => saveConfig({ apiToken: USER_TOKEN }, dirTarget)).toThrow(/Failed to save config/);
    try {
      saveConfig({ apiToken: USER_TOKEN }, dirTarget);
    } catch (e) {
      expect(String(e)).not.toContain(USER_TOKEN);
    }
    expect(readdirSync(join(dirTarget, '..')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('a symlinked config path stays a symlink: the file it points to is replaced, not the link', () => {
    const real = freshConfig();
    const link = freshConfig();
    writeConfig(real, { apiToken: OLD_TOKEN, keep: 'me' }, 0o600);
    mkdirSync(join(link, '..'), { recursive: true });
    symlinkSync(real, link);
    saveConfig({ apiToken: USER_TOKEN }, link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, 'utf-8')).apiToken).toBe(USER_TOKEN);
    expect(mode(real)).toBe(0o600);
  });

  it('the temp file is opened exclusively with 0o600 (stat after the fact cannot see the window)', () => {
    const src = readFileSync(join(__dirname, '../cli/src/utils/config.ts'), 'utf-8');
    expect(src).toMatch(/openSync\(tmp, 'wx', 0o600\)/);
    expect(src).toMatch(/mkdirSync\(dir, \{ recursive: true, mode: 0o700 \}\)/);
  });
});

describe('auth login', () => {
  it('whoami 200: saves only apiToken, prints kind and actor, sends the new token', async () => {
    const cfg = freshConfig();
    const r = await h.runCli(['--config', cfg, 'auth', 'login', '--token-stdin'], { ...NO_ENV_TOKEN, BEEHIVE_ACTOR: 'env-actor' }, { stdin: USER_TOKEN });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('user');
    expect(r.stdout).toContain('alice');
    expect(r.stdout).toContain('read');
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0].url).toBe('/api/whoami');
    expect(h.recorded[0].headers.authorization).toBe(`Bearer ${USER_TOKEN}`);
    expect(h.recorded[0].headers['x-actor-id']).toBeUndefined();
    // no env-derived values (apiUrl from BEEHIVE_API_URL, defaultActor from BEEHIVE_ACTOR) in the file
    expect(readConfig(cfg)).toEqual({ apiToken: USER_TOKEN });
  });

  it('keeps unknown and existing keys when updating', async () => {
    const cfg = freshConfig();
    writeConfig(cfg, { apiToken: OLD_TOKEN, defaultOrganization: 'o1', futureKey: { a: 1 } });
    const r = await h.runCli(['--config', cfg, 'auth', 'login', '--token-stdin'], NO_ENV_TOKEN, { stdin: USER_TOKEN });
    expect(r.code, r.stderr).toBe(0);
    expect(readConfig(cfg)).toEqual({ apiToken: USER_TOKEN, defaultOrganization: 'o1', futureKey: { a: 1 } });
  });

  it('whoami 401: exit 1, the saved good token and file are untouched, nothing created', async () => {
    const cfg = freshConfig();
    writeConfig(cfg, { apiToken: OLD_TOKEN }, 0o600);
    const before = readFileSync(cfg, 'utf-8');
    whoStatus = 401;
    const r = await h.runCli(['--config', cfg, 'auth', 'login', '--token-stdin'], NO_ENV_TOKEN, { stdin: USER_TOKEN });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Nothing was saved');
    expect(readFileSync(cfg, 'utf-8')).toBe(before);

    const none = freshConfig();
    const r2 = await h.runCli(['--config', none, 'auth', 'login', '--token-stdin'], NO_ENV_TOKEN, { stdin: USER_TOKEN });
    expect(r2.code).toBe(1);
    expect(existsSync(none)).toBe(false);
  });

  it('whoami 503: exit 1, "nothing saved", does not call the token bad, file untouched', async () => {
    const cfg = freshConfig();
    writeConfig(cfg, { apiToken: OLD_TOKEN }, 0o600);
    const before = readFileSync(cfg, 'utf-8');
    whoStatus = 503;
    const r = await h.runCli(['--config', cfg, 'auth', 'login', '--token-stdin'], NO_ENV_TOKEN, { stdin: USER_TOKEN });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Nothing was saved/);
    expect(r.stderr).not.toMatch(/rejected/);
    expect(readFileSync(cfg, 'utf-8')).toBe(before);
  });

  it('--token still works and warns that argv is visible; --token with --token-stdin is an error', async () => {
    const cfg = freshConfig();
    const r = await h.runCli(['--config', cfg, 'auth', 'login', '--token', USER_TOKEN], NO_ENV_TOKEN);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain('argv');
    expect(readConfig(cfg)).toEqual({ apiToken: USER_TOKEN });

    const both = await h.runCli(['--config', freshConfig(), 'auth', 'login', '--token', USER_TOKEN, '--token-stdin'], NO_ENV_TOKEN, { stdin: USER_TOKEN });
    expect(both.code).toBe(1);
  });

  it('empty stdin is rejected without a request', async () => {
    const r = await h.runCli(['--config', freshConfig(), 'auth', 'login', '--token-stdin'], NO_ENV_TOKEN, { stdin: '\n' });
    expect(r.code).toBe(1);
    expect(h.recorded).toHaveLength(0);
  });

  it('a corrupt config is not overwritten and its contents are not echoed', async () => {
    const cfg = freshConfig();
    mkdirSync(join(cfg, '..'), { recursive: true });
    writeFileSync(cfg, `${OLD_TOKEN} not json`);
    const r = await h.runCli(['--config', cfg, 'auth', 'login', '--token-stdin'], NO_ENV_TOKEN, { stdin: USER_TOKEN });
    expect(r.code).toBe(1);
    expect(readFileSync(cfg, 'utf-8')).toBe(`${OLD_TOKEN} not json`);
    expect(r.stdout + r.stderr).not.toContain(OLD_TOKEN);
  });
});

describe('auth logout', () => {
  it('removes only the file key and says BEEHIVE_API_TOKEN remains; env values are not persisted', async () => {
    const cfg = freshConfig();
    writeConfig(cfg, { apiToken: OLD_TOKEN, defaultOrganization: 'o1' }, 0o600);
    const r = await h.runCli(['--config', cfg, 'auth', 'logout'], { BEEHIVE_API_TOKEN: 'env-token-0123456789', BEEHIVE_ACTOR: 'env-actor' });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('BEEHIVE_API_TOKEN is still set');
    expect(readConfig(cfg)).toEqual({ defaultOrganization: 'o1' });
  });

  it('does not create a config file when there is none', async () => {
    const cfg = freshConfig();
    const r = await h.runCli(['--config', cfg, 'auth', 'logout'], NO_ENV_TOKEN);
    expect(r.code, r.stderr).toBe(0);
    expect(existsSync(cfg)).toBe(false);
  });
});

describe('actor handling under a user token', () => {
  const issueArgs = ['issue', 'create', 'T', '--repository', 'r1', '--number', '1'];
  const warnings = (stderr: string) => stderr.split('\n').filter((l) => l.includes('ignored because the token is a user token'));

  it.each([
    ['--actor', [] as string[], ['--actor', 'from-flag'], {}],
    ['BEEHIVE_ACTOR', [], [], { BEEHIVE_ACTOR: 'from-env' }],
    ['config defaultActor', 'cfg', [], {}],
  ])('%s: no X-Actor-ID, one warning, exit 0', async (_n, pre, post, env) => {
    let args = issueArgs;
    if (pre === 'cfg') {
      const f = freshConfig();
      writeConfig(f, { defaultActor: 'from-config' });
      args = ['--config', f, ...issueArgs];
    }
    const r = await h.runCli([...args, ...(post as string[])], { BEEHIVE_API_TOKEN: USER_TOKEN, ...(env as Record<string, string>) });
    expect(r.code, r.stderr).toBe(0);
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0].headers['x-actor-id']).toBeUndefined();
    expect(warnings(r.stderr)).toHaveLength(1);
  });

  it('an invalid ignored actor does not abort', async () => {
    const r = await h.runCli(issueArgs, { BEEHIVE_API_TOKEN: USER_TOKEN, BEEHIVE_ACTOR: 'Jane Doe' });
    expect(r.code, r.stderr).toBe(0);
    expect(h.recorded[0].headers['x-actor-id']).toBeUndefined();
    expect(r.stderr).not.toContain('Invalid actor id');
  });

  it('no warning when no actor is set; a service token still sends the actor', async () => {
    const quiet = await h.runCli(issueArgs, { BEEHIVE_API_TOKEN: USER_TOKEN });
    expect(quiet.stderr).toBe('');
    h.reset();
    const svc = await h.runCli(issueArgs, { BEEHIVE_API_TOKEN: SERVICE_TOKEN, BEEHIVE_ACTOR: 'a1' });
    expect(svc.stderr).toBe('');
    expect(h.recorded[0].headers['x-actor-id']).toBe('a1');
  });
});

describe('auth whoami', () => {
  it.each([
    ['read', ['read'], 'read'],
    ['read_write', ['read', 'write'], 'read_write'],
    ['maintainer', ['read', 'write', 'maintainer'], 'maintainer'],
  ])('user token, %s', async (_n, scopes, label) => {
    whoData = user({ scopes });
    const r = await h.runCli(['auth', 'whoami'], { BEEHIVE_API_TOKEN: USER_TOKEN });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`Scope:\\s+${label}\\b`));
    expect(r.stdout).toContain('alice');
    expect(r.stdout).toContain('ut_1');
    expect(r.stdout).toMatch(/Token source:\s+env/);
    expect(r.stdout).toContain('bh_usr_AAAAA...');
  });

  it('master and service tokens', async () => {
    whoData = { kind: 'master', actorId: 'unknown', scopes: ['read', 'write', 'maintainer'], serviceAccountId: null, userTokenId: null };
    const m = await h.runCli(['auth', 'whoami'], { BEEHIVE_API_TOKEN: 'master-token-0123456789' });
    expect(m.stdout).toMatch(/Kind:\s+master/);
    expect(m.stdout).toContain('unknown');
    expect(m.stdout).not.toContain('master-token-0123456789');

    whoData = { kind: 'service', actorId: 'svc:ci', scopes: ['read'], serviceAccountId: 'sa_1', userTokenId: null };
    const s = await h.runCli(['auth', 'whoami'], { BEEHIVE_API_TOKEN: SERVICE_TOKEN });
    expect(s.stdout).toMatch(/Kind:\s+service/);
    expect(s.stdout).toContain('sa_1');
  });

  it('an older edge without userTokenId or scopes still works', async () => {
    whoData = { kind: 'master', actorId: 'unknown' };
    const r = await h.runCli(['auth', 'whoami'], { BEEHIVE_API_TOKEN: 'master-token-0123456789' });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Scope:\s+unknown/);
    expect(r.stdout).not.toContain('User token');
  });

  it('reports the token source: flag, env, config', async () => {
    const cfg = freshConfig();
    writeConfig(cfg, { apiToken: USER_TOKEN }, 0o600);
    const fromConfig = await h.runCli(['--config', cfg, 'auth', 'whoami'], NO_ENV_TOKEN);
    expect(fromConfig.stdout).toMatch(/Token source:\s+config/);
    const fromEnv = await h.runCli(['--config', cfg, 'auth', 'whoami'], { BEEHIVE_API_TOKEN: OLD_TOKEN });
    expect(fromEnv.stdout).toMatch(/Token source:\s+env/);
    const fromFlag = await h.runCli(['--config', cfg, '--token', SERVICE_TOKEN, 'auth', 'whoami'], NO_ENV_TOKEN);
    expect(fromFlag.stdout).toMatch(/Token source:\s+flag/);
  });
});

describe('error hints', () => {
  const issueList = ['issue', 'list'];
  it.each([
    [401, 'user', /revoked, expired/],
    [403, 'user', /master-only for user tokens/],
    [503, 'user', /retry/],
    [503, 'master', /retry/],
  ])('%i with a %s token', async (status, kind, hint) => {
    errorStatus = status;
    const token = kind === 'user' ? USER_TOKEN : 'master-token-0123456789';
    const r = await h.runCli(issueList, { BEEHIVE_API_TOKEN: token });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(hint);
    expect(r.stderr).not.toContain(token);
    expect(r.stderr).not.toMatch(/Bearer/i);
  });

  it('403 with a non-user token has no user-token hint', async () => {
    errorStatus = 403;
    const r = await h.runCli(issueList, { BEEHIVE_API_TOKEN: 'master-token-0123456789' });
    expect(r.stderr).not.toContain('user tokens');
  });
});

describe('secret hygiene', () => {
  it('the full token and its SHA-256 never appear in stdout/stderr of any token command', async () => {
    const cfg = freshConfig();
    const env = { BEEHIVE_API_TOKEN: USER_TOKEN };
    const runs = [
      await h.runCli(['--config', cfg, 'auth', 'login', '--token-stdin'], NO_ENV_TOKEN, { stdin: USER_TOKEN }),
      await h.runCli(['--config', cfg, 'auth', 'whoami'], NO_ENV_TOKEN),
      await h.runCli(['--config', cfg, 'auth', 'status'], NO_ENV_TOKEN),
      await h.runCli(['--config', cfg, 'auth', 'test'], NO_ENV_TOKEN),
      await h.runCli(['--config', cfg, 'auth', 'show-token'], NO_ENV_TOKEN),
      await h.runCli(['--verbose', 'auth', 'whoami'], env),
      await h.runCli(['--verbose', 'issue', 'list'], env),
      await h.runCli(['--config', cfg, 'auth', 'logout'], env),
    ];
    for (const r of runs) {
      expect(r.code, r.stderr).toBe(0);
      const all = r.stdout + r.stderr;
      expect(all).not.toContain(USER_TOKEN);
      expect(all).not.toContain(sha256(USER_TOKEN));
      expect(all).not.toContain('A'.repeat(20));
    }
    expect(runs[4].stdout).toContain('Token: bh_usr_AAAAA...');
  });

  it('show-token with no token fails', async () => {
    const r = await h.runCli(['--config', freshConfig(), 'auth', 'show-token'], NO_ENV_TOKEN);
    expect(r.code).toBe(1);
  });
});

describe('token prefixes', () => {
  it('shows 12 characters of a user or service token and only 8 of anything else, never more than half of a short token', () => {
    expect(tokenPrefix(`${CLI_USER_PREFIX}abcdefghijklmnopqrstuvwxyz`)).toHaveLength(12);
    expect(tokenPrefix(`${CLI_SERVICE_PREFIX}abcdefghijklmnopqrstuvwxyz`)).toHaveLength(12);
    expect(tokenPrefix('a'.repeat(64))).toHaveLength(8);
    expect(tokenPrefix('abcd')).toBe('ab');
  });


  it("the CLI's bh_usr_/bh_svc_ constants equal the worker's", () => {
    expect(CLI_USER_PREFIX).toBe(USER_TOKEN_PREFIX);
    expect(CLI_SERVICE_PREFIX).toBe(SERVICE_TOKEN_PREFIX);
  });
});
