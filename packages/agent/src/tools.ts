/**
 * @otis/agent/tools
 * Versioned declarations, strict JSON schemas, and runtime argument/result validators
 * for all 18 agent tools and 1 control tool.
 * In accordance with docs/archive/plans/006-implementation-handoff.md Section 5.
 */

import type {
  LeadStatus,
  MemoryCategory,
  MemoryScope,
  Provenance,
  TaskDue,
  TaskStatus,
  UndoMode,
  ChangeContactArgs,
  MergeEntitiesArgs,
  SearchWorkspaceHistoryArgs,
  DocumentStartArgs,
  DocumentSectionInput,
  DocumentWriteSectionArgs,
  DocumentPublishArgs,
} from '@otis/contracts';
import {
  DOCUMENT_BOUNDS,
  ENTITY_FILE_SECTIONS,
  normalizeInteractionOccurredAt,
  validateInteractionPayload,
  validateRecordEdit,
  validateReminderSpec,
  validReminderTimezone,
  type EntityFileSection,
  type RecordEdit,
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
  'lease_fence',
  'leasefence',
  'action_id',
  'actionid',
  'internal_admin',
  'internaladmin',
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
      const nested = checkNoForbiddenKeys(
        value as Record<string, unknown>,
        path ? `${path}.${key}` : key,
        allowedKeys,
      );
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

export interface DeleteEntityToolArgs {
  entity_id: string;
  reason?: string | null;
}

export interface LogEventToolArgs {
  entity_id?: string | null;
  kind: 'note' | 'visit' | 'contact' | 'quote';
  payload: Record<string, unknown>;
  occurred_at?: string;
  provenance?: Provenance;
}

export interface ReviseInteractionToolArgs {
  interaction_id: string;
  expected_head_event_id: string;
  kind: 'note' | 'visit' | 'contact' | 'quote';
  payload: Record<string, unknown>;
  occurred_at?: string;
}

export interface RemoveInteractionToolArgs {
  interaction_id: string;
  expected_head_event_id: string;
  reason?: string | null;
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

export interface ReadChatHistoryToolArgs {
  /** Defaults to the current chat when omitted. Must belong to the workspace. */
  chat_id?: string | null;
  /** Page backwards from below this sequence; omit for the latest window. */
  before_sequence?: number | null;
  /** Rows per page, 1–50. Defaults to 20. */
  limit?: number;
}

export interface CreateReminderToolArgs {
  text: string;
  /** Offset-bearing ISO instant to fire at. Must lie in the future. */
  at: string;
  /** IANA display zone for the confirmation copy. Optional. */
  timezone?: string | null;
  /** Delivery channel. Defaults to web. */
  channel?: 'web' | 'telegram';
}

export interface UpdateReminderToolArgs {
  reminder_id: string;
  text?: string;
  at?: string;
  timezone?: string | null;
  channel?: 'web' | 'telegram';
}

export interface CancelReminderToolArgs {
  reminder_id: string;
}

export interface QueryToolArgs {
  resource:
    | 'entities'
    | 'tasks'
    | 'events'
    | 'interactions'
    | 'drafts'
    | 'attachments'
    | 'lead_overview'
    | 'entity_file'
    | 'merge_preview'
    | 'followups'
    | 'members'
    | 'duplicates'
    | 'search'
    | 'records'
    | 'documents';
  section?: EntityFileSection;
  order?: 'occurred' | 'recorded' | 'overdue_first';
  entity_id?: string;
  target_entity_id?: string;
  text?: string;
  query?: string;
  filters?: {
    interaction_id?: string;
    entity_id?: string;
    target_entity_id?: string;
    author_user_id?: string;
    include_removed?: boolean;
    from?: string;
    to?: string;
    entity_status?: LeadStatus;
    task_status?: TaskStatus;
    event_kind?: string;
    assignee_user_id?: string;
    due_before?: string;
    due_after?: string;
    /** Exact entity kind (entities only): lead, client, partner. */
    kind?: string;
    /** Substring match on the source message text (attachments only). */
    text?: string;
    /** Lead status filter (lead_overview only). */
    status?: LeadStatus;
    /** Only leads with overdue open work (lead_overview only). */
    overdue_only?: boolean;
    /** Only leads with no open next step (lead_overview only). */
    without_next_step?: boolean;
    /** Display column subset (lead_overview only). */
    columns?: string[];
    /** Records list id (records resource only). */
    list_id?: string;
    /** Chat id filter (documents resource only). */
    chat_id?: string;
    /** Specific document id filter (documents resource only). */
    document_id?: string;
  };
  limit?: number;
  cursor?: string;
}

export interface ViewImageToolArgs {
  media_id: string;
  /** Standard inference rendition by default; original for small text or precise inspection. */
  detail?: 'standard' | 'original';
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
  'company',
  'address',
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
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(obj, new Set(['query', 'kind', 'limit']), 'find_entities');
  if (unk) return unk;

  if (typeof obj['query'] !== 'string' || !obj['query'].trim()) {
    return fail('invalid_argument', "Field 'query' must be a non-empty string.");
  }
  const query = obj['query'].trim();
  if (query.length > 500) return fail('invalid_argument', 'Query exceeds maximum 500 characters.');

  let limit: number | undefined;
  if (obj['limit'] !== undefined) {
    if (
      typeof obj['limit'] !== 'number' ||
      !Number.isInteger(obj['limit']) ||
      obj['limit'] < 1 ||
      obj['limit'] > 50
    ) {
      return fail('invalid_argument', "Field 'limit' must be an integer between 1 and 50.");
    }
    limit = obj['limit'];
  }

  const kind = typeof obj['kind'] === 'string' ? obj['kind'].trim() : undefined;
  return { ok: true, data: { query, kind, limit } };
}

export function validateUpsertEntityArgs(raw: unknown): ValidationResult<UpsertEntityToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(obj, new Set(['name', 'kind']), 'upsert_entity');
  if (unk) return unk;

  if (typeof obj['name'] !== 'string' || !obj['name'].trim()) {
    return fail('invalid_argument', "Field 'name' must be a non-empty string.");
  }
  const name = obj['name'].trim();
  if (name.length > 200)
    return fail('invalid_argument', 'Entity name exceeds maximum 200 characters.');

  const kind =
    typeof obj['kind'] === 'string' && obj['kind'].trim() ? obj['kind'].trim() : undefined;
  return { ok: true, data: { name, kind } };
}

export function validateRenameEntityArgs(raw: unknown): ValidationResult<RenameEntityToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return fail('invalid_type', 'Expected object.');
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
  if (newName.length > 200)
    return fail('invalid_argument', 'New name exceeds maximum 200 characters.');

  return { ok: true, data: { entity_id: obj['entity_id'].trim(), new_name: newName } };
}

export function validateDeleteEntityArgs(raw: unknown): ValidationResult<DeleteEntityToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(obj, new Set(['entity_id', 'reason']), 'delete_entity');
  if (unk) return unk;

  if (typeof obj['entity_id'] !== 'string' || !obj['entity_id'].trim()) {
    return fail('invalid_argument', "Field 'entity_id' must be a non-empty string.");
  }
  const reason =
    typeof obj['reason'] === 'string' && obj['reason'].trim() ? obj['reason'].trim() : undefined;
  return { ok: true, data: { entity_id: obj['entity_id'].trim(), reason } };
}

export function validateLogEventArgs(raw: unknown): ValidationResult<LogEventToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(
    obj,
    new Set(['entity_id', 'kind', 'payload', 'occurred_at', 'provenance']),
    'log_event',
  );
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

  const checked = validateInteractionPayload(kind, payload);
  if (!checked.valid) return fail(checked.code, checked.message);
  const occurred_at =
    obj['occurred_at'] === undefined
      ? undefined
      : normalizeInteractionOccurredAt(obj['occurred_at']);
  if (occurred_at === null)
    return fail(
      'invalid_occurred_at',
      'Occurred date must be a valid ISO timestamp with a timezone.',
    );
  const entity_id =
    typeof obj['entity_id'] === 'string' && obj['entity_id'].trim()
      ? obj['entity_id'].trim()
      : null;
  const provenance = obj['provenance'] === 'inferred' ? 'inferred' : 'stated';

  return { ok: true, data: { entity_id, kind, payload: checked.payload, occurred_at, provenance } };
}

export function validateReviseInteractionArgs(
  raw: unknown,
): ValidationResult<ReviseInteractionToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(
    obj,
    new Set(['interaction_id', 'expected_head_event_id', 'kind', 'payload', 'occurred_at']),
    'revise_interaction',
  );
  if (unk) return unk;

  if (typeof obj['interaction_id'] !== 'string' || !obj['interaction_id'].trim()) {
    return fail(
      'invalid_argument',
      "Field 'interaction_id' must be the original interaction event ID (non-empty string).",
    );
  }
  if (typeof obj['expected_head_event_id'] !== 'string' || !obj['expected_head_event_id'].trim()) {
    return fail(
      'invalid_argument',
      "Field 'expected_head_event_id' must be the exact current head event ID (non-empty string).",
    );
  }
  const validKinds = new Set(['note', 'visit', 'contact', 'quote']);
  if (typeof obj['kind'] !== 'string' || !validKinds.has(obj['kind'])) {
    return fail(
      'invalid_argument',
      "Field 'kind' must be 'note', 'visit', 'contact', or 'quote', matching the original entry.",
    );
  }
  if (!obj['payload'] || typeof obj['payload'] !== 'object' || Array.isArray(obj['payload'])) {
    return fail('invalid_argument', "Field 'payload' must be an object.");
  }
  const payload = obj['payload'] as Record<string, unknown>;
  // The stable root is server-bound from interaction_id; a model-supplied
  // marker inside the payload is never honored.
  if ('interaction_id' in payload) {
    return fail(
      'invalid_argument',
      "Field 'payload.interaction_id' is reserved and must not be supplied.",
    );
  }
  const checked = validateInteractionPayload(obj['kind'] as string, payload);
  if (!checked.valid) return fail(checked.code, checked.message);
  const occurred_at =
    obj['occurred_at'] === undefined
      ? undefined
      : normalizeInteractionOccurredAt(obj['occurred_at']);
  if (occurred_at === null)
    return fail(
      'invalid_occurred_at',
      'Occurred date must be a valid ISO timestamp with a timezone.',
    );

  if (
    obj['entity_id'] !== undefined &&
    obj['entity_id'] !== null &&
    (typeof obj['entity_id'] !== 'string' || !obj['entity_id'].trim())
  ) {
    return fail('invalid_argument', 'Entity ID must be a non-empty string or null.');
  }
  if (
    obj['provenance'] !== undefined &&
    obj['provenance'] !== 'stated' &&
    obj['provenance'] !== 'inferred'
  ) {
    return fail('invalid_argument', 'Provenance must be stated or inferred.');
  }
  return {
    ok: true,
    data: {
      interaction_id: (obj['interaction_id'] as string).trim(),
      expected_head_event_id: (obj['expected_head_event_id'] as string).trim(),
      kind: obj['kind'] as ReviseInteractionToolArgs['kind'],
      payload: checked.payload,
      occurred_at,
    },
  };
}

export function validateRemoveInteractionArgs(
  raw: unknown,
): ValidationResult<RemoveInteractionToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(
    obj,
    new Set(['interaction_id', 'expected_head_event_id', 'reason']),
    'remove_interaction',
  );
  if (unk) return unk;

  if (typeof obj['interaction_id'] !== 'string' || !obj['interaction_id'].trim()) {
    return fail(
      'invalid_argument',
      "Field 'interaction_id' must be the original interaction event ID (non-empty string).",
    );
  }
  if (typeof obj['expected_head_event_id'] !== 'string' || !obj['expected_head_event_id'].trim()) {
    return fail(
      'invalid_argument',
      "Field 'expected_head_event_id' must be the exact current head event ID (non-empty string).",
    );
  }
  if (
    obj['reason'] !== undefined &&
    obj['reason'] !== null &&
    (typeof obj['reason'] !== 'string' || !obj['reason'].trim() || obj['reason'].length > 500)
  ) {
    return fail(
      'invalid_reason',
      'Removal reason must be a non-empty string of at most 500 characters.',
    );
  }
  const reason = typeof obj['reason'] === 'string' ? obj['reason'].trim() : null;

  return {
    ok: true,
    data: {
      interaction_id: (obj['interaction_id'] as string).trim(),
      expected_head_event_id: (obj['expected_head_event_id'] as string).trim(),
      reason,
    },
  };
}

export function validateSetFieldsArgs(raw: unknown): ValidationResult<SetFieldsToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(obj, new Set(['entity_id', 'fields']), 'set_fields');
  if (unk) return unk;

  if (typeof obj['entity_id'] !== 'string' || !obj['entity_id'].trim()) {
    return fail('invalid_argument', "Field 'entity_id' must be a non-empty string.");
  }
  if (!Array.isArray(obj['fields']) || obj['fields'].length === 0 || obj['fields'].length > 20) {
    return fail(
      'invalid_argument',
      "Field 'fields' must be a non-empty array of up to 20 field updates.",
    );
  }

  const validatedFields: SetFieldsFieldItem[] = [];
  for (const item of obj['fields']) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return fail('invalid_field_item', 'Each field item must be an object.');
    }
    const fObj = item as Record<string, unknown>;
    const fSec = checkNoForbiddenKeys(fObj);
    if (fSec) return fSec;
    const fUnk = checkNoUnknownKeys(
      fObj,
      new Set(['field_name', 'value', 'provenance', 'evidence']),
      'set_fields.field',
    );
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
        return fail(
          'invalid_field_value',
          `Status must be one of: ${Array.from(VALID_LEAD_STATUSES).join(', ')}.`,
        );
      }
    } else if (fieldName === 'quote') {
      if (!val || typeof val !== 'object' || Array.isArray(val)) {
        return fail(
          'invalid_field_value',
          'Quote field must be an object with amount, currency, and role.',
        );
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

export function validateResolveConflictArgs(
  raw: unknown,
): ValidationResult<ResolveConflictToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return fail('invalid_type', 'Expected object.');
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
    return fail(
      'invalid_argument',
      `Field '${String(obj['field_name'])}' is not in core allowlist.`,
    );
  }
  if (!Array.isArray(obj['candidate_event_ids']) || obj['candidate_event_ids'].length < 2) {
    return fail(
      'invalid_argument',
      "Field 'candidate_event_ids' must be an array of at least 2 event IDs.",
    );
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

function isValidCalendarDate(dateStr: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return false;
  const year = parseInt(match[1]!, 10);
  const month = parseInt(match[2]!, 10);
  const day = parseInt(match[3]!, 10);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function isValidIanaTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const ISO_INSTANT_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

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
    if (typeof obj['local_date'] !== 'string' || !isValidCalendarDate(obj['local_date'])) {
      return fail(
        'invalid_due_date',
        "Date due requires a valid calendar date 'local_date' in YYYY-MM-DD format.",
      );
    }
    if (typeof obj['timezone'] !== 'string' || !isValidIanaTimezone(obj['timezone'].trim())) {
      return fail('invalid_due_timezone', "Date due requires a valid IANA 'timezone'.");
    }
    return {
      ok: true,
      data: { kind: 'date', local_date: obj['local_date'], timezone: obj['timezone'].trim() },
    };
  }

  if (obj['kind'] === 'instant') {
    const unk = checkNoUnknownKeys(obj, new Set(['kind', 'at', 'timezone']), 'due.instant');
    if (unk) return unk;
    if (
      typeof obj['at'] !== 'string' ||
      !ISO_INSTANT_REGEX.test(obj['at']) ||
      isNaN(Date.parse(obj['at']))
    ) {
      return fail(
        'invalid_due_instant',
        "Instant due requires a valid offset-bearing ISO string 'at'.",
      );
    }
    if (typeof obj['timezone'] !== 'string' || !isValidIanaTimezone(obj['timezone'].trim())) {
      return fail('invalid_due_timezone', "Instant due requires a valid IANA 'timezone'.");
    }
    return { ok: true, data: { kind: 'instant', at: obj['at'], timezone: obj['timezone'].trim() } };
  }

  return fail('invalid_due_kind', "Due kind must be 'date' or 'instant'.");
}

export function validateCreateTaskArgs(raw: unknown): ValidationResult<CreateTaskToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return fail('invalid_type', 'Expected object.');
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
  if (title.length > 500)
    return fail('invalid_argument', 'Task title exceeds maximum 500 characters.');

  const dueRes = validateTaskDue(obj['due'] !== undefined ? obj['due'] : null);
  if (!dueRes.ok) return dueRes;

  const explicitNoDeadline = obj['explicit_no_deadline'] === true;
  if (dueRes.data === null && !explicitNoDeadline) {
    return fail(
      'missing_deadline',
      'Creating a task requires either a due date/instant or explicit_no_deadline=true.',
    );
  }

  return {
    ok: true,
    data: {
      title,
      entity_id:
        typeof obj['entity_id'] === 'string' && obj['entity_id'].trim()
          ? obj['entity_id'].trim()
          : null,
      assignee_user_id:
        obj['assignee_user_id'] === undefined
          ? undefined
          : typeof obj['assignee_user_id'] === 'string' && obj['assignee_user_id'].trim()
            ? obj['assignee_user_id'].trim()
            : null,
      due: dueRes.data,
      explicit_no_deadline: explicitNoDeadline,
    },
  };
}

export function validateUpdateTaskArgs(raw: unknown): ValidationResult<UpdateTaskToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return fail('invalid_type', 'Expected object.');
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
    if (
      typeof obj['status'] !== 'string' ||
      !VALID_TASK_STATUSES.has(obj['status'] as TaskStatus)
    ) {
      return fail(
        'invalid_argument',
        `Task status must be one of: ${Array.from(VALID_TASK_STATUSES).join(', ')}.`,
      );
    }
    status = obj['status'] as TaskStatus;
  }

  const title =
    typeof obj['title'] === 'string' && obj['title'].trim() ? obj['title'].trim() : undefined;
  const snoozeUntil =
    obj['snooze_until'] === null
      ? null
      : typeof obj['snooze_until'] === 'string' && obj['snooze_until'].trim()
        ? obj['snooze_until'].trim()
        : undefined;

  if (typeof obj['snooze_until'] === 'string' && obj['snooze_until'].trim()) {
    if (
      !ISO_INSTANT_REGEX.test(obj['snooze_until'].trim()) ||
      isNaN(Date.parse(obj['snooze_until'].trim()))
    ) {
      return fail(
        'invalid_snooze_until',
        "Field 'snooze_until' must be a valid offset-bearing ISO instant or null.",
      );
    }
  }

  const expectedRevision =
    typeof obj['expected_revision'] === 'number' && Number.isInteger(obj['expected_revision'])
      ? obj['expected_revision']
      : undefined;

  if (
    title === undefined &&
    status === undefined &&
    due === undefined &&
    snoozeUntil === undefined
  ) {
    return fail(
      'missing_patch',
      'Update task requires at least one field to update (title, status, due, snooze_until).',
    );
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
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(
    obj,
    new Set(['entity_id', 'channel', 'recipient', 'content']),
    'draft_message',
  );
  if (unk) return unk;

  const validChannels = new Set(['whatsapp', 'email', 'sms', 'other']);
  if (typeof obj['channel'] !== 'string' || !validChannels.has(obj['channel'])) {
    return fail(
      'invalid_argument',
      "Field 'channel' must be 'whatsapp', 'email', 'sms', or 'other'.",
    );
  }
  if (typeof obj['content'] !== 'string' || !obj['content'].trim()) {
    return fail('invalid_argument', "Field 'content' must be a non-empty string.");
  }
  const content = obj['content'].trim();
  if (content.length > 10000)
    return fail('invalid_argument', 'Draft content exceeds maximum 10,000 characters.');

  return {
    ok: true,
    data: {
      entity_id:
        typeof obj['entity_id'] === 'string' && obj['entity_id'].trim()
          ? obj['entity_id'].trim()
          : null,
      channel: obj['channel'] as DraftMessageToolArgs['channel'],
      recipient:
        typeof obj['recipient'] === 'string' && obj['recipient'].trim()
          ? obj['recipient'].trim()
          : null,
      content,
    },
  };
}

export function validateUpdateDraftArgs(raw: unknown): ValidationResult<UpdateDraftToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(
    obj,
    new Set(['draft_id', 'expected_revision', 'content', 'recipient']),
    'update_draft',
  );
  if (unk) return unk;

  if (typeof obj['draft_id'] !== 'string' || !obj['draft_id'].trim()) {
    return fail('invalid_argument', "Field 'draft_id' must be a non-empty string.");
  }

  const content =
    typeof obj['content'] === 'string' && obj['content'].trim() ? obj['content'].trim() : undefined;
  const recipient =
    typeof obj['recipient'] === 'string' && obj['recipient'].trim()
      ? obj['recipient'].trim()
      : undefined;
  const expectedRevision =
    typeof obj['expected_revision'] === 'number' && Number.isInteger(obj['expected_revision'])
      ? obj['expected_revision']
      : undefined;

  if (content === undefined && recipient === undefined) {
    return fail('missing_patch', 'Update draft requires content or recipient.');
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

export interface EditRecordsToolArgs {
  list_id: string;
  operations: RecordEdit[];
}

export function validateEditRecordsArgs(raw: unknown): ValidationResult<EditRecordsToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(obj, new Set(['list_id', 'operations']), 'edit_records');
  if (unk) return unk;

  if (typeof obj['list_id'] !== 'string' || !obj['list_id'].trim()) {
    return fail('invalid_argument', "Field 'list_id' must be a non-empty string.");
  }
  if (!Array.isArray(obj['operations']) || obj['operations'].length === 0) {
    return fail('invalid_argument', "Field 'operations' must be a non-empty array of record edits.");
  }
  if (obj['operations'].length > 100) {
    return fail('invalid_argument', 'At most 100 operations travel in one edit_records call.');
  }
  const operations: RecordEdit[] = [];
  for (const rawOp of obj['operations']) {
    const check = validateRecordEdit(rawOp);
    if (!check.valid) {
      return fail(
        'invalid_argument',
        check.op_id ? `[op ${check.op_id}] ${check.message}` : check.message,
      );
    }
    operations.push(rawOp as RecordEdit);
  }
  return { ok: true, data: { list_id: obj['list_id'].trim(), operations } };
}

export function validateMarkMessageSentArgs(
  raw: unknown,
): ValidationResult<MarkMessageSentToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return fail('invalid_type', 'Expected object.');
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

export function validateReadChatHistoryArgs(
  raw: unknown,
): ValidationResult<ReadChatHistoryToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(
    obj,
    new Set(['chat_id', 'before_sequence', 'limit']),
    'read_chat_history',
  );
  if (unk) return unk;

  const chat_id =
    obj['chat_id'] === undefined || obj['chat_id'] === null
      ? null
      : typeof obj['chat_id'] === 'string' && obj['chat_id'].trim()
        ? obj['chat_id'].trim()
        : null;
  if (obj['chat_id'] !== undefined && obj['chat_id'] !== null && chat_id === null) {
    return fail('invalid_argument', "Field 'chat_id' must be a non-empty string when provided.");
  }
  const before_sequence =
    obj['before_sequence'] === undefined || obj['before_sequence'] === null
      ? null
      : typeof obj['before_sequence'] === 'number' &&
          Number.isInteger(obj['before_sequence']) &&
          obj['before_sequence'] > 0
        ? obj['before_sequence']
        : null;
  if (
    obj['before_sequence'] !== undefined &&
    obj['before_sequence'] !== null &&
    before_sequence === null
  ) {
    return fail(
      'invalid_argument',
      "Field 'before_sequence' must be a positive integer when provided.",
    );
  }
  const limit =
    obj['limit'] === undefined || obj['limit'] === null
      ? 20
      : typeof obj['limit'] === 'number' &&
          Number.isInteger(obj['limit']) &&
          obj['limit'] >= 1 &&
          obj['limit'] <= 50
        ? obj['limit']
        : null;
  if (limit === null) {
    return fail(
      'invalid_argument',
      "Field 'limit' must be an integer between 1 and 50 when provided.",
    );
  }
  return { ok: true, data: { chat_id, before_sequence, limit } };
}

function validateReminderInstant(value: unknown): ValidationResult<string> {
  if (typeof value !== 'string' || !ISO_INSTANT_REGEX.test(value) || isNaN(Date.parse(value))) {
    return fail('invalid_instant', "Field 'at' must be a valid offset-bearing ISO instant.");
  }
  return { ok: true, data: value };
}

function validateReminderChannel(value: unknown): ValidationResult<'web' | 'telegram' | undefined> {
  if (value === undefined) return { ok: true, data: undefined };
  if (value === 'web' || value === 'telegram') return { ok: true, data: value };
  return fail('invalid_channel', "Field 'channel' must be 'web' or 'telegram'.");
}

function validateReminderTimezone(value: unknown): ValidationResult<string | null | undefined> {
  if (value === undefined) return { ok: true, data: undefined };
  if (value === null) return { ok: true, data: null };
  if (typeof value === 'string' && value.trim() && isValidIanaTimezone(value.trim())) {
    return { ok: true, data: value.trim() };
  }
  return fail('invalid_timezone', "Field 'timezone' must be a valid IANA timezone or null.");
}

export function validateCreateReminderArgs(raw: unknown): ValidationResult<CreateReminderToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(
    obj,
    new Set(['text', 'at', 'timezone', 'channel']),
    'create_reminder',
  );
  if (unk) return unk;

  if (typeof obj['text'] !== 'string' || !obj['text'].trim()) {
    return fail('invalid_argument', "Field 'text' must be a non-empty string.");
  }
  const text = obj['text'].trim();
  if (text.length > 500)
    return fail('invalid_argument', 'Reminder text exceeds maximum 500 characters.');
  const atRes = validateReminderInstant(obj['at']);
  if (!atRes.ok) return atRes;
  const tzRes = validateReminderTimezone(obj['timezone']);
  if (!tzRes.ok) return tzRes;
  const channelRes = validateReminderChannel(obj['channel']);
  if (!channelRes.ok) return channelRes;
  return {
    ok: true,
    data: {
      text,
      at: atRes.data,
      ...(tzRes.data !== undefined ? { timezone: tzRes.data } : {}),
      ...(channelRes.data !== undefined ? { channel: channelRes.data } : {}),
    },
  };
}

export function validateUpdateReminderArgs(raw: unknown): ValidationResult<UpdateReminderToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(
    obj,
    new Set(['reminder_id', 'text', 'at', 'timezone', 'channel']),
    'update_reminder',
  );
  if (unk) return unk;

  if (typeof obj['reminder_id'] !== 'string' || !obj['reminder_id'].trim()) {
    return fail('invalid_argument', "Field 'reminder_id' must be a non-empty string.");
  }
  let text: string | undefined;
  if (obj['text'] !== undefined) {
    if (typeof obj['text'] !== 'string' || !obj['text'].trim()) {
      return fail('invalid_argument', "Field 'text' must be a non-empty string when provided.");
    }
    text = obj['text'].trim();
    if (text.length > 500)
      return fail('invalid_argument', 'Reminder text exceeds maximum 500 characters.');
  }
  let at: string | undefined;
  if (obj['at'] !== undefined) {
    const atRes = validateReminderInstant(obj['at']);
    if (!atRes.ok) return atRes;
    at = atRes.data;
  }
  const tzRes = validateReminderTimezone(obj['timezone']);
  if (!tzRes.ok) return tzRes;
  const channelRes = validateReminderChannel(obj['channel']);
  if (!channelRes.ok) return channelRes;
  if (
    text === undefined &&
    at === undefined &&
    tzRes.data === undefined &&
    channelRes.data === undefined
  ) {
    return fail(
      'missing_patch',
      'Update reminder requires at least one field to update (text, at, timezone, channel).',
    );
  }
  return {
    ok: true,
    data: {
      reminder_id: (obj['reminder_id'] as string).trim(),
      ...(text !== undefined ? { text } : {}),
      ...(at !== undefined ? { at } : {}),
      ...(tzRes.data !== undefined ? { timezone: tzRes.data } : {}),
      ...(channelRes.data !== undefined ? { channel: channelRes.data } : {}),
    },
  };
}

export function validateCancelReminderArgs(raw: unknown): ValidationResult<CancelReminderToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(obj, new Set(['reminder_id']), 'cancel_reminder');
  if (unk) return unk;

  if (typeof obj['reminder_id'] !== 'string' || !obj['reminder_id'].trim()) {
    return fail('invalid_argument', "Field 'reminder_id' must be a non-empty string.");
  }
  return { ok: true, data: { reminder_id: obj['reminder_id'].trim() } };
}

export function validateQueryArgs(raw: unknown): ValidationResult<QueryToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(
    obj,
    new Set([
      'resource',
      'filters',
      'limit',
      'cursor',
      'section',
      'order',
      'entity_id',
      'target_entity_id',
      'text',
      'query',
    ]),
    'query',
  );
  if (unk) return unk;

  let topEntityId: string | undefined;
  if (obj['entity_id'] !== undefined) {
    if (typeof obj['entity_id'] !== 'string' || !obj['entity_id'].trim()) {
      return fail('invalid_argument', "Field 'entity_id' must be a non-empty string.");
    }
    topEntityId = obj['entity_id'].trim();
  }

  let topTargetEntityId: string | undefined;
  if (obj['target_entity_id'] !== undefined) {
    if (typeof obj['target_entity_id'] !== 'string' || !obj['target_entity_id'].trim()) {
      return fail('invalid_argument', "Field 'target_entity_id' must be a non-empty string.");
    }
    topTargetEntityId = obj['target_entity_id'].trim();
  }

  let topText: string | undefined;
  if (typeof obj['text'] === 'string' && obj['text'].trim()) {
    topText = obj['text'].trim();
  } else if (typeof obj['query'] === 'string' && obj['query'].trim()) {
    topText = obj['query'].trim();
  }

  const validResources = new Set([
    'entities',
    'tasks',
    'events',
    'interactions',
    'drafts',
    'attachments',
    'lead_overview',
    'entity_file',
    'merge_preview',
    'followups',
    'members',
    'duplicates',
    'search',
    'records',
    'documents',
  ]);
  if (typeof obj['resource'] !== 'string' || !validResources.has(obj['resource'])) {
    return fail(
      'invalid_argument',
      'Unknown query resource. Use entities, tasks, events, interactions, drafts, attachments, lead_overview, entity_file, followups, members, duplicates, search, records, or documents.',
    );
  }

  let limit: number | undefined;
  if (obj['limit'] !== undefined) {
    if (
      typeof obj['limit'] !== 'number' ||
      !Number.isInteger(obj['limit']) ||
      obj['limit'] < 1 ||
      obj['limit'] > 100
    ) {
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
        'interaction_id',
        'entity_id',
        'target_entity_id',
        'author_user_id',
        'from',
        'to',
        'include_removed',
        'entity_status',
        'task_status',
        'event_kind',
        'assignee_user_id',
        'due_before',
        'due_after',
        'kind',
        'text',
        'query',
        'status',
        'overdue_only',
        'without_next_step',
        'columns',
        'list_id',
        'chat_id',
        'document_id',
      ]),
      'query.filters',
    );
    if (fUnk) return fUnk;

    if (fObj['entity_status'] !== undefined) {
      if (
        typeof fObj['entity_status'] !== 'string' ||
        !VALID_LEAD_STATUSES.has(fObj['entity_status'] as LeadStatus)
      ) {
        return fail(
          'invalid_argument',
          `Filter 'entity_status' must be one of: ${Array.from(VALID_LEAD_STATUSES).join(', ')}.`,
        );
      }
    }
    if (fObj['task_status'] !== undefined) {
      if (
        typeof fObj['task_status'] !== 'string' ||
        !VALID_TASK_STATUSES.has(fObj['task_status'] as TaskStatus)
      ) {
        return fail(
          'invalid_argument',
          `Filter 'task_status' must be one of: ${Array.from(VALID_TASK_STATUSES).join(', ')}.`,
        );
      }
    }

    filters = {
      interaction_id:
        typeof fObj['interaction_id'] === 'string' ? fObj['interaction_id'].trim() : undefined,
      entity_id: typeof fObj['entity_id'] === 'string' ? fObj['entity_id'].trim() : undefined,
      target_entity_id:
        typeof fObj['target_entity_id'] === 'string' ? fObj['target_entity_id'].trim() : undefined,
      author_user_id:
        typeof fObj['author_user_id'] === 'string' ? fObj['author_user_id'].trim() : undefined,
      include_removed:
        typeof fObj['include_removed'] === 'boolean' ? fObj['include_removed'] : undefined,
      from: typeof fObj['from'] === 'string' ? fObj['from'] : undefined,
      to: typeof fObj['to'] === 'string' ? fObj['to'] : undefined,
      entity_status: fObj['entity_status'] as LeadStatus | undefined,
      task_status: fObj['task_status'] as TaskStatus | undefined,
      event_kind: typeof fObj['event_kind'] === 'string' ? fObj['event_kind'].trim() : undefined,
      assignee_user_id:
        typeof fObj['assignee_user_id'] === 'string' ? fObj['assignee_user_id'].trim() : undefined,
      due_before: typeof fObj['due_before'] === 'string' ? fObj['due_before'].trim() : undefined,
      due_after: typeof fObj['due_after'] === 'string' ? fObj['due_after'].trim() : undefined,
      kind: typeof fObj['kind'] === 'string' ? fObj['kind'].trim() : undefined,
      text: typeof fObj['text'] === 'string' ? fObj['text'].trim() : undefined,
      overdue_only: typeof fObj['overdue_only'] === 'boolean' ? fObj['overdue_only'] : undefined,
      list_id: typeof fObj['list_id'] === 'string' ? fObj['list_id'].trim() : undefined,
      chat_id: typeof fObj['chat_id'] === 'string' ? fObj['chat_id'].trim() : undefined,
      document_id: typeof fObj['document_id'] === 'string' ? fObj['document_id'].trim() : undefined,
    };
    if (filters.kind !== undefined && (filters.kind.length === 0 || filters.kind.length > 64)) {
      return fail(
        'invalid_argument',
        "Filter 'kind' must be a non-empty string of at most 64 characters.",
      );
    }
  }

  if (topEntityId || topTargetEntityId || topText) {
    filters = {
      ...filters,
      ...(topEntityId && !filters?.entity_id ? { entity_id: topEntityId } : {}),
      ...(topTargetEntityId && !filters?.target_entity_id
        ? { target_entity_id: topTargetEntityId }
        : {}),
      ...(topText && !filters?.text ? { text: topText } : {}),
    };
  }

  if (obj['resource'] === 'merge_preview' && (!filters?.entity_id || !filters.target_entity_id))
    return fail('invalid_argument', 'A merge preview needs both client IDs.');
  if (obj['resource'] === 'entity_file') {
    if (!filters?.entity_id || (limit ?? 20) > 50)
      return fail(
        'invalid_argument',
        'entity_file needs an entity_id and a page size from 1 to 50.',
      );
    if (
      obj['section'] !== undefined &&
      !ENTITY_FILE_SECTIONS.includes(obj['section'] as EntityFileSection)
    )
      return fail('invalid_argument', 'Unknown file section.');
    if (obj['order'] !== undefined && !['occurred', 'recorded'].includes(String(obj['order'])))
      return fail('invalid_argument', 'Use occurred or recorded order.');
    if (obj['cursor'] !== undefined && !obj['section'])
      return fail('invalid_argument', 'A file cursor needs its section.');
  } else if (
    obj['section'] !== undefined ||
    (obj['order'] !== undefined &&
      !(obj['resource'] === 'tasks' && obj['order'] === 'overdue_first'))
  )
    return fail('invalid_argument', 'Use section/order for files, or overdue_first for tasks.');
  for (const key of ['from', 'to'] as const) {
    if (filters?.[key] !== undefined) {
      const date = normalizeInteractionOccurredAt(filters[key]);
      if (!date) return fail('invalid_argument', `${key} requires a valid zoned timestamp.`);
      filters[key] = date;
    }
  }
  if (filters?.from && filters.to && filters.from >= filters.to)
    return fail('invalid_argument', 'Choose a nonempty time interval.');
  if (['tasks', 'attachments', 'followups'].includes(String(obj['resource'])) && (limit ?? 25) > 50)
    return fail('invalid_argument', 'This resource has a 50-row page limit.');
  if (obj['resource'] === 'interactions') {
    const supplied = (filters ?? {}) as Record<string, unknown>;
    const allowed = new Set([
      'entity_id',
      'interaction_id',
      'kind',
      'text',
      'author_user_id',
      'from',
      'to',
    ]);
    for (const [key, value] of Object.entries(supplied)) {
      if (value !== undefined && (!allowed.has(key) || typeof value !== 'string' || !value.trim())) {
        return fail('invalid_argument', `Invalid current-interaction filter '${key}'.`);
      }
    }
    if (filters?.kind && !['note', 'visit', 'contact', 'quote'].includes(filters.kind)) {
      return fail('invalid_argument', 'Interaction kind must be note, visit, contact, or quote.');
    }
    if (
      obj['cursor'] !== undefined &&
      (typeof obj['cursor'] !== 'string' ||
        !/^\d+$/.test(obj['cursor']) ||
        !Number.isSafeInteger(Number(obj['cursor'])))
    ) {
      return fail('invalid_argument', 'Invalid current-interaction cursor.');
    }
  }
  if (obj['resource'] === 'lead_overview') {
    const overview = validateLeadOverviewArgs(obj['filters'], obj['limit'], obj['cursor']);
    if (!overview.ok) return overview;
    return {
      ok: true,
      data: {
        resource: 'lead_overview',
        filters: overview.data.filters,
        limit: overview.data.limit,
        cursor: overview.data.cursor,
      },
    };
  }

  return {
    ok: true,
    data: {
      resource: obj['resource'] as QueryToolArgs['resource'],
      section: obj['section'] as EntityFileSection | undefined,
      order: obj['order'] as QueryToolArgs['order'],
      filters,
      limit,
      cursor: typeof obj['cursor'] === 'string' ? obj['cursor'].trim() : undefined,
      ...(topEntityId || filters?.entity_id ? { entity_id: topEntityId ?? filters?.entity_id } : {}),
      ...(topTargetEntityId || filters?.target_entity_id
        ? { target_entity_id: topTargetEntityId ?? filters?.target_entity_id }
        : {}),
    },
  };
}

const LEAD_OVERVIEW_STATUSES: readonly string[] = [
  'new',
  'cold',
  'warm',
  'hot',
  'won',
  'lost',
  'deprioritized',
];
const LEAD_OVERVIEW_COLUMN_IDS: readonly string[] = [
  'status',
  'next_step',
  'due',
  'owner',
  'last_contact',
];

function validateLeadOverviewArgs(
  filtersRaw: unknown,
  limitRaw: unknown,
  cursorRaw: unknown,
): ValidationResult<{ filters?: QueryToolArgs['filters']; limit?: number; cursor?: string }> {
  let filters: QueryToolArgs['filters'];
  if (filtersRaw !== undefined) {
    if (!filtersRaw || typeof filtersRaw !== 'object' || Array.isArray(filtersRaw)) {
      return fail('invalid_argument', "Field 'filters' must be an object.");
    }
    const fObj = filtersRaw as Record<string, unknown>;
    if (fObj['status'] !== undefined) {
      if (typeof fObj['status'] !== 'string' || !LEAD_OVERVIEW_STATUSES.includes(fObj['status'])) {
        return fail(
          'invalid_argument',
          `Filter 'status' must be one of: ${LEAD_OVERVIEW_STATUSES.join(', ')}.`,
        );
      }
    }
    for (const flag of ['overdue_only', 'without_next_step'] as const) {
      if (fObj[flag] !== undefined && typeof fObj[flag] !== 'boolean') {
        return fail('invalid_argument', `Filter '${flag}' must be a boolean.`);
      }
    }
    let columns: string[] | undefined;
    if (fObj['columns'] !== undefined) {
      if (
        !Array.isArray(fObj['columns']) ||
        fObj['columns'].some((c) => typeof c !== 'string' || !LEAD_OVERVIEW_COLUMN_IDS.includes(c))
      ) {
        return fail(
          'invalid_argument',
          `Filter 'columns' must be an array of: ${LEAD_OVERVIEW_COLUMN_IDS.join(', ')}.`,
        );
      }
      columns = [...new Set(fObj['columns'] as string[])];
    }
    filters = {
      ...(typeof fObj['status'] === 'string' ? { status: fObj['status'] as LeadStatus } : {}),
      ...(fObj['overdue_only'] === true ? { overdue_only: true } : {}),
      ...(fObj['without_next_step'] === true ? { without_next_step: true } : {}),
      ...(columns ? { columns } : {}),
    };
  }
  let limit: number | undefined;
  if (limitRaw !== undefined) {
    if (
      typeof limitRaw !== 'number' ||
      !Number.isInteger(limitRaw) ||
      limitRaw < 1 ||
      limitRaw > 50
    ) {
      return fail(
        'invalid_argument',
        "Field 'limit' must be an integer between 1 and 50 for lead_overview pages.",
      );
    }
    limit = limitRaw;
  }
  return {
    ok: true,
    data: {
      filters,
      limit,
      cursor: typeof cursorRaw === 'string' ? cursorRaw.trim() : undefined,
    },
  };
}

export function validateViewImageArgs(raw: unknown): ValidationResult<ViewImageToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(obj, new Set(['media_id', 'detail']), 'view_image');
  if (unk) return unk;

  if (typeof obj['media_id'] !== 'string' || obj['media_id'].trim().length === 0) {
    return fail('invalid_argument', "Field 'media_id' must be a non-empty string.");
  }
  if (obj['media_id'].trim().length > 128) {
    return fail('invalid_argument', "Field 'media_id' must be at most 128 characters.");
  }
  if (obj['detail'] !== undefined && obj['detail'] !== 'standard' && obj['detail'] !== 'original') {
    return fail('invalid_argument', "Field 'detail' must be 'standard' or 'original'.");
  }

  return {
    ok: true,
    data: {
      media_id: obj['media_id'].trim(),
      ...(obj['detail'] !== undefined ? { detail: obj['detail'] as 'standard' | 'original' } : {}),
    },
  };
}

export function validateSearchMemoryArgs(raw: unknown): ValidationResult<SearchMemoryToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(
    obj,
    new Set(['query', 'scope', 'subject_id', 'limit']),
    'search_memory',
  );
  if (unk) return unk;

  if (typeof obj['query'] !== 'string' || !obj['query'].trim()) {
    return fail('invalid_argument', "Field 'query' must be a non-empty string.");
  }
  const query = obj['query'].trim();
  if (query.length > 500) return fail('invalid_argument', 'Search query exceeds 500 characters.');

  const validScopes = new Set(['workspace', 'entity', 'member_in_workspace']);
  let scope: MemoryScope | undefined;
  if (obj['scope'] !== undefined) {
    if (typeof obj['scope'] !== 'string' || !validScopes.has(obj['scope'])) {
      return fail(
        'invalid_argument',
        "Field 'scope' must be 'workspace', 'entity', or 'member_in_workspace'.",
      );
    }
    scope = obj['scope'] as MemoryScope;
  }

  let limit: number | undefined;
  if (obj['limit'] !== undefined) {
    if (
      typeof obj['limit'] !== 'number' ||
      !Number.isInteger(obj['limit']) ||
      obj['limit'] < 1 ||
      obj['limit'] > 50
    ) {
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
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return fail('invalid_type', 'Expected object.');
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

export function validateRememberContextArgs(
  raw: unknown,
): ValidationResult<RememberContextToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(
    obj,
    new Set([
      'scope',
      'subject_id',
      'category',
      'content',
      'source_message_id',
      'supersedes_memory_id',
    ]),
    'remember_context',
  );
  if (unk) return unk;

  const validScopes = new Set(['workspace', 'entity', 'member_in_workspace']);
  if (typeof obj['scope'] !== 'string' || !validScopes.has(obj['scope'])) {
    return fail(
      'invalid_argument',
      "Field 'scope' must be 'workspace', 'entity', or 'member_in_workspace'.",
    );
  }
  const scope = obj['scope'] as MemoryScope;

  const validCats = new Set([
    'communication_preference',
    'relationship_context',
    'workflow_context',
    'other_context',
  ]);
  if (typeof obj['category'] !== 'string' || !validCats.has(obj['category'])) {
    return fail(
      'invalid_argument',
      `Field 'category' must be one of: ${Array.from(validCats).join(', ')}.`,
    );
  }
  const category = obj['category'] as MemoryCategory;

  if (typeof obj['content'] !== 'string' || !obj['content'].trim()) {
    return fail('invalid_argument', "Field 'content' must be a non-empty string.");
  }
  const content = obj['content'].trim();
  if (content.length > 4000)
    return fail('invalid_argument', 'Memory content exceeds 4000 characters.');

  const subject_id =
    typeof obj['subject_id'] === 'string' && obj['subject_id'].trim()
      ? obj['subject_id'].trim()
      : null;
  if (scope === 'workspace' && subject_id !== null) {
    return fail('invalid_subject', 'Workspace scope cannot specify a subject_id.');
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
      source_message_id:
        typeof obj['source_message_id'] === 'string' ? obj['source_message_id'].trim() : null,
      supersedes_memory_id:
        typeof obj['supersedes_memory_id'] === 'string' ? obj['supersedes_memory_id'].trim() : null,
    },
  };
}

export function validateForgetMemoryArgs(raw: unknown): ValidationResult<ForgetMemoryToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return fail('invalid_type', 'Expected object.');
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

export function validateUpdatePreferenceArgs(
  raw: unknown,
): ValidationResult<UpdatePreferenceToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return fail('invalid_type', 'Expected object.');
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
    if (typeof obj['brief_enabled'] !== 'boolean')
      return fail('invalid_argument', "Field 'brief_enabled' must be boolean.");
    brief_enabled = obj['brief_enabled'];
  }

  const brief_local_time =
    typeof obj['brief_local_time'] === 'string'
      ? obj['brief_local_time'].trim()
      : obj['brief_local_time'] === null
        ? null
        : undefined;
  const brief_timezone =
    typeof obj['brief_timezone'] === 'string'
      ? obj['brief_timezone'].trim()
      : obj['brief_timezone'] === null
        ? null
        : undefined;
  const brief_channel =
    obj['brief_channel'] === 'telegram'
      ? 'telegram'
      : obj['brief_channel'] === 'web'
        ? 'web'
        : undefined;

  let brief_weekdays: number[] | null | undefined;
  if (obj['brief_weekdays'] !== undefined) {
    if (obj['brief_weekdays'] === null) {
      brief_weekdays = null;
    } else if (Array.isArray(obj['brief_weekdays'])) {
      if (obj['brief_weekdays'].some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
        return fail('invalid_argument', 'Brief weekdays must be an array of integers 0 to 6.');
      }
      brief_weekdays = obj['brief_weekdays'] as number[];
    } else {
      return fail('invalid_argument', 'Brief weekdays must be an array or null.');
    }
  }

  const preferred_language =
    typeof obj['preferred_language'] === 'string' ? obj['preferred_language'].trim() : undefined;

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

export function validateSetChatThinkingArgs(
  raw: unknown,
): ValidationResult<SetChatThinkingToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return fail('invalid_type', 'Expected object.');
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

export interface SetChatModelToolArgs {
  model: string;
}

export function validateSetChatModelArgs(raw: unknown): ValidationResult<SetChatModelToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(obj, new Set(['model']), 'set_chat_model');
  if (unk) return unk;

  if (typeof obj['model'] !== 'string' || !obj['model'].trim()) {
    return fail('invalid_argument', "Field 'model' must be a non-empty string.");
  }

  return { ok: true, data: { model: obj['model'].trim() } };
}

export interface ExecuteCommandToolArgs {
  command_text: string;
}

export function validateExecuteCommandArgs(raw: unknown): ValidationResult<ExecuteCommandToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(obj, new Set(['command_text']), 'execute_command');
  if (unk) return unk;

  if (typeof obj['command_text'] !== 'string' || !obj['command_text'].trim()) {
    return fail('invalid_argument', "Field 'command_text' must be a non-empty string.");
  }

  return { ok: true, data: { command_text: obj['command_text'].trim() } };
}

export function validateUndoArgs(raw: unknown): ValidationResult<UndoToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj, '', new Set(['action_id', 'actionid']));
  if (sec) return sec;
  const unk = checkNoUnknownKeys(obj, new Set(['action_id', 'mode']), 'undo');
  if (unk) return unk;

  const mode = obj['mode'] === 'single' ? 'single' : 'from_here';
  const action_id =
    typeof obj['action_id'] === 'string' && obj['action_id'].trim()
      ? obj['action_id'].trim()
      : undefined;

  return { ok: true, data: { action_id, mode } };
}

export function validateRequestClarificationArgs(
  raw: unknown,
): ValidationResult<RequestClarificationToolArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return fail('invalid_type', 'Expected object.');
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(
    obj,
    new Set([
      'question',
      'intended_operation',
      'missing_fields',
      'proposed_arguments',
      'candidates',
    ]),
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
    return fail(
      'invalid_argument',
      "Field 'missing_fields' must be a non-empty array of field names.",
    );
  }

  return {
    ok: true,
    data: {
      question: obj['question'].trim(),
      intended_operation: obj['intended_operation'].trim(),
      missing_fields: obj['missing_fields'].map(String),
      proposed_arguments:
        obj['proposed_arguments'] && typeof obj['proposed_arguments'] === 'object'
          ? (obj['proposed_arguments'] as Record<string, unknown>)
          : undefined,
      candidates: Array.isArray(obj['candidates']) ? obj['candidates'].map(String) : undefined,
    },
  };
}

// Master dispatcher for runtime tool argument validation
export function validateHistorySearch(raw: unknown): ValidationResult<SearchWorkspaceHistoryArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return fail('invalid_argument', 'Enter search words.');
  const obj = raw as Record<string, unknown>;
  const error =
    checkNoForbiddenKeys(obj) ??
    checkNoUnknownKeys(
      obj,
      new Set([
        'query',
        'chat_id',
        'entity_id',
        'author_user_id',
        'from',
        'to',
        'source_kind',
        'mode',
        'limit',
        'cursor',
      ]),
      'search_workspace_history',
    );
  if (error) return error;
  if (
    typeof obj.query !== 'string' ||
    !obj.query.trim() ||
    obj.query.length > 500 ||
    (obj.query.match(/[\p{L}\p{N}]+/gu)?.length ?? 0) > 10
  )
    return fail('invalid_argument', 'Use up to ten search words.');
  for (const key of ['chat_id', 'entity_id', 'author_user_id', 'from', 'to', 'cursor'])
    if (
      obj[key] !== undefined &&
      (typeof obj[key] !== 'string' ||
        !obj[key] ||
        String(obj[key]).length > (key === 'cursor' ? 4000 : 128))
    )
      return fail('invalid_argument', `Invalid ${key}.`);
  if (
    obj.source_kind !== undefined &&
    !['member', 'otis', 'system'].includes(String(obj.source_kind))
  )
    return fail('invalid_argument', 'Choose member, otis or system evidence.');
  if (obj.mode !== undefined && !['relevance', 'chronological'].includes(String(obj.mode)))
    return fail('invalid_argument', 'Choose relevance or chronological search.');
  if (
    obj.limit !== undefined &&
    (!Number.isInteger(obj.limit) || Number(obj.limit) < 1 || Number(obj.limit) > 50)
  )
    return fail('invalid_argument', 'Choose 1–50 results.');
  if (obj.from !== undefined && !normalizeInteractionOccurredAt(obj.from))
    return fail('invalid_argument', 'Use a zoned start instant.');
  if (obj.to !== undefined && !normalizeInteractionOccurredAt(obj.to))
    return fail('invalid_argument', 'Use a zoned end instant.');
  return { ok: true, data: obj as unknown as SearchWorkspaceHistoryArgs };
}
export function validateContactChange(raw: unknown): ValidationResult<ChangeContactArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return fail('invalid_argument', 'Choose a contact change.');
  const obj = raw as Record<string, unknown>;
  const error =
    checkNoForbiddenKeys(obj) ??
    checkNoUnknownKeys(
      obj,
      new Set([
        'entity_id',
        'contact_id',
        'expected_revision',
        'operation',
        'method',
        'value',
        'label',
        'primary',
      ]),
      'change_contact',
    );
  if (error) return error;
  if (
    typeof obj.entity_id !== 'string' ||
    !obj.entity_id.trim() ||
    !['save', 'remove', 'make_primary'].includes(String(obj.operation))
  )
    return fail('invalid_argument', 'Choose a client and save/remove/make_primary.');
  if (
    obj.contact_id !== undefined &&
    (typeof obj.contact_id !== 'string' ||
      !obj.contact_id ||
      !Number.isSafeInteger(obj.expected_revision) ||
      Number(obj.expected_revision) < 1)
  )
    return fail('invalid_argument', 'An existing contact needs its current revision.');
  if (obj.operation !== 'save' && !obj.contact_id)
    return fail('invalid_argument', 'Choose the existing contact.');
  if (obj.method !== undefined && !['phone', 'email'].includes(String(obj.method)))
    return fail('invalid_argument', 'Use phone or email.');
  if (!obj.contact_id && (typeof obj.value !== 'string' || !obj.method))
    return fail('invalid_argument', 'A new contact needs a type and value.');
  if (
    obj.value !== undefined &&
    (typeof obj.value !== 'string' || !obj.value.trim() || obj.value.length > 320)
  )
    return fail('invalid_argument', 'Enter a contact value.');
  if (
    obj.label !== undefined &&
    obj.label !== null &&
    (typeof obj.label !== 'string' || obj.label.length > 80)
  )
    return fail('invalid_argument', 'Use a short label.');
  if (obj.primary !== undefined && typeof obj.primary !== 'boolean')
    return fail('invalid_argument', 'primary must be true or false.');
  return { ok: true, data: obj as unknown as ChangeContactArgs };
}
export function validateMergeEntities(raw: unknown): ValidationResult<MergeEntitiesArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return fail('invalid_argument', 'Choose two files to combine.');
  const obj = raw as Record<string, unknown>;
  const error =
    checkNoForbiddenKeys(obj) ??
    checkNoUnknownKeys(
      obj,
      new Set(['source_entity_id', 'target_entity_id', 'expected_revision', 'decisions']),
      'merge_entities',
    );
  if (error) return error;
  if (
    typeof obj.source_entity_id !== 'string' ||
    !obj.source_entity_id ||
    typeof obj.target_entity_id !== 'string' ||
    !obj.target_entity_id ||
    !Number.isSafeInteger(obj.expected_revision) ||
    Number(obj.expected_revision) < 0
  )
    return fail('invalid_argument', 'Choose two files and the preview revision.');
  if (
    obj.decisions !== undefined &&
    (!obj.decisions ||
      typeof obj.decisions !== 'object' ||
      Array.isArray(obj.decisions) ||
      Object.keys(obj.decisions).length > 50 ||
      Object.values(obj.decisions).some(
        (v) => v !== obj.source_entity_id && v !== obj.target_entity_id,
      ))
  )
    return fail('invalid_argument', 'Conflict choices must select one of these files.');
  return { ok: true, data: obj as unknown as MergeEntitiesArgs };
}

function validateCapabilityArgs(name: string, raw: unknown): ValidationResult<unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return fail('invalid_argument', 'Provide the requested details.');
  const o = { ...(raw as Record<string, unknown>) };
  const allowed: Record<string, string[]> = {
    link_attachment: ['entity_id', 'media_id', 'interaction_id', 'label'],
    unlink_attachment: ['link_id', 'expected_revision'],
    update_attachment: [
      'entity_id',
      'media_id',
      'expected_revision',
      'transcript',
      'restore_original_transcript',
      'retention',
    ],
    read_document: ['media_id', 'cursor', 'limit'],
    read_source: ['source_id'],
    change_reminder_rule: [
      'rule_id',
      'expected_revision',
      'entity_id',
      'text',
      'timezone',
      'channel',
      'spec',
      'status',
    ],
  };
  const error = checkNoForbiddenKeys(o) ?? checkNoUnknownKeys(o, new Set(allowed[name]), name);
  if (error) return error;
  if (name === 'update_attachment' && o.restore_original_transcript !== undefined) {
    if (o.restore_original_transcript !== true || o.transcript !== undefined)
      return fail(
        'invalid_argument',
        'Choose either a correction or restoring the original transcript.',
      );
    o.transcript = null;
    delete o.restore_original_transcript;
  }
  for (const key of ['entity_id', 'media_id', 'interaction_id', 'link_id', 'rule_id', 'source_id'])
    if (
      o[key] !== undefined &&
      !(name === 'change_reminder_rule' && key === 'entity_id' && o[key] === null) &&
      (typeof o[key] !== 'string' || !o[key] || String(o[key]).length > 128)
    )
      return fail('invalid_argument', `Invalid ${key}.`);
  if (
    (name === 'link_attachment' && (!o.entity_id || !o.media_id)) ||
    (name === 'unlink_attachment' && !o.link_id) ||
    (name === 'read_document' && !o.media_id) ||
    (name === 'read_source' && !o.source_id)
  )
    return fail('invalid_argument', 'Choose the source, file or client.');
  if (
    (o.expected_revision !== undefined &&
      (!Number.isSafeInteger(o.expected_revision) ||
        Number(o.expected_revision) < (name === 'update_attachment' ? 0 : 1))) ||
    ((o.rule_id || o.link_id || name === 'update_attachment') && o.expected_revision === undefined)
  )
    return fail('invalid_argument', 'Use the current revision before editing.');
  if (
    name === 'update_attachment' &&
    (!o.entity_id ||
      !o.media_id ||
      (o.transcript === undefined && o.retention === undefined) ||
      (o.transcript !== undefined &&
        o.transcript !== null &&
        (typeof o.transcript !== 'string' ||
          !o.transcript.trim() ||
          o.transcript.length > 50_000)) ||
      (o.retention !== undefined && !['retain', 'release'].includes(String(o.retention))))
  )
    return fail(
      'invalid_argument',
      'Choose a saved file and a corrected transcript or explicit retention change.',
    );
  if (o.label !== undefined && (typeof o.label !== 'string' || o.label.length > 200))
    return fail('invalid_argument', 'Use a short label.');
  if (
    name === 'read_document' &&
    ((o.limit !== undefined &&
      (!Number.isInteger(o.limit) || Number(o.limit) < 1 || Number(o.limit) > 5)) ||
      (o.cursor !== undefined && (typeof o.cursor !== 'string' || o.cursor.length > 2000)))
  )
    return fail('invalid_argument', 'Choose 1–5 sections and a valid cursor.');
  if (name === 'change_reminder_rule') {
    if (!o.rule_id && (!o.text || !o.timezone || !o.channel || !o.spec))
      return fail(
        'invalid_argument',
        'A follow-up needs text, timing, timezone and channel. Ask for missing details.',
      );
    if (
      (o.text !== undefined &&
        (typeof o.text !== 'string' || !o.text.trim() || o.text.length > 1000)) ||
      (o.timezone !== undefined && !validReminderTimezone(o.timezone)) ||
      (o.spec !== undefined && !validateReminderSpec(o.spec)) ||
      (o.channel !== undefined && !['web', 'telegram'].includes(String(o.channel))) ||
      (o.status !== undefined && !['active', 'paused', 'cancelled'].includes(String(o.status)))
    )
      return fail('invalid_argument', 'Use a valid recurring follow-up schedule.');
    if (o.spec && (o.spec as { kind: string }).kind === 'after_quote' && !o.entity_id && !o.rule_id)
      return fail('invalid_argument', 'An after-quote follow-up needs a client.');
  }
  return { ok: true, data: o };
}

export function validateDocumentStartArgs(raw: unknown): ValidationResult<DocumentStartArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('invalid_type', 'Expected object.');
  }
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(
    obj,
    new Set(['title', 'intended_sections', 'document_id', 'base_revision_id']),
    'document_start',
  );
  if (unk) return unk;

  if (typeof obj['title'] !== 'string' || !obj['title'].trim()) {
    return fail('invalid_argument', "Field 'title' must be a non-empty string.");
  }
  if (obj['title'].trim().length > DOCUMENT_BOUNDS.MAX_TITLE_CHARS) {
    return fail('invalid_argument', `Field 'title' cannot exceed ${DOCUMENT_BOUNDS.MAX_TITLE_CHARS} characters.`);
  }

  if (!Array.isArray(obj['intended_sections']) || obj['intended_sections'].length === 0) {
    return fail('invalid_argument', "Field 'intended_sections' must be a non-empty array of section titles.");
  }
  if (obj['intended_sections'].length > DOCUMENT_BOUNDS.MAX_SECTIONS_PER_ROUND) {
    return fail('invalid_argument', `Field 'intended_sections' cannot exceed ${DOCUMENT_BOUNDS.MAX_SECTIONS_PER_ROUND} sections.`);
  }
  const intendedSections: string[] = [];
  for (const item of obj['intended_sections']) {
    if (typeof item !== 'string' || !item.trim()) {
      return fail('invalid_argument', "Each item in 'intended_sections' must be a non-empty string.");
    }
    intendedSections.push(item.trim());
  }

  let documentId: string | undefined;
  if (obj['document_id'] !== undefined) {
    if (typeof obj['document_id'] !== 'string' || !obj['document_id'].trim()) {
      return fail('invalid_argument', "Field 'document_id' must be a non-empty string.");
    }
    documentId = obj['document_id'].trim();
  }

  let baseRevisionId: string | undefined;
  if (obj['base_revision_id'] !== undefined) {
    if (typeof obj['base_revision_id'] !== 'string' || !obj['base_revision_id'].trim()) {
      return fail('invalid_argument', "Field 'base_revision_id' must be a non-empty string.");
    }
    baseRevisionId = obj['base_revision_id'].trim();
  }

  return {
    ok: true,
    data: {
      title: obj['title'].trim(),
      intended_sections: intendedSections,
      ...(documentId ? { document_id: documentId } : {}),
      ...(baseRevisionId ? { base_revision_id: baseRevisionId } : {}),
    },
  };
}

export function validateDocumentWriteSectionArgs(raw: unknown): ValidationResult<DocumentWriteSectionArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('invalid_type', 'Expected object.');
  }
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(
    obj,
    new Set(['document_id', 'revision_id', 'sections']),
    'document_write_section',
  );
  if (unk) return unk;

  if (typeof obj['document_id'] !== 'string' || !obj['document_id'].trim()) {
    return fail('invalid_argument', "Field 'document_id' must be a non-empty string.");
  }
  if (typeof obj['revision_id'] !== 'string' || !obj['revision_id'].trim()) {
    return fail('invalid_argument', "Field 'revision_id' must be a non-empty string.");
  }

  if (!Array.isArray(obj['sections']) || obj['sections'].length === 0) {
    return fail('invalid_argument', "Field 'sections' must be a non-empty array.");
  }
  if (obj['sections'].length > DOCUMENT_BOUNDS.MAX_SECTIONS_PER_ROUND) {
    return fail('invalid_argument', `Cannot write more than ${DOCUMENT_BOUNDS.MAX_SECTIONS_PER_ROUND} sections per call.`);
  }

  const sections: DocumentSectionInput[] = [];
  for (const s of obj['sections']) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      return fail('invalid_argument', 'Each section must be an object.');
    }
    const sObj = s as Record<string, unknown>;
    if (typeof sObj['id'] !== 'string' || !sObj['id'].trim()) {
      return fail('invalid_argument', "Section 'id' must be a non-empty string.");
    }
    if (typeof sObj['title'] !== 'string' || !sObj['title'].trim()) {
      return fail('invalid_argument', "Section 'title' must be a non-empty string.");
    }
    if (typeof sObj['content_markdown'] !== 'string') {
      return fail('invalid_argument', "Section 'content_markdown' must be a string.");
    }
    if (sObj['content_markdown'].length > DOCUMENT_BOUNDS.MAX_SECTION_CHARS) {
      return fail('invalid_argument', `Section '${sObj['title']}' exceeds maximum allowed length of ${DOCUMENT_BOUNDS.MAX_SECTION_CHARS} characters.`);
    }
    sections.push({
      id: sObj['id'].trim(),
      title: sObj['title'].trim(),
      content_markdown: sObj['content_markdown'],
    });
  }

  return {
    ok: true,
    data: {
      document_id: obj['document_id'].trim(),
      revision_id: obj['revision_id'].trim(),
      sections,
    },
  };
}

export function validateDocumentPublishArgs(raw: unknown): ValidationResult<DocumentPublishArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('invalid_type', 'Expected object.');
  }
  const obj = raw as Record<string, unknown>;
  const sec = checkNoForbiddenKeys(obj);
  if (sec) return sec;
  const unk = checkNoUnknownKeys(
    obj,
    new Set(['document_id', 'revision_id', 'render_pdf']),
    'document_publish',
  );
  if (unk) return unk;

  if (typeof obj['document_id'] !== 'string' || !obj['document_id'].trim()) {
    return fail('invalid_argument', "Field 'document_id' must be a non-empty string.");
  }
  if (typeof obj['revision_id'] !== 'string' || !obj['revision_id'].trim()) {
    return fail('invalid_argument', "Field 'revision_id' must be a non-empty string.");
  }

  let renderPdf: boolean | undefined;
  if (obj['render_pdf'] !== undefined) {
    if (typeof obj['render_pdf'] !== 'boolean') {
      return fail('invalid_argument', "Field 'render_pdf' must be a boolean.");
    }
    renderPdf = obj['render_pdf'];
  }

  return {
    ok: true,
    data: {
      document_id: obj['document_id'].trim(),
      revision_id: obj['revision_id'].trim(),
      render_pdf: renderPdf ?? true,
    },
  };
}

export function validateToolCall(name: string, rawArgs: unknown): ValidationResult<unknown> {
  switch (name) {
    case 'find_entities':
      return validateFindEntitiesArgs(rawArgs);
    case 'upsert_entity':
      return validateUpsertEntityArgs(rawArgs);
    case 'rename_entity':
      return validateRenameEntityArgs(rawArgs);
    case 'delete_entity':
      return validateDeleteEntityArgs(rawArgs);
    case 'log_event':
      return validateLogEventArgs(rawArgs);
    case 'revise_interaction':
      return validateReviseInteractionArgs(rawArgs);
    case 'remove_interaction':
      return validateRemoveInteractionArgs(rawArgs);
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
    case 'edit_records':
      return validateEditRecordsArgs(rawArgs);
    case 'mark_message_sent':
      return validateMarkMessageSentArgs(rawArgs);
    case 'search_workspace_history':
      return validateHistorySearch(rawArgs);
    case 'change_contact':
      return validateContactChange(rawArgs);
    case 'merge_entities':
      return validateMergeEntities(rawArgs);
    case 'link_attachment':
    case 'unlink_attachment':
    case 'update_attachment':
    case 'read_document':
    case 'read_source':
    case 'change_reminder_rule':
      return validateCapabilityArgs(name, rawArgs);
    case 'read_chat_history':
      return validateReadChatHistoryArgs(rawArgs);
    case 'create_reminder':
      return validateCreateReminderArgs(rawArgs);
    case 'update_reminder':
      return validateUpdateReminderArgs(rawArgs);
    case 'cancel_reminder':
      return validateCancelReminderArgs(rawArgs);
    case 'query':
      return validateQueryArgs(rawArgs);
    case 'view_image':
      return validateViewImageArgs(rawArgs);
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
    case 'set_chat_model':
      return validateSetChatModelArgs(rawArgs);
    case 'execute_command':
      return validateExecuteCommandArgs(rawArgs);
    case 'undo':
      return validateUndoArgs(rawArgs);
    case 'request_clarification':
      return validateRequestClarificationArgs(rawArgs);
    case 'document_start':
      return validateDocumentStartArgs(rawArgs);
    case 'document_write_section':
      return validateDocumentWriteSectionArgs(rawArgs);
    case 'document_publish':
      return validateDocumentPublishArgs(rawArgs);
    default:
      return fail('unknown_tool', `Unknown tool name '${name}'.`);
  }
}

/**
 * Tools that change business records when applied. The correction guard
 * treats any applied call from this set as the run having acted; everything
 * else only reads or configures and never satisfies a pending correction.
 */
export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
  'change_contact',
  'merge_entities',
  'link_attachment',
  'unlink_attachment',
  'update_attachment',
  'change_reminder_rule',
  'upsert_entity',
  'rename_entity',
  'delete_entity',
  'log_event',
  'revise_interaction',
  'remove_interaction',
  'set_fields',
  'resolve_conflict',
  'create_task',
  'update_task',
  'draft_message',
  'update_draft',
  'edit_records',
  'mark_message_sent',
  'create_reminder',
  'update_reminder',
  'cancel_reminder',
  'remember_context',
  'forget_memory',
  'update_preference',
  'execute_command',
  'undo',
  'document_start',
  'document_write_section',
  'document_publish',
]);

/** Tools that never change business records: reads, questions and chat configuration. */
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'search_workspace_history',
  'read_source',
  'read_document',
  'find_entities',
  'read_chat_history',
  'query',
  'view_image',
  'search_memory',
  'get_memory',
  'set_chat_model',
  'set_chat_thinking',
  'request_clarification',
]);

/**
 * True when the run applied at least one business mutation (or found the
 * requested state already applied). A correction answered with only reads
 * or words has not acted, and the correction guard may steer one more round.
 */
export function runAppliedBusinessMutation(
  results: Array<{ name: string; result: { status: string; data?: unknown } }>,
): boolean {
  return results.some(
    (entry) =>
      MUTATING_TOOL_NAMES.has(entry.name) &&
      (entry.result.status === 'applied' || entry.result.status === 'already_applied') &&
      // A staged draft patch performed zero business writes: proposing is
      // not acting, so the correction guard may still steer one more round.
      !(entry.result.data !== null &&
        typeof entry.result.data === 'object' &&
        'records_patch' in (entry.result.data as Record<string, unknown>)),
  );
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
    name: 'read_source',
    description:
      'Open an original workspace source by returned source/message ID, with author, time and surrounding conversation. Read this before treating a historical draft, suggestion or reply as a member promise.',
    parameters: {
      type: 'object',
      properties: { source_id: { type: 'string' } },
      required: ['source_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_document',
    description:
      'Read bounded extracted sections from a private retained file (PDF, text, markdown) or a generated document revision. Discover media IDs in message document attachments, entity_file attachments, or query documents. Follow next_cursor for more; never claim unread sections or invented page numbers.',
    parameters: {
      type: 'object',
      properties: {
        media_id: { type: 'string' },
        cursor: { type: 'string' },
        limit: { type: 'integer' },
      },
      required: ['media_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'link_attachment',
    description:
      'Keep a photo, PDF or original voice note with a client or a particular current entry. A link retains the original privately beyond chat retention. Use existing scoped media and client IDs.',
    parameters: {
      type: 'object',
      properties: {
        entity_id: { type: 'string' },
        media_id: { type: 'string' },
        interaction_id: { type: 'string' },
        label: { type: 'string' },
      },
      required: ['entity_id', 'media_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'unlink_attachment',
    description:
      'Remove a file from the current client view. Original bytes and history remain available for Undo. This does not erase the file.',
    parameters: {
      type: 'object',
      properties: { link_id: { type: 'string' }, expected_revision: { type: 'integer' } },
      required: ['link_id', 'expected_revision'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_attachment',
    description:
      'Correct a saved voice transcript without changing original audio or original transcript. Use restore_original_transcript: true to restore the original instead of a correction. Explicitly release retention only after removing every active link; a 14-day grace starts and permits Undo. Query entity_file attachments for annotation_revision (0 initially).',
    parameters: {
      type: 'object',
      properties: {
        entity_id: { type: 'string' },
        media_id: { type: 'string' },
        expected_revision: { type: 'integer' },
        transcript: { type: 'string' },
        restore_original_transcript: { type: 'boolean' },
        retention: { type: 'string', enum: ['retain', 'release'] },
      },
      required: ['entity_id', 'media_id', 'expected_revision'],
      additionalProperties: false,
    },
  },
  {
    name: 'change_reminder_rule',
    description:
      'Create/edit/pause/cancel an explicitly requested recurring follow-up. Weekly uses selected weekdays (0 Sunday), HH:mm and IANA timezone. after_quote uses offered/expected, elapsed hours OR calendar days at a local time, and an explicit if_no_contact condition. Ask for missing timing/channel; never enable unsolicited follow-ups. Use entity_file reminders for IDs/revisions.',
    parameters: {
      type: 'object',
      properties: {
        rule_id: { type: 'string' },
        expected_revision: { type: 'integer' },
        entity_id: { type: 'string' },
        text: { type: 'string' },
        timezone: { type: 'string' },
        channel: { type: 'string', enum: ['web', 'telegram'] },
        spec: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['weekly', 'after_quote'] },
            weekdays: { type: 'array', items: { type: 'integer' } },
            local_time: { type: 'string' },
            start_date: { type: 'string' },
            end_date: { type: 'string' },
            role: { type: 'string', enum: ['offered', 'expected'] },
            offset: {
              type: 'object',
              properties: {
                hours: { type: 'integer' },
                days: { type: 'integer' },
                local_time: { type: 'string' },
              },
            },
            if_no_contact: { type: 'boolean' },
          },
          required: ['kind'],
        },
        status: { type: 'string', enum: ['active', 'paused', 'cancelled'] },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'search_workspace_history',
    description:
      'Find retained conversations across this workspace, including other chats. Member statements, Otis replies and system notices are distinguished; a draft or suggestion is not a promise. Read the original chat/source before a consequential write. Plain words only. Dates are inclusive zoned start/exclusive zoned end. Relevance is bounded; chronological pages support exhaustive matching coverage once backfill completes.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        chat_id: { type: 'string' },
        entity_id: { type: 'string' },
        author_user_id: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
        source_kind: { type: 'string', enum: ['member', 'otis', 'system'] },
        mode: { type: 'string', enum: ['relevance', 'chronological'] },
        limit: { type: 'integer' },
        cursor: { type: 'string' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'change_contact',
    description:
      'Add, edit, remove or choose a primary phone/email. Preserve original formatting and country-free local numbers. Use query entity_file contacts for current IDs/revisions; new contacts do not silently replace a primary.',
    parameters: {
      type: 'object',
      properties: {
        entity_id: { type: 'string' },
        contact_id: { type: 'string' },
        expected_revision: { type: 'integer' },
        operation: { type: 'string', enum: ['save', 'remove', 'make_primary'] },
        method: { type: 'string', enum: ['phone', 'email'] },
        value: { type: 'string' },
        label: { type: 'string' },
        primary: { type: 'boolean' },
      },
      required: ['entity_id', 'operation'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_entities',
    description:
      'Combine two explicitly identified duplicate clients while preserving both original files and sources. First query merge_preview with entity_id and target_entity_id. Use the returned workspace revision. Unchosen conflicting facts remain disputed; decisions map field names to the chosen original client ID. Never infer same-person identity from similar names.',
    parameters: {
      type: 'object',
      properties: {
        source_entity_id: { type: 'string' },
        target_entity_id: { type: 'string' },
        expected_revision: { type: 'integer' },
        decisions: { type: 'object', additionalProperties: { type: 'string' } },
      },
      required: ['source_entity_id', 'target_entity_id', 'expected_revision'],
      additionalProperties: false,
    },
  },
  {
    name: 'find_entities',
    description:
      'Find entities matching a query by exact name, alias, or fuzzy similarity. Returns candidate matches with confidence scores.',
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
    description:
      'Find an unambiguous existing entity or create a new one. Never creates near-duplicates automatically.',
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
    name: 'delete_entity',
    description:
      'Delete an entity and all of its details (fields, aliases, tasks, drafts, entity notes) after the member confirms. Find the entity first with find_entities; the member is asked to confirm before anything is removed, and the confirmed answer resumes the deletion automatically.',
    parameters: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'ID of the existing entity to delete.' },
        reason: {
          type: 'string',
          description: 'Optional short reason recorded with the deletion (e.g. fake test data).',
        },
      },
      required: ['entity_id'],
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
        payload: {
          type: 'object',
          description:
            'Typed payload matching kind. Note: { text }. Visit: { summary, contact_made, location? }. Contact: { summary, channel: phone|email|in_person|telegram|whatsapp|other }. Quote: { amount (integer minor units >= 0), currency (3-letter ISO), role: offered|expected, description? }.',
        },
        occurred_at: { type: 'string', description: 'ISO timestamp of occurrence.' },
        provenance: { type: 'string', enum: ['stated', 'inferred'] },
      },
      required: ['kind', 'payload'],
      additionalProperties: false,
    },
  },
  {
    name: 'revise_interaction',
    description:
      'Correct one logged note, visit, contact, or quote identified by its interaction event ID. Applies only when the entry is still current: expected_head_event_id must be the exact current head, otherwise the call conflicts instead of overwriting a teammate edit. The kind never changes and a revision keeps the same entity; omit occurred_at to keep the original date.',
    parameters: {
      type: 'object',
      properties: {
        interaction_id: {
          type: 'string',
          description: 'Original interaction event ID (the stable root).',
        },
        expected_head_event_id: {
          type: 'string',
          description: 'Exact current head event ID; stale values conflict.',
        },
        kind: { type: 'string', enum: ['note', 'visit', 'contact', 'quote'] },
        payload: {
          type: 'object',
          description:
            'Replacement payload matching kind, validated exactly like new logging. Note: { text }. Visit: { summary, contact_made, location? }. Contact: { summary, channel }. Quote: { amount (integer minor units >= 0), currency (3-letter ISO), role: offered|expected }.',
        },
        occurred_at: {
          type: 'string',
          description: 'New ISO occurrence timestamp. Omit to keep the original date.',
        },
      },
      required: ['interaction_id', 'expected_head_event_id', 'kind', 'payload'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_interaction',
    description:
      'Remove one logged note, visit, contact, or quote from current use. The original report and history are retained and Undo restores the entry. Applies only when the entry is still current: expected_head_event_id must be the exact current head.',
    parameters: {
      type: 'object',
      properties: {
        interaction_id: {
          type: 'string',
          description: 'Original interaction event ID (the stable root).',
        },
        expected_head_event_id: {
          type: 'string',
          description: 'Exact current head event ID; stale values conflict.',
        },
        reason: {
          type: 'string',
          description: 'Optional short reason recorded with the removal (e.g. duplicate entry).',
        },
      },
      required: ['interaction_id', 'expected_head_event_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_fields',
    description:
      'Update core entity fields (status, phone, preferred_language, assigned_user_id, quote, company, address). Quote amounts must be integer minor units. Use change_contact for additional phones/emails.',
    parameters: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Target entity ID.' },
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field_name: {
                type: 'string',
                enum: [...CORE_FIELD_ALLOWLIST],
              },
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
    description:
      'Resolve a disputed field by choosing a verified value from competing candidate events.',
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
    description:
      'Create an actionable task. Requires either a validated due date/instant or explicit_no_deadline=true.',
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
    description:
      'Update task title, status (open/done/cancelled), due date, or snooze (null clears the snooze).',
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
        snooze_until: {
          type: 'string',
          description: 'Offset-bearing ISO instant to snooze until, or null to clear the snooze.',
        },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'draft_message',
    description:
      'Record an outward draft message (whatsapp, email, sms, other) upon explicit request.',
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
    name: 'edit_records',
    description:
      'Edit Your information table cells, rows, columns, and lists through the shared record operations: cell.set, cell.clear, item.edit, item.remove, row.create, row.remove, row.restore, field.create, field.update, field.archive, field.restore, list.create, list.update, list.archive, list.restore, calculation.define. Every op needs a unique op_id; edits carry the base_token shown with the value. On a saved target the batch commits atomically; on a draft target it stages a patch the member still saves. Discover lists, columns, and bindings with query records first.',
    parameters: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'Records list carrying the edits.' },
        operations: {
          type: 'array',
          items: { type: 'object' },
          description: 'Record edits with unique op_ids and base preconditions.',
        },
      },
      required: ['list_id', 'operations'],
      additionalProperties: false,
    },
  },
  {
    name: 'query',
    description:
      'Query scoped business records. entity_file returns the complete client-file overview with facts, contacts, work, quotes, notes, files, attribution and honest section coverage. members returns the workspace team roster, their names, emails, roles, and user IDs. duplicates scans for similar entity pairs to compare or merge. search performs a unified search across clients, notes, quotes, tasks, files, and conversation history. merge_preview compares entity_id and target_entity_id before an explicitly requested combination. interactions is current editable entries with root/head IDs; events is immutable history. lead_overview gives full filtered counts and paged next steps. records reads an information list page with columns, stable row refs, typed values, versions, and bindings: discover lists and columns there before edit_records. documents lists generated documents in the chat or workspace with their revision state, title, and PDF render status.',
    parameters: {
      type: 'object',
      properties: {
        resource: {
          type: 'string',
          enum: [
            'entities',
            'tasks',
            'events',
            'interactions',
            'drafts',
            'attachments',
            'lead_overview',
            'entity_file',
            'merge_preview',
            'followups',
            'members',
            'duplicates',
            'search',
            'records',
            'documents',
          ],
        },
        section: {
          type: 'string',
          enum: [...ENTITY_FILE_SECTIONS],
          description: 'entity_file only: load another page of just this section.',
        },
        order: { type: 'string', enum: ['occurred', 'recorded', 'overdue_first'] },
        filters: {
          type: 'object',
          properties: {
            interaction_id: {
              type: 'string',
              description: 'Stable original entry ID (interactions only).',
            },
            entity_id: { type: 'string' },
            target_entity_id: { type: 'string' },
            author_user_id: { type: 'string' },
            include_removed: {
              type: 'boolean',
              description:
                'Include removed file links in entity_file attachments, for retention release or history.',
            },
            from: { type: 'string', description: 'Inclusive zoned occurrence timestamp.' },
            to: { type: 'string', description: 'Exclusive zoned occurrence timestamp.' },
            entity_status: { type: 'string' },
            task_status: { type: 'string' },
            event_kind: { type: 'string' },
            assignee_user_id: { type: 'string' },
            due_before: { type: 'string' },
            due_after: { type: 'string' },
            kind: { type: 'string' },
            text: { type: 'string' },
            status: { type: 'string' },
            overdue_only: { type: 'boolean' },
            without_next_step: { type: 'boolean' },
            columns: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['status', 'next_step', 'due', 'owner', 'last_contact'],
              },
            },
            chat_id: { type: 'string', description: 'Chat ID filter (documents resource only).' },
            document_id: { type: 'string', description: 'Document ID filter (documents resource only).' },
          },
          additionalProperties: false,
        },
        entity_id: {
          type: 'string',
          description:
            'Entity ID (for entity_file, merge_preview, or interactions). Can also be supplied inside filters.',
        },
        target_entity_id: {
          type: 'string',
          description:
            'Target entity ID for merge_preview. Can also be supplied inside filters.',
        },
        text: {
          type: 'string',
          description: 'Search query text (search resource only). Can also be supplied inside filters.',
        },
        limit: { type: 'integer' },
        cursor: { type: 'string' },
      },
      required: ['resource'],
      additionalProperties: false,
    },
  },
  {
    name: 'view_image',
    description:
      'Load a retained conversation image into this turn’s visual context by media ID (from query attachments). The image appears alongside the result; never ask the user for internal IDs.',
    parameters: {
      type: 'object',
      properties: {
        media_id: { type: 'string' },
        detail: { type: 'string', enum: ['standard', 'original'] },
      },
      required: ['media_id'],
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
    name: 'read_chat_history',
    description:
      'Read older chat messages beyond the current turn window. Defaults to the current chat; page backwards with before_sequence.',
    parameters: {
      type: 'object',
      properties: {
        chat_id: {
          type: 'string',
          description: 'Chat to read; defaults to the current chat. Must belong to the workspace.',
        },
        before_sequence: {
          type: 'integer',
          description: 'Return messages below this sequence number.',
        },
        limit: { type: 'integer', description: 'Rows per page, 1-50. Defaults to 20.' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'create_reminder',
    description:
      'Set a one-off reminder delivered once at the given instant over the chosen channel.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Reminder text, up to 500 characters.' },
        at: {
          type: 'string',
          description: 'Offset-bearing ISO instant to fire at. Must lie in the future.',
        },
        timezone: { type: 'string', description: 'IANA display zone for the confirmation copy.' },
        channel: {
          type: 'string',
          enum: ['web', 'telegram'],
          description: 'Delivery channel. Defaults to web.',
        },
      },
      required: ['text', 'at'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_reminder',
    description: 'Change a pending reminder before it fires.',
    parameters: {
      type: 'object',
      properties: {
        reminder_id: { type: 'string' },
        text: { type: 'string' },
        at: {
          type: 'string',
          description: 'Offset-bearing ISO instant to fire at. Must lie in the future.',
        },
        timezone: { type: 'string', description: 'IANA display zone for the confirmation copy.' },
        channel: { type: 'string', enum: ['web', 'telegram'] },
      },
      required: ['reminder_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'cancel_reminder',
    description: 'Cancel a pending reminder so it never fires.',
    parameters: {
      type: 'object',
      properties: {
        reminder_id: { type: 'string' },
      },
      required: ['reminder_id'],
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
        category: {
          type: 'string',
          enum: [
            'communication_preference',
            'relationship_context',
            'workflow_context',
            'other_context',
          ],
        },
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
          description:
            "Thinking effort level ('minimal', 'low', 'medium', 'high', 'xhigh', 'max', or 'default'; 'max' only applies to DeepSeek, 'minimal' only to Muse Spark)",
        },
      },
      required: ['level'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_chat_model',
    description:
      'Switch the active conversation model for this chat (e.g. "gemini-3.5-flash-lite", "deepseek-v4.1-flash", "mimo-v2.5", "default"). Use when the user asks to switch or change the model.',
    parameters: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          description:
            'The model key, name, or alias to switch to (e.g. "gemini 3.5", "deepseek", "mimo 2.5", "default").',
        },
      },
      required: ['model'],
      additionalProperties: false,
    },
  },
  {
    name: 'execute_command',
    description:
      'Execute a slash command on behalf of the user (e.g. "/model gemini 3.5", "/thinking minimal", "/undo", "/today").',
    parameters: {
      type: 'object',
      properties: {
        command_text: {
          type: 'string',
          description: 'The full slash command text including slash and arguments.',
        },
      },
      required: ['command_text'],
      additionalProperties: false,
    },
  },
  {
    name: 'undo',
    description:
      'Revert recent actions in the current chat. from_here is the default grouped mode.',
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
    description:
      'Ask the user a concise question before executing an action when required details are ambiguous or missing.',
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
  {
    name: 'document_start',
    description:
      'Start a new generated document draft or a new revision of an existing document. Specify the title and intended sections. For a revision, pass document_id and optionally base_revision_id.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The title of the document.' },
        intended_sections: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of planned section titles or topics.',
        },
        document_id: {
          type: 'string',
          description: 'Optional ID of an existing document to create a new revision for.',
        },
        base_revision_id: {
          type: 'string',
          description: 'Optional base revision ID to branch from.',
        },
      },
      required: ['title', 'intended_sections'],
      additionalProperties: false,
    },
  },
  {
    name: 'document_write_section',
    description:
      'Write or update one or more sections of a document draft. Each section has an id, title, and rich markdown content.',
    parameters: {
      type: 'object',
      properties: {
        document_id: { type: 'string', description: 'The ID of the document being drafted.' },
        revision_id: { type: 'string', description: 'The ID of the draft revision.' },
        sections: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: "Section slug or identifier, e.g. 'sec-intro'." },
              title: { type: 'string', description: 'Section heading title.' },
              content_markdown: { type: 'string', description: 'Markdown content for this section.' },
            },
            required: ['id', 'title', 'content_markdown'],
            additionalProperties: false,
          },
          description: 'Sections to save in this round (up to 16).',
        },
      },
      required: ['document_id', 'revision_id', 'sections'],
      additionalProperties: false,
    },
  },
  {
    name: 'document_publish',
    description:
      'Finalize and publish a document draft revision, assembling sections into a complete markdown document and queuing background PDF rendering.',
    parameters: {
      type: 'object',
      properties: {
        document_id: { type: 'string', description: 'The ID of the document to publish.' },
        revision_id: { type: 'string', description: 'The draft revision ID to publish.' },
        render_pdf: {
          type: 'boolean',
          description: 'Whether to generate a printable PDF artifact (defaults to true).',
        },
      },
      required: ['document_id', 'revision_id'],
      additionalProperties: false,
    },
  },
];
