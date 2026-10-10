/**
 * @otis/ledger/repository/records
 * D1 database hydration and changed-only persistence for records tables:
 * records_lists, records_list_columns, records_rows, records_values, and field_defs.
 * In accordance with plans/editable-records.md Sections 5, 8, and 12.
 */

import type {
  PersistedFieldDef,
  PersistedRecordsList,
  PersistedRecordsListColumn,
  PersistedRecordsRow,
  PersistedRecordsValue,
} from '@otis/contracts';
import type { LedgerProjectionState } from '../types.js';
import { ensureRecordsState } from '../reducers/records.js';

export async function hydrateRecordsDetails(
  db: D1Database,
  workspaceId: string,
  state: LedgerProjectionState,
  listId?: string,
): Promise<void> {
  const { recordsLists, recordsListColumns, recordsRows, recordsValues, fieldDefinitions } =
    ensureRecordsState(state);

  try {
    const listSql = listId
      ? `SELECT * FROM records_lists WHERE workspace_id = ? AND id = ?`
      : `SELECT * FROM records_lists WHERE workspace_id = ?`;
    const listParams = listId ? [workspaceId, listId] : [workspaceId];

    const colSql = listId
      ? `SELECT * FROM records_list_columns WHERE workspace_id = ? AND list_id = ?`
      : `SELECT * FROM records_list_columns WHERE workspace_id = ?`;
    const colParams = listId ? [workspaceId, listId] : [workspaceId];

    const rowSql = listId
      ? `SELECT * FROM records_rows WHERE workspace_id = ? AND list_id = ?`
      : `SELECT * FROM records_rows WHERE workspace_id = ?`;
    const rowParams = listId ? [workspaceId, listId] : [workspaceId];

    const results = await db.batch([
      db.prepare(listSql).bind(...listParams),
      db.prepare(colSql).bind(...colParams),
      db.prepare(rowSql).bind(...rowParams),
      db.prepare(`SELECT * FROM records_values WHERE workspace_id = ?`).bind(workspaceId),
      db.prepare(`SELECT * FROM field_defs WHERE workspace_id = ?`).bind(workspaceId),
    ]);

    const lists = ((results[0] as unknown as { results?: Record<string, unknown>[] }).results ?? []);
    for (const r of lists) {
      const row: PersistedRecordsList = {
        workspace_id: String(r['workspace_id']),
        id: String(r['id']),
        name: String(r['name']),
        source_kind: r['source_kind'] as PersistedRecordsList['source_kind'],
        status: r['status'] as PersistedRecordsList['status'],
        revision: Number(r['revision'] ?? 1),
        source_event_id: r['source_event_id'] ? String(r['source_event_id']) : null,
        created_at: String(r['created_at']),
        updated_at: String(r['updated_at']),
      };
      recordsLists.set(`${workspaceId}:${row.id}`, row);
    }

    const columns = ((results[1] as unknown as { results?: Record<string, unknown>[] }).results ?? []);
    for (const r of columns) {
      const row: PersistedRecordsListColumn = {
        workspace_id: String(r['workspace_id']),
        id: String(r['id']),
        list_id: String(r['list_id']),
        field_id: r['field_id'] ? String(r['field_id']) : null,
        is_core: Number(r['is_core'] ?? 0) === 1,
        core_binding_json: r['core_binding_json'] ? String(r['core_binding_json']) : null,
        position: Number(r['position'] ?? 0),
        visible: Number(r['visible'] ?? 1) === 1,
        width: r['width'] !== null && r['width'] !== undefined ? Number(r['width']) : null,
        revision: Number(r['revision'] ?? 1),
        source_event_id: r['source_event_id'] ? String(r['source_event_id']) : null,
        created_at: String(r['created_at']),
        updated_at: String(r['updated_at']),
      };
      recordsListColumns.set(`${workspaceId}:${row.id}`, row);
    }

    const rows = ((results[2] as unknown as { results?: Record<string, unknown>[] }).results ?? []);
    for (const r of rows) {
      const row: PersistedRecordsRow = {
        workspace_id: String(r['workspace_id']),
        id: String(r['id']),
        list_id: String(r['list_id']),
        status: r['status'] as PersistedRecordsRow['status'],
        revision: Number(r['revision'] ?? 1),
        source_event_id: r['source_event_id'] ? String(r['source_event_id']) : null,
        created_at: String(r['created_at']),
        updated_at: String(r['updated_at']),
      };
      recordsRows.set(`${workspaceId}:${row.id}`, row);
    }

    const values = ((results[3] as unknown as { results?: Record<string, unknown>[] }).results ?? []);
    for (const r of values) {
      const row: PersistedRecordsValue = {
        workspace_id: String(r['workspace_id']),
        row_id: String(r['row_id']),
        column_id: String(r['column_id']),
        value_json: r['value_json'] ? String(r['value_json']) : null,
        value_text: r['value_text'] ? String(r['value_text']) : null,
        revision: Number(r['revision'] ?? 1),
        source_event_id: r['source_event_id'] ? String(r['source_event_id']) : null,
        updated_at: String(r['updated_at']),
      };
      recordsValues.set(`${workspaceId}:${row.row_id}:${row.column_id}`, row);
    }

    const defs = ((results[4] as unknown as { results?: Record<string, unknown>[] }).results ?? []);
    for (const r of defs) {
      const row: PersistedFieldDef = {
        workspace_id: String(r['workspace_id']),
        id: String(r['id']),
        field_name: String(r['field_name'] ?? r['id']),
        display_label: String(r['display_label'] ?? r['field_name'] ?? r['id']),
        value_type: r['value_type'] as PersistedFieldDef['value_type'],
        options_json: r['options_json'] ? String(r['options_json']) : null,
        calculation_json: r['calculation_json'] ? String(r['calculation_json']) : null,
        created_at: String(r['created_at']),
        updated_at: String(r['updated_at']),
      };
      fieldDefinitions.set(`${workspaceId}:${row.field_name}`, row);
    }
  } catch (err) {
    if (!String(err).includes('no such table')) throw err;
  }
}

/**
 * Generates changed-only atomic persistence statements for records tables.
 * FK-safe: values deleted before rows; rows/columns deleted before lists.
 * Created/changed: lists before rows/columns; rows before values.
 */
export function recordsDetailStatements(
  db: D1Database,
  before: LedgerProjectionState,
  after: LedgerProjectionState,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];

  const priorValues = before.recordsValues ?? new Map<string, PersistedRecordsValue>();
  const nextValues = after.recordsValues ?? new Map<string, PersistedRecordsValue>();

  const priorRows = before.recordsRows ?? new Map<string, PersistedRecordsRow>();
  const nextRows = after.recordsRows ?? new Map<string, PersistedRecordsRow>();

  const priorCols = before.recordsListColumns ?? new Map<string, PersistedRecordsListColumn>();
  const nextCols = after.recordsListColumns ?? new Map<string, PersistedRecordsListColumn>();

  const priorLists = before.recordsLists ?? new Map<string, PersistedRecordsList>();
  const nextLists = after.recordsLists ?? new Map<string, PersistedRecordsList>();

  const priorDefs = before.fieldDefinitions ?? new Map<string, PersistedFieldDef>();
  const nextDefs = after.fieldDefinitions ?? new Map<string, PersistedFieldDef>();

  // 1. Deletions (reverse FK dependency order)
  // Delete missing values
  for (const [key, val] of priorValues) {
    if (!nextValues.has(key)) {
      statements.push(
        db
          .prepare(
            `DELETE FROM records_values WHERE workspace_id = ? AND row_id = ? AND column_id = ?`,
          )
          .bind(val.workspace_id, val.row_id, val.column_id),
      );
    }
  }

  // Delete missing rows
  for (const [key, row] of priorRows) {
    if (!nextRows.has(key)) {
      statements.push(
        db
          .prepare(`DELETE FROM records_rows WHERE workspace_id = ? AND id = ?`)
          .bind(row.workspace_id, row.id),
      );
    }
  }

  // Delete missing list columns
  for (const [key, col] of priorCols) {
    if (!nextCols.has(key)) {
      statements.push(
        db
          .prepare(`DELETE FROM records_list_columns WHERE workspace_id = ? AND id = ?`)
          .bind(col.workspace_id, col.id),
      );
    }
  }

  // Delete missing lists
  for (const [key, list] of priorLists) {
    if (!nextLists.has(key)) {
      statements.push(
        db
          .prepare(`DELETE FROM records_lists WHERE workspace_id = ? AND id = ?`)
          .bind(list.workspace_id, list.id),
      );
    }
  }

  // Delete missing field defs
  for (const [key, def] of priorDefs) {
    if (!nextDefs.has(key)) {
      statements.push(
        db
          .prepare(`DELETE FROM field_defs WHERE workspace_id = ? AND id = ?`)
          .bind(def.workspace_id, def.id),
      );
    }
  }

  // 2. Created and changed field_defs
  for (const [key, def] of nextDefs) {
    const prior = priorDefs.get(key);
    if (!prior || JSON.stringify(prior) !== JSON.stringify(def)) {
      statements.push(
        db
          .prepare(
            `INSERT INTO field_defs (workspace_id, id, field_name, display_label, value_type, is_core, is_active, options_json, calculation_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               field_name = excluded.field_name,
               display_label = excluded.display_label,
               value_type = excluded.value_type,
               options_json = excluded.options_json,
               calculation_json = excluded.calculation_json,
               updated_at = excluded.updated_at`,
          )
          .bind(
            def.workspace_id,
            def.id,
            def.field_name,
            def.display_label,
            def.value_type,
            def.options_json ?? null,
            def.calculation_json ?? null,
            def.created_at,
            def.updated_at,
          ),
      );
    }
  }

  // 3. Created and changed records_lists
  for (const [key, list] of nextLists) {
    const prior = priorLists.get(key);
    if (!prior || JSON.stringify(prior) !== JSON.stringify(list)) {
      statements.push(
        db
          .prepare(
            `INSERT INTO records_lists (workspace_id, id, name, source_kind, status, revision, source_event_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(workspace_id, id) DO UPDATE SET
               name = excluded.name,
               source_kind = excluded.source_kind,
               status = excluded.status,
               revision = excluded.revision,
               source_event_id = excluded.source_event_id,
               updated_at = excluded.updated_at`,
          )
          .bind(
            list.workspace_id,
            list.id,
            list.name,
            list.source_kind,
            list.status,
            list.revision,
            list.source_event_id ?? null,
            list.created_at,
            list.updated_at,
          ),
      );
    }
  }

  // 4. Created and changed records_list_columns
  for (const [key, col] of nextCols) {
    const prior = priorCols.get(key);
    if (!prior || JSON.stringify(prior) !== JSON.stringify(col)) {
      statements.push(
        db
          .prepare(
            `INSERT INTO records_list_columns (workspace_id, id, list_id, field_id, is_core, core_binding_json, position, visible, width, revision, source_event_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(workspace_id, id) DO UPDATE SET
               list_id = excluded.list_id,
               field_id = excluded.field_id,
               is_core = excluded.is_core,
               core_binding_json = excluded.core_binding_json,
               position = excluded.position,
               visible = excluded.visible,
               width = excluded.width,
               revision = excluded.revision,
               source_event_id = excluded.source_event_id,
               updated_at = excluded.updated_at`,
          )
          .bind(
            col.workspace_id,
            col.id,
            col.list_id,
            col.field_id ?? null,
            col.is_core ? 1 : 0,
            col.core_binding_json ?? null,
            col.position,
            col.visible ? 1 : 0,
            col.width ?? null,
            col.revision,
            col.source_event_id ?? null,
            col.created_at,
            col.updated_at,
          ),
      );
    }
  }

  // 5. Created and changed records_rows
  for (const [key, row] of nextRows) {
    const prior = priorRows.get(key);
    if (!prior || JSON.stringify(prior) !== JSON.stringify(row)) {
      statements.push(
        db
          .prepare(
            `INSERT INTO records_rows (workspace_id, id, list_id, status, revision, source_event_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(workspace_id, id) DO UPDATE SET
               list_id = excluded.list_id,
               status = excluded.status,
               revision = excluded.revision,
               source_event_id = excluded.source_event_id,
               updated_at = excluded.updated_at`,
          )
          .bind(
            row.workspace_id,
            row.id,
            row.list_id,
            row.status,
            row.revision,
            row.source_event_id ?? null,
            row.created_at,
            row.updated_at,
          ),
      );
    }
  }

  // 6. Created and changed records_values
  for (const [key, val] of nextValues) {
    const prior = priorValues.get(key);
    if (!prior || JSON.stringify(prior) !== JSON.stringify(val)) {
      statements.push(
        db
          .prepare(
            `INSERT INTO records_values (workspace_id, row_id, column_id, value_json, value_text, revision, source_event_id, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(workspace_id, row_id, column_id) DO UPDATE SET
               value_json = excluded.value_json,
               value_text = excluded.value_text,
               revision = excluded.revision,
               source_event_id = excluded.source_event_id,
               updated_at = excluded.updated_at`,
          )
          .bind(
            val.workspace_id,
            val.row_id,
            val.column_id,
            val.value_json ?? null,
            val.value_text ?? null,
            val.revision,
            val.source_event_id ?? null,
            val.updated_at,
          ),
      );
    }
  }

  return statements;
}

function chunkIds(ids: string[], size = 90): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  return chunks;
}

function inClause(count: number): string {
  return `(${Array.from({ length: count }, () => '?').join(',')})`;
}

export interface RecordsHydrationScope {
  listIds: string[];
  rowIds: string[];
  fieldIds: string[];
  columnIds: string[];
}

/**
 * Scoped records hydration for the records_batch footprint: only the
 * touched lists, their columns, the touched custom rows and their values,
 * and the touched field definitions. Unknown ids simply load nothing, so
 * the handler fails closed with not_found instead of reading absence.
 * Tolerant of pre-0030 databases like the workspace-wide variant.
 */
export async function hydrateRecordsScope(
  db: D1Database,
  workspaceId: string,
  state: LedgerProjectionState,
  scope: RecordsHydrationScope,
): Promise<void> {
  const { recordsLists, recordsListColumns, recordsRows, recordsValues, fieldDefinitions } =
    ensureRecordsState(state);
  const statements: D1PreparedStatement[] = [];
  const readers: Array<(rows: Record<string, unknown>[]) => void> = [];

  for (const chunk of chunkIds([...new Set(scope.listIds)])) {
    if (!chunk.length) continue;
    statements.push(
      db.prepare(`SELECT * FROM records_lists WHERE workspace_id = ? AND id IN ${inClause(chunk.length)}`).bind(workspaceId, ...chunk),
    );
    readers.push((rows) => {
      for (const r of rows) {
        const row: PersistedRecordsList = {
          workspace_id: String(r['workspace_id']),
          id: String(r['id']),
          name: String(r['name']),
          source_kind: r['source_kind'] as PersistedRecordsList['source_kind'],
          status: r['status'] as PersistedRecordsList['status'],
          revision: Number(r['revision'] ?? 1),
          source_event_id: r['source_event_id'] ? String(r['source_event_id']) : null,
          created_at: String(r['created_at']),
          updated_at: String(r['updated_at']),
        };
        recordsLists.set(`${workspaceId}:${row.id}`, row);
      }
    });
    statements.push(
      db.prepare(`SELECT * FROM records_list_columns WHERE workspace_id = ? AND list_id IN ${inClause(chunk.length)}`).bind(workspaceId, ...chunk),
    );
    readers.push((rows) => {
      for (const r of rows) {
        const row: PersistedRecordsListColumn = {
          workspace_id: String(r['workspace_id']),
          id: String(r['id']),
          list_id: String(r['list_id']),
          field_id: r['field_id'] ? String(r['field_id']) : null,
          is_core: Number(r['is_core'] ?? 0) === 1,
          core_binding_json: r['core_binding_json'] ? String(r['core_binding_json']) : null,
          position: Number(r['position'] ?? 0),
          visible: Number(r['visible'] ?? 1) === 1,
          width: r['width'] !== null && r['width'] !== undefined ? Number(r['width']) : null,
          revision: Number(r['revision'] ?? 1),
          source_event_id: r['source_event_id'] ? String(r['source_event_id']) : null,
          created_at: String(r['created_at']),
          updated_at: String(r['updated_at']),
        };
        recordsListColumns.set(`${workspaceId}:${row.id}`, row);
      }
    });
  }

  for (const chunk of chunkIds([...new Set(scope.columnIds)])) {
    if (!chunk.length) continue;
    statements.push(
      db.prepare(`SELECT * FROM records_list_columns WHERE workspace_id = ? AND id IN ${inClause(chunk.length)}`).bind(workspaceId, ...chunk),
    );
    readers.push((rows) => {
      for (const r of rows) {
        const row: PersistedRecordsListColumn = {
          workspace_id: String(r['workspace_id']),
          id: String(r['id']),
          list_id: String(r['list_id']),
          field_id: r['field_id'] ? String(r['field_id']) : null,
          is_core: Number(r['is_core'] ?? 0) === 1,
          core_binding_json: r['core_binding_json'] ? String(r['core_binding_json']) : null,
          position: Number(r['position'] ?? 0),
          visible: Number(r['visible'] ?? 1) === 1,
          width: r['width'] !== null && r['width'] !== undefined ? Number(r['width']) : null,
          revision: Number(r['revision'] ?? 1),
          source_event_id: r['source_event_id'] ? String(r['source_event_id']) : null,
          created_at: String(r['created_at']),
          updated_at: String(r['updated_at']),
        };
        recordsListColumns.set(`${workspaceId}:${row.id}`, row);
      }
    });
  }

  for (const chunk of chunkIds([...new Set(scope.rowIds)])) {
    if (!chunk.length) continue;
    statements.push(
      db.prepare(`SELECT * FROM records_rows WHERE workspace_id = ? AND id IN ${inClause(chunk.length)}`).bind(workspaceId, ...chunk),
    );
    readers.push((rows) => {
      for (const r of rows) {
        const row: PersistedRecordsRow = {
          workspace_id: String(r['workspace_id']),
          id: String(r['id']),
          list_id: String(r['list_id']),
          status: r['status'] as PersistedRecordsRow['status'],
          revision: Number(r['revision'] ?? 1),
          source_event_id: r['source_event_id'] ? String(r['source_event_id']) : null,
          created_at: String(r['created_at']),
          updated_at: String(r['updated_at']),
        };
        recordsRows.set(`${workspaceId}:${row.id}`, row);
      }
    });
    statements.push(
      db.prepare(`SELECT * FROM records_values WHERE workspace_id = ? AND row_id IN ${inClause(chunk.length)}`).bind(workspaceId, ...chunk),
    );
    readers.push((rows) => {
      for (const r of rows) {
        const row: PersistedRecordsValue = {
          workspace_id: String(r['workspace_id']),
          row_id: String(r['row_id']),
          column_id: String(r['column_id']),
          value_json: r['value_json'] ? String(r['value_json']) : null,
          value_text: r['value_text'] ? String(r['value_text']) : null,
          revision: Number(r['revision'] ?? 1),
          source_event_id: r['source_event_id'] ? String(r['source_event_id']) : null,
          updated_at: String(r['updated_at']),
        };
        recordsValues.set(`${workspaceId}:${row.row_id}:${row.column_id}`, row);
      }
    });
  }

  // Definitions carry a workspace-qualified row id but are addressed by
  // short field name everywhere else; match either (45 per chunk keeps the
  // doubled bind list inside the 100-bind budget).
  for (const chunk of chunkIds([...new Set(scope.fieldIds)], 45)) {
    if (!chunk.length) continue;
    statements.push(
      db.prepare(`SELECT * FROM field_defs WHERE workspace_id = ? AND (id IN ${inClause(chunk.length)} OR field_name IN ${inClause(chunk.length)})`).bind(workspaceId, ...chunk, ...chunk),
    );
    readers.push((rows) => {
      for (const r of rows) {
        const row: PersistedFieldDef = {
          workspace_id: String(r['workspace_id']),
          id: String(r['id']),
          field_name: String(r['field_name'] ?? r['id']),
          display_label: String(r['display_label'] ?? r['field_name'] ?? r['id']),
          value_type: r['value_type'] as PersistedFieldDef['value_type'],
          options_json: r['options_json'] ? String(r['options_json']) : null,
          calculation_json: r['calculation_json'] ? String(r['calculation_json']) : null,
          created_at: String(r['created_at']),
          updated_at: String(r['updated_at']),
        };
        fieldDefinitions.set(`${workspaceId}:${row.field_name}`, row);
      }
    });
  }

  if (!statements.length) return;
  try {
    const loaded = await db.batch(statements);
    loaded.forEach((result, index) => {
      readers[index]?.(((result as unknown as { results?: Record<string, unknown>[] }).results ?? []));
    });
  } catch (err) {
    if (!String(err).includes('no such table')) throw err;
  }
}
