/**
 * Artifacts namespace names. One definition for the Spec DO (new organization names become namespaces), the sandbox runner
 * (which mints read tokens per namespace) and the preview manager (which refuses a name the runner would refuse).
 * Spec: docs/SF-8-NAMESPACE-PLAN.md
 */
export const NAMESPACE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isValidNamespace(value: unknown): value is string {
  return typeof value === 'string' && NAMESPACE_RE.test(value);
}

/**
 * Stricter check for NEW names only (Cloudflare Artifacts limits: 2-63 characters). `isValidNamespace` stays permissive so
 * rows written before this check (1 or 64 characters) keep working; only organization creation uses this one.
 */
export const NEW_NAMESPACE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,62}$/;

export function isValidNewNamespace(value: unknown): value is string {
  return typeof value === 'string' && NEW_NAMESPACE_RE.test(value);
}
