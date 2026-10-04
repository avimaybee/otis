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
  const runData = await Promise.all(runIds.map(id => api.run(workspaceId, id)));
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
