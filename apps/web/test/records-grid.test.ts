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
