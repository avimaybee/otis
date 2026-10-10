/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { applyOpsToBase, buildRecordsContext, mergeRecordsPatch } from '../src/components/records/useRecordsDraft.js';
import type { RecordRow } from '../src/components/records/types.js';

function baseRow(id: string, cells: Record<string, string>, versions: Record<string, string>): RecordRow {
  const record_cells: RecordRow['record_cells'] = {};
  for (const [columnId, value] of Object.entries(cells)) {
    record_cells[columnId] = {
      value,
      state: 'clear',
      version: versions[columnId] ?? 'v0',
      binding: { kind: 'custom_row_value', column_id: columnId },
      editable: true,
    };
  }
  return { id, ref: { kind: 'custom', id }, cells, record_cells };
}

describe('records draft merge (R16 Slice E)', () => {  it('attaches saved preconditions and drops invalid ops', () => {
    const base = [baseRow('row_1', { note: 'Hello' }, { note: 'v_base_9' })];
    const merged = mergeRecordsPatch(base, [
      { op: 'cell.set', op_id: 'op_a', row_ref: { kind: 'custom', id: 'row_1' }, column_id: 'note', value: 'Hello Otis' },
      { op: 'cell.frobnicate', op_id: 'op_bad' } as never,
      { op: 'cell.set', op_id: 'op_b', row_ref: { kind: 'custom', id: 'row_new' }, column_id: 'note', value: 'Fresh' },
    ]);
    expect(merged).toEqual([
      {
        op: 'cell.set', op_id: 'op_a',
        row_ref: { kind: 'custom', id: 'row_1' }, column_id: 'note',
        value: 'Hello Otis', base_token: 'v_base_9',
      },
      {
        op: 'cell.set', op_id: 'op_b',
        row_ref: { kind: 'custom', id: 'row_new' }, column_id: 'note', value: 'Fresh',
      },
    ]);
  });

  it('overlays merged patches onto the base without touching saved state', () => {
    const base = {
      revision: 4,
      rows: [baseRow('row_1', { note: 'Hello' }, { note: 'v_base_9' })],
      columns: [{ id: 'note', name: 'Note', type: 'text' as const }],
      lists: [],
    };
    const overlay = applyOpsToBase(base, mergeRecordsPatch(base.rows, [
      { op: 'cell.set', op_id: 'op_a', row_ref: { kind: 'custom', id: 'row_1' }, column_id: 'note', value: 'Hello Otis' },
    ]));
    expect(overlay.rows[0]!.cells['note']).toBe('Hello Otis');
    expect(overlay.rows[0]!.record_cells!['note']!.version).toBe('v_base_9');
    expect(base.rows[0]!.cells['note']).toBe('Hello');
  });

  it('freezes the draft target, selection, and delta for one send', () => {
    const context = buildRecordsContext({
      listId: 'leads',
      draftId: 'drd_7',
      generation: 3,
      dirty: true,
      selectedRows: [{ kind: 'entity', id: 'ent_1' }],
      visibleRows: [{ kind: 'entity', id: 'ent_1' }, { kind: 'entity', id: 'ent_2' }],
      columnIds: ['name', 'status'],
      search: '',
      sort: { column_id: 'created', direction: 'asc' },
      operations: [{ op: 'cell.set', op_id: 'op_a', row_ref: { kind: 'entity', id: 'ent_1' }, column_id: 'name', value: 'Acme' }],
    });
    expect(context).toMatchObject({
      list_id: 'leads',
      target: { mode: 'draft', draft_id: 'drd_7', generation: 3 },
      selected_rows: [{ kind: 'entity', id: 'ent_1' }],
    });
    expect(context?.draft_delta).toHaveLength(1);

    const clean = buildRecordsContext({
      listId: 'leads', draftId: 'drd_7', generation: 3, dirty: false,
      selectedRows: [], visibleRows: [], columnIds: [], search: '',
      sort: { column_id: 'created', direction: 'asc' }, operations: [],
    });
    expect(clean?.target).toEqual({ mode: 'saved' });
    expect(clean?.draft_delta).toBeUndefined();
  });
});
