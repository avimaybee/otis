import { describe, expect, it } from 'vitest';
import { parseSseStream, SseOverflowError } from '../src/providers/sse.js';
import { parseRetryAfterMs } from '../src/providers/types.js';

async function collect(
  stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  options?: { maxBufferBytes?: number },
): Promise<Array<{ event: string; data: string }>> {
  const out: Array<{ event: string; data: string }> = [];
  for await (const item of parseSseStream(stream, options)) out.push(item);
  return out;
}

function byteStream(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      controller.close();
    },
  });
}

describe('shared SSE reader', () => {
  it('reads split UTF-8, split lines, CRLF, comments, and multi-data lines', async () => {
    const smile = new TextEncoder().encode('😀');
    const events = await collect(
      byteStream([
        ': keepalive\n',
        'event: step.delta\r\nda',
        'ta: {"index":0}\n\n',
        'event: note\ndata: line1\nda',
        'ta: line2\n\n',
        smile.slice(0, 2),
        smile.slice(2),
      ]),
    );
    expect(events).toEqual([
      { event: 'step.delta', data: '{"index":0}' },
      { event: 'note', data: 'line1\nline2' },
    ]);
  });

  it('handles several events per chunk and [DONE] as ordinary data', async () => {
    const events = await collect(byteStream(['event: a\ndata: 1\n\nevent: b\ndata: [DONE]\n\n']));
    expect(events).toEqual([
      { event: 'a', data: '1' },
      { event: 'b', data: '[DONE]' },
    ]);
  });

  it('fails closed past the byte bound', async () => {
    const big = 'x'.repeat(64);
    await expect(
      collect(
        {
          async *[Symbol.asyncIterator]() {
            yield new TextEncoder().encode(`data: ${big}\n\n`);
          },
        } as AsyncIterable<Uint8Array>,
        { maxBufferBytes: 8 },
      ),
    ).rejects.toBeInstanceOf(SseOverflowError);
  });

  it('allows many small consumed events totaling more than the buffer limit (finding 7 regression)', async () => {
    const chunks: string[] = [];
    for (let i = 0; i < 50; i++) {
      chunks.push(`data: ${i}\n\n`);
    }
    const events = await collect(byteStream(chunks), { maxBufferBytes: 20 });
    expect(events).toHaveLength(50);
    expect(events[0]).toEqual({ event: '', data: '0' });
    expect(events[49]).toEqual({ event: '', data: '49' });
  });

  it('yields identical parsed events whether delivered separate, coalesced, or arbitrarily byte-split (finding 4 follow-up regression)', async () => {
    const eventsText: string[] = [];
    for (let i = 0; i < 50; i++) {
      eventsText.push(`event: e${i}\ndata: item_${i}\n\n`);
    }
    const fullText = eventsText.join('');

    // 1. Separate: one event per chunk
    const separate = await collect(byteStream(eventsText), { maxBufferBytes: 25 });
    expect(separate).toHaveLength(50);

    // 2. Coalesced: all 50 events in a single chunk
    const coalesced = await collect(byteStream([fullText]), { maxBufferBytes: 25 });
    expect(coalesced).toEqual(separate);

    // 3. Arbitrarily split: cut the full stream into 7-byte slices
    const encoder = new TextEncoder();
    const fullBytes = encoder.encode(fullText);
    const slices: Uint8Array[] = [];
    for (let i = 0; i < fullBytes.length; i += 7) {
      slices.push(fullBytes.subarray(i, Math.min(i + 7, fullBytes.length)));
    }
    const fragmented = await collect(
      {
        async *[Symbol.asyncIterator]() {
          for (const s of slices) yield s;
        },
      } as AsyncIterable<Uint8Array>,
      { maxBufferBytes: 25 },
    );
    expect(fragmented).toEqual(separate);
  });

  it('fails when a single pending event exceeds the buffer limit', async () => {
    const chunks = ['data: 1234567890123456789012345\n\n'];
    await expect(collect(byteStream(chunks), { maxBufferBytes: 20 })).rejects.toBeInstanceOf(
      SseOverflowError,
    );
  });

  it('yields identical parsed events near the byte bound whether coalesced, split before newline, or sliced across UTF-8 bytes (P2 regression)', async () => {
    const lineText = 'data: 123456789012345\n\n'; // 15-byte data payload under 20-byte bound
    const expected = [{ event: '', data: '123456789012345' }];

    // 1. Coalesced in one chunk
    const coalesced = await collect(byteStream([lineText]), { maxBufferBytes: 20 });
    expect(coalesced).toEqual(expected);

    // 2. Split immediately before the trailing newline
    const splitBeforeNewline = await collect(byteStream(['data: 123456789012345', '\n\n']), { maxBufferBytes: 20 });
    expect(splitBeforeNewline).toEqual(expected);

    // 3. Sliced into 3-byte slices across UTF-8 bytes
    const encoder = new TextEncoder();
    const bytes = encoder.encode(lineText);
    const slices: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 3) {
      slices.push(bytes.subarray(i, Math.min(i + 3, bytes.length)));
    }
    const sliced = await collect(
      {
        async *[Symbol.asyncIterator]() {
          for (const s of slices) yield s;
        },
      } as AsyncIterable<Uint8Array>,
      { maxBufferBytes: 20 },
    );
    expect(sliced).toEqual(expected);

    // 4. Oversized event (>20 bytes payload) fails identically whether coalesced or split before newline
    const oversizedCoalesced = ['data: 1234567890123456789012345\n\n'];
    await expect(collect(byteStream(oversizedCoalesced), { maxBufferBytes: 20 })).rejects.toBeInstanceOf(
      SseOverflowError,
    );
    const oversizedSplit = ['data: 1234567890123456789012345', '\n\n'];
    await expect(collect(byteStream(oversizedSplit), { maxBufferBytes: 20 })).rejects.toBeInstanceOf(
      SseOverflowError,
    );
  });

  it('parses Retry-After seconds, dates, and garbage without inventing values', () => {
    expect(parseRetryAfterMs('120')).toBe(120_000);
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs('not-a-date')).toBeNull();
    const future = new Date(Date.now() + 60_000).toUTCString();
    const parsed = parseRetryAfterMs(future);
    expect(parsed).not.toBeNull();
    expect(parsed!).toBeGreaterThan(0);
    expect(parsed!).toBeLessThanOrEqual(60_000);
  });
});
