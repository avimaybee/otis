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
    head_value_json: r['head_value_json'] ? String(r['head_value_json']) : null,
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
  };
}

const ENTITY_COLUMNS =
  `id, workspace_id, name, kind, status, assigned_user_id, created_at, updated_at`;
const ALIAS_COLUMNS =
  `id, workspace_id, entity_id, alias, source_event_id, created_at`;
const FIELD_COLUMNS =
  `id, workspace_id, entity_id, field_name, state, value_text, value_json,
   provenance, source_event_id, candidate_event_ids_json, last_confirmed_value_text,
   last_confirmed_value_json, revision, updated_at`;

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

  // Interaction lifecycle rows are opt-in on the full loader: ordinary
  // writes hydrate them scoped (or not at all) through the executor, so a
  // full-workspace interaction scan plus fingerprinting never rides along
  // on every command. Direct readers keep the complete view by default.
  if (options?.includeInteractions === false) return state;
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
  ]);
  const rowsAt = (index: number): Record<string, unknown>[] =>
    ((loaded[index] as unknown as { results?: Record<string, unknown>[] }).results ?? []);

  for (const r of rowsAt(0)) {
    const e = mapEntityRow(r);
    state.entities.set(e.id, e);
  }
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

  return {
    state,
    coverage: {
      entities: new Set([entityId]),
      aliases: new Set(),
      fields: fieldKeys,
      interactions: new Set(),
      tasks: new Set(),
      drafts: new Set(),
      memoryEntries: new Set(),
      memorySuppressions: new Set(),
    },
  };
}

/**
 * Entity-scoped interaction rows for the delete_entity commit path: only
 * the doomed entity's lifecycle is loaded, never the workspace history.
 * Tolerant of pre-C1 databases, where there is simply nothing to drop.
 */
export async function getEntityInteractions(
  db: D1Database,
  workspaceId: string,
  entityId: string,
): Promise<Map<string, InteractionState>> {
  const rows = new Map<string, InteractionState>();
  try {
    const found = (
      await db
        .prepare(`SELECT ${INTERACTION_COLUMNS} FROM interaction_state WHERE workspace_id = ? AND entity_id = ?`)
        .bind(workspaceId, entityId)
        .all<Record<string, unknown>>()
    ).results || [];
    for (const r of found) {
      const row = mapInteractionRow(r);
      rows.set(row.root_event_id, row);
    }
  } catch (err) {
    if (!String(err).includes('no such table')) throw err;
  }
  return rows;
}

/**
 * Targeted hydration for the C1 revise/remove interaction handlers: the
 * single interaction row, its scoped entity, and — for quote kinds — the
 * shared quote field row the revision reduces into. One D1 batch; the
 * caller never scans workspace history to resolve a root. A requested
 * quote field is covered whether present or known absent. Databases
 * predating the C1 migration resolve unknown roots, never fake rows.
 */
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
      .prepare(`SELECT ${INTERACTION_COLUMNS} FROM interaction_state WHERE workspace_id = ? AND root_event_id = ?`)
      .bind(workspaceId, rootEventId)
      .first<Record<string, unknown>>();
    if (found) row = mapInteractionRow(found);
  } catch (err) {
    if (!String(err).includes('no such table')) throw err;
    return { state, coverage };
  }
  if (!row) return { state, coverage };
  state.interactions.set(row.root_event_id, row);
  (coverage.interactions as Set<string>).add(row.root_event_id);
  if (!row.entity_id) return { state, coverage };

  // Sibling roots of the same entity and kind feed head-aware field
  // recompute: revising one disputant must see the others to preserve the
  // dispute instead of overwriting it. Entity histories stay small; the
  // read is indexed and never workspace-wide.
  const loaded = await db.batch([
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
    db
      .prepare(
        `SELECT ${INTERACTION_COLUMNS} FROM interaction_state
         WHERE workspace_id = ? AND entity_id = ? AND kind = ? AND root_event_id != ?`,
      )
      .bind(workspaceId, row.entity_id, row.kind, row.root_event_id),
  ]);
  const rowsAt = (index: number): Record<string, unknown>[] =>
    ((loaded[index] as unknown as { results?: Record<string, unknown>[] }).results ?? []);
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
  for (const r of rowsAt(2)) {
    const sibling = mapInteractionRow(r);
    state.interactions.set(sibling.root_event_id, sibling);
    (coverage.interactions as Set<string>).add(sibling.root_event_id);
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
