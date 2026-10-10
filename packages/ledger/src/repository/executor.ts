/**
 * @otis/ledger/repository/executor
 * Transactional D1 execution boundary for ledger commands.
 * In accordance with architecture.md section 8 and docs/archive/plans/002-ledger.md.
 */

import type {
  CommandResult,
  DraftProjection,
  Entity,
  EntityAlias,
  EntityStateField,
  InteractionState,
  LedgerEvent,
  MemoryEntry,
  MemorySuppression,
  PendingOperationPayload,
  Task,
} from '@otis/contracts';
import type { LedgerCommandContext, LedgerProjectionState, CoverageScope, ProjectionCoverage } from '../types.js';
import { handleLinkAttachment, handleUnlinkAttachment, handleUpdateAttachment } from '../commands/attachments.js';
import { handleChangeReminderRule } from '../commands/reminderRules.js';
import { FULL_PROJECTION_COVERAGE } from '../types.js';
import { expandCanonicalProjectionState, getActionReceipt, getBusinessProjectionState, getEntityInteractions, getFieldProjectionState, getInteractionProjectionState, getLogEventProjectionState, getRecordsProjectionState, getWorkspaceProjectionState, getWorkspaceRevision, recordsScopeFor } from './queries.js';
import { businessDetailStatements, hydrateBusinessDetails } from './business.js';
import { ENTITY_FAMILY_SQL, familyBinds } from './canonical.js';
import { reduceBusinessDetails } from '../reducers/business.js';
import { handleChangeContact } from '../commands/contacts.js';
import { handleMergeEntities } from '../commands/mergeEntity.js';
import { handleCreateEntity } from '../commands/createEntity.js';
import { handleRenameEntity } from '../commands/renameEntity.js';
import { handleDeleteEntity } from '../commands/deleteEntity.js';
import { handleReviseInteraction, handleRemoveInteraction } from '../commands/interactions.js';
import { handleSetField } from '../commands/setField.js';
import { handleSetFields, normalizeStatusResumeAnswer, STATUS_CONFIRM_WORDS, STATUS_DECLINE_WORDS } from '../commands/setFields.js';
import { handleCreateTask, handleUpdateTask } from '../commands/tasks.js';
import { handleLogEvent } from '../commands/logEvent.js';
import { handleRecordDraft } from '../commands/recordDraft.js';
import { handleResolveConflict } from '../commands/resolveConflict.js';
import { handleRememberContext, handleForgetMemory } from '../commands/memory.js';
import { handleMarkMessageSent } from '../commands/markMessageSent.js';
import { handleRecordsBatch } from '../commands/recordsBatch.js';
import { recordsDetailStatements } from './records.js';

/**
 * Computes SHA-256 hash using Web standard SubtleCrypto API.
 */
async function computeHash(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const buffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  const hashArray = Array.from(new Uint8Array(buffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type CommandHandler<TArgs> = (
  context: LedgerCommandContext,
  state: LedgerProjectionState,
  nextSequence: number,
  args: TArgs,
) => {
  result: CommandResult;
  events: LedgerEvent[];
  nextState?: LedgerProjectionState;
  /**
   * Trusted business-effect cost for the daily quota: the number of ready
   * field mutations this commit charges. Defaults to 1 (every other
   * command). Only the batch field handler sets it; the model never does.
   */
  actionCost?: number;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCommandHandler = CommandHandler<any>;

export const DEFAULT_COMMAND_HANDLERS: Record<string, AnyCommandHandler> = {
  change_contact: handleChangeContact,
  merge_entities: handleMergeEntities,
  link_attachment: handleLinkAttachment,
  unlink_attachment: handleUnlinkAttachment,
  update_attachment: handleUpdateAttachment,
  change_reminder_rule: handleChangeReminderRule,
  create_entity: handleCreateEntity,
  rename_entity: handleRenameEntity,
  delete_entity: handleDeleteEntity,
  revise_interaction: handleReviseInteraction,
  remove_interaction: handleRemoveInteraction,
  set_field: handleSetField,
  set_fields: handleSetFields,
  create_task: handleCreateTask,
  update_task: handleUpdateTask,
  log_event: handleLogEvent,
  record_draft: handleRecordDraft,
  resolve_conflict: handleResolveConflict,
  remember_context: handleRememberContext,
  forget_memory: handleForgetMemory,
  mark_message_sent: handleMarkMessageSent,
  records_batch: handleRecordsBatch,
};

/**
 * Creates the single transactional guard statement for the atomic D1 batch.
 * Guarantees that:
 * 1. Workspace revision matches expected business revision.
 * 2. Actor is an active workspace member (or system actor with matching job).
 * 3. Source message exists in this workspace, belongs to the acting member, and matches channel.
 * 4. System job exists in this workspace, matches actor system_job, and is active ('pending' | 'running').
 * 5. Execution fence matches a present, unexpired workspace lease.
 *    Ordinary run-scoped writes from a dispatched handler must present the
 *    fence (fail closed with missing_fence when absent); clarification
 *    resumption is exempt by resuming_clarification_id. A cleared lease
 *    (NULL owner/expiry after recovery) never satisfies the guard: the fence
 *    alone is insufficient without a live lease.
 * 6. Agent run (if specified) exists in this workspace, is 'running' for
 *    ordinary dispatched writes, is pinned to the lease holder
 *    (lease owner/attempt match the run attempt), and matches source
 *    message/job. Clarification resumption instead requires 'waiting_for_input'.
 * 7. Run step (if specified) exists for this run.
 */
function createGuardStatement(
  db: D1Database,
  guardId: string,
  context: LedgerCommandContext,
  actionCost = 1,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO ledger_guards (id, guard_ok)
       VALUES (
         ?,
         (SELECT 1
          FROM workspaces w
          WHERE w.id = ?
            AND w.business_revision = ?
            -- 1. Actor membership:
            AND (? = 'system' OR EXISTS (
              SELECT 1 FROM workspace_users wu
              WHERE wu.workspace_id = w.id AND wu.user_id = ?
            ))
            -- 2. Source message ownership, workspace matching, and channel:
            AND (? IS NULL OR EXISTS (
              SELECT 1 FROM messages_in mi
              WHERE mi.id = ?
                AND mi.workspace_id = w.id
                AND (? = 'system' OR mi.user_id = ?)
                AND (? IS NULL OR mi.channel = ?)
            ))
            -- 3. System job ownership, workspace matching, kind, and active status:
            AND (? IS NULL OR EXISTS (
              SELECT 1 FROM system_jobs sj
              WHERE sj.id = ?
                AND sj.workspace_id = w.id
                AND (? = 'system' AND sj.job_kind = ?)
                AND sj.status IN ('pending', 'running')
            ))
            -- 4. Live lease fence and expiration (skipped when no fence supplied):
            -- a cleared lease (NULL owner/expiry) never passes, even when the
            -- fence value still matches after recovery.
            AND (? IS NULL OR (
              w.lease_fence = ?
              AND w.lease_expires_at IS NOT NULL
              AND unixepoch(w.lease_expires_at) > unixepoch('now')
              AND w.lease_owner IS NOT NULL
              AND w.lease_attempt_id IS NOT NULL
            ))
            -- 5a. Ordinary run validation (if run_id provided and NOT resuming clarification):
            -- the run must be actively pinned to the live lease holder.
            AND (? IS NOT NULL OR ? IS NULL OR EXISTS (
              SELECT 1 FROM agent_runs ar
              JOIN workspaces w2 ON w2.id = ar.workspace_id
              WHERE ar.id = ?
                AND ar.workspace_id = w.id
                AND ar.status = 'running'
                AND ar.attempt_id IS NOT NULL
                AND w2.lease_owner = ar.attempt_id
                AND w2.lease_attempt_id = ar.attempt_id
                AND w2.lease_expires_at IS NOT NULL
                AND unixepoch(w2.lease_expires_at) > unixepoch('now')
                AND (? IS NULL OR ar.source_message_id = ? OR EXISTS (
                  SELECT 1 FROM chat_messages cm JOIN messages_in original ON original.id = ar.source_message_id
                  WHERE cm.run_id = ar.id AND cm.inbound_message_id = ? AND cm.workspace_id = ar.workspace_id
                    AND cm.author_user_id = original.user_id AND cm.author_kind = 'member'
                ))
                AND (? IS NULL OR ar.source_job_id = ?)
                AND (? IS NULL OR (ar.lease_fence = ? AND w2.lease_fence = ?))
            ))
            -- 5b. Clarification Resumption validation (if resuming_clarification_id provided):
            AND (? IS NULL OR EXISTS (
              SELECT 1 FROM pending_clarifications pc
              LEFT JOIN agent_runs ar ON ar.id = pc.run_id
              WHERE pc.id = ?
                AND pc.workspace_id = w.id
                AND pc.status = 'pending'
                AND (pc.run_id IS NULL OR ar.status = 'waiting_for_input')
                AND (pc.run_id IS NULL OR ? IS NULL OR ar.id = ?)
                AND (pc.run_id IS NULL OR ? IS NULL OR ar.lease_fence = ?)
            ))
            -- 6. Step validation (if step_id provided):
            AND (? IS NULL OR EXISTS (
              SELECT 1 FROM run_steps rs
              WHERE rs.id = ?
                AND rs.run_id = ?
                AND rs.workspace_id = w.id
            ))
            AND (? IS NULL OR EXISTS (SELECT 1 FROM media_objects m WHERE m.workspace_id = w.id AND m.id = ?
              AND m.state IN ('validated', 'ready', 'transcribing') AND m.deletion_claimed_at IS NULL
              AND (m.retained = 1 OR m.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))))
            AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM attachment_links l WHERE l.workspace_id = w.id AND l.media_id = ? AND l.state = 'active'))
            AND (? IS NULL OR EXISTS (SELECT 1 FROM media_objects m JOIN media_transcriptions t ON t.workspace_id = m.workspace_id AND t.media_id = m.id
              WHERE m.workspace_id = w.id AND m.id = ? AND m.content_type LIKE 'audio/%'
                AND t.state = 'ready' AND t.transcript_text IS NOT NULL))
            -- 7. Daily action limit validation (if max_daily_actions provided):
            -- the trusted batch cost counts with the same aborting guard, so
            -- a multi-field commit exceeding remaining capacity rolls back.
            AND (? IS NULL OR COALESCE((
              SELECT action_count
              FROM workspace_daily_actions
              WHERE workspace_id = w.id AND date_utc = ?
            ), 0) + ? <= ?)
         )
       )`
    )
    .bind(
      guardId,
      context.workspace_id,
      context.expected_business_revision,
      context.actor.kind,
      context.actor.user_id || '',
      context.source_message_id || null,
      context.source_message_id || '',
      context.actor.kind,
      context.actor.user_id || '',
      context.source_channel || null,
      context.source_channel || '',
      context.source_job_id || null,
      context.source_job_id || '',
      context.actor.kind,
      context.actor.system_job || '',
      context.fence !== undefined ? context.fence : null,
      context.fence !== undefined ? context.fence : 0,
      // 5a (ordinary run):
      context.resuming_clarification_id || null,
      context.run_id || null,
      context.run_id || '',
      context.source_message_id || null,
      context.source_message_id || '',
      context.source_message_id || '',
      context.source_job_id || null,
      context.source_job_id || '',
      context.fence !== undefined ? context.fence : null,
      context.fence !== undefined ? context.fence : 0,
      context.fence !== undefined ? context.fence : 0,
      // 5b (clarification resumption):
      context.resuming_clarification_id || null,
      context.resuming_clarification_id || '',
      context.run_id || null,
      context.run_id || '',
      context.fence !== undefined ? context.fence : null,
      context.fence !== undefined ? context.fence : 0,
      // 6 (step):
      context.step_id || null,
      context.step_id || '',
      context.run_id || '',
      // 7 (daily quota):
      context.required_media_id ?? null,
      context.required_media_id ?? '',
      context.releasing_media_id ?? null,
      context.releasing_media_id ?? '',
      context.correcting_audio_id ?? null,
      context.correcting_audio_id ?? '',
      context.max_daily_actions !== undefined ? context.max_daily_actions : null,
      new Date().toISOString().slice(0, 10),
      Number.isInteger(actionCost) && (actionCost as number) >= 0 ? (actionCost as number) : 1,
      context.max_daily_actions !== undefined ? context.max_daily_actions : 0,
    );
}

/**
 * Handles batch failure by detecting whether it was a transaction guard failure
 * and mapping to precise typed CommandResult errors.
 */
async function handleBatchError(
  err: unknown,
  db: D1Database,
  context: LedgerCommandContext,
  actionCost = 1,
): Promise<CommandResult> {
  const latestWs = await getWorkspaceRevision(db, context.workspace_id);
  if (!latestWs || latestWs.business_revision !== context.expected_business_revision) {
    return {
      status: 'conflict',
      action_id: context.action_id,
      error: {
        code: 'revision_conflict',
        message: `Stale business revision: expected ${context.expected_business_revision}, but workspace revision is ${latestWs?.business_revision}.`,
      },
    };
  }

  if (
    context.fence !== undefined &&
    (latestWs.lease_fence !== context.fence ||
      latestWs.lease_expires_at === null ||
      new Date(latestWs.lease_expires_at).getTime() <= Date.now())
  ) {
    return {
      status: 'conflict',
      action_id: context.action_id,
      error: {
        code: 'fence_conflict',
        message: `Stale execution fence or expired lease: expected fence ${context.fence} (workspace fence is ${latestWs.lease_fence}, expires at ${latestWs.lease_expires_at}).`,
      },
    };
  }

  // Check daily action limit (cost-aware: a batch charges its ready mutations)
  if (context.max_daily_actions !== undefined) {
    const todayUtc = new Date().toISOString().slice(0, 10);
    const quotaRow = await db
      .prepare(`SELECT action_count FROM workspace_daily_actions WHERE workspace_id = ? AND date_utc = ?`)
      .bind(context.workspace_id, todayUtc)
      .first<{ action_count: number }>();
    const cost = Number.isInteger(actionCost) && (actionCost as number) >= 0 ? (actionCost as number) : 1;
    if ((quotaRow?.action_count ?? 0) + cost > context.max_daily_actions) {
      return {
        status: 'rejected',
        action_id: context.action_id,
        error: {
          code: 'daily_action_limit_exceeded',
          message: `Workspace daily action limit (${context.max_daily_actions}) exceeded.`,
        },
      };
    }
  }

  // Check membership
  if (context.actor.kind === 'member' && context.actor.user_id) {
    const isMember = await db
      .prepare(`SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
      .bind(context.workspace_id, context.actor.user_id)
      .first();
    if (!isMember) {
      return {
        status: 'rejected',
        action_id: context.action_id,
        error: {
          code: 'forbidden',
          message: 'User is not an active member of this workspace.',
        },
      };
    }
  }

  // Check source message
  if (context.source_message_id) {
    const srcMsg = await db
      .prepare(`SELECT workspace_id, user_id, channel FROM messages_in WHERE id = ?`)
      .bind(context.source_message_id)
      .first<Record<string, unknown>>();
    if (!srcMsg || srcMsg['workspace_id'] !== context.workspace_id) {
      return {
        status: 'rejected',
        action_id: context.action_id,
        error: {
          code: 'source_conflict',
          message: `Source message '${context.source_message_id}' does not belong to workspace '${context.workspace_id}'.`,
        },
      };
    }
    if (context.actor.kind === 'member' && srcMsg['user_id'] !== context.actor.user_id) {
      return {
        status: 'conflict',
        action_id: context.action_id,
        error: {
          code: 'guard_conflict',
          message: `Source message '${context.source_message_id}' belongs to user '${srcMsg['user_id']}', not actor '${context.actor.user_id}'.`,
        },
      };
    }
    if (context.source_channel && srcMsg['channel'] !== context.source_channel) {
      return {
        status: 'conflict',
        action_id: context.action_id,
        error: {
          code: 'channel_conflict',
          message: `Source message channel is '${srcMsg['channel']}', but context specified '${context.source_channel}'.`,
        },
      };
    }
  }

  // Check system job
  if (context.source_job_id) {
    const srcJob = await db
      .prepare(`SELECT workspace_id, job_kind, status FROM system_jobs WHERE id = ?`)
      .bind(context.source_job_id)
      .first<Record<string, unknown>>();
    if (!srcJob || srcJob['workspace_id'] !== context.workspace_id) {
      return {
        status: 'rejected',
        action_id: context.action_id,
        error: {
          code: 'source_conflict',
          message: `Source job '${context.source_job_id}' does not belong to workspace '${context.workspace_id}'.`,
        },
      };
    }
    if (context.actor.kind !== 'system' || srcJob['job_kind'] !== context.actor.system_job) {
      return {
        status: 'conflict',
        action_id: context.action_id,
        error: {
          code: 'guard_conflict',
          message: `Source job '${context.source_job_id}' kind '${srcJob['job_kind']}' does not match actor '${context.actor.system_job}'.`,
        },
      };
    }
    if (srcJob['status'] !== 'pending' && srcJob['status'] !== 'running') {
      return {
        status: 'conflict',
        action_id: context.action_id,
        error: {
          code: 'job_inactive',
          message: `Source job '${context.source_job_id}' status is '${srcJob['status']}', not active.`,
        },
      };
    }
  }

  // Check pending clarification if resuming
  if (context.resuming_clarification_id) {
    const clarRow = await db
      .prepare(`SELECT status, workspace_id, run_id FROM pending_clarifications WHERE id = ?`)
      .bind(context.resuming_clarification_id)
      .first<Record<string, unknown>>();
    if (!clarRow || clarRow['workspace_id'] !== context.workspace_id) {
      return {
        status: 'conflict',
        action_id: context.action_id,
        error: {
          code: 'clarification_not_found',
          message: `Pending clarification '${context.resuming_clarification_id}' not found in workspace '${context.workspace_id}'.`,
        },
      };
    }
    if (clarRow['status'] !== 'pending') {
      return {
        status: 'conflict',
        action_id: context.action_id,
        error: {
          code: 'already_resolved',
          message: `Clarification '${context.resuming_clarification_id}' is '${clarRow['status']}', no longer pending.`,
        },
      };
    }
    if (clarRow['run_id']) {
      const runRow = await db
        .prepare(`SELECT status FROM agent_runs WHERE id = ?`)
        .bind(clarRow['run_id'])
        .first<Record<string, unknown>>();
      if (runRow && runRow['status'] !== 'waiting_for_input') {
        return {
          status: 'conflict',
          action_id: context.action_id,
          error: {
            code: 'run_not_waiting',
            message: `Run '${clarRow['run_id']}' status is '${runRow['status']}', not 'waiting_for_input'.`,
          },
        };
      }
    }
  }

  // Check run for ordinary writes
  if (context.run_id && !context.resuming_clarification_id) {
    const runRow = await db
      .prepare(`SELECT workspace_id, status, source_message_id, source_job_id FROM agent_runs WHERE id = ?`)
      .bind(context.run_id)
      .first<Record<string, unknown>>();
    if (!runRow || runRow['workspace_id'] !== context.workspace_id) {
      return {
        status: 'conflict',
        action_id: context.action_id,
        error: {
          code: 'run_conflict',
          message: `Run '${context.run_id}' not found or belongs to another workspace.`,
        },
      };
    }
    if (runRow['status'] !== 'queued' && runRow['status'] !== 'running') {
      return {
        status: 'conflict',
        action_id: context.action_id,
        error: {
          code: 'run_inactive',
          message: `Run '${context.run_id}' is '${runRow['status']}', not active.`,
        },
      };
    }
    if (context.source_message_id && runRow['source_message_id'] !== context.source_message_id) {
      return {
        status: 'conflict',
        action_id: context.action_id,
        error: {
          code: 'run_source_mismatch',
          message: `Run '${context.run_id}' trigger message does not match command source message.`,
        },
      };
    }
  }

  // Check if error was due to CHECK constraint on ledger_guards
  const errMsg = err instanceof Error ? err.message : String(err);
  if (errMsg.includes('ledger_guards') || errMsg.includes('CHECK constraint failed')) {
    return {
      status: 'conflict',
      action_id: context.action_id,
      error: {
        code: 'guard_conflict',
        message: `Transaction guard failed: execution preconditions violated (${errMsg}).`,
      },
    };
  }

  throw err;
}

/**
 * Immutable persisted-column snapshot of one projection collection,
 * captured BEFORE the domain handler runs. Reducers may mutate the shared
 * objects in place or shallow-copy the maps, so anything read from
 * `currentState` after the handler can silently miss the change (or see a
 * change that is compared against itself). Fingerprints are plain strings
 * materialized up front: later comparison is by value, never by reference.
 *
 * Each entry carries the exact persisted columns (normalized exactly like
 * the upsert binds: undefined becomes null, arrays become their JSON text)
 * plus the delete binds for its row, so deletions use prior keys even when
 * the handler already dropped them from its maps.
 */
interface ProjectionSnap {
  /** Keyed by the state's own map key. */
  records: Map<string, { fingerprint: string; del: unknown[] }>;
}

/** Single-record persisted-column fingerprints (same normalization as the
 * upsert binds). Used for both the pre-handler snapshot and the post-handler
 * next state, so column lists live in exactly one place per collection. */
function fpValues(values: unknown[]): string {
  return JSON.stringify(
    values.map((value) => {
      if (value === undefined) return null;
      if (Array.isArray(value)) return JSON.stringify(value);
      return value;
    }),
  );
}

function fpEntity(e: Entity): string {
  return fpValues([
    e.id, e.workspace_id, e.name, e.kind, e.status, e.assigned_user_id ?? null, e.created_at, e.updated_at,
  ]);
}

function fpAlias(a: EntityAlias): string {
  return fpValues([a.id, a.workspace_id, a.entity_id, a.alias, a.source_event_id ?? null, a.created_at]);
}

function fpField(f: EntityStateField): string {
  const candidates =
    typeof f.candidate_event_ids === 'string'
      ? f.candidate_event_ids
      : f.candidate_event_ids
        ? JSON.stringify(f.candidate_event_ids)
        : null;
  return fpValues([
    f.id, f.workspace_id, f.entity_id, f.field_name, f.state, f.value_text ?? null, f.value_json ?? null,
    f.provenance, f.source_event_id ?? null, candidates, f.last_confirmed_value_text ?? null,
    f.last_confirmed_value_json ?? null, f.revision, f.updated_at, f.quote_authority_json ?? null,
  ]);
}

function fpInteraction(row: InteractionState): string {
  return fpValues([
    row.workspace_id, row.root_event_id, row.entity_id ?? null, row.kind, row.head_event_id,
    row.revision, row.state, row.occurred_at, row.sequence, row.updated_at, row.head_value_json ?? null,
  ]);
}

function fpTask(t: Task): string {
  return fpValues([
    t.id, t.workspace_id, t.entity_id ?? null, t.title, t.assignee_user_id ?? null, t.status,
    t.due_kind ?? null, t.due_local_date ?? null, t.due_instant ?? null, t.due_timezone ?? null,
    t.snooze_until ?? null, t.source_event_id, t.revision, t.created_at, t.updated_at,
  ]);
}

function fpDraft(d: DraftProjection): string {
  return fpValues([
    d.id, d.workspace_id, d.entity_id ?? null, d.channel, d.recipient_address ?? null, d.content_text,
    d.status, d.source_event_id, d.revision, d.created_at, d.updated_at,
  ]);
}

function fpMemory(m: MemoryEntry): string {
  return fpValues([
    m.id, m.workspace_id, m.scope, m.subject_id ?? null, m.category, m.content, m.status, m.provenance,
    m.source_event_id ?? null, m.source_message_id ?? null, m.author_user_id ?? null, m.observed_at,
    m.created_at, m.superseding_event_id ?? null, m.business_revision,
  ]);
}

function fpSuppression(s: MemorySuppression): string {
  return fpValues([
    s.id, s.workspace_id, s.target_memory_id, s.source_event_id ?? null, s.source_message_id ?? null,
    s.suppression_event_id, s.revision, s.created_at,
  ]);
}

function snapEntities(state: LedgerProjectionState): ProjectionSnap {
  const records = new Map<string, { fingerprint: string; del: unknown[] }>();
  for (const [key, e] of state.entities) {
    records.set(key, {
      fingerprint: fpEntity(e),
      del: [e.workspace_id, e.id],
    });
  }
  return { records };
}

function snapAliases(state: LedgerProjectionState): ProjectionSnap {
  const records = new Map<string, { fingerprint: string; del: unknown[] }>();
  for (const [key, a] of state.aliases) {
    records.set(key, {
      fingerprint: fpAlias(a),
      del: [a.workspace_id, a.entity_id, a.alias],
    });
  }
  return { records };
}

function snapFields(state: LedgerProjectionState): ProjectionSnap {
  const records = new Map<string, { fingerprint: string; del: unknown[] }>();
  for (const [key, f] of state.fields) {
    records.set(key, {
      fingerprint: fpField(f),
      del: [f.workspace_id, f.entity_id, f.field_name],
    });
  }
  return { records };
}

function snapInteractions(state: LedgerProjectionState): ProjectionSnap {
  const records = new Map<string, { fingerprint: string; del: unknown[] }>();
  for (const [key, row] of state.interactions) {
    records.set(key, {
      fingerprint: fpInteraction(row),
      del: [row.workspace_id, row.root_event_id],
    });
  }
  return { records };
}

function snapTasks(state: LedgerProjectionState): ProjectionSnap {
  const records = new Map<string, { fingerprint: string; del: unknown[] }>();
  for (const [key, t] of state.tasks) {
    records.set(key, {
      fingerprint: fpTask(t),
      del: [t.workspace_id, t.id],
    });
  }
  return { records };
}

function snapDrafts(state: LedgerProjectionState): ProjectionSnap {
  const records = new Map<string, { fingerprint: string; del: unknown[] }>();
  for (const [key, d] of state.drafts) {
    records.set(key, {
      fingerprint: fpDraft(d),
      del: [d.workspace_id, d.id],
    });
  }
  return { records };
}

function snapMemoryEntries(state: LedgerProjectionState): ProjectionSnap {
  const records = new Map<string, { fingerprint: string; del: unknown[] }>();
  for (const [key, m] of state.memoryEntries) {
    records.set(key, {
      fingerprint: fpMemory(m),
      del: [m.workspace_id, m.id],
    });
  }
  return { records };
}

function snapSuppressions(state: LedgerProjectionState): ProjectionSnap {
  const records = new Map<string, { fingerprint: string; del: unknown[] }>();
  for (const [key, s] of state.memorySuppressions) {
    records.set(key, {
      fingerprint: fpSuppression(s),
      del: [s.workspace_id, s.id],
    });
  }
  return { records };
}

function snapRecordMaps<V>(
  map: Map<string, V> | undefined,
  del: (row: V) => unknown[],
): ProjectionSnap {
  const records = new Map<string, { fingerprint: string; del: unknown[] }>();
  for (const [key, row] of map ?? new Map<string, V>()) {
    records.set(key, { fingerprint: JSON.stringify(row), del: del(row) });
  }
  return { records };
}

interface ProjectionSnapshots {
  entities: ProjectionSnap;
  aliases: ProjectionSnap;
  fields: ProjectionSnap;
  interactions: ProjectionSnap;
  tasks: ProjectionSnap;
  drafts: ProjectionSnap;
  memoryEntries: ProjectionSnap;
  memorySuppressions: ProjectionSnap;
  recordsLists: ProjectionSnap;
  recordsListColumns: ProjectionSnap;
  recordsRows: ProjectionSnap;
  recordsValues: ProjectionSnap;
  fieldDefinitions: ProjectionSnap;
}

function snapshotProjections(state: LedgerProjectionState): ProjectionSnapshots {
  return {
    entities: snapEntities(state),
    aliases: snapAliases(state),
    fields: snapFields(state),
    interactions: snapInteractions(state),
    tasks: snapTasks(state),
    drafts: snapDrafts(state),
    memoryEntries: snapMemoryEntries(state),
    memorySuppressions: snapSuppressions(state),
    recordsLists: snapRecordMaps(state.recordsLists, (r) => [r.workspace_id, r.id]),
    recordsListColumns: snapRecordMaps(state.recordsListColumns, (r) => [r.workspace_id, r.id]),
    recordsRows: snapRecordMaps(state.recordsRows, (r) => [r.workspace_id, r.id]),
    recordsValues: snapRecordMaps(state.recordsValues, (r) => [r.workspace_id, r.row_id, r.column_id]),
    fieldDefinitions: snapRecordMaps(state.fieldDefinitions, (r) => [r.workspace_id, r.id]),
  };
}

/**
 * Pre-handler memory status/content/scope by id, for FTS, refresh-job, and
 * delete-path decisions that must not read post-handler objects. The main
 * fingerprint snapshot proves changed-ness; these flags supply the exact
 * prior values those decisions branch on.
 */
function snapMemoryFlags(
  state: LedgerProjectionState,
): Map<string, { scope: string; subject_id: string | null; status: string; content: string }> {
  const flags = new Map<string, { scope: string; subject_id: string | null; status: string; content: string }>();
  for (const [key, m] of state.memoryEntries) {
    flags.set(key, { scope: m.scope, subject_id: m.subject_id ?? null, status: m.status, content: m.content });
  }
  return flags;
}

/**
 * Splits next-state keys against a pre-handler snapshot into created,
 * changed (persisted values differ), and deleted sets. Unchanged records
 * emit no statements at all. Created/changed follow next-state order;
 * deleted follow snapshot order; both deterministic.
 */
function diffSnapshots<V>(
  snap: Map<string, { fingerprint: string; del: unknown[] }>,
  next: Map<string, V>,
  fingerprint: (value: V) => string,
): { created: string[]; changed: string[]; deleted: string[] } {
  const created: string[] = [];
  const changed: string[] = [];
  for (const [key, value] of next) {
    const prior = snap.get(key);
    if (!prior) created.push(key);
    else if (prior.fingerprint !== fingerprint(value)) changed.push(key);
  }
  const deleted: string[] = [];
  for (const key of snap.keys()) {
    if (!next.has(key)) deleted.push(key);
  }
  return { created, changed, deleted };
}

/**
 * Trusted footprint selection for targeted hydration. Matches the actual
 * registered handler identity, never the caller's command-name string:
 * custom handlers under a familiar name keep the full loader. Returns null
 * for anything unrecognized so hydration stays fail-open to full state.
 */
function fieldFootprintFor(
  handler: CommandHandler<unknown>,
  args: unknown,
): { entityId: string; fieldNames: string[] } | null {
  if (handler !== (handleSetField as AnyCommandHandler) && handler !== (handleSetFields as AnyCommandHandler) && handler !== (handleResolveConflict as AnyCommandHandler)) {
    return null;
  }
  const record = (args ?? {}) as Record<string, unknown>;
  if (typeof record['entity_id'] !== 'string' || !record['entity_id']) return null;
  if (handler === (handleSetFields as AnyCommandHandler)) {
    if (!Array.isArray(record['fields'])) return null;
    const names: string[] = [];
    for (const item of record['fields']) {
      const name = (item as Record<string, unknown> | null)?.['field_name'];
      if (typeof name !== 'string' || !name) return null;
      names.push(name);
    }
    return { entityId: record['entity_id'], fieldNames: names };
  }
  const name = record['field_name'];
  if (typeof name !== 'string' || !name) return null;
  return { entityId: record['entity_id'], fieldNames: [name] };
}

/**
 * Bounds assertion for the interaction collection. Changed and deleted
 * keys must sit inside the loaded coverage like every other collection,
 * but created keys follow one explicit allowance: a new log is the only
 * writer that creates roots, and its root must belong to the entity the
 * footprint loaded (or be entity-less when the log has no entity). Any
 * other created root — or a root for an entity outside coverage — is a
 * violation, so a partial state can never smuggle foreign lifecycle rows.
 */
function checkInteractions(
  coverage: ProjectionCoverage,
  before: ProjectionSnapshots,
  next: LedgerProjectionState,
  violations: string[],
): void {
  const scope = coverage.interactions;
  const snap = before.interactions.records;
  const values = next.interactions;
  if (scope === 'all') return;
  for (const [key, value] of values) {
    // Loaded keys may change freely: that is what coverage grants.
    if (scope.has(key)) continue;
    const prior = snap.get(key);
    if (!prior) {
      // Created key: allowed for composing batches (whose server-owned ids
      // cannot be enumerated before the run), and otherwise only for the
      // footprint's own entity scope.
      if (coverage.createScope === 'all') continue;
      const allowed = coverage.interactionCreate;
      const covered = allowed && (value.entity_id ?? null) === allowed.entity_id && value.kind === allowed.kind;
      if (!covered) violations.push(`created interaction '${key}' outside loaded coverage`);
      continue;
    }
    if (prior.fingerprint !== fpInteraction(value)) {
      violations.push(`changed interaction '${key}' outside loaded coverage`);
    }
  }
  for (const key of snap.keys()) {
    if (!scope.has(key) && !values.has(key)) violations.push(`deleted interaction '${key}' outside loaded coverage`);
  }
}

/**
 * Trusted footprint selection for C1 targeted hydration. Matches the actual
 * registered revise/remove handler identity, never the caller's
 * command-name string. Returns null for anything unrecognized so hydration
 * stays fail-open to full state.
 */
function interactionFootprintFor(
  handler: CommandHandler<unknown>,
  args: unknown,
): { rootId: string } | null {
  if (handler !== (handleReviseInteraction as AnyCommandHandler) && handler !== (handleRemoveInteraction as AnyCommandHandler)) {
    return null;
  }
  const record = (args ?? {}) as Record<string, unknown>;
  if (typeof record['interaction_id'] !== 'string' || !record['interaction_id']) return null;
  return { rootId: record['interaction_id'] };
}

/**
 * Trusted footprint selection for new log_event writes. Matches the actual
 * registered handler identity, never the caller's command-name string. A
 * new log reads the scoped entity plus active quote siblings when the
 * entry is a quote; everything else stays unloaded. Returns null for
 * anything unrecognized so hydration stays fail-open to full state.
 */
function logEventFootprintFor(
  handler: CommandHandler<unknown>,
  args: unknown,
): { entityId: string | null; kind: string } | null {
  if (handler !== (handleLogEvent as AnyCommandHandler)) return null;
  const record = (args ?? {}) as Record<string, unknown>;
  const kind = record['kind'];
  if (typeof kind !== 'string' || !['note', 'visit', 'contact', 'quote'].includes(kind)) return null;
  const entityId = record['entity_id'];
  if (entityId !== undefined && entityId !== null && (typeof entityId !== 'string' || !entityId)) return null;
  return { entityId: typeof entityId === 'string' && entityId ? entityId : null, kind };
}

/**
 * Trusted footprint selection for records_batch. Matches the actual
 * registered handler identity, never the caller's command-name string.
 * Structurally unexpected args return null so hydration stays fail-open to
 * full state; the handler itself rejects malformed batches.
 */
async function recordsTargetedState(
  db: D1Database,
  workspaceId: string,
  handler: CommandHandler<unknown>,
  args: unknown,
): Promise<{ state: LedgerProjectionState; coverage: ProjectionCoverage } | null> {
  if (handler !== (handleRecordsBatch as AnyCommandHandler)) return null;
  const scope = recordsScopeFor(handler, args);
  if (!scope) return null;
  return getRecordsProjectionState(db, workspaceId, scope);
}

/**
 * Pure post-handler bounds assertion for targeted hydration: any created,
 * changed or deleted key outside the loaded coverage is rejected before any
 * commit, so a partial state can never persist as the whole workspace.
 */
function coverageViolations(
  before: ProjectionSnapshots,
  next: LedgerProjectionState | undefined,
  coverage: ProjectionCoverage,
): string[] {
  if (!next) return [];
  const violations: string[] = [];
  // Composing batches create server-owned rows (entities, tasks, contacts,
  // custom rows) whose ids cannot be enumerated before the run. Creations
  // cannot misread unloaded state as absent, so the records footprint
  // permits them while changed and deleted keys stay strictly covered.
  const allowCreate = coverage.createScope === 'all';
  const check = <V>(
    label: string,
    scope: CoverageScope | undefined,
    snap: Map<string, { fingerprint: string; del: unknown[] }>,
    values: Map<string, V> | undefined,
    fingerprint: (value: V) => string,
  ) => {
    const effective: CoverageScope = scope ?? 'all';
    if (effective === 'all') return;
    for (const [key, value] of values ?? new Map<string, V>()) {
      if (effective.has(key)) continue;
      const prior = snap.get(key);
      if (!prior) {
        if (!allowCreate) violations.push(`created ${label} '${key}' outside loaded coverage`);
      } else if (prior.fingerprint !== fingerprint(value)) {
        violations.push(`changed ${label} '${key}' outside loaded coverage`);
      }
    }
    for (const key of snap.keys()) {
      if (!effective.has(key) && !(values ?? new Map()).has(key)) violations.push(`deleted ${label} '${key}' outside loaded coverage`);
    }
  };
  check('entity', coverage.entities, before.entities.records, next.entities, fpEntity);
  check('alias', coverage.aliases, before.aliases.records, next.aliases, fpAlias);
  check('field', coverage.fields, before.fields.records, next.fields, fpField);
  checkInteractions(coverage, before, next, violations);
  check('task', coverage.tasks, before.tasks.records, next.tasks, fpTask);
  check('draft', coverage.drafts, before.drafts.records, next.drafts, fpDraft);
  check('memory entry', coverage.memoryEntries, before.memoryEntries.records, next.memoryEntries, fpMemory);
  check('suppression', coverage.memorySuppressions, before.memorySuppressions.records, next.memorySuppressions, fpSuppression);
  const fpJson = (value: unknown): string => JSON.stringify(value);
  check('records list', coverage.recordsLists, before.recordsLists.records, next.recordsLists, fpJson);
  check('records column', coverage.recordsListColumns, before.recordsListColumns.records, next.recordsListColumns, fpJson);
  check('records row', coverage.recordsRows, before.recordsRows.records, next.recordsRows, fpJson);
  check('records value', coverage.recordsValues, before.recordsValues.records, next.recordsValues, fpJson);
  check('field definition', coverage.fieldDefinitions, before.fieldDefinitions.records, next.fieldDefinitions, fpJson);
  return violations;
}

/**
 * Shared pending-question persistence: the clarification row plus its
 * question activity, committed in the same atomic batch as the receipt or
 * the applied facts. The actor's waitForInput sees the row and skips its own
 * duplicate, so the question is never published twice.
 */
function pendingQuestionStatements(
  db: D1Database,
  input: {
    workspaceId: string;
    runId: string;
    chatId: string;
    sourceMessageId: string;
    requesterUserId: string;
    question: string;
    intendedOperation: string;
    missingFields: string[];
    candidates: string[] | undefined;
    pendingOperation: PendingOperationPayload;
    sourceRevision: number;
    now: string;
    deferRunTransition: boolean;
  },
): D1PreparedStatement[] {
  const clarId = `clar_${crypto.randomUUID()}`;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO pending_clarifications (
           id, workspace_id, chat_id, run_id, source_message_id, requester_user_id,
           question, intended_operation, missing_fields, candidates_json, operation_payload_json,
           source_revision, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .bind(
        clarId,
        input.workspaceId,
        input.chatId,
        input.runId,
        input.sourceMessageId,
        input.requesterUserId,
        input.question,
        input.intendedOperation,
        JSON.stringify(input.missingFields),
        input.candidates ? JSON.stringify(input.candidates) : null,
        JSON.stringify(input.pendingOperation),
        input.sourceRevision,
        input.now,
        input.now,
      ),
  ];
  if (!input.deferRunTransition) {
    statements.push(
      db
        .prepare(`UPDATE agent_runs SET status = 'waiting_for_input', updated_at = ? WHERE id = ? AND workspace_id = ?`)
        .bind(input.now, input.runId, input.workspaceId),
    );
  }
  const actId = `act_${crypto.randomUUID()}`;
  statements.push(
    db
      .prepare(
        `UPDATE chats
         SET activity_cursor = activity_cursor + 1,
             updated_at = ?,
             last_activity_at = ?
         WHERE id = ?`
      )
      .bind(input.now, input.now, input.chatId),
    db
      .prepare(
        `INSERT INTO run_activity (id, workspace_id, chat_id, run_id, cursor, type, payload_json, created_at)
         VALUES (
           ?, ?, ?, ?,
           (SELECT activity_cursor FROM chats WHERE id = ?),
           'clarification_required',
           ?,
           ?
         )`
      )
      .bind(
        actId,
        input.workspaceId,
        input.chatId,
        input.runId,
        input.chatId,
        JSON.stringify({
          action_id: input.pendingOperation.action_id,
          command_name: input.pendingOperation.command_name,
          prompt: input.question,
          missing_fields: input.missingFields,
          pending_operation: input.pendingOperation,
        }),
        input.now,
      ),
  );
  return statements;
}

/**
 * Cancels the unresolved intent of undone actions in the same Undo
 * transaction, so a later answer cannot resurrect reverted work. Matches on
 * the stored operation's action id; unrelated run/teammate questions stay
 * pending. Chunked to respect the 100-bindings-per-statement budget.
 */
function revertedIntentCancelStatements(
  db: D1Database,
  workspaceId: string,
  revertedActionIds: string[],
  now: string,
): D1PreparedStatement[] {
  const ids = [...new Set(revertedActionIds.filter((id) => typeof id === 'string' && id !== ''))];
  const statements: D1PreparedStatement[] = [];
  for (let offset = 0; offset < ids.length; offset += 40) {
    const chunk = ids.slice(offset, offset + 40);
    const placeholders = chunk.map(() => '?').join(',');
    statements.push(
      db
        .prepare(
          `UPDATE pending_clarifications
           SET status = 'cancelled',
               resolution_response = 'Undone with its saved action.',
               resolved_at = ?,
               updated_at = ?
           WHERE workspace_id = ? AND status = 'pending'
             AND json_extract(operation_payload_json, '$.action_id') IN (${placeholders})`,
        )
        .bind(now, now, workspaceId, ...chunk),
    );
  }
  return statements;
}

export async function executeLedgerCommand<TArgs>(
  db: D1Database,
  context: LedgerCommandContext,
  commandName: string,
  args: TArgs,
  handler: CommandHandler<TArgs>,
  extraStatements?: D1PreparedStatement[],
  options?: { deferRunTransition?: boolean; extrasBeforeGuard?: boolean },
): Promise<CommandResult> {
  const now = new Date().toISOString();
  const payloadHash = await computeHash(JSON.stringify({ commandName, args }));

  // 1. Idempotency Check: look up existing action receipt
  const existingReceipt = await getActionReceipt(db, context.workspace_id, context.action_id);
  if (existingReceipt) {
    if (existingReceipt.payload_hash === payloadHash) {
      // Identical retry: return the recorded result
      try {
        const parsed = JSON.parse(existingReceipt.result_json) as CommandResult;
        return {
          ...parsed,
          status: existingReceipt.result_status === 'needs_clarification' ? 'needs_clarification' : 'already_applied',
          action_id: context.action_id,
        };
      } catch {
        return {
          status: 'already_applied',
          action_id: context.action_id,
          committed_revision: existingReceipt.committed_revision,
        };
      }
    }

    // Reused action_id with different payload -> conflict
    return {
      status: 'conflict',
      action_id: context.action_id,
      error: {
        code: 'action_conflict',
        message: 'Action ID already committed with a different payload.',
      },
    };
  }

  // 2. Load workspace revision metadata
  const wsMeta = await getWorkspaceRevision(db, context.workspace_id);
  if (!wsMeta) {
    return {
      status: 'rejected',
      action_id: context.action_id,
      error: { code: 'not_found', message: `Workspace '${context.workspace_id}' not found.` },
    };
  }

  // 3. Stale revision check before executing handler
  if (context.expected_business_revision !== wsMeta.business_revision) {
    return {
      status: 'conflict',
      action_id: context.action_id,
      error: {
        code: 'revision_conflict',
        message: `Expected business revision ${context.expected_business_revision}, but workspace is at ${wsMeta.business_revision}.`,
      },
    };
  }

  // 3b. Fenced dispatch boundary: ordinary run-scoped writes must present the
  // dispatch fence so the transaction guard can validate it. A stale attempt
  // that lost its lease must not commit a business effect first. Direct
  // clarification resumption is explicitly distinguished: it executes while
  // the run waits (no lease held) and carries resuming_clarification_id.
  if (context.run_id && !context.resuming_clarification_id && context.fence === undefined) {
    return {
      status: 'rejected',
      action_id: context.action_id,
      error: {
        code: 'missing_fence',
        message: `Ledger mutations scoped to run '${context.run_id}' must present the dispatch fence.`,
      },
    };
  }

  // 4. Resolve source channel and effective chat ID
  let effectiveChannel: 'web' | 'telegram' | 'system' =
    context.source_channel || (context.actor.kind === 'system' ? 'system' : 'web');
  if (context.source_message_id) {
    const msgRow = await db
      .prepare(`SELECT channel, user_id FROM messages_in WHERE id = ? AND workspace_id = ?`)
      .bind(context.source_message_id, context.workspace_id)
      .first<Record<string, unknown>>();
    if (msgRow && msgRow['channel']) {
      effectiveChannel = msgRow['channel'] as 'web' | 'telegram' | 'system';
    }
  }

  let effectiveChatId: string | null = context.chat_id || null;
  if (!effectiveChatId && context.run_id) {
    const runRow = await db
      .prepare(`SELECT chat_id FROM agent_runs WHERE id = ? AND workspace_id = ?`)
      .bind(context.run_id, context.workspace_id)
      .first<Record<string, unknown>>();
    if (runRow && runRow['chat_id']) {
      effectiveChatId = String(runRow['chat_id']);
    }
  }

  const resolvedContext: LedgerCommandContext = {
    ...context,
    source_channel: effectiveChannel,
    chat_id: effectiveChatId || undefined,
    required_media_id: handler === (handleLinkAttachment as AnyCommandHandler) || handler === (handleUpdateAttachment as AnyCommandHandler) ? (args as { media_id: string }).media_id : undefined,
    releasing_media_id: handler === (handleUpdateAttachment as AnyCommandHandler) && (args as { retention?: string }).retention === 'release' ? (args as { media_id: string }).media_id : undefined,
    correcting_audio_id: handler === (handleUpdateAttachment as AnyCommandHandler) && (args as { transcript?: unknown }).transcript !== undefined ? (args as { media_id: string }).media_id : undefined,
  };

  // 5. Load current projection state and execute pure domain command.
  // Recognized handlers hydrate explicit footprints: trusted field writers
  // load their entity and requested fields; revise/remove load their root
  // plus active quote siblings when recompute needs them; new logs load
  // their entity plus active quote siblings for quote entries. Everything
  // Unknown/custom handlers, including Undo, take complete state. Known
  // unrelated writers skip interactions; deletion loads its own entity's
  // rows. The immutable snapshot is captured BEFORE the handler:
  // reducers may mutate the shared objects in place or shallow-copy the
  // maps, so the commit diff below compares post-handler values against
  // these strings, never against the (possibly mutated) currentState
  // objects.
  const footprint = fieldFootprintFor(handler as CommandHandler<unknown>, args);
  const interactionFootprint = footprint
    ? null
    : interactionFootprintFor(handler as CommandHandler<unknown>, args);
  const logFootprint = footprint || interactionFootprint
    ? null
    : logEventFootprintFor(handler as CommandHandler<unknown>, args);
  const businessIds = handler === (handleChangeContact as AnyCommandHandler) ? [(args as { entity_id: string }).entity_id]
    : handler === (handleMergeEntities as AnyCommandHandler) ? [(args as { source_entity_id: string }).source_entity_id, (args as { target_entity_id: string }).target_entity_id] : null;
  let ruleState: { state: LedgerProjectionState; coverage: ProjectionCoverage } | null = null;
  if (handler === (handleChangeReminderRule as AnyCommandHandler)) {
    const ruleArgs = args as { rule_id?: string; entity_id?: string | null };
    const row = ruleArgs.rule_id ? await db.prepare('SELECT * FROM reminder_rules WHERE workspace_id = ? AND user_id = ? AND id = ?').bind(context.workspace_id, context.actor.user_id ?? '', ruleArgs.rule_id).first<Record<string, unknown>>() : null;
    const entityId = ruleArgs.entity_id === undefined ? row?.entity_id : ruleArgs.entity_id;
    ruleState = await getFieldProjectionState(db, context.workspace_id, String(entityId ?? '__workspace_rule__'), []);
    ruleState.state.reminderRules = new Map(row ? [[String(row.id), { ...row, spec: JSON.parse(String(row.spec_json)) } as unknown as import('@otis/contracts').ReminderRule]] : []);
  }
  let attachmentEntity: string | null = null;
  if (handler === (handleLinkAttachment as AnyCommandHandler) || handler === (handleUpdateAttachment as AnyCommandHandler)) attachmentEntity = (args as { entity_id: string }).entity_id;
  if (handler === (handleUnlinkAttachment as AnyCommandHandler)) attachmentEntity = (await db.prepare('SELECT entity_id FROM attachment_links WHERE workspace_id = ? AND id = ?').bind(context.workspace_id, (args as { link_id: string }).link_id).first<{ entity_id: string }>())?.entity_id ?? '__missing__';
  const attachmentState = attachmentEntity ? await getFieldProjectionState(db, context.workspace_id, attachmentEntity, []) : null;
  if (attachmentState) {
    await hydrateBusinessDetails(db, context.workspace_id, attachmentState.state, [attachmentEntity!], ['attachment_links']);
    const rootId = (args as { interaction_id?: string }).interaction_id;
    if (rootId) {
      const root = await getInteractionProjectionState(db, context.workspace_id, rootId);
      attachmentState.state.interactions = root.state.interactions;
      attachmentState.coverage.interactions = root.coverage.interactions;
    }
  }
  const targeted = ruleState ?? attachmentState ?? (businessIds ? await getBusinessProjectionState(db, context.workspace_id, businessIds, handler === (handleMergeEntities as AnyCommandHandler)) : footprint
    ? await getFieldProjectionState(db, context.workspace_id, footprint.entityId, footprint.fieldNames)
    : interactionFootprint
      ? await getInteractionProjectionState(db, context.workspace_id, interactionFootprint.rootId)
      : logFootprint
        ? await getLogEventProjectionState(
          db,
          context.workspace_id,
          logFootprint.entityId,
          logFootprint.kind,
        )
        : await recordsTargetedState(db, context.workspace_id, handler as CommandHandler<unknown>, args));
  // Only known handlers can opt out of lifecycle hydration. Unknown/custom
  // handlers (including the Undo closure) always receive the complete state.
  const registeredHandler = Object.values(DEFAULT_COMMAND_HANDLERS).includes(handler);
  let currentState = targeted?.state ?? (await getWorkspaceProjectionState(db, context.workspace_id, {
    includeInteractions: !registeredHandler,
  }));
  if (!targeted && handler === (handleDeleteEntity as AnyCommandHandler)) {
    const entityId = (args as { entity_id?: unknown } | null)?.entity_id;
    if (typeof entityId === 'string') {
      currentState.interactions = await getEntityInteractions(db, context.workspace_id, entityId);
      try { await hydrateBusinessDetails(db, context.workspace_id, currentState, [entityId]); }
      catch (error) { if (!String(error).includes('no such table')) throw error; }
      if (currentState.redirects?.size) currentState = await getWorkspaceProjectionState(db, context.workspace_id);
    }
  }
  if (footprint?.fieldNames.includes('phone') && !currentState.contacts) {
    try { await hydrateBusinessDetails(db, context.workspace_id, currentState, [footprint.entityId], ['entity_contacts']); }
    catch (error) { if (!String(error).includes('no such table')) throw error; }
  }
  const coverage: ProjectionCoverage = targeted?.coverage ?? FULL_PROJECTION_COVERAGE;
  const forwardedEntity = footprint?.entityId ?? logFootprint?.entityId ?? [...currentState.interactions.values()].find(i => i.root_event_id === interactionFootprint?.rootId)?.entity_id;
  if (targeted && !businessIds && forwardedEntity) await expandCanonicalProjectionState(db, context.workspace_id, currentState, coverage, forwardedEntity,
    footprint?.fieldNames ?? (logFootprint?.kind === 'quote' || [...currentState.interactions.values()].some(i => i.root_event_id === interactionFootprint?.rootId && i.kind === 'quote') ? ['quote'] : []));
  const beforeSnapshot = snapshotProjections(currentState);
  const beforeMemoryFlags = snapMemoryFlags(currentState);
  const beforeBusiness: LedgerProjectionState = { ...currentState,
    contacts: currentState.contacts && new Map([...currentState.contacts].map(([id, row]) => [id, { ...row }])),
    redirects: currentState.redirects && new Map([...currentState.redirects].map(([id, row]) => [id, { ...row }])),
    attachmentLinks: currentState.attachmentLinks && new Map([...currentState.attachmentLinks].map(([id, row]) => [id, { ...row }])),
    mediaAnnotations: currentState.mediaAnnotations && new Map([...currentState.mediaAnnotations].map(([id, row]) => [id, { ...row }])),
    reminderRules: currentState.reminderRules && new Map([...currentState.reminderRules].map(([id, row]) => [id, { ...row }])),
    recordsLists: currentState.recordsLists && new Map([...currentState.recordsLists].map(([id, row]) => [id, { ...row }])),
    recordsListColumns: currentState.recordsListColumns && new Map([...currentState.recordsListColumns].map(([id, row]) => [id, { ...row }])),
    recordsRows: currentState.recordsRows && new Map([...currentState.recordsRows].map(([id, row]) => [id, { ...row }])),
    recordsValues: currentState.recordsValues && new Map([...currentState.recordsValues].map(([id, row]) => [id, { ...row }])),
    fieldDefinitions: currentState.fieldDefinitions && new Map([...currentState.fieldDefinitions].map(([id, row]) => [id, { ...row }])),
  };
  const nextSeq = wsMeta.last_event_sequence + 1;
  const { result, events, nextState, actionCost } = handler(resolvedContext, currentState, nextSeq, args);
  if (nextState) for (const event of events) reduceBusinessDetails(nextState, event);
  const batchCost = Number.isInteger(actionCost) && (actionCost as number) >= 0 ? (actionCost as number) : 1;

  // Targeted loads must stay inside their footprint: anything outside the
  // loaded keys rejects before any commit.
  if (targeted) {
    const violations = coverageViolations(beforeSnapshot, nextState, coverage);
    if (violations.length > 0) {
      return {
        status: 'rejected',
        action_id: context.action_id,
        error: {
          code: 'coverage_violation',
          message: `Field handler mutated state outside its loaded footprint: ${violations.slice(0, 3).join('; ')}.`,
        },
      };
    }
  }

  // 6. Handle needs_clarification: durably persist action receipt and pending clarification in D1
  if (result.status === 'needs_clarification') {
    const clarStatements: D1PreparedStatement[] = [];
    const guardId = `guard_${crypto.randomUUID()}`;
    const receiptId = `rcpt_${crypto.randomUUID()}`;

    // Construct versioned, typed pending operation payload with original validated args.
    // A handler may narrow it (the field batch stores only the uncertain
    // status operation, never already-saved fields); anything else keeps the
    // whole-request form. The revision always comes from this transaction.
    const providedOp = result.clarification?.pending_operation;
    const pendingOperation: PendingOperationPayload =
      providedOp && providedOp.version === 1 && typeof providedOp.command_name === 'string' && providedOp.args && typeof providedOp.args === 'object'
        ? { ...providedOp, source_revision: wsMeta.business_revision }
        : {
            version: 1,
            command_name: commandName,
            action_id: context.action_id,
            args: (args || {}) as Record<string, unknown>,
            missing_fields: result.clarification?.missing_fields || [],
            candidates: result.clarification?.candidates,
            source_revision: wsMeta.business_revision,
          };

    if (result.clarification) {
      result.clarification.pending_operation = pendingOperation;
    }

    // Step 0: Guard. Question-only commits charge no business effects
    // (no revision, no quota increment), so they never consume capacity.
    clarStatements.push(createGuardStatement(db, guardId, resolvedContext, 0));

    // Step 1: Action Receipt for clarification (stores pending_operation in result_json)
    clarStatements.push(
      db
        .prepare(
          `INSERT INTO action_receipts (
             id, workspace_id, action_id, payload_hash, command_name, result_status, result_json,
             actor_kind, actor_user_id, source_message_id, source_job_id, run_id, step_id,
             committed_revision, created_at
           ) VALUES (?, ?, ?, ?, ?, 'needs_clarification', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          receiptId,
          context.workspace_id,
          context.action_id,
          payloadHash,
          commandName,
          JSON.stringify({ ...result, pending_operation: pendingOperation }),
          context.actor.kind,
          context.actor.user_id || null,
          context.source_message_id || null,
          context.source_job_id || null,
          context.run_id || null,
          context.step_id || null,
          wsMeta.business_revision,
          now,
        )
    );

    // Step 2: If in run context with chat and member source, persist pending_clarifications.
    // The run transition stays deferred for active dispatch turns (single
    // owner): the dispatcher completes waiting via waitForInput, which skips
    // duplicate clarification/activity when it sees the pending row.
    if (context.run_id && effectiveChatId && context.source_message_id && context.actor.user_id) {
      clarStatements.push(
        ...pendingQuestionStatements(db, {
          workspaceId: context.workspace_id,
          runId: context.run_id,
          chatId: effectiveChatId,
          sourceMessageId: context.source_message_id,
          requesterUserId: context.actor.user_id,
          question: result.clarification?.prompt || result.summary || 'Clarification required',
          intendedOperation: pendingOperation.command_name,
          missingFields: result.clarification?.missing_fields || [],
          candidates: result.clarification?.candidates,
          pendingOperation,
          sourceRevision: wsMeta.business_revision,
          now,
          deferRunTransition: options?.deferRunTransition ?? false,
        }),
      );
    }

    try {
      await db.batch(clarStatements);
      return result;
    } catch (err) {
      return handleBatchError(err, db, resolvedContext, 0);
    }
  }

  // No-effect successes still pin the logical action and its immutable payload.
  // Otherwise an identical edit could later reuse its ID to write different facts.
  if (result.status === 'already_applied' && events.length === 0) {
    const noEffectResult = { ...result, action_id: context.action_id, committed_revision: wsMeta.business_revision };
    const guardId = `guard_${crypto.randomUUID()}`;
    const statements: D1PreparedStatement[] = [];
    if (options?.extrasBeforeGuard && extraStatements?.length) statements.push(...extraStatements);
    statements.push(createGuardStatement(db, guardId, resolvedContext, 0));
    if (!options?.extrasBeforeGuard && extraStatements?.length) statements.push(...extraStatements);
    statements.push(db.prepare(
      `INSERT INTO action_receipts (
         id, workspace_id, action_id, payload_hash, command_name, result_status, result_json,
         actor_kind, actor_user_id, source_message_id, source_job_id, run_id, step_id,
         committed_revision, created_at
       ) VALUES (?, ?, ?, ?, ?, 'already_applied', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      `rcpt_${crypto.randomUUID()}`, context.workspace_id, context.action_id, payloadHash, commandName,
      JSON.stringify(noEffectResult), context.actor.kind, context.actor.user_id || null,
      context.source_message_id || null, context.source_job_id || null, context.run_id || null,
      context.step_id || null, wsMeta.business_revision, now,
    ));
    statements.push(db.prepare('DELETE FROM ledger_guards WHERE id = ?').bind(guardId));
    try {
      await db.batch(statements);
      return noEffectResult;
    } catch (err) {
      return handleBatchError(err, db, resolvedContext, 0);
    }
  }

  // 7. Rejections/conflicts without mutations return immediately.
  if (result.status !== 'applied' || events.length === 0 || !nextState) {
    return result;
  }

  // 8. Construct Single Atomic D1 Batch:
  // Step 0: Transaction guard (membership, source ownership, expected revision, fence, run, step)
  // Step 1: Delete projected rows absent from nextState (preserves "projection equals replay")
  // Step 2: Upsert entities projection (before events to satisfy FK)
  // Step 3: Insert append-only events
  // Step 4: Insert action receipt
  // Step 5: Increment workspace business_revision & last_event_sequence
  // Step 6: Upsert remaining projected tables (aliases, fields, tasks, drafts)
  // Step 7: Advance chat cursor and insert public run_activity (if in run context)

  const statements: D1PreparedStatement[] = [];
  const guardId = `guard_${crypto.randomUUID()}`;
  const receiptId = `rcpt_${crypto.randomUUID()}`;
  const committedRevision = wsMeta.business_revision + 1;
  const newLastEventSequence = wsMeta.last_event_sequence + events.length;

  // Step 0a: Optional pre-guard extras, inside the same atomic batch. The
  // composed Telegram undo places the accepted source receipt here so the
  // guard below can validate it; a guard failure still rolls the whole
  // batch back.
  if (options?.extrasBeforeGuard && extraStatements && extraStatements.length > 0) {
    statements.push(...extraStatements);
  }

  // Step 0b: Transaction guard (membership, source ownership, expected
  // revision, fence, run, step)
  statements.push(createGuardStatement(db, guardId, resolvedContext, batchCost));

  // Step 0c: Remaining extras (e.g., resolving pending clarifications) stay
  // after the guard unless the caller explicitly opted into pre-guard order.
  if (!options?.extrasBeforeGuard && extraStatements && extraStatements.length > 0) {
    statements.push(...extraStatements);
  }

  // Changed-only projection diffs against the pre-handler snapshot.
  // Created/changed keys drive upserts; deleted keys drive deletes by prior
  // keys; unchanged records emit nothing. Loop order below is untouched, so
  // foreign-key order (entities before events/children, children before
  // parents on delete) is preserved exactly.
  const entityDiff = diffSnapshots(beforeSnapshot.entities.records, nextState.entities, fpEntity);
  const aliasDiff = diffSnapshots(beforeSnapshot.aliases.records, nextState.aliases, fpAlias);
  const fieldDiff = diffSnapshots(beforeSnapshot.fields.records, nextState.fields, fpField);
  const interactionDiff = diffSnapshots(beforeSnapshot.interactions.records, nextState.interactions, fpInteraction);
  const taskDiff = diffSnapshots(beforeSnapshot.tasks.records, nextState.tasks, fpTask);
  const draftDiff = diffSnapshots(beforeSnapshot.drafts.records, nextState.drafts, fpDraft);
  const memoryDiff = diffSnapshots(beforeSnapshot.memoryEntries.records, nextState.memoryEntries, fpMemory);
  const suppressionDiff = diffSnapshots(
    beforeSnapshot.memorySuppressions.records,
    nextState.memorySuppressions,
    fpSuppression,
  );

  // Step 1: Projection synchronization - DELETIONS (children deleted before parents for FK safety)
  // Delete drafts missing from nextState
  for (const draftId of draftDiff.deleted) {
    const prior = beforeSnapshot.drafts.records.get(draftId);
    if (!prior) continue;
    statements.push(
      db.prepare(`DELETE FROM draft_projections WHERE workspace_id = ? AND id = ?`).bind(...prior.del)
    );
  }

  // Delete tasks missing from nextState
  for (const taskId of taskDiff.deleted) {
    const prior = beforeSnapshot.tasks.records.get(taskId);
    if (!prior) continue;
    statements.push(
      db.prepare(`DELETE FROM tasks WHERE workspace_id = ? AND id = ?`).bind(...prior.del)
    );
  }

  // Delete fields missing from nextState
  for (const key of fieldDiff.deleted) {
    const prior = beforeSnapshot.fields.records.get(key);
    if (!prior) continue;
    statements.push(
      db
        .prepare(`DELETE FROM entity_state WHERE workspace_id = ? AND entity_id = ? AND field_name = ?`)
        .bind(...prior.del)
    );
  }

  // Delete interaction rows missing from nextState (entity deletion drops
  // the whole lifecycle; history stays in events for replay/audit).
  for (const key of interactionDiff.deleted) {
    const prior = beforeSnapshot.interactions.records.get(key);
    if (!prior) continue;
    statements.push(
      db
        .prepare(`DELETE FROM interaction_state WHERE workspace_id = ? AND root_event_id = ?`)
        .bind(...prior.del)
    );
  }

  // Delete aliases missing from nextState
  for (const key of aliasDiff.deleted) {
    const prior = beforeSnapshot.aliases.records.get(key);
    if (!prior) continue;
    statements.push(
      db
        .prepare(`DELETE FROM entity_aliases WHERE workspace_id = ? AND entity_id = ? AND alias = ?`)
        .bind(...prior.del)
    );
  }

  // Delete entities missing from nextState
  for (const entityId of entityDiff.deleted) {
    const prior = beforeSnapshot.entities.records.get(entityId);
    if (!prior) continue;
    statements.push(
      db.prepare(`DELETE FROM entities WHERE workspace_id = ? AND id = ?`).bind(...prior.del)
    );
  }

  // Delete memory entries missing from nextState
  for (const memId of memoryDiff.deleted) {
    const prior = beforeSnapshot.memoryEntries.records.get(memId);
    const flags = beforeMemoryFlags.get(memId);
    if (!prior || !flags) continue;
    statements.push(
      db.prepare(`DELETE FROM memory_entries WHERE workspace_id = ? AND id = ?`).bind(context.workspace_id, memId),
      db.prepare(`DELETE FROM memory_entries_fts WHERE entry_id = ?`).bind(memId)
    );
    const subjectKey = flags.subject_id || '__workspace__';
    const jobId = `job_${crypto.randomUUID()}`;
    statements.push(
      db
        .prepare(
          `INSERT INTO memory_refresh_jobs (
             id, workspace_id, scope, subject_key, target_revision, state, attempts,
             next_attempt_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
           ON CONFLICT(workspace_id, scope, subject_key, target_revision) DO UPDATE SET
             state = 'pending',
             updated_at = excluded.updated_at`
        )
        .bind(
          jobId,
          context.workspace_id,
          flags.scope,
          subjectKey,
          committedRevision,
          now,
          now,
          now,
        )
    );
  }

  // Delete memory suppressions missing from nextState
  for (const supId of suppressionDiff.deleted) {
    const prior = beforeSnapshot.memorySuppressions.records.get(supId);
    if (!prior) continue;
    statements.push(
      db.prepare(`DELETE FROM memory_suppressions WHERE workspace_id = ? AND id = ?`).bind(...prior.del)
    );
  }

  // Step 2: Entities projection upserts — only created or value-changed rows.
  // New and changed keys preserve next-state order; a changed or new entity
  // still precedes events and child inserts exactly as before.
  for (const key of [...entityDiff.created, ...entityDiff.changed]) {
    const entity = nextState.entities.get(key);
    if (!entity) continue;
    statements.push(
      db
        .prepare(
          `INSERT INTO entities (id, workspace_id, name, kind, status, assigned_user_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             kind = excluded.kind,
             status = excluded.status,
             assigned_user_id = excluded.assigned_user_id,
             updated_at = excluded.updated_at`
        )
        .bind(
          entity.id,
          entity.workspace_id,
          entity.name,
          entity.kind,
          entity.status,
          entity.assigned_user_id || null,
          entity.created_at,
          entity.updated_at,
        )
    );
  }

  // Step 3: Insert append-only events
  for (const evt of events) {
    statements.push(
      db
        .prepare(
          `INSERT INTO events (
             id, workspace_id, sequence, entity_id, actor_kind, actor_user_id, actor_job_id,
             kind, schema_version, payload_json, occurred_at, recorded_at, channel,
             source_message_id, source_job_id, action_id, supersedes_event_id, reverts_event_id,
             provenance, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          evt.id,
          evt.workspace_id,
          evt.sequence,
          evt.entity_id || null,
          evt.actor_kind,
          evt.actor_user_id || null,
          evt.actor_job_id || null,
          evt.kind,
          evt.schema_version,
          JSON.stringify(evt.payload),
          evt.occurred_at,
          evt.recorded_at,
          evt.channel,
          evt.source_message_id || null,
          evt.source_job_id || null,
          evt.action_id,
          evt.supersedes_event_id || null,
          evt.reverts_event_id || null,
          evt.provenance,
          evt.created_at,
        )
    );
  }

  // Final Result shape
  const finalResult: CommandResult = {
    ...result,
    committed_revision: committedRevision,
  };

  statements.push(...businessDetailStatements(db, beforeBusiness, nextState));
  statements.push(...recordsDetailStatements(db, beforeBusiness, nextState));
  const reminderEntities = new Set(events.filter(e => ['quote', 'contact', 'visit', 'message_sent_by_member', 'interaction_removed', 'entity_merged', 'revert'].includes(e.kind) && e.entity_id).map(e => e.entity_id!));
  for (const entityId of reminderEntities) statements.push(db.prepare(`${ENTITY_FAMILY_SQL} UPDATE reminder_rule_cursors SET dirty = 1
    WHERE rule_id IN (SELECT id FROM reminder_rules WHERE workspace_id = ? AND entity_id IN (SELECT id FROM family) AND status = 'active' AND json_extract(spec_json, '$.kind') = 'after_quote') AND dirty = 0`).bind(...familyBinds(context.workspace_id, entityId), context.workspace_id));

  // Step 4: Insert action receipt
  statements.push(
    db
      .prepare(
        `INSERT INTO action_receipts (
           id, workspace_id, action_id, payload_hash, command_name, result_status, result_json,
           actor_kind, actor_user_id, source_message_id, source_job_id, run_id, step_id,
           committed_revision, created_at
         ) VALUES (?, ?, ?, ?, ?, 'applied', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        receiptId,
        context.workspace_id,
        context.action_id,
        payloadHash,
        commandName,
        JSON.stringify(finalResult),
        context.actor.kind,
        context.actor.user_id || null,
        context.source_message_id || null,
        context.source_job_id || null,
        context.run_id || null,
        context.step_id || null,
        committedRevision,
        now,
      )
  );

  // Step 4b: Atomic daily actions quota tracking (UTC-day scope).
  // A batch charges its trusted ready-mutation cost once, not once per
  // fact; question-only and replayed writes charge nothing here.
  const todayUtc = now.slice(0, 10);
  statements.push(
    db
      .prepare(
        `INSERT INTO workspace_daily_actions (workspace_id, date_utc, action_count, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id, date_utc) DO UPDATE SET
           action_count = action_count + ?,
           updated_at = excluded.updated_at`
      )
      .bind(context.workspace_id, todayUtc, batchCost, now, batchCost)
  );

  // Step 5: Increment workspace revision and sequence
  statements.push(
    db
      .prepare(
        `UPDATE workspaces
         SET business_revision = business_revision + 1,
             last_event_sequence = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .bind(newLastEventSequence, now, context.workspace_id)
  );

  // Step 6: Upsert remaining projected tables (aliases, fields, interactions, tasks, drafts)
  // Aliases are immutable once created: only keys absent from the snapshot
  // emit anything at all (never a blanket INSERT OR IGNORE per alias).
  for (const key of [...aliasDiff.created, ...aliasDiff.changed]) {
    const alias = nextState.aliases.get(key);
    if (!alias) continue;
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO entity_aliases (id, workspace_id, entity_id, alias, source_event_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(
          alias.id,
          alias.workspace_id,
          alias.entity_id,
          alias.alias,
          alias.source_event_id || null,
          alias.created_at,
        )
    );
  }

  // Fields — only created or value-changed rows.
  for (const key of [...fieldDiff.created, ...fieldDiff.changed]) {
    const field = nextState.fields.get(key);
    if (!field) continue;
    statements.push(
      db
        .prepare(
          `INSERT INTO entity_state (
             id, workspace_id, entity_id, field_name, state, value_text, value_json,
             provenance, source_event_id, candidate_event_ids_json, last_confirmed_value_text,
             last_confirmed_value_json, revision, updated_at, quote_authority_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(workspace_id, entity_id, field_name) DO UPDATE SET
             state = excluded.state,
             value_text = excluded.value_text,
             value_json = excluded.value_json,
             provenance = excluded.provenance,
             source_event_id = excluded.source_event_id,
             candidate_event_ids_json = excluded.candidate_event_ids_json,
             last_confirmed_value_text = excluded.last_confirmed_value_text,
             last_confirmed_value_json = excluded.last_confirmed_value_json,
             revision = excluded.revision,
             updated_at = excluded.updated_at,
             quote_authority_json = excluded.quote_authority_json`
        )
        .bind(
          field.id,
          field.workspace_id,
          field.entity_id,
          field.field_name,
          field.state,
          field.value_text || null,
          field.value_json || null,
          field.provenance,
          field.source_event_id || null,
          field.candidate_event_ids ? JSON.stringify(field.candidate_event_ids) : null,
          field.last_confirmed_value_text || null,
          field.last_confirmed_value_json || null,
          field.revision,
          field.updated_at,
          field.quote_authority_json ?? null,
        )
    );
  }

  // Interactions — only created or value-changed rows. New and changed
  // roots preserve next-state order; they carry no FK into events, so they
  // commit alongside the other child projections after the event inserts.
  for (const key of [...interactionDiff.created, ...interactionDiff.changed]) {
    const row = nextState.interactions.get(key);
    if (!row) continue;
    statements.push(
      db
        .prepare(
          `INSERT INTO interaction_state (
             workspace_id, root_event_id, entity_id, kind, head_event_id,
             revision, state, occurred_at, sequence, updated_at, head_value_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(workspace_id, root_event_id) DO UPDATE SET
             entity_id = excluded.entity_id,
             kind = excluded.kind,
             head_event_id = excluded.head_event_id,
             revision = excluded.revision,
             state = excluded.state,
             occurred_at = excluded.occurred_at,
             sequence = excluded.sequence,
             updated_at = excluded.updated_at,
             head_value_json = excluded.head_value_json`
        )
        .bind(
          row.workspace_id,
          row.root_event_id,
          row.entity_id || null,
          row.kind,
          row.head_event_id,
          row.revision,
          row.state,
          row.occurred_at,
          row.sequence,
          row.updated_at,
          row.head_value_json || null,
        )
    );
  }

  // Tasks — only created or value-changed rows.
  for (const key of [...taskDiff.created, ...taskDiff.changed]) {
    const task = nextState.tasks.get(key);
    if (!task) continue;
    statements.push(
      db
        .prepare(
          `INSERT INTO tasks (
             id, workspace_id, entity_id, title, assignee_user_id, status, due_kind,
             due_local_date, due_instant, due_timezone, snooze_until, explicit_no_deadline,
             is_promise, source_event_id, revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             assignee_user_id = excluded.assignee_user_id,
             status = excluded.status,
             due_kind = excluded.due_kind,
             due_local_date = excluded.due_local_date,
             due_instant = excluded.due_instant,
             due_timezone = excluded.due_timezone,
             snooze_until = excluded.snooze_until,
             explicit_no_deadline = excluded.explicit_no_deadline,
             is_promise = excluded.is_promise,
             revision = excluded.revision,
             updated_at = excluded.updated_at`
        )
        .bind(
          task.id,
          task.workspace_id,
          task.entity_id || null,
          task.title,
          task.assignee_user_id || null,
          task.status,
          task.due_kind || null,
          task.due_local_date || null,
          task.due_instant || null,
          task.due_timezone || null,
          task.snooze_until || null,
          task.explicit_no_deadline ? 1 : 0,
          task.is_promise ? 1 : 0,
          task.source_event_id,
          task.revision,
          task.created_at,
          task.updated_at,
        )
    );
  }

  // Drafts — only created or value-changed rows.
  for (const key of [...draftDiff.created, ...draftDiff.changed]) {
    const draft = nextState.drafts.get(key);
    if (!draft) continue;
    statements.push(
      db
        .prepare(
          `INSERT INTO draft_projections (
             id, workspace_id, entity_id, channel, recipient_address, content_text,
             status, source_event_id, revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             channel = excluded.channel,
             recipient_address = excluded.recipient_address,
             content_text = excluded.content_text,
             status = excluded.status,
             revision = excluded.revision,
             updated_at = excluded.updated_at`
        )
        .bind(
          draft.id,
          draft.workspace_id,
          draft.entity_id || null,
          draft.channel,
          draft.recipient_address || null,
          draft.content_text,
          draft.status,
          draft.source_event_id,
          draft.revision,
          draft.created_at,
          draft.updated_at,
        )
    );
  }

  // Memory Entries, Suppressions, FTS, and Refresh Jobs (if memory events were emitted)
  const hasMemoryEvents = events.some((e) => e.kind === 'memory_note' || e.kind === 'memory_forgotten' || e.kind === 'revert');
  if (hasMemoryEvents) {
    // Memory entries — only created or value-changed rows.
    for (const key of [...memoryDiff.created, ...memoryDiff.changed]) {
      const mem = nextState.memoryEntries.get(key);
      if (!mem) continue;
      statements.push(
        db
          .prepare(
            `INSERT INTO memory_entries (
               id, workspace_id, scope, subject_id, category, content, status, provenance,
               source_event_id, source_message_id, author_user_id, observed_at, created_at,
               superseding_event_id, business_revision
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               status = excluded.status,
               superseding_event_id = excluded.superseding_event_id,
               business_revision = excluded.business_revision`
          )
          .bind(
            mem.id,
            mem.workspace_id,
            mem.scope,
            mem.subject_id || null,
            mem.category,
            mem.content,
            mem.status,
            mem.provenance,
            mem.source_event_id || null,
            mem.source_message_id || null,
            mem.author_user_id || null,
            mem.observed_at,
            mem.created_at,
            mem.superseding_event_id || null,
            mem.business_revision,
          )
      );
    }

    // Suppressions are append-only: only keys absent from the snapshot are
    // inserted (still OR IGNORE for race safety). Unchanged suppressions
    // emit nothing.
    for (const key of suppressionDiff.created) {
      const sup = nextState.memorySuppressions.get(key);
      if (!sup) continue;
      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO memory_suppressions (
               id, workspace_id, target_memory_id, source_event_id, source_message_id,
               suppression_event_id, revision, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            sup.id,
            sup.workspace_id,
            sup.target_memory_id,
            sup.source_event_id || null,
            sup.source_message_id || null,
            sup.suppression_event_id,
            sup.revision,
            sup.created_at,
          )
      );
    }

    // FTS maintenance & refresh jobs: reconcile active notes to memory_entries_fts and schedule refresh jobs
    const scheduledRefreshKeys = new Set<string>();

    // FTS follows committed status/content compared against the pre-handler
    // flags — never post-handler objects. A new active row still syncs FTS
    // (DELETE is a harmless no-op plus the required INSERT); an unchanged
    // active row syncs nothing; any inactive row drops FTS only when a prior
    // row could have had one.
    for (const mem of nextState.memoryEntries.values()) {
      const prior = beforeMemoryFlags.get(mem.id);
      if (mem.status === 'active') {
        if (!prior || prior.status !== 'active' || prior.content !== mem.content) {
          statements.push(
            db.prepare(`DELETE FROM memory_entries_fts WHERE entry_id = ?`).bind(mem.id),
            db.prepare(`INSERT INTO memory_entries_fts (entry_id, content) VALUES (?, ?)`).bind(mem.id, mem.content),
          );
        }
      } else if (prior && prior.status === 'active') {
        // Only the active-to-inactive transition drops FTS: an unchanged
        // inactive row already has no FTS row, and a brand-new inactive row
        // never created one. Entry deletions always drop FTS on their own path.
        statements.push(
          db.prepare(`DELETE FROM memory_entries_fts WHERE entry_id = ?`).bind(mem.id),
        );
      }

      // Refresh scheduling keeps its exact prior semantics (status or
      // content changed, or brand new), evaluated against the snapshot.
      if (!prior || prior.status !== mem.status || prior.content !== mem.content) {
        const subjectKey = mem.subject_id || '__workspace__';
        const refreshKey = `${mem.scope}::${subjectKey}`;
        if (!scheduledRefreshKeys.has(refreshKey)) {
          scheduledRefreshKeys.add(refreshKey);
          const jobId = `job_${crypto.randomUUID()}`;
          statements.push(
            db
              .prepare(
                `INSERT INTO memory_refresh_jobs (
                   id, workspace_id, scope, subject_key, target_revision, state, attempts,
                   next_attempt_at, created_at, updated_at
                 ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
                 ON CONFLICT(workspace_id, scope, subject_key, target_revision) DO UPDATE SET
                   state = 'pending',
                   updated_at = excluded.updated_at`
              )
              .bind(
                jobId,
                context.workspace_id,
                mem.scope,
                subjectKey,
                committedRevision,
                now,
                now,
                now,
              )
          );
        }
      }
    }
  }

  // Step 7: Advance chat activity cursor and record public activity (if running in chat context)
  if (context.run_id && effectiveChatId) {
    const actId = `act_${crypto.randomUUID()}`;
    statements.push(
      db
        .prepare(
          `UPDATE chats
           SET activity_cursor = activity_cursor + 1,
               updated_at = ?,
               last_activity_at = ?
           WHERE id = ?`
        )
        .bind(now, now, effectiveChatId)
    );

    statements.push(
      db
        .prepare(
          `INSERT INTO run_activity (id, workspace_id, chat_id, run_id, cursor, type, payload_json, created_at)
           VALUES (
             ?, ?, ?, ?,
             (SELECT activity_cursor FROM chats WHERE id = ?),
             'action_applied',
             ?,
             ?
           )`
        )
        .bind(
          actId,
          context.workspace_id,
          effectiveChatId,
          context.run_id,
          effectiveChatId,
          JSON.stringify({
            action_id: context.action_id,
            command_name: commandName,
            summary: result.summary,
            event_ids: events.map((e) => e.id),
          }),
          now,
        )
    );
  }

  // Step 8: Undo cancels the unresolved intent of its reverted actions in
  // the same transaction, so a later answer cannot resurrect reverted work.
  const revertedIds = (result.data as { reverted_action_ids?: unknown } | undefined)?.reverted_action_ids;
  if (Array.isArray(revertedIds) && revertedIds.length > 0) {
    statements.push(
      ...revertedIntentCancelStatements(
        db,
        context.workspace_id,
        revertedIds.filter((id): id is string => typeof id === 'string'),
        now,
      ),
    );
  }

  // Step 9: A mixed commit persists its attached pending question alongside
  // the saved facts. The revision is post-commit; the actor parks on the row
  // and skips its own duplicate via waitForInput.
  const attachedOp = finalResult.clarification?.pending_operation;
  if (
    attachedOp &&
    attachedOp.version === 1 &&
    context.run_id &&
    effectiveChatId &&
    context.source_message_id &&
    context.actor.user_id
  ) {
    statements.push(
      ...pendingQuestionStatements(db, {
        workspaceId: context.workspace_id,
        runId: context.run_id,
        chatId: effectiveChatId,
        sourceMessageId: context.source_message_id,
        requesterUserId: context.actor.user_id,
        question:
          finalResult.clarification?.prompt || finalResult.summary || 'Clarification required',
        intendedOperation: attachedOp.command_name,
        missingFields: finalResult.clarification?.missing_fields || [],
        candidates: finalResult.clarification?.candidates,
        pendingOperation: { ...attachedOp, source_revision: committedRevision },
        sourceRevision: committedRevision,
        now,
        deferRunTransition: true,
      }),
    );
  }

  // 9. Execute atomic batch
  try {
    await db.batch(statements);
    return finalResult;
  } catch (err) {
    return handleBatchError(err, db, resolvedContext, batchCost);
  }
}

export interface ResumeClarificationOptions {
  clarification_id: string;
  resolved_fields: Record<string, unknown>;
  resolution_response?: string;
  /**
   * In-memory normalized operation (e.g. a legacy fallback intent approved
   * by this answer). The row sync commits inside the same atomic batch as
   * the effects — normalization never persists ahead of the guarded
   * transaction, so a rolled-back approval cannot arm a later answer.
   */
  normalizedOperation?: PendingOperationPayload;
  normalizedMissingFields?: string[];
  /** Resolve the question normally, or cancel it (decline that still saves). */
  questionDisposition?: 'resolved' | 'cancelled';
}

/**
 * Resumes a pending clarification by recovering the versioned, typed original operation payload,
 * merging it with the member's clarification answer, and executing the command atomically.
 * Resolves the pending clarification record and unblocks the run in the exact same transaction.
 */
export async function resumePendingClarification(
  db: D1Database,
  context: LedgerCommandContext,
  options: ResumeClarificationOptions,
  handlerRegistry?: Record<string, AnyCommandHandler>,
  extraStatements?: D1PreparedStatement[],
): Promise<CommandResult> {
  // 1. Fetch pending clarification
  const clar = await db
    .prepare(
      `SELECT id, workspace_id, chat_id, run_id, source_message_id, requester_user_id,
              question, intended_operation, missing_fields, candidates_json, operation_payload_json,
              source_revision, status
       FROM pending_clarifications
       WHERE id = ? AND workspace_id = ?`
    )
    .bind(options.clarification_id, context.workspace_id)
    .first<Record<string, unknown>>();

  if (!clar) {
    return {
      status: 'rejected',
      action_id: context.action_id,
      error: {
        code: 'not_found',
        message: `Pending clarification '${options.clarification_id}' not found in workspace '${context.workspace_id}'.`,
      },
    };
  }

  if (clar['status'] !== 'pending') {
    return {
      status: 'conflict',
      action_id: context.action_id,
      error: {
        code: 'already_resolved',
        message: `Clarification '${options.clarification_id}' status is '${clar['status']}', not 'pending'.`,
      },
    };
  }

  if (!clar['operation_payload_json']) {
    return {
      status: 'rejected',
      action_id: context.action_id,
      error: {
        code: 'corrupt_clarification',
        message: `Clarification '${options.clarification_id}' does not contain an operation payload.`,
      },
    };
  }

  let pendingOp: PendingOperationPayload;
  if (options.normalizedOperation) {
    // In-memory normalization replaces the stored operation for this
    // commit: validate the replacement here; the row sync inside the batch
    // persists it only together with the effects.
    const candidate = options.normalizedOperation;
    if (
      candidate.version !== 1 ||
      typeof candidate.command_name !== 'string' ||
      !candidate.args ||
      typeof candidate.args !== 'object'
    ) {
      return {
        status: 'rejected',
        action_id: context.action_id,
        error: { code: 'corrupt_clarification', message: 'Normalized operation payload is malformed.' },
      };
    }
    pendingOp = { ...candidate };
  } else {
    try {
      pendingOp = JSON.parse(String(clar['operation_payload_json'])) as PendingOperationPayload;
    } catch {
      return {
        status: 'rejected',
        action_id: context.action_id,
        error: {
          code: 'corrupt_clarification',
          message: `Clarification '${options.clarification_id}' has malformed operation payload JSON.`,
        },
      };
    }

    if (pendingOp.version !== 1) {
      return {
        status: 'rejected',
        action_id: context.action_id,
        error: {
          code: 'unsupported_version',
          message: `Unsupported pending operation payload version: ${pendingOp.version}`,
        },
      };
    }
  }

  // The row sync is conditional on still-pending, so a concurrent
  // resolution aborts the whole batch through the guard.
  let syncStatements: D1PreparedStatement[] = [];
  if (options.normalizedOperation) {
    pendingOp = { ...options.normalizedOperation };
    const nowSync = new Date().toISOString();
    syncStatements = [
      db
        .prepare(
          `UPDATE pending_clarifications
           SET operation_payload_json = ?, missing_fields = ?, updated_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .bind(
          JSON.stringify(pendingOp),
          JSON.stringify(options.normalizedMissingFields ?? []),
          nowSync,
          options.clarification_id,
        ),
    ];
  }

  // 2. Validate and bound resolved_fields against clarification's missing_fields
  let allowedMissingFields: string[] = [];
  if (options.normalizedOperation) {
    allowedMissingFields = [...(options.normalizedMissingFields ?? [])];
  } else if (clar['missing_fields']) {
    try {
      const parsed = JSON.parse(String(clar['missing_fields']));
      if (Array.isArray(parsed)) {
        allowedMissingFields = parsed.map(String);
      }
    } catch {
      allowedMissingFields = [];
    }
  }

  // 2b. Narrow status-answer normalization: a parked status question carries
  // the proposal in its stored args; the member's persisted answer only
  // selects it. Confirmation maps to the original value with stated
  // provenance, a decline cancels, and anything ambiguous rejects without
  // touching the row so the same question stays pending. Supplied
  // entity/field identity is never honored.
  const resolved: Record<string, unknown> = { ...(options.resolved_fields || {}) };
  let statusResumeValue: string | null = null;
  if (pendingOp.command_name === 'set_field') {
    for (const guarded of ['entity_id', 'field_name', 'action_id']) {
      if (resolved[guarded] !== undefined) {
        return {
          status: 'rejected',
          action_id: context.action_id,
          error: {
            code: 'unsolicited_field',
            message: `Field '${guarded}' cannot be supplied in a status answer.`,
          },
        };
      }
    }
    const storedArgs = (pendingOp.args ?? {}) as Record<string, unknown>;
    const answerKey =
      resolved['status_confirmation'] !== undefined
        ? 'status_confirmation'
        : resolved['status'] !== undefined
          ? 'status'
          : null;
    if (answerKey) {
      if (storedArgs['field_name'] !== 'status') {
        return {
          status: 'rejected',
          action_id: context.action_id,
          error: {
            code: 'answer_ambiguous',
            message: 'That answer does not match the parked status question. Reply confirm to apply it or cancel to drop it.',
          },
        };
      }
      const decision = normalizeStatusResumeAnswer(storedArgs['value'], resolved[answerKey]);
      if (decision.action === 'cancel') {
        return {
          status: 'rejected',
          action_id: context.action_id,
          error: {
            code: 'cancelled_by_member',
            message: `Status change declined; nothing changed.`,
          },
        };
      }
      if (decision.action === 'ambiguous') {
        return {
          status: 'rejected',
          action_id: context.action_id,
          error: { code: 'answer_ambiguous', message: decision.message },
        };
      }
      statusResumeValue = decision.value;
      delete resolved[answerKey];
      allowedMissingFields = allowedMissingFields.filter((f) => f !== answerKey);
    }
  }

  const allowedSet = new Set(allowedMissingFields);
  const resolvedKeys = Object.keys(resolved);

  // Reject unsolicited fields (e.g. attempting to overwrite title or entity_id)
  for (const key of resolvedKeys) {
    if (!allowedSet.has(key)) {
      return {
        status: 'rejected',
        action_id: context.action_id,
        error: {
          code: 'unsolicited_field',
          message: `Field '${key}' was not requested in clarification '${options.clarification_id}'. Allowed missing fields: [${allowedMissingFields.join(', ')}].`,
        },
      };
    }
  }

  // Reject if any required missing field is omitted
  for (const requiredField of allowedMissingFields) {
    if (resolved[requiredField] === undefined) {
      return {
        status: 'rejected',
        action_id: context.action_id,
        error: {
          code: 'missing_required_field',
          message: `Required field '${requiredField}' was not provided for clarification '${options.clarification_id}'.`,
        },
      };
    }
  }

  // Merge strictly bounded fields into original validated args
  if (pendingOp.command_name === 'merge_entities') {
    const decision = String(resolved['merge_identity'] ?? '').trim().toLowerCase();
    if (STATUS_DECLINE_WORDS.has(decision)) return { status: 'rejected', error: { code: 'cancelled_by_member', message: 'The files stay separate.' } };
    if (!STATUS_CONFIRM_WORDS.has(decision)) return { status: 'rejected', error: { code: 'answer_ambiguous', message: 'Confirm the same client, or cancel.' } };
    delete resolved['merge_identity'];
    allowedMissingFields = allowedMissingFields.filter(field => field !== 'merge_identity');
  }
  const mergedArgs: Record<string, unknown> = { ...pendingOp.args };
  for (const key of allowedMissingFields) {
    if (resolved[key] !== undefined) {
      mergedArgs[key] = resolved[key];
    }
  }
  if (statusResumeValue !== null) {
    mergedArgs['value'] = statusResumeValue;
    mergedArgs['provenance'] = 'stated';
  }

  // 3. Resuming clarification requires a source_message_id attributing the member answer
  if (!context.source_message_id) {
    return {
      status: 'rejected',
      action_id: context.action_id,
      error: {
        code: 'missing_source_message',
        message: `Resuming clarification '${options.clarification_id}' requires a source_message_id attributing the member's answer.`,
      },
    };
  }

  // 4. Resolve command handler
  const registry = handlerRegistry || DEFAULT_COMMAND_HANDLERS;
  const handler = registry[pendingOp.command_name];
  if (!handler) {
    return {
      status: 'rejected',
      action_id: context.action_id,
      error: {
        code: 'unsupported_command',
        message: `No handler registered for command '${pendingOp.command_name}'.`,
      },
    };
  }

  // 5. Construct atomic statements to resolve the clarification and unblock the run.
  // The row sync (when normalizing) commits here too: approval metadata,
  // answer resolution and effects land together or not at all.
  const now = new Date().toISOString();
  const disposition = options.questionDisposition ?? 'resolved';
  const resolveStmt = db
    .prepare(
      `UPDATE pending_clarifications
       SET status = ?,
           resolution_response = ?,
           resolved_at = ?,
           updated_at = ?
       WHERE id = ? AND status = 'pending'`
    )
    .bind(
      disposition,
      options.resolution_response || JSON.stringify(options.resolved_fields),
      now,
      now,
      options.clarification_id,
    );

  const batchStatements: D1PreparedStatement[] = [...syncStatements, resolveStmt];
  if (extraStatements && extraStatements.length > 0) {
    batchStatements.push(...extraStatements);
  }

  const effectiveRunId = context.run_id || (clar['run_id'] ? String(clar['run_id']) : undefined);
  if (effectiveRunId) {
    batchStatements.push(
      db
        .prepare(
          `UPDATE agent_runs
           SET status = 'queued',
               updated_at = ?
           WHERE id = ? AND workspace_id = ? AND status = 'waiting_for_input'`
        )
        .bind(now, effectiveRunId, context.workspace_id)
    );
  }

  const effectiveChatId = context.chat_id || (clar['chat_id'] ? String(clar['chat_id']) : undefined);

  const resumedContext: LedgerCommandContext = {
    ...context,
    run_id: effectiveRunId,
    chat_id: effectiveChatId,
    source_message_id: context.source_message_id,
    resuming_clarification_id: options.clarification_id,
  };

  // 6. Execute resumed command atomically with clarification resolution statements
  return await executeLedgerCommand(
    db,
    resumedContext,
    pendingOp.command_name,
    mergedArgs,
    handler,
    batchStatements,
  );
}
