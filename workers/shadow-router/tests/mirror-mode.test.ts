/**
 * Unit tests for what a mirrored request may carry to a candidate (workers/shadow-router/mirror-mode.ts) and for the
 * Scientist queue message (docs/M5A-2-GOVERNANCE-PLAN.md Rev 5, PR-H).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mirrorRequestFor, redactBody, redactJsonValue, resolveMirrorMode, routeTemplate, routeWords } from '../mirror-mode';
import { scientistSafeHeaders, scientistSafeResponseHeaders } from '../candidate-headers';

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe('resolveMirrorMode', () => {
  it('defaults to none and fails closed on anything unknown', () => {
    expect(resolveMirrorMode({})).toBe('none');
    expect(resolveMirrorMode({ MIRROR_BODY_MODE: '' })).toBe('none');
    expect(resolveMirrorMode({ MIRROR_BODY_MODE: 'all' })).toBe('none');
  });
  it('accepts redacted, and full only with the human-set egress var', () => {
    expect(resolveMirrorMode({ MIRROR_BODY_MODE: 'Redacted' })).toBe('redacted');
    expect(resolveMirrorMode({ MIRROR_BODY_MODE: 'full' })).toBe('none');
    expect(resolveMirrorMode({ MIRROR_BODY_MODE: 'full', GOVERNANCE_EGRESS_CONTROLLED: 'yes' })).toBe('none');
    expect(resolveMirrorMode({ MIRROR_BODY_MODE: 'full', GOVERNANCE_EGRESS_CONTROLLED: 'true' })).toBe('full');
  });
});

describe('routeTemplate (an allowlist of route words)', () => {
  const words = routeWords({ MIRROR_ROUTE_WORDS: 'specs,Issues, bad word ,9lives,candidates' });

  it('keeps only configured and default route words', () => {
    expect(routeTemplate('/api/specs', words)).toBe('/api/specs');
    expect(routeTemplate('/api/issues/12345/candidates', words)).toBe('/api/issues/:id/candidates'); // 'Issues' was lowercased
    expect(routeTemplate('/', words)).toBe('/');
    expect(routeTemplate('', words)).toBe('/');
  });

  it.each([
    '/users/alice/reset', '/org/acme-corp/billing', '/x/user_42', '/u/a1b2', '/x/cafe', '/abc123',
    '/t/k3jh4kj23h4kj23h4kj2', '/x/abcdefgh', '/x/deadbee', '/api/users/alice@example.com/profile', '/a/deadbeefcafe0123',
    '/api/6ba7b810-9dad-11d1-80b4-00c04fd430c8', '/api/Spec%20Name', '/reset/AbCdEf123456',
  ])('never lets a slug, username, short token or id through: %s', (path) => {
    const out = routeTemplate(path, words);
    for (const segment of path.split('/').filter(Boolean)) {
      if (!['api'].includes(segment)) expect(out.split('/')).not.toContain(segment);
    }
  });

  it('ignores invalid configured words (spaces, leading digit) and unknown path words', () => {
    expect(words.has('bad word')).toBe(false);
    expect(words.has('9lives')).toBe(false);
    expect(routeTemplate('/9lives', words)).toBe('/:id');
  });

  it('bounds the segment count and total length, so a long path is not a covert channel', () => {
    expect(routeTemplate('/api/' + 'a/'.repeat(40), words).split('/').length).toBeLessThanOrEqual(9);
    expect(routeTemplate('/' + Array.from({ length: 8 }, () => 'candidates').join('/'), words).length).toBeLessThanOrEqual(128);
  });
});

describe('redaction', () => {
  it('replaces string and number leaves and key names, keeps booleans and null, and bounds depth and width', () => {
    expect(redactJsonValue({ a: 'x', b: 1, c: false, d: null, e: [{ f: 'y' }] })).toEqual({ k0: '<string>', k1: 0, k2: false, k3: null, k4: [{ k0: '<string>' }] });
    expect(JSON.stringify(redactJsonValue({ 'alice@x.com': 1, '__proto__': { x: 1 } }))).not.toContain('alice');
    let deep: unknown = 'secret';
    for (let i = 0; i < 40; i++) deep = { n: deep };
    expect(JSON.stringify(redactJsonValue(deep))).not.toContain('secret');
    expect((redactJsonValue(Array.from({ length: 500 }, () => 's')) as unknown[]).length).toBe(50);
  });
  it('redactBody drops non-JSON, invalid JSON and empty bodies', () => {
    const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
    expect(redactBody(bytes('hello'), 'text/plain')).toBeUndefined();
    expect(redactBody(bytes('{bad'), 'application/json')).toBeUndefined();
    expect(redactBody(undefined, 'application/json')).toBeUndefined();
    expect(redactBody(bytes('{"a":"b"}'), null)).toBeUndefined();
    expect(new TextDecoder().decode(redactBody(bytes('{"a":"b"}'), 'application/vnd.api+json; charset=utf-8'))).toBe('{"k0":"<string>"}');
    expect(redactBody(bytes('{"a":"b"}'), 'application/json-seq')).toBeUndefined();
    expect(redactBody(bytes('{"a":"b"}'), 'application/jsonx')).toBeUndefined();
    expect(redactBody(bytes('a=b&c=d'), 'application/x-www-form-urlencoded')).toBeUndefined();
    expect(redactBody(new Uint8Array([0xff, 0xfe, 0x7b, 0x7d]).buffer as ArrayBuffer, 'application/json')).toBeUndefined(); // not UTF-8
    const big = bytes(JSON.stringify(Array.from({ length: 45 }, () => Array.from({ length: 49 }, () => 'x'))));
    expect(redactBody(big, 'application/json')).toBeUndefined(); // more than 2000 nodes: dropped, not truncated
  });
});

describe('Scientist queue headers (allowlists)', () => {
  it('keeps only Accept and Content-Type of the request, so unknown credential-like headers are never persisted', () => {
    const h = new Headers({
      accept: 'text/html', 'content-type': 'application/json', authorization: 'Bearer x', cookie: 'a=b',
      'x-csrf-token': 't', 'x-auth-token': 't', 'cf-access-jwt-assertion': 'jwt', 'x-forwarded-for': '1.2.3.4', 'user-agent': 'ua',
    });
    expect(scientistSafeHeaders(h)).toEqual({ accept: 'text/html', 'content-type': 'application/json' });
  });
  it('keeps a short allowlist of candidate response headers with bounded values', () => {
    const h = new Headers({ 'content-type': 'text/plain', 'set-cookie': 'a=b', 'x-leak': 'v', etag: 'e'.repeat(1000) });
    const out = scientistSafeResponseHeaders(h);
    expect(Object.keys(out).sort()).toEqual(['content-type', 'etag']);
    expect(out.etag.length).toBe(200);
  });
});

describe('mirrorRequestFor', () => {
  const url = new URL('https://router.example/api/specs/abc-123?token=s3cret');
  const source = new Headers({ accept: 'text/html', 'content-type': 'application/json; secret=zzz', 'x-request-id': 'client-id', 'user-agent': 'ua' });
  const body = new TextEncoder().encode('{"a":"b"}').buffer as ArrayBuffer;
  const words = routeWords({});

  it('mode none: route template, Accept and the router id only, no body, no client x-request-id', () => {
    const t = mirrorRequestFor('none', url, source, body, 'router-id', new Headers(), words);
    expect(t.pathAndQuery).toBe('/api/:id/:id');
    expect(t.body).toBeUndefined();
    expect([...t.headers.keys()].sort()).toEqual(['accept', 'x-request-id']);
    expect(t.headers.get('x-request-id')).toBe('router-id');
  });

  it('mode redacted: constant content type (the source value and its parameters are never forwarded)', () => {
    const t = mirrorRequestFor('redacted', url, source, body, 'router-id', new Headers(), words);
    expect(t.headers.get('content-type')).toBe('application/json');
    expect(JSON.stringify([...t.headers])).not.toContain('zzz');
    expect(new TextDecoder().decode(t.body)).toBe('{"k0":"<string>"}');
    expect(t.pathAndQuery).not.toContain('?');
  });

  it('mode full: the original path, query, body and the prepared headers', () => {
    const full = new Headers({ accept: 'x' });
    const t = mirrorRequestFor('full', url, source, body, 'router-id', full, words);
    expect(t.pathAndQuery).toBe('/api/specs/abc-123?token=s3cret');
    expect(t.headers).toBe(full);
    expect(t.body?.byteLength).toBe(body.byteLength);
  });
});
