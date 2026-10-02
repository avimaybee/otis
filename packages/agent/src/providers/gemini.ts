/**
 * @otis/agent/providers/gemini
 * Gemini Interactions API adapter (direct REST, no SDK).
 *
 * Choice rationale (checked 2026-10-01 against
 * https://ai.google.dev/gemini-api/docs/interactions/streaming and
 * .../function-calling): the Interactions family is the current documented
 * path for text, streaming, function calls with id/name/arguments, staged
 * continuations via previous_interaction_id, and usage reporting. One
 * endpoint (`POST /v1beta/interactions`, `stream:true`, SSE) covers all
 * required behaviors; generateContent was not implemented alongside it.
 * Interactions is Beta per Google; generateContent remains their stable
 * recommendation. That status is recorded, not a capability claim.
 *
 * Server-side tools (google_search, code execution, …) are never requested:
 * only `{type:'function'}` declarations are sent. Continuation metadata is
 * the previous interaction id, kept server-only.
 */

import { parseSseStream } from './sse.js';
import {
  GEMINI_ORIGIN,
  MAX_TOOL_ARGUMENT_BYTES,
  numOrNull,
  parseRetryAfterMs,
  type FetchFn,
  type ProviderAdapter,
  type ProviderError,
  type ProviderEvent,
  type ProviderUsage,
  type ToolDeclaration,
  type TurnInput,
} from './types.js';
import { ProviderErrorException } from './types.js';

/** Pinned documented revision header (docs examples, checked 2026-10-01). */
export const GEMINI_API_REVISION = '2026-05-20';

export const GEMINI_INTERACTIONS_URL = `${GEMINI_ORIGIN}/v1beta/interactions`;

interface AccumulatedCall {
  id: string;
  name: string;
  argsText: string;
  /** True when step.start carried complete arguments; later deltas are ignored. */
  sealed: boolean;
}

function validateToolDeclaration(tool: ToolDeclaration): void {
  if (!tool.name || typeof tool.name !== 'string' || !/^[A-Za-z0-9_]+$/.test(tool.name)) {
    throw new ProviderErrorException({
      code: 'invalid_request',
      message: `Tool name '${tool.name}' is not supported; use letters, digits, or underscores.`,
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
  if (
    (params['properties'] !== undefined && typeof params['properties'] !== 'object') ||
    (params['required'] !== undefined && !Array.isArray(params['required']))
  ) {
    throw new ProviderErrorException({
      code: 'invalid_request',
      message: `Tool '${tool.name}' has an unsupported parameter shape; rejected rather than weakened.`,
      retryable: false,
      retryAfterMs: null,
    });
  }
}

function toInteractionsInput(input: TurnInput): { systemInstruction?: string; blocks: unknown[] } {
  const systemTexts: string[] = [];
  const blocks: unknown[] = [];
  const seenFunctionResultCallIds = new Set<string>();

  for (const message of input.messages) {
    if (message.role === 'system') {
      if (message.text) systemTexts.push(message.text);
    } else if (message.role === 'user') {
      blocks.push({ type: 'user_input', content: [{ type: 'text', text: message.text ?? '' }] });
    } else if (message.role === 'tool') {
      const callId = message.toolCallId ?? '';
      if (!callId || !seenFunctionResultCallIds.has(callId)) {
        if (callId) seenFunctionResultCallIds.add(callId);
        blocks.push({
          type: 'function_result',
          call_id: callId,
          name: message.name ?? '',
          result: [{ type: 'text', text: message.text ?? '' }],
        });
      }
    } else {
      if (message.toolCalls && message.toolCalls.length > 0) {
        for (const call of message.toolCalls) {
          if (!call.id || !call.name) {
            throw new ProviderErrorException({
              code: 'invalid_request',
              message: 'Tool call is missing required id or name.',
              retryable: false,
              retryAfterMs: null,
            });
          }
          if (typeof call.arguments !== 'string' || !call.arguments.trim()) {
            throw new ProviderErrorException({
              code: 'invalid_request',
              message: `Missing original tool call arguments for '${call.name}' (${call.id}); cannot fabricate arguments.`,
              retryable: false,
              retryAfterMs: null,
            });
          }
          let parsedArgs: Record<string, unknown>;
          try {
            const parsed = JSON.parse(call.arguments);
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
              throw new Error('Not an object');
            }
            parsedArgs = parsed as Record<string, unknown>;
          } catch {
            throw new ProviderErrorException({
              code: 'invalid_request',
              message: `Malformed original tool call arguments for '${call.name}' (${call.id}); expected JSON object string.`,
              retryable: false,
              retryAfterMs: null,
            });
          }
          blocks.push({
            type: 'function_call',
            id: call.id,
            name: call.name,
            arguments: parsedArgs,
          });
        }
      }
      if (message.text) {
        blocks.push({ type: 'model_output', content: [{ type: 'text', text: message.text }] });
      }
    }
  }

  for (const result of input.pendingToolResults) {
    if (!seenFunctionResultCallIds.has(result.callId)) {
      seenFunctionResultCallIds.add(result.callId);
      blocks.push({
        type: 'function_result',
        name: result.name,
        call_id: result.callId,
        result: [{ type: 'text', text: result.resultText }],
      });
    }
  }

  return {
    ...(systemTexts.length > 0 ? { systemInstruction: systemTexts.join('\n\n') } : {}),
    blocks,
  };
}

function httpError(status: number, headers: Headers): ProviderError {
  const retryAfterMs = parseRetryAfterMs(headers.get('retry-after'));
  if (status === 401 || status === 403) {
    return {
      code: 'invalid_credential',
      message: 'Gemini authentication failed; check your API key.',
      retryable: false,
      retryAfterMs: null,
      status,
    };
  }
  if (status === 404) {
    return {
      code: 'unknown_model',
      message: 'Requested Gemini model was not found.',
      retryable: false,
      retryAfterMs: null,
      status,
    };
  }
  if (status === 429) {
    return {
      code: 'rate_limited',
      message: 'Gemini rate limit exceeded.',
      retryable: true,
      retryAfterMs,
      status,
    };
  }
  if (status >= 500) {
    return {
      code: 'transient',
      message: `Gemini service error (${status}).`,
      retryable: true,
      retryAfterMs,
      status,
    };
  }
  return {
    code: 'invalid_request',
    message: `Gemini request failed (${status}).`,
    retryable: false,
    retryAfterMs: null,
    status,
  };
}

function mapUsage(raw: Record<string, unknown> | undefined): ProviderUsage {
  return {
    inputTokens: numOrNull(raw?.['total_input_tokens']),
    outputTokens: numOrNull(raw?.['total_output_tokens']),
    cacheReadTokens: numOrNull(raw?.['total_cached_tokens']),
    cacheWriteTokens: null,
    reasoningTokens: numOrNull(raw?.['total_thought_tokens']),
    totalTokens: numOrNull(raw?.['total_tokens']),
    cumulative: true,
  };
}

export interface GeminiAdapterOptions {
  fetchFn: FetchFn;
  apiKey: string;
}

export class GeminiInteractionsAdapter implements ProviderAdapter {
  readonly provider = 'gemini' as const;
  private readonly fetchFn: FetchFn;
  private readonly apiKey: string;

  constructor(options: GeminiAdapterOptions & { fetchFn: FetchFn }) {
    this.fetchFn = options.fetchFn;
    this.apiKey = options.apiKey;
  }

  audioSupport(): { support: 'supported' | 'unsupported' | 'unverified'; detail: string } {
    return {
      support: 'unverified',
      detail: 'Audio input is documented for the selected models but no endpoint test has run.',
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
    for (const tool of input.tools) validateToolDeclaration(tool);
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
    if (input.previousContinuation && input.previousContinuation.kind !== 'gemini-interactions') {
      throw new ProviderErrorException({
        code: 'invalid_request',
        message: 'Continuation belongs to a different endpoint family.',
        retryable: false,
        retryAfterMs: null,
      });
    }

    const timeout = AbortSignal.timeout(input.timeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    if (input.signal?.aborted) {
      yield { type: 'error', error: { code: 'aborted', message: 'Turn aborted before start.', retryable: false, retryAfterMs: null } };
      return;
    }

    const { systemInstruction, blocks } = toInteractionsInput(input);
    const body: Record<string, unknown> = {
      model: input.model.modelId,
      input: blocks,
      stream: true,
      generation_config: {
        max_output_tokens: input.maxOutputTokens,
      },
    };
    if (systemInstruction !== undefined) body['system_instruction'] = systemInstruction;
    if (input.tools.length > 0) {
      body['tools'] = input.tools.map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
    }
    const prevId = input.previousContinuation?.interactionId;
    if (prevId) body['previous_interaction_id'] = prevId;

    let response: Response;
    try {
      response = await this.fetchFn(GEMINI_INTERACTIONS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
          'Api-Revision': GEMINI_API_REVISION,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      yield { type: 'error', error: transportError(err) };
      return;
    }
    if (!response.ok || !response.body) {
      yield { type: 'error', error: httpError(response.status, response.headers) };
      return;
    }

    yield* this.readStream(response.body, signal);
  }

  private async *readStream(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): AsyncGenerator<ProviderEvent> {
    const calls = new Map<number, AccumulatedCall>();
    let interactionId: string | null = null;
    let completed = false;
    let terminal: ProviderEvent | null = null;
    let sawToolCall = false;

    const emitCallEnd = function* (
      index: number,
    ): Generator<{ type: 'tool_call_end'; callId: string; name: string; args: unknown } | { type: 'error'; error: ProviderError }> {
      const call = calls.get(index);
      calls.delete(index);
      if (!call || !call.id || !call.name) {
        yield {
          type: 'error',
          error: {
            code: 'malformed_response',
            message: 'Provider ended a tool call without an id and name.',
            retryable: false,
            retryAfterMs: null,
          },
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
      yield { type: 'tool_call_end', callId: call.id, name: call.name, args };
    };

    try {
      for await (const { event, data } of parseSseStream(body, { signal })) {
        if (data === '[DONE]') break;
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (event === 'interaction.created') {
          const interaction = payload['interaction'] as Record<string, unknown> | undefined;
          if (interaction && typeof interaction['id'] === 'string') interactionId = interaction['id'];
        } else if (event === 'step.start') {
          const step = payload['step'] as Record<string, unknown> | undefined;
          const index = payload['index'] as number;
          if (step?.['type'] === 'function_call') {
            const id = typeof step['id'] === 'string' ? step['id'] : '';
            const name = typeof step['name'] === 'string' ? step['name'] : '';
            // step.start carries an empty arguments placeholder; only a
            // non-empty snapshot counts as complete arguments.
            let seed = '';
            let sealed = false;
            const startArgs = step['arguments'];
            if (typeof startArgs === 'string' && startArgs) {
              seed = startArgs;
              sealed = true;
            } else if (startArgs && typeof startArgs === 'object' && Object.keys(startArgs).length > 0) {
              seed = JSON.stringify(startArgs);
              sealed = true;
            }
            calls.set(index, { id, name, argsText: seed, sealed });
            yield { type: 'tool_call_start', callId: id, name };
          }
        } else if (event === 'step.delta') {
          const delta = payload['delta'] as Record<string, unknown> | undefined;
          const index = payload['index'] as number;
          if (!delta || typeof delta['type'] !== 'string') continue;
          if (delta['type'] === 'text' && typeof delta['text'] === 'string') {
            yield { type: 'text_delta', text: delta['text'] };
          } else if (delta['type'] === 'thought_summary') {
            const content = delta['content'] as Record<string, unknown> | undefined;
            if (content?.['type'] === 'text' && typeof content['text'] === 'string') {
              yield { type: 'provider_thought_summary', text: content['text'] };
            }
          } else if (delta['type'] === 'arguments_delta' || delta['type'] === 'arguments') {
            const piece =
              typeof delta['arguments'] === 'string'
                ? delta['arguments']
                : typeof delta['partial_arguments'] === 'string'
                  ? delta['partial_arguments']
                  : '';
            const call = calls.get(index);
            if (call && piece && !call.sealed) {
              if (call.argsText.length + piece.length > MAX_TOOL_ARGUMENT_BYTES) {
                yield {
                  type: 'error',
                  error: {
                    code: 'malformed_response',
                    message: 'Tool arguments exceeded the accumulation bound.',
                    retryable: false,
                    retryAfterMs: null,
                  },
                };
                return;
              }
              call.argsText += piece;
              yield { type: 'tool_call_arguments', callId: call.id, argumentsChunk: piece };
            }
          }
          // thought_signature and other opaque deltas stay server-side: ignored.
        } else if (event === 'step.stop') {
          const index = payload['index'] as number;
          if (calls.has(index)) {
            for (const out of emitCallEnd(index)) {
              yield out;
              if (out.type === 'error') {
                terminal = out;
                return;
              }
            }
          }
        } else if (event === 'interaction.completed') {
          const interaction = payload['interaction'] as Record<string, unknown> | undefined;
          if (interaction && typeof interaction['id'] === 'string') interactionId = interaction['id'];
          yield { type: 'usage', usage: mapUsage(interaction?.['usage'] as Record<string, unknown> | undefined) };
          const status = interaction?.['status'];
          const continuation = interactionId
            ? { kind: 'gemini-interactions' as const, interactionId }
            : null;
          if (status === 'completed') {
            terminal = { type: 'finish', reason: sawToolCall ? 'tool_handoff' : 'success', continuation };
          } else if (status === 'requires_action') {
            // A tool call without a matching completed call is unusable.
            let incomplete = false;
            for (const [, call] of calls) {
              if (!call.id || !call.name) {
                incomplete = true;
                break;
              }
            }
            if (incomplete) {
              terminal = {
                type: 'error',
                error: {
                  code: 'malformed_response',
                  message: 'Interaction requires action but a tool call is incomplete.',
                  retryable: false,
                  retryAfterMs: null,
                },
              };
            } else {
              terminal = { type: 'finish', reason: 'tool_handoff', continuation };
            }
          } else if (status === 'failed' || status === 'cancelled') {
            terminal = {
              type: 'error',
              error: {
                code: status === 'cancelled' ? 'aborted' : 'transient',
                message: `Interaction ended with status '${String(status)}'.`,
                retryable: status !== 'cancelled',
                retryAfterMs: null,
              },
            };
          } else {
            terminal = {
              type: 'error',
              error: {
                code: 'malformed_response',
                message: `Unknown interaction status '${String(status)}'.`,
                retryable: false,
                retryAfterMs: null,
              },
            };
          }
          completed = true;
        } else if (event === 'error') {
          const errObj = payload['error'] as Record<string, unknown> | undefined;
          const code = typeof errObj?.['code'] === 'string' ? errObj['code'] : '';
          const timedOut = /deadline|timeout|unavailable/i.test(code);
          terminal = {
            type: 'error',
            error: {
              code: timedOut ? 'timeout' : 'transient',
              message: timedOut ? 'Gemini stream timed out.' : 'Gemini stream returned an error.',
              retryable: true,
              retryAfterMs: null,
            },
          };
          completed = true;
        }
        // Unknown events and status updates: ignored per versioning policy.
        if (terminal) {
          yield terminal;
          return;
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'SseOverflowError') {
        yield {
          type: 'error',
          error: { code: 'malformed_response', message: err.message, retryable: false, retryAfterMs: null },
        };
        return;
      }
      yield { type: 'error', error: transportError(err) };
      return;
    }
    if (!completed) {
      yield {
        type: 'error',
        error: {
          code: 'malformed_response',
          message: 'Stream ended before the required completion marker.',
          retryable: false,
          retryAfterMs: null,
        },
      };
    }
  }
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

/** Bounded credential probe: fetches one selected model resource (no inference). */
export async function probeGeminiCredential(
  fetchFn: FetchFn,
  apiKey: string,
  modelId: string,
  timeoutMs = 15_000,
): Promise<{ ok: boolean; status: number }> {
  const response = await fetchFn(`${GEMINI_ORIGIN}/v1beta/models/${modelId}`, {
    method: 'GET',
    headers: { 'x-goog-api-key': apiKey, 'Api-Revision': GEMINI_API_REVISION },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { ok: response.ok, status: response.status };
}

export function geminiErrorFromStatus(status: number, headers: Headers): ProviderError {
  return httpError(status, headers);
}
