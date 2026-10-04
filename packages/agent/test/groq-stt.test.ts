import { describe, expect, it } from 'vitest';
import { getEventListeners } from 'node:events';
import {
  GROQ_STT_DEFAULT_MODEL,
  GROQ_STT_ENDPOINT,
  buildSyntheticProbeWav,
  createRegistry,
  isConversationProvider,
  listAvailableModels,
  probeGroqCredential,
  resolveCommandKey,
  transcribeWithGroq,
  type FetchFn,
  type ModelEntry,
} from '../src/index.js';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const bytes = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0]);

describe('Groq STT transport', () => {
  it('posts multipart to the fixed endpoint with auth and no manual boundary', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    const fetchFn: FetchFn = async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return jsonResponse({ text: 'Salut, sună-mă mâine la 10.', language: 'ro', duration: 2.5 });
    };
    const result = await transcribeWithGroq({
      apiKey: 'gsk_unit_test_key',
      model: GROQ_STT_DEFAULT_MODEL,
      bytes,
      filename: 'voice-1.ogg',
      mimeType: 'audio/ogg',
      language: 'ro',
      vocabularyHint: 'Kerning',
      fetchFn,
    });
    expect(result).toEqual({ ok: true, text: 'Salut, sună-mă mâine la 10.', language: 'ro', durationSeconds: 2.5 });
    expect(seenUrl).toBe(GROQ_STT_ENDPOINT);
    expect(seenInit?.method).toBe('POST');
    const headers = new Headers(seenInit?.headers);
    expect(headers.get('authorization')).toBe('Bearer gsk_unit_test_key');
    expect(headers.get('content-type')).toBeNull(); // FormData sets its own boundary
    const form = seenInit?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('model')).toBe(GROQ_STT_DEFAULT_MODEL);
    expect(form.get('temperature')).toBe('0');
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.get('language')).toBe('ro');
    expect(form.get('prompt')).toBe('Kerning');
    const file = form.get('file') as File;
    expect(file.name).toBe('voice-1.ogg');
    expect(file.type).toBe('audio/ogg');
  });

  it('maps auth, rate, format, server and malformed responses without leaking bodies', async () => {
    const cases: Array<{ status: number; code: string; retryable: boolean; headers?: Record<string, string> }> = [
      { status: 401, code: 'invalid_credential', retryable: false },
      { status: 403, code: 'invalid_credential', retryable: false },
      { status: 429, code: 'rate_limited', retryable: true, headers: { 'retry-after': '7' } },
      { status: 400, code: 'invalid_request', retryable: false },
      { status: 500, code: 'transient', retryable: true },
    ];
    for (const testCase of cases) {
      const result = await transcribeWithGroq({
        apiKey: 'gsk_unit_test_key',
        model: GROQ_STT_DEFAULT_MODEL,
        bytes,
        filename: 'voice-1.webm',
        mimeType: 'audio/webm',
        fetchFn: async () => jsonResponse({ error: { message: 'upstream detail' } }, testCase.status, testCase.headers ?? {}),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(testCase.code);
        expect(result.retryable).toBe(testCase.retryable);
        expect(result.message).not.toContain('gsk_unit_test_key');
        expect(result.message).not.toContain('upstream detail');
        if (testCase.status === 429) expect(result.retryAfterMs).toBe(7000);
      }
    }

    const malformed = await transcribeWithGroq({
      apiKey: 'gsk_unit_test_key',
      model: GROQ_STT_DEFAULT_MODEL,
      bytes,
      filename: 'voice-1.webm',
      mimeType: 'audio/webm',
      fetchFn: async () => new Response('not json', { status: 200 }),
    });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.code).toBe('malformed_response');

    const missingText = await transcribeWithGroq({
      apiKey: 'gsk_unit_test_key',
      model: GROQ_STT_DEFAULT_MODEL,
      bytes,
      filename: 'voice-1.webm',
      mimeType: 'audio/webm',
      fetchFn: async () => jsonResponse({ language: 'ro' }),
    });
    expect(missingText.ok).toBe(false);
  });

  it('reports timeouts as retryable and preserves an empty transcript as empty text', async () => {
    const aborted: FetchFn = async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    };
    const timeout = await transcribeWithGroq({
      apiKey: 'gsk_unit_test_key',
      model: GROQ_STT_DEFAULT_MODEL,
      bytes,
      filename: 'voice-1.webm',
      mimeType: 'audio/webm',
      fetchFn: aborted,
    });
    expect(timeout.ok).toBe(false);
    if (!timeout.ok) {
      expect(timeout.code).toBe('timeout');
      expect(timeout.retryable).toBe(true);
    }

    const empty = await transcribeWithGroq({
      apiKey: 'gsk_unit_test_key',
      model: GROQ_STT_DEFAULT_MODEL,
      bytes,
      filename: 'voice-1.webm',
      mimeType: 'audio/webm',
      fetchFn: async () => jsonResponse({ text: '' }),
    });
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.text).toBe('');
  });

  it('keeps the deadline armed through response body consumption', async () => {
    // Headers arrive, then the body stalls forever. Without a live deadline
    // through response.json() this would hold the job open indefinitely.
    const stalled: FetchFn = async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init.signal?.addEventListener(
              'abort',
              () => controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })),
              { once: true },
            );
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    const result = await transcribeWithGroq({
      apiKey: 'gsk_unit_test_key',
      model: GROQ_STT_DEFAULT_MODEL,
      bytes,
      filename: 'voice-1.webm',
      mimeType: 'audio/webm',
      fetchFn: stalled,
      timeoutMs: 50,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('timeout');
      expect(result.retryable).toBe(true);
      expect(result.status).toBe(200);
    }
  });

  it('bounds a fake response whose json() stalls, with no key or body leak', async () => {
    const upstreamBody = 'UPSTREAM_BODY_SENTINEL';
    const stalledResponse = {
      status: 200,
      headers: new Headers(),
      // A json() that never settles and ignores the transport signal: the
      // transport must still bound the read by its own deadline.
      json: () => new Promise(() => undefined),
      text: async () => upstreamBody,
    } as unknown as Response;
    const result = await transcribeWithGroq({
      apiKey: 'gsk_unit_test_key',
      model: GROQ_STT_DEFAULT_MODEL,
      bytes,
      filename: 'voice-1.webm',
      mimeType: 'audio/webm',
      fetchFn: async () => stalledResponse,
      timeoutMs: 50,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('timeout');
      expect(result.retryable).toBe(true);
    }
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('gsk_unit_test_key');
    expect(serialized).not.toContain(upstreamBody);
  });

  it('maps a caller abort without retry and removes its listener', async () => {
    const controller = new AbortController();
    const hanging: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        const fail = () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (init.signal?.aborted) fail();
        else init.signal?.addEventListener('abort', fail, { once: true });
      });
    const pending = transcribeWithGroq({
      apiKey: 'gsk_unit_test_key',
      model: GROQ_STT_DEFAULT_MODEL,
      bytes,
      filename: 'voice-1.webm',
      mimeType: 'audio/webm',
      fetchFn: hanging,
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('aborted');
      expect(result.retryable).toBe(false);
    }
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('builds a valid bounded WAV probe and verifies credentials with one real request', async () => {    const wav = buildSyntheticProbeWav();
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe('WAVE');
    expect(wav.byteLength).toBeLessThan(64 * 1024);

    let calls = 0;
    const result = await probeGroqCredential(async (url, init) => {
      calls += 1;
      expect(url).toBe(GROQ_STT_ENDPOINT);
      const form = init.body as FormData;
      const file = form.get('file') as File;
      expect(file.name).toBe('otis-credential-probe.wav');
      expect(file.type).toBe('audio/wav');
      return jsonResponse({ text: '' });
    }, 'gsk_unit_test_key');
    expect(result).toEqual({ ok: true, status: 200 });
    expect(calls).toBe(1);

    const rejected = await probeGroqCredential(async () => jsonResponse({}, 401), 'gsk_unit_test_key');
    expect(rejected).toEqual({ ok: false, status: 401 });
  });

  it('keeps the STT-only provider out of conversation model selection and run pinning', () => {
    const groqEntry: ModelEntry = {
      commandKey: 'groq-whisper',
      displayName: 'Groq Whisper',
      provider: 'groq',
      modelId: 'whisper-large-v3-turbo',
      endpointFamily: 'go-chat-completions',
      endpointUrl: GROQ_STT_ENDPOINT,
      approved: true,
      lifecycle: 'active',
      capabilities: {
        text: 'supported',
        tools: 'supported',
        stream: 'supported',
        thoughtSummary: 'unverified',
        audio: 'unverified',
      },
      trainingUse: 'test only',
      dataRetention: 'test only',
      evidenceRef: null,
      verifiedAt: null,
    };
    const registry = createRegistry([groqEntry]);
    expect(isConversationProvider('groq')).toBe(false);
    expect(isConversationProvider('opencode_go')).toBe(true);
    expect(() => resolveCommandKey(registry, 'groq-whisper', { credentialStatus: 'available' })).toThrow(
      /not a conversation model/,
    );
    expect(listAvailableModels(registry, { groq: 'available' })).toHaveLength(0);
  });
});
