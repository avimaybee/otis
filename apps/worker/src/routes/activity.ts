/**
 * Activity routes: JSON catch-up and the long-lived SSE stream.
 *
 * Both read the same durable rows written before publication, so a reconnect
 * after a cursor replay sees exactly what a live subscriber saw.
 */

import type { ActivityReadResult } from '@otis/contracts';
import { extractSessionToken } from '@otis/identity';
import type { Env } from '../index.js';
import {
  ActivityCursorSupersededError,
  buildActivityPage,
  readChatActivity,
} from '../chat/activity.js';
import { createActivityStream } from '../chat/stream.js';
import { jsonError, jsonSuccess } from '../middleware/errors.js';
import { getChat } from '../inbox/repository.js';
import { requireWorkspaceScope } from './scope.js';

/**
 * GET /api/workspaces/:workspaceId/chats/:chatId/activity?after=&stream=
 */
export async function handleGetActivity(
  request: Request,
  env: Env,
  workspaceId: string,
  chatId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId);
  if (scope instanceof Response) return scope;

  const chat = await getChat(env.DB, workspaceId, chatId);
  if (!chat) {
    return jsonError(404, 'not_found', 'Chat not found in this workspace.', requestId);
  }

  const url = new URL(request.url);
  const afterRaw = url.searchParams.get('after');
  const after = afterRaw === null ? 0 : Number(afterRaw);
  if (!Number.isSafeInteger(after) || after < 0 || (afterRaw !== null && !/^\d+$/.test(afterRaw))) {
    return jsonError(422, 'validation_error', 'after must be a non-negative integer cursor.', requestId);
  }

  if (url.searchParams.get('stream') === 'sse') {
    const token = extractSessionToken(request);
    if (!token) {
      return jsonError(401, 'unauthorized', 'Session token missing or expired.', requestId);
    }
    return createActivityStream(env.DB, {
      workspaceId,
      chatId,
      afterCursor: after,
      sessionToken: token,
      userId: scope.user.id,
      requestId,
    });
  }

  try {
    const read: ActivityReadResult = await readChatActivity(env.DB, {
      workspaceId,
      chatId,
      afterCursor: after,
    });
    return jsonSuccess(buildActivityPage(chatId, read), 200, { 'x-request-id': requestId });
  } catch (err) {
    if (err instanceof ActivityCursorSupersededError) {
      return jsonError(
        409,
        'cursor_superseded',
        'Activity cursor is ahead of this chat. Resync from the transcript.',
        requestId,
        false,
        { latest_cursor: err.latestCursor },
      );
    }
    throw err;
  }
}
