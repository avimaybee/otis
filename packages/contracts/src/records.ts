/**
 * @otis/contracts/records
 * Authoritative contracts, DTOs, and operation unions for "Your information"
 * (editable records).
 * In accordance with plans/editable-records.md Sections 4, 8, and 9.
 */

export type RecordKind = 'entity' | 'task' | 'interaction' | 'draft' | 'memory' | 'custom';

export interface RecordRef {
  kind: RecordKind;
  id: string;
}

export type RecordValue =
  | string
  | number
  | boolean
  | null
  | { amount: number; currency: string; role?: string }
  | { local_date: string }
  | { instant: string }
  | { kind: 'date'; local_date: string; timezone: string }
  | { kind: 'instant'; at: string; timezone: string };

export type CellState = 'clear' | 'unknown' | 'disputed';

export type CellBinding =
  | { kind: 'entity_property'; property: 'name' | 'kind' | 'status' | 'assigned_user_id' }
  | { kind: 'entity_field'; field_id: string; field_name: string }
  | { kind: 'entity_contact'; method: 'phone' | 'email'; contact_id?: string }
  | { kind: 'interaction'; property: 'latest_note' | 'latest_quote' | 'latest_visit' | 'latest_contact'; root_event_id?: string; head_event_id?: string }
  | { kind: 'task_property'; task_id?: string; property: 'title' | 'due' | 'status' | 'assignee_user_id' }
  | { kind: 'draft_property'; draft_id?: string; property: 'content_text' | 'channel' | 'recipient_address' }
  | { kind: 'custom_row_value'; column_id: string };

export interface RecordSource {
  event_id?: string;
  message_id?: string;
  actor_user_id?: string | null;
  occurred_at?: string;
  recorded_at?: string;
  provenance?: 'stated' | 'inferred';
}

export interface RecordCandidate {
  event_id: string;
  value: RecordValue;
  occurred_at: string;
  recorded_at: string;
  provenance: 'stated' | 'inferred';
}

export interface RecordCell {
  value: RecordValue;
  state: CellState;
  version: string;
  binding: CellBinding;
  editable: boolean;
  source?: RecordSource;
  candidates?: RecordCandidate[];
}

export type ColumnType =
  | 'text'
  | 'status'
  | 'number'
  | 'currency'
  | 'date'
  | 'phone'
  | 'email'
  | 'boolean'
  | 'choice'
  | 'calculation';

export interface CalculationNodeLiteral {
  type: 'literal';
  value: number;
}

export interface CalculationNodeRef {
  type: 'ref';
  column_id: string;
}

export interface CalculationNodeOp {
  type: 'op';
  op: '+' | '-' | '*' | '/';
  left: CalculationNode;
  right: CalculationNode;
}

export type CalculationNode = CalculationNodeLiteral | CalculationNodeRef | CalculationNodeOp;

export interface CalculationTree {
  output_type: 'number' | 'currency';
  expression: CalculationNode;
}

export interface ColumnOptions {
  choices?: string[];
  currency?: string;
  format?: string;
  calculation_rule?: CalculationTree;
}

export interface RecordColumn {
  id: string;
  name: string;
  type: ColumnType;
  width?: number;
  is_core?: boolean;
  isCore?: boolean;
  options?: string[];
  binding?: CellBinding;
  calculation?: {
    expression: string;
    description: string;
    targetType?: 'number' | 'currency';
  };
  capabilities?: {
    sortable?: boolean;
    filterable?: boolean;
    editable?: boolean;
  };
}

export interface RecordRow {
  id: string;
  ref?: RecordRef;
  lifecycle_token?: string;
  cells: Record<string, string>;
  record_cells?: Record<string, RecordCell>;
  source?: string;
  updatedAt?: string;
  provenance?: Record<string, string>;
}

export interface RecordList {
  id: string;
  name: string;
  source_kind?: 'entity' | 'custom' | 'task' | 'interaction' | 'draft';
  description?: string;
  columns: RecordColumn[];
  rows: RecordRow[];
  total_rows?: number;
  next_cursor?: string | null;
}

export interface RecordHistoryItem {
  id: string;
  timestamp: string;
  actor: 'user' | 'otis';
  description: string;
  affected_count?: number;
  affectedCount?: number;
  can_restore?: boolean;
  canRestore?: boolean;
}

export interface RecordsResponse {
  lists: RecordList[];
  history: Record<string, RecordHistoryItem[]>;
  selected_list_id?: string;
  revision?: number;
}

export type RecordEdit =
  | { op: 'cell.set'; op_id: string; row_ref: RecordRef; column_id: string; base_token?: string; value: RecordValue }
  | { op: 'cell.clear'; op_id: string; row_ref: RecordRef; column_id: string; base_token?: string }
  | { op: 'item.edit'; op_id: string; source_ref: RecordRef; base_token?: string; payload: Record<string, unknown>; origin?: { row_ref: RecordRef; column_id: string } }
  | { op: 'item.remove'; op_id: string; source_ref: RecordRef; base_token?: string; origin?: { row_ref: RecordRef; column_id: string } }
  | { op: 'row.create'; op_id: string; row_ref: RecordRef; list_id: string; initial_values?: Record<string, RecordValue> }
  | { op: 'row.remove'; op_id: string; row_ref: RecordRef; base_token?: string }
  | { op: 'row.restore'; op_id: string; row_ref: RecordRef; base_token?: string }
  | { op: 'field.create'; op_id: string; field_id: string; list_id?: string; label: string; type: ColumnType; options?: ColumnOptions }
  | { op: 'field.update'; op_id: string; field_id: string; base_token?: string; label?: string; type?: ColumnType; options?: ColumnOptions }
  | { op: 'field.archive'; op_id: string; field_id: string; base_token?: string }
  | { op: 'field.restore'; op_id: string; field_id: string; base_token?: string }
  | { op: 'list.create'; op_id: string; list_id: string; name: string; source_kind: 'entity' | 'custom' | 'task' | 'interaction' | 'draft' }
  | { op: 'list.update'; op_id: string; list_id: string; base_token?: string; name?: string }
  | { op: 'list.archive'; op_id: string; list_id: string; base_token?: string }
  | { op: 'list.restore'; op_id: string; list_id: string; base_token?: string }
  | { op: 'calculation.define'; op_id: string; field_id: string; base_token?: string; expression_tree: CalculationTree; description: string };

export interface RecordsSaveRequest {
  schema_version: 1;
  save_id: string;
  action_id: string;
  chunk_index: number;
  chunk_count: number;
  list_id: string;
  operations: RecordEdit[];
}

export interface RecordsSaveResponse {
  status: 'applied' | 'already_applied' | 'conflict' | 'rejected';
  save_id: string;
  action_id: string;
  affected_count: number;
  affectedCount?: number;
  saved?: boolean;
  committed_revision?: number;
  id_mappings?: Record<string, string>;
  affected_values?: Array<{ row_ref: RecordRef; column_id: string; value: RecordValue; version: string }>;
  conflicts?: Array<{ op_id: string; message: string; current_value?: RecordValue; submitted_value?: RecordValue }>;
  errors?: Array<{ op_id: string; code: string; message: string }>;
}

export interface RecordsViewQuery {
  list_id?: string;
  search?: string;
  filter?: Record<string, unknown>;
  sort?: { column_id: string; direction: 'asc' | 'desc' };
  columns?: string[];
  cursor?: string | null;
  limit?: number;
}

export interface RecordsContext {
  list_id: string;
  target: { mode: 'saved' } | { mode: 'draft'; draft_id: string; generation: number };
  selected_rows: RecordRef[];
  selected_columns: string[];
  visible_row_order: RecordRef[];
  query: RecordsViewQuery;
  draft_delta?: RecordEdit[];
  context_id?: string;
}

/**
 * A durable assistant proposal for table edits: persisted in the logical
 * step result before it is announced, applied once by patch id, and never a
 * business action receipt. Proposing is not saving; the member reviews and
 * still clicks Save.
 */
export interface RecordsPatch {
  patch_id: string;
  draft: { mode: 'saved' } | { mode: 'draft'; draft_id: string; generation: number };
  list_id: string;
  operations: RecordEdit[];
  op_count: number;
  save_required: boolean;
}

export interface PersistedRecordsList {
  workspace_id: string;
  id: string;
  name: string;
  source_kind: 'entity' | 'custom' | 'task' | 'interaction' | 'draft';
  status: 'active' | 'archived';
  revision: number;
  source_event_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface PersistedRecordsListColumn {
  workspace_id: string;
  id: string;
  list_id: string;
  field_id: string | null;
  is_core: boolean;
  core_binding_json: string | null;
  position: number;
  visible: boolean;
  width: number | null;
  revision: number;
  source_event_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface PersistedRecordsRow {
  workspace_id: string;
  id: string;
  list_id: string;
  status: 'active' | 'archived';
  revision: number;
  source_event_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface PersistedRecordsValue {
  workspace_id: string;
  row_id: string;
  column_id: string;
  value_json: string | null;
  value_text: string | null;
  revision: number;
  source_event_id: string | null;
  updated_at: string;
}

export interface PersistedFieldDef {
  workspace_id: string;
  id: string;
  field_name: string;
  display_label: string;
  value_type: 'string' | 'number' | 'boolean' | 'enum' | 'date' | 'currency';
  options_json?: string | null;
  calculation_json?: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Storage type for a workspace field definition, matching the field_defs
 * value_type CHECK. Display types phone/email share string storage (their
 * UI type rides in options_json); calculations are rules on stored types,
 * never a storage type of their own.
 */
export function fieldStorageType(type: ColumnType): PersistedFieldDef['value_type'] | null {
  switch (type) {
    case 'text':
    case 'phone':
    case 'email':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'choice':
    case 'status':
      return 'enum';
    case 'date':
      return 'date';
    case 'currency':
      return 'currency';
    default:
      return null;
  }
}

/** UI type for a stored definition: explicit phone/email markers survive storage. */
export function fieldDisplayType(def: { value_type: string; options_json?: string | null }): ColumnType {
  if (def.options_json) {
    try {
      const options = JSON.parse(def.options_json) as { ui_type?: string };
      if (options.ui_type === 'phone' || options.ui_type === 'email') return options.ui_type;
    } catch {
      // Fall through to storage mapping.
    }
  }
  switch (def.value_type) {
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'enum': return 'choice';
    case 'date': return 'date';
    case 'currency': return 'currency';
    default: return 'text';
  }
}

/**
 * Built-in lists every workspace owns. The 0030 migration seeds these for
 * workspaces that already exist; workspace creation and the records reader
 * ensure them for workspaces born later. IDs are stable and deep-linkable.
 */
export const BUILT_IN_RECORDS_LISTS: ReadonlyArray<{
  id: string;
  name: string;
  source_kind: PersistedRecordsList['source_kind'];
}> = [
  { id: 'leads', name: 'Leads', source_kind: 'entity' },
  { id: 'tasks', name: 'Tasks', source_kind: 'task' },
  { id: 'notes', name: 'Notes & interactions', source_kind: 'interaction' },
  { id: 'drafts', name: 'Drafts', source_kind: 'draft' },
];

export type RecordsValidation =
  | { valid: true }
  | { valid: false; code: string; message: string; op_id?: string };

const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const RECORD_KINDS: ReadonlySet<string> = new Set(['entity', 'task', 'interaction', 'draft', 'memory', 'custom']);
const RECORD_SOURCE_KINDS: ReadonlySet<string> = new Set(['entity', 'custom', 'task', 'interaction', 'draft']);
const RECORD_COLUMN_TYPES: ReadonlySet<string> = new Set([
  'text', 'status', 'number', 'currency', 'date', 'phone', 'email', 'boolean', 'choice', 'calculation',
]);

function invalidRecord(message: string, code = 'validation_error', op_id?: string): RecordsValidation {
  return { valid: false, code, message, op_id };
}

function checkRecordId(value: unknown, field: string, op_id?: string): RecordsValidation | null {
  if (typeof value !== 'string' || !RECORD_ID_PATTERN.test(value)) {
    return invalidRecord(`Invalid ${field}: must be 1–128 [A-Za-z0-9_-] characters.`, 'validation_error', op_id);
  }
  return null;
}

function checkBaseToken(value: unknown, op_id?: string): RecordsValidation | null {
  if (value !== undefined && (typeof value !== 'string' || !value || value.length > 512)) {
    return invalidRecord('Invalid base_token: must be a non-empty string when present.', 'validation_error', op_id);
  }
  return null;
}

/** Validate a semantic cell value: finite numbers, known object shapes, no NaN/Infinity. */
export function validateRecordValue(value: unknown): RecordsValidation {
  if (value === null) return { valid: true };
  if (typeof value === 'string') {
    return value.length <= 20000
      ? { valid: true }
      : invalidRecord('Text value exceeds 20,000 characters.');
  }
  if (typeof value === 'boolean') return { valid: true };
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? { valid: true }
      : invalidRecord('Numeric value must be finite.');
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return invalidRecord('Value must be text, a finite number, boolean, null, or a currency/date/instant object.');
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  const rest = keys.filter((k) => k !== 'role');
  if (rest.length === 2 && 'amount' in obj && 'currency' in obj) {
    if (!Number.isSafeInteger(obj['amount']) || (obj['amount'] as number) < 0) {
      return invalidRecord('Currency amount must be non-negative integer minor units.');
    }
    if (typeof obj['currency'] !== 'string' || !/^[A-Za-z]{3}$/.test(obj['currency'].trim())) {
      return invalidRecord('Currency must be a 3-letter code.');
    }
    if ('role' in obj && obj['role'] !== 'offered' && obj['role'] !== 'expected') {
      return invalidRecord('Currency role must be offered or expected when present.');
    }
    return { valid: true };
  }
  if (keys.length === 1 && 'local_date' in obj) {
    if (typeof obj['local_date'] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(obj['local_date'])) {
      return invalidRecord('local_date must be YYYY-MM-DD.');
    }
    return { valid: true };
  }
  if (keys.length === 1 && 'instant' in obj) {
    if (typeof obj['instant'] !== 'string' || !Number.isFinite(Date.parse(obj['instant']))) {
      return invalidRecord('instant must be a parseable timestamp.');
    }
    return { valid: true };
  }
  if ('kind' in obj && (obj['kind'] === 'date' || obj['kind'] === 'instant')) {
    if (obj['kind'] === 'date') {
      if (typeof obj['local_date'] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(obj['local_date']) ||
        typeof obj['timezone'] !== 'string' || !obj['timezone']) {
        return invalidRecord('Task due date needs local_date YYYY-MM-DD and timezone.');
      }
      return { valid: true };
    }
    if (typeof obj['at'] !== 'string' || !Number.isFinite(Date.parse(obj['at'])) ||
      typeof obj['timezone'] !== 'string' || !obj['timezone']) {
      return invalidRecord('Task due instant needs at timestamp and timezone.');
    }
    return { valid: true };
  }
  return invalidRecord('Value object must be currency {amount, currency}, {local_date}, {instant}, or a task due.');
}

function checkRecordRef(value: unknown, field: string, op_id?: string): RecordsValidation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalidRecord(`Invalid ${field}: must be {kind, id}.`, 'validation_error', op_id);
  }
  const ref = value as { kind?: unknown; id?: unknown };
  if (typeof ref.kind !== 'string' || !RECORD_KINDS.has(ref.kind)) {
    return invalidRecord(`Invalid ${field}.kind: must be entity, task, interaction, draft, memory or custom.`, 'validation_error', op_id);
  }
  return checkRecordId(ref.id, `${field}.id`, op_id);
}

/** Validate one save operation: names, refs, ids, value shapes. Workspace ownership is checked server-side. */
export function validateRecordEdit(op: unknown): RecordsValidation {
  if (!op || typeof op !== 'object' || Array.isArray(op)) {
    return invalidRecord('Operation must be an object with op and op_id.');
  }
  const edit = op as Record<string, unknown>;
  if (typeof edit['op'] !== 'string') return invalidRecord('Operation is missing its op name.');
  const opId = edit['op_id'];
  const idProblem = checkRecordId(opId, 'op_id');
  if (idProblem) return idProblem;
  const oid = String(opId);
  const baseProblem = checkBaseToken(edit['base_token'], oid);
  if (baseProblem) return baseProblem;

  switch (edit['op']) {
    case 'cell.set': {
      const refProblem = checkRecordRef(edit['row_ref'], 'row_ref', oid);
      if (refProblem) return refProblem;
      const colProblem = checkRecordId(edit['column_id'], 'column_id', oid);
      if (colProblem) return colProblem;
      if (!('value' in edit)) return invalidRecord('cell.set requires a value (use cell.clear to remove).', 'validation_error', oid);
      const valueCheck = validateRecordValue(edit['value']);
      if (!valueCheck.valid) return { ...valueCheck, op_id: oid };
      return { valid: true };
    }
    case 'cell.clear': {
      const refProblem = checkRecordRef(edit['row_ref'], 'row_ref', oid);
      if (refProblem) return refProblem;
      const colProblem = checkRecordId(edit['column_id'], 'column_id', oid);
      if (colProblem) return colProblem;
      return { valid: true };
    }
    case 'item.edit':
    case 'item.remove': {
      const refProblem = checkRecordRef(edit['source_ref'], 'source_ref', oid);
      if (refProblem) return refProblem;
      if (edit['op'] === 'item.edit') {
        const payload = edit['payload'];
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          return invalidRecord('item.edit requires a payload object with typed changes.', 'validation_error', oid);
        }
      }
      if (edit['origin'] !== undefined) {
        const origin = edit['origin'] as Record<string, unknown>;
        const refProblem2 = checkRecordRef(origin['row_ref'], 'origin.row_ref', oid);
        if (refProblem2) return refProblem2;
        const colProblem = checkRecordId(origin['column_id'], 'origin.column_id', oid);
        if (colProblem) return colProblem;
      }
      return { valid: true };
    }
    case 'row.create': {
      const refProblem = checkRecordRef(edit['row_ref'], 'row_ref', oid);
      if (refProblem) return refProblem;
      const listProblem = checkRecordId(edit['list_id'], 'list_id', oid);
      if (listProblem) return listProblem;
      if (edit['initial_values'] !== undefined) {
        const values = edit['initial_values'];
        if (!values || typeof values !== 'object' || Array.isArray(values)) {
          return invalidRecord('initial_values must be an object of column values.', 'validation_error', oid);
        }
        for (const [key, val] of Object.entries(values)) {
          const keyProblem = checkRecordId(key, `initial_values key '${key}'`, oid);
          if (keyProblem) return keyProblem;
          const valueCheck = validateRecordValue(val);
          if (!valueCheck.valid) return { ...valueCheck, op_id: oid };
        }
      }
      return { valid: true };
    }
    case 'row.remove':
    case 'row.restore': {
      const refProblem = checkRecordRef(edit['row_ref'], 'row_ref', oid);
      if (refProblem) return refProblem;
      return { valid: true };
    }
    case 'field.create': {
      const fieldProblem = checkRecordId(edit['field_id'], 'field_id', oid);
      if (fieldProblem) return fieldProblem;
      if (typeof edit['label'] !== 'string' || !edit['label'].trim() || edit['label'].length > 200) {
        return invalidRecord('field.create requires a label of 1–200 characters.', 'validation_error', oid);
      }
      if (typeof edit['type'] !== 'string' || !RECORD_COLUMN_TYPES.has(edit['type']) || edit['type'] === 'calculation') {
        return invalidRecord('field.create needs a stored type (text, number, currency, date, phone, email, boolean, choice, or status). Calculations attach to a stored field separately.', 'validation_error', oid);
      }
      if (edit['list_id'] !== undefined) {
        const listProblem = checkRecordId(edit['list_id'], 'list_id', oid);
        if (listProblem) return listProblem;
      }
      return { valid: true };
    }
    case 'field.update': {
      const fieldProblem = checkRecordId(edit['field_id'], 'field_id', oid);
      if (fieldProblem) return fieldProblem;
      if (edit['label'] !== undefined && (typeof edit['label'] !== 'string' || !edit['label'].trim() || edit['label'].length > 200)) {
        return invalidRecord('field label must be 1–200 characters.', 'validation_error', oid);
      }
      if (edit['type'] !== undefined && (typeof edit['type'] !== 'string' || !RECORD_COLUMN_TYPES.has(edit['type']) || edit['type'] === 'calculation')) {
        return invalidRecord('field type must be a stored column type, not a calculation.', 'validation_error', oid);
      }
      return { valid: true };
    }
    case 'field.archive':
    case 'field.restore': {
      const fieldProblem = checkRecordId(edit['field_id'], 'field_id', oid);
      if (fieldProblem) return fieldProblem;
      return { valid: true };
    }
    case 'list.create': {
      const listProblem = checkRecordId(edit['list_id'], 'list_id', oid);
      if (listProblem) return listProblem;
      if (typeof edit['name'] !== 'string' || !edit['name'].trim() || edit['name'].length > 200) {
        return invalidRecord('list.create requires a name of 1–200 characters.', 'validation_error', oid);
      }
      if (typeof edit['source_kind'] !== 'string' || !RECORD_SOURCE_KINDS.has(edit['source_kind'])) {
        return invalidRecord('list source_kind must be entity, custom, task, interaction or draft.', 'validation_error', oid);
      }
      return { valid: true };
    }
    case 'list.update':
    case 'list.archive':
    case 'list.restore': {
      const listProblem = checkRecordId(edit['list_id'], 'list_id', oid);
      if (listProblem) return listProblem;
      if (edit['op'] === 'list.update' && edit['name'] !== undefined &&
        (typeof edit['name'] !== 'string' || !edit['name'].trim() || edit['name'].length > 200)) {
        return invalidRecord('list name must be 1–200 characters.', 'validation_error', oid);
      }
      return { valid: true };
    }
    case 'calculation.define': {
      const fieldProblem = checkRecordId(edit['field_id'], 'field_id', oid);
      if (fieldProblem) return fieldProblem;
      if (typeof edit['description'] !== 'string' || !edit['description'].trim() || edit['description'].length > 2000) {
        return invalidRecord('calculation.define requires a plain-language description.', 'validation_error', oid);
      }
      const treeProblem = validateCalculationTree(edit['expression_tree'], oid);
      if (treeProblem) return treeProblem;
      return { valid: true };
    }
    default:
      return invalidRecord(`Unsupported operation '${edit['op']}'.`, 'unsupported_operation', oid);
  }
}

function validateCalculationTree(tree: unknown, op_id: string, depth = 0): RecordsValidation | null {
  if (depth > 16) return invalidRecord('Calculation exceeds maximum depth of 16.', 'validation_error', op_id);
  if (!tree || typeof tree !== 'object' || Array.isArray(tree)) {
    return invalidRecord('calculation.define requires an expression_tree with output_type and expression.', 'validation_error', op_id);
  }
  const node = tree as Record<string, unknown>;
  if (node['output_type'] !== 'number' && node['output_type'] !== 'currency') {
    return invalidRecord('Calculation output_type must be number or currency.', 'validation_error', op_id);
  }
  return validateCalculationNode(node['expression'], op_id, depth);
}

function validateCalculationNode(node: unknown, op_id: string, depth: number): RecordsValidation | null {
  if (depth > 16) return invalidRecord('Calculation exceeds maximum depth of 16.', 'validation_error', op_id);
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return invalidRecord('Calculation node must be a literal, ref, or op object.', 'validation_error', op_id);
  }
  const n = node as Record<string, unknown>;
  if (n['type'] === 'literal') {
    if (typeof n['value'] !== 'number' || !Number.isFinite(n['value'])) {
      return invalidRecord('Calculation literal must be a finite number.', 'validation_error', op_id);
    }
    return null;
  }
  if (n['type'] === 'ref') {
    return checkRecordId(n['column_id'], 'calculation ref column_id', op_id);
  }
  if (n['type'] === 'op') {
    if (n['op'] !== '+' && n['op'] !== '-' && n['op'] !== '*' && n['op'] !== '/') {
      return invalidRecord('Calculation op must be +, -, * or /.', 'validation_error', op_id);
    }
    return validateCalculationNode(n['left'], op_id, depth + 1) ?? validateCalculationNode(n['right'], op_id, depth + 1);
  }
  return invalidRecord('Calculation node type must be literal, ref, or op.', 'validation_error', op_id);
}

/** Validate a whole save request envelope: schema, save/action/list ids, bounded operations. */
export function validateRecordsSaveRequest(body: unknown): RecordsValidation {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return invalidRecord('Save request must be an object.');
  }
  const req = body as Record<string, unknown>;
  if (req['schema_version'] !== undefined && req['schema_version'] !== 1) {
    return invalidRecord('Unsupported schema_version: expected 1.');
  }
  const saveProblem = checkRecordIdPrefix(req['save_id'], 'save_id');
  if (saveProblem) return saveProblem;
  const actionProblem = checkRecordIdPrefix(req['action_id'], 'action_id');
  if (actionProblem) return actionProblem;
  const listProblem = checkRecordId(req['list_id'], 'list_id');
  if (listProblem) return listProblem;
  if (!Array.isArray(req['operations'])) {
    return invalidRecord('Save request requires an operations array.');
  }
  if (req['operations'].length > 100) {
    return invalidRecord('Records save chunk cannot exceed 100 operations.');
  }
  const seenOpIds = new Set<string>();
  for (const op of req['operations']) {
    const check = validateRecordEdit(op);
    if (!check.valid) return check;
    const opId = String((op as Record<string, unknown>)['op_id']);
    if (seenOpIds.has(opId)) {
      return invalidRecord(`Duplicate op_id '${opId}' in one save chunk.`, 'validation_error', opId);
    }
    seenOpIds.add(opId);
  }
  return { valid: true };
}

function checkRecordIdPrefix(value: unknown, field: string): RecordsValidation | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !value || value.length > 256) {
    return invalidRecord(`Invalid ${field}: must be a non-empty string when present.`);
  }
  return null;
}

export const RECORDS_CONTEXT_MAX_BYTES = 32 * 1024;
const RECORDS_CONTEXT_MAX_REFS = 200;

function checkRecordRefArray(value: unknown, field: string, op_id?: string): RecordsValidation | null {
  if (!Array.isArray(value)) return invalidRecord(`Invalid ${field}: must be an array of record refs.`, 'validation_error', op_id);
  if (value.length > RECORDS_CONTEXT_MAX_REFS) {
    return invalidRecord(`Invalid ${field}: at most ${RECORDS_CONTEXT_MAX_REFS} refs travel with a message.`, 'validation_error', op_id);
  }
  for (const item of value) {
    const problem = checkRecordRef(item, field, op_id);
    if (problem) return problem;
  }
  return null;
}

/**
 * Validate an assistant-bound records target: which list, which rows are in
 * play, and (for dirty pages) the exact accepted delta. Small deltas travel
 * inline; anything over RECORDS_CONTEXT_MAX_BYTES must narrow its selection
 * instead of uploading out of band. Large private artifacts stay a separate
 * explicit flow, never a silent side channel.
 */
export function validateRecordsContext(value: unknown): RecordsValidation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalidRecord('records_context must be an object.');
  }
  const context = value as Record<string, unknown>;
  const listProblem = checkRecordId(context['list_id'], 'list_id');
  if (listProblem) return listProblem;
  const target = context['target'];
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    return invalidRecord('records_context.target must be a saved or draft target.');
  }
  const mode = (target as Record<string, unknown>)['mode'];
  if (mode === 'draft') {
    const draftTarget = target as Record<string, unknown>;
    if (typeof draftTarget['draft_id'] !== 'string' || !draftTarget['draft_id']) {
      return invalidRecord('Draft targets need a draft_id.');
    }
    if (typeof draftTarget['generation'] !== 'number' || !Number.isInteger(draftTarget['generation']) || draftTarget['generation'] < 0) {
      return invalidRecord('Draft targets need an integer generation.');
    }
  } else if (mode !== 'saved') {
    return invalidRecord("records_context target mode must be 'saved' or 'draft'.");
  }
  for (const field of ['selected_rows', 'selected_columns', 'visible_row_order'] as const) {
    if (field === 'selected_columns') {
      const columns = context[field];
      if (!Array.isArray(columns)) return invalidRecord(`Invalid ${field}: must be an array of column ids.`);
      if (columns.length > RECORDS_CONTEXT_MAX_REFS) {
        return invalidRecord(`Invalid ${field}: at most ${RECORDS_CONTEXT_MAX_REFS} columns travel with a message.`);
      }
      for (const column of columns) {
        const problem = checkRecordId(column, `${field} entry`);
        if (problem) return problem;
      }
      continue;
    }
    const problem = checkRecordRefArray(context[field], field);
    if (problem) return problem;
  }
  const query = context['query'];
  if (query !== undefined && (typeof query !== 'object' || query === null || Array.isArray(query))) {
    return invalidRecord('records_context.query must be an object when present.');
  }
  const delta = context['draft_delta'];
  if (delta !== undefined) {
    if (!Array.isArray(delta)) return invalidRecord('records_context.draft_delta must be an operations array.');
    if (delta.length > 100) return invalidRecord('records_context.draft_delta cannot exceed 100 operations.');
    for (const op of delta) {
      const check = validateRecordEdit(op);
      if (!check.valid) return check;
    }
  }
  if (context['context_id'] !== undefined && typeof context['context_id'] !== 'string') {
    return invalidRecord('records_context.context_id must be a string when present.');
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return invalidRecord('records_context must be JSON-serializable.');
  }
  if (encoded.length > RECORDS_CONTEXT_MAX_BYTES) {
    return invalidRecord(
      `records_context is ${encoded.length} bytes over the ${RECORDS_CONTEXT_MAX_BYTES} inline limit. Narrow the selection instead.`,
    );
  }
  return { valid: true };
}

export type CalculationInput = number | { amount: number; currency: string } | null;

export type CalculationResult =
  | { ok: true; value: number; currency?: string }
  | { ok: false; error: string };

/** All definition ids referenced anywhere in a calculation tree, bounded. */
export function collectCalculationRefs(node: CalculationNode): string[] {
  const refs: string[] = [];
  const visit = (current: CalculationNode, depth: number): void => {
    if (depth > 16 || refs.length > 64) return;
    if (current.type === 'ref') {
      if (!refs.includes(current.column_id)) refs.push(current.column_id);
    } else if (current.type === 'op') {
      visit(current.left, depth + 1);
      visit(current.right, depth + 1);
    }
  };
  visit(node, 0);
  return refs;
}

/**
 * Shared deterministic evaluator for conversational calculation trees.
 * Worker and draft use this same function: no eval, no model JavaScript,
 * bounded depth/size, money-safe minor-unit rounding. Null, missing, and
 * disputed inputs are never zero: any non-numeric input fails the column
 * with a useful error instead of a fabricated total. Division by zero and
 * currency mismatches are errors, not guesses.
 */
export function evaluateCalculationTree(
  tree: CalculationTree,
  inputs: Record<string, CalculationInput>,
): CalculationResult {
  const MAX_NODES = 64;
  let nodes = 0;
  const evaluate = (node: CalculationNode): CalculationResult => {
    nodes += 1;
    if (nodes > MAX_NODES) return { ok: false, error: 'Calculation exceeds 64 nodes.' };
    if (node.type === 'literal') {
      if (!Number.isFinite(node.value)) return { ok: false, error: 'Calculation literal must be finite.' };
      return { ok: true, value: node.value };
    }
    if (node.type === 'ref') {
      const input = inputs[node.column_id];
      if (input === null || input === undefined) {
        return { ok: false, error: `Missing input '${node.column_id}'.` };
      }
      if (typeof input === 'number') {
        if (!Number.isFinite(input)) return { ok: false, error: `Input '${node.column_id}' is not finite.` };
        return { ok: true, value: input };
      }
      if (!Number.isSafeInteger(input.amount) || input.amount < 0) {
        return { ok: false, error: `Money input '${node.column_id}' must be non-negative minor units.` };
      }
      return { ok: true, value: input.amount, currency: input.currency };
    }
    const left = evaluate(node.left);
    if (!left.ok) return left;
    const right = evaluate(node.right);
    if (!right.ok) return right;
    if (left.currency && right.currency && left.currency !== right.currency) {
      return { ok: false, error: `Currency mismatch: ${left.currency} against ${right.currency}.` };
    }
    switch (node.op) {
      case '+': return { ok: true, value: left.value + right.value, currency: left.currency };
      case '-': return { ok: true, value: left.value - right.value, currency: left.currency };
      case '*': {
        const product = left.value * right.value;
        const currency = left.currency ?? right.currency;
        return { ok: true, value: currency ? Math.round(product) : product, currency };
      }
      case '/': {
        if (right.value === 0) return { ok: false, error: 'Division by zero.' };
        // Money over money is a unitless ratio; money over a count stays money.
        const currency = left.currency && right.currency ? undefined : (left.currency ?? right.currency);
        return { ok: true, value: left.value / right.value, currency };
      }
    }
  };
  const result = evaluate(tree.expression);
  if (!result.ok) return result;
  if (!Number.isFinite(result.value)) return { ok: false, error: 'Calculation result is not finite.' };
  if (tree.output_type === 'currency') {
    if (!result.currency) return { ok: false, error: 'Currency calculation needs money inputs.' };
    return { ok: true, value: Math.round(result.value), currency: result.currency };
  }
  if (result.currency) return { ok: false, error: 'Number calculation must not mix money inputs.' };
  return result;
}
