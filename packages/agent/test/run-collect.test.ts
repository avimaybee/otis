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

describe('collect provider round failure typing', () => {
  it('carries the adapter error code through AgentStreamError.providerCode', async () => {
    const err = await collect([
      {
        type: 'error',
        error: { code: 'rate_limited', message: 'Rate limit.', retryable: true, retryAfterMs: 1000 },
      },
    ]);
    expect(err).toBeInstanceOf(AgentStreamError);
    const typed = err as AgentStreamError;
    expect(typed.code).toBe('provider_error');
    expect(typed.providerCode).toBe('rate_limited');
  });

  it('leaves providerCode unset for stream-shape failures', async () => {
    const err = await collect([{ type: 'text_delta', text: 'hi ' }]);
    expect(err).toBeInstanceOf(AgentStreamError);
    const typed = err as AgentStreamError;
    expect(typed.code).toBe('stream_interrupted');
    expect(typed.providerCode).toBeUndefined();
  });
});