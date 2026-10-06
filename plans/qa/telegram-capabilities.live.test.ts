import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { PRODUCTION_REGISTRY } from '../../packages/agent/src/providers/registry.js';
import { GeminiInteractionsAdapter } from '../../packages/agent/src/providers/gemini.js';
import { OpenCodeGoAdapter } from '../../packages/agent/src/providers/opencode-go.js';
import { executeSmokeToolLoop } from '../../packages/agent/test/smoke-tool-loop.js';
import type { FetchFn, ProviderEvent, TurnInput } from '../../packages/agent/src/providers/types.js';

// Explicit opt-in. All inputs and tool results are synthetic; no Otis writes.
const enabled = process.env['OTIS_PROVIDER_AUDIT_LIVE'] === '1';
const evidencePath = new URL('./telegram-capabilities-live-evidence.json', import.meta.url);

describe.skipIf(!enabled)('Current provider tool continuation and effort probes', () => {
  it('records actual endpoint results without interpreting HTTP 200 as effort support', async () => {
    const vars: Record<string, string> = {};
    for (const line of (await readFile(new URL('../../.dev.vars', import.meta.url), 'utf8')).split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (match) vars[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, '$2');
    }
    const geminiKey = vars['GEMINI_API_KEY'] ?? '';
    const goKey = vars['OPENCODE_GO_API_KEY'] || vars['OPENCODE_API_KEY'] || '';
    const redact = (value: string) => Object.values(vars).filter(key => key.length > 12)
      .reduce((safe, key) => safe.split(key).join('[redacted]'), value).slice(0, 700);
    expect(geminiKey.length).toBeGreaterThan(0);
    expect(goKey.length).toBeGreaterThan(0);
    const models = PRODUCTION_REGISTRY.entries.filter(entry => entry.capabilities.text === 'supported');
    const toolLoops: Array<Record<string, unknown>> = [];
    const effortProbes: Array<Record<string, unknown>> = [];
    const save = () => writeFile(evidencePath, JSON.stringify({ capturedAt: new Date().toISOString(),
      source: 'Current adapters for synthetic echo tools; direct Go HTTP requests for effort capability, not production UX.',
      toolLoops, effortProbes }, null, 2) + '\n');

    for (const entry of models) {
      const requests: Array<Record<string, unknown>> = [];
      const transport: FetchFn = async (url, init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        const row: Record<string, unknown> = { linked: Boolean(body['previous_interaction_id'] ?? body['previous_response_id']),
          inputTypes: Array.isArray(body['input']) ? body['input'].map((block: Record<string, unknown>) => block['type'] ?? block['role']) : undefined };
        requests.push(row);
        const response = await fetch(url, init);
        row['status'] = response.status;
        if (!response.ok) {
          try {
            const data = await response.clone().json() as { error?: { message?: string; code?: string }; message?: string };
            row['errorDetail'] = redact(data.error?.message ?? data.message ?? 'No structured detail');
            row['errorCode'] = data.error?.code;
          } catch { row['errorDetail'] = 'No readable structured error'; }
        }
        return response;
      };
      const adapter = entry.provider === 'gemini'
        ? new GeminiInteractionsAdapter({ apiKey: geminiKey, fetchFn: transport })
        : new OpenCodeGoAdapter({ apiKey: goKey, fetchFn: transport, endpointFamily: entry.endpointFamily as 'go-chat-completions' | 'go-responses' });
      const rounds: Array<Record<string, unknown>> = [];
      const started = performance.now();
      const row: Record<string, unknown> = { model: entry.commandKey, family: entry.endpointFamily, requests, rounds };
      try {
        const loop = await executeSmokeToolLoop({ adapter,
          model: { commandKey: entry.commandKey, provider: entry.provider, modelId: entry.modelId, endpointFamily: entry.endpointFamily, endpointUrl: entry.endpointUrl },
          baseInput: { sessionId: `otis-audit-loop-${entry.commandKey}`, workspaceId: 'synthetic-audit', chatId: 'synthetic-audit',
            runId: crypto.randomUUID(), requestId: crypto.randomUUID(), messages: [], tools: [], pendingToolResults: [],
            maxOutputTokens: 2048, timeoutMs: 45_000, thinking: { kind: 'provider_default' } },
          maxContinuationSteps: 2,
          drain: async (input: TurnInput) => {
            const events: ProviderEvent[] = [];
            const turnStarted = performance.now();
            let firstTextMs: number | null = null;
            for await (const event of adapter.streamTurn(input)) {
              events.push(event);
              if (event.type === 'text_delta') firstTextMs ??= Math.round(performance.now() - turnStarted);
            }
            const finish = events.find(event => event.type === 'finish');
            const error = events.find(event => event.type === 'error');
            const usage = events.filter(event => event.type === 'usage').at(-1);
            rounds.push({ elapsedMs: Math.round(performance.now() - turnStarted), firstTextMs,
              finish: finish?.type === 'finish' ? finish.reason : null,
              continuationKind: finish?.type === 'finish' ? finish.continuation?.kind : null,
              toolCalls: events.filter(event => event.type === 'tool_call_end').length,
              textChars: events.reduce((n, event) => n + (event.type === 'text_delta' ? event.text.length : 0), 0),
              error: error?.type === 'error' ? { code: error.error.code, message: redact(error.error.message) } : null,
              usage: usage?.type === 'usage' ? usage.usage : null });
            return { events, ms: Math.round(performance.now() - turnStarted) };
          },
        });
        row['outcome'] = 'tool call and continuation succeeded';
        row['validatedCalls'] = loop.validatedCallCount;
        row['continuationSteps'] = loop.continuationSteps;
      } catch (error) {
        row['outcome'] = 'failed';
        row['error'] = redact(error instanceof Error ? error.message : String(error));
      }
      row['elapsedMs'] = Math.round(performance.now() - started);
      toolLoops.push(row);
      await save();
    }

    // Valid/invalid controls distinguish validated effort from silently ignored
    // parameters. Record the endpoint's echoed reasoning config when available.
    const variants: Record<string, string[]> = {
      'mimo-25': ['low', 'xhigh', 'audit_invalid'],
      'mimo-26-pro': ['low', 'high', 'audit_invalid'],
      'muse-12': ['minimal', 'high', 'audit_invalid'],
      'muse-13': ['minimal', 'high', 'audit_invalid'],
      'deepseek-v4.1-flash': ['low', 'high', 'max', 'audit_invalid'],
    };
    for (const entry of models.filter(model => model.provider === 'opencode_go')) {
      for (const effort of variants[entry.commandKey] ?? []) {
        const started = performance.now();
        const row: Record<string, unknown> = { model: entry.commandKey, family: entry.endpointFamily, effort };
        const body: Record<string, unknown> = { model: entry.modelId, stream: false };
        if (entry.endpointFamily === 'go-responses') {
          body['input'] = 'Return only the product of 12 and 13. No explanation.';
          body['max_output_tokens'] = 1024;
          body['reasoning'] = { effort };
        } else {
          body['messages'] = [{ role: 'user', content: 'Return only the product of 12 and 13. No explanation.' }];
          body['max_tokens'] = 1024;
          body['reasoning_effort'] = effort;
        }
        try {
          const response = await fetch(entry.endpointUrl, { method: 'POST',
            headers: { Authorization: `Bearer ${goKey}`, 'Content-Type': 'application/json',
              'User-Agent': 'otis/0.1.0', 'x-opencode-session': `otis-audit-effort-${entry.commandKey}` },
            body: JSON.stringify(body), signal: AbortSignal.timeout(40_000) });
          row['status'] = response.status;
          const data = await response.json() as Record<string, unknown>;
          row['returnedReasoning'] = data['reasoning'];
          row['responseStatus'] = data['status'];
          row['usage'] = data['usage'];
          if (!response.ok) {
            const error = data['error'] as { message?: string; code?: string } | undefined;
            row['errorDetail'] = redact(error?.message ?? String(data['message'] ?? 'No structured error'));
            row['errorCode'] = error?.code;
          } else {
            // Count output, never persist transcript or private reasoning text.
            const choices = data['choices'] as Array<{ message?: { content?: string }; finish_reason?: string }> | undefined;
            row['finishReason'] = choices?.[0]?.finish_reason;
            row['textChars'] = choices?.[0]?.message?.content?.length;
            row['outputTypes'] = (data['output'] as Array<{ type?: string }> | undefined)?.map(item => item.type);
          }
        } catch (error) {
          row['exception'] = redact(error instanceof Error ? error.message : String(error));
        }
        row['elapsedMs'] = Math.round(performance.now() - started);
        effortProbes.push(row);
        await save();
      }
    }
    expect(toolLoops).toHaveLength(models.length);
    expect(effortProbes).toHaveLength(16);
    const evidence = await readFile(evidencePath, 'utf8');
    for (const key of [geminiKey, goKey]) expect(evidence).not.toContain(key);
  });
});
