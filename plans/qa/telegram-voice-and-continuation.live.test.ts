import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { PRODUCTION_REGISTRY } from '../../packages/agent/src/providers/registry.js';
import { GeminiInteractionsAdapter } from '../../packages/agent/src/providers/gemini.js';
import { OpenCodeGoAdapter } from '../../packages/agent/src/providers/opencode-go.js';
import { buildSyntheticProbeWav, transcribeWithGroq } from '../../packages/agent/src/providers/groqStt.js';
import type { ProviderAdapter, ProviderEvent, TurnInput } from '../../packages/agent/src/providers/types.js';

describe.skipIf(process.env['OTIS_PROVIDER_AUDIT_LIVE'] !== '1')('Synthetic audio and production-shaped MiMo continuation', () => {
  it('checks Go synthetic native audio separately from metadata claims', async () => {
    const vars: Record<string, string> = {};
    for (const line of (await readFile(new URL('../../.dev.vars', import.meta.url), 'utf8')).split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (match) vars[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, '$2');
    }
    const key = vars['OPENCODE_GO_API_KEY'] || vars['OPENCODE_API_KEY']!;
    const entry = PRODUCTION_REGISTRY.entries.find(model => model.commandKey === 'mimo-25')!;
    const requests: Array<Record<string, unknown>> = [];
    const adapter = new OpenCodeGoAdapter({ apiKey: key, endpointFamily: 'go-chat-completions', fetchFn: async (url, init) => {
      const response = await fetch(url, init);
      const row: Record<string, unknown> = { status: response.status };
      if (!response.ok) {
        const data = await response.clone().json() as { error?: { message?: string } };
        row['errorDetail'] = (data.error?.message ?? 'No structured detail').split(key).join('[redacted]').slice(0, 600);
      }
      requests.push(row);
      return response;
    } });
    const events: ProviderEvent[] = [];
    const started = performance.now();
    try {
      for await (const event of adapter.streamTurn({
        model: { commandKey: entry.commandKey, provider: entry.provider, modelId: entry.modelId, endpointFamily: entry.endpointFamily, endpointUrl: entry.endpointUrl },
        sessionId: 'otis-audit-go-audio', workspaceId: 'synthetic-audit', chatId: 'synthetic-audit', runId: crypto.randomUUID(), requestId: crypto.randomUUID(),
        messages: [{ role: 'user', text: 'This is a synthetic tone, without speech. Reply only AUDIO_RECEIVED if you received the audio.',
          audio: { data: Buffer.from(buildSyntheticProbeWav()).toString('base64'), mimeType: 'audio/wav', format: 'wav' } }],
        tools: [], pendingToolResults: [], maxOutputTokens: 1024, timeoutMs: 30_000,
      })) events.push(event);
    } catch (error) {
      events.push({ type: 'error', error: { code: 'invalid_request', message: (error instanceof Error ? error.message : String(error)).split(key).join('[redacted]'), retryable: false, retryAfterMs: null } });
    }
    const finish = events.find(event => event.type === 'finish');
    const error = events.find(event => event.type === 'error');
    const text = events.filter(event => event.type === 'text_delta').map(event => event.text).join('');
    const evidence = JSON.stringify({ capturedAt: new Date().toISOString(), model: entry.commandKey,
      source: 'Synthetic WAV tone only, not Telegram Opus/device or speech evidence.', elapsedMs: Math.round(performance.now() - started), requests,
      finish: finish?.type === 'finish' ? finish.reason : null, expectedMarker: text.includes('AUDIO_RECEIVED'), textChars: text.length,
      error: error?.type === 'error' ? { code: error.error.code, message: error.error.message } : null }, null, 2);
    expect(evidence).not.toContain(key);
    await writeFile(new URL('./telegram-go-audio-live-evidence.json', import.meta.url), evidence + '\n');
  });

  it('records transport/media compatibility without testing private audio or executing business tools', async () => {
    const vars: Record<string, string> = {};
    for (const line of (await readFile(new URL('../../.dev.vars', import.meta.url), 'utf8')).split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (match) vars[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, '$2');
    }
    const redact = (value: string) => Object.values(vars).filter(key => key.length > 12)
      .reduce((safe, key) => safe.split(key).join('[redacted]'), value).slice(0, 600);
    const rows: Array<Record<string, unknown>> = [];
    const save = () => writeFile(new URL('./telegram-voice-continuation-live-evidence.json', import.meta.url),
      JSON.stringify({ capturedAt: new Date().toISOString(), source: 'Synthetic 1-second WAV tone, not Telegram OGG/speech/device evidence; no business writes.', rows }, null, 2) + '\n');
    const makeInput = (key: string): TurnInput => {
      const entry = PRODUCTION_REGISTRY.entries.find(model => model.commandKey === key)!;
      return { model: { commandKey: key, provider: entry.provider, modelId: entry.modelId, endpointFamily: entry.endpointFamily, endpointUrl: entry.endpointUrl },
        sessionId: `otis-audit-media-${key}`, workspaceId: 'synthetic-audit', chatId: 'synthetic-audit',
        runId: crypto.randomUUID(), requestId: crypto.randomUUID(), messages: [], pendingToolResults: [],
        tools: [], maxOutputTokens: 2048, timeoutMs: 40_000, thinking: { kind: 'provider_default' } };
    };
    const drain = async (adapter: ProviderAdapter, input: TurnInput) => {
      const started = performance.now();
      const events: ProviderEvent[] = [];
      for await (const event of adapter.streamTurn(input)) events.push(event);
      const finish = events.find(event => event.type === 'finish');
      const error = events.find(event => event.type === 'error');
      const text = events.filter(event => event.type === 'text_delta').map(event => event.text).join('');
      return { events, text, summary: { elapsedMs: Math.round(performance.now() - started), textChars: text.length,
        finish: finish?.type === 'finish' ? finish.reason : null,
        toolCalls: events.filter(event => event.type === 'tool_call_end').length,
        error: error?.type === 'error' ? { code: error.error.code, message: redact(error.error.message) } : null } };
    };

    const bytes = buildSyntheticProbeWav();
    for (const key of ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']) {
      const input = makeInput(key);
      input.messages = [{ role: 'user', text: 'This is a synthetic tone without speech. Reply with exactly AUDIO_RECEIVED if you received the audio.',
        audio: { data: Buffer.from(bytes).toString('base64'), mimeType: 'audio/wav', format: 'wav' } }];
      const result = await drain(new GeminiInteractionsAdapter({ apiKey: vars['GEMINI_API_KEY']!, fetchFn: fetch }), input);
      rows.push({ scenario: 'native WAV audio transport', model: key, ...result.summary, expectedMarker: result.text.includes('AUDIO_RECEIVED') });
      await save();
    }
    const started = performance.now();
    const stt = await transcribeWithGroq({ apiKey: vars['GROQ_API_KEY']!, model: 'whisper-large-v3-turbo', bytes,
      filename: 'synthetic-tone.wav', mimeType: 'audio/wav', fetchFn: fetch, timeoutMs: 30_000 });
    rows.push({ scenario: 'Groq WAV transport (tone, not speech accuracy)', model: 'whisper-large-v3-turbo',
      elapsedMs: Math.round(performance.now() - started), ok: stt.ok,
      code: stt.ok ? null : stt.code, status: stt.ok ? 200 : stt.status, textChars: stt.ok ? stt.text.length : null });
    await save();

    const input = makeInput('mimo-25');
    input.tools = [{ name: 'echo_fixture', description: 'Read a synthetic value. Call once, then use its result.',
      parameters: { type: 'object', properties: { fixture_id: { type: 'string' } }, required: ['fixture_id'], additionalProperties: false } }];
    input.messages = [
      { role: 'system', text: 'For this integration test, call echo_fixture exactly once with fixture_id smoke-1. Once its result is provided, answer using the result without calling any tool again.' },
      { role: 'user', text: 'Read fixture smoke-1, then return its result in one short sentence.' },
    ];
    const roles: string[][] = [];
    const adapter = new OpenCodeGoAdapter({ apiKey: vars['OPENCODE_GO_API_KEY'] || vars['OPENCODE_API_KEY']!, endpointFamily: 'go-chat-completions',
      fetchFn: async (url, init) => {
        const body = JSON.parse(String(init.body)) as { messages: Array<{ role: string }> };
        roles.push(body.messages.map(message => message.role));
        return fetch(url, init);
      } });
    const initial = await drain(adapter, input);
    const calls = initial.events.filter((event): event is Extract<ProviderEvent, { type: 'tool_call_end' }> => event.type === 'tool_call_end');
    const finish = initial.events.find(event => event.type === 'finish');
    const valid = calls.length === 1 && calls[0]!.name === 'echo_fixture'
      && (calls[0]!.args as Record<string, unknown>)['fixture_id'] === 'smoke-1'
      && finish?.type === 'finish' && finish.reason === 'tool_handoff';
    const row: Record<string, unknown> = { scenario: 'MiMo production-shaped continuation, no new follow-up', model: 'mimo-25', initial: initial.summary, validInitialCall: valid, roles };
    if (valid && finish?.type === 'finish') {
      const call = calls[0]!;
      const next = await drain(adapter, { ...input, requestId: crypto.randomUUID(),
        messages: [...input.messages, { role: 'assistant', toolCalls: [{ id: call.callId, name: call.name, arguments: JSON.stringify(call.args) }] }],
        pendingToolResults: [{ callId: call.callId, name: call.name, arguments: call.args as Record<string, unknown>, resultText: JSON.stringify({ fixture_id: 'smoke-1' }) }],
        previousContinuation: finish.continuation, continuationInput: [] });
      row['continuation'] = next.summary;
      row['finalUsesResult'] = next.text.includes('smoke-1');
      row['repeatedSameArguments'] = next.events.some(event => event.type === 'tool_call_end' && JSON.stringify(event.args) === JSON.stringify(call.args));
    }
    rows.push(row);
    await save();
    expect(rows).toHaveLength(4);
    const evidence = await readFile(new URL('./telegram-voice-continuation-live-evidence.json', import.meta.url), 'utf8');
    for (const key of Object.values(vars).filter(value => value.length > 12)) expect(evidence).not.toContain(key);
  });
});
