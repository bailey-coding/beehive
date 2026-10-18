/**
 * Service token generation and hashing.
 *
 * Plaintext is `bh_svc_` + base64url(32 random bytes). Only the SHA-256 hex
 * digest and a short prefix are ever stored; plaintext is returned once.
 */

export const SERVICE_TOKEN_PREFIX = 'bh_svc_';
export const USER_TOKEN_PREFIX = 'bh_usr_';
const TOKEN_PREFIX_DISPLAY_LENGTH = 12;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateToken(prefix: string): string {
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

/** Cheap edge pre-check: exact length and base64url charset, before any DO round-trip. */
export function looksLikeServiceToken(value: string): boolean {
  return /^bh_svc_[A-Za-z0-9_-]{43}$/.test(value);
}

export function looksLikeUserToken(value: string): boolean {
  return /^bh_usr_[A-Za-z0-9_-]{43}$/.test(value);
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
