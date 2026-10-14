/**
 * Queue bindings and message handling for the Beehive Promotion Worker
 * M3 Promotion Implementation
 */

import { PromotionRequest, Rung } from './types';

/**
 * Queue names used by the promotion worker
 */
export const QUEUE_NAMES = {
  PROMOTION_EVENTS: 'promotion-events',
  PROMOTION_RETRIES: 'promotion-retries',
  ROLLBACK_EVENTS: 'rollback-events',
} as const;

/**
 * Message types that can be processed by the promotion worker
 */
export type QueueMessageType = 
  | 'promote'
  | 'rollback'
  | 'retry'
  | 'cancel';

/**
 * Generic queue message wrapper
 */
export interface QueuePayload {
  type: QueueMessageType;
  data: unknown;
  timestamp: string;
  attempt?: number;
}

/**
 * Parse a queue message into a structured payload
 */
export function parseQueueMessage(message: { body: unknown }): QueuePayload {
  try {
    const body = typeof message.body === 'string' 
      ? JSON.parse(message.body) 
      : message.body;
    
    // Handle already parsed body
    if (body && typeof body === 'object' && 'type' in body && 'data' in body) {
      return body as QueuePayload;
    }
    
    // Legacy format - assume it's a PromotionRequest
    return {
      type: 'promote',
      data: body as PromotionRequest,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('Failed to parse queue message:', error);
    throw new Error('Invalid queue message format');
  }
}

/**
 * Create a promotion message for the queue
 */
export function createPromotionMessage(
  candidateId: string,
  specId: string,
  fromRung: Rung,
  toRung: Rung,
  actorId?: string
): QueuePayload {
  return {
    type: 'promote',
    data: {
      candidateId,
      specId,
      fromRung,
      toRung,
      actorId,
      timestamp: new Date().toISOString(),
    },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Helper to process a batch of messages with error handling
 */
export async function processMessageBatch(
  batch: MessageBatch<unknown>,
  handler: (message: { id: string; body: unknown; timestamp: number | Date }) => Promise<void>
): Promise<{ processed: number; failed: number; errors: Error[] }> {
  const errors: Error[] = [];
  let processed = 0;
  let failed = 0;
  
  for (const message of batch.messages) {
    try {
      const timestamp = typeof message.timestamp === 'number' 
        ? message.timestamp 
        : message.timestamp.getTime();
      await handler({ ...message, timestamp });
      processed++;
    } catch (error) {
      failed++;
      errors.push(error instanceof Error ? error : new Error(String(error)));
      console.error(`Failed to process message ${message.id}:`, error);
    }
  }
  
  return { processed, failed, errors };
}
