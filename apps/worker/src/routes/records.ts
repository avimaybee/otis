/**
 * Workspace Records routes:
 * GET  /api/workspaces/:workspaceId/records
 * POST /api/workspaces/:workspaceId/records
 *
 * Connects the "Your information" records spreadsheet/card views directly
 * to the authoritative D1 ledger tables (entities, entity_state, tasks,
 * draft_projections, events, action_receipts).
 */

import { jsonError, jsonSuccess } from '../middleware/errors.js';
import { readJsonBody, requireWorkspaceScope } from './scope.js';
import type { Env } from '../index.js';

export interface RecordColumn {
  id: string;
  name: string;
  type: 'text' | 'status' | 'number' | 'currency' | 'date' | 'phone';
  width: number;
  isCore?: boolean;
  options?: string[];
}

export interface RecordRow {
  id: string;
  source: 'entity' | 'custom';
  cells: Record<string, string>;
  provenance?: Record<string, string>;
}

export interface RecordList {
  id: string;
  name: string;
  description?: string;
  columns: RecordColumn[];
  rows: RecordRow[];
}

export interface RecordHistoryItem {
  id: string;
  timestamp: string;
  actor: 'user' | 'otis';
  description: string;
  affectedCount: number;
  canRestore: boolean;
}

export interface RecordsResponse {
  lists: RecordList[];
  history: Record<string, RecordHistoryItem[]>;
}

export async function handleGetRecords(
  request: Request,
  env: Env,
  workspaceId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId);
  if (scope instanceof Response) return scope;

  // 1. Fetch workspace users to resolve assignee IDs to display names
  const usersResult = await env.DB.prepare(
    `SELECT u.id, u.display_name FROM users u JOIN workspace_users wu ON wu.user_id = u.id WHERE wu.workspace_id = ?`,
  ).bind(workspaceId).all<{ id: string; display_name: string | null }>();
  const memberMap: Record<string, string> = {};
  for (const u of usersResult.results || []) {
    memberMap[u.id] = u.display_name || 'Teammate';
  }

  // 2. Fetch entities & their current projection state
  const [entitiesResult, fieldsResult, tasksResult, draftsResult, eventsResult, receiptsResult] =
    await Promise.all([
      env.DB.prepare(
        `SELECT id, name, kind, status, assigned_user_id, created_at, updated_at
         FROM entities WHERE workspace_id = ? ORDER BY created_at ASC`,
      ).bind(workspaceId).all<{
        id: string;
        name: string;
        kind: string;
        status: string;
        assigned_user_id: string | null;
        created_at: string;
        updated_at: string;
      }>(),
      env.DB.prepare(
        `SELECT entity_id, field_name, value_text, value_json, provenance, updated_at
         FROM entity_state WHERE workspace_id = ?`,
      ).bind(workspaceId).all<{
        entity_id: string;
        field_name: string;
        value_text: string | null;
        value_json: string | null;
        provenance: string;
        updated_at: string;
      }>(),
      env.DB.prepare(
        `SELECT id, entity_id, title, assignee_user_id, status, due_kind, due_local_date, due_instant, due_timezone, snooze_until, created_at, updated_at
         FROM tasks WHERE workspace_id = ? ORDER BY created_at ASC`,
      ).bind(workspaceId).all<{
        id: string;
        entity_id: string | null;
        title: string;
        assignee_user_id: string | null;
        status: string;
        due_kind: string | null;
        due_local_date: string | null;
        due_instant: string | null;
        due_timezone: string | null;
        snooze_until: string | null;
        created_at: string;
        updated_at: string;
      }>(),
      env.DB.prepare(
        `SELECT id, entity_id, channel, recipient_address, content_text, updated_at
         FROM draft_projections WHERE workspace_id = ? ORDER BY updated_at DESC`,
      ).bind(workspaceId).all<{
        id: string;
        entity_id: string | null;
        channel: string;
        recipient_address: string | null;
        content_text: string;
        updated_at: string;
      }>(),
      env.DB.prepare(
        `SELECT id, sequence, entity_id, actor_kind, actor_user_id, kind, payload_json, occurred_at, recorded_at, action_id, created_at
         FROM events WHERE workspace_id = ? AND kind IN ('note', 'visit', 'contact', 'quote') ORDER BY sequence DESC LIMIT 50`,
      ).bind(workspaceId).all<{
        id: string;
        sequence: number;
        entity_id: string | null;
        actor_kind: string;
        actor_user_id: string | null;
        kind: string;
        payload_json: string;
        occurred_at: string;
        recorded_at: string;
        action_id: string;
        created_at: string;
      }>(),
      env.DB.prepare(
        `SELECT action_id, command_name, result_status, result_json, created_at
         FROM action_receipts WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 20`,
      ).bind(workspaceId).all<{
        action_id: string;
        command_name: string;
        result_status: string;
        result_json: string;
        created_at: string;
      }>(),
    ]);

  const rawEntities = entitiesResult.results || [];
  const rawFields = fieldsResult.results || [];
  const rawTasks = tasksResult.results || [];
  const rawDrafts = draftsResult.results || [];
  const rawEvents = eventsResult.results || [];
  const rawReceipts = receiptsResult.results || [];

  // Group entity state fields by entity_id
  const fieldsByEntity = new Map<string, Array<{ field_name: string; value: string; provenance?: string }>>();
  for (const f of rawFields) {
    let list = fieldsByEntity.get(f.entity_id);
    if (!list) {
      list = [];
      fieldsByEntity.set(f.entity_id, list);
    }
    let val = f.value_text ?? '';
    if (!val && f.value_json) {
      try {
        const parsed = JSON.parse(f.value_json);
        val = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
      } catch {
        val = f.value_json;
      }
    }
    list.push({ field_name: f.field_name, value: val, provenance: f.provenance });
  }

  // Name map for linking entities
  const entityNameMap: Record<string, string> = {};
  for (const e of rawEntities) {
    entityNameMap[e.id] = e.name;
  }

  // 3. Assemble Leads list
  const recognizedCoreFields = new Set([
    'phone',
    'preferred_language',
    'language',
    'quote',
    'deal_value',
    'value',
    'access',
    'access_instructions',
    'notes',
  ]);
  const extraFieldNames = new Set<string>();
  for (const f of rawFields) {
    if (!recognizedCoreFields.has(f.field_name)) {
      extraFieldNames.add(f.field_name);
    }
  }

  const buildEntityRows = (entities: typeof rawEntities): RecordRow[] => {
    return entities.map(e => {
      const cells: Record<string, string> = {
        name: e.name,
        status: e.status,
        phone: '',
        language: '',
        value: '',
        assignee: e.assigned_user_id ? memberMap[e.assigned_user_id] ?? 'Teammate' : '',
        access: '',
        notes: '',
      };
      const prov: Record<string, string> = {};
      const fieldItems = fieldsByEntity.get(e.id) || [];
      for (const item of fieldItems) {
        if (item.field_name === 'phone') cells.phone = item.value;
        else if (item.field_name === 'preferred_language' || item.field_name === 'language') cells.language = item.value;
        else if (item.field_name === 'quote' || item.field_name === 'deal_value' || item.field_name === 'value') {
          cells.value = item.value.startsWith('$') ? item.value : `$${item.value}`;
        } else if (item.field_name === 'access' || item.field_name === 'access_instructions') cells.access = item.value;
        else if (item.field_name === 'notes') cells.notes = item.value;
        else cells[item.field_name] = item.value;

        if (item.provenance) {
          prov[item.field_name] = item.provenance;
        }
      }
      return {
        id: e.id,
        source: 'entity',
        cells,
        ...(Object.keys(prov).length > 0 ? { provenance: prov } : {}),
      };
    });
  };

  const leadRows = buildEntityRows(rawEntities.filter(e => !e.kind || e.kind === 'lead'));

  const leadColumns: RecordColumn[] = [
    { id: 'name', name: 'Lead name', type: 'text', width: 200, isCore: true },
    {
      id: 'status',
      name: 'Status',
      type: 'status',
      width: 120,
      isCore: true,
      options: ['new', 'warm', 'hot', 'won', 'cold', 'lost', 'deprioritized'],
    },
    { id: 'phone', name: 'Phone', type: 'phone', width: 160, isCore: true },
    { id: 'language', name: 'Language', type: 'text', width: 120, isCore: true },
    { id: 'value', name: 'Deal value', type: 'currency', width: 130 },
    { id: 'assignee', name: 'Assignee', type: 'text', width: 140 },
    { id: 'access', name: 'Access instructions', type: 'text', width: 240 },
    { id: 'notes', name: 'Notes', type: 'text', width: 280 },
  ];

  for (const fName of extraFieldNames) {
    leadColumns.push({
      id: fName,
      name: fName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      type: 'text',
      width: 160,
    });
  }

  // 4. Assemble Tasks list
  const taskRows: RecordRow[] = rawTasks.map(t => ({
    id: t.id,
    source: 'custom',
    cells: {
      title: t.title,
      status: t.status,
      due: t.due_local_date || t.due_instant || (t.snooze_until ? `Snoozed until ${t.snooze_until}` : ''),
      assignee: t.assignee_user_id ? memberMap[t.assignee_user_id] ?? 'Teammate' : '',
      entity: t.entity_id ? entityNameMap[t.entity_id] ?? '' : '',
    },
  }));

  const taskColumns: RecordColumn[] = [
    { id: 'title', name: 'Task', type: 'text', width: 260, isCore: true },
    { id: 'status', name: 'Status', type: 'status', width: 120, isCore: true, options: ['open', 'done', 'cancelled'] },
    { id: 'due', name: 'Due date', type: 'date', width: 140 },
    { id: 'assignee', name: 'Assignee', type: 'text', width: 140 },
    { id: 'entity', name: 'Related record', type: 'text', width: 180 },
  ];

  // 5. Assemble Notes & interactions list
  const noteRows: RecordRow[] = rawEvents.map(ev => {
    let summary = '';
    try {
      const p = JSON.parse(ev.payload_json);
      summary = p.text || p.summary || p.notes || p.description || ev.kind;
    } catch {
      summary = ev.kind;
    }
    return {
      id: ev.id,
      source: 'custom',
      cells: {
        date: ev.occurred_at || ev.recorded_at || ev.created_at,
        type: ev.kind,
        summary,
        entity: ev.entity_id ? entityNameMap[ev.entity_id] ?? '' : '',
        actor: ev.actor_user_id ? memberMap[ev.actor_user_id] ?? 'Teammate' : (ev.actor_kind === 'system' ? 'Otis' : ''),
      },
    };
  });

  const noteColumns: RecordColumn[] = [
    { id: 'date', name: 'Date', type: 'text', width: 160, isCore: true },
    { id: 'type', name: 'Type', type: 'text', width: 110, isCore: true },
    { id: 'summary', name: 'Summary / note', type: 'text', width: 340, isCore: true },
    { id: 'entity', name: 'Related record', type: 'text', width: 180 },
    { id: 'actor', name: 'Logged by', type: 'text', width: 140 },
  ];

  // 6. Assemble Drafts list
  const draftRows: RecordRow[] = rawDrafts.map(d => ({
    id: d.id,
    source: 'custom',
    cells: {
      channel: d.channel,
      recipient: d.recipient_address || '',
      content: d.content_text,
      entity: d.entity_id ? entityNameMap[d.entity_id] ?? '' : '',
    },
  }));

  const draftColumns: RecordColumn[] = [
    { id: 'channel', name: 'Channel', type: 'text', width: 120, isCore: true },
    { id: 'recipient', name: 'Recipient', type: 'text', width: 180 },
    { id: 'content', name: 'Draft message', type: 'text', width: 360, isCore: true },
    { id: 'entity', name: 'Related record', type: 'text', width: 180 },
  ];

  const customLists: RecordList[] = [];
  const entityKinds = new Set(rawEntities.map(e => e.kind).filter(Boolean));
  for (const kind of entityKinds) {
    if (kind === 'lead') continue;
    const kindEntities = rawEntities.filter(e => e.kind === kind);
    const kindName = kind.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    customLists.push({
      id: kind,
      name: kindName,
      description: `Custom ${kindName.toLowerCase()} tracked in business memory.`,
      columns: leadColumns,
      rows: buildEntityRows(kindEntities),
    });
  }

  const lists: RecordList[] = [
    {
      id: 'leads',
      name: 'Leads',
      description: 'Active client and prospect records tracked by you and Otis.',
      columns: leadColumns,
      rows: leadRows,
    },
    {
      id: 'tasks',
      name: 'Tasks',
      description: 'Action items, commitments and upcoming deadlines.',
      columns: taskColumns,
      rows: taskRows,
    },
    {
      id: 'notes',
      name: 'Notes & interactions',
      description: 'Notes, calls, visits and quotes captured in conversation.',
      columns: noteColumns,
      rows: noteRows,
    },
    {
      id: 'drafts',
      name: 'Drafts',
      description: 'Prepared outward messages ready for review.',
      columns: draftColumns,
      rows: draftRows,
    },
    ...customLists,
  ];

  // History entries from action receipts
  const historyItems: Record<string, RecordHistoryItem[]> = {
    leads: rawReceipts.map(r => {
      let desc = r.command_name.replace(/_/g, ' ');
      try {
        const parsed = JSON.parse(r.result_json);
        if (parsed.summary) desc = parsed.summary;
      } catch {
        // fallback
      }
      return {
        id: r.action_id,
        timestamp: r.created_at,
        actor: 'user',
        description: desc,
        affectedCount: 1,
        canRestore: false,
      };
    }),
  };

  const responsePayload: RecordsResponse = {
    lists,
    history: historyItems,
  };

  return jsonSuccess(responsePayload, 200, {
    'x-request-id': requestId,
  });
}

export async function handleSaveRecords(
  request: Request,
  env: Env,
  workspaceId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId, { csrf: true });
  if (scope instanceof Response) return scope;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) {
    return jsonError(400, 'bad_request', 'Invalid JSON body.', requestId);
  }
  const body = parsed.body as {
    listId?: string;
    dirtyCells?: Record<string, { columnId: string; currentValue: string }>;
    addedRows?: Array<{ id: string; cells: Record<string, string> }>;
    deletedRowIds?: string[];
  };

  if (!body.listId) {
    return jsonError(400, 'bad_request', 'Invalid save payload: listId is required.', requestId);
  }

  const listId = body.listId;
  const now = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  let affectedCount = 0;

  // Resolve users & entities for foreign-key resolution if needed
  const [usersResult, entitiesResult] = await Promise.all([
    env.DB.prepare(
      `SELECT u.id, u.display_name FROM users u JOIN workspace_users wu ON wu.user_id = u.id WHERE wu.workspace_id = ?`,
    ).bind(workspaceId).all<{ id: string; display_name: string | null }>(),
    env.DB.prepare(
      `SELECT id, name FROM entities WHERE workspace_id = ?`,
    ).bind(workspaceId).all<{ id: string; name: string }>(),
  ]);

  const userNameToId: Record<string, string> = {};
  for (const u of usersResult.results || []) {
    if (u.display_name) userNameToId[u.display_name.toLowerCase()] = u.id;
    userNameToId[u.id] = u.id;
  }
  const entityNameToId: Record<string, string> = {};
  for (const e of entitiesResult.results || []) {
    entityNameToId[e.name.toLowerCase()] = e.id;
    entityNameToId[e.id] = e.id;
  }

  const isTask = listId === 'tasks';
  const isDraft = listId === 'drafts';
  const isNotes = listId === 'notes';
  const entityKind = listId === 'leads' ? 'lead' : listId;

  // 1. Process deletions
  if (body.deletedRowIds && body.deletedRowIds.length > 0) {
    for (const delId of body.deletedRowIds) {
      if (isTask) {
        stmts.push(
          env.DB.prepare(`DELETE FROM tasks WHERE workspace_id = ? AND id = ?`).bind(workspaceId, delId),
        );
        affectedCount++;
      } else if (!isDraft && !isNotes) {
        stmts.push(
          env.DB.prepare(`DELETE FROM entities WHERE workspace_id = ? AND id = ?`).bind(workspaceId, delId),
          env.DB.prepare(`DELETE FROM entity_state WHERE workspace_id = ? AND entity_id = ?`).bind(workspaceId, delId),
        );
        affectedCount++;
      }
    }
  }

  // 2. Process added rows
  if (body.addedRows && body.addedRows.length > 0) {
    for (const row of body.addedRows) {
      if (isTask) {
        const taskId = row.id || `tsk_${crypto.randomUUID()}`;
        const title = row.cells.title?.trim() || 'New task';
        const status = ['open', 'done', 'cancelled'].includes(row.cells.status || '') ? row.cells.status : 'open';
        const dueVal = row.cells.due?.trim() || '';
        let dueKind: 'date' | 'instant' | null = null;
        let dueLocalDate: string | null = null;
        let dueInstant: string | null = null;
        if (dueVal) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(dueVal)) {
            dueKind = 'date';
            dueLocalDate = dueVal;
          } else {
            dueKind = 'instant';
            dueInstant = dueVal;
          }
        }
        const assigneeVal = row.cells.assignee?.trim();
        const assigneeId = assigneeVal ? (userNameToId[assigneeVal.toLowerCase()] ?? null) : null;
        const entityVal = row.cells.entity?.trim();
        const entityId = entityVal ? (entityNameToId[entityVal.toLowerCase()] ?? null) : null;

        // 1. Inbound message tracking for ledger provenance
        const msgId = `min_${crypto.randomUUID()}`;
        stmts.push(
          env.DB.prepare(
            `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, raw_payload, status, created_at, updated_at)
             VALUES (?, ?, ?, 'web', ?, ?, ?, 'processed', ?, ?)`,
          ).bind(
            msgId,
            workspaceId,
            scope.user.id,
            `records_task_${taskId}`,
            taskId,
            JSON.stringify({ title, status, dueVal }),
            now,
            now,
          ),
        );

        // 2. Immutable ledger event
        const eventId = `evt_${crypto.randomUUID()}`;
        const actionId = `act_${crypto.randomUUID()}`;
        stmts.push(
          env.DB.prepare(
            `INSERT INTO events (id, workspace_id, sequence, entity_id, actor_kind, actor_user_id, kind, schema_version, payload_json, occurred_at, recorded_at, channel, source_message_id, source_job_id, action_id, provenance, created_at)
             VALUES (?, ?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM events WHERE workspace_id = ?), ?, 'member', ?, 'task_created', 1, ?, ?, ?, 'web', ?, NULL, ?, 'stated', ?)`,
          ).bind(
            eventId,
            workspaceId,
            workspaceId,
            entityId,
            scope.user.id,
            JSON.stringify({ title, status, due_local_date: dueLocalDate, due_instant: dueInstant }),
            now,
            now,
            msgId,
            actionId,
            now,
          ),
        );

        // 3. Projected task row
        stmts.push(
          env.DB.prepare(
            `INSERT INTO tasks (id, workspace_id, entity_id, title, assignee_user_id, status, due_kind, due_local_date, due_instant, due_timezone, snooze_until, source_event_id, revision, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 1, ?, ?)`,
          ).bind(
            taskId,
            workspaceId,
            entityId,
            title,
            assigneeId,
            status,
            dueKind,
            dueLocalDate,
            dueInstant,
            eventId,
            now,
            now,
          ),
        );
        affectedCount++;
      } else if (!isDraft && !isNotes) {
        const entityId = row.id;
        const name = row.cells.name?.trim() || 'New record';
        const status = ['new', 'warm', 'hot', 'won', 'cold', 'lost', 'deprioritized'].includes(row.cells.status || '')
          ? row.cells.status
          : 'new';

        stmts.push(
          env.DB.prepare(
            `INSERT INTO entities (id, workspace_id, name, kind, status, assigned_user_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, status = excluded.status, updated_at = excluded.updated_at`,
          ).bind(entityId, workspaceId, name, entityKind, status, scope.user.id, now, now),
        );

        // Store custom / core fields in entity_state
        for (const [colId, val] of Object.entries(row.cells)) {
          if (colId === 'name' || colId === 'status' || !val) continue;
          const fieldKey = colId === 'language' ? 'preferred_language' : (colId === 'value' ? 'quote' : colId);
          stmts.push(
            env.DB.prepare(
              `INSERT INTO entity_state (id, workspace_id, entity_id, field_name, state, value_text, provenance, revision, updated_at)
               VALUES (?, ?, ?, ?, 'clear', ?, 'stated', 1, ?)
               ON CONFLICT(workspace_id, entity_id, field_name) DO UPDATE SET value_text = excluded.value_text, updated_at = excluded.updated_at`,
            ).bind(`es_${crypto.randomUUID()}`, workspaceId, entityId, fieldKey, val, now),
          );
        }
        affectedCount++;
      }
    }
  }

  // 3. Process cell edits
  if (body.dirtyCells) {
    for (const [cellKey, dirty] of Object.entries(body.dirtyCells)) {
      const [rowId, colId] = cellKey.split(':');
      if (!rowId || !colId || !dirty) continue;
      const cellVal = typeof dirty.currentValue === 'string' ? dirty.currentValue : String(dirty.currentValue ?? '');

      if (isTask) {
        if (colId === 'title') {
          stmts.push(
            env.DB.prepare(`UPDATE tasks SET title = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`).bind(
              cellVal,
              now,
              workspaceId,
              rowId,
            ),
          );
          affectedCount++;
        } else if (colId === 'status') {
          const status = ['open', 'done', 'cancelled'].includes(cellVal) ? cellVal : 'open';
          stmts.push(
            env.DB.prepare(`UPDATE tasks SET status = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`).bind(
              status,
              now,
              workspaceId,
              rowId,
            ),
          );
          affectedCount++;
        } else if (colId === 'due') {
          let dueKind: 'date' | 'instant' | null = null;
          let dueLocalDate: string | null = null;
          let dueInstant: string | null = null;
          if (cellVal.trim()) {
            if (/^\d{4}-\d{2}-\d{2}$/.test(cellVal.trim())) {
              dueKind = 'date';
              dueLocalDate = cellVal.trim();
            } else {
              dueKind = 'instant';
              dueInstant = cellVal.trim();
            }
          }
          stmts.push(
            env.DB.prepare(
              `UPDATE tasks SET due_kind = ?, due_local_date = ?, due_instant = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`,
            ).bind(dueKind, dueLocalDate, dueInstant, now, workspaceId, rowId),
          );
          affectedCount++;
        } else if (colId === 'assignee') {
          const assigneeId = cellVal.trim() ? (userNameToId[cellVal.trim().toLowerCase()] ?? null) : null;
          stmts.push(
            env.DB.prepare(`UPDATE tasks SET assignee_user_id = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`).bind(
              assigneeId,
              now,
              workspaceId,
              rowId,
            ),
          );
          affectedCount++;
        } else if (colId === 'entity') {
          const entityId = cellVal.trim() ? (entityNameToId[cellVal.trim().toLowerCase()] ?? null) : null;
          stmts.push(
            env.DB.prepare(`UPDATE tasks SET entity_id = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`).bind(
              entityId,
              now,
              workspaceId,
              rowId,
            ),
          );
          affectedCount++;
        }
      } else if (!isDraft && !isNotes) {
        if (colId === 'name') {
          stmts.push(
            env.DB.prepare(`UPDATE entities SET name = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`).bind(
              cellVal,
              now,
              workspaceId,
              rowId,
            ),
          );
          affectedCount++;
        } else if (colId === 'status') {
          const status = ['new', 'warm', 'hot', 'won', 'cold', 'lost', 'deprioritized'].includes(cellVal)
            ? cellVal
            : 'new';
          stmts.push(
            env.DB.prepare(`UPDATE entities SET status = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`).bind(
              status,
              now,
              workspaceId,
              rowId,
            ),
          );
          affectedCount++;
        } else {
          const fieldKey = colId === 'language' ? 'preferred_language' : (colId === 'value' ? 'quote' : colId);
          stmts.push(
            env.DB.prepare(
              `INSERT INTO entity_state (id, workspace_id, entity_id, field_name, state, value_text, provenance, revision, updated_at)
               VALUES (?, ?, ?, ?, 'clear', ?, 'stated', 1, ?)
               ON CONFLICT(workspace_id, entity_id, field_name) DO UPDATE SET value_text = excluded.value_text, updated_at = excluded.updated_at`,
            ).bind(`es_${crypto.randomUUID()}`, workspaceId, rowId, fieldKey, cellVal, now),
          );
          affectedCount++;
        }
      }
    }
  }

  // 4. Record action receipt in ledger for auditability
  if (affectedCount > 0) {
    const actionId = `act_${crypto.randomUUID()}`;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO action_receipts (id, workspace_id, action_id, payload_hash, command_name, result_status, result_json, actor_kind, actor_user_id, committed_revision, created_at)
         VALUES (?, ?, ?, 'manual_save', 'records_batch_save', 'applied', ?, 'member', ?, 1, ?)`,
      ).bind(
        `rcpt_${crypto.randomUUID()}`,
        workspaceId,
        actionId,
        JSON.stringify({ summary: `Saved ${affectedCount} change(s) to ${listId} in business memory` }),
        scope.user.id,
        now,
      ),
    );
  }

  try {
    if (stmts.length > 0) {
      // Chunk statements by 100 to stay well under SQLite / D1 batch limits
      const chunkSize = 100;
      for (let i = 0; i < stmts.length; i += chunkSize) {
        await env.DB.batch(stmts.slice(i, i + chunkSize));
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[otis:records] batch save failed:', msg);
    return jsonError(500, 'batch_failed', msg, requestId);
  }

  return jsonSuccess({ saved: true, affectedCount }, 200, {
    'x-request-id': requestId,
  });
}
