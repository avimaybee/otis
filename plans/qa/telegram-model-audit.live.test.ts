import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { PRODUCTION_REGISTRY } from '../../packages/agent/src/providers/registry.js';
import { GeminiInteractionsAdapter } from '../../packages/agent/src/providers/gemini.js';
import { OpenCodeGoAdapter, GO_MODELS_URL } from '../../packages/agent/src/providers/opencode-go.js';
import { ALL_AGENT_TOOLS } from '../../packages/agent/src/tools.js';
import type { ModelEntry } from '../../packages/agent/src/providers/registry.js';
import type { FetchFn, TurnInput } from '../../packages/agent/src/providers/types.js';

// Real inference is opt-in, uses synthetic prompts, and executes no tools.
// Credentials stay in memory; error strings are redacted before persistence.
const enabled = process.env['OTIS_PROVIDER_AUDIT_LIVE'] === '1';
const outputPath = new URL('./telegram-model-live-evidence.json', import.meta.url);

describe.skipIf(!enabled)('Bounded live provider compatibility evidence (not production UX)', () => {
  it('records fresh/full-tool/history behavior of the current models', async () => {
    const vars: Record<string, string> = {};
    for (const line of (await readFile(new URL('../../.dev.vars', import.meta.url), 'utf8')).split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (match) vars[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, '$2');
    }
    const geminiKey = vars['GEMINI_API_KEY'] ?? '';
    const goKey = vars['OPENCODE_GO_API_KEY'] || vars['OPENCODE_API_KEY'] || '';
    const redact = (text: string) => Object.values(vars).filter(value => value.length > 12)
      .reduce((safe, value) => safe.split(value).join('[redacted]'), text)
      .replace(/bot\d+:[\w-]+/g, 'bot[redacted]').slice(0, 600);
    const metadata: Record<string, unknown> = {};
    const probes: Array<Record<string, unknown>> = [];
    const models = PRODUCTION_REGISTRY.entries.filter(entry => entry.capabilities.text === 'supported');
    expect(ALL_AGENT_TOOLS.length).toBeGreaterThan(0);
    expect(geminiKey.length).toBeGreaterThan(0);
    expect(goKey.length).toBeGreaterThan(0);

    // Discovery is read-only; persist only selected model metadata.
    const discovery = await fetch(GO_MODELS_URL, {
      headers: { Authorization: `Bearer ${goKey}`, 'User-Agent': 'otis/0.1.0' },
      signal: AbortSignal.timeout(20_000),
    });
    const discoveryBody = await discovery.json() as { data?: Array<Record<string, unknown>> };
    metadata['go'] = {
      status: discovery.status,
      selectedModels: (discoveryBody.data ?? []).filter(row => models.some(entry => entry.modelId === row['id']))
        .map(row => ({ id: row['id'], fields: Object.keys(row), reasoning: row['reasoning'], capabilities: row['capabilities'], supported_parameters: row['supported_parameters'] })),
    };

    const save = async () => writeFile(outputPath, JSON.stringify({ capturedAt: new Date().toISOString(),
      source: 'local current adapters; synthetic prompts; no business tools executed', metadata, probes }, null, 2) + '\n');

    async function probe(entry: ModelEntry, scenario: string, history = false, tools = true) {
      const requests: Array<Record<string, unknown>> = [];
      const transport: FetchFn = async (url, init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        const request: Record<string, unknown> = {
          inputTypes: Array.isArray(body['input']) ? body['input'].map((block: Record<string, unknown>) => block['type'] ?? block['role']) : undefined,
          toolCount: Array.isArray(body['tools']) ? body['tools'].length : 0,
          thinking: body['generation_config'] ?? body['reasoning_effort'] ?? body['reasoning'],
        };
        requests.push(request);
        const response = await fetch(url, init);
        request['status'] = response.status;
        if (!response.ok) {
          try {
            const errorBody = await response.clone().json() as { error?: { message?: string; code?: string | number }; message?: string };
            request['errorDetail'] = redact(errorBody.error?.message ?? errorBody.message ?? 'No structured detail');
            request['errorCode'] = errorBody.error?.code;
          } catch { request['errorDetail'] = 'No readable structured error'; }
        }
        return response;
      };
      const adapter = entry.provider === 'gemini'
        ? new GeminiInteractionsAdapter({ apiKey: geminiKey, fetchFn: transport })
        : new OpenCodeGoAdapter({ apiKey: goKey, fetchFn: transport, endpointFamily: entry.endpointFamily as 'go-chat-completions' | 'go-responses' });
      const input: TurnInput = {
        model: { commandKey: entry.commandKey, provider: entry.provider, modelId: entry.modelId, endpointFamily: entry.endpointFamily, endpointUrl: entry.endpointUrl },
        sessionId: `otis-audit-${entry.commandKey}`, workspaceId: 'synthetic-audit', chatId: 'synthetic-audit',
        runId: crypto.randomUUID(), requestId: crypto.randomUUID(),
        messages: [
          { role: 'system', text: 'This is an integration test. Do not call business tools or save anything. Respond with exactly READY.' },
          ...(history ? [{ role: 'user' as const, text: 'Hello.' }, { role: 'assistant' as const, text: 'Hello.' }] : []),
          { role: 'user', text: 'Reply with exactly READY. Do not call tools.' },
        ],
        tools: tools ? ALL_AGENT_TOOLS : [], pendingToolResults: [], previousContinuation: null,
        maxOutputTokens: 1024, timeoutMs: 30_000, thinking: { kind: 'provider_default' },
      };
      const started = performance.now();
      let firstTextMs: number | null = null;
      let textChars = 0;
      let toolCalls = 0;
      let terminal: Record<string, unknown> | null = null;
      try {
        for await (const event of adapter.streamTurn(input)) {
          if (event.type === 'text_delta') {
            firstTextMs ??= Math.round(performance.now() - started);
            textChars += event.text.length;
          } else if (event.type === 'tool_call_end') toolCalls++;
          else if (event.type === 'error') terminal = { type: 'error', code: event.error.code, message: redact(event.error.message) };
          else if (event.type === 'finish') terminal = { type: 'finish', reason: event.reason };
        }
      } catch (error) {
        terminal = { type: 'exception', message: redact(error instanceof Error ? error.message : String(error)) };
      }
      probes.push({ model: entry.commandKey, family: entry.endpointFamily, scenario,
        elapsedMs: Math.round(performance.now() - started), firstTextMs, textChars, toolCalls, terminal, requests });
      await save();
      console.info(JSON.stringify(probes.at(-1)));
    }

    for (const entry of models) await probe(entry, 'fresh with current application tool declarations');
    for (const entry of models.filter(entry => entry.provider === 'gemini')) {
      await probe(entry, 'assistant history with current application tool declarations', true);
      await probe(entry, 'fresh without tools', false, false);
    }
    expect(probes).toHaveLength(models.length + models.filter(entry => entry.provider === 'gemini').length * 2);
    // Harness completion is not a claim every model passed; inspect recorded terminals.
    const evidence = await readFile(outputPath, 'utf8');
    for (const credential of [geminiKey, goKey]) expect(evidence).not.toContain(credential);
  });
});
