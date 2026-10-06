/**
 * @otis/agent/providers/opencode-go
 * OpenCode Go adapter: Chat Completions and Responses endpoint families.
 *
 * Verified against https://opencode.ai/docs/go/ (checked 2026-10-01):
 * origin `https://opencode.ai/zen/go`, per-model endpoint paths, Bearer API
 * key, stable `x-opencode-session` per conversation, and a distinctive
 * User-Agent (`otis/0.1.0`). Only the families required by the selected
 * models are implemented; anything else returns unsupported_capability.
 *
 * Two honesty notes recorded here and in provider-capabilities.md:
 * - The Responses wire shape below follows the OpenAI Responses SSE
 *   protocol implied by the Go table (`@ai-sdk/openai`); it is mocked
 *   protocol evidence only until a live probe confirms the exact route.
 * - Go cap-exhaustion/usage response shapes are unverified; 429 maps to
 *   rate_limited with Retry-After when supplied, never invented.
 */

import { parseSseStream } from './sse.js';
import {
  MAX_TOOL_ARGUMENT_BYTES,
  OPENCODE_GO_ORIGIN,
  OTIS_USER_AGENT,
  emptyUsage,
  numOrNull,
  parseRetryAfterMs,
  type AdapterEnv,
  type AssistantToolCall,
  type FetchFn,
  type HistoricalToolRound,
  type ProviderAdapter,
  type ProviderError,
  type ProviderEvent,
  type ProviderUsage,
  type ToolDeclaration,
  type TurnInput,
} from './types.js';
import { ProviderErrorException, receiverSafeFetch } from './types.js';

export const GO_CHAT_COMPLETIONS_URL = `${OPENCODE_GO_ORIGIN}/v1/chat/completions`;
export const GO_RESPONSES_URL = `${OPENCODE_GO_ORIGIN}/v1/responses`;
export const GO_MODELS_URL = `${OPENCODE_GO_ORIGIN}/v1/models`;

function baseHeaders(apiKey: string, sessionId: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'x-opencode-session': sessionId,
    'User-Agent': OTIS_USER_AGENT,
  };
}

function httpError(provider: string, status: number, headers: Headers): ProviderError {
  const retryAfterMs = parseRetryAfterMs(headers.get('retry-after'));
  if (status === 401 || status === 403) {
    return {
      code: 'invalid_credential',
      message: `${provider} authentication failed; check your API key.`,
      retryable: false,
      retryAfterMs: null,
      status,
    };
  }
  if (status === 404) {
    return {
      code: 'unknown_model',
      message: `Requested ${provider} model was not found.`,
      retryable: false,
      retryAfterMs: null,
      status,
    };
  }
  if (status === 429) {
    return {
      code: 'rate_limited',
      message: `${provider} rate limit exceeded.`,
      retryable: true,
      retryAfterMs,
      status,
    };
  }
  if (status >= 500) {
    return {
      code: 'transient',
      message: `${provider} returned a server error (${status}).`,
      retryable: true,
      retryAfterMs,
      status,
    };
  }
  return {
    code: 'invalid_request',
    message: `${provider} request failed (${status}).`,
    retryable: false,
    retryAfterMs: null,
    status,
  };
}

function transportError(err: unknown): ProviderError {
  if (err instanceof Error) {
    if (err.name === 'AbortError') {
      return { code: 'aborted', message: 'Turn aborted.', retryable: false, retryAfterMs: null };
    }
    if (err.name === 'TimeoutError') {
      return { code: 'timeout', message: 'Provider request timed out.', retryable: true, retryAfterMs: null };
    }
  }
  return { code: 'transient', message: 'Provider transport failed.', retryable: true, retryAfterMs: null };
}


function validateTools(tools: ToolDeclaration[]): void {
  for (const tool of tools) {
    if (!tool.name || !/^[A-Za-z0-9_]+$/.test(tool.name)) {
      throw new ProviderErrorException({
        code: 'invalid_request',
        message: `Tool name '${tool.name}' is not supported.`,
        retryable: false,
        retryAfterMs: null,
      });
    }
    const params = tool.parameters as Record<string, unknown>;
    if (!params || typeof params !== 'object' || params['type'] !== 'object') {
      throw new ProviderErrorException({
        code: 'invalid_request',
        message: `Tool '${tool.name}' parameters must be an object schema.`,
        retryable: false,
        retryAfterMs: null,
      });
    }
  }
}

function linkSignal(input: TurnInput): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timeout = AbortSignal.timeout(input.timeoutMs);
  const onAbort = (): void => controller.abort(input.signal?.aborted ? input.signal.reason : timeout.reason);
  input.signal?.addEventListener('abort', onAbort, { once: true });
  timeout.addEventListener('abort', onAbort, { once: true });
  if (input.signal?.aborted || timeout.aborted) onAbort();
  return { signal: controller.signal, cancel: () => controller.abort() };
}

interface AccumulatedCall {
  id: string;
  name: string;
  argsText: string;
  /** True when the call arrived with complete arguments; later deltas ignored. */
  sealed: boolean;
}

function parseChatCompletionsUsage(raw: Record<string, unknown> | undefined): ProviderUsage {
  const promptDetails = raw?.['prompt_tokens_details'] as Record<string, unknown> | undefined;
  const completionDetails = raw?.['completion_tokens_details'] as Record<string, unknown> | undefined;
  return {
    inputTokens: numOrNull(raw?.['prompt_tokens']),
    outputTokens: numOrNull(raw?.['completion_tokens']),
    cacheReadTokens: numOrNull(promptDetails?.['cached_tokens']),
    cacheWriteTokens: null,
    reasoningTokens: numOrNull(completionDetails?.['reasoning_tokens']) ?? numOrNull(raw?.['reasoning_tokens']),
    totalTokens: numOrNull(raw?.['total_tokens']),
    cumulative: true,
  };
}

function parseResponsesUsage(raw: Record<string, unknown> | undefined): ProviderUsage {
  const inputDetails = (raw?.['input_tokens_details'] ?? raw?.['input_token_details']) as
    | Record<string, unknown>
    | undefined;
  const outputDetails = (raw?.['output_tokens_details'] ?? raw?.['output_token_details']) as
    | Record<string, unknown>
    | undefined;
  return {
    inputTokens: numOrNull(raw?.['input_tokens']),
    outputTokens: numOrNull(raw?.['output_tokens']),
    cacheReadTokens: numOrNull(inputDetails?.['cached_tokens']),
    cacheWriteTokens: null,
    reasoningTokens: numOrNull(outputDetails?.['reasoning_tokens']),
    totalTokens: numOrNull(raw?.['total_tokens']),
    cumulative: true,
  };
}

async function* decodeChatCompletions(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  input?: TurnInput,
): AsyncGenerator<ProviderEvent> {
  const calls = new Map<number, AccumulatedCall>();
  const completedCalls: Array<{ id: string; name: string; argsText: string }> = [];
  const started = new Set<number>();
  let sawToolCall = false;
  let usage: ProviderUsage = emptyUsage();
  let sawUsage = false;
  let finishReason: string | null = null;

  const endCall = function* (
    index: number,
  ): Generator<{ type: 'tool_call_end'; callId: string; name: string; args: unknown } | { type: 'error'; error: ProviderError }> {
    const call = calls.get(index);
    calls.delete(index);
    if (!call || !call.id || !call.name) {
      yield {
        type: 'error',
        error: { code: 'malformed_response', message: 'Chat stream ended a tool call without id and name.', retryable: false, retryAfterMs: null },
      };
      return;
    }
    let args: unknown;
    try {
      args = call.argsText ? (JSON.parse(call.argsText) as unknown) : {};
    } catch {
      yield {
        type: 'error',
        error: {
          code: 'malformed_response',
          message: `Tool call '${call.name}' returned unparseable arguments; not exposed as executable.`,
          retryable: false,
          retryAfterMs: null,
        },
      };
      return;
    }
    sawToolCall = true;
    completedCalls.push({ id: call.id, name: call.name, argsText: call.argsText });
    yield { type: 'tool_call_end', callId: call.id, name: call.name, args };
  };

  try {
    for await (const { data } of parseSseStream(body, { signal })) {
      if (data === '[DONE]') {
        break;
      }
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (chunk['usage'] && typeof chunk['usage'] === 'object') {
        usage = parseChatCompletionsUsage(chunk['usage'] as Record<string, unknown>);
        sawUsage = true;
      }
      const choices = chunk['choices'] as Array<Record<string, unknown>> | undefined;
      const choice = choices?.[0];
      if (!choice) continue;
      const delta = choice['delta'] as Record<string, unknown> | undefined;
      if (typeof choice['finish_reason'] === 'string') finishReason = choice['finish_reason'];
      if (!delta) continue;
      if (typeof delta['content'] === 'string' && delta['content']) {
        yield { type: 'text_delta', text: delta['content'] };
      }
      const toolCalls = delta['tool_calls'] as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(toolCalls)) {
        for (const part of toolCalls) {
          const index = typeof part['index'] === 'number' ? part['index'] : 0;
          const fn = (part['function'] ?? {}) as Record<string, unknown>;
          let call = calls.get(index);
          if (!call) {
            call = { id: '', name: '', argsText: '', sealed: false };
            calls.set(index, call);
          }
          if (typeof part['id'] === 'string' && part['id']) call.id = part['id'];
          if (typeof fn['name'] === 'string' && fn['name']) call.name = fn['name'];
          if (typeof fn['arguments'] === 'string' && fn['arguments']) {
            if (call.sealed) continue;
            if (call.argsText.length + fn['arguments'].length > MAX_TOOL_ARGUMENT_BYTES) {
              yield {
                type: 'error',
                error: { code: 'malformed_response', message: 'Tool arguments exceeded the accumulation bound.', retryable: false, retryAfterMs: null },
              };
              return;
            }
            call.argsText += fn['arguments'];
            if (call.id && call.name) {
              if (!started.has(index)) {
                started.add(index);
                yield { type: 'tool_call_start', callId: call.id, name: call.name };
              }
              yield { type: 'tool_call_arguments', callId: call.id, argumentsChunk: fn['arguments'] };
            }
          } else if (call.id && call.name && !started.has(index)) {
            started.add(index);
            yield { type: 'tool_call_start', callId: call.id, name: call.name };
          }
        }
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'SseOverflowError') {
      yield { type: 'error', error: { code: 'malformed_response', message: err.message, retryable: false, retryAfterMs: null } };
      return;
    }
    yield { type: 'error', error: transportError(err) };
    return;
  }

  if (sawUsage) yield { type: 'usage', usage };

  // Strict completion boundary:
  // If the stream ended without a confirmed finish_reason, or if it was truncated,
  // do NOT publish any unconfirmed calls as executable.
  if (finishReason === null) {
    yield {
      type: 'error',
      error: { code: 'malformed_response', message: 'Chat stream ended before completion.', retryable: false, retryAfterMs: null },
    };
    return;
  }

  if (finishReason === 'length') {
    yield { type: 'finish', reason: 'length_limit', continuation: null };
    return;
  }

  if (finishReason === 'content_filter') {
    yield { type: 'finish', reason: 'refusal_or_block', continuation: null };
    return;
  }

  if (finishReason !== 'stop' && finishReason !== 'tool_calls') {
    yield {
      type: 'error',
      error: {
        code: 'malformed_response',
        message: `Unrecognized finish reason '${finishReason}'.`,
        retryable: false,
        retryAfterMs: null,
      },
    };
    return;
  }

  // Provider confirmed completion: emit executable calls in index order.
  const sortedIndices = [...calls.keys()].sort((a, b) => a - b);
  for (const index of sortedIndices) {
    for (const out of endCall(index)) {
      yield out;
      if (out.type === 'error') return;
    }
  }

  if (finishReason === 'tool_calls' && completedCalls.length === 0) {
    yield {
      type: 'error',
      error: {
        code: 'malformed_response',
        message: 'finish_reason was tool_calls but no valid tool call was decoded.',
        retryable: false,
        retryAfterMs: null,
      },
    };
    return;
  }

  const assistantToolCalls: AssistantToolCall[] = completedCalls.map((c) => ({
    id: c.id,
    name: c.name,
    arguments: c.argsText,
  }));

  const priorRounds: HistoricalToolRound[] = [
    ...(input?.previousContinuation?.priorRounds ?? []),
    ...(input && input.pendingToolResults.length > 0 && input.previousContinuation?.assistantToolCalls
      ? [{ assistantToolCalls: input.previousContinuation.assistantToolCalls, toolResults: input.pendingToolResults }]
      : []),
  ];

  yield {
    type: 'finish',
    reason: sawToolCall || finishReason === 'tool_calls' ? 'tool_handoff' : 'success',
    continuation: {
      kind: 'go-chat-completions',
      ...(assistantToolCalls.length > 0 ? { assistantToolCalls } : {}),
      ...(priorRounds.length > 0 ? { priorRounds } : {}),
    },
  };
}

/**
 * Responses-family SSE decoder. Wire shape follows the OpenAI Responses
 * streaming protocol implied by the Go endpoint table; mocked evidence only
 * until a live probe confirms the exact Go route. Unknown events pass
 * through untouched per provider versioning.
 */
async function* decodeResponses(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  input?: TurnInput,
): AsyncGenerator<ProviderEvent> {
  const calls = new Map<number, AccumulatedCall>();
  const completedCalls: Array<{ id: string; name: string; argsText: string }> = [];
  const started = new Set<number>();
  let sawToolCall = false;
  let usage: ProviderUsage = emptyUsage();
  let sawUsage = false;
  let responseId: string | null = null;
  let status: string | null = null;
  let incompleteReason: string | null = null;
  let done = false;

  const finishCall = function* (
    index: number,
  ): Generator<{ type: 'tool_call_end'; callId: string; name: string; args: unknown } | { type: 'error'; error: ProviderError }> {
    const call = calls.get(index);
    calls.delete(index);
    if (!call || !call.id || !call.name) {
      yield {
        type: 'error',
        error: { code: 'malformed_response', message: 'Responses stream ended a call without id and name.', retryable: false, retryAfterMs: null },
      };
      return;
    }
    let args: unknown;
    try {
      args = call.argsText ? (JSON.parse(call.argsText) as unknown) : {};
    } catch {
      yield {
        type: 'error',
        error: {
          code: 'malformed_response',
          message: `Tool call '${call.name}' returned unparseable arguments; not exposed as executable.`,
          retryable: false,
          retryAfterMs: null,
        },
      };
      return;
    }
    sawToolCall = true;
    completedCalls.push({ id: call.id, name: call.name, argsText: call.argsText });
    yield { type: 'tool_call_end', callId: call.id, name: call.name, args };
  };

  try {
    for await (const { event, data } of parseSseStream(body, { signal })) {
      if (data === '[DONE]') {
        break;
      }
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (event === 'response.output_text.delta') {
        if (typeof payload['delta'] === 'string' && payload['delta']) {
          yield { type: 'text_delta', text: payload['delta'] };
        }
      } else if (event === 'response.output_item.added') {
        const item = payload['item'] as Record<string, unknown> | undefined;
        const index = typeof payload['output_index'] === 'number' ? payload['output_index'] : 0;
        if (item?.['type'] === 'function_call') {
          const id = typeof item['call_id'] === 'string' ? (item['call_id'] as string) : typeof item['id'] === 'string' ? (item['id'] as string) : '';
          const name = typeof item['name'] === 'string' ? (item['name'] as string) : '';
          let seed = '';
          let sealed = false;
          if (typeof item['arguments'] === 'string' && item['arguments']) {
            seed = item['arguments'];
            sealed = true;
          }
          calls.set(index, { id, name, argsText: seed, sealed });
          if (id && name) {
            started.add(index);
            yield { type: 'tool_call_start', callId: id, name };
          }
        }
      } else if (event === 'response.function_call_arguments.delta') {
        const index = typeof payload['output_index'] === 'number' ? payload['output_index'] : 0;
        const piece = typeof payload['delta'] === 'string' ? payload['delta'] : '';
        const call = calls.get(index);
        if (call && piece && !call.sealed) {
          if (call.argsText.length + piece.length > MAX_TOOL_ARGUMENT_BYTES) {
            yield {
              type: 'error',
              error: { code: 'malformed_response', message: 'Tool arguments exceeded the accumulation bound.', retryable: false, retryAfterMs: null },
            };
            return;
          }
          call.argsText += piece;
          if (call.id && call.name) {
            if (!started.has(index)) {
              started.add(index);
              yield { type: 'tool_call_start', callId: call.id, name: call.name };
            }
            yield { type: 'tool_call_arguments', callId: call.id, argumentsChunk: piece };
          }
        }
      } else if (event === 'response.output_item.done') {
        const item = payload['item'] as Record<string, unknown> | undefined;
        const index = typeof payload['output_index'] === 'number' ? payload['output_index'] : 0;
        if (item?.['type'] === 'function_call') {
          const existing = calls.get(index) ?? { id: '', name: '', argsText: '', sealed: false };
          if (typeof item['call_id'] === 'string' && item['call_id']) existing.id = item['call_id'];
          if (typeof item['id'] === 'string' && item['id'] && !existing.id) existing.id = item['id'];
          if (typeof item['name'] === 'string' && item['name']) existing.name = item['name'];
          if (typeof item['arguments'] === 'string' && item['arguments']) existing.argsText = item['arguments'];
          calls.set(index, existing);
          for (const out of finishCall(index)) {
            yield out;
            if (out.type === 'error') return;
          }
        }
      } else if (
        event === 'response.completed' ||
        event === 'response.incomplete' ||
        event === 'response.failed'
      ) {
        const response = payload['response'] as Record<string, unknown> | undefined;
        if (response && typeof response['id'] === 'string') responseId = response['id'];
        if (response?.['usage'] && typeof response['usage'] === 'object') {
          usage = parseResponsesUsage(response['usage'] as Record<string, unknown>);
          sawUsage = true;
        }
        if (typeof response?.['status'] === 'string') status = response['status'];
        const incDetails = response?.['incomplete_details'] as Record<string, unknown> | undefined;
        if (typeof incDetails?.['reason'] === 'string') incompleteReason = incDetails['reason'];
        if (event === 'response.incomplete') status = 'incomplete';
        if (event === 'response.failed') status = 'failed';
        done = true;
        break;
      } else if (event === 'error') {
        yield {
          type: 'error',
          error: {
            code: 'transient',
            message: 'OpenCode Go responses stream returned an error.',
            retryable: true,
            retryAfterMs: null,
          },
        };
        return;
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'SseOverflowError') {
      yield { type: 'error', error: { code: 'malformed_response', message: err.message, retryable: false, retryAfterMs: null } };
      return;
    }
    yield { type: 'error', error: transportError(err) };
    return;
  }

  if (sawUsage) yield { type: 'usage', usage };
  if (!done || !responseId) {
    yield {
      type: 'error',
      error: { code: 'malformed_response', message: 'Responses stream ended before receiving a valid terminal response event.', retryable: false, retryAfterMs: null },
    };
    return;
  }
  if (calls.size > 0) {
    yield {
      type: 'error',
      error: { code: 'malformed_response', message: 'Responses stream completed with an unfinished tool call item.', retryable: false, retryAfterMs: null },
    };
    return;
  }
  if (status !== 'completed' && status !== 'incomplete' && status !== 'failed' && status !== 'cancelled') {
    yield {
      type: 'error',
      error: { code: 'malformed_response', message: `Unknown response status '${String(status)}'.`, retryable: false, retryAfterMs: null },
    };
    return;
  }
  const assistantToolCalls: AssistantToolCall[] = completedCalls.map((c) => ({
    id: c.id,
    name: c.name,
    arguments: c.argsText,
  }));

  const priorRounds: HistoricalToolRound[] = [
    ...(input?.previousContinuation?.priorRounds ?? []),
    ...(input && input.pendingToolResults.length > 0 && input.previousContinuation?.assistantToolCalls
      ? [{ assistantToolCalls: input.previousContinuation.assistantToolCalls, toolResults: input.pendingToolResults }]
      : []),
  ];

  if (status === 'incomplete') {
    const isContentFilter = incompleteReason === 'content_filter';
    yield {
      type: 'finish',
      reason: isContentFilter ? 'refusal_or_block' : 'length_limit',
      continuation: {
        kind: 'go-responses',
        ...(responseId ? { previousResponseId: responseId } : {}),
        ...(assistantToolCalls.length > 0 ? { assistantToolCalls } : {}),
        ...(priorRounds.length > 0 ? { priorRounds } : {}),
      },
    };
    return;
  }
  if (status === 'failed' || status === 'cancelled') {
    yield {
      type: 'error',
      error: {
        code: status === 'cancelled' ? 'aborted' : 'transient',
        message: status === 'cancelled' ? 'Responses request was cancelled.' : 'Responses request failed on provider.',
        retryable: status !== 'cancelled',
        retryAfterMs: null,
      },
    };
    return;
  }
  yield {
    type: 'finish',
    reason: sawToolCall ? 'tool_handoff' : 'success',
    continuation: {
      kind: 'go-responses',
      ...(responseId ? { previousResponseId: responseId } : {}),
      ...(assistantToolCalls.length > 0 ? { assistantToolCalls } : {}),
      ...(priorRounds.length > 0 ? { priorRounds } : {}),
    },
  };
}

function toChatMessages(input: TurnInput): unknown[] {
  const messages: unknown[] = [];
  const messageAssistantCallIds = new Set<string>();
  const messageToolResultIds = new Set<string>();

  for (const message of input.messages) {
    if (message.role === 'tool') {
      if (message.toolCallId) {
        messageToolResultIds.add(message.toolCallId);
      }
      messages.push({
        role: 'tool',
        tool_call_id: message.toolCallId ?? '',
        content: message.text ?? '',
      });
    } else if (message.role === 'assistant') {
      if (message.toolCalls && message.toolCalls.length > 0) {
        for (const c of message.toolCalls) {
          if (!c.id || !c.name || typeof c.arguments !== 'string' || !c.arguments.trim()) {
            throw new ProviderErrorException({
              code: 'invalid_request',
              message: `Missing original tool call arguments for '${c.name}' (${c.id}); cannot fabricate arguments.`,
              retryable: false,
              retryAfterMs: null,
            });
          }
          messageAssistantCallIds.add(c.id);
        }
        messages.push({
          role: 'assistant',
          content: message.text ?? null,
          tool_calls: message.toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: c.arguments },
          })),
        });
      } else {
        messages.push({ role: 'assistant', content: message.text ?? '' });
      }
    } else {
      if (message.role === 'user' && message.audio) {
        messages.push({
          role: 'user',
          content: [
            {
              type: 'input_audio',
              input_audio: {
                data: message.audio.data,
                format: message.audio.format ?? 'wav',
              },
            },
            ...(message.text ? [{ type: 'text', text: message.text }] : []),
          ],
        });
      } else {
        messages.push({ role: message.role, content: message.text ?? '' });
      }
    }
  }

  // Replay prior completed rounds within the current multi-round turn
  // Single authority rule:
  // - No overlap: replay the round once from continuation
  // - Complete overlap: use the existing history once (skip replaying)
  // - Partial overlap: reject with invalid_request before transport
  if (input.previousContinuation?.priorRounds && input.previousContinuation.priorRounds.length > 0) {
    for (const round of input.previousContinuation.priorRounds) {
      const roundCallIds = new Set<string>();
      for (const call of round.assistantToolCalls) {
        if (!call.id || !call.name || typeof call.arguments !== 'string' || !call.arguments.trim()) {
          throw new ProviderErrorException({
            code: 'invalid_request',
            message: `Missing original tool call arguments for '${call.name}' (${call.id}); cannot fabricate arguments.`,
            retryable: false,
            retryAfterMs: null,
          });
        }
        if (roundCallIds.has(call.id)) {
          throw new ProviderErrorException({
            code: 'invalid_request',
            message: `Duplicate tool call ID '${call.id}' in prior round.`,
            retryable: false,
            retryAfterMs: null,
          });
        }
        roundCallIds.add(call.id);
      }

      const roundResultIds = new Set<string>();
      for (const res of round.toolResults) {
        if (!res.callId || typeof res.resultText !== 'string') {
          throw new ProviderErrorException({
            code: 'invalid_request',
            message: 'Invalid tool result in prior round.',
            retryable: false,
            retryAfterMs: null,
          });
        }
        if (roundResultIds.has(res.callId)) {
          throw new ProviderErrorException({
            code: 'invalid_request',
            message: `Duplicate tool result ID '${res.callId}' in prior round.`,
            retryable: false,
            retryAfterMs: null,
          });
        }
        roundResultIds.add(res.callId);
      }

      // Exact correspondence for completed prior round
      for (const call of round.assistantToolCalls) {
        if (!roundResultIds.has(call.id)) {
          throw new ProviderErrorException({
            code: 'invalid_request',
            message: `Missing tool result for tool call '${call.name}' (${call.id}) in prior round.`,
            retryable: false,
            retryAfterMs: null,
          });
        }
      }
      for (const res of round.toolResults) {
        if (!roundCallIds.has(res.callId)) {
          throw new ProviderErrorException({
            code: 'invalid_request',
            message: `Tool result '${res.callId}' does not correspond to any tool call in prior round.`,
            retryable: false,
            retryAfterMs: null,
          });
        }
      }

      const callsInMsg = [...roundCallIds].filter((id) => messageAssistantCallIds.has(id));
      const resultsInMsg = [...roundResultIds].filter((id) => messageToolResultIds.has(id));

      const hasAnyOverlap = callsInMsg.length > 0 || resultsInMsg.length > 0;
      const isCompleteOverlap =
        roundCallIds.size > 0 &&
        roundResultIds.size > 0 &&
        callsInMsg.length === roundCallIds.size &&
        resultsInMsg.length === roundResultIds.size;

      if (hasAnyOverlap) {
        if (!isCompleteOverlap) {
          throw new ProviderErrorException({
            code: 'invalid_request',
            message: `Partial overlap detected for prior round containing tool call(s) [${[...roundCallIds].join(', ')}]. A tool round must be represented either entirely in message history or entirely in continuation.`,
            retryable: false,
            retryAfterMs: null,
          });
        }
        // Complete overlap: existing message history already contains this round completely.
        continue;
      }

      for (const call of round.assistantToolCalls) {
        messageAssistantCallIds.add(call.id);
      }
      for (const res of round.toolResults) {
        messageToolResultIds.add(res.callId);
      }

      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: round.assistantToolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      });
      for (const res of round.toolResults) {
        messages.push({
          role: 'tool',
          tool_call_id: res.callId,
          content: res.resultText,
        });
      }
    }
  }

  // Replay current pending round
  if (input.pendingToolResults.length > 0) {
    // 1. Validate uniqueness of tool result IDs
    const seenResultIds = new Set<string>();
    for (const res of input.pendingToolResults) {
      if (seenResultIds.has(res.callId)) {
        throw new ProviderErrorException({
          code: 'invalid_request',
          message: `Duplicate tool result provided for callId '${res.callId}'.`,
          retryable: false,
          retryAfterMs: null,
        });
      }
      seenResultIds.add(res.callId);
    }

    const expectedCalls = input.previousContinuation?.assistantToolCalls;
    if (expectedCalls && expectedCalls.length > 0) {
      // Validate that all expected calls have arguments (no fabricated empty {})
      for (const call of expectedCalls) {
        if (!call.id || !call.name || typeof call.arguments !== 'string' || !call.arguments.trim()) {
          throw new ProviderErrorException({
            code: 'invalid_request',
            message: `Missing original tool call arguments for '${call.name}' (${call.id}); cannot fabricate arguments.`,
            retryable: false,
            retryAfterMs: null,
          });
        }
      }

      // Check correspondence: all pending results must have an expected call
      for (const res of input.pendingToolResults) {
        if (!expectedCalls.some((c) => c.id === res.callId)) {
          throw new ProviderErrorException({
            code: 'invalid_request',
            message: `Tool result callId '${res.callId}' does not correspond to any pending assistant tool call.`,
            retryable: false,
            retryAfterMs: null,
          });
        }
      }

      // Bidirectional check: all expected calls must have a matching result
      for (const call of expectedCalls) {
        if (!input.pendingToolResults.some((res) => res.callId === call.id)) {
          throw new ProviderErrorException({
            code: 'invalid_request',
            message: `Missing tool result for pending assistant tool call '${call.name}' (${call.id}).`,
            retryable: false,
            retryAfterMs: null,
          });
        }
      }

      const pendingCallIds = expectedCalls.map((c) => c.id);
      const pendingResultIds = input.pendingToolResults.map((r) => r.callId);

      const callsInMsg = pendingCallIds.filter((id) => messageAssistantCallIds.has(id));
      const resultsInMsg = pendingResultIds.filter((id) => messageToolResultIds.has(id));

      const hasAnyOverlap = callsInMsg.length > 0 || resultsInMsg.length > 0;
      const isCompleteOverlap =
        callsInMsg.length === pendingCallIds.length &&
        resultsInMsg.length === pendingResultIds.length;
      const isAssistantOnlyOverlap =
        callsInMsg.length === pendingCallIds.length &&
        resultsInMsg.length === 0;

      if (hasAnyOverlap && !isCompleteOverlap && !isAssistantOnlyOverlap) {
        throw new ProviderErrorException({
          code: 'invalid_request',
          message: `Partial overlap detected for pending round containing tool call(s) [${pendingCallIds.join(', ')}]. A tool round must be represented either entirely in message history or entirely in continuation.`,
          retryable: false,
          retryAfterMs: null,
        });
      }

      if (!isCompleteOverlap && !isAssistantOnlyOverlap) {
        for (const call of expectedCalls) {
          messageAssistantCallIds.add(call.id);
        }
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: expectedCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
          })),
        });
      }

      if (!isCompleteOverlap) {
        for (const result of input.pendingToolResults) {
          messageToolResultIds.add(result.callId);
          messages.push({ role: 'tool', tool_call_id: result.callId, content: result.resultText });
        }
      }
    } else {
      // No assistantToolCalls in continuation: result.arguments must be present on every pending result
      for (const res of input.pendingToolResults) {
        if (res.arguments === undefined || res.arguments === null) {
          throw new ProviderErrorException({
            code: 'invalid_request',
            message: `Missing original tool call arguments for '${res.name}' (${res.callId}); cannot fabricate arguments.`,
            retryable: false,
            retryAfterMs: null,
          });
        }
      }

      const pendingCallIds = input.pendingToolResults.map((r) => r.callId);
      const callsInMsg = pendingCallIds.filter((id) => messageAssistantCallIds.has(id));
      const resultsInMsg = pendingCallIds.filter((id) => messageToolResultIds.has(id));

      const hasAnyOverlap = callsInMsg.length > 0 || resultsInMsg.length > 0;
      const isCompleteOverlap =
        callsInMsg.length === pendingCallIds.length &&
        resultsInMsg.length === pendingCallIds.length;
      const isAssistantOnlyOverlap =
        callsInMsg.length === pendingCallIds.length &&
        resultsInMsg.length === 0;

      if (hasAnyOverlap && !isCompleteOverlap && !isAssistantOnlyOverlap) {
        throw new ProviderErrorException({
          code: 'invalid_request',
          message: `Partial overlap detected for pending round containing tool call(s) [${pendingCallIds.join(', ')}]. A tool round must be represented either entirely in message history or entirely in continuation.`,
          retryable: false,
          retryAfterMs: null,
        });
      }

      if (!isCompleteOverlap && !isAssistantOnlyOverlap) {
        for (const id of pendingCallIds) {
          messageAssistantCallIds.add(id);
        }
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: input.pendingToolResults.map((result) => {
            const args =
              typeof result.arguments === 'string'
                ? result.arguments
                : JSON.stringify(result.arguments);
            if (!args) {
              throw new ProviderErrorException({
                code: 'invalid_request',
                message: `Missing original tool call arguments for '${result.name}' (${result.callId}); cannot fabricate arguments.`,
                retryable: false,
                retryAfterMs: null,
              });
            }
            return {
              id: result.callId,
              type: 'function',
              function: {
                name: result.name,
                arguments: args,
              },
            };
          }),
        });
      }

      if (!isCompleteOverlap) {
        for (const result of input.pendingToolResults) {
          messageToolResultIds.add(result.callId);
          messages.push({ role: 'tool', tool_call_id: result.callId, content: result.resultText });
        }
      }
    }
  }
  return messages;
}

function toResponsesInput(input: TurnInput): unknown[] {
  const items: unknown[] = [];
  const messageAssistantCallIds = new Set<string>();
  const messageToolResultIds = new Set<string>();

  for (const message of input.messages) {
    if (message.role === 'tool') {
      if (message.toolCallId) {
        messageToolResultIds.add(message.toolCallId);
      }
      items.push({
        type: 'function_call_output',
        call_id: message.toolCallId ?? '',
        output: message.text ?? '',
      });
    } else if (message.role === 'assistant') {
      if (message.toolCalls && message.toolCalls.length > 0) {
        for (const c of message.toolCalls) {
          if (!c.id || !c.name || typeof c.arguments !== 'string' || !c.arguments.trim()) {
            throw new ProviderErrorException({
              code: 'invalid_request',
              message: `Missing original tool call arguments for '${c.name}' (${c.id}); cannot fabricate arguments.`,
              retryable: false,
              retryAfterMs: null,
            });
          }
          messageAssistantCallIds.add(c.id);
          items.push({
            type: 'function_call',
            call_id: c.id,
            name: c.name,
            arguments: c.arguments,
          });
        }
      }
      if (message.text) {
        items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: message.text }] });
      }
    } else {
      if (message.role === 'user' && message.audio) {
        items.push({
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_audio',
              input_audio: {
                data: message.audio.data,
                format: message.audio.format ?? 'wav',
              },
            },
            ...(message.text ? [{ type: 'input_text', text: message.text }] : []),
          ],
        });
      } else {
        items.push({ type: 'message', role: message.role, content: [{ type: 'input_text', text: message.text ?? '' }] });
      }
    }
  }

  // Replay prior completed rounds within the current multi-round turn
  if (input.previousContinuation?.priorRounds && input.previousContinuation.priorRounds.length > 0) {
    for (const round of input.previousContinuation.priorRounds) {
      const roundCallIds = new Set<string>();
      for (const call of round.assistantToolCalls) {
        if (!call.id || !call.name || typeof call.arguments !== 'string' || !call.arguments.trim()) {
          throw new ProviderErrorException({
            code: 'invalid_request',
            message: `Missing original tool call arguments for '${call.name}' (${call.id}); cannot fabricate arguments.`,
            retryable: false,
            retryAfterMs: null,
          });
        }
        if (roundCallIds.has(call.id)) {
          throw new ProviderErrorException({
            code: 'invalid_request',
            message: `Duplicate tool call ID '${call.id}' in prior round.`,
            retryable: false,
            retryAfterMs: null,
          });
        }
        roundCallIds.add(call.id);
      }

      const roundResultIds = new Set<string>();
      for (const res of round.toolResults) {
        if (!res.callId || typeof res.resultText !== 'string') {
          throw new ProviderErrorException({
            code: 'invalid_request',
            message: 'Invalid tool result in prior round.',
            retryable: false,
            retryAfterMs: null,
          });
        }
        if (roundResultIds.has(res.callId)) {
          throw new ProviderErrorException({
            code: 'invalid_request',
            message: `Duplicate tool result ID '${res.callId}' in prior round.`,
            retryable: false,
            retryAfterMs: null,
          });
        }
        roundResultIds.add(res.callId);
      }

      // Exact correspondence for completed prior round
      for (const call of round.assistantToolCalls) {
        if (!roundResultIds.has(call.id)) {
          throw new ProviderErrorException({
            code: 'invalid_request',
            message: `Missing tool result for tool call '${call.name}' (${call.id}) in prior round.`,
            retryable: false,
            retryAfterMs: null,
          });
        }
      }
      for (const res of round.toolResults) {
        if (!roundCallIds.has(res.callId)) {
          throw new ProviderErrorException({
            code: 'invalid_request',
            message: `Tool result '${res.callId}' does not correspond to any tool call in prior round.`,
            retryable: false,
            retryAfterMs: null,
          });
        }
      }

      const callsInMsg = [...roundCallIds].filter((id) => messageAssistantCallIds.has(id));
      const resultsInMsg = [...roundResultIds].filter((id) => messageToolResultIds.has(id));

      const hasAnyOverlap = callsInMsg.length > 0 || resultsInMsg.length > 0;
      const isCompleteOverlap =
        roundCallIds.size > 0 &&
        roundResultIds.size > 0 &&
        callsInMsg.length === roundCallIds.size &&
        resultsInMsg.length === roundResultIds.size;

      if (hasAnyOverlap) {
        if (!isCompleteOverlap) {
          throw new ProviderErrorException({
            code: 'invalid_request',
            message: `Partial overlap detected for prior round containing tool call(s) [${[...roundCallIds].join(', ')}]. A tool round must be represented either entirely in message history or entirely in continuation.`,
            retryable: false,
            retryAfterMs: null,
          });
        }
        continue;
      }

      for (const call of round.assistantToolCalls) {
        messageAssistantCallIds.add(call.id);
        items.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
        });
      }
      for (const res of round.toolResults) {
        messageToolResultIds.add(res.callId);
        items.push({
          type: 'function_call_output',
          call_id: res.callId,
          output: res.resultText,
        });
      }
    }
  }

  // Pending round
  if (input.pendingToolResults.length > 0) {
    // 1. Validate uniqueness of tool result IDs
    const seenResultIds = new Set<string>();
    for (const res of input.pendingToolResults) {
      if (!res.callId || typeof res.resultText !== 'string') {
        throw new ProviderErrorException({
          code: 'invalid_request',
          message: 'Invalid tool result in pendingToolResults.',
          retryable: false,
          retryAfterMs: null,
        });
      }
      if (seenResultIds.has(res.callId)) {
        throw new ProviderErrorException({
          code: 'invalid_request',
          message: `Duplicate tool result provided for callId '${res.callId}'.`,
          retryable: false,
          retryAfterMs: null,
        });
      }
      seenResultIds.add(res.callId);
    }

    if (input.previousContinuation?.assistantToolCalls && input.previousContinuation.assistantToolCalls.length > 0) {
      const expectedCalls = input.previousContinuation.assistantToolCalls;
      const seenCallIds = new Set<string>();
      for (const call of expectedCalls) {
        if (!call.id || !call.name || typeof call.arguments !== 'string' || !call.arguments.trim()) {
          throw new ProviderErrorException({
            code: 'invalid_request',
            message: `Missing original tool call arguments for '${call.name}' (${call.id}); cannot fabricate arguments.`,
            retryable: false,
            retryAfterMs: null,
          });
        }
        if (seenCallIds.has(call.id)) {
          throw new ProviderErrorException({
            code: 'invalid_request',
            message: `Duplicate tool call ID '${call.id}' in expected calls.`,
            retryable: false,
            retryAfterMs: null,
          });
        }
        seenCallIds.add(call.id);
      }

      // Check correspondence: every pending result must correspond to an expected call
      for (const res of input.pendingToolResults) {
        if (!seenCallIds.has(res.callId)) {
          throw new ProviderErrorException({
            code: 'invalid_request',
            message: `Tool result callId '${res.callId}' does not correspond to any pending assistant tool call.`,
            retryable: false,
            retryAfterMs: null,
          });
        }
      }

      // Bidirectional check: every expected call must have a matching result
      for (const call of expectedCalls) {
        if (!seenResultIds.has(call.id)) {
          throw new ProviderErrorException({
            code: 'invalid_request',
            message: `Missing tool result for pending assistant tool call '${call.name}' (${call.id}).`,
            retryable: false,
            retryAfterMs: null,
          });
        }
      }

      const pendingCallIds = expectedCalls.map((c) => c.id);
      const pendingResultIds = input.pendingToolResults.map((r) => r.callId);

      const callsInMsg = pendingCallIds.filter((id) => messageAssistantCallIds.has(id));
      const resultsInMsg = pendingResultIds.filter((id) => messageToolResultIds.has(id));

      const hasAnyOverlap = callsInMsg.length > 0 || resultsInMsg.length > 0;
      const isCompleteOverlap =
        callsInMsg.length === pendingCallIds.length &&
        resultsInMsg.length === pendingResultIds.length;
      const isAssistantOnlyOverlap =
        callsInMsg.length === pendingCallIds.length &&
        resultsInMsg.length === 0;

      if (hasAnyOverlap && !isCompleteOverlap && !isAssistantOnlyOverlap) {
        throw new ProviderErrorException({
          code: 'invalid_request',
          message: `Partial overlap detected for pending round containing tool call(s) [${pendingCallIds.join(', ')}]. A tool round must be represented either entirely in message history or entirely in continuation.`,
          retryable: false,
          retryAfterMs: null,
        });
      }

      if (!isCompleteOverlap && !isAssistantOnlyOverlap) {
        for (const call of expectedCalls) {
          messageAssistantCallIds.add(call.id);
          items.push({
            type: 'function_call',
            call_id: call.id,
            name: call.name,
            arguments: call.arguments,
          });
        }
      }

      if (!isCompleteOverlap) {
        for (const result of input.pendingToolResults) {
          messageToolResultIds.add(result.callId);
          items.push({ type: 'function_call_output', call_id: result.callId, output: result.resultText });
        }
      }
    } else {
      for (const res of input.pendingToolResults) {
        if (res.arguments === undefined || res.arguments === null) {
          throw new ProviderErrorException({
            code: 'invalid_request',
            message: `Missing original tool call arguments for '${res.name}' (${res.callId}); cannot fabricate arguments.`,
            retryable: false,
            retryAfterMs: null,
          });
        }
      }

      const pendingCallIds = input.pendingToolResults.map((r) => r.callId);
      const callsInMsg = pendingCallIds.filter((id) => messageAssistantCallIds.has(id));
      const resultsInMsg = pendingCallIds.filter((id) => messageToolResultIds.has(id));

      const hasAnyOverlap = callsInMsg.length > 0 || resultsInMsg.length > 0;
      const isCompleteOverlap =
        callsInMsg.length === pendingCallIds.length &&
        resultsInMsg.length === pendingCallIds.length;
      const isAssistantOnlyOverlap =
        callsInMsg.length === pendingCallIds.length &&
        resultsInMsg.length === 0;

      if (hasAnyOverlap && !isCompleteOverlap && !isAssistantOnlyOverlap) {
        throw new ProviderErrorException({
          code: 'invalid_request',
          message: `Partial overlap detected for pending round containing tool call(s) [${pendingCallIds.join(', ')}]. A tool round must be represented either entirely in message history or entirely in continuation.`,
          retryable: false,
          retryAfterMs: null,
        });
      }

      if (!isCompleteOverlap && !isAssistantOnlyOverlap) {
        for (const result of input.pendingToolResults) {
          const args =
            typeof result.arguments === 'string'
              ? result.arguments
              : JSON.stringify(result.arguments);
          if (!args) {
            throw new ProviderErrorException({
              code: 'invalid_request',
              message: `Missing original tool call arguments for '${result.name}' (${result.callId}); cannot fabricate arguments.`,
              retryable: false,
              retryAfterMs: null,
            });
          }
          messageAssistantCallIds.add(result.callId);
          items.push({
            type: 'function_call',
            call_id: result.callId,
            name: result.name,
            arguments: args,
          });
        }
      }

      if (!isCompleteOverlap) {
        for (const result of input.pendingToolResults) {
          messageToolResultIds.add(result.callId);
          items.push({ type: 'function_call_output', call_id: result.callId, output: result.resultText });
        }
      }
    }
  }

  return items;
}

export interface GoAdapterOptions extends AdapterEnv {
  fetchFn: FetchFn;
  endpointFamily: 'go-chat-completions' | 'go-responses';
}

export class OpenCodeGoAdapter implements ProviderAdapter {
  readonly provider = 'opencode_go' as const;
  private readonly fetchFn: FetchFn;
  private readonly apiKey: string;
  private readonly endpointFamily: 'go-chat-completions' | 'go-responses';

  constructor(options: GoAdapterOptions) {
    this.fetchFn = receiverSafeFetch(options.fetchFn);
    this.apiKey = options.apiKey;
    this.endpointFamily = options.endpointFamily;
  }

  audioSupport(): { support: 'supported' | 'unsupported' | 'unverified'; detail: string } {
    return {
      support: 'unverified',
      detail: 'Go gateway audio forwarding is untested on the selected routes.',
    };
  }

  async *streamTurn(input: TurnInput): AsyncIterable<ProviderEvent> {
    if (input.messages.length === 0) {
      throw new ProviderErrorException({
        code: 'invalid_request',
        message: 'Turn input requires at least one message.',
        retryable: false,
        retryAfterMs: null,
      });
    }
    validateTools(input.tools);
    if (
      typeof input.maxOutputTokens !== 'number' ||
      !Number.isFinite(input.maxOutputTokens) ||
      input.maxOutputTokens <= 0 ||
      !Number.isInteger(input.maxOutputTokens)
    ) {
      throw new ProviderErrorException({
        code: 'invalid_request',
        message: 'maxOutputTokens must be a positive integer.',
        retryable: false,
        retryAfterMs: null,
      });
    }
    if (input.previousContinuation && input.previousContinuation.kind !== this.endpointFamily) {
      throw new ProviderErrorException({
        code: 'invalid_request',
        message: 'Continuation belongs to a different endpoint family.',
        retryable: false,
        retryAfterMs: null,
      });
    }
    if (input.model.endpointFamily !== this.endpointFamily) {
      throw new ProviderErrorException({
        code: 'invalid_request',
        message: `Adapter serves ${this.endpointFamily}, not ${input.model.endpointFamily}.`,
        retryable: false,
        retryAfterMs: null,
      });
    }

    const { signal, cancel } = linkSignal(input);
    if (signal.aborted) {
      yield { type: 'error', error: { code: 'aborted', message: 'Turn aborted before start.', retryable: false, retryAfterMs: null } };
      return;
    }
    try {
      if (this.endpointFamily === 'go-chat-completions') {
        yield* this.streamChat(input, signal);
      } else {
        yield* this.streamResponses(input, signal);
      }
    } finally {
      cancel();
    }
  }

  private async *streamChat(input: TurnInput, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    if (input.thinking) {
      if (input.thinking.kind === 'go_chat_effort') {
        const VALID_GO_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
        if (!VALID_GO_EFFORTS.has(input.thinking.effort)) {
          throw new ProviderErrorException({
            code: 'invalid_request',
            message: `Thinking effort '${input.thinking.effort}' is not supported by OpenCode Go chat adapter.`,
            retryable: false,
            retryAfterMs: null,
          });
        }
      } else if (input.thinking.kind === 'provider_default') {
        // Provider default omits the thinking field
      } else {
        throw new ProviderErrorException({
          code: 'invalid_request',
          message: `Thinking request kind '${(input.thinking as { kind: string }).kind}' is not supported by OpenCode Go chat adapter.`,
          retryable: false,
          retryAfterMs: null,
        });
      }
    }

    const body: Record<string, unknown> = {
      model: input.model.modelId,
      messages: toChatMessages(input),
      tool_choice: 'auto',
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: input.maxOutputTokens,
    };
    if (input.thinking?.kind === 'go_chat_effort') {
      body['reasoning_effort'] = input.thinking.effort;
    }
    if (input.tools.length > 0) {
      body['tools'] = input.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }));
    }
    let response: Response;
    try {
      response = await this.fetchFn(GO_CHAT_COMPLETIONS_URL, {
        method: 'POST',
        headers: baseHeaders(this.apiKey, input.sessionId),
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      yield { type: 'error', error: transportError(err) };
      return;
    }
    if (!response.ok || !response.body) {
      yield { type: 'error', error: httpError('OpenCode Go chat', response.status, response.headers) };
      return;
    }
    yield* decodeChatCompletions(response.body, signal, input);
  }

  private async *streamResponses(input: TurnInput, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    if (input.thinking && input.thinking.kind !== 'provider_default') {
      throw new ProviderErrorException({
        code: 'invalid_request',
        message: `Thinking request kind '${(input.thinking as { kind: string }).kind}' is not supported by OpenCode Go responses adapter.`,
        retryable: false,
        retryAfterMs: null,
      });
    }

    const body: Record<string, unknown> = {
      model: input.model.modelId,
      input: toResponsesInput(input),
      stream: true,
      max_output_tokens: input.maxOutputTokens,
    };
    if (input.tools.length > 0) {
      body['tools'] = input.tools.map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
    }
    let response: Response;
    try {
      response = await this.fetchFn(GO_RESPONSES_URL, {
        method: 'POST',
        headers: baseHeaders(this.apiKey, input.sessionId),
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      yield { type: 'error', error: transportError(err) };
      return;
    }
    if (!response.ok || !response.body) {
      yield { type: 'error', error: httpError('OpenCode Go responses', response.status, response.headers) };
      return;
    }
    yield* decodeResponses(response.body, signal, input);
  }
}

/** Bounded credential probe: models discovery (no inference, no spending). */
export async function probeGoCredential(
  fetchFn: FetchFn,
  apiKey: string,
  sessionId: string,
  timeoutMs = 15_000,
): Promise<{ ok: boolean; status: number }> {
  const safeFetch = receiverSafeFetch(fetchFn);
  const response = await safeFetch(GO_MODELS_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'x-opencode-session': sessionId,
      'User-Agent': OTIS_USER_AGENT,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { ok: response.ok, status: response.status };
}

