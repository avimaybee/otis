/**
 * @otis/worker/agent/context
 * Bounded context retrieval, memory assembly, and structured prompt context.
 * In accordance with docs/archive/plans/006-implementation-handoff.md Section 8 & 10.
 */

import { listAvailableModels, PRODUCTION_REGISTRY, renderSystemPrompt, type CapabilityState, type DynamicPromptContext } from '@otis/agent';

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
  platformKeyPresent?: { gemini?: boolean; opencode_go?: boolean; groq?: boolean };
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

/** Total note content characters per assembled context (F10 budget). */
export const MAX_CONTEXT_NOTE_CHARS = 6000;

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
    /**
     * Durable image references for this message, in upload order. Metadata
     * only — no bytes or object keys. Older material beyond this window
     * stays discoverable through the attachment query/read tools.
     */
    attachments: Array<{ mediaId: string; position: number }>;
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
  // Wrap tokens as prefix match: token*. Up to ten terms so a subject named
  // late in a long report is still searched, not silently dropped.
  return tokens.slice(0, 10).map((t) => `"${t}"*`).join(' OR ');
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
      `SELECT preferred_language, brief_enabled, brief_local_time, brief_timezone, interpretation_timezone, brief_weekdays, brief_channel
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
      `SELECT provider, status FROM provider_credentials WHERE workspace_id = ? AND provider IN ('gemini', 'opencode_go', 'groq')`
    ).bind(workspaceId),
    // Alias index for mention matching below: bounded by construction so a
    // workspace with heavy rename history cannot bloat the turn.
    db.prepare(
      `SELECT entity_id, alias FROM entity_aliases WHERE workspace_id = ? LIMIT 200`
    ).bind(workspaceId),
    // Workspace roster for member identity: who is talking and who can be
    // mentioned. One bounded read in the same roundtrip; display names only.
    db.prepare(
      `SELECT u.id, u.display_name FROM users u
       JOIN workspace_users wu ON wu.user_id = u.id
       WHERE wu.workspace_id = ? LIMIT 50`
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

  // 3. Recent chat transcript for this chat (excluding duplicate of current message).
  // Member identity: the roster (wave index 10) names the speaker. The
  // acting member's own turns stay bare — they are unambiguous in an own
  // chat — while any other member's turns carry their display name so the
  // model never merges two people into one voice.
  const rosterRows = rowsAt(10) as { id: string; display_name: string }[];
  const rosterNames = new Map<string, string>();
  for (const row of rosterRows) {
    const name = String(row['display_name'] ?? '').trim();
    if (row['id'] && name && !rosterNames.has(String(row['id']))) {
      rosterNames.set(String(row['id']), name);
    }
  }
  const chatRows = chatId ? rowsAt(2) : [];

  const recentMessages = chatRows
    .filter((r) => {
      if (params.runId && String(r['run_id'] ?? '') === params.runId) return false;
      if (params.sourceMessageId && String(r['inbound_message_id'] ?? '') === params.sourceMessageId) return false;
      return true;
    })
    .map((r) => {
      const authorId = r['author_user_id'] ? String(r['author_user_id']) : null;
      let text = String(r['content_text']);
      if (r['author_kind'] === 'member' && authorId && authorId !== actorUserId) {
        const speaker = rosterNames.get(authorId);
        if (speaker) text = `${speaker}: ${text}`;
      }
      return {
        id: String(r['id']),
        authorKind: r['author_kind'] as 'member' | 'system',
        authorUserId: authorId,
        text,
        sequence: Number(r['sequence']),
        createdAt: String(r['created_at']),
        attachments: [] as Array<{ mediaId: string; position: number }>,
      };
    })
    .reverse();

  // 3b. Attachment manifest for the included messages: one bounded query
  // over the same window (≤50 ids, far under the 100-parameter D1 limit).
  // Availability is rechecked at hydration time; this never gates text.
  {
    const messageIds = recentMessages.map((m) => m.id).slice(0, 50);
    if (chatId && messageIds.length > 0) {
      const placeholders = messageIds.map(() => '?').join(', ');
      const attachmentRows = (
        await db
          .prepare(
            `SELECT a.chat_message_id AS message_id, a.media_id AS media_id, a.position AS position
             FROM message_image_attachments a
             WHERE a.workspace_id = ? AND a.chat_message_id IN (${placeholders})
             ORDER BY a.position ASC`,
          )
          .bind(workspaceId, ...messageIds)
          .all<{ message_id: string; media_id: string; position: number }>()
      ).results ?? [];
      const byMessage = new Map<string, Array<{ mediaId: string; position: number }>>();
      for (const row of attachmentRows) {
        const list = byMessage.get(row.message_id) ?? [];
        list.push({ mediaId: row.media_id, position: Number(row.position) });
        byMessage.set(row.message_id, list);
      }
      for (const m of recentMessages) {
        m.attachments = byMessage.get(m.id) ?? [];
      }
    }
  }

  // 4. Active Memory Notes. Suppression tombstones already filter inside
  // each note query, so no standalone suppression-ID pull is needed.
  const candidateNotesMap = new Map<string, ActiveNoteExcerpt>();
  const ftsHitIds = new Set<string>();

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
  // UNION ALL roundtrip preserving each entity's own recency cap. Names
  // match by substring; recorded aliases match the same way (minimum three
  // characters, so a two-letter alias cannot claim every sentence).
  const MAX_ENTITY_MATCHES = 5;
  const ENTITY_NOTES_EACH = 5;
  if (sourceText) {
    const entities = (rowsAt(5) as { id: string; name: string }[]);
    const aliases = (rowsAt(9) as { entity_id: string; alias: string }[]);

    const lowerText = sourceText.toLowerCase();
    const matched: { id: string }[] = [];
    const seen = new Set<string>();
    const consider = (id: string) => {
      if (matched.length >= MAX_ENTITY_MATCHES || seen.has(id)) return;
      seen.add(id);
      matched.push({ id });
    };
    for (const ent of entities) {
      if (matched.length >= MAX_ENTITY_MATCHES) break;
      if (ent.name && lowerText.includes(ent.name.toLowerCase())) {
        consider(ent.id);
      }
    }
    for (const row of aliases ?? []) {
      if (matched.length >= MAX_ENTITY_MATCHES) break;
      if (row.alias && row.alias.trim().length >= 3 && lowerText.includes(row.alias.toLowerCase())) {
        consider(row.entity_id);
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

  // 4d. FTS search on active notes (with safe syntax sanitization & fallback).
  // The member predicate lives inside the query so LIMIT keeps the newest
  // visible rows instead of rows discarded afterwards; other members'
  // private notes never enter the candidate set.
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
                 AND (m.scope != 'member_in_workspace' OR m.subject_id = ?)
                 AND memory_entries_fts MATCH ?
               ORDER BY m.observed_at DESC
               LIMIT 5`,
            )
            .bind(workspaceId, actorUserId, ftsQuery)
            .all<Record<string, unknown>>()
        ).results || [];

        for (const r of ftsRows) {
          const id = String(r['id']);
          ftsHitIds.add(id);
          const scope = r['scope'] as 'workspace' | 'entity' | 'member_in_workspace';
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
      } catch (ftsErr) {
        // Safe graceful degradation: malformed query or index availability does not break answering
        console.warn('FTS memory search fallback:', ftsErr);
      }
    }
  }

  // F10 relevance order: notes tied to this member, a mentioned entity, or
  // the text search outrank general workspace notes; newest first within a
  // tier, id order breaks timestamp ties deterministically. Ordering never
  // inspects language: ro/hu/en notes rank by tier and recency only.
  const rankedNotes = [...candidateNotesMap.values()].sort((a, b) => {
    const tierA = a.scope === 'workspace' && !ftsHitIds.has(a.id) ? 1 : 0;
    const tierB = b.scope === 'workspace' && !ftsHitIds.has(b.id) ? 1 : 0;
    if (tierA !== tierB) return tierA - tierB;
    if (a.observedAt !== b.observedAt) return a.observedAt < b.observedAt ? 1 : -1;
    return a.id < b.id ? -1 : 1;
  });

  // Character budget: whole notes in rank order while they fit; the rest is
  // omitted, never truncated mid-fact. A single oversized top note still
  // arrives truncated with an explicit marker rather than an empty context.
  const activeNotes: ActiveNoteExcerpt[] = [];
  let budgetedChars = 0;
  for (const note of rankedNotes) {
    if (activeNotes.length >= limitNotes) break;
    if (budgetedChars + note.content.length <= MAX_CONTEXT_NOTE_CHARS) {
      activeNotes.push(note);
      budgetedChars += note.content.length;
    }
  }
  if (activeNotes.length === 0 && rankedNotes.length > 0) {
    const top = rankedNotes[0]!;
    activeNotes.push({
      ...top,
      content: `${top.content.slice(0, MAX_CONTEXT_NOTE_CHARS)}…[truncated]`,
    });
  }

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
  // Interpretation zone: device-reported first, brief schedule second,
  // unknown otherwise (never invented — the prompt says to ask).
  const briefTz = typeof memberRow?.['brief_timezone'] === 'string' && memberRow['brief_timezone']
    ? String(memberRow['brief_timezone'])
    : undefined;
  const tz = (typeof memberRow?.['interpretation_timezone'] === 'string' && memberRow['interpretation_timezone']
    ? String(memberRow['interpretation_timezone'])
    : undefined) ?? briefTz;

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
  const groqSttAvailable =
    credentialByProvider.get('groq') === 'available' || params.platformKeyPresent?.groq === true;
  const availableModels = listAvailableModels(PRODUCTION_REGISTRY, statuses).map((entry) => {
    const supported = entry.thinking?.state === 'supported' && entry.thinking.choices.length > 0;
    // In Otis, incoming voice notes are transcribed for the model via Groq STT
    // or native provider audio. When a voice transcription route is available,
    // all models receive transcripts and can answer voice notes.
    const voiceSupported: CapabilityState =
      groqSttAvailable || entry.capabilities.audio === 'supported'
        ? 'supported'
        : (entry.capabilities.audio ?? 'unsupported');
    return {
      name: entry.displayName,
      current: entry.commandKey === params.currentModelKey,
      efforts: supported ? entry.thinking!.choices.map((c) => c.label) : [],
      ...(entry.commandKey === params.currentModelKey && params.currentEffortLabel
        ? { currentEffort: params.currentEffortLabel }
        : {}),
      modalities: {
        images: entry.capabilities.vision,
        voiceNotes: voiceSupported,
      },
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

  // Entity display names for note attribution: the workspace's entities were
  // fetched in the first wave, so no extra roundtrip is needed.
  const entityNames = new Map<string, string>(
    ((rowsAt(5) as { id: string; name: string }[]) ?? []).map((ent) => [ent.id, ent.name]),
  );

  const dynamicContext: DynamicPromptContext = {
    workspaceName,
    actingMemberName: rosterNames.get(actorUserId) ?? undefined,
    workspaceMembers: [...rosterNames.values()],
    actingMemberLanguage: memberPreferences?.preferredLanguage ?? undefined,
    currentTimezone: tz,
    currentDateIso: effectiveNowIso,
    recentNotes: activeNotes.map((n) => ({
      id: n.id,
      category: n.category,
      content: n.content,
      scope: n.scope,
      // Member-scoped notes in this context are always the acting member's
      // own (other members' notes are filtered at every read); entity notes
      // resolve through the workspace's entity names fetched above.
      subject: n.scope === 'entity'
        ? (entityNames.get(n.subjectId ?? '') ?? null)
        : n.scope === 'member_in_workspace'
          ? 'own'
          : null,
      observedAt: n.observedAt,
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
