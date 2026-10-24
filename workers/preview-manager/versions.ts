/**
 * Workers Versions: build an immutable version of a candidate Worker for canary.
 *
 * Two clients. `StubWorkerVersionsClient` is the local stand-in. `ApiWorkerVersionsClient`
 * calls the Cloudflare Workers API (verified 2026-10-24, docs/OPEN-QUESTIONS.md "Workers
 * Versions API: verified"); it is selected only by WORKER_VERSIONS_MODE=api and needs a
 * bundle source (the built candidate modules), which is not wired yet, so production keeps
 * answering 501. Traffic does not depend on a deployment switch: the shadow router follows
 * the Spec DO deploy ref, which names the version, and reaches it by its version URL.
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
  readonly kind: 'stub' | 'api';
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

/** One module of a built candidate Worker. */
export interface BundleModule {
  name: string;
  content: string | ArrayBuffer;
  /** e.g. `application/javascript+module` (default) or `application/wasm`. */
  contentType?: string;
}

export interface CandidateBundle {
  mainModule: string;
  modules: BundleModule[];
  compatibilityDate: string;
  compatibilityFlags?: string[];
  /** Upload-metadata bindings. Default none: candidate services are stateless. */
  bindings?: unknown[];
}

/** Supplies the built code of a candidate. Where it comes from (Workers Builds output, Artifacts) is unwired. */
export type CandidateBundleSource = (input: CanaryVersionInput) => Promise<CandidateBundle>;

export interface DeploymentVersion {
  versionId: string;
  percentage: number;
}

const API_BASE = 'https://api.cloudflare.com/client/v4';
/** API error 10007: "This Worker does not exist on your account". */
const WORKER_NOT_FOUND = 10007;
/** Version URL label is `<8 hex>-<worker>`; DNS labels are at most 63 characters. */
const MAX_LABEL = 63;

interface CfEnvelope<T> {
  success?: boolean;
  result?: T;
  errors?: Array<{ code: number; message: string }>;
}

/** Why `name` cannot be a candidate Worker (safe path segment, fits the version URL label), or null if it can. */
export function workerNameError(name: string): string | null {
  if (!/^[a-z0-9-]+$/.test(name)) return `Invalid Worker name: ${name}`;
  if (name.length + 9 > MAX_LABEL) return `Worker name too long for a version URL label: ${name}`;
  return null;
}

class CfApiError extends Error {
  constructor(readonly codes: number[], message: string) {
    super(message);
  }
}

/**
 * Real client. `createVersion` uploads the candidate's built modules to its own Worker
 * (`beehive-candidate-<id>`) without deploying them. The first upload of a Worker cannot be a
 * version upload (404, code 10007), so it goes through the script upload, which also creates
 * the first deployment at 100% (harmless: no production traffic is routed to candidate
 * Workers). Later uploads are versions only. Never touches any other Worker.
 */
export class ApiWorkerVersionsClient implements WorkerVersionsClient {
  readonly kind = 'api' as const;

  constructor(
    private readonly cfg: { accountId: string; apiToken: string; subdomain: string; bundle: CandidateBundleSource },
    private readonly fetchFn: typeof fetch = (input, init) => fetch(input, init)
  ) {}

  async createVersion(input: CanaryVersionInput): Promise<CanaryVersion> {
    const nameError = workerNameError(input.workerName);
    if (nameError) throw new Error(nameError);
    const bundle = await this.cfg.bundle(input);
    const script = `/accounts/${this.cfg.accountId}/workers/scripts/${input.workerName}`;
    const annotations: Record<string, string> = { 'workers/tag': truncateUtf8(input.candidateId, 100) };
    if (input.commitSha) annotations['workers/commit_sha'] = input.commitSha.slice(0, 64);

    let versionId: string;
    try {
      const res = await this.call<{ id: string }>('POST', `${script}/versions`, this.form(bundle, annotations));
      versionId = toUuid(res.id);
    } catch (error) {
      if (!(error instanceof CfApiError) || !error.codes.includes(WORKER_NOT_FOUND)) throw error;
      // First upload: creates the Worker, version 1 and a 100% deployment. The result's
      // `deployment_id` is that version's id as undashed hex.
      const res = await this.call<{ deployment_id: string }>('PUT', script, this.form(bundle, annotations));
      versionId = toUuid(res.deployment_id);
    }
    // Every call, not only the first: if the first call's subdomain step failed after the script upload, the
    // Worker exists and the next call takes the version path; the POST is idempotent.
    await this.call('POST', `${script}/subdomain`, JSON.stringify({ enabled: true, previews_enabled: true }));
    return { versionId, url: `https://${versionId.slice(0, 8)}-${input.workerName}.${this.cfg.subdomain}.workers.dev` };
  }

  /**
   * Switch the Worker's live deployment (percentages must total 100; the API accepts
   * 0.01..100 per version). Not used by the ref-driven canary path; here for completeness.
   */
  async setDeployment(workerName: string, versions: DeploymentVersion[]): Promise<string> {
    const nameError = workerNameError(workerName);
    if (nameError) throw new Error(nameError);
    if (versions.length === 0 || versions.some((v) => !(v.percentage >= 0.01 && v.percentage <= 100))) {
      throw new Error('Each version needs a percentage between 0.01 and 100 (a 0% entry is rejected, code 10210)');
    }
    if (Math.abs(versions.reduce((n, v) => n + v.percentage, 0) - 100) > 1e-6) throw new Error('Version percentages must total 100');
    const body = JSON.stringify({
      strategy: 'percentage',
      versions: versions.map((v) => ({ version_id: v.versionId, percentage: v.percentage })),
    });
    const res = await this.call<{ id: string }>('POST', `/accounts/${this.cfg.accountId}/workers/scripts/${workerName}/deployments`, body);
    return res.id;
  }

  private form(bundle: CandidateBundle, annotations: Record<string, string>): FormData {
    if (bundle.compatibilityFlags?.some((f) => typeof f !== 'string' || !/^[a-z0-9_]+$/.test(f))) {
      throw new Error('Invalid compatibility flag in candidate bundle');
    }
    const metadata = {
      main_module: bundle.mainModule,
      compatibility_date: bundle.compatibilityDate,
      ...(bundle.compatibilityFlags ? { compatibility_flags: bundle.compatibilityFlags } : {}),
      bindings: bundle.bindings ?? [],
      annotations,
    };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    for (const m of bundle.modules) {
      form.append(m.name, new Blob([m.content], { type: m.contentType ?? 'application/javascript+module' }), m.name);
    }
    return form;
  }

  private async call<T>(method: string, path: string, body: FormData | string): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.cfg.apiToken}` };
    if (typeof body === 'string') headers['Content-Type'] = 'application/json';
    const res = await this.fetchFn(`${API_BASE}${path}`, { method, headers, body });
    const env = (await res.json().catch(() => ({}))) as CfEnvelope<T>;
    if (!res.ok || env.success === false || env.result === undefined) {
      const errors = env.errors ?? [];
      const detail = errors.map((e) => `${e.code}: ${e.message}`).join('; ') || 'no error body';
      const retry = res.status === 429 ? ` (rate limited, retry-after ${res.headers.get('Retry-After') ?? 'unknown'}s)` : '';
      throw new CfApiError(errors.map((e) => e.code), `Cloudflare API ${method} ${path} -> HTTP ${res.status}${retry}: ${detail}`);
    }
    return env.result;
  }
}

/** Cut to at most `maxBytes` UTF-8 bytes (the annotation limit is in bytes) without splitting a character. */
function truncateUtf8(s: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(s);
  return bytes.length <= maxBytes ? s : new TextDecoder().decode(bytes.slice(0, maxBytes)).replace(/�+$/, '');
}

function toUuid(id: unknown): string {
  if (typeof id !== 'string') throw new Error(`Unexpected version id from Cloudflare: ${String(id)}`);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return id;
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error(`Unexpected version id from Cloudflare: ${id}`);
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

/**
 * 'stub' only together with BEEHIVE_LOCAL_DEV=1 (set only by scripts/start-e2e-workers.sh), so a
 * production worker with WORKER_VERSIONS_MODE=stub set by mistake still gets null.
 * 'api' needs credentials, the workers.dev subdomain AND a bundle source; any missing piece
 * gives null, and the route answers 501 rather than reporting a version that was never built.
 * Unset (production default) is null.
 */
export function workerVersionsClientFor(
  env: {
    WORKER_VERSIONS_MODE?: string;
    BEEHIVE_LOCAL_DEV?: string;
    WORKERS_SUBDOMAIN?: string;
    CLOUDFLARE_ACCOUNT_ID?: string;
    CLOUDFLARE_API_TOKEN?: string;
  },
  bundle?: CandidateBundleSource
): WorkerVersionsClient | null {
  if (env.WORKER_VERSIONS_MODE === 'stub') {
    return env.BEEHIVE_LOCAL_DEV === '1' ? new StubWorkerVersionsClient(env.WORKERS_SUBDOMAIN) : null;
  }
  if (env.WORKER_VERSIONS_MODE === 'api') {
    const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken, WORKERS_SUBDOMAIN: subdomain } = env;
    return accountId && apiToken && subdomain && bundle ? new ApiWorkerVersionsClient({ accountId, apiToken, subdomain, bundle }) : null;
  }
  return null;
}
