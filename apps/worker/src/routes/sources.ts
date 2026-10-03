import type { MemorySourceResponse } from '@otis/contracts';
import type { Env } from '../index.js';
import { jsonError, jsonSuccess } from '../middleware/errors.js';
import { requireWorkspaceScope } from './scope.js';

export async function handleGetMemorySource(request: Request, env: Env, workspaceId: string, memoryId: string, requestId: string): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId);
  if (scope instanceof Response) return scope;
  const memory = await env.DB.prepare(`SELECT id, content, provenance, status, observed_at, source_message_id FROM memory_entries WHERE workspace_id = ? AND id = ?`).bind(workspaceId, memoryId).first<{ id: string; content: string; provenance: 'stated' | 'inferred'; status: string; observed_at: string; source_message_id: string | null }>();
  if (!memory) return jsonError(404, 'not_found', 'Source not found in this workspace.', requestId);
  const source = memory.source_message_id ? await env.DB.prepare(`SELECT mi.chat_id, u.display_name AS author_name, cm.content_text AS text, mi.created_at, mi.channel FROM messages_in mi LEFT JOIN users u ON u.id = mi.user_id LEFT JOIN chat_messages cm ON cm.inbound_message_id = mi.id AND cm.workspace_id = mi.workspace_id WHERE mi.id = ? AND mi.workspace_id = ?`).bind(memory.source_message_id, workspaceId).first<MemorySourceResponse['source']>() : null;
  return jsonSuccess({ memory: { id: memory.id, content: memory.status === 'forgotten' ? 'This saved context was forgotten.' : memory.content, provenance: memory.provenance, status: memory.status, observed_at: memory.observed_at }, source } satisfies MemorySourceResponse, 200, { 'x-request-id': requestId });
}
