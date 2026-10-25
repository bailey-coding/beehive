/**
 * Candidate bundle source backed by `beehive-sandbox-runner` (docs/SANDBOX-BUILD-PLAN.md): asks it to build a candidate
 * commit in its container and returns the bundle the api Versions client uploads. Not used unless
 * `WORKER_VERSIONS_MODE=api` (production stays at 501 otherwise).
 */

import { z } from 'zod';
import type { CandidateBundleSource } from './versions';

/** A failed build, carrying the sandbox-runner's error code and an HTTP status for the route to answer with. */
export class SandboxBuildError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
  }
}

const BuildResponseSchema = z.object({
  success: z.literal(true),
  bundle: z.object({
    mainModule: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
    modules: z.array(z.object({ name: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/), content: z.string().min(1) })).min(1).max(8),
    compatibilityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    source: z.enum(['prebuilt', 'esbuild']),
  }),
});

const ErrorResponseSchema = z.object({ code: z.string().optional(), error: z.string().optional() });

const SHA_RE = /^[0-9a-f]{40}$/;
/** The build can take up to the runner's 150 s deadline plus queueing behind another build of the same commit. */
const BUILD_TIMEOUT_MS = 170_000;

export function sandboxBundleSource(runner: Fetcher, apiToken: string | undefined): CandidateBundleSource {
  return async (input) => {
    if (!apiToken) throw new SandboxBuildError('NOT_CONFIGURED', 503, 'API_AUTH_TOKEN is not configured on the preview manager');
    if (!input.repoName) throw new SandboxBuildError('BAD_REQUEST', 422, 'the candidate has no repository to build');
    if (!input.commitSha || !SHA_RE.test(input.commitSha)) {
      throw new SandboxBuildError('BAD_REQUEST', 422, 'the candidate has no full 40-character commit to build');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BUILD_TIMEOUT_MS);
    let res: Response;
    try {
      res = await runner.fetch('https://sandbox-runner.internal/sandbox/build', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: input.repoName, commitSha: input.commitSha }),
        signal: controller.signal,
      });
    } catch (error) {
      const timedOut = controller.signal.aborted;
      throw new SandboxBuildError('UNAVAILABLE', 504, timedOut ? 'the build service did not answer in time' : `the build service is unreachable: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }

    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const parsed = ErrorResponseSchema.safeParse(body);
      const detail = parsed.success ? parsed.data : {};
      throw new SandboxBuildError(detail.code ?? 'UNAVAILABLE', res.status, detail.error ?? `the build service answered HTTP ${res.status}`);
    }
    const parsed = BuildResponseSchema.safeParse(body);
    if (!parsed.success) throw new SandboxBuildError('UNAVAILABLE', 502, 'the build service returned an unexpected response');

    const { mainModule, modules, compatibilityDate } = parsed.data.bundle;
    const main = modules.find((m) => m.name === mainModule);
    if (!main) throw new SandboxBuildError('BUILD_FAILED', 422, 'the bundle has no main module');
    // A module Worker must export a handler. This also catches a checked-out symlink (a text file holding only a path).
    if (!/\bexport\b/.test(main.content)) throw new SandboxBuildError('BUILD_FAILED', 422, 'the built file is not an ES module (it has no export)');
    return { mainModule, modules: modules.map((m) => ({ name: m.name, content: m.content })), compatibilityDate };
  };
}
