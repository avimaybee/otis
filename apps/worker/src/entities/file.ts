import {
  ENTITY_FILE_SECTIONS,
  normalizeInteractionOccurredAt,
  type EntityFile,
  type EntityFileSection,
  type EntityFileSectionResponse,
  type FilePage,
  type SourceRef,
} from '@otis/contracts';
import {
  CURRENT_INTERACTION_COLUMNS,
  CURRENT_INTERACTION_JOINS,
  mapCurrentInteraction,
} from '@otis/ledger';
import { ENTITY_FAMILY_SQL, familyBinds } from './canonical.js';
import { readWork } from './work.js';

type Row = Record<string, unknown>;
const text = (value: unknown) => (value == null ? null : String(value));
const json = (value: unknown) => (value == null ? null : (JSON.parse(String(value)) as unknown));
export const sourceColumns = `e.id AS event_id, e.source_message_id, e.actor_user_id, u.display_name AS actor_name, e.recorded_at, e.channel`;
export const sourceRef = (r: Row): SourceRef => ({
  event_id: text(r.event_id),
  message_id: text(r.source_message_id),
  actor_user_id: text(r.actor_user_id),
  actor_name: text(r.actor_name),
  recorded_at: text(r.recorded_at),
  channel: text(r.channel),
});
export class FileReadError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid_cursor' | 'file_changed',
    message: string,
  ) {
    super(message);
  }
}
type Cursor = {
  v: 1;
  workspace: string;
  entity: string;
  section: EntityFileSection;
  revision: number;
  after: string | number;
  order: string;
  filters?: string;
};
const encode = (value: Cursor) => btoa(unescape(encodeURIComponent(JSON.stringify(value))));
function decode(value: string): Cursor {
  try {
    if (value.length > 2000) throw new Error();
    const c = JSON.parse(decodeURIComponent(escape(atob(value)))) as Cursor;
    if (
      c.v !== 1 ||
      !Number.isSafeInteger(c.revision) ||
      !ENTITY_FILE_SECTIONS.includes(c.section) ||
      (typeof c.after !== 'string' && typeof c.after !== 'number')
    )
      throw new Error();
    return c;
  } catch {
    throw new FileReadError('invalid_cursor', 'This page link is invalid.');
  }
}
const unavailable = (): FilePage => ({
  items: [],
  total: 0,
  next_cursor: null,
  has_more: false,
  availability: 'unavailable',
});

/** One shared indexed read for agent and inspection UI; no model summary is a source. */
export async function readEntityFile(
  db: D1Database,
  workspaceId: string,
  userId: string,
  entityId: string,
  options: {
    section?: EntityFileSection;
    limit?: number;
    cursor?: string;
    order?: 'occurred' | 'recorded';
    now?: string;
    author_user_id?: string;
    from?: string;
    to?: string;
    include_removed?: boolean;
    interaction_id?: string;
  } = {},
): Promise<EntityFile | EntityFileSectionResponse> {
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || (options.cursor && !options.section))
    throw new FileReadError('invalid_cursor', 'Choose a section and a page size from 1 to 50.');
  const order = options.order ?? 'occurred';
  const filterScope = JSON.stringify([
    options.author_user_id,
    options.from,
    options.to,
    Boolean(options.include_removed),
    options.interaction_id,
  ]);
  if (options.from) {
    const parsed = normalizeInteractionOccurredAt(options.from);
    if (!parsed) throw new FileReadError('invalid_cursor', 'Choose valid dates with timezones.');
    options = { ...options, from: parsed };
  }
  if (options.to) {
    const parsed = normalizeInteractionOccurredAt(options.to);
    if (!parsed) throw new FileReadError('invalid_cursor', 'Choose valid dates with timezones.');
    options = { ...options, to: parsed };
  }
  if (options.from && options.to && options.from >= options.to)
    throw new FileReadError('invalid_cursor', 'Choose an end after the start.');
  const prepare = (sql: string) => ({
    bind: (...args: (string | number)[]) =>
      db
        .prepare(`${ENTITY_FAMILY_SQL} ${sql}`)
        .bind(...familyBinds(workspaceId, entityId), ...args),
  });
  const cursor = options.cursor && options.section !== 'tasks' ? decode(options.cursor) : null;
  if (
    cursor &&
    (cursor.workspace !== workspaceId ||
      cursor.entity !== entityId ||
      cursor.section !== options.section ||
      cursor.order !== order ||
      cursor.filters !== filterScope)
  )
    throw new FileReadError(
      'invalid_cursor',
      'This page belongs to different file filters or a different section.',
    );
  const sections: EntityFileSection[] = options.section
    ? [options.section]
    : [
        'facts',
        'tasks',
        'timeline',
        'notes',
        'quotes',
        'drafts',
        'memory',
        'contacts',
        'attachments',
        'reminders',
      ];
  const statements = [
    prepare(`SELECT ent.*, owner.display_name AS assigned_name, w.business_revision, sf.state AS status_state, af.state AS assigned_state,
      ms.interpretation_timezone FROM entities ent JOIN workspaces w ON w.id = ent.workspace_id
      JOIN workspace_users member ON member.workspace_id = ent.workspace_id AND member.user_id = ?
      LEFT JOIN users owner ON owner.id = ent.assigned_user_id
      LEFT JOIN entity_state sf ON sf.workspace_id = ent.workspace_id AND sf.entity_id = ent.id AND sf.field_name = 'status'
      LEFT JOIN entity_state af ON af.workspace_id = ent.workspace_id AND af.entity_id = ent.id AND af.field_name = 'assigned_user_id'
      LEFT JOIN member_settings ms ON ms.workspace_id = ent.workspace_id AND ms.user_id = member.user_id
      WHERE ent.workspace_id = ? AND ent.id IN (SELECT id FROM canonical)`).bind(
      userId,
      workspaceId,
    ),
  ];
  if (!options.section) {
    statements.push(
      prepare(
        'SELECT alias FROM entity_aliases WHERE workspace_id = ? AND entity_id IN (SELECT id FROM family) ORDER BY alias LIMIT 100',
      ).bind(workspaceId),
    );
    statements.push(
      prepare(`SELECT MAX(occurred_at) AS last_contact FROM (
      SELECT i.occurred_at FROM interaction_state i JOIN events e ON e.id = i.head_event_id AND e.workspace_id = i.workspace_id
      WHERE i.workspace_id = ? AND i.entity_id IN (SELECT id FROM family) AND i.state = 'active'
        AND (i.kind = 'contact' OR (i.kind = 'visit' AND json_extract(e.payload_json, '$.contact_made') = 1))
      UNION ALL SELECT e.occurred_at FROM events e WHERE e.workspace_id = ? AND e.entity_id IN (SELECT id FROM family) AND e.kind = 'message_sent_by_member'
        AND NOT EXISTS (SELECT 1 FROM events r WHERE r.workspace_id = e.workspace_id AND r.kind = 'revert'
          AND (r.reverts_event_id = e.id OR json_extract(r.payload_json, '$.target_event_id') = e.id)))`).bind(
        workspaceId,
        workspaceId,
      ),
    );
    statements.push(
      prepare(`SELECT e.id, e.name, e.status, e.assigned_user_id, r.decisions_json FROM entities e
      LEFT JOIN entity_redirects r ON r.workspace_id = e.workspace_id AND r.source_entity_id = e.id
      WHERE e.workspace_id = ? AND e.id IN (SELECT id FROM family) ORDER BY e.id`).bind(
        workspaceId,
      ),
    );
  }
  const specs: {
    section: EntityFileSection;
    index: number;
    key: string;
    map: (r: Row) => unknown;
  }[] = [];
  for (const section of sections) {
    if (section === 'tasks') continue; // The general work reader owns due/snooze/zone ordering.
    let columns: string, from: string, where: string, key: string, map: (r: Row) => unknown;
    const binds: (string | number)[] = [workspaceId];
    let ascending = false;
    if (section === 'facts') {
      columns = `f.*, e.entity_id AS origin_entity_id, ${sourceColumns}`;
      from =
        'FROM entity_state f LEFT JOIN events e ON e.workspace_id = f.workspace_id AND e.id = f.source_event_id LEFT JOIN users u ON u.id = e.actor_user_id';
      where = 'f.workspace_id = ? AND f.entity_id IN (SELECT id FROM canonical)';
      key = 'f.field_name';
      ascending = true;
      map = (r) => ({
        field: String(r.field_name),
        origin_entity_id: String(r.origin_entity_id ?? r.entity_id),
        state: r.state,
        value: r.state === 'disputed' ? null : (json(r.value_json) ?? r.value_text),
        revision: Number(r.revision),
        candidate_event_ids: json(r.candidate_event_ids_json) ?? [],
        source: sourceRef(r),
      });
    } else if (section === 'timeline' || section === 'notes' || section === 'quotes') {
      columns = CURRENT_INTERACTION_COLUMNS;
      from = CURRENT_INTERACTION_JOINS;
      where =
        "i.workspace_id = ? AND i.entity_id IN (SELECT id FROM family) AND i.state = 'active'";
      if (section !== 'timeline') {
        where += ' AND i.kind = ?';
        binds.push(section === 'notes' ? 'note' : 'quote');
      }
      if (options.interaction_id) {
        where += ' AND i.root_event_id = ?';
        binds.push(options.interaction_id);
      }
      key =
        order === 'recorded' ? 'i.sequence' : "i.occurred_at || ':' || printf('%020d', i.sequence)";
      map = mapCurrentInteraction;
    } else if (section === 'history') {
      columns = `e.*, u.display_name AS actor_name, e.id AS event_id,
        i.root_event_id AS interaction_id, i.head_event_id AS current_head_event_id,
        EXISTS (SELECT 1 FROM events r WHERE r.workspace_id = e.workspace_id AND r.kind = 'revert'
          AND (r.reverts_event_id = e.id OR json_extract(r.payload_json, '$.target_event_id') = e.id)) AS is_reverted`;
      from = `FROM events e LEFT JOIN users u ON u.id = e.actor_user_id LEFT JOIN interaction_state i
        ON i.workspace_id = e.workspace_id AND i.root_event_id = COALESCE(json_extract(e.payload_json, '$.interaction_id'), json_extract(e.payload_json, '$.root_event_id'), e.id)`;
      where = 'e.workspace_id = ? AND e.entity_id IN (SELECT id FROM family)';
      key = 'e.sequence';
      map = (r) => ({
        id: r.id,
        kind: r.kind,
        entity_id: r.entity_id,
        sequence: r.sequence,
        payload: json(r.payload_json),
        occurred_at: r.occurred_at,
        supersedes_event_id: r.supersedes_event_id,
        reverts_event_id: r.reverts_event_id,
        is_reverted: Boolean(r.is_reverted),
        interaction_id: r.interaction_id,
        current_head_event_id: r.current_head_event_id,
        source: sourceRef(r),
      });
    } else if (section === 'drafts') {
      columns = `d.id, d.entity_id, d.channel AS draft_channel, d.content_text, d.recipient_address, d.status, d.revision, ${sourceColumns}`;
      from =
        'FROM draft_projections d LEFT JOIN events e ON e.workspace_id = d.workspace_id AND e.id = d.source_event_id LEFT JOIN users u ON u.id = e.actor_user_id';
      where = 'd.workspace_id = ? AND d.entity_id IN (SELECT id FROM family)';
      key = 'd.id';
      ascending = true;
      map = (r) => ({ ...r, source: sourceRef(r) });
    } else if (section === 'memory') {
      columns = `m.id, m.content, m.category, m.provenance, m.observed_at, ${sourceColumns}`;
      from =
        'FROM memory_entries m LEFT JOIN events e ON e.workspace_id = m.workspace_id AND e.id = m.source_event_id LEFT JOIN users u ON u.id = e.actor_user_id';
      where =
        "m.workspace_id = ? AND m.subject_id IN (SELECT id FROM family) AND m.scope = 'entity' AND m.status = 'active' AND NOT EXISTS (SELECT 1 FROM memory_suppressions s WHERE s.workspace_id = m.workspace_id AND s.target_memory_id = m.id)";
      key = 'm.id';
      ascending = true;
      map = (r) => ({ ...r, source: sourceRef(r) });
    } else if (section === 'contacts') {
      columns = `c.*, ${sourceColumns}`;
      from =
        'FROM entity_contacts c LEFT JOIN events e ON e.workspace_id = c.workspace_id AND e.id = c.source_event_id LEFT JOIN users u ON u.id = e.actor_user_id';
      where =
        "c.workspace_id = ? AND c.entity_id IN (SELECT id FROM family) AND c.state != 'removed'";
      key = 'c.id';
      ascending = true;
      map = (r) => ({ ...r, is_primary: Boolean(r.is_primary), source: sourceRef(r) });
    } else if (section === 'attachments') {
      columns = `l.id, l.entity_id, l.interaction_id, l.media_id, l.label, l.revision, l.state AS link_state, COALESCE(m.format, m.content_type) AS format, m.filename, m.byte_size, m.retained, m.state AS media_state, m.expires_at, ${sourceColumns}`;
      columns +=
        ', COALESCE(annotation.transcript, transcript.transcript_text) AS transcript, transcript.transcript_text AS original_transcript, COALESCE(annotation.revision, 0) AS annotation_revision, annotation.source_event_id AS annotation_event_id, correction.source_message_id AS correction_message_id, corrector.display_name AS corrector_name, correction.recorded_at AS corrected_at, annotation.retention, annotation.release_after, d.state AS extraction_state, d.error AS extraction_error';
      from =
        'FROM attachment_links l JOIN media_objects m ON m.workspace_id = l.workspace_id AND m.id = l.media_id LEFT JOIN media_transcriptions transcript ON transcript.workspace_id = m.workspace_id AND transcript.media_id = m.id LEFT JOIN media_annotations annotation ON annotation.workspace_id = m.workspace_id AND annotation.media_id = m.id LEFT JOIN events correction ON correction.workspace_id = m.workspace_id AND correction.id = annotation.source_event_id LEFT JOIN users corrector ON corrector.id = correction.actor_user_id LEFT JOIN document_extractions d ON d.workspace_id = m.workspace_id AND d.media_id = m.id LEFT JOIN events e ON e.workspace_id = l.workspace_id AND e.id = l.source_event_id LEFT JOIN users u ON u.id = e.actor_user_id';
      where = `l.workspace_id = ? AND l.entity_id IN (SELECT id FROM family)${options.include_removed ? '' : " AND l.state = 'active'"}`;
      key = 'l.id';
      ascending = true;
      map = (r) => ({ ...r, source: sourceRef(r) });
    } else {
      columns = `r.id, r.entity_id, r.text, r.timezone, r.channel AS delivery_channel, r.spec_json, r.status, r.revision, c.next_due, c.last_delivered_at, ${sourceColumns}`;
      from =
        'FROM reminder_rules r LEFT JOIN reminder_rule_cursors c ON c.rule_id = r.id AND c.workspace_id = r.workspace_id LEFT JOIN events e ON e.workspace_id = r.workspace_id AND e.id = r.source_event_id LEFT JOIN users u ON u.id = e.actor_user_id';
      where =
        "r.workspace_id = ? AND r.entity_id IN (SELECT id FROM family) AND r.user_id = ? AND r.status != 'cancelled'";
      binds.push(userId);
      key = 'r.id';
      ascending = true;
      map = (r) => ({ ...r, spec: json(r.spec_json), source: sourceRef(r) });
    }
    const currentEntries = ['timeline', 'notes', 'quotes'].includes(section);
    if (options.author_user_id) {
      where += currentEntries
        ? ' AND (e.actor_user_id = ? OR root.actor_user_id = ?)'
        : ' AND e.actor_user_id = ?';
      binds.push(options.author_user_id);
      if (currentEntries) binds.push(options.author_user_id);
    }
    const time =
      order === 'occurred' && currentEntries
        ? 'i.occurred_at'
        : order === 'occurred' && section === 'history'
          ? 'e.occurred_at'
          : 'e.recorded_at';
    if (options.from) {
      where += ` AND ${time} >= ?`;
      binds.push(options.from);
    }
    if (options.to) {
      where += ` AND ${time} < ?`;
      binds.push(options.to);
    }
    const index = statements.length;
    statements.push(prepare(`SELECT COUNT(*) AS total ${from} WHERE ${where}`).bind(...binds));
    if (cursor) {
      where += ` AND ${key} ${ascending ? '>' : '<'} ?`;
      binds.push(cursor.after);
    }
    statements.push(
      prepare(
        `SELECT ${columns}, ${key} AS page_key ${from} WHERE ${where} ORDER BY ${key} ${ascending ? 'ASC' : 'DESC'} LIMIT ?`,
      ).bind(...binds, limit + 1),
    );
    specs.push({ section, index, key, map });
  }
  const results = await db.batch(statements);
  const rows = (index: number) => (results[index]?.results ?? []) as Row[];
  const ent = rows(0)[0];
  if (!ent) throw new FileReadError('not_found', 'This file is not available in this workspace.');
  const revision = Number(ent.business_revision);
  if (cursor && cursor.revision !== revision)
    throw new FileReadError(
      'file_changed',
      'This file changed. Refresh before loading another page.',
    );
  const pages: Partial<Record<EntityFileSection, FilePage<unknown>>> = {};
  if (sections.includes('tasks')) {
    const work = await readWork(db, workspaceId, userId, {
      filters: { entity_id: entityId },
      limit,
      cursor: options.cursor,
      now: options.now,
    });
    if (work.as_of_business_revision !== revision)
      throw new FileReadError('file_changed', 'This file changed. Refresh it.');
    pages.tasks = {
      items: work.rows,
      total: work.counts.total,
      has_more: work.has_more,
      next_cursor: work.next_cursor,
      availability: 'available',
    };
  }
  for (const spec of specs) {
    const found = rows(spec.index + 1);
    const hasMore = found.length > limit;
    pages[spec.section] = {
      items: found.slice(0, limit).map(spec.map),
      total: Number(rows(spec.index)[0]?.total ?? 0),
      has_more: hasMore,
      availability: 'available',
      next_cursor: hasMore
        ? encode({
            v: 1,
            workspace: workspaceId,
            entity: entityId,
            section: spec.section,
            revision,
            order,
            filters: filterScope,
            after: found[limit - 1]!.page_key as string | number,
          })
        : null,
    };
  }
  if (options.section)
    return {
      version: 1,
      entity_id: String(ent.id),
      as_of_business_revision: revision,
      section: options.section,
      page: pages[options.section] ?? unavailable(),
    };
  const family = rows(3);
  const statusFact = { state: ent.status_state };
  const ownerFact = { state: ent.assigned_state };
  const file = {
    version: 1,
    entity: {
      id: String(ent.id),
      name: String(ent.name),
      kind: String(ent.kind),
      status: statusFact?.state === 'disputed' ? 'disputed' : String(ent.status),
      assigned_user_id: ownerFact?.state === 'disputed' ? null : text(ent.assigned_user_id),
      assigned_name: ownerFact?.state === 'disputed' ? 'Disputed' : text(ent.assigned_name),
      aliases: rows(1).map((r) => String(r.alias)),
      merged_from: family
        .filter((r) => r.id !== ent.id)
        .map((r) => ({ id: String(r.id), name: String(r.name) })),
    },
    as_of_business_revision: revision,
    ...pages,
    last_contact: text(rows(2)[0]?.last_contact),
    coverage: {
      bounded: true,
      partial_sections: Object.entries(pages)
        .filter(([, page]) => page.has_more)
        .map(([section]) => section),
      unavailable_sections: [],
    },
  } as EntityFile;
  return file;
}
