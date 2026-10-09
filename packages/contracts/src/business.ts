export interface EntityContact {
  id: string; workspace_id: string; entity_id: string; method: 'phone' | 'email'; value: string;
  comparison_key: string; label: string | null; is_primary: boolean; state: 'active' | 'removed' | 'disputed';
  revision: number; source_event_id: string; original_event_id: string; updated_at: string;
}
export interface EntityRedirect {
  workspace_id: string; source_entity_id: string; target_entity_id: string; source_event_id: string;
  decisions: Record<string, string>; revision: number; updated_at: string;
}
export interface AttachmentLink {
  id: string; workspace_id: string; entity_id: string; interaction_id: string | null; media_id: string;
  label: string | null; state: 'active' | 'unlinked'; revision: number; source_event_id: string; updated_at: string;
}
export type ReminderSpec =
  | { kind: 'weekly'; weekdays: number[]; local_time: string; start_date?: string; end_date?: string }
  | { kind: 'after_quote'; role: 'offered' | 'expected'; offset: { hours: number } | { days: number; local_time: string }; if_no_contact: boolean };
export interface ReminderRule {
  id: string; workspace_id: string; user_id: string; entity_id: string | null; text: string;
  timezone: string; channel: 'web' | 'telegram'; spec: ReminderSpec;
  status: 'active' | 'paused' | 'cancelled'; revision: number; source_event_id: string; updated_at: string;
}
export interface ChangeContactArgs {
  entity_id: string; contact_id?: string; expected_revision?: number;
  operation: 'save' | 'remove' | 'make_primary'; method?: 'phone' | 'email'; value?: string;
  label?: string | null; primary?: boolean;
}
export interface MergeEntitiesArgs {
  source_entity_id: string; target_entity_id: string; expected_revision: number;
  decisions?: Record<string, string>;
}
export interface LinkAttachmentArgs { entity_id: string; media_id: string; interaction_id?: string; label?: string }
/** Original audio/transcript bytes are immutable; this is a sourced overlay. */
export interface MediaAnnotation {
  media_id: string; workspace_id: string; transcript: string | null;
  retention: 'inherit' | 'retain' | 'release'; release_after: string | null;
  revision: number; source_event_id: string; updated_at: string;
}
export interface UpdateAttachmentArgs {
  entity_id: string; media_id: string; expected_revision: number;
  transcript?: string | null; retention?: 'retain' | 'release';
}
export interface UnlinkAttachmentArgs { link_id: string; expected_revision: number }
export interface ChangeReminderRuleArgs {
  rule_id?: string; expected_revision?: number; entity_id?: string | null;
  text?: string; timezone?: string; channel?: 'web' | 'telegram'; spec?: ReminderSpec;
  status?: 'active' | 'paused' | 'cancelled';
}
export interface FollowUpRow {
  id: string; entity_id: string | null; text: string; timezone: string; channel: 'web' | 'telegram';
  spec: ReminderSpec; status: 'active' | 'paused'; revision: number;
  next_due: string | null; last_delivered_at: string | null;
  actor_user_id: string | null; actor_name: string | null; source_message_id: string | null;
  recorded_at: string; source_channel: string;
}
export interface FollowUpPage {
  rows: FollowUpRow[]; total: number; as_of_business_revision: number;
  has_more: boolean; next_cursor: string | null;
}
