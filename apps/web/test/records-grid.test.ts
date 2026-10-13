/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { needsRowForm, planPaste } from '../src/components/records/gridCore.js';

const COLUMNS = [
  { id: 'name', type: 'text' },
  { id: 'phone', type: 'phone' },
  { id: 'value', type: 'currency' },
] as Array<{ id: string; type: 'text' | 'phone' | 'currency' }>;

const SCOPE = {
  makeRowId: (() => {
    let n = 0;
    return () => `row_new_${++n}`;
  })(),
  listKind: 'entity' as const,
  listId: 'leads',
  refOf: (rowId: string) => ({ kind: 'entity' as const, id: rowId }),
  baseOf: (rowId: string, columnId: string) => `v_${rowId}_${columnId}`,
};

describe('Records grid guards (R16 Slice D)', () => {
  it('routes structured columns to the row form', () => {
    expect(needsRowForm({ id: 'name', type: 'text' })).toBe(false);
    expect(needsRowForm({ id: 'phone', type: 'phone' })).toBe(false);
    expect(needsRowForm({ id: 'notes', type: 'text' })).toBe(false);
    expect(needsRowForm({ id: 'value', type: 'currency' })).toBe(true);
    expect(needsRowForm({ id: 'quote', type: 'text' })).toBe(true);
    expect(needsRowForm({ id: 'due', type: 'date' })).toBe(true);
    expect(needsRowForm({ id: 'total', type: 'calculation' })).toBe(true);
    expect(needsRowForm({ id: 'next_action', type: 'text' })).toBe(true);
    expect(needsRowForm({ id: 'kind', type: 'text' })).toBe(true);
    expect(needsRowForm({ id: 'entity', type: 'text' })).toBe(true);
  });

  it('plans a 5x4 paste with overflow review, structured skips, and one temp id per new row', () => {
    const values = [
      ['Acme', '+15550001', 'should-not-paste', 'extra-a1', 'extra-a2'],
      ['Beta', '+15550002', 'x', 'extra-b1', ''],
      ['', '', '', '', ''],
      ['Gamma', '+15550003', 'y', '', 'extra-c1'],
      ['Delta', '+15550004', 'z', '', ''],
    ];
    const plan = planPaste(COLUMNS, ['ent_1'], 0, 'name', values, SCOPE);

    // Existing row edits carry base preconditions.
    const firstCell = plan.ops.find((op) => op.op === 'cell.set' && op.row_ref.id === 'ent_1' && op.column_id === 'name');
    expect(firstCell).toMatchObject({ value: 'Acme', base_token: 'v_ent_1_name' });

    // Structured money cells stay out with a count instead of corrupting quotes.
    expect(plan.skippedStructured).toBe(4);

    // One temp id per new row, shared by its create and its cells.
    const creates = plan.ops.filter((op) => op.op === 'row.create');
    expect(creates.map((op) => op.row_ref.id)).toEqual(['row_new_1', 'row_new_2', 'row_new_3']);
    const betaCells = plan.ops.filter((op) => op.op === 'cell.set' && op.row_ref.id === 'row_new_1');
    expect(betaCells.map((op) => op.column_id).sort()).toEqual(['name', 'phone']);

    // The pasted name rides in initial_values so the save never invents one.
    expect(creates[0]).toMatchObject({ initial_values: { name: 'Beta' } });

    // Fully blank lines paste nothing.
    expect(plan.ops.some((op) => op.op === 'cell.set' && op.row_ref.id === 'row_new_blank')).toBe(false);

    // Overflow columns are retained per row for review, never clipped.
    expect(plan.reviewRows).toEqual([
      { rowId: 'ent_1', values: ['extra-a1', 'extra-a2'] },
      { rowId: 'row_new_1', values: ['extra-b1', ''] },
      { rowId: 'row_new_2', values: ['', 'extra-c1'] },
    ]);
  });

  it('ignores an unknown start column instead of misplacing values', () => {
    const plan = planPaste(COLUMNS, ['ent_1'], 0, 'nope', [['Acme']], SCOPE);
    expect(plan.ops).toEqual([]);
    expect(plan.reviewRows).toEqual([]);
  });
});

describe('save chunking (RR02)', () => {
  it('keeps a row.create with its same-row cells in one chunk', async () => {
    const { buildSaveChunks, SAVE_CHUNK_OPS } = await import('../src/components/records/gridCore.js');
    const ops: import('@otis/contracts').RecordEdit[] = [
      { op: 'row.create', op_id: 'op_c', row_ref: { kind: 'entity', id: 'tmp_1' }, list_id: 'leads', initial_values: {} },
      { op: 'cell.set', op_id: 'op_n', row_ref: { kind: 'entity', id: 'tmp_1' }, column_id: 'name', value: 'Acme' },
    ];
    for (let i = 0; i < SAVE_CHUNK_OPS - 1; i++) {
      ops.unshift({ op: 'cell.set', op_id: `op_fill_${i}`, row_ref: { kind: 'entity', id: `ent_${i}` }, column_id: 'name', value: `N${i}` });
    }
    const chunks = buildSaveChunks(ops);
    expect(chunks.length).toBe(2);
    // The creation group moved whole into the second chunk, never split.
    const second = chunks[1]!;
    expect(second.map((op) => op.op_id)).toEqual(['op_c', 'op_n']);
    expect(chunks.flat()).toHaveLength(ops.length);
  });

  it('bounds every chunk at the operation limit in order', async () => {
    const { buildSaveChunks, SAVE_CHUNK_OPS } = await import('../src/components/records/gridCore.js');
    const ops: import('@otis/contracts').RecordEdit[] = Array.from({ length: SAVE_CHUNK_OPS * 2 + 5 }, (_, i) => ({
      op: 'cell.set' as const,
      op_id: `op_${i}`,
      row_ref: { kind: 'entity' as const, id: `ent_${i}` },
      column_id: 'name',
      value: `N${i}`,
    }));
    const chunks = buildSaveChunks(ops);
    expect(chunks.length).toBe(3);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(SAVE_CHUNK_OPS);
    expect(chunks.flat().map((op) => op.op_id)).toEqual(ops.map((op) => op.op_id));
  });

  it('never moves a cell edit ahead of the field definition that types it', async () => {    const { buildSaveChunks } = await import('../src/components/records/gridCore.js');
    const ops: import('@otis/contracts').RecordEdit[] = [
      { op: 'row.create', op_id: 'op_c', row_ref: { kind: 'custom', id: 'tmp_1' }, list_id: 'projects', initial_values: { name: 'Widget' } },
      { op: 'cell.set', op_id: 'op_n', row_ref: { kind: 'custom', id: 'tmp_1' }, column_id: 'name', value: 'Widget' },
      { op: 'field.create', op_id: 'op_f', field_id: 'budget', list_id: 'projects', label: 'Budget', type: 'currency' },
      { op: 'cell.set', op_id: 'op_b', row_ref: { kind: 'custom', id: 'tmp_1' }, column_id: 'budget', value: { amount: 1000, currency: 'USD' } },
    ];
    const chunks = buildSaveChunks(ops);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.map((op) => op.op_id)).toEqual(['op_c', 'op_n', 'op_f', 'op_b']);
  });

  it('remaps temporary IDs and rebases versions into unsubmitted chunks', async () => {
    const { remapPendingChunks } = await import('../src/components/records/gridCore.js');
    const chunks: import('@otis/contracts').RecordEdit[][] = [
      [
        { op: 'row.create', op_id: 'op_c', row_ref: { kind: 'entity', id: 'tmp_1' }, list_id: 'leads', initial_values: { name: 'Acme' } },
      ],
      [
        { op: 'cell.set', op_id: 'op_p', row_ref: { kind: 'entity', id: 'tmp_1' }, column_id: 'phone', value: '+15551234567', base_token: 'v_stale' },
      ],
    ];
    remapPendingChunks(chunks, 1, { tmp_1: 'ent_9' }, [
      { row_ref: { kind: 'entity', id: 'ent_9' }, column_id: 'phone', version: 'v_new' },
    ]);
    const cell = chunks[1]![0]!;
    expect(cell.op).toBe('cell.set');
    if (cell.op === 'cell.set') {
      expect(cell.row_ref.id).toBe('ent_9');
      expect(cell.base_token).toBe('v_new');
    }
    // The submitted chunk itself is untouched.
    expect(chunks[0]![0]!.op).toBe('row.create');
  });
});
