/**
 * @otis/agent/run
 * Provider-neutral bounded agent loop, stream accumulation, tool group validation,
 * and durable progress state.
 * In accordance with plans/006-implementation-handoff.md Section 7.
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
  approvedBulkScope?: string[];
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
  ) {
    super(message);
    this.name = 'AgentStreamError';
    this.code = code;
  }
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
        throw new AgentStreamError('provider_error', event.error.message || `Provider returned error code: ${event.error.code}`);
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

    // 3. Pre-validate against registered schema
    const validation = validateToolCall(item.name, args);
    if (!validation.ok) {
      if (validation.error.code === 'unknown_tool') {
        throw new AgentStreamError('unknown_tool', `Model proposed unrecognized tool '${item.name}'.`);
      }
      if (validation.error.code === 'missing_deadline' && item.name === 'create_task') {
        completedCalls.push({
          callId: item.callId,
          name: item.name,
          args,
        });
        continue;
      }
      throw new AgentStreamError(
        'malformed_tool_args',
        `Validation failed for tool '${item.name}': ${validation.error.message}`,
      );
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
