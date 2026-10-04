import { describe, expect, it } from 'vitest';
import { GeminiInteractionsAdapter, GEMINI_INTERACTIONS_URL } from '../src/providers/gemini.js';
import type { ProviderEvent, TurnInput } from '../src/providers/types.js';
import { ProviderErrorException } from '../src/providers/types.js';
import { baseInput, chunkedResponse, ECHO_TOOL, errorResponse, geminiModel, mockFetch, shred } from './helpers.js';

function adapterFor(fetchFn: ReturnType<typeof mockFetch>): GeminiInteractionsAdapter {
  return new GeminiInteractionsAdapter({ fetchFn, apiKey: 'test-gemini-key' });
}

async function collect(input: TurnInput, fetchFn: ReturnType<typeof mockFetch>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of adapterFor(fetchFn).streamTurn(input)) events.push(event);
  return events;
}

const TEXT_STREAM = [
  'event: interaction.created\n',
  'data: {"interaction":{"id":"v1_abc","status":"in_progress","model":"gemini-3.5-flash-lite"},"event_type":"interaction.created"}\n\n',
  'event: step.start\n',
  'data: {"index":0,"step":{"type":"model_output"},"event_type":"step.start"}\n\n',
  'event: step.delta\n',
  'data: {"index":0,"delta":{"type":"text","text":"Hello, "},"event_type":"step.delta"}\n\n',
  'event: step.delta\n',
  'data: {"index":0,"delta":{"type":"text","text":"Kerning."},"event_type":"step.delta"}\n\n',
  'event: step.stop\n',
  'data: {"index":0,"event_type":"step.stop"}\n\n',
  'event: interaction.completed\n',
  'data: {"interaction":{"id":"v1_abc","status":"completed","usage":{"total_tokens":42,"total_input_tokens":30,"total_cached_tokens":5,"total_output_tokens":12,"total_thought_tokens":3}},"event_type":"interaction.completed"}\n\n',
  'event: done\n',
  'data: [DONE]\n\n',
].join('');

const TOOL_STREAM = [
  'event: interaction.created\n',
  'data: {"interaction":{"id":"v1_tool","status":"in_progress","model":"gemini-3.5-flash-lite"},"event_type":"interaction.created"}\n\n',
  'event: step.start\n',
  'data: {"index":0,"step":{"type":"function_call","id":"call_a","name":"echo_fixture","arguments":{}},"event_type":"step.start"}\n\n',
  'event: step.delta\n',
  'data: {"index":0,"delta":{"type":"arguments_delta","arguments":"{\\"fixture_id\\":\\"a\\"}"},"event_type":"step.delta"}\n\n',
  'event: step.stop\n',
  'data: {"index":0,"event_type":"step.stop"}\n\n',
  'event: step.start\n',
  'data: {"index":1,"step":{"type":"function_call","id":"call_b","name":"echo_fixture","arguments":{}},"event_type":"step.start"}\n\n',
  'event: step.delta\n',
  'data: {"index":1,"delta":{"type":"arguments_delta","arguments":"{\\"fixture_id\\":\\"b\\"}"},"event_type":"step.delta"}\n\n',
  'event: step.stop\n',
  'data: {"index":1,"event_type":"step.stop"}\n\n',
  'event: interaction.completed\n',
  'data: {"interaction":{"id":"v1_tool","status":"requires_action","usage":{"total_tokens":10,"total_input_tokens":8,"total_output_tokens":2}},"event_type":"interaction.completed"}\n\n',
  'event: done\n',
  'data: [DONE]\n\n',
].join('');

describe('Gemini Interactions adapter', () => {
  it('invokes transport without a receiver (Workers Illegal-invocation safe)', async () => {
    let observedThis: unknown = 'unset';
    async function receiverCheckingFetch(this: unknown, _url: string, _init: RequestInit): Promise<Response> {
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- observing the invocation receiver is the assertion.
      observedThis = this;
      return chunkedResponse([TEXT_STREAM]);
    }
    const adapter = new GeminiInteractionsAdapter({
      fetchFn: receiverCheckingFetch as unknown as ReturnType<typeof mockFetch>,
      apiKey: 'test-gemini-key',
    });
    const events: ProviderEvent[] = [];
    for await (const event of adapter.streamTurn(baseInput(geminiModel()))) events.push(event);
    expect(events[events.length - 1]).toMatchObject({ type: 'finish' });
    // A member invocation (this.fetchFn) would surface the adapter instance
    // here and throw Illegal invocation against native Workers fetch.
    expect(observedThis).toBeUndefined();
  });

  it('sends the documented endpoint, key header, tools, and streams text plus usage', async () => {
    const fetchFn = mockFetch(() => chunkedResponse(shred(TEXT_STREAM, [7, 53, 11])));
    const input = baseInput(geminiModel(), {
      messages: [
        { role: 'system', text: 'You are Otis.' },
        { role: 'user', text: 'Hello' },
      ],
      tools: [{ ...ECHO_TOOL }],
    });
    const events = await collect(input, fetchFn);

    expect(fetchFn.requests).toHaveLength(1);
    expect(fetchFn.requests[0]!.url).toBe(GEMINI_INTERACTIONS_URL);
    expect(fetchFn.requests[0]!.headers['x-goog-api-key']).toBe('test-gemini-key');
    const body = fetchFn.requests[0]!.body as Record<string, unknown>;
    expect(body['model']).toBe('gemini-3.5-flash-lite');
    expect(body['stream']).toBe(true);
    expect(body['system_instruction']).toBe('You are Otis.');
    expect(body['tools']).toEqual([
      {
        type: 'function',
        name: 'echo_fixture',
        description: 'Echoes a fixture identifier.',
        parameters: ECHO_TOOL.parameters,
      },
    ]);

    expect(events.filter((event) => event.type === 'text_delta')).toEqual([
      { type: 'text_delta', text: 'Hello, ' },
      { type: 'text_delta', text: 'Kerning.' },
    ]);
    expect(events.find((event) => event.type === 'usage')).toMatchObject({
      usage: {
        inputTokens: 30,
        outputTokens: 12,
        cacheReadTokens: 5,
        cacheWriteTokens: null,
        reasoningTokens: 3,
        totalTokens: 42,
        cumulative: true,
      },
    });
    const finish = events[events.length - 1];
    expect(finish).toMatchObject({
      type: 'finish',
      reason: 'success',
      continuation: { kind: 'gemini-interactions', interactionId: 'v1_abc' },
    });
  });

  it('keeps two interleaved tool calls separate by index with validated JSON', async () => {
    const fetchFn = mockFetch(() => chunkedResponse([TOOL_STREAM]));
    const events = await collect(baseInput(geminiModel(), { tools: [{ ...ECHO_TOOL }] }), fetchFn);
    expect(events.filter((event) => event.type === 'tool_call_end')).toEqual([
      { type: 'tool_call_end', callId: 'call_a', name: 'echo_fixture', args: { fixture_id: 'a' } },
      { type: 'tool_call_end', callId: 'call_b', name: 'echo_fixture', args: { fixture_id: 'b' } },
    ]);
    expect(events[events.length - 1]).toMatchObject({ type: 'finish', reason: 'tool_handoff' });
  });

  it('surfaces documented thought summaries and never raw signatures', async () => {
    const stream = [
      'event: step.start\n',
      'data: {"index":0,"step":{"type":"thought"},"event_type":"step.start"}\n\n',
      'event: step.delta\n',
      'data: {"index":0,"delta":{"type":"thought_summary","content":{"type":"text","text":"Checking records."}},"event_type":"step.delta"}\n\n',
      'event: step.delta\n',
      'data: {"index":0,"delta":{"type":"thought_signature","signature":"opaque"},"event_type":"step.delta"}\n\n',
      'event: step.stop\n',
      'data: {"index":0,"event_type":"step.stop"}\n\n',
      'event: interaction.completed\n',
      'data: {"interaction":{"id":"v1_th","status":"completed","usage":{}},"event_type":"interaction.completed"}\n\n',
    ].join('');
    const fetchFn = mockFetch(() => chunkedResponse([stream]));
    const events = await collect(baseInput(geminiModel()), fetchFn);
    expect(events).toContainEqual({
      type: 'provider_thought_summary',
      text: 'Checking records.',
      blockId: 's0',
      contentKind: 'summary',
      mode: 'append',
    });
    expect(JSON.stringify(events)).not.toContain('opaque');
  });

  it('forwards thought step.start summaries as snapshot blocks per step', async () => {
    const stream = [
      'event: step.start\n',
      'data: {"index":0,"step":{"type":"thought","summary":[{"type":"text","text":"Evaluating the clues"}]},"event_type":"step.start"}\n\n',
      'event: step.start\n',
      'data: {"index":1,"step":{"type":"thought","summary":[{"type":"text","text":"Comparing options"}]},"event_type":"step.start"}\n\n',
      'event: interaction.completed\n',
      'data: {"interaction":{"id":"v1_th2","status":"completed","usage":{}},"event_type":"interaction.completed"}\n\n',
    ].join('');
    const fetchFn = mockFetch(() => chunkedResponse([stream]));
    const events = await collect(baseInput(geminiModel()), fetchFn);
    expect(events).toContainEqual({
      type: 'provider_thought_summary',
      text: 'Evaluating the clues',
      blockId: 's0',
      contentKind: 'summary',
      mode: 'snapshot',
    });
    expect(events).toContainEqual({
      type: 'provider_thought_summary',
      text: 'Comparing options',
      blockId: 's1',
      contentKind: 'summary',
      mode: 'snapshot',
    });
  });

  it('requests verified thought summaries on the same Interactions endpoint', async () => {
    const fetchFn = mockFetch(() => chunkedResponse([TEXT_STREAM]));
    await collect(baseInput(geminiModel()), fetchFn);
    const body = fetchFn.requests[0]!.body as Record<string, unknown>;
    const genConfig = body['generation_config'] as Record<string, unknown>;
    expect(genConfig['thinking_summaries']).toBe('auto');
    expect(genConfig['max_output_tokens']).toBe(512);
  });

  it('continues tool results with the previous interaction id', async () => {
    const fetchFn = mockFetch(() => chunkedResponse([TEXT_STREAM]));
    const input = baseInput(geminiModel(), {
      pendingToolResults: [{ callId: 'call_a', name: 'echo_fixture', resultText: '{"fixture_id":"a"}' }],
      previousContinuation: { kind: 'gemini-interactions', interactionId: 'v1_tool' },
    });
    await collect(input, fetchFn);
    const body = fetchFn.requests[0]!.body as Record<string, unknown>;
    expect(body['previous_interaction_id']).toBe('v1_tool');
    // Stateful continuation: the stored interaction already owns the prior
    // user input, so only the newly pending function result is submitted.
    expect(body['input']).toEqual([
      {
        type: 'function_result',
        name: 'echo_fixture',
        call_id: 'call_a',
        result: [{ type: 'text', text: '{"fixture_id":"a"}' }],
      },
    ]);
  });

  it('stateful continuation sends only new input and pending results, never replayed calls or history', async () => {
    const fetchFn = mockFetch(() => chunkedResponse([TEXT_STREAM]));
    const input = baseInput(geminiModel(), {
      // Production-shaped handler input: full stored history including the
      // previously proposed assistant call and its result, plus the latest
      // pending result and steering that arrived after the continuation.
      messages: [
        { role: 'system', text: 'System prompt' },
        { role: 'user', text: 'Original request' },
        { role: 'assistant', toolCalls: [{ id: 'call_old', name: 'tool_old', arguments: '{"x":1}' }] },
        { role: 'tool', toolCallId: 'call_old', name: 'tool_old', text: 'old result' },
        { role: 'assistant', toolCalls: [{ id: 'call_new', name: 'tool_new', arguments: '{"y":2}' }] },
      ],
      pendingToolResults: [{ callId: 'call_new', name: 'tool_new', resultText: 'new result' }],
      continuationInput: [{ role: 'user', text: '[Additional context from the same member]: prefer Tuesday' }],
      previousContinuation: { kind: 'gemini-interactions', interactionId: 'v1_linked' },
    });
    await collect(input, fetchFn);
    const body = fetchFn.requests[0]!.body as Record<string, unknown>;
    expect(body['previous_interaction_id']).toBe('v1_linked');
    const blocks = body['input'] as Array<Record<string, unknown>>;
    expect(blocks.some((block) => block['type'] === 'function_call')).toBe(false);
    expect(blocks.some((block) => block['type'] === 'model_output')).toBe(false);
    expect(blocks.filter((block) => block['type'] === 'user_input')).toEqual([
      {
        type: 'user_input',
        content: [{ type: 'text', text: '[Additional context from the same member]: prefer Tuesday' }],
      },
    ]);
    expect(blocks.filter((block) => block['type'] === 'function_result')).toEqual([
      { type: 'function_result', name: 'tool_new', call_id: 'call_new', result: [{ type: 'text', text: 'new result' }] },
    ]);
    // Interaction-scoped configuration is re-specified alongside the link.
    expect(body['system_instruction']).toBe('System prompt');
    expect(body['generation_config']).toBeDefined();
  });

  it('initial requests keep complete stateless serialization with function calls and results', async () => {
    const fetchFn = mockFetch(() => chunkedResponse([TEXT_STREAM]));
    const input = baseInput(geminiModel(), {
      messages: [
        { role: 'user', text: 'Run tool' },
        { role: 'assistant', toolCalls: [{ id: 'call_s', name: 'tool_s', arguments: '{"a":1}' }] },
        { role: 'tool', toolCallId: 'call_s', name: 'tool_s', text: 'result_s' },
      ],
      previousContinuation: null,
    });
    await collect(input, fetchFn);
    const body = fetchFn.requests[0]!.body as Record<string, unknown>;
    expect(body['previous_interaction_id']).toBeUndefined();
    const blocks = body['input'] as Array<Record<string, unknown>>;
    expect(blocks.some((block) => block['type'] === 'function_call' && block['id'] === 'call_s')).toBe(true);
    expect(blocks.some((block) => block['type'] === 'function_result' && block['call_id'] === 'call_s')).toBe(true);
  });

  it('rejects malformed tool arguments without exposing a partial call', async () => {
    const stream = [
      'event: step.start\n',
      'data: {"index":0,"step":{"type":"function_call","id":"call_x","name":"echo_fixture","arguments":{}},"event_type":"step.start"}\n\n',
      'event: step.delta\n',
      'data: {"index":0,"delta":{"type":"arguments_delta","arguments":"{bad json"},"event_type":"step.delta"}\n\n',
      'event: step.stop\n',
      'data: {"index":0,"event_type":"step.stop"}\n\n',
    ].join('');
    const fetchFn = mockFetch(() => chunkedResponse([stream]));
    const events = await collect(baseInput(geminiModel(), { tools: [{ ...ECHO_TOOL }] }), fetchFn);
    expect(events.filter((event) => event.type === 'tool_call_end')).toHaveLength(0);
    expect(events[events.length - 1]).toMatchObject({ type: 'error', error: { code: 'malformed_response' } });
  });

  it('fails a stream cut off before the completion marker', async () => {
    const fetchFn = mockFetch(() =>
      chunkedResponse(['event: step.delta\n', 'data: {"index":0,"delta":{"type":"text","text":"Half"}}\n\n']),
    );
    const events = await collect(baseInput(geminiModel()), fetchFn);
    expect(events[events.length - 1]).toMatchObject({
      type: 'error',
      error: { code: 'malformed_response' },
    });
  });

  it('maps 401, 429 with Retry-After, and 500 without leaking bodies', async () => {
    for (const [status, body, code, retryable, retryAfter] of [
      [401, { error: { message: 'API key not valid.' } }, 'invalid_credential', false, null],
      [429, { error: { message: 'Slow down.' } }, 'rate_limited', true, 30000],
      [500, 'upstream exploded: secret=hunter2', 'transient', true, null],
    ] as const) {
      const fetchFn = mockFetch(() =>
        errorResponse(status, body, status === 429 ? { 'retry-after': '30' } : undefined),
      );
      const events = await collect(baseInput(geminiModel()), fetchFn);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'error', error: { code, retryable, retryAfterMs: retryAfter } });
      expect(JSON.stringify(events[0])).not.toContain('hunter2');
    }
  });

  it('maps unknown models, timeouts, and aborts to typed errors', async () => {
    const notFound = mockFetch(() => errorResponse(404, { error: { message: 'Not found.' } }));
    expect((await collect(baseInput(geminiModel()), notFound))[0]).toMatchObject({
      type: 'error',
      error: { code: 'unknown_model' },
    });

    // The mock settles like a real fetch backed by AbortSignal.timeout:
    // rejection carries the timeout reason, which the adapter maps to timeout.
    const hanging = mockFetch((_request, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const fire = (): void => reject(Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }));
        if (init.signal?.aborted) {
          fire();
          return;
        }
        init.signal?.addEventListener('abort', fire, { once: true });
      });
    });
    const timeoutErr = await (async () => {
      const events: ProviderEvent[] = [];
      for await (const event of adapterFor(hanging).streamTurn(baseInput(geminiModel(), { timeoutMs: 20 }))) {
        events.push(event);
      }
      return events;
    })();
    expect(timeoutErr[timeoutErr.length - 1]).toMatchObject({ type: 'error', error: { code: 'timeout' } });

    const controller = new AbortController();
    controller.abort();
    const aborted = await collect(baseInput(geminiModel(), { signal: controller.signal }), mockFetch(() => chunkedResponse([TEXT_STREAM])));
    expect(aborted[aborted.length - 1]).toMatchObject({ type: 'error', error: { code: 'aborted' } });
  });

  it('throws on unsupported tool schemas before any network call', async () => {
    const fetchFn = mockFetch(() => chunkedResponse([TEXT_STREAM]));
    await expect(
      collect(baseInput(geminiModel(), { tools: [{ name: 'bad tool', description: 'x', parameters: {} }] }), fetchFn),
    ).rejects.toBeInstanceOf(ProviderErrorException);
    expect(fetchFn.requests).toHaveLength(0);
  });

  it('sends the documented generation_config.max_output_tokens in request body (finding 5 regression)', async () => {
    const fetchFn = mockFetch(() => chunkedResponse([TEXT_STREAM]));
    const input = baseInput(geminiModel(), { maxOutputTokens: 17 });
    await collect(input, fetchFn);
    expect(fetchFn.requests).toHaveLength(1);
    const body = fetchFn.requests[0]!.body as Record<string, unknown>;
    expect(body['generation_config']).toEqual({ max_output_tokens: 17, thinking_summaries: 'auto' });
  });

  it('rejects non-positive integer maxOutputTokens before transport', async () => {
    const fetchFn = mockFetch(() => chunkedResponse([TEXT_STREAM]));
    await expect(
      collect(baseInput(geminiModel(), { maxOutputTokens: -5 }), fetchFn),
    ).rejects.toBeInstanceOf(ProviderErrorException);
    expect(fetchFn.requests).toHaveLength(0);
  });

  it('never echoes dummy secrets, bearer strings, URLs, or prompts from upstream errors (finding 6 regression)', async () => {
    const upstreamSecretBody = {
      error: {
        message: 'DUMMY_SECRET_MARKER bearer eyJhbGciOi https://example.com/api?key=secret_123 prompt: "my private note"',
      },
    };
    for (const status of [400, 401, 403, 404, 429, 500]) {
      const fetchFn = mockFetch(() => errorResponse(status, upstreamSecretBody));
      const events = await collect(baseInput(geminiModel()), fetchFn);
      expect(events).toHaveLength(1);
      const json = JSON.stringify(events[0]);
      expect(json).not.toContain('DUMMY_SECRET_MARKER');
      expect(json).not.toContain('eyJhbGciOi');
      expect(json).not.toContain('https://example.com');
      expect(json).not.toContain('secret_123');
      expect(json).not.toContain('my private note');
    }

    const sseErrorStream = [
      'event: error\n',
      'data: {"error":{"code":"internal","message":"DUMMY_SECRET_MARKER https://example.com/leak prompt: secret"}}\n\n',
    ].join('');
    const sseFetch = mockFetch(() => chunkedResponse([sseErrorStream]));
    const sseEvents = await collect(baseInput(geminiModel()), sseFetch);
    const sseJson = JSON.stringify(sseEvents);
    expect(sseJson).not.toContain('DUMMY_SECRET_MARKER');
    expect(sseJson).not.toContain('https://example.com');
  });

  it('serializes historical function_call with id and function_result with call_id while preserving valid {} (P1 regression)', async () => {
    const fetchFn = mockFetch(() => chunkedResponse([TEXT_STREAM]));
    const input = baseInput(geminiModel(), {
      messages: [
        { role: 'user', text: 'Run tools' },
        {
          role: 'assistant',
          toolCalls: [
            { id: 'call_A', name: 'tool_a', arguments: '{"value":"A"}' },
            { id: 'call_empty', name: 'tool_empty', arguments: '{}' },
          ],
        },
        { role: 'tool', toolCallId: 'call_A', name: 'tool_a', text: 'result_A' },
        { role: 'tool', toolCallId: 'call_empty', name: 'tool_empty', text: 'result_empty' },
      ],
      pendingToolResults: [],
    });
    await collect(input, fetchFn);
    expect(fetchFn.requests).toHaveLength(1);
    const body = fetchFn.requests[0]!.body as Record<string, unknown>;
    const blocks = body['input'] as Array<Record<string, unknown>>;

    const callA = blocks.find((b) => b['type'] === 'function_call' && b['name'] === 'tool_a');
    expect(callA).toBeDefined();
    expect(callA!['id']).toBe('call_A');
    expect(callA!['call_id']).toBeUndefined();
    expect(callA!['arguments']).toEqual({ value: 'A' });

    const callEmpty = blocks.find((b) => b['type'] === 'function_call' && b['name'] === 'tool_empty');
    expect(callEmpty).toBeDefined();
    expect(callEmpty!['id']).toBe('call_empty');
    expect(callEmpty!['call_id']).toBeUndefined();
    expect(callEmpty!['arguments']).toEqual({});

    const resA = blocks.find((b) => b['type'] === 'function_result' && b['name'] === 'tool_a');
    expect(resA).toBeDefined();
    expect(resA!['call_id']).toBe('call_A');
    expect(resA!['id']).toBeUndefined();
    expect(resA!['result']).toEqual([{ type: 'text', text: 'result_A' }]);
  });

  it('rejects malformed or non-object historical arguments before fetch with 0 network calls (P1 regression)', async () => {
    for (const badArgs of ['NOT_VALID_JSON', '', '123', '[1, 2]', 'null']) {
      const fetchFn = mockFetch(() => chunkedResponse([TEXT_STREAM]));
      const input = baseInput(geminiModel(), {
        messages: [
          {
            role: 'assistant',
            toolCalls: [{ id: 'call_bad', name: 'tool_bad', arguments: badArgs }],
          },
        ],
      });
      await expect(async () => {
        for await (const event of adapterFor(fetchFn).streamTurn(input)) {
          void event;
        }
      }).rejects.toMatchObject({ detail: { code: 'invalid_request' } });
      expect(fetchFn.requests).toHaveLength(0);
    }
  });

  it('deduplicates function_result blocks on wire when tool result appears in both messages and pendingToolResults (R2-05 regression)', async () => {
    const fetchFn = mockFetch(() => chunkedResponse([TEXT_STREAM]));
    const input = baseInput(geminiModel(), {
      messages: [
        { role: 'user', text: 'Run tool' },
        {
          role: 'assistant',
          toolCalls: [{ id: 'call_dup_1', name: 'my_tool', arguments: '{"x":1}' }],
        },
        { role: 'tool', toolCallId: 'call_dup_1', name: 'my_tool', text: 'result_from_msg' },
      ],
      pendingToolResults: [
        { callId: 'call_dup_1', name: 'my_tool', resultText: 'result_from_pending' },
      ],
    });
    await collect(input, fetchFn);
    expect(fetchFn.requests).toHaveLength(1);
    const body = fetchFn.requests[0]!.body as Record<string, unknown>;
    const blocks = body['input'] as Array<Record<string, unknown>>;

    const resultsForCall = blocks.filter((b) => b['type'] === 'function_result' && b['call_id'] === 'call_dup_1');
    expect(resultsForCall).toHaveLength(1);
  });

  describe('thinking controls', () => {
    it('sets generation_config.thinking_level when gemini_level is specified', async () => {
      const fetchFn = mockFetch(() => chunkedResponse([TEXT_STREAM]));
      const input = baseInput(geminiModel(), {
        thinking: { kind: 'gemini_level', level: 'high' },
      });
      await collect(input, fetchFn);
      expect(fetchFn.requests).toHaveLength(1);
      const body = fetchFn.requests[0]!.body as Record<string, unknown>;
      const genConfig = body['generation_config'] as Record<string, unknown>;
      expect(genConfig).toBeDefined();
      expect(genConfig['thinking_level']).toBe('high');
      expect(genConfig['max_output_tokens']).toBe(512);
    });

    it('omits thinking_level when provider_default is specified or omitted', async () => {
      const fetchFn = mockFetch(() => chunkedResponse([TEXT_STREAM]));
      const input = baseInput(geminiModel(), {
        thinking: { kind: 'provider_default' },
      });
      await collect(input, fetchFn);
      expect(fetchFn.requests).toHaveLength(1);
      const body = fetchFn.requests[0]!.body as Record<string, unknown>;
      const genConfig = body['generation_config'] as Record<string, unknown>;
      expect(genConfig['thinking_level']).toBeUndefined();
    });

    it('rejects incompatible thinking kind before fetch with 0 network calls', async () => {
      const fetchFn = mockFetch(() => chunkedResponse([TEXT_STREAM]));
      const input = baseInput(geminiModel(), {
        // @ts-expect-error test invalid request kind
        thinking: { kind: 'go_chat_effort', effort: 'high' },
      });
      await expect(async () => {
        for await (const event of adapterFor(fetchFn).streamTurn(input)) {
          void event;
        }
      }).rejects.toMatchObject({ detail: { code: 'invalid_request' } });
      expect(fetchFn.requests).toHaveLength(0);
    });

    it('rejects unverified level before fetch with 0 network calls', async () => {
      const fetchFn = mockFetch(() => chunkedResponse([TEXT_STREAM]));
      const input = baseInput(geminiModel(), {
        thinking: { kind: 'gemini_level', level: 'xhigh' },
      });
      await expect(async () => {
        for await (const event of adapterFor(fetchFn).streamTurn(input)) {
          void event;
        }
      }).rejects.toMatchObject({ detail: { code: 'invalid_request' } });
      expect(fetchFn.requests).toHaveLength(0);
    });
  });
});
