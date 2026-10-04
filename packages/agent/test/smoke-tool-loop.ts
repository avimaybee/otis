/**
 * Shared validator and execution harness for live and deterministic smoke tool loops.
 * Enforces strict validation of all tool calls in all rounds and preserves user context.
 */

import type {
  ProviderAdapter,
  ProviderEvent,
  ProviderMessage,
  ResolvedModel,
  ToolResultBlock,
  TurnInput,
} from '../src/index.js';

export const SMOKE_TOOL = {
  name: 'echo_fixture',
  description: 'Echoes a synthetic fixture identifier for smoke verification.',
  parameters: {
    type: 'object',
    properties: { fixture_id: { type: 'string' } },
    required: ['fixture_id'],
  },
};

export const STATIC_PREFIX =
  'Otis provider smoke 005. Static prefix for cache comparison. ' +
  'Neutral fabricated content with no customer data. '.repeat(8);

export const SMOKE_CONTEXT_MARKER = '[marker:smoke-fixture-context]';

export interface ValidatedSmokeToolCall {
  callId: string;
  name: string;
  args: { fixture_id: string };
}

/**
 * Validates tool calls emitted during a smoke turn:
 * - Non-empty array of calls
 * - Unique, non-empty callId for every call
 * - Tool name must be exactly 'echo_fixture'
 * - Arguments must be an object with fixture_id === 'smoke-1'
 * Throws immediately on any violation; never fabricates arguments or results.
 */
export function validateSmokeToolCalls(
  toolCalls: Array<{ callId?: string; name?: string; args?: unknown }>,
): ValidatedSmokeToolCall[] {
  if (toolCalls.length === 0) {
    throw new Error('Tool turn emitted zero tool calls.');
  }
  const seenIds = new Set<string>();
  const validated: ValidatedSmokeToolCall[] = [];

  for (const call of toolCalls) {
    if (!call.callId || typeof call.callId !== 'string' || !call.callId.trim()) {
      throw new Error(`Tool call has missing or invalid callId: '${call.callId}'.`);
    }
    if (seenIds.has(call.callId)) {
      throw new Error(`Duplicate tool call ID '${call.callId}' in tool turn.`);
    }
    seenIds.add(call.callId);

    if (call.name !== 'echo_fixture') {
      throw new Error(`Unexpected tool name '${call.name}'; expected 'echo_fixture'.`);
    }

    if (
      !call.args ||
      typeof call.args !== 'object' ||
      Array.isArray(call.args) ||
      typeof (call.args as Record<string, unknown>)['fixture_id'] !== 'string' ||
      (call.args as Record<string, unknown>)['fixture_id'] !== 'smoke-1'
    ) {
      throw new Error(
        `Tool call '${call.callId}' has invalid arguments; expected { fixture_id: 'smoke-1' }, got: ${JSON.stringify(call.args)}`,
      );
    }

    validated.push({
      callId: call.callId,
      name: call.name,
      args: { fixture_id: (call.args as Record<string, unknown>)['fixture_id'] as string },
    });
  }

  return validated;
}

export interface SmokeToolLoopResult {
  initialTurn: { events: ProviderEvent[]; ms: number };
  finalTurn: { events: ProviderEvent[]; ms: number };
  continuationSteps: number;
  validatedCallCount: number;
}

/**
 * Executes a bounded tool continuation loop:
 * - Up to maxContinuationSteps (default 3) continuation steps.
 * - Validates every call before producing its tool result.
 * - Formulates results strictly from validated calls (no fabricated fallback).
 * - Preserves complete user instruction history with SMOKE_CONTEXT_MARKER.
 * - Enforces final success with text deltas.
 */
export async function executeSmokeToolLoop(params: {
  adapter: ProviderAdapter;
  baseInput: Omit<TurnInput, 'model'>;
  model: ResolvedModel;
  maxContinuationSteps?: number;
  drain: (input: TurnInput) => Promise<{ events: ProviderEvent[]; ms: number }>;
  logStage?: (stage: string, result: { events: ProviderEvent[]; ms: number }) => void;
}): Promise<SmokeToolLoopResult> {
  const maxSteps = params.maxContinuationSteps ?? 3;
  const initialUserPrompt = `${STATIC_PREFIX} Call the echo fixture with id smoke-1. ${SMOKE_CONTEXT_MARKER}`;

  // 1. Initial tool turn
  const initialTurn = await params.drain({
    ...params.baseInput,
    model: params.model,
    requestId: 'smoke-req-2',
    messages: [{ role: 'user', text: initialUserPrompt }],
    tools: [SMOKE_TOOL],
  });
  params.logStage?.('tool_initial', initialTurn);

  const initialToolCalls = initialTurn.events.filter(
    (e): e is Extract<ProviderEvent, { type: 'tool_call_end' }> => e.type === 'tool_call_end',
  );
  // Validate initial calls immediately!
  const initialValidated = validateSmokeToolCalls(initialToolCalls);
  let validatedCallCount = initialValidated.length;

  const initialFinish = initialTurn.events.find(
    (e): e is Extract<ProviderEvent, { type: 'finish' }> => e.type === 'finish',
  );
  if (!initialFinish || initialFinish.reason !== 'tool_handoff') {
    throw new Error(`Expected initial turn finish reason 'tool_handoff', got '${initialFinish?.reason}'.`);
  }

  let currentValidatedCalls = initialValidated;
  let continuationStep = 0;
  let currentContinuation = initialFinish.continuation;

  // Complete conversation history for stateless models (preserves original prompt with marker)
  const conversationMessages: ProviderMessage[] = [
    { role: 'user', text: initialUserPrompt },
  ];

  while (continuationStep < maxSteps) {
    continuationStep++;
    // Formulate results strictly from validated calls (no fabricated fallback)
    const pendingToolResults: ToolResultBlock[] = currentValidatedCalls.map((c) => ({
      callId: c.callId,
      name: c.name,
      resultText: JSON.stringify(c.args),
      arguments: c.args,
    }));

    // Preserve complete user instruction history for stateless adapters and
    // provide the genuinely new follow-up for linked stateful continuations.
    const followUp: ProviderMessage = {
      role: 'user',
      text: `${STATIC_PREFIX} Summarize the fixture result. ${SMOKE_CONTEXT_MARKER}`,
    };
    const stepMessages: ProviderMessage[] = [...conversationMessages, followUp];

    const nextTurn = await params.drain({
      ...params.baseInput,
      model: params.model,
      requestId: `smoke-req-${2 + continuationStep}`,
      messages: stepMessages,
      continuationInput: [followUp],
      tools: [SMOKE_TOOL],
      pendingToolResults,
      previousContinuation: currentContinuation,
    });
    params.logStage?.(`continuation_step_${continuationStep}`, nextTurn);

    const err = nextTurn.events.find((e): e is Extract<ProviderEvent, { type: 'error' }> => e.type === 'error');
    if (err) {
      throw new Error(`Smoke continuation step ${continuationStep} failed: ${err.error.code} - ${err.error.message}`);
    }

    const finish = nextTurn.events.find(
      (e): e is Extract<ProviderEvent, { type: 'finish' }> => e.type === 'finish',
    );
    if (!finish) {
      throw new Error(`Smoke continuation step ${continuationStep} ended without a finish event.`);
    }

    if (finish.reason === 'success') {
      const textDeltas = nextTurn.events.filter((e) => e.type === 'text_delta');
      if (textDeltas.length === 0) {
        throw new Error(`Smoke continuation finished with 'success' but produced zero text deltas.`);
      }
      return {
        initialTurn,
        finalTurn: nextTurn,
        continuationSteps: continuationStep,
        validatedCallCount,
      };
    }

    if (finish.reason === 'tool_handoff') {
      const calls = nextTurn.events.filter(
        (e): e is Extract<ProviderEvent, { type: 'tool_call_end' }> => e.type === 'tool_call_end',
      );
      // Validate EVERY call in this handoff turn before continuing!
      const validated = validateSmokeToolCalls(calls);
      validatedCallCount += validated.length;
      currentValidatedCalls = validated;
      currentContinuation = finish.continuation;
      continue;
    }

    throw new Error(`Unexpected finish reason '${finish.reason}' in continuation step ${continuationStep}.`);
  }

  throw new Error(`Smoke tool loop exhausted ${maxSteps} continuation steps without reaching final success.`);
}
