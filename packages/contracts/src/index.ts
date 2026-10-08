/**
 * @otis/contracts
 * Shared domain, DTO, and API contracts for Otis.
 * Defined in docs/contracts.md and architecture.md.
 */

// --- Chat API DTOs (docs/contracts.md sections 7-9) ---
// Re-exported so clients can import everything from the package root.
export * from './chat.js';
export * from './voice.js';
export * from './media.js';

// --- Base Result & Error Types ---

export type ResultStatus =
  | 'applied'
  | 'already_applied'
  | 'needs_clarification'
  | 'conflict'
  | 'rejected'
  | 'retryable_failure';

export interface PendingOperationPayload {
  version: 1;
  command_name: string;
  action_id: string;
  args: Record<string, unknown>;
  missing_fields: string[];
  candidates?: string[];
  source_revision: number;
}

export interface ClarificationPrompt {
  prompt: string;
  missing_fields?: string[];
  candidates?: string[];
  pending_operation?: PendingOperationPayload;
}

export interface CommandResult<T = unknown> {
  status: ResultStatus;
  action_id?: string;
  affected_resource_ids?: string[];
  event_ids?: string[];
  committed_revision?: number;
  summary?: string;
  clarification?: ClarificationPrompt;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface HttpErrorResponse {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    request_id: string;
    details?: unknown;
  };
}

// --- Trusted Workspace Context ---

export interface ActorContext {
  kind: 'member' | 'system';
  user_id?: string;
  system_job?: string;
}

export interface WorkspaceContext {
  workspace_id: string;
  actor: ActorContext;
  membership_revision: number;
  source_message_id?: string;
  source_job_id?: string;
  source_channel?: 'web' | 'telegram' | 'system';
  chat_id?: string;
  request_id: string;
  run_id?: string;
  step_id?: string;
  fence?: number;
}

// --- Identity & Workspace Models ---

export interface User {
  id: string;
  firebase_uid: string;
  email: string | null;
  display_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface Workspace {
  id: string;
  name: string;
  owner_user_id: string | null;
  business_revision: number;
  membership_revision: number;
  lease_owner: string | null;
  lease_attempt_id: string | null;
  lease_fence: number;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export type WorkspaceRole = 'owner' | 'member';

export interface WorkspaceMember {
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
  joined_at: string;
  created_at: string;
  updated_at: string;
  display_name?: string | null;
  email?: string | null;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: WorkspaceRole;
  joined_at: string;
}

export interface Session {
  id: string;
  token_hash: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_seen_at: string;
}

export interface Invite {
  id: string;
  token_hash: string;
  workspace_id: string;
  invited_email: string;
  invited_by_user_id: string;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  accepted_by_user_id: string | null;
}

export interface LinkCode {
  id: string;
  code_hash: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

// --- Provider & Settings Contracts ---

/** `groq` is an STT-only provider: it never appears as a conversation model. */
export type ProviderName = 'gemini' | 'opencode_go' | 'groq';

export type ProviderStatus =
  | 'unverified'
  | 'available'
  | 'invalid_credential'
  | 'unavailable'
  | 'retired';

export interface ProviderCredentialMetadata {
  provider: ProviderName;
  status: ProviderStatus;
  last_verified_at: string | null;
  key_version: number;
  source?: 'platform' | 'workspace';
  has_platform_fallback?: boolean;
}

export interface WorkspaceSettings {
  workspace_id: string;
  default_model: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemberSettings {
  workspace_id: string;
  user_id: string;
  brief_enabled: boolean;
  brief_local_time: string | null;
  brief_timezone: string | null;
  /**
   * Device-reported IANA zone for interpreting the member's relative dates.
   * Server-derived from message telemetry, never a brief-schedule override.
   */
  interpretation_timezone: string | null;
  /** Selected weekdays as 0 (Sunday) through 6 (Saturday). */
  brief_weekdays: number[] | null;
  brief_channel: 'web' | 'telegram';
  preferred_language: string;
  created_at: string;
  updated_at: string;
}

// --- API Request & Response Types ---

export interface HealthResponse {
  status: 'ok';
  timestamp: string;
}

export interface AuthSessionRequest {
  id_token: string;
  invite_token?: string;
}

export interface AuthSessionResponse {
  status: 'ok';
  user: User;
  workspaces: WorkspaceSummary[];
  session_expires_at: string;
}

export interface MeResponse {
  user: User;
  workspaces: WorkspaceSummary[];
}

/** One-time Telegram connection link for the requesting member. The code
 * itself is never returned or persisted — only the deep link to open it. */
export interface TelegramLinkResponse {
  status: 'ok';
  deep_link: string;
  expires_at: string;
}

/** One own Telegram connection: routing workspace when the caller still has
 * membership there, otherwise null (selection needed). Never another user's. */
export interface TelegramConnectionEntry {
  routing_workspace: { id: string; name: string } | null;
}

/** Read-only Telegram connection status for the session user. */
export interface TelegramConnectionResponse {
  status: 'ok';
  /** Bot provisioning present (username and token configured). */
  available: boolean;
  state: 'connected' | 'routing_needed' | 'disconnected';
  /** Routing workspace when a single own connection is ready; filtered to
   * workspaces the caller can still access. */
  routing_workspace: { id: string; name: string } | null;
  /** Bounded list of the caller's own connections (legacy multiples). */
  connections: TelegramConnectionEntry[];
}

/** Result of disconnecting the session user's own Telegram connection. */
export interface TelegramDisconnectResponse {
  status: 'ok';
  state: 'disconnected';
}

export interface LogoutResponse {
  status: 'ok';
}

export interface WorkspaceDetailResponse {
  workspace: {
    id: string;
    name: string;
    role: WorkspaceRole;
    business_revision: number;
    created_at: string;
  };
}

export interface CreateInviteRequest {
  email: string;
}

export interface CreateInviteResponse {
  status: 'ok';
  invite_id: string;
  /** Raw token, shown once so the inviter can copy the link. Never stored client-side. */
  token: string;
  expires_at: string;
}

export interface MemberListResponse {
  members: WorkspaceMember[];
}

export interface LifecycleActionResponse {
  status: 'ok';
  workspace_id: string;
  affected_user_id: string;
  membership_revision: number;
}

export interface TransferOwnershipRequest {
  new_owner_user_id: string;
}

export interface UpdateMemberSettingsRequest {
  brief_enabled?: boolean;
  brief_local_time?: string | null;
  brief_timezone?: string | null;
  brief_weekdays?: number[] | null;
  brief_channel?: 'web' | 'telegram';
  preferred_language?: string;
}

export interface UpdateWorkspaceSettingsRequest {
  default_model?: string | null;
}

export interface PutCredentialRequest {
  /** Raw provider key. Encrypted server-side; never returned or logged. */
  key: string;
}

export interface CredentialStatusResponse {
  status: 'ok';
  credential: ProviderCredentialMetadata | null;
}

// --- Domain Enums & Dates ---

export type ChannelType = 'web' | 'telegram' | 'system';

export type EntityKind = 'business' | 'person' | 'other';

export type LeadStatus =
  | 'new'
  | 'cold'
  | 'warm'
  | 'hot'
  | 'won'
  | 'lost'
  | 'deprioritized';

export type TaskStatus = 'open' | 'done' | 'cancelled';

export type TaskDue =
  | { kind: 'date'; local_date: string; timezone: string }
  | { kind: 'instant'; at: string; timezone: string }
  | null;

// --- Canonical States & Enums (docs/contracts.md Section 3) ---

export type InboundProcessingStatus =
  | 'unrouted'
  | 'queued'
  | 'processing'
  | 'waiting_for_input'
  | 'processed'
  | 'unsupported'
  | 'failed'
  | 'cancelled';

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_input'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'cancelled';

export type RunExecutorKind = 'agent' | 'command' | 'system';

export type StepStatus =
  | 'planned'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped';

export type ClarificationStatus =
  | 'pending'
  | 'resolved'
  | 'cancelled'
  | 'superseded';

export type DeliveryStatus =
  | 'pending'
  | 'sending'
  | 'delivered'
  | 'failed_known'
  | 'outcome_unknown'
  | 'cancelled';

export type SystemJobKind =
  | 'scheduled_daily_brief'
  | 'reminder'
  | 'summary_refresh'
  | 'outbox_sweep'
  | 'media_orphan_cleanup'
  | 'export';

export type SystemJobStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type OutboxDestination =
  | 'workspace_actor'
  | 'telegram'
  | 'summary_worker';

// --- Conversation & Inbound Models ---

export interface Chat {
  id: string;
  workspace_id: string;
  author_user_id: string;
  /** Display only; authorization uses the authenticated user ID. */
  author_display_name?: string | null;
  title: string;
  model_override: string | null;
  thinking_override?: { model_key: string; choice_id: string } | null;
  thinking_override_json?: string | null;
  is_archived: boolean;
  activity_cursor: number;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
}

export interface CreateChatRequest {
  title?: string;
  client_chat_id?: string;
  model_override?: string | null;
}

export interface ChatListResponse {
  chats: Chat[];
  next_cursor?: string;
}

export interface ChatMessage {
  id: string;
  workspace_id: string;
  chat_id: string;
  author_user_id: string | null;
  author_display_name?: string | null;
  author_kind: 'member' | 'system';
  channel: ChannelType;
  inbound_message_id: string | null;
  client_message_id: string | null;
  content_text: string;
  media_id: string | null;
  /** Validated still-image uploads attached to this message, in send order. */
  image_media_ids?: string[] | null;
  run_id: string | null;
  sequence: number;
  created_at: string;
  updated_at: string;
}

export interface CreateChatMessageRequest {
  client_message_id: string;
  text?: string;
  media_id?: string;
  /** Validated still-image uploads attached to this message (at most IMAGE_BOUNDS.MAX_PER_MESSAGE). */
  image_media_ids?: string[];
  clarification_id?: string;
  /**
   * Device-reported IANA timezone of the sender, stored as the member's
   * interpretation zone for relative dates. Optional telemetry, never
   * required; invalid values are rejected like any other bad field.
   */
  timezone?: string;
}

export interface AcceptMessageResponse {
  status: 'accepted';
  message_id: string;
  run_id: string;
  acceptance_sequence: number;
  mode?: 'new_run' | 'steer' | 'clarification';
  reply?: string;
  selected_workspace_id?: string | null;
  /** A deterministic control action committed its effect; no agent was queued. */
  command_applied?: boolean;
}

export interface InboundMessage {
  id: string;
  workspace_id: string | null;
  user_id: string | null;
  channel: ChannelType;
  external_id: string;
  payload_fingerprint: string;
  raw_payload: string | null;
  status: InboundProcessingStatus;
  acceptance_sequence: number | null;
  chat_id: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface SystemJob {
  id: string;
  workspace_id: string;
  job_kind: SystemJobKind;
  status: SystemJobStatus;
  scheduled_at: string;
  attempt_count: number;
  max_attempts: number;
  last_error: string | null;
  payload: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentRun {
  id: string;
  workspace_id: string;
  chat_id: string | null;
  source_message_id: string | null;
  source_job_id: string | null;
  executor_kind: RunExecutorKind;
  status: RunStatus;
  model_key: string | null;
  attempt_id: string | null;
  lease_fence: number;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunStep {
  id: string;
  run_id: string;
  workspace_id: string;
  step_index: number;
  tool_name: string;
  arguments_hash: string;
  arguments_json: string;
  status: StepStatus;
  result_json: string | null;
  action_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface PendingClarification {
  id: string;
  workspace_id: string;
  chat_id: string;
  run_id: string;
  source_message_id: string;
  requester_user_id: string;
  question: string;
  intended_operation: string;
  missing_fields: string[];
  candidates_json?: string | null;
  source_revision: number;
  status: ClarificationStatus;
  resolution_response?: string | null;
  resolved_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface OutboxItem {
  id: string;
  workspace_id: string;
  destination: OutboxDestination;
  topic: string;
  payload_json: string;
  status: DeliveryStatus;
  attempt_count: number;
  max_attempts: number;
  last_attempt_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface TelegramUser {
  telegram_user_id: string;
  user_id: string;
  selected_workspace_id: string | null;
  active_chat_id: string | null;
  created_at: string;
  updated_at: string;
}

// --- Activity & Envelopes ---

export type PublicActivityType =
  | 'message_accepted'
  | 'queued'
  | 'run_started'
  | 'text_chunk'
  | 'text_preview'
  | 'step_started'
  | 'step_finished'
  | 'action_applied'
  | 'reasoning_summary'
  | 'clarification_required'
  | 'partial_failure'
  | 'answer_saved'
  | 'run_finished'
  | 'action_reverted';

export interface PublicActivity<T = unknown> {
  schema_version: 1;
  id: string;
  cursor: number;
  workspace_id: string;
  chat_id: string;
  run_id: string;
  created_at: string;
  type: PublicActivityType;
  payload: T;
}

// --- Ledger, Business Events & Projections (docs/contracts.md Section 5 & Plan 002) ---

export type LedgerEventKind =
  | 'entity_created'
  | 'entity_renamed'
  | 'alias_added'
  | 'note'
  | 'visit'
  | 'contact'
  | 'quote'
  | 'status_change'
  | 'field_change'
  | 'task_created'
  | 'task_updated'
  | 'task_done'
  | 'task_cancelled'
  | 'draft_created'
  | 'draft_updated'
  | 'message_sent_by_member'
  | 'conflict_resolved'
  | 'memory_note'
  | 'memory_forgotten'
  | 'entity_deleted'
  | 'interaction_removed'
  | 'revert';

export type Provenance = 'stated' | 'inferred';

export type FieldState = 'clear' | 'disputed';

export interface QuoteValue {
  amount: number; // integer minor units (e.g. 360000 cents = 3600 EUR)
  currency: string; // ISO 4217, e.g. 'EUR'
  role: 'offered' | 'expected';
  /**
   * Stable interaction root for C1 revision chains. Absent on legacy rows,
   * where the root is the event's own ID. Set on revision events to the
   * original interaction event ID; never rewrites who originally logged it.
   */
  interaction_id?: string | null;
}

export interface VisitPayload {
  summary: string;
  contact_made: boolean;
  location?: string;
  /** Stable interaction root; absent on legacy rows (root is own event ID). */
  interaction_id?: string | null;
}

export interface ContactPayload {
  summary: string;
  channel: 'phone' | 'email' | 'in_person' | 'telegram' | 'whatsapp' | 'other';
  /** Stable interaction root; absent on legacy rows (root is own event ID). */
  interaction_id?: string | null;
}

export interface NotePayload {
  text: string;
  /** Stable interaction root; absent on legacy rows (root is own event ID). */
  interaction_id?: string | null;
}

export interface StatusChangePayload {
  old_status?: LeadStatus | null;
  new_status: LeadStatus;
  reason?: string;
}

export interface FieldChangePayload {
  field_name: string;
  old_value?: unknown;
  new_value: unknown;
  reason?: string;
}

export interface TaskCreatedPayload {
  task_id: string;
  title: string;
  entity_id?: string | null;
  assignee_user_id?: string | null;
  due: TaskDue;
  /** True when the member explicitly chose no deadline. Absent on old rows. */
  explicit_no_deadline?: boolean;
  /** True when the member explicitly promised this work. Absent on old rows. */
  is_promise?: boolean;
}

export interface TaskUpdatedPayload {
  task_id: string;
  title?: string;
  assignee_user_id?: string | null;
  due?: TaskDue;
  snooze_until?: string | null;
  status?: TaskStatus;
}

export interface ConflictResolvedPayload {
  entity_id: string;
  field_name: string;
  resolved_value: unknown;
  candidate_event_ids: string[];
  rationale?: string;
}

export interface RevertPayload {
  target_event_id: string;
  target_action_id: string;
  target_event_kind: LedgerEventKind;
  mode: UndoMode;
  group_operation_id: string;
  rationale?: string;
}

/**
 * C1 logical removal of one interaction (note/visit/contact/quote).
 * Targets the stable root and the exact current head; the original report
 * and every revision stay in append-only history. Removal is logical, not
 * audited erasure: Undo restores the prior head.
 */
export interface InteractionRemovedPayload {
  /** Stable root: the original interaction event ID (legacy roots equal it). */
  root_event_id: string;
  /** Exact current head event ID at removal time (optimistic token). */
  head_event_id: string;
  /** Original kind of the removed interaction; never converted. */
  target_kind: 'note' | 'visit' | 'contact' | 'quote';
  reason?: string | null;
}

/** Result data for a successful `revise_interaction` commit. */
export interface ReviseInteractionResult {
  event_id: string;
  interaction_id: string;
  head_event_id: string;
}

/** Result data for a successful `remove_interaction` commit. */
export interface RemoveInteractionResult {
  event_id: string;
  interaction_id: string;
  head_event_id: string;
}

export interface LedgerEvent<T = unknown> {
  id: string;
  workspace_id: string;
  sequence: number;
  entity_id?: string | null;
  actor_kind: 'member' | 'system';
  actor_user_id?: string | null;
  actor_job_id?: string | null;
  kind: LedgerEventKind;
  schema_version: number;
  payload: T;
  occurred_at: string;
  recorded_at: string;
  channel: ChannelType;
  source_message_id?: string | null;
  source_job_id?: string | null;
  action_id: string;
  supersedes_event_id?: string | null;
  reverts_event_id?: string | null;
  provenance: Provenance;
  created_at: string;
}

export interface Entity {
  id: string;
  workspace_id: string;
  name: string;
  kind: string;
  status: LeadStatus;
  assigned_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface EntityAlias {
  id: string;
  workspace_id: string;
  entity_id: string;
  alias: string;
  source_event_id?: string | null;
  created_at: string;
}

export interface EntityStateField {
  id: string;
  workspace_id: string;
  entity_id: string;
  field_name: string;
  state: FieldState;
  value_text: string | null;
  value_json: string | null;
  provenance: Provenance;
  source_event_id: string | null;
  candidate_event_ids?: string[] | null;
  last_confirmed_value_text?: string | null;
  last_confirmed_value_json?: string | null;
  revision: number;
  updated_at: string;
}

export interface Task {
  id: string;
  workspace_id: string;
  entity_id: string | null;
  title: string;
  assignee_user_id: string | null;
  status: TaskStatus;
  due_kind: 'date' | 'instant' | null;
  due_local_date: string | null;
  due_instant: string | null;
  due_timezone: string | null;
  snooze_until: string | null;
  /** Persisted explicit no-deadline choice; false for pre-marker rows. */
  explicit_no_deadline: boolean;
  /** Persisted explicit promise marker; false for pre-marker rows. */
  is_promise: boolean;
  source_event_id: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

/**
 * C1 single-interaction lifecycle projection: one row per stable interaction
 * root tracking the current head, removal state and revision. Content stays
 * in events; this row carries only the metadata timeline/file reads need.
 * Legacy rows use their own event ID as root. Rebuilt deterministically
 * from the event stream, so projection always equals replay.
 */
export interface InteractionState {
  workspace_id: string;
  root_event_id: string;
  entity_id: string | null;
  kind: 'note' | 'visit' | 'contact' | 'quote';
  head_event_id: string;
  revision: number;
  state: 'active' | 'removed';
  occurred_at: string;
  sequence: number;
  updated_at: string;
  /**
   * Head value snapshot for quote rows (the head event's quote payload),
   * letting head-aware quote reduction recompute from the projection
   * without rereading history. NULL for other kinds.
   */
  head_value_json: string | null;
}

export interface DraftProjection {
  id: string;
  workspace_id: string;
  entity_id: string | null;  channel: 'whatsapp' | 'email' | 'sms' | 'other';
  recipient_address: string | null;
  content_text: string;
  status: 'draft' | 'member_confirmed_sent' | 'archived';
  source_event_id: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface MessageSentByMemberPayload {
  draft_id: string;
  confirmed_by_user_id?: string;
}

export type MemoryScope = 'workspace' | 'entity' | 'member_in_workspace';

export type MemoryCategory =
  | 'communication_preference'
  | 'relationship_context'
  | 'workflow_context'
  | 'other_context';

export type MemoryStatus = 'active' | 'superseded' | 'forgotten';

export interface MemoryNotePayload {
  memory_id: string;
  scope: MemoryScope;
  subject_id?: string | null;
  category: MemoryCategory;
  content: string;
  supersedes_memory_id?: string | null;
}

export interface MemoryForgottenPayload {
  memory_id: string;
  rationale?: string;
}

export interface MemoryEntry {
  id: string;
  workspace_id: string;
  scope: MemoryScope;
  subject_id: string | null;
  category: MemoryCategory;
  content: string;
  status: MemoryStatus;
  provenance: Provenance;
  source_event_id: string | null;
  source_message_id: string | null;
  author_user_id: string | null;
  observed_at: string;
  created_at: string;
  superseding_event_id: string | null;
  business_revision: number;
}

export interface MemorySuppression {
  id: string;
  workspace_id: string;
  target_memory_id: string;
  source_event_id: string | null;
  source_message_id: string | null;
  suppression_event_id: string;
  revision: number;
  created_at: string;
}

export interface MemorySummary {
  id: string;
  workspace_id: string;
  scope: MemoryScope;
  subject_key: string;
  summary_text: string;
  source_manifest_json: string;
  built_from_revision: number;
  format_version: number;
  generation_model: string | null;
  built_at: string;
}

export interface MemoryRefreshJob {
  id: string;
  workspace_id: string;
  scope: MemoryScope;
  subject_key: string;
  target_revision: number;
  state: 'pending' | 'running' | 'completed' | 'failed';
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  claim_token: string | null;
  claim_expires_at: string | null;
  error_class: string | null;
  created_at: string;
  updated_at: string;
}

export interface ActionReceipt {
  id: string;
  workspace_id: string;
  action_id: string;
  payload_hash: string;
  command_name: string;
  result_status: ResultStatus;
  result_json: string;
  actor_kind: 'member' | 'system';
  actor_user_id?: string | null;
  source_message_id?: string | null;
  source_job_id?: string | null;
  run_id?: string | null;
  step_id?: string | null;
  committed_revision: number;
  created_at: string;
}

export type UndoMode = 'from_here' | 'single';

export interface UndoPreviewDependency {
  action_id: string;
  reason: string;
  requires_clarification: boolean;
}

export interface UndoPreview {
  target_action_id: string;
  mode: UndoMode;
  selected_action_ids: string[];
  affected_event_ids: string[];
  affected_entities: { id: string; name: string; changes: string[] }[];
  affected_tasks: { id: string; title: string; changes: string[] }[];
  affected_context?: { id: string; summary: string; changes: string[] }[];
  dependencies: UndoPreviewDependency[];
  expected_revision: number;
}

export interface UndoRequest {
  action_id: string;
  mode: UndoMode;
  client_operation_id: string;
  expected_revision: number;
}

// --- Named Bounds and Defaults ---

export const AUTH_BOUNDS = {
  SESSION_TTL_SECONDS: 7 * 24 * 60 * 60, // 7 days
  INVITE_TTL_SECONDS: 7 * 24 * 60 * 60, // 7 days
  LINK_CODE_TTL_SECONDS: 10 * 60, // 10 minutes
  COOKIE_NAME: 'otis_session',
  CSRF_HEADER: 'x-otis-csrf',
} as const;

export const DOMAIN_BOUNDS = {
  MAX_INPUT_CHARS: 16000,
  DEFAULT_QUERY_LIMIT: 25,
  MAX_QUERY_LIMIT: 100,
  MAX_TRANSCRIPT_PAGE: 50,
  MAX_MEMORY_HITS: 12,
  MAX_MEDIA_DURATION_SECONDS: 180,
  MAX_MEDIA_BYTES: 20 * 1024 * 1024, // 20 MiB
  MAX_TOOL_PROPOSALS_PER_SLICE: 12,
  AUDIO_RETENTION_DAYS: 14,
  EXPORT_RETENTION_HOURS: 24,
  DOWNLOAD_TICKET_TTL_SECONDS: 15 * 60, // 15 minutes
} as const;
