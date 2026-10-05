/**
 * @otis/ledger/types
 * Internal domain types, commands, and options for the Otis ledger.
 */

import type {
  Entity,
  EntityAlias,
  EntityStateField,
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
} from '@otis/contracts';

export interface LedgerProjectionState {
  entities: Map<string, Entity>;
  aliases: Map<string, EntityAlias>; // key: `${workspace_id}:${alias.toLowerCase()}`
  fields: Map<string, EntityStateField>; // key: `${entity_id}:${field_name}`
  tasks: Map<string, Task>;
  drafts: Map<string, DraftProjection>;
  memoryEntries: Map<string, MemoryEntry>; // key: `${id}`
  memorySuppressions: Map<string, MemorySuppression>; // key: `${id}`
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

export interface LogEventArgs {
  entity_id?: string | null;
  kind: 'note' | 'visit' | 'contact' | 'quote';
  payload: Record<string, unknown>;
  occurred_at?: string;
  provenance?: Provenance;
}

export interface SetFieldArgs {
  entity_id: string;
  field_name: string;
  value: unknown;
  provenance?: Provenance;
  supersedes_event_id?: string | null;
}

export interface CreateTaskArgs {
  title: string;
  entity_id?: string | null;
  assignee_user_id?: string | null;
  due?: TaskDue;
  explicit_no_deadline?: boolean;
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
  action_id: string;
  expected_business_revision: number;
  resuming_clarification_id?: string;
  max_daily_actions?: number;
}
