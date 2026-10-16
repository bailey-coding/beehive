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
function validateQueueMessage(message: unknown): QueueMessage {
  const result = QueueMessageSchema.safeParse(message);
  if (!result.success) {
    const errors = result.error.issues.map((issue) => {
      const path = issue.path.join('.');
      return `${path}: ${issue.message}`;
    });
    throw new Error(`Queue message validation failed: ${errors.join('; ')}`);
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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Auth gate - fail closed, applies to every route including /health
    const denied = authGate(request, env);
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

    // Determine which queue this batch came from
    const queueName = batch.queue;
    const isPreviewPush = queueName === 'preview-artifacts-push';
    const isPreviewEvents = queueName === 'preview-artifacts-events';
    const isProductionPush = queueName === 'beehive-artifacts-push';

    for (const message of batch.messages) {
      try {
        // Validate and parse queue message with Zod
        const msg = validateQueueMessage(message.body);
        const event = msg.event;

        // Log receipt with queue context
        console.log(`[QueueConsumer] [${queueName}] Received push event: ${event.id} for ${event.repository.full_name}@${event.commit.sha}`);

        // Handle preview deployment for preview push queue
        if (isPreviewPush) {
          await triggerPreviewDeployment(event, env, specDoStub);
        }

        // Handle artifacts events (both production and preview)
        if (isPreviewEvents || queueName === 'beehive-artifacts-events') {
          console.log(`[QueueConsumer] Handling artifacts event from ${queueName}`);
          // Events are processed similarly, just logged with queue context
        }

        // Find candidate by repository URL from Spec DO
        // First fetch repositories to find matching repo_id
        const reposResp = await specDoStub.fetch(
          new Request(`https://spec-do.internal/api/repositories?limit=100`, {
            headers: { 'X-Actor-ID': 'queue-consumer' },
          })
        );

        if (!reposResp.ok) {
          console.error(`[QueueConsumer] Failed to fetch repositories: ${reposResp.status}`);
          continue;
        }

        const reposData = await reposResp.json() as { data?: any[] };
        const repositories = reposData.data || [];
        const repo = repositories.find((r: any) => r.remote_url === event.repository.full_name);

        if (!repo) {
          console.log(`[QueueConsumer] No repository found for ${event.repository.full_name}, skipping`);
          continue;
        }

        // Now fetch candidates and find matching repository_id
        const candidatesResp = await specDoStub.fetch(
          new Request(`https://spec-do.internal/api/candidates?limit=100`, {
            headers: { 'X-Actor-ID': 'queue-consumer' },
          })
        );

        if (!candidatesResp.ok) {
          console.error(`[QueueConsumer] Failed to fetch candidates: ${candidatesResp.status}`);
          continue;
        }

        const candidatesData = await candidatesResp.json() as { data?: any[] };
        const candidates = candidatesData.data || [];

        // Find the candidate whose repository_id matches the repo
        const candidate = candidates.find((c: any) => c.repositoryId === repo.id || c.repository_id === repo.id);

        if (!candidate) {
          console.log(`[QueueConsumer] No candidate found for repo ${repo.id} (${event.repository.full_name}), skipping`);
          continue;
        }

        console.log(`[QueueConsumer] Found candidate ${candidate.id} for push event`);

        // Fail-closed: skip gate trigger if API_AUTH_TOKEN is not configured
        if (!env.API_AUTH_TOKEN) {
          console.error('[QueueConsumer] API_AUTH_TOKEN not configured; not triggering gate');
          continue;
        }

        // Trigger pre-merge gate workflow via service binding
        const gateResponse = await env.GATE_WORKFLOW.fetch(
          new Request(`http://beehive-gate-workflow/gates/pre-merge`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${env.API_AUTH_TOKEN}`,
              'X-Actor-ID': 'queue-consumer',
            },
            body: JSON.stringify({
              candidateId: candidate.id,
              specId: candidate.specId || candidate.spec_id,
              commitSha: event.commit.sha,
              baseCommitSha: event.base_ref ? event.commit.sha : (candidate.baseCommitSha || candidate.base_commit_sha),
              actorId: 'queue-consumer',
              namespace: event.repository.namespace,
              repoName: event.repository.name,
            }),
          })
        );

        if (!gateResponse.ok) {
          console.error(`[QueueConsumer] Failed to trigger gate workflow: ${gateResponse.status}`);
          continue;
        }

        const result = await gateResponse.json();
        console.log(`[QueueConsumer] Gate workflow triggered: ${JSON.stringify(result)}`);

        // Record event in Spec DO history
        await specDoStub.fetch(
          new Request(`https://spec-do.internal/api/entities/candidate/${candidate.id}/history`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Actor-ID': 'queue-consumer',
            },
            body: JSON.stringify({
              stage: 'push_received',
              notes: `Artifacts push event: ${event.commit.sha}`,
              metadata: JSON.stringify(event),
            }),
          })
        );

        console.log(`[QueueConsumer] Processed push event ${event.id} successfully`);

      } catch (error) {
        console.error(`[QueueConsumer] Error processing message ${message.id}:`, error);
      }
    }
  },
} satisfies ExportedHandler<Env>;

type ExportedHandler<E = unknown> = {
  fetch: (request: Request, env: E, ctx: ExecutionContext) => Promise<Response>;
  queue: (batch: MessageBatch<QueueMessage>, env: E, ctx: ExecutionContext) => Promise<void>;
};
