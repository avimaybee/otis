/**
 * Unified Workspace Search across entities, notes/quotes, tasks, files, and chats.
 */

import type { UnifiedSearchResponse, UnifiedSearchResultItem } from '@otis/contracts';
import { searchWorkspaceHistory } from './conversationSearch.js';

export async function unifiedWorkspaceSearch(
  db: D1Database,
  workspaceId: string,
  userId: string,
  queryText: string,
  limitPerCategory = 5,
): Promise<UnifiedSearchResponse> {
  const trimmed = queryText.trim();
  if (!trimmed) {
    return {
      query: '',
      categories: {
        entities: [],
        notes: [],
        quotes: [],
        tasks: [],
        files: [],
        chats: [],
      },
      total_matches: 0,
    };
  }

  const likePattern = `%${trimmed}%`;
  const entityNameMap = new Map<string, string>();

  // 1. Entities
  const entityResults: UnifiedSearchResultItem[] = [];
  try {
    const { results: rawEntities } = await db
      .prepare(
        `SELECT e.id, e.name, e.kind, e.status,
                (SELECT s.value_text FROM entity_state s WHERE s.workspace_id = e.workspace_id AND s.entity_id = e.id AND s.field_name = 'company' AND s.state = 'clear') AS company
         FROM entities e
         WHERE e.workspace_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM entity_redirects redirect
             WHERE redirect.workspace_id = e.workspace_id AND redirect.source_entity_id = e.id
           )
           AND (
             e.name LIKE ?
             OR EXISTS (
               SELECT 1 FROM entity_state s
               WHERE s.workspace_id = e.workspace_id AND s.entity_id = e.id
                 AND s.field_name IN ('company', 'address')
                 AND s.state = 'clear'
                 AND s.value_text LIKE ?
             )
             OR EXISTS (
               SELECT 1 FROM entity_aliases a
               WHERE a.workspace_id = e.workspace_id AND a.entity_id = e.id
                 AND a.alias LIKE ?
             )
           )
         ORDER BY e.updated_at DESC LIMIT ?`,
      )
      .bind(workspaceId, likePattern, likePattern, likePattern, limitPerCategory)
      .all<{ id: string; name: string; kind?: string | null; status?: string | null; company?: string | null }>();

    for (const e of rawEntities ?? []) {
      entityNameMap.set(e.id, e.name);
      entityResults.push({
        id: e.id,
        category: 'entity',
        title: e.name,
        detail: [e.kind || 'lead', e.status, e.company].filter(Boolean).join(' · '),
        entityId: e.id,
        entityName: e.name,
      });
    }
  } catch (err) {
    console.error('[unifiedSearch] entity search error:', err);
  }

  // 2. Notes & Quotes (Interactions)
  const noteResults: UnifiedSearchResultItem[] = [];
  const quoteResults: UnifiedSearchResultItem[] = [];
  try {
    const { results: rawInteractions } = await db
      .prepare(
        `SELECT i.root_event_id AS interaction_id, i.entity_id, i.kind, i.occurred_at,
                u.display_name AS actor_name, i.head_value_json, e.payload_json
         FROM interaction_state i
         LEFT JOIN events e ON i.workspace_id = e.workspace_id AND i.head_event_id = e.id
         LEFT JOIN users u ON u.id = e.actor_user_id
         WHERE i.workspace_id = ? AND i.state = 'active'
           AND (i.head_value_json LIKE ? OR e.payload_json LIKE ?)
         ORDER BY i.occurred_at DESC LIMIT ?`,
      )
      .bind(workspaceId, likePattern, likePattern, limitPerCategory * 2)
      .all<{
        interaction_id: string;
        entity_id: string | null;
        kind: string;
        occurred_at: string;
        actor_name: string | null;
        head_value_json: string | null;
        payload_json: string | null;
      }>();

    // If some entities aren't in entityNameMap, fetch their names
    const missingEntityIds = (rawInteractions ?? [])
      .map((i) => i.entity_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0 && !entityNameMap.has(id));

    if (missingEntityIds.length > 0) {
      const placeholders = missingEntityIds.map(() => '?').join(',');
      const { results: names } = await db
        .prepare(`SELECT id, name FROM entities WHERE workspace_id = ? AND id IN (${placeholders})`)
        .bind(workspaceId, ...missingEntityIds)
        .all<{ id: string; name: string }>();
      for (const row of names ?? []) {
        entityNameMap.set(row.id, row.name);
      }
    }

    for (const item of rawInteractions ?? []) {
      let text = '';
      let role = '';
      let amount = 0;
      let currency = '';

      try {
        const parsed = JSON.parse(item.head_value_json || item.payload_json || '{}') as Record<string, unknown>;
        text = String(parsed.text || parsed.summary || parsed.notes || parsed.description || '');
        role = String(parsed.role || '');
        amount = Number(parsed.amount || 0);
        currency = String(parsed.currency || '');
      } catch {
        text = String(item.head_value_json || '');
      }

      const entName = item.entity_id ? entityNameMap.get(item.entity_id) : undefined;

      if (item.kind === 'quote') {
        const quoteTitle = `${role === 'expected' ? 'Expected budget' : 'Offered quote'}: ${amount / 100} ${currency}`;
        quoteResults.push({
          id: item.interaction_id,
          category: 'quote',
          title: quoteTitle,
          snippet: text || undefined,
          detail: entName ? `For ${entName}` : undefined,
          date: item.occurred_at?.slice(0, 10),
          entityId: item.entity_id || undefined,
          entityName: entName,
        });
      } else {
        noteResults.push({
          id: item.interaction_id,
          category: 'note',
          title: text.length > 60 ? `${text.slice(0, 60)}…` : text || `${item.kind} entry`,
          snippet: text,
          detail: [entName ? `For ${entName}` : null, item.actor_name ? `by ${item.actor_name}` : null].filter(Boolean).join(' · '),
          date: item.occurred_at?.slice(0, 10),
          entityId: item.entity_id || undefined,
          entityName: entName,
        });
      }
    }
  } catch (err) {
    console.error('[unifiedSearch] interactions search error:', err);
  }

  // 3. Tasks
  const taskResults: UnifiedSearchResultItem[] = [];
  try {
    const { results: rawTasks } = await db
      .prepare(
        `SELECT id, title, status, due_local_date, due_instant, entity_id
         FROM tasks
         WHERE workspace_id = ? AND status != 'cancelled' AND title LIKE ?
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .bind(workspaceId, likePattern, limitPerCategory)
      .all<{ id: string; title: string; status: string; due_local_date: string | null; due_instant: string | null; entity_id: string | null }>();

    for (const t of rawTasks ?? []) {
      const entName = t.entity_id ? entityNameMap.get(t.entity_id) : undefined;
      const due = t.due_local_date || t.due_instant;
      taskResults.push({
        id: t.id,
        category: 'task',
        title: t.title,
        detail: [t.status, due ? `Due: ${due}` : null, entName ? `For ${entName}` : null].filter(Boolean).join(' · '),
        date: due || undefined,
        entityId: t.entity_id || undefined,
        entityName: entName,
      });
    }
  } catch (err) {
    console.error('[unifiedSearch] tasks search error:', err);
  }

  // 4. Files
  const fileResults: UnifiedSearchResultItem[] = [];
  try {
    const { results: rawFiles } = await db
      .prepare(
        `SELECT m.id, m.filename, m.content_type, l.entity_id
         FROM media_objects m
         LEFT JOIN attachment_links l ON l.workspace_id = m.workspace_id AND l.media_id = m.id AND l.state = 'active'
         WHERE m.workspace_id = ? AND m.state NOT IN ('deleted', 'expired', 'rejected') AND m.filename LIKE ?
         ORDER BY m.updated_at DESC LIMIT ?`,
      )
      .bind(workspaceId, likePattern, limitPerCategory)
      .all<{ id: string; filename: string | null; content_type: string | null; entity_id: string | null }>();

    for (const f of rawFiles ?? []) {
      const entName = f.entity_id ? entityNameMap.get(f.entity_id) : undefined;
      fileResults.push({
        id: f.id,
        category: 'file',
        title: f.filename || 'File',
        detail: [f.content_type, entName ? `For ${entName}` : null].filter(Boolean).join(' · '),
        entityId: f.entity_id || undefined,
        entityName: entName,
      });
    }
  } catch (err) {
    console.error('[unifiedSearch] files search error:', err);
  }

  // 5. Chats (conversations)
  const chatResults: UnifiedSearchResultItem[] = [];
  try {
    const chatSearch = await searchWorkspaceHistory(db, workspaceId, userId, {
      query: trimmed,
      limit: limitPerCategory,
      mode: 'relevance',
    });
    for (const item of chatSearch.items) {
      chatResults.push({
        id: item.message_id,
        category: 'chat',
        title: item.chat_title || 'Conversation',
        snippet: item.excerpt,
        detail: item.author_name ? `From ${item.author_name}` : undefined,
        date: item.recorded_at?.slice(0, 10),
        chatId: item.chat_id,
        messageId: item.message_id,
      });
    }
  } catch {
    // FTS or conversation search error falls back gracefully without breaking the rest of the search
  }

  const total =
    entityResults.length +
    noteResults.length +
    quoteResults.length +
    taskResults.length +
    fileResults.length +
    chatResults.length;

  return {
    query: trimmed,
    categories: {
      entities: entityResults,
      notes: noteResults.slice(0, limitPerCategory),
      quotes: quoteResults.slice(0, limitPerCategory),
      tasks: taskResults,
      files: fileResults,
      chats: chatResults,
    },
    total_matches: total,
  };
}
