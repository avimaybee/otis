/**
 * Chat snapshot: one query per (user, workspace, chat) holding the server
 * snapshot plus pure updaters. Stream events patch this snapshot with
 * `setQueryData`; only resync and targeted run/message refreshes refetch.
 */

import { useQuery } from '@tanstack/react-query';
import type {
  ChatDetailResponse,
  ChatMessage,
  ClarificationSummary,
  PublicActivity,
  RunDetailResponse,
} from '@otis/contracts';
import { api } from './client.js';
import { mergeActivity } from '../hooks/useActivityStream.js';
import { qk } from './queries.js';

export interface ChatSnapshot {
  detail: ChatDetailResponse;
  messages: ChatMessage[];
  older: number | null;
  runs: Record<string, RunDetailResponse>;
  activities: PublicActivity[];
  questions: ClarificationSummary[];
  cursor: number;
}

export function mergeMessages(previous: ChatMessage[], next: ChatMessage[]): ChatMessage[] {
  return [...new Map([...previous, ...next].map(message => [message.id, message])).values()]
    .sort((left, right) => left.sequence - right.sequence);
}

export async function fetchChatSnapshot(workspaceId: string, chatId: string): Promise<ChatSnapshot> {
  const [detail, page, firstActivity, questions] = await Promise.all([
    api.getChat(workspaceId, chatId),
    api.listMessages(workspaceId, chatId),
    api.activity(workspaceId, chatId, 0),
    api.clarifications(workspaceId, chatId),
  ]);
  const runIds = [...new Set(page.messages.flatMap(message => (message.run_id ? [message.run_id] : [])))];
  // One batched roundtrip instead of one request per run; unknown ids are
  // omitted server-side, mirroring the previous per-run settled behavior.
  const runData = runIds.length > 0 ? (await api.runs(workspaceId, runIds)).runs : [];
  const activities = [...new Map(
    [...firstActivity.activities, ...runData.flatMap(run => run.activities)].map(activity => [activity.id, activity]),
  ).values()].sort((left, right) => left.cursor - right.cursor);
  return {
    detail,
    messages: mergeMessages([], page.messages),
    older: page.next_before_sequence,
    runs: Object.fromEntries(runData.map(run => [run.run.id, run])),
    activities,
    questions: questions.clarifications,
    cursor: firstActivity.latest_cursor,
  };
}

export function useChatSnapshot(userId: string, workspaceId: string, chatId: string | null, disabled: boolean) {
  return useQuery({
    queryKey: chatId ? qk.chat(userId, workspaceId, chatId) : ['otis', userId, workspaceId, 'chat', 'none'],
    queryFn: () => fetchChatSnapshot(workspaceId, chatId!),
    enabled: chatId !== null && !disabled,
  });
}

export function applyActivitySnapshot(snapshot: ChatSnapshot, activity: PublicActivity): ChatSnapshot {
  return {
    ...snapshot,
    activities: mergeActivity(snapshot.activities, activity),
    cursor: Math.max(snapshot.cursor, activity.cursor),
  };
}

export function applyRunSnapshot(snapshot: ChatSnapshot, run: RunDetailResponse): ChatSnapshot {
  return {
    ...snapshot,
    runs: { ...snapshot.runs, [run.run.id]: run },
    activities: run.activities.reduce(mergeActivity, snapshot.activities),
    cursor: Math.max(snapshot.cursor, ...run.activities.map(activity => activity.cursor), snapshot.cursor),
  };
}

export function applyLatestMessages(snapshot: ChatSnapshot, messages: ChatMessage[]): ChatSnapshot {
  return { ...snapshot, messages: mergeMessages(snapshot.messages, messages) };
}

/**
 * Files a committed reply locally from its answer_saved event, without a
 * messages refetch. Returns null when the payload lacks committed message
 * data (older shapes, truncated text) so the caller falls back to refetch.
 */
export function applyAnswerSaved(snapshot: ChatSnapshot, activity: PublicActivity): ChatSnapshot | null {
  const payload = activity.payload as {
    message_id?: unknown; sequence?: unknown; text?: unknown; text_truncated?: unknown; channel?: unknown;
  } | null;
  if (
    !payload
    || typeof payload.message_id !== 'string'
    || typeof payload.sequence !== 'number'
    || !Number.isInteger(payload.sequence)
    || typeof payload.text !== 'string'
    || payload.text_truncated === true
  ) {
    return null;
  }
  const channel = payload.channel === 'web' || payload.channel === 'telegram' || payload.channel === 'system'
    ? payload.channel
    : 'web';
  const message: ChatMessage = {
    id: payload.message_id,
    workspace_id: activity.workspace_id,
    chat_id: activity.chat_id,
    author_user_id: null,
    author_kind: 'system',
    channel,
    inbound_message_id: null,
    client_message_id: null,
    content_text: payload.text,
    media_id: null,
    run_id: activity.run_id,
    sequence: payload.sequence,
    created_at: activity.created_at,
    updated_at: activity.created_at,
  };
  return { ...snapshot, messages: mergeMessages(snapshot.messages, [message]) };
}

/**
 * Files an accepted outgoing message locally from the acceptance receipt,
 * without a transcript refetch. The server row carries the same client UUID,
 * so reconciliation replaces the local echo instead of duplicating it.
 */
export function applyAcceptedMessage(
  snapshot: ChatSnapshot,
  message: {
    id: string;
    workspace_id: string;
    chat_id: string;
    author_user_id: string;
    client_message_id: string;
    content_text: string;
    media_id: string | null;
    image_media_ids?: string[] | null;
    run_id: string;
    sequence: number;
    created_at: string;
  },
): ChatSnapshot {
  const row: ChatMessage = {
    ...message,
    image_media_ids: message.image_media_ids ?? null,
    author_display_name: null,
    author_kind: 'member',
    channel: 'web',
    inbound_message_id: null,
    updated_at: message.created_at,
  };
  return { ...snapshot, messages: mergeMessages(snapshot.messages, [row]) };
}

export function applyOlderMessages(
  snapshot: ChatSnapshot,
  messages: ChatMessage[],
  older: number | null,
): ChatSnapshot {
  return { ...snapshot, messages: mergeMessages(messages, snapshot.messages), older };
}

export function applyQuestions(snapshot: ChatSnapshot, questions: ClarificationSummary[]): ChatSnapshot {
  return { ...snapshot, questions };
}

export function applyDetail(snapshot: ChatSnapshot, detail: ChatDetailResponse): ChatSnapshot {
  return { ...snapshot, detail };
}
