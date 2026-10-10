import { isExplicitMergeIntent } from '@otis/agent';
import { readFollowUps } from '../entities/followups.js';
import { listMembers } from '@otis/identity';
import { normalizeName, levenshteinDistance } from '@otis/ledger';
import { unifiedWorkspaceSearch } from '../unifiedSearch.js';
/**
 * @otis/worker/agent/repository
 * Guarded execution bridge mapping agent tools to ledger commands,
 * scoped database queries, and fenced settings mutations.
 * In accordance with docs/archive/plans/006-implementation-handoff.md Section 4 & 5.
 */

import type {
  ChangeContactArgs,
  CommandResult,
  LeadStatus,
  MergeEntitiesArgs,
  RecordEdit,
  RecordRef,
  RecordsContext,
  RecordValue,
  SearchWorkspaceHistoryArgs,
} from '@otis/contracts';
import { validateRecordEdit } from '@otis/contracts';
import { readDocument } from '../media/documents.js';
import {
  canonicalEntityId,
  canonicalEntityMap,
  ENTITY_FAMILY_SQL,
  familyBinds,
} from '../entities/canonical.js';
import { readWork } from '../entities/work.js';
import { readChatAttachments } from '../entities/attachments.js';
import {
  checkUntrustedContentPolicy,
  isExplicitPromise,
  isExplicitSentConfirmation,
  isExplicitStatusIntent,
  sentConfirmationMatchesTarget,
  validateToolCall,
  type CancelReminderToolArgs,
  type CreateReminderToolArgs,
  type CreateTaskToolArgs,
  type DeleteEntityToolArgs,
  type DraftMessageToolArgs,
  type EditRecordsToolArgs,
  type FindEntitiesToolArgs,
  type ForgetMemoryToolArgs,
  type GetMemoryToolArgs,
  type LogEventToolArgs,
  type MarkMessageSentToolArgs,
  type QueryToolArgs,
  type ReadChatHistoryToolArgs,
  type RememberContextToolArgs,
  type RemoveInteractionToolArgs,
  type ReviseInteractionToolArgs,
  type UpdateReminderToolArgs,
  type RenameEntityToolArgs,
  type RequestClarificationToolArgs,
  type ResolveConflictToolArgs,
  type SearchMemoryToolArgs,
  type SetChatModelToolArgs,
  type SetChatThinkingToolArgs,
  type SetFieldsToolArgs,
  type UndoToolArgs,
  type UpdateDraftToolArgs,
  type UpdatePreferenceToolArgs,
  type UpdateTaskToolArgs,
  type UpsertEntityToolArgs,
  type ViewImageToolArgs,
  type ExecuteCommandToolArgs,
  PRODUCTION_REGISTRY,
} from '@otis/agent';
import {
  DEFAULT_COMMAND_HANDLERS,
  contactComparison,
  executeLedgerCommand,
  getActionReceiptsByIds,
  getQuestionByAction,
  getWorkspaceActions,
  getWorkspaceEvents,
  getBusinessProjectionState,
  previewEntityMerge,
  handleUndoCommit,
  readCurrentInteractions,
  rankEntityMatches,
  type LedgerCommandContext,
} from '@otis/ledger';
import { setMemberSettings, SettingsError, sha256 } from '@otis/identity';
import { executeCommand, resolveModelAlias } from '../routes/commands.js';
import { getChat } from '../inbox/repository.js';
import { sanitizeFtsQuery } from './context.js';
import { readLeadOverview, type LeadOverviewColumn } from './leadOverview.js';
import { FileReadError, readEntityFile } from '../entities/file.js';
import { readRecordsPage } from '../records/read.js';
import {
  HistoryReadError,
  readWorkspaceMessageSource,
  searchWorkspaceHistory,
} from '../conversationSearch.js';
import { cancelReminder, createReminder, updateReminder } from '../reminders/service.js';
import type {
  DocumentStartArgs,
  DocumentWriteSectionArgs,
  DocumentPublishArgs,
} from '@otis/contracts';
import {
  startDocument,
  writeDocumentSections,
  publishDocument,
  listChatDocuments,
} from '../media/generatedDocuments.js';
import type { Env } from '../index.js';


/** Draft-target gate: table-writing tools stage, clarify, or reject; all others execute normally. */

function draftScopeKeys(context: RecordsContext): Set<string> {
  const keys = new Set<string>();
  for (const ref of [...context.selected_rows, ...context.visible_row_order]) {
    keys.add(`${ref.kind}:${ref.id}`);
  }
  return keys;
}

function draftScopeViolation(
  context: RecordsContext,
  actionId: string,
  refs: RecordRef[],
  what: string,
): CommandResult | null {
  const allowed = draftScopeKeys(context);
  const outside = refs.filter((ref) => !allowed.has(`${ref.kind}:${ref.id}`));
  if (outside.length === 0) return null;
  const names = outside.map((ref) => `${ref.kind} ${ref.id}`).join(', ');
  return {
    status: 'needs_clarification',
    action_id: actionId,
    summary: `The table edit targets ${names}, outside the open ${context.list_id} selection.`,
    clarification: {
      prompt: `Which records should '${what}' change? It currently reaches ${names}, outside the rows in view. Name the exact records or open their list first.`,
      missing_fields: ['records_scope'],
    },
  };
}

function draftPatchResult(
  actionId: string,
  context: RecordsContext,
  listId: string,
  ops: RecordEdit[],
  summary: string,
): CommandResult {
  for (const op of ops) {
    const check = validateRecordEdit(op);
    if (!check.valid) {
      return {
        status: 'rejected',
        action_id: actionId,
        error: {
          code: check.code,
          message: check.op_id ? `[op ${check.op_id}] ${check.message}` : check.message,
        },
      };
    }
  }
  return {
    status: 'applied',
    action_id: actionId,
    summary: `${summary} Staged ${ops.length} table edits into the open draft — Save when ready. No business writes happened.`,
    data: {
      records_patch: {
        patch_id: `ptc_${actionId}`,
        draft: context.target,
        list_id: listId,
        operations: ops,
        op_count: ops.length,
        save_required: true,
      },
    },
  };
}

function cellOp(
  toolName: string,
  index: number,
  rowRef: RecordRef,
  columnId: string,
  value: unknown,
): RecordEdit {
  return {
    op: 'cell.set',
    op_id: `op_${toolName}_${index}`,
    row_ref: rowRef,
    column_id: columnId,
    value: value as RecordValue,
  };
}

/**
 * Translate a legacy table-writing tool call into shared record operations.
 * Returns null when the tool is not draft-gated (it executes normally).
 * Staging never commits: the member reviews the patch and still saves it.
 */
function translateLegacyToolToOps(
  context: RecordsContext,
  toolName: string,
  args: unknown,
): { ops: RecordEdit[]; listId: string } | { clarify: string } | { reject: string } | null {
  const listId = context.list_id;
  const a = (args ?? {}) as Record<string, unknown>;
  switch (toolName) {
    case 'set_fields': {
      const entityId = a['entity_id'];
      const fields = a['fields'];
      if (typeof entityId !== 'string' || !Array.isArray(fields)) return null;
      const ops: RecordEdit[] = fields.flatMap((field, index) => {
        const item = (field ?? {}) as Record<string, unknown>;
        if (typeof item['field_name'] !== 'string' || !('value' in item)) return [];
        return [cellOp(toolName, index, { kind: 'entity', id: entityId }, item['field_name'], item['value'])];
      });
      return { ops, listId };
    }
    case 'upsert_entity': {
      if (typeof a['name'] !== 'string' || !a['name'].trim()) return null;
      return {
        ops: [{
          op: 'row.create', op_id: `op_${toolName}_0`,
          row_ref: { kind: 'entity', id: `tmp_${toolName}_0` }, list_id: listId,
          initial_values: { name: a['name'] },
        }],
        listId,
      };
    }
    case 'rename_entity': {
      if (typeof a['entity_id'] !== 'string' || typeof a['new_name'] !== 'string') return null;
      return {
        ops: [cellOp(toolName, 0, { kind: 'entity', id: a['entity_id'] }, 'name', a['new_name'])],
        listId,
      };
    }
    case 'delete_entity': {
      if (typeof a['entity_id'] !== 'string') return null;
      return {
        ops: [{ op: 'row.remove', op_id: `op_${toolName}_0`, row_ref: { kind: 'entity', id: a['entity_id'] } }],
        listId,
      };
    }
    case 'change_contact': {
      if (typeof a['entity_id'] !== 'string') return null;
      if (a['operation'] === 'make_primary') {
        return { clarify: 'Choosing a primary contact needs the member to pick one in the open draft.' };
      }
      const method = a['method'];
      if (method !== 'phone' && method !== 'email') return null;
      if (a['operation'] === 'remove' || a['value'] === null) {
        return {
          ops: [{ op: 'cell.clear', op_id: `op_${toolName}_0`, row_ref: { kind: 'entity', id: a['entity_id'] }, column_id: method }],
          listId,
        };
      }
      if (typeof a['value'] !== 'string') return null;
      return {
        ops: [cellOp(toolName, 0, { kind: 'entity', id: a['entity_id'] }, method, a['value'])],
        listId,
      };
    }
    case 'log_event': {
      const kind = a['kind'];
      const payload = (a['payload'] ?? {}) as Record<string, unknown>;
      const entityId = typeof a['entity_id'] === 'string' && a['entity_id'] ? a['entity_id'] : null;
      if (kind === 'note' && typeof payload['text'] === 'string' && payload['text'].trim()) {
        if (entityId) {
          return {
            ops: [cellOp(toolName, 0, { kind: 'entity', id: entityId }, 'notes', payload['text'])],
            listId,
          };
        }
        return {
          ops: [{
            op: 'row.create', op_id: `op_${toolName}_0`,
            row_ref: { kind: 'interaction', id: `tmp_${toolName}_0` }, list_id: 'notes',
            initial_values: { text: payload['text'] },
          }],
          listId: 'notes',
        };
      }
      if (kind === 'quote' && payload['amount'] !== undefined) {
        if (!entityId) return { clarify: 'Which record should carry this quote? Name the exact row first.' };
        return {
          ops: [cellOp(toolName, 0, { kind: 'entity', id: entityId }, 'value', {
            amount: payload['amount'], currency: payload['currency'], role: payload['role'],
          })],
          listId,
        };
      }
      return { clarify: 'This entry needs its typed fields in the open draft. Describe which record and which values.' };
    }
    case 'revise_interaction': {
      if (typeof a['interaction_id'] !== 'string') return null;
      return {
        ops: [{
          op: 'item.edit', op_id: `op_${toolName}_0`,
          source_ref: { kind: 'interaction', id: a['interaction_id'] },
          payload: (a['payload'] ?? {}) as Record<string, unknown>,
        }],
        listId,
      };
    }
    case 'remove_interaction': {
      if (typeof a['interaction_id'] !== 'string') return null;
      return {
        ops: [{ op: 'item.remove', op_id: `op_${toolName}_0`, source_ref: { kind: 'interaction', id: a['interaction_id'] } }],
        listId,
      };
    }
    case 'create_task': {
      if (typeof a['title'] !== 'string' || !a['title'].trim()) return null;
      return {
        ops: [{
          op: 'row.create', op_id: `op_${toolName}_0`,
          row_ref: { kind: 'task', id: `tmp_${toolName}_0` }, list_id: 'tasks',
          initial_values: {
            title: a['title'],
            ...(typeof a['due'] === 'object' && a['due'] !== null ? { due: a['due'] as RecordValue } : {}),
            ...(typeof a['assignee_user_id'] === 'string' ? { assignee: a['assignee_user_id'] } : {}),
          },
        }],
        listId: 'tasks',
      };
    }
    case 'update_task': {
      if (typeof a['task_id'] !== 'string') return null;
      const ops: RecordEdit[] = [];
      let index = 0;
      for (const [key, column] of [['title', 'title'], ['status', 'status'], ['due', 'due']] as const) {
        if (a[key] !== undefined) {
          ops.push(cellOp(toolName, index++, { kind: 'task', id: a['task_id'] }, column, a[key]));
        }
      }
      if (typeof a['assignee_user_id'] === 'string') {
        ops.push(cellOp(toolName, index++, { kind: 'task', id: a['task_id'] }, 'assignee', a['assignee_user_id']));
      }
      if (ops.length === 0) return { clarify: 'Snoozes and other task options need the member to choose them in the open draft.' };
      return { ops, listId };
    }
    case 'draft_message': {
      if (typeof a['content'] !== 'string' || !a['content'].trim()) return null;
      if (typeof a['channel'] !== 'string') return null;
      return {
        ops: [{
          op: 'row.create', op_id: `op_${toolName}_0`,
          row_ref: { kind: 'draft', id: `tmp_${toolName}_0` }, list_id: 'drafts',
          initial_values: {
            content_text: a['content'],
            channel: a['channel'],
            ...(typeof a['recipient'] === 'string' ? { recipient_address: a['recipient'] } : {}),
          },
        }],
        listId: 'drafts',
      };
    }
    case 'update_draft': {
      if (typeof a['draft_id'] !== 'string') return null;
      const ops: RecordEdit[] = [];
      if (typeof a['content'] === 'string') {
        ops.push(cellOp(toolName, 0, { kind: 'draft', id: a['draft_id'] }, 'content', a['content']));
      }
      if (typeof a['recipient'] === 'string') {
        ops.push(cellOp(toolName, 1, { kind: 'draft', id: a['draft_id'] }, 'recipient', a['recipient']));
      }
      if (ops.length === 0) return null;
      return { ops, listId };
    }
    case 'resolve_conflict': {
      if (typeof a['entity_id'] !== 'string' || typeof a['field_name'] !== 'string' || !('resolved_value' in a)) return null;
      return {
        ops: [cellOp(toolName, 0, { kind: 'entity', id: a['entity_id'] }, a['field_name'], a['resolved_value'])],
        listId,
      };
    }
    case 'undo': {
      return { reject: 'Undo applies to saved changes. Save or discard the open draft first, then undo.' };
    }
    case 'merge_entities': {
      return { clarify: 'Combining records needs the member to confirm the pair in the open draft first.' };
    }
    case 'mark_message_sent': {
      return { clarify: 'Sending needs explicit member confirmation and cannot ride on an unsaved draft.' };
    }
    default:
      return null;
  }
}

/**
 * Draft-target gate for table-writing tools. Staged patches validate and
 * scope-check exactly like manual saves; anything out of scope asks narrowly
 * instead of painting another list, and anything unst stageable rejects
 * with its reason. Returns null for tools that execute normally.
 */
function stageDraftToolResult(
  context: RecordsContext,
  toolName: string,
  args: unknown,
  actionId: string,
): CommandResult | null {
  if (toolName === 'edit_records') {
    const erArgs = args as Partial<EditRecordsToolArgs>;
    if (typeof erArgs.list_id !== 'string' || !Array.isArray(erArgs.operations)) return null;
    const ops = erArgs.operations as RecordEdit[];
    const refs: RecordRef[] = [];
    for (const op of ops) {
      if (!op || typeof op !== 'object') continue;
      if (op.op === 'cell.set' || op.op === 'cell.clear' || op.op === 'row.remove' || op.op === 'row.restore') {
        refs.push(op.row_ref);
      } else if (op.op === 'item.edit' || op.op === 'item.remove') {
        refs.push(op.source_ref);
      } else if (op.op === 'row.create') {
        if (op.list_id !== context.list_id) {
          return {
            status: 'needs_clarification',
            action_id: actionId,
            summary: `The table edit creates rows in '${op.list_id}' while '${context.list_id}' is open.`,
            clarification: {
              prompt: `This change creates rows in '${op.list_id}', but '${context.list_id}' is open. Open '${op.list_id}' first, or confirm the rows belong there.`,
              missing_fields: ['records_scope'],
            },
          };
        }
      } else if (op.op === 'field.create' || op.op === 'calculation.define') {
        const fieldList = op.op === 'field.create' ? op.list_id : undefined;
        if (fieldList !== undefined && fieldList !== context.list_id) {
          return {
            status: 'needs_clarification',
            action_id: actionId,
            summary: 'The table edit defines a field for another list.',
            clarification: {
              prompt: `This change defines a field outside '${context.list_id}'. Open that list first, or confirm the field belongs there.`,
              missing_fields: ['records_scope'],
            },
          };
        }
      }
    }
    const scoped = draftScopeViolation(context, actionId, refs, toolName);
    if (scoped) return scoped;
    return draftPatchResult(actionId, context, erArgs.list_id, ops, 'Table edits proposed.');
  }
  // The translator returns null for tools that execute normally; every
  // other table writer stages, clarifies, or rejects explicitly below.
  const translated = translateLegacyToolToOps(context, toolName, args);
  if (translated === null) return null;
  if ('reject' in translated) {
    return { status: 'rejected', action_id: actionId, error: { code: 'draft_target_unsupported', message: translated.reject } };
  }
  if ('clarify' in translated) {
    return {
      status: 'needs_clarification',
      action_id: actionId,
      summary: translated.clarify,
      clarification: { prompt: translated.clarify, missing_fields: ['records_scope'] },
    };
  }
  const refs: RecordRef[] = [];
  for (const op of translated.ops) {
    if (op.op === 'cell.set' || op.op === 'cell.clear' || op.op === 'row.remove' || op.op === 'row.restore') {
      refs.push(op.row_ref);
    } else if (op.op === 'item.edit' || op.op === 'item.remove') {
      refs.push(op.source_ref);
    }
  }
  const scoped = draftScopeViolation(context, actionId, refs, toolName);
  if (scoped) return scoped;
  return draftPatchResult(actionId, context, translated.listId, translated.ops, `Proposed via ${toolName}.`);
}

export interface ExecuteAgentToolParams {
  storage?: R2Bucket;
  pdfQueue?: Queue;
  browser?: Fetcher;
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
  /** Frozen records target from the accepted turn, if composed beside the grid. */
  recordsContext?: import('@otis/contracts').RecordsContext;
  toolName: string;
  toolArgs: unknown;
  maxDailyActions?: number;
}

export async function executeAgentTool(params: ExecuteAgentToolParams): Promise<CommandResult> {
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
      error: {
        code: 'policy_violation',
        message: untrustedRes.violation || 'Untrusted content cannot perform mutations.',
      },
    };
  }

  // 3. Per-item explicit intent for lead status changes. The verdict travels
  // into the ledger batch as trusted indexes; the batch saves clear facts
  // while parking only uncertain status, instead of rejecting the whole tool.
  // Model provenance can never grant confirmation here.
  let explicitStatusIndexes: number[] | undefined;
  if (toolName === 'set_fields') {
    const sfArgs = args as SetFieldsToolArgs;
    explicitStatusIndexes = [];
    sfArgs.fields.forEach((field, index) => {
      if (field.field_name !== 'status') return;
      const explicitRes = isExplicitStatusIntent(sourceText, field.value as LeadStatus);
      if (explicitRes.isExplicit) explicitStatusIndexes!.push(index);
    });
  }

  const wsRow = await db
    .prepare(
      `SELECT w.business_revision FROM workspaces w JOIN workspace_users member
    ON member.workspace_id = w.id AND member.user_id = ? WHERE w.id = ?`,
    )
    .bind(actorUserId, workspaceId)
    .first<{ business_revision: number }>();
  if (!wsRow)
    return {
      status: 'rejected',
      action_id: actionId,
      error: { code: 'access_lost', message: 'Workspace access is no longer available.' },
    };
  const effectiveExpectedRevision = expectedBusinessRevision ?? wsRow.business_revision;

  // 3b. Draft-target enforcement (R16 Slice E). When the turn was composed
  // beside the grid with unsaved edits, table-writing tools stage validated
  // operations into the member's draft instead of committing: the member
  // still clicks Save. Anything that cannot stage asks narrowly or rejects
  // explicitly; a prompt instruction alone is not enforcement.
  if (params.recordsContext && params.recordsContext.target.mode === 'draft') {
    const staged = stageDraftToolResult(params.recordsContext, toolName, args, actionId);
    if (staged) return staged;
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
      const queryTrim = (feArgs.query || '').trim();
      const likePattern = `%${queryTrim}%`;

      // Bounded candidate retrieval (SOL-22): prioritize matches and bound to 100 max
      const entitiesRows =
        (
          await db
            .prepare(
              `SELECT id, name FROM entities WHERE workspace_id = ? AND (name LIKE ? OR id = ?) LIMIT 100`,
            )
            .bind(workspaceId, likePattern, queryTrim)
            .all<{ id: string; name: string }>()
        ).results || [];

      const candidateEntities = entitiesRows;
      if (candidateEntities.length < 25) {
        const fallbackRows =
          (
            await db
              .prepare(
                `SELECT id, name FROM entities WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 50`,
              )
              .bind(workspaceId)
              .all<{ id: string; name: string }>()
          ).results || [];
        const seenIds = new Set(candidateEntities.map((r) => r.id));
        for (const row of fallbackRows) {
          if (!seenIds.has(row.id)) {
            candidateEntities.push(row);
            seenIds.add(row.id);
          }
        }
      }

      const aliasesRows =
        (
          await db
            .prepare(
              `SELECT id, entity_id, alias FROM entity_aliases WHERE workspace_id = ? AND (alias LIKE ? OR entity_id = ?) LIMIT 100`,
            )
            .bind(workspaceId, likePattern, queryTrim)
            .all<{ id: string; entity_id: string; alias: string }>()
        ).results || [];

      const matchResult = rankEntityMatches(feArgs.query, candidateEntities, aliasesRows);
      const canonicalMatches = await canonicalEntityMap(
        db,
        workspaceId,
        matchResult.candidates.map((c) => c.id),
      );
      const seenCanonical = new Set<string>();
      const deduplicated = matchResult.candidates.filter((c) => {
        const id = canonicalMatches.get(c.id)?.id;
        if (!id || seenCanonical.has(id)) return false;
        seenCanonical.add(id);
        return true;
      });
      const candidates = feArgs.limit ? deduplicated.slice(0, feArgs.limit) : deduplicated;
      for (const candidate of candidates)
        Object.assign(candidate, {
          origin_entity_id: candidate.id,
          canonical_id: canonicalMatches.get(candidate.id)!.id,
          canonical_name: canonicalMatches.get(candidate.id)!.name,
        });

      if (candidates.length > 0) {
        const entIds = candidates.map((c) => canonicalMatches.get(c.id)!.id);
        const placeholders = entIds.map(() => '?').join(',');
        const fieldRows =
          (
            await db
              .prepare(
                `SELECT entity_id, field_name, state, value_text, value_json, provenance, revision, updated_at, candidate_event_ids_json, last_confirmed_value_text
           FROM entity_state
           WHERE workspace_id = ? AND entity_id IN (${placeholders})`,
              )
              .bind(workspaceId, ...entIds)
              .all<{
                entity_id: string;
                field_name: string;
                state: string;
                value_text: string | null;
                value_json: string | null;
                provenance: string;
                revision: number;
                updated_at: string;
                candidate_event_ids_json: string | null;
                last_confirmed_value_text: string | null;
              }>()
          ).results || [];

        const fieldsByEntity: Record<string, Record<string, unknown>> = {};
        for (const fr of fieldRows) {
          const entityFields = fieldsByEntity[fr.entity_id] ?? (fieldsByEntity[fr.entity_id] = {});
          let val: unknown = fr.value_text;
          if (fr.value_json) {
            try {
              val = JSON.parse(fr.value_json);
            } catch {
              /* keep text */
            }
          }
          let candIds: unknown = undefined;
          if (fr.candidate_event_ids_json) {
            try {
              candIds = JSON.parse(fr.candidate_event_ids_json);
            } catch {
              candIds = undefined;
            }
          }
          entityFields[fr.field_name] = {
            state: fr.state,
            value: fr.state === 'disputed' ? null : val,
            provenance: fr.provenance,
            revision: fr.revision,
            updated_at: fr.updated_at,
            candidate_event_ids: candIds,
            last_confirmed_value: fr.last_confirmed_value_text,
          };
        }

        for (const cand of candidates) {
          (cand as unknown as Record<string, unknown>).fields =
            fieldsByEntity[canonicalMatches.get(cand.id)!.id] || {};
        }
        if (matchResult.bestMatch) {
          (matchResult.bestMatch as unknown as Record<string, unknown>).fields =
            fieldsByEntity[
              canonicalMatches.get(matchResult.bestMatch.id)?.id ?? matchResult.bestMatch.id
            ] || {};
        }
      }

      return {
        status: 'applied',
        action_id: actionId,
        data: {
          candidates,
          bestMatch: matchResult.bestMatch
            ? candidates.find(
                (c) =>
                  canonicalMatches.get(c.id)?.id ===
                  canonicalMatches.get(matchResult.bestMatch!.id)?.id,
              )
            : undefined,
          isAmbiguous: candidates.length > 1 && matchResult.isAmbiguous,
          ambiguityReason: candidates.length > 1 ? matchResult.ambiguityReason : undefined,
        },
      };
    }

    case 'search_workspace_history': {
      try {
        return {
          status: 'applied',
          action_id: actionId,
          data: await searchWorkspaceHistory(
            db,
            workspaceId,
            actorUserId,
            args as SearchWorkspaceHistoryArgs,
          ),
        };
      } catch (error) {
        if (!(error instanceof HistoryReadError)) throw error;
        return {
          status: 'rejected',
          action_id: actionId,
          error: { code: error.code, message: error.message },
        };
      }
    }
    case 'read_source': {
      try {
        return {
          status: 'applied',
          action_id: actionId,
          data: await readWorkspaceMessageSource(
            db,
            workspaceId,
            actorUserId,
            (args as { source_id: string }).source_id,
          ),
        };
      } catch (error) {
        if (!(error instanceof HistoryReadError)) throw error;
        return { status: 'rejected', error: { code: error.code, message: error.message } };
      }
    }
    case 'read_document': {
      try {
        return {
          status: 'applied',
          action_id: actionId,
          data: await readDocument(
            { DB: db, STORAGE: params.storage },
            workspaceId,
            actorUserId,
            args as { media_id: string; cursor?: string; limit?: number },
          ),
        };
      } catch (error) {
        return {
          status: 'rejected',
          error: {
            code: 'document_unavailable',
            message: error instanceof Error ? error.message : 'Document unavailable.',
          },
        };
      }
    }
    case 'document_start': {
      try {
        const res = await startDocument(
          { DB: db, STORAGE: params.storage, PDF_QUEUE: params.pdfQueue, BROWSER: params.browser } as unknown as Env,
          workspaceId,
          actorUserId,
          chatId ?? '',
          runId ?? null,
          args as DocumentStartArgs,
        );
        return { status: 'applied', action_id: actionId, data: res };
      } catch (err) {
        return {
          status: 'rejected',
          action_id: actionId,
          error: {
            code: 'document_start_failed',
            message: err instanceof Error ? err.message : 'Failed to start document.',
          },
        };
      }
    }
    case 'document_write_section': {
      try {
        const res = await writeDocumentSections(
          { DB: db, STORAGE: params.storage, PDF_QUEUE: params.pdfQueue, BROWSER: params.browser } as unknown as Env,
          workspaceId,
          args as DocumentWriteSectionArgs,
        );
        return { status: 'applied', action_id: actionId, data: res };
      } catch (err) {
        return {
          status: 'rejected',
          action_id: actionId,
          error: {
            code: 'document_write_failed',
            message: err instanceof Error ? err.message : 'Failed to write document section.',
          },
        };
      }
    }
    case 'document_publish': {
      try {
        const res = await publishDocument(
          { DB: db, STORAGE: params.storage, PDF_QUEUE: params.pdfQueue, BROWSER: params.browser } as unknown as Env,
          workspaceId,
          args as DocumentPublishArgs,
        );
        return { status: 'applied', action_id: actionId, data: res };
      } catch (err) {
        return {
          status: 'rejected',
          action_id: actionId,
          error: {
            code: 'document_publish_failed',
            message: err instanceof Error ? err.message : 'Failed to publish document.',
          },
        };
      }
    }
    case 'query': {
      try {
        const qArgs = args as QueryToolArgs;
      if (qArgs.resource === 'merge_preview') {
        const sourceEntityId = qArgs.filters?.entity_id ?? qArgs.entity_id;
        const targetEntityId = qArgs.filters?.target_entity_id ?? qArgs.target_entity_id;
        if (!sourceEntityId || !targetEntityId) {
          return {
            status: 'rejected',
            action_id: actionId,
            error: {
              code: 'missing_argument',
              message: 'Both entity_id and target_entity_id are required for merge preview.',
            },
          };
        }
        const member = await db
          .prepare('SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?')
          .bind(workspaceId, actorUserId)
          .first();
        if (!member)
          return { status: 'rejected', error: { code: 'not_found', message: 'Files not found.' } };
        const { state } = await getBusinessProjectionState(
          db,
          workspaceId,
          [sourceEntityId, targetEntityId],
          true,
        );
        const preview = previewEntityMerge(
          state,
          sourceEntityId,
          targetEntityId,
        );
        return preview
          ? {
              status: 'applied',
              action_id: actionId,
              data: { ...preview, expected_revision: effectiveExpectedRevision },
            }
          : {
              status: 'rejected',
              action_id: actionId,
              error: {
                code: 'invalid_merge',
                message: 'Choose two different clients in this workspace.',
              },
            };
      }
      if (qArgs.resource === 'entity_file') {
        const entityId = qArgs.filters?.entity_id ?? qArgs.entity_id;
        if (!entityId) {
          return {
            status: 'rejected',
            action_id: actionId,
            error: {
              code: 'missing_argument',
              message: 'entity_id is required for entity_file.',
            },
          };
        }
        try {
          return {
            status: 'applied',
            action_id: actionId,
            data: await readEntityFile(db, workspaceId, actorUserId, entityId, {
              author_user_id: qArgs.filters?.author_user_id,
              from: qArgs.filters?.from,
              to: qArgs.filters?.to,
              include_removed: qArgs.filters?.include_removed,
              section: qArgs.section,
              order: qArgs.order as 'occurred' | 'recorded' | undefined,
              limit: qArgs.limit,
              cursor: qArgs.cursor,
            }),
          };
        } catch (error) {
          if (error instanceof FileReadError) {
            return {
              status: 'rejected',
              action_id: actionId,
              error: { code: error.code, message: error.message },
            };
          }
          return {
            status: 'rejected',
            action_id: actionId,
            error: { code: 'query_error', message: error instanceof Error ? error.message : String(error) },
          };
        }
      }
      if (qArgs.resource === 'interactions') {
        const data = await readCurrentInteractions(db, workspaceId, {
          entity_id: qArgs.filters?.entity_id,
          interaction_id: qArgs.filters?.interaction_id,
          kind: qArgs.filters?.kind as 'note' | 'visit' | 'contact' | 'quote' | undefined,
          text: qArgs.filters?.text,
          limit: qArgs.limit,
          cursor: qArgs.cursor,
          author_user_id: qArgs.filters?.author_user_id,
          from: qArgs.filters?.from,
          to: qArgs.filters?.to,
        });
        return { status: 'applied', action_id: actionId, data };
      }
      if (qArgs.resource === 'records') {
        // Same shared reader as the route and dossier refreshes: lists,
        // columns with bindings, bounded rows with versions, and honest
        // cursors. Compact by default; fetch wider pages only when needed.
        const page = await readRecordsPage(db, workspaceId, {
          list: qArgs.filters?.list_id,
          limit: Math.min(Math.max(1, qArgs.limit ?? 20), 100),
          cursor: qArgs.cursor,
          search: qArgs.filters?.text ?? qArgs.text ?? '',
          sortParam: '',
        });
        return { status: 'applied', action_id: actionId, data: page };
      }
      if (qArgs.resource === 'documents') {
        const docs = await listChatDocuments(
          { DB: db, STORAGE: params.storage, PDF_QUEUE: params.pdfQueue, BROWSER: params.browser } as unknown as Env,
          workspaceId,
          actorUserId,
          qArgs.filters?.chat_id ?? chatId ?? '',
        );
        return { status: 'applied', action_id: actionId, data: docs };
      }
      if (qArgs.resource === 'members') {
        const members = await listMembers(db, workspaceId);
        return {
          status: 'applied',
          action_id: actionId,
          data: {
            members: members.map((m) => ({
              user_id: m.user_id,
              display_name: m.display_name,
              email: m.email,
              role: m.role,
              joined_at: m.joined_at,
            })),
            total: members.length,
          },
        };
      }
      if (qArgs.resource === 'search') {
        const queryText = qArgs.filters?.text || (qArgs as unknown as { text?: string; query?: string }).text || (qArgs as unknown as { text?: string; query?: string }).query || '';
        const limitPerCategory = Math.min(Math.max(1, qArgs.limit || 5), 20);
        const searchResults = await unifiedWorkspaceSearch(
          db,
          workspaceId,
          actorUserId,
          queryText,
          limitPerCategory,
        );
        return {
          status: 'applied',
          action_id: actionId,
          data: searchResults,
        };
      }
      if (qArgs.resource === 'duplicates') {
        const { results: allEntities } = await db
          .prepare(
            `SELECT id, name, kind, status,
                    (SELECT value_text FROM entity_state s WHERE s.workspace_id = entities.workspace_id AND s.entity_id = entities.id AND s.field_name = 'company' AND s.state = 'clear') AS company
             FROM entities
             WHERE workspace_id = ?
               AND NOT EXISTS (
                 SELECT 1 FROM entity_redirects redirect
                 WHERE redirect.workspace_id = entities.workspace_id
                   AND redirect.source_entity_id = entities.id
               )
             ORDER BY name ASC LIMIT 100`,
          )
          .bind(workspaceId)
          .all<{ id: string; name: string; kind?: string | null; status?: string | null; company?: string | null }>();

        const candidates: Array<{
          entity_a: { id: string; name: string; kind?: string | null; status?: string | null; company?: string | null };
          entity_b: { id: string; name: string; kind?: string | null; status?: string | null; company?: string | null };
          similarity: number;
          reason: string;
        }> = [];

        const ents = allEntities ?? [];
        for (let i = 0; i < ents.length; i++) {
          for (let j = i + 1; j < ents.length; j++) {
            const ea = ents[i]!;
            const eb = ents[j]!;
            const normA = normalizeName(ea.name);
            const normB = normalizeName(eb.name);
            if (!normA || !normB) continue;

            const maxLen = Math.max(normA.length, normB.length);
            const dist = levenshteinDistance(normA, normB);
            const score = 1 - dist / maxLen;

            const isSubstring = (normA.length >= 3 && normB.includes(normA)) || (normB.length >= 3 && normA.includes(normB));

            if (score >= 0.75 || (isSubstring && Math.abs(normA.length - normB.length) <= 5)) {
              candidates.push({
                entity_a: { id: ea.id, name: ea.name, kind: ea.kind, status: ea.status, company: ea.company },
                entity_b: { id: eb.id, name: eb.name, kind: eb.kind, status: eb.status, company: eb.company },
                similarity: Math.round(Math.max(score, isSubstring ? 0.8 : 0) * 100) / 100,
                reason: score >= 0.9 ? 'Nearly identical names' : isSubstring ? 'Name variation or suffix' : 'Similar spelling',
              });
            }
          }
        }

        return {
          status: 'applied',
          action_id: actionId,
          data: {
            candidates: candidates.slice(0, 20),
            total_candidates: candidates.length,
          },
        };
      }
      const limit = qArgs.limit || 25;

      if (qArgs.resource === 'entities') {
        let sql = `SELECT id, name, kind, CASE WHEN (SELECT state FROM entity_state f WHERE f.workspace_id = entities.workspace_id AND f.entity_id = entities.id AND f.field_name = 'status') = 'disputed' THEN 'disputed' ELSE COALESCE((SELECT value_text FROM entity_state f WHERE f.workspace_id = entities.workspace_id AND f.entity_id = entities.id AND f.field_name = 'status'), status) END AS status,
          CASE WHEN (SELECT state FROM entity_state f WHERE f.workspace_id = entities.workspace_id AND f.entity_id = entities.id AND f.field_name = 'assigned_user_id') = 'disputed' THEN NULL ELSE assigned_user_id END AS assigned_user_id,
          CASE WHEN (SELECT state FROM entity_state f WHERE f.workspace_id = entities.workspace_id AND f.entity_id = entities.id AND f.field_name = 'assigned_user_id') = 'disputed' THEN 'Disputed' ELSE (SELECT display_name FROM users WHERE id = entities.assigned_user_id) END AS assigned_name,
          created_at, updated_at FROM entities WHERE workspace_id = ? AND NOT EXISTS (SELECT 1 FROM entity_redirects redirect WHERE redirect.workspace_id = entities.workspace_id AND redirect.source_entity_id = entities.id)`;
        const binds: unknown[] = [workspaceId];
        if (qArgs.filters?.entity_id) {
          sql += ` AND id = ?`;
          binds.push(
            (await canonicalEntityId(db, workspaceId, qArgs.filters.entity_id)) ?? '__missing__',
          );
        }
        if (qArgs.filters?.kind) {
          sql += ` AND kind = ?`;
          binds.push(qArgs.filters.kind);
        }
        if (qArgs.filters?.entity_status) {
          sql += ` AND status = ?`;
          sql += ` AND COALESCE((SELECT state FROM entity_state f WHERE f.workspace_id = entities.workspace_id AND f.entity_id = entities.id AND f.field_name = 'status'), 'clear') != 'disputed'`;
          binds.push(qArgs.filters.entity_status);
        }
        if (qArgs.filters?.assignee_user_id) {
          sql += ` AND assigned_user_id = ?`;
          sql += ` AND COALESCE((SELECT state FROM entity_state f WHERE f.workspace_id = entities.workspace_id AND f.entity_id = entities.id AND f.field_name = 'assigned_user_id'), 'clear') != 'disputed'`;
          binds.push(qArgs.filters.assignee_user_id);
        }
        if (qArgs.cursor) {
          sql += ` AND id > ?`;
          binds.push(qArgs.cursor);
        }
        sql += ` ORDER BY id ASC LIMIT ?`;
        binds.push(limit);
        const rows =
          (
            await db
              .prepare(sql)
              .bind(...binds)
              .all()
          ).results || [];
        if (rows.length > 0) {
          const entityIds = rows.map((r) => String(r.id));
          const placeholders = entityIds.map(() => '?').join(',');
          const fieldRows =
            (
              await db
                .prepare(
                  `SELECT entity_id, field_name, state, value_text, value_json, provenance, revision, updated_at, candidate_event_ids_json, last_confirmed_value_text
             FROM entity_state
             WHERE workspace_id = ? AND entity_id IN (${placeholders})`,
                )
                .bind(workspaceId, ...entityIds)
                .all<{
                  entity_id: string;
                  field_name: string;
                  state: string;
                  value_text: string | null;
                  value_json: string | null;
                  provenance: string;
                  revision: number;
                  updated_at: string;
                  candidate_event_ids_json: string | null;
                  last_confirmed_value_text: string | null;
                }>()
            ).results || [];

          const fieldsByEntity: Record<string, Record<string, unknown>> = {};
          for (const fr of fieldRows) {
            const entityFields =
              fieldsByEntity[fr.entity_id] ?? (fieldsByEntity[fr.entity_id] = {});
            let val: unknown = fr.value_text;
            if (fr.value_json) {
              try {
                val = JSON.parse(fr.value_json);
              } catch {
                /* keep text */
              }
            }
            let candIds: unknown = undefined;
            if (fr.candidate_event_ids_json) {
              try {
                candIds = JSON.parse(fr.candidate_event_ids_json);
              } catch {
                candIds = undefined;
              }
            }
            entityFields[fr.field_name] = {
              state: fr.state,
              value: fr.state === 'disputed' ? null : val,
              provenance: fr.provenance,
              revision: fr.revision,
              updated_at: fr.updated_at,
              candidate_event_ids: candIds,
              last_confirmed_value: fr.last_confirmed_value_text,
            };
          }

          for (const row of rows) {
            (row as Record<string, unknown>).fields = fieldsByEntity[String(row.id)] || {};
          }
        }
        return { status: 'applied', action_id: actionId, data: rows };
      }

      if (qArgs.resource === 'tasks') {
        if (qArgs.order === 'overdue_first' || qArgs.filters?.overdue_only) {
          try {
            return {
              status: 'applied',
              action_id: actionId,
              data: await readWork(db, workspaceId, actorUserId, {
                filters: qArgs.filters,
                limit: qArgs.limit,
                cursor: qArgs.cursor,
              }),
            };
          } catch (error) {
            return {
              status: 'rejected',
              error: {
                code: 'invalid_work_page',
                message: error instanceof Error ? error.message : 'Work unavailable.',
              },
            };
          }
        }
        let sql = `SELECT id, entity_id, title, assignee_user_id, status, due_kind, due_local_date, due_instant, due_timezone, snooze_until, revision, created_at, updated_at FROM tasks WHERE workspace_id = ?`;
        const binds: unknown[] = [workspaceId];
        if (qArgs.filters?.task_status) {
          sql += ` AND status = ?`;
          binds.push(qArgs.filters.task_status);
        }
        if (qArgs.filters?.entity_id) {
          sql = `${ENTITY_FAMILY_SQL} ${sql} AND entity_id IN (SELECT id FROM family)`;
          binds.unshift(...familyBinds(workspaceId, qArgs.filters.entity_id));
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
        const rows =
          (
            await db
              .prepare(sql)
              .bind(...binds)
              .all()
          ).results || [];
        return { status: 'applied', action_id: actionId, data: rows };
      }

      if (qArgs.resource === 'events') {
        let sql = `SELECT e.id, e.sequence, e.entity_id, e.kind, e.payload_json, e.occurred_at,
          e.recorded_at, e.channel, e.provenance, e.actor_user_id, u.display_name AS actor_name, e.source_message_id,
          e.supersedes_event_id, e.reverts_event_id,
          i.root_event_id AS interaction_id, i.head_event_id AS current_head_event_id,
          i.state AS interaction_state,
          EXISTS (SELECT 1 FROM events r WHERE r.workspace_id = e.workspace_id AND r.kind = 'revert'
            AND (r.reverts_event_id = e.id OR json_extract(r.payload_json, '$.target_event_id') = e.id)) AS is_reverted
          FROM events e LEFT JOIN users u ON u.id = e.actor_user_id LEFT JOIN interaction_state i ON i.workspace_id = e.workspace_id
            AND i.root_event_id = CASE WHEN e.kind = 'interaction_removed' THEN json_extract(e.payload_json, '$.root_event_id')
              WHEN e.kind IN ('note', 'visit', 'contact', 'quote') THEN COALESCE(json_extract(e.payload_json, '$.interaction_id'), e.id) ELSE NULL END
          WHERE e.workspace_id = ?`;
        const binds: unknown[] = [workspaceId];
        if (qArgs.filters?.entity_id) {
          sql = `${ENTITY_FAMILY_SQL} ${sql} AND e.entity_id IN (SELECT id FROM family)`;
          binds.unshift(...familyBinds(workspaceId, qArgs.filters.entity_id));
        }
        if (qArgs.filters?.event_kind) {
          sql += ` AND e.kind = ?`;
          binds.push(qArgs.filters.event_kind);
        }
        if (qArgs.filters?.author_user_id) {
          sql += ' AND e.actor_user_id = ?';
          binds.push(qArgs.filters.author_user_id);
        }
        if (qArgs.filters?.from) {
          sql += ' AND e.occurred_at >= ?';
          binds.push(qArgs.filters.from);
        }
        if (qArgs.filters?.to) {
          sql += ' AND e.occurred_at < ?';
          binds.push(qArgs.filters.to);
        }
        if (qArgs.cursor) {
          const seq = Number(qArgs.cursor);
          if (!Number.isNaN(seq)) {
            sql += ` AND e.sequence < ?`;
            binds.push(seq);
          }
        }
        sql += ` ORDER BY e.sequence DESC LIMIT ?`;
        binds.push(limit);
        const rows =
          (
            await db
              .prepare(sql)
              .bind(...binds)
              .all()
          ).results || [];
        return { status: 'applied', action_id: actionId, data: rows };
      }

      if (qArgs.resource === 'drafts') {
        let sql = `SELECT id, entity_id, channel, recipient_address, content_text, status, revision, created_at, updated_at FROM draft_projections WHERE workspace_id = ?`;
        const binds: unknown[] = [workspaceId];
        if (qArgs.filters?.entity_id) {
          sql = `${ENTITY_FAMILY_SQL} ${sql} AND entity_id IN (SELECT id FROM family)`;
          binds.unshift(...familyBinds(workspaceId, qArgs.filters.entity_id));
        }
        if (qArgs.cursor) {
          sql += ` AND id > ?`;
          binds.push(qArgs.cursor);
        }
        sql += ` ORDER BY id ASC LIMIT ?`;
        binds.push(limit);
        const rows =
          (
            await db
              .prepare(sql)
              .bind(...binds)
              .all()
          ).results || [];
        return { status: 'applied', action_id: actionId, data: rows };
      }

      if (qArgs.resource === 'attachments') {
        if (qArgs.filters?.entity_id) {
          try {
            return {
              status: 'applied',
              action_id: actionId,
              data: await readEntityFile(db, workspaceId, actorUserId, qArgs.filters.entity_id, {
                include_removed: qArgs.filters?.include_removed,
                section: 'attachments',
                limit: qArgs.limit,
                cursor: qArgs.cursor,
              }),
            };
          } catch (error) {
            return {
              status: 'rejected',
              error: {
                code: 'attachments_unavailable',
                message: error instanceof Error ? error.message : 'Files unavailable.',
              },
            };
          }
        }
        if (!chatId) {
          return {
            status: 'rejected',
            action_id: actionId,
            error: {
              code: 'missing_chat',
              message: 'Attachments can only be listed inside a conversation.',
            },
          };
        }
        try {
          return {
            status: 'applied',
            action_id: actionId,
            data: await readChatAttachments(db, workspaceId, actorUserId, chatId, {
              ...qArgs.filters,
              limit: qArgs.limit,
              cursor: qArgs.cursor,
            }),
          };
        } catch (error) {
          return {
            status: 'rejected',
            error: {
              code: 'invalid_attachment_page',
              message: error instanceof Error ? error.message : 'Files unavailable.',
            },
          };
        }
      }
      if (qArgs.resource === 'followups') {
        try {
          return {
            status: 'applied',
            action_id: actionId,
            data: await readFollowUps(db, workspaceId, actorUserId, {
              limit: qArgs.limit,
              cursor: qArgs.cursor,
            }),
          };
        } catch (error) {
          return {
            status: 'rejected',
            error: {
              code: 'followups_unavailable',
              message: error instanceof Error ? error.message : 'Follow-ups unavailable.',
            },
          };
        }
      }

      if (qArgs.resource === 'lead_overview') {
        // Purpose-built lead report read: full-set counts, deterministic
        // overdue-first order, explicit page cursors. One shared function
        // serves the tool and read-only pagination alike.
        const page = await readLeadOverview(db, {
          workspaceId,
          actorUserId,
          filters: {
            ...(qArgs.filters?.status ? { status: qArgs.filters.status } : {}),
            ...(qArgs.filters?.overdue_only ? { overdue_only: true } : {}),
            ...(qArgs.filters?.without_next_step ? { without_next_step: true } : {}),
          },
          columns: qArgs.filters?.columns as LeadOverviewColumn[] | undefined,
          limit: qArgs.limit,
          cursor: qArgs.cursor,
        });
        return { status: 'applied', action_id: actionId, data: page };
      }

      return {
        status: 'rejected',
        action_id: actionId,
        error: { code: 'invalid_resource', message: `Unknown resource '${qArgs.resource}'.` },
      };
      } catch (err: unknown) {
        return {
          status: 'rejected',
          action_id: actionId,
          error: {
            code: 'query_error',
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    }

    case 'view_image': {
      // Read-only image load by durable receipt. Checks current membership
      // scope (workspace), source chat ownership and retention state, then
      // returns references only: the handler hydrates pixels ephemerally for
      // the next provider request. No ledger event, no chat message.
      const vArgs = args as ViewImageToolArgs;
      if (!chatId) {
        return {
          status: 'rejected',
          action_id: actionId,
          error: {
            code: 'missing_chat',
            message: 'Images can only be viewed inside a conversation.',
          },
        };
      }
      const imageRow = await db
        .prepare(
          `SELECT m.id AS media_id, a.chat_message_id AS chat_message_id,
              cm.sequence AS sequence, m.format AS format, m.state AS state,
              m.expires_at AS expires_at, m.retained, SUBSTR(cm.content_text, 1, 160) AS excerpt
           FROM media_objects m
           LEFT JOIN message_image_attachments a ON a.media_id = m.id AND a.workspace_id = m.workspace_id
           LEFT JOIN chat_messages cm ON cm.id = a.chat_message_id AND cm.workspace_id = m.workspace_id
           WHERE m.workspace_id = ? AND m.id = ? AND (cm.chat_id = ? OR EXISTS (SELECT 1 FROM attachment_links l WHERE l.media_id = m.id AND l.workspace_id = m.workspace_id AND l.state = 'active'))
             AND EXISTS (SELECT 1 FROM workspace_users member WHERE member.workspace_id = m.workspace_id AND member.user_id = ?)
           LIMIT 1`,
        )
        .bind(workspaceId, vArgs.media_id, chatId, actorUserId)
        .first<{
          media_id: string;
          chat_message_id: string;
          sequence: number;
          format: string | null;
          state: string;
          expires_at: string;
          retained: number;
          excerpt: string | null;
        }>();
      if (!imageRow) {
        return {
          status: 'rejected',
          action_id: actionId,
          error: {
            code: 'unknown_image',
            message:
              'No such image in this conversation. List retained images with the attachments query first.',
          },
        };
      }
      const readable =
        (imageRow.format === 'image/jpeg' ||
          imageRow.format === 'image/png' ||
          imageRow.format === 'image/webp') &&
        imageRow.state === 'validated' &&
        (imageRow.retained === 1 || imageRow.expires_at > new Date().toISOString());
      if (!readable) {
        return {
          status: 'rejected',
          action_id: actionId,
          error: {
            code: 'image_unavailable',
            message: `That image is no longer readable (state ${imageRow.state}). Say so plainly instead of describing it.`,
          },
        };
      }
      return {
        status: 'applied',
        action_id: actionId,
        data: {
          media_id: imageRow.media_id,
          chat_message_id: imageRow.chat_message_id,
          sequence: imageRow.sequence,
          format: imageRow.format,
          available: true,
          requested_detail: vArgs.detail ?? 'standard',
          excerpt: imageRow.excerpt ?? '',
        },
      };
    }

    case 'search_memory': {
      const smArgs = args as SearchMemoryToolArgs;
      const limit = smArgs.limit || 12;
      const entitySubject = smArgs.subject_id && smArgs.scope === 'entity';

      const ftsQuery = sanitizeFtsQuery(smArgs.query);
      let rows: Record<string, unknown>[] = [];

      if (ftsQuery) {
        // Suppressed entries never surface, and another member's private
        // notes never surface: both predicates live inside the query so the
        // LIMIT applies to visible rows, not rows discarded afterwards.
        let ftsSql = `${entitySubject ? ENTITY_FAMILY_SQL : ''}
          SELECT m.id, m.scope, m.subject_id, m.category, m.content, m.status, m.observed_at, m.created_at, m.business_revision
          FROM memory_entries_fts f
          JOIN memory_entries m ON m.id = f.entry_id
          WHERE m.workspace_id = ? AND m.status = 'active'
            AND NOT EXISTS (SELECT 1 FROM memory_suppressions s WHERE s.workspace_id = m.workspace_id AND s.target_memory_id = m.id)
            AND (m.scope != 'member_in_workspace' OR m.subject_id = ?)
            AND memory_entries_fts MATCH ?
        `;
        const ftsBinds: unknown[] = [
          ...(entitySubject ? familyBinds(workspaceId, smArgs.subject_id!) : []),
          workspaceId,
          actorUserId,
          ftsQuery,
        ];
        if (smArgs.scope) {
          ftsSql += ` AND m.scope = ?`;
          ftsBinds.push(smArgs.scope);
        }
        if (smArgs.subject_id) {
          ftsSql += entitySubject
            ? ' AND m.subject_id IN (SELECT id FROM family)'
            : ' AND m.subject_id = ?';
          if (!entitySubject) ftsBinds.push(smArgs.subject_id);
        }
        ftsSql += ` ORDER BY m.observed_at DESC LIMIT ?`;
        ftsBinds.push(limit);

        try {
          rows =
            (
              await db
                .prepare(ftsSql)
                .bind(...ftsBinds)
                .all()
            ).results || [];
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (
            msg.includes('fts5') ||
            msg.includes('syntax') ||
            msg.includes('no such table') ||
            msg.includes('MATCH')
          ) {
            rows = [];
          } else {
            throw err;
          }
        }
      }

      // If FTS returned 0 rows or query was not FTS-compatible, fall back to LIKE search
      if (rows.length === 0) {
        let likeSql = `${entitySubject ? ENTITY_FAMILY_SQL : ''}
          SELECT id, scope, subject_id, category, content, status, observed_at, created_at, business_revision
          FROM memory_entries
          WHERE workspace_id = ? AND status = 'active' AND content LIKE ?
            AND NOT EXISTS (SELECT 1 FROM memory_suppressions s WHERE s.workspace_id = memory_entries.workspace_id AND s.target_memory_id = memory_entries.id)
            AND (scope != 'member_in_workspace' OR subject_id = ?)
        `;
        const likeBinds: unknown[] = [
          ...(entitySubject ? familyBinds(workspaceId, smArgs.subject_id!) : []),
          workspaceId,
          `%${smArgs.query.trim()}%`,
          actorUserId,
        ];
        if (smArgs.scope) {
          likeSql += ` AND scope = ?`;
          likeBinds.push(smArgs.scope);
        }
        if (smArgs.subject_id) {
          likeSql += entitySubject
            ? ' AND subject_id IN (SELECT id FROM family)'
            : ' AND subject_id = ?';
          if (!entitySubject) likeBinds.push(smArgs.subject_id);
        }
        likeSql += ` ORDER BY observed_at DESC LIMIT ?`;
        likeBinds.push(limit);

        rows =
          (
            await db
              .prepare(likeSql)
              .bind(...likeBinds)
              .all()
          ).results || [];
      }

      return { status: 'applied', action_id: actionId, data: rows };
    }

    case 'get_memory': {
      const gmArgs = args as GetMemoryToolArgs;
      const row = await db
        .prepare(
          `SELECT id, scope, subject_id, category, content, status, provenance, source_event_id, source_message_id, author_user_id, observed_at, created_at, business_revision
           FROM memory_entries WHERE workspace_id = ? AND id = ?
             AND (scope != 'member_in_workspace' OR subject_id = ?)
             AND EXISTS (SELECT 1 FROM workspace_users WHERE workspace_id = memory_entries.workspace_id AND user_id = ?)`,
        )
        .bind(workspaceId, gmArgs.memory_id, actorUserId, actorUserId)
        .first();

      if (!row) {
        return {
          status: 'rejected',
          action_id: actionId,
          error: { code: 'not_found', message: `Memory entry '${gmArgs.memory_id}' not found.` },
        };
      }
      // Forgotten, superseded or otherwise inactive entries are never
      // returned as current facts: the read reports their state instead of
      // their content, so a stale id cannot resurrect discarded memory.
      const entry = row as Record<string, unknown>;
      if (entry['status'] !== 'active') {
        return {
          status: 'rejected',
          action_id: actionId,
          error: {
            code: 'memory_inactive',
            message: `Memory entry '${gmArgs.memory_id}' is no longer active (status: ${String(entry['status'])}).`,
          },
        };
      }
      const suppressed = await db
        .prepare(
          `SELECT 1 FROM memory_suppressions WHERE workspace_id = ? AND target_memory_id = ?`,
        )
        .bind(workspaceId, gmArgs.memory_id)
        .first();
      if (suppressed) {
        return {
          status: 'rejected',
          action_id: actionId,
          error: {
            code: 'memory_inactive',
            message: `Memory entry '${gmArgs.memory_id}' is no longer active (forgotten).`,
          },
        };
      }
      return { status: 'applied', action_id: actionId, data: row };
    }

    case 'read_chat_history': {
      const rhArgs = args as ReadChatHistoryToolArgs;
      const targetChatId = rhArgs.chat_id ?? chatId ?? null;
      if (!targetChatId) {
        return {
          status: 'rejected',
          action_id: actionId,
          error: { code: 'missing_chat', message: 'No current chat: pass an explicit chat_id.' },
        };
      }
      // Workspace-scoped existence: chats are member-visible, but a chat
      // from another workspace (or a deleted one) resolves to not_found,
      // never to leaked rows.
      const chatRow = await db
        .prepare(`SELECT id FROM chats WHERE workspace_id = ? AND id = ?`)
        .bind(workspaceId, targetChatId)
        .first();
      if (!chatRow) {
        return {
          status: 'rejected',
          action_id: actionId,
          error: {
            code: 'not_found',
            message: `Chat '${targetChatId}' not found in this workspace.`,
          },
        };
      }
      const limit = rhArgs.limit ?? 20;
      const rows =
        (
          await db
            .prepare(
              `SELECT id, author_kind, author_user_id, content_text, run_id, sequence, created_at
           FROM chat_messages
           WHERE workspace_id = ? AND chat_id = ? ${rhArgs.before_sequence ? 'AND sequence < ?' : ''}
           ORDER BY sequence DESC LIMIT ?`,
            )
            .bind(
              ...(rhArgs.before_sequence
                ? ([workspaceId, targetChatId, rhArgs.before_sequence, limit] as unknown[])
                : ([workspaceId, targetChatId, limit] as unknown[])),
            )
            .all<Record<string, unknown>>()
        ).results || [];
      const messages = [...rows].reverse();
      const oldest = messages.length > 0 ? Number(messages[0]!['sequence']) : null;
      return {
        status: 'applied',
        action_id: actionId,
        data: {
          chat_id: targetChatId,
          messages: messages.map((m) => ({
            id: String(m['id']),
            author_kind: m['author_kind'],
            author_user_id: m['author_user_id'] ? String(m['author_user_id']) : null,
            content_text: String(m['content_text']),
            run_id: m['run_id'] ? String(m['run_id']) : null,
            sequence: Number(m['sequence']),
            created_at: String(m['created_at']),
          })),
          older: oldest !== null && oldest > 1 ? oldest : null,
        },
      };
    }

    // --- Reminder Tools: confirmed one-off delivery, not a task due date.
    // Creation, change and cancellation all scope to the acting member's
    // own pending rows; the sweep delivers through the existing chat and
    // Telegram owners.
    case 'create_reminder': {
      const crArgs = args as CreateReminderToolArgs;
      const created = await createReminder(db, {
        workspaceId,
        userId: actorUserId,
        chatId: chatId ?? null,
        actionId,
        text: crArgs.text,
        at: crArgs.at,
        timezone: crArgs.timezone ?? null,
        channel: crArgs.channel,
        nowIso: new Date().toISOString(),
      });
      if (created.status === 'rejected') {
        return {
          status: 'rejected',
          action_id: actionId,
          error: { code: created.code, message: created.message },
        };
      }
      return {
        status: 'applied',
        action_id: actionId,
        data: { reminder_id: created.reminder.id, remind_at: created.reminder.remind_at },
        summary:
          created.status === 'already'
            ? 'Reminder already set for that time.'
            : `Reminder set for ${created.reminder.remind_at}.`,
      };
    }

    case 'update_reminder': {
      const urArgs = args as UpdateReminderToolArgs;
      const updated = await updateReminder(db, {
        workspaceId,
        userId: actorUserId,
        reminderId: urArgs.reminder_id,
        ...(urArgs.text !== undefined ? { text: urArgs.text } : {}),
        ...(urArgs.at !== undefined ? { at: urArgs.at } : {}),
        ...(urArgs.timezone !== undefined ? { timezone: urArgs.timezone } : {}),
        ...(urArgs.channel !== undefined ? { channel: urArgs.channel } : {}),
        nowIso: new Date().toISOString(),
      });
      if (updated.status === 'rejected') {
        return {
          status: 'rejected',
          action_id: actionId,
          error: { code: updated.code, message: updated.message },
        };
      }
      return {
        status: 'applied',
        action_id: actionId,
        data: { reminder_id: updated.reminder.id, remind_at: updated.reminder.remind_at },
        summary: `Reminder updated for ${updated.reminder.remind_at}.`,
      };
    }

    case 'cancel_reminder': {
      const crArgs = args as CancelReminderToolArgs;
      const cancelled = await cancelReminder(db, {
        workspaceId,
        userId: actorUserId,
        reminderId: crArgs.reminder_id,
        nowIso: new Date().toISOString(),
      });
      if (cancelled.status === 'rejected') {
        return {
          status: 'rejected',
          action_id: actionId,
          error: { code: cancelled.code, message: cancelled.message },
        };
      }
      return {
        status: 'applied',
        action_id: actionId,
        data: { reminder_id: cancelled.reminder.id },
        summary:
          cancelled.status === 'already'
            ? 'Reminder was already cancelled.'
            : 'Reminder cancelled.',
      };
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
          fencedContext:
            runId && fence !== undefined
              ? {
                  runId,
                  stepId,
                  fence,
                  actionId,
                  sourceMessageId,
                  maxDailyActions: params.maxDailyActions,
                }
              : undefined,
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

    // --- Thinking Controls Tool ---
    case 'set_chat_thinking': {
      const stArgs = args as SetChatThinkingToolArgs;
      if (!chatId) {
        return {
          status: 'rejected',
          action_id: actionId,
          error: { code: 'missing_chat', message: 'Chat ID required to set thinking effort.' },
        };
      }
      const chatRow = await db
        .prepare(
          `SELECT c.author_user_id, c.model_override, s.default_model
           FROM chats c
           LEFT JOIN workspace_settings s ON s.workspace_id = c.workspace_id
           WHERE c.id = ? AND c.workspace_id = ?`,
        )
        .bind(chatId, workspaceId)
        .first<{
          author_user_id: string;
          model_override: string | null;
          default_model: string | null;
        }>();

      if (!chatRow || chatRow.author_user_id !== actorUserId) {
        return {
          status: 'rejected',
          action_id: actionId,
          error: {
            code: 'unauthorized',
            message: 'Only the chat author can configure thinking controls for this conversation.',
          },
        };
      }

      const effectiveModelKey = chatRow.model_override ?? chatRow.default_model ?? '';
      const entry = PRODUCTION_REGISTRY.entries.find((e) => e.commandKey === effectiveModelKey);
      if (!entry) {
        return {
          status: 'rejected',
          action_id: actionId,
          error: { code: 'model_not_found', message: `Model '${effectiveModelKey}' not found.` },
        };
      }

      if (stArgs.level === 'default') {
        await db
          .prepare(
            `UPDATE chats SET thinking_override_json = NULL WHERE id = ? AND workspace_id = ? AND author_user_id = ?`,
          )
          .bind(chatId, workspaceId, actorUserId)
          .run();
        return {
          status: 'applied',
          action_id: actionId,
          summary: `Thinking level reset to Provider default for ${entry.displayName} in this chat.`,
        };
      }

      if (entry.thinking?.state === 'unsupported') {
        return {
          status: 'rejected',
          action_id: actionId,
          error: {
            code: 'unsupported',
            message: `${entry.displayName} has no adjustable thinking control. It uses provider default.`,
          },
        };
      }

      if (entry.thinking?.state === 'unverified' || !entry.thinking) {
        return {
          status: 'rejected',
          action_id: actionId,
          error: {
            code: 'unverified',
            message: `Thinking controls have not been verified for ${entry.displayName}. It uses provider default.`,
          },
        };
      }

      const choice = entry.thinking.choices.find(
        (c) => c.id.toLowerCase() === stArgs.level.toLowerCase(),
      );
      if (!choice) {
        const available = entry.thinking.choices.map((c) => c.label).join(', ');
        return {
          status: 'rejected',
          action_id: actionId,
          error: {
            code: 'invalid_choice',
            message: `Unknown thinking level '${stArgs.level}'. Available choices for ${entry.displayName}: ${available}.`,
          },
        };
      }

      const thinkingOverride = { model_key: entry.commandKey, choice_id: choice.id };
      await db
        .prepare(
          `UPDATE chats SET thinking_override_json = ? WHERE id = ? AND workspace_id = ? AND author_user_id = ?`,
        )
        .bind(JSON.stringify(thinkingOverride), chatId, workspaceId, actorUserId)
        .run();

      return {
        status: 'applied',
        action_id: actionId,
        summary: `Thinking set to ${choice.label} for ${entry.displayName} in this chat. It applies to your next message.`,
      };
    }

    case 'set_chat_model': {
      const smArgs = args as SetChatModelToolArgs;
      if (!chatId) {
        return {
          status: 'rejected',
          action_id: actionId,
          error: { code: 'missing_chat', message: 'Chat ID required to set model.' },
        };
      }
      const chatRow = await db
        .prepare(`SELECT author_user_id FROM chats WHERE id = ? AND workspace_id = ?`)
        .bind(chatId, workspaceId)
        .first<{ author_user_id: string }>();

      if (!chatRow || chatRow.author_user_id !== actorUserId) {
        return {
          status: 'rejected',
          action_id: actionId,
          error: {
            code: 'unauthorized',
            message: 'Only the chat author can configure the model for this conversation.',
          },
        };
      }

      const rawInput = smArgs.model.trim();
      if (rawInput.toLowerCase() === 'default') {
        await db
          .prepare(
            `UPDATE chats SET model_override = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?`,
          )
          .bind(new Date().toISOString(), chatId, workspaceId)
          .run();
        return {
          status: 'applied',
          action_id: actionId,
          summary: 'This chat now follows the workspace default model.',
        };
      }

      const resolvedKey = resolveModelAlias(rawInput);
      const entry = PRODUCTION_REGISTRY.entries.find((e) => e.commandKey === resolvedKey);
      if (!entry) {
        return {
          status: 'rejected',
          action_id: actionId,
          error: { code: 'unknown_model', message: `Model '${rawInput}' is not recognized.` },
        };
      }

      await db
        .prepare(
          `UPDATE chats SET model_override = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`,
        )
        .bind(entry.commandKey, new Date().toISOString(), chatId, workspaceId)
        .run();

      return {
        status: 'applied',
        action_id: actionId,
        summary: `Switched conversation model to ${entry.displayName}.`,
      };
    }

    case 'execute_command': {
      const ecArgs = args as ExecuteCommandToolArgs;
      if (!chatId) {
        return {
          status: 'rejected',
          action_id: actionId,
          error: { code: 'missing_chat', message: 'Chat ID required to execute command.' },
        };
      }
      const chatRow = await getChat(db, workspaceId, chatId);
      if (!chatRow || chatRow.author_user_id !== actorUserId) {
        return {
          status: 'rejected',
          action_id: actionId,
          error: {
            code: 'unauthorized',
            message: 'Only the chat author can execute commands in this conversation.',
          },
        };
      }

      const cmdText = ecArgs.command_text.startsWith('/')
        ? ecArgs.command_text
        : `/${ecArgs.command_text}`;
      const outcome = await executeCommand(
        { db, workspaceId, userId: actorUserId, surface: 'web' },
        chatRow,
        cmdText,
      );

      if (outcome.kind === 'reply') {
        for (const effect of outcome.effects) {
          if (effect.type === 'set_chat_model') {
            await db
              .prepare(
                `UPDATE chats SET model_override = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`,
              )
              .bind(effect.commandKey, new Date().toISOString(), effect.chatId, workspaceId)
              .run();
          } else if (effect.type === 'set_chat_thinking') {
            await db
              .prepare(
                `UPDATE chats SET thinking_override_json = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`,
              )
              .bind(
                effect.thinkingOverride ? JSON.stringify(effect.thinkingOverride) : null,
                new Date().toISOString(),
                effect.chatId,
                workspaceId,
              )
              .run();
          }
        }
        return {
          status: 'applied',
          action_id: actionId,
          summary: outcome.text,
        };
      }

      return {
        status: 'rejected',
        action_id: actionId,
        error: { code: 'command_failed', message: 'Command could not be executed.' },
      };
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
      const nameTrim = (ueArgs.name || '').trim();
      const likePattern = `%${nameTrim}%`;

      // Match first to avoid near-duplicates (SOL-22 bounded candidates)
      const entitiesRows =
        (
          await db
            .prepare(
              `SELECT id, name FROM entities WHERE workspace_id = ? AND (name LIKE ? OR id = ?) LIMIT 100`,
            )
            .bind(workspaceId, likePattern, nameTrim)
            .all<{ id: string; name: string }>()
        ).results || [];

      const candidateEntities = entitiesRows;
      if (candidateEntities.length < 25) {
        const fallbackRows =
          (
            await db
              .prepare(
                `SELECT id, name FROM entities WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 50`,
              )
              .bind(workspaceId)
              .all<{ id: string; name: string }>()
          ).results || [];
        const seenIds = new Set(candidateEntities.map((r) => r.id));
        for (const row of fallbackRows) {
          if (!seenIds.has(row.id)) {
            candidateEntities.push(row);
            seenIds.add(row.id);
          }
        }
      }

      const aliasesRows =
        (
          await db
            .prepare(
              `SELECT id, entity_id, alias FROM entity_aliases WHERE workspace_id = ? AND (alias LIKE ? OR entity_id = ?) LIMIT 100`,
            )
            .bind(workspaceId, likePattern, nameTrim)
            .all<{ id: string; entity_id: string; alias: string }>()
        ).results || [];

      const matchRes = rankEntityMatches(ueArgs.name, candidateEntities, aliasesRows);
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

    case 'delete_entity': {
      const deArgs = args as DeleteEntityToolArgs;
      const target = await db
        .prepare(`SELECT id, name FROM entities WHERE workspace_id = ? AND id = ?`)
        .bind(workspaceId, deArgs.entity_id)
        .first<{ id: string; name: string }>();
      if (!target) {
        return {
          status: 'rejected',
          action_id: actionId,
          error: {
            code: 'not_found',
            message: `Entity '${deArgs.entity_id}' not found in this workspace. Find it first with find_entities.`,
          },
        };
      }
      // Irreversible by editing, so the member always confirms first. The
      // confirmed answer resumes this exact operation with confirm set.
      return {
        status: 'needs_clarification',
        action_id: actionId,
        clarification: {
          prompt: `Delete '${target.name}' and all of its details (fields, tasks, drafts, notes)? Reply yes to confirm.`,
          missing_fields: ['confirm'],
          candidates: ['yes', 'no'],
          pending_operation: {
            version: 1,
            command_name: 'delete_entity',
            action_id: actionId,
            args: { entity_id: target.id, reason: deArgs.reason ?? null },
            missing_fields: ['confirm'],
            candidates: ['yes', 'no'],
            source_revision: effectiveExpectedRevision,
          },
        },
      };
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

    case 'revise_interaction': {
      const riArgs = args as ReviseInteractionToolArgs;
      return executeLedgerCommand(
        db,
        ledgerContext,
        'revise_interaction',
        riArgs,
        DEFAULT_COMMAND_HANDLERS['revise_interaction']!,
        undefined,
        { deferRunTransition: true },
      );
    }

    case 'remove_interaction': {
      const rmArgs = args as RemoveInteractionToolArgs;
      return executeLedgerCommand(
        db,
        ledgerContext,
        'remove_interaction',
        rmArgs,
        DEFAULT_COMMAND_HANDLERS['remove_interaction']!,
        undefined,
        { deferRunTransition: true },
      );
    }

    case 'set_fields': {
      const sfArgs = args as SetFieldsToolArgs;
      const childItems = sfArgs.fields.map((item) => ({
        entity_id: sfArgs.entity_id,
        field_name: item.field_name,
        value: item.value,
        provenance: item.provenance,
      }));

      // Legacy compatibility: an in-flight request from the old per-field
      // loop may already have `<parent>_f<N>` receipts without a parent
      // receipt. Match workspace, command and exact child payload hash —
      // never a suffix alone — then finish only the remainder sequentially.
      const childActionIds = childItems.map((_, i) => `${actionId}_f${i}`);
      const childReceipts = await getActionReceiptsByIds(db, workspaceId, childActionIds);
      const receiptByActionId = new Map(childReceipts.map((r) => [r.action_id, r]));
      const committedChildIndexes = new Set<number>();
      for (let i = 0; i < childItems.length; i++) {
        const receipt = receiptByActionId.get(childActionIds[i]!);
        if (!receipt) continue;
        const expectedHash = await sha256(
          JSON.stringify({ commandName: 'set_field', args: childItems[i] }),
        );
        if (receipt.command_name !== 'set_field' || receipt.payload_hash !== expectedHash) {
          return {
            status: 'conflict',
            action_id: actionId,
            error: {
              code: 'action_conflict',
              message: `Action ID '${childActionIds[i]}' already committed with a different payload.`,
            },
          };
        }
        if (receipt.result_status === 'applied' || receipt.result_status === 'already_applied') {
          committedChildIndexes.add(i);
        }
      }

      if (committedChildIndexes.size === childItems.length && childItems.length > 0) {
        const committedRevision = Math.max(
          ...[...committedChildIndexes].map(
            (i) => receiptByActionId.get(childActionIds[i]!)!.committed_revision,
          ),
        );
        return {
          status: 'applied',
          action_id: actionId,
          committed_revision: committedRevision,
          summary: `Updated fields: ${sfArgs.fields.map((f) => f.field_name).join(', ')} (previously committed).`,
        };
      }

      if (committedChildIndexes.size > 0) {
        // Narrow legacy completion: the resume floor is the higher of the
        // request revision and the highest verified child revision. The live
        // revision must equal it exactly — anything above is an unexplained
        // teammate change and conflicts instead of silently rebasing.
        // Sequential by necessity, never claimed atomic.
        const matchedMaxRev = Math.max(
          ...[...committedChildIndexes].map(
            (i) => receiptByActionId.get(childActionIds[i]!)!.committed_revision,
          ),
        );
        const liveRevRow = await db
          .prepare(`SELECT business_revision FROM workspaces WHERE id = ?`)
          .bind(workspaceId)
          .first<{ business_revision: number }>();
        const liveRev = Number(liveRevRow?.business_revision ?? effectiveExpectedRevision);
        const floor = Math.max(effectiveExpectedRevision, matchedMaxRev);
        if (liveRev !== floor) {
          return {
            status: 'conflict',
            action_id: actionId,
            error: {
              code: 'revision_conflict',
              message: `Workspace revision ${liveRev} is not explained by the ${committedChildIndexes.size} verified prior child commit(s) from revision ${effectiveExpectedRevision}. Refetch and retry with a fresh revision.`,
            },
          };
        }
        let currentRevision = liveRev;
        const appliedFieldNames = childItems
          .filter((_, i) => committedChildIndexes.has(i))
          .map((item) => item.field_name);
        for (let i = 0; i < childItems.length; i++) {
          if (committedChildIndexes.has(i)) continue;
          const item = childItems[i]!;
          const childContext: LedgerCommandContext = {
            ...ledgerContext,
            action_id: childActionIds[i]!,
            expected_business_revision: currentRevision,
          };
          const res = await executeLedgerCommand(
            db,
            childContext,
            'set_field',
            {
              entity_id: item.entity_id,
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
              summary:
                appliedFieldNames.length > 0
                  ? `Applied fields [${appliedFieldNames.join(', ')}] (including previously committed work), but failed on '${item.field_name}': ${res.error?.message ?? res.summary}`
                  : (res.error?.message ?? res.summary),
            };
          }
        }
        return {
          status: 'applied',
          action_id: actionId,
          committed_revision: currentRevision,
          summary: `Updated fields: ${appliedFieldNames.join(', ')} (legacy sequential completion after previously committed work).`,
        };
      }

      // New parent batch path: one validated transaction, one receipt, one
      // business revision for the whole request.
      const batchRes = await executeLedgerCommand(
        db,
        ledgerContext,
        'set_fields',
        {
          entity_id: sfArgs.entity_id,
          fields: childItems.map((item) => ({
            field_name: item.field_name,
            value: item.value,
            provenance: item.provenance,
          })),
          explicit_status_indexes: explicitStatusIndexes ?? [],
        },
        DEFAULT_COMMAND_HANDLERS['set_fields']!,
        undefined,
        { deferRunTransition: true },
      );

      // Mixed commit: facts saved, uncertain status parked. Expose
      // needs_clarification with the committed revision/events so the run
      // parks normally while the saved work stays visible. Replays resolve
      // against the persisted question row: an open question re-parks (the
      // actor dedupes), a closed one returns the standing outcome, and a
      // rowless fresh park passes through untouched.
      if (batchRes.status === 'applied' || batchRes.status === 'already_applied') {
        if (!batchRes.clarification) return batchRes;
        const knownQ = await getQuestionByAction(db, workspaceId, actionId);
        if (!knownQ || knownQ.status === 'pending') {
          if (!knownQ) return batchRes;
          return {
            status: 'needs_clarification',
            action_id: actionId,
            committed_revision: batchRes.committed_revision,
            summary: batchRes.summary,
            clarification: batchRes.clarification,
            data: batchRes.data,
          };
        }
        return batchRes;
      }
      if (batchRes.status === 'needs_clarification' && batchRes.clarification) {
        // Question-only: a fresh park just created its row. A replay whose
        // question already resolved or cancelled must not park again.
        const knownQ = await getQuestionByAction(db, workspaceId, actionId);
        if (!knownQ || knownQ.status === 'pending') return batchRes;
        return {
          status: 'rejected',
          action_id: actionId,
          error: {
            code: 'already_resolved',
            message: 'That question was already answered; nothing remains to apply.',
          },
        };
      }
      return batchRes;
    }

    case 'change_contact':
      return executeLedgerCommand(
        db,
        ledgerContext,
        'change_contact',
        args as ChangeContactArgs,
        DEFAULT_COMMAND_HANDLERS['change_contact']!,
      );
    case 'link_attachment':
    case 'unlink_attachment':
    case 'update_attachment':
    case 'change_reminder_rule':
      return executeLedgerCommand(
        db,
        ledgerContext,
        toolName,
        args,
        DEFAULT_COMMAND_HANDLERS[toolName]!,
      );
    case 'merge_entities': {
      const explicit = isExplicitMergeIntent(sourceText);
      return executeLedgerCommand(
        db,
        { ...ledgerContext, merge_identity_confirmed: explicit },
        'merge_entities',
        args as MergeEntitiesArgs,
        DEFAULT_COMMAND_HANDLERS['merge_entities']!,
      );
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
      // Promise ranking is policy-derived from member words, never
      // model-supplied: an explicit "I promise" in the source marks the
      // task so the brief kernel ranks it first. Anything else stays an
      // ordinary task.
      return executeLedgerCommand(
        db,
        ledgerContext,
        'create_task',
        { ...ctArgs, is_promise: isExplicitPromise(sourceText).isPromise },
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
      const canonical = dmArgs.entity_id
        ? await canonicalEntityId(db, workspaceId, dmArgs.entity_id)
        : null;
      if (dmArgs.entity_id) {
        const contacts =
          (
            await db
              .prepare(
                `${ENTITY_FAMILY_SQL} SELECT id, method, value, is_primary, state FROM entity_contacts WHERE workspace_id = ? AND entity_id IN (SELECT id FROM family) AND state != 'removed'`,
              )
              .bind(...familyBinds(workspaceId, dmArgs.entity_id), workspaceId)
              .all<{
                id: string;
                method: string;
                value: string;
                is_primary: number;
                state: string;
              }>()
          ).results ?? [];
        const relevant = contacts.filter((c) =>
          dmArgs.channel === 'email' ? c.method === 'email' : c.method === 'phone',
        );
        const selected = dmArgs.recipient
          ? relevant.find(
              (c) =>
                contactComparison(c.method as 'phone' | 'email', c.value) ===
                contactComparison(c.method as 'phone' | 'email', dmArgs.recipient!),
            )
          : undefined;
        const primaries = relevant.filter((c) => c.is_primary && c.state === 'active');
        if (
          selected?.state === 'disputed' ||
          (relevant.length > 1 &&
            (!selected ||
              (!sourceText.includes(selected.value) &&
                (primaries.length !== 1 || primaries[0]!.id !== selected.id))))
        )
          return {
            status: 'needs_clarification',
            clarification: {
              prompt: 'Which contact should this draft be addressed to?',
              missing_fields: ['recipient'],
              candidates: relevant.filter((c) => c.state === 'active').map((c) => c.value),
            },
          };
      }
      const dispute = await checkDraftDisputedValues(db, workspaceId, canonical, dmArgs.content);
      if (dispute.inDispute) {
        return {
          status: 'needs_clarification',
          action_id: actionId,
          clarification: {
            prompt: `Field '${dispute.fieldName}' is currently in dispute (competing values: ${dispute.disputedValues?.join(', ')}). It cannot be used as settled content in an outward draft without explicit confirmation.`,
            missing_fields: ['dispute_confirmation'],
            candidates: ['confirm_disputed_value', 'change_content'],
          },
        };
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
      if (udArgs.content) {
        const existingDraft = await db
          .prepare(`SELECT entity_id FROM draft_projections WHERE workspace_id = ? AND id = ?`)
          .bind(workspaceId, udArgs.draft_id)
          .first<{ entity_id: string | null }>();
        const dispute = await checkDraftDisputedValues(
          db,
          workspaceId,
          existingDraft?.entity_id ?? null,
          udArgs.content,
        );
        if (dispute.inDispute) {
          return {
            status: 'needs_clarification',
            action_id: actionId,
            clarification: {
              prompt: `Field '${dispute.fieldName}' is currently in dispute (competing values: ${dispute.disputedValues?.join(', ')}). It cannot be used as settled content in an outward draft without explicit confirmation.`,
              missing_fields: ['dispute_confirmation'],
              candidates: ['confirm_disputed_value', 'change_content'],
            },
          };
        }
      }
      return executeLedgerCommand(
        db,
        ledgerContext,
        'record_draft',
        {
          draft_id: udArgs.draft_id,
          content_text: udArgs.content,
          recipient_address: udArgs.recipient,
          expected_revision: udArgs.expected_revision,
        },
        DEFAULT_COMMAND_HANDLERS['record_draft']!,
        undefined,
        { deferRunTransition: true },
      );
    }

    case 'mark_message_sent': {
      const mmsArgs = args as MarkMessageSentToolArgs;
      // An absent source confirms nothing: without member words, marking
      // sent would fabricate a completion record. Clarify instead.
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
      // The confirmation must not name a different recipient than the
      // draft's: a mismatched target is about another send. A missing draft
      // is left for the ledger command's own not_found rejection.
      const draftTarget = await db
        .prepare(
          `SELECT recipient_address FROM draft_projections WHERE workspace_id = ? AND id = ?`,
        )
        .bind(workspaceId, mmsArgs.draft_id)
        .first<{ recipient_address: string | null }>();
      if (draftTarget) {
        const targetCheck = sentConfirmationMatchesTarget(
          sourceText,
          draftTarget.recipient_address,
        );
        if (!targetCheck.matches) {
          return {
            status: 'needs_clarification',
            action_id: actionId,
            clarification: {
              prompt: `${targetCheck.reason} Which message did you send?`,
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
          const chatRuns =
            (
              await db
                .prepare(`SELECT id FROM agent_runs WHERE workspace_id = ? AND chat_id = ?`)
                .bind(workspaceId, chatId)
                .all<{ id: string }>()
            ).results || [];
          const runIdSet = new Set(chatRuns.map((r) => r.id));

          const chatMsgs =
            (
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
                  ((a.run_id && runIdSet.has(a.run_id)) ||
                    (a.source_message_id && msgIdSet.has(a.source_message_id))),
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
            error: {
              code: 'no_actions_to_undo',
              message: 'No eligible actions to undo in current chat.',
            },
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
        (ctx, state, seq, undoReq) =>
          handleUndoCommit(ctx, allEvents, allActions, state, seq, undoReq),
        undefined,
        { deferRunTransition: true },
      );
    }

    case 'edit_records': {
      const erArgs = args as EditRecordsToolArgs;
      // Saved target (or no records turn): commit through the guarded ledger
      // exactly like a manual Save, with a retry-stable save identity.
      return executeLedgerCommand(
        db,
        ledgerContext,
        'records_batch',
        {
          save_id: `save_${actionId}`,
          action_id: actionId,
          list_id: erArgs.list_id,
          chunk_index: 0,
          chunk_count: 1,
          operations: erArgs.operations,
        },
        DEFAULT_COMMAND_HANDLERS['records_batch']!,
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

async function checkDraftDisputedValues(
  db: D1Database,
  workspaceId: string,
  entityId: string | null,
  draftContent: string,
): Promise<{ inDispute: boolean; fieldName?: string; disputedValues?: string[] }> {
  if (entityId) entityId = await canonicalEntityId(db, workspaceId, entityId);
  const query = entityId
    ? db
        .prepare(
          `SELECT field_name, candidate_event_ids_json, last_confirmed_value_text FROM entity_state WHERE workspace_id = ? AND entity_id = ? AND state = 'disputed'`,
        )
        .bind(workspaceId, entityId)
    : db
        .prepare(
          `SELECT field_name, candidate_event_ids_json, last_confirmed_value_text FROM entity_state WHERE workspace_id = ? AND state = 'disputed'`,
        )
        .bind(workspaceId);
  const disputedRows =
    (
      await query.all<{
        field_name: string;
        candidate_event_ids_json: string | null;
        last_confirmed_value_text: string | null;
      }>()
    ).results || [];

  for (const row of disputedRows) {
    const candidateIds: string[] = row.candidate_event_ids_json
      ? (JSON.parse(row.candidate_event_ids_json) as string[])
      : [];

    const candidateValues: string[] = [];

    if (candidateIds.length > 0) {
      const placeholders = candidateIds.map(() => '?').join(',');
      const candidateEvents =
        (
          await db
            .prepare(
              `SELECT kind, payload_json FROM events WHERE workspace_id = ? AND id IN (${placeholders})`,
            )
            .bind(workspaceId, ...candidateIds)
            .all<{ kind: string; payload_json: string }>()
        ).results || [];

      for (const evt of candidateEvents) {
        try {
          const payload = JSON.parse(evt.payload_json) as Record<string, unknown>;
          if (evt.kind === 'quote') {
            const amount = payload['amount'];
            const currency = payload['currency'] ? String(payload['currency']) : '';
            if (typeof amount === 'number') {
              candidateValues.push(String(amount));
              if (amount >= 100 && amount % 100 === 0) {
                const major = amount / 100;
                candidateValues.push(String(major));
                candidateValues.push(major.toLocaleString());
              }
              if (currency) {
                candidateValues.push(`${amount} ${currency}`);
                if (amount >= 100 && amount % 100 === 0) {
                  const major = amount / 100;
                  candidateValues.push(`${major} ${currency}`);
                  candidateValues.push(`${major}${currency}`);
                }
              }
            } else if (typeof amount === 'string') {
              candidateValues.push(amount);
            }
          } else if (evt.kind === 'field_change') {
            const val = payload['new_value'];
            if (val !== undefined && val !== null) {
              if (typeof val === 'object' && val !== null) {
                const innerAmount = (val as Record<string, unknown>)['amount'];
                if (typeof innerAmount === 'number') {
                  candidateValues.push(String(innerAmount));
                  if (innerAmount >= 100 && innerAmount % 100 === 0) {
                    candidateValues.push(String(innerAmount / 100));
                  }
                }
                candidateValues.push(JSON.stringify(val));
              } else {
                candidateValues.push(String(val));
              }
            }
          }
        } catch {
          // ignore malformed payload
        }
      }
    }

    if (row.last_confirmed_value_text) {
      candidateValues.push(row.last_confirmed_value_text);
    }

    const contentLower = draftContent.toLowerCase();
    for (const val of candidateValues) {
      const cleanVal = val.trim();
      if (!cleanVal || cleanVal.length < 2) continue;
      const isNum = /^\d+[\d,.]*$/.test(cleanVal);
      if (isNum) {
        const escaped = cleanVal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const numRegex = new RegExp(`(?:^|[^0-9a-zA-Z])${escaped}(?:$|[^0-9a-zA-Z])`, 'i');
        if (numRegex.test(draftContent)) {
          return {
            inDispute: true,
            fieldName: row.field_name,
            disputedValues: Array.from(new Set(candidateValues)),
          };
        }
      } else if (contentLower.includes(cleanVal.toLowerCase())) {
        return {
          inDispute: true,
          fieldName: row.field_name,
          disputedValues: Array.from(new Set(candidateValues)),
        };
      }
    }
  }

  return { inDispute: false };
}
