/** Every assignment of `key` in a TOML text (bare or quoted key, plain or inline-table), as its raw value; comments are stripped first */
export function assignments(text: string, key: string): string[] {
  const code = text.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n');
  return [...code.matchAll(new RegExp(`["']?${key}["']?\\s*=\\s*("[^"]*"|'[^']*'|[^\\s,}]+)`, 'g'))].map((m) => m[1].replace(/^["']|["']$/g, ''));
}
