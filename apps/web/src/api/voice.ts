/**
 * Voice upload adapter (010 baseline).
 *
 * The web recorder owns local capture, Review and retry identity. Handing the
 * frozen bytes to the server sits behind this one adapter seam. The concrete
 * Worker routes are now published (apps/worker/src/media/routes.ts):
 *
 *   POST /api/workspaces/:workspaceId/media/uploads
 *   PUT  /api/workspaces/:workspaceId/media/uploads/:mediaId/content
 *   POST /api/workspaces/:workspaceId/media/uploads/:mediaId/finalize
 *   GET  /api/workspaces/:workspaceId/media/:mediaId/status
 *
 * The byte PUT carries the one-time scoped ticket in `x-otis-upload-token`;
 * every mutating call carries the CSRF header. No endpoint is guessed.
 *
 * `main.tsx` registers `createWorkerVoiceAdapter()` at startup. The mic still
 * appears only when the server reports an effective voice route for the
 * current model (`ModelOption.voice_available`); the exact-format route is
 * re-checked by the claim/finalize routes, and a 422 keeps the local
 * recording with the precise reason. The recording is attached through the
 * existing acceptance path (`CreateChatMessageRequest.media_id` + the same
 * stable `client_message_id`) carried by the scoped outbox, so local bytes
 * are deleted only after durable acceptance.
 *
 * Remaining backend dependency: the worker index must mount
 * `handleVoiceMediaRoute` before a handoff can complete.
 *
 * Contract source: `packages/contracts/src/voice.ts` (DTOs, bounds,
 * `normalizeVoiceFormat`, `isValidMediaId`). The stable `clientMessageId` is
 * generated once per recording and reused on every retry, so a retried
 * upload cannot become a second message.
 */

import {
  AUTH_BOUNDS,
  isValidMediaId,
  normalizeVoiceFormat,
  type CreateVoiceUploadRequest,
  type CreateVoiceUploadResponse,
  type FinalizeVoiceUploadResponse,
  type VoiceMediaStatusResponse,
  type VoiceMediaSummary,
} from '@otis/contracts';
import { ApiError, parseRetryAfterMs } from './client.js';

export const VOICE_UPLOAD_TOKEN_HEADER = 'x-otis-upload-token';

export interface VoiceUploadRequest {
  workspaceId: string;
  chatId: string;
  /** Stable message UUID generated once per recording; same on retry. */
  clientMessageId: string;
  blob: Blob;
  /** Negotiated MediaRecorder MIME (canonical container + codecs parameter). */
  mimeType: string;
  durationMs: number;
  filename: string;
}

export interface VoiceUploadResult {
  media: VoiceMediaSummary;
}

/**
 * One recording handoff. Implementations may create a claim, stream bytes and
 * finalize, but must resolve only after the server has a durable media
 * identity; a rejected or unconfirmed upload throws.
 */
export interface VoiceUploadAdapter {
  upload(request: VoiceUploadRequest): Promise<VoiceUploadResult>;
}

/** Server calls in the published order; injectable for tests. */
export interface VoiceTransport {
  createUpload(workspaceId: string, request: CreateVoiceUploadRequest): Promise<CreateVoiceUploadResponse>;
  /** PUTs to the server-supplied ticket URL, never a constructed public URL. */
  putBytes(ticketUrl: string, token: string, blob: Blob): Promise<VoiceMediaStatusResponse>;
  finalizeUpload(workspaceId: string, mediaId: string): Promise<FinalizeVoiceUploadResponse>;
  mediaStatus(workspaceId: string, mediaId: string): Promise<VoiceMediaStatusResponse>;
}

let activeAdapter: VoiceUploadAdapter | null = null;

/** Registers the confirmed production adapter, or null to fail closed. */
export function configureVoiceUpload(adapter: VoiceUploadAdapter | null): void {
  activeAdapter = adapter;
}

export function voiceUploadAdapter(): VoiceUploadAdapter | null {
  return activeAdapter;
}

/** True only when a real server handoff exists; gates the live mic action. */
export function voiceRouteReady(): boolean {
  return activeAdapter !== null;
}

async function voiceRequest<T>(
  path: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const method = init.method ?? 'GET';
  const headers = new Headers(init.headers);
  if (method !== 'GET') headers.set(AUTH_BOUNDS.CSRF_HEADER, '1');
  if (typeof init.body === 'string') headers.set('Content-Type', 'application/json');
  // A network failure (offline, DNS, aborted) keeps its transport error so
  // the recorder can offer the same-identity Retry; only HTTP answers map to
  // ApiError below.
  const response = await fetchImpl(path, { ...init, headers, credentials: 'same-origin' });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(response.status, 'service_unavailable', 'Otis is unavailable. Try again shortly.');
  }
  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string; request_id?: string } })?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'unknown_error',
      error?.message ?? `Request failed with HTTP ${response.status}`,
      error?.request_id,
      parseRetryAfterMs(response.headers.get('Retry-After')),
    );
  }
  return payload as T;
}

/** Worker transport against the published media routes. */
export function createWorkerVoiceTransport(fetchImpl: typeof fetch = fetch): VoiceTransport {
  return {
    createUpload: (workspaceId, request) =>
      voiceRequest<CreateVoiceUploadResponse>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/media/uploads`,
        { method: 'POST', body: JSON.stringify(request) },
        fetchImpl,
      ),
    putBytes: (ticketUrl, token, blob) =>
      voiceRequest<VoiceMediaStatusResponse>(
        ticketUrl,
        {
          method: 'PUT',
          body: blob,
          headers: {
            [VOICE_UPLOAD_TOKEN_HEADER]: token,
            'Content-Type': blob.type || 'application/octet-stream',
          },
        },
        fetchImpl,
      ),
    finalizeUpload: (workspaceId, mediaId) =>
      voiceRequest<FinalizeVoiceUploadResponse>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/media/uploads/${encodeURIComponent(mediaId)}/finalize`,
        { method: 'POST', body: JSON.stringify({}) },
        fetchImpl,
      ),
    mediaStatus: (workspaceId, mediaId) =>
      voiceRequest<VoiceMediaStatusResponse>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/media/${encodeURIComponent(mediaId)}/status`,
        {},
        fetchImpl,
      ),
  };
}

/**
 * Full adapter: claim, byte PUT, finalize. The recording is canonicalized to
 * its container format before the claim; bytes are never renamed.
 */
export function createWorkerVoiceAdapter(transport: VoiceTransport = createWorkerVoiceTransport()): VoiceUploadAdapter {
  return {
    upload: async request => {
      const format = normalizeVoiceFormat(request.mimeType);
      if (!format) throw new Error(`Unsupported recording format: ${request.mimeType}`);
      const created = await transport.createUpload(request.workspaceId, {
        chat_id: request.chatId,
        client_message_id: request.clientMessageId,
        content_type: format,
        byte_size: request.blob.size,
        duration_ms: request.durationMs,
        filename: request.filename,
      });
      if (!isValidMediaId(created.media.media_id)) {
        throw new Error('Voice upload claim returned no media identity.');
      }
      await transport.putBytes(created.upload.url, created.upload.token, request.blob);
      const finalized = await transport.finalizeUpload(request.workspaceId, created.media.media_id);
      return { media: finalized.media };
    },
  };
}

/** Runs one handoff and rejects a response without a valid media identity. */
export async function uploadVoiceNote(
  adapter: VoiceUploadAdapter,
  request: VoiceUploadRequest,
): Promise<VoiceUploadResult> {
  const result = await adapter.upload(request);
  if (!result || !result.media || !isValidMediaId(result.media.media_id)) {
    throw new Error('Voice upload returned no media identity.');
  }
  return result;
}

/** Plain filename matching the canonical container; never a renamed stream. */
export function voiceFilename(mimeType: string, at: Date = new Date()): string {
  const format = normalizeVoiceFormat(mimeType);
  const extension = format === 'audio/mp4' ? 'm4a' : format === 'audio/ogg' ? 'ogg' : 'webm';
  const stamp = at.toISOString().replace(/[:.]/g, '-');
  return `voice-${stamp}.${extension}`;
}

/** Test hook: forget the registered adapter between cases. */
export function resetVoiceUploadForTests(): void {
  activeAdapter = null;
}
