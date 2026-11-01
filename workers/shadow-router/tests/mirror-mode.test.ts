/**
 * Unit tests for what a mirrored request may carry to a candidate (workers/shadow-router/mirror-mode.ts) and for the
 * Scientist queue message (docs/M5A-2-GOVERNANCE-PLAN.md Rev 5, PR-H).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redactBody, redactJsonValue, resolveMirrorMode, routeTemplate } from '../mirror-mode';
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

describe('routeTemplate', () => {
  it.each([
    ['/api/specs', '/api/specs'],
    ['/api/specs/6ba7b810-9dad-11d1-80b4-00c04fd430c8', '/api/specs/:id'],
    ['/api/users/alice@example.com/profile', '/api/users/:id/profile'],
    ['/api/orders/12345', '/api/orders/:id'],
    ['/reset/AbCdEf123456', '/reset/:id'],
    ['/a/deadbeefcafe0123', '/a/:id'],
    ['/', '/'],
    ['/api/Spec%20Name', '/api/:id'],
  ])('%s -> %s', (input, expected) => {
    expect(routeTemplate(input)).toBe(expected);
  });
});

describe('redaction', () => {
  it('replaces string and number leaves, keeps keys, booleans and null, and bounds depth and width', () => {
    expect(redactJsonValue({ a: 'x', b: 1, c: false, d: null, e: [{ f: 'y' }] })).toEqual({ a: '<string>', b: 0, c: false, d: null, e: [{ f: '<string>' }] });
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
    expect(new TextDecoder().decode(redactBody(bytes('{"a":"b"}'), 'application/vnd.api+json; charset=utf-8'))).toBe('{"a":"<string>"}');
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
