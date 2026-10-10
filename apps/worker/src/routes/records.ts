/**
 * Workspace Records routes:
 * GET  /api/workspaces/:workspaceId/records
 * POST /api/workspaces/:workspaceId/records
 *
 * Connects the "Your information" records spreadsheet/card views directly
 * to the authoritative D1 ledger tables through executeLedgerCommand with
 * atomic conditional D1 batch guards.
 *
 * In accordance with plans/editable-records.md Sections 6, 8, and 12 (Slice B).
 */

import { jsonError, jsonSuccess } from '../middleware/errors.js';
import { readJsonBody, requireWorkspaceScope } from './scope.js';
import { readRecordsPage } from '../records/read.js';
import type { Env } from '../index.js';
import {
  executeLedgerCommand,
  getWorkspaceRevision,
  handleRecordsBatch,
} from '@otis/ledger';
import type {
  ColumnType,
  RecordCell,
  RecordColumn,
  RecordEdit,
  RecordHistoryItem,
  RecordList,
  RecordRef,
  RecordRow,
  RecordsResponse,
  RecordsSaveRequest,
  RecordsSaveResponse,
  RecordsViewQuery,
  RecordValue,
} from '@otis/contracts';
import { validateRecordsSaveRequest } from '@otis/contracts';

async function readMembershipRevision(db: D1Database, workspaceId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT membership_revision FROM workspaces WHERE id = ?`)
    .bind(workspaceId)
    .first<{ membership_revision: number }>();
  return row?.membership_revision ?? 0;
}

async function computeHash(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const buffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  const hashArray = Array.from(new Uint8Array(buffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Re-export contract types for backward compatibility
export type {
  ColumnType,
  RecordCell,
  RecordColumn,
  RecordEdit,
  RecordHistoryItem,
  RecordList,
  RecordRef,
  RecordRow,
  RecordsResponse,
  RecordsSaveRequest,
  RecordsSaveResponse,
  RecordsViewQuery,
  RecordValue,
};

export async function handleGetRecords(
  request: Request,
  env: Env,
  workspaceId: string,
  requestId: string,
): Promise<Response> {
  try {
    const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId);
    if (scope instanceof Response) return scope;


    const url = new URL(request.url);
    const payload = await readRecordsPage(env.DB, workspaceId, {
      list: url.searchParams.get('list') || url.searchParams.get('list_id') || undefined,
      limit: Math.min(Math.max(1, Number(url.searchParams.get('limit')) || 50), 100),
      cursor: url.searchParams.get('cursor') || undefined,
      search: (url.searchParams.get('search') || url.searchParams.get('q') || '').trim(),
      sortParam: (url.searchParams.get('sort') || '').trim(),
    });
    return jsonSuccess(payload, 200, {
      'x-request-id': requestId,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.stack || err.message : String(err);
    console.error('[otis:records get error]:', msg);
    return jsonError(500, 'internal_error', 'Unable to load records. Retry from the list; the saved data is unchanged.', requestId);
  }
}


export async function handleSaveRecords(
  request: Request,
  env: Env,
  workspaceId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId, {
    csrf: true,
  });
  if (scope instanceof Response) return scope;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) {
    return jsonError(400, 'bad_request', 'Invalid JSON body.', requestId);
  }
  const body = parsed.body as {
    listId?: string;
    list_id?: string;
    save_id?: string;
    action_id?: string;
    chunk_index?: number;
    chunk_count?: number;
    expected_revision?: number;
    operations?: RecordEdit[];
    dirtyCells?: Record<string, { columnId?: string; currentValue?: unknown; baseValue?: unknown }>;
    addedRows?: Array<{ id?: string; source?: string; cells: Record<string, unknown> }>;
    deletedRowIds?: string[];
  };

  const listId = body.list_id || body.listId;
  if (!listId) {
    return jsonError(400, 'bad_request', 'Invalid save payload: listId is required.', requestId);
  }

  const saveId = body.save_id || `save_${crypto.randomUUID()}`;
  const actionId = body.action_id || `act_rec_${crypto.randomUUID()}`;

  // 1. Convert payload into RecordEdit[] union
  const operations: RecordEdit[] = [];

  if (Array.isArray(body.operations)) {
    operations.push(...body.operations);
  } else {
    const isTask = listId === 'tasks';
    const isDraft = listId === 'drafts';
    const isNotes = listId === 'notes';
    const defaultKind = isTask ? 'task' : isDraft ? 'draft' : isNotes ? 'interaction' : (listId === 'leads' ? 'entity' : 'custom');

    // Deletions
    if (body.deletedRowIds && body.deletedRowIds.length > 0) {
      for (const delId of body.deletedRowIds) {
        operations.push({
          op: 'row.remove',
          op_id: `op_del_${delId}`,
          row_ref: { kind: defaultKind, id: delId },
        });
      }
    }

    // Additions
    if (body.addedRows && body.addedRows.length > 0) {
      for (const row of body.addedRows) {
        const rowId = row.id || `row_${crypto.randomUUID()}`;
        operations.push({
          op: 'row.create',
          op_id: `op_add_${rowId}`,
          row_ref: { kind: defaultKind, id: rowId },
          list_id: listId,
          initial_values: row.cells as Record<string, RecordValue>,
        });
      }
    }

    // Cell updates. Legacy keys are `${rowId}:${columnId}`; row ids are
    // server-generated and never contain a colon, while column ids may
    // (e.g. `leads:name`), so the row id ends at the FIRST colon. New
    // clients send the operations union directly and skip this parsing.
    if (body.dirtyCells) {
      for (const [cellKey, dirty] of Object.entries(body.dirtyCells)) {
        if (!dirty) continue;
        const separator = cellKey.indexOf(':');
        if (separator <= 0) continue;
        const rowId = cellKey.slice(0, separator);
        const colId = cellKey.slice(separator + 1);
        if (!colId) continue;
        operations.push({
          op: 'cell.set',
          op_id: `op_set_${rowId}_${colId}`,
          row_ref: { kind: defaultKind, id: rowId },
          column_id: colId,
          value: (dirty.currentValue as RecordValue) ?? null,
          base_token: dirty.baseValue !== undefined && dirty.baseValue !== null ? String(dirty.baseValue) : undefined,
        });
      }
    }
  }

  // 2. Validate bounds and the whole envelope before any effect. The ledger
  // handler re-validates; this boundary rejection keeps malformed saves out
  // with the offending op identified.
  if (operations.length > 100) {
    return jsonError(422, 'validation_error', 'Records save chunk cannot exceed 100 operations.', requestId);
  }

  if (operations.length === 0) {
    return jsonSuccess({
      saved: true,
      status: 'already_applied',
      save_id: saveId,
      action_id: actionId,
      affected_count: 0,
      affectedCount: 0,
    }, 200, { 'x-request-id': requestId });
  }

  const envelopeCheck = validateRecordsSaveRequest({
    schema_version: 1,
    save_id: saveId,
    action_id: actionId,
    list_id: listId,
    operations,
  });
  if (!envelopeCheck.valid) {
    return jsonError(400, envelopeCheck.code, envelopeCheck.op_id ? `[op ${envelopeCheck.op_id}] ${envelopeCheck.message}` : envelopeCheck.message, requestId);
  }

  // 3. Pre-validate row existence and workspace ownership on edits and
  // deletions: one batched read per touched kind, never one query per op.
  // The ledger handler re-checks against its hydrated footprint; this early
  // pass turns foreign or unknown ids into precise 404s before any commit.
  {
    const idsByKind = new Map<string, Set<string>>();
    const labelFor = (kind: string): string =>
      kind === 'entity' ? 'Entity' : kind === 'task' ? 'Task' : kind === 'draft' ? 'Draft'
        : kind === 'interaction' ? 'Interaction' : 'Row';
    for (const op of operations) {
      const ref = op.op === 'cell.set' || op.op === 'cell.clear' || op.op === 'row.remove' ? op.row_ref
        : op.op === 'item.edit' || op.op === 'item.remove' ? op.source_ref : null;
      if (!ref) continue;
      let ids = idsByKind.get(ref.kind);
      if (!ids) {
        ids = new Set();
        idsByKind.set(ref.kind, ids);
      }
      ids.add(ref.id);
    }
    const tableFor: Record<string, { table: string; column: string }> = {
      entity: { table: 'entities', column: 'id' },
      task: { table: 'tasks', column: 'id' },
      draft: { table: 'draft_projections', column: 'id' },
      interaction: { table: 'interaction_state', column: 'root_event_id' },
      custom: { table: 'records_rows', column: 'id' },
    };
    const checks: Array<Promise<{ kind: string; found: Set<string> }>> = [];
    for (const [kind, ids] of idsByKind) {
      const mapping = tableFor[kind];
      // Definitions, lists, and memory refs resolve inside the handler.
      if (!mapping) continue;
      const idList = [...ids];
      const placeholders = idList.map(() => '?').join(',');
      checks.push(
        (async () => {
          try {
            const res = await env.DB.prepare(
              `SELECT ${mapping.column} AS id FROM ${mapping.table} WHERE workspace_id = ? AND ${mapping.column} IN (${placeholders})`,
            ).bind(workspaceId, ...idList).all<{ id: string }>();
            return { kind, found: new Set((res.results || []).map((r) => r.id)) };
          } catch (err) {
            // Pre-records databases have no custom-row table: every custom
            // ref is then unknown, which the handler reports as not_found.
            if (!String(err).includes('no such table')) throw err;
            return { kind, found: new Set<string>() };
          }
        })(),
      );
    }
    const settled = await Promise.all(checks);
    for (const { kind, found } of settled) {
      for (const id of idsByKind.get(kind) ?? []) {
        if (!found.has(id)) {
          return jsonError(404, 'not_found', `${labelFor(kind)} '${id}' not found in this workspace.`, requestId);
        }
      }
    }
  }

  // 4. Inbound message tracking for ledger provenance (inserted inside the guarded batch)
  const now = new Date().toISOString();
  const msgId = `min_${crypto.randomUUID()}`;
  const msgFingerprint = await computeHash(JSON.stringify({ save_id: saveId, action_id: actionId, list_id: listId }));
  const extraStatements = [
    env.DB.prepare(
      `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, raw_payload, status, created_at, updated_at)
       VALUES (?, ?, ?, 'web', ?, ?, ?, 'processed', ?, ?)`,
    ).bind(
      msgId,
      workspaceId,
      scope.user.id,
      `records_save_${actionId}`,
      msgFingerprint,
      JSON.stringify({ save_id: saveId, action_id: actionId, list_id: listId, op_count: operations.length }),
      now,
      now,
    ),
  ];

  // 6. Read workspace revision and execute guarded ledger command
  const wsMeta = await getWorkspaceRevision(env.DB, workspaceId);
  if (!wsMeta) {
    return jsonError(404, 'workspace_not_found', 'Workspace not found.', requestId);
  }
  const expectedRevision = body.expected_revision ?? wsMeta.business_revision;
  const membershipRevision = await readMembershipRevision(env.DB, workspaceId);

  const commandContext = {
    workspace_id: workspaceId,
    action_id: actionId,
    expected_business_revision: expectedRevision,
    actor: { kind: 'member' as const, user_id: scope.user.id },
    membership_revision: membershipRevision,
    request_id: requestId,
    source_channel: 'web' as const,
    source_message_id: msgId,
  };

  const result = await executeLedgerCommand(
    env.DB,
    commandContext,
    'records_batch',
    {
      save_id: saveId,
      action_id: actionId,
      list_id: listId,
      chunk_index: body.chunk_index ?? 0,
      chunk_count: body.chunk_count ?? 1,
      operations,
    },
    handleRecordsBatch,
    extraStatements,
    { extrasBeforeGuard: true },
  );

  if (result.status === 'conflict') {
    const detail = (result as unknown as { data?: { conflict?: unknown }; summary?: string })?.data?.conflict
      ?? (result as unknown as { summary?: string })?.summary;
    return jsonError(409, 'conflict', result.error?.message || 'Conflict detected.', requestId, false, {
      conflict: detail,
    });
  }

  if (result.status === 'rejected') {
    return jsonError(400, result.error?.code || 'rejected', result.error?.message || 'Operation rejected.', requestId);
  }

  if (result.status === 'needs_clarification') {
    return jsonError(422, 'needs_clarification', result.summary || 'This save needs a missing detail before it can commit.', requestId);
  }

  const resultData = (result.data || {}) as {
    affected_count?: number;
    affected_values?: Array<{ row_ref: RecordRef; column_id: string; value: RecordValue; version: string }>;
    id_mappings?: Record<string, string>;
  };
  const affectedCount = resultData.affected_count ?? 0;

  let committedRevision = result.committed_revision;
  if (committedRevision === undefined) {
    const refreshed = await getWorkspaceRevision(env.DB, workspaceId);
    committedRevision = refreshed?.business_revision;
  }

  const responsePayload: RecordsSaveResponse & { saved: boolean; affectedCount: number } = {
    saved: true,
    status: result.status as 'applied' | 'already_applied',
    save_id: saveId,
    action_id: actionId,
    affected_count: affectedCount,
    affectedCount,
    affected_values: resultData.affected_values,
    id_mappings: resultData.id_mappings,
    committed_revision: committedRevision,
  };

  return jsonSuccess(responsePayload, 200, {
    'x-request-id': requestId,
  });
}
