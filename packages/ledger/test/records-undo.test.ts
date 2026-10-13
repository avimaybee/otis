/**
 * @otis/ledger/test/records-undo.test
 * Regression tests for re-audit repairs: Undo preserves the unjournaled
 * built-in list baseline, flags later teammate work rooted in undone
 * lists/fields, and contact cell edits carry the displayed revision.
 */
import { describe, expect, it } from 'vitest';
import type {
  ActionReceipt,
  EntityContact,
  LedgerEvent,
  RecordEdit,
} from '@otis/contracts';
import type { LedgerCommandContext, LedgerProjectionState } from '../src/types.js';
import { handleRecordsBatch } from '../src/commands/recordsBatch.js';
import { computeUndoPreview, handleUndoCommit } from '../src/commands/undo.js';

function ctx(actionId: string): LedgerCommandContext {
  return {
    workspace_id: 'ws_re',
    actor: { kind: 'member', user_id: 'user_1' },
    membership_revision: 1,
    source_message_id: 'msg_1',
    source_channel: 'web',
    request_id: 'req_1',
    action_id: actionId,
    expected_business_revision: 0,
  };
}

function emptyState(): LedgerProjectionState {
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

function receipt(actionId: string, runId: string | null = null): ActionReceipt {
  return {
    id: `rcpt_${actionId}`,
    workspace_id: 'ws_re',
    action_id: actionId,
    payload_hash: `hash_${actionId}`,
    command_name: 'records_batch',
    result_status: 'applied',
    result_json: '{}',
    actor_kind: 'member',
    actor_user_id: 'user_1',
    committed_revision: 1,
    created_at: new Date().toISOString(),
    ...(runId ? { run_id: runId } : {}),
  } as ActionReceipt;
}

function tagEvents(events: LedgerEvent[], actionId: string, baseSeq: number): LedgerEvent[] {
  return events.map((e, i) => ({ ...e, action_id: actionId, sequence: baseSeq + i }));
}

describe('records Undo baseline and dependencies (RR08)', () => {
  it('preserves seeded built-in lists when undoing an ordinary entity creation', () => {
    const start = handleRecordsBatch(ctx('act_create'), emptyState(), 1, {
      schema_version: 1,
      save_id: 'save_1',
      list_id: 'leads',
      operations: [
        { op: 'row.create', op_id: 'op_c', row_ref: { kind: 'entity', id: 'tmp_1' }, list_id: 'leads', initial_values: { name: 'Acme' } },
      ],
    });
    expect(start.result.status).toBe('applied');
    const createdEvents = tagEvents(start.events, 'act_create', 1);
    // The rebuilt state carries a seeded Leads list with no journaled events.
    const current = start.nextState!;
    current.recordsLists!.set('ws_re:leads', {
      workspace_id: 'ws_re',
      id: 'leads',
      name: 'Leads',
      source_kind: 'entity',
      status: 'active',
      revision: 1,
      source_event_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const out = handleUndoCommit(ctx('act_undo'), createdEvents, [receipt('act_create')], current, 100, {
      action_id: 'act_create',
      mode: 'single',
      client_operation_id: 'cop_1',
      expected_revision: 1,
    });
    expect(out.result.status).toBe('applied');
    expect(out.nextState!.recordsLists!.has('ws_re:leads')).toBe(true);
  });

  it('flags later teammate row work rooted in an undone list creation', () => {
    const listed = handleRecordsBatch(ctx('act_list'), emptyState(), 1, {
      schema_version: 1,
      save_id: 'save_list',
      list_id: 'projects',
      operations: [
        { op: 'list.create', op_id: 'op_l', list_id: 'projects', name: 'Projects', source_kind: 'custom' },
      ],
    });
    expect(listed.result.status).toBe('applied');
    const listEvents = tagEvents(listed.events, 'act_list', 1);
    const rowed = handleRecordsBatch(ctx('act_row'), listed.nextState!, 10, {
      schema_version: 1,
      save_id: 'save_row',
      list_id: 'projects',
      operations: [
        { op: 'row.create', op_id: 'op_r', row_ref: { kind: 'custom', id: 'row_9' }, list_id: 'projects', initial_values: { name: 'Widget' } },
      ],
    });
    expect(rowed.result.status).toBe('applied');
    const allEvents = [...listEvents, ...tagEvents(rowed.events, 'act_row', 10)];
    const preview = computeUndoPreview('act_list', 'single', [receipt('act_list'), receipt('act_row')], allEvents, rowed.nextState!, 1);
    expect(preview.dependencies.map((d) => d.action_id)).toContain('act_row');
  });
});

describe('records contact cell revisions (RR04)', () => {
  function contactState(): LedgerProjectionState {
    const state = emptyState();
    const now = new Date().toISOString();
    state.entities.set('ent_1', {
      id: 'ent_1', workspace_id: 'ws_re', name: 'Acme', kind: 'business', status: 'new',
      assigned_user_id: null, created_at: now, updated_at: now,
    });
    const contact: EntityContact = {
      id: 'contact_1', workspace_id: 'ws_re', entity_id: 'ent_1', method: 'phone',
      value: '+15551234567', comparison_key: '+15551234567', label: null, is_primary: true,
      state: 'active', revision: 1, source_event_id: 'evt_c', original_event_id: 'evt_c', updated_at: now,
    };
    state.contacts = new Map([['contact_1', contact]]);
    return state;
  }

  const phoneSet = (value: string | null): RecordEdit[] => value === null
    ? [{ op: 'cell.clear', op_id: 'op_clear', row_ref: { kind: 'entity', id: 'ent_1' }, column_id: 'phone' }]
    : [{ op: 'cell.set', op_id: 'op_set', row_ref: { kind: 'entity', id: 'ent_1' }, column_id: 'phone', value }];

  it('edits the existing phone without a revision conflict', () => {
    const out = handleRecordsBatch(ctx('act_phone'), contactState(), 1, {
      schema_version: 1, save_id: 'save_p', list_id: 'leads', operations: phoneSet('+15557654321'),
    });
    expect(out.result.status).toBe('applied');
  });

  it('returns the post-reducer contact version so follow-up edits rebase', () => {
    const first = handleRecordsBatch(ctx('act_p1'), contactState(), 1, {
      schema_version: 1, save_id: 'save_p1', list_id: 'leads', operations: phoneSet('+15557654321'),
    });
    expect(first.result.status).toBe('applied');
    const data = first.result.data as { affected_values?: Array<{ version: string }> };
    const version = data.affected_values?.[0]?.version;
    expect(typeof version).toBe('string');
    expect(version!.length).toBeGreaterThan(0);
    const savedContact = [...first.nextState!.contacts!.values()].find((c) => c.state === 'active');
    expect(version).toBe(savedContact!.updated_at);
    // A second edit presenting the acknowledged version applies cleanly.
    const second = handleRecordsBatch(ctx('act_p2'), first.nextState!, 10, {
      schema_version: 1, save_id: 'save_p2', list_id: 'leads',
      operations: [{
        op: 'cell.set', op_id: 'op_set2',
        row_ref: { kind: 'entity', id: 'ent_1' }, column_id: 'phone',
        value: '+15550000000', base_token: version,
      }],
    });
    expect(second.result.status).toBe('applied');
  });

  it('clears the existing phone without a validation conflict', () => {
    const out = handleRecordsBatch(ctx('act_clear'), contactState(), 1, {
      schema_version: 1, save_id: 'save_c', list_id: 'leads', operations: phoneSet(null),
    });
    expect(out.result.status).toBe('applied');
  });
});
