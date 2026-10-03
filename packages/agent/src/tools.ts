/**
 * @otis/agent/tools
 * Versioned declarations, strict JSON schemas, and runtime argument/result validators
 * for all 18 agent tools and 1 control tool.
 * In accordance with plans/006-implementation-handoff.md Section 5.
 */

import type {
  LeadStatus,
  MemoryCategory,
  MemoryScope,
  Provenance,
  TaskDue,
  TaskStatus,
  UndoMode,
} from '@otis/contracts';

// Forbidden authority keys that model proposals are never permitted to provide
const FORBIDDEN_AUTHORITY_KEYS = new Set([
  'workspace_id',
  'workspaceid',
  'actor_id',
  'actorid',
  'user_id',
  'userid',
  'fence',
  'action_id',
  'actionid',
  'membership_revision',
  'source_channel',
  'run_id',
  'runid',
  'step_id',
  'stepid',
  'api_key',
  'apikey',
  'provider_key',
  'sql',
  'url',
]);

export interface ValidationSuccess<T> {
  ok: true;
  data: T;
}

export interface ValidationFailure {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

function fail(code: string, message: string, details?: unknown): ValidationFailure {
  return { ok: false, error: { code, message, details } };
}

function checkNoForbiddenKeys(
  obj: Record<string, unknown>,
  path = '',
  allowedKeys?: Set<string>,
): ValidationFailure | null {
  for (const [key, value] of Object.entries(obj)) {
    const lower = key.toLowerCase();
    if (allowedKeys && allowedKeys.has(lower)) {
      continue;
    }
    if (FORBIDDEN_AUTHORITY_KEYS.has(lower)) {
      return fail(
        'forbidden_key',
        `Model proposal contained forbidden authority key '${path ? `${path}.${key}` : key}'.`,
      );
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = checkNoForbiddenKeys(value as Record<string, unknown>, path ? `${path}.${key}` : key, allowedKeys);
      if (nested) return nested;
    }
  }
  return null;
}

function checkNoUnknownKeys(
  obj: Record<string, unknown>,
  allowed: Set<string>,
  toolName: string,
): ValidationFailure | null {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      return fail('unknown_key', `Unknown argument '${key}' passed to tool '${toolName}'.`);
    }
  }
  return null;
}

// --- Tool Argument Types ---

export interface FindEntitiesToolArgs {
  query: string;
  kind?: string;
  limit?: number;
}

export interface UpsertEntityToolArgs {
  name: string;
  kind?: string;
}

export interface RenameEntityToolArgs {
  entity_id: string;
  new_name: string;
}

export interface LogEventToolArgs {
  entity_id?: string | null;
  kind: 'note' | 'visit' | 'contact' | 'quote';
  payload: Record<string, unknown>;
  occurred_at?: string;
  provenance?: Provenance;
}

export interface SetFieldsFieldItem {
  field_name: string;
  value: unknown;
  provenance?: Provenance;
  evidence?: string;
}

export interface SetFieldsToolArgs {
  entity_id: string;
  fields: SetFieldsFieldItem[];
}

export interface ResolveConflictToolArgs {
  entity_id: string;
  field_name: string;
  candidate_event_ids: string[];
  resolved_value: unknown;
  rationale?: string;
}

export interface CreateTaskToolArgs {
  title: string;
  entity_id?: string | null;
  assignee_user_id?: string | null;
  due: TaskDue;
  explicit_no_deadline?: boolean;
}

export interface UpdateTaskToolArgs {
  task_id: string;
  expected_revision?: number;
  title?: string;
  status?: TaskStatus;
  due?: TaskDue;
  snooze_until?: string | null;
}

export interface DraftMessageToolArgs {
  entity_id?: string | null;
  channel: 'whatsapp' | 'email' | 'sms' | 'other';
  recipient?: string | null;
  content: string;
}

export interface UpdateDraftToolArgs {
  draft_id: string;
  expected_revision?: number;
  content?: string;
  recipient?: string | null;
}

export interface MarkMessageSentToolArgs {
  draft_id: string;
}

export interface QueryToolArgs {
  resource: 'entities' | 'tasks' | 'events' | 'drafts';
  filters?: {
    entity_id?: string;
    entity_status?: LeadStatus;
    task_status?: TaskStatus;
    event_kind?: string;
    assignee_user_id?: string;
    due_before?: string;
    due_after?: string;
  };
  limit?: number;
  cursor?: string;
}

export interface SearchMemoryToolArgs {
  query: string;
  scope?: MemoryScope;
  subject_id?: string;
  limit?: number;
}

export interface GetMemoryToolArgs {
  memory_id: string;
}

export interface RememberContextToolArgs {
  scope: MemoryScope;
  subject_id?: string | null;
  category: MemoryCategory;
  content: string;
  source_message_id?: string | null;
  supersedes_memory_id?: string | null;
}

export interface ForgetMemoryToolArgs {
  memory_id: string;
  rationale?: string;
}

export interface UpdatePreferenceToolArgs {
  preferred_language?: string;
  brief_enabled?: boolean;
  brief_local_time?: string | null;
  brief_timezone?: string | null;
  brief_weekdays?: number[] | null;
  brief_channel?: 'web' | 'telegram';
}

export interface UndoToolArgs {
  action_id?: string;
  mode?: UndoMode;
}

export interface RequestClarificationToolArgs {
  question: string;
  intended_operation: string;
  missing_fields: string[];
  proposed_arguments?: Record<string, unknown>;
  candidates?: string[];
}

// --- Core Allowlist Constants ---
export const CORE_FIELD_ALLOWLIST = new Set([
  'status',
  'phone',
  'preferred_language',
  'assigned_user_id',
  'quote',
]);

export const VALID_LEAD_STATUSES = new Set<LeadStatus>([
  'new',
  'cold',
  'warm',
  'hot',
  'won',
  'lost',
  'deprioritized',
]);

export const VALID_TASK_STATUSES = new Set<TaskStatus>(['open', 'done', 'cancelled']);

// --- Validators ---

export function validateFindEntitiesArgs(raw: unknown): ValidationResult<FindEntitiesToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(obj, new Set(['query', 'kind', 'limit']), 'find_entities');
  if (unk) return unk;

  if (typeof obj['query'] !== 'string' || !obj['query'].trim()) {
    return fail('invalid_argument', "Field 'query' must be a non-empty string.");
  }
  const query = obj['query'].trim();
  if (query.length > 500) return fail('invalid_argument', "Query exceeds maximum 500 characters.");

  let limit: number | undefined;
  if (obj['limit'] !== undefined) {
    if (typeof obj['limit'] !== 'number' || !Number.isInteger(obj['limit']) || obj['limit'] < 1 || obj['limit'] > 50) {
      return fail('invalid_argument', "Field 'limit' must be an integer between 1 and 50.");
    }
    limit = obj['limit'];
  }

  const kind = typeof obj['kind'] === 'string' ? obj['kind'].trim() : undefined;
  return { ok: true, data: { query, kind, limit } };
}

export function validateUpsertEntityArgs(raw: unknown): ValidationResult<UpsertEntityToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(obj, new Set(['name', 'kind']), 'upsert_entity');
  if (unk) return unk;

  if (typeof obj['name'] !== 'string' || !obj['name'].trim()) {
    return fail('invalid_argument', "Field 'name' must be a non-empty string.");
  }
  const name = obj['name'].trim();
  if (name.length > 200) return fail('invalid_argument', "Entity name exceeds maximum 200 characters.");

  const kind = typeof obj['kind'] === 'string' && obj['kind'].trim() ? obj['kind'].trim() : undefined;
  return { ok: true, data: { name, kind } };
}

export function validateRenameEntityArgs(raw: unknown): ValidationResult<RenameEntityToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(obj, new Set(['entity_id', 'new_name']), 'rename_entity');
  if (unk) return unk;

  if (typeof obj['entity_id'] !== 'string' || !obj['entity_id'].trim()) {
    return fail('invalid_argument', "Field 'entity_id' must be a non-empty string.");
  }
  if (typeof obj['new_name'] !== 'string' || !obj['new_name'].trim()) {
    return fail('invalid_argument', "Field 'new_name' must be a non-empty string.");
  }
  const newName = obj['new_name'].trim();
  if (newName.length > 200) return fail('invalid_argument', "New name exceeds maximum 200 characters.");

  return { ok: true, data: { entity_id: obj['entity_id'].trim(), new_name: newName } };
}

export function validateLogEventArgs(raw: unknown): ValidationResult<LogEventToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(obj, new Set(['entity_id', 'kind', 'payload', 'occurred_at', 'provenance']), 'log_event');
  if (unk) return unk;

  const validKinds = new Set(['note', 'visit', 'contact', 'quote']);
  if (typeof obj['kind'] !== 'string' || !validKinds.has(obj['kind'])) {
    return fail('invalid_argument', "Field 'kind' must be 'note', 'visit', 'contact', or 'quote'.");
  }
  const kind = obj['kind'] as LogEventToolArgs['kind'];

  if (!obj['payload'] || typeof obj['payload'] !== 'object' || Array.isArray(obj['payload'])) {
    return fail('invalid_argument', "Field 'payload' must be an object.");
  }
  const payload = obj['payload'] as Record<string, unknown>;

  // Kind-specific payload verification
  if (kind === 'note') {
    const unkP = checkNoUnknownKeys(payload, new Set(['text']), 'log_event.note');
    if (unkP) return unkP;
    if (typeof payload['text'] !== 'string' || !payload['text'].trim()) {
      return fail('invalid_payload', "Note payload requires non-empty string 'text'.");
    }
  } else if (kind === 'visit') {
    const unkP = checkNoUnknownKeys(payload, new Set(['summary', 'contact_made', 'location']), 'log_event.visit');
    if (unkP) return unkP;
    if (typeof payload['summary'] !== 'string' || typeof payload['contact_made'] !== 'boolean') {
      return fail('invalid_payload', "Visit payload requires string 'summary' and boolean 'contact_made'.");
    }
  } else if (kind === 'contact') {
    const unkP = checkNoUnknownKeys(payload, new Set(['summary', 'channel']), 'log_event.contact');
    if (unkP) return unkP;
    const channels = new Set(['phone', 'email', 'in_person', 'telegram', 'whatsapp', 'other']);
    if (typeof payload['summary'] !== 'string' || typeof payload['channel'] !== 'string' || !channels.has(payload['channel'])) {
      return fail('invalid_payload', "Contact payload requires string 'summary' and valid 'channel'.");
    }
  } else if (kind === 'quote') {
    const unkP = checkNoUnknownKeys(payload, new Set(['amount', 'currency', 'role']), 'log_event.quote');
    if (unkP) return unkP;
    if (
      typeof payload['amount'] !== 'number' ||
      !Number.isInteger(payload['amount']) ||
      payload['amount'] < 0 ||
      typeof payload['currency'] !== 'string' ||
      payload['currency'].length !== 3 ||
      (payload['role'] !== 'offered' && payload['role'] !== 'expected')
    ) {
      return fail(
        'invalid_payload',
        "Quote payload requires integer minor units 'amount', 3-letter 'currency', and role ('offered' | 'expected').",
      );
    }
  }

  const entity_id = typeof obj['entity_id'] === 'string' && obj['entity_id'].trim() ? obj['entity_id'].trim() : null;
  const provenance = obj['provenance'] === 'inferred' ? 'inferred' : 'stated';
  const occurred_at = typeof obj['occurred_at'] === 'string' && obj['occurred_at'].trim() ? obj['occurred_at'].trim() : undefined;

  return { ok: true, data: { entity_id, kind, payload, occurred_at, provenance } };
}

export function validateSetFieldsArgs(raw: unknown): ValidationResult<SetFieldsToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(obj, new Set(['entity_id', 'fields']), 'set_fields');
  if (unk) return unk;

  if (typeof obj['entity_id'] !== 'string' || !obj['entity_id'].trim()) {
    return fail('invalid_argument', "Field 'entity_id' must be a non-empty string.");
  }
  if (!Array.isArray(obj['fields']) || obj['fields'].length === 0 || obj['fields'].length > 20) {
    return fail('invalid_argument', "Field 'fields' must be a non-empty array of up to 20 field updates.");
  }

  const validatedFields: SetFieldsFieldItem[] = [];
  for (const item of obj['fields']) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return fail('invalid_field_item', 'Each field item must be an object.');
    }
    const fObj = item as Record<string, unknown>;
    const fSec = checkNoForbiddenKeys(fObj);
    if (fSec) return fSec;
    const fUnk = checkNoUnknownKeys(fObj, new Set(['field_name', 'value', 'provenance', 'evidence']), 'set_fields.field');
    if (fUnk) return fUnk;

    if (typeof fObj['field_name'] !== 'string' || !CORE_FIELD_ALLOWLIST.has(fObj['field_name'])) {
      return fail(
        'disallowed_field',
        `Field '${String(fObj['field_name'])}' is not in core field allowlist: ${Array.from(CORE_FIELD_ALLOWLIST).join(', ')}.`,
      );
    }
    const fieldName = fObj['field_name'];
    const val = fObj['value'];

    // Specific validation per field
    if (fieldName === 'status') {
      if (typeof val !== 'string' || !VALID_LEAD_STATUSES.has(val as LeadStatus)) {
        return fail('invalid_field_value', `Status must be one of: ${Array.from(VALID_LEAD_STATUSES).join(', ')}.`);
      }
    } else if (fieldName === 'quote') {
      if (!val || typeof val !== 'object' || Array.isArray(val)) {
        return fail('invalid_field_value', 'Quote field must be an object with amount, currency, and role.');
      }
      const q = val as Record<string, unknown>;
      if (
        typeof q['amount'] !== 'number' ||
        !Number.isInteger(q['amount']) ||
        q['amount'] < 0 ||
        typeof q['currency'] !== 'string' ||
        q['currency'].length !== 3 ||
        (q['role'] !== 'offered' && q['role'] !== 'expected')
      ) {
        return fail(
          'invalid_field_value',
          "Quote value must have integer minor units 'amount', 3-letter 'currency', and role ('offered' | 'expected').",
        );
      }
    }

    validatedFields.push({
      field_name: fieldName,
      value: val,
      provenance: fObj['provenance'] === 'inferred' ? 'inferred' : 'stated',
      evidence: typeof fObj['evidence'] === 'string' ? fObj['evidence'].trim() : undefined,
    });
  }

  return { ok: true, data: { entity_id: obj['entity_id'].trim(), fields: validatedFields } };
}

export function validateResolveConflictArgs(raw: unknown): ValidationResult<ResolveConflictToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(
    obj,
    new Set(['entity_id', 'field_name', 'candidate_event_ids', 'resolved_value', 'rationale']),
    'resolve_conflict',
  );
  if (unk) return unk;

  if (typeof obj['entity_id'] !== 'string' || !obj['entity_id'].trim()) {
    return fail('invalid_argument', "Field 'entity_id' must be a non-empty string.");
  }
  if (typeof obj['field_name'] !== 'string' || !CORE_FIELD_ALLOWLIST.has(obj['field_name'])) {
    return fail('invalid_argument', `Field '${String(obj['field_name'])}' is not in core allowlist.`);
  }
  if (!Array.isArray(obj['candidate_event_ids']) || obj['candidate_event_ids'].length < 2) {
    return fail('invalid_argument', "Field 'candidate_event_ids' must be an array of at least 2 event IDs.");
  }

  return {
    ok: true,
    data: {
      entity_id: obj['entity_id'].trim(),
      field_name: obj['field_name'].trim(),
      candidate_event_ids: obj['candidate_event_ids'].map(String),
      resolved_value: obj['resolved_value'],
      rationale: typeof obj['rationale'] === 'string' ? obj['rationale'].trim() : undefined,
    },
  };
}

export function validateTaskDue(due: unknown): ValidationResult<TaskDue> {
  if (due === null) return { ok: true, data: null };
  if (!due || typeof due !== 'object' || Array.isArray(due)) {
    return fail('invalid_due', "Task due must be null or an object with kind 'date' or 'instant'.");
  }
  const obj = due as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;

  if (obj['kind'] === 'date') {
    const unk = checkNoUnknownKeys(obj, new Set(['kind', 'local_date', 'timezone']), 'due.date');
    if (unk) return unk;
    if (typeof obj['local_date'] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(obj['local_date'])) {
      return fail('invalid_due_date', "Date due requires 'local_date' in YYYY-MM-DD format.");
    }
    if (typeof obj['timezone'] !== 'string' || !obj['timezone'].trim()) {
      return fail('invalid_due_date', "Date due requires an IANA 'timezone'.");
    }
    return { ok: true, data: { kind: 'date', local_date: obj['local_date'], timezone: obj['timezone'].trim() } };
  }

  if (obj['kind'] === 'instant') {
    const unk = checkNoUnknownKeys(obj, new Set(['kind', 'at', 'timezone']), 'due.instant');
    if (unk) return unk;
    if (typeof obj['at'] !== 'string' || isNaN(Date.parse(obj['at']))) {
      return fail('invalid_due_instant', "Instant due requires valid ISO string 'at'.");
    }
    if (typeof obj['timezone'] !== 'string' || !obj['timezone'].trim()) {
      return fail('invalid_due_instant', "Instant due requires an IANA 'timezone'.");
    }
    return { ok: true, data: { kind: 'instant', at: obj['at'], timezone: obj['timezone'].trim() } };
  }

  return fail('invalid_due_kind', "Due kind must be 'date' or 'instant'.");
}

export function validateCreateTaskArgs(raw: unknown): ValidationResult<CreateTaskToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(
    obj,
    new Set(['title', 'entity_id', 'assignee_user_id', 'due', 'explicit_no_deadline']),
    'create_task',
  );
  if (unk) return unk;

  if (typeof obj['title'] !== 'string' || !obj['title'].trim()) {
    return fail('invalid_argument', "Field 'title' must be a non-empty string.");
  }
  const title = obj['title'].trim();
  if (title.length > 500) return fail('invalid_argument', "Task title exceeds maximum 500 characters.");

  const dueRes = validateTaskDue(obj['due'] !== undefined ? obj['due'] : null);
  if (!dueRes.ok) return dueRes;

  const explicitNoDeadline = obj['explicit_no_deadline'] === true;
  if (dueRes.data === null && !explicitNoDeadline) {
    return fail(
      'missing_deadline',
      "Creating a task requires either a due date/instant or explicit_no_deadline=true.",
    );
  }

  return {
    ok: true,
    data: {
      title,
      entity_id: typeof obj['entity_id'] === 'string' && obj['entity_id'].trim() ? obj['entity_id'].trim() : null,
      assignee_user_id:
        typeof obj['assignee_user_id'] === 'string' && obj['assignee_user_id'].trim()
          ? obj['assignee_user_id'].trim()
          : null,
      due: dueRes.data,
      explicit_no_deadline: explicitNoDeadline,
    },
  };
}

export function validateUpdateTaskArgs(raw: unknown): ValidationResult<UpdateTaskToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(
    obj,
    new Set(['task_id', 'expected_revision', 'title', 'status', 'due', 'snooze_until']),
    'update_task',
  );
  if (unk) return unk;

  if (typeof obj['task_id'] !== 'string' || !obj['task_id'].trim()) {
    return fail('invalid_argument', "Field 'task_id' must be a non-empty string.");
  }

  let due: TaskDue | undefined;
  if (obj['due'] !== undefined) {
    const dRes = validateTaskDue(obj['due']);
    if (!dRes.ok) return dRes;
    due = dRes.data;
  }

  let status: TaskStatus | undefined;
  if (obj['status'] !== undefined) {
    if (typeof obj['status'] !== 'string' || !VALID_TASK_STATUSES.has(obj['status'] as TaskStatus)) {
      return fail('invalid_argument', `Task status must be one of: ${Array.from(VALID_TASK_STATUSES).join(', ')}.`);
    }
    status = obj['status'] as TaskStatus;
  }

  const title = typeof obj['title'] === 'string' && obj['title'].trim() ? obj['title'].trim() : undefined;
  const snoozeUntil = typeof obj['snooze_until'] === 'string' && obj['snooze_until'].trim() ? obj['snooze_until'].trim() : undefined;
  const expectedRevision = typeof obj['expected_revision'] === 'number' && Number.isInteger(obj['expected_revision']) ? obj['expected_revision'] : undefined;

  if (title === undefined && status === undefined && due === undefined && snoozeUntil === undefined) {
    return fail('missing_patch', "Update task requires at least one field to update (title, status, due, snooze_until).");
  }

  return {
    ok: true,
    data: {
      task_id: obj['task_id'].trim(),
      expected_revision: expectedRevision,
      title,
      status,
      due,
      snooze_until: snoozeUntil,
    },
  };
}

export function validateDraftMessageArgs(raw: unknown): ValidationResult<DraftMessageToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(obj, new Set(['entity_id', 'channel', 'recipient', 'content']), 'draft_message');
  if (unk) return unk;

  const validChannels = new Set(['whatsapp', 'email', 'sms', 'other']);
  if (typeof obj['channel'] !== 'string' || !validChannels.has(obj['channel'])) {
    return fail('invalid_argument', "Field 'channel' must be 'whatsapp', 'email', 'sms', or 'other'.");
  }
  if (typeof obj['content'] !== 'string' || !obj['content'].trim()) {
    return fail('invalid_argument', "Field 'content' must be a non-empty string.");
  }
  const content = obj['content'].trim();
  if (content.length > 10000) return fail('invalid_argument', "Draft content exceeds maximum 10,000 characters.");

  return {
    ok: true,
    data: {
      entity_id: typeof obj['entity_id'] === 'string' && obj['entity_id'].trim() ? obj['entity_id'].trim() : null,
      channel: obj['channel'] as DraftMessageToolArgs['channel'],
      recipient: typeof obj['recipient'] === 'string' && obj['recipient'].trim() ? obj['recipient'].trim() : null,
      content,
    },
  };
}

export function validateUpdateDraftArgs(raw: unknown): ValidationResult<UpdateDraftToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(obj, new Set(['draft_id', 'expected_revision', 'content', 'recipient']), 'update_draft');
  if (unk) return unk;

  if (typeof obj['draft_id'] !== 'string' || !obj['draft_id'].trim()) {
    return fail('invalid_argument', "Field 'draft_id' must be a non-empty string.");
  }

  const content = typeof obj['content'] === 'string' && obj['content'].trim() ? obj['content'].trim() : undefined;
  const recipient = typeof obj['recipient'] === 'string' && obj['recipient'].trim() ? obj['recipient'].trim() : undefined;
  const expectedRevision = typeof obj['expected_revision'] === 'number' && Number.isInteger(obj['expected_revision']) ? obj['expected_revision'] : undefined;

  if (content === undefined && recipient === undefined) {
    return fail('missing_patch', "Update draft requires content or recipient.");
  }

  return {
    ok: true,
    data: {
      draft_id: obj['draft_id'].trim(),
      expected_revision: expectedRevision,
      content,
      recipient,
    },
  };
}

export function validateMarkMessageSentArgs(raw: unknown): ValidationResult<MarkMessageSentToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(obj, new Set(['draft_id']), 'mark_message_sent');
  if (unk) return unk;

  if (typeof obj['draft_id'] !== 'string' || !obj['draft_id'].trim()) {
    return fail('invalid_argument', "Field 'draft_id' must be a non-empty string.");
  }
  return { ok: true, data: { draft_id: obj['draft_id'].trim() } };
}

export function validateQueryArgs(raw: unknown): ValidationResult<QueryToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(obj, new Set(['resource', 'filters', 'limit', 'cursor']), 'query');
  if (unk) return unk;

  const validResources = new Set(['entities', 'tasks', 'events', 'drafts']);
  if (typeof obj['resource'] !== 'string' || !validResources.has(obj['resource'])) {
    return fail('invalid_argument', "Field 'resource' must be 'entities', 'tasks', 'events', or 'drafts'.");
  }

  let limit: number | undefined;
  if (obj['limit'] !== undefined) {
    if (typeof obj['limit'] !== 'number' || !Number.isInteger(obj['limit']) || obj['limit'] < 1 || obj['limit'] > 100) {
      return fail('invalid_argument', "Field 'limit' must be an integer between 1 and 100.");
    }
    limit = obj['limit'];
  }

  let filters: QueryToolArgs['filters'];
  if (obj['filters'] !== undefined) {
    if (!obj['filters'] || typeof obj['filters'] !== 'object' || Array.isArray(obj['filters'])) {
      return fail('invalid_argument', "Field 'filters' must be an object.");
    }
    const fObj = obj['filters'] as Record<string, unknown>;
    const fSec = checkNoForbiddenKeys(fObj);
    if (fSec) return fSec;
    const fUnk = checkNoUnknownKeys(
      fObj,
      new Set([
        'entity_id',
        'entity_status',
        'task_status',
        'event_kind',
        'assignee_user_id',
        'due_before',
        'due_after',
      ]),
      'query.filters',
    );
    if (fUnk) return fUnk;

    if (fObj['entity_status'] !== undefined) {
      if (typeof fObj['entity_status'] !== 'string' || !VALID_LEAD_STATUSES.has(fObj['entity_status'] as LeadStatus)) {
        return fail('invalid_argument', `Filter 'entity_status' must be one of: ${Array.from(VALID_LEAD_STATUSES).join(', ')}.`);
      }
    }
    if (fObj['task_status'] !== undefined) {
      if (typeof fObj['task_status'] !== 'string' || !VALID_TASK_STATUSES.has(fObj['task_status'] as TaskStatus)) {
        return fail('invalid_argument', `Filter 'task_status' must be one of: ${Array.from(VALID_TASK_STATUSES).join(', ')}.`);
      }
    }

    filters = {
      entity_id: typeof fObj['entity_id'] === 'string' ? fObj['entity_id'].trim() : undefined,
      entity_status: fObj['entity_status'] as LeadStatus | undefined,
      task_status: fObj['task_status'] as TaskStatus | undefined,
      event_kind: typeof fObj['event_kind'] === 'string' ? fObj['event_kind'].trim() : undefined,
      assignee_user_id: typeof fObj['assignee_user_id'] === 'string' ? fObj['assignee_user_id'].trim() : undefined,
      due_before: typeof fObj['due_before'] === 'string' ? fObj['due_before'].trim() : undefined,
      due_after: typeof fObj['due_after'] === 'string' ? fObj['due_after'].trim() : undefined,
    };
  }

  return {
    ok: true,
    data: {
      resource: obj['resource'] as QueryToolArgs['resource'],
      filters,
      limit,
      cursor: typeof obj['cursor'] === 'string' ? obj['cursor'].trim() : undefined,
    },
  };
}

export function validateSearchMemoryArgs(raw: unknown): ValidationResult<SearchMemoryToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(obj, new Set(['query', 'scope', 'subject_id', 'limit']), 'search_memory');
  if (unk) return unk;

  if (typeof obj['query'] !== 'string' || !obj['query'].trim()) {
    return fail('invalid_argument', "Field 'query' must be a non-empty string.");
  }
  const query = obj['query'].trim();
  if (query.length > 500) return fail('invalid_argument', "Search query exceeds 500 characters.");

  const validScopes = new Set(['workspace', 'entity', 'member_in_workspace']);
  let scope: MemoryScope | undefined;
  if (obj['scope'] !== undefined) {
    if (typeof obj['scope'] !== 'string' || !validScopes.has(obj['scope'])) {
      return fail('invalid_argument', "Field 'scope' must be 'workspace', 'entity', or 'member_in_workspace'.");
    }
    scope = obj['scope'] as MemoryScope;
  }

  let limit: number | undefined;
  if (obj['limit'] !== undefined) {
    if (typeof obj['limit'] !== 'number' || !Number.isInteger(obj['limit']) || obj['limit'] < 1 || obj['limit'] > 50) {
      return fail('invalid_argument', "Field 'limit' must be an integer between 1 and 50.");
    }
    limit = obj['limit'];
  }

  return {
    ok: true,
    data: {
      query,
      scope,
      subject_id: typeof obj['subject_id'] === 'string' ? obj['subject_id'].trim() : undefined,
      limit,
    },
  };
}

export function validateGetMemoryArgs(raw: unknown): ValidationResult<GetMemoryToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(obj, new Set(['memory_id']), 'get_memory');
  if (unk) return unk;

  if (typeof obj['memory_id'] !== 'string' || !obj['memory_id'].trim()) {
    return fail('invalid_argument', "Field 'memory_id' must be a non-empty string.");
  }
  return { ok: true, data: { memory_id: obj['memory_id'].trim() } };
}

export function validateRememberContextArgs(raw: unknown): ValidationResult<RememberContextToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(
    obj,
    new Set(['scope', 'subject_id', 'category', 'content', 'source_message_id', 'supersedes_memory_id']),
    'remember_context',
  );
  if (unk) return unk;

  const validScopes = new Set(['workspace', 'entity', 'member_in_workspace']);
  if (typeof obj['scope'] !== 'string' || !validScopes.has(obj['scope'])) {
    return fail('invalid_argument', "Field 'scope' must be 'workspace', 'entity', or 'member_in_workspace'.");
  }
  const scope = obj['scope'] as MemoryScope;

  const validCats = new Set(['communication_preference', 'relationship_context', 'workflow_context', 'other_context']);
  if (typeof obj['category'] !== 'string' || !validCats.has(obj['category'])) {
    return fail('invalid_argument', `Field 'category' must be one of: ${Array.from(validCats).join(', ')}.`);
  }
  const category = obj['category'] as MemoryCategory;

  if (typeof obj['content'] !== 'string' || !obj['content'].trim()) {
    return fail('invalid_argument', "Field 'content' must be a non-empty string.");
  }
  const content = obj['content'].trim();
  if (content.length > 4000) return fail('invalid_argument', "Memory content exceeds 4000 characters.");

  const subject_id = typeof obj['subject_id'] === 'string' && obj['subject_id'].trim() ? obj['subject_id'].trim() : null;
  if (scope === 'workspace' && subject_id !== null) {
    return fail('invalid_subject', "Workspace scope cannot specify a subject_id.");
  }
  if ((scope === 'entity' || scope === 'member_in_workspace') && !subject_id) {
    return fail('missing_subject', `Scope '${scope}' requires a non-empty subject_id.`);
  }

  return {
    ok: true,
    data: {
      scope,
      subject_id,
      category,
      content,
      source_message_id: typeof obj['source_message_id'] === 'string' ? obj['source_message_id'].trim() : null,
      supersedes_memory_id: typeof obj['supersedes_memory_id'] === 'string' ? obj['supersedes_memory_id'].trim() : null,
    },
  };
}

export function validateForgetMemoryArgs(raw: unknown): ValidationResult<ForgetMemoryToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(obj, new Set(['memory_id', 'rationale']), 'forget_memory');
  if (unk) return unk;

  if (typeof obj['memory_id'] !== 'string' || !obj['memory_id'].trim()) {
    return fail('invalid_argument', "Field 'memory_id' must be a non-empty string.");
  }

  return {
    ok: true,
    data: {
      memory_id: obj['memory_id'].trim(),
      rationale: typeof obj['rationale'] === 'string' ? obj['rationale'].trim() : undefined,
    },
  };
}

export function validateUpdatePreferenceArgs(raw: unknown): ValidationResult<UpdatePreferenceToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(
    obj,
    new Set([
      'preferred_language',
      'brief_enabled',
      'brief_local_time',
      'brief_timezone',
      'brief_weekdays',
      'brief_channel',
    ]),
    'update_preference',
  );
  if (unk) return unk;

  let brief_enabled: boolean | undefined;
  if (obj['brief_enabled'] !== undefined) {
    if (typeof obj['brief_enabled'] !== 'boolean') return fail('invalid_argument', "Field 'brief_enabled' must be boolean.");
    brief_enabled = obj['brief_enabled'];
  }

  const brief_local_time = typeof obj['brief_local_time'] === 'string' ? obj['brief_local_time'].trim() : (obj['brief_local_time'] === null ? null : undefined);
  const brief_timezone = typeof obj['brief_timezone'] === 'string' ? obj['brief_timezone'].trim() : (obj['brief_timezone'] === null ? null : undefined);
  const brief_channel = obj['brief_channel'] === 'telegram' ? 'telegram' : (obj['brief_channel'] === 'web' ? 'web' : undefined);

  let brief_weekdays: number[] | null | undefined;
  if (obj['brief_weekdays'] !== undefined) {
    if (obj['brief_weekdays'] === null) {
      brief_weekdays = null;
    } else if (Array.isArray(obj['brief_weekdays'])) {
      if (obj['brief_weekdays'].some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
        return fail('invalid_argument', "Brief weekdays must be an array of integers 0 to 6.");
      }
      brief_weekdays = obj['brief_weekdays'] as number[];
    } else {
      return fail('invalid_argument', "Brief weekdays must be an array or null.");
    }
  }

  const preferred_language = typeof obj['preferred_language'] === 'string' ? obj['preferred_language'].trim() : undefined;

  return {
    ok: true,
    data: {
      preferred_language,
      brief_enabled,
      brief_local_time,
      brief_timezone,
      brief_weekdays,
      brief_channel,
    },
  };
}

export interface SetChatThinkingToolArgs {
  level: string;
}

export function validateSetChatThinkingArgs(raw: unknown): ValidationResult<SetChatThinkingToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(obj, new Set(['level']), 'set_chat_thinking');
  if (unk) return unk;

  if (typeof obj['level'] !== 'string' || !obj['level'].trim()) {
    return fail('invalid_argument', "Field 'level' must be a non-empty string.");
  }

  return { ok: true, data: { level: obj['level'].trim().toLowerCase() } };
}

export function validateUndoArgs(raw: unknown): ValidationResult<UndoToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj, '', new Set(['action_id', 'actionid']));
  if (sec) return sec;
  const unk = checkNoUnknownKeys(obj, new Set(['action_id', 'mode']), 'undo');
  if (unk) return unk;

  const mode = obj['mode'] === 'single' ? 'single' : 'from_here';
  const action_id = typeof obj['action_id'] === 'string' && obj['action_id'].trim() ? obj['action_id'].trim() : undefined;

  return { ok: true, data: { action_id, mode } };
}

export function validateRequestClarificationArgs(raw: unknown): ValidationResult<RequestClarificationToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(
    obj,
    new Set(['question', 'intended_operation', 'missing_fields', 'proposed_arguments', 'candidates']),
    'request_clarification',
  );
  if (unk) return unk;

  if (typeof obj['question'] !== 'string' || !obj['question'].trim()) {
    return fail('invalid_argument', "Field 'question' must be a non-empty string.");
  }
  if (typeof obj['intended_operation'] !== 'string' || !obj['intended_operation'].trim()) {
    return fail('invalid_argument', "Field 'intended_operation' must be a non-empty string.");
  }
  if (!Array.isArray(obj['missing_fields']) || obj['missing_fields'].length === 0) {
    return fail('invalid_argument', "Field 'missing_fields' must be a non-empty array of field names.");
  }

  return {
    ok: true,
    data: {
      question: obj['question'].trim(),
      intended_operation: obj['intended_operation'].trim(),
      missing_fields: obj['missing_fields'].map(String),
      proposed_arguments: obj['proposed_arguments'] && typeof obj['proposed_arguments'] === 'object' ? (obj['proposed_arguments'] as Record<string, unknown>) : undefined,
      candidates: Array.isArray(obj['candidates']) ? obj['candidates'].map(String) : undefined,
    },
  };
}

// Master dispatcher for runtime tool argument validation
export function validateToolCall(
  name: string,
  rawArgs: unknown,
): ValidationResult<unknown> {
  switch (name) {
    case 'find_entities':
      return validateFindEntitiesArgs(rawArgs);
    case 'upsert_entity':
      return validateUpsertEntityArgs(rawArgs);
    case 'rename_entity':
      return validateRenameEntityArgs(rawArgs);
    case 'log_event':
      return validateLogEventArgs(rawArgs);
    case 'set_fields':
      return validateSetFieldsArgs(rawArgs);
    case 'resolve_conflict':
      return validateResolveConflictArgs(rawArgs);
    case 'create_task':
      return validateCreateTaskArgs(rawArgs);
    case 'update_task':
      return validateUpdateTaskArgs(rawArgs);
    case 'draft_message':
      return validateDraftMessageArgs(rawArgs);
    case 'update_draft':
      return validateUpdateDraftArgs(rawArgs);
    case 'mark_message_sent':
      return validateMarkMessageSentArgs(rawArgs);
    case 'query':
      return validateQueryArgs(rawArgs);
    case 'search_memory':
      return validateSearchMemoryArgs(rawArgs);
    case 'get_memory':
      return validateGetMemoryArgs(rawArgs);
    case 'remember_context':
      return validateRememberContextArgs(rawArgs);
    case 'forget_memory':
      return validateForgetMemoryArgs(rawArgs);
    case 'update_preference':
      return validateUpdatePreferenceArgs(rawArgs);
    case 'set_chat_thinking':
      return validateSetChatThinkingArgs(rawArgs);
    case 'undo':
      return validateUndoArgs(rawArgs);
    case 'request_clarification':
      return validateRequestClarificationArgs(rawArgs);
    default:
      return fail('unknown_tool', `Unknown tool name '${name}'.`);
  }
}

// --- Provider Schema Declarations ---
export interface ProviderToolDeclaration {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
}

export const ALL_AGENT_TOOLS: ProviderToolDeclaration[] = [
  {
    name: 'find_entities',
    description: 'Find entities matching a query by exact name, alias, or fuzzy similarity. Returns candidate matches with confidence scores.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The entity search query string.' },
        kind: { type: 'string', description: 'Optional entity kind filter.' },
        limit: { type: 'integer', description: 'Maximum number of candidates to return (1-50).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'upsert_entity',
    description: 'Find an unambiguous existing entity or create a new one. Never creates near-duplicates automatically.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Canonical entity name.' },
        kind: { type: 'string', description: 'Entity kind (e.g. business, person, lead).' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'rename_entity',
    description: 'Explicitly rename an existing entity.',
    parameters: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'ID of the existing entity to rename.' },
        new_name: { type: 'string', description: 'Explicit new canonical name.' },
      },
      required: ['entity_id', 'new_name'],
      additionalProperties: false,
    },
  },
  {
    name: 'log_event',
    description: 'Record an interaction note, visit, contact, or quote for an entity.',
    parameters: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Optional target entity ID.' },
        kind: { type: 'string', enum: ['note', 'visit', 'contact', 'quote'] },
        payload: { type: 'object', description: 'Typed payload matching the event kind.' },
        occurred_at: { type: 'string', description: 'ISO timestamp of occurrence.' },
        provenance: { type: 'string', enum: ['stated', 'inferred'] },
      },
      required: ['kind', 'payload'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_fields',
    description: 'Update core entity fields (status, phone, preferred_language, assigned_user_id, quote). Quote amounts must be integer minor units.',
    parameters: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Target entity ID.' },
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field_name: { type: 'string', enum: ['status', 'phone', 'preferred_language', 'assigned_user_id', 'quote'] },
              value: {},
              provenance: { type: 'string', enum: ['stated', 'inferred'] },
              evidence: { type: 'string' },
            },
            required: ['field_name', 'value'],
            additionalProperties: false,
          },
        },
      },
      required: ['entity_id', 'fields'],
      additionalProperties: false,
    },
  },
  {
    name: 'resolve_conflict',
    description: 'Resolve a disputed field by choosing a verified value from competing candidate events.',
    parameters: {
      type: 'object',
      properties: {
        entity_id: { type: 'string' },
        field_name: { type: 'string' },
        candidate_event_ids: { type: 'array', items: { type: 'string' } },
        resolved_value: {},
        rationale: { type: 'string' },
      },
      required: ['entity_id', 'field_name', 'candidate_event_ids', 'resolved_value'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_task',
    description: 'Create an actionable task. Requires either a validated due date/instant or explicit_no_deadline=true.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        entity_id: { type: 'string' },
        assignee_user_id: { type: 'string' },
        due: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['date', 'instant'] },
            local_date: { type: 'string' },
            at: { type: 'string' },
            timezone: { type: 'string' },
          },
          required: ['kind', 'timezone'],
          additionalProperties: false,
        },
        explicit_no_deadline: { type: 'boolean' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_task',
    description: 'Update task title, status (open/done/cancelled), due date, or snooze.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        expected_revision: { type: 'integer' },
        title: { type: 'string' },
        status: { type: 'string', enum: ['open', 'done', 'cancelled'] },
        due: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['date', 'instant'] },
            local_date: { type: 'string' },
            at: { type: 'string' },
            timezone: { type: 'string' },
          },
          required: ['kind', 'timezone'],
          additionalProperties: false,
        },
        snooze_until: { type: 'string' },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'draft_message',
    description: 'Record an outward draft message (whatsapp, email, sms, other) upon explicit request.',
    parameters: {
      type: 'object',
      properties: {
        entity_id: { type: 'string' },
        channel: { type: 'string', enum: ['whatsapp', 'email', 'sms', 'other'] },
        recipient: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['channel', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_draft',
    description: 'Update content or recipient of an existing draft.',
    parameters: {
      type: 'object',
      properties: {
        draft_id: { type: 'string' },
        expected_revision: { type: 'integer' },
        content: { type: 'string' },
        recipient: { type: 'string' },
      },
      required: ['draft_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'mark_message_sent',
    description: 'Mark a draft message as sent based on explicit member confirmation.',
    parameters: {
      type: 'object',
      properties: {
        draft_id: { type: 'string' },
      },
      required: ['draft_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'query',
    description: 'Query structured records (entities, tasks, events, drafts) with whitelisted filters.',
    parameters: {
      type: 'object',
      properties: {
        resource: { type: 'string', enum: ['entities', 'tasks', 'events', 'drafts'] },
        filters: {
          type: 'object',
          properties: {
            entity_id: { type: 'string' },
            entity_status: { type: 'string' },
            task_status: { type: 'string' },
            event_kind: { type: 'string' },
            assignee_user_id: { type: 'string' },
            due_before: { type: 'string' },
            due_after: { type: 'string' },
          },
          additionalProperties: false,
        },
        limit: { type: 'integer' },
        cursor: { type: 'string' },
      },
      required: ['resource'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_memory',
    description: 'Search active curated memory notes across the workspace.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        scope: { type: 'string', enum: ['workspace', 'entity', 'member_in_workspace'] },
        subject_id: { type: 'string' },
        limit: { type: 'integer' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_memory',
    description: 'Get details of a single memory note by ID.',
    parameters: {
      type: 'object',
      properties: {
        memory_id: { type: 'string' },
      },
      required: ['memory_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'remember_context',
    description: 'Curate a durable memory note for the workspace, an entity, or a member.',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['workspace', 'entity', 'member_in_workspace'] },
        subject_id: { type: 'string' },
        category: { type: 'string', enum: ['communication_preference', 'relationship_context', 'workflow_context', 'other_context'] },
        content: { type: 'string' },
        source_message_id: { type: 'string' },
        supersedes_memory_id: { type: 'string' },
      },
      required: ['scope', 'category', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'forget_memory',
    description: 'Explicitly forget a durable memory note and suppress it from future retrieval.',
    parameters: {
      type: 'object',
      properties: {
        memory_id: { type: 'string' },
        rationale: { type: 'string' },
      },
      required: ['memory_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_preference',
    description: 'Update authenticated member preferences (language, brief schedule/delivery).',
    parameters: {
      type: 'object',
      properties: {
        preferred_language: { type: 'string' },
        brief_enabled: { type: 'boolean' },
        brief_local_time: { type: 'string' },
        brief_timezone: { type: 'string' },
        brief_weekdays: { type: 'array', items: { type: 'integer' } },
        brief_channel: { type: 'string', enum: ['web', 'telegram'] },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'set_chat_thinking',
    description: 'Set the model thinking effort for future messages in this chat.',
    parameters: {
      type: 'object',
      properties: {
        level: {
          type: 'string',
          description: "Thinking effort level ('minimal', 'low', 'medium', 'high', 'xhigh', or 'default')",
        },
      },
      required: ['level'],
      additionalProperties: false,
    },
  },
  {
    name: 'undo',
    description: 'Revert recent actions in the current chat. from_here is the default grouped mode.',
    parameters: {
      type: 'object',
      properties: {
        action_id: { type: 'string' },
        mode: { type: 'string', enum: ['from_here', 'single'] },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'request_clarification',
    description: 'Ask the user a concise question before executing an action when required details are ambiguous or missing.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        intended_operation: { type: 'string' },
        missing_fields: { type: 'array', items: { type: 'string' } },
        proposed_arguments: { type: 'object' },
        candidates: { type: 'array', items: { type: 'string' } },
      },
      required: ['question', 'intended_operation', 'missing_fields'],
      additionalProperties: false,
    },
  },
];
