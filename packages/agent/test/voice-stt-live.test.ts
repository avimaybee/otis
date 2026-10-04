/**
 * Opt-in live Groq STT probe. Skipped unless OTIS_VOICE_LIVE=1 and a
 * designated local key exists (OTIS_SMOKE_KEY, GROQ_API_KEY, or the
 * gitignored .dev.vars GROQ_API_KEY). Exactly one bounded synthetic request:
 * a 1-second tone, never speech, never evidence of transcript quality. The
 * report prints status class, character count and timing only — never the
 * key, audio bytes, transcript text, or raw upstream bodies.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
  GROQ_STT_DEFAULT_MODEL,
  GROQ_STT_ENDPOINT,
  buildSyntheticProbeWav,
  transcribeWithGroq,
} from '../src/index.js';

const live = process.env['OTIS_VOICE_LIVE'] === '1';

function readDesignatedKey(): string | null {
  const direct = process.env['OTIS_SMOKE_KEY'] ?? process.env['GROQ_API_KEY'];
  if (direct && direct.trim()) return direct.trim();
  if (existsSync('.dev.vars')) {
    for (const line of readFileSync('.dev.vars', 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('GROQ_API_KEY=')) {
        const value = trimmed.slice('GROQ_API_KEY='.length).trim();
        if (value) return value;
      }
    }
  }
  return null;
}

describe.skipIf(!live)('live Groq STT probe (opt-in, bounded)', () => {
  it('accepts one synthetic tone at the fixed endpoint', async () => {
    const key = readDesignatedKey();
    expect(key, 'OTIS_VOICE_LIVE=1 requires a designated Groq key').toBeTruthy();
    const started = Date.now();
    const result = await transcribeWithGroq({
      apiKey: key!,
      model: GROQ_STT_DEFAULT_MODEL,
      bytes: buildSyntheticProbeWav(),
      filename: 'otis-live-probe.wav',
      mimeType: 'audio/wav',
      fetchFn: fetch,
      timeoutMs: 30_000,
    });
    const elapsedMs = Date.now() - started;
    console.log(
      JSON.stringify({
        stage: 'groq_stt_probe',
        endpoint: GROQ_STT_ENDPOINT,
        model: GROQ_STT_DEFAULT_MODEL,
        ok: result.ok,
        code: result.ok ? null : result.code,
        status: result.ok ? 200 : result.status,
        textChars: result.ok ? result.text.length : null,
        ms: elapsedMs,
      }),
    );
    expect(result.ok).toBe(true);
  }, 45_000);
});
