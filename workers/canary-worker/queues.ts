import type { Env, RollbackTrigger } from './types';
import type { MessageBatch, ExecutionContext, Message } from '@cloudflare/workers-types';
import { RollbackManager } from './rollback';

/**
 * Queue handler for canary rollback triggers
 * Processes messages from the canary-rollback-triggers queue
 */
export async function handleRollbackQueue(
  batch: MessageBatch,
  env: Env,
  ctx?: ExecutionContext
): Promise<void> {
  const rollback = new RollbackManager(env);
  
  for (const message of batch.messages) {
    try {
      const body = JSON.parse(String(message.body)) as RollbackTrigger;
      await rollback.processQueueMessage(message);
    } catch (error) {
      console.error('Failed to process rollback queue message:', error);
    }
  }
}
