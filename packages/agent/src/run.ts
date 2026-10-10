/**
 * @otis/agent/run
 * Provider-neutral bounded agent loop, stream accumulation, tool group validation,
 * and durable progress state.
 * In accordance with docs/archive/plans/006-implementation-handoff.md Section 7.
 */

import type { CommandResult } from '@otis/contracts';
import type {
  FinishReason,
  ProviderEvent,
  ProviderUsage,
  ServerContinuation,
} from './providers/types.js';
import { validateToolCall } from './tools.js';

export interface AssistantCall {
  callId: string;
  name: string;
  args: unknown;
}

export interface PlannedToolExecution {
  callId: string;
  name: string;
  args: unknown;
  actionId: string;
}

export interface DurableToolResult {
  callId: string;
  actionId: string;
  name: string;
  args: unknown;
  result: CommandResult;
}

export interface DurableCompletedRound {
  roundIndex: number;
  assistantCalls: AssistantCall[];
  toolResults: DurableToolResult[];
  continuation: ServerContinuation | null;
  usage?: ProviderUsage | null;
}

export interface DurableAgentProgress {
  version: 1;
  phase: 'init' | 'provider_pending' | 'tools_executing' | 'completed' | 'clarification';
  roundIndex: number;
  currentRound?: {
    assistantCalls: AssistantCall[];
    continuation: ServerContinuation | null;
    usage?: ProviderUsage | null;
  };
  completedRounds?: DurableCompletedRound[];
  completedToolResults: DurableToolResult[];
  nextToolIndex: number;
  finalAnswer?: string | null;
  steeringInputs?: { messageId: string; sourceMessageId: string; text: string; sequence: number }[];
  lastSteeringSequence?: number;
  /** How many steeringInputs were already sent to the provider in a request. */
  sentSteeringCount?: number;
  /**
   * Source message id of the clarification answer already sent to the
   * provider. Identity, not text: each distinct clarification answer must be
   * sent once, and an already-sent answer is never repeated across rounds or
   * restarts.
   */
  sentAnswerMessageId?: string;
  approvedBulkScope?: string[];
  /**
   * Set when the correction guard steered one extra round after a text-only
   * answer to an explicit value correction. At most one steered round per
   * run: a second text-only answer completes normally instead of looping.
   */
  correctionSteerSent?: boolean;
  pendingClarification?: {
    question: string;
    intendedOperation: string;
    missingFields: string[];
    candidates?: unknown;
    clarificationId?: string;
    callId?: string;
    actionId?: string;
    stepIndex?: number;
    proposedArguments?: Record<string, unknown>;
    pendingOperation?: unknown;
    sourceRevision?: number;
  };
}

export interface CollectedProviderRound {
  text: string;
  toolCalls: AssistantCall[];
  finishReason: FinishReason;
  continuation: ServerContinuation | null;
  usage?: ProviderUsage | null;
}

export class AgentStreamError extends Error {
  public readonly code:
    | 'stream_interrupted'
    | 'stream_cancelled'
    | 'incomplete_tool_call'
    | 'malformed_tool_args'
    | 'duplicate_call_id'
    | 'unknown_tool'
    | 'provider_error'
    | 'refusal'
    | 'length_exceeded';
  /**
   * The adapter's own typed code when `code` is 'provider_error', drawn from
   * the closed provider-code union (transport/HTTP/decoding/limits). Survives
   * collection so the handler can log the precise failure instead of a single
   * blanket stream error. Never a raw upstream body.
   */
  public readonly providerCode?: string;
  public readonly retryable?: boolean;
  public readonly retryAfterMs?: number | null;
  public readonly status?: number;

  constructor(
    code:
      | 'stream_interrupted'
      | 'stream_cancelled'
      | 'incomplete_tool_call'
      | 'malformed_tool_args'
      | 'duplicate_call_id'
      | 'unknown_tool'
      | 'provider_error'
      | 'refusal'
      | 'length_exceeded',
    message: string,
    providerCode?: string,
    retryable?: boolean,
    retryAfterMs?: number | null,
    status?: number,
  ) {
    super(message);
    this.name = 'AgentStreamError';
    this.code = code;
    if (providerCode !== undefined) this.providerCode = providerCode;
    if (retryable !== undefined) this.retryable = retryable;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
    if (status !== undefined) this.status = status;
  }
}

/**
 * Returns true if an error from a provider turn is transient and safe to retry automatically.
 * Covers upstream rate limits (429), outages / gateway failures (502, 503, 504), network timeouts,
 * and premature stream disconnections.
 */
export function isRetryableStreamError(err: unknown): boolean {
  if (err instanceof AgentStreamError) {
    if (err.code === 'stream_cancelled' || err.code === 'unknown_tool' || err.code === 'refusal') {
      return false;
    }
    if (err.retryable === true) return true;
    if (err.code === 'stream_interrupted') return true;
    if (err.status === 429 || err.status === 502 || err.status === 503 || err.status === 504) return true;
    if (err.providerCode === 'rate_limited' || err.providerCode === 'transient' || err.providerCode === 'timeout') return true;
  }
  if (err && typeof err === 'object') {
    if ('detail' in err) {
      const detail = (err as { detail: unknown }).detail;
      if (detail && typeof detail === 'object') {
        const d = detail as { retryable?: boolean; status?: number; code?: string };
        if (d.retryable === true) return true;
        if (d.status === 429 || (d.status !== undefined && d.status >= 500 && d.status <= 504)) return true;
        if (d.code === 'rate_limited' || d.code === 'transient' || d.code === 'timeout') return true;
      }
    }
    const anyErr = err as { status?: number; code?: string; retryable?: boolean };
    if (anyErr.retryable === true) return true;
    if (anyErr.status === 429 || (anyErr.status !== undefined && anyErr.status >= 500 && anyErr.status <= 504)) return true;
    if (anyErr.code === 'rate_limited' || anyErr.code === 'transient' || anyErr.code === 'timeout') return true;
  }
  return false;
}

/**
 * Calculates a backoff delay in milliseconds for a retryable stream error, honoring upstream
 * retryAfterMs hints and exponential backoff, bounded within Cloudflare Worker lifecycle.
 */
export function getStreamRetryDelayMs(err: unknown, attempt: number): number {
  let delay = 500 * Math.pow(2, attempt);
  if (err instanceof AgentStreamError && typeof err.retryAfterMs === 'number' && err.retryAfterMs > 0) {
    delay = Math.max(delay, err.retryAfterMs);
  }
  return Math.min(Math.max(delay, 200), 3000);
}

/**
 * Consumes an AsyncIterable<ProviderEvent> from an adapter and collects
 * a strictly verified, complete provider round.
 * Premature stream termination, broken JSON, duplicate call IDs, or unknown
 * tools reject immediately before any tool starts executing.
 */
export async function collectAndValidateProviderStream(
  stream: AsyncIterable<ProviderEvent>,
): Promise<CollectedProviderRound> {
  let text = '';
  const toolCallsMap = new Map<string, { callId: string; name: string; argsChunk: string; parsedArgs?: unknown; ended: boolean }>();
  let finishReason: CollectedProviderRound['finishReason'] | null = null;
  let continuation: ServerContinuation | null = null;
  let usage: ProviderUsage | null = null;
  let receivedTerminalEvent = false;

  for await (const event of stream) {
    switch (event.type) {
      case 'text_delta':
        text += event.text;
        break;

      case 'tool_call_start': {
        if (toolCallsMap.has(event.callId)) {
          throw new AgentStreamError('duplicate_call_id', `Duplicate tool call ID received: '${event.callId}'.`);
        }
        toolCallsMap.set(event.callId, {
          callId: event.callId,
          name: event.name,
          argsChunk: '',
          ended: false,
        });
        break;
      }

      case 'tool_call_arguments': {
        const item = toolCallsMap.get(event.callId);
        if (!item) {
          throw new AgentStreamError('stream_interrupted', `Received arguments chunk for unstarted call ID '${event.callId}'.`);
        }
        item.argsChunk += event.argumentsChunk;
        break;
      }

      case 'tool_call_end': {
        const item = toolCallsMap.get(event.callId);
        if (!item) {
          throw new AgentStreamError('stream_interrupted', `Received tool_call_end for unstarted call ID '${event.callId}'.`);
        }
        item.ended = true;
        item.parsedArgs = event.args;
        break;
      }

      case 'usage':
        usage = event.usage;
        break;

      case 'finish':
        receivedTerminalEvent = true;
        finishReason = event.reason;
        continuation = event.continuation;
        break;

      case 'error':
        throw new AgentStreamError(
          'provider_error',
          event.error.message || `Provider returned error code: ${event.error.code}`,
          event.error.code,
          event.error.retryable,
          event.error.retryAfterMs,
          event.error.status,
        );
    }
  }

  // 1. Verify stream finished cleanly with a finish event
  if (!receivedTerminalEvent || !finishReason) {
    throw new AgentStreamError('stream_interrupted', 'Provider stream ended prematurely without a finish event.');
  }

  if (finishReason === 'cancelled') {
    throw new AgentStreamError('stream_cancelled', 'Provider stream was cancelled before completing.');
  }

  if (finishReason === 'refusal_or_block') {
    throw new AgentStreamError('refusal', 'Model refused to answer the prompt.');
  }

  if (finishReason === 'length_limit') {
    throw new AgentStreamError('length_exceeded', 'Model reached maximum output token limit before finishing.');
  }

  if (finishReason !== 'success' && finishReason !== 'tool_handoff') {
    throw new AgentStreamError('stream_interrupted', `Provider stream ended with unexpected finish reason '${finishReason}'.`);
  }

  // 2. Parse and validate all tool calls in the group
  const completedCalls: AssistantCall[] = [];
  for (const item of toolCallsMap.values()) {
    if (!item.ended) {
      throw new AgentStreamError(
        'incomplete_tool_call',
        `Tool call '${item.name}' (${item.callId}) ended without receiving tool_call_end event.`,
      );
    }

    let args: unknown = item.parsedArgs;
    if (args === undefined && item.argsChunk) {
      try {
        args = JSON.parse(item.argsChunk);
      } catch (err) {
        throw new AgentStreamError(
          'malformed_tool_args',
          `Tool '${item.name}' arguments failed JSON parse: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (args === undefined) {
      args = {};
    }

    // 3. Pre-validate against registered schema. Correctable argument
    // errors on known tools flow through the executor as rejected tool
    // results, so the model sees typed feedback and can fix and retry them
    // in the next round instead of failing the whole run. An unknown tool
    // still aborts the round before any sibling mutates: a plan referencing
    // a nonexistent capability is untrustworthy as a whole. The executor
    // re-validates identically (authority and policy stay rejected there);
    // collection still throws only for transport/protocol defects otherwise.
    const validation = validateToolCall(item.name, args);
    if (!validation.ok) {
      if (validation.error.code === 'unknown_tool') {
        throw new AgentStreamError('unknown_tool', `Model proposed unrecognized tool '${item.name}'.`);
      }
      completedCalls.push({
        callId: item.callId,
        name: item.name,
        args,
      });
      continue;
    }

    completedCalls.push({
      callId: item.callId,
      name: item.name,
      args,
    });
  }

  return {
    text,
    toolCalls: completedCalls,
    finishReason,
    continuation,
    usage,
  };
}

/**
 * Creates initial empty progress object.
 */
export function createInitialProgress(): DurableAgentProgress {
  return {
    version: 1,
    phase: 'init',
    roundIndex: 0,
    completedRounds: [],
    completedToolResults: [],
    nextToolIndex: 0,
  };
}
