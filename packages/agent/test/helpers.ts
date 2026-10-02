/**
 * Shared deterministic fixtures for provider contract tests. No network I/O.
 * All wire shapes mirror the documented provider protocols; mocked evidence
 * is never presented as live capability.
 */

import type { FetchFn, ResolvedModel, TurnInput } from '../src/providers/types.js';

export function textEncoder(): TextEncoder {
  return new TextEncoder();
}

/** Builds a Response whose body streams the given byte chunks in order. */
export function chunkedResponse(chunks: Array<string | Uint8Array>, init?: ResponseInit): Response {
  const encoder = textEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
  return new Response(stream, {
    ...init,
    headers: { 'Content-Type': 'text/event-stream', ...(init?.headers ?? {}) },
  });
}

export interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export function mockFetch(
  respond: (request: RecordedRequest, init: RequestInit) => Response | Promise<Response>,
): FetchFn & { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    let body: unknown = init.body;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body) as unknown;
      } catch {
        body = init.body;
      }
    }
    const recorded = { url, headers, body };
    requests.push(recorded);
    return respond(recorded, init);
  }) as FetchFn & { requests: RecordedRequest[] };
  fetchFn.requests = requests;
  return fetchFn;
}

export function errorResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
  });
}

export function geminiModel(): ResolvedModel {
  return {
    commandKey: 'gemini-3.5-flash-lite',
    provider: 'gemini',
    modelId: 'gemini-3.5-flash-lite',
    endpointFamily: 'gemini-interactions',
    endpointUrl: 'https://generativelanguage.googleapis.com/v1beta/interactions',
  };
}

export function goChatModel(): ResolvedModel {
  return {
    commandKey: 'mimo-25',
    provider: 'opencode_go',
    modelId: 'mimo-v2.5',
    endpointFamily: 'go-chat-completions',
    endpointUrl: 'https://opencode.ai/zen/go/v1/chat/completions',
  };
}

export function goResponsesModel(): ResolvedModel {
  return {
    commandKey: 'muse-13',
    provider: 'opencode_go',
    modelId: 'muse-spark-1.3-contributor',
    endpointFamily: 'go-responses',
    endpointUrl: 'https://opencode.ai/zen/go/v1/responses',
  };
}

export function baseInput(model: ResolvedModel, overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    model,
    sessionId: 'sess_workspace_chat',
    workspaceId: 'ws-test',
    chatId: 'chat-test',
    runId: 'run-test',
    requestId: 'req-test',
    messages: [{ role: 'user', text: 'Hello' }],
    pendingToolResults: [],
    previousContinuation: null,
    tools: [],
    maxOutputTokens: 512,
    timeoutMs: 10_000,
    ...overrides,
  };
}

export const ECHO_TOOL = {
  name: 'echo_fixture',
  description: 'Echoes a fixture identifier.',
  parameters: {
    type: 'object',
    properties: { fixture_id: { type: 'string' } },
    required: ['fixture_id'],
  },
} as const;

/** Splits text into awkward byte chunks to prove boundary handling. */
export function shred(text: string, sizes: number[]): string[] {
  const out: string[] = [];
  let rest = text;
  let i = 0;
  while (rest.length > 0) {
    const size = sizes[i % sizes.length]!;
    out.push(rest.slice(0, size));
    rest = rest.slice(size);
    i += 1;
  }
  return out;
}
