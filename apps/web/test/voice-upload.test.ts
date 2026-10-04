/** @vitest-environment happy-dom */
/**
 * 010 voice upload adapter: capability-ordered MIME negotiation, honest
 * filename mapping, the confirmed Worker media transport and fail-closed
 * route gating. Transport tests use an injected fetch; no live network call.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VoiceMediaSummary } from '@otis/contracts';
import {
  configureVoiceUpload,
  createWorkerVoiceAdapter,
  createWorkerVoiceTransport,
  resetVoiceUploadForTests,
  uploadVoiceNote,
  voiceFilename,
  voiceRouteReady,
  VOICE_UPLOAD_TOKEN_HEADER,
  type VoiceUploadAdapter,
} from '../src/api/voice.js';
import { pickRecorderMime, RECORDER_MIME_CANDIDATES } from '../src/hooks/useVoiceRecorder.js';

afterEach(() => resetVoiceUploadForTests());

const media: VoiceMediaSummary = {
  media_id: 'med_abc123',
  workspace_id: 'ws',
  chat_id: 'chat',
  uploader_user_id: 'avi',
  state: 'validated',
  format: 'audio/webm',
  content_type: 'audio/webm',
  byte_size: 1024,
  duration_ms: 1000,
  created_at: new Date().toISOString(),
  expires_at: new Date().toISOString(),
  transcript: null,
  transcription: null,
};

describe('voice capability negotiation', () => {
  it('picks the first supported candidate in capability order', () => {
    expect(pickRecorderMime(mime => mime === 'audio/webm;codecs=opus')).toBe('audio/webm;codecs=opus');
    expect(pickRecorderMime(mime => mime === 'audio/mp4')).toBe('audio/mp4');
    expect(pickRecorderMime(mime => mime === 'audio/ogg;codecs=opus')).toBe('audio/ogg;codecs=opus');
  });

  it('returns null when no candidate is supported instead of renaming bytes', () => {
    expect(pickRecorderMime(() => false)).toBeNull();
  });

  it('tolerates a throwing capability probe', () => {
    const probes: string[] = [];
    const result = pickRecorderMime(mime => {
      probes.push(mime);
      if (mime === RECORDER_MIME_CANDIDATES[0]) throw new Error('probe failed');
      return mime === 'audio/webm';
    });
    expect(result).toBe('audio/webm');
    expect(probes).toHaveLength(2);
  });
});

describe('voice upload adapter seam', () => {
  it('is closed until a confirmed adapter is registered', () => {
    expect(voiceRouteReady()).toBe(false);
    const adapter: VoiceUploadAdapter = { upload: async () => ({ media }) };
    configureVoiceUpload(adapter);
    expect(voiceRouteReady()).toBe(true);
    configureVoiceUpload(null);
    expect(voiceRouteReady()).toBe(false);
  });

  it('rejects an upload result without a valid media identity', async () => {
    const adapter: VoiceUploadAdapter = {
      upload: async () => ({ media: { ...media, media_id: 'not-a-media-id' } }),
    };
    await expect(uploadVoiceNote(adapter, {
      workspaceId: 'ws',
      chatId: 'chat',
      clientMessageId: 'client-1',
      blob: new Blob(['a']),
      mimeType: 'audio/webm',
      durationMs: 1000,
      filename: 'voice.webm',
    })).rejects.toThrow('no media identity');
  });

  it('passes the stable client message identity through to the adapter', async () => {
    const upload = vi.fn().mockResolvedValue({ media });
    const adapter: VoiceUploadAdapter = { upload };
    const request = {
      workspaceId: 'ws',
      chatId: 'chat',
      clientMessageId: 'client-stable',
      blob: new Blob(['a']),
      mimeType: 'audio/mp4',
      durationMs: 2000,
      filename: 'voice.m4a',
    };
    await expect(uploadVoiceNote(adapter, request)).resolves.toEqual({ media });
    expect(upload).toHaveBeenCalledWith(request);
  });

  it('maps canonical containers to honest filename extensions', () => {
    const at = new Date(Date.UTC(2026, 9, 4, 12, 0, 0));
    expect(voiceFilename('audio/webm;codecs=opus', at)).toBe('voice-2026-10-04T12-00-00-000Z.webm');
    expect(voiceFilename('audio/mp4;codecs=mp4a.40.2', at)).toBe('voice-2026-10-04T12-00-00-000Z.m4a');
    expect(voiceFilename('audio/ogg;codecs=opus', at)).toBe('voice-2026-10-04T12-00-00-000Z.ogg');
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('worker voice transport (published routes)', () => {
  const request = {
    workspaceId: 'ws one',
    chatId: 'chat',
    clientMessageId: 'client-1',
    blob: new Blob(['aa'], { type: 'audio/webm;codecs=opus' }),
    mimeType: 'audio/webm;codecs=opus',
    durationMs: 1000,
    filename: 'voice.webm',
  };

  it('orchestrates claim, ticket PUT and finalize with canonical metadata', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      if (calls.length === 1) {
        return jsonResponse({
          status: 'ok',
          media,
          upload: {
            url: '/api/workspaces/ws%20one/media/uploads/med_abc123/content',
            token: 'ticket-token',
            expires_at: new Date().toISOString(),
          },
          limits: { max_bytes: 1024, max_duration_seconds: 180, formats: ['audio/webm'] },
        }, 201);
      }
      if (calls.length === 2) return jsonResponse({ status: 'ok', media: { ...media, state: 'quarantine' } });
      return jsonResponse({ status: 'ok', media: { ...media, state: 'validated' } });
    }) as typeof fetch;

    const adapter = createWorkerVoiceAdapter(createWorkerVoiceTransport(fetchImpl));
    const result = await adapter.upload(request);

    expect(result.media.media_id).toBe('med_abc123');
    expect(calls.map(call => [call.init.method, call.url])).toEqual([
      ['POST', '/api/workspaces/ws%20one/media/uploads'],
      ['PUT', '/api/workspaces/ws%20one/media/uploads/med_abc123/content'],
      ['POST', '/api/workspaces/ws%20one/media/uploads/med_abc123/finalize'],
    ]);
    const claim = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    expect(claim.content_type).toBe('audio/webm');
    expect(claim.client_message_id).toBe('client-1');
    expect(claim.byte_size).toBe(2);
    expect(claim.duration_ms).toBe(1000);
    const putHeaders = new Headers(calls[1]!.init.headers);
    expect(putHeaders.get(VOICE_UPLOAD_TOKEN_HEADER)).toBe('ticket-token');
    expect(putHeaders.get('x-otis-csrf')).toBe('1');
    expect(putHeaders.get('Content-Type')).toBe('audio/webm;codecs=opus');
    expect(calls[0]!.init.credentials).toBe('same-origin');
  });

  it('surfaces a server voice_unavailable rejection with its code', async () => {
    const fetchImpl = (async () => jsonResponse({
      error: { code: 'voice_unavailable', message: 'Voice is unavailable for this model.', request_id: 'req-1' },
    }, 422)) as typeof fetch;
    const adapter = createWorkerVoiceAdapter(createWorkerVoiceTransport(fetchImpl));
    await expect(adapter.upload(request)).rejects.toMatchObject({ status: 422, code: 'voice_unavailable' });
  });

  it('refuses an unsupported container before any claim is created', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse({ status: 'ok' });
    }) as typeof fetch;
    const adapter = createWorkerVoiceAdapter(createWorkerVoiceTransport(fetchImpl));
    await expect(adapter.upload({ ...request, mimeType: 'audio/wav' })).rejects.toThrow('Unsupported recording format');
    expect(calls).toHaveLength(0);
  });
});
