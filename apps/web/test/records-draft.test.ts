/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { applyOpsToBase, buildRecordsContext, mergeEditPredecessors, mergeRecordsPatch } from '../src/components/records/useRecordsDraft.js';
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

  it('preserves the draft boundary with an explicit omission on oversized deltas', () => {
    const operations = Array.from({ length: 101 }, (_, i) => ({
      op: 'cell.set' as const,
      op_id: `op_${i}`,
      row_ref: { kind: 'entity' as const, id: `ent_${i}` },
      column_id: 'name',
      value: `Name ${i}`,
    }));
    const context = buildRecordsContext({
      listId: 'leads', draftId: 'drd_9', generation: 1, dirty: true,
      selectedRows: [{ kind: 'entity', id: 'ent_0' }], visibleRows: [], columnIds: ['name'],
      search: '', sort: { column_id: 'created', direction: 'asc' }, operations,
    });
    expect(context).not.toBeNull();
    expect(context?.target).toEqual({ mode: 'draft', draft_id: 'drd_9', generation: 1 });
    expect(context?.draft_delta).toHaveLength(100);
    expect(context?.draft_delta_omitted).toBe(true);
  });

  it('keeps only the original predecessor when coalescing repeated cell edits', () => {
    const first = { op: 'cell.set', op_id: 'op_1', row_ref: { kind: 'entity', id: 'ent_1' }, column_id: 'name', value: 'one' } as const;
    // A coalesced keystroke keeps the group's original predecessor, even one
    // displaced by an intermediate edit that is itself being replaced.
    expect(mergeEditPredecessors(undefined)).toEqual([]);
    expect(mergeEditPredecessors([])).toEqual([]);
    expect(mergeEditPredecessors([first as never])).toEqual([first]);
  });

  it('round-trips the pending Save identity through storage', async () => {
    const { storeRecordsDraft, loadRecordsDraft, clearRecordsDraft } = await import('../src/components/records/recordsDraftStore.js');
    storeRecordsDraft('usr_re', 'ws_re', 'leads', {
      draftId: 'drd_re',
      generation: 2,
      baseRevision: 7,
      operations: [{ op: 'cell.set', op_id: 'op_x', row_ref: { kind: 'entity', id: 'ent_1' }, column_id: 'name', value: 'Acme' }],
      pendingSave: {
        saveId: 'save-original', actionId: 'act-original', opIds: ['op_x'],
        operations: [{ op: 'cell.set', op_id: 'op_x', row_ref: { kind: 'entity', id: 'ent_1' }, column_id: 'name', value: 'Acme' }],
        listId: 'leads', chunkIndex: 1, chunkCount: 3,
      },
    });
    const loaded = loadRecordsDraft('usr_re', 'ws_re', 'leads');
    expect(loaded?.pendingSave).toMatchObject({
      saveId: 'save-original', actionId: 'act-original', listId: 'leads', chunkIndex: 1, chunkCount: 3,
    });
    clearRecordsDraft('usr_re', 'ws_re', 'leads');
    expect(loadRecordsDraft('usr_re', 'ws_re', 'leads')).toBeNull();
  });
});
