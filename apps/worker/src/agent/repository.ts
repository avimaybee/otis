/**
 * @otis/worker/agent/repository
 * Guarded execution bridge mapping agent tools to ledger commands,
 * scoped database queries, and fenced settings mutations.
 * In accordance with plans/006-implementation-handoff.md Section 4 & 5.
 */

import type { CommandResult, LeadStatus } from '@otis/contracts';
import {
  checkUntrustedContentPolicy,
  isExplicitSentConfirmation,
  isExplicitStatusIntent,
  validateToolCall,
  type CreateTaskToolArgs,
  type DraftMessageToolArgs,
  type FindEntitiesToolArgs,
  type ForgetMemoryToolArgs,
  type GetMemoryToolArgs,
  type LogEventToolArgs,
  type MarkMessageSentToolArgs,
  type QueryToolArgs,
  type RememberContextToolArgs,
  type RenameEntityToolArgs,
  type RequestClarificationToolArgs,
  type ResolveConflictToolArgs,
  type SearchMemoryToolArgs,
  type SetFieldsToolArgs,
  type UndoToolArgs,
  type UpdateDraftToolArgs,
  type UpdatePreferenceToolArgs,
  type UpdateTaskToolArgs,
  type UpsertEntityToolArgs,
} from '@otis/agent';
import {
  DEFAULT_COMMAND_HANDLERS,
  executeLedgerCommand,
  getWorkspaceActions,
  getWorkspaceEvents,
  handleUndoCommit,
  rankEntityMatches,
  type LedgerCommandContext,
} from '@otis/ledger';
import { setMemberSettings, SettingsError } from '@otis/identity';
import { sanitizeFtsQuery } from './context.js';

export interface ExecuteAgentToolParams {
  db: D1Database;
  workspaceId: string;
  actorUserId: string;
  runId?: string;
  stepId?: string;
  fence?: number;
  expectedBusinessRevision?: number;
  actionId: string;
  sourceMessageId?: string;
  chatId?: string;
  sourceTrust?: 'member' | 'forwarded_client' | 'memory';
  sourceText?: string;
  toolName: string;
  toolArgs: unknown;
  maxDailyActions?: number;
}

export async function executeAgentTool(
  params: ExecuteAgentToolParams,
): Promise<CommandResult> {
  const {
    db,
    workspaceId,
    actorUserId,
    runId,
    stepId,
    fence,
    expectedBusinessRevision,
    actionId,
    sourceMessageId,
    chatId,
    sourceTrust = 'member',
    sourceText = '',
    toolName,
    toolArgs,
  } = params;

  // 1. Runtime schema & argument validation
  const valRes = validateToolCall(toolName, toolArgs);
  let args = valRes.ok ? valRes.data : toolArgs;
  if (!valRes.ok) {
    if (toolName === 'create_task' && valRes.error.code === 'missing_deadline') {
      args = toolArgs;
    } else {
      return {
        status: 'rejected',
        action_id: actionId,
        error: valRes.error,
      };
    }
  }

  // 2. Untrusted content / injection policy check
  const untrustedRes = checkUntrustedContentPolicy(sourceTrust, toolName, sourceText);
  if (!untrustedRes.allowed) {
    return {
      status: 'rejected',
      action_id: actionId,
      error: { code: 'policy_violation', message: untrustedRes.violation || 'Untrusted content cannot perform mutations.' },
    };
  }

  // 3. Explicit intent check for lead status changes
  if (toolName === 'set_fields') {
    const sfArgs = args as SetFieldsToolArgs;
    const statusFields = sfArgs.fields.filter((f) => f.field_name === 'status');
    for (const statusField of statusFields) {
      const explicitRes = isExplicitStatusIntent(sourceText, statusField.value as LeadStatus);
      if (!explicitRes.isExplicit) {
        return {
          status: 'needs_clarification',
          action_id: actionId,
          clarification: {
            prompt: `Did you want to set the status of this lead to ${String(statusField.value)}?`,
            missing_fields: ['status_confirmation'],
            candidates: ['confirm', 'cancel'],
          },
        };
      }
    }
  }

  let effectiveExpectedRevision = expectedBusinessRevision;
  if (effectiveExpectedRevision === undefined) {
    const wsRow = await db
      .prepare(`SELECT business_revision FROM workspaces WHERE id = ?`)
      .bind(workspaceId)
      .first<{ business_revision: number }>();
    effectiveExpectedRevision = wsRow?.business_revision ?? 0;
  }

  // Common ledger context
  const ledgerContext: LedgerCommandContext = {
    workspace_id: workspaceId,
    actor: { kind: 'member', user_id: actorUserId },
    membership_revision: 1,
    source_message_id: sourceMessageId,
    chat_id: chatId,
    request_id: actionId,
    run_id: runId,
    step_id: stepId,
    fence,
    action_id: actionId,
    expected_business_revision: effectiveExpectedRevision,
    max_daily_actions: params.maxDailyActions,
  };

  // 4. Dispatch by tool owner
  switch (toolName) {
    // --- Read / Query Tools ---
    case 'find_entities': {
      const feArgs = args as FindEntitiesToolArgs;
      const entitiesRows = (
        await db
          .prepare(`SELECT id, name FROM entities WHERE workspace_id = ?`)
          .bind(workspaceId)
          .all<{ id: string; name: string }>()
      ).results || [];

      const aliasesRows = (
        await db
          .prepare(`SELECT id, entity_id, alias FROM entity_aliases WHERE workspace_id = ?`)
          .bind(workspaceId)
          .all<{ id: string; entity_id: string; alias: string }>()
      ).results || [];

      const matchResult = rankEntityMatches(feArgs.query, entitiesRows, aliasesRows);
      const candidates = feArgs.limit ? matchResult.candidates.slice(0, feArgs.limit) : matchResult.candidates;

      return {
        status: 'applied',
        action_id: actionId,
        data: {
          candidates,
          bestMatch: matchResult.bestMatch,
          isAmbiguous: matchResult.isAmbiguous,
          ambiguityReason: matchResult.ambiguityReason,
        },
      };
    }

    case 'query': {
      const qArgs = args as QueryToolArgs;
      const limit = qArgs.limit || 25;

      if (qArgs.resource === 'entities') {
        let sql = `SELECT id, name, kind, status, assigned_user_id, created_at, updated_at FROM entities WHERE workspace_id = ?`;
        const binds: unknown[] = [workspaceId];
        if (qArgs.filters?.entity_id) {
          sql += ` AND id = ?`;
          binds.push(qArgs.filters.entity_id);
        }
        if (qArgs.filters?.entity_status) {
          sql += ` AND status = ?`;
          binds.push(qArgs.filters.entity_status);
        }
        if (qArgs.filters?.assignee_user_id) {
          sql += ` AND assigned_user_id = ?`;
          binds.push(qArgs.filters.assignee_user_id);
        }
        if (qArgs.cursor) {
          sql += ` AND id > ?`;
          binds.push(qArgs.cursor);
        }
        sql += ` ORDER BY id ASC LIMIT ?`;
        binds.push(limit);
        const rows = (await db.prepare(sql).bind(...binds).all()).results || [];
        return { status: 'applied', action_id: actionId, data: rows };
      }

      if (qArgs.resource === 'tasks') {
        let sql = `SELECT id, entity_id, title, assignee_user_id, status, due_kind, due_local_date, due_instant, due_timezone, snooze_until, revision, created_at, updated_at FROM tasks WHERE workspace_id = ?`;
        const binds: unknown[] = [workspaceId];
        if (qArgs.filters?.task_status) {
          sql += ` AND status = ?`;
          binds.push(qArgs.filters.task_status);
        }
        if (qArgs.filters?.entity_id) {
          sql += ` AND entity_id = ?`;
          binds.push(qArgs.filters.entity_id);
        }
        if (qArgs.filters?.assignee_user_id) {
          sql += ` AND assignee_user_id = ?`;
          binds.push(qArgs.filters.assignee_user_id);
        }
        if (qArgs.filters?.due_before) {
          sql += ` AND (due_local_date <= ? OR due_instant <= ?)`;
          binds.push(qArgs.filters.due_before, qArgs.filters.due_before);
        }
        if (qArgs.filters?.due_after) {
          sql += ` AND (due_local_date >= ? OR due_instant >= ?)`;
          binds.push(qArgs.filters.due_after, qArgs.filters.due_after);
        }
        if (qArgs.cursor) {
          sql += ` AND id > ?`;
          binds.push(qArgs.cursor);
        }
        sql += ` ORDER BY id ASC LIMIT ?`;
        binds.push(limit);
        const rows = (await db.prepare(sql).bind(...binds).all()).results || [];
        return { status: 'applied', action_id: actionId, data: rows };
      }

      if (qArgs.resource === 'events') {
        let sql = `SELECT id, sequence, entity_id, kind, payload_json, occurred_at, recorded_at, channel, provenance FROM events WHERE workspace_id = ?`;
        const binds: unknown[] = [workspaceId];
        if (qArgs.filters?.entity_id) {
          sql += ` AND entity_id = ?`;
          binds.push(qArgs.filters.entity_id);
        }
        if (qArgs.filters?.event_kind) {
          sql += ` AND kind = ?`;
          binds.push(qArgs.filters.event_kind);
        }
        if (qArgs.cursor) {
          const seq = Number(qArgs.cursor);
          if (!Number.isNaN(seq)) {
            sql += ` AND sequence < ?`;
            binds.push(seq);
          }
        }
        sql += ` ORDER BY sequence DESC LIMIT ?`;
        binds.push(limit);
        const rows = (await db.prepare(sql).bind(...binds).all()).results || [];
        return { status: 'applied', action_id: actionId, data: rows };
      }

      if (qArgs.resource === 'drafts') {
        let sql = `SELECT id, entity_id, channel, recipient_address, content_text, status, revision, created_at, updated_at FROM draft_projections WHERE workspace_id = ?`;
        const binds: unknown[] = [workspaceId];
        if (qArgs.filters?.entity_id) {
          sql += ` AND entity_id = ?`;
          binds.push(qArgs.filters.entity_id);
        }
        if (qArgs.cursor) {
          sql += ` AND id > ?`;
          binds.push(qArgs.cursor);
        }
        sql += ` ORDER BY id ASC LIMIT ?`;
        binds.push(limit);
        const rows = (await db.prepare(sql).bind(...binds).all()).results || [];
        return { status: 'applied', action_id: actionId, data: rows };
      }

      return { status: 'rejected', action_id: actionId, error: { code: 'invalid_resource', message: `Unknown resource '${qArgs.resource}'.` } };
    }

    case 'search_memory': {
      const smArgs = args as SearchMemoryToolArgs;
      const limit = smArgs.limit || 12;

      const ftsQuery = sanitizeFtsQuery(smArgs.query);
      let rows: Record<string, unknown>[] = [];

      if (ftsQuery) {
        let ftsSql = `
          SELECT m.id, m.scope, m.subject_id, m.category, m.content, m.status, m.observed_at, m.created_at, m.business_revision
          FROM memory_entries_fts f
          JOIN memory_entries m ON m.id = f.entry_id
          WHERE m.workspace_id = ? AND m.status = 'active'
            AND memory_entries_fts MATCH ?
        `;
        const ftsBinds: unknown[] = [workspaceId, ftsQuery];
        if (smArgs.scope) {
          ftsSql += ` AND m.scope = ?`;
          ftsBinds.push(smArgs.scope);
        }
        if (smArgs.subject_id) {
          ftsSql += ` AND m.subject_id = ?`;
          ftsBinds.push(smArgs.subject_id);
        }
        ftsSql += ` ORDER BY m.observed_at DESC LIMIT ?`;
        ftsBinds.push(limit);

        try {
          rows = (await db.prepare(ftsSql).bind(...ftsBinds).all()).results || [];
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('fts5') || msg.includes('syntax') || msg.includes('no such table') || msg.includes('MATCH')) {
            rows = [];
          } else {
            throw err;
          }
        }
      }

      // If FTS returned 0 rows or query was not FTS-compatible, fall back to LIKE search
      if (rows.length === 0) {
        let likeSql = `
          SELECT id, scope, subject_id, category, content, status, observed_at, created_at, business_revision
          FROM memory_entries
          WHERE workspace_id = ? AND status = 'active' AND content LIKE ?
        `;
        const likeBinds: unknown[] = [workspaceId, `%${smArgs.query.trim()}%`];
        if (smArgs.scope) {
          likeSql += ` AND scope = ?`;
          likeBinds.push(smArgs.scope);
        }
        if (smArgs.subject_id) {
          likeSql += ` AND subject_id = ?`;
          likeBinds.push(smArgs.subject_id);
        }
        likeSql += ` ORDER BY observed_at DESC LIMIT ?`;
        likeBinds.push(limit);

        rows = (await db.prepare(likeSql).bind(...likeBinds).all()).results || [];
      }

      return { status: 'applied', action_id: actionId, data: rows };
    }

    case 'get_memory': {
      const gmArgs = args as GetMemoryToolArgs;
      const row = await db
        .prepare(
          `SELECT id, scope, subject_id, category, content, status, provenance, source_event_id, source_message_id, author_user_id, observed_at, created_at, business_revision
           FROM memory_entries WHERE workspace_id = ? AND id = ?`
        )
        .bind(workspaceId, gmArgs.memory_id)
        .first();

      if (!row) {
        return {
          status: 'rejected',
          action_id: actionId,
          error: { code: 'not_found', message: `Memory entry '${gmArgs.memory_id}' not found.` },
        };
      }
      return { status: 'applied', action_id: actionId, data: row };
    }

    // --- Preference Tool ---
    case 'update_preference': {
      const upArgs = args as UpdatePreferenceToolArgs;
      try {
        const updated = await setMemberSettings(db, {
          workspaceId,
          userId: actorUserId,
          actorUserId,
          input: upArgs,
          fencedContext: (runId && fence !== undefined) ? {
            runId,
            stepId,
            fence,
            actionId,
            sourceMessageId,
            maxDailyActions: params.maxDailyActions,
          } : undefined,
        });
        return {
          status: 'applied',
          action_id: actionId,
          data: updated,
          summary: 'Updated member preferences.',
        };
      } catch (err) {
        if (err instanceof SettingsError) {
          if (err.code === 'conflict' || err.code === 'fence_conflict') {
            return {
              status: 'conflict',
              action_id: actionId,
              error: { code: err.code, message: err.message },
            };
          }
          return {
            status: 'rejected',
            action_id: actionId,
            error: { code: err.code, message: err.message },
          };
        }
        throw err;
      }
    }

    // --- Control Tool ---
    case 'request_clarification': {
      const rcArgs = args as RequestClarificationToolArgs;
      return {
        status: 'needs_clarification',
        action_id: actionId,
        clarification: {
          prompt: rcArgs.question,
          missing_fields: rcArgs.missing_fields,
          candidates: rcArgs.candidates,
          pending_operation: {
            version: 1,
            command_name: rcArgs.intended_operation,
            action_id: actionId,
            args: rcArgs.proposed_arguments || {},
            missing_fields: rcArgs.missing_fields,
            candidates: rcArgs.candidates,
            source_revision: effectiveExpectedRevision,
          },
        },
      };
    }

    // --- Ledger Commands ---
    case 'upsert_entity': {
      const ueArgs = args as UpsertEntityToolArgs;
      // Match first to avoid near-duplicates
      const entitiesRows = (
        await db
          .prepare(`SELECT id, name FROM entities WHERE workspace_id = ?`)
          .bind(workspaceId)
          .all<{ id: string; name: string }>()
      ).results || [];

      const aliasesRows = (
        await db
          .prepare(`SELECT id, entity_id, alias FROM entity_aliases WHERE workspace_id = ?`)
          .bind(workspaceId)
          .all<{ id: string; entity_id: string; alias: string }>()
      ).results || [];

      const matchRes = rankEntityMatches(ueArgs.name, entitiesRows, aliasesRows);
      if (matchRes.bestMatch) {
        // Return existing unambiguous entity
        return {
          status: 'already_applied',
          action_id: actionId,
          affected_resource_ids: [matchRes.bestMatch.id],
          data: { entity_id: matchRes.bestMatch.id, name: matchRes.bestMatch.name },
          summary: `Matched existing entity '${matchRes.bestMatch.name}'.`,
        };
      }

      if (matchRes.isAmbiguous) {
        return {
          status: 'needs_clarification',
          action_id: actionId,
          clarification: {
            prompt: `Multiple existing entities match '${ueArgs.name}'. Which one did you mean?`,
            missing_fields: ['entity_selection'],
            candidates: matchRes.candidates.map((c) => c.name),
          },
        };
      }

      // No match: create genuinely new entity
      return executeLedgerCommand(
        db,
        ledgerContext,
        'create_entity',
        { name: ueArgs.name, kind: ueArgs.kind },
        DEFAULT_COMMAND_HANDLERS['create_entity']!,
        undefined,
        { deferRunTransition: true },
      );
    }

    case 'rename_entity': {
      const reArgs = args as RenameEntityToolArgs;
      return executeLedgerCommand(
        db,
        ledgerContext,
        'rename_entity',
        reArgs,
        DEFAULT_COMMAND_HANDLERS['rename_entity']!,
        undefined,
        { deferRunTransition: true },
      );
    }

    case 'log_event': {
      const leArgs = args as LogEventToolArgs;
      return executeLedgerCommand(
        db,
        ledgerContext,
        'log_event',
        leArgs,
        DEFAULT_COMMAND_HANDLERS['log_event']!,
        undefined,
        { deferRunTransition: true },
      );
    }

    case 'set_fields': {
      const sfArgs = args as SetFieldsToolArgs;
      let currentRevision = effectiveExpectedRevision;
      const appliedFieldNames: string[] = [];

      for (let i = 0; i < sfArgs.fields.length; i++) {
        const item = sfArgs.fields[i]!;
        const childActionId = `${actionId}_f${i}`;
        const childContext: LedgerCommandContext = {
          ...ledgerContext,
          action_id: childActionId,
          expected_business_revision: currentRevision,
        };

        const res = await executeLedgerCommand(
          db,
          childContext,
          'set_field',
          {
            entity_id: sfArgs.entity_id,
            field_name: item.field_name,
            value: item.value,
            provenance: item.provenance,
          },
          DEFAULT_COMMAND_HANDLERS['set_field']!,
          undefined,
          { deferRunTransition: true },
        );

        if (res.status === 'applied') {
          appliedFieldNames.push(item.field_name);
          currentRevision = res.committed_revision ?? currentRevision + 1;
        } else if (res.status === 'already_applied') {
          appliedFieldNames.push(item.field_name);
        } else {
          return {
            ...res,
            action_id: actionId,
            summary: appliedFieldNames.length > 0
              ? `Applied fields [${appliedFieldNames.join(', ')}], but failed on '${item.field_name}': ${res.error?.message}`
              : res.error?.message,
          };
        }
      }

      return {
        status: 'applied',
        action_id: actionId,
        committed_revision: currentRevision,
        summary: `Updated fields: ${appliedFieldNames.join(', ')}.`,
      };
    }

    case 'resolve_conflict': {
      const rcArgs = args as ResolveConflictToolArgs;
      return executeLedgerCommand(
        db,
        ledgerContext,
        'resolve_conflict',
        rcArgs,
        DEFAULT_COMMAND_HANDLERS['resolve_conflict']!,
        undefined,
        { deferRunTransition: true },
      );
    }

    case 'create_task': {
      const ctArgs = args as CreateTaskToolArgs;
      return executeLedgerCommand(
        db,
        ledgerContext,
        'create_task',
        ctArgs,
        DEFAULT_COMMAND_HANDLERS['create_task']!,
        undefined,
        { deferRunTransition: true },
      );
    }

    case 'update_task': {
      const utArgs = args as UpdateTaskToolArgs;
      return executeLedgerCommand(
        db,
        ledgerContext,
        'update_task',
        utArgs,
        DEFAULT_COMMAND_HANDLERS['update_task']!,
        undefined,
        { deferRunTransition: true },
      );
    }

    case 'draft_message': {
      const dmArgs = args as DraftMessageToolArgs;
      if (dmArgs.entity_id) {
        const disputedRows = (
          await db
            .prepare(
              `SELECT field_name, value_text, value_json FROM entity_state WHERE workspace_id = ? AND entity_id = ? AND state = 'disputed'`,
            )
            .bind(workspaceId, dmArgs.entity_id)
            .all<{ field_name: string; value_text: string | null; value_json: string | null }>()
        ).results || [];
        for (const row of disputedRows) {
          const val = row.value_text || (row.value_json ? String(row.value_json) : null);
          if (val && dmArgs.content.toLowerCase().includes(val.toLowerCase())) {
            return {
              status: 'needs_clarification',
              action_id: actionId,
              clarification: {
                prompt: `Field '${row.field_name}' is currently in dispute (${val}). It cannot be used as settled content in an outward draft without explicit confirmation.`,
                missing_fields: ['dispute_confirmation'],
                candidates: ['confirm_disputed_value', 'change_content'],
              },
            };
          }
        }
      }
      return executeLedgerCommand(
        db,
        ledgerContext,
        'record_draft',
        {
          entity_id: dmArgs.entity_id,
          channel: dmArgs.channel,
          recipient_address: dmArgs.recipient,
          content_text: dmArgs.content,
        },
        DEFAULT_COMMAND_HANDLERS['record_draft']!,
        undefined,
        { deferRunTransition: true },
      );
    }

    case 'update_draft': {
      const udArgs = args as UpdateDraftToolArgs;
      return executeLedgerCommand(
        db,
        ledgerContext,
        'record_draft',
        {
          draft_id: udArgs.draft_id,
          content_text: udArgs.content,
          recipient_address: udArgs.recipient,
        },
        DEFAULT_COMMAND_HANDLERS['record_draft']!,
        undefined,
        { deferRunTransition: true },
      );
    }

    case 'mark_message_sent': {
      const mmsArgs = args as MarkMessageSentToolArgs;
      if (sourceText) {
        const sentCheck = isExplicitSentConfirmation(sourceText);
        if (!sentCheck.isConfirmed) {
          return {
            status: 'needs_clarification',
            action_id: actionId,
            clarification: {
              prompt: 'Did you already send this message to the recipient?',
              missing_fields: ['sent_confirmation'],
              candidates: ['confirmed_sent', 'not_sent'],
            },
          };
        }
      }
      return executeLedgerCommand(
        db,
        ledgerContext,
        'mark_message_sent',
        mmsArgs,
        DEFAULT_COMMAND_HANDLERS['mark_message_sent']!,
        undefined,
        { deferRunTransition: true },
      );
    }

    case 'remember_context': {
      const remArgs = args as RememberContextToolArgs;
      return executeLedgerCommand(
        db,
        ledgerContext,
        'remember_context',
        remArgs,
        DEFAULT_COMMAND_HANDLERS['remember_context']!,
        undefined,
        { deferRunTransition: true },
      );
    }

    case 'forget_memory': {
      const fArgs = args as ForgetMemoryToolArgs;
      return executeLedgerCommand(
        db,
        ledgerContext,
        'forget_memory',
        fArgs,
        DEFAULT_COMMAND_HANDLERS['forget_memory']!,
        undefined,
        { deferRunTransition: true },
      );
    }

    case 'undo': {
      const uArgs = args as UndoToolArgs;
      const allEvents = await getWorkspaceEvents(db, workspaceId);
      const allActions = await getWorkspaceActions(db, workspaceId);

      let targetActionId = uArgs.action_id;
      if (!targetActionId) {
        // Resolve latest action by this member in this chat
        let eligibleActionIds: Set<string> | null = null;
        if (chatId) {
          const chatRuns = (
            await db
              .prepare(`SELECT id FROM agent_runs WHERE workspace_id = ? AND chat_id = ?`)
              .bind(workspaceId, chatId)
              .all<{ id: string }>()
          ).results || [];
          const runIdSet = new Set(chatRuns.map((r) => r.id));

          const chatMsgs = (
            await db
              .prepare(`SELECT id FROM messages_in WHERE workspace_id = ? AND chat_id = ?`)
              .bind(workspaceId, chatId)
              .all<{ id: string }>()
          ).results || [];
          const msgIdSet = new Set(chatMsgs.map((m) => m.id));

          eligibleActionIds = new Set(
            allActions
              .filter(
                (a) =>
                  a.actor_user_id === actorUserId &&
                  a.result_status === 'applied' &&
                  ((a.run_id && runIdSet.has(a.run_id)) || (a.source_message_id && msgIdSet.has(a.source_message_id))),
              )
              .map((a) => a.action_id),
          );
        }

        const eligible = allActions.filter(
          (a) =>
            a.actor_user_id === actorUserId &&
            a.result_status === 'applied' &&
            (!eligibleActionIds || eligibleActionIds.has(a.action_id)),
        );
        if (eligible.length === 0) {
          return {
            status: 'rejected',
            action_id: actionId,
            error: { code: 'no_actions_to_undo', message: 'No eligible actions to undo in current chat.' },
          };
        }
        targetActionId = eligible[eligible.length - 1]!.action_id;
      }

      return executeLedgerCommand(
        db,
        ledgerContext,
        'undo',
        {
          action_id: targetActionId,
          mode: uArgs.mode || 'from_here',
          client_operation_id: actionId,
          expected_revision: effectiveExpectedRevision,
        },
        (ctx, state, seq, undoReq) => handleUndoCommit(ctx, allEvents, allActions, state, seq, undoReq),
        undefined,
        { deferRunTransition: true },
      );
    }

    default:
      return {
        status: 'rejected',
        action_id: actionId,
        error: { code: 'unknown_tool', message: `Tool '${toolName}' is not implemented.` },
      };
  }
}
