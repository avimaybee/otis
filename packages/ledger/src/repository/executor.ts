/**
 * @otis/ledger/repository/executor
 * Transactional D1 execution boundary for ledger commands.
 * In accordance with architecture.md section 8 and plans/002-ledger.md.
 */

import type { CommandResult, LedgerEvent, PendingOperationPayload } from '@otis/contracts';
import type { LedgerCommandContext, LedgerProjectionState } from '../types.js';
import { getActionReceipt, getWorkspaceProjectionState, getWorkspaceRevision } from './queries.js';
import { handleCreateEntity } from '../commands/createEntity.js';
import { handleRenameEntity } from '../commands/renameEntity.js';
import { handleSetField } from '../commands/setField.js';
import { handleCreateTask, handleUpdateTask } from '../commands/tasks.js';
import { handleLogEvent } from '../commands/logEvent.js';
import { handleRecordDraft } from '../commands/recordDraft.js';
import { handleResolveConflict } from '../commands/resolveConflict.js';

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
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCommandHandler = CommandHandler<any>;

export const DEFAULT_COMMAND_HANDLERS: Record<string, AnyCommandHandler> = {
  create_entity: handleCreateEntity,
  rename_entity: handleRenameEntity,
  set_field: handleSetField,
  create_task: handleCreateTask,
  update_task: handleUpdateTask,
  log_event: handleLogEvent,
  record_draft: handleRecordDraft,
  resolve_conflict: handleResolveConflict,
};

/**
 * Creates the single transactional guard statement for the atomic D1 batch.
 * Guarantees that:
 * 1. Workspace revision matches expected business revision.
 * 2. Actor is an active workspace member (or system actor with matching job).
 * 3. Source message exists in this workspace, belongs to the acting member, and matches channel.
 * 4. System job exists in this workspace, matches actor system_job, and is active ('pending' | 'running').
 * 5. Execution fence matches workspace lease fence and lease is not expired.
 * 6. Agent run (if specified) exists in this workspace, is active ('queued' | 'running'), and matches source message/job.
 * 7. Run step (if specified) exists for this run.
 */
function createGuardStatement(
  db: D1Database,
  guardId: string,
  context: LedgerCommandContext,
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
            -- 4. Lease fence and expiration:
            AND (? IS NULL OR (
              w.lease_fence = ?
              AND (w.lease_expires_at IS NULL OR unixepoch(w.lease_expires_at) > unixepoch('now'))
            ))
            -- 5a. Ordinary run validation (if run_id provided and NOT resuming clarification):
            AND (? IS NOT NULL OR ? IS NULL OR EXISTS (
              SELECT 1 FROM agent_runs ar
              WHERE ar.id = ?
                AND ar.workspace_id = w.id
                AND ar.status IN ('queued', 'running')
                AND (? IS NULL OR ar.source_message_id = ?)
                AND (? IS NULL OR ar.source_job_id = ?)
                AND (? IS NULL OR ar.lease_fence = ?)
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
      context.source_job_id || null,
      context.source_job_id || '',
      context.fence !== undefined ? context.fence : null,
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
      (latestWs.lease_expires_at !== null &&
        new Date(latestWs.lease_expires_at).getTime() <= Date.now()))
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

export async function executeLedgerCommand<TArgs>(
  db: D1Database,
  context: LedgerCommandContext,
  commandName: string,
  args: TArgs,
  handler: CommandHandler<TArgs>,
  extraStatements?: D1PreparedStatement[],
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
  };

  // 5. Load current projection state and execute pure domain command
  const currentState = await getWorkspaceProjectionState(db, context.workspace_id);
  const nextSeq = wsMeta.last_event_sequence + 1;
  const { result, events, nextState } = handler(resolvedContext, currentState, nextSeq, args);

  // 6. Handle needs_clarification: durably persist action receipt and pending clarification in D1
  if (result.status === 'needs_clarification') {
    const clarStatements: D1PreparedStatement[] = [];
    const guardId = `guard_${crypto.randomUUID()}`;
    const receiptId = `rcpt_${crypto.randomUUID()}`;

    // Construct versioned, typed pending operation payload with original validated args
    const pendingOperation: PendingOperationPayload = {
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

    // Step 0: Guard
    clarStatements.push(createGuardStatement(db, guardId, resolvedContext));

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

    // Step 2: If in run context with chat and member source, persist pending_clarifications
    if (context.run_id && effectiveChatId && context.source_message_id && context.actor.user_id) {
      const clarId = `clar_${crypto.randomUUID()}`;
      clarStatements.push(
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
            context.workspace_id,
            effectiveChatId,
            context.run_id,
            context.source_message_id,
            context.actor.user_id,
            result.clarification?.prompt || result.summary || 'Clarification required',
            commandName,
            JSON.stringify(result.clarification?.missing_fields || []),
            result.clarification?.candidates ? JSON.stringify(result.clarification.candidates) : null,
            JSON.stringify(pendingOperation),
            wsMeta.business_revision,
            now,
            now,
          )
      );

      // Transition run status to waiting_for_input
      clarStatements.push(
        db
          .prepare(`UPDATE agent_runs SET status = 'waiting_for_input', updated_at = ? WHERE id = ? AND workspace_id = ?`)
          .bind(now, context.run_id, context.workspace_id)
      );

      // Advance chat cursor and record clarification_required activity
      const actId = `act_${crypto.randomUUID()}`;
      clarStatements.push(
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

      clarStatements.push(
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
            context.workspace_id,
            effectiveChatId,
            context.run_id,
            effectiveChatId,
            JSON.stringify({
              action_id: context.action_id,
              command_name: commandName,
              prompt: result.clarification?.prompt,
              missing_fields: result.clarification?.missing_fields,
              pending_operation: pendingOperation,
            }),
            now,
          )
      );
    }

    try {
      await db.batch(clarStatements);
      return result;
    } catch (err) {
      return handleBatchError(err, db, resolvedContext);
    }
  }

  // 7. If the command resulted in non-applied status (rejection/conflict) without mutations, return immediately
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

  // Step 0: Guard
  statements.push(createGuardStatement(db, guardId, resolvedContext));

  // Step 0b: Extra statements (e.g., resolving pending clarifications)
  if (extraStatements && extraStatements.length > 0) {
    statements.push(...extraStatements);
  }

  // Step 1: Projection synchronization - DELETIONS
  // Delete entities missing from nextState
  for (const entityId of currentState.entities.keys()) {
    if (!nextState.entities.has(entityId)) {
      statements.push(
        db.prepare(`DELETE FROM entities WHERE workspace_id = ? AND id = ?`).bind(context.workspace_id, entityId)
      );
    }
  }

  // Delete aliases missing from nextState
  for (const [key, alias] of currentState.aliases) {
    if (!nextState.aliases.has(key)) {
      statements.push(
        db
          .prepare(`DELETE FROM entity_aliases WHERE workspace_id = ? AND entity_id = ? AND alias = ?`)
          .bind(context.workspace_id, alias.entity_id, alias.alias)
      );
    }
  }

  // Delete fields missing from nextState
  for (const [key, field] of currentState.fields) {
    if (!nextState.fields.has(key)) {
      statements.push(
        db
          .prepare(`DELETE FROM entity_state WHERE workspace_id = ? AND entity_id = ? AND field_name = ?`)
          .bind(context.workspace_id, field.entity_id, field.field_name)
      );
    }
  }

  // Delete tasks missing from nextState
  for (const taskId of currentState.tasks.keys()) {
    if (!nextState.tasks.has(taskId)) {
      statements.push(
        db.prepare(`DELETE FROM tasks WHERE workspace_id = ? AND id = ?`).bind(context.workspace_id, taskId)
      );
    }
  }

  // Delete drafts missing from nextState
  for (const draftId of currentState.drafts.keys()) {
    if (!nextState.drafts.has(draftId)) {
      statements.push(
        db.prepare(`DELETE FROM draft_projections WHERE workspace_id = ? AND id = ?`).bind(context.workspace_id, draftId)
      );
    }
  }

  // Step 2: Entities projection upserts
  for (const entity of nextState.entities.values()) {
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

  // Step 6: Upsert remaining projected tables (Aliases, Fields, Tasks, Drafts)
  // Aliases
  for (const alias of nextState.aliases.values()) {
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

  // Fields
  for (const field of nextState.fields.values()) {
    statements.push(
      db
        .prepare(
          `INSERT INTO entity_state (
             id, workspace_id, entity_id, field_name, state, value_text, value_json,
             provenance, source_event_id, candidate_event_ids_json, last_confirmed_value_text,
             last_confirmed_value_json, revision, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
             updated_at = excluded.updated_at`
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
        )
    );
  }

  // Tasks
  for (const task of nextState.tasks.values()) {
    statements.push(
      db
        .prepare(
          `INSERT INTO tasks (
             id, workspace_id, entity_id, title, assignee_user_id, status, due_kind,
             due_local_date, due_instant, due_timezone, snooze_until, source_event_id,
             revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             assignee_user_id = excluded.assignee_user_id,
             status = excluded.status,
             due_kind = excluded.due_kind,
             due_local_date = excluded.due_local_date,
             due_instant = excluded.due_instant,
             due_timezone = excluded.due_timezone,
             snooze_until = excluded.snooze_until,
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
          task.source_event_id,
          task.revision,
          task.created_at,
          task.updated_at,
        )
    );
  }

  // Drafts
  for (const draft of nextState.drafts.values()) {
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

  // 9. Execute atomic batch
  try {
    await db.batch(statements);
    return finalResult;
  } catch (err) {
    return handleBatchError(err, db, resolvedContext);
  }
}

export interface ResumeClarificationOptions {
  clarification_id: string;
  resolved_fields: Record<string, unknown>;
  resolution_response?: string;
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

  // 2. Validate and bound resolved_fields against clarification's missing_fields
  let allowedMissingFields: string[] = [];
  if (clar['missing_fields']) {
    try {
      const parsed = JSON.parse(String(clar['missing_fields']));
      if (Array.isArray(parsed)) {
        allowedMissingFields = parsed.map(String);
      }
    } catch {
      allowedMissingFields = [];
    }
  }

  const allowedSet = new Set(allowedMissingFields);
  const resolvedKeys = Object.keys(options.resolved_fields || {});

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
    if (options.resolved_fields[requiredField] === undefined) {
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
  const mergedArgs: Record<string, unknown> = { ...pendingOp.args };
  for (const key of allowedMissingFields) {
    if (options.resolved_fields[key] !== undefined) {
      mergedArgs[key] = options.resolved_fields[key];
    }
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

  // 5. Construct atomic statements to resolve the clarification and unblock the run
  const now = new Date().toISOString();
  const resolveStmt = db
    .prepare(
      `UPDATE pending_clarifications
       SET status = 'resolved',
           resolution_response = ?,
           resolved_at = ?,
           updated_at = ?
       WHERE id = ? AND status = 'pending'`
    )
    .bind(
      options.resolution_response || JSON.stringify(options.resolved_fields),
      now,
      now,
      options.clarification_id,
    );

  const extraStatements: D1PreparedStatement[] = [resolveStmt];

  const effectiveRunId = context.run_id || (clar['run_id'] ? String(clar['run_id']) : undefined);
  if (effectiveRunId) {
    extraStatements.push(
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
    extraStatements,
  );
}
