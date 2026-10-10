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
    // echo carries a factual label so the bubble is not blank. Photos behave
    // the same: the server media identities are already finalized, so the
    // echo renders them through the private media route immediately.
    content_text: entry.text || (entry.mediaId ? 'Voice note' : entry.imageMediaIds?.length ? 'Photos' : ''),
    media_id: entry.mediaId ?? null,
    image_media_ids: entry.imageMediaIds ?? null,
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
  const ordered: ChatMessage[] = [...server];

  // Calculate highest known sequence among server messages and saved outbox entries
  let maxSeq = 0;
  for (const msg of server) {
    if (typeof msg.sequence === 'number' && msg.sequence > maxSeq) {
      maxSeq = msg.sequence;
    }
  }
  for (const entry of outbox) {
    if (typeof entry.sequence === 'number' && entry.sequence > maxSeq) {
      maxSeq = entry.sequence;
    }
  }

  let nextProjectedSeq = maxSeq + 1;

  for (const entry of outbox) {
    if (byClientId.has(entry.clientId)) continue;

    // Preserve acknowledged server sequence; otherwise project monotonically past maxSeq
    const seq = typeof entry.sequence === 'number' && entry.sequence > 0
      ? entry.sequence
      : nextProjectedSeq++;

    ordered.push(localMessage(entry, seq));

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

  // Strictly sort all messages: primary sequence ascending, then createdAt, then member before non-member, then stable ID
  ordered.sort((left, right) => {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
    const leftTime = new Date(left.created_at).getTime();
    const rightTime = new Date(right.created_at).getTime();
    if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime) && leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    if (left.author_kind === 'member' && right.author_kind !== 'member') return -1;
    if (left.author_kind !== 'member' && right.author_kind === 'member') return 1;
    return left.id.localeCompare(right.id);
  });

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
