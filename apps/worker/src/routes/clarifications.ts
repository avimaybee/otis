/**
 * Clarification routes: inspect a pending question and answer it.
 *
 * Answering is an ordinary attributed message. The shortcut only pre-fills the
 * answer text; the durable resumption path is the actor's, so an answer from a
 * different chat or a new unrelated message cannot silently satisfy an older
 * question.
 */

import type {
  ClarificationListResponse,
  ClarificationReplyRequest,
  ClarificationReplyResponse,
  ClarificationSummary,
} from '@otis/contracts';
import type { Env } from '../index.js';
import { jsonError, jsonSuccess } from '../middleware/errors.js';
import { acceptWebMessage } from '../inbox/repository.js';
import { resumeRun } from '../actor/dispatch.js';
import { requireWorkspaceScope } from './scope.js';

async function loadClarification(db: D1Database, workspaceId: string, clarificationId: string) {
  return db
    .prepare(
      `SELECT id, workspace_id, chat_id, run_id, requester_user_id, question, intended_operation,
              missing_fields, candidates_json, status, source_revision, created_at, answer_message_id
       FROM pending_clarifications WHERE id = ? AND workspace_id = ?`,
    )
    .bind(clarificationId, workspaceId)
    .first<Record<string, unknown>>();
}

function toSummary(row: Record<string, unknown>, callerUserId: string): ClarificationSummary {
  return {
    id: String(row['id']),
    chat_id: String(row['chat_id']),
    run_id: row['run_id'] ? String(row['run_id']) : null,
    question: String(row['question']),
    intended_operation: String(row['intended_operation']),
    missing_fields: parseJsonArray(row['missing_fields']),
    candidates: row['candidates_json'] ? parseJsonArray(row['candidates_json']) : null,
    status: String(row['status']) as ClarificationSummary['status'],
    created_at: String(row['created_at']),
    answerable_by_caller: String(row['requester_user_id']) === callerUserId && row['status'] === 'pending',
  };
}

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * GET /api/workspaces/:workspaceId/chats/:chatId/clarifications?status=
 */
export async function handleListClarifications(
  request: Request,
  env: Env,
  workspaceId: string,
  chatId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId);
  if (scope instanceof Response) return scope;

  const url = new URL(request.url);
  const status = url.searchParams.get('status') ?? 'pending';
  if (status !== 'pending' && status !== 'resolved' && status !== 'all') {
    return jsonError(422, 'validation_error', 'status must be pending, resolved, or all.', requestId);
  }

  const sql =
    status === 'all'
      ? `SELECT id, chat_id, run_id, requester_user_id, question, intended_operation,
                missing_fields, candidates_json, status, created_at
         FROM pending_clarifications WHERE workspace_id = ? AND chat_id = ?
         ORDER BY created_at DESC LIMIT 50`
      : `SELECT id, chat_id, run_id, requester_user_id, question, intended_operation,
                missing_fields, candidates_json, status, created_at
         FROM pending_clarifications WHERE workspace_id = ? AND chat_id = ? AND status = ?
         ORDER BY created_at DESC LIMIT 50`;

  const binds: (string | number)[] =
    status === 'all' ? [workspaceId, chatId] : [workspaceId, chatId, status];

  const rows =
    (await env.DB.prepare(sql).bind(...binds).all<Record<string, unknown>>()).results || [];

  const body: ClarificationListResponse = {
    clarifications: rows.map((row) => toSummary(row, scope.user.id)),
  };
  return jsonSuccess(body, 200, { 'x-request-id': requestId });
}

/**
 * GET /api/workspaces/:workspaceId/clarifications/:clarificationId
 */
export async function handleGetClarification(
  request: Request,
  env: Env,
  workspaceId: string,
  clarificationId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId);
  if (scope instanceof Response) return scope;

  const row = await loadClarification(env.DB, workspaceId, clarificationId);
  if (!row) {
    return jsonError(404, 'not_found', 'Clarification not found in this workspace.', requestId);
  }

  return jsonSuccess(
    { clarification: toSummary(row, scope.user.id) },
    200,
    { 'x-request-id': requestId },
  );
}

/**
 * POST /api/workspaces/:workspaceId/clarifications/:clarificationId/reply
 *
 * The answer is durably accepted as a normal member message in the pending
 * chat, then handed to the actor's clarification resumption. That path
 * revalidates requester identity and membership inside its committing batch, so
 * a removed member or a different author cannot satisfy the question.
 */
export async function handleReplyToClarification(
  request: Request,
  env: Env,
  workspaceId: string,
  clarificationId: string,
  requestId: string,
  expectedChatId?: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId, { csrf: true });
  if (scope instanceof Response) return scope;

  const clarification = await loadClarification(env.DB, workspaceId, clarificationId);
  if (!clarification) {
    return jsonError(404, 'not_found', 'Clarification not found in this workspace.', requestId);
  }
  if (expectedChatId && clarification['chat_id'] !== expectedChatId) return jsonError(404, 'not_found', 'Question not found in this chat.', requestId);
  if (String(clarification['requester_user_id']) !== scope.user.id) {
    return jsonError(
      403,
      'forbidden',
      'Only the member who asked the question can answer it.',
      requestId,
    );
  }

  let body: ClarificationReplyRequest;
  try {
    body = (await request.json()) as ClarificationReplyRequest;
  } catch {
    return jsonError(400, 'bad_request', 'Invalid JSON body.', requestId);
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonError(422, 'validation_error', 'Expected a JSON object.', requestId);
  if (body.resolved_fields !== undefined && (!body.resolved_fields || typeof body.resolved_fields !== 'object' || Array.isArray(body.resolved_fields) || Object.keys(body.resolved_fields).length > 16 || Object.values(body.resolved_fields).some(value => typeof value !== 'string' || value.length > 1000))) return jsonError(422, 'validation_error', 'resolved_fields must contain bounded text values.', requestId);
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const clientMessageId = typeof body.client_message_id === 'string' ? body.client_message_id : '';
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(clientMessageId) || text.length > 16000) {
    return jsonError(422, 'validation_error', 'client_message_id is required.', requestId);
  }
  if (!text && !body.resolved_fields) {
    return jsonError(422, 'validation_error', 'An answer must include text or resolved_fields.', requestId);
  }

  const chatId = String(clarification['chat_id']);
  const runId = clarification['run_id'] ? String(clarification['run_id']) : null;
  if (!runId) return jsonError(422, 'resume_failed', 'This question has no resumable run.', requestId);
  if (String(clarification['status']) !== 'pending') {
    const prior = await env.DB.prepare(`SELECT id FROM messages_in WHERE workspace_id = ? AND chat_id = ? AND user_id = ? AND channel = 'web' AND external_id = ?`).bind(workspaceId, chatId, scope.user.id, clientMessageId).first<{ id: string }>();
    if (!prior || clarification['answer_message_id'] !== prior.id) return jsonError(409, 'already_resolved', 'That question has already been answered.', requestId);
  }

  let accepted: { message_id: string; run_id: string; acceptance_sequence: number };
  try {
    accepted = await acceptWebMessage(env.DB, {
      workspaceId,
      chatId,
      userId: scope.user.id,
      clientMessageId,
      answerRunId: runId ?? undefined,
      answerContext: { clarificationId, fields: body.resolved_fields },
      text: text.length > 0 ? text : 'Answered the question.',
    });
  } catch (err) {
    const code = err instanceof Error ? err.name : '';
    if (code === 'ForbiddenError') {
      return jsonError(403, 'forbidden', err instanceof Error ? err.message : 'Not allowed.', requestId);
    }
    if (code === 'NotFoundError') {
      return jsonError(404, 'not_found', err instanceof Error ? err.message : 'Chat not found.', requestId);
    }
    if (code === 'ValidationError') {
      return jsonError(422, 'validation_error', err instanceof Error ? err.message : 'Invalid answer.', requestId);
    }
    if (code === 'ConflictError') {
      return jsonError(409, 'conflict', err instanceof Error ? err.message : 'Duplicate message.', requestId);
    }
    throw err;
  }

  const answerMessage = await env.DB.prepare(`SELECT id FROM messages_in WHERE workspace_id = ? AND chat_id = ? AND external_id = ?`).bind(workspaceId, chatId, clientMessageId).first<{ id: string }>();
  const result = answerMessage ? await resumeRun(env.DB, {
    workspaceId, runId, answer: { clarificationId, messageId: answerMessage.id, authorUserId: scope.user.id, text, resolvedFields: body.resolved_fields },
  }) : { resumed: false };
  if (!result.resumed && !('replay' in result && result.replay)) return jsonError(422, 'resume_failed', 'I could not use that answer yet. Give the requested detail or a date and timezone.', requestId);
  const body2: ClarificationReplyResponse = {
    status: 'resumed',
    clarification_id: clarificationId,
    message_id: accepted.message_id,
    run_id: runId,
  };
  return jsonSuccess(body2, 202, { 'x-request-id': requestId });
}
