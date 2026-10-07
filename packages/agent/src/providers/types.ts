/**
 * @otis/agent/providers/types
 * Provider-neutral turn contract for Plan 005.
 *
 * Plan 006 consumes streamed text, completed tool calls, usage and typed
 * failures through this interface without knowing HTTP protocols. Adapters
 * translate provider wire shapes into these events and never execute tools:
 * transport completion means the provider finished its output, not that Otis
 * saved an action.
 */

import type { ProviderName } from '@otis/contracts';

/** Fixed provider origins. Adapters never accept a caller-supplied base URL. */
export const GEMINI_ORIGIN = 'https://generativelanguage.googleapis.com';
export const OPENCODE_GO_ORIGIN = 'https://opencode.ai/zen/go';

/** Distinctive client identification required by OpenCode Go. */
export const OTIS_USER_AGENT = 'otis/0.1.0';

/** Named transport bounds. */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 60_000;
export const MAX_SSE_BUFFER_BYTES = 256 * 1024;
export const MAX_TOOL_ARGUMENT_BYTES = 64 * 1024;
export const MAX_TEXT_BUFFER_CHARS = 256 * 1024;
/**
 * Attached still images per user message. Mirrors contracts IMAGE_BOUNDS.
 * MAX_PER_MESSAGE; the contracts module owns the product bound and a test
 * below pins equality so the two cannot drift.
 */
export const MAX_IMAGES_PER_MESSAGE = 4;
/**
 * Image containers an adapter may forward. Mirrors contracts IMAGE_FORMATS
 * (magic-byte verified at upload); adapters never accept anything else.
 */
export const SUPPORTED_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;
/** Base64 ceiling per image: 5 MiB of bytes decodes from ~6.8M chars; 8M caps abuse. */
export const MAX_IMAGE_DATA_CHARS = 8 * 1024 * 1024;

/**
 * Whether the pinned model may receive attached still images. Owned by
 * registry ModelCapabilities['vision']; resolvers copy it here so adapters
 * can refuse before spend. Absent means the caller did not resolve it:
 * adapters map images and let the attempt itself produce evidence.
 */
export type VisionSupport = 'supported' | 'unsupported' | 'unverified';

export type EndpointFamily = 'gemini-interactions' | 'go-chat-completions' | 'go-responses';

export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  text?: string;
  /** Present when a user message carries native audio bytes (base64). */
  audio?: {
    data: string;
    mimeType: string;
    format?: 'wav' | 'mp4' | 'ogg' | 'webm';
  };
  /** Present when a user message carries attached still images (base64). */
  images?: Array<{
    data: string;
    mimeType: string;
  }>;
  /** Present when an assistant message made tool calls. */
  toolCalls?: AssistantToolCall[];
  /** Present when role === 'tool', matching a prior tool call id. */
  toolCallId?: string;
  /** Optional tool name for a tool result message. */
  name?: string;
}

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolResultBlock {
  callId: string;
  name: string;
  /** Original arguments passed to the tool call; preserved faithfully for continuation. */
  arguments?: string | Record<string, unknown> | null;
  resultText: string;
  /**
   * Ephemeral hydrated images for a view_image result. Lives on the in-memory
   * request only: adapters map these into endpoint-native visual input, and
   * they must never be written to checkpoints, logs, or durable results.
   */
  images?: Array<{
    data: string;
    mimeType: string;
  }>;
}

export interface AssistantToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Ordered record of a completed tool round within a multi-round turn. */
export interface HistoricalToolRound {
  assistantToolCalls: AssistantToolCall[];
  toolResults: ToolResultBlock[];
}

/**
 * Opaque protocol continuation kept server-side only. Never rendered,
 * logged, or sent to the client. Persisted-turn recovery is Plan 006's
 * responsibility; this object names the fields it must store.
 *
 * For go-chat-completions, assistantToolCalls preserves the exact grouping
 * and arguments of the tool calls emitted by the assistant so that subsequent
 * continuation turns replay faithful conversation history. priorRounds preserves
 * earlier tool calls and results across successive rounds of the same turn.
 */
export interface ServerContinuation {
  kind: EndpointFamily;
  interactionId?: string;
  previousResponseId?: string;
  assistantToolCalls?: AssistantToolCall[];
  priorRounds?: HistoricalToolRound[];
}

export interface ResolvedModel {
  commandKey: string;
  provider: ProviderName;
  modelId: string;
  endpointFamily: EndpointFamily;
  endpointUrl: string;
  /** Copied from the registry entry by the resolver; absent when unresolved. */
  vision?: VisionSupport;
}

export type ThinkingRequest =
  | { kind: 'provider_default' }
  | { kind: 'gemini_level'; level: 'minimal' | 'low' | 'medium' | 'high' }
  | { kind: 'go_chat_effort'; effort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'none' }
  | { kind: 'go_responses_effort'; effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' };

export interface TurnInput {
  model: ResolvedModel;
  /** Stable per (workspace, chat); distinct chats never share one. */
  sessionId: string;
  workspaceId: string;
  chatId: string;
  runId: string;
  requestId: string;
  /** Complete message history in order; adapters map roles per endpoint. */
  messages: ProviderMessage[];
  /**
   * Messages that are genuinely new since a linked server continuation was
   * created (steering context, clarification answers). Adapters that support
   * stateful continuations send these as new input alongside the pending
   * tool results; stored history is never replayed on the linked request.
   * Ignored for stateless/initial requests.
   */
  continuationInput?: ProviderMessage[];
  /** Results for a previous handoff; empty on a fresh turn. */
  pendingToolResults: ToolResultBlock[];
  previousContinuation?: ServerContinuation | null;
  tools: ToolDeclaration[];
  maxOutputTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
  thinking?: ThinkingRequest;
}

export interface ProviderUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  /** True when the snapshot supersedes earlier snapshots in this turn. */
  cumulative: boolean;
}

export type FinishReason =
  | 'success'
  | 'tool_handoff'
  | 'length_limit'
  | 'refusal_or_block'
  | 'cancelled';

export type ProviderErrorCode =
  | 'invalid_credential'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'unknown_model'
  | 'unsupported_capability'
  | 'timeout'
  | 'aborted'
  | 'malformed_response'
  | 'blocked'
  | 'transient'
  | 'invalid_request';

export interface ProviderError {
  code: ProviderErrorCode;
  /** Sanitized: never a raw upstream body, URL, or key-bearing object. */
  message: string;
  retryable: boolean;
  /** Provider-supplied reset hint in ms when present; never invented. */
  retryAfterMs: number | null;
  status?: number;
}

export class ProviderErrorException extends Error {
  public readonly detail: ProviderError;

  constructor(detail: ProviderError) {
    super(detail.message);
    this.name = 'ProviderErrorException';
    this.detail = detail;
  }
}

export type ProviderEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_start'; callId: string; name: string }
  | { type: 'tool_call_arguments'; callId: string; argumentsChunk: string }
  | { type: 'tool_call_end'; callId: string; name: string; args: unknown }
  | {
      type: 'provider_thought_summary';
      text: string;
      /** Step-scoped identity within one stream (`s{index}`); handler groups by run/round/block. */
      blockId: string;
      /** The documented wire channel: incremental thought-summary text. */
      contentKind: 'summary';
      /** `snapshot` replaces the block (step.start summary); `append` extends it (deltas). */
      mode: 'snapshot' | 'append';
    }
  | { type: 'usage'; usage: ProviderUsage }
  | {
      type: 'finish';
      reason: FinishReason;
      continuation: ServerContinuation | null;
    }
  | { type: 'error'; error: ProviderError };

/**
 * Terminal convention: a turn yields exactly one terminal event — either
 * `finish` or `error` — and never throws after yielding `error`. Input
 * validation failures throw `ProviderErrorException` before any event.
 */
export interface ProviderAdapter {
  readonly provider: ProviderName;
  streamTurn(input: TurnInput): AsyncIterable<ProviderEvent>;
  /** Audio transcription is unverified for every selected model in 005. */
  audioSupport(): { support: 'supported' | 'unsupported' | 'unverified'; detail: string };
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Normalizes any fetch implementation so invoking it never depends on its
 * receiver. Native platform `fetch` detached from its global and called as a
 * bare function or object member throws "Illegal invocation" inside
 * Cloudflare Workers; the arrow wrapper invokes it lexically instead. Pass
 * every injected transport through here at its owner boundary.
 */
export function receiverSafeFetch(fetchFn: FetchFn): FetchFn {
  return (url, init) => fetchFn(url, init);
}

export interface AdapterEnv {
  fetchFn: FetchFn;
  apiKey: string;
}

export function emptyUsage(): ProviderUsage {
  return {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    cumulative: true,
  };
}

/** Missing numeric fields stay null; explicit zeros are preserved. */
export function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Parses an HTTP Retry-After value (delay seconds or HTTP date) into
 * milliseconds. Returns null when absent or unparseable; never invents one.
 */
export function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  return null;
}

/**
 * Validates attached still images on every user message before any spend.
 * Throws invalid_request when a message carries too many images, an
 * unverified container, or an empty/oversized payload. Adapters call this
 * at stream entry over messages plus continuation input.
 */
export function validateTurnImages(messages: ProviderMessage[]): void {
  for (const message of messages) {
    if (message.role !== 'user' || !message.images || message.images.length === 0) continue;
    if (message.images.length > MAX_IMAGES_PER_MESSAGE) {
      throw new ProviderErrorException({
        code: 'invalid_request',
        message: `A message carries ${message.images.length} images; at most ${MAX_IMAGES_PER_MESSAGE} are supported.`,
        retryable: false,
        retryAfterMs: null,
      });
    }
    for (const image of message.images) {
      if (!(SUPPORTED_IMAGE_MIMES as readonly string[]).includes(image.mimeType)) {
        throw new ProviderErrorException({
          code: 'invalid_request',
          message: `Image container '${image.mimeType}' is not supported. Supported containers: ${SUPPORTED_IMAGE_MIMES.join(', ')}.`,
          retryable: false,
          retryAfterMs: null,
        });
      }
      if (!image.data || image.data.length > MAX_IMAGE_DATA_CHARS) {
        throw new ProviderErrorException({
          code: 'invalid_request',
          message: 'An attached image is empty or exceeds the per-image size bound.',
          retryable: false,
          retryAfterMs: null,
        });
      }
    }
  }
}

/**
 * Refuses image-carrying turns for models the registry marks as unable
 * before any spend. Unverified models pass through: the documented wire
 * shape is attempted and the outcome itself becomes probe evidence.
 * Call only when the turn actually carries images.
 */
export function assertVisionForImages(model: ResolvedModel): void {
  if (model.vision === 'unsupported') {
    throw new ProviderErrorException({
      code: 'unsupported_capability',
      message: `Model '${model.commandKey}' does not accept image input; send text only or switch models.`,
      retryable: false,
      retryAfterMs: null,
    });
  }
}

/** True when any message in the turn carries at least one attached image. */
export function turnHasImages(messages: ProviderMessage[]): boolean {
  return messages.some((m) => m.role === 'user' && !!m.images && m.images.length > 0);
}
