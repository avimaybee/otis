/**
 * One reconciliation function deriving the visible transcript.
 *
 * Worker/D1 own accepted messages; the outbox owns unsent/local delivery
 * state; this module merges them. Server records carrying a known client UUID
 * replace their local bubble under a stable React key (client_message_id),
 * so HTTP acceptance, activity replay and snapshots may arrive in any order
 * without appending a duplicate bubble.
 */

import type { ChatMessage } from '@otis/contracts';
import type { OutboxEntry } from './outbox.js';

export type MessageDelivery = 'server' | 'sending' | 'saved' | 'failed';

export interface DerivedTranscript {
  messages: ChatMessage[];
  /** Delivery state by client UUID for bubbles that are not plain server rows. */
  delivery: Record<string, { state: Exclude<MessageDelivery, 'server'>; error?: string; durable: boolean }>;
}

function localMessage(entry: OutboxEntry, sequence: number): ChatMessage {
  return {
    id: `local:${entry.clientId}`,
    workspace_id: entry.workspaceId,
    chat_id: entry.chatId ?? '',
    author_user_id: entry.userId,
    author_display_name: null,
    author_kind: 'member',
    channel: 'web',
    inbound_message_id: null,
    client_message_id: entry.clientId,
    // A voice note has no typed text until the transcript commits; the local
    // echo carries a factual label so the bubble is not blank.
    content_text: entry.text || (entry.mediaId ? 'Voice note' : ''),
    media_id: entry.mediaId ?? null,
    run_id: entry.runId ?? null,
    sequence,
    created_at: entry.createdAt,
    updated_at: entry.createdAt,
  };
}

export function deriveTranscript(server: ChatMessage[], outbox: OutboxEntry[], durable: boolean): DerivedTranscript {
  const byClientId = new Map<string, ChatMessage>();
  for (const message of server) {
    if (message.client_message_id) byClientId.set(message.client_message_id, message);
  }
  const delivery: DerivedTranscript['delivery'] = {};
  const ordered = [...server].sort((left, right) => left.sequence - right.sequence);
  let sequence = ordered.length > 0 ? ordered[ordered.length - 1]!.sequence + 1 : 1;
  for (const entry of outbox) {
    if (byClientId.has(entry.clientId)) continue;
    ordered.push(localMessage(entry, sequence));
    sequence += 1;
    if (entry.state !== 'saved') {
      delivery[entry.clientId] = {
        state: entry.state,
        ...(entry.errorMessage ? { error: entry.errorMessage } : {}),
        durable,
      };
    } else {
      // Accepted by the server but the authoritative row has not arrived yet.
      delivery[entry.clientId] = { state: 'saved', durable };
    }
  }
  return { messages: ordered, delivery };
}

/** Client UUIDs the server has durably recorded, for outbox pruning. */
export function reconciledClientIds(server: ChatMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of server) {
    if (message.client_message_id) ids.add(message.client_message_id);
  }
  return ids;
}
