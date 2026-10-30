/**
 * Beehive Queue Consumer Worker
 *
 * Consumes push events from Cloudflare Artifacts Queue and triggers
 * the Pre-merge Gate Workflow for candidate repositories.
 *
 * This is the M1 event-driven integration - hand-written, not agent-generated.
 */

import { z } from 'zod';
import type { CandidateResponse } from '../api/types';
import { authGate } from '../shared/auth';
import { getSpecDoStub, type SpecDoStub } from '../shared/spec-do-auth';

export interface Queue {
  send: (message: any) => Promise<void>;
}

interface Env {
  SPEC_DO: DurableObjectNamespace;
  // Tier-1 secret for Spec DO calls (workers/shared/spec-do-auth.ts); no admin token on this worker
  SPEC_DO_INTERNAL_TOKEN?: string;
  GATE_WORKFLOW: Service;
  PREVIEW_MANAGER: Service;
  API_AUTH_TOKEN?: string;
  preview_artifacts_push?: Queue;
  preview_artifacts_events?: Queue;
}

// Zod schemas for queue message validation
const ArtifactsPushEventSchema = z.object({
  id: z.string().min(1),
  type: z.literal('push'),
  repository: z.object({
    name: z.string().min(1),
    namespace: z.string().min(1),
    full_name: z.string().min(1),
  }),
  commit: z.object({
    sha: z.string().min(1),
    message: z.string().optional(),
    author: z.object({
      name: z.string().optional(),
      email: z.string().optional(),
    }).optional(),
    timestamp: z.string().optional(),
  }),
  ref: z.string().min(1),
  base_ref: z.string().optional(),
  created_at: z.string(),
});

const QueueMessageSchema = z.object({
  event: ArtifactsPushEventSchema,
  received_at: z.number().int().positive(),
});

interface ArtifactsPushEvent {
  id: string;
  type: 'push';
  repository: {
    name: string;
    namespace: string;
    full_name: string;
  };
  commit: {
    sha: string;
    message?: string;
    author?: {
      name?: string;
      email?: string;
    };
    timestamp?: string;
  };
  ref: string;
  base_ref?: string;
  created_at: string;
}

interface QueueMessage {
  event: ArtifactsPushEvent;
  received_at: number;
}

/**
 * Validate and parse a queue message
 * This prevents field name mismatches and missing field errors
 */
class ValidationError extends Error {}

function validateQueueMessage(message: unknown): QueueMessage {
  const result = QueueMessageSchema.safeParse(message);
  if (!result.success) {
    const errors = result.error.issues.map((issue) => {
      const path = issue.path.join('.');
      return `${path}: ${issue.message}`;
    });
    throw new ValidationError(`Queue message validation failed: ${errors.join('; ')}`);
  }
  return result.data;
}

const DEFAULT_SPEC_DO_NAME = 'main';

// Schema for Preview Manager deploy request
const PreviewManagerDeployRequestSchema = z.object({
  candidateId: z.string().uuid(),
  repository: z.object({
    name: z.string().min(1),
    namespace: z.string().min(1),
    full_name: z.string().min(1),
  }),
  commit: z.object({
    sha: z.string().min(1),
    message: z.string().optional(),
    author: z.object({
      name: z.string().optional(),
      email: z.string().optional(),
    }).optional(),
    timestamp: z.string().optional(),
  }),
  commitSha: z.string().min(1),
  baseCommitSha: z.string().optional(),
  timestamp: z.number().int().positive(),
});

/**
 * Triggers preview deployment for candidate code via Preview Manager service
 */
async function triggerPreviewDeployment(event: ArtifactsPushEvent, env: Env, specDoStub: SpecDoStub): Promise<void> {
  console.log(`[QueueConsumer] Triggering preview deployment for ${event.repository.full_name}@${event.commit.sha}`);

  // First, fetch all repositories to find the one matching the event
  const reposResp = await specDoStub.fetch(
    new Request(`https://spec-do.internal/api/repositories?limit=100`, {
      headers: { 'X-Actor-ID': 'queue-consumer' },
    })
  );

  if (!reposResp.ok) {
    console.error(`[QueueConsumer] Failed to fetch repositories: ${reposResp.status}`);
    return;
  }

  const reposData = await reposResp.json() as { data?: any[] };
  const repositories = reposData.data || [];

  // Find the repository by remote_url
  const repo = repositories.find((r: any) => r.remote_url === event.repository.full_name);

  if (!repo) {
    console.log(`[QueueConsumer] No repository found for ${event.repository.full_name}, skipping`);
    return;
  }

  // Now fetch candidates and find the one with matching repository_id
  const candidatesResp = await specDoStub.fetch(
    new Request(`https://spec-do.internal/api/candidates?limit=100`, {
      headers: { 'X-Actor-ID': 'queue-consumer' },
    })
  );

  if (!candidatesResp.ok) {
    console.error(`[QueueConsumer] Failed to fetch candidates for preview: ${candidatesResp.status}`);
    return;
  }

  const candidatesData = await candidatesResp.json() as { data?: any[] };
  const candidates = candidatesData.data || [];

  const candidate = candidates.find((c: any) => c.repositoryId === repo.id || c.repository_id === repo.id);

  if (!candidate) {
    console.log(`[QueueConsumer] No candidate found for repository ${repo.id} (${event.repository.full_name}), skipping`);
    return;
  }

  // Call Preview Manager service to trigger preview deployment
  // The Preview Manager will handle the Workers Builds API calls and Spec DO updates
  try {
    const previewManagerResponse = await env.PREVIEW_MANAGER.fetch(
      new Request(`https://preview-manager.internal/api/preview/deploy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Actor-ID': 'queue-consumer',
          'Authorization': `Bearer ${env.API_AUTH_TOKEN || ''}`,
        },
        body: JSON.stringify({
          candidateId: candidate.id,
          repository: event.repository,
          commit: event.commit,
          commitSha: event.commit.sha,
          baseCommitSha: event.base_ref || (candidate.baseCommitSha || candidate.base_commit_sha),
          timestamp: Date.now(),
        }),
      })
    );

    if (!previewManagerResponse.ok) {
      const errorText = await previewManagerResponse.text();
      console.error(`[QueueConsumer] Preview Manager returned error: ${previewManagerResponse.status} - ${errorText}`);
      return;
    }

    const result = await previewManagerResponse.json();
    console.log(`[QueueConsumer] Preview deployment triggered via Preview Manager: ${JSON.stringify(result)}`);
  } catch (error) {
    console.error(`[QueueConsumer] Failed to call Preview Manager:`, error);
    return;
  }

  console.log(`[QueueConsumer] Preview deployment triggered for candidate ${candidate.id}`);
}

/** Delivery attempts after which a transient failure is given up (matches max_retries = 4 in wrangler.toml). */
const MAX_ATTEMPTS = 5;
const MAX_BACKOFF_SECONDS = 900;
const IN_FLIGHT_RETRY_SECONDS = 10;
const CONFIG_RETRY_SECONDS = 3600;
// The Spec DO rejects Idempotency-Key values over 255 characters; the gate key adds ':gate'
const MAX_BASE_KEY_CHARS = 200;

type Outcome =
  | { kind: 'done' }
  // Retry later (bounded by MAX_ATTEMPTS): the failure may clear by itself
  | { kind: 'transient'; reason: string; delaySeconds?: number }
  // Retrying cannot help: log at error level and ack
  | { kind: 'permanent'; reason: string };

/** 5xx, 408, 429 and 401/403 (token misconfiguration, recoverable) are worth retrying; other 4xx are not. */
function classifyStatus(status: number): 'transient' | 'permanent' {
  return status >= 500 || status === 408 || status === 429 || status === 401 || status === 403
    ? 'transient'
    : 'permanent';
}

function backoffSeconds(attempts: number): number {
  return Math.min(30 * 2 ** (attempts - 1), MAX_BACKOFF_SECONDS);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Base idempotency key for one queue event; hashed when long so key + ':gate' stays under 255 characters. */
async function eventKey(queueName: string, eventId: string): Promise<string> {
  const raw = `${queueName}:${eventId}`;
  return raw.length <= MAX_BASE_KEY_CHARS ? raw : `h1:${await sha256Hex(raw)}`;
}

/**
 * Processes one push event. Queue delivery is at-least-once, so every step is safe to repeat: the gate
 * start and the history write both carry an Idempotency-Key derived from the event id.
 */
async function processMessage(
  message: Message<QueueMessage>,
  attempts: number,
  queueName: string,
  env: Env,
  specDoStub: SpecDoStub
): Promise<Outcome> {
  const isPreviewPush = queueName === 'preview-artifacts-push';
  const isPreviewEvents = queueName === 'preview-artifacts-events';

  // Validate and parse queue message with Zod (a ValidationError is permanent)
  const msg = validateQueueMessage(message.body);
  const event = msg.event;

  console.log(`[QueueConsumer] [${queueName}] Received push event: ${event.id} for ${event.repository.full_name}@${event.commit.sha}`);

  // Preview deployment is best effort and has no idempotency key: run it on the first delivery only,
  // so a retry of the gate or history step does not start a second build.
  if (isPreviewPush && attempts === 1) {
    try {
      await triggerPreviewDeployment(event, env, specDoStub);
    } catch (error) {
      console.error(`[QueueConsumer] Preview deployment failed for ${event.id} (best effort, not retried):`, error);
    }
  }

  if (isPreviewEvents || queueName === 'beehive-artifacts-events') {
    console.log(`[QueueConsumer] Handling artifacts event from ${queueName}`);
    // Events are processed similarly, just logged with queue context
  }

  // Find candidate by repository URL from Spec DO. A missing row is transient: the push can arrive
  // before the repository or candidate is written. (Lookups cover the first 100 rows only.)
  const reposResp = await specDoStub.fetch(
    new Request(`https://spec-do.internal/api/repositories?limit=100`, {
      headers: { 'X-Actor-ID': 'queue-consumer' },
    })
  );
  if (!reposResp.ok) {
    return { kind: classifyStatus(reposResp.status), reason: `repositories lookup answered ${reposResp.status}` };
  }
  const reposData = await reposResp.json() as { data?: any[] };
  const repo = (reposData.data || []).find((r: any) => r.remote_url === event.repository.full_name);
  if (!repo) {
    return { kind: 'transient', reason: `no repository found for ${event.repository.full_name}` };
  }

  const candidatesResp = await specDoStub.fetch(
    new Request(`https://spec-do.internal/api/candidates?limit=100`, {
      headers: { 'X-Actor-ID': 'queue-consumer' },
    })
  );
  if (!candidatesResp.ok) {
    return { kind: classifyStatus(candidatesResp.status), reason: `candidates lookup answered ${candidatesResp.status}` };
  }
  const candidatesData = await candidatesResp.json() as { data?: any[] };
  const candidate = (candidatesData.data || []).find((c: any) => c.repositoryId === repo.id || c.repository_id === repo.id);
  if (!candidate) {
    return { kind: 'transient', reason: `no candidate found for repo ${repo.id} (${event.repository.full_name})` };
  }

  console.log(`[QueueConsumer] Found candidate ${candidate.id} for push event`);

  // Fail-closed: do not trigger the gate without API_AUTH_TOKEN. Recoverable configuration, so retry slowly.
  if (!env.API_AUTH_TOKEN) {
    return { kind: 'transient', reason: 'API_AUTH_TOKEN not configured', delaySeconds: CONFIG_RETRY_SECONDS };
  }

  const baseKey = await eventKey(queueName, event.id);

  // Trigger pre-merge gate workflow via service binding; the gate dedupes a repeat of this key
  const gateResponse = await env.GATE_WORKFLOW.fetch(
    new Request(`http://beehive-gate-workflow/gates/pre-merge`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.API_AUTH_TOKEN}`,
        'X-Actor-ID': 'queue-consumer',
        'Idempotency-Key': `${baseKey}:gate`,
      },
      body: JSON.stringify({
        candidateId: candidate.id,
        specId: candidate.specId || candidate.spec_id,
        commitSha: event.commit.sha,
        baseCommitSha: event.base_ref ? event.commit.sha : (candidate.baseCommitSha || candidate.base_commit_sha),
        actorId: 'queue-consumer',
      }),
    })
  );

  if (!gateResponse.ok) {
    if (gateResponse.status === 409) {
      const body = await gateResponse.clone().json().catch(() => null) as { inFlight?: boolean } | null;
      if (body?.inFlight) {
        return { kind: 'transient', reason: 'gate run for this event is still in flight', delaySeconds: IN_FLIGHT_RETRY_SECONDS };
      }
    }
    return { kind: classifyStatus(gateResponse.status), reason: `gate workflow answered ${gateResponse.status}` };
  }

  // A gate replay (200 + Idempotent-Replay) parses the same as a fresh run (201)
  const result = await gateResponse.json();
  console.log(`[QueueConsumer] Gate workflow triggered: ${JSON.stringify(result)}`);

  // Record event in Spec DO history (a redelivery replays the stored response)
  const historyResp = await specDoStub.fetch(
    new Request(`https://spec-do.internal/api/entities/candidate/${candidate.id}/history`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Actor-ID': 'queue-consumer',
        'Idempotency-Key': baseKey,
      },
      body: JSON.stringify({
        stage: 'push_received',
        notes: `Artifacts push event: ${event.commit.sha}`,
        metadata: JSON.stringify(event),
      }),
    })
  );
  if (!historyResp.ok) {
    if (historyResp.status === 409) {
      // Same key, different body: not "already processed" (a true replay answers 201 + Idempotent-Replay)
      return { kind: 'permanent', reason: `history idempotency key ${baseKey} reused with a different body` };
    }
    return { kind: classifyStatus(historyResp.status), reason: `history write answered ${historyResp.status}` };
  }

  console.log(`[QueueConsumer] Processed push event ${event.id} successfully`);
  return { kind: 'done' };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Auth gate - fail closed, applies to every route including /health
    const denied = await authGate(request, env);
    if (denied) return denied;

    const url = new URL(request.url);
    const path = url.pathname;

    // Health check
    if (path === '/health' || path === '/queue/health') {
      return new Response(JSON.stringify({ status: 'healthy', timestamp: Date.now() }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  },

  async queue(batch: MessageBatch<QueueMessage>, env: Env, ctx: ExecutionContext): Promise<void> {
    // Get Spec DO stub for persistence
    const specDoStub = getSpecDoStub(env, DEFAULT_SPEC_DO_NAME);
    const queueName = batch.queue;

    // Per-message handling must stay inside this loop: a throw out of queue() would retry the whole batch,
    // including messages that already succeeded. A normal return acks every message not retried below.
    for (const message of batch.messages) {
      const attempts = message.attempts ?? 1;
      let outcome: Outcome;
      try {
        outcome = await processMessage(message, attempts, queueName, env, specDoStub);
      } catch (error) {
        outcome = error instanceof ValidationError
          ? { kind: 'permanent', reason: error.message }
          : { kind: 'transient', reason: `unexpected error: ${(error as Error)?.message ?? String(error)}` };
      }

      if (outcome.kind === 'done') continue;
      if (outcome.kind === 'permanent') {
        console.error(`[QueueConsumer] Dropping message ${message.id} (permanent): ${outcome.reason}`);
        continue;
      }
      if (attempts >= MAX_ATTEMPTS) {
        console.error(`[QueueConsumer] Giving up on message ${message.id} after ${attempts} attempts: ${outcome.reason}`);
        continue;
      }
      console.warn(`[QueueConsumer] Retrying message ${message.id} (attempt ${attempts}): ${outcome.reason}`);
      message.retry({ delaySeconds: outcome.delaySeconds ?? backoffSeconds(attempts) });
    }
  },
} satisfies ExportedHandler<Env>;

type ExportedHandler<E = unknown> = {
  fetch: (request: Request, env: E, ctx: ExecutionContext) => Promise<Response>;
  queue: (batch: MessageBatch<QueueMessage>, env: E, ctx: ExecutionContext) => Promise<void>;
};
