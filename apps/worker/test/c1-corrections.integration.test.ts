import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  DEFAULT_COMMAND_HANDLERS, computeUndoPreview, executeLedgerCommand, readCurrentInteractions, resolveInteractionEntities,
  getActionReceipt, getWorkspaceActions, getWorkspaceEvents, getWorkspaceProjectionState,
  handleUndoCommit, rebuildProjections, type LedgerCommandContext,
} from '@otis/ledger';
import { validateToolCall } from '@otis/agent';
import { ALL_MIGRATION_SQL, applyMigrationSql, applyMigrations } from './migrations.js';



// Production regressions for C1 source-derived counterexamples.
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
const eventId = (result: { data?: unknown; event_ids?: string[] }) =>
  (result.data as { event_id?: string } | undefined)?.event_id ?? result.event_ids![0]!;
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

async function resolveQuote(id: string, amount = 45000) {
  const disputed = (await state()).fields.get(`${id}:quote`)!;
  const resolved = await command('resolve_conflict', { entity_id: id, field_name: 'quote',
    candidate_event_ids: disputed.candidate_event_ids, resolved_value: offered(amount) });
  expect(resolved.status).toBe('applied');
  return resolved;
}

describe('C1 current entries and explicit quote decisions', () => {
  it('preserves a later resolution when single Undo would remove one of its source claims', async () => {
    const id = await entity();
    const original = await log(id, 'quote', offered(45000));
    await log(id, 'quote', offered(70000));
    await resolveQuote(id);
    const undone = await undo(original.action_id!);
    expect(undone.status).toBe('needs_clarification');
    expect((await state()).fields.get(`${id}:quote`)?.state).toBe('clear');
  });
  it('retains a resolution through description/date corrections but disputes a new financial claim', async () => {
    const id = await entity();
    const selected = eventId(await log(id, 'quote', offered(45000)));
    const rejected = eventId(await log(id, 'quote', offered(70000)));
    const resolved = await resolveQuote(id);
    const changed = await revise(rejected, rejected, 'quote', { ...offered(70000), description: 'Historical quote' }, RECENT);
    expect(changed.status).toBe('applied');
    const clear = (await state()).fields.get(`${id}:quote`)!;
    expect(clear.state).toBe('clear');
    expect(clear.source_event_id).toBe(eventId(resolved));
    expect((await remove(selected)).status).toBe('applied');
    expect((await state()).fields.get(`${id}:quote`)?.state).toBe('clear');
    expect((await revise(rejected, eventId(changed), 'quote', offered(80000))).status).toBe('applied');
    const disputed = (await state()).fields.get(`${id}:quote`)!;
    expect(disputed.state).toBe('disputed');
    expect(disputed.candidate_event_ids).toContain(eventId(resolved));
    expect(disputed).toEqual(rebuildProjections(await events()).fields.get(`${id}:quote`));
  });
  it('preserves an independent field report when its competing quote entry is removed', async () => {
    const id = await entity();
    const root = eventId(await log(id, 'quote', offered(45000)));
    const field = await command('set_field', { entity_id: id, field_name: 'quote', value: offered(70000) });
    expect(field.status).toBe('applied');
    expect((await state()).fields.get(`${id}:quote`)?.state).toBe('disputed');
    expect((await remove(root)).status).toBe('applied');
    const current = (await state()).fields.get(`${id}:quote`)!;
    expect(current.state).toBe('clear');
    expect(JSON.parse(current.value_json!)).toEqual(offered(70000));
    expect(current).toEqual(rebuildProjections(await events()).fields.get(`${id}:quote`));
  });
  it('keeps an explicit field correction authoritative through quote cleanup and Undo', async () => {
    const id = await entity();
    const root = eventId(await log(id, 'quote', offered(45000)));
    const corrected = await command('set_field', { entity_id: id, field_name: 'quote', value: offered(70000), supersedes_event_id: root });
    expect(corrected.status).toBe('applied');
    const changed = await revise(root, root, 'quote', { ...offered(45000), description: 'Original quote' });
    expect(changed.status).toBe('applied');
    expect(JSON.parse((await state()).fields.get(`${id}:quote`)!.value_json!)).toEqual(offered(70000));
    expect((await undo(changed.action_id!)).status).toBe('applied');
    expect((await undo(corrected.action_id!)).status).toBe('applied');
    expect(JSON.parse((await state()).fields.get(`${id}:quote`)!.value_json!)).toEqual(offered(45000));
  });
  it('lists one current head per root, pages without duplicates, and excludes removals/Undo/other workspaces', async () => {
    const id = await entity();
    const first = eventId(await log(id, 'note', { text: 'First' }));
    const changed = await revise(first, first, 'note', { text: 'First corrected' });
    const removed = eventId(await log(id, 'note', { text: 'Removed' }));
    await remove(removed);
    const undone = await log(id, 'note', { text: 'Undone' });
    await undo(undone.action_id!);
    const second = eventId(await log(id, 'note', { text: 'Second' }));
    const page = await readCurrentInteractions(env.DB, workspaceId, { entity_id: id, limit: 1 });
    expect(page.rows.map(row => row.interaction_id)).toEqual([second]);
    expect(page.has_more).toBe(true);
    const last = await readCurrentInteractions(env.DB, workspaceId, { entity_id: id, limit: 1, cursor: page.next_cursor! });
    expect(last.rows[0]).toMatchObject({ interaction_id: first, head_event_id: eventId(changed), payload: { text: 'First corrected' }, actor_user_id: USER });
    expect(last.has_more).toBe(false);
    expect((await readCurrentInteractions(env.DB, 'another-workspace', { interaction_id: first })).rows).toEqual([]);
    expect(await resolveInteractionEntities(env.DB, workspaceId, [first, second, removed])).toEqual(new Map([[first, id], [second, id]]));
    expect(await resolveInteractionEntities(env.DB, 'another-workspace', [first])).toEqual(new Map());
    expect(validateToolCall('query', { resource: 'interactions', filters: { kind: 'note', entity_id: id } }).ok).toBe(true);
    expect(validateToolCall('query', { resource: 'interactions', cursor: '1 OR 1=1' }).ok).toBe(false);
  });
  it('returns current content on head conflicts, and a no-op adds neither revision nor quota', async () => {
    const root = eventId(await log(null, 'note', { text: 'Original' }));
    const changed = await revise(root, root, 'note', { text: 'Corrected' });
    const stale = await revise(root, root, 'note', { text: 'Outdated overwrite' });
    expect(stale.status).toBe('conflict');
    expect(stale.data).toMatchObject({ head_event_id: eventId(changed), current: { payload: { text: 'Corrected' }, occurred_at: OLD } });
    const before = await env.DB.prepare('SELECT business_revision FROM workspaces WHERE id = ?').bind(workspaceId).first();
    const quotaBefore = await env.DB.prepare('SELECT action_count FROM workspace_daily_actions WHERE workspace_id = ?').bind(workspaceId).first();
    expect((await revise(root, eventId(changed), 'note', { text: 'Corrected' })).status).toBe('already_applied');
    expect(await env.DB.prepare('SELECT business_revision FROM workspaces WHERE id = ?').bind(workspaceId).first()).toEqual(before);
    expect(await env.DB.prepare('SELECT action_count FROM workspace_daily_actions WHERE workspace_id = ?').bind(workspaceId).first()).toEqual(quotaBefore);
  });
  it('shows the content and original date that Undo restores', async () => {
    const root = eventId(await log(null, 'note', { text: 'Original detail' }));
    const changed = await revise(root, root, 'note', { text: 'Wrong detail' }, RECENT);
    const preview = computeUndoPreview(changed.action_id!, 'single', await getWorkspaceActions(env.DB, workspaceId), await events(), await state(), 0);
    expect(preview.affected_context?.[0]?.changes.join(' ')).toContain('Original detail');
    expect(preview.affected_context?.[0]?.changes.join(' ')).toContain(OLD);
  });
  it('pins no-effect edit/remove payloads and rolls back their receipts on authority loss', async () => {
    const root = eventId(await log(null, 'note', { text: 'Unchanged' }));
    const args = { interaction_id: root, expected_head_event_id: root, kind: 'note', payload: { text: 'Unchanged' } };
    const ctx = await context();
    const quota = await env.DB.prepare('SELECT action_count FROM workspace_daily_actions WHERE workspace_id = ?').bind(workspaceId).first();
    const guards = await env.DB.prepare('SELECT COUNT(*) AS n FROM ledger_guards').first();
    const invoke = (c: LedgerCommandContext, value = args) => executeLedgerCommand(env.DB, c, 'revise_interaction', value, DEFAULT_COMMAND_HANDLERS['revise_interaction']!);
    expect((await invoke(ctx)).status).toBe('already_applied');
    expect(await getActionReceipt(env.DB, workspaceId, ctx.action_id)).toMatchObject({ result_status: 'already_applied', committed_revision: ctx.expected_business_revision });
    expect((await invoke(ctx)).status).toBe('already_applied');
    expect((await invoke(ctx, { ...args, payload: { text: 'Changed retry' } })).error?.code).toBe('action_conflict');
    expect(await env.DB.prepare('SELECT action_count FROM workspace_daily_actions WHERE workspace_id = ?').bind(workspaceId).first()).toEqual(quota);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM ledger_guards').first()).toEqual(guards);
    expect((await events())).toHaveLength(1);

    const badSource = { ...await context(), source_message_id: 'missing-source' };
    expect((await invoke(badSource)).status).toBe('rejected');
    expect(await getActionReceipt(env.DB, workspaceId, badSource.action_id)).toBeNull();
    const staleFence = { ...await context(), fence: 999 };
    expect((await invoke(staleFence)).status).toBe('conflict');
    expect(await getActionReceipt(env.DB, workspaceId, staleFence.action_id)).toBeNull();

    expect((await remove(root)).status).toBe('applied');
    const removeCtx = await context();
    const removeArgs = { interaction_id: root, expected_head_event_id: root };
    expect((await executeLedgerCommand(env.DB, removeCtx, 'remove_interaction', removeArgs, DEFAULT_COMMAND_HANDLERS['remove_interaction']!)).status).toBe('already_applied');
    expect(await getActionReceipt(env.DB, workspaceId, removeCtx.action_id)).not.toBeNull();
    expect((await executeLedgerCommand(env.DB, removeCtx, 'remove_interaction', { ...removeArgs, reason: 'Different retry' }, DEFAULT_COMMAND_HANDLERS['remove_interaction']!)).error?.code).toBe('action_conflict');
  });
  it('upgrades unresolved field claims and retains them through quote removal', async () => {
    const id = await entity();
    const root = eventId(await log(id, 'quote', offered(45000)));
    await command('set_field', { entity_id: id, field_name: 'quote', value: offered(70000) });
    await command('set_field', { entity_id: id, field_name: 'quote', value: offered(90000) });
    await env.DB.prepare('ALTER TABLE entity_state DROP COLUMN quote_authority_json').run();
    await env.DB.prepare('DROP INDEX idx_interaction_current').run();
    await applyMigrationSql(env.DB, ALL_MIGRATION_SQL[24]!);
    expect((await remove(root)).status).toBe('applied');
    const field = (await state()).fields.get(`${id}:quote`)!;
    expect(field.state).toBe('disputed');
    expect(field.candidate_event_ids).toHaveLength(2);
    expect(field).toEqual(rebuildProjections(await events()).fields.get(`${id}:quote`));
  });
  it('upgrades a populated legacy resolved quote without losing original bodies or its decision', async () => {
    const id = await entity();
    const selected = eventId(await log(id, 'quote', { ...offered(45000), description: 'Includes installation' }));
    const rejected = eventId(await log(id, 'quote', offered(70000)));
    const resolved = await resolveQuote(id);
    const before = await events();
    // Emulate the actual pre-0025 schema on this isolated test database.
    await env.DB.prepare('ALTER TABLE entity_state DROP COLUMN quote_authority_json').run();
    await env.DB.prepare('DROP INDEX idx_interaction_current').run();
    await env.DB.prepare('UPDATE interaction_state SET head_value_json = (SELECT payload_json FROM events WHERE id = head_event_id AND workspace_id = interaction_state.workspace_id) WHERE workspace_id = ? AND root_event_id = ?').bind(workspaceId, selected).run();
    await applyMigrationSql(env.DB, ALL_MIGRATION_SQL[24]!);
    const field = (await state()).fields.get(`${id}:quote`)!;
    const metadata = JSON.parse(field.quote_authority_json!);
    expect(metadata.event_id).toBe(eventId(resolved));
    expect(typeof metadata.value_json).toBe('string');
    expect(JSON.parse(metadata.covered[selected])).toEqual(offered(45000));
    const changed = await revise(rejected, rejected, 'quote', { ...offered(70000), description: 'Still rejected' });
    expect(changed.status).toBe('applied');
    expect((await state()).fields.get(`${id}:quote`)?.state).toBe('clear');
    expect((await events()).slice(0, before.length)).toEqual(before);
    expect((await state()).fields.get(`${id}:quote`)).toEqual(rebuildProjections(await events()).fields.get(`${id}:quote`));
  });
});
