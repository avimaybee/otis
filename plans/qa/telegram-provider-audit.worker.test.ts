import { describe, expect, it } from 'vitest';
import { transcribeWithGroq, GROQ_STT_ORIGIN } from '../../packages/agent/src/providers/groqStt.js';

describe('Reported Groq transport failure in actual workerd; network mocked', () => {
  it('reproduces the historical native-fetch receiver error', async () => {
    const historicalParams = { fetchFn: fetch };
    await expect((async () => historicalParams.fetchFn(`${GROQ_STT_ORIGIN}/openai/v1/audio/transcriptions`, {
      method: 'POST', body: 'synthetic audit fixture',
    }))()).rejects.toThrow(/Illegal invocation|incorrect.*this/i);
  });

  it('current Groq helper accepts native fetch and reaches a controlled HTTP response', async () => {
    const result = await transcribeWithGroq({
      apiKey: 'audit-fixture-not-a-real-key', model: 'whisper-large-v3-turbo',
      bytes: new Uint8Array([1, 2, 3, 4]), filename: 'fixture.ogg', mimeType: 'audio/ogg', fetchFn: fetch,
    });
    expect(result).toEqual({ ok: true, text: 'Synthetic transport fixture.', language: 'en', durationSeconds: 1 });
  });
});
