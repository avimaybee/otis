import type { CurrentInteraction } from './interactions.js';

export const ENTITY_FILE_SECTIONS = ['facts', 'tasks', 'timeline', 'history', 'notes', 'quotes', 'drafts', 'memory', 'contacts', 'attachments', 'reminders'] as const;
export type EntityFileSection = typeof ENTITY_FILE_SECTIONS[number];
export interface SourceRef {
  event_id: string | null;
  message_id: string | null;
  actor_user_id: string | null;
  actor_name: string | null;
  recorded_at: string | null;
  channel: string | null;
}
export interface FileFact {
  field: string;
  origin_entity_id: string;
  value: unknown;
  state: 'clear' | 'disputed';
  revision: number;
  candidate_event_ids: string[];
  source: SourceRef;
}
export interface FileTask {
  id: string; entity_id: string | null; title: string; status: string; revision: number;
  assignee_user_id: string | null; assignee_name: string | null;
  due_kind: string | null; due_local_date: string | null; due_instant: string | null;
  due_timezone: string | null; snooze_until: string | null; overdue: boolean;
  source: SourceRef;
}
export interface FileHistory {
  id: string; entity_id: string | null; kind: string; sequence: number; payload: unknown;
  occurred_at: string; supersedes_event_id: string | null; reverts_event_id: string | null;
  is_reverted: boolean; interaction_id: string | null; current_head_event_id: string | null;
  source: SourceRef;
}
export interface FilePage<T = Record<string, unknown>> {
  items: T[]; total: number; next_cursor: string | null; has_more: boolean;
  availability: 'available' | 'unavailable';
}
export interface EntityFile {
  version: 1;
  entity: { id: string; name: string; kind: string; status: string; assigned_user_id: string | null; assigned_name: string | null; aliases: string[]; merged_from: { id: string; name: string }[] };
  as_of_business_revision: number;
  facts: FilePage<FileFact>; tasks: FilePage<FileTask>;
  timeline: FilePage<CurrentInteraction>; history?: FilePage<FileHistory>;
  notes: FilePage<CurrentInteraction>; quotes: FilePage<CurrentInteraction>;
  drafts: FilePage; memory: FilePage; contacts: FilePage; attachments: FilePage; reminders: FilePage;
  last_contact: string | null;
  coverage: { bounded: boolean; partial_sections: EntityFileSection[]; unavailable_sections: EntityFileSection[] };
}
export interface EntityFileSectionResponse {
  version: 1; entity_id: string; as_of_business_revision: number; section: EntityFileSection;
  page: FilePage<unknown>;
}
