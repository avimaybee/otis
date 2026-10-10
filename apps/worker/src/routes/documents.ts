/**
 * @otis/worker/routes/documents
 * Routes for reading generated documents, revisions, and retrying PDF renders.
 */

import type { Env } from '../index.js';
import { jsonError, jsonSuccess } from '../middleware/errors.js';
import { requireWorkspaceScope } from './scope.js';
import {
  getDocumentRevision,
  getGeneratedDocument,
  listChatDocuments,
  retryDocumentRender,
} from '../media/generatedDocuments.js';

/**
 * GET /api/workspaces/:workspaceId/documents/:documentId
 */
export async function handleGetGeneratedDocument(
  request: Request,
  env: Env,
  workspaceId: string,
  documentId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId);
  if (scope instanceof Response) return scope;

  try {
    const detail = await getGeneratedDocument(env, workspaceId, scope.user.id, documentId);
    if (!detail) {
      return jsonError(404, 'not_found', 'Document not found in this workspace.', requestId);
    }
    return jsonSuccess(detail, 200, { 'cache-control': 'no-store' });
  } catch (err) {
    return jsonError(
      500,
      'document_error',
      err instanceof Error ? err.message : 'Could not load document.',
      requestId,
    );
  }
}

/**
 * GET /api/workspaces/:workspaceId/documents/:documentId/revisions/:revisionId
 */
export async function handleGetDocumentRevision(
  request: Request,
  env: Env,
  workspaceId: string,
  documentId: string,
  revisionId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId);
  if (scope instanceof Response) return scope;

  try {
    const detail = await getDocumentRevision(env, workspaceId, scope.user.id, documentId, revisionId);
    if (!detail) {
      return jsonError(404, 'not_found', 'Revision not found.', requestId);
    }
    return jsonSuccess(detail, 200, { 'cache-control': 'no-store' });
  } catch (err) {
    return jsonError(
      500,
      'revision_error',
      err instanceof Error ? err.message : 'Could not load revision.',
      requestId,
    );
  }
}

/**
 * POST /api/workspaces/:workspaceId/documents/:documentId/revisions/:revisionId/retry-render
 */
export async function handleRetryDocumentRender(
  request: Request,
  env: Env,
  workspaceId: string,
  documentId: string,
  revisionId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId, { csrf: true });
  if (scope instanceof Response) return scope;

  try {
    const retried = await retryDocumentRender(env, workspaceId, scope.user.id, documentId, revisionId);
    if (!retried) {
      return jsonError(404, 'not_found', 'Document revision could not be retried.', requestId);
    }
    return jsonSuccess({ retried: true, revision_id: revisionId }, 200, { 'cache-control': 'no-store' });
  } catch (err) {
    return jsonError(
      500,
      'retry_error',
      err instanceof Error ? err.message : 'Could not retry PDF render.',
      requestId,
    );
  }
}

/**
 * GET /api/workspaces/:workspaceId/chats/:chatId/documents
 */
export async function handleListChatDocuments(
  request: Request,
  env: Env,
  workspaceId: string,
  chatId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId);
  if (scope instanceof Response) return scope;

  try {
    const list = await listChatDocuments(env, workspaceId, scope.user.id, chatId);
    return jsonSuccess(list, 200, { 'cache-control': 'no-store' });
  } catch (err) {
    return jsonError(
      500,
      'list_error',
      err instanceof Error ? err.message : 'Could not list documents.',
      requestId,
    );
  }
}
