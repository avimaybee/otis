/**
 * @otis/agent/providers/fake
 * Deterministic scripted provider for Plan 006 policy tests and adapter
 * contract tests. Performs no network I/O and no business writes. Fake-only
 * registry entries travel through test injection, never the production
 * allowlist.
 */

import type { ProviderName } from '@otis/contracts';
import type {
  FetchFn,
  ProviderAdapter,
  ProviderEvent,
  ProviderUsage,
  TurnInput,
} from './types.js';

export type FakeTurnScript =
  | { kind: 'text'; text: string; usage?: Partial<ProviderUsage> }
  | { kind: 'tool_calls'; calls: Array<{ callId: string; name: string; args: unknown }> }
  | {
      kind: 'tool_result_continuation';
      intermediateText: string;
      calls: Array<{ callId: string; name: string; args: unknown }>;
      finalText: string;
    }
  | { kind: 'hang_until_abort' }
  | { kind: 'fail'; code: 'transient' | 'rate_limited' | 'blocked'; message?: string };

export interface FakeAdapterOptions {
  provider?: ProviderName;
  fetchFn?: FetchFn;
  scripts: FakeTurnScript[];
}

function scriptUsage(partial?: Partial<ProviderUsage>): ProviderUsage {
  return {
    inputTokens: partial?.inputTokens ?? null,
    outputTokens: partial?.outputTokens ?? null,
    cacheReadTokens: partial?.cacheReadTokens ?? null,
    cacheWriteTokens: partial?.cacheWriteTokens ?? null,
    reasoningTokens: partial?.reasoningTokens ?? null,
    totalTokens: partial?.totalTokens ?? null,
    cumulative: true,
  };
}

/** Records how the fake was invoked so tests prove credential plumbing. */
export interface FakeCallRecord {
  requestId: string;
  modelId: string;
  sessionId: string;
}

export class FakeProviderAdapter implements ProviderAdapter {
  readonly provider: ProviderName;
  readonly calls: FakeCallRecord[] = [];
  private readonly scripts: FakeTurnScript[];
  private cursor = 0;

  constructor(options: FakeAdapterOptions) {
    this.provider = options.provider ?? 'gemini';
    this.scripts = [...options.scripts];
  }

  audioSupport(): { support: 'supported' | 'unsupported' | 'unverified'; detail: string } {
    return { support: 'unverified', detail: 'Fake provider performs no audio transport.' };
  }

  async *streamTurn(input: TurnInput): AsyncIterable<ProviderEvent> {
    this.calls.push({ requestId: input.requestId, modelId: input.model.modelId, sessionId: input.sessionId });
    const script = this.scripts[this.cursor] ?? { kind: 'text', text: '' };
    this.cursor += 1;

    if (script.kind === 'hang_until_abort') {
      await new Promise<void>((_resolve, reject) => {
        if (input.signal?.aborted) {
          reject(new Error('aborted before start'));
          return;
        }
        input.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }).catch(() => undefined);
      yield {
        type: 'error',
        error: { code: 'aborted', message: 'Turn aborted.', retryable: false, retryAfterMs: null },
      };
      return;
    }

    if (script.kind === 'fail') {
      yield {
        type: 'error',
        error: {
          code: script.code,
          message: script.message ?? `Fake ${script.code} failure.`,
          retryable: script.code !== 'blocked',
          retryAfterMs: null,
        },
      };
      return;
    }

    if (script.kind === 'text') {
      if (script.text) yield { type: 'text_delta', text: script.text };
      yield { type: 'usage', usage: scriptUsage(script.usage) };
      yield { type: 'finish', reason: 'success', continuation: null };
      return;
    }

    if (script.kind === 'tool_calls' || script.kind === 'tool_result_continuation') {
      if (script.kind === 'tool_result_continuation' && script.intermediateText) {
        yield { type: 'text_delta', text: script.intermediateText };
      }
      for (const call of script.calls) {
        yield { type: 'tool_call_start', callId: call.callId, name: call.name };
        const argsText = JSON.stringify(call.args);
        yield { type: 'tool_call_arguments', callId: call.callId, argumentsChunk: argsText };
        yield { type: 'tool_call_end', callId: call.callId, name: call.name, args: call.args };
      }
      if (script.kind === 'tool_result_continuation') {
        // A continuation replays the recorded result as provider text: the
        // script models a tool-result round trip without network I/O.
        if (input.pendingToolResults.length > 0 && script.finalText) {
          yield { type: 'text_delta', text: script.finalText };
        }
      }
      yield { type: 'usage', usage: scriptUsage() };
      yield {
        type: 'finish',
        reason: 'tool_handoff',
        continuation: { kind: 'gemini-interactions', interactionId: `fake_${input.requestId}` },
      };
      return;
    }
  }
}
