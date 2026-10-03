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
  SteeringRunClosedError,
} from '../inbox/repository.js';
import type { CreateChatRequest, CreateChatMessageRequest } from '@otis/contracts';
import { validateChatMessageRequest } from '@otis/contracts';
import { parseCommandText } from '@otis/commands';
import { handleExecuteCommand } from './commands.js';
import { handleReplyToClarification } from './clarifications.js';

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
  const filter = url.searchParams.get('filter') ?? 'team';
  if (filter !== 'mine' && filter !== 'team') return jsonError(422, 'validation_error', 'filter must be mine or team.', requestId);
  const cursor = url.searchParams.get('cursor') || undefined;
  const rawLimit = url.searchParams.get('limit'); const limit = rawLimit === null ? 25 : Number(rawLimit);
  if (rawLimit !== null && (!/^\d+$/.test(rawLimit) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)) return jsonError(422, 'validation_error', 'limit must be an integer from 1 to 100.', requestId);

  let result;
  try { result = await listChats(env.DB, workspaceId, {
    filter,
    userId: auth.userId,
    cursor,
    limit,
  }); } catch (error) { if (error instanceof ValidationError) return jsonError(422, 'validation_error', error.message, requestId); throw error; }

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

  if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonError(422, 'validation_error', 'Expected a JSON object.', requestId);
  if (body.model_override != null) return jsonError(422, 'validation_error', 'Use /model after creating the chat to select an available model.', requestId);
  try {
  const chat = await createChat(env.DB, {
    workspaceId,
    authorUserId: auth.userId,
    title: body.title,
    clientChatId: body.client_chat_id,
    modelOverride: body.model_override,
  });

  return jsonSuccess({ chat }, 201, { 'x-request-id': requestId });
  } catch (error) { if (error instanceof ValidationError) return jsonError(422, 'validation_error', error.message, requestId); if (error instanceof ConflictError) return jsonError(409, 'conflict', error.message, requestId); if (error instanceof NotFoundError) return jsonError(404, 'not_found', error.message, requestId); throw error; }
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

  const validated = validateChatMessageRequest(body);
  if (!validated.valid) return jsonError(422, 'validation_error', validated.message, requestId);
  body = validated.value;

  try {
    if (body.clarification_id) {
      return handleReplyToClarification(new Request(request.url, {
        method: 'POST', headers: request.headers, body: JSON.stringify(body),
      }), env, workspaceId, body.clarification_id, requestId, chatId);
    }
    if (typeof body.text === 'string' && parseCommandText(body.text, 'web').kind !== 'text') {
      return handleExecuteCommand(new Request(request.url, {
        method: 'POST', headers: request.headers, body: JSON.stringify(body),
      }), env, workspaceId, chatId, requestId);
    }
    const parsed = parseCommandText(body.text ?? '', 'web');
    const active = await env.DB.prepare(`SELECT id FROM agent_runs WHERE workspace_id = ? AND chat_id = ? AND executor_kind = 'agent' AND status IN ('running', 'queued') AND COALESCE(json_extract(agent_progress_json, '$.phase'), '') <> 'completed' ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, created_at DESC LIMIT 1`).bind(workspaceId, chatId).first<{ id: string }>();
    const result = await acceptWebMessage(env.DB, {
      workspaceId,
      chatId,
      userId: auth.userId,
      clientMessageId: body.client_message_id,
      text: parsed.kind === 'text' ? parsed.text : body.text,
      mediaId: body.media_id,
      steerRunId: active?.id,
    });

    return jsonSuccess(result, 202, { 'x-request-id': requestId });
  } catch (err) {
    if (err instanceof SteeringRunClosedError) {
      const result = await acceptWebMessage(env.DB, { workspaceId, chatId, userId: auth.userId, clientMessageId: body.client_message_id, text: parseCommandText(body.text ?? '', 'web').kind === 'text' ? (parseCommandText(body.text ?? '', 'web') as { text: string }).text : body.text, mediaId: body.media_id });
      return jsonSuccess(result, 202, { 'x-request-id': requestId });
    }
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

    return jsonError(500, 'internal_error', 'The message could not be accepted. Retry with the same message ID.', requestId);
  }
}
