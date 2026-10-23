/**
 * Service and user token generation and hashing.
 *
 * Plaintext is a type prefix (`bh_svc_` service, `bh_usr_` user) + base64url(32
 * random bytes). Only the SHA-256 hex digest and a short prefix are ever stored;
 * plaintext is returned once.
 */

export const SERVICE_TOKEN_PREFIX = 'bh_svc_';
export const USER_TOKEN_PREFIX = 'bh_usr_';
export type TokenTypePrefix = typeof SERVICE_TOKEN_PREFIX | typeof USER_TOKEN_PREFIX;
const TOKEN_PREFIX_DISPLAY_LENGTH = 12;
// base64url of 32 bytes, unpadded
const TOKEN_BODY = /^[A-Za-z0-9_-]{43}$/;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** `prefix` + base64url of 32 bytes from crypto.getRandomValues (256 bits). */
export function generateToken(prefix: TokenTypePrefix): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return prefix + toBase64Url(bytes);
}

export function generateServiceToken(): string {
  return generateToken(SERVICE_TOKEN_PREFIX);
}

export function generateUserToken(): string {
  return generateToken(USER_TOKEN_PREFIX);
}

export async function hashToken(plaintext: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(plaintext));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function tokenPrefix(plaintext: string): string {
  return plaintext.slice(0, TOKEN_PREFIX_DISPLAY_LENGTH);
}

/** Cheap edge pre-check: exact prefix, length and base64url charset, before any DO round-trip. */
export function looksLikeToken(prefix: TokenTypePrefix, value: string): boolean {
  return value.startsWith(prefix) && TOKEN_BODY.test(value.slice(prefix.length));
}

export function looksLikeServiceToken(value: string): boolean {
  return looksLikeToken(SERVICE_TOKEN_PREFIX, value);
}

export function looksLikeUserToken(value: string): boolean {
  return looksLikeToken(USER_TOKEN_PREFIX, value);
}

/** Constant-time string compare via digests (equal length, so no early exit on length). */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
