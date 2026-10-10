/**
 * @otis/ledger/commands/recordsBatch
 * Pure composition command handler for `records_batch`.
 * Composes existing source handlers (entity, contact, interaction, task, draft)
 * with records definition and custom row operations.
 * In accordance with plans/editable-records.md Sections 5, 8, and 12.
 *
 * Atomicity: the whole chunk validates before any effect; any rejected,
 * conflicted, or clarification-needing op ends the chunk with zero events.
 * No-op cell writes are skipped without events, revision, or quota effect.
 * Unknown ops, duplicate lifecycle creates, missing lifecycle targets, and
 * read-only bindings reject explicitly instead of reporting success.
 */

import type {
  CellBinding,
  CommandResult,
  LedgerEvent,
  RecordRef,
  RecordValue,
  TaskDue,
  TaskStatus,
  LeadStatus,
} from '@otis/contracts';
import { validateRecordEdit, validateRecordValue } from '@otis/contracts';
import type { LedgerCommandContext, LedgerProjectionState, RecordsBatchArgs } from '../types.js';
import { createLedgerEvent } from './events.js';
import { collectCalculationRefs, fieldStorageType } from '@otis/contracts';
import { formatQuoteText } from '../reducers/fields.js';
import { reduceRecords, ensureRecordsState } from '../reducers/records.js';
import { reduceEntity } from '../reducers/entities.js';
import { reduceBusinessDetails } from '../reducers/business.js';
import { handleCreateEntity } from './createEntity.js';
import { handleDeleteEntity } from './deleteEntity.js';
import { handleSetField } from './setField.js';
import { handleChangeContact } from './contacts.js';
import { handleCreateTask, handleUpdateTask } from './tasks.js';
import { handleRecordDraft } from './recordDraft.js';
import { handleLogEvent } from './logEvent.js';
import { handleReviseInteraction, handleRemoveInteraction } from './interactions.js';

export interface RecordsBatchResultData {
  save_id: string;
  affected_count: number;
  conflict?: {
    op_id: string;
    target_ref: RecordRef;
    base_token?: string;
    current_token?: string;
    reason: string;
  };
  affected_values?: Array<{ row_ref: RecordRef; column_id: string; value: RecordValue; version: string }>;
  id_mappings?: Record<string, string>;
}

function resolveBinding(
  workspaceId: string,
  state: LedgerProjectionState,
  listId: string,
  columnId: string,
  rowRefKind?: string,
): CellBinding {
  // 1. Check custom column definitions
  const colKey = `${workspaceId}:${columnId}`;
  const customCol = state.recordsListColumns?.get(colKey);
  if (customCol?.core_binding_json) {
    try {
      return JSON.parse(customCol.core_binding_json) as CellBinding;
    } catch {
      // fallback
    }
  }

  // 2. Check built-in bindings
  const normalized = columnId.toLowerCase().replace(/^[^:]+:/, '');

  if (listId === 'leads' || rowRefKind === 'entity') {
    if (normalized === 'name') return { kind: 'entity_property', property: 'name' };
    if (normalized === 'status') return { kind: 'entity_property', property: 'status' };
    if (normalized === 'assigned_user_id' || normalized === 'owner') {
      return { kind: 'entity_property', property: 'assigned_user_id' };
    }
    if (normalized === 'phone') return { kind: 'entity_contact', method: 'phone' };
    if (normalized === 'email') return { kind: 'entity_contact', method: 'email' };
    if (normalized === 'quote' || normalized === 'value' || normalized === 'deal_value') {
      return { kind: 'interaction', property: 'latest_quote' };
    }
    if (normalized === 'latest_note' || normalized === 'notes') {
      return { kind: 'interaction', property: 'latest_note' };
    }
    return { kind: 'entity_field', field_id: columnId, field_name: normalized };
  }

  if (listId === 'tasks' || rowRefKind === 'task') {
    if (normalized === 'title') return { kind: 'task_property', property: 'title' };
    if (normalized === 'status') return { kind: 'task_property', property: 'status' };
    if (normalized === 'due') return { kind: 'task_property', property: 'due' };
    if (normalized === 'assignee_user_id' || normalized === 'assignee') {
      return { kind: 'task_property', property: 'assignee_user_id' };
    }
    return { kind: 'task_property', property: 'title' };
  }

  if (listId === 'drafts' || rowRefKind === 'draft') {
    if (normalized === 'content_text' || normalized === 'content') {
      return { kind: 'draft_property', property: 'content_text' };
    }
    if (normalized === 'channel') return { kind: 'draft_property', property: 'channel' };
    if (normalized === 'recipient_address' || normalized === 'recipient') {
      return { kind: 'draft_property', property: 'recipient_address' };
    }
    return { kind: 'draft_property', property: 'content_text' };
  }

  if (listId === 'notes' || rowRefKind === 'interaction') {
    return { kind: 'interaction', property: 'latest_note' };
  }

  return { kind: 'custom_row_value', column_id: columnId };
}

/**
 * Display-only columns carry real source bindings for inspection, but saving
 * through them would corrupt the source (e.g. writing a formatted next
 * action into a task title). Only custom lists accept every column; the
 * built-ins restrict saves to their true editors.
 */
const READ_ONLY_COLUMNS: Record<string, Set<string>> = {
  leads: new Set(['next_action', 'kind']),
  tasks: new Set(['entity']),
  drafts: new Set(['entity']),
  notes: new Set(['date', 'type', 'entity', 'actor']),
};

function readOnlyColumnMessage(listId: string, columnId: string): string | null {
  if (READ_ONLY_COLUMNS[listId]?.has(columnId)) {
    return `Column '${columnId}' is read-only. Open the underlying entry to change it.`;
  }
  return null;
}

/**
 * Build a strict quote payload from a semantic cell value. Typed currency
 * objects are validated exactly (minor units, 3-letter code, offered or
 * expected role). A finite number is read as minor units and plain numeric
 * text as major units, both taking the column's currency when known and USD
 * otherwise. Display-formatted text (symbols, role words) is not
 * reverse-parsed: those cells need the typed quote editor, not a guess.
 */
function toQuotePayload(
  value: RecordValue,
  defaultCurrency: string,
): { payload?: Record<string, unknown>; error?: string } {
  if (typeof value === 'object' && value !== null && 'amount' in value && 'currency' in value) {
    const amount = (value as { amount?: unknown }).amount;
    const currency = (value as { currency?: unknown }).currency;
    const role = (value as { role?: unknown }).role;
    if (!Number.isSafeInteger(amount) || (amount as number) < 0) {
      return { error: 'Quote amount must be non-negative integer minor units.' };
    }
    if (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency.trim())) {
      return { error: 'Quote currency must be a 3-letter code.' };
    }
    if (role !== undefined && role !== 'offered' && role !== 'expected') {
      return { error: 'Quote role must be offered or expected.' };
    }
    return {
      payload: {
        amount,
        currency: (currency as string).trim().toUpperCase(),
        role: role === 'expected' ? 'expected' : 'offered',
      },
    };
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return { error: 'Quote value must be a non-negative number.' };
    return { payload: { amount: Math.round(value), currency: defaultCurrency, role: 'offered' } };
  }
  if (typeof value === 'string') {
    if (value.trim() === '') return { error: 'Quote value must not be empty.' };
    const numeric = Number(value.replace(/[^0-9.-]+/g, ''));
    if (!Number.isFinite(numeric) || numeric < 0) {
      return { error: `Cannot read a quote amount from '${value.slice(0, 80)}'.` };
    }
    return { payload: { amount: Math.round(numeric * 100), currency: defaultCurrency, role: 'offered' } };
  }
  return { error: 'Quote value must be a currency object, a number, or numeric text.' };
}

/** Semantic equality between a stored field row and an incoming value. */
function fieldValueEquals(
  current: { value_text: string | null; value_json: string | null } | undefined,
  value: RecordValue,
): boolean {
  if (!current) return false;
  if (value === null) return current.value_text === null && current.value_json === null;
  if (typeof value === 'string') return current.value_text === value && current.value_json === null;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return current.value_text === String(value);
  }
  return current.value_json === JSON.stringify(value);
}

/**
 * Latest active formatted head for an entity's quotes, used to recognize
 * identical re-saves. Null when the entity has no quote or its head cannot
 * be read, in which case the write applies. Latest notes always append a
 * new entry (there is no in-place value to converge on), so they skip this.
 */
function latestInteractionText(
  state: LedgerProjectionState,
  entityId: string,
  kind: 'note' | 'quote',
): string | null {
  let latest: { occurred_at: string; text: string } | null = null;
  for (const row of state.interactions.values()) {
    if (row.entity_id !== entityId || row.kind !== kind || row.state !== 'active' || !row.head_value_json) continue;
    try {
      const head = JSON.parse(row.head_value_json) as Record<string, unknown>;
      const text = kind === 'note'
        ? String(head['text'] ?? head['summary'] ?? head['notes'] ?? '')
        : (typeof head['amount'] === 'number' && typeof head['currency'] === 'string'
          ? formatQuoteText(head['amount'], head['currency'], String(head['role'] ?? 'offered'))
          : '');
      if (!text) continue;
      if (!latest || row.occurred_at >= latest.occurred_at) latest = { occurred_at: row.occurred_at, text };
    } catch {
      continue;
    }
  }
  return latest?.text ?? null;
}

/**
 * True when a cell.set would change nothing, so the batch can skip it
 * without emitting a business event, revision, or quota effect. Unknown or
 * ambiguous current state applies normally rather than being dropped.
 */
function isNoopCellEdit(
  workspaceId: string,
  state: LedgerProjectionState,
  rowRef: RecordRef,
  rowId: string,
  columnId: string,
  binding: CellBinding,
  value: RecordValue,
): boolean {
  if (binding.kind === 'entity_property') {
    const entity = state.entities.get(rowId);
    if (!entity) return false;
    if (binding.property === 'name') return entity.name === String(value ?? '');
    if (binding.property === 'status') return entity.status === String(value ?? '');
    if (binding.property === 'assigned_user_id') {
      return (entity.assigned_user_id ?? null) === (value === null ? null : String(value));
    }
    return false;
  }
  if (binding.kind === 'entity_field') {
    const field = state.fields.get(`${rowId}:${binding.field_name}`);
    if (!field) return value === null;
    return fieldValueEquals(field, value);
  }
  if (binding.kind === 'entity_contact') {
    const contacts = [...(state.contacts?.values() ?? [])].filter(
      (c) => c.entity_id === rowId && c.method === binding.method && c.state === 'active',
    );
    if (contacts.length === 0) return value === null || String(value ?? '') === '';
    if (value === null) return contacts.length === 0;
    if (contacts.length !== 1) return false;
    return contacts[0]!.value === String(value);
  }
  if (binding.kind === 'task_property') {
    const task = state.tasks.get(binding.task_id || rowId);
    if (!task) return false;
    if (binding.property === 'title') return task.title === String(value ?? '');
    if (binding.property === 'status') return task.status === String(value ?? '');
    if (binding.property === 'assignee_user_id') {
      return (task.assignee_user_id ?? null) === (value === null ? null : String(value));
    }
    if (binding.property === 'due') {
      if (value === null) return task.due_kind === null;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
      const due = value as Record<string, unknown>;
      if (due['kind'] === 'date') {
        return task.due_kind === 'date' && task.due_local_date === String(due['local_date'] ?? '');
      }
      if (due['kind'] === 'instant') {
        return task.due_kind === 'instant' && task.due_instant === String(due['at'] ?? '');
      }
      return false;
    }
    return false;
  }
  if (binding.kind === 'draft_property') {
    const draft = state.drafts.get(binding.draft_id || rowId);
    if (!draft) return false;
    if (binding.property === 'content_text') return draft.content_text === String(value ?? '');
    if (binding.property === 'channel') return draft.channel === String(value ?? '');
    if (binding.property === 'recipient_address') {
      return (draft.recipient_address ?? null) === (value === null ? null : String(value));
    }
    return false;
  }
  if (binding.kind === 'interaction' && rowRef.kind === 'interaction') {
    const row = state.interactions.get(rowId);
    if (!row?.head_value_json) return false;
    try {
      const head = JSON.parse(row.head_value_json) as Record<string, unknown>;
      const current = head['text'] ?? head['summary'] ?? head['notes'] ?? '';
      return typeof value === 'string' && current === value;
    } catch {
      return false;
    }
  }
  if (binding.kind === 'interaction' && binding.property === 'latest_note' && typeof value === 'string') {
    // Latest-note writes append a new entry by design; no stored value exists
    // to converge on, so identical text still logs once per explicit save.
    return false;
  }
  if (binding.kind === 'interaction' && binding.property === 'latest_quote') {
    const latest = latestInteractionText(state, rowId, 'quote');
    if (latest === null) return false;
    if (typeof value === 'string') return latest === value;
    const quote = toQuotePayload(value, '');
    if (!quote.payload) return false;
    const payload = quote.payload as { amount?: unknown; currency?: unknown; role?: unknown };
    return (
      typeof payload.amount === 'number' &&
      typeof payload.currency === 'string' &&
      latest === formatQuoteText(payload.amount, payload.currency, String(payload.role ?? 'offered'))
    );
  }
  if (binding.kind === 'custom_row_value') {
    const current = state.recordsValues?.get(`${workspaceId}:${rowId}:${columnId}`);
    if (!current) return value === null;
    return fieldValueEquals(current, value);
  }
  return false;
}

/** Task due shapes accepted from table editing. */
function isValidTaskDue(value: RecordValue): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const due = value as Record<string, unknown>;
  if (due['kind'] === 'date') {
    return typeof due['local_date'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(due['local_date']) &&
      typeof due['timezone'] === 'string' && !!due['timezone'];
  }
  if (due['kind'] === 'instant') {
    return typeof due['at'] === 'string' && Number.isFinite(Date.parse(due['at'])) &&
      typeof due['timezone'] === 'string' && !!due['timezone'];
  }
  return false;
}

/** A sub-handler result carries effects only when applied; anything else ends the whole chunk. */
function subHandlerFailed(result: { status: string }): boolean {
  return result.status !== 'applied' && result.status !== 'already_applied';
}

function rejected(message: string, code = 'validation_error'): {
  result: CommandResult<RecordsBatchResultData>;
  events: LedgerEvent[];
} {
  return {
    result: { status: 'rejected', error: { code, message } },
    events: [],
  };
}

interface BatchRunner {
  context: LedgerCommandContext;
  saveId: string;
  state: LedgerProjectionState;
  currentSeq: number;
  events: LedgerEvent[];
  affectedValues: Array<{ row_ref: RecordRef; column_id: string; value: RecordValue; version: string }>;
  idAliases: Map<string, string>;
}

function conflictOutcome(
  run: BatchRunner,
  opId: string,
  targetRef: RecordRef,
  baseToken: string,
  currentToken: string,
): { result: CommandResult<RecordsBatchResultData>; events: LedgerEvent[] } {
  return {
    result: {
      status: 'conflict',
      action_id: run.context.action_id,
      summary: 'This value changed while you edited. Review the saved value before overwriting it.',
      data: {
        save_id: run.saveId,
        affected_count: 0,
        conflict: {
          op_id: opId,
          target_ref: targetRef,
          base_token: baseToken,
          current_token: currentToken,
          reason: 'Concurrent modification.',
        },
      },
    },
    events: [],
  };
}

/**
 * Compare the submitted base precondition against the loaded current state.
 * Different-cell progress never conflicts: only the touched cell is
 * compared. A base matches when it equals the current version token OR the
 * current semantic value (legacy drafts send base values, newer readers
 * send version tokens). Same-millisecond timestamp collisions can never
 * hide a genuine value change.
 */
function checkBaseConflict(
  run: BatchRunner,
  opId: string,
  rowRef: RecordRef,
  rowId: string,
  columnId: string,
  binding: CellBinding,
  baseToken: string | undefined,
): { result: CommandResult<RecordsBatchResultData>; events: LedgerEvent[] } | null {
  if (!baseToken) return null;
  let token: string | null = null;
  let values: string[] = [];
  if (binding.kind === 'entity_property') {
    const entity = run.state.entities.get(rowId);
    if (!entity) return null;
    token = entity.updated_at;
    values = [
      binding.property === 'name' ? entity.name
        : binding.property === 'status' ? entity.status
          : (entity.assigned_user_id ?? ''),
    ];
  } else if (binding.kind === 'entity_field') {
    const field = run.state.fields.get(`${rowId}:${binding.field_name}`);
    if (!field) return null;
    token = field.updated_at;
    values = [field.value_text ?? '', field.value_json ?? ''];
  } else if (binding.kind === 'entity_contact') {
    const contacts = [...(run.state.contacts?.values() ?? [])].filter(
      (c) => c.entity_id === rowId && c.method === binding.method && c.state === 'active',
    );
    if (contacts.length === 0) return null;
    token = contacts[0]!.updated_at ?? entityUpdatedFallback(run, rowId);
    values = contacts.map((c) => c.value);
  } else if (binding.kind === 'task_property') {
    const task = run.state.tasks.get(binding.task_id || rowId);
    if (!task) return null;
    token = task.updated_at;
    values = [
      binding.property === 'title' ? task.title
        : binding.property === 'status' ? task.status
          : binding.property === 'assignee_user_id' ? (task.assignee_user_id ?? '')
            : taskDueFingerprint(task),
    ];
  } else if (binding.kind === 'draft_property') {
    const draft = run.state.drafts.get(binding.draft_id || rowId);
    if (!draft) return null;
    token = draft.updated_at;
    values = [
      binding.property === 'content_text' ? draft.content_text
        : binding.property === 'channel' ? draft.channel
          : (draft.recipient_address ?? ''),
    ];
  } else if (binding.kind === 'interaction' && rowRef.kind === 'interaction') {
    const row = run.state.interactions.get(rowId);
    if (!row) return null;
    token = row.head_event_id;
    values = [interactionHeadText(row.head_value_json)];
  } else if (binding.kind === 'custom_row_value') {
    const current = run.state.recordsValues?.get(`${run.context.workspace_id}:${rowId}:${columnId}`);
    if (!current) return null;
    token = current.updated_at;
    values = [current.value_text ?? '', current.value_json ?? ''];
  }
  if (token === null) return null;
  if (baseToken === token || values.includes(baseToken)) return null;
  return conflictOutcome(run, opId, rowRef, baseToken, token);
}

function entityUpdatedFallback(run: BatchRunner, rowId: string): string | null {
  return run.state.entities.get(rowId)?.updated_at ?? null;
}

function taskDueFingerprint(task: {
  due_kind: string | null;
  due_local_date: string | null;
  due_instant: string | null;
}): string {
  if (task.due_kind === 'date') return `date:${task.due_local_date ?? ''}`;
  if (task.due_kind === 'instant') return `instant:${task.due_instant ?? ''}`;
  return 'none';
}

function interactionHeadText(headValueJson: string | null): string {
  if (!headValueJson) return '';
  try {
    const head = JSON.parse(headValueJson) as Record<string, unknown>;
    const text = head['text'] ?? head['summary'] ?? head['notes'] ?? '';
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}

/**
 * Propagate a composed handler's non-applied outcome. Clarifications and
 * conflicts travel intact so the caller can ask or show mine/saved;
 * rejections keep their code and message.
 */
function propagateSubResult(
  result: { status: string; error?: { code: string; message: string } },
): { result: CommandResult<RecordsBatchResultData>; events: LedgerEvent[] } | null {
  if (!subHandlerFailed(result)) return null;
  if (result.status === 'needs_clarification' || result.status === 'conflict') {
    return { result: result as CommandResult<RecordsBatchResultData>, events: [] };
  }
  return {
    result: {
      status: 'rejected',
      error: result.error ?? { code: 'rejected', message: 'Composed operation was rejected.' },
    },
    events: [],
  };
}

function trackApplied(run: BatchRunner, rowRef: RecordRef, columnId: string, value: RecordValue): void {
  run.affectedValues.push({ row_ref: rowRef, column_id: columnId, value, version: String(run.currentSeq) });
}

/**
 * Apply one semantic cell value through its canonical source handler.
 * Returns a terminal chunk outcome, or null when the edit applied.
 */
function applyCellValue(
  run: BatchRunner,
  rowRef: RecordRef,
  columnId: string,
  binding: CellBinding,
  value: RecordValue,
  opId: string,
  baseToken?: string,
): { result: CommandResult<RecordsBatchResultData>; events: LedgerEvent[] } | null {
  const { context } = run;
  const rowId = rowRef.id;
  const fail = (message: string, code = 'validation_error') => rejected(`[op ${opId}] ${message}`, code);
  // Calculated columns are derived and read-only; editing an input restages
  // the output through the normal read, never through a direct write.
  if (binding.kind === 'custom_row_value') {
    const def = run.state.fieldDefinitions?.get(`${context.workspace_id}:${columnId}`);
    if (def?.calculation_json) {
      return fail('Calculated columns are read-only. Edit an input field instead.');
    }
  }
  const conflicted = checkBaseConflict(run, opId, rowRef, rowId, columnId, binding, baseToken);
  if (conflicted) return conflicted;

  if (binding.kind === 'entity_property') {
    const entity = run.state.entities.get(rowId);
    if (!entity) return fail(`Entity '${rowId}' not found.`, 'not_found');
    if (binding.property === 'kind') {
      return fail('Record type is display-only. It cannot be edited from the table.');
    }
    if (binding.property === 'name') {
      if (value === null || String(value).trim() === '') return fail('Name must not be empty.');
      const evt = createLedgerEvent(run.context, run.currentSeq++, {
        entity_id: rowId,
        kind: 'entity_renamed',
        payload: { new_name: String(value) },
      });
      run.events.push(evt);
      reduceEntity(run.state.entities, run.state.aliases, evt);
      trackApplied(run, rowRef, columnId, value);
      return null;
    }
    const fieldName = binding.property === 'status' ? 'status' : 'assigned_user_id';
    const res = handleSetField(run.context, run.state, run.currentSeq, {
      entity_id: rowId,
      field_name: fieldName,
      value,
    });
    const propagated = propagateSubResult(res.result);
    if (propagated) return propagated;
    run.events.push(...res.events);
    run.currentSeq += res.events.length;
    if (res.nextState) run.state = res.nextState;
    trackApplied(run, rowRef, columnId, value);
    return null;
  }

  if (binding.kind === 'entity_field') {
    const res = handleSetField(run.context, run.state, run.currentSeq, {
      entity_id: rowId,
      field_name: binding.field_name,
      value,
    });
    const propagated = propagateSubResult(res.result);
    if (propagated) return propagated;
    run.events.push(...res.events);
    run.currentSeq += res.events.length;
    if (res.nextState) run.state = res.nextState;
    trackApplied(run, rowRef, columnId, value);
    return null;
  }

  if (binding.kind === 'entity_contact') {
    if (!run.state.contacts) run.state.contacts = new Map();
    const res = handleChangeContact(run.context, run.state, run.currentSeq, {
      entity_id: rowId,
      contact_id: binding.contact_id,
      operation: value === null || String(value ?? '') === '' ? 'remove' : 'save',
      method: binding.method,
      value: String(value ?? ''),
    });
    const propagated = propagateSubResult(res.result);
    if (propagated) return propagated;
    run.events.push(...res.events);
    run.currentSeq += res.events.length;
    if (res.nextState) run.state = res.nextState;
    trackApplied(run, rowRef, columnId, value);
    return null;
  }

  if (binding.kind === 'task_property') {
    const taskId = binding.task_id || rowId;
    const patch: Record<string, unknown> = { task_id: taskId };
    if (binding.property === 'title') patch['title'] = String(value ?? '');
    else if (binding.property === 'status') {
      if (value !== 'open' && value !== 'done' && value !== 'cancelled') {
        return fail(`Invalid task status '${String(value)}'.`);
      }
      patch['status'] = value as TaskStatus;
    } else if (binding.property === 'due') {
      if (value !== null && !isValidTaskDue(value)) {
        return fail('Invalid task due: use null, {kind: date, local_date, timezone}, or {kind: instant, at, timezone}.');
      }
      patch['due'] = value as TaskDue;
    } else if (binding.property === 'assignee_user_id') {
      patch['assignee_user_id'] = value === null ? null : String(value);
    }
    const res = handleUpdateTask(run.context, run.state, run.currentSeq, patch as unknown as Parameters<typeof handleUpdateTask>[3]);
    const propagated = propagateSubResult(res.result);
    if (propagated) return propagated;
    run.events.push(...res.events);
    run.currentSeq += res.events.length;
    if (res.nextState) run.state = res.nextState;
    trackApplied(run, rowRef, columnId, value);
    return null;
  }

  if (binding.kind === 'draft_property') {
    const draftId = binding.draft_id || rowId;
    const patch: Record<string, unknown> = { draft_id: draftId };
    if (binding.property === 'content_text') patch['content_text'] = value === null ? '' : String(value);
    else if (binding.property === 'channel') patch['channel'] = value;
    else if (binding.property === 'recipient_address') {
      patch['recipient_address'] = value === null ? null : String(value);
    }
    const res = handleRecordDraft(run.context, run.state, run.currentSeq, patch as unknown as Parameters<typeof handleRecordDraft>[3]);
    const propagated = propagateSubResult(res.result);
    if (propagated) return propagated;
    run.events.push(...res.events);
    run.currentSeq += res.events.length;
    if (res.nextState) run.state = res.nextState;
    trackApplied(run, rowRef, columnId, value);
    return null;
  }

  if (binding.kind === 'interaction') {
    if (rowRef.kind === 'interaction') {
      const interRow = run.state.interactions.get(rowId);
      if (!interRow) return fail(`Interaction '${rowId}' not found.`, 'not_found');
      let payload: Record<string, unknown>;
      if (typeof value === 'object' && value !== null && !('amount' in value) && !('local_date' in value) && !('instant' in value)) {
        payload = value as Record<string, unknown>;
      } else if (interRow.kind === 'note' && typeof value === 'string') {
        if (!value.trim()) return fail('Note text must not be empty. Remove the entry instead of clearing it.');
        payload = { text: value };
      } else if (interRow.kind === 'quote') {
        const quote = toQuotePayload(value, 'USD');
        if (!quote.payload) return fail(quote.error ?? 'Invalid quote value.');
        payload = quote.payload;
      } else if (typeof value === 'string') {
        return fail(`Editing a ${interRow.kind} entry needs its typed fields. Open the entry to correct it.`);
      } else {
        return fail(`Unsupported value for a ${interRow.kind} entry.`);
      }
      if (baseToken && baseToken !== interRow.head_event_id) {
        return conflictOutcome(run, opId, rowRef, baseToken, interRow.head_event_id);
      }
      const res = handleReviseInteraction(run.context, run.state, run.currentSeq, {
        interaction_id: rowId,
        expected_head_event_id: interRow.head_event_id,
        kind: interRow.kind,
        payload,
      });
      const propagated = propagateSubResult(res.result);
      if (propagated) return propagated;
      run.events.push(...res.events);
      run.currentSeq += res.events.length;
      if (res.nextState) run.state = res.nextState;
      trackApplied(run, rowRef, columnId, value);
      return null;
    }
    if (value === null || (typeof value === 'string' && value.trim() === '')) {
      return fail('Clearing a latest note or quote needs its entry removed. Remove the entry instead.');
    }
    if (binding.property === 'latest_note') {
      const res = handleLogEvent(run.context, run.state, run.currentSeq, {
        entity_id: rowId,
        kind: 'note',
        payload: { text: String(value) },
      });
      const propagated = propagateSubResult(res.result);
      if (propagated) return propagated;
      run.events.push(...res.events);
      run.currentSeq += res.events.length;
      if (res.nextState) run.state = res.nextState;
      trackApplied(run, rowRef, columnId, value);
      return null;
    }
    if (binding.property === 'latest_quote') {
      const quote = toQuotePayload(value, 'USD');
      if (!quote.payload) return fail(quote.error ?? 'Invalid quote value.');
      const res = handleLogEvent(run.context, run.state, run.currentSeq, {
        entity_id: rowId,
        kind: 'quote',
        payload: quote.payload,
      });
      const propagated = propagateSubResult(res.result);
      if (propagated) return propagated;
      run.events.push(...res.events);
      run.currentSeq += res.events.length;
      if (res.nextState) run.state = res.nextState;
      trackApplied(run, rowRef, columnId, value);
      return null;
    }
    return fail(`Unsupported interaction binding '${binding.property}'.`);
  }

  // Custom row value
  const rowKey = `${context.workspace_id}:${rowId}`;
  const existingRow = run.state.recordsRows?.get(rowKey);
  if (!existingRow) return fail(`Row '${rowId}' not found.`, 'not_found');
  const valKey = `${context.workspace_id}:${rowId}:${columnId}`;
  const evt = createLedgerEvent(run.context, run.currentSeq++, {
    kind: 'record_cell_changed',
    payload: { row_ref: rowRef, column_id: columnId, value, binding },
  });
  run.events.push(evt);
  reduceRecords(run.state, evt);
  void valKey;
  trackApplied(run, rowRef, columnId, value);
  return null;
}

/**
 * Remove or archive the source behind a row ref: entities delete with
 * history, tasks cancel, drafts archive, interactions remove, custom rows
 * archive. Memory entries are explicitly read-only here.
 */
function applySourceRemoval(
  run: BatchRunner,
  rowRef: RecordRef,
  baseToken: string | undefined,
  opId: string,
): { result: CommandResult<RecordsBatchResultData>; events: LedgerEvent[] } | null {
  const fail = (message: string, code = 'validation_error') => rejected(`[op ${opId}] ${message}`, code);
  const rowId = run.idAliases.get(rowRef.id) ?? rowRef.id;

  if (rowRef.kind === 'memory') {
    return fail('Remembered facts are read-only in table editing. Correct or forget them from the conversation.');
  }
  if (rowRef.kind === 'entity') {
    const res = handleDeleteEntity(run.context, run.state, run.currentSeq, { entity_id: rowId, confirm: 'yes' });
    const propagated = propagateSubResult(res.result);
    if (propagated) return propagated;
    run.events.push(...res.events);
    run.currentSeq += res.events.length;
    if (res.nextState) run.state = res.nextState;
    return null;
  }
  if (rowRef.kind === 'task') {
    const res = handleUpdateTask(run.context, run.state, run.currentSeq, { task_id: rowId, status: 'cancelled' } as Parameters<typeof handleUpdateTask>[3]);
    const propagated = propagateSubResult(res.result);
    if (propagated) return propagated;
    run.events.push(...res.events);
    run.currentSeq += res.events.length;
    if (res.nextState) run.state = res.nextState;
    return null;
  }
  if (rowRef.kind === 'draft') {
    const res = handleRecordDraft(run.context, run.state, run.currentSeq, { draft_id: rowId, status: 'archived' });
    const propagated = propagateSubResult(res.result);
    if (propagated) return propagated;
    run.events.push(...res.events);
    run.currentSeq += res.events.length;
    if (res.nextState) run.state = res.nextState;
    return null;
  }
  if (rowRef.kind === 'interaction') {
    const interRow = run.state.interactions.get(rowId);
    if (!interRow) return fail(`Interaction '${rowId}' not found.`, 'not_found');
    if (baseToken && baseToken !== interRow.head_event_id) {
      return conflictOutcome(run, opId, rowRef, baseToken, interRow.head_event_id);
    }
    const res = handleRemoveInteraction(run.context, run.state, run.currentSeq, {
      interaction_id: rowId,
      expected_head_event_id: interRow.head_event_id,
    });
    const propagated = propagateSubResult(res.result);
    if (propagated) return propagated;
    run.events.push(...res.events);
    run.currentSeq += res.events.length;
    if (res.nextState) run.state = res.nextState;
    return null;
  }
  const existingRow = run.state.recordsRows?.get(`${run.context.workspace_id}:${rowId}`);
  if (!existingRow) return fail(`Row '${rowId}' not found.`, 'not_found');
  const evt = createLedgerEvent(run.context, run.currentSeq++, {
    kind: 'record_row_archived',
    payload: { row_ref: { ...rowRef, id: rowId } },
  });
  run.events.push(evt);
  reduceRecords(run.state, evt);
  return null;
}

/**
 * Translate an item.edit into the bound source: entity/task/draft fields go
 * through their canonical cells, interactions revise, custom rows set cells.
 * Memory stays explicitly read-only.
 */
function applyItemEdit(
  run: BatchRunner,
  listId: string,
  sourceRef: RecordRef,
  payload: Record<string, unknown>,
  baseToken: string | undefined,
  origin: { row_ref: RecordRef; column_id: string } | undefined,
  opId: string,
): { result: CommandResult<RecordsBatchResultData>; events: LedgerEvent[] } | null {
  const fail = (message: string, code = 'validation_error') => rejected(`[op ${opId}] ${message}`, code);
  const rowId = run.idAliases.get(sourceRef.id) ?? sourceRef.id;
  const rowRef: RecordRef = { ...sourceRef, id: rowId };

  if (sourceRef.kind === 'memory') {
    return fail('Remembered facts are read-only in table editing. Correct or forget them from the conversation.');
  }
  if (sourceRef.kind === 'interaction') {
    const interRow = run.state.interactions.get(rowId);
    if (!interRow) return fail(`Interaction '${rowId}' not found.`, 'not_found');
    if (baseToken && baseToken !== interRow.head_event_id) {
      return conflictOutcome(run, opId, rowRef, baseToken, interRow.head_event_id);
    }
    const kind = typeof payload['kind'] === 'string' ? String(payload['kind']) : interRow.kind;
    if (kind !== interRow.kind) return fail(`Cannot change an entry from ${interRow.kind} to ${kind}.`);
    const fields = (payload['payload'] ?? payload) as Record<string, unknown>;
    if (!fields || typeof fields !== 'object') return fail('Interaction edit needs a payload object.');
    const res = handleReviseInteraction(run.context, run.state, run.currentSeq, {
      interaction_id: rowId,
      expected_head_event_id: interRow.head_event_id,
      kind,
      payload: fields as Record<string, unknown>,
    });
    const propagated = propagateSubResult(res.result);
    if (propagated) return propagated;
    run.events.push(...res.events);
    run.currentSeq += res.events.length;
    if (res.nextState) run.state = res.nextState;
    if (origin) trackApplied(run, rowRef, origin.column_id, (fields['text'] ?? fields['summary'] ?? '') as RecordValue);
    return null;
  }
  if (sourceRef.kind === 'custom') {
    for (const [columnId, value] of Object.entries(payload)) {
      const binding = resolveBinding(run.context.workspace_id, run.state, listId, columnId, 'custom');
      if (value === null || value === undefined) continue;
      const valueCheck = validateRecordValue(value);
      if (!valueCheck.valid) return fail(`Invalid value for '${columnId}': ${valueCheck.message}`);
      if (isNoopCellEdit(run.context.workspace_id, run.state, rowRef, rowId, columnId, binding, value as RecordValue)) continue;
      const outcome = applyCellValue(run, rowRef, columnId, binding, value as RecordValue, opId, baseToken);
      if (outcome) return outcome;
    }
    return null;
  }
  for (const [fieldKey, value] of Object.entries(payload)) {
    if (fieldKey === 'kind') continue;
    const columnId = origin && Object.keys(payload).length === 1 ? origin.column_id : fieldKey;
    const binding = resolveBinding(run.context.workspace_id, run.state, listId, columnId, sourceRef.kind);
    if (value === null || value === undefined) continue;
    const outcome = applyCellValue(run, rowRef, columnId, binding, value as RecordValue, opId, baseToken);
    if (outcome) return outcome;
  }
  return null;
}

export function handleRecordsBatch(
  context: LedgerCommandContext,
  state: LedgerProjectionState,
  nextSequence: number,
  args: RecordsBatchArgs,
): {
  result: CommandResult<RecordsBatchResultData>;
  events: LedgerEvent[];
  nextState?: LedgerProjectionState;
  actionCost?: number;
} {
  if (!args || !Array.isArray(args.operations)) {
    return rejected('Missing operations array in records batch.');
  }

  // One user Save chunk stays atomic in one D1 batch: larger pastes arrive
  // as serial chunks with stable action ids, never as one unbounded commit.
  if (args.operations.length > 100) {
    return rejected('Records save chunk cannot exceed 100 operations.');
  }

  if (args.operations.length === 0) {
    return {
      result: {
        status: 'already_applied',
        action_id: context.action_id,
        summary: 'No record operations to apply.',
        data: { save_id: args.save_id, affected_count: 0 },
      },
      events: [],
      nextState: state,
      actionCost: 0,
    };
  }

  // Validate every operation before any effect: one invalid op rejects its
  // atomic chunk and the client keeps its draft.
  for (const op of args.operations) {
    const check = validateRecordEdit(op);
    if (!check.valid) {
      const tag = check.op_id ? `[op ${check.op_id}] ` : '';
      return rejected(`${tag}${check.message}`, check.code);
    }
  }

  // Normalize intra-chunk duplicates: an identical repeat is a no-op, while
  // two different values for one cell in one chunk are contradictory.
  const cellSetFirst = new Map<string, string>();
  const skippedOpIds = new Set<string>();
  for (const op of args.operations) {
    if (op.op !== 'cell.set') continue;
    const key = `${op.row_ref.kind}:${op.row_ref.id}:${op.column_id}`;
    const fingerprint = JSON.stringify(op.value ?? null);
    const first = cellSetFirst.get(key);
    if (first === undefined) {
      cellSetFirst.set(key, fingerprint);
    } else if (first === fingerprint) {
      skippedOpIds.add(op.op_id);
    } else {
      return rejected(
        `[op ${op.op_id}] Contradictory duplicate: cell '${op.column_id}' is set twice with different values in one save.`,
      );
    }
  }

  ensureRecordsState(state);
  const run: BatchRunner = {
    context,
    saveId: args.save_id,
    state,
    currentSeq: nextSequence,
    events: [],
    affectedValues: [],
    idAliases: new Map<string, string>(),
  };
  let appliedCount = 0;

  for (const op of args.operations) {
    if (skippedOpIds.has(op.op_id)) continue;
    const eventsBefore = run.events.length;
    const fail = (message: string, code = 'validation_error') => rejected(`[op ${op.op_id}] ${message}`, code);

    switch (op.op) {
      case 'cell.set':
      case 'cell.clear': {
        const rowId = run.idAliases.get(op.row_ref.id) ?? op.row_ref.id;
        const rowRef: RecordRef = { ...op.row_ref, id: rowId };
        const value = op.op === 'cell.set' ? op.value : null;
        const binding = resolveBinding(context.workspace_id, run.state, args.list_id, op.column_id, op.row_ref.kind);

        const readOnly = readOnlyColumnMessage(args.list_id, op.column_id);
        if (readOnly) return fail(readOnly);
        if (op.op === 'cell.set' && isNoopCellEdit(context.workspace_id, run.state, op.row_ref, rowId, op.column_id, binding, value)) {
          break;
        }
        if (op.op === 'cell.clear' && binding.kind === 'interaction') {
          return fail('Clearing a latest note or quote needs its entry removed. Remove the entry instead.');
        }
        const outcome = applyCellValue(run, rowRef, op.column_id, binding, value, op.op_id, op.base_token);
        if (outcome) return outcome;
        break;
      }

      case 'item.edit': {
        const outcome = applyItemEdit(run, args.list_id, op.source_ref, op.payload, op.base_token, op.origin, op.op_id);
        if (outcome) return outcome;
        break;
      }

      case 'item.remove': {
        const outcome = applySourceRemoval(run, op.source_ref, op.base_token, op.op_id);
        if (outcome) return outcome;
        break;
      }

      case 'row.create': {
        const list = run.state.recordsLists?.get(`${context.workspace_id}:${op.list_id}`);
        // A durable list definition wins; otherwise the row kind decides, so
        // a task or draft staged from another list still lands canonically.
        const sourceKind = list?.source_kind
          || (op.list_id === 'leads' ? 'entity'
            : op.list_id === 'tasks' || op.row_ref.kind === 'task' ? 'task'
              : op.list_id === 'drafts' || op.row_ref.kind === 'draft' ? 'draft'
                : op.list_id === 'notes' || op.row_ref.kind === 'interaction' ? 'interaction' : 'custom');

        if (sourceKind === 'entity') {
          const initialName = String(
            op.initial_values?.['name'] ||
              op.initial_values?.['leads:name'] ||
              '',
          ).trim();
          if (!initialName) {
            return fail('Name the record before saving. Empty leads are not created.');
          }
          let initialStatus = (op.initial_values?.['status'] ||
            op.initial_values?.['leads:status']) as LeadStatus | undefined;
          if (typeof initialStatus === 'string') {
            const normalized = initialStatus.toLowerCase().replace(/lead/i, '').trim();
            if (['new', 'cold', 'warm', 'hot', 'won', 'lost', 'deprioritized'].includes(normalized)) {
              initialStatus = normalized as LeadStatus;
            }
          }
          const res = handleCreateEntity(run.context, run.state, run.currentSeq, {
            name: initialName,
            initial_status: initialStatus,
          });
          const propagated = propagateSubResult(res.result);
          if (propagated) return propagated;
          run.events.push(...res.events);
          run.currentSeq += res.events.length;
          if (res.nextState) run.state = res.nextState;

          const createdEntityId = res.result.data?.entity_id || op.row_ref.id;
          run.idAliases.set(op.row_ref.id, createdEntityId);
          run.affectedValues.push({
            row_ref: { kind: 'entity', id: createdEntityId },
            column_id: 'name',
            value: initialName,
            version: String(run.currentSeq),
          });

          if (op.initial_values) {
            for (const [k, v] of Object.entries(op.initial_values)) {
              if (k === 'name' || k === 'status' || k === 'leads:name' || k === 'leads:status' || v === null || v === undefined || v === '') continue;
              if (k === 'phone' || k === 'leads:phone' || (k === 'contact' && !String(v).includes('@'))) {
                if (!run.state.contacts) run.state.contacts = new Map();
                const cRes = handleChangeContact(run.context, run.state, run.currentSeq, {
                  entity_id: createdEntityId,
                  operation: 'save',
                  method: 'phone',
                  value: String(v),
                });
                const cPropagated = propagateSubResult(cRes.result);
                if (cPropagated) return cPropagated;
                run.events.push(...cRes.events);
                run.currentSeq += cRes.events.length;
                if (cRes.nextState) run.state = cRes.nextState;
                run.affectedValues.push({ row_ref: { kind: 'entity', id: createdEntityId }, column_id: 'phone', value: String(v), version: String(run.currentSeq) });
              } else if (k === 'email' || k === 'leads:email' || (k === 'contact' && String(v).includes('@'))) {
                if (!run.state.contacts) run.state.contacts = new Map();
                const cRes = handleChangeContact(run.context, run.state, run.currentSeq, {
                  entity_id: createdEntityId,
                  operation: 'save',
                  method: 'email',
                  value: String(v),
                });
                const cPropagated = propagateSubResult(cRes.result);
                if (cPropagated) return cPropagated;
                run.events.push(...cRes.events);
                run.currentSeq += cRes.events.length;
                if (cRes.nextState) run.state = cRes.nextState;
                run.affectedValues.push({ row_ref: { kind: 'entity', id: createdEntityId }, column_id: 'email', value: String(v), version: String(run.currentSeq) });
              } else if (k === 'notes' || k === 'leads:notes') {
                const nRes = handleLogEvent(run.context, run.state, run.currentSeq, {
                  entity_id: createdEntityId,
                  kind: 'note',
                  payload: { text: String(v) },
                });
                const nPropagated = propagateSubResult(nRes.result);
                if (nPropagated) return nPropagated;
                run.events.push(...nRes.events);
                run.currentSeq += nRes.events.length;
                if (nRes.nextState) run.state = nRes.nextState;
                run.affectedValues.push({ row_ref: { kind: 'entity', id: createdEntityId }, column_id: 'notes', value: String(v), version: String(run.currentSeq) });
              } else if (k === 'value' || k === 'leads:value' || k === 'quote' || k === 'leads:quote') {
                const quote = toQuotePayload(v as RecordValue, 'USD');
                if (!quote.payload) return fail(quote.error ?? 'Invalid quote value.');
                const qRes = handleLogEvent(run.context, run.state, run.currentSeq, {
                  entity_id: createdEntityId,
                  kind: 'quote',
                  payload: quote.payload,
                });
                const qPropagated = propagateSubResult(qRes.result);
                if (qPropagated) return qPropagated;
                run.events.push(...qRes.events);
                run.currentSeq += qRes.events.length;
                if (qRes.nextState) run.state = qRes.nextState;
                run.affectedValues.push({ row_ref: { kind: 'entity', id: createdEntityId }, column_id: 'value', value: String(v), version: String(run.currentSeq) });
              } else {
                const fRes = handleSetField(run.context, run.state, run.currentSeq, {
                  entity_id: createdEntityId,
                  field_name: k.replace(/^leads:/, ''),
                  value: String(v),
                });
                const fPropagated = propagateSubResult(fRes.result);
                if (fPropagated) return fPropagated;
                run.events.push(...fRes.events);
                run.currentSeq += fRes.events.length;
                if (fRes.nextState) run.state = fRes.nextState;
                run.affectedValues.push({ row_ref: { kind: 'entity', id: createdEntityId }, column_id: k, value: String(v), version: String(run.currentSeq) });
              }
            }
          }
        } else if (sourceKind === 'task') {
          const title = String(op.initial_values?.['title'] || op.initial_values?.['tasks:title'] || '').trim();
          if (!title) {
            return fail('Give the task a title before saving.');
          }
          const assigneeRaw = op.initial_values?.['assignee_user_id'] ?? op.initial_values?.['assignee'] ?? op.initial_values?.['tasks:assignee'];
          const entityRaw = op.initial_values?.['entity_id'] ?? op.initial_values?.['entity'];
          const res = handleCreateTask(run.context, run.state, run.currentSeq, {
            title,
            entity_id: typeof entityRaw === 'string' && entityRaw ? entityRaw : null,
            assignee_user_id: typeof assigneeRaw === 'string' && assigneeRaw ? assigneeRaw : undefined,
            due: (op.initial_values?.['due'] || op.initial_values?.['tasks:due']) as TaskDue | undefined,
            explicit_no_deadline: !op.initial_values?.['due'] && !op.initial_values?.['tasks:due'],
          });
          const propagated = propagateSubResult(res.result);
          if (propagated) return propagated;
          run.events.push(...res.events);
          run.currentSeq += res.events.length;
          if (res.nextState) run.state = res.nextState;
          const createdTaskId = res.result.data?.task_id;
          if (createdTaskId) {
            run.idAliases.set(op.row_ref.id, createdTaskId);
          }
        } else if (sourceKind === 'draft') {
          const content = String(op.initial_values?.['content_text'] || op.initial_values?.['drafts:content_text'] || '').trim();
          if (!content) {
            return fail('Write the draft message before saving.');
          }
          const channelValue = String(op.initial_values?.['channel'] || op.initial_values?.['drafts:channel'] || 'whatsapp');
          const recipientRaw = op.initial_values?.['recipient_address'] ?? op.initial_values?.['recipient'] ?? op.initial_values?.['drafts:recipient_address'];
          const entityRaw = op.initial_values?.['entity_id'] ?? op.initial_values?.['entity'];
          const res = handleRecordDraft(run.context, run.state, run.currentSeq, {
            content_text: content,
            channel: (['whatsapp', 'email', 'sms', 'other'].includes(channelValue)
              ? channelValue
              : 'whatsapp') as 'whatsapp' | 'email' | 'sms' | 'other',
            recipient_address: typeof recipientRaw === 'string' && recipientRaw ? recipientRaw : null,
            entity_id: typeof entityRaw === 'string' && entityRaw ? entityRaw : null,
          });
          const propagated = propagateSubResult(res.result);
          if (propagated) return propagated;
          run.events.push(...res.events);
          run.currentSeq += res.events.length;
          if (res.nextState) run.state = res.nextState;
          const createdDraftId = res.result.data?.draft_id;
          if (createdDraftId) {
            run.idAliases.set(op.row_ref.id, createdDraftId);
          }
        } else if (sourceKind === 'interaction') {
          // Notes-list rows are logged entries, optionally attached to an
          // entity. An empty entry is rejected instead of saved blank.
          const text = String(
            op.initial_values?.['text'] || op.initial_values?.['summary'] || op.initial_values?.['notes'] || '',
          ).trim();
          if (!text) {
            return fail('Write the note before saving.');
          }
          const entityRef = op.initial_values?.['entity_id'] ?? op.initial_values?.['entity'];
          const res = handleLogEvent(run.context, run.state, run.currentSeq, {
            entity_id: typeof entityRef === 'string' && entityRef ? entityRef : null,
            kind: 'note',
            payload: { text },
          });
          const propagated = propagateSubResult(res.result);
          if (propagated) return propagated;
          run.events.push(...res.events);
          run.currentSeq += res.events.length;
          if (res.nextState) run.state = res.nextState;
          const createdRoot = res.result.data && typeof res.result.data === 'object'
            ? (res.result.data as { event_id?: string }).event_id : undefined;
          if (createdRoot) {
            run.idAliases.set(op.row_ref.id, createdRoot);
            run.affectedValues.push({
              row_ref: { kind: 'interaction', id: createdRoot },
              column_id: 'summary',
              value: text,
              version: String(run.currentSeq),
            });
          }
        } else {
          // Custom row: client IDs are scoped to this workspace and collide loudly.
          const existingRow = run.state.recordsRows?.get(`${context.workspace_id}:${op.row_ref.id}`);
          if (existingRow && existingRow.status === 'active') {
            return fail(`Row '${op.row_ref.id}' already exists.`, 'collision');
          }
          const evt = createLedgerEvent(run.context, run.currentSeq++, {
            kind: 'record_row_created',
            payload: {
              list_id: op.list_id,
              row_ref: op.row_ref,
              initial_values: op.initial_values,
            },
          });
          run.events.push(evt);
          reduceRecords(run.state, evt);
          run.idAliases.set(op.row_ref.id, op.row_ref.id);
        }
        break;
      }

      case 'row.remove': {
        const outcome = applySourceRemoval(run, op.row_ref, op.base_token, op.op_id);
        if (outcome) return outcome;
        break;
      }

      case 'row.restore': {
        if (op.row_ref.kind !== 'custom') {
          return fail('Only custom rows restore here. Entity, task, draft, and interaction recovery uses Undo.');
        }
        const existingRow = run.state.recordsRows?.get(`${context.workspace_id}:${op.row_ref.id}`);
        if (!existingRow) return fail(`Row '${op.row_ref.id}' not found.`, 'not_found');
        if (existingRow.status === 'active') break;
        const evt = createLedgerEvent(run.context, run.currentSeq++, {
          kind: 'record_row_restored',
          payload: { row_ref: op.row_ref },
        });
        run.events.push(evt);
        reduceRecords(run.state, evt);
        break;
      }

      case 'field.create': {
        const fieldKey = `${context.workspace_id}:${op.field_id}`;
        if (run.state.fieldDefinitions?.get(fieldKey)) {
          return fail(`Field '${op.field_id}' already exists.`, 'collision');
        }
        const evtDef = createLedgerEvent(run.context, run.currentSeq++, {
          kind: 'field_definition_created',
          payload: {
            field_id: op.field_id,
            label: op.label,
            type: op.type,
            options: op.options,
          },
        });
        run.events.push(evtDef);
        reduceRecords(run.state, evtDef);

        if (op.list_id) {
          const colId = `col_${crypto.randomUUID()}`;
          const evtCol = createLedgerEvent(run.context, run.currentSeq++, {
            kind: 'record_column_created',
            payload: {
              column_id: colId,
              list_id: op.list_id,
              name: op.label,
              type: op.type,
              options: op.options,
              field_id: op.field_id,
            },
          });
          run.events.push(evtCol);
          reduceRecords(run.state, evtCol);
        }
        break;
      }

      case 'field.update': {
        const existing = run.state.fieldDefinitions?.get(`${context.workspace_id}:${op.field_id}`);
        if (!existing) return fail(`Field '${op.field_id}' not found.`, 'not_found');
        // Incompatible conversions keep their originals: create a successor
        // definition instead of reinterpreting stored values in place.
        if (op.type) {
          const nextStorage = fieldStorageType(op.type);
          if (nextStorage && nextStorage !== existing.value_type) {
            return fail(`Changing '${op.field_id}' from ${existing.value_type} to ${nextStorage} would reinterpret saved values. Create a new field instead; the original stays intact.`);
          }
        }
        const evt = createLedgerEvent(run.context, run.currentSeq++, {
          kind: 'field_definition_updated',
          payload: {
            field_id: op.field_id,
            label: op.label,
            type: op.type,
            options: op.options,
          },
        });
        run.events.push(evt);
        reduceRecords(run.state, evt);
        break;
      }

      case 'field.archive':
      case 'field.restore': {
        const colKey = `${context.workspace_id}:${op.field_id}`;
        const existingCol = run.state.recordsListColumns?.get(colKey);
        const existingDef = run.state.fieldDefinitions?.get(colKey);
        if (!existingCol && !existingDef) return fail(`Field '${op.field_id}' not found.`, 'not_found');
        const evt = createLedgerEvent(run.context, run.currentSeq++, {
          kind: op.op === 'field.archive' ? 'record_column_archived' : 'record_column_restored',
          payload: { column_id: op.field_id },
        });
        run.events.push(evt);
        reduceRecords(run.state, evt);
        break;
      }

      case 'list.create': {
        const listKey = `${context.workspace_id}:${op.list_id}`;
        if (run.state.recordsLists?.get(listKey)) {
          return fail(`List '${op.list_id}' already exists.`, 'collision');
        }
        const evt = createLedgerEvent(run.context, run.currentSeq++, {
          kind: 'record_list_created',
          payload: {
            list_id: op.list_id,
            name: op.name,
            source_kind: op.source_kind,
          },
        });
        run.events.push(evt);
        reduceRecords(run.state, evt);
        break;
      }

      case 'list.update':
      case 'list.archive':
      case 'list.restore': {
        const existing = run.state.recordsLists?.get(`${context.workspace_id}:${op.list_id}`);
        if (!existing) return fail(`List '${op.list_id}' not found.`, 'not_found');
        const kind = op.op === 'list.update' ? 'record_list_updated'
          : op.op === 'list.archive' ? 'record_list_archived' : 'record_list_restored';
        const evt = createLedgerEvent(run.context, run.currentSeq++, {
          kind,
          payload: {
            list_id: op.list_id,
            name: op.op === 'list.update' ? (op.name ?? existing.name) : existing.name,
          },
        });
        run.events.push(evt);
        reduceRecords(run.state, evt);
        break;
      }

      case 'calculation.define': {
        const existing = run.state.fieldDefinitions?.get(`${context.workspace_id}:${op.field_id}`);
        if (!existing) return fail(`Field '${op.field_id}' not found. Define the field before its calculation.`, 'not_found');
        // The rule output must match the field's stored type: numbers derive
        // numbers, currency derives currency.
        const expectedStorage = op.expression_tree.output_type === 'currency' ? 'currency' : 'number';
        if (existing.value_type !== expectedStorage) {
          return fail(`Calculation output ${op.expression_tree.output_type} does not match '${op.field_id}' stored as ${existing.value_type}.`);
        }
        // References must resolve to known definitions (already saved or
        // created earlier in this same batch), never to future guesses.
        const missing = collectCalculationRefs(op.expression_tree.expression).filter(
          (refId) => !run.state.fieldDefinitions?.has(`${context.workspace_id}:${refId}`),
        );
        if (missing.length > 0) {
          return fail(`Calculation references unknown fields: ${missing.join(', ')}. Define inputs first.`);
        }
        const evt = createLedgerEvent(run.context, run.currentSeq++, {
          kind: 'calculation_defined',
          payload: {
            field_id: op.field_id,
            expression_tree: op.expression_tree,
            description: op.description,
          },
        });
        run.events.push(evt);
        reduceRecords(run.state, evt);
        break;
      }

      default:
        return fail(`Unsupported operation '${(op as { op: string }).op}'.`, 'unsupported_operation');
    }
    if (run.events.length > eventsBefore) appliedCount++;
  }

  for (const event of run.events) {
    reduceBusinessDetails(run.state, event);
  }

  // Every operation matched saved state: pin the logical action without a
  // business event, revision, or quota effect.
  if (appliedCount === 0) {
    return {
      result: {
        status: 'already_applied',
        action_id: context.action_id,
        summary: 'No record changes: every operation already matched the saved state.',
        data: { save_id: args.save_id, affected_count: 0 },
      },
      events: [],
      nextState: run.state,
      actionCost: 0,
    };
  }

  return {
    result: {
      status: 'applied',
      action_id: context.action_id,
      affected_resource_ids: [args.list_id],
      summary: `Applied ${appliedCount} record edit operations to list '${args.list_id}'.`,
      data: {
        save_id: args.save_id,
        affected_count: appliedCount,
        affected_values: run.affectedValues,
        id_mappings: Object.fromEntries(run.idAliases),
      },
    },
    events: run.events,
    nextState: run.state,
    actionCost: Math.max(1, args.operations.length),
  };
}
