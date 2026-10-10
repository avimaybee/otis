/**
 * @otis/ledger/reducers/records
 * Pure reducers for records flexibility and custom row/definition events.
 * In accordance with plans/editable-records.md Sections 5, 8, and 12.
 */

import type { LedgerEvent, PersistedRecordsList, PersistedRecordsListColumn, PersistedRecordsRow, PersistedRecordsValue, PersistedFieldDef } from '@otis/contracts';
import { fieldStorageType } from '@otis/contracts';
import type { LedgerProjectionState } from '../types.js';

/** UI-type marker preserved inside options_json for display types sharing string storage. */
function fieldUiTypeMarker(type: string): Record<string, string> {
  return type === 'phone' || type === 'email' ? { ui_type: type } : {};
}

export function ensureRecordsState(state: LedgerProjectionState): {
  recordsLists: Map<string, PersistedRecordsList>;
  recordsListColumns: Map<string, PersistedRecordsListColumn>;
  recordsRows: Map<string, PersistedRecordsRow>;
  recordsValues: Map<string, PersistedRecordsValue>;
  fieldDefinitions: Map<string, PersistedFieldDef>;
} {
  if (!state.recordsLists) state.recordsLists = new Map();
  if (!state.recordsListColumns) state.recordsListColumns = new Map();
  if (!state.recordsRows) state.recordsRows = new Map();
  if (!state.recordsValues) state.recordsValues = new Map();
  if (!state.fieldDefinitions) state.fieldDefinitions = new Map();
  return {
    recordsLists: state.recordsLists,
    recordsListColumns: state.recordsListColumns,
    recordsRows: state.recordsRows,
    recordsValues: state.recordsValues,
    fieldDefinitions: state.fieldDefinitions,
  };
}

export function reduceRecords(state: LedgerProjectionState, event: LedgerEvent): void {
  const { recordsLists, recordsListColumns, recordsRows, recordsValues, fieldDefinitions } = ensureRecordsState(state);
  const p = (event.payload ?? {}) as Record<string, unknown>;

  switch (event.kind) {
    case 'record_list_created': {
      const listId = String(p['list_id'] || '');
      if (!listId) return;
      const key = `${event.workspace_id}:${listId}`;
      recordsLists.set(key, {
        workspace_id: event.workspace_id,
        id: listId,
        name: String(p['name'] || listId),
        source_kind: (p['source_kind'] as PersistedRecordsList['source_kind']) || 'custom',
        status: 'active',
        revision: 1,
        source_event_id: event.id,
        created_at: event.recorded_at,
        updated_at: event.recorded_at,
      });
      break;
    }

    case 'record_list_updated': {
      const listId = String(p['list_id'] || '');
      if (!listId) return;
      const key = `${event.workspace_id}:${listId}`;
      const existing = recordsLists.get(key);
      if (existing) {
        recordsLists.set(key, {
          ...existing,
          name: p['name'] ? String(p['name']) : existing.name,
          revision: existing.revision + 1,
          source_event_id: event.id,
          updated_at: event.recorded_at,
        });
      }
      break;
    }

    case 'record_list_archived': {
      const listId = String(p['list_id'] || '');
      if (!listId) return;
      const key = `${event.workspace_id}:${listId}`;
      const existing = recordsLists.get(key);
      if (existing) {
        recordsLists.set(key, {
          ...existing,
          status: 'archived',
          revision: existing.revision + 1,
          source_event_id: event.id,
          updated_at: event.recorded_at,
        });
      }
      break;
    }

    case 'record_list_restored': {
      const listId = String(p['list_id'] || '');
      if (!listId) return;
      const key = `${event.workspace_id}:${listId}`;
      const existing = recordsLists.get(key);
      if (existing) {
        recordsLists.set(key, {
          ...existing,
          status: 'active',
          revision: existing.revision + 1,
          source_event_id: event.id,
          updated_at: event.recorded_at,
        });
      }
      break;
    }

    case 'record_column_created': {
      const colId = String(p['column_id'] || '');
      const listId = String(p['list_id'] || '');
      if (!colId || !listId) return;
      const key = `${event.workspace_id}:${colId}`;
      recordsListColumns.set(key, {
        workspace_id: event.workspace_id,
        id: colId,
        list_id: listId,
        field_id: p['field_id'] ? String(p['field_id']) : null,
        is_core: Boolean(p['is_core']),
        core_binding_json: p['core_binding_json'] ? String(p['core_binding_json']) : (p['binding'] ? JSON.stringify(p['binding']) : null),
        position: typeof p['position'] === 'number' ? p['position'] : recordsListColumns.size,
        visible: p['visible'] !== false,
        width: typeof p['width'] === 'number' ? p['width'] : null,
        revision: 1,
        source_event_id: event.id,
        created_at: event.recorded_at,
        updated_at: event.recorded_at,
      });
      break;
    }

    case 'record_column_updated': {
      const colId = String(p['column_id'] || '');
      if (!colId) return;
      const key = `${event.workspace_id}:${colId}`;
      const existing = recordsListColumns.get(key);
      if (existing) {
        recordsListColumns.set(key, {
          ...existing,
          width: p['width'] !== undefined ? (typeof p['width'] === 'number' ? p['width'] : null) : existing.width,
          position: typeof p['position'] === 'number' ? p['position'] : existing.position,
          visible: p['visible'] !== undefined ? Boolean(p['visible']) : existing.visible,
          revision: existing.revision + 1,
          source_event_id: event.id,
          updated_at: event.recorded_at,
        });
      }
      break;
    }

    case 'record_column_archived': {
      const colId = String(p['column_id'] || '');
      if (!colId) return;
      const key = `${event.workspace_id}:${colId}`;
      const existing = recordsListColumns.get(key);
      if (existing) {
        recordsListColumns.set(key, {
          ...existing,
          visible: false,
          revision: existing.revision + 1,
          source_event_id: event.id,
          updated_at: event.recorded_at,
        });
      }
      break;
    }

    case 'record_column_restored': {
      const colId = String(p['column_id'] || '');
      if (!colId) return;
      const key = `${event.workspace_id}:${colId}`;
      const existing = recordsListColumns.get(key);
      if (existing) {
        recordsListColumns.set(key, {
          ...existing,
          visible: true,
          revision: existing.revision + 1,
          source_event_id: event.id,
          updated_at: event.recorded_at,
        });
      }
      break;
    }

    case 'field_definition_created': {
      const fieldId = String(p['field_id'] || '');
      if (!fieldId) return;
      const storage = fieldStorageType(String(p['type'] || 'text') as import('@otis/contracts').ColumnType);
      if (!storage) return;
      // The row id is workspace-qualified (the table PK is global); the
      // short field name keys state, columns, and entity bindings.
      const key = `${event.workspace_id}:${fieldId}`;
      const options = p['options'] !== undefined && p['options'] !== null
        ? { ...(p['options'] as Record<string, unknown>), ...fieldUiTypeMarker(String(p['type'] || 'text')) }
        : fieldUiTypeMarker(String(p['type'] || 'text'));
      fieldDefinitions.set(key, {
        workspace_id: event.workspace_id,
        id: `${event.workspace_id}:${fieldId}`,
        field_name: fieldId,
        display_label: String(p['label'] || fieldId),
        value_type: storage,
        options_json: options && Object.keys(options).length > 0 ? JSON.stringify(options) : null,
        calculation_json: null,
        created_at: event.recorded_at,
        updated_at: event.recorded_at,
      });
      break;
    }

    case 'field_definition_updated': {
      const fieldId = String(p['field_id'] || '');
      if (!fieldId) return;
      const key = `${event.workspace_id}:${fieldId}`;
      const existing = fieldDefinitions.get(key);
      if (existing) {
        const nextType = p['type'] !== undefined ? String(p['type']) : null;
        const nextStorage = nextType
          ? fieldStorageType(nextType as import('@otis/contracts').ColumnType)
          : existing.value_type;
        const nextOptions = p['options'] !== undefined
          ? (p['options'] ? JSON.stringify({
            ...(p['options'] as Record<string, unknown>),
            ...fieldUiTypeMarker(nextType ?? existing.value_type),
          }) : null)
          : existing.options_json;
        fieldDefinitions.set(key, {
          ...existing,
          display_label: p['label'] ? String(p['label']) : existing.display_label,
          value_type: nextStorage ?? existing.value_type,
          options_json: nextOptions,
          updated_at: event.recorded_at,
        });
      }
      break;
    }

    case 'calculation_defined': {
      const fieldId = String(p['field_id'] || '');
      if (!fieldId) return;
      const key = `${event.workspace_id}:${fieldId}`;
      const existing = fieldDefinitions.get(key);
      if (existing) {
        fieldDefinitions.set(key, {
          ...existing,
          calculation_json: JSON.stringify({
            expression_tree: p['expression_tree'],
            description: p['description'] ? String(p['description']) : '',
          }),
          updated_at: event.recorded_at,
        });
      }
      break;
    }

    case 'record_row_created': {
      const rowRef = p['row_ref'] as { kind?: string; id?: string } | undefined;
      const listId = String(p['list_id'] || '');
      if (!rowRef || !rowRef.id || !listId) return;
      if (rowRef.kind === 'custom') {
        const rowKey = `${event.workspace_id}:${rowRef.id}`;
        recordsRows.set(rowKey, {
          workspace_id: event.workspace_id,
          id: rowRef.id,
          list_id: listId,
          status: 'active',
          revision: 1,
          source_event_id: event.id,
          created_at: event.recorded_at,
          updated_at: event.recorded_at,
        });

        const initialValues = p['initial_values'] as Record<string, unknown> | undefined;
        if (initialValues) {
          for (const [colId, val] of Object.entries(initialValues)) {
            const valKey = `${event.workspace_id}:${rowRef.id}:${colId}`;
            recordsValues.set(valKey, {
              workspace_id: event.workspace_id,
              row_id: rowRef.id,
              column_id: colId,
              value_json: typeof val === 'object' && val !== null ? JSON.stringify(val) : null,
              value_text: typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean' ? String(val) : null,
              revision: 1,
              source_event_id: event.id,
              updated_at: event.recorded_at,
            });
          }
        }
      }
      break;
    }

    case 'record_row_archived': {
      const rowRef = p['row_ref'] as { kind?: string; id?: string } | undefined;
      if (!rowRef || !rowRef.id || rowRef.kind !== 'custom') return;
      const rowKey = `${event.workspace_id}:${rowRef.id}`;
      const existing = recordsRows.get(rowKey);
      if (existing) {
        recordsRows.set(rowKey, {
          ...existing,
          status: 'archived',
          revision: existing.revision + 1,
          source_event_id: event.id,
          updated_at: event.recorded_at,
        });
      }
      break;
    }

    case 'record_row_restored': {
      const rowRef = p['row_ref'] as { kind?: string; id?: string } | undefined;
      if (!rowRef || !rowRef.id || rowRef.kind !== 'custom') return;
      const rowKey = `${event.workspace_id}:${rowRef.id}`;
      const existing = recordsRows.get(rowKey);
      if (existing) {
        recordsRows.set(rowKey, {
          ...existing,
          status: 'active',
          revision: existing.revision + 1,
          source_event_id: event.id,
          updated_at: event.recorded_at,
        });
      }
      break;
    }

    case 'record_cell_changed': {
      const rowRef = p['row_ref'] as { kind?: string; id?: string } | undefined;
      const colId = String(p['column_id'] || '');
      if (!rowRef || !rowRef.id || !colId || rowRef.kind !== 'custom') return;
      const valKey = `${event.workspace_id}:${rowRef.id}:${colId}`;
      const val = p['value'];
      const existing = recordsValues.get(valKey);
      if (val === null || val === undefined) {
        recordsValues.delete(valKey);
      } else {
        recordsValues.set(valKey, {
          workspace_id: event.workspace_id,
          row_id: rowRef.id,
          column_id: colId,
          value_json: typeof val === 'object' && val !== null ? JSON.stringify(val) : null,
          value_text: typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean' ? String(val) : null,
          revision: (existing?.revision ?? 0) + 1,
          source_event_id: event.id,
          updated_at: event.recorded_at,
        });
      }
      break;
    }
  }
}
