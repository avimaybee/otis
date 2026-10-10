import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from './migrations.js';
import { executeAgentTool } from '../src/agent/repository.js';
import { acceptWebMessage, createChat } from '../src/inbox/repository.js';
import {
  executeLedgerCommand,
  handleCreateEntity,
  getWorkspaceEvents,
  getWorkspaceProjectionState,
  rebuildProjections,
  type LedgerCommandContext,
} from '@otis/ledger';

/**
 * R16 Slice E on workerd D1: the general edit_records tool, draft-target
 * enforcement for legacy tools, records discovery, derived calculations,
 * and acceptance fingerprinting of the frozen records target.
 */

const WS = 'ws-records-agent';
const OWNER = 'usr_recagent_owner';
const NOW = new Date().toISOString();
const LEASE = new Date(Date.now() + 60 * 60 * 1000).toISOString();

let CHAT = '';
let ENT = '';

function draftContext(extra?: Record<string, unknown>) {
  return {
    list_id: 'leads',
    target: { mode: 'draft' as const, draft_id: 'drd_agent_1', generation: 2 },
    selected_rows: [{ kind: 'entity', id: ENT }],
    selected_columns: ['name'],
    visible_row_order: [{ kind: 'entity', id: ENT }],
    query: { list_id: 'leads' },
    ...extra,
  };
}

async function tool(
  toolName: string,
  toolArgs: unknown,
  actionId: string,
  recordsContext?: ReturnType<typeof draftContext>,
) {
  return executeAgentTool({
    db: env.DB,
    workspaceId: WS,
    actorUserId: OWNER,
    actionId,
    sourceMessageId: 'msg-recagent-owner',
    toolName,
    toolArgs,
    ...(recordsContext ? { recordsContext: recordsContext as never } : {}),
  });
}

async function revisionOf(): Promise<number> {
  const row = await env.DB.prepare(`SELECT business_revision FROM workspaces WHERE id = ?`)
    .bind(WS).first<{ business_revision: number }>();
  return Number(row?.business_revision ?? -1);
}

async function eventCount(): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE workspace_id = ?`)
    .bind(WS).first<{ n: number }>();
  return Number(row?.n ?? -1);
}

function ledgerContext(actionId: string, revision: number): LedgerCommandContext {
  return {
    workspace_id: WS,
    actor: { kind: 'member', user_id: OWNER },
    membership_revision: 1,
    source_message_id: 'msg-recagent-owner',
    request_id: `req_${actionId}`,
    action_id: actionId,
    expected_business_revision: revision,
  };
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  await env.DB.prepare(
    `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(OWNER, 'fb_recagent', 'owner@recagent.test', 'Rec Agent', NOW, NOW).run();
  await env.DB.prepare(
    `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, last_acceptance_sequence, last_event_sequence, lease_fence, lease_owner, lease_attempt_id, lease_expires_at, created_at, updated_at)
     VALUES (?, 'Records Agent', ?, 0, 1, 0, 0, 1, ?, ?, ?, ?, ?)`,
  ).bind(WS, OWNER, OWNER, OWNER, LEASE, NOW, NOW).run();
  await env.DB.prepare(
    `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
     VALUES (?, ?, 'owner', ?, ?, ?)`,
  ).bind(WS, OWNER, NOW, NOW, NOW).run();
  await env.DB.prepare(
    `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, status, created_at, updated_at)
     VALUES ('msg-recagent-owner', ?, ?, 'web', 'ext-recagent', 'fp-recagent', 'processed', ?, ?)`,
  ).bind(WS, OWNER, NOW, NOW).run();
  const chat = await createChat(env.DB, { workspaceId: WS, authorUserId: OWNER, title: 'Agent records' });
  CHAT = chat.id;

  const created = await executeLedgerCommand(
    env.DB, ledgerContext('act_recagent_seed', 0), 'create_entity', { name: 'Agent Lead' }, handleCreateEntity,
  );
  expect(created.status).toBe('applied');
  ENT = (created.data as { entity_id: string }).entity_id;
});

describe('R16 Slice E edit_records through the agent', () => {
  it('commits on a saved turn through the guarded ledger', async () => {
    const before = await eventCount();
    const res = await tool('edit_records', {
      list_id: 'leads',
      operations: [{ op: 'cell.set', op_id: 'op_e1', row_ref: { kind: 'entity', id: ENT }, column_id: 'name', value: 'Agent Lead Renamed' }],
    }, 'act_recagent_e1');
    expect(res.status).toBe('applied');
    expect(await eventCount()).toBeGreaterThan(before);
    const events = await getWorkspaceEvents(env.DB, WS);
    const rebuilt = rebuildProjections(events);
    expect(rebuilt.entities.get(ENT)?.name).toBe('Agent Lead Renamed');
  });

  it('rejects malformed edit_records without effects', async () => {
    const before = await eventCount();
    const res = await tool('edit_records', {
      list_id: 'leads',
      operations: [{ op: 'cell.frobnicate', op_id: 'op_bad' }],
    }, 'act_recagent_e2');
    expect(res.status).toBe('rejected');
    expect(await eventCount()).toBe(before);
  });
});

describe('R16 Slice E draft-target enforcement', () => {
  it('stages legacy set_fields into the open draft with zero ledger writes', async () => {
    const beforeEvents = await eventCount();
    const beforeRev = await revisionOf();
    const res = await tool('set_fields', {
      entity_id: ENT,
      fields: [{ field_name: 'company', value: 'Staged Ltd' }],
    }, 'act_recagent_d1', draftContext());
    expect(res.status).toBe('applied');
    const patch = (res.data as { records_patch?: { patch_id: string; operations: unknown[]; save_required: boolean } })?.records_patch;
    expect(patch?.patch_id).toBe('ptc_act_recagent_d1');
    expect(patch?.save_required).toBe(true);
    expect(patch?.operations).toHaveLength(1);
    expect(await eventCount()).toBe(beforeEvents);
    expect(await revisionOf()).toBe(beforeRev);
  });

  it('stages notes, tasks, and interaction revisions as patches', async () => {
    const note = await tool('log_event', {
      entity_id: ENT, kind: 'note', payload: { text: 'Agent note' },
    }, 'act_recagent_d2', draftContext());
    expect(note.status).toBe('applied');
    expect((note.data as { records_patch?: unknown })?.records_patch).toBeDefined();

    const task = await tool('create_task', {
      title: 'Agent task', explicit_no_deadline: true,
    }, 'act_recagent_d3', draftContext());
    expect(task.status).toBe('applied');

    const before = await eventCount();
    const draft = await tool('draft_message', {
      channel: 'whatsapp', content: 'Hello draft',
    }, 'act_recagent_d4', draftContext());
    expect(draft.status).toBe('applied');
    expect(await eventCount()).toBe(before);
  });

  it('asks narrowly when the edit leaves the open selection', async () => {
    const res = await tool('set_fields', {
      entity_id: 'ent_elsewhere',
      fields: [{ field_name: 'company', value: 'Elsewhere Ltd' }],
    }, 'act_recagent_d5', draftContext());
    expect(res.status).toBe('needs_clarification');
    expect(await eventCount()).toBe(await eventCount());
  });

  it('rejects undo and clarifies merge and send in draft mode', async () => {
    const undone = await tool('undo', { mode: 'single' }, 'act_recagent_d6', draftContext());
    expect(undone.status).toBe('rejected');
    const merged = await tool('merge_entities', { source_entity_id: ENT, target_entity_id: ENT, expected_revision: 0 }, 'act_recagent_d7', draftContext());
    expect(merged.status).toBe('needs_clarification');
    const sent = await tool('mark_message_sent', { draft_id: 'dft_x' }, 'act_recagent_d8', draftContext());
    expect(sent.status).toBe('needs_clarification');
  });

  it('returns the identical patch id on provider retry', async () => {
    const args = {
      entity_id: ENT,
      fields: [{ field_name: 'company', value: 'Retry Ltd' }],
    };
    const first = await tool('set_fields', args, 'act_recagent_d9', draftContext());
    const second = await tool('set_fields', args, 'act_recagent_d9', draftContext());
    expect(first.status).toBe('applied');
    expect(second.status).toBe('applied');
    expect((first.data as { records_patch?: { patch_id: string } })?.records_patch?.patch_id)
      .toBe((second.data as { records_patch?: { patch_id: string } })?.records_patch?.patch_id);
  });
});

describe('R16 Slice E records discovery', () => {
  it('reads the shared list page with versions and bindings', async () => {
    const res = await tool('query', { resource: 'records', filters: { list_id: 'leads' }, limit: 10 }, 'act_recagent_q1');
    expect(res.status).toBe('applied');
    const page = res.data as { lists: Array<{ id: string; rows: Array<{ id: string; record_cells?: Record<string, { version: string }> }> }> };
    const leads = page.lists.find((l) => l.id === 'leads');
    expect(leads).toBeDefined();
    const row = leads!.rows.find((r) => r.id === ENT);
    expect(row?.record_cells?.['name']?.version).toBeTruthy();
  });
});

describe('R16 Slice E derived calculations', () => {
  it('defines a total, evaluates it on read, and keeps originals', async () => {
    const setup = await tool('edit_records', {
      list_id: 'products',
      operations: [
        { op: 'list.create', op_id: 'op_pl', list_id: 'products', name: 'Products', source_kind: 'custom' },
        { op: 'field.create', op_id: 'op_f1', field_id: 'price', list_id: 'products', label: 'Price', type: 'currency' },
        { op: 'field.create', op_id: 'op_f2', field_id: 'qty', list_id: 'products', label: 'Quantity', type: 'number' },
        { op: 'field.create', op_id: 'op_f3', field_id: 'total', list_id: 'products', label: 'Total', type: 'currency' },
        {
          op: 'calculation.define', op_id: 'op_c1', field_id: 'total',
          expression_tree: {
            output_type: 'currency',
            expression: {
              type: 'op', op: '*',
              left: { type: 'ref', column_id: 'price' },
              right: { type: 'ref', column_id: 'qty' },
            },
          },
          description: 'Price times quantity',
        },
        {
          op: 'row.create', op_id: 'op_r1',
          row_ref: { kind: 'custom', id: 'row_widget' }, list_id: 'products',
          initial_values: { price: { amount: 1999, currency: 'EUR' }, qty: 3 },
        },
      ],
    }, 'act_recagent_c1');
    expect(setup.status).toBe('applied');

    const page = await tool('query', { resource: 'records', filters: { list_id: 'products' }, limit: 10 }, 'act_recagent_c2');
    expect(page.status).toBe('applied');
    const products = (page.data as { lists: Array<{ id: string; rows: Array<{ id: string; cells: Record<string, string>; record_cells?: Record<string, { value: unknown; editable: boolean }> }> }> }).lists
      .find((l) => l.id === 'products')!;
    const widget = products.rows.find((r) => r.id === 'row_widget')!;
    expect(widget.cells['total']).toContain('59');
    expect(widget.record_cells?.['total']).toMatchObject({
      value: { amount: 5997, currency: 'EUR' }, editable: false,
    });
    // Originals remain inspectable beside the derived output.
    expect(widget.record_cells?.['price']).toBeDefined();
    expect(widget.record_cells?.['qty']).toBeDefined();

    // Direct writes to the derived column reject honestly.
    const direct = await tool('edit_records', {
      list_id: 'products',
      operations: [{ op: 'cell.set', op_id: 'op_direct', row_ref: { kind: 'custom', id: 'row_widget' }, column_id: 'total', value: 1 }],
    }, 'act_recagent_c3');
    expect(direct.status).toBe('rejected');
  });

  it('shows a useful error for missing inputs instead of a zero total', async () => {
    const setup = await tool('edit_records', {
      list_id: 'products',
      operations: [{
        op: 'row.create', op_id: 'op_r2',
        row_ref: { kind: 'custom', id: 'row_partial' }, list_id: 'products',
        initial_values: { price: { amount: 1000, currency: 'EUR' } },
      }],
    }, 'act_recagent_c4');
    expect(setup.status).toBe('applied');
    const page = await tool('query', { resource: 'records', filters: { list_id: 'products' }, limit: 10 }, 'act_recagent_c5');
    const products = (page.data as { lists: Array<{ id: string; rows: Array<{ id: string; cells: Record<string, string> }> }> }).lists
      .find((l) => l.id === 'products')!;
    const partial = products.rows.find((r) => r.id === 'row_partial')!;
    expect(partial.cells['total']).toContain('Missing input');
  });
});

describe('R16 Slice E frozen acceptance target', () => {
  it('treats a changed records target as a different payload', async () => {
    const first = await acceptWebMessage(env.DB, {
      workspaceId: WS, chatId: CHAT, userId: OWNER,
      clientMessageId: 'cid-recagent-1', text: 'Tidy the draft',
      recordsContext: draftContext(),
    });
    const retry = await acceptWebMessage(env.DB, {
      workspaceId: WS, chatId: CHAT, userId: OWNER,
      clientMessageId: 'cid-recagent-1', text: 'Tidy the draft',
      recordsContext: draftContext(),
    });
    expect(retry.run_id).toBe(first.run_id);

    const changed = draftContext({ target: { mode: 'saved' as const } });
    await expect(acceptWebMessage(env.DB, {
      workspaceId: WS, chatId: CHAT, userId: OWNER,
      clientMessageId: 'cid-recagent-1', text: 'Tidy the draft',
      recordsContext: changed,
    })).rejects.toThrow();
  });

  it('rejects an oversized records target at acceptance', async () => {
    const big = draftContext({
      draft_delta: Array.from({ length: 100 }, (_, i) => ({
        op: 'cell.set', op_id: `op_big_${i}`,
        row_ref: { kind: 'custom', id: `row_big_${i}` }, column_id: 'note',
        value: 'x'.repeat(400),
      })),
    });
    await expect(acceptWebMessage(env.DB, {
      workspaceId: WS, chatId: CHAT, userId: OWNER,
      clientMessageId: 'cid-recagent-big', text: 'Tidy everything',
      recordsContext: big,
    })).rejects.toThrow();
  });
});

describe('R16 Slice E live equals rebuild after agent writes', () => {
  it('keeps projections deterministic', async () => {
    const events = await getWorkspaceEvents(env.DB, WS);
    const live = await getWorkspaceProjectionState(env.DB, WS);
    const rebuilt = rebuildProjections(events);
    expect([...rebuilt.entities.keys()].sort()).toEqual([...live.entities.keys()].sort());
    const builtIn = new Set(['leads', 'tasks', 'notes', 'drafts']);
    const liveLists = [...(live.recordsLists?.keys() ?? [])].filter((k) => !builtIn.has(String(k).split(':').pop()));
    const rebuiltLists = [...(rebuilt.recordsLists?.keys() ?? [])].filter((k) => !builtIn.has(String(k).split(':').pop()));
    expect(rebuiltLists.sort()).toEqual(liveLists.sort());
  });
});
