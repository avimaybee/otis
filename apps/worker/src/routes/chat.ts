/**
 * Chat detail and transcript routes.
 *
 * Every current workspace member may read every chat. Only the author may
 * append, which the 004A acceptance path enforces; nothing here grants write
 * authority to a reader.
 */

import type { ChatDetailResponse, MessageListResponse } from '@otis/contracts';
import { DOMAIN_BOUNDS } from '@otis/contracts';
import type { Env } from '../index.js';
import { jsonError, jsonSuccess } from '../middleware/errors.js';
import { getChat, listChatMessages } from '../inbox/repository.js';
import { requireWorkspaceScope } from './scope.js';

/**
 * GET /api/workspaces/:workspaceId/chats/:chatId
 */
export async function handleGetChatDetail(
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

  const body: ChatDetailResponse = {
    chat: {
      id: chat.id,
      workspace_id: chat.workspace_id,
      author_user_id: chat.author_user_id,
      author_display_name: chat.author_display_name,
      title: chat.title,
      model_override: chat.model_override,
      thinking_override: chat.thinking_override,
      is_archived: chat.is_archived,
      last_activity_at: chat.last_activity_at,
      created_at: chat.created_at,
    },
    is_author: chat.author_user_id === scope.user.id,
  };

  return jsonSuccess(body, 200, { 'x-request-id': requestId });
}

/**
 * GET /api/workspaces/:workspaceId/chats/:chatId/messages
 *
 * Returns one page in ascending sequence order. `next_before_sequence` is the
 * cursor for older pages, and null when the page is not full.
 */
export async function handleGetMessages(
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
  const beforeRaw = url.searchParams.get('before_sequence');
  const beforeSequence = beforeRaw === null ? undefined : Number(beforeRaw);
  if (beforeSequence !== undefined && (!Number.isSafeInteger(beforeSequence) || beforeSequence < 1 || !/^\d+$/.test(beforeRaw!))) {
    return jsonError(422, 'validation_error', 'before_sequence must be an integer.', requestId);
  }

  const limitRaw = url.searchParams.get('limit');
  const requestedLimit =
    limitRaw === null ? DOMAIN_BOUNDS.MAX_TRANSCRIPT_PAGE : Number(limitRaw);
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || (limitRaw !== null && !/^\d+$/.test(limitRaw))) {
    return jsonError(422, 'validation_error', 'limit must be a positive integer.', requestId);
  }
  const limit = Math.min(requestedLimit, DOMAIN_BOUNDS.MAX_TRANSCRIPT_PAGE);

  const messages = await listChatMessages(env.DB, workspaceId, chatId, {
    beforeSeq: beforeSequence,
    limit,
  });

  const body: MessageListResponse = {
    chat_id: chatId,
    messages,
    next_before_sequence:
      messages.length === limit && messages.length > 0 ? messages[0]!.sequence : null,
  };

  return jsonSuccess(body, 200, { 'x-request-id': requestId });
}