import type { MemorySourceResponse } from '@otis/contracts';
import type { Env } from '../index.js';
import { jsonError, jsonSuccess } from '../middleware/errors.js';
import { requireWorkspaceScope } from './scope.js';
import { HistoryReadError, readWorkspaceMessageSource, searchWorkspaceHistory } from '../conversationSearch.js';

export async function handleGetMemorySource(request: Request, env: Env, workspaceId: string, memoryId: string, requestId: string): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId);
  if (scope instanceof Response) return scope;
  const memory = await env.DB.prepare(`SELECT id, content, provenance, status, observed_at, source_message_id FROM memory_entries WHERE workspace_id = ? AND id = ? AND (scope != 'member_in_workspace' OR subject_id = ?)`).bind(workspaceId, memoryId, scope.user.id).first<{ id: string; content: string; provenance: 'stated' | 'inferred'; status: string; observed_at: string; source_message_id: string | null }>();
  if (!memory) return jsonError(404, 'not_found', 'Source not found in this workspace.', requestId);
  const source = memory.source_message_id ? await env.DB.prepare(`SELECT mi.chat_id, u.display_name AS author_name, cm.content_text AS text, mi.created_at, mi.channel FROM messages_in mi LEFT JOIN users u ON u.id = mi.user_id LEFT JOIN chat_messages cm ON cm.inbound_message_id = mi.id AND cm.workspace_id = mi.workspace_id WHERE mi.id = ? AND mi.workspace_id = ?`).bind(memory.source_message_id, workspaceId).first<MemorySourceResponse['source']>() : null;
  return jsonSuccess({ memory: { id: memory.id, content: memory.status === 'forgotten' ? 'This saved context was forgotten.' : memory.content, provenance: memory.provenance, status: memory.status, observed_at: memory.observed_at }, source } satisfies MemorySourceResponse, 200, { 'x-request-id': requestId });
}

export async function handleGetWorkspaceSource(request: Request, env: Env, workspaceId: string, sourceId: string, requestId: string): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId); if (scope instanceof Response) return scope;
  try { return jsonSuccess(await readWorkspaceMessageSource(env.DB, workspaceId, scope.user.id, sourceId), 200, { 'cache-control': 'no-store' }); }
  catch (error) { if (!(error instanceof HistoryReadError)) throw error; return jsonError(404, error.code, error.message, requestId); }
}
export async function handleSearchWorkspaceHistory(request: Request, env: Env, workspaceId: string, requestId: string): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId); if (scope instanceof Response) return scope;
  const p = new URL(request.url).searchParams;
  try { return jsonSuccess(await searchWorkspaceHistory(env.DB, workspaceId, scope.user.id, { query: p.get('q') ?? '', chat_id: p.get('chat_id') ?? undefined, entity_id: p.get('entity_id') ?? undefined, author_user_id: p.get('author_user_id') ?? undefined, from: p.get('from') ?? undefined, to: p.get('to') ?? undefined, source_kind: (p.get('source_kind') ?? undefined) as 'member' | 'otis' | 'system' | undefined, mode: (p.get('mode') ?? undefined) as 'relevance' | 'chronological' | undefined, cursor: p.get('cursor') ?? undefined, limit: p.has('limit') ? Number(p.get('limit')) : undefined }), 200, { 'cache-control': 'no-store' }); }
  catch (error) { if (!(error instanceof HistoryReadError)) throw error; return jsonError(error.code === 'index_changed' ? 409 : 400, error.code, error.message, requestId); }
}
