/**
 * @otis/contracts/chat
 * Runtime DTOs for the chat API: transcript reads, activity streaming,
 * run status, action inspection, undo, clarification replies, and the shared
 * slash-command surface. Defined in docs/contracts.md section 7-9.
 */

import type {
  AgentRun,
  ChatMessage,
  ClarificationStatus,
  LedgerEventKind,
  PendingClarification,
  PublicActivity,
  RunStatus,
  StepStatus,
  UndoMode,
  UndoPreview,
  CreateChatMessageRequest,
} from './index.js';
import { DOMAIN_BOUNDS } from './index.js';
import { isValidMediaId } from './voice.js';
import { IMAGE_BOUNDS } from './media.js';

export type DtoValidation<T> = { valid: true; value: T } | { valid: false; message: string };
/** Runtime request boundary shared by ordinary messages and command shortcuts. */
export function validateChatMessageRequest(value: unknown): DtoValidation<CreateChatMessageRequest> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false, message: 'A message object is required.' };
  const body = value as Record<string, unknown>;
  const id = body.client_message_id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return { valid: false, message: 'A valid client_message_id is required.' };
  const mediaId = body.media_id;
  if (mediaId !== undefined && mediaId !== null && !isValidMediaId(mediaId)) return { valid: false, message: 'Invalid media_id.' };
  const hasMedia = typeof mediaId === 'string';
  const rawImageIds = body.image_media_ids;
  let imageMediaIds: string[] = [];
  if (rawImageIds !== undefined && rawImageIds !== null) {
    if (!Array.isArray(rawImageIds)) return { valid: false, message: 'image_media_ids must be an array of media IDs.' };
    if (rawImageIds.length > IMAGE_BOUNDS.MAX_PER_MESSAGE) {
      return { valid: false, message: `At most ${IMAGE_BOUNDS.MAX_PER_MESSAGE} images may be attached to a message.` };
    }
    for (const id of rawImageIds) {
      if (!isValidMediaId(id)) return { valid: false, message: 'Invalid image media ID.' };
    }
    imageMediaIds = [...new Set(rawImageIds as string[])];
  }
  const hasImages = imageMediaIds.length > 0;
  const text = body.text;
  if (text !== undefined) {
    if (typeof text !== 'string' || text.length > DOMAIN_BOUNDS.MAX_INPUT_CHARS) {
      return { valid: false, message: `Text must contain 1–${DOMAIN_BOUNDS.MAX_INPUT_CHARS} characters.` };
    }
    if (!hasMedia && !hasImages && !text.trim()) return { valid: false, message: `Text must contain 1–${DOMAIN_BOUNDS.MAX_INPUT_CHARS} characters.` };
  } else if (!hasMedia && !hasImages) {
    return { valid: false, message: `Text must contain 1–${DOMAIN_BOUNDS.MAX_INPUT_CHARS} characters.` };
  }
  if (body.clarification_id !== undefined && (typeof body.clarification_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.clarification_id))) return { valid: false, message: 'Invalid clarification_id.' };
  return {
    valid: true,
    value: {
      client_message_id: id,
      ...(typeof text === 'string' ? { text } : {}),
      ...(hasMedia ? { media_id: mediaId as string } : {}),
      ...(hasImages ? { image_media_ids: imageMediaIds } : {}),
      ...(body.clarification_id ? { clarification_id: body.clarification_id as string } : {}),
    },
  };
}

// --- Transcript & chat reads ---

export interface ChatDetailResponse {
  chat: {
    id: string;
    workspace_id: string;
    author_user_id: string;
    author_display_name?: string | null;
    title: string;
    model_override: string | null;
    thinking_override?: { model_key: string; choice_id: string } | null;
    is_archived: boolean;
    last_activity_at: string;
    created_at: string;
  };
  /** True when the caller authored this chat and may therefore append to it. */
  is_author: boolean;
}

export interface MessageListResponse {
  chat_id: string;
  messages: ChatMessage[];
  /** Exclusive upper bound to pass back as `before_sequence` for older pages. */
  next_before_sequence: number | null;
}

export interface SendMessageResponse {
  status: 'accepted';
  message_id: string;
  run_id: string;
  acceptance_sequence: number;
  /** Echo of the durable id used for retries; identical payloads are idempotent. */
  client_message_id: string;
}

// --- Activity stream & catch-up ---

export interface ActivityPageResponse {
  chat_id: string;
  activities: PublicActivity[];
  /** Highest cursor present in this page; pass back as `after` to resume. */
  next_cursor: number;
  /** Current chat activity cursor, so a quiet chat is distinguishable from a gap. */
  latest_cursor: number;
}

export type ActivityStreamMode = 'json' | 'sse';

export type StreamEventName =
  | 'activity'
  | 'resync_required'
  | 'membership_revoked'
  | 'heartbeat';

/** Persisted activity rows plus the cursors a client needs to resume. */
export interface ActivityReadResult {
  activities: PublicActivity[];
  /** Highest cursor the client has applied after reading this page. */
  nextCursor: number;
  /** Current chat activity cursor, so a quiet chat differs from a gap. */
  latestCursor: number;
}

export const ACTIVITY_BOUNDS = {
  /** Maximum rows returned by one JSON catch-up page. */
  MAX_CATCHUP_PAGE: 200,
  /** Heartbeat cadence for an open SSE stream. Carries no business meaning. */
  HEARTBEAT_MS: 15_000,
  /** Hard upper bound on a single long-lived stream before the client reconnects. */
  MAX_STREAM_MS: 5 * 60_000,
  /** Poll interval used while a stream waits for new rows. */
  POLL_INTERVAL_MS: 500,
} as const;

export const STEERING_BOUNDS = { MAX_MESSAGES_PER_RUN: 32, MAX_CHARS_PER_RUN: 64_000 } as const;

// --- Run status ---

export interface RunStepSummary {
  step_index: number;
  tool_name: string;
  status: StepStatus;
  action_id: string | null;
  /** Decoded tool result, already normalized at the owner boundary. */
  result: unknown;
  created_at: string;
  updated_at: string;
}

export interface RunActionSummary {
  action_id: string;
  command_name: string;
  result_status: string;
  committed_revision: number;
  summary: string | null;
  created_at: string;
}

export interface RunDetailResponse {
  run: AgentRun;
  steps: RunStepSummary[];
  actions: RunActionSummary[];
  activities: PublicActivity[];
  pending_clarification: PendingClarification | null;
  /** Authoritative conversation status the UI may render directly. */
  status: RunStatus;
  sources?: MemorySourceReference[];
}

export interface MemorySourceReference { memory_id: string; label: string; provenance: 'stated' | 'inferred'; }

/**
 * Batched run-detail page: the same RunDetailResponse shapes as the
 * single-run route, in request order, omitting unknown ids. One HTTP
 * roundtrip replaces the per-run N+1 on snapshot and older-page loads.
 */
export interface RunBatchResponse {
  runs: RunDetailResponse[];
}export interface MemorySourceResponse {
  memory: { id: string; content: string; provenance: 'stated' | 'inferred'; status: string; observed_at: string };
  source: { chat_id: string | null; author_name: string | null; text: string | null; created_at: string; channel: string } | null;
}

// --- Action detail, undo preview and undo commit ---

export interface ActionEventSummary {
  id: string;
  kind: LedgerEventKind;
  sequence: number;
  occurred_at: string;
  entity_id: string | null;
  payload: unknown;
  reverted: boolean;
}

export interface ActionDetailResponse {
  action: {
    action_id: string;
    workspace_id: string;
    command_name: string;
    result_status: string;
    summary: string | null;
    committed_revision: number;
    actor_kind: 'member' | 'system';
    actor_user_id: string | null;
    source_message_id: string | null;
    run_id: string | null;
    step_id: string | null;
    created_at: string;
    events: ActionEventSummary[];
    undo: {
      /** False once the selected action's events are all reverted. */
      available: boolean;
      reverted_event_ids: string[];
      reverted_by_event_ids: string[];
    };
    source: {
      id: string;
      channel: string;
      created_at: string;
      text_preview: string | null;
    } | null;
  };
}

export interface UndoPreviewRequest {
  mode?: UndoMode;
}

export interface UndoPreviewResponse {
  preview: UndoPreview;
}

export interface UndoCommitRequest {
  mode?: UndoMode;
  client_operation_id: string;
  /** Preview revision that must still hold when the commit is attempted. */
  expected_revision: number;
}

export interface UndoCommitResponse {
  status: 'applied' | 'already_applied' | 'needs_clarification' | 'rejected' | 'conflict';
  action_id: string;
  /** Ledger action ID of the undo itself, stable across retries. */
  undo_action_id: string;
  affected_action_ids: string[];
  revert_event_ids: string[];
  committed_revision: number | null;
  summary: string;
  /** Present when a dependency needs an ordinary-language answer first. */
  dependencies?: { action_id: string; reason: string }[];
  error?: { code: string; message: string };
}

// --- Clarifications ---

export interface ClarificationSummary {
  id: string;
  chat_id: string;
  run_id: string | null;
  question: string;
  intended_operation: string;
  missing_fields: string[];
  candidates: string[] | null;
  status: ClarificationStatus;
  created_at: string;
  /** True when the caller is the member who may answer it. */
  answerable_by_caller: boolean;
}

export interface ClarificationListResponse {
  clarifications: ClarificationSummary[];
}

export interface ClarificationReplyRequest {
  /** Ordinary reply text; the same wording a normal composer message would send. */
  text: string;
  client_message_id: string;
  /** Optional structured answer for choice-style questions. */
  resolved_fields?: Record<string, string>;
}

export interface ClarificationReplyResponse {
  status: 'resumed';
  clarification_id: string;
  message_id: string;
  run_id: string;
}

// --- Shared slash-command surface ---

export type CommandSurface = 'web' | 'telegram';

export interface CommandDescriptor {
  name: string;
  summary: string;
  usage: string;
  /** False for commands that are parsed but not yet executable on this surface. */
  available: boolean;
  /** True when the command is answered by the server without a model run. */
  deterministic: boolean;
}

export interface CommandRegistryResponse {
  surface: CommandSurface;
  commands: CommandDescriptor[];
}

export interface ThinkingChoiceDTO {
  id: string;
  label: string;
}

export interface ThinkingOptionDTO {
  current_choice_id: string | null;
  effective_choice_id: string | null;
  is_default: boolean;
  state: 'supported' | 'unsupported' | 'unverified';
  choices: ThinkingChoiceDTO[];
  unavailability_reason?: string | null;
}

export interface ModelOption {
  command_key: string;
  display_name: string;
  provider: string;
  native_audio_supported: boolean;
  voice_available: boolean;
  available: boolean;
  is_current: boolean;
  is_default: boolean;
  thinking?: ThinkingOptionDTO;
}

export interface ModelListResponse {
  models: ModelOption[];
  current_command_key: string | null;
  default_command_key: string | null;
  /** Explains why nothing is selectable; absent when at least one entry is available. */
  unavailable_reason?: string;
}

// --- Errors shared by chat routes ---

export interface PartialFailurePayload {
  status: 'partial';
  run_id: string;
  /** Action IDs that actually committed, receipt-backed. */
  applied_action_ids: string[];
  /** Human-readable explanation persisted with the run. */
  explanation: string;
  retryable: boolean;
}
