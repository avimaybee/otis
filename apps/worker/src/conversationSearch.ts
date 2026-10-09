import { normalizeInteractionOccurredAt, type HistorySearchResponse, type SearchWorkspaceHistoryArgs, type WorkspaceMessageSource } from '@otis/contracts';
import { ENTITY_FAMILY_SQL, familyBinds } from './entities/canonical.js';

export class HistoryReadError extends Error {
  constructor(readonly code: 'invalid_argument' | 'invalid_cursor' | 'not_found' | 'index_changed', message: string) { super(message); }
}
const encode = (value: unknown) => btoa(unescape(encodeURIComponent(JSON.stringify(value))));
function parse(value: string): Record<string, unknown> {
  try { if (value.length > 4000) throw new Error(); const result: unknown = JSON.parse(decodeURIComponent(escape(atob(value)))); if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(); return result as Record<string, unknown>; }
  catch { throw new HistoryReadError('invalid_cursor', 'This search page is invalid.'); }
}
const kindSql = `CASE WHEN cm.author_kind = 'member' THEN 'member' WHEN ar.executor_kind = 'system' THEN 'system' ELSE 'otis' END`;
const nullable = (v: unknown) => v == null ? null : String(v);

export async function searchWorkspaceHistory(db: D1Database, workspaceId: string, userId: string, args: SearchWorkspaceHistoryArgs): Promise<HistorySearchResponse> {
  const terms = args.query?.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!terms.length || args.query.length > 500 || terms.length > 10) throw new HistoryReadError('invalid_argument', 'Use up to ten search words, and narrow by client, chat, author or dates.');
  const limit = args.limit ?? 20, mode = args.mode ?? 'relevance';
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !['relevance', 'chronological'].includes(mode) || (args.cursor && mode !== 'chronological')) throw new HistoryReadError('invalid_argument', 'Choose 1–50 results; chronological search supports further pages.');
  const start = args.from ? normalizeInteractionOccurredAt(args.from) : null, end = args.to ? normalizeInteractionOccurredAt(args.to) : null;
  if ((args.from && !start) || (args.to && !end) || (start && end && start >= end) || (args.source_kind && !['member', 'otis', 'system'].includes(args.source_kind))) throw new HistoryReadError('invalid_argument', 'Use a valid zoned interval and source filter.');
  const scopeToken = 'w' + [...new TextEncoder().encode(workspaceId)].map(n => n.toString(16).padStart(2, '0')).join('');
  const match = `scope_token : "${scopeToken}" AND body : (${terms.map(t => `"${t}"*`).join(' AND ')})`;
  const predicates = ['chat_message_fts MATCH ?', 'cm.workspace_id = ?', 'EXISTS (SELECT 1 FROM workspace_users member WHERE member.workspace_id = cm.workspace_id AND member.user_id = ?)',
    'NOT EXISTS (SELECT 1 FROM memory_suppressions s WHERE s.workspace_id = cm.workspace_id AND s.source_message_id = cm.inbound_message_id)'];
  const binds: (string | number)[] = [match, workspaceId, userId];
  for (const [field, value] of [['cm.chat_id', args.chat_id], ['cm.author_user_id', args.author_user_id]] as const) if (value) { predicates.push(`${field} = ?`); binds.push(value); }
  if (args.source_kind) { predicates.push(`${kindSql} = ?`); binds.push(args.source_kind); }
  if (args.from) { predicates.push('cm.created_at >= ?'); binds.push(normalizeInteractionOccurredAt(args.from)!); }
  if (args.to) { predicates.push('cm.created_at < ?'); binds.push(normalizeInteractionOccurredAt(args.to)!); }
  const prefix = args.entity_id ? ENTITY_FAMILY_SQL + ' ' : '';
  const prefixBinds = args.entity_id ? familyBinds(workspaceId, args.entity_id) : [];
  if (args.entity_id) predicates.push(`EXISTS (SELECT 1 FROM events e WHERE e.workspace_id = cm.workspace_id AND e.source_message_id = cm.inbound_message_id AND e.entity_id IN (SELECT id FROM family))`);
  const fingerprint = JSON.stringify([workspaceId, userId, args.query, args.chat_id ?? null, args.entity_id ?? null, args.author_user_id ?? null, args.from ?? null, args.to ?? null, args.source_kind ?? null, mode]);
  const cursor = args.cursor ? parse(args.cursor) : null;
  if (cursor && (cursor.v !== 1 || cursor.scope !== fingerprint || !Number.isSafeInteger(cursor.upper) || !Number.isSafeInteger(cursor.backfill) || typeof cursor.at !== 'string' || typeof cursor.id !== 'string')) throw new HistoryReadError('invalid_cursor', 'This page belongs to a different search.');
  if (cursor) { predicates.push('cm.rowid <= ?'); binds.push(Number(cursor.upper)); }
  const from = `FROM chat_message_fts JOIN chat_messages cm ON cm.rowid = chat_message_fts.rowid
    JOIN chats chat ON chat.id = cm.chat_id AND chat.workspace_id = cm.workspace_id
    LEFT JOIN users author ON author.id = cm.author_user_id LEFT JOIN agent_runs ar ON ar.id = cm.run_id AND ar.workspace_id = cm.workspace_id`;
  const result = await db.batch([
    db.prepare(`${prefix} SELECT COUNT(*) AS total, COALESCE(MAX(cm.rowid), 0) AS upper ${from} WHERE ${predicates.join(' AND ')}`).bind(...prefixBinds, ...binds),
    db.prepare('SELECT after_rowid, after_rowid >= COALESCE((SELECT MAX(rowid) FROM chat_messages), 0) AS complete FROM conversation_search_backfill WHERE id = 1'),
  ]);
  const count = (result[0]!.results?.[0] ?? { total: 0, upper: 0 }) as { total: number; upper: number };
  const index = result[1]!.results?.[0] as { after_rowid: number; complete: number };
  if (cursor && cursor.backfill !== index.after_rowid) throw new HistoryReadError('index_changed', 'Older history became available. Refresh this search.');
  if (!cursor) { predicates.push('cm.rowid <= ?'); binds.push(Number(count.upper)); }
  if (cursor) { predicates.push('(cm.created_at < ? OR (cm.created_at = ? AND cm.id < ?))'); binds.push(String(cursor.at), String(cursor.at), String(cursor.id)); }
  const found = (await db.prepare(`${prefix} SELECT cm.id, cm.inbound_message_id, cm.chat_id, chat.title AS chat_title,
      cm.author_user_id, author.display_name AS author_name, ${kindSql} AS source_kind, cm.created_at, cm.sequence,
      snippet(chat_message_fts, 1, '', '', ' … ', 48) AS excerpt
      ${from} WHERE ${predicates.join(' AND ')} ORDER BY ${mode === 'relevance' ? 'bm25(chat_message_fts), cm.created_at DESC, cm.id DESC' : 'cm.created_at DESC, cm.id DESC'} LIMIT ?`)
    .bind(...prefixBinds, ...binds, limit + 1).all<Record<string, unknown>>()).results ?? [];
  const items = found.slice(0, limit).map(r => ({ message_id: String(r.id), inbound_message_id: nullable(r.inbound_message_id), chat_id: String(r.chat_id), chat_title: nullable(r.chat_title), author_user_id: nullable(r.author_user_id), author_name: nullable(r.author_name), source_kind: r.source_kind as 'member' | 'otis' | 'system', recorded_at: String(r.created_at), sequence: Number(r.sequence), excerpt: String(r.excerpt), source_available: true }));
  const last = items.at(-1), hasMore = found.length > limit;
  return { version: 1, items, total: Number(count.total), has_more: hasMore, next_cursor: hasMore && mode === 'chronological' && last ? encode({ v: 1, scope: fingerprint, upper: cursor?.upper ?? count.upper, backfill: index.after_rowid, at: last.recorded_at, id: last.message_id }) : null, coverage: { mode, bounded: true, index_complete: Boolean(index.complete) } };
}

/** Bounded recovery work; message triggers index new writes in their original transaction. */
export async function backfillConversationSearch(db: D1Database, limit = 100): Promise<number> {
  const pending = await db.prepare('SELECT after_rowid < COALESCE((SELECT MAX(rowid) FROM chat_messages), 0) AS pending FROM conversation_search_backfill WHERE id = 1').first<{ pending: number }>();
  if (!pending?.pending) return 0;
  const rows = await db.batch([
    db.prepare(`INSERT OR REPLACE INTO chat_message_fts(rowid, scope_token, body)
      SELECT rowid, 'w' || hex(workspace_id), COALESCE(content_text, '') FROM chat_messages
      WHERE rowid > (SELECT after_rowid FROM conversation_search_backfill WHERE id = 1) ORDER BY rowid LIMIT ?`).bind(limit),
    db.prepare(`UPDATE conversation_search_backfill SET after_rowid = MAX(after_rowid, COALESCE((SELECT MAX(rowid) FROM (SELECT rowid FROM chat_messages WHERE rowid > conversation_search_backfill.after_rowid ORDER BY rowid LIMIT ?)), after_rowid)) WHERE id = 1`).bind(limit),
  ]);
  return rows[0]!.meta.changes;
}

export async function readWorkspaceMessageSource(db: D1Database, workspaceId: string, userId: string, id: string): Promise<WorkspaceMessageSource> {
  const row = await db.prepare(`SELECT cm.id, cm.chat_id, cm.sequence, cm.content_text AS text, cm.created_at, cm.channel,
    cm.author_user_id, u.display_name AS author_name FROM chat_messages cm LEFT JOIN users u ON u.id = cm.author_user_id
    WHERE cm.workspace_id = ? AND (cm.id = ? OR cm.inbound_message_id = ?)
    AND EXISTS (SELECT 1 FROM workspace_users member WHERE member.workspace_id = cm.workspace_id AND member.user_id = ?) LIMIT 1`)
    .bind(workspaceId, id, id, userId).first<Record<string, unknown>>();
  if (!row) {
    const inbound = await db.prepare(`SELECT mi.id, mi.chat_id, mi.user_id, mi.raw_payload, mi.created_at, mi.channel, u.display_name AS author_name
      FROM messages_in mi LEFT JOIN users u ON u.id = mi.user_id WHERE mi.workspace_id = ? AND mi.id = ?
      AND EXISTS (SELECT 1 FROM workspace_users member WHERE member.workspace_id = mi.workspace_id AND member.user_id = ?)`)
      .bind(workspaceId, id, userId).first<Record<string, unknown>>();
    if (!inbound) throw new HistoryReadError('not_found', 'The original source is unavailable in this workspace.');
    let payload: { text?: string } = {}; try { payload = JSON.parse(String(inbound.raw_payload ?? '{}')) as typeof payload; } catch { /* missing original content */ }
    return { id: String(inbound.id), chat_id: nullable(inbound.chat_id), author_user_id: nullable(inbound.user_id), author_name: nullable(inbound.author_name), text: payload.text ?? 'Original text is unavailable.', recorded_at: String(inbound.created_at), channel: String(inbound.channel), sequence: null, context: [] };
  }
  const context = (await db.prepare(`SELECT cm.id, cm.content_text AS text, cm.author_kind, cm.sequence, u.display_name AS author_name
      FROM chat_messages cm LEFT JOIN users u ON u.id = cm.author_user_id WHERE cm.workspace_id = ? AND cm.chat_id = ? AND cm.sequence BETWEEN ? AND ?
      AND EXISTS (SELECT 1 FROM workspace_users member WHERE member.workspace_id = cm.workspace_id AND member.user_id = ?) ORDER BY cm.sequence LIMIT 21`)
    .bind(workspaceId, String(row.chat_id), Number(row.sequence) - 10, Number(row.sequence) + 10, userId).all<WorkspaceMessageSource['context'][number]>()).results ?? [];
  return { id: String(row.id), chat_id: String(row.chat_id), author_name: nullable(row.author_name), author_user_id: nullable(row.author_user_id), text: String(row.text ?? ''), recorded_at: String(row.created_at), channel: String(row.channel), sequence: Number(row.sequence), context };
}
