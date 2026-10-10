import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from './migrations.js';
import {
  executeLedgerCommand,
  handleRecordsBatch,
  handleUndoCommit,
  rebuildProjections,
  getWorkspaceActions,
  getWorkspaceEvents,
  getWorkspaceProjectionState,
  type LedgerCommandContext,
} from '@otis/ledger';
import { createWorkspace, sha256 } from '@otis/identity';
import { AUTH_BOUNDS } from '@otis/contracts';
import { handleGetRecords, handleSaveRecords } from '../src/routes/records.js';
import type { Env } from '../src/index.js';

/**
 * R16 Slice B: authoritative Save and bounded reads on workerd D1.
 * Covers the plan's done-evidence: foreign-ID rejection with zero effects in
 * both workspaces, atomic chunk rollback, retry idempotency, same-cell
 * conflict versus different-cell success, canonical store targeting (no
 * shadow phone/email fields), receipt history keyed by list, keyset paging,
 * single Undo with live equal to rebuild, and a targeted cost pin proving
 * small-edit cost follows touched state rather than workspace size.
 */

const WS = 'ws-records-b';
const WS2 = 'ws-records-foreign';
const OWNER = 'usr_records_owner';
const TEAMMATE = 'usr_records_tm';
const OUTSIDER = 'usr_records_out';
const BEARER = 'rec-test-bearer-token';
const OUTBEARER = 'rec-outsider-bearer';
const NOW = new Date().toISOString();
const LEASE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const EXPIRY = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
const WENV = { DB: env.DB } as unknown as Env;

function makeContext(actionId: string, revision: number): LedgerCommandContext {
  return {
    workspace_id: WS,
    actor: { kind: 'member', user_id: OWNER },
    membership_revision: 1,
    source_message_id: 'msg-rec-owner',
    request_id: `req_${actionId}`,
    action_id: actionId,
    expected_business_revision: revision,
  };
}

function saveRequest(workspaceId: string, body: unknown, token = BEARER): Request {
  return new Request(`http://localhost/api/workspaces/${workspaceId}/records`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      [AUTH_BOUNDS.CSRF_HEADER]: '1',
      origin: 'http://localhost',
    },
    body: JSON.stringify(body),
  });
}

function getRequest(workspaceId: string, query = '', token = BEARER): Request {
  return new Request(`http://localhost/api/workspaces/${workspaceId}/records${query}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  });
}

async function postSave(workspaceId: string, body: unknown, token = BEARER) {
  const res = await handleSaveRecords(saveRequest(workspaceId, body, token), WENV, workspaceId, `req-test-${Date.now()}`);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function getLists(workspaceId: string, query = '', token = BEARER) {
  const res = await handleGetRecords(getRequest(workspaceId, query, token), WENV, workspaceId, 'req-test-get');
  expect(res.status).toBe(200);
  return (await res.json()) as {
    lists: Array<{
      id: string; name: string; source_kind: string; columns: Array<{ id: string; name: string }>;
      rows: Array<{ id: string; cells: Record<string, string>; record_cells?: Record<string, { value: unknown; version: string }> }>;
      total_rows?: number; next_cursor?: string | null;
    }>;
    history: Record<string, Array<{ id: string; description: string; affected_count?: number }>>;
    revision: number;
  };
}

function listById(payload: Awaited<ReturnType<typeof getLists>>, id: string) {
  const list = payload.lists.find((l) => l.id === id);
  expect(list).toBeDefined();
  return list!;
}

async function revisionOf(workspaceId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT business_revision FROM workspaces WHERE id = ?`)
    .bind(workspaceId).first<{ business_revision: number }>();
  return Number(row?.business_revision ?? -1);
}

async function eventCount(workspaceId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE workspace_id = ?`)
    .bind(workspaceId).first<{ n: number }>();
  return Number(row?.n ?? -1);
}

async function liveEqualsRebuild(): Promise<boolean> {
  const events = await getWorkspaceEvents(env.DB, WS);
  const rebuilt = rebuildProjections(events);
  const live = await getWorkspaceProjectionState(env.DB, WS);
  const ser = (m: Map<string, unknown>) =>
    JSON.stringify([...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
  // Built-in lists are seeded data outside the event log (migration seed /
  // creation ensure), so the comparison scopes them out; every event-driven
  // list, row, value, and definition must still match exactly.
  const BUILT_INS = new Set(['leads', 'tasks', 'notes', 'drafts']);
  const withoutBuiltins = (m: Map<string, unknown> | undefined) =>
    new Map([...(m ?? new Map()).entries()].filter(([k]) => {
      const id = String(k).split(':').pop();
      return !BUILT_INS.has(id ?? '');
    }));
  const recordsMaps: Array<{ a: Map<string, unknown> | undefined; b: Map<string, unknown> | undefined; skipBuiltins: boolean }> = [
    { a: rebuilt.recordsLists as Map<string, unknown> | undefined, b: live.recordsLists as Map<string, unknown> | undefined, skipBuiltins: true },
    { a: rebuilt.recordsRows as Map<string, unknown> | undefined, b: live.recordsRows as Map<string, unknown> | undefined, skipBuiltins: false },
    { a: rebuilt.recordsValues as Map<string, unknown> | undefined, b: live.recordsValues as Map<string, unknown> | undefined, skipBuiltins: false },
    { a: rebuilt.fieldDefinitions as Map<string, unknown> | undefined, b: live.fieldDefinitions as Map<string, unknown> | undefined, skipBuiltins: false },
  ];
  return (
    ser(rebuilt.entities as Map<string, unknown>) === ser(live.entities as Map<string, unknown>) &&
    ser(rebuilt.fields as Map<string, unknown>) === ser(live.fields as Map<string, unknown>) &&
    ser(rebuilt.tasks as Map<string, unknown>) === ser(live.tasks as Map<string, unknown>) &&
    ser(rebuilt.drafts as Map<string, unknown>) === ser(live.drafts as Map<string, unknown>) &&
    ser(rebuilt.interactions as Map<string, unknown>) === ser(live.interactions as Map<string, unknown>) &&
    recordsMaps.every(({ a, b, skipBuiltins }) =>
      ser(skipBuiltins ? withoutBuiltins(a) : (a ?? new Map())) ===
      ser(skipBuiltins ? withoutBuiltins(b) : (b ?? new Map())))
  );
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  await env.DB.prepare(
    `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`,
  ).bind(
    OWNER, 'fb_rec_owner', 'owner@rec.test', 'Rec Owner', NOW, NOW,
    TEAMMATE, 'fb_rec_tm', 'tm@rec.test', 'Rec Tm', NOW, NOW,
    OUTSIDER, 'fb_rec_out', 'out@rec.test', 'Outsider', NOW, NOW,
  ).run();
  // Both workspaces are born WITHOUT records_lists rows: the first GET
  // ensures the built-ins, proving the post-migration path.
  await env.DB.prepare(
    `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, last_acceptance_sequence, last_event_sequence, lease_fence, lease_owner, lease_attempt_id, lease_expires_at, created_at, updated_at)
     VALUES (?, 'Records B', ?, 0, 1, 0, 0, 1, ?, ?, ?, ?, ?),
            (?, 'Records Foreign', ?, 0, 1, 0, 0, 1, ?, ?, ?, ?, ?)`,
  ).bind(
    WS, OWNER, OWNER, OWNER, LEASE, NOW, NOW,
    WS2, OUTSIDER, OUTSIDER, OUTSIDER, LEASE, NOW, NOW,
  ).run();
  await env.DB.prepare(
    `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
     VALUES (?, ?, 'owner', ?, ?, ?), (?, ?, 'member', ?, ?, ?), (?, ?, 'owner', ?, ?, ?)`,
  ).bind(WS, OWNER, NOW, NOW, NOW, WS, TEAMMATE, NOW, NOW, NOW, WS2, OUTSIDER, NOW, NOW, NOW).run();
  await env.DB.prepare(
    `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, status, created_at, updated_at)
     VALUES ('msg-rec-owner', ?, ?, 'web', 'ext-rec', 'fp-rec', 'processed', ?, ?)`,
  ).bind(WS, OWNER, NOW, NOW).run();
  const tokenHash = await sha256(BEARER);
  const outsiderHash = await sha256(OUTBEARER);
  await env.DB.prepare(
    `INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, last_seen_at)
     VALUES ('ses-rec-1', ?, ?, ?, ?, ?), ('ses-rec-out', ?, ?, ?, ?, ?)`,
  ).bind(tokenHash, OWNER, NOW, EXPIRY, NOW, outsiderHash, OUTSIDER, NOW, EXPIRY, NOW).run();
});

describe('R16 Slice B authoritative reads', () => {
  it('ensures built-in lists on first read and reports honest totals', async () => {
    const payload = await getLists(WS2, '', OUTBEARER);
    expect(payload.lists.map((l) => l.id)).toEqual(['leads', 'tasks', 'notes', 'drafts']);
    expect(payload.revision).toBe(0);
    for (const list of payload.lists) {
      expect(list.rows).toEqual([]);
      expect(list.total_rows).toBe(0);
      expect(list.next_cursor).toBeNull();
    }
    // Second read does not duplicate the ensured lists.
    const again = await getLists(WS2, '', OUTBEARER);
    expect(again.lists.map((l) => l.id)).toEqual(['leads', 'tasks', 'notes', 'drafts']);
  });

  it('creates workspaces with built-in lists through identity', async () => {
    const created = await createWorkspace(env.DB, { name: 'Seeded Lists', ownerUserId: OWNER, workspaceId: 'ws-records-seeded' });
    expect(created.id).toBe('ws-records-seeded');
    const rows = await env.DB.prepare(
      `SELECT id FROM records_lists WHERE workspace_id = ? ORDER BY id`,
    ).bind('ws-records-seeded').all<{ id: string }>();
    expect((rows.results || []).map((r) => r.id)).toEqual(['drafts', 'leads', 'notes', 'tasks']);
  });
});

describe('R16 Slice B authoritative saves', () => {
  it('creates a lead with canonical phone, email, and note stores and no shadow fields', async () => {
    const saved = await postSave(WS, {
      listId: 'leads',
      save_id: 'save_b1',
      action_id: 'act_rec_b1',
      operations: [{
        op: 'row.create', op_id: 'op_mk',
        row_ref: { kind: 'entity', id: 'tmp-lead' }, list_id: 'leads',
        initial_values: {
          name: 'Kerning Studio', phone: '+15551234567', email: 'hello@kerning.test', notes: 'First contact',
        },
      }],
    });
    expect(saved.status).toBe(200);
    expect(saved.json['saved']).toBe(true);
    expect(saved.json['status']).toBe('applied');
    const mappings = saved.json['id_mappings'] as Record<string, string>;
    const entityId = mappings['tmp-lead'];
    expect(entityId).toBeTruthy();
    expect(entityId).not.toBe('tmp-lead');

    // Canonical stores: contacts carry phone/email, interactions carry the note.
    const contactRows = await env.DB.prepare(
      `SELECT method, value FROM entity_contacts WHERE workspace_id = ? AND entity_id = ? ORDER BY method`,
    ).bind(WS, entityId).all<{ method: string; value: string }>();
    expect((contactRows.results || []).map((r) => [r.method, r.value])).toEqual([
      ['email', 'hello@kerning.test'],
      ['phone', '+15551234567'],
    ]);
    const shadow = await env.DB.prepare(
      `SELECT field_name FROM entity_state WHERE workspace_id = ? AND entity_id = ? AND field_name IN ('phone', 'email')`,
    ).bind(WS, entityId).all();
    expect(shadow.results).toHaveLength(0);
    const noteRow = await env.DB.prepare(
      `SELECT kind, state FROM interaction_state WHERE workspace_id = ? AND entity_id = ? AND kind = 'note'`,
    ).bind(WS, entityId).first<{ kind: string; state: string }>();
    expect(noteRow?.state).toBe('active');

    // The read shows the saved values with usable version preconditions.
    const payload = await getLists(WS, '?list=leads');
    const leads = listById(payload, 'leads');
    expect(leads.total_rows).toBe(1);
    expect(leads.next_cursor).toBeNull();
    const row = leads.rows.find((r) => r.id === entityId);
    expect(row?.cells['phone']).toBe('+15551234567');
    expect(row?.cells['notes']).toBe('First contact');
    expect(row?.record_cells?.['name']?.version).toBeTruthy();
    expect(await liveEqualsRebuild()).toBe(true);
  });

  it('rejects a foreign id with zero effects in either workspace', async () => {
    const beforeEvents = await eventCount(WS);
    const beforeEvents2 = await eventCount(WS2);
    const beforeRev = await revisionOf(WS);
    const beforeRev2 = await revisionOf(WS2);

    // 'no-such-ent' exists in neither workspace; scope the save at WS2.
    const res = await postSave(WS2, {
      listId: 'leads',
      save_id: 'save_foreign',
      action_id: 'act_rec_foreign',
      operations: [{
        op: 'cell.set', op_id: 'op_f',
        row_ref: { kind: 'entity', id: 'no-such-ent' }, column_id: 'name', value: 'Intruder',
      }],
    }, 'invalid-bearer-token');
    expect(res.status).toBe(401);

    // Outsider is authenticated for WS2 but the entity id is unknown there.
    const res2 = await postSave(WS2, {
      listId: 'leads',
      save_id: 'save_foreign2',
      action_id: 'act_rec_foreign2',
      operations: [{
        op: 'cell.set', op_id: 'op_f2',
        row_ref: { kind: 'entity', id: 'no-such-ent' }, column_id: 'name', value: 'Intruder',
      }],
    }, OUTBEARER);
    expect(res2.status).toBe(404);

    expect(await eventCount(WS)).toBe(beforeEvents);
    expect(await eventCount(WS2)).toBe(beforeEvents2);
    expect(await revisionOf(WS)).toBe(beforeRev);
    expect(await revisionOf(WS2)).toBe(beforeRev2);
  });

  it('replays a retry once and reports the stored receipt', async () => {
    const body = {
      listId: 'leads',
      save_id: 'save_retry',
      action_id: 'act_rec_retry',
      operations: [{
        op: 'row.create', op_id: 'op_rt',
        row_ref: { kind: 'entity', id: 'tmp-retry' }, list_id: 'leads',
        initial_values: { name: 'Retry Co' },
      }],
    };
    const first = await postSave(WS, body);
    expect(first.status).toBe(200);
    const eventsAfterFirst = await eventCount(WS);
    const second = await postSave(WS, body);
    expect(second.status).toBe(200);
    expect(second.json['status']).toBe('already_applied');
    expect(await eventCount(WS)).toBe(eventsAfterFirst);

    // Same action id with a different payload conflicts instead of forking.
    const forked = await postSave(WS, { ...body, operations: [{
      op: 'row.create', op_id: 'op_rt2',
      row_ref: { kind: 'entity', id: 'tmp-other' }, list_id: 'leads',
      initial_values: { name: 'Other Co' },
    }] });
    expect(forked.status).toBe(409);
  });

  it('rejects malformed and contradictory saves before any effect', async () => {
    const before = await eventCount(WS);
    const unknown = await postSave(WS, {
      listId: 'leads', save_id: 'save_bad1', action_id: 'act_rec_bad1',
      operations: [{ op: 'cell.frobnicate', op_id: 'op_x' }],
    });
    expect(unknown.status).toBe(400);
    expect(await eventCount(WS)).toBe(before);

    const created = await postSave(WS, {
      listId: 'leads', save_id: 'save_bad2', action_id: 'act_rec_bad2',
      operations: [{
        op: 'row.create', op_id: 'op_mk2',
        row_ref: { kind: 'entity', id: 'tmp-clash' }, list_id: 'leads',
        initial_values: { name: 'Clash Co' },
      }],
    });
    expect(created.status).toBe(200);
    const afterCreate = await eventCount(WS);
    expect(afterCreate).toBeGreaterThan(before);
    const clashId = (created.json['id_mappings'] as Record<string, string>)['tmp-clash']!;
    const clash = await postSave(WS, {
      listId: 'leads', save_id: 'save_bad3', action_id: 'act_rec_bad3',
      operations: [
        { op: 'cell.set', op_id: 'op_a', row_ref: { kind: 'entity', id: clashId }, column_id: 'name', value: 'One' },
        { op: 'cell.set', op_id: 'op_b', row_ref: { kind: 'entity', id: clashId }, column_id: 'name', value: 'Two' },
      ],
    });
    expect(clash.status).toBe(400);
    // The contradictory chunk committed nothing: event count pinned and the
    // saved name untouched.
    expect(await eventCount(WS)).toBe(afterCreate);
    const current = await getLists(WS, '?list=leads');
    expect(current.lists.find((l) => l.id === 'leads')!.rows.find((r) => r.id === clashId)!
      .record_cells!['name']!.value).toBe('Clash Co');
    expect(await liveEqualsRebuild()).toBe(true);
  });

  it('conflicts on a stale base while different cells succeed together', async () => {
    const made = await postSave(WS, {
      listId: 'leads', save_id: 'save_cf0', action_id: 'act_rec_cf0',
      operations: [{
        op: 'row.create', op_id: 'op_cf0',
        row_ref: { kind: 'entity', id: 'tmp-cf' }, list_id: 'leads',
        initial_values: { name: 'Conflict Co' },
      }],
    });
    const entityId = (made.json['id_mappings'] as Record<string, string>)['tmp-cf']!;

    const read = await getLists(WS, '?list=leads');
    const baseName = read.lists.find((l) => l.id === 'leads')!.rows.find((r) => r.id === entityId)!
      .record_cells!['name']!.value as string;

    // Teammate-adjacent change through a second save.
    const concurrent = await postSave(WS, {
      listId: 'leads', save_id: 'save_cf1', action_id: 'act_rec_cf1',
      operations: [
        { op: 'cell.set', op_id: 'op_cf1', row_ref: { kind: 'entity', id: entityId }, column_id: 'name', value: 'Conflict Co Renewed' },
        { op: 'cell.set', op_id: 'op_cf2', row_ref: { kind: 'entity', id: entityId }, column_id: 'company', value: 'Renewed Ltd' },
      ],
    });
    expect(concurrent.status).toBe(200);

    // Stale base on the same cell conflicts with mine/saved detail.
    const stale = await postSave(WS, {
      listId: 'leads', save_id: 'save_cf2', action_id: 'act_rec_cf2',
      operations: [{
        op: 'cell.set', op_id: 'op_cf3',
        row_ref: { kind: 'entity', id: entityId }, column_id: 'name',
        value: 'Stale Overwrite', base_token: baseName,
      }],
    });
    expect(stale.status).toBe(409);
    const staleError = stale.json['error'] as Record<string, unknown>;
    expect(staleError['code']).toBe('conflict');
    expect(staleError['details']).toBeDefined();

    // Saved value kept; a fresh base applies.
    const after = await getLists(WS, '?list=leads');
    const nameCell = after.lists.find((l) => l.id === 'leads')!.rows.find((r) => r.id === entityId)!
      .record_cells!['name']!;
    expect(nameCell.value).toBe('Conflict Co Renewed');
    const fresh = await postSave(WS, {
      listId: 'leads', save_id: 'save_cf3', action_id: 'act_rec_cf3',
      operations: [{
        op: 'cell.set', op_id: 'op_cf4',
        row_ref: { kind: 'entity', id: entityId }, column_id: 'name',
        value: 'Conflict Co Final', base_token: nameCell.version,
      }],
    });
    expect(fresh.status).toBe(200);
    expect(await liveEqualsRebuild()).toBe(true);
  });

  it('saves quotes, tasks, and drafts to their canonical stores', async () => {
    const made = await postSave(WS, {
      listId: 'leads', save_id: 'save_ct0', action_id: 'act_rec_ct0',
      operations: [{
        op: 'row.create', op_id: 'op_ct0',
        row_ref: { kind: 'entity', id: 'tmp-stores' }, list_id: 'leads',
        initial_values: { name: 'Stores Co' },
      }],
    });
    const entityId = (made.json['id_mappings'] as Record<string, string>)['tmp-stores']!;

    const quote = await postSave(WS, {
      listId: 'leads', save_id: 'save_ct1', action_id: 'act_rec_ct1',
      operations: [{
        op: 'cell.set', op_id: 'op_q',
        row_ref: { kind: 'entity', id: entityId }, column_id: 'value',
        value: { amount: 120000, currency: 'EUR', role: 'offered' },
      }],
    });
    expect(quote.status).toBe(200);
    const quoteRow = await env.DB.prepare(
      `SELECT kind, state FROM interaction_state WHERE workspace_id = ? AND entity_id = ? AND kind = 'quote'`,
    ).bind(WS, entityId).first<{ kind: string; state: string }>();
    expect(quoteRow?.state).toBe('active');
    const quoted = await getLists(WS, '?list=leads');
    const valueCell = quoted.lists.find((l) => l.id === 'leads')!.rows.find((r) => r.id === entityId)!
      .record_cells!['value']!;
    expect(valueCell.value).toEqual({ amount: 120000, currency: 'EUR', role: 'offered' });

    const task = await postSave(WS, {
      listId: 'tasks', save_id: 'save_ct2', action_id: 'act_rec_ct2',
      operations: [
        {
          op: 'row.create', op_id: 'op_t',
          row_ref: { kind: 'task', id: 'tmp-task' }, list_id: 'tasks',
          initial_values: { title: 'Call Stores Co' },
        },
      ],
    });
    expect(task.status).toBe(200);
    const taskId = (task.json['id_mappings'] as Record<string, string>)['tmp-task']!;
    const done = await postSave(WS, {
      listId: 'tasks', save_id: 'save_ct3', action_id: 'act_rec_ct3',
      operations: [{ op: 'cell.set', op_id: 'op_td', row_ref: { kind: 'task', id: taskId }, column_id: 'status', value: 'done' }],
    });
    expect(done.status).toBe(200);

    const draft = await postSave(WS, {
      listId: 'drafts', save_id: 'save_ct4', action_id: 'act_rec_ct4',
      operations: [{
        op: 'row.create', op_id: 'op_d',
        row_ref: { kind: 'draft', id: 'tmp-draft' }, list_id: 'drafts',
        initial_values: { content_text: 'Hello Stores', channel: 'whatsapp' },
      }],
    });
    expect(draft.status).toBe(200);
    const draftId = (draft.json['id_mappings'] as Record<string, string>)['tmp-draft']!;
    const edited = await postSave(WS, {
      listId: 'drafts', save_id: 'save_ct5', action_id: 'act_rec_ct5',
      operations: [{ op: 'cell.set', op_id: 'op_de', row_ref: { kind: 'draft', id: draftId }, column_id: 'content', value: 'Hello Stores!' }],
    });
    expect(edited.status).toBe(200);
    expect(await liveEqualsRebuild()).toBe(true);
  });

  it('sorts server-side on allowlisted columns and ignores invalid sort specs', async () => {
    for (const [suffix, name] of [['s1', 'Zulu Co'], ['s2', 'Alpha Co']] as Array<[string, string]>) {
      const res = await postSave(WS, {
        listId: 'leads', save_id: `save_sort_${suffix}`, action_id: `act_rec_sort_${suffix}`,
        operations: [{
          op: 'row.create', op_id: `op_sort_${suffix}`,
          row_ref: { kind: 'entity', id: `tmp-sort-${suffix}` }, list_id: 'leads',
          initial_values: { name },
        }],
      });
      expect(res.status).toBe(200);
    }
    const desc = await getLists(WS, '?list=leads&sort=name:desc&limit=100');
    const namesDesc = listById(desc, 'leads').rows.map((r) => r.cells['name']);
    const sortedDesc = [...namesDesc].sort().reverse();
    expect(namesDesc).toEqual(sortedDesc);

    const asc = await getLists(WS, '?list=leads&sort=name:asc&limit=100');
    const namesAsc = listById(asc, 'leads').rows.map((r) => r.cells['name']);
    expect(namesAsc).toEqual([...namesAsc].sort());

    // An invalid spec falls back to the default order instead of failing.
    const invalid = await getLists(WS, '?list=leads&sort=%3Bdrop:desc&limit=100');
    expect(listById(invalid, 'leads').rows.length).toBeGreaterThan(0);
  });

  it('round-trips multiline and tabbed note text exactly', async () => {
    const made = await postSave(WS, {
      listId: 'leads', save_id: 'save_ml0', action_id: 'act_rec_ml0',
      operations: [{
        op: 'row.create', op_id: 'op_ml0',
        row_ref: { kind: 'entity', id: 'tmp-multiline' }, list_id: 'leads',
        initial_values: { name: 'Multiline Co' },
      }],
    });
    const entityId = (made.json['id_mappings'] as Record<string, string>)['tmp-multiline']!;
    const text = 'Line one\nLine two\twith tab\nUnicode: naïve café  日本語';
    const saved = await postSave(WS, {
      listId: 'leads', save_id: 'save_ml1', action_id: 'act_rec_ml1',
      operations: [{
        op: 'cell.set', op_id: 'op_ml1',
        row_ref: { kind: 'entity', id: entityId }, column_id: 'notes', value: text,
      }],
    });
    expect(saved.status).toBe(200);

    const leads = await getLists(WS, '?list=leads');
    expect(leads.lists.find((l) => l.id === 'leads')!.rows.find((r) => r.id === entityId)!.cells['notes']).toBe(text);
    const notes = await getLists(WS, '?list=notes&limit=100');
    const entry = listById(notes, 'notes').rows.find((r) => r.cells['summary'] === text);
    expect(entry).toBeDefined();
    expect(entry!.record_cells!['summary']!.value).toBe(text);
  });

  it('exports records stores and erases them with the workspace', async () => {
    const { collectWorkspaceExportSections } = await import('../src/routes/exports.js');
    const sections = await collectWorkspaceExportSections(env.DB, WS);
    expect((sections.recordsLists ?? []).length).toBeGreaterThan(0);
    const { createWorkspace, deleteWorkspace } = await import('@otis/identity');
    const temp = await createWorkspace(env.DB, { name: 'Export Probe', ownerUserId: OWNER, workspaceId: 'ws-records-export-probe' });
    expect(temp.id).toBe('ws-records-export-probe');
    const probeSections = await collectWorkspaceExportSections(env.DB, temp.id);
    expect((probeSections.recordsLists ?? []).map((r) => r['id']).sort()).toEqual(['drafts', 'leads', 'notes', 'tasks']);
    await deleteWorkspace(env.DB, { workspaceId: temp.id, actorUserId: OWNER });
    const remaining = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM records_lists WHERE workspace_id = ?`,
    ).bind(temp.id).first<{ n: number }>();
    expect(Number(remaining?.n ?? -1)).toBe(0);
  });

  it('pages notes with keyset cursors and keys history by list', async () => {
    const made = await postSave(WS, {
      listId: 'leads', save_id: 'save_pg0', action_id: 'act_rec_pg0',
      operations: [{
        op: 'row.create', op_id: 'op_pg0',
        row_ref: { kind: 'entity', id: 'tmp-paging' }, list_id: 'leads',
        initial_values: { name: 'Paging Co' },
      }],
    });
    const entityId = (made.json['id_mappings'] as Record<string, string>)['tmp-paging']!;
    for (let i = 1; i <= 3; i++) {
      const res = await postSave(WS, {
        listId: 'leads', save_id: `save_pg${i}`, action_id: `act_rec_pg${i}`,
        operations: [{
          op: 'cell.set', op_id: `op_pg${i}`,
          row_ref: { kind: 'entity', id: entityId }, column_id: 'notes', value: `Paging note ${i}`,
        }],
      });
      expect(res.status).toBe(200);
    }
    const first = await getLists(WS, '?list=notes&limit=2');
    const notes = listById(first, 'notes');
    expect(notes.rows).toHaveLength(2);
    expect(notes.next_cursor).toBeTruthy();
    expect(notes.total_rows).toBeGreaterThanOrEqual(3);
    const second = await getLists(WS, `?list=notes&limit=2&cursor=${encodeURIComponent(notes.next_cursor!)}`);
    const notes2 = listById(second, 'notes');
    expect(notes2.rows.length).toBeGreaterThan(0);
    const seen = new Set([...notes.rows, ...notes2.rows].map((r) => r.id));
    expect(seen.size).toBe(notes.rows.length + notes2.rows.length);

    // History carries the saves under their own list, not as Leads.
    const full = await getLists(WS, '');
    expect((full.history['leads'] ?? []).some((h) => h.id === 'act_rec_pg1')).toBe(true);
  });

  it('keeps a single-cell save to a bounded statement budget', async () => {
    const made = await postSave(WS, {
      listId: 'leads', save_id: 'save_cost0', action_id: 'act_rec_cost0',
      operations: [{
        op: 'row.create', op_id: 'op_cost0',
        row_ref: { kind: 'entity', id: 'tmp-cost' }, list_id: 'leads',
        initial_values: { name: 'Cost Co' },
      }],
    });
    const entityId = (made.json['id_mappings'] as Record<string, string>)['tmp-cost']!;

    let prepares = 0;
    let batches = 0;
    const target = env.DB as unknown as Record<string, unknown>;
    const proxy = new Proxy(target, {
      get(t, prop, receiver) {
        if (prop === 'prepare') {
          return (query: string) => {
            prepares += 1;
            return (t['prepare'] as (q: string) => D1PreparedStatement).call(t, query);
          };
        }
        if (prop === 'batch') {
          return (statements: D1PreparedStatement[]) => {
            batches += 1;
            return (t['batch'] as (s: D1PreparedStatement[]) => Promise<D1Result[]>).call(t, statements);
          };
        }
        const value = Reflect.get(t, prop, receiver);
        return typeof value === 'function' ? (value as (...a: never[]) => unknown).bind(t) : value;
      },
    });
    const res = await executeLedgerCommand(
      proxy as unknown as D1Database, makeContext('act_rec_cost1', await revisionOf(WS)), 'records_batch',
      {
        save_id: 'save_cost1', list_id: 'leads',
        operations: [{ op: 'cell.set', op_id: 'op_cost1', row_ref: { kind: 'entity', id: entityId }, column_id: 'name', value: 'Cost Co Renamed' }],
      },
      handleRecordsBatch,
    );
    expect(res.status).toBe('applied');
    // Targeted hydration (entity family batch, touched-lifecycle batch,
    // records-scope batch) plus one atomic commit batch: cost follows the
    // touched entity, never the workspace. 25 prepares: guard/receipt reads,
    // 7-statement family hydration, touched lifecycle reads, records scope
    // reads including the targeted column definitions behind the
    // calculated-column write guard, and the commit sequence (guard, event,
    // receipt, quota, workspace, entity row). Re-pin with cause if this moves.
    expect(batches).toBe(4);
    expect(prepares).toBe(25);
  });

  it('rolls a chunk back atomically when a later op is invalid', async () => {    const beforeEvents = await eventCount(WS);
    const beforeRev = await revisionOf(WS);
    const res = await executeLedgerCommand(
      env.DB, makeContext('act_rec_atomic', beforeRev), 'records_batch',
      {
        save_id: 'save_atomic', list_id: 'leads',
        operations: [
          { op: 'cell.set', op_id: 'op_ok', row_ref: { kind: 'entity', id: 'ghost-target' }, column_id: 'name', value: 'Ghost' },
          { op: 'cell.set', op_id: 'op_bad', row_ref: { kind: 'entity', id: 'missing-ent' }, column_id: 'name', value: 'Nope' },
        ],
      },
      handleRecordsBatch,
    );
    expect(res.status).toBe('rejected');
    expect(await eventCount(WS)).toBe(beforeEvents);
    expect(await revisionOf(WS)).toBe(beforeRev);
    expect(await liveEqualsRebuild()).toBe(true);
  });

  it('pins a no-op save without consuming a revision', async () => {
    const made = await postSave(WS, {
      listId: 'leads', save_id: 'save_np0', action_id: 'act_rec_np0',
      operations: [{
        op: 'row.create', op_id: 'op_np0',
        row_ref: { kind: 'entity', id: 'tmp-noop' }, list_id: 'leads',
        initial_values: { name: 'Noop Co' },
      }],
    });
    const entityId = (made.json['id_mappings'] as Record<string, string>)['tmp-noop']!;
    const beforeRev = await revisionOf(WS);
    const noop = await postSave(WS, {
      listId: 'leads', save_id: 'save_np1', action_id: 'act_rec_np1',
      operations: [{ op: 'cell.set', op_id: 'op_np1', row_ref: { kind: 'entity', id: entityId }, column_id: 'name', value: 'Noop Co' }],
    });
    expect(noop.status).toBe(200);
    expect(noop.json['status']).toBe('already_applied');
    expect(await revisionOf(WS)).toBe(beforeRev);
  });

  it('undoes a save and restores live equal to rebuild', async () => {
    const made = await postSave(WS, {
      listId: 'leads', save_id: 'save_un0', action_id: 'act_rec_un0',
      operations: [{
        op: 'row.create', op_id: 'op_un0',
        row_ref: { kind: 'entity', id: 'tmp-undo' }, list_id: 'leads',
        initial_values: { name: 'Undo Co', phone: '+15550001111' },
      }],
    });
    const entityId = (made.json['id_mappings'] as Record<string, string>)['tmp-undo']!;
    const renamed = await postSave(WS, {
      listId: 'leads', save_id: 'save_un1', action_id: 'act_rec_un1',
      operations: [{ op: 'cell.set', op_id: 'op_un1', row_ref: { kind: 'entity', id: entityId }, column_id: 'name', value: 'Undo Co Renamed' }],
    });
    expect(renamed.status).toBe(200);

    const allEvents = await getWorkspaceEvents(env.DB, WS);
    const allActions = await getWorkspaceActions(env.DB, WS);
    const undone = await executeLedgerCommand(
      env.DB, makeContext('act_rec_undo1', await revisionOf(WS)), 'undo',
      { action_id: 'act_rec_un1', mode: 'single', client_operation_id: 'cop_rec_undo1', expected_revision: await revisionOf(WS) },
      (c, s, seq, req) => handleUndoCommit(c, allEvents, allActions, s, seq, req),
    );
    expect(undone.status).toBe('applied');
    const after = await getLists(WS, '?list=leads');
    const nameCell = after.lists.find((l) => l.id === 'leads')!.rows.find((r) => r.id === entityId)!
      .record_cells!['name']!;
    expect(nameCell.value).toBe('Undo Co');
    expect(await liveEqualsRebuild()).toBe(true);
  });
});
