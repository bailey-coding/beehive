/**
 * Artifacts namespace names. One definition for the Spec DO (new organization names become namespaces), the sandbox runner
 * (which mints read tokens per namespace) and the preview manager (which refuses a name the runner would refuse).
 * Spec: docs/SF-8-NAMESPACE-PLAN.md
 */
export const NAMESPACE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isValidNamespace(value: unknown): value is string {
  return typeof value === 'string' && NAMESPACE_RE.test(value);
}
