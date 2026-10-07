/**
 * Chat snapshot: one query per (user, workspace, chat) holding the server
 * snapshot plus pure updaters. Stream events patch this snapshot with
 * `setQueryData`; only resync and targeted run/message refreshes refetch.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  ChatDetailResponse,
  ChatMessage,
  ClarificationSummary,
  PublicActivity,
  RunDetailResponse,
} from '@otis/contracts';
import { api, ApiError } from './client.js';
import { debugLog } from './log.js';
import { mergeActivity } from '../hooks/useActivityStream.js';
import { qk } from './queries.js';

export interface ChatSnapshot {
  detail: ChatDetailResponse;
  messages: ChatMessage[];
  older: number | null;
  runs: Record<string, RunDetailResponse>;
  activities: PublicActivity[];
  questions: ClarificationSummary[];
  /**
   * True when the question-list read failed while run details survived: the
   * empty list is an outage, not an authoritative "no questions". The UI
   * keeps the run-known answer path usable and offers an explicit retry.
   */
  questionsFailed: boolean;
  cursor: number;
}

/**
 * Authorization failures are never optional metadata: a 401 means the session
 * is dead and a 403 means this workspace stopped serving the member, so both
 * must reach the query-error recovery path. Every other secondary failure
 * degrades to empty metadata that live events repair.
 */
function isAuthFailure(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

export function mergeMessages(previous: ChatMessage[], next: ChatMessage[]): ChatMessage[] {
  return [...new Map([...previous, ...next].map(message => [message.id, message])).values()]
    .sort((left, right) => left.sequence - right.sequence);
}

/** Primary transcript: detail + messages only. Enough to paint the
 * conversation, unlock the composer and resolve read-only state. */
export interface ChatPrimary {
  detail: ChatDetailResponse;
  messages: ChatMessage[];
  older: number | null;
}

/**
 * Reads the primary transcript. Either read may abort on navigation; both
 * must succeed or there is nothing truthful to paint.
 */
export async function fetchChatPrimary(
  workspaceId: string,
  chatId: string,
  signal?: AbortSignal,
): Promise<ChatPrimary> {
  const [detail, page] = await Promise.all([
    api.getChat(workspaceId, chatId, signal),
    api.listMessages(workspaceId, chatId, null, signal),
  ]);
  return {
    detail,
    messages: mergeMessages([], page.messages),
    older: page.next_before_sequence,
  };
}

export async function fetchChatSnapshot(
  workspaceId: string,
  chatId: string,
  signal?: AbortSignal,
  onPrimary?: (primary: ChatPrimary) => void,
): Promise<ChatSnapshot> {
  // Independent reads start together: the primary transcript (detail +
  // messages) and the secondary metadata (activity + questions) no longer
  // waterfall. The primary still paints through the caller's local state the
  // moment its two reads resolve, without waiting for metadata; runs fetch
  // as soon as message IDs are known without waiting for metadata either.
  // Nothing here touches the query cache: cache writes stay exclusively with
  // the single TanStack return below plus the existing live updaters
  // (acceptance, activity, refresh), so a late or aborted primary can never
  // overwrite live-patched cache state the way a seeded write could.
  const primaryPromise = fetchChatPrimary(workspaceId, chatId, signal);
  const activityPromise = api.activity(workspaceId, chatId, 0, signal);
  const questionsPromise = api.clarifications(workspaceId, chatId, signal);
  let primary: ChatPrimary;
  try {
    primary = await primaryPromise;
  } catch (err) {
    // The primary sinks the snapshot, but the already-issued secondary reads
    // must still settle to avoid floating unhandled rejections.
    await Promise.allSettled([activityPromise, questionsPromise]);
    throw err;
  }
  // Navigation wins before painting: an abort landing while secondary work
  // is outstanding propagates without painting a chat the user already left.
  if (signal?.aborted) throw signal.reason;
  onPrimary?.(primary);
  // Secondary metadata degrades truthfully: activity, questions and run
  // details fill when available, and a failure leaves the transcript with
  // empty metadata instead of sinking the whole snapshot. Live events and
  // targeted refreshes repair the gaps. Only the primary is load-bearing.
  const [activitySettled, questionsSettled] = await Promise.allSettled([activityPromise, questionsPromise]);
  // Navigation wins over degradation: an aborted fetch propagates so
  // TanStack keeps whatever the cache already holds.
  if (signal?.aborted) throw signal.reason;
  // Authorization failures propagate to the session/workspace recovery path;
  // ordinary metadata outages degrade to empty lists live events repair.
  for (const settled of [activitySettled, questionsSettled]) {
    if (settled.status === 'rejected' && isAuthFailure(settled.reason)) throw settled.reason;
  }
  const firstActivity = activitySettled.status === 'fulfilled'
    ? activitySettled.value
    : { activities: [] as PublicActivity[], latest_cursor: 0 };
  const questions = questionsSettled.status === 'fulfilled'
    ? questionsSettled.value
    : { clarifications: [] as ClarificationSummary[] };
  const questionsFailed = questionsSettled.status === 'rejected';
  if (activitySettled.status === 'rejected' || questionsSettled.status === 'rejected') {
    debugLog('chat', 'secondary snapshot metadata unavailable; rendering transcript without it', {
      chatId,
      activity: activitySettled.status,
      questions: questionsSettled.status,
    });
  }
  const runIds = [...new Set(primary.messages.flatMap(message => (message.run_id ? [message.run_id] : [])))];
  // One batched roundtrip instead of one request per run; unknown ids are
  // omitted server-side, mirroring the previous per-run settled behavior.
  // A batch failure must never sink the whole snapshot: render messages and
  // activities without run details, and let live events repair active runs.
  let runData: RunDetailResponse[] = [];
  if (runIds.length > 0) {
    try {
      runData = (await api.runs(workspaceId, runIds, signal)).runs;
    } catch (err) {
      if (signal?.aborted) throw err;
      if (isAuthFailure(err)) throw err;
      debugLog('chat', 'batched run details unavailable; rendering without them', {
        chatId, status: err instanceof ApiError ? err.status : null,
      });
    }
  }
  const activities = [...new Map(
    [...firstActivity.activities, ...runData.flatMap(run => run.activities)].map(activity => [activity.id, activity]),
  ).values()].sort((left, right) => left.cursor - right.cursor);
  return {
    detail: primary.detail,
    messages: primary.messages,
    older: primary.older,
    runs: Object.fromEntries(runData.map(run => [run.run.id, run])),
    activities,
    questions: questions.clarifications,
    questionsFailed,
    cursor: firstActivity.latest_cursor,
  };
}

export function useChatSnapshot(userId: string, workspaceId: string, chatId: string | null, disabled: boolean) {
  // Staged primary paint lives in local state, keyed to its scope, and is
  // merged at read time by the caller (`data ?? primarySnapshot`). It is
  // never written to the query cache, so it cannot clobber the acceptance
  // patch, activity events or targeted refreshes that land mid-fetch.
  const scopeKey = `${userId}:${workspaceId}:${chatId ?? 'none'}`;
  const [staged, setStaged] = useState<{ scopeKey: string; snapshot: ChatSnapshot } | null>(null);
  const query = useQuery({
    queryKey: chatId ? qk.chat(userId, workspaceId, chatId) : ['otis', userId, workspaceId, 'chat', 'none'],
    queryFn: ({ signal }) => fetchChatSnapshot(workspaceId, chatId!, signal, (primary) => {
      if (signal.aborted) return;
      setStaged({
        scopeKey,
        snapshot: {
          detail: primary.detail,
          messages: primary.messages,
          older: primary.older,
          runs: {},
          activities: [],
          questions: [],
          questionsFailed: false,
          cursor: 0,
        },
      });
    }),
    enabled: chatId !== null && !disabled,
  });
  const primarySnapshot = !disabled && staged?.scopeKey === scopeKey ? staged.snapshot : undefined;
  return { ...query, primarySnapshot };
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
  // A successful list read is authoritative: it replaces the outage flag
  // along with the list, so the retry affordance and run-known fallback
  // stand down together.
  return { ...snapshot, questions, questionsFailed: false };
}

/**
 * Chooses the clarification the composer answers. An explicit reply wins;
 * otherwise the first pending answerable question outside the dismissed set.
 * Dismissal is a sticky exclusion list, never a single rotating slot: with
 * two pending questions, dismissing both must leave no selection rather
 * than reselecting the first.
 */
export function selectPendingQuestion(
  questions: ClarificationSummary[],
  replyId: string | null,
  dismissedIds: readonly string[],
): ClarificationSummary | undefined {
  if (replyId) return questions.find(question => question.id === replyId && question.answerable_by_caller);
  return questions.find(
    question => question.status === 'pending' && question.answerable_by_caller && !dismissedIds.includes(question.id),
  );
}

export function applyDetail(snapshot: ChatSnapshot, detail: ChatDetailResponse): ChatSnapshot {
  return { ...snapshot, detail };
}
