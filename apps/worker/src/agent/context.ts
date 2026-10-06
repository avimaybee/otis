/**
 * @otis/worker/agent/context
 * Bounded context retrieval, memory assembly, and structured prompt context.
 * In accordance with plans/006-implementation-handoff.md Section 8 & 10.
 */

import { listAvailableModels, PRODUCTION_REGISTRY, renderSystemPrompt, type DynamicPromptContext } from '@otis/agent';

export interface TurnContextParams {
  workspaceId: string;
  actorUserId: string;
  chatId?: string | null;
  sourceText?: string;
  sourceMessageId?: string | null;
  runId?: string | null;
  pendingOperation?: unknown | null;
  limitTurns?: number;
  limitNotes?: number;
  nowIso?: string;
  /** Presence (never values) of platform fallback keys per provider. */
  platformKeyPresent?: { gemini?: boolean; opencode_go?: boolean };
  /** Pinned run model for marking the current catalog entry. */
  currentModelKey?: string | null;
  /** Persisted effort label for the current model, if any. */
  currentEffortLabel?: string | null;
}

export interface ActiveNoteExcerpt {
  id: string;
  scope: 'workspace' | 'entity' | 'member_in_workspace';
  subjectId: string | null;
  category: string;
  content: string;
  observedAt: string;
  businessRevision: number;
}

export interface AssembledTurnContext {
  workspaceId: string;
  actorUserId: string;
  chatId: string;
  memberPreferences: {
    preferredLanguage?: string | null;
    briefEnabled?: boolean | null;
    briefLocalTime?: string | null;
    briefTimezone?: string | null;
    briefWeekdays?: number[] | null;
    briefChannel?: string | null;
  } | null;
  recentMessages: Array<{
    id: string;
    authorKind: 'member' | 'system';
    authorUserId: string | null;
    text: string;
    sequence: number;
    createdAt: string;
  }>;
  activeNotes: ActiveNoteExcerpt[];
  currentSummary: {
    scope: string;
    subjectKey: string;
    summaryText: string;
    builtFromRevision: number;
    sourceManifest: Array<{ type: string; id: string }>;
  } | null;
  systemPrompt: string;
}

/**
 * Sanitizes plain search text for safe SQLite FTS5 MATCH expressions.
 * Removes all boolean and syntax operators to prevent syntax errors.
 */
export function sanitizeFtsQuery(raw: string): string {
  if (!raw) return '';
  // Keep only alphanumeric characters and spaces
  const cleaned = raw.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
  const tokens = cleaned
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return '';
  // Wrap tokens as prefix match: token*
  return tokens.slice(0, 6).map((t) => `"${t}"*`).join(' OR ');
}

/**
 * Assembles bounded, authoritative context for an agent turn.
 * Respects tenant boundaries, member preference scoping, forget suppressions,
 * and summary staleness validation.
 */
export async function getTurnContext(
  db: D1Database,
  params: TurnContextParams,
): Promise<AssembledTurnContext> {
  const {
    workspaceId,
    actorUserId,
    chatId,
    sourceText = '',
    limitTurns = 10,
    limitNotes = 12,
  } = params;

  // Wave 1: every independent read in one batch roundtrip. Suppression
  // tombstones filter inside the note queries (NOT EXISTS over the indexed
  // suppression key), so no full suppression-ID pull is needed.
  const suppressionClause = `AND NOT EXISTS (SELECT 1 FROM memory_suppressions s WHERE s.workspace_id = memory_entries.workspace_id AND s.target_memory_id = memory_entries.id)`;
  const wave = await db.batch([
    db.prepare(`SELECT name, business_revision FROM workspaces WHERE id = ?`).bind(workspaceId),
    db.prepare(
      `SELECT preferred_language, brief_enabled, brief_local_time, brief_timezone, brief_weekdays, brief_channel
       FROM member_settings WHERE workspace_id = ? AND user_id = ?`,
    ).bind(workspaceId, actorUserId),
    db.prepare(
      `SELECT id, author_kind, author_user_id, content_text, sequence, created_at, run_id, inbound_message_id
       FROM chat_messages
       WHERE workspace_id = ? AND chat_id = ?
       ORDER BY sequence DESC LIMIT ?`,
    ).bind(workspaceId, chatId ?? '', limitTurns),
    db.prepare(
      `SELECT id, scope, subject_id, category, content, observed_at, created_at, business_revision
       FROM memory_entries
       WHERE workspace_id = ? AND scope = 'workspace' AND status = 'active' ${suppressionClause}
       ORDER BY observed_at DESC LIMIT ?`,
    ).bind(workspaceId, limitNotes),
    db.prepare(
      `SELECT id, scope, subject_id, category, content, observed_at, created_at, business_revision
       FROM memory_entries
       WHERE workspace_id = ? AND scope = 'member_in_workspace' AND subject_id = ? AND status = 'active' ${suppressionClause}
       ORDER BY observed_at DESC LIMIT ?`,
    ).bind(workspaceId, actorUserId, limitNotes),
    db.prepare(`SELECT id, name FROM entities WHERE workspace_id = ?`).bind(workspaceId),
    db.prepare(
      `SELECT scope, subject_key, summary_text, source_manifest_json, built_from_revision
       FROM memory_summaries
       WHERE workspace_id = ? AND scope = 'workspace' AND subject_key = '__workspace__'`,
    ).bind(workspaceId),
    db.prepare(
      `SELECT es.field_name, e.name as entity_name
       FROM entity_state es
       JOIN entities e ON e.id = es.entity_id
       WHERE es.workspace_id = ? AND es.state = 'disputed'
       LIMIT 10`,
    ).bind(workspaceId),
    db.prepare(
      `SELECT provider, status FROM provider_credentials WHERE workspace_id = ? AND provider IN ('gemini', 'opencode_go')`
    ).bind(workspaceId),
  ]);
  const rowsAt = (index: number): Record<string, unknown>[] =>
    ((wave[index] as unknown as { results?: Record<string, unknown>[] }).results ?? []);

  // 1. Workspace info and business revision
  const wsRow = rowsAt(0)[0] as { name: string; business_revision: number } | undefined;
  const workspaceName = wsRow?.name || 'Workspace';
  const currentBusinessRevision = wsRow?.business_revision ?? 0;

  // 2. Member Settings for actor
  const memberRow = rowsAt(1)[0] as Record<string, unknown> | undefined;

  let memberPreferences: AssembledTurnContext['memberPreferences'] = null;
  if (memberRow) {
    let weekdays: number[] | null = null;
    if (typeof memberRow['brief_weekdays'] === 'string') {
      try {
        weekdays = JSON.parse(memberRow['brief_weekdays']) as number[];
      } catch {
        weekdays = null;
      }
    }
    memberPreferences = {
      preferredLanguage: memberRow['preferred_language'] ? String(memberRow['preferred_language']) : null,
      briefEnabled: Boolean(memberRow['brief_enabled']),
      briefLocalTime: memberRow['brief_local_time'] ? String(memberRow['brief_local_time']) : null,
      briefTimezone: memberRow['brief_timezone'] ? String(memberRow['brief_timezone']) : null,
      briefWeekdays: weekdays,
      briefChannel: memberRow['brief_channel'] ? String(memberRow['brief_channel']) : null,
    };
  }

  // 3. Recent chat transcript for this chat (excluding duplicate of current message)
  const chatRows = chatId ? rowsAt(2) : [];

  const recentMessages = chatRows
    .filter((r) => {
      if (params.runId && String(r['run_id'] ?? '') === params.runId) return false;
      if (params.sourceMessageId && String(r['inbound_message_id'] ?? '') === params.sourceMessageId) return false;
      return true;
    })
    .map((r) => ({
      id: String(r['id']),
      authorKind: r['author_kind'] as 'member' | 'system',
      authorUserId: r['author_user_id'] ? String(r['author_user_id']) : null,
      text: String(r['content_text']),
      sequence: Number(r['sequence']),
      createdAt: String(r['created_at']),
    }))
    .reverse();

  // 4. Active Memory Notes. Suppression tombstones already filter inside
  // each note query, so no standalone suppression-ID pull is needed.
  const candidateNotesMap = new Map<string, ActiveNoteExcerpt>();

  // 4a. Workspace-scoped active notes
  const wsNotes = rowsAt(3);

  for (const r of wsNotes) {
    const id = String(r['id']);
    candidateNotesMap.set(id, {
      id,
      scope: 'workspace',
      subjectId: null,
      category: String(r['category']),
      content: String(r['content']),
      observedAt: String(r['observed_at']),
      businessRevision: Number(r['business_revision']),
    });
  }

  // 4b. Member-in-workspace notes (only for this acting user)
  const memberNotes = rowsAt(4);

  for (const r of memberNotes) {
    const id = String(r['id']);
    candidateNotesMap.set(id, {
      id,
      scope: 'member_in_workspace',
      subjectId: actorUserId,
      category: String(r['category']),
      content: String(r['content']),
      observedAt: String(r['observed_at']),
      businessRevision: Number(r['business_revision']),
    });
  }

  // 4c. Entity-scoped notes if entity mentioned: bounded matches, one
  // UNION ALL roundtrip preserving each entity's own recency cap.
  const MAX_ENTITY_MATCHES = 5;
  const ENTITY_NOTES_EACH = 5;
  if (sourceText) {
    const entities = (rowsAt(5) as { id: string; name: string }[]);

    const lowerText = sourceText.toLowerCase();
    const matched: { id: string }[] = [];
    for (const ent of entities) {
      if (matched.length >= MAX_ENTITY_MATCHES) break;
      if (ent.name && lowerText.includes(ent.name.toLowerCase())) {
        matched.push({ id: ent.id });
      }
    }
    if (matched.length > 0) {
      const placeholders = matched.map(() => '?').join(', ');
      const values: unknown[] = [workspaceId, ...matched.map((ent) => ent.id)];
      const entNotes = ((await db
        .prepare(
          `SELECT id, scope, subject_id, category, content, observed_at, created_at, business_revision
           FROM (
             SELECT id, scope, subject_id, category, content, observed_at, created_at, business_revision,
               ROW_NUMBER() OVER (PARTITION BY subject_id ORDER BY observed_at DESC) AS rn
             FROM memory_entries
             WHERE workspace_id = ? AND scope = 'entity' AND subject_id IN (${placeholders}) AND status = 'active'
               AND NOT EXISTS (SELECT 1 FROM memory_suppressions s WHERE s.workspace_id = memory_entries.workspace_id AND s.target_memory_id = memory_entries.id)
           )
           WHERE rn <= ${ENTITY_NOTES_EACH}`,
        )
        .bind(...values)
        .all<Record<string, unknown>>()).results || []);

      for (const r of entNotes) {
        const id = String(r['id']);
        candidateNotesMap.set(id, {
          id,
          scope: 'entity',
          subjectId: String(r['subject_id']),
          category: String(r['category']),
          content: String(r['content']),
          observedAt: String(r['observed_at']),
          businessRevision: Number(r['business_revision']),
        });
      }
    }
  }

  // 4d. FTS search on active notes (with safe syntax sanitization & fallback)
  if (sourceText) {
    const ftsQuery = sanitizeFtsQuery(sourceText);
    if (ftsQuery) {
      try {
        const ftsRows = (
          await db
            .prepare(
              `SELECT m.id, m.scope, m.subject_id, m.category, m.content, m.observed_at, m.created_at, m.business_revision
               FROM memory_entries_fts fts
               JOIN memory_entries m ON m.id = fts.entry_id
               WHERE m.workspace_id = ? AND m.status = 'active'
                 AND NOT EXISTS (SELECT 1 FROM memory_suppressions s WHERE s.workspace_id = m.workspace_id AND s.target_memory_id = m.id)
                 AND memory_entries_fts MATCH ?
               LIMIT 5`,
            )
            .bind(workspaceId, ftsQuery)
            .all<Record<string, unknown>>()
        ).results || [];

        for (const r of ftsRows) {
          const id = String(r['id']);
          // Only include notes belonging to this workspace or acting member
          const scope = r['scope'] as 'workspace' | 'entity' | 'member_in_workspace';
          if (scope !== 'member_in_workspace' || r['subject_id'] === actorUserId) {
            candidateNotesMap.set(id, {
              id,
              scope,
              subjectId: r['subject_id'] ? String(r['subject_id']) : null,
              category: String(r['category']),
              content: String(r['content']),
              observedAt: String(r['observed_at']),
              businessRevision: Number(r['business_revision']),
            });
          }
        }
      } catch (ftsErr) {
        // Safe graceful degradation: malformed query or index availability does not break answering
        console.warn('FTS memory search fallback:', ftsErr);
      }
    }
  }

  const activeNotes = Array.from(candidateNotesMap.values()).slice(0, limitNotes);

  // 5. Extractive summary (checked against current business revision)
  let currentSummary: AssembledTurnContext['currentSummary'] = null;
  const summaryRow = rowsAt(6)[0] as Record<string, unknown> | undefined;

  if (summaryRow) {
    const builtFromRev = Number(summaryRow['built_from_revision']);
    // Validate revision: only accept summary if built-from revision matches current revision
    if (builtFromRev === currentBusinessRevision) {
      let manifest: Array<{ type: string; id: string }> = [];
      try {
        manifest = JSON.parse(String(summaryRow['source_manifest_json'])) as Array<{ type: string; id: string }>;
      } catch {
        manifest = [];
      }
      currentSummary = {
        scope: String(summaryRow['scope']),
        subjectKey: String(summaryRow['subject_key']),
        summaryText: String(summaryRow['summary_text']),
        builtFromRevision: builtFromRev,
        sourceManifest: manifest,
      };
    }
  }

  // 7. Render dynamic context for system prompt
  const effectiveNowIso = params.nowIso || new Date().toISOString();
  const tz = memberPreferences?.briefTimezone ?? undefined;

  // Query unresolved disputed fields in this workspace
  const disputedRows = (rowsAt(7) as { field_name: string; entity_name: string }[]);

  // Server-derived model catalog: availability mirrors model selection
  // exactly — an existing workspace credential row takes precedence (any
  // non-available status hides the provider); platform keys apply only when
  // no row exists. Never advertises unusable models.
  const credentialRows = (rowsAt(8) as { provider: string; status: string }[]);
  const credentialByProvider = new Map(credentialRows.map((r) => [r.provider, r.status]));
  const statusFor = (provider: 'gemini' | 'opencode_go'): 'available' | null => {
    const row = credentialByProvider.get(provider);
    if (row !== undefined) return row === 'available' ? 'available' : null;
    return params.platformKeyPresent?.[provider] === true ? 'available' : null;
  };
  const statuses: Record<string, 'available' | null> = {
    gemini: statusFor('gemini'),
    opencode_go: statusFor('opencode_go'),
  };
  const availableModels = listAvailableModels(PRODUCTION_REGISTRY, statuses).map((entry) => {
    const supported = entry.thinking?.state === 'supported' && entry.thinking.choices.length > 0;
    return {
      name: entry.displayName,
      current: entry.commandKey === params.currentModelKey,
      efforts: supported ? entry.thinking!.choices.map((c) => c.label) : [],
      ...(entry.commandKey === params.currentModelKey && params.currentEffortLabel
        ? { currentEffort: params.currentEffortLabel }
        : {}),
    };
  });

  // Query latest brief items to resolve ordinal references (e.g. "I did the second one")
  let latestBriefItems: DynamicPromptContext['latestBriefItems'] = undefined;
  try {
    const latestBriefRow = await db
      .prepare(
        `SELECT id FROM briefs WHERE workspace_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(workspaceId, actorUserId)
      .first<{ id: string }>();

    if (latestBriefRow?.id) {
      const itemRows = (
        await db
          .prepare(
            `SELECT position, title, task_id, entity_id
             FROM brief_items
             WHERE brief_id = ?
             ORDER BY position ASC
             LIMIT 10`,
          )
          .bind(latestBriefRow.id)
          .all<{ position: number; title: string; task_id: string | null; entity_id: string | null }>()
      ).results || [];

      if (itemRows.length > 0) {
        latestBriefItems = itemRows.map((r) => ({
          position: r.position,
          title: r.title,
          taskId: r.task_id,
          entityId: r.entity_id,
        }));
      }
    }
  } catch {
    // If briefs table does not exist or fails, degrade gracefully
  }

  const dynamicContext: DynamicPromptContext = {
    workspaceName,
    actingMemberLanguage: memberPreferences?.preferredLanguage ?? undefined,
    currentTimezone: tz,
    currentDateIso: effectiveNowIso,
    recentNotes: activeNotes.map((n) => ({
      id: n.id,
      category: n.category,
      content: n.content,
    })),
    recentSummaries: currentSummary ? [currentSummary.summaryText] : undefined,
    disputedFacts: disputedRows.map((r) => ({
      entityName: r.entity_name,
      fieldName: r.field_name,
    })),
    availableModels,
    latestBriefItems,
  };

  const systemPrompt = renderSystemPrompt(dynamicContext);

  return {
    workspaceId,
    actorUserId,
    chatId: chatId || '',
    memberPreferences,
    recentMessages,
    activeNotes,
    currentSummary,
    systemPrompt,
  };
}
