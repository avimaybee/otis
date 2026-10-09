import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  DEFAULT_COMMAND_HANDLERS, computeUndoPreview, executeLedgerCommand,
  getActionReceipt, getWorkspaceActions, getWorkspaceEvents, getWorkspaceProjectionState,
  handleUndoCommit, rebuildProjections, type LedgerCommandContext,
} from '../../packages/ledger/src/index.js';
import { validateToolCall } from '../../packages/agent/src/tools.js';
import { ALL_MIGRATION_SQL, applyMigrationSql, applyMigrations } from '../../apps/worker/test/migrations.js';
import { readLeadOverview } from '../../apps/worker/src/agent/leadOverview.js';
import { readBriefCandidates } from '../../apps/worker/src/brief/read.js';

// Maintained source-derived review probes, outside the default suite.
// First-review controls plus counterexamples from the ecc2246 source trace.
const USER = 'c1_recheck_user';
const OLD = '2026-09-01T10:00:00.000Z';
const RECENT = '2026-09-20T10:00:00.000Z';
let workspaceId: string;
let sourceId: string;

beforeAll(async () => {
  await applyMigrations(env.DB);
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO users (id, firebase_uid, display_name, created_at, updated_at)
    VALUES (?, ?, 'C1 review member', ?, ?)`).bind(USER, USER, now, now).run();
});

beforeEach(async () => {
  workspaceId = `c1_recheck_${crypto.randomUUID()}`;
  sourceId = `c1_source_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO workspaces (id, name, owner_user_id, created_at, updated_at)
    VALUES (?, 'Synthetic C1 review', ?, ?, ?)`).bind(workspaceId, USER, now, now).run();
  await env.DB.prepare(`INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
    VALUES (?, ?, 'owner', ?, ?, ?)`).bind(workspaceId, USER, now, now, now).run();
  await env.DB.prepare(`INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id,
    payload_fingerprint, status, created_at, updated_at)
    VALUES (?, ?, ?, 'web', ?, 'c1-synthetic', 'processed', ?, ?)`)
    .bind(sourceId, workspaceId, USER, sourceId, now, now).run();
});

async function context(): Promise<LedgerCommandContext> {
  const meta = await env.DB.prepare(`SELECT business_revision FROM workspaces WHERE id = ?`)
    .bind(workspaceId).first<{ business_revision: number }>();
  return {
    workspace_id: workspaceId, actor: { kind: 'member', user_id: USER },
    source_message_id: sourceId, membership_revision: 1,
    request_id: `c1_request_${crypto.randomUUID()}`, action_id: `c1_action_${crypto.randomUUID()}`,
    expected_business_revision: meta!.business_revision,
  };
}

async function command(name: string, args: unknown) {
  return executeLedgerCommand(env.DB, await context(), name, args, DEFAULT_COMMAND_HANDLERS[name]!);
}
const state = () => getWorkspaceProjectionState(env.DB, workspaceId);
const events = () => getWorkspaceEvents(env.DB, workspaceId);
const offered = (amount: number) => ({ amount, currency: 'EUR', role: 'offered' });

async function entity(name = 'Copper Foundry') {
  const result = await command('create_entity', { name, kind: 'lead', initial_status: 'warm' });
  expect(result.status).toBe('applied');
  return (result.data as { entity_id: string }).entity_id;
}
async function log(entityId: string | null, kind: string, payload: Record<string, unknown>, occurredAt = OLD) {
  const result = await command('log_event', { entity_id: entityId, kind, payload, occurred_at: occurredAt });
  expect(result.status).toBe('applied');
  return result;
}
const eventId = (result: { data?: unknown }) => (result.data as { event_id: string }).event_id;
async function revise(root: string, head: string, kind: string, payload: Record<string, unknown>, occurredAt?: string) {
  return command('revise_interaction', {
    interaction_id: root, expected_head_event_id: head, kind, payload,
    ...(occurredAt === undefined ? {} : { occurred_at: occurredAt }),
  });
}
async function remove(root: string, head = root) {
  return command('remove_interaction', { interaction_id: root, expected_head_event_id: head });
}
async function undo(actionId: string) {
  const allEvents = await events();
  const allActions = await getWorkspaceActions(env.DB, workspaceId);
  const ctx = await context();
  const request = { action_id: actionId, mode: 'single' as const,
    client_operation_id: ctx.action_id, expected_revision: ctx.expected_business_revision! };
  return executeLedgerCommand(env.DB, ctx, 'undo', request,
    (current, before, sequence, args) => handleUndoCommit(current, allEvents, allActions, before, sequence, args));
}

describe('C1 first-review semantic controls', () => {
  it('preserves occurrence when only quote content changes', async () => {
    const id = await entity();
    const root = eventId(await log(id, 'quote', offered(45000)));
    expect((await revise(root, root, 'quote', offered(50000))).status).toBe('applied');
    expect((await state()).interactions.get(root)?.occurred_at).toBe(OLD);
  });
  it('rejects impossible calendar dates without changing the head', async () => {
    const root = eventId(await log(null, 'note', { text: 'Original' }));
    expect((await revise(root, root, 'note', { text: 'Correction' }, '2026-02-30T10:00:00.000Z')).status).toBe('rejected');
    expect((await state()).interactions.get(root)?.head_event_id).toBe(root);
  });
  it('excludes a removed only quote from current field state', async () => {
    const id = await entity();
    const root = eventId(await log(id, 'quote', offered(45000)));
    expect((await remove(root)).status).toBe('applied');
    const live = await state();
    const replay = rebuildProjections(await events());
    expect(live.interactions.get(root)?.state).toBe('removed');
    expect({ live: live.fields.get(`${id}:quote`)?.value_text ?? null,
      replay: replay.fields.get(`${id}:quote`)?.value_text ?? null }).toEqual({ live: null, replay: null });
  });
  it('does not resolve another active quote claim by editing one root', async () => {
    const id = await entity();
    const first = eventId(await log(id, 'quote', offered(45000)));
    const second = eventId(await log(id, 'quote', offered(70000), RECENT));
    expect((await revise(first, first, 'quote', offered(50000))).status).toBe('applied');
    const field = (await state()).fields.get(`${id}:quote`);
    expect(field?.state).toBe('disputed');
    expect(field?.candidate_event_ids).toContain(second);
  });
  it('drops removed contact from both overview and brief last-contact reads', async () => {
    const id = await entity();
    await log(id, 'contact', { summary: 'Older contact', channel: 'phone' });
    const recent = eventId(await log(id, 'contact', { summary: 'Recent contact', channel: 'phone' }, RECENT));
    expect((await remove(recent)).status).toBe('applied');
    const overview = await readLeadOverview(env.DB, { workspaceId, actorUserId: USER });
    const brief = await readBriefCandidates(env.DB, workspaceId, USER);
    expect({ overview: overview.rows.find(row => row.lead_id === id)?.last_contact_at,
      brief: brief.leads.find(row => row.entityId === id)?.lastContactAt }).toEqual({ overview: OLD, brief: OLD });
  });
  it('does not let lower-level logging replace a different client root', async () => {
    const first = await entity();
    const second = await entity('Violet Studio');
    const root = eventId(await log(first, 'note', { text: 'First entry' }));
    const args = { entity_id: second, kind: 'note', payload: { text: 'Second entry', interaction_id: root } };
    expect(validateToolCall('log_event', args).ok).toBe(false);
    await command('log_event', args);
    expect((await state()).interactions.get(root)).toMatchObject({ entity_id: first, head_event_id: root, revision: 1 });
  });
  it('does not backfill a legacy root after its client was deleted', async () => {
    const id = await entity();
    const root = eventId(await log(id, 'note', { text: 'Legacy entry' }));
    expect((await command('delete_entity', { entity_id: id, confirm: 'yes' })).status).toBe('applied');
    await applyMigrationSql(env.DB, ALL_MIGRATION_SQL[22]!);
    expect({ live: (await state()).interactions.has(root), replay: rebuildProjections(await events()).interactions.has(root) })
      .toEqual({ live: false, replay: false });
  });
  it('includes the restored entry in removal Undo preview', async () => {
    const root = eventId(await log(null, 'note', { text: 'Entry to restore' }));
    const removed = await remove(root);
    expect(removed.status).toBe('applied');
    const receipt = await getActionReceipt(env.DB, workspaceId, removed.action_id!);
    const preview = computeUndoPreview(removed.action_id!, 'single', [receipt!], await events(), await state(), removed.committed_revision!);
    expect(preview.affected_event_ids).toHaveLength(1);
    expect(preview.affected_context).toHaveLength(1);
  });
  it('control: rejects a stale head after a valid correction', async () => {
    const root = eventId(await log(null, 'note', { text: 'Original' }));
    expect((await revise(root, root, 'note', { text: 'Updated' })).status).toBe('applied');
    const stale = await revise(root, root, 'note', { text: 'Stale edit' });
    expect(stale.status).toBe('conflict');
    expect(stale.error?.code).toBe('head_conflict');
  });
});

describe('C1 second source-review counterexamples', () => {
  it('removes persisted lifecycle rows when an original log is actually undone', async () => {
    const logged = await log(null, 'note', { text: 'Undo this entry' });
    const root = eventId(logged);
    expect((await undo(logged.action_id!)).status).toBe('applied');
    expect({ live: (await state()).interactions.has(root), replay: rebuildProjections(await events()).interactions.has(root) })
      .toEqual({ live: false, replay: false });
  });
  it('does not mistake an earlier revision for a later Undo dependency', async () => {
    const root = eventId(await log(null, 'note', { text: 'Original' }));
    const first = await revise(root, root, 'note', { text: 'First correction' });
    expect(first.status).toBe('applied');
    const second = await revise(root, eventId(first), 'note', { text: 'Second correction' });
    expect(second.status).toBe('applied');
    expect((await undo(second.action_id!)).status).toBe('applied');
    expect((await state()).interactions.get(root)?.head_event_id).toBe(eventId(first));
  });
  it('does not let an already-undone descendant block its original entry', async () => {
    const logged = await log(null, 'note', { text: 'Original' });
    const root = eventId(logged);
    const changed = await revise(root, root, 'note', { text: 'Correction' });
    expect(changed.status).toBe('applied');
    expect((await undo(changed.action_id!)).status).toBe('applied');
    expect((await undo(logged.action_id!)).status).toBe('applied');
  });
  it('preserves a resolved quote when removing a duplicate active quote', async () => {
    const id = await entity();
    await log(id, 'quote', offered(45000));
    await log(id, 'quote', offered(70000));
    const duplicate = eventId(await log(id, 'quote', offered(45000)));
    const disputed = (await state()).fields.get(`${id}:quote`)!;
    expect((await command('resolve_conflict', { entity_id: id, field_name: 'quote',
      candidate_event_ids: disputed.candidate_event_ids, resolved_value: offered(45000), rationale: '450 is correct' })).status).toBe('applied');
    expect((await remove(duplicate)).status).toBe('applied');
    expect((await state()).fields.get(`${id}:quote`)?.state).toBe('clear');
  });
  it('rejects a non-ISO occurrence instead of persisting sortable-looking text', async () => {
    const root = eventId(await log(null, 'note', { text: 'Original' }));
    expect((await revise(root, root, 'note', { text: 'Corrected' }, 'September 1, 2026 10:00:00 GMT')).status).toBe('rejected');
  });
  it('normalizes valid zoned occurrences before last-contact ranking', async () => {
    const id = await entity();
    const root = eventId(await log(id, 'contact', { summary: 'Earlier contact', channel: 'phone' }));
    const later = '2026-09-20T12:00:00.000Z';
    await log(id, 'contact', { summary: 'Later contact', channel: 'phone' }, later);
    expect((await revise(root, root, 'contact', { summary: 'Date corrected', channel: 'phone' }, '2026-09-21T00:00:00+14:00')).status).toBe('applied');
    const overview = await readLeadOverview(env.DB, { workspaceId, actorUserId: USER });
    expect(overview.rows.find(row => row.lead_id === id)?.last_contact_at).toBe(later);
  });
  it('backfills legacy quote snapshots in the same shape as replay', async () => {
    const id = await entity();
    const root = eventId(await log(id, 'quote', { ...offered(45000), description: 'Includes installation' }));
    // Synthetic legacy-equivalent original event; restore only its absent
    // projection through actual backfill SQL. No production data involved.
    await env.DB.prepare(`DELETE FROM interaction_state WHERE workspace_id = ? AND root_event_id = ?`).bind(workspaceId, root).run();
    await applyMigrationSql(env.DB, ALL_MIGRATION_SQL[22]!);
    const live = (await state()).interactions.get(root)!;
    const replay = rebuildProjections(await events()).interactions.get(root)!;
    expect(JSON.parse(live.head_value_json!)).toEqual(JSON.parse(replay.head_value_json!));
  });
  it('requires the same valid contact channel for a correction as for new logging', async () => {
    const root = eventId(await log(null, 'contact', { summary: 'Original', channel: 'phone' }));
    const payload = { summary: 'Correction', channel: 'carrier-pigeon' };
    expect(validateToolCall('log_event', { kind: 'contact', payload }).ok).toBe(false);
    const args = { interaction_id: root, expected_head_event_id: root, kind: 'contact', payload };
    const changed = await command('revise_interaction', args);
    expect({ toolAccepted: validateToolCall('revise_interaction', args).ok, ledgerStatus: changed.status })
      .toEqual({ toolAccepted: false, ledgerStatus: 'rejected' });
  });
});
