/**
 * @otis/worker/routes/chats
 * HTTP handlers for workspace chats and message acceptance.
 * In accordance with docs/contracts.md and plans/004-inbound-routing.md.
 */

import {
  extractSessionToken,
  validateCsrfAndOrigin,
  buildWorkspaceContext,
} from '@otis/identity';
import type { Env } from '../index.js';
import { jsonError, jsonSuccess } from '../middleware/errors.js';
import {
  createChat,
  getChat,
  listChats,
  listChatMessages,
  acceptWebMessage,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../inbox/repository.js';
import type { CreateChatRequest, CreateChatMessageRequest } from '@otis/contracts';

/**
 * Authenticates the request and verifies active membership in the workspace.
 */
async function authenticateWorkspaceMember(
  request: Request,
  env: Env,
  workspaceId: string,
  requestId: string,
) {
  const token = extractSessionToken(request);
  if (!token) {
    return { error: jsonError(401, 'unauthorized', 'Session token missing or expired.', requestId) };
  }

  // Derive hash of the session token
  const tokenHash = await (async (t: string) => {
    const encoder = new TextEncoder();
    const data = encoder.encode(t);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  })(token);

  const now = new Date().toISOString();
  const session = await env.DB
    .prepare(
      `SELECT user_id, expires_at, revoked_at FROM sessions WHERE token_hash = ?`
    )
    .bind(tokenHash)
    .first<Record<string, unknown>>();

  if (!session || session['revoked_at'] || String(session['expires_at']) <= now) {
    return { error: jsonError(401, 'unauthorized', 'Invalid or expired session.', requestId) };
  }

  const userId = String(session['user_id']);
  try {
    const context = await buildWorkspaceContext(env.DB, {
      workspaceId,
      userId,
      requestId,
    });
    return { userId, context };
  } catch {
    return { error: jsonError(404, 'not_found', 'Workspace not found or access denied.', requestId) };
  }
}

/**
 * GET /api/workspaces/:workspaceId/chats
 */
export async function handleListChats(
  request: Request,
  env: Env,
  workspaceId: string,
  requestId: string,
): Promise<Response> {
  const auth = await authenticateWorkspaceMember(request, env, workspaceId, requestId);
  if (auth.error) return auth.error;

  const url = new URL(request.url);
  const filter = url.searchParams.get('filter') === 'mine' ? 'mine' : 'team';
  const cursor = url.searchParams.get('cursor') || undefined;
  const limit = url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit')!, 10) : 25;

  const result = await listChats(env.DB, workspaceId, {
    filter,
    userId: auth.userId,
    cursor,
    limit,
  });

  return jsonSuccess(result, 200, { 'x-request-id': requestId });
}

/**
 * POST /api/workspaces/:workspaceId/chats
 */
export async function handleCreateChat(
  request: Request,
  env: Env,
  workspaceId: string,
  requestId: string,
): Promise<Response> {
  if (!validateCsrfAndOrigin(request)) {
    return jsonError(403, 'csrf_violation', 'Invalid CSRF header or origin.', requestId);
  }

  const auth = await authenticateWorkspaceMember(request, env, workspaceId, requestId);
  if (auth.error) return auth.error;

  let body: CreateChatRequest = {};
  try {
    body = (await request.json()) as CreateChatRequest;
  } catch {
    // Empty body is valid, creates chat with default title
  }

  const chat = await createChat(env.DB, {
    workspaceId,
    authorUserId: auth.userId,
    title: body.title,
    clientChatId: body.client_chat_id,
    modelOverride: body.model_override,
  });

  return jsonSuccess({ chat }, 201, { 'x-request-id': requestId });
}

/**
 * GET /api/workspaces/:workspaceId/chats/:chatId
 */
export async function handleGetChat(
  request: Request,
  env: Env,
  workspaceId: string,
  chatId: string,
  requestId: string,
): Promise<Response> {
  const auth = await authenticateWorkspaceMember(request, env, workspaceId, requestId);
  if (auth.error) return auth.error;

  const chat = await getChat(env.DB, workspaceId, chatId);
  if (!chat) {
    return jsonError(404, 'not_found', 'Chat not found in this workspace.', requestId);
  }

  return jsonSuccess({ chat }, 200, { 'x-request-id': requestId });
}

/**
 * GET /api/workspaces/:workspaceId/chats/:chatId/messages
 */
export async function handleListMessages(
  request: Request,
  env: Env,
  workspaceId: string,
  chatId: string,
  requestId: string,
): Promise<Response> {
  const auth = await authenticateWorkspaceMember(request, env, workspaceId, requestId);
  if (auth.error) return auth.error;

  const chat = await getChat(env.DB, workspaceId, chatId);
  if (!chat) {
    return jsonError(404, 'not_found', 'Chat not found in this workspace.', requestId);
  }

  const url = new URL(request.url);
  const beforeSeq = url.searchParams.get('before_seq')
    ? parseInt(url.searchParams.get('before_seq')!, 10)
    : undefined;
  const limit = url.searchParams.get('limit')
    ? parseInt(url.searchParams.get('limit')!, 10)
    : 50;

  const messages = await listChatMessages(env.DB, workspaceId, chatId, {
    beforeSeq,
    limit,
  });

  return jsonSuccess({ messages }, 200, { 'x-request-id': requestId });
}

/**
 * POST /api/workspaces/:workspaceId/chats/:chatId/messages
 * Durable Message Acceptance -> HTTP 202 Accepted.
 */
export async function handleCreateMessage(
  request: Request,
  env: Env,
  workspaceId: string,
  chatId: string,
  requestId: string,
): Promise<Response> {
  if (!validateCsrfAndOrigin(request)) {
    return jsonError(403, 'csrf_violation', 'Invalid CSRF header or origin.', requestId);
  }

  const auth = await authenticateWorkspaceMember(request, env, workspaceId, requestId);
  if (auth.error) return auth.error;

  let body: CreateChatMessageRequest;
  try {
    body = (await request.json()) as CreateChatMessageRequest;
  } catch {
    return jsonError(400, 'bad_request', 'Invalid JSON body.', requestId);
  }

  if (!body.client_message_id || typeof body.client_message_id !== 'string') {
    return jsonError(422, 'validation_error', 'Missing or invalid client_message_id.', requestId);
  }

  try {
    const result = await acceptWebMessage(env.DB, {
      workspaceId,
      chatId,
      userId: auth.userId,
      clientMessageId: body.client_message_id,
      text: body.text,
      mediaId: body.media_id,
    });

    return jsonSuccess(result, 202, { 'x-request-id': requestId });
  } catch (err) {
    if (err instanceof ConflictError) {
      return jsonError(409, 'conflict', err.message, requestId);
    }
    if (err instanceof ForbiddenError) {
      return jsonError(403, 'forbidden', err.message, requestId);
    }
    if (err instanceof NotFoundError) {
      return jsonError(404, 'not_found', err.message, requestId);
    }
    if (err instanceof ValidationError) {
      return jsonError(422, 'validation_error', err.message, requestId);
    }

    return jsonError(500, 'internal_error', `Failed to accept message: ${String(err)}`, requestId);
  }
}
