import { describe, expect, it } from 'vitest';
import { AgentStreamError, collectAndValidateProviderStream } from '../src/run.js';
import type { ProviderEvent } from '../src/providers/types.js';

async function collect(events: ProviderEvent[]): Promise<unknown> {
  try {
    await collectAndValidateProviderStream(events);
    return null;
  } catch (err) {
    return err;
  }
}

async function collectOk(events: ProviderEvent[]) {
  return collectAndValidateProviderStream(events);
}

function toolCallEvents(callId: string, name: string, args: unknown): ProviderEvent[] {
  return [
    { type: 'tool_call_start', callId, name },
    { type: 'tool_call_arguments', callId, argumentsChunk: JSON.stringify(args) },
    { type: 'tool_call_end', callId, name, args },
    { type: 'finish', reason: 'tool_handoff', continuation: null },
  ];
}

describe('collect provider round failure typing', () => {
  it('carries the adapter error code through AgentStreamError.providerCode', async () => {
    const err = await collect([
      {
        type: 'error',
        error: { code: 'rate_limited', message: 'Rate limit.', retryable: true, retryAfterMs: 1000, status: 429 },
      },
    ]);
    expect(err).toBeInstanceOf(AgentStreamError);
    const typed = err as AgentStreamError;
    expect(typed.code).toBe('provider_error');
    expect(typed.providerCode).toBe('rate_limited');
    expect(typed.retryable).toBe(true);
    expect(typed.retryAfterMs).toBe(1000);
    expect(typed.status).toBe(429);
  });

  it('leaves providerCode unset for stream-shape failures', async () => {
    const err = await collect([{ type: 'text_delta', text: 'hi ' }]);
    expect(err).toBeInstanceOf(AgentStreamError);
    const typed = err as AgentStreamError;
    expect(typed.code).toBe('stream_interrupted');
    expect(typed.providerCode).toBeUndefined();
  });
});

describe('stream retry helpers', () => {
  it('identifies retryable stream errors correctly', async () => {
    const { isRetryableStreamError, getStreamRetryDelayMs } = await import('../src/run.js');
    const rateLimited = new AgentStreamError('provider_error', 'Rate limited', 'rate_limited', true, 1500, 429);
    expect(isRetryableStreamError(rateLimited)).toBe(true);

    const serverDown = new AgentStreamError('provider_error', 'Service unavailable', 'transient', true, null, 503);
    expect(isRetryableStreamError(serverDown)).toBe(true);

    const interrupted = new AgentStreamError('stream_interrupted', 'Dropped connection');
    expect(isRetryableStreamError(interrupted)).toBe(true);

    const cancelled = new AgentStreamError('stream_cancelled', 'Cancelled');
    expect(isRetryableStreamError(cancelled)).toBe(false);

    const unknownTool = new AgentStreamError('unknown_tool', 'Invalid tool');
    expect(isRetryableStreamError(unknownTool)).toBe(false);

    expect(getStreamRetryDelayMs(rateLimited, 0)).toBe(1500);
    expect(getStreamRetryDelayMs(serverDown, 0)).toBe(500);
    expect(getStreamRetryDelayMs(serverDown, 1)).toBe(1000);
  });
});

describe('collect correctable validation outcomes', () => {
  it('passes invalid tool arguments through for executor feedback instead of throwing', async () => {
    const badArgs = { kind: 'quote', description: 'rejected extra arg' };
    const round = await collectOk(toolCallEvents('call_bad', 'log_event', badArgs));
    expect(round.toolCalls).toHaveLength(1);
    expect(round.toolCalls[0]).toMatchObject({ callId: 'call_bad', name: 'log_event', args: badArgs });
  });

  it('still aborts the round on unknown tools before any sibling mutates', async () => {
    const err = await collect(toolCallEvents('call_unknown', 'frobnicate', { x: 1 }));
    expect(err).toBeInstanceOf(AgentStreamError);
    expect((err as AgentStreamError).code).toBe('unknown_tool');
  });

  it('passes a deadline-less create_task through for the executor clarification path', async () => {
    const round = await collectOk(
      toolCallEvents('call_nodeadline', 'create_task', { title: 'Call back' }),
    );
    expect(round.toolCalls).toHaveLength(1);
    expect(round.toolCalls[0]).toMatchObject({ callId: 'call_nodeadline', name: 'create_task' });
  });

  it('still throws for unparseable argument JSON', async () => {
    const err = await collect([
      { type: 'tool_call_start', callId: 'call_json', name: 'log_event' },
      { type: 'tool_call_arguments', callId: 'call_json', argumentsChunk: '{not json' },
      { type: 'tool_call_end', callId: 'call_json', name: 'log_event', args: undefined },
      { type: 'finish', reason: 'tool_handoff', continuation: null },
    ]);
    expect(err).toBeInstanceOf(AgentStreamError);
    expect((err as AgentStreamError).code).toBe('malformed_tool_args');
  });

  it('still throws for incomplete and duplicate calls', async () => {
    const incomplete = await collect([
      { type: 'tool_call_start', callId: 'call_half', name: 'log_event' },
      { type: 'finish', reason: 'tool_handoff', continuation: null },
    ]);
    expect((incomplete as AgentStreamError).code).toBe('incomplete_tool_call');
    const duplicate = await collect([
      { type: 'tool_call_start', callId: 'call_dup', name: 'log_event' },
      { type: 'tool_call_start', callId: 'call_dup', name: 'log_event' },
    ]);
    expect((duplicate as AgentStreamError).code).toBe('duplicate_call_id');
  });
});