import { describe, expect, it } from 'vitest';
import {
  StreamPublisher,
  THINKING_MAX_DISPLAY_CHARS,
  createThinkingBudget,
  type StreamPublishFn,
} from '../src/agent/streamPublish.js';

interface RecordedCall {
  key: string;
  type: string;
  payload: Record<string, unknown>;
}

function recorder() {
  const calls: RecordedCall[] = [];
  const publish: StreamPublishFn = async (key, type, payload) => {
    calls.push({ key, type, payload: payload as Record<string, unknown> });
  };
  return { calls, publish };
}

function thinking(text: string, blockId = 's0', mode: 'snapshot' | 'append' = 'append') {
  return { text, blockId, contentKind: 'summary' as const, mode };
}

function thinkingText(calls: RecordedCall[]): string {
  return calls
    .filter(call => call.type === 'reasoning_summary' && typeof call.payload['text'] === 'string')
    .map(call => call.payload['text'] as string)
    .join('');
}

describe('StreamPublisher (R6 stream reliability)', () => {
  it('drains a large single delta fully before the terminal record', async () => {
    const { calls, publish } = recorder();
    const publisher = new StreamPublisher(publish, 0, 'gemini');
    publisher.pushThinking(thinking('x'.repeat(5000)));
    await publisher.close('complete');
    expect(thinkingText(calls)).toBe('x'.repeat(5000));
    const states = calls.map(call => call.payload['state']);
    expect(states[states.length - 1]).toBe('complete');
    expect(states.filter(state => state === 'streaming').length).toBeGreaterThan(0);
  });

  it('keeps 200 small deltas complete and ordered', async () => {
    const { calls, publish } = recorder();
    const publisher = new StreamPublisher(publish, 0, 'gemini');
    for (let index = 0; index < 200; index++) {
      publisher.pushThinking(thinking(`w${index} `));
    }
    await publisher.close('complete');
    expect(thinkingText(calls)).toBe(Array.from({ length: 200 }, (_, index) => `w${index} `).join(''));
  });

  it('serializes slow publishes so the terminal record stays last', async () => {
    const calls: RecordedCall[] = [];
    const gates: Array<() => void> = [];
    const publish: StreamPublishFn = (key, type, payload) =>
      new Promise<void>(resolve => {
        gates.push(() => {
          calls.push({ key, type, payload: payload as Record<string, unknown> });
          resolve();
        });
      });
    const publisher = new StreamPublisher(publish, 0, 'gemini');
    publisher.pushText('hello ');
    publisher.pushThinking(thinking('thinking part '));
    const closed = publisher.close('complete');
    for (let step = 0; step < 50; step++) {
      await new Promise(resolve => setTimeout(resolve, 0));
      const gate = gates.shift();
      if (gate) gate();
    }
    await Promise.race([
      closed,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('close did not settle')), 2000)),
    ]);
    const texts = calls.map(call => String(call.payload['text'] ?? ''));
    expect(texts.join('')).toContain('hello ');
    expect(texts.join('')).toContain('thinking part ');
    expect(calls[calls.length - 1]!.payload['state']).toBe('complete');
  });

  it('retries rejected publishes without unhandled rejection or loss', async () => {
    const calls: RecordedCall[] = [];
    let failures = 0;
    const errors: unknown[] = [];
    const publish: StreamPublishFn = async (key, type, payload) => {
      if (failures < 2) {
        failures += 1;
        throw new Error('D1 busy');
      }
      calls.push({ key, type, payload: payload as Record<string, unknown> });
    };
    const publisher = new StreamPublisher(publish, 0, 'gemini', err => {
      errors.push(err);
    });
    publisher.pushText('retry me');
    await publisher.tick(Date.now() + 10_000);
    expect(calls).toHaveLength(0);
    await publisher.tick(Date.now() + 10_000);
    await publisher.close('complete');
    expect(calls.map(call => call.payload['text']).join('')).toBe('retry me');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('interruption preserves partial content and stops further writes', async () => {
    const { calls, publish } = recorder();
    const publisher = new StreamPublisher(publish, 0, 'gemini');
    publisher.pushThinking(thinking('half '));
    await publisher.tick(Date.now() + 10_000);
    await publisher.close('interrupted');
    publisher.pushThinking(thinking('late '));
    publisher.pushText('late text');
    await publisher.tick(Date.now() + 20_000);
    await publisher.close('interrupted');
    expect(thinkingText(calls)).toBe('half ');
    expect(calls[calls.length - 1]!.payload['state']).toBe('interrupted');
    expect(calls.filter(call => call.type === 'text_chunk')).toHaveLength(0);
  });

  it('caps display once with exactly one truncation marker and keeps the answer', async () => {
    const { calls, publish } = recorder();
    const publisher = new StreamPublisher(publish, 0, 'gemini');
    publisher.pushText('the answer stays whole');
    publisher.pushThinking(thinking('y'.repeat(THINKING_MAX_DISPLAY_CHARS + 5000)));
    await publisher.close('complete');
    const published = thinkingText(calls);
    expect(published.length).toBeLessThanOrEqual(THINKING_MAX_DISPLAY_CHARS + 1000);
    expect(published.length).toBeGreaterThan(0);
    const truncated = calls.filter(call => call.payload['state'] === 'truncated');
    expect(truncated).toHaveLength(1);
    expect(calls.filter(call => call.type === 'text_chunk').map(call => call.payload['text']).join('')).toBe(
      'the answer stays whole',
    );
  });

  it('publishes a short answer in one chunk before completion', async () => {
    const { calls, publish } = recorder();
    const publisher = new StreamPublisher(publish, 0, 'gemini');
    publisher.pushText('Hi.');
    await publisher.close('complete');
    const chunks = calls.filter(call => call.type === 'text_chunk');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.payload['text']).toBe('Hi.');
  });

  it('flushes the first text delta as a live frame immediately, then coalesces', async () => {
    const { calls, publish } = recorder();
    const frames: Array<{ text: string; seq: number }> = [];
    const publisher = new StreamPublisher(publish, 0, 'gemini', () => undefined, undefined, (text, seq) => {
      frames.push({ text, seq });
    });
    publisher.pushText('H');
    // No timer tick and no D1 write: the opener is already visible live.
    expect(frames).toEqual([{ text: 'H', seq: 1 }]);
    expect(calls.filter(call => call.type === 'text_chunk')).toHaveLength(0);
    // Later deltas coalesce instead of emitting one frame each.
    publisher.pushText('i');
    publisher.pushText('!');
    expect(frames).toHaveLength(1);
    await publisher.tick(Date.now() + 10_000);
    expect(frames).toEqual([{ text: 'H', seq: 1 }, { text: 'Hi!', seq: 2 }]);
    await publisher.close('complete');
    // The durable remainder persists exactly once.
    expect(calls.filter(call => call.type === 'text_chunk').map(call => call.payload['text']).join('')).toBe('Hi!');
  });

  it('shares one thinking budget across rounds of a turn', async () => {
    const { calls, publish } = recorder();
    const budget = createThinkingBudget();
    const first = new StreamPublisher(publish, 0, 'gemini', () => undefined, budget);
    first.pushThinking(thinking('a'.repeat(20_000)));
    await first.close('complete');
    const second = new StreamPublisher(publish, 1, 'gemini', () => undefined, budget);
    second.pushThinking(thinking('b'.repeat(10_000)));
    await second.close('complete');
    const published = thinkingText(calls);
    expect(published.length).toBeLessThanOrEqual(THINKING_MAX_DISPLAY_CHARS + 1000);
    expect(calls.filter(call => call.payload['state'] === 'truncated')).toHaveLength(1);
    // Round record keys stay distinct: no id collision across rounds.
    const keys = calls.map(call => call.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('duplicate close performs no extra writes', async () => {
    const { calls, publish } = recorder();
    const publisher = new StreamPublisher(publish, 0, 'gemini');
    publisher.pushText('once');
    expect(await publisher.close('complete')).toBe(true);
    const count = calls.length;
    expect(await publisher.close('complete')).toBe(true);
    expect(calls.length).toBe(count);
  });

  it('truncation wins the single terminal receipt under first-write-wins keys', async () => {
    const rows = new Map<string, RecordedCall>();
    const publish: StreamPublishFn = async (key, type, payload) => {
      if (!rows.has(key)) rows.set(key, { key, type, payload: payload as Record<string, unknown> });
    };
    const publisher = new StreamPublisher(publish, 0, 'gemini');
    for (let index = 0; index < 30; index++) {
      publisher.pushThinking(thinking('z'.repeat(1000)));
      await publisher.tick(Date.now() + (index + 1) * 10_000);
    }
    const drained = await publisher.close('complete');
    expect(drained).toBe(true);
    const ends = [...rows.values()].filter(call => call.key === 'r0_think_s0_end');
    expect(ends).toHaveLength(1);
    expect(ends[0]!.payload['state']).toBe('truncated');
    // All published thinking text stays within cap plus one in-flight batch.
    const published = [...rows.values()]
      .filter(call => call.type === 'reasoning_summary' && typeof call.payload['text'] === 'string')
      .map(call => call.payload['text'] as string)
      .join('').length;
    expect(published).toBeLessThanOrEqual(THINKING_MAX_DISPLAY_CHARS + 1000);
  });

  it('close reports false when the final remainder cannot publish', async () => {
    const errors: unknown[] = [];
    let attempts = 0;
    const publish: StreamPublishFn = async () => {
      attempts += 1;
      throw new Error('D1 busy');
    };
    const publisher = new StreamPublisher(publish, 0, 'gemini', err => {
      errors.push(err);
    });
    publisher.pushText('final words');
    const drained = await publisher.close('complete');
    expect(drained).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
    expect(attempts).toBeGreaterThan(0);
    const second = await publisher.close('complete');
    expect(second).toBe(false);
    expect(attempts).toBeGreaterThan(0);
  });

  it('emits noDisclosure for thinking-free rounds', async () => {
    const { calls, publish } = recorder();
    const publisher = new StreamPublisher(publish, 0, 'gemini');
    publisher.pushText('plain answer');
    await publisher.close('complete');
    expect(calls.some(call => call.type === 'reasoning_summary')).toBe(false);
  });

  it('scopes retry generations apart so a replacement never collides (BG06)', async () => {
    const { calls, publish } = recorder();
    const first = new StreamPublisher(publish, 0, 'gemini', () => undefined, undefined, undefined, undefined, 'abc123s0');
    first.pushText('retry me');
    await first.close('complete');
    const second = new StreamPublisher(publish, 0, 'gemini', () => undefined, undefined, undefined, undefined, 'abc123s1');
    second.pushText('retry me');
    await second.close('complete');
    const keys = calls.map(call => call.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.some(key => key.includes('_gabc123s0_'))).toBe(true);
    expect(keys.some(key => key.includes('_gabc123s1_'))).toBe(true);
  });

  it('discard drops the provisional display without persisting (BG06)', async () => {
    const { calls, publish } = recorder();
    const publisher = new StreamPublisher(publish, 0, 'gemini');
    publisher.pushText('partial preamble');
    publisher.pushThinking(thinking('partial thought'));
    await publisher.discard();
    publisher.pushText('late text');
    await publisher.tick(Date.now() + 20_000);
    expect(calls.filter(call => call.type === 'text_chunk')).toHaveLength(0);
    expect(thinkingText(calls)).toBe('');
  });

  it('discard releases unpublished budget and fences in-flight publication (BG10)', async () => {
    // Phase 1: buffered-but-never-enqueued content releases its allowance.
    const budgetA = createThinkingBudget();
    const plainA = recorder();
    const first = new StreamPublisher(plainA.publish, 0, 'gemini', () => undefined, budgetA);
    first.pushThinking(thinking('y'.repeat(100)));
    expect(budgetA.bufferedChars).toBe(100);
    await first.discard();
    expect(budgetA.bufferedChars).toBe(0);
    expect(budgetA.publishedChars).toBe(0);
    expect(plainA.calls).toHaveLength(0);

    // Phase 2: an in-flight publish settles exactly before retirement.
    const budgetB = createThinkingBudget();
    const gates: Array<() => void> = [];
    const calls: RecordedCall[] = [];
    const gatedPublish: StreamPublishFn = (_key, type, payload) =>
      new Promise<void>((resolve) => {
        gates.push(() => {
          calls.push({ key: _key, type, payload: payload as Record<string, unknown> });
          resolve();
        });
      });
    const publisher = new StreamPublisher(gatedPublish, 0, 'gemini', () => undefined, budgetB);
    publisher.pushThinking(thinking('x'.repeat(1000)));
    for (let step = 0; step < 10 && gates.length === 0; step++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(gates.length).toBe(1);
    const discarding = publisher.discard();
    // Release the gate while discard waits: the authorized flush lands, then
    // the (now empty) remainder retires with exact accounting.
    gates.splice(0).forEach((gate) => gate());
    await discarding;
    expect(thinkingText(calls)).toBe('x'.repeat(1000));
    expect(budgetB.publishedChars).toBe(1000);
    expect(budgetB.bufferedChars).toBe(0);
    // A replacement publisher on the same budget keeps its full allowance.
    const plain = recorder();
    const replacement = new StreamPublisher(plain.publish, 0, 'gemini', () => undefined, budgetB);
    replacement.pushThinking(thinking('z'.repeat(100)));
    await replacement.tick(Date.now() + 20_000);
    await replacement.close('complete');
    expect(budgetB.bufferedChars).toBe(0);
    expect(
      plain.calls
        .filter((call) => call.type === 'reasoning_summary' && typeof call.payload['text'] === 'string')
        .map((call) => call.payload['text'] as string)
        .join(''),
    ).toBe('z'.repeat(100));
  });

  it('carries the publication generation in thinking payloads (BG09)', async () => {
    const { calls, publish } = recorder();
    const publisher = new StreamPublisher(publish, 0, 'gemini', () => undefined, undefined, undefined, undefined, 'abc123s1');
    publisher.pushThinking(thinking('thought ', 's0'));
    await publisher.tick(Date.now() + 10_000);
    await publisher.close('complete');
    const summaries = calls.filter((call) => call.type === 'reasoning_summary');
    expect(summaries.length).toBeGreaterThan(0);
    for (const summary of summaries) {
      expect(summary.payload['generation']).toBe('abc123s1');
      expect(summary.payload['block_id']).toBe('s0');
    }
  });

  it('refuses pushes, ticks and preview frames once the run is aborted (F08)', async () => {
    const { calls, publish } = recorder();
    const previews: Array<{ text: string; seq: number }> = [];
    let aborted = false;
    const publisher = new StreamPublisher(
      publish,
      0,
      'gemini',
      () => undefined,
      undefined,
      (text, seq) => {
        previews.push({ text, seq });
      },
      () => aborted,
    );
    publisher.pushText('before stop');
    expect(previews).toHaveLength(1);
    aborted = true;
    publisher.pushText('after stop');
    publisher.pushThinking(thinking('stale thought'));
    await publisher.tick(Date.now() + 10_000);
    expect(previews).toHaveLength(1);
    await publisher.close('interrupted');
    expect(calls.filter(call => call.type === 'text_chunk').map(call => call.payload['text']).join('')).toBe(
      'before stop',
    );
  });
});
