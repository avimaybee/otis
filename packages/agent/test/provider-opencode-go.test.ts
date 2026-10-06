import { describe, expect, it } from 'vitest';
import {
  GO_CHAT_COMPLETIONS_URL,
  GO_MODELS_URL,
  GO_RESPONSES_URL,
  OpenCodeGoAdapter,
  probeGoCredential,
} from '../src/providers/opencode-go.js';
import type { ProviderEvent, ServerContinuation } from '../src/providers/types.js';
import { ProviderErrorException } from '../src/providers/types.js';
import { baseInput, chunkedResponse, errorResponse, goChatModel, goResponsesModel, mockFetch } from './helpers.js';

function chatAdapter(fetchFn: ReturnType<typeof mockFetch>): OpenCodeGoAdapter {
  return new OpenCodeGoAdapter({ fetchFn, apiKey: 'test-go-key', endpointFamily: 'go-chat-completions' });
}

function responsesAdapter(fetchFn: ReturnType<typeof mockFetch>): OpenCodeGoAdapter {
  return new OpenCodeGoAdapter({ fetchFn, apiKey: 'test-go-key', endpointFamily: 'go-responses' });
}

const CHAT_STREAM = [
  'data: {"choices":[{"delta":{"content":"Hi "}}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"echo_fixture","arguments":"{\\"fixture_id\\""}}]}}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"a\\"}"}}]}}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_2","function":{"name":"echo_fixture","arguments":"{\\"fixture_id\\":\\"b\\"}"}}]}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":40,"completion_tokens":12,"total_tokens":52,"prompt_tokens_details":{"cached_tokens":30}}}\n\n',
  'data: [DONE]\n\n',
].join('');

const RESPONSES_STREAM = [
  'event: response.output_text.delta\n',
  'data: {"delta":"Answer: "}\n\n',
  'event: response.output_item.added\n',
  'data: {"output_index":1,"item":{"type":"function_call","call_id":"call_r1","name":"echo_fixture","arguments":""}}\n\n',
  'event: response.function_call_arguments.delta\n',
  'data: {"output_index":1,"delta":"{\\"fixture_id\\":\\"z\\"}"}\n\n',
  'event: response.output_item.done\n',
  'data: {"output_index":1,"item":{"type":"function_call","call_id":"call_r1","name":"echo_fixture","arguments":"{\\"fixture_id\\":\\"z\\"}"}}\n\n',
  'event: response.completed\n',
  'data: {"response":{"id":"resp_1","status":"completed","usage":{"input_tokens":20,"output_tokens":9,"total_tokens":29,"input_tokens_details":{"cached_tokens":12},"output_tokens_details":{"reasoning_tokens":3}}}}\n\n',
].join('');

describe('OpenCode Go chat completions adapter', () => {
  it('invokes transport without a receiver (Workers Illegal-invocation safe)', async () => {
    let observedThis: unknown = 'unset';
    async function receiverCheckingFetch(this: unknown, _url: string, _init: RequestInit): Promise<Response> {
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- observing the invocation receiver is the assertion.
      observedThis = this;
      return chunkedResponse([CHAT_STREAM]);
    }
    const events: ProviderEvent[] = [];
    const adapter = new OpenCodeGoAdapter({
      fetchFn: receiverCheckingFetch as unknown as ReturnType<typeof mockFetch>,
      apiKey: 'test-go-key',
      endpointFamily: 'go-chat-completions',
    });
    for await (const event of adapter.streamTurn(baseInput(goChatModel()))) events.push(event);
    expect(events[events.length - 1]).toMatchObject({ type: 'finish' });
    // A member invocation (this.fetchFn) would surface the adapter instance
    // here and throw Illegal invocation against native Workers fetch.
    expect(observedThis).toBeUndefined();
  });

  it('sends the documented endpoint, headers, and OpenAI body shape', async () => {
    const fetchFn = mockFetch(() => chunkedResponse([CHAT_STREAM]));
    const events: ProviderEvent[] = [];
    for await (const event of chatAdapter(fetchFn).streamTurn(baseInput(goChatModel()))) events.push(event);

    expect(fetchFn.requests).toHaveLength(1);
    const request = fetchFn.requests[0]!;
    expect(request.url).toBe(GO_CHAT_COMPLETIONS_URL);
    expect(request.headers['authorization']).toBe('Bearer test-go-key');
    expect(request.headers['x-opencode-session']).toBe('sess_workspace_chat');
    expect(request.headers['user-agent']).toMatch(/^otis\//);
    const body = request.body as Record<string, unknown>;
    expect(body['model']).toBe('mimo-v2.5');
    expect(body['stream']).toBe(true);
    expect(body['messages']).toEqual([{ role: 'user', content: 'Hello' }]);

    expect(events.filter((event) => event.type === 'tool_call_end')).toEqual([
      { type: 'tool_call_end', callId: 'call_1', name: 'echo_fixture', args: { fixture_id: 'a' } },
      { type: 'tool_call_end', callId: 'call_2', name: 'echo_fixture', args: { fixture_id: 'b' } },
    ]);
    expect(events.find((event) => event.type === 'usage')).toMatchObject({
      usage: { inputTokens: 40, outputTokens: 12, cacheReadTokens: 30, cacheWriteTokens: null, totalTokens: 52 },
    });
    expect(events[events.length - 1]).toMatchObject({ type: 'finish', reason: 'tool_handoff' });
  });

  it('rejects a family mismatch instead of posting to the wrong endpoint', async () => {
    const fetchFn = mockFetch(() => chunkedResponse([CHAT_STREAM]));
    await expect(
      (async () => {
        for await (const event of chatAdapter(fetchFn).streamTurn(baseInput(goResponsesModel()))) {
          void event;
        }
      })(),
    ).rejects.toBeInstanceOf(ProviderErrorException);
    expect(fetchFn.requests).toHaveLength(0);
  });

  it('maps 401 and 429 without inventing reset times', async () => {
    const denied = mockFetch(() => errorResponse(401, { error: { message: 'Bad key.' } }));
    const deniedEvents: ProviderEvent[] = [];
    for await (const event of chatAdapter(denied).streamTurn(baseInput(goChatModel()))) deniedEvents.push(event);
    expect(deniedEvents[0]).toMatchObject({ type: 'error', error: { code: 'invalid_credential', retryAfterMs: null } });

    const capped = mockFetch(() => errorResponse(429, { error: { message: 'Cap reached.' } }));
    const cappedEvents: ProviderEvent[] = [];
    for await (const event of chatAdapter(capped).streamTurn(baseInput(goChatModel()))) cappedEvents.push(event);
    expect(cappedEvents[0]).toMatchObject({ type: 'error', error: { code: 'rate_limited', retryable: true } });
  });

  it('truncated chat stream produces zero executable calls and malformed_response (finding 1 regression)', async () => {
    const stream = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"create_task","arguments":"{\\"title\\":\\"buy milk\\"}"}}]}}]}\n\n',
      // Ends cleanly here (EOF), no finish_reason and no [DONE]
    ].join('');
    const fetchFn = mockFetch(() => chunkedResponse([stream]));
    const events: ProviderEvent[] = [];
    for await (const event of chatAdapter(fetchFn).streamTurn(baseInput(goChatModel()))) events.push(event);

    const callEnds = events.filter((e) => e.type === 'tool_call_end');
    expect(callEnds).toHaveLength(0);
    const lastEvent = events[events.length - 1];
    expect(lastEvent).toMatchObject({
      type: 'error',
      error: { code: 'malformed_response' },
    });
  });

  it('unfinished calls with finish_reason length or content_filter are not executed (finding 1 regression)', async () => {
    for (const [finishReason, expectedReason] of [
      ['length', 'length_limit'],
      ['content_filter', 'refusal_or_block'],
    ] as const) {
      const stream = [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"create_task","arguments":"{\\"title\\":\\"cut off"}}]}}]}\n\n',
        `data: {"choices":[{"delta":{},"finish_reason":"${finishReason}"}]}\n\n`,
        'data: [DONE]\n\n',
      ].join('');
      const fetchFn = mockFetch(() => chunkedResponse([stream]));
      const events: ProviderEvent[] = [];
      for await (const event of chatAdapter(fetchFn).streamTurn(baseInput(goChatModel()))) events.push(event);

      const callEnds = events.filter((e) => e.type === 'tool_call_end');
      expect(callEnds).toHaveLength(0);
      expect(events[events.length - 1]).toMatchObject({
        type: 'finish',
        reason: expectedReason,
      });
    }
  });

  it('continuation faithfully replays original assistant tool calls and exact arguments (finding 2 regression)', async () => {
    const fetchFn = mockFetch(() => chunkedResponse([CHAT_STREAM]));
    const input = baseInput(goChatModel(), {
      messages: [{ role: 'user', text: 'Plan tasks' }],
      pendingToolResults: [
        { callId: 'call_1', name: 'create_task', arguments: { title: 'First Task' }, resultText: '{"id":"t1"}' },
        { callId: 'call_2', name: 'create_task', arguments: JSON.stringify({ title: 'Second Task' }), resultText: '{"id":"t2"}' },
      ],
      previousContinuation: {
        kind: 'go-chat-completions',
        assistantToolCalls: [
          { id: 'call_1', name: 'create_task', arguments: '{"title":"First Task"}' },
          { id: 'call_2', name: 'create_task', arguments: '{"title":"Second Task"}' },
        ],
      },
    });
    const freshAdapter = chatAdapter(fetchFn);
    const events: ProviderEvent[] = [];
    for await (const event of freshAdapter.streamTurn(input)) events.push(event);

    expect(fetchFn.requests).toHaveLength(1);
    const outgoingMessages = (fetchFn.requests[0]!.body as Record<string, unknown>)['messages'] as Array<Record<string, unknown>>;
    const assistantMsg = outgoingMessages.find((m) => m['role'] === 'assistant');
    expect(assistantMsg).toBeDefined();
    const toolCalls = assistantMsg!['tool_calls'] as Array<Record<string, unknown>>;
    expect(toolCalls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'create_task', arguments: '{"title":"First Task"}' } },
      { id: 'call_2', type: 'function', function: { name: 'create_task', arguments: '{"title":"Second Task"}' } },
    ]);
    expect(JSON.stringify(assistantMsg)).not.toContain('"{}"');
  });

  it('sanitizes public errors without echoing upstream secrets or URLs (finding 6 regression)', async () => {
    const dummyUpstream = {
      error: {
        message: 'DUMMY_SECRET_MARKER bearer eyJhbGciOi https://opencode.ai/leak prompt: "private user prompt"',
      },
    };
    for (const status of [401, 403, 404, 429, 500]) {
      const fetchFn = mockFetch(() => errorResponse(status, dummyUpstream));
      const events: ProviderEvent[] = [];
      for await (const event of chatAdapter(fetchFn).streamTurn(baseInput(goChatModel()))) events.push(event);
      expect(events).toHaveLength(1);
      const json = JSON.stringify(events[0]);
      expect(json).not.toContain('DUMMY_SECRET_MARKER');
      expect(json).not.toContain('https://opencode.ai/leak');
      expect(json).not.toContain('private user prompt');
    }
  });

  it('rejects unknown Chat finish reason with no executable calls and typed error (finding 2 follow-up regression)', async () => {
    const unknownStream = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_u","function":{"name":"echo_fixture","arguments":"{\\"fixture_id\\":\\"u\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"unrecognized_custom_reason"}]}\n\n',
    ].join('');
    const fetchFn = mockFetch(() => chunkedResponse([unknownStream]));
    const events: ProviderEvent[] = [];
    for await (const e of chatAdapter(fetchFn).streamTurn(baseInput(goChatModel()))) events.push(e);
    expect(events.filter((e) => e.type === 'tool_call_end')).toHaveLength(0);
    expect(events[events.length - 1]).toMatchObject({
      type: 'error',
      error: { code: 'malformed_response' },
    });
  });

  it('retains complete ordered history across multiple tool rounds and subsequent turns without {} fabrication (finding 1 follow-up regression)', async () => {
    // Round 1: user prompt -> model yields tool call A
    const streamRound1 = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_A","function":{"name":"tool_a","arguments":"{\\"argA\\":\\"valA\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    ].join('');
    const fetch1 = mockFetch(() => chunkedResponse([streamRound1]));
    const events1: ProviderEvent[] = [];
    const input1 = baseInput(goChatModel());
    for await (const e of chatAdapter(fetch1).streamTurn(input1)) events1.push(e);

    const finish1 = events1.find((e) => e.type === 'finish');
    expect(finish1).toBeDefined();
    expect(finish1?.type === 'finish' && finish1.reason).toBe('tool_handoff');
    const cont1 = (finish1 as { continuation?: ServerContinuation }).continuation;
    expect(cont1?.assistantToolCalls).toEqual([
      { id: 'call_A', name: 'tool_a', arguments: '{"argA":"valA"}' },
    ]);

    // Round 2: fresh adapter instance, sends call A result -> model yields tool call B
    const streamRound2 = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_B","function":{"name":"tool_b","arguments":"{\\"argB\\":\\"valB\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    ].join('');
    const fetch2 = mockFetch(() => chunkedResponse([streamRound2]));
    const events2: ProviderEvent[] = [];
    const input2 = baseInput(goChatModel(), {
      pendingToolResults: [{ callId: 'call_A', name: 'tool_a', arguments: '{"argA":"valA"}', resultText: '{"result":"resA"}' }],
      previousContinuation: cont1,
    });
    for await (const e of chatAdapter(fetch2).streamTurn(input2)) events2.push(e);

    // Verify outgoing request 2 body contains user + call A + result A
    const req2Body = fetch2.requests[0]!.body as { messages: unknown[] };
    expect(req2Body.messages).toEqual([
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_A', type: 'function', function: { name: 'tool_a', arguments: '{"argA":"valA"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_A', content: '{"result":"resA"}' },
    ]);

    const finish2 = events2.find((e) => e.type === 'finish');
    expect(finish2?.type === 'finish' && finish2.reason).toBe('tool_handoff');
    const cont2 = (finish2 as { continuation?: ServerContinuation }).continuation;
    expect(cont2?.assistantToolCalls).toEqual([
      { id: 'call_B', name: 'tool_b', arguments: '{"argB":"valB"}' },
    ]);
    expect(cont2?.priorRounds).toHaveLength(1);
    expect(cont2?.priorRounds?.[0]?.assistantToolCalls[0]?.id).toBe('call_A');

    // Round 3: fresh adapter instance, sends call B result -> model yields final text response
    const streamRound3 = [
      'data: {"choices":[{"delta":{"content":"Done both tasks."}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    ].join('');
    const fetch3 = mockFetch(() => chunkedResponse([streamRound3]));
    const events3: ProviderEvent[] = [];
    const input3 = baseInput(goChatModel(), {
      pendingToolResults: [{ callId: 'call_B', name: 'tool_b', arguments: '{"argB":"valB"}', resultText: '{"result":"resB"}' }],
      previousContinuation: cont2,
    });
    for await (const e of chatAdapter(fetch3).streamTurn(input3)) events3.push(e);

    // Verify outgoing request 3 body contains user + call A + result A + call B + result B!
    const req3Body = fetch3.requests[0]!.body as { messages: unknown[] };
    expect(req3Body.messages).toEqual([
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_A', type: 'function', function: { name: 'tool_a', arguments: '{"argA":"valA"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_A', content: '{"result":"resA"}' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_B', type: 'function', function: { name: 'tool_b', arguments: '{"argB":"valB"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_B', content: '{"result":"resB"}' },
    ]);
    expect(events3[events3.length - 1]).toMatchObject({ type: 'finish', reason: 'success' });

    // Subsequent ordinary chat turn: new user message after prior multi-round turn
    const subsequentStream = [
      'data: {"choices":[{"delta":{"content":"Follow up answer."}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    ].join('');
    const fetchSubsequent = mockFetch(() => chunkedResponse([subsequentStream]));
    const inputSubsequent = baseInput(goChatModel(), {
      messages: [
        { role: 'user', text: 'Hello' },
        {
          role: 'assistant',
          toolCalls: [{ id: 'call_A', name: 'tool_a', arguments: '{"argA":"valA"}' }],
        },
        { role: 'tool', toolCallId: 'call_A', text: '{"result":"resA"}' },
        {
          role: 'assistant',
          toolCalls: [{ id: 'call_B', name: 'tool_b', arguments: '{"argB":"valB"}' }],
        },
        { role: 'tool', toolCallId: 'call_B', text: '{"result":"resB"}' },
        { role: 'assistant', text: 'Done both tasks.' },
        { role: 'user', text: 'Follow-up question' },
      ],
      pendingToolResults: [],
      previousContinuation: null,
    });
    const subsequentEvents: ProviderEvent[] = [];
    for await (const e of chatAdapter(fetchSubsequent).streamTurn(inputSubsequent)) subsequentEvents.push(e);

    const reqSubsequentBody = fetchSubsequent.requests[0]!.body as { messages: unknown[] };
    expect(reqSubsequentBody.messages).toEqual([
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_A', type: 'function', function: { name: 'tool_a', arguments: '{"argA":"valA"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_A', content: '{"result":"resA"}' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_B', type: 'function', function: { name: 'tool_b', arguments: '{"argB":"valB"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_B', content: '{"result":"resB"}' },
      { role: 'assistant', content: 'Done both tasks.' },
      { role: 'user', content: 'Follow-up question' },
    ]);

    // Missing original arguments rejects before transport (0 fetch calls)
    const fetchNoArgs = mockFetch(() => chunkedResponse([streamRound2]));
    const inputNoArgs = baseInput(goChatModel(), {
      pendingToolResults: [{ callId: 'call_missing', name: 'tool_x', arguments: null, resultText: 'res' }],
      previousContinuation: null,
    });
    await expect(async () => {
      for await (const event of chatAdapter(fetchNoArgs).streamTurn(inputNoArgs)) {
        void event;
      }
    }).rejects.toMatchObject({ detail: { code: 'invalid_request' } });
    expect(fetchNoArgs.requests).toHaveLength(0);
  });

  it('deduplicates a two-call fully represented round so grouped calls and results appear exactly once (P2 regression)', async () => {
    const stream = [
      'data: {"choices":[{"delta":{"content":"Done."}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    ].join('');
    const fetchFn = mockFetch(() => chunkedResponse([stream]));
    const input = baseInput(goChatModel(), {
      messages: [
        { role: 'user', text: 'Hello' },
        {
          role: 'assistant',
          toolCalls: [
            { id: 'call_A', name: 'tool_a', arguments: '{"argA":"valA"}' },
            { id: 'call_B', name: 'tool_b', arguments: '{"argB":"valB"}' },
          ],
        },
        { role: 'tool', toolCallId: 'call_A', text: '{"result":"resA"}' },
        { role: 'tool', toolCallId: 'call_B', text: '{"result":"resB"}' },
      ],
      pendingToolResults: [],
      previousContinuation: {
        kind: 'go-chat-completions',
        priorRounds: [
          {
            assistantToolCalls: [
              { id: 'call_A', name: 'tool_a', arguments: '{"argA":"valA"}' },
              { id: 'call_B', name: 'tool_b', arguments: '{"argB":"valB"}' },
            ],
            toolResults: [
              { callId: 'call_A', name: 'tool_a', arguments: '{"argA":"valA"}', resultText: '{"result":"resA"}' },
              { callId: 'call_B', name: 'tool_b', arguments: '{"argB":"valB"}', resultText: '{"result":"resB"}' },
            ],
          },
        ],
      },
    });

    for await (const event of chatAdapter(fetchFn).streamTurn(input)) void event;

    expect(fetchFn.requests).toHaveLength(1);
    const body = fetchFn.requests[0]!.body as { messages: Array<Record<string, unknown>> };

    const assistantMsgs = body.messages.filter((m) => m['role'] === 'assistant' && m['tool_calls']);
    expect(assistantMsgs).toHaveLength(1);
    expect(assistantMsgs[0]!['tool_calls']).toEqual([
      { id: 'call_A', type: 'function', function: { name: 'tool_a', arguments: '{"argA":"valA"}' } },
      { id: 'call_B', type: 'function', function: { name: 'tool_b', arguments: '{"argB":"valB"}' } },
    ]);

    const toolMsgs = body.messages.filter((m) => m['role'] === 'tool');
    expect(toolMsgs).toHaveLength(2);
    expect(toolMsgs.map((m) => m['tool_call_id'])).toEqual(['call_A', 'call_B']);
  });

  it('rejects partial overlap when message history contains only call A from an A+B prior round (P2 regression)', async () => {
    const fetchFn = mockFetch(() => chunkedResponse(['data: [DONE]\n\n']));
    const input = baseInput(goChatModel(), {
      messages: [
        { role: 'user', text: 'Hello' },
        {
          role: 'assistant',
          toolCalls: [{ id: 'call_A', name: 'tool_a', arguments: '{"argA":"valA"}' }],
        },
        { role: 'tool', toolCallId: 'call_A', text: '{"result":"resA"}' },
      ],
      pendingToolResults: [],
      previousContinuation: {
        kind: 'go-chat-completions',
        priorRounds: [
          {
            assistantToolCalls: [
              { id: 'call_A', name: 'tool_a', arguments: '{"argA":"valA"}' },
              { id: 'call_B', name: 'tool_b', arguments: '{"argB":"valB"}' },
            ],
            toolResults: [
              { callId: 'call_A', name: 'tool_a', arguments: '{"argA":"valA"}', resultText: '{"result":"resA"}' },
              { callId: 'call_B', name: 'tool_b', arguments: '{"argB":"valB"}', resultText: '{"result":"resB"}' },
            ],
          },
        ],
      },
    });

    await expect(async () => {
      for await (const event of chatAdapter(fetchFn).streamTurn(input)) void event;
    }).rejects.toMatchObject({ detail: { code: 'invalid_request' } });
    expect(fetchFn.requests).toHaveLength(0);
  });

  it('rejects partial overlap when message history contains only call A from an A+B pending round (P2 regression)', async () => {
    const fetchFn = mockFetch(() => chunkedResponse(['data: [DONE]\n\n']));
    const input = baseInput(goChatModel(), {
      messages: [
        { role: 'user', text: 'Hello' },
        {
          role: 'assistant',
          toolCalls: [{ id: 'call_A', name: 'tool_a', arguments: '{"argA":"valA"}' }],
        },
        { role: 'tool', toolCallId: 'call_A', text: '{"result":"resA"}' },
      ],
      pendingToolResults: [
        { callId: 'call_A', name: 'tool_a', arguments: '{"argA":"valA"}', resultText: '{"result":"resA"}' },
        { callId: 'call_B', name: 'tool_b', arguments: '{"argB":"valB"}', resultText: '{"result":"resB"}' },
      ],
      previousContinuation: {
        kind: 'go-chat-completions',
        assistantToolCalls: [
          { id: 'call_A', name: 'tool_a', arguments: '{"argA":"valA"}' },
          { id: 'call_B', name: 'tool_b', arguments: '{"argB":"valB"}' },
        ],
      },
    });

    await expect(async () => {
      for await (const event of chatAdapter(fetchFn).streamTurn(input)) void event;
    }).rejects.toMatchObject({ detail: { code: 'invalid_request' } });
    expect(fetchFn.requests).toHaveLength(0);
  });

  it('rejects partial overlap when assistant call is present in messages but its result is missing (P2 regression)', async () => {
    const fetchFn = mockFetch(() => chunkedResponse(['data: [DONE]\n\n']));
    const input = baseInput(goChatModel(), {
      messages: [
        { role: 'user', text: 'Hello' },
        {
          role: 'assistant',
          toolCalls: [{ id: 'call_A', name: 'tool_a', arguments: '{"argA":"valA"}' }],
        },
        // Notice: result for call_A is missing from messages!
      ],
      pendingToolResults: [],
      previousContinuation: {
        kind: 'go-chat-completions',
        priorRounds: [
          {
            assistantToolCalls: [{ id: 'call_A', name: 'tool_a', arguments: '{"argA":"valA"}' }],
            toolResults: [{ callId: 'call_A', name: 'tool_a', arguments: '{"argA":"valA"}', resultText: '{"result":"resA"}' }],
          },
        ],
      },
    });

    await expect(async () => {
      for await (const event of chatAdapter(fetchFn).streamTurn(input)) void event;
    }).rejects.toMatchObject({ detail: { code: 'invalid_request' } });
    expect(fetchFn.requests).toHaveLength(0);
  });

  it('emits tool results without duplicating assistant calls when entire assistant call group is in messages (P2 regression)', async () => {
    const stream = [
      'data: {"choices":[{"delta":{"content":"Done."}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    ].join('');
    const fetchFn = mockFetch(() => chunkedResponse([stream]));
    const input = baseInput(goChatModel(), {
      messages: [
        { role: 'user', text: 'Hello' },
        {
          role: 'assistant',
          toolCalls: [
            { id: 'call_A', name: 'tool_a', arguments: '{"argA":"valA"}' },
            { id: 'call_B', name: 'tool_b', arguments: '{"argB":"valB"}' },
          ],
        },
        // Tool results are NOT in messages; they are pending
      ],
      pendingToolResults: [
        { callId: 'call_A', name: 'tool_a', arguments: '{"argA":"valA"}', resultText: '{"result":"resA"}' },
        { callId: 'call_B', name: 'tool_b', arguments: '{"argB":"valB"}', resultText: '{"result":"resB"}' },
      ],
      previousContinuation: {
        kind: 'go-chat-completions',
        assistantToolCalls: [
          { id: 'call_A', name: 'tool_a', arguments: '{"argA":"valA"}' },
          { id: 'call_B', name: 'tool_b', arguments: '{"argB":"valB"}' },
        ],
      },
    });

    for await (const event of chatAdapter(fetchFn).streamTurn(input)) void event;

    expect(fetchFn.requests).toHaveLength(1);
    const body = fetchFn.requests[0]!.body as { messages: Array<Record<string, unknown>> };

    // Assistant call group is present once
    const assistantMsgs = body.messages.filter((m) => m['role'] === 'assistant' && m['tool_calls']);
    expect(assistantMsgs).toHaveLength(1);
    expect(assistantMsgs[0]!['tool_calls']).toEqual([
      { id: 'call_A', type: 'function', function: { name: 'tool_a', arguments: '{"argA":"valA"}' } },
      { id: 'call_B', type: 'function', function: { name: 'tool_b', arguments: '{"argB":"valB"}' } },
    ]);

    // Tool results are emitted once
    const toolMsgs = body.messages.filter((m) => m['role'] === 'tool');
    expect(toolMsgs).toHaveLength(2);
    expect(toolMsgs.map((m) => m['tool_call_id'])).toEqual(['call_A', 'call_B']);
  });

  it('rejects incomplete pending results when assistant calls A+B only receive result A before fetch (P2 regression)', async () => {
    const fetchFn = mockFetch(() => chunkedResponse(['data: [DONE]\n\n']));
    const input = baseInput(goChatModel(), {
      pendingToolResults: [
        { callId: 'call_A', name: 'tool_a', arguments: '{"argA":"valA"}', resultText: '{"result":"resA"}' },
      ],
      previousContinuation: {
        kind: 'go-chat-completions',
        assistantToolCalls: [
          { id: 'call_A', name: 'tool_a', arguments: '{"argA":"valA"}' },
          { id: 'call_B', name: 'tool_b', arguments: '{"argB":"valB"}' },
        ],
      },
    });

    await expect(async () => {
      for await (const event of chatAdapter(fetchFn).streamTurn(input)) {
        void event;
      }
    }).rejects.toMatchObject({ detail: { code: 'invalid_request' } });
    expect(fetchFn.requests).toHaveLength(0);
  });
});

describe('OpenCode Go responses adapter (mocked OpenAI Responses shape)', () => {
  it('decodes text, function calls, usage, and the response continuation', async () => {
    const fetchFn = mockFetch(() => chunkedResponse([RESPONSES_STREAM]));
    const events: ProviderEvent[] = [];
    for await (const event of responsesAdapter(fetchFn).streamTurn(baseInput(goResponsesModel()))) events.push(event);

    expect(fetchFn.requests[0]!.url).toBe(GO_RESPONSES_URL);
    const body = fetchFn.requests[0]!.body as Record<string, unknown>;
    expect(body['model']).toBe('muse-spark-1.3-contributor');
    expect(body['stream']).toBe(true);

    expect(events).toContainEqual({ type: 'text_delta', text: 'Answer: ' });
    expect(events).toContainEqual({
      type: 'tool_call_end',
      callId: 'call_r1',
      name: 'echo_fixture',
      args: { fixture_id: 'z' },
    });
    expect(events.find((event) => event.type === 'usage')).toMatchObject({
      usage: { inputTokens: 20, outputTokens: 9, cacheReadTokens: 12, reasoningTokens: 3, totalTokens: 29 },
    });
    expect(events[events.length - 1]).toMatchObject({
      type: 'finish',
      reason: 'tool_handoff',
      continuation: { kind: 'go-responses', previousResponseId: 'resp_1' },
    });
  });

  it('replays tool calls and results statelessly on Responses continuation', async () => {
    const fetchFn = mockFetch(() => chunkedResponse([RESPONSES_STREAM]));
    const events: ProviderEvent[] = [];
    const input = baseInput(goResponsesModel(), {
      pendingToolResults: [{ callId: 'call_r1', name: 'echo_fixture', resultText: '{"fixture_id":"z"}' }],
      previousContinuation: {
        kind: 'go-responses',
        previousResponseId: 'resp_0',
        assistantToolCalls: [{ id: 'call_r1', name: 'echo_fixture', arguments: '{"fixture_id":"z"}' }],
      },
    });
    for await (const event of responsesAdapter(fetchFn).streamTurn(input)) events.push(event);
    const body = fetchFn.requests[0]!.body as Record<string, unknown>;
    expect(body['previous_response_id']).toBeUndefined();
    expect(body['input']).toContainEqual({
      type: 'function_call',
      call_id: 'call_r1',
      name: 'echo_fixture',
      arguments: '{"fixture_id":"z"}',
    });
    expect(body['input']).toContainEqual({ type: 'function_call_output', call_id: 'call_r1', output: '{"fixture_id":"z"}' });
    expect(events[events.length - 1]!).toMatchObject({
      type: 'finish',
      reason: 'tool_handoff',
      continuation: {
        kind: 'go-responses',
        previousResponseId: 'resp_1',
        assistantToolCalls: [{ id: 'call_r1', name: 'echo_fixture', arguments: '{"fixture_id":"z"}' }],
      },
    });
  });

  it('rejects duplicate pending tool results in Responses before transport with 0 fetches', async () => {
    const fetchFn = mockFetch(() => chunkedResponse([RESPONSES_STREAM]));
    const input = baseInput(goResponsesModel(), {
      pendingToolResults: [
        { callId: 'call_A', name: 'echo_fixture', resultText: '{"fixture_id":"a"}' },
        { callId: 'call_A', name: 'echo_fixture', resultText: '{"fixture_id":"a"}' },
      ],
      previousContinuation: {
        kind: 'go-responses',
        previousResponseId: 'resp_0',
        assistantToolCalls: [{ id: 'call_A', name: 'echo_fixture', arguments: '{"fixture_id":"a"}' }],
      },
    });
    await expect(async () => {
      for await (const _ of responsesAdapter(fetchFn).streamTurn(input)) {
        // drain
      }
    }).rejects.toThrowError(/duplicate tool result/i);
    expect(fetchFn.requests).toHaveLength(0);
  });

  it('rejects completed prior round missing result for call B in Responses before transport with 0 fetches', async () => {
    const fetchFn = mockFetch(() => chunkedResponse([RESPONSES_STREAM]));
    const input = baseInput(goResponsesModel(), {
      pendingToolResults: [{ callId: 'call_C', name: 'echo_fixture', resultText: '{"fixture_id":"c"}' }],
      previousContinuation: {
        kind: 'go-responses',
        previousResponseId: 'resp_1',
        assistantToolCalls: [{ id: 'call_C', name: 'echo_fixture', arguments: '{"fixture_id":"c"}' }],
        priorRounds: [
          {
            assistantToolCalls: [
              { id: 'call_A', name: 'echo_fixture', arguments: '{"fixture_id":"a"}' },
              { id: 'call_B', name: 'echo_fixture', arguments: '{"fixture_id":"b"}' },
            ],
            toolResults: [
              { callId: 'call_A', name: 'echo_fixture', resultText: '{"fixture_id":"a"}' },
              // call_B result is missing!
            ],
          },
        ],
      },
    });
    await expect(async () => {
      for await (const _ of responsesAdapter(fetchFn).streamTurn(input)) {
        // drain
      }
    }).rejects.toThrowError(/missing tool result for tool call 'echo_fixture' \(call_B\)/i);
    expect(fetchFn.requests).toHaveLength(0);
  });

  it('rejects orphan result in completed prior round in Responses before transport with 0 fetches', async () => {
    const fetchFn = mockFetch(() => chunkedResponse([RESPONSES_STREAM]));
    const input = baseInput(goResponsesModel(), {
      pendingToolResults: [{ callId: 'call_C', name: 'echo_fixture', resultText: '{"fixture_id":"c"}' }],
      previousContinuation: {
        kind: 'go-responses',
        previousResponseId: 'resp_1',
        assistantToolCalls: [{ id: 'call_C', name: 'echo_fixture', arguments: '{"fixture_id":"c"}' }],
        priorRounds: [
          {
            assistantToolCalls: [{ id: 'call_A', name: 'echo_fixture', arguments: '{"fixture_id":"a"}' }],
            toolResults: [
              { callId: 'call_A', name: 'echo_fixture', resultText: '{"fixture_id":"a"}' },
              { callId: 'call_orphan', name: 'echo_fixture', resultText: '{"fixture_id":"orphan"}' },
            ],
          },
        ],
      },
    });
    await expect(async () => {
      for await (const _ of responsesAdapter(fetchFn).streamTurn(input)) {
        // drain
      }
    }).rejects.toThrowError(/does not correspond to any tool call/i);
    expect(fetchFn.requests).toHaveLength(0);
  });

  it('replays multi-round Responses continuation across fresh adapter instances retaining earlier results exactly once without previous_response_id', async () => {
    // Stream 1 returns tool call A
    const stream1 = [
      'event: response.output_item.added\n',
      'data: {"output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_A","name":"echo_fixture","arguments":""}}\n\n',
      'event: response.function_call_arguments.delta\n',
      'data: {"output_index":0,"delta":"{\\"id\\":\\"a\\"}"}\n\n',
      'event: response.output_item.done\n',
      'data: {"output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_A","name":"echo_fixture","arguments":"{\\"id\\":\\"a\\"}"}}\n\n',
      'event: response.completed\n',
      'data: {"response":{"id":"resp_1","status":"completed","usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}\n\n',
    ].join('');

    // Stream 2 returns tool call B
    const stream2 = [
      'event: response.output_item.added\n',
      'data: {"output_index":0,"item":{"type":"function_call","id":"fc_2","call_id":"call_B","name":"echo_fixture","arguments":""}}\n\n',
      'event: response.function_call_arguments.delta\n',
      'data: {"output_index":0,"delta":"{\\"id\\":\\"b\\"}"}\n\n',
      'event: response.output_item.done\n',
      'data: {"output_index":0,"item":{"type":"function_call","id":"fc_2","call_id":"call_B","name":"echo_fixture","arguments":"{\\"id\\":\\"b\\"}"}}\n\n',
      'event: response.completed\n',
      'data: {"response":{"id":"resp_2","status":"completed","usage":{"input_tokens":20,"output_tokens":10,"total_tokens":30}}}\n\n',
    ].join('');

    // Stream 3 returns final text
    const stream3 = [
      'event: response.output_text.delta\n',
      'data: {"delta":"Final summary."}\n\n',
      'event: response.completed\n',
      'data: {"response":{"id":"resp_3","status":"completed","usage":{"input_tokens":30,"output_tokens":15,"total_tokens":45}}}\n\n',
    ].join('');

    // Round 1
    const fetch1 = mockFetch(() => chunkedResponse([stream1]));
    const events1: ProviderEvent[] = [];
    for await (const e of responsesAdapter(fetch1).streamTurn(baseInput(goResponsesModel()))) events1.push(e);
    const finish1 = events1.find((e): e is Extract<ProviderEvent, { type: 'finish' }> => e.type === 'finish');
    expect(finish1?.reason).toBe('tool_handoff');

    // Round 2 (fresh adapter)
    const fetch2 = mockFetch(() => chunkedResponse([stream2]));
    const events2: ProviderEvent[] = [];
    const input2 = baseInput(goResponsesModel(), {
      pendingToolResults: [{ callId: 'call_A', name: 'echo_fixture', resultText: '{"id":"a"}' }],
      previousContinuation: finish1!.continuation,
    });
    for await (const e of responsesAdapter(fetch2).streamTurn(input2)) events2.push(e);
    const finish2 = events2.find((e): e is Extract<ProviderEvent, { type: 'finish' }> => e.type === 'finish');
    expect(finish2?.reason).toBe('tool_handoff');
    expect(finish2?.continuation?.kind).toBe('go-responses');
    expect((finish2?.continuation as { priorRounds?: unknown[] })?.priorRounds).toHaveLength(1);

    // Round 3 (fresh adapter)
    const fetch3 = mockFetch(() => chunkedResponse([stream3]));
    const events3: ProviderEvent[] = [];
    const input3 = baseInput(goResponsesModel(), {
      pendingToolResults: [{ callId: 'call_B', name: 'echo_fixture', resultText: '{"id":"b"}' }],
      previousContinuation: finish2!.continuation,
    });
    for await (const e of responsesAdapter(fetch3).streamTurn(input3)) events3.push(e);
    const finish3 = events3.find((e): e is Extract<ProviderEvent, { type: 'finish' }> => e.type === 'finish');
    expect(finish3?.reason).toBe('success');

    // Inspect request body of round 3:
    const reqBody3 = fetch3.requests[0]!.body as Record<string, unknown>;
    expect(reqBody3['previous_response_id']).toBeUndefined();
    const inputItems = reqBody3['input'] as Array<Record<string, unknown>>;
    const callA = inputItems.filter((i) => i['type'] === 'function_call' && i['call_id'] === 'call_A');
    const resA = inputItems.filter((i) => i['type'] === 'function_call_output' && i['call_id'] === 'call_A');
    const callB = inputItems.filter((i) => i['type'] === 'function_call' && i['call_id'] === 'call_B');
    const resB = inputItems.filter((i) => i['type'] === 'function_call_output' && i['call_id'] === 'call_B');

    expect(callA).toHaveLength(1);
    expect(resA).toHaveLength(1);
    expect(callB).toHaveLength(1);
    expect(resB).toHaveLength(1);
  });

  it('normalizes Responses incomplete (max_output_tokens and content_filter), failed, and truncated EOF distinctly (finding 9 regression)', async () => {
    // 1. response.incomplete with max_output_tokens
    const maxTokensStream = [
      'event: response.incomplete\n',
      'data: {"response":{"id":"resp_inc","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":10,"output_tokens":50,"total_tokens":60}}}\n\n',
    ].join('');
    const fetchMax = mockFetch(() => chunkedResponse([maxTokensStream]));
    const eventsMax: ProviderEvent[] = [];
    for await (const e of responsesAdapter(fetchMax).streamTurn(baseInput(goResponsesModel()))) eventsMax.push(e);
    expect(eventsMax.find((e) => e.type === 'usage')).toMatchObject({
      usage: { inputTokens: 10, outputTokens: 50, totalTokens: 60 },
    });
    expect(eventsMax[eventsMax.length - 1]).toMatchObject({
      type: 'finish',
      reason: 'length_limit',
      continuation: { kind: 'go-responses', previousResponseId: 'resp_inc' },
    });

    // 2. response.incomplete with content_filter
    const filterStream = [
      'event: response.incomplete\n',
      'data: {"response":{"id":"resp_flt","status":"incomplete","incomplete_details":{"reason":"content_filter"}}}\n\n',
    ].join('');
    const fetchFlt = mockFetch(() => chunkedResponse([filterStream]));
    const eventsFlt: ProviderEvent[] = [];
    for await (const e of responsesAdapter(fetchFlt).streamTurn(baseInput(goResponsesModel()))) eventsFlt.push(e);
    expect(eventsFlt[eventsFlt.length - 1]).toMatchObject({
      type: 'finish',
      reason: 'refusal_or_block',
    });

    // 3. response.failed
    const failedStream = [
      'event: response.failed\n',
      'data: {"response":{"id":"resp_fail","status":"failed","error":{"code":"server_error","message":"DUMMY_SECRET_MARKER"}}}\n\n',
    ].join('');
    const fetchFail = mockFetch(() => chunkedResponse([failedStream]));
    const eventsFail: ProviderEvent[] = [];
    for await (const e of responsesAdapter(fetchFail).streamTurn(baseInput(goResponsesModel()))) eventsFail.push(e);
    expect(eventsFail[eventsFail.length - 1]).toMatchObject({
      type: 'error',
      error: { code: 'transient' },
    });
    expect(JSON.stringify(eventsFail)).not.toContain('DUMMY_SECRET_MARKER');

    // 4. Truncated EOF without terminal event
    const truncatedStream = [
      'event: response.output_text.delta\n',
      'data: {"delta":"partial"}\n\n',
    ].join('');
    const fetchTrunc = mockFetch(() => chunkedResponse([truncatedStream]));
    const eventsTrunc: ProviderEvent[] = [];
    for await (const e of responsesAdapter(fetchTrunc).streamTurn(baseInput(goResponsesModel()))) eventsTrunc.push(e);
    expect(eventsTrunc[eventsTrunc.length - 1]).toMatchObject({
      type: 'error',
      error: { code: 'malformed_response' },
    });
  });

  it('Responses does not synthesize tool calls for incomplete output items at EOF and rejects unfinished completion (finding 1 and 2 regression)', async () => {
    const unclosedItemStream = [
      'event: response.output_item.added\n',
      'data: {"output_index":0,"item":{"type":"function_call","call_id":"call_unclosed","name":"echo_fixture","arguments":""}}\n\n',
      'event: response.function_call_arguments.delta\n',
      'data: {"output_index":0,"delta":"{\\"fixture_id\\":\\"partial"}\n\n',
      'event: response.completed\n',
      'data: {"response":{"id":"resp_no_done","status":"completed"}}\n\n',
    ].join('');
    const fetchFn = mockFetch(() => chunkedResponse([unclosedItemStream]));
    const events: ProviderEvent[] = [];
    for await (const e of responsesAdapter(fetchFn).streamTurn(baseInput(goResponsesModel()))) events.push(e);
    expect(events.filter((e) => e.type === 'tool_call_end')).toHaveLength(0);
    expect(events[events.length - 1]).toMatchObject({
      type: 'error',
      error: { code: 'malformed_response' },
    });
  });

  it('rejects bare [DONE] stream without terminal response event (finding 2 follow-up regression)', async () => {
    const fetchFn = mockFetch(() => chunkedResponse(['data: [DONE]\n\n']));
    const events: ProviderEvent[] = [];
    for await (const e of responsesAdapter(fetchFn).streamTurn(baseInput(goResponsesModel()))) events.push(e);
    expect(events).toEqual([
      {
        type: 'error',
        error: { code: 'malformed_response', message: expect.stringContaining('terminal response event'), retryable: false, retryAfterMs: null },
      },
    ]);
  });

  it('Responses usage preserves input_tokens_details and output_tokens_details with zero and null counts (finding 3 follow-up regression)', async () => {
    const usageStream = [
      'event: response.completed\n',
      'data: {"response":{"id":"resp_usage","status":"completed","usage":{"input_tokens":15,"output_tokens":0,"total_tokens":15,"input_tokens_details":{"cached_tokens":0},"output_tokens_details":{"reasoning_tokens":5}}}}\n\n',
    ].join('');
    const fetchFn = mockFetch(() => chunkedResponse([usageStream]));
    const events: ProviderEvent[] = [];
    for await (const e of responsesAdapter(fetchFn).streamTurn(baseInput(goResponsesModel()))) events.push(e);
    const usageEvent = events.find((e) => e.type === 'usage');
    expect(usageEvent).toMatchObject({
      usage: {
        inputTokens: 15,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: null,
        reasoningTokens: 5,
        totalTokens: 15,
      },
    });
  });
});

describe('Go credential probe', () => {
  it('hits models discovery with the session header and no prompt body', async () => {
    const fetchFn = mockFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const probe = await probeGoCredential(fetchFn, 'test-go-key', 'sess_workspace_chat');
    expect(probe).toEqual({ ok: true, status: 200 });
    expect(fetchFn.requests[0]!.url).toBe(GO_MODELS_URL);
    expect(fetchFn.requests[0]!.headers['authorization']).toBe('Bearer test-go-key');
  });
});

describe('OpenCode Go thinking controls', () => {
  it('sends reasoning_effort in chat completions body when go_chat_effort is specified', async () => {
    const fetchFn = mockFetch(() => chunkedResponse([CHAT_STREAM]));
    const input = baseInput(goChatModel(), {
      thinking: { kind: 'go_chat_effort', effort: 'high' },
    });
    for await (const event of chatAdapter(fetchFn).streamTurn(input)) {
      void event;
    }
    expect(fetchFn.requests).toHaveLength(1);
    const body = fetchFn.requests[0]!.body as Record<string, unknown>;
    expect(body['reasoning_effort']).toBe('high');
  });

  it('omits reasoning_effort in chat completions body when provider_default is specified', async () => {
    const fetchFn = mockFetch(() => chunkedResponse([CHAT_STREAM]));
    const input = baseInput(goChatModel(), {
      thinking: { kind: 'provider_default' },
    });
    for await (const event of chatAdapter(fetchFn).streamTurn(input)) {
      void event;
    }
    expect(fetchFn.requests).toHaveLength(1);
    const body = fetchFn.requests[0]!.body as Record<string, unknown>;
    expect(body['reasoning_effort']).toBeUndefined();
  });

  it('chat adapter rejects incompatible thinking kind before fetch with 0 requests', async () => {
    const fetchFn = mockFetch(() => chunkedResponse([CHAT_STREAM]));
    const input = baseInput(goChatModel(), {
      // @ts-expect-error test invalid kind
      thinking: { kind: 'gemini_level', level: 'high' },
    });
    await expect(async () => {
      for await (const event of chatAdapter(fetchFn).streamTurn(input)) {
        void event;
      }
    }).rejects.toMatchObject({ detail: { code: 'invalid_request' } });
    expect(fetchFn.requests).toHaveLength(0);
  });

  it('chat adapter rejects unsupported effort string before fetch with 0 requests', async () => {
    const fetchFn = mockFetch(() => chunkedResponse([CHAT_STREAM]));
    const input = baseInput(goChatModel(), {
      thinking: { kind: 'go_chat_effort', effort: 'super_high' },
    });
    await expect(async () => {
      for await (const event of chatAdapter(fetchFn).streamTurn(input)) {
        void event;
      }
    }).rejects.toMatchObject({ detail: { code: 'invalid_request' } });
    expect(fetchFn.requests).toHaveLength(0);
  });

  it('responses adapter permits provider_default and omits thinking parameters', async () => {
    const fetchFn = mockFetch(() => chunkedResponse([RESPONSES_STREAM]));
    const input = baseInput(goResponsesModel(), {
      thinking: { kind: 'provider_default' },
    });
    for await (const event of responsesAdapter(fetchFn).streamTurn(input)) {
      void event;
    }
    expect(fetchFn.requests).toHaveLength(1);
    const body = fetchFn.requests[0]!.body as Record<string, unknown>;
    expect(body['reasoning_effort']).toBeUndefined();
    expect(body['reasoning']).toBeUndefined();
  });

  it('responses adapter rejects a chat-family thinking kind before fetch with 0 requests', async () => {
    const fetchFn = mockFetch(() => chunkedResponse([RESPONSES_STREAM]));
    const input = baseInput(goResponsesModel(), {
      thinking: { kind: 'go_chat_effort', effort: 'high' },
    });
    await expect(async () => {
      for await (const event of responsesAdapter(fetchFn).streamTurn(input)) {
        void event;
      }
    }).rejects.toMatchObject({ detail: { code: 'invalid_request' } });
    expect(fetchFn.requests).toHaveLength(0);
  });

  it('responses adapter sends nested reasoning effort for go_responses_effort', async () => {
    const fetchFn = mockFetch(() => chunkedResponse([RESPONSES_STREAM]));
    const input = baseInput(goResponsesModel(), {
      thinking: { kind: 'go_responses_effort', effort: 'minimal' },
    });
    for await (const event of responsesAdapter(fetchFn).streamTurn(input)) {
      void event;
    }
    expect(fetchFn.requests).toHaveLength(1);
    const body = fetchFn.requests[0]!.body as Record<string, unknown>;
    expect(body['reasoning']).toEqual({ effort: 'minimal' });
    expect(body['reasoning_effort']).toBeUndefined();
  });

  it('responses adapter rejects an unknown effort string before fetch with 0 requests', async () => {
    const fetchFn = mockFetch(() => chunkedResponse([RESPONSES_STREAM]));
    const input = baseInput(goResponsesModel(), {
      thinking: { kind: 'go_responses_effort', effort: 'ultra' },
    });
    await expect(async () => {
      for await (const event of responsesAdapter(fetchFn).streamTurn(input)) {
        void event;
      }
    }).rejects.toMatchObject({ detail: { code: 'invalid_request' } });
    expect(fetchFn.requests).toHaveLength(0);
  });

  it('chat adapter accepts the full gateway effort enum, including edge values', async () => {
    for (const effort of ['minimal', 'max', 'none'] as const) {
      const fetchFn = mockFetch(() => chunkedResponse([CHAT_STREAM]));
      const input = baseInput(goChatModel(), {
        thinking: { kind: 'go_chat_effort', effort },
      });
      for await (const event of chatAdapter(fetchFn).streamTurn(input)) {
        void event;
      }
      expect(fetchFn.requests).toHaveLength(1);
      expect((fetchFn.requests[0]!.body as Record<string, unknown>)['reasoning_effort']).toBe(effort);
    }
  });

  it('responses adapter accepts gateway edge values max and none', async () => {
    for (const effort of ['max', 'none'] as const) {
      const fetchFn = mockFetch(() => chunkedResponse([RESPONSES_STREAM]));
      const input = baseInput(goResponsesModel(), {
        thinking: { kind: 'go_responses_effort', effort },
      });
      for await (const event of responsesAdapter(fetchFn).streamTurn(input)) {
        void event;
      }
      expect(fetchFn.requests).toHaveLength(1);
      expect((fetchFn.requests[0]!.body as Record<string, unknown>)['reasoning']).toEqual({ effort });
    }
  });
});
