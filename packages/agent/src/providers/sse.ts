/**
 * @otis/agent/providers/sse
 * Minimal shared server-sent-events reader for the three SSE wire shapes in
 * Plan 005 (Gemini Interactions, Go Chat Completions, Go Responses).
 *
 * Handles split UTF-8 sequences, split lines, CRLF, comment/keepalive lines,
 * multiple data lines per event (joined with \n), and dispatches on blank
 * lines. Unknown event names pass through; adapters decide what to accept.
 *
 * The buffer bound limits retained parsed event payload bytes (event name,
 * data line values, and \n delimiters) buffered for an individual event,
 * applied consistently to both completed lines and trailing partial lines.
 * Throws `SseOverflowError` past the byte bound rather than buffering
 * unbounded provider output.
 */

import { MAX_SSE_BUFFER_BYTES } from './types.js';

export interface SseEvent {
  /** Empty when the sender omitted the event field. */
  event: string;
  data: string;
}

export class SseOverflowError extends Error {
  constructor(limitBytes: number) {
    super(`SSE stream exceeded ${limitBytes} buffered bytes.`);
    this.name = 'SseOverflowError';
  }
}

export async function* parseSseStream(
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  options: { maxBufferBytes?: number; signal?: AbortSignal } = {},
): AsyncGenerator<SseEvent> {
  const maxBufferBytes = options.maxBufferBytes ?? MAX_SSE_BUFFER_BYTES;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let text = '';
  let eventName = '';
  let dataLines: string[] = [];

  let currentEventBytes = 0;

  const checkTrailing = (trailingText: string): void => {
    if (!trailingText) return;
    if (trailingText.startsWith(':')) {
      if (encoder.encode(trailingText).byteLength > maxBufferBytes) {
        throw new SseOverflowError(maxBufferBytes);
      }
      return;
    }
    const colon = trailingText.indexOf(':');
    if (colon === -1) {
      if (encoder.encode(trailingText).byteLength > maxBufferBytes) {
        throw new SseOverflowError(maxBufferBytes);
      }
      return;
    }
    const field = trailingText.slice(0, colon).trim();
    let value = trailingText.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') {
      const valueBytes = encoder.encode(value).byteLength;
      if (currentEventBytes + valueBytes > maxBufferBytes) {
        throw new SseOverflowError(maxBufferBytes);
      }
    } else if (field === 'data') {
      const valueBytes = encoder.encode(value).byteLength;
      const extraNewline = dataLines.length > 0 ? 1 : 0;
      if (currentEventBytes + valueBytes + extraNewline > maxBufferBytes) {
        throw new SseOverflowError(maxBufferBytes);
      }
    } else {
      if (encoder.encode(trailingText).byteLength > maxBufferBytes) {
        throw new SseOverflowError(maxBufferBytes);
      }
    }
  };

  const push = (chunk: Uint8Array): void => {
    text += decoder.decode(chunk, { stream: true });
    if (text.indexOf('\n') === -1) {
      checkTrailing(text);
    }
  };

  const takeEvents = function* (): Generator<SseEvent> {
    let boundary = text.indexOf('\n');
    while (boundary !== -1) {
      let line = text.slice(0, boundary);
      text = text.slice(boundary + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        if (eventName !== '' || dataLines.length > 0) {
          yield { event: eventName, data: dataLines.join('\n') };
        }
        eventName = '';
        dataLines = [];
        currentEventBytes = 0;
      } else if (line.startsWith(':')) {
        // Comment/keepalive: ignored per SSE. Does not contribute to event buffer.
      } else {
        const colon = line.indexOf(':');
        if (colon === -1) {
          if (encoder.encode(line).byteLength > maxBufferBytes) {
            throw new SseOverflowError(maxBufferBytes);
          }
          continue;
        }
        const field = line.slice(0, colon).trim();
        let value = line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        const valueBytes = encoder.encode(value).byteLength;
        if (field === 'event') {
          eventName = value;
          currentEventBytes += valueBytes;
        } else if (field === 'data') {
          dataLines.push(value);
          currentEventBytes += valueBytes + (dataLines.length > 1 ? 1 : 0);
        }
        if (currentEventBytes > maxBufferBytes) {
          throw new SseOverflowError(maxBufferBytes);
        }
      }
      boundary = text.indexOf('\n');
    }
    checkTrailing(text);
  };

  try {
    if (Symbol.asyncIterator in Object(body)) {
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        if (options.signal?.aborted) return;
        push(chunk);
        yield* takeEvents();
      }
    } else {
      const reader = (body as ReadableStream<Uint8Array>).getReader();
      try {
        for (;;) {
          if (options.signal?.aborted) return;
          const { done, value } = await reader.read();
          if (done) break;
          push(value);
          yield* takeEvents();
        }
      } finally {
        reader.releaseLock();
      }
    }
    text += decoder.decode();
    yield* takeEvents();
  } finally {
    decoder.decode();
  }
}
