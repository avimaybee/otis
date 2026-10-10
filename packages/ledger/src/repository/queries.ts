/**
 * @otis/ledger/repository/queries
 * Database reads for ledger events, action receipts, and current projections.
 */

import type {
  ActionReceipt,
  DraftProjection,
  Entity,
  EntityAlias,
  EntityStateField,
  InteractionState,
  LedgerEvent,
  MemoryEntry,
  MemorySuppression,
  Task,
} from '@otis/contracts';
import type { LedgerProjectionState, ProjectionCoverage } from '../types.js';
import { CURRENT_INTERACTION_COLUMNS, CURRENT_INTERACTION_JOINS, mapCurrentInteraction } from './interactions.js';
import { hydrateBusinessDetails } from './business.js';
import { hydrateRecordsDetails, hydrateRecordsScope } from './records.js';
import { ENTITY_FAMILY_SQL, familyBinds } from './canonical.js';

export async function getWorkspaceRevision(
  db: D1Database,
  workspaceId: string,
): Promise<{ business_revision: number; last_event_sequence: number; lease_fence: number; lease_expires_at: string | null } | null> {
  const row = await db
    .prepare(
      `SELECT business_revision, last_event_sequence, lease_fence, lease_expires_at
       FROM workspaces WHERE id = ?`
    )
    .bind(workspaceId)
    .first<Record<string, unknown>>();

  if (!row) return null;

  return {
    business_revision: Number(row['business_revision'] || 0),
    last_event_sequence: Number(row['last_event_sequence'] || 0),
    lease_fence: Number(row['lease_fence'] || 0),
    lease_expires_at: row['lease_expires_at'] ? String(row['lease_expires_at']) : null,
  };
}

export async function getActionReceipt(
  db: D1Database,
  workspaceId: string,
  actionId: string,
): Promise<ActionReceipt | null> {
  const row = await db
    .prepare(
      `SELECT id, workspace_id, action_id, payload_hash, command_name, result_status, result_json,
              actor_kind, actor_user_id, source_message_id, source_job_id, run_id, step_id,
              committed_revision, created_at
       FROM action_receipts WHERE workspace_id = ? AND action_id = ?`
    )
    .bind(workspaceId, actionId)
    .first<Record<string, unknown>>();

  if (!row) return null;

  return {
    id: String(row['id']),
    workspace_id: String(row['workspace_id']),
    action_id: String(row['action_id']),
    payload_hash: String(row['payload_hash']),
    command_name: String(row['command_name']),
    result_status: row['result_status'] as ActionReceipt['result_status'],
    result_json: String(row['result_json']),
    actor_kind: row['actor_kind'] as ActionReceipt['actor_kind'],
    actor_user_id: row['actor_user_id'] ? String(row['actor_user_id']) : null,
    source_message_id: row['source_message_id'] ? String(row['source_message_id']) : null,
    source_job_id: row['source_job_id'] ? String(row['source_job_id']) : null,
    run_id: row['run_id'] ? String(row['run_id']) : null,
    step_id: row['step_id'] ? String(row['step_id']) : null,
    committed_revision: Number(row['committed_revision']),
    created_at: String(row['created_at']),
  };
}

export async function getWorkspaceEvents(
  db: D1Database,
  workspaceId: string,
): Promise<LedgerEvent[]> {
  const rows = (
    await db
      .prepare(
        `SELECT id, workspace_id, sequence, entity_id, actor_kind, actor_user_id, actor_job_id,
                kind, schema_version, payload_json, occurred_at, recorded_at, channel,
                source_message_id, source_job_id, action_id, supersedes_event_id, reverts_event_id,
                provenance, created_at
         FROM events WHERE workspace_id = ? ORDER BY sequence ASC`
      )
      .bind(workspaceId)
      .all<Record<string, unknown>>()
  ).results || [];

  return rows.map((r: Record<string, unknown>) => ({
    id: String(r['id']),
    workspace_id: String(r['workspace_id']),
    sequence: Number(r['sequence']),
    entity_id: r['entity_id'] ? String(r['entity_id']) : null,
    actor_kind: r['actor_kind'] as LedgerEvent['actor_kind'],
    actor_user_id: r['actor_user_id'] ? String(r['actor_user_id']) : null,
    actor_job_id: r['actor_job_id'] ? String(r['actor_job_id']) : null,
    kind: r['kind'] as LedgerEvent['kind'],
    schema_version: Number(r['schema_version']),
    payload: JSON.parse(String(r['payload_json'] || '{}')),
    occurred_at: String(r['occurred_at']),
    recorded_at: String(r['recorded_at']),
    channel: r['channel'] as LedgerEvent['channel'],
    source_message_id: r['source_message_id'] ? String(r['source_message_id']) : null,
    source_job_id: r['source_job_id'] ? String(r['source_job_id']) : null,
    action_id: String(r['action_id']),
    supersedes_event_id: r['supersedes_event_id'] ? String(r['supersedes_event_id']) : null,
    reverts_event_id: r['reverts_event_id'] ? String(r['reverts_event_id']) : null,
    provenance: r['provenance'] as LedgerEvent['provenance'],
    created_at: String(r['created_at']),
  }));
}

export async function getWorkspaceActions(
  db: D1Database,
  workspaceId: string,
): Promise<ActionReceipt[]> {
  const rows = (
    await db
      .prepare(
        `SELECT id, workspace_id, action_id, payload_hash, command_name, result_status, result_json,
                actor_kind, actor_user_id, source_message_id, source_job_id, run_id, step_id,
                committed_revision, created_at
         FROM action_receipts WHERE workspace_id = ? ORDER BY committed_revision ASC, created_at ASC`
      )
      .bind(workspaceId)
      .all<Record<string, unknown>>()
  ).results || [];

  return rows.map((r: Record<string, unknown>) => ({
    id: String(r['id']),
    workspace_id: String(r['workspace_id']),
    action_id: String(r['action_id']),
    payload_hash: String(r['payload_hash']),
    command_name: String(r['command_name']),
    result_status: r['result_status'] as ActionReceipt['result_status'],
    result_json: String(r['result_json']),
    actor_kind: r['actor_kind'] as ActionReceipt['actor_kind'],
    actor_user_id: r['actor_user_id'] ? String(r['actor_user_id']) : null,
    source_message_id: r['source_message_id'] ? String(r['source_message_id']) : null,
    source_job_id: r['source_job_id'] ? String(r['source_job_id']) : null,
    run_id: r['run_id'] ? String(r['run_id']) : null,
    step_id: r['step_id'] ? String(r['step_id']) : null,
    committed_revision: Number(r['committed_revision']),
    created_at: String(r['created_at']),
  }));
}

function mapEntityRow(r: Record<string, unknown>): Entity {
  return {
    id: String(r['id']),
    workspace_id: String(r['workspace_id']),
    name: String(r['name']),
    kind: String(r['kind']),
    status: r['status'] as Entity['status'],
    assigned_user_id: r['assigned_user_id'] ? String(r['assigned_user_id']) : null,
    created_at: String(r['created_at']),
    updated_at: String(r['updated_at']),
  };
}

function mapAliasRow(r: Record<string, unknown>): EntityAlias {
  return {
    id: String(r['id']),
    workspace_id: String(r['workspace_id']),
    entity_id: String(r['entity_id']),
    alias: String(r['alias']),
    source_event_id: r['source_event_id'] ? String(r['source_event_id']) : null,
    created_at: String(r['created_at']),
  };
}

function mapInteractionRow(r: Record<string, unknown>): InteractionState {
  const raw = r['head_value_json'] ? JSON.parse(String(r['head_value_json'])) as Record<string, unknown> : null;
  const valid = raw && typeof raw['amount'] === 'number' && typeof raw['currency'] === 'string' && typeof raw['role'] === 'string';
  return {
    workspace_id: String(r['workspace_id']),
    root_event_id: String(r['root_event_id']),
    entity_id: r['entity_id'] ? String(r['entity_id']) : null,
    kind: r['kind'] as InteractionState['kind'],
    head_event_id: String(r['head_event_id']),
    revision: Number(r['revision']),
    state: r['state'] as InteractionState['state'],
    occurred_at: String(r['occurred_at']),
    sequence: Number(r['sequence']),
    updated_at: String(r['updated_at']),
    head_value_json: valid ? JSON.stringify({ amount: raw['amount'], currency: raw['currency'], role: raw['role'] }) : null,
  };
}

function mapFieldRow(r: Record<string, unknown>): EntityStateField {
  return {
    id: String(r['id']),
    workspace_id: String(r['workspace_id']),
    entity_id: String(r['entity_id']),
    field_name: String(r['field_name']),
    state: r['state'] as EntityStateField['state'],
    value_text: r['value_text'] ? String(r['value_text']) : null,
    value_json: r['value_json'] ? String(r['value_json']) : null,
    provenance: r['provenance'] as EntityStateField['provenance'],
    source_event_id: r['source_event_id'] ? String(r['source_event_id']) : null,
    candidate_event_ids: r['candidate_event_ids_json']
      ? (JSON.parse(String(r['candidate_event_ids_json'])) as string[])
      : null,
    last_confirmed_value_text: r['last_confirmed_value_text']
      ? String(r['last_confirmed_value_text'])
      : null,
    last_confirmed_value_json: r['last_confirmed_value_json']
      ? String(r['last_confirmed_value_json'])
      : null,
    revision: Number(r['revision']),
    updated_at: String(r['updated_at']),
    ...(r['field_name'] === 'quote' ? { quote_authority_json: r['quote_authority_json'] ? String(r['quote_authority_json']) : null } : {}),
  };
}

const ENTITY_COLUMNS =
  `id, workspace_id, name, kind, status, assigned_user_id, created_at, updated_at`;
const ALIAS_COLUMNS =
  `id, workspace_id, entity_id, alias, source_event_id, created_at`;
const FIELD_COLUMNS =
  `id, workspace_id, entity_id, field_name, state, value_text, value_json,
   provenance, source_event_id, candidate_event_ids_json, last_confirmed_value_text,
   last_confirmed_value_json, revision, updated_at, quote_authority_json`;

const INTERACTION_COLUMNS =
  `workspace_id, root_event_id, entity_id, kind, head_event_id, revision,
   state, occurred_at, sequence, updated_at, head_value_json`;

export async function getWorkspaceProjectionState(
  db: D1Database,
  workspaceId: string,
  options?: { includeInteractions?: boolean },
): Promise<LedgerProjectionState> {
  const state: LedgerProjectionState = {
    entities: new Map(),
    aliases: new Map(),
    fields: new Map(),
    interactions: new Map(),
    tasks: new Map(),
    drafts: new Map(),
    memoryEntries: new Map(),
    memorySuppressions: new Map(),
  };

  // The seven workspace-scoped reads are independent, so they go out as
  // two batch roundtrips (core tables, then memory tables) instead of seven
  // serial reads. Result order matches statement order; the mapping below is
  // unchanged. Memory reads stay in their own batch because harnesses that
  // apply only the core migrations have no memory tables: a missing table
  // must skip the memory maps, never fail the whole projection.
  const core = await db.batch([
    db
      .prepare(
        `SELECT ${ENTITY_COLUMNS}
         FROM entities WHERE workspace_id = ?`,
      )
      .bind(workspaceId),
    db
      .prepare(
        `SELECT ${ALIAS_COLUMNS} FROM entity_aliases WHERE workspace_id = ?`,
      )
      .bind(workspaceId),
    db
      .prepare(
        `SELECT ${FIELD_COLUMNS}
         FROM entity_state WHERE workspace_id = ?`,
      )
      .bind(workspaceId),
    db
      .prepare(
        `SELECT id, workspace_id, entity_id, title, assignee_user_id, status, due_kind,
                due_local_date, due_instant, due_timezone, snooze_until, explicit_no_deadline,
                is_promise, source_event_id, revision, created_at, updated_at
         FROM tasks WHERE workspace_id = ?`,
      )
      .bind(workspaceId),
    db
      .prepare(
        `SELECT id, workspace_id, entity_id, channel, recipient_address, content_text,
                status, source_event_id, revision, created_at, updated_at
         FROM draft_projections WHERE workspace_id = ?`,
      )
      .bind(workspaceId),
  ]);
  const rowsAt = (index: number): Record<string, unknown>[] =>
    ((core[index] as unknown as { results?: Record<string, unknown>[] }).results ?? []);

  // 1. Entities
  const entityRows = rowsAt(0);

  for (const r of entityRows) {
    const e = mapEntityRow(r);
    state.entities.set(e.id, e);
  }

  // 2. Aliases
  const aliasRows = rowsAt(1);

  for (const r of aliasRows) {
    const a = mapAliasRow(r);
    const key = `${workspaceId}:${a.alias.toLowerCase()}`;
    state.aliases.set(key, a);
  }

  // 3. Entity State Fields
  const fieldRows = rowsAt(2);

  for (const r of fieldRows) {
    const f = mapFieldRow(r);
    const key = `${f.entity_id}:${f.field_name}`;
    state.fields.set(key, f);
  }

  // 4. Tasks
  const taskRows = rowsAt(3);

  for (const r of taskRows) {
    const t: Task = {
      id: String(r['id']),
      workspace_id: String(r['workspace_id']),
      entity_id: r['entity_id'] ? String(r['entity_id']) : null,
      title: String(r['title']),
      assignee_user_id: r['assignee_user_id'] ? String(r['assignee_user_id']) : null,
      status: r['status'] as Task['status'],
      due_kind: (r['due_kind'] as Task['due_kind']) || null,
      due_local_date: r['due_local_date'] ? String(r['due_local_date']) : null,
      due_instant: r['due_instant'] ? String(r['due_instant']) : null,
      due_timezone: r['due_timezone'] ? String(r['due_timezone']) : null,
      snooze_until: r['snooze_until'] ? String(r['snooze_until']) : null,
      explicit_no_deadline: Number(r['explicit_no_deadline'] ?? 0) === 1,
      is_promise: Number(r['is_promise'] ?? 0) === 1,
      source_event_id: String(r['source_event_id']),
      revision: Number(r['revision']),
      created_at: String(r['created_at']),
      updated_at: String(r['updated_at']),
    };
    state.tasks.set(t.id, t);
  }

  // 5. Drafts
  const draftRows = rowsAt(4);

  for (const r of draftRows) {
    const d: DraftProjection = {
      id: String(r['id']),
      workspace_id: String(r['workspace_id']),
      entity_id: r['entity_id'] ? String(r['entity_id']) : null,
      channel: r['channel'] as DraftProjection['channel'],
      recipient_address: r['recipient_address'] ? String(r['recipient_address']) : null,
      content_text: String(r['content_text']),
      status: r['status'] as DraftProjection['status'],
      source_event_id: String(r['source_event_id']),
      revision: Number(r['revision']),
      created_at: String(r['created_at']),
      updated_at: String(r['updated_at']),
    };
    state.drafts.set(d.id, d);
  }

  // 6. Memory Entries
  try {
    const memoryBatch = await db.batch([
      db
        .prepare(
          `SELECT id, workspace_id, scope, subject_id, category, content, status, provenance,
                  source_event_id, source_message_id, author_user_id, observed_at, created_at,
                  superseding_event_id, business_revision
           FROM memory_entries WHERE workspace_id = ?`,
        )
        .bind(workspaceId),
      db
        .prepare(
          `SELECT id, workspace_id, target_memory_id, source_event_id, source_message_id,
                  suppression_event_id, revision, created_at
           FROM memory_suppressions WHERE workspace_id = ?`,
        )
        .bind(workspaceId),
    ]);
    const memoryRows =
      ((memoryBatch[0] as unknown as { results?: Record<string, unknown>[] }).results ?? []);

    for (const r of memoryRows) {
      const m: MemoryEntry = {
        id: String(r['id']),
        workspace_id: String(r['workspace_id']),
        scope: r['scope'] as MemoryEntry['scope'],
        subject_id: r['subject_id'] ? String(r['subject_id']) : null,
        category: r['category'] as MemoryEntry['category'],
        content: String(r['content']),
        status: r['status'] as MemoryEntry['status'],
        provenance: r['provenance'] as MemoryEntry['provenance'],
        source_event_id: r['source_event_id'] ? String(r['source_event_id']) : null,
        source_message_id: r['source_message_id'] ? String(r['source_message_id']) : null,
        author_user_id: r['author_user_id'] ? String(r['author_user_id']) : null,
        observed_at: String(r['observed_at']),
        created_at: String(r['created_at']),
        superseding_event_id: r['superseding_event_id'] ? String(r['superseding_event_id']) : null,
        business_revision: Number(r['business_revision']),
      };
      state.memoryEntries.set(m.id, m);
    }

    // 7. Memory Suppressions
    const suppressionRows =
      ((memoryBatch[1] as unknown as { results?: Record<string, unknown>[] }).results ?? []);

    for (const r of suppressionRows) {
      const s: MemorySuppression = {
        id: String(r['id']),
        workspace_id: String(r['workspace_id']),
        target_memory_id: String(r['target_memory_id']),
        source_event_id: r['source_event_id'] ? String(r['source_event_id']) : null,
        source_message_id: r['source_message_id'] ? String(r['source_message_id']) : null,
        suppression_event_id: String(r['suppression_event_id']),
        revision: Number(r['revision']),
        created_at: String(r['created_at']),
      };
      state.memorySuppressions.set(s.id, s);
    }
  } catch (err) {
    if (!String(err).includes('no such table')) throw err;
  }

  if (options?.includeInteractions === false) return state;
  // The default is complete for unknown/custom handlers, especially Undo,
  // which must see every existing row to persist replay's deletions.
  // The executor opts known unrelated writers out by handler identity.
  try {
    const interactionRows = (
      await db
        .prepare(`SELECT ${INTERACTION_COLUMNS} FROM interaction_state WHERE workspace_id = ?`)
        .bind(workspaceId)
        .all<Record<string, unknown>>()
    ).results || [];
    for (const r of interactionRows) {
      const row = mapInteractionRow(r);
      state.interactions.set(row.root_event_id, row);
    }
  } catch (err) {
    if (!String(err).includes('no such table')) throw err;
  }

  try { await hydrateBusinessDetails(db, workspaceId, state); }
  catch (error) { if (!String(error).includes('no such table')) throw error; }

  try { await hydrateRecordsDetails(db, workspaceId, state); }
  catch (error) { if (!String(error).includes('no such table')) throw error; }
  return state;
}

/**
 * Targeted field hydration for trusted set_field / set_fields /
 * resolve_conflict handlers: one entity row plus the requested field rows
 * with full dispute/source columns, in a single D1 read batch. These
 * handlers never read or write aliases, tasks, drafts or memory, so those
 * collections stay unloaded (and unbounded in the diff) rather than scaling
 * every field write with the workspace. An absent requested field is known
 * absent, an unrequested field untouched.
 */
export async function getBusinessProjectionState(db: D1Database, workspaceId: string, entityIds: string[], includeFields: boolean): Promise<{ state: LedgerProjectionState; coverage: ProjectionCoverage }> {
  const state: LedgerProjectionState = { entities: new Map(), aliases: new Map(), fields: new Map(), interactions: new Map(), tasks: new Map(), drafts: new Map(), memoryEntries: new Map(), memorySuppressions: new Map() };
  const placeholders = entityIds.map(() => '?').join(',');
  const familySql = `WITH RECURSIVE ancestors(id, depth) AS (SELECT id, 0 FROM entities WHERE workspace_id = ? AND id IN (${placeholders})
    UNION ALL SELECT r.target_entity_id, a.depth + 1 FROM ancestors a JOIN entity_redirects r ON r.source_entity_id = a.id AND r.workspace_id = ? WHERE a.depth < 32),
    family(id) AS (SELECT id FROM ancestors UNION SELECT r.source_entity_id FROM family f JOIN entity_redirects r ON r.target_entity_id = f.id AND r.workspace_id = ?) `;
  const familyArgs = [workspaceId, ...entityIds, workspaceId, workspaceId];
  const results = await db.batch([
    db.prepare(`${familySql} SELECT ${ENTITY_COLUMNS} FROM entities WHERE workspace_id = ? AND id IN (SELECT id FROM family)`).bind(...familyArgs, workspaceId),
    db.prepare(`${familySql} SELECT ${FIELD_COLUMNS} FROM entity_state WHERE workspace_id = ? AND entity_id IN (SELECT id FROM family)${includeFields ? '' : ' AND 0'}`).bind(...familyArgs, workspaceId),
    db.prepare(`${familySql} SELECT id, workspace_id, entity_id, alias, source_event_id, created_at FROM entity_aliases WHERE workspace_id = ? AND entity_id IN (SELECT id FROM family)`).bind(...familyArgs, workspaceId),
    db.prepare(`${familySql} SELECT * FROM entity_contacts WHERE workspace_id = ? AND entity_id IN (SELECT id FROM family)`).bind(...familyArgs, workspaceId),
    db.prepare(`${familySql} SELECT * FROM entity_redirects WHERE workspace_id = ? AND source_entity_id IN (SELECT id FROM family)`).bind(...familyArgs, workspaceId),
    db.prepare(`${familySql} SELECT ${INTERACTION_COLUMNS} FROM interaction_state WHERE workspace_id = ? AND entity_id IN (SELECT id FROM family) AND kind = 'quote' AND state = 'active'${includeFields ? '' : ' AND 0'}`).bind(...familyArgs, workspaceId),
    ...(includeFields ? [db.prepare(`${familySql} SELECT ent.id AS entity_id,
      (SELECT COUNT(*) FROM events r WHERE r.workspace_id = ent.workspace_id AND r.entity_id = ent.id) AS history,
      (SELECT COUNT(*) FROM interaction_state r WHERE r.workspace_id = ent.workspace_id AND r.entity_id = ent.id AND r.state = 'active') AS interactions,
      (SELECT COUNT(*) FROM tasks r WHERE r.workspace_id = ent.workspace_id AND r.entity_id = ent.id) AS tasks,
      (SELECT COUNT(*) FROM draft_projections r WHERE r.workspace_id = ent.workspace_id AND r.entity_id = ent.id) AS drafts,
      (SELECT COUNT(*) FROM attachment_links r WHERE r.workspace_id = ent.workspace_id AND r.entity_id = ent.id) AS files,
      (SELECT COUNT(*) FROM memory_entries r WHERE r.workspace_id = ent.workspace_id AND r.subject_id = ent.id AND r.scope = 'entity' AND r.status = 'active') AS context,
      (SELECT COUNT(*) FROM entity_contacts r WHERE r.workspace_id = ent.workspace_id AND r.entity_id = ent.id AND r.state != 'removed') AS contacts
      FROM entities ent WHERE ent.workspace_id = ? AND ent.id IN (SELECT id FROM family)`).bind(...familyArgs, workspaceId)] : []),
  ]);
  for (const row of (results[0]!.results ?? []) as Record<string, unknown>[]) { const e = mapEntityRow(row); state.entities.set(e.id, e); }
  for (const row of (results[1]!.results ?? []) as Record<string, unknown>[]) { const f = mapFieldRow(row); state.fields.set(`${f.entity_id}:${f.field_name}`, f); }
  for (const row of (results[2]!.results ?? []) as Record<string, unknown>[]) { const a = row as unknown as EntityAlias; state.aliases.set(`${workspaceId}:${a.alias.toLowerCase()}`, a); }
  state.contacts = new Map(((results[3]!.results ?? []) as Record<string, unknown>[]).map(r => [String(r.id), { ...r, is_primary: Boolean(r.is_primary) } as unknown as import('@otis/contracts').EntityContact]));
  state.redirects = new Map(((results[4]!.results ?? []) as Record<string, unknown>[]).map(r => { const { decisions_json, ...rest } = r; return [String(r.source_entity_id), { ...rest, decisions: JSON.parse(String(decisions_json)) } as unknown as import('@otis/contracts').EntityRedirect]; }));
  for (const row of (results[5]!.results ?? []) as Record<string, unknown>[]) { const i = mapInteractionRow(row); state.interactions.set(i.root_event_id, i); }
  state.mergeCounts = new Map();
  for (const r of (results[6]?.results ?? []) as Record<string, unknown>[]) { const { entity_id, ...counts } = r; state.mergeCounts.set(String(entity_id), Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value)]))); }
  const fieldKeys = new Set(state.fields.keys());
  if (includeFields) for (const id of state.entities.keys()) for (const name of ['status', 'assigned_user_id', ...[...state.fields.values()].map(f => f.field_name)]) fieldKeys.add(`${id}:${name}`);
  return { state, coverage: { entities: new Set(state.entities.keys()), aliases: new Set(state.aliases.keys()), fields: fieldKeys, interactions: new Set(state.interactions.keys()), tasks: new Set(), drafts: new Set(), memoryEntries: new Set(), memorySuppressions: new Set() } };
}

export async function expandCanonicalProjectionState(db: D1Database, workspaceId: string, state: LedgerProjectionState, coverage: ProjectionCoverage, entityId: string, fieldNames: string[]): Promise<void> {
  if (state.redirects?.size === 0) return;
  try { if (!(fieldNames.includes('phone') && state.contacts)) await hydrateBusinessDetails(db, workspaceId, state, [entityId], ['entity_redirects']); }
  catch (error) { if (String(error).includes('no such table')) return; throw error; }
  const parents: string[] = []; let id = entityId;
  while (state.redirects?.has(id)) {
    id = state.redirects.get(id)!.target_entity_id;
    if (parents.includes(id) || parents.length >= 32) throw new Error('Invalid client redirect chain.');
    parents.push(id);
  }
  if (!parents.length && !(fieldNames.includes('quote') && state.redirects?.size)) return;
  const marks = parents.length ? parents.map(() => '?').join(',') : "'__none__'";
  const names = fieldNames.length ? fieldNames : ['__no_fields__'];
  const queries = [
    db.prepare(`SELECT ${ENTITY_COLUMNS} FROM entities WHERE workspace_id = ? AND id IN (${marks})`).bind(workspaceId, ...parents),
    db.prepare(`SELECT ${FIELD_COLUMNS} FROM entity_state WHERE workspace_id = ? AND entity_id IN (${marks}) AND field_name IN (${names.map(() => '?').join(',')})`).bind(workspaceId, ...parents, ...names),
  ];
  if (names.includes('quote')) {
    queries.push(db.prepare(`${ENTITY_FAMILY_SQL} SELECT ${INTERACTION_COLUMNS} FROM interaction_state WHERE workspace_id = ? AND entity_id IN (SELECT id FROM family) AND kind = 'quote' AND state = 'active'`).bind(...familyBinds(workspaceId, entityId), workspaceId));
    queries.push(db.prepare(`${ENTITY_FAMILY_SQL} SELECT * FROM entity_redirects WHERE workspace_id = ? AND source_entity_id IN (SELECT id FROM family)`).bind(...familyBinds(workspaceId, entityId), workspaceId));
  }
  const rows = await db.batch(queries);
  for (const row of (rows[0]!.results ?? []) as Record<string, unknown>[]) { const e = mapEntityRow(row); state.entities.set(e.id, e); }
  for (const row of (rows[1]!.results ?? []) as Record<string, unknown>[]) { const f = mapFieldRow(row); state.fields.set(`${f.entity_id}:${f.field_name}`, f); }
  for (const row of (rows[2]?.results ?? []) as Record<string, unknown>[]) { const i = mapInteractionRow(row); state.interactions.set(i.root_event_id, i); }
  for (const row of (rows[3]?.results ?? []) as Record<string, unknown>[]) { const { decisions_json, ...rest } = row; state.redirects!.set(String(row.source_entity_id), { ...rest, decisions: JSON.parse(String(decisions_json)) } as unknown as import('@otis/contracts').EntityRedirect); }
  if (coverage.entities !== 'all') for (const parent of parents) coverage.entities.add(parent);
  if (coverage.fields !== 'all') for (const parent of parents) for (const name of fieldNames) coverage.fields.add(`${parent}:${name}`);
  if (coverage.interactions !== 'all') for (const key of state.interactions.keys()) coverage.interactions.add(key);
}

export async function getFieldProjectionState(
  db: D1Database,
  workspaceId: string,
  entityId: string,
  fieldNames: string[],
): Promise<{ state: LedgerProjectionState; coverage: ProjectionCoverage }> {
  const state: LedgerProjectionState = {
    entities: new Map(),
    aliases: new Map(),
    fields: new Map(),
    interactions: new Map(),
    tasks: new Map(),
    drafts: new Map(),
    memoryEntries: new Map(),
    memorySuppressions: new Map(),
  };
  const distinctFields = [...new Set(fieldNames.filter((n) => typeof n === 'string' && n !== ''))];
  const fieldPlaceholders = distinctFields.map(() => '?').join(',');
  const loaded = await db.batch([
    db
      .prepare(`SELECT ${ENTITY_COLUMNS} FROM entities WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, entityId),
    distinctFields.length > 0
      ? db
          .prepare(
            `SELECT ${FIELD_COLUMNS} FROM entity_state
             WHERE workspace_id = ? AND entity_id = ? AND field_name IN (${fieldPlaceholders})`,
          )
          .bind(workspaceId, entityId, ...distinctFields)
      : db.prepare(`SELECT ${FIELD_COLUMNS} FROM entity_state WHERE 1 = 0`),
    ...(distinctFields.includes('quote') ? [db.prepare(
      `SELECT ${INTERACTION_COLUMNS} FROM interaction_state
       WHERE workspace_id = ? AND entity_id = ? AND kind = 'quote' AND state = 'active'`,
    ).bind(workspaceId, entityId)] : []),
    ...(distinctFields.includes('phone') ? [db.prepare(`${ENTITY_FAMILY_SQL} SELECT * FROM entity_contacts WHERE workspace_id = ? AND entity_id IN (SELECT id FROM family)`).bind(...familyBinds(workspaceId, entityId), workspaceId)] : []),
    distinctFields.includes('phone') ? db.prepare(`${ENTITY_FAMILY_SQL} SELECT * FROM entity_redirects WHERE workspace_id = ? AND source_entity_id IN (SELECT id FROM family)`).bind(...familyBinds(workspaceId, entityId), workspaceId) : db.prepare('SELECT * FROM entity_redirects WHERE workspace_id = ? AND (source_entity_id = ? OR target_entity_id = ?)').bind(workspaceId, entityId, entityId),
  ]);
  const rowsAt = (index: number): Record<string, unknown>[] =>
    ((loaded[index] as unknown as { results?: Record<string, unknown>[] }).results ?? []);

  state.redirects = new Map(rowsAt(loaded.length - 1).map(r => { const { decisions_json, ...rest } = r; return [String(r.source_entity_id), { ...rest, decisions: JSON.parse(String(decisions_json)) } as unknown as import('@otis/contracts').EntityRedirect]; }));
  for (const r of rowsAt(0)) {
    const e = mapEntityRow(r);
    state.entities.set(e.id, e);
  }
  if (distinctFields.includes('phone')) state.contacts = new Map(rowsAt(loaded.length - 2).map(r => [String(r.id), { ...r, is_primary: Boolean(r.is_primary) } as unknown as import('@otis/contracts').EntityContact]));
  const fieldKeys = new Set<string>();
  for (const r of rowsAt(1)) {
    const f = mapFieldRow(r);
    const key = `${f.entity_id}:${f.field_name}`;
    state.fields.set(key, f);
  }
  // Requested fields are covered whether present or known absent: creating
  // a requested field is inside the footprint, touching any other field is
  // not.
  for (const name of distinctFields) fieldKeys.add(`${entityId}:${name}`);
  if (distinctFields.includes('quote')) {
    for (const r of rowsAt(2)) {
      const row = mapInteractionRow(r);
      state.interactions.set(row.root_event_id, row);
    }
  }

  return {
    state,
    coverage: {
      entities: new Set([entityId]),
      aliases: new Set(),
      fields: fieldKeys,
      interactions: new Set(state.interactions.keys()),
      tasks: new Set(),
      drafts: new Set(),
      memoryEntries: new Set(),
      memorySuppressions: new Set(),
    },
  };
}

/** Entity deletion needs only its own lifecycle rows to persist removals. */
export async function getEntityInteractions(
  db: D1Database, workspaceId: string, entityId: string,
): Promise<Map<string, InteractionState>> {
  const result = await db.prepare(`SELECT ${INTERACTION_COLUMNS} FROM interaction_state
    WHERE workspace_id = ? AND entity_id = ?`).bind(workspaceId, entityId).all<Record<string, unknown>>();
  return new Map((result.results ?? []).map(value => {
    const row = mapInteractionRow(value);
    return [row.root_event_id, row];
  }));
}

/** Target plus content, scoped entity, and active quote dependencies only. */
export async function getInteractionProjectionState(
  db: D1Database,
  workspaceId: string,
  rootEventId: string,
): Promise<{ state: LedgerProjectionState; coverage: ProjectionCoverage }> {
  const state: LedgerProjectionState = {
    entities: new Map(),
    aliases: new Map(),
    fields: new Map(),
    interactions: new Map(),
    tasks: new Map(),
    drafts: new Map(),
    memoryEntries: new Map(),
    memorySuppressions: new Map(),
  };
  const coverage: ProjectionCoverage = {
    entities: new Set(),
    aliases: new Set(),
    fields: new Set(),
    interactions: new Set(),
    tasks: new Set(),
    drafts: new Set(),
    memoryEntries: new Set(),
    memorySuppressions: new Set(),
  };
  let row: InteractionState | null = null;
  try {
    const found = await db
      .prepare(`SELECT ${CURRENT_INTERACTION_COLUMNS}, i.workspace_id, i.state, i.updated_at, i.head_value_json
        ${CURRENT_INTERACTION_JOINS} WHERE i.workspace_id = ? AND i.root_event_id = ?`)
      .bind(workspaceId, rootEventId)
      .first<Record<string, unknown>>();
    if (found) {
      row = mapInteractionRow(found);
      state.interactionHeads = new Map([[row.root_event_id, mapCurrentInteraction(found)]]);
    }
  } catch (err) {
    if (!String(err).includes('no such table')) throw err;
    return { state, coverage };
  }
  if (!row) return { state, coverage };
  state.interactions.set(row.root_event_id, row);
  (coverage.interactions as Set<string>).add(row.root_event_id);
  if (!row.entity_id) return { state, coverage };

  // Sibling roots feed head-aware quote recompute only: revising one
  // disputant must see the other active heads to preserve the dispute
  // instead of overwriting it. Non-quote edits need just their target, and
  // removed roots contribute nothing, so both stay unloaded.
  const statements: D1PreparedStatement[] = [
    db
      .prepare(`SELECT ${ENTITY_COLUMNS} FROM entities WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, row.entity_id),
    row.kind === 'quote'
      ? db
          .prepare(
            `SELECT ${FIELD_COLUMNS} FROM entity_state
             WHERE workspace_id = ? AND entity_id = ? AND field_name = 'quote'`,
          )
          .bind(workspaceId, row.entity_id)
      : db.prepare(`SELECT ${FIELD_COLUMNS} FROM entity_state WHERE 1 = 0`),
  ];
  if (row.kind === 'quote') {
    statements.push(
      db
        .prepare(
          `SELECT ${INTERACTION_COLUMNS} FROM interaction_state
           WHERE workspace_id = ? AND entity_id = ? AND kind = ?
             AND state = 'active' AND root_event_id != ?`,
        )
        .bind(workspaceId, row.entity_id, row.kind, row.root_event_id),
    );
  }
  statements.push(db.prepare('SELECT * FROM entity_redirects WHERE workspace_id = ? AND (source_entity_id = ? OR target_entity_id = ?)').bind(workspaceId, row.entity_id, row.entity_id));
    const loaded = await db.batch(statements);
  const rowsAt = (index: number): Record<string, unknown>[] =>
    ((loaded[index] as unknown as { results?: Record<string, unknown>[] }).results ?? []);
  state.redirects = new Map(rowsAt(loaded.length - 1).map(r => { const { decisions_json, ...rest } = r; return [String(r.source_entity_id), { ...rest, decisions: JSON.parse(String(decisions_json)) } as unknown as import('@otis/contracts').EntityRedirect]; }));
  for (const r of rowsAt(0)) {
    const e = mapEntityRow(r);
    state.entities.set(e.id, e);
    (coverage.entities as Set<string>).add(e.id);
  }
  for (const r of rowsAt(1)) {
    const f = mapFieldRow(r);
    const key = `${f.entity_id}:${f.field_name}`;
    state.fields.set(key, f);
  }
  if (row.kind === 'quote') {
    (coverage.fields as Set<string>).add(`${row.entity_id}:quote`);
  }
  if (row.kind === 'quote' && loaded.length > 2) {
    for (const r of rowsAt(2)) {
      const sibling = mapInteractionRow(r);
      state.interactions.set(sibling.root_event_id, sibling);
      (coverage.interactions as Set<string>).add(sibling.root_event_id);
    }
  }
  return { state, coverage };
}

/**
 * Targeted hydration for new log_event writes: the scoped entity row for
 * the existence check, plus active quote siblings when the new entry is a
 * quote (head-aware recompute must see competing heads). Nothing else is
 * loaded: a new log creates at most one root and never reads aliases,
 * tasks, drafts or memory. Coverage carries the entity plus an explicit
 * create-allowance: the bounds check permits created interaction rows only
 * for the loaded entity (or entity-less roots when the log has no entity).
 */
export async function getLogEventProjectionState(
  db: D1Database,
  workspaceId: string,
  entityId: string | null,
  kind: string,
): Promise<{ state: LedgerProjectionState; coverage: ProjectionCoverage }> {
  const state: LedgerProjectionState = {
    entities: new Map(),
    aliases: new Map(),
    fields: new Map(),
    interactions: new Map(),
    tasks: new Map(),
    drafts: new Map(),
    memoryEntries: new Map(),
    memorySuppressions: new Map(),
  };
  const coverage: ProjectionCoverage = {
    entities: new Set(),
    aliases: new Set(),
    fields: new Set(),
    interactions: new Set(),
    tasks: new Set(),
    drafts: new Set(),
    memoryEntries: new Set(),
    memorySuppressions: new Set(),
  };
  coverage.interactionCreate = { entity_id: entityId, kind };
  if (!entityId) return { state, coverage };
  try {
    const statements: D1PreparedStatement[] = [
      db
        .prepare(`SELECT ${ENTITY_COLUMNS} FROM entities WHERE workspace_id = ? AND id = ?`)
        .bind(workspaceId, entityId),
    ];
    if (kind === 'quote') {
      statements.push(
        db
          .prepare(
            `SELECT ${FIELD_COLUMNS} FROM entity_state
             WHERE workspace_id = ? AND entity_id = ? AND field_name = 'quote'`,
          )
          .bind(workspaceId, entityId),
        db
          .prepare(
            `SELECT ${INTERACTION_COLUMNS} FROM interaction_state
             WHERE workspace_id = ? AND entity_id = ? AND kind = 'quote' AND state = 'active'`,
          )
          .bind(workspaceId, entityId),
      );
    } else {
      statements.push(db.prepare(`SELECT ${FIELD_COLUMNS} FROM entity_state WHERE 1 = 0`));
    }
    statements.push(db.prepare('SELECT * FROM entity_redirects WHERE workspace_id = ? AND (source_entity_id = ? OR target_entity_id = ?)').bind(workspaceId, entityId, entityId));
    const loaded = await db.batch(statements);
    const rowsAt = (index: number): Record<string, unknown>[] =>
      ((loaded[index] as unknown as { results?: Record<string, unknown>[] }).results ?? []);
    state.redirects = new Map(rowsAt(loaded.length - 1).map(r => { const { decisions_json, ...rest } = r; return [String(r.source_entity_id), { ...rest, decisions: JSON.parse(String(decisions_json)) } as unknown as import('@otis/contracts').EntityRedirect]; }));
  for (const r of rowsAt(0)) {
      const e = mapEntityRow(r);
      state.entities.set(e.id, e);
      (coverage.entities as Set<string>).add(e.id);
    }
    for (const r of rowsAt(1)) {
      const f = mapFieldRow(r);
      state.fields.set(`${f.entity_id}:${f.field_name}`, f);
    }
    if (kind === 'quote') {
      (coverage.fields as Set<string>).add(`${entityId}:quote`);
      for (const r of rowsAt(2)) {
        const sibling = mapInteractionRow(r);
        state.interactions.set(sibling.root_event_id, sibling);
        (coverage.interactions as Set<string>).add(sibling.root_event_id);
      }
    }
  } catch (err) {
    if (!String(err).includes('no such table')) throw err;
  }
  return { state, coverage };
}

/**
 * Finds the latest question (any status) for a ledger action, by the stored
 * operation's action id. Recovery adapts clarification-bearing receipts
 * against this row: an open question re-parks, a closed one never asks
 * again, and a sourceless fresh park (no run context, no row) passes
 * through untouched.
 */
export async function getQuestionByAction(
  db: D1Database,
  workspaceId: string,
  actionId: string,
): Promise<{
  id: string;
  status: string;
  question: string;
  missing_fields: string[];
  candidates: string[] | null;
  operation_payload_json: string;
  source_revision: number;
} | null> {
  const row = await db
    .prepare(
      `SELECT id, status, question, missing_fields, candidates_json, operation_payload_json, source_revision
       FROM pending_clarifications
       WHERE workspace_id = ?
         AND json_extract(operation_payload_json, '$.action_id') = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(workspaceId, actionId)
    .first<Record<string, unknown>>();
  if (!row) return null;
  let missing: string[] = [];
  try {
    const parsed = JSON.parse(String(row['missing_fields'] ?? '[]'));
    if (Array.isArray(parsed)) missing = parsed.map(String);
  } catch {
    missing = [];
  }
  let candidates: string[] | null = null;
  if (row['candidates_json']) {
    try {
      const parsed = JSON.parse(String(row['candidates_json']));
      if (Array.isArray(parsed)) candidates = parsed.map(String);
    } catch {
      candidates = null;
    }
  }
  return {
    id: String(row['id']),
    status: String(row['status'] ?? ''),
    question: String(row['question'] ?? ''),
    missing_fields: missing,
    candidates,
    operation_payload_json: String(row['operation_payload_json'] ?? ''),
    source_revision: Number(row['source_revision'] ?? 0),
  };
}
/**
 * Bounded lookup of action receipts by explicit action IDs, for the legacy
 * per-field (`<parent>_f<N>`) compatibility path. One roundtrip; the caller
 * matches command name and exact payload hash, never a suffix alone.
 */
export async function getActionReceiptsByIds(
  db: D1Database,
  workspaceId: string,
  actionIds: string[],
): Promise<ActionReceipt[]> {
  const ids = [...new Set(actionIds.filter((id) => typeof id === 'string' && id !== ''))].slice(0, 25);
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = (
    await db
      .prepare(
        `SELECT id, workspace_id, action_id, payload_hash, command_name, result_status, result_json,
                actor_kind, actor_user_id, source_message_id, source_job_id, run_id, step_id,
                committed_revision, created_at
         FROM action_receipts WHERE workspace_id = ? AND action_id IN (${placeholders})`,
      )
      .bind(workspaceId, ...ids)
      .all<Record<string, unknown>>()
  ).results || [];
  return rows.map((r) => ({
    id: String(r['id']),
    workspace_id: String(r['workspace_id']),
    action_id: String(r['action_id']),
    payload_hash: String(r['payload_hash']),
    command_name: String(r['command_name']),
    result_status: r['result_status'] as ActionReceipt['result_status'],
    result_json: String(r['result_json']),
    actor_kind: r['actor_kind'] as ActionReceipt['actor_kind'],
    actor_user_id: r['actor_user_id'] ? String(r['actor_user_id']) : null,
    source_message_id: r['source_message_id'] ? String(r['source_message_id']) : null,
    source_job_id: r['source_job_id'] ? String(r['source_job_id']) : null,
    run_id: r['run_id'] ? String(r['run_id']) : null,
    step_id: r['step_id'] ? String(r['step_id']) : null,
    committed_revision: Number(r['committed_revision']),
    created_at: String(r['created_at']),
  }));
}

export interface RecordsOperationScope {
  entityIds: string[];
  taskIds: string[];
  draftIds: string[];
  rootIds: string[];
  listIds: string[];
  rowIds: string[];
  fieldIds: string[];
  columnIds: string[];
}

function scopeId(value: unknown): string | null {
  return typeof value === 'string' && value && value.length <= 256 ? value : null;
}

/**
 * Trusted scope selection for the records_batch footprint: collect every
 * touched id straight from the operations. Anything structurally
 * unexpected returns null so hydration stays fail-open to full state; the
 * handler itself rejects malformed batches before any effect.
 */
export function recordsScopeFor(handler: unknown, args: unknown): RecordsOperationScope | null {
  // Identity is checked by the caller against the registered handler; this
  // guard keeps direct calls honest too.
  if (!handler || !args || typeof args !== 'object') return null;
  const record = args as Record<string, unknown>;
  if (!Array.isArray(record['operations']) || record['operations'].length > 100) return null;
  const scope: RecordsOperationScope = {
    entityIds: [], taskIds: [], draftIds: [], rootIds: [],
    listIds: [], rowIds: [], fieldIds: [], columnIds: [],
  };
  const pushRef = (kind: unknown, id: unknown): boolean => {
    const clean = scopeId(id);
    if (typeof kind !== 'string' || !clean) return false;
    if (kind === 'entity') scope.entityIds.push(clean);
    else if (kind === 'task') scope.taskIds.push(clean);
    else if (kind === 'draft') scope.draftIds.push(clean);
    else if (kind === 'interaction') scope.rootIds.push(clean);
    else if (kind === 'custom') scope.rowIds.push(clean);
    else if (kind === 'memory') return true;
    else return false;
    return true;
  };
  const listId = scopeId(record['list_id']);
  if (!listId) return null;
  scope.listIds.push(listId);
  for (const op of record['operations']) {
    if (!op || typeof op !== 'object' || Array.isArray(op)) return null;
    const edit = op as Record<string, unknown>;
    if (typeof edit['op'] !== 'string' || typeof edit['op_id'] !== 'string') return null;
    switch (edit['op']) {
      case 'cell.set':
      case 'cell.clear': {
        const ref = edit['row_ref'] as Record<string, unknown> | undefined;
        if (!ref || !pushRef(ref['kind'], ref['id'])) return null;
        const columnId = scopeId(edit['column_id']);
        if (!columnId) return null;
        scope.columnIds.push(columnId);
        break;
      }
      case 'item.edit':
      case 'item.remove': {
        const ref = edit['source_ref'] as Record<string, unknown> | undefined;
        if (!ref || !pushRef(ref['kind'], ref['id'])) return null;
        const origin = edit['origin'] as Record<string, unknown> | undefined;
        if (origin !== undefined) {
          const originRef = origin['row_ref'] as Record<string, unknown> | undefined;
          if (!originRef || !pushRef(originRef['kind'], originRef['id'])) return null;
        }
        break;
      }
      case 'row.create': {
        const ref = edit['row_ref'] as Record<string, unknown> | undefined;
        if (!ref || !pushRef(ref['kind'], ref['id'])) return null;
        const opList = scopeId(edit['list_id']);
        if (!opList) return null;
        scope.listIds.push(opList);
        break;
      }
      case 'row.remove':
      case 'row.restore': {
        const ref = edit['row_ref'] as Record<string, unknown> | undefined;
        if (!ref || !pushRef(ref['kind'], ref['id'])) return null;
        break;
      }
      case 'field.create':
      case 'field.update':
      case 'field.archive':
      case 'field.restore': {
        const fieldId = scopeId(edit['field_id']);
        if (!fieldId) return null;
        scope.fieldIds.push(fieldId);
        scope.columnIds.push(fieldId);
        const opList = edit['list_id'];
        if (opList !== undefined) {
          const clean = scopeId(opList);
          if (!clean) return null;
          scope.listIds.push(clean);
        }
        break;
      }
      case 'list.create':
      case 'list.update':
      case 'list.archive':
      case 'list.restore': {
        const opList = scopeId(edit['list_id']);
        if (!opList) return null;
        scope.listIds.push(opList);
        break;
      }
      case 'calculation.define': {
        const fieldId = scopeId(edit['field_id']);
        if (!fieldId) return null;
        scope.fieldIds.push(fieldId);
        break;
      }
      default:
        return null;
    }
  }
  return scope;
}

function chunkIn(ids: string[], size = 80): string[][] {
  const unique = [...new Set(ids)];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += size) chunks.push(unique.slice(i, i + size));
  return chunks;
}

/**
 * Targeted hydration for records_batch: the touched entity families with
 * fields, contacts, aliases, and quote siblings; touched tasks, drafts, and
 * interaction roots plus the touched entities' full lifecycle rows (so
 * deletion cascades see exactly what the full loader would); entity-scoped
 * memories; and the touched records lists, columns, rows, values, and
 * field definitions. Cost follows touched state, never workspace size.
 * Creations stay provable through coverage createScope; changed and deleted
 * keys must sit inside the loaded sets.
 */
export async function getRecordsProjectionState(
  db: D1Database,
  workspaceId: string,
  scope: RecordsOperationScope,
): Promise<{ state: LedgerProjectionState; coverage: ProjectionCoverage }> {
  const business = await getBusinessProjectionState(db, workspaceId, [...new Set(scope.entityIds)], true);
  const state = business.state;
  if (!state.tasks) state.tasks = new Map();
  if (!state.drafts) state.drafts = new Map();
  if (!state.memoryEntries) state.memoryEntries = new Map();
  if (!state.memorySuppressions) state.memorySuppressions = new Map();

  const entityKeys = [...state.entities.keys()];
  const statements: D1PreparedStatement[] = [];
  const readers: Array<(rows: Record<string, unknown>[]) => void> = [];

  const taskIdChunks = chunkIn(scope.taskIds);
  const entityChunks = chunkIn(entityKeys);
  for (const idChunk of taskIdChunks.length ? taskIdChunks : [[]]) {
    for (const entChunk of entityChunks.length ? entityChunks : [[]]) {
      if (!idChunk.length && !entChunk.length) continue;
      const conditions: string[] = [];
      const binds: unknown[] = [workspaceId];
      if (idChunk.length) {
        conditions.push(`id IN (${idChunk.map(() => '?').join(',')})`);
        binds.push(...idChunk);
      }
      if (entChunk.length) {
        conditions.push(`entity_id IN (${entChunk.map(() => '?').join(',')})`);
        binds.push(...entChunk);
      }
      statements.push(
        db.prepare(`SELECT * FROM tasks WHERE workspace_id = ? AND (${conditions.join(' OR ')})`).bind(...binds),
      );
      readers.push((rows) => {
        for (const r of rows) {
          const t: Task = {
            id: String(r['id']),
            workspace_id: String(r['workspace_id']),
            entity_id: r['entity_id'] ? String(r['entity_id']) : null,
            title: String(r['title']),
            assignee_user_id: r['assignee_user_id'] ? String(r['assignee_user_id']) : null,
            status: r['status'] as Task['status'],
            due_kind: (r['due_kind'] as Task['due_kind']) || null,
            due_local_date: r['due_local_date'] ? String(r['due_local_date']) : null,
            due_instant: r['due_instant'] ? String(r['due_instant']) : null,
            due_timezone: r['due_timezone'] ? String(r['due_timezone']) : null,
            snooze_until: r['snooze_until'] ? String(r['snooze_until']) : null,
            explicit_no_deadline: Number(r['explicit_no_deadline'] ?? 0) === 1,
            is_promise: Number(r['is_promise'] ?? 0) === 1,
            source_event_id: String(r['source_event_id']),
            revision: Number(r['revision']),
            created_at: String(r['created_at']),
            updated_at: String(r['updated_at']),
          };
          state.tasks.set(t.id, t);
        }
      });
    }
  }

  for (const idChunk of chunkIn(scope.draftIds).length ? chunkIn(scope.draftIds) : [[]]) {
    for (const entChunk of entityChunks.length ? entityChunks : [[]]) {
      if (!idChunk.length && !entChunk.length) continue;
      const conditions: string[] = [];
      const binds: unknown[] = [workspaceId];
      if (idChunk.length) {
        conditions.push(`id IN (${idChunk.map(() => '?').join(',')})`);
        binds.push(...idChunk);
      }
      if (entChunk.length) {
        conditions.push(`entity_id IN (${entChunk.map(() => '?').join(',')})`);
        binds.push(...entChunk);
      }
      statements.push(
        db.prepare(`SELECT * FROM draft_projections WHERE workspace_id = ? AND (${conditions.join(' OR ')})`).bind(...binds),
      );
      readers.push((rows) => {
        for (const r of rows) {
          const d: DraftProjection = {
            id: String(r['id']),
            workspace_id: String(r['workspace_id']),
            entity_id: r['entity_id'] ? String(r['entity_id']) : null,
            channel: r['channel'] as DraftProjection['channel'],
            recipient_address: r['recipient_address'] ? String(r['recipient_address']) : null,
            content_text: String(r['content_text']),
            status: r['status'] as DraftProjection['status'],
            source_event_id: String(r['source_event_id']),
            revision: Number(r['revision']),
            created_at: String(r['created_at']),
            updated_at: String(r['updated_at']),
          };
          state.drafts.set(d.id, d);
        }
      });
    }
  }

  for (const rootChunk of chunkIn(scope.rootIds).length ? chunkIn(scope.rootIds) : [[]]) {
    for (const entChunk of entityChunks.length ? entityChunks : [[]]) {
      if (!rootChunk.length && !entChunk.length) continue;
      const conditions: string[] = [];
      const binds: unknown[] = [workspaceId];
      if (rootChunk.length) {
        conditions.push(`root_event_id IN (${rootChunk.map(() => '?').join(',')})`);
        binds.push(...rootChunk);
      }
      if (entChunk.length) {
        conditions.push(`entity_id IN (${entChunk.map(() => '?').join(',')})`);
        binds.push(...entChunk);
      }
      statements.push(
        db.prepare(`SELECT ${INTERACTION_COLUMNS} FROM interaction_state WHERE workspace_id = ? AND (${conditions.join(' OR ')})`).bind(...binds),
      );
      readers.push((rows) => {
        for (const r of rows) {
          const row = mapInteractionRow(r);
          state.interactions.set(row.root_event_id, row);
        }
      });
    }
  }

  for (const entChunk of entityChunks) {
    statements.push(
      db.prepare(
        `SELECT id, workspace_id, scope, subject_id, category, content, status, provenance,
                source_event_id, source_message_id, author_user_id, observed_at, created_at,
                superseding_event_id, business_revision
         FROM memory_entries WHERE workspace_id = ? AND scope = 'entity' AND subject_id IN (${entChunk.map(() => '?').join(',')})`,
      ).bind(workspaceId, ...entChunk),
    );
    readers.push((rows) => {
      for (const r of rows) {
        const m: MemoryEntry = {
          id: String(r['id']),
          workspace_id: String(r['workspace_id']),
          scope: r['scope'] as MemoryEntry['scope'],
          subject_id: r['subject_id'] ? String(r['subject_id']) : null,
          category: r['category'] as MemoryEntry['category'],
          content: String(r['content']),
          status: r['status'] as MemoryEntry['status'],
          provenance: r['provenance'] as MemoryEntry['provenance'],
          source_event_id: r['source_event_id'] ? String(r['source_event_id']) : null,
          source_message_id: r['source_message_id'] ? String(r['source_message_id']) : null,
          author_user_id: r['author_user_id'] ? String(r['author_user_id']) : null,
          observed_at: String(r['observed_at']),
          created_at: String(r['created_at']),
          superseding_event_id: r['superseding_event_id'] ? String(r['superseding_event_id']) : null,
          business_revision: Number(r['business_revision']),
        };
        state.memoryEntries.set(m.id, m);
      }
    });
  }

  if (statements.length) {
    try {
      const loaded = await db.batch(statements);
      loaded.forEach((result, index) => {
        readers[index]?.(((result as unknown as { results?: Record<string, unknown>[] }).results ?? []));
      });
    } catch (err) {
      if (!String(err).includes('no such table')) throw err;
    }
  }

  try {
    await hydrateRecordsScope(db, workspaceId, state, {
      listIds: scope.listIds,
      rowIds: scope.rowIds,
      // Targeted columns ride along so guards see their definitions
      // (calculated columns reject direct writes).
      fieldIds: [...scope.fieldIds, ...scope.columnIds],
      columnIds: scope.columnIds,
    });
  } catch (err) {
    if (!String(err).includes('no such table')) throw err;
  }

  const coverage: ProjectionCoverage = {
    ...business.coverage,
    createScope: 'all',
    tasks: new Set(state.tasks.keys()),
    drafts: new Set(state.drafts.keys()),
    interactions: new Set(state.interactions.keys()),
    memoryEntries: new Set(state.memoryEntries.keys()),
    memorySuppressions: new Set(),
    recordsLists: new Set((state.recordsLists ?? new Map()).keys()),
    recordsListColumns: new Set((state.recordsListColumns ?? new Map()).keys()),
    recordsRows: new Set((state.recordsRows ?? new Map()).keys()),
    recordsValues: new Set((state.recordsValues ?? new Map()).keys()),
    fieldDefinitions: new Set((state.fieldDefinitions ?? new Map()).keys()),
  };
  return { state, coverage };
}
