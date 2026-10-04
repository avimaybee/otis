/**
 * Persisted public activity reads for one chat.
 *
 * Activity is written before publication, so both the JSON catch-up page and
 * the long-lived stream read the same durable rows in docs/contracts.md
 * section 8. FTS is not involved; nothing here reconstructs business state
 * from provider output.
 */

import type { ActivityPageResponse, ActivityReadResult, PublicActivity } from '@otis/contracts';
import { ACTIVITY_BOUNDS } from '@otis/contracts';

export class ActivityCursorSupersededError extends Error {
  constructor(readonly latestCursor: number) {
    super('Activity cursor is newer than this chat. Resync from the transcript.');
    this.name = 'ActivityCursorSupersededError';
  }
}

/**
 * Reads activity rows strictly after `afterCursor`, oldest first.
 *
 * The stored cursor is chat-monotonic. A cursor beyond the chat's current
 * activity cursor means the client is following a different or stale chat
 * state, so the caller must resync rather than silently receive nothing.
 */
export async function readChatActivity(
  db: D1Database,
  params: { workspaceId: string; chatId: string; afterCursor?: number; limit?: number },
  queryCount?: { count: number },
): Promise<ActivityReadResult> {
  const limit = Math.min(
    Math.max(params.limit ?? ACTIVITY_BOUNDS.MAX_CATCHUP_PAGE, 1),
    ACTIVITY_BOUNDS.MAX_CATCHUP_PAGE,
  );

  const after = params.afterCursor ?? 0;
  if (queryCount) queryCount.count += 1;
  const chat = await db
    .prepare(`SELECT id, workspace_id, activity_cursor FROM chats WHERE id = ? AND workspace_id = ?`)
    .bind(params.chatId, params.workspaceId)
    .first<{ activity_cursor: number }>();
  if (!chat) return { activities: [], nextCursor: after, latestCursor: 0 };

  const latestCursor = Number(chat.activity_cursor ?? 0);
  if (after > latestCursor) {
    throw new ActivityCursorSupersededError(latestCursor);
  }

  // If the requested cursor is already at latestCursor, avoid querying run_activity entirely.
  if (after === latestCursor) {
    return { activities: [], latestCursor, nextCursor: after };
  }

  if (queryCount) queryCount.count += 1;
  const rows =
    (
      await db
        .prepare(
          `SELECT id, workspace_id, chat_id, run_id, cursor, type, payload_json, created_at
           FROM run_activity
           WHERE workspace_id = ? AND chat_id = ? AND cursor > ?
           ORDER BY cursor ASC
           LIMIT ?`,
        )
        .bind(params.workspaceId, params.chatId, after, limit)
        .all<Record<string, unknown>>()
    ).results || [];

  const activities: PublicActivity[] = rows.map(publicActivityFromRow);

  const nextCursor = activities.length > 0 ? activities[activities.length - 1]!.cursor : after;
  return { activities, latestCursor, nextCursor };
}

export function publicActivityFromRow(row: Record<string, unknown>): PublicActivity {
  return {
    schema_version: 1 as const,
    id: String(row['id']),
    cursor: Number(row['cursor']),
    workspace_id: String(row['workspace_id']),
    chat_id: String(row['chat_id']),
    run_id: String(row['run_id']),
    created_at: String(row['created_at']),
    type: String(row['type']) as PublicActivity['type'],
    payload: safePayload(String(row['type']), String(row['payload_json'] ?? 'null')),
  };
}

function safePayload(type: string, json: string): unknown {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const keys: Record<string, string[]> = {
      message_accepted: ['client_message_id', 'text', 'media_id', 'steering_message_id'],
      queued: ['status'], run_started: ['status'], text_chunk: ['text', 'round_index'],
      step_started: ['step_index', 'tool_name'], step_finished: ['step_index', 'tool_name', 'status'],
      action_applied: ['action_id', 'command_name', 'summary', 'event_ids'],
      action_reverted: ['action_id', 'mode', 'requested_by_user_id'],
      reasoning_summary: ['text', 'provider', 'round_index', 'block_id', 'content_kind', 'mode', 'state'],
      clarification_required: ['question', 'missing_fields'], partial_failure: ['error_code'],
      answer_saved: ['reply', 'selected_workspace_id'], run_finished: ['status'],
    };
    return Object.fromEntries((keys[type] ?? []).flatMap<[string, unknown]>(key => {
      const value = parsed[key];
      if (typeof value === 'string') return [[key, value.slice(0, 16_000)]];
      if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return [[key, value]];
      if (Array.isArray(value) && value.every(item => typeof item === 'string')) return [[key, value.slice(0, 32).map(item => item.slice(0, 256))]];
      return [];
    }));
  } catch {
    return null;
  }
}

export function buildActivityPage(chatId: string, read: ActivityReadResult): ActivityPageResponse {
  return {
    chat_id: chatId,
    activities: read.activities,
    next_cursor: read.nextCursor,
    latest_cursor: read.latestCursor,
  };
}
