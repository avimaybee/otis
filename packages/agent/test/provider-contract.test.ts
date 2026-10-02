import { describe, expect, it } from 'vitest';
import { FakeProviderAdapter } from '../src/providers/fake.js';
import type { ProviderEvent, TurnInput } from '../src/providers/types.js';
import { baseInput, ECHO_TOOL, geminiModel } from './helpers.js';

async function collect(input: TurnInput, adapter: FakeProviderAdapter): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of adapter.streamTurn(input)) events.push(event);
  return events;
}

function terminals(events: ProviderEvent[]): ProviderEvent[] {
  return events.filter((event) => event.type === 'finish' || event.type === 'error');
}

describe('provider contract via the deterministic fake', () => {
  it('streams text in order with exactly one success terminal', async () => {
    const adapter = new FakeProviderAdapter({ scripts: [{ kind: 'text', text: 'Hello world' }] });
    const events = await collect(baseInput(geminiModel()), adapter);
    expect(events).toEqual([
      { type: 'text_delta', text: 'Hello world' },
      {
        type: 'usage',
        usage: {
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          reasoningTokens: null,
          totalTokens: null,
          cumulative: true,
        },
      },
      { type: 'finish', reason: 'success', continuation: null },
    ]);
    expect(terminals(events)).toHaveLength(1);
  });

  it('emits one completed call per provider call for two interleaved calls', async () => {
    const adapter = new FakeProviderAdapter({
      scripts: [
        {
          kind: 'tool_calls',
          calls: [
            { callId: 'call_1', name: 'echo_fixture', args: { fixture_id: 'a' } },
            { callId: 'call_2', name: 'echo_fixture', args: { fixture_id: 'b' } },
          ],
        },
      ],
    });
    const events = await collect(baseInput(geminiModel(), { tools: [{ ...ECHO_TOOL }] }), adapter);
    const ends = events.filter((event) => event.type === 'tool_call_end');
    expect(ends).toEqual([
      { type: 'tool_call_end', callId: 'call_1', name: 'echo_fixture', args: { fixture_id: 'a' } },
      { type: 'tool_call_end', callId: 'call_2', name: 'echo_fixture', args: { fixture_id: 'b' } },
    ]);
    expect(terminals(events)).toHaveLength(1);
    expect(terminals(events)[0]).toMatchObject({ type: 'finish', reason: 'tool_handoff' });
  });

  it('models a tool-result continuation round trip', async () => {
    const adapter = new FakeProviderAdapter({
      scripts: [
        {
          kind: 'tool_result_continuation',
          intermediateText: 'Working.',
          calls: [{ callId: 'call_9', name: 'echo_fixture', args: { fixture_id: 'z' } }],
          finalText: 'Done with z.',
        },
      ],
    });
    const input = baseInput(geminiModel(), {
      pendingToolResults: [{ callId: 'call_9', name: 'echo_fixture', resultText: '{"fixture_id":"z"}' }],
    });
    const events = await collect(input, adapter);
    expect(events.map((event) => event.type)).toEqual([
      'text_delta',
      'tool_call_start',
      'tool_call_arguments',
      'tool_call_end',
      'text_delta',
      'usage',
      'finish',
    ]);
    expect(adapter.calls[0]).toMatchObject({ requestId: 'req-test', sessionId: 'sess_workspace_chat' });
  });

  it('cancels a hanging turn with a single aborted terminal', async () => {
    const adapter = new FakeProviderAdapter({ scripts: [{ kind: 'hang_until_abort' }] });
    const controller = new AbortController();
    const events: ProviderEvent[] = [];
    const pumping = (async () => {
      for await (const event of adapter.streamTurn(baseInput(geminiModel(), { signal: controller.signal }))) {
        events.push(event);
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await pumping;
    expect(events).toEqual([
      { type: 'error', error: { code: 'aborted', message: 'Turn aborted.', retryable: false, retryAfterMs: null } },
    ]);
  });

  it('reports failures as a single typed error terminal', async () => {
    const adapter = new FakeProviderAdapter({ scripts: [{ kind: 'fail', code: 'rate_limited' }] });
    const events = await collect(baseInput(geminiModel()), adapter);
    expect(terminals(events)).toEqual([
      { type: 'error', error: { code: 'rate_limited', message: 'Fake rate_limited failure.', retryable: true, retryAfterMs: null } },
    ]);
  });

  it('preserves explicit zero usage while missing metrics stay null', async () => {
    const adapter = new FakeProviderAdapter({
      scripts: [{ kind: 'text', text: 'x', usage: { inputTokens: 0, outputTokens: 5 } }],
    });
    const events = await collect(baseInput(geminiModel()), adapter);
    const usage = events.find((event) => event.type === 'usage');
    expect(usage).toMatchObject({ usage: { inputTokens: 0, outputTokens: 5, cacheReadTokens: null } });
  });
});
