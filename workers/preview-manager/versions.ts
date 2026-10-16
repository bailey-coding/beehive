/**
 * Workers Versions: build an immutable version of a candidate Worker for canary.
 *
 * Only the stub exists. Whether the Workers Versions API can create a version
 * from a candidate commit and switch traffic to it instantly is unverified
 * (docs/OPEN-QUESTIONS.md, "Canary deploy and rollback"), so no code here calls
 * the Cloudflare API. Traffic does not depend on a version switch either: the
 * shadow router follows the Spec DO deploy ref, which names the version.
 *
 * Spec: AGENTS.md#non-negotiable-architectural-rules (rule 7: rollback is a ref operation)
 */

export interface CanaryVersionInput {
  workerName: string;
  candidateId: string;
  commitSha: string | null;
}

export interface CanaryVersion {
  versionId: string;
  url: string;
}

export interface WorkerVersionsClient {
  readonly kind: 'stub';
  createVersion(input: CanaryVersionInput): Promise<CanaryVersion>;
}

/**
 * Local stand-in: a fresh `stub-<uuid>` version id per call and a version
 * preview URL in the `<version prefix>-<worker>.<subdomain>.workers.dev` shape.
 * Nothing is built or deployed.
 */
export class StubWorkerVersionsClient implements WorkerVersionsClient {
  readonly kind = 'stub' as const;

  constructor(private readonly subdomain?: string) {}

  async createVersion(input: CanaryVersionInput): Promise<CanaryVersion> {
    const uuid = crypto.randomUUID();
    const host = this.subdomain ? `${input.workerName}.${this.subdomain}` : input.workerName;
    return { versionId: `stub-${uuid}`, url: `https://${uuid.slice(0, 8)}-${host}.workers.dev` };
  }
}

/**
 * The stub only when WORKER_VERSIONS_MODE is 'stub' AND BEEHIVE_LOCAL_DEV is '1'.
 * The second variable is set only by scripts/start-e2e-workers.sh (`--var`), so a
 * production worker with WORKER_VERSIONS_MODE=stub set by mistake still gets null:
 * there is no real client, and the route answers 501 rather than reporting a
 * version that was never built.
 */
export function workerVersionsClientFor(env: {
  WORKER_VERSIONS_MODE?: string;
  BEEHIVE_LOCAL_DEV?: string;
  WORKERS_SUBDOMAIN?: string;
}): WorkerVersionsClient | null {
  const local = env.BEEHIVE_LOCAL_DEV === '1';
  return local && env.WORKER_VERSIONS_MODE === 'stub' ? new StubWorkerVersionsClient(env.WORKERS_SUBDOMAIN) : null;
}
