import { describe, it, expect } from 'vitest';
import { isValidNamespace, isValidNewNamespace } from '../../workers/shared/namespace';

describe('namespace validators', () => {
  it('new names must be 2-63 characters (Artifacts limit)', () => {
    expect(isValidNewNamespace('a')).toBe(false);
    expect(isValidNewNamespace('ab')).toBe(true);
    expect(isValidNewNamespace('a'.repeat(63))).toBe(true);
    expect(isValidNewNamespace('a'.repeat(64))).toBe(false);
    expect(isValidNewNamespace('-ab')).toBe(false);
    expect(isValidNewNamespace('a b')).toBe(false);
    expect(isValidNewNamespace(5)).toBe(false);
  });
  it('the permissive validator still accepts legacy 1 and 64 character names', () => {
    expect(isValidNamespace('a')).toBe(true);
    expect(isValidNamespace('a'.repeat(64))).toBe(true);
    expect(isValidNamespace('a'.repeat(65))).toBe(false);
  });
});
