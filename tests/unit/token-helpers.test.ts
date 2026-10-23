/**
 * Token helpers (workers/shared/service-tokens.ts) after the user-token generalisation:
 * bh_usr_ tokens share the bh_svc_ format (prefix + base64url of 32 random bytes), each
 * prefix only matches its own shape check, and every bh_svc_ behaviour is unchanged.
 *
 * Task: T2 | Spec: docs/M12-IMPL-PLAN.md S1
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SERVICE_TOKEN_PREFIX,
  USER_TOKEN_PREFIX,
  generateServiceToken,
  generateUserToken,
  generateToken,
  hashToken,
  looksLikeServiceToken,
  looksLikeUserToken,
  looksLikeToken,
  tokenPrefix,
} from '../../workers/shared/service-tokens';

const BODY = /^[A-Za-z0-9_-]{43}$/;

afterEach(() => vi.restoreAllMocks());

describe('user tokens (bh_usr_)', () => {
  it('are bh_usr_ + a 43-char base64url body, and two mints differ', () => {
    const a = generateUserToken();
    const b = generateUserToken();
    expect(USER_TOKEN_PREFIX).toBe('bh_usr_');
    expect(a.startsWith('bh_usr_')).toBe(true);
    expect(a).toHaveLength(7 + 43);
    expect(a.slice(7)).toMatch(BODY);
    expect(a).not.toBe(b);
    expect(looksLikeUserToken(a)).toBe(true);
  });

  it('draw 32 bytes from crypto.getRandomValues (256 bits)', () => {
    const spy = vi.spyOn(crypto, 'getRandomValues');
    generateUserToken();
    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0][0] as Uint8Array).length).toBe(32);
  });

  it('display prefix is the first 12 chars: the type prefix plus 5 body chars', () => {
    const t = generateUserToken();
    expect(tokenPrefix(t)).toBe(t.slice(0, 12));
    expect(tokenPrefix(t)).toMatch(/^bh_usr_[A-Za-z0-9_-]{5}$/);
  });

  it('the shape check rejects wrong length, charset, prefix and a service token', () => {
    const t = generateUserToken();
    const bad = [
      t.slice(0, -1),
      t + 'A',
      t.slice(0, -1) + '=',
      t.slice(0, -1) + '+',
      t.slice(0, -1) + '/',
      'bh_usr_',
      '',
      'BH_USR_' + t.slice(7),
      'bh-usr_' + t.slice(7),
      'bh_usr' + t.slice(7),
      ' ' + t,
      t + '\n',
      generateServiceToken(),
    ];
    for (const v of bad) expect(looksLikeUserToken(v), JSON.stringify(v)).toBe(false);
  });

  it('hashes to lowercase SHA-256 hex, deterministically, and never equal to the plaintext', async () => {
    const t = generateUserToken();
    const h = await hashToken(t);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashToken(t)).toBe(h);
    expect(h).not.toContain(t.slice(7));
  });
});

describe('service tokens (bh_svc_) are unchanged', () => {
  it('keep their prefix, length, shape check and display prefix', () => {
    const t = generateServiceToken();
    expect(SERVICE_TOKEN_PREFIX).toBe('bh_svc_');
    expect(t.startsWith('bh_svc_')).toBe(true);
    expect(t).toHaveLength(7 + 43);
    expect(t.slice(7)).toMatch(BODY);
    expect(looksLikeServiceToken(t)).toBe(true);
    expect(looksLikeServiceToken(t.slice(0, -1))).toBe(false);
    expect(looksLikeServiceToken(t + 'x')).toBe(false);
    expect(looksLikeServiceToken(generateUserToken())).toBe(false);
    expect(tokenPrefix(t)).toMatch(/^bh_svc_[A-Za-z0-9_-]{5}$/);
  });

  it('match the old literal regex on generated and hand-made values', () => {
    const old = (v: string) => /^bh_svc_[A-Za-z0-9_-]{43}$/.test(v);
    const samples = [generateServiceToken(), 'bh_svc_' + 'a'.repeat(43), 'bh_svc_' + 'a'.repeat(42), 'bh_svc_' + 'a'.repeat(42) + '!'];
    for (const v of samples) expect(looksLikeServiceToken(v)).toBe(old(v));
  });
});

describe('generic helpers', () => {
  it('generateToken and looksLikeToken take the prefix as a parameter', () => {
    expect(looksLikeToken(USER_TOKEN_PREFIX, generateToken(USER_TOKEN_PREFIX))).toBe(true);
    expect(looksLikeToken(SERVICE_TOKEN_PREFIX, generateToken(USER_TOKEN_PREFIX))).toBe(false);
    expect(looksLikeToken(USER_TOKEN_PREFIX, generateToken(SERVICE_TOKEN_PREFIX))).toBe(false);
  });
});
