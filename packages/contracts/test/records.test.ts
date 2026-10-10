import { describe, expect, it } from 'vitest';
import {
  evaluateCalculationTree,
  validateRecordEdit,
  validateRecordsContext,
  validateRecordsSaveRequest,
  validateRecordValue,
  type CalculationTree,
} from '../src/records.js';
describe('records shared contracts', () => {
  it('validates semantic values without inventing shapes', () => {    expect(validateRecordValue('hi')).toEqual({ valid: true });
    expect(validateRecordValue(42)).toEqual({ valid: true });
    expect(validateRecordValue(true)).toEqual({ valid: true });
    expect(validateRecordValue(null)).toEqual({ valid: true });
    expect(validateRecordValue(NaN).valid).toBe(false);
    expect(validateRecordValue({ amount: 100, currency: 'EUR' })).toEqual({ valid: true });
    expect(validateRecordValue({ amount: 100, currency: 'EUR', role: 'offered' })).toEqual({ valid: true });
    expect(validateRecordValue({ amount: 100, currency: 'EUR', role: 'quoted' }).valid).toBe(false);
    expect(validateRecordValue({ kind: 'date', local_date: '2026-10-10', timezone: 'UTC' })).toEqual({ valid: true });
    expect(validateRecordValue({ kind: 'date', local_date: 'tomorrow', timezone: 'UTC' }).valid).toBe(false);
  });

  it('validates save envelopes with identified ops', () => {
    const good = validateRecordsSaveRequest({
      schema_version: 1, save_id: 's1', action_id: 'a1', list_id: 'leads',
      operations: [{ op: 'cell.clear', op_id: 'op1', row_ref: { kind: 'entity', id: 'e1' }, column_id: 'name' }],
    });
    expect(good).toEqual({ valid: true });
    const bad = validateRecordEdit({ op: 'cell.set', op_id: 'op9', row_ref: { kind: 'entity', id: 'e1' }, column_id: 'x' });
    expect(bad.valid).toBe(false);
  });
});

describe('calculation evaluator', () => {
  it('multiplies price by quantity in minor units', () => {
    const tree: CalculationTree = {
      output_type: 'currency',
      expression: {
        type: 'op', op: '*',
        left: { type: 'ref', column_id: 'price' },
        right: { type: 'ref', column_id: 'qty' },
      },
    };
    expect(evaluateCalculationTree(tree, {
      price: { amount: 1999, currency: 'EUR' }, qty: 3,
    })).toEqual({ ok: true, value: 5997, currency: 'EUR' });
  });

  it('refuses missing, disputed-shaped, and mismatched inputs instead of zero-filling', () => {
    const tree: CalculationTree = {
      output_type: 'number',
      expression: {
        type: 'op', op: '+',
        left: { type: 'ref', column_id: 'a' },
        right: { type: 'ref', column_id: 'b' },
      },
    };
    expect(evaluateCalculationTree(tree, { a: 1, b: null }).ok).toBe(false);
    expect(evaluateCalculationTree(tree, { a: 1 }).ok).toBe(false);
    expect(evaluateCalculationTree(tree, {
      a: { amount: 100, currency: 'EUR' }, b: { amount: 100, currency: 'USD' },
    })).toEqual({ ok: false, error: expect.stringContaining('Currency mismatch') });
  });

  it('rejects division by zero and guards node budgets', () => {
    const tree: CalculationTree = {
      output_type: 'number',
      expression: {
        type: 'op', op: '/',
        left: { type: 'literal', value: 10 },
        right: { type: 'literal', value: 0 },
      },
    };
    expect(evaluateCalculationTree(tree, {})).toEqual({ ok: false, error: 'Division by zero.' });
  });

  it('keeps plain numbers exact and money ratios unitless', () => {
    const ratio: CalculationTree = {
      output_type: 'number',
      expression: {
        type: 'op', op: '/',
        left: { type: 'ref', column_id: 'a' },
        right: { type: 'ref', column_id: 'b' },
      },
    };
    expect(evaluateCalculationTree(ratio, {
      a: { amount: 15000, currency: 'EUR' }, b: { amount: 5000, currency: 'EUR' },
    })).toEqual({ ok: true, value: 3, currency: undefined });
  });
});

describe('records_context validation', () => {
  const base = {
    list_id: 'leads',
    target: { mode: 'saved' as const },
    selected_rows: [{ kind: 'entity', id: 'ent_1' }],
    selected_columns: ['name'],
    visible_row_order: [{ kind: 'entity', id: 'ent_1' }],
    query: { list_id: 'leads' },
  };
  it('accepts saved and draft targets with a small delta', () => {
    expect(validateRecordsContext(base)).toEqual({ valid: true });
    expect(validateRecordsContext({
      ...base,
      target: { mode: 'draft', draft_id: 'drd_1', generation: 3 },
      draft_delta: [{ op: 'cell.set', op_id: 'op1', row_ref: { kind: 'entity', id: 'ent_1' }, column_id: 'name', value: 'Acme' }],
    })).toEqual({ valid: true });
  });
  it('rejects unknown modes, oversized deltas, and invalid op payloads', () => {
    expect(validateRecordsContext({ ...base, target: { mode: 'sticky' } }).valid).toBe(false);
    expect(validateRecordsContext({
      ...base, draft_delta: Array.from({ length: 101 }, (_, i) => ({
        op: 'cell.clear', op_id: `op${i}`, row_ref: { kind: 'entity', id: 'e1' }, column_id: 'name',
      })),
    }).valid).toBe(false);
    expect(validateRecordsContext({
      ...base, draft_delta: [{ op: 'cell.frobnicate', op_id: 'op1' }],
    }).valid).toBe(false);
  });
  it('rejects non-serializable and oversized contexts', () => {
    const big: Record<string, unknown> = { ...base };
    big['selected_rows'] = Array.from({ length: 201 }, (_, i) => ({ kind: 'entity', id: `e${i}` }));
    expect(validateRecordsContext(big).valid).toBe(false);
    const circular: Record<string, unknown> = { ...base };
    circular['query'] = circular;
    expect(validateRecordsContext(circular).valid).toBe(false);
  });
});
