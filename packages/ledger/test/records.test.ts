/**
 * @otis/ledger/test/records.test
 * Pure domain tests for records batch composition, reducers, and deterministic rebuild.
 * In accordance with plans/editable-records.md Slice A.
 */

import { describe, expect, it } from 'vitest';
import type { LedgerCommandContext, LedgerProjectionState } from '../src/types.js';
import { validateRecordEdit, validateRecordsSaveRequest, validateRecordValue } from '@otis/contracts';
import { handleRecordsBatch } from '../src/commands/recordsBatch.js';
import { handleCreateEntity } from '../src/commands/createEntity.js';
import { rebuildProjections } from '../src/reducers/rebuild.js';

function createDummyContext(workspaceId = 'ws_test'): LedgerCommandContext {
  return {
    workspace_id: workspaceId,
    actor: { kind: 'member', user_id: 'user_123' },
    membership_revision: 1,
    source_message_id: 'msg_source_1',
    source_channel: 'web',
    request_id: 'req_123',
    action_id: 'act_123',
    expected_business_revision: 0,
  };
}

function createEmptyState(): LedgerProjectionState {
  return {
    entities: new Map(),
    aliases: new Map(),
    fields: new Map(),
    interactions: new Map(),
    tasks: new Map(),
    drafts: new Map(),
    memoryEntries: new Map(),
    memorySuppressions: new Map(),
    recordsLists: new Map(),
    recordsListColumns: new Map(),
    recordsRows: new Map(),
    recordsValues: new Map(),
    fieldDefinitions: new Map(),
  };
}

describe('Records batch command and reducers (Slice A)', () => {
  it('handles empty operations gracefully', () => {
    const ctx = createDummyContext();
    const state = createEmptyState();
    const res = handleRecordsBatch(ctx, state, 1, {
      schema_version: 1,
      save_id: 'save_1',
      list_id: 'leads',
      operations: [],
    });

    expect(res.result.status).toBe('already_applied');
    expect(res.events).toHaveLength(0);
  });

  it('creates and updates custom lists, columns, and field definitions', () => {
    const ctx = createDummyContext();
    const state = createEmptyState();

    const res = handleRecordsBatch(ctx, state, 1, {
      schema_version: 1,
      save_id: 'save_1',
      list_id: 'projects',
      operations: [
        { op: 'list.create', op_id: 'op1', list_id: 'projects', name: 'Projects', source_kind: 'custom' },
        { op: 'field.create', op_id: 'op2', field_id: 'budget', list_id: 'projects', label: 'Budget', type: 'currency' },
        { op: 'calculation.define', op_id: 'op3', field_id: 'budget', expression_tree: { output_type: 'currency', expression: { type: 'literal', value: 1000 } }, description: 'Base budget' },
      ],
    });

    expect(res.result.status).toBe('applied');
    expect(res.events.length).toBeGreaterThanOrEqual(3);

    const nextState = res.nextState!;
    const list = nextState.recordsLists?.get('ws_test:projects');
    expect(list).toBeDefined();
    expect(list?.name).toBe('Projects');
    expect(list?.source_kind).toBe('custom');

    const fieldDef = nextState.fieldDefinitions?.get('ws_test:budget');
    expect(fieldDef).toBeDefined();
    expect(fieldDef?.display_label).toBe('Budget');
    expect(fieldDef?.value_type).toBe('currency');
    expect(fieldDef?.calculation_json).toContain('Base budget');

    // Deterministic replay check
    const rebuilt = rebuildProjections(res.events);
    expect(rebuilt.recordsLists?.get('ws_test:projects')).toEqual(list);
    expect(rebuilt.fieldDefinitions?.get('ws_test:budget')).toEqual(fieldDef);
  });

  it('manages custom row lifecycle: create, set cell, clear cell, archive, restore', () => {
    const ctx = createDummyContext();
    let state = createEmptyState();

    // 1. Create row with initial values
    const resCreate = handleRecordsBatch(ctx, state, 1, {
      schema_version: 1,
      save_id: 'save_row',
      list_id: 'custom_list',
      operations: [
        {
          op: 'row.create',
          op_id: 'op_r1',
          row_ref: { kind: 'custom', id: 'row_1' },
          list_id: 'custom_list',
          initial_values: { col_notes: 'Initial note', col_priority: 5 },
        },
      ],
    });
    expect(resCreate.result.status).toBe('applied');
    state = resCreate.nextState!;

    const row = state.recordsRows?.get('ws_test:row_1');
    expect(row).toBeDefined();
    expect(row?.status).toBe('active');

    const valNote = state.recordsValues?.get('ws_test:row_1:col_notes');
    expect(valNote?.value_text).toBe('Initial note');

    // 2. Set cell
    const resSet = handleRecordsBatch(ctx, state, resCreate.events.length + 1, {
      schema_version: 1,
      save_id: 'save_cell',
      list_id: 'custom_list',
      operations: [
        {
          op: 'cell.set',
          op_id: 'op_set',
          row_ref: { kind: 'custom', id: 'row_1' },
          column_id: 'col_notes',
          value: 'Updated note',
        },
      ],
    });
    state = resSet.nextState!;
    expect(state.recordsValues?.get('ws_test:row_1:col_notes')?.value_text).toBe('Updated note');

    // 3. Clear cell
    const resClear = handleRecordsBatch(ctx, state, resCreate.events.length + resSet.events.length + 1, {
      schema_version: 1,
      save_id: 'save_clear',
      list_id: 'custom_list',
      operations: [
        {
          op: 'cell.clear',
          op_id: 'op_clear',
          row_ref: { kind: 'custom', id: 'row_1' },
          column_id: 'col_notes',
        },
      ],
    });
    state = resClear.nextState!;
    expect(state.recordsValues?.has('ws_test:row_1:col_notes')).toBe(false);

    // 4. Archive row
    const resArchive = handleRecordsBatch(ctx, state, 10, {
      schema_version: 1,
      save_id: 'save_arch',
      list_id: 'custom_list',
      operations: [
        {
          op: 'row.remove',
          op_id: 'op_arch',
          row_ref: { kind: 'custom', id: 'row_1' },
        },
      ],
    });
    state = resArchive.nextState!;
    expect(state.recordsRows?.get('ws_test:row_1')?.status).toBe('archived');

    // 5. Restore row
    const resRestore = handleRecordsBatch(ctx, state, 15, {
      schema_version: 1,
      save_id: 'save_rest',
      list_id: 'custom_list',
      operations: [
        {
          op: 'row.restore',
          op_id: 'op_rest',
          row_ref: { kind: 'custom', id: 'row_1' },
        },
      ],
    });
    state = resRestore.nextState!;
    expect(state.recordsRows?.get('ws_test:row_1')?.status).toBe('active');

    // All events deterministic replay
    const allEvents = [
      ...resCreate.events,
      ...resSet.events,
      ...resClear.events,
      ...resArchive.events,
      ...resRestore.events,
    ];
    const rebuilt = rebuildProjections(allEvents);
    expect(rebuilt.recordsRows?.get('ws_test:row_1')?.status).toBe('active');
  });

  it('translates core entity cell edits to canonical domain events', () => {
    const ctx = createDummyContext();
    const state = createEmptyState();

    // First create an entity
    const entRes = handleCreateEntity(ctx, state, 1, { name: 'Acme Corp', initial_status: 'warm' });
    const entityId = entRes.result.data!.entity_id;
    let nextState = entRes.nextState!;

    // Edit name, status, and phone via records_batch
    const batchRes = handleRecordsBatch(ctx, nextState, entRes.events.length + 1, {
      schema_version: 1,
      save_id: 'save_core',
      list_id: 'leads',
      operations: [
        { op: 'cell.set', op_id: 'op_name', row_ref: { kind: 'entity', id: entityId }, column_id: 'name', value: 'Acme International' },
        { op: 'cell.set', op_id: 'op_status', row_ref: { kind: 'entity', id: entityId }, column_id: 'status', value: 'won' },
        { op: 'cell.set', op_id: 'op_phone', row_ref: { kind: 'entity', id: entityId }, column_id: 'phone', value: '+15551234567' },
      ],
    });

    expect(batchRes.result.status).toBe('applied');
    nextState = batchRes.nextState!;

    // Check entity updated canonically
    const entity = nextState.entities.get(entityId);
    expect(entity?.name).toBe('Acme International');
    expect(entity?.status).toBe('won');

    // Check contact updated canonically in entity_contacts
    const contact = [...(nextState.contacts?.values() ?? [])].find(c => c.entity_id === entityId && c.method === 'phone');
    expect(contact).toBeDefined();
    expect(contact?.value).toBe('+15551234567');

    // Replay
    const allEvents = [...entRes.events, ...batchRes.events];
    const rebuilt = rebuildProjections(allEvents);
    expect(rebuilt.entities.get(entityId)?.name).toBe('Acme International');
    expect(rebuilt.entities.get(entityId)?.status).toBe('won');
    const rebuiltContact = [...(rebuilt.contacts?.values() ?? [])].find(c => c.entity_id === entityId && c.method === 'phone');
    expect(rebuiltContact?.value).toBe('+15551234567');
  });

  it('translates task cell edits to canonical task events', () => {
    const ctx = createDummyContext();
    const state = createEmptyState();

    // Create task via records_batch
    const createRes = handleRecordsBatch(ctx, state, 1, {
      schema_version: 1,
      save_id: 'save_task_create',
      list_id: 'tasks',
      operations: [
        {
          op: 'row.create',
          op_id: 'op_t1',
          row_ref: { kind: 'task', id: 'task_temp' },
          list_id: 'tasks',
          initial_values: { title: 'Call client back' },
        },
      ],
    });

    expect(createRes.result.status).toBe('applied');
    const taskId = [...createRes.nextState!.tasks.values()][0]!.id;

    // Update title and status
    const updateRes = handleRecordsBatch(ctx, createRes.nextState!, createRes.events.length + 1, {
      schema_version: 1,
      save_id: 'save_task_update',
      list_id: 'tasks',
      operations: [
        { op: 'cell.set', op_id: 'op_t2', row_ref: { kind: 'task', id: taskId }, column_id: 'title', value: 'Call client back urgently' },
        { op: 'cell.set', op_id: 'op_t3', row_ref: { kind: 'task', id: taskId }, column_id: 'status', value: 'done' },
      ],
    });

    expect(updateRes.result.status).toBe('applied');
    const task = updateRes.nextState!.tasks.get(taskId);
    expect(task?.title).toBe('Call client back urgently');
    expect(task?.status).toBe('done');

    // Deterministic replay
    const rebuilt = rebuildProjections([...createRes.events, ...updateRes.events]);
    expect(rebuilt.tasks.get(taskId)?.title).toBe('Call client back urgently');
    expect(rebuilt.tasks.get(taskId)?.status).toBe('done');
  });
});

describe('Records validators (Slice A)', () => {
  it('accepts a well-formed cell.set and save envelope', () => {
    expect(validateRecordEdit({
      op: 'cell.set', op_id: 'op1',
      row_ref: { kind: 'entity', id: 'ent_1' }, column_id: 'name', value: 'Acme',
    })).toEqual({ valid: true });
    expect(validateRecordsSaveRequest({
      schema_version: 1, save_id: 'save_1', action_id: 'act_1', list_id: 'leads',
      operations: [{ op: 'cell.set', op_id: 'op1', row_ref: { kind: 'entity', id: 'ent_1' }, column_id: 'name', value: 'Acme' }],
    })).toEqual({ valid: true });
  });

  it('rejects unknown ops, malformed ids, and non-finite values', () => {
    expect(validateRecordEdit({ op: 'cell.frobnicate', op_id: 'op1' }).valid).toBe(false);
    const badOp = validateRecordEdit({ op: 'cell.set', op_id: 'op1', row_ref: { kind: 'entity', id: '' }, column_id: 'name', value: 'x' });
    expect(badOp.valid).toBe(false);
    expect(validateRecordValue(NaN).valid).toBe(false);
    expect(validateRecordValue(Infinity).valid).toBe(false);
    expect(validateRecordValue({ amount: -5, currency: 'EUR' }).valid).toBe(false);
    expect(validateRecordValue({ amount: 100, currency: 'EURO' }).valid).toBe(false);
    expect(validateRecordValue({ amount: 100, currency: 'EUR' }).valid).toBe(true);
    expect(validateRecordValue({ local_date: '2026-10-10' }).valid).toBe(true);
    expect(validateRecordValue({ local_date: '10/10/2026' }).valid).toBe(false);
  });

  it('rejects duplicate op_ids, oversized chunks, and bad calculation trees', () => {
    const dup = validateRecordsSaveRequest({
      schema_version: 1, save_id: 's', action_id: 'a', list_id: 'leads',
      operations: [
        { op: 'cell.clear', op_id: 'op1', row_ref: { kind: 'entity', id: 'e1' }, column_id: 'name' },
        { op: 'cell.clear', op_id: 'op1', row_ref: { kind: 'entity', id: 'e1' }, column_id: 'name' },
      ],
    });
    expect(dup.valid).toBe(false);
    const big = validateRecordsSaveRequest({
      schema_version: 1, save_id: 's', action_id: 'a', list_id: 'leads',
      operations: Array.from({ length: 101 }, (_, i) => ({
        op: 'cell.clear', op_id: `op${i}`, row_ref: { kind: 'entity', id: 'e1' }, column_id: 'name',
      })),
    });
    expect(big.valid).toBe(false);
    const badCalc = validateRecordEdit({
      op: 'calculation.define', op_id: 'op1', field_id: 'total',
      expression_tree: { output_type: 'money', expression: { type: 'literal', value: 1 } },
      description: 'Total',
    });
    expect(badCalc.valid).toBe(false);
    const evalTree = validateRecordEdit({
      op: 'calculation.define', op_id: 'op1', field_id: 'total',
      expression_tree: { output_type: 'number', expression: { type: 'literal', value: 1 } },
      description: 'Total',
    });
    expect(evalTree).toEqual({ valid: true });
  });
});

describe('Records batch guards (Slice A)', () => {
  function batch(ctx: LedgerCommandContext, state: LedgerProjectionState, seq: number, listId: string, operations: never[]) {
    return handleRecordsBatch(ctx, state, seq, {
      schema_version: 1, save_id: 'save_guard', list_id: listId, operations,
    });
  }

  it('rejects unknown operations instead of reporting success', () => {
    const ctx = createDummyContext();
    const res = batch(ctx, createEmptyState(), 1, 'leads', [
      { op: 'cell.frobnicate', op_id: 'op_bad', row_ref: { kind: 'entity', id: 'e1' }, column_id: 'name' },
    ] as never[]);
    expect(res.result.status).toBe('rejected');
    expect(res.events).toHaveLength(0);
  });

  it('rejects duplicate lifecycle creates and missing lifecycle targets', () => {
    const ctx = createDummyContext();
    let state = createEmptyState();
    const created = batch(ctx, state, 1, 'custom', [
      { op: 'list.create', op_id: 'op_l1', list_id: 'projects', name: 'Projects', source_kind: 'custom' },
      { op: 'field.create', op_id: 'op_f1', field_id: 'budget', list_id: 'projects', label: 'Budget', type: 'currency' },
    ] as never[]);
    expect(created.result.status).toBe('applied');
    state = created.nextState!;

    const dupList = batch(ctx, state, 10, 'custom', [
      { op: 'list.create', op_id: 'op_l2', list_id: 'projects', name: 'Projects', source_kind: 'custom' },
    ] as never[]);
    expect(dupList.result.status).toBe('rejected');

    const missingList = batch(ctx, state, 10, 'custom', [
      { op: 'list.archive', op_id: 'op_l3', list_id: 'nope' },
    ] as never[]);
    expect(missingList.result.status).toBe('rejected');

    const dupField = batch(ctx, state, 10, 'custom', [
      { op: 'field.create', op_id: 'op_f2', field_id: 'budget', label: 'Budget', type: 'currency' },
    ] as never[]);
    expect(dupField.result.status).toBe('rejected');

    const missingCalc = batch(ctx, state, 10, 'custom', [
      {
        op: 'calculation.define', op_id: 'op_c1', field_id: 'ghost',
        expression_tree: { output_type: 'number', expression: { type: 'literal', value: 1 } },
        description: 'Ghost total',
      },
    ] as never[]);
    expect(missingCalc.result.status).toBe('rejected');

    // Replay keeps definitions intact.
    const rebuilt = rebuildProjections(created.events);
    expect(rebuilt.recordsLists?.get('ws_test:projects')?.name).toBe('Projects');
    expect(rebuilt.fieldDefinitions?.get('ws_test:budget')?.value_type).toBe('currency');
  });

  it('rejects contradictory duplicates and collapses identical repeats', () => {
    const ctx = createDummyContext();
    const state = createEmptyState();
    const entRes = handleCreateEntity(ctx, state, 1, { name: 'Acme' });
    const entityId = entRes.result.data!.entity_id;

    const clash = batch({ ...ctx }, entRes.nextState!, 2, 'leads', [
      { op: 'cell.set', op_id: 'op_a', row_ref: { kind: 'entity', id: entityId }, column_id: 'name', value: 'One' },
      { op: 'cell.set', op_id: 'op_b', row_ref: { kind: 'entity', id: entityId }, column_id: 'name', value: 'Two' },
    ] as never[]);
    expect(clash.result.status).toBe('rejected');
    expect(clash.events).toHaveLength(0);

    const repeat = batch({ ...ctx }, entRes.nextState!, 2, 'leads', [
      { op: 'cell.set', op_id: 'op_a', row_ref: { kind: 'entity', id: entityId }, column_id: 'name', value: 'Acme Corp' },
      { op: 'cell.set', op_id: 'op_b', row_ref: { kind: 'entity', id: entityId }, column_id: 'name', value: 'Acme Corp' },
    ] as never[]);
    expect(repeat.result.status).toBe('applied');
    expect(repeat.result.data?.affected_count).toBe(1);
  });

  it('returns already_applied with zero events when every op is a no-op', () => {
    const ctx = createDummyContext();
    const state = createEmptyState();
    const entRes = handleCreateEntity(ctx, state, 1, { name: 'Acme' });
    const entityId = entRes.result.data!.entity_id;

    const noop = batch({ ...ctx }, entRes.nextState!, 2, 'leads', [
      { op: 'cell.set', op_id: 'op_n', row_ref: { kind: 'entity', id: entityId }, column_id: 'name', value: 'Acme' },
    ] as never[]);
    expect(noop.result.status).toBe('already_applied');
    expect(noop.events).toHaveLength(0);
  });

  it('edits and removes entity sources through item ops, and keeps memory read-only', () => {
    const ctx = createDummyContext();
    const state = createEmptyState();
    const entRes = handleCreateEntity(ctx, state, 1, { name: 'Acme' });
    const entityId = entRes.result.data!.entity_id;

    const edited = batch({ ...ctx }, entRes.nextState!, 2, 'leads', [
      { op: 'item.edit', op_id: 'op_e', source_ref: { kind: 'entity', id: entityId }, payload: { name: 'Acme Intl' } },
    ] as never[]);
    expect(edited.result.status).toBe('applied');
    expect(edited.nextState!.entities.get(entityId)?.name).toBe('Acme Intl');

    const removed = batch({ ...ctx }, edited.nextState!, 10, 'leads', [
      { op: 'item.remove', op_id: 'op_r', source_ref: { kind: 'entity', id: entityId } },
    ] as never[]);
    expect(removed.result.status).toBe('applied');
    expect(removed.events.some((e) => e.kind === 'entity_deleted')).toBe(true);

    const memoryEdit = batch({ ...ctx }, removed.nextState!, 20, 'leads', [
      { op: 'item.edit', op_id: 'op_m', source_ref: { kind: 'memory', id: 'mem_1' }, payload: { content: 'x' } },
    ] as never[]);
    expect(memoryEdit.result.status).toBe('rejected');

    const rebuilt = rebuildProjections([...entRes.events, ...edited.events, ...removed.events]);
    expect(rebuilt.entities.get(entityId)?.status).toBe(
      removed.nextState!.entities.get(entityId)?.status,
    );
  });

  it('validates quote roles strictly and applies offered quotes', () => {
    const ctx = createDummyContext();
    const state = createEmptyState();
    const entRes = handleCreateEntity(ctx, state, 1, { name: 'Acme' });
    const entityId = entRes.result.data!.entity_id;

    const badRole = batch({ ...ctx }, entRes.nextState!, 2, 'leads', [
      {
        op: 'cell.set', op_id: 'op_q1',
        row_ref: { kind: 'entity', id: entityId }, column_id: 'quote',
        value: { amount: 50000, currency: 'EUR', role: 'quoted' },
      },
    ] as never[]);
    expect(badRole.result.status).toBe('rejected');
    expect(badRole.events).toHaveLength(0);

    const good = batch({ ...ctx }, entRes.nextState!, 2, 'leads', [
      {
        op: 'cell.set', op_id: 'op_q2',
        row_ref: { kind: 'entity', id: entityId }, column_id: 'quote',
        value: { amount: 50000, currency: 'EUR', role: 'offered' },
      },
    ] as never[]);
    expect(good.result.status).toBe('applied');
    expect(good.events.some((e) => e.kind === 'quote')).toBe(true);

    const rebuilt = rebuildProjections([...entRes.events, ...good.events]);
    expect([...rebuilt.interactions.values()].filter((i) => i.kind === 'quote')).toHaveLength(1);
  });

  it('conflicts on a stale base token and keeps the saved value', () => {
    const ctx = createDummyContext();
    const state = createEmptyState();
    const entRes = handleCreateEntity(ctx, state, 1, { name: 'Acme' });
    const entityId = entRes.result.data!.entity_id;

    const first = batch({ ...ctx }, entRes.nextState!, 2, 'leads', [
      { op: 'cell.set', op_id: 'op_1', row_ref: { kind: 'entity', id: entityId }, column_id: 'name', value: 'Acme Two' },
    ] as never[]);
    expect(first.result.status).toBe('applied');

    // Legacy drafts send the base value they displayed: a changed saved
    // value conflicts even when timestamps collide within one millisecond.
    const staleValue = batch({ ...ctx }, first.nextState!, 10, 'leads', [
      {
        op: 'cell.set', op_id: 'op_2',
        row_ref: { kind: 'entity', id: entityId }, column_id: 'name',
        value: 'Acme Three', base_token: 'Acme',
      },
    ] as never[]);
    expect(staleValue.result.status).toBe('conflict');
    expect(staleValue.events).toHaveLength(0);
    expect(staleValue.result.status === 'conflict' && staleValue.result.data?.conflict?.op_id).toBe('op_2');

    // Version tokens conflict when the saved version moved on.
    const moved = first.nextState!;
    moved.entities.get(entityId)!.updated_at = '2030-01-01T00:00:00.000Z';
    const staleToken = batch({ ...ctx }, moved, 10, 'leads', [
      {
        op: 'cell.set', op_id: 'op_3',
        row_ref: { kind: 'entity', id: entityId }, column_id: 'name',
        value: 'Acme Three', base_token: '2020-01-01T00:00:00.000Z',
      },
    ] as never[]);
    expect(staleToken.result.status).toBe('conflict');

    // A matching base value applies cleanly.
    const fresh = batch({ ...ctx }, first.nextState!, 10, 'leads', [
      {
        op: 'cell.set', op_id: 'op_4',
        row_ref: { kind: 'entity', id: entityId }, column_id: 'name',
        value: 'Acme Three', base_token: 'Acme Two',
      },
    ] as never[]);
    expect(fresh.result.status).toBe('applied');
    expect(fresh.nextState!.entities.get(entityId)?.name).toBe('Acme Three');
  });

  it('rejects non-custom row restore and treats active restore as a no-op', () => {
    const ctx = createDummyContext();
    const state = createEmptyState();
    const entRes = handleCreateEntity(ctx, state, 1, { name: 'Acme' });
    const entityId = entRes.result.data!.entity_id;

    const badRestore = batch({ ...ctx }, entRes.nextState!, 2, 'custom', [
      { op: 'row.restore', op_id: 'op_rr', row_ref: { kind: 'entity', id: entityId } },
    ] as never[]);
    expect(badRestore.result.status).toBe('rejected');

    const created = batch({ ...ctx }, entRes.nextState!, 2, 'custom', [
      {
        op: 'row.create', op_id: 'op_rc',
        row_ref: { kind: 'custom', id: 'row_9' }, list_id: 'custom',
        initial_values: { note: 'hi' },
      },
    ] as never[]);
    expect(created.result.status).toBe('applied');

    const restoreActive = batch({ ...ctx }, created.nextState!, 10, 'custom', [
      { op: 'row.restore', op_id: 'op_ra', row_ref: { kind: 'custom', id: 'row_9' } },
    ] as never[]);
    expect(restoreActive.result.status).toBe('already_applied');
    expect(restoreActive.events).toHaveLength(0);
  });
});
