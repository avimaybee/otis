/**
 * @otis/contracts/voice
 * Voice/media DTOs for Gate 010: authenticated private upload, validated
 * recording metadata, transcription readiness and workspace STT settings.
 * Defined in docs/contracts.md sections 7 and 13 plus plans/010-groq-stt-handoff.md.
 *
 * The wire contract stays provider-neutral: no client-supplied provider URL,
 * key, or model. The server snapshots the route (native or Groq STT) at
 * message acceptance; clients only read status and stream bytes through the
 * authenticated Worker routes.
 */

import type { ProviderStatus } from './index.js';
import type { DtoValidation } from './chat.js';

/** The three required capture containers (Android WebM, iPhone MP4/AAC, Telegram OGG/Opus). */
export const VOICE_FORMATS = ['audio/webm', 'audio/mp4', 'audio/ogg'] as const;
export type VoiceFormat = (typeof VOICE_FORMATS)[number];

/** Approved Groq Whisper STT candidates; the default follows measured evidence. */
export const VOICE_STT_MODELS = ['whisper-large-v3-turbo', 'whisper-large-v3'] as const;
export type VoiceSttModel = (typeof VOICE_STT_MODELS)[number];
export const VOICE_STT_PROVIDER = 'groq' as const;

export const VOICE_BOUNDS = {
  /** Product cap: three minutes per note. */
  MAX_DURATION_SECONDS: 180,
  /** Existing 20 MiB domain bound or the lower verified channel/provider limit. */
  MAX_BYTES: 20 * 1024 * 1024,
  /** Reject trivially small payloads that cannot be a real recording. */
  MIN_BYTES: 256,
  /** Short-lived scoped upload ticket; membership is still rechecked per request. */
  UPLOAD_TTL_SECONDS: 15 * 60,
  MAX_FILENAME_CHARS: 120,
  /** Bounded transcription attempts before a visible failure (plan 010 retry bound). */
  MAX_TRANSCRIPTION_ATTEMPTS: 3,
} as const;

/** Existing media lifecycle states (docs/contracts.md section 3). */
export type VoiceMediaState =
  | 'quarantine'
  | 'validated'
  | 'transcribing'
  | 'ready'
  | 'rejected'
  | 'expired'
  | 'deleted';

export type VoiceTranscriptionState = 'pending' | 'running' | 'ready' | 'failed' | 'cancelled';

export type VoiceRouteKind = 'native' | 'groq_stt' | 'unavailable';

export interface VoiceTranscriptionSummary {
  state: VoiceTranscriptionState;
  /** Route snapshot taken at acceptance; 'unavailable' never reaches a job. */
  route: Exclude<VoiceRouteKind, 'unavailable'>;
  provider: typeof VOICE_STT_PROVIDER | null;
  model: string | null;
  /** Source language returned by the provider, when it returns one. */
  language: string | null;
  /** Bounded, sanitized failure code; never a raw upstream body. */
  error_code: string | null;
  error_message: string | null;
}

export interface VoiceMediaSummary {
  media_id: string;
  workspace_id: string;
  chat_id: string | null;
  uploader_user_id: string;
  state: VoiceMediaState;
  format: VoiceFormat | null;
  content_type: string | null;
  byte_size: number | null;
  duration_ms: number | null;
  created_at: string;
  /** Raw audio retention boundary (14 days from creation). */
  expires_at: string;
  /** Committed transcript text once ready; null while pending or failed. */
  transcript: string | null;
  transcription: VoiceTranscriptionSummary | null;
}

// --- Upload claim / bytes / finalize ---

export interface CreateVoiceUploadRequest {
  chat_id: string;
  /** Stable message UUID the recording will be attached to. */
  client_message_id: string;
  /** Negotiated MediaRecorder MIME or the channel MIME (e.g. audio/ogg for Telegram). */
  content_type: string;
  byte_size: number;
  /** Client-measured duration; the server validates actual bytes where parseable. */
  duration_ms: number;
  filename?: string;
}

export interface VoiceUploadTicket {
  /** Authenticated same-origin Worker URL; never a public R2 URL. */
  url: string;
  /** One-time scoped token for the byte PUT; still requires the session. */
  token: string;
  expires_at: string;
}

export interface CreateVoiceUploadResponse {
  status: 'ok';
  media: VoiceMediaSummary;
  upload: VoiceUploadTicket;
  limits: {
    max_bytes: number;
    max_duration_seconds: number;
    formats: VoiceFormat[];
  };
  /**
   * True when the workspace STT route is configured but this container has no
   * server-recorded verification yet: the upload may only be used as a
   * one-time format-verification sample, never as a business message.
   */
  verification_sample: boolean;
}

export interface FinalizeVoiceUploadResponse {
  status: 'ok';
  media: VoiceMediaSummary;
}

export interface VoiceMediaStatusResponse {
  status: 'ok';
  media: VoiceMediaSummary;
}

// --- Workspace STT configuration ---

export interface WorkspaceVoiceSettings {
  workspace_id: string;
  enabled: boolean;
  provider: typeof VOICE_STT_PROVIDER | null;
  model: VoiceSttModel | null;
  /** Formats actually tested by the workspace; the route resolver requires the exact format. */
  verified_formats: VoiceFormat[];
  /** True only when all three required formats are verified. */
  transcription_verified: boolean;
  /** Current Groq credential status; ciphertext and keys never cross this boundary. */
  credential_status: ProviderStatus | null;
}

export interface UpdateWorkspaceVoiceSettingsRequest {
  enabled?: boolean;
  model?: VoiceSttModel | null;
}

export interface VoiceSettingsResponse {
  status: 'ok';
  settings: WorkspaceVoiceSettings;
}

/**
 * Result of a server-side format verification: the server actually
 * transcribed a validated sample of this container with the workspace key
 * and recorded the evidence. Client-declared verification is never accepted.
 */
export interface VerifyVoiceFormatResponse {
  status: 'ok';
  verified_format: VoiceFormat;
  verified_formats: VoiceFormat[];
  transcription_verified: boolean;
  model: VoiceSttModel;
  sample_deleted: true;
}

// --- Request validation shared by routes and clients ---

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MEDIA_ID_PATTERN = /^med_[A-Za-z0-9_-]{1,96}$/;

export function isVoiceSttModel(value: unknown): value is VoiceSttModel {
  return typeof value === 'string' && (VOICE_STT_MODELS as readonly string[]).includes(value);
}

export function isValidMediaId(value: unknown): value is string {
  return typeof value === 'string' && MEDIA_ID_PATTERN.test(value);
}

/**
 * Normalizes a client MIME or extension to a canonical container format.
 * Parameters are preserved only by the recorder; the contract stores the
 * canonical container, never a renamed byte stream.
 */
export function normalizeVoiceFormat(mimeOrExt: string): VoiceFormat | null {
  const base = mimeOrExt.trim().toLowerCase().split(';')[0]?.trim() ?? '';
  if (base === 'audio/webm' || base.endsWith('.webm')) return 'audio/webm';
  if (base === 'audio/mp4' || base === 'audio/m4a' || base.endsWith('.mp4') || base.endsWith('.m4a')) return 'audio/mp4';
  if (base === 'audio/ogg' || base === 'audio/opus' || base.endsWith('.ogg') || base.endsWith('.oga') || base.endsWith('.opus')) return 'audio/ogg';
  return null;
}

function sanitizeFilename(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') return null;
  const basename = value.split(/[\\/]/).pop() ?? '';
  const trimmed = basename.trim().slice(0, VOICE_BOUNDS.MAX_FILENAME_CHARS);
  if (!trimmed || trimmed === '.' || trimmed === '..') return undefined;
  return trimmed;
}

export function validateCreateVoiceUploadRequest(value: unknown): DtoValidation<CreateVoiceUploadRequest> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, message: 'An upload request object is required.' };
  }
  const body = value as Record<string, unknown>;
  if (typeof body.chat_id !== 'string' || !ID_PATTERN.test(body.chat_id)) {
    return { valid: false, message: 'A valid chat_id is required.' };
  }
  if (typeof body.client_message_id !== 'string' || !ID_PATTERN.test(body.client_message_id)) {
    return { valid: false, message: 'A valid client_message_id is required.' };
  }
  if (typeof body.content_type !== 'string' || !normalizeVoiceFormat(body.content_type)) {
    return { valid: false, message: `content_type must be one of: ${VOICE_FORMATS.join(', ')}.` };
  }
  if (
    typeof body.byte_size !== 'number' ||
    !Number.isInteger(body.byte_size) ||
    body.byte_size < VOICE_BOUNDS.MIN_BYTES ||
    body.byte_size > VOICE_BOUNDS.MAX_BYTES
  ) {
    return {
      valid: false,
      message: `byte_size must be between ${VOICE_BOUNDS.MIN_BYTES} and ${VOICE_BOUNDS.MAX_BYTES} bytes.`,
    };
  }
  if (
    typeof body.duration_ms !== 'number' ||
    !Number.isInteger(body.duration_ms) ||
    body.duration_ms <= 0 ||
    body.duration_ms > VOICE_BOUNDS.MAX_DURATION_SECONDS * 1000
  ) {
    return {
      valid: false,
      message: `duration_ms must be between 1 and ${VOICE_BOUNDS.MAX_DURATION_SECONDS * 1000}.`,
    };
  }
  const filename = sanitizeFilename(body.filename);
  if (filename === null) return { valid: false, message: 'filename must be a plain string.' };
  const format = normalizeVoiceFormat(body.content_type)!;
  return {
    valid: true,
    value: {
      chat_id: body.chat_id,
      client_message_id: body.client_message_id,
      content_type: format,
      byte_size: body.byte_size,
      duration_ms: body.duration_ms,
      ...(filename ? { filename } : {}),
    },
  };
}

export function validateUpdateVoiceSettingsRequest(
  value: unknown,
): DtoValidation<UpdateWorkspaceVoiceSettingsRequest> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, message: 'A settings object is required.' };
  }
  const body = value as Record<string, unknown>;
  if (body.verified_formats !== undefined) {
    // Verification is server evidence from an actual transcription; a client
    // request can never grant route capability.
    return {
      valid: false,
      message: 'verified_formats is server-recorded evidence and cannot be set from a client.',
    };
  }
  const out: UpdateWorkspaceVoiceSettingsRequest = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return { valid: false, message: 'enabled must be a boolean.' };
    out.enabled = body.enabled;
  }
  if (body.model !== undefined) {
    if (body.model !== null && !isVoiceSttModel(body.model)) {
      return { valid: false, message: `model must be one of: ${VOICE_STT_MODELS.join(', ')}.` };
    }
    out.model = body.model as VoiceSttModel | null;
  }
  return { valid: true, value: out };
}
