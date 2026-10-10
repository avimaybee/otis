/**
 * @otis/ledger/types
 * Internal domain types, commands, and options for the Otis ledger.
 */

import type {
  CurrentInteraction,
  EntityContact, EntityRedirect, AttachmentLink, ReminderRule, MediaAnnotation,
  Entity,
  EntityAlias,
  EntityStateField,
  InteractionState,
  Task,
  DraftProjection,
  MemoryEntry,
  MemorySuppression,
  MemoryScope,
  MemoryCategory,
  LeadStatus,
  Provenance,
  TaskDue,
  TaskStatus,
  WorkspaceContext,
  PersistedRecordsList,
  PersistedRecordsListColumn,
  PersistedRecordsRow,
  PersistedRecordsValue,
  PersistedFieldDef,
  RecordEdit,
} from '@otis/contracts';

export interface LedgerProjectionState {
  mergeCounts?: Map<string, Record<string, number>>;
  contacts?: Map<string, EntityContact>;
  redirects?: Map<string, EntityRedirect>;
  attachmentLinks?: Map<string, AttachmentLink>;
  reminderRules?: Map<string, ReminderRule>;
  mediaAnnotations?: Map<string, MediaAnnotation>;
  /** Read-only target bodies for conflict recovery and no-op detection; not another projection. */
  interactionHeads?: Map<string, CurrentInteraction>;
  entities: Map<string, Entity>;
  aliases: Map<string, EntityAlias>; // key: `${workspace_id}:${alias.toLowerCase()}`
  fields: Map<string, EntityStateField>; // key: `${entity_id}:${field_name}`
  interactions: Map<string, InteractionState>; // key: root event id
  tasks: Map<string, Task>;
  drafts: Map<string, DraftProjection>;
  memoryEntries: Map<string, MemoryEntry>; // key: `${id}`
  memorySuppressions: Map<string, MemorySuppression>; // key: `${id}`
  recordsLists?: Map<string, PersistedRecordsList>;
  recordsListColumns?: Map<string, PersistedRecordsListColumn>;
  recordsRows?: Map<string, PersistedRecordsRow>;
  recordsValues?: Map<string, PersistedRecordsValue>;
  fieldDefinitions?: Map<string, PersistedFieldDef>;
}

export interface CreateEntityArgs {
  name: string;
  kind?: string;
  initial_status?: LeadStatus;
  assigned_user_id?: string | null;
}

export interface RenameEntityArgs {
  entity_id: string;
  new_name: string;
}

export interface AddAliasArgs {
  entity_id: string;
  alias: string;
}

export interface DeleteEntityArgs {
  entity_id: string;
  /**
   * Explicit member confirmation. The conversational flow asks first and the
   * confirmed answer resumes with confirm set; only affirmative values
   * ('yes', 'confirm', 'delete') execute, anything else cancels.
   */
  confirm?: string | null;
  reason?: string | null;
}

export interface LogEventArgs {
  entity_id?: string | null;
  kind: 'note' | 'visit' | 'contact' | 'quote';
  payload: Record<string, unknown>;
  occurred_at?: string;
  provenance?: Provenance;
}

/**
 * C1 single-interaction revision. Emits another note/visit/contact/quote
 * event with `supersedes_event_id` pointing at the exact current head and a
 * typed replacement payload carrying the stable root ID. Strict by design:
 * no arbitrary JSON merge patch, no event-kind conversion (replacing a visit
 * with a quote is remove + log, preserving both histories), no
 * workspace/actor override, no model-supplied approval.
 */
export interface ReviseInteractionArgs {
  /** Stable root: the original interaction event ID. */
  interaction_id: string;
  /** Optimistic edit token: the exact current head event ID. */
  expected_head_event_id: string;
  /** Must equal the root interaction's kind; kinds never convert. */
  kind: 'note' | 'visit' | 'contact' | 'quote';
  /** Replacement payload, validated exactly as new logging validates it. */
  payload: Record<string, unknown>;
  /** New occurrence time; recorded time stays the commit time. */
  occurred_at?: string;
}

/**
 * C1 single-interaction removal. Emits one `interaction_removed` event
 * targeting root/current head with an optional reason. Logical removal with
 * history/Undo, not audited erasure.
 */
export interface RemoveInteractionArgs {
  /** Stable root: the original interaction event ID. */
  interaction_id: string;
  /** Optimistic edit token: the exact current head event ID. */
  expected_head_event_id: string;
  reason?: string | null;
}

export interface SetFieldArgs {
  entity_id: string;
  field_name: string;
  value: unknown;
  provenance?: Provenance;
  supersedes_event_id?: string | null;
}

export interface SetFieldsFieldItem {
  field_name: string;
  value: unknown;
  provenance?: Provenance;
}

export interface SetFieldsArgs {
  entity_id: string;
  fields: SetFieldsFieldItem[];
  /**
   * Trusted agent-layer verdict: indexes into `fields` whose status update
   * was explicitly instructed by the member's own words. Never model-supplied:
   * the agent bridge derives it from the source text, and resumption derives
   * it from a persisted member confirmation. Absent means no explicit intent.
   */
  explicit_status_indexes?: number[];
}

/**
 * Which projection keys a targeted hydration loaded. Unloaded collections
 * are empty maps; the post-handler bounds assertion treats any mutation
 * outside the covered keys as a violation instead of silently persisting a
 * partial state as the whole workspace.
 */
export type CoverageScope = 'all' | Set<string>;

export interface ProjectionCoverage {
  /** Only the trusted new-log footprint permits creating a root. */
  interactionCreate?: { entity_id: string | null; kind: string };
  /**
   * When 'all', created keys pass the bounds assertion in every collection:
   * creations cannot misread unloaded state as absent, so a composing batch
   * with server-generated ids stays provable while changed and deleted keys
   * must still sit inside the loaded coverage. Absent for all existing
   * footprints, which keep the strict created-key check.
   */
  createScope?: 'all' | 'none';
  entities: CoverageScope;
  aliases: CoverageScope;
  fields: CoverageScope;
  interactions: CoverageScope;
  tasks: CoverageScope;
  drafts: CoverageScope;
  memoryEntries: CoverageScope;
  memorySuppressions: CoverageScope;
  recordsLists?: CoverageScope;
  recordsListColumns?: CoverageScope;
  recordsRows?: CoverageScope;
  recordsValues?: CoverageScope;
  fieldDefinitions?: CoverageScope;
}

export const FULL_PROJECTION_COVERAGE: ProjectionCoverage = {
  entities: 'all',
  aliases: 'all',
  fields: 'all',
  interactions: 'all',
  tasks: 'all',
  drafts: 'all',
  memoryEntries: 'all',
  memorySuppressions: 'all',
  recordsLists: 'all',
  recordsListColumns: 'all',
  recordsRows: 'all',
  recordsValues: 'all',
  fieldDefinitions: 'all',
};

export interface RecordsBatchArgs {
  schema_version?: 1;
  save_id: string;
  action_id?: string;
  chunk_index?: number;
  chunk_count?: number;
  list_id: string;
  operations: RecordEdit[];
}

export interface CreateTaskArgs {
  title: string;
  entity_id?: string | null;
  assignee_user_id?: string | null;
  due?: TaskDue;
  explicit_no_deadline?: boolean;
  /** Policy-derived explicit promise marker; never model-supplied. */
  is_promise?: boolean;
}

export interface UpdateTaskArgs {
  task_id: string;
  status?: TaskStatus;
  due?: TaskDue;
  snooze_until?: string | null;
  title?: string;
  expected_revision?: number;
}

export interface ResolveConflictArgs {
  entity_id: string;
  field_name: string;
  resolved_value: unknown;
  candidate_event_ids: string[];
  rationale?: string;
}

export interface RecordDraftArgs {
  draft_id?: string;
  entity_id?: string | null;
  channel?: 'whatsapp' | 'email' | 'sms' | 'other';
  recipient_address?: string | null;
  content_text?: string;
  status?: 'draft' | 'member_confirmed_sent' | 'archived';
  expected_revision?: number;
}

export interface MarkMessageSentArgs {
  draft_id: string;
  confirmed_by_user_id?: string;
}

export interface RememberContextArgs {
  memory_id?: string;
  scope: MemoryScope;
  subject_id?: string | null;
  category: MemoryCategory;
  content: string;
  provenance?: Provenance;
  supersedes_memory_id?: string | null;
}

export interface ForgetMemoryArgs {
  memory_id: string;
  rationale?: string;
}

export interface LedgerCommandContext extends WorkspaceContext {
  /** Trusted interpretation verdict, never accepted from model arguments. */
  merge_identity_confirmed?: boolean;
  /** Derived by the trusted attachment handler; checked again in the commit guard. */
  required_media_id?: string;
  /** Trusted guard requirements for a selected file edit, never client authority. */
  releasing_media_id?: string;
  correcting_audio_id?: string;
  action_id: string;
  expected_business_revision: number;
  resuming_clarification_id?: string;
  max_daily_actions?: number;
}
