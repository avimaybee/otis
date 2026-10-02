import { describe, expect, it } from 'vitest';
import {
  executeSmokeToolLoop,
  validateSmokeToolCalls,
  SMOKE_CONTEXT_MARKER,
  SMOKE_TOOL,
  type ValidatedSmokeToolCall,
} from './smoke-tool-loop.js';
import type {
  ProviderAdapter,
  ProviderEvent,
  ResolvedModel,
  TurnInput,
} from '../src/index.js';

describe('smoke tool call validator', () => {
  it('validates a correct echo_fixture call with fixture_id smoke-1', () => {
    const calls = [{ callId: 'call_1', name: 'echo_fixture', args: { fixture_id: 'smoke-1' } }];
    const validated = validateSmokeToolCalls(calls);
    expect(validated).toEqual<ValidatedSmokeToolCall[]>([
      { callId: 'call_1', name: 'echo_fixture', args: { fixture_id: 'smoke-1' } },
    ]);
  });

  it('rejects an empty tool calls array', () => {
    expect(() => validateSmokeToolCalls([])).toThrowError(/emitted zero tool calls/i);
  });

  it('rejects missing or empty callId', () => {
    expect(() =>
      validateSmokeToolCalls([{ callId: '', name: 'echo_fixture', args: { fixture_id: 'smoke-1' } }]),
    ).toThrowError(/missing or invalid callId/i);
    expect(() =>
      validateSmokeToolCalls([{ name: 'echo_fixture', args: { fixture_id: 'smoke-1' } }]),
    ).toThrowError(/missing or invalid callId/i);
  });

  it('rejects duplicate callId within the turn', () => {
    const calls = [
      { callId: 'call_1', name: 'echo_fixture', args: { fixture_id: 'smoke-1' } },
      { callId: 'call_1', name: 'echo_fixture', args: { fixture_id: 'smoke-1' } },
    ];
    expect(() => validateSmokeToolCalls(calls)).toThrowError(/duplicate tool call ID 'call_1'/i);
  });

  it('rejects unexpected tool name', () => {
    const calls = [{ callId: 'call_1', name: 'unexpected_tool', args: { fixture_id: 'smoke-1' } }];
    expect(() => validateSmokeToolCalls(calls)).toThrowError(/unexpected tool name 'unexpected_tool'/i);
  });

  it('rejects missing or null arguments', () => {
    expect(() =>
      validateSmokeToolCalls([{ callId: 'call_1', name: 'echo_fixture', args: null }]),
    ).toThrowError(/invalid arguments/i);
    expect(() =>
      validateSmokeToolCalls([{ callId: 'call_1', name: 'echo_fixture', args: undefined }]),
    ).toThrowError(/invalid arguments/i);
  });

  it('rejects arguments with wrong fixture_id or non-object type', () => {
    expect(() =>
      validateSmokeToolCalls([{ callId: 'call_1', name: 'echo_fixture', args: { fixture_id: 'wrong' } }]),
    ).toThrowError(/invalid arguments/i);
    expect(() =>
      validateSmokeToolCalls([{ callId: 'call_1', name: 'echo_fixture', args: 'not-an-object' }]),
    ).toThrowError(/invalid arguments/i);
    expect(() =>
      validateSmokeToolCalls([{ callId: 'call_1', name: 'echo_fixture', args: ['array'] }]),
    ).toThrowError(/invalid arguments/i);
  });
});

describe('smoke tool loop execution harness', () => {
  const fakeModel: ResolvedModel = {
    commandKey: 'fake-model',
    provider: 'opencode_go',
    modelId: 'mimo-v2.5',
    endpointFamily: 'go-chat-completions',
    endpointUrl: 'https://opencode.ai/zen/go/v1/chat/completions',
  };

  const fakeBaseInput: Omit<TurnInput, 'model'> = {
    sessionId: 'sess_smoke_test',
    workspaceId: 'ws_smoke',
    chatId: 'chat_smoke',
    runId: 'run_smoke',
    requestId: 'req_smoke',
    messages: [],
    pendingToolResults: [],
    previousContinuation: null,
    tools: [SMOKE_TOOL],
    maxOutputTokens: 256,
    timeoutMs: 5000,
  };

  function createMockAdapter(
    turnResponses: Array<(input: TurnInput) => ProviderEvent[]>,
  ): { adapter: ProviderAdapter; recordedInputs: TurnInput[] } {
    const recordedInputs: TurnInput[] = [];
    let turnIndex = 0;

    const adapter: ProviderAdapter = {
      async *streamTurn(input: TurnInput): AsyncIterable<ProviderEvent> {
        recordedInputs.push(input);
        const responder = turnResponses[turnIndex];
        if (!responder) throw new Error(`Unexpected turn request at index ${turnIndex}`);
        turnIndex++;
        const events = responder(input);
        for (const event of events) {
          yield event;
        }
      },
    };

    return { adapter, recordedInputs };
  }

  it('completes a valid one-round loop successfully', async () => {
    const { adapter, recordedInputs } = createMockAdapter([
      // Turn 1: initial tool call
      () => [
        { type: 'tool_call_start', callId: 'call_1', name: 'echo_fixture' },
        { type: 'tool_call_arguments', delta: '{"fixture_id":"smoke-1"}' },
        { type: 'tool_call_end', callId: 'call_1', name: 'echo_fixture', args: { fixture_id: 'smoke-1' } },
        { type: 'finish', reason: 'tool_handoff', continuation: { kind: 'go-chat' } },
      ],
      // Turn 2: continuation replies with text
      () => [
        { type: 'text_delta', text: 'Smoke fixture verified.' },
        { type: 'finish', reason: 'success' },
      ],
    ]);

    const result = await executeSmokeToolLoop({
      adapter,
      baseInput: fakeBaseInput,
      model: fakeModel,
      drain: async (input) => {
        const events: ProviderEvent[] = [];
        for await (const e of adapter.streamTurn(input)) events.push(e);
        return { events, ms: 10 };
      },
    });

    expect(result.continuationSteps).toBe(1);
    expect(result.validatedCallCount).toBe(1);
    expect(recordedInputs).toHaveLength(2);
    // User context is retained with context marker
    expect(recordedInputs[1]!.messages[0]!.text).toContain(SMOKE_CONTEXT_MARKER);
    expect(recordedInputs[1]!.pendingToolResults).toEqual([
      { callId: 'call_1', name: 'echo_fixture', resultText: '{"fixture_id":"smoke-1"}', arguments: { fixture_id: 'smoke-1' } },
    ]);
  });

  it('completes a valid multi-round loop successfully', async () => {
    const { adapter, recordedInputs } = createMockAdapter([
      // Turn 1: tool call 1
      () => [
        { type: 'tool_call_end', callId: 'call_1', name: 'echo_fixture', args: { fixture_id: 'smoke-1' } },
        { type: 'finish', reason: 'tool_handoff', continuation: { kind: 'gemini-interactions' } },
      ],
      // Turn 2: tool call 2
      () => [
        { type: 'tool_call_end', callId: 'call_2', name: 'echo_fixture', args: { fixture_id: 'smoke-1' } },
        { type: 'finish', reason: 'tool_handoff', continuation: { kind: 'gemini-interactions' } },
      ],
      // Turn 3: final text
      () => [
        { type: 'text_delta', text: 'All fixture rounds complete.' },
        { type: 'finish', reason: 'success' },
      ],
    ]);

    const result = await executeSmokeToolLoop({
      adapter,
      baseInput: fakeBaseInput,
      model: fakeModel,
      drain: async (input) => {
        const events: ProviderEvent[] = [];
        for await (const e of adapter.streamTurn(input)) events.push(e);
        return { events, ms: 10 };
      },
    });

    expect(result.continuationSteps).toBe(2);
    expect(result.validatedCallCount).toBe(2);
    expect(recordedInputs).toHaveLength(3);
  });

  it('rejects an unknown tool on a later step before producing a result or follow-up request', async () => {
    const { adapter, recordedInputs } = createMockAdapter([
      // Turn 1: valid tool call
      () => [
        { type: 'tool_call_end', callId: 'call_1', name: 'echo_fixture', args: { fixture_id: 'smoke-1' } },
        { type: 'finish', reason: 'tool_handoff', continuation: { kind: 'go-chat' } },
      ],
      // Turn 2: unexpected tool
      () => [
        { type: 'tool_call_end', callId: 'call_2', name: 'unexpected_tool', args: { fixture_id: 'smoke-1' } },
        { type: 'finish', reason: 'tool_handoff', continuation: { kind: 'go-chat' } },
      ],
      // Turn 3 should NEVER be reached!
      () => [
        { type: 'text_delta', text: 'Should never run' },
        { type: 'finish', reason: 'success' },
      ],
    ]);

    await expect(
      executeSmokeToolLoop({
        adapter,
        baseInput: fakeBaseInput,
        model: fakeModel,
        drain: async (input) => {
          const events: ProviderEvent[] = [];
          for await (const e of adapter.streamTurn(input)) events.push(e);
          return { events, ms: 10 };
        },
      }),
    ).rejects.toThrowError(/unexpected tool name 'unexpected_tool'/i);

    // Turn 3 was never called: exactly 2 turns occurred
    expect(recordedInputs).toHaveLength(2);
  });

  it('rejects wrong arguments on a later step before producing a result or follow-up request', async () => {
    const { adapter, recordedInputs } = createMockAdapter([
      // Turn 1: valid tool call
      () => [
        { type: 'tool_call_end', callId: 'call_1', name: 'echo_fixture', args: { fixture_id: 'smoke-1' } },
        { type: 'finish', reason: 'tool_handoff', continuation: { kind: 'go-chat' } },
      ],
      // Turn 2: wrong fixture_id
      () => [
        { type: 'tool_call_end', callId: 'call_2', name: 'echo_fixture', args: { fixture_id: 'invalid-id' } },
        { type: 'finish', reason: 'tool_handoff', continuation: { kind: 'go-chat' } },
      ],
    ]);

    await expect(
      executeSmokeToolLoop({
        adapter,
        baseInput: fakeBaseInput,
        model: fakeModel,
        drain: async (input) => {
          const events: ProviderEvent[] = [];
          for await (const e of adapter.streamTurn(input)) events.push(e);
          return { events, ms: 10 };
        },
      }),
    ).rejects.toThrowError(/invalid arguments/i);

    expect(recordedInputs).toHaveLength(2);
  });

  it('rejects missing arguments on a later step before producing a result or follow-up request', async () => {
    const { adapter, recordedInputs } = createMockAdapter([
      // Turn 1: valid
      () => [
        { type: 'tool_call_end', callId: 'call_1', name: 'echo_fixture', args: { fixture_id: 'smoke-1' } },
        { type: 'finish', reason: 'tool_handoff', continuation: { kind: 'go-chat' } },
      ],
      // Turn 2: missing args
      () => [
        { type: 'tool_call_end', callId: 'call_2', name: 'echo_fixture', args: undefined },
        { type: 'finish', reason: 'tool_handoff', continuation: { kind: 'go-chat' } },
      ],
    ]);

    await expect(
      executeSmokeToolLoop({
        adapter,
        baseInput: fakeBaseInput,
        model: fakeModel,
        drain: async (input) => {
          const events: ProviderEvent[] = [];
          for await (const e of adapter.streamTurn(input)) events.push(e);
          return { events, ms: 10 };
        },
      }),
    ).rejects.toThrowError(/invalid arguments/i);

    expect(recordedInputs).toHaveLength(2);
  });

  it('rejects a second invalid call in the first group immediately', async () => {
    const { adapter, recordedInputs } = createMockAdapter([
      // Turn 1: call 1 valid, call 2 invalid
      () => [
        { type: 'tool_call_end', callId: 'call_1', name: 'echo_fixture', args: { fixture_id: 'smoke-1' } },
        { type: 'tool_call_end', callId: 'call_2', name: 'unexpected_tool', args: { fixture_id: 'smoke-1' } },
        { type: 'finish', reason: 'tool_handoff', continuation: { kind: 'go-chat' } },
      ],
    ]);

    await expect(
      executeSmokeToolLoop({
        adapter,
        baseInput: fakeBaseInput,
        model: fakeModel,
        drain: async (input) => {
          const events: ProviderEvent[] = [];
          for await (const e of adapter.streamTurn(input)) events.push(e);
          return { events, ms: 10 };
        },
      }),
    ).rejects.toThrowError(/unexpected tool name 'unexpected_tool'/i);

    expect(recordedInputs).toHaveLength(1);
  });

  it('fails if the model exhausts max continuation steps without reaching success', async () => {
    const { adapter, recordedInputs } = createMockAdapter([
      // Initial
      () => [
        { type: 'tool_call_end', callId: 'call_1', name: 'echo_fixture', args: { fixture_id: 'smoke-1' } },
        { type: 'finish', reason: 'tool_handoff', continuation: { kind: 'gemini-interactions' } },
      ],
      // Step 1
      () => [
        { type: 'tool_call_end', callId: 'call_2', name: 'echo_fixture', args: { fixture_id: 'smoke-1' } },
        { type: 'finish', reason: 'tool_handoff', continuation: { kind: 'gemini-interactions' } },
      ],
      // Step 2
      () => [
        { type: 'tool_call_end', callId: 'call_3', name: 'echo_fixture', args: { fixture_id: 'smoke-1' } },
        { type: 'finish', reason: 'tool_handoff', continuation: { kind: 'gemini-interactions' } },
      ],
      // Step 3 (still requests tool handoff!)
      () => [
        { type: 'tool_call_end', callId: 'call_4', name: 'echo_fixture', args: { fixture_id: 'smoke-1' } },
        { type: 'finish', reason: 'tool_handoff', continuation: { kind: 'gemini-interactions' } },
      ],
    ]);

    await expect(
      executeSmokeToolLoop({
        adapter,
        baseInput: fakeBaseInput,
        model: fakeModel,
        maxContinuationSteps: 3,
        drain: async (input) => {
          const events: ProviderEvent[] = [];
          for await (const e of adapter.streamTurn(input)) events.push(e);
          return { events, ms: 10 };
        },
      }),
    ).rejects.toThrowError(/exhausted 3 continuation steps/i);

    expect(recordedInputs).toHaveLength(4);
  });
});
