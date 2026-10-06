/**
 * @otis/contracts/media
 * Shared image-attachment contract: verified container formats, size/count
 * bounds, and snapshot validation. Voice recording contracts stay in
 * voice.ts; this module covers still images attached to prompts only.
 * Clients never choose providers or endpoints; the server snapshots the
 * model and its verified capabilities at acceptance.
 */

import type { VoiceFormat } from './voice.js';

/** Image containers the server verifies from magic bytes, never extensions. */
export const IMAGE_FORMATS = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];

/** Either durable media kind stored in media_objects. */
export type MediaFormat = VoiceFormat | ImageFormat;

export const IMAGE_BOUNDS = {
  /** Product cap: 5 MiB per image. */
  MAX_BYTES: 5 * 1024 * 1024,
  /** Reject trivially small payloads that cannot be a real image. */
  MIN_BYTES: 128,
  /** Product cap: attached images per message. */
  MAX_PER_MESSAGE: 4,
} as const;

import type { DtoValidation } from './chat.js';

/** Canonical image container from a client MIME or filename; never trusts extensions alone. */
export function normalizeImageFormat(mimeOrExt: string): ImageFormat | null {
  const base = mimeOrExt.trim().toLowerCase().split(';')[0]?.trim() ?? '';
  if (base === 'image/jpeg' || base === 'image/jpg' || base.endsWith('.jpg') || base.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (base === 'image/png' || base.endsWith('.png')) return 'image/png';
  if (base === 'image/webp' || base.endsWith('.webp')) return 'image/webp';
  return null;
}

export function isImageFormat(value: unknown): value is ImageFormat {
  return typeof value === 'string' && (IMAGE_FORMATS as readonly string[]).includes(value);
}

export interface CreateImageUploadRequest {
  chat_id: string;
  /** Stable message UUID the image will be attached to. */
  client_message_id: string;
  /** Client-declared MIME; the server verifies magic bytes on PUT. */
  content_type: ImageFormat;
  byte_size: number;
  filename?: string;
}

export interface CreateImageUploadResponse {
  status: 'ok';
  media_id: string;
  upload: {
    /** Authenticated same-origin Worker URL; never a public R2 URL. */
    url: string;
    token: string;
    expires_at: string;
  };
  limits: {
    max_bytes: number;
    formats: ImageFormat[];
  };
}

const IMAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function sanitizeImageFilename(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') return null;
  const basename = value.split(/[\\/]/).pop() ?? '';
  const trimmed = basename.trim().slice(0, 120);
  if (!trimmed || trimmed === '.' || trimmed === '..') return undefined;
  return trimmed;
}

export function validateCreateImageUploadRequest(value: unknown): DtoValidation<CreateImageUploadRequest> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, message: 'An upload request object is required.' };
  }
  const body = value as Record<string, unknown>;
  if (typeof body.chat_id !== 'string' || !IMAGE_ID_PATTERN.test(body.chat_id)) {
    return { valid: false, message: 'A valid chat_id is required.' };
  }
  if (typeof body.client_message_id !== 'string' || !IMAGE_ID_PATTERN.test(body.client_message_id)) {
    return { valid: false, message: 'A valid client_message_id is required.' };
  }
  if (typeof body.content_type !== 'string' || !normalizeImageFormat(body.content_type)) {
    return { valid: false, message: `content_type must be one of: ${IMAGE_FORMATS.join(', ')}.` };
  }
  if (
    typeof body.byte_size !== 'number' ||
    !Number.isInteger(body.byte_size) ||
    body.byte_size < IMAGE_BOUNDS.MIN_BYTES ||
    body.byte_size > IMAGE_BOUNDS.MAX_BYTES
  ) {
    return {
      valid: false,
      message: `byte_size must be between ${IMAGE_BOUNDS.MIN_BYTES} and ${IMAGE_BOUNDS.MAX_BYTES} bytes.`,
    };
  }
  const filename = sanitizeImageFilename(body.filename);
  if (filename === null) return { valid: false, message: 'filename must be a plain string.' };
  const format = normalizeImageFormat(body.content_type)!;
  return {
    valid: true,
    value: {
      chat_id: body.chat_id,
      client_message_id: body.client_message_id,
      content_type: format,
      byte_size: body.byte_size,
      ...(filename ? { filename } : {}),
    },
  };
}
