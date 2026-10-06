/**
 * Still-image upload client (Slice 4).
 *
 * Mirrors the voice upload seam (`api/voice.ts`) against the same media
 * routes, but for prompt attachments: claim, byte PUT, finalize. The claim
 * response carries only the media identity plus the scoped ticket (no
 * duration, no transcription); the caller keeps the finalized media IDs and
 * submits them with the message (`CreateChatMessageRequest.image_media_ids`).
 *
 * Client metadata is validated up front (container allowlist, per-image and
 * per-message bounds from contracts), but the server re-verifies magic bytes
 * and bounds on PUT: a renamed file fails there with a precise 422.
 */

import {
  IMAGE_BOUNDS,
  IMAGE_FORMATS,
  isValidMediaId,
  normalizeImageFormat,
  type CreateImageUploadResponse,
  type FinalizeVoiceUploadResponse,
  type ImageFormat,
  type VoiceMediaStatusResponse,
} from '@otis/contracts';
import { ApiError, parseRetryAfterMs } from './client.js';
import { AUTH_BOUNDS } from '@otis/contracts';

export const IMAGE_UPLOAD_TOKEN_HEADER = 'x-otis-upload-token';

export interface ImageUploadRequest {
  workspaceId: string;
  chatId: string;
  /** Stable upload UUID generated once per file; same on retry. */
  clientMessageId: string;
  file: File;
}

export interface ImageUploadResult {
  mediaId: string;
  format: ImageFormat;
}

/** Server calls in the published order; injectable for tests and stories. */
export interface ImageTransport {
  createUpload(
    workspaceId: string,
    request: { chat_id: string; client_message_id: string; content_type: string; byte_size: number },
  ): Promise<CreateImageUploadResponse>;
  /** PUTs to the server-supplied ticket URL, never a constructed public URL. */
  putBytes(ticketUrl: string, token: string, file: File): Promise<VoiceMediaStatusResponse>;
  finalizeUpload(workspaceId: string, mediaId: string): Promise<FinalizeVoiceUploadResponse>;
}

const IMAGE_REQUEST_TIMEOUT_MS = 60_000;

async function imageRequest<T>(
  path: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set(AUTH_BOUNDS.CSRF_HEADER, '1');
  if (typeof init.body === 'string') headers.set('Content-Type', 'application/json');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new DOMException('Image request timed out', 'TimeoutError'));
  }, IMAGE_REQUEST_TIMEOUT_MS);
  const onAbort = (): void => {
    controller.abort(init.signal?.reason);
  };
  if (init.signal) {
    if (init.signal.aborted) {
      controller.abort(init.signal.reason);
    } else {
      init.signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  let response: Response;
  try {
    response = await fetchImpl(path, { ...init, headers, credentials: 'same-origin', signal: controller.signal });
  } catch (err) {
    clearTimeout(timeoutId);
    init.signal?.removeEventListener('abort', onAbort);
    throw err;
  }
  // The deadline stays armed through body consumption: a 5 MB object with a
  // stalled body must still time out instead of hanging the composer submit.
  let text: string;
  try {
    text = await response.text();
  } finally {
    clearTimeout(timeoutId);
    init.signal?.removeEventListener('abort', onAbort);
  }
  let payload: unknown = null;
  try {
    payload = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(response.status, 'service_unavailable', 'Otis is unavailable. Try again shortly.');
  }
  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string; request_id?: string; details?: unknown } })?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'unknown_error',
      error?.message ?? `Request failed with HTTP ${response.status}`,
      error?.request_id,
      parseRetryAfterMs(response.headers.get('Retry-After')),
      error?.details,
    );
  }
  return payload as T;
}

/** Worker transport against the published media routes. */
export function createWorkerImageTransport(fetchImpl: typeof fetch = fetch): ImageTransport {
  return {
    createUpload: (workspaceId, request) =>
      imageRequest<CreateImageUploadResponse>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/media/uploads`,
        { method: 'POST', body: JSON.stringify(request) },
        fetchImpl,
      ),
    putBytes: (ticketUrl, token, file) =>
      imageRequest<VoiceMediaStatusResponse>(
        ticketUrl,
        {
          method: 'PUT',
          body: file,
          headers: {
            [IMAGE_UPLOAD_TOKEN_HEADER]: token,
            'Content-Type': file.type || 'application/octet-stream',
          },
        },
        fetchImpl,
      ),
    finalizeUpload: (workspaceId, mediaId) =>
      imageRequest<FinalizeVoiceUploadResponse>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/media/uploads/${encodeURIComponent(mediaId)}/finalize`,
        { method: 'POST', body: JSON.stringify({}) },
        fetchImpl,
      ),
  };
}

/** Client-side file gate: format allowlist plus product size bounds. */
export function validateImageFile(file: File): { valid: true; format: ImageFormat } | { valid: false; message: string } {
  const format = normalizeImageFormat(file.type || file.name);
  if (!format) {
    return { valid: false, message: `Only ${IMAGE_FORMATS.join(', ')} images can be attached.` };
  }
  if (file.size < IMAGE_BOUNDS.MIN_BYTES || file.size > IMAGE_BOUNDS.MAX_BYTES) {
    return {
      valid: false,
      message: `Images must be between ${Math.ceil(IMAGE_BOUNDS.MIN_BYTES / 1024)} KB and ${Math.floor(IMAGE_BOUNDS.MAX_BYTES / 1024 / 1024)} MB.`,
    };
  }
  return { valid: true, format };
}

/**
 * Full handoff for one file: claim, byte PUT, finalize. Resolves only with
 * a valid server media identity; any rejection throws with the server's
 * precise reason so the composer can keep the file for retry. Like voice, a
 * retry after a lost finalize meets a finalized claim (409) carrying the
 * media identity and finalizes directly instead of looping the conflict.
 */
export async function uploadImageFile(
  transport: ImageTransport,
  request: ImageUploadRequest,
): Promise<ImageUploadResult> {
  const gate = validateImageFile(request.file);
  if (!gate.valid) throw new Error(gate.message);
  let created: CreateImageUploadResponse;
  try {
    created = await transport.createUpload(request.workspaceId, {
      chat_id: request.chatId,
      client_message_id: request.clientMessageId,
      content_type: gate.format,
      byte_size: request.file.size,
    });
  } catch (err) {
    const mediaId =
      err instanceof ApiError && err.status === 409 && err.code === 'upload_already_finalized'
        ? (err.details as { media_id?: unknown } | undefined)?.media_id
        : undefined;
    if (typeof mediaId !== 'string' || !isValidMediaId(mediaId)) throw err;
    await transport.finalizeUpload(request.workspaceId, mediaId);
    return { mediaId, format: gate.format };
  }
  if (!isValidMediaId(created.media_id)) {
    throw new Error('Image upload claim returned no media identity.');
  }
  await transport.putBytes(created.upload.url, created.upload.token, request.file);
  await transport.finalizeUpload(request.workspaceId, created.media_id);
  return { mediaId: created.media_id, format: gate.format };
}
