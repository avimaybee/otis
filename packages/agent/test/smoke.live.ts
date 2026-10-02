/**
 * Opt-in live provider smoke for Plan 005. NEVER runs under `pnpm test`,
 * build, or CI: this filename matches no default vitest include pattern and
 * executes only via `pnpm smoke:providers` with explicit environment.
 *
 * Required environment (a designated secret source; never request keys here):
 *   OTIS_SMOKE_PROVIDER  gemini | opencode_go
 *   OTIS_SMOKE_MODEL     operator command key from the production registry
 *   OTIS_SMOKE_KEY       raw provider key, or OTIS_SMOKE_KEY_FILE (path)
 *
 * Bounded: six requests maximum (text, initial tool call, up to three
 * continuation steps, one repeated-prefix comparison). Fabricated neutral
 * data only; a harmless echo fixture tool; no real Kerning records. Prints
 * a sanitized JSON report: keys, prompt bodies, audio content, and raw
 * protocol reasoning never appear in output.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
  GeminiInteractionsAdapter,
  OpenCodeGoAdapter,
  PRODUCTION_REGISTRY,
  estimateCostUsd,
  DOCUMENTED_RATES_2026_10_01,
  type ProviderAdapter,
  type ProviderEvent,
  type ResolvedModel,
  type TurnInput,
} from '../src/index.js';
import {
  executeSmokeToolLoop,
  STATIC_PREFIX,
} from './smoke-tool-loop.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Live smoke requires ${name} to be set. Refusing to run.`);
  return value;
}

function readDesignatedKey(provider?: string): string {
  const file = process.env['OTIS_SMOKE_KEY_FILE'];
  if (file) return readFileSync(file, 'utf8').trim();
  const direct = process.env['OTIS_SMOKE_KEY'];
  if (direct) return direct.trim();
  if (existsSync('.dev.vars')) {
    const content = readFileSync('.dev.vars', 'utf8');
    const target =
      provider === 'gemini'
        ? 'GEMINI_API_KEY'
        : provider === 'opencode_go'
          ? 'OPENCODE_API_KEY'
          : null;
    if (target) {
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith(`${target}=`)) {
          const val = trimmed.slice(target.length + 1).trim();
          if (val) return val;
        }
      }
    }
  }
  return requiredEnv('OTIS_SMOKE_KEY').trim();
}

function toResolved(entry: (typeof PRODUCTION_REGISTRY.entries)[number]): ResolvedModel {
  return {
    commandKey: entry.commandKey,
    provider: entry.provider,
    modelId: entry.modelId,
    endpointFamily: entry.endpointFamily,
    endpointUrl: entry.endpointUrl,
  };
}

describe('live provider smoke (opt-in only)', () => {
  it('runs bounded text, tool round trip, and prefix comparison probes', async () => {
    const provider = requiredEnv('OTIS_SMOKE_PROVIDER');
    const commandKey = requiredEnv('OTIS_SMOKE_MODEL');
    const apiKey = readDesignatedKey(provider);
    if (!apiKey) throw new Error('Designated key is empty. Refusing to run.');

    const entry = PRODUCTION_REGISTRY.entries.find((item) => item.commandKey === commandKey);
    if (!entry) throw new Error(`Unknown model command key '${commandKey}'.`);
    if (provider !== entry.provider) throw new Error('Provider selection does not match the model entry.');

    let adapter: ProviderAdapter;
    if (entry.endpointFamily === 'gemini-interactions') {
      adapter = new GeminiInteractionsAdapter({ fetchFn: fetch, apiKey });
    } else if (entry.endpointFamily === 'go-chat-completions' || entry.endpointFamily === 'go-responses') {
      adapter = new OpenCodeGoAdapter({ fetchFn: fetch, apiKey, endpointFamily: entry.endpointFamily });
    } else {
      throw new Error(`No smoke transport for family '${entry.endpointFamily}'.`);
    }

    const startedAt = new Date().toISOString();
    const sessionId = `smoke_${Date.now()}`;
    const base: Omit<TurnInput, 'model'> = {
      sessionId,
      workspaceId: 'smoke',
      chatId: 'smoke-chat',
      runId: 'smoke-run',
      requestId: 'smoke-req-1',
      messages: [{ role: 'user', text: `${STATIC_PREFIX} Say "smoke-ok".` }],
      pendingToolResults: [],
      previousContinuation: null,
      tools: [],
      // Responses reasoning shares the output budget; 256 truncated Muse
      // before it could produce text or a tool call during live verification.
      maxOutputTokens: entry.endpointFamily === 'go-responses' ? 2048 : 256,
      timeoutMs: 60_000,
    };
    const model = toResolved(entry);

    // Planned request count is reported before any paid call below.
    console.log(
      JSON.stringify({ smoke_plan: { model: entry.modelId, family: entry.endpointFamily, max_requests: 6 } }),
    );

    const drain = async (input: TurnInput): Promise<{ events: ProviderEvent[]; ms: number }> => {
      const begin = Date.now();
      const events: ProviderEvent[] = [];
      for await (const event of adapter.streamTurn(input)) events.push(event);
      return { events, ms: Date.now() - begin };
    };

    const logStage = (stage: string, turnResult: { events: ProviderEvent[]; ms: number }): void => {
      const err = turnResult.events.find((e): e is Extract<ProviderEvent, { type: 'error' }> => e.type === 'error');
      const fin = turnResult.events.find((e): e is Extract<ProviderEvent, { type: 'finish' }> => e.type === 'finish');
      const toolEnds = turnResult.events.filter(
        (e): e is Extract<ProviderEvent, { type: 'tool_call_end' }> => e.type === 'tool_call_end',
      );
      const deltas = turnResult.events.filter((e) => e.type === 'text_delta');
      console.log(
        JSON.stringify({
          smoke_stage: {
            stage,
            status: err ? 'error' : 'ok',
            finish_reason: fin?.reason ?? null,
            error_code: err?.error.code ?? null,
            http_status: err?.error.status ?? (fin ? 200 : null),
            tool_calls: toolEnds.map((c) => ({
              name: c.name,
              has_id: !!c.callId,
              has_args: c.args != null,
            })),
            deltas_count: deltas.length,
            ms: turnResult.ms,
          },
        }),
      );
    };

    // 1. Text stream with usage capture.
    const text = await drain({ ...base, model });
    logStage('text', text);
    const textFinish = text.events.find((event) => event.type === 'finish' || event.type === 'error');
    const textUsage = text.events.find((event) => event.type === 'usage');

    // 2-3. Bounded tool loop with strict validation of all tool calls (up to 3 continuation steps max).
    const toolLoopResult = await executeSmokeToolLoop({
      adapter,
      baseInput: base,
      model,
      maxContinuationSteps: 3,
      drain,
      logStage,
    });
    const toolTurn = toolLoopResult.initialTurn;
    const finalContinuationTurn = toolLoopResult.finalTurn;
    const continuationStep = toolLoopResult.continuationSteps;
    const initialToolEnd = toolTurn.events.find((e) => e.type === 'tool_call_end');

    // 4. Repeated static prefix with a changing suffix (one comparison only).
    const repeat = await drain({
      ...base,
      model,
      requestId: `smoke-req-${3 + continuationStep}`,
      messages: [{ role: 'user', text: `${STATIC_PREFIX} Say "smoke-ok-again".` }],
    });
    logStage('prefix_repeat', repeat);

    const cacheOf = (events: ProviderEvent[]): number | null => {
      const usage = events.find((event) => event.type === 'usage');
      return usage && usage.type === 'usage' ? usage.usage.cacheReadTokens : null;
    };

    const usageOf = (
      events: ProviderEvent[],
    ): { inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null } => {
      const usage = events.find((event) => event.type === 'usage');
      if (!usage || usage.type !== 'usage') return { inputTokens: null, outputTokens: null, cacheReadTokens: null };
      return { inputTokens: usage.usage.inputTokens, outputTokens: usage.usage.outputTokens, cacheReadTokens: usage.usage.cacheReadTokens };
    };
    const textUsageValues = usageOf(text.events);
    const rates = DOCUMENTED_RATES_2026_10_01[entry.modelId];

    console.log(
      JSON.stringify({
        smoke_report: {
          command_key: entry.commandKey,
          model_id: entry.modelId,
          endpoint_family: entry.endpointFamily,
          date: startedAt,
          text_finish: textFinish?.type,
          text_ms: text.ms,
          text_usage: textUsageValues,
          estimated_cost_usd: rates ? estimateCostUsd(textUsageValues, rates) : null,
          cost_rates: rates ? rates.source : null,
          tool_call_completed: initialToolEnd?.type === 'tool_call_end',
          continuation_steps: continuationStep,
          round_trip_finish:
            finalContinuationTurn?.events.find((event) => event.type === 'finish' || event.type === 'error')?.type ?? null,
          round_trip_finish_reason:
            finalContinuationTurn?.events.find(
              (event): event is Extract<ProviderEvent, { type: 'finish' }> => event.type === 'finish',
            )?.reason ?? null,
          repeat_cache_read_tokens: cacheOf(repeat.events),
          audio: 'unverified (no device samples run)',
        },
      }),
    );

    // 1. Text stream must finish successfully with non-empty output and reported usage.
    expect(textFinish?.type).toBe('finish');
    if (textFinish && textFinish.type === 'finish') {
      expect(textFinish.reason).toBe('success');
    }
    const deltas = text.events.filter((e) => e.type === 'text_delta');
    expect(deltas.length).toBeGreaterThan(0);
    expect(textUsage?.type).toBe('usage');

    // 2. Tool call must complete faithfully with expected name and arguments.
    expect(initialToolEnd).toBeDefined();
    expect(initialToolEnd?.type).toBe('tool_call_end');
    if (initialToolEnd && initialToolEnd.type === 'tool_call_end') {
      expect(initialToolEnd.name).toBe('echo_fixture');
      expect((initialToolEnd.args as Record<string, unknown>)?.['fixture_id']).toBe('smoke-1');
    }
    const toolFinish = toolTurn.events.find((e) => e.type === 'finish');
    expect(toolFinish?.type).toBe('finish');
    if (toolFinish && toolFinish.type === 'finish') {
      expect(toolFinish.reason).toBe('tool_handoff');
    }
    expect(toolLoopResult.validatedCallCount).toBeGreaterThanOrEqual(1);

    // 3. Round-trip continuation must complete successfully with text output.
    expect(finalContinuationTurn).not.toBeNull();
    const roundTripFinish = finalContinuationTurn?.events.find((e) => e.type === 'finish');
    expect(roundTripFinish?.type).toBe('finish');
    if (roundTripFinish && roundTripFinish.type === 'finish') {
      expect(roundTripFinish.reason).toBe('success');
    }
    const roundTripDeltas = finalContinuationTurn?.events.filter((e) => e.type === 'text_delta') ?? [];
    expect(roundTripDeltas.length).toBeGreaterThan(0);
  }, 300_000);
});
