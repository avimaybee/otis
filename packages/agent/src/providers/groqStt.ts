/**
 * @otis/agent/providers/groqStt
 * Fixed-endpoint Groq Whisper transcription transport for Gate 010.
 *
 * Server-side only: the raw workspace key is injected by the Worker credential
 * boundary and never appears in events, results, logs, or errors. The origin
 * and path are constants; callers cannot supply a provider URL, model list, or
 * arbitrary remote fetch. This is transcription, not translation.
 *
 * Official reference: https://console.groq.com/docs/speech-to-text
 */

import { parseRetryAfterMs, receiverSafeFetch, type FetchFn } from './types.js';

/** Fixed Groq origin; the only STT destination Otis dials. */
export const GROQ_STT_ORIGIN = 'https://api.groq.com';
export const GROQ_STT_ENDPOINT = `${GROQ_STT_ORIGIN}/openai/v1/audio/transcriptions`;

/** Approved STT candidates; the production default follows measured evidence. */
export const GROQ_STT_MODELS = ['whisper-large-v3-turbo', 'whisper-large-v3'] as const;
export type GroqSttModel = (typeof GROQ_STT_MODELS)[number];
export const GROQ_STT_DEFAULT_MODEL: GroqSttModel = 'whisper-large-v3-turbo';

export const GROQ_STT_TIMEOUT_MS = 60_000;
/** Probe uses one short synthetic tone; still a real inference request. */
export const GROQ_STT_PROBE_TIMEOUT_MS = 30_000;

export interface GroqTranscriptionSuccess {
  ok: true;
  text: string;
  language: string | null;
  durationSeconds: number | null;
}

export type GroqTranscriptionErrorCode =
  | 'invalid_credential'
  | 'rate_limited'
  | 'invalid_request'
  | 'timeout'
  | 'aborted'
  | 'transient'
  | 'malformed_response';

export interface GroqTranscriptionFailure {
  ok: false;
  code: GroqTranscriptionErrorCode;
  status: number | null;
  retryable: boolean;
  retryAfterMs: number | null;
  /** Sanitized: status class only, never an upstream body or key-bearing detail. */
  message: string;
}

export type GroqTranscriptionResult = GroqTranscriptionSuccess | GroqTranscriptionFailure;

export interface GroqTranscriptionParams {
  apiKey: string;
  model: GroqSttModel;
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
  /** Optional language hint; only set when the member reliably specified one. */
  language?: string;
  /** Short approved vocabulary hint for names; never full business history. */
  vocabularyHint?: string;
  fetchFn: FetchFn;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function failure(
  code: GroqTranscriptionErrorCode,
  status: number | null,
  message: string,
  options?: { retryable?: boolean; retryAfterMs?: number | null },
): GroqTranscriptionFailure {
  return {
    ok: false,
    code,
    status,
    retryable: options?.retryable ?? false,
    retryAfterMs: options?.retryAfterMs ?? null,
    message,
  };
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

function abortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Bounds a body read by the transport abort signal even when the platform
 * response is not itself tied to the signal (for example a stalled `json()`
 * on an injected transport). The losing promise is always handled, so no
 * unhandled rejection escapes after the race settles.
 */
function abortRace<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Sends validated private bytes as multipart to the fixed transcription
 * endpoint. The multipart boundary is set by FormData; never manually.
 * Response bodies are parsed for the transcript fields only and are never
 * logged or returned as raw text.
 *
 * The deadline covers the whole request, including response body consumption:
 * a provider that sends headers and then stalls the body is aborted at the
 * timeout instead of holding the job open indefinitely. The caller-abort
 * listener is always removed in `finally`.
 */
export async function transcribeWithGroq(
  params: GroqTranscriptionParams,
): Promise<GroqTranscriptionResult> {
  const timeoutMs = params.timeoutMs ?? GROQ_STT_TIMEOUT_MS;
  const safeFetch = receiverSafeFetch(params.fetchFn);
  const form = new FormData();
  const filePayload = typeof File !== 'undefined'
    ? new File([copyBytes(params.bytes)], params.filename, { type: params.mimeType })
    : new Blob([copyBytes(params.bytes)], { type: params.mimeType });
  form.append('file', filePayload, params.filename);
  form.append('model', params.model);
  form.append('temperature', '0');
  form.append('response_format', 'verbose_json');
  if (params.language) form.append('language', params.language);
  if (params.vocabularyHint) form.append('prompt', params.vocabularyHint.slice(0, 512));

  const controller = new AbortController();
  const callerSignal = params.signal;
  const onCallerAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortCode = (): 'aborted' | 'timeout' => (callerSignal?.aborted ? 'aborted' : 'timeout');

  try {
    let response: Response;
    try {
      response = await safeFetch(GROQ_STT_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${params.apiKey}` },
        body: form,
        signal: controller.signal,
      });
    } catch (err) {
      if (isAbortError(err)) {
        return abortCode() === 'aborted'
          ? failure('aborted', null, 'Transcription was cancelled.', { retryable: false })
          : failure('timeout', null, 'Groq transcription timed out.', { retryable: true });
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn('[otis:groqStt] transport error:', errMsg);
      return failure('transient', null, `Groq transcription transport failed: ${errMsg}`, { retryable: true });
    }

    if (response.status === 401 || response.status === 403) {
      return failure('invalid_credential', response.status, 'Groq rejected the workspace credential.');
    }
    if (response.status === 429) {
      return failure('rate_limited', response.status, 'Groq transcription rate limit reached.', {
        retryable: true,
        retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
      });
    }
    if (response.status === 400 || response.status === 413 || response.status === 415) {
      return failure('invalid_request', response.status, 'Groq rejected the audio request.');
    }
    if (response.status >= 500) {
      return failure('transient', response.status, 'Groq transcription is temporarily unavailable.', {
        retryable: true,
      });
    }
    if (response.status !== 200) {
      return failure('transient', response.status, 'Groq transcription returned an unexpected status.', {
        retryable: true,
      });
    }

    let body: unknown;
    try {
      // The same deadline stays armed here, and the read races the abort
      // signal, so even a body whose read ignores the transport signal is
      // bounded instead of holding the job open.
      body = await abortRace(response.json(), controller.signal);
    } catch (err) {
      if (isAbortError(err)) {
        return abortCode() === 'aborted'
          ? failure('aborted', response.status, 'Transcription was cancelled.', { retryable: false })
          : failure('timeout', response.status, 'Groq transcription timed out.', { retryable: true });
      }
      return failure('malformed_response', response.status, 'Groq transcription response was not valid JSON.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return failure('malformed_response', response.status, 'Groq transcription response had an unexpected shape.');
    }
    const record = body as Record<string, unknown>;
    if (typeof record['text'] !== 'string') {
      return failure('malformed_response', response.status, 'Groq transcription response had no text field.');
    }
    return {
      ok: true,
      text: record['text'],
      language: typeof record['language'] === 'string' && record['language'] ? record['language'] : null,
      durationSeconds:
        typeof record['duration'] === 'number' && Number.isFinite(record['duration'])
          ? record['duration']
          : null,
    };
  } finally {
    clearTimeout(timer);
    if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
  }
}

/**
 * Deterministic 1-second 440 Hz tone as a 16 kHz mono 16-bit PCM WAV. Used
 * only as a bounded synthetic credential probe: it exercises the real
 * endpoint with the workspace key and proves audio is accepted. It is not
 * speech and is never evidence of transcript quality.
 */
export function buildSyntheticProbeWav(): Uint8Array {
  const sampleRate = 16_000;
  const seconds = 1;
  const samples = sampleRate * seconds;
  const dataBytes = samples * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.2 * 32767);
    view.setInt16(44 + i * 2, sample, true);
  }
  return new Uint8Array(buffer);
}

/**
 * Bounded credential probe for the existing verification race protection:
 * one synthetic transcription request against the fixed endpoint. A 2xx
 * proves the key authenticates and the endpoint accepts audio; an empty
 * transcript is acceptable here and never treated as a quality verdict.
 */
export async function probeGroqCredential(
  fetchFn: FetchFn,
  apiKey: string,
  timeoutMs = GROQ_STT_PROBE_TIMEOUT_MS,
): Promise<{ ok: boolean; status: number }> {
  const result = await transcribeWithGroq({
    apiKey,
    model: GROQ_STT_DEFAULT_MODEL,
    bytes: buildSyntheticProbeWav(),
    filename: 'otis-credential-probe.wav',
    mimeType: 'audio/wav',
    fetchFn,
    timeoutMs,
  });
  if (result.ok) return { ok: true, status: 200 };
  if (result.code === 'timeout') return { ok: false, status: 0 };
  return { ok: false, status: result.status ?? 0 };
}
