/** Audit-only defect reproductions. Green means the remaining defect exists. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isExplicitSentConfirmation, isExplicitStatusIntent } from '../../packages/agent/src/policy.js';
import { api } from '../../apps/web/src/api/client.js';
import { validateTaskDue } from '../../packages/agent/src/tools.js';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('remaining resolution-claim defects', () => {
  it('instant deadline validator still accepts February 31 through Date.parse normalization', () => {
    expect(validateTaskDue({ kind: 'instant', at: '2026-02-31T10:00:00Z', timezone: 'UTC' }).ok).toBe(true);
  });
  it.each(['The customer sent me their logo.', 'I will have sent it by Friday.'])(
    'sent guard accepts third-party or future action: %s', text => {
      expect(isExplicitSentConfirmation(text).isConfirmed).toBe(true);
    },
  );

  it('status guard accepts a different entity signing in the same sentence', () => {
    expect(isExplicitStatusIntent('Bistro signed; Cafe is still deciding.', 'won').isExplicit).toBe(true);
  });

  it('request timeout is cleared before a stalled response body finishes', async () => {
    vi.useFakeTimers();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(new TextEncoder().encode('{"user":{"id":"audit-user","display_name":null},"workspaces":[]}'));
      },
    });
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_path: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    let settled = false;
    const request = api.me().finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(signal?.aborted).toBe(false);
    expect(settled).toBe(false);
    streamController.close();
    await request;
  });
});
